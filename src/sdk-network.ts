import { readCursorSdkUseHttp1Preference } from "./config.js";
import type { ExecutorReleaseReport } from "./executor-warmup.js";
import type { StateStore } from "./types.js";

const CURSOR_SDK_HTTP1_SETTING = "cursorSdkUseHttp1ForAgent";
const PROXY_URL_SETTING = "proxyUrl";

/** HTTP/1.1 最终取值是谁定的，用于告诉运维「这个开关是不是网关替他做的决定」。 */
export type Http1Source = "stored" | "env" | "proxy" | "default";

export interface Http1Preference {
  enabled: boolean;
  source: Http1Source;
}

/** 注意：本文件的布尔值用 "true"/"false" 编码，与 gateway-settings.ts 的 "on"/"off" 不同；
 *  沿用各自既有约定，不做统一，以免改写已经落库的历史值。 */

/**
 * HTTP/1.1 必须按三态解析，不能只取一个布尔默认值。
 * 模型流量走 connect-node 的 HTTP/2，而 node:http2 完全不支持代理——
 * 「配了代理但没开 HTTP/1.1」是墙内唯一会让模型请求静默超时的组合，
 * 而它恰恰是过去的默认值。所以在没人表过态时，代理的存在本身就是最强的信号，
 * 由它把开关顶上去；但顶上去不能盖过运维的明确意见：落库值与非空环境变量都算明确意见，
 * 包括显式的 false（确实有人只想让 REST 走代理、模型流量直连）。
 */
export async function loadCursorSdkUseHttp1ForAgent(
  store: StateStore,
  options: { proxyConfigured?: boolean; fallback?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<Http1Preference> {
  // 缺行返回 undefined，所以落库的 "false" 与「从没配过」在这里是分得开的。
  // 空串是第三种情况：运维在后台把开关退回了「未设置」，必须与「从没配过」完全等价——
  // StateStore 只有 get/set 两个原语，删不掉单行，退回未设置只能这么编码。
  const stored = (await store.getSetting(CURSOR_SDK_HTTP1_SETTING))?.trim();
  if (stored) return { enabled: stored === "true", source: "stored" };
  const fromEnv = readCursorSdkUseHttp1Preference(options.env ?? process.env);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: "env" };
  if (options.proxyConfigured) return { enabled: true, source: "proxy" };
  return { enabled: options.fallback === true, source: "default" };
}

export async function saveCursorSdkUseHttp1ForAgent(store: StateStore, enabled: boolean): Promise<void> {
  await store.setSetting(CURSOR_SDK_HTTP1_SETTING, enabled ? "true" : "false");
}

/**
 * 退回「没人表过态」。必须存在这条路：否则后台只要保存过一次设置，
 * 落库值就永远压着环境变量与「配了代理自动开」，运维再也回不到自动档。
 */
export async function clearCursorSdkUseHttp1ForAgent(store: StateStore): Promise<void> {
  await store.setSetting(CURSOR_SDK_HTTP1_SETTING, "");
}

/**
 * 出站代理地址。空串是有意义的值：「用户在后台把代理关了」必须能和「从没配过」区分开，
 * 否则关掉之后每次重启又会被 env 里的 PROXY_URL/HTTPS_PROXY 兜回来，用户以为关不掉。
 */
export async function loadProxyUrl(store: StateStore, fallback: string | undefined): Promise<string | undefined> {
  const stored = await store.getSetting(PROXY_URL_SETTING);
  if (stored === undefined) return fallback?.trim() || undefined;
  return stored.trim() || undefined;
}

export async function saveProxyUrl(store: StateStore, proxyUrl: string | undefined): Promise<void> {
  await store.setSetting(PROXY_URL_SETTING, proxyUrl?.trim() ?? "");
}

/**
 * configureCursorSdk 写的是模块级状态，只有**新建**传输层时才会去读它，
 * 已经建好的那一个会一直用它出生时的协议。启动预热正好会建一个，
 * 于是运行期把 HTTP/1.1 打开后，预热出来的执行器仍握着 HTTP/2，模型请求照样绕过代理。
 * 让 index.ts 在这里登记「放掉预热租约」的动作：引用计数归零后 SDK 才会 dispose 旧执行器，
 * 下一个请求拿到的传输层才是按新配置建的。
 */
let resetAgentTransports: (() => Promise<void | ExecutorReleaseReport>) | undefined;

export function setAgentTransportResetter(reset: (() => Promise<void | ExecutorReleaseReport>) | undefined): void {
  resetAgentTransports = reset;
}

/**
 * 释放执行器的时限。这一层与执行器池自己的时限是两回事：
 * 池那边的窗口更短、诊断更细，正常情况下先超时；这里兜的是「注册进来的重置器本身挂死」，
 * 保证管理接口的「保存设置」在任何情况下都会返回。
 */
const AGENT_RESET_TIMEOUT_MS = 15_000;

export interface AgentTransportResetReport {
  ok: boolean;
  /** 没成功时的可读原因；成功时不写。 */
  detail?: string;
}

let lastReset: AgentTransportResetReport | undefined;

/** 最近一次 applyCursorSdkNetworkConfig 里执行器释放的结果，供管理接口如实回报给运维。 */
export function lastAgentTransportReset(): AgentTransportResetReport | undefined {
  return lastReset;
}

export async function applyCursorSdkNetworkConfig(useHttp1ForAgent: boolean): Promise<void> {
  const { configureCursorSdk } = await import("@cursor/sdk");
  configureCursorSdk({ local: { useHttp1ForAgent } });
  lastReset = await resetTransports();
}

/**
 * 释放失败不该把「配置已改」这件事回滚掉：最坏情况只是旧执行器多活一会儿，重启即可收敛。
 * 但也绝不能继续假装成功——旧执行器还握着按旧配置建的传输层，
 * 「后台点完开关模型流量却仍然绕过代理」正是这样来的，运维必须知道自己得重启。
 */
async function resetTransports(): Promise<AgentTransportResetReport> {
  if (!resetAgentTransports) return { ok: true };
  try {
    const result = await withTimeout(resetAgentTransports(), AGENT_RESET_TIMEOUT_MS);
    if (isFailedReleaseReport(result)) {
      const detail = `预热执行器未能释放（${result.failures.join("；") || "仍有租约未释放"}）：` +
        "新配置已保存，但已经建好的传输层仍是旧协议，要彻底生效请重启网关。";
      console.warn(`[sdk-network] ${detail}`);
      return { ok: false, detail };
    }
    return { ok: true };
  } catch (error) {
    const detail =
      `预热执行器未能释放（${error instanceof Error ? error.message : String(error)}）：` +
      "新配置已保存，但已经建好的传输层仍是旧协议，要彻底生效请重启网关。";
    console.warn(`[sdk-network] ${detail}`);
    return { ok: false, detail };
  }
}

function isFailedReleaseReport(value: void | ExecutorReleaseReport): value is ExecutorReleaseReport {
  return value !== undefined && value.ok === false;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 不 unref：调用方（管理接口）正等着它返回，定时器不算数就等于没有时限。
    const timer = setTimeout(() => reject(new Error(`释放超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
