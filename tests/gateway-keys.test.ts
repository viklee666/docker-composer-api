import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { authenticate, sha256, type AuthResolvers } from "../src/auth.js";
import { ApiError } from "../src/errors.js";
import { GatewayKeyPool, MIN_GATEWAY_KEY_LENGTH } from "../src/gateway-key-pool.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import type { ModelLister, ModelListResult } from "../src/models.js";
import { NO_KEY_SENTINEL } from "../src/routing.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunResult, CursorRunner, CursorStreamEvent, GatewayConfig } from "../src/types.js";

/** 与 makeConfig().gatewayApiKey 一致：单密钥时代的那把主密钥。 */
const LEGACY_KEY = "legacy-gateway-key-0001";
const ADMIN_PASSWORD = "admin-password";
/** HTTP 层用例里那把「绑了 Cursor key」的入站密钥。 */
const BOUND_KEY = "bound-inbound-key-0001";
/** 对照组：从来没绑过任何 Cursor key，语义是「不限制」。 */
const UNBOUND_KEY = "unbound-inbound-key-0002";

test("seedFromEnv is idempotent and keeps manual edits", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  await pool.seedFromEnv(LEGACY_KEY);
  await pool.seedFromEnv(LEGACY_KEY);

  const seeded = await pool.list();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].source, "env");
  assert.equal(seeded[0].status, "active");
  assert.deepEqual(seeded[0].allowedCursorKeyIds, []);
  assert.deepEqual(seeded[0].modelScope, { allowed: [], excluded: [] });

  assert.equal(await pool.disable(seeded[0].id), true);
  await pool.seedFromEnv(LEGACY_KEY);
  const reseeded = await pool.list();
  assert.equal(reseeded.length, 1);
  assert.equal(reseeded[0].status, "disabled");
});

test("seedFromEnv ignores a missing or blank env key", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  await pool.seedFromEnv(undefined);
  await pool.seedFromEnv("   ");
  assert.deepEqual(await pool.list(), []);
  assert.equal(pool.hasAnyKey(), false);
});

test("restarting without GATEWAY_API_KEY disables the retained env record", async () => {
  const store = new MemoryStateStore();
  const firstPool = new GatewayKeyPool(store);
  await firstPool.seedFromEnv(LEGACY_KEY);
  const first = (await firstPool.list())[0];
  assert.ok(first);

  // 新池复用同一份持久化数据，模拟进程重启后的播种。
  const restarted = new GatewayKeyPool(store);
  await restarted.seedFromEnv(undefined);
  const retained = (await restarted.list())[0];
  assert.equal(retained?.id, first.id);
  assert.equal(retained?.source, "env");
  assert.equal(retained?.status, "disabled");
  assert.equal(restarted.resolve(LEGACY_KEY), undefined);

  // 变量暂时恢复也不能无意复活被撤销的凭据；需要显式 enable。
  await restarted.seedFromEnv(LEGACY_KEY);
  assert.equal((await restarted.list())[0]?.status, "disabled");
  assert.throws(
    () => authenticate(bearer(LEGACY_KEY), makeConfig({ allowDirectCursorKeys: false }), resolvers(restarted)),
    apiError(401, "unauthorized")
  );
});

test("add rejects empty, too-short and duplicate keys", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  await assert.rejects(pool.add("   "), apiError(400));
  await assert.rejects(pool.add("short-key"), apiError(400));

  const created = await pool.add("first-inbound-key-123456", { label: "team-a" });
  assert.equal(created.label, "team-a");
  assert.equal(created.source, "manual");
  await assert.rejects(pool.add("  first-inbound-key-123456  "), apiError(409, "key_exists"));
  assert.equal((await pool.list()).length, 1);
});

test("generateKey produces distinct, long, URL-safe keys", () => {
  const keys = Array.from({ length: 64 }, () => GatewayKeyPool.generateKey());
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.match(key, /^gw-[A-Za-z0-9_-]+$/);
    assert.ok(key.length > MIN_GATEWAY_KEY_LENGTH * 2);
  }
});

