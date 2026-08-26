import type { StateStore } from "./types.js";

const MAX_MODE_DEFAULT_SETTING = "cursorMaxModeDefault";
const FAST_DEFAULT_SETTING = "cursorFastDefault";
const AUTO_DISABLE_KEYS_SETTING = "autoDisableKeys";
const AUTO_DISABLE_THRESHOLD_SETTING = "autoDisableThreshold";
const SAND_CLIENT_MODE_SETTING = "sandClientMode";

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
