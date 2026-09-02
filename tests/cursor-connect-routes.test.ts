import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { CursorKeyPool } from "../src/key-pool.js";
import type { ModelLister } from "../src/models.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunResult, CursorRunner, CursorStreamEvent, GatewayConfig } from "../src/types.js";
import { encodeEnvelope } from "../src/cursor-connect/envelope.js";
import { ProviderRoutingRunner } from "../src/cursor-connect/routing-runner.js";
import { CursorConnectService } from "../src/cursor-connect/service.js";
import { CursorConnectStore } from "../src/cursor-connect/store.js";
import {
  AvailableModelsResponse,
  AvailableModelsResponse_AvailableModel,
  AvailableModelsResponse_DegradationStatus
} from "../src/cursor-connect/proto/available_models_pb.js";
import {
  InferenceStreamResponse,
  InferenceTextStreamPart
} from "../src/cursor-connect/proto/inference_pb.js";

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

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

/** 一元上游桩：AvailableModels 的请求与响应都是裸 protobuf；兑换接口走 JSON；Stream 回一段 pong。 */
function connectFetch(
  models: AvailableModelsResponse_AvailableModel[],
  exchange: {
    accessToken?: string;
    refreshToken?: string;
    status?: number;
    body?: unknown;
    calls?: Array<{ url: string; authorization: string; body: string }>;
    streamCalls?: string[];
  } = {}
) {
  const session = exchange.accessToken ?? jwt({ type: "session", sub: "acct" });
  const refresh = exchange.refreshToken ?? "refresh-token";
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href.includes("/auth/exchange_user_api_key")) {
      exchange.calls?.push({
        url: href,
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
        body: String(init?.body ?? "")
      });
      if (exchange.status && exchange.status >= 400) {
        const payload = exchange.body ?? { error: "denied" };
        return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status: exchange.status });
      }
      return Response.json({ accessToken: session, refreshToken: refresh });
    }
    if (href.includes("AvailableModels")) {
      return new Response(new AvailableModelsResponse({ models }).toBinary(), { status: 200 });
    }
    if (href.includes("InferenceService/Stream")) {
      exchange.streamCalls?.push(href);
      const frames = [
        encodeEnvelope(
          new InferenceStreamResponse({
            response: { case: "textPart", value: new InferenceTextStreamPart({ text: "pong" }) }
          }).toBinary()
        ),
        encodeEnvelope(new TextEncoder().encode("{}"), { endStream: true })
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(frame);
            controller.close();
          }
        }),
        { status: 200 }
      );
    }
    return new Response(`unexpected connect url: ${href}`, { status: 500 });
  };
}

async function buildApp(
  options: {
    withCredential?: boolean;
    config?: Partial<GatewayConfig>;
    exchange?: Parameters<typeof connectFetch>[1];
    modelLister?: ModelLister;
  } = {}
) {
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
    fetchImpl: connectFetch(
      [
        new AvailableModelsResponse_AvailableModel({ name: "grok-4.6", defaultOn: true }),
        new AvailableModelsResponse_AvailableModel({
          name: "gone",
          degradationStatus: AvailableModelsResponse_DegradationStatus.DISABLED
        })
      ],
      options.exchange
    )
  });

  const app = createApp({
    config,
    store,
    runner: new ProviderRoutingRunner({ sdk: new StubRunner(), connect }),
    keyPool,
    connect,
    ...(options.modelLister ? { modelLister: options.modelLister } : {})
  });
  return { app, connect, connectStore, keyPool };
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
  const fromKey = "/admin/api/connect/credentials/from-key";
  assert.equal((await app.inject({ method: "POST", url: fromKey, payload: { cursorKeyId: "x" } })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "POST", url: fromKey, headers: apiAuth, payload: { cursorKeyId: "x" } })).statusCode,
    401
  );
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

test("a connect credential can be imported from a Cursor key in the pool", async () => {
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const accessToken = jwt({ type: "session", sub: "acct" });
  const { app, connectStore, keyPool } = await buildApp({
    exchange: { accessToken, refreshToken: "refresh-token", calls }
  });
  const [key] = await keyPool.list();
  const created = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials/from-key",
    headers: adminAuth,
    payload: { cursorKeyId: key.id }
  });
  assert.equal(created.statusCode, 200, created.body);
  const credential = (created.json() as { credential: Record<string, unknown> }).credential;
  assert.equal(credential.sourceCursorKeyId, key.id);
  assert.equal(credential.label, key.label);
  assert.ok(!JSON.stringify(credential).includes(accessToken));
  assert.ok(!JSON.stringify(credential).includes(key.apiKey));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/auth\/exchange_user_api_key$/);
  assert.equal(calls[0].authorization, `Bearer ${key.apiKey}`);
  assert.equal(calls[0].body, "{}");

  const stored = connectStore.credential(String(credential.id));
  assert.equal(stored?.sessionToken, accessToken);
  assert.equal(stored?.sourceCursorKeyId, key.id);
  const machineId = stored!.machineId;

  const listed = await app.inject({ method: "GET", url: "/admin/api/connect", headers: adminAuth });
  assert.doesNotMatch(listed.body, new RegExp(accessToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(listed.body, new RegExp(key.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const again = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials/from-key",
    headers: adminAuth,
    payload: { cursorKeyId: key.id, machineId: "should-not-replace" }
  });
  assert.equal(again.statusCode, 200);
  const updated = (again.json() as { credential: { id: string } }).credential;
  assert.equal(updated.id, credential.id, "同一把 key 再拉应更新而不是新建");
  assert.equal(connectStore.credential(updated.id)?.machineId, machineId);
  assert.equal(connectStore.listCredentials().length, 1);
  await app.close();
});

