import { Readable } from "node:stream";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./admin.js";
import { authenticate, extractToken, sessionAffinity } from "./auth.js";
import {
  anthropicError,
  anthropicErrorType,
  ApiError,
  newRequestId,
  normalizeError,
  openAiError,
  openAiErrorPayload,
  openAiStatus,
  raceWithAbort
} from "./errors.js";
import type { CursorKeyPool } from "./key-pool.js";
import { errorMessage } from "./key-pool.js";
import { mergeIntents, parseModelParamsSpec, type ModelIntent } from "./model-params.js";
import { listAvailableModels, openAiModelList, openAiModelObject, type ModelLister } from "./models.js";
import {
  anthropicMessageObject,
  anthropicToolUse,
  anthropicUsage,
  chatCompletionObject,
  GATEWAY_THINKING_SIGNATURE,
  openAiToolCall,
  openAiUsage,
  prepareAnthropicMessages,
  prepareOpenAiChat,
  prepareOpenAiResponses,
  responseCallIds,
  responseListObject,
  responseMessageItem,
  responseObject,
  responseReasoningItem,
  responseSnapshot,
  responseTextPart,
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
  CursorStreamEvent,
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
    // Anthropic 在所有响应（含成功与流式）上都带 request-id；错误体里复用同一个值。
    if (request.url.startsWith("/v1/messages")) {
      reply.header("request-id", anthropicRequestId(request));
    }
    if (request.method === "OPTIONS") {
      reply.status(204).send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (request.url.startsWith("/v1/messages")) {
      // Anthropic 客户端从 request-id 头/字段拿排查用的请求标识。
      const requestId = anthropicRequestId(request);
      reply.header("request-id", requestId).status(normalized.statusCode).send(anthropicError(normalized, requestId));
      return;
    }
    reply.status(openAiStatus(normalized.statusCode)).send(openAiError(normalized));
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
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, chatStream({ id, created, prepared, auth, events, deps, log, signal: abort.signal }))));
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
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, responsesStream({ id, created, prepared, previousResponseId, auth, events, deps, log, signal: abort.signal }))));
    }
    const output = await runLogged(deps, log, run);
    const response = responseObject({ id, created, prepared, output, previousResponseId });
    // store:false 是数据保留契约：不落库，后续 GET/DELETE 自然 404。
    if (prepared.store) await saveResponse(deps, auth, id, response, prepared.inputItems);
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
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, anthropicStream({ id, prepared, events, deps, log, signal: abort.signal }))));
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
  } finally {
    // 客户端断连时生成器被 return()，上面两条路径都不会执行；这里兜底记 499，请求日志不再丢失。
    if (!log.finished) finishLog(deps, log, 499, "client disconnected before the stream completed");
  }
}

async function runWithTimeout(deps: AppDeps, run: Parameters<CursorRunner["run"]>[0]): Promise<CursorRunResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.config.requestTimeoutMs);
  try {
    // 双保险：runner 内部已对 SDK 调用做 abort 竞速，这里再对整个 run 竞速一次，
    // 即使上游出现完全不感知 signal 的挂死，客户端也一定能等到 504 而不是请求永久悬挂。
    return await raceWithAbort(deps.runner.run(run, controller.signal), controller.signal);
  } catch (error) {
    // 内部 abort 用 499 表达，但非流式请求的客户端还连着：对外必须是 504,而不是一个不存在的 HTTP 语义。
    if (timedOut) throw new ApiError(`Upstream run timed out after ${deps.config.requestTimeoutMs}ms.`, 504, "timeout_error");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sendSse(reply: FastifyReply, chunks: AsyncIterable<string>): FastifyReply {
  return reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache, no-transform")
    .header("connection", "keep-alive")
    // Nginx 反代默认 proxy_buffering on 会把 SSE 攒成大块（表现为流式卡顿/成块到达），显式要求不缓冲。
    .header("x-accel-buffering", "no")
    .send(Readable.from(chunks));
}

/**
 * 流式请求的取消控制：客户端断连（socket close）立即 abort 底层 run；
 * 超时按“无输出空闲时间”计（每写出一个 SSE chunk 重置），避免误杀仍在正常吐字的长回答。
 */
function streamAbort(request: FastifyRequest, idleTimeoutMs: number): { signal: AbortSignal; touch: () => void; done: () => void } {
  const controller = new AbortController();
  // 空闲超时与客户端断连共用一个 signal，但语义不同：超时时客户端还连着，要收到规范的 504 超时错误事件；
  // 断连则谁也收不到，只按 499 记日志。用 abort reason 区分两者。
  const abortIdle = (): void => controller.abort(new ApiError(`Upstream produced no output for ${idleTimeoutMs}ms.`, 504, "timeout_error"));
  let timer = setTimeout(abortIdle, idleTimeoutMs);
  const socket = request.raw.socket;
  const onClose = () => {
    clearTimeout(timer);
    socket?.removeListener?.("close", onClose);
    controller.abort();
  };
  socket?.once?.("close", onClose);
  // 连接可能在注册监听前就断了（例如前置的 previous_response_id 查库期间）；否则会被空闲超时误判成 504。
  if (request.raw.destroyed || socket?.destroyed) onClose();
  return {
    signal: controller.signal,
    touch: () => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(abortIdle, idleTimeoutMs);
    },
    done: () => {
      clearTimeout(timer);
      socket?.removeListener?.("close", onClose);
    }
  };
}

