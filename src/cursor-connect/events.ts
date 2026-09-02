import type { RequestUsage } from "../types.js";
import type { InferenceStreamResponse } from "./proto/inference_pb.js";

export const UNIFIED_EVENT_VERSION = 1;

/**
 * 事件类型分两类，这个区分是 G9 重放策略的依据，不是分类癖：
 *
 * - **网关自造**：上游没有对应帧，重跑一定能重新生成，重放安全；
 * - **有上游帧支撑**：重跑后内容可能不同（模型输出不确定），
 *   已经投递给客户端的这类事件不能靠"再跑一次"补回来。
 */
export const GATEWAY_EVENT_TYPES = [
  "run.accepted",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "task.created",
  "task.started",
  "task.awaiting_tool",
  "task.awaiting_child",
  "task.completed",
  "summary.started",
  "summary.completed",
  "tool.result.accepted",
  /** worker 侧的收尾。与上游 `response_info` 带来的 `run.completed` 是两回事。 */
  "run.finished",
  /**
   * 网关侧判定的失败（本地执行抛异常），与上游帧带来的 `run.failed` 分开。
   * 前者重跑一定能重来，后者重跑内容可能不同——这正是这张表存在的意义。
   */
  "run.errored"
] as const;

export const UPSTREAM_EVENT_TYPES = [
  "text.delta",
  "text.final",
  "thinking.delta",
  "thinking.signature",
  "tool.call.start",
  "tool.call.delta",
  "tool.call.complete",
  "usage",
  "usage.extended",
  "provider.metadata",
  /** 上游发来了本版本不认识的 oneof case。与 provider.metadata 分开，否则谁也答不出"上游加了新 case 吗"。 */
  "provider.unknown",
  "invocation.confirmed",
  "image.descriptions",
  "run.completed",
  "run.failed"
] as const;

export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number];
export type UpstreamEventType = (typeof UPSTREAM_EVENT_TYPES)[number];
export type UnifiedEventType = GatewayEventType | UpstreamEventType;

const GATEWAY_EVENT_SET: ReadonlySet<string> = new Set(GATEWAY_EVENT_TYPES);

export function isGatewayGenerated(type: UnifiedEventType): boolean {
  return GATEWAY_EVENT_SET.has(type);
}

