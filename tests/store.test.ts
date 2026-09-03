import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadConfig, shouldUseDurableHub } from "../src/config.js";
import { NO_KEY_SENTINEL } from "../src/routing.js";
import { MemoryStateStore, SqliteStateStore } from "../src/store.js";
import type { CursorKeyRecord, GatewayKeyRecord, RequestLogRecord } from "../src/types.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "composer-store-")), "state.sqlite");
}

/** 按 0.4.2 及更早版本的 schema 建库，用来验证升级路径不丢数据。 */
function seedLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cursor_keys (
      id TEXT PRIMARY KEY, api_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'manual',
      disabled_reason TEXT, disabled_at TEXT, last_used_at TEXT, last_error TEXT,
      request_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE request_logs (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT,
      auth_mode TEXT NOT NULL, key_id TEXT, key_label TEXT, status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, stream INTEGER NOT NULL DEFAULT 0, error TEXT
    );
  `);
  db.prepare(
    "INSERT INTO cursor_keys (id, api_key, label, status, source, request_count, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run("k-old", "key_legacy_value", "legacy", "active", "manual", 7, new Date().toISOString());
  db.prepare(
    "INSERT INTO request_logs (id, ts, endpoint, auth_mode, status, duration_ms) VALUES (?,?,?,?,?,?)"
  ).run("log-old", new Date().toISOString(), "/v1/chat/completions", "gateway", 200, 1234);
  db.close();
}

function key(overrides: Partial<CursorKeyRecord> = {}): CursorKeyRecord {
  return {
    id: "k1",
    apiKey: "key_one",
    label: "one",
    status: "active",
    source: "manual",
    sortOrder: 1,
    requestCount: 0,
    failureCount: 0,
    clientType: "inherit",
    modelScope: { allowed: [], excluded: [] },
    weight: 1,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function gatewayKey(overrides: Partial<GatewayKeyRecord> = {}): GatewayKeyRecord {
  return {
    id: "gw-1",
    apiKey: "gw-secret",
    label: "client-a",
    status: "active",
    source: "manual",
    allowedCursorKeyIds: [],
    modelScope: { allowed: [], excluded: [] },
    requestCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function log(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  return {
    id: "log-1",
    ts: new Date().toISOString(),
    endpoint: "/v1/messages",
    model: "composer-2.5",
    authMode: "gateway",
    status: 200,
    durationMs: 120,
    stream: false,
    ...overrides
  };
}

test("upgrading an old database keeps existing rows and backfills new columns", async () => {
  const path = tempDbPath();
  seedLegacyDatabase(path);
  const store = new SqliteStateStore(path);

  const keys = await store.listCursorKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].id, "k-old");
  assert.equal(keys[0].requestCount, 7, "existing counters must survive the migration");
  assert.deepEqual(keys[0].modelScope, { allowed: [], excluded: [] }, "no scope means unrestricted");
  assert.equal(keys[0].weight, 1);
  assert.equal(keys[0].sortOrder, 1, "sort_order backfills from rowid so取用顺序不变");

  const logs = await store.listRequestLogs({ limit: 10 });
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].id, "log-old");
  assert.equal(logs.logs[0].usage, undefined, "old rows report no usage rather than zeroes");
  assert.equal(logs.logs[0].effectiveParams, undefined, "老记录没有实测标记，后台据此把三列都按请求意图展示");

  // 迁移必须可重复执行：进程重启会再跑一遍。
  const reopened = new SqliteStateStore(path);
  assert.equal((await reopened.listCursorKeys()).length, 1);
});

test("cursor key model scope and weight round-trip through sqlite", async () => {
  const store = new SqliteStateStore(tempDbPath());
  await store.insertCursorKey(key());
  await store.updateCursorKey("k1", {
    modelScope: { allowed: ["gpt-5.6", "composer-2.5"], excluded: ["claude-opus-4-8"] },
    weight: 5
  });
  const [updated] = await store.listCursorKeys();
  assert.deepEqual(updated.modelScope, { allowed: ["gpt-5.6", "composer-2.5"], excluded: ["claude-opus-4-8"] });
  assert.equal(updated.weight, 5);

  // 非法权重要被夹到最小 1，否则加权轮询会除零 / 永不选中。
  await store.updateCursorKey("k1", { weight: 0 });
  assert.equal((await store.listCursorKeys())[0].weight, 1);
});

test("gateway keys round-trip and deleting the last bound cursor key denies everything", async () => {
  const store = new SqliteStateStore(tempDbPath());
  await store.insertCursorKey(key());
  await store.insertCursorKey(key({ id: "k2", apiKey: "key_two", sortOrder: 2 }));
  await store.insertGatewayKey(gatewayKey({
    allowedCursorKeyIds: ["k1", "k2"],
    modelScope: { allowed: [], excluded: ["claude-opus-4-8"] }
  }));

  const found = await store.getGatewayKeyByValue("gw-secret");
  assert.equal(found?.id, "gw-1");
  assert.deepEqual(found?.allowedCursorKeyIds, ["k1", "k2"]);
  assert.deepEqual(found?.modelScope.excluded, ["claude-opus-4-8"]);

  await store.deleteCursorKey("k1");
  const partial = await store.getGatewayKeyByValue("gw-secret");
  assert.deepEqual(partial?.allowedCursorKeyIds, ["k2"], "还有别的绑定时只剔掉被删的那把");

  await store.deleteCursorKey("k2");
  const after = await store.getGatewayKeyByValue("gw-secret");
  assert.deepEqual(
    after?.allowedCursorKeyIds,
    [NO_KEY_SENTINEL],
    "剔空必须落到哨兵：留成 [] 的语义是「不限制」，删 key 反而会把这把密钥放开成整池可用"
  );
});

test("session bindings expire strictly by age and are dropped with their key", async () => {
  const store = new SqliteStateStore(tempDbPath());
  await store.insertCursorKey(key());
  await store.saveSessionBinding("hash-1", "k1");

  assert.equal((await store.getSessionBinding("hash-1", 60_000))?.keyId, "k1");
  // ttl=0 表示「年龄必须小于 0ms」，即全部过期；用 >= 比较会在同毫秒读写时误判为有效。
  assert.equal(await store.getSessionBinding("hash-1", 0), undefined);
  assert.equal(await store.pruneSessionBindings(0), 1);

  await store.saveSessionBinding("hash-2", "k1");
  await store.deleteCursorKey("k1");
  assert.equal(await store.getSessionBinding("hash-2", 60_000), undefined, "绑定必须随 key 一起消失");
});

test("request logs persist parameter snapshot, usage and cost", async () => {
  const store = new SqliteStateStore(tempDbPath());
  await store.insertRequestLog(log({
    id: "rich",
    reasoningEffort: "high",
    maxMode: true,
    fast: false,
    clientType: "sdk",
    agentMode: "agent",
    modelParams: [{ id: "context", value: "1m" }, { id: "effort", value: "high" }],
    effectiveParams: ["reasoningEffort", "fast"],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 15, reasoningTokens: 3 },
    usageSource: "sdk",
    cost: { rawCostCents: 1.5, chargedCents: 0 }
  }));

  const [stored] = (await store.listRequestLogs({ limit: 5 })).logs;
  assert.equal(stored.reasoningEffort, "high");
  assert.equal(stored.maxMode, true);
  assert.equal(stored.fast, false, "false 与「未记录」必须区分开");
  assert.deepEqual(stored.effectiveParams, ["reasoningEffort", "fast"], "哪几列是实测值必须能读回来，否则区分不了实测与意图");
  assert.equal(stored.clientType, "sdk");
  assert.equal(stored.agentMode, "agent");
  assert.deepEqual(stored.modelParams, [{ id: "context", value: "1m" }, { id: "effort", value: "high" }]);
  assert.deepEqual(stored.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 15, reasoningTokens: 3 });
  assert.equal(stored.usageSource, "sdk");
  // chargedCents 为 0 是套餐内用量的正常结果，不能被当成「没记录」丢掉。
  assert.deepEqual(stored.cost, { rawCostCents: 1.5, chargedCents: 0 });
});

test("request log listing paginates and filters", async () => {
  const store = new SqliteStateStore(tempDbPath());
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    await store.insertRequestLog(log({
      id: `log-${i}`,
      ts: new Date(now - i * 1000).toISOString(),
      model: i % 2 ? "composer-2.5" : "gpt-5.6",
      status: i === 4 ? 500 : 200,
      keyId: "kk",
      gatewayKeyId: "gw-1"
    }));
  }

  const first = await store.listRequestLogs({ limit: 2, offset: 0 });
  const second = await store.listRequestLogs({ limit: 2, offset: 2 });
  assert.equal(first.total, 5, "total 反映过滤后的全部条数，供前端算页数");
  assert.equal(first.logs.length, 2);
  assert.notEqual(first.logs[0].id, second.logs[0].id);

  assert.equal((await store.listRequestLogs({ limit: 50, outcome: "error" })).total, 1);
  assert.equal((await store.listRequestLogs({ limit: 50, outcome: "success" })).total, 4);
  assert.equal((await store.listRequestLogs({ limit: 50, model: "gpt-5.6" })).total, 3);
  assert.equal((await store.listRequestLogs({ limit: 50, gatewayKeyId: "gw-1" })).total, 5);
  assert.equal((await store.listRequestLogs({ limit: 50, gatewayKeyId: "missing" })).total, 0);
});

test("usage can be backfilled after the request finished and rolls into stats", async () => {
  const store = new SqliteStateStore(tempDbPath());
  await store.insertRequestLog(log({ id: "pending" }));
  assert.equal((await store.listRequestLogs({ limit: 5 })).logs[0].usage, undefined);

  const ok = await store.updateRequestLogUsage(
    "pending",
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 },
    { rawCostCents: 9, chargedCents: 4.5 },
    "sdk"
  );
  assert.equal(ok, true);
  assert.equal(await store.updateRequestLogUsage("nope", undefined, undefined, "sdk"), false);

  const [backfilled] = (await store.listRequestLogs({ limit: 5 })).logs;
  assert.equal(backfilled.usage?.totalTokens, 3);
  assert.equal(backfilled.cost?.chargedCents, 4.5);

  await store.insertRequestLog(log({
    id: "estimated",
    usage: { inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17, totalTokens: 48 },
    usageSource: "estimated"
  }));
  const stats = await store.requestLogStats();
  assert.equal(stats.tokens.input, 1);
  assert.equal(stats.tokens.total, 3);
  assert.deepEqual(stats.estimatedTokens, {
    input: 7,
    output: 11,
    cacheRead: 13,
    cacheWrite: 17,
    total: 48
  });
  assert.equal(stats.cost.rawCostCents, 9);
  assert.equal(stats.total, 2);

  assert.equal(await store.clearRequestLogs(), 2);
  assert.equal((await store.listRequestLogs({ limit: 5 })).total, 0);
});

test("loadConfig defaults to durable with the session-resume kill switch off", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.cursorSdkDisableSessionResume, false);
  assert.equal(defaults.cursorSdkSessionMode, "durable");
  assert.equal(shouldUseDurableHub(defaults), true);
});

test("request history keeps everything by default and only trims once REQUEST_LOG_KEEP sets a cap", async () => {
  // 默认全量保留：没设、设 0、设负数、设成非数字都落到「不裁剪」。
  assert.equal(loadConfig({}).requestLogKeep, 0);
  assert.equal(loadConfig({ REQUEST_LOG_KEEP: "0" }).requestLogKeep, 0, "0 必须能表达「无上限」——integerValue 那套 > 0 的解析器做不到");
  assert.equal(loadConfig({ REQUEST_LOG_KEEP: "-5" }).requestLogKeep, 0);
  assert.equal(loadConfig({ REQUEST_LOG_KEEP: "nonsense" }).requestLogKeep, 0);
  assert.equal(loadConfig({ REQUEST_LOG_KEEP: "500oops" }).requestLogKeep, 0);
  assert.equal(loadConfig({ REQUEST_LOG_KEEP: "500" }).requestLogKeep, 500);

  const path = tempDbPath();
  const unlimited = new SqliteStateStore(path, { requestLogKeep: loadConfig({}).requestLogKeep });
  // 必须越过一个裁剪周期（每 100 条才跑一次），否则「没被裁」可能只是裁剪压根没触发。
  for (let i = 0; i < 120; i += 1) await unlimited.insertRequestLog(log({ id: `keep-${i}` }));
  assert.equal((await unlimited.listRequestLogs({ limit: 1 })).total, 120);

  // 同一个库改成有上限：构造时先兜底裁一次积压，之后每满 100 条再裁一次。
  const capped = new SqliteStateStore(path, { requestLogKeep: 5 });
  assert.equal((await capped.listRequestLogs({ limit: 1 })).total, 5);
  for (let i = 0; i < 100; i += 1) await capped.insertRequestLog(log({ id: `cap-${i}` }));
  assert.equal((await capped.listRequestLogs({ limit: 1 })).total, 5);
});

test("setRequestLogKeep trims immediately when the admin changes the cap", async () => {
  const path = tempDbPath();
  const store = new SqliteStateStore(path, { requestLogKeep: 0 });
  for (let i = 0; i < 20; i += 1) await store.insertRequestLog(log({ id: `live-keep-${i}` }));
  assert.equal((await store.listRequestLogs({ limit: 1 })).total, 20);
  store.setRequestLogKeep(7);
  assert.equal((await store.listRequestLogs({ limit: 1 })).total, 7);
});

test("integer settings reject numeric prefixes instead of accepting parseInt leftovers", () => {
  const defaults = loadConfig({});
  assert.equal(loadConfig({ PORT: "500oops" }).port, defaults.port);
  assert.equal(loadConfig({ REQUEST_TIMEOUT_MS: "123oops" }).requestTimeoutMs, defaults.requestTimeoutMs);
  assert.equal(loadConfig({ MAX_KEY_ATTEMPTS: "5.5" }).maxKeyAttempts, defaults.maxKeyAttempts);
  assert.equal(loadConfig({ MAX_TRANSIENT_KEY_ATTEMPTS: "0x10" }).maxTransientAttempts, defaults.maxTransientAttempts);
  assert.equal(loadConfig({ AUTO_DISABLE_THRESHOLD: "8abc" }).autoDisableThreshold, defaults.autoDisableThreshold);
  assert.equal(loadConfig({ SESSION_AFFINITY_TTL_MS: "900oops" }).sessionAffinityTtlMs, defaults.sessionAffinityTtlMs);
  assert.equal(loadConfig({ PORT: " 500 " }).port, 500, "surrounding whitespace remains harmless");
});

test("agent cost baselines book only the increment and survive a restart", async () => {
  const path = tempDbPath();
  const store = new SqliteStateStore(path);
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-1", { rawCostCents: 10, chargedCents: 4 }),
    { rawCostCents: 10, chargedCents: 4 }
  );
  // 第二个请求复用同一个 agent：累计值里已经含上一次的钱，只能记新增那部分。
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-1", { rawCostCents: 25, chargedCents: 9 }),
    { rawCostCents: 15, chargedCents: 5 }
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-2", { rawCostCents: 7, chargedCents: 0 }),
    { rawCostCents: 7, chargedCents: 0 },
    "每个 agent 各记各的"
  );

  // 基线落库的全部意义就在这里：sdk_sessions 与 SDK 自带的 agent store 都活过重启，
  // 同一个 agentId 重启后会继续服务请求，纯内存基线必然丢、必然重复计费。
  const restarted = new SqliteStateStore(path);
  assert.deepEqual(
    await restarted.bookAgentUsageDelta("agent-1", { rawCostCents: 30, chargedCents: 11 }),
    { rawCostCents: 5, chargedCents: 2 }
  );

  // 累计值倒退只可能是读到旧副本或 agent 被重置：记 0 而不是负数，基线原地不动，
  // 下一次读到正确的累计值时少记的部分会一起补回来。
  assert.deepEqual(
    await restarted.bookAgentUsageDelta("agent-1", { rawCostCents: 1, chargedCents: 1 }),
    { rawCostCents: 0, chargedCents: 0 }
  );
  assert.deepEqual(
    await restarted.bookAgentUsageDelta("agent-1", { rawCostCents: 32, chargedCents: 12 }),
    { rawCostCents: 2, chargedCents: 1 }
  );
});

test("agent cost baselines never lower the high-water mark on ambiguous regressions", async () => {
  const store = new SqliteStateStore(tempDbPath());
  assert.deepEqual(
    await store.bookAgentUsageDelta("reset-agent", { rawCostCents: 100, chargedCents: 40 }),
    { rawCostCents: 100, chargedCents: 40 }
  );
  // 1 → 2 既可能是旧副本按时间到达，也可能是 agent 换代；累计接口没有可靠信号可区分。
  assert.deepEqual(
    await store.bookAgentUsageDelta("reset-agent", { rawCostCents: 1, chargedCents: 1 }),
    { rawCostCents: 0, chargedCents: 0 }
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("reset-agent", { rawCostCents: 2, chargedCents: 2 }),
    { rawCostCents: 0, chargedCents: 0 },
    "严格递增的低读数也不能证明 reset，否则旧副本会让同一笔钱再次入账"
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("reset-agent", { rawCostCents: 100, chargedCents: 40 }),
    { rawCostCents: 0, chargedCents: 0 },
    "回到旧高水位时不能把 98 当成新请求金额"
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("reset-agent", { rawCostCents: 105, chargedCents: 43 }),
    { rawCostCents: 5, chargedCents: 3 }
  );
});

test("startup cleanup does not remove a baseline for a persisted quiet agent", async () => {
  const path = tempDbPath();
  const store = new SqliteStateStore(path);
  await store.bookAgentUsageDelta("active-agent", { rawCostCents: 100, chargedCents: 40 });
  await store.saveSession("session-active", "active-agent");
  const db = new DatabaseSync(path);
  // 模拟持续存活但一个月没有请求的 agent；两张表都跨重启保存，不能只按时间删掉金额基线。
  db.prepare("UPDATE agent_usage_baselines SET updated_at = ? WHERE agent_id = ?").run("2000-01-01T00:00:00.000Z", "active-agent");
  db.prepare("UPDATE sdk_sessions SET updated_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "session-active");
  db.close();

  const restarted = new SqliteStateStore(path);
  assert.deepEqual(
    await restarted.bookAgentUsageDelta("active-agent", { rawCostCents: 120, chargedCents: 50 }),
    { rawCostCents: 20, chargedCents: 10 },
    "a persisted quiet agent must retain its high-water baseline across restart"
  );
});

test("memory combined booking rolls back its baseline when log assignment fails", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(log({ id: "rollback" }));
  const stored = store.requestLogs[0]!;
  Object.defineProperty(stored, "cost", {
    configurable: true,
    get: () => undefined,
    set: () => {
      throw new Error("simulated request log failure");
    }
  });

  await assert.rejects(
    store.bookAgentUsageDeltaForRequest("rollback", "rollback-agent", { rawCostCents: 10, chargedCents: 4 }),
    /simulated request log failure/
  );
  Object.defineProperty(stored, "cost", { configurable: true, enumerable: true, writable: true, value: undefined });
  assert.deepEqual(
    await store.bookAgentUsageDeltaForRequest("rollback", "rollback-agent", { rawCostCents: 10, chargedCents: 4 }),
    { rawCostCents: 10, chargedCents: 4 },
    "a failed log write must not consume the cumulative amount"
  );
});

test("memory store matches the sqlite store behaviour", async () => {
  const store = new MemoryStateStore();
  await store.insertCursorKey(key());
  await store.insertGatewayKey(gatewayKey({ allowedCursorKeyIds: ["k1"] }));
  await store.saveSessionBinding("hash", "k1");

  assert.equal((await store.getSessionBinding("hash", 60_000))?.keyId, "k1");
  assert.equal(await store.getSessionBinding("hash", 0), undefined);

  await store.saveSessionBinding("hash", "k1");
  await store.deleteCursorKey("k1");
  assert.equal(await store.getSessionBinding("hash", 60_000), undefined);
  // 两个 store 的绑定语义必须逐字一致，否则用内存 store 的测试根本测不到真实行为。
  assert.deepEqual((await store.listGatewayKeys())[0].allowedCursorKeyIds, [NO_KEY_SENTINEL]);

  await store.insertRequestLog(log({
    usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 },
    usageSource: "sdk"
  }));
  const stats = await store.requestLogStats();
  assert.equal(stats.tokens.input, 4);
  assert.equal(stats.tokens.total, 5);
  assert.equal((await store.listRequestLogs({ limit: 1 })).total, 1);

  // 金额基线的语义也必须逐字一致，否则用内存 store 写的补写用例测不到真实的「只记增量」。
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-1", { rawCostCents: 10, chargedCents: 4 }),
    { rawCostCents: 10, chargedCents: 4 }
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-1", { rawCostCents: 25, chargedCents: 9 }),
    { rawCostCents: 15, chargedCents: 5 }
  );
  assert.deepEqual(
    await store.bookAgentUsageDelta("agent-1", { rawCostCents: 1, chargedCents: 1 }),
    { rawCostCents: 0, chargedCents: 0 }
  );

  // 读出来的记录必须是副本，否则调用方改一下就污染了库里的状态。
  const keys = await store.listCursorKeys();
  await store.insertCursorKey(key({ id: "k2", apiKey: "key_two", sortOrder: 2 }));
  keys.forEach((item) => item.modelScope.allowed.push("mutated"));
  assert.deepEqual((await store.listCursorKeys())[0].modelScope.allowed, []);
});
