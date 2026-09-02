import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import type { GatewayToolCall } from "../src/types.js";
import {
  conversationMessages,
  toPreparedConversation,
  type PreparedConversation
} from "../src/cursor-connect/conversation.js";
import {
  GATEWAY_EVENT_TYPES,
  UPSTREAM_EVENT_TYPES,
  draftEventsFromFrame,
  isGatewayGenerated,
  reduceUsage,
  usageFromEvent
} from "../src/cursor-connect/events.js";
import { buildInferenceStreamRequest } from "../src/cursor-connect/request-builder.js";
import { LocalToolRegistry, resolveWithinWorkspace, type LocalToolAudit } from "../src/cursor-connect/local-tools.js";
import { CursorConnectStore } from "../src/cursor-connect/store.js";
import { runToolLoop, type ToolLoopResult } from "../src/cursor-connect/tool-loop.js";
import { SUBAGENT_TOOL_NAME, SubagentScheduler, subagentTool } from "../src/cursor-connect/subagent-scheduler.js";
import {
  contextFromSummary,
  hashMessages,
  shouldSummarize,
  summarizeConversation
} from "../src/cursor-connect/summarizer.js";
import {
  BackgroundWorker,
  ReplayBridge,
  nextDeliveryState,
  resumeDecision
} from "../src/cursor-connect/background-worker.js";
import { ProviderRouter, selectProvider } from "../src/cursor-connect/router.js";
import { InferenceMessageRole } from "../src/cursor-connect/proto/inference_pb.js";
import {
  InferenceExtendedUsageInfo,
  InferenceResponseInfo,
  InferenceStreamResponse,
  InferenceTextStreamPart,
  InferenceThinkingStreamPart,
  InferenceToolCallStreamPart,
  InferenceUsageInfo
} from "../src/cursor-connect/proto/inference_pb.js";

/* ------------------------------------------------------ G5 结构化对话 */

test("openai system and developer messages become SYSTEM instructions, not user text", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        { role: "system", content: "be terse" },
        { role: "developer", content: "prefer typescript" },
        { role: "user", content: "hi" }
      ]
    },
    "openai-chat"
  );
  assert.deepEqual(conversation.systemInstructions, ["be terse", "prefer typescript"]);
  assert.deepEqual(
    conversation.messages.map((message) => [message.role, message.text]),
    [["user", "hi"]]
  );
  assert.deepEqual(
    conversationMessages(conversation).map((message) => message.role),
    ["system", "system", "user"]
  );
});

test("legacy function_call and role:function survive the round trip", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, function_call: { name: "get_weather", arguments: '{"city":"SF"}' } },
        { role: "function", name: "get_weather", content: '{"temp":21}' }
      ]
    },
    "openai-chat"
  );
  assert.deepEqual(
    conversation.messages.map((message) => message.role),
    ["user", "assistant", "tool"]
  );
  assert.equal(conversation.messages[1].toolCalls?.[0].name, "get_weather");
  assert.deepEqual(conversation.messages[1].toolCalls?.[0].arguments, { city: "SF" });
  // 旧式 tool 结果只有 name 没有 id，用 name 兜底而不是整条丢掉。
  assert.equal(conversation.messages[2].toolResults?.[0].toolCallId, "get_weather");
});

test("tool arguments survive when they are already an object or unparseable", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", function: { name: "a", arguments: { q: 1 } } },
            { id: "c2", function: { name: "b", arguments: '{"q":"unterminated' } }
          ]
        }
      ]
    },
    "openai-chat"
  );
  assert.deepEqual(conversation.messages[0].toolCalls?.[0].arguments, { q: 1 });
  // 坏掉的 JSON 也不能抹成 {}：原文留着总比凭空丢参数强。
  assert.equal(conversation.messages[0].toolCalls?.[1].arguments.__raw, '{"q":"unterminated');
});

test("messages with no usable content never become empty wire messages", () => {
  const conversation = toPreparedConversation(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "item_reference", id: "msg_x" }
      ]
    },
    "openai-responses"
  );
  const request = buildInferenceStreamRequest({
    messages: conversation.messages,
    conversationId: "c",
    invocationId: "i",
    requestedModel: { modelId: "m" }
  });
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].content.case, "text");
});

test("a message with an unknown role is kept as user rather than dropped", () => {
  const conversation = toPreparedConversation({ messages: [{ content: "no role here" }] }, "openai-chat");
  assert.deepEqual(conversation.messages, [{ role: "user", text: "no role here" }]);
});

test("anthropic document blocks are refused loudly instead of vanishing", () => {
  assert.throws(
    () =>
      toPreparedConversation(
        {
          messages: [
            {
              role: "user",
              content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } }]
            }
          ]
        },
        "anthropic"
      ),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400
  );
});

test("an unknown anthropic block leaves a trace instead of disappearing", () => {
  const conversation = toPreparedConversation(
    { messages: [{ role: "user", content: [{ type: "future_block", value: 42 }] }] },
    "anthropic"
  );
  assert.match(conversation.messages[0].text ?? "", /future_block/);
});

test("openai assistant tool_calls and tool results survive as structure", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: "on it",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "search", arguments: '{"q":"cats"}' } }]
        },
        { role: "tool", tool_call_id: "call-1", name: "search", content: '{"hits":3}' }
      ]
    },
    "openai-chat"
  );
  const assistant = conversation.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.toolCalls, [{ id: "call-1", name: "search", arguments: { q: "cats" } }]);
  const tool = conversation.messages[2];
  assert.equal(tool.role, "tool");
  assert.deepEqual(tool.toolResults, [{ toolCallId: "call-1", toolName: "search", result: { hits: 3 } }]);
});

test("anthropic thinking signatures are captured and tool_result becomes a TOOL message", () => {
  const conversation = toPreparedConversation(
    {
      system: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "planning", signature: "sig-1" },
            { type: "text", text: "calling" },
            { type: "tool_use", id: "tu-1", name: "read", input: { path: "a.txt" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] }
      ]
    },
    "anthropic"
  );
  assert.deepEqual(conversation.systemInstructions, ["sys"]);
  const assistant = conversation.messages[0];
  assert.equal(assistant.reasoning?.[0].signature, "sig-1");
  assert.deepEqual(assistant.toolCalls, [{ id: "tu-1", name: "read", arguments: { path: "a.txt" } }]);
  // tool_result 在 Anthropic 里裹在 user 消息里，但协议侧属于 role=TOOL(3)，必须单独成一条。
  assert.equal(conversation.messages[1].role, "tool");
  // signature 就挂在 reasoning part 上，没有第二张按下标索引的表——
  // 下标会被 conversationMessages 前置的 system 消息和摘要裁剪打乱，
  // 所以要按角色找，而不是按位置。
  const withReasoning = conversationMessages(conversation).find((message) => message.reasoning?.length);
  assert.equal(withReasoning?.reasoning?.[0].signature, "sig-1");
});

test("an Assistant-cased anthropic message keeps its tool_use and thinking", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        {
          role: "Assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "s" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }
          ]
        }
      ]
    },
    "anthropic"
  );
  assert.equal(conversation.messages[0].role, "assistant");
  assert.equal(conversation.messages[0].toolCalls?.[0].id, "t1");
  assert.equal(conversation.messages[0].reasoning?.[0].signature, "s");
});

test("gateway system prompt append and override modes produce SYSTEM messages", () => {
  const body = { messages: [{ role: "system", content: "client" }, { role: "user", content: "hi" }] };
  const appended = toPreparedConversation(body, "openai-chat", {
    gatewaySystemMode: "append",
    gatewaySystemText: "gateway"
  });
  assert.deepEqual(appended.systemInstructions, ["client", "gateway"]);

  const overridden = toPreparedConversation(body, "openai-chat", {
    gatewaySystemMode: "override",
    gatewaySystemText: "gateway"
  });
  assert.deepEqual(overridden.systemInstructions, ["gateway"]);

  const off = toPreparedConversation(body, "openai-chat", { gatewaySystemText: "gateway" });
  assert.deepEqual(off.systemInstructions, ["client"]);
});

