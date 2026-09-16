import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { CursorKeyRecord, CursorRunRequest, GatewayConfig } from "../src/types.js";
import { keyMintedTokenNeedsRefresh } from "../src/cursor-bot/credentials.js";
import { encodeEnvelope } from "../src/cursor-bot/envelope.js";
import { CursorBotService, botSettings } from "../src/cursor-bot/service.js";
import { CursorBotStore } from "../src/cursor-bot/store.js";
import {
  InferenceStreamResponse,
  InferenceTextStreamPart
} from "../src/cursor-bot/proto/inference_pb.js";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({}), sqlitePath: ":memory:", ...overrides };
}

function keyRecord(id = "key-1"): Pick<CursorKeyRecord, "id" | "apiKey" | "label" | "modelScope" | "status"> {
  return {
    id,
    apiKey: "crsr_pool_key",
    label: "pool",
    modelScope: { allowed: [], excluded: [] },
    status: "active"
  };
}

function streamPong(): Response {
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

function runRequest(): CursorRunRequest {
  return {
    protocol: "openai-chat",
    apiKey: "unused",
    useKeyPool: false,
    model: "grok-4.6",
    prompt: "hi",
    sessionKey: "owner",
    images: [],
    tools: []
  } as CursorRunRequest;
}

test("upsertCredential persists JWT exp for api_key_token", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = jwt({ type: "api_key_token", exp });
  const store = CursorBotStore.open(":memory:");
  const record = store.upsertCredential({ sessionToken: token, machineId: "m", clientVersion: "1" });
  assert.equal(record.tokenType, "api_key_token");
  assert.equal(record.expiresAt, new Date(exp * 1000).toISOString());
  const raw = store.rawCredentialRow(record.id);
  assert.equal(raw?.expires_at, record.expiresAt);
  store.close();
});

test("auto-refresh re-exchanges a from-key token inside the expiry window", async () => {
  const now = Date.now();
  const expiring = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 60 });
  const fresh = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 3600 });
  const exchanges: string[] = [];
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  const service = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async (id) => (id === source.id ? source : undefined),
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/exchange_user_api_key")) {
        exchanges.push(fresh);
        return Response.json({ accessToken: fresh, refreshToken: "r" });
      }
      if (String(url).includes("InferenceService/Stream")) return streamPong();
      return new Response("unexpected", { status: 500 });
    }
  });
  const credential = store.upsertCredential({
    sessionToken: expiring,
    machineId: "machine-stable",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  assert.equal(keyMintedTokenNeedsRefresh(credential, now), true);

  await service.refreshExpiringKeyTokens();
  assert.equal(exchanges.length, 1);
  assert.equal(store.credential(credential.id)?.sessionToken, fresh);
  assert.equal(store.credential(credential.id)?.machineId, "machine-stable");

  await service.refreshExpiringKeyTokens();
  assert.equal(exchanges.length, 1, "还早的新票不该再兑");
  store.close();
});

test("auto-refresh stays off the wire when the token still has headroom", async () => {
  const now = Date.now();
  const token = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 50 * 60 });
  let exchanges = 0;
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  const service = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl: async () => {
      exchanges += 1;
      return Response.json({ accessToken: token, refreshToken: "r" });
    }
  });
  store.upsertCredential({
    sessionToken: token,
    machineId: "m",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  await service.refreshExpiringKeyTokens();
  assert.equal(exchanges, 0);
  store.close();
});

test("auto-refresh does not touch pasted tokens or honor a disabled switch", async () => {
  const now = Date.now();
  const expiring = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 30 });
  let exchanges = 0;
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  const fetchImpl = async () => {
    exchanges += 1;
    return Response.json({ accessToken: jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 3600 }), refreshToken: "r" });
  };

  const pasted = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl
  });
  store.upsertCredential({ sessionToken: expiring, machineId: "m1", clientVersion: "1" });
  await pasted.refreshExpiringKeyTokens();
  assert.equal(exchanges, 0, "没有 sourceCursorKeyId 的不兑");

  const off = new CursorBotService({
    store,
    config: baseConfig({ botAutoRefreshFromKey: false }),
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl
  });
  const fromKey = store.upsertCredential({
    sessionToken: expiring,
    machineId: "m2",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  await off.refreshExpiringKeyTokens();
  assert.equal(exchanges, 0, "开关关掉时巡检不兑");

  const forced = await off.refreshCredentialFromSourceKey(fromKey.id);
  assert.equal(exchanges, 1, "手动刷新无视开关");
  assert.notEqual(forced.sessionToken, expiring);
  store.close();
});

