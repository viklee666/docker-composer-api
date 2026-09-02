import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { GatewayImage, GatewayTool, GatewayToolCall } from "../types.js";
import type { ConnectMessage, ConnectReasoningPart, ConnectToolResult } from "./request-builder.js";

/**
 * Connect 路线的结构化上下文（计划 §G5）。
 *
 * 与 `CursorRunRequest.prompt` 并存而不替换：SDK 路线只能收一串合成文本，
 * 而 `InferenceCoreMessage` 是结构化的——有 `role`（含 `SYSTEM=4`）、`tool_calls`、
 * `reasoning_parts`、`tool_content`。压成一个字符串会把这些全丢掉，
 * 而且 system 内容一变就污染整个 prompt 前缀、连带废掉上游的 prompt 缓存。
 */
export interface PreparedConversation {
  /** 结构化消息，直接对应 InferenceCoreMessage[]。不含 system。 */
  messages: ConnectMessage[];
  /** system / developer 指令单独保留，构造请求时映射到 role=SYSTEM(4)。 */
  systemInstructions: string[];
  tools: GatewayTool[];
  /** 同一段对话内保持稳定。 */
  conversationId: string;
  conversationGroupId?: string;
  /** 每次请求新生成。 */
  invocationId: string;
  /**
   * 上一轮 thinking 的 signature **不在这里**——它们直接挂在
   * `ConnectMessage.reasoning[].signature` 上，由 request-builder 原样写进
   * `InferenceReasoningPart.signature`。
   *
   * 这里曾经有一张按消息下标索引的 `reasoningSignatures` 表。它是错的：下标既会被
   * `conversationMessages()` 前置的 system 消息顶掉，也会被 `contextFromSummary()`
   * 的裁剪打乱，而且它记的东西结构上已经存在。一个指向私有可变数组的位置下标不是稳定身份。
   */
  /** summary checkpoint 引用（G8）。 */
  summaryId?: string;
  /** 父子关系（G7）。协议层没有这两个字段，纯网关侧记账。 */
  parentRunId?: string;
  parentToolCallId?: string;
}

export type InboundProtocol = "openai-chat" | "openai-responses" | "anthropic";

export interface ConversationOptions {
  conversationId?: string;
  conversationGroupId?: string;
  invocationId?: string;
  /** 网关默认 system 提示词，追加在客户端 system 之后。 */
  gatewaySystemText?: string;
  /** override 模式：忽略客户端 system，只发网关的。 */
  gatewaySystemMode?: "off" | "append" | "override";
  tools?: GatewayTool[];
}

/**
 * 入站请求体 → 结构化对话。
 *
 * 刻意不改 `protocol.ts`：那 1200 行合成 prompt 的逻辑服务着 SDK 路线和三套对外协议，
 * 已有 590 条测试压在上面。这里只读原始 body 走一条独立的结构化解析，
 * 两条路径互不影响，Connect 路线出问题也不会波及 SDK 路线。
 */
export function toPreparedConversation(
  body: unknown,
  protocol: InboundProtocol,
  options: ConversationOptions = {}
): PreparedConversation {
  const record = asRecord(body);
  const parsed =
    protocol === "anthropic" ? parseAnthropic(record) : protocol === "openai-responses" ? parseResponses(record) : parseChat(record);

  const systemInstructions = resolveSystem(parsed.system, options);
  return {
    messages: parsed.messages,
    systemInstructions,
    tools: options.tools ?? [],
    conversationId: options.conversationId ?? randomUUID(),
    ...(options.conversationGroupId ? { conversationGroupId: options.conversationGroupId } : {}),
    invocationId: options.invocationId ?? randomUUID(),
  };
}

/** 把结构化对话摊平成 request-builder 要的消息序列（system 在最前）。 */
export function conversationMessages(conversation: PreparedConversation): ConnectMessage[] {
  const system = conversation.systemInstructions
    .filter((text) => text.trim())
    .map((text): ConnectMessage => ({ role: "system", text }));
  return [...system, ...conversation.messages];
}

