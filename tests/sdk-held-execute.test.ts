import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import type { AgentLike } from "../src/cursor-runner.js";

/**
 * WP0 spike：生产 SessionHub 还不存在，禁止 import src/session-hub.ts。
 * 下面的 MiniHub 只活在本测试文件里，证明「HTTP1 停在 pending execute、HTTP2 resolve 后同一 Run 继续」。
 */

const SDK_VERSION = installedSdkVersion();
const LIVE_API_KEY = firstCursorApiKeyFromEnv();
const HTTP1_BUDGET_MS = 500;
const LIVE_HOLD_MS = 2_000;
const LIVE_TIMEOUT_MS = 120_000;

test("mini-hub parks HTTP1 on pending execute and resumes the same run after HTTP2 resolve", async () => {
  assert.equal(SDK_VERSION, "1.0.27");
  const hub = new MiniHub();
  const t0 = Date.now();
  const http1 = await hub.handleHttp1("Read README.md");
  const http1Ms = Date.now() - t0;

  assert.ok(http1Ms < HTTP1_BUDGET_MS, `HTTP1 must return while execute is still pending, took ${http1Ms}ms`);
  assert.equal(hub.state, "awaiting_tools");
  assert.equal(http1.runId, "run-held");
  assert.equal(http1.agentId, "agent-held-execute");
  assert.deepEqual(http1.toolCalls.map((call) => call.name), ["Read"]);
  assert.equal(http1.texts.join(""), "Calling Read.");
  assert.equal(http1.texts.join("").includes("hello from README"), false);
  assert.equal(hub.run.cancelled, false);
  assert.equal(hub.agent.disposed, false);
  assert.equal(hub.hasPending("call_read_1"), true);

  await delay(30);
  assert.equal(hub.hasPending("call_read_1"), true, "pending execute must survive after HTTP1 ended");
  assert.equal(hub.state, "awaiting_tools");

  const http2 = await hub.handleHttp2("call_read_1", "hello from README");
  assert.equal(http2.runId, http1.runId);
  assert.equal(hub.state, "idle");
  assert.ok(http2.texts.join("").includes("hello from README"), http2.texts.join(""));
  assert.equal(hub.run.cancelled, false);
  assert.equal(hub.agent.disposed, false);
  assert.equal(hub.hasPending("call_read_1"), false);
  assert.equal(asRecord(http2.waitResult)?.status, "finished");
});

