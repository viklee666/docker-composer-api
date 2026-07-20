import { randomUUID, createHash } from "node:crypto";
import { ApiError } from "./errors.js";
import { classifyErrorText, classifyKeyFailure, errorMessage } from "./key-pool.js";
import { resolveModelParams, type ModelCatalog, type ModelIntent } from "./model-params.js";
import { parseToolMarkers } from "./protocol.js";
import { createSdkCustomTools, normalizeToolCallForClient, normalizeToolCallsForClient } from "./tool-compat.js";
import type {
  AgentMode,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayToolCall,
  ModelParameterValue,
  StateStore
} from "./types.js";

/** 解析后可直接发给 SDK 的模型选择 + 会话模式。 */
interface ResolvedModelRun {
  model: { id: string; params?: ModelParameterValue[] };
  mode?: AgentMode;
}

export interface AgentLike {
  agentId?: string;
  send(message: unknown, options: Record<string, unknown>): Promise<RunLike>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

interface RunLike {
  id?: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<unknown>;
  cancel?: () => Promise<unknown>;
}

export interface AgentFactory {
  create(options: Record<string, unknown>): Promise<AgentLike>;
  resume?(agentId: string, options: Record<string, unknown>): Promise<AgentLike>;
}

export class CursorSdkRunner implements CursorRunner {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: StateStore,
    private readonly input: {
      defaultWorkingDirectory: string;
      sdkClientVersion: string;
      /** 为 API 网关默认使用“每次请求 fresh agent”，避免远端 agent 会话长期累积/污染后所有请求持续 502。 */
      disableSessionResume?: boolean;
      /** 用于按模型发现目录（Cursor.models.list() 的参数定义 + variants），把思考强度/Max Mode 等语义意图解析成合法 model.params。 */
      getModelCatalog?: (modelId: string, apiKey?: string) => Promise<ModelCatalog | undefined>;
    },
    private readonly agentFactory?: AgentFactory
  ) {}

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    const events = this.stream(input, signal);
    let result: CursorRunResult | undefined;
    let text = "";
    const toolCalls: GatewayToolCall[] = [];
    for await (const event of events) {
      if (event.type === "text") text += event.text;
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
      if (event.type === "done") result = event.result;
    }
    return result ?? { text, toolCalls };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    if (signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");
    const id = sessionId(input);
    yield* this.withSessionLock(id, () => this.streamLocked(input, signal, id));
  }

  private async *streamLocked(input: CursorRunRequest, signal: AbortSignal | undefined, id: string): AsyncIterable<CursorStreamEvent> {
    const factory = this.agentFactory ?? await this.loadAgentFactory();
    const resolved = await this.resolveModelRun(input);
    const existingAgentId = this.input.disableSessionResume ? undefined : await this.store.getSession(id);
    let resumedAgent: AgentLike | undefined;
    if (existingAgentId && typeof factory.resume === "function") {
      try {
        resumedAgent = await factory.resume(existingAgentId, this.agentOptions(input, resolved));
      } catch (error) {
        const keyError = keySemanticApiError(input.model, error);
        if (keyError) throw keyError;
        // 旧 agent 明确不可 resume，清掉后走新建。
        await this.store.deleteSession(id).catch(() => undefined);
      }
    }

    if (resumedAgent) {
      try {
        yield* this.runWithAgent(resumedAgent, input, signal, id, resolved);
        return;
      } catch (error) {
        if (!isRetryableStaleSessionError(error) && !isActiveRunError(error)) throw error;
        // 旧 agent 可能已过期，或仍有 CREATING/RUNNING run；清掉绑定后用 fresh agent 避免客户端重试卡死。
        await this.store.deleteSession(id).catch(() => undefined);
      }
    }

    const agent = await factory.create(this.agentOptions(input, resolved)).catch((error) => {
      throw keySemanticApiError(input.model, error) ?? error;
    });
    yield* this.runWithAgent(agent, input, signal, id, resolved);
  }

