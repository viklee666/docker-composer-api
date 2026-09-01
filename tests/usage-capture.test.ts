import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mergeUsage, parseSdkUsage } from "../src/cursor-runner.js";
import { effectiveUsage } from "../src/protocol.js";
import { MemoryStateStore, SqliteStateStore } from "../src/store.js";
import { closeAppThenDrainUsage, UsageReconciler } from "../src/usage-reconciler.js";
import type { RequestCost, RequestLogRecord, RequestUsage } from "../src/types.js";

const SDK_USAGE: RequestUsage = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 8800,
  cacheWriteTokens: 64,
  totalTokens: 10404,
  reasoningTokens: 96
};

const SDK_COST: RequestCost = { rawCostCents: 1.75, chargedCents: 0 };

test("parseSdkUsage derives totalTokens for a turn-ended payload", () => {
  const usage = parseSdkUsage({
    type: "turn-ended",
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
      reasoningTokens: 12
    }
  });
  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 900,
    cacheWriteTokens: 30,
    // 线上没有 totalTokens：四个桶互斥，合计是四者之和（reasoning 是 output 的子集，不另计）。
    totalTokens: 1095,
    reasoningTokens: 12
  });
});

test("parseSdkUsage keeps the totalTokens reported by the message-level usage event", () => {
  const usage = parseSdkUsage({
    type: "usage",
    agent_id: "agent-1",
    run_id: "run-1",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 18 }
  });
  assert.equal(usage?.totalTokens, 18);
  assert.ok(usage && !("reasoningTokens" in usage));
});

test("parseSdkUsage repairs an inconsistent reported total", () => {
  const usage = parseSdkUsage({
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 99 }
  });
  assert.equal(usage?.totalTokens, 18, "a contradictory total must not reach history or the client");
});

test("parseSdkUsage accepts an already unwrapped token-count object", () => {
  const usage = parseSdkUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  assert.equal(usage?.totalTokens, 10);
});

test("parseSdkUsage returns undefined for garbage, missing and partial payloads", () => {
  const payloads: unknown[] = [
    undefined,
    null,
    42,
    "usage",
    [],
    {},
    { type: "turn-ended" },
    { type: "turn-ended", usage: null },
    { type: "turn-ended", usage: "nope" },
    // 少字段的半份负载不能冒充真实用量：日志里的 usageSource=sdk 是要拿来对账的。
    { type: "turn-ended", usage: { inputTokens: 1, outputTokens: 2 } },
    { type: "usage", usage: { inputTokens: "1", outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    { type: "usage", usage: { inputTokens: Number.NaN, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }
  ];
  for (const payload of payloads) {
    assert.equal(parseSdkUsage(payload), undefined, `expected undefined for ${JSON.stringify(payload) ?? String(payload)}`);
  }
});

test("mergeUsage sums field-wise and keeps reasoningTokens from either side", () => {
  const first: RequestUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10
  };
  const second: RequestUsage = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    reasoningTokens: 7
  };
  assert.deepEqual(mergeUsage(first, second), {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
    totalTokens: 110,
    reasoningTokens: 7
  });
  assert.deepEqual(mergeUsage(second, first), {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
    totalTokens: 110,
    reasoningTokens: 7
  });
});

test("mergeUsage handles undefined sides and never aliases its inputs", () => {
  const usage: RequestUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10
  };
  assert.equal(mergeUsage(undefined, undefined), undefined);
  assert.deepEqual(mergeUsage(undefined, usage), usage);
  assert.deepEqual(mergeUsage(usage, undefined), usage);
  assert.notEqual(mergeUsage(undefined, usage), usage);
  const both = mergeUsage(usage, usage);
  assert.ok(both && !("reasoningTokens" in both));
});

test("usage aggregators repair inconsistent totals at their boundaries", () => {
  const inconsistent: RequestUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 99
  };
  assert.equal(mergeUsage(undefined, inconsistent)?.totalTokens, 10);
  assert.equal(effectiveUsage(inconsistent, 0, 0).totalTokens, 10);
});

