import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SDKCustomTool } from "@cursor/sdk";
import { durableSessionId } from "../src/durable-id.js";
import {
  PARALLEL_TOOL_SETTLE_MS,
  SessionHub,
  TOOL_HOLD_EXPIRED_LOG,
  createSessionSlot,
  type HubAgent,
  type HubPumpItem,
  type HubRun
} from "../src/session-hub.js";
import { STATELESS_EXECUTE_ACCEPTED_TEXT, createSdkCustomTools } from "../src/tool-compat.js";
import type { GatewayTool } from "../src/types.js";

const HTTP1_BUDGET_MS = 500;

const readTool: GatewayTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"]
  }
};

const grepTool: GatewayTool = {
  name: "Grep",
  description: "Search files",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"]
  }
};

test("PARALLEL_TOOL_SETTLE_MS is 25ms and injectable on the hub", () => {
  assert.equal(PARALLEL_TOOL_SETTLE_MS, 25);
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  assert.equal(hub.parallelToolSettleMs, 0);
});

test("hub configure updates TTL and live-session cap", () => {
  const hub = new SessionHub({ holdTtlMs: 1000, idleTtlMs: 2000, maxLiveSessions: 3 });
  hub.configure({ holdTtlMs: 5000, idleTtlMs: 6000, maxLiveSessions: 8 });
  assert.equal(hub.holdTtlMs, 5000);
  assert.equal(hub.idleTtlMs, 6000);
  assert.equal(hub.maxLiveSessions, 8);
});

test("hub parks HTTP1 on pending execute and resumes the same run after HTTP2 resolve", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const sessionId = "sess-held";
  const { agent, run } = await startHeldSession(hub, sessionId, "single");

  const t0 = Date.now();
  const http1 = await consumeUntilHeld(hub, sessionId);
  const http1Ms = Date.now() - t0;

  assert.ok(http1Ms < HTTP1_BUDGET_MS, `HTTP1 must return while execute is still pending, took ${http1Ms}ms`);
  assert.equal(hub.get(sessionId)?.state, "awaiting_tools");
  assert.equal(http1.runId, "run-held");
  assert.equal(http1.agentId, "agent-held-execute");
  assert.deepEqual(http1.toolCalls.map((call) => call.name), ["Read"]);
  assert.equal(http1.texts.join(""), "Calling Read.");
  assert.equal(http1.texts.join("").includes("hello from README"), false);
  assert.equal(run.cancelled, false);
  assert.equal(agent.disposed, false);
  assert.equal(hub.get(sessionId)?.pending.has("call_read_1"), true);

  await delay(30);
  assert.equal(hub.get(sessionId)?.pending.has("call_read_1"), true, "pending execute must survive after HTTP1 ended");
  assert.equal(hub.get(sessionId)?.state, "awaiting_tools");

  const http2 = await consumeAfterResolve(hub, sessionId, "call_read_1", "hello from README");
  assert.equal(http2.runId, http1.runId);
  assert.equal(hub.get(sessionId)?.state, "idle");
  assert.ok(http2.texts.join("").includes("hello from README"), http2.texts.join(""));
  assert.equal(run.cancelled, false);
  assert.equal(agent.disposed, false);
  assert.equal(hub.get(sessionId)?.pending.has("call_read_1"), false);
  assert.equal(asRecord(http2.waitResult)?.status, "finished");
  await hub.dropAll();
});

test("hold:true execute returns a pending Promise and never the fake-success copy", async () => {
  const hub = new SessionHub();
  const sessionId = "sess-hold-switch";
  const agent = new FakeAgent("single");
  hub.put(sessionId, createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "key",
    model: "composer-2.5"
  }));

  let held = false;
  const tools = createSdkCustomTools([readTool], () => {}, {
    hold: true,
    onHold: (id, resolve, reject) => {
      held = true;
      hub.registerHold(sessionId, id, "Read", resolve, reject);
    }
  });
  assert.ok(tools);
  const result = tools.Read.execute({ file_path: "README.md" }, { toolCallId: "call_hold" });
  assert.equal(typeof (result as { then?: unknown }).then, "function");
  assert.equal(held, true);
  assert.notEqual(result, {
    content: [{ type: "text", text: STATELESS_EXECUTE_ACCEPTED_TEXT }]
  });
  const text = JSON.stringify(result);
  assert.equal(text.includes(STATELESS_EXECUTE_ACCEPTED_TEXT), false);

  const ok = hub.resolvePending(sessionId, "call_hold", { content: [{ type: "text", text: "ok" }] });
  assert.equal(ok, true);
  const settled = await result;
  assert.deepEqual(settled, { content: [{ type: "text", text: "ok" }] });
  await hub.dropAll();
});

