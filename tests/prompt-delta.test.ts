import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDurableTurn, fingerprintTools, hasSendableUserIntent, type DurableSlotHints } from "../src/prompt-delta.js";
import type { DurableTurn, ProtocolKind } from "../src/types.js";

const LOOKUP_CHAT = {
  type: "function",
  function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }
};
const READ_CHAT = {
  type: "function",
  function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }
};
const GET_MCP_CHAT = {
  type: "function",
  function: { name: "GetMcpTools", parameters: { type: "object", properties: {} } }
};
const LOOKUP_RESPONSES = {
  type: "function",
  name: "lookup",
  parameters: { type: "object", properties: { q: { type: "string" } } }
};
const READ_ANTHROPIC = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
};
const LOOKUP_ANTHROPIC = {
  name: "lookup",
  input_schema: { type: "object", properties: { q: { type: "string" } } }
};

const OLD_IMAGE = "https://example.com/old.png";
const NEW_IMAGE = "https://example.com/new.png";
const RITUAL = "搜到工具了，先把完整 schema 拉齐再扫。";

type Row = {
  name: string;
  protocol: ProtocolKind;
  body: unknown;
  previous?: Parameters<typeof extractDurableTurn>[2];
  slotHints?: DurableSlotHints | ((base: DurableTurn) => DurableSlotHints);
  base?: { protocol?: ProtocolKind; body: unknown; previous?: Parameters<typeof extractDurableTurn>[2] };
  kind: DurableTurn["kind"];
  userText?: string;
  toolResults?: NonNullable<DurableTurn["toolResults"]>;
  imageData?: string[];
  assertExtra?: (turn: DurableTurn) => void;
};

