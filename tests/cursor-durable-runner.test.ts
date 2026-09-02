import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKCustomTool } from "@cursor/sdk";
import { CursorSdkRunner, STABLE_DIRECTIVE, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { durableSessionId } from "../src/durable-id.js";
import { ApiError } from "../src/errors.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { createApp } from "../src/server.js";
import { SessionHub } from "../src/session-hub.js";
import { MemoryStateStore } from "../src/store.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  DurableTurn,
  GatewayConfig,
  GatewayTool
} from "../src/types.js";

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

const gatewayConfig: GatewayConfig = {
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
  cursorSdkSessionMode: "stateless",
  cursorSdkToolHoldTtlMs: 900_000,
  cursorSdkSessionIdleTtlMs: 3_600_000,
  cursorSdkMaxLiveSessions: 256,
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

test("durable two user turns: one create, two incremental sends, no ASSISTANT replay", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent();
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return agent;
    },
    resume: async () => {
      throw new Error("resume is WP5; WP4 create path must not resume");
    }
  };
  const runner = durableRunner(hub, factory);

  const first = await runner.run(baseRun({
    prompt: "Conversation:\nUSER: hello\nASSISTANT: I already answered this.\nUSER: follow?",
    conversationSeed: "seed-two-turns",
    durableTurn: userTurn("hello")
  }));
  const second = await runner.run(baseRun({
    prompt: "Conversation:\nUSER: hello\nASSISTANT: I already answered this.\nUSER: follow up",
    conversationSeed: "seed-two-turns",
    durableTurn: userTurn("follow up")
  }));

  assert.equal(createCount, 1);
  assert.equal(agent.sends.length, 2);
  assert.equal(agent.disposed, false);
  assert.equal(first.text, "reply 1");
  assert.equal(second.text, "reply 2");
  const firstPayload = sendText(agent.sends[0]);
  const secondPayload = sendText(agent.sends[1]);
  assert.match(firstPayload, new RegExp(STABLE_DIRECTIVE));
  assert.match(firstPayload, /hello/);
  assert.equal(firstPayload.includes("ASSISTANT:"), false);
  assert.equal(firstPayload.includes("TOOLS:"), false);
  assert.equal(firstPayload.includes("REMINDER"), false);
  assert.equal(firstPayload.includes("Conversation:"), false);
  assert.equal(secondPayload.includes("ASSISTANT:"), false);
  assert.equal(secondPayload.includes("I already answered this"), false);
  assert.equal(secondPayload.includes(STABLE_DIRECTIVE), false);
  assert.equal(secondPayload, "follow up");
  assert.match(String(agent.sendOptions[0]?.idempotencyKey), /^[0-9a-f]{64}$/);
  assert.equal("local" in (agent.sendOptions[0] ?? {}), false);
  assert.equal("local" in (agent.sendOptions[1] ?? {}), false);
  await hub.dropAll();
});

test("durable first send prefixes gateway SYSTEM text", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent();
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  await runner.run(baseRun({
    conversationSeed: "seed-system",
    durableTurn: { kind: "new_user", userText: "hello", systemText: "gateway-rule", ...FP }
  }));
  const payload = sendText(agent.sends[0]);
  assert.match(payload, /SYSTEM:\ngateway-rule/);
  assert.match(payload, /hello/);
  await hub.dropAll();
});

test("durable held execute: same runId, one send, resolve, no cancel/dispose", async (t) => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const logs: string[] = [];
  const error = t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const agent = new HeldToolAgent();
  let createCount = 0;
  const factory: AgentFactory = {
    create: async (options) => {
      createCount += 1;
      agent.attachCreateOptions(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-held-execute";

  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  assert.equal(createCount, 1);
  assert.equal(agent.sends.length, 1);
  assert.equal(http1.toolCalls.map((call) => call.name).join(","), "Read");
  assert.equal(http1.runId, "run-held");
  assert.equal(agent.runs[0]?.cancelled, false);
  assert.equal(agent.disposed, false);
  assert.equal(http1.text.includes("hello from README"), false);

  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_read_1", content: "hello from README" }]
    }
  }));

  assert.equal(createCount, 1);
  assert.equal(agent.sends.length, 1, "tool_result must resolve execute, not send again");
  assert.equal(http2.runId, http1.runId);
  assert.match(http2.text, /hello from README/);
  assert.equal(agent.runs[0]?.cancelled, false);
  assert.equal(agent.disposed, false);
  assert.ok(logs.some((line) => line.includes("[durable] resolve execute id=call_read_1")), logs.join("\n"));
  assert.ok(logs.some((line) => line.includes("[durable] send first")), logs.join("\n"));
  error.mock.restore();
  await hub.dropAll();
});

