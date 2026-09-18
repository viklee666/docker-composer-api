import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSdkCustomTools,
  matchesClientTool,
  normalizeToolCallForClient
} from "../src/tool-compat.js";
import { extractDurableTurn } from "../src/prompt-delta.js";
import type { GatewayTool } from "../src/types.js";

/**
 * 宿主元工具过滤（090d4a7，983be1f 拆除后又补回）：
 * Task / GetMcpTools / GetDynamicTools 等不得进 customTools、不得转发、结果不得当 durable 增量。
 * 否则 SDK 只留 mcp 通道时模型会每轮再演一遍发现仪式。
 */

const getMcpTools: GatewayTool = {
  name: "GetMcpTools",
  description: "Discover MCP tools",
  inputSchema: { type: "object", properties: {} }
};

const taskTool: GatewayTool = {
  name: "Task",
  description: "Launch a subagent",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] }
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

const clientTools: GatewayTool[] = [getMcpTools, taskTool, readTool];

test("createSdkCustomTools drops host-meta tools and keeps Read", () => {
  const customTools = createSdkCustomTools(clientTools, () => {});
  assert.ok(customTools);
  assert.deepEqual(Object.keys(customTools), ["Read"]);
});

test("createSdkCustomTools hold:true registers Read and drives its execute through onHold", async () => {
  let held = false;
  const release: Array<(value: unknown) => void> = [];
  const customTools = createSdkCustomTools([taskTool, readTool], () => {}, {
    hold: true,
    onHold: (_id, resolve) => {
      held = true;
      release.push(resolve);
    }
  });
  assert.ok(customTools);
  assert.equal(customTools.Task, undefined, "Task 是宿主元工具，不能进 customTools");
  const pending = customTools.Read!.execute({ file_path: "README.md" }, { toolCallId: "call_read_1" });
  assert.equal(held, true, "Read execute 必须经 onHold 挂起");
  release[0]({ content: [{ type: "text", text: "subagent done" }] });
  const result = (await pending) as { content: Array<{ text: string }> };
  assert.equal(result.content[0].text, "subagent done");
});

test("createSdkCustomTools sanitizes newline composite SDK execute ids before onHold", async () => {
  const raw = "call-ae1e879d-f3ef-4c9e-bc0e-ab5edc79138f-1\nfc_dfca56e0-1050-9e16-b0de-c91782f3f512_0";
  let heldId = "";
  let capturedId = "";
  const customTools = createSdkCustomTools([readTool], (toolCall) => {
    capturedId = toolCall.id;
  }, {
    hold: true,
    onHold: (id, resolve) => {
      heldId = id;
      resolve({ content: [{ type: "text", text: "ok" }] });
    }
  });
  assert.ok(customTools);
  await customTools.Read.execute({ file_path: "README.md" }, { toolCallId: raw });
  assert.equal(heldId, "call-ae1e879d-f3ef-4c9e-bc0e-ab5edc79138f-1");
  assert.equal(capturedId, heldId);
  assert.equal(heldId.includes("\n"), false);
  assert.ok(heldId.length <= 64);
});

test("normalizeToolCallForClient strips newline composite tool ids", () => {
  const raw = "call-ae1e879d-f3ef-4c9e-bc0e-ab5edc79138f-1\nfc_dfca56e0-1050-9e16-b0de-c91782f3f512_0";
  const normalized = normalizeToolCallForClient(
    { id: raw, name: "Read", arguments: { file_path: "a.ts" } },
    [readTool]
  );
  assert.equal(normalized.id, "call-ae1e879d-f3ef-4c9e-bc0e-ab5edc79138f-1");
});

const STATELESS_EXECUTE_COPY =
  "Accepted. The caller will execute this tool and return the result in the next request. End your turn now without calling more tools.";

test("createSdkCustomTools hold:false returns the exact fake-success copy synchronously", () => {
  const twoArg = createSdkCustomTools([readTool], () => {});
  assert.ok(twoArg);
  const twoArgResult = twoArg.Read.execute({ file_path: "README.md" }, { toolCallId: "call_two_arg" });
  assert.equal(twoArgResult instanceof Promise, false);
  assert.deepEqual(twoArgResult, {
    content: [{ type: "text", text: STATELESS_EXECUTE_COPY }]
  });
});

test("matchesClientTool rejects client-declared Task and GetMcpTools", () => {
  assert.equal(
    matchesClientTool({ id: "call_task", name: "Task", arguments: { prompt: "x" } }, clientTools),
    false,
    "即使客户端声明了 Task 也不转发，避免子代理/MCP 发现套娃"
  );
  assert.equal(
    matchesClientTool({ id: "call_meta", name: "GetMcpTools", arguments: {} }, clientTools),
    false
  );
  assert.equal(
    matchesClientTool({ id: "call_dyn", name: "GetDynamicTools", arguments: {} }, clientTools),
    false
  );
  assert.equal(
    matchesClientTool(
      { id: "call_read", name: "Read", arguments: { file_path: "src/index.ts" } },
      clientTools
    ),
    true
  );
});

