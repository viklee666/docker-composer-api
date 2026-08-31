import { ApiError } from "./errors.js";
import { classifyKeyFailure, CursorKeyPool, errorMessage } from "./key-pool.js";
import type { NoKeyReason, RoutingPolicy } from "./key-pool.js";
import { denyRuleUnverifiable, identityAllowed, modelIdentity, sessionBindingHash } from "./routing.js";
import { getGlobalCursorClientType, resolveCursorClientType } from "./sand-client.js";
import type {
  CursorClientType,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayToolCall,
  ModelIdentity
} from "./types.js";

/** 单次请求最多尝试的 key 数默认上限，避免 key 极多时无界轮换放大上游压力。可由 MAX_KEY_ATTEMPTS 覆盖。 */
const DEFAULT_MAX_KEY_ATTEMPTS = 10;
/**
 * 单次请求中软失败（换了 key 但没禁用）的默认重试上限。
 * 避免某模型在所有 key 上都不可用时把整池 key 试一遍白烧额度；超过即停手透出上游错误。可由 MAX_TRANSIENT_KEY_ATTEMPTS 覆盖。
 */
const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 3;

export interface KeyRotatingOptions {
  /** 单次请求最多尝试的 key 数（含成功前的失败次数）。默认 10。 */
  maxKeyAttempts?: number;
  /** 单次请求软失败的最大次数，超过则不再换 key、直接透出上游错误。默认 3。 */
  maxTransientAttempts?: number;
  /** 全局通道；未提供时读模块级总开关。测试里应绑到 config，避免并行用例互相污染。 */
  resolveGlobalClientType?: () => CursorClientType;
  /** 取用策略；未提供时读 key 池自己的策略（选 key 本来就以池上的策略为准）。 */
  resolveRoutingPolicy?: () => RoutingPolicy;
}

/**
 * 包装真实 runner：useKeyPool 的请求按取用策略（含模型可见范围、网关密钥绑定、会话粘性）取 key 调上游；
 * - 上游报 key 级错误时把失败交给 key 池记账（是否禁用由自动禁用策略决定），随后换下一个 key 重试；
 * - 未被禁用的失败算软失败：累计到上限或所有 key 都软失败时，透出真实上游错误而不是笼统的"无有效 key"；
 * - 确实把 key 全禁完/池里没有可用 key 时才返回 429 insufficient_quota，
 *   模型范围与密钥授权造成的落空按 403 表达（见 noKeyError）。
 */
export class KeyRotatingRunner implements CursorRunner {
  private readonly maxKeyAttempts: number;
  private readonly maxTransientAttempts: number;
  private readonly resolveGlobalClientType?: () => CursorClientType;
  private readonly resolveRoutingPolicy?: () => RoutingPolicy;

  constructor(
    private readonly inner: CursorRunner,
    private readonly pool: CursorKeyPool,
    options: KeyRotatingOptions = {}
  ) {
    this.maxKeyAttempts = positiveIntOr(options.maxKeyAttempts, DEFAULT_MAX_KEY_ATTEMPTS);
    this.maxTransientAttempts = positiveIntOr(options.maxTransientAttempts, DEFAULT_MAX_TRANSIENT_ATTEMPTS);
    this.resolveGlobalClientType = options.resolveGlobalClientType;
    this.resolveRoutingPolicy = options.resolveRoutingPolicy;
  }

  private globalClientType(): CursorClientType {
    return this.resolveGlobalClientType?.() ?? getGlobalCursorClientType();
  }

  private routingPolicy(): RoutingPolicy {
    return this.resolveRoutingPolicy?.() ?? this.pool.routingPolicy;
  }

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    let result: CursorRunResult | undefined;
    let text = "";
    let reasoningText = "";
    const toolCalls: GatewayToolCall[] = [];
    for await (const event of this.stream(input, signal)) {
      if (event.type === "text") text += event.text;
      if (event.type === "thinking") reasoningText += event.text;
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
      if (event.type === "done") result = event.result;
    }
    // 只信 done 的 result：换 key 重试时本地累积会把失败尝试的 thinking 拼进成功尝试的响应。
    return result ?? { text, toolCalls, ...(reasoningText ? { reasoningText } : {}) };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    if (!input.useKeyPool) {
      if (!input.apiKey) throw new ApiError("Missing Cursor API key.", 401, "unauthorized");
      const record = await this.pool.getByValue(input.apiKey);
      if (record?.status === "disabled") {
        // direct 模式拿的是同一把 Cursor key，不能因为绕过池选 key 就绕过后台的全局停用。
        throw new ApiError("This Cursor API key is disabled.", 401, "unauthorized");
      }
      // 直传的 key 若已在池中登记且配了可见范围，同样受限：运维给它配范围就是想限制它。
      // 客户端手里已经握着裸 key，这里不是提权修复，只是不让直传成为绕过后台设置的后门。
      if (record && !identityAllowed(runIdentity(input), record.modelScope)) {
        throw noKeyError("model-not-allowed", input.model);
      }
      if (record && denyRuleUnverifiable(runIdentity(input), record.modelScope)) {
        throw noKeyError("model-unverified", input.model);
      }
      const clientType = input.clientType ?? resolveCursorClientType(record?.clientType, this.globalClientType());
      yield* this.inner.stream({ ...input, clientType }, signal);
      return;
    }

