import { DEFAULT_AUTO_DISABLE_THRESHOLD } from "./key-pool.js";
import { parseModelParamsSpec } from "./model-params.js";
import type { AgentMode, GatewayConfig } from "./types.js";

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
    cursorWorkingDirectory: stringValue(env.CURSOR_WORKING_DIRECTORY, process.cwd()),
    requestTimeoutMs: integerValue(env.REQUEST_TIMEOUT_MS, 180_000),
    sdkClientVersion: stringValue(env.CURSOR_SDK_CLIENT_VERSION, "sdk-1.0.27"),
    cursorSdkDisableSessionResume: booleanValue(env.CURSOR_SDK_DISABLE_SESSION_RESUME, true),
    cursorSdkUseHttp1ForAgent: booleanValue(env.CURSOR_SDK_USE_HTTP1_FOR_AGENT, false),
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
    sandClientMode: booleanValue(env.SAND_CLIENT_MODE, false)
  };
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
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