const ROWS: Row[] = [
  {
    name: "1. Chat [user] → new_user",
    protocol: "openai-chat",
    body: { messages: [{ role: "user", content: "hello" }] },
    kind: "new_user",
    userText: "hello"
  },
  {
    name: "2. Chat [user, assistant+tool_calls, tool] → tool_results (id aligned)",
    protocol: "openai-chat",
    body: {
      messages: [
        { role: "user", content: "lookup ping" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "lookup", arguments: '{"q":"ping"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_abc", content: "pong" }
      ],
      tools: [LOOKUP_CHAT]
    },
    kind: "tool_results",
    toolResults: [{ id: "call_abc", content: "pong" }]
  },
  {
    name: "3. Chat two parallel tool_calls + two tool messages",
    protocol: "openai-chat",
    body: {
      messages: [
        { role: "user", content: "do both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } },
            { id: "call_2", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "alpha" },
        { role: "tool", tool_call_id: "call_2", content: "file body" }
      ],
      tools: [LOOKUP_CHAT, READ_CHAT]
    },
    kind: "tool_results",
    toolResults: [
      { id: "call_1", content: "alpha" },
      { id: "call_2", content: "file body" }
    ]
  },
  {
    name: "4a. Anthropic user text → new_user",
    protocol: "anthropic-messages",
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hello claude" }] }],
      tools: [LOOKUP_ANTHROPIC]
    },
    kind: "new_user",
    userText: "hello claude"
  },
  {
    name: "4b. Anthropic tool_result blocks → tool_results (is_error mapped)",
    protocol: "anthropic-messages",
    body: {
      max_tokens: 1024,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_ok", name: "Read", input: { file_path: "a.ts" } },
            { type: "tool_use", id: "tu_bad", name: "lookup", input: { q: "x" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_ok", content: [{ type: "text", text: "file body" }] },
            { type: "tool_result", tool_use_id: "tu_bad", content: "boom", is_error: true }
          ]
        }
      ],
      tools: [READ_ANTHROPIC, LOOKUP_ANTHROPIC]
    },
    kind: "tool_results",
    toolResults: [
      { id: "tu_ok", content: "file body" },
      { id: "tu_bad", content: "boom", isError: true }
    ]
  },
  {
    name: "5a. Responses input text → new_user",
    protocol: "openai-responses",
    body: { input: "Explain closures.", tools: [LOOKUP_RESPONSES] },
    kind: "new_user",
    userText: "Explain closures."
  },
  {
    name: "5b. Responses function_call_output → tool_results",
    protocol: "openai-responses",
    body: {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] },
        { type: "function_call", call_id: "call_weather", name: "lookup", arguments: '{"q":"Paris"}' },
        { type: "function_call_output", call_id: "call_weather", output: '{"temp":21}' }
      ],
      tools: [LOOKUP_RESPONSES]
    },
    kind: "tool_results",
    toolResults: [{ id: "call_weather", content: '{"temp":21}' }]
  },
  {
    name: "5c. Responses previous_response_id with only output items this turn",
    protocol: "openai-responses",
    body: {
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_weather", content: "via content field" }]
    },
    previous: {
      response: {
        output: [{ type: "function_call", call_id: "call_weather", name: "lookup", arguments: "{}" }]
      },
      inputItems: []
    },
    kind: "tool_results",
    toolResults: [{ id: "call_weather", content: "via content field" }]
  },
  {
    name: "6. GetMcpTools result passes through (host-meta filter removed)",
    protocol: "openai-chat",
    body: {
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_meta", type: "function", function: { name: "GetMcpTools", arguments: "{}" } },
            { id: "call_read", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_meta", content: "schema-pack" },
        { role: "tool", tool_call_id: "call_read", content: "file body" }
      ],
      tools: [GET_MCP_CHAT, READ_CHAT]
    },
    kind: "tool_results",
    toolResults: [
      { id: "call_meta", content: "schema-pack" },
      { id: "call_read", content: "file body" }
    ]
  },
  {
    name: "7. System text change vs slotHints → incompatible",
    protocol: "openai-chat",
    base: {
      body: {
        messages: [
          { role: "system", content: "Always answer in haiku form." },
          { role: "user", content: "hi" }
        ]
      }
    },
    body: {
      messages: [
        { role: "system", content: "Always answer with a numbered list." },
        { role: "user", content: "hi" }
      ]
    },
    slotHints: (base) => ({
      lastUserText: base.userText,
      systemFingerprint: base.systemFingerprint,
      toolsFingerprint: base.toolsFingerprint
    }),
    kind: "incompatible"
  },
  {
    name: "8. tools list name/schema change → incompatible",
    protocol: "openai-chat",
    base: {
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: [LOOKUP_CHAT]
      }
    },
    body: {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: { q: { type: "string" }, extra: { type: "number" } } }
          }
        }
      ]
    },
    slotHints: (base) => ({
      lastUserText: base.userText,
      systemFingerprint: base.systemFingerprint,
      toolsFingerprint: base.toolsFingerprint
    }),
    kind: "incompatible"
  },
  {
    name: "9. Empty increment (last user === lastUserText, no new tool result)",
    protocol: "openai-chat",
    base: {
      body: { messages: [{ role: "user", content: "hello" }] }
    },
    body: {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" }
      ]
    },
    slotHints: (base) => ({
      lastUserText: base.userText,
      systemFingerprint: base.systemFingerprint,
      toolsFingerprint: base.toolsFingerprint
    }),
    kind: "empty"
  },
  {
    name: "10. Images only from this-turn new user message",
    protocol: "openai-chat",
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: OLD_IMAGE } }
          ]
        },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: [
            { type: "text", text: "second" },
            { type: "image_url", image_url: { url: NEW_IMAGE } }
          ]
        }
      ]
    },
    kind: "new_user",
    userText: "second",
    imageData: [NEW_IMAGE]
  }
];

