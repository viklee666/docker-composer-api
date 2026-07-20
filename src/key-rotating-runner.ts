import { ApiError } from "./errors.js";
import { classifyKeyFailure, CursorKeyPool, errorMessage } from "./key-pool.js";
import type {
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayToolCall
} from "./types.js";

/** 单次请求最多尝试的 key 数默认上限，避免 key 极多时无界轮换放大上游压力。可由 MAX_KEY_ATTEMPTS 覆盖。 */
const DEFAULT_MAX_KEY_ATTEMPTS = 10;
/**
 * 单次请求中 transient（上游无详情 error）软失败的默认重试上限。
 * 避免某模型在所有 key 上都不可用时把整池 key 试一遍白烧额度；超过即停手透出 502。可由 MAX_TRANSIENT_KEY_ATTEMPTS 覆盖。
 */
const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 3;

export interface KeyRotatingOptions {
  /** 单次请求最多尝试的 key 数（含成功前的失败次数）。默认 10。 */
  maxKeyAttempts?: number;
  /** 单次请求 transient 软失败的最大次数，超过则不再换 key、直接透出上游错误（502）。默认 3。 */
  maxTransientAttempts?: number;
}

/**
 * 包装真实 runner：useKeyPool 的请求按后台设置的顺序取 key 调上游；
 * - 命中额度不足/无效 key（quota/auth）时禁用该 key 并自动换下一个重试；
 * - 命中上游无详情 error（transient）时不禁用、但仍换下一个 key 重试，
 *   让队首坏 key 不再拖死后续有效 key；transient 累计到上限或全部 key 都 transient 失败时透出真实上游错误（502）；
 * - 全部 key 已被禁用/耗尽时返回 429 insufficient_quota（无有效 key）。
 */
export class KeyRotatingRunner implements CursorRunner {
  private readonly maxKeyAttempts: number;
  private readonly maxTransientAttempts: number;

  constructor(
    private readonly inner: CursorRunner,
    private readonly pool: CursorKeyPool,
    options: KeyRotatingOptions = {}
  ) {
    this.maxKeyAttempts = positiveIntOr(options.maxKeyAttempts, DEFAULT_MAX_KEY_ATTEMPTS);
    this.maxTransientAttempts = positiveIntOr(options.maxTransientAttempts, DEFAULT_MAX_TRANSIENT_ATTEMPTS);
  }

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    let result: CursorRunResult | undefined;
    let text = "";
    const toolCalls: GatewayToolCall[] = [];
    for await (const event of this.stream(input, signal)) {
      if (event.type === "text") text += event.text;
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
      if (event.type === "done") result = event.result;
    }
    return result ?? { text, toolCalls };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    if (!input.useKeyPool) {
      if (!input.apiKey) throw new ApiError("Missing Cursor API key.", 401, "unauthorized");
      yield* this.inner.stream(input, signal);
      return;
    }

    const attempted = new Set<string>();
    // 最近一次 transient（上游无详情 error）错误；所有 key 都 transient 失败时透出它而非误报额度耗尽。
    let transientError: unknown;
    let transientCount = 0;
    for (;;) {
      const key = await this.pool.pickActive(attempted);
      if (!key) {
        if (transientError) throw transientError;
        throw new ApiError(
          attempted.size
            ? "No valid Cursor API key available: all keys are exhausted or invalid and were disabled automatically. Re-enable keys in the admin panel after quota recovers."
            : (await this.pool.hasAnyKey())
              ? "No valid Cursor API key available: all keys are disabled. Re-enable keys in the admin panel."
              : "No valid Cursor API key available: none configured. Add keys in the admin panel or via CURSOR_API_KEYS.",
          429,
          "insufficient_quota"
        );
      }
      if (attempted.size >= this.maxKeyAttempts) {
        if (transientError) throw transientError;
        throw new ApiError(
          "Exhausted Cursor API key rotation attempts without success.",
          502,
          "upstream_run_failed"
        );
      }
      attempted.add(key.id);
      if (input.keyUsageRef) {
        input.keyUsageRef.keyId = key.id;
        input.keyUsageRef.keyLabel = key.label;
      }
      await this.pool.recordUse(key.id);

      let emitted = false;
      try {
        for await (const event of this.inner.stream({ ...input, apiKey: key.apiKey }, signal)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const failure = classifyKeyFailure(error);
        if (failure === "quota" || failure === "auth") {
          await this.pool.disable(key.id, failure, errorMessage(error));
        } else if (failure === "transient") {
          // 不禁用：原因不确定，可能只是上游临时容量不足；记下错误后换下一个 key 重试。
          transientError = error;
          transientCount += 1;
        }
        // 已向客户端吐出过内容时无法安全重试；非 key 级错误原样抛出。
        if (!failure || emitted || signal?.aborted) throw error;
        // transient 软失败累计到上限：停手透出上游错误，避免某模型在整池 key 上都不可用时把额度试个遍。
        if (failure === "transient" && transientCount >= this.maxTransientAttempts) throw error;
      }
    }
  }
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
