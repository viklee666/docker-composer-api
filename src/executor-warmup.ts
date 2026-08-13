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

interface WarmLease {
  /** 预热完成后拿到的释放函数；预热失败或已被抢先回收时为 undefined。 */
  release?: () => Promise<void>;
  pending: Promise<void>;
  touchedAt: number;
}

export class ExecutorWarmPool implements ExecutorLeaseManager {
  private readonly leases = new Map<string, WarmLease>();
  private readonly cooldownUntil = new Map<string, number>();
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

  async warm(apiKey: string, workingDirectory: string): Promise<void> {
    if (!apiKey) return;
    const id = leaseId(apiKey, workingDirectory);
    if (this.now() < (this.cooldownUntil.get(id) ?? 0)) return;
    const existing = this.leases.get(id);
    if (existing) {
      existing.touchedAt = this.now();
      await existing.pending.catch(() => undefined);
      return;
    }
    const lease: WarmLease = { pending: Promise.resolve(), touchedAt: this.now() };
    // 先挂上真实的 pending 再登记：否则并发 warm 可能撞见占位的 resolved promise，误判预热已完成。
    lease.pending = (async () => {
      const platform = await this.loadPlatform();
      const release = await platform?.prewarmLocalWorkspace?.({
        apiKey,
        local: { cwd: workingDirectory, settingSources: [] }
      });
      // 预热还没跑完就被 recycle 摘掉了：这份租约已无人保管，必须立刻释放，
      // 否则它会以「谁也解不掉的引用」把坏执行器继续钉在 SDK 缓存里。
      if (this.leases.get(id) !== lease) {
        await release?.().catch(() => undefined);
        return;
      }
      lease.release = release;
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
    this.leases.delete(id);
    await lease.pending.catch(() => undefined);
    await lease.release?.().catch(() => undefined);
  }

  /** 释放全部租约（关停/测试收尾用），让 SDK 能回收所有共享执行器。 */
  async releaseAll(): Promise<void> {
    const leases = [...this.leases.values()];
    this.leases.clear();
    for (const lease of leases) {
      await lease.pending.catch(() => undefined);
      await lease.release?.().catch(() => undefined);
    }
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
      this.leases.delete(oldestId);
      void evicted.pending
        .catch(() => undefined)
        .then(() => evicted.release?.().catch(() => undefined));
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

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
