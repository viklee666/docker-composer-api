import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import {
  mergeIntents,
  parseModelParamsSpec,
  parseModelSpec,
  reasoningEffortFromThinkingBudget,
  type ModelIntent
} from "./model-params.js";
import { normalizeModel } from "./models.js";
import { resolveSystemText, systemPromptActive } from "./system-prompt.js";
import { filterHostMetaTools, isHostMetaTool } from "./tool-compat.js";
import type { AgentMode, AuthContext, CursorRunRequest, CursorRunResult, GatewayImage, GatewayTool, GatewayToolCall, KeyUsageRef, RequestUsage, SystemPromptSettings } from "./types.js";

export interface PreparedRequest {
  model: string;
  prompt: string;
  images: GatewayImage[];
  tools: GatewayTool[];
  stream: boolean;
  /** 客户端是否用 `stream_options.include_usage` 显式要求流式 usage（未要求时不得发 usage 块）。 */
  includeUsage: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  inputItems: unknown[];
  metadata: Record<string, unknown>;
  /** Responses `store`：false 时本次响应不落库（默认 true）。 */
  store: boolean;
  /** 从请求体 + 模型 id 后缀解析出的模型运行意图（思考强度 / Max Mode / fast / 显式 params / mode）。 */
  intent: ModelIntent;
  /** Responses 快照需要原样回显的请求字段（仅 /v1/responses 填充）。 */
  responsesEcho?: ResponsesEcho;
  /**
   * thinking 块对客户端的可见性（仅 /v1/messages 填充）：
   * - "off"：不输出 thinking 块（未启用思考，或客户端明确关闭）；
   * - "full"：输出完整 thinking 内容；
   * - "omitted"：官方 display:"omitted" 语义——仍输出空 thinking 块（含 signature），但省略思考文本。
   */
  thinkingVisibility?: ThinkingVisibility;
}

export type ThinkingVisibility = "off" | "full" | "omitted";

/** `/v1/responses` 的 Response 对象要求回显请求参数，这里保留解析时会被归一化掉的原始值。 */
export interface ResponsesEcho {
  /** 官方允许 string；个别客户端发数组，回显必须原样（prompt 侧另行提取文本）。 */
  instructions: unknown;
  reasoning: unknown;
  text: unknown;
  truncation: unknown;
  user: unknown;
  parallelToolCalls: boolean;
  toolChoice: unknown;
  tools: unknown[];
  background: boolean;
}

/**
 * prepare* 的网关侧可选输入。缺省即「完全按客户端原文合成 prompt」，
 * 所有既有调用点不传该参数时行为与改造前逐字节一致。
 */
export interface PrepareOptions {
  /**
   * 网关默认系统提示词。SDK 没有 system 入参，只能经合成 prompt 注入（见 system-prompt.ts）。
   * mode 为 off 或正文为空时完全不改变任何东西。
   */
  systemPrompt?: SystemPromptSettings;
}

export interface PrepareAnthropicOptions extends PrepareOptions {
  /** 见 `prepareAnthropicMessages` 的 @param 说明。 */
  countTokens?: boolean;
}

export function prepareOpenAiChat(body: unknown, options?: PrepareOptions): PreparedRequest {
  const record = objectBody(body);
  const messages = arrayField(record, "messages");
  rejectCommonUnsupported(record);
  const tools = parseOpenAiTools(record.tools, record.tool_choice);
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  /*
   * Chat 协议没有独立的 system 段，system/developer 轮次平时是就地折进 Conversation 的。
   * 一旦注入生效就把它们上提成一个 SYSTEM 块，位置与 Anthropic/Responses 一致（工具说明之后、
   * 对话之前）——只有这样网关正文才是模型眼里的系统级指令而不是一轮用户发言，
   * 而且 append 要求「客户端在前、网关在后」、override 要求整段丢掉客户端 system，
   * 就地改写这两点都做不到（多条 system 会重复追加，override 也删不干净）。
   * 未注入时一行都不动，保持既有 prompt 形状。
   */
  const hoistSystem = systemPromptActive(options?.systemPrompt);
  const systemBlockAt = transcript.length;
  const clientSystemParts: string[] = [];
  transcript.push("", "Conversation:");
  const images: GatewayImage[] = [];
  // 先扫完全部 tool_calls / 旧版 function_call，result 出现在 call 前面时也能丢掉元工具输出。
  const metaCallIds = collectHostMetaCallIds(messages);
  for (const message of messages) {
    const item = asRecord(message, "messages[]");
    const role = stringField(item, "role", "user");
    if (role === "tool" || role === "function") {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name && isHostMetaTool(name)) continue;
      const callId = typeof item.tool_call_id === "string" && item.tool_call_id.trim()
        ? item.tool_call_id.trim()
        : name || "unknown";
      if (metaCallIds.has(callId)) continue;
      const content = contentToTextAndImages(item.content, images, false);
      transcript.push(`TOOL RESULT (${callId}): ${content || "[empty]"}`);
      continue;
    }
    const content = contentToTextAndImages(item.content, images, role === "assistant");
    if (hoistSystem && (role === "system" || role === "developer")) {
      // 图片副作用已在上面收完；正文改由 SYSTEM 块统一承载。
      if (content) clientSystemParts.push(content);
      continue;
    }
    const calls = Array.isArray(item.tool_calls) ? item.tool_calls : item.function_call !== undefined && item.function_call !== null ? [item.function_call] : [];
    const kept = calls.filter((call) => {
      const name = chatToolCallName(call);
      return !name || !isHostMetaTool(name);
    });
    // strip 后既无正文也无保留工具则整轮不写，避免发明 [empty] 回灌。
    if (!content && !kept.length) continue;
    if (content) transcript.push(`${role.toUpperCase()}: ${content}`);
    if (kept.length) transcript.push(`${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(kept)}`);
  }
  if (hoistSystem) {
    // 多条 system/developer 之间也按空行分隔，与 append 的拼接口径一致。
    const system = resolveSystemText(clientSystemParts.join("\n\n"), options?.systemPrompt);
    if (system) transcript.splice(systemBlockAt, 0, "", `SYSTEM:\n${system}`);
  }
  appendToolReminder(transcript, tools);
  return basePrepared(record, transcript.join("\n"), images, tools, messages);
}

