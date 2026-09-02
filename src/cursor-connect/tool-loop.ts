import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { CursorStreamEvent, GatewayToolCall, RequestUsage } from "../types.js";
import type { CursorConnectClient } from "./client.js";
import { conversationMessages, type PreparedConversation } from "./conversation.js";
import { draftEventsFromFrame, type DraftEvent } from "./events.js";
import {
  buildInferenceStreamRequest,
  type ConnectMessage,
  type ConnectModelConfig,
  type ConnectRequestedModel,
  type ConnectToolResult
} from "./request-builder.js";
import { ResponseNormalizer } from "./response-normalizer.js";
import type { CursorConnectStore } from "./store.js";

/** 一次工具执行的结果。`isError` 会原样进 `InferenceToolResultPart.is_error`。 */
export interface ToolExecution {
  result: unknown;
  isError?: boolean;
}

export type ToolExecutor = (
  call: GatewayToolCall,
  context: { runId: string; iteration: number; signal?: AbortSignal }
) => Promise<ToolExecution | undefined>;

export interface ToolLoopDeps {
  client: Pick<CursorConnectClient, "stream">;
  store?: CursorConnectStore;
  /**
   * 网关侧执行器（本地工具 G6.2 / 子代理 G7）。
   * 返回 `undefined` 表示这个工具网关不负责执行——此时循环停下来把调用交回调用方，
   * 这正是 OpenAI 风格无状态工具循环的形态。
   */
  executeTool?: ToolExecutor;
  /** 事件落库（G9/G11）。不传就不落。 */
  onEvents?: (drafts: DraftEvent[], iteration: number) => void;
}

export interface ToolLoopOptions {
  conversation: PreparedConversation;
  requestedModel: ConnectRequestedModel;
  modelConfig?: ConnectModelConfig;
  runId: string;
  /** 防跑飞。到达上限就停，并在结果里标明原因，不静默截断。 */
  maxIterations?: number;
  newInvocationId?: () => string;
  signal?: AbortSignal;
}

export type ToolLoopStop = "completed" | "awaiting_caller" | "max_iterations";

export interface ToolLoopResult {
  text: string;
  reasoningText: string;
  /** 最后一轮里网关没有代为执行、需要调用方处理的工具调用。 */
  pendingToolCalls: GatewayToolCall[];
  /**
   * 网关**已经执行完**但还没发给上游的工具结果（只在提前返回时非空）。
   * 不交出来的话它们已经在库里记成 submitted，却永远不会进入任何一次请求，
   * 调用方也拿不到——等于凭空蒸发。
   */
  completedToolResults: ConnectToolResult[];
  usage?: RequestUsage;
  resolvedModel?: string;
  iterations: number;
  stoppedBecause: ToolLoopStop;
}

export const DEFAULT_MAX_TOOL_ITERATIONS = 8;

/**
 * 无状态工具循环（计划 §G6.1）。
 *
 * 走 `Stream` 时每一轮都是**一个新的 HTTP 请求**：`conversation_id` 保持不变，
 * `invocation_id` 每轮新生成，上一轮的 assistant(tool_calls) 与 tool(tool_content)
 * 追加进 messages 再发一次。
 *
 * **未实测的前提**：上游是否真的按同一个 `conversation_id` 把两次 `Stream` 请求接续起来。
 * 计划 §13 把这条列为第二部分最大的单点风险——如果服务端依赖 invocation 之间的连接级状态，
 * 这条路走不通，必须切 `RunInference`（载荷类型相同，只换 transport 与握手）。
 * 代码按"能接续"实现，但调用方不应把它当已验证事实。
 */
