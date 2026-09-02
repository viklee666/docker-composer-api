import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { ModelCatalog } from "../model-params.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayConfig,
  GatewayProvider,
  GatewayTool,
  RequestUsage
} from "../types.js";
import { fetchAvailableModels, type ConnectCatalog, type ConnectModelEntry } from "./available-models.js";
import { resolveRequestedModel } from "./catalog.js";
import { CursorConnectClient, DEFAULT_CONNECT_BASE_URL } from "./client.js";
import { toPreparedConversation, type PreparedConversation } from "./conversation.js";
import type { CursorConnectCredential } from "./credentials.js";
import { SAND_CLIENT_TYPE } from "./credentials.js";
import { DEFAULT_READ_MAX_BYTES } from "./envelope.js";
import type { UnifiedEvent } from "./events.js";
import { LocalToolRegistry } from "./local-tools.js";
import { CursorConnectProvider, conversationIdFor } from "./provider.js";
import { buildInferenceStreamRequest } from "./request-builder.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import { SubagentScheduler, subagentTool, type SubagentRunContext } from "./subagent-scheduler.js";
import { runToolLoop } from "./tool-loop.js";
import { CursorConnectStore, type CcCredential } from "./store.js";
import { DEFAULT_CONNECT_CLIENT_VERSION } from "../config.js";
import type { ConnectFetch } from "./transport.js";

