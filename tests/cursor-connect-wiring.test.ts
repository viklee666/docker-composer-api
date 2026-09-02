import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { CursorRunRequest, GatewayConfig } from "../src/types.js";
import { fetchAvailableModels } from "../src/cursor-connect/available-models.js";
import { encodeEnvelope } from "../src/cursor-connect/envelope.js";
import { ProviderRoutingRunner } from "../src/cursor-connect/routing-runner.js";
import { CursorConnectService, connectSettings, seedConnectCredential } from "../src/cursor-connect/service.js";
import { CursorConnectStore } from "../src/cursor-connect/store.js";
import {
  AvailableModelsRequest,
  AvailableModelsResponse,
  AvailableModelsResponse_AvailableModel,
  AvailableModelsResponse_DegradationStatus,
  AvailableModelsResponse_FeatureModelConfig,
  AvailableModelsResponse_ModelVariantConfig,
  AvailableModelsScope,
  ModelParameterDefinition,
  ModelParameterDefinition_EnumParameterDefinition,
  ModelParameterDefinition_EnumParameterDefinition_EnumParameterValue,
  ModelParameterDefinition_ModelParameterType,
  RequestedModel_ModelParameterValue
} from "../src/cursor-connect/proto/available_models_pb.js";
import {
  InferenceStreamResponse,
  InferenceTextStreamPart
} from "../src/cursor-connect/proto/inference_pb.js";

/* ------------------------------------------------------------ 配置默认 */

test("connect config defaults keep the SDK route in charge and every extra off", () => {
  const settings = connectSettings(loadConfig({}));
  assert.equal(settings.defaultProvider, "sdk", "Connect 未实测过工具循环，不能默认接管流量");
  assert.equal(settings.sendTools, false);
  assert.equal(settings.subagents, false);
  assert.equal(settings.background, false);
  assert.deepEqual(settings.localTools, [], "本地工具默认全关");
  assert.equal(settings.codec, "proto");
  assert.match(settings.baseUrl, /^https:\/\//);
});

test("connect config reads its env switches", () => {
  const settings = connectSettings(
    loadConfig({
      GATEWAY_PROVIDER: "connect",
      CURSOR_CONNECT_BASE_URL: "https://example.test",
      CURSOR_CONNECT_CODEC: "json",
      CURSOR_CONNECT_SEND_TOOLS: "true",
      CURSOR_CONNECT_LOCAL_TOOLS: "read_file, other",
      CURSOR_CONNECT_SUBAGENTS: "1"
    })
  );
  assert.equal(settings.defaultProvider, "connect");
  assert.equal(settings.baseUrl, "https://example.test");
  assert.equal(settings.codec, "json");
  assert.equal(settings.sendTools, true);
  assert.deepEqual(settings.localTools, ["read_file", "other"]);
  assert.equal(settings.subagents, true);
});

/* ------------------------------------------------------ 凭据与可用性 */

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({}), sqlitePath: ":memory:", ...overrides };
}

test("a credential seeded from env keeps a stable machine id across restarts", () => {
  const store = CursorConnectStore.open(":memory:");
  const config = baseConfig({ connectSessionToken: "token-one" });

  const first = seedConnectCredential(store, config);
  assert.ok(first);
  assert.equal(store.listCredentials().length, 1);

  // 同一个 token 再启动一次：不该重复写库。
  seedConnectCredential(store, config);
  assert.equal(store.listCredentials().length, 1);

  // token 换了要更新，但 machineId 必须原样保留——换了上游就当成另一台设备。
  const rotated = seedConnectCredential(store, baseConfig({ connectSessionToken: "token-two" }));
  assert.equal(rotated?.machineId, first.machineId);
  assert.equal(rotated?.sessionToken, "token-two");
  assert.equal(store.listCredentials().length, 1);
  store.close();
});

test("the stored token is not sitting in the database as plain text", () => {
  const store = CursorConnectStore.open(":memory:");
  const record = store.upsertCredential({ sessionToken: "super-secret-token", machineId: "m", clientVersion: "1" });
  assert.equal(record.sessionToken, "super-secret-token", "读回来必须是明文，provider 要用它发请求");

  const raw = store.rawCredentialRow(record.id);
  assert.ok(raw, "row should exist");
  assert.ok(!JSON.stringify(raw).includes("super-secret-token"), "落库的值不该是明文");
  store.close();
});

