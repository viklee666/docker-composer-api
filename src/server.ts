import { Readable } from "node:stream";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./admin.js";
import { authenticate, explicitSessionId, extractToken, sessionAffinity } from "./auth.js";
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
import type { GatewayKeyPool } from "./gateway-key-pool.js";
import type { CursorKeyPool } from "./key-pool.js";
import { errorMessage } from "./key-pool.js";
import type { UsageReconciler } from "./usage-reconciler.js";
import { resolveCursorClientType, runWithCursorClientType } from "./sand-client.js";
import { effectiveIntentFromParams, mergeIntents, parseModelParamsSpec, type ModelIntent } from "./model-params.js";
import {
  applyModelScope,
  findModelAcrossCatalogues,
  listAvailableModels,
  openAiModelList,
  openAiModelObject,
  type CatalogueLookup,
  type ModelLister,
  type ModelListResult
} from "./models.js";
import { conversationSeed, denyRuleUnverifiable, filterModelsByScope, identityAllowed, modelIdentity } from "./routing.js";
import {
  anthropicMessageObject,
  anthropicCompletionChars,
  anthropicTokenCount,
  anthropicToolUse,
  anthropicUsage,
  chatCompletionChars,
  chatCompletionObject,
  effectiveUsage,
  gatewayThinkingSignature,
  openAiToolCall,
  openAiUsage,
  prepareAnthropicMessages,
  prepareOpenAiChat,
  prepareOpenAiResponses,
  responseCallIds,
  responseCompletionChars,
  responseListObject,
  responseMessageItem,
  responseReasoningChars,
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
  AgentMode,
  AuthContext,
  CursorClientType,
  CursorKeyRecord,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  EffectiveParamField,
  GatewayConfig,
  KeyUsageRef,
  ModelIdentity,
  ModelScope,
  RequestLogRecord,
  RunTelemetryRef,
  StateStore,
  SystemPromptSettings
} from "./types.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

export interface AppDeps {
  config: GatewayConfig;
  store: StateStore;
  runner: CursorRunner;
  keyPool: CursorKeyPool;
  /**
   * 对外网关密钥池（多密钥 + 每密钥可用 Cursor key / 模型范围）。
   * 不提供时退回 config.gatewayApiKey 的单密钥老行为，测试与旧部署都不用改。
   */
  gatewayKeyPool?: GatewayKeyPool;
  /** 上游计费金额的带外补写器；不提供则只记 token 用量、不查金额。 */
  usageReconciler?: UsageReconciler;
  startedAt?: number;
  /** 模型列表来源，默认走 Cursor SDK（测试时可注入桩）。 */
  modelLister?: ModelLister;
  /** SDK 网络配置应用器，测试时可注入桩以避免加载真实 SDK。 */
  applyCursorSdkNetworkConfig?: (useHttp1ForAgent: boolean) => Promise<void>;
}

/**
 * 统一的鉴权入口：把网关密钥池接成同步解析器。
 * authenticate 必须保持同步（八个路由处理器都在首行直接调用它），所以这里传的是
 * 池内内存快照的查询函数，而不是异步的库查询。
 */
export function authFor(deps: AppDeps, request: FastifyRequest): AuthContext {
  const pool = deps.gatewayKeyPool;
  if (!pool) return authenticate(request, deps.config);
  return authenticate(request, deps.config, {
    resolveGatewayKey: (token) => pool.resolve(token),
    resolveAnyGatewayKey: (token) => pool.resolveAny(token)
  });
}

/**
 * 模块内请求日志草稿。telemetryRef 与 keyUsageRef 一样是可变引出通道：
 * beginLog 时还是空的，runner 在跑的过程中写回真实用量 / 通道 / 下发参数，
 * 所以 clientType / modelParams / usage 必须在 finishLog 时再读，不能在 beginLog 时拍快照。
 */
