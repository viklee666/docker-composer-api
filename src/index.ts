import { createEphemeralAgentStore } from "./agent-store.js";
import { loadConfig } from "./config.js";
import { CursorSdkRunner } from "./cursor-runner.js";
import {
  loadAutoDisableKeys,
  loadAutoDisableThreshold,
  loadCursorFastDefault,
  loadCursorMaxModeDefault
} from "./gateway-settings.js";
import { CursorKeyPool } from "./key-pool.js";
import { KeyRotatingRunner } from "./key-rotating-runner.js";
import { getModelCatalogEntry } from "./models.js";
import { applyCursorSdkNetworkConfig, loadCursorSdkUseHttp1ForAgent } from "./sdk-network.js";
import { createApp } from "./server.js";
import { SqliteStateStore } from "./store.js";

// Cursor SDK 在云端流以 end-stream error 收场时，底层 ConnectError 可能以 unhandledRejection 形式逃逸
//（官方已确认的 SDK 行为）。兜底记录并截断，避免拖垮进程或在未来 Node 版本触发非零退出；不打印完整堆栈以免泄露敏感上下文。
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection] ${message.slice(0, 300)}`);
});

const config = loadConfig();
const store = new SqliteStateStore(config.sqlitePath);
config.cursorSdkUseHttp1ForAgent = await loadCursorSdkUseHttp1ForAgent(store, config.cursorSdkUseHttp1ForAgent);
if (config.cursorSdkUseHttp1ForAgent) {
  await applyCursorSdkNetworkConfig(true);
}
// 管理后台持久化的模型默认开关优先于 env 默认值。
config.cursorMaxMode = await loadCursorMaxModeDefault(store, config.cursorMaxMode);
config.cursorFast = await loadCursorFastDefault(store, config.cursorFast);
// 自动禁用策略同样以后台持久化设置优先，改完即时生效且重启后保留。
config.autoDisableKeys = await loadAutoDisableKeys(store, config.autoDisableKeys);
config.autoDisableThreshold = await loadAutoDisableThreshold(store, config.autoDisableThreshold);
const keyPool = new CursorKeyPool(store, {
  enabled: config.autoDisableKeys,
  threshold: config.autoDisableThreshold
});
await keyPool.seedFromEnv(config.cursorApiKeys);

const sdkRunner = new CursorSdkRunner(store, {
  defaultWorkingDirectory: config.cursorWorkingDirectory,
  sdkClientVersion: config.sdkClientVersion,
  disableSessionResume: config.cursorSdkDisableSessionResume,
  allowBuiltinTools: config.cursorAllowBuiltinTools,
  // stateless（默认）：agent 记录无需跨请求持久化，共享有界内存 store，
  // 规避 SDK 默认 SqliteLocalAgentStore 每 agent 泄漏内核句柄的问题。
  // 开启 session resume 时保留 SDK 默认持久化存储（恢复依赖跨请求/跨重启的记录）。
  ...(config.cursorSdkDisableSessionResume ? { localAgentStore: createEphemeralAgentStore() } : {}),
  getModelCatalog: getModelCatalogEntry
});
const runner = new KeyRotatingRunner(sdkRunner, keyPool, {
  maxKeyAttempts: config.maxKeyAttempts,
  maxTransientAttempts: config.maxTransientAttempts
});
const app = createApp({
  config,
  store,
  runner,
  keyPool,
  startedAt: Date.now()
});

await app.listen({ host: config.host, port: config.port });
console.log(`Docker Composer API listening on http://${config.host}:${config.port}`);
console.log(`Admin panel available at /admin (${config.adminPassword ? "enabled" : "disabled: set ADMIN_PASSWORD"})`);
if (config.cursorSdkDisableSessionResume) console.log("Cursor SDK session resume disabled (stateless per request)");
if (config.cursorSdkUseHttp1ForAgent) console.log("Cursor SDK local agent HTTP/1.1 mode enabled");

// 启动即预热 SDK：默认路径下 SDK 是首个请求才懒加载的，冷加载 + 本地执行器初始化会拖慢首请求的首 token。
// 预热失败不影响服务（首请求会再走懒加载）。
void (async () => {
  try {
    const sdk = await import("@cursor/sdk") as {
      createAgentPlatform?: () => Promise<{ prewarmLocalWorkspace?: (options: Record<string, unknown>) => Promise<() => Promise<void>> }>;
    };
    console.log("Cursor SDK preloaded");
    const poolKey = (await keyPool.list()).find((key) => key.status === "active");
    if (!sdk.createAgentPlatform || !poolKey) return;
    // 预扫描工作区（规则/忽略文件等），让首个 send() 少一段准备时间。
    // 返回的 release 函数用于停止缓存维护；网关生命周期内持续复用工作区，不调用。
    const platform = await sdk.createAgentPlatform();
    await platform.prewarmLocalWorkspace?.({
      apiKey: poolKey.apiKey,
      local: { cwd: config.cursorWorkingDirectory, settingSources: [] }
    });
    console.log("Cursor workspace prewarmed");
  } catch (error) {
    console.error(`[prewarm] Cursor SDK preload failed (first request will lazy-load): ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
})();