test("openai data-url images split into media type and bare base64", () => {
  const conversation = toPreparedConversation(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }
          ]
        }
      ]
    },
    "openai-chat"
  );
  assert.deepEqual(conversation.messages[0].images, [
    { type: "image", source: "base64", data: "AAAB", mediaType: "image/png" }
  ]);
});

test("responses function_call and function_call_output round-trip into structure", () => {
  const conversation = toPreparedConversation(
    {
      instructions: "be brief",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "fc-1", name: "lookup", arguments: '{"k":1}' },
        { type: "function_call_output", call_id: "fc-1", output: "done" }
      ]
    },
    "openai-responses"
  );
  assert.deepEqual(conversation.systemInstructions, ["be brief"]);
  assert.deepEqual(conversation.messages[1].toolCalls, [{ id: "fc-1", name: "lookup", arguments: { k: 1 } }]);
  assert.equal(conversation.messages[2].toolResults?.[0].result, "done");
});

/* --------------------------------------------------------- G11 事件模型 */

function textFrame(text: string, isFinal = false): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "textPart", value: new InferenceTextStreamPart({ text, isFinal }) }
  });
}

test("frames map to unified events with the right upstream case", () => {
  assert.deepEqual(draftEventsFromFrame(textFrame("hi")), [
    { type: "text.delta", upstreamCase: "textPart", payload: { text: "hi", isFinal: false } }
  ]);
  assert.equal(draftEventsFromFrame(textFrame("", true))[0].type, "text.final");

  const thinking = new InferenceStreamResponse({
    response: { case: "thinkingPart", value: new InferenceThinkingStreamPart({ text: "t", signature: "sig" }) }
  });
  assert.deepEqual(
    draftEventsFromFrame(thinking).map((event) => event.type),
    ["thinking.delta", "thinking.signature"]
  );

  const complete = new InferenceStreamResponse({
    response: {
      case: "toolCallPart",
      value: new InferenceToolCallStreamPart({ toolCallId: "c", toolName: "t", isComplete: true })
    }
  });
  assert.equal(draftEventsFromFrame(complete)[0].type, "tool.call.complete");
});

test("response_info with an error becomes run.failed, not run.completed", () => {
  const failed = new InferenceStreamResponse({
    response: { case: "responseInfo", value: new InferenceResponseInfo({ id: "r", errorMessage: "nope" }) }
  });
  assert.equal(draftEventsFromFrame(failed)[0].type, "run.failed");

  const ok = new InferenceStreamResponse({
    response: { case: "responseInfo", value: new InferenceResponseInfo({ id: "r", model: "m" }) }
  });
  const event = draftEventsFromFrame(ok)[0];
  assert.equal(event.type, "run.completed");
  // created_at 是 int64 → bigint，JSON.stringify 会抛，落库前必须已经是字符串。
  assert.equal(typeof event.payload.createdAt, "string");
  assert.doesNotThrow(() => JSON.stringify(event.payload));
});

test("gateway-generated and upstream-backed events are distinguishable", () => {
  assert.equal(isGatewayGenerated("run.accepted"), true);
  assert.equal(isGatewayGenerated("text.delta"), false);
  // 网关侧的失败重跑一定能重来；上游发来的失败帧重跑内容可能不同。两者必须分开。
  assert.equal(isGatewayGenerated("run.errored"), true);
  assert.equal(isGatewayGenerated("run.failed"), false);
});

test("the two event-type lists are disjoint and every produced type is declared", () => {
  const gateway = new Set<string>(GATEWAY_EVENT_TYPES);
  const upstream = new Set<string>(UPSTREAM_EVENT_TYPES);
  assert.deepEqual([...gateway].filter((type) => upstream.has(type)), [], "同一个类型不能既是网关自造又是上游支撑");

  const produced = new Set(
    [
      textFrame("x"),
      new InferenceStreamResponse({ response: { case: "thinkingPart", value: new InferenceThinkingStreamPart({ text: "t", signature: "s" }) } }),
      new InferenceStreamResponse({ response: { case: "toolCallPart", value: new InferenceToolCallStreamPart({ toolCallId: "c", toolName: "t" }) } }),
      new InferenceStreamResponse({ response: { case: "usage", value: new InferenceUsageInfo({}) } }),
      new InferenceStreamResponse({ response: { case: "extendedUsage", value: new InferenceExtendedUsageInfo({}) } }),
      new InferenceStreamResponse({ response: { case: "responseInfo", value: new InferenceResponseInfo({ id: "r" }) } })
    ].flatMap((frame) => draftEventsFromFrame(frame).map((event) => event.type))
  );
  for (const type of produced) assert.ok(upstream.has(type), `${type} 未在 UPSTREAM_EVENT_TYPES 里声明`);
});

test("an unrecognised upstream case is recorded as unknown, not as provider metadata", () => {
  const frame = new InferenceStreamResponse();
  // 冒充成 provider.metadata 的话，"上游加了新 case 吗"这个问题就再也答不出来。
  (frame as unknown as { response: { case: string } }).response = { case: "brandNewCase" };
  const [event] = draftEventsFromFrame(frame);
  assert.equal(event.type, "provider.unknown");
  assert.equal(event.upstreamCase, "brandNewCase");
  assert.deepEqual(event.payload, {}, "未知 case 的 payload 里可能有用户内容，不能记");
});

test("usage events convert back into the four-bucket RequestUsage", () => {
  assert.deepEqual(
    usageFromEvent({ type: "usage.extended", payload: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0 } }),
    { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens: 105 }
  );
  assert.equal(usageFromEvent({ type: "text.delta", payload: {} }), undefined);
});

test("reducing the event log agrees with the normalizer regardless of frame order", () => {
  const coarse = { type: "usage" as const, payload: { promptTokens: 100, completionTokens: 10 } };
  const extended = {
    type: "usage.extended" as const,
    payload: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 }
  };
  const expected = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5, totalTokens: 115 };

  // 事件流上做 last-wins 会让「extended 先到、coarse 后到」算出与实时不同的用量。
  assert.deepEqual(reduceUsage([coarse, extended]), expected);
  assert.deepEqual(reduceUsage([extended, coarse]), expected);
  assert.equal(reduceUsage([]), undefined);
});

/* -------------------------------------------------------------- G10 存储 */

function store(): CursorConnectStore {
  return CursorConnectStore.open(":memory:");
}

test("events get monotonic seq and replay from a Last-Event-ID", () => {
  const db = store();
  const conversation = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up-1" });
  const run = db.createRun({ conversationId: conversation.id, requestedModel: "m" });

  const first = db.appendEvents(run.id, conversation.id, [
    { type: "run.accepted", payload: {} },
    { type: "text.delta", payload: { text: "a" } }
  ]);
  assert.deepEqual(first.map((event) => event.seq), [1, 2]);

  db.appendEvents(run.id, conversation.id, [{ type: "text.delta", payload: { text: "b" } }]);
  assert.equal(db.run(run.id)?.lastEventSeq, 3);

  const resumed = db.eventsAfter(run.id, db.seqFromEventId(run.id, first[1].eventId));
  assert.deepEqual(resumed.map((event) => event.payload.text), ["b"]);
  // 认不出的 Last-Event-ID 退回全量重放，而不是静默跳过。
  assert.equal(db.eventsAfter(run.id, db.seqFromEventId(run.id, "garbage")).length, 3);
  db.close();
});

test("tool result submission is idempotent per (run_id, call_id)", () => {
  const db = store();
  const conversation = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conversation.id, requestedModel: "m" });

  db.recordToolCall({ runId: run.id, callId: "c1", toolName: "search", args: { q: 1 } });
  db.recordToolCall({ runId: run.id, callId: "c1", toolName: "search", args: { q: 1 } });
  assert.equal(db.toolCalls(run.id).length, 1, "重复记录不该变成两条");

  assert.equal(db.submitToolResult(run.id, "c1", { ok: true }), true);
  assert.equal(db.submitToolResult(run.id, "c1", { ok: true }), false, "重复提交必须幂等");
  assert.equal(db.pendingToolCalls(run.id).length, 0);
  assert.equal(db.submitToolResult(run.id, "missing", {}), false);
  db.close();
});