/** 把 `GatewayConfig` 上那一组可选字段收敛成一份带默认值的设置。 */
export interface ConnectSettings {
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

export function connectSettings(config: GatewayConfig): ConnectSettings {
  return {
    defaultProvider: config.defaultProvider ?? "sdk",
    baseUrl: config.connectBaseUrl?.trim() || DEFAULT_CONNECT_BASE_URL,
    codec: config.connectCodec ?? "proto",
    readMaxBytes: config.connectReadMaxBytes ?? DEFAULT_READ_MAX_BYTES,
    sendTools: config.connectSendTools ?? false,
    localTools: config.connectLocalTools ?? [],
    subagents: config.connectSubagents ?? false,
    background: config.connectBackground ?? false,
    clientVersion: config.connectClientVersion?.trim() || DEFAULT_CONNECT_CLIENT_VERSION
  };
}

/** 目录缓存的存活时长。按凭据分片，不同账号可见的模型不同。 */
const CATALOG_TTL_MS = 5 * 60 * 1000;
/** 连续失败到这个数就自动停用凭据，避免一把废 token 把每个请求都拖到超时。 */
const CREDENTIAL_FAILURE_LIMIT = 5;

export interface CursorConnectServiceOptions {
  store: CursorConnectStore;
  config: GatewayConfig;
  fetchImpl?: ConnectFetch;
  workspace?: string;
}

/**
 * Connect 路线的装配层。
 *
 * 它拥有三件事：**凭据轮换**（按最近使用时间挑一把活的）、**目录缓存**（按凭据分片），
 * 以及把两者喂给 `CursorConnectProvider`。选路本身在 `router.ts`，不在这里。
 */
export class CursorConnectService implements CursorRunner {
  private readonly settings: ConnectSettings;
  private readonly localTools?: LocalToolRegistry;
  private readonly catalogs = new Map<string, { value: ConnectCatalog; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<ConnectCatalog | undefined>>();
  /** runId → SSE 订阅者。事件先落库、再从这里推出去。 */
  private readonly listeners = new Map<string, Set<(event: UnifiedEvent) => void>>();

  constructor(private readonly options: CursorConnectServiceOptions) {
    this.settings = connectSettings(options.config);
    if (this.settings.localTools.length) {
      this.localTools = new LocalToolRegistry({
        workspace: options.workspace ?? options.config.cursorWorkingDirectory,
        allowlist: this.settings.localTools
      });
    }
  }

  get available(): boolean {
    return this.options.store.activeCredentials().length > 0;
  }

  get store(): CursorConnectStore {
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
      ...(active.length ? {} : { reason: all.length ? "所有 Connect 凭据都已停用" : "还没有配置 Connect 凭据" })
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
    const credential = this.pickCredential(input.model);
    try {
      // 网关侧需要代跑工具（本地工具 / 子代理）时走多轮循环；否则单发单收。
      // 两条路都产出同样的 `CursorStreamEvent`，对外 SSE 层不区分。
      const orchestrated = this.orchestratedTools(input);
      if (orchestrated.length) yield* this.streamWithTools(credential, input, orchestrated, signal);
      else yield* this.providerFor(credential, input).stream(input, signal);
      this.options.store.recordCredentialUse(credential.id);
    } catch (error) {
      this.noteFailure(credential, error);
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
   * 打开 `CURSOR_CONNECT_SEND_TOOLS` 之后才会走到。
   */
  private async *streamWithTools(
    credential: CcCredential,
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

    const client = new CursorConnectClient({
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
        ...(signal ? { signal } : {})
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
  private async runChild(credential: CcCredential, context: SubagentRunContext): Promise<{ text: string; isError?: boolean; usage?: RequestUsage }> {
    const client = new CursorConnectClient({
      credential: toProviderCredential(credential),
      baseUrl: this.settings.baseUrl,
      codec: this.settings.codec,
      readMaxBytes: this.settings.readMaxBytes,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    const normalizer = new ResponseNormalizer();
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
      text: normalizer.state.text,
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
   */
  pickCredential(model?: string): CcCredential {
    const active = this.options.store.activeCredentials().filter((credential) => allowsModel(credential, model));
    if (!active.length) {
      const total = this.options.store.listCredentials().length;
      throw new ApiError(
        total
          ? "No usable Cursor Connect credential for this model."
          : "Cursor Connect is not configured; add a credential in the admin console.",
        503,
        "provider_unavailable"
      );
    }
    // 最近用过的排前面，尽量固定在同一把上。
    return active.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0];
  }

  /** 目录：按凭据分片缓存，失败短缓存，不让一次抖动把之后几分钟全拖成降级。 */
  async catalog(credential: CcCredential, force = false): Promise<ConnectCatalog | undefined> {
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
        console.warn(`[cursor-connect] model catalog unavailable: ${errorText(error)}`);
        return undefined;
      });
    this.inflight.set(credential.id, pending);
    return pending;
  }

  /** 对外模型列表（`/v1/models` 的 Connect 视角）。DISABLED 的不暴露。 */
  async listModels(force = false): Promise<ConnectModelEntry[]> {
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

  private providerFor(credential: CcCredential, input: CursorRunRequest): CursorConnectProvider {
    return new CursorConnectProvider({
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

  private async modelCatalogFor(credential: CcCredential, modelId: string): Promise<ModelCatalog | undefined> {
    const catalog = await this.catalog(credential);
    const wanted = modelId.trim().toLowerCase();
    const entry = catalog?.models.find(
      (model) => model.id.toLowerCase() === wanted || model.aliases.some((alias) => alias.toLowerCase() === wanted)
    );
    if (!entry) return undefined;
    return { parameters: entry.parameters, variants: entry.variants };
  }

  private noteFailure(credential: CcCredential, error: unknown): void {
    const status = error instanceof ApiError ? error.statusCode : 500;
    // 只有凭据本身的问题才计数。429/5xx 是上游状态，跟这把 token 的有效性无关，
    // 按失败累计会把一次限流演变成把凭据停掉。
    if (status !== 401 && status !== 403) return;
    const failures = this.options.store.recordCredentialFailure(credential.id, errorText(error));
    if (failures >= CREDENTIAL_FAILURE_LIMIT) {
      this.options.store.setCredentialStatus(credential.id, "disabled");
      console.error(`[cursor-connect] credential ${credential.id} disabled after ${failures} auth failures`);
    }
  }
}

/** 库里的凭据行 → provider 要的凭据形状。空字段一律不带，避免发出空串头。 */
function toProviderCredential(credential: CcCredential): CursorConnectCredential {
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

function allowsModel(credential: CcCredential, model?: string): boolean {
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
export function seedConnectCredential(store: CursorConnectStore, config: GatewayConfig): CcCredential | undefined {
  const token = config.connectSessionToken?.trim();
  if (!token) return undefined;
  const existing = store.listCredentials().find((credential) => credential.label === "env");
  const settings = connectSettings(config);
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
    machineId: config.connectMachineId?.trim() || randomUUID(),
    clientVersion: settings.clientVersion,
    clientOs: process.platform,
    clientArch: process.arch,
    deviceType: "desktop"
  });
}
