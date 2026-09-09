import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { endStreamError, envelopeError, httpTransportError, isUpstreamResourceExhausted } from "../src/cursor-bot/errors.js";
import { EnvelopeTooLargeError } from "../src/cursor-bot/envelope.js";
import { CursorBotService } from "../src/cursor-bot/service.js";
import { CursorBotStore, type BotCredential } from "../src/cursor-bot/store.js";
import { ApiError } from "../src/errors.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { classifyKeyFailure, CursorKeyPool } from "../src/key-pool.js";
import {
  bucketExhausted,
  DEFAULT_QUOTA_BUCKET_RESET_MS,
  DEFAULT_QUOTA_BUCKET_TABLE,
  ModelQuotaBucketStore,
  parseQuotaBucketTable,
  pruneExhaustedBuckets,
  resolveQuotaBucket,
  type QuotaBucket
} from "../src/quota-buckets.js";
import { QuotaBucketSync } from "../src/quota-bucket-sync.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunner, GatewayConfig } from "../src/types.js";

/* ------------------------------------------------------ 纯函数：判定链 */

test("resolveQuotaBucket prefers the manual table, then vendor, then default", () => {
  const table = parseQuotaBucketTable({ models: { "composer-2.5": "cursor", "GROK-4.6": "other" }, default: "other" })!;
  // 表命中（大小写不敏感）。
  assert.equal(resolveQuotaBucket("composer-2.5", table), "cursor");
  assert.equal(resolveQuotaBucket("Grok-4.6", table), "other");
  // 表查不到：vendor 推断兜底。
  assert.equal(resolveQuotaBucket("unknown-model", table, { isCursor: true }), "cursor");
  assert.equal(resolveQuotaBucket("unknown-model", table, { isCursor: false }), "other");
  // vendor 也推断不出（SDK 目录没有 vendor / 目录没拉到）：保守走 default。
  assert.equal(resolveQuotaBucket("unknown-model", table), "other");
  assert.equal(resolveQuotaBucket(undefined, table), "other");
  // default 配成 cursor 时同样生效。
  const cursorDefault = parseQuotaBucketTable({ models: {}, default: "cursor" })!;
  assert.equal(resolveQuotaBucket("anything", cursorDefault), "cursor");
});

test("parseQuotaBucketTable drops invalid model entries and rejects broken tables", () => {
  // 单条非法的模型项丢弃，其余保留。
  const partial = parseQuotaBucketTable({ models: { ok: "cursor", bad: "nope", "": "other" }, default: "other" })!;
  assert.deepEqual(partial.models, { ok: "cursor" });
  // default 非法回落 other（保守）。
  assert.equal(parseQuotaBucketTable({ models: {}, default: "wat" })?.default, "other");
  // 整张非法 → undefined，由调用方决定 400 / 兜底。
  assert.equal(parseQuotaBucketTable(undefined), undefined);
  assert.equal(parseQuotaBucketTable("nope"), undefined);
  assert.equal(parseQuotaBucketTable({ models: ["array"] }), undefined);
});

test("bucketExhausted and pruneExhaustedBuckets treat expiry as recovery", () => {
  const now = Date.now();
  const live = { cursor: new Date(now + 60_000).toISOString() };
  const expired = { cursor: new Date(now - 60_000).toISOString() };
  assert.equal(bucketExhausted(live, "cursor", now), true);
  assert.equal(bucketExhausted(expired, "cursor", now), false, "到期即视为未耗尽");
  assert.equal(bucketExhausted(undefined, "cursor", now), false);

  // 无可剔 → 原引用（调用方据此免掉一次写库）。
  assert.equal(pruneExhaustedBuckets(live, now), live);
  assert.equal(pruneExhaustedBuckets(undefined, now), undefined);
  // 全剔完 → undefined；部分剔完 → 新对象。
  assert.equal(pruneExhaustedBuckets(expired, now), undefined);
  const mixed = { cursor: expired.cursor, other: live.cursor };
  const pruned = pruneExhaustedBuckets(mixed, now)!;
  assert.deepEqual(pruned, { other: live.cursor });
  assert.notEqual(pruned, mixed);
});

