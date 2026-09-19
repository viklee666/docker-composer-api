import { DEFAULT_BOT_BASE_URL } from "./cursor-bot/client.js";
import { DEFAULT_READ_MAX_BYTES } from "./cursor-bot/envelope.js";
import { DEFAULT_AUTO_DISABLE_THRESHOLD } from "./key-pool.js";
import { parseModelParamPolicyEnv } from "./model-param-policy.js";
import { parseModelParamsSpec } from "./model-params.js";
import { DEFAULT_REQUEST_LOG_KEEP } from "./store.js";
import type {
  AgentMode,
  CursorSdkSessionMode,
  GatewayConfig,
  GatewayProvider,
  RoutingStrategy,
  SystemPromptMode
} from "./types.js";

/** 挂起工具 execute 的默认等待（15min）。env: CURSOR_SDK_TOOL_HOLD_TTL_MS。 */
export const DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS = 900_000;
/** 客户端委派工具（Task 等）的默认 hold 等待（60min）。env: CURSOR_SDK_DELEGATE_HOLD_TTL_MS。 */
export const DEFAULT_CURSOR_SDK_DELEGATE_HOLD_TTL_MS = 3_600_000;
/** durable 空闲 agent 默认回收阈值（60min）。env: CURSOR_SDK_SESSION_IDLE_TTL_MS。 */
export const DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS = 3_600_000;
/** SessionHub / 共享内存 store 默认同时存活会话上限。env: CURSOR_SDK_MAX_LIVE_SESSIONS。 */
export const DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS = 256;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const gatewayApiKey = optionalString(env.GATEWAY_API_KEY);
  // 默认 false：新部署走 durable。true 是 kill switch，重启后回到今日 create+全文+假成功+cancel+dispose。
  const cursorSdkDisableSessionResume = booleanValue(env.CURSOR_SDK_DISABLE_SESSION_RESUME, false);
  const requestedSessionMode = parseSessionMode(env.CURSOR_SDK_SESSION_MODE);
  return {
    host: stringValue(env.HOST, "0.0.0.0"),
    port: integerValue(env.PORT, 8787),
    cursorApiKeys: parseKeyList(env.CURSOR_API_KEYS, env.CURSOR_API_KEY),
    gatewayApiKey,
    adminPassword: optionalString(env.ADMIN_PASSWORD) ?? gatewayApiKey,
    allowDirectCursorKeys: booleanValue(env.ALLOW_DIRECT_CURSOR_KEYS, true),
    sqlitePath: stringValue(env.SQLITE_PATH, "./data/state.sqlite"),
    requestLogKeep: nonNegativeIntegerValue(env.REQUEST_LOG_KEEP, DEFAULT_REQUEST_LOG_KEEP),
    cursorWorkingDirectory: stringValue(env.CURSOR_WORKING_DIRECTORY, process.cwd()),
    requestTimeoutMs: integerValue(env.REQUEST_TIMEOUT_MS, 180_000),
    sdkClientVersion: stringValue(env.CURSOR_SDK_CLIENT_VERSION, "sdk-1.0.27"),
    cursorSdkDisableSessionResume,
    // kill switch 打开时强制 stateless，即使 env 写了 durable。
    cursorSdkSessionMode: cursorSdkDisableSessionResume ? "stateless" : requestedSessionMode,
    cursorSdkToolHoldTtlMs: integerValue(env.CURSOR_SDK_TOOL_HOLD_TTL_MS, DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS),
    cursorSdkDelegateHoldTtlMs: integerValue(env.CURSOR_SDK_DELEGATE_HOLD_TTL_MS, DEFAULT_CURSOR_SDK_DELEGATE_HOLD_TTL_MS),
    cursorSdkSessionIdleTtlMs: integerValue(env.CURSOR_SDK_SESSION_IDLE_TTL_MS, DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS),
    cursorSdkMaxLiveSessions: integerValue(env.CURSOR_SDK_MAX_LIVE_SESSIONS, DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS),
    cursorSdkUseHttp1ForAgent: booleanValue(env.CURSOR_SDK_USE_HTTP1_FOR_AGENT, false),
    cursorPrewarm: booleanValue(env.CURSOR_PREWARM, true),
    cursorAllowBuiltinTools: booleanValue(env.CURSOR_ALLOW_BUILTIN_TOOLS, false),
    maxKeyAttempts: integerValue(env.MAX_KEY_ATTEMPTS, 10),
    maxTransientAttempts: integerValue(env.MAX_TRANSIENT_KEY_ATTEMPTS, 3),
    autoDisableKeys: booleanValue(env.AUTO_DISABLE_KEYS, true),
    autoDisableThreshold: integerValue(env.AUTO_DISABLE_THRESHOLD, DEFAULT_AUTO_DISABLE_THRESHOLD),
    cursorReasoningEffort: optionalString(env.CURSOR_REASONING_EFFORT),
    cursorMaxModePolicy: parseModelParamPolicyEnv(env.CURSOR_MAX_MODE, env.CURSOR_MAX_MODE_MODELS),
    cursorFastPolicy: parseModelParamPolicyEnv(env.CURSOR_FAST, env.CURSOR_FAST_MODELS),
    cursorModelParams: parseModelParamsSpec(env.CURSOR_MODEL_PARAMS),
    cursorAgentMode: optionalAgentMode(env.CURSOR_AGENT_MODE),
    // 默认 fill-first：Cursor 按 key 缓存 prompt，轮询换 key 会丢缓存并放大计费，因此轮询要显式开启。
    routingStrategy: parseRoutingStrategy(env.ROUTING_STRATEGY),
    sessionAffinity: booleanValue(env.SESSION_AFFINITY, true),
    sessionAffinityTtlMs: integerValue(env.SESSION_AFFINITY_TTL_MS, 60 * 60 * 1000),
    proxyUrl: optionalString(env.PROXY_URL),
    systemPromptMode: parseSystemPromptMode(env.SYSTEM_PROMPT_MODE),
    systemPrompt: optionalString(env.SYSTEM_PROMPT),
    // 默认开：Cursor 空轮次（(no content) 占位）不再打到上游。对照需要关时 .env 写 false。
    dropEmptyDurableTurns: booleanValue(env.DROP_EMPTY_DURABLE_TURNS, true),
    /**
     * 严格模式：内容推导身份（derived-L3）不进 durable Hub，一律 stateless。
     * 默认关（推导身份照常复用槽）。无显式会话 id 的客户端（如 cursor-byok）没有会话边界
     * 保证，同仓库 + 同模板 prompt 的并发会话会推导出同一个 Hub 键互串内容；开着本开关
     * 即牺牲这类客户端的 durable 缓存换零串扰，带显式 id 的客户端不受影响。
     * env: DURABLE_REQUIRE_EXPLICIT_ID。
     */
    durableRequireExplicitId: booleanValue(env.DURABLE_REQUIRE_EXPLICIT_ID, false),

    // Cursor Bot 路线。默认全关 / 全保守：这条路线还没跑过真实流量，
    // 默认接管流量或默认开工具都会让一次配置失误直接打到生产请求上。
    defaultProvider: parseProvider(env.GATEWAY_PROVIDER),
    botBaseUrl: stringValue(env.CURSOR_BOT_BASE_URL, DEFAULT_BOT_BASE_URL),
    botCodec: env.CURSOR_BOT_CODEC?.trim().toLowerCase() === "json" ? "json" : "proto",
    botReadMaxBytes: integerValue(env.CURSOR_BOT_MAX_FRAME_BYTES, DEFAULT_READ_MAX_BYTES),
    botSendTools: booleanValue(env.CURSOR_BOT_SEND_TOOLS, false),
    botLocalTools: parseList(env.CURSOR_BOT_LOCAL_TOOLS),
    botSubagents: booleanValue(env.CURSOR_BOT_SUBAGENTS, false),
    botBackground: booleanValue(env.CURSOR_BOT_BACKGROUND, false),
    botSessionToken: optionalString(env.CURSOR_BOT_TOKEN),
    botMachineId: optionalString(env.CURSOR_BOT_MACHINE_ID),
    botClientVersion: stringValue(env.CURSOR_BOT_CLIENT_VERSION, DEFAULT_BOT_CLIENT_VERSION),
    // Box relay 场景：注入 x-anyrun-network-token 等路由凭据（JSON 对象，键值都是字符串）。
    // 解析失败按空处理并告警——一个写错的 env 不该让网关起不来。
    botExtraHeaders: parseExtraHeaders(env.CURSOR_BOT_EXTRA_HEADERS),
    // 推理出口：relay = 经 Box relay（自动 EnsureSandBox）；direct = api2 直连。
    // 直连恢复后可用，但不能把 tools[] 写进上游（会 resource_exhausted）。
    botInferenceRoute: env.CURSOR_BOT_INFERENCE_ROUTE?.trim().toLowerCase() === "relay" ? "relay" : "direct",
    // 由 Key 兑换的 session JWT 约 1 小时过期；默认到期前自动再兑。粘贴的桌面端 token 不走这条。
    botAutoRefreshFromKey: booleanValue(env.CURSOR_BOT_AUTO_REFRESH_FROM_KEY, true),

    // Debug 快照（包 D）：env 只做总开关与上限默认值，过滤条件与运行期开关走 gateway-settings。
    // 默认关：全量落盘会把请求原文（含 prompt）写进磁盘，必须显式开启。
    debugEnabled: booleanValue(env.GATEWAY_DEBUG, false),
    debugMaxEntries: nonNegativeIntegerValue(env.GATEWAY_DEBUG_MAX_ENTRIES, 2_000),
    debugMaxTotalBytes: nonNegativeIntegerValue(env.GATEWAY_DEBUG_MAX_TOTAL_BYTES, 200 * 1024 * 1024)
  };
}

