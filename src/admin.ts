import type { FastifyInstance, FastifyRequest } from "fastify";
import { ADMIN_HTML } from "./admin-ui.js";
import { extractToken } from "./auth.js";
import { ApiError, normalizeError, raceWithAbort } from "./errors.js";
import {
  saveAutoDisableKeys,
  saveAutoDisableThreshold,
  saveCursorFastDefault,
  saveCursorMaxModeDefault,
  saveSandClientMode
} from "./gateway-settings.js";
import { isSandClientHookPatched, parseCursorClientTypeSetting, resolveCursorClientType, runWithCursorClientType, setGlobalCursorClientType } from "./sand-client.js";
import { errorMessage, maskKey } from "./key-pool.js";
import { listAvailableModels, normalizeModel } from "./models.js";
import {
  applyCursorSdkNetworkConfig,
  loadCursorSdkUseHttp1ForAgent,
  saveCursorSdkUseHttp1ForAgent
} from "./sdk-network.js";
import type { AppDeps } from "./server.js";
import type { CursorKeyRecord, CursorRunRequest, KeyUsageRef } from "./types.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(ADMIN_HTML);
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
    const cursorSdkUseHttp1ForAgent = await loadCursorSdkUseHttp1ForAgent(deps.store, deps.config.cursorSdkUseHttp1ForAgent);
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
        cursorMaxMode: deps.config.cursorMaxMode === true,
        cursorFast: deps.config.cursorFast === true,
        autoDisableKeys: deps.keyPool.autoDisablePolicy.enabled,
        autoDisableThreshold: deps.keyPool.autoDisablePolicy.threshold,
        sandClientMode: deps.config.sandClientMode === true,
        sandClientHookPatched: isSandClientHookPatched(),
        gatewayKeyConfigured: Boolean(deps.config.gatewayApiKey)
      },
      keys: {
        total: keys.length,
        active: keys.filter((key) => key.status === "active").length,
        disabled: keys.filter((key) => key.status === "disabled").length
      },
      requests,
      models: modelList.models.map((model) => model.id),
      modelSource: modelList.source
    };
  });

  app.post("/admin/api/settings", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    let touched = false;

    if (body.cursorSdkUseHttp1ForAgent !== undefined) {
      if (typeof body.cursorSdkUseHttp1ForAgent !== "boolean") {
        throw new ApiError("cursorSdkUseHttp1ForAgent must be a boolean.", 400, "invalid_request_error", "cursorSdkUseHttp1ForAgent");
      }
      deps.config.cursorSdkUseHttp1ForAgent = body.cursorSdkUseHttp1ForAgent;
      await saveCursorSdkUseHttp1ForAgent(deps.store, body.cursorSdkUseHttp1ForAgent);
      await (deps.applyCursorSdkNetworkConfig ?? applyCursorSdkNetworkConfig)(body.cursorSdkUseHttp1ForAgent);
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

    if (!touched) throw new ApiError("No settings provided.", 400, "invalid_request_error");

    return {
      ok: true,
      config: {
        cursorSdkUseHttp1ForAgent: deps.config.cursorSdkUseHttp1ForAgent,
        cursorMaxMode: deps.config.cursorMaxMode === true,
        cursorFast: deps.config.cursorFast === true,
        autoDisableKeys: deps.keyPool.autoDisablePolicy.enabled,
        autoDisableThreshold: deps.keyPool.autoDisablePolicy.threshold,
        sandClientMode: deps.config.sandClientMode === true,
        sandClientHookPatched: isSandClientHookPatched()
      }
    };
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
    const record = await deps.keyPool.add(key, label, clientType);
    return { ok: true, key: publicKey(record) };
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

  app.delete("/admin/api/keys/:id", async (request) => {
    requireAdmin(request, deps);
    const ok = await deps.keyPool.remove(keyId(request));
    if (!ok) throw new ApiError("Key not found.", 404, "not_found");
    return { ok: true };
  });

  app.get("/admin/api/logs", async (request) => {
    requireAdmin(request, deps);
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const limit = Number.parseInt(String(query.limit ?? ""), 10);
    const logs = await deps.store.listRequestLogs(Number.isFinite(limit) && limit > 0 ? limit : 50);
    return { logs };
  });

  app.post("/admin/api/test", async (request) => {
    requireAdmin(request, deps);
    const body = objectBody(request.body);
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "Reply with exactly: pong";
    const keyId = typeof body.keyId === "string" && body.keyId.trim() ? body.keyId.trim() : undefined;
    const keyUsageRef: KeyUsageRef = {};
    const startedAt = Date.now();
    // 每次测试用唯一 sessionKey，避免复用上次的 SDK agent 会话把坏的 stale 状态带进来。
    const run: CursorRunRequest = {
      protocol: "openai-chat",
      apiKey: "",
      useKeyPool: true,
      keyUsageRef,
      model: normalizeModel(body.model),
      prompt: `You are serving a gateway connectivity test. Return only final answer text.\n\nUSER: ${prompt}`,
      sessionKey: `admin-connectivity-test-${globalThis.crypto.randomUUID()}`,
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
