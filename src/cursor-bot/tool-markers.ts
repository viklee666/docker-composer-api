import { randomUUID } from "node:crypto";
import type { CursorStreamEvent, GatewayToolCall } from "../types.js";

/** 正文工具标记的开头（与 SDK 侧 protocol.ts 的 parseToolMarkers 同一套格式）。 */
const MARKER_OPEN = "<tool_call>";
/** 正文工具标记的结尾。 */
const MARKER_CLOSE = "</tool_call>";
/** 未闭合 marker 的最大暂扣字节数，超过按普通文本放行（与 SDK 侧 ToolMarkerFilter 同值）。 */
const MAX_MARKER_BUFFER = 64 * 1024;
/** 完整 marker 的整体正则（非流式路径用）。 */
const MARKER_RE = new RegExp(escapeRegExp(MARKER_OPEN) + "([\\s\\S]*?)" + escapeRegExp(MARKER_CLOSE), "g");
/** Luna / 直连未声明 tools[] 时会把调用糊成 `to=Read junk {...}` 正文，而不是 `<tool_call>`。 */
const TO_EQUALS = "to=";
/** GPT Harmony：`<|recipient|>Shell {json}`。 */
const RECIPIENT_OPEN = "<|recipient|>";
/** `to=` / `<|recipient|>` 后面允许的工具名（含 `functions.Read`）。 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*/;
/** 工具名与 JSON 之间夹的胡话上限（实测 `代上 code:` / `(json在线观看中文字幕)` 都远短于此）。 */
const TO_EQUALS_JUNK_MAX = 160;
/** Harmony 标签后通常直接跟 JSON；`<|constrain|>json<|content|>` 也要能跨过去。 */
const RECIPIENT_JUNK_MAX = 48;

/**
 * Bot 通道的正文工具标记还原（计划包 F 第 3 条）。
 *
 * 上游（Cursor Inference Stream）在未拿到结构化 tools[] 时会把工具调用当正文吐出。
 * 常见几种：`<tool_call>{...}</tool_call>`、直连 Luna 的 `to=Read junk {...}`、
 * GPT Harmony 的 `<|recipient|>Shell {json}`，以及剥掉标签后剩下的裸参数 JSON。
 * SDK 路线只处理第一种；这里都还原，但不共用 SDK 过滤器——那边耦合着 park / held
 * 等状态，照搬会把那些概念一起带进 bot。
 *
 * 与 SDK 侧的差异（有意为之）：
 * - 流式过滤挂在 ResponseNormalizer 的 textPart 事件上，而不是单独一层 runner；
 * - 客户端工具声明过滤（keepDeclaredOnly）与别名归一不在这里做——本文件只负责把
 *   标记还原成调用，声明表在 ResponseNormalizer 手里（admitMarkerToolCall 复用
 *   tool-compat 的 matchesClientTool / normalizeToolCallForClient，与 SDK 侧同口径）。
 */

/** 非流式：把全文里全部完整标记解析成工具调用，正文剥掉已消费的标记（首尾空白一并去掉，与 SDK 侧同口径）。 */
export function parseToolMarkers(text: string): { text: string; toolCalls: GatewayToolCall[] } {
  const toolCalls: GatewayToolCall[] = [];
  const withoutXml = text.replace(MARKER_RE, (match, raw: string) => {
    const parsed = parseToolCallJson(raw);
    // 解析失败保留原文，避免工具调用与正文一起被静默吞掉（与 SDK 侧同口径）。
    if (!parsed) return match;
    toolCalls.push(parsed);
    return "";
  });
  const cleaned = stripTextToolCalls(withoutXml, toolCalls).trim();
  return { text: cleaned, toolCalls };
}

function stripTextToolCalls(text: string, sink: GatewayToolCall[]): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const found = nextTextToolCall(text, cursor);
    if (!found || found.status !== "hit") {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, found.start);
    sink.push(found.call);
    cursor = found.end;
  }
  return out;
}

type ExtractFind =
  | { status: "none" }
  | { status: "incomplete"; start: number }
  | { status: "hit"; start: number; end: number; call: GatewayToolCall };

type LocatedFind = Exclude<ExtractFind, { status: "none" }>;

