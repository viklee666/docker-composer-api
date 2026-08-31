import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createEphemeralAgentStore } from "../src/agent-store.js";
import { anthropicError, anthropicErrorType, ApiError, newRequestId, openAiError, openAiErrorType, openAiStatus } from "../src/errors.js";
import { CursorSdkRunner, toolCallsFromSdkEvent, upstreamRunError, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { ExecutorWarmPool } from "../src/executor-warmup.js";
import { GatewayKeyPool } from "../src/gateway-key-pool.js";
import { CursorKeyPool, classifyKeyFailure, indicatesUpstreamAuthFailure, type AutoDisablePolicy } from "../src/key-pool.js";
import { KeyRotatingRunner, type KeyRotatingOptions } from "../src/key-rotating-runner.js";
import { parseModelSpec, resolveModelParams, type ModelCatalog } from "../src/model-params.js";
import type { ModelLister } from "../src/models.js";
import { parseToolMarkers } from "../src/protocol.js";
import { sessionBindingHash } from "../src/routing.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore, SqliteStateStore } from "../src/store.js";
import { normalizeToolCallForClient } from "../src/tool-compat.js";
import { UsageReconciler } from "../src/usage-reconciler.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayConfig,
  GatewayTool,
  ModelScope,
  RequestLogRecord,
  RunTelemetryRef
} from "../src/types.js";

const baseConfig: GatewayConfig = {
  host: "127.0.0.1",
  port: 0,
  cursorApiKeys: ["server-cursor-key"],
  gatewayApiKey: "gateway-key",
  adminPassword: "gateway-key",
  allowDirectCursorKeys: true,
  sqlitePath: ":memory:",
  requestLogKeep: 0,
  cursorWorkingDirectory: "/workspace",
  requestTimeoutMs: 10_000,
  sdkClientVersion: "sdk-1.0.27",
  cursorSdkDisableSessionResume: true,
  cursorSdkUseHttp1ForAgent: false,
  cursorAllowBuiltinTools: false,
  maxKeyAttempts: 10,
  maxTransientAttempts: 3,
  autoDisableKeys: true,
  autoDisableThreshold: 2,
  sandClientMode: false,
  routingStrategy: "fill-first",
  sessionAffinity: false,
  sessionAffinityTtlMs: 60 * 60 * 1000,
  systemPromptMode: "off",
  cursorPrewarm: false
};

test("health and models are available", async () => {
  const { app } = await createTestApp();
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const models = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(models.statusCode, 200);
  assert.equal(models.json().object, "list");
  assert.ok(models.body.includes("composer-2.5"));
});

test("models endpoint serves upstream list with auth and supports retrieval by id or alias", async () => {
  const { app } = await createTestApp();
  const listed = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(listed.statusCode, 200);
  const ids = listed.json().data.map((model: { id: string }) => model.id);
  assert.deepEqual(ids, ["composer-2.5", "claude-fable-5"]);

  const byId = await app.inject({ method: "GET", url: "/v1/models/composer-2.5" });
  assert.equal(byId.statusCode, 200);
  assert.equal(byId.json().object, "model");

  const byAlias = await app.inject({
    method: "GET",
    url: "/v1/models/fable",
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(byAlias.statusCode, 200);
  assert.equal(byAlias.json().id, "claude-fable-5");

  const missing = await app.inject({
    method: "GET",
    url: "/v1/models/not-a-model",
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(missing.statusCode, 404);
});

test("models endpoint does not send an unregistered direct token to the model lister", async () => {
  const asked: (string | undefined)[] = [];
  const { app } = await createTestApp({
    modelLister: async (apiKey) => {
      asked.push(apiKey);
      return {
        models: [{ id: "composer-2.5", name: "Composer", aliases: [] }],
        source: "cursor"
      };
    }
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer unregistered-direct-token" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(asked, [undefined]);
});

test("models endpoint applies a registered direct key's own model scope", async () => {
  const { app, keyPool } = await createTestApp({ keys: ["server-cursor-key", "other-cursor-key"] });
  const direct = (await keyPool.list()).find((key) => key.apiKey === "server-cursor-key");
  assert.ok(direct);
  await keyPool.setModelScope(direct.id, { allowed: [], excluded: ["claude-fable-5"] });

  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer server-cursor-key" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().data.map((model: { id: string }) => model.id),
    ["composer-2.5"]
  );
});

test("chat completions supports gateway auth via key pool", async () => {
  const runner = new FakeRunner({ text: "hello from composer" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.choices[0].message.content, "hello from composer");
  assert.equal(runner.lastApiKey, "server-cursor-key");
});

test("chat completions supports direct Cursor key auth and SSE", async () => {
  const runner = new FakeRunner({ chunks: ["he", "llo"] });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] as string, /text\/event-stream/);
  assert.match(response.body, /chat\.completion\.chunk/);
  assert.match(response.body, /data: \[DONE\]/);
  assert.equal(runner.lastApiKey, "direct-cursor-key");
});

test("gateway requests rotate to next key on quota error and disable the failed key", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failFor.set("key-a", "You have hit your usage limit. Payment required.");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 1 } });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "served by key-b");
  assert.equal(runner.lastApiKey, "key-b");

  const keys = await keyPool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a");
  const keyB = keys.find((key) => key.apiKey === "key-b");
  assert.equal(keyA?.status, "disabled");
  assert.equal(keyA?.disabledReason, "额度不足");
  assert.match(keyA?.lastError ?? "", /usage limit/i);
  assert.equal(keyB?.status, "active");
});

test("admin reorder changes which key is tried first", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b", "key-c"] });
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const before = await keyPool.list();
  assert.deepEqual(before.map((key) => key.apiKey), ["key-a", "key-b", "key-c"]);

  const reordered = await app.inject({
    method: "POST",
    url: "/admin/api/keys/reorder",
    headers: adminHeaders,
    payload: { ids: [before[2].id, before[0].id, before[1].id] }
  });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(
    reordered.json().keys.map((key: { sortOrder: number }) => key.sortOrder),
    [1, 2, 3]
  );

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(runner.lastApiKey, "key-c");

  const unknown = await app.inject({
    method: "POST",
    url: "/admin/api/keys/reorder",
    headers: adminHeaders,
    payload: { ids: ["nope"] }
  });
  assert.equal(unknown.statusCode, 404);

  const empty = await app.inject({
    method: "POST",
    url: "/admin/api/keys/reorder",
    headers: adminHeaders,
    payload: { ids: [] }
  });
  assert.equal(empty.statusCode, 400);
});

test("sqlite store migrates legacy cursor_keys table and supports reorder", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "composer-api-test-")), "state.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE cursor_keys (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'manual',
      disabled_reason TEXT,
      disabled_at TEXT,
      last_used_at TEXT,
      last_error TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO cursor_keys (id, api_key, label, created_at) VALUES
      ('id-a', 'legacy-key-a', 'a', '2026-01-01T00:00:00Z'),
      ('id-b', 'legacy-key-b', 'b', '2026-01-02T00:00:00Z');
  `);
  legacy.close();

  const store = new SqliteStateStore(path);
  const migrated = await store.listCursorKeys();
  assert.deepEqual(migrated.map((key) => key.id), ["id-a", "id-b"]);
  assert.ok(migrated.every((key) => key.sortOrder > 0), "sort_order backfilled from rowid");
  assert.ok(migrated.every((key) => key.failureCount === 0), "failure_count 补列后从 0 起算");
  assert.ok(migrated.every((key) => key.clientType === "inherit"), "client_type 补列后默认跟随全局");

  await store.updateCursorKey("id-a", { clientType: "sand" });
  assert.equal((await store.listCursorKeys()).find((key) => key.id === "id-a")?.clientType, "sand");

  await store.updateCursorKey("id-a", { incrementFailureCount: true });
  assert.equal((await store.listCursorKeys()).find((key) => key.id === "id-a")?.failureCount, 1);
  await store.updateCursorKey("id-a", { failureCount: 0 });
  assert.equal((await store.listCursorKeys()).find((key) => key.id === "id-a")?.failureCount, 0);

  await store.reorderCursorKeys(["id-b"]);
  const reordered = await store.listCursorKeys();
  assert.deepEqual(reordered.map((key) => key.id), ["id-b", "id-a"]);
  assert.deepEqual(reordered.map((key) => key.sortOrder), [1, 2]);

  await store.saveSession("session-a", "agent-a");
  assert.equal(await store.getSession("session-a"), "agent-a");
  assert.equal(await store.deleteSession("session-a"), true);
  assert.equal(await store.getSession("session-a"), undefined);
});

test("sqlite store backfills the conversation seed column on a legacy responses table", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "composer-api-test-")), "state.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE responses (
      id TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      input_items_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO responses (id, owner_hash, response_json, input_items_json, created_at, updated_at) VALUES
      ('resp_old', 'owner', '{"id":"resp_old"}', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);
  legacy.close();

  const store = new SqliteStateStore(path);
  // 补列之前存下的响应没有种子：续聊时退回按请求体现算，认不出就不启用粘性，而不是报错。
  const old = await store.getResponse("resp_old", "owner");
  assert.ok(old);
  assert.equal(old.conversationSeed, undefined);
  assert.deepEqual(old.inputItems, []);

  const now = new Date().toISOString();
  const record = { id: "resp_new", ownerHash: "owner", response: {}, inputItems: [], createdAt: now, updatedAt: now };
  await store.saveResponse({ ...record, conversationSeed: "seed-abc" });
  assert.equal((await store.getResponse("resp_new", "owner"))?.conversationSeed, "seed-abc");
  // 覆写同一条记录时种子跟着走，续聊链不会因为一次重写而断掉。
  await store.saveResponse({ ...record, conversationSeed: "seed-def" });
  assert.equal((await store.getResponse("resp_new", "owner"))?.conversationSeed, "seed-def");
  assert.equal(await store.getResponse("resp_new", "other-owner"), undefined);
});

test("returns 429 insufficient_quota when every key is exhausted", async () => {
  const runner = new FakeRunner({});
  runner.failFor.set("key-a", "quota exceeded");
  runner.failFor.set("key-b", "Insufficient credits remaining");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 1 } });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, "insufficient_quota");
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "disabled"));
});

test("non key-level upstream errors do not disable keys", async () => {
  const runner = new FakeRunner({});
  runner.failFor.set("key-a", "upstream timeout while connecting");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 500);
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"));
});

test("transient upstream error rotates to next key without disabling the failed one", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failWith.set("key-a", new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed"));
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "served by key-b");
  assert.equal(runner.lastApiKey, "key-b");

  // transient 不禁用任何 key：队首 key-a 仍 active，额度/容量恢复后无需手动启用。
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"));
});

test("all keys failing transiently surface the upstream error instead of a false 429", async () => {
  const runner = new FakeRunner({});
  runner.failWith.set("key-a", new ApiError("Cursor upstream run ended in error A", 502, "upstream_run_failed"));
  runner.failWith.set("key-b", new ApiError("Cursor upstream run ended in error B", 502, "upstream_run_failed"));
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "upstream_run_failed");
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"));
});

test("classifyKeyFailure distinguishes quota, auth, and transient errors", () => {
  assert.equal(classifyKeyFailure(new Error("You've hit your usage limit")), "quota");
  assert.equal(classifyKeyFailure(new Error("Insufficient credits")), "quota");
  assert.equal(classifyKeyFailure(Object.assign(new Error("Payment Required"), { status: 402 })), "quota");
  assert.equal(classifyKeyFailure(new Error("Invalid API key provided")), "auth");
  assert.equal(classifyKeyFailure(Object.assign(new Error("nope"), { statusCode: 401 })), "auth");
  assert.equal(classifyKeyFailure(new Error("Rate limit exceeded, retry later")), undefined);
  assert.equal(classifyKeyFailure(new Error("connect ETIMEDOUT")), undefined);
  // 上游无详情 error（网关自抛 upstream_run_failed）→ transient，且优先于文案里的 quota 字样。
  assert.equal(
    classifyKeyFailure(new ApiError("Cursor upstream run ended in error: quota/credit exhausted", 502, "upstream_run_failed")),
    "transient"
  );
});

test("indicatesUpstreamAuthFailure covers exactly the failures the SDK auth closure caches forever", () => {
  assert.equal(indicatesUpstreamAuthFailure(new Error("Invalid API key provided")), true);
  assert.equal(indicatesUpstreamAuthFailure(Object.assign(new Error("nope"), { status: 401 })), true);
  assert.equal(
    indicatesUpstreamAuthFailure(new Error("Authentication error. If you are logged in, try logging out and back in.")),
    true
  );
  // SDK 自己的 key 兑换失败文案：正是被永久缓存进鉴权闭包的那个错误。
  assert.equal(
    indicatesUpstreamAuthFailure(new Error("API key exchange succeeded but returned no access token.")),
    true
  );
  // 额度/限流/网络错误不会被鉴权闭包缓存，回收执行器无济于事，也不该白丢预热。
  assert.equal(indicatesUpstreamAuthFailure(new Error("You have hit your usage limit")), false);
  assert.equal(indicatesUpstreamAuthFailure(new Error("Rate limit exceeded, retry later")), false);
  assert.equal(indicatesUpstreamAuthFailure(new Error("connect ETIMEDOUT")), false);
});

test("ExecutorWarmPool releases the prewarm lease on recycle and cools down before warming again", async () => {
  let prewarmCount = 0;
  let releaseCount = 0;
  let now = 1_000;
  const pool = new ExecutorWarmPool({
    loadPlatform: async () => ({
      prewarmLocalWorkspace: async () => {
        prewarmCount += 1;
        return async () => {
          releaseCount += 1;
        };
      }
    }),
    cooldownMs: 60_000,
    now: () => now
  });

  await pool.warm("key-a", "/workspace");
  assert.equal(prewarmCount, 1);
  // 已持有租约时重复预热不能再抓一次引用，否则引用计数永远回不到 0。
  await pool.warm("key-a", "/workspace");
  assert.equal(prewarmCount, 1);
  assert.equal(pool.size, 1);

  await pool.recycle("key-a", "/workspace");
  assert.equal(releaseCount, 1, "回收必须真的释放租约，SDK 才可能 dispose 掉坏执行器");
  assert.equal(pool.size, 0);

  // 冷却窗口内不重新预热：要留时间让在途请求收尾、引用计数归零。
  await pool.warm("key-a", "/workspace");
  assert.equal(prewarmCount, 1);
  assert.equal(pool.size, 0);

  now += 60_001;
  await pool.warm("key-a", "/workspace");
  assert.equal(prewarmCount, 2);

  await pool.releaseAll();
  assert.equal(releaseCount, 2);
  assert.equal(pool.size, 0);
});

test("ExecutorWarmPool releases a prewarm lease that lands after recycle", async () => {
  let releaseCount = 0;
  let startPrewarm!: () => void;
  const prewarmGate = new Promise<void>((resolve) => {
    startPrewarm = resolve;
  });
  const pool = new ExecutorWarmPool({
    loadPlatform: async () => ({
      prewarmLocalWorkspace: async () => {
        await prewarmGate;
        return async () => {
          releaseCount += 1;
        };
      }
    })
  });

  const warming = pool.warm("key-a", "/workspace");
  // 预热尚未落地就回收：晚到的租约必须立刻自行释放，否则它会变成谁也解不掉的引用。
  const recycling = pool.recycle("key-a", "/workspace");
  startPrewarm();
  await Promise.all([warming, recycling]);

  assert.equal(releaseCount, 1);
  assert.equal(pool.size, 0);
});

test("upstream auth failures recycle the shared SDK executor so a poisoned auth closure cannot wedge the key", async () => {
  const recycled: string[] = [];
  const factory: AgentFactory = {
    create: async () => {
      throw Object.assign(new Error("Invalid API Key"), { status: 401, code: "unauthenticated" });
    }
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    executorLeases: {
      warm: async () => undefined,
      recycle: async (apiKey, cwd) => {
        recycled.push(`${apiKey}@${cwd}`);
      },
      releaseAll: async () => ({ ok: true, failures: [] })
    }
  }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 401
  );
  assert.deepEqual(recycled, ["cursor-key@/workspace"]);
});

test("quota failures keep the prewarmed executor instead of throwing away the warm start", async () => {
  const recycled: string[] = [];
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-quota",
      send: async () => new FakeSdkRun({
        waitResult: { status: "error", error: { message: "You have hit your usage limit." } }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    executorLeases: {
      warm: async () => undefined,
      recycle: async (apiKey, cwd) => {
        recycled.push(`${apiKey}@${cwd}`);
      },
      releaseAll: async () => ({ ok: true, failures: [] })
    }
  }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 402
  );
  assert.deepEqual(recycled, []);
});

test("upstreamRunError decouples run-error detail into codes so real bad keys get disabled", () => {
  // 无详情 → transient 软失败（502 upstream_run_failed）：轮换但不禁用。
  const noDetail = upstreamRunError("composer-2.5", "");
  assert.equal(noDetail.statusCode, 502);
  assert.equal(noDetail.code, "upstream_run_failed");
  assert.equal(classifyKeyFailure(noDetail), "transient");

  // 详情命中额度耗尽 → 402，且被判为 quota（会禁用该 key），而非被 transient 吞掉。
  const quota = upstreamRunError("composer-2.5", "You have hit your usage limit. Insufficient credits remaining.");
  assert.equal(quota.statusCode, 402);
  assert.equal(quota.code, "insufficient_quota");
  assert.equal(classifyKeyFailure(quota), "quota");
  assert.ok(!/\bupstream_run_failed\b/.test(quota.message), "quota error must not carry the transient token");

  const invoice = upstreamRunError("composer-2.5", "You have an unpaid invoice. Pay your invoice in Stripe.");
  assert.equal(invoice.statusCode, 402);
  assert.equal(invoice.code, "insufficient_quota");
  assert.equal(classifyKeyFailure(invoice), "quota");

  // 详情命中 key 失效 → 401，被判为 auth（会禁用该 key）。
  const auth = upstreamRunError("composer-2.5", "Invalid API key provided");
  assert.equal(auth.statusCode, 401);
  assert.equal(auth.code, "unauthorized");
  assert.equal(classifyKeyFailure(auth), "auth");
});

test("gateway rotates and disables a key on auth failure", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failFor.set("key-a", "Invalid API key provided");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 1 } });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "served by key-b");
  assert.equal(runner.lastApiKey, "key-b");

  const keys = await keyPool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a");
  const keyB = keys.find((key) => key.apiKey === "key-b");
  assert.equal(keyA?.status, "disabled");
  assert.equal(keyA?.disabledReason, "key 无效/未授权");
  assert.match(keyA?.lastError ?? "", /invalid api key/i);
  assert.equal(keyB?.status, "active");
});

test("a single quota error only rotates; the key is disabled once the streak reaches the threshold", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failFor.set("key-a", "You have hit your usage limit.");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 2 } });
  const chat = () => app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal((await chat()).statusCode, 200);
  const afterFirst = (await keyPool.list()).find((key) => key.apiKey === "key-a");
  assert.equal(afterFirst?.status, "active", "一次失败不该废掉 key");
  assert.equal(afterFirst?.failureCount, 1);
  assert.match(afterFirst?.lastError ?? "", /usage limit/i);

  assert.equal((await chat()).statusCode, 200);
  const afterSecond = (await keyPool.list()).find((key) => key.apiKey === "key-a");
  assert.equal(afterSecond?.status, "disabled");
  assert.equal(afterSecond?.disabledReason, "额度不足");
});

test("a success between failures clears the streak so a flaky key is never disabled", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 2 } });
  const chat = () => app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });

  runner.failFor.set("key-a", "Invalid API key provided");
  await chat();
  assert.equal((await keyPool.list()).find((key) => key.apiKey === "key-a")?.failureCount, 1);

  runner.failFor.delete("key-a");
  await chat();
  const recovered = (await keyPool.list()).find((key) => key.apiKey === "key-a");
  assert.equal(recovered?.status, "active");
  assert.equal(recovered?.failureCount, 0);
  assert.equal(recovered?.lastError, undefined, "成功后不该继续挂着旧错误");

  runner.failFor.set("key-a", "Invalid API key provided");
  await chat();
  assert.equal((await keyPool.list()).find((key) => key.apiKey === "key-a")?.status, "active");
});

test("auto disable can be turned off so keys are only skipped, never disabled", async () => {
  const runner = new FakeRunner({});
  runner.failFor.set("key-a", "Invalid API key provided");
  runner.failFor.set("key-b", "You have hit your usage limit.");
  const { app, keyPool } = await createTestApp({
    runner,
    keys: ["key-a", "key-b"],
    autoDisable: { enabled: false }
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer gateway-key" },
      payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
    });
    // 全部 key 软失败：透出真实上游错误，而不是误报"所有 key 都已被自动禁用"。
    assert.equal(response.statusCode, 500);
    assert.match(response.json().error.message, /usage limit/i);
  }
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"), "关闭自动禁用后不该有 key 被停用");
  assert.ok(keys.every((key) => key.lastError), "仍然记录最近错误供排查");
});

test("manual enable clears the failure streak so the key is not re-disabled by the next error", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failFor.set("key-a", "You have hit your usage limit.");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 2 } });
  const chat = () => app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });

  await chat();
  await chat();
  const keyA = (await keyPool.list()).find((key) => key.apiKey === "key-a")!;
  assert.equal(keyA.status, "disabled");

  const enabled = await app.inject({
    method: "POST",
    url: `/admin/api/keys/${keyA.id}/enable`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(enabled.statusCode, 200);
  const reenabled = (await keyPool.list()).find((key) => key.apiKey === "key-a");
  assert.equal(reenabled?.failureCount, 0);
  assert.equal(reenabled?.lastError, undefined);

  await chat();
  assert.equal((await keyPool.list()).find((key) => key.apiKey === "key-a")?.status, "active", "启用后一次失败不该立刻又被禁");
});

test("admin settings change the auto disable policy at runtime", async () => {
  const { app, keyPool } = await createTestApp();
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const saved = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { autoDisableKeys: false, autoDisableThreshold: 5 }
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().config.autoDisableKeys, false);
  assert.deepEqual(saved.json().config.autoDisableThreshold, 5);
  assert.deepEqual(keyPool.autoDisablePolicy, { enabled: false, threshold: 5 });

  const overview = await app.inject({ method: "GET", url: "/admin/api/overview", headers: adminHeaders });
  assert.equal(overview.json().config.autoDisableKeys, false);
  assert.equal(overview.json().config.autoDisableThreshold, 5);

  const invalid = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { autoDisableThreshold: 0 }
  });
  assert.equal(invalid.statusCode, 400);
});

test("Cursor session auth hiccups rotate keys instead of marking a working key invalid", async () => {
  // Cursor 上游会原样吐出 IDE 那句"退出重新登录"，它不代表 key 失效（同一个 key 之前之后都能跑通）。
  const hiccup = "Authentication error If you are logged in, try logging out and back in";
  assert.equal(classifyKeyFailure(new Error(hiccup)), "transient");
  assert.equal(classifyKeyFailure(Object.assign(new Error(hiccup), { status: 401 })), "transient");
  const wrapped = upstreamRunError("claude-opus-5", `${hiccup}; ERROR: ${hiccup}.`);
  assert.equal(wrapped.statusCode, 502);
  assert.equal(wrapped.code, "upstream_run_failed");
  assert.equal(classifyKeyFailure(wrapped), "transient");

  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failFor.set("key-a", hiccup);
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"], autoDisable: { threshold: 1 } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer gateway-key" },
      payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().choices[0].message.content, "served by key-b");
  }
  const keyA = (await keyPool.list()).find((key) => key.apiKey === "key-a");
  assert.equal(keyA?.status, "active", "会话态认证抖动不该禁用 key，哪怕阈值是 1 次");
  assert.equal(keyA?.failureCount, 0, "transient 不计入自动禁用");
});

test("key rotation stops at maxKeyAttempts instead of trying the whole pool", async () => {
  const allKeys = ["key-a", "key-b", "key-c", "key-d", "key-e"];
  const runner = new FakeRunner({});
  for (const key of allKeys) {
    runner.failWith.set(key, new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed"));
  }
  const { app, keyPool } = await createTestApp({
    runner,
    keys: allKeys,
    runnerOptions: { maxKeyAttempts: 2, maxTransientAttempts: 99 }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 502);
  // 只尝试了上限数量的 key，没有把整池 5 个都试一遍。
  assert.deepEqual(runner.seen, ["key-a", "key-b"]);
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"), "transient failures must not disable keys");
});

test("the maxKeyAttempts guard does not consume an unexecuted round-robin slot", async () => {
  const runner = new FakeRunner({ text: "served by key-b" });
  runner.failWith.set("key-a", new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed"));
  const { app } = await createTestApp({
    runner,
    keys: ["key-a", "key-b"],
    config: { routingStrategy: "round-robin" },
    runnerOptions: { maxKeyAttempts: 1, maxTransientAttempts: 99 }
  });
  const request = () => app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal((await request()).statusCode, 502);
  assert.equal((await request()).statusCode, 200);
  assert.deepEqual(runner.seen, ["key-a", "key-b"]);
});

test("transient failures stop after maxTransientAttempts to avoid burning the whole pool", async () => {
  const allKeys = ["key-a", "key-b", "key-c", "key-d", "key-e"];
  const runner = new FakeRunner({});
  for (const key of allKeys) {
    runner.failWith.set(key, new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed"));
  }
  const { app, keyPool } = await createTestApp({
    runner,
    keys: allKeys,
    runnerOptions: { maxKeyAttempts: 99, maxTransientAttempts: 2 }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "upstream_run_failed");
  // transient 累计到上限即停手，不再继续换 key 烧额度。
  assert.deepEqual(runner.seen, ["key-a", "key-b"]);
  const keys = await keyPool.list();
  assert.ok(keys.every((key) => key.status === "active"));
});

test("responses can be created, retrieved, list input items, and deleted", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "response text" }) });
  const created = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello" }
  });
  assert.equal(created.statusCode, 200);
  const createdBody = created.json();
  assert.equal(createdBody.object, "response");

  const loaded = await app.inject({
    method: "GET",
    url: `/v1/responses/${createdBody.id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.json().id, createdBody.id);

  const items = await app.inject({
    method: "GET",
    url: `/v1/responses/${createdBody.id}/input_items`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(items.statusCode, 200);
  assert.equal(items.json().object, "list");

  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/responses/${createdBody.id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().deleted, true);
});

