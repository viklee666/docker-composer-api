import { randomUUID, createHash } from "node:crypto";
import { ApiError, raceWithAbort } from "./errors.js";
import { classifyErrorText, classifyKeyFailure, errorMessage, isRateLimitError } from "./key-pool.js";
import { resolveModelParams, type ModelCatalog, type ModelIntent } from "./model-params.js";
import { parseToolCallJson, parseToolMarkers } from "./protocol.js";
import { createSdkCustomTools, matchesClientTool, normalizeToolCallForClient, normalizeToolCallsForClient } from "./tool-compat.js";
import type {
  AgentMode,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  GatewayToolCall,
  ModelParameterValue,
  StateStore
} from "./types.js";

/** 解析后可直接发给 SDK 的模型选择 + 会话模式。 */
interface ResolvedModelRun {
  model: { id: string; params?: ModelParameterValue[] };
  mode?: AgentMode;
}

export interface AgentLike {
  agentId?: string;
  send(message: unknown, options: Record<string, unknown>): Promise<RunLike>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

interface RunLike {
  id?: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<unknown>;
  cancel?: () => Promise<unknown>;
}

export interface AgentFactory {
  create(options: Record<string, unknown>): Promise<AgentLike>;
  resume?(agentId: string, options: Record<string, unknown>): Promise<AgentLike>;
}

export class CursorSdkRunner implements CursorRunner {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: StateStore,
    private readonly input: {
      defaultWorkingDirectory: string;
      sdkClientVersion: string;
      /** 为 API 网关默认使用“每次请求 fresh agent”，避免远端 agent 会话长期累积/污染后所有请求持续 502。 */
      disableSessionResume?: boolean;
      /** 允许 agent 在网关容器内使用内置工具（默认 false：SDK >=1.0.27 下用 tools 限制为纯文本/仅 MCP）。 */
      allowBuiltinTools?: boolean;
      /**
       * 注入给每个 agent 的共享 LocalAgentStore。SDK 默认的 SqliteLocalAgentStore 按 agent 各开一份，
       * 每次请求泄漏约 7~8 个内核句柄且 dispose 不回收；stateless 模式下传入网关的有界内存 store 规避。
       */
      localAgentStore?: object;
      /** 用于按模型发现目录（Cursor.models.list() 的参数定义 + variants），把思考强度/Max Mode 等语义意图解析成合法 model.params。 */
      getModelCatalog?: (modelId: string, apiKey?: string) => Promise<ModelCatalog | undefined>;
    },
    private readonly agentFactory?: AgentFactory
  ) {}

