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

export type ConnectRole = "system" | "user" | "assistant" | "tool";

const ROLE_ENUM: Record<ConnectRole, InferenceMessageRole> = {
  system: InferenceMessageRole.SYSTEM,
  user: InferenceMessageRole.USER,
  assistant: InferenceMessageRole.ASSISTANT,
  tool: InferenceMessageRole.TOOL
};

/** 上一轮的思考片段。`signature` 存在时必须原样带回，否则 extended thinking 的连续性会断。 */
export interface ConnectReasoningPart {
  text: string;
  signature?: string;
  isRedacted?: boolean;
  redactedData?: string;
  modelName?: string;
}

export interface ConnectToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

export interface ConnectMessage {
  role: ConnectRole;
  text?: string;
  images?: GatewayImage[];
  /** assistant 轮次里模型发起的工具调用；与 content 不是 oneof，可以和文本共存。 */
  toolCalls?: GatewayToolCall[];
  reasoning?: ConnectReasoningPart[];
  /** 仅 role=tool 有意义。 */
  toolResults?: ConnectToolResult[];
}

export interface ConnectRequestedModel {
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

export interface ConnectModelConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ConnectConversation {
  messages: ConnectMessage[];
  tools?: GatewayTool[];
  /** 同一段对话内保持稳定。 */
  conversationId: string;
  conversationGroupId?: string;
  /** 每次请求新生成。 */
  invocationId: string;
  requestedModel: ConnectRequestedModel;
  modelConfig?: ConnectModelConfig;
}

export function buildInferenceStreamRequest(conversation: ConnectConversation): InferenceStreamRequest {
  const requestedModel = buildRequestedModel(conversation.requestedModel);
  const request = new InferenceStreamRequest({
    messages: conversation.messages.map(buildCoreMessage),
    requestedModel,
    // model_id 与 requested_model.model_id 是两个字段，客户端两处都填同一个值。
    modelId: requestedModel.modelId,
    conversationId: conversation.conversationId,
    invocationId: conversation.invocationId
  });
  if (conversation.conversationGroupId) request.conversationGroupId = conversation.conversationGroupId;
  if (conversation.tools?.length) request.tools = conversation.tools.map(buildAgentTool);
  const modelConfig = buildModelConfig(conversation.modelConfig);
  if (modelConfig) request.modelConfig = modelConfig;
  return request;
}

export function buildRequestedModel(model: ConnectRequestedModel): InferenceRequestedModel {
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

function buildModelConfig(config: ConnectModelConfig | undefined): InferenceModelConfig | undefined {
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

function buildCoreMessage(message: ConnectMessage): InferenceCoreMessage {
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

function buildContentParts(message: ConnectMessage): InferenceContentParts {
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
        "Cursor Connect provider cannot send URL images yet; inline the image as base64.",
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

function buildToolResultContent(message: ConnectMessage): InferenceToolResultContent {
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
