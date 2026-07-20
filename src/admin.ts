import type { FastifyInstance, FastifyRequest } from "fastify";
import { ADMIN_HTML } from "./admin-ui.js";
import { extractToken } from "./auth.js";
import { ApiError, normalizeError } from "./errors.js";
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
    const modelList = await (deps.modelLister ?? listAvailableModels)(poolKey?.apiKey);
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
    if (typeof body.cursorSdkUseHttp1ForAgent !== "boolean") {
      throw new ApiError("cursorSdkUseHttp1ForAgent must be a boolean.", 400, "invalid_request_error", "cursorSdkUseHttp1ForAgent");
    }
    deps.config.cursorSdkUseHttp1ForAgent = body.cursorSdkUseHttp1ForAgent;
    await saveCursorSdkUseHttp1ForAgent(deps.store, body.cursorSdkUseHttp1ForAgent);
    await (deps.applyCursorSdkNetworkConfig ?? applyCursorSdkNetworkConfig)(body.cursorSdkUseHttp1ForAgent);
    return {
      ok: true,
      config: {
        cursorSdkUseHttp1ForAgent: body.cursorSdkUseHttp1ForAgent
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
    const record = await deps.keyPool.add(key, label);
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
      tools: []
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
      const output = await deps.runner.run(run, controller.signal);
      logTest(deps, startedAt, run.model, keyUsageRef, 200);
      return {
        ok: true,
        text: output.text,
        keyLabel: keyUsageRef.keyLabel ?? null,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      const normalized = normalizeError(error);
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
