import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { CursorConnectClient } from "./client.js";
import { conversationMessages, type PreparedConversation } from "./conversation.js";
import {
  buildInferenceStreamRequest,
  type ConnectMessage,
  type ConnectRequestedModel
} from "./request-builder.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import type { CcSummary, CursorConnectStore } from "./store.js";

/**
 * Summary checkpoint（计划 §G8）。
 *
 * **协议层面 summary 不是独立能力**：没有 SummarizeRequest，没有 summary 专用字段。
 * summary 就是"用一个特殊 prompt 发一次普通推理"，只是要用**独立的 invocation_id**、
 * 保持同一个 `conversation_id`。
 *
 * `InferenceResponseInfo.supports_self_summary`（字段 7）是唯一相关的协议信号，
 * 但走 `Stream` 时它出现在响应**尾部**——是事后信息。所以摘要决策由网关自己做，
 * 不等上游告知。（对比：`RunInference` 的 `run_ready.supports_self_summary` 是事前的。）
 */

export const DEFAULT_SUMMARY_PROMPT =
  "Summarize the conversation so far. Preserve: unresolved questions, decisions already made, " +
  "file paths and identifiers that were mentioned, and any tool results that later turns depend on. " +
  "Write it as notes for yourself, not as a reply to the user.";

export interface SummaryTriggerInput {
  /** 上游报告的本轮输入 token（`usage.prompt_tokens`），不是字符数估算。 */
  promptTokens: number;
  /** `AvailableModel.context_token_limit`；未知时传 undefined，此时只认显式触发。 */
  contextTokenLimit?: number;
  /** 占比阈值，默认 0.75。 */
  threshold?: number;
  /** 用户显式 `/summarize`。 */
  explicit?: boolean;
}

/**
 * 是否该做摘要。
 * 阈值判断只用真实 token 数：字符数估算在 CJK 与代码上偏差极大，
 * 据此触发摘要要么永远不触发，要么在还早得很的时候就把上下文砍了。
 */
export function shouldSummarize(input: SummaryTriggerInput): boolean {
  if (input.explicit) return true;
  if (!input.contextTokenLimit || input.contextTokenLimit <= 0) return false;
  const threshold = input.threshold ?? 0.75;
  return input.promptTokens >= input.contextTokenLimit * threshold;
}

export interface SummarizeDeps {
  client: Pick<CursorConnectClient, "stream">;
  store: CursorConnectStore;
  newInvocationId?: () => string;
}

export interface SummarizeOptions {
  conversation: PreparedConversation;
  /** 网关侧 conversation 行的 id（不是 upstream conversation_id）。 */
  conversationRowId: string;
  runId: string;
  requestedModel: ConnectRequestedModel;
  coveredThroughSeq: number;
  prompt?: string;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  summary: CcSummary;
  /** true 表示命中了同一段消息的已有摘要，没有真的发请求。 */
  reused: boolean;
}

/**
 * 生成 summary checkpoint。
 *
 * 失败时**不动**已有 checkpoint、不动 transcript：调用方继续用旧的即可。
 * 原始事件永远不删，只记录覆盖到哪个 seq。
 */
