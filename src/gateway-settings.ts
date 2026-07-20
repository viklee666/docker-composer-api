import type { StateStore } from "./types.js";

const MAX_MODE_DEFAULT_SETTING = "cursorMaxModeDefault";
const FAST_DEFAULT_SETTING = "cursorFastDefault";

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
