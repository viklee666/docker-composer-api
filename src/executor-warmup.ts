import { createHash } from "node:crypto";
import type { ExecutorLeaseManager } from "./types.js";

/**
 * Cursor SDK 的本地执行器在进程内是「共享 + 引用计数」的：缓存键由
 * (workingDirectory, dirs, apiKey 哈希, settingSources, mcpServers, sandboxOptions …) 决定，
 * 只有引用计数归零时才会被移出缓存并 dispose。
 *
 * 关键问题：执行器持有的鉴权拦截器会把「API key 兑换 access token」的失败**永久**缓存在闭包里——
 * 命中之后每个请求都立刻重抛同一个鉴权错误，既没有 TTL，也没有任何重置路径
 *（拦截器自带的 Unauthenticated 重试会先撞上这个已缓存的错误）。
 * 于是上游一次偶发的兑换失败，就会让这个共享执行器此后的所有请求全部失败，直到它被 dispose。
 *
 * 网关此前在启动时预热工作区却丢弃了 prewarmLocalWorkspace() 返回的 release()，
 * 等于给该执行器永久加了一个引用：引用计数再也回不到 0 → 坏掉的执行器永远不会被回收。
 * 对外表现正是「跑一段时间后所有请求都 502、等再久也不恢复、换一把新 key（换了缓存键）
 * 或重启容器才好」，且与并发无关——一死全死。
 *
 * 这里把预热租约收归网关自己保管：平时持有租约以省掉冷启动开销；一旦上游报鉴权类错误就
 * 立即释放，并在冷却期内不再重新预热——留出窗口让在途请求结束、引用计数归零，
 * SDK 自然 dispose 掉坏执行器，下一个请求即可拿到全新的执行器与全新的鉴权闭包。
 */

/** SDK 平台对象里网关唯一需要的能力：预热本地工作区并拿回租约的释放函数。 */
export interface WarmupPlatform {
  prewarmLocalWorkspace?(options: Record<string, unknown>): Promise<() => Promise<void>>;
}

/**
 * 释放租约后暂不重新预热的时长。回收要真正生效必须让引用计数归零，
 * 因此得留出窗口等在途请求收尾——被污染的执行器上请求都是秒失败，这个窗口绰绰有余。
 */
const DEFAULT_RECYCLE_COOLDOWN_MS = 60_000;
/** 同时持有的预热租约上限（key 池可能有多把 key），防止无界增长。 */
const DEFAULT_MAX_LEASES = 8;
/**
 * 一次释放（含等预热落地 + 调 release）的总时限。
 * 调用方要么是正在等响应的管理请求，要么是收到 SIGTERM 的关停流程，两个都等不起无限久；
 * 等不动的租约会留在表里，下一次再试，而不是被丢掉。
 */
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;

interface WarmLease {
  /** 预热完成后拿到的释放函数；预热失败或已被抢先回收时为 undefined。 */
  release?: () => Promise<void>;
  pending: Promise<void>;
  touchedAt: number;
  /** 已经进入回收流程的租约不能再被 warm 当成健康租约复用。 */
  retiring?: boolean;
  /** 同一份租约可能被多个清理路径同时观察，保留动作只能登记一次。 */
  retained?: boolean;
  /**
   * 已经发起、但还没返回的释放动作。重试时必须复用它：
   * 对同一份租约调两次 release 会把 SDK 的引用计数减穿，连别人的引用一起解掉。
   */
  releasing?: Promise<void>;
}

/** 超时与真失败要分开处理，所以给超时一个可识别的类型。 */
class ReleaseTimeout extends Error {
  constructor() {
    super("超时");
    this.name = "ReleaseTimeout";
  }
}

export interface ExecutorReleaseReport {
  ok: boolean;
  failures: readonly string[];
}