test("resolvePending accepts Responses call_ prefix of the hung execute id", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const sessionId = "sess-alias";
  hub.put(sessionId, createSessionSlot({
    agent: { agentId: "a", send: async () => { throw new Error("unused"); } },
    agentId: "a",
    apiKey: "key",
    model: "composer-2.5"
  }));
  let resolved: unknown;
  hub.registerHold(sessionId, "toolu_01abc", "lookup", (value) => {
    resolved = value;
  }, () => undefined);
  assert.equal(hub.resolvePending(sessionId, "call_toolu_01abc", { content: [{ type: "text", text: "pong" }] }), true);
  assert.deepEqual(resolved, { content: [{ type: "text", text: "pong" }] });
  assert.equal(hub.get(sessionId)?.pending.size, 0);
  await hub.dropAll();
});

test("parallel tools after first execute are collected across the settle window", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const sessionId = "sess-parallel";
  await startHeldSession(hub, sessionId, "parallel-microtask");
  const http1 = await consumeUntilHeld(hub, sessionId);
  const names = http1.toolCalls.map((call) => call.name).sort();
  assert.deepEqual(names, ["Grep", "Read"]);
  const slot = hub.get(sessionId);
  assert.ok(slot);
  assert.equal(slot.pending.size, 2);
  assert.equal(slot.pending.has("call_read_1"), true);
  assert.equal(slot.pending.has("call_grep_1"), true);
  assert.equal(slot.state, "awaiting_tools");
  await hub.dropAll();
});

test("acquire serializes the same session; release lets the waiter proceed", async () => {
  const hub = new SessionHub();
  const order: number[] = [];
  const release1 = await hub.acquire("sess-lock");
  let secondAcquired = false;
  const second = hub.acquire("sess-lock").then((release2) => {
    secondAcquired = true;
    order.push(2);
    release2();
  });
  await delay(20);
  assert.equal(secondAcquired, false);
  order.push(1);
  hub.release(release1);
  await second;
  assert.deepEqual(order, [1, 2]);
});

test("tryAcquire on an idle session returns a release function", async () => {
  const hub = new SessionHub();
  const release = await hub.tryAcquire("sess-try-idle");
  assert.equal(typeof release, "function");
  assert.ok(release);
  release();
});

test("tryAcquire is undefined while locked and does not enqueue", async () => {
  const hub = new SessionHub();
  const release1 = await hub.acquire("sess-try-busy");
  assert.equal(await hub.tryAcquire("sess-try-busy"), undefined);
  await delay(20);
  assert.equal(await hub.tryAcquire("sess-try-busy"), undefined);

  let waiterGotLock = false;
  const waiter = hub.acquire("sess-try-busy").then((release2) => {
    waiterGotLock = true;
    release2();
  });
  await delay(20);
  assert.equal(waiterGotLock, false);

  hub.release(release1);
  await waiter;
  assert.equal(waiterGotLock, true);

  const release3 = await hub.tryAcquire("sess-try-busy");
  assert.equal(typeof release3, "function");
  assert.ok(release3);
  release3();
});

test("acquire abort while waiting does not drop an awaiting_tools slot", async () => {
  const hub = new SessionHub();
  const sessionId = "sess-abort-lock";
  const agent = new FakeAgent("single");
  hub.put(sessionId, createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "key",
    model: "m",
    state: "awaiting_tools"
  }));
  hub.beginAwaitingTools(sessionId);
  const release1 = await hub.acquire(sessionId);
  const controller = new AbortController();
  const waiting = hub.acquire(sessionId, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(hub.get(sessionId)?.state, "awaiting_tools");
  assert.equal(agent.disposed, false);
  release1();
  await hub.dropAll();
});

