import { createHash } from "node:crypto";
import { filterModelsByScope, staticCanonicalModel } from "./routing.js";
import { getCurrentCursorClientType, runWithCursorClientType } from "./sand-client.js";
import type {
  CursorClientType,
  GatewayModel,
  ModelParameterDefinition,
  ModelScope,
  ModelVariantDefinition
} from "./types.js";

/** 上游不可达且无缓存时的静态兜底列表。 */
export const MODELS: GatewayModel[] = [
  { id: "composer-2.5", name: "Cursor Composer 2.5", cursorModel: "composer-2.5" },
  { id: "composer-2.5-fast", name: "Cursor Composer 2.5 Fast", cursorModel: "composer-2.5-fast" },
  { id: "composer-latest", name: "Cursor Composer latest alias", cursorModel: "composer-2.5" }
];

export interface ModelEntry {
  id: string;
  name: string;
  aliases: string[];
  /** 该模型支持的参数定义（fast / reasoning / effort / 上下文等），用于把语义意图解析成 model.params。 */
  parameters?: ModelParameterDefinition[];
  /** 该模型的预设参数组合（官方文档：可直接拷进 model.params），用于 Max Mode 等 variant 级映射兜底。 */
  variants?: ModelVariantDefinition[];
  /** 缺省即 SDK 密钥池。Connect 条目必须显式标出，否则 /v1/models 分不清会走哪条路。 */
  provider?: "sdk" | "connect";
}

export interface ModelListResult {
  models: ModelEntry[];
  source: "cursor" | "fallback";
}

export type ModelLister = (apiKey?: string) => Promise<ModelListResult>;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** 发现失败后的负缓存时长：短暂避开对上游的每请求重试，同时保证恢复后能较快重新发现。 */
const FAILURE_RETRY_MS = 60 * 1000;
/** 未知模型触发的强制刷新最短间隔：防止乱填模型 id 的请求打爆上游。 */
const FORCED_REFRESH_MIN_INTERVAL_MS = 30 * 1000;
/** 缓存桶数量上限：ALLOW_DIRECT_CURSOR_KEYS 时每个客户端 key 一个桶，必须设上限防无界增长。 */
const MAX_CACHE_BUCKETS = 64;
/** 目录缓存按 apiKey 分桶：key 池可能混用不同账号/团队的 key，各账号可用模型与参数定义可能不同。 */
const caches = new Map<string, { models: ModelEntry[]; at: number }>();
/** 失败负缓存同样按桶记录：一个无效 direct key 的失败不应让其他有效 key 也被挡在上游之外。 */
const failureAt = new Map<string, number>();
let lastForcedRefreshAt = 0;

function cacheBucket(apiKey: string): string {
  // Sand / SDK 通道可见模型可能不同，按通道分桶避免串名单。
  return createHash("sha256").update(`${apiKey}\0${getCurrentCursorClientType()}`).digest("hex").slice(0, 16);
}

function setCache(bucket: string, entry: { models: ModelEntry[]; at: number }): void {
  caches.set(bucket, entry);
  while (caches.size > MAX_CACHE_BUCKETS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, value] of caches) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    caches.delete(oldestKey);
  }
}

function anyCache(): { models: ModelEntry[]; at: number } | undefined {
  let latest: { models: ModelEntry[]; at: number } | undefined;
  for (const entry of caches.values()) {
    if (!latest || entry.at > latest.at) latest = entry;
  }
  return latest;
}

/**
 * 从 Cursor 后台拉取当前账号可用模型（Cursor.models.list），10 分钟缓存（按 apiKey 分桶）；
 * 无 key、上游失败时依次退回缓存、静态兜底列表。失败后 1 分钟内不再重试上游，避免放大故障。
 * forceRefresh 时绕过 TTL（用于“请求了缓存里没有的模型”场景，让新上线模型即刻可用）。
 */
