import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CURSOR_SDK_DELEGATE_HOLD_TTL_MS,
  DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS,
  DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS,
  DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS,
  loadConfig,
  shouldUseDurableHub
} from "../src/config.js";
import {
  claudeSessionHeaderDemoted,
  claudeSessionHeaderTrusted,
  durableAgentId,
  durableIdentity,
  durableSessionId,
  normalizeExplicitId,
  resolveConversationIdentity,
  stableUuid,
  withoutBodyMetadata,
  withoutClaudeSessionHeader
} from "../src/durable-id.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID_SHAPE = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("loadConfig defaults to durable with the session-resume kill switch off", () => {
  const config = loadConfig({});
  assert.equal(config.cursorSdkDisableSessionResume, false);
  assert.equal(config.cursorSdkSessionMode, "durable");
  assert.equal(config.cursorSdkToolHoldTtlMs, DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS);
  assert.equal(config.cursorSdkDelegateHoldTtlMs, DEFAULT_CURSOR_SDK_DELEGATE_HOLD_TTL_MS);
  assert.equal(config.cursorSdkSessionIdleTtlMs, DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS);
  assert.equal(config.cursorSdkMaxLiveSessions, DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS);
  assert.equal(DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS, 900_000);
  assert.equal(DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS, 3_600_000);
  assert.equal(DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS, 256);
  assert.equal(shouldUseDurableHub(config), true);
});

test("kill switch forces sessionMode stateless even when env asks for durable", () => {
  const config = loadConfig({
    CURSOR_SDK_DISABLE_SESSION_RESUME: "true",
    CURSOR_SDK_SESSION_MODE: "durable"
  });
  assert.equal(config.cursorSdkDisableSessionResume, true);
  assert.equal(config.cursorSdkSessionMode, "stateless");
  assert.equal(shouldUseDurableHub(config), false);
});

test("sessionMode durable is honored only when the kill switch is off", () => {
  const config = loadConfig({
    CURSOR_SDK_DISABLE_SESSION_RESUME: "false",
    CURSOR_SDK_SESSION_MODE: "durable",
    CURSOR_SDK_TOOL_HOLD_TTL_MS: "120000",
    CURSOR_SDK_SESSION_IDLE_TTL_MS: "1800000",
    CURSOR_SDK_MAX_LIVE_SESSIONS: "32"
  });
  assert.equal(config.cursorSdkDisableSessionResume, false);
  assert.equal(config.cursorSdkSessionMode, "durable");
  assert.equal(config.cursorSdkToolHoldTtlMs, 120_000);
  assert.equal(config.cursorSdkSessionIdleTtlMs, 1_800_000);
  assert.equal(config.cursorSdkMaxLiveSessions, 32);
  assert.equal(shouldUseDurableHub(config), true);
});

test("explicit SESSION_MODE=stateless stays off the Hub when the kill switch is off", () => {
  const config = loadConfig({
    CURSOR_SDK_DISABLE_SESSION_RESUME: "false",
    CURSOR_SDK_SESSION_MODE: "stateless"
  });
  assert.equal(config.cursorSdkDisableSessionResume, false);
  assert.equal(config.cursorSdkSessionMode, "stateless");
  assert.equal(shouldUseDurableHub(config), false);
  assert.equal(loadConfig({ CURSOR_SDK_DISABLE_SESSION_RESUME: "false" }).cursorSdkSessionMode, "durable");
  assert.equal(loadConfig({ CURSOR_SDK_DISABLE_SESSION_RESUME: "false", CURSOR_SDK_SESSION_MODE: "nope" }).cursorSdkSessionMode, "durable");
});

test("durable TTL env rejects numeric prefixes and empty values", () => {
  const defaults = loadConfig({});
  assert.equal(loadConfig({ CURSOR_SDK_TOOL_HOLD_TTL_MS: "900oops" }).cursorSdkToolHoldTtlMs, defaults.cursorSdkToolHoldTtlMs);
  assert.equal(loadConfig({ CURSOR_SDK_SESSION_IDLE_TTL_MS: "3600oops" }).cursorSdkSessionIdleTtlMs, defaults.cursorSdkSessionIdleTtlMs);
  assert.equal(loadConfig({ CURSOR_SDK_MAX_LIVE_SESSIONS: "32abc" }).cursorSdkMaxLiveSessions, defaults.cursorSdkMaxLiveSessions);
});

