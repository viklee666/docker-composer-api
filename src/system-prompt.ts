import type { SystemPromptMode, SystemPromptSettings } from "./types.js";

/**
 * 网关默认系统提示词。
 *
 * `@cursor/sdk` 没有任何 system / instructions 入参（AgentOptions 与 SendOptions 都不带），
 * 线上 proto 里的 custom_system_prompt 也没有公开 API 能到达；文件规则（AGENTS.md / .cursor/rules）
 * 又被 cursor-runner 的 `local.settingSources: []` 刻意关掉了。
 * 因此唯一可用的注入通道就是 protocol.ts 合成的那段 prompt 文本，本模块只负责算出「最终 system 正文」。
 */

const MODES: readonly SystemPromptMode[] = ["off", "append", "override"];

/**
 * 规范化后台 / 环境变量传入的设置：文本 trim，认不出的 mode 归 off，
 * 空文本一律降级为 off——配了个空提示词绝不能反过来把客户端自己的 system 洗掉。
 * off 时仍保留已 trim 的正文，后台在 off/append/override 之间来回切时不会丢草稿。
 */
export function normalizeSystemPromptSettings(mode: unknown, text: unknown): SystemPromptSettings {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const raw = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  const parsed = MODES.find((candidate) => candidate === raw) ?? "off";
  return trimmed ? { mode: parsed, text: trimmed } : { mode: "off" };
}

/** 设置是否真的会改变请求：mode 非 off 且正文非空。 */
export function systemPromptActive(settings: SystemPromptSettings | undefined): boolean {
  return gatewayText(settings) !== "";
}

/**
 * 计算本次请求最终生效的 system 文本。
 * - off / 空配置：原样返回客户端原文（连空白都不动），保证未启用时与改造前逐字节一致；
 * - append：客户端原文在前、网关正文在后，中间空一行；客户端没有 system 时只剩网关正文，不留前导空行；
 * - override：只保留网关正文，整段丢掉客户端 system。
 */
export function resolveSystemText(clientSystem: string, settings: SystemPromptSettings | undefined): string {
  const gateway = gatewayText(settings);
  if (!gateway) return clientSystem;
  if (settings?.mode === "override") return gateway;
  // 先削掉客户端尾部空白，分隔符才恰好是一个空行（客户端原文常以 \n 结尾，直接拼会多出空行）。
  const head = clientSystem.trimEnd();
  return head ? `${head}\n\n${gateway}` : gateway;
}

/** mode 生效时的网关正文；off / 非法 mode / 空文本一律返回空串。 */
function gatewayText(settings: SystemPromptSettings | undefined): string {
  if (settings?.mode !== "append" && settings?.mode !== "override") return "";
  return typeof settings.text === "string" ? settings.text.trim() : "";
}