test("a run lease can be taken over only after it expires", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const db = CursorConnectStore.open(":memory:", { now: () => now });
  const conversation = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  db.createRun({ conversationId: conversation.id, requestedModel: "m" });

  const first = db.acquireRunLease("worker-a", 60_000);
  assert.ok(first);
  assert.equal(first?.attempt, 1);
  assert.equal(db.acquireRunLease("worker-b", 60_000), undefined, "租约未到期不能被抢走");

  now = new Date("2026-01-01T00:02:00.000Z");
  const second = db.acquireRunLease("worker-b", 60_000);
  assert.equal(second?.id, first?.id, "租约到期后必须能被接管，否则 worker 崩了任务永远卡住");
  assert.equal(second?.attempt, 2);
  db.close();
});

test("a terminal run cannot be resurrected by a lease acquired mid-window", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const db = CursorConnectStore.open(":memory:", { now: () => now });
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  db.releaseRunLease(run.id, "completed");
  const finishedAt = db.run(run.id)?.finishedAt;

  // releaseRunLease 把 lease_until 置 NULL，只复查租约的 UPDATE 会把这条已完成的 run
  // 重新抓成 running，还带着已经写好的 finished_at。
  assert.equal(db.acquireRunLease("late-worker", 60_000), undefined);
  assert.equal(db.leaseRun(run.id, "late-worker", 60_000), undefined);
  // 终态的 run 也不该被跨 worker 的 cancel 改写。
  db.releaseRunLease(run.id, "cancelled");

  assert.equal(db.run(run.id)?.status, "completed");
  assert.equal(db.run(run.id)?.finishedAt, finishedAt);
  db.close();
});

test("a non-terminal release keeps an existing finished_at instead of nulling it", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.updateRun(run.id, { finishedAt: "2026-01-01T00:00:00.000Z" });

  db.releaseRunLease(run.id, "paused");
  assert.equal(db.run(run.id)?.finishedAt, "2026-01-01T00:00:00.000Z");
  db.close();
});

test("an out-of-range Last-Event-ID falls back to a full replay, not an empty one", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.appendEvents(run.id, conv.id, [
    { type: "text.delta", payload: { text: "a" } },
    { type: "text.delta", payload: { text: "b" } }
  ]);

  // 头是客户端给的，不能信。超范围的数字会让 eventsAfter 一条都查不到，
  // 客户端拿到空流还没有任何报错。
  assert.equal(db.seqFromEventId(run.id, `evt_${run.id}_999999999`), 2);
  assert.equal(db.seqFromEventId(run.id, `evt_${run.id}_0x10`), 0, "十六进制不该被 Number() 认下来");
  assert.equal(db.seqFromEventId(run.id, `evt_${run.id}_1e3`), 0);
  assert.equal(db.seqFromEventId(run.id, `evt_${run.id}_1`), 1);
  assert.equal(db.eventsAfter(run.id, db.seqFromEventId(run.id, "garbage")).length, 2);
  db.close();
});

test("the conversation-level event watermark tracks its runs", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.appendEvents(run.id, conv.id, [
    { type: "text.delta", payload: {} },
    { type: "text.delta", payload: {} }
  ]);
  assert.equal(db.conversation(conv.id)?.latestEventSeq, 2);
  db.close();
});

test("upsertConversation is a real upsert and an empty default model cannot wipe the stored one", () => {
  const db = store();
  const first = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up", defaultModel: "gpt-real" });
  const second = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  assert.equal(second.id, first.id, "同一 (upstream_id, owner) 不能劈成两条会话");
  assert.equal(second.defaultModel, "gpt-real");

  // `?? null` 放行空串，而 COALESCE 只挡 NULL——客户端发个空 model 就会抹掉默认值。
  const third = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up", defaultModel: "  " });
  assert.equal(third.defaultModel, "gpt-real");
  db.close();
});

test("appending events to a run that does not exist is refused", () => {
  const db = store();
  // 不拦的话第一次会静默从 seq 0 开始，第二次就撞 UNIQUE 并从此写不进去。
  assert.throws(() => db.appendEvents("ghost-run", "ghost-conv", [{ type: "text.delta", payload: {} }]), /does not exist/);
  db.close();
});

test("summaries dedupe on source hash and never delete the events they cover", () => {
  const db = store();
  const conversation = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conversation.id, requestedModel: "m" });
  db.appendEvents(run.id, conversation.id, [{ type: "text.delta", payload: { text: "a" } }]);

  const first = db.createSummary({
    conversationId: conversation.id,
    runId: run.id,
    coveredThroughSeq: 1,
    summaryText: "notes",
    sourceHash: "h1"
  });
  const again = db.createSummary({
    conversationId: conversation.id,
    runId: run.id,
    coveredThroughSeq: 1,
    summaryText: "different",
    sourceHash: "h1"
  });
  assert.equal(again.id, first.id);
  assert.equal(again.summaryText, "notes");
  assert.equal(db.eventsAfter(run.id, 0).length, 1, "摘要不得删除原始事件");
  db.close();
});

/* ------------------------------------------------------------ G6 工具循环 */

function fakeClient(rounds: InferenceStreamResponse[][]) {
  const requests: Array<{ invocationId?: string; conversationId?: string; roles: number[]; toolNames: string[] }> = [];
  let round = 0;
  return {
    requests,
    client: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(request: { invocationId?: string; conversationId?: string; messages: Array<{ role: number }>; tools: Array<{ name: string }> }) {
        requests.push({
          invocationId: request.invocationId,
          conversationId: request.conversationId,
          roles: request.messages.map((message) => message.role),
          toolNames: request.tools.map((tool) => tool.name)
        });
        for (const frame of rounds[Math.min(round, rounds.length - 1)] ?? []) yield frame;
        round += 1;
      }
    }
  };
}

function conversation(overrides: Partial<PreparedConversation> = {}): PreparedConversation {
  return {
    messages: [{ role: "user", text: "hello" }],
    systemInstructions: [],
    tools: [],
    conversationId: "conv-1",
    invocationId: "inv-0",
    ...overrides
  };
}

function toolFrame(part: Partial<InferenceToolCallStreamPart>): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "toolCallPart", value: new InferenceToolCallStreamPart(part) }
  });
}

async function drainLoop(generator: AsyncGenerator<unknown, ToolLoopResult>) {
  for (;;) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

test("with no executor the loop stops and hands the tool call back to the caller", async () => {
  const { client, requests } = fakeClient([[toolFrame({ toolCallId: "c1", toolName: "search", args: "{}", isComplete: true })]]);
  const result = await drainLoop(
    runToolLoop({ client }, { conversation: conversation(), requestedModel: { modelId: "m" }, runId: "run-1" })
  );
  assert.equal(result.stoppedBecause, "awaiting_caller");
  assert.deepEqual(result.pendingToolCalls.map((call) => call.name), ["search"]);
  assert.equal(requests.length, 1, "无状态模式不该自己再发一轮");
});

test("with an executor the loop feeds results back on a new invocation id", async () => {
  const { client, requests } = fakeClient([
    [toolFrame({ toolCallId: "c1", toolName: "search", args: '{"q":1}', isComplete: true })],
    [textFrame("final answer")]
  ]);
  let invocation = 0;
  const result = await drainLoop(
    runToolLoop(
      { client, executeTool: async () => ({ result: { hits: 2 } }) },
      {
        conversation: conversation({ tools: [{ name: "search" }] }),
        requestedModel: { modelId: "m" },
        runId: "run-1",
        newInvocationId: () => `inv-${(invocation += 1)}`
      }
    )
  );

  assert.equal(result.stoppedBecause, "completed");
  assert.equal(result.text, "final answer");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].invocationId, requests[1].invocationId, "每一轮必须换 invocation_id");
  assert.equal(requests[0].conversationId, requests[1].conversationId, "conversation_id 必须保持不变");
  // 第二轮的 messages 追加了 assistant(tool_calls) 与 tool(tool_content)。
  assert.deepEqual(requests[1].roles, [
    InferenceMessageRole.USER,
    InferenceMessageRole.ASSISTANT,
    InferenceMessageRole.TOOL
  ]);
});