interface RequestLog {
  endpoint: string;
  model?: string;
  authMode: RequestLogRecord["authMode"];
  keyUsageRef: KeyUsageRef;
  telemetryRef: RunTelemetryRef;
  stream: boolean;
  startedAt: number;
  finished: boolean;
  gatewayKeyId?: string;
  gatewayKeyLabel?: string;
  /** direct 模式下客户端自带的那把 Cursor key：它不经过密钥池，没有 keyId 可以回查金额。 */
  directApiKey?: string;
  reasoningEffort?: string;
  maxMode?: boolean;
  fast?: boolean;
  agentMode?: AgentMode;
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
    sendProtocolError(request, reply, normalizeError(error));
  });

  // 未命中任何路由时 Fastify 默认回 {message,error,statusCode}：既不是 Anthropic 信封也不是 OpenAI 信封，
  // 严格 SDK 解不出错误原因。走与抛错路径相同的分流。
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0];
    sendProtocolError(request, reply, new ApiError(`Unknown endpoint: ${request.method} ${path}`, 404, "not_found"));
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
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const prepared = prepareOpenAiChat(request.body, { systemPrompt: gatewaySystemPrompt(deps.config) });
    const identity = await scopedModelIdentity(deps, auth, prepared.model);
    const id = `chatcmpl_${compactId()}`;
    const created = nowSeconds();
    const log = beginLog("/v1/chat/completions", auth, prepared);
    const run = loggedRunRequest(deps, log, {
      prepared,
      protocol: "openai-chat",
      auth,
      identity,
      sessionKey: sessionAffinity(request, auth.ownerHash),
      request
    });
    if (prepared.stream) {
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, chatStream({ id, created, prepared, auth, events, deps, log, signal: abort.signal }))));
    }
    const output = await runLogged(deps, log, run, (result) => ({
      completionChars: chatCompletionChars(result)
    }));
    return chatCompletionObject({ id, created, prepared, output, usage: log.telemetryRef.usage });
  });

  app.post("/v1/responses", async (request, reply) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const previousResponseId = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
    const previous = previousResponseId ? await deps.store.getResponse(previousResponseId, auth.ownerHash) : undefined;
    if (previousResponseId && !previous) throw new ApiError("Previous response not found.", 404, "not_found", "previous_response_id");
    const prepared = prepareOpenAiResponses(body, previous ? { response: previous.response, inputItems: previous.inputItems } : undefined, { systemPrompt: gatewaySystemPrompt(deps.config) });
    const identity = await scopedModelIdentity(deps, auth, prepared.model);
    const id = `resp_${compactId()}`;
    const created = nowSeconds();
    /*
     * 续聊沿用上一轮落库的种子。这里必须是「继承」而不是「回溯整条链」：
     * 每条记录只存直接父节点，但每一轮都把继承来的种子再写回自己那行，第三轮往后照样对得上。
     * 老库记录（无种子）与 store:false（压根没落库）自然退回按请求体现算，认不出就不启用粘性。
     */
    const seed = previous?.conversationSeed ?? conversationSeed(body);
    const log = beginLog("/v1/responses", auth, prepared);
    const run = loggedRunRequest(deps, log, {
      prepared,
      protocol: "openai-responses",
      auth,
      identity,
      sessionKey: sessionAffinity(request, previousResponseId ?? auth.ownerHash),
      conversationSeed: seed,
      request
    });
    if (prepared.stream) {
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, responsesStream({ id, created, prepared, previousResponseId, conversationSeed: seed, auth, events, deps, log, signal: abort.signal }))));
    }
    const output = await runLogged(deps, log, run, (result) => {
      const outputChars = responseCompletionChars(result);
      const reasoningChars = responseReasoningChars(result);
      const usage = responsesUsage(prepared.prompt.length, outputChars, reasoningChars);
      return {
        completionChars: outputChars + reasoningChars,
        outputTokens: Number(usage.output_tokens)
      };
    });
    const response = responseObject({ id, created, prepared, output, previousResponseId, usage: log.telemetryRef.usage });
    // store:false 是数据保留契约：不落库，后续 GET/DELETE 自然 404。
    if (prepared.store) await saveResponse(deps, auth, id, response, prepared.inputItems, seed);
    return response;
  });

  app.get("/v1/responses/:id", async (request) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const id = routeParam(request.params, "id");
    const record = await deps.store.getResponse(id, auth.ownerHash);
    if (!record) throw new ApiError("Response not found.", 404, "not_found");
    return record.response;
  });

  app.delete("/v1/responses/:id", async (request) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const id = routeParam(request.params, "id");
    const deleted = await deps.store.deleteResponse(id, auth.ownerHash);
    if (!deleted) throw new ApiError("Response not found.", 404, "not_found");
    return { id, object: "response.deleted", deleted: true };
  });

  app.get("/v1/responses/:id/input_items", async (request) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const id = routeParam(request.params, "id");
    const record = await deps.store.getResponse(id, auth.ownerHash);
    if (!record) throw new ApiError("Response not found.", 404, "not_found");
    return responseListObject(record.inputItems);
  });

  /**
   * 官方 token 预估端点：只做请求解析与估算，不落请求日志、不碰 runner 与密钥池。
   * 与 /v1/messages 是两条独立静态路由，注册顺序无关。
   */
  app.post("/v1/messages/count_tokens", async (request) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const prepared = prepareAnthropicMessages(request.body, {
      countTokens: true,
      systemPrompt: gatewaySystemPrompt(deps.config)
    });
    // 不碰 runner 也要拦：否则被目录藏起来的模型能从这里探出「存在且可估算」。
    // direct 模式也必须自己查：另外三个入口那份「已登记 key 的可见范围」是 runner 兜住的，
    // 这条路上没有 runner，漏掉就成了 D5 的一个缺口。
    // 两种范围都不可能存在时（网关密钥不限制、又不是直传）连目录都不必解析。
    if (auth.modelScope || auth.mode === "direct") await scopedModelIdentity(deps, auth, prepared.model);
    return anthropicTokenCount(prepared);
  });

  app.post("/v1/messages", async (request, reply) => {
    const auth = authFor(deps, request);
    noteGatewayKeyUse(deps, auth);
    const prepared = prepareAnthropicMessages(request.body, { systemPrompt: gatewaySystemPrompt(deps.config) });
    const identity = await scopedModelIdentity(deps, auth, prepared.model);
    const id = `msg_${compactId()}`;
    const log = beginLog("/v1/messages", auth, prepared);
    const run = loggedRunRequest(deps, log, {
      prepared,
      protocol: "anthropic-messages",
      auth,
      identity,
      sessionKey: sessionAffinity(request, auth.ownerHash),
      request
    });
    if (prepared.stream) {
      const abort = streamAbort(request, deps.config.requestTimeoutMs);
      const events = await openRunnerStream(deps, log, run, abort);
      return sendSse(reply, withStreamAbort(abort, withStreamLog(deps, log, anthropicStream({ id, prepared, events, deps, log, signal: abort.signal }))));
    }
    const output = await runLogged(deps, log, run, (result) => ({
      completionChars: anthropicCompletionChars(prepared, result)
    }));
    return anthropicMessageObject({ id, prepared, output, usage: log.telemetryRef.usage });
  });

  registerAdminRoutes(app, deps);

  return app;
}