test("ModelQuotaBucketStore falls back on missing or broken files and round-trips saves", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-buckets-"));
  const path = join(dir, "model-quota-buckets.json");
  const store = new ModelQuotaBucketStore(path);
  // 文件缺失 → 兜底表（全 other）。
  assert.equal(store.load(), DEFAULT_QUOTA_BUCKET_TABLE);
  // 进程内缓存：坏文件写盘后也不会被再读（save 刷缓存、load 命中缓存）。
  const saved = store.save(parseQuotaBucketTable({ models: { composer: "cursor" }, default: "other" })!);
  assert.equal(saved.models.composer, "cursor");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { models: { composer: "cursor" }, default: "other" });
  // 新实例（无缓存）读坏文件 → 兜底。
  const broken = new ModelQuotaBucketStore(path);
  writeFileSync(path, "{not json", "utf8");
  assert.equal(broken.load(), DEFAULT_QUOTA_BUCKET_TABLE);
});

/* ------------------------------------------------------ key 池：选 key 过滤与恢复 */

async function poolWithKeys(keys: string[]): Promise<{ pool: CursorKeyPool; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  const pool = new CursorKeyPool(store);
  await pool.seedFromEnv(keys);
  return { pool, store };
}

test("a bucket-exhausted key stays active and is skipped only for that bucket", async () => {
  const { pool } = await poolWithKeys(["key-a", "key-b"]);
  const keys = await pool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a")!;
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  assert.equal(await pool.markQuotaBucketExhausted(keyA.id, "cursor", future), true);

  // cursor 桶的请求避开 key-a，选 key-b。
  const cursorPick = await pool.selectKey(new Set(), { quotaBucket: "cursor" });
  assert.ok("key" in cursorPick);
  assert.equal(cursorPick.key.apiKey, "key-b");
  // key 本身仍 active——桶级标记不是禁用。
  assert.equal((await pool.list()).find((key) => key.apiKey === "key-a")?.status, "active");

  // 同一把 key 的 other 桶照常可用；不带桶过滤的选 key 也不受影响。
  const otherPick = await pool.selectKey(new Set(), { quotaBucket: "other" });
  assert.ok("key" in otherPick);
  assert.equal(otherPick.key.apiKey, "key-a");
  const plainPick = await pool.selectKey(new Set(), {});
  assert.ok("key" in plainPick);
  assert.equal(plainPick.key.apiKey, "key-a");
});

test("when the whole pool is exhausted for the bucket, keys are still tried in order", async () => {
  const { pool } = await poolWithKeys(["key-a", "key-b"]);
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  for (const key of await pool.list()) {
    await pool.markQuotaBucketExhausted(key.id, "cursor", future);
  }
  const pick = await pool.selectKey(new Set(), { quotaBucket: "cursor" });
  assert.ok("key" in pick, "全池该桶都耗尽时照常尝试，不能打成无 key 可用");
  assert.equal(pick.key.apiKey, "key-a");
});

test("expired bucket marks are lazily cleared on the next selection", async () => {
  const { pool } = await poolWithKeys(["key-a"]);
  const keyA = (await pool.list())[0];
  const past = new Date(Date.now() - 60_000).toISOString();
  await pool.markQuotaBucketExhausted(keyA.id, "cursor", past);

  const pick = await pool.selectKey(new Set(), { quotaBucket: "cursor" });
  assert.ok("key" in pick);
  assert.equal(pick.key.apiKey, "key-a", "到期即恢复参与候选");
  const after = (await pool.list())[0];
  assert.equal(after.exhaustedBuckets, undefined, "懒清除顺手把过期的标记列清掉");
});

