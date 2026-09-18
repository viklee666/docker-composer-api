import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { DEFAULT_MODEL_PARAM_POLICY } from "../src/model-param-policy.js";
import { providerModelDefaults, providerRequestTimeoutMs } from "../src/provider-settings.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunRequest, CursorRunner, CursorStreamEvent, GatewayConfig } from "../src/types.js";
import { encodeEnvelope } from "../src/cursor-bot/envelope.js";
import { ProviderRoutingRunner } from "../src/cursor-bot/routing-runner.js";
import { InferenceStreamRequest, InferenceStreamResponse, InferenceTextStreamPart } from "../src/cursor-bot/proto/inference_pb.js";
import { botAutoDisablePolicy, botSettings, CursorBotService } from "../src/cursor-bot/service.js";
import { CursorBotStore } from "../src/cursor-bot/store.js";
import {
  loadCursorFastPolicy,
  loadCursorReasoningEffort,
  loadProviderRunOverrides,
  saveProviderRunOverrides
} from "../src/gateway-settings.js";

/*
 * 包 A（计划 §3.5）：SDK / Bot 运行设置隔离。
 *
 * 覆盖四条要求：
 * 1. provider 不同 ⇒ 解析出不同 intent（单元级 + 走 HTTP 的端到端）；
 * 2. 旧 setting key 迁移后值不变（读侧映射，升级生命线）；
 * 3. 未设置 override 时行为与现状一致；
 * 4. admin 两侧表单互不影响（后端分支级）。
 */

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({}), sqlitePath: ":memory:", ...overrides };
}

/* ------------------------------------------------ 加载 / 保存（迁移与兼容） */

test("provider overrides load as nothing on a fresh store (upgrade keeps prior behavior)", async () => {
  const store = new MemoryStateStore();
  assert.equal(await loadProviderRunOverrides(store, "sdk"), undefined);
  assert.equal(await loadProviderRunOverrides(store, "bot"), undefined);
});

test("legacy global keys still feed both routes as shared defaults", async () => {
  // 老库只有旧全局 key（后台保存过的顶层设置），没有任何 sdk* / bot* 键。
  const store = new MemoryStateStore();
  await store.setSetting("cursorReasoningEffort", "high");
  await store.setSetting("cursorFastPolicy", "force-selected");
  await store.setSetting("cursorFastModels", JSON.stringify(["composer-2.5"]));

  // 按 index.ts 启动时的顺序恢复：旧 key → 顶层字段（两侧共同默认值），再加载两侧覆盖。
  const config = baseConfig();
  config.cursorReasoningEffort = await loadCursorReasoningEffort(store, config.cursorReasoningEffort);
  config.cursorFastPolicy = await loadCursorFastPolicy(store, config.cursorFastPolicy ?? DEFAULT_MODEL_PARAM_POLICY);
  config.sdkOverrides = await loadProviderRunOverrides(store, "sdk");
  config.botOverrides = await loadProviderRunOverrides(store, "bot");

  assert.equal(config.sdkOverrides, undefined, "没有 per-provider 键就不该有覆盖对象");
  assert.equal(config.botOverrides, undefined);
  // 升级生命线：两侧都照旧吃到旧值，绝不回默认值。
  assert.equal(providerModelDefaults(config, "sdk", "composer-2.5").reasoningEffort, "high");
  assert.equal(providerModelDefaults(config, "bot", "composer-2.5").reasoningEffort, "high");
  assert.equal(providerModelDefaults(config, "sdk", "composer-2.5").fast, true);
  assert.equal(providerModelDefaults(config, "bot", "composer-2.5").fast, true);
});

test("provider overrides round-trip through the settings store", async () => {
  const store = new MemoryStateStore();
  await saveProviderRunOverrides(store, "bot", {
    reasoningEffort: "high",
    fastPolicy: { mode: "force-selected", models: ["grok-4.6"] },
    autoDisableKeys: false,
    autoDisableThreshold: 3,
    requestTimeoutMs: 120_000,
    sendTools: true,
    codec: "json",
    autoRefreshFromKey: false
  });
  const loaded = await loadProviderRunOverrides(store, "bot");
  assert.ok(loaded);
  assert.equal(loaded.reasoningEffort, "high");
  assert.deepEqual(loaded.fastPolicy, { mode: "force-selected", models: ["grok-4.6"] });
  assert.equal(loaded.autoDisableKeys, false);
  assert.equal(loaded.autoDisableThreshold, 3);
  assert.equal(loaded.requestTimeoutMs, 120_000);
  assert.equal(loaded.sendTools, true);
  assert.equal(loaded.codec, "json");
  assert.equal(loaded.autoRefreshFromKey, false);
});

