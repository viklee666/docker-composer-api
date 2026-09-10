import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { DEFAULT_BOT_BASE_URL, methodUrl } from "./client.js";
import { buildConnectHeaders, NETWORK_TOKEN_HEADER, type ConnectCodec } from "./headers.js";
import { EnsureSandBoxRequest, EnsureSandBoxResponse, SandBoxRunState } from "./proto/grokbot_service_pb.js";
import { postConnectUnary, type ConnectFetch } from "./transport.js";
import type { CursorBotCredential } from "./credentials.js";

/**
 * Box relay 连接层（plans/box-relay-automation.md P1/P2）。
 *
 * 0.44 起推理直连 api2 要求 Box 内部 token，唯一出口是经 Box relay：
 *   POST {gatewayUrl}/sand-stream-relay/aiserver.v1.InferenceService/Stream
 *   鉴权 Bearer gatewayToken + 头 x-anyrun-network-token。
 *
 * 三样连接材料与桌面端同源：`GrokBotService/EnsureSandBox`（api2、session JWT、
 * 空请求体——桌面端 `ensureSandBox({})` 同款）。字段号见
 * docs/reference/grokbot-service-descriptor.txt。
 */

export const GROKBOT_SERVICE = "aiserver.v1.GrokBotService";
export const ENSURE_SANDBOX_METHOD = "EnsureSandBox";

/** relay 路由前缀（Box 侧 host 补丁约定的挂载点，v135 同款）。 */
export const RELAY_PATH_PREFIX = "/sand-stream-relay";

/** EnsureSandBox 之后的重取冷却：上游连续拒绝时不逐请求回源（桌面端同语义，取更短值）。 */
const REFRESH_COOLDOWN_MS = 60_000;

export interface BoxRelayConnection {
  gatewayUrl: string;
  gatewayToken: string;
  networkToken: string;
  runState: SandBoxRunState;
  /** 簿记字段，不参与相等性判断用途。 */
  fetchedAt: number;
}

export interface EnsureBoxConnectionOptions {
  /** api2 基址（EnsureSandBox 走直连，不进 relay）。默认 `https://api2.cursor.sh`。 */
  baseUrl?: string;
  codec?: ConnectCodec;
  fetchImpl?: ConnectFetch;
  signal?: AbortSignal;
  /** 测试注入固定时间，让 checksum 可断言。 */
  nowMs?: () => number;
}

/**
 * 调 `GrokBotService/EnsureSandBox` 拿 Box 连接三件套。
 *
 * 与目录（AiService/AvailableModels）同一鉴权族：session JWT + 标准 sand 头，
 * 一元 proto 编码。冷启动可能触发建 Box（秒~分钟级），超时交给调用方的 signal。
 */
export async function ensureBoxConnection(
  credential: CursorBotCredential,
  options: EnsureBoxConnectionOptions = {}
): Promise<BoxRelayConnection> {
  const payload = new EnsureSandBoxRequest({}).toBinary();
  const raw = await postConnectUnary({
    url: methodUrl(
      options.baseUrl?.trim() || DEFAULT_BOT_BASE_URL,
      GROKBOT_SERVICE,
      ENSURE_SANDBOX_METHOD
    ),
    headers: buildConnectHeaders({
      credential,
      codec: options.codec ?? "proto",
      kind: "unary",
      nowMs: options.nowMs?.()
    }),
    body: payload,
    signal: options.signal,
    fetchImpl: options.fetchImpl
  });

  const response = EnsureSandBoxResponse.fromBinary(raw);
  const gatewayUrl = response.gatewayUrl.trim();
  const gatewayToken = response.gatewayToken.trim();
  const networkToken = response.networkToken.trim();
  if (!gatewayUrl.startsWith("https://") || !gatewayToken || !networkToken) {
    throw new ApiError(
      "EnsureSandBox 响应缺少 gatewayUrl/gatewayToken/networkToken（后端行为变化？）",
      502,
      "upstream_error"
    );
  }
  return {
    gatewayUrl,
    gatewayToken,
    networkToken,
    runState: response.runState,
    fetchedAt: Date.now()
  };
}

/** relay 模式下推理出口的 baseUrl（client.methodUrl 会在其后拼 service/method）。 */
export function relayInferenceBaseUrl(connection: BoxRelayConnection): string {
  return connection.gatewayUrl.replace(/\/+$/, "") + RELAY_PATH_PREFIX;
}

/** relay 模式下注入的出站头（路由必需，缺了 gateway 会 404 "could not be routed"）。 */
export function relayExtraHeaders(connection: BoxRelayConnection): Record<string, string> {
  return { [NETWORK_TOKEN_HEADER]: connection.networkToken };
}

/**
 * 按凭据分片的连接缓存。
 *
 * - 单飞：同凭据并发请求只回源一次（对齐目录的 inflight 模式）；
 * - 失效驱动刷新：不设 TTL——Box 重启/网关轮换表现为 401/403/连不上，由调用方
 *   `invalidate` 后重取拿新连接（新 gatewayUrl），比定时刷新少一半状态；
 * - 冷却：一次失败后 60s 内不再回源，避免凭据坏了把 EnsureSandBox 打成逐请求回源。
 */
export class BoxRelayConnectionManager {
  private readonly cache = new Map<string, BoxRelayConnection>();
  private readonly inflight = new Map<string, Promise<BoxRelayConnection>>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly lastError = new Map<string, unknown>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(credential: CursorBotCredential, options: EnsureBoxConnectionOptions = {}): Promise<BoxRelayConnection> {
    const cached = this.cache.get(credential.id);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(credential.id);
    if (running) return running;

    const blockedUntil = this.blockedUntil.get(credential.id) ?? 0;
    if (this.now() < blockedUntil) {
      return Promise.reject(
        new ApiError(
          `Box 连接处于失败冷却期（${Math.ceil((blockedUntil - this.now()) / 1000)}s 后重试）：${errorText(
            this.lastError.get(credential.id)
          )}`,
          502,
          "upstream_error"
        )
      );
    }

    const pending = ensureBoxConnection(credential, options)
      .then((connection) => {
        this.cache.set(credential.id, connection);
        this.blockedUntil.delete(credential.id);
        this.lastError.delete(credential.id);
        return connection;
      })
      .catch((error: unknown) => {
        this.blockedUntil.set(credential.id, this.now() + REFRESH_COOLDOWN_MS);
        this.lastError.set(credential.id, error);
        throw error;
      })
      .finally(() => {
        this.inflight.delete(credential.id);
      });
    this.inflight.set(credential.id, pending);
    return pending;
  }

  /** 丢弃缓存（401/403/连不上时调用）；inflight 不动——它本来就在取新值。 */
  invalidate(credentialId: string): void {
    this.cache.delete(credentialId);
    // 冷却只拦「回源失败」，不拦失效后的重取。
    this.blockedUntil.delete(credentialId);
    this.lastError.delete(credentialId);
  }

  /** 冷却与最后错误一并清空（凭据更新/测试用）。 */
  reset(credentialId?: string): void {
    if (credentialId === undefined) {
      this.cache.clear();
      this.blockedUntil.clear();
      this.lastError.clear();
      return;
    }
    this.invalidate(credentialId);
  }

  cached(credentialId: string): BoxRelayConnection | undefined {
    return this.cache.get(credentialId);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return typeof error === "string" ? error.slice(0, 160) : "未知错误";
}
