import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type { GatewayTool, GatewayToolCall } from "./types.js";

type JsonRecord = Record<string, SDKJsonValue>;

const TOOL_ALIASES: Record<string, string[]> = {
  Bash: ["shell", "Shell", "bash"],
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  Glob: ["glob"],
  Grep: ["grep"],
  LS: ["ls", "list"],
  WebFetch: ["webfetch", "web_fetch"],
  WebSearch: ["websearch", "web_search"]
};

/** Claude Code 宿主元工具不得进 customTools，否则内层会再演 MCP 发现或 Task 套娃。精确名、大小写不敏感。 */
const HOST_META_TOOL_NAMES = new Set([
  "getmcptools",
  "callmcptool",
  "fetchmcpresource",
  "listmcpresources",
  "mcp_auth",
  "task",
  "taskoutput",
  "taskstop",
  "agent",
  "skill",
  "slashcommand",
  "enterplanmode",
  "exitplanmode",
  "switchmode",
  "askuserquestion",
  "askquestion"
]);

export function isHostMetaTool(name: string): boolean {
  return HOST_META_TOOL_NAMES.has(name.toLowerCase());
}

export function filterHostMetaTools(tools: GatewayTool[]): GatewayTool[] {
  return tools.filter((tool) => !isHostMetaTool(tool.name));
}

/**
 * 参数改名映射：同一来源键可尝试多个目标键（按顺序取第一个存在于客户端 schema 的）。
 * 例如 Claude Code 的 Grep 用 `-A`/`-B`/`-C`/`-i`，其他客户端可能用 context_after 等长名。
 */
const ARG_ALIASES: Record<string, Record<string, string[]>> = {
  Read: {
    path: ["file_path"]
  },
  Write: {
    path: ["file_path"],
    fileText: ["content"],
    file_text: ["content"]
  },
  Edit: {
    path: ["file_path"]
  },
  Glob: {
    globPattern: ["pattern"],
    glob_pattern: ["pattern"],
    targetDirectory: ["path"],
    target_directory: ["path"]
  },
  Grep: {
    outputMode: ["output_mode"],
    headLimit: ["head_limit"],
    contextBefore: ["context_before", "-B"],
    contextAfter: ["context_after", "-A"],
    context_before: ["-B"],
    context_after: ["-A"],
    caseInsensitive: ["case_insensitive", "-i"],
    case_insensitive: ["-i"],
    sortAscending: ["sort_ascending"]
  }
};

export function createSdkCustomTools(
  tools: GatewayTool[],
  onToolCall: (toolCall: GatewayToolCall) => void
): Record<string, SDKCustomTool> | undefined {
  const clientTools = filterHostMetaTools(tools);
  if (!clientTools.length) return undefined;
  const customTools: Record<string, SDKCustomTool> = {};
  for (const tool of clientTools) {
    if (!tool.name) continue;
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: sdkInputSchema(tool.inputSchema),
      execute: (args, context) => {
        onToolCall(normalizeToolCallForClient({
          id: context.toolCallId ?? `call_${randomUUID().replaceAll("-", "")}`,
          name: tool.name,
          arguments: jsonRecordToPlain(args)
        }, clientTools));
        // 必须返回“成功”而非 isError：错误结果会诱导 agent 重试改参数或改用内置工具，
        // 恰好产生外部客户端观察到的“参数错误/重复调用”。网关随后会 cancel 整个 run。
        return {
          content: [
            {
              type: "text",
              text: "Accepted. The caller will execute this tool and return the result in the next request. End your turn now without calling more tools."
            }
          ]
        };
      }
    };
  }
  return Object.keys(customTools).length ? customTools : undefined;
}

export function normalizeToolCallForClient(toolCall: GatewayToolCall, tools: GatewayTool[]): GatewayToolCall {
  if (!tools.length) return toolCall;
  const unwrapped = unwrapMcpToolCall(toolCall);
  const tool = findClientTool(unwrapped.name, tools);
  if (!tool) return unwrapped;
  return {
    ...unwrapped,
    name: tool.name,
    arguments: normalizeArguments(tool.name, unwrapped.arguments, tool.inputSchema)
  };
}