test("drop times out a hung dispose so the next acquire is not blocked", async () => {
  const hub = new SessionHub({ recycleCleanupMs: 40 });
  const agent: HubAgent = {
    agentId: "hang-dispose",
    send: async () => {
      throw new Error("unused");
    },
    [Symbol.asyncDispose]: () => new Promise(() => undefined)
  };
  hub.put("sess-hang", createSessionSlot({
    agent,
    agentId: "hang-dispose",
    apiKey: "key",
    model: "m",
    state: "idle"
  }));
  const started = Date.now();
  await hub.drop("sess-hang");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `hung dispose must not block drop, took ${elapsed}ms`);
  const release = await hub.acquire("sess-hang");
  release();
});

test("idle TTL recycles with cancel + dispose + store.deleteSession", async () => {
  let now = 1_000;
  const deleted: string[] = [];
  const hub = new SessionHub({
    idleTtlMs: 100,
    holdTtlMs: 10_000,
    now: () => now,
    store: {
      deleteSession: async (id) => {
        deleted.push(id);
        return true;
      }
    }
  });
  const agent = new FakeAgent("single");
  const run = new FakeSdkRun();
  hub.put("sess-idle", createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "key",
    model: "m",
    run,
    state: "idle"
  }));
  now = 1_200;
  assert.equal(hub.get("sess-idle"), undefined);
  await hub.sweep();
  assert.equal(agent.disposed, true);
  assert.equal(run.cancelled, true);
  assert.deepEqual(deleted, ["sess-idle"]);
  assert.equal(hub.size, 0);
});

test("idle TTL does not recycle awaiting_tools before hold deadline", async () => {
  let now = 1_000;
  const hub = new SessionHub({
    idleTtlMs: 50,
    holdTtlMs: 5_000,
    now: () => now
  });
  const agent = new FakeAgent("single");
  hub.put("sess-hold-live", createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "key",
    model: "m"
  }));
  hub.beginAwaitingTools("sess-hold-live");
  now = 1_200;
  await hub.sweep();
  assert.equal(hub.get("sess-hold-live")?.state, "awaiting_tools");
  assert.equal(agent.disposed, false);
  await hub.dropAll();
});

test("hold TTL recycles and logs tool hold expired", async () => {
  let now = 5_000;
  const deleted: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const hub = new SessionHub({
    holdTtlMs: 100,
    idleTtlMs: 10_000,
    now: () => now,
    store: {
      deleteSession: async (id) => {
        deleted.push(id);
        return true;
      }
    }
  });
  try {
    const agent = new FakeAgent("single");
    const run = new FakeSdkRun();
    hub.put("sess-hold-ttl", createSessionSlot({
      agent,
      agentId: agent.agentId,
      apiKey: "key",
      model: "m",
      run
    }));
    const pending = new Promise((_resolve, reject) => {
      hub.registerHold("sess-hold-ttl", "call_x", "Read", () => undefined, reject);
    });
    pending.catch(() => undefined);
    hub.beginAwaitingTools("sess-hold-ttl");
    now = 5_200;
    assert.equal(hub.get("sess-hold-ttl"), undefined);
    await hub.sweep();
    assert.equal(agent.disposed, true);
    assert.equal(run.cancelled, true);
    assert.deepEqual(deleted, ["sess-hold-ttl"]);
    assert.equal(errors.some((line) => line.includes(TOOL_HOLD_EXPIRED_LOG)), true);
  } finally {
    console.error = originalError;
    await hub.dropAll();
  }
});

test("max live sessions evict LRU idle slots", async () => {
  const deleted: string[] = [];
  const hub = new SessionHub({
    maxLiveSessions: 2,
    store: {
      deleteSession: async (id) => {
        deleted.push(id);
        return true;
      }
    }
  });
  const a = new FakeAgent("single");
  const b = new FakeAgent("single");
  const c = new FakeAgent("single");
  hub.put("sess-a", createSessionSlot({ agent: a, agentId: "a", apiKey: "k", model: "m", state: "idle" }));
  hub.put("sess-b", createSessionSlot({ agent: b, agentId: "b", apiKey: "k", model: "m", state: "idle" }));
  hub.markIdle("sess-a");
  hub.put("sess-c", createSessionSlot({ agent: c, agentId: "c", apiKey: "k", model: "m", state: "idle" }));
  await hub.flush();
  assert.equal(hub.get("sess-b"), undefined);
  assert.ok(hub.get("sess-a"));
  assert.ok(hub.get("sess-c"));
  assert.equal(b.disposed, true);
  assert.equal(a.disposed, false);
  assert.deepEqual(deleted, ["sess-b"]);
  await hub.dropAll();
});

