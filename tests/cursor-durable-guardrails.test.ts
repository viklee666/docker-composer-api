import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorSdkRunner, toolResultsForeignToSlot, type AgentFactory, type AgentLike } from "../src/cursor-runner.js";
import { durableSessionId } from "../src/durable-id.js";
import {
  SessionHub,
  assistantTextDigest,
  createSessionSlot,
  inboundAssistantTextMismatch,
  inboundFreshSessionOnDeliveredSlot,
  inboundHistoryIncompatible,
  markTurnDelivered,
  recordAssistantDigest,
  recordIssuedToolCalls,
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

test("护栏 1：空 userText 不 send、不建槽、不退 stateless（0 create / 0 send / 空 assistant）", async () => {
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
  resetDurableTelemetry();

  const result = await runner.run(baseRun({
    prompt: "Conversation:\nUSER: hi",
    conversationSeed: "seed-empty-guard",
    durableTurn: { kind: "new_user", userText: "", ...FP }
  }));

  // 空轮次静默 noop：模型一个字都不出、agent 不建、槽不增。
  assert.equal(created.length, 0, "不得 create agent");
  assert.equal(result.text, "");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(hub.size, 0, "空轮次守卫发生在 ensureDurableSlot 之前，不留 Hub 槽");
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["reuse:empty_turn_guard"] ?? 0) >= 1,
    "必须留下 empty_turn_guard 打点（且不建 Hub 也照记）"
  );
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

test("护栏 4：kind=empty 静默 noop —— 0 create / 0 send / 空 assistant（不再 400）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-empty-400-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  resetDurableTelemetry();

  // 400 会让客户端重试/打出错误条，空轮更吵；改为静默 200 空 assistant。
  const result = await runner.run(baseRun({
    conversationSeed: "seed-empty-400-message",
    durableTurn: { kind: "empty", ...FP }
  }));

  assert.equal(created.length, 0, "empty 轮不得 create agent");
  assert.equal(result.text, "");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(hub.size, 0);
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["reuse:empty_turn_noop"] ?? 0) >= 1,
    "必须留下 empty_turn_noop 打点"
  );
  await hub.dropAll();
});

test("空轮次收口：已有活槽时空轮不得碰 slot 历史（lastUserText / digest 不变、不重发）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent("agent-empty-live-slot");
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-empty-live-slot";
  const sessionId = sessionHash(seed);

  // 第一轮真问题：建槽、发一次增量、记录 lastUserText 与 digest。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("hello", "reply 1")
  }));
  const slot = hub.get(sessionId);
  assert.ok(slot);
  assert.equal(slot.lastUserText, "hello");

  // 第二轮空轮（empty.json 形状）：上游收不到任何 send，槽历史原样保留。
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: { kind: "empty", assistantDigest: assistantTextDigest("reply 1"), ...FP }
  }));
  assert.equal(agent.sends.length, 1, "空轮不得触发 durable send");
  assert.equal(result.text, "");
  const liveSlot = hub.get(sessionId);
  assert.ok(liveSlot, "空轮不得销毁槽");
  assert.equal(liveSlot.lastUserText, "hello", "空轮不得把 lastUserText 覆盖成占位符");
  assert.equal(liveSlot.lastAssistantDigest, assistantTextDigest("reply 1"));

  // 空轮之后的下一句真问题仍走 durable 增量（没被粘性 stateless）。
  const next = await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurnWithAssistant("follow up", "reply 1")
  }));
  assert.equal(agent.sends.length, 2, "空轮后的真问题仍走 durable 增量 send");
  assert.equal(next.text, "reply 2");
  await hub.dropAll();
});

test("空轮次收口：debug 快照记 empty_turn_noop（对照 empty.json 的 new_user send）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const factory: AgentFactory = { create: async () => new TrackingAgent() };
  const runner = durableRunner(hub, factory);
  const turns: Array<{ channel: string; payload: unknown }> = [];
  await runner.run(baseRun({
    conversationSeed: "seed-empty-noop-debug",
    durableTurn: { kind: "empty", ...FP },
    debugRef: {
      noteUpstreamTurn(channel, payload) {
        turns.push({ channel, payload });
      },
      noteSelectedKey: () => undefined
    }
  }));
  const blocked = turns.find((turn) => (turn.payload as { blocked?: string })?.blocked === "empty_turn_noop");
  assert.ok(blocked, "debug 快照必须能看出空轮被 empty_turn_noop 拦下");
  const payload = blocked!.payload as { kind?: string };
  assert.equal(payload.kind, "empty");
  await hub.dropAll();
});