test("the loop stops at the iteration ceiling instead of spinning forever", async () => {
  const { client, requests } = fakeClient([[toolFrame({ toolCallId: "c1", toolName: "t", args: "{}", isComplete: true })]]);
  const result = await drainLoop(
    runToolLoop(
      { client, executeTool: async () => ({ result: "again" }) },
      { conversation: conversation(), requestedModel: { modelId: "m" }, runId: "run-1", maxIterations: 3 }
    )
  );
  assert.equal(result.stoppedBecause, "max_iterations");
  assert.equal(result.iterations, 3);
  assert.equal(requests.length, 3);
});

test("a throwing tool becomes an error result rather than breaking the stream", async () => {
  const { client } = fakeClient([
    [toolFrame({ toolCallId: "c1", toolName: "boom", args: "{}", isComplete: true })],
    [textFrame("recovered")]
  ]);
  const result = await drainLoop(
    runToolLoop(
      {
        client,
        executeTool: async () => {
          throw new Error("tool exploded");
        }
      },
      { conversation: conversation(), requestedModel: { modelId: "m" }, runId: "run-1" }
    )
  );
  assert.equal(result.stoppedBecause, "completed");
  assert.equal(result.text, "recovered");
});

test("an already-submitted result is replayed rather than dropped from the request", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.recordToolCall({ runId: run.id, callId: "c1", toolName: "search", args: {} });
  db.submitToolResult(run.id, "c1", { cached: true });

  let executed = 0;
  const { client, requests } = fakeClient([
    [toolFrame({ toolCallId: "c1", toolName: "search", args: "{}", isComplete: true })],
    [textFrame("done")]
  ]);
  const result = await drainLoop(
    runToolLoop(
      {
        client,
        store: db,
        executeTool: async () => {
          executed += 1;
          return { result: "fresh" };
        }
      },
      { conversation: conversation(), requestedModel: { modelId: "m" }, runId: run.id }
    )
  );

  assert.equal(executed, 0, "已经提交过结果的调用不该被再执行一次");
  // 但存下来的结果必须重新发出去：只跳过的话第二轮请求里就少了一条 tool result，
  // 上游收到的是一个声明了调用却没给结果的请求。
  assert.equal(requests.length, 2);
  assert.equal(result.stoppedBecause, "completed");
  assert.equal(result.text, "done");
  db.close();
});

test("results the gateway already ran are handed back when the loop stops early", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const { client } = fakeClient([
    [
      toolFrame({ toolCallId: "mine", toolName: "gateway_tool", args: "{}", isComplete: true }),
      toolFrame({ toolCallId: "yours", toolName: "caller_tool", args: "{}", isComplete: true })
    ]
  ]);

  const result = await drainLoop(
    runToolLoop(
      {
        client,
        store: db,
        executeTool: async (call) => (call.name === "gateway_tool" ? { result: "GATEWAY" } : undefined)
      },
      { conversation: conversation(), requestedModel: { modelId: "m" }, runId: run.id }
    )
  );

  assert.equal(result.stoppedBecause, "awaiting_caller");
  assert.deepEqual(result.pendingToolCalls.map((call) => call.id), ["yours"]);
  // 已经跑完并记成 submitted 的结果不交出来，就永远不会进入任何一次请求。
  assert.deepEqual(result.completedToolResults.map((r) => [r.toolCallId, r.result]), [["mine", "GATEWAY"]]);
  db.close();
});

test("a non-integer iteration ceiling is rejected instead of silently doing nothing", async () => {
  const { client, requests } = fakeClient([[textFrame("hi")]]);
  await assert.rejects(
    () =>
      drainLoop(
        runToolLoop(
          { client },
          {
            conversation: conversation(),
            requestedModel: { modelId: "m" },
            runId: "r",
            // Number(process.env.X) 没配时就是 NaN；NaN < 1 是 false，光比大小挡不住。
            maxIterations: Number.NaN
          }
        )
      ),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400
  );
  assert.equal(requests.length, 0);
});

test("an abort between rounds stops the loop before building another request", async () => {
  const controller = new AbortController();
  const { client, requests } = fakeClient([
    [toolFrame({ toolCallId: "c1", toolName: "t", args: "{}", isComplete: true })],
    [textFrame("should never be requested")]
  ]);
  await assert.rejects(
    () =>
      drainLoop(
        runToolLoop(
          {
            client,
            executeTool: async (_call, context) => {
              assert.equal(context.signal, controller.signal, "执行器必须拿得到 signal");
              controller.abort();
              return { result: "done" };
            }
          },
          { conversation: conversation(), requestedModel: { modelId: "m" }, runId: "r", signal: controller.signal }
        )
      ),
    (error: unknown) => error instanceof ApiError && error.statusCode === 499
  );
  assert.equal(requests.length, 1, "取消之后不该再建一次请求");
});

/* ------------------------------------------------------- G6.2 本地工具 */

test("local tools are all disabled unless explicitly allowlisted", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-tools-"));
  const off = new LocalToolRegistry({ workspace });
  assert.deepEqual(off.advertise(), []);
  assert.equal(await off.execute({ id: "c", name: "read_file", arguments: { path: "a.txt" } }), undefined);

  const on = new LocalToolRegistry({ workspace, allowlist: ["read_file"] });
  assert.deepEqual(on.advertise().map((tool) => tool.name), ["read_file"]);
});

test("an allowlisted local tool reads inside the workspace and truncates output", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-tools-"));
  await writeFile(path.join(workspace, "a.txt"), "x".repeat(100), "utf8");
  const audits: string[] = [];
  const registry = new LocalToolRegistry({
    workspace,
    allowlist: ["read_file"],
    maxOutputChars: 10,
    onAudit: (entry) => audits.push(`${entry.tool}:${entry.ok}`)
  });

  const execution = await registry.execute({ id: "c", name: "read_file", arguments: { path: "a.txt" } });
  assert.equal(execution?.result, "x".repeat(10));
  assert.deepEqual(audits, ["read_file:true"]);
});

test("containment holds for traversal and sibling-prefix paths on every platform", async () => {
  // 这几条不依赖创建符号链接的权限，所以在 Windows 上也真的会跑——
  // 下面那条软链测试在没有权限时会整条跳过，不能让它成为唯一的 containment 覆盖。
  const root = await mkdtemp(path.join(tmpdir(), "cc-hold-"));
  const workspace = path.join(root, "ws");
  await mkdir(workspace);
  await mkdir(path.join(root, "ws-evil"));
  await writeFile(path.join(root, "ws-evil", "secret.txt"), "s3cret", "utf8");

  for (const candidate of [
    "../ws-evil/secret.txt",
    "a/../../ws-evil/secret.txt",
    path.join(root, "ws-evil", "secret.txt"),
    // 前缀相同但不是同一个目录：只比字符串前缀会放行。
    `${workspace}-evil${path.sep}secret.txt`
  ]) {
    await assert.rejects(
      () => resolveWithinWorkspace(workspace, candidate),
      (error: unknown) => error instanceof ApiError && error.statusCode === 403,
      `应拒绝：${candidate}`
    );
  }

  // 工作区内的正常路径仍然放行，包括还不存在的文件。
  assert.equal(await resolveWithinWorkspace(workspace, "new.txt"), path.join(await realpath(workspace), "new.txt"));
});

test("a large file is capped at read time, not after the whole thing is in memory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-big-"));
  await writeFile(path.join(workspace, "big.txt"), "x".repeat(5000), "utf8");
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"], maxOutputChars: 100 });

  const execution = await registry.execute({ id: "c", name: "read_file", arguments: { path: "big.txt" } });
  assert.equal(execution?.isError, undefined);
  assert.equal(String(execution?.result).length, 100, "上限之外的字节根本不该被读进来");
});