function nextTextToolCall(text: string, from: number): LocatedFind | undefined {
  const candidates = [
    findPrefixedJsonCall(text, from, RECIPIENT_OPEN, RECIPIENT_JUNK_MAX),
    findPrefixedJsonCall(text, from, TO_EQUALS, TO_EQUALS_JUNK_MAX),
    findBareToolJson(text, from)
  ].filter((item): item is LocatedFind => item.status !== "none");
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0];
}

function findPrefixedJsonCall(text: string, from: number, prefix: string, junkMax: number): ExtractFind {
  let searchFrom = from;
  while (searchFrom < text.length) {
    const start = text.indexOf(prefix, searchFrom);
    if (start < 0) return { status: "none" };
    const afterEq = start + prefix.length;
    const nameMatch = TOOL_NAME_RE.exec(text.slice(afterEq));
    if (!nameMatch || /^multi_tool_use\.parallel$/i.test(nameMatch[0])) {
      if (afterEq >= text.length) return { status: "incomplete", start };
      searchFrom = afterEq;
      continue;
    }
    const afterName = afterEq + nameMatch[0].length;
    if (afterName >= text.length) return { status: "incomplete", start };
    const afterTags = skipHarmonyTags(text, afterName);
    if (afterTags >= text.length) return { status: "incomplete", start };
    const braceAt = text.indexOf("{", afterTags);
    if (braceAt < 0) {
      if (text.length - afterTags <= junkMax) return { status: "incomplete", start };
      searchFrom = afterEq;
      continue;
    }
    if (braceAt - afterTags > junkMax) {
      searchFrom = afterEq;
      continue;
    }
    const json = findBalancedJson(text, braceAt);
    if (!json) {
      if (text.length - start > MAX_MARKER_BUFFER) {
        searchFrom = afterEq;
        continue;
      }
      return { status: "incomplete", start };
    }
    const args = parseObjectJson(json.raw);
    if (!args) {
      searchFrom = json.end;
      continue;
    }
    return {
      status: "hit",
      start,
      end: absorbCrumbs(text, json.end),
      call: makeToolCall(nameMatch[0], args)
    };
  }
  return { status: "none" };
}

function findBareToolJson(text: string, from: number): ExtractFind {
  let searchFrom = from;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) return { status: "none" };
    const json = findBalancedJson(text, start);
    if (!json) {
      if (text.length - start > MAX_MARKER_BUFFER) {
        searchFrom = start + 1;
        continue;
      }
      return { status: "incomplete", start };
    }
    const args = parseObjectJson(json.raw);
    const unwrapped = args ? unwrapEnvelopeArgs(args) : undefined;
    const named = typeof args?.name === "string" ? args.name.trim() : "";
    const name = named || (unwrapped ? inferToolFromArgs(unwrapped) : undefined);
    if (!unwrapped || !name) {
      searchFrom = json.end;
      continue;
    }
    return {
      status: "hit",
      start,
      end: absorbCrumbs(text, json.end),
      call: makeToolCall(name, unwrapped)
    };
  }
  return { status: "none" };
}

function inferToolFromArgs(args: Record<string, unknown>): string | undefined {
  const keys = new Set(Object.keys(args));
  if (keys.size === 0) return undefined;
  if (keys.has("old_string") && keys.has("new_string")) return "StrReplace";
  if (keys.has("glob_pattern")) return "Glob";
  if (keys.has("command")) return "Shell";
  if (keys.has("todos")) return "TodoWrite";
  if (keys.has("target_notebook")) return "EditNotebook";
  if (keys.has("pattern") && (keys.has("glob") || keys.has("path") || keys.has("file_path"))) return "Grep";
  if (keys.has("path") || keys.has("file_path") || keys.has("target_file")) return "Read";
  return undefined;
}

