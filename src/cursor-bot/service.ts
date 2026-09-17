import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { ModelCatalog } from "../model-params.js";
import type {
  CursorKeyRecord,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayConfig,
  GatewayProvider,
  GatewayTool,
  RequestUsage
} from "../types.js";
import { fetchAvailableModels, type BotCatalog, type BotModelEntry } from "./available-models.js";
import { exchangeUserApiKey } from "./api-key-exchange.js";
import {
  BoxRelayConnectionManager,
  relayExtraHeaders,
  relayInferenceBaseUrl,
  type BoxRelayConnection
} from "./box-relay.js";
import {
  probeRelay,
  provisionRelay,
  type RelayProbeResult
} from "./relay-provision.js";
import { resolveRequestedModel } from "./catalog.js";
import { CursorBotClient, DEFAULT_BOT_BASE_URL } from "./client.js";
import { toPreparedConversation, type PreparedConversation } from "./conversation.js";
import { withUnadvertisedToolCatalog } from "./tool-catalog.js";
import type { CursorBotCredential } from "./credentials.js";
import {
  KEY_TOKEN_REFRESH_INTERVAL_MS,
  KEY_TOKEN_REFRESH_RETRY_MS,
  SAND_CLIENT_TYPE,
  cursorTokenAccount,
  keyMintedTokenExpired,
  keyMintedTokenNeedsRefresh
} from "./credentials.js";
import { DEFAULT_READ_MAX_BYTES } from "./envelope.js";
import { isUpstreamResourceExhausted } from "./errors.js";
import type { UnifiedEvent } from "./events.js";
import { LocalToolRegistry } from "./local-tools.js";
import {
  bucketExhausted,
  DEFAULT_QUOTA_BUCKET_RESET_MS,
  pruneExhaustedBuckets,
  type QuotaBucket,
  type QuotaBucketHooks
} from "../quota-buckets.js";
import { CursorBotProvider, conversationIdFor } from "./provider.js";
import { buildInferenceStreamRequest } from "./request-builder.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import { SubagentScheduler, subagentTool, type SubagentRunContext } from "./subagent-scheduler.js";
import { runToolLoop, type ToolLoopResult } from "./tool-loop.js";
import { CursorBotStore, type BotCredential } from "./store.js";
import { DEFAULT_BOT_CLIENT_VERSION } from "../config.js";
import type { ConnectFetch } from "./transport.js";

/** 把 `GatewayConfig` 上那一组可选字段收敛成一份带默认值的设置。 */
export interface BotSettings {
  defaultProvider: GatewayProvider;
  baseUrl: string;
  codec: "proto" | "json";
  readMaxBytes: number;
  sendTools: boolean;
  localTools: string[];
  subagents: boolean;
  background: boolean;
  clientVersion: string;
  /** 额外出站头（`CURSOR_BOT_EXTRA_HEADERS`）：Box relay 的路由凭据等。 */
  extraHeaders: Record<string, string>;
  /**
   * 推理出口：`direct` = api2 直连（0.44 前的老路径，现在会被上游以 unauthenticated 拒）；
   * `relay` = 经 Box relay（EnsureSandBox 自动取连接，token 失效自动重取重试）。
   */
  inferenceRoute: "direct" | "relay";
  /**
   * 由 Cursor Key 兑换的 session JWT 到期前是否自动再兑。
   * 只作用于带 sourceCursorKeyId 的凭据。
   */
  autoRefreshFromKey: boolean;
}

export function botSettings(config: GatewayConfig): BotSettings {
  // 包 A：Bot 侧覆盖优先，未覆盖回落顶层 env 默认值（botOverrides 由后台保存 / 启动恢复）。
  const overrides = config.botOverrides;
  return {
    defaultProvider: config.defaultProvider ?? "sdk",
    baseUrl: config.botBaseUrl?.trim() || DEFAULT_BOT_BASE_URL,
    codec: overrides?.codec ?? config.botCodec ?? "proto",
    readMaxBytes: config.botReadMaxBytes ?? DEFAULT_READ_MAX_BYTES,
    sendTools: overrides?.sendTools ?? config.botSendTools ?? false,
    localTools: config.botLocalTools ?? [],
    subagents: config.botSubagents ?? false,
    background: config.botBackground ?? false,
    clientVersion: config.botClientVersion?.trim() || DEFAULT_BOT_CLIENT_VERSION,
    extraHeaders: config.botExtraHeaders ?? {},
    inferenceRoute: overrides?.inferenceRoute ?? config.botInferenceRoute ?? "direct",
    autoRefreshFromKey: overrides?.autoRefreshFromKey ?? config.botAutoRefreshFromKey ?? true
  };
}

/** 目录缓存的存活时长。按凭据分片，不同账号可见的模型不同。 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** 推理出口三要素（direct / relay 的统一表达）。 */
interface InferenceTarget {
  baseUrl: string;
  credential: CursorBotCredential;
  extraHeaders?: Record<string, string>;
}

/** relay 路径上值得重取连接再试一次的错误：
 * - 401/403：Box gateway token 轮换（重取即新 token）；
 * - 502：transport failed —— Box 重启后旧 pod URL 拒连（重取拿到新 gatewayUrl）。
 * 404 不在此列（relay 未装配，换连接无用，streamPlain 已映射成可操作提示）。
 */
function isRelayRetryable(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 502].includes(error.statusCode);
}

/**
 * relay 路由 404 = Box 侧补丁丢失（Box 重建即失），换连接无用，必须给出可操作的归因。
 * 其余错误原样抛。三条 relay 路径（单发单收 / 工具循环 / 子代理 child）共用。
 */
function relayError(error: unknown): unknown {
  if (error instanceof ApiError && error.statusCode === 404) {
    return new ApiError(
      "Box relay 未装配（Box 重建后补丁会丢失）：请在管理后台该 Bot 凭据行重新「装配 relay」。",
      502,
      "upstream_error"
    );
  }
  return error;
}

/** 供后台展示的 relay 状态。 */
export interface RelayStatusReport {
  /** 当前推理出口（settings，非探测结果）。 */
  route: "direct" | "relay";
  /** 缓存的 Box 连接（没有就先 EnsureSandBox 一次）。 */
  connection: {
    /** 只回 host，不回完整 URL——baseUrl 含 pod 标识，没必要进后台页面。 */
    gatewayHost: string;
    runState: string;
    fetchedAt: number;
  };
  probe: RelayProbeResult;
  /** 进行中/刚结束的装配任务。 */
  provisioning?: RelayProvisionSnapshot;
}

/** 装配任务的对外快照。 */
export interface RelayProvisionSnapshot {
  state: "running" | "ok" | "failed";
  startedAt: number;
  finishedAt?: number;
  agentName?: string;
  message: string;
}

