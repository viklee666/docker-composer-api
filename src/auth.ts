import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { AuthContext, GatewayConfig } from "./types.js";

export function authenticate(request: FastifyRequest, config: GatewayConfig): AuthContext {
  const token = bearerToken(request) ?? headerString(request, "x-api-key");
  if (token && config.gatewayApiKey && token === config.gatewayApiKey) {
    // 网关模式不在此处固定 key，由 KeyRotatingRunner 在运行时从密钥池解析。
    return {
      mode: "gateway",
      ownerHash: sha256(`gateway:${config.gatewayApiKey}`)
    };
  }

  if (token && config.allowDirectCursorKeys) {
    return {
      mode: "direct",
      apiKey: token,
      ownerHash: sha256(`direct:${token}`)
    };
  }

  throw new ApiError("Missing or invalid API key.", 401, "unauthorized");
}

/** 从 Authorization Bearer 或 x-api-key 头提取 token。 */
export function extractToken(request: FastifyRequest): string | undefined {
  return bearerToken(request) ?? headerString(request, "x-api-key");
}

export function sessionAffinity(request: FastifyRequest, fallback: string): string {
  return (
    headerString(request, "x-session-affinity") ??
    headerString(request, "x-opencode-session-id") ??
    headerString(request, "x-opencode-session") ??
    headerString(request, "anthropic-session-id") ??
    fallback
  );
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = headerString(request, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1]?.trim() || undefined;
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.find(Boolean)?.trim() || undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
