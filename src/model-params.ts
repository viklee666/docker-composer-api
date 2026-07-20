import type { AgentMode, ModelParameterDefinition, ModelParameterValue, ModelVariantDefinition } from "./types.js";

/**
 * 客户端/网关侧对模型运行参数的“语义意图”，与具体 Cursor 模型的参数 id 解耦。
 * 真实的 model.params 由 resolveModelParams 结合 Cursor.models.list() 的目录（参数定义 + variants）推导得到。
 */
export interface ModelIntent {
  /** 思考/推理强度：none/off/minimal/low/medium/high/xhigh/max，或数字（Anthropic thinking budget tokens）。 */
  reasoningEffort?: string;
  /** Max Mode / 大上下文（如 Anthropic 1M context）。 */
  maxMode?: boolean;
  /** fast 变体开关。 */
  fast?: boolean;
  /** 显式透传的 model.params（优先级最高）。 */
  params?: ModelParameterValue[];
  /** 会话模式 agent/plan。 */
  mode?: AgentMode;
}

/** Cursor.models.list() 目录中与参数解析相关的部分（ModelEntry 的结构子集）。 */
export interface ModelCatalog {
  parameters?: ModelParameterDefinition[];
  variants?: ModelVariantDefinition[];
}

export interface ResolvedModelParams {
  params: ModelParameterValue[];
  /** 语义意图未命中任何参数而被丢弃的字段（如在不支持的模型上请求 maxMode），用于日志。 */
  dropped: string[];
  /** 目录发现失败、使用了内置模型家族惯例做兜底映射。 */
  usedFallback: boolean;
}

export interface ModelSpec {
  /** 去掉后缀后的基础模型 id。 */
  model: string;
  /** 从模型 id 后缀解析出的意图。 */
  intent: ModelIntent;
}

/** 归一化的思考强度等级，数值越大越强。 */
const LEVEL_RANK: Record<string, number> = {
  off: 0,
  none: 0,
  false: 0,
  disable: 0,
  disabled: 0,
  minimal: 1,
  min: 1,
  lowest: 1,
  low: 2,
  medium: 3,
  med: 3,
  moderate: 3,
  adaptive: 3,
  default: 3,
  standard: 3,
  high: 4,
  true: 4,
  on: 4,
  enabled: 4,
  xhigh: 5,
  "x-high": 5,
  extrahigh: 5,
  "extra-high": 5,
  higher: 5,
  max: 6,
  maximum: 6,
  ultra: 6
};

const REASONING_PARAM = /reason|effort|think/i;
const BOOLEAN_THINKING_PARAM = /^think(ing)?$/i;
const MAX_MODE_PARAM = /max.?mode|context|window|long|token|length|^1m$/i;

/**
 * 目录发现失败（无 key 权限 / 上游故障）时按模型 id 推断家族的兜底参数定义。
 * 只包含该家族全部型号都支持的最小集合（对照 2026-07 实测 Cursor.models.list() 目录）：
 * - claude 系全型号都有 thinking；effort/context 仅新型号有，不列入以免老型号收到无效参数。
 * - codex（gpt-x.y-codex）: reasoning，取值全型号一致为 low..extra-high。
 * - 其余 gpt 系: reasoning + context（mini/nano 无 fast/context，reasoning 取全家族交集 low..high）。
 * - grok: effort + fast；composer: fast；glm: reasoning[high|max]。
 * maxMode 的 context 档位仍按请求下发（如 1m），老型号不支持时由上游报错并入日志，优于静默丢弃。
 */
interface FallbackFamily {
  pattern: RegExp;
  defs: ModelParameterDefinition[];
  /** 该家族最大 context 档位与 fast=true 互斥（无 catalog variants 时的静态兜底约束，如 GPT-5.x）。 */
  maxContextExcludesFast?: boolean;
}