/** 播种凭据的默认客户端版本。与本地 Cursor 一致，便于上游按版本识别。 */
export const DEFAULT_BOT_CLIENT_VERSION = "3.18.9";

/**
 * 解析 `CURSOR_BOT_EXTRA_HEADERS`（JSON 对象，string→string）。
 * 非 JSON / 非对象 / 值非字符串的条目一律丢弃——额外头是逃生舱不是核心配置，
 * 写错时降级为「不注入」比让网关拒绝启动更可运维（请求会拿到清晰的 404/401 再回来排查）。
 */
function parseExtraHeaders(value: string | undefined): Record<string, string> {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[config] CURSOR_BOT_EXTRA_HEADERS 不是 JSON 对象，已忽略");
      return {};
    }
    const result: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (name.trim() && typeof headerValue === "string" && headerValue.trim()) {
        result[name.trim()] = headerValue.trim();
      }
    }
    return result;
  } catch {
    console.warn("[config] CURSOR_BOT_EXTRA_HEADERS 不是合法 JSON，已忽略");
    return {};
  }
}

function parseProvider(value: string | undefined): GatewayProvider {
  // "connect" / "cursor-connect" 是改名前的旧值（env 里可能残留），仅读侧承认，对外一律产出 "bot"。
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "bot" || trimmed === "cursor-bot" || trimmed === "connect" || trimmed === "cursor-connect" ? "bot" : "sdk";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]/)    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 环境变量里对 HTTP/1.1 的表态，未设置时是 undefined。
 * `cursorSdkUseHttp1ForAgent` 字段本身只能是布尔，而 `booleanValue` 把「没设过」和
 * 「显式写了 false」压成同一个 false——这两者在代理场景下的处置完全相反：
 * 没设过时代理有资格把开关顶上去（否则模型流量绕过代理直连），
 * 显式关掉则是运维已经知情并选了直连，网关不能替他改回来。
 */
