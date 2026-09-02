import { createHash, randomUUID } from "node:crypto";
import { durableIdentity } from "../durable-id.js";
import type { ModelIntent } from "../model-params.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  ModelParameterValue
} from "../types.js";
import { ModelCatalogCache, resolveRequestedModel, type ModelCatalogPort } from "./catalog.js";
import { CursorConnectClient, type CursorConnectClientOptions } from "./client.js";
import { SAND_CLIENT_TYPE, type CursorConnectCredential } from "./credentials.js";
import type { ConnectCompression } from "./envelope.js";
import type { ConnectCodec } from "./headers.js";
import { buildInferenceStreamRequest, type ConnectConversation, type ConnectMessage } from "./request-builder.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import type { ConnectFetch } from "./transport.js";

export interface CursorConnectProviderOptions {
  /** 每个请求解析一次凭据：调用方可以按 key / 租户挑不同的 credential。 */
  resolveCredential: (input: CursorRunRequest) => CursorConnectCredential;
  baseUrl?: string;
  codec?: ConnectCodec;
  requestCompression?: ConnectCompression;
  acceptEncoding?: string;
  readMaxBytes?: number;
  fetchImpl?: ConnectFetch;
  /** 模型目录来源；缺省时不查目录，参数解析走 model-params.ts 的家族兜底。 */
  getModelCatalog?: ModelCatalogPort;
  catalogTtlMs?: number;
  /**
   * 独立的 system 指令，映射成 `role=SYSTEM(4)` 的消息。
   *
   * `CursorRunRequest.prompt` 是 protocol.ts 合成好的单串文本，system 已经拼在里面，
   * 所以这里默认为空——两边都发会重复。结构化 system 要等 G5 把
   * `PreparedConversation` 接进来，届时这个选项由调用方填。
   */
  systemInstructions?: string[];
  /**
   * 是否向上游声明 `tools[]`。默认 false。
   *
   * request-builder 与 response-normalizer 都已按 descriptor 实现了工具的编解码，
   * 但「同 conversation_id、新 invocation_id 的第二次 Stream 请求能否接续」尚未实测（G6/P2），
   * 在那之前声明工具会让模型发起一轮网关接不住的调用。
   */
  sendTools?: boolean;
  /** 供测试注入。 */
  newInvocationId?: () => string;
  nowMs?: () => number;
}

/**
 * 走 `aiserver.v1.InferenceService/Stream` 的 provider。
 *
 * 直接实现现有 `CursorRunner`，不引入新的 provider 抽象：这样 `server.ts`、
 * `key-rotating-runner.ts` 和三套 SSE 输出层一行都不用改，SDK 路线也不受影响。
 * 真正需要新接口的是工具 loop 与 background（G6/G9），到那时再定，现在定必然要推翻。
 */
export class CursorConnectProvider implements CursorRunner {
  private readonly catalog?: ModelCatalogCache;

  constructor(private readonly options: CursorConnectProviderOptions) {
    if (options.getModelCatalog) {
      this.catalog = new ModelCatalogCache(options.getModelCatalog, { ttlMs: options.catalogTtlMs });
    }
  }

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    let result: CursorRunResult | undefined;
    for await (const event of this.stream(input, signal)) {
      if (event.type === "done") result = event.result;
    }
    return result ?? { text: "", toolCalls: [] };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    const credential = this.options.resolveCredential(input);
    // 先建 client：它的构造函数会校验凭据。放在 buildConversation 之后的话，
    // 一份缺字段的凭据要先白跑一次目录查询（可能是网络往返）才会被拒。
    const client = new CursorConnectClient(this.clientOptions(credential));
    const conversation = await this.buildConversation(input, credential);
    const normalizer = new ResponseNormalizer();

    this.recordRequestTelemetry(input, conversation);

