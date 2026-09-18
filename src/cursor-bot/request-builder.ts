import { Struct, Value, type JsonValue } from "@bufbuild/protobuf";
import { ApiError } from "../errors.js";
import type { GatewayImage, GatewayTool, GatewayToolCall, ModelParameterValue } from "../types.js";
import {
  InferenceAgentTool,
  InferenceContentPart,
  InferenceContentParts,
  InferenceCoreMessage,
  InferenceImagePart,
  InferenceMessageRole,
  InferenceModelConfig,
  InferenceModelParameterValue,
  InferenceReasoningPart,
  InferenceRequestedModel,
  InferenceStreamRequest,
  InferenceTextPart,
  InferenceToolCall,
  InferenceToolResultContent,
  InferenceToolResultPart
} from "./proto/inference_pb.js";

export type BotRole = "system" | "user" | "assistant" | "tool";
export type BotInferenceRoute = "direct" | "relay";

const ROLE_ENUM: Record<BotRole, InferenceMessageRole> = {
  system: InferenceMessageRole.SYSTEM,
  user: InferenceMessageRole.USER,
  assistant: InferenceMessageRole.ASSISTANT,
  tool: InferenceMessageRole.TOOL
};

/** 上一轮的思考片段。`signature` 存在时必须原样带回，否则 extended thinking 的连续性会断。 */
export interface BotReasoningPart {
  text: string;
  signature?: string;
  isRedacted?: boolean;
  redactedData?: string;
  modelName?: string;
}

export interface BotToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

export interface BotMessage {
  role: BotRole;
  text?: string;
  images?: GatewayImage[];
  /** assistant 轮次里模型发起的工具调用；与 content 不是 oneof，可以和文本共存。 */
  toolCalls?: GatewayToolCall[];
  reasoning?: BotReasoningPart[];
  /** 仅 role=tool 有意义。 */
  toolResults?: BotToolResult[];
}

export interface BotRequestedModel {
  modelId: string;
  maxMode?: boolean;
  parameters?: ModelParameterValue[];
  /** 内置模型 true，BYOK/自定义 false。 */
  builtInModel?: boolean;
  /**
   * `model_id` 本身是 `gpt-5.5@1m:high` 这类变体串时才置 true。
   * 网关已经把变体串解析成结构化 parameters，所以恒为 false。
   */
  isVariantStringRepresentation?: boolean;
}

export interface BotModelConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface BotConversation {
  messages: BotMessage[];
  tools?: GatewayTool[];
  /**
   * 是否把 `tools[]` 写进上游请求。缺省按模型 + 出口：
   * api2 直连一律不声明；Box relay 上 grok 不声明、其余声明。
   * 显式 `true` / `false` 盖过默认（排障用）。
   *
   * 网关本地仍拿 `tools` 做 XML 还原与未声明过滤——不声明也能发起调用。
   */
  advertiseTools?: boolean;
  /** 推理出口。缺省按「非直连」处理，保持单测与旧调用点行为。 */
  inferenceRoute?: BotInferenceRoute;
  /** 同一段对话内保持稳定。 */
  conversationId: string;
  conversationGroupId?: string;
  /** 每次请求新生成。 */
  invocationId: string;
  requestedModel: BotRequestedModel;
  modelConfig?: BotModelConfig;
}

/** 与 model-params 家族兜底同一口径：这些模型走 Anthropic 后端。 */
const CLAUDE_FAMILY = /claude|opus|sonnet|haiku|fable/i;

export function isClaudeFamily(modelId: string): boolean {
  return CLAUDE_FAMILY.test(modelId.trim());
}

/**
 * 走 InferenceService 时不要轻易把 `tools[]` 写进请求。
 *
 * 实测：
 * - grok（relay / 直连）：一声明就 `resource_exhausted`；不声明仍会打结构化
 *   `tool_call` 帧或正文 `<tool_call>` XML。
 * - api2 直连：所有模型一声明都 `resource_exhausted`（与 grok 同症状）。
 * - Box relay 上 composer / luna：仍要声明，否则不会走工具。
 *
 * 不声明时，grok / GPT 把名字写进 `accepted_unadvertised_tool_names`。
 * Claude 直连连这份名单也会 `resource_exhausted`（同包 GPT 能过、无工具 ping 能过）。
 *
 * 后续轮次回放 thinking 时，Claude 直连还会把网关自造的 signature 写进
 * `reasoning_parts`，api2 同样用 `resource_exhausted` 拒（首轮没有这段历史就能过）。
 */