for (const row of ROWS) {
  test(row.name, () => {
    const slotHints = resolveHints(row);
    const turn = extractDurableTurn(row.protocol, row.body, row.previous, slotHints);
    assert.equal(turn.kind, row.kind, JSON.stringify(turn));
    assert.match(turn.systemFingerprint, /^[0-9a-f]{64}$/);
    assert.match(turn.toolsFingerprint, /^[0-9a-f]{64}$/);
    if (row.userText !== undefined) assert.equal(turn.userText, row.userText);
    if (row.toolResults) assert.deepEqual(turn.toolResults, row.toolResults);
    if (row.kind !== "tool_results") assert.equal(turn.toolResults, undefined);
    if (row.imageData) {
      assert.deepEqual(
        (turn.images ?? []).map((image) => image.data),
        row.imageData
      );
      assert.equal(
        (turn.images ?? []).some((image) => image.data === OLD_IMAGE),
        false,
        "historical images must not be replayed"
      );
    }
    if (row.kind === "new_user" && !row.imageData) assert.equal(turn.images, undefined);
    row.assertExtra?.(turn);
  });
}

test("Anthropic GetMcpTools tool_result passes through (host-meta filter removed)", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
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
    ],
    tools: [READ_ANTHROPIC]
  });
  assert.equal(turn.kind, "tool_results");
  // 宿主元过滤已拆除：客户端声明并执行了的元工具结果原样回流（上游 agent 在等它）。
  assert.deepEqual(turn.toolResults, [
    { id: "call_meta", content: "schema-pack" },
    { id: "call_read", content: "file body" }
  ]);
});

test("Responses previous GetMcpTools function_call_output passes through", () => {
  const turn = extractDurableTurn(
    "openai-responses",
    {
      previous_response_id: "resp_1",
      input: [
        { type: "function_call_output", call_id: "call_meta", output: "schema-pack" },
        { type: "function_call_output", call_id: "call_read", output: "file body" }
      ]
    },
    {
      response: {
        output: [
          { type: "function_call", call_id: "call_meta", name: "GetMcpTools", arguments: "{}" },
          { type: "function_call", call_id: "call_read", name: "Read", arguments: "{}" }
        ]
      }
    }
  );
  assert.equal(turn.kind, "tool_results");
  assert.deepEqual(turn.toolResults, [
    { id: "call_meta", content: "schema-pack" },
    { id: "call_read", content: "file body" }
  ]);
});

test("toolsFingerprint includes GetMcpTools and reordering does not change it", () => {
  const withMeta = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hi" }],
    tools: [GET_MCP_CHAT, READ_CHAT, LOOKUP_CHAT]
  });
  const reordered = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hi" }],
    tools: [LOOKUP_CHAT, READ_CHAT, GET_MCP_CHAT]
  });
  assert.equal(withMeta.toolsFingerprint, reordered.toolsFingerprint, "排序稳定性不依赖元过滤");
  const withoutMeta = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hi" }],
    tools: [LOOKUP_CHAT, READ_CHAT]
  });
  assert.notEqual(withMeta.toolsFingerprint, withoutMeta.toolsFingerprint, "声明了 GetMcpTools 就要进指纹");
  assert.equal(withMeta.kind, "new_user");
});

test("same system and tools with a new last user stay new_user", () => {
  const first = extractDurableTurn("openai-chat", {
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" }
    ],
    tools: [LOOKUP_CHAT]
  });
  const second = extractDurableTurn(
    "openai-chat",
    {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "follow up" }
      ],
      tools: [LOOKUP_CHAT]
    },
    undefined,
    {
      lastUserText: first.userText,
      systemFingerprint: first.systemFingerprint,
      toolsFingerprint: first.toolsFingerprint
    }
  );
  assert.equal(second.kind, "new_user");
  assert.equal(second.userText, "follow up");
});

test("ritual assistant text is not a tool result", () => {
  const turn = extractDurableTurn("openai-chat", {
    messages: [
      { role: "user", content: "Continue" },
      { role: "assistant", content: RITUAL }
    ]
  });
  assert.equal(turn.kind, "new_user");
  assert.equal(turn.userText, "Continue");
  assert.equal(turn.toolResults, undefined);
});

test("Anthropic this-turn images exclude historical user images", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", source: { type: "url", url: OLD_IMAGE } }
        ]
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "image", source: { type: "url", url: NEW_IMAGE } }
        ]
      }
    ]
  });
  assert.equal(turn.kind, "new_user");
  assert.equal(turn.userText, "second");
  assert.deepEqual(
    (turn.images ?? []).map((image) => image.data),
    [NEW_IMAGE]
  );
});