test("UsageReconciler backfills usage and cost onto the request log", async () => {
  const store = new MemoryStateStore();
  const perRequestUsage: RequestUsage = {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    totalTokens: 23,
    reasoningTokens: 4
  };
  await store.insertRequestLog(requestLog("log-1", { usage: perRequestUsage, usageSource: "sdk" }));
  const calls: string[][] = [];
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    getUsage: async (agentId, apiKey) => {
      calls.push([agentId, apiKey]);
      return { usage: SDK_USAGE, cost: SDK_COST };
    }
  });

  reconciler.schedule({ logId: "log-1", agentId: "agent-1", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  assert.deepEqual(calls, [["agent-1", "key-1"]]);
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  // Agent.getUsage() 的 usage 是整个 agent 的累计值，不能覆盖请求路径已经捕获的本轮用量。
  assert.deepEqual(log?.usage, perRequestUsage);
  assert.deepEqual(log?.cost, SDK_COST);
  assert.equal(log?.usageSource, "sdk");
});

test("UsageReconciler retries while cost is still eventually consistent", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("log-2"));
  let attempts = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 4,
    getUsage: async () => {
      attempts += 1;
      return attempts < 3 ? { usage: SDK_USAGE } : { usage: SDK_USAGE, cost: SDK_COST };
    }
  });

  reconciler.schedule({ logId: "log-2", agentId: "agent-2", apiKey: "key-2" });
  await reconciler.drain();
  reconciler.close();

  assert.equal(attempts, 3);
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.deepEqual(log?.cost, SDK_COST);
  assert.equal(log?.usage, undefined, "agent cumulative usage is not a per-request fallback");
});

test("UsageReconciler stops after the bounded polling policy without inventing usage", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("log-3"));
  let attempts = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 2,
    getUsage: async () => {
      attempts += 1;
      return { usage: SDK_USAGE };
    }
  });

  reconciler.schedule({ logId: "log-3", agentId: "agent-3", apiKey: "key-3" });
  await reconciler.drain();
  reconciler.close();

  assert.equal(attempts, 2);
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.equal(log?.usage, undefined);
  assert.equal(log?.cost, undefined);
  assert.equal(log?.usageSource, undefined);
});

test("stateless reconciliation treats an all-zero cost as a final answer", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("log-4"));
  let attempts = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 5,
    trackAgentBaseline: false,
    getUsage: async () => {
      attempts += 1;
      return { usage: SDK_USAGE, cost: { rawCostCents: 0, chargedCents: 0 } };
    }
  });

  reconciler.schedule({ logId: "log-4", agentId: "agent-4", apiKey: "key-4" });
  await reconciler.drain();
  reconciler.close();

  assert.equal(attempts, 1);
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.deepEqual(log?.cost, { rawCostCents: 0, chargedCents: 0 });
});

test("UsageReconciler keeps polling after a stale cumulative cost", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("stale-a"));
  await store.insertRequestLog(requestLog("stale-b"));
  let phase = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 2,
    getUsage: async () => {
      const cost = phase++ === 0
        ? { rawCostCents: 10, chargedCents: 4 }
        : phase === 2
          ? { rawCostCents: 10, chargedCents: 4 }
          : { rawCostCents: 15, chargedCents: 6 };
      return { cost };
    }
  });

  reconciler.schedule({ logId: "stale-a", agentId: "agent-stale", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.schedule({ logId: "stale-b", agentId: "agent-stale", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  const logs = await store.listRequestLogs({ limit: 10 });
  assert.equal(phase, 3, "a defined cumulative value is not proof that the newest run is included");
  assert.deepEqual(logs.logs.find((log) => log.id === "stale-b")?.cost, { rawCostCents: 5, chargedCents: 2 });
});

test("tracked reconciliation does not treat stale zero cost as completion", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("stale-zero"));
  let attempts = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 2,
    getUsage: async () => {
      attempts += 1;
      return {
        cost: attempts === 1
          ? { rawCostCents: 0, chargedCents: 0 }
          : { rawCostCents: 5, chargedCents: 2 }
      };
    }
  });

  reconciler.schedule({ logId: "stale-zero", agentId: "agent-stale-zero", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  assert.equal(attempts, 2);
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.deepEqual(log?.cost, { rawCostCents: 5, chargedCents: 2 });
});