test("Responses remapped call_id still resolves the hung execute (path A)", async (t) => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const logs: string[] = [];
  const error = t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const agent = new HeldToolAgent("toolu_01lookup");
  const factory: AgentFactory = {
    create: async (options) => {
      agent.attachCreateOptions(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-responses-alias";

  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("lookup ping")
  }));
  assert.equal(http1.toolCalls.length, 1);
  assert.equal(http1.toolCalls[0]?.id, "toolu_01lookup");

  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_toolu_01lookup", content: "pong" }]
    }
  }));

  assert.equal(agent.sends.length, 1, "remapped call_id must resolve execute, not send");
  assert.equal(http2.runId, http1.runId);
  assert.match(http2.text, /pong/);
  assert.ok(logs.some((line) => line.includes("[durable] resolve execute id=call_toolu_01lookup")), logs.join("\n"));
  error.mock.restore();
  await hub.dropAll();
});

test("unmatched tool_results abort hung execute then path B, no drop+create", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new HeldToolAgent();
  let createCount = 0;
  const factory: AgentFactory = {
    create: async (options) => {
      createCount += 1;
      agent.attachCreateOptions(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-unmatched-abort";

  await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_other", content: "stale replay" }]
    }
  }));

  assert.equal(createCount, 1);
  assert.equal(agent.sends.length, 2);
  assert.match(sendText(agent.sends[1]), /TOOL RESULT \(call_other\):\nstale replay/);
  assert.equal(http2.text, "after tool");
  assert.equal(agent.disposed, false);
  await hub.dropAll();
});

