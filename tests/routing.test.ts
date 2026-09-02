import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CursorKeyPool } from "../src/key-pool.js";
import type { KeySelection, NoKeyReason, RoutingPolicy } from "../src/key-pool.js";
import { applyModelScope } from "../src/models.js";
import {
  conversationSeed,
  denyRuleUnverifiable,
  filterModelsByScope,
  identityAllowed,
  intersectScopes,
  modelAllowed,
  modelIdentity,
  normalizeModelList,
  NO_MODEL_SENTINEL,
  pickWeighted,
  sessionBindingHash
} from "../src/routing.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorKeyRecord } from "../src/types.js";

test("modelAllowed treats an empty scope as unrestricted", () => {
  assert.equal(modelAllowed("composer-2.5", undefined), true);
  assert.equal(modelAllowed("composer-2.5", { allowed: [], excluded: [] }), true);
});

test("modelAllowed denies excluded models and enforces a non-empty whitelist", () => {
  assert.equal(modelAllowed("gpt-5", { allowed: [], excluded: ["gpt-5"] }), false);
  assert.equal(modelAllowed("composer-2.5", { allowed: [], excluded: ["gpt-5"] }), true);
  assert.equal(modelAllowed("composer-2.5", { allowed: ["composer-2.5"], excluded: [] }), true);
  assert.equal(modelAllowed("gpt-5", { allowed: ["composer-2.5"], excluded: [] }), false);
});

test("modelAllowed lets deny win when a model is in both lists", () => {
  assert.equal(modelAllowed("gpt-5", { allowed: ["gpt-5"], excluded: ["gpt-5"] }), false);
});

test("modelAllowed compares case-insensitively and ignores surrounding whitespace", () => {
  assert.equal(modelAllowed("  GPT-5  ", { allowed: [], excluded: ["gpt-5"] }), false);
  assert.equal(modelAllowed("gpt-5", { allowed: [], excluded: ["  GPT-5 "] }), false);
  assert.equal(modelAllowed("Composer-2.5", { allowed: ["composer-2.5"], excluded: [] }), true);
});

test("modelIdentity collects every name the requested model answers to", () => {
  const identity = modelIdentity("Fable", { id: "claude-fable-5", aliases: ["fable", " FABLE-5 "] });
  assert.equal(identity.requested, "fable");
  assert.deepEqual(identity.names, ["fable", "claude-fable-5", "fable-5"]);
  assert.equal(identity.confirmed, true);

  // 目录查不到就只认请求名——认得少只会让匹配更严，但必须如实标出来。
  assert.deepEqual(modelIdentity("  GPT-5  ").names, ["gpt-5"]);
  assert.equal(modelIdentity("gpt-5").confirmed, false);
  assert.deepEqual(modelIdentity("").names, []);
});

test("static aliases fold without any catalogue so a deny rule still matches", () => {
  // 这张表不需要网络，别名折叠没有任何理由跟着目录一起失效。
  const byAlias = modelIdentity("composer-latest");
  assert.equal(byAlias.confirmed, false, "静态别名不是目录确认");
  assert.deepEqual(byAlias.names, ["composer-latest", "composer-2.5", "composer", "composer-2-5", "composer-2.5-sdk"]);
  assert.equal(identityAllowed(byAlias, { allowed: [], excluded: ["composer-2.5"] }), false);
  assert.equal(identityAllowed(byAlias, { allowed: ["composer-2.5"], excluded: [] }), true);

  // 反向同样成立：黑名单写别名、请求写 canonical id。
  assert.equal(identityAllowed(modelIdentity("composer-2.5"), { allowed: [], excluded: ["composer-latest"] }), false);
});

test("an unresolved identity leaves a deny rule unevaluated instead of satisfied", () => {
  const unresolved = modelIdentity("fable");

  // 白名单方向：少认几个叫法只会更严，降级是安全的，不需要额外兜底。
  const allowOnly = { allowed: ["claude-fable-5"], excluded: [] };
  assert.equal(identityAllowed(unresolved, allowOnly), false);
  assert.equal(denyRuleUnverifiable(unresolved, allowOnly), false);

  // 黑名单方向：identityAllowed 只能回答「没命中」，而这里的「没命中」不等于「没违规」——
  // 黑名单写 canonical id、请求写别名、目录又没确认过身份，正是那条绕过的形状。
  const denyCanonical = { allowed: [], excluded: ["claude-fable-5"] };
  assert.equal(identityAllowed(unresolved, denyCanonical), true, "光看这一层就会放行");
  assert.equal(denyRuleUnverifiable(unresolved, denyCanonical), true, "所以必须有第二个信号让调用方拒绝");

  // 目录确认过身份之后，同一条黑名单就能真正求值，也不再需要兜底。
  const resolved = modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable"] });
  assert.equal(identityAllowed(resolved, denyCanonical), false);
  assert.equal(denyRuleUnverifiable(resolved, denyCanonical), false);

  // 没有黑名单就没有算不准的东西，不能把整片范围都拖成不可用。
  assert.equal(denyRuleUnverifiable(unresolved, { allowed: [], excluded: [] }), false);
  assert.equal(denyRuleUnverifiable(unresolved, undefined), false);
});

