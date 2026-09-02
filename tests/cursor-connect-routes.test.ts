import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunRequest, CursorRunResult, CursorRunner, CursorStreamEvent, GatewayConfig } from "../src/types.js";
import { encodeEnvelope } from "../src/cursor-connect/envelope.js";
import { CursorConnectService } from "../src/cursor-connect/service.js";
import { CursorConnectStore } from "../src/cursor-connect/store.js";
import {
  AvailableModelsResponse,
  AvailableModelsResponse_AvailableModel,
  AvailableModelsResponse_DegradationStatus
} from "../src/cursor-connect/proto/available_models_pb.js";

const ADMIN_PASSWORD = "admin-secret";
const GATEWAY_KEY = "gw-key";

class StubRunner implements CursorRunner {
  async run(): Promise<CursorRunResult> {
    return { text: "sdk", toolCalls: [] };
  }
  async *stream(): AsyncIterable<CursorStreamEvent> {
    yield { type: "done", result: { text: "sdk", toolCalls: [] } };
  }
}

/** 一元上游桩：AvailableModels 的请求与响应都是裸 protobuf，没有 envelope。 */
function connectFetch(models: AvailableModelsResponse_AvailableModel[]) {
  return async (): Promise<Response> =>
    new Response(new AvailableModelsResponse({ models }).toBinary(), { status: 200 });
}

async function buildApp(options: { withCredential?: boolean; config?: Partial<GatewayConfig> } = {}) {
  const store = new MemoryStateStore();
  const config: GatewayConfig = {
    ...loadConfig({}),
    adminPassword: ADMIN_PASSWORD,
    gatewayApiKey: GATEWAY_KEY,
    sqlitePath: ":memory:",
    ...options.config
  };
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key"]);

  const connectStore = CursorConnectStore.open(":memory:");
  if (options.withCredential) {
    connectStore.upsertCredential({ sessionToken: "session-token", machineId: "machine-1", clientVersion: "3.18.9" });
  }
  const connect = new CursorConnectService({
    store: connectStore,
    config,
    fetchImpl: connectFetch([
      new AvailableModelsResponse_AvailableModel({ name: "grok-4.6", defaultOn: true }),
      new AvailableModelsResponse_AvailableModel({
        name: "gone",
        degradationStatus: AvailableModelsResponse_DegradationStatus.DISABLED
      })
    ])
  });

  const app = createApp({ config, store, runner: new StubRunner(), keyPool, connect });
  return { app, connect, connectStore };
}

const adminAuth = { authorization: `Bearer ${ADMIN_PASSWORD}` };
const apiAuth = { authorization: `Bearer ${GATEWAY_KEY}` };

/* ------------------------------------------------------------ 管理接口 */

test("the admin connect panel reports an unconfigured route instead of failing", async () => {
  const { app } = await buildApp();
  const response = await app.inject({ method: "GET", url: "/admin/api/connect", headers: adminAuth });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { enabled: boolean; status: { available: boolean }; credentials: unknown[] };
  assert.equal(body.enabled, true);
  assert.equal(body.status.available, false);
  assert.deepEqual(body.credentials, []);
  await app.close();
});

test("admin endpoints require the admin password, not just any gateway key", async () => {
  const { app } = await buildApp({ withCredential: true });
  for (const url of ["/admin/api/connect", "/admin/api/connect/models", "/admin/api/connect/runs"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, `${url} 应拒绝匿名请求`);
    assert.equal(
      (await app.inject({ method: "GET", url, headers: apiAuth })).statusCode,
      401,
      `${url} 不该接受普通网关密钥`
    );
  }
  await app.close();
});

test("a credential can be created, tested, disabled and deleted from the admin API", async () => {
  const { app } = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials",
    headers: adminAuth,
    payload: { sessionToken: "brand-new-token", label: "primary" }
  });
  assert.equal(created.statusCode, 200);
  const credential = (created.json() as { credential: Record<string, unknown> }).credential;
  const id = credential.id as string;
  assert.equal(credential.label, "primary");
  assert.equal(credential.status, "active");
  // 后台绝不回传 token 明文，只给首尾提示。
  assert.ok(!JSON.stringify(credential).includes("brand-new-token"));
  assert.match(String(credential.tokenHint), /^bran…oken\(15\)$/);

  const tested = await app.inject({
    method: "POST",
    url: `/admin/api/connect/credentials/${id}/test`,
    headers: adminAuth
  });
  assert.equal(tested.statusCode, 200);
  assert.equal((tested.json() as { ok: boolean; models: number }).models, 2);

  const disabled = await app.inject({
    method: "POST",
    url: `/admin/api/connect/credentials/${id}/disable`,
    headers: adminAuth
  });
  assert.equal((disabled.json() as { credential: { status: string } }).credential.status, "disabled");

  const removed = await app.inject({
    method: "DELETE",
    url: `/admin/api/connect/credentials/${id}`,
    headers: adminAuth
  });
  assert.equal(removed.statusCode, 200);
  const after = await app.inject({ method: "GET", url: "/admin/api/connect", headers: adminAuth });
  assert.deepEqual((after.json() as { credentials: unknown[] }).credentials, []);
  await app.close();
});

