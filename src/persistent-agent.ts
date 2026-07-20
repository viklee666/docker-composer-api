import { ApiError } from "./errors.js";
import { applyCursorSdkNetworkConfig } from "./sdk-network.js";
import type { CursorRunRequest, CursorRunResult, CursorRunner, CursorStreamEvent } from "./types.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a persistent Cursor SDK agent running inside one long-lived active run.",
  "You have a tool named wait_for_user_input. Call it immediately to receive the next user request.",
  "After receiving a user request from the tool, answer it normally. When your answer is complete, call wait_for_user_input again.",
  "Never end the run voluntarily. Keep cycling: wait_for_user_input -> answer -> wait_for_user_input.",
  "If the user request contains API protocol wrapper text, follow the user's actual request while preserving compatibility with that wrapper."
].join("\n");

const DEFAULT_USER_PROMPT = "Start persistent mode now. Call wait_for_user_input and wait for the next user request.";

export interface PersistentStartOptions {
  apiKey: string;
  model: string;
  modelParams?: Array<{ id: string; value: string }>;
  httpMode: "default" | "1.1" | "2";
  cwd: string;
  maxAttempts: number;
  readyTimeoutMs: number;
  responseTimeoutMs: number;
  systemPrompt?: string;
  userPrompt?: string;
  routeApiTraffic: boolean;
}

export interface PersistentStatus {
  status: "idle" | "starting" | "ready" | "error" | "stopping";
  routeApiTraffic: boolean;
  model?: string;
  httpMode?: string;
  attempts: number;
  successes: number;
  failures: number;
  waiting: boolean;
  activeRequest: boolean;
  lastError?: string;
  lastStartedAt?: string;
  lastReadyAt?: string;
}