test("identityAllowed matches a scope that only names the id against an alias request", () => {
  const identity = modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable", "fable-5"] });
  // 这就是别名绕过黑名单的洞：黑名单写 canonical id，请求写别名。
  assert.equal(identityAllowed(identity, { allowed: [], excluded: ["claude-fable-5"] }), false);
  // 反向的误拒同样要修：白名单只写 id 时别名请求应当放行。
  assert.equal(identityAllowed(identity, { allowed: ["claude-fable-5"], excluded: [] }), true);

  // 黑名单写别名、请求写 id 也要拦得住。
  const byId = modelIdentity("claude-fable-5", { id: "claude-fable-5", aliases: ["fable"] });
  assert.equal(identityAllowed(byId, { allowed: [], excluded: ["fable"] }), false);
  assert.equal(identityAllowed(byId, { allowed: ["fable"], excluded: [] }), true);
});

test("identityAllowed never loosens a scope when the catalogue could not resolve the model", () => {
  const unresolved = modelIdentity("fable");
  assert.equal(identityAllowed(unresolved, { allowed: ["claude-fable-5"], excluded: [] }), false);
  assert.equal(identityAllowed(unresolved, { allowed: [], excluded: ["fable"] }), false);
  assert.equal(identityAllowed(unresolved, { allowed: [], excluded: [] }), true);
  // 名字对得上就照常判，「没确认」只影响黑名单能不能求值，不该让匹配本身失灵。
  assert.equal(denyRuleUnverifiable(unresolved, { allowed: [], excluded: ["fable"] }), true);
});

test("intersectScopes unions exclusions and keeps the other side when one is unrestricted", () => {
  const scope = intersectScopes(
    { allowed: [], excluded: ["gpt-5"] },
    { allowed: ["composer-2.5", "claude-4"], excluded: ["o3"] }
  );
  assert.deepEqual(scope.allowed, ["composer-2.5", "claude-4"]);
  assert.deepEqual(scope.excluded, ["gpt-5", "o3"]);

  const mirrored = intersectScopes({ allowed: ["composer-2.5"], excluded: [] }, { allowed: [], excluded: [] });
  assert.deepEqual(mirrored.allowed, ["composer-2.5"]);
  assert.deepEqual(mirrored.excluded, []);
});

test("intersectScopes intersects two whitelists", () => {
  const scope = intersectScopes(
    { allowed: ["composer-2.5", "gpt-5"], excluded: [] },
    { allowed: ["GPT-5", "claude-4"], excluded: [] }
  );
  assert.deepEqual(scope.allowed, ["gpt-5"]);
  assert.equal(modelAllowed("gpt-5", scope), true);
  assert.equal(modelAllowed("composer-2.5", scope), false);
});

test("intersectScopes keeps two spellings of the same model instead of denying it", () => {
  const identity = modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable", "fable-5"] });
  const gateway = { allowed: ["claude-fable-5"], excluded: [] };
  const key = { allowed: ["fable"], excluded: [] };

  // 两侧写的是同一个模型的两种叫法，按字符串求交会落空 → 误拒。
  assert.equal(identityAllowed(identity, intersectScopes(gateway, key)), false);
  assert.equal(identityAllowed(identity, intersectScopes(gateway, key, identity)), true);

  // 放宽只作用于白名单：一侧把它列进黑名单就还是拒。
  const denied = intersectScopes(gateway, { allowed: ["fable"], excluded: ["fable-5"] }, identity);
  assert.equal(identityAllowed(identity, denied), false);

  // 真正不相交的白名单不会因为带了身份就被放行。
  const disjoint = intersectScopes(gateway, { allowed: ["gpt-5"], excluded: [] }, identity);
  assert.deepEqual(disjoint.allowed, [NO_MODEL_SENTINEL]);
  assert.equal(identityAllowed(identity, disjoint), false);
});

test("intersectScopes denies everything when the whitelists are disjoint", () => {
  // 空 allowed 表示「不限制」，所以交集落空绝不能编码成空数组，否则可见范围会被放大成全部模型。
  const scope = intersectScopes({ allowed: ["composer-2.5"], excluded: [] }, { allowed: ["gpt-5"], excluded: [] });
  assert.equal(scope.allowed.length, 1);
  assert.equal(modelAllowed("composer-2.5", scope), false);
  assert.equal(modelAllowed("gpt-5", scope), false);
});

