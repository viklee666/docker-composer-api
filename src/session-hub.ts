import { createHash } from "node:crypto";
import {
  DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS,
  DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS,
  DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS
} from "./config.js";
import { ApiError } from "./errors.js";

/**
 * 第一次 execute 之后排空并行工具的窗口。先 queueMicrotask，再等本常量毫秒（含 0ms）。
 * 单测经 SessionHubOptions.parallelToolSettleMs 注入。
 */
export const PARALLEL_TOOL_SETTLE_MS = 25;

export const TOOL_HOLD_EXPIRED_LOG = "[session-hub] tool hold expired";

/** cancel/dispose 挂死不能把 Hub 互斥锁卡住：后一个同会话请求会一直排队直到客户端断连（499）。 */
const RECYCLE_CLEANUP_MS = 5_000;

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

/**
 * pump 项的 run 印章：EventPump.push 时盖上（见 EventPump），消费方比对 slot.runId 判定归属，
 * 不匹配的项属于上一轮 run 的残留，丢弃。无印章 = 本次 send 早于 run 句柄就绪的窗口，按本 run 处理。
 */
export type HubPumpItem = (
  | { kind: "event"; event: unknown }
  | { kind: "captured"; id: string; name: string; args?: Record<string, unknown> }
  | { kind: "end"; error?: unknown }
) & { runId?: string };

/**
 * onDelta + stream 合流队列，可被第二条 HTTP 继续消费。
 *
 * 包 E：pump 项归属校验。`runId` 是本次 send 绑定的 run 印章——push 进来且尚未盖章的项
 * 视为属于当前 run（onDelta 早于 run 句柄就绪的窗口）；消费方按 `slot.runId` 比对印章，
 * 不匹配的项属于上一轮残留，丢弃（计划第 4 条，防止 park 住的旧 Run 事件被当作本轮输出）。
 */
export class EventPump {
  /** 本次 send 的 run id；新 attach 时由调用方设置。 */
  runId?: string;

  push(item: HubPumpItem): void {
    if (this.runId !== undefined) item.runId = this.runId;
    this.queue.push(item);
  }

  next(): Promise<HubPumpItem> {
    return this.queue.next();
  }

  /** 非阻塞取出；settle 窗口内收齐的并行 captured 走这里。 */
  poll(): HubPumpItem | undefined {
    return this.queue.poll();
  }

  /** 包 E：pump 里是否还有未消费项（重试续播可行性判定用）。 */
  hasQueued(): boolean {
    return this.queue.size > 0;
  }

  private readonly queue = new AsyncQueue<HubPumpItem>();
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
  /**
   * 包 E：已向客户端交付过语义输出（done 或 tool_call 已发出）的那轮的用户文本。
   * 与 lastUserText（send 后立即写，只表示「已发给上游」）分开：重试同一轮时
   * 已交付 ⇒ stateless 全量重跑，未交付 ⇒ 优先续播或退 stateless（计划第 6 条）。
   */
  deliveredUserText?: string;
  /** 包 E：上一轮 assistant 输出文本的摘要（normalize 后 sha256，不存原文）。 */
  lastAssistantDigest?: string;
  lastUsedAt: number;
  holdDeadline?: number;
  /** Tool call ids already served to the client (history rewrite detection). */
  issuedToolCallIds: string[];
  /**
   * Client-visible call ids that must resolve the same hung execute.
   * Responses rewrites `toolu_…` / UUID into `call_${suffix}`; Chat/Anthropic echo the execute id.
   */
  callAliases: Map<string, string>;
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
  /** cancel/dispose 上限；单测可缩短。 */
  recycleCleanupMs?: number;
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
  /**
   * 包 E 审阅修复（应修 1）：恢复槽（Agent.resume）的上一轮 assistant 输出摘要基线。
   * live 槽由 consumeDurablePump 收尾时记录自己交付的输出；resumed 槽没有这段内存，
   * 由调用方用入站 transcript 的上一条 assistant 摘要（turn.assistantDigest）播种，
   * 让恢复后的下一轮与 live 槽共用同一套分叉比对口径。
   */
  lastAssistantDigest?: string;
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
    lastAssistantDigest: input.lastAssistantDigest,
    lastUsedAt: 0,
    issuedToolCallIds,
    callAliases: new Map(),
    historyChecksum: input.historyChecksum ?? historyChecksum(issuedToolCallIds, input.lastUserText),
    resumed: input.resumed
  };
}