  async run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    const events = this.stream(input, signal);
    let result: CursorRunResult | undefined;
    let text = "";
    let reasoningText = "";
    const toolCalls: GatewayToolCall[] = [];
    for await (const event of events) {
      if (event.type === "text") text += event.text;
      // 非流式下 thinking 没有别的出口，聚合起来供 reasoning_content / reasoning item / thinking 块使用。
      if (event.type === "thinking") reasoningText += event.text;
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
      if (event.type === "done") result = event.result;
    }
    // done 的 result 是权威结果（与 text/toolCalls 同理）；本地累积只在缺 done 事件时兜底。
    return result ?? { text, toolCalls, ...(reasoningText ? { reasoningText } : {}) };
  }

  async *stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    if (signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");
    const id = sessionId(input);
    // stateless 模式（默认）下每请求都是独立 fresh agent，没有共享会话状态需要保护；
    // 跳过互斥锁，否则同一网关 key + 模型的所有并发请求会被完全串行化。
    if (this.input.disableSessionResume) {
      yield* this.streamLocked(input, signal, id);
      return;
    }
    yield* this.withSessionLock(id, () => this.streamLocked(input, signal, id));
  }

  private async *streamLocked(input: CursorRunRequest, signal: AbortSignal | undefined, id: string): AsyncIterable<CursorStreamEvent> {
    const factory = this.agentFactory ?? await this.loadAgentFactory();
    // 目录拉取 / agent 创建 / send 这些 SDK 调用可能既不 settle 也不感知 signal（上游传输挂死）。
    // 全部与 abort 竞速：空闲超时或客户端断连时请求一定能收尾，而不是永久悬挂、随流量持续堆积句柄与内存。
    const resolved = await raceWithAbort(this.resolveModelRun(input), signal);
    const existingAgentId = this.input.disableSessionResume ? undefined : await this.store.getSession(id);
    let resumedAgent: AgentLike | undefined;
    if (existingAgentId && typeof factory.resume === "function") {
      try {
        resumedAgent = await raceCreateAgent(factory.resume(existingAgentId, this.agentOptions(input, resolved)), signal);
      } catch (error) {
        const keyError = keySemanticApiError(input.model, error);
        if (keyError) throw keyError;
        // 旧 agent 明确不可 resume，清掉后走新建。
        await this.store.deleteSession(id).catch(() => undefined);
      }
    }

    if (resumedAgent) {
      try {
        yield* this.runWithAgent(resumedAgent, input, signal, id, resolved);
        return;
      } catch (error) {
        if (!isRetryableStaleSessionError(error) && !isActiveRunError(error)) throw error;
        // 旧 agent 可能已过期，或仍有 CREATING/RUNNING run；清掉绑定后用 fresh agent 避免客户端重试卡死。
        await this.store.deleteSession(id).catch(() => undefined);
      }
    }

    const agent = await raceCreateAgent(factory.create(this.agentOptions(input, resolved)), signal).catch((error) => {
      throw keySemanticApiError(input.model, error) ?? modelUnavailableError(error) ?? error;
    });
    yield* this.runWithAgent(agent, input, signal, id, resolved);
  }

  /** 把请求里的模型运行意图解析成可直接发给 SDK 的模型选择（model.params）+ 会话模式。 */
  private async resolveModelRun(input: CursorRunRequest): Promise<ResolvedModelRun> {
    const intent: ModelIntent = {
      reasoningEffort: input.reasoningEffort,
      maxMode: input.maxMode,
      fast: input.fast,
      params: input.modelParams,
      mode: input.mode
    };
    const needsCatalog = intent.reasoningEffort !== undefined || intent.maxMode !== undefined || intent.fast !== undefined;
    let catalog: ModelCatalog | undefined;
    if (needsCatalog && this.input.getModelCatalog) {
      catalog = await this.input.getModelCatalog(input.model, input.apiKey).catch(() => undefined);
    }
    const resolved = resolveModelParams(catalog, intent, input.model);
    logDroppedIntent(input.model, resolved.dropped, resolved.usedFallback);
    const model: ResolvedModelRun["model"] = { id: input.model };
    if (resolved.params.length) {
      model.params = resolved.params;
      // 正向可观测性：记录实际下发的 model.params（同组合 10 分钟内只打一次），便于对照 Cursor 仪表盘核实 fast/Max Mode 是否生效。
      const summary = resolved.params.map((param) => `${param.id}=${param.value}`).join(",");
      logDeduped(`sent\0${input.model}\0${summary}`, `[model-params] model="${input.model}" sending params: ${summary}`);
    }
    return { model, ...(intent.mode ? { mode: intent.mode } : {}) };
  }

  private async *withSessionLock(id: string, run: () => AsyncIterable<CursorStreamEvent>): AsyncIterable<CursorStreamEvent> {
    const previous = this.sessionLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.sessionLocks.set(id, current);
    await previous.catch(() => undefined);
    try {
      yield* run();
    } finally {
      release();
      if (this.sessionLocks.get(id) === current) this.sessionLocks.delete(id);
    }
  }

  private async *runWithAgent(
    agent: AgentLike,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    id: string,
    resolved: ResolvedModelRun
  ): AsyncIterable<CursorStreamEvent> {
    let activeRun: RunLike | undefined;
    let finishedNormally = false;
    // onDelta（SDK 逐 token 回调）与 run.stream()（消息级事件）合流进同一个队列消费：
    // 文本以 token 粒度实时下发；tool_call / 错误归因仍走消息级事件。
    const queue = new AsyncQueue<QueueItem>();
    const onAbort = () => queue.push({ kind: "abort" });
    try {
      if (signal?.aborted) throw new ApiError("Request was aborted.", 499, "request_aborted");
      const capturedToolCalls: GatewayToolCall[] = [];
      // capture 回调除记录调用外还推一个唤醒项：队列空等时也能立即处理 capture 并取消 run。
      const customTools = createSdkCustomTools(input.tools, (toolCall) => {
        pushToolCall(capturedToolCalls, toolCall);
        queue.push({ kind: "captured" });
      });
      const onDelta = (args: { update: unknown }) => {
        queue.push({ kind: "delta", update: args?.update });
      };
      const run = await this.sendWithOptionalCustomTools(agent, input, customTools, resolved, onDelta, signal);
      activeRun = run;
      // abort 必须能唤醒空队列等待，否则超时/断连时上游无事件的 run 会永久挂住。
      signal?.addEventListener("abort", onAbort, { once: true });
      // abort 若恰好发生在 await send() 期间，事件在注册 listener 前已触发，必须补推一次。
      if (signal?.aborted) queue.push({ kind: "abort" });
      void (async () => {
        try {
          for await (const event of run.stream()) queue.push({ kind: "event", event });
          queue.push({ kind: "end" });
        } catch (error) {
          queue.push({ kind: "end", error });
        }
      })();

      const textParts: string[] = [];
      // 思考文本随 result 一起返回：非流式聚合器换 key 重试时，只有本次成功尝试的思考会被采用。
      // 流式请求的思考已逐块发给客户端，result 里的副本无人消费，不再留存（长思考会白占内存）。
      const keepThinking = !input.stream;
      const thinkingParts: string[] = [];
      const toolCalls: GatewayToolCall[] = [];
      const streamErrorDetails: string[] = [];
      // 有客户端工具时用增量 marker 过滤器实现“乐观流式”：正文实时下发，只暂扣可能是 <tool_call> 前缀的尾部。
      const filter = input.tools.length ? new ToolMarkerFilter() : undefined;
      // 文本/思考各锁定单一来源（delta 或 message），防止来源交错时重复或丢字。
      let textSource: "none" | "delta" | "message" = "none";
      let thinkingSource: "none" | "delta" | "message" = "none";
      let streamError: unknown;
      // cancel 也走坏传输时可能挂死：加时长上限，别让工具调用下发/abort 收尾被它堵住。
      const cancelRun = () => withCleanupTimeout(run.cancel?.().catch(() => undefined));
      // 过滤 marker/事件里未被客户端声明的工具调用（转发只会让客户端报 unknown tool）。
      const keepDeclaredOnly = (calls: GatewayToolCall[]): GatewayToolCall[] => calls.filter((toolCall) => {
        if (input.tools.length && matchesClientTool(toolCall, input.tools)) return true;
        logDeduped(
          `unmatched\0${input.model}\0${toolCall.name}`,
          `[tool-compat] model="${input.model}" dropped tool call "${toolCall.name}" not declared by the client`
        );
        return false;
      });

      loop: for (;;) {
        const item = await queue.next();
        if (signal?.aborted || item.kind === "abort") {
          await cancelRun();
          throw new ApiError("Request was aborted.", 499, "request_aborted");
        }
        let chunk = "";
        // 事件里的工具调用延后到文本处理之后再转发：同一 assistant 事件可能同时带 text 和 tool_use，文本必须先下发。
        let eventToolCalls: GatewayToolCall[] = [];
        if (item.kind === "delta") {
          const update = asRecord(item.update);
          const type = typeof update?.type === "string" ? update.type : "";
          // 空字符串 delta 不锁定来源，否则后续合法的消息级全文会被误屏蔽。
          if (type === "text-delta" && typeof update?.text === "string" && update.text && textSource !== "message") {
            textSource = "delta";
            chunk = update.text;
          } else if (type === "thinking-delta" && typeof update?.text === "string" && update.text && thinkingSource !== "message") {
            thinkingSource = "delta";
            if (keepThinking) thinkingParts.push(update.text);
            yield { type: "thinking", text: update.text };
          }
        } else if (item.kind === "event") {
          const event = item.event;
          const thinking = thinkingFromSdkEvent(event);
          if (thinking && thinkingSource !== "delta") {
            thinkingSource = "message";
            if (keepThinking) thinkingParts.push(thinking);
            yield { type: "thinking", text: thinking };
          }
          const text = textFromSdkEvent(event);
          // onDelta 已产出过文本时跳过消息级全文，避免同一段内容双份输出。
          if (text && textSource !== "delta") {
            textSource = "message";
            chunk = text;
          }
          const errorDetail = errorDetailFromSdkEvent(event);
          if (errorDetail) streamErrorDetails.push(errorDetail);
          eventToolCalls = keepDeclaredOnly(toolCallsFromSdkEvent(event))
            .map((toolCall) => normalizeToolCallForClient(toolCall, input.tools));
        } else if (item.kind === "end") {
          streamError = item.error;
          break;
        }
        // item.kind === "captured" 只是唤醒，落到下方统一的 captured 检查。

        if (chunk) {
          if (!filter) {
            textParts.push(chunk);
            yield { type: "text", text: chunk };
          } else {
            const safe = filter.push(chunk);
            if (safe) {
              textParts.push(safe);
              yield { type: "text", text: safe };
            }
            const markerCalls = filter.takeToolCalls();
            if (markerCalls.length) {
              const declared = keepDeclaredOnly(markerCalls);
              if (declared.length) {
                // 先 cancel 再 yield：消费方（客户端断连）可能在 yield 处终止本生成器，取消不能排在其后。
                await cancelRun();
                for (const toolCall of normalizeToolCallsForClient(declared, input.tools)) {
                  pushToolCall(toolCalls, toolCall);
                  yield { type: "tool_call", toolCall };
                }
                break loop;
              }
              // 全部 marker 都未被客户端声明（已记日志丢弃）：取回 marker 之后暂存的正文，继续正常流式。
              const held = filter.takeHeldText();
              if (held) {
                textParts.push(held);
                yield { type: "text", text: held };
              }
            }
          }
        }

        if (eventToolCalls.length) {
          // 先取消，避免 SDK 在容器内继续执行本地工具，也防止消费方提前终止时漏掉取消。
          await cancelRun();
          for (const toolCall of eventToolCalls) {
            pushToolCall(toolCalls, toolCall);
            yield { type: "tool_call", toolCall };
          }
          break;
        }

        const captured = pendingCapturedToolCalls(capturedToolCalls, toolCalls);
        if (captured.length) {
          await cancelRun();
          for (const toolCall of captured) {
            pushToolCall(toolCalls, toolCall);
            yield { type: "tool_call", toolCall };
          }
          break;
        }
      }

      // 自定义工具回调已捕获到调用时，即使 SDK 流因取消/工具结果报错，也应把调用返回给客户端。
      if (streamError && (signal?.aborted || !capturedToolCalls.length)) throw streamError;

      // 吐出 marker 过滤器暂扣的尾部文本（未构成完整 marker 的部分）；有工具调用时该尾部多为残缺 marker，丢弃。
      if (filter && !toolCalls.length && !capturedToolCalls.length) {
        const rest = filter.flush();
        if (rest) {
          textParts.push(rest);
          yield { type: "text", text: rest };
        }
      }

      const missedCapturedToolCalls = pendingCapturedToolCalls(capturedToolCalls, toolCalls);
      if (missedCapturedToolCalls.length) {
        await cancelRun();
        for (const toolCall of missedCapturedToolCalls) {
          pushToolCall(toolCalls, toolCall);
          yield { type: "tool_call", toolCall };
        }
      }

      // wait() 也要能被 abort 打断：上游卡死时客户端断连/超时不能永久挂在这里。
      let waitError: unknown;
      let waited: unknown;
      try {
        waited = await raceWithAbort(run.wait(), signal);
      } catch (error) {
        if (error instanceof ApiError && error.code === "request_aborted") {
          await cancelRun();
          throw error;
        }
        waitError = error;
      }
      // wait 期间才到达的 capture 也要补发（execute 回调可能与 cancel/wait 并发）。
      for (const toolCall of pendingCapturedToolCalls(capturedToolCalls, toolCalls)) {
        pushToolCall(toolCalls, toolCall);
        yield { type: "tool_call", toolCall };
      }
      const waitedText = resultText(waited);
      if (!toolCalls.length && !textParts.length && waitedText) {
        // 流阶段没有任何产出、只有 wait() 的最终文本时才使用它；仍需做一次静态 marker 解析。
        const parsed = input.tools.length ? parseToolMarkers(waitedText) : { text: waitedText, toolCalls: [] };
        const declared = keepDeclaredOnly(parsed.toolCalls);
        if (declared.length) {
          for (const toolCall of normalizeToolCallsForClient(declared, input.tools)) {
            pushToolCall(toolCalls, toolCall);
            yield { type: "tool_call", toolCall };
          }
        }
        if (parsed.text && !declared.length) {
          textParts.push(parsed.text);
          yield { type: "text", text: parsed.text };
        }
      }

      // run 以 error/cancelled 收场且没有任何产出时必须显式报错，否则会变成空 200。
      //（本网关自己的 cancel 都发生在已产出工具调用/文本之后，零产出的 cancelled 一定是外部/异常取消。）
      // SDK >=1.0.23 的失败 run 携带结构化 error（message/code），此处尽量提取真实原因
      //（如区域限制 "not supported in your region"、额度耗尽等），避免单一归因误导排查。
      const terminalStatus = runStatus(waited);
      if (!textParts.length && !toolCalls.length && (terminalStatus === "error" || terminalStatus === "cancelled")) {
        throw upstreamRunError(input.model, uniqueJoined([...streamErrorDetails, runErrorDetail(waited)]));
      }
      // wait() 本身 reject 且毫无产出时同样不能变成空 200（旧实现遗留问题）。
      if (!textParts.length && !toolCalls.length && waited === undefined && waitError) {
        const keyError = keySemanticApiError(input.model, waitError);
        if (keyError) throw keyError;
        throw upstreamRunError(input.model, uniqueJoined([...streamErrorDetails, errorMessage(waitError)]));
      }

      const result: CursorRunResult = {
        text: textParts.join("").trim(),
        toolCalls: [...toolCalls],
        ...(thinkingParts.length ? { reasoningText: thinkingParts.join("") } : {}),
        agentId: agent.agentId,
        runId: run.id
      };
      if (!this.input.disableSessionResume && agent.agentId) await this.store.saveSession(id, agent.agentId);
      yield { type: "done", result };
      finishedNormally = true;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // 消费方提前终止（客户端断连触发生成器 return()）时兜底取消 run，避免上游继续跑。
      // cancel/dispose 都带时长上限：清理挂死不能反过来堵住生成器的 return()/throw() 路径。
      if (!finishedNormally && activeRun) await withCleanupTimeout(activeRun.cancel?.().catch(() => undefined));
      await withCleanupTimeout(disposeAgent(agent));
    }
  }

  private async sendWithOptionalCustomTools(
    agent: AgentLike,
    input: CursorRunRequest,
    customTools: Record<string, unknown> | undefined,
    resolved: ResolvedModelRun,
    onDelta: (args: { update: unknown }) => void,
    signal: AbortSignal | undefined
  ): Promise<RunLike> {
    const options = () => ({
      model: resolved.model,
      idempotencyKey: randomUUID(),
      onDelta,
      ...(resolved.mode ? { mode: resolved.mode } : {})
    });
    const send = (opts: Record<string, unknown>) => raceSendRun(agent.send(this.sdkMessage(input), opts), signal);
    if (!customTools) return send(options());
    try {
      return await send({
        ...options(),
        local: { customTools }
      });
    } catch (error) {
      const keyError = keySemanticApiError(input.model, error);
      if (keyError) throw keyError;
      if (!isCustomToolsUnsupportedError(error)) throw error;
      return send(options());
    }
  }

  private async loadAgentFactory(): Promise<AgentFactory> {
    const { Agent } = await import("@cursor/sdk") as Record<string, unknown>;
    if (!Agent || typeof Agent !== "function" && typeof Agent !== "object") {
      throw new ApiError("@cursor/sdk Agent export is unavailable.", 500, "cursor_sdk_unavailable");
    }
    return Agent as AgentFactory;
  }

  private agentOptions(input: CursorRunRequest, resolved: ResolvedModelRun): Record<string, unknown> {
    return {
      apiKey: input.apiKey,
      model: resolved.model,
      name: "Docker Composer API",
      // settingSources: [] 显式关闭环境规则加载，绝不把调用方机器/项目/团队的 Cursor 规则
      //（~/.cursor、.cursor/rules、AGENTS.md 等）注入到请求里，避免夹带额外提示词。
      local: {
        cwd: input.workingDirectory || this.input.defaultWorkingDirectory,
        settingSources: [],
        ...(this.input.localAgentStore ? { store: this.input.localAgentStore } : {})
      },
      clientVersion: this.input.sdkClientVersion,
      // SDK >=1.0.27 的内置工具限制：无客户端工具 → []（纯文本，agent 不能动网关容器的文件/命令）；
      // 有客户端工具 → 只留 "mcp" 元工具通道（send 时注入的 customTools 经 custom-user-tools MCP server 暴露）。
      // 这从根上阻止 agent 在网关侧真实执行 shell/edit 后又把调用转发给客户端造成双重执行。
      ...(this.input.allowBuiltinTools ? {} : { tools: input.tools.length ? ["mcp"] : [] }),
      ...(resolved.mode ? { mode: resolved.mode } : {})
    };
  }

  private sdkMessage(input: CursorRunRequest): unknown {
    if (!input.images.length) return input.prompt;
    return {
      text: input.prompt,
      images: input.images.map((image) => image.source === "url"
        ? { url: image.data }
        : { data: image.data, mimeType: image.mediaType ?? "image/png" })
    };
  }
}