test("responses stream emits OpenAI Responses events", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["one", " two"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello" }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event: response\.created/);
  assert.match(response.body, /event: response\.output_text\.delta/);
  assert.match(response.body, /event: response\.completed/);
});

// ---------------------------------------------------------------------------
// previous_response_id 续聊的会话粘性
// ---------------------------------------------------------------------------

const RESPONSES_HEADERS = { authorization: "Bearer gateway-key" };
const FIRST_TURN = { model: "composer-2.5", instructions: "You are helpful.", input: "Explain closures." };
const SECOND_TURN = { model: "composer-2.5", input: "Now show me an example." };

/** baseConfig 把粘性关着，这一组用例必须自己开，否则测的是「绑定压根没写」。 */
function stickyResponsesApp(runner: FakeRunner, config: Partial<GatewayConfig> = {}, keys?: string[]) {
  return createTestApp({ runner, ...(keys ? { keys } : {}), config: { sessionAffinity: true, ...config } });
}

async function postResponses(
  app: ReturnType<typeof createApp>,
  payload: Record<string, unknown>
): Promise<Record<string, string>> {
  const response = await app.inject({ method: "POST", url: "/v1/responses", headers: RESPONSES_HEADERS, payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("a responses chain keeps one sticky identity across three turns", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await stickyResponsesApp(runner);

  const turn1 = await postResponses(app, FIRST_TURN);
  const sticky = runner.lastInput?.stickyKey;
  assert.ok(sticky, "第一轮的请求体里有 system + user，本来就该认得出");

  const turn2 = await postResponses(app, { ...SECOND_TURN, previous_response_id: turn1.id });
  assert.equal(runner.lastInput?.stickyKey, sticky);

  // 第三轮是关键：链上每条记录只存直接父节点，靠的是每一轮都把继承来的种子再写回自己那行。
  await postResponses(app, { model: "composer-2.5", previous_response_id: turn2.id, input: "What about memory leaks?" });
  assert.equal(runner.lastInput?.stickyKey, sticky);

  // 另一段对话必须落到另一个身份，否则粘性就成了「把所有会话钉到同一把 key 上」。
  await postResponses(app, { ...FIRST_TURN, input: "Explain generators." });
  assert.notEqual(runner.lastInput?.stickyKey, sticky);
});

test("the continuation identity comes from storage, not from the request body", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, store } = await stickyResponsesApp(runner);

  const turn1 = await postResponses(app, FIRST_TURN);
  const sticky = runner.lastInput?.stickyKey;
  const seed = [...store.responses.values()].find((record) => record.id === turn1.id)?.conversationSeed;
  assert.ok(seed, "种子必须落库，否则下一轮无从继承");
  // 纯服务端状态：客户端拿到它就能自己指定这次打到哪把 key。
  assert.ok(!JSON.stringify(turn1).includes(seed), "种子不得出现在回显给客户端的任何字段里");

  await postResponses(app, { ...SECOND_TURN, previous_response_id: turn1.id });
  assert.equal(runner.lastInput?.stickyKey, sticky);

  // 同样的请求体去掉 previous_response_id：身份只可能来自库里那一行。
  await postResponses(app, SECOND_TURN);
  assert.notEqual(runner.lastInput?.stickyKey, sticky);
});

test("a responses continuation lands on the key its conversation was bound to", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, store, keyPool } = await stickyResponsesApp(runner, {}, ["key-a", "key-b"]);

  const turn1 = await postResponses(app, FIRST_TURN);
  const sticky = runner.lastInput?.stickyKey;
  assert.ok(sticky, "第一轮认不出会话就根本不会写绑定");
  const bound = store.sessionBindings.get(sessionBindingHash(sticky));
  assert.ok(bound, "跑通之后这段对话应当被钉到某把 key 上");

  // 把绑定改指到另一把 key：续聊只要真的复用了这段对话的身份就会跟着换过去，
  // 而 fill-first 本来永远只挑第一把——这一步把「粘性生效」和「碰巧同一把」区分开。
  const other = (await keyPool.list()).find((key) => key.id !== bound.keyId);
  assert.ok(other);
  await store.saveSessionBinding(sessionBindingHash(sticky), other.id);

  await postResponses(app, { ...SECOND_TURN, previous_response_id: turn1.id });
  assert.equal(runner.lastApiKey, other.apiKey);
});

test("the streaming save path carries the seed so the next turn still sticks", async () => {
  const runner = new FakeRunner({ chunks: ["ok"] });
  const { app } = await stickyResponsesApp(runner);

  const stream = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: RESPONSES_HEADERS,
    payload: { ...FIRST_TURN, stream: true }
  });
  assert.equal(stream.statusCode, 200);
  const sticky = runner.lastInput?.stickyKey;
  assert.ok(sticky);
  const completed = sseFrames(stream.body).at(-1)?.data as { response: { id: string } };

  await postResponses(app, { ...SECOND_TURN, previous_response_id: completed.response.id });
  assert.equal(runner.lastInput?.stickyKey, sticky);
});

test("a tool-only continuation still sticks even though its body names no conversation", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await stickyResponsesApp(runner);

  const turn1 = await postResponses(app, { ...FIRST_TURN, input: "Weather in Paris?" });
  const sticky = runner.lastInput?.stickyKey;
  assert.ok(sticky);

  const toolInput = [{ type: "function_call_output", call_id: "call_weather", output: "{\"temp\":21}" }];
  await postResponses(app, { model: "composer-2.5", previous_response_id: turn1.id, input: toolInput });
  assert.equal(runner.lastInput?.stickyKey, sticky);

  // 同一段输入没有父节点时确实认不出对话——这正是继承要补上的那一环。
  await postResponses(app, { model: "composer-2.5", input: toolInput });
  assert.equal(runner.lastInput?.stickyKey, undefined);
});

test("an unstored or unknown previous_response_id degrades instead of crashing", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await stickyResponsesApp(runner);

  const ephemeral = await postResponses(app, { ...FIRST_TURN, store: false });
  // 不落库不等于认不出对话：本轮仍按请求体算身份，只是没人能接着往下聊。
  assert.ok(runner.lastInput?.stickyKey);

  for (const previousResponseId of [ephemeral.id, "resp_never_existed"]) {
    const continued = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: RESPONSES_HEADERS,
      payload: { ...SECOND_TURN, previous_response_id: previousResponseId }
    });
    assert.equal(continued.statusCode, 404, previousResponseId);
    assert.equal(continued.json().error.param, "previous_response_id");
  }
});

/** Responses 的官方工具定义是扁平的：`{type:"function", name, parameters}`，不是 Chat 的嵌套 function 对象。 */
const FLAT_WEATHER_TOOL = {
  type: "function",
  name: "get_weather",
  description: "Get the weather.",
  parameters: { type: "object", properties: { city: { type: "string" } } },
  strict: true
};

test("responses parses official flat tool definitions and rejects nothing silently", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Weather in Paris?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(runner.lastInput?.tools, [{
    name: "get_weather",
    description: "Get the weather.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } }
  }]);
  // 工具原样回显在 Response 快照里（含 strict 等网关不消费的字段）。
  assert.deepEqual(response.json().tools, [FLAT_WEATHER_TOOL]);
});

test("responses still accepts the nested chat tool shape for compatibility", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Weather in Paris?",
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(runner.lastInput?.tools?.map((tool) => tool.name), ["get_weather"]);
});

test("responses ignores builtin tool types even when they carry a function field", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Search the web",
      tools: [
        { type: "web_search", function: { name: "web_search", parameters: { type: "object", properties: {} } } },
        FLAT_WEATHER_TOOL
      ]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(runner.lastInput?.tools?.map((tool) => tool.name), ["get_weather"]);
});

test("a hostile tool type does not crash the request", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Hello",
      // String(type) 对这种对象会抛 TypeError；日志渲染不能把请求变成 500。
      tools: [{ type: { toString: null, valueOf: null } }, FLAT_WEATHER_TOOL]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.json().tools as { name?: string }[]).map((tool) => tool.name), [undefined, "get_weather"]);
});

test("responses echoes tools and reasoning in the official schema shape", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Weather in Paris?",
      // 网关容忍的宽松写法：嵌套工具 + 字符串 reasoning。回显必须归一化成官方形状。
      reasoning: "high",
      instructions: "  keep spacing  ",
      tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } }]
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.tools, [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }]);
  // instructions 原样回显（prompt 里才用 trim 后的值）。
  assert.equal(body.instructions, "  keep spacing  ");
});

test("responses function_call_output strings are not double encoded", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: [
        { type: "message", role: "user", content: "Weather in Paris?" },
        { type: "function_call_output", call_id: "call_weather", output: "{\"temp\":21}" }
      ],
      tools: [FLAT_WEATHER_TOOL]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(runner.lastInput?.prompt.includes('TOOL RESULT (call_weather): {"temp":21}'), runner.lastInput?.prompt);
  assert.ok(!runner.lastInput?.prompt.includes('\\"temp\\"'), "string output must not be JSON.stringify'd twice");
});

test("responses stream indexes pure tool-call output from zero", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({
      text: "",
      toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }]
    })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather in Paris?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sseEvents(response.body), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed"
  ]);
  const frames = sseFrames(response.body);
  assert.deepEqual(frames[2].data, {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "fc_weather", type: "function_call", status: "in_progress", call_id: "call_weather", name: "get_weather", arguments: "" },
    sequence_number: 3
  });
  assert.deepEqual(frames[3].data, {
    type: "response.function_call_arguments.delta",
    item_id: "fc_weather",
    output_index: 0,
    delta: '{"city":"Paris"}',
    sequence_number: 4
  });
  assert.deepEqual(frames[4].data, {
    type: "response.function_call_arguments.done",
    item_id: "fc_weather",
    output_index: 0,
    name: "get_weather",
    arguments: '{"city":"Paris"}',
    sequence_number: 5
  });
  assert.deepEqual(frames[5].data, {
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "fc_weather", type: "function_call", status: "completed", call_id: "call_weather", name: "get_weather", arguments: '{"city":"Paris"}' },
    sequence_number: 6
  });
});

test("responses stream indexes tool-call output after text when text is streamed", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({
      text: "I need weather.",
      chunks: ["I need weather."],
      toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }]
    })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather in Paris?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sseEvents(response.body), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed"
  ]);
  const frames = sseFrames(response.body);
  // 文本 item 在工具调用开始前先收尾，工具 item 拿到下一个 output_index。
  assert.equal((frames[7].data as { output_index: number }).output_index, 0);
  assert.equal((frames[8].data as { output_index: number }).output_index, 1);
  const completed = frames.at(-1)!.data as { response: { output: { type: string }[] } };
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "function_call"]);
});

test("anthropic messages supports text and tool_use responses", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({
      text: "",
      toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }]
    })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [{ role: "user", content: "Weather in Paris?" }]
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.content[0].type, "tool_use");
});

test("tool call compatibility maps Cursor-native aliases to client tool schemas", () => {
  const tools: GatewayTool[] = [
    {
      name: "Read",
      inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
    },
    {
      name: "Grep",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          output_mode: { type: "string" },
          head_limit: { type: "number" },
          case_insensitive: { type: "boolean" }
        }
      }
    },
    {
      name: "Glob",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } } }
    },
    {
      name: "Bash",
      inputSchema: { type: "object", properties: { command: { type: "string" } } }
    }
  ];

  assert.deepEqual(
    normalizeToolCallForClient({ id: "call_read", name: "read", arguments: { path: "README.md" } }, tools),
    { id: "call_read", name: "Read", arguments: { file_path: "README.md" } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "call_grep", name: "Grep", arguments: { pattern: "TODO", outputMode: "content", headLimit: 20, caseInsensitive: true } }, tools),
    { id: "call_grep", name: "Grep", arguments: { pattern: "TODO", output_mode: "content", head_limit: 20, case_insensitive: true } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "call_glob", name: "glob", arguments: { globPattern: "**/*.ts", targetDirectory: "src" } }, tools),
    { id: "call_glob", name: "Glob", arguments: { pattern: "**/*.ts", path: "src" } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "call_shell", name: "shell", arguments: { command: "pwd" } }, tools),
    { id: "call_shell", name: "Bash", arguments: { command: "pwd" } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "call_mcp", name: "mcp", arguments: { providerIdentifier: "custom-user-tools", toolName: "Read", args: { file_path: "src/index.ts" } } }, tools),
    { id: "call_mcp", name: "Read", arguments: { file_path: "src/index.ts" } }
  );
});

test("SDK tool-call event parsing ignores arg-less progress and preserves parallel assistant tool uses", () => {
  assert.deepEqual(
    toolCallsFromSdkEvent({ type: "tool_call", call_id: "call_read", name: "Read", status: "running" }),
    []
  );
  assert.deepEqual(
    toolCallsFromSdkEvent({ type: "tool_call", call_id: "call_read", name: "Read", status: "running", args: { path: "README.md" } }),
    []
  );
  assert.deepEqual(
    toolCallsFromSdkEvent({ type: "tool_call", call_id: "call_read", name: "Read", status: "completed", truncated: { args: true }, args: { path: "README.md" } }),
    []
  );
  assert.deepEqual(
    toolCallsFromSdkEvent({ type: "tool_call", call_id: "call_read", name: "Read", status: "completed", args: { path: "README.md" } }),
    [{ id: "call_read", name: "Read", arguments: { path: "README.md" } }]
  );
  assert.deepEqual(
    toolCallsFromSdkEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "Read", input: { path: "README.md" } },
          { type: "tool_use", id: "call_b", name: "Grep", input: { pattern: "TODO" } }
        ]
      }
    }),
    [
      { id: "call_a", name: "Read", arguments: { path: "README.md" } },
      { id: "call_b", name: "Grep", arguments: { pattern: "TODO" } }
    ]
  );
});

test("CursorSdkRunner retries without custom tools when the SDK rejects send-level customTools", async () => {
  const sendOptions: Record<string, unknown>[] = [];
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async (_message, options) => {
        sendOptions.push(options);
        if (sendOptions.length === 1) {
          throw new Error("Custom local tools are only supported for local SDK agents.");
        }
        return new FakeSdkRun({ waitResult: { status: "finished", result: "fallback ok" } });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "read README",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [{ name: "Read", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }]
  });

  assert.equal(result.text, "fallback ok");
  assert.equal(sendOptions.length, 2);
  assert.ok((sendOptions[0].local as { customTools?: unknown } | undefined)?.customTools, "first attempt should pass customTools");
  assert.equal("local" in sendOptions[1], false, "fallback attempt should omit local customTools");
});

