import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import {
  mergeIntents,
  parseModelParamsSpec,
  parseModelSpec,
  reasoningEffortFromThinkingBudget,
  type ModelIntent
} from "./model-params.js";
import { normalizeModel } from "./models.js";
import type { AgentMode, AuthContext, CursorRunRequest, CursorRunResult, GatewayImage, GatewayTool, GatewayToolCall, KeyUsageRef } from "./types.js";

export interface PreparedRequest {
  model: string;
  prompt: string;
  images: GatewayImage[];
  tools: GatewayTool[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  inputItems: unknown[];
  metadata: Record<string, unknown>;
  /** 从请求体 + 模型 id 后缀解析出的模型运行意图（思考强度 / Max Mode / fast / 显式 params / mode）。 */
  intent: ModelIntent;
}

export function prepareOpenAiChat(body: unknown): PreparedRequest {
  const record = objectBody(body);
  const messages = arrayField(record, "messages");
  rejectCommonUnsupported(record);
  const tools = parseOpenAiTools(record.tools, record.tool_choice);
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  transcript.push("", "Conversation:");
  const images: GatewayImage[] = [];
  for (const message of messages) {
    const item = asRecord(message, "messages[]");
    const role = stringField(item, "role", "user");
    const content = contentToTextAndImages(item.content, images);
    if (role === "tool") {
      transcript.push(`TOOL RESULT (${stringField(item, "tool_call_id", "unknown")}): ${content || "[empty]"}`);
    } else {
      transcript.push(`${role.toUpperCase()}: ${content || "[empty]"}`);
    }
    if (Array.isArray(item.tool_calls)) transcript.push(`${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`);
  }
  appendToolReminder(transcript, tools);
  return basePrepared(record, transcript.join("\n"), images, tools, messages);
}

export function prepareOpenAiResponses(body: unknown, previous?: { response?: Record<string, unknown>; inputItems?: unknown[] }): PreparedRequest {
  const record = objectBody(body);
  rejectCommonUnsupported(record);
  const tools = parseOpenAiTools(record.tools, record.tool_choice);
  const images: GatewayImage[] = [];
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  const instructions = typeof record.instructions === "string" ? record.instructions.trim() : "";
  if (instructions) transcript.push("", `INSTRUCTIONS:\n${instructions}`);
  if (previous?.response) {
    transcript.push("", `PREVIOUS_RESPONSE:\n${JSON.stringify(previous.response)}`);
  }
  transcript.push("", "INPUT:");
  const inputItems = normalizedResponseInput(record.input);
  transcript.push(responseInputToTextAndImages(record.input, images));
  appendToolReminder(transcript, tools);
  return basePrepared(record, transcript.join("\n"), images, tools, inputItems);
}

export function prepareAnthropicMessages(body: unknown): PreparedRequest {
  const record = objectBody(body);
  // Anthropic 的 thinking 不再拒绝：映射为 Cursor 的思考强度（reasoning/effort/thinking 参数）透传给 SDK。
  if (record.mcp_servers !== undefined) throw new ApiError("Anthropic server tools are not supported; pass client tools in tools instead.", 400, "unsupported_parameter", "mcp_servers");
  const messages = arrayField(record, "messages");
  const tools = parseAnthropicTools(record.tools, record.tool_choice);
  const images: GatewayImage[] = [];
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  const system = anthropicSystemText(record.system, images);
  if (system) transcript.push("", `SYSTEM:\n${system}`);
  transcript.push("", "Conversation:");
  for (const message of messages) {
    const item = asRecord(message, "messages[]");
    const role = stringField(item, "role", "user");
    transcript.push(`${role.toUpperCase()}: ${anthropicContentToTextAndImages(item.content, images) || "[empty]"}`);
  }
  appendToolReminder(transcript, tools);
  return basePrepared(record, transcript.join("\n"), images, tools, messages);
}

export function toRunRequest(input: {
  prepared: PreparedRequest;
  protocol: CursorRunRequest["protocol"];
  auth: AuthContext;
  sessionKey: string;
  workingDirectory: string;
  keyUsageRef?: KeyUsageRef;
  /** 网关侧默认值 + 请求头推导的意图；优先级低于请求体/模型 id 后缀。 */
  controls?: ModelIntent;
}): CursorRunRequest {
  // 优先级（低→高）：网关默认/请求头(controls) < 请求体/模型 id 后缀(prepared.intent)。
  const intent = mergeIntents(input.controls, input.prepared.intent);
  return {
    protocol: input.protocol,
    apiKey: input.auth.apiKey ?? "",
    useKeyPool: input.auth.mode === "gateway",
    keyUsageRef: input.keyUsageRef,
    model: input.prepared.model,
    prompt: input.prepared.prompt,
    sessionKey: input.sessionKey,
    stream: input.prepared.stream,
    workingDirectory: input.workingDirectory,
    images: input.prepared.images,
    tools: input.prepared.tools,
    temperature: input.prepared.temperature,
    topP: input.prepared.topP,
    maxTokens: input.prepared.maxTokens,
    stop: input.prepared.stop,
    reasoningEffort: intent.reasoningEffort,
    maxMode: intent.maxMode,
    fast: intent.fast,
    modelParams: intent.params,
    mode: intent.mode
  };
}

export function chatCompletionObject(input: { id: string; created: number; prepared: PreparedRequest; output: CursorRunResult }): Record<string, unknown> {
  const toolCalls = input.output.toolCalls.map(openAiToolCall);
  const completionChars = input.output.text.length + JSON.stringify(toolCalls).length;
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.prepared.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !input.output.text ? null : input.output.text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: openAiUsage(input.prepared.prompt.length, completionChars),
    cursor_agent_id: input.output.agentId ?? null,
    cursor_run_id: input.output.runId ?? null
  };
}

