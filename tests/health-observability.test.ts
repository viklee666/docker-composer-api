import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { sha256 } from "../src/auth.js";
import { ApiError } from "../src/errors.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import {
  durableTelemetrySnapshot,
  recordDurableCache,
  recordDurableDecision,
  resetDurableTelemetry
} from "../src/durable-telemetry.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayConfig,
  RequestLogRecord,
  RequestUsage
} from "../src/types.js";

const GATEWAY_KEY = "gateway-key";
const ADMIN_PASSWORD = "gateway-key";

beforeEach(() => {
  resetDurableTelemetry();
});

test("/health is public and includes gitCommit, builtAt, sessionMode, uptimeSeconds", async () => {
  const prevSha = process.env.GIT_SHA;
  const prevBuilt = process.env.BUILT_AT;
  process.env.GIT_SHA = "deadbeefcafebabe";
  process.env.BUILT_AT = "2026-09-03T10:00:00Z";
  try {
    const { app } = await bootApp({
      startedAt: Date.now() - 4_500,
      config: { cursorSdkDisableSessionResume: false, cursorSdkSessionMode: "durable" }
    });
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.gitCommit, "deadbeefcafebabe");
    assert.equal(body.builtAt, "2026-09-03T10:00:00Z");
    assert.equal(body.sessionMode, "durable");
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.ok((body.uptimeSeconds as number) >= 4);
    assert.equal(body.storage, "sqlite");
    const durable = body.durable as { hitRatio: number | null; decisions: Record<string, number>; recent?: unknown };
    assert.ok(durable);
    assert.equal(durable.recent, undefined);
    assert.equal(durable.hitRatio, null);
  } finally {
    restoreEnv("GIT_SHA", prevSha);
    restoreEnv("BUILT_AT", prevBuilt);
  }
});

test("/health sessionMode is stateless when the kill switch is on", async () => {
  const { app } = await bootApp({
    config: { cursorSdkDisableSessionResume: true, cursorSdkSessionMode: "durable" }
  });
  const body = (await app.inject({ method: "GET", url: "/health" })).json() as { sessionMode: string };
  assert.equal(body.sessionMode, "stateless");
});

test("/health durable summary reports hitRatio without session ids", async () => {
  recordDurableCache({ inputTokens: 70, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 8 });
  recordDurableDecision({ decision: "reuse", session: "should-not-appear-on-health" });
  const { app } = await bootApp();
  const body = (await app.inject({ method: "GET", url: "/health" })).json() as {
    durable: { hitRatio: number | null; decisions: Record<string, number> };
  };
  assert.equal(body.durable.hitRatio, 0.3);
  assert.equal(body.durable.decisions.reuse, 1);
  assert.equal(JSON.stringify(body).includes("should-not-appear-on-health"), false);
});

test("unknown gitCommit and builtAt default to unknown", async () => {
  const prevSha = process.env.GIT_SHA;
  const prevBuilt = process.env.BUILT_AT;
  delete process.env.GIT_SHA;
  delete process.env.BUILT_AT;
  try {
    const { app } = await bootApp();
    const body = (await app.inject({ method: "GET", url: "/health" })).json() as { gitCommit: string; builtAt: string };
    assert.equal(body.gitCommit, "unknown");
    assert.equal(body.builtAt, "unknown");
  } finally {
    restoreEnv("GIT_SHA", prevSha);
    restoreEnv("BUILT_AT", prevBuilt);
  }
});

test("CORS allow-headers includes claude-code agent id headers", async () => {
  const { app } = await bootApp();
  const response = await app.inject({ method: "OPTIONS", url: "/v1/chat/completions" });
  assert.equal(response.statusCode, 204);
  const allowed = String(response.headers["access-control-allow-headers"] ?? "");
  assert.match(allowed, /x-claude-code-agent-id/);
  assert.match(allowed, /x-claude-code-parent-agent-id/);
});

