import { createHash } from "node:crypto";
import {
  collectHostMetaCallIds,
  contentToTextAndImages,
  imageFromUrl,
  parseAnthropicTools,
  parseOpenAiTools,
  parseResponsesTools,
  responseContentToText
} from "./protocol.js";
import { systemSeedText } from "./routing.js";
import { resolveSystemText } from "./system-prompt.js";
import { isHostMetaTool } from "./tool-compat.js";
import type { DurableTurn, GatewayImage, GatewayTool, ProtocolKind, SystemPromptSettings } from "./types.js";

/**
 * Slot 侧提示：与 SessionHub 对齐的最小字段。历史 checksum 等由后续 WP 扩展。
 * 入站指纹与这些值不一致时 `extractDurableTurn` 返回 `kind=incompatible`。
 */
export interface DurableSlotHints {
  lastUserText?: string;
  systemFingerprint?: string;
  toolsFingerprint?: string;
}

/** 与 `prepareOpenAiResponses` 的 previous 同形，仅 Responses 续聊需要。 */
export interface DurablePrevious {
  response?: Record<string, unknown>;
  inputItems?: unknown[];
}

interface TurnBits {
  userText?: string;
  images?: GatewayImage[];
  toolResults?: DurableTurn["toolResults"];
}

/**
 * 从客户端全量 history 抽出本轮增量。纯函数，不改 `prepare*` flatten，也不发 send。
 *
 * `protocol` 决定 messages / input / tool_result 形状；`previous` 只给 Responses
 * `previous_response_id` 用来对上 `call_id`（含宿主元工具丢弃）。
 * `systemPrompt` 与 flatten 路径同一套 append/override，否则 durable send 会丢掉后台系统提示。
 *
 * `slotHints` 需要活 slot。gateway 选 key 之前 server 往往还没有 durableSessionId，
 * 指纹 / lastUserText 由 runner `ensureDurableSlot` 对齐；入口能拿到 hints 时仍应传入。
 */
export function extractDurableTurn(
  protocol: ProtocolKind,
  body: unknown,
  previous?: DurablePrevious,
  slotHints?: DurableSlotHints,
  systemPrompt?: SystemPromptSettings
): DurableTurn {
  const record = asRecord(body) ?? {};
  const systemText = resolveSystemText(systemSeedText(record), systemPrompt);
  const systemFingerprint = sha256Hex(systemText);
  const toolsFingerprint = fingerprintTools(parseTools(protocol, record));
  const withSystem = (turn: DurableTurn): DurableTurn => (systemText ? { ...turn, systemText } : turn);
  if (slotHints?.systemFingerprint !== undefined && slotHints.systemFingerprint !== systemFingerprint) {
    return withSystem({ kind: "incompatible", systemFingerprint, toolsFingerprint });
  }
  if (slotHints?.toolsFingerprint !== undefined && slotHints.toolsFingerprint !== toolsFingerprint) {
    return withSystem({ kind: "incompatible", systemFingerprint, toolsFingerprint });
  }

  const bits =
    protocol === "openai-chat"
      ? extractChat(record)
      : protocol === "anthropic-messages"
        ? extractAnthropic(record)
        : extractResponses(record, previous);

  const toolResults = bits.toolResults?.length ? bits.toolResults : undefined;
  if (toolResults) {
    return withSystem({ kind: "tool_results", systemFingerprint, toolsFingerprint, toolResults });
  }

  const userText = bits.userText ?? "";
  const images = bits.images?.length ? bits.images : undefined;
  if (slotHints?.lastUserText !== undefined && slotHints.lastUserText === userText) {
    return withSystem({ kind: "empty", systemFingerprint, toolsFingerprint });
  }
  if (!userText && !images) {
    return withSystem({ kind: "empty", systemFingerprint, toolsFingerprint });
  }
  return withSystem({ kind: "new_user", systemFingerprint, toolsFingerprint, userText, images });
}

export function fingerprintTools(tools: GatewayTool[]): string {
  const rows = tools
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(stableStringify(rows));
}

function parseTools(protocol: ProtocolKind, record: Record<string, unknown>): GatewayTool[] {
  if (protocol === "openai-chat") return parseOpenAiTools(record.tools, record.tool_choice);
  if (protocol === "openai-responses") return parseResponsesTools(record.tools, record.tool_choice);
  return parseAnthropicTools(record.tools, record.tool_choice);
}

function extractChat(record: Record<string, unknown>): TurnBits {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const metaIds = collectHostMetaCallIds(messages);
  let i = messages.length - 1;
  while (i >= 0) {
    const role = asRecord(messages[i])?.role;
    if (role === "tool" || role === "function") {
      i -= 1;
      continue;
    }
    break;
  }
  const trailing = messages.slice(i + 1);
  const toolResults = chatToolResults(trailing, metaIds);
  if (toolResults.length) return { toolResults };

  const lastUser = lastRoleMessage(messages.slice(0, i + 1), "user");
  if (!lastUser) return {};
  const images: GatewayImage[] = [];
  const userText = stripImagePlaceholders(contentToTextAndImages(lastUser.content, images, false));
  return { userText, images };
}

function chatToolResults(trailing: unknown[], metaIds: ReadonlySet<string>): NonNullable<DurableTurn["toolResults"]> {
  const results: NonNullable<DurableTurn["toolResults"]> = [];
  for (const message of trailing) {
    const item = asRecord(message);
    if (!item) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name && isHostMetaTool(name)) continue;
    const callId =
      typeof item.tool_call_id === "string" && item.tool_call_id.trim()
        ? item.tool_call_id.trim()
        : name;
    if (!callId || metaIds.has(callId)) continue;
    const dumped: GatewayImage[] = [];
    const content = stripImagePlaceholders(contentToTextAndImages(item.content, dumped, false));
    results.push({ id: callId, content });
  }
  return results;
}

