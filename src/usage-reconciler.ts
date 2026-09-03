import { parseSdkUsage } from "./cursor-runner.js";
import type { RequestCost, RequestUsage, StateStore } from "./types.js";

export interface ReconcileInput {
  /** request_logs 主键，用于回写。 */
  logId: string;
  agentId: string;
  /** 调用 getUsage 用的 Cursor key（必须是跑这次请求的那个 key）。 */
  apiKey: string;
}

export interface UsageReconcilerOptions {
  store: StateStore;
  /** 延迟多久再查，等上游计费事件落地。默认 15s。 */
  delayMs?: number;
  /** 最多查几次（累计 cost 可能是旧值，所以无论是否有值都按界限轮询）。默认 3。 */
  maxAttempts?: number;
  /** 单次 getUsage 最多等待多久；SDK 没有提供可传入的 AbortSignal，所以这里必须自行兜底。默认 10s。 */
  getUsageTimeoutMs?: number;
  /** drain 最多等待多久；超过后放弃尚未开始的任务并让关停继续。默认 30s。 */
  drainTimeoutMs?: number;
  /** 注入用，便于测试。默认动态 import("@cursor/sdk") 的 Agent.getUsage。 */
  getUsage?: (agentId: string, apiKey: string) => Promise<{ usage?: RequestUsage; cost?: RequestCost }>;
  /**
   * 是否按 agent 记基线、只把增量写进本条日志。默认开（多记一行基线总比重复计费安全）。
   * 关掉 session resume 时每个请求都是全新 agent，增量恒等于累计值，
   * 这时落基线只会让 `agent_usage_baselines` 跟着请求数一起无界增长，所以 index.ts 会显式关掉它。
   * durable / 旧 resume 必须开：`getUsage` 是 agent 累计值，本条 HTTP 只能记增量，不能把首轮金额再加一遍。
   * 函数形式让后台切换会话模式后立即生效。
   */
  trackAgentBaseline?: boolean | (() => boolean);
}

const DEFAULT_DELAY_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_GET_USAGE_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
/**
 * 同时在飞的补写数量。getUsage 是对 api.cursor.com 的真实网络调用，
 * 上游按 key 限速（同 get_models 的每分钟 30 次量级），并发压到个位数即可。
 */
const CONCURRENCY = 2;
/** 退避上限，避免 delayMs 配大后单条补写拖太久。 */
const MAX_BACKOFF_MS = 60_000;
/** drain() 等待期间的事件循环保活间隔（见 drain 的注释）。 */
const DRAIN_KEEPALIVE_MS = 25;

interface PendingTask {
  input: ReconcileInput;
  attempt: number;
}

/**
 * 上游计费金额的带外补写。
 *
 * token 用量在请求路径上就能从 SDK 流里免费拿到，但金额是 Cursor 服务端算的、
 * 最终一致的：run 刚结束时 cost 往往还不存在。所以这里独立排队、延迟重查，
 * 绝不参与 HTTP 响应的关键路径，也绝不把异常抛给调用方。
 */
export class UsageReconciler {
  private readonly store: StateStore;
  private readonly delayMs: number;
  private readonly maxAttempts: number;
  private readonly getUsageTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly getUsage: (agentId: string, apiKey: string) => Promise<{ usage?: RequestUsage; cost?: RequestCost }>;
  private readonly resolveTrackAgentBaseline: () => boolean;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly queue: PendingTask[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private drainKeepAlive?: NodeJS.Timeout;
  private drainDeadline?: NodeJS.Timeout;
  private active = 0;
  private closed = false;
  private drainExpired = false;

  constructor(options: UsageReconcilerOptions) {
    this.store = options.store;
    this.delayMs = positiveMs(options.delayMs, DEFAULT_DELAY_MS);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.getUsageTimeoutMs = positiveMs(options.getUsageTimeoutMs, DEFAULT_GET_USAGE_TIMEOUT_MS);
    this.drainTimeoutMs = positiveMs(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
    this.getUsage = options.getUsage ?? fetchAgentUsage;
    const track = options.trackAgentBaseline ?? true;
    this.resolveTrackAgentBaseline = typeof track === "function" ? track : () => track;
  }

  private trackAgentBaseline(): boolean {
    return this.resolveTrackAgentBaseline();
  }

  /** 排入一次补写；不抛异常、不阻塞调用方。 */
  schedule(input: ReconcileInput): void {
    try {
      if (this.closed) return;
      if (!input?.logId || !input?.agentId || !input?.apiKey) return;
      this.enqueueAfter({ input, attempt: 1 }, this.delayMs);
    } catch (error) {
      console.error(`[usage-reconciler] failed to schedule a cost backfill: ${errorText(error)}`);
    }
  }

  /** 等待队列排空（测试与优雅关闭用）。 */
  drain(): Promise<void> {
    if (this.idle() || this.drainExpired) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      // 等待中的网络调用只剩 Promise 引用时，事件循环可能没有可见的 ref；
      // 有人明确等待排空时才临时保活，避免 drain 在关停路径上悬空；同时设置硬上限，
      // 否则一个永不 settle 的上游调用会让 SIGTERM 永远挂着。
      this.drainKeepAlive ??= setInterval(() => undefined, DRAIN_KEEPALIVE_MS);
      this.drainDeadline ??= setTimeout(() => this.expireDrain(), this.drainTimeoutMs);
    });
  }