test("errorHandler writes a request_logs row for 401 before beginLog", async () => {
  const { app, store } = await bootApp();
  const { errors } = await withConsoleError(async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(response.statusCode, 401);
    await tick();
    return response;
  });
  const row = latestStoreLog(store, "/v1/chat/completions");
  assert.equal(row.status, 401);
  assert.ok(row.error);
  assert.match(row.error, /API key/i);
  assert.equal(row.model, undefined);
  assert.equal(row.stream, false);
  assert.equal(row.authMode, "gateway");
  assert.ok(errors.some((line) => line.includes("[request]") && line.includes("status=401")));
});

test("errorHandler writes a request_logs row for prepare 400 before beginLog", async () => {
  const { app, store } = await bootApp();
  const { errors } = await withConsoleError(async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_KEY}` },
      payload: { model: "composer-2.5", n: 3, messages: [{ role: "user", content: "Hello" }] }
    });
    assert.equal(response.statusCode, 400);
    await tick();
    return response;
  });
  const row = latestStoreLog(store, "/v1/chat/completions");
  assert.equal(row.status, 400);
  assert.ok(row.error);
  assert.match(row.error, /n greater than 1/);
  assert.ok(errors.some((line) => line.includes("[request]") && line.includes("status=400")));
});

test("finishLog console-errors 400 after beginLog and records provider plus cache usage", async () => {
  const runner = new CaptureRunner(
    undefined,
    new ApiError("mapped client error", 400, "invalid_request_error")
  );
  const { app, store } = await bootApp({ runner });
  const { errors } = await withConsoleError(async () => {
    const response = await app.inject(chat({ content: "fail please" }));
    assert.equal(response.statusCode, 400);
    await tick();
    return response;
  });
  const row = latestStoreLog(store, "/v1/chat/completions");
  assert.equal(row.status, 400);
  assert.equal(row.error, "mapped client error");
  assert.equal(row.provider, "sdk");
  assert.ok(errors.some((line) => line.includes("[request]") && line.includes("status=400")));
});

test("successful run sets ownerHash, provider, and feeds cache telemetry", async () => {
  const usage: RequestUsage = {
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    totalTokens: 120
  };
  const runner = new CaptureRunner(usage);
  const { app, store } = await bootApp({ runner });
  const response = await app.inject(chat({ content: "ping" }));
  assert.equal(response.statusCode, 200);
  await tick();
  assert.equal(runner.last?.ownerHash, sha256(`gateway:${GATEWAY_KEY}`));
  assert.equal(runner.last?.provider, "sdk");
  const row = latestStoreLog(store, "/v1/chat/completions");
  assert.equal(row.status, 200);
  assert.equal(row.provider, "sdk");
  const snap = durableTelemetrySnapshot();
  assert.equal(snap.cache.requests, 1);
  assert.equal(snap.cache.hitRatio, 20 / 100);
});

test("identitySource records header, body-field, and derived-L3 from the three endpoints", async () => {
  const { app } = await bootApp();
  const header = await app.inject(chat({
    content: "header path",
    headers: { "x-session-id": "header-session-aaa" }
  }));
  assert.equal(header.statusCode, 200);

  const bodyField = await app.inject(chat({
    content: "body path",
    extra: { session_id: "body-session-bbb" }
  }));
  assert.equal(bodyField.statusCode, 200);

  const derived = await app.inject(chat({ content: "derived path only" }));
  assert.equal(derived.statusCode, 200);

  const messages = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": GATEWAY_KEY, "x-session-id": "anthropic-header" },
    payload: { model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(messages.statusCode, 200);

  const snap = durableTelemetrySnapshot();
  assert.equal(snap.identitySource.header, 2);
  assert.equal(snap.identitySource["body-field"], 1);
  assert.equal(snap.identitySource["derived-L3"], 1);
});

test("/admin/api/overview includes the durable snapshot", async () => {
  recordDurableDecision({ decision: "resume", session: "overviewsessxx", reason: "ok" });
  const { app } = await bootApp();
  const response = await app.inject({
    method: "GET",
    url: "/admin/api/overview",
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` }
  });
  assert.equal(response.statusCode, 200);
  const durable = response.json().durable as {
    cache: { hitRatio: number | null };
    decisions: Record<string, number>;
    identitySource: Record<string, number>;
    recent: Array<{ session?: string; decision: string }>;
  };
  assert.ok(durable);
  assert.equal(durable.decisions.resume, 1);
  assert.equal(durable.recent[0].session, "overviewsess");
  assert.equal(durable.recent[0].session?.length, 12);
  assert.equal(typeof durable.identitySource.header, "number");
});

