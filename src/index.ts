import { createEphemeralAgentStore } from "./agent-store.js";
import { loadConfig, shouldUseDurableHub } from "./config.js";
import { CursorSdkRunner } from "./cursor-runner.js";
import { SessionHub } from "./session-hub.js";
import { ExecutorWarmPool, type WarmupPlatform } from "./executor-warmup.js";
import {
  loadAutoDisableKeys,
  loadAutoDisableThreshold,
  loadCursorFastDefault,
  loadCursorMaxModeDefault,
  loadRoutingStrategy,
  loadSandClientMode,
  loadSessionAffinity,
  loadSessionAffinityTtlMs,
  loadSystemPromptSettings
} from "./gateway-settings.js";
import { GatewayKeyPool } from "./gateway-key-pool.js";
import { CursorKeyPool } from "./key-pool.js";
import { KeyRotatingRunner } from "./key-rotating-runner.js";
import { getModelCatalogEntry } from "./models.js";
import { applyProxyConfig } from "./proxy.js";
import { closeAppThenDrainUsage, UsageReconciler } from "./usage-reconciler.js";
import {
  installSandClientHeaderHook,
  isSandClientHookPatched,
  resolveCursorClientType,
  runWithCursorClientType,
  setGlobalCursorClientType,
  waitForSandClientHook
} from "./sand-client.js";
import {
  applyCursorSdkNetworkConfig,
  loadCursorSdkUseHttp1ForAgent,
  loadProxyUrl,
  setAgentTransportResetter
} from "./sdk-network.js";
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
const store = new SqliteStateStore(config.sqlitePath, { requestLogKeep: config.requestLogKeep });
// Sand 总开关必须在任何 @cursor/sdk import 之前落到 __cursorClientType。
// HTTP/1 配置会动态 import SDK，不能放在 setGlobal 前面。
config.sandClientMode = await loadSandClientMode(store, config.sandClientMode);
setGlobalCursorClientType(config.sandClientMode ? "sand" : "sdk");

/*
 * 代理必须在第一次 import("@cursor/sdk") 之前装好。
 * 不是因为 dispatcher / globalAgent 会被快照（它们都是每次请求现取的），
 * 而是因为文件末尾的预热会立刻做一次「API key 兑换 access token」：
 * SDK 的鉴权拦截器把这一步的失败永久缓存在闭包里（无 TTL、无重置路径），
 * 所以预热若先走直连而失败，共享执行器就在整个进程生命周期内被污染，
 * 之后每个请求都会立刻重抛同一个错误，只能重启才能恢复。
 * 另外 HTTP_PROXY 等环境变量只对设置之后 spawn 的子进程生效（agent 的 shell 工具会用到）。
 */
config.proxyUrl = await loadProxyUrl(store, config.proxyUrl);
// HTTP/1.1 的解析必须排在代理地址之后：没人表过态时，「配了代理」本身就是打开它的理由，
// 否则模型流量会绕过代理直连——这正是「配了代理还是超时」的成因。
const http1 = await loadCursorSdkUseHttp1ForAgent(store, {
  proxyConfigured: Boolean(config.proxyUrl),
  fallback: config.cursorSdkUseHttp1ForAgent
});
config.cursorSdkUseHttp1ForAgent = http1.enabled;
const proxy = applyProxyConfig(config.proxyUrl, { useHttp1ForAgent: config.cursorSdkUseHttp1ForAgent });
for (const warning of proxy.warnings) console.warn(`[proxy] ${warning}`);
if (http1.source === "proxy") {
  console.log("Cursor SDK HTTP/1.1 auto-enabled by outbound proxy (HTTP/2 cannot be proxied; set CURSOR_SDK_USE_HTTP1_FOR_AGENT=false to opt out)");
}