test("clearing a provider override (empty value) falls back to the shared default", async () => {
  const store = new MemoryStateStore();
  await saveProviderRunOverrides(store, "sdk", { reasoningEffort: "high", autoDisableKeys: false });
  await saveProviderRunOverrides(store, "sdk", {});
  assert.equal(await loadProviderRunOverrides(store, "sdk"), undefined, "整包清空后读侧应回到未覆盖");
});

/* ------------------------------------------------ 取值口径（provider ⇒ intent） */

test("providerModelDefaults resolves per-side overrides and falls back to the shared config", () => {
  const config = baseConfig({
    cursorReasoningEffort: "low",
    cursorAgentMode: "agent",
    cursorFastPolicy: { mode: "passthrough", models: [] },
    cursorMaxModePolicy: { mode: "passthrough", models: [] },
    sdkOverrides: { reasoningEffort: "medium" },
    botOverrides: {
      reasoningEffort: "high",
      fastPolicy: { mode: "force-selected", models: ["grok-4.6"] },
      agentMode: "plan"
    }
  });

  const sdk = providerModelDefaults(config, "sdk", "grok-4.6");
  assert.equal(sdk.reasoningEffort, "medium", "SDK 侧覆盖优先");
  assert.equal(sdk.fast, false, "SDK 侧未覆盖回落顶层 passthrough（显式 false）");
  assert.equal(sdk.mode, "agent");

  const bot = providerModelDefaults(config, "bot", "grok-4.6");
  assert.equal(bot.reasoningEffort, "high", "Bot 侧覆盖与 SDK 侧互不串味");
  assert.equal(bot.fast, true, "Bot 侧 force-selected 命中名单内模型");
  assert.equal(providerModelDefaults(config, "bot", "composer-2.5").fast, false, "名单外模型不吃强制开启");
  assert.equal(bot.mode, "plan");

  // provider 缺省（selectProvider 回落 sdk）按 SDK 处理，与改造前一致。
  assert.equal(providerModelDefaults(config, undefined, "grok-4.6").reasoningEffort, "medium");

  // 完全没有覆盖时与顶层逐字段相同（未设置 override ⇒ 行为不变）。
  const bare = baseConfig({ cursorReasoningEffort: "low" });
  assert.equal(providerModelDefaults(bare, "sdk", "composer-2.5").reasoningEffort, "low");
  assert.equal(providerModelDefaults(bare, "bot", "composer-2.5").reasoningEffort, "low");
});

test("providerRequestTimeoutMs takes the side override, falling back to the global value", () => {
  const config = baseConfig({ requestTimeoutMs: 30_000, botOverrides: { requestTimeoutMs: 120_000 } });
  assert.equal(providerRequestTimeoutMs(config, "bot"), 120_000);
  assert.equal(providerRequestTimeoutMs(config, "sdk"), 30_000);
  assert.equal(providerRequestTimeoutMs(config, undefined), 30_000);
});

/* ------------------------------------------------ Bot 侧设置（botSettings / 禁用策略） */

test("botSettings falls back from bot overrides to env defaults", () => {
  const envOnly = baseConfig({ botCodec: "json", botSendTools: true });
  assert.equal(botSettings(envOnly).codec, "json");
  assert.equal(botSettings(envOnly).sendTools, true);

  const overridden = baseConfig({ botCodec: "json", botSendTools: true, botOverrides: { codec: "proto", sendTools: false } });
  assert.equal(botSettings(overridden).codec, "proto");
  assert.equal(botSettings(overridden).sendTools, false);

  const refreshOff = baseConfig({ botAutoRefreshFromKey: true, botOverrides: { autoRefreshFromKey: false } });
  assert.equal(botSettings(refreshOff).autoRefreshFromKey, false);
  assert.equal(botSettings(baseConfig({})).autoRefreshFromKey, true);
});

