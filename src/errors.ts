import { randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "invalid_request_error",
    readonly param?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * OpenAI 官方 error.type taxonomy：只有 5 个大类，具体语义留在 code 字段里。
 * 499（客户端断连/空闲超时）对外按服务端错误表达——它不是客户端能修的请求错误。
 */
export function openAiErrorType(statusCode: number): string {
  if (statusCode === 401) return "authentication_error";
  if (statusCode === 403) return "permission_error";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode === 499 || statusCode >= 500) return "server_error";
  return "invalid_request_error";
}

/** OpenAI 端点没有 402：直传 key 的额度错误按官方语义映射成 429 + insufficient_quota。 */
export function openAiStatus(statusCode: number): number {
  return statusCode === 402 ? 429 : statusCode;
}

/** 错误信封里的 error 对象，HTTP 响应体与流内错误事件共用同一形状。 */
export function openAiErrorPayload(error: unknown): Record<string, unknown> {
  const apiError = normalizeError(error);
  const quota = apiError.statusCode === 402;
  return {
    message: apiError.message,
    type: openAiErrorType(openAiStatus(apiError.statusCode)),
    param: apiError.param ?? null,
    code: quota ? "insufficient_quota" : apiError.code
  };
}

export function openAiError(error: unknown): Record<string, unknown> {
  return { error: openAiErrorPayload(error) };
}

export function anthropicError(error: unknown, requestId: string = newRequestId()): Record<string, unknown> {
  const apiError = normalizeError(error);
  return {
    type: "error",
    error: {
      type: anthropicErrorType(apiError.statusCode),
      message: apiError.message
    },
    request_id: requestId
  };
}

export function newRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

/**
 * 让一个 promise 可被 AbortSignal 打断（abort → 499 request_aborted）。
 * 上游 SDK 的个别调用可能既不 settle 也不感知 signal（传输层挂死），
 * 竞速保证请求级超时/断连始终能收尾，请求不会永久悬挂堆积。
 * 输掉竞速的 promise 会附加空 catch，防止其迟到的 rejection 变成 unhandledRejection。
 */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new ApiError("Request was aborted.", 499, "request_aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(new ApiError("Request was aborted.", 499, "request_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export function anthropicErrorType(statusCode: number): string {
  if (statusCode === 401) return "authentication_error";
  if (statusCode === 402) return "billing_error";
  if (statusCode === 403) return "permission_error";
  if (statusCode === 404) return "not_found_error";
  if (statusCode === 413) return "request_too_large";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode === 504) return "timeout_error";
  if (statusCode === 529) return "overloaded_error";
  if (statusCode === 499 || statusCode >= 500) return "api_error";
  return "invalid_request_error";
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    // Fastify 用 statusCode 表达 400 JSON 解析失败、413 body 超限等；改写成 500 会误导客户端。
    const status = statusFromError(error);
    if (status) return new ApiError(error.message, status, codeForStatus(status));
    return new ApiError(error.message, 500, "internal_error");
  }
  return new ApiError("Unexpected error", 500, "internal_error");
}

/**
 * 只认 Fastify 自己抛的错误（`FST_` 前缀的 code + statusCode）：400 JSON 解析失败、413 body 超限等。
 * 刻意不认上游 SDK 错误带的 `status`/`statusCode`：把上游状态与原始消息透给客户端，
 * 既会误导它去改自己的 key/URL，也可能带出上游 URL、账号信息等内部细节。
 * 有语义的上游错误都在 cursor-runner / key-pool 里显式转成 ApiError，其余一律 500。
 */
function statusFromError(error: Error): number | undefined {
  const candidate = error as { statusCode?: unknown; code?: unknown };
  if (typeof candidate.code !== "string" || !candidate.code.startsWith("FST_")) return undefined;
  const value = candidate.statusCode;
  if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) return value;
  return undefined;
}

function codeForStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 504) return "timeout_error";
  return status >= 500 ? "internal_error" : "invalid_request_error";
}
