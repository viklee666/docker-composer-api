import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteAgentStore } from "../src/agent-store.js";
import { MemoryStateStore, SqliteStateStore } from "../src/store.js";
import type { RequestLogRecord } from "../src/types.js";

const BLOB_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "composer-agents-"));
}

function agentStorePath(dir = tempDir()): string {
  return join(dir, "agents.sqlite");
}

function agent(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    cwd: "/w",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((name) => String(name).replaceAll("\\", "/"));
}

test("sqlite agent store persists sdkMetadata.blobEncryptionKey and checkpoint bytes across close/reopen", async () => {
  const path = agentStorePath();
  const blob = new Uint8Array([0, 1, 255, 0]);
  const store = createSqliteAgentStore(path);
  await store.agents.create({
    agent: agent("a1", { sdkMetadata: { blobEncryptionKey: BLOB_ENCRYPTION_KEY } })
  });
  await store.checkpoints.create({ agentId: "a1", blobId: "b1", data: blob });
  store.close();

  const reopened = createSqliteAgentStore(path);
  const restored = await reopened.agents.get({ agentId: "a1" }) as { sdkMetadata?: { blobEncryptionKey?: string } } | null;
  assert.equal(restored?.sdkMetadata?.blobEncryptionKey, BLOB_ENCRYPTION_KEY);
  assert.equal(restored?.sdkMetadata?.blobEncryptionKey?.length, 64);
  const restoredBlob = await reopened.checkpoints.get({ agentId: "a1", blobId: "b1" });
  assert.ok(restoredBlob);
  assert.deepEqual([...restoredBlob], [0, 1, 255, 0]);
  reopened.close();
});

test("maxAgents=2 drops the oldest agent including its blobs", async () => {
  const store = createSqliteAgentStore(agentStorePath(), { maxAgents: 2 });
  await store.agents.create({ agent: agent("a1") });
  await store.checkpoints.create({ agentId: "a1", blobId: "blob-a1", data: new Uint8Array([1]) });
  await store.agents.create({ agent: agent("a2") });
  await store.checkpoints.create({ agentId: "a2", blobId: "blob-a2", data: new Uint8Array([2]) });
  await store.agents.create({ agent: agent("a3") });
  await store.checkpoints.create({ agentId: "a3", blobId: "blob-a3", data: new Uint8Array([3]) });

  assert.equal(await store.agents.get({ agentId: "a1" }), null);
  assert.equal(await store.checkpoints.get({ agentId: "a1", blobId: "blob-a1" }), null);
  assert.equal((await store.agents.get({ agentId: "a2" }))?.agentId, "a2");
  assert.deepEqual([...(await store.checkpoints.get({ agentId: "a2", blobId: "blob-a2" }) ?? [])], [2]);
  assert.equal((await store.agents.get({ agentId: "a3" }))?.agentId, "a3");
  assert.deepEqual([...(await store.checkpoints.get({ agentId: "a3", blobId: "blob-a3" }) ?? [])], [3]);
  store.close();
});

test("idle TTL sweep removes an idle agent on the next insert", async () => {
  const store = createSqliteAgentStore(agentStorePath(), { idleTtlMs: 1, maxAgents: 16 });
  await store.agents.create({ agent: agent("idle") });
  await store.checkpoints.create({ agentId: "idle", blobId: "b", data: new Uint8Array([9]) });
  await delay(50);
  await store.agents.create({ agent: agent("fresh") });

  assert.equal(await store.agents.get({ agentId: "idle" }), null);
  assert.equal(await store.checkpoints.get({ agentId: "idle", blobId: "b" }), null);
  assert.equal((await store.agents.get({ agentId: "fresh" }))?.agentId, "fresh");
  store.close();
});

