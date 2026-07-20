import { Readable } from "node:stream";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./admin.js";
import { authenticate, extractToken, sessionAffinity } from "./auth.js";
import { anthropicError, ApiError, normalizeError, openAiError } from "./errors.js";
import type { CursorKeyPool } from "./key-pool.js";
import { errorMessage } from "./key-pool.js";
import { mergeIntents, parseModelParamsSpec, type ModelIntent } from "./model-params.js";
import { listAvailableModels, openAiModelList, openAiModelObject, type ModelLister } from "./models.js";
import {
  anthropicMessageObject,
  anthropicToolUse,
  anthropicUsage,
  chatCompletionObject,
  openAiToolCall,
  openAiUsage,
  prepareAnthropicMessages,
  prepareOpenAiChat,
  prepareOpenAiResponses,
  responseListObject,
  responseObject,
  responseToolCallItem,
  responsesUsage,
  toRunRequest,
  type PreparedRequest
} from "./protocol.js";
import { sse, sseDone } from "./sse.js";
import type {
  AuthContext,
  CursorRunResult,
  CursorRunner,
  GatewayConfig,
  KeyUsageRef,
  RequestLogRecord,
  StateStore
} from "./types.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

export interface AppDeps {
  config: GatewayConfig;
  store: StateStore;
  runner: CursorRunner;
  keyPool: CursorKeyPool;
  startedAt?: number;
  /** 模型列表来源，默认走 Cursor SDK（测试时可注入桩）。 */
  modelLister?: ModelLister;
  /** SDK 网络配置应用器，测试时可注入桩以避免加载真实 SDK。 */
  applyCursorSdkNetworkConfig?: (useHttp1ForAgent: boolean) => Promise<void>;
}

interface RequestLog {
  endpoint: string;
  model?: string;
  authMode: RequestLogRecord["authMode"];
  keyUsageRef: KeyUsageRef;
  stream: boolean;
  startedAt: number;
  finished: boolean;
}