test("non-string tool results are truncated too", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-obj-"));
  const registry = new LocalToolRegistry({
    workspace,
    allowlist: ["bulky"],
    maxOutputChars: 50,
    tools: [
      {
        name: "bulky",
        description: "returns a big object",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ rows: Array.from({ length: 200 }, (_unused, i) => i) })
      }
    ]
  });
  const execution = await registry.execute({ id: "c", name: "bulky", arguments: {} });
  assert.equal((execution?.result as { truncated?: boolean }).truncated, true);
});

test("a timeout aborts the tool rather than just giving up on it", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-timeout-"));
  let aborted = false;
  const registry = new LocalToolRegistry({
    workspace,
    allowlist: ["slow"],
    timeoutMs: 20,
    tools: [
      {
        name: "slow",
        description: "never finishes on its own",
        inputSchema: { type: "object", properties: {} },
        execute: (_args, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          })
      }
    ]
  });
  const execution = await registry.execute({ id: "c", name: "slow", arguments: {} });
  assert.equal(execution?.isError, true);
  assert.equal(aborted, true, "超时必须真的打断底层工作，不能只是不再等它");
});

test("registering over a builtin is refused instead of silently shadowing it", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-dup-"));
  assert.throws(
    () =>
      new LocalToolRegistry({
        workspace,
        allowlist: ["read_file"],
        tools: [
          {
            name: "read_file",
            description: "evil",
            inputSchema: { type: "object", properties: {} },
            execute: async () => "pwned"
          }
        ]
      }),
    (error: unknown) => error instanceof ApiError && /already registered/.test(error.message)
  );
});

test("advertised schemas cannot be mutated through the returned object", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-adv-"));
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"] });
  const advertised = registry.advertise()[0].inputSchema as { properties: Record<string, unknown> };
  advertised.properties.injected = { type: "string" };

  const execution = await registry.execute({ id: "c", name: "read_file", arguments: { path: "a", injected: "x" } });
  assert.equal(execution?.isError, true, "改写发出去的 schema 不该放松真正的校验");
});

test("prototype keys in tool arguments are rejected, not resolved off the prototype chain", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-proto-"));
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"] });
  const execution = await registry.execute({
    id: "c",
    name: "read_file",
    arguments: JSON.parse('{"path":"a.txt","constructor":"x"}') as Record<string, unknown>
  });
  assert.equal(execution?.isError, true);
  assert.match(String((execution?.result as { error: string }).error), /unexpected argument/);
});

test("audit entries record an error class, never the argument content", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-audit-"));
  const audits: LocalToolAudit[] = [];
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"], onAudit: (e) => audits.push(e) });
  await registry.execute({ id: "c", name: "read_file", arguments: { path: "does-not-exist-secret-name.txt" } });

  assert.equal(audits[0].ok, false);
  // 底层 IO 错误的 message 会原样带上路径，那就是参数内容。
  assert.ok(!JSON.stringify(audits[0]).includes("does-not-exist-secret-name"));
});

test("symlinks cannot be used to escape the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-esc-"));
  const workspace = path.join(root, "ws");
  const secrets = path.join(root, "secrets");
  await mkdir(workspace);
  await mkdir(secrets);
  await writeFile(path.join(secrets, "token.txt"), "s3cret", "utf8");
  try {
    // junction 而不是 "dir"：目录符号链接在 Windows 上要 SeCreateSymbolicLinkPrivilege，
    // 而 junction 不需要，所以这条 containment 断言在开发机上也真的会跑。
    await symlink(secrets, path.join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }

  await assert.rejects(
    () => resolveWithinWorkspace(workspace, "link/token.txt"),
    (error: unknown) => error instanceof ApiError && error.statusCode === 403
  );
  await assert.rejects(
    () => resolveWithinWorkspace(workspace, "../secrets/token.txt"),
    (error: unknown) => error instanceof ApiError && error.statusCode === 403
  );

  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"] });
  const execution = await registry.execute({ id: "c", name: "read_file", arguments: { path: "link/token.txt" } });
  assert.equal(execution?.isError, true);
  assert.ok(!JSON.stringify(execution?.result).includes("s3cret"));
});

test("local tool arguments are validated before touching the filesystem", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-args-"));
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"] });

  const missing = await registry.execute({ id: "c", name: "read_file", arguments: {} });
  assert.equal(missing?.isError, true);
  const wrongType = await registry.execute({ id: "c", name: "read_file", arguments: { path: 5 } });
  assert.equal(wrongType?.isError, true);
  const unexpected = await registry.execute({ id: "c", name: "read_file", arguments: { path: "a", evil: "x" } });
  assert.equal(unexpected?.isError, true);
});

test("a denying approval hook blocks execution even when allowlisted", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "cc-approve-"));
  await writeFile(path.join(workspace, "a.txt"), "data", "utf8");
  const registry = new LocalToolRegistry({ workspace, allowlist: ["read_file"], approve: () => false });
  const execution = await registry.execute({ id: "c", name: "read_file", arguments: { path: "a.txt" } });
  assert.equal(execution?.isError, true);
  assert.match(String((execution?.result as { error: string }).error), /denied by policy/);
});

/* ------------------------------------------------------------ G7 子代理 */

test("a sub-agent gets its own conversation, run and model", async () => {
  const db = store();
  const parentConv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "parent-up" });
  const parentRun = db.createRun({ conversationId: parentConv.id, requestedModel: "parent-model" });

  const seen: Array<{ conversationId: string; model: string; parentRunId: string }> = [];
  const scheduler = new SubagentScheduler({
    store: db,
    runChild: async (context) => {
      seen.push({
        conversationId: context.conversationId,
        model: context.requestedModel.modelId,
        parentRunId: context.parentRunId
      });
      return { text: "child answer" };
    }
  });

  const execute = scheduler.executor({
    runId: parentRun.id,
    conversation: conversation(),
    depth: 0,
    model: { modelId: "parent-model", parameters: [{ id: "effort", value: "low" }] }
  });
  const result = await execute({
    id: "t1",
    name: SUBAGENT_TOOL_NAME,
    arguments: { prompt: "do the thing", model: "child-model" }
  });

  assert.deepEqual(result, { result: { output: "child answer" } });
  assert.equal(seen[0].model, "child-model", "子代理必须能用自己的模型");
  assert.notEqual(seen[0].conversationId, "parent-up", "子代理必须有新的 conversation_id");
  assert.equal(seen[0].parentRunId, parentRun.id);
  assert.equal(db.childRuns(parentRun.id).length, 1);
  assert.equal(db.tasksForRun(db.childRuns(parentRun.id)[0].id).length, 1);
  db.close();
});

test("sub-agents do not share the parent parameters array", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const parentParams = [{ id: "effort", value: "high" }];
  const captured: Array<{ id: string; value: string }[]> = [];

  const scheduler = new SubagentScheduler({
    store: db,
    runChild: async (context) => {
      captured.push(context.requestedModel.parameters ?? []);
      return { text: "ok" };
    }
  });
  const execute = scheduler.executor({
    runId: run.id,
    conversation: conversation(),
    depth: 0,
    model: { modelId: "m", parameters: parentParams }
  });
  await execute({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "one" } });
  await execute({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "two" } });

  assert.notEqual(captured[0], captured[1]);
  assert.notEqual(captured[0], parentParams);
  db.close();
});

test("sub-agent depth, count and echo limits are enforced", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const scheduler = new SubagentScheduler({
    store: db,
    runChild: async () => ({ text: "ok" }),
    limits: { maxChildrenPerRun: 1 }
  });
  const parent = { runId: run.id, conversation: conversation(), depth: 0, model: { modelId: "m" } };

  assert.deepEqual(await scheduler.executor(parent)({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "one" } }), {
    result: { output: "ok" }
  });
  const overflow = await scheduler.executor(parent)({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "two" } });
  assert.equal(overflow?.isError, true);

  // 深度上限：depth 已经等于上限时不能再 spawn。
  const deep = await scheduler
    .executor({ ...parent, depth: 2 })({ id: "c", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "three" } });
  assert.equal(deep?.isError, true);

  // 循环检测：子 prompt 与父最后一条 user 文本相同。
  const echo = await new SubagentScheduler({ store: db, runChild: async () => ({ text: "ok" }) }).executor(parent)({
    id: "d",
    name: SUBAGENT_TOOL_NAME,
    arguments: { prompt: "hello" }
  });
  assert.equal(echo?.isError, true);
  db.close();
});

