import { parseModelParamsSpec } from "./model-params.js";
import type {
  AgentMode,
  CursorSdkSessionMode,
  ModelParameterValue,
  RoutingStrategy,
  StateStore,
  SystemPromptMode,
  SystemPromptSettings
} from "./types.js";

const MAX_MODE_DEFAULT_SETTING = "cursorMaxModeDefault";
const FAST_DEFAULT_SETTING = "cursorFastDefault";
const AUTO_DISABLE_KEYS_SETTING = "autoDisableKeys";
const AUTO_DISABLE_THRESHOLD_SETTING = "autoDisableThreshold";
const SAND_CLIENT_MODE_SETTING = "sandClientMode";
const ROUTING_STRATEGY_SETTING = "routingStrategy";
const SESSION_AFFINITY_SETTING = "sessionAffinity";
const SESSION_AFFINITY_TTL_SETTING = "sessionAffinityTtlMs";
const SYSTEM_PROMPT_MODE_SETTING = "systemPromptMode";
const SYSTEM_PROMPT_TEXT_SETTING = "systemPromptText";
const SESSION_MODE_SETTING = "cursorSdkSessionMode";
const ALLOW_DIRECT_CURSOR_KEYS_SETTING = "allowDirectCursorKeys";
const REQUEST_TIMEOUT_MS_SETTING = "requestTimeoutMs";
const REQUEST_LOG_KEEP_SETTING = "requestLogKeep";
const ALLOW_BUILTIN_TOOLS_SETTING = "cursorAllowBuiltinTools";
const TOOL_HOLD_TTL_SETTING = "cursorSdkToolHoldTtlMs";
const SESSION_IDLE_TTL_SETTING = "cursorSdkSessionIdleTtlMs";
const MAX_LIVE_SESSIONS_SETTING = "cursorSdkMaxLiveSessions";
const MAX_KEY_ATTEMPTS_SETTING = "maxKeyAttempts";
const MAX_TRANSIENT_ATTEMPTS_SETTING = "maxTransientKeyAttempts";
const REASONING_EFFORT_SETTING = "cursorReasoningEffort";
const AGENT_MODE_SETTING = "cursorAgentMode";
const MODEL_PARAMS_SETTING = "cursorModelParams";

/** 后台可改整数项的合法区间。保存与加载共用，避免一边放行一边读回来被丢掉。 */
export const RUNTIME_SETTING_BOUNDS = {
  requestTimeoutMs: { min: 5_000, max: 3_600_000 },
  requestLogKeep: { min: 0, max: 10_000_000 },
  toolHoldTtlMs: { min: 1_000, max: 86_400_000 },
  idleTtlMs: { min: 10_000, max: 7 * 86_400_000 },
  maxLiveSessions: { min: 1, max: 10_000 },
  maxKeyAttempts: { min: 1, max: 100 },
  maxTransientAttempts: { min: 1, max: 50 }
} as const;

export const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 读取管理后台持久化的“默认开启”状态：
 * - on  → true（网关对支持的模型强制默认开启）
 * - off → undefined（网关不强加默认，交回客户端/模型决定）
 * - 未设置 → 回退到 env 默认值（fallback）
 */
async function loadDefault(store: StateStore, key: string, fallback: boolean | undefined): Promise<boolean | undefined> {
  const stored = await store.getSetting(key);
  if (stored === undefined) return fallback;
  return stored === "on" ? true : undefined;
}

async function saveDefault(store: StateStore, key: string, enabled: boolean): Promise<void> {
  await store.setSetting(key, enabled ? "on" : "off");
}

export function loadCursorMaxModeDefault(store: StateStore, fallback: boolean | undefined): Promise<boolean | undefined> {
  return loadDefault(store, MAX_MODE_DEFAULT_SETTING, fallback);
}

export function saveCursorMaxModeDefault(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, MAX_MODE_DEFAULT_SETTING, enabled);
}

export function loadCursorFastDefault(store: StateStore, fallback: boolean | undefined): Promise<boolean | undefined> {
  return loadDefault(store, FAST_DEFAULT_SETTING, fallback);
}

export function saveCursorFastDefault(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, FAST_DEFAULT_SETTING, enabled);
}