async function* withStreamAbort(abort: { touch: () => void; done: () => void }, chunks: AsyncIterable<string>): AsyncIterable<string> {
  try {
    for await (const chunk of chunks) {
      abort.touch();
      yield chunk;
    }
  } finally {
    abort.done();
  }
}

/**
 * 提交 SSE 响应前预取 runner 的第一个事件：上游即时失败（无效 key、额度耗尽、模型不可用等）
 * 必须走正常的 HTTP 错误信封，而不是 200 + 流内错误——SDK 的重试/错误处理依赖真实状态码。
 * 成功后把首事件塞回流，交给各端点的 SSE 生成器继续消费。
 */
async function openRunnerStream(
  deps: AppDeps,
  log: RequestLog,
  run: Parameters<CursorRunner["run"]>[0],
  abort: { signal: AbortSignal; done: () => void }
): Promise<AsyncIterable<CursorStreamEvent>> {
  const iterator = deps.runner.stream(run, abort.signal)[Symbol.asyncIterator]();
  let first: IteratorResult<CursorStreamEvent>;
  try {
    // 与 abort 竞速：上游完全无视 signal 挂死时，空闲超时/断连仍能把请求收尾。
    first = await raceWithAbort(iterator.next(), abort.signal);
  } catch (error) {
    abort.done();
    const normalized = normalizeError(error);
    // runner 把 abort 一律表达成内部 499；预取阶段命中空闲超时时还原成对客户端有意义的 504。
    const resolved = normalized.statusCode === 499 && abort.signal.aborted && abort.signal.reason instanceof ApiError
      ? abort.signal.reason
      : normalized;
    finishLog(deps, log, resolved.statusCode, errorMessage(error));
    throw resolved;
  }
  return {
    [Symbol.asyncIterator]() {
      let deliveredFirst = false;
      return {
        next(): Promise<IteratorResult<CursorStreamEvent>> {
          if (!deliveredFirst) {
            deliveredFirst = true;
            return Promise.resolve(first);
          }
          // 流中途同样竞速：读事件被无视 signal 的上游挂住时，abort 会以 499 打断，
          // 由 SSE 生成器的 catch 按语义转成流内 504/断连收尾。
          return raceWithAbort(iterator.next(), abort.signal);
        },
        return(value?: unknown): Promise<IteratorResult<CursorStreamEvent>> {
          deliveredFirst = true;
          return iterator.return?.(value) ?? Promise.resolve({ done: true as const, value: undefined });
        }
      };
    }
  };
}