/** 相同 key 的日志 10 分钟内只打一次，避免高流量刷屏。 */
const dedupedLogAt = new Map<string, number>();
const DEDUPED_LOG_TTL_MS = 10 * 60 * 1000;

function logDeduped(key: string, message: string): void {
  const last = dedupedLogAt.get(key) ?? 0;
  const now = Date.now();
  if (now - last < DEDUPED_LOG_TTL_MS) return;
  // 模型/参数/工具名都可能被请求方制造高基数：先清过期项；仍超限则按插入顺序淘汰最旧，保证硬上限。
  if (dedupedLogAt.size >= 1000) {
    for (const [existingKey, at] of dedupedLogAt) {
      if (now - at >= DEDUPED_LOG_TTL_MS) dedupedLogAt.delete(existingKey);
    }
    while (dedupedLogAt.size >= 1000) {
      const oldest = dedupedLogAt.keys().next().value;
      if (oldest === undefined) break;
      dedupedLogAt.delete(oldest);
    }
  }
  dedupedLogAt.set(key, now);
  console.error(message);
}

/** 清理型调用（cancel/dispose）的最长等待：坏传输上挂死的清理不应堵住请求收尾。 */
const CLEANUP_TIMEOUT_MS = 5_000;

/** 给清理型 promise 加时长上限，超时/失败都按放弃处理（残留资源交给进程级回收兜底）。 */
function withCleanupTimeout(promise: Promise<unknown> | undefined, ms = CLEANUP_TIMEOUT_MS): Promise<void> {
  if (!promise) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}

