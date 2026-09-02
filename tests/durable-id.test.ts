import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS,
  DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS,
  DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS,
  loadConfig,
  shouldUseDurableHub
} from "../src/config.js";
import {
  durableIdentity,
  durableSessionId,
  normalizeExplicitId,
  resolveConversationIdentity
} from "../src/durable-id.js";

test("loadConfig defaults to durable with the session-resume kill switch off", () => {
  const config = loadConfig({});
  assert.equal(config.cursorSdkDisableSessionResume, false);
  assert.equal(config.cursorSdkSessionMode, "durable");
  assert.equal(config.cursorSdkToolHoldTtlMs, DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS);
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

test("durableSessionId mixes apiKey and model so different slots do not collide", () => {
  const headers = { "anthropic-session-id": "same-conversation" };
  const left = durableSessionId({ headers, apiKey: "key-a", model: "composer-2.5" });
  const right = durableSessionId({ headers, apiKey: "key-b", model: "composer-2.5" });
  const otherModel = durableSessionId({ headers, apiKey: "key-a", model: "grok-4" });
  assert.ok(left && right && otherModel);
  assert.notEqual(left, right);
  assert.notEqual(left, otherModel);
});

test("durableSessionId accepts the expanded explicit session headers", () => {
  const keys = {
    apiKey: "k",
    model: "composer-2.5"
  };
  const rows = [
    { headers: { "x-claude-code-session-id": "claude-code-sess-1" } },
    { headers: { "x-session-id": "x-session-id-value-1" } },
    { headers: { "session-id": "session-id-value-1" } },
    { headers: { session_id: "session_id-value-1" } },
    { headers: { conversation_id: "conversation-id-value-1" } },
    { headers: { "x-codex-window-id": "codex-window-1" } },
    { headers: { "x-codex-turn-metadata": JSON.stringify({ prompt_cache_key: "codex-pck-1" }) } },
    { headers: { "x-codex-turn-metadata": JSON.stringify({ window_id: "codex-meta-window-1" }) } }
  ];
  const ids = rows.map((row) => durableSessionId({ ...keys, headers: row.headers }));
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
