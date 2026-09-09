import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationMessages, toPreparedConversation } from "../src/cursor-bot/conversation.js";
import { runToolLoop } from "../src/cursor-bot/tool-loop.js";
import type { PreparedConversation } from "../src/cursor-bot/conversation.js";
import {
  InferenceMessageRole,
  InferenceStreamRequest,
  InferenceStreamResponse,
  InferenceTextStreamPart,
  InferenceToolCallStreamPart
} from "../src/cursor-bot/proto/inference_pb.js";

function textFrame(text: string): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "textPart", value: new InferenceTextStreamPart({ text }) }
  });
}

function toolFrame(part: Partial<InferenceToolCallStreamPart>): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "toolCallPart", value: new InferenceToolCallStreamPart(part) }
  });
}

/** 记下完整 proto 请求的假 client，供回灌形态断言用。 */
function recordingClient(rounds: InferenceStreamResponse[][]) {
  const requests: unknown[] = [];
  let round = 0;
  return {
    requests,
    client: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(request: unknown) {
        requests.push(request);
        for (const frame of rounds[Math.min(round, rounds.length - 1)] ?? []) yield frame;
        round += 1;
      }
    }
  };
}

/* -------------------------------------------------- Anthropic 回灌形态 */

test("anthropic refeed: tool_use + tool_result survive into the next round's request", async () => {
  // 入站是 Anthropic 形态：assistant 带 tool_use 块，下一条 user 消息里裹 tool_result。
  const conversation = toPreparedConversation(
    {
      messages: [
        { role: "user", content: "list the files" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "need ls", signature: "sig-1" },
            { type: "text", text: "on it" },
            { type: "tool_use", id: "tu-1", name: "ls", input: { path: "." } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "a.txt" }] }
      ]
    },
    "anthropic"
  ) as PreparedConversation;

  const { client, requests } = recordingClient([[textFrame("done")]]);
  const result = await (async () => {
    const generator = runToolLoop({ client }, {
      conversation,
      requestedModel: { modelId: "m" },
      runId: "r"
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return next.value;
    }
  })();

  // 入站这轮没有新的上游调用（history 里已有完整问答），最终应直接完成。
  assert.equal(result.stoppedBecause, "completed");
  assert.equal(requests.length, 1);
  const messages = (requests[0] as InferenceStreamRequest).messages;
  // proto 形态：user → assistant(reasoning + text + toolCalls) → tool(toolContent)。
  assert.deepEqual(messages.map((message) => message.role), [
    InferenceMessageRole.USER,
    InferenceMessageRole.ASSISTANT,
    InferenceMessageRole.TOOL
  ]);
  const assistant = messages[1];
  assert.equal(assistant.content.case, "text");
  const toolCall = assistant.toolCalls[0];
  assert.equal(toolCall.toolCallId, "tu-1");
  assert.equal(toolCall.toolName, "ls");
  assert.equal(assistant.reasoningParts[0].signature, "sig-1");
  const tool = messages[2];
  const toolContent = tool.content.case === "toolContent" ? tool.content.value : undefined;
  assert.equal(toolContent?.parts.length, 1);
  assert.equal(toolContent?.parts[0].toolCallId, "tu-1");
  assert.equal(toolContent?.parts[0].toolName, "ls");
});

test("anthropic refeed: the loop round-trips tool results back upstream", async () => {
  // 第一轮上游回一个 tool_call 帧，执行器喂结果，第二轮请求必须把
  // assistant(toolCalls) + tool(toolResults) 追加进 messages——这是接续的前提。
  const conversation = toPreparedConversation(
    { messages: [{ role: "user", content: "go" }] },
    "anthropic"
  ) as PreparedConversation;
  const { client, requests } = recordingClient([
    [toolFrame({ toolCallId: "tu-2", toolName: "ls", args: '{}', isComplete: true })],
    [textFrame("final") ]
  ]);
  const result = await (async () => {
    const generator = runToolLoop(
      { client, executeTool: async () => ({ result: "a.txt" }) },
      { conversation, requestedModel: { modelId: "m" }, runId: "r" }
    );
    for (;;) {
      const next = await generator.next();
      if (next.done) return next.value;
    }
  })();

  assert.equal(result.stoppedBecause, "completed");
  assert.equal(requests.length, 2);
  const second = (requests[1] as InferenceStreamRequest).messages;
  assert.deepEqual(second.map((message) => message.role), [
    InferenceMessageRole.USER,
    InferenceMessageRole.ASSISTANT,
    InferenceMessageRole.TOOL
  ]);
  const call = second[1].toolCalls[0];
  assert.equal(call.toolCallId, "tu-2");
  const toolContent = second[2].content.case === "toolContent" ? second[2].content.value : undefined;
  const part = toolContent?.parts[0];
  assert.equal(part?.toolCallId, "tu-2");
  // proto 值是 google.protobuf.Value 的 oneof，字符串走 kind.stringValue。
  const resultValue = part && part.result ? part.result.kind : undefined;
  assert.equal(resultValue?.case, "stringValue");
  if (resultValue && resultValue.case === "stringValue") assert.equal(resultValue.value, "a.txt");
});
