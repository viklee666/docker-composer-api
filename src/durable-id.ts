import { createHash } from "node:crypto";
import { conversationSeed } from "./routing.js";

/**
 * 计算 SessionHub 用的会话键。
 *
 * 仅当能认出「这是哪一段对话」时有值：显式会话头、传入/继承的 conversationSeed、
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
 */
export function durableIdentity(input: DurableSessionIdInput): string | undefined {
  return (
    nonempty(explicitSessionIdFromHeaders(input.headers)) ??
    nonempty(input.conversationSeed) ??
    nonempty(conversationSeed(input.body)) ??
    nonempty(input.stickyKey)
  );
}

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
  /** 入站密钥的 owner 散列。禁止单独作为 Hub 键。 */
  ownerHash?: string;
  headers?: DurableSessionHeaders;
  body?: unknown;
}

type DurableSessionHeaders = Record<string, string | string[] | undefined>;

/**
 * 与 auth.explicitSessionId 同一组头、同一优先级。
 * 不依赖 FastifyRequest，便于纯函数测试与 WP4 接线。
 */
function explicitSessionIdFromHeaders(headers: DurableSessionHeaders | undefined): string | undefined {
  if (!headers) return undefined;
  return (
    headerValue(headers, "x-session-affinity") ??
    headerValue(headers, "x-opencode-session-id") ??
    headerValue(headers, "x-opencode-session") ??
    headerValue(headers, "anthropic-session-id")
  );
}

function headerValue(headers: DurableSessionHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      const found = value.find((item) => typeof item === "string" && item.trim());
      return found?.trim() || undefined;
    }
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