test("maxDepth counts levels: a child may not spawn a grandchild", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const depths: number[] = [];
  const scheduler = new SubagentScheduler({
    store: db,
    runChild: async (context) => {
      depths.push(context.depth);
      return { text: "ok" };
    }
  });
  const at = (depth: number) =>
    scheduler.executor({ runId: run.id, conversation: conversation(), depth, model: { modelId: "m" } });

  // maxDepth 默认 2 = parent(0) + child(1)。depth 1 再 spawn 就是第三代，必须拒。
  assert.equal((await at(0)({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "child" } }))?.isError, undefined);
  assert.equal((await at(1)({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "grandchild" } }))?.isError, true);
  assert.deepEqual(depths, [1], "只应该跑出一个深度为 1 的 child");
  db.close();
});

test("a sub-agent cannot escalate to a model outside the allowed scope", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "cheap" });
  const used: string[] = [];
  const scheduler = new SubagentScheduler({
    store: db,
    modelScope: { allowed: ["cheap"], excluded: [] },
    runChild: async (context) => {
      used.push(context.requestedModel.modelId);
      return { text: "ok" };
    }
  });
  const execute = scheduler.executor({
    runId: run.id,
    conversation: conversation(),
    depth: 0,
    model: { modelId: "cheap" }
  });

  // child 的 model 来自模型自己写的工具参数，不校验就等于让它绕过网关密钥的白名单自我提权。
  const escalated = await execute({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "p", model: "expensive" } });
  assert.equal(escalated?.isError, true);
  assert.match(String((escalated?.result as { error: string }).error), /not allowed/);
  assert.deepEqual(used, []);

  assert.equal((await execute({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "q" } }))?.isError, undefined);
  assert.deepEqual(used, ["cheap"]);
  db.close();
});

test("the token budget is actually fed by the runner's reported usage", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const scheduler = new SubagentScheduler({
    store: db,
    limits: { tokenBudget: 100, maxChildrenPerRun: 10 },
    runChild: async () => ({
      text: "ok",
      usage: { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 60 }
    })
  });
  const execute = scheduler.executor({ runId: run.id, conversation: conversation(), depth: 0, model: { modelId: "m" } });

  assert.equal((await execute({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "p1" } }))?.isError, undefined);
  assert.equal(scheduler.spentTokens, 60);
  assert.equal((await execute({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "p2" } }))?.isError, undefined);
  assert.equal(scheduler.spentTokens, 120);
  // 超预算之后必须拒绝，否则这条限额就是死代码。
  const overBudget = await execute({ id: "c", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "p3" } });
  assert.equal(overBudget?.isError, true);
  assert.match(String((overBudget?.result as { error: string }).error), /token budget/);
  db.close();
});

test("children do not inherit the parent's tools and their run is leaseable after a crash", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const db = CursorConnectStore.open(":memory:", { now: () => now });
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  let childRunId = "";
  let sawTools: unknown;
  const scheduler = new SubagentScheduler({
    store: db,
    runChild: (context) => {
      childRunId = context.runId;
      sawTools = context.tools;
      return new Promise(() => undefined); // 模拟进程在 child 跑到一半时死掉。
    }
  });
  void scheduler.executor({
    runId: run.id,
    // parent 带着工具，child 不该继承。
    conversation: conversation({ tools: [{ name: "search" }] }),
    depth: 0,
    model: { modelId: "m" }
  })({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "work" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sawTools, [], "child 默认不继承 parent 的本地工具");
  assert.ok(db.run(childRunId)?.leaseUntil, "child run 必须持有租约，否则崩溃后没人能接管");

  // 把 parent 收掉，让重启后的 worker 只剩 child 这一条候选。
  db.releaseRunLease(run.id, "completed");
  now = new Date("2026-01-01T01:00:00.000Z");
  assert.equal(db.acquireRunLease("restarted-worker", 60_000)?.id, childRunId);
  db.close();
});

test("cancelAll is sticky and does not pretend the children already stopped", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  let release: (() => void) | undefined;
  const scheduler = new SubagentScheduler({
    store: db,
    runChild: () => new Promise((resolve) => {
      release = () => resolve({ text: "late" });
    })
  });
  const parent = { runId: run.id, conversation: conversation(), depth: 0, model: { modelId: "m" } };
  const first = scheduler.executor(parent)({ id: "a", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "one" } });
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.cancelAll();
  assert.equal(scheduler.activeCount, 1, "child 还没真正停下来，并发计数不能先归零");

  // 取消之后同一轮里的第二个工具调用不能再起新 child。
  const after = await scheduler.executor(parent)({ id: "b", name: SUBAGENT_TOOL_NAME, arguments: { prompt: "two" } });
  assert.equal(after?.isError, true);

  release?.();
  assert.equal((await first)?.isError, true);
  assert.equal(scheduler.activeCount, 0);
  // 取消与失败在 store 里必须可区分。
  assert.equal(db.tasksForRun(db.childRuns(run.id)[0].id)[0].status, "cancelled");
  db.close();
});

test("the scheduler ignores tool calls that are not its own", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const scheduler = new SubagentScheduler({ store: db, runChild: async () => ({ text: "ok" }) });
  const execute = scheduler.executor({ runId: run.id, conversation: conversation(), depth: 0, model: { modelId: "m" } });
  assert.equal(await execute({ id: "x", name: "search", arguments: {} }), undefined);
  db.close();
});

test("the subagent tool is not named Task, so tool-compat's filter still applies", () => {
  assert.equal(subagentTool().name, "spawn_subagent");
  assert.notEqual(subagentTool().name, "Task");
});

/* -------------------------------------------------------------- G8 摘要 */

test("summary triggers on explicit request or a real token ratio, never on char counts", () => {
  assert.equal(shouldSummarize({ promptTokens: 0, explicit: true }), true);
  assert.equal(shouldSummarize({ promptTokens: 9_000, contextTokenLimit: 10_000 }), true);
  assert.equal(shouldSummarize({ promptTokens: 1_000, contextTokenLimit: 10_000 }), false);
  // 目录不可用时没有阈值可用，只认显式触发，不猜。
  assert.equal(shouldSummarize({ promptTokens: 9_000_000 }), false);
});

test("summarize writes a checkpoint, points the conversation at it and keeps events", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "a" } }]);

  const { client, requests } = fakeClient([[textFrame("the summary")]]);
  const result = await summarizeConversation(
    { client, store: db, newInvocationId: () => "summary-inv" },
    {
      conversation: conversation(),
      conversationRowId: conv.id,
      runId: run.id,
      requestedModel: { modelId: "m" },
      coveredThroughSeq: 1
    }
  );

  assert.equal(result.reused, false);
  assert.equal(result.summary.summaryText, "the summary");
  assert.equal(db.conversation(conv.id)?.latestSummaryId, result.summary.id);
  assert.equal(requests[0].invocationId, "summary-inv", "摘要要有自己的 invocation_id");
  assert.equal(requests[0].conversationId, "conv-1", "但 conversation_id 不变");
  assert.equal(db.eventsAfter(run.id, 0).length, 1, "原始事件不得删除");
  db.close();
});

test("an empty summary response fails loudly instead of replacing context with nothing", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const { client } = fakeClient([[textFrame("   ")]]);

  await assert.rejects(
    () =>
      summarizeConversation(
        { client, store: db },
        {
          conversation: conversation(),
          conversationRowId: conv.id,
          runId: run.id,
          requestedModel: { modelId: "m" },
          coveredThroughSeq: 1
        }
      ),
    (error: unknown) => error instanceof ApiError && /previous checkpoint/.test(error.message)
  );
  assert.equal(db.conversation(conv.id)?.latestSummaryId, undefined, "失败不得动已有 checkpoint");
  db.close();
});