test("normalizeModelList trims, drops blanks and dedupes case-insensitively", () => {
  assert.deepEqual(normalizeModelList(["  GPT-5 ", "gpt-5", "", "   ", "composer-2.5", 7]), ["GPT-5", "composer-2.5"]);
  assert.deepEqual(normalizeModelList("gpt-5, composer-2.5\n gpt-5 "), ["gpt-5", "composer-2.5"]);
  assert.deepEqual(normalizeModelList(undefined), []);
});

test("pickWeighted alternates evenly weighted candidates", () => {
  const candidates = [{ id: "a", weight: 1 }, { id: "b", weight: 1 }];
  const picked = [0, 1, 2, 3].map((cursor) => pickWeighted(candidates, cursor)?.id);
  assert.deepEqual(picked, ["a", "b", "a", "b"]);
});

test("pickWeighted honours a 3:1 weight split over one full cycle", () => {
  const candidates = [{ id: "a", weight: 3 }, { id: "b", weight: 1 }];
  const picked = [0, 1, 2, 3].map((cursor) => pickWeighted(candidates, cursor)?.id);
  assert.deepEqual(picked, ["a", "a", "a", "b"]);
  // 游标越过一轮后分布保持稳定。
  assert.equal(pickWeighted(candidates, 4)?.id, "a");
  assert.equal(pickWeighted(candidates, 7)?.id, "b");
});

test("pickWeighted always returns the only candidate and never undefined for a non-empty list", () => {
  const single = [{ id: "solo", weight: 5 }];
  for (const cursor of [0, 1, 2, 99]) assert.equal(pickWeighted(single, cursor)?.id, "solo");
  assert.equal(pickWeighted([], 0), undefined);
});

test("pickWeighted treats a non-positive weight as 1", () => {
  const candidates = [{ id: "a", weight: 0 }, { id: "b", weight: 1 }];
  const picked = [0, 1, 2, 3].map((cursor) => pickWeighted(candidates, cursor)?.id);
  assert.deepEqual(picked, ["a", "b", "a", "b"]);
});

test("filterModelsByScope keeps a model whose alias is whitelisted", () => {
  const models = [
    { id: "composer-2.5", aliases: ["composer-latest"] },
    { id: "gpt-5", aliases: [] }
  ];
  const visible = filterModelsByScope(models, { allowed: ["composer-latest"], excluded: [] });
  assert.deepEqual(visible.map((model) => model.id), ["composer-2.5"]);
});

test("filterModelsByScope hides a model whose id is excluded even if an alias would pass", () => {
  const models = [{ id: "composer-2.5", aliases: ["composer-latest"] }];
  const visible = filterModelsByScope(models, { allowed: ["composer-latest"], excluded: ["composer-2.5"] });
  assert.deepEqual(visible, []);
});

test("filterModelsByScope hides a model whose alias is excluded", () => {
  // 黑白名单两侧都按整组叫法匹配：只写别名的黑名单也要能把整条藏掉。
  const models = [{ id: "claude-fable-5", aliases: ["fable"] }, { id: "gpt-5", aliases: [] }];
  const visible = filterModelsByScope(models, { allowed: [], excluded: ["fable"] });
  assert.deepEqual(visible.map((model) => model.id), ["gpt-5"]);
});

test("filterModelsByScope passes everything through when the scope is empty", () => {
  const models = [{ id: "composer-2.5", aliases: [] }, { id: "gpt-5" }];
  assert.equal(filterModelsByScope(models, { allowed: [], excluded: [] }).length, 2);
  assert.equal(filterModelsByScope(models, undefined).length, 2);
});

test("applyModelScope filters the catalogue and preserves its source", () => {
  const result = applyModelScope(
    {
      models: [
        { id: "composer-2.5", name: "Composer", aliases: ["composer-latest"] },
        { id: "gpt-5", name: "GPT-5", aliases: [] }
      ],
      source: "cursor"
    },
    { allowed: [], excluded: ["gpt-5"] }
  );
  assert.deepEqual(result.models.map((model) => model.id), ["composer-2.5"]);
  assert.equal(result.source, "cursor");
});

test("sessionBindingHash is stable, fixed-length and does not leak the session key", () => {
  const hash = sessionBindingHash("owner:conversation-42");
  assert.equal(hash.length, 32);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(hash, sessionBindingHash("owner:conversation-42"));
  assert.notEqual(hash, sessionBindingHash("owner:conversation-43"));
});