/**
 * `system-prompt.ts` 的 off/append/override 三态，但结果是**独立的 SYSTEM 消息**而不是拼进文本。
 * override 时客户端 system 被整体丢弃——这与既有语义一致。
 */
function resolveSystem(clientSystem: string[], options: ConversationOptions): string[] {
  const gateway = options.gatewaySystemText?.trim();
  const mode = options.gatewaySystemMode ?? "off";
  if (mode === "override" && gateway) return [gateway];
  if (mode === "append" && gateway) return [...clientSystem, gateway];
  return clientSystem;
}

interface ParsedInbound {
  system: string[];
  messages: ConnectMessage[];
}

/* ------------------------------------------------------------- OpenAI Chat */

function parseChat(record: Record<string, unknown>): ParsedInbound {
  const result: ParsedInbound = { system: [], messages: [] };
  for (const raw of asArray(record.messages)) {
    const message = asRecord(raw);
    // 缺 role / role 不认识时按 user，与 protocol.ts 一致；丢掉整条消息是最坏的处理。
    const role = stringOr(message.role, "user");

    if (role === "system" || role === "developer") {
      const text = contentText(message.content);
      if (text) result.system.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      // OpenAI 的 tool 消息一条只带一个 tool_call_id。合并成一条 TOOL 消息由调用方决定，
      // 这里保持一条一条——InferenceToolResultContent.parts 是 repeated，两种都合法。
      // 旧式 `role:"function"` 只带 name 不带 id，用 name 兜底（同 protocol.ts）。
      const toolCallId = stringOr(message.tool_call_id, "") || stringOr(message.name, "");
      if (!toolCallId) continue;
      result.messages.push({
        role: "tool",
        toolResults: [
          {
            toolCallId,
            toolName: stringOr(message.name, ""),
            result: parseMaybeJson(contentText(message.content))
          }
        ]
      });
      continue;
    }

    if (role === "assistant") {
      const assistant: ConnectMessage = { role: "assistant" };
      const text = contentText(message.content);
      if (text) assistant.text = text;
      // 旧式单个 function_call 与新式 tool_calls 都要认，否则旧客户端的整轮工具调用会消失。
      const toolCalls = parseChatToolCalls(
        Array.isArray(message.tool_calls) ? message.tool_calls : message.function_call ? [{ function: message.function_call }] : []
      );
      if (toolCalls.length) assistant.toolCalls = toolCalls;
      const reasoning = parseReasoning(message);
      if (reasoning.length) assistant.reasoning = reasoning;
      if (assistant.text || assistant.toolCalls || assistant.reasoning) result.messages.push(assistant);
      continue;
    }

    pushUser(result.messages, message.content);
  }
  return result;
}

function parseChatToolCalls(raw: unknown): GatewayToolCall[] {
  const calls: GatewayToolCall[] = [];
  for (const [index, item] of asArray(raw).entries()) {
    const call = asRecord(item);
    const fn = asRecord(call.function);
    const name = stringOr(fn.name, "");
    if (!name) continue;
    // 旧式 function_call 没有 id；用 name 兜底，与 protocol.ts 的口径一致。
    const id = stringOr(call.id, "") || `${name}_${index}`;
    calls.push({ id, name, arguments: toolArguments(fn.arguments) });
  }
  return calls;
}

/**
 * `arguments` 在实践中有三种形态：JSON 串、已经是对象、以及坏掉的 JSON 串。
 * 一律 `asRecord(parseMaybeJson(...))` 会把后两种都抹成 `{}`，参数就凭空丢了。
 */
function toolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const parsed = parseMaybeJson(stringOr(raw, ""));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  // 解析不出对象时保留原文，总比交一个空对象强。
  const text = stringOr(raw, "");
  return text ? { __raw: text } : {};
}

/** 只有真有内容才推：空 user 消息在 wire 上是一条 role=USER 但 content oneof 未设的消息。 */
function pushUser(messages: ConnectMessage[], content: unknown): void {
  const message = userMessage(content);
  if (message.text || message.images?.length) messages.push(message);
}