const FALLBACK_FAMILIES: FallbackFamily[] = [
  {
    pattern: /codex/i,
    defs: [
      enumDef("reasoning", ["low", "medium", "high", "extra-high"]),
      boolDef("fast")
    ]
  },
  {
    // Claude 系的 1m + fast=true 是合法组合，不设互斥。
    pattern: /claude|opus|sonnet|haiku|fable/i,
    defs: [
      boolDef("thinking"),
      enumDef("context", ["200k", "1m"]),
      boolDef("fast")
    ]
  },
  {
    // GPT-5.x：context=1m 时只有 fast=false，最大 context 与 fast 互斥。
    pattern: /gpt/i,
    defs: [
      enumDef("reasoning", ["low", "medium", "high"]),
      enumDef("context", ["272k", "1m"]),
      boolDef("fast")
    ],
    maxContextExcludesFast: true
  },
  {
    pattern: /grok/i,
    defs: [
      enumDef("effort", ["low", "medium", "high"]),
      boolDef("fast")
    ]
  },
  {
    pattern: /composer/i,
    defs: [boolDef("fast")]
  },
  {
    pattern: /glm/i,
    defs: [enumDef("reasoning", ["high", "max"])]
  }
];

function enumDef(id: string, values: string[]): ModelParameterDefinition {
  return { id, values: values.map((value) => ({ value })) };
}

function boolDef(id: string): ModelParameterDefinition {
  return { id, values: [{ value: "false" }, { value: "true" }] };
}

function fallbackFamilyFor(modelId: string): FallbackFamily | undefined {
  return FALLBACK_FAMILIES.find((entry) => entry.pattern.test(modelId));
}

export function fallbackParameterDefinitions(modelId: string): ModelParameterDefinition[] {
  return fallbackFamilyFor(modelId)?.defs ?? [];
}

/**
 * 解析模型 id 里的透传后缀（不与真实 id 里的 `-` 冲突）：
 * - `[id=value,id2=value2]` ACP 风格显式 model.params（与 Cursor ACP 的 modelId 表示一致）
 * - `#id=value,id2=value2` 显式 model.params（最高优先级）
 * - `:level` 思考强度简写（如 composer-2.5:high）
 * - `@max` / `@1m` / `@273k` 大上下文 / Max Mode 简写
 * 例：`gpt-5.5@1m:high#fast=false`、`claude-opus-4-8[thinking=true,context=1m,effort=xhigh]`
 */
export function parseModelSpec(raw: unknown): ModelSpec {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { model: "", intent: {} };
  const intent: ModelIntent = {};
  let rest = text;
  const explicitParams = new Map<string, string>();

  // ACP / Claude Code 风格的方括号后缀：`model[key=value,...]`（显式 params）或裸 token（`[1m]` / `[fast]` / `[high]`）。
  // Claude Code 指向自定义 base URL 时会把 `[1m]` 原样透传进请求体 model 字段（且会丢掉 context-1m beta 头），
  // 所以这里必须能从裸 token 识别 Max Mode，否则 Claude Code 的 1M 设置到不了网关。
  const bracket = /\[([^\][]*)\]/.exec(rest);
  if (bracket) {
    for (const token of bracket[1].split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        explicitParams.set(token.slice(0, eq).trim(), token.slice(eq + 1).trim());
      } else {
        applyBareSuffixToken(intent, token);
      }
    }
    rest = (rest.slice(0, bracket.index) + rest.slice(bracket.index + bracket[0].length)).trim();
  }

  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    for (const param of parseModelParamsSpec(rest.slice(hashIndex + 1)) ?? []) explicitParams.set(param.id, param.value);
    rest = rest.slice(0, hashIndex);
  }

  if (explicitParams.size) intent.params = [...explicitParams].map(([id, value]) => ({ id, value }));

  // `@` / `:` 后缀可任意组合（如 gpt-5.5@1m:high 或 claude:xhigh@1m），从右往左逐个消费。
  for (;;) {
    const index = Math.max(rest.lastIndexOf("@"), rest.lastIndexOf(":"));
    if (index < 0) break;
    const separator = rest[index];
    const token = rest.slice(index + 1).trim().toLowerCase();
    rest = rest.slice(0, index);
    if (separator === "@") {
      // @default / @nomax 显式关闭；其余（1m/273k/max/long/...）都视为开启 Max Mode。
      if (intent.maxMode === undefined) {
        intent.maxMode = !["default", "nomax", "no-max", "off", "false", "small"].includes(token);
      }
      continue;
    }
    if (token === "fast") {
      if (intent.fast === undefined) intent.fast = true;
    } else if (token === "slow" || token === "nofast" || token === "no-fast") {
      if (intent.fast === undefined) intent.fast = false;
    } else if (token && intent.reasoningEffort === undefined) {
      intent.reasoningEffort = token;
    }
  }

  return { model: rest.trim(), intent };
}

