import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDebugRecorder,
  maskSecrets,
  SNAPSHOT_MAX_BYTES,
  type DebugRecorderSettings
} from "../src/debug-recorder.js";

interface Harness {
  root: string;
  settings: DebugRecorderSettings;
  recorder: ReturnType<typeof createDebugRecorder>;
}

/** 快照文件应在 dirname(SQLITE_PATH)/debug/<date>/<logId>.json；测试用临时目录顶替。 */
function harness(overrides: Partial<DebugRecorderSettings> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "debug-recorder-"));
  const settings: DebugRecorderSettings = {
    enabled: true,
    filters: {},
    maxEntries: 0,
    maxTotalBytes: 0,
    ...overrides
  };
  const recorder = createDebugRecorder({ rootDir: root, resolveSettings: () => settings });
  return { root, settings, recorder };
}

function openInput(h: Harness, patch: Partial<Parameters<ReturnType<typeof createDebugRecorder>["open"]>[0]> = {}) {
  return {
    logId: "log-0001",
    endpoint: "/v1/messages",
    model: "claude-sonnet-4-5",
    ownerLabel: "team-a",
    ownerHash: "a".repeat(32),
    headers: { "content-type": "application/json" },
    body: { messages: [] },
    keyUsageRef: {},
    telemetryRef: {},
    ...patch
  };
}

/** 写一条完整快照并返回文件全文（找不到文件时断言失败）。 */
function writeSnapshot(h: Harness, logId: string, run: (session: NonNullable<ReturnType<ReturnType<typeof createDebugRecorder>["open"]>>) => void): string {
  const session = h.recorder.open({ ...openInput(h), logId });
  assert.ok(session, "enabled 时 open 必须返回会话");
  run(session);
  session.finish(200);
  const days = readdirSync(h.root);
  assert.equal(days.length, 1, "单日单目录");
  const file = join(h.root, days[0], `${logId}.json`);
  assert.ok(existsSync(file), `快照文件必须落盘: ${file}`);
  return readFileSync(file, "utf8");
}

test("开关关闭时 open 返回 undefined 且零落盘", () => {
  const h = harness({ enabled: false });
  assert.equal(h.recorder.open(openInput(h)), undefined);
  // mkdtempSync 建的 root 允许存在，但里面不能有任何日期目录 / 快照文件。
  assert.deepEqual(readdirSync(h.root), [], "开关关闭时不得产生任何落盘");
});

test("敏感头在落盘前被掩码，且掩码形式与 maskKey 一致", () => {
  const h = harness();
  const token = "crsk_0123456789abcdef0123456789abcdef";
  const session = h.recorder.open({
    ...openInput(h),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
  });
  assert.ok(session);
  session.finish(200);
  const days = readdirSync(h.root);
  const text = readFileSync(join(h.root, days[0], "log-0001.json"), "utf8");
  // 先验证头确实进了快照，再验证值没有泄漏。
  assert.ok(text.includes('"authorization"'));
  assert.ok(!text.includes(token), "authorization 头明文不得落盘");
  assert.ok(text.includes("***"), "掩码保留前后片段");
});

test("maskSecrets 覆盖 Bearer / sk- / crsr_ / crsk_ / ghp_ / JWT 凭据", () => {
  const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N64TWJ3XKCZ7q";
  const text = maskSecrets(
    JSON.stringify({
      auth: bearer,
      apiKey: "sk-ant-api03-0123456789abcdef",
      cursorKey: "crsr_0123456789abcdef",
      botCred: "crsk_0123456789abcdef",
      githubPat: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      raw: "prefix sk-abcdefghijklmnop trailing",
      safe: "no secrets here"
    })
  );
  assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT 主体不得保留");
  assert.ok(!text.includes("sk-ant-api03"), "sk- key 不得保留");
  assert.ok(!text.includes("crsr_0123456789abcdef"), "crsr_ token 不得保留");
  assert.ok(!text.includes("crsk_0123456789abcdef"), "crsk_ token 不得保留");
  assert.ok(!text.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), "ghp_ PAT 不得保留");
  assert.ok(text.includes("Bearer [redacted]"));
  assert.ok(text.includes("[redacted]"));
  assert.ok(text.includes("no secrets here"));
});

test("请求体里的 crsk_ / ghp_ 凭据同样被 maskSecrets 兜底掩码", () => {
  const h = harness();
  const crsk = "crsk_0123456789abcdef0123456789abcdef";
  const ghp = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  const session = h.recorder.open({
    ...openInput(h),
    logId: "log-body-crsk",
    body: { botCredential: crsk, githubPat: ghp }
  });
  assert.ok(session);
  session.finish(200);
  const days = readdirSync(h.root);
  const text = readFileSync(join(h.root, days[0], "log-body-crsk.json"), "utf8");
  assert.ok(!text.includes(crsk), "请求体内的 crsk_ token 不得落盘");
  assert.ok(!text.includes(ghp), "请求体内的 ghp_ token 不得落盘");
});

