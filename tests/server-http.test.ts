import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../src/errors.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { createApp, resolveStreamError, shouldSuppressStreamError } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayConfig,
  RequestLogRecord,
  RunTelemetryRef
} from "../src/types.js";

/**
 * 真实 HTTP server 的 499 / 504 空闲超时 / abortReason 测试（计划 §5 包 C）。
 *
 * 全套网关单测走 app.inject()，light-my-request 的模拟 socket 与真实 Node HTTP server
 * 在 request.raw.destroyed / socket.destroyed 上语义不同——恰是包 C 要修的判据所在地，
 * 所以这里必须真的 listen(0) 并用 http 客户端打，inject 永远测不出这条路径。
 */

const baseConfig: GatewayConfig = {
  host: "127.0.0.1",
  port: 0,
  cursorApiKeys: ["server-cursor-key"],
  gatewayApiKey: "gateway-key",
  adminPassword: "gateway-key",
  allowDirectCursorKeys: true,
  sqlitePath: ":memory:",
  requestLogKeep: 0,
  cursorWorkingDirectory: "/workspace",
  requestTimeoutMs: 10_000,
  sdkClientVersion: "sdk-1.0.27",
  cursorSdkDisableSessionResume: true,
  cursorSdkSessionMode: "stateless",
  cursorSdkToolHoldTtlMs: 900_000,
  cursorSdkSessionIdleTtlMs: 3_600_000,
  cursorSdkMaxLiveSessions: 256,
  cursorSdkUseHttp1ForAgent: false,
  cursorAllowBuiltinTools: false,
  maxKeyAttempts: 10,
  maxTransientAttempts: 3,
  autoDisableKeys: true,
  autoDisableThreshold: 2,
  routingStrategy: "fill-first",
  sessionAffinity: false,
  sessionAffinityTtlMs: 60 * 60 * 1000,
  systemPromptMode: "off",
  cursorPrewarm: false
};

/** 与 server.test.ts 的 FakeRunner 同款：可控延迟吐流、感知 abort、可回写遥测。 */
class FakeRunner implements CursorRunner {
  constructor(private readonly output: Partial<CursorRunResult> & {
    chunks?: string[];
    /** 每个文本事件之间的延迟：给客户端留出「中途断连」的窗口。 */
    chunkDelayMs?: number;
    /** 首个事件前的挂起时长：模拟上游长时间无输出（空闲超时路径）。abort 时提前结束，不留悬挂计时器。 */
    hangMs?: number;
  } = {}) {}

  abortSignal?: AbortSignal;

  async run(): Promise<CursorRunResult> {
    return { text: this.output.text ?? "ok", toolCalls: [] };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    this.abortSignal = signal;
    if (input.telemetryRef) {
      input.telemetryRef.agentId = "agent-http-test";
      input.telemetryRef.runId = "run-http-test";
    }
    if (signal?.aborted) {
      // 与真实 runner 一致：拿到已 abort 的 signal 直接抛 499。
      throw new ApiError("Request was aborted.", 499, "request_aborted");
    }
    if (this.output.hangMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.output.hangMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    const chunks = this.output.chunks ?? ["hello ", "world"];
    let text = "";
    for (const chunk of chunks) {
      if (this.output.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, this.output.chunkDelayMs));
      text += chunk;
      yield { type: "text", text: chunk };
    }
    yield {
      type: "done",
      result: { text, toolCalls: [], agentId: "agent-http-test", runId: "run-http-test" }
    };
  }
}

interface Harness {
  app: FastifyInstance;
  port: number;
  store: MemoryStateStore;
  runner: FakeRunner;
}

/** 建真实 server：app.listen(0)，t.after 里关干净。configOverrides 用来按用例调小 requestTimeoutMs 等。 */
async function createHttpApp(
  t: TestContext,
  runnerOptions: ConstructorParameters<typeof FakeRunner>[0] = {},
  configOverrides: Partial<GatewayConfig> = {}
): Promise<Harness> {
  const store = new MemoryStateStore();
  const runner = new FakeRunner(runnerOptions);
  const keyPool = new CursorKeyPool(store, undefined, { strategy: "fill-first" });
  await keyPool.seedFromEnv(["server-cursor-key"]);
  const app = createApp({
    config: { ...baseConfig, ...configOverrides },
    store,
    runner: new KeyRotatingRunner(runner, keyPool),
    keyPool,
    modelLister: async () => ({
      models: [
        { id: "composer-2.5", name: "Cursor Composer 2.5", aliases: ["composer-latest", "composer"] },
        { id: "claude-fable-5", name: "Fable 5", aliases: ["fable", "fable-5"] }
      ],
      source: "cursor"
    })
  });
  const port = await new Promise<number>((resolve) => {
    void app.listen({ port: 0, host: "127.0.0.1" }, () => {
      resolve((app.server.address() as { port: number }).port);
    });
  });
  t.after(async () => {
    await app.close();
  });
  return { app, port, store, runner };
}

