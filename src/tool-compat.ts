import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import { sanitizeClientToolCallId } from "./session-hub.js";
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

/**
 * 永久隔离的宿主发现/控制工具：不得进 customTools、不得转发给客户端、
 * 历史结果不当 durable 增量。精确名、大小写不敏感。
 * GetDynamicTools 是现行 Cursor agent 的发现入口。
 *
 * Task / Agent / TaskOutput / TaskStop 不在此列——它们是「客户端委派候选」，
 * 只有当前请求 tools[] 实际声明了才注册/转发，网关绝不伪造。
 */
const ISOLATED_HOST_TOOL_NAMES = new Set([
  "getmcptools",
  "callmcptool",
  "getdynamictools",
  "calldynamictool",
  "fetchmcpresource",
  "listmcpresources",
  "mcp_auth",
  "skill",
  "slashcommand",
  "enterplanmode",
  "exitplanmode",
  "switchmode",
  "askuserquestion",
  "askquestion"
]);

/** IDE 子代理生命周期工具。候选 ≠ 自动注册；以入站声明为准。 */
const CLIENT_DELEGATE_TOOL_NAMES = new Set([
  "task",
  "agent",
  "taskoutput",
  "taskstop"
]);

export function isHostMetaTool(name: string): boolean {
  return ISOLATED_HOST_TOOL_NAMES.has(name.toLowerCase());
}

export function isClientDelegateTool(name: string): boolean {
  return CLIENT_DELEGATE_TOOL_NAMES.has(name.toLowerCase());
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
    path: ["file_path"],
    file_path: ["path"],
    target_file: ["path", "file_path"]
  },
  Write: {
    path: ["file_path"],
    file_path: ["path"],
    target_file: ["path", "file_path"],
    fileText: ["content"],
    file_text: ["content"]
  },
  Edit: {
    path: ["file_path"],
    file_path: ["path"],
    target_file: ["path", "file_path"]
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

/**
 * Stateless `execute` 假成功文案（诱导 agent 停手，随后 cancel）。
 * `hold: true` 路径禁止返回此字符串；文案本身锁定，cursor-runner 的双参调用依赖它。
 */
export const STATELESS_EXECUTE_ACCEPTED_TEXT =
  "Accepted. The caller will execute this tool and return the result in the next request. End your turn now without calling more tools.";

export type HeldToolResolve = (value: unknown) => void;
export type HeldToolReject = (reason?: unknown) => void;

export interface CreateSdkCustomToolsOptions {
  /**
   * false / 省略：同步返回假成功（今日 stateless，cursor-runner 双参调用）。
   * true：返回未 settle 的 Promise，经 `onHold` 交给 SessionHub。
   */
  hold?: boolean;
  onHold?: (toolCallId: string, resolve: HeldToolResolve, reject: HeldToolReject) => void;
}

export function createSdkCustomTools(
  tools: GatewayTool[],
  onToolCall: (toolCall: GatewayToolCall) => void,
  options?: CreateSdkCustomToolsOptions
): Record<string, SDKCustomTool> | undefined {
  const clientTools = filterHostMetaTools(tools);
  if (!clientTools.length) return undefined;
  const hold = options?.hold === true;
  const customTools: Record<string, SDKCustomTool> = {};
  for (const tool of clientTools) {
    if (!tool.name) continue;
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: sdkInputSchema(tool.inputSchema),
      execute: (args, context) => {
        const rawId = context.toolCallId ?? `call_${randomUUID().replaceAll("-", "")}`;
        const id = sanitizeClientToolCallId(rawId) || rawId;
        onToolCall(normalizeToolCallForClient({
          id,
          name: tool.name,
          arguments: jsonRecordToPlain(args)
        }, clientTools));
        if (hold) {
          return new Promise<SDKCustomToolResult>((resolve, reject) => {
            if (!options?.onHold) {
              reject(new Error("createSdkCustomTools hold:true requires onHold"));
              return;
            }
            options.onHold(id, (value) => resolve(value as SDKCustomToolResult), reject);
          });
        }
        // 必须返回“成功”而非 isError：错误结果会诱导 agent 重试改参数或改用内置工具，
        // 恰好产生外部客户端观察到的“参数错误/重复调用”。网关随后会 cancel 整个 run。
        return {
          content: [
            {
              type: "text",
              text: STATELESS_EXECUTE_ACCEPTED_TEXT
            }
          ]
        };
      }
    };
  }
  return Object.keys(customTools).length ? customTools : undefined;
}