test("fill-first selects the lowest sort_order regardless of insertion order", async () => {
  const { pool } = await poolWith([
    makeKey({ id: "b", sortOrder: 2 }),
    makeKey({ id: "a", sortOrder: 1 })
  ]);
  const selection = expectKey(await pool.selectKey(new Set()));
  assert.equal(selection.key.id, "a");
  assert.equal(selection.sticky, false);
  // 重复选择不会漂移：吃满第一个 key 才是保住上游 prompt 缓存的前提。
  assert.equal(expectKey(await pool.selectKey(new Set())).key.id, "a");
});

test("pickActive still works with no options for the model-catalogue call site", async () => {
  const { pool } = await poolWith([makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })]);
  const key = await pool.pickActive(new Set());
  assert.equal(key?.id, "a");
});

test("round-robin rotates across keys and respects weights", async () => {
  const { pool } = await poolWith(
    [makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })],
    { strategy: "round-robin" }
  );
  assert.deepEqual(await pickIds(pool, 4), ["a", "b", "a", "b"]);

  const { pool: weighted } = await poolWith(
    [makeKey({ id: "a", sortOrder: 1, weight: 3 }), makeKey({ id: "b", sortOrder: 2 })],
    { strategy: "round-robin" }
  );
  assert.deepEqual(await pickIds(weighted, 4), ["a", "a", "a", "b"]);
});

test("selection skips keys whose model scope denies the requested model", async () => {
  const { pool } = await poolWith([
    makeKey({ id: "a", sortOrder: 1, modelScope: { allowed: [], excluded: ["gpt-5"] } }),
    makeKey({ id: "b", sortOrder: 2 })
  ]);
  const gpt = modelIdentity("gpt-5", { id: "gpt-5" });
  const composer = modelIdentity("composer-2.5", { id: "composer-2.5" });
  assert.equal(expectKey(await pool.selectKey(new Set(), { model: "gpt-5", modelIdentity: gpt })).key.id, "b");
  assert.equal(expectKey(await pool.selectKey(new Set(), { model: "composer-2.5", modelIdentity: composer })).key.id, "a");
});

test("selection honours a whitelist-only key scope", async () => {
  const { pool } = await poolWith([
    makeKey({ id: "a", sortOrder: 1, modelScope: { allowed: ["claude-4"], excluded: [] } }),
    makeKey({ id: "b", sortOrder: 2 })
  ]);
  assert.equal(expectKey(await pool.selectKey(new Set(), { model: "claude-4" })).key.id, "a");
  assert.equal(expectKey(await pool.selectKey(new Set(), { model: "composer-2.5" })).key.id, "b");
});

test("selection matches a key scope against every name of the requested model", async () => {
  const identity = modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable", "fable-5"] });

  const { pool: denied } = await poolWith([
    makeKey({ id: "a", modelScope: { allowed: [], excluded: ["claude-fable-5"] } })
  ]);
  assert.equal(
    expectReason(await denied.selectKey(new Set(), { model: "fable", modelIdentity: identity })),
    "model-not-allowed"
  );

  const { pool: allowed } = await poolWith([
    makeKey({ id: "a", modelScope: { allowed: ["claude-fable-5"], excluded: [] } })
  ]);
  assert.equal(expectKey(await allowed.selectKey(new Set(), { model: "fable", modelIdentity: identity })).key.id, "a");
});

test("selection applies the gateway key scope on top of the key's own scope", async () => {
  const { pool } = await poolWith([makeKey({ id: "a" })]);
  assert.equal(
    expectReason(await pool.selectKey(new Set(), {
      model: "gpt-5",
      gatewayModelScope: { allowed: [], excluded: ["gpt-5"] }
    })),
    "model-not-allowed"
  );
  // 网关侧只写 canonical id 时，别名请求同样拦得住。
  assert.equal(
    expectReason(await pool.selectKey(new Set(), {
      model: "fable",
      modelIdentity: modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable"] }),
      gatewayModelScope: { allowed: [], excluded: ["claude-fable-5"] }
    })),
    "model-not-allowed"
  );
  // 两侧都不挡时照常选中。
  assert.equal(
    expectKey(await pool.selectKey(new Set(), {
      model: "composer-2.5",
      gatewayModelScope: { allowed: ["composer-2.5"], excluded: [] }
    })).key.id,
    "a"
  );
});

test("borrowing a key to read the catalogue does not distort round-robin", async () => {
  const { pool } = await poolWith(twoKeys(), { strategy: "round-robin" });
  // 读目录是旁路动作，推进游标会让两把等权 key 稳定退化成「目录永远读一把、执行永远打另一把」，
  // 判定依据与执行依据分属两把 key 的目录，两层防御就各看各的数据。
  assert.equal((await pool.pickActive(new Set()))?.id, "a");
  assert.equal((await pool.pickActive(new Set()))?.id, "a");
  assert.deepEqual(await pickIds(pool, 2), ["a", "b"]);
  assert.equal((await pool.pickActive(new Set()))?.id, "a");
});