/** 上下文/大窗口 token（如 1m / 273k / 200000），出现即视为开启 Max Mode。 */
const CONTEXT_SIZE_TOKEN = /^\d+(\.\d+)?[km]?$/i;

/**
 * 解析方括号里不带 `=` 的裸 token，按取值语义分类（与位置无关）：
 * - 上下文档位（1m/273k/...）或 max-mode/long → maxMode=true；nomax/small/default → maxMode=false
 * - fast/slow → fast
 * - 其余（low/medium/high/xhigh/max/none...）→ 思考强度
 */
function applyBareSuffixToken(intent: ModelIntent, token: string): void {
  const value = token.trim().toLowerCase();
  if (!value) return;
  if ((CONTEXT_SIZE_TOKEN.test(value) && /[km]$/.test(value)) || ["max-mode", "maxmode", "long", "1m"].includes(value)) {
    if (intent.maxMode === undefined) intent.maxMode = true;
    return;
  }
  if (["nomax", "no-max", "small", "default-context"].includes(value)) {
    if (intent.maxMode === undefined) intent.maxMode = false;
    return;
  }
  if (value === "fast") {
    if (intent.fast === undefined) intent.fast = true;
    return;
  }
  if (["slow", "nofast", "no-fast"].includes(value)) {
    if (intent.fast === undefined) intent.fast = false;
    return;
  }
  if (intent.reasoningEffort === undefined) intent.reasoningEffort = value;
}

/** 解析 `id=value,id2=value2`（或 `;` 分隔）或 JSON 数组形式的 model.params。 */
export function parseModelParamsSpec(value: unknown): ModelParameterValue[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return normalizeParamArray(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    try {
      return normalizeParamArray(JSON.parse(trimmed) as unknown);
    } catch {
      return undefined;
    }
  }
  const params = trimmed
    .split(/[,;\n]/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return [];
      const id = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      return id ? [{ id, value: val }] : [];
    });
  return params.length ? params : undefined;
}

function normalizeParamArray(value: unknown): ModelParameterValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const params = value.flatMap((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!record || !id) return [];
    const raw = record.value;
    const val = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
    return [{ id, value: val }];
  });
  return params.length ? params : undefined;
}

/** 合并多个意图，后者覆盖前者；显式 params 逐 id 覆盖合并。 */
export function mergeIntents(...intents: Array<ModelIntent | undefined>): ModelIntent {
  const merged: ModelIntent = {};
  const params = new Map<string, string>();
  for (const intent of intents) {
    if (!intent) continue;
    if (intent.reasoningEffort !== undefined) merged.reasoningEffort = intent.reasoningEffort;
    if (intent.maxMode !== undefined) merged.maxMode = intent.maxMode;
    if (intent.fast !== undefined) merged.fast = intent.fast;
    if (intent.mode !== undefined) merged.mode = intent.mode;
    for (const param of intent.params ?? []) params.set(param.id, param.value);
  }
  if (params.size) merged.params = [...params].map(([id, value]) => ({ id, value }));
  return merged;
}

/** 将 Anthropic thinking budget tokens 归一化为思考强度等级。 */
export function reasoningEffortFromThinkingBudget(budget: number): string {
  if (!Number.isFinite(budget) || budget <= 0) return "none";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24_000) return "high";
  return "max";
}