async function* chatStream(input: {
  id: string;
  created: number;
  prepared: PreparedRequest;
  auth: AuthContext;
  events: AsyncIterable<CursorStreamEvent>;
  deps: AppDeps;
  log: RequestLog;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const includeUsage = input.prepared.includeUsage;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): string => sse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.prepared.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    // 官方语义：请求了 include_usage 时普通块携带 usage:null，未请求时连字段都不出现。
    ...(includeUsage ? { usage: null } : {})
  });
  try {
    yield chunk({ role: "assistant" }, null);
    let final: CursorRunResult = { text: "", toolCalls: [] };
    for await (const event of input.events) {
      if (event.type === "thinking" && event.text) {
        // DeepSeek 惯例的 reasoning_content 增量，兼容多数 OpenAI 客户端；不识别的客户端会忽略该字段。
        yield chunk({ reasoning_content: event.text }, null);
      } else if (event.type === "text" && event.text) {
        final.text += event.text;
        yield chunk({ content: event.text }, null);
      } else if (event.type === "tool_call") {
        final.toolCalls.push(event.toolCall);
        yield chunk({ tool_calls: [{ index: final.toolCalls.length - 1, ...openAiToolCall(event.toolCall) }] }, null);
      } else if (event.type === "done") {
        final = event.result;
      }
    }
    yield chunk({}, final.toolCalls.length ? "tool_calls" : "stop");
    // 未请求 usage 时不得追加 choices:[] 的块：大量客户端无脑取 choices[0] 会崩。
    if (includeUsage) {
      yield sse({
        id: input.id,
        object: "chat.completion.chunk",
        created: input.created,
        model: input.prepared.model,
        choices: [],
        usage: openAiUsage(input.prepared.prompt.length, final.text.length + JSON.stringify(final.toolCalls).length)
      });
    }
    yield sseDone();
  } catch (error) {
    // 流已开始，只能用流内错误事件收场；[DONE] 不再发出，客户端据此判定本次响应失败。
    const apiError = reportStreamError(input.deps, input.log, error, input.signal);
    if (apiError) yield sse({ error: openAiErrorPayload(apiError) });
  }
}

/**
 * 流中途失败：错误已通过流内事件送达客户端，这里把真实状态写进请求日志。
 * finishLog 幂等，`withStreamLog` 随后的 200 不会覆盖它。
 * runner 把任何 abort 都表达成内部 499，这里按 abort reason 还原成对客户端有意义的语义（空闲超时 → 504）。
 */
function reportStreamError(deps: AppDeps, log: RequestLog, error: unknown, signal?: AbortSignal): ApiError | undefined {
  const normalized = normalizeError(error);
  const aborted = normalized.statusCode === 499 && signal?.aborted === true;
  // 空闲超时用 ApiError 作为 abort reason；纯断连没有 reason。
  const resolved = aborted && signal?.reason instanceof ApiError ? signal.reason : normalized;
  finishLog(deps, log, resolved.statusCode, resolved === normalized ? errorMessage(error) : resolved.message);
  // 客户端已断连：没人再读这条流，不必也不该再写错误事件。
  return aborted && resolved.statusCode === 499 ? undefined : resolved;
}

/**
 * `/v1/responses` 的官方事件状态机：所有事件带全局递增的 sequence_number，
 * output item（reasoning / message / function_call）按产出顺序分配连续的 output_index，
 * 每个 item 都有完整的 added → 增量 → done 生命周期；成功以 response.completed 收尾，失败发 `event: error`，两种情况都不发 [DONE]。
 */
