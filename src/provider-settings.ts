import { policyIntent } from "./model-param-policy.js";
import type { ModelIntent } from "./model-params.js";
import type { GatewayConfig, GatewayProvider, ProviderRunOverrides } from "./types.js";

/**
 * 某条路线的覆盖层（包 A，计划 §3.5）。bot 取 botOverrides，其余一律 sdkOverrides——
 * provider 缺省（类型可选、或 selectProvider 回落 sdk）时按 SDK 处理，与现状一致。
 */
export function providerOverrides(
  config: GatewayConfig,
  provider: GatewayProvider | undefined
): ProviderRunOverrides | undefined {
  return provider === "bot" ? config.botOverrides : config.sdkOverrides;
}

/**
 * 某条路线的模型运行默认值：覆盖字段优先，未覆盖回落顶层同名值。
 * 顶层值由 env / 既有后台设置加载，因此未做任何覆盖时返回值与改造前完全一致（升级零迁移）。
 * requestModelControls 与 admin 联通性测试共用这一份解析，避免两处口径漂移。
 */
export function providerModelDefaults(
  config: GatewayConfig,
  provider: GatewayProvider | undefined,
  model: string
): ModelIntent {
  const overrides = providerOverrides(config, provider);
  return {
    reasoningEffort: overrides?.reasoningEffort ?? config.cursorReasoningEffort,
    maxMode: policyIntent(overrides?.maxModePolicy ?? config.cursorMaxModePolicy, model),
    fast: policyIntent(overrides?.fastPolicy ?? config.cursorFastPolicy, model),
    mode: overrides?.agentMode ?? config.cursorAgentMode,
    params: overrides?.modelParams ?? config.cursorModelParams
  };
}

/**
 * 某条路线的上游空闲超时。请求路径上 provider 已知时用它替代直接读 config.requestTimeoutMs；
 * provider 未知的公共前置（目录查询等）仍读全局值。
 */
export function providerRequestTimeoutMs(
  config: GatewayConfig,
  provider: GatewayProvider | undefined
): number {
  return providerOverrides(config, provider)?.requestTimeoutMs ?? config.requestTimeoutMs;
}