export function normalizeToolCallForClient(toolCall: GatewayToolCall, tools: GatewayTool[]): GatewayToolCall {
  const withSafeId = withSanitizedToolCallId(toolCall);
  if (!tools.length) return withSafeId;
  const unwrapped = withSanitizedToolCallId(unwrapMcpToolCall(withSafeId, tools));
  const tool = findClientTool(unwrapped.name, tools);
  if (!tool) return unwrapped;
  return {
    ...unwrapped,
    name: tool.name,
    arguments: normalizeArguments(tool.name, unwrapped.arguments, tool.inputSchema)
  };
}

function withSanitizedToolCallId(toolCall: GatewayToolCall): GatewayToolCall {
  const id = sanitizeClientToolCallId(toolCall.id);
  return !id || id === toolCall.id ? toolCall : { ...toolCall, id };
}

/** 该调用（解包/别名映射后）是否命中客户端声明过的工具；未命中的内置工具调用不应转发给客户端。 */
export function matchesClientTool(toolCall: GatewayToolCall, tools: GatewayTool[]): boolean {
  if (!tools.length) return false;
  const unwrapped = unwrapMcpToolCall(toolCall, tools);
  // 发现/控制类即使客户端声明了也不转发。
  if (isHostMetaTool(unwrapped.name)) return false;
  if (isClientDelegateTool(unwrapped.name) && !delegateCallFromRegisteredMapping(toolCall, unwrapped, tools)) {
    return false;
  }
  return findClientTool(unwrapped.name, tools) !== undefined;
}

export function normalizeToolCallsForClient(toolCalls: GatewayToolCall[], tools: GatewayTool[]): GatewayToolCall[] {
  return toolCalls.map((toolCall) => normalizeToolCallForClient(toolCall, tools));
}