function extractAnthropic(record: Record<string, unknown>): TurnBits {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const metaIds = collectHostMetaCallIds(messages);
  const last = lastRoleMessage(messages, "user");
  if (!last) return {};

  const toolResults = anthropicToolResults(last.content, metaIds);
  if (toolResults.length) return { toolResults };

  const images: GatewayImage[] = [];
  collectAnthropicImages(last.content, images);
  const userText = anthropicUserText(last.content);
  return { userText, images };
}

function anthropicToolResults(content: unknown, metaIds: ReadonlySet<string>): NonNullable<DurableTurn["toolResults"]> {
  if (!Array.isArray(content)) return [];
  const results: NonNullable<DurableTurn["toolResults"]> = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record || record.type !== "tool_result") continue;
    const id = typeof record.tool_use_id === "string" ? record.tool_use_id.trim() : "";
    if (!id || metaIds.has(id)) continue;
    const item: NonNullable<DurableTurn["toolResults"]>[number] = {
      id,
      content: toolResultText(record.content)
    };
    if (record.is_error === true) item.isError = true;
    results.push(item);
  }
  return results;
}

function anthropicUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record?.type === "text" && typeof record.text === "string" && record.text) parts.push(record.text);
  }
  return parts.join("\n");
}

function collectAnthropicImages(content: unknown, images: GatewayImage[]): void {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    const record = asRecord(part);
    if (!record || record.type !== "image") continue;
    const source = asRecord(record.source);
    if (!source) continue;
    const type = typeof source.type === "string" ? source.type : "";
    if (type === "base64" && typeof source.data === "string") {
      images.push({
        type: "image",
        source: "base64",
        data: source.data,
        mediaType: typeof source.media_type === "string" ? source.media_type : undefined
      });
    } else if (type === "url" && typeof source.url === "string") {
      images.push(imageFromUrl(source.url));
    }
  }
}

function extractResponses(record: Record<string, unknown>, previous?: DurablePrevious): TurnBits {
  const input = record.input;
  if (typeof input === "string") return { userText: input };

  const items = Array.isArray(input) ? input : [];
  const metaIds = collectHostMetaCallIds([
    ...items,
    ...(Array.isArray(previous?.response?.output) ? previous.response.output : []),
    ...(previous?.inputItems ?? [])
  ]);

  let i = items.length - 1;
  while (i >= 0 && (isResponseToolOutput(items[i]) || isReasoningItem(items[i]))) i -= 1;
  const trailing = items.slice(i + 1).filter((item) => isResponseToolOutput(item));
  const toolResults = responseToolResults(trailing, metaIds);
  if (toolResults.length) return { toolResults };

  const lastUser = lastResponseUserItem(items.slice(0, i + 1));
  if (!lastUser) return {};
  return responseUserBits(lastUser);
}

function responseToolResults(trailing: unknown[], metaIds: ReadonlySet<string>): NonNullable<DurableTurn["toolResults"]> {
  const results: NonNullable<DurableTurn["toolResults"]> = [];
  for (const item of trailing) {
    const record = asRecord(item);
    if (!record) continue;
    const id =
      (typeof record.call_id === "string" && record.call_id.trim()) ||
      (typeof record.tool_use_id === "string" && record.tool_use_id.trim()) ||
      "";
    if (!id || metaIds.has(id)) continue;
    const raw = record.output ?? record.content ?? "";
    results.push({
      id,
      content: typeof raw === "string" ? raw : toolResultText(raw)
    });
  }
  return results;
}

function lastResponseUserItem(items: unknown[]): unknown {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isResponseUserItem(items[i])) return items[i];
  }
  return undefined;
}

function responseUserBits(item: unknown): TurnBits {
  if (typeof item === "string") return { userText: item };
  const record = asRecord(item);
  if (!record) return {};
  const images: GatewayImage[] = [];
  if (record.type === "input_text" && typeof record.text === "string") {
    return { userText: record.text, images };
  }
  if (record.type === "input_image") {
    pushInputImage(record, images);
    return { userText: "", images };
  }
  const userText = stripImagePlaceholders(responseContentToText(record.content ?? record.text, images, false));
  return { userText, images };
}

function isResponseToolOutput(value: unknown): boolean {
  const type = asRecord(value)?.type;
  return type === "function_call_output" || type === "tool_result";
}

function isReasoningItem(value: unknown): boolean {
  return asRecord(value)?.type === "reasoning";
}

function isResponseUserItem(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.type === "input_text" || record.type === "input_image") return true;
  if (record.type === "message" || record.type === undefined) {
    return record.role === undefined || record.role === "user";
  }
  return false;
}

function pushInputImage(record: Record<string, unknown>, images: GatewayImage[]): void {
  const url = typeof record.image_url === "string" ? record.image_url : "";
  const data = typeof record.image_base64 === "string" ? record.image_base64 : "";
  if (url) images.push(imageFromUrl(url));
  if (data) {
    images.push({
      type: "image",
      source: "base64",
      data,
      mediaType: typeof record.media_type === "string" ? record.media_type : undefined
    });
  }
}

function lastRoleMessage(messages: unknown[], role: string): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = asRecord(messages[i]);
    if (item?.role === role) return item;
  }
  return undefined;
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        if (!record) return "";
        if (
          (record.type === "text" || record.type === "input_text" || record.type === "output_text") &&
          typeof record.text === "string"
        ) {
          return record.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (record && typeof record.text === "string") return record.text;
  return JSON.stringify(value);
}

function stripImagePlaceholders(text: string): string {
  return text
    .split("\n")
    .filter((line) => line !== "[image:attached]" && line !== "[image:missing]")
    .join("\n");
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