export function createApp(deps: AppDeps): FastifyInstance {
  const app = fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  deps.startedAt ??= Date.now();

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS")
      .header("access-control-allow-headers", "authorization,x-api-key,content-type,anthropic-version,anthropic-beta,x-session-affinity,x-opencode-session-id,x-opencode-session,anthropic-session-id,x-cursor-reasoning-effort,x-cursor-max-mode,x-cursor-fast,x-cursor-mode,x-cursor-model-params")
      .header("access-control-max-age", "86400");
    if (request.method === "OPTIONS") {
      reply.status(204).send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    const body = request.url.startsWith("/v1/messages") ? anthropicError(normalized) : openAiError(normalized);
    reply.status(normalized.statusCode).send(body);
  });

  app.get("/health", async () => ({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    cursorSdk: true,
    storage: "sqlite"
  }));

  app.get("/v1/models", async (request) => {
    const { models } = await listModels(deps, request);
    return openAiModelList(models);
  });

  app.get("/v1/models/:id", async (request) => {
    const id = routeParam(request.params, "id");
    const { models } = await listModels(deps, request);
    const found = models.find((model) => model.id === id || model.aliases.includes(id));
    if (!found) throw new ApiError(`Model '${id}' not found.`, 404, "not_found", "model");
    return openAiModelObject(found);
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const auth = authenticate(request, deps.config);
    const prepared = prepareOpenAiChat(request.body);
    const id = `chatcmpl_${compactId()}`;
    const created = nowSeconds();
    const log = beginLog("/v1/chat/completions", auth, prepared);
    const run = toRunRequest({
      prepared,
      protocol: "openai-chat",
      auth,
      sessionKey: sessionAffinity(request, auth.ownerHash),
      workingDirectory: deps.config.cursorWorkingDirectory,
      keyUsageRef: log.keyUsageRef,
      controls: requestModelControls(request, deps.config)
    });
    if (prepared.stream) {
      return sendSse(reply, withStreamLog(deps, log, chatStream({ id, created, prepared, auth, run, deps })));
    }
    const output = await runLogged(deps, log, run);
    return chatCompletionObject({ id, created, prepared, output });
  });

  app.post("/v1/responses", async (request, reply) => {
    const auth = authenticate(request, deps.config);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const previousResponseId = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
    const previous = previousResponseId ? await deps.store.getResponse(previousResponseId, auth.ownerHash) : undefined;
    if (previousResponseId && !previous) throw new ApiError("Previous response not found.", 404, "not_found", "previous_response_id");
    const prepared = prepareOpenAiResponses(body, previous ? { response: previous.response, inputItems: previous.inputItems } : undefined);
    const id = `resp_${compactId()}`;
    const created = nowSeconds();
    const log = beginLog("/v1/responses", auth, prepared);
    const run = toRunRequest({
      prepared,
      protocol: "openai-responses",
      auth,
      sessionKey: sessionAffinity(request, previousResponseId ?? auth.ownerHash),
      workingDirectory: deps.config.cursorWorkingDirectory,
      keyUsageRef: log.keyUsageRef,
      controls: requestModelControls(request, deps.config)
    });
    if (prepared.stream) {
      return sendSse(reply, withStreamLog(deps, log, responsesStream({ id, created, prepared, previousResponseId, auth, run, deps })));
    }
    const output = await runLogged(deps, log, run);
    const response = responseObject({ id, created, prepared, output, previousResponseId });
    await saveResponse(deps, auth, id, response, prepared.inputItems);
    return response;
  });

  app.get("/v1/responses/:id", async (request) => {
    const auth = authenticate(request, deps.config);
    const id = routeParam(request.params, "id");
    const record = await deps.store.getResponse(id, auth.ownerHash);
    if (!record) throw new ApiError("Response not found.", 404, "not_found");
    return record.response;
  });

  app.delete("/v1/responses/:id", async (request) => {
    const auth = authenticate(request, deps.config);
    const id = routeParam(request.params, "id");
    const deleted = await deps.store.deleteResponse(id, auth.ownerHash);
    if (!deleted) throw new ApiError("Response not found.", 404, "not_found");
    return { id, object: "response.deleted", deleted: true };
  });

  app.get("/v1/responses/:id/input_items", async (request) => {
    const auth = authenticate(request, deps.config);
    const id = routeParam(request.params, "id");
    const record = await deps.store.getResponse(id, auth.ownerHash);
    if (!record) throw new ApiError("Response not found.", 404, "not_found");
    return responseListObject(record.inputItems);
  });

  app.post("/v1/messages", async (request, reply) => {
    const auth = authenticate(request, deps.config);
    const prepared = prepareAnthropicMessages(request.body);
    const id = `msg_${compactId()}`;
    const log = beginLog("/v1/messages", auth, prepared);
    const run = toRunRequest({
      prepared,
      protocol: "anthropic-messages",
      auth,
      sessionKey: sessionAffinity(request, auth.ownerHash),
      workingDirectory: deps.config.cursorWorkingDirectory,
      keyUsageRef: log.keyUsageRef,
      controls: requestModelControls(request, deps.config)
    });
    if (prepared.stream) {
      return sendSse(reply, withStreamLog(deps, log, anthropicStream({ id, prepared, run, deps })));
    }
    const output = await runLogged(deps, log, run);
    return anthropicMessageObject({ id, prepared, output });
  });

  registerAdminRoutes(app, deps);

  return app;
}

/**
 * /v1/models 鉴权宽容：带网关 key 用密钥池、直传 key 用客户端 key 拉取上游实时列表；
 * 未带或无效 token 不报 401，返回缓存/兜底列表（兼容启动时先探测模型的客户端）。
 */
async function listModels(deps: AppDeps, request: Parameters<typeof authenticate>[0]): ReturnType<ModelLister> {
  const lister = deps.modelLister ?? listAvailableModels;
  let apiKey: string | undefined;
  if (extractToken(request)) {
    try {
      const auth = authenticate(request, deps.config);
      apiKey = auth.mode === "direct" ? auth.apiKey : (await deps.keyPool.pickActive(new Set()))?.apiKey;
    } catch {
      apiKey = undefined;
    }
  }
  return lister(apiKey);
}

function beginLog(endpoint: string, auth: AuthContext, prepared: PreparedRequest): RequestLog {
  return {
    endpoint,
    model: prepared.model,
    authMode: auth.mode,
    keyUsageRef: {},
    stream: prepared.stream,
    startedAt: Date.now(),
    finished: false
  };
}

export function finishLog(deps: AppDeps, log: RequestLog, status: number, error?: string): void {
  if (log.finished) return;
  log.finished = true;
  if (status >= 500 || error) {
    const key = [log.keyUsageRef.keyLabel, log.keyUsageRef.keyId].filter(Boolean).join("/");
    console.error(
      `[request] ${log.endpoint} status=${status} model=${log.model ?? "-"} auth=${log.authMode}` +
      (key ? ` key=${key}` : "") +
      ` durationMs=${Date.now() - log.startedAt}` +
      (error ? ` error=${error.slice(0, 300)}` : "")
    );
  }
  void deps.store
    .insertRequestLog({
      id: compactId(),
      ts: new Date().toISOString(),
      endpoint: log.endpoint,
      model: log.model,
      authMode: log.authMode,
      keyId: log.keyUsageRef.keyId,
      keyLabel: log.keyUsageRef.keyLabel,
      status,
      durationMs: Date.now() - log.startedAt,
      stream: log.stream,
      error: error ? error.slice(0, 500) : undefined
    })
    .catch(() => undefined);
}