/* -------------------------------------------------------- OpenAI Responses */

function parseResponses(record: Record<string, unknown>): ParsedInbound {
  const result: ParsedInbound = { system: [], messages: [] };
  const instructions = contentText(record.instructions);
  if (instructions) result.system.push(instructions);

  const input = record.input;
  if (typeof input === "string") {
    if (input) result.messages.push({ role: "user", text: input });
    return result;
  }

  for (const raw of asArray(input)) {
    if (typeof raw === "string") {
      if (raw) result.messages.push({ role: "user", text: raw });
      continue;
    }
    const item = asRecord(raw);
    const type = stringOr(item.type, "message");

    // reasoning / item_reference 等非消息项没有可发送的内容。
    // 不跳过的话它们会掉进下面的 user 分支，变成一条 role=USER 但 content 未设的空消息。
    if (type === "reasoning" || type === "item_reference") continue;

    if (type === "function_call") {
      const id = stringOr(item.call_id, "") || stringOr(item.id, "");
      const name = stringOr(item.name, "");
      if (!id || !name) continue;
      result.messages.push({ role: "assistant", toolCalls: [{ id, name, arguments: toolArguments(item.arguments) }] });
      continue;
    }
    if (type === "function_call_output") {
      const id = stringOr(item.call_id, "");
      if (!id) continue;
      result.messages.push({
        role: "tool",
        toolResults: [{ toolCallId: id, toolName: "", result: parseMaybeJson(contentText(item.output)) }]
      });
      continue;
    }

    const role = stringOr(item.role, "user");
    if (role === "system" || role === "developer") {
      const text = contentText(item.content);
      if (text) result.system.push(text);
      continue;
    }
    if (role === "assistant") {
      const text = contentText(item.content);
      if (text) result.messages.push({ role: "assistant", text });
      continue;
    }
    pushUser(result.messages, item.content);
  }
  return result;
}

/* ------------------------------------------------------ Anthropic Messages */

