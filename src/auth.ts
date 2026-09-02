import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { explicitSessionIdFromHeaders } from "./durable-id.js";
import { ApiError } from "./errors.js";
import type { AuthContext, GatewayConfig, GatewayKeyRecord } from "./types.js";

/**
 * 多密钥模式的同步解析器，由 GatewayKeyPool 的内存快照提供。
 * 之所以是同步：authenticate 是八个路由处理器的第一行调用，改成 async 会波及所有端点，
 * 还会给每个请求加一次 SQLite 读。
 */
export interface AuthResolvers {
  /** 只返回 active 的网关密钥（GatewayKeyPool.resolve）。 */
  resolveGatewayKey?: (token: string) => GatewayKeyRecord | undefined;
  /** 含 disabled 的全量解析（GatewayKeyPool.resolveAny），用于把已停用的密钥判成 401。 */
  resolveAnyGatewayKey?: (token: string) => GatewayKeyRecord | undefined;
}

export function authenticate(
  request: FastifyRequest,
  config: GatewayConfig,
  resolvers?: AuthResolvers
): AuthContext {
  const token = extractToken(request);
  if (!token) throw new ApiError("Missing or invalid API key.", 401, "unauthorized");

  const gatewayKey = resolvers?.resolveGatewayKey?.(token);
  if (gatewayKey) return gatewayKeyContext(gatewayKey, config);

  // 停用的密钥必须就地 401，不能继续往下走：
  // 落到 direct 分支会被当成「客户端自带的 Cursor key」原样发给上游，停用等于没停用；
  // 落到 legacy 分支同理——env 播种进表后又被后台停用的主密钥若还能从 config.gatewayApiKey 走通，
  // 后台那个停用按钮就是个摆设。
  const known = resolvers?.resolveAnyGatewayKey?.(token);
  if (known?.status === "disabled") {
    throw new ApiError("This gateway API key is disabled.", 401, "unauthorized");
  }

  if (config.gatewayApiKey && token === config.gatewayApiKey) {
    if (resolvers?.resolveGatewayKey || resolvers?.resolveAnyGatewayKey) {
      // 接入网关密钥池后，配置值也必须有一条 active 记录；否则删除同值的 manual 记录
      // 会从这里绕回旧兼容分支，出现接口报成功但凭据仍可用的假删除。
      throw new ApiError("Missing or invalid API key.", 401, "unauthorized");
    }
    // 网关模式不在此处固定 key，由 KeyRotatingRunner 在运行时从密钥池解析。
    return {
      mode: "gateway",
      ownerHash: legacyOwnerHash(config.gatewayApiKey)
    };
  }

  if (config.allowDirectCursorKeys) {
    return {
      mode: "direct",
      apiKey: token,
      ownerHash: sha256(`direct:${token}`)
    };
  }

  throw new ApiError("Missing or invalid API key.", 401, "unauthorized");
}

/** 空的限制列表一律不写进 AuthContext：下游按 undefined 判「不限制」，写个空数组会被误读成「什么都不许用」。 */
function gatewayKeyContext(record: GatewayKeyRecord, config: GatewayConfig): AuthContext {
  const allowedCursorKeyIds = record.allowedCursorKeyIds ?? [];
  const scope = record.modelScope;
  const restrictsModels = Boolean(scope?.allowed.length || scope?.excluded.length);
  return {
    mode: "gateway",
    ownerHash: gatewayKeyOwnerHash(record, config),
    gatewayKeyId: record.id,
    gatewayKeyLabel: record.label,
    // 拷贝而非直接引用密钥池快照里的数组，避免下游改动反噬内存快照。
    ...(allowedCursorKeyIds.length ? { allowedCursorKeyIds: [...allowedCursorKeyIds] } : {}),
    ...(restrictsModels && scope
      ? { modelScope: { allowed: [...scope.allowed], excluded: [...scope.excluded] } }
      : {})
  };
}

/**
 * ownerHash 是 /v1/responses 唯一的数据隔离边界（responses.owner_hash）。
 * 多密钥按密钥 id 派生，各入站密钥的存储互相隔离。
 * 例外是 env 播种进来、值仍等于 config.gatewayApiKey 的那把主密钥：
 * 它在启用多密钥表之前存下的 response 全挂在 legacy 哈希下，改用 per-key 哈希的话，
 * 运维「只是打开了新表」就会让全部历史 response 失联，因此这一把继续沿用 legacy 哈希。
 */
function gatewayKeyOwnerHash(record: GatewayKeyRecord, config: GatewayConfig): string {
  if (record.source === "env" && config.gatewayApiKey && record.apiKey === config.gatewayApiKey) {
    return legacyOwnerHash(config.gatewayApiKey);
  }
  return sha256(`gateway-key:${record.id}`);
}

/** 单密钥时代的 owner 口径，逐字节保持不变，否则老数据全部读不回来。 */
function legacyOwnerHash(gatewayApiKey: string): string {
  return sha256(`gateway:${gatewayApiKey}`);
}

/** 从 Authorization Bearer 或 x-api-key 头提取 token。 */
export function extractToken(request: FastifyRequest): string | undefined {
  return bearerToken(request) ?? headerString(request, "x-api-key");
}

export function sessionAffinity(request: FastifyRequest, fallback: string): string {
  return explicitSessionId(request) ?? fallback;
}

/**
 * 只认客户端显式给出的会话标识，认不出就返回 undefined。
 * 会话粘性必须用这个而不是 sessionAffinity：后者会退化成调用方传的 fallback
 * （网关模式下是所有请求共享的 ownerHash），用它做绑定等于把整个网关钉死在一把 key 上。
 */
export function explicitSessionId(request: FastifyRequest): string | undefined {
  return explicitSessionIdFromHeaders(request.headers);
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