function parseObjectJson(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function makeToolCall(rawName: string, args: Record<string, unknown>): GatewayToolCall {
  const unwrapped = unwrapEnvelopeArgs(args);
  const mapped =
    "file_path" in unwrapped && !("path" in unwrapped)
      ? { ...unwrapped, path: unwrapped.file_path }
      : "target_file" in unwrapped && !("path" in unwrapped)
        ? { ...unwrapped, path: unwrapped.target_file }
        : unwrapped;
  return {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    name: rawName.replace(/^functions\./i, ""),
    arguments: mapped
  };
}

/** `to=Shell {"name":"Shell","arguments":{command}}` 要把内层对象拆出来，否则 Cursor 报缺 command。 */
function unwrapEnvelopeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(args.arguments) ?? asRecord(args.input);
  if (!nested) return args;
  const keys = Object.keys(args);
  if (keys.every((key) => key === "name" || key === "arguments" || key === "input" || key === "id")) return nested;
  return args;
}

/** Harmony 在工具名和 JSON 之间会插 `<|content|>` / `<|constrain|>json` 这类标签。 */
function skipHarmonyTags(text: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
    if (!text.startsWith("<|", index)) break;
    const close = text.indexOf("|>", index + 2);
    if (close < 0 || close - index > 40) break;
    index = close + 2;
  }
  return index;
}

function absorbCrumbs(text: string, end: number): number {
  let cursor = skipHarmonyTags(text, end);
  const nexts = [text.indexOf(TO_EQUALS, cursor), text.indexOf(RECIPIENT_OPEN, cursor), text.indexOf("{", cursor)].filter(
    (index) => index >= 0
  );
  if (!nexts.length) return cursor;
  const next = Math.min(...nexts);
  const between = text.slice(cursor, next);
  return between.length <= 12 && !/[\n。！？]/.test(between) ? next : cursor;
}

function findBalancedJson(text: string, braceStart: number): { end: number; raw: string } | undefined {
  if (text[braceStart] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { end: i + 1, raw: text.slice(braceStart, i + 1) };
    }
  }
  return undefined;
}

/**
 * 解析 <tool_call> 标记内的 JSON。容错处理模型常见的输出偏差：
 * 代码围栏包裹、arguments 是字符串化 JSON（OpenAI 原生格式）。
 * 解析失败返回 undefined，由调用方保留原文。
 */
export function parseToolCallJson(raw: string): GatewayToolCall | undefined {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const value = JSON.parse(stripped) as unknown;
    const record = asRecord(value);
    if (!record) return undefined;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return undefined;
    const args = toolCallArguments(record.arguments ?? record.input);
    if (!args) return undefined;
    const id =
      typeof record.id === "string" && record.id.trim() ? record.id.trim() : `call_${randomUUID().replaceAll("-", "")}`;
    return { id, name, arguments: args };
  } catch {
    return undefined;
  }
}

/**
 * 流式 <tool_call> 标记过滤器（与 SDK 侧 ToolMarkerFilter 同款算法）：
 * 正文实时放行，只暂扣可能是 marker 前缀的尾部（最多 MARKER_OPEN.length-1 个字符）；
 * 每次 push 解析 buffer 里**全部**完整 marker；解析失败的 marker 原文放行（不静默吞内容）；
 * 首个成功解析的 marker 之后的正文进入 held 暂存区——不能先于工具调用下发。
 */
export class ToolMarkerFilter {
  private buffer = "";
  private held = "";
  private pendingToolCalls: GatewayToolCall[] = [];