test("CursorSdkRunner ignores thinking/status text and surfaces terminal run errors", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "status", status: "RUNNING", text: "starting" };
          yield { type: "thinking", text: "internal scratchpad" };
        },
        waitResult: {
          status: "error",
          error: { message: "You have an unpaid invoice. Pay your invoice in Stripe." }
        }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 402 && error.code === "insufficient_quota"
  );
});

test("CursorSdkRunner uses SDK stream status error details for key classification", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "status", status: "ERROR", message: "Invalid API Key" };
        },
        waitResult: { status: "error" }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 401 && error.code === "unauthorized" && /Invalid API Key/i.test(error.message)
  );
});

test("gateway disables a key when the SDK stream only exposes auth failure in status messages", async () => {
  const factory: AgentFactory = {
    create: async (options) => ({
      agentId: "agent-test",
      send: async () => {
        if (options.apiKey === "key-a") {
          return new FakeSdkRun({
            streamEvents: async function* () {
              yield { type: "status", status: "ERROR", message: "Invalid API Key" };
            },
            waitResult: { status: "error" }
          });
        }
        return new FakeSdkRun({ waitResult: { status: "finished", result: "served by key-b" } });
      }
    })
  };
  const sdkRunner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const { app, keyPool } = await createTestApp({
    runner: sdkRunner as unknown as FakeRunner,
    keys: ["key-a", "key-b"],
    autoDisable: { threshold: 1 }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "served by key-b");

  const keys = await keyPool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a");
  assert.equal(keyA?.status, "disabled");
  assert.equal(keyA?.disabledReason, "key 无效/未授权");
  assert.match(keyA?.lastError ?? "", /Invalid API Key/i);
});

test("CursorSdkRunner maps SDK create auth errors to 401 instead of generic 500", async () => {
  const factory: AgentFactory = {
    create: async () => {
      throw Object.assign(new Error("Invalid API Key"), { status: 401, code: "unauthenticated" });
    }
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 401 && error.code === "unauthorized"
  );
});

test("CursorSdkRunner maps upstream per-key rate limits to 429 instead of generic 500", async () => {
  // 真机复现：单 key 并发突发触发 Cursor "30 requests per minute for the get_models endpoint"。
  const factory: AgentFactory = {
    create: async () => {
      throw new Error("You have exceeded the rate limit of 30 requests per minute for the get_models endpoint (request ID: req-x)");
    }
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 429 && error.code === "rate_limit_exceeded"
  );
});

test("CursorSdkRunner aborts hung agent creation and disposes the late-arriving agent", { timeout: 5000 }, async () => {
  // SDK 传输层挂死时 Agent.create 既不 resolve 也不 reject：abort 必须能打断，
  // 且晚到的 agent（本地执行器持有句柄/缓存）也要被释放，否则每个挂死请求都是一份泄漏。
  let closeCount = 0;
  let resolveCreate!: (agent: AgentLike) => void;
  const factory: AgentFactory = {
    create: () => new Promise<AgentLike>((resolve) => {
      resolveCreate = resolve;
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const controller = new AbortController();
  const pending = runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, (error) => error instanceof ApiError && error.statusCode === 499 && error.code === "request_aborted");

  resolveCreate({
    agentId: "agent-late",
    send: async () => new FakeSdkRun(),
    close: () => {
      closeCount += 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeCount, 1, "late-arriving agent must still be disposed");
});

test("CursorSdkRunner aborts hung send calls, cancels the late run and disposes the agent", { timeout: 5000 }, async () => {
  let closeCount = 0;
  let cancelCount = 0;
  let resolveSend!: (run: { id?: string; stream: () => AsyncIterable<unknown>; wait: () => Promise<unknown>; cancel: () => Promise<void> }) => void;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-hung-send",
      send: () => new Promise((resolve) => {
        resolveSend = resolve;
      }),
      close: () => {
        closeCount += 1;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const controller = new AbortController();
  const pending = runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, (error) => error instanceof ApiError && error.statusCode === 499 && error.code === "request_aborted");
  assert.equal(closeCount, 1, "agent must be disposed even when send never settled before abort");

  resolveSend({
    stream: async function* () { /* 无事件 */ },
    wait: async () => ({ status: "cancelled" }),
    cancel: async () => {
      cancelCount += 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelCount, 1, "late-arriving run must be cancelled to stop the upstream");
});

test("CursorSdkRunner disposes SDK agents after successful runs", async () => {
  let closeCount = 0;
  let disposeCount = 0;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-dispose",
      send: async () => new FakeSdkRun({ waitResult: { status: "finished", result: "dispose ok" } }),
      close: () => {
        closeCount += 1;
      },
      [Symbol.asyncDispose]: async () => {
        disposeCount += 1;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });

  assert.equal(result.text, "dispose ok");
  assert.equal(disposeCount, 1);
  assert.equal(closeCount, 0);
});

test("CursorSdkRunner disposes SDK agents after terminal run errors", async () => {
  let closeCount = 0;
  let disposeCount = 0;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-error-dispose",
      send: async () => new FakeSdkRun({ waitResult: { status: "error" } }),
      close: () => {
        closeCount += 1;
      },
      [Symbol.asyncDispose]: async () => {
        disposeCount += 1;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_run_failed"
  );

  assert.equal(disposeCount, 1);
  assert.equal(closeCount, 0);
});

test("CursorSdkRunner keeps real assistant text even when the terminal run status is error", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "partial answer" }] }
          };
        },
        waitResult: { status: "error", error: { message: "stream interrupted after output" } }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });

  assert.equal(result.text, "partial answer");
});

test("CursorSdkRunner returns all captured custom tool callbacks and cancels the SDK run", async () => {
  let sdkRun: FakeSdkRun | undefined;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async (_message, options) => {
        sdkRun = new FakeSdkRun({
          streamEvents: async function* () {
            const customTools = (options.local as { customTools: Record<string, { execute: (args: Record<string, unknown>, context: { toolCallId: string }) => unknown }> }).customTools;
            await customTools.Read.execute({ path: "README.md" }, { toolCallId: "call_read" });
            await customTools.Grep.execute({ pattern: "TODO" }, { toolCallId: "call_grep" });
            yield { type: "status", status: "RUNNING" };
          },
          waitResult: { status: "cancelled" }
        });
        return sdkRun;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "read and grep",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [
      { name: "Read", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "Grep", inputSchema: { type: "object", properties: { pattern: { type: "string" } } } }
    ]
  });

  assert.deepEqual(result.toolCalls, [
    { id: "call_read", name: "Read", arguments: { file_path: "README.md" } },
    { id: "call_grep", name: "Grep", arguments: { pattern: "TODO" } }
  ]);
  assert.equal(result.text, "");
  assert.equal(sdkRun?.cancelled, true);
});

test("CursorSdkRunner serializes concurrent requests for the same session", async () => {
  let sendCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStreamStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => {
        sendCount += 1;
        const current = sendCount;
        return new FakeSdkRun({
          streamEvents: async function* () {
            if (current === 1) {
              firstStarted();
              await firstCanFinish;
            }
          },
          waitResult: { status: "finished", result: `run ${current}` }
        });
      }
    }),
    resume: async () => ({
      agentId: "agent-test",
      send: async () => {
        sendCount += 1;
        return new FakeSdkRun({ waitResult: { status: "finished", result: `run ${sendCount}` } });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const input: CursorRunRequest = {
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "same-session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };

  const first = runner.run(input);
  await firstStreamStarted;
  const second = runner.run(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sendCount, 1, "second request should wait for the first session run to finish");
  releaseFirst();

  assert.equal((await first).text, "run 1");
  assert.equal((await second).text, "run 2");
});

test("CursorSdkRunner drops a busy resumed agent and creates a fresh one", async () => {
  let createCount = 0;
  let resumeCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return {
        agentId: createCount === 1 ? "agent-old" : "agent-fresh",
        send: async () => new FakeSdkRun({ waitResult: { status: "finished", result: createCount === 1 ? "first" : "fresh" } })
      };
    },
    resume: async () => {
      resumeCount += 1;
      return {
        agentId: "agent-old",
        send: async () => {
          throw new Error("Agent agent-old already has active run");
        }
      };
    }
  };
  const store = new MemoryStateStore();
  const runner = new CursorSdkRunner(store, { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const input: CursorRunRequest = {
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "busy-session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };

  assert.equal((await runner.run(input)).text, "first");
  const recovered = await runner.run(input);

  assert.equal(recovered.text, "fresh");
  assert.equal(resumeCount, 1);
  assert.equal(createCount, 2);
});

test("CursorSdkRunner can disable SDK session resume and avoid persisting remote agents", async () => {
  let createCount = 0;
  let resumeCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return {
        agentId: `agent-fresh-${createCount}`,
        send: async () => new FakeSdkRun({ waitResult: { status: "finished", result: `fresh ${createCount}` } })
      };
    },
    resume: async () => {
      resumeCount += 1;
      throw new Error("resume should not be called in stateless mode");
    }
  };
  const store = new MemoryStateStore();
  const runner = new CursorSdkRunner(store, {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    disableSessionResume: true
  }, factory);
  const input: CursorRunRequest = {
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "stateless-session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };

  assert.equal((await runner.run(input)).text, "fresh 1");
  assert.equal((await runner.run(input)).text, "fresh 2");
  assert.equal(createCount, 2);
  assert.equal(resumeCount, 0);
  assert.equal(store.sessions.size, 0);
});

test("anthropic stream emits official event order", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hel", "lo"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  const events = [...response.body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
});

test("anthropic unsupported document blocks return Anthropic style errors", async () => {
  const { app } = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", data: "x" } }] }]
    }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().type, "error");
});

test("admin page is served and admin api requires credentials", async () => {
  const { app } = await createTestApp();
  const page = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.match(page.body, /管理后台/);

  const denied = await app.inject({ method: "GET", url: "/admin/api/keys" });
  assert.equal(denied.statusCode, 401);

  const wrong = await app.inject({
    method: "GET",
    url: "/admin/api/keys",
    headers: { authorization: "Bearer wrong-password" }
  });
  assert.equal(wrong.statusCode, 401);
});

test("admin api manages cursor keys lifecycle", async () => {
  const { app } = await createTestApp({ keys: ["key-a"] });
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const list = await app.inject({ method: "GET", url: "/admin/api/keys", headers: adminHeaders });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().keys.length, 1);
  assert.ok(!JSON.stringify(list.json()).includes("key-a"), "full key must never be returned");

  const added = await app.inject({
    method: "POST",
    url: "/admin/api/keys",
    headers: adminHeaders,
    payload: { key: "key_new_secret_value_123", label: "备用号" }
  });
  assert.equal(added.statusCode, 200);
  const newId = added.json().key.id;
  assert.equal(added.json().key.label, "备用号");

  const disabled = await app.inject({ method: "POST", url: `/admin/api/keys/${newId}/disable`, headers: adminHeaders });
  assert.equal(disabled.statusCode, 200);
  let keys = (await app.inject({ method: "GET", url: "/admin/api/keys", headers: adminHeaders })).json().keys;
  assert.equal(keys.find((key: { id: string }) => key.id === newId).status, "disabled");

  const enabled = await app.inject({ method: "POST", url: `/admin/api/keys/${newId}/enable`, headers: adminHeaders });
  assert.equal(enabled.statusCode, 200);
  keys = (await app.inject({ method: "GET", url: "/admin/api/keys", headers: adminHeaders })).json().keys;
  assert.equal(keys.find((key: { id: string }) => key.id === newId).status, "active");

  const removed = await app.inject({ method: "DELETE", url: `/admin/api/keys/${newId}`, headers: adminHeaders });
  assert.equal(removed.statusCode, 200);
  keys = (await app.inject({ method: "GET", url: "/admin/api/keys", headers: adminHeaders })).json().keys;
  assert.equal(keys.length, 1);
});

test("admin connectivity test can target a specific key instead of the pool head", async () => {
  const runner = new FakeRunner({ text: "pong" });
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });
  const adminHeaders = { authorization: "Bearer gateway-key" };
  const keyB = (await keyPool.list()).find((key) => key.apiKey === "key-b");
  assert.ok(keyB, "key-b should exist");

  const res = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminHeaders,
    payload: { keyId: keyB.id, model: "composer-2.5" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().keyLabel, keyB.label);
  // 指定 keyId 时直接用该 key（key-b），而不是密钥池队首（key-a）。
  assert.equal(runner.lastApiKey, "key-b");

  const missing = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminHeaders,
    payload: { keyId: "does-not-exist" }
  });
  assert.equal(missing.statusCode, 404);
});

test("admin settings can toggle Cursor SDK HTTP/1.1 mode", async () => {
  const applied: boolean[] = [];
  const { app, store } = await createTestApp({
    applyCursorSdkNetworkConfig: async (enabled) => {
      applied.push(enabled);
    }
  });
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const enabled = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { cursorSdkUseHttp1ForAgent: true }
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().config.cursorSdkUseHttp1ForAgent, true);
  assert.equal(await store.getSetting("cursorSdkUseHttp1ForAgent"), "true");
  assert.deepEqual(applied, [true]);

  const overview = await app.inject({ method: "GET", url: "/admin/api/overview", headers: adminHeaders });
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.json().config.cursorSdkUseHttp1ForAgent, true);
});

test("admin settings can toggle Sand channel globally and per key", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, store, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const listed = await app.inject({ method: "GET", url: "/admin/api/keys", headers: adminHeaders });
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.json().keys.every((key: { clientType: string }) => key.clientType === "inherit"));

  const saved = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { sandClientMode: true }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().config.sandClientMode, true);
  assert.equal(await store.getSetting("sandClientMode"), "on");

  const overview = await app.inject({ method: "GET", url: "/admin/api/overview", headers: adminHeaders });
  assert.equal(overview.json().config.sandClientMode, true);

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: adminHeaders,
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(runner.lastInput?.clientType, "sand", "总开关打开后，跟随全局的 key 应走 sand");

  const keys = await keyPool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a");
  const keyB = keys.find((key) => key.apiKey === "key-b");
  assert.ok(keyA && keyB);

  const forcedSdk = await app.inject({
    method: "POST",
    url: `/admin/api/keys/${keyA.id}/channel`,
    headers: adminHeaders,
    payload: { clientType: "sdk" }
  });
  assert.equal(forcedSdk.statusCode, 200);
  assert.equal(forcedSdk.json().key.clientType, "sdk");

  const forcedSand = await app.inject({
    method: "POST",
    url: `/admin/api/keys/${keyB.id}/channel`,
    headers: adminHeaders,
    payload: { clientType: "sand" }
  });
  assert.equal(forcedSand.statusCode, 200);
  assert.equal(forcedSand.json().key.clientType, "sand");

  await keyPool.disable(keyB.id, "manual");
  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: adminHeaders,
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(runner.lastApiKey, "key-a");
  assert.equal(runner.lastInput?.clientType, "sdk", "key 强制 SDK 应覆盖全局 Sand");

  await keyPool.enable(keyB.id);
  await keyPool.disable(keyA.id, "manual");
  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: adminHeaders,
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(runner.lastApiKey, "key-b");
  assert.equal(runner.lastInput?.clientType, "sand");

  const off = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { sandClientMode: false }
  });
  assert.equal(off.json().config.sandClientMode, false);

  const invalid = await app.inject({
    method: "POST",
    url: `/admin/api/keys/${keyA.id}/channel`,
    headers: adminHeaders,
    payload: { clientType: "glass" }
  });
  assert.equal(invalid.statusCode, 400);
});

test("admin can add a key already pinned to Sand", async () => {
  const { app, keyPool } = await createTestApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/api/keys",
    headers: { authorization: "Bearer gateway-key" },
    payload: { key: "key-sand-only", label: "sand-key", clientType: "sand" }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().key.clientType, "sand");
  const stored = (await keyPool.list()).find((key) => key.apiKey === "key-sand-only");
  assert.equal(stored?.clientType, "sand");
});

test("admin settings can toggle default Max Mode and Fast and they flow into requests", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, store } = await createTestApp({ runner });
  const adminHeaders = { authorization: "Bearer gateway-key" };

  const saved = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { cursorMaxMode: true, cursorFast: true }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().config.cursorMaxMode, true);
  assert.equal(saved.json().config.cursorFast, true);
  assert.equal(await store.getSetting("cursorMaxModeDefault"), "on");
  assert.equal(await store.getSetting("cursorFastDefault"), "on");

  const overview = await app.inject({ method: "GET", url: "/admin/api/overview", headers: adminHeaders });
  assert.equal(overview.json().config.cursorMaxMode, true);
  assert.equal(overview.json().config.cursorFast, true);

  // 默认开关应流入实际请求（客户端未显式指定时）。
  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(runner.lastInput?.maxMode, true);
  assert.equal(runner.lastInput?.fast, true);

  // 关闭后网关不再强加默认（交回客户端/模型）。
  const off = await app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: adminHeaders,
    payload: { cursorMaxMode: false, cursorFast: false }
  });
  assert.equal(off.json().config.cursorMaxMode, false);
  assert.equal(off.json().config.cursorFast, false);

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] }
  });
  assert.equal(runner.lastInput?.maxMode, undefined);
  assert.equal(runner.lastInput?.fast, undefined);
});

test("requests are recorded into admin logs and overview stats", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }) });
  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chat.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));

  const adminHeaders = { authorization: "Bearer gateway-key" };
  const logs = await app.inject({ method: "GET", url: "/admin/api/logs", headers: adminHeaders });
  assert.equal(logs.statusCode, 200);
  const entries = logs.json().logs;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].endpoint, "/v1/chat/completions");
  assert.equal(entries[0].status, 200);
  assert.equal(entries[0].authMode, "gateway");
  assert.ok(entries[0].keyLabel, "key label should be recorded for pool requests");

  const overview = await app.inject({ method: "GET", url: "/admin/api/overview", headers: adminHeaders });
  assert.equal(overview.statusCode, 200);
  const body = overview.json();
  assert.equal(body.requests.total, 1);
  assert.equal(body.keys.active, 1);
  assert.ok(body.models.includes("composer-2.5"));
});

// ===== 模型参数透传 / 映射（对照 2026-07 实测 Cursor.models.list() 目录结构） =====

const claudeCatalog: ModelCatalog = {
  parameters: [
    { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
    { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
    { id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
    { id: "fast", values: [{ value: "false" }, { value: "true" }] }
  ],
  variants: [
    {
      displayName: "Opus 4.8",
      isDefault: true,
      params: [
        { id: "cyber", value: "false" },
        { id: "thinking", value: "true" },
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" }
      ]
    }
  ]
};

// GPT-5.x：272k 有 fast 两态；1m 只有 fast=false（1m 与 fast 互斥），对照实测目录。
const gptCatalog: ModelCatalog = {
  parameters: [
    { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
    { id: "reasoning", values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
    { id: "fast", values: [{ value: "false" }, { value: "true" }] }
  ],
  variants: [
    { displayName: "GPT-5.6", params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "medium" }, { id: "fast", value: "false" }] },
    { displayName: "GPT-5.6", params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "medium" }, { id: "fast", value: "true" }] },
    { displayName: "GPT-5.6", params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "xhigh" }, { id: "fast", value: "true" }] },
    { displayName: "GPT-5.6", isDefault: true, params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "medium" }, { id: "fast", value: "false" }] },
    { displayName: "GPT-5.6", params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "xhigh" }, { id: "fast", value: "false" }] }
  ]
};

function paramsMap(params: Array<{ id: string; value: string }>): Record<string, string> {
  return Object.fromEntries(params.map((param) => [param.id, param.value]));
}

test("resolveModelParams maps effort/maxMode onto Claude catalog and keeps the default-variant baseline", () => {
  const resolved = resolveModelParams(claudeCatalog, { reasoningEffort: "xhigh", maxMode: true }, "claude-opus-4-8");
  assert.deepEqual(paramsMap(resolved.params), {
    cyber: "false",
    thinking: "true",
    context: "1m",
    effort: "xhigh",
    fast: "false"
  });
  assert.deepEqual(resolved.dropped, []);
  assert.equal(resolved.usedFallback, false);
});

