import { ApiError } from "../errors.js";
import { DEFAULT_CONNECT_BASE_URL } from "./client.js";
import { cursorTokenType } from "./credentials.js";
import type { ConnectFetch } from "./transport.js";

/**
 * Cursor 桌面端 `exchangeApiKeyForTokens` / `loginWithApiKey` 打的同一个接口。
 * 用 Cursor API key（`crsr_` / `key_`）换 `{ accessToken, refreshToken }`，
 * 其中 accessToken 才是 Connect 路线要的 session JWT。
 *
 * 形状取自 Cursor Grok Bot 桌面端实现：`POST {api2}/auth/exchange_user_api_key`，
 * `Authorization: Bearer <apiKey>`，body `{}`。不发 machineId——兑换与设备标识是两步。
 */
export const EXCHANGE_USER_API_KEY_PATH = "/auth/exchange_user_api_key";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_SNIPPET = 300;
const KEY_HINT_PREFIX_LENGTH = 6;
const API_KEY_PREFIXES = ["crsr_", "key_"] as const;

export interface ExchangedCursorTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ExchangeUserApiKeyOptions {
  apiKey: string;
  /** 与 Connect 出站同一份 baseUrl，默认 `https://api2.cursor.sh`。 */
  baseUrl?: string;
  fetchImpl?: ConnectFetch;
}

export function exchangeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${EXCHANGE_USER_API_KEY_PATH}`;
}

export async function exchangeUserApiKey(options: ExchangeUserApiKeyOptions): Promise<ExchangedCursorTokens> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new ApiError("Cursor API key is required.", 400, "invalid_request_error", "cursorKeyId");
  }
  const url = exchangeUrl(options.baseUrl?.trim() || DEFAULT_CONNECT_BASE_URL);
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({}),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiError("兑换 session token 超时，请稍后重试。", 504, "upstream_timeout");
    }
    throw new ApiError(`无法连接 Cursor 兑换接口：${errorText(error)}`, 502, "upstream_error");
  }

  const status = response.status;
  const bodyText = await readBody(response);
  // 401/403 与跳登录页的 3xx 对调用方是同一件事：这把 key 换不出 session token。
  // 对外固定 403：管理后台把任意 401 当成「管理员口令失效」并踢回登录页。
  if (status === 401 || status === 403 || status === 0 || (status >= 300 && status < 400)) {
    if (isSignInPolicyViolation(bodyText)) {
      throw new ApiError("这把 Cursor key 被登录策略拒绝，无法兑换 session token。", 403, "permission_error", "cursorKeyId");
    }
    throw new ApiError(
      "这把 Cursor key 无法兑换 session token：key 无效、过期或没有兑换权限。",
      403,
      "permission_error",
      "cursorKeyId"
    );
  }
  if (status === 429) {
    throw new ApiError("Cursor 兑换接口限流，请稍后再试。", 429, "rate_limit_exceeded");
  }
  if (status < 200 || status >= 300) {
    throw new ApiError(`Cursor 兑换接口返回 ${status}：${bodySnippet(bodyText)}`, 502, "upstream_error");
  }

  const tokens = readTokens(bodyText);
  if (cursorTokenType(tokens.accessToken) === "web") {
    throw new ApiError("兑换结果是浏览器 web token，不能作为 Connect session token。", 502, "upstream_error");
  }
  return tokens;
}

function readTokens(bodyText: string): ExchangedCursorTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ApiError(`Cursor 兑换接口返回了非 JSON 响应：${bodySnippet(bodyText)}`, 502, "upstream_error");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ApiError("Cursor 兑换接口响应不是对象，接口可能已变更。", 502, "upstream_error");
  }
  const record = parsed as { accessToken?: unknown; refreshToken?: unknown };
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  const refreshToken = typeof record.refreshToken === "string" ? record.refreshToken.trim() : "";
  // 桌面端两个字段都要有才算成功；缺一个就当「兑换成功但没给 token」，不能把半截响应当凭据入库。
  if (!accessToken || !refreshToken) {
    throw new ApiError("Cursor 兑换接口没有同时返回 accessToken 与 refreshToken。", 502, "upstream_error");
  }
  return { accessToken, refreshToken };
}

function isSignInPolicyViolation(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return Boolean(parsed && typeof parsed === "object" && (parsed as { error?: unknown }).error === "sign_in_policy_violation");
  } catch {
    return false;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function bodySnippet(bodyText: string): string {
  const redacted = redactSecrets(bodyText.replace(/\s+/g, " ").trim());
  if (!redacted) return "(空响应体)";
  return redacted.length > MAX_BODY_SNIPPET ? `${redacted.slice(0, MAX_BODY_SNIPPET)}…` : redacted;
}

const SECRET_FIELD_PATTERN =
  /("(?:api_?key|access_?token|refresh_?token|session_?token|token|secret|password|cookie|authorization)"\s*:\s*")([^"]*)(")/gi;
const BARE_KEY_PATTERN = new RegExp(`(?:${API_KEY_PREFIXES.join("|")})[A-Za-z0-9_-]{4,}`, "g");
const JWT_ECHO_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function redactSecrets(text: string): string {
  return text
    .replace(JWT_ECHO_PATTERN, "eyJ***")
    .replace(SECRET_FIELD_PATTERN, (_match, prefix: string, value: string, suffix: string) => {
      if (!value) return `${prefix}${suffix}`;
      if (/^eyJ[A-Za-z0-9_-]*\./.test(value) || /token/i.test(prefix)) return `${prefix}***${suffix}`;
      return `${prefix}${shapeHint(value)}${suffix}`;
    })
    .replace(BARE_KEY_PATTERN, (match: string) => shapeHint(match));
}

function shapeHint(value: string): string {
  const keep = Math.min(KEY_HINT_PREFIX_LENGTH, Math.max(0, value.length - 1));
  return `${value.slice(0, keep)}…（共 ${value.length} 字符）`;
}

function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (record.name === "TimeoutError" || record.name === "AbortError") return true;
    if (record.code === "ABORT_ERR" || record.code === "UND_ERR_ABORTED") return true;
    current = record.cause;
  }
  return false;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return typeof error === "string" ? redactSecrets(error) : "未知错误";
}
