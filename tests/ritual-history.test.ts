import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRitualAssistantText,
  prepareAnthropicMessages,
  prepareOpenAiChat,
  prepareOpenAiResponses,
  stripRitualAssistantText
} from "../src/protocol.js";

const RITUAL_SCHEMA_SENTENCE = "搜到工具了，先把完整 schema 拉齐再扫课程路径。";
const RITUAL_ALIGN_TOOLS_SHORT = "先对齐工具再继续";
const RITUAL_HISTORY_SENTENCE = "搜到工具了，先把完整 schema 拉齐再扫。";
const RITUAL_SCHEMA_FIRST = "先把完整 schema 拉齐再扫。";
const CASUAL_FETCH_THEN_SCHEMA = "I'll fetch the notes, then discuss the schema.";
const INCOMPLETE_SCHEMA_SHORT = "incomplete schema ok";
const SECRET_REASONING_ALIGN = "secret reasoning align";
const EARLIER_ANSWER = "earlier answer";
const STALE_INSTRUCTIONS = "Always answer in haiku form.";
const FRESH_INSTRUCTIONS = "Always answer with a numbered list.";
const USER_SCHEMA_MESSAGE = "Please keep discussing the course JSON schema in this thread.";

/** >200 chars, mentions schema once, no 拉齐/对齐/align/fetch-schema planning phrasing. */
const LONG_CASUAL_SCHEMA_ANSWER = [
  "I read the lecture notes and drafted a walkthrough of the homework.",
  "The assignment mentions a JSON schema once as optional documentation.",
  "The rest of this reply covers module order, what to implement first,",
  "and why the grading rubric cares more about tests than extra comments.",
  "Please keep going from the files already in the workspace rather than restarting."
].join(" ");

function toolsAndReminder(prompt: string): string {
  const toolsIdx = prompt.indexOf("\nTOOLS:");
  const reminderIdx = prompt.indexOf("\nREMINDER:");
  const conversationIdx = prompt.indexOf("\nConversation:");
  const inputIdx = prompt.indexOf("\nINPUT:");
  const cut = conversationIdx >= 0 ? conversationIdx : inputIdx >= 0 ? inputIdx : reminderIdx;
  const toolsBlock = toolsIdx >= 0 ? prompt.slice(toolsIdx, cut >= 0 ? cut : reminderIdx) : "";
  const reminderBlock = reminderIdx >= 0 ? prompt.slice(reminderIdx) : "";
  return `${toolsBlock}\n${reminderBlock}`;
}

const READ_ANTHROPIC = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
};
const READ_CHAT = {
  type: "function",
  function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }
};
const READ_RESPONSES = {
  type: "function",
  name: "Read",
  parameters: { type: "object", properties: { file_path: { type: "string" } } }
};

test("isRitualAssistantText is true for the 搜到工具了 schema-alignment sentence", () => {
  assert.equal(isRitualAssistantText(RITUAL_SCHEMA_SENTENCE), true);
});

test("isRitualAssistantText is true for a short 对齐工具 sentence", () => {
  assert.equal(isRitualAssistantText(RITUAL_ALIGN_TOOLS_SHORT), true);
});

test("isRitualAssistantText is false for a long answer that mentions schema once", () => {
  assert.ok(LONG_CASUAL_SCHEMA_ANSWER.length > 200);
  assert.equal(isRitualAssistantText(LONG_CASUAL_SCHEMA_ANSWER), false);
});

test("isRitualAssistantText is true when schema appears before 拉齐", () => {
  assert.equal(isRitualAssistantText(RITUAL_SCHEMA_FIRST), true);
});

test("isRitualAssistantText is false for fetch-notes-then-schema discussion", () => {
  assert.equal(isRitualAssistantText(CASUAL_FETCH_THEN_SCHEMA), false);
});

test("isRitualAssistantText is false for a short incomplete-schema mention", () => {
  assert.ok(INCOMPLETE_SCHEMA_SHORT.length <= 200);
  assert.equal(isRitualAssistantText(INCOMPLETE_SCHEMA_SHORT), false);
});

test("stripRitualAssistantText empties a ritual short string", () => {
  assert.equal(stripRitualAssistantText(RITUAL_SCHEMA_SENTENCE), "");
});

test("stripRitualAssistantText leaves earlier answer unchanged", () => {
  assert.equal(stripRitualAssistantText(EARLIER_ANSWER), EARLIER_ANSWER);
});