export async function listAvailableModels(apiKey?: string, forceRefresh = false): Promise<ModelListResult> {
  if (!apiKey) {
    const fallbackCache = anyCache();
    return fallbackCache ? { models: fallbackCache.models, source: "cursor" } : fallbackModels();
  }
  const bucket = cacheBucket(apiKey);
  const cached = caches.get(bucket);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { models: cached.models, source: "cursor" };
  }
  if (!cached && Date.now() - (failureAt.get(bucket) ?? 0) < FAILURE_RETRY_MS) return fallbackModels();
  try {
    const sdk = await import("@cursor/sdk") as Record<string, unknown>;
    const cursor = sdk.Cursor as
      | { models?: { list?: (options: { apiKey: string }) => Promise<unknown> } }
      | undefined;
    const listed = await runWithCursorClientType(getCurrentCursorClientType(), () => cursor?.models?.list?.({ apiKey }));
    const models = parseSdkModels(listed);
    if (models.length) {
      setCache(bucket, { models, at: Date.now() });
      return { models, source: "cursor" };
    }
  } catch (error) {
    failureAt.set(bucket, Date.now());
    // 与目录缓存共用同一上限语义，防止 direct key 制造无界增长。
    while (failureAt.size > MAX_CACHE_BUCKETS) {
      const oldest = failureAt.keys().next().value;
      if (oldest === undefined) break;
      failureAt.delete(oldest);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[models] Cursor.models.list() failed: ${message.slice(0, 200)}`);
  }
  return cached ? { models: cached.models, source: "cursor" } : fallbackModels();
}

/**
 * 按可见范围过滤目录条目，用于 /v1/models 与后台模型选择器。
 * 只做过滤，不碰抓取与缓存：source 原样带出，让上层仍能区分「上游目录」与「静态兜底」。
 */
export function applyModelScope(result: ModelListResult, scope: ModelScope | undefined): ModelListResult {
  return { models: filterModelsByScope(result.models, scope), source: result.source };
}

export function openAiModelList(models: ModelEntry[]): Record<string, unknown> {
  return {
    object: "list",
    data: models.map(openAiModelObject)
  };
}

export function openAiModelObject(model: ModelEntry): Record<string, unknown> {
  const provider = model.provider === "connect" ? "connect" : "sdk";
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: provider === "connect" ? "cursor-connect" : "cursor",
    name: model.name,
    aliases: model.aliases,
    // 非 OpenAI 标准字段：客户端只看 id 时用 connect/ 前缀选路；看元数据时用这个字段。
    gateway_provider: provider,
    // 非 OpenAI 标准字段：暴露 Cursor 的参数定义与预设组合，方便客户端发现可用的 model_params。
    ...(model.parameters?.length ? { cursor_parameters: model.parameters } : {}),
    ...(model.variants?.length ? { cursor_variants: model.variants } : {})
  };
}

/**
 * 返回某模型（按 id 或 alias 匹配）的目录条目（参数定义 + variants），
 * 用于在 runner 里把语义意图解析成合法 model.params。复用 listAvailableModels 的缓存。
 */
export async function getModelCatalogEntry(modelId: string, apiKey?: string): Promise<ModelEntry | undefined> {
  if (!modelId) return undefined;
  const { models } = await listAvailableModels(apiKey);
  const found = findModelEntry(models, modelId);
  if (found) return found;
  if (!apiKey) return undefined;
  // 目录刚从上游实时拉取过（不是旧缓存）→ 上游确实没有该模型，立刻再刷一次没有意义。
  const entry = caches.get(cacheBucket(apiKey));
  if (entry && Date.now() - entry.at < FORCED_REFRESH_MIN_INTERVAL_MS) return undefined;
  // 缓存里没有该模型：可能是刚上线的新模型，强刷一次目录（全局限频 30s），避免新模型要等 10 分钟缓存过期才可用。
  if (Date.now() - lastForcedRefreshAt >= FORCED_REFRESH_MIN_INTERVAL_MS) {
    lastForcedRefreshAt = Date.now();
    const refreshed = await listAvailableModels(apiKey, true);
    return findModelEntry(refreshed.models, modelId);
  }
  return undefined;
}

/** 在一份目录里按 id 或 alias 找条目（大小写不敏感）。 */
export function findModelEntry(models: ModelEntry[], modelId: string): ModelEntry | undefined {
  const target = modelId.trim().toLowerCase();
  return models.find((model) =>
    model.id.toLowerCase() === target || model.aliases.some((alias) => alias.toLowerCase() === target));
}

/** 查一份目录要用哪把 key、走哪条通道。目录按 (apiKey, 通道) 分桶缓存，两者必须一起决定。 */
export interface CatalogueLookup {
  apiKey?: string;
  clientType: CursorClientType;
}

export interface CatalogueResolution {
  entry?: ModelEntry;
  /** 只有所有相关目录都成功确认且找到了该模型时才为 true。 */
  confirmed: boolean;
}

/**
 * 在多把 key 的目录里解析同一个模型，别名取并集。
 *
 * 只查一把 key 的目录不够：各账号可见的模型与别名本来就不一样，
 * 拿「随便借来的那把」的目录去做判定，读到的叫法就可能与真正执行的那把 key 对不上——
 * 授权与执行依据不同一份数据，两层防御会一起失效。并集与「选中哪把 key」无关，
 * 因此判定结果不再随取用策略、轮询游标漂移。
 *
 * 单把 key 拉取失败不该丢掉其它目录已经确认的叫法，但也不能把残缺并集当成完整身份：
 * 只要任一相关目录失败，`confirmed` 就为 false。目录成功却没有该模型时也不返回 entry，
 * 让调用方继续把未知模型当成未确认，而不是把「查不到」误当成「没有别名」。
 * 静态兜底目录（source=fallback）不算确认：那是网关自己的猜测，不是账号的真实目录。
 */
export async function findModelAcrossCatalogues(
  lister: ModelLister,
  lookups: CatalogueLookup[],
  modelId: string
): Promise<CatalogueResolution> {
  let merged: ModelEntry | undefined;
  let complete = lookups.length > 0;
  for (const lookup of lookups) {
    const listed = await listOneCatalogue(lister, lookup);
    if (listed?.source !== "cursor") {
      complete = false;
      continue;
    }
    const found = findModelEntry(listed.models, modelId);
    if (!found) continue;
    // 连 canonical id 一起并进别名：同一个模型在别的账号下可能就以某个别名作为 id，
    // 只留第一份的 id 会把那个叫法丢掉，而丢掉的每个叫法都是黑名单的一个缺口。
    merged = merged
      ? { ...merged, aliases: [...new Set([...merged.aliases, found.id, ...found.aliases])] }
      : found;
  }
  return { entry: merged, confirmed: Boolean(merged) && complete };
}

/** 单把 key 的目录查询：失败一律吞掉。runWithCursorClientType 是同步转发，所以要用 try 而不是 .catch。 */
async function listOneCatalogue(lister: ModelLister, lookup: CatalogueLookup): Promise<ModelListResult | undefined> {
  try {
    return await runWithCursorClientType(lookup.clientType, () => lister(lookup.apiKey));
  } catch {
    return undefined;
  }
}

export function normalizeModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "composer-2.5";
  return staticCanonicalModel(value) ?? value.trim();
}

function fallbackModels(): ModelListResult {
  return {
    models: MODELS.map((model) => ({ id: model.id, name: model.name, aliases: [] })),
    source: "fallback"
  };
}

function parseSdkModels(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const aliases = Array.isArray(record?.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === "string" && Boolean(alias))
      : [];
    const name = typeof record?.displayName === "string" && record.displayName ? record.displayName : id;
    const parameters = parseModelParameterDefinitions(record?.parameters);
    const variants = parseModelVariants(record?.variants);
    return [{
      id,
      name,
      aliases,
      ...(parameters ? { parameters } : {}),
      ...(variants ? { variants } : {})
    }];
  });
}

function parseModelParameterDefinitions(value: unknown): ModelParameterDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const defs = value.flatMap((item) => {
    const record = asRecord(item);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id || !Array.isArray(record?.values)) return [];
    const values = record.values.flatMap((entry) => {
      const valueRecord = asRecord(entry);
      const raw = valueRecord?.value;
      const stringValue = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
      if (!stringValue) return [];
      const displayName = typeof valueRecord?.displayName === "string" ? valueRecord.displayName : undefined;
      return [{ value: stringValue, ...(displayName ? { displayName } : {}) }];
    });
    if (!values.length) return [];
    const displayName = typeof record.displayName === "string" ? record.displayName : undefined;
    return [{ id, ...(displayName ? { displayName } : {}), values }];
  });
  return defs.length ? defs : undefined;
}

function parseModelVariants(value: unknown): ModelVariantDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || !Array.isArray(record.params)) return [];
    const params = record.params.flatMap((entry) => {
      const paramRecord = asRecord(entry);
      const id = typeof paramRecord?.id === "string" ? paramRecord.id.trim() : "";
      const raw = paramRecord?.value;
      const paramValue = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
      return id && paramValue ? [{ id, value: paramValue }] : [];
    });
    if (!params.length) return [];
    const displayName = typeof record.displayName === "string" ? record.displayName : "";
    const description = typeof record.description === "string" ? record.description : undefined;
    return [{
      displayName,
      ...(description ? { description } : {}),
      ...(record.isDefault === true ? { isDefault: true } : {}),
      params
    }];
  });
  return variants.length ? variants : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