export function prepareOpenAiResponses(body: unknown, previous?: { response?: Record<string, unknown>; inputItems?: unknown[] }, options?: PrepareOptions): PreparedRequest {
  const record = objectBody(body);
  rejectCommonUnsupported(record);
  const tools = parseResponsesTools(record.tools, record.tool_choice);
  const images: GatewayImage[] = [];
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  const rawInstructions = record.instructions === undefined ? null : record.instructions;
  /*
   * Responses 的客户端 system 有两个入口：顶层 instructions，以及 input[] 里 role=system/developer 的条目。
   * 后者平时就地渲染成 INPUT: 下的一行 SYSTEM:，一旦注入生效就必须和 instructions 一起交给
   * resolveSystemText——否则 override 模式下网关正文进了 INSTRUCTIONS:、客户端 system 还留在 INPUT: 里，
   * 两套系统级指令并存，override 名存实亡。
   * 未注入时一条都不上提，INPUT: 的渲染与改造前逐字节一致。
   * INSTRUCTIONS 块要等 input 渲染完才知道上提了什么，所以先占位、最后 splice 回原位。
   */
  const hoistSystem = systemPromptActive(options?.systemPrompt);
  const instructionsBlockAt = transcript.length;
  if (previous?.response) {
    transcript.push("", `PREVIOUS_RESPONSE:\n${JSON.stringify(sanitizePreviousResponseForPrompt(previous.response))}`);
  }
  transcript.push("", "INPUT:");
  const inputItems = normalizedResponseInput(record.input);
  // previous.output 里的元工具 call_id 要能对上本轮只带 function_call_output 的续请求。
  const priorMetaIds = collectHostMetaCallIds([
    ...(Array.isArray(previous?.response?.output) ? previous.response.output : []),
    ...(previous?.inputItems ?? [])
  ]);
  const hoisted: string[] = [];
  transcript.push(responseInputToTextAndImages(record.input, images, priorMetaIds, hoistSystem ? hoisted : undefined));
  // 顺序即客户端书写顺序：instructions 在前、input[] 里的 system 在后，append 才能保证网关正文收尾。
  const clientSystem = [instructionsText(record.instructions).trim(), ...hoisted].filter(Boolean).join("\n\n");
  // 网关正文注入这里，回显仍用未加工的 rawInstructions。
  const instructions = resolveSystemText(clientSystem, options?.systemPrompt);
  if (instructions) transcript.splice(instructionsBlockAt, 0, "", `INSTRUCTIONS:\n${instructions}`);
  appendToolReminder(transcript, tools);
  const prepared = basePrepared(record, transcript.join("\n"), images, tools, inputItems);
  prepared.responsesEcho = {
    // 回显请求原值（prompt 用的是 trim 后的版本，回显不能替客户端改内容）。
    instructions: rawInstructions,
    reasoning: responsesReasoningEcho(record.reasoning),
    text: asOptionalRecord(record.text) ?? null,
    truncation: record.truncation ?? "disabled",
    user: record.user ?? null,
    parallelToolCalls: record.parallel_tool_calls !== false,
    toolChoice: record.tool_choice ?? "auto",
    tools: responsesToolEcho(record.tools),
    background: record.background === true
  };
  return prepared;
}

/**
 * @param options.countTokens `/v1/messages/count_tokens` 的请求体按官方 schema 就没有 max_tokens 字段，
 *   不该触发缺字段日志——那条日志只记一次，被 count_tokens 抢先触发后，真正遗漏 max_tokens 的
 *   messages 请求就再也不会被记录。
 */
export function prepareAnthropicMessages(body: unknown, options?: PrepareAnthropicOptions): PreparedRequest {
  const record = objectBody(body);
  // Anthropic 的 thinking 不再拒绝：映射为 Cursor 的思考强度（reasoning/effort/thinking 参数）透传给 SDK。
  if (record.mcp_servers !== undefined) throw new ApiError("Anthropic server tools are not supported; pass client tools in tools instead.", 400, "unsupported_parameter", "mcp_servers");
  // 官方 max_tokens 必填，但它在本网关上本来也不生效：宽松客户端只记一次日志，不拒绝请求。
  if (!options?.countTokens && record.max_tokens === undefined) {
    logOnce("anthropic-missing-max-tokens", "[anthropic] request omitted the required max_tokens field; accepted anyway (the parameter has no effect on the Cursor upstream).");
  }
  const messages = arrayField(record, "messages");
  const tools = parseAnthropicTools(record.tools, record.tool_choice);
  const images: GatewayImage[] = [];
  const transcript: string[] = [systemDirective(tools)];
  appendToolInstructions(transcript, tools, record.tool_choice);
  const system = resolveSystemText(anthropicSystemText(record.system, images), options?.systemPrompt);
  if (system) transcript.push("", `SYSTEM:\n${system}`);
  transcript.push("", "Conversation:");
  const metaToolUseIds = collectHostMetaCallIds(messages);
  for (const message of messages) {
    const item = asRecord(message, "messages[]");
    const role = stringField(item, "role", "user");
    const text = anthropicContentToTextAndImages(item.content, images, role === "assistant", metaToolUseIds);
    if (!text) continue;
    transcript.push(`${role.toUpperCase()}: ${text}`);
  }
  appendToolReminder(transcript, tools);
  const prepared = basePrepared(record, transcript.join("\n"), images, tools, messages);
  prepared.thinkingVisibility = resolveThinkingVisibility(record, prepared.intent);
  return prepared;
}

