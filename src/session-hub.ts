import { createHash } from "node:crypto";
import {
  DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS,
  DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS,
  DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS
} from "./config.js";

/**
 * 第一次 execute 之后排空并行工具的窗口。先 queueMicrotask，再等本常量毫秒（含 0ms）。
 * 单测经 SessionHubOptions.parallelToolSettleMs 注入。
 */
export const PARALLEL_TOOL_SETTLE_MS = 25;

export const TOOL_HOLD_EXPIRED_LOG = "[session-hub] tool hold expired";

export type SessionSlotState = "running" | "awaiting_tools" | "idle" | "dead";

/** 与 cursor-runner AgentLike 结构兼容，本模块不 import runner（WP4 会反向依赖 Hub）。 */
export interface HubAgent {
  agentId?: string;
  send(message: unknown, options?: Record<string, unknown>): Promise<HubRun>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

export interface HubRun {
  id?: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<unknown>;
  cancel?: () => Promise<unknown>;
}

export interface PendingExecute {
  name: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export type HubPumpItem =
  | { kind: "event"; event: unknown }
  | { kind: "captured"; id: string; name: string; args?: Record<string, unknown> }
  | { kind: "end"; error?: unknown };

/**
 * onDelta + stream 合流队列，可被第二条 HTTP 继续消费。
 */
export class EventPump {
  private readonly queue = new AsyncQueue<HubPumpItem>();

  push(item: HubPumpItem): void {
    this.queue.push(item);
  }

  next(): Promise<HubPumpItem> {
    return this.queue.next();
  }