test("bot auto-disable policy keeps its own defaults and does not inherit the SDK pool knobs", () => {
  // 刻意不回落顶层：SDK 侧关掉自动禁用不能顺手拆掉 Bot 凭据的护栏（阈值同理）。
  const config = baseConfig({ autoDisableKeys: false, autoDisableThreshold: 2 });
  assert.deepEqual(botAutoDisablePolicy(config), { enabled: true, threshold: 5 });
  assert.deepEqual(
    botAutoDisablePolicy(baseConfig({ botOverrides: { autoDisableKeys: false, autoDisableThreshold: 2 } })),
    { enabled: false, threshold: 2 }
  );
});

/* -------------------------------- Bot sendTools 运行期生效（不固化启动快照） */

function botFramesResponse(): Response {
  const frames = [
    encodeEnvelope(
      new InferenceStreamResponse({
        response: { case: "textPart", value: new InferenceTextStreamPart({ text: "ok" }) }
      }).toBinary()
    ),
    encodeEnvelope(new TextEncoder().encode("{}"), { endStream: true })
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      }
    }),
    { status: 200 }
  );
}

test("bot sendTools takes effect at runtime without rebuilding the service", async () => {
  const store = CursorBotStore.open(":memory:");
  store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const upstream: InferenceStreamRequest[] = [];
  const config = baseConfig({ botSendTools: false });
  const service = new CursorBotService({
    store,
    config,
    fetchImpl: async (_url, init) => {
      // 剥掉 Connect 信封的 5 字节帧头，剩下的就是 InferenceStreamRequest 的 proto 编码。
      const body = init.body as Uint8Array;
      upstream.push(InferenceStreamRequest.fromBinary(body.subarray(5)));
      return botFramesResponse();
    }
  });
  const run: CursorRunRequest = {
    protocol: "openai-chat",
    apiKey: "unused",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "owner",
    images: [],
    tools: [{ name: "get_weather" }]
  } as CursorRunRequest;

  for await (const _ of service.stream(run)) void _;
  assert.equal(upstream[0].tools.length, 0, "env 默认（false）时不向上游声明工具");
  assert.deepEqual(upstream[0].acceptedUnadvertisedToolNames, []);

  // 后台保存 Bot 覆盖 = 写回 config.botOverrides；service 每次 stream 现查，立即生效。
  // 默认推理出口是 direct：sendTools 打开也不写 tools[]，改走未声明工具名。
  config.botOverrides = { sendTools: true };
  for await (const _ of service.stream(run)) void _;
  assert.equal(upstream[1].tools.length, 0, "直连即使 sendTools=true 也不写 tools[]");
  assert.deepEqual(upstream[1].acceptedUnadvertisedToolNames, ["get_weather"]);

  for await (const _ of service.stream({ ...run, model: "grok-4.6" })) void _;
  assert.equal(upstream[2].tools.length, 0, "grok 即使 sendTools=true 也不向上游声明 tools[]");
  assert.deepEqual(upstream[2].acceptedUnadvertisedToolNames, ["get_weather"]);

  config.botOverrides = { sendTools: true, inferenceRoute: "relay" };
  for await (const _ of service.stream(run)) void _;
  assert.equal(upstream[3].tools.length, 1, "relay 上 composer 仍声明 tools[]");
  assert.deepEqual(upstream[3].acceptedUnadvertisedToolNames, []);

  config.botOverrides = { sendTools: false };
  for await (const _ of service.stream(run)) void _;
  assert.equal(upstream[4].tools.length, 0, "改回 false 同样立即生效");
  assert.deepEqual(upstream[4].acceptedUnadvertisedToolNames, []);
  store.close();
});

/* ------------------------------------------------ admin 两侧表单互不影响 */

const ADMIN_PASSWORD = "provider-settings-admin";

class StubRunner implements CursorRunner {
  async run() {
    return { text: "ok", toolCalls: [] };
  }
  async *stream(): AsyncIterable<CursorStreamEvent> {
    yield { type: "done", result: { text: "ok", toolCalls: [] } };
  }
}