/** 从 instructions（string 或数组）提取用于合成 prompt 的文本；回显始终用原值。 */
function instructionsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    const record = asOptionalRecord(item);
    if (typeof record?.text === "string") return record.text;
    return record ? JSON.stringify(record) : "";
  }).filter(Boolean).join("\n");
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
    // messages 端点在客户端未请求 thinking 时会丢弃 thinking 事件；chat/responses 恒转发（reasoning_content / reasoning item）。
    thinkingVisible: input.protocol === "anthropic-messages" ? (input.prepared.thinkingVisibility ?? "off") !== "off" : true,
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

export function chatCompletionObject(input: { id: string; created: number; prepared: PreparedRequest; output: CursorRunResult; usage?: RequestUsage }): Record<string, unknown> {
  const toolCalls = input.output.toolCalls.map(openAiToolCall);
  const completionChars = chatCompletionChars(input.output);
  const reasoning = input.output.reasoningText ?? "";
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
          // DeepSeek 惯例的非流式推理字段，与流式 delta.reasoning_content 对称；不识别的客户端忽略。
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: openAiUsage(input.prepared.prompt.length, completionChars, input.usage),
    cursor_agent_id: input.output.agentId ?? null,
    cursor_run_id: input.output.runId ?? null
  };
}

/**
 * 官方 Response 对象的统一构造点：流式的 `response.created` / `response.in_progress` / `response.completed`
 * 与非流式响应体共用，避免两处字段漂移。无法从上游取得的行为参数一律回显请求值或 null。
 */
export function responseSnapshot(input: {
  id: string;
  created: number;
  prepared: PreparedRequest;
  status: "in_progress" | "completed";
  output?: Record<string, unknown>[];
  usage?: Record<string, unknown>;
  previousResponseId?: string;
  agentId?: string;
  runId?: string;
}): Record<string, unknown> {
  const echo = input.prepared.responsesEcho;
  const completed = input.status === "completed";
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: input.status,
    completed_at: completed ? Math.floor(Date.now() / 1000) : null,
    error: null,
    incomplete_details: null,
    instructions: echo?.instructions ?? null,
    max_output_tokens: input.prepared.maxTokens ?? null,
    model: input.prepared.model,
    output: input.output ?? [],
    parallel_tool_calls: echo?.parallelToolCalls ?? true,
    previous_response_id: input.previousResponseId ?? null,
    reasoning: echo?.reasoning ?? null,
    background: echo?.background ?? false,
    store: input.prepared.store,
    temperature: input.prepared.temperature ?? null,
    // text 在官方 schema 里是对象（非 nullable），缺省是 {format:{type:"text"}}；发 null 会让严格解码器失败。
    text: echo?.text ?? { format: { type: "text" } },
    tool_choice: echo?.toolChoice ?? "auto",
    tools: echo?.tools ?? [],
    top_p: input.prepared.topP ?? null,
    truncation: echo?.truncation ?? "disabled",
    usage: input.usage ?? null,
    user: echo?.user ?? null,
    metadata: input.prepared.metadata,
    cursor_agent_id: input.agentId ?? null,
    cursor_run_id: input.runId ?? null
  };
}

export function responseObject(input: { id: string; created: number; prepared: PreparedRequest; output: CursorRunResult; previousResponseId?: string; usage?: RequestUsage }): Record<string, unknown> {
  const items = responseOutputItems(input.id, input.output);
  return responseSnapshot({
    id: input.id,
    created: input.created,
    prepared: input.prepared,
    status: "completed",
    output: items,
    usage: responsesUsage(
      input.prepared.prompt.length,
      responseCompletionChars(input.output),
      responseReasoningChars(input.output),
      input.usage
    ),
    previousResponseId: input.previousResponseId,
    agentId: input.output.agentId,
    runId: input.output.runId
  });
}

/** 非流式 Response 的 output[]：reasoning → message → function_call，与流式生成器的产出顺序一致。 */
export function responseOutputItems(id: string, output: CursorRunResult): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const suffix = id.replace(/^resp_/, "");
  const usedCallSuffixes = new Set<string>();
  if (output.reasoningText) items.push(responseReasoningItem(`rs_${suffix}`, output.reasoningText));
  const toolItems = output.toolCalls.map((toolCall) => responseToolCallItem(toolCall, "completed", usedCallSuffixes));
  if (!toolItems.length || output.text) items.push(responseMessageItem(`msg_${suffix}`, output.text));
  items.push(...toolItems);
  return items;
}

export function responseMessageItem(itemId: string, text: string): Record<string, unknown> {
  return { id: itemId, type: "message", status: "completed", role: "assistant", content: [responseTextPart(text)] };
}

/** `output_text` content part：官方 schema 现含 logprobs 字段。 */
export function responseTextPart(text: string): Record<string, unknown> {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}

