import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS,
  DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS,
  DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS,
  loadConfig,
  shouldUseDurableHub
} from "../src/config.js";
import { durableIdentity, durableSessionId } from "../src/durable-id.js";

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
