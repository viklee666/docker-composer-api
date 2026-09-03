import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  RECENT_DECISION_LIMIT,
  durableTelemetrySnapshot,
  recordDurableCache,
  recordDurableDecision,
  recordIdentitySource,
  resetDurableTelemetry
} from "../src/durable-telemetry.js";

beforeEach(() => {
  resetDurableTelemetry();
});

test("cache hitRatio is cacheRead / (input + cacheRead + cacheWrite)", () => {
  assert.equal(durableTelemetrySnapshot().cache.hitRatio, null);

  recordDurableCache({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 50, outputTokens: 10 });
  const once = durableTelemetrySnapshot();
  assert.equal(once.cache.requests, 1);
  assert.equal(once.cache.hitRatio, 0.25);
  assert.equal(once.cache.outputTokens, 10);

  recordDurableCache({ inputTokens: 0, cacheReadTokens: 150, cacheWriteTokens: 0, outputTokens: 5 });
  const twice = durableTelemetrySnapshot();
  assert.equal(twice.cache.requests, 2);
  assert.equal(twice.cache.inputTokens, 100);
  assert.equal(twice.cache.cacheReadTokens, 200);
  assert.equal(twice.cache.cacheWriteTokens, 50);
  assert.equal(twice.cache.hitRatio, 200 / 350);
});

test("zero cache denominator stays null", () => {
  recordDurableCache({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 });
  assert.equal(durableTelemetrySnapshot().cache.hitRatio, null);
});

test("session ids in recent are truncated to 12 characters", () => {
  recordDurableDecision({
    decision: "create",
    session: "abcdefghijklmnop-rest-of-id",
    kind: "new_user",
    liveSessions: 4
  });
  const snap = durableTelemetrySnapshot();
  assert.equal(snap.recent.length, 1);
  assert.equal(snap.recent[0].session, "abcdefghijkl");
  assert.equal(snap.recent[0].session?.length, 12);
  assert.equal(snap.liveSessions, 4);
  assert.equal(durableTelemetrySnapshot(9).liveSessions, 9);
});

test("the 51st decision drops the oldest", () => {
  assert.equal(RECENT_DECISION_LIMIT, 50);
  for (let i = 0; i < 51; i++) {
    recordDurableDecision({
      decision: i === 0 ? "stateless" : "reuse",
      session: `sess-${String(i).padStart(4, "0")}-xxxxxxxxxx`,
      reason: i === 0 ? "first" : undefined
    });
  }
  const snap = durableTelemetrySnapshot();
  assert.equal(snap.recent.length, 50);
  assert.equal(snap.recent[0].session, "sess-0001-xx");
  assert.equal(snap.recent[0].decision, "reuse");
  assert.equal(snap.recent[49].session, "sess-0050-xx");
  assert.equal(snap.decisions.create, undefined);
  assert.equal(snap.decisions.stateless, 1);
  assert.equal(snap.decisions["stateless:first"], 1);
  assert.equal(snap.decisions.reuse, 50);
});

test("identitySource counters increment per source", () => {
  recordIdentitySource("header");
  recordIdentitySource("header");
  recordIdentitySource("body-field");
  recordIdentitySource("derived-L3");
  recordIdentitySource("none");
  const snap = durableTelemetrySnapshot();
  assert.equal(snap.identitySource.header, 2);
  assert.equal(snap.identitySource["body-field"], 1);
  assert.equal(snap.identitySource["derived-L3"], 1);
  assert.equal(snap.identitySource.none, 1);
});

test("snapshot copies must not mutate process memory", () => {
  recordDurableDecision({ decision: "create", session: "abc" });
  const snap = durableTelemetrySnapshot();
  snap.decisions.create = 99;
  snap.recent.pop();
  snap.identitySource.header = 7;
  const again = durableTelemetrySnapshot();
  assert.equal(again.decisions.create, 1);
  assert.equal(again.recent.length, 1);
  assert.equal(again.identitySource.header, 0);
});