test("resolveModelParams turns thinking off without touching baseline effort and honors adaptive soft level", () => {
  const off = resolveModelParams(claudeCatalog, { reasoningEffort: "none" }, "claude-opus-4-8");
  assert.equal(paramsMap(off.params).thinking, "false");

  const adaptive = resolveModelParams(claudeCatalog, { reasoningEffort: "adaptive" }, "claude-opus-4-8");
  assert.equal(paramsMap(adaptive.params).thinking, "true");
  // adaptive 跟随模型默认强度：保持默认 variant 的 effort=high，而不是压成 medium。
  assert.equal(paramsMap(adaptive.params).effort, "high");
});

test("resolveModelParams maps codex-style reasoning and context downshift on GPT catalog", () => {
  const resolved = resolveModelParams(gptCatalog, { reasoningEffort: "xhigh", maxMode: false, fast: true }, "gpt-5.6");
  assert.deepEqual(paramsMap(resolved.params), {
    context: "272k",
    reasoning: "xhigh",
    fast: "true"
  });
});

test("resolveModelParams keeps Max Mode over fast when a GPT model cannot combine 1m + fast", () => {
  const resolved = resolveModelParams(gptCatalog, { maxMode: true, fast: true }, "gpt-5.6-sol");
  assert.equal(paramsMap(resolved.params).context, "1m");
  assert.equal(paramsMap(resolved.params).fast, "false");
  assert.ok(resolved.dropped.some((entry) => entry.includes("fast=true")));
});

test("resolveModelParams downgrades context to keep fast when only fast is requested on GPT", () => {
  const resolved = resolveModelParams(gptCatalog, { fast: true }, "gpt-5.6-sol");
  assert.equal(paramsMap(resolved.params).fast, "true");
  assert.equal(paramsMap(resolved.params).context, "272k");
});

test("resolveModelParams allows 1m + fast together on Claude models that support it", () => {
  const claudeWithFastVariants: ModelCatalog = {
    parameters: claudeCatalog.parameters,
    variants: [
      { displayName: "Opus 4.8", isDefault: true, params: [{ id: "cyber", value: "false" }, { id: "thinking", value: "true" }, { id: "context", value: "1m" }, { id: "effort", value: "high" }, { id: "fast", value: "false" }] },
      { displayName: "Opus 4.8", params: [{ id: "cyber", value: "false" }, { id: "thinking", value: "true" }, { id: "context", value: "1m" }, { id: "effort", value: "high" }, { id: "fast", value: "true" }] }
    ]
  };
  const resolved = resolveModelParams(claudeWithFastVariants, { maxMode: true, fast: true }, "claude-opus-4-8");
  assert.equal(paramsMap(resolved.params).context, "1m");
  assert.equal(paramsMap(resolved.params).fast, "true");
  assert.deepEqual(resolved.dropped, []);
});

test("resolveModelParams keeps Max Mode over fast on GPT even without catalog (family fallback)", () => {
  const resolved = resolveModelParams(undefined, { maxMode: true, fast: true }, "gpt-5.6-sol");
  assert.equal(resolved.usedFallback, true);
  assert.equal(paramsMap(resolved.params).context, "1m");
  assert.equal(paramsMap(resolved.params).fast, "false");
});

test("resolveModelParams falls back to family conventions when catalog discovery fails", () => {
  const claude = resolveModelParams(undefined, { reasoningEffort: "high", maxMode: true }, "claude-opus-4-8");
  assert.equal(claude.usedFallback, true);
  assert.deepEqual(paramsMap(claude.params), { thinking: "true", context: "1m" });

  const codex = resolveModelParams(undefined, { reasoningEffort: "xhigh" }, "gpt-5.3-codex");
  assert.equal(paramsMap(codex.params).reasoning, "extra-high");
});

test("resolveModelParams reports dropped intent for models without matching parameters", () => {
  const composerCatalog: ModelCatalog = {
    parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
    variants: [{ displayName: "Composer 2.5", isDefault: true, params: [{ id: "fast", value: "true" }] }]
  };
  const resolved = resolveModelParams(composerCatalog, { reasoningEffort: "high", maxMode: true, params: [{ id: "fast", value: "false" }] }, "composer-2.5");
  assert.deepEqual(paramsMap(resolved.params), { fast: "false" });
  assert.deepEqual(resolved.dropped, ["reasoningEffort=high", "maxMode=true"]);
});

test("parseModelSpec supports ACP bracket params plus @/:/# suffixes", () => {
  const bracket = parseModelSpec("claude-opus-4-8[thinking=true,context=1m,effort=xhigh]");
  assert.equal(bracket.model, "claude-opus-4-8");
  assert.deepEqual(paramsMap(bracket.intent.params ?? []), { thinking: "true", context: "1m", effort: "xhigh" });

  const suffixes = parseModelSpec("gpt-5.5@1m:high#fast=false");
  assert.equal(suffixes.model, "gpt-5.5");
  assert.equal(suffixes.intent.maxMode, true);
  assert.equal(suffixes.intent.reasoningEffort, "high");
  assert.deepEqual(paramsMap(suffixes.intent.params ?? []), { fast: "false" });
});

test("parseModelSpec reads Claude Code style bare [1m] suffix as Max Mode", () => {
  // Claude Code 指向自定义 base URL 时把 ANTHROPIC_MODEL='<model>[1m]' 原样透传进 model 字段。
  const opus = parseModelSpec("claude-opus-4-8[1m]");
  assert.equal(opus.model, "claude-opus-4-8");
  assert.equal(opus.intent.maxMode, true);

  const gpt = parseModelSpec("gpt-5.6-sol[1m]");
  assert.equal(gpt.model, "gpt-5.6-sol");
  assert.equal(gpt.intent.maxMode, true);

  const combo = parseModelSpec("claude-opus-4-8[1m,high,fast]");
  assert.equal(combo.model, "claude-opus-4-8");
  assert.equal(combo.intent.maxMode, true);
  assert.equal(combo.intent.reasoningEffort, "high");
  assert.equal(combo.intent.fast, true);

  const context200k = parseModelSpec("claude-sonnet-4-6[200k]");
  assert.equal(context200k.intent.maxMode, true);
});

test("anthropic thinking budget and context-1m beta header flow into the run request", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      "x-api-key": "gateway-key",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-1m-2025-08-07"
    },
    payload: {
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 30_000 },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(runner.lastInput?.model, "claude-opus-4-8");
  assert.equal(runner.lastInput?.reasoningEffort, "max");
  assert.equal(runner.lastInput?.maxMode, true);
});

test("openai reasoning_effort and responses reasoning.effort flow into the run request", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      max_mode: true,
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(runner.lastInput?.reasoningEffort, "xhigh");
  assert.equal(runner.lastInput?.maxMode, true);

  const responses = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "gpt-5.3-codex",
      reasoning: { effort: "high" },
      input: "Hello"
    }
  });
  assert.equal(responses.statusCode, 200);
  assert.equal(runner.lastInput?.reasoningEffort, "high");
});

test("model id suffixes and x-cursor headers flow into the run request with body taking precedence", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });

  const bySuffix = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "claude-opus-4-8@1m:xhigh", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(bySuffix.statusCode, 200);
  assert.equal(runner.lastInput?.model, "claude-opus-4-8");
  assert.equal(runner.lastInput?.reasoningEffort, "xhigh");
  assert.equal(runner.lastInput?.maxMode, true);

  const byHeaders = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: "Bearer gateway-key",
      "x-cursor-reasoning-effort": "low",
      "x-cursor-max-mode": "true",
      "x-cursor-model-params": "fast=true"
    },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(byHeaders.statusCode, 200);
  assert.equal(runner.lastInput?.reasoningEffort, "low");
  assert.equal(runner.lastInput?.maxMode, true);
  assert.deepEqual(runner.lastInput?.modelParams, [{ id: "fast", value: "true" }]);
});

test("CursorSdkRunner sends resolved model.params to the SDK agent", async () => {
  const createOptions: Record<string, unknown>[] = [];
  const sendOptions: Record<string, unknown>[] = [];
  const factory: AgentFactory = {
    create: async (options) => {
      createOptions.push(options);
      return {
        agentId: "agent-params",
        send: async (_message, options2) => {
          sendOptions.push(options2);
          return new FakeSdkRun({ waitResult: { status: "finished", result: "params ok" } });
        }
      };
    }
  };
  const runner = new CursorSdkRunner(
    new MemoryStateStore(),
    {
      defaultWorkingDirectory: "/workspace",
      sdkClientVersion: "test",
      getModelCatalog: async (modelId) => (modelId === "claude-opus-4-8" ? claudeCatalog : undefined)
    },
    factory
  );

  const result = await runner.run({
    protocol: "anthropic-messages",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "claude-opus-4-8",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [],
    reasoningEffort: "xhigh",
    maxMode: true
  });

  assert.equal(result.text, "params ok");
  const sentModel = sendOptions[0].model as { id: string; params: Array<{ id: string; value: string }> };
  assert.equal(sentModel.id, "claude-opus-4-8");
  assert.deepEqual(paramsMap(sentModel.params), {
    cyber: "false",
    thinking: "true",
    context: "1m",
    effort: "xhigh",
    fast: "false"
  });
  const createdModel = (createOptions[0] as { model: { params?: Array<{ id: string; value: string }> } }).model;
  assert.deepEqual(paramsMap(createdModel.params ?? []), paramsMap(sentModel.params));
});

// ===== 新增修复的回归测试 =====

test("anthropic streaming tool_use emits input via input_json_delta with empty start input", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({
      text: "",
      toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris", unit: "celsius" } }]
    })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      stream: true,
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [{ role: "user", content: "Weather in Paris?" }]
    }
  });
  assert.equal(response.statusCode, 200);
  const chunks = response.body.split("\n\n");
  const start = chunks.find((chunk) => chunk.includes("content_block_start") && chunk.includes('"tool_use"'));
  assert.ok(start, "should emit tool_use content_block_start");
  // Anthropic 官方语义：start 的 input 恒为空对象，完整参数走 input_json_delta。
  assert.match(start, /"input":\{\}/);
  const delta = chunks.find((chunk) => chunk.includes("input_json_delta"));
  assert.ok(delta, "should emit input_json_delta");
  assert.ok(delta.includes("Paris") && delta.includes("celsius"), "partial_json should carry the full arguments");
});

test("CursorSdkRunner streams text optimistically with tools and holds back tool_call markers", async () => {
  let sdkRun: FakeSdkRun | undefined;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-marker",
      send: async () => {
        sdkRun = new FakeSdkRun({
          streamEvents: async function* () {
            yield { type: "assistant", message: { content: [{ type: "text", text: "Let me check. <tool_" }] } };
            yield { type: "assistant", message: { content: [{ type: "text", text: 'call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>' }] } };
          },
          waitResult: { status: "cancelled" }
        });
        return sdkRun;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream({
    protocol: "anthropic-messages",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "weather",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }]
  })) {
    events.push(event);
  }
  // 正文在 marker 之前实时下发（不再等 run 结束才一次性吐出）。
  const textEvents = events.filter((event) => event.type === "text");
  assert.ok(textEvents.length >= 1, "text before the marker must stream live");
  assert.equal(textEvents.map((event) => event.type === "text" ? event.text : "").join(""), "Let me check. ");
  const toolEvents = events.filter((event) => event.type === "tool_call");
  assert.equal(toolEvents.length, 1);
  assert.deepEqual(toolEvents[0].type === "tool_call" ? toolEvents[0].toolCall.arguments : {}, { city: "Paris" });
  // 捕获 marker 工具调用后取消 run，避免继续烧 token。
  assert.equal(sdkRun?.cancelled, true);
});

test("CursorSdkRunner streams token-level text from onDelta and dedupes message-level text", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-delta",
      send: async (_message, options) => {
        const onDelta = options.onDelta as (args: { update: unknown }) => void;
        return new FakeSdkRun({
          streamEvents: async function* () {
            onDelta({ update: { type: "thinking-delta", text: "pondering" } });
            onDelta({ update: { type: "text-delta", text: "he" } });
            onDelta({ update: { type: "text-delta", text: "llo" } });
            // 消息级全文事件必须被去重，不能再输出一遍。
            yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
          },
          waitResult: { status: "finished", result: "hello" }
        });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  })) {
    events.push(event);
  }
  const thinking = events.filter((event) => event.type === "thinking");
  assert.equal(thinking.length, 1);
  const texts = events.filter((event): event is { type: "text"; text: string } => event.type === "text").map((event) => event.text);
  assert.deepEqual(texts, ["he", "llo"]);
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type === "done" ? done.result.text : "", "hello");
  // 未标记 stream 的请求按非流式处理：思考全文随 done 返回，供聚合器使用。
  assert.equal(done?.type === "done" ? done.result.reasoningText : undefined, "pondering");
});

test("streaming runs do not retain a second copy of the thinking transcript", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-delta",
      send: async (_message, options) => {
        const onDelta = options.onDelta as (args: { update: unknown }) => void;
        return new FakeSdkRun({
          streamEvents: async function* () {
            onDelta({ update: { type: "thinking-delta", text: "pondering" } });
            onDelta({ update: { type: "text-delta", text: "answer" } });
            yield { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } };
          },
          waitResult: { status: "finished", result: "answer" }
        });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    stream: true,
    workingDirectory: "/workspace",
    images: [],
    tools: []
  })) {
    events.push(event);
  }
  // 思考已逐块发给客户端，done.result 不再留一份（长思考会白占内存）。
  assert.equal(events.filter((event) => event.type === "thinking").length, 1);
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type === "done" ? done.result.reasoningText : "unset", undefined);
});

test("CursorSdkRunner.run aggregates thinking into reasoningText", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-delta",
      send: async (_message, options) => {
        const onDelta = options.onDelta as (args: { update: unknown }) => void;
        return new FakeSdkRun({
          streamEvents: async function* () {
            onDelta({ update: { type: "thinking-delta", text: "step one. " } });
            onDelta({ update: { type: "thinking-delta", text: "step two." } });
            onDelta({ update: { type: "text-delta", text: "answer" } });
            yield { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } };
          },
          waitResult: { status: "finished", result: "answer" }
        });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    stream: false,
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });
  assert.equal(result.text, "answer");
  assert.equal(result.reasoningText, "step one. step two.");
});

test("CursorSdkRunner does not forward agent-native tool calls the client never declared", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-native",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "tool_call", call_id: "call_sem", name: "semsearch", status: "completed", args: { query: "weather" } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "the answer" }] } };
        },
        waitResult: { status: "finished", result: "the answer" }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const result = await runner.run({
    protocol: "anthropic-messages",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "weather",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }]
  });
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.text, "the answer");
});

test("CursorSdkRunner restricts SDK builtin tools: [] without client tools, mcp-only with client tools", async () => {
  const createOptions: Record<string, unknown>[] = [];
  const factory: AgentFactory = {
    create: async (options) => {
      createOptions.push(options);
      return {
        agentId: "agent-tools-restrict",
        send: async () => new FakeSdkRun({ waitResult: { status: "finished", result: "ok" } })
      };
    }
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const base = {
    protocol: "openai-chat" as const,
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: []
  };
  await runner.run({ ...base, tools: [] });
  await runner.run({ ...base, tools: [{ name: "get_weather" }] });
  assert.deepEqual(createOptions[0].tools, []);
  assert.deepEqual(createOptions[1].tools, ["mcp"]);
});

test("CursorSdkRunner skips the session lock in stateless (disableSessionResume) mode", async () => {
  let sendCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStreamStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-parallel",
      send: async () => {
        sendCount += 1;
        const current = sendCount;
        return new FakeSdkRun({
          streamEvents: async function* () {
            if (current === 1) {
              firstStarted();
              await firstCanFinish;
            }
          },
          waitResult: { status: "finished", result: `run ${current}` }
        });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    disableSessionResume: true
  }, factory);
  const input: CursorRunRequest = {
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "same-session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };

  const first = runner.run(input);
  await firstStreamStarted;
  const second = runner.run(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // stateless 模式下并发请求不被会话锁串行化：第二个请求应立即开跑。
  assert.equal(sendCount, 2, "second request must not wait for the first in stateless mode");
  releaseFirst();
  assert.equal((await first).text, "run 1");
  assert.equal((await second).text, "run 2");
});

test("parseToolMarkers keeps unparsable markers verbatim and tolerates stringified arguments", () => {
  // arguments 是字符串化 JSON（OpenAI 原生格式）：必须能解析。
  const stringified = parseToolMarkers('<tool_call>{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}</tool_call>');
  assert.equal(stringified.toolCalls.length, 1);
  assert.deepEqual(stringified.toolCalls[0].arguments, { city: "Paris" });

  // 解析失败的 marker 保留原文，不再连同正文一起被静默吞掉。
  const broken = parseToolMarkers("before <tool_call>not json at all</tool_call> after");
  assert.equal(broken.toolCalls.length, 0);
  assert.match(broken.text, /not json at all/);
});

test("resolveModelParams falls back to family mapping when the catalog entry has no parameter definitions", () => {
  const resolved = resolveModelParams({}, { fast: true }, "composer-2.5");
  assert.equal(resolved.usedFallback, true);
  assert.deepEqual(paramsMap(resolved.params), { fast: "true" });
  assert.deepEqual(resolved.dropped, []);
});

test("CursorSdkRunner abort wakes an idle stream and cancels the run", async () => {
  let sdkRun: FakeSdkRun | undefined;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-abort",
      send: async () => {
        sdkRun = new FakeSdkRun({
          // 上游永远不产生任何事件：abort 必须能唤醒空队列等待。
          streamEvents: async function* () {
            await new Promise(() => undefined);
          },
          waitResult: { status: "cancelled" }
        });
        return sdkRun;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const controller = new AbortController();
  const pending = runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    () => pending,
    (error) => error instanceof ApiError && error.statusCode === 499 && error.code === "request_aborted"
  );
  assert.equal(sdkRun?.cancelled, true, "abort must cancel the underlying SDK run");
});

test("normalizeToolCallForClient maps Claude Code Grep flag keys without chain rewrites", () => {
  const flagTools: GatewayTool[] = [{
    name: "Grep",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, "-A": { type: "number" }, "-i": { type: "boolean" } } }
  }];
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c1", name: "grep", arguments: { pattern: "x", contextAfter: 3, caseInsensitive: true } }, flagTools),
    { id: "c1", name: "Grep", arguments: { pattern: "x", "-A": 3, "-i": true } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c2", name: "grep", arguments: { pattern: "x", context_after: 3 } }, flagTools),
    { id: "c2", name: "Grep", arguments: { pattern: "x", "-A": 3 } }
  );

  // schema 同时含 context_after 与 -A：contextAfter 落到 context_after，且不再链式改写到 -A；
  // 原本就是 context_after 的参数保持不动。
  const bothTools: GatewayTool[] = [{
    name: "Grep",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, context_after: { type: "number" }, "-A": { type: "number" } } }
  }];
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c3", name: "grep", arguments: { pattern: "x", contextAfter: 3 } }, bothTools),
    { id: "c3", name: "Grep", arguments: { pattern: "x", context_after: 3 } }
  );
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c4", name: "grep", arguments: { pattern: "x", context_after: 3 } }, bothTools),
    { id: "c4", name: "Grep", arguments: { pattern: "x", context_after: 3 } }
  );

  // 无 schema 时不猜测 flag 风格键。
  const schemaless: GatewayTool[] = [{ name: "Grep" }];
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c5", name: "grep", arguments: { context_after: 3 } }, schemaless),
    { id: "c5", name: "Grep", arguments: { context_after: 3 } }
  );
});

test("CursorSdkRunner drops marker tool calls for tools the client never declared", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-marker-unmatched",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: 'ok <tool_call>{"name":"semsearch","arguments":{"q":"x"}}</tool_call> done' }] } };
        },
        waitResult: { status: "finished", result: "" }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const result = await runner.run({
    protocol: "anthropic-messages",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "weather",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }]
  });
  assert.deepEqual(result.toolCalls, [], "undeclared marker tool call must not be forwarded");
  // 精确断言：marker 前后的正文都保留、marker 本体不泄漏。
  assert.equal(result.text, "ok  done");
  assert.ok(!result.text.includes("<tool_call>"), "marker must not leak into the text");
});