/** Anthropic `tool_use.id` / Cursor 回传的实际上限；超长 id 会被截断。 */
export const CLIENT_TOOL_CALL_ID_MAX = 64;

/**
 * SDK customTools 的 execute id 经常是 `call-<uuid>-N\nfc_<uuid>_0` 这种带换行的复合串。
 * 原样发给 Anthropic/Cursor 会被截成 64 字符，回传对不上 pending/issued，durable 误判 foreign。
 * 对外只保留第一行（通常 ≤64 且无控制字符）。
 */
export function sanitizeClientToolCallId(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return raw;
  const first = (text.split(/[\r\n]+/)[0] ?? "").trim();
  if (!first) {
    return `call_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
  }
  if (first.length <= CLIENT_TOOL_CALL_ID_MAX && !/\p{Cc}/u.test(first)) return first;
  if (/\p{Cc}/u.test(first)) {
    const cleaned = first.replace(/\p{Cc}/gu, "");
    if (cleaned && cleaned.length <= CLIENT_TOOL_CALL_ID_MAX) return cleaned;
    return `call_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
  }
  return first.slice(0, CLIENT_TOOL_CALL_ID_MAX);
}

/**
 * 把复合 / 截断 / `call_` 别名拆成可精确比对的 token。
 * 含整串、换行分段、超长时的 64 字符前缀，以及剥掉 `call_` 后的后缀。
 */
export function toolCallIdTokens(id: string): string[] {
  const out = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.add(trimmed);
    const stripped = trimmed.replace(/^call_/, "");
    if (stripped) out.add(stripped);
  };
  add(id);
  for (const part of id.split(/[\r\n]+/)) add(part);
  if (id.length > CLIENT_TOOL_CALL_ID_MAX) add(id.slice(0, CLIENT_TOOL_CALL_ID_MAX));
  return [...out];
}

export function toolCallIdsOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const rightTokens = new Set(toolCallIdTokens(right));
  return toolCallIdTokens(left).some((token) => rightTokens.has(token));
}

/** Responses `call_id`: strip a leading `call_`, then put it back so `foo` and `call_foo` collide. */
export function responsesCallId(id: string): string {
  const suffix = id.trim().replace(/^call_/, "");
  return suffix ? `call_${suffix}` : id;
}

/** Map a client-returned tool id onto the hung execute key, if any. */
export function canonicalHoldId(slot: SessionSlot, clientId: string): string | undefined {
  if (!clientId) return undefined;
  if (slot.pending.has(clientId)) return clientId;
  const aliased = slot.callAliases.get(clientId);
  if (aliased && slot.pending.has(aliased)) return aliased;
  for (const pendingId of slot.pending.keys()) {
    if (clientId === responsesCallId(pendingId) || pendingId === responsesCallId(clientId)) return pendingId;
    if (toolCallIdsOverlap(pendingId, clientId)) return pendingId;
  }
  for (const [alias, executeId] of slot.callAliases) {
    if (slot.pending.has(executeId) && toolCallIdsOverlap(alias, clientId)) return executeId;
  }
  return undefined;
}

export function rememberCallAlias(slot: SessionSlot, executeId: string, alias: string | undefined): void {
  if (!alias || alias === executeId) return;
  slot.callAliases.set(alias, executeId);
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

/** 包 E：assistant 文本一致性摘要口径——去全部空白后 sha256；入站（prompt-delta）与出站（slot）两侧共用。 */
export function assistantTextDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, "")).digest("hex");
}

/** 包 E：记录上一轮 assistant 输出摘要（交付后调用；只存哈希不存原文）。空文本不记录（保持 undefined，护栏不触发）。 */
export function recordAssistantDigest(slot: SessionSlot, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  slot.lastAssistantDigest = assistantTextDigest(trimmed);
}

/**
 * 包 E：标记「已向客户端交付语义输出」的轮次（done/tool_call 已发出之后调用）。
 * 与 lastUserText 的「已发送」分开（计划第 6 条）：重试判定据此选续播还是 stateless 重跑。
 */