async function runLogged(deps: AppDeps, log: RequestLog, run: Parameters<CursorRunner["run"]>[0]): Promise<CursorRunResult> {
  try {
    const output = await runWithTimeout(deps, run);
    finishLog(deps, log, 200);
    return output;
  } catch (error) {
    finishLog(deps, log, normalizeError(error).statusCode, errorMessage(error));
    throw error;
  }
}

async function* withStreamLog(deps: AppDeps, log: RequestLog, chunks: AsyncIterable<string>): AsyncIterable<string> {
  try {
    yield* chunks;
    finishLog(deps, log, 200);
  } catch (error) {
    finishLog(deps, log, normalizeError(error).statusCode, errorMessage(error));
    throw error;
  }
}

async function runWithTimeout(deps: AppDeps, run: Parameters<CursorRunner["run"]>[0]): Promise<CursorRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.config.requestTimeoutMs);
  try {
    return await deps.runner.run(run, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sendSse(reply: FastifyReply, chunks: AsyncIterable<string>): FastifyReply {
  return reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache, no-transform")
    .header("connection", "keep-alive")
    .send(Readable.from(chunks));
}

async function* chatStream(input: {
  id: string;
  created: number;
  prepared: PreparedRequest;
  auth: AuthContext;
  run: Parameters<CursorRunner["run"]>[0];
  deps: AppDeps;
}): AsyncIterable<string> {
  yield sse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.prepared.model,
    choices: [{ index: 0, delta: { role: "assistant" }, logprobs: null, finish_reason: null }]
  });
  let final: CursorRunResult = { text: "", toolCalls: [] };
  for await (const event of input.deps.runner.stream(input.run)) {
    if (event.type === "text" && event.text) {
      final.text += event.text;
      yield sse({
        id: input.id,
        object: "chat.completion.chunk",
        created: input.created,
        model: input.prepared.model,
        choices: [{ index: 0, delta: { content: event.text }, logprobs: null, finish_reason: null }]
      });
    } else if (event.type === "tool_call") {
      final.toolCalls.push(event.toolCall);
      yield sse({
        id: input.id,
        object: "chat.completion.chunk",
        created: input.created,
        model: input.prepared.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: final.toolCalls.length - 1, ...openAiToolCall(event.toolCall) }] }, logprobs: null, finish_reason: null }]
      });
    } else if (event.type === "done") {
      final = event.result;
    }
  }
  yield sse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.prepared.model,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: final.toolCalls.length ? "tool_calls" : "stop" }]
  });
  yield sse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.prepared.model,
    choices: [],
    usage: openAiUsage(input.prepared.prompt.length, final.text.length + JSON.stringify(final.toolCalls).length)
  });
  yield sseDone();
}

async function* responsesStream(input: {
  id: string;
  created: number;
  prepared: PreparedRequest;
  previousResponseId?: string;
  auth: AuthContext;
  run: Parameters<CursorRunner["run"]>[0];
  deps: AppDeps;
}): AsyncIterable<string> {
  const base = {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "in_progress",
    model: input.prepared.model,
    output: [],
    previous_response_id: input.previousResponseId ?? null,
    usage: null
  };
  yield sse({ type: "response.created", response: base }, "response.created");
  yield sse({ type: "response.in_progress", response: base }, "response.in_progress");

  let textStarted = false;
  let final: CursorRunResult = { text: "", toolCalls: [] };
  for await (const event of input.deps.runner.stream(input.run)) {
    if (event.type === "text" && event.text) {
      if (!textStarted) {
        textStarted = true;
        const messageId = `msg_${input.id.slice(5)}`;
        yield sse({ type: "response.output_item.added", output_index: 0, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } }, "response.output_item.added");
        yield sse({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, "response.content_part.added");
      }
      final.text += event.text;
      yield sse({ type: "response.output_text.delta", item_id: `msg_${input.id.slice(5)}`, output_index: 0, content_index: 0, delta: event.text }, "response.output_text.delta");
    } else if (event.type === "tool_call") {
      final.toolCalls.push(event.toolCall);
      const item = responseToolCallItem(event.toolCall);
      const outputIndex = (textStarted ? 1 : 0) + final.toolCalls.length - 1;
      yield sse({ type: "response.output_item.added", output_index: outputIndex, item }, "response.output_item.added");
      yield sse({ type: "response.output_item.done", output_index: outputIndex, item }, "response.output_item.done");
    } else if (event.type === "done") {
      final = event.result;
    }
  }

  const response = responseObject({ id: input.id, created: input.created, prepared: input.prepared, output: final, previousResponseId: input.previousResponseId });
  await saveResponse(input.deps, input.auth, input.id, response, input.prepared.inputItems);
  yield sse({ type: "response.completed", response }, "response.completed");
}