test("resolve follows add/disable/enable/remove with no explicit refresh", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  assert.equal(pool.hasAnyKey(), false);

  const record = await pool.add("inbound-key-aaaaaaaaaaaa");
  assert.equal(pool.hasAnyKey(), true);
  assert.equal(pool.resolve("inbound-key-aaaaaaaaaaaa")?.id, record.id);
  assert.equal(pool.resolve("inbound-key-aaaaaaaaaaaab"), undefined);
  assert.equal(pool.resolve("unknown"), undefined);
  assert.equal(pool.resolve(""), undefined);

  await pool.disable(record.id);
  assert.equal(pool.resolve("inbound-key-aaaaaaaaaaaa"), undefined);
  assert.equal(pool.resolveAny("inbound-key-aaaaaaaaaaaa")?.status, "disabled");
  assert.equal(pool.hasAnyKey(), true);

  await pool.enable(record.id);
  assert.equal(pool.resolve("inbound-key-aaaaaaaaaaaa")?.id, record.id);

  assert.equal(await pool.remove(record.id), true);
  assert.equal(pool.resolve("inbound-key-aaaaaaaaaaaa"), undefined);
  assert.equal(pool.resolveAny("inbound-key-aaaaaaaaaaaa"), undefined);
  assert.equal(pool.hasAnyKey(), false);
});

test("update normalizes restrictions and recordUse tallies into the snapshot", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const record = await pool.add("inbound-key-bbbbbbbbbbbb");

  const updated = await pool.update(record.id, {
    allowedCursorKeyIds: ["key-1", " key-1 ", "", "key-2"],
    modelScope: { allowed: ["gpt-5", "  "], excluded: [] }
  });
  assert.deepEqual(updated?.allowedCursorKeyIds, ["key-1", "key-2"]);
  assert.deepEqual(updated?.modelScope, { allowed: ["gpt-5"], excluded: [] });
  assert.deepEqual(pool.resolve("inbound-key-bbbbbbbbbbbb")?.allowedCursorKeyIds, ["key-1", "key-2"]);

  await pool.recordUse(record.id);
  assert.equal(pool.resolve("inbound-key-bbbbbbbbbbbb")?.requestCount, 1);
  assert.equal((await pool.get(record.id))?.requestCount, 1);
  assert.equal(await pool.update("no-such-id", { label: "x" }), undefined);
});

test("authenticate surfaces the gateway key identity and its restrictions", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const record = await pool.add("team-a-inbound-key-0001", {
    label: "team-a",
    allowedCursorKeyIds: ["cursor-key-1"],
    modelScope: { allowed: ["gpt-5"], excluded: ["o3"] }
  });

  const auth = authenticate(bearer("team-a-inbound-key-0001"), makeConfig(), resolvers(pool));
  assert.equal(auth.mode, "gateway");
  assert.equal(auth.apiKey, undefined);
  assert.equal(auth.gatewayKeyId, record.id);
  assert.equal(auth.gatewayKeyLabel, "team-a");
  assert.deepEqual(auth.allowedCursorKeyIds, ["cursor-key-1"]);
  assert.deepEqual(auth.modelScope, { allowed: ["gpt-5"], excluded: ["o3"] });
  assert.equal(auth.ownerHash, sha256(`gateway-key:${record.id}`));

  // x-api-key 与 Authorization 走同一条解析路径。
  assert.equal(authenticate(apiKeyHeader("team-a-inbound-key-0001"), makeConfig(), resolvers(pool)).gatewayKeyId, record.id);
});

test("an unrestricted gateway key leaves both scopes undefined", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  await pool.add("team-b-inbound-key-0002");

  const auth = authenticate(bearer("team-b-inbound-key-0002"), makeConfig(), resolvers(pool));
  assert.equal(auth.allowedCursorKeyIds, undefined);
  assert.equal(auth.modelScope, undefined);
});