/** agent 创建/恢复与 abort 竞速：abort 赢时，晚到的 agent 也必须释放（本地执行器持有句柄与缓存）。 */
async function raceCreateAgent(pending: Promise<AgentLike>, signal: AbortSignal | undefined): Promise<AgentLike> {
  try {
    return await raceWithAbort(pending, signal);
  } catch (error) {
    if (error instanceof ApiError && error.code === "request_aborted") {
      pending.then((agent) => void disposeAgent(agent)).catch(() => undefined);
    }
    throw error;
  }
}

/** send 与 abort 竞速：abort 赢时上游 run 可能已经启动，晚到后补一次 best-effort 取消。 */
async function raceSendRun(pending: Promise<RunLike>, signal: AbortSignal | undefined): Promise<RunLike> {
  try {
    return await raceWithAbort(pending, signal);
  } catch (error) {
    if (error instanceof ApiError && error.code === "request_aborted") {
      pending.then((run) => void run.cancel?.().catch(() => undefined)).catch(() => undefined);
    }
    throw error;
  }
}

function logDroppedIntent(model: string, dropped: string[], usedFallback: boolean): void {
  if (!dropped.length && !usedFallback) return;
  const detail = [
    dropped.length ? `dropped: ${dropped.join(", ")} (no matching model parameter)` : "",
    usedFallback ? "catalog parameter definitions unavailable; used built-in family fallback mapping" : ""
  ].filter(Boolean).join("; ");
  logDeduped(`dropped\0${model}\0${detail}`, `[model-params] model="${model}" ${detail}`);
}

