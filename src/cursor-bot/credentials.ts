import { ApiError } from "../errors.js";

/** Grok Bot 的 `x-cursor-client-type` 常量值（计划文档 §1.5）。 */
export const SAND_CLIENT_TYPE = "sand";

/** 目录不可用时的兜底模型（`SAND_DEFAULT_MODEL_ID`），只用于明确标注的降级路径。 */
export const SAND_DEFAULT_MODEL_ID = "grok-4.5";

/**
 * Cursor Bot 路线的一份凭据。
 *
 * 与 SDK 路线的 `CURSOR_API_KEYS` 是两套东西：SDK 用 API key，Bot 用 session JWT
 * 加一组**必须稳定**的设备标识。machineId 每次请求换一个，上游看到的就是每次一台新设备。
 */
export interface CursorBotCredential {
  /** 库内标识，仅用于日志与缓存分片，不发给上游。 */
  id: string;
  label?: string;
  /** `authorization: Bearer <sessionToken>`。 */
  sessionToken: string;
  /** 生命周期内不可变。 */
  machineId: string;
  /** 可为空；为空时 checksum 不拼 `/`。 */
  macMachineId?: string;
  clientVersion: string;
  /** 默认 `sand`。 */
  clientType?: string;
  clientOs?: string;
  clientArch?: string;
  clientOsVersion?: string;
  deviceType?: string;
  timezone?: string;
  clientKey?: string;
  sessionId?: string;
  teamId?: string;
  /** 隐私模式：允许训练 → `false`，否则 `true`。未设置时不发该头。 */
  ghostMode?: boolean;
  newOnboardingCompleted?: boolean;
}

/**
 * JWT payload 里的 `type` claim。
 * - `web`：浏览器登录态，不能拿去调推理；
 * - `session`：桌面端长会话；
 * - `api_key_token`：`exchange_user_api_key` 兑出来的短票（实测约 1 小时）。
 */
export type CursorTokenType = "session" | "web" | "api_key_token" | "unknown";

/** 到期前这么久就该再兑一次。短票约 1 小时；10 分钟窗口覆盖巡检间隔和兑换往返。 */
export const KEY_TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;
/** 后台巡检间隔。 */
export const KEY_TOKEN_REFRESH_INTERVAL_MS = 60 * 1000;
/**
 * JWT 没有 `exp` 时的保守寿命：按签发时间（`time` / `iat`）或上次写入起算。
 * 短于实测 1 小时，避免无 exp 的 api_key_token 拖到已经失效才换。
 */
export const KEY_TOKEN_REFRESH_FALLBACK_TTL_MS = 50 * 60 * 1000;
/** 兑换失败后的退避，避免每个请求都去打上游。 */
export const KEY_TOKEN_REFRESH_RETRY_MS = 60 * 1000;

export function credentialClientType(credential: CursorBotCredential): string {
  return credential.clientType?.trim() || SAND_CLIENT_TYPE;
}

function readJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return undefined;
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 只读 JWT 的 `type` claim，不校验签名（网关没有也不需要上游的密钥）。
 * 不是 JWT（例如不透明 token）时返回 `unknown` 而不是报错。
 */
export function cursorTokenType(token: string): CursorTokenType {
  const type = readJwtPayload(token)?.type;
  if (type === "web") return "web";
  if (type === "session") return "session";
  if (type === "api_key_token") return "api_key_token";
  return "unknown";
}

/**
 * JWT 数字时间 claim → epoch ms。
 * Cursor 的 `api_key_token` 里 `exp` 是数字秒、`time` 却经常是字符串秒，两种都要认。
 */
function jwtUnixMs(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const truncated = Math.trunc(n);
  // 1e12 ms ≈ 2001-09-09。大于这个数的当毫秒，否则当秒。
  return truncated > 1e12 ? truncated : truncated * 1000;
}

/** JWT `exp` → 毫秒时间戳。缺字段 / 非数字 / 非正数视为读不到。 */
export function cursorTokenExpiresAtMs(token: string): number | undefined {
  return jwtUnixMs(readJwtPayload(token)?.exp);
}

/** JWT 签发时间：Cursor 用 `time`，标准 JWT 用 `iat`。 */
export function cursorTokenIssuedAtMs(token: string): number | undefined {
  const payload = readJwtPayload(token);
  return jwtUnixMs(payload?.time) ?? jwtUnixMs(payload?.iat);
}

export function cursorTokenExpiresAtIso(token: string): string | undefined {
  const ms = cursorTokenExpiresAtMs(token);
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

function resolveExpiryMs(credential: { sessionToken: string; expiresAt?: string }): number | undefined {
  const fromColumn = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN;
  if (Number.isFinite(fromColumn)) return fromColumn;
  return cursorTokenExpiresAtMs(credential.sessionToken);
}

function resolveIssuedAtMs(credential: { sessionToken: string; updatedAt?: string }): number | undefined {
  const fromJwt = cursorTokenIssuedAtMs(credential.sessionToken);
  if (fromJwt !== undefined) return fromJwt;
  const updatedAt = credential.updatedAt ? Date.parse(credential.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) ? updatedAt : undefined;
}

/**
 * 由 Key 兑换的 session JWT 是否该再兑一次。
 * 有 `exp` 就按到期前 `skewMs`；没有就按签发时间（JWT `time`/`iat`，否则 `updatedAt`）+ 保守寿命。
 * 粘贴的桌面端 token 没有 source key，调用方根本不该走到这里。
 */
export function keyMintedTokenNeedsRefresh(
  credential: { sessionToken: string; expiresAt?: string; updatedAt?: string },
  now = Date.now(),
  skewMs = KEY_TOKEN_REFRESH_SKEW_MS
): boolean {
  const expiresAt = resolveExpiryMs(credential);
  if (expiresAt !== undefined) return expiresAt - now <= skewMs;
  const issuedAt = resolveIssuedAtMs(credential);
  if (issuedAt === undefined) return true;
  return now - issuedAt >= KEY_TOKEN_REFRESH_FALLBACK_TTL_MS;
}

/** 短票是否已经过期（或无 exp 且已超过保守寿命）。用来决定要不要无视退避、强制再兑。 */
export function keyMintedTokenExpired(
  credential: { sessionToken: string; expiresAt?: string; updatedAt?: string },
  now = Date.now()
): boolean {
  const expiresAt = resolveExpiryMs(credential);
  if (expiresAt !== undefined) return expiresAt <= now;
  const issuedAt = resolveIssuedAtMs(credential);
  if (issuedAt === undefined) return false;
  return now - issuedAt >= KEY_TOKEN_REFRESH_FALLBACK_TTL_MS;
}

/**
 * 凭据自检。只拦能在本地判定的错误（缺字段、拿了 web token），
 * 剩下的交给上游——网关无权也无法替上游判断一份凭据是否有资格。
 *
 * 抛出的消息里绝不含 token 本身。
 */
export function assertUsableCredential(credential: CursorBotCredential): void {
  const missing = (["sessionToken", "machineId", "clientVersion"] as const).filter(
    (field) => !credential[field]?.trim()
  );
  if (missing.length) {
    throw new ApiError(`Cursor Bot credential is missing ${missing.join(", ")}.`, 500, "invalid_credential");
  }
  if (cursorTokenType(credential.sessionToken) === "web") {
    throw new ApiError(
      "Cursor Bot credential holds a browser web token; a session token is required.",
      401,
      "unauthorized"
    );
  }
}
