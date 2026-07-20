import type { StateStore } from "./types.js";

const CURSOR_SDK_HTTP1_SETTING = "cursorSdkUseHttp1ForAgent";

export async function loadCursorSdkUseHttp1ForAgent(store: StateStore, fallback: boolean): Promise<boolean> {
  const stored = await store.getSetting(CURSOR_SDK_HTTP1_SETTING);
  if (stored === undefined) return fallback;
  return stored === "true";
}

export async function saveCursorSdkUseHttp1ForAgent(store: StateStore, enabled: boolean): Promise<void> {
  await store.setSetting(CURSOR_SDK_HTTP1_SETTING, enabled ? "true" : "false");
}

export async function applyCursorSdkNetworkConfig(useHttp1ForAgent: boolean): Promise<void> {
  const { configureCursorSdk } = await import("@cursor/sdk");
  configureCursorSdk({ local: { useHttp1ForAgent } });
}