export function responseReasoningItem(itemId: string, text: string): Record<string, unknown> {
  return { id: itemId, type: "reasoning", summary: [{ type: "summary_text", text }] };
}

export function anthropicMessageObject(input: { id: string; prepared: PreparedRequest; output: CursorRunResult; usage?: RequestUsage }): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const reasoning = input.output.reasoningText ?? "";
  const visibility = input.prepared.thinkingVisibility ?? "off";
  if (reasoning && visibility !== "off") {
    // display:"omitted" 的官方语义：仍返回 thinking 块（含 signature），但省略思考文本。
    content.push({ type: "thinking", thinking: visibility === "omitted" ? "" : reasoning, signature: gatewayThinkingSignature() });
  }
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
    // 与流式同口径：正文 + 可见思考字符 + 客户端 tool_use JSON。旧写法用 JSON.stringify(content)，
    // 而 content 里已经含正文与思考全文，正文被算两遍——同一次对话走两种模式报出的 output_tokens 差近一倍。
    usage: anthropicUsage(
      input.prepared.prompt.length,
      anthropicCompletionChars(input.prepared, input.output),
      input.usage
    )
  };
}

/** 各协议的估算必须按各自真正交给客户端的形状计数，不能拿 SDK 内部的 GatewayToolCall 代替。 */
export function chatCompletionChars(output: CursorRunResult): number {
  return output.text.length +
    (output.reasoningText?.length ?? 0) +
    JSON.stringify(output.toolCalls.map(openAiToolCall)).length;
}

export function responseCompletionChars(output: CursorRunResult): number {
  const usedCallSuffixes = new Set<string>();
  return output.text.length + JSON.stringify(
    output.toolCalls.map((toolCall) => responseToolCallItem(toolCall, "completed", usedCallSuffixes))
  ).length;
}

export function responseReasoningChars(output: CursorRunResult): number {
  return output.reasoningText?.length ?? 0;
}

export function anthropicCompletionChars(prepared: PreparedRequest, output: CursorRunResult): number {
  const visibility = prepared.thinkingVisibility ?? "off";
  const thinkingChars = visibility === "full" ? (output.reasoningText?.length ?? 0) : 0;
  return output.text.length +
    thinkingChars +
    JSON.stringify(output.toolCalls.map(anthropicToolUse)).length;
}

/**
 * 网关自产 thinking 块的不透明签名（Anthropic 协议要求非空 signature；本网关不校验回传签名）。
 * 每块单独生成：固定常量 base64 解开就是明文，且所有响应共用一个值，容易被误当成可校验的凭据。
 */
export function gatewayThinkingSignature(): string {
  return randomBytes(64).toString("base64");
}

/** 关闭思考的强度取值：命中即视为客户端明确不要 thinking 块。 */
const THINKING_DISABLED = new Set(["none", "off", "false", "disabled", "disable", "no", "0"]);

/**
 * thinking 块可见性：只看请求体 / 模型 id 后缀解析出的意图，
 * 网关默认值与请求头不算——未主动要求思考的客户端不该收到 thinking 块。
 */
function resolveThinkingVisibility(record: Record<string, unknown>, intent: ModelIntent): ThinkingVisibility {
  if (thinkingDisabledByRequest(record)) return "off";
  const effort = intent.reasoningEffort;
  const enabled = typeof effort === "string" && effort.trim() !== "" && !THINKING_DISABLED.has(effort.trim().toLowerCase());
  if (!enabled) return "off";
  return thinkingDisplayOmitted(record) ? "omitted" : "full";
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

/** 同一调用对象四个事件各求一次 id，必须稳定：首次解析后按对象缓存。 */
const resolvedCallSuffixes = new WeakMap<GatewayToolCall, string>();

/**
 * function_call item 的两个 id 是不同命名空间：item `id` 用 `fc_` 前缀，`call_id` 用 `call_` 前缀
 * （客户端回传 function_call_output 时引用的是 call_id）。上游 id 已带 `call_` 时不再重复加前缀。
 * 传入 `used`（响应级去重集）可防止不同原始 id（如 "foo" 与 "call_foo"）归一化后撞成同一个 call_id。
 */
export function responseCallIds(toolCall: GatewayToolCall, used?: Set<string>): { itemId: string; callId: string } {
  let suffix = resolvedCallSuffixes.get(toolCall);
  if (suffix === undefined) {
    suffix = toolCall.id.trim().replace(/^call_/, "") || degenerateCallSuffix(toolCall);
    if (used) {
      let candidate = suffix;
      let counter = 2;
      while (used.has(candidate)) candidate = `${suffix}_${counter++}`;
      suffix = candidate;
      used.add(suffix);
    }
    resolvedCallSuffixes.set(toolCall, suffix);
  }
  return { itemId: `fc_${suffix}`, callId: `call_${suffix}` };
}

/** 退化 id（空或只有 `call_` 前缀）的替身后缀。 */
const degenerateCallSuffixes = new WeakMap<GatewayToolCall, string>();

/**
 * 同一个工具调用的 added / arguments.delta / arguments.done / output_item.done 四个事件会各自求一次 id，
 * 所以替身必须按调用对象记忆：直接随机会让四个事件对不上，用固定常量又会让两个退化调用撞成同一个 call_id。
 */
function degenerateCallSuffix(toolCall: GatewayToolCall): string {
  const existing = degenerateCallSuffixes.get(toolCall);
  if (existing) return existing;
  const suffix = randomUUID().replaceAll("-", "");
  degenerateCallSuffixes.set(toolCall, suffix);
  return suffix;
}

export function responseToolCallItem(toolCall: GatewayToolCall, status: "in_progress" | "completed" = "completed", used?: Set<string>): Record<string, unknown> {
  const { itemId, callId } = responseCallIds(toolCall, used);
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: toolCall.name,
    // added 事件按官方形状先给空 arguments，完整参数由 function_call_arguments.delta/done 下发。
    arguments: status === "in_progress" ? "" : JSON.stringify(toolCall.arguments)
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

/**
 * 有真实用量就用真实值，否则退回按字符估算。
 * 估算分支只填 input/output 两桶（缓存与推理无从估算，恒 0/缺省）。
 */
export function normalizeRequestUsage(usage: RequestUsage): RequestUsage {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    ...usage,
    // RequestUsage 的 totalTokens 是四个互斥桶的合计；边界收到旧对象时也要恢复这个不变量。
    totalTokens
  };
}

export function effectiveUsage(real: RequestUsage | undefined, estimatedPromptChars: number, estimatedCompletionChars: number): RequestUsage {
  if (real) {
    const normalized = normalizeRequestUsage(real);
    return real.totalTokens === normalized.totalTokens ? real : normalized;
  }
  const inputTokens = estimateTokens(estimatedPromptChars);
  const outputTokens = estimateTokens(estimatedCompletionChars);
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens };
}