export function markTurnDelivered(slot: SessionSlot): void {
  if (slot.lastUserText !== undefined) slot.deliveredUserText = slot.lastUserText;
}

/**
 * 包 E：入站 transcript 上一条 assistant 文本摘要与 slot 记录的上一轮输出摘要是否对不上。
 * 两侧都有值才比对（一侧缺号 = 无法证明分叉，放行，避免误伤 hitRatio）。
 */
export function inboundAssistantTextMismatch(
  slot: SessionSlot,
  assistantDigest: string | undefined
): boolean {
  return assistantDigest !== undefined
    && slot.lastAssistantDigest !== undefined
    && assistantDigest !== slot.lastAssistantDigest;
}

/**
 * 新鲜会话护栏：入站 transcript 一条 assistant 轮都没有（digest 缺号），而槽已经向
 * **另一个**客户端交付过语义输出（deliveredUserText 有值）——正常续聊的客户端会把
 * 历史（含之前的 assistant 回复）带回来，零 assistant 入站只可能是新会话的第一轮。
 * 内容推导身份（derived-L3）没有会话边界：同仓库 + 同模板 prompt 的并发新会话会推导出
 * 同一个 Hub 键，这条护栏挡住「会话 B 的第一轮直接 send 进带着 A 全部历史的 agent」。
 * 调用方据此退 stateless（与 history_mismatch 同口径），绝不 drop 槽。
 */
export function inboundFreshSessionOnDeliveredSlot(
  slot: SessionSlot,
  assistantDigest: string | undefined
): boolean {
  return assistantDigest === undefined && slot.deliveredUserText !== undefined;
}

export type DurableReplaceReason =
  | "incompatible"
  | "model"
  | "toolsFingerprint"
  | "history";