  /** 把请求里的模型运行意图解析成可直接发给 SDK 的模型选择（model.params）+ 会话模式。 */
  private async resolveModelRun(input: CursorRunRequest): Promise<ResolvedModelRun> {
    const intent: ModelIntent = {
      reasoningEffort: input.reasoningEffort,
      maxMode: input.maxMode,
      fast: input.fast,
      params: input.modelParams,
      mode: input.mode
    };
    const needsCatalog = intent.reasoningEffort !== undefined || intent.maxMode !== undefined || intent.fast !== undefined;
    let catalog: ModelCatalog | undefined;
    if (needsCatalog && this.input.getModelCatalog) {
      catalog = await this.input.getModelCatalog(input.model, input.apiKey).catch(() => undefined);
    }
    const resolved = resolveModelParams(catalog, intent, input.model);
    logDroppedIntent(input.model, resolved.dropped, resolved.usedFallback);
    const model: ResolvedModelRun["model"] = { id: input.model };
    if (resolved.params.length) model.params = resolved.params;
    return { model, ...(intent.mode ? { mode: intent.mode } : {}) };
  }

  private async *withSessionLock(id: string, run: () => AsyncIterable<CursorStreamEvent>): AsyncIterable<CursorStreamEvent> {
    const previous = this.sessionLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.sessionLocks.set(id, current);
    await previous.catch(() => undefined);
    try {
      yield* run();
    } finally {
      release();
      if (this.sessionLocks.get(id) === current) this.sessionLocks.delete(id);
    }
  }