/**
 * /v1/models 鉴权宽容：带网关 key 用密钥池、已登记直传 key 用自己的 key 拉取上游实时列表；
 * 未登记直传 token 不会被交给上游；
 * 未带或未知 token 不报 401，返回缓存/兜底列表（兼容启动时先探测模型的客户端）；
 * 已知停用凭据仍按撤销语义返回 401。
 */
async function listModels(deps: AppDeps, request: Parameters<typeof authenticate>[0]): ReturnType<ModelLister> {
  const lister = deps.modelLister ?? listAvailableModels;
  let source: CatalogueLookup = { clientType: deps.config.sandClientMode ? "sand" : "sdk" };
  let auth: AuthContext | undefined;
  const token = extractToken(request);
  if (token) {
    // 发现端点对未知 token 保持兼容性的宽容不能覆盖已知停用凭据，否则撤销只挡推理、不挡
    // 目录探测，攻击者仍能拿着看似失效的 key 观察服务能力。
    if (deps.gatewayKeyPool?.resolveAny(token)?.status === "disabled") {
      throw new ApiError("This gateway API key is disabled.", 401, "unauthorized");
    }
    try {
      auth = authFor(deps, request);
    } catch {
      source = { clientType: source.clientType };
    }
    if (auth?.mode === "direct" && auth.apiKey) {
      const record = await deps.keyPool.getByValue(auth.apiKey);
      if (record?.status === "disabled") {
        throw new ApiError("This Cursor API key is disabled.", 401, "unauthorized");
      }
    }
    if (auth) {
      try {
        source = await catalogueSource(deps, auth);
      } catch {
        source = { clientType: source.clientType };
      }
    }
  }
  const listed = await runWithCursorClientType(source.clientType, () => lister(source.apiKey));
  return filterListedModels(deps, listed, auth);
}

/**
 * 网关模式的 auth 里没有 Cursor key（要等选完 key 才有），所以向池借一把 active 的来拉 /v1/models 的目录。
 * 借用走 pickActive，它刻意不推进轮询游标：读目录是旁路动作，不该改变下一次执行选中哪把 key。
 */
async function catalogueSource(deps: AppDeps, auth: AuthContext): Promise<CatalogueLookup> {
  const fallback: CursorClientType = deps.config.sandClientMode ? "sand" : "sdk";
  if (auth.mode === "direct") {
    const record = auth.apiKey ? await deps.keyPool.getByValue(auth.apiKey) : undefined;
    // 未登记的直传 token 没有任何值得向上游证明的身份；把它原样交给 models.list
    // 会让发现端点变成调用方驱动的上游探测器。未登记时只允许无 key 的缓存/兜底路径。
    return {
      ...(record?.status === "active" ? { apiKey: record.apiKey } : {}),
      clientType: resolveCursorClientType(record?.clientType, fallback)
    };
  }
  const key = await deps.keyPool.pickActive(
    new Set(),
    auth.allowedCursorKeyIds?.length ? { allowedKeyIds: auth.allowedCursorKeyIds } : undefined
  );
  return { apiKey: key?.apiKey, clientType: resolveCursorClientType(key?.clientType, fallback) };
}