  /** 停止后续调度，但已接受的任务仍必须完成；调用方应随后 await drain()。 */
  close(): void {
    this.closed = true;
    this.pump();
  }

  private pending(): number {
    return this.timers.size + this.queue.length + this.active;
  }

  private idle(): boolean {
    return this.pending() === 0;
  }

  private enqueueAfter(task: PendingTask, ms: number): void {
    if (this.drainExpired) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.queue.push(task);
      this.pump();
    }, Math.max(0, ms));
    // 这里刻意不 unref：已接受的退避任务必须在关停时仍能被 drain() 看见并执行，
    // 不能为了让进程尽快退出而把一笔金额变成幽灵任务。
    this.timers.add(timer);
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      this.active += 1;
      const settle = () => {
        this.active -= 1;
        this.pump();
      };
      void this.execute(task).then(settle, settle);
    }
    this.settleDrain();
  }

  /** 单次补写。内部吞掉所有异常：这是尽力而为的旁路，失败只记日志。 */
  private async execute(task: PendingTask): Promise<void> {
    try {
      const result = await this.getUsageWithTimeout(task.input);
      const cost = result?.cost;
      const booked = cost ? await this.bookCost(task.input.logId, task.input.agentId, cost) : undefined;
      // getUsage 的 usage 是 agent 累计值，不属于这条 request log 的单次遥测；本次用量只认请求路径捕获的 usage。
      // tracked 模式的 store 方法已经把金额和基线放进同一事务，不能再用第二次 update 覆盖同一行的累计增量。
      if (booked && !this.trackAgentBaseline()) {
        await this.store.updateRequestLogUsage(task.input.logId, undefined, booked);
      }
      // 累计值没有增长时，既可能是免费请求，也可能是计费副本尚未更新；
      // 在上界前继续轮询，最后仍没有增量时至少落一行明确的 0。
      // 这会牺牲极晚到达的金额，但不会把累计总额再当成单次金额写进去。
      if (
        !booked &&
        this.trackAgentBaseline() &&
        cost &&
        task.attempt >= this.maxAttempts
      ) {
        await this.store.updateRequestLogUsage(
          task.input.logId,
          undefined,
          { rawCostCents: 0, chargedCents: 0 }
        );
      }
      // 累计 cost 有值也可能只是旧副本；若本轮没有新增金额，不能把它当作本次 run 已纳入。
      // 一旦有新增金额便停止，避免同一 agent 的后续 run 在本条日志的有界轮询期间被误摊进来。
      if (
        task.attempt < this.maxAttempts &&
        (this.trackAgentBaseline() ? !booked : !cost)
      ) {
        this.enqueueAfter({ input: task.input, attempt: task.attempt + 1 }, this.backoffMs(task.attempt));
      }
    } catch (error) {
      console.error(`[usage-reconciler] cost backfill failed for log=${task.input.logId}: ${errorText(error)}`);
      if (task.attempt < this.maxAttempts) {
        this.enqueueAfter({ input: task.input, attempt: task.attempt + 1 }, this.backoffMs(task.attempt));
      }
    }
  }

  private getUsageWithTimeout(input: ReconcileInput): Promise<{ usage?: RequestUsage; cost?: RequestCost }> {
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<{ usage?: RequestUsage; cost?: RequestCost }>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`getUsage timed out after ${this.getUsageTimeoutMs}ms`)),
        this.getUsageTimeoutMs
      );
      // 超时只是旁路补写的自我保护，不能因为它的计时器又阻止进程退出。
      timer.unref?.();
      Promise.resolve()
        .then(() => this.getUsage(input.agentId, input.apiKey))
        .then(resolve, reject);
    });
    return result.finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * `agent.getUsage()` 返回的是**整个 agent** 的累计金额。session resume 打开时同一个 agent 会服务多个请求，
   * 把累计值原样写进第二条日志，等于把第一条的金额又记了一遍。所以这里换成「上次记账之后新增的那部分」。
   *
   * 每次增量写入都在 store 内和基线推进共用事务；同一累计值的重复轮询不会重复记账，
   * 但累计值是否已包含本次 run 无法从返回值判断，所以由 maxAttempts 提供明确的上界。
   * 同一 agent 的两条补写撞在一起时，基线的读-改-写在 store 里是原子的：先到的拿走全部增量、
   * 后到的拿到 0，合计仍然正确——累计口径本来就没法把一笔钱摊回具体哪一次 run。
   */
  private async bookCost(logId: string, agentId: string, cost: RequestCost): Promise<RequestCost | undefined> {
    if (!this.trackAgentBaseline()) return cost;
    return this.store.bookAgentUsageDeltaForRequest(logId, agentId, cost);
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.delayMs * 2 ** attempt, MAX_BACKOFF_MS);
  }

  private settleDrain(): void {
    if (!this.idle()) return;
    this.finishDrainWaiters();
  }

  private expireDrain(): void {
    if (this.idle()) {
      this.settleDrain();
      return;
    }
    const delayed = this.timers.size;
    const queued = this.queue.length;
    const active = this.active;
    const pending = delayed + queued + active;
    this.drainExpired = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
    console.error(
      `[usage-reconciler] drain timed out after ${this.drainTimeoutMs}ms; ` +
      `abandoning ${pending} backfills (${delayed} delayed, ${queued} queued, ${active} in flight)`
    );
    this.finishDrainWaiters();
  }

  private finishDrainWaiters(): void {
    while (this.drainWaiters.length) this.drainWaiters.shift()?.();
    if (this.drainDeadline) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    if (this.drainKeepAlive) {
      clearInterval(this.drainKeepAlive);
      this.drainKeepAlive = undefined;
    }
  }
}