interface SseFrame {
  event?: string;
  data?: unknown;
}

/** SSE 响应体拆帧，只认 event: 名与 data: JSON（[DONE] 保留 raw 形态）。 */
function sseFrames(body: string): SseFrame[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => ({
      event: /^event: (.+)$/m.exec(frame)?.[1],
      data: /^data: (.+)$/m.test(frame) ? safeJson(/^data: (.+)$/m.exec(frame)?.[1]) : undefined
    }));
}

function safeJson(raw: string | undefined): unknown {
  if (!raw || raw === "[DONE]") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 收完一条流式 POST：断言中途没断（否则读端会炸）。 */
async function readFullStream(port: number, body: unknown): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": "gateway-key",
          "anthropic-version": "2023-06-01"
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`unexpected status ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * 发一条流式 POST，收到首个 data 后立刻 destroy 客户端连接（真实中途断连）。
 * 返回连接被销毁前实际收到的字节数，断言用。
 */
async function postAndDestroyMidStream(port: number, body: unknown): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let seen = 0;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": "gateway-key",
          "anthropic-version": "2023-06-01"
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`unexpected status ${res.statusCode}`));
          return;
        }
        let resolved = false;
        // 握手（message_start）一出门就拔线：此刻 runner 还在慢慢吐，连接层真实断开。
        res.on("data", (chunk: Buffer) => {
          seen += chunk.length;
          if (!resolved) {
            resolved = true;
            req.destroy();
            resolve(seen);
          }
        });
        res.on("error", () => undefined);
      }
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      // 拔线后 socket 层报 ECONNRESET / EPIPE 属预期；其余错误照常炸。
      // destroy 发生在收到首个 data 之前时也不能把 promise 挂死。
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE" && seen === 0) reject(error);
    });
    req.end(JSON.stringify(body));
  });
}

/** finishLog 是 fire-and-forget，多打一发健康检查等落库链跑完，再读日志。 */
async function waitForLogs(port: number, predicate: (log: RequestLogRecord) => boolean, tries = 40): Promise<RequestLogRecord[]> {
  for (let i = 0; i < tries; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const logs = await fetchLogs(port);
    const matched = logs.filter(predicate);
    // 落库链（含 abort 后 finishLog 的微任务）需要几轮事件循环；等满条件或重试耗尽。
    if (matched.length) return matched;
  }
  return (await fetchLogs(port)).filter(predicate);
}

async function fetchLogs(port: number): Promise<RequestLogRecord[]> {
  const response = await fetch(`http://127.0.0.1:${port}/admin/api/logs?limit=50`, {
    headers: { authorization: "Bearer gateway-key" }
  });
  assert.equal(response.status, 200);
  const page = (await response.json()) as { logs: RequestLogRecord[] };
  return page.logs;
}

const STREAM_BODY = {
  model: "composer-2.5",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "Hello" }]
};

test("真实 HTTP：客户端不断连的流式请求不产生 499（判据收紧）", { timeout: 15_000 }, async (t) => {
  // chunk 间延迟让「请求体已读完、runner 还在吐」的窗口真实存在：
  // 旧判据 request.raw.destroyed 在 body 读完后即为 true，会在这条路径上 0ms 误杀。
  const { port } = await createHttpApp(t, { chunks: ["hello ", "brave ", "world"], chunkDelayMs: 60 });

  const body = await readFullStream(port, STREAM_BODY);
  // 流必须完整走完：message_start → … → message_stop，说明 runner 没被误杀。
  const events = sseFrames(body).map((frame) => frame.event);
  assert.equal(events.at(-1), "message_stop", `流应正常收尾，实际事件序列：${events.join(" > ")}`);

  const logs = await waitForLogs(port, (log) => log.endpoint === "/v1/messages");
  assert.equal(logs.length, 1, "应只有一条请求日志");
  assert.equal(logs[0].status, 200, "正常流式请求不得记 499");
  assert.equal(logs[0].abortReason, undefined, "未被 abort 的请求不落归因");
});

test("真实 HTTP：中途 destroy 的流式请求记 499 且 abortReason=client_disconnect", { timeout: 15_000 }, async (t) => {
  // 吐流放慢，保证客户端拔线时 runner 还在产出（真正的「中途断连」而不是收尾后断）。
  const { port } = await createHttpApp(t, { chunks: ["hello ", "brave ", "world"], chunkDelayMs: 80 });

  const seen = await postAndDestroyMidStream(port, STREAM_BODY);
  assert.ok(seen > 0, "拔线前必须已收到响应字节（SSE 已提交）");

  // socket close 触发 streamAbort 的 onClose → abort → runner 499 → finishLog(499)。
  const logs = await waitForLogs(port, (log) => log.endpoint === "/v1/messages" && log.status === 499);
  assert.equal(logs.length, 1, "真断连必须记一条 499");
  assert.equal(logs[0].abortReason, "client_disconnect", "归因必须是 client_disconnect");
  assert.equal(logs[0].stream, true);
  // socket 已销毁：reportStreamError 不再往客户端写流内 error 事件，但日志侧语义不受影响。
  assert.ok(logs[0].error, "499 行应带错误文案");
});