/**
 * 模型身份解析的时限，与 runner 的推理超时分开。
 * 身份解析发生在 runner 的超时/中断机制建立**之前**，目录调用自己又没有请求级 deadline，
 * 冷缓存下的一次挂死会把整个请求（包括压根不碰 runner 的 count_tokens）拖过配置的推理超时。
 */
const MODEL_CATALOGUE_TIMEOUT_MS = 5_000;

/**
 * 解析本次请求的模型身份，顺带挡下可见范围外的模型。
 *
 * 两件事必须在同一层做完：身份只有在 handler 里才解析得出来（选 key 那层拿不到 apiKey，
 * 也不该为了判范围去做目录 I/O），而 README 承诺的 403 `model_not_allowed` 要在请求真正
 * 打到上游之前就给出。返回的身份随请求下传，选 key 时直接复用，全程只解析一次。
 */
async function scopedModelIdentity(deps: AppDeps, auth: AuthContext, model: string): Promise<ModelIdentity> {
  // direct 模式下这把 key 可能已在池中登记：D5 说它同样受自己那份范围约束，
  // 而同一次查询顺带决定了拿谁的目录解析身份，所以只查一次、两处用。
  const registered = auth.mode === "direct" && auth.apiKey ? await deps.keyPool.getByValue(auth.apiKey) : undefined;
  if (registered?.status === "disabled") {
    // 停用是这把凭据的全局撤销；不能先做目录/范围判定，让同一把 key 以另一种错误形态继续被端点接受。
    throw new ApiError("This Cursor API key is disabled.", 401, "unauthorized");
  }
  const identity = await resolveModelIdentity(deps, auth, registered, model);
  enforceGatewayModelScope(identity, auth.modelScope, model);
  enforceRegisteredKeyScope(identity, registered?.modelScope, model);
  return identity;
}

/**
 * L1 快速拒绝。入站网关密钥的可见范围是本网关唯一的多租户边界；
 * Cursor key 自身的黑名单同样是硬限制，direct 模式在下一段按同一口径检查。
 */
function enforceGatewayModelScope(identity: ModelIdentity, scope: ModelScope | undefined, model: string): void {
  if (!scope) return;
  // 先判真命中：能明确说出「这个模型被排除了」时就不该退而报「查不到」，后者会把运维引去查上游。
  if (!identityAllowed(identity, scope)) {
    throw new ApiError(
      `This gateway API key is not allowed to use model "${model}": the model is outside its model scope. Widen the gateway key model scope in the admin panel or request another model.`,
      403,
      "model_not_allowed",
      "model"
    );
  }
  if (denyRuleUnverifiable(identity, scope)) {
    throw new ApiError(
      `Cannot verify whether model "${model}" is on this gateway API key's model deny list: the Cursor model catalogue is unavailable, so the request is refused instead of being let through an unevaluated deny rule. Retry once the catalogue recovers, or request the model by the exact name used in the deny list.`,
      403,
      "model_identity_unverified",
      "model"
    );
  }
}

/**
 * D5：直传的 key 若已在池中登记且配了可见范围，同样受限。
 * 这是运维对该凭据施加的硬限制，不因为客户端手里也有裸 key 就允许绕过；
 * 目录抖动时黑名单按 fail-closed 处理，避免 direct 成为网关模式之外的别名后门。
 * 三个推理入口在 runner 里还会再查一遍，count_tokens 不进 runner，只有这一处能拦。
 */
function enforceRegisteredKeyScope(identity: ModelIdentity, scope: ModelScope | undefined, model: string): void {
  if (!scope) return;
  if (!identityAllowed(identity, scope)) {
    throw new ApiError(
      `This Cursor API key is not allowed to use model "${model}": the model is outside the scope registered for this key in the admin panel. Widen that scope or request another model.`,
      403,
      "model_not_allowed",
      "model"
    );
  }
  // Cursor key 的黑名单同样是硬限制：目录没确认完整时，别名可能还藏在未返回的那份目录里，
  // 把「暂时算不准」当成「没命中」会让 direct 与网关模式出现一条可绕过的后门。
  if (denyRuleUnverifiable(identity, scope)) {
    throw new ApiError(
      `Cannot verify whether model "${model}" is on this Cursor API key's model deny list: the Cursor model catalogue is unavailable, so the request is refused instead of being let through an unevaluated deny rule. Retry once the catalogue recovers, or request the model by the exact name used in the deny list.`,
      403,
      "model_identity_unverified",
      "model"
    );
  }
}

