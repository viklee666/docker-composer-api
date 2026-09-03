import { modelIdentity } from "./routing.js";
import type { ModelParamPolicy, ModelParamPolicyMode } from "./types.js";

/** 三态档位的合法取值，保存与加载共用。 */
export const MODEL_PARAM_POLICY_MODES: readonly ModelParamPolicyMode[] = [
  "passthrough",
  "force-all",
  "force-selected"
];

/** 新部署 / 没有任何表态时的默认档：不加速、最小上下文。 */
export const DEFAULT_MODEL_PARAM_POLICY: ModelParamPolicy = { mode: "passthrough", models: [] };

export function isModelParamPolicyMode(value: unknown): value is ModelParamPolicyMode {
  return (MODEL_PARAM_POLICY_MODES as readonly string[]).includes(value as string);
}

/**
 * 策略在单个模型上解析出的显式取值：
 * passthrough / 未点名 → false；force-all / 点名 → true。
 *
 * 永远返回布尔而不是 undefined——「透传」的操作定义就是把 fast=false / 最小 context 写出去，
 * 留 undefined 会被 resolveModelParams 当成「没表态」跳过 applyFast，默认档的 fast=true 原样出门。
 * 不支持该参数的模型由 resolveModelParams dropped，这里不必查目录。
 */
export function policyIntent(policy: ModelParamPolicy | undefined, modelId: string): boolean {
  if (policy?.mode === "force-all") return true;
  if (policy?.mode !== "force-selected") return false;
  // 名单匹配与黑白名单同口径：canonical id、别名、静态 alias 组一起认，
  // 否则用别名请求就绕过了按 id 写的名单。
  const identity = modelIdentity(modelId);
  const wanted = new Set(policy.models.map((id) => id.trim().toLowerCase()).filter(Boolean));
  return identity.names.some((name) => wanted.has(name));
}

/**
 * env 的三态解析（CURSOR_FAST / CURSOR_MAX_MODE + 对应的 *_MODELS 名单）：
 * `true` / `force-all` → force-all（旧 env「默认开启」的语义）；
 * `force-selected` → 该档，名单来自 env（逗号/分号/换行分隔）；
 * 其余（`false` / `off` / `passthrough` / 空 / 非法）→ passthrough。
 */
export function parseModelParamPolicyEnv(mode: string | undefined, models: string | undefined): ModelParamPolicy {
  const trimmed = mode?.trim().toLowerCase() ?? "";
  if (trimmed === "force-selected") return { mode: "force-selected", models: parsePolicyModelList(models) };
  if (trimmed === "force-all" || trimmed === "true" || trimmed === "1" || trimmed === "on") {
    return { mode: "force-all", models: [] };
  }
  return { mode: "passthrough", models: [] };
}

/** 名单解析：逗号/分号/换行分隔，去空白去重。 */
export function parsePolicyModelList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))];
}