test("selection refuses rather than guesses when a gateway deny rule cannot be evaluated", async () => {
  const { pool } = await poolWith([makeKey({ id: "a" })]);
  const denyCanonical = { allowed: [], excluded: ["claude-fable-5"] };

  // 入口那道万一被绕开（新增入口忘了校验），第二道防线不能把「查不到」当成「没违规」。
  assert.equal(
    expectReason(await pool.selectKey(new Set(), {
      model: "fable",
      modelIdentity: modelIdentity("fable"),
      gatewayModelScope: denyCanonical
    })),
    "model-unverified"
  );

  // 目录确认过身份就照常按规则判，不会退化成一律拒绝。
  assert.equal(
    expectReason(await pool.selectKey(new Set(), {
      model: "fable",
      modelIdentity: modelIdentity("fable", { id: "claude-fable-5", aliases: ["fable"] }),
      gatewayModelScope: denyCanonical
    })),
    "model-not-allowed"
  );
  assert.equal(
    expectKey(await pool.selectKey(new Set(), {
      model: "composer-2.5",
      modelIdentity: modelIdentity("composer-2.5", { id: "composer-2.5", aliases: [] }),
      gatewayModelScope: denyCanonical
    })).key.id,
    "a"
  );

  // Cursor key 的黑名单是硬限制：目录抖动时不能让别名绕过它。
  const { pool: keyDenies } = await poolWith([makeKey({ id: "a", modelScope: denyCanonical })]);
  assert.equal(
    expectReason(await keyDenies.selectKey(new Set(), { model: "composer-2.5" })),
    "model-unverified"
  );
});

test("a gateway whitelist and a key whitelist naming the same model differently still select a key", async () => {
  const { pool } = await poolWith([makeKey({ id: "a", modelScope: { allowed: ["fable"], excluded: [] } })]);
  const identity = modelIdentity("claude-fable-5", { id: "claude-fable-5", aliases: ["fable", "fable-5"] });
  assert.equal(
    expectKey(await pool.selectKey(new Set(), {
      model: "claude-fable-5",
      modelIdentity: identity,
      gatewayModelScope: { allowed: ["claude-fable-5"], excluded: [] }
    })).key.id,
    "a"
  );
});

test("disjoint gateway and key whitelists deny every model instead of allowing all", async () => {
  const { pool } = await poolWith([makeKey({ id: "a", modelScope: { allowed: ["composer-2.5"], excluded: [] } })]);
  assert.equal(
    expectReason(await pool.selectKey(new Set(), {
      model: "composer-2.5",
      gatewayModelScope: { allowed: ["gpt-5"], excluded: [] }
    })),
    "model-not-allowed"
  );
});

test("a gateway key scope is ignored when the caller asks for no particular model", async () => {
  // /v1/models 借 key 拉目录时不带 model，这一步不该被任何可见范围挡掉。
  const { pool } = await poolWith([makeKey({ id: "a" })]);
  const key = await pool.pickActive(new Set(), { gatewayModelScope: { allowed: ["gpt-5"], excluded: [] } });
  assert.equal(key?.id, "a");
});

test("allowedKeyIds restricts selection to the bound keys", async () => {
  const { pool } = await poolWith([makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })]);
  assert.equal(expectKey(await pool.selectKey(new Set(), { allowedKeyIds: ["b"] })).key.id, "b");
  // 空数组表示不限制，不是「一个都不给」。
  assert.equal(expectKey(await pool.selectKey(new Set(), { allowedKeyIds: [] })).key.id, "a");
});

test("no-key reasons are reported specifically enough to act on", async () => {
  const { pool: empty } = await poolWith([]);
  assert.equal(expectReason(await empty.selectKey(new Set())), "none-configured");

  const { pool: disabled } = await poolWith([makeKey({ id: "a", status: "disabled" })]);
  assert.equal(expectReason(await disabled.selectKey(new Set())), "all-disabled");
  // 绑定是入站密钥的授权边界，绑定目标全被停用时不能退化成可重试的 429。
  assert.equal(
    expectReason(await disabled.selectKey(new Set(), { allowedKeyIds: ["a"] })),
    "not-authorized"
  );

  const { pool: unbound } = await poolWith([makeKey({ id: "a" }), makeKey({ id: "b" })]);
  assert.equal(expectReason(await unbound.selectKey(new Set(), { allowedKeyIds: ["ghost"] })), "not-authorized");

  const { pool: scoped } = await poolWith([makeKey({ id: "a", modelScope: { allowed: [], excluded: ["gpt-5"] } })]);
  assert.equal(expectReason(await scoped.selectKey(new Set(), { model: "gpt-5" })), "model-not-allowed");

  const { pool: tried } = await poolWith([makeKey({ id: "a" })]);
  assert.equal(expectReason(await tried.selectKey(new Set(["a"]))), "exhausted");
});