if (config.cursorSdkUseHttp1ForAgent) {
  await applyCursorSdkNetworkConfig(true);
}
// 管理后台持久化的模型默认开关优先于 env 默认值。
config.cursorMaxMode = await loadCursorMaxModeDefault(store, config.cursorMaxMode);
config.cursorFast = await loadCursorFastDefault(store, config.cursorFast);
// 自动禁用策略同样以后台持久化设置优先，改完即时生效且重启后保留。
config.autoDisableKeys = await loadAutoDisableKeys(store, config.autoDisableKeys);
config.autoDisableThreshold = await loadAutoDisableThreshold(store, config.autoDisableThreshold);
// 取用策略与会话粘性同样以后台持久化设置优先。
config.routingStrategy = await loadRoutingStrategy(store, config.routingStrategy);
config.sessionAffinity = await loadSessionAffinity(store, config.sessionAffinity);
config.sessionAffinityTtlMs = await loadSessionAffinityTtlMs(store, config.sessionAffinityTtlMs);
const systemPrompt = await loadSystemPromptSettings(store, {
  mode: config.systemPromptMode,
  ...(config.systemPrompt ? { text: config.systemPrompt } : {})
});
config.systemPromptMode = systemPrompt.mode;
config.systemPrompt = systemPrompt.text;
const keyPool = new CursorKeyPool(store, {
  enabled: config.autoDisableKeys,
  threshold: config.autoDisableThreshold
}, {
  strategy: config.routingStrategy,
  sessionAffinity: config.sessionAffinity,
  sessionAffinityTtlMs: config.sessionAffinityTtlMs
});
await keyPool.seedFromEnv(config.cursorApiKeys);

// 对外网关密钥池：把 env 的 GATEWAY_API_KEY 播种进库，之后就能在后台加更多密钥并逐个限定可用的 Cursor key。
const gatewayKeyPool = new GatewayKeyPool(store);
await gatewayKeyPool.seedFromEnv(config.gatewayApiKey);
await gatewayKeyPool.refresh();

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

// 运行期切 HTTP/1.1 时，光写 SDK 的模块状态不够：已经建好的传输层不会改协议。
// 放掉预热租约让引用计数归零，SDK 才会 dispose 旧执行器，下一个请求拿到的才是新协议的传输层。
setAgentTransportResetter(() => executorLeases.releaseAll());

// D9：无论 kill switch 还是 durable，都注入一份共享有界内存 store，禁止 omit 后落到 SDK 每 agent SQLite。
// kill switch 打开：TTL 保持今日 10min（createEphemeralAgentStore 无参默认）。
// kill switch 关闭（即便 WP7 前有人设 env）：idle TTL 用 cursorSdkSessionIdleTtlMs，仍有界。
const localAgentStore = createEphemeralAgentStore(
  config.cursorSdkDisableSessionResume
    ? undefined
    : {
        idleTtlMs: config.cursorSdkSessionIdleTtlMs,
        maxAgents: config.cursorSdkMaxLiveSessions
      }
);
// 生产默认 durable（kill switch 关 + sessionMode=durable）→ 建 Hub。kill switch 打开则不建。
const useDurableHub = shouldUseDurableHub(config);
const sessionHub = useDurableHub
  ? new SessionHub({
      holdTtlMs: config.cursorSdkToolHoldTtlMs,
      idleTtlMs: config.cursorSdkSessionIdleTtlMs,
      maxLiveSessions: config.cursorSdkMaxLiveSessions,
      store
    })
  : undefined;

const sdkRunner = new CursorSdkRunner(store, {
  defaultWorkingDirectory: config.cursorWorkingDirectory,
  sdkClientVersion: config.sdkClientVersion,
  disableSessionResume: config.cursorSdkDisableSessionResume,
  allowBuiltinTools: config.cursorAllowBuiltinTools,
  executorLeases,
  localAgentStore,
  getModelCatalog: getModelCatalogEntry,
  sessionHub
});
const runner = new KeyRotatingRunner(sdkRunner, keyPool, {
  maxKeyAttempts: config.maxKeyAttempts,
  maxTransientAttempts: config.maxTransientAttempts,
  resolveGlobalClientType: () => config.sandClientMode ? "sand" : "sdk"
});