export function shouldAdvertiseBotTools(
  modelId: string,
  override?: boolean,
  route?: BotInferenceRoute
): boolean {
  if (override === false) return false;
  if (override === true) return true;
  if (route === "direct") return false;
  return !/grok/i.test(modelId.trim());
}

/** 不能写 tools[] 时，要不要改走 accepted_unadvertised_tool_names。 */
export function shouldSendUnadvertisedToolNames(
  modelId: string,
  override?: boolean,
  route?: BotInferenceRoute
): boolean {
  if (override === false) return false;
  if (shouldAdvertiseBotTools(modelId, override, route)) return false;
  if (route === "direct" && isClaudeFamily(modelId)) return false;
  return true;
}

/**
 * 要不要把上一轮 thinking 写进 `reasoning_parts`。
 * Claude 直连拒网关自造的 88 字节 signature（Connect `resource_exhausted`）；
 * GPT / grok 同一字段能过。thinking 仍下发给客户端展示，只是回上游时剥掉。
 */
export function shouldReplayReasoningParts(modelId: string, route?: BotInferenceRoute): boolean {
  return !(route === "direct" && isClaudeFamily(modelId));
}

export function buildInferenceStreamRequest(conversation: BotConversation): InferenceStreamRequest {
  const requestedModel = buildRequestedModel(conversation.requestedModel);
  const replayReasoning = shouldReplayReasoningParts(
    conversation.requestedModel.modelId,
    conversation.inferenceRoute
  );
  const request = new InferenceStreamRequest({
    messages: conversation.messages.map((message) =>
      buildCoreMessage(replayReasoning || !message.reasoning?.length ? message : { ...message, reasoning: undefined })
    ),
    requestedModel,
    // model_id 与 requested_model.model_id 是两个字段，客户端两处都填同一个值。
    modelId: requestedModel.modelId,
    conversationId: conversation.conversationId,
    invocationId: conversation.invocationId
  });
  if (conversation.conversationGroupId) request.conversationGroupId = conversation.conversationGroupId;
  const toolNames = uniqueToolNames(conversation.tools);
  if (
    conversation.tools?.length &&
    shouldAdvertiseBotTools(conversation.requestedModel.modelId, conversation.advertiseTools, conversation.inferenceRoute)
  ) {
    request.tools = conversation.tools.map(buildAgentTool);
  } else if (
    toolNames.length &&
    shouldSendUnadvertisedToolNames(
      conversation.requestedModel.modelId,
      conversation.advertiseTools,
      conversation.inferenceRoute
    )
  ) {
    // sendTools 开着、但这条路不能写 tools[]：用协议自带的未声明工具名列表，
    // 否则上游只认训练先验（ReadFile 等），客户端的 Read 会对不上。
    // Claude 直连连这份名单也拒，不发；工具靠本地 XML / 正文还原。
    request.acceptedUnadvertisedToolNames = toolNames;
  }
  const modelConfig = buildModelConfig(conversation.modelConfig);
  if (modelConfig) request.modelConfig = modelConfig;
  return request;
}

export function buildRequestedModel(model: BotRequestedModel): InferenceRequestedModel {
  return new InferenceRequestedModel({
    modelId: model.modelId,
    maxMode: model.maxMode ?? false,
    parameters: (model.parameters ?? []).map(
      (parameter) => new InferenceModelParameterValue({ id: parameter.id, value: parameter.value })
    ),
    builtInModel: model.builtInModel ?? true,
    isVariantStringRepresentation: model.isVariantStringRepresentation ?? false
  });
}

function buildModelConfig(config: BotModelConfig | undefined): InferenceModelConfig | undefined {
  if (!config) return undefined;
  const message = new InferenceModelConfig();
  let set = false;
  if (config.maxTokens !== undefined) {
    message.maxTokens = config.maxTokens;
    set = true;
  }
  if (config.temperature !== undefined) {
    message.temperature = config.temperature;
    set = true;
  }
  if (config.topP !== undefined) {
    message.topP = config.topP;
    set = true;
  }
  if (config.stopSequences?.length) {
    message.stopSequences = [...config.stopSequences];
    set = true;
  }
  return set ? message : undefined;
}

