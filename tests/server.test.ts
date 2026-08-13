import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createEphemeralAgentStore } from "../src/agent-store.js";
import { anthropicError, anthropicErrorType, ApiError, newRequestId, openAiError, openAiErrorType, openAiStatus } from "../src/errors.js";
import { CursorSdkRunner, toolCallsFromSdkEvent, upstreamRunError, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { CursorKeyPool, classifyKeyFailure } from "../src/key-pool.js";
import { KeyRotatingRunner, type KeyRotatingOptions } from "../src/key-rotating-runner.js";
import { parseModelSpec, resolveModelParams, type ModelCatalog } from "../src/model-params.js";
import type { ModelLister } from "../src/models.js";
import { parseToolMarkers } from "../src/protocol.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore, SqliteStateStore } from "../src/store.js";
import { normalizeToolCallForClient } from "../src/tool-compat.js";
import type { CursorRunRequest, CursorRunResult, CursorRunner, CursorStreamEvent, GatewayConfig, GatewayTool } from "../src/types.js";

const baseConfig: GatewayConfig = {
  host: "127.0.0.1",
  port: 0,
  cursorApiKeys: ["server-cursor-key"],
  gatewayApiKey: "gateway-key",
  adminPassword: "gateway-key",
  allowDirectCursorKeys: true,
  sqlitePath: ":memory:",
  cursorWorkingDirectory: "/workspace",
  requestTimeoutMs: 10_000,
  sdkClientVersion: "sdk-1.0.27",
  cursorSdkDisableSessionResume: true,
  cursorSdkUseHttp1ForAgent: false,
  cursorAllowBuiltinTools: false,
  maxKeyAttempts: 10,
  maxTransientAttempts: 3
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

  await store.reorderCursorKeys(["id-b"]);
  const reordered = await store.listCursorKeys();
  assert.deepEqual(reordered.map((key) => key.id), ["id-b", "id-a"]);
  assert.deepEqual(reordered.map((key) => key.sortOrder), [1, 2]);

  await store.saveSession("session-a", "agent-a");
  assert.equal(await store.getSession("session-a"), "agent-a");
  assert.equal(await store.deleteSession("session-a"), true);
  assert.equal(await store.getSession("session-a"), undefined);
});

test("returns 429 insufficient_quota when every key is exhausted", async () => {
  const runner = new FakeRunner({});
  runner.failFor.set("key-a", "quota exceeded");
  runner.failFor.set("key-b", "Insufficient credits remaining");
  const { app, keyPool } = await createTestApp({ runner, keys: ["key-a", "key-b"] });

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

  const keys = await keyPool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a");
  const keyB = keys.find((key) => key.apiKey === "key-b");
  assert.equal(keyA?.status, "disabled");
  assert.equal(keyA?.disabledReason, "key 无效");
  assert.match(keyA?.lastError ?? "", /invalid api key/i);
  assert.equal(keyB?.status, "active");
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
    keys: ["key-a", "key-b"]
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
  assert.equal(keyA?.disabledReason, "key 无效");
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

async function createTestApp(options: {
  runner?: CursorRunner;
  store?: MemoryStateStore;
  keys?: string[];
  config?: Partial<GatewayConfig>;
  runnerOptions?: KeyRotatingOptions;
  applyCursorSdkNetworkConfig?: (useHttp1ForAgent: boolean) => Promise<void>;
} = {}): Promise<{ app: ReturnType<typeof createApp>; store: MemoryStateStore; keyPool: CursorKeyPool }> {
  const store = options.store ?? new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(options.keys ?? ["server-cursor-key"]);
  const inner = options.runner ?? new FakeRunner();
  const runner = new KeyRotatingRunner(inner, keyPool, options.runnerOptions);
  const modelLister: ModelLister = async () => ({
    models: [
      { id: "composer-2.5", name: "Cursor Composer 2.5", aliases: ["composer-latest", "composer"] },
      { id: "claude-fable-5", name: "Fable 5", aliases: ["fable", "fable-5"] }
    ],
    source: "cursor"
  });
  const app = createApp({
    config: { ...baseConfig, ...options.config },
    store,
    runner,
    keyPool,
    modelLister,
    applyCursorSdkNetworkConfig: options.applyCursorSdkNetworkConfig
  });
  return { app, store, keyPool };
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
  } = {}) {}

  async run(input: CursorRunRequest): Promise<CursorRunResult> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    if (this.output.hangIgnoringAbort) await new Promise(() => undefined);
    return {
      text: this.output.text ?? "ok",
      toolCalls: this.output.toolCalls ?? [],
      agentId: "agent-test",
      runId: "run-test"
    };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    if (this.output.hangIgnoringAbort) await new Promise(() => undefined);
    if (this.output.hangUntilAborted) await abortedPromise(signal);
    for (const thinking of this.output.thinking ?? []) {
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
    const thinking = (this.output.thinking ?? []).join("");
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