export async function summarizeConversation(
  deps: SummarizeDeps,
  options: SummarizeOptions
): Promise<SummarizeResult> {
  const messages = conversationMessages(options.conversation);
  const sourceHash = hashMessages(messages);

  // 同一段消息重复摘要既费钱又会让 checkpoint 抖动，命中就直接复用。
  const existing = deps.store.latestSummary(options.conversationRowId);
  if (existing && existing.sourceHash === sourceHash) return { summary: existing, reused: true };

  const request = buildInferenceStreamRequest({
    messages: [...messages, { role: "user", text: options.prompt ?? DEFAULT_SUMMARY_PROMPT }],
    conversationId: options.conversation.conversationId,
    // 摘要要有自己的 invocation_id，但 conversation_id 不变——它是同一段对话的一部分。
    invocationId: (deps.newInvocationId ?? randomUUID)(),
    requestedModel: options.requestedModel
  });

  const normalizer = new ResponseNormalizer();
  for await (const frame of deps.client.stream(request, options.signal)) {
    for (const _ of normalizer.accept(frame)) {
      // 摘要不对外流式输出，只要最终文本。
    }
  }

  const text = normalizer.state.text.trim();
  if (!text) {
    // 声明做了摘要却拿不到内容，比不做摘要更糟：上层会拿一个空 checkpoint 去替换上下文。
    throw new ApiError("Summary run produced no text; keeping the previous checkpoint.", 502, "upstream_error");
  }

  const summary = deps.store.createSummary({
    conversationId: options.conversationRowId,
    runId: options.runId,
    coveredThroughSeq: options.coveredThroughSeq,
    summaryText: text,
    model: normalizer.state.resolvedModel ?? options.requestedModel.modelId,
    ...(options.requestedModel.parameters?.length
      ? { parametersJson: JSON.stringify(options.requestedModel.parameters) }
      : {}),
    sourceHash
  });
  // 先写 checkpoint 再切 active context：顺序反过来的话，写库失败就会丢掉刚生成的摘要。
  deps.store.setLatestSummary(options.conversationRowId, summary.id);
  return { summary, reused: false };
}

/**
 * 用 checkpoint 重建上下文：摘要 + 未被覆盖的尾部消息。
 *
 * **未完成的工具调用和子代理状态必须保留**——摘要不是丢弃 pending 状态的借口。
 * 这里的做法是把 tool 消息与紧邻它的 assistant(tool_calls) 一起留在尾部。
 */
export function contextFromSummary(
  conversation: PreparedConversation,
  summaryText: string,
  keepTailMessages = 4
): PreparedConversation {
  const messages = conversation.messages;
  const tailStart = Math.max(0, messages.length - keepTailMessages);

  // 哪些工具调用还没拿到结果。这些是**未完成状态**，摘要绝不能把它们裁掉——
  // 裁掉之后模型既看不到自己发起过调用，也永远等不到结果。
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "tool" ? (message.toolResults ?? []).map((result) => result.toolCallId) : []
    )
  );
  const unanswered = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id).filter((id) => !answered.has(id))
        : []
    )
  );

  // 尾部保留的工具结果，其发起者也必须一起保留，否则上游看到一个无主的工具结果。
  const tailResultIds = new Set(
    messages
      .slice(tailStart)
      .flatMap((message) => (message.role === "tool" ? (message.toolResults ?? []).map((r) => r.toolCallId) : []))
  );

  const keep = (message: ConnectMessage, index: number): boolean => {
    if (index >= tailStart) return true;
    if (message.role === "assistant" && message.toolCalls?.length) {
      return message.toolCalls.some((call) => unanswered.has(call.id) || tailResultIds.has(call.id));
    }
    if (message.role === "tool") {
      return (message.toolResults ?? []).some((result) => unanswered.has(result.toolCallId));
    }
    return false;
  };

  // 按原下标过滤而不是「拼接头尾」：拼接会把补回来的发起者排到它自己的结果后面。
  return {
    ...conversation,
    systemInstructions: [...conversation.systemInstructions, `Conversation summary so far:\n${summaryText}`],
    messages: messages.filter(keep)
  };
}

/** 被摘要消息序列的 hash，用于挡住重复摘要。只 hash 结构与文本，不含时间戳。 */
export function hashMessages(messages: ConnectMessage[]): string {
  const canonical = messages.map((message) => ({
    role: message.role,
    text: message.text ?? "",
    toolCalls: (message.toolCalls ?? []).map((call) => [call.id, call.name]),
    toolResults: (message.toolResults ?? []).map((result) => [result.toolCallId, JSON.stringify(result.result ?? null)])
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
