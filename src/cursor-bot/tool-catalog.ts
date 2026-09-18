import type { GatewayTool } from "../types.js";
import { shouldAdvertiseBotTools, type BotInferenceRoute } from "./request-builder.js";

/**
 * 不能把 `tools[]` 写进 InferenceService 时（grok；以及 api2 直连的所有模型），
 * 自研 agent / byok 以外的客户端通常也**只**在入站 `tools[]` 里声明工具，
 * 不会再把清单抄进 system。结构化 `tools[]` 能看见这些名字；
 * 看不见时就会退回训练先验（ReadFile 等），把 `Read` 叫成 `Readfile`。
 *
 * 这份卡片按**本轮真实工具表**生成，不硬编码 Cursor 工具名。
 * 只在「本轮不会向上游声明 tools[]」时注入。
 */
export function unadvertisedToolCatalog(
  tools: GatewayTool[] | undefined,
  modelId: string,
  advertiseOverride?: boolean,
  route?: BotInferenceRoute
): string | undefined {
  if (!tools?.length) return undefined;
  if (shouldAdvertiseBotTools(modelId, advertiseOverride, route)) return undefined;
  const lines = tools.flatMap((tool) => {
    const name = tool.name?.trim();
    return name ? [`- ${name}${argumentHint(tool)}`] : [];
  });
  if (!lines.length) return undefined;
  return [
    "CLIENT TOOLS: call these exact names. Do not rename, translate, camelCase-join, or append File / Tool / _file.",
    "A listed tool is provided by the caller and is available. Never substitute a different name for it.",
    ...lines,
    'Call through the structured tool interface, or with ONLY: <tool_call>{"name":"EXACT_NAME","arguments":{}}</tool_call>'
  ].join("\n");
}

export function withUnadvertisedToolCatalog<T extends { systemInstructions: string[]; tools: GatewayTool[] }>(
  conversation: T,
  modelId: string,
  advertiseOverride?: boolean,
  route?: BotInferenceRoute
): T {
  const text = unadvertisedToolCatalog(conversation.tools, modelId, advertiseOverride, route);
  if (!text) return conversation;
  return { ...conversation, systemInstructions: [...conversation.systemInstructions, text] };
}

function argumentHint(tool: GatewayTool): string {
  const keys = schemaKeys(tool.inputSchema);
  return keys.length ? ` — arguments: ${keys.join(", ")}` : "";
}

function schemaKeys(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return [];
  const schema = inputSchema as Record<string, unknown>;
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  // 必填键在前，其余按 schema 原序；上限只是防一份巨型 JSON schema 把 system 撑爆。
  const ordered = [...required.filter((key) => properties.includes(key)), ...properties.filter((key) => !required.includes(key))];
  return ordered.slice(0, 8);
}
