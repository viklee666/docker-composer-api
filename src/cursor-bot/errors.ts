import { ApiError } from "../errors.js";
import { EnvelopeTooLargeError, TruncatedEnvelopeError } from "./envelope.js";
import { InferenceStreamErrorType, type InferenceStreamError } from "./proto/inference_pb.js";

/**
 * Connect 的 16 个错误码。流式响应即使出错也常常是 HTTP 200 + endStream 帧里带 error，
 * 所以「HTTP 状态」和「Connect code」是两条独立的错误路径，两条都要能落到同一套对外错误上。
 */
export type ConnectCode =
  | "canceled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data_loss"
  | "unauthenticated";

const CONNECT_CODE_STATUS: Record<ConnectCode, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401
};

// 刻意没有反向的 status → ConnectCode 表：Connect 规范那张表是有损的
// （429 与 502/503/504 都归到 unavailable），把 HTTP 状态往返一遍会丢掉重试语义。
// HTTP 层失败直接用状态码（见 httpTransportError），Connect code 只在 endStream 那条路径上用。

/** endStream 帧的 JSON 体：`{metadata?, error?}`，error 缺席即正常收流。 */
export interface EndStreamResponse {
  metadata?: Record<string, string[]>;
  error?: { code?: string; message?: string; details?: unknown[] };
}

export function isConnectCode(value: string): value is ConnectCode {
  return Object.hasOwn(CONNECT_CODE_STATUS, value);
}

export function connectCodeToStatus(code: string): number {
  return isConnectCode(code) ? CONNECT_CODE_STATUS[code] : 500;
}

/**
 * 空 payload 是正常收尾。非空但解析不出来的 payload **不能**当成正常收尾——
 * 那里本来可能装着 error，静默吞掉会把一次失败的请求变成一个内容截断的成功响应。
 */
export function parseEndStream(payload: Uint8Array): EndStreamResponse {
  const text = Buffer.from(payload).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as EndStreamResponse;
  } catch {
    // 落到下面的兜底。
  }
  return { error: { code: "internal", message: "Cursor Connect sent an unreadable end-of-stream frame." } };
}

/** endStream 里的 error → 对外错误。code 缺失按 unknown。 */
export function endStreamError(error: NonNullable<EndStreamResponse["error"]>): ApiError {
  const code = error.code?.trim() || "unknown";
  const status = connectCodeToStatus(code);
  const detail = error.message?.trim() ?? "";
  // 上游经常只回一个 `"Error"`，对运维毫无信息量。始终带上 Connect code：
  // 「unauthenticated」比「Error」能直接指向该换 token 这件事。
  const message = detail && detail.toLowerCase() !== "error" ? `${detail} (connect: ${code})` : `Cursor Connect rejected the request: ${code}`;
  return new ApiError(message, status, apiErrorCode(status));
}

/**
 * `InferenceStreamError.error_type` → 对外错误。
 * 枚举值来自 descriptor（`InferenceStreamErrorType`），映射到状态码这一步是网关自己的口径。
 * `is_input_token_limit_error` / `is_output_token_limit_error` 是 error_type 之外的第二路信号，
 * 老服务端可能只置布尔不置枚举，所以两路都认。
 */
export function inferenceStreamError(error: InferenceStreamError): ApiError {
  const message = error.message?.trim() || "Cursor inference failed.";
  if (error.isInputTokenLimitError || error.errorType === InferenceStreamErrorType.INPUT_TOKEN_LIMIT) {
    return new ApiError(message, 400, "context_length_exceeded");
  }
  if (error.isOutputTokenLimitError || error.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT) {
    return new ApiError(message, 400, "context_length_exceeded");
  }
  switch (error.errorType) {
    case InferenceStreamErrorType.RATE_LIMIT:
      return new ApiError(message, 429, "rate_limit_exceeded");
    case InferenceStreamErrorType.AUTHENTICATION:
      return new ApiError(message, 401, "unauthorized");
    case InferenceStreamErrorType.PERMISSION:
      return new ApiError(message, 403, "forbidden");
    case InferenceStreamErrorType.OVERLOADED:
      // 529 而不是 503：errors.ts 的 anthropicErrorType 只在 529 上给 overloaded_error。
      return new ApiError(message, 529, "overloaded");
    case InferenceStreamErrorType.CONTENT_FILTER:
      return new ApiError(message, 400, "content_policy_violation");
    default:
      return new ApiError(message, 500, "upstream_error");
  }
}

/**
 * envelope 层的结构性失败 → 对外错误。
 *
 * 不把内部消息透给调用方：`EnvelopeTooLargeError` 的原文带着网关自己的 `readMaxBytes`，
 * 而且不经过这里的话 `normalizeError()` 会把它归成 500 `internal_error`——
 * 那是在说"网关坏了"，实际是上游发来的响应不可用。
 *
 * 不是 envelope 错误时返回 undefined，交给调用方原样上抛。
 */
export function envelopeError(error: unknown): ApiError | undefined {
  if (error instanceof EnvelopeTooLargeError) {
    return new ApiError(
      "Cursor Connect response frame exceeded the gateway size limit.",
      502,
      "upstream_error"
    );
  }
  if (error instanceof TruncatedEnvelopeError) {
    return new ApiError("Cursor Connect stream ended mid-frame.", 502, "upstream_error");
  }
  return undefined;
}

/**
 * HTTP 层就失败（还没进流）时的错误。
 *
 * 状态码**原样透传**，不绕道 Connect code 再换算回来：那条往返是有损的
 * （429→unavailable→503、404→unimplemented→501、400→internal→500），
 * 会把「配额用完」说成「服务不可用」，调用方的重试策略跟着一起错。
 * Connect code 只在 endStream 那条路径上有意义——那里根本没有 HTTP 状态可用。
 *
 * body 只截前若干字节，避免把上游整页 HTML 灌进日志。
 */
export function httpTransportError(status: number, bodyText: string): ApiError {
  const outward = status >= 400 && status <= 599 ? status : 502;
  const detail = bodyText.trim().slice(0, 400);
  const message = detail
    ? `Cursor Connect request failed (HTTP ${status}): ${detail}`
    : `Cursor Connect request failed (HTTP ${status}).`;
  return new ApiError(message, outward, apiErrorCode(outward));
}

/** 对齐 src/errors.ts 的 codeForStatus 口径，避免同一状态在两条 provider 上给出不同 code。 */
function apiErrorCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 499) return "request_aborted";
  if (status === 504) return "timeout_error";
  return status >= 500 ? "upstream_error" : "invalid_request_error";
}