test("rotating a pasted token does not wipe model scope or the source key link", () => {
  const store = CursorConnectStore.open(":memory:");
  const first = store.upsertCredential({
    sessionToken: "token-one",
    machineId: "machine-stable",
    clientVersion: "1",
    sourceCursorKeyId: "key-1",
    allowedModels: ["grok-4.6"],
    excludedModels: ["skip-me"],
    macMachineId: "mac-1"
  });
  const rotated = store.upsertCredential({
    id: first.id,
    sessionToken: "token-two",
    machineId: "machine-stable",
    clientVersion: "1"
  });
  assert.equal(rotated.sourceCursorKeyId, "key-1");
  assert.deepEqual(rotated.allowedModels, ["grok-4.6"]);
  assert.deepEqual(rotated.excludedModels, ["skip-me"]);
  assert.equal(rotated.macMachineId, "mac-1");
  store.close();
});

test("importFromCursorKey copies the key scope and keeps machineId on the second pull", async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const session = `${encode({ alg: "none" })}.${encode({ type: "session" })}.sig`;
  const store = CursorConnectStore.open(":memory:");
  const service = new CursorConnectService({
    store,
    config: baseConfig(),
    fetchImpl: async () => Response.json({ accessToken: session, refreshToken: "refresh" })
  });
  const key = {
    id: "key-1",
    apiKey: "crsr_pool_key",
    label: "pool",
    modelScope: { allowed: ["grok-4.6"], excluded: [] }
  };
  const first = await service.importFromCursorKey(key);
  assert.equal(first.sourceCursorKeyId, "key-1");
  assert.deepEqual(first.allowedModels, ["grok-4.6"]);
  const second = await service.importFromCursorKey({ ...key, label: "pool" }, { machineId: "should-not-win" });
  assert.equal(second.id, first.id);
  assert.equal(second.machineId, first.machineId);
  store.close();
});

test("service availability and status explain what is missing", () => {
  const store = CursorConnectStore.open(":memory:");
  const service = new CursorConnectService({ store, config: baseConfig() });
  assert.equal(service.available, false);
  assert.match(service.status().reason ?? "", /还没有配置/);

  const record = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  assert.equal(service.available, true);
  assert.equal(service.status().activeCredentials, 1);

  store.setCredentialStatus(record.id, "disabled");
  assert.equal(service.available, false);
  assert.match(service.status().reason ?? "", /都已停用/);
  store.close();
});

test("running without a credential fails with a clear 503 rather than a transport error", async () => {
  const store = CursorConnectStore.open(":memory:");
  const service = new CursorConnectService({ store, config: baseConfig() });
  await assert.rejects(
    () => service.run(runRequest()),
    (error: unknown) => error instanceof ApiError && error.statusCode === 503
  );
  store.close();
});

test("a credential whose model scope excludes the request is not picked", () => {
  const store = CursorConnectStore.open(":memory:");
  store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1", allowedModels: ["only-this"] });
  const service = new CursorConnectService({ store, config: baseConfig() });

  assert.equal(service.pickCredential("only-this").machineId, "m");
  assert.throws(() => service.pickCredential("something-else"), (error: unknown) => error instanceof ApiError);
  store.close();
});

/* ------------------------------------------------------------ 目录调用 */

function catalogResponse(): AvailableModelsResponse {
  return new AvailableModelsResponse({
    models: [
      new AvailableModelsResponse_AvailableModel({
        name: "grok-4.6",
        defaultOn: true,
        clientDisplayName: "Grok 4.6",
        supportsThinking: true,
        supportsMaxMode: true,
        contextTokenLimit: 200_000,
        parameterDefinitions: [
          new ModelParameterDefinition({
            id: "effort",
            name: "Effort",
            parameterType: new ModelParameterDefinition_ModelParameterType({
              enumParameter: new ModelParameterDefinition_EnumParameterDefinition({
                values: [
                  new ModelParameterDefinition_EnumParameterDefinition_EnumParameterValue({ value: "low" }),
                  new ModelParameterDefinition_EnumParameterDefinition_EnumParameterValue({ value: "high" })
                ]
              })
            })
          })
        ],
        variants: [
          new AvailableModelsResponse_ModelVariantConfig({
            displayName: "default",
            isDefaultNonMaxConfig: true,
            parameterValues: [new RequestedModel_ModelParameterValue({ id: "effort", value: "low" })]
          })
        ],
        idAliases: ["grok"]
      }),
      new AvailableModelsResponse_AvailableModel({
        name: "retired-model",
        degradationStatus: AvailableModelsResponse_DegradationStatus.DISABLED
      })
    ],
    composerModelConfig: new AvailableModelsResponse_FeatureModelConfig({ defaultModel: "grok-4.6" }),
    subagentModelConfigs: {
      explore: new AvailableModelsResponse_FeatureModelConfig({ defaultModel: "grok-4.6" })
    }
  });
}