/** 自动禁用开关：与 Max Mode 不同，off 是明确的"永不自动禁用"，不是"交回默认"。 */
export async function loadAutoDisableKeys(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(AUTO_DISABLE_KEYS_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveAutoDisableKeys(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, AUTO_DISABLE_KEYS_SETTING, enabled);
}

export async function loadAutoDisableThreshold(store: StateStore, fallback: number): Promise<number> {
  const stored = Number.parseInt((await store.getSetting(AUTO_DISABLE_THRESHOLD_SETTING)) ?? "", 10);
  return Number.isFinite(stored) && stored >= 1 ? stored : fallback;
}

export function saveAutoDisableThreshold(store: StateStore, threshold: number): Promise<void> {
  return store.setSetting(AUTO_DISABLE_THRESHOLD_SETTING, String(threshold));
}

/** Sand 通道总开关：off 是明确的「全局走 SDK」，不是「交回默认」。 */
export async function loadSandClientMode(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(SAND_CLIENT_MODE_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveSandClientMode(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, SAND_CLIENT_MODE_SETTING, enabled);
}

/**
 * key 取用策略。默认 fill-first：Cursor 按 key 缓存 prompt，轮询换 key 会丢掉缓存、
 * 让同一段上下文重复计费，所以轮询必须由用户显式开启。
 */
export async function loadRoutingStrategy(store: StateStore, fallback: RoutingStrategy): Promise<RoutingStrategy> {
  const stored = await store.getSetting(ROUTING_STRATEGY_SETTING);
  if (stored === undefined) return fallback;
  return stored === "round-robin" ? "round-robin" : "fill-first";
}

export function saveRoutingStrategy(store: StateStore, strategy: RoutingStrategy): Promise<void> {
  return store.setSetting(ROUTING_STRATEGY_SETTING, strategy);
}

/** 会话粘性开关：off 是明确的「每次都重新选 key」，不是「交回默认」。 */
export async function loadSessionAffinity(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(SESSION_AFFINITY_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveSessionAffinity(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, SESSION_AFFINITY_SETTING, enabled);
}

export async function loadSessionAffinityTtlMs(store: StateStore, fallback: number): Promise<number> {
  const stored = Number.parseInt((await store.getSetting(SESSION_AFFINITY_TTL_SETTING)) ?? "", 10);
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

export function saveSessionAffinityTtlMs(store: StateStore, ttlMs: number): Promise<void> {
  return store.setSetting(SESSION_AFFINITY_TTL_SETTING, String(ttlMs));
}

/**
 * 默认系统提示词。mode 与正文分两个键存：正文可能很长且含换行，
 * 与 mode 混在一个值里会让「关掉注入但保留草稿」变得不可能。
 */
export async function loadSystemPromptSettings(
  store: StateStore,
  fallback: SystemPromptSettings
): Promise<SystemPromptSettings> {
  const storedMode = await store.getSetting(SYSTEM_PROMPT_MODE_SETTING);
  const storedText = await store.getSetting(SYSTEM_PROMPT_TEXT_SETTING);
  const mode: SystemPromptMode = storedMode === undefined
    ? fallback.mode
    : storedMode === "append" || storedMode === "override" ? storedMode : "off";
  const text = storedText === undefined ? fallback.text : storedText || undefined;
  return { mode, ...(text ? { text } : {}) };
}

export async function saveSystemPromptSettings(store: StateStore, settings: SystemPromptSettings): Promise<void> {
  await store.setSetting(SYSTEM_PROMPT_MODE_SETTING, settings.mode);
  await store.setSetting(SYSTEM_PROMPT_TEXT_SETTING, settings.text ?? "");
}

/**
 * 会话模式。库里有值就覆盖 env（含 kill switch）：后台保存过 durable 之后，
 * 拷进 .env 的 DISABLE=true 不能再把生产悄悄打回 stateless。
 */
export async function loadCursorSdkSessionMode(
  store: StateStore,
  fallbackMode: CursorSdkSessionMode,
  fallbackDisable: boolean
): Promise<{ mode: CursorSdkSessionMode; disable: boolean; stored: boolean }> {
  const stored = await store.getSetting(SESSION_MODE_SETTING);
  if (stored === "durable") return { mode: "durable", disable: false, stored: true };
  if (stored === "stateless") return { mode: "stateless", disable: false, stored: true };
  return {
    mode: fallbackDisable ? "stateless" : fallbackMode,
    disable: fallbackDisable,
    stored: false
  };
}

export function saveCursorSdkSessionMode(store: StateStore, mode: CursorSdkSessionMode): Promise<void> {
  return store.setSetting(SESSION_MODE_SETTING, mode);
}

export async function loadAllowDirectCursorKeys(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(ALLOW_DIRECT_CURSOR_KEYS_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveAllowDirectCursorKeys(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, ALLOW_DIRECT_CURSOR_KEYS_SETTING, enabled);
}

export async function loadCursorAllowBuiltinTools(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(ALLOW_BUILTIN_TOOLS_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveCursorAllowBuiltinTools(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, ALLOW_BUILTIN_TOOLS_SETTING, enabled);
}

export function loadRequestTimeoutMs(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, REQUEST_TIMEOUT_MS_SETTING, fallback, RUNTIME_SETTING_BOUNDS.requestTimeoutMs);
}

export function saveRequestTimeoutMs(store: StateStore, value: number): Promise<void> {
  return store.setSetting(REQUEST_TIMEOUT_MS_SETTING, String(value));
}

export function loadRequestLogKeep(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, REQUEST_LOG_KEEP_SETTING, fallback, RUNTIME_SETTING_BOUNDS.requestLogKeep);
}

export function saveRequestLogKeep(store: StateStore, value: number): Promise<void> {
  return store.setSetting(REQUEST_LOG_KEEP_SETTING, String(value));
}

export function loadCursorSdkToolHoldTtlMs(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, TOOL_HOLD_TTL_SETTING, fallback, RUNTIME_SETTING_BOUNDS.toolHoldTtlMs);
}

export function saveCursorSdkToolHoldTtlMs(store: StateStore, value: number): Promise<void> {
  return store.setSetting(TOOL_HOLD_TTL_SETTING, String(value));
}

export function loadCursorSdkSessionIdleTtlMs(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, SESSION_IDLE_TTL_SETTING, fallback, RUNTIME_SETTING_BOUNDS.idleTtlMs);
}

export function saveCursorSdkSessionIdleTtlMs(store: StateStore, value: number): Promise<void> {
  return store.setSetting(SESSION_IDLE_TTL_SETTING, String(value));
}

export function loadCursorSdkMaxLiveSessions(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, MAX_LIVE_SESSIONS_SETTING, fallback, RUNTIME_SETTING_BOUNDS.maxLiveSessions);
}

export function saveCursorSdkMaxLiveSessions(store: StateStore, value: number): Promise<void> {
  return store.setSetting(MAX_LIVE_SESSIONS_SETTING, String(value));
}

export function loadMaxKeyAttempts(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, MAX_KEY_ATTEMPTS_SETTING, fallback, RUNTIME_SETTING_BOUNDS.maxKeyAttempts);
}

