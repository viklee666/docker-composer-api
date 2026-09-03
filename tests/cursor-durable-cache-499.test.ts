import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorSdkRunner, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { durableSessionId } from "../src/durable-id.js";
import { ApiError } from "../src/errors.js";
import { SessionHub } from "../src/session-hub.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunRequest, CursorStreamEvent, DurableTurn } from "../src/types.js";

const OWNER = "owner-m1";
const MODEL = "composer-2.5";
const FP = {
  systemFingerprint: "aa".repeat(32),
  toolsFingerprint: "bb".repeat(32)
};

test("abort mid-text keeps the idle agent and ends with done (no 499)", { timeout: 5_000 }, async (t) => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  let agent: HangAfterTextAgent | undefined;
  const factory: AgentFactory = {
    create: async (options) => {
      agent = new HangAfterTextAgent(String(options.agentId ?? "missing"));
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-abort-mid-text";
  const sessionId = hubKey({ conversationSeed: seed });

  const abort = new AbortController();
  const events: CursorStreamEvent[] = [];
  await assert.doesNotReject(async () => {
    for await (const event of runner.stream(baseRun({
      conversationSeed: seed,
      durableTurn: userTurn("hello")
    }), abort.signal)) {
      events.push(event);
      if (event.type === "text") abort.abort();
    }
  });

  assert.ok(events.some((event) => event.type === "text"));
  assert.ok(events.some((event) => event.type === "done"), "client abort after text must yield done, not 499");
  assert.ok(agent);
  assert.equal(agent.disposed, false);
  assert.equal(agent.cancelled, true, "keep-alive abort must cancel the Run so the next send is not busy");
  const slot = hub.get(sessionId);
  assert.ok(slot, "mid-text abort must not drop the Hub slot");
  assert.equal(slot.state, "idle");
  assert.equal(slot.agent, agent);
  assert.ok(logs.some((line) => line.includes("[durable] keep-alive abort")), logs.join("\n"));
  await hub.dropAll();
});

test("generator return after text parks keep-alive without aborting the signal", { timeout: 5_000 }, async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  let agent: HangAfterTextAgent | undefined;
  const factory: AgentFactory = {
    create: async (options) => {
      agent = new HangAfterTextAgent(String(options.agentId ?? "missing"));
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-return-mid-text";
  const sessionId = hubKey({ conversationSeed: seed });
  const run = baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  });
  const signal = new AbortController().signal;
  const iter = runner.stream(run, signal)[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "text");
  assert.equal(signal.aborted, false, "return() must not rely on AbortSignal");
  await iter.return?.();
  assert.ok(agent);
  assert.equal(agent.disposed, false);
  assert.equal(agent.cancelled, true, "return() after text must cancel the Run");
  const slot = hub.get(sessionId);
  assert.ok(slot, "return() after text must not drop the Hub slot");
  assert.equal(slot.state, "idle");
  assert.equal(slot.agent, agent);
  await hub.dropAll();
});

test("idle-timeout 504 with partial text still errors (not keep-alive 200)", { timeout: 5_000 }, async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  let agent: HangAfterTextAgent | undefined;
  const factory: AgentFactory = {
    create: async (options) => {
      agent = new HangAfterTextAgent(String(options.agentId ?? "missing"));
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-abort-504";
  const sessionId = hubKey({ conversationSeed: seed });
  const abort = new AbortController();
  const events: CursorStreamEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of runner.stream(baseRun({
      conversationSeed: seed,
      durableTurn: userTurn("hello")
    }), abort.signal)) {
      events.push(event);
      if (event.type === "text") {
        abort.abort(new ApiError("Upstream produced no output for 20ms.", 504, "timeout_error"));
      }
    }
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ApiError && thrown.statusCode === 499, String(thrown));
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.ok(agent);
  assert.equal(agent.disposed, true, "504 idle timeout must still drop the running slot");
  assert.equal(hub.get(sessionId), undefined);
  await hub.dropAll();
});

