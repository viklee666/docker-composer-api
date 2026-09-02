/**
 * Live WP8 smoke: S1 two-turn chat, S2 lookup tool round-trip, S4 responses, S3 messages.
 * Model: first catalog id matching grok-4.6.
 *
 * Usage:
 *   node scripts/live-durable-smoke.mjs
 *   LIVE_GATEWAY_URL=http://127.0.0.1:8787 node scripts/live-durable-smoke.mjs
 *
 * Windows host + @cursor/sdk 1.0.27: Agent.send loads local runtime (357.js) and
 * the process dies with 0xC0000005 (ACCESS_VIOLATION). Run this against Linux/Docker.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8787;
const EXTERNAL = process.env.LIVE_GATEWAY_URL?.replace(/\/$/, "");
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const REQUEST_MS = 360_000;

function parseDotenv(file) {
  const env = {};
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/crsr_[A-Za-z0-9]+/g, "crsr_***")
    .replace(/key_[A-Za-z0-9]+/g, "key_***");
}

function pickGrok46(models) {
  const ids = models.map((m) => m.id).filter(Boolean);
  const scored = ids
    .filter((id) => /grok/i.test(id))
    .map((id) => {
      let score = 0;
      if (/grok-4\.6/i.test(id) || /grok4\.6/i.test(id) || /grok-4-6/i.test(id)) score = 100;
      else if (/4\.6/.test(id)) score = 80;
      else if (/grok-4/i.test(id)) score = 40;
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 80 ? scored[0].id : scored[0]?.id;
}

function assistantText(chat) {
  const msg = chat?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function cacheFromUsage(usage) {
  if (!usage) return undefined;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? 0;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0;
  const denom = prompt + cacheRead + cacheWrite;
  return {
    prompt,
    cacheRead,
    cacheWrite,
    cacheHit: denom > 0 ? Number((cacheRead / denom).toFixed(3)) : undefined
  };
}

function anthropicText(json) {
  const blocks = json?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
}

const fileEnv = parseDotenv(path.join(root, ".env"));
const token = fileEnv.GATEWAY_API_KEY?.trim() || fileEnv.CURSOR_API_KEY?.trim();
if (!token) {
  console.error("No GATEWAY_API_KEY or CURSOR_API_KEY in .env");
  process.exit(1);
}

mkdirSync(path.join(root, "data"), { recursive: true });
const emptyWorkspace = path.join(root, "data", "empty-workspace");
mkdirSync(emptyWorkspace, { recursive: true });

const childEnv = {
  ...process.env,
  ...fileEnv,
  HOST: "127.0.0.1",
  PORT: String(PORT),
  SQLITE_PATH: path.join(root, "data", "live-durable.sqlite"),
  CURSOR_WORKING_DIRECTORY: emptyWorkspace,
  CURSOR_PREWARM: "false",
  REQUEST_TIMEOUT_MS: String(REQUEST_MS)
};

const results = [];
const durableLines = [];
let child;
let listening = false;

async function api(method, urlPath, body, extraHeaders = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extraHeaders
  };
  if (urlPath.startsWith("/v1/messages")) {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = token;
  }
  return timedJson(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS)
  });
}

async function timedJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  return { status: res.status, json };
}

try {
  if (!EXTERNAL) {
    child = spawn(process.execPath, ["dist/src/index.js"], {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server start timeout")), 90_000);
      const handle = (line) => {
        const text = redact(line);
        console.log(`[server] ${text}`);
        if (/\[durable\]/.test(line)) durableLines.push(text);
        if (/listening on http:\/\//i.test(line)) {
          listening = true;
          clearTimeout(timer);
          resolve();
        }
      };
      createInterface({ input: child.stdout }).on("line", handle);
      createInterface({ input: child.stderr }).on("line", handle);
      child.on("exit", (code, signal) => {
        console.log(`[server-exit] code=${code} signal=${signal}`);
        if (!listening) {
          clearTimeout(timer);
          reject(new Error(`server exited ${code} signal=${signal}`));
        }
      });
    });
  } else {
    console.log(`using existing gateway ${BASE}`);
  }

  const listed = await api("GET", "/v1/models");
  if (listed.status !== 200) {
    throw new Error(`GET /v1/models ${listed.status} ${redact(JSON.stringify(listed.json)).slice(0, 400)}`);
  }
  const models = listed.json?.data ?? [];
  const grokIds = models.filter((m) => /grok/i.test(m.id)).map((m) => m.id);
  const model = pickGrok46(models);
  console.log(`models source=${listed.json?.object ?? "list"} grok=${grokIds.join(", ") || "(none)"}`);
  if (!model) throw new Error(`no grok model in catalog; grok ids: ${grokIds.join(", ") || "none"}`);
  console.log(`using model=${model}`);

  const session = `live-durable-${Date.now()}`;
  const affinity = { "x-session-affinity": session };

  async function chat(messages, extra = {}, headers = affinity) {
    return api("POST", "/v1/chat/completions", { model, stream: false, messages, ...extra }, headers);
  }

  const s1user = `用一句话介绍 docker-composer-api 这个仓库。标记 ${session}-S1。不要使用工具。`;
  const s1a = await chat([{ role: "user", content: s1user }]);
  const t1 = assistantText(s1a.json);
  results.push({
    name: "S1-turn1",
    ok: s1a.status === 200 && t1.length > 0,
    status: s1a.status,
    preview: t1.slice(0, 180),
    cache: cacheFromUsage(s1a.json?.usage),
    error: s1a.json?.error?.message
  });

  const s1b = await chat([
    { role: "user", content: s1user },
    { role: "assistant", content: t1 },
    { role: "user", content: "上一句回复的最后一个词（或最后一个汉字）是什么？不要再介绍仓库。" }
  ]);
  const t2 = assistantText(s1b.json);
  const repeatedIntro = /docker-composer-api/.test(t2) && /仓库/.test(t2) && t2.length > 80;
  results.push({
    name: "S1-turn2",
    ok: s1b.status === 200 && t2.length > 0 && !repeatedIntro,
    status: s1b.status,
    preview: t2.slice(0, 180),
    cache: cacheFromUsage(s1b.json?.usage),
    note: repeatedIntro ? "second turn looks like it re-introduced the repo" : "did not re-introduce the repo",
    error: s1b.json?.error?.message
  });

  const lookupTool = {
    type: "function",
    function: {
      name: "lookup",
      description: "Look up a short token. Always call this when asked to lookup.",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"]
      }
    }
  };
  const s2headers = { "x-session-affinity": `${session}-s2` };
  const s2user = "请调用 lookup 工具，参数 q=ping。不要编造结果，必须发起 tool call。";
  const s2a = await chat(
    [{ role: "user", content: s2user }],
    { tools: [lookupTool], tool_choice: { type: "function", function: { name: "lookup" } } },
    s2headers
  );
  const toolCalls = s2a.json?.choices?.[0]?.message?.tool_calls ?? [];
  results.push({
    name: "S2-tool-call",
    ok: s2a.status === 200 && toolCalls.length > 0,
    status: s2a.status,
    finish: s2a.json?.choices?.[0]?.finish_reason,
    tools: toolCalls.map((c) => c.function?.name),
    preview: assistantText(s2a.json).slice(0, 160),
    cache: cacheFromUsage(s2a.json?.usage),
    error: s2a.json?.error?.message
  });
  if (toolCalls.length) {
    const s2b = await chat(
      [
        { role: "user", content: s2user },
        s2a.json.choices[0].message,
        ...toolCalls.map((call) => ({
          role: "tool",
          tool_call_id: call.id,
          content: "pong"
        }))
      ],
      { tools: [lookupTool], tool_choice: "auto" },
      s2headers
    );
    const s2text = assistantText(s2b.json);
    results.push({
      name: "S2-tool-result",
      ok: s2b.status === 200 && /pong/i.test(s2text) && !/我要调用 lookup/.test(s2text),
      status: s2b.status,
      preview: s2text.slice(0, 220),
      finish: s2b.json?.choices?.[0]?.finish_reason,
      cache: cacheFromUsage(s2b.json?.usage),
      error: s2b.json?.error?.message
    });
  }

  const r1 = await api("POST", "/v1/responses", {
    model,
    input: `用四个汉字回答：天是什么颜色？标记 ${session}-R1。`,
    store: true
  }, { "x-session-affinity": `${session}-r` });
  const rid = r1.json?.id;
  results.push({
    name: "S4-responses-1",
    ok: r1.status === 200 && Boolean(rid),
    status: r1.status,
    id: rid,
    error: r1.json?.error?.message
  });
  if (rid) {
    const r2 = await api("POST", "/v1/responses", {
      model,
      previous_response_id: rid,
      input: "只重复你上一条答案的最后两个字。"
    }, { "x-session-affinity": `${session}-r` });
    const out = JSON.stringify(r2.json?.output ?? r2.json).slice(0, 300);
    results.push({
      name: "S4-responses-2",
      ok: r2.status === 200,
      status: r2.status,
      preview: out,
      cache: cacheFromUsage(r2.json?.usage),
      error: r2.json?.error?.message
    });
  }

  const m1 = await api("POST", "/v1/messages", {
    model,
    max_tokens: 256,
    messages: [{ role: "user", content: `只用两个字回答：1+1 等于几？标记 ${session}-M。` }]
  }, { "x-session-affinity": `${session}-m` });
  const mtext = anthropicText(m1.json);
  results.push({
    name: "S3-messages-1",
    ok: m1.status === 200 && mtext.length > 0,
    status: m1.status,
    preview: mtext.slice(0, 160),
    stop: m1.json?.stop_reason,
    cache: cacheFromUsage(m1.json?.usage),
    error: m1.json?.error?.message
  });

  const failed = results.filter((r) => !r.ok);
  const sends = durableLines.filter((l) => /\[durable\] send /.test(l));
  const resolves = durableLines.filter((l) => /\[durable\] resolve execute/.test(l));
  const creates = durableLines.filter((l) => /\[durable\] create agentId=/.test(l));
  console.log(JSON.stringify({
    model,
    session,
    results,
    durable: { creates, sends, resolves, all: durableLines }
  }, null, 2));
  if (failed.length) {
    console.error(`FAILED ${failed.map((f) => f.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("ALL LIVE CHECKS PASSED");
  }
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(redact(err.stack ?? err.message));
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    const c = cause;
    console.error(`fetch-cause name=${c.name} code=${c.code} errno=${c.errno} message=${redact(c.message ?? "")}`);
  }
  if (child) {
    console.error(`child pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode} killed=${child.killed}`);
  }
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