test("tracked reconciliation records an explicit zero when cumulative cost stays unchanged", async () => {
  const store = new MemoryStateStore();
  await store.bookAgentUsageDelta("free-agent", { rawCostCents: 10, chargedCents: 4 });
  await store.insertRequestLog(requestLog("free-request"));
  let attempts = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 3,
    getUsage: async () => {
      attempts += 1;
      return { cost: { rawCostCents: 10, chargedCents: 4 } };
    }
  });

  reconciler.schedule({ logId: "free-request", agentId: "free-agent", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  assert.equal(attempts, 3, "unchanged cumulative cost remains ambiguous until the bounded retry window ends");
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.deepEqual(log?.cost, { rawCostCents: 0, chargedCents: 0 }, "a final zero must be distinguishable from no lookup result");
});

test("a failed request-log write does not advance the cost baseline", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "composer-usage-")), "state.sqlite");
  const store = new SqliteStateStore(path);
  await store.insertRequestLog(requestLog("crash-before-log"));
  await store.insertRequestLog(requestLog("after-retry"));
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TRIGGER fail_cost_log_write
    BEFORE UPDATE OF raw_cost_cents ON request_logs
    BEGIN
      SELECT RAISE(ABORT, 'simulated request log failure');
    END;
  `);
  db.close();

  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    getUsage: async () => ({ cost: { rawCostCents: 10, chargedCents: 4 } })
  });
  reconciler.schedule({ logId: "crash-before-log", agentId: "agent-crash", apiKey: "key-1" });
  await reconciler.drain();

  const withoutTrigger = new DatabaseSync(path);
  withoutTrigger.exec("DROP TRIGGER fail_cost_log_write");
  withoutTrigger.close();
  reconciler.schedule({ logId: "after-retry", agentId: "agent-crash", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  const logs = await store.listRequestLogs({ limit: 10 });
  assert.deepEqual(
    logs.logs.find((log) => log.id === "after-retry")?.cost,
    { rawCostCents: 10, chargedCents: 4 },
    "the failed atomic write must leave the baseline at its previous value"
  );
  assert.equal(logs.logs.find((log) => log.id === "crash-before-log")?.cost, undefined);
});

test("UsageReconciler books only the increment when one resumed agent serves several requests", async () => {
  // Durable / 旧 resume：getUsage 是整个 agent 的累计值。第二条 HTTP 只能记增量，
  // 否则会把第一轮的金额再加一遍。kill-switch 计费见下面显式 trackAgentBaseline:false 的用例。
  const store = new MemoryStateStore();
  const firstUsage: RequestUsage = {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 17
  };
  const secondUsage: RequestUsage = {
    inputTokens: 31,
    outputTokens: 9,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 47,
    reasoningTokens: 3
  };
  await store.insertRequestLog(requestLog("resume-1", { usage: firstUsage, usageSource: "sdk" }));
  await store.insertRequestLog(requestLog("resume-2", { usage: secondUsage, usageSource: "sdk" }));
  // getUsage 返回的是整个 agent 的累计值：第二次请求看到的数字里已经含第一次的钱。
  const cumulative: RequestCost[] = [
    { rawCostCents: 12, chargedCents: 5 },
    { rawCostCents: 30, chargedCents: 11 }
  ];
  let call = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    trackAgentBaseline: true,
    getUsage: async () => ({ usage: call++ === 0 ? firstUsage : secondUsage, cost: cumulative[call - 1] ?? cumulative[1] })
  });

  reconciler.schedule({ logId: "resume-1", agentId: "agent-resumed", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.schedule({ logId: "resume-2", agentId: "agent-resumed", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  const logs = await store.listRequestLogs({ limit: 10 });
  const first = logs.logs.find((log) => log.id === "resume-1");
  const second = logs.logs.find((log) => log.id === "resume-2");
  assert.deepEqual(first?.usage, firstUsage);
  assert.deepEqual(second?.usage, secondUsage);
  assert.deepEqual(first?.cost, { rawCostCents: 12, chargedCents: 5 });
  assert.deepEqual(second?.cost, { rawCostCents: 18, chargedCents: 6 }, "第二条只能记增量，否则第一条的金额被重复计入");
});

test("UsageReconciler never books the same increment twice when two backfills race", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("race-1"));
  await store.insertRequestLog(requestLog("race-2"));
  // 两条补写同时在飞（并发上限就是 2），都会读到同一个累计值。
  let inFlight = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    getUsage: async () => {
      inFlight += 1;
      if (inFlight >= 2) release();
      await bothStarted;
      return { usage: SDK_USAGE, cost: { rawCostCents: 40, chargedCents: 16 } };
    }
  });

  reconciler.schedule({ logId: "race-1", agentId: "agent-race", apiKey: "key-1" });
  reconciler.schedule({ logId: "race-2", agentId: "agent-race", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  const logs = (await store.listRequestLogs({ limit: 10 })).logs;
  const total = logs.reduce((sum, log) => sum + (log.cost?.rawCostCents ?? 0), 0);
  // 累计口径本来就摊不回具体某一次 run：先到的拿走全部增量、后到的拿到 0，合计必须正好等于累计值一次。
  assert.equal(total, 40);
  assert.equal(logs.reduce((sum, log) => sum + (log.cost?.chargedCents ?? 0), 0), 16);
});

test("UsageReconciler writes the cumulative as-is when agent baselines are turned off", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("stateless-1"));
  await store.insertRequestLog(requestLog("stateless-2"));
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    // 关掉 session resume 时每个请求都是全新 agent，增量恒等于累计值，不必落基线。
    trackAgentBaseline: false,
    getUsage: async () => ({ usage: SDK_USAGE, cost: SDK_COST })
  });

  reconciler.schedule({ logId: "stateless-1", agentId: "agent-fresh-1", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.schedule({ logId: "stateless-2", agentId: "agent-fresh-2", apiKey: "key-1" });
  await reconciler.drain();
  reconciler.close();

  const logs = (await store.listRequestLogs({ limit: 10 })).logs;
  // 不记基线时每条都拿到完整金额，不会被上一条的基线扣成 0。
  assert.deepEqual(logs.find((log) => log.id === "stateless-1")?.cost, SDK_COST);
  assert.deepEqual(logs.find((log) => log.id === "stateless-2")?.cost, SDK_COST);
});

test("UsageReconciler swallows getUsage failures and still drains", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("log-5"));
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    getUsage: async () => {
      throw new Error("upstream exploded");
    }
  });

  const logged = await withCapturedErrors(async () => {
    assert.doesNotThrow(() => reconciler.schedule({ logId: "log-5", agentId: "agent-5", apiKey: "key-5" }));
    await reconciler.drain();
    reconciler.close();
  });

  assert.ok(logged.some((line) => line.includes("upstream exploded")), logged.join("\n"));
  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.equal(log?.usage, undefined);
  assert.equal(log?.usageSource, undefined);
});

test("UsageReconciler does not drop backfills during a burst", async () => {
  const store = new MemoryStateStore();
  let calls = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    trackAgentBaseline: false,
    getUsage: async () => {
      calls += 1;
      return { cost: { rawCostCents: 0, chargedCents: 0 } };
    }
  });

  for (let index = 0; index < 205; index += 1) {
    await store.insertRequestLog(requestLog(`burst-${index}`));
    reconciler.schedule({ logId: `burst-${index}`, agentId: "agent", apiKey: "key" });
  }
  await reconciler.drain();

  reconciler.close();
  assert.equal(calls, 205, "all scheduled rows must remain recoverable; a fixed in-memory drop cap loses money");
});

test("close() stops new work but drains already scheduled backfills", async () => {
  const store = new MemoryStateStore();
  let calls = 0;
  const reconciler = new UsageReconciler({
    store,
    delayMs: 20,
    maxAttempts: 1,
    trackAgentBaseline: false,
    getUsage: async () => {
      calls += 1;
      return { cost: SDK_COST };
    }
  });

  await store.insertRequestLog(requestLog("log-6"));
  reconciler.schedule({ logId: "log-6", agentId: "agent-6", apiKey: "key-6" });
  reconciler.close();
  await reconciler.drain();

  assert.equal(calls, 1, "graceful shutdown must wait for pending money lookups");
  // close 之后再排队也应该是空操作。
  await store.insertRequestLog(requestLog("log-7"));
  reconciler.schedule({ logId: "log-7", agentId: "agent-7", apiKey: "key-7" });
  await delay(40);
  assert.equal(calls, 1);
});

test("shutdown waits for the HTTP app before closing the reconciler", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("in-flight"));
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    trackAgentBaseline: false,
    getUsage: async () => ({ cost: SDK_COST })
  });
  let releaseRequest!: () => void;
  const requestFinished = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  const shutdown = closeAppThenDrainUsage(async () => {
    await requestFinished;
    // Fastify 的 close 之后才会执行到这里，模拟在途 handler 收尾时的 schedule。
    reconciler.schedule({ logId: "in-flight", agentId: "agent-in-flight", apiKey: "key-1" });
  }, reconciler);
  releaseRequest();
  await shutdown;

  const [log] = (await store.listRequestLogs({ limit: 10 })).logs;
  assert.deepEqual(log?.cost, SDK_COST, "an in-flight request must be allowed to enqueue before shutdown closes the reconciler");
});

test("drain reports and releases a hung getUsage within its deadline", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("hung"));
  let releaseUsage!: (value: { usage?: RequestUsage; cost?: RequestCost }) => void;
  const hangingUsage = new Promise<{ usage?: RequestUsage; cost?: RequestCost }>((resolve) => {
    releaseUsage = resolve;
  });
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    drainTimeoutMs: 30,
    getUsage: async () => hangingUsage
  });
  reconciler.schedule({ logId: "hung", agentId: "agent-hung", apiKey: "key-1" });
  reconciler.close();

  const logged = await withCapturedErrors(async () => {
    const drainPromise = reconciler.drain();
    const completed = await Promise.race([
      drainPromise.then(() => true),
      delay(80).then(() => false)
    ]);
    try {
      assert.equal(completed, true, "shutdown must not wait forever for a hung upstream lookup");
    } finally {
      // 释放测试中的挂起调用，确保断言失败时也能收尾。
      releaseUsage({});
      await drainPromise;
    }
  });

  assert.ok(
    logged.some((line) => line.includes("drain timed out") && line.includes("in flight")),
    logged.join("\n")
  );
});

test("a hung getUsage call times out without waiting for the drain deadline", async () => {
  const store = new MemoryStateStore();
  await store.insertRequestLog(requestLog("get-usage-timeout"));
  let releaseUsage!: (value: { usage?: RequestUsage; cost?: RequestCost }) => void;
  const hangingUsage = new Promise<{ usage?: RequestUsage; cost?: RequestCost }>((resolve) => {
    releaseUsage = resolve;
  });
  const reconciler = new UsageReconciler({
    store,
    delayMs: 1,
    maxAttempts: 1,
    getUsageTimeoutMs: 20,
    drainTimeoutMs: 100,
    getUsage: async () => hangingUsage
  });
  reconciler.schedule({ logId: "get-usage-timeout", agentId: "agent-timeout", apiKey: "key-1" });
  reconciler.close();

  const logged = await withCapturedErrors(async () => {
    const drainPromise = reconciler.drain();
    const completed = await Promise.race([
      drainPromise.then(() => true),
      delay(80).then(() => false)
    ]);
    try {
      assert.equal(completed, true, "a single hung lookup must not consume the entire shutdown window");
    } finally {
      releaseUsage({});
      await drainPromise;
    }
  });

  assert.ok(logged.some((line) => line.includes("getUsage timed out")), logged.join("\n"));
});

function requestLog(id: string, overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  return {
    id,
    ts: new Date().toISOString(),
    endpoint: "/v1/chat/completions",
    model: "composer-2.5",
    authMode: "gateway",
    status: 200,
    durationMs: 1234,
    stream: false,
    ...overrides
  };
}

async function withCapturedErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