test("a disabled gateway key is 401 instead of falling through to direct mode", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const record = await pool.add("team-c-inbound-key-0003");
  await pool.disable(record.id);

  const config = makeConfig({ allowDirectCursorKeys: true });
  assert.throws(
    () => authenticate(bearer("team-c-inbound-key-0003"), config, resolvers(pool)),
    apiError(401, "unauthorized")
  );
});

test("a disabled env-sourced key does not fall back to the legacy single-key path", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const config = makeConfig();
  await pool.seedFromEnv(config.gatewayApiKey);
  const [seeded] = await pool.list();
  await pool.disable(seeded.id);

  assert.throws(() => authenticate(bearer(LEGACY_KEY), config, resolvers(pool)), apiError(401, "unauthorized"));
});

test("a disabled env-sourced gateway key cannot re-enable itself through the admin api", async () => {
  const { app, gatewayKeyPool } = await createTestApp({ config: { adminPassword: LEGACY_KEY } });
  await gatewayKeyPool.seedFromEnv(LEGACY_KEY);
  const [seeded] = await gatewayKeyPool.list();
  assert.ok(seeded);
  await gatewayKeyPool.disable(seeded.id);

  const models = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${LEGACY_KEY}` }
  });
  assert.equal(models.statusCode, 401);

  const response = await app.inject({
    method: "POST",
    url: `/admin/api/gateway-keys/${seeded.id}/enable`,
    headers: { authorization: `Bearer ${LEGACY_KEY}` }
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  assert.equal((await gatewayKeyPool.list())[0]?.status, "disabled");
});

test("the legacy single key still works and keeps its owner hash", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const config = makeConfig();
  const expected = sha256(`gateway:${LEGACY_KEY}`);

  const withoutResolvers = authenticate(bearer(LEGACY_KEY), config);
  assert.equal(withoutResolvers.mode, "gateway");
  assert.equal(withoutResolvers.gatewayKeyId, undefined);
  assert.equal(withoutResolvers.ownerHash, expected);

  // 接入密钥池后，配置值必须由 active 记录承载；空池不能绕过删除语义。
  assert.throws(
    () => authenticate(bearer(LEGACY_KEY), config, resolvers(pool)),
    apiError(401, "unauthorized")
  );
});

test("an env-seeded key equal to gatewayApiKey keeps the legacy owner hash, a manual key gets its own", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  const config = makeConfig();
  await pool.seedFromEnv(config.gatewayApiKey);
  const [seeded] = await pool.list();
  const manual = await pool.add("manual-inbound-key-0004");

  const seededAuth = authenticate(bearer(LEGACY_KEY), config, resolvers(pool));
  assert.equal(seededAuth.gatewayKeyId, seeded.id);
  // 播种后主密钥的 owner 口径必须与开表之前逐字节一致，否则历史 responses 全部失联。
  assert.equal(seededAuth.ownerHash, sha256(`gateway:${LEGACY_KEY}`));
  assert.equal(seededAuth.ownerHash, authenticate(bearer(LEGACY_KEY), config).ownerHash);

  const manualAuth = authenticate(bearer("manual-inbound-key-0004"), config, resolvers(pool));
  assert.equal(manualAuth.ownerHash, sha256(`gateway-key:${manual.id}`));
  assert.notEqual(manualAuth.ownerHash, seededAuth.ownerHash);
});

test("rotating GATEWAY_API_KEY disables the old env record and activates the new one", async () => {
  const store = new MemoryStateStore();
  const firstPool = new GatewayKeyPool(store);
  await firstPool.seedFromEnv("previous-env-key-0005");
  const previous = (await firstPool.list())[0];
  assert.ok(previous);

  const restarted = new GatewayKeyPool(store);
  await restarted.seedFromEnv("rotated-env-key-0007");
  const records = await restarted.list();
  const oldRecord = records.find((record) => record.apiKey === "previous-env-key-0005");
  const current = records.find((record) => record.apiKey === "rotated-env-key-0007");
  assert.equal(records.length, 2);
  assert.equal(oldRecord?.id, previous.id);
  assert.equal(oldRecord?.status, "disabled");
  assert.ok(current);
  assert.equal(current.status, "active");
  assert.equal(restarted.resolve("previous-env-key-0005"), undefined);
  assert.equal(restarted.resolve("rotated-env-key-0007")?.id, current.id);

  assert.throws(
    () => authenticate(
      bearer("previous-env-key-0005"),
      makeConfig({ gatewayApiKey: "rotated-env-key-0007", allowDirectCursorKeys: false }),
      resolvers(restarted)
    ),
    apiError(401, "unauthorized")
  );
  const newAuth = authenticate(
    bearer("rotated-env-key-0007"),
    makeConfig({ gatewayApiKey: "rotated-env-key-0007", allowDirectCursorKeys: false }),
    resolvers(restarted)
  );
  assert.equal(newAuth.gatewayKeyId, current.id);
  // 当前 env 记录仍沿用 legacy owner 口径；轮换只撤销旧 token，不重分区新 token 的历史语义。
  assert.equal(newAuth.ownerHash, sha256("gateway:rotated-env-key-0007"));
});

test("direct mode and the missing-token path are unchanged", async () => {
  const pool = new GatewayKeyPool(new MemoryStateStore());
  await pool.add("team-d-inbound-key-0006");
  const config = makeConfig();

  const direct = authenticate(bearer("key_raw_cursor_token"), config, resolvers(pool));
  assert.equal(direct.mode, "direct");
  assert.equal(direct.apiKey, "key_raw_cursor_token");
  assert.equal(direct.ownerHash, sha256("direct:key_raw_cursor_token"));
  assert.equal(direct.gatewayKeyId, undefined);

  assert.throws(() => authenticate(bearer(""), config, resolvers(pool)), apiError(401, "unauthorized"));
  assert.throws(() => authenticate(noAuth(), config, resolvers(pool)), apiError(401, "unauthorized"));
  assert.throws(
    () => authenticate(bearer("unknown-token"), makeConfig({ allowDirectCursorKeys: false }), resolvers(pool)),
    apiError(401, "unauthorized")
  );
});

test("deleting a manual gateway key equal to gatewayApiKey revokes it", async () => {
  const { app, gatewayKeyPool } = await createTestApp({ config: { allowDirectCursorKeys: false } });
  const manual = await gatewayKeyPool.add(LEGACY_KEY);
  assert.equal((await chat(app, LEGACY_KEY)).statusCode, 200);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/admin/api/gateway-keys/${manual.id}`,
    headers: adminHeaders()
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(gatewayKeyPool.resolveAny(LEGACY_KEY), undefined);
  assert.equal((await chat(app, LEGACY_KEY)).statusCode, 401);
});

