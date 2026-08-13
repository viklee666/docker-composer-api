import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { CursorSdkRunner, toolCallsFromSdkEvent, upstreamRunError, type AgentFactory } from "../src/cursor-runner.js";
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
    payload: {
      model: "composer-2.5",
      stream: true,
      input: "Weather in Paris?",
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }]
    }
  });
  assert.equal(response.statusCode, 200);
  const toolAdded = response.body
    .split("\n\n")
    .find((chunk) => chunk.includes("event: response.output_item.added") && chunk.includes('"type":"function_call"'));
  assert.ok(toolAdded, "stream should include a function_call output item");
  assert.match(toolAdded, /"output_index":0/);
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
    payload: {
      model: "composer-2.5",
      stream: true,
      input: "Weather in Paris?",
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }]
    }
  });
  assert.equal(response.statusCode, 200);
  const toolAdded = response.body
    .split("\n\n")
    .find((chunk) => chunk.includes("event: response.output_item.added") && chunk.includes('"type":"function_call"'));
  assert.ok(toolAdded, "stream should include a function_call output item");
  assert.match(toolAdded, /"output_index":1/);
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

test("responses stream keeps alive during thinking and emits completion events", async () => {
  const { app } = await createTestApp({ runner: new FakeRunner({ thinking: ["pondering"], chunks: ["answer"] }) });
  const response = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", stream: true, input: "Say hello" }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /^: thinking$/m, "thinking should surface as SSE keepalive comments");
  assert.match(response.body, /event: response\.output_text\.done/);
  assert.match(response.body, /event: response\.content_part\.done/);
  assert.match(response.body, /event: response\.output_item\.done/);
  assert.match(response.body, /event: response\.completed/);
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
    payload: { model: "composer-2.5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hello" }] }
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
  runner?: FakeRunner;
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

  constructor(private readonly output: Partial<CursorRunResult> & { chunks?: string[]; thinking?: string[] } = {}) {}

  async run(input: CursorRunRequest): Promise<CursorRunResult> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    return {
      text: this.output.text ?? "ok",
      toolCalls: this.output.toolCalls ?? [],
      agentId: "agent-test",
      runId: "run-test"
    };
  }

  async *stream(input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
    this.lastApiKey = input.apiKey;
    this.lastInput = input;
    this.seen.push(input.apiKey);
    this.maybeFail(input);
    for (const thinking of this.output.thinking ?? []) {
      yield { type: "thinking", text: thinking };
    }
    const chunks = this.output.chunks ?? (this.output.text ? [this.output.text] : []);
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      yield { type: "text", text: chunk };
    }
    for (const toolCall of this.output.toolCalls ?? []) {
      yield { type: "tool_call", toolCall };
    }
    yield {
      type: "done",
      result: {
        text: this.output.text ?? text,
        toolCalls: this.output.toolCalls ?? [],
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
