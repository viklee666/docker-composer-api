import { randomUUID } from "node:crypto";
import { cursorChecksum } from "./checksum.js";
import { credentialClientType, type CursorConnectCredential } from "./credentials.js";

export const CONNECT_PROTOCOL_VERSION = "1";

/**
 * Connect 的 content-type 分**流式**与**一元**两套，混用会被服务端以 415 拒掉（实测）：
 *
 * - 流式（ServerStreaming / BiDi）：`application/connect+proto`，body 是 5 字节 envelope 帧序列；
 * - 一元（Unary）：`application/proto`，body 就是裸 protobuf，**没有 envelope**。
 *
 * 计划 §1.6 抄下的四个常量（`i6t` / `s6t` / `a6t` / `o6t`）正是这两套各两种编码。
 */
export const CONTENT_TYPE_STREAM_PROTO = "application/connect+proto";
export const CONTENT_TYPE_STREAM_JSON = "application/connect+json";
export const CONTENT_TYPE_UNARY_PROTO = "application/proto";
export const CONTENT_TYPE_UNARY_JSON = "application/json";

/** 兼容旧引用名。 */
export const CONTENT_TYPE_PROTO = CONTENT_TYPE_STREAM_PROTO;
export const CONTENT_TYPE_JSON = CONTENT_TYPE_STREAM_JSON;

export type ConnectCodec = "proto" | "json";
export type ConnectCallKind = "stream" | "unary";

export function contentTypeFor(kind: ConnectCallKind, codec: ConnectCodec): string {
  if (kind === "unary") return codec === "json" ? CONTENT_TYPE_UNARY_JSON : CONTENT_TYPE_UNARY_PROTO;
  return codec === "json" ? CONTENT_TYPE_STREAM_JSON : CONTENT_TYPE_STREAM_PROTO;
}

/**
 * 出站请求头会带 token、设备标识和 checksum，落日志前必须先过这里。
 * 白名单式脱敏：只要值可能含身份信息就整段换掉，不做「保留前几位」这种半脱敏。
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "x-cursor-checksum",
  "x-client-key",
  "x-session-id",
  "x-cursor-team-id"
]);

export interface BuildHeadersOptions {
  credential: CursorConnectCredential;
  codec?: ConnectCodec;
  /** 流式还是一元。默认 stream；填错会被服务端以 415 拒掉。 */
  kind?: ConnectCallKind;
  /** 本次请求 id；不传则新生成。同时用于 `x-amzn-trace-id`。 */
  requestId?: string;
  /** 声明能接受的响应压缩；envelope 层负责解。 */
  acceptEncoding?: string;
  /** 请求体实际用了哪种压缩；identity 时不发该头。 */
  contentEncoding?: "gzip" | "br";
  /** 供测试注入固定时间，保证 checksum 可断言。 */
  nowMs?: number;
}

/**
 * 构造 `aiserver.v1.*` 出站头。
 *
 * 刻意**不发**这几个：
 * - `x-sand-box-namespace`：Grok Bot 用来路由到自己的 sandbox，网关不是 sandbox 控制端；
 * - `x-cursor-client-commit`：仅 Anysphere 内部账号会带；
 * - `x-inference-authentication-jwt` / `x-cursor-workload*`：Grok Bot inference proxy 的上下文。
 *
 * 发了不属于自己身份的头，等于向上游声称自己是另一类客户端。
 */
export function buildConnectHeaders(options: BuildHeadersOptions): Record<string, string> {
  const { credential } = options;
  const requestId = options.requestId ?? randomUUID();
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.sessionToken}`,
    "content-type": contentTypeFor(options.kind ?? "stream", options.codec ?? "proto"),
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "x-cursor-checksum": cursorChecksum(credential.machineId, credential.macMachineId, options.nowMs),
    "x-cursor-client-type": credentialClientType(credential),
    // 头名是 x-cursor-client-version；x-cursor-version 在三个 bundle 里都是 0 处。
    "x-cursor-client-version": credential.clientVersion,
    "x-cursor-streaming": "true",
    "x-request-id": requestId,
    "x-amzn-trace-id": `Root=${requestId}`
  };

  // 压缩头也分两套：一元用标准的 `accept-encoding` / `content-encoding`，
  // 流式用 Connect 自己的 `connect-*` 前缀（envelope 里另有 compressed 标志位）。
  if (options.kind === "unary") {
    if (options.acceptEncoding) headers["accept-encoding"] = options.acceptEncoding;
    if (options.contentEncoding) headers["content-encoding"] = options.contentEncoding;
  } else {
    if (options.acceptEncoding) headers["connect-accept-encoding"] = options.acceptEncoding;
    if (options.contentEncoding) headers["connect-content-encoding"] = options.contentEncoding;
  }

  putIf(headers, "x-ghost-mode", credential.ghostMode === undefined ? undefined : String(credential.ghostMode));
  putIf(headers, "x-cursor-client-os", credential.clientOs);
  putIf(headers, "x-cursor-client-arch", credential.clientArch);
  putIf(headers, "x-cursor-client-os-version", credential.clientOsVersion);
  putIf(headers, "x-cursor-client-device-type", credential.deviceType);
  putIf(headers, "x-cursor-timezone", credential.timezone);
  putIf(headers, "x-client-key", credential.clientKey);
  putIf(headers, "x-session-id", credential.sessionId);
  putIf(headers, "x-cursor-team-id", credential.teamId);
  putIf(
    headers,
    "x-new-onboarding-completed",
    credential.newOnboardingCompleted === undefined ? undefined : String(credential.newOnboardingCompleted)
  );

  return headers;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADERS.has(name.toLowerCase()) ? "***" : value])
  );
}

function putIf(headers: Record<string, string>, name: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) headers[name] = trimmed;
}