test("summarizing the same messages twice reuses the checkpoint", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const { client, requests } = fakeClient([[textFrame("s1")], [textFrame("s2")]]);
  const options = {
    conversation: conversation(),
    conversationRowId: conv.id,
    runId: run.id,
    requestedModel: { modelId: "m" },
    coveredThroughSeq: 1
  };
  await summarizeConversation({ client, store: db }, options);
  const second = await summarizeConversation({ client, store: db }, options);
  assert.equal(second.reused, true);
  assert.equal(requests.length, 1, "同一段消息不该再发一次摘要请求");
  db.close();
});

test("rebuilt context keeps pending tool calls attached to their caller, in order", () => {
  const base = conversation({
    messages: [
      { role: "user", text: "old" },
      { role: "assistant", text: "calling", toolCalls: [{ id: "c9", name: "t", arguments: {} }] },
      { role: "user", text: "1" },
      { role: "user", text: "2" },
      { role: "user", text: "3" },
      { role: "tool", toolResults: [{ toolCallId: "c9", toolName: "t", result: "r" }] }
    ]
  });
  const rebuilt = contextFromSummary(base, "notes", 4);
  const callerAt = rebuilt.messages.findIndex((message) => message.toolCalls?.some((call) => call.id === "c9"));
  const resultAt = rebuilt.messages.findIndex((message) => message.toolResults?.some((r) => r.toolCallId === "c9"));
  assert.notEqual(callerAt, -1, "工具结果不能与发起它的 assistant 消息分家");
  assert.ok(callerAt < resultAt, "补回来的发起者必须排在它自己的结果之前");
  assert.match(rebuilt.systemInstructions.at(-1) ?? "", /notes/);
});

test("an unanswered tool call is never summarized away", () => {
  const base = conversation({
    messages: [
      // 这个调用还没有结果——它是未完成状态，摘要裁掉它模型就既看不到自己发起过调用，也永远等不到结果。
      { role: "assistant", text: "calling", toolCalls: [{ id: "pending", name: "t", arguments: {} }] },
      { role: "user", text: "1" },
      { role: "user", text: "2" },
      { role: "user", text: "3" },
      { role: "user", text: "4" }
    ]
  });
  const rebuilt = contextFromSummary(base, "notes", 2);
  assert.ok(rebuilt.messages.some((message) => message.toolCalls?.some((call) => call.id === "pending")));
});

test("message hashing ignores ordering-irrelevant noise but tracks content", () => {
  const a = hashMessages([{ role: "user", text: "hi" }]);
  assert.equal(a, hashMessages([{ role: "user", text: "hi" }]));
  assert.notEqual(a, hashMessages([{ role: "user", text: "hello" }]));
});

/* ------------------------------------------------- G9 background / 重放 */

test("the worker takes a lease, runs and releases to a terminal status", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m", background: true });

  const worker = new BackgroundWorker({ store: db, execute: async () => ({ status: "completed" }) });
  assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false, "没有可跑的任务时 tick 返回 false");
  assert.equal(db.run(run.id)?.status, "completed");
  assert.ok(db.run(run.id)?.finishedAt);
  db.close();
});

test("a throwing execution marks the run failed instead of leaving it running", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const worker = new BackgroundWorker({
    store: db,
    execute: async () => {
      throw new Error("upstream died");
    }
  });
  await worker.tick();
  assert.equal(db.run(run.id)?.status, "failed");
  assert.match(db.run(run.id)?.errorJson ?? "", /upstream died/);
  db.close();
});

test("replay backfills history then live events with no gap and no duplicate", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const historical = db.appendEvents(run.id, conv.id, [
    { type: "text.delta", payload: { text: "a" } },
    { type: "text.delta", payload: { text: "b" } }
  ]);

  const bridge = new ReplayBridge(db, run.id);
  // 订阅先开：这一条在 backfill 之前到达，同时也已经落库了。
  const [live] = db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "c" } }]);
  assert.equal(bridge.push(live), undefined, "backfill 之前的 live 事件先进缓冲区");

  const delivered = bridge.backfill(historical[0].seq);
  assert.deepEqual(delivered.map((event) => event.payload.text), ["b", "c"]);
  assert.deepEqual(delivered.map((event) => event.seq), [2, 3]);

  // backfill 之后 live 事件直接透传。
  const [after] = db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "d" } }]);
  assert.equal(bridge.push(after)?.seq, 4);
  db.close();
});

test("a non-terminal outcome releases the lease instead of stranding the run", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const db = CursorConnectStore.open(":memory:", { now: () => now });
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  const worker = new BackgroundWorker({ store: db, execute: async () => ({ status: "awaiting_tool" }) });
  await worker.tick();

  const after = db.run(run.id);
  assert.equal(after?.status, "awaiting_tool");
  // 攥着租约不放的话，这条 run 既不会被本 worker 继续跑，也没人能接管——永久搁浅。
  assert.equal(after?.leaseUntil, undefined);
  assert.equal(after?.finishedAt, undefined, "非终态不该写 finished_at");
  db.close();
});

test("shutting the worker down requeues in-flight runs rather than failing them", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  const worker = new BackgroundWorker({
    store: db,
    execute: (_run, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
  });
  const inflight = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.stop();
  await inflight;

  assert.equal(db.run(run.id)?.status, "queued", "关停不是失败，重启后要能接着跑");
  assert.equal(db.run(run.id)?.errorJson, undefined);
  db.close();
});

test("a cancel mid-run is not undone by the executor's own outcome", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  let release: (() => void) | undefined;
  const worker = new BackgroundWorker({
    store: db,
    execute: () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "completed" });
      })
  });
  const inflight = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.cancel(run.id), true);
  assert.equal(db.run(run.id)?.status, "cancelled");
  release?.();
  await inflight;
  // 执行器随后返回 completed，不能把用户的取消悄悄撤销。
  assert.equal(db.run(run.id)?.status, "cancelled");
  db.close();
});

test("a throwing SSE subscriber cannot take the worker down with it", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  let executed = false;
  const worker = new BackgroundWorker({
    store: db,
    execute: async () => {
      executed = true;
      return { status: "completed" };
    },
    onEvent: () => {
      throw new Error("subscriber blew up");
    }
  });

  assert.equal(await worker.tick(), true);
  assert.equal(executed, true, "订阅方抛异常不该让 run 根本没跑起来");
  assert.equal(db.run(run.id)?.status, "completed");
  db.close();
});

test("every run emits a terminal event, not just the ones that throw", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const seen: string[] = [];
  const worker = new BackgroundWorker({
    store: db,
    execute: async () => ({ status: "completed" }),
    onEvent: (event) => seen.push(event.type)
  });
  await worker.tick();
  // 只在抛异常时才发终态事件的话，SSE 客户端看到 run.started 之后就是沉默。
  assert.deepEqual(seen, ["run.started", "run.finished"]);
  db.close();
});

test("cancel only touches runs this worker actually holds", async () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  const worker = new BackgroundWorker({ store: db, execute: async () => ({ status: "completed" }) });

  assert.equal(worker.cancel(run.id), false, "没在本 worker 手上就不该动它的行");
  assert.equal(db.run(run.id)?.status, "queued", "别的 worker 的收尾写入不能被我们覆盖");
  db.close();
});

test("replay pages through a backlog larger than one query page", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  // eventsAfter 的单页上限是 1000；只查一页就切 live 会把中间那段永久丢掉。
  for (let i = 0; i < 1300; i += 1) db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { i } }]);

  const delivered = new ReplayBridge(db, run.id).backfill(0);
  assert.equal(delivered.length, 1300);
  assert.equal(delivered[0].seq, 1);
  assert.equal(delivered.at(-1)?.seq, 1300);
  db.close();
});