  /** 送入新文本，返回可以安全下发的部分（首个已解析 marker 之前的正文）。 */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    const append = (text: string) => {
      if (!text) return;
      if (this.pendingToolCalls.length) this.held += text;
      else out += text;
    };
    for (;;) {
      const xmlStart = this.buffer.indexOf(MARKER_OPEN);
      const textCall = nextTextToolCall(this.buffer, 0);
      const textStart = textCall ? textCall.start : -1;
      if (xmlStart < 0 && textStart < 0) {
        const hold = this.holdFrom();
        append(this.buffer.slice(0, hold));
        this.buffer = this.buffer.slice(hold);
        break;
      }
      if (xmlStart >= 0 && (textStart < 0 || xmlStart <= textStart)) {
        const end = this.buffer.indexOf(MARKER_CLOSE, xmlStart + MARKER_OPEN.length);
        if (end < 0) {
          // marker 已开但长时间不闭合：超过上限（按 UTF-16 code unit 计）当普通文本放行，避免无界缓冲。
          if (this.buffer.length - xmlStart > MAX_MARKER_BUFFER) {
            append(this.buffer);
            this.buffer = "";
            break;
          }
          // marker 已开但未闭合：放行 marker 前的正文，暂扣其余等待闭合。
          append(this.buffer.slice(0, xmlStart));
          this.buffer = this.buffer.slice(xmlStart);
          break;
        }
        append(this.buffer.slice(0, xmlStart));
        const raw = this.buffer.slice(xmlStart + MARKER_OPEN.length, end);
        this.buffer = this.buffer.slice(end + MARKER_CLOSE.length);
        const parsed = parseToolCallJson(raw);
        if (parsed) this.pendingToolCalls.push(parsed);
        else append(MARKER_OPEN + raw + MARKER_CLOSE);
        continue;
      }
      if (!textCall || textCall.status !== "hit") {
        const holdAt = textCall?.start ?? 0;
        if (this.buffer.length - holdAt > MAX_MARKER_BUFFER) {
          append(this.buffer);
          this.buffer = "";
          break;
        }
        append(this.buffer.slice(0, holdAt));
        this.buffer = this.buffer.slice(holdAt);
        break;
      }
      append(this.buffer.slice(0, textCall.start));
      this.buffer = this.buffer.slice(textCall.end);
      this.pendingToolCalls.push(textCall.call);
    }
    return out;
  }

  /** 取走并清空已解析到的 marker 工具调用。 */
  takeToolCalls(): GatewayToolCall[] {
    const calls = this.pendingToolCalls;
    this.pendingToolCalls = [];
    return calls;
  }

  /** 取回 marker 之后暂存的正文（调用方决定不再下发工具时恢复流式用）。 */
  takeHeldText(): string {
    const held = this.held;
    this.held = "";
    return held;
  }

  /** 流结束时取回暂存正文 + 暂扣尾部（未构成完整 marker 的部分）。 */
  flush(): string {
    const rest = this.held + this.buffer;
    this.held = "";
    this.buffer = "";
    return rest;
  }

  /** buffer 尾部可能是 `<tool_call>` 或 `to=` 前缀的最早位置。 */
  private holdFrom(): number {
    const prefixes = [MARKER_OPEN, TO_EQUALS, RECIPIENT_OPEN];
    let earliest = this.buffer.length;
    for (const prefix of prefixes) {
      const max = Math.min(this.buffer.length, prefix.length - 1);
      for (let len = max; len > 0; len -= 1) {
        if (prefix.startsWith(this.buffer.slice(this.buffer.length - len))) {
          earliest = Math.min(earliest, this.buffer.length - len);
          break;
        }
      }
    }
    return earliest;
  }
}

/**
 * 便捷封装：把一个 textPart 增量交给过滤器，产出 0..n 个事件。
 * 正文放行成 text 事件；marker 里解析出的调用集中产出，且**恒在最后**：
 * 产出调用前先把 held 暂存的正文补放掉（marker 之后的正文不能先于工具调用下发，
 * 但既然调用已经解析出来，held 正文就先补放、调用压轴），同一增量内的顺序是
 * 「marker 前正文 → 补放的 held 正文 → tool_call」。
 */
export function markerEventsFromText(filter: ToolMarkerFilter, chunk: string): CursorStreamEvent[] {
  const events: CursorStreamEvent[] = [];
  const safe = filter.push(chunk);
  if (safe) events.push({ type: "text", text: safe });
  const calls = filter.takeToolCalls();
  if (calls.length) {
    const held = filter.takeHeldText();
    if (held) events.push({ type: "text", text: held });
    for (const toolCall of calls) events.push({ type: "tool_call", toolCall });
  }
  return events;
}

/** 流结束时收尾：把 held 与未闭合的 buffer 作为正文放行（没有可解析的调用）。 */
export function markerFlushEvents(filter: ToolMarkerFilter): CursorStreamEvent[] {
  const rest = filter.flush();
  return rest ? [{ type: "text", text: rest }] : [];
}

/** arguments 可能是对象，也可能是字符串化 JSON（模型极常见的输出方式）。 */
function toolCallArguments(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 把字面量字符安全地塞进正则源。 */
function escapeRegExp(text: string): string {
  return text.replace(/[/.*+?^${}()|[\]\\\\]/g, "\\$&");
}