/**
 * 结合模型目录把语义意图解析为可直接发给 SDK 的 model.params（官方文档推荐的做法）：
 * 1. 以默认 variant 的完整参数组合为基线（官方：variants 的 params 可直接拷进 model selection）。
 *    只发部分参数时其余参数会落到“每个参数的第一个允许值”，可能偏离默认（如 context 从 1m 掉到 300k），
 *    所以只要有任何意图就先补全默认组合。
 * 2. 按参数定义把思考强度 / Max Mode / fast 意图映射到具体参数 id / 允许值。
 * 3. 用 variants（合法组合白名单）校正互斥组合：如 GPT-5.x 的 context=1m 只允许 fast=false，
 *    Max Mode 与 fast 冲突时以 Max Mode 优先（除非只显式要了 fast）。Claude 系 1m+fast=true 合法则不动。
 * 4. 目录发现失败时按模型家族的已知惯例兜底映射（而非静默丢弃），未命中的意图记入 dropped 供日志。
 * 5. 显式 params 始终最后生效并覆盖前面所有推导结果。
 */
export function resolveModelParams(
  catalog: ModelCatalog | undefined,
  intent: ModelIntent,
  modelId = ""
): ResolvedModelParams {
  const result = new Map<string, string>();
  const dropped: string[] = [];
  const hasSemantic = intent.reasoningEffort !== undefined || intent.maxMode !== undefined || intent.fast !== undefined;
  if (!hasSemantic && !intent.params?.length) return { params: [], dropped, usedFallback: false };

  let defs = catalog?.parameters ?? [];
  let family: FallbackFamily | undefined;
  let usedFallback = false;
  if (catalog === undefined && hasSemantic) {
    family = fallbackFamilyFor(modelId);
    defs = family?.defs ?? [];
    usedFallback = defs.length > 0;
  }

  const defaultVariant = catalog?.variants?.find((variant) => variant.isDefault);
  for (const param of defaultVariant?.params ?? []) result.set(param.id, param.value);

  if (intent.reasoningEffort !== undefined && !applyReasoning(result, defs, intent.reasoningEffort)) {
    dropped.push(`reasoningEffort=${intent.reasoningEffort}`);
  }
  if (intent.maxMode !== undefined && !applyMaxMode(result, defs, intent.maxMode)) {
    dropped.push(`maxMode=${intent.maxMode}`);
  }
  if (intent.fast !== undefined && !applyFast(result, defs, intent.fast)) {
    dropped.push(`fast=${intent.fast}`);
  }

  resolveContextFastConflict(result, defs, catalog?.variants, family, intent, dropped);

  for (const param of intent.params ?? []) result.set(param.id, param.value);

  return {
    params: [...result].map(([id, value]) => ({ id, value })),
    dropped,
    usedFallback
  };
}

/**
 * 校正 context 档位与 fast 的互斥组合。冲突判定优先用 catalog variants（每个模型真实的合法组合白名单），
 * 无 variants 时退回家族静态约束（maxContextExcludesFast）。
 * 冲突时的取舍：Max Mode（大 context）优先于 fast；仅显式要了 fast、没要 Max Mode 时才反过来降 context 保 fast。
 */
function resolveContextFastConflict(
  result: Map<string, string>,
  defs: ModelParameterDefinition[],
  variants: ModelVariantDefinition[] | undefined,
  family: FallbackFamily | undefined,
  intent: ModelIntent,
  dropped: string[]
): void {
  const contextDef = defs.find((def) =>
    !isBooleanDef(def) && (MAX_MODE_PARAM.test(def.id) || (def.displayName ? MAX_MODE_PARAM.test(def.displayName) : false)));
  const fastDef = defs.find((def) => /^fast$/i.test(def.id)) ?? defs.find((def) => /fast/i.test(def.id));
  if (!contextDef || !fastDef) return;
  const ctxId = contextDef.id;
  const fastId = fastDef.id;
  if (!result.has(ctxId) || !result.has(fastId)) return;
  const ctxVal = result.get(ctxId) ?? "";
  const fastVal = result.get(fastId) ?? "";

  if (pairIsAllowed(variants, ctxId, ctxVal, fastId, fastVal, family, contextDef)) return;

  // Max Mode 优先：显式要了 maxMode，或没有单独显式要 fast 时，保 context、改 fast。
  if (intent.maxMode !== undefined || intent.fast === undefined) {
    const fixedFast = fastValueForContext(variants, ctxId, ctxVal, fastId, family);
    if (fixedFast !== undefined && fixedFast !== fastVal) {
      result.set(fastId, fixedFast);
      dropped.push(`fast=${fastVal} (not combinable with ${ctxId}=${ctxVal}; forced ${fastId}=${fixedFast})`);
    }
    return;
  }
  // 只显式要了 fast：保 fast、把 context 降到能与该 fast 共存的最大档位。
  const fixedCtx = contextValueForFast(variants, ctxId, fastId, fastVal, contextDef);
  if (fixedCtx !== undefined && fixedCtx !== ctxVal) {
    result.set(ctxId, fixedCtx);
    dropped.push(`maxMode context=${ctxVal} (not combinable with fast=${fastVal}; downgraded ${ctxId}=${fixedCtx})`);
  }
}

