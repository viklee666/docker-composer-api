import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKCustomTool } from "@cursor/sdk";
import { CursorSdkRunner, STABLE_DIRECTIVE, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { durableSessionId } from "../src/durable-id.js";
import { ApiError } from "../src/errors.js";
import {
  SessionHub,
  createSessionSlot,
  durableSlotReplaceReason,
  historyChecksum,
  inboundHistoryIncompatible,
  type HubAgent
} from "../src/session-hub.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunRequest, DurableTurn, GatewayTool } from "../src/types.js";

const FP = {
  systemFingerprint: "aa".repeat(32),
  toolsFingerprint: "bb".repeat(32)
};

const readTool: GatewayTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"]
  }
};

test("historyChecksum is stable for issued ids + lastUserText", () => {
  assert.equal(
    historyChecksum(["b", "a"], "hello"),
    historyChecksum(["a", "b"], "hello")
  );
  assert.notEqual(historyChecksum(["a"], "hello"), historyChecksum(["a"], "hello!"));
});

test("durableSlotReplaceReason: fingerprints / model / apiKey / incompatible kind", () => {
  const slot = createSessionSlot({
    agent: dummyAgent(),
    agentId: "agent-1",
    apiKey: "key-a",
    model: "composer-2.5",
    systemFingerprint: "sys-1",
    toolsFingerprint: "tools-1"
  });
  assert.equal(durableSlotReplaceReason(slot, { kind: "incompatible" }), "incompatible");
  assert.equal(durableSlotReplaceReason(slot, { apiKey: "key-b", model: "composer-2.5" }), "apiKey");
  assert.equal(durableSlotReplaceReason(slot, { apiKey: "key-a", model: "composer-2" }), "model");
  assert.equal(durableSlotReplaceReason(slot, {
    apiKey: "key-a",
    model: "composer-2.5",
    systemFingerprint: "sys-2"
  }), "systemFingerprint");
  assert.equal(durableSlotReplaceReason(slot, {
    apiKey: "key-a",
    model: "composer-2.5",
    toolsFingerprint: "tools-2"
  }), "toolsFingerprint");
  assert.equal(durableSlotReplaceReason(slot, {
    kind: "new_user",
    apiKey: "key-a",
    model: "composer-2.5",
    systemFingerprint: "sys-1",
    toolsFingerprint: "tools-1"
  }), undefined);
});

test("inboundHistoryIncompatible: missing issued ids is not a valid result", () => {
  const slot = createSessionSlot({
    agent: dummyAgent(),
    agentId: "agent-1",
    apiKey: "key",
    model: "m",
    issuedToolCallIds: ["call_read_1"],
    state: "awaiting_tools"
  });
  slot.pending.set("call_read_1", {
    name: "Read",
    resolve: () => undefined,
    reject: () => undefined
  });
  assert.equal(inboundHistoryIncompatible(slot, {
    kind: "tool_results",
    toolResults: [{ id: "call_other" }]
  }), true);
  assert.equal(inboundHistoryIncompatible(slot, {
    kind: "tool_results",
    toolResults: [{ id: "call_read_1" }]
  }), false);
  assert.equal(inboundHistoryIncompatible(slot, { kind: "new_user" }), false);
});