async function providerSettingsApp(t: TestContext): Promise<{ app: FastifyInstance; store: MemoryStateStore; config: GatewayConfig; keyPool: CursorKeyPool }> {
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key-a"]);
  const config = baseConfig({
    adminPassword: ADMIN_PASSWORD,
    gatewayApiKey: "gateway-key",
    cursorReasoningEffort: "low"
  });
  const app = createApp({
    config,
    store,
    keyPool,
    runner: new KeyRotatingRunner(new StubRunner(), keyPool),
    applyCursorSdkNetworkConfig: async () => undefined,
    modelLister: async () => ({ models: [{ id: "composer-2.5", name: "Composer 2.5", aliases: [] }], source: "cursor" })
  });
  t.after(() => app.close());
  return { app, store, config, keyPool };
}

function postSettings(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
    payload
  });
}

test("saving sdk overrides does not touch the bot side or the shared config", async (t) => {
  const { app, store, config, keyPool } = await providerSettingsApp(t);
  const response = await postSettings(app, { sdkOverrides: { reasoningEffort: "medium", autoDisableThreshold: 7 } });
  assert.equal(response.statusCode, 200);

  assert.equal(config.sdkOverrides?.reasoningEffort, "medium");
  assert.equal(config.sdkOverrides?.autoDisableThreshold, 7);
  assert.equal(keyPool.autoDisablePolicy.threshold, 7, "SDK 侧阈值要联动 key 池（运行期生效）");
  assert.equal(config.botOverrides, undefined, "Bot 侧未被触碰");
  assert.equal(config.cursorReasoningEffort, "low", "顶层公共默认未被触碰");

  assert.equal(await store.getSetting("sdkReasoningEffort"), "medium");
  assert.equal(await store.getSetting("botReasoningEffort"), undefined, "没有写过 bot 侧的键");

  const echoed = response.json().config;
  assert.equal(echoed.sdkOverrides.reasoningEffort, "medium");
  assert.equal(echoed.botOverrides.reasoningEffort, "", "未覆盖回显为空（前端显示「跟随」）");
});

test("saving bot overrides does not touch the sdk side or the shared config", async (t) => {
  const { app, store, config } = await providerSettingsApp(t);
  const response = await postSettings(app, {
    botOverrides: { reasoningEffort: "high", sendTools: true, codec: "json", requestTimeoutMs: 120_000, autoRefreshFromKey: false }
  });
  assert.equal(response.statusCode, 200);

  assert.equal(config.botOverrides?.reasoningEffort, "high");
  assert.equal(config.botOverrides?.sendTools, true);
  assert.equal(config.botOverrides?.codec, "json");
  assert.equal(config.botOverrides?.requestTimeoutMs, 120_000);
  assert.equal(config.botOverrides?.autoRefreshFromKey, false);
  assert.equal(config.sdkOverrides, undefined, "SDK 侧未被触碰");
  assert.equal(config.cursorReasoningEffort, "low", "顶层公共默认未被触碰");

  assert.equal(await store.getSetting("botReasoningEffort"), "high");
  assert.equal(await store.getSetting("botSendTools"), "on");
  assert.equal(await store.getSetting("botCodec"), "json");
  assert.equal(await store.getSetting("botAutoRefreshFromKey"), "off");
  assert.equal(await store.getSetting("sdkReasoningEffort"), undefined);

  // 保存后 botSettings 立即反映（同一进程内 bot 路线下次请求就用新值，无需重启）。
  assert.equal(botSettings(config).sendTools, true);
  assert.equal(botSettings(config).codec, "json");
  assert.equal(botSettings(config).autoRefreshFromKey, false);
  assert.equal(providerModelDefaults(config, "bot", "composer-2.5").reasoningEffort, "high");
  assert.equal(providerModelDefaults(config, "sdk", "composer-2.5").reasoningEffort, "low");
  assert.equal(providerRequestTimeoutMs(config, "bot"), 120_000);
  assert.equal(providerRequestTimeoutMs(config, "sdk"), config.requestTimeoutMs);
});

