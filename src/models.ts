import type { GatewayModel, ModelParameterDefinition, ModelVariantDefinition } from "./types.js";

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
}

export interface ModelListResult {
  models: ModelEntry[];
  source: "cursor" | "fallback";
}

export type ModelLister = (apiKey?: string) => Promise<ModelListResult>;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** 发现失败后的负缓存时长：短暂避开对上游的每请求重试，同时保证恢复后能较快重新发现。 */
const FAILURE_RETRY_MS = 60 * 1000;
let cache: { models: ModelEntry[]; at: number } | undefined;
let lastFailureAt = 0;

/**
 * 从 Cursor 后台拉取当前账号可用模型（Cursor.models.list），10 分钟缓存；
 * 无 key、上游失败时依次退回缓存、静态兜底列表。失败后 1 分钟内不再重试上游，避免放大故障。
 */
export async function listAvailableModels(apiKey?: string): Promise<ModelListResult> {
  if (!apiKey) return cache ? { models: cache.models, source: "cursor" } : fallbackModels();
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { models: cache.models, source: "cursor" };
  }
  if (!cache && Date.now() - lastFailureAt < FAILURE_RETRY_MS) return fallbackModels();
  try {
    const sdk = await import("@cursor/sdk") as Record<string, unknown>;
    const cursor = sdk.Cursor as
      | { models?: { list?: (options: { apiKey: string }) => Promise<unknown> } }
      | undefined;
    const listed = await cursor?.models?.list?.({ apiKey });
    const models = parseSdkModels(listed);
    if (models.length) {
      cache = { models, at: Date.now() };
      return { models, source: "cursor" };
    }
  } catch (error) {
    lastFailureAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[models] Cursor.models.list() failed: ${message.slice(0, 200)}`);
  }
  return cache ? { models: cache.models, source: "cursor" } : fallbackModels();
}

export function openAiModelList(models: ModelEntry[]): Record<string, unknown> {
  return {
    object: "list",
    data: models.map(openAiModelObject)
  };
}

export function openAiModelObject(model: ModelEntry): Record<string, unknown> {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: model.name,
    aliases: model.aliases,
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
  const target = modelId.trim().toLowerCase();
  return models.find((model) =>
    model.id.toLowerCase() === target || model.aliases.some((alias) => alias.toLowerCase() === target));
}

export function normalizeModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "composer-2.5";
  const normalized = value.trim().toLowerCase();
  if (["composer-latest", "composer", "composer-2.5", "composer-2-5", "composer-2.5-sdk"].includes(normalized)) {
    return "composer-2.5";
  }
  if (["composer-2.5-fast", "composer-2-5-fast"].includes(normalized)) return "composer-2.5-fast";
  return value.trim();
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