test("model scoping outranks exhaustion when the key was never a candidate", async () => {
  const { pool } = await poolWith([
    makeKey({ id: "a", sortOrder: 1 }),
    makeKey({ id: "b", sortOrder: 2, modelScope: { allowed: [], excluded: ["gpt-5"] } })
  ]);
  // a 试过并失败，b 本来就不能服务该模型 → 已经真的试过 key，exhausted 才是准确说法。
  assert.equal(expectReason(await pool.selectKey(new Set(["a"]), { model: "gpt-5" })), "exhausted");
});

test("a bound session sticks to its key even when fill-first would pick another", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  const hash = sessionBindingHash("conversation-1");
  await pool.bindSession(hash, "b");
  const selection = expectKey(await pool.selectKey(new Set(), { sessionHash: hash }));
  assert.equal(selection.key.id, "b");
  assert.equal(selection.sticky, true);
  // 没带会话标识的请求不受绑定影响。
  assert.equal(expectKey(await pool.selectKey(new Set())).key.id, "a");
});

test("a stale binding falls through to normal selection and is dropped", async () => {
  const { pool, store } = await poolWith(twoKeys(), { sessionAffinity: true });
  const hash = sessionBindingHash("conversation-2");
  await pool.bindSession(hash, "b");
  await pool.disable("b", "manual");

  const selection = expectKey(await pool.selectKey(new Set(), { sessionHash: hash }));
  assert.equal(selection.key.id, "a");
  assert.equal(selection.sticky, false);
  assert.equal(await store.getSessionBinding(hash, 60_000), undefined);
  assert.equal(store.sessionBindings.has(hash), false);
});

test("a binding pointing at an already-tried key falls through instead of retrying it", async () => {
  const { pool, store } = await poolWith(twoKeys(), { sessionAffinity: true });
  const hash = sessionBindingHash("conversation-3");
  await pool.bindSession(hash, "a");
  const selection = expectKey(await pool.selectKey(new Set(["a"]), { sessionHash: hash }));
  assert.equal(selection.key.id, "b");
  assert.equal(selection.sticky, false);
  assert.equal(store.sessionBindings.has(hash), false);
});

test("an expired binding falls through to normal selection", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true, sessionAffinityTtlMs: 1 });
  const hash = sessionBindingHash("conversation-4");
  await pool.bindSession(hash, "b");
  await delay(20);
  const selection = expectKey(await pool.selectKey(new Set(), { sessionHash: hash }));
  assert.equal(selection.key.id, "a");
  assert.equal(selection.sticky, false);
});

test("session affinity is opt-in: bindSession is a no-op and existing bindings are ignored", async () => {
  // 不传取用策略的池保持旧行为，粘性要由调用方按 config 显式打开。
  const { pool, store } = await poolWith(twoKeys());
  assert.equal(pool.routingPolicy.sessionAffinity, false);

  const hash = sessionBindingHash("conversation-5");
  await pool.bindSession(hash, "b");
  assert.equal(store.sessionBindings.size, 0);

  await store.saveSessionBinding(hash, "b");
  assert.equal(expectKey(await pool.selectKey(new Set(), { sessionHash: hash })).key.id, "a");

  // 打开后同一个池立刻开始认绑定，无需重建。
  pool.setRoutingPolicy({ sessionAffinity: true });
  const selection = expectKey(await pool.selectKey(new Set(), { sessionHash: hash }));
  assert.equal(selection.key.id, "b");
  assert.equal(selection.sticky, true);
});

test("setRoutingPolicy takes effect immediately and rejects unknown strategies", async () => {
  const { pool } = await poolWith([makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })]);
  assert.equal(pool.routingPolicy.strategy, "fill-first");
  assert.equal(expectKey(await pool.selectKey(new Set())).key.id, "a");

  pool.setRoutingPolicy({ strategy: "round-robin" });
  assert.deepEqual(await pickIds(pool, 2), ["a", "b"]);

  const unchanged = pool.setRoutingPolicy({ strategy: "nonsense" as RoutingPolicy["strategy"], sessionAffinityTtlMs: -1 });
  assert.equal(unchanged.strategy, "round-robin");
  assert.equal(unchanged.sessionAffinityTtlMs, pool.routingPolicy.sessionAffinityTtlMs);
});

test("setModelScope and setWeight normalize what the admin panel sends", async () => {
  const { pool } = await poolWith([makeKey({ id: "a" })]);
  assert.equal(await pool.setModelScope("a", { allowed: [" GPT-5 ", "gpt-5", ""], excluded: ["o3"] }), true);
  assert.deepEqual((await pool.get("a"))?.modelScope, { allowed: ["GPT-5"], excluded: ["o3"] });

  assert.equal(await pool.setWeight("a", 0), true);
  assert.equal((await pool.get("a"))?.weight, 1);
  assert.equal(await pool.setWeight("a", 4.7), true);
  assert.equal((await pool.get("a"))?.weight, 4);
});