test("same identity two rounds: create once with durable agentId; live reuse then resume", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const factory = new RecordingFactory();
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-same-identity";
  const sessionId = hubKey({ conversationSeed: seed });

  const first = await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  const second = await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("follow up") }));

  assert.equal(factory.creates.length, 1);
  assert.equal(factory.creates[0]?.agentId, sessionId);
  assert.equal(first.agentId, sessionId);
  assert.equal(second.agentId, sessionId);
  assert.equal(hub.get(sessionId)?.agentId, sessionId);
  assert.equal(hub.get(sessionId)?.agent, factory.creates[0]?.agent);

  await hub.dropAll();
  const hub2 = new SessionHub({ parallelToolSettleMs: 0, store });
  const runner2 = durableRunner(hub2, factory, store);
  const third = await runner2.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("after drop") }));
  assert.equal(factory.creates.length, 1, "drop must resume the deterministic id, not create again");
  assert.ok(factory.resumes.includes(sessionId));
  assert.equal(third.agentId, sessionId);
  await hub2.dropAll();
});

test("apiKey rotation reuses the same agentId without an extra create", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory = new RecordingFactory();
  const runner = durableRunner(hub, factory);
  const seed = "seed-apikey-rotate";
  const sessionId = hubKey({ conversationSeed: seed });

  const first = await runner.run(baseRun({
    apiKey: "key-a",
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  const second = await runner.run(baseRun({
    apiKey: "key-b",
    conversationSeed: seed,
    durableTurn: userTurn("still me")
  }));

  assert.equal(factory.creates.length, 1);
  assert.equal(factory.creates[0]?.agentId, sessionId);
  assert.equal(first.agentId, sessionId);
  assert.equal(second.agentId, sessionId);
  assert.equal(hub.get(sessionId)?.apiKey, "key-b");
  await hub.dropAll();
});

test("conversationSeed with agent-id suffix is a different Hub slot", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory = new RecordingFactory();
  const runner = durableRunner(hub, factory);
  const childSeed = "sess\0agent:child-a";
  const parentSeed = "sess";
  const childId = hubKey({ conversationSeed: childSeed });
  const parentId = hubKey({ conversationSeed: parentSeed });
  assert.notEqual(childId, parentId);

  await runner.run(baseRun({ conversationSeed: childSeed, durableTurn: userTurn("child") }));
  await runner.run(baseRun({ conversationSeed: parentSeed, durableTurn: userTurn("parent") }));

  assert.equal(factory.creates.length, 2);
  assert.deepEqual(factory.creates.map((item) => item.agentId).sort(), [childId, parentId].sort());
  assert.ok(hub.get(childId));
  assert.ok(hub.get(parentId));
  assert.notEqual(hub.get(childId)?.agent, hub.get(parentId)?.agent);
  await hub.dropAll();
});

test("different ownerHash with the same conversationSeed uses different slots", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory = new RecordingFactory();
  const runner = durableRunner(hub, factory);
  const seed = "shared-seed";
  const idA = hubKey({ conversationSeed: seed, ownerHash: "owner-a" });
  const idB = hubKey({ conversationSeed: seed, ownerHash: "owner-b" });
  assert.notEqual(idA, idB);

  await runner.run(baseRun({
    ownerHash: "owner-a",
    conversationSeed: seed,
    durableTurn: userTurn("hello a")
  }));
  await runner.run(baseRun({
    ownerHash: "owner-b",
    conversationSeed: seed,
    durableTurn: userTurn("hello b")
  }));

  assert.equal(factory.creates.length, 2);
  assert.ok(hub.get(idA));
  assert.ok(hub.get(idB));
  assert.equal(hub.get(idA)?.agentId, idA);
  assert.equal(hub.get(idB)?.agentId, idB);
  await hub.dropAll();
});

