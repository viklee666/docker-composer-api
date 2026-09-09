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
import { resolveRequestedModel } from "./catalog.js";
import { CursorBotClient, DEFAULT_BOT_BASE_URL } from "./client.js";
import { toPreparedConversation, type PreparedConversation } from "./conversation.js";
import type { CursorBotCredential } from "./credentials.js";
import { SAND_CLIENT_TYPE } from "./credentials.js";
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
import { runToolLoop } from "./tool-loop.js";
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
    clientVersion: config.botClientVersion?.trim() || DEFAULT_BOT_CLIENT_VERSION
  };
}

/** 目录缓存的存活时长。按凭据分片，不同账号可见的模型不同。 */
const CATALOG_TTL_MS = 5 * 60 * 1000;
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
    const credential = this.pickCredential(input.model, bucket);
    try {
      // 网关侧需要代跑工具（本地工具 / 子代理）时走多轮循环；否则单发单收。
      // 两条路都产出同样的 `CursorStreamEvent`，对外 SSE 层不区分。
      const orchestrated = this.orchestratedTools(input);
      if (orchestrated.length) yield* this.streamWithTools(credential, input, orchestrated, signal);
      else yield* this.providerFor(credential, input).stream(input, signal);
      this.options.store.recordCredentialUse(credential.id, bucket);
    } catch (error) {
      this.noteFailure(credential, error, input.model);
      throw error;
    }
  }

  /** 网关自己负责执行的工具：本地工具 + 子代理。调用方声明的工具不在此列（由调用方自己执行）。 */
  private orchestratedTools(input: CursorRunRequest): GatewayTool[] {
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

    const client = new CursorBotClient({
      credential: toProviderCredential(credential),
      baseUrl: this.settings.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
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

    const generator = runToolLoop(
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
      let next = await generator.next();
      while (!next.done) {
        yield next.value;
        next = await generator.next();
      }
      const result = next.value;
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
  private async runChild(credential: BotCredential, context: SubagentRunContext): Promise<{ text: string; isError?: boolean; usage?: RequestUsage }> {
    const client = new CursorBotClient({
      credential: toProviderCredential(credential),
      baseUrl: this.settings.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    // child 声明了工具时同样可能收到正文形态的调用，开启同款标记还原（包 F）；
    // 还原出的调用同样按声明过滤 + 别名归一（与 SDK 侧同口径，见 ResponseNormalizer）。
    const normalizer = new ResponseNormalizer({ parseToolMarkers: context.tools.length > 0, tools: context.tools });
    const request = buildInferenceStreamRequest({
      messages: [{ role: "user", text: context.prompt }],
      // child 默认不继承父的工具，`tools` 由 scheduler 按 childTools 决定。
      ...(context.tools.length ? { tools: context.tools } : {}),
      conversationId: context.conversationId,
      invocationId: context.invocationId,
      requestedModel: context.requestedModel
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
  }

  /** 结构化对话。有原始 body 就走 G5 的解析器，否则退回单条 user 文本。 */
  private conversationFor(input: CursorRunRequest, tools: GatewayTool[]): PreparedConversation {
    const conversationId = conversationIdFor(input);
    if (input.rawBody && input.inboundProtocol) {
      try {
        return toPreparedConversation(input.rawBody, input.inboundProtocol, {
          conversationId,
          tools: [...input.tools, ...tools]
        });
      } catch {
        // 解析失败退回合成 prompt，不能让它把请求打挂。
      }
    }
    return {
      messages: [{ role: "user", text: input.prompt, ...(input.images.length ? { images: input.images } : {}) }],
      systemInstructions: [],
      tools: [...input.tools, ...tools],
      conversationId,
      invocationId: randomUUID()
    };
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
    const credential = this.pickCredential();
    const catalog = await this.catalog(credential, force);
    return (catalog?.models ?? []).filter((model) => model.degradation !== "disabled");
  }

  /** 连通性测试：后台按钮用。成功返回目录规模，失败原样把错误交回去。 */
  async testCredential(credentialId: string): Promise<{ ok: true; models: number; defaultModel?: string }> {
    const credential = this.options.store.credential(credentialId);
    if (!credential) throw new ApiError("Credential not found.", 404, "not_found");
    try {
      const catalog = await fetchAvailableModels({
        credential,
        baseUrl: this.settings.baseUrl,
        codec: this.settings.codec,
        readMaxBytes: this.settings.readMaxBytes,
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
    const write = (target?: BotCredential): BotCredential =>
      this.options.store.upsertCredential({
        ...(target ? { id: target.id } : {}),
        label,
        sessionToken: tokens.accessToken,
        machineId: target?.machineId || options.machineId?.trim() || randomUUID(),
        clientVersion: this.settings.clientVersion,
        ...(!target
          ? { clientOs: process.platform, clientArch: process.arch, deviceType: "desktop" }
          : {}),
        sourceCursorKeyId: key.id,
        allowedModels: key.modelScope.allowed,
        excludedModels: key.modelScope.excluded,
        status: "active"
      });
    try {
      return write(existing);
    } catch (error) {
      // 两个进程同时首次导入同一把 key 时，输家撞 UNIQUE。改走更新而不是把兑换结果丢掉。
      const raced = this.options.store.credentialBySourceKeyId(key.id);
      if (raced) return write(raced);
      throw error;
    }
  }

  private providerFor(credential: BotCredential, input: CursorRunRequest): CursorBotProvider {
    return new CursorBotProvider({
      resolveCredential: () => toProviderCredential(credential),
      baseUrl: this.settings.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      sendTools: this.settings.sendTools,
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

  private noteFailure(credential: BotCredential, error: unknown, model?: string): void {
    const status = error instanceof ApiError ? error.statusCode : 500;
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