test("live SDK held execute survives 2s then wait() finishes", {
  skip: LIVE_API_KEY ? false : "no CURSOR_API_KEY or CURSOR_API_KEYS",
  timeout: LIVE_TIMEOUT_MS
}, async () => {
  if (!LIVE_API_KEY) {
    assert.fail("live test entered without an API key");
    return;
  }
  const apiKey = LIVE_API_KEY;

  await prepareLiveSdkNetwork();
  const cwd = await mkdtemp(path.join(tmpdir(), "wp0-held-execute-"));
  const { Agent } = await import("@cursor/sdk");

  let resolveHold: ((result: SDKCustomToolResult) => void) | undefined;
  const hold = new Promise<SDKCustomToolResult>((resolve) => {
    resolveHold = resolve;
  });
  let executeCalledAt = 0;
  let executeSettled = false;

  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    name: "WP0 held-execute spike",
    tools: ["mcp"],
    local: {
      cwd,
      settingSources: [],
      customTools: {
        hold_probe: {
          description: "Probe tool that must be called immediately. The test holds this execute() for 2 seconds.",
          inputSchema: {
            type: "object",
            properties: { ping: { type: "string" } },
            required: ["ping"]
          },
          execute: async () => {
            executeCalledAt = Date.now();
            const result = await hold;
            executeSettled = true;
            return result;
          }
        }
      }
    }
  });

  let streamError: unknown;
  try {
    const run = await agent.send(
      "You have exactly one tool: hold_probe. You MUST call hold_probe now with ping=wp0 as your first action. Do not write a final answer until hold_probe returns. After the tool result arrives, reply with exactly: HELD_EXECUTE_OK"
    );
    const streamDone = (async () => {
      try {
        for await (const _event of run.stream()) {
          // Drain stream so the local runtime is not stalled by an unconsumed generator.
        }
      } catch (error) {
        streamError = error;
      }
    })();

    const executeDeadline = Date.now() + 60_000;
    while (!executeCalledAt && Date.now() < executeDeadline) {
      await delay(50);
      if (run.status === "error" || run.status === "cancelled") break;
    }
    if (!executeCalledAt) {
      await run.cancel().catch(() => undefined);
      const detail = streamError instanceof Error ? streamError.message : run.error?.message ?? run.status;
      assert.fail(`live SDK never invoked hold_probe.execute (status=${run.status}${detail ? `; ${detail}` : ""})`);
    }

    await delay(LIVE_HOLD_MS);
    const heldMs = Date.now() - executeCalledAt;
    assert.ok(heldMs >= LIVE_HOLD_MS - 50, `hold was too short: ${heldMs}ms`);
    assert.equal(executeSettled, false, "execute must still be pending after the 2s hold");
    assert.notEqual(run.status, "cancelled", "SDK cancelled the Run while execute was held");
    assert.notEqual(run.status, "error", `SDK errored while execute was held: ${run.error?.message ?? ""}`);

    resolveHold?.({ content: [{ type: "text", text: "probe-result" }] });
    const waited = await withTimeout(run.wait(), 60_000, "run.wait()");
    await withTimeout(streamDone, 10_000, "run.stream() drain");

    if (streamError) {
      const message = streamError instanceof Error ? streamError.message : String(streamError);
      assert.fail(`SDK stream disconnected while execute was held: ${message}`);
    }
    assert.equal(waited.status, "finished", `wait() status=${waited.status} error=${waited.error?.message ?? ""}`);
    assert.equal(executeSettled, true);
  } finally {
    await agent[Symbol.asyncDispose]().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

function installedSdkVersion(): string {
  const pkgPath = path.resolve(process.cwd(), "node_modules/@cursor/sdk/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

/** 与 src/config.ts 同一口径：CURSOR_API_KEYS 多分隔 + 旧的 CURSOR_API_KEY。 */
function firstCursorApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const keys = (env.CURSOR_API_KEYS ?? "")
    .split(/[,;\n]/)
    .map((key) => key.trim())
    .filter(Boolean);
  const legacy = env.CURSOR_API_KEY?.trim();
  if (legacy && !keys.includes(legacy)) keys.unshift(legacy);
  return keys[0];
}

async function prepareLiveSdkNetwork(): Promise<void> {
  const proxyUrl = process.env.PROXY_URL?.trim();
  const http1Env = process.env.CURSOR_SDK_USE_HTTP1_FOR_AGENT?.trim().toLowerCase();
  const useHttp1 = http1Env === "true" || http1Env === "1" || Boolean(proxyUrl);
  if (proxyUrl) {
    const { applyProxyConfig } = await import("../src/proxy.js");
    applyProxyConfig(proxyUrl, { useHttp1ForAgent: useHttp1 });
  }
  if (useHttp1) {
    const { applyCursorSdkNetworkConfig } = await import("../src/sdk-network.js");
    await applyCursorSdkNetworkConfig(true);
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

type HubState = "empty" | "running" | "awaiting_tools" | "idle" | "dead";

type QueueItem =
  | { kind: "event"; event: unknown }
  | { kind: "captured"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "end"; error?: unknown };

interface PendingExecute {
  resolve: (value: SDKCustomToolResult) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

interface HubTurn {
  texts: string[];
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  runId: string;
  agentId: string;
  waitResult?: unknown;
}

/** 单消费者队列，形状对齐 cursor-runner.ts AsyncQueue。 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.resolvers.push(resolve));
  }
}

/**
 * 最小 durable 状态机：HTTP1 泵到 pending execute 就结束（不 cancel / dispose），
 * HTTP2 resolve 后从同一 queue 继续吐后续文本，再 wait() → idle。
 */
class MiniHub {
  state: HubState = "empty";
  agent = new FakeAgent();
  run = new FakeSdkRun();
  private readonly queue = new AsyncQueue<QueueItem>();
  private readonly pending = new Map<string, PendingExecute>();

  hasPending(id: string): boolean {
    const slot = this.pending.get(id);
    return Boolean(slot && !slot.settled);
  }

  async handleHttp1(prompt: string): Promise<HubTurn> {
    this.state = "running";
    this.run = await this.agent.send(prompt, {
      local: { customTools: this.createHeldTools() }
    }) as FakeSdkRun;
    this.startPump();

    const texts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (;;) {
      const item = await this.queue.next();
      if (item.kind === "event") {
        const text = assistantText(item.event);
        if (text) texts.push(text);
        const call = toolCallFromEvent(item.event);
        if (call) toolCalls.push(call);
        continue;
      }
      if (item.kind === "end") {
        this.state = "dead";
        const detail = item.error instanceof Error ? item.error.message : String(item.error ?? "stream ended");
        throw new Error(`HTTP1 stream ended before pending execute: ${detail}`);
      }
      toolCalls.push({ id: item.id, name: item.name, arguments: item.args });
      if (![...this.pending.values()].some((slot) => !slot.settled)) {
        throw new Error(`captured ${item.id} but execute Promise was already settled`);
      }
      this.state = "awaiting_tools";
      break;
    }

    return {
      texts,
      toolCalls,
      runId: this.run.id,
      agentId: this.agent.agentId ?? ""
    };
  }

  async handleHttp2(toolCallId: string, resultText: string): Promise<HubTurn> {
    const slot = this.pending.get(toolCallId);
    if (!slot || slot.settled) throw new Error(`no pending execute for ${toolCallId}`);
    this.state = "running";
    slot.settled = true;
    slot.resolve({ content: [{ type: "text", text: resultText }] });

    const texts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (;;) {
      const item = await this.queue.next();
      if (item.kind === "event") {
        const text = assistantText(item.event);
        if (text) texts.push(text);
        const call = toolCallFromEvent(item.event);
        if (call) toolCalls.push(call);
      } else if (item.kind === "end") {
        if (item.error) {
          this.state = "dead";
          throw item.error instanceof Error ? item.error : new Error(String(item.error));
        }
        break;
      }
    }

    const waitResult = await this.run.wait();
    this.state = "idle";
    return {
      texts,
      toolCalls,
      runId: this.run.id,
      agentId: this.agent.agentId ?? "",
      waitResult
    };
  }

  private createHeldTools(): Record<string, SDKCustomTool> {
    return {
      Read: {
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"]
        },
        execute: (args, context) => {
          const id = context.toolCallId ?? "call_unknown";
          const promise = new Promise<SDKCustomToolResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, settled: false });
          });
          this.queue.push({
            kind: "captured",
            id,
            name: "Read",
            args: args as Record<string, unknown>
          });
          return promise;
        }
      }
    };
  }

  private startPump(): void {
    const run = this.run;
    void (async () => {
      try {
        for await (const event of run.stream()) this.queue.push({ kind: "event", event });
        this.queue.push({ kind: "end" });
      } catch (error) {
        this.queue.push({ kind: "end", error });
      }
    })();
  }
}

