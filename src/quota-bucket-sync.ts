import type { CursorBotStore } from "./cursor-bot/store.js";
import type { CursorKeyPool } from "./key-pool.js";
import { resolveQuotaBucket, type ModelQuotaBucketStore, type QuotaBucket, type QuotaBucketHooks } from "./quota-buckets.js";

/**
 * 额度桶的双向联动（包 B，计划 §3.6 第 8 条）。
 *
 * 一把 Cursor key 与「用它兑换出来的 bot 凭据」背后是同一个账号，额度池也是同一个：
 * - bot 凭据撞上 resource_exhausted ⇒ 凭据与源 key 的**同一个桶**一起标耗尽；
 * - key 的桶被标耗尽（SDK 侧 / 后台入口）⇒ 由它兑换出来的凭据同步标上；
 * - 桶级标记两侧都**不走 disable**（key / 凭据保持 active），只是选路时避开该桶；
 *   402（账号级欠费）是唯一例外：整把凭据 / key 一起禁用（disableSourceKey）。
 *
 * 集中在一个协调器里而不是两边互调：Bot 与 SDK 的存储本来互不引用（见 cursor-bot/store.ts
 * 的头注释），在这里碰面一次，比让 service 握 key 池、key 池反握 bot store 的交叉依赖干净。
 */
export class QuotaBucketSync implements QuotaBucketHooks {
  constructor(
    private readonly targets: {
      keyPool: CursorKeyPool;
      /** Bot 路线未装载时缺省：只剩 key 侧的单向标记。 */
      botStore?: CursorBotStore;
      table: ModelQuotaBucketStore;
    }
  ) {}

  resolveBucket(model?: string, vendorIsCursor?: boolean): QuotaBucket {
    return resolveQuotaBucket(
      model,
      this.targets.table.load(),
      vendorIsCursor === undefined ? undefined : { isCursor: vendorIsCursor }
    );
  }

  /** bot 凭据的桶耗尽：标凭据，再经 sourceCursorKeyId 同步标源 key（fire-and-forget，不阻塞请求收尾）。 */
  markCredentialExhausted(credentialId: string, bucket: QuotaBucket, expiresAt: string): void {
    const store = this.targets.botStore;
    if (!store) return;
    const credential = store.credential(credentialId);
    if (!credential) return;
    store.markCredentialBucketExhausted(credential.id, bucket, expiresAt);
    if (!credential.sourceCursorKeyId) return;
    void this.targets.keyPool
      .markQuotaBucketExhausted(credential.sourceCursorKeyId, bucket, expiresAt)
      .catch((error: unknown) => {
        console.error(`[quota-buckets] failed to mark source key ${credential.sourceCursorKeyId}: ${errorText(error)}`);
      });
  }

  /** key 的桶耗尽：标 key，再反查由它兑换出来的 bot 凭据同步标上（双向联动的另一侧）。 */
  async markKeyBucket(keyId: string, bucket: QuotaBucket, expiresAt: string): Promise<boolean> {
    // 直接调 key 池的原始方法而不是绕回 markCredentialExhausted：两个方向各走各的，
    // 谁也不调谁，联动才不会成环（SDK 侧标桶的入口也走这里，同一约定）。
    const ok = await this.targets.keyPool.markQuotaBucketExhausted(keyId, bucket, expiresAt);
    if (ok) {
      const credential = this.targets.botStore?.credentialBySourceKeyId(keyId);
      if (credential) this.targets.botStore?.markCredentialBucketExhausted(credential.id, bucket, expiresAt);
    }
    return ok;
  }

  /**
   * bot 凭据撞 402（账号级欠费）：联动禁用源 Cursor key，走 key-pool 的 quota 语义
   * （一次即禁，fire-and-forget，不阻塞请求收尾）。同上，只调 key 池的原始方法，不成环。
   */
  disableSourceKey(keyId: string, detail?: string): void {
    void this.targets.keyPool.disable(keyId, "quota", detail).catch((error: unknown) => {
      console.error(`[quota-buckets] failed to disable source key ${keyId}: ${errorText(error)}`);
    });
  }

  /** 后台「清除额度标记」：key 与由它兑换的 bot 凭据一起清，语义与人工 enable（清失败计数）分开。 */
  async clearKeyBuckets(keyId: string): Promise<boolean> {
    const ok = await this.targets.keyPool.clearQuotaBuckets(keyId);
    const credential = this.targets.botStore?.credentialBySourceKeyId(keyId);
    if (credential) this.targets.botStore?.clearCredentialQuotaBuckets(credential.id);
    return ok;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}