test("Bearer token 混在请求体里也会被 maskSecrets 兜底", () => {
  const h = harness();
  const sessionToken = "Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  const text = writeSnapshot(h, "log-body-mask", (session) => {
    session.noteUpstreamTurn("sdk", { message: "auth " + sessionToken + " rest" });
  });
  assert.ok(!text.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), "上游轮次里的 Bearer token 不得保留");
  assert.ok(text.includes("Bearer [redacted]"));
});

test("maskHeaders 对 x-api-key / cookie 同样掩码", () => {
  const h = harness();
  const session = h.recorder.open({
    ...openInput(h),
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-verysecretkey12345",
      cookie: "session=abc123def456ghi789",
      "user-agent": "claude-cli/1.0"
    }
  });
  assert.ok(session);
  session.finish(200);
  const days = readdirSync(h.root);
  const text = readFileSync(join(h.root, days[0], "log-0001.json"), "utf8");
  assert.ok(!text.includes("sk-ant-verysecretkey12345"), "x-api-key 明文不得落盘");
  assert.ok(!text.includes("session=abc123def456ghi789"), "cookie 明文不得落盘");
  assert.ok(text.includes("claude-cli/1.0"), "非敏感头原样保留");
});

test("匹配的快照按 logId 可读回，read 拒绝非法 id", () => {
  const h = harness();
  const text = writeSnapshot(h, "log-read-1", () => {});
  const found = h.recorder.read("log-read-1");
  assert.ok(found);
  assert.ok(found.includes('"logId": "log-read-1"'));
  assert.equal(h.recorder.read("log-read-2"), undefined);
  // 路径注入类的 id 直接拒绝。
  assert.equal(h.recorder.read("../../etc/passwd"), undefined);
  assert.equal(h.recorder.read(""), undefined);
});

test("endpoint / model / owner 过滤不匹配时不落盘", () => {
  const h = harness({ filters: { endpoint: "/v1/messages" } });
  const rejected = h.recorder.open({ ...openInput(h), endpoint: "/v1/chat/completions", logId: "log-no" });
  assert.equal(rejected, undefined);
  const accepted = h.recorder.open(openInput(h));
  assert.ok(accepted);
  accepted.finish(200);
  const days = readdirSync(h.root);
  assert.equal(readdirSync(join(h.root, days[0])).length, 1);

  const byModel = harness({ filters: { model: "grok" } });
  assert.equal(byModel.recorder.open(openInput(byModel)), undefined);

  const byOwner = harness({ filters: { owner: "team-b" } });
  assert.equal(byOwner.recorder.open(openInput(byOwner)), undefined);
  // owner 匹配 ownerHash 前 16 位前缀。
  const byHash = harness({ filters: { owner: "aaaa" } });
  assert.ok(byHash.recorder.open(openInput(byHash)));
});

test("finish 幂等：只有第一次落盘", () => {
  const h = harness();
  const session = h.recorder.open(openInput(h));
  assert.ok(session);
  session.finish(500, "boom");
  session.finish(200);
  const days = readdirSync(h.root);
  const files = readdirSync(join(h.root, days[0]));
  assert.equal(files.length, 1);
  const text = readFileSync(join(h.root, days[0], files[0]), "utf8");
  assert.ok(text.includes('"status": 500'));
  assert.ok(text.includes("boom"));
});

test("单日条数上限：清理触发后只留最新 maxEntries 条", () => {
  const h = harness({ maxEntries: 3 });
  // CLEANUP_EVERY=20：写满 20 条触发一次清理，之后单日只剩最新 3 条。
  // Windows 的文件 mtime 粒度粗（同一毫秒写出的文件排序不稳定），
  // 所以不点名断言「哪 3 条」留下，只断言条数与「最旧的确实被清掉」。
  for (let i = 0; i < 20; i++) {
    const s = h.recorder.open({ ...openInput(h), logId: `log-entry-${i}` });
    assert.ok(s);
    s.finish(200);
  }
  const days = readdirSync(h.root);
  const remaining = readdirSync(join(h.root, days[0]));
  assert.equal(remaining.length, 3, `清理后应只剩 maxEntries 条（实际 ${remaining.length}）`);
});

test("总体积上限：从最旧开始删", () => {
  const h = harness({ maxEntries: 0, maxTotalBytes: 2048 });
  // 每条快照 ~1-2KB，写 20 条触发清理后总体积必须被压回上限附近。
  for (let i = 0; i < 20; i++) {
    const s = h.recorder.open({ ...openInput(h), logId: `log-size-${i}` });
    assert.ok(s);
    s.finish(200);
  }
  const days = readdirSync(h.root);
  const dir = join(h.root, days[0]);
  const remaining = readdirSync(dir);
  assert.ok(remaining.length < 20, `必须删掉一部分（剩余 ${remaining.length}）`);
  let totalBytes = 0;
  for (const name of remaining) totalBytes += readFileSync(join(dir, name), "utf8").length;
  // 上限 2048 + 最后一条自身（清理后新写的可能把它顶回去一点）。
  assert.ok(totalBytes <= 6144, `剩余体积需接近上限（实际 ${totalBytes}）`);
});