test("护栏（新鲜会话纯函数）：零 assistant 入站 + 已交付槽 ⇒ 判定外来会话", () => {
  const slot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  // 未交付过的槽（deliveredUserText 缺号）：新会话第一轮落进来是合法的（同 seed 复用），放行。
  assert.equal(inboundFreshSessionOnDeliveredSlot(slot, undefined), false);
  slot.lastUserText = "hello";
  markTurnDelivered(slot);
  // 已交付 + digest 缺号 = 会话 B 的第一轮撞进已交付槽。
  assert.equal(inboundFreshSessionOnDeliveredSlot(slot, undefined), true);
  // 入站带 assistant 摘要的续聊（哪怕分叉）由 digest 比对护栏负责，本护栏不掺和。
  assert.equal(inboundFreshSessionOnDeliveredSlot(slot, assistantTextDigest("any")), false);
});

test("护栏（新鲜会话）：会话 B 首轮撞进已交付槽 ⇒ stateless，槽不动、不串 send", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fresh-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-fresh-session-collision";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  // 会话 A 第一轮：正常 durable，交付 "reply 1"。
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: userTurn("hello from session A")
  }));
  assert.equal(created.length, 1);

  // 会话 B 第一轮（同 seed 碰撞、零 assistant 历史）：不得 send 进 A 的 agent，退 stateless。
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    prompt: "USER: fresh question from session B",
    identitySource: "derived-L3",
    durableTurn: userTurn("fresh question from session B")
  }));
  assert.equal(created.length, 2, "碰撞轮必须走 stateless 新 agent");
  assert.equal(created[0].sends.length, 1, "会话 A 的 durable agent 不得收到 B 的第一轮");
  assert.equal(result.text, "reply 1");
  const slot = hub.get(sessionId);
  assert.ok(slot, "新鲜会话护栏不得销毁槽");
  assert.equal(slot.agent, created[0].agent);
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["fallback:fresh_session"] ?? 0) >= 1,
    "必须留下 fresh_session 打点"
  );

  // 显式 id（header / body-field）的会话不可能碰撞，同形状请求（digest 缺号续聊）不受护栏影响。
  const explicit = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "header",
    durableTurn: userTurn("follow up from the same explicit-id client")
  }));
  assert.equal(created.length, 2, "显式 id 的 digest 缺号续聊不得被误伤");
  assert.equal(created[0].sends.length, 2, "显式 id 续聊照常走 durable 增量 send");
  assert.equal(explicit.text, "reply 2");
  await hub.dropAll();
});

test("护栏（新鲜会话）：Responses 协议 digest 恒缺号，不受本护栏影响", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent("agent-responses-exempt");
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-responses-exempt";
  const sessionId = sessionHash(seed);

  // 第一轮：Responses 形状（无 assistantDigest）正常 durable。
  await runner.run(baseRun({
    conversationSeed: seed,
    protocol: "openai-responses",
    identitySource: "derived-L3",
    durableTurn: userTurn("hello")
  }));
  // 第二轮：Responses 续聊 input 不带 assistant 文本（digest 缺号）。Responses 的身份
  // 走显式 seed 继承，实际不会是 derived-L3；此处用 derived-L3 + 该协议组合验证最坏
  // 情况下也不误伤——协议恒缺 digest，护栏若不豁免该协议会把每轮续聊都打回 stateless。
  const next = await runner.run(baseRun({
    conversationSeed: seed,
    protocol: "openai-responses",
    identitySource: "derived-L3",
    durableTurn: userTurn("follow up")
  }));
  assert.equal(agent.sends.length, 2, "Responses 续聊不得被新鲜会话护栏误伤");
  assert.equal(next.text, "reply 2");
  assert.ok(hub.get(sessionId));
  await hub.dropAll();
});