function twoKeys(): CursorKeyRecord[] {
  return [makeKey({ id: "a", sortOrder: 1 }), makeKey({ id: "b", sortOrder: 2 })];
}

async function poolWith(
  keys: CursorKeyRecord[],
  routing: Partial<RoutingPolicy> = {}
): Promise<{ pool: CursorKeyPool; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  for (const key of keys) await store.insertCursorKey(key);
  return { pool: new CursorKeyPool(store, {}, routing), store };
}

function makeKey(overrides: Partial<CursorKeyRecord> & { id: string }): CursorKeyRecord {
  return {
    apiKey: `key_${overrides.id}`,
    label: overrides.id,
    status: "active",
    source: "manual",
    sortOrder: 1,
    requestCount: 0,
    failureCount: 0,
    clientType: "inherit",
    modelScope: { allowed: [], excluded: [] },
    weight: 1,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

async function pickIds(pool: CursorKeyPool, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(expectKey(await pool.selectKey(new Set())).key.id);
  }
  return ids;
}

function expectKey(selection: KeySelection | { reason: NoKeyReason }): KeySelection {
  if ("key" in selection) return selection;
  assert.fail(`expected a key, got reason "${selection.reason}"`);
}

function expectReason(selection: KeySelection | { reason: NoKeyReason }): NoKeyReason {
  if ("reason" in selection) return selection.reason;
  assert.fail(`expected no key, got "${selection.key.id}"`);
}

test("conversationSeed stays stable as a conversation grows", () => {
  const turn1 = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain closures." }
    ]
  };
  const turn3 = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain closures." },
      { role: "assistant", content: "A closure captures its lexical scope." },
      { role: "user", content: "Now show me an example." },
      { role: "assistant", content: "function counter() { let n = 0; ... }" },
      { role: "user", content: "What about memory leaks?" }
    ]
  };
  const seed = conversationSeed(turn1);
  assert.ok(seed, "a conversation with a user message must be identifiable");
  // 这是整个粘性机制的前提：同一段对话越聊越长，身份也必须不变。
  assert.equal(conversationSeed(turn3), seed);
  // 第一条 user 之后再插入的 system/developer 也不得改 seed，否则续聊补约束会拆槽。
  const laterInstructions = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain closures." },
      { role: "assistant", content: "A closure captures its lexical scope." },
      { role: "developer", content: "Prefer short examples." },
      { role: "system", content: "Stay in the same conversation." },
      { role: "user", content: "Now show me an example." }
    ]
  };
  assert.equal(conversationSeed(laterInstructions), seed);
});

test("conversationSeed separates different conversations and unidentifiable ones", () => {
  const a = conversationSeed({ messages: [{ role: "user", content: "Explain closures." }] });
  const b = conversationSeed({ messages: [{ role: "user", content: "Explain generators." }] });
  assert.ok(a && b);
  assert.notEqual(a, b);

  // 同样的第一条 user 消息、不同的 system → 不同对话。
  const withSystem = conversationSeed({
    messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "Explain closures." }]
  });
  assert.notEqual(withSystem, a);

  // 认不出对话时必须返回 undefined，而不是一个所有请求共享的常量。
  assert.equal(conversationSeed({}), undefined);
  assert.equal(conversationSeed({ messages: [] }), undefined);
  assert.equal(conversationSeed({ messages: [{ role: "system", content: "only system" }] }), undefined);
  assert.equal(conversationSeed(undefined), undefined);
  assert.equal(conversationSeed("not an object"), undefined);
});

test("conversationSeed ignores top-level instruction changes past 50 runes but keeps the full first user message", () => {
  // 说明书只取前 50 rune：长 preamble 尾部的仓库名不得拆成两段对话。
  const preamble = "You are a meticulous coding agent working inside a large monorepo. ".repeat(6);
  const alpha = conversationSeed({ system: `${preamble}Repository: alpha.`, messages: [{ role: "user", content: "Explain closures." }] });
  const beta = conversationSeed({ system: `${preamble}Repository: beta.`, messages: [{ role: "user", content: "Explain closures." }] });
  assert.ok(alpha && beta);
  assert.equal(alpha, beta);

  // 第一条 user 仍是全文：共享模板前缀、实质诉求在尾部时必须分开。
  const task = "Review the attached module and report any correctness issues you find. ".repeat(5);
  const readAlpha = conversationSeed({ messages: [{ role: "user", content: `${task}File: alpha.ts` }] });
  const readBeta = conversationSeed({ messages: [{ role: "user", content: `${task}File: beta.ts` }] });
  assert.ok(readAlpha && readBeta);
  assert.notEqual(readAlpha, readBeta);
});