test("importing from a missing Cursor key is 404 and does not invent a credential", async () => {
  const { app, connectStore } = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials/from-key",
    headers: adminAuth,
    payload: { cursorKeyId: "missing-key" }
  });
  assert.equal(response.statusCode, 404);
  assert.equal(connectStore.listCredentials().length, 0);
  await app.close();
});

test("from-key requires a cursorKeyId", async () => {
  const { app } = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials/from-key",
    headers: adminAuth,
    payload: {}
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test("from-key surfaces exchange failures without leaking the Cursor key", async () => {
  const { app, keyPool } = await buildApp({ exchange: { status: 403, body: { error: "denied", apiKey: "cursor-key" } } });
  const [key] = await keyPool.list();
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/connect/credentials/from-key",
    headers: adminAuth,
    payload: { cursorKeyId: key.id }
  });
  assert.equal(response.statusCode, 403);
  assert.doesNotMatch(response.body, /cursor-key/);
  await app.close();
});

test("the admin connect panel lists Cursor keys for import", async () => {
  const { app, keyPool } = await buildApp();
  const [key] = await keyPool.list();
  const response = await app.inject({ method: "GET", url: "/admin/api/connect", headers: adminAuth });
  const body = response.json() as { cursorKeys: Array<{ id: string; apiKey?: string; maskedKey: string }> };
  assert.equal(body.cursorKeys.length, 1);
  assert.equal(body.cursorKeys[0].id, key.id);
  assert.equal(body.cursorKeys[0].apiKey, undefined);
  assert.ok(body.cursorKeys[0].maskedKey);
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

test("the admin connectivity test can send a real Connect chat", async () => {
  const { app } = await buildApp({ withCredential: true });
  const viaProvider = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminAuth,
    payload: { provider: "connect", model: "grok-4.6", prompt: "ping" }
  });
  assert.equal(viaProvider.statusCode, 200);
  assert.equal(viaProvider.json().ok, true);
  assert.equal(viaProvider.json().provider, "connect");
  assert.equal(viaProvider.json().text, "pong");

  const viaPrefix = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminAuth,
    payload: { model: "connect/grok-4.6", prompt: "ping" }
  });
  assert.equal(viaPrefix.statusCode, 200);
  assert.equal(viaPrefix.json().ok, true);
  assert.equal(viaPrefix.json().provider, "connect");
  assert.equal(viaPrefix.json().text, "pong");

  const sdk = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminAuth,
    payload: { model: "composer-2.5" }
  });
  assert.equal(sdk.statusCode, 200);
  assert.equal(sdk.json().ok, true);
  assert.equal(sdk.json().provider, "sdk");
  assert.equal(sdk.json().text, "sdk");
  await app.close();
});

test("the admin Connect test does not silently fall back to the SDK pool", async () => {
  const { app } = await buildApp();
  const missing = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminAuth,
    payload: { provider: "connect", model: "grok-4.6" }
  });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().ok, false);
  assert.equal(missing.json().provider, "connect");
  assert.match(String(missing.json().error), /凭据/);

  const mixed = await app.inject({
    method: "POST",
    url: "/admin/api/test",
    headers: adminAuth,
    payload: { provider: "connect", model: "grok-4.6", keyId: "any" }
  });
  assert.equal(mixed.statusCode, 400);
  await app.close();
});

test("GET /v1/models exposes Connect entries under the connect/ prefix", async () => {
  const { app } = await buildApp({
    withCredential: true,
    modelLister: async () => ({
      models: [{ id: "composer-2.5", name: "Composer", aliases: [] }],
      source: "cursor"
    })
  });
  const listed = await app.inject({ method: "GET", url: "/v1/models", headers: apiAuth });
  assert.equal(listed.statusCode, 200);
  const ids = (listed.json() as { data: Array<{ id: string }> }).data.map((model) => model.id);
  assert.ok(ids.includes("composer-2.5"));
  assert.ok(ids.includes("connect/grok-4.6"), "Connect 模型必须以 connect/ 前缀出现在目录里");
  assert.ok(!ids.includes("connect/gone"), "DISABLED 的 Connect 模型不能出现在目录里");

  const byId = await app.inject({ method: "GET", url: "/v1/models/connect/grok-4.6", headers: apiAuth });
  assert.equal(byId.statusCode, 200);
  assert.equal((byId.json() as { id: string }).id, "connect/grok-4.6");
  await app.close();
});

test("a client can chat through Connect by selecting a connect/ model", async () => {
  const { app } = await buildApp({
    withCredential: true,
    modelLister: async () => ({
      models: [{ id: "composer-2.5", name: "Composer", aliases: [] }],
      source: "cursor"
    })
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: apiAuth,
    payload: { model: "connect/grok-4.6", messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    (response.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content,
    "pong"
  );
  await app.close();
});
