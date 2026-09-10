import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { CursorRunRequest, GatewayConfig } from "../src/types.js";
import {
  BoxRelayConnectionManager,
  ensureBoxConnection,
  relayExtraHeaders,
  relayInferenceBaseUrl,
  type BoxRelayConnection
} from "../src/cursor-bot/box-relay.js";
import { listBoxAgents, probeRelay } from "../src/cursor-bot/relay-provision.js";
import { encodeEnvelope } from "../src/cursor-bot/envelope.js";
import { CursorBotService, botSettings } from "../src/cursor-bot/service.js";
import { CursorBotStore } from "../src/cursor-bot/store.js";
import {
  EnsureSandBoxResponse,
  SandBoxRunState
} from "../src/cursor-bot/proto/grokbot_service_pb.js";
import {
  InferenceStreamResponse,
  InferenceTextStreamPart
} from "../src/cursor-bot/proto/inference_pb.js";

/* ---------------------------------------------------------------- 测试脚手架 */

const CREDENTIAL = { id: "c", sessionToken: "jwt-session", machineId: "m", clientVersion: "0.44.0" };

function boxResponse(overrides: Partial<EnsureSandBoxResponse> = {}): Uint8Array {
  return new EnsureSandBoxResponse({
    cluster: "us10",
    gatewayUrl: "https://box-gateway.test/pod-1",
    gatewayToken: "box-token-1",
    networkToken: "nto-token-1",
    runState: SandBoxRunState.RUNNING,
    ...overrides
  }).toBinary();
}

function inferenceFrames(text: string): Uint8Array[] {
  return [
    encodeEnvelope(
      new InferenceStreamResponse({
        response: { case: "textPart", value: new InferenceTextStreamPart({ text }) }
      }).toBinary()
    ),
    encodeEnvelope(new TextEncoder().encode("{}"), { endStream: true })
  ];
}

function streamResponse(frames: Uint8Array[]): Response {
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

/** 按请求顺序应答的 mock fetch；每个元素是 [匹配谓词, 响应工厂]。 */
function scriptedFetch(script: Array<{ match: (url: string) => boolean; respond: (url: string, init: RequestInit) => Response }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const step = script[calls.length - 1] ?? script[script.length - 1];
    const entry = step && (step.match(url) ? step : script.find((candidate) => candidate.match(url)));
    if (!entry) throw new Error(`unexpected url ${url}`);
    return entry.respond(url, init);
  };
  return { calls, fetchImpl };
}

const ensureStep = (body = boxResponse()) => ({
  match: (url: string) => url.endsWith("/aiserver.v1.GrokBotService/EnsureSandBox"),
  respond: () => new Response(body, { status: 200 })
});

const inferenceStep = (text = "ok", check?: (url: string, init: RequestInit) => void) => ({
  match: (url: string) => url.includes("/sand-stream-relay/aiserver.v1.InferenceService/Stream"),
  respond: (url: string, init: RequestInit) => {
    check?.(url, init);
    return streamResponse(inferenceFrames(text));
  }
});

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({}), sqlitePath: ":memory:", ...overrides };
}

function runRequest(overrides: Partial<CursorRunRequest> = {}): CursorRunRequest {
  return {
    protocol: "openai-chat",
    apiKey: "unused",
    useKeyPool: false,
    model: "grok-4.6",
    prompt: "hello",
    sessionKey: "owner",
    images: [],
    tools: [],
    ...overrides
  } as CursorRunRequest;
}

/* ---------------------------------------------------------------- box-relay 单元 */