interface AgentLike {
  agentId?: string;
  send(message: unknown, options: Record<string, unknown>): Promise<RunLike>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

interface RunLike {
  id?: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<unknown>;
  cancel?: () => Promise<unknown>;
}

interface QueuedRequest {
  input: CursorRunRequest;
  resolve: (result: CursorRunResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class PersistentAgentManager {
  private status: PersistentStatus["status"] = "idle";
  private routeApiTraffic = false;
  private options?: PersistentStartOptions;
  private attempts = 0;
  private successes = 0;
  private failures = 0;
  private waitingResolver?: (request: QueuedRequest) => void;
  private queue: QueuedRequest[] = [];
  private active?: QueuedRequest;
  private responseText = "";
  private agent?: AgentLike;
  private run?: RunLike;
  private stopped = false;
  private readyResolver?: () => void;
  private readyRejecter?: (error: unknown) => void;
  private readyPromise?: Promise<void>;
  private lastError?: string;
  private lastStartedAt?: string;
  private lastReadyAt?: string;

  getStatus(): PersistentStatus {
    return {
      status: this.status,
      routeApiTraffic: this.routeApiTraffic,
      model: this.options?.model,
      httpMode: this.options?.httpMode,
      attempts: this.attempts,
      successes: this.successes,
      failures: this.failures,
      waiting: Boolean(this.waitingResolver),
      activeRequest: Boolean(this.active),
      lastError: this.lastError,
      lastStartedAt: this.lastStartedAt,
      lastReadyAt: this.lastReadyAt
    };
  }

  setRouteApiTraffic(enabled: boolean): void {
    this.routeApiTraffic = enabled;
  }

  canRoute(): boolean {
    return this.routeApiTraffic && this.status === "ready";
  }

  start(options: PersistentStartOptions): void {
    void this.stop();
    this.options = options;
    this.routeApiTraffic = options.routeApiTraffic;
    this.status = "starting";
    this.stopped = false;
    this.attempts = 0;
    this.successes = 0;
    this.failures = 0;
    this.lastError = undefined;
    this.lastStartedAt = new Date().toISOString();
    this.lastReadyAt = undefined;
    void this.startLoop(options);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.status !== "idle") this.status = "stopping";
    this.rejectAll(new ApiError("Persistent agent stopped.", 503, "persistent_agent_stopped"));
    await this.run?.cancel?.().catch(() => undefined);
    await this.agent?.[Symbol.asyncDispose]?.().catch(() => undefined);
    this.agent?.close?.();
    this.agent = undefined;
    this.run = undefined;
    this.waitingResolver = undefined;
    this.active = undefined;
    this.responseText = "";
    this.status = "idle";
  }

  submit(input: CursorRunRequest): Promise<CursorRunResult> {
    if (!this.canRoute()) {
      throw new ApiError("Persistent agent is not ready.", 503, "persistent_agent_not_ready");
    }
    const timeoutMs = this.options?.responseTimeoutMs ?? 180_000;
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        input,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((item) => item !== request);
          if (this.active === request) this.active = undefined;
          reject(new ApiError("Persistent agent response timed out.", 504, "persistent_agent_timeout"));
        }, timeoutMs)
      };
      this.enqueue(request);
    });
  }

  private async startLoop(options: PersistentStartOptions): Promise<void> {
    for (let attempt = 1; attempt <= options.maxAttempts && !this.stopped; attempt += 1) {
      this.attempts = attempt;
      try {
        await this.startAttempt(options);
        return;
      } catch (error) {
        this.failures += 1;
        this.lastError = errorText(error);
        await this.cleanupAttempt();
      }
    }
    if (!this.stopped) this.status = "error";
  }

  private async startAttempt(options: PersistentStartOptions): Promise<void> {
    if (options.httpMode === "1.1") await applyCursorSdkNetworkConfig(true);
    if (options.httpMode === "2") await applyCursorSdkNetworkConfig(false);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    const { Agent } = await import("@cursor/sdk") as { Agent: { create(options: Record<string, unknown>): Promise<AgentLike> } };
    const model = modelSelection(options);
    const agent = await Agent.create({
      apiKey: options.apiKey,
      model,
      name: "Docker Composer API Persistent Agent",
      local: { cwd: options.cwd }
    });
    this.agent = agent;
    const run = await agent.send(buildInitialPrompt(options), {
      model,
      idempotencyKey: crypto.randomUUID(),
      local: {
        customTools: {
          wait_for_user_input: {
            description: "Wait for the next user request from the API gateway persistent session.",
            inputSchema: { type: "object", properties: {} },
            execute: async () => this.waitForUserInput()
          }
        }
      }
    });
    this.run = run;
    void this.consumeRun(run);
    await withTimeout(this.readyPromise, options.readyTimeoutMs, "Persistent agent did not enter wait tool in time.");
    this.status = "ready";
    this.successes += 1;
    this.lastReadyAt = new Date().toISOString();
  }

  private async consumeRun(run: RunLike): Promise<void> {
    try {
      for await (const event of run.stream()) {
        const text = textFromSdkEvent(event);
        if (text && this.active) this.responseText += text;
      }
      await run.wait().catch(() => undefined);
      if (this.active && this.responseText.trim()) this.finishActive();
      if (!this.stopped) {
        this.status = "error";
        this.lastError = "Persistent run ended.";
        this.rejectAll(new ApiError("Persistent run ended.", 502, "persistent_run_ended"));
      }
    } catch (error) {
      if (!this.stopped) {
        this.status = "error";
        this.lastError = errorText(error);
        this.readyRejecter?.(error);
        this.rejectAll(error);
      }
    }
  }

  private async waitForUserInput(): Promise<string> {
    if (this.active) this.finishActive();
    if (this.status === "starting") this.readyResolver?.();
    const request = await new Promise<QueuedRequest>((resolve) => {
      const next = this.queue.shift();
      if (next) {
        resolve(next);
        return;
      }
      this.waitingResolver = resolve;
    });
    this.waitingResolver = undefined;
    this.active = request;
    this.responseText = "";
    return [
      "NEXT_USER_REQUEST_FROM_API_GATEWAY:",
      `protocol: ${request.input.protocol}`,
      `sessionKey: ${request.input.sessionKey}`,
      "",
      request.input.prompt
    ].join("\n");
  }

  private enqueue(request: QueuedRequest): void {
    if (this.waitingResolver) {
      const resolve = this.waitingResolver;
      this.waitingResolver = undefined;
      resolve(request);
      return;
    }
    this.queue.push(request);
  }

  private finishActive(): void {
    const request = this.active;
    if (!request) return;
    clearTimeout(request.timer);
    const text = this.responseText.trim();
    this.active = undefined;
    this.responseText = "";
    request.resolve({
      text,
      toolCalls: [],
      agentId: this.agent?.agentId,
      runId: this.run?.id
    });
  }

  private rejectAll(error: unknown): void {
    const all = [...this.queue, ...(this.active ? [this.active] : [])];
    this.queue = [];
    this.active = undefined;
    for (const request of all) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private async cleanupAttempt(): Promise<void> {
    await this.run?.cancel?.().catch(() => undefined);
    await this.agent?.[Symbol.asyncDispose]?.().catch(() => undefined);
    this.agent?.close?.();
    this.agent = undefined;
    this.run = undefined;
    this.waitingResolver = undefined;
    this.active = undefined;
    this.responseText = "";
  }
}

export class PersistentRoutingRunner implements CursorRunner {
  constructor(
    private readonly manager: PersistentAgentManager,
    private readonly fallback: CursorRunner
  ) {}

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    if (!this.manager.canRoute()) return this.fallback.run(input, signal);
    if (signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");
    return this.manager.submit(input);
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    if (!this.manager.canRoute()) {
      yield* this.fallback.stream(input, signal);
      return;
    }
    const result = await this.run(input, signal);
    if (result.text) yield { type: "text", text: result.text };
    yield { type: "done", result };
  }
}

function buildInitialPrompt(options: PersistentStartOptions): string {
  return [
    options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    "",
    options.userPrompt?.trim() || DEFAULT_USER_PROMPT
  ].join("\n");
}

function modelSelection(options: PersistentStartOptions): Record<string, unknown> {
  return {
    id: options.model,
    ...(options.modelParams?.length ? { params: options.modelParams } : {})
  };
}

function textFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.delta === "string") return record.delta;
  if (record.type === "assistant") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.flatMap((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}