    const attempted = new Set<string>();
    // 会话粘性的绑定键只认 stickyKey：认不出是哪段对话就不参与粘性，也不写绑定。
    // 这里绝不能拿 sessionKey 兜底——它在没有会话头时会退化成所有请求共享的 ownerHash。
    const sessionHash = input.stickyKey ? sessionBindingHash(input.stickyKey) : undefined;
    // 最近一次软失败（换过 key 但没禁用）的错误；所有 key 都软失败时透出它而非误报额度耗尽。
    let softError: unknown;
    let softCount = 0;
    for (;;) {
      const selection = await this.pool.selectKey(attempted, {
        model: input.model,
        modelIdentity: input.modelIdentity,
        gatewayModelScope: input.gatewayModelScope,
        allowedKeyIds: input.allowedKeyIds,
        sessionHash
      }, attempted.size < this.maxKeyAttempts);
      if (!("key" in selection)) {
        if (softError) throw softError;
        throw noKeyError(selection.reason, input.model);
      }
      const key = selection.key;
      if (attempted.size >= this.maxKeyAttempts) {
        if (softError) throw softError;
        throw new ApiError(
          "Exhausted Cursor API key rotation attempts without success.",
          502,
          "upstream_run_failed"
        );
      }
      attempted.add(key.id);
      if (input.keyUsageRef) {
        input.keyUsageRef.keyId = key.id;
        input.keyUsageRef.keyLabel = key.label;
      }
      await this.pool.recordUse(key.id);
      const clientType = resolveCursorClientType(key.clientType, this.globalClientType());

      let emitted = false;
      // 非流式：整段缓冲到本次尝试成功结束后再放行——失败尝试的任何事件（含 thinking）都不会
      // 泄漏给聚合器，从根上杜绝换 key 重试时跨尝试拼接内容；反正非流式消费方不需要增量。
      const buffering = !input.stream;
      const buffered: CursorStreamEvent[] = [];
      try {
        for await (const event of this.inner.stream({ ...input, apiKey: key.apiKey, clientType }, signal)) {
          if (buffering) {
            buffered.push(event);
            continue;
          }
          // 流式：thinking 只有真正会被端点转发给客户端时才算“已交付”
          //（messages 端点在客户端未请求 thinking 时会把它丢弃，此时失败仍可安全换 key）。
          if (event.type !== "thinking" || input.thinkingVisible !== false) emitted = true;
          yield event;
        }
        if (buffering) yield* buffered;
        // 跑通即认为该 key 健康：清掉连续失败计数，偶发失败不会跨请求累积到禁用阈值。
        await this.pool.recordSuccess(key.id);
        if (sessionHash && this.routingPolicy().sessionAffinity) {
          try {
            await this.pool.bindSession(sessionHash, key.id);
          } catch {
            // 绑定只是上游缓存优化，写失败不该把一次已经跑通的请求变成失败。
          }
        }
        return;
      } catch (error) {
        const failure = classifyKeyFailure(error);
        // 是否禁用由 key 池的自动禁用策略决定（可关闭，也可要求连续失败若干次）。
        const disabled = failure ? await this.pool.reportFailure(key.id, failure, errorMessage(error)) : false;
        if (failure && !disabled) {
          // 该 key 仍留在池里：记下错误后换下一个 key，全部软失败时把它透出去。
          softError = error;
          softCount += 1;
        }
        // 已向客户端吐出过内容时无法安全重试；非 key 级错误原样抛出。
        if (!failure || emitted || signal?.aborted) throw error;
        // 软失败累计到上限：停手透出上游错误，避免某模型在整池 key 上都不可用时把额度试个遍。
        if (!disabled && softCount >= this.maxTransientAttempts) throw error;
      }
    }
  }
}

/**
 * 把「选不出 key」翻译成对客户端可操作的错误。
 * 模型范围 / 授权落空刻意不复用 429 insufficient_quota：把「这个 key 被你排除了该模型」
 * 报成额度耗尽会把人引去查账单，实际要改的是后台的可见范围或密钥绑定，因此按 403 表达权限语义。
 */
function noKeyError(reason: NoKeyReason, model: string): ApiError {
  switch (reason) {
    case "none-configured":
      return new ApiError(
        "No valid Cursor API key available: none configured. Add keys in the admin panel or via CURSOR_API_KEYS.",
        429,
        "insufficient_quota"
      );
    case "all-disabled":
      return new ApiError(
        "No valid Cursor API key available: all keys are disabled. Re-enable keys in the admin panel.",
        429,
        "insufficient_quota"
      );
    case "model-not-allowed":
      return new ApiError(
        `No Cursor API key is allowed to serve model "${model}": every available key scopes this model out. Widen the key model scope in the admin panel or request another model.`,
        403,
        "model_not_allowed",
        "model"
      );
    // 刻意与 model_not_allowed 分开：这不是「命中了某条规则」，而是「规则算不出来」，
    // 运维要区分的正是「该改可见范围」与「上游目录挂了、等一会儿就好」。
    case "model-unverified":
      return new ApiError(
        `Cannot verify whether model "${model}" is on the applicable model deny list: the Cursor model catalogue is unavailable, so the request is refused instead of being let through an unevaluated deny rule. Retry once the catalogue recovers, or request the model by the exact name used in the deny list.`,
        403,
        "model_identity_unverified",
        "model"
      );
    case "not-authorized":
      return new ApiError(
        "No Cursor API key is available to this gateway key: every key bound to it is missing or disabled. Update the gateway key binding in the admin panel.",
        403,
        "not_authorized"
      );
    case "exhausted":
    default:
      return new ApiError(
        "No valid Cursor API key available: all keys are exhausted or invalid and were disabled automatically. Re-enable keys in the admin panel after quota recovers.",
        429,
        "insufficient_quota"
      );
  }
}

/** server 解析过就用它；没有（比如内部直接构造的 run）退回只认模型名的身份，宁严勿宽。 */
function runIdentity(input: CursorRunRequest): ModelIdentity {
  return input.modelIdentity ?? modelIdentity(input.model);
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