test("prepareAnthropicMessages TOOLS/REMINDER keep Read and drop GetMcpTools and Task", () => {
  const prepared = prepareAnthropicMessages({
    model: "composer-2.5",
    max_tokens: 1024,
    tools: [
      { name: "GetMcpTools", description: "Discover MCP tools", input_schema: { type: "object", properties: {} } },
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
      },
      { name: "Task", description: "Launch a subagent", input_schema: { type: "object", properties: { prompt: { type: "string" } } } }
    ],
    messages: [{ role: "user", content: "Hello" }]
  });
  const section = toolsAndReminder(prepared.prompt);
  assert.ok(section.includes("TOOLS:"), "prompt must include a TOOLS section");
  assert.ok(section.includes("REMINDER:"), "prompt must include a REMINDER section");
  assert.ok(!section.includes("GetMcpTools"), "TOOLS/REMINDER must not contain GetMcpTools");
  assert.ok(!section.includes("Task"), "TOOLS/REMINDER must not contain Task");
  assert.ok(section.includes("Read"), "TOOLS/REMINDER must still contain Read");
});

test("prepareAnthropicMessages drops ritual assistant history, keeps Continue and earlier answer, excludes thinking", () => {
  // Same history shape as server.test.ts "anthropic history thinking blocks are excluded…", plus a ritual-only assistant turn.
  const prepared = prepareAnthropicMessages({
    model: "composer-2.5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret internal reasoning", signature: "fake-sig" },
          { type: "text", text: EARLIER_ANSWER }
        ]
      },
      { role: "assistant", content: [{ type: "text", text: RITUAL_HISTORY_SENTENCE }] },
      { role: "user", content: "Continue" }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_HISTORY_SENTENCE), "ritual assistant text must not enter the prompt");
  assert.ok(prompt.includes("Continue"), "user Continue must stay in the prompt");
  assert.ok(prompt.includes(EARLIER_ANSWER), "regular assistant text stays in the prompt");
  assert.ok(!prompt.includes("secret internal reasoning"), "thinking content must not enter the prompt");
  assert.ok(!prompt.includes("fake-sig"), "thinking signature must not enter the prompt");
});

test("prepareOpenAiChat drops ritual assistant content and keeps user schema mentions", () => {
  const prepared = prepareOpenAiChat({
    model: "composer-2.5",
    messages: [
      { role: "user", content: USER_SCHEMA_MESSAGE },
      { role: "assistant", content: RITUAL_SCHEMA_SENTENCE },
      { role: "user", content: "Continue" }
    ],
    tools: [READ_CHAT]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_SCHEMA_SENTENCE), "ritual assistant content must not enter the prompt");
  assert.ok(prompt.includes(USER_SCHEMA_MESSAGE), "user content mentioning schema must remain");
});

test("prepareOpenAiChat TOOLS/REMINDER keep Read and drop GetMcpTools and Task", () => {
  const prepared = prepareOpenAiChat({
    model: "composer-2.5",
    messages: [{ role: "user", content: "Hello" }],
    tools: [
      { type: "function", function: { name: "GetMcpTools", parameters: { type: "object", properties: {} } } },
      READ_CHAT,
      { type: "function", function: { name: "Task", parameters: { type: "object", properties: { prompt: { type: "string" } } } } }
    ]
  });
  const section = toolsAndReminder(prepared.prompt);
  assert.ok(section.includes("Read"), "TOOLS/REMINDER must still contain Read");
  assert.ok(!section.includes("GetMcpTools"), "TOOLS/REMINDER must not contain GetMcpTools");
  assert.ok(!section.includes("Task"), "TOOLS/REMINDER must not contain Task");
});

test("prepareOpenAiChat drops host-meta tool_calls and their tool results from history", () => {
  const prepared = prepareOpenAiChat({
    model: "composer-2.5",
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_meta", type: "function", function: { name: "GetMcpTools", arguments: "{}" } },
          { id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.ts\"}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_meta", content: "schema-pack" },
      { role: "tool", tool_call_id: "call_read", content: "file body" }
    ],
    tools: [READ_CHAT]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes("GetMcpTools"), "host-meta tool_calls must not be replayed");
  assert.ok(!prompt.includes("schema-pack"), "host-meta tool results must not be replayed");
  assert.ok(prompt.includes("Read"), "client Read tool_call stays");
  assert.ok(prompt.includes("file body"), "Read tool result stays");
});