export interface UnifiedEvent {
  version: number;
  eventId: string;
  runId: string;
  conversationId: string;
  /** 网关自己生成的单调递增序号，不依赖上游。 */
  seq: number;
  type: UnifiedEventType;
  /** 第几次尝试。重放时用来区分「同一逻辑事件的不同次产出」。 */
  attempt: number;
  /** 来源 oneof case 名，便于排查；网关自造事件没有。 */
  upstreamCase?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** 未落库、未编号的事件。seq / eventId 由 event store 分配。 */
export interface DraftEvent {
  type: UnifiedEventType;
  upstreamCase?: string;
  payload: Record<string, unknown>;
}

/**
 * `InferenceStreamResponse` → 统一事件。
 *
 * 与 `ResponseNormalizer` 是两条互补的路径而不是重复：normalizer 产出的是
 * `CursorStreamEvent`（喂给现有 SSE 输出层，只有四个 case），这里产出的是可落库、
 * 可按 seq 重放的完整事件流。两者共用同一份帧，谁也不改谁的语义。
 *
 * 工具调用的三态在这里**不做累积**：累积是有状态的，属于 tool-loop；
 * 事件流要如实记录每一帧，否则重放出来的就不是上游真实发生过的东西。
 */
export function draftEventsFromFrame(frame: InferenceStreamResponse): DraftEvent[] {
  const response = frame.response;
  // switch 覆盖了全部 10 个 case，`response` 在 default 分支里会被收窄成 never，
  // 单独留一份未收窄的 case 名给未知 case 用。
  const kind: string | undefined = frame.response.case;
  switch (response.case) {
    case "textPart":
      return [
        {
          type: response.value.isFinal ? "text.final" : "text.delta",
          upstreamCase: "textPart",
          payload: { text: response.value.text, isFinal: response.value.isFinal }
        }
      ];
    case "thinkingPart": {
      const events: DraftEvent[] = [];
      if (response.value.text) {
        events.push({
          type: "thinking.delta",
          upstreamCase: "thinkingPart",
          payload: { text: response.value.text }
        });
      }
      if (response.value.signature) {
        events.push({
          type: "thinking.signature",
          upstreamCase: "thinkingPart",
          payload: { signature: response.value.signature }
        });
      }
      return events;
    }
    case "toolCallPart": {
      const part = response.value;
      const payload: Record<string, unknown> = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
        ...(part.toolIndex === undefined ? {} : { toolIndex: part.toolIndex })
      };
      // 与 675.js 的判定顺序一致：is_complete 优先，其次 tool_name，最后才是 args 增量。
      const type: UnifiedEventType = part.isComplete
        ? "tool.call.complete"
        : part.toolName
          ? "tool.call.start"
          : "tool.call.delta";
      return [{ type, upstreamCase: "toolCallPart", payload }];
    }
    case "usage":
      return [
        {
          type: "usage",
          upstreamCase: "usage",
          payload: {
            promptTokens: response.value.promptTokens,
            completionTokens: response.value.completionTokens,
            ...(response.value.totalTokens === undefined ? {} : { totalTokens: response.value.totalTokens })
          }
        }
      ];
    case "extendedUsage":
      return [
        {
          type: "usage.extended",
          upstreamCase: "extendedUsage",
          payload: {
            inputTokens: response.value.inputTokens,
            outputTokens: response.value.outputTokens,
            cacheReadTokens: response.value.cacheReadTokens,
            cacheWriteTokens: response.value.cacheWriteTokens,
            maxTokens: response.value.maxTokens
          }
        }
      ];
    case "responseInfo": {
      const info = response.value;
      const payload: Record<string, unknown> = {
        id: info.id,
        model: info.model,
        // created_at 是 int64 → bigint，JSON 序列化不了，落库前先转成字符串。
        createdAt: info.createdAt.toString(),
        ...(info.supportsSelfSummary === undefined ? {} : { supportsSelfSummary: info.supportsSelfSummary })
      };
      if (info.errorMessage) {
        return [{ type: "run.failed", upstreamCase: "responseInfo", payload: { ...payload, error: info.errorMessage } }];
      }
      return [{ type: "run.completed", upstreamCase: "responseInfo", payload }];
    }
    case "invocationId":
      return [
        {
          type: "invocation.confirmed",
          upstreamCase: "invocationId",
          payload: { invocationId: response.value.invocationId }
        }
      ];
    case "error":
      return [
        {
          type: "run.failed",
          upstreamCase: "error",
          payload: {
            message: response.value.message,
            code: response.value.code,
            errorType: response.value.errorType,
            isInputTokenLimitError: response.value.isInputTokenLimitError,
            isOutputTokenLimitError: response.value.isOutputTokenLimitError
          }
        }
      ];
    case "providerMetadata":
      return [{ type: "provider.metadata", upstreamCase: "providerMetadata", payload: {} }];
    case "imageDescriptions":
      return [
        {
          type: "image.descriptions",
          upstreamCase: "imageDescriptions",
          payload: { count: response.value.descriptions.length }
        }
      ];
    default:
      // 新版本上游加的 case：记 case 名，不记 payload（里面可能有用户内容），不中断流。
      return kind ? [{ type: "provider.unknown", upstreamCase: kind, payload: {} }] : [];
  }
}

/**
 * 从一串事件里还原本轮用量（四桶互斥口径）。
 *
 * 必须用它而不是对事件流做 last-wins 的 `usageFromEvent`：
 * `usage.prompt_tokens` 是含缓存的总输入，`usage.extended.input_tokens` 是缓存之外的部分，
 * 两者口径不同。`extended` 一旦出现就整体接管，与 `ResponseNormalizer` 的行为保持一致——
 * 否则同一条流经事件库重放出来的用量会和实时算出来的不一样。
 */
export function reduceUsage(events: Array<Pick<UnifiedEvent, "type" | "payload">>): RequestUsage | undefined {
  let coarse: RequestUsage | undefined;
  let extended: RequestUsage | undefined;
  for (const event of events) {
    const usage = usageFromEvent(event);
    if (!usage) continue;
    if (event.type === "usage.extended") extended = usage;
    else coarse = usage;
  }
  return extended ?? coarse;
}

/** 单个 usage / usage.extended 事件 → RequestUsage。跨事件聚合请用 `reduceUsage`。 */
export function usageFromEvent(event: Pick<UnifiedEvent, "type" | "payload">): RequestUsage | undefined {
  const payload = event.payload;
  if (event.type === "usage.extended") {
    const inputTokens = numberOr(payload.inputTokens);
    const outputTokens = numberOr(payload.outputTokens);
    const cacheReadTokens = numberOr(payload.cacheReadTokens);
    const cacheWriteTokens = numberOr(payload.cacheWriteTokens);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    };
  }
  if (event.type === "usage") {
    const inputTokens = numberOr(payload.promptTokens);
    const outputTokens = numberOr(payload.completionTokens);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens
    };
  }
  return undefined;
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