/** onDelta 回调与 run.stream() 事件合流用的异步队列（单消费者）。 */
type QueueItem =
  | { kind: "delta"; update: unknown }
  | { kind: "event"; event: unknown }
  /** AbortSignal 触发：唤醒空队列等待，立即取消并抛 499。 */
  | { kind: "abort" }
  /** customTools execute 捕获到调用：唤醒消费循环即时处理（本身不带数据）。 */
  | { kind: "captured" }
  | { kind: "end"; error?: unknown };

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.resolvers.push(resolve));
  }
}

const MARKER_OPEN = "<tool_call>";
const MARKER_CLOSE = "</tool_call>";
/** 未闭合 marker 的最大暂扣字节数，超过按普通文本放行。 */
const MAX_MARKER_BUFFER = 64 * 1024;

/**
 * 流式 <tool_call> 标记过滤器：正文实时放行，只暂扣可能是 marker 前缀的尾部（最多 10 个字符）。
 * 每次 push 会解析 buffer 里**全部**完整 marker；解析失败的 marker 原文放行（不静默吞内容）。
 * 首个成功解析的 marker 之后的正文进入 held 暂存区——不能先于工具调用下发；
 * 若调用方把全部 marker 调用判为未声明而丢弃，可用 takeHeldText() 取回继续流式。
 */