test("deleting the last bound cursor key leaves the gateway key able to use nothing", async () => {
  const { app, keyPool, gatewayKeyPool } = await createTestApp({ cursorKeys: ["cursor-key-a", "cursor-key-b"] });
  const [keyA, keyB] = await keyPool.list();
  await gatewayKeyPool.add(BOUND_KEY, { allowedCursorKeyIds: [keyA.id, keyB.id] });

  assert.equal((await chat(app, BOUND_KEY)).statusCode, 200);

  // 还剩一把绑定：快照要即时收窄到剩下的那把，请求继续正常。
  assert.equal((await deleteCursorKey(app, keyA.id)).statusCode, 200);
  assert.deepEqual(gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds, [keyB.id]);
  assert.equal((await chat(app, BOUND_KEY)).statusCode, 200);

  // 最后一把也被删掉：绑定落到哨兵，这把密钥什么都用不了。
  // 池里仍有 cursor-key-c，所以 403 只可能来自绑定本身，不是「没配 key」。
  await keyPool.add("cursor-key-c");
  assert.equal((await deleteCursorKey(app, keyB.id)).statusCode, 200);
  assert.deepEqual(gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds, [NO_KEY_SENTINEL]);

  const denied = await chat(app, BOUND_KEY);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "not_authorized");
  // 对照组：从来没绑过的密钥仍然可用整个池，空列表的「不限制」语义没被改掉。
  await gatewayKeyPool.add(UNBOUND_KEY);
  assert.equal((await chat(app, UNBOUND_KEY)).statusCode, 200);
});

