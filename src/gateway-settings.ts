import { isModelParamPolicyMode } from "./model-param-policy.js";
import { formatModelParamsSpec, parseModelParamsSpec } from "./model-params.js";
import type { DebugFilters } from "./debug-recorder.js";
import type {
  AgentMode,
  CursorSdkSessionMode,
  GatewayProvider,
  ModelParamPolicy,
  ModelParameterValue,
  ProviderRunOverrides,
  RoutingStrategy,
  StateStore,
  SystemPromptMode,
  SystemPromptSettings
} from "./types.js";

const MAX_MODE_POLICY_SETTING = "cursorMaxModePolicy";
const MAX_MODE_MODELS_SETTING = "cursorMaxModeModels";
const FAST_POLICY_SETTING = "cursorFastPolicy";
const FAST_MODELS_SETTING = "cursorFastModels";
// 旧二态键只作迁移来源与兼容投影，不再承载新语义（checkbox 存布尔会毁掉第三态）。
const MAX_MODE_DEFAULT_SETTING = "cursorMaxModeDefault";
const FAST_DEFAULT_SETTING = "cursorFastDefault";
const AUTO_DISABLE_KEYS_SETTING = "autoDisableKeys";
const AUTO_DISABLE_THRESHOLD_SETTING = "autoDisableThreshold";
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
const DEBUG_ENABLED_SETTING = "debugEnabled";
const DEBUG_FILTERS_SETTING = "debugFilters";
const DEBUG_MAX_ENTRIES_SETTING = "debugMaxEntries";
const DEBUG_MAX_TOTAL_BYTES_SETTING = "debugMaxTotalBytes";

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

async function saveDefault(store: StateStore, key: string, enabled: boolean): Promise<void> {
  await store.setSetting(key, enabled ? "on" : "off");
}

/**
 * 三态策略的启动加载，读取顺序：
 * 1. 新键存在且合法 → 用它（名单一并读；非法档位按 passthrough 落，不回退 env）；
 * 2. 旧二态键 → `on` 升级为 force-all（今天勾上的行为），`off` 升级为 passthrough；
 * 3. 都没有 → env（loadConfig 已解析好的 fallback）。
 */
async function loadModelParamPolicy(
  store: StateStore,
  policyKey: string,
  modelsKey: string,
  legacyKey: string,
  fallback: ModelParamPolicy
): Promise<ModelParamPolicy> {
  const stored = await store.getSetting(policyKey);
  if (stored !== undefined) {
    return {
      mode: isModelParamPolicyMode(stored) ? stored : "passthrough",
      models: await loadPolicyModels(store, modelsKey)
    };
  }
  const legacy = await store.getSetting(legacyKey);
  if (legacy === "on") return { mode: "force-all", models: [] };
  if (legacy === "off") return { mode: "passthrough", models: [] };
  return fallback;
}

/** 名单存 JSON 数组；非法 JSON / 非数组一律当空名单，不让一条坏数据把请求路径打挂。 */
async function loadPolicyModels(store: StateStore, key: string): Promise<string[]> {
  const stored = await store.getSetting(key);
  if (stored === undefined) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
  } catch {
    return [];
  }
}

async function saveModelParamPolicy(
  store: StateStore,
  policyKey: string,
  modelsKey: string,
  legacyKey: string,
  policy: ModelParamPolicy
): Promise<void> {
  await store.setSetting(policyKey, policy.mode);
  await store.setSetting(modelsKey, JSON.stringify(policy.models));
  // 兼容投影：回滚到旧二进制时至少保留「强制开 / 不强制」的信息，不至于全空白。
  await store.setSetting(legacyKey, policy.mode === "force-all" ? "on" : "off");
}

export function loadCursorMaxModePolicy(
  store: StateStore,
  fallback: ModelParamPolicy
): Promise<ModelParamPolicy> {
  return loadModelParamPolicy(store, MAX_MODE_POLICY_SETTING, MAX_MODE_MODELS_SETTING, MAX_MODE_DEFAULT_SETTING, fallback);
}

export function saveCursorMaxModePolicy(store: StateStore, policy: ModelParamPolicy): Promise<void> {
  return saveModelParamPolicy(store, MAX_MODE_POLICY_SETTING, MAX_MODE_MODELS_SETTING, MAX_MODE_DEFAULT_SETTING, policy);
}

export function loadCursorFastPolicy(
  store: StateStore,
  fallback: ModelParamPolicy
): Promise<ModelParamPolicy> {
  return loadModelParamPolicy(store, FAST_POLICY_SETTING, FAST_MODELS_SETTING, FAST_DEFAULT_SETTING, fallback);
}