test("matchesClientTool still rejects tools the client never declared", () => {
  assert.equal(
    matchesClientTool({ id: "c", name: "Task", arguments: {} }, [readTool]),
    false,
    "未声明的工具名自然匹配不上"
  );
});

test("matchesClientTool does not unwrap mcp-wrapped Task onto the client", () => {
  assert.equal(
    matchesClientTool(
      {
        id: "c",
        name: "mcp",
        arguments: {
          providerIdentifier: "custom-user-tools",
          toolName: "Task",
          args: { prompt: "explore" }
        }
      },
      clientTools
    ),
    false
  );
});

test("extractDurableTurn drops Task tool results instead of sending them upstream", () => {
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 64,
    messages: [
      { role: "user", content: "review the changes" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_task_9", name: "Task", input: { prompt: "review" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_task_9", content: "subagent report" }] }
    ]
  });
  assert.notEqual(turn.kind, "tool_results");
  assert.equal(turn.toolResults, undefined);
});

test("normalizeToolCallForClient still unwraps custom-user-tools MCP calls to Read", () => {
  assert.deepEqual(
    normalizeToolCallForClient(
      {
        id: "call_mcp",
        name: "mcp",
        arguments: {
          providerIdentifier: "custom-user-tools",
          toolName: "Read",
          args: { file_path: "src/index.ts" }
        }
      },
      clientTools
    ),
    { id: "call_mcp", name: "Read", arguments: { file_path: "src/index.ts" } }
  );
});

test("Readfile / ReadFile / functions.ReadFile collapse to the declared Read name", () => {
  const tools: GatewayTool[] = [
    { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }
  ];
  for (const name of ["Readfile", "ReadFile", "read_file", "functions.ReadFile"]) {
    assert.deepEqual(
      normalizeToolCallForClient({ id: "c", name, arguments: { target_file: "a.ts" } }, tools),
      { id: "c", name: "Read", arguments: { path: "a.ts" } },
      name
    );
  }
});

test("a custom agent tool gets the same File-suffix collapse, without a hardcoded alias", () => {
  const tools: GatewayTool[] = [
    { name: "LookupDoc", inputSchema: { type: "object", properties: { id: { type: "string" } } } }
  ];
  assert.deepEqual(
    normalizeToolCallForClient({ id: "c", name: "LookupDocFile", arguments: { id: "1" } }, tools),
    { id: "c", name: "LookupDoc", arguments: { id: "1" } }
  );
});

test("File-suffix collapse stays put when both the short and long names are declared", () => {
  const tools: GatewayTool[] = [
    { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "ReadFile", inputSchema: { type: "object", properties: { target_file: { type: "string" } } } }
  ];
  assert.equal(normalizeToolCallForClient({ id: "c", name: "ReadFile", arguments: { target_file: "a.ts" } }, tools).name, "ReadFile");
  assert.equal(normalizeToolCallForClient({ id: "c", name: "Read", arguments: { path: "a.ts" } }, tools).name, "Read");
});

test("an agent that actually declared Readfile keeps that name", () => {
  const tools: GatewayTool[] = [
    { name: "Readfile", inputSchema: { type: "object", properties: { target_file: { type: "string" } } } }
  ];
  assert.equal(
    normalizeToolCallForClient({ id: "c", name: "Readfile", arguments: { target_file: "a.ts" } }, tools).name,
    "Readfile",
    "声明名原样保留"
  );
  assert.equal(
    normalizeToolCallForClient({ id: "c", name: "ReadFile", arguments: { target_file: "a.ts" } }, tools).name,
    "Readfile",
    "只是大小写不同，仍落到声明名"
  );
  assert.equal(
    normalizeToolCallForClient({ id: "c", name: "Read", arguments: { target_file: "a.ts" } }, tools).name,
    "Read",
    "不会把短名硬扩成 Readfile"
  );
});

test("normalizeToolCallForClient unwraps a name/arguments envelope and drops a boolean notify_on_output", () => {
  const tools: GatewayTool[] = [
    {
      name: "Shell",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, notify_on_output: { type: "object" } },
        required: ["command"]
      }
    }
  ];
  const unwrapped = normalizeToolCallForClient(
    {
      id: "c1",
      name: "Shell",
      arguments: { name: "Shell", arguments: { command: "Get-Location", notify_on_output: false } }
    },
    tools
  );
  assert.equal(unwrapped.name, "Shell");
  assert.equal(unwrapped.arguments.command, "Get-Location");
  assert.equal(unwrapped.arguments.notify_on_output, undefined);
  assert.equal(unwrapped.arguments.name, undefined);

  const kept = normalizeToolCallForClient(
    { id: "c2", name: "Shell", arguments: { command: "pwd", notify_on_output: { pattern: "ok" } } },
    tools
  );
  assert.deepEqual(kept.arguments.notify_on_output, { pattern: "ok" });
});