test("CursorSdkRunner keeps a declared marker call that follows a dropped undeclared one in the same chunk", async () => {
  let sdkRun: FakeSdkRun | undefined;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-multi-marker",
      send: async () => {
        sdkRun = new FakeSdkRun({
          streamEvents: async function* () {
            yield {
              type: "assistant",
              message: {
                content: [{
                  type: "text",
                  text: 'a <tool_call>{"name":"semsearch","arguments":{"q":"x"}}</tool_call> b <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call> c'
                }]
              }
            };
          },
          waitResult: { status: "cancelled" }
        });
        return sdkRun;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream({
    protocol: "anthropic-messages",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "weather",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }]
  })) {
    events.push(event);
  }
  const toolEvents = events.filter((event): event is { type: "tool_call"; toolCall: { id: string; name: string; arguments: Record<string, unknown> } } => event.type === "tool_call");
  assert.equal(toolEvents.length, 1, "only the declared marker call is forwarded");
  assert.equal(toolEvents[0].toolCall.name, "get_weather");
  assert.deepEqual(toolEvents[0].toolCall.arguments, { city: "Paris" });
  assert.equal(sdkRun?.cancelled, true);
});

test("CursorSdkRunner ignores empty text-delta and still accepts message-level text", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-empty-delta",
      send: async (_message, options) => {
        const onDelta = options.onDelta as (args: { update: unknown }) => void;
        return new FakeSdkRun({
          streamEvents: async function* () {
            // 空 delta 不能锁定文本来源为 delta，否则后面的消息级全文会被丢。
            onDelta({ update: { type: "text-delta", text: "" } });
            yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
          },
          waitResult: { status: "finished", result: "hello" }
        });
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });
  assert.equal(result.text, "hello");
});

test("CursorSdkRunner abort interrupts a hung run.wait()", async () => {
  let sdkRun: FakeSdkRun | undefined;
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-hung-wait",
      send: async () => {
        sdkRun = new FakeSdkRun({
          // 流立即结束，但 wait() 永不返回：abort 必须能打断。
          streamEvents: async function* () { /* empty */ },
          waitResult: undefined,
          hangWait: true
        });
        return sdkRun;
      }
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  const controller = new AbortController();
  const pending = runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    () => pending,
    (error) => error instanceof ApiError && error.statusCode === 499 && error.code === "request_aborted"
  );
});

test("CursorSdkRunner surfaces a cancelled run with zero output as an upstream error", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-external-cancel",
      send: async () => new FakeSdkRun({ waitResult: { status: "cancelled" } })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);
  await assert.rejects(
    () => runner.run({
      protocol: "openai-chat",
      apiKey: "cursor-key",
      useKeyPool: false,
      model: "composer-2.5",
      prompt: "hello",
      sessionKey: "session",
      workingDirectory: "/workspace",
      images: [],
      tools: []
    }),
    (error) => error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_run_failed"
  );
});

test("KeyRotatingRunner retries after thinking only for non-streaming requests", async () => {
  const makeInner = (): CursorRunner => ({
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
      if (input.apiKey === "key-a") {
        yield { type: "thinking", text: "hmm" };
        throw new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed");
      }
      yield { type: "text", text: "ok" };
      yield { type: "done", result: { text: "ok", toolCalls: [] } };
    }
  });
  const baseInput: CursorRunRequest = {
    protocol: "anthropic-messages",
    apiKey: "",
    useKeyPool: true,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };

  // 非流式：thinking 会被聚合器丢弃 → 允许换 key 重试，最终成功。
  {
    const store = new MemoryStateStore();
    const keyPool = new CursorKeyPool(store);
    await keyPool.seedFromEnv(["key-a", "key-b"]);
    const rotating = new KeyRotatingRunner(makeInner(), keyPool);
    const result = await rotating.run({ ...baseInput, stream: false });
    assert.equal(result.text, "ok");
  }

  // 流式：thinking 已发给客户端 → 不再透明重试，透出上游错误。
  {
    const store = new MemoryStateStore();
    const keyPool = new CursorKeyPool(store);
    await keyPool.seedFromEnv(["key-a", "key-b"]);
    const rotating = new KeyRotatingRunner(makeInner(), keyPool);
    await assert.rejects(async () => {
      for await (const event of rotating.stream({ ...baseInput, stream: true })) {
        void event;
      }
    }, (error) => error instanceof ApiError && error.code === "upstream_run_failed");
  }
});

test("responses stream expresses thinking as a reasoning item, not an SSE comment", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["pon", "dering"], chunks: ["answer"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello" }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes(": thinking"), "the SSE keepalive comment is replaced by real reasoning events");
  assert.deepEqual(sseEvents(response.body), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed"
  ]);

  const frames = sseFrames(response.body);
  const reasoningAdded = frames[2].data as { output_index: number; item: Record<string, unknown> };
  assert.equal(reasoningAdded.output_index, 0);
  assert.equal(reasoningAdded.item.type, "reasoning");
  assert.deepEqual(reasoningAdded.item.summary, []);
  assert.match(String(reasoningAdded.item.id), /^rs_/);

  const summaryDone = frames[6].data as { text: string; summary_index: number };
  assert.equal(summaryDone.text, "pondering");
  assert.equal(summaryDone.summary_index, 0);

  const reasoningDone = frames[8].data as { item: { summary: unknown[] } };
  assert.deepEqual(reasoningDone.item.summary, [{ type: "summary_text", text: "pondering" }]);

  // 文本 item 排在 reasoning item 之后，output_index 连续分配。
  assert.equal((frames[9].data as { output_index: number }).output_index, 1);
  const completed = frames.at(-1)!.data as { response: { output: { type: string }[]; usage: Record<string, unknown> } };
  assert.deepEqual(completed.response.output.map((item) => item.type), ["reasoning", "message"]);
  assert.deepEqual(completed.response.usage.output_tokens_details, { reasoning_tokens: 3 });
});

test("normalizeToolCallForClient removes redundant synonym source keys when the target is already set", () => {
  const tools: GatewayTool[] = [{
    name: "Write",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } }
  }];
  const normalized = normalizeToolCallForClient(
    { id: "c1", name: "write", arguments: { path: "a.md", fileText: "hello", file_text: "hello" } },
    tools
  );
  // fileText/file_text 同义并存：content 只取一次，schema 外的冗余键全部清除。
  assert.deepEqual(normalized, { id: "c1", name: "Write", arguments: { file_path: "a.md", content: "hello" } });
});

test("anthropic history thinking blocks are excluded from the synthesized prompt", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret internal reasoning", signature: "fake-sig" },
            { type: "text", text: "earlier answer" }
          ]
        },
        { role: "user", content: "Continue" }
      ]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!runner.lastInput?.prompt.includes("secret internal reasoning"), "thinking content must not enter the prompt");
  assert.ok(!runner.lastInput?.prompt.includes("fake-sig"), "thinking signature must not enter the prompt");
  assert.ok(runner.lastInput?.prompt.includes("earlier answer"), "regular assistant text stays in the prompt");
});

test("anthropic stream emits thinking blocks with signature_delta before stop", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["let me think"], chunks: ["answer"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.body;
  assert.match(body, /"content_block_start".*"type":"thinking"/);
  assert.match(body, /thinking_delta/);
  assert.match(body, /signature_delta/);
  // thinking 块的 stop 之前必须先有 signature_delta（Anthropic 协议要求）。
  assert.ok(body.indexOf("signature_delta") < body.indexOf("content_block_stop"), "signature_delta must precede the thinking block stop");
  // thinking 块之后正文以独立 text 块（index 1）下发。
  assert.match(body, /"index":1.*"type":"text"|"type":"text".*"index":1/);

  // 严格 union 解码器要求 thinking 块从 start 起就带 signature 字段。
  const start = sseFrames(body).find((frame) => frame.event === "content_block_start")!.data as { content_block: Record<string, unknown> };
  assert.deepEqual(start.content_block, { type: "thinking", thinking: "", signature: "" });
});

test("anthropic stream drops thinking when the client never requested it", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["internal"], chunks: ["answer"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("thinking_delta"), "thinking must not leak when it was not requested");
  assert.ok(!response.body.includes("signature_delta"), "no thinking block means no signature delta");
  assert.deepEqual(sseEvents(response.body), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  // 正文块占 index 0：被丢弃的 thinking 不能占用块下标。
  const start = sseFrames(response.body).find((frame) => frame.event === "content_block_start")!.data as { index: number; content_block: Record<string, unknown> };
  assert.equal(start.index, 0);
  assert.deepEqual(start.content_block, { type: "text", text: "" });
});

test("anthropic non-stream returns a thinking block only when thinking was requested", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["deep thought"], text: "answer" }) });
  const withThinking = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(withThinking.statusCode, 200);
  const blocks = withThinking.json().content as Record<string, unknown>[];
  assert.deepEqual(blocks.map((block) => block.type), ["thinking", "text"]);
  assert.equal(blocks[0].thinking, "deep thought");
  assert.ok(typeof blocks[0].signature === "string" && blocks[0].signature, "thinking block needs a signature");

  const withoutThinking = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.deepEqual((withoutThinking.json().content as { type: string }[]).map((block) => block.type), ["text"]);
  // 无工具调用时终止原因是 end_turn，stop_sequence 恒为 null（上游拿不到停止序列）。
  assert.equal(withoutThinking.json().stop_reason, "end_turn");
  assert.equal(withoutThinking.json().stop_sequence, null);
});

test("anthropic stream message_delta reports end_turn with a null stop_sequence", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  const delta = sseFrames(response.body).find((frame) => frame.event === "message_delta")!.data as { delta: unknown; usage: Record<string, number> };
  assert.deepEqual(delta.delta, { stop_reason: "end_turn", stop_sequence: null });
  assert.ok(typeof delta.usage.output_tokens === "number");
});

test("openai chat stream forwards thinking as reasoning_content deltas", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["pondering"], chunks: ["answer"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"reasoning_content":"pondering"/);
  assert.match(response.body, /"content":"answer"/);
});

// ---------------------------------------------------------------------------
// 网关密钥的模型可见范围
// ---------------------------------------------------------------------------

const RESTRICTED_GATEWAY_KEY = "restricted-gateway-key";

/** 四个入口的最小合法请求体：同一条可见范围规则要在每个协议上都成立。 */
function inferenceCalls(model: string): { url: string; payload: Record<string, unknown> }[] {
  return [
    { url: "/v1/chat/completions", payload: { model, messages: [{ role: "user", content: "Hello" }] } },
    { url: "/v1/responses", payload: { model, input: "Hello" } },
    { url: "/v1/messages", payload: { model, max_tokens: 64, messages: [{ role: "user", content: "Hello" }] } },
    { url: "/v1/messages/count_tokens", payload: { model, messages: [{ role: "user", content: "Hello" }] } }
  ];
}

async function gatewayKeyApp(
  apiKey: string,
  modelScope: ModelScope,
  runner: CursorRunner,
  options: { modelLister?: ModelLister; keys?: string[]; config?: Partial<GatewayConfig> } = {}
): Promise<{ app: ReturnType<typeof createApp>; keyPool: CursorKeyPool }> {
  const store = new MemoryStateStore();
  const gatewayKeyPool = new GatewayKeyPool(store);
  await gatewayKeyPool.add(apiKey, { label: "scoped", modelScope });
  const { app, keyPool } = await createTestApp({ store, runner, gatewayKeyPool, ...options });
  return { app, keyPool };
}

/** 目录整个不可达：冷缓存的进程碰上上游挂掉，正是别名绕过最好用的那个窗口。 */
const brokenCatalogue: ModelLister = () => {
  throw new Error("model catalogue unreachable");
};

/** 目录通了，但里面压根没有这个模型。 */
const emptyCatalogue: ModelLister = async () => ({ models: [], source: "cursor" });

/** 陈旧快照：还是「fable 这个别名加上去之前」的样子。目录缓存 10 分钟，这段窗口真实存在。 */
const staleCatalogue: ModelLister = async () => ({
  models: [
    { id: "composer-2.5", name: "Cursor Composer 2.5", aliases: ["composer-latest"] },
    { id: "claude-fable-5", name: "Fable 5", aliases: ["fable-5"] }
  ],
  source: "cursor"
});

/** 只有 cursor-key-b 的账号看得到 fable 这个别名。 */
const perKeyCatalogue: ModelLister = async (apiKey) => ({
  models: apiKey === "cursor-key-b"
    ? [{ id: "claude-fable-5", name: "Fable 5", aliases: ["fable", "fable-5"] }]
    : [{ id: "composer-2.5", name: "Cursor Composer 2.5", aliases: [] }],
  source: "cursor"
});

test("a partial catalogue failure leaves the merged identity unconfirmed", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  const mixedCatalogue: ModelLister = async (apiKey) => {
    if (apiKey === "cursor-key-a") throw new Error("catalogue unavailable for account A");
    return {
      models: [{ id: "claude-fable-5", name: "Fable 5", aliases: [] }],
      source: "cursor"
    };
  };
  const { app } = await gatewayKeyApp(
    RESTRICTED_GATEWAY_KEY,
    { allowed: [], excluded: ["fable"] },
    runner,
    { modelLister: mixedCatalogue, keys: ["cursor-key-a", "cursor-key-b"] }
  );

  // A 的目录可能认识 canonical id 的别名 fable，B 的成功响应不能证明并集已经完整。
  const response = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "claude-fable-5");
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "model_identity_unverified");
  assert.deepEqual(runner.seen, []);
});

test("a Cursor key denylist fails closed when its catalogue is unavailable", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  const { app, keyPool } = await createTestApp({ runner, modelLister: brokenCatalogue });
  const key = (await keyPool.list())[0];
  assert.ok(key);
  await keyPool.setModelScope(key.id, { allowed: [], excluded: ["claude-fable-5"] });

  // 目录挂掉时，fable 可能只是这把 key 的别名；黑名单不能把未知叫法当成安全。
  const response = await aliasChat(app, "gateway-key", "fable");
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "model_identity_unverified");
  assert.deepEqual(runner.seen, []);
});

function aliasChat(app: ReturnType<typeof createApp>, token: string, model: string, stream = false) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${token}` },
    payload: { model, messages: [{ role: "user", content: "Hello" }], ...(stream ? { stream: true } : {}) }
  });
}

test("a gateway deny list stays enforced when the catalogue cannot confirm the model", async () => {
  // 「黑名单写 canonical id + 请求写别名 + 目录说不出这是谁」是一条可以主动触发的绕过：
  // 三种降级形态（挂了 / 没这条 / 陈旧到还没有那个别名）都必须拒绝，而不是当作「没命中」放行。
  for (const lister of [brokenCatalogue, emptyCatalogue, staleCatalogue]) {
    const runner = new FakeRunner({ text: "should never run" });
    const { app } = await gatewayKeyApp(
      RESTRICTED_GATEWAY_KEY,
      { allowed: [], excluded: ["claude-fable-5"] },
      runner,
      { modelLister: lister }
    );
    const response = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "fable");
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "model_identity_unverified");
    assert.equal(response.json().error.param, "model");
    // 与真命中黑名单分开报：运维要区分的正是「该改可见范围」与「上游目录挂了、等一会儿就好」。
    assert.match(response.json().error.message, /catalogue is unavailable/);
    assert.deepEqual(runner.seen, []);
  }
});

test("the streaming variants of every entry point are refused before any SSE is opened", async () => {
  const runner = new FakeRunner({ chunks: ["should never run"] });
  const { app } = await gatewayKeyApp(RESTRICTED_GATEWAY_KEY, { allowed: [], excluded: ["claude-fable-5"] }, runner);
  const streaming = [
    { url: "/v1/chat/completions", payload: { model: "fable", stream: true, messages: [{ role: "user", content: "Hello" }] } },
    { url: "/v1/responses", payload: { model: "fable", stream: true, input: "Hello" } },
    { url: "/v1/messages", payload: { model: "fable", stream: true, max_tokens: 64, messages: [{ role: "user", content: "Hello" }] } }
  ];
  for (const call of streaming) {
    const response = await app.inject({
      method: "POST",
      url: call.url,
      headers: { authorization: `Bearer ${RESTRICTED_GATEWAY_KEY}`, "anthropic-version": "2023-06-01" },
      payload: call.payload
    });
    assert.equal(response.statusCode, 403, call.url);
    // 错误必须走信封而不是流：客户端还没开始读 SSE，塞一个流内 error 事件它接不住。
    assert.ok(!(response.headers["content-type"] ?? "").toString().includes("event-stream"), call.url);
    assert.equal(response.json().error.type, "permission_error", call.url);
  }
  assert.deepEqual(runner.seen, []);
});

test("a streaming request is refused the same way when the catalogue is down", async () => {
  const runner = new FakeRunner({ chunks: ["should never run"] });
  const { app } = await gatewayKeyApp(
    RESTRICTED_GATEWAY_KEY,
    { allowed: [], excluded: ["claude-fable-5"] },
    runner,
    { modelLister: brokenCatalogue }
  );
  const response = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "fable", true);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "model_identity_unverified");
  assert.deepEqual(runner.seen, []);
});

test("model identity does not depend on which key the router happens to pick", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  // 身份取全池并集之前，判定读的是「借来的那把」的目录、执行落在另一把上：
  // round-robin 两把等权 key 时这两把必然错开，于是只有 b 认识的那个别名永远躲得过黑名单。
  const { app } = await gatewayKeyApp(
    RESTRICTED_GATEWAY_KEY,
    { allowed: [], excluded: ["claude-fable-5"] },
    runner,
    { modelLister: perKeyCatalogue, keys: ["cursor-key-a", "cursor-key-b"], config: { routingStrategy: "round-robin" } }
  );
  const denied = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "fable");
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "model_not_allowed");
  assert.deepEqual(runner.seen, []);
});

test("reading the catalogue no longer steals a slot from round-robin", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await createTestApp({
    runner,
    keys: ["key-a", "key-b"],
    config: { routingStrategy: "round-robin" }
  });
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await aliasChat(app, "gateway-key", "composer-2.5")).statusCode, 200);
  }
  // 每请求一次「借 key 读目录」会把游标多推一格，两把等权 key 就会稳定错开。
  assert.deepEqual(runner.seen, ["key-a", "key-b"]);
});

test("a gateway allow list and a key allow list may spell the same model differently", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await gatewayKeyApp(
    RESTRICTED_GATEWAY_KEY,
    { allowed: ["claude-fable-5"], excluded: [] },
    runner
  );
  const key = (await keyPool.list())[0];
  await keyPool.setModelScope(key.id, { allowed: ["fable"], excluded: [] });
  // 两侧描述的是同一个模型，按字符串求交会落空成「什么都不许用」，把本该放行的请求拒掉。
  const response = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "claude-fable-5");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "ok");
});

test("an allow-list-only gateway key keeps working while the catalogue is down", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await gatewayKeyApp(
    RESTRICTED_GATEWAY_KEY,
    { allowed: ["claude-fable-5"], excluded: [] },
    runner,
    { modelLister: brokenCatalogue }
  );
  // 白名单只会往更严的方向降级，所以不该被黑名单那条 fail-closed 波及。
  assert.equal((await aliasChat(app, RESTRICTED_GATEWAY_KEY, "claude-fable-5")).statusCode, 200);

  // 别名请求在目录不可用时会被误拒——这正是「更严」的那一侧，报的也仍是普通的策略拒绝。
  const byAlias = await aliasChat(app, RESTRICTED_GATEWAY_KEY, "fable");
  assert.equal(byAlias.statusCode, 403);
  assert.equal(byAlias.json().error.code, "model_not_allowed");
});

test("count_tokens honours the scope registered for a direct Cursor key", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await createTestApp({ runner });
  const key = (await keyPool.list())[0];
  await keyPool.setModelScope(key.id, { allowed: [], excluded: ["claude-fable-5"] });

  // count_tokens 不进 runner，另外三个入口那份「已登记 key 的可见范围」在这条路上没人兜。
  const denied = await app.inject({
    method: "POST",
    url: "/v1/messages/count_tokens",
    headers: { authorization: "Bearer server-cursor-key", "anthropic-version": "2023-06-01" },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.type, "permission_error");

  // 范围内的模型照常估算。
  const allowed = await app.inject({
    method: "POST",
    url: "/v1/messages/count_tokens",
    headers: { authorization: "Bearer server-cursor-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(allowed.statusCode, 200);
  assert.ok(allowed.json().input_tokens > 0);

  // 池里没登记过的直传 key 没有范围可言，行为不变。
  const unregistered = await app.inject({
    method: "POST",
    url: "/v1/messages/count_tokens",
    headers: { authorization: "Bearer direct-cursor-key", "anthropic-version": "2023-06-01" },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(unregistered.statusCode, 200);
});

test("a gateway key model denylist is enforced on every inference entry point", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  const { app } = await gatewayKeyApp(RESTRICTED_GATEWAY_KEY, { allowed: [], excluded: ["claude-fable-5"] }, runner);
  for (const call of inferenceCalls("claude-fable-5")) {
    const response = await app.inject({
      method: "POST",
      url: call.url,
      headers: { authorization: `Bearer ${RESTRICTED_GATEWAY_KEY}`, "anthropic-version": "2023-06-01" },
      payload: call.payload
    });
    assert.equal(response.statusCode, 403, call.url);
    assert.equal(response.json().error.type, "permission_error", call.url);
    // Anthropic 信封没有 code 字段，只有 OpenAI 侧能断言到具体错误码。
    if (!call.url.startsWith("/v1/messages")) {
      assert.equal(response.json().error.code, "model_not_allowed", call.url);
      assert.equal(response.json().error.param, "model", call.url);
    }
  }
  // 一次都没打到上游，这才叫「快速拒绝」。
  assert.deepEqual(runner.seen, []);
});

test("requesting a model by alias does not slip past a gateway key denylist", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  const { app } = await gatewayKeyApp(RESTRICTED_GATEWAY_KEY, { allowed: [], excluded: ["claude-fable-5"] }, runner);
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${RESTRICTED_GATEWAY_KEY}` },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "model_not_allowed");
  assert.deepEqual(runner.seen, []);
});

