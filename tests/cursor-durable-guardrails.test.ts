import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorSdkRunner, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { durableSessionId } from "../src/durable-id.js";
import {
  SessionHub,
  assistantTextDigest,
  createSessionSlot,
  inboundAssistantTextMismatch,
  inboundHistoryIncompatible,
  markTurnDelivered,
  recordAssistantDigest,
  type HubAgent
} from "../src/session-hub.js";
import { extractDurableTurn } from "../src/prompt-delta.js";
import { durableTelemetrySnapshot, resetDurableTelemetry } from "../src/durable-telemetry.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunRequest, CursorStreamEvent, DurableTurn, GatewayTool } from "../src/types.js";

/** 包 E（轮次一致性护栏）专项：每个护栏点至少一条断言。 */

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

test("护栏纯函数：assistantTextDigest 口径（去空白）与 mismatch 判定", () => {
  assert.equal(assistantTextDigest("hello  world"), assistantTextDigest("helloworld"));
  assert.notEqual(assistantTextDigest("hello"), assistantTextDigest("olleh"));
  const slot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  // 两侧都有值才比对：一侧缺号 = 无法证明分叉，放行。
  assert.equal(inboundAssistantTextMismatch(slot, undefined), false);
  recordAssistantDigest(slot, "turn one output");
  assert.equal(inboundAssistantTextMismatch(slot, undefined), false);
  assert.equal(inboundAssistantTextMismatch(slot, assistantTextDigest("turn one output")), false);
  assert.equal(inboundAssistantTextMismatch(slot, assistantTextDigest("different output")), true);
  // 空文本不记录摘要（护栏不触发）。
  const emptySlot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  recordAssistantDigest(emptySlot, "   ");
  assert.equal(emptySlot.lastAssistantDigest, undefined);
});

test("护栏纯函数：纯文本会话（无 issued ids）历史分叉不再直接放行", () => {
  const slot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  // 旧行为：!issued.length 直接 return false。现在两侧都有摘要时要比对。
  assert.equal(inboundHistoryIncompatible(slot, { kind: "new_user" }), false);
  recordAssistantDigest(slot, "previous answer");
  assert.equal(
    inboundHistoryIncompatible(slot, { kind: "new_user", assistantDigest: assistantTextDigest("rewritten answer") }),
    true
  );
  assert.equal(
    inboundHistoryIncompatible(slot, { kind: "new_user", assistantDigest: assistantTextDigest("previous answer") }),
    false
  );
});

test("护栏纯函数：markTurnDelivered 与 lastUserText（已发送）分离", () => {
  const slot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  slot.lastUserText = "hello";
  assert.equal(slot.deliveredUserText, undefined, "send 之后只写 lastUserText，不写 delivered");
  markTurnDelivered(slot);
  assert.equal(slot.deliveredUserText, "hello");
});

test("extractDurableTurn 产出 assistantDigest（chat/anthropic），Responses 缺省", () => {
  const chat = extractDurableTurn("openai-chat", {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "follow up" }
    ]
  });
  assert.equal(chat.kind, "new_user");
  assert.equal(chat.assistantDigest, assistantTextDigest("hi there"));

  const anthropic = extractDurableTurn("anthropic-messages", {
    max_tokens: 64,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "answer one" }] },
      { role: "user", content: "next" }
    ]
  });
  assert.equal(anthropic.assistantDigest, assistantTextDigest("answer one"));

  // Responses 历史走 previous_response_id，input 里没有 assistant 轮 → digest 缺省（护栏不触发）。
  const responses = extractDurableTurn("openai-responses", {
    input: "Explain closures."
  });
  assert.equal(responses.assistantDigest, undefined);

  // 无 assistant 轮的纯首轮也缺省。
  const firstTurn = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(firstTurn.assistantDigest, undefined);
});