/**
 * 模型身份 = 全池 active key 目录的并集 + 网关静态别名组。
 *
 * 取并集而不是「借一把 key 的目录」，是因为借来的那把与真正执行的那把根本不保证是同一把：
 * 判定读 A 的目录、执行落到 B，两层防御就各看各的数据，一起失效。
 * 并集与选中哪把 key 无关，授权与执行因此永远看同一组叫法。
 * 各账号可见的别名本来也不一样，并集顺带补上了「只有另一把 key 才看得到的那个叫法」。
 *
 * 成本：每请求 N 次目录查询（N = active key 数），目录按 (key, 通道) 缓存 10 分钟，
 * 命中缓存时只是 N 次内存查表；冷缓存下的串行拉取由 deadline 兜住。
 * 任一相关目录失败时，即使其它目录找到了 entry，身份也标记 confirmed=false；
 * 这表示别名并集不完整，由 denyRuleUnverifiable 决定黑名单该怎么办。
 */
async function resolveModelIdentity(
  deps: AppDeps,
  auth: AuthContext,
  registered: CursorKeyRecord | undefined,
  model: string
): Promise<ModelIdentity> {
  const lookups = await catalogueLookups(deps, auth, registered);
  if (!lookups.length) return modelIdentity(model);
  const lister = deps.modelLister ?? listAvailableModels;
  const entry = await withCatalogueDeadline(
    findModelAcrossCatalogues(lister, lookups, model),
    Math.min(deps.config.requestTimeoutMs, MODEL_CATALOGUE_TIMEOUT_MS)
  );
  return entry
    ? modelIdentity(model, entry.entry, entry.confirmed)
    : modelIdentity(model);
}

async function catalogueLookups(
  deps: AppDeps,
  auth: AuthContext,
  registered: CursorKeyRecord | undefined
): Promise<CatalogueLookup[]> {
  const fallback: CursorClientType = deps.config.sandClientMode ? "sand" : "sdk";
  if (auth.mode === "direct") {
    // 未登记的直传 token 一律不查目录：这条路上身份没人用（direct 不选 key，也没有网关范围），
    // 而拿调用方随手给的 token 去查目录，等于让任何人都能撬动一次上游调用，
    // 顺带把按 key 分桶的目录缓存冲成一次性的。
    return registered?.status === "active"
      ? [{ apiKey: registered.apiKey, clientType: resolveCursorClientType(registered.clientType, fallback) }]
      : [];
  }
  return (await deps.keyPool.list())
    .filter((key) => key.status === "active")
    .map((key) => ({ apiKey: key.apiKey, clientType: resolveCursorClientType(key.clientType, fallback) }));
}

/**
 * 给目录解析套一个独立的时限，超时按「没查到」处理。
 * 是竞速而不是真的取消：SDK 的 models.list 不收 AbortSignal，挂死的那次调用只能留在后台自生自灭，
 * 但请求本身不会再被它拖住——与 runWithTimeout 对 run 的处理是同一套路。
 * 超时与目录报错走同一条降级路径，于是「超时」在黑名单侧同样算「算不准」而不是「没命中」。
 */
function withCatalogueDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(timeoutMs, 1));
    const settle = (value: T | undefined): void => {
      clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(undefined));
  });
}