function parseAnthropic(record: Record<string, unknown>): ParsedInbound {
  const result: ParsedInbound = { system: [], messages: [] };
  const system = contentText(record.system);
  if (system) result.system.push(system);

  for (const raw of asArray(record.messages)) {
    const message = asRecord(raw);
    // 小写归一：`"Assistant"` 落到 user 分支的话，该消息的 tool_use 与 thinking 会被整段丢掉。
    const role = stringOr(message.role, "user").toLowerCase();
    const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];

    if (!blocks.length) {
      const text = contentText(message.content);
      if (text) result.messages.push({ role: role === "assistant" ? "assistant" : "user", text });
      continue;
    }

    // Anthropic 把 tool_result 放在 user 消息里，但协议侧它属于 role=TOOL(3)。
    const toolResults: ConnectToolResult[] = [];
    const toolCalls: GatewayToolCall[] = [];
    const reasoning: ConnectReasoningPart[] = [];
    const images: GatewayImage[] = [];
    const texts: string[] = [];

    for (const block of blocks) {
      switch (stringOr(block.type, "")) {
        case "text":
          if (typeof block.text === "string" && block.text) texts.push(block.text);
          break;
        case "thinking": {
          const text = stringOr(block.thinking, "");
          const signature = stringOr(block.signature, "");
          const part: ConnectReasoningPart = { text };
          if (signature) part.signature = signature;
          reasoning.push(part);
          break;
        }
        case "redacted_thinking":
          reasoning.push({ text: "", isRedacted: true, redactedData: stringOr(block.data, "") });
          break;
        case "tool_use": {
          const id = stringOr(block.id, "");
          const name = stringOr(block.name, "");
          if (id && name) toolCalls.push({ id, name, arguments: toolArguments(block.input) });
          break;
        }
        case "tool_result": {
          const id = stringOr(block.tool_use_id, "");
          if (!id) break;
          toolResults.push({
            toolCallId: id,
            toolName: "",
            result: parseMaybeJson(contentText(block.content)),
            isError: block.is_error === true
          });
          break;
        }
        case "image": {
          const source = asRecord(block.source);
          const type = stringOr(source.type, "base64");
          images.push(
            type === "url"
              ? { type: "image", source: "url", data: stringOr(source.url, "") }
              : {
                  type: "image",
                  source: "base64",
                  data: stringOr(source.data, ""),
                  mediaType: stringOr(source.media_type, "") || undefined
                }
          );
          break;
        }
        case "document":
          // 与 protocol.ts 一致：明确拒绝而不是静默丢掉——
          // 丢掉的后果是模型被问一份它从来没收到的 PDF。
          throw new ApiError(
            "document/PDF content blocks are not supported on the Cursor Connect route.",
            400,
            "unsupported_parameter"
          );
        default: {
          // 不认识的块也不能凭空消失，至少把它序列化进文本里留个痕。
          const serialized = safeStringify(block);
          if (serialized) texts.push(serialized);
          break;
        }
      }
    }

    // tool_result 必须单独成一条 TOOL 消息：content 是 oneof，
    // 它和同一条 user 消息里的文本 / 图片不能共存。
    // assistant 轮次里出现 tool_result 是不合规的输入，但真出现时结果得排在
    // 发起它的 assistant 消息之后，否则上游看到的是一个还没被请求的工具结果。
    if (toolResults.length && role !== "assistant") result.messages.push({ role: "tool", toolResults });

    const text = texts.join("\n\n");
    if (role === "assistant") {
      const assistant: ConnectMessage = { role: "assistant" };
      if (text) assistant.text = text;
      if (toolCalls.length) assistant.toolCalls = toolCalls;
      if (reasoning.length) assistant.reasoning = reasoning;
      if (assistant.text || assistant.toolCalls || assistant.reasoning) result.messages.push(assistant);
      if (toolResults.length) result.messages.push({ role: "tool", toolResults });
      continue;
    }
    // 非 assistant 角色也可能带 tool_use / thinking（客户端不规范时）。
    // 只看 text/images 会把它们连同整条消息一起丢掉。
    if (text || images.length || toolCalls.length || reasoning.length) {
      result.messages.push({
        role: "user",
        ...(text ? { text } : {}),
        ...(images.length ? { images } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(reasoning.length ? { reasoning } : {})
      });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ 通用 */

function userMessage(content: unknown): ConnectMessage {
  const images: GatewayImage[] = [];
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else {
    for (const raw of asArray(content)) {
      const part = asRecord(raw);
      const type = stringOr(part.type, "");
      if (type === "text" || type === "input_text") {
        const text = stringOr(part.text, "");
        if (text) texts.push(text);
      } else if (type === "image_url" || type === "input_image") {
        const image = imageFrom(part);
        if (image) images.push(image);
      }
    }
  }
  const text = texts.join("\n\n");
  return { role: "user", ...(text ? { text } : {}), ...(images.length ? { images } : {}) };
}

/** OpenAI 的 data URL（`data:image/png;base64,...`）要拆成 mediaType + 裸 base64。 */
function imageFrom(part: Record<string, unknown>): GatewayImage | undefined {
  const url = stringOr(asRecord(part.image_url).url, "") || stringOr(part.image_url, "") || stringOr(part.url, "");
  if (!url) return undefined;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) return { type: "image", source: "base64", data: dataUrl[2], mediaType: dataUrl[1] };
  return { type: "image", source: "url", data: url };
}

function parseReasoning(message: Record<string, unknown>): ConnectReasoningPart[] {
  const text = stringOr(message.reasoning_content, "") || stringOr(message.reasoning, "");
  if (!text) return [];
  const signature = stringOr(message.reasoning_signature, "");
  return [{ text, ...(signature ? { signature } : {}) }];
}

/** 工具结果原文可能是 JSON 串也可能是纯文本；能 parse 就给结构化 Value，否则原样当字符串。 */
function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    const part = asRecord(raw);
    const text = stringOr(part.text, "");
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
