import type { FastifyInstance, FastifyRequest } from "fastify";
import { ADMIN_HTML } from "./admin-ui.js";
import { extractToken } from "./auth.js";
import { createCursorApiKey } from "./cursor-account.js";
import { ApiError, normalizeError, raceWithAbort } from "./errors.js";
import { GatewayKeyPool } from "./gateway-key-pool.js";
import {
  saveAutoDisableKeys,
  saveAutoDisableThreshold,
  saveCursorFastDefault,
  saveCursorMaxModeDefault,
  saveRoutingStrategy,
  saveSandClientMode,
  saveSessionAffinity,
  saveSessionAffinityTtlMs,
  saveSystemPromptSettings
} from "./gateway-settings.js";
import { isSandClientHookPatched, parseCursorClientTypeSetting, resolveCursorClientType, runWithCursorClientType, setGlobalCursorClientType } from "./sand-client.js";
import { errorMessage, maskKey } from "./key-pool.js";
import { listAvailableModels, normalizeModel, type ModelListResult, type ModelLister } from "./models.js";
import { applyProxyConfig, parseProxyUrl, proxyStatus, testProxy } from "./proxy.js";
import { NO_KEY_SENTINEL, normalizeModelList } from "./routing.js";
import {
  applyCursorSdkNetworkConfig,
  clearCursorSdkUseHttp1ForAgent,
  lastAgentTransportReset,
  loadCursorSdkUseHttp1ForAgent,
  saveCursorSdkUseHttp1ForAgent,
  saveProxyUrl
} from "./sdk-network.js";
import type { AppDeps } from "./server.js";
import type {
  CursorClientType,
  CursorKeyRecord,
  CursorRunRequest,
  GatewayKeyPatch,
  GatewayKeyRecord,
  KeyUsageRef,
  RequestLogQuery,
  RoutingStrategy,
  SystemPromptMode
} from "./types.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

/** 低于 1 秒的粘性 TTL 绑了等于没绑，超过 30 天会让失效 key 被粘住太久。 */
const MIN_SESSION_AFFINITY_TTL_MS = 1_000;
const MAX_SESSION_AFFINITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 权重上限挡住离谱的输入，避免加权轮询的累计权重溢出。 */
const MAX_KEY_WEIGHT = 1_000_000;
/** 系统提示词正文上限：够写长规则，又不会把整段 prompt 撑到请求超时。 */
const MAX_SYSTEM_PROMPT_LENGTH = 32_000;

/**
 * 自动开 HTTP/1.1 之后必须如实交代「什么时候才真的生效」。
 * configureCursorSdk 写的是模块状态，只有新建传输层时才会读；网关会顺手放掉预热租约让旧执行器可被回收，
 * 但仍在跑的会话握着自己的引用，得等它们收尾。把这一段说清楚，好过让运维以为点完按钮就万事大吉。
 */