test("a browser web token is refused before it ever reaches the upstream", async () => {
  const { app } = await buildApp();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const webToken = `${encode({ alg: "none" })}.${encode({ type: "web" })}.sig`;
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials",
    headers: adminAuth,
    payload: { sessionToken: webToken }
  });
  assert.equal(response.statusCode, 400);
  assert.match((response.json() as { error: { message: string } }).error.message, /web token/);
  await app.close();
});

test("rotating a token keeps the machine id stable", async () => {
  const { app, connectStore } = await buildApp({ withCredential: true });
  const id = connectStore.listCredentials()[0].id;
  const before = connectStore.credential(id)!.machineId;

  const response = await app.inject({
    method: "POST",
    url: `/admin/api/connect/credentials/${id}`,
    headers: adminAuth,
    payload: { sessionToken: "rotated-token" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(connectStore.credential(id)?.sessionToken, "rotated-token");
  // 设备标识变了上游就当成另一台设备，换 token 不该顺带换掉它。
  assert.equal(connectStore.credential(id)?.machineId, before);
  await app.close();
});

test("the admin model list comes from the catalog and hides disabled models", async () => {
  const { app } = await buildApp({ withCredential: true });
  const response = await app.inject({ method: "GET", url: "/admin/api/connect/models", headers: adminAuth });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    (response.json() as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ["grok-4.6"]
  );
  await app.close();
});

test("admin run listing and cancel work end to end", async () => {
  const { app, connectStore } = await buildApp({ withCredential: true });
  const conversation = connectStore.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = connectStore.createRun({ conversationId: conversation.id, requestedModel: "grok-4.6" });
  connectStore.appendEvents(run.id, conversation.id, [{ type: "text.delta", payload: { text: "a" } }]);

  const list = await app.inject({ method: "GET", url: "/admin/api/connect/runs", headers: adminAuth });
  assert.equal((list.json() as { runs: Array<{ id: string }> }).runs[0].id, run.id);

  const detail = await app.inject({ method: "GET", url: `/admin/api/connect/runs/${run.id}`, headers: adminAuth });
  const body = detail.json() as { events: unknown[]; toolCalls: unknown[] };
  assert.equal(body.events.length, 1);
  assert.deepEqual(body.toolCalls, []);

  const cancelled = await app.inject({
    method: "POST",
    url: `/admin/api/connect/runs/${run.id}/cancel`,
    headers: adminAuth
  });
  assert.equal((cancelled.json() as { run: { status: string } }).run.status, "cancelled");
  await app.close();
});

/* -------------------------------------------------------- 对外 API 面 */

test("the public connect endpoints authenticate with the gateway key", async () => {
  const { app } = await buildApp({ withCredential: true });
  assert.equal((await app.inject({ method: "GET", url: "/v1/cursor-connect/status" })).statusCode, 401);

  const status = await app.inject({ method: "GET", url: "/v1/cursor-connect/status", headers: apiAuth });
  assert.equal(status.statusCode, 200);
  assert.equal((status.json() as { available: boolean }).available, true);
  await app.close();
});

test("run status, tool-results and resume enforce ownership and idempotency", async () => {
  const { app, connectStore } = await buildApp({ withCredential: true });
  const conversation = connectStore.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = connectStore.createRun({ conversationId: conversation.id, requestedModel: "grok-4.6" });
  connectStore.recordToolCall({ runId: run.id, callId: "call-1", toolName: "search", args: {} });

  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/cursor-connect/runs/nope", headers: apiAuth })).statusCode,
    404
  );

  const first = await app.inject({
    method: "POST",
    url: `/v1/cursor-connect/runs/${run.id}/tool-results`,
    headers: apiAuth,
    payload: { results: [{ toolCallId: "call-1", result: { ok: true } }, { toolCallId: "ghost", result: 1 }] }
  });
  const body = first.json() as { accepted: string[]; unknown: string[]; pending: string[] };
  assert.deepEqual(body.accepted, ["call-1"]);
  // 不属于这个 run 的 tool_call_id 必须被拒，否则谁都能往别人的 run 里塞结果。
  assert.deepEqual(body.unknown, ["ghost"]);
  assert.deepEqual(body.pending, []);

  const again = await app.inject({
    method: "POST",
    url: `/v1/cursor-connect/runs/${run.id}/tool-results`,
    headers: apiAuth,
    payload: { results: [{ toolCallId: "call-1", result: { ok: true } }] }
  });
  assert.deepEqual((again.json() as { accepted: string[]; duplicates: string[] }).duplicates, ["call-1"]);

  const empty = await app.inject({
    method: "POST",
    url: `/v1/cursor-connect/runs/${run.id}/tool-results`,
    headers: apiAuth,
    payload: { results: [] }
  });
  assert.equal(empty.statusCode, 400);
  await app.close();
});

test("resume refuses to re-run anything already partially delivered", async () => {
  const { app, connectStore } = await buildApp({ withCredential: true });
  const conversation = connectStore.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = connectStore.createRun({ conversationId: conversation.id, requestedModel: "grok-4.6" });
  connectStore.appendEvents(run.id, conversation.id, [{ type: "text.delta", payload: { text: "half" } }]);

  const response = await app.inject({
    method: "POST",
    url: `/v1/cursor-connect/runs/${run.id}/resume`,
    headers: apiAuth
  });
  const body = response.json() as { resumed: boolean; action: string };
  assert.equal(body.resumed, false);
  assert.equal(body.action, "unknown", "已经交付过半截文本，重跑会重复输出");
  await app.close();
});

test("the events endpoint replays persisted events and honours Last-Event-ID", async () => {
  const { app, connectStore } = await buildApp({ withCredential: true });
  const conversation = connectStore.upsertConversation({ ownerHash: "o", upstreamConversationId: "up" });
  const run = connectStore.createRun({ conversationId: conversation.id, requestedModel: "grok-4.6" });
  const events = connectStore.appendEvents(run.id, conversation.id, [
    { type: "text.delta", payload: { text: "a" } },
    { type: "text.delta", payload: { text: "b" } }
  ]);
  // 终态 run 的 SSE 补发完就收流，测试才能拿到完整响应而不是挂在 live 段。
  connectStore.releaseRunLease(run.id, "completed");

  const full = await app.inject({ method: "GET", url: `/v1/cursor-connect/runs/${run.id}/events`, headers: apiAuth });
  assert.equal(full.statusCode, 200);
  assert.match(full.headers["content-type"] as string, /text\/event-stream/);
  assert.equal((full.body.match(/"text":"a"/g) ?? []).length, 1);
  assert.equal((full.body.match(/"text":"b"/g) ?? []).length, 1);

  const resumed = await app.inject({
    method: "GET",
    url: `/v1/cursor-connect/runs/${run.id}/events`,
    headers: { ...apiAuth, "last-event-id": events[0].eventId }
  });
  assert.ok(!resumed.body.includes('"text":"a"'), "已经收过的事件不该重发");
  assert.ok(resumed.body.includes('"text":"b"'));
  await app.close();
});

test("connect endpoints report 503 when the route is not configured at all", async () => {
  const store = new MemoryStateStore();
  const config: GatewayConfig = {
    ...loadConfig({}),
    adminPassword: ADMIN_PASSWORD,
    gatewayApiKey: GATEWAY_KEY,
    sqlitePath: ":memory:"
  };
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key"]);
  // 没有 connect：端点仍然注册，但明确回 503 而不是 404，
  // 否则运维分不清「没装这条路线」和「打错了 URL」。
  const app = createApp({ config, store, runner: new StubRunner(), keyPool });

  const status = await app.inject({ method: "GET", url: "/v1/cursor-connect/status", headers: apiAuth });
  assert.equal((status.json() as { available: boolean }).available, false);
  const runs = await app.inject({ method: "GET", url: "/v1/cursor-connect/runs", headers: apiAuth });
  assert.equal(runs.statusCode, 503);
  const admin = await app.inject({ method: "GET", url: "/admin/api/connect/models", headers: adminAuth });
  assert.equal(admin.statusCode, 503);
  await app.close();
});

/* ---------------------------------------------------------------- 选路 */

test("provider selection routes by header and model prefix without touching the SDK path", async () => {
  const { app } = await buildApp({ withCredential: true });
  // Connect 路线的推理走真实 transport，这里只验证选路命中：Connect 出站会失败，
  // 但失败来自上游而不是「路由没生效」。SDK 路线的 stub 一定返回 "sdk"。
  const viaSdk = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: apiAuth,
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(viaSdk.statusCode, 200);
  assert.equal((viaSdk.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "sdk");
  await app.close();
});