test("after N agents only one sqlite file exists (no agents/*/store.db)", async () => {
  const dir = tempDir();
  const store = createSqliteAgentStore(join(dir, "agents.sqlite"), { maxAgents: 32 });
  for (let i = 0; i < 8; i += 1) {
    await store.agents.create({ agent: agent(`a${i}`) });
    await store.checkpoints.create({ agentId: `a${i}`, blobId: `b${i}`, data: new Uint8Array([i]) });
  }

  const files = relativeFiles(dir);
  const dbFiles = files.filter((name) => /\.(sqlite|db)$/i.test(name));
  assert.equal(dbFiles.length, 1, `expected one sqlite file, saw ${dbFiles.join(", ")}`);
  assert.equal(dbFiles[0], "agents.sqlite");
  assert.equal(
    files.some((name) => /(?:^|\/)agents\/.+\/store\.db$/i.test(name)),
    false,
    "must not create per-agent store.db files"
  );
  store.close();
});

test("evicted agents.update upserts (parity with ephemeral)", async () => {
  const store = createSqliteAgentStore(agentStorePath(), { maxAgents: 2 });
  await store.agents.create({ agent: agent("a1", { sdkMetadata: { blobEncryptionKey: BLOB_ENCRYPTION_KEY } }) });
  await store.agents.create({ agent: agent("a2") });
  await store.agents.create({ agent: agent("a3") });
  assert.equal(await store.agents.get({ agentId: "a1" }), null);

  const updated = agent("a1", { status: "running", updatedAt: 99, sdkMetadata: { blobEncryptionKey: BLOB_ENCRYPTION_KEY } });
  const returned = await store.agents.update({ agent: updated });
  assert.equal(returned.status, "running");
  const got = await store.agents.get({ agentId: "a1" }) as { status?: string; sdkMetadata?: { blobEncryptionKey?: string } } | null;
  assert.equal(got?.status, "running");
  assert.equal(got?.sdkMetadata?.blobEncryptionKey, BLOB_ENCRYPTION_KEY);
  store.close();
});

test("request_logs.provider round-trips, migrates a missing column, and KEEP=0 keeps rows", async () => {
  const memory = new MemoryStateStore();
  await memory.insertRequestLog(log({ id: "mem", provider: "connect" }));
  assert.equal((await memory.listRequestLogs({ limit: 5 })).logs[0].provider, "connect");

  const sqlite = new SqliteStateStore(join(tempDir(), "state.sqlite"));
  await sqlite.insertRequestLog(log({ id: "sql", provider: "connect" }));
  assert.equal((await sqlite.listRequestLogs({ limit: 5 })).logs[0].provider, "connect");
  await sqlite.insertRequestLog(log({ id: "sql-sdk", provider: "sdk" }));
  assert.equal((await sqlite.listRequestLogs({ limit: 5 })).logs.find((row) => row.id === "sql-sdk")?.provider, "sdk");
  await sqlite.insertRequestLog(log({ id: "sql-none" }));
  assert.equal((await sqlite.listRequestLogs({ limit: 5 })).logs.find((row) => row.id === "sql-none")?.provider, undefined);

  const legacyPath = join(tempDir(), "state.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE request_logs (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT,
      auth_mode TEXT NOT NULL, key_id TEXT, key_label TEXT, status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, stream INTEGER NOT NULL DEFAULT 0, error TEXT
    );
  `);
  legacy.prepare(
    "INSERT INTO request_logs (id, ts, endpoint, auth_mode, status, duration_ms) VALUES (?,?,?,?,?,?)"
  ).run("log-old", new Date().toISOString(), "/v1/chat/completions", "gateway", 200, 1234);
  legacy.close();

  const migrated = new SqliteStateStore(legacyPath);
  assert.equal((await migrated.listRequestLogs({ limit: 5 })).logs[0].provider, undefined, "old rows have no provider");
  await migrated.insertRequestLog(log({ id: "log-new", provider: "connect" }));
  const after = await migrated.listRequestLogs({ limit: 5 });
  assert.equal(after.logs.find((row) => row.id === "log-old")?.provider, undefined);
  assert.equal(after.logs.find((row) => row.id === "log-new")?.provider, "connect");

  const keepPath = join(tempDir(), "state.sqlite");
  const unlimited = new SqliteStateStore(keepPath, { requestLogKeep: 0 });
  for (let i = 0; i < 120; i += 1) await unlimited.insertRequestLog(log({ id: `keep-${i}`, provider: "connect" }));
  assert.equal((await unlimited.listRequestLogs({ limit: 1 })).total, 120, "REQUEST_LOG_KEEP=0 must keep every row");
});