export function responseObject(input: { id: string; created: number; prepared: PreparedRequest; output: CursorRunResult; previousResponseId?: string }): Record<string, unknown> {
  const toolItems = input.output.toolCalls.map((toolCall) => responseToolCallItem(toolCall));
  const output: Record<string, unknown>[] = [];
  if (!toolItems.length || input.output.text) {
    output.push({
      id: `msg_${input.id.slice(5)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: input.output.text, annotations: [] }]
    });
  }
  output.push(...toolItems);
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    model: input.prepared.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: input.previousResponseId ?? null,
    store: input.prepared.metadata.store ?? true,
    tool_choice: "auto",
    tools: input.prepared.tools.map(responseToolMetadata),
    usage: responsesUsage(input.prepared.prompt.length, input.output.text.length + JSON.stringify(toolItems).length),
    metadata: input.prepared.metadata,
    cursor_agent_id: input.output.agentId ?? null,
    cursor_run_id: input.output.runId ?? null
  };
}

export function anthropicMessageObject(input: { id: string; prepared: PreparedRequest; output: CursorRunResult }): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.output.text || !input.output.toolCalls.length) content.push({ type: "text", text: input.output.text });
  for (const toolCall of input.output.toolCalls) content.push(anthropicToolUse(toolCall));
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.prepared.model,
    content,
    stop_reason: input.output.toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(input.prepared.prompt.length, input.output.text.length + JSON.stringify(content).length)
  };
}

export function openAiToolCall(toolCall: GatewayToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments)
    }
  };
}

export function responseToolCallItem(toolCall: GatewayToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function_call",
    status: "completed",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.arguments)
  };
}

export function anthropicToolUse(toolCall: GatewayToolCall): Record<string, unknown> {
  return {
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments
  };
}

export function openAiUsage(promptChars: number, completionChars: number): Record<string, unknown> {
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(completionChars);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

export function responsesUsage(promptChars: number, outputChars: number): Record<string, unknown> {
  const inputTokens = estimateTokens(promptChars);
  const outputTokens = estimateTokens(outputChars);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens
  };
}

export function anthropicUsage(inputChars: number, outputChars: number): Record<string, unknown> {
  return {
    input_tokens: estimateTokens(inputChars),
    output_tokens: estimateTokens(outputChars)
  };
}

export function responseListObject(inputItems: unknown[]): Record<string, unknown> {
  return {
    object: "list",
    data: inputItems,
    first_id: itemId(inputItems[0]),
    last_id: itemId(inputItems[inputItems.length - 1]),
    has_more: false
  };
}

export function parseToolMarkers(text: string): CursorRunResult {
  const toolCalls: GatewayToolCall[] = [];
  const cleaned = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (match, raw: string) => {
    const parsed = parseToolCallJson(raw);
    if (!parsed) return match; // 解析失败保留原文，避免工具调用与正文一起被静默吞掉。
    toolCalls.push(parsed);
    return "";
  }).trim();
  return { text: cleaned, toolCalls };
}

/**
 * 解析 <tool_call> 标记内的 JSON。容错处理模型常见的输出偏差：
 * 代码围栏包裹、`arguments` 是字符串化 JSON（OpenAI 原生格式）。解析失败返回 undefined，由调用方保留原文。
 */
export function parseToolCallJson(raw: string): GatewayToolCall | undefined {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const value = JSON.parse(stripped) as unknown;
    const record = asRecord(value, "tool_call");
    const name = stringField(record, "name");
    const args = toolCallArguments(record.arguments ?? record.input);
    if (!args) return undefined;
    const id = typeof record.id === "string" && record.id.trim() ? record.id : `call_${randomUUID().replaceAll("-", "")}`;
    return { id, name, arguments: args };
  } catch {
    return undefined;
  }
}

/** arguments 可能是对象，也可能是字符串化 JSON（模型极常见的输出方式）。 */
function toolCallArguments(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asOptionalRecord(parsed) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return asOptionalRecord(value);
}

function basePrepared(record: Record<string, unknown>, prompt: string, images: GatewayImage[], tools: GatewayTool[], inputItems: unknown[]): PreparedRequest {
  const stop = Array.isArray(record.stop) ? record.stop.filter((item): item is string => typeof item === "string") :
    typeof record.stop === "string" ? [record.stop] :
      Array.isArray(record.stop_sequences) ? record.stop_sequences.filter((item): item is string => typeof item === "string") : undefined;
  const spec = parseModelSpec(record.model);
  // 优先级（低→高）：请求体语义字段 < 模型 id 后缀（更显式的用户选择）。
  const intent = mergeIntents(extractModelControls(record), spec.intent);
  return {
    model: normalizeModel(spec.model || record.model),
    prompt,
    images,
    tools,
    stream: record.stream === true,
    maxTokens: integerOrUndefined(record.max_tokens ?? record.max_output_tokens),
    temperature: numberOrUndefined(record.temperature),
    topP: numberOrUndefined(record.top_p),
    stop,
    inputItems,
    metadata: {
      ...(asOptionalRecord(record.metadata) ?? {}),
      ...(record.store !== undefined ? { store: record.store !== false } : {})
    },
    intent
  };
}

/**
 * 从请求体解析模型运行意图：
 * - reasoning_effort（OpenAI Chat）/ reasoning.effort（OpenAI Responses / Codex）/ thinking（Anthropic Claude Code）→ 思考强度
 * - max_mode / fast / mode 供想显式控制的客户端使用
 * - cursor 扩展对象与 model_params 支持透传任意 Cursor model.params
 */
export function extractModelControls(record: Record<string, unknown>): ModelIntent {
  const cursorExt = asOptionalRecord(record.cursor);
  return mergeIntents(readControlObject(record, false), cursorExt ? readControlObject(cursorExt, true) : undefined);
}

function readControlObject(record: Record<string, unknown>, allowParamsKey: boolean): ModelIntent {
  const intent: ModelIntent = {};
  const effort = reasoningEffortValue(record);
  if (effort !== undefined) intent.reasoningEffort = effort;
  const maxMode = booleanField(record.max_mode ?? record.maxMode);
  if (maxMode !== undefined) intent.maxMode = maxMode;
  const fast = booleanField(record.fast);
  if (fast !== undefined) intent.fast = fast;
  const mode = agentModeField(record.mode);
  if (mode) intent.mode = mode;
  const params = parseModelParamsSpec(record.model_params ?? record.modelParams ?? (allowParamsKey ? record.params : undefined));
  if (params) intent.params = params;
  return intent;
}

function reasoningEffortValue(record: Record<string, unknown>): string | undefined {
  if (typeof record.reasoning_effort === "string" && record.reasoning_effort.trim()) return record.reasoning_effort.trim();
  if (typeof record.reasoning === "string" && record.reasoning.trim()) return record.reasoning.trim();
  const reasoning = asOptionalRecord(record.reasoning);
  if (typeof reasoning?.effort === "string" && reasoning.effort.trim()) return reasoning.effort.trim();
  // 新版 Claude Code 在 adaptive thinking 下用 output_config.effort 表达强度。
  const outputConfig = asOptionalRecord(record.output_config);
  if (typeof outputConfig?.effort === "string" && outputConfig.effort.trim()) return outputConfig.effort.trim();
  const thinking = record.thinking;
  if (typeof thinking === "boolean") return thinking ? "high" : "none";
  if (typeof thinking === "string" && thinking.trim()) return thinking.trim();
  const thinkingRecord = asOptionalRecord(thinking);
  if (thinkingRecord) {
    const type = typeof thinkingRecord.type === "string" ? thinkingRecord.type.toLowerCase() : "";
    if (type === "disabled" || thinkingRecord.enabled === false) return "none";
    const budget = thinkingRecord.budget_tokens ?? thinkingRecord.budgetTokens;
    if (typeof budget === "number") return reasoningEffortFromThinkingBudget(budget);
    if (typeof thinkingRecord.effort === "string" && thinkingRecord.effort.trim()) return thinkingRecord.effort.trim();
    // adaptive：开思考但跟随模型默认强度（Claude 4.6+ 的 adaptive thinking）。
    if (type === "adaptive") return "adaptive";
    if (type === "enabled" || thinkingRecord.enabled === true) return "high";
  }
  return undefined;
}

function booleanField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    return !["0", "false", "no", "off"].includes(trimmed);
  }
  return undefined;
}

function agentModeField(value: unknown): AgentMode | undefined {
  return value === "agent" || value === "plan" ? value : undefined;
}

function objectBody(body: unknown): Record<string, unknown> {
  return asRecord(body, "body");
}

function rejectCommonUnsupported(record: Record<string, unknown>): void {
  if (record.n !== undefined && record.n !== 1) throw new ApiError("n greater than 1 is not supported.", 400, "unsupported_parameter", "n");
  if (record.logprobs !== undefined || record.top_logprobs !== undefined) throw new ApiError("logprobs are not supported.", 400, "unsupported_parameter", "logprobs");
  if (record.audio !== undefined) throw new ApiError("audio output is not supported.", 400, "unsupported_parameter", "audio");
}

/**
 * 网关注入的最小化前导指令：
 * - 无工具：只保留一句防止底层 Cursor agent 擅自动文件/命令的护栏（尽量不夹带其它提示词）。
 * - 有工具：保留客户端工具协议（这是工具调用能正常工作的必要说明，不能省）。
 */
function systemDirective(tools: GatewayTool[]): string {
  if (!tools.length) return "Respond to the conversation below directly. Do not use tools or edit files.";
  return [
    "The caller registered external tools (listed under TOOLS below), executed by the CALLER on their machine, not by you.",
    "Treat every listed tool as available. Use the exact tool name and input schema shown under TOOLS; never claim a listed tool is unavailable and never substitute a builtin tool for it.",
    "When a listed tool is needed, call it through the tool interface. Only if the tool interface is unavailable, reply with ONLY fallback tool call block(s) in exactly this format and no other prose:",
    '<tool_call>{"name":"tool_name","arguments":{"key":"value"}}</tool_call>',
    "The caller executes the tool(s) and returns results in a follow-up request; answer with text only after TOOL RESULT messages arrive."
  ].join("\n");
}

function appendToolInstructions(transcript: string[], tools: GatewayTool[], toolChoice: unknown): void {
  if (!tools.length) return;
  transcript.push("", `TOOL_CHOICE: ${JSON.stringify(toolChoice ?? "auto")}`);
  transcript.push("TOOLS:");
  for (const tool of tools) transcript.push(JSON.stringify(tool));
}

/** 模型对 prompt 末尾内容注意力最高，工具场景在结尾补一次硬性提醒。 */
function appendToolReminder(transcript: string[], tools: GatewayTool[]): void {
  if (!tools.length) return;
  transcript.push(
    "",
    `REMINDER: The client tools [${tools.map((tool) => tool.name).join(", ")}] are provided by the caller and always available. If the latest user request requires one of them and its TOOL RESULT is not in the conversation yet, call the registered client tool by exact name; use <tool_call> fallback only if no tool interface is available.`
  );
}

function parseOpenAiTools(value: unknown, toolChoice: unknown): GatewayTool[] {
  if (toolChoice === "none") return [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asOptionalRecord(item);
    const fn = asOptionalRecord(record?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) return [];
    return [{ name, description: typeof fn?.description === "string" ? fn.description : undefined, inputSchema: fn?.parameters }];
  });
}

function parseAnthropicTools(value: unknown, toolChoice: unknown): GatewayTool[] {
  if (asOptionalRecord(toolChoice)?.type === "none") return [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asOptionalRecord(item);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    return [{ name, description: typeof record?.description === "string" ? record.description : undefined, inputSchema: record?.input_schema }];
  });
}

function contentToTextAndImages(value: unknown, images: GatewayImage[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === null || value === undefined ? "" : JSON.stringify(value);
  const parts: string[] = [];
  for (const part of value) {
    const record = asOptionalRecord(part);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image_url") {
      const imageUrl = asOptionalRecord(record.image_url);
      const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
      if (url) images.push(imageFromUrl(url));
      parts.push(`[image:${url ? "attached" : "missing"}]`);
    } else parts.push(JSON.stringify(record));
  }
  return parts.join("\n");
}

function responseInputToTextAndImages(value: unknown, images: GatewayImage[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  const parts: string[] = [];
  for (const item of value) {
    const record = asOptionalRecord(item);
    if (!record) continue;
    if (record.type === "message") parts.push(`${stringField(record, "role", "user").toUpperCase()}: ${responseContentToText(record.content, images)}`);
    else if (record.type === "input_text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "input_image") {
      const url = typeof record.image_url === "string" ? record.image_url : "";
      const data = typeof record.image_base64 === "string" ? record.image_base64 : "";
      if (url) images.push(imageFromUrl(url));
      if (data) images.push({ type: "image", source: "base64", data, mediaType: typeof record.media_type === "string" ? record.media_type : undefined });
      parts.push("[image:attached]");
    } else if (record.type === "function_call_output" || record.type === "tool_result") {
      parts.push(`TOOL RESULT (${stringField(record, "call_id", "unknown")}): ${JSON.stringify(record.output ?? record.content ?? "")}`);
    } else parts.push(JSON.stringify(record));
  }
  return parts.join("\n");
}

function responseContentToText(value: unknown, images: GatewayImage[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  return value.map((part) => {
    const record = asOptionalRecord(part);
    if (!record) return "";
    if ((record.type === "input_text" || record.type === "output_text") && typeof record.text === "string") return record.text;
    if (record.type === "input_image") {
      const url = typeof record.image_url === "string" ? record.image_url : "";
      if (url) images.push(imageFromUrl(url));
      return "[image:attached]";
    }
    return JSON.stringify(record);
  }).filter(Boolean).join("\n");
}

function normalizedResponseInput(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [{ id: `item_${randomUUID().replaceAll("-", "")}`, type: "message", role: "user", content: value }];
}

function anthropicSystemText(value: unknown, images: GatewayImage[]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return anthropicContentToTextAndImages(value, images);
  return value === undefined ? "" : JSON.stringify(value);
}

function anthropicContentToTextAndImages(value: unknown, images: GatewayImage[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  const parts: string[] = [];
  for (const part of value) {
    const record = asOptionalRecord(part);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image") {
      const source = asOptionalRecord(record.source);
      const type = typeof source?.type === "string" ? source.type : "";
      if (type === "base64" && typeof source?.data === "string") {
        images.push({ type: "image", source: "base64", data: source.data, mediaType: typeof source.media_type === "string" ? source.media_type : undefined });
      } else if (type === "url" && typeof source?.url === "string") {
        images.push(imageFromUrl(source.url));
      }
      parts.push("[image:attached]");
    } else if (record.type === "thinking" || record.type === "redacted_thinking") {
      // 客户端回传的历史思考块（含网关的占位签名）不进入合成 prompt：纯内部推理，原样注入只会污染提示词、浪费 token。
    } else if (record.type === "tool_use") {
      parts.push(`ASSISTANT TOOL_USE: ${JSON.stringify(record)}`);
    } else if (record.type === "tool_result") {
      parts.push(`TOOL RESULT (${stringField(record, "tool_use_id", "unknown")}): ${JSON.stringify(record.content ?? "")}`);
    } else if (record.type === "document") {
      throw new ApiError("Anthropic document/PDF blocks are not supported by this Cursor-backed adapter.", 400, "unsupported_parameter", "content");
    } else {
      parts.push(JSON.stringify(record));
    }
  }
  return parts.join("\n");
}

function imageFromUrl(url: string): GatewayImage {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
    if (match) return { type: "image", source: "base64", mediaType: match[1], data: match[2] };
  }
  return { type: "image", source: "url", data: url };
}

function responseToolMetadata(tool: GatewayTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema ?? { type: "object", properties: {} }
  };
}

function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function itemId(item: unknown): string | null {
  const record = asOptionalRecord(item);
  return typeof record?.id === "string" ? record.id : null;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new ApiError(`${key} must be an array.`, 400, "invalid_request_error", key);
  return value;
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new ApiError(`${key} must be a string.`, 400, "invalid_request_error", key);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ApiError(`${label} must be an object.`, 400, "invalid_request_error", label);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