test("prepareOpenAiResponses TOOLS/REMINDER keep Read and drop GetMcpTools and Task", () => {
  const prepared = prepareOpenAiResponses({
    model: "composer-2.5",
    input: "Hello",
    tools: [
      { type: "function", name: "GetMcpTools", parameters: { type: "object", properties: {} } },
      READ_RESPONSES,
      { type: "function", name: "Task", parameters: { type: "object", properties: { prompt: { type: "string" } } } }
    ]
  });
  const section = toolsAndReminder(prepared.prompt);
  assert.ok(section.includes("Read"), "TOOLS/REMINDER must still contain Read");
  assert.ok(!section.includes("GetMcpTools"), "TOOLS/REMINDER must not contain GetMcpTools");
  assert.ok(!section.includes("Task"), "TOOLS/REMINDER must not contain Task");
});

test("prepareOpenAiResponses drops ritual assistant input and host-meta function_call items", () => {
  const prepared = prepareOpenAiResponses({
    model: "composer-2.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: USER_SCHEMA_MESSAGE }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: RITUAL_HISTORY_SENTENCE }] },
      { type: "function_call", call_id: "call_meta", name: "GetMcpTools", arguments: "{}" },
      { type: "function_call", call_id: "call_read", name: "Read", arguments: "{\"file_path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_meta", output: "schema-pack" },
      { type: "function_call_output", call_id: "call_read", output: "file body" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }
    ],
    tools: [READ_RESPONSES]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_HISTORY_SENTENCE), "ritual assistant input must not enter the prompt");
  assert.ok(!prompt.includes("GetMcpTools"), "host-meta function_call must not be replayed");
  assert.ok(!prompt.includes("schema-pack"), "host-meta function_call_output must not be replayed");
  assert.ok(prompt.includes(USER_SCHEMA_MESSAGE), "user schema mention stays");
  assert.ok(prompt.includes("Continue"), "user Continue stays");
  assert.ok(prompt.includes("Read"), "client Read function_call stays");
  assert.ok(prompt.includes("file body"), "Read function_call_output stays");
});

test("prepareOpenAiResponses sanitizes previous_response dump without mutating the stored snapshot", () => {
  const stored = {
    id: "resp_prev",
    instructions: STALE_INSTRUCTIONS,
    tools: [
      { type: "function", name: "GetMcpTools", parameters: { type: "object" } },
      { type: "function", name: "Read", parameters: { type: "object" } }
    ],
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "align schema internally" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: RITUAL_HISTORY_SENTENCE }] },
      { type: "function_call", call_id: "call_meta", name: "GetMcpTools", arguments: "{}" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: EARLIER_ANSWER }] }
    ]
  };
  const prepared = prepareOpenAiResponses({ model: "composer-2.5", input: "Continue" }, { response: stored, inputItems: [] });
  const prompt = prepared.prompt;
  assert.ok(prompt.includes("PREVIOUS_RESPONSE:"), "previous snapshot still enters the prompt");
  assert.ok(!prompt.includes(RITUAL_HISTORY_SENTENCE), "ritual output_text must not enter PREVIOUS_RESPONSE dump");
  assert.ok(!prompt.includes("GetMcpTools"), "host-meta tools/calls must not enter PREVIOUS_RESPONSE dump");
  assert.ok(!prompt.includes("align schema internally"), "reasoning must not enter PREVIOUS_RESPONSE dump");
  assert.ok(prompt.includes(EARLIER_ANSWER), "regular assistant output stays in the dump");
  assert.ok(prompt.includes("Read"), "client Read tool stays in the dump");
  // instructions 是逐轮参数：官方语义下它不随 previous_response_id 继承，快照回灌等于把过期指令又发一遍。
  assert.ok(!prompt.includes(STALE_INSTRUCTIONS), "previous instructions must not re-enter the prompt");
  assert.equal(stored.tools[0].name, "GetMcpTools", "stored snapshot must not be mutated");
  assert.equal(stored.instructions, STALE_INSTRUCTIONS, "stored instructions must not be mutated");
  assert.equal((stored.output[1] as { content: Array<{ text: string }> }).content[0].text, RITUAL_HISTORY_SENTENCE);
});

test("a resent instructions is this turn's client system, not the previous turn's leftover", () => {
  const stored = { id: "resp_prev", instructions: STALE_INSTRUCTIONS, output: [] };
  const prepared = prepareOpenAiResponses(
    { model: "composer-2.5", instructions: FRESH_INSTRUCTIONS, input: "Continue" },
    { response: stored, inputItems: [] }
  );
  assert.ok(prepared.prompt.includes(`INSTRUCTIONS:\n${FRESH_INSTRUCTIONS}`), prepared.prompt);
  assert.ok(!prepared.prompt.includes(STALE_INSTRUCTIONS), prepared.prompt);
});