/** 该调用（解包/别名映射后）是否命中客户端声明过的工具；未命中的内置工具调用不应转发给客户端。 */
export function matchesClientTool(toolCall: GatewayToolCall, tools: GatewayTool[]): boolean {
  if (!tools.length) return false;
  const unwrapped = unwrapMcpToolCall(toolCall);
  // unwrap 后内层 toolName 若是 GetMcpTools / Task 等宿主元名，直接 false，不转发。
  if (isHostMetaTool(unwrapped.name)) return false;
  return findClientTool(unwrapped.name, tools) !== undefined;
}

export function normalizeToolCallsForClient(toolCalls: GatewayToolCall[], tools: GatewayTool[]): GatewayToolCall[] {
  return toolCalls.map((toolCall) => normalizeToolCallForClient(toolCall, tools));
}

function unwrapMcpToolCall(toolCall: GatewayToolCall): GatewayToolCall {
  const args = toolCall.arguments;
  const toolName = stringValue(args.toolName ?? args.tool_name ?? args.name);
  const provider = stringValue(args.providerIdentifier ?? args.provider_identifier ?? args.server);
  if (toolName && (provider === "custom-user-tools" || toolCall.name === "mcp" || toolCall.name === "CallMcpTool")) {
    const nestedRaw = args.args ?? args.arguments ?? args.input;
    const nestedArgs = recordValue(nestedRaw);
    // 嵌套参数存在但无法解析（畸形 JSON 字符串等）时不能静默降级成 {}——那会给客户端发缺参调用。
    if (nestedRaw !== undefined && nestedRaw !== null && nestedArgs === undefined) {
      console.error(`[tool-compat] unparsable nested MCP args for tool "${toolName}"; dropping the wrapper unwrap`);
      return toolCall;
    }
    return { ...toolCall, name: toolName, arguments: nestedArgs ?? {} };
  }
  const customPrefix = "custom-user-tools-";
  if (toolCall.name.startsWith(customPrefix)) {
    return { ...toolCall, name: toolCall.name.slice(customPrefix.length), arguments: args };
  }
  return toolCall;
}

function findClientTool(name: string, tools: GatewayTool[]): GatewayTool | undefined {
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive;
  for (const tool of tools) {
    const aliases = TOOL_ALIASES[tool.name] ?? [];
    if (aliases.some((alias) => alias.toLowerCase() === lower)) return tool;
  }
  return undefined;
}

function normalizeArguments(toolName: string, args: Record<string, unknown>, inputSchema: unknown): Record<string, unknown> {
  const aliases = ARG_ALIASES[toolName];
  if (!aliases) return args;
  const properties = schemaProperties(inputSchema);
  const normalized: Record<string, unknown> = { ...args };
  for (const [from, targets] of Object.entries(aliases)) {
    // 只对“原始参数里就存在”的键改名，禁止对上一轮改名结果再改名（链式改写）。
    if (!(from in args)) continue;
    // 来源键本身就在客户端 schema 里 → 已是合法键名，保持不动。
    if (properties.size && properties.has(from)) continue;
    // 有 schema 时选第一个真实存在于客户端 schema 的目标键；
    // 无 schema 时不猜测 flag 风格键（-A/-i 等），只落到常规命名的首个候选。
    const to = properties.size
      ? targets.find((candidate) => properties.has(candidate))
      : targets.find((candidate) => !candidate.startsWith("-"));
    if (!to || to === from) continue;
    if (normalized[to] === undefined) normalized[to] = args[from];
    // 目标已有值（如 fileText/file_text 同义键并存）时也要删掉 schema 外的冗余来源键，严格 schema 客户端会拒绝多余键。
    delete normalized[from];
  }
  return normalized;
}

function schemaProperties(inputSchema: unknown): Set<string> {
  const schema = recordValue(inputSchema);
  const properties = recordValue(schema?.properties);
  return new Set(properties ? Object.keys(properties) : []);
}

function sdkInputSchema(value: unknown): JsonRecord {
  const sanitized = sanitizeJsonValue(value);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) return sanitized as JsonRecord;
  return { type: "object", properties: {} };
}

function sanitizeJsonValue(value: unknown): SDKJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.flatMap((item) => {
    const sanitized = sanitizeJsonValue(item);
    return sanitized === undefined ? [] : [sanitized];
  });
  if (value && typeof value === "object") {
    const record: JsonRecord = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeJsonValue(item);
      if (sanitized !== undefined) record[key] = sanitized;
    }
    return record;
  }
  return undefined;
}

function jsonRecordToPlain(value: Record<string, SDKJsonValue>): Record<string, unknown> {
  return { ...value };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return recordValue(parsed);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
