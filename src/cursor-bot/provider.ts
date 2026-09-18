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
import { CursorBotClient, type CursorBotClientOptions } from "./client.js";
import { SAND_CLIENT_TYPE, type CursorBotCredential } from "./credentials.js";
import type { ConnectCompression } from "./envelope.js";
import type { ConnectCodec } from "./headers.js";
import {
  buildInferenceStreamRequest,
  type BotConversation,
  type BotInferenceRoute,
  type BotMessage
} from "./request-builder.js";
import { unadvertisedToolCatalog } from "./tool-catalog.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import { InferenceStreamRequest } from "./proto/inference_pb.js";
import type { ConnectFetch } from "./transport.js";

export interface CursorBotProviderOptions {
  /** 每个请求解析一次凭据：调用方可以按 key / 租户挑不同的 credential。 */
  resolveCredential: (input: CursorRunRequest) => CursorBotCredential;
  baseUrl?: string;
  codec?: ConnectCodec;
  requestCompression?: ConnectCompression;
  acceptEncoding?: string;
  readMaxBytes?: number;
  fetchImpl?: ConnectFetch;
  /** 额外出站头（Box relay 路由凭据等），见 buildConnectHeaders。 */
  extraHeaders?: Record<string, string>;
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
   * 是否把调用方的工具表纳入本轮对话（解析 XML / 过滤未声明调用）。
   * 默认 false。真正写进上游 `tools[]` 还要过 `shouldAdvertiseBotTools`：
   * api2 直连一律不声明；Box relay 上 grok 不声明。不声明也能发起调用，
   * 一声明反而 `resource_exhausted`。
   */
  sendTools?: boolean;
  /** 推理出口。直连时所有模型都不把 tools[] 写给上游。 */
  inferenceRoute?: BotInferenceRoute;
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
export class CursorBotProvider implements CursorRunner {
  private readonly catalog?: ModelCatalogCache;

  constructor(private readonly options: CursorBotProviderOptions) {
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
    const client = new CursorBotClient(this.clientOptions(credential));
    const conversation = await this.buildConversation(input, credential);
    // 声明了 tools 才解析正文标记（包 F）：没声明工具时模型把 XML 当普通正文讨论是正常行为。
    // 声明表一并交给 normalizer：marker 还原出的调用按声明过滤 + 别名归一（与 SDK 侧同口径）。
    const normalizer = new ResponseNormalizer({
      parseToolMarkers: (conversation.tools?.length ?? 0) > 0,
      tools: conversation.tools
    });

    this.recordRequestTelemetry(input, conversation);

    try {
      const request = buildInferenceStreamRequest(conversation);
      // 包 D：Bot 的 Connect 请求体全文（JSON 视角——与 json codec 出门格式一致，proto 的字段语义相同）。
      // 在 stream 之前记：编码成信封之后就没有可读副本了。
      try {
        input.debugRef?.noteUpstreamTurn("bot", safeRequestJson(request));
      } catch {
        // 观测路径不得影响请求。
      }
      for await (const frame of client.stream(request, signal)) {
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

  private clientOptions(credential: CursorBotCredential): CursorBotClientOptions {
    return {
      credential,
      baseUrl: this.options.baseUrl,
      codec: this.options.codec,
      requestCompression: this.options.requestCompression,
      acceptEncoding: this.options.acceptEncoding,
      readMaxBytes: this.options.readMaxBytes,
      fetchImpl: this.options.fetchImpl,
      extraHeaders: this.options.extraHeaders,
      nowMs: this.options.nowMs
    };
  }

  private async buildConversation(
    input: CursorRunRequest,
    credential: CursorBotCredential
  ): Promise<BotConversation> {
    const intent = intentFrom(input);
    // 只有真有语义意图时才查目录：没意图时参数一定为空，查了也用不上。
    const needsCatalog = intent.reasoningEffort !== undefined || intent.maxMode !== undefined || intent.fast !== undefined;
    const catalog = needsCatalog ? await this.catalog?.get(input.model, credential.id) : undefined;
    const resolved = resolveRequestedModel({ modelId: input.model, intent, catalog });
    if (resolved.dropped.length) {
      console.warn(
        `[cursor-bot] model="${input.model}" dropped intent: ${resolved.dropped.join(", ")}` +
          (resolved.usedFallback ? " (catalog unavailable, used family fallback)" : "")
      );
    }

    const messages: BotMessage[] = [];
    for (const instruction of this.options.systemInstructions ?? []) {
      if (instruction.trim()) messages.push({ role: "system", text: instruction });
    }
    // sendTools 只决定要不要把 tools[] 写给上游。本地仍拿客户端工具表做 XML 还原
    // 与名字归一——不声明也能发起调用，不带这张表就无法把 Readfile 收成 Read。
    const advertiseTools = this.options.sendTools ? undefined : false;
    const toolCatalog = unadvertisedToolCatalog(
      input.tools,
      input.model,
      advertiseTools,
      this.options.inferenceRoute
    );
    if (toolCatalog) messages.push({ role: "system", text: toolCatalog });
    messages.push({ role: "user", text: input.prompt, ...(input.images.length ? { images: input.images } : {}) });

    return {
      messages,
      ...(input.tools.length ? { tools: input.tools } : {}),
      advertiseTools,
      ...(this.options.inferenceRoute ? { inferenceRoute: this.options.inferenceRoute } : {}),
      conversationId: conversationIdFor(input),
      invocationId: this.options.newInvocationId?.() ?? randomUUID(),
      requestedModel: resolved.requestedModel,
      modelConfig: modelConfigFrom(input)
    };
  }

  /** 下发参数写回 telemetryRef，与 SDK 路线同一条通道，请求日志无需区分 provider。 */
  private recordRequestTelemetry(input: CursorRunRequest, conversation: BotConversation): void {
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

function modelConfigFrom(input: CursorRunRequest): BotConversation["modelConfig"] {
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

/**
 * `InferenceStreamRequest` → 可落盘的 JSON（包 D）。proto 的 toJsonString 可能因为
 * 未初始化的 optional 字段或 BigInt 抛异常，快照绝不能因此打断请求——失败时退回
 * 「messages 数量 + conversationId」的最小摘要并如实标注 parse 失败。
 */
function safeRequestJson(request: InferenceStreamRequest): unknown {
  try {
    return JSON.parse(request.toJsonString()) as unknown;
  } catch (error) {
    return {
      parseFailed: true,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      conversationId: request.conversationId,
      messageCount: request.messages.length
    };
  }
}