function buildCoreMessage(message: BotMessage): InferenceCoreMessage {
  const core = new InferenceCoreMessage({ role: ROLE_ENUM[message.role] });

  // content 是 oneof：text / parts / tool_content 三者只能设一个。
  if (message.role === "tool") {
    core.content = { case: "toolContent", value: buildToolResultContent(message) };
  } else if (message.images?.length) {
    core.content = { case: "parts", value: buildContentParts(message) };
  } else if (message.text !== undefined) {
    core.content = { case: "text", value: message.text };
  }

  if (message.toolCalls?.length) {
    core.toolCalls = message.toolCalls.map(
      (call) =>
        new InferenceToolCall({
          toolCallId: call.id,
          toolName: call.name,
          // 请求侧的 args 是 google.protobuf.Struct（结构化），
          // 响应侧 tool_call_part.args 却是 string，两处类型不同，不要互相套用。
          args: toStruct(call.arguments)
        })
    );
  }
  if (message.reasoning?.length) {
    core.reasoningParts = message.reasoning.map((part) => {
      const reasoning = new InferenceReasoningPart({ isRedacted: part.isRedacted ?? false, text: part.text });
      if (part.signature) reasoning.signature = part.signature;
      if (part.redactedData) reasoning.redactedData = part.redactedData;
      if (part.modelName) reasoning.modelName = part.modelName;
      return reasoning;
    });
  }
  return core;
}

function buildContentParts(message: BotMessage): InferenceContentParts {
  const parts: InferenceContentPart[] = [];
  if (message.text) {
    parts.push(new InferenceContentPart({ part: { case: "text", value: new InferenceTextPart({ text: message.text }) } }));
  }
  for (const image of message.images ?? []) {
    // descriptor 里 InferenceImagePart 只有 `data` + `mime_type`，没有 url 字段，
    // 也没有任何证据说 `data` 能放 URL。把 URL 塞进 `data` 等于替上游发明语义，
    // 模型收到的会是一串没意义的文本。宁可明确拒绝，也不静默送错或静默丢弃。
    if (image.source === "url") {
      throw new ApiError(
        "Cursor Bot provider cannot send URL images yet; inline the image as base64.",
        400,
        "unsupported_image_source"
      );
    }
    const part = new InferenceImagePart({ data: image.data });
    if (image.mediaType) part.mimeType = image.mediaType;
    parts.push(new InferenceContentPart({ part: { case: "image", value: part } }));
  }
  return new InferenceContentParts({ parts });
}

function buildToolResultContent(message: BotMessage): InferenceToolResultContent {
  const parts = (message.toolResults ?? []).map(
    (result) =>
      new InferenceToolResultPart({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: toValue(result.result),
        isError: result.isError ?? false
      })
  );
  return new InferenceToolResultContent({ parts });
}

function buildAgentTool(tool: GatewayTool): InferenceAgentTool {
  return new InferenceAgentTool({
    name: tool.name,
    description: tool.description ?? "",
    parameters: toStruct(tool.inputSchema)
  });
}

function uniqueToolNames(tools: GatewayTool[] | undefined): string[] {
  const names = (tools ?? []).map((tool) => tool.name?.trim()).filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

/**
 * 任意 JS 值 → `google.protobuf.Struct`。
 * 先过一遍 JSON 序列化：`undefined`、函数、循环引用在 protobuf 侧都会抛，
 * 而一个工具参数里混进 undefined 不该让整个请求失败。
 */
export function toStruct(value: unknown): Struct {
  const json = toJsonValue(value);
  return json !== null && typeof json === "object" && !Array.isArray(json)
    ? Struct.fromJson(json)
    : new Struct();
}

export function toValue(value: unknown): Value {
  return Value.fromJson(toJsonValue(value));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const serialized: unknown = JSON.parse(JSON.stringify(value));
    return (serialized ?? null) as JsonValue;
  } catch {
    return null;
  }
}