async function* responsesStream(input: {
  id: string;
  created: number;
  prepared: PreparedRequest;
  previousResponseId?: string;
  auth: AuthContext;
  events: AsyncIterable<CursorStreamEvent>;
  deps: AppDeps;
  log: RequestLog;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  let sequence = 1;
  const emit = (payload: Record<string, unknown>): string => sse({ ...payload, sequence_number: sequence++ }, String(payload.type));
  const snapshot = (status: "in_progress" | "completed", output?: Record<string, unknown>[], usage?: Record<string, unknown>, result?: CursorRunResult): Record<string, unknown> =>
    responseSnapshot({
      id: input.id,
      created: input.created,
      prepared: input.prepared,
      status,
      output,
      usage,
      previousResponseId: input.previousResponseId,
      agentId: result?.agentId,
      runId: result?.runId
    });

  try {
    yield emit({ type: "response.created", response: snapshot("in_progress") });
    yield emit({ type: "response.in_progress", response: snapshot("in_progress") });

    const suffix = input.id.replace(/^resp_/, "");
    const items: Record<string, unknown>[] = [];
    let nextOutputIndex = 0;
    let itemCounter = 0;
    let text = "";
    let reasoning = "";
    let openKind: "message" | "reasoning" | null = null;
    let openIndex = -1;
    let openItemId = "";
    let openText = "";
    let final: CursorRunResult = { text: "", toolCalls: [] };

    const closeOpenItem = (): string[] => {
      if (openKind === null) return [];
      const chunks: string[] = [];
      if (openKind === "message") {
        const item = responseMessageItem(openItemId, openText);
        chunks.push(emit({ type: "response.output_text.done", item_id: openItemId, output_index: openIndex, content_index: 0, text: openText, logprobs: [] }));
        chunks.push(emit({ type: "response.content_part.done", item_id: openItemId, output_index: openIndex, content_index: 0, part: responseTextPart(openText) }));
        chunks.push(emit({ type: "response.output_item.done", output_index: openIndex, item }));
        items.push(item);
      } else {
        const item = responseReasoningItem(openItemId, openText);
        chunks.push(emit({ type: "response.reasoning_summary_text.done", item_id: openItemId, output_index: openIndex, summary_index: 0, text: openText }));
        chunks.push(emit({ type: "response.reasoning_summary_part.done", item_id: openItemId, output_index: openIndex, summary_index: 0, part: { type: "summary_text", text: openText } }));
        chunks.push(emit({ type: "response.output_item.done", output_index: openIndex, item }));
        items.push(item);
      }
      openKind = null;
      return chunks;
    };

    const usedCallSuffixes = new Set<string>();
    for await (const event of input.events) {
      if (event.type === "thinking" && event.text) {
        if (openKind !== "reasoning") {
          yield* closeOpenItem();
          openKind = "reasoning";
          openIndex = nextOutputIndex++;
          openItemId = `rs_${suffix}_${itemCounter++}`;
          openText = "";
          yield emit({ type: "response.output_item.added", output_index: openIndex, item: { id: openItemId, type: "reasoning", summary: [] } });
          yield emit({ type: "response.reasoning_summary_part.added", item_id: openItemId, output_index: openIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        openText += event.text;
        reasoning += event.text;
        yield emit({ type: "response.reasoning_summary_text.delta", item_id: openItemId, output_index: openIndex, summary_index: 0, delta: event.text });
      } else if (event.type === "text" && event.text) {
        if (openKind !== "message") {
          yield* closeOpenItem();
          openKind = "message";
          openIndex = nextOutputIndex++;
          openItemId = `msg_${suffix}_${itemCounter++}`;
          openText = "";
          yield emit({ type: "response.output_item.added", output_index: openIndex, item: { id: openItemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
          yield emit({ type: "response.content_part.added", item_id: openItemId, output_index: openIndex, content_index: 0, part: responseTextPart("") });
        }
        openText += event.text;
        text += event.text;
        yield emit({ type: "response.output_text.delta", item_id: openItemId, output_index: openIndex, content_index: 0, delta: event.text, logprobs: [] });
      } else if (event.type === "tool_call") {
        yield* closeOpenItem();
        const outputIndex = nextOutputIndex++;
        const { itemId } = responseCallIds(event.toolCall, usedCallSuffixes);
        const args = JSON.stringify(event.toolCall.arguments);
        const item = responseToolCallItem(event.toolCall);
        yield emit({ type: "response.output_item.added", output_index: outputIndex, item: responseToolCallItem(event.toolCall, "in_progress") });
        // 上游一次性给出完整参数，按合法的最粗粒度发一个 delta 再 done。
        yield emit({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: args });
        // 官方 schema 的 function_call_arguments.done 带 name。
        yield emit({ type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, name: event.toolCall.name, arguments: args });
        yield emit({ type: "response.output_item.done", output_index: outputIndex, item });
        items.push(item);
      } else if (event.type === "done") {
        final = event.result;
      }
    }
    yield* closeOpenItem();

    // 流阶段零增量、只在 done.result 给出产出的 runner（合法契约）：补发完整生命周期事件；
    // 真正零产出时也补一个空 message item，与非流式 responseOutputItems 的形状保持一致。
    if (!items.length) {
      const fallbackReasoning = final.reasoningText ?? "";
      if (fallbackReasoning) {
        const outputIndex = nextOutputIndex++;
        const itemId = `rs_${suffix}_${itemCounter++}`;
        const item = responseReasoningItem(itemId, fallbackReasoning);
        yield emit({ type: "response.output_item.added", output_index: outputIndex, item: { id: itemId, type: "reasoning", summary: [] } });
        yield emit({ type: "response.reasoning_summary_part.added", item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
        yield emit({ type: "response.reasoning_summary_text.delta", item_id: itemId, output_index: outputIndex, summary_index: 0, delta: fallbackReasoning });
        yield emit({ type: "response.reasoning_summary_text.done", item_id: itemId, output_index: outputIndex, summary_index: 0, text: fallbackReasoning });
        yield emit({ type: "response.reasoning_summary_part.done", item_id: itemId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: fallbackReasoning } });
        yield emit({ type: "response.output_item.done", output_index: outputIndex, item });
        items.push(item);
        reasoning += fallbackReasoning;
      }
      if (final.text || !final.toolCalls.length) {
        const outputIndex = nextOutputIndex++;
        const itemId = `msg_${suffix}_${itemCounter++}`;
        const item = responseMessageItem(itemId, final.text);
        yield emit({ type: "response.output_item.added", output_index: outputIndex, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
        yield emit({ type: "response.content_part.added", item_id: itemId, output_index: outputIndex, content_index: 0, part: responseTextPart("") });
        if (final.text) yield emit({ type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, content_index: 0, delta: final.text, logprobs: [] });
        yield emit({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, content_index: 0, text: final.text, logprobs: [] });
        yield emit({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, content_index: 0, part: responseTextPart(final.text) });
        yield emit({ type: "response.output_item.done", output_index: outputIndex, item });
        items.push(item);
        text = final.text;
      }
      for (const toolCall of final.toolCalls) {
        const outputIndex = nextOutputIndex++;
        const { itemId } = responseCallIds(toolCall, usedCallSuffixes);
        const args = JSON.stringify(toolCall.arguments);
        const item = responseToolCallItem(toolCall);
        yield emit({ type: "response.output_item.added", output_index: outputIndex, item: responseToolCallItem(toolCall, "in_progress") });
        yield emit({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: args });
        yield emit({ type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, name: toolCall.name, arguments: args });
        yield emit({ type: "response.output_item.done", output_index: outputIndex, item });
        items.push(item);
      }
    }

    const usage = responsesUsage(input.prepared.prompt.length, text.length + JSON.stringify(items.filter(isFunctionCallItem)).length, reasoning.length);
    const response = snapshot("completed", items, usage, final);
    if (input.prepared.store) await saveResponse(input.deps, input.auth, input.id, response, input.prepared.inputItems);
    yield emit({ type: "response.completed", response });
  } catch (error) {
    const apiError = reportStreamError(input.deps, input.log, error, input.signal);
    if (apiError) {
      yield sse({
        type: "error",
        code: openAiErrorPayload(apiError).code,
        message: apiError.message,
        param: apiError.param ?? null,
        sequence_number: sequence++
      }, "error");
    }
  }
}

function isFunctionCallItem(item: Record<string, unknown>): boolean {
  return item.type === "function_call";
}

async function* anthropicStream(input: {
  id: string;
  prepared: PreparedRequest;
  events: AsyncIterable<CursorStreamEvent>;
  deps: AppDeps;
  log: RequestLog;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  // 客户端没请求思考时不产出 thinking 块；display:"omitted" 时仍产出空块（含 signature）但省略思考文本。
  const thinkingVisibility = input.prepared.thinkingVisibility ?? "off";
  try {
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
        usage: anthropicUsage(input.prepared.prompt.length, 0)
      }
    }, "message_start");
    let nextIndex = 0;
    let openIndex = -1;
    let openType: "text" | "thinking" | null = null;
    let text = "";
    let thinkingChars = 0;
    const toolCalls: CursorRunResult["toolCalls"] = [];
    const closeOpenBlock = (): string[] => {
      if (openType === null) return [];
      const chunks: string[] = [];
      // Anthropic 协议要求 thinking 块在 stop 前有 signature_delta；网关无真实签名，发一个不透明占位签名
      // 保证严格客户端（Claude Code）能正常收块。历史消息里的 thinking 块本网关按纯文本处理，不校验签名。
      if (openType === "thinking") {
        chunks.push(sse({ type: "content_block_delta", index: openIndex, delta: { type: "signature_delta", signature: GATEWAY_THINKING_SIGNATURE } }, "content_block_delta"));
      }
      chunks.push(sse({ type: "content_block_stop", index: openIndex }, "content_block_stop"));
      openType = null;
      return chunks;
    };
    for await (const event of input.events) {
      if (event.type === "thinking" && event.text) {
        if (thinkingVisibility === "off") continue;
        if (openType !== "thinking") {
          yield* closeOpenBlock();
          openIndex = nextIndex;
          nextIndex += 1;
          openType = "thinking";
          // 严格 union 解码器要求 thinking 块起手就带 signature 字段（真值由结尾的 signature_delta 补齐）。
          yield sse({ type: "content_block_start", index: openIndex, content_block: { type: "thinking", thinking: "", signature: "" } }, "content_block_start");
        }
        thinkingChars += event.text.length;
        // display:"omitted"：块存在（含 signature_delta 收尾），但不下发思考文本增量。
        if (thinkingVisibility === "full") {
          yield sse({ type: "content_block_delta", index: openIndex, delta: { type: "thinking_delta", thinking: event.text } }, "content_block_delta");
        }
      } else if (event.type === "text" && event.text) {
        if (openType !== "text") {
          yield* closeOpenBlock();
          openIndex = nextIndex;
          nextIndex += 1;
          openType = "text";
          yield sse({ type: "content_block_start", index: openIndex, content_block: { type: "text", text: "" } }, "content_block_start");
        }
        text += event.text;
        yield sse({ type: "content_block_delta", index: openIndex, delta: { type: "text_delta", text: event.text } }, "content_block_delta");
      } else if (event.type === "tool_call") {
        yield* closeOpenBlock();
        toolCalls.push(event.toolCall);
        const index = nextIndex;
        nextIndex += 1;
        // Anthropic 官方语义：tool_use 的 content_block_start.input 恒为 {}，
        // 完整参数只通过 input_json_delta 下发——按规范实现的客户端（含 Claude Code）靠累积 partial_json 得到 input。
        yield sse({ type: "content_block_start", index, content_block: { ...anthropicToolUse(event.toolCall), input: {} } }, "content_block_start");
        yield sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolCall.arguments ?? {}) } }, "content_block_delta");
        yield sse({ type: "content_block_stop", index }, "content_block_stop");
      } else if (event.type === "done") {
        text = event.result.text || text;
        toolCalls.splice(0, toolCalls.length, ...event.result.toolCalls);
      }
    }
    yield* closeOpenBlock();
    yield sse({
      type: "message_delta",
      delta: { stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null },
      usage: anthropicUsage(input.prepared.prompt.length, text.length + thinkingChars + JSON.stringify(toolCalls).length)
    }, "message_delta");
    yield sse({ type: "message_stop" }, "message_stop");
  } catch (error) {
    // 规范的流内错误：发 error 事件后结束，不再补 message_stop（那会让客户端把失败当成正常收尾）。
    const apiError = reportStreamError(input.deps, input.log, error, input.signal);
    if (apiError) {
      yield sse({
        type: "error",
        error: { type: anthropicErrorType(apiError.statusCode), message: apiError.message }
      }, "error");
    }
  }
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

/** 每个 /v1/messages 请求一个稳定的 request id：响应头与错误体里必须是同一个值。 */
function anthropicRequestId(request: FastifyRequest): string {
  const holder = request as FastifyRequest & { anthropicRequestId?: string };
  holder.anthropicRequestId ??= newRequestId();
  return holder.anthropicRequestId;
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