test("护栏（tool_results 零交集纯函数）：外来 id 全部对不上 ⇒ foreign", () => {
  const slot = createSessionSlot({ agent: dummyAgent(), agentId: "a", apiKey: "k", model: "m" });
  // 槽没发过任何 tool_call（issued/pending 全空）⇒ 无从判定，放行（走既有 400 路径）。
  assert.equal(toolResultsForeignToSlot(slot, [{ id: "call_x" }]), false);
  recordIssuedToolCalls(slot, ["call_mine"]);
  // path B：结果 id 是本槽上一轮发过的（Responses 的 call_ 前缀别名剥掉后同后缀）。
  assert.equal(toolResultsForeignToSlot(slot, [{ id: "call_mine" }]), false);
  assert.equal(toolResultsForeignToSlot(slot, [{ id: "mine" }]), false, "剥 call_ 前缀后同后缀必须命中");
  // 全部外来 ⇒ foreign。
  assert.equal(toolResultsForeignToSlot(slot, [{ id: "call_foreign_1" }, { id: "call_foreign_2" }]), true);
  // 混合（任一命中）⇒ 不是 foreign。
  assert.equal(toolResultsForeignToSlot(slot, [{ id: "call_foreign_1" }, { id: "call_mine" }]), false);
  // 空结果列表不算 foreign（由 empty/duplicate 路径处理）。
  assert.equal(toolResultsForeignToSlot(slot, []), false);
});

test("护栏（tool_results 零交集）：外来工具结果撞进挂起槽 ⇒ stateless 且不 abort 挂起 execute", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: Array<{ agent: HeldToolAgent; durable: boolean }> = [];
  const factory: AgentFactory = {
    create: async (options) => {
      const durable = created.length === 0;
      const agent = new HeldToolAgent(durable);
      if (durable) agent.attachCreateOptions(options);
      created.push({ agent, durable });
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-foreign-tool-results";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  // 会话 A 停在挂起 execute（call_read_1 等结果）。
  await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    identitySource: "derived-L3",
    durableTurn: userTurn("Read README.md")
  }));
  const slot = hub.get(sessionId);
  assert.ok(slot);
  assert.equal(slot.pending.has("call_read_1"), true);
  const durableAgent = created[0].agent;
  const heldRun = durableAgent.runs[0];
  assert.ok(heldRun);

  // 会话 B 的工具结果（id 全部外来）撞进同一个槽：不得 abort 挂起 execute、不得 send。
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    identitySource: "derived-L3",
    prompt: "Conversation:\nUSER: Read README.md",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_from_other_session", content: "other session output" }]
    }
  }));
  assert.equal(heldRun.cancelled, false, "外来工具结果不得 cancel 会话 A 挂起的 run");
  assert.equal(durableAgent.sends.length, 1, "外来工具结果不得触发 durable send");
  const liveSlot = hub.get(sessionId);
  assert.ok(liveSlot, "零交集护栏不得销毁槽");
  assert.equal(liveSlot.pending.has("call_read_1"), true, "挂起 execute 原样保留");
  assert.ok(result.text.length > 0, "stateless 退回也要有完整产出");
  const snapshot = durableTelemetrySnapshot();
  assert.ok(
    (snapshot.decisions["fallback:foreign_tool_results"] ?? 0) >= 1,
    "必须留下 foreign_tool_results 打点"
  );

  // 显式 id 会话的 unmatched tool_results（客户端自身 bug）：不受零交集护栏保护，
  // 走既有 unmatched-abort 路径（行为与改动前一致）。
  const explicitBuggy = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    identitySource: "header",
    prompt: "Conversation:\nUSER: Read README.md",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_buggy_client", content: "client bug result" }]
    }
  }));
  assert.ok(explicitBuggy.text.length > 0, "显式 id 的 unmatched 路径照常工作");
  await hub.dropAll();
});