test("护栏 1：空 userText 不 send，退 stateless 全量（不 400）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-empty-guard-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const flatten = "Conversation:\nASSISTANT: stateless full prompt must run\nUSER: hi";

  const result = await runner.run(baseRun({
    prompt: flatten,
    conversationSeed: "seed-empty-guard",
    durableTurn: { kind: "new_user", userText: "", ...FP }
  }));

  // 空轮次被护栏拦下：durable send 不发生，stateless 全量跑了一条。
  assert.equal(created.length, 1);
  assert.equal(created[0].sends.length, 1);
  assert.equal(sendText(created[0].sends[0]), flatten);
  assert.equal(created[0].disposed, true);
  assert.equal(result.text, "reply 1");
  assert.equal(hub.size, 0, "空轮次守卫发生在 ensureDurableSlot 之前，不留 Hub 槽");
});

test("护栏 1：空轮次守卫在 debug 快照里标红（noteUpstreamTurn blocked）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory: AgentFactory = { create: async () => new TrackingAgent() };
  const runner = durableRunner(hub, factory);
  const turns: Array<{ channel: string; payload: unknown }> = [];
  await runner.run(baseRun({
    conversationSeed: "seed-empty-guard-debug",
    durableTurn: { kind: "new_user", userText: "", ...FP },
    debugRef: {
      noteUpstreamTurn(channel, payload) {
        turns.push({ channel, payload });
      },
      noteSelectedKey: () => undefined
    }
  }));
  const blocked = turns.find((turn) => (turn.payload as { blocked?: string })?.blocked === "empty_turn_guard");
  assert.ok(blocked, "debug 快照必须能看出空轮次被拦下");
  await hub.dropAll();
});

test("护栏 3：历史分叉 ⇒ stateless 退回且 slot 存活（不销毁 agent、不 drop+create）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-mismatch-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-history-mismatch";
  const sessionId = sessionHash(seed);

  // 第一轮：正常 durable 复用，产出 "reply 1"，slot 记录 lastAssistantDigest。
  await runner.run(baseRun({
    conversationSeed: seed,
    prompt: "Conversation:\nUSER: hello",
    durableTurn: userTurnWithAssistant("hello", "reply 1")
  }));
  assert.equal(created.length, 1);
  assert.ok(hub.get(sessionId));

  // 第二轮：入站 transcript 的上一条 assistant 是客户端伪造的另一段输出（分叉）。
  const forked = await runner.run(baseRun({
    conversationSeed: seed,
    prompt: "Conversation:\nUSER: hello\nASSISTANT: I said something completely different\nUSER: follow up",
    durableTurn: userTurnWithAssistant("follow up", "I said something completely different")
  }));

  // 分叉 ⇒ 本轮退 stateless（新建 agent 跑全量 prompt），原 slot 原样存活。
  assert.equal(created.length, 2, "分叉轮走 stateless 新 agent");
  assert.equal(sendText(created[1].sends[0]), "Conversation:\nUSER: hello\nASSISTANT: I said something completely different\nUSER: follow up");
  assert.equal(forked.text, "reply 1");
  const slot = hub.get(sessionId);
  assert.ok(slot, "历史分叉不得销毁 Hub 槽");
  assert.equal(slot.agent, created[0].agent);
  assert.equal(created[0].disposed, false);
  await hub.dropAll();
});

test("护栏（粘性 stateless）：fallback 后槽 digest 停在旧轮，后续每轮继续退 stateless 且槽不销毁", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-sticky-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-sticky-stateless";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  // 第一轮：正常 durable 复用，交付 "reply 1"，slot 记录 digest(reply 1)。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  assert.equal(created.length, 1);
  const durableAgent = created[0];

  // 第二轮：入站 transcript 分叉 ⇒ stateless 退回（slot 的 digest 仍停在 reply 1）。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("follow up", "forked output")
  }));
  assert.equal(created.length, 2, "分叉轮退 stateless 新 agent");

  // 第三轮：transcript 反映的是 stateless 轮的输出（≠ 槽里旧轮 digest）⇒ 仍然 mismatch，继续退
  // stateless（粘性，有意为之）：stateless 轮走全新 agent，上游 durable agent 的历史已分叉，
  // 恢复增量只会错位；槽被 TTL/LRU 回收后基线自然重置。
  const third = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("more", "output of the stateless run")
  }));
  assert.equal(created.length, 3, "粘性：fallback 后下一轮也走 stateless");
  assert.equal(third.text, "reply 1");
  assert.equal(durableAgent.sends.length, 1, "durable agent 不再收增量 send");
  const liveSlot = hub.get(sessionId);
  assert.ok(liveSlot, "粘性 stateless 不销毁槽（TTL/LRU 回收后才自然重置）");
  assert.equal(liveSlot.agent, durableAgent.agent);
  const snapshot = durableTelemetrySnapshot();
  assert.equal(snapshot.decisions["fallback:history_mismatch"] ?? 0, 2, "两轮都留下 history_mismatch 打点");
  await hub.dropAll();
});

