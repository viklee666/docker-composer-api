import { DEFAULT_AUTO_DISABLE_THRESHOLD } from "./key-pool.js";
import { parseModelParamsSpec } from "./model-params.js";
import { DEFAULT_REQUEST_LOG_KEEP } from "./store.js";
import type { AgentMode, GatewayConfig, RoutingStrategy, SystemPromptMode } from "./types.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const gatewayApiKey = optionalString(env.GATEWAY_API_KEY);
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
    cursorSdkDisableSessionResume: booleanValue(env.CURSOR_SDK_DISABLE_SESSION_RESUME, true),
    cursorSdkUseHttp1ForAgent: booleanValue(env.CURSOR_SDK_USE_HTTP1_FOR_AGENT, false),
    cursorPrewarm: booleanValue(env.CURSOR_PREWARM, true),
    cursorAllowBuiltinTools: booleanValue(env.CURSOR_ALLOW_BUILTIN_TOOLS, false),
    maxKeyAttempts: integerValue(env.MAX_KEY_ATTEMPTS, 10),
    maxTransientAttempts: integerValue(env.MAX_TRANSIENT_KEY_ATTEMPTS, 3),
    autoDisableKeys: booleanValue(env.AUTO_DISABLE_KEYS, true),
    autoDisableThreshold: integerValue(env.AUTO_DISABLE_THRESHOLD, DEFAULT_AUTO_DISABLE_THRESHOLD),
    cursorReasoningEffort: optionalString(env.CURSOR_REASONING_EFFORT),
    cursorMaxMode: optionalBoolean(env.CURSOR_MAX_MODE),
    cursorFast: optionalBoolean(env.CURSOR_FAST),
    cursorModelParams: parseModelParamsSpec(env.CURSOR_MODEL_PARAMS),
    cursorAgentMode: optionalAgentMode(env.CURSOR_AGENT_MODE),
    sandClientMode: booleanValue(env.SAND_CLIENT_MODE, false),
    // 默认 fill-first：Cursor 按 key 缓存 prompt，轮询换 key 会丢缓存并放大计费，因此轮询要显式开启。
    routingStrategy: parseRoutingStrategy(env.ROUTING_STRATEGY),
    sessionAffinity: booleanValue(env.SESSION_AFFINITY, true),
    sessionAffinityTtlMs: integerValue(env.SESSION_AFFINITY_TTL_MS, 60 * 60 * 1000),
    proxyUrl: optionalString(env.PROXY_URL),
    systemPromptMode: parseSystemPromptMode(env.SYSTEM_PROMPT_MODE),
    systemPrompt: optionalString(env.SYSTEM_PROMPT)
  };
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