  /** 非阻塞取出；settle 窗口内收齐的并行 captured 走这里。 */
  poll(): HubPumpItem | undefined {
    return this.queue.poll();
  }
}

export interface SessionSlot {
  state: SessionSlotState;
  agent: HubAgent;
  agentId: string;
  run?: HubRun;
  runId?: string;
  apiKey: string;
  model: string;
  toolsFingerprint: string;
  systemFingerprint: string;
  pending: Map<string, PendingExecute>;
  pump: EventPump;
  waitPromise?: Promise<unknown>;
  lastUserText?: string;
  lastUsedAt: number;
  holdDeadline?: number;
  /** Tool call ids already served to the client (history rewrite detection). */
  issuedToolCallIds: string[];
  /** sha256(sorted issued ids + lastUserText). */
  historyChecksum: string;
  /** True when the handle came from Agent.resume (do not re-send STABLE_DIRECTIVE). */
  resumed?: boolean;
}

export interface SessionHubStore {
  deleteSession(id: string): Promise<boolean>;
}

export interface SessionHubOptions {
  holdTtlMs?: number;
  idleTtlMs?: number;
  maxLiveSessions?: number;
  parallelToolSettleMs?: number;
  store?: SessionHubStore;
  /** 注入时钟；提供时不挂真实 hold setTimeout，单测用 sweep() 过期。 */
  now?: () => number;
}

export interface CreateSessionSlotInput {
  agent: HubAgent;
  agentId: string;
  apiKey: string;
  model: string;
  toolsFingerprint?: string;
  systemFingerprint?: string;
  run?: HubRun;
  runId?: string;
  state?: SessionSlotState;
  lastUserText?: string;
  waitPromise?: Promise<unknown>;
  issuedToolCallIds?: string[];
  historyChecksum?: string;
  resumed?: boolean;
}

type RecycleReason = "idle" | "hold" | "lru" | "explicit";

export function createSessionSlot(input: CreateSessionSlotInput): SessionSlot {
  const issuedToolCallIds = input.issuedToolCallIds ? [...input.issuedToolCallIds] : [];
  return {
    state: input.state ?? "running",
    agent: input.agent,
    agentId: input.agentId,
    run: input.run,
    runId: input.runId,
    apiKey: input.apiKey,
    model: input.model,
    toolsFingerprint: input.toolsFingerprint ?? "",
    systemFingerprint: input.systemFingerprint ?? "",
    pending: new Map(),
    pump: new EventPump(),
    waitPromise: input.waitPromise,
    lastUserText: input.lastUserText,
    lastUsedAt: 0,
    issuedToolCallIds,
    historyChecksum: input.historyChecksum ?? historyChecksum(issuedToolCallIds, input.lastUserText),
    resumed: input.resumed
  };
}

/** Stable checksum of served tool_call ids + last user text (D11 history rewrite). */
export function historyChecksum(issuedToolCallIds: Iterable<string>, lastUserText?: string): string {
  const ids = [...issuedToolCallIds].filter(Boolean).sort().join(",");
  return createHash("sha256").update(`${ids}\0${lastUserText ?? ""}`).digest("hex");
}

export function recordIssuedToolCalls(slot: SessionSlot, ids: Iterable<string>): void {
  const issued = slot.issuedToolCallIds ?? [];
  let changed = false;
  for (const id of ids) {
    if (!id || issued.includes(id)) continue;
    issued.push(id);
    changed = true;
  }
  slot.issuedToolCallIds = issued;
  if (changed || !slot.historyChecksum) {
    slot.historyChecksum = historyChecksum(issued, slot.lastUserText);
  }
}

export function touchSlotHistory(slot: SessionSlot, lastUserText?: string): void {
  if (lastUserText !== undefined) slot.lastUserText = lastUserText;
  slot.historyChecksum = historyChecksum(slot.issuedToolCallIds ?? [], slot.lastUserText);
}

export type DurableReplaceReason =
  | "incompatible"
  | "model"
  | "apiKey"
  | "systemFingerprint"
  | "toolsFingerprint"
  | "history";

/**
 * Why this inbound turn cannot reuse the live slot. `incompatible` / model / apiKey /
 * fingerprint / rewritten history → caller must drop+create (D11). Undefined = keep slot.
 */
export function durableSlotReplaceReason(
  slot: SessionSlot | undefined,
  input: {
    kind?: string;
    apiKey?: string;
    model?: string;
    systemFingerprint?: string;
    toolsFingerprint?: string;
    toolResults?: Array<{ id: string }>;
    prompt?: string;
  }
): DurableReplaceReason | undefined {
  if (input.kind === "incompatible") return "incompatible";
  if (!slot) return undefined;
  if (input.apiKey !== undefined && slot.apiKey !== input.apiKey) return "apiKey";
  if (input.model !== undefined && slot.model !== input.model) return "model";
  if (slot.systemFingerprint && input.systemFingerprint && slot.systemFingerprint !== input.systemFingerprint) {
    return "systemFingerprint";
  }
  if (slot.toolsFingerprint && input.toolsFingerprint && slot.toolsFingerprint !== input.toolsFingerprint) {
    return "toolsFingerprint";
  }
  if (inboundHistoryIncompatible(slot, input)) return "history";
  return undefined;
}

/**
 * Issued tool_call ids missing from inbound, and this is not a valid tool result
 * (nor a user-cancel new_user while awaiting_tools).
 */
export function inboundHistoryIncompatible(
  slot: SessionSlot,
  input: { kind?: string; toolResults?: Array<{ id: string }>; prompt?: string }
): boolean {
  const issued = slot.issuedToolCallIds ?? [];
  if (!issued.length) return false;
  if (input.kind === "tool_results") {
    const resultIds = new Set((input.toolResults ?? []).map((item) => item.id));
    const pendingIds = [...slot.pending.keys()];
    const needed = pendingIds.length > 0 ? pendingIds : issued;
    return !needed.some((id) => resultIds.has(id));
  }
  if (input.kind === "new_user" && slot.state === "awaiting_tools") return false;
  const prompt = input.prompt ?? "";
  if (issued.some((id) => id && prompt.includes(id))) return false;
  return input.kind === "new_user" && slot.state === "idle";
}

export async function settleParallelTools(ms: number = PARALLEL_TOOL_SETTLE_MS): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  if (ms > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/**
 * 进程内 durable 会话槽：互斥、挂起 execute、TTL / LRU 回收。
 * Map 键由调用方提供（`durableSessionId(...)`），禁止用 ownerHash。
 *
 * WP4 主路径：put → attachPump →（工具）registerHold / beginAwaitingTools
 * → resolvePending → markIdle；不要的槽 drop。
 */
export class SessionHub {
  readonly holdTtlMs: number;
  readonly idleTtlMs: number;
  readonly maxLiveSessions: number;
  readonly parallelToolSettleMs: number;

  private readonly store: SessionHubStore | undefined;
  private readonly nowFn: () => number;
  private readonly usesFakeClock: boolean;
  private readonly slots = new Map<string, SessionSlot>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: SessionHubOptions = {}) {
    this.holdTtlMs = positiveBound(options.holdTtlMs, DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS);
    this.idleTtlMs = positiveBound(options.idleTtlMs, DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS);
    this.maxLiveSessions = positiveBound(options.maxLiveSessions, DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS);
    this.parallelToolSettleMs = options.parallelToolSettleMs ?? PARALLEL_TOOL_SETTLE_MS;
    this.store = options.store;
    this.usesFakeClock = typeof options.now === "function";
    this.nowFn = options.now ?? Date.now;
  }

  get size(): number {
    return this.slots.size;
  }

  get(sessionId: string): SessionSlot | undefined {
    const slot = this.slots.get(sessionId);
    if (!slot) return undefined;
    const reason = this.expiryReason(slot);
    if (reason) {
      this.track(this.drop(sessionId, reason));
      return undefined;
    }
    return slot;
  }

  put(sessionId: string, slot: SessionSlot): void {
    const updating = this.slots.has(sessionId);
    if (!updating) this.evictToFit(sessionId);
    this.slots.delete(sessionId);
    slot.lastUsedAt = this.nowFn();
    this.slots.set(sessionId, slot);
  }

  /**
   * 同一 session 串行。返回的函数即 release；必须在 finally 里调用。
   * 等待期间 abort → 让出队列位置，不取消已经 awaiting_tools 的槽。
   */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    await this.sweep();
    if (signal?.aborted) throw abortError(signal);

    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const previous = this.lockTails.get(sessionId) ?? Promise.resolve();
    const tail = previous.catch(() => undefined).then(() => held);
    this.lockTails.set(sessionId, tail);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      unlock();
      if (this.lockTails.get(sessionId) === tail) this.lockTails.delete(sessionId);
    };