/**
 * OpenAI 口径下 prompt/input 侧是「本轮处理的全部输入 token」，缓存命中只是它的子集
 * （cached_tokens ≤ prompt_tokens）；而上游 RequestUsage 沿用 SDK 的四桶互斥口径
 * （totalTokens = input + output + cacheRead + cacheWrite），所以要把两个缓存桶并回输入侧。
 */
function openAiInputTokens(usage: RequestUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** reasoning 按契约是 output 的子集；万一上游报反了也不能让 detail 大于总量（严格客户端会判为非法）。 */
function reasoningSubset(usage: RequestUsage): number {
  return Math.min(Math.max(usage.reasoningTokens ?? 0, 0), usage.outputTokens);
}

/**
 * total_tokens 一律按 prompt + completion 自算，不直接抄 RequestUsage.totalTokens：
 * 后者不含 reasoning 而 completion_tokens 含（reasoning 是 output 的子集），直接抄会让三个数对不上。
 * 在 SDK 的四桶口径下两者本来就相等，这里只是让关系在任何输入下都自洽。
 * detail 字段只在拿到真实用量时出现：估算不出缓存/推理，凭空发 0 会误导客户端。
 */
export function openAiUsage(promptChars: number, completionChars: number, real?: RequestUsage): Record<string, unknown> {
  const usage = effectiveUsage(real, promptChars, completionChars);
  const promptTokens = openAiInputTokens(usage);
  const completionTokens = usage.outputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(real
      ? {
        prompt_tokens_details: { cached_tokens: real.cacheReadTokens },
        completion_tokens_details: { reasoning_tokens: reasoningSubset(real) }
      }
      : {})
  };
}

/**
 * 官方语义里 output_tokens 含 reasoning_tokens，这里同样把思考计入输出侧，避免 detail 大于总量：
 * 估算分支把思考字符加进 output，真实分支直接用 outputTokens（reasoning 本就是它的子集）。
 * input/total 口径同 `openAiUsage`：缓存读写并入 input_tokens，cached_tokens 是其子集。
 */
export function responsesUsage(promptChars: number, outputChars: number, reasoningChars = 0, real?: RequestUsage): Record<string, unknown> {
  const estimatedReasoning = estimateTokens(reasoningChars);
  const usage = effectiveUsage(real, promptChars, outputChars);
  const inputTokens = openAiInputTokens(usage);
  const reasoningTokens = real ? reasoningSubset(real) : estimatedReasoning;
  const outputTokens = real ? usage.outputTokens : usage.outputTokens + estimatedReasoning;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens
  };
}

/**
 * Anthropic 口径与 SDK 的四桶一一对应：input_tokens 只是「未命中缓存的输入」，
 * 缓存读取/写入是**另外两个并列的桶**，不含在 input_tokens 里（这点与 OpenAI 相反，不能共用一套映射）。
 * 常见客户端（含 Claude Code）会直接读这两个字段做统计；上游没报用量时按估算走，三桶恒 0。
 */
export function anthropicUsage(inputChars: number, outputChars: number, real?: RequestUsage): Record<string, unknown> {
  const usage = effectiveUsage(real, inputChars, outputChars);
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    output_tokens: usage.outputTokens
  };
}

/**
 * `/v1/messages/count_tokens` 的响应体。与 `anthropicUsage` 的 input_tokens 同口径：
 * 客户端拿它做预算判断时，不会和随后真实请求报出的用量对不上。
 */