test("a gateway key allowlist naming only the canonical id still accepts an alias request", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await gatewayKeyApp(RESTRICTED_GATEWAY_KEY, { allowed: ["claude-fable-5"], excluded: [] }, runner);
  const allowed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${RESTRICTED_GATEWAY_KEY}` },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().choices[0].message.content, "ok");
  // 第二层：网关范围与解析好的身份都随请求下传，选 key 时不必再查目录。
  assert.deepEqual(runner.lastInput?.gatewayModelScope, { allowed: ["claude-fable-5"], excluded: [] });
  assert.deepEqual(runner.lastInput?.modelIdentity?.names, ["fable", "claude-fable-5", "fable-5"]);

  const denied = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${RESTRICTED_GATEWAY_KEY}` },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "model_not_allowed");
});

test("an unrestricted gateway key reaches every entry point unchanged", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app } = await gatewayKeyApp("unrestricted-gateway-key", { allowed: [], excluded: [] }, runner);
  for (const call of inferenceCalls("claude-fable-5")) {
    const response = await app.inject({
      method: "POST",
      url: call.url,
      headers: { authorization: "Bearer unrestricted-gateway-key", "anthropic-version": "2023-06-01" },
      payload: call.payload
    });
    assert.equal(response.statusCode, 200, call.url);
  }
  // 没有范围就不该往下传，选 key 时才不会白算一次交集。
  assert.equal(runner.lastInput?.gatewayModelScope, undefined);
});

test("a Cursor key model denylist also catches a request made by alias", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await createTestApp({ runner });
  const key = (await keyPool.list())[0];
  await keyPool.setModelScope(key.id, { allowed: [], excluded: ["claude-fable-5"] });

  const denied = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "model_not_allowed");

  const allowed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(allowed.statusCode, 200);
});

test("direct mode honours the model scope registered for that Cursor key", async () => {
  const runner = new FakeRunner({ text: "ok" });
  const { app, keyPool } = await createTestApp({ runner });
  const key = (await keyPool.list())[0];
  await keyPool.setModelScope(key.id, { allowed: [], excluded: ["claude-fable-5"] });

  const scoped = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer server-cursor-key" },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(scoped.statusCode, 403);
  assert.equal(scoped.json().error.code, "model_not_allowed");

  // 池里没登记过的直传 key 没有范围可言，行为不变。
  const unregistered = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "fable", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(unregistered.statusCode, 200);
});

test("direct mode rejects a disabled registered Cursor key", async () => {
  const runner = new FakeRunner({ text: "should never run" });
  const { app, keyPool } = await createTestApp({ runner });
  const key = (await keyPool.list())[0];
  assert.ok(key);
  await keyPool.setModelScope(key.id, { allowed: [], excluded: ["claude-fable-5"] });
  await keyPool.disable(key.id, "manual");

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer server-cursor-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  assert.deepEqual(runner.seen, []);

  const models = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer server-cursor-key" }
  });
  assert.equal(models.statusCode, 401);
});

async function createTestApp(options: {
  runner?: CursorRunner;
  store?: MemoryStateStore;
  keys?: string[];
  config?: Partial<GatewayConfig>;
  runnerOptions?: KeyRotatingOptions;
  autoDisable?: Partial<AutoDisablePolicy>;
  applyCursorSdkNetworkConfig?: (useHttp1ForAgent: boolean) => Promise<void>;
  /**
   * 多密钥模式的入站密钥池。不传时鉴权走 config.gatewayApiKey 的单密钥老路径，
   * 拿不到 per-key 的绑定与模型范围；要验证受限网关密钥的用例必须传。
   */
  gatewayKeyPool?: GatewayKeyPool;
  /** 金额补写器。不传时请求路径完全不查金额（绝大多数用例都不需要）。 */
  usageReconciler?: UsageReconciler;
  /** 模型目录。默认是一份健康的双模型目录；要验证目录降级的用例才需要覆盖。 */
  modelLister?: ModelLister;
} = {}): Promise<{ app: ReturnType<typeof createApp>; store: MemoryStateStore; keyPool: CursorKeyPool }> {
  const store = options.store ?? new MemoryStateStore();
  const config = { ...baseConfig, ...options.config };
  // 路由策略必须跟着 config 走：key 池自己也留一份副本，不显式传进来的话
  // 用例拿到的是池的默认值（会话粘性默认开），跟 config 里写的策略对不上。
  const keyPool = new CursorKeyPool(store, options.autoDisable, {
    strategy: config.routingStrategy,
    sessionAffinity: config.sessionAffinity,
    sessionAffinityTtlMs: config.sessionAffinityTtlMs
  });
  await keyPool.seedFromEnv(options.keys ?? ["server-cursor-key"]);
  const inner = options.runner ?? new FakeRunner();
  const runner = new KeyRotatingRunner(inner, keyPool, {
    ...options.runnerOptions,
    resolveGlobalClientType: () => config.sandClientMode ? "sand" : "sdk"
  });
  const modelLister: ModelLister = options.modelLister ?? (async () => ({
    models: [
      { id: "composer-2.5", name: "Cursor Composer 2.5", aliases: ["composer-latest", "composer"] },
      { id: "claude-fable-5", name: "Fable 5", aliases: ["fable", "fable-5"] }
    ],
    source: "cursor"
  }));
  const app = createApp({
    config,
    store,
    runner,
    keyPool,
    ...(options.gatewayKeyPool ? { gatewayKeyPool: options.gatewayKeyPool } : {}),
    ...(options.usageReconciler ? { usageReconciler: options.usageReconciler } : {}),
    modelLister,
    applyCursorSdkNetworkConfig: options.applyCursorSdkNetworkConfig
  });
  return { app, store, keyPool };
}

/**
 * 请求历史里最新的一条。走后台接口而不是直接读 store：finishLog 里的落库是 fire-and-forget，
 * 多一次完整请求往返才能保证它已经写完，顺带把对外暴露的形状也测了。
 */
async function latestLog(
  app: ReturnType<typeof createApp>,
  endpoint = "/v1/chat/completions"
): Promise<RequestLogRecord> {
  const response = await app.inject({ method: "GET", url: "/admin/api/logs", headers: { authorization: "Bearer gateway-key" } });
  assert.equal(response.statusCode, 200);
  const log = (response.json().logs as RequestLogRecord[]).find((entry) => entry.endpoint === endpoint);
  assert.ok(log, `no request log for ${endpoint}`);
  return log;
}

/** 让 finishLog 那条 fire-and-forget 的落库链（含它 then 里的金额补写排队）跑完。 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface SseFrame {
  event?: string;
  raw?: string;
  data?: unknown;
}

/** 把 SSE 响应体拆成有序帧，用于断言精确的事件顺序与 JSON 形状。 */
function sseFrames(body: string): SseFrame[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: ([\s\S]+?)$/m.exec(frame)?.[1];
      let data: unknown;
      if (raw !== undefined && raw !== "[DONE]") {
        // 解析失败要立刻炸：否则只比事件名的顺序断言会在 data 变成非法 JSON 时照样通过。
        data = JSON.parse(raw) as unknown;
      }
      return { event, raw, data };
    });
}

/** 事件顺序：优先取 SSE `event:` 名，退回 data.type / [DONE]。 */
function sseEvents(body: string): string[] {
  return sseFrames(body).map((frame) => {
    if (frame.event) return frame.event;
    if (frame.raw === "[DONE]") return "[DONE]";
    const type = (frame.data as { type?: unknown } | undefined)?.type;
    return typeof type === "string" ? type : "chunk";
  });
}

class FakeSdkRun {
  readonly id = "run-test";
  cancelled = false;

  constructor(private readonly input: {
    streamEvents?: () => AsyncIterable<unknown>;
    waitResult?: unknown;
    /** wait() 永不返回，用于验证 abort 能打断挂死的 wait。 */
    hangWait?: boolean;
  } = {}) {}

  async *stream(): AsyncIterable<unknown> {
    if (this.input.streamEvents) yield* this.input.streamEvents();
  }

  async wait(): Promise<unknown> {
    if (this.input.hangWait) return new Promise(() => undefined);
    return this.input.waitResult ?? { status: "finished", result: "" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class FakeRunner implements CursorRunner {
  lastApiKey = "";
  lastInput?: CursorRunRequest;
  readonly seen: string[] = [];
  readonly failFor = new Map<string, string>();
  readonly failWith = new Map<string, Error>();

  constructor(private readonly output: Partial<CursorRunResult> & {
    chunks?: string[];
    thinking?: string[];
    /** 已经吐出内容之后再抛错，用于验证流内错误事件（而不是裸断连）。 */
    failMidStream?: Error;
    /** 一直挂到被 abort，用于验证超时映射。 */
    hangUntilAborted?: boolean;
    /** 吐完 thinking/chunks 后再挂住，用于验证流中途的空闲超时（区别于首事件前超时）。 */
    hangAfterChunks?: boolean;
    /** 完全无视 abort signal 的永久挂死（模拟 SDK 传输层卡死），验证请求级竞速兜底。 */
    hangIgnoringAbort?: boolean;
    /** 吐完 chunks 后无视 abort 永久挂死，验证流中途的竞速兜底。 */
    hangAfterChunksIgnoringAbort?: boolean;
    /** 覆盖写回 telemetryRef 的遥测（实测用量、真正下发的 model.params 等）。 */
    telemetry?: Partial<RunTelemetryRef>;
  } = {}) {}

  async run(input: CursorRunRequest): Promise<CursorRunResult> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    this.noteTelemetry(input);
    if (this.output.hangIgnoringAbort) await new Promise(() => undefined);
    return {
      text: this.output.text ?? "ok",
      toolCalls: this.output.toolCalls ?? [],
      ...(this.output.reasoningText ? { reasoningText: this.output.reasoningText } : {}),
      agentId: "agent-test",
      runId: "run-test"
    };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    this.noteTelemetry(input);
    if (this.output.hangIgnoringAbort) await new Promise(() => undefined);
    if (this.output.hangUntilAborted) await abortedPromise(signal);
    const thinkingChunks = this.output.thinking ?? (this.output.reasoningText ? [this.output.reasoningText] : []);
    for (const thinking of thinkingChunks) {
      yield { type: "thinking", text: thinking };
    }
    const chunks = this.output.chunks ?? (this.output.text ? [this.output.text] : []);
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      yield { type: "text", text: chunk };
    }
    if (this.output.failMidStream) throw this.output.failMidStream;
    if (this.output.hangAfterChunksIgnoringAbort) await new Promise(() => undefined);
    if (this.output.hangAfterChunks) await abortedPromise(signal);
    for (const toolCall of this.output.toolCalls ?? []) {
      yield { type: "tool_call", toolCall };
    }
    const thinking = thinkingChunks.join("");
    yield {
      type: "done",
      result: {
        text: this.output.text ?? text,
        toolCalls: this.output.toolCalls ?? [],
        ...(thinking ? { reasoningText: thinking } : {}),
        agentId: "agent-test",
        runId: "run-test"
      }
    };
  }

  private maybeFail(input: CursorRunRequest): void {
    const custom = this.failWith.get(input.apiKey);
    if (custom) throw custom;
    const failure = this.failFor.get(input.apiKey);
    if (failure) throw new Error(failure);
  }

  /**
   * 真实 runner 拿到 agent 之后会把 agentId/runId 写回 telemetryRef，金额补写全靠它认人；
   * 实测用量与真正下发的 model.params 也走同一条回传通道。跑失败的尝试没有 agent，所以放在 maybeFail 之后。
   */
  private noteTelemetry(input: CursorRunRequest): void {
    const telemetry = input.telemetryRef;
    if (!telemetry) return;
    telemetry.agentId = this.output.telemetry?.agentId ?? "agent-test";
    telemetry.runId = this.output.telemetry?.runId ?? "run-test";
    if (this.output.telemetry?.modelParams) telemetry.modelParams = this.output.telemetry.modelParams;
    if (this.output.telemetry?.usage) telemetry.usage = this.output.telemetry.usage;
  }
}

/** 模拟"上游挂住直到网关 abort"：与真实 runner 一样把 abort 表达成 499。 */
function abortedPromise(signal?: AbortSignal): Promise<never> {
  // 没有 signal 就立即失败：否则一旦 abort 传递链回归，这个 promise 会永远挂住整个测试套件。
  if (!signal) return Promise.reject(new ApiError("hangUntilAborted requires an abort signal.", 500, "internal_error"));
  return new Promise((_, reject) => {
    const fail = (): void => reject(new ApiError("Request was aborted.", 499, "request_aborted"));
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

// ---------------------------------------------------------------------------
// P0-1 stream_options.include_usage
// ---------------------------------------------------------------------------

test("chat stream omits the usage chunk unless stream_options.include_usage is set", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  const frames = sseFrames(response.body);
  assert.equal(frames.at(-1)?.raw, "[DONE]");
  const chunks = frames.slice(0, -1).map((frame) => frame.data as Record<string, unknown>);
  // 每个块都必须有 choices[0]；无脑取 choices[0] 的客户端不能被 choices:[] 的 usage 块打崩。
  assert.ok(chunks.every((chunk) => (chunk.choices as unknown[]).length === 1), "no choices:[] chunk may be emitted");
  assert.ok(chunks.every((chunk) => !("usage" in chunk)), "usage field must be absent entirely");
  assert.deepEqual(chunks.map((chunk) => (chunk.choices as { delta: unknown }[])[0].delta), [
    { role: "assistant" },
    { content: "hi" },
    {}
  ]);
});

test("chat stream sends usage:null plus a final usage chunk when include_usage is requested", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(response.statusCode, 200);
  const frames = sseFrames(response.body);
  assert.equal(frames.at(-1)?.raw, "[DONE]");
  const chunks = frames.slice(0, -1).map((frame) => frame.data as Record<string, unknown>);
  const usageChunks = chunks.filter((chunk) => (chunk.choices as unknown[]).length === 0);
  assert.equal(usageChunks.length, 1, "exactly one choices:[] usage chunk");
  assert.equal(usageChunks[0], chunks.at(-1), "the usage chunk is the last one before [DONE]");
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null), "normal chunks carry usage:null");
  const usage = usageChunks[0].usage as Record<string, number>;
  assert.deepEqual(Object.keys(usage).sort(), ["completion_tokens", "prompt_tokens", "total_tokens"]);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

// ---------------------------------------------------------------------------
// P0-2 in-stream errors
// ---------------------------------------------------------------------------

test("chat stream reports a mid-stream failure as an error frame without [DONE]", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], failMidStream: new ApiError("upstream exploded", 502, "upstream_run_failed") })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("data: [DONE]"), "a failed chat stream must not be terminated with [DONE]");
  const frames = sseFrames(response.body);
  assert.deepEqual(frames.at(-1)?.data, {
    error: { message: "upstream exploded", type: "server_error", param: null, code: "upstream_run_failed" }
  });
});

test("responses stream reports a mid-stream failure as an error event with a continuing sequence", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], failMidStream: new ApiError("upstream exploded", 502, "upstream_run_failed") })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", stream: true, input: "Hello" }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("data: [DONE]"), "responses never emits [DONE]");
  assert.deepEqual(sseEvents(response.body), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "error"
  ]);
  assert.deepEqual(sseFrames(response.body).at(-1)?.data, {
    type: "error",
    code: "upstream_run_failed",
    message: "upstream exploded",
    param: null,
    sequence_number: 6
  });
});

test("anthropic stream reports a mid-stream failure as an error event without message_stop", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], failMidStream: new ApiError("upstream exploded", 529, "overloaded") })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "direct-cursor-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sseEvents(response.body), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "error"
  ]);
  assert.deepEqual(sseFrames(response.body).at(-1)?.data, {
    type: "error",
    error: { type: "overloaded_error", message: "upstream exploded" }
  });
});

test("a failed stream is logged with the real status instead of 200", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], failMidStream: new ApiError("upstream exploded", 502, "upstream_run_failed") })
  });
  const streamed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(streamed.statusCode, 200);
  const logs = await app.inject({ method: "GET", url: "/admin/api/logs", headers: { authorization: "Bearer gateway-key" } });
  const entry = (logs.json().logs as { endpoint: string; status: number }[]).find((log) => log.endpoint === "/v1/chat/completions");
  assert.equal(entry?.status, 502);
});

test("a non-streaming history row carries the same estimated numbers the client was told", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hello there, this is the answer" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);

  const log = await latestLog(app);
  assert.equal(log.usageSource, "estimated");
  // 以前这里只写 estimated 不写数字，后台显示「估算」加一片空白。数字必须和响应体里那份对得上。
  const usage = response.json().usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  assert.ok(usage.total_tokens > 0);
  assert.equal(log.usage?.inputTokens, usage.prompt_tokens);
  assert.equal(log.usage?.outputTokens, usage.completion_tokens);
  assert.equal(log.usage?.totalTokens, usage.total_tokens);
});

test("a streaming history row carries the estimate the usage chunk reported", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hello ", "there"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(response.statusCode, 200);
  const usage = sseFrames(response.body)
    .map((frame) => (frame.data as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | undefined)?.usage)
    .filter(Boolean)
    .at(-1);
  assert.ok(usage);

  // 流式在 finishLog 之前就走完了整条流，估算补在收尾那一步，和 usage 块用同一份字符数。
  const log = await latestLog(app);
  assert.equal(log.usageSource, "estimated");
  assert.equal(log.usage?.inputTokens, usage.prompt_tokens);
  assert.equal(log.usage?.outputTokens, usage.completion_tokens);
  assert.equal(log.usage?.totalTokens, usage.total_tokens);
});

test("estimated history matches rendered reasoning and tool output in every protocol", async () => {
  const toolCall = { id: "call-weather", name: "get_weather", arguments: { city: "Paris" } };

  const chatRunner = new FakeRunner({ text: "answer", reasoningText: "think", toolCalls: [toolCall] });
  const { app: chatApp } = await createTestApp({ runner: chatRunner });
  const chatResponse = await chatApp.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chatResponse.statusCode, 200);
  const chatBody = chatResponse.json();
  const chatUsage = chatBody.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  const chatTools = chatBody.choices[0].message.tool_calls as unknown[];
  const expectedChatCompletion = Math.ceil(("answer".length + "think".length + JSON.stringify(chatTools).length) / 4);
  assert.equal(chatUsage.completion_tokens, expectedChatCompletion);
  const chatLog = await latestLog(chatApp);
  assert.equal(chatLog.usage?.outputTokens, expectedChatCompletion);

  const anthropicRunner = new FakeRunner({ text: "answer", reasoningText: "hidden thinking", toolCalls: [toolCall] });
  const { app: anthropicApp } = await createTestApp({ runner: anthropicRunner });
  const anthropicResponse = await anthropicApp.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 256,
      thinking: { type: "enabled", display: "omitted" },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(anthropicResponse.statusCode, 200);
  const anthropicBody = anthropicResponse.json();
  const anthropicTools = (anthropicBody.content as { type: string }[]).filter((item) => item.type === "tool_use");
  const expectedAnthropicCompletion = Math.ceil(("answer".length + JSON.stringify(anthropicTools).length) / 4);
  assert.equal(anthropicBody.usage.output_tokens, expectedAnthropicCompletion);
  const anthropicLog = await latestLog(anthropicApp, "/v1/messages");
  assert.equal(anthropicLog.usage?.outputTokens, expectedAnthropicCompletion);

  const responsesRunner = new FakeRunner({ text: "answer", reasoningText: "abcde", toolCalls: [toolCall] });
  const { app: responsesApp } = await createTestApp({ runner: responsesRunner });
  const responsesResponse = await responsesApp.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Hello" }
  });
  assert.equal(responsesResponse.statusCode, 200);
  const responsesBody = responsesResponse.json();
  const responseItems = responsesBody.output as { type: string; content?: { text?: string }[]; summary?: { text?: string }[] }[];
  const responseText = responseItems
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
  const responseReasoning = responseItems
    .flatMap((item) => item.summary ?? [])
    .map((part) => part.text ?? "")
    .join("");
  const responseTools = responseItems.filter((item) => item.type === "function_call");
  const expectedResponsesOutput = Math.ceil((responseText.length + JSON.stringify(responseTools).length) / 4);
  const expectedResponsesReasoning = Math.ceil(responseReasoning.length / 4);
  assert.equal(responsesBody.usage.output_tokens, expectedResponsesOutput + expectedResponsesReasoning);
  const responsesLog = await latestLog(responsesApp, "/v1/responses");
  assert.equal(responsesLog.usage?.outputTokens, expectedResponsesOutput + expectedResponsesReasoning);
});