export class ExecutorWarmPool implements ExecutorLeaseManager {
  private readonly leases = new Map<string, WarmLease>();
  private readonly cooldownUntil = new Map<string, number>();
  /** 释放没收尾、但 id 上已经有新租约的那些孤儿：句柄不能丢，只能另找地方存着等下次重试。 */
  private readonly orphans: WarmLease[] = [];
  /** 溢出回收可能还没来得及把失败租约登记回表；全量释放必须把这批在途动作也等完。 */
  private readonly settling = new Set<Promise<string | undefined>>();
  private lastFailures: readonly string[] = [];
  private readonly loadPlatform: () => Promise<WarmupPlatform | undefined>;
  private readonly cooldownMs: number;
  private readonly maxLeases: number;
  private readonly now: () => number;

  constructor(input: {
    loadPlatform: () => Promise<WarmupPlatform | undefined>;
    cooldownMs?: number;
    maxLeases?: number;
    /** 测试注入时钟，避免用真实等待验证冷却窗口。 */
    now?: () => number;
  }) {
    this.loadPlatform = input.loadPlatform;
    this.cooldownMs = positiveOr(input.cooldownMs, DEFAULT_RECYCLE_COOLDOWN_MS);
    this.maxLeases = positiveOr(input.maxLeases, DEFAULT_MAX_LEASES);
    this.now = input.now ?? (() => Date.now());
  }

  /** 当前持有的租约数，供测试与排查用。 */
  get size(): number {
    return this.leases.size;
  }

  /**
   * 上一次释放里没能收尾的原因（空数组＝全部释放成功）。
   * 释放失败等于 SDK 不会回收那个执行器，静默吞掉就等于把泄漏藏起来；
   * 这个数组、日志里的告警、以及 releaseAll 之后仍然大于 0 的 size 是运维仅有的三条线索。
   */
  get releaseFailures(): readonly string[] {
    return this.lastFailures;
  }

  async warm(apiKey: string, workingDirectory: string): Promise<void> {
    if (!apiKey) return;
    const id = leaseId(apiKey, workingDirectory);
    if (this.now() < (this.cooldownUntil.get(id) ?? 0)) return;
    const existing = this.leases.get(id);
    if (existing) {
      existing.touchedAt = this.now();
      if (existing.retiring) {
        // 释放失败留下的句柄不能继续给请求复用；先尝试把旧执行器收干净，
        // 这里连 pending 也必须沿用截止时间，避免预热本身卡住后 warm 无界等待。
        const failure = await this.trackSettle(id, existing, releaseDeadline());
        this.reportFailures(failure ? [failure] : []);
        if (failure) return;
        if (this.leases.get(id) === existing) this.leases.delete(id);
      } else {
        await existing.pending.catch(() => undefined);
        return;
      }
    }
    const lease: WarmLease = { pending: Promise.resolve(), touchedAt: this.now(), retiring: false, retained: false };
    // 先挂上真实的 pending 再登记：否则并发 warm 可能撞见占位的 resolved promise，误判预热已完成。
    lease.pending = (async () => {
      const platform = await this.loadPlatform();
      const release = await platform?.prewarmLocalWorkspace?.({
        apiKey,
        local: { cwd: workingDirectory, settingSources: [] }
      });
      lease.release = release;
      // 预热还没跑完就被 recycle 摘掉了：这份租约已无人保管，必须立刻释放，
      // 否则它会以「谁也解不掉的引用」把坏执行器继续钉在 SDK 缓存里。
      if (this.leases.get(id) !== lease) {
        // 不能在 pending 内等待 settle：recycle 可能正等 pending 落地，互相等待会把晚到的 release 卡死。
        void this.trackSettle(id, lease, releaseDeadline()).then((failure) => {
          if (failure) this.reportFailures([failure]);
        });
      }
    })();
    this.leases.set(id, lease);
    this.evictOverflow(id);
    try {
      await lease.pending;
    } catch (error) {
      if (this.leases.get(id) === lease) this.leases.delete(id);
      throw error;
    }
  }