interface RelayProvisionJob {
  snapshot: RelayProvisionSnapshot;
}
/** 连续失败到这个数就自动停用凭据，避免一把废 token 把每个请求都拖到超时。也是 Bot 侧禁用阈值的默认值。 */
const CREDENTIAL_FAILURE_LIMIT = 5;

/**
 * Bot 凭据的自动禁用策略（包 A）：读 Bot 侧覆盖，回落 Bot 路线自己的默认（开、阈值 5）。
 * 刻意不回落顶层 autoDisableKeys / autoDisableThreshold——那两个 key 管的是 SDK 的 key 池；
 * 挂上 Bot 会让「为 SDK 关掉自动禁用」顺手把 Bot 凭据的护栏也拆了（反之亦然），升级后行为反而变了。
 */
export function botAutoDisablePolicy(config: GatewayConfig): { enabled: boolean; threshold: number } {
  return {
    enabled: config.botOverrides?.autoDisableKeys ?? true,
    threshold: config.botOverrides?.autoDisableThreshold ?? CREDENTIAL_FAILURE_LIMIT
  };
}

export interface CursorBotServiceOptions {
  store: CursorBotStore;
  config: GatewayConfig;
  fetchImpl?: ConnectFetch;
  workspace?: string;
  /**
   * 包 B：额度分桶钩子（模型 → 桶解析 + 桶耗尽标记，含与源 Cursor key 的双向联动）。
   * 未提供时不做桶过滤、不标桶，行为与改造前一致（测试装配不用改）。
   */
  quotaBuckets?: QuotaBucketHooks;
  /**
   * 解析兑换源 Cursor key。自动刷新 from-key 凭据时用它拿明文 apiKey。
   * 未提供则自动刷新静默跳过（测试装配不必注入）。
   */
  resolveSourceKey?: (
    id: string
  ) => Promise<Pick<CursorKeyRecord, "id" | "apiKey" | "label" | "modelScope" | "status"> | undefined>;
  /** 可注入时钟，方便测到期窗口。 */
  now?: () => Date;
}

/**
 * Cursor Bot 路线的装配层。
 *
 * 它拥有三件事：**凭据轮换**（按最近使用时间挑一把活的）、**目录缓存**（按凭据分片），
 * 以及把两者喂给 `CursorBotProvider`。选路本身在 `router.ts`，不在这里。
 */