test("recordSuccess clears the recovered bucket's mark and only that mark", async () => {
  const { pool } = await poolWithKeys(["key-a"]);
  const keyA = (await pool.list())[0];
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  await pool.markQuotaBucketExhausted(keyA.id, "cursor", future);
  await pool.markQuotaBucketExhausted(keyA.id, "other", future);

  // other 桶的成功不该误清 cursor 桶的标记。
  await pool.recordSuccess(keyA.id, "other");
  assert.deepEqual((await pool.list())[0].exhaustedBuckets, { cursor: future });

  // cursor 桶成功后清掉它。
  await pool.recordSuccess(keyA.id, "cursor");
  assert.equal((await pool.list())[0].exhaustedBuckets, undefined);

  // 不带桶（未接线的旧装配）：一次成功全清。
  await pool.markQuotaBucketExhausted(keyA.id, "cursor", future);
  await pool.markQuotaBucketExhausted(keyA.id, "other", future);
  await pool.recordSuccess(keyA.id);
  assert.equal((await pool.list())[0].exhaustedBuckets, undefined);
});

test("clearQuotaBuckets only touches the bucket marks, not the disable state", async () => {
  const { pool } = await poolWithKeys(["key-a"]);
  const keyA = (await pool.list())[0];
  await pool.reportFailure(keyA.id, "auth", "Invalid API key provided");
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  await pool.markQuotaBucketExhausted(keyA.id, "cursor", future);

  assert.equal(await pool.clearQuotaBuckets(keyA.id), true);
  const after = (await pool.list())[0];
  assert.equal(after.exhaustedBuckets, undefined);
  assert.equal(after.status, "active");
  assert.equal(after.failureCount, 1, "失败计数是人工 enable 的语义，不该被顺手清掉");
});

/* ------------------------------------------------------ key 池：quota 立即禁用 */

test("a quota failure disables the key immediately while auth still waits for the threshold", async () => {
  const { pool } = await poolWithKeys(["key-a", "key-b"]);
  const keys = await pool.list();
  const keyA = keys.find((key) => key.apiKey === "key-a")!;
  const keyB = keys.find((key) => key.apiKey === "key-b")!;

  await pool.reportFailure(keyA.id, "quota", "You have hit your usage limit.");
  const afterQuota = (await pool.list()).find((key) => key.apiKey === "key-a")!;
  assert.equal(afterQuota.status, "disabled", "quota 一次即禁，不看阈值");
  assert.equal(afterQuota.disabledReason, "额度不足");

  await pool.reportFailure(keyB.id, "auth", "Invalid API key provided");
  const afterAuth = (await pool.list()).find((key) => key.apiKey === "key-b")!;
  assert.equal(afterAuth.status, "active", "auth 仍按阈值累计（默认 2）");
  assert.equal(afterAuth.failureCount, 1);
});

test("quota immediate disable still respects a disabled auto-disable policy", async () => {
  const store = new MemoryStateStore();
  const pool = new CursorKeyPool(store, { enabled: false });
  await pool.seedFromEnv(["key-a"]);
  const keyA = (await pool.list())[0];
  await pool.reportFailure(keyA.id, "quota", "unpaid invoice");
  assert.equal((await pool.list())[0].status, "active", "后台关掉自动禁用后只轮换不禁用");
});

test("transient wins over quota when both signals are present", () => {
  // upstream_run_failed 的 502 里带着 402 文案：上游只是跑挂了，不能当欠费禁 key。
  const transient = new ApiError("upstream failed with payment required text", 502, "upstream_run_failed");
  assert.equal(classifyKeyFailure(transient), "transient");
  // 真正的 402 才是账号级欠费。
  const quota = new ApiError("unpaid invoice", 402, "insufficient_quota");
  assert.equal(classifyKeyFailure(quota), "quota");
});

/* ------------------------------------------------------ Bot 侧：标记与选凭据 */

function botConfig(): GatewayConfig {
  return { ...loadConfig({}), sqlitePath: ":memory:" };
}

test("bot store marks a bucket, keeps the credential active, and clears it on use", () => {
  const store = CursorBotStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();

  store.markCredentialBucketExhausted(credential.id, "cursor", future, "resource_exhausted");
  const marked = store.credential(credential.id)!;
  assert.equal(marked.status, "active", "桶级标记不是停用");
  assert.deepEqual(marked.exhaustedBuckets, { cursor: future });
  assert.match(marked.lastError ?? "", /resource_exhausted/);

  // 不带桶的成功（目录连通性测试）不动标记。
  store.recordCredentialUse(credential.id);
  assert.deepEqual(store.credential(credential.id)!.exhaustedBuckets, { cursor: future });

  // 该桶一次成功 → 清该桶；顺手清失败计数与错误痕迹（原有行为）。
  store.recordCredentialUse(credential.id, "cursor");
  const cleared = store.credential(credential.id)!;
  assert.equal(cleared.exhaustedBuckets, undefined);
  assert.equal(cleared.failureCount, 0);

  store.markCredentialBucketExhausted(credential.id, "other", future);
  store.clearCredentialQuotaBuckets(credential.id);
  assert.equal(store.credential(credential.id)!.exhaustedBuckets, undefined);
  store.close();
});