class CaptureRunner implements CursorRunner {
  last?: CursorRunRequest;

  constructor(
    private readonly usage?: RequestUsage,
    private readonly fail?: Error
  ) {}

  async run(input: CursorRunRequest): Promise<CursorRunResult> {
    this.last = input;
    if (this.fail) throw this.fail;
    if (this.usage && input.telemetryRef) input.telemetryRef.usage = this.usage;
    return { text: "ok", toolCalls: [] };
  }

  async *stream(input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
    this.last = input;
    if (this.fail) throw this.fail;
    if (this.usage && input.telemetryRef) input.telemetryRef.usage = this.usage;
    yield { type: "done", result: { text: "ok", toolCalls: [] } };
  }
}

async function bootApp(options: {
  runner?: CursorRunner;
  startedAt?: number;
  config?: Partial<GatewayConfig>;
} = {}): Promise<{ app: ReturnType<typeof createApp>; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  const config = makeConfig(options.config);
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key-a"]);
  const app = createApp({
    config,
    store,
    runner: options.runner ?? new CaptureRunner(),
    keyPool,
    startedAt: options.startedAt,
    modelLister: async () => ({
      models: [{ id: "composer-2.5", name: "Composer 2.5", aliases: [] }],
      source: "cursor"
    })
  });
  return { app, store };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    cursorApiKeys: ["cursor-key-a"],
    gatewayApiKey: GATEWAY_KEY,
    adminPassword: ADMIN_PASSWORD,
    allowDirectCursorKeys: true,
    sqlitePath: ":memory:",
    requestLogKeep: 0,
    cursorWorkingDirectory: "/workspace",
    requestTimeoutMs: 10_000,
    sdkClientVersion: "sdk-test",
    cursorSdkDisableSessionResume: true,
    cursorSdkSessionMode: "stateless",
    cursorSdkToolHoldTtlMs: 900_000,
    cursorSdkSessionIdleTtlMs: 3_600_000,
    cursorSdkMaxLiveSessions: 256,
    cursorAllowBuiltinTools: false,
    cursorSdkUseHttp1ForAgent: false,
    maxKeyAttempts: 10,
    maxTransientAttempts: 3,
    autoDisableKeys: true,
    autoDisableThreshold: 2,
    sandClientMode: false,
    routingStrategy: "fill-first",
    sessionAffinity: false,
    sessionAffinityTtlMs: 60 * 60 * 1000,
    systemPromptMode: "off",
    cursorPrewarm: false,
    ...overrides
  };
}

function chat(input: {
  content: string;
  headers?: Record<string, string>;
  extra?: Record<string, unknown>;
}): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  return {
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, ...input.headers },
    payload: {
      model: "composer-2.5",
      messages: [{ role: "user", content: input.content }],
      ...input.extra
    }
  };
}

function latestStoreLog(store: MemoryStateStore, endpoint: string): RequestLogRecord {
  const row = [...store.requestLogs].reverse().find((log) => log.endpoint === endpoint);
  assert.ok(row, `no request log for ${endpoint}`);
  return row;
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function withConsoleError<T>(work: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const result = await work();
    return { result, errors };
  } finally {
    console.error = original;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