  async recycle(apiKey: string, workingDirectory: string): Promise<void> {
    if (!apiKey) return;
    const id = leaseId(apiKey, workingDirectory);
    this.cooldownUntil.set(id, this.now() + this.cooldownMs);
    this.trimCooldowns();
    const lease = this.leases.get(id);
    if (!lease) return;
    lease.retiring = true;
    lease.retained = false;
    this.leases.delete(id);
    // recycle 跑在请求的错误处理路径上，卡住就是这个请求卡住，同样要有时限。
    const failure = await this.trackSettle(id, lease, releaseDeadline());
    this.reportFailures(failure ? [failure] : []);
  }

  /**
   * 释放全部租约（关停 / 运行期切 HTTP/1.1 / 测试收尾），让 SDK 能回收所有共享执行器。
   *
   * 两条硬性要求：
   * 一是必须有时限——调用方是正在等响应的管理请求，而 release() 底下是 SDK 的 dispose，
   * 它卡住就是整个「保存设置」卡住；
   * 二是没释放成功的租约必须留在表里——那个 release 函数是解开这份引用的唯一句柄，
   * 先摘表再吞异常等于把句柄弄丢，执行器从此永久钉在 SDK 缓存里（正是本文件开头描述的那种泄漏）。
   * 返回值必须把失败带给上层，后台保存网络设置才能提醒运维而不是报一个假成功。
   */
  async releaseAll(options: { timeoutMs?: number } = {}): Promise<ExecutorReleaseReport> {
    const deadline = releaseDeadline(options.timeoutMs);
    const entries = [...this.leases.entries()];
    const orphans = this.orphans.splice(0, this.orphans.length);
    for (const [, lease] of entries) {
      lease.retiring = true;
      lease.retained = false;
    }
    for (const lease of orphans) {
      lease.retiring = true;
      lease.retained = false;
    }
    this.leases.clear();
    // 并发释放：一份卡住的租约不该把其余几份的时间窗也耗光。
    const tasks = new Set<Promise<string | undefined>>(this.settling);
    for (const [id, lease] of entries) tasks.add(this.trackSettle(id, lease, deadline));
    for (const lease of orphans) tasks.add(this.trackSettle(undefined, lease, deadline));
    const settled = await Promise.all(tasks);
    const failures = settled.filter((failure): failure is string => failure !== undefined);
    this.reportFailures(failures);
    return { ok: failures.length === 0, failures: [...failures] };
  }

  /**
   * 把异步释放登记起来：溢出回收是后台触发的，若全量 reset 恰好撞上它，
   * 不等这份 promise 就会把「仍在释放」误报成「没有租约」。
   */
  private trackSettle(id: string | undefined, lease: WarmLease, deadline: number): Promise<string | undefined> {
    const task = this.settle(id, lease, deadline).catch((error: unknown) => {
      const failure = `释放失败（${describeLease(id)}）：${errorText(error)}`;
      this.retain(id, lease);
      return failure;
    });
    this.settling.add(task);
    void task.then(() => this.settling.delete(task));
    return task;
  }

  /**
   * 释放一份租约：先等预热落地（没落地就还没有 release 可调），再调 release，两步共用一个截止时间。
   * 返回失败原因，成功返回 undefined；任何一步没走完都会把租约放回去等下次重试。
   */
  private async settle(id: string | undefined, lease: WarmLease, deadline: number): Promise<string | undefined> {
    lease.retiring = true;
    try {
      await raceDeadline(lease.pending, deadline);
    } catch (error) {
      // 预热本身失败（不是超时）意味着压根没抓到引用，没有句柄可留，直接算收尾。
      if (!(error instanceof ReleaseTimeout)) return undefined;
      this.retain(id, lease);
      return `预热仍未完成，租约暂留待下次释放（${describeLease(id)}）`;
    }
    return this.releaseSettled(id, lease, deadline);
  }