test("auto-refresh skips a disabled source key; concurrent callers single-flight", async () => {
  const now = Date.now();
  const expiring = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 30 });
  const fresh = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 3600 });
  let exchanges = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  const service = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl: async () => {
      exchanges += 1;
      await gate;
      return Response.json({ accessToken: fresh, refreshToken: "r" });
    }
  });
  const disabled = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async () => ({ ...source, status: "disabled" }),
    fetchImpl: async () => {
      exchanges += 1;
      return Response.json({ accessToken: fresh, refreshToken: "r" });
    }
  });
  const credential = store.upsertCredential({
    sessionToken: expiring,
    machineId: "m",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  await disabled.refreshExpiringKeyTokens();
  assert.equal(exchanges, 0, "源 key 停用时自动刷新跳过");
  assert.equal(store.credential(credential.id)?.sessionToken, expiring);

  const first = service.refreshExpiringKeyTokens();
  const second = service.refreshExpiringKeyTokens();
  release();
  await Promise.all([first, second]);
  assert.equal(exchanges, 1, "并发巡检只兑一次");
  assert.equal(store.credential(credential.id)?.sessionToken, fresh);
  store.close();
});

test("stream refreshes an expiring from-key token before talking to inference", async () => {
  const now = Date.now();
  const expiring = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 60 });
  const fresh = jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 3600 });
  const seen: string[] = [];
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  const service = new CursorBotService({
    store,
    config: baseConfig(),
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl: async (url, init) => {
      const href = String(url);
      if (href.includes("/auth/exchange_user_api_key")) {
        seen.push("exchange");
        return Response.json({ accessToken: fresh, refreshToken: "r" });
      }
      if (href.includes("InferenceService/Stream")) {
        seen.push("stream");
        const headers = init?.headers as Record<string, string> | undefined;
        assert.equal(headers?.authorization, `Bearer ${fresh}`, "推理必须带新票，不能还拿快过期的");
        return streamPong();
      }
      return new Response("unexpected", { status: 500 });
    }
  });
  store.upsertCredential({
    sessionToken: expiring,
    machineId: "m",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  const result = await service.run(runRequest());
  assert.equal(result.text, "pong");
  assert.deepEqual(seen, ["exchange", "stream"]);
  store.close();
});

test("refreshCredentialFromSourceKey refuses credentials not minted from a key", async () => {
  const store = CursorBotStore.open(":memory:");
  const service = new CursorBotService({ store, config: baseConfig() });
  const pasted = store.upsertCredential({ sessionToken: "pasted", machineId: "m", clientVersion: "1" });
  await assert.rejects(
    () => service.refreshCredentialFromSourceKey(pasted.id),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400
  );
  store.close();
});

test("botSettings autoRefreshFromKey is live, not a constructor snapshot", async () => {
  const config = baseConfig();
  assert.equal(botSettings(config).autoRefreshFromKey, true);
  config.botOverrides = { autoRefreshFromKey: false };
  const store = CursorBotStore.open(":memory:");
  const source = keyRecord();
  let exchanges = 0;
  const now = Date.now();
  const service = new CursorBotService({
    store,
    config,
    now: () => new Date(now),
    resolveSourceKey: async () => source,
    fetchImpl: async () => {
      exchanges += 1;
      return Response.json({
        accessToken: jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 3600 }),
        refreshToken: "r"
      });
    }
  });
  store.upsertCredential({
    sessionToken: jwt({ type: "api_key_token", exp: Math.floor(now / 1000) + 30 }),
    machineId: "m",
    clientVersion: "1",
    sourceCursorKeyId: source.id
  });
  await service.refreshExpiringKeyTokens();
  assert.equal(exchanges, 0, "运行期关掉后巡检立刻停");
  config.botOverrides = { autoRefreshFromKey: true };
  await service.refreshExpiringKeyTokens();
  assert.equal(exchanges, 1, "再打开立即生效");
  store.close();
});