const HTTP1_AUTO_ENABLED_NOTICE =
  "检测到已配置代理，而「Cursor SDK HTTP/1.1」从未被设置过，已自动开启并保存：" +
  "HTTP/2 不支持代理，不开的话模型流量会绕过代理直连。" +
  "新建的会话立即按 HTTP/1.1 走；已经建好的连接仍是 HTTP/2，要等在途请求收尾才会被回收。" +
  "若模型请求仍然超时，重启网关最保险。";

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/admin", async (_request, reply) => {
    // 后台是内联单文件页面，版本随网关一起走。不禁缓存的话浏览器会启发式缓存它，
    // 升级完打开后台还是旧页面（旧 JS 打新接口），排查起来非常费时间。
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store, must-revalidate")
      .send(ADMIN_HTML);
  });

  app.post("/admin/api/login", async (request) => {
    requireAdmin(request, deps);
    return { ok: true };
  });

  app.get("/admin/api/overview", async (request) => {
    requireAdmin(request, deps);
    const keys = await deps.keyPool.list();
    const requests = await deps.store.requestLogStats();
    const poolKey = keys.find((key) => key.status === "active");
    const modelList = await runWithCursorClientType(
      resolveCursorClientType(poolKey?.clientType, deps.config.sandClientMode ? "sand" : "sdk"),
      () => (deps.modelLister ?? listAvailableModels)(poolKey?.apiKey)
    );
    const http1 = await loadCursorSdkUseHttp1ForAgent(deps.store, {
      proxyConfigured: Boolean(deps.config.proxyUrl),
      fallback: deps.config.cursorSdkUseHttp1ForAgent
    });
    const cursorSdkUseHttp1ForAgent = http1.enabled;
    const routing = deps.keyPool.routingPolicy;
    const gatewayKeys = deps.gatewayKeyPool ? await deps.gatewayKeyPool.list() : undefined;
    return {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.floor((Date.now() - (deps.startedAt ?? Date.now())) / 1000),
      storage: "sqlite",
      config: {
        allowDirectCursorKeys: deps.config.allowDirectCursorKeys,
        requestTimeoutMs: deps.config.requestTimeoutMs,
        workingDirectory: deps.config.cursorWorkingDirectory,
        cursorSdkUseHttp1ForAgent,
        // 后台的开关是三态的，光给布尔值它分不出「运维亲手设的」与「网关按代理替他决定的」，
        // 于是只能拿一个 checkbox 回显，一保存就把「没表过态」写成了显式取值。
        cursorSdkUseHttp1Source: http1.source,
        cursorMaxMode: deps.config.cursorMaxMode === true,
        cursorFast: deps.config.cursorFast === true,
        autoDisableKeys: deps.keyPool.autoDisablePolicy.enabled,
        autoDisableThreshold: deps.keyPool.autoDisablePolicy.threshold,
        sandClientMode: deps.config.sandClientMode === true,
        sandClientHookPatched: isSandClientHookPatched(),
        gatewayKeyConfigured: Boolean(deps.config.gatewayApiKey),
        routingStrategy: routing.strategy,
        sessionAffinity: routing.sessionAffinity,
        sessionAffinityTtlMs: routing.sessionAffinityTtlMs,
        systemPromptMode: deps.config.systemPromptMode,
        systemPromptSet: Boolean(deps.config.systemPrompt?.trim()),
        proxy: proxyStatus({ useHttp1ForAgent: cursorSdkUseHttp1ForAgent })
      },
      keys: {
        total: keys.length,
        active: keys.filter((key) => key.status === "active").length,
        disabled: keys.filter((key) => key.status === "disabled").length
      },
      ...(gatewayKeys
        ? {
          gatewayKeys: {
            total: gatewayKeys.length,
            active: gatewayKeys.filter((key) => key.status === "active").length,
            disabled: gatewayKeys.filter((key) => key.status === "disabled").length
          }
        }
        : {}),
      requests,
      models: modelList.models.map((model) => model.id),
      modelSource: modelList.source
    };
  });

  /**
   * 管理后台模型选择器的完整目录。必须不过滤：这里是运营勾选 allow/deny 的源，
   * 套上某把 key 的范围会让被禁掉的模型从名单里消失，再也勾不回来。
   */
  app.get("/admin/api/models", async (request) => {
    requireAdmin(request, deps);
    return globalModelCatalogue(deps);
  });

  app.post("/admin/api/settings", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    let touched = false;
    let http1Toggled = false;
    let http1AutoEnabled = false;
    let executorResetWarning: string | undefined;
    const applyNetwork = deps.applyCursorSdkNetworkConfig ?? applyCursorSdkNetworkConfig;
    /** 只有真的调过默认实现，lastAgentTransportReset() 才是这一次的结果（测试注入的桩不写它）。 */
    const applyNetworkAndReport = async (enabled: boolean): Promise<void> => {
      await applyNetwork(enabled);
      if (applyNetwork !== applyCursorSdkNetworkConfig) return;
      const report = lastAgentTransportReset();
      if (report && !report.ok) executorResetWarning = report.detail;
    };

    // null 表示「退回未设置」，是这个三态开关的第三个值。
    // 没有它，后台就只能用 true/false 表达一切，于是任何一次保存都会把「没人表过态」
    // 变成一个显式取值，配代理时的自动启用从此永远不会发生。
    if (body.cursorSdkUseHttp1ForAgent !== undefined) {
      if (typeof body.cursorSdkUseHttp1ForAgent !== "boolean" && body.cursorSdkUseHttp1ForAgent !== null) {
        throw new ApiError(
          "cursorSdkUseHttp1ForAgent must be a boolean, or null to fall back to the proxy-aware default.",
          400,
          "invalid_request_error",
          "cursorSdkUseHttp1ForAgent"
        );
      }
      if (body.cursorSdkUseHttp1ForAgent === null) await clearCursorSdkUseHttp1ForAgent(deps.store);
      else await saveCursorSdkUseHttp1ForAgent(deps.store, body.cursorSdkUseHttp1ForAgent);
      // 退回未设置之后生效值要按三态重算：配着代理时它仍然是开着的，
      // 直接把 null 当 false 用会在运维毫不知情的情况下让模型流量绕过代理。
      const effective = await loadCursorSdkUseHttp1ForAgent(deps.store, {
        proxyConfigured: Boolean(deps.config.proxyUrl)
      });
      deps.config.cursorSdkUseHttp1ForAgent = effective.enabled;
      await applyNetworkAndReport(effective.enabled);
      http1Toggled = true;
      touched = true;
    }

    // Max Mode / Fast 默认开关：开启→网关对支持的模型强制默认；关闭→网关不强加默认（交回客户端/模型）。
    if (body.cursorMaxMode !== undefined) {
      if (typeof body.cursorMaxMode !== "boolean") {
        throw new ApiError("cursorMaxMode must be a boolean.", 400, "invalid_request_error", "cursorMaxMode");
      }
      deps.config.cursorMaxMode = body.cursorMaxMode ? true : undefined;
      await saveCursorMaxModeDefault(deps.store, body.cursorMaxMode);
      touched = true;
    }

    if (body.cursorFast !== undefined) {
      if (typeof body.cursorFast !== "boolean") {
        throw new ApiError("cursorFast must be a boolean.", 400, "invalid_request_error", "cursorFast");
      }
      deps.config.cursorFast = body.cursorFast ? true : undefined;
      await saveCursorFastDefault(deps.store, body.cursorFast);
      touched = true;
    }

    // 自动禁用策略：关掉后失效/额度错误只轮换不禁用，阈值决定连续失败多少次才禁。
    if (body.autoDisableKeys !== undefined) {
      if (typeof body.autoDisableKeys !== "boolean") {
        throw new ApiError("autoDisableKeys must be a boolean.", 400, "invalid_request_error", "autoDisableKeys");
      }
      deps.config.autoDisableKeys = body.autoDisableKeys;
      deps.keyPool.setAutoDisablePolicy({ enabled: body.autoDisableKeys });
      await saveAutoDisableKeys(deps.store, body.autoDisableKeys);
      touched = true;
    }

    if (body.autoDisableThreshold !== undefined) {
      const threshold = typeof body.autoDisableThreshold === "number" ? body.autoDisableThreshold : Number.NaN;
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50) {
        throw new ApiError(
          "autoDisableThreshold must be an integer between 1 and 50.",
          400,
          "invalid_request_error",
          "autoDisableThreshold"
        );
      }
      deps.config.autoDisableThreshold = threshold;
      deps.keyPool.setAutoDisablePolicy({ threshold });
      await saveAutoDisableThreshold(deps.store, threshold);
      touched = true;
    }

    if (body.sandClientMode !== undefined) {
      if (typeof body.sandClientMode !== "boolean") {
        throw new ApiError("sandClientMode must be a boolean.", 400, "invalid_request_error", "sandClientMode");
      }
      await saveSandClientMode(deps.store, body.sandClientMode);
      deps.config.sandClientMode = body.sandClientMode;
      setGlobalCursorClientType(body.sandClientMode ? "sand" : "sdk");
      touched = true;
    }

    // 路由策略必须三处一起写：只落库要等重启，只改 config 选 key 仍走池里的旧副本。
    if (body.routingStrategy !== undefined) {
      const strategy = parseRoutingStrategy(body.routingStrategy);
      deps.config.routingStrategy = strategy;
      deps.keyPool.setRoutingPolicy({ strategy });
      await saveRoutingStrategy(deps.store, strategy);
      touched = true;
    }

    if (body.sessionAffinity !== undefined) {
      if (typeof body.sessionAffinity !== "boolean") {
        throw new ApiError("sessionAffinity must be a boolean.", 400, "invalid_request_error", "sessionAffinity");
      }
      deps.config.sessionAffinity = body.sessionAffinity;
      deps.keyPool.setRoutingPolicy({ sessionAffinity: body.sessionAffinity });
      await saveSessionAffinity(deps.store, body.sessionAffinity);
      touched = true;
    }

    if (body.sessionAffinityTtlMs !== undefined) {
      const ttlMs = typeof body.sessionAffinityTtlMs === "number" ? body.sessionAffinityTtlMs : Number.NaN;
      if (!Number.isInteger(ttlMs) || ttlMs < MIN_SESSION_AFFINITY_TTL_MS || ttlMs > MAX_SESSION_AFFINITY_TTL_MS) {
        throw new ApiError(
          "sessionAffinityTtlMs must be an integer between 1000 and 2592000000 (30 days).",
          400,
          "invalid_request_error",
          "sessionAffinityTtlMs"
        );
      }
      deps.config.sessionAffinityTtlMs = ttlMs;
      deps.keyPool.setRoutingPolicy({ sessionAffinityTtlMs: ttlMs });
      await saveSessionAffinityTtlMs(deps.store, ttlMs);
      touched = true;
    }

    // mode 与正文分存：关掉注入时仍保留草稿，空白正文按「没有提示词」处理，免得把客户端自己的 system 洗掉。
    if (body.systemPromptMode !== undefined || body.systemPromptText !== undefined) {
      const mode = body.systemPromptMode !== undefined
        ? parseSystemPromptMode(body.systemPromptMode)
        : deps.config.systemPromptMode;
      const text = body.systemPromptText !== undefined
        ? parseSystemPromptText(body.systemPromptText)
        : (deps.config.systemPrompt?.trim() || undefined);
      deps.config.systemPromptMode = mode;
      deps.config.systemPrompt = text;
      await saveSystemPromptSettings(deps.store, { mode, ...(text ? { text } : {}) });
      touched = true;
    }

    // 先 parse 再落库：非法地址若只 trim 进 config，下次请求会全军覆没且要重启才能改回来。
    if (body.proxyUrl !== undefined) {
      if (typeof body.proxyUrl !== "string") {
        throw new ApiError("proxyUrl must be a string.", 400, "invalid_request_error", "proxyUrl");
      }
      const trimmed = body.proxyUrl.trim();
      const url = trimmed ? parseProxyUrl(trimmed).url : undefined;
      deps.config.proxyUrl = url;
      await saveProxyUrl(deps.store, url);
      // 配了代理却不开 HTTP/1.1，模型流量仍走不支持代理的 HTTP/2，等于代理白配。
      // 所以只要运维从没表过态（库里没行、环境变量也没写），保存代理就顺手把开关顶上去并落库。
      // 反过来清空代理时不动它：开关是运维自己开的，网关没有替他关掉的理由。
      if (url && !http1Toggled && (await loadCursorSdkUseHttp1ForAgent(deps.store, { proxyConfigured: true })).source === "proxy") {
        deps.config.cursorSdkUseHttp1ForAgent = true;
        await saveCursorSdkUseHttp1ForAgent(deps.store, true);
        await applyNetworkAndReport(true);
        http1AutoEnabled = true;
      }
      applyProxyConfig(url, { useHttp1ForAgent: deps.config.cursorSdkUseHttp1ForAgent });
      touched = true;
    }

    if (!touched) throw new ApiError("No settings provided.", 400, "invalid_request_error");

    // HTTP/2 不支持代理：HTTP/1.1 开关一变，模型流量是否真走代理必须按新值重算告警。
    const http1 = deps.config.cursorSdkUseHttp1ForAgent;
    const proxy = http1Toggled && deps.config.proxyUrl
      ? applyProxyConfig(deps.config.proxyUrl, { useHttp1ForAgent: http1 })
      : proxyStatus({ useHttp1ForAgent: http1 });
    const routing = deps.keyPool.routingPolicy;
    // 回显来源而不只是布尔值：后台的三态控件靠它决定该停在「未设置」还是「强制开/关」，
    // 回一个布尔就等于逼前端把状态压平，正是这个开关被悄悄写死的起点。
    const http1Source = (await loadCursorSdkUseHttp1ForAgent(deps.store, {
      proxyConfigured: Boolean(deps.config.proxyUrl)
    })).source;

    return {
      ok: true,
      ...(http1AutoEnabled ? { http1AutoEnabled: true, notice: HTTP1_AUTO_ENABLED_NOTICE } : {}),
      ...(executorResetWarning ? { executorResetWarning } : {}),
      config: {
        cursorSdkUseHttp1ForAgent: deps.config.cursorSdkUseHttp1ForAgent,
        cursorSdkUseHttp1Source: http1Source,
        cursorMaxMode: deps.config.cursorMaxMode === true,
        cursorFast: deps.config.cursorFast === true,
        autoDisableKeys: deps.keyPool.autoDisablePolicy.enabled,
        autoDisableThreshold: deps.keyPool.autoDisablePolicy.threshold,
        sandClientMode: deps.config.sandClientMode === true,
        sandClientHookPatched: isSandClientHookPatched(),
        routingStrategy: routing.strategy,
        sessionAffinity: routing.sessionAffinity,
        sessionAffinityTtlMs: routing.sessionAffinityTtlMs,
        systemPromptMode: deps.config.systemPromptMode,
        systemPrompt: deps.config.systemPrompt ?? "",
        proxy,
        warnings: proxy.warnings
      }
    };
  });

  app.get("/admin/api/proxy", async (request) => {
    requireAdmin(request, deps);
    return proxyStatus({ useHttp1ForAgent: deps.config.cursorSdkUseHttp1ForAgent });
  });

  /**
   * 系统提示词正文单独一个读接口。
   * 不塞进 /overview 是因为后台每 10 秒轮询一次 overview，而正文可以有几万字；
   * 也不该让前端靠「POST 一次设置再看回显」来取正文——那是用写操作做读操作。
   */
  app.get("/admin/api/system-prompt", async (request) => {
    requireAdmin(request, deps);
    return { mode: deps.config.systemPromptMode, text: deps.config.systemPrompt ?? "" };
  });

  /**
   * 探测只打一次性 agent，绝不换掉进程里已经装上的 dispatcher。
   * 响应里不能带凭据：testProxy 已经抹过，这里也不回传用户提交的 URL。
   */
  app.post("/admin/api/proxy/test", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const raw = typeof body.proxyUrl === "string" ? body.proxyUrl : (deps.config.proxyUrl ?? "");
    if (!raw.trim()) {
      throw new ApiError("No proxy URL configured to test.", 400, "invalid_request_error", "proxyUrl");
    }
    return testProxy(raw);
  });

  app.get("/admin/api/keys", async (request) => {
    requireAdmin(request, deps);
    const keys = await deps.keyPool.list();
    return { keys: keys.map(publicKey) };
  });

  app.post("/admin/api/keys", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const key = typeof body.key === "string" ? body.key : "";
    const label = typeof body.label === "string" ? body.label : undefined;
    const clientType = body.clientType === undefined ? "inherit" : parseCursorClientTypeSetting(body.clientType);
    if (!clientType) {
      throw new ApiError("clientType must be inherit, sdk, or sand.", 400, "invalid_request_error", "clientType");
    }
    const allowed = optionalStringArray(body.allowed, "allowed");
    const excluded = optionalStringArray(body.excluded, "excluded");
    const weight = body.weight === undefined ? undefined : parseWeight(body.weight);
    const record = await deps.keyPool.add(key, label, clientType, {
      ...(allowed !== undefined || excluded !== undefined
        ? { modelScope: { allowed: allowed ?? [], excluded: excluded ?? [] } }
        : {}),
      ...(weight !== undefined ? { weight } : {})
    });
    return { ok: true, key: publicKey(record) };
  });

  /**
   * 用 Cursor 后台会话铸一把 API key 并入池。session token 等同账号密码，
   * 绝不能落库、写日志或回显——铸完即弃，只把铸出的 key 留下。
   */
  app.post("/admin/api/keys/mint", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : "";
    const clientType = body.clientType === undefined ? "inherit" : parseCursorClientTypeSetting(body.clientType);
    if (!clientType) {
      throw new ApiError("clientType must be inherit, sdk, or sand.", 400, "invalid_request_error", "clientType");
    }
    const minted = await createCursorApiKey({
      sessionToken,
      name: body.name as string | undefined
    });
    const record = await deps.keyPool.add(minted.apiKey, minted.name, clientType);
    return { ok: true, key: publicKey(record), name: minted.name };
  });

  app.post("/admin/api/keys/reorder", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    await deps.keyPool.reorder(ids);
    const keys = await deps.keyPool.list();
    return { ok: true, keys: keys.map(publicKey) };
  });

  app.post("/admin/api/keys/:id/enable", async (request) => {
    requireAdmin(request, deps);
    const ok = await deps.keyPool.enable(keyId(request));
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    return { ok: true };
  });

  app.post("/admin/api/keys/:id/disable", async (request) => {
    requireAdmin(request, deps);
    const ok = await deps.keyPool.disable(keyId(request), "manual");
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    return { ok: true };
  });

  app.post("/admin/api/keys/:id/channel", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const clientType = parseCursorClientTypeSetting(body.clientType);
    if (!clientType) {
      throw new ApiError("clientType must be inherit, sdk, or sand.", 400, "invalid_request_error", "clientType");
    }
    const ok = await deps.keyPool.setClientType(keyId(request), clientType);
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    const record = await deps.keyPool.get(keyId(request));
    return { ok: true, key: record ? publicKey(record) : undefined };
  });

  /**
   * 按 key 收窄模型：一把号只跑便宜模型、另一把专跑 opus，避免选 key 时把范围外的请求打上去再报错。
   */
  app.post("/admin/api/keys/:id/models", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const ok = await deps.keyPool.setModelScope(keyId(request), {
      allowed: optionalStringArray(body.allowed, "allowed") ?? [],
      excluded: optionalStringArray(body.excluded, "excluded") ?? []
    });
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    const record = await deps.keyPool.get(keyId(request));
    if (!record) throw new ApiError("Key not found.", 404, "not_found");
    return { ok: true, key: publicKey(record) };
  });

  app.post("/admin/api/keys/:id/weight", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const ok = await deps.keyPool.setWeight(keyId(request), parseWeight(body.weight));
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    const record = await deps.keyPool.get(keyId(request));
    if (!record) throw new ApiError("Key not found.", 404, "not_found");
    return { ok: true, key: publicKey(record) };
  });

  app.delete("/admin/api/keys/:id", async (request) => {
    requireAdmin(request, deps);
    const ok = await deps.keyPool.remove(keyId(request));
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    // 删 key 会绕过网关密钥池直接改 gateway_keys（剔除绑定），不刷新快照的话
    // authenticate() 会一直拿重启前的旧绑定，被删的 key 在鉴权侧仍然「可用」。
    // 池是可选依赖，没接多密钥模式时这里必须静默跳过，不能把删 key 变成 503。
    await deps.gatewayKeyPool?.refresh();
    return { ok: true };
  });

  app.get("/admin/api/gateway-keys", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const keys = await pool.list();
    return { keys: keys.map((key) => publicGatewayKey(key)) };
  });

  /**
   * 入站密钥只在创建这一次回明文：列表永远只给掩码，丢了就只能作废重发。
   */
  app.post("/admin/api/gateway-keys", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const body = objectBody(request.body);
    const apiKey = typeof body.key === "string" && body.key.trim()
      ? body.key.trim()
      : GatewayKeyPool.generateKey();
    const label = typeof body.label === "string" ? body.label : undefined;
    const allowedCursorKeyIds = await resolveAllowedCursorKeyIds(body.allowedCursorKeyIds, deps);
    const allowed = optionalStringArray(body.allowed, "allowed");
    const excluded = optionalStringArray(body.excluded, "excluded");
    const record = await pool.add(apiKey, {
      label,
      ...(allowedCursorKeyIds !== undefined ? { allowedCursorKeyIds } : {}),
      ...(allowed !== undefined || excluded !== undefined
        ? { modelScope: { allowed: allowed ?? [], excluded: excluded ?? [] } }
        : {})
    });
    return { ok: true, key: publicGatewayKey(record, { reveal: true }) };
  });

  app.post("/admin/api/gateway-keys/:id", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const body = objectBody(request.body);
    const patch: GatewayKeyPatch = {};
    if (body.label !== undefined) {
      if (typeof body.label !== "string") {
        throw new ApiError("label must be a string.", 400, "invalid_request_error", "label");
      }
      patch.label = body.label;
    }
    const allowedCursorKeyIds = await resolveAllowedCursorKeyIds(body.allowedCursorKeyIds, deps);
    if (allowedCursorKeyIds !== undefined) patch.allowedCursorKeyIds = allowedCursorKeyIds;
    const allowed = optionalStringArray(body.allowed, "allowed");
    const excluded = optionalStringArray(body.excluded, "excluded");
    if (allowed !== undefined || excluded !== undefined) {
      patch.modelScope = { allowed: allowed ?? [], excluded: excluded ?? [] };
    }
    const record = await pool.update(keyId(request), patch);
    if (!record) throw new ApiError("Gateway key not found.", 404, "not_found");
    return { ok: true, key: publicGatewayKey(record) };
  });

  app.post("/admin/api/gateway-keys/:id/enable", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const ok = await pool.enable(keyId(request));
    if (!ok) throw new ApiError("Gateway key not found.", 404, "not_found");
    return { ok: true };
  });

  app.post("/admin/api/gateway-keys/:id/disable", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const ok = await pool.disable(keyId(request));
    if (!ok) throw new ApiError("Gateway key not found.", 404, "not_found");
    return { ok: true };
  });

  /**
   * env 播种的密钥拒绝物理删除：环境配置可能再次播种同一凭据，而保留停用行才能留下审计轨迹。
   * `seedFromEnv` 会把移除或轮换后的旧行停用；停用也会先于 legacy 分支被鉴权检查。
   */
  app.delete("/admin/api/gateway-keys/:id", async (request) => {
    requireAdmin(request, deps);
    const pool = requireGatewayKeyPool(deps);
    const id = keyId(request);
    const existing = await pool.get(id);
    if (!existing) throw new ApiError("Gateway key not found.", 404, "not_found");
    if (existing.source === "env") {
      throw new ApiError(
        "This gateway key is managed by GATEWAY_API_KEY and cannot be deleted. Disable it now to revoke access, or remove GATEWAY_API_KEY and restart; startup will disable the retained record without erasing its audit history.",
        409,
        "gateway_key_env_managed"
      );
    }
    const ok = await pool.remove(id);
    if (!ok) throw new ApiError("Gateway key not found.", 404, "not_found");
    return { ok: true };
  });

  /**
   * 请求历史。默认每页 100 条（老版本固定只取 50 条，用量核对根本不够看），
   * 支持 offset 翻页与按 key / 网关密钥 / 模型 / 成败 / 时间过滤，并回传 total 供前端分页。
   */
  app.get("/admin/api/logs", async (request) => {
    requireAdmin(request, deps);
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const requested = positiveInt(query.limit) ?? 100;
    const logQuery: RequestLogQuery = {
      limit: requested,
      offset: positiveInt(query.offset) ?? 0,
      ...(stringParam(query.keyId) ? { keyId: stringParam(query.keyId) } : {}),
      ...(stringParam(query.gatewayKeyId) ? { gatewayKeyId: stringParam(query.gatewayKeyId) } : {}),
      ...(stringParam(query.model) ? { model: stringParam(query.model) } : {}),
      ...(parseOutcome(query.outcome) ? { outcome: parseOutcome(query.outcome) } : {}),
      ...(stringParam(query.since) ? { since: stringParam(query.since) } : {})
    };
    const page = await deps.store.listRequestLogs(logQuery);
    return { logs: page.logs, total: page.total, limit: logQuery.limit, offset: logQuery.offset ?? 0 };
  });

  app.post("/admin/api/logs/clear", async (request) => {
    requireAdmin(request, deps);
    const removed = await deps.store.clearRequestLogs();
    return { ok: true, removed };
  });

  app.post("/admin/api/test", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "Reply with exactly: pong";
    const keyId = typeof body.keyId === "string" && body.keyId.trim() ? body.keyId.trim() : undefined;
    const keyUsageRef: KeyUsageRef = {};
    const startedAt = Date.now();
    // 每次测试用唯一 sessionKey，并强制本请求 stateless：不得进 Hub / 旧 resume，避免粘到用户会话或坏 agent。
    const run: CursorRunRequest = {
      protocol: "openai-chat",
      apiKey: "",
      useKeyPool: true,
      keyUsageRef,
      model: normalizeModel(body.model),
      prompt: `You are serving a gateway connectivity test. Return only final answer text.\n\nUSER: ${prompt}`,
      sessionKey: `admin-connectivity-test-${globalThis.crypto.randomUUID()}`,
      forceStateless: true,
      workingDirectory: deps.config.cursorWorkingDirectory,
      images: [],
      tools: [],
      // 联通性测试也带上网关默认意图（fast/Max Mode 等），否则仪表盘里这些测试请求永远显示非 fast，误导排查。
      reasoningEffort: deps.config.cursorReasoningEffort,
      maxMode: deps.config.cursorMaxMode,
      fast: deps.config.cursorFast,
      modelParams: deps.config.cursorModelParams,
      mode: deps.config.cursorAgentMode
    };
    // 指定 keyId 时只验证该 key（绕过密钥池轮换），便于逐个定位到底是哪个 key 不可用。
    if (keyId) {
      const target = (await deps.keyPool.list()).find((key) => key.id === keyId);
      if (!target) throw new ApiError("Key not found.", 404, "not_found", "keyId");
      run.useKeyPool = false;
      run.apiKey = target.apiKey;
      keyUsageRef.keyId = target.id;
      keyUsageRef.keyLabel = target.label;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.config.requestTimeoutMs);
    try {
      // 与 abort 竞速：上游完全无视 signal 挂死时，联通性测试也必须在超时后返回而非悬挂。
      const output = await raceWithAbort(deps.runner.run(run, controller.signal), controller.signal);
      // 指定 key 的测试绕过了密钥池，成功也要回写健康状态，否则后台会一直挂着早已恢复的失败计数与红字。
      if (keyId) await deps.keyPool.recordSuccess(keyId);
      logTest(deps, startedAt, run.model, keyUsageRef, 200);
      return {
        ok: true,
        text: output.text,
        keyLabel: keyUsageRef.keyLabel ?? null,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      const normalized = normalizeError(error);
      // 人工点的诊断按 transient 记：只留错误痕迹，不计入自动禁用（否则一顿测试就能把 key 测没）。
      if (keyId) await deps.keyPool.reportFailure(keyId, "transient", errorMessage(error));
      logTest(deps, startedAt, run.model, keyUsageRef, normalized.statusCode, errorMessage(error));
      return {
        ok: false,
        error: normalized.message,
        keyLabel: keyUsageRef.keyLabel ?? null,
        durationMs: Date.now() - startedAt
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

function requireAdmin(request: FastifyRequest, deps: AppDeps): void {
  if (!deps.config.adminPassword) {
    throw new ApiError("Admin panel is disabled. Set ADMIN_PASSWORD or GATEWAY_API_KEY.", 503, "admin_disabled");
  }
  const token = extractToken(request);
  if (!token || token !== deps.config.adminPassword) {
    throw new ApiError("Invalid admin credentials.", 401, "unauthorized");
  }
  // 未设置 ADMIN_PASSWORD 时，后台口令就是 GATEWAY_API_KEY；停用网关密钥后若仍只比较配置值，
  // 持有者会立刻调用 enable 自己复活。停用状态必须覆盖这条兼容的管理员认证路径。
  if (deps.gatewayKeyPool?.resolveAny(token)?.status === "disabled") {
    throw new ApiError("This gateway API key is disabled.", 401, "unauthorized");
  }
}

/** 多密钥入站没接上时所有 gateway-keys 接口都得直接 503，否则 UI 会以为写进去了其实根本没池。 */
function requireGatewayKeyPool(deps: AppDeps): GatewayKeyPool {
  if (!deps.gatewayKeyPool) {
    throw new ApiError("Gateway multi-key mode is not configured.", 503, "gateway_keys_unavailable");
  }
  return deps.gatewayKeyPool;
}

/** 后台模型选择器的一条：只要 id / 名称 / 别名，参数定义与 variants 对勾选没用。 */
interface CatalogueEntry {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * 全局模型清单 = 池里所有 active key 目录的并集（按 id 去重，别名取并集）。
 * 取单把 key 的目录当全局清单是错的：不同账号 / 通道能看到的模型本来就不一样，
 * 那样运营就勾不到「只有另一把 key 才有」的模型。
 * 成本可控——目录按 (apiKey, 通道) 缓存 10 分钟，并集在缓存命中时只是几次内存查表；
 * 单把 key 拉取失败也只是少贡献几条，不该让整份清单塌成兜底列表。
 */
async function globalModelCatalogue(deps: AppDeps): Promise<{ models: CatalogueEntry[]; source: "cursor" | "fallback" }> {
  const lister = deps.modelLister ?? listAvailableModels;
  const globalType = deps.config.sandClientMode ? "sand" : "sdk";
  const active = (await deps.keyPool.list()).filter((key) => key.status === "active");
  const merged = new Map<string, CatalogueEntry>();
  let source: "cursor" | "fallback" = "fallback";
  for (const key of active) {
    const listed = await listCatalogue(lister, resolveCursorClientType(key.clientType, globalType), key.apiKey);
    if (!listed) continue;
    if (listed.source === "cursor") source = "cursor";
    for (const model of listed.models) mergeCatalogueEntry(merged, model);
  }
  // 一把 active key 都没有（或全部拉取失败）时退回无 key 目录：进程缓存或静态兜底。
  // 空清单会让后台的模型勾选框整片空白，运维连手填的参照都没有。
  if (!merged.size) {
    const listed = await listCatalogue(lister, globalType, undefined);
    if (listed) {
      source = listed.source;
      for (const model of listed.models) mergeCatalogueEntry(merged, model);
    }
  }
  return { models: [...merged.values()], source };
}

/** 单把 key 的目录查询：失败一律吞掉。runWithCursorClientType 是同步转发，所以要用 try 而不是 .catch。 */
async function listCatalogue(
  lister: ModelLister,
  clientType: CursorClientType,
  apiKey: string | undefined
): Promise<ModelListResult | undefined> {
  try {
    return await runWithCursorClientType(clientType, () => lister(apiKey));
  } catch {
    return undefined;
  }
}

function mergeCatalogueEntry(merged: Map<string, CatalogueEntry>, model: CatalogueEntry): void {
  const id = model.id?.trim();
  if (!id) return;
  const existing = merged.get(id.toLowerCase());
  if (!existing) {
    merged.set(id.toLowerCase(), { id, name: model.name || id, aliases: [...new Set(model.aliases ?? [])] });
    return;
  }
  for (const alias of model.aliases ?? []) {
    if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
  }
}

function publicKey(record: CursorKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    maskedKey: maskKey(record.apiKey),
    status: record.status,
    source: record.source,
    sortOrder: record.sortOrder,
    disabledReason: record.disabledReason ?? null,
    disabledAt: record.disabledAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
    lastError: record.lastError ?? null,
    requestCount: record.requestCount,
    failureCount: record.failureCount,
    clientType: record.clientType,
    modelScope: record.modelScope,
    weight: record.weight,
    createdAt: record.createdAt
  };
}

function publicGatewayKey(record: GatewayKeyRecord, options: { reveal?: boolean } = {}): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    maskedKey: maskKey(record.apiKey),
    // 仅创建/生成时回一次完整密钥：之后再也取不回明文。
    ...(options.reveal ? { apiKey: record.apiKey } : {}),
    status: record.status,
    source: record.source,
    allowedCursorKeyIds: record.allowedCursorKeyIds,
    modelScope: record.modelScope,
    requestCount: record.requestCount,
    lastUsedAt: record.lastUsedAt ?? null,
    createdAt: record.createdAt
  };
}

function logTest(deps: AppDeps, startedAt: number, model: string, keyUsageRef: KeyUsageRef, status: number, error?: string): void {
  void deps.store
    .insertRequestLog({
      id: globalThis.crypto.randomUUID().replaceAll("-", ""),
      ts: new Date().toISOString(),
      endpoint: "/admin/api/test",
      model,
      authMode: "admin",
      keyId: keyUsageRef.keyId,
      keyLabel: keyUsageRef.keyLabel,
      status,
      durationMs: Date.now() - startedAt,
      stream: false,
      error: error ? error.slice(0, 500) : undefined
    })
    .catch(() => undefined);
}

function keyId(request: FastifyRequest): string {
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) throw new ApiError("Missing key id.", 400, "invalid_request_error", "id");
  return id;
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

/** 查询串参数一律是字符串；解析失败返回 undefined，让调用方用自己的默认值。 */
function positiveInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringParam(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function parseOutcome(value: unknown): "success" | "error" | undefined {
  return value === "success" || value === "error" ? value : undefined;
}

function optionalStringArray(value: unknown, param: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(`${param} must be an array of strings.`, 400, "invalid_request_error", param);
  }
  return normalizeModelList(value);
}

function parseWeight(value: unknown): number {
  const weight = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_KEY_WEIGHT) {
    throw new ApiError(
      "weight must be an integer between 1 and 1000000.",
      400,
      "invalid_request_error",
      "weight"
    );
  }
  return weight;
}

function parseRoutingStrategy(value: unknown): RoutingStrategy {
  if (value === "fill-first" || value === "round-robin") return value;
  throw new ApiError(
    "routingStrategy must be fill-first or round-robin.",
    400,
    "invalid_request_error",
    "routingStrategy"
  );
}

function parseSystemPromptMode(value: unknown): SystemPromptMode {
  if (value === "off" || value === "append" || value === "override") return value;
  throw new ApiError(
    "systemPromptMode must be off, append, or override.",
    400,
    "invalid_request_error",
    "systemPromptMode"
  );
}

function parseSystemPromptText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    throw new ApiError("systemPromptText must be a string.", 400, "invalid_request_error", "systemPromptText");
  }
  if (value.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new ApiError(
      "systemPromptText must be at most 32000 characters.",
      400,
      "invalid_request_error",
      "systemPromptText"
    );
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 绑到不存在的 Cursor key 会让这条入站密钥永远选不到凭据，必须在写入前拒绝。
 *
 * 唯一的例外是 `NO_KEY_SENTINEL`：它是删掉最后一把绑定 key 时写下的「全禁」标记，
 * 按定义就不存在对应的 Cursor key。后台回填这条绑定时会原样带回来，
 * 若按未知 id 拒掉，运维就只能靠清空绑定来「修好」表单——而清空的语义恰恰是放开整池。
 * 勾了真实 key 则以真实绑定为准，哨兵随之作废。
 */
async function resolveAllowedCursorKeyIds(value: unknown, deps: AppDeps): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(
      "allowedCursorKeyIds must be an array of key ids.",
      400,
      "invalid_request_error",
      "allowedCursorKeyIds"
    );
  }
  const submitted = [...new Set(
    value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
  )];
  const ids = submitted.filter((id) => id !== NO_KEY_SENTINEL);
  if (!ids.length) return submitted.length ? [NO_KEY_SENTINEL] : [];
  const known = new Set((await deps.keyPool.list()).map((key) => key.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new ApiError(
      `Unknown Cursor key id(s): ${unknown.join(", ")}.`,
      400,
      "invalid_request_error",
      "allowedCursorKeyIds"
    );
  }
  return ids;
}