  /** pending 已经落地后的释放步骤，供回收流程与晚到的预热共用，避免重复调用 release。 */
  private async releaseSettled(id: string | undefined, lease: WarmLease, deadline: number): Promise<string | undefined> {
    if (!lease.release) return undefined;
    if (!lease.releasing) {
      let started: Promise<void>;
      try {
        started = lease.release();
      } catch (error) {
        this.retain(id, lease);
        return `释放失败（${describeLease(id)}）：${errorText(error)}`;
      }
      // 超时之后没人再 await 它，挂个空 catch 免得变成进程级的未处理 rejection。
      started.catch(() => undefined);
      lease.releasing = started;
    }
    try {
      await raceDeadline(lease.releasing, deadline);
      return undefined;
    } catch (error) {
      // 超时的要保住在途 promise（下次复用，绝不重复调 release）；
      // 真失败的要清掉，好让下一次重新发起一次干净的释放。
      if (!(error instanceof ReleaseTimeout)) lease.releasing = undefined;
      this.retain(id, lease);
      return `释放失败（${describeLease(id)}）：${errorText(error)}`;
    }
  }

  /** 把没能释放的租约放回去。id 上已经有新租约时不能覆盖它，只能挂到孤儿列表上。 */
  private retain(id: string | undefined, lease: WarmLease): void {
    if (lease.retained) return;
    lease.retained = true;
    if (id !== undefined && !this.leases.has(id)) {
      this.leases.set(id, lease);
      return;
    }
    this.orphans.push(lease);
  }

  private reportFailures(failures: string[]): void {
    this.lastFailures = failures;
    if (failures.length === 0) return;
    console.warn(
      `[executor-warmup] ${failures.length} 份预热租约未能释放，SDK 不会回收对应执行器（下次释放会重试）：${failures.join("；")}`
    );
  }

  private evictOverflow(keepId: string): void {
    while (this.leases.size > this.maxLeases) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, lease] of this.leases) {
        if (id === keepId) continue;
        if (lease.touchedAt < oldestAt) {
          oldestAt = lease.touchedAt;
          oldestId = id;
        }
      }
      const evicted = oldestId === undefined ? undefined : this.leases.get(oldestId);
      if (oldestId === undefined || !evicted) break;
      evicted.retiring = true;
      evicted.retained = false;
      this.leases.delete(oldestId);
      void this.trackSettle(oldestId, evicted, releaseDeadline()).then(
        (failure) => {
          if (failure) this.reportFailures([failure]);
        }
      );
    }
  }

  private trimCooldowns(): void {
    const now = this.now();
    for (const [id, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(id);
    }
    while (this.cooldownUntil.size > this.maxLeases * 4) {
      const oldest = this.cooldownUntil.keys().next().value;
      if (oldest === undefined) break;
      this.cooldownUntil.delete(oldest);
    }
  }
}

/** 租约身份 = SDK 执行器缓存键里网关会变动的两部分：apiKey 与工作目录（settingSources 恒为 []）。 */
function leaseId(apiKey: string, workingDirectory: string): string {
  return createHash("sha256").update(`${apiKey}\0${workingDirectory}`).digest("hex");
}

/** 截止时间一律走真实时钟：注入的 now() 是给冷却窗口用的假时钟，拿它算超时会永远等不到。 */
function releaseDeadline(timeoutMs?: number): number {
  return Date.now() + positiveOr(timeoutMs, DEFAULT_RELEASE_TIMEOUT_MS);
}

function raceDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ReleaseTimeout());
  return new Promise<T>((resolve, reject) => {
    // 刻意不 unref：调用方正 await 这个 promise，定时器一旦不算数，
    // 「有时限」就退化成「事件循环空了就永远不返回」，关停与保存设置都会挂在这里。
    // 计时器只在真的等待期间存在（work 落地即 clearTimeout），最多多留进程 5 秒。
    const timer = setTimeout(() => reject(new ReleaseTimeout()), remaining);
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

/** 日志里只写租约 id 的前 8 位：它是 apiKey 的哈希，全量写出来对排查没有额外价值。 */
function describeLease(id: string | undefined): string {
  return id === undefined ? "孤儿租约" : `租约 ${id.slice(0, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