class ToolMarkerFilter {
  private buffer = "";
  private held = "";
  private pendingToolCalls: GatewayToolCall[] = [];

  /** 送入新文本，返回可以安全下发的部分（首个已解析 marker 之前的正文）。 */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    const append = (text: string) => {
      if (!text) return;
      if (this.pendingToolCalls.length) this.held += text;
      else out += text;
    };
    for (;;) {
      const start = this.buffer.indexOf(MARKER_OPEN);
      if (start >= 0) {
        const end = this.buffer.indexOf(MARKER_CLOSE, start + MARKER_OPEN.length);
        if (end < 0) {
          // marker 已开但长时间不闭合：超过上限（按 UTF-16 code unit 计）当普通文本放行，避免无界缓冲。
          if (this.buffer.length - start > MAX_MARKER_BUFFER) {
            append(this.buffer);
            this.buffer = "";
            break;
          }
          // marker 已开但未闭合：放行 marker 前的正文，暂扣其余等待闭合。
          append(this.buffer.slice(0, start));
          this.buffer = this.buffer.slice(start);
          break;
        }
        append(this.buffer.slice(0, start));
        const raw = this.buffer.slice(start + MARKER_OPEN.length, end);
        this.buffer = this.buffer.slice(end + MARKER_CLOSE.length);
        const parsed = parseToolCallJson(raw);
        if (parsed) this.pendingToolCalls.push(parsed);
        else append(MARKER_OPEN + raw + MARKER_CLOSE);
        continue;
      }
      const hold = this.holdFrom();
      append(this.buffer.slice(0, hold));
      this.buffer = this.buffer.slice(hold);
      break;
    }
    return out;
  }

  /** 取走并清空已解析到的 marker 工具调用。 */
  takeToolCalls(): GatewayToolCall[] {
    const calls = this.pendingToolCalls;
    this.pendingToolCalls = [];
    return calls;
  }

  /** 取回 marker 之后暂存的正文（全部 marker 被判为未声明丢弃时恢复流式用）。 */
  takeHeldText(): string {
    const held = this.held;
    this.held = "";
    return held;
  }

  /** 流结束时取回暂存正文 + 暂扣尾部（未构成完整 marker 的部分）。 */
  flush(): string {
    const rest = this.held + this.buffer;
    this.held = "";
    this.buffer = "";
    return rest;
  }

  /** buffer 尾部可能是 MARKER_OPEN 前缀的最早位置。 */
  private holdFrom(): number {
    const max = Math.min(this.buffer.length, MARKER_OPEN.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (MARKER_OPEN.startsWith(this.buffer.slice(this.buffer.length - len))) return this.buffer.length - len;
    }
    return this.buffer.length;
  }
}