test("护栏（审阅应修 1）：resumed 槽以入站 digest 播种，恢复槽的护栏与 live 槽同口径", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const store = new MemoryStateStore();
  const resumedAgent = new ResumedSilentAgent();
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-resume-fallback-${created.length + 1}`);
      created.push(agent);
      return agent;
    },
    resume: async () => resumedAgent
  };
  const runner = durableRunner(hub, factory, store);
  const seed = "seed-resume-digest";
  const sessionId = sessionHash(seed);
  // 进程重启后的恢复链路：Hub 槽没了，store 里还留着 agentId（agent-store 只落 SDK 文档，
  // slot 的 digest 只能从入站 turn 播种）。
  await store.saveSession(sessionId, "agent-resumed");

  // 恢复轮：入站 transcript 上一条 assistant = "earlier reply"；恢复的 agent 交付空文本
  // （digest 不被本轮输出覆盖），播种的基线必须留在槽上。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("hello again", "earlier reply")
  }));
  assert.equal(resumedAgent.sends.length, 1);
  assert.equal(sendText(resumedAgent.sends[0]), "hello again", "resumed 槽不重发 STABLE_DIRECTIVE");
  const slot = hub.get(sessionId);
  assert.ok(slot);
  assert.equal(slot.resumed, true);
  assert.equal(slot.lastAssistantDigest, assistantTextDigest("earlier reply"), "resumed 槽播种入站 digest 基线");

  // 下一轮 transcript 与恢复基线分叉 ⇒ 退 stateless（resumed 槽的护栏不再失效），槽存活。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("next", "forked after resume")
  }));
  assert.equal(created.length, 1, "分叉轮退 stateless 新 agent");
  assert.equal(resumedAgent.sends.length, 1, "resumed agent 不收分叉轮的增量 send");
  assert.ok(hub.get(sessionId), "分叉退回不得销毁 resumed 槽");
  await hub.dropAll();
});

test("护栏 5：重复 new_user（重试）不 400 —— 已交付 ⇒ stateless 全量重跑", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-retry-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-retry-delivered";

  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }));
  assert.equal(created.length, 1);
  assert.equal(created[0].sends.length, 1);

  // 客户端重试同一轮：绝不 400，也不再发增量（上游已收到过），退 stateless 全量。
  const flatten = "Conversation:\nUSER: hello";
  const retried = await runner.run(baseRun({
    conversationSeed: seed,
    prompt: flatten,
    durableTurn: userTurn("hello")
  }));

  assert.equal(created.length, 2, "已交付的重试走 stateless 新 agent");
  assert.equal(created[0].sends.length, 1, "durable agent 不再收第二次增量 send");
  assert.equal(sendText(created[1].sends[0]), flatten);
  assert.equal(retried.text, "reply 1");
  const slot = hub.get(sessionHash(seed));
  assert.ok(slot, "重试退回不得销毁 Hub 槽");
  assert.equal(slot.agent, created[0].agent);
  await hub.dropAll();
});

test("护栏 5：重复 new_user 且挂起 execute 已交付工具 ⇒ stateless 退回（槽与挂起 execute 保留）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: Array<{ agent: HeldToolAgent; durable: boolean }> = [];
  const factory: AgentFactory = {
    create: async (options) => {
      // 首次 create = durable agent；之后所有 create = stateless 退回的新 agent。
      const durable = created.length === 0;
      const agent = new HeldToolAgent(durable);
      if (durable) agent.attachCreateOptions(options);
      created.push({ agent, durable });
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-retry-resume";

  // HTTP1 停在挂起 execute：userText 已发送、tool_call 已交付。
  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  assert.equal(http1.toolCalls[0]?.id, "call_read_1");
  const durableAgent = created[0].agent;
  assert.equal(durableAgent.sends.length, 1);

  // 重复 new_user：不 400、不再 send，本轮退 stateless（工具已交付，客户端重试意味着它没收到）。
  const retried = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    prompt: "Conversation:\nUSER: Read README.md",
    durableTurn: userTurn("Read README.md")
  }));
  assert.equal(durableAgent.sends.length, 1, "重试绝不触发第二次 durable send");
  assert.ok(!/Empty durable turn/.test(String(retried.text)));
  const slot = hub.get(sessionHash(seed));
  assert.ok(slot, "重试不得销毁挂起 execute 的槽");
  assert.equal(slot.pending.has("call_read_1"), true, "挂起 execute 不被重试打断");
  await hub.dropAll();
});

test("护栏 5：重复 new_user 未交付且 pump 有产出 ⇒ 续播（reuse:retry_after_send），不重发", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent("agent-retry-pump-output");
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-retry-pump-output";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  // 第一轮正常交付 "reply 1"：slot 记录 lastUserText/runId，pump 盖上本 run 印章。
  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  const slot = hub.get(sessionId);
  assert.ok(slot);

  // 手工构造「已发送未交付 + pump 有产出」：清掉交付标记，往 pump 塞带本轮 runId 印章的续播输出。
  // （该窗口实践中几乎不可达——send 之后、交付之前 HTTP 必须恰好断掉且槽未回收；此处作为
  // reuse:retry_after_send 防御性分支的行为锁定，与护栏 6 的陈旧印章用例互补。）
  slot.deliveredUserText = undefined;
  slot.pump.push({ kind: "event", event: { type: "text-delta", text: "parked run output" } });
  slot.pump.push({ kind: "end" });

  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }))) {
    events.push(event);
  }

  const text = events.map((event) => (event.type === "text" ? event.text : "")).join("");
  assert.ok(text.includes("parked run output"), "续播必须吐出 park 住的 pump 产出");
  assert.ok(events.some((event) => event.type === "done"), "续播流必须正常收尾");
  assert.equal(agent.sends.length, 1, "续播绝不触发第二次 durable send");
  assert.ok(hub.get(sessionId), "续播不得销毁槽");
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["reuse:retry_after_send"] ?? 0) >= 1,
    "必须留下 reuse:retry_after_send 打点"
  );
  await hub.dropAll();
});

test("护栏 6：pump 事件 runId 不匹配 ⇒ 丢弃不计入本轮", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent();
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-stale-pump";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("hello") }));
  const slot = hub.get(sessionId);
  assert.ok(slot);

  // 模拟换 run 后的残留：pump 里塞入盖着旧 run 印章的事件与终止项，本轮 runId 与印章不一致。
  slot.pump.runId = "run-stale";
  slot.pump.push({ kind: "event", event: { type: "text-delta", text: "STALE OUTPUT" } });
  slot.pump.push({ kind: "end" });
  slot.runId = "run-current";
  // 重试但清掉交付标记：强制走「未交付且有残留」的续播分支。
  slot.deliveredUserText = undefined;
  slot.lastUserText = "hello";

  const events: CursorStreamEvent[] = [];
  for await (const event of runner.stream(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello")
  }))) {
    events.push(event);
  }

  const text = events.map((event) => (event.type === "text" ? event.text : "")).join("");
  assert.equal(text.includes("STALE OUTPUT"), false, "陈旧 run 的事件绝不能当作本轮输出");
  assert.ok(events.some((event) => event.type === "done"), "丢弃陈旧项后流必须正常收尾");
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["fallback:stale_pump_events"] ?? 0) >= 1,
    "陈旧 pump 项必须留下 stale_pump_events 打点"
  );
  await hub.dropAll();
});

test("护栏 7：held execute 只驱动一次 —— 重放同一条 tool_results 不再触发第二次消费", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: Array<{ agent: HeldToolAgent; durable: boolean }> = [];
  const factory: AgentFactory = {
    create: async (options) => {
      // 首次 create = durable agent；之后所有 create = stateless 退回的新 agent。
      const durable = created.length === 0;
      const agent = new HeldToolAgent(durable);
      if (durable) agent.attachCreateOptions(options);
      created.push({ agent, durable });
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-idempotent-execute";

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
      toolResults: [{ id: "call_read_1", content: "hello from README" }]
    }
  }));
  assert.match(http2.text, /hello from README/);
  const durableAgent = created[0].agent;
  assert.equal(durableAgent.sends.length, 1);

  // 重放同一条 tool_results（resolvePending 已落空、execute 已被消费）：
  // 绝不能驱动第二次 consume、更不能再 send 一轮（上游会多收一个无输入轮次）。
  const replay = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    prompt: "Conversation:\nUSER: Read README.md",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_read_1", content: "hello from README" }]
    }
  }));
  assert.equal(durableAgent.sends.length, 1, "重放的 tool_results 不得再触发 durable send");
  assert.ok(replay.text.length > 0, "重放走 stateless 也要有完整产出，不报错");
  await hub.dropAll();
});

test("护栏 4（400 文案分叉）：kind=empty 的 400 使用可区分的 message/code", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory: AgentFactory = { create: async () => new TrackingAgent() };
  const runner = durableRunner(hub, factory);
  await assert.rejects(
    () => runner.run(baseRun({
      conversationSeed: "seed-empty-400-message",
      durableTurn: { kind: "empty", ...FP }
    })),
    (error) => error instanceof Error
      && error.message.includes("no sendable content")
      && (error as { code?: string }).code === "request_empty"
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

/** 与入站 transcript 的上一条 assistant 文本对齐的 new_user turn（assistantDigest 由 extractDurableTurn 口径生成）。 */
function userTurnWithAssistant(userText: string, lastAssistantText: string): DurableTurn {
  return {
    kind: "new_user",
    userText,
    ...FP,
    assistantDigest: assistantTextDigest(lastAssistantText)
  };
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
  const record = message && typeof message === "object" ? message as { text?: unknown } : undefined;
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

  constructor(readonly agentId = "agent-guard") {}

  get agent(): TrackingAgent {
    return this;
  }

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

/** 恢复轮交付空文本的假 agent：digest 基线不被本轮输出覆盖，用来锁定 resumed 槽的播种行为。 */
class ResumedSilentAgent implements AgentLike {
  readonly sends: unknown[] = [];

  constructor(readonly agentId = "agent-resumed") {}

  async send(message: unknown): Promise<SimpleFakeRun> {
    this.sends.push(message);
    return new SimpleFakeRun(`run-resumed-${this.sends.length}`, { waitResult: { status: "finished", result: "" } });
  }

  close(): void {}
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

type SDKCustomToolLike = {
  execute: (args: Record<string, unknown>, context: { toolCallId: string }) => Promise<unknown>;
};

class HeldToolAgent implements AgentLike {
  readonly agentId: string;
  disposed = false;
  readonly sends: unknown[] = [];
  readonly runs: HeldFakeRun[] = [];
  tools: Record<string, SDKCustomToolLike> | undefined;

  constructor(durable = false) {
    this.agentId = durable ? "agent-held-durable" : "agent-held-stateless";
  }

  attachCreateOptions(options: Record<string, unknown>): void {
    const local = options.local as { customTools?: Record<string, SDKCustomToolLike> } | undefined;
    this.tools = local?.customTools;
  }

  async send(message: unknown, options?: Record<string, unknown>): Promise<HeldFakeRun> {
    // stateless 路径的 customTools 走 send options（sendWithOptionalCustomTools）；durable 路径只在
    // create options 里带、send options 不带——不能让空 send options 把 create 时拿到的 tools 冲掉。
    if (options?.local !== undefined) this.attachCreateOptions(options);
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
  const record = result && typeof result === "object" ? result as { content?: unknown } : undefined;
  const content = record?.content;
  if (!Array.isArray(content)) return String(result);
  return content.map((block) => {
    const item = block && typeof block === "object" ? block as { text?: unknown } : undefined;
    return typeof item?.text === "string" ? item.text : "";
  }).join("");
}