test("pickCredential skips the exhausted bucket and falls back when all are exhausted", () => {
  const store = CursorBotStore.open(":memory:");
  const first = store.upsertCredential({ sessionToken: "t1", machineId: "m1", clientVersion: "1" });
  const second = store.upsertCredential({ sessionToken: "t2", machineId: "m2", clientVersion: "1" });
  const service = new CursorBotService({ store, config: botConfig() });
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();

  // fill-first：无标记时最近使用的优先；这里都没用过，取第一把。
  store.markCredentialBucketExhausted(first.id, "cursor", future);
  assert.equal(service.pickCredential("composer-2.5", "cursor").id, second.id, "cursor 桶的请求避开被标记的凭据");
  assert.equal(service.pickCredential("grok-4.6", "other").id, first.id, "other 桶照常用它");

  // 全池耗尽 → 照常尝试（宁可试一把也不能直接 503）。
  store.markCredentialBucketExhausted(second.id, "cursor", future);
  assert.equal(service.pickCredential("composer-2.5", "cursor").id, first.id);
  store.close();
});

test("bot noteFailure marks the bucket only for upstream resource_exhausted frames", async () => {
  const store = CursorBotStore.open(":memory:");
  const credential = store.upsertCredential({
    sessionToken: "t",
    machineId: "m",
    clientVersion: "1",
    sourceCursorKeyId: "pool-key-1"
  });
  const keys = new MemoryStateStore();
  const keyPool = new CursorKeyPool(keys);
  await keyPool.seedFromEnv(["pool-key-value"]);
  const poolKey = (await keyPool.list())[0];
  // 让 bot 凭据真的指向这把池内 key，联动才能标到它。
  store.upsertCredential({ id: credential.id, machineId: "m", clientVersion: "1", sourceCursorKeyId: poolKey.id });
  const table = new ModelQuotaBucketStore(join(mkdtempSync(join(tmpdir(), "quota-buckets-")), "model-quota-buckets.json"));
  const sync = new QuotaBucketSync({ keyPool, botStore: store, table });
  const service = new CursorBotService({ store, config: botConfig(), quotaBuckets: sync });
  // noteFailure 是私有方法：这里测的就是失败归因这一步，走内部入口比伪造整条网络链路可靠。
  const noteFailure = (service as unknown as {
    noteFailure(credential: BotCredential, error: unknown, model?: string): void;
  }).noteFailure.bind(service);

  // 上游 EndStream 帧带回的 resource_exhausted：标桶（表里没配、无目录缓存 → other 桶），不禁用不计失败。
  noteFailure(credential, endStreamError({ code: "resource_exhausted", message: "You have exceeded your quota." }), "grok-4.6");
  const marked = store.credential(credential.id)!;
  assert.equal(marked.status, "active");
  assert.equal(marked.failureCount, 0);
  assert.ok(marked.exhaustedBuckets?.other, "模型查不到表、无 vendor 提示 → 保守归 other 桶");

  // 双向联动的 bot → key 侧：源 key 的同一个桶一起标上（fire-and-forget，等它跑完）。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const keyAfter = (await keyPool.list())[0];
  assert.equal(keyAfter.status, "active");
  assert.ok(keyAfter.exhaustedBuckets?.other, "bot 凭据撞额度时同步标源 Cursor key");
  assert.equal(keyAfter.disabledReason, undefined);

  // 本地构造的 429（InferenceStreamError 的 RATE_LIMIT / 网关自造）不带上游标记：不标桶。
  store.clearCredentialQuotaBuckets(credential.id);
  noteFailure(credential, new ApiError("rate limited", 429, "rate_limit_exceeded"), "grok-4.6");
  assert.equal(store.credential(credential.id)!.exhaustedBuckets, undefined);

  // 本地 EnvelopeTooLargeError（经 envelopeError 映射成 502）：不标桶也不计失败。
  noteFailure(credential, envelopeError(new EnvelopeTooLargeError(9999, 100))!, "grok-4.6");
  const afterEnvelope = store.credential(credential.id)!;
  assert.equal(afterEnvelope.exhaustedBuckets, undefined);
  assert.equal(afterEnvelope.failureCount, 0);
  assert.equal(isUpstreamResourceExhausted(new EnvelopeTooLargeError(1, 2)), false);
  store.close();
});