export function readCursorSdkUseHttp1Preference(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return optionalBoolean(env.CURSOR_SDK_USE_HTTP1_FOR_AGENT);
}

function parseRoutingStrategy(value: string | undefined): RoutingStrategy {
  return value?.trim().toLowerCase() === "round-robin" ? "round-robin" : "fill-first";
}

/**
 * 未设置或取值非法时按 durable。显式 `stateless` 仍有效。
 * kill switch 的覆盖在 loadConfig 里做，这里只解析 env 字面量。
 */
function parseSessionMode(value: string | undefined): CursorSdkSessionMode {
  return value?.trim().toLowerCase() === "stateless" ? "stateless" : "durable";
}

/**
 * WP3/WP4 接线：是否应构建 SessionHub。
 * kill switch 打开 → false（今日路径）。只有 kill switch 关闭且 mode=durable 才 true。
 */
export function shouldUseDurableHub(config: Pick<GatewayConfig, "cursorSdkDisableSessionResume" | "cursorSdkSessionMode">): boolean {
  return !config.cursorSdkDisableSessionResume && config.cursorSdkSessionMode === "durable";
}

/** 未设置或取值非法时按 off 处理：不注入默认系统提示词，保持既有行为。 */
function parseSystemPromptMode(value: string | undefined): SystemPromptMode {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "append" || trimmed === "override" ? trimmed : "off";
}

/** CURSOR_API_KEYS 支持逗号/分号/换行分隔；CURSOR_API_KEY 兼容旧的单 key 配置。 */
function parseKeyList(multi: string | undefined, single: string | undefined): string[] {
  const keys = (multi ?? "")
    .split(/[,;\n]/)
    .map((key) => key.trim())
    .filter(Boolean);
  const legacy = optionalString(single);
  if (legacy && !keys.includes(legacy)) keys.unshift(legacy);
  return [...new Set(keys)];
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringValue(value: string | undefined, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function integerValue(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 接受 0 的整数解析。`integerValue` 要求 > 0（端口、超时这类设置写 0 只能是笔误），
 * 而「不设上限」这个语义恰恰只能用 0 表达，所以单独一个解析函数而不是放宽那边的下界。
 */
function nonNegativeIntegerValue(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** 未设置时返回 undefined（不覆盖客户端/模型默认）；设置时按常见真假词解析。 */
function optionalBoolean(value: string | undefined): boolean | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return !["0", "false", "no", "off"].includes(trimmed);
}

function optionalAgentMode(value: string | undefined): AgentMode | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "agent" || trimmed === "plan" ? trimmed : undefined;
}