export class CursorBotService implements CursorRunner {
  private readonly localTools?: LocalToolRegistry;
  private readonly catalogs = new Map<string, { value: BotCatalog; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<BotCatalog | undefined>>();
  /** relay 模式下按凭据缓存的 Box 连接（EnsureSandBox），失效驱动刷新。 */
  private readonly boxConnections = new BoxRelayConnectionManager();
  /** 装配任务（按凭据至多一个；进程内存态，重启即清）。 */
  private readonly relayProvisions = new Map<string, RelayProvisionJob>();
  /** 同一把凭据的兑换单飞：并发请求不能每人打一次 exchange。 */
  private readonly keyTokenRefreshes = new Map<string, Promise<BotCredential>>();
  /** 兑换失败后的退避截止（credential id → epoch ms）。 */
  private readonly keyTokenRefreshBackoffUntil = new Map<string, number>();
  private keyTokenRefreshTimer?: ReturnType<typeof setInterval>;
  /** runId → SSE 订阅者。事件先落库、再从这里推出去。 */
  private readonly listeners = new Map<string, Set<(event: UnifiedEvent) => void>>();

  constructor(private readonly options: CursorBotServiceOptions) {
    if (botSettings(options.config).localTools.length) {
      this.localTools = new LocalToolRegistry({
        workspace: options.workspace ?? options.config.cursorWorkingDirectory,
        allowlist: botSettings(options.config).localTools
      });
    }
  }

  /**
   * 每次现查而不是构造时固化（包 A）：后台改 Bot 侧覆盖（sendTools / codec 等）要立即生效，
   * 不能让启动时的快照把运行期改动挡住。botSettings 是纯函数、开销可忽略；
   * localTools 的注册表仍只在构造时建——它绑定工作区，不属于可运行期修改的运行设置。
   */
  private get settings(): BotSettings {
    return botSettings(this.options.config);
  }

  get available(): boolean {
    return this.options.store.activeCredentials().length > 0;
  }

  get store(): CursorBotStore {
    return this.options.store;
  }

  /**
   * 事件订阅。SSE 端点先订阅、再补发历史，中间到达的事件靠 `ReplayBridge` 的缓冲兜住。
   * 订阅方抛异常不能影响其它订阅方，更不能把产生事件的那条 run 打断。
   */
  subscribe(runId: string, listener: (event: UnifiedEvent) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }

  publish(event: UnifiedEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // 订阅方（一条 SSE 连接）自己炸了不该波及别人。
      }
    }
  }

  /** 供后台展示：这条路线现在能不能服务请求，不能的话是缺什么。 */
  status(): { available: boolean; credentials: number; activeCredentials: number; reason?: string } {
    const all = this.options.store.listCredentials();
    const active = all.filter((credential) => credential.status === "active");
    return {
      available: active.length > 0,
      credentials: all.length,
      activeCredentials: active.length,
      ...(active.length ? {} : { reason: all.length ? "所有 Bot 凭据都已停用" : "还没有配置 Bot 凭据" })
    };
  }

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    let result: CursorRunResult | undefined;
    for await (const event of this.stream(input, signal)) {
      if (event.type === "done") result = event.result;
    }
    return result ?? { text: "", toolCalls: [] };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    // 包 B：整条请求（含失败标桶、成功清标记）都按这个桶算。vendor 推断用目录缓存里的
    // 任意一份——vendor 是模型属性，与用哪把凭据拉到的目录无关。
    const bucket = this.options.quotaBuckets?.resolveBucket(input.model, this.anyVendorIsCursor(input.model));
    let credential = await this.pickFreshKeyToken(input.model, bucket);
    let yieldedAny = false;
    try {
      for await (const event of this.dispatchStream(credential, input, signal)) {
        yieldedAny = true;
        yield event;
      }
      this.options.store.recordCredentialUse(credential.id, bucket);
    } catch (error) {
      // 短票过期表现为 401/403。还没向客户端吐过事件时，强制再兑一次然后重放整轮。
      // 已经吐过内容的流绝不重放（客户端已收到一半）。
      if (!yieldedAny && this.canRetryAuthWithKeyRefresh(credential, error)) {
        credential = await this.refreshFromSourceKey(credential, { force: true, allowDisabledKey: true });
        try {
          for await (const event of this.dispatchStream(credential, input, signal)) {
            yield event;
          }
          this.options.store.recordCredentialUse(credential.id, bucket);
          return;
        } catch (retryError) {
          this.noteFailure(credential, retryError, input.model);
          throw retryError;
        }
      }
      this.noteFailure(credential, error, input.model);
      throw error;
    }
  }

  /** 网关侧需要代跑工具（本地工具 / 子代理）时走多轮循环；否则单发单收。 */
  private async *dispatchStream(
    credential: BotCredential,
    input: CursorRunRequest,
    signal?: AbortSignal
  ): AsyncIterable<CursorStreamEvent> {
    const orchestrated = this.orchestratedTools(input);
    if (orchestrated.length) yield* this.streamWithTools(credential, input, orchestrated, signal);
    else yield* this.streamPlain(credential, input, signal);
  }

  /**
   * 单发单收路径。relay 模式下带一次性重试：
   * 连接后**尚未产出任何事件**时遇 401/403/502（Box token 轮换 / Box 重启换了 pod）→
   * 失效缓存重取连接再来一次；已经吐过内容的流绝不重放（客户端已收到一半）。
   */
  private async *streamPlain(
    credential: BotCredential,
    input: CursorRunRequest,
    signal?: AbortSignal
  ): AsyncIterable<CursorStreamEvent> {
    if (this.settings.inferenceRoute !== "relay") {
      yield* this.providerFor(credential, input, await this.inferenceTarget(credential)).stream(input, signal);
      return;
    }
    for (let attempt = 0; ; attempt += 1) {
      let yieldedAny = false;
      try {
        const target = await this.inferenceTarget(credential);
        for await (const event of this.providerFor(credential, input, target).stream(input, signal)) {
          yieldedAny = true;
          yield event;
        }
        return;
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) throw relayError(error);
        if (yieldedAny || attempt >= 1 || !isRelayRetryable(error)) throw error;
        this.boxConnections.invalidate(credential.id);
      }
    }
  }

  /** 推理出口三要素：direct = settings 原样；relay = EnsureSandBox 连接换 baseUrl/token/头。 */
  private async inferenceTarget(credential: BotCredential): Promise<InferenceTarget> {
    const base = {
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      fetchImpl: this.options.fetchImpl
    };
    if (this.settings.inferenceRoute !== "relay") {
      return {
        baseUrl: this.settings.baseUrl,
        credential: toProviderCredential(credential),
        extraHeaders: this.settings.extraHeaders
      };
    }
    const connection = await this.boxConnections.get(credential, {
      baseUrl: this.settings.baseUrl,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    return {
      baseUrl: relayInferenceBaseUrl(connection),
      // relay 用 Box gateway token 鉴权；session JWT 只用来换连接（EnsureSandBox）。
      credential: { ...toProviderCredential(credential), sessionToken: connection.gatewayToken },
      extraHeaders: { ...this.settings.extraHeaders, ...relayExtraHeaders(connection) }
    };
  }
  private orchestratedTools(input: CursorRunRequest): GatewayTool[] {
    // 网关自己负责执行的工具：本地工具 + 子代理。调用方声明的工具不在此列。
    if (!this.settings.sendTools) return [];
    return [...(this.localTools?.advertise() ?? []), ...(this.settings.subagents ? [subagentTool()] : [])];
  }

  /**
   * 多轮工具循环。
   *
   * 每一轮都是一次新的 `Stream` 请求：`conversation_id` 不变、`invocation_id` 每轮新生成。
   * **上游是否真按 conversation_id 接续尚未实测**（计划 §P2），所以这条路只有在运维显式
   * 打开 `CURSOR_BOT_SEND_TOOLS` 之后才会走到。
   */
  private async *streamWithTools(
    credential: BotCredential,
    input: CursorRunRequest,
    orchestrated: GatewayTool[],
    signal?: AbortSignal
  ): AsyncIterable<CursorStreamEvent> {
    const conversation = this.conversationFor(input, orchestrated);
    const catalog = await this.modelCatalogFor(credential, input.model);
    const resolved = resolveRequestedModel({
      modelId: input.model,
      intent: {
        reasoningEffort: input.reasoningEffort,
        maxMode: input.maxMode,
        fast: input.fast,
        params: input.modelParams,
        mode: input.mode
      },
      catalog
    });

    // run / conversation 落库：工具调用的幂等、事件重放、background 恢复都挂在这两行上。
    const row = this.options.store.upsertConversation({
      ownerHash: input.sessionKey,
      upstreamConversationId: conversation.conversationId,
      defaultModel: input.model
    });
    const run = this.options.store.createRun({
      conversationId: row.id,
      requestedModel: input.model,
      status: "running",
      ...(resolved.parameters.length ? { parametersJson: JSON.stringify(resolved.parameters) } : {})
    });
    this.options.store.leaseRun(run.id, "inline", 300_000);

    const scheduler = this.settings.subagents
      ? new SubagentScheduler({
          store: this.options.store,
          runChild: async (context) => this.runChild(credential, context),
          ...(input.gatewayModelScope ? { modelScope: input.gatewayModelScope } : {})
        })
      : undefined;

    // 工具编排是多次上游往返：连接取一次复用整轮（token 刚换新，中途轮换属极端情形）。
    // relay 下必须能重取：连接缓存不设 TTL、纯失效驱动刷新，这条路径若不 invalidate，
    // Box 重启/token 轮换后缓存里的坏连接永远修不好——而开了工具编排之后**所有**请求
    // 都走这里，没有任何路径会去修它（单发单收的自愈路径走不到），子代理就此永久不可用。
    const buildGenerator = (client: CursorBotClient) => runToolLoop(
      {
        client,
        store: this.options.store,
        executeTool: async (call, context) =>
          (await this.localTools?.execute(call, context.signal)) ??
          (await scheduler?.executor({
            runId: run.id,
            conversation,
            depth: 0,
            model: resolved.requestedModel
          })(call)),
        onEvents: (drafts, iteration) => {
          for (const event of this.options.store.appendEvents(run.id, row.id, drafts, iteration)) this.publish(event);
        }
      },
      {
        conversation,
        requestedModel: resolved.requestedModel,
        runId: run.id,
        ...(signal ? { signal } : {}),
        // 包 D：上游轮次全文经 debugRef 回写（server 侧在 CursorRunRequest 上挂的快照通道）。
        ...(input.debugRef ? { debugRef: input.debugRef } : {})
      }
    );

    try {
      const result = yield* this.driveToolLoop(credential, buildGenerator, run.id);
      if (input.telemetryRef) {
        input.telemetryRef.upstreamModel = result.resolvedModel ?? resolved.requestedModel.modelId;
        input.telemetryRef.clientType = SAND_CLIENT_TYPE;
        if (resolved.parameters.length) input.telemetryRef.modelParams = resolved.parameters;
        if (result.usage) input.telemetryRef.usage = result.usage;
        input.telemetryRef.runId = run.id;
      }
      this.options.store.updateRun(run.id, { ...(result.usage ? { usage: result.usage } : {}) });
      // 还等着调用方交结果时不能记成完成：那会让重连逻辑以为这一轮已经收尾。
      this.options.store.releaseRunLease(
        run.id,
        result.stoppedBecause === "awaiting_caller" ? "awaiting_tool" : "completed"
      );
      yield {
        type: "done",
        result: {
          text: result.text,
          toolCalls: result.pendingToolCalls,
          ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
          runId: run.id
        }
      };
    } catch (error) {
      scheduler?.cancelAll();
      this.options.store.updateRun(run.id, { errorJson: JSON.stringify({ message: errorText(error) }) });
      this.options.store.releaseRunLease(run.id, "failed");
      throw error;
    }
  }

  /** 子代理的 child run：同一把凭据、独立 conversation、可以是不同模型。 */
  /**
   * 驱动工具循环，并在 relay 下补上「首个事件产出前可重取连接」的自愈能力。
   *
   * 重试边界与 streamPlain 同口径：只要已经 yield 过事件就绝不重跑（客户端收到一半的流
   * 不能重放）。首事件之前重跑是安全的——runToolLoop 的 messages 是本地副本、事件副作用
   * （appendEvents）只在收到事件时发生，所以此时重建 generator 等价于第一次发起。
   * run 行只在外层建一次，重试复用同一个 runId，不会产生重复行。
   */
  private async *driveToolLoop(
    credential: BotCredential,
    buildGenerator: (client: CursorBotClient) => AsyncGenerator<CursorStreamEvent, ToolLoopResult>,
    runId: string
  ): AsyncGenerator<CursorStreamEvent, ToolLoopResult> {
    for (let attempt = 0; ; attempt += 1) {
      let yieldedAny = false;
      try {
        const target = await this.inferenceTarget(credential);
        const generator = buildGenerator(new CursorBotClient({
          credential: target.credential,
          baseUrl: target.baseUrl,
          codec: this.settings.codec,
          readMaxBytes: this.settings.readMaxBytes,
          extraHeaders: target.extraHeaders,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
        }));
        let next = await generator.next();
        while (!next.done) {
          yieldedAny = true;
          yield next.value;
          next = await generator.next();
        }
        return next.value;
      } catch (error) {
        if (this.settings.inferenceRoute !== "relay") throw error;
        if (error instanceof ApiError && error.statusCode === 404) throw relayError(error);
        if (yieldedAny || attempt >= 1 || !isRelayRetryable(error)) throw error;
        // 坏连接必须丢掉：缓存不设 TTL，不 invalidate 就永远拿同一个坏连接（runId=${runId} 这轮之后也一样）。
        this.boxConnections.invalidate(credential.id);
      }
    }
  }

  private async runChild(credential: BotCredential, context: SubagentRunContext): Promise<{ text: string; isError?: boolean; usage?: RequestUsage }> {
    const request = buildInferenceStreamRequest({
      messages: [{ role: "user", text: context.prompt }],
      // child 默认不继承父的工具，`tools` 由 scheduler 按 childTools 决定。
      ...(context.tools.length ? { tools: context.tools } : {}),
      conversationId: context.conversationId,
      invocationId: context.invocationId,
      requestedModel: context.requestedModel
    });
    // child 的增量不对外流式输出（父轮次只要最终文本），所以整段重跑没有"流放了一半"的问题：
    // relay 下连接坏掉时可以直接换连接重来一次，与 streamPlain / driveToolLoop 同口径。
    for (let attempt = 0; ; attempt += 1) {
      // child 声明了工具时同样可能收到正文形态的调用，开启同款标记还原（包 F）；
      // 还原出的调用同样按声明过滤 + 别名归一（与 SDK 侧同口径，见 ResponseNormalizer）。
      // normalizer 必须每次重建：重试要的是干净的聚合状态，不能接着上次的残文往下拼。
      const normalizer = new ResponseNormalizer({ parseToolMarkers: context.tools.length > 0, tools: context.tools });
      try {
        const target = await this.inferenceTarget(credential);
        const client = new CursorBotClient({
          credential: target.credential,
          baseUrl: target.baseUrl,
          codec: this.settings.codec,
          readMaxBytes: this.settings.readMaxBytes,
          extraHeaders: target.extraHeaders,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
        });
        for await (const frame of client.stream(request, context.signal)) {
          for (const _ of normalizer.accept(frame)) {
            // child 的增量不对外流式输出，父轮次只要它的最终文本。
          }
        }
        return {
          // 读 result() 而不是 state.text：held / 未闭合 marker 的尾部残文只有 result() 的
          // 聚合口径收全了（这里没人迭代 flush 事件），直接读 state 会漏最后一段正文。
          text: normalizer.result().text,
          ...(normalizer.state.usage ? { usage: normalizer.state.usage } : {})
        };
      } catch (error) {
        if (this.settings.inferenceRoute !== "relay") throw error;
        if (error instanceof ApiError && error.statusCode === 404) throw relayError(error);
        if (attempt >= 1 || !isRelayRetryable(error)) throw error;
        this.boxConnections.invalidate(credential.id);
      }
    }
  }

  /** 结构化对话。有原始 body 就走 G5 的解析器，否则退回单条 user 文本。 */
  private conversationFor(input: CursorRunRequest, tools: GatewayTool[]): PreparedConversation {
    const conversationId = conversationIdFor(input);
    const advertiseTools = this.settings.sendTools ? undefined : false;
    let prepared: PreparedConversation;
    if (input.rawBody && input.inboundProtocol) {
      try {
        prepared = toPreparedConversation(input.rawBody, input.inboundProtocol, {
          conversationId,
          tools: [...input.tools, ...tools]
        });
      } catch {
        // 解析失败退回合成 prompt，不能让它把请求打挂。
        prepared = fallbackConversation(input, tools, conversationId);
      }
    } else {
      prepared = fallbackConversation(input, tools, conversationId);
    }
    // grok 不声明 tools[]：把本轮真实工具名写进 SYSTEM，自研 agent 只在 tools[] 里声明时也能看见。
    return withUnadvertisedToolCatalog(prepared, input.model, advertiseTools);
  }

  /**
   * 挑一把可用凭据。
   *
   * 按 `lastUsedAt` 升序里的**最近使用者优先**（fill-first）：与 SDK 路线的默认策略一致，
   * 换凭据会丢掉上游按设备/账号维持的 prompt 缓存。
   *
   * 包 B：bucket 给出时，该桶已耗尽且未到期的凭据不参与候选（顺手懒清除到期标记并落库）。
   * 全部候选都耗尽时回落到不过滤——标记只是网关自己的保守估计，宁可照常试也不能直接 503。
   */
  pickCredential(model?: string, bucket?: QuotaBucket): BotCredential {
    const active = this.options.store.activeCredentials().filter((credential) => allowsModel(credential, model));
    let usable = active;
    if (bucket && active.length) {
      const filtered = active.filter((credential) => {
        const pruned = pruneExhaustedBuckets(credential.exhaustedBuckets);
        if (pruned !== credential.exhaustedBuckets) {
          this.options.store.setCredentialExhaustedBuckets(credential.id, pruned);
        }
        return !bucketExhausted(pruned, bucket);
      });
      // 全部候选都耗尽时回落到不过滤：标记只是网关自己的保守估计，宁可照常试也不能直接 503。
      if (filtered.length) usable = filtered;
    }
    if (!usable.length) {
      const total = this.options.store.listCredentials().length;
      throw new ApiError(
        total
          ? "No usable Cursor Bot credential for this model."
          : "Cursor Bot is not configured; add a credential in the admin console.",
        503,
        "provider_unavailable"
      );
    }
    // 最近用过的排前面，尽量固定在同一把上。
    return usable.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0];
  }

  /** 目录：按凭据分片缓存，失败短缓存，不让一次抖动把之后几分钟全拖成降级。 */
  async catalog(credential: BotCredential, force = false): Promise<BotCatalog | undefined> {
    const cached = this.catalogs.get(credential.id);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const existing = this.inflight.get(credential.id);
    if (existing && !force) return existing;

    const pending = fetchAvailableModels({
      credential,
      baseUrl: this.settings.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      extraHeaders: this.settings.extraHeaders,
      fetchImpl: this.options.fetchImpl
    })
      .then((value) => {
        this.catalogs.set(credential.id, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
        this.inflight.delete(credential.id);
        return value;
      })
      .catch((error: unknown) => {
        this.inflight.delete(credential.id);
        // 目录拿不到不该让推理请求失败：`resolveModelParams` 有家族兜底。
        console.warn(`[cursor-bot] model catalog unavailable: ${errorText(error)}`);
        return undefined;
      });
    this.inflight.set(credential.id, pending);
    return pending;
  }

  /** 对外模型列表（`/v1/models` 的 Bot 视角）。DISABLED 的不暴露。 */
  async listModels(force = false): Promise<BotModelEntry[]> {
    const credential = await this.pickFreshKeyToken();
    const catalog = await this.catalog(credential, force);
    return (catalog?.models ?? []).filter((model) => model.degradation !== "disabled");
  }

  /** 连通性测试：后台按钮用。成功返回目录规模，失败原样把错误交回去。 */
  async testCredential(credentialId: string): Promise<{ ok: true; models: number; defaultModel?: string }> {
    const credential = await this.ensureFreshKeyToken(this.requireCredential(credentialId));
    try {
      const catalog = await fetchAvailableModels({
        credential,
        baseUrl: this.settings.baseUrl,
        codec: this.settings.codec,
        readMaxBytes: this.settings.readMaxBytes,
        extraHeaders: this.settings.extraHeaders,
        fetchImpl: this.options.fetchImpl
      });
      this.catalogs.set(credential.id, { value: catalog, expiresAt: Date.now() + CATALOG_TTL_MS });
      this.options.store.recordCredentialUse(credential.id);
      return {
        ok: true,
        models: catalog.models.length,
        ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {})
      };
    } catch (error) {
      this.noteFailure(credential, error);
      throw error;
    }
  }

  /**
   * 写入一份 Bot session JWT。同一 Cursor 账号（JWT `sub` → user id）已有凭据则覆盖，
   * 保留原来的 machineId。未传入 `sourceCursorKeyId` 时摘掉 Key 池绑定——
   * 手工粘贴 / 桌面导入绝不能被自动刷新兑掉。
   */
  async putSessionCredential(input: {
    sessionToken: string;
    label?: string;
    machineId?: string;
    macMachineId?: string;
    clientVersion?: string;
    clientOs?: string;
    clientArch?: string;
    deviceType?: string;
    timezone?: string;
    allowedModels?: string[];
    excludedModels?: string[];
    sourceCursorKeyId?: string | null;
    accountEmail?: string;
    lookupEmail?: boolean;
  }): Promise<BotCredential> {
    const sessionToken = input.sessionToken.trim();
    if (!sessionToken) throw new ApiError("sessionToken is required.", 400, "invalid_request_error", "sessionToken");
    const account = cursorTokenAccount(sessionToken);
    const existing =
      (input.sourceCursorKeyId ? this.options.store.credentialBySourceKeyId(input.sourceCursorKeyId) : undefined) ??
      (account ? this.options.store.credentialByUserId(account.userId) : undefined);
    let accountEmail = input.accountEmail?.trim() || existing?.accountEmail || account?.email;
    if (input.lookupEmail !== false && !accountEmail) {
      accountEmail = (await this.lookupAccountEmail(sessionToken)) ?? undefined;
    }
    // 未显式传入 = 手工写入（粘贴 / 桌面导入），必须摘掉 Key 池绑定。
    // 不能按 JWT type 判断：粘一张 api_key_token 上去若仍挂着 sourceCursorKeyId，
    // 自动刷新会在一小时内把它兑回短票，等于手工填写作废。
    const sourceCursorKeyId = input.sourceCursorKeyId !== undefined ? input.sourceCursorKeyId : null;
    const write = (target?: BotCredential): BotCredential =>
      this.options.store.upsertCredential({
        ...(target ? { id: target.id } : {}),
        label: input.label?.trim() || target?.label || accountEmail || account?.userId,
        sessionToken,
        machineId: target?.machineId || input.machineId?.trim() || randomUUID(),
        macMachineId: input.macMachineId,
        clientVersion: input.clientVersion ?? this.settings.clientVersion,
        ...(!target
          ? {
              clientOs: input.clientOs ?? process.platform,
              clientArch: input.clientArch ?? process.arch,
              deviceType: input.deviceType ?? "desktop"
            }
          : {}),
        timezone: input.timezone,
        allowedModels: input.allowedModels,
        excludedModels: input.excludedModels,
        sourceCursorKeyId,
        accountEmail: accountEmail ?? null,
        status: "active"
      });
    const previousToken = existing?.sessionToken;
    try {
      const written = write(existing);
      if (written.sessionToken !== previousToken) this.boxConnections.invalidate(written.id);
      return written;
    } catch (error) {
      const raced = account ? this.options.store.credentialByUserId(account.userId) : undefined;
      if (raced) {
        const written = write(raced);
        if (written.sessionToken !== previousToken) this.boxConnections.invalidate(written.id);
        return written;
      }
      throw error;
    }
  }

  private async lookupAccountEmail(sessionToken: string): Promise<string | undefined> {
    const doFetch = this.options.fetchImpl ?? ((input, init) => fetch(input, init));
    const account = cursorTokenAccount(sessionToken);
    try {
      const stripe = await doFetch("https://api2.cursor.sh/auth/full_stripe_profile", {
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(5_000)
      });
      if (stripe.ok) {
        const body: unknown = await stripe.json();
        const email =
          body && typeof body === "object"
            ? (body as { email?: unknown; membership?: { email?: unknown } }).email ??
              (body as { membership?: { email?: unknown } }).membership?.email
            : undefined;
        if (typeof email === "string" && email.includes("@")) return email.trim();
      }
    } catch {
      // 邮箱查询失败不挡导入。
    }
    if (!account?.userId.startsWith("user_")) return undefined;
    try {
      const me = await doFetch("https://cursor.com/api/dashboard/get-me", {
        method: "POST",
        headers: {
          cookie: `WorkosCursorSessionToken=${account.userId}::${sessionToken}`,
          "content-type": "application/json",
          origin: "https://cursor.com"
        },
        body: "{}",
        signal: AbortSignal.timeout(5_000)
      });
      if (!me.ok) return undefined;
      const body: unknown = await me.json();
      const email = body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
      if (typeof email === "string" && email.includes("@")) return email.trim();
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * 写入本机 Grok Bot / Cursor 桌面端的长效 session JWT。
   * 同一账号已有凭据则覆盖；machineId 只在新建时使用。
   */
  async importDesktopSession(input: {
    sessionToken: string;
    machineId: string;
    label?: string;
  }): Promise<BotCredential> {
    const sessionToken = input.sessionToken.trim();
    const machineId = input.machineId.trim();
    if (!sessionToken) throw new ApiError("sessionToken is required.", 400, "invalid_request_error", "sessionToken");
    if (!machineId) throw new ApiError("machineId is required.", 400, "invalid_request_error", "machineId");
    return this.putSessionCredential({
      sessionToken,
      machineId,
      label: input.label,
      lookupEmail: true
    });
  }

  /**
   * 用 Cursor Key 池里的 `crsr_` 向上游兑换 session JWT，写成 Bot 凭据。
   * 同一把 key 再拉一次只换 token，machineId 保持不变。
   */
  async importFromCursorKey(
    key: Pick<CursorKeyRecord, "id" | "apiKey" | "label" | "modelScope">,
    options: { label?: string; machineId?: string } = {}
  ): Promise<BotCredential> {
    const tokens = await exchangeUserApiKey({
      apiKey: key.apiKey,
      baseUrl: this.settings.baseUrl,
      fetchImpl: this.options.fetchImpl
    });
    const existing = this.options.store.credentialBySourceKeyId(key.id);
    const label = options.label?.trim() || key.label?.trim() || existing?.label;
    return this.putSessionCredential({
      sessionToken: tokens.accessToken,
      label,
      machineId: existing?.machineId || options.machineId?.trim(),
      sourceCursorKeyId: key.id,
      allowedModels: key.modelScope.allowed,
      excludedModels: key.modelScope.excluded,
      lookupEmail: false
    });
  }

  private providerFor(credential: BotCredential, input: CursorRunRequest, target: InferenceTarget): CursorBotProvider {
    return new CursorBotProvider({
      resolveCredential: () => target.credential,
      baseUrl: target.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      sendTools: this.settings.sendTools,
      extraHeaders: target.extraHeaders,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      // 目录喂给参数解析：`parameter_definitions` 是参数 id 与值域的权威来源，
      // 拿到它之后 model-params.ts 的硬编码只作兜底。
      getModelCatalog: async (modelId) => this.modelCatalogFor(credential, modelId),
      ...(this.systemInstructions(input).length ? { systemInstructions: this.systemInstructions(input) } : {})
    });
  }

  /** 结构化 system：入站原始 body 在，就用 G5 的解析器，避免 system 被拼进 user 文本。 */
  private systemInstructions(input: CursorRunRequest): string[] {
    if (!input.rawBody || !input.inboundProtocol) return [];
    try {
      return toPreparedConversation(input.rawBody, input.inboundProtocol).systemInstructions;
    } catch {
      // 解析不了就退回「system 已经在 prompt 里」的老形态，不能让它把请求打挂。
      return [];
    }
  }

  private async modelCatalogFor(credential: BotCredential, modelId: string): Promise<ModelCatalog | undefined> {
    const catalog = await this.catalog(credential);
    const wanted = modelId.trim().toLowerCase();
    const entry = catalog?.models.find(
      (model) => model.id.toLowerCase() === wanted || model.aliases.some((alias) => alias.toLowerCase() === wanted)
    );
    if (!entry) return undefined;
    return { parameters: entry.parameters, variants: entry.variants };
  }

  /* -------------------------------------------------- relay 状态与装配（P3，后台用） */

  /**
   * 后台「relay 状态」：确保连接（EnsureSandBox）→ 探测路由 → 附上装配任务快照。
   * 探测有网络往返（上限 30s），只供后台按钮触发，不进请求热路径。
   */
  async relayStatus(credentialId: string): Promise<RelayStatusReport> {
    const credential = await this.ensureFreshKeyToken(this.requireCredential(credentialId));
    const connection = await this.boxConnections.get(credential, {
      baseUrl: this.settings.baseUrl,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    const probe = await probeRelay(connection, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    // 探测发现 token 轮换就顺手失效缓存：下一次 get 拿新连接。
    if (probe.status === "auth-expired") this.boxConnections.invalidate(credential.id);
    return {
      route: this.settings.inferenceRoute,
      connection: {
        gatewayHost: new URL(connection.gatewayUrl).host,
        runState: connection.runState.toString(),
        fetchedAt: connection.fetchedAt
      },
      probe,
      ...(this.relayProvisions.has(credential.id)
        ? { provisioning: this.relayProvisions.get(credential.id)!.snapshot }
        : {})
    };
  }

  /**
   * 后台「装配 relay」：发指令给 Box agent 并轮询到就绪（异步任务，立即返回快照）。
   * 同一凭据同时只跑一个；装配指令会出现在所选 Bot 的聊天里，属预期。
   */
  startRelayProvision(credentialId: string): RelayProvisionSnapshot {
    const credential = this.requireCredential(credentialId);
    const existing = this.relayProvisions.get(credential.id);
    if (existing?.snapshot.state === "running") return existing.snapshot;

    const snapshot: RelayProvisionSnapshot = {
      state: "running",
      startedAt: Date.now(),
      message: "正在获取 Box 连接…"
    };
    this.relayProvisions.set(credential.id, { snapshot });

    const getConnection = async (): Promise<BoxRelayConnection> => {
      const fresh = await this.ensureFreshKeyToken(this.requireCredential(credential.id));
      return this.boxConnections.get(fresh, {
        baseUrl: this.settings.baseUrl,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
      });
    };
    // 装配期间连接可能因 host 重启轮换：探测报 auth/不可达就失效重取。
    const refreshedConnection = async (): Promise<BoxRelayConnection> => {
      try {
        return await getConnection();
      } catch (error) {
        this.boxConnections.invalidate(credential.id);
        throw error;
      }
    };

    void provisionRelay(refreshedConnection, (message) => {
      snapshot.message = message;
    }, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    })
      .then((outcome) => {
        snapshot.state = outcome.ok ? "ok" : "failed";
        snapshot.finishedAt = Date.now();
        snapshot.agentName = outcome.agentName;
        snapshot.message = outcome.detail;
      })
      .catch((error: unknown) => {
        snapshot.state = "failed";
        snapshot.finishedAt = Date.now();
        snapshot.message = `装配未启动：${errorText(error)}`;
      });

    return { ...snapshot };
  }

  /**
   * 由 Key 兑换的短票巡检。进程启动时打开；后台改开关立即生效（每次 tick 现查 settings）。
   * 关停时必须 stopKeyTokenRefresh，否则 interval 会拖住进程。
   */
  startKeyTokenRefresh(): void {
    if (this.keyTokenRefreshTimer) return;
    const tick = (): void => {
      void this.refreshExpiringKeyTokens().catch((error: unknown) => {
        console.error(`[cursor-bot] key token refresh tick failed: ${errorText(error)}`);
      });
    };
    this.keyTokenRefreshTimer = setInterval(tick, KEY_TOKEN_REFRESH_INTERVAL_MS);
    tick();
    console.log(`[cursor-bot] key-minted token auto-refresh every ${KEY_TOKEN_REFRESH_INTERVAL_MS / 1000}s`);
  }

  stopKeyTokenRefresh(): void {
    if (!this.keyTokenRefreshTimer) return;
    clearInterval(this.keyTokenRefreshTimer);
    this.keyTokenRefreshTimer = undefined;
  }

  /** 巡检 from-key 凭据：到期窗口内的再兑一次。自动刷新关闭时直接返回。 */
  async refreshExpiringKeyTokens(): Promise<void> {
    if (!this.settings.autoRefreshFromKey || !this.options.resolveSourceKey) return;
    for (const credential of this.options.store.listCredentials()) {
      if (!credential.sourceCursorKeyId) continue;
      // 停用的也扫：过期后 401 曾把凭据自动停掉，只扫 active 会永远兑不到，只能靠按钮。
      if (credential.status !== "active" && !keyMintedTokenNeedsRefresh(credential, this.nowMs())) continue;
      await this.ensureFreshKeyToken(credential);
    }
  }

  /**
   * 后台「刷新」：无视到期窗口与自动刷新开关，只要有 sourceCursorKeyId 就再兑一次。
   */
  async refreshCredentialFromSourceKey(credentialId: string): Promise<BotCredential> {
    const credential = this.requireCredential(credentialId);
    if (!credential.sourceCursorKeyId) {
      throw new ApiError("这份凭据不是从 Cursor Key 兑换的，无法自动刷新。", 400, "invalid_request_error");
    }
    return this.refreshFromSourceKey(credential, { force: true, allowDisabledKey: true });
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /**
   * 选一把活的 from-key 凭据并保证短票未进入到期窗口。
   * 全部停用时先尝试用源 Key 救活过期的 from-key 凭据，再选一次。
   */
  private async pickFreshKeyToken(model?: string, bucket?: QuotaBucket): Promise<BotCredential> {
    try {
      return await this.ensureFreshKeyToken(this.pickCredential(model, bucket));
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 503 || !this.settings.autoRefreshFromKey) throw error;
      const revived = await this.reviveFromKeyCredentials();
      if (!revived) throw error;
      return await this.ensureFreshKeyToken(this.pickCredential(model, bucket));
    }
  }

  private async reviveFromKeyCredentials(): Promise<boolean> {
    if (!this.options.resolveSourceKey) return false;
    let revived = false;
    for (const credential of this.options.store.listCredentials()) {
      if (!credential.sourceCursorKeyId) continue;
      const next = await this.refreshFromSourceKey(credential, { force: true, allowDisabledKey: true });
      if (next.status === "active") revived = true;
    }
    return revived;
  }

  private canRetryAuthWithKeyRefresh(credential: BotCredential, error: unknown): boolean {
    if (!credential.sourceCursorKeyId || !this.options.resolveSourceKey) return false;
    if (!this.settings.autoRefreshFromKey) return false;
    return error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
  }

  private async ensureFreshKeyToken(credential: BotCredential): Promise<BotCredential> {
    if (!credential.sourceCursorKeyId || !this.options.resolveSourceKey) return credential;
    if (!this.settings.autoRefreshFromKey) return credential;
    if (!keyMintedTokenNeedsRefresh(credential, this.nowMs())) return credential;
    const expired = keyMintedTokenExpired(credential, this.nowMs()) || credential.status !== "active";
    return this.refreshFromSourceKey(credential, { force: expired, allowDisabledKey: expired });
  }

  private async refreshFromSourceKey(
    credential: BotCredential,
    options: { force: boolean; allowDisabledKey: boolean }
  ): Promise<BotCredential> {
    const inflight = this.keyTokenRefreshes.get(credential.id);
    if (inflight) return inflight;
    const task = this.doRefreshFromSourceKey(credential, options).finally(() => {
      this.keyTokenRefreshes.delete(credential.id);
    });
    this.keyTokenRefreshes.set(credential.id, task);
    return task;
  }

  private async doRefreshFromSourceKey(
    credential: BotCredential,
    options: { force: boolean; allowDisabledKey: boolean }
  ): Promise<BotCredential> {
    const sourceKeyId = credential.sourceCursorKeyId?.trim();
    if (!sourceKeyId) return credential;
    const backoffUntil = this.keyTokenRefreshBackoffUntil.get(credential.id) ?? 0;
    if (!options.force && backoffUntil > this.nowMs()) return credential;

    const key = await this.options.resolveSourceKey?.(sourceKeyId);
    if (!key?.apiKey) {
      if (options.force) {
        throw new ApiError("源 Cursor Key 已不在池里，无法刷新这份凭据。", 404, "not_found", "cursorKeyId");
      }
      return credential;
    }
    if (key.status === "disabled" && !options.allowDisabledKey) return credential;

    try {
      const next = await this.importFromCursorKey(key);
      this.keyTokenRefreshBackoffUntil.delete(credential.id);
      this.options.store.setCredentialLastError(next.id, null);
      if (next.sessionToken !== credential.sessionToken) {
        console.log(`[cursor-bot] refreshed key-minted session token for credential ${next.id}`);
      }
      return next;
    } catch (error) {
      this.keyTokenRefreshBackoffUntil.set(credential.id, this.nowMs() + KEY_TOKEN_REFRESH_RETRY_MS);
      this.options.store.setCredentialLastError(credential.id, `刷新 session token 失败：${errorText(error)}`);
      if (options.force) throw error;
      console.error(`[cursor-bot] failed to refresh key-minted token for credential ${credential.id}: ${errorText(error)}`);
      return credential;
    }
  }

  private requireCredential(credentialId: string): BotCredential {
    const credential = this.options.store.credential(credentialId);
    if (!credential) throw new ApiError("Credential not found.", 404, "not_found");
    return credential;
  }

  private noteFailure(credential: BotCredential, error: unknown, model?: string): void {    const status = error instanceof ApiError ? error.statusCode : 500;
    // 包 B：只有**上游 EndStream 帧亲口带回的** resource_exhausted 才算额度桶耗尽
    // （isUpstreamResourceExhausted 的 symbol 标记只有 endStreamError 会挂）。本地构造的 429
    // ——EnvelopeTooLargeError 是 502、InferenceStreamError 的 RATE_LIMIT 不带标记——都不会进这。
    // 只标桶：凭据保持 active，不计失败、不禁用，同 key 的 other 桶模型照常可用。
    if (status === 429 && isUpstreamResourceExhausted(error)) {
      const hooks = this.options.quotaBuckets;
      if (hooks) {
        const bucket = hooks.resolveBucket(model, this.anyVendorIsCursor(model));
        const expiresAt = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
        hooks.markCredentialExhausted(credential.id, bucket, expiresAt);
      }
      return;
    }
    // 402：账号级欠费（Connect 协议的 HTTP 层状态码，httpTransportError 原样透传到
    // ApiError.statusCode；endStream 那条路出不了 402——Connect code 表里没有它）。
    // 欠费是账号级的，影响全部额度桶，语义对齐 key-pool 的 quota 失败：一次即禁用，
    // 不等阈值累计；并经 sourceCursorKeyId 联动禁用兑换出这把凭据的源 Cursor key
    //（同一个账号一起欠费，两侧都该停）。
    if (status === 402) {
      this.options.store.recordCredentialFailure(credential.id, errorText(error));
      if (botAutoDisablePolicy(this.options.config).enabled) {
        this.options.store.setCredentialStatus(credential.id, "disabled");
        console.error(`[cursor-bot] credential ${credential.id} disabled after quota failure (402)`);
        if (credential.sourceCursorKeyId) {
          this.options.quotaBuckets?.disableSourceKey?.(credential.sourceCursorKeyId, errorText(error));
        }
      }
      return;
    }
    // 只有凭据本身的问题才计数。429/5xx 是上游状态，跟这把 token 的有效性无关，
    // 按失败累计会把一次限流演变成把凭据停掉。
    if (status !== 401 && status !== 403) return;
    // from-key 短票过期是预期的：记痕迹但不累计、不停用。停用后巡检只扫 active，就只能靠按钮救。
    if (credential.sourceCursorKeyId && this.settings.autoRefreshFromKey) {
      this.options.store.setCredentialLastError(credential.id, errorText(error));
      return;
    }
    const failures = this.options.store.recordCredentialFailure(credential.id, errorText(error));
    // 包 A：Bot 侧禁用策略独立于 SDK 的 key 池；未覆盖时保持改造前的默认（开、阈值 5）。
    const policy = botAutoDisablePolicy(this.options.config);
    if (policy.enabled && failures >= policy.threshold) {
      this.options.store.setCredentialStatus(credential.id, "disabled");
      console.error(`[cursor-bot] credential ${credential.id} disabled after ${failures} auth failures`);
    }
  }

  /**
   * 包 B：从目录缓存里查模型的 vendor 是否 Cursor 自家（额度分桶的兜底信号）。
   * vendor 是模型属性，任意凭据拉到的目录都行；缓存里查不到就返回 undefined，
   * 让 resolveBucket 走主表 / default——归类不确定时往「不标错桶」的方向退。
   */
  private anyVendorIsCursor(model?: string): boolean | undefined {
    if (!model) return undefined;
    const wanted = model.trim().toLowerCase();
    for (const cached of this.catalogs.values()) {
      const entry = cached.value.models.find(
        (candidate) =>
          candidate.id.toLowerCase() === wanted ||
          candidate.aliases.some((alias) => alias.toLowerCase() === wanted)
      );
      if (entry) return entry.vendorIsCursor;
    }
    return undefined;
  }
}

/** 库里的凭据行 → provider 要的凭据形状。空字段一律不带，避免发出空串头。 */
function toProviderCredential(credential: BotCredential): CursorBotCredential {
  return {
    id: credential.id,
    ...(credential.label ? { label: credential.label } : {}),
    sessionToken: credential.sessionToken,
    machineId: credential.machineId,
    ...(credential.macMachineId ? { macMachineId: credential.macMachineId } : {}),
    clientVersion: credential.clientVersion,
    ...(credential.clientOs ? { clientOs: credential.clientOs } : {}),
    ...(credential.clientArch ? { clientArch: credential.clientArch } : {}),
    ...(credential.clientOsVersion ? { clientOsVersion: credential.clientOsVersion } : {}),
    ...(credential.deviceType ? { deviceType: credential.deviceType } : {}),
    ...(credential.clientKey ? { clientKey: credential.clientKey } : {}),
    ...(credential.sessionId ? { sessionId: credential.sessionId } : {}),
    ...(credential.timezone ? { timezone: credential.timezone } : {})
  };
}

function fallbackConversation(
  input: CursorRunRequest,
  tools: GatewayTool[],
  conversationId: string
): PreparedConversation {
  return {
    messages: [{ role: "user", text: input.prompt, ...(input.images.length ? { images: input.images } : {}) }],
    systemInstructions: [],
    tools: [...input.tools, ...tools],
    conversationId,
    invocationId: randomUUID()
  };
}

function allowsModel(credential: BotCredential, model?: string): boolean {
  if (!model) return true;
  const wanted = model.trim().toLowerCase();
  if (credential.excludedModels?.some((entry) => entry.toLowerCase() === wanted)) return false;
  if (!credential.allowedModels?.length) return true;
  return credential.allowedModels.some((entry) => entry.toLowerCase() === wanted);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

/**
 * 首次启动时把 env 里的 token 播种进库。
 *
 * machineId 不给就生成一个并**永久保存**：每次启动换一个的话，上游看到的是每次一台新设备。
 */
export function seedBotCredential(store: CursorBotStore, config: GatewayConfig): BotCredential | undefined {
  const token = config.botSessionToken?.trim();
  if (!token) return undefined;
  const existing = store.listCredentials().find((credential) => credential.label === "env");
  const settings = botSettings(config);
  if (existing) {
    // token 变了才更新，避免每次启动都写一遍库。
    if (existing.sessionToken === token) return existing;
    return store.upsertCredential({
      id: existing.id,
      label: "env",
      sessionToken: token,
      machineId: existing.machineId,
      clientVersion: settings.clientVersion
    });
  }
  return store.upsertCredential({
    label: "env",
    sessionToken: token,
    machineId: config.botMachineId?.trim() || randomUUID(),
    clientVersion: settings.clientVersion,
    clientOs: process.platform,
    clientArch: process.arch,
    deviceType: "desktop"
  });
}