test("bot noteFailure on 402 disables the credential and its source key", async () => {
  const store = CursorBotStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const keys = new MemoryStateStore();
  const keyPool = new CursorKeyPool(keys);
  await keyPool.seedFromEnv(["pool-key-value"]);
  const poolKey = (await keyPool.list())[0];
  // 让 bot 凭据真的指向这把池内 key，联动才能禁到它。
  store.upsertCredential({ id: credential.id, machineId: "m", clientVersion: "1", sourceCursorKeyId: poolKey.id });
  // noteFailure 拿的是选路时读出的凭据行（生产路径里带着 sourceCursorKeyId）：重读一次再传入。
  const linked = store.credential(credential.id)!;
  const table = new ModelQuotaBucketStore(join(mkdtempSync(join(tmpdir(), "quota-buckets-")), "model-quota-buckets.json"));
  const sync = new QuotaBucketSync({ keyPool, botStore: store, table });
  const service = new CursorBotService({ store, config: botConfig(), quotaBuckets: sync });
  const noteFailure = (service as unknown as {
    noteFailure(credential: BotCredential, error: unknown, model?: string): void;
  }).noteFailure.bind(service);

  // Connect HTTP 层的 402（httpTransportError 原样透传状态码到 ApiError.statusCode）：
  // 账号级欠费，语义对齐 key-pool 的 quota 失败——一次即禁用，不等阈值累计。
  noteFailure(linked, httpTransportError(402, "unpaid invoice"), "grok-4.6");
  const after = store.credential(credential.id)!;
  assert.equal(after.status, "disabled", "402 是账号级欠费：凭据一次即禁用");
  assert.ok(after.failureCount >= 1, "失败痕迹照记，供后台排查");

  // 联动禁用源 key（fire-and-forget，等微任务跑完）。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const keyAfter = (await keyPool.list())[0];
  assert.equal(keyAfter.status, "disabled", "同账号的源 Cursor key 一起禁用");
  assert.equal(keyAfter.disabledReason, "额度不足");
  store.close();
});

test("marking a key's bucket from the pool side propagates to its bot credentials", async () => {
  const store = CursorBotStore.open(":memory:");
  const credential = store.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1" });
  const keys = new MemoryStateStore();
  const keyPool = new CursorKeyPool(keys);
  await keyPool.seedFromEnv(["pool-key-value"]);
  const poolKey = (await keyPool.list())[0];
  store.upsertCredential({ id: credential.id, machineId: "m", clientVersion: "1", sourceCursorKeyId: poolKey.id });
  const table = new ModelQuotaBucketStore(join(mkdtempSync(join(tmpdir(), "quota-buckets-")), "model-quota-buckets.json"));
  const sync = new QuotaBucketSync({ keyPool, botStore: store, table });

  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  assert.equal(await sync.markKeyBucket(poolKey.id, "cursor", future), true);
  const keyAfter = (await keyPool.list())[0];
  assert.deepEqual(keyAfter.exhaustedBuckets, { cursor: future });
  assert.equal(keyAfter.status, "active");
  const credentialAfter = store.credential(credential.id)!;
  assert.deepEqual(credentialAfter.exhaustedBuckets, { cursor: future }, "key 侧标桶同步标到兑换出的 bot 凭据");
  assert.equal(credentialAfter.status, "active");

  // 后台清除：两侧一起清。
  assert.equal(await sync.clearKeyBuckets(poolKey.id), true);
  assert.equal((await keyPool.list())[0].exhaustedBuckets, undefined);
  assert.equal(store.credential(credential.id)!.exhaustedBuckets, undefined);
  store.close();
});