test("real upstream usage beats the estimate and is labelled as such", async () => {
  const runner = new FakeRunner({
    text: "ok",
    telemetry: {
      usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30, totalTokens: 1095 }
    }
  });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);

  const log = await latestLog(app);
  assert.equal(log.usageSource, "sdk");
  assert.equal(log.usage?.totalTokens, 1095);
});

test("a request that never produced anything claims no usage at all", async () => {
  const runner = new FakeRunner({});
  runner.failWith.set("direct-cursor-key", new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed"));
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 502);

  const log = await latestLog(app);
  // 没有产出就没有可估的东西：标 estimated 而字段全空比什么都不标更误导人。
  assert.equal(log.usage, undefined);
  assert.equal(log.usageSource, undefined);
});

test("direct-mode requests get their cost backfilled with the client's own key", async () => {
  const store = new MemoryStateStore();
  const calls: string[][] = [];
  const usageReconciler = new UsageReconciler({
    store,
    delayMs: 1,
    getUsage: async (agentId, apiKey) => {
      calls.push([agentId, apiKey]);
      return { cost: { rawCostCents: 3.5, chargedCents: 1.25 } };
    }
  });
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }), store, usageReconciler });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  await tick();
  await usageReconciler.drain();
  usageReconciler.close();

  // 直传不经过密钥池、没有 keyId，只能拿客户端自己那把 key 去查金额，否则直传请求永远没有金额。
  assert.deepEqual(calls, [["agent-test", "direct-cursor-key"]]);
  const [log] = (await store.listRequestLogs({ limit: 5 })).logs;
  assert.deepEqual(log.cost, { rawCostCents: 3.5, chargedCents: 1.25 });
});

test("parameter columns record what took effect and leave the unrecoverable ones as intent", async () => {
  const runner = new FakeRunner({
    text: "ok",
    // 上游实际收到的是 fast=false：1m 上下文与 fast 互斥，网关自己降了级，与客户端要的正好相反。
    telemetry: { modelParams: [{ id: "context", value: "1m" }, { id: "effort", value: "low" }, { id: "fast", value: "false" }] }
  });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: "Bearer gateway-key",
      "x-cursor-reasoning-effort": "xhigh",
      "x-cursor-max-mode": "true",
      "x-cursor-fast": "true"
    },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);

  const log = await latestLog(app);
  assert.equal(log.fast, false, "客户端要了 fast 但实际发的是 false，记意图就等于记了个假象");
  assert.equal(log.reasoningEffort, "low");
  // context=1m 是档位型参数，光看下发值不对照该模型的全部档位判断不出是不是最大档，
  // 所以 maxMode 只能退回请求意图，并且不进 effectiveParams。
  assert.equal(log.maxMode, true);
  assert.deepEqual(log.effectiveParams, ["reasoningEffort", "fast"]);
});

test("parameter columns fall back to intent when nothing came back from the runner", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: "Bearer gateway-key",
      "x-cursor-reasoning-effort": "high",
      "x-cursor-max-mode": "true",
      "x-cursor-fast": "true"
    },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);

  const log = await latestLog(app);
  assert.equal(log.reasoningEffort, "high");
  assert.equal(log.maxMode, true);
  assert.equal(log.fast, true);
  // 一个都没确认：运维看到的是「客户端要了，但网关不知道最后发的是什么」。
  assert.equal(log.effectiveParams, undefined);
});

// ---------------------------------------------------------------------------
// P0-6 Response snapshots
// ---------------------------------------------------------------------------

test("responses stream keeps output_index unique when a tool call precedes text", async () => {
  // 旧实现用 `(textStarted ? 1 : 0) + toolCalls.length - 1`：工具先于文本时两者都会拿到 index 0。
  const runner: CursorRunner = {
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (): AsyncIterable<CursorStreamEvent> {
      yield { type: "tool_call", toolCall: { id: "call_weather", name: "get_weather", arguments: { city: "Paris" } } };
      yield { type: "text", text: "checking" };
      yield { type: "done", result: { text: "checking", toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }] } };
    }
  };
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather in Paris?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const frames = sseFrames(response.body);
  const added = frames.filter((frame) => frame.event === "response.output_item.added").map((frame) => frame.data as { output_index: number; item: { type: string } });
  assert.deepEqual(added.map((event) => [event.item.type, event.output_index]), [["function_call", 0], ["message", 1]]);
  const completed = frames.at(-1)!.data as { response: { output: { type: string }[] } };
  assert.deepEqual(completed.response.output.map((item) => item.type), ["function_call", "message"]);
});

test("response objects echo the official request parameters", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Say hello",
      instructions: "Be terse.",
      max_output_tokens: 256,
      temperature: 0.3,
      top_p: 0.9,
      truncation: "auto",
      user: "user-42",
      parallel_tool_calls: false,
      tool_choice: "required",
      text: { format: { type: "text" } },
      reasoning: { effort: "high" },
      metadata: { trace: "abc" },
      tools: [FLAT_WEATHER_TOOL]
    }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.instructions, "Be terse.");
  assert.equal(body.max_output_tokens, 256);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.truncation, "auto");
  assert.equal(body.user, "user-42");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.text, { format: { type: "text" } });
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.background, false);
  assert.equal(body.store, true);
  assert.equal(body.error, null);
  assert.equal(body.incomplete_details, null);
  // store 是顶层契约字段，不再污染客户端的 metadata。
  assert.deepEqual(body.metadata, { trace: "abc" });
  // 锁定完整字段集：漏掉任何一个官方字段（或多出未声明字段）都要让这条测试失败。
  assert.deepEqual(Object.keys(body).sort(), [
    "background",
    "completed_at",
    "created_at",
    "cursor_agent_id",
    "cursor_run_id",
    "error",
    "id",
    "incomplete_details",
    "instructions",
    "max_output_tokens",
    "metadata",
    "model",
    "object",
    "output",
    "parallel_tool_calls",
    "previous_response_id",
    "reasoning",
    "status",
    "store",
    "temperature",
    "text",
    "tool_choice",
    "tools",
    "top_p",
    "truncation",
    "usage",
    "user"
  ]);
  assert.deepEqual(body.usage.input_tokens_details, { cached_tokens: 0 });
});

test("responses stream snapshots use the same field set as the non-streaming object", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const streamed = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello" }
  });
  const plain = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello" }
  });
  const frames = sseFrames(streamed.body);
  const created = (frames[0].data as { response: Record<string, unknown> }).response;
  const completed = (frames.at(-1)!.data as { response: Record<string, unknown> }).response;
  const expected = Object.keys(plain.json()).sort();
  assert.deepEqual(Object.keys(created).sort(), expected, "response.created must be a full snapshot");
  assert.deepEqual(Object.keys(completed).sort(), expected, "response.completed must be a full snapshot");
  // 每个事件的 SSE event 名必须与 data.type 一致。
  for (const frame of frames) assert.equal(frame.event, (frame.data as { type: string }).type);
});

test("responses stream created/in_progress carry a full response snapshot", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello", instructions: "Be terse.", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const frames = sseFrames(response.body);
  const created = frames[0].data as { sequence_number: number; response: Record<string, unknown> };
  assert.equal(created.sequence_number, 1);
  assert.equal(created.response.status, "in_progress");
  assert.deepEqual(created.response.output, []);
  assert.equal(created.response.usage, null);
  assert.equal(created.response.completed_at, null);
  assert.equal(created.response.instructions, "Be terse.");
  assert.deepEqual(created.response.tools, [FLAT_WEATHER_TOOL]);
  const inProgress = frames[1].data as { sequence_number: number; response: Record<string, unknown> };
  assert.equal(inProgress.sequence_number, 2);
  // in_progress 必须是和 created 一样的完整快照，不能退化成精简对象。
  assert.deepEqual(inProgress.response, created.response);

  // sequence_number 在整条响应内从 1 起严格递增。
  const sequences = frames.map((frame) => (frame.data as { sequence_number: number }).sequence_number);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));

  const completed = frames.at(-1)!.data as { response: Record<string, unknown> };
  assert.equal(completed.response.status, "completed");
  assert.equal(typeof completed.response.completed_at, "number");
  assert.ok(completed.response.usage, "completed snapshot carries usage");
});

test("responses stream text events carry logprobs and item ids consistent with the snapshot", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["he", "llo"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello" }
  });
  const frames = sseFrames(response.body);
  const added = frames[2].data as { item: { id: string } };
  const partAdded = frames[3].data as Record<string, unknown>;
  assert.deepEqual(partAdded.part, { type: "output_text", text: "", annotations: [], logprobs: [] });
  const delta = frames[4].data as Record<string, unknown>;
  assert.equal(delta.item_id, added.item.id);
  assert.deepEqual(delta.logprobs, []);
  assert.equal(delta.delta, "he");
  const textDone = frames[6].data as Record<string, unknown>;
  assert.equal(textDone.text, "hello", "output_text.done must equal the concatenated deltas");
  const itemDone = frames[8].data as { item: { content: unknown[] } };
  assert.deepEqual(itemDone.item.content, [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }]);
});

// ---------------------------------------------------------------------------
// P0-7 store semantics
// ---------------------------------------------------------------------------

