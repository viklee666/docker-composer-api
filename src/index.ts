import { loadConfig } from "./config.js";
import { CursorSdkRunner } from "./cursor-runner.js";
import { CursorKeyPool } from "./key-pool.js";
import { KeyRotatingRunner } from "./key-rotating-runner.js";
import { getModelCatalogEntry } from "./models.js";
import { PersistentAgentManager, PersistentRoutingRunner } from "./persistent-agent.js";
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
const keyPool = new CursorKeyPool(store);
await keyPool.seedFromEnv(config.cursorApiKeys);

const sdkRunner = new CursorSdkRunner(store, {
  defaultWorkingDirectory: config.cursorWorkingDirectory,
  sdkClientVersion: config.sdkClientVersion,
  disableSessionResume: config.cursorSdkDisableSessionResume,
  getModelCatalog: getModelCatalogEntry
});
const runner = new KeyRotatingRunner(sdkRunner, keyPool, {
  maxKeyAttempts: config.maxKeyAttempts,
  maxTransientAttempts: config.maxTransientAttempts
});
const persistentAgent = new PersistentAgentManager();
const app = createApp({
  config,
  store,
  runner: new PersistentRoutingRunner(persistentAgent, runner),
  keyPool,
  persistentAgent,
  startedAt: Date.now()
});

await app.listen({ host: config.host, port: config.port });
console.log(`Docker Composer API listening on http://${config.host}:${config.port}`);
console.log(`Admin panel available at /admin (${config.adminPassword ? "enabled" : "disabled: set ADMIN_PASSWORD"})`);
if (config.cursorSdkDisableSessionResume) console.log("Cursor SDK session resume disabled (stateless per request)");
if (config.cursorSdkUseHttp1ForAgent) console.log("Cursor SDK local agent HTTP/1.1 mode enabled");