/**
 * Fastify 关闭会等待已经进入处理流程的请求；先关 HTTP 入口，再拒绝新的 schedule，
 * 才不会把在途请求刚完成的金额补写挡在 reconciler 的 closed 闸门外。
 */
export async function closeAppThenDrainUsage(
  closeApp: () => Promise<unknown>,
  reconciler: UsageReconciler
): Promise<void> {
  await closeApp();
  reconciler.close();
  await reconciler.drain();
}

/**
 * 默认实现：静态 `Agent.getUsage(agentId, { apiKey })`。
 * 每一级属性都用可选链，SDK 换名 / 移除导出时退化成「查不到 cost」而不是抛错，
 * 与 models.ts 调用 Cursor.models.list 的写法保持一致。
 */
async function fetchAgentUsage(
  agentId: string,
  apiKey: string
): Promise<{ usage?: RequestUsage; cost?: RequestCost }> {
  const sdk = await import("@cursor/sdk") as Record<string, unknown>;
  const agent = sdk.Agent as
    | { getUsage?: (agentId: string, options: { apiKey: string }) => Promise<unknown> }
    | undefined;
  // 不按 runId 收窄：本地 agent 的 runs[].runId 是计费侧的 usage UUID，
  // 传客户端那个 run-<uuid> 标签会直接抛 ConfigurationError。
  const result = await agent?.getUsage?.(agentId, { apiKey });
  const record = asRecord(result);
  const usage = parseSdkUsage(record?.usage);
  const cost = parseUsageCost(record?.cost);
  return { ...(usage ? { usage } : {}), ...(cost ? { cost } : {}) };
}

/** UsageCost 是「美分浮点数」；0 是套餐内 / BYOK / 赠额用量的正常取值，不能当成没有 cost。 */
function parseUsageCost(value: unknown): RequestCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawCostCents = finiteNumber(record.rawCostCents);
  const chargedCents = finiteNumber(record.chargedCents);
  if (rawCostCents === undefined && chargedCents === undefined) return undefined;
  return { rawCostCents: rawCostCents ?? 0, chargedCents: chargedCents ?? 0 };
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