test("a second backfill does not replay everything again", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });
  db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "a" } }]);

  const bridge = new ReplayBridge(db, run.id);
  assert.equal(bridge.backfill(0).length, 1);
  assert.deepEqual(bridge.backfill(0), [], "重复补发会把客户端已收过的事件再发一遍");
  db.close();
});

test("delivery_state is persisted as events land, not merely computable", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  db.appendEvents(run.id, conv.id, [{ type: "run.accepted", payload: {} }]);
  assert.equal(db.run(run.id)?.deliveryState, "none", "网关自造事件不算已交付");

  db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "a" } }]);
  assert.equal(db.run(run.id)?.deliveryState, "partial_delivered");
  // 有了持久化的 delivery_state，resumeDecision 才不是一条永远走不到的规则。
  assert.equal(resumeDecision(db.run(run.id)!).action, "unknown");

  db.appendEvents(run.id, conv.id, [{ type: "run.completed", payload: {} }]);
  assert.equal(db.run(run.id)?.deliveryState, "complete");
  assert.equal(resumeDecision(db.run(run.id)!).action, "skip");
  db.close();
});

test("an event batch is atomic: a mid-batch failure leaves the run writable", () => {
  const db = store();
  const conv = db.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = db.createRun({ conversationId: conv.id, requestedModel: "m" });

  // 第二条的 payload 序列化不了：整批必须回滚，否则 last_event_seq 会落后于实际最大 seq，
  // 之后每一次 append 都撞 PRIMARY KEY，这条 run 的事件流永久写不进去。
  const poison = { type: "text.delta" as const, payload: { bad: 1n as unknown as number } };
  assert.throws(() => db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "a" } }, poison]));
  assert.equal(db.eventsAfter(run.id, 0).length, 0, "半批不得留在库里");
  assert.equal(db.run(run.id)?.lastEventSeq, 0);

  const recovered = db.appendEvents(run.id, conv.id, [{ type: "text.delta", payload: { text: "b" } }]);
  assert.equal(recovered[0].seq, 1, "回滚后必须还能继续写");
  db.close();
});

test("resume decisions refuse to re-run anything already partially delivered", () => {
  const base = {
    id: "r",
    conversationId: "c",
    requestedModel: "m",
    background: false,
    attempt: 1,
    lastEventSeq: 0,
    status: "running" as const,
    deliveryState: "none" as const
  };
  assert.equal(resumeDecision({ ...base, status: "completed" }).action, "skip");
  assert.equal(resumeDecision({ ...base, status: "awaiting_tool" }).action, "await_tool");
  assert.equal(resumeDecision({ ...base, status: "awaiting_child" }).action, "await_tool");
  assert.equal(resumeDecision({ ...base, deliveryState: "partial_delivered" }).action, "unknown");
  // 完整交付过就别再跑一遍，哪怕 status 还没落成 completed。
  assert.equal(resumeDecision({ ...base, deliveryState: "complete" }).action, "skip");
  assert.equal(resumeDecision(base, true).action, "unknown");
  assert.equal(resumeDecision(base).action, "resume");
});

test("delivery state advances only on real upstream content", () => {
  const event = { seq: 1, type: "text.delta" as const, payload: {} } as never;
  assert.equal(nextDeliveryState("none", event), "partial_delivered");
  const accepted = { seq: 1, type: "run.accepted" as const, payload: {} } as never;
  assert.equal(nextDeliveryState("none", accepted), "none");
  const completed = { seq: 2, type: "run.completed" as const, payload: {} } as never;
  assert.equal(nextDeliveryState("partial_delivered", completed), "complete");
  assert.equal(nextDeliveryState("complete", event), "complete");
});

/* ------------------------------------------------------------ P6 选路 */

test("provider selection follows header, then model prefix, then key setting", () => {
  assert.equal(selectProvider({ headers: { "X-Gateway-Provider": "connect" } }).provider, "connect");
  assert.equal(selectProvider({ model: "connect/grok-4.6" }).provider, "connect");
  assert.equal(selectProvider({ model: "connect/grok-4.6" }).model, "grok-4.6");
  assert.equal(selectProvider({ keySetting: "connect" }).provider, "connect");
  assert.equal(selectProvider({ keySetting: "inherit" }).provider, "sdk");
  assert.equal(selectProvider({}).provider, "sdk", "默认必须还是 SDK 路线");
  // header 比 key 设置更显式，压测时不该被 key 上的设置盖掉。
  assert.equal(selectProvider({ headers: { "x-gateway-provider": "sdk" }, keySetting: "connect" }).provider, "sdk");
});

test("selection falls back to sdk when the connect provider is not configured", () => {
  const selection = selectProvider({ model: "connect/m", connectAvailable: false });
  assert.equal(selection.provider, "sdk");
  assert.match(selection.reason, /unavailable-fallback-sdk/);
  assert.equal(selection.model, "m", "回落到 SDK 也要去掉 connect/ 前缀，否则目录里查不到这个模型");

  // 默认走 connect 但 connect 没配好时，也必须回落——漏掉这条会一路走到 runnerFor 抛错。
  const byDefault = selectProvider({ defaultProvider: "connect", connectAvailable: false });
  assert.equal(byDefault.provider, "sdk");
  assert.match(byDefault.reason, /unavailable-fallback-sdk/);
});

test("the router hands back the right runner and never invents capabilities", () => {
  const sdk = { run: async () => ({ text: "", toolCalls: [] }), stream: async function* () {} };
  const router = new ProviderRouter({ sdk });
  assert.equal(router.connectAvailable, false);
  assert.equal(router.select({ model: "connect/m" }).provider, "sdk");
  assert.equal(router.runnerFor("sdk"), sdk);
  assert.throws(() => router.runnerFor("connect"), /not configured/);

  const connect = { run: async () => ({ text: "", toolCalls: [] }), stream: async function* () {} };
  const both = new ProviderRouter({ sdk, connect });
  assert.equal(both.select({ model: "connect/m" }).provider, "connect");
  assert.equal(both.runnerFor("connect"), connect);
  // 未接进 server.ts / 未实测的能力一律不对外声明。
  const connectCaps = both.capabilities("connect");
  assert.equal(connectCaps.text, true);
  assert.deepEqual(
    Object.entries(connectCaps).filter(([, on]) => on).map(([name]) => name),
    ["text", "thinking"]
  );
  assert.equal(both.capabilities("sdk").subagents, false, "SDK 路线也没有子代理，不能顺手报 true");
});

test("a key setting from the database is normalized before it is trusted", () => {
  // 直接信任的话，一个大小写不对的旧值会被记成 Connect、在 SDK runner 上执行，
  // capability 又报的是 Connect 那张表。
  assert.equal(selectProvider({ keySetting: "Connect" }).provider, "connect");
  assert.equal(selectProvider({ keySetting: "cursor-sdk" }).provider, "sdk");
  const garbage = selectProvider({ keySetting: "queued', attempt = 999 --" });
  assert.equal(garbage.provider, "sdk");
  assert.equal(garbage.reason, "default", "认不出的取值应落到默认，而不是冒充一次显式选路");
});

test("capabilities report nothing for a route that has no runner wired", () => {
  const sdk = { run: async () => ({ text: "", toolCalls: [] }), stream: async function* () {} };
  const caps = new ProviderRouter({ sdk }).capabilities("connect");
  assert.deepEqual(Object.values(caps).filter(Boolean), [], "没接 runner 的路线不能宣传任何能力");
});

test("a bare connect/ prefix leaves the model unset so the default can apply", () => {
  assert.equal(selectProvider({ model: "connect/" }).model, undefined);
  assert.equal(selectProvider({ model: "connected-model" }).model, "connected-model");
});

test("a run with defaultProvider connect still routes there when it is configured", () => {
  const runner = { run: async () => ({ text: "", toolCalls: [] }), stream: async function* () {} };
  const router = new ProviderRouter({ sdk: runner, connect: runner, defaultProvider: "connect" });
  assert.equal(router.select({}).provider, "connect");
  assert.equal(router.select({ keySetting: "sdk" }).provider, "sdk");
});
