import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDurableTurn, fingerprintTools, type DurableSlotHints } from "../src/prompt-delta.js";
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
    name: "6. GetMcpTools result discarded, not in toolResults",
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
    toolResults: [{ id: "call_read", content: "file body" }],
    assertExtra: (turn) => {
      assert.equal(
        turn.toolResults?.some((item) => item.content.includes("schema-pack") || item.id === "call_meta"),
        false
      );
    }
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

test("Anthropic GetMcpTools tool_result is discarded", () => {
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
  assert.deepEqual(turn.toolResults, [{ id: "call_read", content: "file body" }]);
});

test("Responses previous GetMcpTools function_call_output is discarded", () => {
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
  assert.deepEqual(turn.toolResults, [{ id: "call_read", content: "file body" }]);
});

test("toolsFingerprint ignores GetMcpTools and is stable under reorder", () => {
  const withMeta = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hi" }],
    tools: [GET_MCP_CHAT, READ_CHAT, LOOKUP_CHAT]
  });
  const reordered = extractDurableTurn("openai-chat", {
    messages: [{ role: "user", content: "hi" }],
    tools: [LOOKUP_CHAT, READ_CHAT]
  });
  assert.equal(withMeta.toolsFingerprint, reordered.toolsFingerprint);
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

test("GetMcpTools-only trailing results become empty when lastUserText matches", () => {
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
  assert.equal(second.kind, "empty");
  assert.equal(second.toolResults, undefined);
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