  private async *runWithAgent(
    agent: AgentLike,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    id: string,
    resolved: ResolvedModelRun
  ): AsyncIterable<CursorStreamEvent> {
    try {
      if (signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");
      const capturedToolCalls: GatewayToolCall[] = [];
      const customTools = createSdkCustomTools(input.tools, (toolCall) => pushToolCall(capturedToolCalls, toolCall));
      const run = await this.sendWithOptionalCustomTools(agent, input, customTools, resolved);
      const textParts: string[] = [];
      const toolCalls: GatewayToolCall[] = [];
      const streamErrorDetails: string[] = [];

      try {
        try {
          for await (const event of run.stream()) {
            if (signal?.aborted) {
              await run.cancel?.().catch(() => undefined);
              throw new ApiError("Request was aborted.", 499, "request_aborted");
            }
            const text = textFromSdkEvent(event);
            if (text) {
              textParts.push(text);
              if (!input.tools.length) yield { type: "text", text };
            }
            const errorDetail = errorDetailFromSdkEvent(event);
            if (errorDetail) streamErrorDetails.push(errorDetail);
            const sdkToolCalls = toolCallsFromSdkEvent(event);
            if (sdkToolCalls.length) {
              for (const toolCall of sdkToolCalls) {
                const normalized = normalizeToolCallForClient(toolCall, input.tools);
                pushToolCall(toolCalls, normalized);
                yield { type: "tool_call", toolCall: normalized };
              }
              // 捕获工具调用后立即取消，避免 SDK 在容器内继续执行本地工具。
              await run.cancel?.().catch(() => undefined);
              break;
            }
            const captured = pendingCapturedToolCalls(capturedToolCalls, toolCalls);
            if (captured.length) {
              for (const toolCall of captured) {
                pushToolCall(toolCalls, toolCall);
                yield { type: "tool_call", toolCall };
              }
              await run.cancel?.().catch(() => undefined);
              break;
            }
          }
        } catch (error) {
          if (signal?.aborted || !capturedToolCalls.length) throw error;
          // 自定义工具回调已捕获到调用时，即使 SDK 后续因取消/工具结果报错，也应把调用返回给客户端。
        }
      } finally {
        // Cursor SDK 的 wait 可能在取消工具调用后抛错；此处只用它补齐纯文本结果。
      }

      const missedCapturedToolCalls = pendingCapturedToolCalls(capturedToolCalls, toolCalls);
      if (missedCapturedToolCalls.length) {
        for (const toolCall of missedCapturedToolCalls) {
          pushToolCall(toolCalls, toolCall);
          yield { type: "tool_call", toolCall };
        }
        await run.cancel?.().catch(() => undefined);
      }

      const waited = await run.wait().catch(() => undefined);
      const waitedText = resultText(waited);
      if (!toolCalls.length && !textParts.length && waitedText) {
        textParts.push(waitedText);
        yield { type: "text", text: waitedText };
      }

      // run 以 error 收场且没有任何产出时必须显式报错，否则会变成空 200。
      // Cursor SDK 在 run 失败时通常只回裸 status="error"、不带 error/message 详情（官方已确认的 SDK 行为），
      // 真实原因可能是：额度/配额耗尽、上游临时容量不足（resource_exhausted，多会自行恢复）、
      // key 失效，或该模型不被 API/SDK 通道支持。这里尽量从结果里提取可用详情，避免单一归因误导排查。
      if (!textParts.length && !toolCalls.length && runStatus(waited) === "error") {
        throw upstreamRunError(input.model, uniqueJoined([...streamErrorDetails, runErrorDetail(waited)]));
      }

      const parsed = parseToolMarkers(textParts.join(""));
      const finalToolCalls = normalizeToolCallsForClient(toolCalls.length ? toolCalls : parsed.toolCalls, input.tools);
      const finalText = finalToolCalls.length ? "" : parsed.text;
      if (input.tools.length && !finalToolCalls.length && finalText) {
        yield { type: "text", text: finalText };
      }
      if (input.tools.length && finalToolCalls.length && !toolCalls.length) {
        for (const toolCall of finalToolCalls) yield { type: "tool_call", toolCall };
      }
      const result: CursorRunResult = {
        text: finalText,
        toolCalls: finalToolCalls,
        agentId: agent.agentId,
        runId: run.id
      };
      if (!this.input.disableSessionResume && agent.agentId) await this.store.saveSession(id, agent.agentId);
      yield { type: "done", result };
    } finally {
      await disposeAgent(agent);
    }
  }

  private async sendWithOptionalCustomTools(
    agent: AgentLike,
    input: CursorRunRequest,
    customTools: Record<string, unknown> | undefined,
    resolved: ResolvedModelRun
  ): Promise<RunLike> {
    const options = () => ({
      model: resolved.model,
      idempotencyKey: randomUUID(),
      ...(resolved.mode ? { mode: resolved.mode } : {})
    });
    if (!customTools) return agent.send(this.sdkMessage(input), options());
    try {
      return await agent.send(this.sdkMessage(input), {
        ...options(),
        local: { customTools }
      });
    } catch (error) {
      const keyError = keySemanticApiError(input.model, error);
      if (keyError) throw keyError;
      if (!isCustomToolsUnsupportedError(error)) throw error;
      return agent.send(this.sdkMessage(input), options());
    }
  }

  private async loadAgentFactory(): Promise<AgentFactory> {
    const { Agent } = await import("@cursor/sdk") as Record<string, unknown>;
    if (!Agent || typeof Agent !== "function" && typeof Agent !== "object") {
      throw new ApiError("@cursor/sdk Agent export is unavailable.", 500, "cursor_sdk_unavailable");
    }
    return Agent as AgentFactory;
  }

  private agentOptions(input: CursorRunRequest, resolved: ResolvedModelRun): Record<string, unknown> {
    return {
      apiKey: input.apiKey,
      model: resolved.model,
      name: "Docker Composer API",
      // settingSources: [] 显式关闭环境规则加载，绝不把调用方机器/项目/团队的 Cursor 规则
      //（~/.cursor、.cursor/rules、AGENTS.md 等）注入到请求里，避免夹带额外提示词。
      local: { cwd: input.workingDirectory || this.input.defaultWorkingDirectory, settingSources: [] },
      clientVersion: this.input.sdkClientVersion,
      ...(resolved.mode ? { mode: resolved.mode } : {})
    };
  }

  private sdkMessage(input: CursorRunRequest): unknown {
    if (!input.images.length) return input.prompt;
    return {
      text: input.prompt,
      images: input.images.map((image) => image.source === "url"
        ? { url: image.data }
        : { data: image.data, mimeType: image.mediaType ?? "image/png" })
    };
  }
}

/** 相同 (model, 详情) 的丢弃/兜底日志 10 分钟内只打一次，避免高流量刷屏。 */
const droppedIntentLoggedAt = new Map<string, number>();
const DROPPED_INTENT_LOG_TTL_MS = 10 * 60 * 1000;

function logDroppedIntent(model: string, dropped: string[], usedFallback: boolean): void {
  if (!dropped.length && !usedFallback) return;
  const detail = [
    dropped.length ? `dropped: ${dropped.join(", ")} (no matching model parameter)` : "",
    usedFallback ? "catalog discovery unavailable; used built-in family fallback mapping" : ""
  ].filter(Boolean).join("; ");
  const key = `${model}\0${detail}`;
  const last = droppedIntentLoggedAt.get(key) ?? 0;
  const now = Date.now();
  if (now - last < DROPPED_INTENT_LOG_TTL_MS) return;
  droppedIntentLoggedAt.set(key, now);
  console.error(`[model-params] model="${model}" ${detail}`);
}

function sessionId(input: CursorRunRequest): string {
  return createHash("sha256")
    .update([input.apiKey, input.model, input.sessionKey, input.workingDirectory ?? ""].join("\0"))
    .digest("hex");
}

function textFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "status" || type === "thinking" || type === "thinkingMessage") return "";
  if (type === "assistant") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.flatMap((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("");
  }
  if (typeof record.text === "string") return record.text;
  if (typeof record.delta === "string") return record.delta;
  return "";
}

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : "";
  if (typeof record.result === "string") return record.result;
  if (typeof record.text === "string") return record.text;
  return "";
}