test("Responses type=tool_result is accepted as function_call_output", () => {
  const turn = extractDurableTurn("openai-responses", {
    input: [{ type: "tool_result", call_id: "call_x", output: "ok" }]
  });
  assert.equal(turn.kind, "tool_results");
  assert.deepEqual(turn.toolResults, [{ id: "call_x", content: "ok" }]);
});

test("fingerprintTools sorts by name and includes inputSchema", () => {
  const a = fingerprintTools([
    { name: "b", inputSchema: { type: "object" } },
    { name: "a", inputSchema: { type: "string" } }
  ]);
  const b = fingerprintTools([
    { name: "a", inputSchema: { type: "string" } },
    { name: "b", inputSchema: { type: "object" } }
  ]);
  const c = fingerprintTools([
    { name: "a", inputSchema: { type: "number" } },
    { name: "b", inputSchema: { type: "object" } }
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("GetMcpTools-only trailing results stay tool_results (host-meta filter removed)", () => {
  const first = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "Hello" }]
  });
  const second = extractDurableTurn(
    "openai-chat",
    {
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_meta", type: "function", function: { name: "GetMcpTools", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_meta", content: "schema-pack" }
      ]
    },
    undefined,
    {
      lastUserText: first.userText,
      systemFingerprint: first.systemFingerprint,
      toolsFingerprint: first.toolsFingerprint
    }
  );
  assert.equal(second.kind, "tool_results");
  assert.deepEqual(second.toolResults, [{ id: "call_meta", content: "schema-pack" }]);
});

test("gateway SYSTEM_PROMPT append is in durable systemText and fingerprint", () => {
  const body = {
    messages: [
      { role: "system", content: "client" },
      { role: "user", content: "hi" }
    ]
  };
  const off = extractDurableTurn("openai-chat", body);
  const appended = extractDurableTurn("openai-chat", body, undefined, undefined, { mode: "append", text: "gateway" });
  assert.equal(off.systemText, "client");
  assert.equal(appended.systemText, "client\n\ngateway");
  assert.notEqual(appended.systemFingerprint, off.systemFingerprint);
  const overridden = extractDurableTurn("openai-chat", body, undefined, undefined, { mode: "override", text: "gateway" });
  assert.equal(overridden.systemText, "gateway");
});

/* ------------------------------- 空轮次收口（hasSendableUserIntent，计划 §2/§7） */

test("hasSendableUserIntent: 空串 / 纯空白 → 无意图", () => {
  assert.equal(hasSendableUserIntent(""), false);
  assert.equal(hasSendableUserIntent("   \n\t "), false);
});

test("hasSendableUserIntent: (no content) 占位（忽略大小写）→ 无意图", () => {
  assert.equal(hasSendableUserIntent("(no content)"), false);
  assert.equal(hasSendableUserIntent("(NO CONTENT)"), false);
  assert.equal(hasSendableUserIntent("\n(no content)\n"), false);
});

test("hasSendableUserIntent: <user_query> 包裹的占位 → 无意图（本机 harness 壳，防御）", () => {
  assert.equal(hasSendableUserIntent("<user_query>\n(no content)\n</user_query>"), false);
});

test("hasSendableUserIntent: 仅 caveat + 空 user_query → 无意图", () => {
  const text = [
    "<local-command-caveat>Caveat: local command stdout below.</local-command-caveat>",
    "<command-name>/effort</command-name>",
    "<local-command-stdout>Cancelled</local-command-stdout>",
    "<user_query></user_query>"
  ].join("\n");
  assert.equal(hasSendableUserIntent(text), false);
});

test("hasSendableUserIntent: 真问题 → 有意图", () => {
  assert.equal(hasSendableUserIntent("<user_query>另起一个计划</user_query>"), true);
  assert.equal(hasSendableUserIntent("直接提问"), true);
});