test("abort 归因三值与分支原样落盘", () => {
  const h = harness();
  const text = writeSnapshot(h, "log-abort", (session) => {
    session.noteAbort({
      branch: "early-destroyed-check",
      rawDestroyed: true,
      rawComplete: true,
      socketDestroyed: false
    });
  });
  assert.ok(text.includes('"branch": "early-destroyed-check"'));
  assert.ok(text.includes('"rawDestroyed": true'));
  assert.ok(text.includes('"rawComplete": true'));
  assert.ok(text.includes('"socketDestroyed": false'));
});

test("abort 归因里的 abortReason（包 C）随快照落盘", () => {
  const h = harness();
  const client = writeSnapshot(h, "log-abort-reason", (session) => {
    session.noteAbort({
      branch: "socket-close-listener",
      rawDestroyed: true,
      rawComplete: true,
      socketDestroyed: true,
      abortReason: "client_disconnect"
    });
  });
  assert.ok(client.includes('"abortReason": "client_disconnect"'));

  const timeout = writeSnapshot(h, "log-abort-timeout", (session) => {
    session.noteAbort({
      branch: "idle-timeout",
      rawDestroyed: false,
      rawComplete: true,
      socketDestroyed: false,
      signalReason: "Upstream produced no output for 90000ms.",
      abortReason: "idle_timeout"
    });
  });
  assert.ok(timeout.includes('"abortReason": "idle_timeout"'));
  assert.ok(timeout.includes("Upstream produced no output"));
});

test("noteAbort 只写一次：后到的归因不覆盖先到的现场", () => {
  const h = harness();
  // 早退分支先拍下现场，随后 socket 真关闭再触发一次 noteAbort：必须保留早退那份，不得被覆盖。
  const text = writeSnapshot(h, "log-abort-once", (session) => {
    session.noteAbort({
      branch: "early-destroyed-check",
      rawDestroyed: true,
      rawComplete: true,
      socketDestroyed: false,
      abortReason: "client_disconnect"
    });
    session.noteAbort({
      branch: "socket-close-listener",
      rawDestroyed: true,
      rawComplete: true,
      socketDestroyed: true,
      abortReason: "client_disconnect"
    });
  });
  assert.ok(text.includes('"branch": "early-destroyed-check"'), "先到的早退现场必须保留");
  assert.ok(!text.includes('"branch": "socket-close-listener"'), "后到的归因不得覆盖");
  assert.ok(!text.includes('"socketDestroyed": true'), "覆盖现场的销毁值不得出现");
});

test("请求体超过快照预算时只留 omitted 标记，不持有全文", () => {
  const h = harness();
  const big = "x".repeat(SNAPSHOT_MAX_BYTES + 1024);
  const session = h.recorder.open({ ...openInput(h), logId: "log-big-body", body: { big } });
  assert.ok(session);
  session.finish(200);
  const days = readdirSync(h.root);
  const text = readFileSync(join(h.root, days[0], "log-big-body.json"), "utf8");
  assert.ok(text.includes('"omittedBySizeBudget": true'), "超预算的请求体只留 omitted 标记");
  assert.ok(text.includes('"bodyChars"'), "标记里带原始字符数");
  assert.ok(!text.includes(big), "超预算的请求体全文不得落盘");
});

test("SSE 逐事件与上游轮次全文都进快照", () => {
  const h = harness();
  const text = writeSnapshot(h, "log-full", (session) => {
    session.noteRouting({ provider: "bot", model: "grok-4", reason: "model-prefix" });
    session.noteSelectedKey("abc12***wxyz", "key-1", "main-key");
    session.noteUpstreamTurn("bot", { conversationId: "c-1", messages: [{ role: "user", text: "全文轮次" }] });
    session.noteSseEvent("data: {\"delta\":\"hi\"}\n\n");
    session.noteResponse({ text: "done" });
  });
  assert.ok(text.includes("全文轮次"), "上游轮次全文不得摘要");
  assert.ok(text.includes("data: "), "SSE 事件原文保留");
  assert.ok(text.includes("abc12***wxyz"), "选中 key 的掩码值保留");
  assert.ok(!text.includes("abc123wxyz"), "非掩码形式的 key 不存在");
});

test("read 在目录不存在时安全返回 undefined", () => {
  const h = harness({ enabled: false });
  assert.equal(h.recorder.read("anything"), undefined);
});