test("shouldUseDurableHub ignores a durable mode when the kill switch is still on", () => {
  assert.equal(
    shouldUseDurableHub({ cursorSdkDisableSessionResume: true, cursorSdkSessionMode: "durable" }),
    false
  );
  assert.equal(
    shouldUseDurableHub({ cursorSdkDisableSessionResume: false, cursorSdkSessionMode: "stateless" }),
    false
  );
  assert.equal(
    shouldUseDurableHub({ cursorSdkDisableSessionResume: false, cursorSdkSessionMode: "durable" }),
    true
  );
});

test("durableSessionId is undefined when no conversation identity is present", () => {
  assert.equal(durableSessionId({}), undefined);
  assert.equal(durableSessionId({ apiKey: "k", model: "composer-2.5", workingDirectory: "/w" }), undefined);
  assert.equal(durableSessionId({ headers: {}, body: { messages: [] } }), undefined);
  assert.equal(durableSessionId({ headers: { "anthropic-session-id": "   " } }), undefined);
  assert.equal(durableIdentity({}), undefined);
});

test("durableSessionId is defined when anthropic-session-id is present", () => {
  const id = durableSessionId({
    headers: { "anthropic-session-id": "sess-claude-1" },
    apiKey: "k",
    model: "composer-2.5"
  });
  assert.equal(typeof id, "string");
  assert.ok(id && id.length > 0);
  assert.notEqual(
    id,
    durableSessionId({
      headers: { "anthropic-session-id": "sess-claude-2" },
      apiKey: "k",
      model: "composer-2.5"
    })
  );
});