/* ------------------------------------------- SDK 路线：标桶联动与选桶传递 */

function poolRequest(model: string) {
  return {
    protocol: "openai-chat" as const,
    apiKey: "",
    useKeyPool: true,
    model,
    prompt: "hello",
    sessionKey: "session",
    stream: false,
    workingDirectory: "/workspace",
    images: [],
    tools: []
  };
}

test("an SDK-route quota failure marks the bucket and propagates to bot credentials", async () => {
  const keys = new MemoryStateStore();
  const keyPool = new CursorKeyPool(keys);
  await keyPool.seedFromEnv(["key-a"]);
  const poolKey = (await keyPool.list())[0];
  const botStore = CursorBotStore.open(":memory:");
  botStore.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1", sourceCursorKeyId: poolKey.id });
  const table = new ModelQuotaBucketStore(join(mkdtempSync(join(tmpdir(), "quota-buckets-")), "model-quota-buckets.json"));
  const sync = new QuotaBucketSync({ keyPool, botStore, table });

  const inner: CursorRunner = {
    run: async () => {
      throw httpTransportError(402, "unpaid invoice");
    },
    stream: async function* () {
      throw httpTransportError(402, "unpaid invoice");
    }
  };
  const rotating = new KeyRotatingRunner(inner, keyPool, {
    resolveQuotaBucket: () => "cursor",
    markKeyBucket: (keyId, bucket, expiresAt) => sync.markKeyBucket(keyId, bucket, expiresAt)
  });
  // 只有一把 key：quota 失败禁掉它之后无 key 可选，请求以失败收场。
  await assert.rejects(rotating.run(poolRequest("composer-2.5")));

  const keyAfter = (await keyPool.list())[0];
  assert.ok(keyAfter.exhaustedBuckets?.cursor, "SDK 侧 quota 失败把该桶标耗尽");
  assert.equal(keyAfter.status, "disabled", "key 本身仍按 quota 语义整把禁用");
  const credential = botStore.credentialBySourceKeyId(poolKey.id)!;
  assert.ok(credential.exhaustedBuckets?.cursor, "联动标到同账号的 bot 凭据（§3.6 第 8 条）");
  assert.equal(credential.status, "active", "凭据只被标桶不禁用——整把禁用的联动只在 bot 侧 402 入口触发");
  botStore.close();
});

test("KeyRotatingRunner passes the resolved quota bucket into key selection", async () => {
  const { pool } = await poolWithKeys(["key-a", "key-b"]);
  const keyA = (await pool.list()).find((key) => key.apiKey === "key-a")!;
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  await pool.markQuotaBucketExhausted(keyA.id, "cursor", future);

  const seen: string[] = [];
  const inner: CursorRunner = {
    run: async (input) => {
      seen.push(input.apiKey);
      return { text: "ok", toolCalls: [] };
    },
    stream: async function* (input) {
      seen.push(input.apiKey);
      yield { type: "done", result: { text: "ok", toolCalls: [] } } as const;
    }
  };
  const rotating = new KeyRotatingRunner(inner, pool, { resolveQuotaBucket: () => "cursor" });
  const result = await rotating.run(poolRequest("composer-2.5"));
  assert.equal(result.text, "ok");
  assert.deepEqual(seen, ["key-b"], "runner 把解析出的桶传进 selectKey，该桶已耗尽的 key-a 被避开");
});

/* ------------------------------------------------------ admin 端点 */

function adminConfig(): GatewayConfig {
  return {
    ...loadConfig({}),
    sqlitePath: ":memory:",
    gatewayApiKey: "gateway-key",
    adminPassword: "gateway-key"
  };
}

const dummyRunner: CursorRunner = {
  run: async () => ({ text: "", toolCalls: [] }),
  stream: async function* () {
    // 这里的用例只打 admin 端点，不会真的走到推理；给一个合法的空流即可。
    yield { type: "done", result: { text: "", toolCalls: [] } } as const;
  }
};