function runStatus(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.status === "string" ? record.status : "";
}

/** 从 SDK stream 的 status/result/error 事件中提取非正文错误详情，用于避免 terminal error 变成“no details”。 */
function errorDetailFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const parts: string[] = [];
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (type === "status" && ["error", "failed", "expired"].includes(status)) {
    pushString(parts, record.message);
    pushString(parts, record.status);
  }
  if (type === "result" && status === "error") {
    pushString(parts, record.errorCode);
    pushString(parts, record.message);
    pushErrorLike(parts, record.error);
  }
  if (type === "error") {
    pushString(parts, record.message);
    pushString(parts, record.code);
    pushString(parts, record.reason);
    pushErrorLike(parts, record.error);
  }
  pushErrorLike(parts, asRecord(record.message)?.error);
  return uniqueJoined(parts);
}

/** 尽量从 SDK run 结果里抽取错误详情（多数版本不提供，提供时用于精确归因与日志）。 */
function runErrorDetail(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const parts: string[] = [];
  for (const field of ["error", "message", "code", "reason", "detail", "details"]) {
    const raw = record[field];
    if (typeof raw === "string" && raw.trim()) {
      parts.push(raw.trim());
    } else {
      const nested = asRecord(raw);
      const message = nested && typeof nested.message === "string" ? nested.message : undefined;
      if (message?.trim()) parts.push(message.trim());
    }
  }
  return [...new Set(parts)].join("; ").slice(0, 300);
}

/**
 * 把 SDK「裸 error 收场」转成网关错误并选择合适的 code。
 * - 无详情（多数 SDK 版本如此）→ upstream_run_failed(502)，按 transient 处理：
 *   由 KeyRotatingRunner 换下一个 key 重试而不禁用，避免临时容量不足误伤好 key。
 * - 带出额度/认证类详情时 → 解耦为 insufficient_quota(402) / unauthorized(401)，
 *   让真正耗尽额度或失效的 key 能被 classifyKeyFailure 识别并禁用，而非被 transient 吞掉。
 * 注意：quota/auth 文案里不含 "upstream_run_failed" token，以免又被 transient 正则抢先命中。
 */
export function upstreamRunError(model: string, detail: string): ApiError {
  const kind = detail ? classifyErrorText(detail) : undefined;
  if (kind === "quota") {
    return new ApiError(
      `Cursor upstream run ended in error for model "${model}": ${detail}. ` +
      "This key appears to be out of quota/credit; the gateway will disable it and rotate to the next pool key.",
      402,
      "insufficient_quota"
    );
  }
  if (kind === "auth") {
    return new ApiError(
      `Cursor upstream run ended in error for model "${model}": ${detail}. ` +
      "This key appears invalid or unauthorized; the gateway will disable it and rotate to the next pool key.",
      401,
      "unauthorized"
    );
  }
  return new ApiError(
    `Cursor upstream run ended in error for model "${model}"` +
    (detail ? `: ${detail}` : " with no details provided by upstream") +
    ". Likely causes: quota/credit exhausted, a temporary Cursor capacity shortage (often self-recovers), " +
    "or a model not runnable via the API/SDK channel. The gateway will try the next pool key automatically; " +
    "if it persists, retry shortly or use composer-2.5 / composer-2.5-fast / auto.",
    502,
    "upstream_run_failed"
  );
}

