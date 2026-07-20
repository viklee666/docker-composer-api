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

export function openAiError(error: unknown): Record<string, unknown> {
  const apiError = normalizeError(error);
  return {
    error: {
      message: apiError.message,
      type: apiError.code,
      param: apiError.param ?? null,
      code: apiError.code
    }
  };
}

export function anthropicError(error: unknown): Record<string, unknown> {
  const apiError = normalizeError(error);
  return {
    type: "error",
    error: {
      type: anthropicErrorType(apiError.statusCode, apiError.code),
      message: apiError.message
    }
  };
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError(error.message, 500, "internal_error");
  return new ApiError("Unexpected error", 500, "internal_error");
}

function anthropicErrorType(statusCode: number, code: string): string {
  if (statusCode === 401) return "authentication_error";
  if (statusCode === 403) return "permission_error";
  if (statusCode === 404) return "not_found_error";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode >= 500) return "api_error";
  if (code === "unsupported_parameter") return "invalid_request_error";
  return "invalid_request_error";
}