test("SDK event tool_call with a different id than execute is not double-emitted", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new HeldToolAgent("call_read_1", "evt_other");
  const factory: AgentFactory = {
    create: async (options) => {
      agent.attachCreateOptions(options);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const http1 = await runner.run(baseRun({
    conversationSeed: "seed-dedup-ids",
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  assert.deepEqual(http1.toolCalls.map((call) => call.id), ["call_read_1"]);
  assert.equal(http1.toolCalls.length, 1);
  await hub.dropAll();
});

test("no Hub and kill switch off is true stateless, never old resume", async () => {
  const created: TrackingAgent[] = [];
  let resumeCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-nohub-${created.length + 1}`);
      created.push(agent);
      return agent;
    },
    resume: async () => {
      resumeCount += 1;
      throw new Error("SESSION_MODE=stateless must not resume");
    }
  };
  const store = new MemoryStateStore();
  const runner = new CursorSdkRunner(store, {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    disableSessionResume: false
  }, factory);
  const flatten = "Conversation:\nUSER: hello\nASSISTANT: old\nUSER: next";
  await runner.run(baseRun({ prompt: flatten, conversationSeed: "seed-nohub", stickyKey: "sticky-nohub" }));
  await runner.run(baseRun({ prompt: flatten, conversationSeed: "seed-nohub", stickyKey: "sticky-nohub" }));
  assert.equal(resumeCount, 0);
  assert.equal(created.length, 2);
  assert.equal(sendText(created[0].sends[0]), flatten);
  assert.equal(created[0].disposed, true);
});

test("kill switch stays stateless even when a Hub is injected", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-stateless-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), {
    defaultWorkingDirectory: "/workspace",
    sdkClientVersion: "test",
    disableSessionResume: true,
    sessionHub: hub
  }, factory);
  const flatten = "Conversation:\nUSER: hello\nASSISTANT: old answer\nUSER: next\nTOOLS:\nREMINDER: listed tools";

  await runner.run(baseRun({
    prompt: flatten,
    conversationSeed: "seed-kill",
    stickyKey: "sticky-kill",
    durableTurn: userTurn("hello")
  }));
  await runner.run(baseRun({
    prompt: flatten,
    conversationSeed: "seed-kill",
    stickyKey: "sticky-kill",
    durableTurn: userTurn("next")
  }));

  assert.equal(created.length, 2);
  assert.equal(sendText(created[1].sends[0]), flatten);
  assert.match(String(created[0].sendOptions[0]?.idempotencyKey), /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(created[0].disposed, true);
  assert.equal(created[1].disposed, true);
  await hub.dropAll();
});

test("unidentifiable session is true stateless: no resume persist even with Hub + kill switch off", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const store = new MemoryStateStore();
  const created: TrackingAgent[] = [];
  let resumeCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-anon-${created.length + 1}`);
      created.push(agent);
      return agent;
    },
    resume: async () => {
      resumeCount += 1;
      throw new Error("resume must not run for unidentifiable sessions");
    }
  };
  const runner = durableRunner(hub, factory, store);
  const flatten = "Conversation:\nASSISTANT: should be sent on stateless fallback\nUSER: hi";

  await runner.run(baseRun({
    prompt: flatten,
    sessionKey: "owner-looking-but-not-a-seed"
  }));
  await runner.run(baseRun({
    prompt: flatten,
    sessionKey: "owner-looking-but-not-a-seed"
  }));

  assert.equal(created.length, 2);
  assert.equal(resumeCount, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal(hub.size, 0);
  assert.equal(sendText(created[0].sends[0]), flatten);
  assert.equal(sendText(created[1].sends[0]), flatten);
  assert.equal(created[0].disposed, true);
  assert.equal(created[1].disposed, true);
  await hub.dropAll();
});

test("inferred conversationSeed does not enter the Hub when reuseDurableAgent is false", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const store = new MemoryStateStore();
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-inferred-${created.length + 1}`);
      created.push(agent);
      return agent;
    },
    resume: async () => {
      throw new Error("resume must not run when reuseDurableAgent is false");
    }
  };
  const runner = durableRunner(hub, factory, store);
  const flatten = "Conversation:\nUSER: hello";

  await runner.run(baseRun({
    prompt: flatten,
    conversationSeed: "same-hello-hash",
    stickyKey: "owner:same-hello-hash",
    durableTurn: userTurn("hello"),
    reuseDurableAgent: false
  }));
  await runner.run(baseRun({
    prompt: flatten,
    conversationSeed: "same-hello-hash",
    stickyKey: "owner:same-hello-hash",
    durableTurn: userTurn("hello"),
    reuseDurableAgent: false
  }));

  assert.equal(created.length, 2);
  assert.equal(store.sessions.size, 0);
  assert.equal(hub.size, 0);
  assert.equal(sendText(created[0].sends[0]), flatten);
  assert.equal(created[0].disposed, true);
  assert.equal(created[1].disposed, true);
  await hub.dropAll();
});

test("overlapping new_user on a locked Hub is stateless flatten, not 499", { timeout: 5_000 }, async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const store = new MemoryStateStore();
  let createCount = 0;
  let firstAgent: TrackingAgent | undefined;
  let secondAgent: TrackingAgent | undefined;
  let resolveHang = (): void => undefined;
  const hang = new Promise<void>((resolve) => {
    resolveHang = resolve;
  });
  let firstCreateStarted!: () => void;
  const firstCreate = new Promise<void>((resolve) => {
    firstCreateStarted = resolve;
  });
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      if (createCount === 1) {
        firstCreateStarted();
        await hang;
        firstAgent = new TrackingAgent("agent-overlap-1");
        return firstAgent;
      }
      secondAgent = new TrackingAgent("agent-overlap-2");
      return secondAgent;
    },
    resume: async () => {
      throw new Error("overlapping new_user fallback must not resume");
    }
  };
  const runner = durableRunner(hub, factory, store);
  const flatten = "Conversation:\nUSER: hello";
  const seed = "seed-overlap-new-user";
  const sessionId = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/workspace",
    conversationSeed: seed
  });
  assert.ok(sessionId);

  const first = runner.run(baseRun({
    prompt: flatten,
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  try {
    await firstCreate;
    const second = await runner.run(baseRun({
      prompt: flatten,
      conversationSeed: seed,
      durableTurn: userTurn("hello")
    }));
    assert.equal(createCount, 2);
    assert.ok(secondAgent);
    assert.equal(sendText(secondAgent.sends[0]), flatten);
    assert.equal(secondAgent.disposed, true);
    assert.equal(firstAgent === undefined, true);
    assert.equal(second.text, "reply 1");

    resolveHang();
    const firstResult = await first;
    assert.ok(firstAgent);
    assert.equal(firstResult.agentId, "agent-overlap-1");
    assert.equal(firstAgent.disposed, false);
    assert.equal(hub.get(sessionId)?.agentId, "agent-overlap-1");
    assert.equal(hub.get(sessionId)?.agent, firstAgent);
  } finally {
    resolveHang();
    await first.catch(() => undefined);
    await hub.dropAll();
  }
});

test("durable path B: marker tool_call then tool_result is a short send, same agent", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new MarkerAgent();
  let createCount = 0;
  const factory: AgentFactory = {
    create: async () => {
      createCount += 1;
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-marker-b";

  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("read it")
  }));
  assert.equal(http1.toolCalls[0]?.name, "Read");
  assert.equal(createCount, 1);
  assert.equal(agent.disposed, false);
  assert.equal(agent.runs[0]?.cancelled, true);

  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_mark", content: "file body" }]
    }
  }));
  assert.equal(createCount, 1);
  assert.equal(agent.sends.length, 2);
  assert.match(sendText(agent.sends[1]), /TOOL RESULT \(call_mark\):\nfile body/);
  assert.equal(sendText(agent.sends[1]).includes("ASSISTANT:"), false);
  assert.equal(http2.text, "after tool");
  assert.equal(agent.disposed, false);
  await hub.dropAll();
});

test("path B abort after tool_call keeps the idle agent", { timeout: 5_000 }, async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new MarkerAgent({ hangWaitOnFirst: true });
  const factory: AgentFactory = {
    create: async () => agent
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-marker-b-abort";
  const sessionId = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/workspace",
    conversationSeed: seed
  });
  assert.ok(sessionId);

  const abort = new AbortController();
  const events: CursorStreamEvent[] = [];
  try {
    for await (const event of runner.stream(baseRun({
      conversationSeed: seed,
      tools: [readTool],
      durableTurn: userTurn("read it")
    }), abort.signal)) {
      events.push(event);
      if (event.type === "tool_call") abort.abort();
    }
  } catch (error) {
    assert.equal(error instanceof ApiError && error.statusCode === 499, true, String(error));
  }

  assert.ok(events.some((event) => event.type === "tool_call"));
  assert.equal(agent.disposed, false);
  const slot = hub.get(sessionId);
  assert.ok(slot, "path B abort must not drop the Hub slot");
  assert.equal(slot.state, "idle");
  assert.equal(slot.agent, agent);
  await hub.dropAll();
});

test("chat, responses, and messages all attach durableTurn and conversationSeed", async () => {
  const capture = new CaptureRunner();
  const { app } = await createCaptureApp(capture);

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "hello chat" }] }
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(capture.last?.durableTurn?.kind, "new_user");
  assert.equal(capture.last?.durableTurn?.userText, "hello chat");
  assert.ok(capture.last?.conversationSeed);
  assert.ok(capture.last?.stickyKey);
  assert.equal(capture.last?.reuseDurableAgent, true);

  const chatSession = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer gateway-key", "x-session-affinity": "sess-chat-1" },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "hello chat" }] }
  });
  assert.equal(chatSession.statusCode, 200);
  assert.equal(capture.last?.reuseDurableAgent, true);

  const responses = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer gateway-key" },
    payload: { model: "composer-2.5", input: "hello responses" }
  });
  assert.equal(responses.statusCode, 200);
  assert.equal(capture.last?.durableTurn?.kind, "new_user");
  assert.equal(capture.last?.durableTurn?.userText, "hello responses");
  assert.ok(capture.last?.conversationSeed);
  assert.equal(capture.last?.reuseDurableAgent, true);

  const messages = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key" },
    payload: { model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content: "hello messages" }] }
  });
  assert.equal(messages.statusCode, 200);
  assert.equal(capture.last?.durableTurn?.kind, "new_user");
  assert.equal(capture.last?.durableTurn?.userText, "hello messages");
  assert.ok(capture.last?.conversationSeed);
  assert.equal(capture.last?.reuseDurableAgent, true);

  const messagesSession = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": "gateway-key", "anthropic-session-id": "sess-msg-1" },
    payload: { model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content: "hello messages" }] }
  });
  assert.equal(messagesSession.statusCode, 200);
  assert.equal(capture.last?.reuseDurableAgent, true);

  const counted = await app.inject({
    method: "POST",
    url: "/v1/messages/count_tokens",
    headers: { "x-api-key": "gateway-key" },
    payload: { model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content: "hello messages" }] }
  });
  assert.equal(counted.statusCode, 200);

  await app.close();
});

test("empty durable turn is 400", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory: AgentFactory = {
    create: async () => new TrackingAgent()
  };
  const runner = durableRunner(hub, factory);
  await assert.rejects(
    () => runner.run(baseRun({
      conversationSeed: "seed-empty",
      durableTurn: { kind: "empty", ...FP }
    })),
    (error) => error instanceof ApiError && error.statusCode === 400
  );
  await hub.dropAll();
});

function durableRunner(hub: SessionHub, factory: AgentFactory, store: MemoryStateStore = new MemoryStateStore()): CursorSdkRunner {
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

function sendText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "text" in message && typeof (message as { text: unknown }).text === "string") {
    return (message as { text: string }).text;
  }
  return String(message);
}

async function createCaptureApp(inner: CursorRunner): Promise<{ app: ReturnType<typeof createApp> }> {
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["server-cursor-key"]);
  const runner = new KeyRotatingRunner(inner, keyPool, { maxKeyAttempts: 3, maxTransientAttempts: 1 });
  const app = createApp({
    config: gatewayConfig,
    store,
    runner,
    keyPool,
    startedAt: Date.now(),
    modelLister: async () => ({
      models: [{ id: "composer-2.5", name: "Composer", aliases: [] }],
      source: "cursor"
    })
  });
  return { app };
}

class CaptureRunner implements CursorRunner {
  last?: CursorRunRequest;

  async run(input: CursorRunRequest): Promise<CursorRunResult> {
    this.last = input;
    return { text: "ok", toolCalls: [] };
  }

  async *stream(input: CursorRunRequest): AsyncIterable<CursorStreamEvent> {
    this.last = input;
    yield { type: "done", result: { text: "ok", toolCalls: [] } };
  }
}

class SimpleFakeRun {
  cancelled = false;

  constructor(readonly id: string, private readonly input: {
    streamEvents?: () => AsyncIterable<unknown>;
    waitResult?: unknown;
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

  constructor(
    private readonly executeId = "call_read_1",
    private readonly eventId?: string
  ) {}

  attachCreateOptions(options: Record<string, unknown>): void {
    const local = asRecord(options.local);
    this.tools = local?.customTools as Record<string, SDKCustomTool> | undefined;
  }

  async send(message: unknown): Promise<HeldFakeRun> {
    this.sends.push(message);
    const run = new HeldFakeRun();
    this.runs.push(run);
    if (this.sends.length > 1) {
      run.attach(async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "after tool" }] }
        };
      });
      return run;
    }
    const tools = this.tools;
    if (!tools?.Read) throw new Error("HeldToolAgent expected customTools.Read on create");
    const executeId = this.executeId;
    const eventId = this.eventId ?? executeId;
    run.attach(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Calling Read." }] }
      };
      const pending = tools.Read.execute({ file_path: "README.md" }, { toolCallId: executeId }) as Promise<unknown>;
      yield {
        type: "tool_call",
        toolCall: { id: eventId, name: "Read", arguments: { file_path: "README.md" } }
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

class MarkerAgent implements AgentLike {
  readonly agentId = "agent-marker";
  disposed = false;
  readonly sends: unknown[] = [];
  readonly runs: SimpleFakeRun[] = [];

  constructor(private readonly options: { hangWaitOnFirst?: boolean } = {}) {}

  async send(message: unknown): Promise<SimpleFakeRun> {
    this.sends.push(message);
    const n = this.sends.length;
    const run = new SimpleFakeRun(`run-mark-${n}`, {
      streamEvents: async function* () {
        if (n === 1) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: '<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"},"id":"call_mark"}</tool_call>' }]
            }
          };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "after tool" }] }
        };
      },
      hangWait: n === 1 && this.options.hangWaitOnFirst === true,
      waitResult: n === 1
        ? { status: "cancelled", result: "" }
        : { status: "finished", result: "after tool" }
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
