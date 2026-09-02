import { resolveModelParams, type ModelCatalog, type ModelIntent } from "../model-params.js";
import type { ModelParameterValue } from "../types.js";
import type { ConnectRequestedModel } from "./request-builder.js";

/**
 * 目录查询口。
 *
 * **不实现 `aiserver.v1.AiService/AvailableModels` 的 Connect 调用**：
 * 那两个消息（`AvailableModelsRequest` / `AvailableModelsResponse`）不在
 * `docs/reference/inference-descriptor-8844.txt` 里，本仓库的硬约束是协议字段只从该文件读。
 * 在拿到对应 descriptor 之前，目录只能由调用方注入——现成的实现是
 * `src/models.ts` 的 `getModelCatalogEntry`（SDK 侧目录，同样给出参数定义与 variants）。
 */
export type ModelCatalogPort = (modelId: string, credentialKey?: string) => Promise<ModelCatalog | undefined>;

export interface CatalogCacheOptions {
  ttlMs?: number;
  failureTtlMs?: number;
  maxEntries?: number;
  /** 供测试注入。 */
  now?: () => number;
}

/** 默认缓存 5 分钟：目录按账号可见性变化，但也不该每个请求都回源。 */
export const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * 查询**失败**只缓存 10 秒。按完整 TTL 记住一次瞬时故障，
 * 等于让一个网络抖动把之后 5 分钟的请求全部降级到家族兜底，且期间一次都不重试。
 * 但也不能不缓存——目录持续不可用时每个请求都回源会把它压得更死。
 */
export const DEFAULT_CATALOG_FAILURE_TTL_MS = 10 * 1000;

/**
 * 条目上限。缓存键含 `modelId`，而 `modelId` 是**调用方可控**的：
 * 不设上限时，一串随便编的模型名就能把这张表撑到内存耗尽。
 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 512;

interface CacheEntry {
  value: ModelCatalog | undefined;
  expiresAt: number;
}

/**
 * 按「凭据 + 模型」分片的目录缓存。
 *
 * 分片键必须含凭据：不同账号可见的模型与参数定义不同，
 * 共用一份缓存会把 A 账号的参数定义用到 B 账号的请求上。
 */
export class ModelCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ModelCatalog | undefined>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** clear() 后自增；在途请求回来时若代次已变就不写缓存，否则刚清掉的旧值会自己长回来。 */
  private generation = 0;

  constructor(
    private readonly port: ModelCatalogPort,
    options: CatalogCacheOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_CATALOG_FAILURE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_CATALOG_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  async get(modelId: string, credentialKey?: string): Promise<ModelCatalog | undefined> {
    const key = `${credentialKey ?? ""}\u0000${modelId.toLowerCase()}`;
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.expiresAt > this.now()) return cached.value;
      // 过期即删：只在表满时才清理的话，一堆过期条目会一直占着内存。
      this.entries.delete(key);
    }

    // 同一 key 的并发请求合并成一次回源，避免冷启动时把目录接口打满。
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const generation = this.generation;
    // 成功与失败分开处理：`.catch(() => undefined)` 会把「目录里没有这个模型」和
    // 「目录接口抽了一下」压成同一件事，然后按完整 TTL 缓存。一次瞬时故障就会让
    // 之后 5 分钟的请求全部拿不到参数定义、且一次都不重试。
    const pending = this.port(modelId, credentialKey).then(
      (value) => this.store(key, generation, value, this.ttlMs),
      () => this.store(key, generation, undefined, this.failureTtlMs)
    );
    this.inflight.set(key, pending);
    return pending;
  }

  /** 当前缓存条目数。用于观测与测试「过期项确实被丢掉了」。 */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.generation += 1;
  }

  private store(
    key: string,
    generation: number,
    value: ModelCatalog | undefined,
    ttlMs: number
  ): ModelCatalog | undefined {
    this.inflight.delete(key);
    if (generation !== this.generation) return value;
    this.evictIfFull();
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return value;
  }

  /** 先清过期项；仍然满就按插入顺序丢最旧的（Map 的迭代顺序就是插入顺序）。 */
  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

export interface ResolveRequestedModelInput {
  modelId: string;
  intent: ModelIntent;
  catalog?: ModelCatalog;
  /** 内置模型 true；BYOK/自定义模型的调用方要显式传 false。 */
  builtInModel?: boolean;
}

export interface ResolvedRequestedModel {
  requestedModel: ConnectRequestedModel;
  parameters: ModelParameterValue[];
  /** 语义意图没落到任何参数上的部分，供日志。 */
  dropped: string[];
  /** 目录缺失、用了家族兜底映射。 */
  usedFallback: boolean;
}

/**
 * `ModelIntent` → `InferenceRequestedModel` 的入参。
 *
 * 参数解析整段复用 `src/model-params.ts`：它输出的 `ModelParameterValue{id,value}`
 * 与 descriptor 里的 `InferenceModelParameterValue{1 id string, 2 value string}` 字段完全一致，
 * 没有重写的必要，也不该有第二套 effort/maxMode/fast 语义。
 *
 * 请求没表达任何意图时 `resolveModelParams` 返回空数组，这里就不发 parameters——
 * 由服务端用模型自己的默认强度，而不是网关替它决定一个 medium。
 */
export function resolveRequestedModel(input: ResolveRequestedModelInput): ResolvedRequestedModel {
  const resolved = resolveModelParams(input.catalog, input.intent, input.modelId);
  return {
    requestedModel: {
      modelId: input.modelId,
      maxMode: input.intent.maxMode ?? false,
      // 每次都是 resolveModelParams 新建的数组，不同请求之间不共享引用。
      parameters: resolved.params,
      builtInModel: input.builtInModel ?? true,
      // 变体串已经解析成结构化 parameters，服务端不需要再解析一次。
      isVariantStringRepresentation: false
    },
    parameters: resolved.params,
    dropped: resolved.dropped,
    usedFallback: resolved.usedFallback
  };
}