export function anthropicTokenCount(prepared: PreparedRequest): Record<string, unknown> {
  return { input_tokens: estimateTokens(prepared.prompt.length) };
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
    includeUsage: asOptionalRecord(record.stream_options)?.include_usage === true,
    maxTokens: firstInteger(record.max_tokens, record.max_completion_tokens, record.max_output_tokens),
    temperature: numberOrUndefined(record.temperature),
    topP: numberOrUndefined(record.top_p),
    stop,
    inputItems,
    // 顶层 store 是数据保留契约，不再混进 metadata（客户端自己的 metadata.store 键原样保留）。
    metadata: asOptionalRecord(record.metadata) ?? {},
    store: record.store !== false,
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

/** 客户端明确关闭思考（`thinking:false` / `{type:"disabled"}` / `enabled:false`）→ 完全不输出 thinking 块。 */
function thinkingDisabledByRequest(record: Record<string, unknown>): boolean {
  const thinking = record.thinking;
  if (thinking === false) return true;
  const thinkingRecord = asOptionalRecord(thinking);
  if (!thinkingRecord) return false;
  const type = typeof thinkingRecord.type === "string" ? thinkingRecord.type.trim().toLowerCase() : "";
  return type === "disabled" || type === "disable" || type === "none" || type === "off" || thinkingRecord.enabled === false;
}

/**
 * `thinking.display:"omitted"`：仍然思考，但省略思考文本。
 * 官方语义是发**空 thinking 块**（含 signature），不是删除整个块。不改变发给上游的思考强度。
 */
function thinkingDisplayOmitted(record: Record<string, unknown>): boolean {
  const thinkingRecord = asOptionalRecord(record.thinking);
  return typeof thinkingRecord?.display === "string" && thinkingRecord.display.trim().toLowerCase() === "omitted";
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
  // logprobs:false / top_logprobs 只是"不要 logprobs"或 Responses 的合法参数，不该 400；只有显式要 logprobs 才拒绝。
  if (record.logprobs === true) throw new ApiError("logprobs are not supported.", 400, "unsupported_parameter", "logprobs");
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
  return filterHostMetaTools(value.flatMap((item) => {
    const record = asOptionalRecord(item);
    const fn = asOptionalRecord(record?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) return [];
    return [{ name, description: typeof fn?.description === "string" ? fn.description : undefined, inputSchema: fn?.parameters }];
  }));
}

/**
 * Responses 的工具定义是扁平的（`{type:"function", name, description, parameters, strict}`），
 * 不是 Chat 的嵌套 `{type:"function", function:{...}}`。嵌套写法作为宽容兜底接受（记一次日志），
 * 内置工具（web_search 等）与未知类型不静默丢弃，同样记日志。
 */
function parseResponsesTools(value: unknown, toolChoice: unknown): GatewayTool[] {
  if (toolChoice === "none") return [];
  if (!Array.isArray(value)) return [];
  return filterHostMetaTools(value.flatMap((item) => {
    const record = asOptionalRecord(item);
    if (!record) return [];
    // 先按 type 分流：内置工具（web_search 等）即使带 function 字段也不能当成客户端函数工具。
    if (record.type !== undefined && record.type !== "function") {
      logOnce("responses-unsupported-tool", `[responses] tool type ${describeValue(record.type)} is not supported by this Cursor-backed gateway and was ignored.`);
      return [];
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name) {
      return [{ name, description: typeof record.description === "string" ? record.description : undefined, inputSchema: record.parameters }];
    }
    const nested = asOptionalRecord(record.function);
    const nestedName = typeof nested?.name === "string" ? nested.name.trim() : "";
    if (nestedName) {
      logOnce("responses-nested-tool", `[responses] tool "${nestedName}" uses the Chat nested {function:{...}} shape; the Responses API expects the flat shape. Accepted for compatibility.`);
      return [{ name: nestedName, description: typeof nested?.description === "string" ? nested.description : undefined, inputSchema: nested?.parameters }];
    }
    logOnce("responses-unnamed-tool", "[responses] a function tool without a usable name was ignored.");
    return [];
  }));
}

/**
 * 回显给客户端的 tools 必须是官方扁平形状：兼容接受的嵌套写法要先摊平，
 * 否则 Response 快照本身就违反 schema，严格 SDK 解码会失败。
 */
function responsesToolEcho(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asOptionalRecord(item);
    const nested = asOptionalRecord(record?.function);
    if (!record || record.type !== "function" || typeof record.name === "string" || !nested) return item;
    // 摊平时保留 function 对象里的全部字段（含 strict 等），只是提到顶层。
    const { function: _nested, ...rest } = record;
    return { ...rest, ...nested, type: "function" };
  });
}

/** `reasoning` 在官方 schema 里是对象；本网关额外容忍字符串写法，回显时要归一化。 */
function responsesReasoningEcho(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) return { effort: value.trim() };
  return asOptionalRecord(value) ?? null;
}

const loggedNotices = new Set<string>();

/**
 * 安全渲染请求里的任意值用于日志：`String(value)` 对 `{"toString":null,"valueOf":null}` 这类
 * 构造出来的对象会抛 TypeError，把一次日志变成 500。同时截断，避免超长值撑爆日志。
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `"${value.slice(0, 60)}"`;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return `<${Array.isArray(value) ? "array" : typeof value}>`;
}

/**
 * 同一类协议偏差只记一次，避免高频请求刷屏。
 * key 必须是固定分类（不能拼入请求侧可控的工具名等），否则集合会被构造请求撑大且退化成每次都打。
 */
function logOnce(key: string, message: string): void {
  if (loggedNotices.has(key)) return;
  loggedNotices.add(key);
  console.warn(message);
}

function parseAnthropicTools(value: unknown, toolChoice: unknown): GatewayTool[] {
  if (asOptionalRecord(toolChoice)?.type === "none") return [];
  if (!Array.isArray(value)) return [];
  return filterHostMetaTools(value.flatMap((item) => {
    const record = asOptionalRecord(item);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    return [{ name, description: typeof record?.description === "string" ? record.description : undefined, inputSchema: record?.input_schema }];
  }));
}