class FakeSdkRun {
  readonly id = "run-held";
  cancelled = false;
  private readonly finished: Promise<unknown>;
  private resolveFinished!: (value: unknown) => void;
  private events: (() => AsyncIterable<unknown>) | undefined;

  constructor() {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  attach(streamEvents: () => AsyncIterable<unknown>): void {
    this.events = streamEvents;
  }

  async *stream(): AsyncIterable<unknown> {
    try {
      if (this.events) yield* this.events();
      if (!this.cancelled) this.resolveFinished({ status: "finished", result: "done" });
    } catch (error) {
      this.resolveFinished({
        status: this.cancelled ? "cancelled" : "error",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  wait(): Promise<unknown> {
    return this.finished;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.resolveFinished({ status: "cancelled" });
  }
}

class FakeAgent implements AgentLike {
  readonly agentId = "agent-held-execute";
  disposed = false;

  async send(message: unknown, options: Record<string, unknown>): Promise<FakeSdkRun> {
    void message;
    const customTools = asRecord(asRecord(options.local)?.customTools);
    const read = asRecord(customTools?.Read);
    const execute = read?.execute;
    if (typeof execute !== "function") throw new Error("FakeAgent expected customTools.Read.execute");

    const run = new FakeSdkRun();
    run.attach(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Calling Read." }] }
      };
      const pending = execute.call(read, { file_path: "README.md" }, { toolCallId: "call_read_1" }) as Promise<unknown>;
      yield {
        type: "tool_call",
        toolCall: { id: "call_read_1", name: "Read", arguments: { file_path: "README.md" } }
      };
      const result = await pending;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: `README:\n${toolResultText(result)}` }] }
      };
    });
    return run;
  }

  close(): void {
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assistantText(event: unknown): string {
  const record = asRecord(event);
  if (!record || record.type !== "assistant") return "";
  const message = asRecord(record.message);
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    }).join("");
  }
  return typeof record.text === "string" ? record.text : "";
}

function toolCallFromEvent(event: unknown): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  const record = asRecord(event);
  const toolCall = asRecord(record?.toolCall);
  if (!toolCall || typeof toolCall.id !== "string" || typeof toolCall.name !== "string") return undefined;
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: asRecord(toolCall.arguments) ?? {}
  };
}

function toolResultText(result: unknown): string {
  const record = asRecord(result);
  const content = record?.content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const item = asRecord(block);
      return typeof item?.text === "string" ? item.text : "";
    }).join("");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}
