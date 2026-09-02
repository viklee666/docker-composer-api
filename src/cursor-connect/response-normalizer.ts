import type { CursorRunResult, CursorStreamEvent, GatewayToolCall, RequestUsage } from "../types.js";
import { inferenceStreamError } from "./errors.js";
import { ApiError } from "../errors.js";
import type { InferenceStreamResponse } from "./proto/inference_pb.js";

/** 一次 run 从帧流里攒出来的全部状态。 */
export interface ConnectRunState {
  text: string;
  reasoningText: string;
  toolCalls: GatewayToolCall[];
  usage?: RequestUsage;
  /** `response_info.id`，上游给的响应标识。 */
  responseId?: string;
  /** `response_info.model`，上游实际解析到的模型（走 Stream 时这是唯一的回填来源）。 */
  resolvedModel?: string;
  /** `response_info.supports_self_summary`；走 Stream 时是事后信息。 */
  supportsSelfSummary?: boolean;
  /** 上游确认的 invocation id，用于与请求侧对账。 */
  invocationId?: string;
  /** thinking 片段的 signature，按出现顺序保留；回传上一轮 reasoning 时要原样带上。 */
  thinkingSignatures: string[];
  /** 遇到的未知 oneof case 名（新版本上游加的），只记不中断。 */
  unknownCases: string[];
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * `InferenceStreamResponse` → 网关内部事件。
 *
 * 只产出现有 `CursorStreamEvent` 的四种 case，不扩 union：
 * usage 走 `telemetryRef`（与 SDK 路线同一条通道），错误直接抛 `ApiError`。
 * 这样 server.ts / SSE 输出层一行都不用改。
 */
export class ResponseNormalizer {
  readonly state: ConnectRunState = {
    text: "",
    reasoningText: "",
    toolCalls: [],
    thinkingSignatures: [],
    unknownCases: []
  };

  /** tool_call_part 的三态解析需要按 tool_call_id 累积 args。 */
  private readonly pending = new Map<string, PendingToolCall>();

  /**
   * 已经产出过的调用键。
   * 少了它，重复的 `is_complete` 帧会把同一个调用发两遍，
   * 完成之后迟到的 args 增量还会新建一个 name 为空的幽灵调用，在 flush 时冒出来。
   */
  private readonly completed = new Set<string>();

  /** 收到过 extended_usage 之后，粗口径的 usage 帧不再回写。 */
  private hasExtendedUsage = false;

  /**
   * 消费一帧，产出 0..n 个事件。
   * 上游报错时抛出——把 error 帧降级成一个普通事件，会让调用方以为请求成功但内容为空。
   */
  *accept(frame: InferenceStreamResponse): Generator<CursorStreamEvent> {
    const response = frame.response;
    switch (response.case) {
      case "textPart": {
        // is_final 的帧 text 常常是空的：只表示「文本到此为止」，不应产生空文本块。
        if (response.value.text) {
          this.state.text += response.value.text;
          yield { type: "text", text: response.value.text };
        }
        return;
      }
      case "thinkingPart": {
        if (response.value.signature) this.state.thinkingSignatures.push(response.value.signature);
        if (response.value.text) {
          this.state.reasoningText += response.value.text;
          yield { type: "thinking", text: response.value.text };
        }
        return;
      }
      case "toolCallPart": {
        const toolCall = this.acceptToolCall(response.value);
        if (toolCall) yield { type: "tool_call", toolCall };
        return;
      }
      // usage 与 extended_usage 的口径不同，**不能逐字段合并**：
      // `prompt_tokens` 是含缓存的总输入，而 `input_tokens` 是缓存之外的那部分。
      // 两者取 max 会把 input=100 与 cacheRead=80 凑到一起，凭空多出 80 个 token。
      // RequestUsage 是四桶互斥口径（totalTokens = input+output+cacheRead+cacheWrite），
      // extended_usage 正好就是这四个桶，所以它一到就整体接管。
      case "usage": {
        if (this.hasExtendedUsage) return;
        const { promptTokens, completionTokens } = response.value;
        this.state.usage = {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: promptTokens + completionTokens
        };
        return;
      }
      case "extendedUsage": {
        const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = response.value;
        this.hasExtendedUsage = true;
        this.state.usage = {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
        };
        return;
      }
      case "responseInfo": {
        const info = response.value;
        this.state.responseId = info.id || this.state.responseId;
        this.state.resolvedModel = info.model || this.state.resolvedModel;
        if (info.supportsSelfSummary !== undefined) this.state.supportsSelfSummary = info.supportsSelfSummary;
        // response_info 也能带错误：这条路径下没有 error 帧，漏了就会静默返回半截内容。
        if (info.errorMessage) throw new ApiError(info.errorMessage, 500, "upstream_error");
        return;
      }
      case "invocationId": {
        this.state.invocationId = response.value.invocationId;
        return;
      }
      case "error":
        throw inferenceStreamError(response.value);
      case "providerMetadata":
      case "imageDescriptions":
        // 结构已知但本阶段不消费，记一笔便于排查。
        this.noteCase(response.case);
        return;
      default:
        // 新版本上游加的 case。记 case 名，不记 payload——payload 里可能有用户内容。
        this.noteCase(response.case ?? "(empty)");
        return;
    }
  }