test("deleting the only bound cursor key returns 403 even when the pool is empty", async () => {
  const { app, keyPool, gatewayKeyPool } = await createTestApp({ cursorKeys: ["cursor-key-only"] });
  const [only] = await keyPool.list();
  await gatewayKeyPool.add(BOUND_KEY, { allowedCursorKeyIds: [only.id] });

  assert.equal((await deleteCursorKey(app, only.id)).statusCode, 200);
  assert.deepEqual(gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds, [NO_KEY_SENTINEL]);

  const denied = await chat(app, BOUND_KEY);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "not_authorized");
});

test("a gateway binding whose Cursor keys are all disabled returns 403 not 429", async () => {
  const { app, keyPool, gatewayKeyPool } = await createTestApp({ cursorKeys: ["cursor-key-a", "cursor-key-b"] });
  const keys = await keyPool.list();
  await gatewayKeyPool.add(BOUND_KEY, { allowedCursorKeyIds: keys.map((key) => key.id) });
  for (const key of keys) await keyPool.disable(key.id, "manual");

  const denied = await chat(app, BOUND_KEY);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "not_authorized");
});

test("the gateway key snapshot refreshes on cursor key deletion without a restart", async () => {
  const { app, keyPool, gatewayKeyPool } = await createTestApp({ cursorKeys: ["cursor-key-a", "cursor-key-b"] });
  const [keyA] = await keyPool.list();
  await gatewayKeyPool.add(BOUND_KEY, { allowedCursorKeyIds: [keyA.id] });
  assert.deepEqual(gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds, [keyA.id]);

  await deleteCursorKey(app, keyA.id);
  // 删 key 是绕过网关密钥池直接改 gateway_keys 的，路由不 refresh 的话这里读到的还是被删的 id。
  assert.deepEqual(gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds, [NO_KEY_SENTINEL]);
  assert.deepEqual(
    (await gatewayKeyPool.list())[0].allowedCursorKeyIds,
    gatewayKeyPool.resolve(BOUND_KEY)?.allowedCursorKeyIds,
    "内存快照与库必须一致"
  );
});

test("a dead binding survives the admin bind form and only widens when asked explicitly", async () => {
  const { app, keyPool, gatewayKeyPool } = await createTestApp({ cursorKeys: ["cursor-key-a", "cursor-key-b"] });
  const [keyA, keyB] = await keyPool.list();
  const record = await gatewayKeyPool.add(BOUND_KEY, { allowedCursorKeyIds: [keyA.id] });
  await deleteCursorKey(app, keyA.id);

  // 后台把哨兵原样回填。校验器必须放行它，否则运维只能靠清空绑定「修好」表单——而清空就是放开整池。
  const resaved = await editGatewayKey(app, record.id, { label: "team-a", allowedCursorKeyIds: [NO_KEY_SENTINEL] });
  assert.equal(resaved.statusCode, 200);
  assert.deepEqual(resaved.json().key.allowedCursorKeyIds, [NO_KEY_SENTINEL]);
  assert.equal((await chat(app, BOUND_KEY)).statusCode, 403);

  // 勾了真实 key 就以真实绑定为准，哨兵作废。
  const rebound = await editGatewayKey(app, record.id, { allowedCursorKeyIds: [NO_KEY_SENTINEL, keyB.id] });
  assert.deepEqual(rebound.json().key.allowedCursorKeyIds, [keyB.id]);
  assert.equal((await chat(app, BOUND_KEY)).statusCode, 200);

  // 显式清空仍然是「不限制」：这是运维明确的意图，语义不变。
  const widened = await editGatewayKey(app, record.id, { allowedCursorKeyIds: [] });
  assert.deepEqual(widened.json().key.allowedCursorKeyIds, []);
  assert.equal((await chat(app, BOUND_KEY)).statusCode, 200);

  // 绑定到不存在的 key 依然要 400，放行哨兵不等于放行任意脏 id。
  const bogus = await editGatewayKey(app, record.id, { allowedCursorKeyIds: ["no-such-key"] });
  assert.equal(bogus.statusCode, 400);
});