test("护栏（tool_results 零交集）：本槽 path A 结果正常 resolve，不被误伤", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: Array<{ agent: HeldToolAgent; durable: boolean }> = [];
  const factory: AgentFactory = {
    create: async (options) => {
      const durable = created.length === 0;
      const agent = new HeldToolAgent(durable);
      if (durable) agent.attachCreateOptions(options);
      created.push({ agent, durable });
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-own-tool-results";

  // path A 全链路：挂起 execute → 结果 id 命中 pending → 同一 Run 继续。
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
  assert.equal(created[0].agent.sends.length, 1, "path A 不触发第二次 send（execute resolve 续跑）");
  await hub.dropAll();
});

test("护栏（已交付去重）：SDK 消息级事件重放旧 tool_use ⇒ 不重发 tool_call（快照 7d96afaa 场景）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: Array<{ agent: ReplayToolAgent; durable: boolean }> = [];
  const factory: AgentFactory = {
    create: async (options) => {
      const durable = created.length === 0;
      const agent = new ReplayToolAgent();
      if (durable) agent.attachCreateOptions(options);
      created.push({ agent, durable });
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-issued-tool-dedup";

  // HTTP1：模型发起 Read（call_read_1），停在挂起 execute，客户端拿到一次 tool_call。
  const http1 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: userTurn("Read README.md")
  }));
  assert.equal(http1.toolCalls.length, 1, "HTTP1 交付一次 tool_call");
  assert.equal(http1.toolCalls[0]?.id, "call_read_1");

  // HTTP2：客户端回传结果；SDK 的消息级事件在续跑时整段重放 run 的 assistant 内容
  // （含早前轮次的 tool_use，快照实锤形态）。不得把已交付的 call_read_1 再发一次。
  const http2 = await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "tool_results",
      ...FP,
      toolResults: [{ id: "call_read_1", content: "hello from README" }]
    }
  }));
  assert.ok(http2.text.includes("final answer"), `续跑文本要交付：${http2.text.slice(0, 80)}`);
  assert.equal(http2.toolCalls.length, 0, "重放的旧 tool_use 绝不能第二次交付给客户端（否则客户端重跑工具、结果触发 duplicate_tool_results、模型二次作答）");
  await hub.dropAll();
});

/**
 * 复现快照 7d96afaa 场景的假 agent：execute 挂起（path A），客户端回传结果后续跑时，
 * 消息级 assistant 事件「整段重放」run 的内容——终稿消息里混入早前轮次的 tool_use
 * （与真实 SDK 的累积消息事件同形）。
 */
class ReplayToolAgent implements AgentLike {
  readonly agentId = "agent-replay";
  disposed = false;
  readonly sends: unknown[] = [];
  private tools: Record<string, SDKCustomToolLike> | undefined;

  attachCreateOptions(options: Record<string, unknown>): void {
    const local = options.local as { customTools?: Record<string, SDKCustomToolLike> } | undefined;
    this.tools = local?.customTools;
  }

  async send(message: unknown, options?: Record<string, unknown>): Promise<HeldFakeRun> {
    if (options?.local !== undefined) this.attachCreateOptions(options);
    this.sends.push(message);
    const tools = this.tools;
    const run = new HeldFakeRun();
    run.attach(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "Checking." }] } };
      if (!tools?.Read) throw new Error("ReplayToolAgent expected customTools.Read on create");
      const pending = tools.Read.execute({ file_path: "README.md" }, { toolCallId: "call_read_1" }) as Promise<unknown>;
      yield {
        type: "tool_call",
        toolCall: { id: "call_read_1", name: "Read", arguments: { file_path: "README.md" } }
      };
      await pending;
      // 续跑：终稿 assistant 消息里混入早前轮次的 tool_use（SDK 累积消息事件重放形态）。
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "final answer" },
            { type: "tool_use", id: "call_read_1", name: "Read", input: { file_path: "README.md" } }
          ]
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

/* ---------------------- 碰撞分叉（collision fork） ---------------------- */