export async function* runToolLoop(
  deps: ToolLoopDeps,
  options: ToolLoopOptions
): AsyncGenerator<CursorStreamEvent, ToolLoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  // `NaN < 1` 是 false，光比大小挡不住它；而 `iteration < NaN` 也是 false，
  // 结果是一次上游请求都不发就返回 max_iterations。`Number(env)` 没配时正好给出 NaN。
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new ApiError("maxIterations must be a positive integer.", 400, "invalid_request_error");
  }
  const newInvocationId = options.newInvocationId ?? randomUUID;

  // 只改本地副本：调用方传进来的 conversation 不该因为跑了一轮循环就被写脏。
  const messages: ConnectMessage[] = [...conversationMessages(options.conversation)];
  const aggregate = { text: "", reasoningText: "" };
  let usage: RequestUsage | undefined;
  let resolvedModel: string | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // 每轮开头先看取消。少了这一步，工具执行期间的取消要等到下一轮请求发出去、
    // 被 fetch 以 already-aborted 拒掉才反应过来——白建一次请求。
    if (options.signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");

    const request = buildInferenceStreamRequest({
      messages,
      tools: options.conversation.tools,
      conversationId: options.conversation.conversationId,
      ...(options.conversation.conversationGroupId
        ? { conversationGroupId: options.conversation.conversationGroupId }
        : {}),
      invocationId: newInvocationId(),
      requestedModel: options.requestedModel,
      ...(options.modelConfig ? { modelConfig: options.modelConfig } : {})
    });

    const normalizer = new ResponseNormalizer();
    for await (const frame of deps.client.stream(request, options.signal)) {
      deps.onEvents?.(draftEventsFromFrame(frame), iteration);
      yield* normalizer.accept(frame);
    }
    yield* normalizer.flush();

    aggregate.text += normalizer.state.text;
    aggregate.reasoningText += normalizer.state.reasoningText;
    if (normalizer.state.usage) usage = mergeUsage(usage, normalizer.state.usage);
    if (normalizer.state.resolvedModel) resolvedModel = normalizer.state.resolvedModel;

    const calls = normalizer.state.toolCalls;
    if (!calls.length) {
      return finish(aggregate, usage, resolvedModel, [], [], iteration + 1, "completed");
    }

    for (const call of calls) {
      deps.store?.recordToolCall({
        runId: options.runId,
        callId: call.id,
        toolName: call.name,
        args: call.arguments
      });
    }

    // 没有执行器就是无状态模式：把调用交回给调用方，由它在下一次 HTTP 请求里带上结果。
    if (!deps.executeTool) {
      return finish(aggregate, usage, resolvedModel, calls, [], iteration + 1, "awaiting_caller");
    }

    const executed = await executeAll(deps, options, calls, iteration);

    // 有工具网关执行不了：继续循环只会让模型对着一个永远不回来的调用干等。
    // 已经执行完的那部分必须随结果交出去——它们在库里已经记成 submitted，
    // 不交出来就永远不会进入任何一次请求。
    if (executed.unhandled.length) {
      return finish(
        aggregate,
        usage,
        resolvedModel,
        executed.unhandled,
        executed.results,
        iteration + 1,
        "awaiting_caller"
      );
    }
    if (!executed.results.length) {
      return finish(aggregate, usage, resolvedModel, [], [], iteration + 1, "awaiting_caller");
    }

    messages.push({
      role: "assistant",
      ...(normalizer.state.text ? { text: normalizer.state.text } : {}),
      toolCalls: calls.filter((call) => executed.handled.has(call.id))
    });
    messages.push({ role: "tool", toolResults: executed.results });
  }

  return finish(aggregate, usage, resolvedModel, [], [], maxIterations, "max_iterations");
}

async function executeAll(
  deps: ToolLoopDeps,
  options: ToolLoopOptions,
  calls: GatewayToolCall[],
  iteration: number
): Promise<{ results: ConnectToolResult[]; handled: Set<string>; unhandled: GatewayToolCall[] }> {
  const results: ConnectToolResult[] = [];
  const handled = new Set<string>();
  const unhandled: GatewayToolCall[] = [];

  // 一轮只读一次工具表。放在 per-call 循环里读，每个调用都要全表扫一遍。
  const priorByCallId = new Map((deps.store?.toolCalls(options.runId) ?? []).map((row) => [row.callId, row]));

  for (const call of calls) {
    // 重复提交同一个 result 必须幂等：store 说「已经提交过」时不再执行一次。
    // 但**要把存下来的结果拿出来重发**——只是 continue 的话这一轮就少了一条 tool result，
    // 上游会收到一个声明了调用却没给结果的请求。
    const prior = priorByCallId.get(call.id);
    if (prior?.status === "submitted") {
      handled.add(call.id);
      results.push({
        toolCallId: call.id,
        toolName: call.name,
        result: prior.resultJson ? safeParse(prior.resultJson) : null,
        isError: prior.isError
      });
      continue;
    }

    let execution: ToolExecution | undefined;
    try {
      execution = await deps.executeTool?.(call, { runId: options.runId, iteration, signal: options.signal });
    } catch (error) {
      // 工具自己炸了不该让整条流断掉：把失败作为 tool result 回灌，让模型有机会换个做法。
      execution = { result: { error: errorText(error) }, isError: true };
    }
    if (!execution) {
      unhandled.push(call);
      continue;
    }
    handled.add(call.id);
    deps.store?.submitToolResult(options.runId, call.id, execution.result, execution.isError ?? false);
    results.push({
      toolCallId: call.id,
      toolName: call.name,
      result: execution.result,
      isError: execution.isError ?? false
    });
  }
  return { results, handled, unhandled };
}

function finish(
  aggregate: { text: string; reasoningText: string },
  usage: RequestUsage | undefined,
  resolvedModel: string | undefined,
  pendingToolCalls: GatewayToolCall[],
  completedToolResults: ConnectToolResult[],
  iterations: number,
  stoppedBecause: ToolLoopStop
): ToolLoopResult {
  return {
    text: aggregate.text,
    reasoningText: aggregate.reasoningText,
    pendingToolCalls,
    completedToolResults,
    ...(usage ? { usage } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    iterations,
    stoppedBecause
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 多轮的用量要累加：每一轮是独立的一次推理，各报各的。 */
function mergeUsage(current: RequestUsage | undefined, next: RequestUsage): RequestUsage {
  if (!current) return next;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
    totalTokens: current.totalTokens + next.totalTokens
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "tool execution failed";
}