test("store:false responses are not persisted", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const created = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello", store: false }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().store, false);
  const loaded = await app.inject({
    method: "GET",
    url: `/v1/responses/${created.json().id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(loaded.statusCode, 404);

  const stored = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello" }
  });
  assert.equal(stored.json().store, true);
  const reloaded = await app.inject({
    method: "GET",
    url: `/v1/responses/${stored.json().id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(reloaded.statusCode, 200);
});

test("store:false streamed responses are not persisted", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, store: false, input: "Say hello" }
  });
  assert.equal(response.statusCode, 200);
  const completed = sseFrames(response.body).at(-1)!.data as { response: { id: string; store: boolean } };
  assert.equal(completed.response.store, false);
  const loaded = await app.inject({
    method: "GET",
    url: `/v1/responses/${completed.response.id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(loaded.statusCode, 404);
});

test("a client metadata key named store does not disable persistence", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const created = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello", metadata: { store: "false" } }
  });
  assert.equal(created.json().store, true);
  assert.deepEqual(created.json().metadata, { store: "false" });
  const loaded = await app.inject({
    method: "GET",
    url: `/v1/responses/${created.json().id}`,
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(loaded.statusCode, 200);
});

test("an explicit top-level store is never mirrored into metadata", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  for (const store of [true, false]) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer gateway-key" },
      payload: { model: "composer-2.5", input: "Say hello", store, metadata: { trace: "abc" } }
    });
    assert.equal(created.json().store, store);
    // 顶层 store 是数据保留契约，绝不能被合成进客户端的 metadata。
    assert.deepEqual(created.json().metadata, { trace: "abc" }, `store=${store}`);
  }

  const withoutMetadata = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello", store: false }
  });
  assert.deepEqual(withoutMetadata.json().metadata, {});
});

// ---------------------------------------------------------------------------
// P1-3 request leniency
// ---------------------------------------------------------------------------

test("logprobs:false and top_logprobs are accepted while logprobs:true stays rejected", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const lenient = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", logprobs: false, top_logprobs: 3, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(lenient.statusCode, 200);

  const responsesTopLogprobs = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", top_logprobs: 2, input: "Hello" }
  });
  assert.equal(responsesTopLogprobs.statusCode, 200);

  const rejected = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", logprobs: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error.type, "invalid_request_error");
});

test("explicitly disabled thinking suppresses the block without changing upstream intent", async () => {
  const runner = new FakeRunner({ thinking: ["should not appear"], chunks: ["answer"] });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      stream: true,
      // Claude Code 会同时带这两个字段；显式关闭必须压过 effort 提示（仅就"是否回传思考"而言）。
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("thinking_delta"), "explicitly disabled thinking must not emit thinking blocks");
  // 输出侧的门控不能改写发给 Cursor 上游的思考强度（对外格式修复不触碰内部转换）。
  assert.equal(runner.lastInput?.reasoningEffort, "high");
});

test("thinking display:omitted emits an empty thinking block but keeps the reasoning text out", async () => {
  const runner = new FakeRunner({ thinking: ["private reasoning"], chunks: ["answer"] });
  const { app } = await createTestApp({ runner });
  const streamed = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 2048, display: "omitted" },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  assert.equal(streamed.statusCode, 200);
  assert.ok(!streamed.body.includes("private reasoning"), "omitted thinking must not be streamed back");
  assert.ok(!streamed.body.includes("thinking_delta"), "no thinking text deltas in omitted mode");
  // 官方 omitted 语义：仍发**空 thinking 块**（start 带 signature 字段 + signature_delta 收尾），不是删除整个块。
  assert.match(streamed.body, /"content_block_start".*"type":"thinking"/);
  assert.match(streamed.body, /signature_delta/);
  // 思考本身仍然请求上游执行（budget 2048 → low），只是不回传文本。
  assert.equal(runner.lastInput?.reasoningEffort, "low");

  const plain = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 2048, display: "omitted" },
      messages: [{ role: "user", content: "Hello" }]
    }
  });
  const content = plain.json().content as { type: string; thinking?: string; signature?: string }[];
  assert.deepEqual(content.map((block) => block.type), ["thinking", "text"]);
  assert.equal(content[0].thinking, "", "omitted thinking block carries empty text");
  assert.ok(content[0].signature, "omitted thinking block still carries a signature");
  assert.ok(!JSON.stringify(content).includes("private reasoning"));
});

test("responses text defaults to the official object rather than null", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello" }
  });
  // text 是官方 schema 里的非 nullable 对象；null 会让严格解码器失败。
  assert.deepEqual(response.json().text, { format: { type: "text" } });
});

test("function_call_arguments.done carries the tool name", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ text: "", toolCalls: [{ id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }] })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather?", tools: [FLAT_WEATHER_TOOL] }
  });
  const done = sseFrames(response.body).find((frame) => frame.event === "response.function_call_arguments.done")!.data as Record<string, unknown>;
  assert.equal(done.name, "get_weather");
  assert.equal(done.arguments, '{"city":"Paris"}');
});

test("an invalid token limit does not mask a valid alias", async () => {
  const runner = new FakeRunner({ text: "hi" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Hello", max_tokens: 0, max_output_tokens: 512 }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(runner.lastInput?.maxTokens, 512);
  assert.equal(response.json().max_output_tokens, 512);
});

test("degenerate upstream tool call ids stay stable across the whole streaming lifecycle", async () => {
  const toolCall = { id: "call_", name: "get_weather", arguments: { city: "Paris" } };
  const runner: CursorRunner = {
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (): AsyncIterable<CursorStreamEvent> {
      yield { type: "tool_call", toolCall };
      yield { type: "done", result: { text: "", toolCalls: [toolCall] } };
    }
  };
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const frames = sseFrames(response.body);
  const added = frames[2].data as { item: { id: string; call_id: string } };
  assert.match(added.item.id, /^fc_.+/);
  assert.match(added.item.call_id, /^call_.+/);
  assert.notEqual(added.item.call_id, "call_");
  // 四个生命周期事件必须引用同一个 item id，否则客户端无法把参数拼回同一个调用。
  assert.equal((frames[3].data as { item_id: string }).item_id, added.item.id);
  assert.equal((frames[4].data as { item_id: string }).item_id, added.item.id);
  assert.equal((frames[5].data as { item: { id: string } }).item.id, added.item.id);
  const completed = frames.at(-1)!.data as { response: { output: { id: string; call_id: string }[] } };
  assert.equal(completed.response.output[0].id, added.item.id);
  assert.equal(completed.response.output[0].call_id, added.item.call_id);
});

test("two degenerate tool call ids do not collide with each other", async () => {
  const first = { id: "", name: "get_weather", arguments: { city: "Paris" } };
  const second = { id: "call_", name: "get_weather", arguments: { city: "Berlin" } };
  const runner: CursorRunner = {
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (): AsyncIterable<CursorStreamEvent> {
      yield { type: "tool_call", toolCall: first };
      yield { type: "tool_call", toolCall: second };
      yield { type: "done", result: { text: "", toolCalls: [first, second] } };
    }
  };
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather?", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const completed = sseFrames(response.body).at(-1)!.data as { response: { output: { id: string; call_id: string }[] } };
  const [a, b] = completed.response.output;
  assert.notEqual(a.call_id, b.call_id, "distinct tool calls must not share a call_id");
  assert.notEqual(a.id, b.id, "distinct tool calls must not share an item id");
  // 替身 id 也要在四个生命周期事件之间保持一致。
  const added = sseFrames(response.body).filter((frame) => frame.event === "response.output_item.added").map((frame) => (frame.data as { item: { id: string } }).item.id);
  assert.deepEqual(added, [a.id, b.id]);
});

test("nested tool echo preserves fields like strict", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "ok" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: {
      model: "composer-2.5",
      input: "Weather?",
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} }, strict: true } }]
    }
  });
  assert.deepEqual(response.json().tools, [
    { type: "function", name: "get_weather", parameters: { type: "object", properties: {} }, strict: true }
  ]);
});

test("tool call ids stay consistent across every streamed lifecycle event", async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ text: "", toolCalls: [{ id: "tool_abc123", name: "get_weather", arguments: { city: "Paris" } }] })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Weather?", tools: [FLAT_WEATHER_TOOL] }
  });
  const frames = sseFrames(response.body);
  const added = frames[2].data as { item: { id: string; call_id: string } };
  // 上游未带 call_ 前缀时补上，item id 用 fc_ 前缀。
  assert.equal(added.item.id, "fc_tool_abc123");
  assert.equal(added.item.call_id, "call_tool_abc123");
  assert.equal((frames[3].data as { item_id: string }).item_id, "fc_tool_abc123");
  assert.equal((frames[4].data as { item_id: string }).item_id, "fc_tool_abc123");
});

test("max_completion_tokens is parsed as a max_tokens synonym", async () => {
  const runner = new FakeRunner({ text: "hi" });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", max_completion_tokens: 128, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(runner.lastInput?.maxTokens, 128);
});

// ---------------------------------------------------------------------------
// P1-10 / P1-12 error envelope and status mapping
// ---------------------------------------------------------------------------

test("openai errors use the official type taxonomy and keep specifics in code", async () => {
  const { app } = await createTestApp();
  const unauthorized = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.json(), {
    error: { message: "Missing or invalid API key.", type: "authentication_error", param: null, code: "unauthorized" }
  });

  const badParam = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", n: 3, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(badParam.statusCode, 400);
  assert.deepEqual(badParam.json().error, {
    message: "n greater than 1 is not supported.",
    type: "invalid_request_error",
    param: "n",
    code: "unsupported_parameter"
  });
});

test("anthropic errors carry the official type plus a request id", async () => {
  const { app } = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key" },
    payload: {
      model: "composer-2.5",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", data: "x" } }] }]
    }
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /Gateway limitation/);
  assert.match(body.request_id, /^req_/);
  assert.equal(response.headers["request-id"], body.request_id);

  const missingKey = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "composer-2.5", max_tokens: 8, messages: [] } });
  assert.equal(missingKey.statusCode, 401);
  assert.equal(missingKey.json().error.type, "authentication_error");
});

test("upstream 402 becomes 429 insufficient_quota on OpenAI endpoints and stays billing_error on Anthropic", async () => {
  const runner = new FakeRunner({ text: "hi" });
  runner.failWith.set("direct-cursor-key", new ApiError("You have run out of credits.", 402, "billing_error"));
  const { app } = await createTestApp({ runner });

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chat.statusCode, 429);
  assert.deepEqual(chat.json().error, {
    message: "You have run out of credits.",
    type: "rate_limit_error",
    param: null,
    code: "insufficient_quota"
  });

  const messages = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "direct-cursor-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(messages.statusCode, 402);
  assert.equal(messages.json().error.type, "billing_error");
});

test("fastify body errors keep their own status instead of becoming 500", async () => {
  const { app } = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key", "content-type": "application/json" },
    payload: "{\"model\": broken"
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.type, "invalid_request_error");
});

test("error taxonomy maps every status class for both protocols", () => {
  const openAi: [number, string][] = [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "invalid_request_error"],
    [413, "invalid_request_error"],
    [429, "rate_limit_error"],
    [499, "server_error"],
    [500, "server_error"],
    [502, "server_error"],
    [504, "server_error"]
  ];
  for (const [status, type] of openAi) {
    assert.equal(openAiErrorType(status), type, `openai ${status}`);
  }
  // 402 在 OpenAI 侧不存在：状态改 429，code 换成 insufficient_quota。
  assert.equal(openAiStatus(402), 429);
  assert.equal(openAiStatus(503), 503);
  assert.deepEqual(openAiError(new ApiError("out of credits", 402, "billing_error")), {
    error: { message: "out of credits", type: "rate_limit_error", param: null, code: "insufficient_quota" }
  });

  const anthropic: [number, string][] = [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [499, "api_error"],
    [500, "api_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"]
  ];
  for (const [status, type] of anthropic) {
    assert.equal(anthropicErrorType(status), type, `anthropic ${status}`);
  }

  const first = newRequestId();
  const second = newRequestId();
  assert.match(first, /^req_[0-9a-f]{32}$/);
  assert.notEqual(first, second);
  assert.equal(anthropicError(new ApiError("nope", 429, "rate_limit_exceeded"), "req_fixed").request_id, "req_fixed");
});

test("anthropic responses always carry a request-id header", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ text: "hi" }) });
  const ok = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers["request-id"] as string, /^req_[0-9a-f]{32}$/);
  // 成功响应体不带 request_id（只有错误体带）。
  assert.ok(!("request_id" in ok.json()), "success bodies must not carry request_id");

  const streamed = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.match(streamed.headers["request-id"] as string, /^req_[0-9a-f]{32}$/);
  assert.notEqual(streamed.headers["request-id"], ok.headers["request-id"]);
});

test("idle timeout before the first upstream event returns a plain HTTP 504", { timeout: 5000 }, async () => {
  // 首个事件都没等到就超时：SSE 尚未提交，必须是真正的 HTTP 错误信封，而不是 200 + 流内错误。
  const { app } = await createTestApp({
    runner: new FakeRunner({ hangUntilAborted: true }),
    config: { requestTimeoutMs: 20 }
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 504);
  assert.equal(response.json().type, "error");
  assert.equal(response.json().error.type, "timeout_error");

  const chat = await createTestApp({
    runner: new FakeRunner({ hangUntilAborted: true }),
    config: { requestTimeoutMs: 20 }
  });
  const chatResponse = await chat.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chatResponse.statusCode, 504);
  assert.equal(chatResponse.json().error.type, "server_error");
  assert.equal(chatResponse.json().error.code, "timeout_error");
});

test("mid-stream idle timeouts surface as a 504 timeout error event", { timeout: 5000 }, async () => {
  // 已经吐过内容后才超时：流已提交，用规范的流内错误事件收场。
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], hangAfterChunks: true }),
    config: { requestTimeoutMs: 30 }
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"text_delta","text":"partial"/);
  const last = sseFrames(response.body).at(-1)?.data as { type: string; error: { type: string } };
  assert.equal(last.type, "error");
  assert.equal(last.error.type, "timeout_error");

  const chat = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], hangAfterChunks: true }),
    config: { requestTimeoutMs: 30 }
  });
  const chatResponse = await chat.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(chatResponse.statusCode, 200);
  const chatLast = sseFrames(chatResponse.body).at(-1)?.data as { error: { type: string; code: string } };
  assert.equal(chatLast.error.code, "timeout_error");
  assert.equal(chatLast.error.type, "server_error");
});

test("requests still time out when the upstream ignores abort signals entirely", { timeout: 5000 }, async () => {
  // 模拟 SDK 传输层挂死：既不产出事件、也永远不 settle、更不感知 abort signal。
  // 这类挂死曾让请求永久悬挂堆积（表现为服务器"卡死"），请求级竞速必须兜底成 504。
  const streaming = await createTestApp({
    runner: new FakeRunner({ hangIgnoringAbort: true }),
    config: { requestTimeoutMs: 20 }
  });
  const streamResponse = await streaming.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(streamResponse.statusCode, 504);
  assert.equal(streamResponse.json().error.code, "timeout_error");

  const blocking = await createTestApp({
    runner: new FakeRunner({ hangIgnoringAbort: true }),
    config: { requestTimeoutMs: 20 }
  });
  const blockingResponse = await blocking.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(blockingResponse.statusCode, 504);
  assert.equal(blockingResponse.json().error.code, "timeout_error");
});

test("mid-stream hangs that ignore abort still end with an in-stream 504 error event", { timeout: 5000 }, async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ chunks: ["partial"], hangAfterChunksIgnoringAbort: true }),
    config: { requestTimeoutMs: 30 }
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"content":"partial"/);
  const last = sseFrames(response.body).at(-1)?.data as { error: { type: string; code: string } };
  assert.equal(last.error.code, "timeout_error");
  assert.equal(last.error.type, "server_error");
});

test("upstream failure before the first event returns a plain HTTP error on all stream endpoints", async () => {
  for (const [url, headers, payload] of [
    ["/v1/chat/completions", { authorization: "Bearer direct-cursor-key" }, { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "Hi" }] }],
    ["/v1/responses", { authorization: "Bearer direct-cursor-key" }, { model: "composer-2.5", stream: true, input: "Hi" }],
    ["/v1/messages", { "x-api-key": "direct-cursor-key", "anthropic-version": "2023-06-01" }, { model: "composer-2.5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "Hi" }] }]
  ] as const) {
    const runner = new FakeRunner({ text: "unused" });
    runner.failWith.set("direct-cursor-key", new ApiError("Invalid API key provided", 401, "unauthorized"));
    const { app } = await createTestApp({ runner });
    const response = await app.inject({ method: "POST", url, headers: { ...headers }, payload });
    assert.equal(response.statusCode, 401, `${url} must fail with a real HTTP status`);
    assert.match(response.headers["content-type"] as string, /application\/json/, `${url} must not commit an SSE response`);
  }
});

test("responses stream synthesizes lifecycle events when the runner only reports via done", async () => {
  // 合法契约：runner 流阶段零增量，全部产出只在 done.result。
  const runner: CursorRunner = {
    run: async () => ({ text: "final text", toolCalls: [], reasoningText: "final reasoning" }),
    stream: async function* (): AsyncIterable<CursorStreamEvent> {
      yield {
        type: "done",
        result: {
          text: "final text",
          toolCalls: [{ id: "call_late", name: "get_weather", arguments: { city: "Lyon" } }],
          reasoningText: "final reasoning"
        }
      };
    }
  };
  const { app } = await createTestApp({ runner: runner as unknown as FakeRunner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Hi", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const body = response.body;
  assert.match(body, /response\.reasoning_summary_text\.delta/);
  assert.match(body, /"delta":"final text"/);
  assert.match(body, /response\.function_call_arguments\.done/);
  const completed = sseFrames(response.body).find((frame) => frame.event === "response.completed")?.data as { response: { output: { type: string }[] } };
  assert.deepEqual(completed.response.output.map((item) => item.type), ["reasoning", "message", "function_call"]);
});

test("normalized function call ids never collide across different raw ids", async () => {
  const runner = new FakeRunner({
    text: "",
    toolCalls: [
      { id: "foo", name: "get_weather", arguments: { city: "A" } },
      { id: "call_foo", name: "get_weather", arguments: { city: "B" } }
    ]
  });
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Hi", tools: [FLAT_WEATHER_TOOL] }
  });
  assert.equal(response.statusCode, 200);
  const calls = (response.json().output as { type: string; call_id?: string; id?: string }[]).filter((item) => item.type === "function_call");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].call_id, calls[1].call_id, "normalized call_ids must stay distinct");
  assert.notEqual(calls[0].id, calls[1].id, "normalized item ids must stay distinct");
});

test("hidden thinking does not block key rotation on streaming requests", async () => {
  const inner: CursorRunner = {
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
      if (input.apiKey === "key-a") {
        yield { type: "thinking", text: "hidden" };
        throw new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed");
      }
      yield { type: "text", text: "ok" };
      yield { type: "done", result: { text: "ok", toolCalls: [] } };
    }
  };
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["key-a", "key-b"]);
  const rotating = new KeyRotatingRunner(inner, keyPool);
  const events: CursorStreamEvent[] = [];
  // messages 端点未请求 thinking → thinkingVisible:false：thinking 会被端点丢弃，不算已交付，失败仍可换 key。
  for await (const event of rotating.stream({
    protocol: "anthropic-messages",
    apiKey: "",
    useKeyPool: true,
    model: "composer-2.5",
    prompt: "hi",
    sessionKey: "session",
    stream: true,
    thinkingVisible: false,
    workingDirectory: "/workspace",
    images: [],
    tools: []
  })) {
    events.push(event);
  }
  const texts = events.filter((event): event is { type: "text"; text: string } => event.type === "text").map((event) => event.text);
  assert.deepEqual(texts, ["ok"], "second key must serve the request");
});

test("raw upstream errors carrying a status do not leak it to the client", async () => {
  const runner = new FakeRunner({ text: "hi" });
  // 上游 SDK 错误常带 status；透传出去会让客户端以为是自己的 key/URL 有问题。
  runner.failWith.set("direct-cursor-key", Object.assign(new Error("upstream said no"), { status: 404 }));
  const { app } = await createTestApp({ runner });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer direct-cursor-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.type, "server_error");
  assert.equal(response.json().error.code, "internal_error");
});

test("non-streaming upstream timeouts surface as 504 timeout_error", { timeout: 5000 }, async () => {
  const { app } = await createTestApp({
    runner: new FakeRunner({ hangUntilAborted: true }),
    config: { requestTimeoutMs: 20 }
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 504);
  assert.equal(response.json().error.type, "server_error");
  assert.equal(response.json().error.code, "timeout_error");
});

test("anthropic message_start usage exposes the cache token counters", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ chunks: ["hi"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
  });
  const start = sseFrames(response.body)[0].data as { message: { usage: Record<string, number> } };
  assert.deepEqual(Object.keys(start.message.usage).sort(), [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens"
  ]);
  assert.equal(start.message.usage.cache_creation_input_tokens, 0);
  assert.equal(start.message.usage.cache_read_input_tokens, 0);
  assert.equal(start.message.usage.output_tokens, 0);
});

// ---------------------------------------------------------------------------
// P2-4 non-streaming reasoning
// ---------------------------------------------------------------------------

test("non-streaming chat returns aggregated thinking as reasoning_content", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["step one. ", "step two."], text: "answer" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.equal(response.statusCode, 200);
  const message = response.json().choices[0].message;
  assert.equal(message.content, "answer");
  assert.equal(message.reasoning_content, "step one. step two.");

  const withoutThinking = await createTestApp({ runner: new FakeRunner({ text: "answer" }) });
  const plain = await withoutThinking.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] }
  });
  assert.ok(!("reasoning_content" in plain.json().choices[0].message), "no reasoning field without thinking");
});

test("key rotation does not splice thinking from a failed attempt into the answer", async () => {
  // 非流式请求允许"吐过 thinking 后换 key 重试"；聚合出的思考只能来自最终成功的那次尝试。
  const inner: CursorRunner = {
    run: async () => ({ text: "", toolCalls: [] }),
    stream: async function* (input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
      if (input.apiKey === "key-a") {
        yield { type: "thinking", text: "discarded attempt" };
        throw new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed");
      }
      yield { type: "thinking", text: "kept attempt" };
      yield { type: "text", text: "ok" };
      yield { type: "done", result: { text: "ok", toolCalls: [], reasoningText: "kept attempt" } };
    }
  };
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["key-a", "key-b"]);
  const result = await new KeyRotatingRunner(inner, keyPool).run({
    protocol: "openai-chat",
    apiKey: "",
    useKeyPool: true,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    stream: false,
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });
  assert.equal(result.text, "ok");
  assert.equal(result.reasoningText, "kept attempt");
});

test("non-streaming responses include a reasoning item and reasoning token details", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["pondering"], text: "answer" }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "Say hello" }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.output.map((item: { type: string }) => item.type), ["reasoning", "message"]);
  assert.deepEqual(body.output[0].summary, [{ type: "summary_text", text: "pondering" }]);
  assert.match(body.output[0].id, /^rs_/);
  assert.equal(body.usage.output_tokens_details.reasoning_tokens, 3);
  assert.ok(body.usage.output_tokens >= body.usage.output_tokens_details.reasoning_tokens);
});

test("ephemeral agent store round-trips records, pages run events and stays bounded", async () => {
  const store = createEphemeralAgentStore();
  await store.agents.create({ agent: { agentId: "a1", cwd: "/w", status: "running", createdAt: 1, updatedAt: 1 } });
  await store.runs.create({ run: { runId: "r1", agentId: "a1", turnNumber: 1, status: "running", createdAt: 1, updatedAt: 1 } });
  await store.checkpoints.create({ agentId: "a1", blobId: "b1", data: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await store.checkpoints.get({ agentId: "a1", blobId: "b1" }), new Uint8Array([1, 2, 3]));
  assert.equal((await store.runs.get({ agentId: "a1", runId: "r1" }))?.runId, "r1");

  // 事件流：append 顺序 + afterOffset 精确续读（SDK 的 run.stream 依赖该语义）。
  await store.runEvents.append({ runId: "r1", eventType: "first", payload: { n: 1 } });
  await store.runEvents.append({ runId: "r1", eventType: "second", payload: { n: 2 } });
  const firstPage = await store.runEvents.list({ runId: "r1", limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].eventType, "first");
  assert.ok(firstPage.nextOffset);
  const secondPage = await store.runEvents.list({ runId: "r1", afterOffset: firstPage.nextOffset });
  assert.deepEqual(secondPage.items.map((event) => event.eventType), ["second"]);

  // 有界性：超过上限后最旧的 agent 连同 runs/blobs/events 一起被回收，不随请求数无限增长。
  for (let i = 0; i < 300; i += 1) {
    await store.agents.create({ agent: { agentId: `bulk-${i}`, cwd: "/w", status: "idle", createdAt: i, updatedAt: i } });
  }
  assert.equal(await store.agents.get({ agentId: "a1" }), null);
  assert.equal(await store.checkpoints.get({ agentId: "a1", blobId: "b1" }), null);
  assert.equal((await store.runEvents.list({ runId: "r1" })).items.length, 0);
  const listed = await store.agents.list({ filter: { limit: 1000 } });
  assert.ok(listed.items.length <= 256, `agent buckets must stay bounded, saw ${listed.items.length}`);
});

// ---------------------------------------------------------------------------
// thinking 签名 / usage 口径 / 404 信封 / count_tokens
// ---------------------------------------------------------------------------

test("thinking signatures are per-block opaque values rather than a shared constant", async () => {
  const headers = { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" };
  const payload = {
    model: "composer-2.5",
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: "Hello" }]
  };
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["deep thought"], text: "answer" }) });
  const signatureOf = (body: string): string => {
    const content = (JSON.parse(body) as { content: { type: string; signature?: string }[] }).content;
    const signature = content.find((block) => block.type === "thinking")?.signature;
    assert.ok(signature, "thinking 块必须带非空 signature");
    return signature;
  };

  const first = signatureOf((await app.inject({ method: "POST", url: "/v1/messages", headers, payload })).body);
  const second = signatureOf((await app.inject({ method: "POST", url: "/v1/messages", headers, payload })).body);
  const streamed = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...payload, stream: true } });
  const streamedSignature = sseFrames(streamed.body)
    .map((frame) => frame.data as { delta?: { type?: string; signature?: string } } | undefined)
    .find((data) => data?.delta?.type === "signature_delta")?.delta?.signature;
  assert.ok(streamedSignature, "流式 thinking 块要以 signature_delta 收尾");

  assert.equal(new Set([first, second, streamedSignature]).size, 3, "每个 thinking 块要有独立签名，不能是编译期常量");
  // 旧实现是 base64("docker-composer-api:opaque-thinking-signature")，解开即明文，容易被误当成可校验凭据。
  for (const signature of [first, second, streamedSignature]) {
    assert.ok(signature.length >= 64, "签名要足够长，避免被当成可校验的短凭据");
    assert.ok(!Buffer.from(signature, "base64").toString("utf8").includes("docker-composer-api"), "签名不得解码出可读明文");
  }
});

test("anthropic output_tokens are identical between streaming and non-streaming", async () => {
  const headers = { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" };
  const payload = {
    model: "composer-2.5",
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: "Hello" }]
  };
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["deep thought"], text: "answer" }) });

  const plain = await app.inject({ method: "POST", url: "/v1/messages", headers, payload });
  const streamed = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...payload, stream: true } });
  const messageDelta = sseFrames(streamed.body)
    .map((frame) => frame.data as { type?: string; usage?: { output_tokens: number } } | undefined)
    .find((data) => data?.type === "message_delta");
  assert.ok(messageDelta?.usage, "message_delta 必须带 usage");

  // 正文只算一次：旧的非流式实现用 JSON.stringify(content)，而 content 里已含正文与思考全文，
  // 同一次对话走两种模式报出的 output_tokens 差近一倍。
  const expected = Math.ceil(("answer".length + "deep thought".length + "[]".length) / 4);
  assert.equal(plain.json().usage.output_tokens, expected);
  assert.equal(messageDelta.usage.output_tokens, expected);
});

test("unknown routes answer with the endpoint's own error envelope", async () => {
  const { app } = await createTestApp();

  const anthropic = await app.inject({
    method: "POST",
    url: "/v1/messages/batches",
    headers: { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" },
    payload: {}
  });
  assert.equal(anthropic.statusCode, 404);
  const anthropicBody = anthropic.json();
  assert.equal(anthropicBody.type, "error");
  assert.equal(anthropicBody.error.type, "not_found_error");
  // 头与错误体里必须是同一个 request id，否则客户端拿去排查时对不上。
  assert.ok(typeof anthropicBody.request_id === "string" && anthropicBody.request_id.startsWith("req_"));
  assert.equal(anthropic.headers["request-id"], anthropicBody.request_id);

  const openai = await app.inject({
    method: "POST",
    url: "/v1/embeddings",
    headers: { authorization: "Bearer gateway-key" },
    payload: {}
  });
  assert.equal(openai.statusCode, 404);
  assert.equal(openai.json().error.type, "invalid_request_error");
  assert.equal(openai.json().error.code, "not_found");
});

test("count_tokens estimates input tokens without reaching the runner", async () => {
  const runner = new FakeRunner({ text: "answer" });
  const { app } = await createTestApp({ runner });
  const headers = { "x-api-key": "gateway-key", "anthropic-version": "2023-06-01" };
  const payload = { model: "composer-2.5", messages: [{ role: "user", content: "Hello there" }] };

  const counted = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", headers, payload });
  assert.equal(counted.statusCode, 200);
  const estimated = counted.json().input_tokens as number;
  assert.ok(Number.isInteger(estimated) && estimated > 0);
  // 不消耗上游额度，也不占用密钥池。
  assert.equal(runner.lastApiKey, "");

  // 与真实请求同口径：客户端拿它做预算判断时不会和随后报出的 usage 对不上。
  const real = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...payload, max_tokens: 64 } });
  assert.equal(real.json().usage.input_tokens, estimated);

  const unauthorized = await app.inject({ method: "POST", url: "/v1/messages/count_tokens", payload });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error.type, "authentication_error");
});