test("分叉：同 seed 的输家会话 tool_results → 派生分叉槽（全量首程），后续轮次增量续跑", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fork-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-collision-fork";
  const sessionId = sessionHash(seed);
  resetDurableTelemetry();

  // 会话 A（赢家）第一轮：正常 durable，交付 "reply 1"（纯文本轮；赢家发过工具调用的形态
  // 用 issued 集合模拟——零交集判定需要基础槽有已发过的 id 作证据）。
  await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: userTurn("hello from session A")
  }));
  assert.equal(created.length, 1);
  const winnerSlot = hub.get(sessionId);
  assert.ok(winnerSlot);
  recordIssuedToolCalls(winnerSlot, ["tool_a_winner_1"]);

  // 会话 B（输家）第二轮：tool_results 的 id 来自 B 自己第一轮的 stateless agent → 对基础槽 foreign。
  // lineageToolId = B 的 transcript 里最早的工具 id，分叉键由它派生。
  const bLineage = "tool_b_first_0001";
  const forked = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    prompt: "Conversation:\nUSER: hello\nASSISTANT TOOL_USE: {b}\nTOOL RESULT (b): done\nUSER: continue",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      lineageToolId: bLineage,
      toolResults: [{ id: "tool_b_first_0001", content: "session B tool output" }]
    }
  }));
  // 分叉首程：新建分叉 agent（全量 prompt），不得动 A 的基础槽 agent。
  assert.equal(created.length, 2, "分叉必须新建自己的 agent");
  const baseSlot = hub.get(sessionId);
  assert.ok(baseSlot, "基础槽不得被分叉销毁");
  assert.equal(baseSlot.agent, created[0].agent, "赢家的 agent 原样保留");
  // 全量首程发的是完整 flatten（含历史与工具结果），而不是 path B 的工具结果摘要。
  assert.ok(sendText(created[1].sends[0]).includes("TOOL RESULT (b): done"), "分叉首程必须带完整上下文");
  assert.equal(forked.text, "reply 1");

  // 会话 B 第三轮：同样的 lineage → 命中同一分叉槽，增量续跑（不再 stateless、不再 foreign）。
  const third = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: {
      kind: "tool_results",
      ...FP,
      lineageToolId: bLineage,
      assistantDigest: assistantTextDigest("reply 1"),
      toolResults: [{ id: "tool_b_second_0002", content: "more output" }]
    }
  }));
  assert.equal(created.length, 2, "第三轮必须复用分叉 agent，不再新建");
  assert.equal(created[1].sends.length, 2, "分叉槽增量续跑（第二次 send）");
  assert.equal(third.text, "reply 2");
  // 分叉槽键与基础槽不同，两个会话各归各的。
  const forkSessionId = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/workspace",
    conversationSeed: `${seed}\u0000fork:${bLineage}`
  });
  assert.ok(forkSessionId);
  assert.ok(hub.get(forkSessionId), "分叉槽必须落在 lineage 派生的键上");
  assert.notEqual(forkSessionId, sessionId);
  const snapshot = durableTelemetrySnapshot();
  assert.ok((snapshot.decisions["create:collision_fork"] ?? 0) >= 1, "必须留下 create:collision_fork 打点");
  assert.ok((snapshot.decisions["reuse:collision_fork"] ?? 0) >= 1, "第三轮必须留下 reuse:collision_fork 打点");
  await hub.dropAll();
});

test("分叉（fresh_session 路径）：输家 new_user 且带 lineage → 也走分叉，不再永久 stateless", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fork-new-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-collision-fork-newuser";

  // 赢家第一轮。
  await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: userTurn("hello from winner")
  }));
  assert.equal(created.length, 1);

  // 输家带工具历史的 new_user（fresh_session 护栏会拦）→ 分叉。
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    prompt: "Conversation:\nUSER: task for B",
    durableTurn: {
      kind: "new_user",
      ...FP,
      lineageToolId: "tool_b_lineage_0001",
      userText: "task for B"
    }
  }));
  assert.equal(created.length, 2, "fresh_session + lineage 必须分叉新建，不得退 stateless（那会陷入全量重放循环）");
  assert.ok(result.text.length > 0);
  await hub.dropAll();
});

test("分叉不可递归：分叉槽内再触发护栏 → 退 stateless（同 lineage 不会无限套娃）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fork-deep-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-collision-fork-depth";

  await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: userTurn("winner")
  }));
  const winnerSlot2 = hub.get(sessionHash(seed));
  assert.ok(winnerSlot2);
  recordIssuedToolCalls(winnerSlot2, ["tool_a_w2"]);
  // 输家第一轮：分叉。
  await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    prompt: "Conversation:\nUSER: for B",
    durableTurn: { kind: "tool_results", ...FP, lineageToolId: "tool_b_x", toolResults: [{ id: "tool_b_x", content: "r" }] }
  }));
  assert.equal(created.length, 2);
  // 输家第二轮：分叉槽已在 → 复用（reuse:collision_fork），增量 send。
  const second = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: { kind: "tool_results", ...FP, lineageToolId: "tool_b_x", toolResults: [{ id: "tool_b_y", content: "r2" }] }
  }));
  assert.equal(created.length, 2, "第二轮复用分叉 agent");
  assert.equal(created[1].sends.length, 2, "分叉槽增量");
  assert.ok(second.text.length > 0);
  await hub.dropAll();
});

