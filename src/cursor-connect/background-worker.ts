import { randomUUID } from "node:crypto";
import type { UnifiedEvent } from "./events.js";
import { isGatewayGenerated } from "./events.js";
import type { CcRun, CursorConnectStore, DeliveryState, RunStatus } from "./store.js";
import { isTerminal } from "./store.js";

/**
 * background worker + 事件重放（计划 §G9）。
 *
 * 必须区分三种"恢复"，它们的可行性完全不同：
 *
 * - **客户端重新连接** = 重放网关已落库的事件。完全可控，已实现；
 * - **worker 重启** = 从 DB 恢复任务状态并续跑。完全可控，已实现（靠 lease）；
 * - **上游断点续传** = **不存在**。`InferenceStreamRequest` 的 12 个字段与
 *   `RunInferenceRunRequest` 的 5 个字段里都没有 offset / cursor / resumeToken，
 *   所以上游连接断掉后只能从 transcript / checkpoint 重建一个新请求。
 */

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_POLL_MS = 250;

export interface RunExecution {
  status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "awaiting_tool" | "awaiting_child">;
  errorJson?: string;
}

/** 真正跑一个 run。worker 只管 lease、状态机与事件顺序。 */
export type RunExecutor = (run: CcRun, signal: AbortSignal) => Promise<RunExecution>;

export interface BackgroundWorkerOptions {
  store: CursorConnectStore;
  execute: RunExecutor;
  owner?: string;
  leaseMs?: number;
  pollMs?: number;
  onEvent?: (event: UnifiedEvent) => void;
}

export class BackgroundWorker {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private running = false;
  /** 关停中：此时 execute 抛出的是我们自己 abort 造成的，不能记成 failed。 */
  private stopping = false;
  private loop?: Promise<void>;

  constructor(private readonly options: BackgroundWorkerOptions) {
    this.owner = options.owner ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    this.stopping = false;
  }

  /** 取一个 run 跑完。返回 false 表示当前没有可跑的。测试与单步驱动用。 */
  async tick(): Promise<boolean> {
    const run = this.options.store.acquireRunLease(this.owner, this.leaseMs);
    if (!run) return false;
    await this.runOne(run);
    return true;
  }

  private async pump(): Promise<void> {
    while (this.running) {
      const worked = await this.tick().catch(() => false);
      if (!worked && this.running) await delay(this.pollMs);
    }
  }

  private async runOne(run: CcRun): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      this.emit(run, "run.started", { attempt: run.attempt });
      const outcome = await this.options.execute(run, controller.signal);
      // 被 cancel 过就不要再用执行器的结局覆盖：cancel 已经把状态写成 cancelled，
      // 这里再写一次 completed 等于把用户的取消悄悄撤销。
      if (this.cancelled.delete(run.id)) return;
      if (outcome.errorJson) this.options.store.updateRun(run.id, { errorJson: outcome.errorJson });
      // 无论终态与否都要**放掉租约**。非终态（awaiting_tool / awaiting_child）如果还攥着租约，
      // 这条 run 既不会被这个 worker 继续跑，也不会被任何人接管——直接永久搁浅。
      this.options.store.releaseRunLease(run.id, outcome.status);
      this.emit(run, isTerminal(outcome.status) ? "run.finished" : "run.paused", { status: outcome.status });
    } catch (error) {
      if (this.stopping) {
        // 关停不是失败：把 run 放回 queued，让重启后的 worker 接着跑。
        this.options.store.releaseRunLease(run.id, "queued");
        this.emit(run, "run.paused", { reason: "worker shutting down" });
      } else {
        const message = error instanceof Error ? error.message : "run failed";
        this.options.store.updateRun(run.id, { errorJson: JSON.stringify({ message }) });
        this.options.store.releaseRunLease(run.id, "failed");
        // run.errored 而不是 run.failed：这是网关侧的失败，重跑一定能重新产生，
        // 而 run.failed 表示上游发来过一个失败帧，重跑结果可能完全不同。
        this.emit(run, "run.errored", { message });
      }
    } finally {
      this.controllers.delete(run.id);
      this.cancelled.delete(run.id);
    }
  }

  /**
   * 客户端断开**不**取消 background run，只有显式 cancel 才取消。
   *
   * 只动本 worker 手上的 run：跨 worker 去改一条自己没有租约的记录，
   * 会和持有它的那个 worker 的收尾写入互相覆盖。
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    this.cancelled.add(runId);
    this.options.store.releaseRunLease(runId, "cancelled");
    const run = this.options.store.run(runId);
    if (run) this.emit(run, "run.cancelled", {});
    return true;
  }

  private emit(
    run: CcRun,
    type: "run.started" | "run.errored" | "run.paused" | "run.cancelled" | "run.finished",
    payload: Record<string, unknown>
  ): void {
    const [event] = this.options.store.appendEvents(run.id, run.conversationId, [{ type, payload }], run.attempt);
    if (!event) return;
    try {
      this.options.onEvent?.(event);
    } catch {
      // 订阅方（SSE 连接）自己炸了不该把 worker 一起带走，也不该让这条 run 半途停下。
    }
  }
}

/**
 * 重放 + 订阅的衔接。
 *
 * 补发与 live 之间有竞态：先查"补发上界"再订阅，中间到达的事件会丢；
 * 反过来先订阅再查，会重复。这里的做法是**先订阅进缓冲区、再查补发**，
 * 然后按 seq 去重合并——重复可以靠 seq 去掉，丢失不行。
 */