/**
 * 一元上游桩。
 *
 * 一元调用**没有 envelope**：请求体就是裸 protobuf，响应体也是。
 * 这里刻意直接 `fromBinary(body)` 而不是 `body.subarray(5)`——
 * 之前按流式那套发（带 5 字节 envelope + `application/connect+proto`）
 * 被真实服务端以 415 拒了，所以这个桩要按真实形状收。
 */
function unaryUpstream(response: AvailableModelsResponse) {
  const captured: Array<{ url: string; headers: Record<string, string>; request: AvailableModelsRequest }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body as Uint8Array;
    captured.push({
      url,
      headers: init.headers as Record<string, string>,
      request: AvailableModelsRequest.fromBinary(body)
    });
    return new Response(response.toBinary(), { status: 200 });
  };
  return { captured, fetchImpl };
}

const CREDENTIAL = { id: "c", sessionToken: "t", machineId: "m", clientVersion: "3.18.9" };

test("AvailableModels posts the documented request and maps the catalog", async () => {
  const { captured, fetchImpl } = unaryUpstream(catalogResponse());
  const catalog = await fetchAvailableModels({ credential: CREDENTIAL, fetchImpl, baseUrl: "https://api.test" });

  assert.equal(captured[0].url, "https://api.test/aiserver.v1.AiService/AvailableModels");
  // 一元用 `application/proto`，不是流式的 `application/connect+proto`——发错真会拿到 415。
  assert.equal(captured[0].headers["content-type"], "application/proto");
  assert.equal(captured[0].headers["connect-accept-encoding"], undefined, "一元不发 connect-* 压缩头");
  // 与 Grok Bot 的 fetchSandAvailableModels 一致：要参数定义、取用户可见范围。
  assert.equal(captured[0].request.useModelParameters, true);
  assert.equal(captured[0].request.scope, AvailableModelsScope.USER_AVAILABLE);

  assert.deepEqual(catalog.models.map((model) => model.id), ["grok-4.6", "retired-model"]);
  const grok = catalog.models[0];
  assert.equal(grok.displayName, "Grok 4.6");
  assert.equal(grok.contextTokenLimit, 200_000);
  assert.deepEqual(grok.aliases, ["grok"]);
  // parameter_definitions 是参数值域的权威来源，boolean 与 enum 都摊平成一组允许值。
  assert.deepEqual(grok.parameters, [
    { id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "high" }] }
  ]);
  assert.equal(grok.variants[0].isDefault, true);
  assert.equal(catalog.models[1].degradation, "disabled");
  assert.equal(catalog.defaultModel, "grok-4.6");
  assert.deepEqual(catalog.subagentModels, { explore: "grok-4.6" });
});

test("the model list hides DISABLED models and caches per credential", async () => {
  const store = CursorConnectStore.open(":memory:");
  store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const { captured, fetchImpl } = unaryUpstream(catalogResponse());
  const service = new CursorConnectService({ store, config: baseConfig(), fetchImpl });

  const models = await service.listModels();
  assert.deepEqual(models.map((model) => model.id), ["grok-4.6"], "DISABLED 的模型不对外暴露");
  await service.listModels();
  assert.equal(captured.length, 1, "TTL 内不该重复回源");

  await service.listModels(true);
  assert.equal(captured.length, 2, "强制刷新要真的回源");
  store.close();
});

test("a catalog failure degrades to no catalog rather than failing the request", async () => {
  const store = CursorConnectStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const service = new CursorConnectService({
    store,
    config: baseConfig(),
    fetchImpl: async () => new Response("nope", { status: 500 })
  });
  assert.equal(await service.catalog(credential), undefined);
  store.close();
});