function sessionId(input: CursorRunRequest): string {
  return createHash("sha256")
    .update([input.apiKey, input.model, input.sessionKey, input.workingDirectory ?? ""].join("\0"))
    .digest("hex");
}

/** 从消息级 SDK 事件里提取思考文本（onDelta 不可用时的兜底通道）。 */
function thinkingFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const type = typeof record.type === "string" ? record.type : "";
  if (type !== "thinking" && type !== "thinkingMessage") return "";
  if (typeof record.text === "string") return record.text;
  const message = asRecord(record.message);
  return typeof message?.text === "string" ? message.text : "";
}

function textFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "status" || type === "thinking" || type === "thinkingMessage") return "";
  if (type === "assistant") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.flatMap((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("");
  }
  if (typeof record.text === "string") return record.text;
  if (typeof record.delta === "string") return record.delta;
  return "";
}

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : "";
  if (typeof record.result === "string") return record.result;
  if (typeof record.text === "string") return record.text;
  return "";
}

function runStatus(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.status === "string" ? record.status : "";
}

/** 从 SDK stream 的 status/result/error 事件中提取非正文错误详情，用于避免 terminal error 变成“no details”。 */
function errorDetailFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const parts: string[] = [];
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (type === "status" && ["error", "failed", "expired"].includes(status)) {
    pushString(parts, record.message);
    pushString(parts, record.status);
  }
  if (type === "result" && status === "error") {
    pushString(parts, record.errorCode);
    pushString(parts, record.message);
    pushErrorLike(parts, record.error);
  }
  if (type === "error") {
    pushString(parts, record.message);
    pushString(parts, record.code);
    pushString(parts, record.reason);
    pushErrorLike(parts, record.error);
  }
  pushErrorLike(parts, asRecord(record.message)?.error);
  return uniqueJoined(parts);
}

/** 尽量从 SDK run 结果里抽取错误详情（多数版本不提供，提供时用于精确归因与日志）。 */
function runErrorDetail(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const parts: string[] = [];
  for (const field of ["error", "message", "code", "reason", "detail", "details"]) {
    const raw = record[field];
    if (typeof raw === "string" && raw.trim()) {
      parts.push(raw.trim());
    } else {
      const nested = asRecord(raw);
      const message = nested && typeof nested.message === "string" ? nested.message : undefined;
      if (message?.trim()) parts.push(message.trim());
    }
  }
  return [...new Set(parts)].join("; ").slice(0, 300);
}

/**
 * 把 SDK「裸 error 收场」转成网关错误并选择合适的 code。
 * - 无详情（多数 SDK 版本如此）→ upstream_run_failed(502)，按 transient 处理：
 *   由 KeyRotatingRunner 换下一个 key 重试而不禁用，避免临时容量不足误伤好 key。
 * - 带出额度/认证类详情时 → 解耦为 insufficient_quota(402) / unauthorized(401)，
 *   让真正耗尽额度或失效的 key 能被 classifyKeyFailure 识别并禁用，而非被 transient 吞掉。
 * 注意：quota/auth 文案里不含 "upstream_run_failed" token，以免又被 transient 正则抢先命中。
 */
export function upstreamRunError(model: string, detail: string): ApiError {
  // 模型对该账号/区域不可用（如 "This model provider is not supported in your region"）：
  // 换 key 大概率无解（同团队/同出口区域），直接 403 透出真实原因而不是笼统的 502。
  // 注意只匹配明确的区域限制文案，避免把临时容量不足（"model not available" 类措辞）误判为永久限制。
  if (/not (supported|available) in your (region|country)|model provider is not supported/i.test(detail)) {
    return new ApiError(
      `Cursor upstream cannot run model "${model}": ${detail}. ` +
      "See https://cursor.com/docs/account/regions - this model provider is restricted for this account or egress region.",
      403,
      "model_unavailable"
    );
  }
  const kind = detail ? classifyErrorText(detail) : undefined;
  if (kind === "quota") {
    return new ApiError(
      `Cursor upstream run ended in error for model "${model}": ${detail}. ` +
      "This key appears to be out of quota/credit; the gateway rotates to the next pool key, and disables this one only after it keeps failing (auto-disable policy is configurable in /admin).",
      402,
      "insufficient_quota"
    );
  }
  if (kind === "auth") {
    return new ApiError(
      `Cursor upstream run ended in error for model "${model}": ${detail}. ` +
      "This key appears invalid or unauthorized; the gateway rotates to the next pool key, and disables this one only after it keeps failing (auto-disable policy is configurable in /admin).",
      401,
      "unauthorized"
    );
  }
  return new ApiError(
    `Cursor upstream run ended in error for model "${model}"` +
    (detail ? `: ${detail}` : " with no details provided by upstream") +
    ". Likely causes: quota/credit exhausted, a temporary Cursor capacity shortage (often self-recovers), " +
    "or a model not runnable via the API/SDK channel. The gateway will try the next pool key automatically; " +
    "if it persists, retry shortly or use composer-2.5 / composer-2.5-fast / auto.",
    502,
    "upstream_run_failed"
  );
}

