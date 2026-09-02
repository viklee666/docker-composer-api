import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, normalizeError } from "../errors.js";
import { sse } from "../sse.js";
import { isTerminal, type CursorConnectStore } from "./store.js";
import type { CursorConnectService } from "./service.js";
import type { UnifiedEvent } from "./events.js";
import { ReplayBridge } from "./background-worker.js";

/**
 * Connect 路线自己的 HTTP 面（计划 §G9）。
 *
 * 这些端点服务的是 **durable / background** 场景：无状态的 OpenAI 风格调用方
 * 本来就在下一次 `/v1/chat/completions` 里带完整历史，用不到这里。
 */
export interface ConnectRouteDeps {
  connect?: CursorConnectService;
  store?: CursorConnectStore;
  /** 鉴权钩子，与主 API 共用同一套入站密钥判定。 */
  authorize: (request: FastifyRequest) => void;
  /** 事件订阅：worker 推事件时回调，用于 SSE live 段。 */
  subscribe?: (runId: string, listener: (event: UnifiedEvent) => void) => () => void;
}

const PREFIX = "/v1/cursor-connect";

export function registerConnectRoutes(app: FastifyInstance, deps: ConnectRouteDeps): void {
  const requireStore = (): CursorConnectStore => {
    if (!deps.store) {
      throw new ApiError("Cursor Connect is not configured on this gateway.", 503, "provider_unavailable");
    }
    return deps.store;
  };

  app.get(`${PREFIX}/status`, async (request) => {
    deps.authorize(request);
    return deps.connect?.status() ?? { available: false, credentials: 0, activeCredentials: 0, reason: "未启用" };
  });

  app.get(`${PREFIX}/models`, async (request) => {
    deps.authorize(request);
    if (!deps.connect) throw new ApiError("Cursor Connect is not configured.", 503, "provider_unavailable");
    const force = (request.query as { refresh?: string } | undefined)?.refresh === "true";
    const models = await deps.connect.listModels(force);
    return { object: "list", data: models };
  });

  app.get(`${PREFIX}/runs`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const query = request.query as { conversationId?: string; limit?: string } | undefined;
    const limit = Math.min(Math.max(Number(query?.limit ?? 50) || 50, 1), 500);
    return { object: "list", data: store.listRuns({ conversationId: query?.conversationId, limit }) };
  });

  app.get(`${PREFIX}/runs/:id`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const run = store.run(runId(request));
    if (!run) throw new ApiError("Run not found.", 404, "not_found");
    return { ...run, toolCalls: store.toolCalls(run.id), tasks: store.tasksForRun(run.id) };
  });

  /**
   * SSE 重放 + live。
   *
   * `Last-Event-ID` 头（或 `?after=`）之后的事件先从库里补齐，再接 live。
   * 顺序由 `ReplayBridge` 保证：先订阅进缓冲、再翻页补发、按 seq 去重合并。
   */
  app.get(`${PREFIX}/runs/:id/events`, async (request, reply) => {
    deps.authorize(request);
    const store = requireStore();
    const id = runId(request);
    const run = store.run(id);
    if (!run) throw new ApiError("Run not found.", 404, "not_found");

    const query = request.query as { after?: string } | undefined;
    const headerId = request.headers["last-event-id"];
    const afterSeq = query?.after
      ? Math.max(0, Number(query.after) || 0)
      : store.seqFromEventId(id, typeof headerId === "string" ? headerId : undefined);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const bridge = new ReplayBridge(store, id);
    const send = (event: UnifiedEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`id: ${event.eventId}\n`);
      reply.raw.write(sse(event, event.type));
    };

    // 先订阅再补发：反过来的话，两步之间到达的事件会永远丢掉。
    const unsubscribe = deps.subscribe?.(id, (event) => {
      const passthrough = bridge.push(event);
      if (passthrough) send(passthrough);
    });

    for (const event of bridge.backfill(afterSeq)) send(event);

    const finished = store.run(id);
    if (finished && isTerminal(finished.status)) {
      unsubscribe?.();
      reply.raw.end();
      return reply;
    }

    // 心跳：中间的反向代理常在 60s 无字节时掐断空闲连接。
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keep-alive\n\n");
    }, 20_000);
    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    // 客户端断开**不**取消 background run，只解订阅。
    request.raw.on("close", close);
    return reply;
  });

  app.post(`${PREFIX}/runs/:id/cancel`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const id = runId(request);
    const run = store.run(id);
    if (!run) throw new ApiError("Run not found.", 404, "not_found");
    if (isTerminal(run.status)) return { id, status: run.status, cancelled: false };
    store.releaseRunLease(id, "cancelled");
    return { id, status: "cancelled", cancelled: true };
  });

  app.post(`${PREFIX}/runs/:id/resume`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const id = runId(request);
    const run = store.run(id);
    if (!run) throw new ApiError("Run not found.", 404, "not_found");
    const decision = resumeDecisionFor(store, run.id);
    if (decision.action !== "resume") return { id, resumed: false, ...decision };
    store.releaseRunLease(id, "queued");
    return { id, resumed: true, ...decision };
  });

  app.post(`${PREFIX}/runs/:id/tool-results`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const id = runId(request);
    if (!store.run(id)) throw new ApiError("Run not found.", 404, "not_found");

    const body = request.body as { results?: Array<{ toolCallId?: string; result?: unknown; isError?: boolean }> } | undefined;
    const results = Array.isArray(body?.results) ? body.results : [];
    if (!results.length) throw new ApiError("results must be a non-empty array.", 400, "invalid_request_error");

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const unknown: string[] = [];
    const known = new Set(store.toolCalls(id).map((call) => call.callId));
    for (const entry of results) {
      const callId = typeof entry.toolCallId === "string" ? entry.toolCallId : "";
      if (!callId || !known.has(callId)) {
        // 校验结果确实属于这个 run 且 tool_call_id 存在——否则任何人都能往别人的 run 里塞结果。
        unknown.push(callId || "(missing)");
        continue;
      }
      if (store.submitToolResult(id, callId, entry.result ?? null, entry.isError === true)) accepted.push(callId);
      else duplicates.push(callId);
    }

    // 全部结果都到齐了才把 run 放回队列，否则模型会对着还没回来的调用再跑一轮。
    const pending = store.pendingToolCalls(id);
    if (accepted.length && !pending.length) store.releaseRunLease(id, "queued");
    return { id, accepted, duplicates, unknown, pending: pending.map((call) => call.callId) };
  });

  app.get(`${PREFIX}/conversations/:id/summaries`, async (request) => {
    deps.authorize(request);
    const store = requireStore();
    const id = (request.params as { id: string }).id;
    const latest = store.latestSummary(id);
    return { conversationId: id, latest: latest ?? null };
  });
}

function runId(request: FastifyRequest): string {
  const id = (request.params as { id?: string } | undefined)?.id;
  if (!id) throw new ApiError("Missing run id.", 400, "invalid_request_error");
  return id;
}

/** 与 background-worker 的 resumeDecision 同一套规则，但把 pending tool 也算进去。 */
function resumeDecisionFor(store: CursorConnectStore, id: string): { action: string; reason: string } {
  const run = store.run(id)!;
  if (isTerminal(run.status)) return { action: "skip", reason: `run is already ${run.status}` };
  if (store.pendingToolCalls(id).length) {
    return { action: "await_tool", reason: "pending tool results; submit them first" };
  }
  if (run.deliveryState === "complete") return { action: "skip", reason: "response already delivered in full" };
  if (run.deliveryState === "partial_delivered") {
    return { action: "unknown", reason: "partial output already delivered; re-running would duplicate it" };
  }
  return { action: "resume", reason: "nothing delivered yet" };
}

/** 把内部错误转成对外 JSON。Connect 专用端点不走 OpenAI/Anthropic 的错误信封。 */
export function connectErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  const api = normalizeError(error);
  return reply.status(api.statusCode).send({ error: { message: api.message, code: api.code } });
}