test("Map keys are caller-supplied durableSessionId values, not ownerHash", () => {
  const hub = new SessionHub();
  const agent = new FakeAgent("single");
  const id = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/work",
    conversationSeed: "seed-1"
  });
  assert.ok(id);
  hub.put(id, createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "cursor-key",
    model: "composer-2.5"
  }));
  assert.equal(hub.get(id)?.agentId, agent.agentId);
  assert.equal(hub.get("owner-hash-alone"), undefined);
  assert.notEqual(id, "owner-hash-alone");
});

type FakeMode = "single" | "parallel-microtask";

async function startHeldSession(
  hub: SessionHub,
  sessionId: string,
  mode: FakeMode
): Promise<{ agent: FakeAgent; run: FakeSdkRun }> {
  const agent = new FakeAgent(mode);
  const tools = createSdkCustomTools(mode === "single" ? [readTool] : [readTool, grepTool], (toolCall) => {
    const slot = hub.get(sessionId);
    slot?.pump.push({
      kind: "captured",
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.arguments
    });
  }, {
    hold: true,
    onHold: (toolCallId, resolve, reject) => {
      const name = toolCallId.includes("grep") ? "Grep" : "Read";
      hub.registerHold(sessionId, toolCallId, name, resolve, reject);
    }
  });
  if (!tools) throw new Error("expected customTools");
  agent.tools = tools;

  hub.put(sessionId, createSessionSlot({
    agent,
    agentId: agent.agentId,
    apiKey: "key",
    model: "composer-2.5",
    state: "running"
  }));
  const run = await agent.send("Read README.md") as FakeSdkRun;
  const slot = hub.get(sessionId);
  if (!slot) throw new Error("missing slot after put");
  slot.run = run;
  slot.runId = run.id;
  hub.attachPump(sessionId);
  startPump(slot.pump, run);
  return { agent, run };
}

async function consumeUntilHeld(hub: SessionHub, sessionId: string): Promise<HubTurn> {
  const slot = hub.get(sessionId);
  if (!slot?.run) throw new Error("consumeUntilHeld needs a run");
  const pump = hub.attachPump(sessionId);
  const texts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

  for (;;) {
    const item = await pump.next();
    applyPumpItem(item, texts, toolCalls);
    if (item.kind === "end") {
      const detail = item.error instanceof Error ? item.error.message : String(item.error ?? "stream ended");
      throw new Error(`HTTP1 stream ended before pending execute: ${detail}`);
    }
    if (item.kind !== "captured") continue;
    await hub.settleParallelTools();
    drainPump(pump, texts, toolCalls);
    if (![...slot.pending.values()].length) {
      throw new Error(`captured ${item.id} but execute Promise was already settled`);
    }
    hub.beginAwaitingTools(sessionId);
    break;
  }

  return {
    texts,
    toolCalls,
    runId: slot.runId ?? slot.run.id ?? "",
    agentId: slot.agentId
  };
}

async function consumeAfterResolve(
  hub: SessionHub,
  sessionId: string,
  toolCallId: string,
  resultText: string
): Promise<HubTurn> {
  const slot = hub.get(sessionId);
  if (!slot?.run) throw new Error("consumeAfterResolve needs a run");
  const pump = hub.attachPump(sessionId);
  const ok = hub.resolvePending(sessionId, toolCallId, { content: [{ type: "text", text: resultText }] });
  if (!ok) throw new Error(`no pending execute for ${toolCallId}`);

  const texts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (;;) {
    const item = await pump.next();
    if (item.kind === "end") {
      if (item.error) throw item.error instanceof Error ? item.error : new Error(String(item.error));
      break;
    }
    applyPumpItem(item, texts, toolCalls);
  }

  const waitResult = await slot.run.wait();
  hub.markIdle(sessionId);
  return {
    texts,
    toolCalls,
    runId: slot.runId ?? slot.run.id ?? "",
    agentId: slot.agentId,
    waitResult
  };
}

