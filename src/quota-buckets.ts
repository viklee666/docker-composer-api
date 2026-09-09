import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 额度分桶（包 B，计划 §3.6）。
 *
 * Cursor 的账号额度不是一整块：Cursor 自家模型（composer 系）与第三方模型（claude / grok 等）
 * 各有各的池子。某类模型额度耗尽只该让 key 避开那一类，而不是整把禁用——
 * 账号级欠费（402 / unpaid invoice）才是整把禁用的事，那部分在 key-pool 的 reportFailure 里。
 *
 * 桶取值目前两个：`cursor`（Cursor 自家模型的额度池）与 `other`（其余全部）。
 */
export type QuotaBucket = "cursor" | "other";

/** 人工维护的模型 → 桶主表（data/model-quota-buckets.json）。 */
export interface ModelQuotaBucketTable {
  /** 模型 id（大小写不敏感）→ 桶。 */
  models: Record<string, QuotaBucket>;
  /** 表里查不到时的兜底桶。 */
  default: QuotaBucket;
}

/** 文件缺失 / 内容非法时的兜底表：全按 other 处理（保守：不因分桶误伤任何 key）。 */
export const DEFAULT_QUOTA_BUCKET_TABLE: ModelQuotaBucketTable = { models: {}, default: "other" };

/**
 * 桶标记的默认存活时长。上游 EndStream 帧只说「resource_exhausted」，不带回重置时间点，
 * 先按 1 小时冷却：到期懒清除 + 一次成功即清（recordSuccess / recordCredentialUse）双保险，
 * 标早了只是一次多余的失败尝试，标晚了会白丢一段可用额度。
 */
export const DEFAULT_QUOTA_BUCKET_RESET_MS = 60 * 60 * 1000;

function normalizeBucket(value: unknown): QuotaBucket | undefined {
  return value === "cursor" || value === "other" ? value : undefined;
}

/**
 * 校验并归一化一份外部输入的表（admin PUT / 文件内容）。
 * 非法返回 undefined，由调用方决定报 400 还是退回兜底表；单条非法的模型项直接丢弃
 * （丢弃后该模型回落 default / vendor 推断，不会让整张表失效）。
 */
export function parseQuotaBucketTable(value: unknown): ModelQuotaBucketTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const defaultBucket = normalizeBucket(record.default) ?? "other";
  const models: Record<string, QuotaBucket> = {};
  const rawModels = record.models;
  if (rawModels !== undefined) {
    if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return undefined;
    for (const [model, bucket] of Object.entries(rawModels as Record<string, unknown>)) {
      const name = model.trim().toLowerCase();
      const normalized = normalizeBucket(bucket);
      if (name && normalized) models[name] = normalized;
    }
  }
  return { models, default: defaultBucket };
}

/**
 * 模型 → 桶的判定链（计划 §3.6 第 5 条）：
 * 1. 主表（人工维护）命中即用；
 * 2. 查不到时用 available_models 的 vendor 推断：Cursor 系归 cursor 桶，其余归 other；
 * 3. vendor 也推断不出（SDK 目录没有 vendor 字段 / 目录没拉到）按表 default，通常即 other——
 *    保守方向：归类不确定时宁可试错也不提前把 key 从候选里剔掉。
 */
export function resolveQuotaBucket(
  model: string | undefined,
  table: ModelQuotaBucketTable,
  vendor?: { isCursor?: boolean }
): QuotaBucket {
  const name = model?.trim().toLowerCase();
  if (name) {
    const hit = table.models[name];
    if (hit) return hit;
  }
  if (vendor?.isCursor === true) return "cursor";
  return table.default === "cursor" ? "cursor" : "other";
}

/** 该桶是否仍处于耗尽期（标记存在且未到期）。到期即视为未耗尽（懒清除的读取侧）。 */
export function bucketExhausted(
  marks: Record<string, string> | undefined,
  bucket: QuotaBucket,
  nowMs = Date.now()
): boolean {
  const until = marks?.[bucket];
  if (!until) return false;
  const ts = Date.parse(until);
  return Number.isFinite(ts) && ts > nowMs;
}

/**
 * 剔掉已到期的桶标记。返回原引用表示没有可剔的（调用方据此免掉一次写库）；
 * 全部剔完返回 undefined，部分剔完返回新对象。
 */
export function pruneExhaustedBuckets(
  marks: Record<string, string> | undefined,
  nowMs = Date.now()
): Record<string, string> | undefined {
  if (!marks) return undefined;
  let changed = false;
  const kept: Record<string, string> = {};
  for (const [bucket, until] of Object.entries(marks)) {
    const ts = Date.parse(until);
    if (Number.isFinite(ts) && ts > nowMs) kept[bucket] = until;
    else changed = true;
  }
  if (!changed) return marks;
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Bot 路线需要的额度桶钩子（由 quota-bucket-sync.ts 的 QuotaBucketSync 实现，index.ts 装配）。
 * service 只依赖这个接口，不直接握 key 池——Bot 与 SDK 两条路线的存储互不引用，
 * 双向联动（凭据 ↔ 源 key）集中在一个协调器里做。
 */
export interface QuotaBucketHooks {
  /** 把请求模型解析到额度桶；vendorIsCursor 是 available_models 的 vendor 推断结果（可选）。 */
  resolveBucket(model?: string, vendorIsCursor?: boolean): QuotaBucket;
  /** 标记一把 bot 凭据的桶耗尽，并经 sourceCursorKeyId 同步标记源 Cursor key。 */
  markCredentialExhausted(credentialId: string, bucket: QuotaBucket, expiresAt: string): void;
  /**
   * bot 凭据撞 402（账号级欠费）时联动禁用兑换出它的源 Cursor key，走 key-pool 的
   * quota 语义（一次即禁）。可选：只关心桶标记的装配（测试桩）可以不实现。
   */
  disableSourceKey?(keyId: string, detail?: string): void;
}

/**
 * `data/model-quota-buckets.json` 的读写器（进程内缓存一份，后台保存后立即生效）。
 * 文件与状态库同目录（dirname(SQLITE_PATH)），运维备份状态目录时一起走。
 */
export class ModelQuotaBucketStore {
  private cache?: ModelQuotaBucketTable;

  constructor(private readonly filePath: string) {}

  /** 文件缺失 / 内容非法 → 兜底表（全 other），不让一张坏表把选路打挂。 */
  load(): ModelQuotaBucketTable {
    if (this.cache) return this.cache;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      return DEFAULT_QUOTA_BUCKET_TABLE;
    }
    this.cache = parseQuotaBucketTable(parsed) ?? DEFAULT_QUOTA_BUCKET_TABLE;
    return this.cache;
  }

  /** 落盘并刷新缓存。输入必须是 parseQuotaBucketTable 的产物（admin 侧先校验再存）。 */
  save(table: ModelQuotaBucketTable): ModelQuotaBucketTable {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    this.cache = table;
    return table;
  }
}
