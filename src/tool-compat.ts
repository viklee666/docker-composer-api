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

const ARG_ALIASES: Record<string, Record<string, string>> = {
  Read: {
    path: "file_path"
  },
  Write: {
    path: "file_path",
    fileText: "content",
    file_text: "content"
  },
  Edit: {
    path: "file_path"
  },
  Glob: {
    globPattern: "pattern",
    glob_pattern: "pattern",
    targetDirectory: "path",
    target_directory: "path"
  },
  Grep: {
    outputMode: "output_mode",
    headLimit: "head_limit",
    contextBefore: "context_before",
    contextAfter: "context_after",
    caseInsensitive: "case_insensitive",
    sortAscending: "sort_ascending"
  }
};

export function createSdkCustomTools(
  tools: GatewayTool[],
  onToolCall: (toolCall: GatewayToolCall) => void
): Record<string, SDKCustomTool> | undefined {
  if (!tools.length) return undefined;
  const customTools: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
    if (!tool.name) continue;
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: sdkInputSchema(tool.inputSchema),
      execute: (args, context) => {
        onToolCall(normalizeToolCallForClient({
          id: context.toolCallId ?? `call_${randomUUID().replaceAll("-", "")}`,
          name: tool.name,
          arguments: jsonRecordToPlain(args)
        }, tools));
        return {
          content: [
            {
              type: "text",
              text: "Tool call captured by the API gateway and returned to the caller for client-side execution."
            }
          ],
          isError: true
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

export function normalizeToolCallsForClient(toolCalls: GatewayToolCall[], tools: GatewayTool[]): GatewayToolCall[] {
  return toolCalls.map((toolCall) => normalizeToolCallForClient(toolCall, tools));
}

function unwrapMcpToolCall(toolCall: GatewayToolCall): GatewayToolCall {
  const args = toolCall.arguments;
  const toolName = stringValue(args.toolName ?? args.tool_name ?? args.name);
  const provider = stringValue(args.providerIdentifier ?? args.provider_identifier ?? args.server);
  const nestedArgs = recordValue(args.args ?? args.arguments ?? args.input) ?? {};
  if (toolName && (provider === "custom-user-tools" || toolCall.name === "mcp" || toolCall.name === "CallMcpTool")) {
    return { ...toolCall, name: toolName, arguments: nestedArgs };
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
  for (const [from, to] of Object.entries(aliases)) {
    if (!(from in normalized) || normalized[to] !== undefined) continue;
    if (properties.size && !properties.has(to)) continue;
    normalized[to] = normalized[from];
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