test("clearing a bot override via null restores the shared default", async (t) => {
  const { app, store, config } = await providerSettingsApp(t);
  await postSettings(app, { botOverrides: { sendTools: true, reasoningEffort: "high", autoRefreshFromKey: false } });
  assert.equal(config.botOverrides?.sendTools, true);

  const response = await postSettings(app, { botOverrides: { sendTools: null, reasoningEffort: null, autoRefreshFromKey: null } });
  assert.equal(response.statusCode, 200);
  assert.equal(config.botOverrides?.sendTools, undefined, "null = 恢复跟随全局");
  assert.equal(config.botOverrides?.reasoningEffort, undefined);
  assert.equal(config.botOverrides?.autoRefreshFromKey, undefined);
  assert.equal(botSettings(config).sendTools, false, "回落 env 默认（false）");
  assert.equal(botSettings(config).autoRefreshFromKey, true, "回落 env 默认（开）");
  assert.equal(providerModelDefaults(config, "bot", "composer-2.5").reasoningEffort, "low");
  assert.equal(await store.getSetting("botSendTools"), "", "落库为空串 = 未覆盖标记");
  assert.equal(await loadProviderRunOverrides(store, "bot"), undefined, "全部清掉后读侧回到未覆盖");
});

test("invalid provider override values are rejected per field", async (t) => {
  const { app } = await providerSettingsApp(t);
  assert.equal((await postSettings(app, { botOverrides: { reasoningEffort: "sideways" } })).statusCode, 400);
  assert.equal((await postSettings(app, { botOverrides: { requestTimeoutMs: 100 } })).statusCode, 400);
  assert.equal((await postSettings(app, { sdkOverrides: { autoDisableThreshold: 99 } })).statusCode, 400);
  assert.equal((await postSettings(app, { sdkOverrides: { fastPolicy: "always" } })).statusCode, 400);
  assert.equal((await postSettings(app, { botOverrides: { codec: "msgpack" } })).statusCode, 400);
  assert.equal((await postSettings(app, { botOverrides: { autoRefreshFromKey: "yes" } })).statusCode, 400);
});

/* ------------------------------------------------ 端到端：provider ⇒ 不同 intent */

test("the same request resolves different intents per provider through the HTTP entry", async (t) => {
  const botStore = CursorBotStore.open(":memory:");
  botStore.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const config = baseConfig({
    adminPassword: ADMIN_PASSWORD,
    gatewayApiKey: "gateway-key",
    cursorReasoningEffort: "low",
    botOverrides: { reasoningEffort: "high" }
  });
  const bot = new CursorBotService({
    store: botStore,
    config,
    fetchImpl: async (url) => {
      // 目录查询让它失败：intent 断言只看请求意图，不依赖目录解析（失败会走家族兜底）。
      if (url.includes("AvailableModels")) return new Response("nope", { status: 500 });
      return botFramesResponse();
    }
  });
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key-a"]);
  const runner = new ProviderRoutingRunner({
    sdk: new KeyRotatingRunner(new StubRunner(), keyPool),
    bot
  });
  const app = createApp({
    config,
    store,
    keyPool,
    runner,
    bot,
    applyCursorSdkNetworkConfig: async () => undefined,
    modelLister: async () => ({
      models: [
        { id: "composer-2.5", name: "Composer 2.5", aliases: [] },
        { id: "grok-4.6", name: "Grok 4.6", aliases: ["grok"] }
      ],
      source: "cursor"
    })
  });
  t.after(() => {
    botStore.close();
    return app.close();
  });

  const post = (model: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer gateway-key", "content-type": "application/json" },
      payload: { model, messages: [{ role: "user", content: "hi" }] }
    });

  assert.equal((await post("bot/grok-4.6")).statusCode, 200, "bot/ 前缀选 Bot 路线");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const botLog = (await logs(app)).find((entry) => entry.endpoint === "/v1/chat/completions");
  assert.ok(botLog);
  assert.equal(botLog.provider, "bot");
  assert.equal(botLog.reasoningEffort, "high", "Bot 侧覆盖生效");

  assert.equal((await post("composer-2.5")).statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 日志按最新在前排序，find 取到的就是刚完成的这一条。
  const sdkLog = (await logs(app)).find((entry) => entry.endpoint === "/v1/chat/completions");
  assert.ok(sdkLog);
  assert.equal(sdkLog.provider, "sdk");
  assert.equal(sdkLog.reasoningEffort, "low", "SDK 侧走公共默认");
});

async function logs(app: FastifyInstance) {
  const response = await app.inject({
    method: "GET",
    url: "/admin/api/logs",
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` }
  });
  assert.equal(response.statusCode, 200);
  return response.json().logs as Array<{ endpoint: string; provider?: string; reasoningEffort?: string }>;
}