test("ensureBoxConnection posts an empty unary request to api2 and reads the connection", async () => {
  const { calls, fetchImpl } = scriptedFetch([ensureStep()]);
  const connection = await ensureBoxConnection(CREDENTIAL, { baseUrl: "https://api2.test", fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api2.test/aiserver.v1.GrokBotService/EnsureSandBox");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/proto", "一元调用用裸 proto");
  assert.equal(headers.authorization, "Bearer jwt-session", "EnsureSandBox 用 session JWT");
  assert.equal((calls[0].init.body as Uint8Array).length, 0, "空请求体：与桌面端 ensureSandBox({}) 一致");

  assert.equal(connection.gatewayUrl, "https://box-gateway.test/pod-1");
  assert.equal(connection.gatewayToken, "box-token-1");
  assert.equal(connection.networkToken, "nto-token-1");
  assert.equal(connection.runState, SandBoxRunState.RUNNING);
  assert.equal(relayInferenceBaseUrl(connection), "https://box-gateway.test/pod-1/sand-stream-relay");
  assert.deepEqual(relayExtraHeaders(connection), { "x-anyrun-network-token": "nto-token-1" });
});

test("ensureBoxConnection rejects responses missing the connection fields", async () => {
  const broken = boxResponse({ gatewayToken: "", networkToken: "" });
  const { fetchImpl } = scriptedFetch([ensureStep(broken)]);
  await assert.rejects(
    () => ensureBoxConnection(CREDENTIAL, { fetchImpl }),
    (error: unknown) => error instanceof ApiError && /gatewayUrl|gatewayToken|networkToken/.test(error.message)
  );
});

test("the connection manager caches, single-flights, and refreshes on invalidate", async () => {
  let now = 1_000;
  const manager = new BoxRelayConnectionManager(() => now);
  let fetched = 0;
  const options = {
    fetchImpl: async () => {
      fetched += 1;
      return new Response(boxResponse({ gatewayToken: `token-${fetched}` }), { status: 200 });
    }
  };

  const first = await manager.get(CREDENTIAL, options);
  assert.equal(fetched, 1);
  const cached = await manager.get(CREDENTIAL, options);
  assert.equal(fetched, 1, "命中缓存不回源");
  assert.equal(cached.gatewayToken, "token-1");

  // 单飞：并发两个 get 只回源一次。
  const [a, b] = await Promise.all([manager.get(CREDENTIAL, options), manager.get(CREDENTIAL, options)]);
  assert.equal(fetched, 1);
  assert.equal(a.gatewayToken, b.gatewayToken);

  manager.invalidate(CREDENTIAL.id);
  const refreshed = await manager.get(CREDENTIAL, options);
  assert.equal(fetched, 2, "失效后重取");
  assert.equal(refreshed.gatewayToken, "token-2");
});

test("the connection manager cools down after a failed ensure", async () => {
  let now = 1_000;
  const manager = new BoxRelayConnectionManager(() => now);
  let fetched = 0;
  const options = {
    fetchImpl: async () => {
      fetched += 1;
      if (fetched === 1) return new Response("unauthorized", { status: 401 });
      return new Response(boxResponse(), { status: 200 });
    }
  };

  await assert.rejects(() => manager.get(CREDENTIAL, options));
  await assert.rejects(
    () => manager.get(CREDENTIAL, options),
    (error: unknown) => error instanceof ApiError && /冷却/.test(error.message),
    "冷却期内不回源直接拒绝"
  );
  assert.equal(fetched, 1);

  now += 61_000;
  const recovered = await manager.get(CREDENTIAL, options);
  assert.equal(fetched, 2, "冷却过了要能重试");
  assert.equal(recovered.gatewayToken, "box-token-1");
});

/* --------------------------------------------------------- service 推理选路 */

test("relay mode routes inference through the box relay with swapped credentials", async () => {
  const store = CursorBotStore.open(":memory:");
  store.upsertCredential({ sessionToken: "jwt-session", machineId: "m", clientVersion: "0.44.0" });

  let inferenceHeaders: Record<string, string> = {};
  const { calls, fetchImpl } = scriptedFetch([
    ensureStep(),
    inferenceStep("relay ok", (_url, init) => {
      inferenceHeaders = init.headers as Record<string, string>;
    })
  ]);
  const service = new CursorBotService({
    store,
    config: baseConfig({ botInferenceRoute: "relay" }),
    fetchImpl
  });

  const events = [];
  for await (const event of service.stream(runRequest())) events.push(event);
  assert.deepEqual(events, [
    { type: "text", text: "relay ok" },
    { type: "done", result: { text: "relay ok", toolCalls: [] } }
  ]);

  assert.equal(calls.length, 2, "EnsureSandBox 一次 + 推理一次");
  assert.match(calls[1].url, /^https:\/\/box-gateway\.test\/pod-1\/sand-stream-relay\/aiserver\.v1\.InferenceService\/Stream$/);
  assert.equal(inferenceHeaders.authorization, "Bearer box-token-1", "推理鉴权换成 Box gateway token");
  assert.equal(inferenceHeaders["x-anyrun-network-token"], "nto-token-1", "路由头必须带上");

  // 同一凭据的下一个请求：连接命中缓存，只有推理出站。
  calls.length = 0;
  for await (const event of service.stream(runRequest())) void event;
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sand-stream-relay/);
  store.close();
});

