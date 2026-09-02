import { ApiError } from "../errors.js";
import type { ModelParameterDefinition, ModelVariantDefinition } from "../types.js";
import { buildConnectHeaders, type ConnectCodec } from "./headers.js";
import { assertUsableCredential, type CursorConnectCredential } from "./credentials.js";
import { postConnectUnary, type ConnectFetch } from "./transport.js";
import {
  AvailableModelsRequest,
  AvailableModelsResponse,
  AvailableModelsResponse_DegradationStatus,
  AvailableModelsScope,
  type AvailableModelsResponse_AvailableModel,
  type ModelParameterDefinition as ProtoModelParameterDefinition
} from "./proto/available_models_pb.js";
import { DEFAULT_CONNECT_BASE_URL, methodUrl } from "./client.js";

/**
 * `aiserver.v1.AiService/AvailableModels`（Unary）。
 *
 * 字段来自 `docs/reference/available-models-descriptor.txt`，由
 * `scripts/extract-descriptor.mjs` 从本机 Cursor 3.18.9 的 bundle 机械抽取，没有一处是猜的。
 *
 * Connect 的 Unary 与 ServerStreaming 走同一套 envelope，所以这里复用同一个 transport：
 * 一发一收，响应里恰好一条消息帧加一条 endStream。
 */
export const AI_SERVICE = "aiserver.v1.AiService";
export const AVAILABLE_MODELS_METHOD = "AvailableModels";

export interface AvailableModelsOptions {
  credential: CursorConnectCredential;
  baseUrl?: string;
  codec?: ConnectCodec;
  readMaxBytes?: number;
  fetchImpl?: ConnectFetch;
  signal?: AbortSignal;
  nowMs?: () => number;
}

/** 目录里一个模型的网关视角摘要。只留网关真正会用到的字段。 */
export interface ConnectModelEntry {
  id: string;
  displayName?: string;
  defaultOn: boolean;
  supportsAgent?: boolean;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  supportsMaxMode?: boolean;
  supportsNonMaxMode?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  /** `DISABLED` 的模型不对外暴露；`DEGRADED` 暴露但要标注。 */
  degradation: "ok" | "degraded" | "disabled";
  /** 参数定义是参数 id 与值域的权威来源，优先于 model-params.ts 的硬编码兜底。 */
  parameters: ModelParameterDefinition[];
  variants: ModelVariantDefinition[];
  aliases: string[];
}

export interface ConnectCatalog {
  models: ConnectModelEntry[];
  /** 子代理的服务端默认模型配置（`subagent_model_configs`，字段 16）。 */
  subagentModels: Record<string, string>;
  /** 对话默认模型（`composer_model_config`）。 */
  defaultModel?: string;
  fetchedAt: number;
}

export async function fetchAvailableModels(options: AvailableModelsOptions): Promise<ConnectCatalog> {
  assertUsableCredential(options.credential);
  const codec = options.codec ?? "proto";

  const request = new AvailableModelsRequest({
    // 与 Grok Bot 的 fetchSandAvailableModels 一致：要参数定义，取用户可见范围。
    useModelParameters: true,
    scope: AvailableModelsScope.USER_AVAILABLE
  });
  // 一元调用：body 是**裸** protobuf，没有 5 字节 envelope，content-type 也是
  // `application/proto` 而不是 `application/connect+proto`。发成流式那套会拿到 415。
  const payload = codec === "json" ? new TextEncoder().encode(request.toJsonString()) : request.toBinary();
  const raw = await postConnectUnary({
    url: methodUrl(options.baseUrl?.trim() || DEFAULT_CONNECT_BASE_URL, AI_SERVICE, AVAILABLE_MODELS_METHOD),
    headers: buildConnectHeaders({
      credential: options.credential,
      codec,
      kind: "unary",
      nowMs: options.nowMs?.()
    }),
    body: payload,
    signal: options.signal,
    fetchImpl: options.fetchImpl
  });

  if (!raw.length) throw new ApiError("Cursor returned an empty model catalog.", 502, "upstream_error");
  const response =
    codec === "json"
      ? AvailableModelsResponse.fromJsonString(Buffer.from(raw).toString("utf8"))
      : AvailableModelsResponse.fromBinary(raw);
  return toCatalog(response);
}

function toCatalog(response: AvailableModelsResponse): ConnectCatalog {
  const subagentModels: Record<string, string> = {};
  for (const [feature, config] of Object.entries(response.subagentModelConfigs)) {
    if (config.defaultModel) subagentModels[feature] = config.defaultModel;
  }
  return {
    models: response.models.map(toEntry).filter((model) => model.id),
    subagentModels,
    ...(response.composerModelConfig?.defaultModel ? { defaultModel: response.composerModelConfig.defaultModel } : {}),
    fetchedAt: Date.now()
  };
}

function toEntry(model: AvailableModelsResponse_AvailableModel): ConnectModelEntry {
  return {
    id: model.name,
    ...(model.clientDisplayName ? { displayName: model.clientDisplayName } : {}),
    defaultOn: model.defaultOn,
    ...(model.supportsAgent === undefined ? {} : { supportsAgent: model.supportsAgent }),
    ...(model.supportsThinking === undefined ? {} : { supportsThinking: model.supportsThinking }),
    ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
    ...(model.supportsMaxMode === undefined ? {} : { supportsMaxMode: model.supportsMaxMode }),
    ...(model.supportsNonMaxMode === undefined ? {} : { supportsNonMaxMode: model.supportsNonMaxMode }),
    ...(model.contextTokenLimit === undefined ? {} : { contextTokenLimit: model.contextTokenLimit }),
    ...(model.contextTokenLimitForMaxMode === undefined
      ? {}
      : { contextTokenLimitForMaxMode: model.contextTokenLimitForMaxMode }),
    degradation: degradationOf(model.degradationStatus),
    parameters: model.parameterDefinitions.map(toParameterDefinition).filter((definition) => definition.values.length),
    variants: model.variants.map((variant) => ({
      displayName: variant.displayName,
      // 目录把默认变体拆成 max / 非 max 两个标志；`resolveModelParams` 只认一个 isDefault，
      // 取非 max 那个作为默认——Max Mode 是显式意图，不该在没人要求时被当成默认。
      ...(variant.isDefaultNonMaxConfig ? { isDefault: true } : {}),
      params: variant.parameterValues.map((value) => ({ id: value.id, value: value.value }))
    })),
    aliases: [...model.legacySlugs, ...model.idAliases]
  };
}

function degradationOf(status: AvailableModelsResponse_DegradationStatus | undefined): ConnectModelEntry["degradation"] {
  if (status === AvailableModelsResponse_DegradationStatus.DEGRADED) return "degraded";
  if (status === AvailableModelsResponse_DegradationStatus.DISABLED) return "disabled";
  return "ok";
}

/**
 * `ModelParameterDefinition` → `model-params.ts` 认识的形状。
 *
 * 参数类型是 oneof（boolean / enum），两种都要摊平成「一组允许值」，
 * 因为下游 `resolveModelParams` 只按值域做匹配。
 */
function toParameterDefinition(definition: ProtoModelParameterDefinition): ModelParameterDefinition {
  const type = definition.parameterType;
  // boolean 与 enum 都摊平成「一组允许值」：下游 resolveModelParams 只按值域匹配。
  const values = [
    ...(type?.booleanParameter?.values ?? []),
    ...(type?.enumParameter?.values ?? [])
  ].map((entry) => ({ value: entry.value, ...(entry.displayName ? { displayName: entry.displayName } : {}) }));
  return {
    id: definition.id,
    ...(definition.name ? { displayName: definition.name } : {}),
    values
  };
}