function variantValue(variant: ModelVariantDefinition, id: string): string | undefined {
  return variant.params.find((param) => param.id === id)?.value;
}

/** (context, fast) 组合是否合法：优先查 variants 白名单，无则退回家族静态约束。 */
function pairIsAllowed(
  variants: ModelVariantDefinition[] | undefined,
  ctxId: string,
  ctxVal: string,
  fastId: string,
  fastVal: string,
  family: FallbackFamily | undefined,
  contextDef: ModelParameterDefinition
): boolean {
  if (variants?.length) {
    return variants.some((variant) => variantValue(variant, ctxId) === ctxVal && variantValue(variant, fastId) === fastVal);
  }
  if (family?.maxContextExcludesFast && fastVal === "true") {
    return ctxVal !== maxContextValue(contextDef);
  }
  return true;
}

/** 给定 context 值，返回能与之共存的 fast 值（variants 里的实际取值；无 variants 时最大档强制 false）。 */
function fastValueForContext(
  variants: ModelVariantDefinition[] | undefined,
  ctxId: string,
  ctxVal: string,
  fastId: string,
  family: FallbackFamily | undefined
): string | undefined {
  if (variants?.length) {
    for (const variant of variants) {
      if (variantValue(variant, ctxId) === ctxVal) {
        const value = variantValue(variant, fastId);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }
  return family?.maxContextExcludesFast ? "false" : undefined;
}

/** 给定 fast 值，返回能与之共存的最大 context 档位（variants 优先；无则取次大档）。 */
function contextValueForFast(
  variants: ModelVariantDefinition[] | undefined,
  ctxId: string,
  fastId: string,
  fastVal: string,
  contextDef: ModelParameterDefinition
): string | undefined {
  if (variants?.length) {
    let best: string | undefined;
    for (const variant of variants) {
      if (variantValue(variant, fastId) !== fastVal) continue;
      const value = variantValue(variant, ctxId);
      if (value === undefined) continue;
      if (best === undefined || contextSize(value) > contextSize(best)) best = value;
    }
    return best;
  }
  // 无 variants：退回定义里第二大的 context 档位（最大档与 fast 互斥）。
  const sorted = [...contextDef.values].map((entry) => entry.value).sort((a, b) => contextSize(b) - contextSize(a));
  return sorted[1] ?? sorted[0];
}

function maxContextValue(contextDef: ModelParameterDefinition): string {
  return [...contextDef.values]
    .map((entry) => entry.value)
    .sort((a, b) => contextSize(b) - contextSize(a))[0] ?? "";
}

/** “跟随模型默认强度”的软等级：开思考但不覆盖模型默认 effort（如 Claude adaptive thinking）。 */
const SOFT_LEVEL = /^(adaptive|default|standard|auto)$/i;

function applyReasoning(result: Map<string, string>, defs: ModelParameterDefinition[], effort: string): boolean {
  const rank = normalizeLevel(effort);
  if (rank === undefined) return false;
  const soft = SOFT_LEVEL.test(effort.trim());

  const booleanThinking = defs.find((def) => BOOLEAN_THINKING_PARAM.test(def.id) && isBooleanDef(def));
  const graded = defs.find((def) => REASONING_PARAM.test(def.id) && def !== booleanThinking && !isBooleanDef(def));

  if (booleanThinking) {
    result.set(booleanThinking.id, pickBooleanValue(booleanThinking, rank > 0));
    // Claude 类模型同时暴露 thinking + effort：关掉思考时不再设强度；开启时设置强度等级（软等级保留模型默认强度）。
    if (graded && rank > 0 && !soft) {
      const value = pickClosestValue(graded, rank);
      if (value !== undefined) result.set(graded.id, value);
    }
    return true;
  }

  const target = graded ?? defs.find((def) => REASONING_PARAM.test(def.id));
  if (!target) return false;
  if (isBooleanDef(target)) {
    result.set(target.id, pickBooleanValue(target, rank > 0));
    return true;
  }
  const value = pickClosestValue(target, rank);
  if (value === undefined) return false;
  result.set(target.id, value);
  return true;
}

function applyMaxMode(result: Map<string, string>, defs: ModelParameterDefinition[], enabled: boolean): boolean {
  const target = defs.find((def) => MAX_MODE_PARAM.test(def.id) || (def.displayName ? MAX_MODE_PARAM.test(def.displayName) : false));
  if (!target || !target.values.length) return false;
  if (isBooleanDef(target)) {
    result.set(target.id, pickBooleanValue(target, enabled));
    return true;
  }
  // 非布尔（上下文大小档位）：开启取最大档，关闭取最小档。
  const sorted = [...target.values].sort((a, b) => contextSize(a.value) - contextSize(b.value));
  const chosen = enabled ? sorted[sorted.length - 1] : sorted[0];
  if (!chosen) return false;
  result.set(target.id, chosen.value);
  return true;
}

function applyFast(result: Map<string, string>, defs: ModelParameterDefinition[], enabled: boolean): boolean {
  const target = defs.find((def) => /^fast$/i.test(def.id)) ?? defs.find((def) => /fast/i.test(def.id));
  if (!target) return false;
  result.set(target.id, pickBooleanValue(target, enabled));
  return true;
}

function isBooleanDef(def: ModelParameterDefinition): boolean {
  if (!def.values.length) return false;
  return def.values.every((entry) => entry.value === "true" || entry.value === "false");
}

function pickBooleanValue(def: ModelParameterDefinition, enabled: boolean): string {
  const wanted = enabled ? "true" : "false";
  return def.values.some((entry) => entry.value === wanted) ? wanted : def.values[0]?.value ?? wanted;
}

function pickClosestValue(def: ModelParameterDefinition, rank: number): string | undefined {
  let best: { value: string; distance: number; rank: number } | undefined;
  for (const entry of def.values) {
    const entryRank = normalizeLevel(entry.value) ?? normalizeLevel(entry.displayName ?? "");
    if (entryRank === undefined) continue;
    const distance = Math.abs(entryRank - rank);
    // 距离更近者优先；距离相同取更高等级（更贴近“更强思考”的语义）。
    if (!best || distance < best.distance || (distance === best.distance && entryRank > best.rank)) {
      best = { value: entry.value, distance, rank: entryRank };
    }
  }
  if (best) return best.value;
  // 无法按等级匹配（取值不是标准强度词）时不强行下发，交回 undefined。
  return undefined;
}

function normalizeLevel(value: string): number | undefined {
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  if (key in LEVEL_RANK) return LEVEL_RANK[key];
  const numeric = Number(key);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return 0;
    if (numeric <= 2048) return 2;
    if (numeric <= 8192) return 3;
    if (numeric <= 24_000) return 4;
    return 6;
  }
  return undefined;
}

/** 把上下文档位取值（如 `1m` / `273k` / `200000`）估算成可比较的数值。 */
function contextSize(value: string): number {
  const match = /([\d.]+)\s*([kmb]?)/i.exec(value.trim().toLowerCase());
  if (!match) return value === "true" ? 1 : 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = match[2];
  const factor = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : unit === "b" ? 1_000_000_000 : 1;
  return base * factor;
}