test("create already-exists / UnknownAgentError falls back to resume", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const sessionIdExpected = hubKey({ conversationSeed: "seed-already-exists" });
  let createCalls = 0;
  let resumeCalls = 0;
  let resumed: TrackingAgent | undefined;
  const factory: AgentFactory = {
    create: async (options) => {
      createCalls += 1;
      const error = new Error(`Agent ${String(options.agentId)} already exists`);
      error.name = "UnknownAgentError";
      throw error;
    },
    resume: async (id) => {
      resumeCalls += 1;
      if (createCalls === 0) throw new Error("agent not in store yet");
      resumed = new TrackingAgent(id);
      return resumed;
    }
  };
  const runner = durableRunner(hub, factory);
  const result = await runner.run(baseRun({
    conversationSeed: "seed-already-exists",
    durableTurn: userTurn("hello")
  }));
  assert.equal(createCalls, 1);
  assert.ok(resumeCalls >= 1);
  assert.equal(result.agentId, sessionIdExpected);
  assert.equal(hub.get(sessionIdExpected)?.agent, resumed);
  await hub.dropAll();
});

function durableRunner(hub: SessionHub, factory: AgentFactory, store = new MemoryStateStore()): CursorSdkRunner {
  return new CursorSdkRunner(store, {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    disableSessionResume: false,
    sessionHub: hub
  }, factory);
}

function baseRun(overrides: Partial<CursorRunRequest> = {}): CursorRunRequest {
  return {
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: MODEL,
    prompt: "USER: hello",
    sessionKey: "session",
    ownerHash: OWNER,
    workingDirectory: "/workspace",
    images: [],
    tools: [],
    ...overrides
  };
}

function userTurn(userText: string): DurableTurn {
  return { kind: "new_user", userText, ...FP };
}

function hubKey(input: { conversationSeed: string; ownerHash?: string; model?: string }): string {
  const id = durableSessionId({
    conversationSeed: input.conversationSeed,
    ownerHash: input.ownerHash ?? OWNER,
    model: input.model ?? MODEL,
    apiKey: "cursor-key",
    workingDirectory: "/workspace"
  });
  if (!id) throw new Error("expected durable session id");
  return id;
}

class SimpleFakeRun {
  cancelled = false;

  constructor(readonly id: string, private readonly input: {
    streamEvents?: () => AsyncIterable<unknown>;
    waitResult?: unknown;
  } = {}) {}

  async *stream(): AsyncIterable<unknown> {
    if (this.input.streamEvents) yield* this.input.streamEvents();
  }

  async wait(): Promise<unknown> {
    return this.input.waitResult ?? { status: "finished", result: "" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class TrackingAgent implements AgentLike {
  disposed = false;
  readonly sends: unknown[] = [];
  readonly sendOptions: Record<string, unknown>[] = [];
  readonly runs: SimpleFakeRun[] = [];

  constructor(readonly agentId: string) {}

  async send(message: unknown, options: Record<string, unknown>): Promise<SimpleFakeRun> {
    this.sends.push(message);
    this.sendOptions.push(options);
    const run = new SimpleFakeRun(`run-${this.sends.length}`, {
      waitResult: { status: "finished", result: `reply ${this.sends.length}` }
    });
    this.runs.push(run);
    return run;
  }

  close(): void {
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

class RecordingFactory implements AgentFactory {
  readonly creates: Array<{ agentId?: unknown; agent: TrackingAgent }> = [];
  readonly resumes: string[] = [];
  private readonly known = new Set<string>();

  create = async (options: Record<string, unknown>): Promise<AgentLike> => {
    const agentId = String(options.agentId ?? "");
    const agent = new TrackingAgent(agentId);
    this.known.add(agentId);
    this.creates.push({ agentId: options.agentId, agent });
    return agent;
  };

  resume = async (id: string): Promise<AgentLike> => {
    this.resumes.push(id);
    if (!this.known.has(id)) throw new Error(`agent not in store: ${id}`);
    return new TrackingAgent(id);
  };
}

class HangAfterTextAgent implements AgentLike {
  disposed = false;
  cancelled = false;

  constructor(readonly agentId: string) {}

  async send(): Promise<{
    id: string;
    stream: () => AsyncIterable<unknown>;
    wait: () => Promise<unknown>;
    cancel: () => Promise<void>;
  }> {
    const self = this;
    return {
      id: "run-hang-text",
      async *stream() {
        yield { type: "text-delta", text: "partial-output" };
        await new Promise(() => undefined);
      },
      wait() {
        return new Promise(() => undefined);
      },
      async cancel() {
        self.cancelled = true;
      }
    };
  }

  close(): void {
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}
