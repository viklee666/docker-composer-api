import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { sessionBindingHash } from "../src/routing.js";
import { MemoryStateStore } from "../src/store.js";
import type {
  CursorKeyRecord,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  DurableTurn
} from "../src/types.js";

const FP = {
  systemFingerprint: "aa".repeat(32),
  toolsFingerprint: "bb".repeat(32)
};

const durableTurn: DurableTurn = {
  kind: "new_user",
  userText: "hello",
  ...FP
};

test("durable pinned key 401 does not rotate to the next pool key", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  const stickyKey = "owner:durable-pin-401";
  await pool.bindSession(sessionBindingHash(stickyKey), "a");

  const attempted: string[] = [];
  const rotating = new KeyRotatingRunner(trackingRunner(attempted, {
    key_a: () => {
      throw Object.assign(new Error("Invalid API key provided"), { status: 401 });
    }
  }), pool);

  await assert.rejects(
    () => collect(rotating.stream(runInput({ useKeyPool: true, stickyKey, durableTurn }))),
    (error: unknown) => error instanceof ApiError
      && error.statusCode === 502
      && error.code === "upstream_run_failed"
      && error.message.includes("Pinned Cursor API key")
  );
  assert.deepEqual(attempted, ["key_a"], "key 2 must stay unused so a held execute is not dropped");
});

test("durable first turn without a binding still rotates after 401", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  const stickyKey = "owner:durable-first-rotate";
  const attempted: string[] = [];
  const rotating = new KeyRotatingRunner(trackingRunner(attempted, {
    key_a: () => {
      throw Object.assign(new Error("Invalid API key provided"), { status: 401 });
    }
  }), pool);

  const events = await collect(rotating.stream(runInput({ useKeyPool: true, stickyKey, durableTurn })));
  assert.deepEqual(attempted, ["key_a", "key_b"]);
  assert.equal(doneText(events), "ok");
  assert.equal((await pool.getSessionBinding(sessionBindingHash(stickyKey)))?.keyId, "b");
});

test("non-durable requests still rotate off a sticky binding after 401", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  const stickyKey = "owner:stateless-still-rotates";
  await pool.bindSession(sessionBindingHash(stickyKey), "a");

  const attempted: string[] = [];
  const rotating = new KeyRotatingRunner(trackingRunner(attempted, {
    key_a: () => {
      throw Object.assign(new Error("Invalid API key provided"), { status: 401 });
    }
  }), pool);

  const events = await collect(rotating.stream(runInput({ useKeyPool: true, stickyKey })));
  assert.deepEqual(attempted, ["key_a", "key_b"], "routing fallthrough when NOT durableTurn stays unchanged");
  assert.equal(doneText(events), "ok");
});

test("durable two successful turns stay on the pinned key", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  const stickyKey = "owner:durable-same-key";
  const attempted: string[] = [];
  const rotating = new KeyRotatingRunner(trackingRunner(attempted), pool);

  await collect(rotating.stream(runInput({ useKeyPool: true, stickyKey, durableTurn })));
  await collect(rotating.stream(runInput({ useKeyPool: true, stickyKey, durableTurn })));

  assert.deepEqual(attempted, ["key_a", "key_a"]);
  assert.equal((await pool.getSessionBinding(sessionBindingHash(stickyKey)))?.keyId, "a");
});

function twoKeys(): CursorKeyRecord[] {
  return [makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })];
}

async function poolWith(
  keys: CursorKeyRecord[],
  routing: { sessionAffinity?: boolean } = {}
): Promise<{ pool: CursorKeyPool; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  for (const key of keys) await store.insertCursorKey(key);
  return { pool: new CursorKeyPool(store, { enabled: false }, routing), store };
}

function makeKey(overrides: Partial<CursorKeyRecord> & { id: string }): CursorKeyRecord {
  return {
    apiKey: `key_${overrides.id}`,
    label: overrides.id,
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

function trackingRunner(
  attempted: string[],
  failByKey: Record<string, () => never> = {}
): CursorRunner {
  return {
    run: async () => ({ text: "ok", toolCalls: [] }),
    stream: async function* (input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
      attempted.push(input.apiKey);
      failByKey[input.apiKey]?.();
      yield { type: "done", result: { text: "ok", toolCalls: [] } };
    }
  };
}

function runInput(overrides: Partial<CursorRunRequest> = {}): CursorRunRequest {
  return {
    protocol: "openai-chat",
    apiKey: "",
    useKeyPool: true,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [],
    stream: true,
    ...overrides
  };
}

async function collect(stream: AsyncIterable<CursorStreamEvent>): Promise<CursorStreamEvent[]> {
  const events: CursorStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function doneText(events: CursorStreamEvent[]): string | undefined {
  const done = events.find((event): event is { type: "done"; result: CursorRunResult } => event.type === "done");
  return done?.result.text;
}