test("hasSendableUserIntent: 正文讨论 (no content) 字样但非整段占位 → 有意图", () => {
  assert.equal(hasSendableUserIntent("请解释什么叫 (no content) 占位"), true);
  assert.equal(hasSendableUserIntent("<user_query>请解释 (no content)</user_query>"), true);
});

test("hasSendableUserIntent: 取最后一个 user_query 的 inner", () => {
  const text = "<user_query>(no content)</user_query>\n<user_query>真正的问题</user_query>";
  assert.equal(hasSendableUserIntent(text), true);
});

test("hasSendableUserIntent: 真正文里字面引用完整占位标签 → 有意图（不得误判空轮）", () => {
  // 用户在真正文里让模型解释这个格式：最后一个 user_query 的 inner 恰是整段占位，
  // 但 user_query 块之外仍有实质内容 ⇒ 是引用，不是空轮。
  const quoted = "请看这个例子 <user_query>(no content)</user_query> 它是什么意思";
  assert.equal(hasSendableUserIntent(quoted), true);
  // harness 占位轮：标签外没有任何真正文 ⇒ 仍是空轮。
  assert.equal(hasSendableUserIntent("<user_query>\n(no content)\n</user_query>\n"), false);
});

test("extract: anthropic 真正文引用占位标签 → 仍 new_user（防误伤收口）", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [
      { role: "user", content: "请看这个例子 <user_query>(no content)</user_query> 它是什么意思" }
    ]
  });
  assert.equal(turn.kind, "new_user");
});

/* ------------------------------- extract 空轮收口 */

test("extract: anthropic 最后一条 user 为字符串占位 (no content) → empty（empty.json 实锤）", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [
      { role: "user", content: "上一个问题" },
      { role: "assistant", content: [{ type: "text", text: "上一条回复" }] },
      { role: "user", content: "(no content)" }
    ]
  });
  assert.equal(turn.kind, "empty");
});

test("extract: 真问题仍是 new_user 且 userText 保留原文（不剥 harness 壳）", () => {
  const original = "<local-command-caveat>noise</local-command-caveat>\n<user_query>真问题</user_query>";
  const turn = extractDurableTurn("openai-chat", {
    messages: [
      { role: "user", content: original }
    ]
  });
  assert.equal(turn.kind, "new_user");
  assert.equal(turn.userText, original);
});

test("extract: 关掉开关时占位仍按 new_user 发出（旧行为）", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [{ role: "user", content: "(no content)" }]
  }, undefined, undefined, undefined, false);
  assert.equal(turn.kind, "new_user");
  assert.equal(turn.userText, "(no content)");
});

test("extract: 空字符串 userText 的旧 empty 用例不受开关影响", () => {
  const on = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [{ role: "user", content: "" }]
  });
  const off = extractDurableTurn("anthropic-messages", {
    max_tokens: 1024,
    messages: [{ role: "user", content: "" }]
  }, undefined, undefined, undefined, false);
  assert.equal(on.kind, "empty");
  assert.equal(off.kind, "empty");
});

test("extract: chat 空轮（占位符）同样收成 empty（三套协议共用）", () => {
  const turn = extractDurableTurn("openai-chat", {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "(no content)" }
    ]
  });
  assert.equal(turn.kind, "empty");
});

test("extract: 纯图片轮次不受占位判定影响", () => {
  const turn = extractDurableTurn("openai-chat", {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "(no content)" },
          { type: "image_url", image_url: { url: NEW_IMAGE } }
        ]
      }
    ]
  });
  assert.equal(turn.kind, "new_user");
  assert.deepEqual((turn.images ?? []).map((image) => image.data), [NEW_IMAGE]);
});

function resolveHints(row: Row): DurableSlotHints | undefined {
  if (!row.slotHints) return undefined;
  if (typeof row.slotHints !== "function") return row.slotHints;
  const base = extractDurableTurn(
    row.base?.protocol ?? row.protocol,
    row.base?.body ?? row.body,
    row.base?.previous ?? row.previous
  );
  return row.slotHints(base);
}