async function adminApp(options: { quotaBuckets?: ModelQuotaBucketStore; botQuotaSync?: boolean } = {}) {
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["key-a"]);
  const config = adminConfig();
  // 带 botStore 的协调器装配：后台「清除额度标记」经它把 key 与兑换出的 bot 凭据一起清。
  const botStore = options.botQuotaSync ? CursorBotStore.open(":memory:") : undefined;
  const quotaBucketSync = botStore
    ? new QuotaBucketSync({
        keyPool,
        botStore,
        table: options.quotaBuckets ?? new ModelQuotaBucketStore(join(mkdtempSync(join(tmpdir(), "quota-buckets-")), "model-quota-buckets.json"))
      })
    : undefined;
  const app = createApp({
    config,
    store,
    runner: dummyRunner,
    keyPool,
    ...(options.quotaBuckets ? { quotaBuckets: options.quotaBuckets } : {}),
    ...(quotaBucketSync ? { quotaBucketSync } : {})
  });
  return { app, keyPool, botStore };
}

test("admin can clear a key's quota marks and sees them in the key list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-buckets-"));
  const { app, keyPool, botStore } = await adminApp({
    quotaBuckets: new ModelQuotaBucketStore(join(dir, "model-quota-buckets.json")),
    botQuotaSync: true
  });
  const headers = { authorization: "Bearer gateway-key" };
  const keyA = (await keyPool.list())[0];
  const future = new Date(Date.now() + DEFAULT_QUOTA_BUCKET_RESET_MS).toISOString();
  await keyPool.markQuotaBucketExhausted(keyA.id, "cursor", future);
  // 由这把 key 兑换出的 bot 凭据也带上同桶标记：清除时必须两侧一起清（协调器复用路径）。
  botStore!.upsertCredential({ sessionToken: "t", machineId: "m", clientVersion: "1", sourceCursorKeyId: keyA.id });
  const credential = botStore!.credentialBySourceKeyId(keyA.id)!;
  botStore!.markCredentialBucketExhausted(credential.id, "cursor", future);

  const listed = await app.inject({ method: "GET", url: "/admin/api/keys", headers });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().keys[0].exhaustedBuckets, { cursor: future }, "publicKey 回显额度桶标记");

  const cleared = await app.inject({ method: "POST", url: `/admin/api/keys/${keyA.id}/clear-quota`, headers });
  assert.equal(cleared.statusCode, 200);
  assert.equal((await keyPool.list())[0].exhaustedBuckets, undefined);
  assert.equal(botStore!.credential(credential.id)!.exhaustedBuckets, undefined, "bot 凭据的同桶标记一起清");

  const missing = await app.inject({ method: "POST", url: "/admin/api/keys/no-such-key/clear-quota", headers });
  assert.equal(missing.statusCode, 404);
  botStore!.close();
});

test("admin quota-buckets endpoints validate, persist, and report availability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-buckets-"));
  const path = join(dir, "model-quota-buckets.json");
  const { app } = await adminApp({ quotaBuckets: new ModelQuotaBucketStore(path) });
  const headers = { authorization: "Bearer gateway-key" };

  const initial = await app.inject({ method: "GET", url: "/admin/api/quota-buckets", headers });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().table, { models: {}, default: "other" });

  const saved = await app.inject({
    method: "PUT",
    url: "/admin/api/quota-buckets",
    headers,
    payload: { table: { models: { "composer-2.5": "cursor", "claude-fable-5": "other" }, default: "other" } }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().table.models["composer-2.5"], "cursor");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).default, "other", "保存真的落盘");

  const bad = await app.inject({
    method: "PUT",
    url: "/admin/api/quota-buckets",
    headers,
    payload: { table: { models: "not-an-object", default: "other" } }
  });
  assert.equal(bad.statusCode, 400);

  // 未装配（测试装配 / 旧部署不传 quotaBuckets）时明确 503，而不是把兜底表当已保存内容回写。
  const bare = await adminApp();
  const unavailable = await bare.app.inject({ method: "GET", url: "/admin/api/quota-buckets", headers });
  assert.equal(unavailable.statusCode, 503);
});