test("分叉锁：分叉键被占用时退 stateless（基础键的锁保护不到分叉槽）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const created: TrackingAgent[] = [];
  const factory: AgentFactory = {
    create: async () => {
      const agent = new TrackingAgent(`agent-fork-lock-${created.length + 1}`);
      created.push(agent);
      return agent;
    }
  };
  const runner = durableRunner(hub, factory);
  const seed = "seed-fork-lock";
  const lineage = "tool_b_lock_0001";
  resetDurableTelemetry();

  // 赢家占基础槽（并种上 issued 证据，让零交集判定有依据）。
  await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    durableTurn: userTurn("winner")
  }));
  const baseSlot = hub.get(sessionHash(seed));
  assert.ok(baseSlot);
  recordIssuedToolCalls(baseSlot, ["tool_a_lock"]);

  // 手工占住分叉键的锁，模拟同一输家会话的另一条 HTTP 正在跑。
  const forkSessionId = durableSessionId({
    apiKey: "cursor-key",
    model: "composer-2.5",
    workingDirectory: "/workspace",
    conversationSeed: `${seed}\u0000fork:${lineage}`
  });
  assert.ok(forkSessionId);
  const held = await hub.acquire(forkSessionId);

  // new_user 分叉走 tryAcquire → 拿不到锁 → 退 stateless，绝不无锁操作分叉槽。
  const result = await runner.run(baseRun({
    conversationSeed: seed,
    identitySource: "derived-L3",
    prompt: "Conversation:\nUSER: locked out",
    durableTurn: { kind: "new_user", ...FP, lineageToolId: lineage, userText: "locked out" }
  }));
  assert.ok(result.text.length > 0, "拿不到分叉锁也要有完整产出");
  assert.equal(hub.get(forkSessionId), undefined, "锁被占时不得建分叉槽");
  const snapshot = durableTelemetrySnapshot();
  assert.ok((snapshot.decisions["fallback:fork_locked"] ?? 0) >= 1, "必须留下 fallback:fork_locked 打点");
  held();
  await hub.dropAll();
});

test("durable 增量轮次带路径提醒（首程不重复，无工具不加）", async () => {
  // durable 只在首程发 STABLE_DIRECTIVE + 客户端 SYSTEM（含真实 workspace path），
  // 之后每轮只发 userText——模型手边就只剩自己的 cwd（/workspace）可依据，于是拿它拼工具路径。
  // 有工具的增量轮次必须带一句提醒，否则长会话里路径会持续跑偏（实测 Grep{path:"/workspace/src"}）。
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent("agent-path-reminder");
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-path-reminder";

  await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: { kind: "new_user", ...FP, userText: "first question", systemText: "Workspace Path: e:\repo" }
  }));
  const firstSend = sendText(agent.sends[0]);
  assert.match(firstSend, /Do not edit, create, or delete files/, "首程发 STABLE_DIRECTIVE");
  assert.match(firstSend, /Workspace Path: e:\repo/, "首程发客户端 SYSTEM");
  assert.doesNotMatch(firstSend, /Reminder: tool paths belong/, "首程已有完整指令，不重复提醒");

  // 第二轮（增量）：只发 userText + 提醒。
  await runner.run(baseRun({
    conversationSeed: seed,
    tools: [readTool],
    durableTurn: {
      kind: "new_user",
      ...FP,
      userText: "second question",
      assistantDigest: assistantTextDigest("reply 1")
    }
  }));
  const secondSend = sendText(agent.sends[1]);
  assert.match(secondSend, /Reminder: tool paths belong to the caller's workspace/, "增量轮必须带路径提醒");
  assert.match(secondSend, /second question/);
  assert.doesNotMatch(secondSend, /Workspace Path: e:\repo/, "提醒不等于重发 system（那是每轮上万 token）");

  await hub.dropAll();
});

test("durable 无工具的增量轮次不带路径提醒（省 token）", async () => {
  const hub = new SessionHub({ parallelToolSettleMs: 0 });
  const agent = new TrackingAgent("agent-no-tools");
  const factory: AgentFactory = { create: async () => agent };
  const runner = durableRunner(hub, factory);
  const seed = "seed-path-reminder-no-tools";

  await runner.run(baseRun({ conversationSeed: seed, durableTurn: userTurn("first") }));
  await runner.run(baseRun({
    conversationSeed: seed,
    durableTurn: { kind: "new_user", ...FP, userText: "second", assistantDigest: assistantTextDigest("reply 1") }
  }));
  assert.doesNotMatch(sendText(agent.sends[1]), /Reminder: tool paths/, "没有工具就没有路径问题");
  await hub.dropAll();
});