test("a connectivity test records success and surfaces the upstream error otherwise", async () => {
  const store = CursorConnectStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });

  const ok = new CursorConnectService({ store, config: baseConfig(), fetchImpl: unaryUpstream(catalogResponse()).fetchImpl });
  const result = await ok.testCredential(credential.id);
  assert.equal(result.models, 2);
  assert.ok(store.credential(credential.id)?.lastUsedAt, "成功要记一次使用");

  const bad = new CursorConnectService({
    store,
    config: baseConfig(),
    fetchImpl: async () => new Response("bad token", { status: 401 })
  });
  await assert.rejects(
    () => bad.testCredential(credential.id),
    (error: unknown) => error instanceof ApiError && error.statusCode === 401
  );
  assert.equal(store.credential(credential.id)?.failureCount, 1, "鉴权失败要计数");
  store.close();
});

test("only auth failures count against a credential, not rate limits", async () => {
  const store = CursorConnectStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const service = new CursorConnectService({
    store,
    config: baseConfig(),
    // 429 是上游状态，跟这把 token 的有效性无关；按失败累计会把一次限流演变成停用凭据。
    fetchImpl: async () => new Response("slow down", { status: 429 })
  });
  await assert.rejects(() => service.testCredential(credential.id));
  assert.equal(store.credential(credential.id)?.failureCount, 0);
  store.close();
});

test("five auth failures disable the credential automatically", async () => {
  const store = CursorConnectStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const service = new CursorConnectService({
    store,
    config: baseConfig(),
    fetchImpl: async () => new Response("bad token", { status: 401 })
  });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => service.testCredential(credential.id));
  assert.equal(store.credential(credential.id)?.status, "disabled");
  assert.equal(service.available, false);
  store.close();
});

/* ------------------------------------------------------------ 推理与选路 */

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

test("a text run goes out over Connect and comes back as gateway events", async () => {
  const store = CursorConnectStore.open(":memory:");
  store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });

  const frames = [
    encodeEnvelope(
      new InferenceStreamResponse({
        response: { case: "textPart", value: new InferenceTextStreamPart({ text: "hi there" }) }
      }).toBinary()
    ),
    encodeEnvelope(new TextEncoder().encode("{}"), { endStream: true })
  ];
  let seenUrl = "";
  const service = new CursorConnectService({
    store,
    config: baseConfig(),
    fetchImpl: async (url) => {
      seenUrl = url;
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
  });

  const events = [];
  for await (const event of service.stream(runRequest())) events.push(event);
  assert.deepEqual(events, [
    { type: "text", text: "hi there" },
    { type: "done", result: { text: "hi there", toolCalls: [] } }
  ]);
  assert.match(seenUrl, /aiserver\.v1\.InferenceService\/Stream$/);
  // 成功一次要记使用时间，凭据轮换才能固定在同一把上。
  assert.ok(store.listCredentials()[0].lastUsedAt);
  store.close();
});

test("the routing runner dispatches on the provider field and falls back when connect is absent", async () => {
  const calls: string[] = [];
  const sdk = {
    run: async () => {
      calls.push("sdk.run");
      return { text: "sdk", toolCalls: [] };
    },
    stream: async function* () {
      calls.push("sdk.stream");
    }
  };
  const connect = {
    run: async () => {
      calls.push("connect.run");
      return { text: "connect", toolCalls: [] };
    },
    stream: async function* () {
      calls.push("connect.stream");
    }
  };

  const both = new ProviderRoutingRunner({ sdk, connect });
  assert.equal((await both.run(runRequest())).text, "sdk", "没写 provider 就是 SDK 路线");
  assert.equal((await both.run(runRequest({ provider: "connect" }))).text, "connect");
  assert.equal((await both.run(runRequest({ provider: "sdk" }))).text, "sdk");

  // Connect 没装时不该抛错，回落 SDK 比让请求 500 更可取。
  const sdkOnly = new ProviderRoutingRunner({ sdk });
  assert.equal((await sdkOnly.run(runRequest({ provider: "connect" }))).text, "sdk");
  assert.deepEqual(calls, ["sdk.run", "connect.run", "sdk.run", "sdk.run"]);
});