/** SDK 在 Agent.create/send 阶段就拒绝了模型 id（"Cannot use this model: ..."）→ 400 而非笼统 500。 */
function modelUnavailableError(error: unknown): ApiError | undefined {
  const message = errorMessage(error);
  if (/cannot use this model/i.test(message)) {
    return new ApiError(message, 400, "model_not_found", "model");
  }
  return undefined;
}

function keySemanticApiError(model: string, error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  const message = errorMessage(error);
  const detail = message === "{}" ? "" : message;
  // 上游按 key 限速（如 get_models 每分钟 30 次）：对客户端必须是 429（可退避重试），不是笼统 500。
  if (isRateLimitError(error)) {
    return new ApiError(
      `Cursor upstream rate limited the request for model "${model}": ${detail || "rate limit exceeded"}. ` +
      "Retry after a short backoff; concurrent bursts on a single key hit Cursor's per-key rate limits.",
      429,
      "rate_limit_exceeded"
    );
  }
  const failure = classifyKeyFailure(error);
  if (failure === "quota") {
    return new ApiError(
      `Cursor upstream rejected the request for model "${model}": ${detail || "quota/credit exhausted"}. ` +
      "This key appears to be out of quota/credit; the gateway rotates to the next pool key, and disables this one only after it keeps failing (auto-disable policy is configurable in /admin).",
      402,
      "insufficient_quota"
    );
  }
  if (failure === "auth") {
    return new ApiError(
      `Cursor upstream rejected the request for model "${model}": ${detail || "invalid or unauthorized API key"}. ` +
      "This key appears invalid or unauthorized; the gateway rotates to the next pool key, and disables this one only after it keeps failing (auto-disable policy is configurable in /admin).",
      401,
      "unauthorized"
    );
  }
  return undefined;
}

function isRetryableStaleSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_run_failed";
}

function isActiveRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has active run|agent is busy|AgentBusyError/i.test(message);
}

export function toolCallsFromSdkEvent(event: unknown): GatewayToolCall[] {
  const record = asRecord(event);
  if (!record) return [];
  if (record.type === "assistant") return toolCallsFromAssistantMessage(record);
  const raw = record.type === "tool_call" ? record.toolCall ?? record.tool_call ?? record : undefined;
  const tool = asRecord(raw);
  if (!tool) return [];
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!name) return [];
  const status = stringValue(tool.status);
  if (status && status !== "completed") return [];
  const truncated = asRecord(tool.truncated);
  if (truncated?.args === true) return [];
  const args = objectArgs(tool.arguments) ?? objectArgs(tool.args) ?? objectArgs(tool.input);
  if (!args) return [];
  return [{
    id: stringValue(tool.id) ?? stringValue(tool.call_id) ?? stringValue(tool.callId) ?? `call_${randomUUID().replaceAll("-", "")}`,
    name,
    arguments: args
  }];
}

function toolCallsFromAssistantMessage(record: Record<string, unknown>): GatewayToolCall[] {
  const message = asRecord(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolCalls: GatewayToolCall[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (item?.type !== "tool_use") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    toolCalls.push({
      id: stringValue(item.id) ?? `call_${randomUUID().replaceAll("-", "")}`,
      name,
      arguments: objectArgs(item.input) ?? {}
    });
  }
  return toolCalls;
}

function isCustomToolsUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /custom local tools|local\.customTools|only supported for local sdk agents/i.test(message);
}

function pushToolCall(toolCalls: GatewayToolCall[], toolCall: GatewayToolCall): void {
  const existingIndex = toolCalls.findIndex((item) => item.id === toolCall.id);
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = toolCall;
    return;
  }
  toolCalls.push(toolCall);
}

function pendingCapturedToolCalls(captured: GatewayToolCall[], emitted: GatewayToolCall[]): GatewayToolCall[] {
  return captured.filter((toolCall) => !emitted.some((item) => item.id === toolCall.id));
}

function objectArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return objectArgs(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pushString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) parts.push(value.trim());
}

function pushErrorLike(parts: string[], value: unknown): void {
  if (typeof value === "string") {
    pushString(parts, value);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const field of ["message", "code", "reason", "detail", "details", "error"]) {
    const raw = record[field];
    if (typeof raw === "string") pushString(parts, raw);
    else if (field === "error") pushErrorLike(parts, raw);
  }
}

function uniqueJoined(parts: string[]): string {
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join("; ").slice(0, 300);
}

async function disposeAgent(agent: AgentLike): Promise<void> {
  const asyncDispose = agent[Symbol.asyncDispose];
  if (asyncDispose) {
    await asyncDispose.call(agent).catch(() => undefined);
    return;
  }
  try {
    agent.close?.();
  } catch {
    // best-effort cleanup only
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
