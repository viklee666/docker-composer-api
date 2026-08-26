import { createEphemeralAgentStore } from "./agent-store.js";
import { loadConfig } from "./config.js";
import { CursorSdkRunner } from "./cursor-runner.js";
import { ExecutorWarmPool, type WarmupPlatform } from "./executor-warmup.js";
import {
  loadAutoDisableKeys,
  loadAutoDisableThreshold,
  loadCursorFastDefault,
  loadCursorMaxModeDefault,
  loadSandClientMode
} from "./gateway-settings.js";
import { CursorKeyPool } from "./key-pool.js";
import { KeyRotatingRunner } from "./key-rotating-runner.js";
import { getModelCatalogEntry } from "./models.js";
import {
  installSandClientHeaderHook,
  isSandClientHookPatched,
  resolveCursorClientType,
  runWithCursorClientType,
  setGlobalCursorClientType,
  waitForSandClientHook
} from "./sand-client.js";
import { applyCursorSdkNetworkConfig, loadCursorSdkUseHttp1ForAgent } from "./sdk-network.js";
import { createApp } from "./server.js";
import { SqliteStateStore } from "./store.js";

// 必须在任何 import("@cursor/sdk") 之前挂上 loader，否则硬编码的 client-type 头无法按请求改写。
installSandClientHeaderHook();

// Cursor SDK 在云端流以 end-stream error 收场时，底层 ConnectError 可能以 unhandledRejection 形式逃逸
//（官方已确认的 SDK 行为）。兜底记录并截断，避免拖垮进程或在未来 Node 版本触发非零退出；不打印完整堆栈以免泄露敏感上下文。
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection] ${message.slice(0, 300)}`);
});

const config = loadConfig();
const store = new SqliteStateStore(config.sqlitePath);
// Sand 总开关必须在任何 @cursor/sdk import 之前落到 __cursorClientType。
// HTTP/1 配置会动态 import SDK，不能放在 setGlobal 前面。
config.sandClientMode = await loadSandClientMode(store, config.sandClientMode);
setGlobalCursorClientType(config.sandClientMode ? "sand" : "sdk");
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

// SDK 的本地执行器在进程内按 (工作目录, apiKey, settingSources …) 共享并引用计数，
// 而它的鉴权拦截器会把「API key 兑换 access token」的失败永久缓存在闭包里（无 TTL、无重置路径），
// 只有引用计数归零、执行器被 dispose 才能恢复。因此预热租约必须由网关保管：
// 上游报鉴权错误时释放它，让坏执行器能被回收，而不是一直钉在缓存里让后续请求全部 502。
const executorLeases = new ExecutorWarmPool({
  loadPlatform: async () => {
    const sdk = await import("@cursor/sdk") as {
      createAgentPlatform?: () => Promise<WarmupPlatform>;
    };
    return sdk.createAgentPlatform ? sdk.createAgentPlatform() : undefined;
  }
});

const sdkRunner = new CursorSdkRunner(store, {
  defaultWorkingDirectory: config.cursorWorkingDirectory,
  sdkClientVersion: config.sdkClientVersion,
  disableSessionResume: config.cursorSdkDisableSessionResume,
  allowBuiltinTools: config.cursorAllowBuiltinTools,
  executorLeases,
  // stateless（默认）：agent 记录无需跨请求持久化，共享有界内存 store，
  // 规避 SDK 默认 SqliteLocalAgentStore 每 agent 泄漏内核句柄的问题。
  // 开启 session resume 时保留 SDK 默认持久化存储（恢复依赖跨请求/跨重启的记录）。
  ...(config.cursorSdkDisableSessionResume ? { localAgentStore: createEphemeralAgentStore() } : {}),
  getModelCatalog: getModelCatalogEntry
});
const runner = new KeyRotatingRunner(sdkRunner, keyPool, {
  maxKeyAttempts: config.maxKeyAttempts,
  maxTransientAttempts: config.maxTransientAttempts,
  resolveGlobalClientType: () => config.sandClientMode ? "sand" : "sdk"
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
if (config.sandClientMode) console.log("Cursor Sand channel enabled globally (per-key overrides still apply)");

// 启动即预热 SDK：默认路径下 SDK 是首个请求才懒加载的，冷加载 + 本地执行器初始化会拖慢首请求的首 token。
// 预热失败不影响服务（首请求会再走懒加载）。
// 预热拿到的租约必须交给 executorLeases 保管而不是丢弃：丢掉 release 等于给共享执行器永久加了一个引用，
// 引用计数再也回不到 0，鉴权闭包一旦被污染就只能靠重启进程恢复。
void (async () => {
  try {
    await import("@cursor/sdk");
    const hooked = await waitForSandClientHook();
    console.log(hooked || isSandClientHookPatched()
      ? "Cursor SDK preloaded (client-type hook applied)"
      : "Cursor SDK preloaded (client-type hook not confirmed; Sand requests will fail closed)");
    const poolKey = (await keyPool.list()).find((key) => key.status === "active");
    if (!poolKey) return;
    // 预扫描工作区（规则/忽略文件等），让首个 send() 少一段准备时间。
    const clientType = resolveCursorClientType(poolKey.clientType, config.sandClientMode ? "sand" : "sdk");
    await runWithCursorClientType(clientType, () => executorLeases.warm(poolKey.apiKey, config.cursorWorkingDirectory));
    console.log("Cursor workspace prewarmed");
  } catch (error) {
    console.error(`[prewarm] Cursor SDK preload failed (first request will lazy-load): ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
})();

// 关停时释放全部预热租约，让 SDK 能 dispose 共享执行器，而不是把本地执行器的句柄留到进程被强杀。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      await executorLeases.releaseAll();
      await app.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}