async function* anthropicStream(input: {
  id: string;
  prepared: PreparedRequest;
  run: Parameters<CursorRunner["run"]>[0];
  deps: AppDeps;
}): AsyncIterable<string> {
  yield sse({
    type: "message_start",
    message: {
      id: input.id,
      type: "message",
      role: "assistant",
      model: input.prepared.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: Math.ceil(input.prepared.prompt.length / 4), output_tokens: 0 }
    }
  }, "message_start");
  let textStarted = false;
  let text = "";
  const toolCalls: CursorRunResult["toolCalls"] = [];
  for await (const event of input.deps.runner.stream(input.run)) {
    if (event.type === "text" && event.text) {
      if (!textStarted) {
        textStarted = true;
        yield sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
      }
      text += event.text;
      yield sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: event.text } }, "content_block_delta");
    } else if (event.type === "tool_call") {
      toolCalls.push(event.toolCall);
      const index = textStarted ? toolCalls.length : toolCalls.length - 1;
      yield sse({ type: "content_block_start", index, content_block: anthropicToolUse(event.toolCall) }, "content_block_start");
      yield sse({ type: "content_block_stop", index }, "content_block_stop");
    } else if (event.type === "done") {
      text = event.result.text || text;
      toolCalls.splice(0, toolCalls.length, ...event.result.toolCalls);
    }
  }
  if (textStarted) yield sse({ type: "content_block_stop", index: 0 }, "content_block_stop");
  yield sse({
    type: "message_delta",
    delta: { stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null },
    usage: anthropicUsage(input.prepared.prompt.length, text.length + JSON.stringify(toolCalls).length)
  }, "message_delta");
  yield sse({ type: "message_stop" }, "message_stop");
}

async function saveResponse(deps: AppDeps, auth: AuthContext, id: string, response: Record<string, unknown>, inputItems: unknown[]): Promise<void> {
  const now = new Date().toISOString();
  await deps.store.saveResponse({
    id,
    ownerHash: auth.ownerHash,
    response,
    inputItems,
    createdAt: now,
    updatedAt: now
  });
}

/**
 * 网关默认值（env）+ 请求头推导的模型运行意图，优先级低于请求体 / 模型 id 后缀。
 * 请求头支持：anthropic-beta（含 context-1m → Max Mode）、x-cursor-reasoning-effort/max-mode/fast/mode/model-params。
 */
function requestModelControls(request: FastifyRequest, config: GatewayConfig): ModelIntent {
  const configDefaults: ModelIntent = {
    reasoningEffort: config.cursorReasoningEffort,
    maxMode: config.cursorMaxMode,
    fast: config.cursorFast,
    mode: config.cursorAgentMode,
    params: config.cursorModelParams
  };
  return mergeIntents(configDefaults, headerModelIntent(request.headers));
}

function headerModelIntent(headers: FastifyRequest["headers"]): ModelIntent {
  const intent: ModelIntent = {};
  const beta = headerValue(headers["anthropic-beta"]);
  if (beta && /context-1m|(^|[^0-9])1m([^0-9]|$)/i.test(beta)) intent.maxMode = true;
  const effort = headerValue(headers["x-cursor-reasoning-effort"]);
  if (effort) intent.reasoningEffort = effort;
  const maxMode = booleanHeader(headerValue(headers["x-cursor-max-mode"]));
  if (maxMode !== undefined) intent.maxMode = maxMode;
  const fast = booleanHeader(headerValue(headers["x-cursor-fast"]));
  if (fast !== undefined) intent.fast = fast;
  const mode = headerValue(headers["x-cursor-mode"]);
  if (mode === "agent" || mode === "plan") intent.mode = mode;
  const params = parseModelParamsSpec(headerValue(headers["x-cursor-model-params"]));
  if (params) intent.params = params;
  return intent;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanHeader(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function routeParam(params: unknown, key: string): string {
  const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new ApiError("Missing route parameter.", 400, "invalid_request_error", key);
  return value.trim();
}

function compactId(): string {
  return cryptoRandom().replaceAll("-", "");
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