    try {
      for await (const frame of client.stream(buildInferenceStreamRequest(conversation), signal)) {
        yield* normalizer.accept(frame);
      }
    } finally {
      // 失败的 run 一样要落用量：上游可能已经发过 usage 帧就报错了，
      // 只在成功路径回写会让这部分计费凭空消失。
      this.recordResponseTelemetry(input, normalizer);
    }
    yield* normalizer.flush();
    yield { type: "done", result: normalizer.result() };
  }

  private clientOptions(credential: CursorConnectCredential): CursorConnectClientOptions {
    return {
      credential,
      baseUrl: this.options.baseUrl,
      codec: this.options.codec,
      requestCompression: this.options.requestCompression,
      acceptEncoding: this.options.acceptEncoding,
      readMaxBytes: this.options.readMaxBytes,
      fetchImpl: this.options.fetchImpl,
      nowMs: this.options.nowMs
    };
  }

  private async buildConversation(
    input: CursorRunRequest,
    credential: CursorConnectCredential
  ): Promise<ConnectConversation> {
    const intent = intentFrom(input);
    // 只有真有语义意图时才查目录：没意图时参数一定为空，查了也用不上。
    const needsCatalog = intent.reasoningEffort !== undefined || intent.maxMode !== undefined || intent.fast !== undefined;
    const catalog = needsCatalog ? await this.catalog?.get(input.model, credential.id) : undefined;
    const resolved = resolveRequestedModel({ modelId: input.model, intent, catalog });
    if (resolved.dropped.length) {
      console.warn(
        `[cursor-connect] model="${input.model}" dropped intent: ${resolved.dropped.join(", ")}` +
          (resolved.usedFallback ? " (catalog unavailable, used family fallback)" : "")
      );
    }

    const messages: ConnectMessage[] = [];
    for (const instruction of this.options.systemInstructions ?? []) {
      if (instruction.trim()) messages.push({ role: "system", text: instruction });
    }
    messages.push({ role: "user", text: input.prompt, ...(input.images.length ? { images: input.images } : {}) });

    return {
      messages,
      ...(this.options.sendTools && input.tools.length ? { tools: input.tools } : {}),
      conversationId: conversationIdFor(input),
      invocationId: this.options.newInvocationId?.() ?? randomUUID(),
      requestedModel: resolved.requestedModel,
      modelConfig: modelConfigFrom(input)
    };
  }

  /** 下发参数写回 telemetryRef，与 SDK 路线同一条通道，请求日志无需区分 provider。 */
  private recordRequestTelemetry(input: CursorRunRequest, conversation: ConnectConversation): void {
    const telemetry = input.telemetryRef;
    if (!telemetry) return;
    telemetry.upstreamModel = conversation.requestedModel.modelId;
    const parameters = conversation.requestedModel.parameters as ModelParameterValue[] | undefined;
    if (parameters?.length) telemetry.modelParams = parameters;
    telemetry.clientType = SAND_CLIENT_TYPE;
  }

  private recordResponseTelemetry(input: CursorRunRequest, normalizer: ResponseNormalizer): void {
    const telemetry = input.telemetryRef;
    if (!telemetry) return;
    if (normalizer.state.usage) telemetry.usage = normalizer.state.usage;
    // 走 Stream 时上游没有 run_ready，response_info.model 是唯一的解析结果回填来源。
    if (normalizer.state.resolvedModel) telemetry.upstreamModel = normalizer.state.resolvedModel;
    if (normalizer.state.responseId) telemetry.runId = normalizer.state.responseId;
  }
}

function intentFrom(input: CursorRunRequest): ModelIntent {
  return {
    reasoningEffort: input.reasoningEffort,
    maxMode: input.maxMode,
    fast: input.fast,
    params: input.modelParams,
    mode: input.mode
  };
}

function modelConfigFrom(input: CursorRunRequest): ConnectConversation["modelConfig"] {
  const config = {
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
    stopSequences: input.stop
  };
  return Object.values(config).some((value) => value !== undefined) ? config : undefined;
}

/**
 * 同一段对话要发同一个 `conversation_id`，否则上游每轮都当新对话（prompt 缓存也就没了）。
 *
 * 身份沿用 `durableIdentity`，但必须再看 `reuseDurableAgent`：Chat / Messages 只靠
 * system+首条 user 哈希认「同一段对话」时，server 会把该位置 false。
 * 此时若仍用 seed 当 conversation_id，互不相干的外部请求会在上游挤进同一段对话，
 * 并发 Stream 被标成 canceled → 网关日志 499。后台联通性测试没有 seed，每次新 UUID，所以测得通。
 *
 * 认不出身份、或明确不复用时，每次新开一段。禁止拿 ownerHash / 裸 sessionKey 兜底。
 */
export function conversationIdFor(input: CursorRunRequest): string {
  if (input.reuseDurableAgent === false) return randomUUID();
  const identity = durableIdentity({
    conversationSeed: input.conversationSeed,
    stickyKey: input.stickyKey
  });
  return identity ? stableUuid(`${identity}\u0000${input.model}`) : randomUUID();
}

/** 由稳定字符串派生一个形如 UUID 的标识（客户端那边 conversation_id 就是 uuid 形状）。 */
function stableUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