export class ReplayBridge {
  private readonly buffer: UnifiedEvent[] = [];
  private live = false;

  constructor(
    private readonly store: CursorConnectStore,
    private readonly runId: string,
    /** 缓冲上限。缓冲里的事件都已经落库，溢出丢掉不会丢数据——backfill 会从库里查回来。 */
    private readonly maxBuffer = 4096
  ) {}

  /** 订阅侧调用：live 事件先进缓冲区，等 backfill 完成后才直接透传。 */
  push(event: UnifiedEvent): UnifiedEvent | undefined {
    if (!this.live) {
      // 只有 backfill 从不被调用时才会涨到这里；丢的都是库里还在的，不算丢事件。
      if (this.buffer.length < this.maxBuffer) this.buffer.push(event);
      return undefined;
    }
    return event;
  }

  /**
   * 补发 `afterSeq` 之后的历史，并把订阅期间缓冲的事件按 seq 去重后接上。
   * 返回的序列一定是 seq 严格递增、无重复、无空洞的。
   *
   * 重复调用返回空数组：第二次全量补发会把客户端已经收过的事件再发一遍。
   */
  backfill(afterSeq: number): UnifiedEvent[] {
    if (this.live) return [];

    // 必须翻页翻到空。`eventsAfter` 单页有上限，只查一页就切 live，
    // 一条长 run 的中间那段会被静默跳过，而且再也补不回来。
    const history: UnifiedEvent[] = [];
    for (let cursor = afterSeq; ; ) {
      const page = this.store.eventsAfter(this.runId, cursor);
      if (!page.length) break;
      history.push(...page);
      cursor = page[page.length - 1].seq;
    }

    const seen = new Set(history.map((event) => event.seq));
    const buffered = this.buffer.filter((event) => {
      if (event.seq <= afterSeq || seen.has(event.seq)) return false;
      seen.add(event.seq);
      return true;
    });
    this.buffer.length = 0;
    this.live = true;
    return [...history, ...buffered].sort((a, b) => a.seq - b.seq);
  }
}

/**
 * 断线后重建请求是否安全（计划 §G9 的重建安全规则）。
 *
 * 上游没有断点续传，所以"恢复"只能是重跑。重跑安全与否取决于已经交付了多少：
 * 已经把半截文本发给客户端的 run 重跑会重复输出，这种情况宁可标 `unknown`
 * 让调用方决定，也不要假装恢复成功。
 */
export function resumeDecision(run: CcRun, hasSideEffectingTools = false): {
  action: "skip" | "resume" | "await_tool" | "unknown";
  reason: string;
} {
  if (run.status === "completed") return { action: "skip", reason: "run already completed" };
  if (run.status === "cancelled") return { action: "skip", reason: "run was cancelled" };
  // 收全了 response_info 就等于这一轮已经完整交付，即使 status 还没来得及落成 completed。
  if (run.deliveryState === "complete") return { action: "skip", reason: "run already delivered a complete response" };
  if (run.status === "awaiting_tool" || run.status === "awaiting_child") {
    return { action: "await_tool", reason: `pending ${run.status === "awaiting_tool" ? "tool" : "child"} result; do not re-issue inference` };
  }
  if (hasSideEffectingTools) {
    return { action: "unknown", reason: "side-effecting local tools already ran; re-running is not safe" };
  }
  if (run.deliveryState === "partial_delivered") {
    return { action: "unknown", reason: "partial output already delivered; re-running would duplicate it" };
  }
  return { action: "resume", reason: "nothing delivered yet" };
}

/**
 * 事件是否值得为「重跑」重新产出。
 * 网关自造的事件重跑一定能重来；有上游帧支撑的重跑后内容可能不同。
 */
export function replayableAfterRerun(event: UnifiedEvent): boolean {
  return isGatewayGenerated(event.type);
}

/** 收到第一个有上游帧支撑的内容事件后，delivery_state 就不再是 none。 */
export function nextDeliveryState(current: DeliveryState, event: UnifiedEvent): DeliveryState {
  if (current === "complete") return current;
  if (event.type === "run.completed") return "complete";
  if (event.type === "text.delta" || event.type === "text.final" || event.type === "thinking.delta") {
    return "partial_delivered";
  }
  return current;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