test("durableSessionId accepts the other explicit session headers", () => {
  const keys = {
    apiKey: "k",
    model: "composer-2.5"
  };
  const a = durableSessionId({ ...keys, headers: { "x-session-affinity": "aff-1" } });
  const b = durableSessionId({ ...keys, headers: { "x-opencode-session-id": "oc-1" } });
  const c = durableSessionId({ ...keys, headers: { "x-opencode-session": "oc-2" } });
  assert.ok(a && b && c);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test("ownerHash or bare sessionKey alone must not become a Hub key", () => {
  const owner = "owner-hash-shared-by-every-gateway-request";
  assert.equal(
    durableSessionId({
      ownerHash: owner,
      sessionKey: owner,
      apiKey: "k",
      model: "composer-2.5",
      workingDirectory: "/w"
    }),
    undefined
  );
  assert.equal(
    durableSessionId({
      sessionKey: "naked-session-key",
      apiKey: "k",
      model: "m"
    }),
    undefined
  );
  assert.equal(durableIdentity({ ownerHash: owner, sessionKey: owner }), undefined);
});

test("conversationSeed or stickyKey is enough for a durable id", () => {
  const fromSeed = durableSessionId({
    conversationSeed: "seed-from-responses",
    apiKey: "k",
    model: "composer-2.5"
  });
  const fromSticky = durableSessionId({
    stickyKey: "owner:seed-from-responses",
    apiKey: "k",
    model: "composer-2.5"
  });
  const fromBody = durableSessionId({
    body: { messages: [{ role: "user", content: "Explain closures." }] },
    apiKey: "k",
    model: "composer-2.5"
  });
  assert.ok(fromSeed && fromSticky && fromBody);
  assert.notEqual(fromSeed, fromSticky);
  assert.notEqual(
    fromBody,
    durableSessionId({
      body: { messages: [{ role: "user", content: "Explain generators." }] },
      apiKey: "k",
      model: "composer-2.5"
    })
  );
});

test("durableSessionId is stable across apiKeys and differs by model", () => {
  const headers = { "anthropic-session-id": "same-conversation" };
  const left = durableSessionId({ headers, apiKey: "key-a", model: "composer-2.5", workingDirectory: "/a" });
  const right = durableSessionId({ headers, apiKey: "key-b", model: "composer-2.5", workingDirectory: "/b" });
  const otherModel = durableSessionId({ headers, apiKey: "key-a", model: "grok-4" });
  assert.ok(left && right && otherModel);
  assert.equal(left, right);
  assert.notEqual(left, otherModel);
});

test("same identity two calls yield the same durableAgentId and durableSessionId", () => {
  const input = {
    headers: { "x-session-id": "same-session" },
    ownerHash: "owner-a",
    model: "composer-2.5",
    apiKey: "k"
  };
  const first = durableSessionId(input);
  const second = durableSessionId(input);
  const agent = durableAgentId({ ownerHash: "owner-a", identity: "same-session", model: "composer-2.5" });
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(first, agent);
  assert.equal(
    durableAgentId({ ownerHash: "owner-a", identity: "same-session", model: "composer-2.5" }),
    agent
  );
});

test("same identity with different apiKey yields the same agentId", () => {
  const identity = "same-conversation";
  const headers = { "anthropic-session-id": identity };
  const ownerHash = "owner-a";
  const model = "composer-2.5";
  const left = durableSessionId({ headers, ownerHash, model, apiKey: "key-a" });
  const right = durableSessionId({ headers, ownerHash, model, apiKey: "key-b" });
  const agent = durableAgentId({ ownerHash, identity, model });
  assert.ok(left);
  assert.equal(left, right);
  assert.equal(left, agent);
});

test("same x-claude-code-session-id with different x-claude-code-agent-id splits identity and agentId", () => {
  const session = "claude-code-parent";
  const model = "composer-2.5";
  const ownerHash = "owner-a";
  const parentHeaders = { "x-claude-code-session-id": session };
  const subA = { ...parentHeaders, "x-claude-code-agent-id": "sub-agent-a" };
  const subB = { ...parentHeaders, "x-claude-code-agent-id": "sub-agent-b" };
  // 真 claude-cli 的头总是与 JSON user_id 成对出现；降权判据要求两者配对才采信头。
  const body = { metadata: { user_id: JSON.stringify({ session_id: session }) } };
  const parentIdentity = durableIdentity({ headers: parentHeaders, body });
  const identityA = durableIdentity({ headers: subA, body });
  const identityB = durableIdentity({ headers: subB, body });
  assert.ok(parentIdentity && identityA && identityB);
  assert.equal(parentIdentity.includes("\0agent:"), false);
  assert.notEqual(identityA, identityB);
  assert.notEqual(identityA, parentIdentity);
  assert.ok(identityA.includes("\0agent:sub-agent-a"));
  assert.ok(identityB.includes("\0agent:sub-agent-b"));
  const idA = durableSessionId({ headers: subA, body, ownerHash, model });
  const idB = durableSessionId({ headers: subB, body, ownerHash, model });
  assert.ok(idA && idB);
  assert.notEqual(idA, idB);
});

test("parent session-id header without agent-id does not contain the agent suffix", () => {
  const identity = durableIdentity({
    headers: { "x-claude-code-session-id": "parent-only" },
    body: { metadata: { user_id: JSON.stringify({ session_id: "parent-only" }) } }
  });
  assert.ok(identity);
  assert.equal(identity.includes("\0agent:"), false);
  // agent-id 头单独出现仍不构成身份（无头无 body → undefined，语义与改造前一致）。
  assert.equal(durableIdentity({ headers: { "x-claude-code-agent-id": "orphan-sub" } }), undefined);
});

test("different ownerHash with the same x-session-id yields different agentId", () => {
  const headers = { "x-session-id": "shared-client-session" };
  const model = "composer-2.5";
  const left = durableSessionId({ headers, ownerHash: "owner-a", model });
  const right = durableSessionId({ headers, ownerHash: "owner-b", model });
  assert.ok(left && right);
  assert.notEqual(left, right);
});

test("stableUuid is RFC 4122 version 4 variant 1", () => {
  const id = stableUuid("any-stable-input");
  assert.match(id, UUID_SHAPE);
  assert.equal(stableUuid("any-stable-input"), id);
  assert.notEqual(stableUuid("other-input"), id);
});

test("durableAgentId is agent- prefixed UUID shape and never uses bc-", () => {
  const id = durableAgentId({ ownerHash: "own", identity: "sess", model: "composer-2.5" });
  assert.match(id, AGENT_ID_SHAPE);
  assert.equal(id.startsWith("agent-"), true);
  assert.equal(id.startsWith("bc-"), false);
  const sessionId = durableSessionId({
    headers: { "x-session-id": "sess" },
    ownerHash: "own",
    model: "composer-2.5"
  });
  assert.equal(sessionId, id);
  assert.ok(sessionId);
  assert.match(sessionId, AGENT_ID_SHAPE);
});

test("durableSessionId accepts the expanded explicit session headers", () => {
  const keys = {
    apiKey: "k",
    model: "composer-2.5"
  };
  const rows = [
    {
      headers: { "x-claude-code-session-id": "claude-code-sess-1" },
      body: { metadata: { user_id: JSON.stringify({ session_id: "claude-code-sess-1" }) } }
    },
    { headers: { "x-session-id": "x-session-id-value-1" } },
    { headers: { "session-id": "session-id-value-1" } },
    { headers: { session_id: "session_id-value-1" } },
    { headers: { conversation_id: "conversation-id-value-1" } },
    { headers: { "x-codex-window-id": "codex-window-1" } },
    { headers: { "x-codex-turn-metadata": JSON.stringify({ prompt_cache_key: "codex-pck-1" }) } },
    { headers: { "x-codex-turn-metadata": JSON.stringify({ window_id: "codex-meta-window-1" }) } }
  ];
  const ids = rows.map((row) => durableSessionId({ ...keys, headers: row.headers, body: row.body }));
  for (const [index, id] of ids.entries()) {
    assert.ok(id, `header row ${index}`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("durableSessionId accepts explicit session fields on the body", () => {
  const keys = {
    apiKey: "k",
    model: "composer-2.5"
  };
  const bodies = [
    { session_id: "body-session-id-1" },
    { sessionId: "body-sessionId-1" },
    { conversation_id: "body-conversation-id-1" },
    { prompt_cache_key: "body-pck-1" },
    { conversation: "body-conversation-string-1" },
    { conversation: { id: "body-conversation-object-1" } },
    { client_metadata: { "x-codex-window-id": "body-codex-window-1" } },
    { metadata: { user_id: JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111" }) } },
    { metadata: { user_id: "claude-user_session_22222222-2222-4222-8222-222222222222" } }
  ];
  const ids = bodies.map((body) => durableSessionId({ ...keys, body }));
  for (const [index, id] of ids.entries()) {
    assert.ok(id, `body row ${index}`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("normalizeExplicitId trims, rejects empty control and oversized values, and keeps a UUID", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const rows: Array<[string, string, string | undefined]> = [
    ["control", "sess\nid", undefined],
    ["trim", "  trimmed-session-id  ", "trimmed-session-id"],
    ["empty", "", undefined],
    ["oversize", "a".repeat(257), undefined],
    ["uuid", uuid, uuid]
  ];
  for (const [name, value, expected] of rows) {
    assert.equal(normalizeExplicitId(value), expected, name);
    assert.equal(durableIdentity({ headers: { "x-session-affinity": value } }), expected, name);
  }
});

test("x-client-request-id alone is not an identity and does not block L3 derive", () => {
  const headers = { "x-client-request-id": "req-every-turn-1" };
  assert.equal(durableIdentity({ headers }), undefined);
  assert.equal(durableSessionId({ headers, apiKey: "k", model: "composer-2.5" }), undefined);

  const body = { messages: [{ role: "user", content: "Explain closures." }] };
  const derived = durableIdentity({ headers, body });
  assert.ok(derived);
  assert.equal(derived, durableIdentity({ body }));
  assert.ok(durableSessionId({ headers, body, apiKey: "k", model: "composer-2.5" }));
});

test("explicit header identity wins over an explicit body field", () => {
  const headers = { "x-session-affinity": "header-session-aaa" };
  const body = { session_id: "body-session-bbb" };
  const both = durableIdentity({ headers, body });
  const headerOnly = durableIdentity({ headers });
  const bodyOnly = durableIdentity({ body });
  assert.ok(both && headerOnly && bodyOnly);
  assert.equal(both, headerOnly);
  assert.notEqual(both, bodyOnly);
});

test("stickyKey equal to ownerHash is not a Hub key while ownerHash still scopes L3 identity", () => {
  const owner = "owner-hash-shared-by-every-gateway-request";
  assert.equal(
    durableSessionId({
      ownerHash: owner,
      stickyKey: owner,
      apiKey: "k",
      model: "composer-2.5",
      workingDirectory: "/w"
    }),
    undefined
  );
  assert.equal(durableIdentity({ ownerHash: owner, stickyKey: owner }), undefined);

  const body = { messages: [{ role: "user", content: "Explain closures." }] };
  const scopedA = durableIdentity({ body, ownerHash: "owner-hash-a" });
  const scopedB = durableIdentity({ body, ownerHash: "owner-hash-b" });
  assert.ok(scopedA && scopedB);
  assert.notEqual(scopedA, scopedB);
});

test("resolveConversationIdentity matches durableIdentity for the same input", () => {
  const inputs = [
    { headers: { "anthropic-session-id": "sess-alias-1" } },
    { body: { messages: [{ role: "user", content: "Explain closures." }] } },
    { conversationSeed: "seed-from-alias" },
    { ownerHash: "owner-only" }
  ];
  for (const input of inputs) {
    assert.equal(resolveConversationIdentity(input), durableIdentity(input));
  }
});

/* ---------------------- x-claude-code-session-id 降权（计划 v2） ---------------------- */

const CPA_HEADER = { "x-claude-code-session-id": "0d349c18-69c3-418c-9623-bfc7acfe9baf" };

test("claudeSessionHeaderTrusted: JSON user_id 与头一致才采信；legacy 一律不信", () => {
  const jsonBody = {
    metadata: {
      user_id: JSON.stringify({
        device_id: "93ab134c9e8236f7678147751d642ba1846b25216dfb76659f00adefbd5a689c",
        account_uuid: "",
        session_id: "0d349c18-69c3-418c-9623-bfc7acfe9baf"
      })
    }
  };
  const jsonObjectBody = { metadata: { user_id: { session_id: "0d349c18-69c3-418c-9623-bfc7acfe9baf" } } };
  const mismatchBody = { metadata: { user_id: JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111" }) } };
  const legacyMatchBody = {
    metadata: {
      user_id: `user_58f2306017dd5a3767e8c494bda78ba73acae18f2aeee4d759b4a7bb08b68d9b_account_750e3a68-3c4a-4184-873f-708173b1dc9a_session_0d349c18-69c3-418c-9623-bfc7acfe9baf`
    }
  };
  const legacyRandomBody = {
    metadata: {
      user_id: `user_c231a63f30e019208334e1a9af47aae3fdd2997ceb821cb21028de8ad0e2fc2c_account_1892a561-dfa1-4b37-a921-31a5d6a953cc_session_3318187c-21d2-4e5f-a9d0-1f3a2b4c5d6e`
    }
  };

  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, jsonBody), true, "JSON 字符串 + 一致 → 采信");
  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, jsonObjectBody), true, "JSON 对象形态 + 一致 → 采信");
  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, mismatchBody), false, "JSON + 不一致 → 降权");
  assert.equal(
    claudeSessionHeaderTrusted(CPA_HEADER, legacyMatchBody),
    false,
    "legacy 即使尾段与头一致也不采信（v1 漏洞：新 CPA cloak 会造出这种一致）"
  );
  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, legacyRandomBody), false, "legacy 随机 → 降权（线上快照形态）");
  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, {}), false, "头孤证（无 metadata）→ 降权");
  assert.equal(claudeSessionHeaderTrusted(CPA_HEADER, undefined), false);
  assert.equal(claudeSessionHeaderTrusted({}, jsonBody), false, "无头谈不上信任");
  assert.equal(claudeSessionHeaderTrusted(undefined, jsonBody), false);
  assert.equal(claudeSessionHeaderDemoted(CPA_HEADER, legacyRandomBody), true);
  assert.equal(claudeSessionHeaderDemoted(CPA_HEADER, jsonBody), false);
  assert.equal(claudeSessionHeaderDemoted({}, jsonBody), false, "没有该头就没有降权");
});

test("durableIdentity 降权：CPA per-key 头 + 随机 user_id → 落 L3，会话按内容区分（修复前同头必串）", () => {
  const ownerHash = "owner-byok-chain";
  const protocol = "anthropic-messages" as const;
  const cpaHeader = { "x-claude-code-session-id": "per-key-constant-from-cpa" };
  const legacyUserA = { user_id: "user_1111111111111111111111111111111111111111111111111111111111111111_account_11111111-1111-4111-8111-111111111111_session_11111111-1111-4111-8111-111111111111" };
  const legacyUserB = { user_id: "user_2222222222222222222222222222222222222222222222222222222222222222_account_22222222-2222-4222-8222-222222222222_session_22222222-2222-4222-8222-222222222222" };
  const bodyA = {
    system: "You are an AI coding assistant, powered by composer2.5.",
    messages: [{ role: "user", content: "workspace request-context + question A" }],
    metadata: legacyUserA
  };
  const bodyB = {
    system: "You are an AI coding assistant, powered by composer2.5.",
    messages: [{ role: "user", content: "workspace request-context + question B" }],
    metadata: legacyUserB
  };

  // 降权后，身份与「无头无 metadata」的同一请求完全一致（头与 user_id 都不参与）。
  const demotedA = durableIdentity({ headers: cpaHeader, body: bodyA, protocol, ownerHash });
  const bareA = durableIdentity({ headers: {}, body: withoutBodyMetadata(bodyA), protocol, ownerHash });
  assert.ok(demotedA);
  assert.equal(demotedA, bareA, "伪装头与随机 user_id 不得影响身份");

  // 两个不同会话（首条 user 不同）→ 不同身份；修复前它们因同头共享同一个 durableAgentId。
  const demotedB = durableIdentity({ headers: cpaHeader, body: bodyB, protocol, ownerHash });
  assert.notEqual(demotedA, demotedB, "不同会话必须分出不同身份");

  // 同一会话续聊（首条 user 不变、追加轮次、user_id 又随机变了一个）→ 身份稳定，durable 保持。
  const bodyA2 = {
    system: bodyA.system,
    messages: [
      { role: "user", content: "workspace request-context + question A" },
      { role: "assistant", content: "answer A" },
      { role: "user", content: "follow up" }
    ],
    metadata: { user_id: "user_3333333333333333333333333333333333333333333333333333333333333333_account_33333333-3333-4333-8333-333333333333_session_33333333-3333-4333-8333-333333333333" }
  };
  assert.equal(durableIdentity({ headers: cpaHeader, body: bodyA2, protocol, ownerHash }), demotedA);
});

test("durableIdentity 采信：真 claude-cli（JSON user_id 与头一致）身份 = 头值，行为不变", () => {
  const session = "0d349c18-69c3-418c-9623-bfc7acfe9baf";
  const body = {
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "hello" }],
    metadata: { user_id: JSON.stringify({ device_id: "a".repeat(64), account_uuid: "", session_id: session }) }
  };
  const identity = durableIdentity({ headers: CPA_HEADER, body, protocol: "anthropic-messages" });
  assert.equal(identity, session);
  assert.equal(claudeSessionHeaderDemoted(CPA_HEADER, body), false);
});

test("durableIdentity 降权不影响其他显式头：x-session-id 照常命中", () => {
  const headers = { ...CPA_HEADER, "x-session-id": "opencode-session-1" };
  const body = {
    messages: [{ role: "user", content: "hello" }],
    metadata: { user_id: "user_legacy_random_session_11111111-1111-4111-8111-111111111111" }
  };
  const identity = durableIdentity({ headers, body, protocol: "anthropic-messages" });
  assert.equal(identity, "opencode-session-1");
});

test("withoutClaudeSessionHeader / withoutBodyMetadata 只剥自己的目标，其余原样保留", () => {
  const headers = { "x-claude-code-session-id": "s", "X-Claude-Code-Session-Id": "s2", "x-session-id": "keep", authorization: "Bearer x" };
  const stripped = withoutClaudeSessionHeader(headers);
  assert.ok(stripped);
  assert.equal("x-claude-code-session-id" in stripped, false);
  assert.equal("X-Claude-Code-Session-Id" in stripped, false, "大小写不敏感剥离");
  assert.equal(stripped["x-session-id"], "keep");
  assert.equal(stripped.authorization, "Bearer x");
  const untouched = withoutClaudeSessionHeader({ "x-session-id": "only" });
  assert.ok(untouched);
  assert.equal(untouched["x-session-id"], "only", "无目标头时原样返回");

  const body = { model: "m", messages: [], metadata: { user_id: "x" }, session_id: "keep-me" };
  const bodyStripped = withoutBodyMetadata(body) as Record<string, unknown>;
  assert.equal("metadata" in bodyStripped, false);
  assert.equal(bodyStripped.session_id, "keep-me");
  assert.equal(bodyStripped.model, "m");
  const noMeta = { messages: [] };
  assert.equal(withoutBodyMetadata(noMeta), noMeta, "无 metadata 时原样返回（同一引用）");
});