/** 历史短仪式句（拉齐 schema / GetMcpTools 等）不进合成 prompt；只判整段且 ≤200 字，避免误删讨论 schema 的长回复。 */
const RITUAL_ASSISTANT_RE = /拉齐\s*schema|对齐\s*schema|schema\s*拉齐|schema\s*对齐|align\s+schema|对齐工具|拉齐工具|align\s+tools|align\s+the\s+tool|搜到工具了|found\s+the\s+tool|\bGetMcpTools\b|\bCallMcpTool\b/i;

export function isRitualAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200) return false;
  return RITUAL_ASSISTANT_RE.test(trimmed);
}

export function stripRitualAssistantText(text: string): string {
  return isRitualAssistantText(text) ? "" : text;
}

function chatToolCallName(value: unknown): string {
  const record = asOptionalRecord(value);
  const fn = asOptionalRecord(record?.function);
  if (typeof fn?.name === "string" && fn.name.trim()) return fn.name.trim();
  return typeof record?.name === "string" ? record.name.trim() : "";
}

function chatToolCallId(value: unknown): string {
  const record = asOptionalRecord(value);
  return typeof record?.id === "string" ? record.id.trim() : "";
}

/** 从 function_call / tool_use 收集宿主元工具 call_id，让另包或后到的 function_call_output 也能丢掉。 */
export function collectHostMetaCallIds(items: unknown[]): Set<string> {
  const ids = new Set<string>();
  walkHostMetaCallIds(items, ids);
  return ids;
}

function walkHostMetaCallIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walkHostMetaCallIds(item, ids);
    return;
  }
  const record = asOptionalRecord(value);
  if (!record) return;
  if (record.type === "function_call" || record.type === "tool_use") {
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name && isHostMetaTool(name)) {
      if (typeof record.call_id === "string" && record.call_id.trim()) ids.add(record.call_id.trim());
      if (typeof record.id === "string" && record.id.trim()) ids.add(record.id.trim());
    }
  }
  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      const name = chatToolCallName(call);
      const id = chatToolCallId(call);
      if (name && isHostMetaTool(name) && id) ids.add(id);
    }
  }
  const fc = asOptionalRecord(record.function_call);
  if (fc) {
    const name = typeof fc.name === "string" ? fc.name.trim() : "";
    if (name && isHostMetaTool(name) && typeof fc.id === "string" && fc.id.trim()) ids.add(fc.id.trim());
  }
  if (record.role === "function") {
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name && isHostMetaTool(name)) {
      ids.add(name);
      if (typeof record.tool_call_id === "string" && record.tool_call_id.trim()) ids.add(record.tool_call_id.trim());
    }
  }
  if (Array.isArray(record.content)) walkHostMetaCallIds(record.content, ids);
}

/** 只清洗写入合成 prompt 的副本，不改客户端取回的已存 Response。 */
function sanitizePreviousResponseForPrompt(response: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  /*
   * instructions 按官方语义是逐轮参数，不随 previous_response_id 继承。
   * 快照原样入 prompt 会把上一轮的客户端 system 再灌一遍，和本轮 INSTRUCTIONS: 块里的
   * 系统级指令并存甚至打架——本轮该守什么规矩，只由本轮请求决定。
   */
  delete copy.instructions;
  if (Array.isArray(copy.tools)) {
    copy.tools = copy.tools.filter((item) => {
      const record = asOptionalRecord(item);
      const nested = asOptionalRecord(record?.function);
      const name = typeof record?.name === "string" ? record.name : typeof nested?.name === "string" ? nested.name : "";
      return !name || !isHostMetaTool(name);
    });
  }
  if (!Array.isArray(copy.output)) return copy;
  const metaCallIds = collectHostMetaCallIds(copy.output);
  copy.output = copy.output.flatMap((item) => {
    const record = asOptionalRecord(item);
    if (!record) return [];
    if (record.type === "reasoning") return [];
    if (record.type === "function_call" && typeof record.name === "string" && isHostMetaTool(record.name)) return [];
    if ((record.type === "function_call_output" || record.type === "tool_result") && typeof record.call_id === "string" && metaCallIds.has(record.call_id.trim())) return [];
    if (record.type === "message" && typeof record.content === "string") {
      const text = stripRitualAssistantText(record.content);
      if (!text) return [];
      record.content = text;
      return [record];
    }
    if (record.type === "message" && Array.isArray(record.content)) {
      record.content = record.content.flatMap((part) => {
        const block = asOptionalRecord(part);
        if (!block) return [];
        if ((block.type === "output_text" || block.type === "input_text" || block.type === "text") && typeof block.text === "string") {
          const text = stripRitualAssistantText(block.text);
          if (!text) return [];
          return [{ ...block, text }];
        }
        return [block];
      });
      const hasText = (record.content as unknown[]).some((part) => {
        const block = asOptionalRecord(part);
        return Boolean(block && typeof block.text === "string" && block.text);
      });
      if (!hasText) return [];
    }
    return [record];
  });
  return copy;
}

function contentToTextAndImages(value: unknown, images: GatewayImage[], stripRitual = false): string {
  if (typeof value === "string") return stripRitual ? stripRitualAssistantText(value) : value;
  if (!Array.isArray(value)) return value === null || value === undefined ? "" : JSON.stringify(value);
  const parts: string[] = [];
  for (const part of value) {
    const record = asOptionalRecord(part);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      const text = stripRitual ? stripRitualAssistantText(record.text) : record.text;
      if (text) parts.push(text);
    } else if (record.type === "image_url") {
      const imageUrl = asOptionalRecord(record.image_url);
      const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
      if (url) images.push(imageFromUrl(url));
      parts.push(`[image:${url ? "attached" : "missing"}]`);
    } else if (record.type === "reasoning" || record.type === "thinking" || record.type === "redacted_thinking") {
      continue;
    } else parts.push(JSON.stringify(record));
  }
  return parts.join("\n");
}