test("prepareAnthropicMessages drops host-meta tool_use and matching tool_result from history", () => {
  const prepared = prepareAnthropicMessages({
    model: "composer-2.5",
    max_tokens: 1024,
    tools: [READ_ANTHROPIC],
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_meta", name: "GetMcpTools", input: {} },
          { type: "tool_use", id: "call_read", name: "Read", input: { file_path: "a.ts" } }
        ]
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_meta", content: "schema-pack" },
          { type: "tool_result", tool_use_id: "call_read", content: "file body" }
        ]
      }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes("GetMcpTools"), "host-meta tool_use must not be replayed");
  assert.ok(!prompt.includes("schema-pack"), "host-meta tool_result must not be replayed");
  assert.ok(prompt.includes("Read"), "client Read tool_use stays");
  assert.ok(prompt.includes("file body"), "Read tool_result stays");
});

test("prepareOpenAiChat ritual-only assistant turn does not invent ASSISTANT: [empty]", () => {
  const prepared = prepareOpenAiChat({
    model: "composer-2.5",
    messages: [
      { role: "user", content: "Continue" },
      { role: "assistant", content: RITUAL_SCHEMA_SENTENCE }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_SCHEMA_SENTENCE), "ritual assistant content must not enter the prompt");
  assert.ok(!prompt.includes("ASSISTANT: [empty]"), "ritual-only assistant turn must not invent ASSISTANT: [empty]");
  assert.ok(prompt.includes("Continue"), "user Continue must stay in the prompt");
});

test("prepareAnthropicMessages ritual-only assistant turn does not invent ASSISTANT: [empty]", () => {
  const prepared = prepareAnthropicMessages({
    model: "composer-2.5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Continue" },
      { role: "assistant", content: [{ type: "text", text: RITUAL_HISTORY_SENTENCE }] }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_HISTORY_SENTENCE), "ritual assistant text must not enter the prompt");
  assert.ok(!prompt.includes("ASSISTANT: [empty]"), "ritual-only assistant turn must not invent ASSISTANT: [empty]");
  assert.ok(prompt.includes("Continue"), "user Continue must stay in the prompt");
});

test("prepareAnthropicMessages user-only GetMcpTools tool_result does not invent USER: [empty] or replay schema-pack", () => {
  const prepared = prepareAnthropicMessages({
    model: "composer-2.5",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_meta", name: "GetMcpTools", input: {} }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_meta", content: "schema-pack" }]
      }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes("USER: [empty]"), "meta-only user turn must not invent USER: [empty]");
  assert.ok(!prompt.includes("schema-pack"), "host-meta tool_result must not be replayed");
});

test("prepareOpenAiResponses drops orphan previous GetMcpTools function_call_output from current input", () => {
  const prepared = prepareOpenAiResponses(
    {
      model: "composer-2.5",
      input: [{ type: "function_call_output", call_id: "call_meta", output: "schema-pack" }]
    },
    {
      response: {
        output: [{ type: "function_call", call_id: "call_meta", name: "GetMcpTools", arguments: "{}" }]
      },
      inputItems: []
    }
  );
  assert.ok(!prepared.prompt.includes("schema-pack"), "orphan host-meta function_call_output must not enter the prompt");
});

test("prepareOpenAiResponses skips reasoning items in input", () => {
  const prepared = prepareOpenAiResponses({
    model: "composer-2.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: SECRET_REASONING_ALIGN }] }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(SECRET_REASONING_ALIGN), "reasoning input must not enter the prompt");
  assert.ok(prompt.includes("Continue"), "user Continue stays");
});

test("prepareOpenAiResponses strips ritual assistant content with type text", () => {
  const prepared = prepareOpenAiResponses({
    model: "composer-2.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: USER_SCHEMA_MESSAGE }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: RITUAL_HISTORY_SENTENCE }] }
    ]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes(RITUAL_HISTORY_SENTENCE), "ritual assistant type:text must not enter the prompt");
  assert.ok(prompt.includes(USER_SCHEMA_MESSAGE), "user schema mention stays");
});

test("prepareOpenAiChat drops host-meta tool result even when it appears before the matching tool_calls", () => {
  const prepared = prepareOpenAiChat({
    model: "composer-2.5",
    messages: [
      { role: "user", content: "Hello" },
      { role: "tool", tool_call_id: "call_meta", content: "schema-pack" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_meta", type: "function", function: { name: "GetMcpTools", arguments: "{}" } }
        ]
      }
    ],
    tools: [READ_CHAT]
  });
  const prompt = prepared.prompt;
  assert.ok(!prompt.includes("schema-pack"), "host-meta tool result before tool_calls must not be replayed");
  assert.ok(!prompt.includes("GetMcpTools"), "host-meta tool_calls must not be replayed");
  assert.ok(prompt.includes("Hello"), "user Hello stays");
});
