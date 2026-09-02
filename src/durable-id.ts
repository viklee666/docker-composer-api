import { createHash } from "node:crypto";
import { conversationSeed } from "./routing.js";

/**
 * 计算 SessionHub 用的会话键。
 *
 * 仅当能认出「这是哪一段对话」时有值：显式会话头/body、传入/继承的 conversationSeed、
 * 请求体算出的 conversationSeed、或已经由 stickyKeyFor 组好的 stickyKey。
 * 无 seed → undefined，走 stateless，禁止用 ownerHash / 裸 sessionKey 兜底。
 *
 * Hub 键再混入 apiKey + model + workingDirectory，与今日 sessionId() 同构，
 * 避免不同模型 / key / 工作目录撞槽。
 */
export function durableSessionId(input: DurableSessionIdInput): string | undefined {
  const identity = durableIdentity(input);
  if (!identity) return undefined;
  return createHash("sha256")
    .update([input.apiKey ?? "", input.model ?? "", identity, input.workingDirectory ?? ""].join("\0"))
    .digest("hex");
}

/**
 * 可识别的对话身份（未混 apiKey/model）。ownerHash 与裸 sessionKey 即使传入也忽略。
 * 三级瀑布：显式头/body → 继承的 conversationSeed → 请求体现算 → 非 ownerHash 的 stickyKey。
 */
export function durableIdentity(input: DurableSessionIdInput): string | undefined {
  const sticky = nonempty(input.stickyKey);
  return (
    nonempty(explicitSessionIdFromHeaders(input.headers)) ??
    nonempty(explicitSessionIdFromBody(input.body)) ??
    nonempty(input.conversationSeed) ??
    nonempty(conversationSeed(input.body, input.protocol, input.ownerHash)) ??
    (sticky && sticky !== input.ownerHash ? sticky : undefined)
  );
}

export const resolveConversationIdentity = durableIdentity;

export interface DurableSessionIdInput {
  apiKey?: string;
  model?: string;
  workingDirectory?: string;
  /** 已由 stickyKeyFor 组好的身份（含 ownerHash 前缀）；有值即可作为 Hub 键。 */
  stickyKey?: string;
  /** Responses 继承或调用方已算好的 conversationSeed。 */
  conversationSeed?: string;
  /**
   * 今日 runner 的 sessionKey。无头时会退化成 ownerHash——禁止拿它当 Hub 键。
   * 字段留在输入上是为了调用方可传入 CursorRunRequest 而不被误用。
   */
  sessionKey?: string;
  /** 入站密钥的 owner 散列。禁止当 Hub 键；仅作 L3 callerScope。 */
  ownerHash?: string;
  /** Chat / Messages / Responses；第 3 级按协议互斥取 instruction 与首条 user。 */
  protocol?: "openai-chat" | "anthropic-messages" | "openai-responses";
  headers?: DurableSessionHeaders;
  body?: unknown;
}

type DurableSessionHeaders = Record<string, string | string[] | number | undefined>;

/** 去空白、拒 Unicode 控制字符、UTF-8 长度 ≤256。 */
export function normalizeExplicitId(value: string): string | undefined {
  if (/\p{Cc}/u.test(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 256) return undefined;
  return trimmed;
}

/**
 * 客户端显式会话头，先命中先用。不认 x-client-request-id。
 * 不依赖 FastifyRequest，便于纯函数测试与接线。
 */
export function explicitSessionIdFromHeaders(headers: DurableSessionHeaders | undefined): string | undefined {
  if (!headers) return undefined;
  return (
    headerValue(headers, "x-session-affinity") ??
    headerValue(headers, "x-opencode-session-id") ??
    headerValue(headers, "x-opencode-session") ??
    headerValue(headers, "anthropic-session-id") ??
    headerValue(headers, "x-claude-code-session-id") ??
    headerValue(headers, "x-session-id") ??
    headerValue(headers, "session-id") ??
    headerValue(headers, "session_id") ??
    headerValue(headers, "conversation_id") ??
    headerValue(headers, "x-codex-window-id") ??
    explicitFromCodexTurnMetadata(headers)
  );
}

function explicitSessionIdFromBody(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return (
    explicitString(record.session_id) ??
    explicitString(record.sessionId) ??
    explicitString(record.conversation_id) ??
    explicitString(record.prompt_cache_key) ??
    explicitFromConversation(record.conversation) ??
    explicitFromClientMetadata(record.client_metadata) ??
    explicitFromMetadataUserId(record.metadata)
  );
}

function explicitFromCodexTurnMetadata(headers: DurableSessionHeaders): string | undefined {
  const raw = rawHeaderStrings(headers, "x-codex-turn-metadata");
  for (const item of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    const fromCache = explicitString(record.prompt_cache_key);
    if (fromCache) return fromCache;
    const fromWindow = explicitString(record.window_id);
    if (fromWindow) return fromWindow;
  }
  return undefined;
}

function explicitFromConversation(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeExplicitId(value);
  const record = asRecord(value);
  return record ? explicitString(record.id) : undefined;
}

function explicitFromClientMetadata(value: unknown): string | undefined {
  const record = asRecord(value);
  return record ? explicitString(record["x-codex-window-id"]) : undefined;
}

function explicitFromMetadataUserId(metadata: unknown): string | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const userId = record.user_id;
  const nested = asRecord(userId);
  if (nested) return explicitString(nested.session_id);
  if (typeof userId !== "string") return undefined;
  if (userId.startsWith("{")) {
    try {
      const parsed = asRecord(JSON.parse(userId));
      return parsed ? explicitString(parsed.session_id) : undefined;
    } catch {
      return undefined;
    }
  }
  const match = /_session_([a-f0-9-]+)$/.exec(userId);
  return match?.[1] ? normalizeExplicitId(match[1]) : undefined;
}

function explicitString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeExplicitId(value) : undefined;
}

function headerValue(headers: DurableSessionHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string") continue;
        const normalized = normalizeExplicitId(item);
        if (normalized) return normalized;
      }
      return undefined;
    }
    return typeof value === "string" ? normalizeExplicitId(value) : undefined;
  }
  return undefined;
}

function rawHeaderStrings(headers: DurableSessionHeaders, name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") values.push(item);
      }
    }
  }
  return values;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