test("relay mode retries once with a fresh connection after a 401", async () => {
  const store = CursorBotStore.open(":memory:");
  store.upsertCredential({ sessionToken: "jwt-session", machineId: "m", clientVersion: "0.44.0" });

  const { calls, fetchImpl } = scriptedFetch([
    ensureStep(boxResponse({ gatewayToken: "stale" })),
    { match: (url) => url.includes("sand-stream-relay"), respond: () => new Response("stale token", { status: 401 }) },
    ensureStep(boxResponse({ gatewayToken: "fresh", networkToken: "nto-fresh" })),
    inferenceStep("second try")
  ]);
  const service = new CursorBotService({
    store,
    config: baseConfig({ botInferenceRoute: "relay" }),
    fetchImpl
  });

  const events = [];
  for await (const event of service.stream(runRequest())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text", "done"]);
  assert.equal(calls.length, 4, "ensure → 401 → 重取 → 重试");
  const retryHeaders = calls[3].init.headers as Record<string, string>;
  assert.equal(retryHeaders.authorization, "Bearer fresh");
  assert.equal(retryHeaders["x-anyrun-network-token"], "nto-fresh");
  store.close();
});

test("a 404 from the relay surfaces an actionable provisioning hint, not a retry", async () => {
  const store = CursorBotStore.open(":memory:");
  store.upsertCredential({ sessionToken: "jwt-session", machineId: "m", clientVersion: "0.44.0" });

  const { calls, fetchImpl } = scriptedFetch([
    ensureStep(),
    { match: (url) => url.includes("sand-stream-relay"), respond: () => new Response("no route", { status: 404 }) }
  ]);
  const service = new CursorBotService({
    store,
    config: baseConfig({ botInferenceRoute: "relay" }),
    fetchImpl
  });

  await assert.rejects(
    () => service.run(runRequest()),
    (error: unknown) => error instanceof ApiError && /relay 未装配/.test(error.message)
  );
  assert.equal(calls.length, 2, "404 不重试");
  store.close();
});

test("direct mode keeps the legacy api2 inference url and never calls EnsureSandBox", async () => {
  const store = CursorBotStore.open(":memory:");
  store.upsertCredential({ sessionToken: "jwt-session", machineId: "m", clientVersion: "0.44.0" });

  let seenUrl = "";
  const { fetchImpl } = scriptedFetch([
    {
      match: () => true,
      respond: (url) => {
        seenUrl = url;
        return streamResponse(inferenceFrames("direct ok"));
      }
    }
  ]);
  const service = new CursorBotService({ store, config: baseConfig(), fetchImpl });
  const result = await service.run(runRequest());
  assert.equal(result.text, "direct ok");
  assert.match(seenUrl, /aiserver\.v1\.InferenceService\/Stream$/);
  assert.ok(!seenUrl.includes("sand-stream-relay"));
  store.close();
});

test("botSettings resolves the inference route through overrides then env", () => {
  assert.equal(botSettings(loadConfig({})).inferenceRoute, "direct", "默认保守：直连");
  assert.equal(botSettings(baseConfig({ botInferenceRoute: "relay" })).inferenceRoute, "relay");
  assert.equal(
    botSettings(baseConfig({ botOverrides: { inferenceRoute: "direct" }, botInferenceRoute: "relay" })).inferenceRoute,
    "direct",
    "后台覆盖优先于 env"
  );
});

/* ---------------------------------------------------------------- relay 探测与名册 */

const CONNECTION: BoxRelayConnection = {
  gatewayUrl: "https://box-gateway.test/pod-1",
  gatewayToken: "box-token-1",
  networkToken: "nto-token-1",
  runState: SandBoxRunState.RUNNING,
  fetchedAt: 0
};

function probeResponse(status: number, contentType: string, body: string | Uint8Array = ""): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

test("probeRelay distinguishes ok / missing / auth-expired / non-connect 200", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = [];
  const recorder = (respond: () => Response) => async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return respond();
  };

  const ok = await probeRelay(CONNECTION, { fetchImpl: recorder(() => probeResponse(200, "application/connect+proto")) });
  assert.deepEqual(ok, { status: "ok" });
  assert.equal(seen[0].url, "https://box-gateway.test/pod-1/sand-stream-relay/aiserver.v1.InferenceService/Stream");
  assert.equal(seen[0].headers["content-type"], "application/connect+proto");
  assert.equal(seen[0].headers.authorization, "Bearer box-token-1");
  assert.equal(seen[0].headers["x-anyrun-network-token"], "nto-token-1");
  assert.equal(seen[0].body.length, 5, "空 envelope 探测帧");

  const missing = await probeRelay(CONNECTION, { fetchImpl: recorder(() => probeResponse(404, "application/json")) });
  assert.equal(missing.status, "missing");

  const auth = await probeRelay(CONNECTION, { fetchImpl: recorder(() => probeResponse(401, "application/json")) });
  assert.equal(auth.status, "auth-expired");

  // 网关可能对未知路径回一个无关的 200 页面：不算已装配（v1.35 同款判据）。
  const fake200 = await probeRelay(CONNECTION, { fetchImpl: recorder(() => probeResponse(200, "text/html", "<html>")) });
  assert.equal(fake200.status, "missing");

  const unreachable = await probeRelay(CONNECTION, {
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    }
  });
  assert.equal(unreachable.status, "unreachable");
});

test("listBoxAgents posts to the gateway REST api and maps agent rows", async () => {
  const seen: string[] = [];
  const agents = await listBoxAgents(CONNECTION, {
    fetchImpl: async (url, init): Promise<Response> => {
      seen.push(url);
      return Response.json([
        { id: "a1", name: "New Bot", isActive: true, updatedAt: 20 },
        { id: "a2", name: "", isActive: false, updatedAt: 10 },
        { no: "id" }
      ]);
    }
  });
  assert.deepEqual(seen, ["https://box-gateway.test/pod-1/api/listAgents"]);
  assert.deepEqual(agents, [
    { id: "a1", name: "New Bot", isActive: true, updatedAt: 20 },
    { id: "a2", name: "（未命名 Bot）", isActive: false, updatedAt: 10 }
  ], "缺 id 的行丢弃，缺名的兜底");
});
