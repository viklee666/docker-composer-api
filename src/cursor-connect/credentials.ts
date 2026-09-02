import { ApiError } from "../errors.js";

/** Grok Bot 的 `x-cursor-client-type` 常量值（计划文档 §1.5）。 */
export const SAND_CLIENT_TYPE = "sand";

/** 目录不可用时的兜底模型（`SAND_DEFAULT_MODEL_ID`），只用于明确标注的降级路径。 */
export const SAND_DEFAULT_MODEL_ID = "grok-4.5";

/**
 * Connect 路线的一份凭据。
 *
 * 与 SDK 路线的 `CURSOR_API_KEYS` 是两套东西：SDK 用 API key，Connect 用 session JWT
 * 加一组**必须稳定**的设备标识。machineId 每次请求换一个，上游看到的就是每次一台新设备。
 */
export interface CursorConnectCredential {
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

/** JWT payload 里的 `type` claim；浏览器登录态是 `web`，不能拿去调推理。 */
export type CursorTokenType = "session" | "web" | "unknown";

export function credentialClientType(credential: CursorConnectCredential): string {
  return credential.clientType?.trim() || SAND_CLIENT_TYPE;
}

/**
 * 只读 JWT 的 `type` claim，不校验签名（网关没有也不需要上游的密钥）。
 * 不是 JWT（例如不透明 token）时返回 `unknown` 而不是报错。
 */
export function cursorTokenType(token: string): CursorTokenType {
  const segments = token.split(".");
  if (segments.length !== 3) return "unknown";
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return "unknown";
    const type = (payload as { type?: unknown }).type;
    if (type === "web") return "web";
    if (type === "session") return "session";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 凭据自检。只拦能在本地判定的错误（缺字段、拿了 web token），
 * 剩下的交给上游——网关无权也无法替上游判断一份凭据是否有资格。
 *
 * 抛出的消息里绝不含 token 本身。
 */
export function assertUsableCredential(credential: CursorConnectCredential): void {
  const missing = (["sessionToken", "machineId", "clientVersion"] as const).filter(
    (field) => !credential[field]?.trim()
  );
  if (missing.length) {
    throw new ApiError(`Cursor Connect credential is missing ${missing.join(", ")}.`, 500, "invalid_credential");
  }
  if (cursorTokenType(credential.sessionToken) === "web") {
    throw new ApiError(
      "Cursor Connect credential holds a browser web token; a session token is required.",
      401,
      "unauthorized"
    );
  }
}