test("an env-sourced gateway key is 409 on delete but can still be disabled", async () => {
  const { app, gatewayKeyPool } = await createTestApp();
  await gatewayKeyPool.seedFromEnv(LEGACY_KEY);
  const manual = await gatewayKeyPool.add(UNBOUND_KEY);
  const [seeded] = (await gatewayKeyPool.list()).filter((key) => key.source === "env");
  assert.equal((await chat(app, LEGACY_KEY)).statusCode, 200);

  const refused = await app.inject({
    method: "DELETE",
    url: `/admin/api/gateway-keys/${seeded.id}`,
    headers: adminHeaders()
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "gateway_key_env_managed");
  assert.match(refused.json().error.message, /GATEWAY_API_KEY/);
  assert.equal((await gatewayKeyPool.list()).length, 2, "拒绝删除就不能顺手删掉半条记录");

  // 停用是真正有效的替代方案：auth 在 legacy 分支之前就拦下 disabled 记录。
  const disabled = await app.inject({
    method: "POST",
    url: `/admin/api/gateway-keys/${seeded.id}/disable`,
    headers: adminHeaders()
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal((await chat(app, LEGACY_KEY)).statusCode, 401);

  // 后台添加的密钥不受影响，照删不误。
  const removed = await app.inject({
    method: "DELETE",
    url: `/admin/api/gateway-keys/${manual.id}`,
    headers: adminHeaders()
  });
  assert.equal(removed.statusCode, 200);
  assert.equal((await gatewayKeyPool.list()).length, 1);
});

test("the admin model catalogue is the union across every active cursor key", async () => {
  const catalogues: Record<string, ModelListResult> = {
    "cursor-key-a": {
      models: [{ id: "composer-2.5", name: "Composer 2.5", aliases: ["composer-latest"] }],
      source: "cursor"
    },
    "cursor-key-b": {
      models: [
        { id: "composer-2.5", name: "Composer 2.5", aliases: ["composer"] },
        { id: "claude-opus-4-8", name: "Opus", aliases: ["opus"] }
      ],
      source: "cursor"
    }
  };
  const asked: (string | undefined)[] = [];
  const { app, keyPool } = await createTestApp({
    cursorKeys: ["cursor-key-a", "cursor-key-b", "cursor-key-broken"],
    modelLister: (apiKey) => {
      asked.push(apiKey);
      // 一把 key 拉不到目录不能让整份全局清单塌掉。这里刻意同步抛：
      // runWithCursorClientType 是同步转发，同步异常不会变成 rejected promise。
      if (apiKey === "cursor-key-broken") throw new Error("upstream down for this account");
      return Promise.resolve(catalogues[apiKey ?? ""] ?? { models: [], source: "fallback" });
    }
  });
  // 被禁用的 key 不参与并集：它的目录不代表任何还能跑的请求。
  const disabled = (await keyPool.list()).find((key) => key.apiKey === "cursor-key-b");
  assert.ok(disabled);

  const response = await app.inject({ method: "GET", url: "/admin/api/models", headers: adminHeaders() });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.models.map((model: { id: string }) => model.id), ["composer-2.5", "claude-opus-4-8"]);
  assert.deepEqual(body.models[0].aliases, ["composer-latest", "composer"], "同一模型在不同账号下的别名取并集");
  assert.equal(body.source, "cursor");
  assert.deepEqual(asked, ["cursor-key-a", "cursor-key-b", "cursor-key-broken"]);

  await keyPool.disable(disabled.id, "manual");
  const narrowed = await app.inject({ method: "GET", url: "/admin/api/models", headers: adminHeaders() });
  assert.deepEqual(narrowed.json().models.map((model: { id: string }) => model.id), ["composer-2.5"]);
});

/** 一个只关心「请求有没有走到上游」的假 runner：本文件的用例只断言选 key / 鉴权的结果。 */
class StubRunner implements CursorRunner {
  async run(): Promise<CursorRunResult> {
    return { text: "ok", toolCalls: [] };
  }

  async *stream(): AsyncIterable<CursorStreamEvent> {
    yield { type: "done", result: { text: "ok", toolCalls: [] } };
  }
}

/**
 * 起一个真实的 Fastify 实例，鉴权与选 key 全走生产代码路径。
 * 网关绑定的语义只有在 HTTP 层才能验完整：store 写了什么、快照读到什么、
 * 以及最终客户端拿到 200 还是 403，是三件独立的事。
 */
async function createTestApp(options: {
  cursorKeys?: string[];
  modelLister?: ModelLister;
  config?: Partial<GatewayConfig>;
} = {}): Promise<{
  app: FastifyInstance;
  store: MemoryStateStore;
  keyPool: CursorKeyPool;
  gatewayKeyPool: GatewayKeyPool;
}> {
  const store = new MemoryStateStore();
  const config = makeConfig(options.config);
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(options.cursorKeys ?? ["cursor-key-a"]);
  const gatewayKeyPool = new GatewayKeyPool(store);
  await gatewayKeyPool.refresh();
  const app = createApp({
    config,
    store,
    keyPool,
    gatewayKeyPool,
    runner: new KeyRotatingRunner(new StubRunner(), keyPool),
    modelLister: options.modelLister ?? (async () => ({
      models: [{ id: "composer-2.5", name: "Composer 2.5", aliases: [] }],
      source: "cursor"
    }))
  });
  return { app, store, keyPool, gatewayKeyPool };
}

function chat(app: FastifyInstance, token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${token}` },
    payload: { model: "composer-2.5", messages: [{ role: "user", content: "ping" }] }
  });
}

function deleteCursorKey(app: FastifyInstance, id: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "DELETE", url: `/admin/api/keys/${id}`, headers: adminHeaders() });
}

function editGatewayKey(
  app: FastifyInstance,
  id: string,
  payload: Record<string, unknown>
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: `/admin/api/gateway-keys/${id}`, headers: adminHeaders(), payload });
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_PASSWORD}` };
}

function resolvers(pool: GatewayKeyPool): AuthResolvers {
  return {
    resolveGatewayKey: (token) => pool.resolve(token),
    resolveAnyGatewayKey: (token) => pool.resolveAny(token)
  };
}

function bearer(token: string): FastifyRequest {
  return fakeRequest({ authorization: `Bearer ${token}` });
}

function apiKeyHeader(token: string): FastifyRequest {
  return fakeRequest({ "x-api-key": token });
}

function noAuth(): FastifyRequest {
  return fakeRequest({});
}

function fakeRequest(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function apiError(statusCode: number, code?: string): (error: unknown) => boolean {
  return (error) => {
    if (!(error instanceof ApiError)) throw new Error(`expected ApiError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    if (code) assert.equal(error.code, code);
    return true;
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    cursorApiKeys: [],
    gatewayApiKey: LEGACY_KEY,
    adminPassword: ADMIN_PASSWORD,
    allowDirectCursorKeys: true,
    sqlitePath: ":memory:",
    requestLogKeep: 0,
    cursorWorkingDirectory: "/tmp",
    requestTimeoutMs: 30_000,
    sdkClientVersion: "sdk-test",
    cursorSdkDisableSessionResume: true,
    cursorAllowBuiltinTools: false,
    cursorSdkUseHttp1ForAgent: false,
    maxKeyAttempts: 10,
    maxTransientAttempts: 3,
    autoDisableKeys: true,
    autoDisableThreshold: 2,
    sandClientMode: false,
    routingStrategy: "fill-first",
    sessionAffinity: true,
    sessionAffinityTtlMs: 3_600_000,
    systemPromptMode: "off",
    cursorPrewarm: false,
    ...overrides
  };
}