/**
 * 本轮为何不能复用 live slot。`incompatible` / model / toolsFingerprint /
 * rewritten history → 调用方 drop+create（D11）。undefined = 留槽。
 * systemFingerprint 变化不换槽。apiKey 变化不换槽（轮询换 key 必须复用同一 agent）。
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
    assistantDigest?: string;
  }
): DurableReplaceReason | undefined {
  if (input.kind === "incompatible") return "incompatible";
  if (!slot) return undefined;
  if (input.model !== undefined && slot.model !== input.model) return "model";
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
  input: { kind?: string; toolResults?: Array<{ id: string }>; prompt?: string; assistantDigest?: string }
): boolean {
  const issued = slot.issuedToolCallIds ?? [];
  if (!issued.length) {
    // 包 E：纯文本会话原先在这里直接放行，等于完全没有一致性护栏。
    // 现在比对入站上一条 assistant 文本摘要与 slot 记录的上一轮输出摘要（计划第 2 条）。
    // 对不上由调用方退 stateless（不 drop 槽）；本函数返回 true 只表达「历史对不上」。
    return inboundAssistantTextMismatch(slot, input.assistantDigest);
  }
  if (input.kind === "tool_results") {
    // Unmatched ids while execute is hung are abort+path B in the runner, not a history rewrite.
    return false;
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
  holdTtlMs: number;
  idleTtlMs: number;
  maxLiveSessions: number;
  readonly parallelToolSettleMs: number;
  readonly recycleCleanupMs: number;

  private readonly store: SessionHubStore | undefined;
  private readonly nowFn: () => number;
  private readonly usesFakeClock: boolean;
  private readonly slots = new Map<string, SessionSlot>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<Promise<void>>();
  /** 槽被回收时同步清理注册方按 session 记的边车状态（runner 的 ordinals / consumedExecutes / capturedPumps）。 */
  private readonly dropListeners: Array<(sessionId: string) => void> = [];

  constructor(options: SessionHubOptions = {}) {
    this.holdTtlMs = positiveBound(options.holdTtlMs, DEFAULT_CURSOR_SDK_TOOL_HOLD_TTL_MS);
    this.idleTtlMs = positiveBound(options.idleTtlMs, DEFAULT_CURSOR_SDK_SESSION_IDLE_TTL_MS);
    this.maxLiveSessions = positiveBound(options.maxLiveSessions, DEFAULT_CURSOR_SDK_MAX_LIVE_SESSIONS);
    this.parallelToolSettleMs = options.parallelToolSettleMs ?? PARALLEL_TOOL_SETTLE_MS;
    this.recycleCleanupMs = positiveBound(options.recycleCleanupMs, RECYCLE_CLEANUP_MS);
    this.store = options.store;
    this.usesFakeClock = typeof options.now === "function";
    this.nowFn = options.now ?? Date.now;
  }

  /** 后台改 TTL / 上限后立即作用于后续 sweep / hold / 新槽，不丢现有会话。 */
  configure(patch: { holdTtlMs?: number; idleTtlMs?: number; maxLiveSessions?: number }): void {
    if (patch.holdTtlMs !== undefined) this.holdTtlMs = positiveBound(patch.holdTtlMs, this.holdTtlMs);
    if (patch.idleTtlMs !== undefined) this.idleTtlMs = positiveBound(patch.idleTtlMs, this.idleTtlMs);
    if (patch.maxLiveSessions !== undefined) this.maxLiveSessions = positiveBound(patch.maxLiveSessions, this.maxLiveSessions);
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

    const { previous, release } = this.bindLock(sessionId);

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

  /**
   * 非阻塞互斥。已有 lockTails 则立刻 undefined：不 sweep、不 set、不 touch、不挂 waiter。
   * 空闲则先 sweep（与 acquire 开头相同），再检查 has；仍空则 bindLock + touch，马上返回 release，
   * 不等待前一位。重叠 POST 探测走这里；可短等路径仍用 acquire。
   */
  async tryAcquire(sessionId: string): Promise<(() => void) | undefined> {
    if (this.lockTails.has(sessionId)) return undefined;
    await this.sweep();
    if (this.lockTails.has(sessionId)) return undefined;
    const { release } = this.bindLock(sessionId);
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
    rememberCallAlias(slot, toolCallId, responsesCallId(toolCallId));
    for (const token of toolCallIdTokens(toolCallId)) {
      rememberCallAlias(slot, toolCallId, token);
    }
  }

  resolvePending(sessionId: string, toolCallId: string, result: unknown): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) return false;
    const holdId = canonicalHoldId(slot, toolCallId);
    if (!holdId) return false;
    const pending = slot.pending.get(holdId);
    if (!pending) return false;
    slot.pending.delete(holdId);
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
    // 包 E 审阅修复（应修 2）：Hub 内部回收（idle/hold/LRU）不走 runner 的 dropDurableSession，
    // 注册方按 session 记的边车 Map（runOrdinals / consumedExecutes / capturedPumps）会一直漏清。
    // 回收时同步通知，清理失败不影响回收主流程。
    for (const listener of this.dropListeners) {
      try {
        listener(sessionId);
      } catch {
        // best-effort cleanup only
      }
    }
    await this.recycle(sessionId, slot, reason);
  }

  /**
   * 包 E 审阅修复（应修 2）：注册「槽被回收」监听。drop（显式或 idle/hold/LRU 内部回收）
   * 都会触发，供 runner 清理按 session 记的边车状态，防止 Map 随会话数无界增长。
   */
  onDrop(listener: (sessionId: string) => void): void {
    this.dropListeners.push(listener);
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
      await withCleanupTimeout(slot.run?.cancel?.(), this.recycleCleanupMs);
    } catch {
      // best-effort
    }
    await withCleanupTimeout(disposeHubAgent(slot.agent), this.recycleCleanupMs);
    // Idle/hold/LRU drop must deleteSession so Agent.resume cannot revive a disposed agent.
    if (this.store) {
      try {
        await this.store.deleteSession(sessionId);
      } catch {
        // best-effort
      }
    }
  }

  /** 登记 held / release / lockTails；不等待前一位。acquire 与 tryAcquire 共用。 */
  private bindLock(sessionId: string): { previous: Promise<void>; release: () => void } {
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
    return { previous, release };
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

  /** 包 E：仍在队列里的项数（不含已交给 resolver 的）；供 hasQueued 判定。 */
  get size(): number {
    return this.items.length;
  }

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
  return new ApiError("Request was aborted.", 499, "request_aborted");
}

function withCleanupTimeout(promise: Promise<unknown> | undefined, ms = RECYCLE_CLEANUP_MS): Promise<void> {
  if (!promise) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
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