function keySemanticApiError(model: string, error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  const failure = classifyKeyFailure(error);
  const message = errorMessage(error);
  const detail = message === "{}" ? "" : message;
  if (failure === "quota") {
    return new ApiError(
      `Cursor upstream rejected the request for model "${model}": ${detail || "quota/credit exhausted"}. ` +
      "This key appears to be out of quota/credit; the gateway will disable it and rotate to the next pool key.",
      402,
      "insufficient_quota"
    );
  }
  if (failure === "auth") {
    return new ApiError(
      `Cursor upstream rejected the request for model "${model}": ${detail || "invalid or unauthorized API key"}. ` +
      "This key appears invalid or unauthorized; the gateway will disable it and rotate to the next pool key.",
      401,
      "unauthorized"
    );
  }
  return undefined;
}

function isRetryableStaleSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_run_failed";
}

function isActiveRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has active run|agent is busy|AgentBusyError/i.test(message);
}

export function toolCallsFromSdkEvent(event: unknown): GatewayToolCall[] {
  const record = asRecord(event);
  if (!record) return [];
  if (record.type === "assistant") return toolCallsFromAssistantMessage(record);
  const raw = record.type === "tool_call" ? record.toolCall ?? record.tool_call ?? record : undefined;
  const tool = asRecord(raw);
  if (!tool) return [];
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!name) return [];
  const status = stringValue(tool.status);
  if (status && status !== "completed") return [];
  const truncated = asRecord(tool.truncated);
  if (truncated?.args === true) return [];
  const args = objectArgs(tool.arguments) ?? objectArgs(tool.args) ?? objectArgs(tool.input);
  if (!args) return [];
  return [{
    id: stringValue(tool.id) ?? stringValue(tool.call_id) ?? stringValue(tool.callId) ?? `call_${randomUUID().replaceAll("-", "")}`,
    name,
    arguments: args
  }];
}

function toolCallsFromAssistantMessage(record: Record<string, unknown>): GatewayToolCall[] {
  const message = asRecord(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolCalls: GatewayToolCall[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (item?.type !== "tool_use") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    toolCalls.push({
      id: stringValue(item.id) ?? `call_${randomUUID().replaceAll("-", "")}`,
      name,
      arguments: objectArgs(item.input) ?? {}
    });
  }
  return toolCalls;
}

function isCustomToolsUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /custom local tools|local\.customTools|only supported for local sdk agents/i.test(message);
}

function pushToolCall(toolCalls: GatewayToolCall[], toolCall: GatewayToolCall): void {
  const existingIndex = toolCalls.findIndex((item) => item.id === toolCall.id);
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = toolCall;
    return;
  }
  toolCalls.push(toolCall);
}

function pendingCapturedToolCalls(captured: GatewayToolCall[], emitted: GatewayToolCall[]): GatewayToolCall[] {
  return captured.filter((toolCall) => !emitted.some((item) => item.id === toolCall.id));
}

function objectArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return objectArgs(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pushString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) parts.push(value.trim());
}

function pushErrorLike(parts: string[], value: unknown): void {
  if (typeof value === "string") {
    pushString(parts, value);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const field of ["message", "code", "reason", "detail", "details", "error"]) {
    const raw = record[field];
    if (typeof raw === "string") pushString(parts, raw);
    else if (field === "error") pushErrorLike(parts, raw);
  }
}

function uniqueJoined(parts: string[]): string {
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join("; ").slice(0, 300);
}

async function disposeAgent(agent: AgentLike): Promise<void> {
  const asyncDispose = agent[Symbol.asyncDispose];
  if (asyncDispose) {
    await asyncDispose.call(agent).catch(() => undefined);
    return;
  }
  try {
    agent.close?.();
  } catch {
    // best-effort cleanup only
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