test("conversationSeed is still a bounded 50-rune instruction prefix, not the whole conversation", () => {
  // 第 51 个码点之后的 system 变化必须同 seed，否则日期/git 行会拆槽。
  const beyondWindow = "x".repeat(50);
  assert.equal(
    conversationSeed({ system: `${beyondWindow}A`, messages: [{ role: "user", content: "hi" }] }),
    conversationSeed({ system: `${beyondWindow}B`, messages: [{ role: "user", content: "hi" }] })
  );
});

test("conversationSeed reads all three protocol body shapes", () => {
  // Anthropic：顶层 system + 内容块数组。
  const anthropic = conversationSeed({
    system: "You are helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "Explain closures." }] }]
  });
  // OpenAI Chat：等价内容应当得到同一个身份，客户端换协议不该丢掉缓存亲和性。
  const chat = conversationSeed({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain closures." }
    ]
  });
  assert.ok(anthropic);
  assert.equal(anthropic, chat);

  // Responses：instructions + 字符串 input。
  const responses = conversationSeed({ instructions: "You are helpful.", input: "Explain closures." });
  assert.equal(responses, chat);

  // Responses：input 为 item 数组。
  const responsesItems = conversationSeed({
    instructions: "You are helpful.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Explain closures." }] }]
  });
  assert.equal(responsesItems, chat);
});

test("conversationSeed includes every effective system instruction", () => {
  const firstSystem = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Use concise answers." },
      { role: "user", content: "Explain closures." }
    ]
  };
  const differentChatSystem = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Use detailed answers." },
      { role: "user", content: "Explain closures." }
    ]
  };
  assert.notEqual(
    conversationSeed(firstSystem),
    conversationSeed(differentChatSystem),
    "later system/developer instructions must not share the first-message key affinity"
  );

  const firstResponsesSystem = {
    instructions: "You are helpful.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Use concise answers." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Explain closures." }] }
    ]
  };
  const differentResponsesSystem = {
    instructions: "You are helpful.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Use detailed answers." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Explain closures." }] }
    ]
  };
  assert.equal(
    conversationSeed(firstResponsesSystem),
    conversationSeed(differentResponsesSystem),
    "Responses L3 ignores developer/system items inside input"
  );
});

test("conversationSeed ignores top-level system on Chat bodies", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "developer", content: "Use concise answers." },
    { role: "user", content: "Explain closures." }
  ];
  const withPersonaA = conversationSeed({ system: "Top-level persona A.", messages }, "openai-chat");
  const withPersonaB = conversationSeed({ system: "Top-level persona B.", messages }, "openai-chat");
  assert.ok(withPersonaA && withPersonaB);
  assert.equal(withPersonaA, withPersonaB);
});

test("conversationSeed matches inferred and explicit protocol on clean shapes", () => {
  const groups = [
    {
      protocol: "openai-chat" as const,
      body: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Explain closures." }
        ]
      }
    },
    {
      protocol: "anthropic-messages" as const,
      body: {
        system: "You are helpful.",
        messages: [{ role: "user", content: "Explain closures." }]
      }
    },
    {
      protocol: "openai-responses" as const,
      body: { instructions: "You are helpful.", input: "Explain closures." }
    }
  ];
  for (const { protocol, body } of groups) {
    const inferred = conversationSeed(body);
    const explicit = conversationSeed(body, protocol);
    assert.ok(inferred && explicit, protocol);
    assert.equal(inferred, explicit, protocol);
  }
});

test("conversationSeed mixes callerScope and treats omitted scope like empty string", () => {
  const body = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain closures." }
    ]
  };
  const scopedA = conversationSeed(body, "openai-chat", "caller-scope-a");
  const scopedB = conversationSeed(body, "openai-chat", "caller-scope-b");
  assert.ok(scopedA && scopedB);
  assert.notEqual(scopedA, scopedB);
  assert.equal(conversationSeed(body), conversationSeed(body, undefined, ""));
});

test("session stickiness only engages when the conversation is identifiable", async () => {
  const { pool } = await poolWith(twoKeys(), { sessionAffinity: true });
  // 没有 sessionHash（调用方认不出对话）时不该写下任何绑定，
  // 否则整个网关会被钉在一把 key 上：轮询失效，出错的 key 再也不会被重试。
  const first = expectKey(await pool.selectKey(new Set()));
  assert.equal(first.sticky, false);
  await pool.bindSession("", first.key.id);

  const other = expectKey(await pool.selectKey(new Set([first.key.id])));
  assert.equal(other.sticky, false, "无会话标识时每次都按策略重新选 key");
  assert.notEqual(other.key.id, first.key.id);
});