  /**
   * 流结束时把还没 complete 的工具调用收尾。
   * 上游在 `is_complete` 之前断流时，已累积的 args 仍然比丢掉有用。
   */
  *flush(): Generator<CursorStreamEvent> {
    for (const [key, pending] of [...this.pending]) {
      this.pending.delete(key);
      yield { type: "tool_call", toolCall: this.completeToolCall(key, pending) };
    }
  }

  result(): CursorRunResult {
    return {
      text: this.state.text,
      toolCalls: this.state.toolCalls,
      ...(this.state.reasoningText ? { reasoningText: this.state.reasoningText } : {})
    };
  }

  /** 只记 case 名去重后的列表，不记 payload——payload 里可能有用户内容，而且帧数不可控。 */
  private noteCase(name: string): void {
    if (!this.state.unknownCases.includes(name)) this.state.unknownCases.push(name);
  }

  /**
   * 三态：`is_complete` → 完整调用；有 tool_name 且未完成 → streaming-start；
   * 两者都没有 → args 增量。这与客户端 `675.js` 的判定顺序一致。
   */
  private acceptToolCall(part: {
    toolCallId: string;
    toolName: string;
    args: string;
    isComplete: boolean;
    toolIndex?: number;
  }): GatewayToolCall | undefined {
    // 并行调用时上游可能只在增量帧里带 tool_index、不重复 tool_call_id；
    // 只按 id 归并会把所有并行调用挤进同一个空 id 的槽里。
    const key = part.toolCallId || (part.toolIndex === undefined ? "" : `#${part.toolIndex}`);
    if (this.completed.has(key)) return undefined;

    const existing = this.pending.get(key);
    if (part.isComplete) {
      this.pending.delete(key);
      return this.completeToolCall(key, {
        id: part.toolCallId || existing?.id || key,
        // 完成帧不一定重复带 tool_name，沿用 streaming-start 记下的那个。
        name: part.toolName || existing?.name || "",
        // 完成帧的 args 是全量还是增量取决于上游；带了就以它为准，没带才用累积值。
        args: part.args || existing?.args || ""
      });
    }
    if (part.toolName) {
      this.pending.set(key, { id: part.toolCallId || key, name: part.toolName, args: part.args ?? "" });
      return undefined;
    }
    if (existing) existing.args += part.args ?? "";
    else this.pending.set(key, { id: part.toolCallId || key, name: "", args: part.args ?? "" });
    return undefined;
  }

  private completeToolCall(key: string, pending: PendingToolCall): GatewayToolCall {
    this.completed.add(key);
    const toolCall: GatewayToolCall = {
      id: pending.id,
      name: pending.name,
      arguments: parseToolArgs(pending.args)
    };
    this.state.toolCalls.push(toolCall);
    return toolCall;
  }
}

/** 客户端原文就是 parse 失败置 `{}`；这里照做，不要因为一个坏参数把整条流打断。 */
function parseToolArgs(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