/*
 * 金额是 Cursor 服务端算的、最终一致的：run 刚结束时往往还查不到，
 * 而 getUsage 又是一次真实网络调用。所以放到带外队列里延迟补写，
 * 绝不进入 HTTP 响应的关键路径。token 用量本身在请求路径上就从 SDK 流里拿到了。
 */
const usageReconciler = new UsageReconciler({
  store,
  // kill switch 打开：每个请求都是全新 agent，不落基线（今日）。
  // kill switch 关闭：runner 仍可能跨请求复用 agent（旧 resume，以及 WP3+ durable Hub），必须记增量。
  // durable 时 shouldUseDurableHub 为 true；它蕴含 kill switch 关闭，与 !disable 一并写明意图。
  trackAgentBaseline: useDurableHub || !config.cursorSdkDisableSessionResume
});

const app = createApp({
  config,
  store,
  runner,
  keyPool,
  gatewayKeyPool,
  usageReconciler,
  startedAt: Date.now()
});

await app.listen({ host: config.host, port: config.port });
console.log(`Docker Composer API listening on http://${config.host}:${config.port}`);
console.log(`Admin panel available at /admin (${config.adminPassword ? "enabled" : "disabled: set ADMIN_PASSWORD"})`);
if (config.cursorSdkDisableSessionResume) {
  console.log("Cursor SDK kill switch on: session resume disabled (stateless per request: create+full prompt+cancel+dispose)");
} else if (useDurableHub) {
  console.log(
    `Cursor SDK session mode: durable (idle ttl ${Math.round(config.cursorSdkSessionIdleTtlMs / 1000)}s, max ${config.cursorSdkMaxLiveSessions})`
  );
} else {
  console.log("Cursor SDK session mode: stateless (SESSION_MODE=stateless; kill switch off)");
}
if (config.cursorSdkUseHttp1ForAgent) console.log("Cursor SDK local agent HTTP/1.1 mode enabled");
if (config.sandClientMode) console.log("Cursor Sand channel enabled globally (per-key overrides still apply)");
console.log(
  `Key routing: ${config.routingStrategy}` +
  (config.sessionAffinity ? `, session affinity on (ttl ${Math.round(config.sessionAffinityTtlMs / 1000)}s)` : ", session affinity off")
);
if (proxy.enabled) {
  console.log(
    `Outbound proxy: ${proxy.url} (model traffic ${proxy.modelTrafficProxied ? "proxied" : "NOT proxied — enable HTTP/1.1"})`
  );
}
if (config.systemPromptMode !== "off" && config.systemPrompt) {
  console.log(`Default system prompt: ${config.systemPromptMode} (${config.systemPrompt.length} chars)`);
}

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
    // 原生工作区扫描在部分宿主会以 access violation 打挂进程，而这是 try/catch 抓不到的，
    // 所以这里必须能整块跳过；跳过只是让首请求多花一次冷启动，功能不受影响。
    if (!config.cursorPrewarm) {
      console.log("Cursor workspace prewarm skipped (CURSOR_PREWARM=false)");
      return;
    }
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
// Fastify 先关 HTTP 入口会等待在途请求收尾；只有这一步完成后才关闭补写器，
// 否则在途请求完成时排入的金额会被 closed 闸门静默丢掉。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      await closeAppThenDrainUsage(
        () => app.close().catch(() => undefined),
        usageReconciler
      );
      // durable 活句柄必须在放掉执行器租约前后限时 dispose，否则 agent 子进程会泄漏到强杀。
      if (sessionHub) {
        console.log(`[shutdown] dropping ${sessionHub.size} durable live session(s)`);
        await sessionHub.dropAll().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[shutdown] sessionHub.dropAll failed: ${message.slice(0, 200)}`);
        });
      }
      await executorLeases.releaseAll();
      process.exit(0);
    })();
  });
}