function unwrapMcpToolCall(toolCall: GatewayToolCall, tools: GatewayTool[] = []): GatewayToolCall {
  const envelope = unwrapCallEnvelope(toolCall);
  const args = envelope.arguments;
  const toolName = stringValue(args.toolName ?? args.tool_name ?? args.name);
  const provider = stringValue(args.providerIdentifier ?? args.provider_identifier ?? args.server);
  // 只接受 custom-user-tools / 裸 mcp 外壳。CallMcpTool 是客户端动态调用入口，不得当委派通道。
  if (toolName && isCustomUserToolsEnvelope(envelope.name, provider)) {
    if (isHostMetaTool(toolName)) return envelope;
    if (isClientDelegateTool(toolName) && !findClientTool(toolName, tools)) return envelope;
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
  if (envelope.name.toLowerCase().startsWith(customPrefix)) {
    const innerName = envelope.name.slice(customPrefix.length);
    if (isHostMetaTool(innerName)) return envelope;
    if (isClientDelegateTool(innerName) && !findClientTool(innerName, tools)) return envelope;
    return { ...envelope, name: innerName, arguments: args };
  }
  return envelope;
}

function isCustomUserToolsEnvelope(envelopeName: string, provider: string | undefined): boolean {
  if (provider === "custom-user-tools") return true;
  return envelopeName === "mcp";
}

/**
 * 委派类工具必须来自已注册的客户端映射：直呼声明名，或 custom-user-tools 外壳解包到声明名。
 * 不能仅因外壳叫 mcp / CallMcpTool 就放行 Task。
 */
function delegateCallFromRegisteredMapping(
  original: GatewayToolCall,
  unwrapped: GatewayToolCall,
  tools: GatewayTool[]
): boolean {
  if (!findClientTool(unwrapped.name, tools)) return false;
  if (findClientTool(original.name, tools)) return true;
  const provider = stringValue(original.arguments.providerIdentifier ?? original.arguments.provider_identifier ?? original.arguments.server);
  return isCustomUserToolsEnvelope(original.name, provider)
    || original.name.toLowerCase().startsWith("custom-user-tools-");
}

/** `to=Shell {"name":"Shell","arguments":{command}}` 不能把外壳当参数交给 Cursor。 */
function unwrapCallEnvelope(toolCall: GatewayToolCall): GatewayToolCall {
  const args = toolCall.arguments;
  const nested = recordValue(args.arguments ?? args.input);
  if (!nested) return toolCall;
  const keys = Object.keys(args);
  if (!keys.every((key) => key === "name" || key === "arguments" || key === "input" || key === "id")) return toolCall;
  return {
    ...toolCall,
    name: stringValue(args.name) ?? toolCall.name,
    arguments: nested
  };
}

/** Grok / GPT 方言常给工具名加 File、_file、Tool，或加上 `functions.` 前缀。 */
const NAME_DECORATION = /(_?(file|tool))$/i;

function findClientTool(name: string, tools: GatewayTool[]): GatewayTool | undefined {
  const lookup = stripFunctionsPrefix(name);
  const exact = tools.find((tool) => tool.name === lookup || tool.name === name);
  if (exact) return exact;
  const lower = lookup.toLowerCase();
  const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive;
  for (const tool of tools) {
    const aliases = TOOL_ALIASES[tool.name] ?? [];
    if (aliases.some((alias) => alias.toLowerCase() === lower)) return tool;
  }
  return uniqueDecoratedMatch(lookup, tools);
}

function stripFunctionsPrefix(name: string): string {
  const trimmed = name.trim();
  const prefixed = /^functions\.(.+)$/i.exec(trimmed);
  return prefixed ? prefixed[1] : trimmed;
}

/**
 * 声明表里只有 `Read`、模型却打出 `Readfile` / `ReadFile` / `read_file` 时，
 * 若去掉 File/_file/Tool 之后**恰好唯一**命中一个声明名，就认成那个。
 * 声明了 `Read` 和 `ReadFile` 时不猜——精确 / 大小写匹配已经先处理了 `ReadFile`。
 * 不硬编码 Cursor 工具名，自研 agent 的 `Search` → `SearchFile` 同样能对上。
 */
function uniqueDecoratedMatch(name: string, tools: GatewayTool[]): GatewayTool | undefined {
  const lower = name.toLowerCase();
  const stripped = lower.replace(NAME_DECORATION, "");
  if (!stripped || stripped === lower) return undefined;
  const matches = tools.filter((tool) => tool.name.toLowerCase() === stripped);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeArguments(toolName: string, args: Record<string, unknown>, inputSchema: unknown): Record<string, unknown> {
  const cleaned = dropInvalidNotifyOnOutput(args);
  const aliases = ARG_ALIASES[toolName];
  if (!aliases) return cleaned;
  const properties = schemaProperties(inputSchema);
  const normalized: Record<string, unknown> = { ...cleaned };
  for (const [from, targets] of Object.entries(aliases)) {
    // 只对“原始参数里就存在”的键改名，禁止对上一轮改名结果再改名（链式改写）。
    if (!(from in cleaned)) continue;
    // 来源键本身就在客户端 schema 里 → 已是合法键名，保持不动。
    if (properties.size && properties.has(from)) continue;
    // 有 schema 时选第一个真实存在于客户端 schema 的目标键；
    // 无 schema 时不猜测 flag 风格键（-A/-i 等），只落到常规命名的首个候选。
    const to = properties.size
      ? targets.find((candidate) => properties.has(candidate))
      : targets.find((candidate) => !candidate.startsWith("-"));
    if (!to || to === from) continue;
    if (normalized[to] === undefined) normalized[to] = cleaned[from];
    // 目标已有值（如 fileText/file_text 同义键并存）时也要删掉 schema 外的冗余来源键，严格 schema 客户端会拒绝多余键。
    delete normalized[from];
  }
  return normalized;
}

/**
 * Cursor 的 Shell.notify_on_output 必须是带 pattern 的对象。
 * Luna 常填 false / {} / {enabled:false}，会被客户端直接打回，模型再改用 Harmony 重试。
 * 非法值直接丢掉，等价于 Grok 从不填这个字段。
 */
function dropInvalidNotifyOnOutput(args: Record<string, unknown>): Record<string, unknown> {
  if (!("notify_on_output" in args)) return args;
  const value = args.notify_on_output;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { pattern?: unknown }).pattern === "string") {
    return args;
  }
  const next = { ...args };
  delete next.notify_on_output;
  return next;
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