function startPump(pump: { push: (item: HubPumpItem) => void }, run: HubRun): void {
  void (async () => {
    try {
      for await (const event of run.stream()) pump.push({ kind: "event", event });
      pump.push({ kind: "end" });
    } catch (error) {
      pump.push({ kind: "end", error });
    }
  })();
}

function drainPump(
  pump: { poll: () => HubPumpItem | undefined },
  texts: string[],
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
): void {
  for (;;) {
    const extra = pump.poll();
    if (!extra) return;
    if (extra.kind === "end") {
      const detail = extra.error instanceof Error ? extra.error.message : String(extra.error ?? "stream ended");
      throw new Error(`HTTP1 stream ended during settle: ${detail}`);
    }
    applyPumpItem(extra, texts, toolCalls);
  }
}

function applyPumpItem(
  item: HubPumpItem,
  texts: string[],
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
): void {
  if (item.kind === "event") {
    const text = assistantText(item.event);
    if (text) texts.push(text);
    const call = toolCallFromEvent(item.event);
    if (call && !toolCalls.some((existing) => existing.id === call.id)) toolCalls.push(call);
    return;
  }
  if (item.kind === "captured") {
    if (!toolCalls.some((call) => call.id === item.id)) {
      toolCalls.push({ id: item.id, name: item.name, arguments: item.args ?? {} });
    }
  }
}

interface HubTurn {
  texts: string[];
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  runId: string;
  agentId: string;
  waitResult?: unknown;
}

class FakeSdkRun implements HubRun {
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

class FakeAgent implements HubAgent {
  readonly agentId = "agent-held-execute";
  disposed = false;
  tools: Record<string, SDKCustomTool> | undefined;

  constructor(private readonly mode: FakeMode) {}

  async send(_message: unknown, _options?: Record<string, unknown>): Promise<FakeSdkRun> {
    const tools = this.tools;
    if (!tools?.Read) throw new Error("FakeAgent expected customTools.Read.execute");
    const run = new FakeSdkRun();
    const mode = this.mode;
    run.attach(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: mode === "single" ? "Calling Read." : "Calling tools." }] }
      };
      if (mode === "single") {
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
        return;
      }
      if (!tools.Grep) throw new Error("FakeAgent parallel mode expected Grep");
      const pendingRead = tools.Read.execute({ file_path: "README.md" }, { toolCallId: "call_read_1" }) as Promise<unknown>;
      yield {
        type: "tool_call",
        toolCall: { id: "call_read_1", name: "Read", arguments: { file_path: "README.md" } }
      };
      let pendingGrep!: Promise<unknown>;
      queueMicrotask(() => {
        pendingGrep = tools.Grep.execute({ pattern: "TODO" }, { toolCallId: "call_grep_1" }) as Promise<unknown>;
      });
      yield {
        type: "tool_call",
        toolCall: { id: "call_grep_1", name: "Grep", arguments: { pattern: "TODO" } }
      };
      while (!pendingGrep) await delay(0);
      const [readResult, grepResult] = await Promise.all([pendingRead, pendingGrep]);
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: `${toolResultText(readResult)} ${toolResultText(grepResult)}` }]
        }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assistantText(event: unknown): string {
  const record = asRecord(event);
  if (!record || record.type !== "assistant") return "";
  const message = asRecord(record.message);
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    }).join("");
  }
  return typeof record.text === "string" ? record.text : "";
}

function toolCallFromEvent(event: unknown): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  const record = asRecord(event);
  const toolCall = asRecord(record?.toolCall);
  if (!toolCall || typeof toolCall.id !== "string" || typeof toolCall.name !== "string") return undefined;
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: asRecord(toolCall.arguments) ?? {}
  };
}

function toolResultText(result: unknown): string {
  const record = asRecord(result);
  const content = record?.content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const item = asRecord(block);
      return typeof item?.text === "string" ? item.text : "";
    }).join("");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}
