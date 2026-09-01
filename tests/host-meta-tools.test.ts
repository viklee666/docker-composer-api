import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSdkCustomTools,
  filterHostMetaTools,
  isHostMetaTool,
  matchesClientTool,
  normalizeToolCallForClient
} from "../src/tool-compat.js";
import type { GatewayTool } from "../src/types.js";

const getMcpTools: GatewayTool = {
  name: "GetMcpTools",
  description: "Discover MCP tools",
  inputSchema: { type: "object", properties: {} }
};

const taskTool: GatewayTool = {
  name: "Task",
  description: "Launch a subagent",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } } }
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

const clientToolsWithMeta: GatewayTool[] = [getMcpTools, readTool];

test("isHostMetaTool is true for host MCP, subagent, skill, and ask tools regardless of case", () => {
  for (const name of ["GetMcpTools", "getmcptools", "Task", "CallMcpTool", "Agent", "Skill", "AskUserQuestion"]) {
    assert.equal(isHostMetaTool(name), true, name);
  }
});

test("isHostMetaTool is false for client file tools and non-exact user-defined names", () => {
  for (const name of ["Read", "Bash", "my_get_mcp_tools"]) {
    assert.equal(isHostMetaTool(name), false, name);
  }
});

test("filterHostMetaTools keeps Read and drops GetMcpTools and Task", () => {
  const filtered = filterHostMetaTools([readTool, getMcpTools, taskTool]);
  assert.deepEqual(filtered.map((tool) => tool.name), ["Read"]);
});

test("createSdkCustomTools registers only Read when GetMcpTools is also present", () => {
  const customTools = createSdkCustomTools([getMcpTools, readTool], () => {});
  assert.ok(customTools);
  assert.deepEqual(Object.keys(customTools), ["Read"]);
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

  const explicit = createSdkCustomTools([readTool], () => {}, { hold: false });
  assert.ok(explicit);
  const explicitResult = explicit.Read.execute({ file_path: "src/index.ts" }, { toolCallId: "call_hold_false" });
  assert.equal(explicitResult instanceof Promise, false);
  assert.deepEqual(explicitResult, twoArgResult);
});

test("createSdkCustomTools hold:true still registers only Read when GetMcpTools is present", () => {
  const customTools = createSdkCustomTools([getMcpTools, taskTool, readTool], () => {}, {
    hold: true,
    onHold: () => {}
  });
  assert.ok(customTools);
  assert.deepEqual(Object.keys(customTools), ["Read"]);
});

test("matchesClientTool rejects GetMcpTools even when it is in the client tool list", () => {
  // 清单里带着宿主元工具也不能转发，否则外层会再开 MCP 发现 / 子代理。
  assert.equal(
    matchesClientTool({ id: "call_meta", name: "GetMcpTools", arguments: {} }, clientToolsWithMeta),
    false
  );
});

test("matchesClientTool accepts Read against the same client tool list", () => {
  assert.equal(
    matchesClientTool(
      { id: "call_read", name: "Read", arguments: { file_path: "src/index.ts" } },
      clientToolsWithMeta
    ),
    true
  );
});

test("matchesClientTool rejects mcp-wrapped GetMcpTools even when it is in the client tool list", () => {
  assert.equal(
    matchesClientTool(
      {
        id: "c",
        name: "mcp",
        arguments: {
          providerIdentifier: "custom-user-tools",
          toolName: "GetMcpTools",
          args: {}
        }
      },
      [
        { name: "GetMcpTools", inputSchema: {} },
        { name: "Read", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }
      ]
    ),
    false
  );
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
      clientToolsWithMeta
    ),
    { id: "call_mcp", name: "Read", arguments: { file_path: "src/index.ts" } }
  );
});
