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
 * 宿主元工具直通（090d4a7 的剔除机制已拆除）：
 * 当初的剔除治的是缓存错位造成的「仪式重演」，durable 上线后现象消失，剔除只剩副作用——
 * cursor-byok 声明的 Task / MCP 发现工具被拦，子代理整个不可用。现在客户端声明的工具
 * 全量注册、全量可转发、结果原样回流。
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

test("createSdkCustomTools registers client-declared host meta tools (Task / GetMcpTools)", () => {
  const customTools = createSdkCustomTools(clientTools, () => {});
  assert.ok(customTools);
  assert.deepEqual(Object.keys(customTools), ["GetMcpTools", "Task", "Read"]);
});

test("createSdkCustomTools hold:true registers Task and drives its execute through onHold", async () => {
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
  const pending = customTools.Task!.execute({ prompt: "review the diff" }, { toolCallId: "call_task_1" });
  assert.equal(held, true, "Task execute 必须经 onHold 挂起");
  release[0]({ content: [{ type: "text", text: "subagent done" }] });
  const result = (await pending) as { content: Array<{ text: string }> };
  assert.equal(result.content[0].text, "subagent done");
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

test("matchesClientTool accepts client-declared Task and GetMcpTools", () => {
  assert.equal(
    matchesClientTool({ id: "call_task", name: "Task", arguments: { prompt: "x" } }, clientTools),
    true,
    "客户端声明了 Task 就必须可转发（byok 靠它拉起子代理）"
  );
  assert.equal(
    matchesClientTool({ id: "call_meta", name: "GetMcpTools", arguments: {} }, clientTools),
    true
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
    "未声明的工具名自然匹配不上，无需宿主元名单"
  );
});

test("matchesClientTool unwraps mcp-wrapped Task for a client that declared it", () => {
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
    true
  );
});

test("extractDurableTurn passes Task tool results through as turn increments", () => {
  // byok 执行完 Task 回传结果：必须作为 tool_results 增量发回上游 agent（挂起的 execute 等着它），
  // 不得再被宿主元名单剥离成空轮。
  const turn = extractDurableTurn("anthropic-messages", {
    max_tokens: 64,
    messages: [
      { role: "user", content: "review the changes" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_task_9", name: "Task", input: { prompt: "review" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_task_9", content: "subagent report" }] }
    ]
  });
  assert.equal(turn.kind, "tool_results");
  assert.deepEqual(turn.toolResults, [{ id: "call_task_9", content: "subagent report" }]);
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