/**
 * @param hoistedSystem 传数组即表示「system/developer 条目改由 INSTRUCTIONS 块承载」：
 *   正文收进该数组、不写进 INPUT:，图片副作用照常收集。不传则一切就地渲染（未注入时的原行为）。
 */
function responseInputToTextAndImages(value: unknown, images: GatewayImage[], priorMetaIds?: ReadonlySet<string>, hoistedSystem?: string[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  const metaCallIds = new Set(priorMetaIds);
  for (const id of collectHostMetaCallIds(value)) metaCallIds.add(id);
  const parts: string[] = [];
  for (const item of value) {
    const record = asOptionalRecord(item);
    if (!record) continue;
    if (record.type === "reasoning") continue;
    // type 省略的 EasyInputMessage 也要认：漏掉的话它会以 JSON 块的形式把客户端 system 留在 INPUT: 里。
    if (hoistedSystem && (record.type === "message" || record.type === undefined) && isSystemRole(record.role)) {
      const text = responseContentToText(record.content, images);
      if (text) hoistedSystem.push(text);
      continue;
    }
    if (record.type === "message") {
      const role = stringField(record, "role", "user");
      const text = responseContentToText(record.content, images, role === "assistant");
      if (!text) continue;
      parts.push(`${role.toUpperCase()}: ${text}`);
    } else if (record.type === "input_text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "input_image") {
      const url = typeof record.image_url === "string" ? record.image_url : "";
      const data = typeof record.image_base64 === "string" ? record.image_base64 : "";
      if (url) images.push(imageFromUrl(url));
      if (data) images.push({ type: "image", source: "base64", data, mediaType: typeof record.media_type === "string" ? record.media_type : undefined });
      parts.push("[image:attached]");
    } else if (record.type === "function_call") {
      const name = typeof record.name === "string" ? record.name : "";
      if (name && isHostMetaTool(name)) continue;
      parts.push(JSON.stringify(record));
    } else if (record.type === "function_call_output" || record.type === "tool_result") {
      const callId = stringField(record, "call_id", "unknown");
      if (metaCallIds.has(callId)) continue;
      // output 已是字符串时直接用：再 JSON.stringify 一次会把工具结果变成带转义的引号串。
      const raw = record.output ?? record.content ?? "";
      parts.push(`TOOL RESULT (${callId}): ${typeof raw === "string" ? raw : JSON.stringify(raw)}`);
    } else parts.push(JSON.stringify(record));
  }
  return parts.join("\n");
}

function isSystemRole(role: unknown): boolean {
  return role === "system" || role === "developer";
}

function responseContentToText(value: unknown, images: GatewayImage[], stripRitual = false): string {
  if (typeof value === "string") return stripRitual ? stripRitualAssistantText(value) : value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  return value.map((part) => {
    const record = asOptionalRecord(part);
    if (!record) return "";
    if ((record.type === "input_text" || record.type === "output_text" || record.type === "text") && typeof record.text === "string") {
      return stripRitual ? stripRitualAssistantText(record.text) : record.text;
    }
    if (record.type === "input_image") {
      const url = typeof record.image_url === "string" ? record.image_url : "";
      if (url) images.push(imageFromUrl(url));
      return "[image:attached]";
    }
    if (record.type === "reasoning" || record.type === "thinking" || record.type === "redacted_thinking") return "";
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

function anthropicContentToTextAndImages(value: unknown, images: GatewayImage[], stripRitual = false, metaToolUseIds?: Set<string>): string {
  if (typeof value === "string") return stripRitual ? stripRitualAssistantText(value) : value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  const parts: string[] = [];
  for (const part of value) {
    const record = asOptionalRecord(part);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      if (stripRitual) {
        const text = stripRitualAssistantText(record.text);
        if (text) parts.push(text);
      } else {
        parts.push(record.text);
      }
    } else if (record.type === "image") {
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
      const name = typeof record.name === "string" ? record.name : "";
      const id = typeof record.id === "string" ? record.id : "";
      if (name && isHostMetaTool(name)) {
        if (id && metaToolUseIds) metaToolUseIds.add(id);
        continue;
      }
      parts.push(`ASSISTANT TOOL_USE: ${JSON.stringify(record)}`);
    } else if (record.type === "tool_result") {
      const toolUseId = stringField(record, "tool_use_id", "unknown");
      if (metaToolUseIds?.has(toolUseId)) continue;
      parts.push(`TOOL RESULT (${toolUseId}): ${JSON.stringify(record.content ?? "")}`);
    } else if (record.type === "document") {
      throw new ApiError(
        "Gateway limitation: document/PDF content blocks are not supported by this Cursor-backed gateway (the Cursor upstream accepts text and images only). Extract the text client-side and send it as a text block.",
        400,
        "unsupported_parameter",
        "content"
      );
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

/** max_tokens / max_completion_tokens / max_output_tokens 同义：取第一个**有效**值，非法值不遮蔽后面的合法别名。 */
function firstInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = integerOrUndefined(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ApiError(`${label} must be an object.`, 400, "invalid_request_error", label);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