test("tool fingerprint change drop+creates a new agent (not 400)", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fp-${created.length + 1}`);
      created.push(agent);
      return agent;
    },
    resume: async () => {
      throw new Error("fingerprint change must not resume the old agent");
    }
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-fp-change";

  const first = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  const second = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: {
      kind: "new_user",
      userText: "hello again",
      systemFingerprint: FP.systemFingerprint,
      toolsFingerprint: "cc".repeat(32)
    }
  }));

  assert.equal(created.length, 2);
  assert.equal(first.agentId, "agent-fp-1");
  assert.equal(second.agentId, "agent-fp-2");
  assert.equal(created[0].disposed, true);
  assert.equal(created[1].disposed, false);
  assert.match(sendText(created[1].sends[0]), new RegExp(STABLE_DIRECTIVE));
  assert.equal(await store.getSession(sessionHash(seed)), "agent-fp-2");
  await hub.dropAll();
});

test("kind=incompatible drop+creates instead of 400", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-inc-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-incompatible-kind";
  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("one") }));
  const recovered = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: { kind: "incompatible", ...FP }
  }));
  assert.equal(created.length, 2);
  assert.equal(recovered.agentId, "agent-inc-2");
  assert.equal(created[0].disposed, true);
  await hub.dropAll();
});

test("busy send drop+creates; next request does not resume the bad id", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const resumedIds: string[] = [];
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      if (createCount === 1) return new OneShotBusyAgent("agent-busy");
      return new TrackingAgent("agent-fresh");
    },
    resume: async (id) => {
      resumedIds.push(id);
      return new TrackingAgent(id);
    }
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-busy";

  const first = await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  assert.equal(first.agentId, "agent-busy");

  const recovered = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("follow up")
  }));
  assert.equal(recovered.agentId, "agent-fresh");
  assert.equal(createCount, 2);
  assert.equal(await store.getSession(sessionHash(seed)), "agent-fresh");

  const hub2 = new SessionHub({ parallelToolSettleMs: 0, store });
  const runner2 = durableRunner(hub2, factory, store);
  const third = await runner2.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("after restart")
  }));
  assert.equal(third.agentId, "agent-fresh");
  assert.deepEqual(resumedIds, ["agent-fresh"]);
  assert.equal(resumedIds.includes("agent-busy"), false);
  await hub.dropAll();
  await hub2.dropAll();
});

test("stale resume drop+creates a fresh agent", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const seed = "seed-stale-resume";
  const id = sessionHash(seed);
  await store.saveSession(id, "agent-stale");
  let createCount = 0;
  let resumeCount = 0;
  const resumeOptions: Record<string, unknown>[] = [];
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return new TrackingAgent("agent-after-stale");
    },
    resume: async (agentId, options) => {
      resumeCount += 1;
      resumeOptions.push(options);
      if (agentId === "agent-stale") throw new Error("stale session: agent not found");
      return new TrackingAgent(agentId);
    }
  };
  const runner = durableRunner(hub, factory, store);
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  assert.equal(resumeCount, 1);
  assert.equal(createCount, 1);
  assert.equal(result.agentId, "agent-after-stale");
  assert.equal(await store.getSession(id), "agent-after-stale");
  await hub.dropAll();
});

test("stale 502 on send drop+creates in the same request", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      if (createCount === 1) return new StaleSecondSendAgent("agent-stale-live");
      return new TrackingAgent("agent-stale-fresh");
    }
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-stale-send";
  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  const recovered = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("next")
  }));
  assert.equal(createCount, 2);
  assert.equal(recovered.agentId, "agent-stale-fresh");
  assert.equal(await store.getSession(sessionHash(seed)), "agent-stale-fresh");
  await hub.dropAll();
});

test("resume after restart passes customTools again; send omits them", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const seed = "seed-resume-tools";
  await store.saveSession(sessionHash(seed), "agent-resume");
  const resumeCalls: Record<string, unknown>[] = [];
  const agent = new TrackingAgent("agent-resume");
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return new TrackingAgent("agent-should-not-create");
    },
    resume: async (id, options) => {
      assert.equal(id, "agent-resume");
      resumeCalls.push(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory, store);
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README")
  }));
  assert.equal(createCount, 0);
  assert.equal(result.agentId, "agent-resume");
  assert.equal(resumeCalls.length, 1);
  const local = asRecord(resumeCalls[0]?.local);
  assert.ok(local?.customTools, "resume must pass customTools (inline tools are not persisted)");
  assert.ok(asRecord(local.customTools)?.Read);
  assert.deepEqual(local.settingSources, []);
  assert.equal("local" in (agent.sendOptions[0] ?? {}), false);
  assert.equal(sendText(agent.sends[0]).includes(STABLE_DIRECTIVE), false);
  await hub.dropAll();
});

test("no live slot + tool_results resumes then path B send (not hung pending)", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const seed = "seed-restart-tools";
  await store.saveSession(sessionHash(seed), "agent-idle");
  const agent = new TrackingAgent("agent-idle");
  const resumeOptions: Record<string, unknown>[] = [];
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return new TrackingAgent("agent-created");
    },
    resume: async (id, options) => {
      resumeOptions.push(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory, store);
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_read_1", content: "hello from README" }]
    }
  }));
  assert.equal(createCount, 0);
  assert.equal(resumeOptions.length, 1);
  assert.ok(asRecord(asRecord(resumeOptions[0].local)?.customTools)?.Read);
  assert.equal(agent.sends.length, 1);
  assert.match(sendText(agent.sends[0]), /TOOL RESULT \(call_read_1\):\nhello from README/);
  assert.equal(hub.get(sessionHash(seed))?.pending.size ?? 0, 0);
  assert.equal(result.text, "reply 1");
  await hub.dropAll();
});

test("no live slot + no agentId + tool_results is 400, not a poisoned create", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return new TrackingAgent("agent-poison");
    },
    resume: async () => {
      throw new Error("resume should not run without a stored agentId");
    }
  };
  const runner = durableRunner(hub, factory, store);
  await assert.rejects(
    () => runner.run(baseRun({
      conversationSeed: "seed-orphan-tools",
      durableTurn: {
        kind: "tool_results",
        ...FP,
        toolResults: [{ id: "call_x", content: "nope" }]
      }
    })),
    (error) => error instanceof ApiError && error.statusCode === 400
  );
  assert.equal(createCount, 0);
  assert.equal(hub.size, 0);
  await hub.dropAll();
});

test("mismatched tool_results while pending drop+creates instead of hanging", async () => {
  const store = new MemoryStateStore();
  const hub = new SessionHub({ parallelToolSettleMs: 0, store });
  const held = new HeldToolAgent();
  const created: AgentLike[] = [];
  const factory: AgentFactory = {
    create: async (options) => {
      if (created.length === 0) {
        held.attachCreateOptions(options);
        created.push(held);
        return held;
      }
      const next = new TrackingAgent("agent-after-rewrite");
      created.push(next);
      return next;
    }
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-history-rewrite";
  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  assert.equal(http1.toolCalls[0]?.id, "call_read_1");
  assert.equal(held.disposed, false);
  assert.equal(hub.get(sessionHash(seed))?.pending.has("call_read_1"), true);

  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    prompt: "USER: rewritten history without the tool call",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_unknown", content: "wrong" }]
    }
  }));

  assert.equal(created.length, 2);
  assert.equal(held.disposed, true);
  assert.equal(http2.agentId, "agent-after-rewrite");
  assert.match(sendText((created[1] as TrackingAgent).sends[0]), /TOOL RESULT \(call_unknown\)/);
  assert.equal(hub.get(sessionHash(seed))?.pending.size ?? 0, 0);
  await hub.dropAll();
});

test("idle TTL deleteSession so the next request creates instead of resuming a disposed agent", async () => {
  let now = 1_000;
  const store = new MemoryStateStore();
  const hub = new SessionHub({
    parallelToolSettleMs: 0,
    idleTtlMs: 100,
    holdTtlMs: 10_000,
    now: () => now,
    store
  });
  let createCount = 0;
  let resumeCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return new TrackingAgent(`agent-ttl-${createCount}`);
    },
    resume: async (id) => {
      resumeCount += 1;
      return new TrackingAgent(id);
    }
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-idle-ttl";
  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  assert.equal(createCount, 1);
  assert.equal(await store.getSession(sessionHash(seed)), "agent-ttl-1");

  now = 1_200;
  const next = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("after idle")
  }));
  assert.equal(resumeCount, 0);
  assert.equal(createCount, 2);
  assert.equal(next.agentId, "agent-ttl-2");
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
    model: "composer-2.5",
    prompt: "USER: hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: [],
    ...overrides
  };
}

function userTurn(userText: string): DurableTurn {
  return { kind: "new_user", userText, ...FP };
}

function sessionHash(seed: string): string {
  const id = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/workspace",
    conversationSeed: seed
  });
  if (!id) throw new Error("expected durable session id");
  return id;
}

function sendText(message: unknown): string {
  if (typeof message === "string") return message;
  const record = asRecord(message);
  if (typeof record?.text === "string") return record.text;
  return String(message);
}

function dummyAgent(): HubAgent {
  return {
    agentId: "dummy",
    send: async () => ({
      stream: async function* () {},
      wait: async () => ({ status: "finished" })
    })
  };
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

  constructor(readonly agentId = "agent-durable-text") {}

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

class OneShotBusyAgent extends TrackingAgent {
  async send(message: unknown, options: Record<string, unknown>): Promise<SimpleFakeRun> {
    if (this.sends.length >= 1) {
      throw new Error("AgentBusyError: Agent is RUNNING");
    }
    return super.send(message, options);
  }
}

class StaleSecondSendAgent extends TrackingAgent {
  async send(message: unknown, options: Record<string, unknown>): Promise<SimpleFakeRun> {
    if (this.sends.length >= 1) {
      throw new ApiError("Cursor upstream run ended in error", 502, "upstream_run_failed");
    }
    return super.send(message, options);
  }
}

class HeldFakeRun {
  readonly id = "run-held";
  cancelled = false;
  private readonly finished: Promise<unknown>;
  private resolveFinished!: (value: unknown) => void;
  private events: (() => AsyncIterable<unknown>) | undefined;

  constructor() {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  attach(streamEvents: () => AsyncIterable<unknown>): void {
    this.events = streamEvents;
  }

  async *stream(): AsyncIterable<unknown> {
    try {
      if (this.events) yield* this.events();
      if (!this.cancelled) this.resolveFinished({ status: "finished", result: "done" });
    } catch (error) {
      this.resolveFinished({
        status: this.cancelled ? "cancelled" : "error",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  wait(): Promise<unknown> {
    return this.finished;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.resolveFinished({ status: "cancelled" });
  }
}

class HeldToolAgent implements AgentLike {
  readonly agentId = "agent-held";
  disposed = false;
  readonly sends: unknown[] = [];
  readonly runs: HeldFakeRun[] = [];
  tools: Record<string, SDKCustomTool> | undefined;

  attachCreateOptions(options: Record<string, unknown>): void {
    const local = asRecord(options.local);
    this.tools = local?.customTools as Record<string, SDKCustomTool> | undefined;
  }

  async send(message: unknown): Promise<HeldFakeRun> {
    this.sends.push(message);
    const tools = this.tools;
    if (!tools?.Read) throw new Error("HeldToolAgent expected customTools.Read on create");
    const run = new HeldFakeRun();
    this.runs.push(run);
    run.attach(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Calling Read." }] }
      };
      const pending = tools.Read.execute({ file_path: "README.md" }, { toolCallId: "call_read_1" }) as Promise<unknown>;
      yield {
        type: "tool_call",
        toolCall: { id: "call_read_1", name: "Read", arguments: { file_path: "README.md" } }
      };
      const result = await pending;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: `README:\n${toolResultText(result)}` }] }
      };
    });
    return run;
  }

  close(): void {
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

function toolResultText(result: unknown): string {
  const record = asRecord(result);
  const content = record?.content;
  if (!Array.isArray(content)) return String(result);
  return content.map((block) => {
    const item = asRecord(block);
    return typeof item?.text === "string" ? item.text : "";
  }).join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