test("真实 HTTP：空闲超时给客户端发 504 规范 error 事件并记 abortReason=idle_timeout", { timeout: 15_000 }, async (t) => {
  // 挂起不产出的 runner + 300ms 空闲超时：客户端必须收到流内 timeout_error 事件（而不是裸 EOF / 永久悬挂）。
  // requestTimeoutMs 走顶层 config（FakeRunner 路由到 sdk，无 per-provider 覆盖）。
  const { port } = await createHttpApp(t, { hangMs: 10_000 }, { requestTimeoutMs: 300 });

  const body = await readFullStream(port, STREAM_BODY);
  const frames = sseFrames(body);
  const events = frames.map((frame) => frame.event);
  assert.ok(events.includes("message_start"), "SSE 应已提交（200 + message_start）");
  const errorFrame = frames.find((frame) => frame.event === "error");
  assert.ok(errorFrame, `必须收到流内 error 事件，实际事件序列：${events.join(" > ")}`);
  const payload = errorFrame?.data as { type?: string; error?: { type?: string; message?: string } };
  assert.equal(payload.type, "error");
  assert.equal(payload.error?.type, "timeout_error", "空闲超时对外必须是 504 / timeout_error 语义");
  assert.ok(payload.error?.message?.includes("no output"), "错误文案应指向空闲超时");
  assert.ok(!events.includes("message_stop"), "失败流不得补 message_stop（否则客户端会当成功收尾）");

  // reportStreamError 按 abort reason 还原成 504 落日志，归因是 idle_timeout 而不是 client_disconnect。
  const logs = await waitForLogs(port, (log) => log.endpoint === "/v1/messages" && log.status === 504);
  assert.equal(logs.length, 1, "空闲超时必须记一条 504");
  assert.equal(logs[0].abortReason, "idle_timeout", "归因必须是 idle_timeout");
});

// ---------------------------------------------------------------------------
// 判定纯函数的单测（reportStreamError 的两个判定抽了出来）
// ---------------------------------------------------------------------------

const ABORT_499 = new ApiError("Request was aborted.", 499, "request_aborted");

test("shouldSuppressStreamError：socket 存活时不抑制（必须发 error 事件，不能裸 EOF）", () => {
  const controller = new AbortController();
  controller.abort();
  // 包 C 的核心场景：0ms 误杀被 abort 但客户端还连着——必须发 error 事件。
  assert.equal(shouldSuppressStreamError(ABORT_499, controller.signal, () => true), false);
});

test("shouldSuppressStreamError：socket 销毁时抑制；无探针时维持旧行为", () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(shouldSuppressStreamError(ABORT_499, controller.signal, () => false), true, "socket 已销毁没人收流");
  // 探针缺失（inject 测试 / 非流式路径）：按 abort 语义跳过，维持旧行为。
  assert.equal(shouldSuppressStreamError(ABORT_499, controller.signal, undefined), true);
});

test("shouldSuppressStreamError：非 499 或未 abort 一律不抑制", () => {
  const controller = new AbortController();
  // 非 499：上游 5xx 等，客户端必须收到 error 事件，与 socket 状态无关。
  assert.equal(shouldSuppressStreamError(new ApiError("upstream exploded", 502, "upstream_run_failed"), controller.signal, () => false), false);
  // 499 但 signal 未 abort（罕见但语义上必须守住）：不抑制。
  assert.equal(shouldSuppressStreamError(ABORT_499, undefined, () => false), false);
  controller.abort();
  // 499 但错误实际是空闲超时（504 reason 还原后）：客户端还连着必须收 504 事件。
  const timeout = new ApiError("Upstream produced no output for 90000ms.", 504, "timeout_error");
  assert.equal(shouldSuppressStreamError(timeout, controller.signal, () => true), false);
});

test("resolveStreamError：空闲超时的 abort reason 还原成 504，其余按原错误", () => {
  const controller = new AbortController();
  controller.abort(new ApiError("Upstream produced no output for 90000ms.", 504, "timeout_error"));
  const resolved = resolveStreamError(ABORT_499, ABORT_499, controller.signal);
  assert.equal(resolved.statusCode, 504);
  assert.equal(resolved.code, "timeout_error");

  // 纯断连没有 reason：按原 499 表达。
  const plain = new AbortController();
  plain.abort();
  assert.equal(resolveStreamError(ABORT_499, ABORT_499, plain.signal), ABORT_499);
  // 非 abort 错误原样返回。
  const upstream = new ApiError("upstream exploded", 502, "upstream_run_failed");
  assert.equal(resolveStreamError(upstream, upstream, undefined), upstream);
});