export function saveCursorFastPolicy(store: StateStore, policy: ModelParamPolicy): Promise<void> {
  return saveModelParamPolicy(store, FAST_POLICY_SETTING, FAST_MODELS_SETTING, FAST_DEFAULT_SETTING, policy);
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

/* ---------------------- per-provider 运行设置（包 A，计划 §3.5） */

/** per-provider 覆盖层的 setting key 字段名（实际 key = provider 前缀 + 字段名，如 sdkReasoningEffort）。 */
const PROVIDER_OVERRIDE_KEYS = {
  requestTimeoutMs: "RequestTimeoutMs",
  autoDisableKeys: "AutoDisableKeys",
  autoDisableThreshold: "AutoDisableThreshold",
  reasoningEffort: "ReasoningEffort",
  maxModePolicy: "MaxModePolicy",
  maxModeModels: "MaxModeModels",
  fastPolicy: "FastPolicy",
  fastModels: "FastModels",
  modelParams: "ModelParams",
  agentMode: "AgentMode",
  sendTools: "SendTools",
  codec: "Codec"
} as const;

function providerSettingKey(
  provider: GatewayProvider,
  field: keyof typeof PROVIDER_OVERRIDE_KEYS
): string {
  return provider + PROVIDER_OVERRIDE_KEYS[field];
}

/**
 * per-provider 运行设置的启动加载（包 A，计划 §3.5）。
 *
 * 迁移与兼容（升级生命线）：旧全局 key（cursorReasoningEffort 等）继续由上面各自的
 * loadXxx 恢复进 GatewayConfig 顶层字段，作为两条路线的共同默认值——不迁移、不删除；
 * 这里的 `sdk*` / `bot*` key 只承载「某条路线显式改过」的覆盖值。字段独立判定：
 * key 缺失 / 空串（= 恢复跟随全局）/ 非法值一律不进结果，消费侧按「覆盖 ?? 顶层」取值。
 * 于是老库升级后这里返回 undefined，行为与改造前完全一致，线上设置绝不回默认值。
 */
export async function loadProviderRunOverrides(
  store: StateStore,
  provider: GatewayProvider
): Promise<ProviderRunOverrides | undefined> {
  const overrides: ProviderRunOverrides = {};

  const timeout = Number.parseInt((await store.getSetting(providerSettingKey(provider, "requestTimeoutMs"))) ?? "", 10);
  const timeoutBounds = RUNTIME_SETTING_BOUNDS.requestTimeoutMs;
  if (Number.isInteger(timeout) && timeout >= timeoutBounds.min && timeout <= timeoutBounds.max) {
    overrides.requestTimeoutMs = timeout;
  }

  overrides.autoDisableKeys = await loadOverrideFlag(store, providerSettingKey(provider, "autoDisableKeys"));

  const threshold = Number.parseInt((await store.getSetting(providerSettingKey(provider, "autoDisableThreshold"))) ?? "", 10);
  if (Number.isInteger(threshold) && threshold >= 1) overrides.autoDisableThreshold = threshold;

  const effort = parseReasoningEffort(await store.getSetting(providerSettingKey(provider, "reasoningEffort")));
  if (effort) overrides.reasoningEffort = effort;

  overrides.maxModePolicy = await loadOverridePolicy(
    store,
    providerSettingKey(provider, "maxModePolicy"),
    providerSettingKey(provider, "maxModeModels")
  );
  overrides.fastPolicy = await loadOverridePolicy(
    store,
    providerSettingKey(provider, "fastPolicy"),
    providerSettingKey(provider, "fastModels")
  );

  const params = parseModelParamsSpec(await store.getSetting(providerSettingKey(provider, "modelParams")));
  if (params) overrides.modelParams = params;

  const agentMode = await store.getSetting(providerSettingKey(provider, "agentMode"));
  if (agentMode === "agent" || agentMode === "plan") overrides.agentMode = agentMode;

  if (provider === "bot") {
    // sendTools / codec 只属于 Bot 路线；SDK 侧没有对应的同名 key。
    overrides.sendTools = await loadOverrideFlag(store, providerSettingKey("bot", "sendTools"));
    const codec = await store.getSetting(providerSettingKey("bot", "codec"));
    if (codec === "proto" || codec === "json") overrides.codec = codec;
  }

  return Object.values(overrides).some((value) => value !== undefined) ? overrides : undefined;
}

/**
 * per-provider 运行设置的后台保存（包 A）。整包覆盖，与表单「保存」按钮的语义一致：
 * 未覆盖的字段写空串（读侧遇空串即视为跟随全局），因此「恢复默认」能真正清掉旧值。
 */
export async function saveProviderRunOverrides(
  store: StateStore,
  provider: GatewayProvider,
  overrides: ProviderRunOverrides
): Promise<void> {
  await store.setSetting(
    providerSettingKey(provider, "requestTimeoutMs"),
    overrides.requestTimeoutMs === undefined ? "" : String(overrides.requestTimeoutMs)
  );
  await saveOverrideFlag(store, providerSettingKey(provider, "autoDisableKeys"), overrides.autoDisableKeys);
  await store.setSetting(
    providerSettingKey(provider, "autoDisableThreshold"),
    overrides.autoDisableThreshold === undefined ? "" : String(overrides.autoDisableThreshold)
  );
  await store.setSetting(providerSettingKey(provider, "reasoningEffort"), overrides.reasoningEffort ?? "");
  await store.setSetting(providerSettingKey(provider, "maxModePolicy"), overrides.maxModePolicy?.mode ?? "");
  await store.setSetting(
    providerSettingKey(provider, "maxModeModels"),
    JSON.stringify(overrides.maxModePolicy?.models ?? [])
  );
  await store.setSetting(providerSettingKey(provider, "fastPolicy"), overrides.fastPolicy?.mode ?? "");
  await store.setSetting(
    providerSettingKey(provider, "fastModels"),
    JSON.stringify(overrides.fastPolicy?.models ?? [])
  );
  await store.setSetting(
    providerSettingKey(provider, "modelParams"),
    formatModelParamsSpec(overrides.modelParams)
  );
  await store.setSetting(providerSettingKey(provider, "agentMode"), overrides.agentMode ?? "");
  if (provider === "bot") {
    await saveOverrideFlag(store, providerSettingKey("bot", "sendTools"), overrides.sendTools);
    await store.setSetting(providerSettingKey("bot", "codec"), overrides.codec ?? "");
  }
}

/** 布尔覆盖只认显式 on/off；缺失或空串（= 恢复跟随全局）一律视为未覆盖。 */
async function loadOverrideFlag(store: StateStore, key: string): Promise<boolean | undefined> {
  const stored = await store.getSetting(key);
  if (stored === "on") return true;
  if (stored === "off") return false;
  return undefined;
}

/** 三态策略覆盖：policy key 是合法档位才覆盖（models 名单跟随 policy 一起读）。 */
async function loadOverridePolicy(
  store: StateStore,
  policyKey: string,
  modelsKey: string
): Promise<ModelParamPolicy | undefined> {
  const stored = await store.getSetting(policyKey);
  if (!isModelParamPolicyMode(stored)) return undefined;
  return { mode: stored, models: await loadPolicyModels(store, modelsKey) };
}

/** 三态落库：undefined = 跟随全局（空串），true/false = on/off。 */
async function saveOverrideFlag(store: StateStore, key: string, value: boolean | undefined): Promise<void> {
  await store.setSetting(key, value === undefined ? "" : value ? "on" : "off");
}

/* ---------------------------------- Debug 快照（包 D，计划 §3.1） */

/**
 * Debug 总开关：库里存过就覆盖 env（与 autoDisableKeys 同机制）。
 * off 是明确的「关」，不是「交回默认」。
 */
export async function loadDebugEnabled(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(DEBUG_ENABLED_SETTING);
  if (stored === undefined) return fallback;
  return stored === "on";
}

export function saveDebugEnabled(store: StateStore, enabled: boolean): Promise<void> {
  return saveDefault(store, DEBUG_ENABLED_SETTING, enabled);
}

/**
 * Debug 过滤条件（owner / endpoint / model）。单独一个 JSON 键：
 * 三个子字段都允许单独更新，存整体 JSON 比三个键更容易保持一致（保存时整包覆盖）。
 * 非法 JSON / 非对象 / 非字符串子字段一律按空过滤处理，不让一条坏数据把请求路径打挂。
 */
export async function loadDebugFilters(store: StateStore): Promise<DebugFilters> {
  const stored = await store.getSetting(DEBUG_FILTERS_SETTING);
  if (stored === undefined) return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const trimmed = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const owner = trimmed(record.owner);
    const endpoint = trimmed(record.endpoint);
    const model = trimmed(record.model);
    return { ...(owner ? { owner } : {}), ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}) };
  } catch {
    return {};
  }
}

export function saveDebugFilters(store: StateStore, filters: DebugFilters): Promise<void> {
  return store.setSetting(DEBUG_FILTERS_SETTING, JSON.stringify(filters));
}

/** 单日条数上限。0 合法（= 不限制），与 requestLogKeep 同语义。 */
export async function loadDebugMaxEntries(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, DEBUG_MAX_ENTRIES_SETTING, fallback, { min: 0, max: 1_000_000 });
}

export function saveDebugMaxEntries(store: StateStore, value: number): Promise<void> {
  return store.setSetting(DEBUG_MAX_ENTRIES_SETTING, String(value));
}

/** 快照总体积上限（字节）。0 合法（= 不限制）。 */
export async function loadDebugMaxTotalBytes(store: StateStore, fallback: number): Promise<number> {
  return loadIntSetting(store, DEBUG_MAX_TOTAL_BYTES_SETTING, fallback, { min: 0, max: 100 * 1024 * 1024 * 1024 });
}

export function saveDebugMaxTotalBytes(store: StateStore, value: number): Promise<void> {
  return store.setSetting(DEBUG_MAX_TOTAL_BYTES_SETTING, String(value));
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