function beginLog(endpoint: string, auth: AuthContext, prepared: PreparedRequest): RequestLog {
  return {
    endpoint,
    model: prepared.model,
    authMode: auth.mode,
    keyUsageRef: {},
    telemetryRef: {},
    stream: prepared.stream,
    startedAt: Date.now(),
    finished: false,
    gatewayKeyId: auth.gatewayKeyId,
    gatewayKeyLabel: auth.gatewayKeyLabel,
    ...(auth.mode === "direct" && auth.apiKey ? { directApiKey: auth.apiKey } : {})
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
  const id = compactId();
  const params = loggedModelParams(log);
  void deps.store
    .insertRequestLog({
      id,
      ts: new Date().toISOString(),
      endpoint: log.endpoint,
      model: log.model,
      authMode: log.authMode,
      keyId: log.keyUsageRef.keyId,
      keyLabel: log.keyUsageRef.keyLabel,
      status,
      durationMs: Date.now() - log.startedAt,
      stream: log.stream,
      error: error ? error.slice(0, 500) : undefined,
      gatewayKeyId: log.gatewayKeyId,
      gatewayKeyLabel: log.gatewayKeyLabel,
      reasoningEffort: params.reasoningEffort,
      maxMode: params.maxMode,
      fast: params.fast,
      ...(params.effectiveParams.length ? { effectiveParams: params.effectiveParams } : {}),
      agentMode: log.agentMode,
      clientType: log.telemetryRef.clientType,
      modelParams: log.telemetryRef.modelParams,
      ...loggedUsage(log.telemetryRef),
      cost: log.telemetryRef.cost
    })
    .then(() => scheduleCostBackfill(deps, log, id))
    .catch((error: unknown) => {
      // 落库失败会连带丢掉金额补写：静默吞掉等于后台既看不到这次请求，也没人知道它丢了。
      console.error(
        `[request-log] persist failed ${log.endpoint} status=${status}: ` +
        (error instanceof Error ? error.message.slice(0, 300) : String(error))
      );
    });
}

/**
 * 日志里的用量与来源。上游报过就是实测值；没报过时落估算值并如实标 estimated。
 * 两样都没有（请求根本没跑到产出，比如鉴权失败或上游立刻报错）时一个字段都不写：
 * 原先无条件标 estimated 而 token 列全空，后台显示「估算」加一片空白，比什么都不标更误导人。
 */
function loggedUsage(telemetry: RunTelemetryRef): Pick<RequestLogRecord, "usage" | "usageSource"> {
  if (telemetry.usage) return { usage: telemetry.usage, usageSource: "sdk" };
  if (telemetry.estimatedUsage) return { usage: telemetry.estimatedUsage, usageSource: "estimated" };
  return {};
}

/**
 * 三个参数列优先记实际下发值（从 runner 真正发出去的 model.params 反解），反解不出才退回请求意图。
 * effectiveParams 记下哪几列是实测的：运维要区分的是「客户端要了 fast、也确实发出去了」与
 * 「客户端要了 fast，但网关不知道最后发的是什么」，这两种情况以前在日志里长得一模一样。
 */
function loggedModelParams(log: RequestLog): {
  reasoningEffort?: string;
  maxMode?: boolean;
  fast?: boolean;
  effectiveParams: EffectiveParamField[];
} {
  const effective = effectiveIntentFromParams(log.telemetryRef.modelParams);
  const effectiveParams: EffectiveParamField[] = [];
  if (effective.reasoningEffort !== undefined) effectiveParams.push("reasoningEffort");
  if (effective.maxMode !== undefined) effectiveParams.push("maxMode");
  if (effective.fast !== undefined) effectiveParams.push("fast");
  return {
    reasoningEffort: effective.reasoningEffort ?? log.reasoningEffort,
    maxMode: effective.maxMode ?? log.maxMode,
    fast: effective.fast ?? log.fast,
    effectiveParams
  };
}

/**
 * 上游没报用量时给请求日志留一份估算。只在这里落 telemetryRef.estimatedUsage，
 * 不碰 telemetryRef.usage：后者是「上游实测」的语义，响应体按它决定要不要输出缓存/推理明细。
 */
function noteEstimatedUsage(
  log: RequestLog,
  promptChars: number,
  completionChars: number,
  outputTokens?: number
): void {
  if (log.telemetryRef.usage || log.telemetryRef.estimatedUsage) return;
  const estimated = effectiveUsage(undefined, promptChars, completionChars);
  if (outputTokens !== undefined) {
    estimated.outputTokens = outputTokens;
    estimated.totalTokens = estimated.inputTokens + outputTokens;
  }
  log.telemetryRef.estimatedUsage = estimated;
}

function noteGatewayKeyUse(deps: AppDeps, auth: AuthContext): void {
  if (!auth.gatewayKeyId) return;
  void deps.gatewayKeyPool?.recordUse(auth.gatewayKeyId)?.catch(() => undefined);
}

function gatewaySystemPrompt(config: GatewayConfig): SystemPromptSettings {
  return { mode: config.systemPromptMode, text: config.systemPrompt };
}

function loggedRunRequest(
  deps: AppDeps,
  log: RequestLog,
  input: {
    prepared: PreparedRequest;
    protocol: CursorRunRequest["protocol"];
    auth: AuthContext;
    /** handler 解析好的模型身份，下传给选 key，省掉那一层再查目录。 */
    identity: ModelIdentity;
    sessionKey: string;
    /** 调用方已经确定的会话身份（Responses 续聊沿用上一轮落库的种子）；不传就按请求体现算。 */
    conversationSeed?: string;
    request: FastifyRequest;
  }
): CursorRunRequest {
  const stickyKey = stickyKeyFor(input.request, input.auth, input.conversationSeed);
  const run: CursorRunRequest = {
    ...toRunRequest({
      prepared: input.prepared,
      protocol: input.protocol,
      auth: input.auth,
      sessionKey: input.sessionKey,
      workingDirectory: deps.config.cursorWorkingDirectory,
      keyUsageRef: log.keyUsageRef,
      controls: requestModelControls(input.request, deps.config)
    }),
    telemetryRef: log.telemetryRef,
    modelIdentity: input.identity,
    ...(input.auth.allowedCursorKeyIds?.length ? { allowedKeyIds: input.auth.allowedCursorKeyIds } : {}),
    // 第二道防线：入口已经拦过一次，这里再让选 key 只在网关范围 ∩ key 范围里挑。
    ...(input.auth.modelScope ? { gatewayModelScope: input.auth.modelScope } : {}),
    ...(stickyKey ? { stickyKey } : {})
  };
  log.reasoningEffort = run.reasoningEffort;
  log.maxMode = run.maxMode;
  log.fast = run.fast;
  log.agentMode = run.mode;
  return run;
}

/**
 * 会话粘性的身份。三级来源，都认不出就返回 undefined（此时不启用粘性）：
 * 1. 客户端显式给的会话头；
 * 2. 调用方给的 seed（Responses 续聊从上一轮记录里继承来的那个）；
 * 3. 请求体里这段对话的稳定前缀（system + 第一条 user 消息）——同一段对话每轮都算出同一个值。
 *
 * 绝不能退回 ownerHash：网关模式下它对所有请求都是同一个值，拿它绑定等于把整个网关
 * 钉死在一把 key 上，轮询失效，出错的 key 也永远不会再被这个调用方重试。
 * 身份里带上 ownerHash 前缀是为了隔离不同入站密钥，避免两家客户端共用一条绑定。
 */
function stickyKeyFor(request: FastifyRequest, auth: AuthContext, seed?: string): string | undefined {
  const explicit = explicitSessionId(request);
  const identity = explicit ?? seed ?? conversationSeed(request.body);
  return identity ? `${auth.ownerHash}:${identity}` : undefined;
}

/**
 * 目录只展示这次请求真能打到的模型：入站网关密钥的范围 ∩ 至少一个可用 Cursor key 的范围。
 * 列出会 403 的模型比藏起来更糟；GET /v1/models/:id 走同一份过滤后的列表，所以隐藏的模型会 404。
 */
async function filterListedModels(deps: AppDeps, listed: ModelListResult, auth?: AuthContext): Promise<ModelListResult> {
  const inbound = applyModelScope(listed, auth?.modelScope);
  if (auth?.mode === "direct") {
    const direct = auth.apiKey ? await deps.keyPool.getByValue(auth.apiKey) : undefined;
    // direct 请求不会在池里挑其它账号：发现结果也只能按这把已登记 key 的范围过滤。
    // 未登记 token 没有后台范围，保留无 key 的目录即可，但绝不能把它当成整池权限。
    return direct
      ? { models: filterModelsByScope(inbound.models, direct.modelScope), source: inbound.source }
      : inbound;
  }
  const keys = await deps.keyPool.list();
  const allowedIds = auth?.allowedCursorKeyIds;
  const permitted = keys.filter((key) =>
    key.status === "active" && (!allowedIds?.length || allowedIds.includes(key.id))
  );
  const visible = new Set<string>();
  for (const key of permitted) {
    for (const model of filterModelsByScope(inbound.models, key.modelScope)) {
      visible.add(model.id);
    }
  }
  return { models: inbound.models.filter((model) => visible.has(model.id)), source: inbound.source };
}

/** getUsage 必须用跑这次请求的那把 key 去查：网关模式下从池里按 keyId 取，直传模式下就是客户端自带的那把。 */
function scheduleCostBackfill(deps: AppDeps, log: RequestLog, logId: string): void {
  const reconciler = deps.usageReconciler;
  const agentId = log.telemetryRef.agentId;
  if (!reconciler || !agentId) return;
  const keyId = log.keyUsageRef.keyId;
  if (!keyId) {
    // 直传模式不经过密钥池，没有 keyId——原先这里直接 return，于是直传请求永远没有金额。
    if (log.directApiKey) reconciler.schedule({ logId, agentId, apiKey: log.directApiKey });
    return;
  }
  void deps.keyPool.get(keyId)
    .then((key) => {
      if (!key?.apiKey) {
        // key 在补写排队前被删了：没有凭据就查不到金额，但必须留痕，
        // 否则这行会永远停在「无金额」，而运维无从判断是上游没算完还是钥匙没了。
        console.error(`[request-log] cost backfill skipped: cursor key ${keyId} is gone (log=${logId})`);
        return;
      }
      reconciler.schedule({ logId, agentId, apiKey: key.apiKey });
    })
    .catch((error: unknown) => {
      console.error(
        `[request-log] cost backfill lookup failed for key ${keyId} (log=${logId}): ` +
        (error instanceof Error ? error.message.slice(0, 200) : String(error))
      );
    });
}

interface EstimatedOutput {
  completionChars: number;
  outputTokens?: number;
}

async function runLogged(
  deps: AppDeps,
  log: RequestLog,
  run: Parameters<CursorRunner["run"]>[0],
  estimate: (output: CursorRunResult) => EstimatedOutput
): Promise<CursorRunResult> {
  try {
    const output = await runWithTimeout(deps, run);
    // 非流式的估算只能补在这里：finishLog 紧接着就同步拍下 usage 快照，
    // 而响应体（连同它自己那套按协议估算的用量）要等 runLogged 返回之后才构造。
    const estimated = estimate(output);
    noteEstimatedUsage(log, run.prompt.length, estimated.completionChars, estimated.outputTokens);
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
    let reasoning = "";
    for await (const event of input.events) {
      if (event.type === "thinking" && event.text) {
        reasoning += event.text;
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
        reasoning = final.reasoningText ?? reasoning;
      }
    }
    const rendered = reasoning === final.reasoningText
      ? final
      : { ...final, ...(reasoning ? { reasoningText: reasoning } : {}) };
    const completionChars = chatCompletionChars(rendered);
    // 不放进 include_usage 分支：客户端要不要看用量，与请求历史要不要有数字是两回事。
    noteEstimatedUsage(input.log, input.prepared.prompt.length, completionChars);
    yield chunk({}, final.toolCalls.length ? "tool_calls" : "stop");
    // 未请求 usage 时不得追加 choices:[] 的块：大量客户端无脑取 choices[0] 会崩。
    if (includeUsage) {
      yield sse({
        id: input.id,
        object: "chat.completion.chunk",
        created: input.created,
        model: input.prepared.model,
        choices: [],
        usage: openAiUsage(input.prepared.prompt.length, completionChars, input.log.telemetryRef.usage)
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
  /** 本段对话的粘性身份，随响应一起落库供下一轮继承；不进 Response 对象。 */
  conversationSeed?: string;
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
        reasoning = final.reasoningText ?? reasoning;
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

    const outputChars = text.length + JSON.stringify(items.filter(isFunctionCallItem)).length;
    const usage = responsesUsage(input.prepared.prompt.length, outputChars, reasoning.length, input.log.telemetryRef.usage);
    // Responses 将正文与 reasoning 分开向上取整，日志也必须复用 response usage 的 output_tokens。
    noteEstimatedUsage(
      input.log,
      input.prepared.prompt.length,
      outputChars + reasoning.length,
      Number(usage.output_tokens)
    );
    const response = snapshot("completed", items, usage, final);
    if (input.prepared.store) await saveResponse(input.deps, input.auth, input.id, response, input.prepared.inputItems, input.conversationSeed);
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
    let reasoning = "";
    const toolCalls: CursorRunResult["toolCalls"] = [];
    const closeOpenBlock = (): string[] => {
      if (openType === null) return [];
      const chunks: string[] = [];
      // Anthropic 协议要求 thinking 块在 stop 前有 signature_delta；网关无真实签名，发一个不透明签名
      // 保证严格客户端（Claude Code）能正常收块。历史消息里的 thinking 块本网关按纯文本处理，不校验签名。
      if (openType === "thinking") {
        chunks.push(sse({ type: "content_block_delta", index: openIndex, delta: { type: "signature_delta", signature: gatewayThinkingSignature() } }, "content_block_delta"));
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
        reasoning += event.text;
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
        reasoning = event.result.reasoningText ?? reasoning;
      }
    }
    yield* closeOpenBlock();
    const completionChars = anthropicCompletionChars(input.prepared, {
      text,
      toolCalls,
      ...(reasoning ? { reasoningText: reasoning } : {})
    });
    noteEstimatedUsage(input.log, input.prepared.prompt.length, completionChars);
    yield sse({
      type: "message_delta",
      delta: { stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null },
      usage: anthropicUsage(input.prepared.prompt.length, completionChars, input.log.telemetryRef.usage)
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

/** @param seed 会话粘性身份，只写库不回显：它是选 key 用的服务端状态，泄漏给客户端等于让人指定打到哪把 key。 */
async function saveResponse(deps: AppDeps, auth: AuthContext, id: string, response: Record<string, unknown>, inputItems: unknown[], seed?: string): Promise<void> {
  const now = new Date().toISOString();
  await deps.store.saveResponse({
    id,
    ownerHash: auth.ownerHash,
    response,
    inputItems,
    ...(seed ? { conversationSeed: seed } : {}),
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

/**
 * 按端点协议选择错误信封：/v1/messages 系列用 Anthropic 形状（含 request_id），其余用 OpenAI 形状。
 * 抛错路径与未命中路由路径共用同一实现，避免两处漂移。
 */
function sendProtocolError(request: FastifyRequest, reply: FastifyReply, error: ApiError): void {
  if (request.url.startsWith("/v1/messages")) {
    // Anthropic 客户端从 request-id 头/字段拿排查用的请求标识。
    const requestId = anthropicRequestId(request);
    reply.header("request-id", requestId).status(error.statusCode).send(anthropicError(error, requestId));
    return;
  }
  reply.status(openAiStatus(error.statusCode)).send(openAiError(error));
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
