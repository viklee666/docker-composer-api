import { ApiError } from "./errors.js";
import { classifyKeyFailure, CursorKeyPool, errorMessage } from "./key-pool.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayToolCall
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
}

/**
 * 包装真实 runner：useKeyPool 的请求按后台设置的顺序取 key 调上游；
 * - 上游报 key 级错误时把失败交给 key 池记账（是否禁用由自动禁用策略决定），随后换下一个 key 重试；
 * - 未被禁用的失败算软失败：累计到上限或所有 key 都软失败时，透出真实上游错误而不是笼统的"无有效 key"；
 * - 确实把 key 全禁完/池里没有可用 key 时才返回 429 insufficient_quota。
 */
export class KeyRotatingRunner implements CursorRunner {
  private readonly maxKeyAttempts: number;
  private readonly maxTransientAttempts: number;

  constructor(
    private readonly inner: CursorRunner,
    private readonly pool: CursorKeyPool,
    options: KeyRotatingOptions = {}
  ) {
    this.maxKeyAttempts = positiveIntOr(options.maxKeyAttempts, DEFAULT_MAX_KEY_ATTEMPTS);
    this.maxTransientAttempts = positiveIntOr(options.maxTransientAttempts, DEFAULT_MAX_TRANSIENT_ATTEMPTS);
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
      yield* this.inner.stream(input, signal);
      return;
    }

    const attempted = new Set<string>();
    // 最近一次软失败（换过 key 但没禁用）的错误；所有 key 都软失败时透出它而非误报额度耗尽。
    let softError: unknown;
    let softCount = 0;
    for (;;) {
      const key = await this.pool.pickActive(attempted);
      if (!key) {
        if (softError) throw softError;
        throw new ApiError(
          attempted.size
            ? "No valid Cursor API key available: all keys are exhausted or invalid and were disabled automatically. Re-enable keys in the admin panel after quota recovers."
            : (await this.pool.hasAnyKey())
              ? "No valid Cursor API key available: all keys are disabled. Re-enable keys in the admin panel."
              : "No valid Cursor API key available: none configured. Add keys in the admin panel or via CURSOR_API_KEYS.",
          429,
          "insufficient_quota"
        );
      }
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

      let emitted = false;
      // 非流式：整段缓冲到本次尝试成功结束后再放行——失败尝试的任何事件（含 thinking）都不会
      // 泄漏给聚合器，从根上杜绝换 key 重试时跨尝试拼接内容；反正非流式消费方不需要增量。
      const buffering = !input.stream;
      const buffered: CursorStreamEvent[] = [];
      try {
        for await (const event of this.inner.stream({ ...input, apiKey: key.apiKey }, signal)) {
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

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