    try {
      await this.waitForPrevious(previous, signal);
    } catch (error) {
      release();
      throw error;
    }
    if (signal?.aborted) {
      release();
      throw abortError(signal);
    }
    this.touch(sessionId);
    return release;
  }

  release(releaseFn: () => void): void {
    releaseFn();
  }

  attachPump(sessionId: string, pump?: EventPump): EventPump {
    const slot = this.slots.get(sessionId);
    if (!slot) throw new Error(`session-hub: no slot for attachPump (${sessionId})`);
    if (pump) slot.pump = pump;
    return slot.pump;
  }

  registerHold(
    sessionId: string,
    toolCallId: string,
    name: string,
    resolve: PendingExecute["resolve"],
    reject: PendingExecute["reject"]
  ): void {
    const slot = this.slots.get(sessionId);
    if (!slot) {
      reject(new Error(`session-hub: no slot for hold (${sessionId})`));
      return;
    }
    slot.pending.set(toolCallId, { name, resolve, reject });
  }

  resolvePending(sessionId: string, toolCallId: string, result: unknown): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) return false;
    const pending = slot.pending.get(toolCallId);
    if (!pending) return false;
    slot.pending.delete(toolCallId);
    pending.resolve(result);
    this.touch(sessionId);
    if (slot.pending.size === 0 && slot.state === "awaiting_tools") {
      slot.state = "running";
      slot.holdDeadline = undefined;
      this.clearHoldTimer(sessionId);
    }
    return true;
  }

  rejectPending(sessionId: string, toolCallId: string, reason?: unknown): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) return false;
    const pending = slot.pending.get(toolCallId);
    if (!pending) return false;
    slot.pending.delete(toolCallId);
    pending.reject(reason);
    this.touch(sessionId);
    return true;
  }

  beginAwaitingTools(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.state = "awaiting_tools";
    slot.holdDeadline = this.nowFn() + this.holdTtlMs;
    this.armHoldTimer(sessionId);
    this.touch(sessionId);
  }

  markRunning(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.state = "running";
    slot.holdDeadline = undefined;
    this.clearHoldTimer(sessionId);
    this.touch(sessionId);
  }

  markIdle(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.state = "idle";
    slot.holdDeadline = undefined;
    this.clearHoldTimer(sessionId);
    this.touch(sessionId);
  }

  async settleParallelTools(ms?: number): Promise<void> {
    await settleParallelTools(ms ?? this.parallelToolSettleMs);
  }

  async drop(sessionId: string, reason: RecycleReason = "explicit"): Promise<void> {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    this.slots.delete(sessionId);
    this.clearHoldTimer(sessionId);
    slot.state = "dead";
    if (reason === "hold") console.error(TOOL_HOLD_EXPIRED_LOG);
    await this.recycle(sessionId, slot, reason);
  }

  async dropAll(): Promise<void> {
    const ids = [...this.slots.keys()];
    await Promise.all(ids.map((id) => this.drop(id, "explicit")));
    await this.flush();
  }

  async sweep(): Promise<void> {
    for (const [sessionId, slot] of [...this.slots]) {
      const reason = this.expiryReason(slot);
      if (reason) this.track(this.drop(sessionId, reason));
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.inflight.size) return;
    await Promise.all([...this.inflight]);
  }

  private touch(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.lastUsedAt = this.nowFn();
    this.slots.delete(sessionId);
    this.slots.set(sessionId, slot);
  }

  private expiryReason(slot: SessionSlot): RecycleReason | undefined {
    const now = this.nowFn();
    if (slot.state === "awaiting_tools" && slot.holdDeadline !== undefined && now >= slot.holdDeadline) {
      return "hold";
    }
    if (slot.state === "idle" && now - slot.lastUsedAt >= this.idleTtlMs) return "idle";
    if (slot.state === "dead") return "idle";
    return undefined;
  }

  private evictToFit(keepId: string): void {
    while (this.slots.size >= this.maxLiveSessions) {
      const victim = this.pickLruVictim(keepId);
      if (!victim) break;
      this.track(this.drop(victim, "lru"));
    }
  }

  private pickLruVictim(keepId: string): string | undefined {
    const ids = [...this.slots.keys()].filter((id) => id !== keepId);
    for (const id of ids) {
      const state = this.slots.get(id)?.state;
      if (state === "idle" || state === "dead") return id;
    }
    for (const id of ids) {
      if (this.slots.get(id)?.state === "awaiting_tools") return id;
    }
    return ids[0];
  }

  private armHoldTimer(sessionId: string): void {
    this.clearHoldTimer(sessionId);
    if (this.usesFakeClock) return;
    const slot = this.slots.get(sessionId);
    const delay = Math.max(0, (slot?.holdDeadline ?? this.nowFn() + this.holdTtlMs) - this.nowFn());
    const timer = setTimeout(() => {
      this.holdTimers.delete(sessionId);
      this.track(this.drop(sessionId, "hold"));
    }, delay);
    timer.unref();
    this.holdTimers.set(sessionId, timer);
  }

  private clearHoldTimer(sessionId: string): void {
    const timer = this.holdTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.holdTimers.delete(sessionId);
  }

  private track(job: Promise<void>): void {
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
  }

  private async recycle(sessionId: string, slot: SessionSlot, reason: RecycleReason): Promise<void> {
    const error = recycleError(sessionId, reason);
    for (const pending of slot.pending.values()) {
      try {
        pending.reject(error);
      } catch {
        // reject 本身不该抛；防护调用方 resolve/reject 抛错
      }
    }
    slot.pending.clear();
    try {
      await slot.run?.cancel?.();
    } catch {
      // best-effort
    }
    await disposeHubAgent(slot.agent);
    // Idle/hold/LRU drop must deleteSession so Agent.resume cannot revive a disposed agent.
    if (this.store) {
      try {
        await this.store.deleteSession(sessionId);
      } catch {
        // best-effort
      }
    }
  }

  private async waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    const waited = previous.catch(() => undefined);
    if (!signal) {
      await waited;
      return;
    }
    await Promise.race([waited, abortPromise(signal)]);
  }
}

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

  poll(): T | undefined {
    return this.items.shift();
  }
}

async function disposeHubAgent(agent: HubAgent): Promise<void> {
  const asyncDispose = agent[Symbol.asyncDispose];
  if (asyncDispose) {
    await asyncDispose.call(agent).catch(() => undefined);
    return;
  }
  try {
    agent.close?.();
  } catch {
    // best-effort cleanup only
  }
}

function recycleError(sessionId: string, reason: RecycleReason): Error {
  if (reason === "hold") return new Error("tool hold expired");
  return new Error(`session dropped (${reason}): ${sessionId}`);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("aborted");
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

function positiveBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