export function saveMaxKeyAttempts(store: StateStore, value: number): Promise<void> {
  return store.setSetting(MAX_KEY_ATTEMPTS_SETTING, String(value));
}

export function loadMaxTransientAttempts(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, MAX_TRANSIENT_ATTEMPTS_SETTING, fallback, RUNTIME_SETTING_BOUNDS.maxTransientAttempts);
}

export function saveMaxTransientAttempts(store: StateStore, value: number): Promise<void> {
  return store.setSetting(MAX_TRANSIENT_ATTEMPTS_SETTING, String(value));
}

export async function loadCursorReasoningEffort(store: StateStore, fallback?: string): Promise<string | undefined> {
  const stored = await store.getSetting(REASONING_EFFORT_SETTING);
  if (stored === undefined) return fallback;
  return parseReasoningEffort(stored);
}

export function saveCursorReasoningEffort(store: StateStore, value: string | undefined): Promise<void> {
  return store.setSetting(REASONING_EFFORT_SETTING, value ?? "");
}

export async function loadCursorAgentMode(store: StateStore, fallback?: AgentMode): Promise<AgentMode | undefined> {
  const stored = await store.getSetting(AGENT_MODE_SETTING);
  if (stored === undefined) return fallback;
  return stored === "agent" || stored === "plan" ? stored : undefined;
}

export function saveCursorAgentMode(store: StateStore, value: AgentMode | undefined): Promise<void> {
  return store.setSetting(AGENT_MODE_SETTING, value ?? "");
}

export async function loadCursorModelParams(
  store: StateStore,
  fallback?: ModelParameterValue[]
): Promise<ModelParameterValue[] | undefined> {
  const stored = await store.getSetting(MODEL_PARAMS_SETTING);
  if (stored === undefined) return fallback;
  return parseModelParamsSpec(stored);
}

export function saveCursorModelParams(store: StateStore, spec: string): Promise<void> {
  return store.setSetting(MODEL_PARAMS_SETTING, spec);
}

export function parseReasoningEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

async function loadIntSetting(
  store: StateStore,
  key: string,
  fallback: number,
  bounds: { min: number; max: number }
): Promise<number> {
  const stored = Number.parseInt((await store.getSetting(key)) ?? "", 10);
  if (!Number.isInteger(stored) || stored < bounds.min || stored > bounds.max) return fallback;
  return stored;
}
