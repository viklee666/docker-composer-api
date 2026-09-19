import { randomUUID, createHash } from "node:crypto";
import { ApiError, raceWithAbort } from "./errors.js";
import { classifyErrorText, classifyKeyFailure, errorMessage, indicatesUpstreamAuthFailure, isRateLimitError, maskKey } from "./key-pool.js";
import { resolveModelParams, type ModelCatalog, type ModelIntent } from "./model-params.js";
import { isRitualAssistantText, normalizeRequestUsage, parseToolCallJson, parseToolMarkers, responseCallIds } from "./protocol.js";
import { durableAgentId, durableSessionId } from "./durable-id.js";
import { recordDurableDecision } from "./durable-telemetry.js";
import {
  EventPump,
  canonicalHoldId,
  createSessionSlot,
  durableSlotReplaceReason,
  inboundAssistantTextMismatch,
  inboundFreshSessionOnDeliveredSlot,
  markTurnDelivered,
  recordAssistantDigest,
  recordIssuedToolCalls,
  rememberCallAlias,
  responsesCallId,
  toolCallIdTokens,
  toolCallIdsOverlap,
  touchSlotHistory,
  type HubPumpItem,
  type SessionHub,
  type SessionSlot
} from "./session-hub.js";
import { createSdkCustomTools, isClientDelegateTool, matchesClientTool, normalizeToolCallForClient, normalizeToolCallsForClient } from "./tool-compat.js";
import type {
  AgentMode,
  CursorRunRequest,
  CursorRunResult,
  CursorRunner,
  CursorStreamEvent,
  ExecutorLeaseManager,
  GatewayImage,
  GatewayToolCall,
  ModelParameterValue,
  RequestUsage,
  RunTelemetryRef,
  StateStore
} from "./types.js";

/**
 * First-send durable instruction. Must stay a module constant: no dates, request ids, or tool name lists.
 * File-edit guardrail + “use already-registered tools”.
 */
export const STABLE_DIRECTIVE =
  "Do not edit, create, or delete files on this machine, and do not run shell commands here. When a task needs a tool, call one of the already-registered tools through the tool interface; do not claim a registered tool is unavailable.";

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
  private readonly durableRunOrdinals = new Map<string, number>();
  /**
   * 包 E 第 7 条：held execute 续跑的幂等键（session → 已驱动过 consume 的 execute id 集合）。
   * 同一 execute resolve 之后只允许驱动一次 consumeDurablePump，防止上游多收一个无输入轮次。
   */
  private readonly durableConsumedExecutes = new Map<string, Set<string>>();
  /**
   * 包 E 审阅修复（建议 4）：session → 当前 send 的 pump 引用盒。
   * durableCustomTools 的 captured 回调闭包捕获这个盒（不再动态读 hub.get(sessionId)?.pump），
   * durableSend 每次换泵时同步盒里的引用；槽被 drop+create 换掉后旧盒指向死泵，
   * 旧 agent 迟到的 tool 调用自然落空，推不进新槽的泵、也盖不上新印章。
   */
  private readonly durableCapturedPumps = new Map<string, { current?: EventPump }>();

  constructor(
    private readonly store: StateStore,
    private readonly input: {
      defaultWorkingDirectory: string;
      sdkClientVersion: string;
      /** 为 API 网关默认使用“每次请求 fresh agent”，避免远端 agent 会话长期累积/污染后所有请求持续 502。 */
      disableSessionResume?: boolean | (() => boolean);
      /** 允许 agent 在网关容器内使用内置工具（默认 false：SDK >=1.0.27 下用 tools 限制为纯文本/仅 MCP）。 */
      allowBuiltinTools?: boolean | (() => boolean);
      /**
       * 注入给每个 agent 的共享 LocalAgentStore。SDK 默认的 SqliteLocalAgentStore 按 agent 各开一份，
       * 每次请求泄漏约 7~8 个内核句柄且 dispose 不回收；stateless 模式下传入网关的有界内存 store 规避。
       */
      localAgentStore?: object;
      /** 用于按模型发现目录（Cursor.models.list() 的参数定义 + variants），把思考强度/Max Mode 等语义意图解析成合法 model.params。 */
      getModelCatalog?: (modelId: string, apiKey?: string) => Promise<ModelCatalog | undefined>;
      /**
       * SDK 共享本地执行器的预热租约管理。上游鉴权失败会被执行器的鉴权闭包永久缓存，
       * 必须释放租约让引用计数归零、SDK dispose 掉它，否则这把 key 之后的每个请求都会秒失败到进程重启。
       */
      executorLeases?: ExecutorLeaseManager;
      /**
       * WP4 durable Hub. When omitted, every request is true stateless
       * (create+full prompt+cancel+dispose). Never fall through to the old
       * getSession/resume+full-transcript path.
       */
      sessionHub?: SessionHub;
    },
    private readonly agentFactory?: AgentFactory
  ) {
    // 包 E 审阅修复（应修 2）：Hub 内部回收（idle/hold/LRU）不走 dropDurableSession，
    // 注册监听同步清 runner 侧按 session 记的边车 Map，防止随会话数无界增长。
    this.input.sessionHub?.onDrop((sessionId) => {
      this.durableRunOrdinals.delete(sessionId);
      this.durableConsumedExecutes.delete(sessionId);
      this.durableCapturedPumps.delete(sessionId);
    });
  }

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
    try {
      // kill switch 或本请求 forceStateless：每请求独立 fresh agent，没有共享会话状态需要保护；
      // 跳过互斥锁，否则同一网关 key + 模型的所有并发请求会被完全串行化。
      if (this.isStateless(input)) {
        yield* this.streamLocked(input, signal, id);
        return;
      }
      const hub = this.input.sessionHub;
      // Hub 键 = durableAgentId(ownerHash \0 identity \0 model)。apiKey/cwd 不进混料。
      // reuseDurableAgent === false：seed 只给 key 粘性，不进 Hub（见 server canReuseDurableAgent）。
      const durableId = hub && input.reuseDurableAgent !== false ? durableSessionId({
        apiKey: input.apiKey,
        model: input.model,
        workingDirectory: input.workingDirectory || this.input.defaultWorkingDirectory,
        stickyKey: input.stickyKey,
        conversationSeed: input.conversationSeed,
        ownerHash: input.ownerHash
      }) : undefined;
      if (hub && durableId) {
        yield* this.streamDurable(hub, durableId, input, signal);
        return;
      }
      // D4: Hub 在但认不出会话 → 真 stateless（与 kill switch 相同）。禁止用 ownerHash/sessionKey 走旧 resume。
      if (hub) {
        recordDurableDecision({
          decision: "fallback",
          reason: input.reuseDurableAgent === false ? "reuse_disabled" : "unidentifiable",
          kind: input.durableTurn?.kind,
          liveSessions: hub.size
        });
      }
      yield* this.streamLocked({ ...input, forceStateless: true }, signal, id);
    } catch (error) {
      await this.recycleExecutorOnAuthFailure(input, error);
      throw error;
    }
  }

  /**
   * 上游鉴权失败会被 SDK 共享执行器的鉴权闭包永久缓存（无 TTL、无重置路径），
   * 此后该执行器上的每个请求都立刻重抛同一个错误。释放预热租约让引用计数能归零，
   * SDK 才会 dispose 掉它，下一个请求拿到全新执行器与全新鉴权闭包。
   */
  private async recycleExecutorOnAuthFailure(input: CursorRunRequest, error: unknown): Promise<void> {
    const leases = this.input.executorLeases;
    if (!leases || !input.apiKey || !indicatesUpstreamAuthFailure(error)) return;
    const workingDirectory = input.workingDirectory || this.input.defaultWorkingDirectory;
    // 唯一能证明回收真的触发过的信号：不打日志的话，线上只能看到 502 消失，无从判断是修复生效还是故障没复现。
    console.error(
      `[executor] recycling shared Cursor executor after an upstream auth failure ` +
      `key=${maskKey(input.apiKey)} cwd=${workingDirectory} model="${input.model}": ${errorMessage(error).slice(0, 200)}`
    );
    await leases.recycle(input.apiKey, workingDirectory).catch(() => undefined);
  }

  private async *streamLocked(input: CursorRunRequest, signal: AbortSignal | undefined, id: string): AsyncIterable<CursorStreamEvent> {
    const factory = this.agentFactory ?? await this.loadAgentFactory();
    // 目录拉取 / agent 创建 / send 这些 SDK 调用可能既不 settle 也不感知 signal（上游传输挂死）。
    // 全部与 abort 竞速：空闲超时或客户端断连时请求一定能收尾，而不是永久悬挂、随流量持续堆积句柄与内存。
    const resolved = await raceWithAbort(this.resolveModelRun(input), signal);
    recordRunTelemetry(input, resolved);
    const existingAgentId = this.isStateless(input) ? undefined : await this.store.getSession(id);
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

  /**
   * Durable sibling of streamLocked. Kill switch / no Hub / unidentifiable session never enter here.
   * Path A (WP0 pass): held execute, same Run, no cancel/wait/dispose on tool HTTP.
   * Path B (D18 marker + no pending execute): cancel that Run, keep agent, next tool_result is a short send.
   */
  private async *streamDurable(
    hub: SessionHub,
    durableId: string,
    input: CursorRunRequest,
    signal: AbortSignal | undefined
  ): AsyncIterable<CursorStreamEvent> {
    const slot = hub.get(durableId);
    const handshakeEmitted = slot != null && (slot.state === "idle" || slot.state === "awaiting_tools" || slot.pending.size > 0);
    const mayWait = input.durableTurn?.kind === "tool_results" && handshakeEmitted;
    const release = mayWait
      ? await hub.acquire(durableId, signal)
      : await hub.tryAcquire(durableId);
    if (!release) {
      recordDurableDecision({
        decision: "fallback",
        reason: "locked",
        session: durableId.slice(0, 12),
        kind: input.durableTurn?.kind,
        liveSessions: hub.size
      });
      yield* this.streamLocked({ ...input, forceStateless: true }, signal, sessionId(input));
      return;
    }
    try {
      yield* this.runDurableLocked(hub, durableId, input, signal);
    } finally {
      try {
        await this.settleDurableSlotState(hub, durableId);
      } finally {
        release();
      }
    }
  }

  /**
   * 请求收尾时把槽状态落定：还挂着 execute ⇒ awaiting_tools（等下一条 HTTP 送结果）；
   * 仍是 running（既没挂起也没收尾，说明本轮异常中断）⇒ 丢弃，别把半死的 agent 留给下一轮。
   * 基础槽与分叉槽共用这一套（两者都必须在自己的锁内收尾）。
   */
  private async settleDurableSlotState(hub: SessionHub, sessionId: string): Promise<void> {
    const slot = hub.get(sessionId);
    if (slot?.state === "running" && slot.pending.size > 0) {
      hub.beginAwaitingTools(sessionId);
    } else if (slot?.state === "running") {
      await this.dropDurableSession(hub, sessionId).catch(() => undefined);
    }
  }

  private async *runDurableLocked(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    allowFork = true
  ): AsyncIterable<CursorStreamEvent> {
    const resolved = await raceWithAbort(this.resolveModelRun(input), signal);
    recordRunTelemetry(input, resolved);

    const turn = input.durableTurn;

    if (turn?.kind === "empty") {
      // 空轮次（占位符 / 无有效意图）静默收尾：不 400（客户端会重试打得更吵）、不退 stateless
      // （aff0a15 已实测：拦了 durable send、stateless 全量照样让模型编一句「没看到问题」）。
      // 不 ensureDurableSlot、不 touchSlotHistory：空轮不该建槽，也不该把 lastUserText 覆盖成占位符。
      yield* this.noopEmptyTurn(hub, sessionId, input, "empty_turn_noop");
      return;
    }

    // 包 E 第 1 条：new_user（或缺 durableTurn 的直连调用）且没有 userText / images 时绝不 send。
    // 与 extract 收口对齐后应几乎走不到，留作兜底——同样静默 noop，禁止再退 stateless 全量重跑。
    if ((turn?.kind ?? "new_user") === "new_user" && !turn?.userText && !turn?.images?.length) {
      yield* this.noopEmptyTurn(hub, sessionId, input, "empty_turn_guard");
      return;
    }

    let slot = await this.ensureDurableSlot(hub, sessionId, input, resolved, signal, turn);
    if (!slot) {
      // 碰撞分叉：fresh_session 护栏拦下（基础槽已被同 seed 的另一个会话交付过输出）、
      // 且入站历史带 lineage 标记（有工具轮的续聊）时，不再退 stateless——派生分叉槽，
      // 首程全量落地、后续恢复增量，否则输家会话永远回不了 durable（快照实锤 25 轮循环）。
      const baseSlot = hub.get(sessionId);
      if (
        allowFork
        && turn?.lineageToolId
        && turn.kind === "new_user"
        && input.identitySource === "derived-L3"
        && input.protocol !== "openai-responses"
        && baseSlot
        && inboundFreshSessionOnDeliveredSlot(baseSlot, turn.assistantDigest)
      ) {
        yield* this.runForkedDurable(hub, input, signal, turn, resolved);
        return;
      }
      // 包 E 第 3 条：入站历史与 slot 记录的上一轮输出对不上（历史分叉）。
      // 只牺牲本轮缓存退 stateless，绝不销毁槽、不关 reuse。
      recordDurableDecision({
        decision: "fallback",
        reason: "history_mismatch",
        session: sessionId.slice(0, 12),
        kind: turn?.kind,
        liveSessions: hub.size
      });
      try {
        input.debugRef?.noteUpstreamTurn("sdk", {
          kind: turn?.kind ?? "new_user",
          blocked: "history_mismatch",
          remark: "inbound last assistant text does not match the slot's last delivered turn"
        });
      } catch {
        // 观测路径不得影响主流程。
      }
      yield* this.streamStatelessFallback(input, signal);
      return;
    }
    // ensureDurableSlot 从这里往后必有槽（上面的 undefined 分支已 return）；
    // let 供 sendRecoverable 的 drop+create 恢复路径重新赋值。
    let liveSlot: SessionSlot = slot;

    // 包 E 第 5 条：new_user 重复（客户端重试同一轮）不再 400。
    if (
      turn?.kind === "new_user"
      && liveSlot.lastUserText !== undefined
      && turn.userText === liveSlot.lastUserText
      && !turn.images?.length
    ) {
      yield* this.retryDurableTurn(hub, sessionId, liveSlot, input, signal, turn);
      return;
    }

    const sendRecoverable = async (
      spec: { kind: "new_user" | "tool_results"; message: unknown; firstSend: boolean }
    ): Promise<void> => {
      try {
        await this.durableSend(hub, liveSlot, sessionId, input, resolved, signal, spec);
      } catch (error) {
        if (isActiveRunError(error) || isRetryableStaleSessionError(error)) {
          const reason = isActiveRunError(error) ? "busy" : "stale";
          console.error(`[durable] drop+create ${reason} session=${sessionId.slice(0, 12)}`);
          recordDurableDecision({
            decision: "recreate",
            reason,
            session: sessionId.slice(0, 12),
            kind: spec.kind,
            liveSessions: hub.size
          });
          await this.dropDurableSession(hub, sessionId);
          liveSlot = await this.createDurableSlot(hub, sessionId, input, resolved, signal, turn);
          const recovered = spec.kind === "new_user"
            ? {
              kind: "new_user" as const,
              firstSend: true,
              message: sdkTextMessage(formatDurableUserMessage({
                firstSend: true,
                userText: turn?.userText ?? "",
                systemText: turn?.systemText
              }), turn?.images)
            }
            : spec;
          await this.durableSend(hub, liveSlot, sessionId, input, resolved, signal, recovered);
          return;
        }
        const keyError = keySemanticApiError(input.model, error);
        if (keyError) throw keyError;
        throw error;
      }
    };

    if (turn?.kind === "tool_results") {
      // tool_results 零交集护栏（只对 derived-L3 内容推导身份生效）：全部结果 id 与本槽
      // 发过的 tool_call（含 pending execute）零交集 = 另一个会话的工具结果撞进了同一个
      // Hub 键。必须先于 resolvePending / abortHung 检查：外来结果既不该 resolve 任何东西，
      // 更不能 abort 本槽挂起的 execute（那可能是对方会话正在等待的工具轮）。
      // 显式 id 的会话不会碰撞；同一会话内客户端发错 id 属于客户端 bug，走既有
      // unmatched-abort 路径处理（下同），本护栏不掺和。
      if (
        input.identitySource === "derived-L3"
        && toolResultsForeignToSlot(liveSlot, turn.toolResults ?? [])
      ) {
        // 碰撞分叉：外来工具结果 + lineage 标记 → 派生分叉槽（首程全量落地）。
        // 没 lineage（纯文本首轮撞车、或历史被压缩掉了调用侧 id）才退 stateless。
        if (allowFork && turn.lineageToolId) {
          yield* this.runForkedDurable(hub, input, signal, turn, resolved);
          return;
        }
        console.error(`[durable] foreign tool_results; stateless fallback session=${sessionId.slice(0, 12)}`);
        recordDurableDecision({
          decision: "fallback",
          reason: "foreign_tool_results",
          session: sessionId.slice(0, 12),
          kind: turn.kind,
          liveSessions: hub.size
        });
        try {
          input.debugRef?.noteUpstreamTurn("sdk", {
            kind: turn.kind,
            blocked: "foreign_tool_results",
            remark: "none of the inbound tool result ids match tool calls issued by this slot's agent"
          });
        } catch {
          // 观测路径不得影响主流程。
        }
        yield* this.streamStatelessFallback(input, signal);
        return;
      }
      let resolvedAny = false;
      const consumedExecutes = this.durableConsumedExecutes.get(sessionId) ?? new Set<string>();
      const newlyResolved: string[] = [];
      for (const result of turn.toolResults ?? []) {
        const sdkResult = {
          content: [{ type: "text", text: result.content }],
          ...(result.isError ? { isError: true } : {})
        };
        if (hub.resolvePending(sessionId, result.id, sdkResult)) {
          resolvedAny = true;
          // 包 E 第 7 条：只统计本 HTTP 真正新 resolve 的 execute；已驱动过 consume 的不算。
          if (!consumedExecutes.has(result.id)) newlyResolved.push(result.id);
          console.error(`[durable] resolve execute id=${result.id}`);
        }
      }
      if (resolvedAny) {
        if ((hub.get(sessionId)?.pending.size ?? 0) === 0) {
          // Path A HTTP2: same Run continues; leave awaiting_tools only while execute is still held.
          hub.markRunning(sessionId);
        }
        liveSlot = hub.get(sessionId) ?? liveSlot;
        if (newlyResolved.length) {
          // 包 E 第 7 条：同一 execute 只允许驱动一次 consumeDurablePump（幂等键：session + execute id）。
          // durableSend 换新 run 时集合清空——新 run 的 execute 是全新的键。
          const known = this.durableConsumedExecutes.get(sessionId) ?? new Set<string>();
          for (const id of newlyResolved) known.add(id);
          this.durableConsumedExecutes.set(sessionId, known);
          yield* this.consumeDurablePump(hub, sessionId, liveSlot, input, signal);
        } else {
          // 全部 execute 都已驱动过 consume：重放的 tool_results，绝不再 send 一次（避免上游多收一轮）。
          recordDurableDecision({
            decision: "fallback",
            reason: "duplicate_tool_results",
            session: sessionId.slice(0, 12),
            kind: turn.kind,
            liveSessions: hub.size
          });
          yield* this.streamStatelessFallback(input, signal);
        }
        return;
      }
      const replayedResults = (turn.toolResults ?? []).filter((result) => consumedExecutes.has(result.id));
      if (!turn.toolResults?.length || replayedResults.length === turn.toolResults.length) {
        // 包 E 第 7 条：resolvePending 全部落空且都是已消费过的 execute——上一条 HTTP 的重放，
        // 不能再走 path B send（上游会多收一个无输入轮次，§1.2 未解释缺口的候选之一）。
        recordDurableDecision({
          decision: "fallback",
          reason: "duplicate_tool_results",
          session: sessionId.slice(0, 12),
          kind: turn.kind,
          liveSessions: hub.size
        });
        yield* this.streamStatelessFallback(input, signal);
        return;
      }
      // Nothing resolved. If execute is still hung, path B send would hit "active run" and drop+create.
      if (liveSlot.pending.size > 0) {
        console.error(`[durable] unmatched tool_results; abort hung execute session=${sessionId.slice(0, 12)}`);
        await this.abortHungDurableRun(hub, sessionId, liveSlot, "unmatched tool_result");
      }
      const text = formatPathBToolResults(turn.toolResults ?? []);
      await sendRecoverable({ kind: "tool_results", message: text, firstSend: false });
      liveSlot = hub.get(sessionId) ?? liveSlot;
      yield* this.consumeDurablePump(hub, sessionId, liveSlot, input, signal);
      return;
    }

    if (liveSlot.state === "awaiting_tools") {
      console.error(`[durable] user cancelled pending tools session=${sessionId.slice(0, 12)}`);
      await this.abortHungDurableRun(hub, sessionId, liveSlot, "user cancelled tools");
    }

    const firstSend = liveSlot.lastUserText === undefined && !slot.resumed;
    const userText = turn?.userText ?? "";
    const text = formatDurableUserMessage({
      firstSend,
      userText,
      systemText: turn?.systemText
    });
    await sendRecoverable({
      kind: "new_user",
      message: sdkTextMessage(text, turn?.images),
      firstSend
    });
    liveSlot = hub.get(sessionId) ?? liveSlot;
    touchSlotHistory(liveSlot, userText);
    yield* this.consumeDurablePump(hub, sessionId, liveSlot, input, signal);
  }

  /**
   * 空轮次（kind=empty / 空 new_user 兜底）的静默收尾：不打上游、不建槽、不碰 slot 历史。
   *
   * digest 风险（有意先不改，线上跑一轮再验证）：返回 200 空 assistant 后，若客户端把空回复
   * 写进 transcript，下一轮的 assistantDigest 对不上槽里上一轮真回复会触发 history_mismatch →
   * 粘性 stateless。验收发现真被粘住时，再在 noop 路径把 lastAssistantDigest 更新成空串摘要并补
   * 护栏测试；不预先改，以免客户端其实不落空 assistant 时误伤。
   */
  private async *noopEmptyTurn(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest,
    reason: "empty_turn_noop" | "empty_turn_guard"
  ): AsyncIterable<CursorStreamEvent> {
    const slot = hub.get(sessionId);
    recordDurableDecision({
      decision: "reuse",
      reason,
      ...(slot ? { session: sessionId.slice(0, 12) } : {}),
      kind: input.durableTurn?.kind,
      ...(slot ? { liveSessions: hub.size } : {})
    });
    try {
      input.debugRef?.noteUpstreamTurn("sdk", {
        kind: "empty",
        blocked: reason,
        remark: "blocked: no sendable user intent, no upstream send"
      });
    } catch {
      // 观测路径不得影响主流程。
    }
    yield { type: "done", result: { text: "", toolCalls: [] } };
  }

  /**
   * 包 E 第 5/6 条：new_user 重复（客户端重试同一轮）不再 400。
   * - 已交付（done/tool_call 已发给客户端）⇒ 上游已有这轮，不能重发增量，退 stateless 全量重跑；
   * - 已发送未交付且还有可续播的输出（park 住的 Run/pump 残留或挂起 execute）⇒ 继续消费；
   * - 拿不到可续播输出 ⇒ 退 stateless，绝不报错。
   */
  private async *retryDurableTurn(
    hub: SessionHub,
    sessionId: string,
    slot: SessionSlot,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    turn: NonNullable<CursorRunRequest["durableTurn"]>
  ): AsyncIterable<CursorStreamEvent> {
    const delivered = slot.deliveredUserText !== undefined && slot.deliveredUserText === slot.lastUserText;
    if (!delivered && (slot.pending.size > 0 || slot.pump.hasQueued())) {
      // 已发送未交付：优先续播 park 住的 Run（挂起 execute 或未排空的 pump）。
      recordDurableDecision({
        decision: "reuse",
        reason: "retry_after_send",
        session: sessionId.slice(0, 12),
        kind: turn.kind,
        liveSessions: hub.size
      });
      yield* this.consumeDurablePump(hub, sessionId, slot, input, signal);
      return;
    }
    // 已交付（或没有任何可续播输出）：上游已收到这一轮，增量重发会造成轮次错位，退 stateless 全量重跑。
    recordDurableDecision({
      decision: "fallback",
      reason: "retry_after_deliver",
      session: sessionId.slice(0, 12),
      kind: turn.kind,
      liveSessions: hub.size
    });
    yield* this.streamStatelessFallback(input, signal);
  }

  private async ensureDurableSlot(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest,
    resolved: ResolvedModelRun,
    signal: AbortSignal | undefined,
    turn: CursorRunRequest["durableTurn"]
  ): Promise<SessionSlot | undefined> {
    let slot = hub.get(sessionId);
    // 包 E 第 3 条：入站上一条 assistant 文本与 slot 记录的上一轮输出摘要对不上 = 历史分叉。
    // 先于指纹/历史规则检查：分叉只退 stateless（调用方处理），绝不能落到 drop+create。
    // tool_results 例外：工具结果轮次里 transcript 的上一条 assistant 是工具调用轮，
    // 文本口径不可比（且该分支另有 pending/alias 护栏）。
    if (
      slot
      && turn?.kind !== "tool_results"
      && inboundAssistantTextMismatch(slot, turn?.assistantDigest)
    ) {
      console.error(`[durable] history mismatch; stateless fallback session=${sessionId.slice(0, 12)}`);
      return undefined;
    }
    // 新鲜会话护栏（只对 derived-L3 内容推导身份生效）：入站 transcript 零 assistant 轮
    // （digest 缺号）而槽已交付过输出——derived-L3 没有会话边界，同仓库并发的新会话会撞进
    // 同一个槽；正常续聊总会带着之前的 assistant 回复，零 assistant 只可能是会话 B 的第一轮。
    // 显式 id（header / body-field）的会话不可能碰撞，不进本护栏：只发增量的合法有状态客户端
    // （协议不回传 assistant 轮）会被误伤。Responses 协议豁免：其历史走 previous_response_id、
    // input 恒缺 assistant 文本（digest 天然缺号），且续聊身份靠落库 seed 继承、也会被归到
    // derived-L3 档，不豁免会把每轮 Responses 续聊都打回 stateless。
    if (
      slot
      && turn?.kind === "new_user"
      && input.identitySource === "derived-L3"
      && input.protocol !== "openai-responses"
      && inboundFreshSessionOnDeliveredSlot(slot, turn?.assistantDigest)
    ) {
      console.error(`[durable] fresh session on delivered slot; stateless fallback session=${sessionId.slice(0, 12)}`);
      recordDurableDecision({
        decision: "fallback",
        reason: "fresh_session",
        session: sessionId.slice(0, 12),
        kind: turn?.kind,
        liveSessions: hub.size
      });
      try {
        input.debugRef?.noteUpstreamTurn("sdk", {
          kind: turn.kind,
          blocked: "fresh_session",
          remark: "inbound transcript has no assistant turn while the slot already delivered output to another client"
        });
      } catch {
        // 观测路径不得影响主流程。
      }
      return undefined;
    }
    const replaceReason = durableSlotReplaceReason(slot, {
      kind: turn?.kind,
      apiKey: input.apiKey,
      model: input.model,
      systemFingerprint: turn?.systemFingerprint,
      toolsFingerprint: turn?.toolsFingerprint,
      toolResults: turn?.toolResults,
      prompt: input.prompt,
      assistantDigest: turn?.assistantDigest
    });
    if (slot && replaceReason) {
      console.error(`[durable] drop+create ${replaceReason} session=${sessionId.slice(0, 12)}`);
      recordDurableDecision({
        decision: "recreate",
        reason: replaceReason,
        session: sessionId.slice(0, 12),
        kind: turn?.kind,
        liveSessions: hub.size
      });
      await this.dropDurableSession(hub, sessionId);
      slot = undefined;
    }
    if (slot) {
      slot.apiKey = input.apiKey;
      recordDurableDecision({
        decision: "reuse",
        session: sessionId.slice(0, 12),
        kind: turn?.kind,
        liveSessions: hub.size
      });
      return slot;
    }

    // 包 E 第 3 条：历史分叉时 ensureDurableSlot 返回 undefined（上面 early return），
    // 走不到这里。下面的 resume/create 只服务「指纹兼容且历史对得上」的请求。
    if (!replaceReason) {
      const existingAgentId = await this.store.getSession(sessionId);
      const resumed = await this.tryResumeDurableSlot(
        hub,
        sessionId,
        input,
        resolved,
        signal,
        turn,
        existingAgentId ?? sessionId
      );
      if (resumed) return resumed;
    }

    // Restart leftover: no live handle, tool_results, nowhere to resume → do not poison a new agent.
    if (turn?.kind === "tool_results" && !replaceReason) {
      throw new ApiError("No durable session is awaiting tool results.", 400, "invalid_request_error");
    }

    return this.createDurableSlot(hub, sessionId, input, resolved, signal, turn);
  }

  /**
   * 碰撞分叉（collision fork）：内容推导身份撞进同一个 Hub 键时，输家会话的每一轮都是
   * foreign/fresh_session，退 stateless 会陷入「每轮全量重放、模型反复重做任务」的循环
   * （快照 0e4e94c2：输家子代理连打 25 轮工具）。这里用入站 transcript 里最早的工具调用
   * id（lineageToolId，同会话跨轮稳定、跨会话随机不同）派生一个分叉会话键：
   * - 分叉槽不存在 ⇒ create + 首程发完整 flatten（stateless 的口径，但 agent 保留）；
   * - 分叉槽已存在 ⇒ 作为普通 durable 会话续跑（增量 + path A/B，禁再分叉防同 marker 递归）。
   * 槽主（赢家会话）不受影响：它从不触发护栏，永远走基础槽。
   */
  private async *runForkedDurable(
    hub: SessionHub,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    turn: NonNullable<CursorRunRequest["durableTurn"]>,
    resolved: ResolvedModelRun
  ): AsyncIterable<CursorStreamEvent> {
    const lineage = turn.lineageToolId;
    if (!lineage) {
      // 调用点已保证 lineage 存在；这里只做防御：拿不到标记就无法派生稳定分叉键，退 stateless。
      yield* this.streamStatelessFallback(input, signal);
      return;
    }
    const baseIdentity = input.conversationSeed ?? input.stickyKey ?? input.sessionKey;
    // 分隔符是真正的 NUL（ ），与 durableIdentity 的 ` agent:` 同口径——普通空格会与提示词内容混淆。
    const forkIdentity = `${baseIdentity} fork:${lineage}`;
    const forkSessionId = durableAgentId({ ownerHash: input.ownerHash ?? "", identity: forkIdentity, model: input.model });
    // 分叉槽有自己的键，基础键的锁保护不到它：必须单独取锁，否则同一输家会话的并发/重叠
    // 请求会同时操作同一个分叉槽（破坏 Hub 互斥），且没有任何路径为它做状态收尾。
    const forkRelease = turn.kind === "tool_results"
      ? await hub.acquire(forkSessionId, signal)
      : await hub.tryAcquire(forkSessionId);
    if (!forkRelease) {
      recordDurableDecision({
        decision: "fallback",
        reason: "fork_locked",
        session: forkSessionId.slice(0, 12),
        kind: turn.kind,
        liveSessions: hub.size
      });
      yield* this.streamStatelessFallback(input, signal);
      return;
    }
    try {
      yield* this.runForkedDurableLocked(hub, forkSessionId, lineage, input, signal, turn, resolved);
    } finally {
      try {
        await this.settleDurableSlotState(hub, forkSessionId);
      } finally {
        forkRelease();
      }
    }
  }

  /** 分叉槽已持锁后的主体：命中已有分叉槽 ⇒ 普通 durable 续跑；否则 create + 全量首程。 */
  private async *runForkedDurableLocked(
    hub: SessionHub,
    forkSessionId: string,
    lineage: string,
    input: CursorRunRequest,
    signal: AbortSignal | undefined,
    turn: NonNullable<CursorRunRequest["durableTurn"]>,
    resolved: ResolvedModelRun
  ): AsyncIterable<CursorStreamEvent> {
    const existing = hub.get(forkSessionId);
    if (existing) {
      recordDurableDecision({
        decision: "reuse",
        reason: "collision_fork",
        session: forkSessionId.slice(0, 12),
        kind: turn.kind,
        liveSessions: hub.size
      });
      yield* this.runDurableLocked(hub, forkSessionId, input, signal, false);
      return;
    }
    console.error(
      `[durable] collision fork session=${forkSessionId.slice(0, 12)} lineage=${lineage.slice(0, 14)} kind=${turn.kind}`
    );
    recordDurableDecision({
      decision: "create",
      reason: "collision_fork",
      session: forkSessionId.slice(0, 12),
      kind: turn.kind,
      liveSessions: hub.size
    });
    try {
      input.debugRef?.noteUpstreamTurn("sdk", {
        kind: turn.kind,
        blocked: "collision_fork",
        remark: "derived-L3 collision: forking a dedicated durable session for the locked-out conversation"
      });
    } catch {
      // 观测路径不得影响主流程。
    }
    const slot = await this.createDurableSlot(hub, forkSessionId, input, resolved, signal, turn);
    // 分叉首程：完整 flatten 落到新 agent（与 stateless 同口径），让模型带着全部上下文续跑；
    // agent 保留在分叉槽里，后续轮次按 lineage 命中同一键，恢复增量。
    await this.durableSend(hub, slot, forkSessionId, input, resolved, signal, {
      // 调用点只在 new_user / tool_results 两个护栏分支进来；其余 kind 到不了这里。
      kind: turn.kind === "tool_results" ? "tool_results" : "new_user",
      message: input.prompt,
      firstSend: true
    });
    const liveSlot = hub.get(forkSessionId) ?? slot;
    yield* this.consumeDurablePump(hub, forkSessionId, liveSlot, input, signal);
  }

  /**
   * 包 E：护栏共用的退回路径——本轮 forceStateless 全量重跑（streamLocked 已有同款路径，
   * 见 streamDurable 的 locked 分支）。只牺牲本轮缓存命中，不销毁 slot、不动 park/reuse。
   *
   * 口径决策（有意为之，不要“修”）：fallback 之后本会话粘性 stateless。slot.lastAssistantDigest
   * 停在 fallback 前的旧轮，后续每轮入站 transcript（反映的是 stateless 全量轮的输出）都与它对不上，
   * 于是继续退 stateless——这是正确的：stateless 轮走的是全新 agent，上游 durable agent 的历史
   * 已经分叉，恢复增量只会错位。槽被 TTL/LRU 回收（Hub drop 会连带清 store 映射）后基线自然重置。
   */
  private async *streamStatelessFallback(
    input: CursorRunRequest,
    signal: AbortSignal | undefined
  ): AsyncIterable<CursorStreamEvent> {
    yield* this.streamLocked({ ...input, forceStateless: true }, signal, sessionId(input));
  }

  private async tryResumeDurableSlot(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest,
    resolved: ResolvedModelRun,
    signal: AbortSignal | undefined,
    turn: CursorRunRequest["durableTurn"],
    agentId: string
  ): Promise<SessionSlot | undefined> {
    const factory = this.agentFactory ?? await this.loadAgentFactory();
    if (typeof factory.resume !== "function") {
      await this.store.deleteSession(sessionId).catch(() => undefined);
      return undefined;
    }
    const customTools = this.durableCustomTools(hub, sessionId, input);
    try {
      const agent = await raceCreateAgent(
        factory.resume(agentId, this.agentOptions(input, resolved, customTools.tools, sessionId)),
        signal
      );
      // Restart cannot restore in-memory pending executes. Resume is always idle.
      const slot = createSessionSlot({
        agent,
        agentId: agent.agentId ?? agentId,
        apiKey: input.apiKey,
        model: input.model,
        toolsFingerprint: turn?.toolsFingerprint ?? "",
        systemFingerprint: turn?.systemFingerprint ?? "",
        state: "idle",
        resumed: true,
        // 包 E 审阅修复（应修 1）：resumed 槽没有内存里的上一轮输出可记，用入站 transcript 的
        // 上一条 assistant 摘要播种基线，恢复后的下一轮即可与 live 槽共用同一套分叉比对口径。
        // （agent-store 只落 SDK 的 agent 文档，不存 slot 字段；digest 的恢复链路只有这条。）
        // deliveredUserText 不播种：resume 轮 lastUserText 缺号，重试判定的「已交付」分支天然走不到。
        lastAssistantDigest: turn?.assistantDigest
      });
      try {
        hub.put(sessionId, slot);
      } catch (error) {
        await withCleanupTimeout(Promise.resolve(slot.agent.close?.())).catch(() => undefined);
        throw error;
      }
      this.durableCapturedPumps.set(sessionId, customTools.pumpRef);
      if (slot.agentId && slot.agentId !== agentId) {
        await this.store.saveSession(sessionId, slot.agentId);
      }
      recordDurableDecision({
        decision: "resume",
        session: sessionId.slice(0, 12),
        kind: turn?.kind,
        liveSessions: hub.size
      });
      console.error(
        `[durable] resume agentId=${slot.agentId} customTools=${customTools.tools ? "yes" : "no"} session=${sessionId.slice(0, 12)}`
      );
      return slot;
    } catch (error) {
      const keyError = keySemanticApiError(input.model, error);
      if (keyError) throw keyError;
      console.error(
        `[durable] resume failed, dropping mapping session=${sessionId.slice(0, 12)}: ${errorMessage(error).slice(0, 200)}`
      );
      await this.store.deleteSession(sessionId).catch(() => undefined);
      return undefined;
    }
  }

  private async createDurableSlot(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest,
    resolved: ResolvedModelRun,
    signal: AbortSignal | undefined,
    turn: CursorRunRequest["durableTurn"]
  ): Promise<SessionSlot> {
    const factory = this.agentFactory ?? await this.loadAgentFactory();
    const customTools = this.durableCustomTools(hub, sessionId, input);
    const options = this.agentOptions(input, resolved, customTools.tools, sessionId);
    let agent: AgentLike;
    try {
      agent = await raceCreateAgent(factory.create(options), signal);
    } catch (error) {
      const keyError = keySemanticApiError(input.model, error);
      if (keyError) throw keyError;
      const unavailable = modelUnavailableError(error);
      if (unavailable) throw unavailable;
      if (isAgentAlreadyExistsError(error)) {
        const resumed = await this.tryResumeDurableSlot(
          hub,
          sessionId,
          input,
          resolved,
          signal,
          turn,
          sessionId
        );
        if (resumed) return resumed;
      }
      throw error;
    }
    const slot = createSessionSlot({
      agent,
      agentId: agent.agentId || sessionId,
      apiKey: input.apiKey,
      model: input.model,
      toolsFingerprint: turn?.toolsFingerprint ?? "",
      systemFingerprint: turn?.systemFingerprint ?? "",
      state: "running"
    });
    try {
      hub.put(sessionId, slot);
    } catch (error) {
      await withCleanupTimeout(Promise.resolve(slot.agent.close?.())).catch(() => undefined);
      throw error;
    }
    this.durableCapturedPumps.set(sessionId, customTools.pumpRef);
    await this.store.saveSession(sessionId, slot.agentId);
    recordDurableDecision({
      decision: "create",
      session: sessionId.slice(0, 12),
      kind: turn?.kind,
      liveSessions: hub.size
    });
    console.error(
      `[durable] create agentId=${slot.agentId} customTools=${customTools.tools ? "yes" : "no"} session=${sessionId.slice(0, 12)}`
    );
    return slot;
  }

  /**
   * create/resume register customTools; later send omits them (whole-table replace).
   *
   * 包 E 审阅修复（建议 4）：captured 推送不再动态读 `hub.get(sessionId)?.pump`——泵被换/槽被
   * drop+create 换掉后，旧 run 迟到的 tool 调用会推进新泵并盖上新印章。改为闭包捕获本地 pump
   * 引用盒（与 durableSend 里 onDelta/stream 闭包捕获本次 send 的 pump 同构）：durableSend 每次
   * 换泵时同步盒里的引用；新槽创建时换新盒，旧 agent 的回调握着旧盒、推不进新槽的泵。
   */
  private durableCustomTools(
    hub: SessionHub,
    sessionId: string,
    input: CursorRunRequest
  ): { tools: ReturnType<typeof createSdkCustomTools>; pumpRef: { current?: EventPump } } {
    const toolNames = new Map<string, string>();
    const pumpRef: { current?: EventPump } = {};
    const tools = createSdkCustomTools(input.tools, (toolCall) => {
      toolNames.set(toolCall.id, toolCall.name);
      pumpRef.current?.push({
        kind: "captured",
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.arguments
      });
    }, {
      hold: true,
      onHold: (toolCallId, resolve, reject) => {
        const name = toolNames.get(toolCallId) ?? "tool";
        hub.registerHold(sessionId, toolCallId, name, resolve, reject, {
          delegated: isClientDelegateTool(name)
        });
      }
    });
    return { tools, pumpRef };
  }

  private async abortHungDurableRun(
    hub: SessionHub,
    sessionId: string,
    slot: SessionSlot,
    reason: string
  ): Promise<void> {
    for (const id of [...slot.pending.keys()]) {
      hub.rejectPending(sessionId, id, new Error(reason));
    }
    await withCleanupTimeout(slot.run?.cancel?.().catch(() => undefined));
    if (slot.waitPromise) await withCleanupTimeout(slot.waitPromise.catch(() => undefined));
    slot.run = undefined;
    slot.waitPromise = undefined;
    slot.runId = undefined;
    hub.markIdle(sessionId);
  }

  private async dropDurableSession(hub: SessionHub, sessionId: string): Promise<void> {
    // 包 E 审阅修复（应修 2）：三个按 session 记的边车 Map 一起清（原先漏了 consumedExecutes/capturedPumps）。
    // Hub 内部的 idle/hold/LRU 回收走不到这里，由构造器里注册的 onDrop 监听兜底。
    this.durableRunOrdinals.delete(sessionId);
    this.durableConsumedExecutes.delete(sessionId);
    this.durableCapturedPumps.delete(sessionId);
    await hub.drop(sessionId).catch(() => undefined);
    await this.store.deleteSession(sessionId).catch(() => undefined);
  }

  private async durableSend(
    hub: SessionHub,
    slot: SessionSlot,
    sessionId: string,
    input: CursorRunRequest,
    resolved: ResolvedModelRun,
    signal: AbortSignal | undefined,
    spec: { kind: "new_user" | "tool_results"; message: unknown; firstSend: boolean }
  ): Promise<RunLike> {
    const ordinal = this.nextDurableOrdinal(sessionId);
    const preview = typeof spec.message === "string" ? spec.message : String(asRecord(spec.message)?.text ?? "");
    console.error(
      `[durable] send ${spec.firstSend ? "first" : "follow-up"} session=${sessionId.slice(0, 12)} chars=${preview.length}`
    );
    // 包 D：上游实际发出的轮次全文（含 firstSend 标记与消息原文），在 send 之前记——send 之后没有任何可靠的等价物。
    try {
      input.debugRef?.noteUpstreamTurn("sdk", { kind: spec.kind, firstSend: spec.firstSend, message: spec.message });
    } catch {
      // 观测路径不得影响 send。
    }
    hub.markRunning(sessionId);
    // 包 E 第 6 条：每次 send 换新 pump 并按 run 盖章。onDelta/stream 推的是「本次 send 的 pump」
    // （闭包捕获，绝不读写 slot.pump——它可能已被下一轮 send 换掉），旧 run 的残余事件
    // 因此不可能污染新轮次；消费方还会按 runId 印章丢弃陈旧项（见 consumeDurablePump）。
    const pump = new EventPump();
    hub.attachPump(sessionId, pump);
    // 换泵时同步 captured 推送的落点（durableCustomTools 闭包捕获的引用盒）：本 run 的
    // tool 调用推「本次 send 的 pump」，与 onDelta/stream 的闭包捕获同构。
    const capturedPumpRef = this.durableCapturedPumps.get(sessionId);
    if (capturedPumpRef) capturedPumpRef.current = pump;
    const onDelta = (args: { update: unknown }) => {
      if (args?.update !== undefined) pump.push({ kind: "event", event: args.update });
    };
    const agent = slot.agent as AgentLike;
    const run = await raceSendRun(agent.send(spec.message, {
      model: resolved.model,
      idempotencyKey: durableIdempotencyKey(sessionId, ordinal, spec.kind),
      onDelta,
      ...(resolved.mode ? { mode: resolved.mode } : {})
    }), signal).catch((error) => {
      const keyError = keySemanticApiError(input.model, error);
      if (keyError) throw keyError;
      throw error;
    });
    slot.run = run;
    slot.runId = run.id;
    // send 落定后才拿到 run 句柄：此刻起 pump 项盖上本 run 印章；早于此刻的项无印章、按本 run 处理。
    pump.runId = run.id;
    // 包 E 第 7 条：换新 run，旧的 execute 幂等标记作废（新 run 的 execute 是全新的键）。
    this.durableConsumedExecutes.delete(sessionId);
    const waitPromise = run.wait();
    slot.waitPromise = waitPromise;
    void waitPromise.catch(() => undefined);
    void (async () => {
      try {
        for await (const event of run.stream()) pump.push({ kind: "event", event });
        pump.push({ kind: "end" });
      } catch (error) {
        pump.push({ kind: "end", error });
      }
    })();
    if (input.telemetryRef) {
      if (slot.agent.agentId) input.telemetryRef.agentId = slot.agent.agentId;
      if (run.id) input.telemetryRef.runId = run.id;
    }
    return run;
  }

  private nextDurableOrdinal(sessionId: string): number {
    const next = (this.durableRunOrdinals.get(sessionId) ?? 0) + 1;
    this.durableRunOrdinals.set(sessionId, next);
    return next;
  }

  private async *consumeDurablePump(
    hub: SessionHub,
    sessionId: string,
    slot: SessionSlot,
    input: CursorRunRequest,
    signal: AbortSignal | undefined
  ): AsyncIterable<CursorStreamEvent> {
    const usageLedger = new TurnUsageLedger();
    const capturedToolCalls: GatewayToolCall[] = [];
    const sdkEventToolCalls: GatewayToolCall[] = [];
    const textParts: string[] = [];
    const keepThinking = !input.stream;
    const thinkingParts: string[] = [];
    const toolCalls: GatewayToolCall[] = [];
    const streamErrorDetails: string[] = [];
    const filter = input.tools.length ? new ToolMarkerFilter() : undefined;
    let textSource: "none" | "delta" | "message" = "none";
    let thinkingSource: "none" | "delta" | "message" = "none";
    let streamError: unknown;
    let streamHadItems = false;
    let pathB = false;

    const parkPathB = (): void => {
      recordIssuedToolCalls(slot, issuedIdsWithAliases(slot, toolCalls));
      hub.markIdle(sessionId);
    };

    const pathBDone = (): CursorStreamEvent => ({
      type: "done",
      result: {
        text: textParts.join("").trim(),
        toolCalls: [...toolCalls],
        ...(thinkingParts.length ? { reasoningText: thinkingParts.join("") } : {}),
        agentId: slot.agentId || slot.agent.agentId,
        runId: slot.runId ?? slot.run?.id
      }
    });

    const parkKeepAlive = async (): Promise<void> => {
      console.error(`[durable] keep-alive abort session=${sessionId.slice(0, 12)}`);
      await withCleanupTimeout(slot.run?.cancel?.().catch(() => undefined));
      recordIssuedToolCalls(slot, issuedIdsWithAliases(slot, toolCalls));
      hub.markIdle(sessionId);
      recordDurableDecision({
        decision: "reuse",
        reason: "keep-alive-abort",
        session: sessionId.slice(0, 12),
        liveSessions: hub.size
      });
    };

    const keepDeclaredOnly = (calls: GatewayToolCall[]): GatewayToolCall[] => calls.filter((toolCall) => {
      if (input.tools.length && matchesClientTool(toolCall, input.tools)) return true;
      logDeduped(
        `unmatched\0${input.model}\0${toolCall.name}`,
        `[tool-compat] model="${input.model}" dropped tool call "${toolCall.name}" not declared by the client`
      );
      return false;
    });

    function* emitTextChunk(chunk: string): Generator<CursorStreamEvent> {
      if (!chunk) return;
      if (!filter) {
        textParts.push(chunk);
        yield { type: "text", text: chunk };
        return;
      }
      const safe = filter.push(chunk);
      if (safe) {
        textParts.push(safe);
        yield { type: "text", text: safe };
      }
      const markerCalls = keepDeclaredOnly(filter.takeToolCalls());
      if (markerCalls.length && slot.pending.size === 0) {
        pathB = true;
        const start = toolCalls.length;
        for (const toolCall of normalizeToolCallsForClient(markerCalls, input.tools)) {
          pushToolCall(toolCalls, toolCall);
        }
        // Mark idle before yielding so a client disconnect during/after tool_call cannot drop the agent.
        parkPathB();
        for (const toolCall of toolCalls.slice(start)) {
          yield { type: "tool_call", toolCall };
        }
        return;
      }
      if (markerCalls.length) {
        const held = filter.takeHeldText();
        if (held) {
          textParts.push(held);
          yield { type: "text", text: held };
        }
      }
    }

    function* applyEvent(event: unknown): Generator<CursorStreamEvent> {
      const record = asRecord(event);
      const type = typeof record?.type === "string" ? record.type : "";
      if (type === "text-delta" || type === "thinking-delta" || type === "turn-ended") {
        streamHadItems = true;
        if (type === "text-delta" && typeof record?.text === "string" && record.text && textSource !== "message") {
          textSource = "delta";
          yield* emitTextChunk(record.text);
        } else if (type === "thinking-delta" && typeof record?.text === "string" && record.text && thinkingSource !== "message") {
          thinkingSource = "delta";
          if (keepThinking) thinkingParts.push(record.text);
          yield { type: "thinking", text: record.text };
        } else if (type === "turn-ended") {
          const turnUsage = parseSdkUsage(record);
          if (turnUsage) {
            usageLedger.addDeltaTurn(turnUsage);
            publishUsageTotal(usageLedger, input.telemetryRef);
          }
        }
        return;
      }
      streamHadItems = true;
      captureUsageFromSdkEvent(event, input.telemetryRef, usageLedger);
      const thinking = thinkingFromSdkEvent(event);
      if (thinking && thinkingSource !== "delta") {
        thinkingSource = "message";
        if (keepThinking) thinkingParts.push(thinking);
        yield { type: "thinking", text: thinking };
      }
      const text = textFromSdkEvent(event);
      if (text && textSource !== "delta") {
        textSource = "message";
        yield* emitTextChunk(text);
      }
      const errorDetail = errorDetailFromSdkEvent(event);
      if (errorDetail) streamErrorDetails.push(errorDetail);
      const parsedEventCalls = keepDeclaredOnly(toolCallsFromSdkEvent(event))
        .map((toolCall) => normalizeToolCallForClient(toolCall, input.tools));
      for (const toolCall of parsedEventCalls) {
        pushToolCall(sdkEventToolCalls, toolCall);
      }
    }

    const collectHeldToolCall = (toolCall: GatewayToolCall): GatewayToolCall | undefined => {
      const declared = keepDeclaredOnly([toolCall]);
      if (!declared.length) return undefined;
      const normalized = normalizeToolCallForClient(declared[0], input.tools);
      if (toolCalls.some((item) => item.id === normalized.id || (!isClientDelegateTool(normalized.name) && sameToolInvocation(item, normalized)))) {
        return undefined;
      }
      // 已交付去重：SDK 消息级事件会整段重放 run 的 assistant 内容（含早前轮次的 tool_use），
      // parkHeld / post-end 的兜底提取会把已交付过的 tool_call 再次发出——客户端重跑工具、
      // 结果被 duplicate_tool_results 打回 stateless，模型二次作答（快照实锤：同一 tool id
      // 出现在两个 assistant 轮）。该 id 仍挂在 pending（SDK 对新调用复用了同一 id）时必须
      // 放行重发，否则那个 execute 会无人解决、挂到 hold TTL 把槽拖死。
      if (
        (slot.issuedToolCallIds?.includes(normalized.id)
          || slot.issuedToolCallIds?.some((id) => toolCallIdsOverlap(id, normalized.id)))
        && !canonicalHoldId(slot, normalized.id)
      ) {
        console.error(`[durable] dropped already-issued tool call id=${normalized.id} name=${normalized.name} session=${sessionId.slice(0, 12)}`);
        return undefined;
      }
      pushToolCall(toolCalls, normalized);
      rememberCallAlias(slot, normalized.id, responseCallIds(normalized).callId);
      rememberCallAlias(slot, normalized.id, responsesCallId(normalized.id));
      for (const token of toolCallIdTokens(normalized.id)) {
        rememberCallAlias(slot, normalized.id, token);
      }
      return normalized;
    };

    const parkHeld = async function* (): AsyncIterable<CursorStreamEvent> {
      await hub.settleParallelTools();
      for (;;) {
        const extra = slot.pump.poll();
        if (!extra) break;
        if (extra.kind === "captured") {
          pushToolCall(capturedToolCalls, {
            id: extra.id,
            name: extra.name,
            arguments: extra.args ?? {}
          });
        } else if (extra.kind === "event") {
          yield* applyEvent(extra.event);
        }
      }
      const start = toolCalls.length;
      if (slot.pending.size > 0) {
        for (const toolCall of capturedToolCalls) collectHeldToolCall(toolCall);
        for (const eventCall of sdkEventToolCalls) {
          if (toolCalls.some((item) => item.id === eventCall.id || (!isClientDelegateTool(eventCall.name) && sameToolInvocation(item, eventCall)))) continue;
          const matchId = isClientDelegateTool(eventCall.name)
            ? [...slot.pending.keys()].find((id) => id === eventCall.id || toolCallIdsOverlap(id, eventCall.id))
            : [...slot.pending.keys()].find((id) => slot.pending.get(id)?.name === eventCall.name);
          if (matchId) collectHeldToolCall({ ...eventCall, id: matchId });
        }
      } else {
        for (const toolCall of pendingCapturedToolCalls(capturedToolCalls, toolCalls)) collectHeldToolCall(toolCall);
        for (const toolCall of sdkEventToolCalls) collectHeldToolCall(toolCall);
      }
      for (const toolCall of toolCalls.slice(start)) {
        yield { type: "tool_call", toolCall };
      }
      recordIssuedToolCalls(slot, issuedIdsWithAliases(slot, toolCalls));
      hub.beginAwaitingTools(sessionId);
      yield {
        type: "done",
        result: {
          text: textParts.join("").trim(),
          toolCalls: [...toolCalls],
          ...(thinkingParts.length ? { reasoningText: thinkingParts.join("") } : {}),
          agentId: slot.agentId || slot.agent.agentId,
          runId: slot.runId ?? slot.run?.id
        }
      };
    };

    try {
    for (;;) {
      const item = await nextHubItem(slot.pump, signal);
      if (item.kind === "http-abort") {
        // Held execute: this HTTP is supposed to end with tool_calls. Do not drop the slot.
        if (slot.pending.size > 0) {
          yield* parkHeld();
          return;
        }
        // Path B: tools already on the wire. Keep the agent idle; do not 499-drop.
        if (pathB && toolCalls.length) {
          parkPathB();
          yield pathBDone();
          return;
        }
        // Client abort after semantic output: cancel the Run, keep the agent, yield done.
        // Idle-timeout 504 must not be converted to 200 even with partial text.
        if ((textParts.length || toolCalls.length) && !isIdleTimeoutAbort(signal)) {
          await parkKeepAlive();
          yield pathBDone();
          return;
        }
        throw new ApiError("Request was aborted.", 499, "request_aborted");
      }
      // 包 E 第 6 条：pump 项归属校验。带印章且不等于当前 runId 的事件属于上一轮 run 的残留
      // （换 run 只靠 attachPump 整体换队列，早于本轮 send 的项可能还在排队）——丢弃并打点，
      // 绝不能当作本轮输出（线上那些 0.0s 却有 token 估算的 200 行的最可疑来源）。
      // 无印章项 = 本次 send 早于 run 句柄就绪的窗口推入，按本 run 处理。
      const stampedRunId = item.runId;
      if (stampedRunId !== undefined && slot.runId !== undefined && stampedRunId !== slot.runId) {
        console.error(
          `[durable] dropped stale pump ${item.kind} run=${stampedRunId} current=${slot.runId} session=${sessionId.slice(0, 12)}`
        );
        recordDurableDecision({
          decision: "fallback",
          reason: "stale_pump_events",
          session: sessionId.slice(0, 12),
          kind: input.durableTurn?.kind,
          liveSessions: hub.size
        });
        // 陈旧 end 是旧流的终止信号：丢弃后不能再回 nextHubItem 死等（上一轮 send 的 pump
        // 不会再有新项），本轮 pump 消费到此为止，wait/收尾照常接手。
        if (item.kind === "end") break;
        continue;
      }
      if (item.kind === "captured") {
        streamHadItems = true;
        pushToolCall(capturedToolCalls, {
          id: item.id,
          name: item.name,
          arguments: item.args ?? {}
        });
      } else if (item.kind === "event") {
        yield* applyEvent(item.event);
      } else if (item.kind === "end") {
        streamError = item.error;
        break;
      }

      if (pathB) {
        await withCleanupTimeout(slot.run?.cancel?.().catch(() => undefined));
        break;
      }

      if (slot.pending.size > 0) {
        yield* parkHeld();
        return;
      }
    }

    // Path B marker: tools already yielded. Skip wait on the cancelled run so HTTP abort
    // cannot 499 while state is still running (that would drop the agent in streamDurable finally).
    if (pathB) {
      parkPathB();
      yield pathBDone();
      return;
    }

    if (streamError && (signal?.aborted || !capturedToolCalls.length)) throw streamError;

    if (filter && !toolCalls.length && !capturedToolCalls.length) {
      const rest = filter.flush();
      if (rest) {
        textParts.push(rest);
        yield { type: "text", text: rest };
      }
    }

    if (slot.pending.size > 0) {
      yield* parkHeld();
      return;
    }

    for (const toolCall of pendingCapturedToolCalls(capturedToolCalls, toolCalls)) {
      const emitted = collectHeldToolCall(toolCall);
      if (emitted) yield { type: "tool_call", toolCall: emitted };
    }
    for (const toolCall of sdkEventToolCalls) {
      const emitted = collectHeldToolCall(toolCall);
      if (emitted) yield { type: "tool_call", toolCall: emitted };
    }

    let waitError: unknown;
    let waited: unknown;
    try {
      waited = await raceWithAbort(slot.waitPromise ?? slot.run?.wait() ?? Promise.resolve(undefined), signal);
    } catch (error) {
      if (error instanceof ApiError && error.code === "request_aborted") {
        if (isIdleTimeoutAbort(signal)) throw error;
        if (pathB && toolCalls.length) {
          parkPathB();
          yield pathBDone();
          return;
        }
        if (textParts.length || toolCalls.length) {
          await parkKeepAlive();
          yield pathBDone();
          return;
        }
        throw error;
      }
      waitError = error;
    }

    const waitedText = resultText(waited);
    if (!streamHadItems && !toolCalls.length && !textParts.length && waitedText && !isRitualAssistantText(waitedText)) {
      const parsed = input.tools.length ? parseToolMarkers(waitedText) : { text: waitedText, toolCalls: [] };
      const declared = keepDeclaredOnly(parsed.toolCalls);
      if (declared.length) {
        pathB = true;
        const start = toolCalls.length;
        for (const toolCall of normalizeToolCallsForClient(declared, input.tools)) {
          pushToolCall(toolCalls, toolCall);
        }
        parkPathB();
        for (const toolCall of toolCalls.slice(start)) {
          yield { type: "tool_call", toolCall };
        }
      }
      if (parsed.text && !declared.length) {
        textParts.push(parsed.text);
        yield { type: "text", text: parsed.text };
      }
    }

    const terminalStatus = runStatus(waited);
    if (!textParts.length && !toolCalls.length && (terminalStatus === "error" || terminalStatus === "cancelled")) {
      throw upstreamRunError(input.model, uniqueJoined([...streamErrorDetails, runErrorDetail(waited)]));
    }
    if (!textParts.length && !toolCalls.length && waited === undefined && waitError) {
      const keyError = keySemanticApiError(input.model, waitError);
      if (keyError) throw keyError;
      throw upstreamRunError(input.model, uniqueJoined([...streamErrorDetails, errorMessage(waitError)]));
    }

    recordIssuedToolCalls(slot, issuedIdsWithAliases(slot, toolCalls));
    hub.markIdle(sessionId);
    yield {
      type: "done",
      result: {
        text: textParts.join("").trim(),
        toolCalls: [...toolCalls],
        ...(thinkingParts.length ? { reasoningText: thinkingParts.join("") } : {}),
        agentId: slot.agentId || slot.agent.agentId,
        runId: slot.runId ?? slot.run?.id
      }
    };
    } finally {
      const live = hub.get(sessionId);
      if (
        live?.state === "running"
        && live.pending.size === 0
        && (textParts.length > 0 || toolCalls.length > 0)
        && !isIdleTimeoutAbort(signal)
      ) {
        await parkKeepAlive();
      }
      // 包 E 第 2/6 条（收尾口径统一放在 finally：done / parkHeld / pathBDone / 异常全都要走）：
      // - 上一轮 assistant 输出摘要（normalize 后 sha256），下一轮 new_user 与入站 transcript 比对；
      // - 「已交付」标记：本轮发过语义输出（文本或工具调用）即算交付，重试判定据此选续播还是 stateless。
      // live 槽可能与闭包 slot 不是同一对象（中途被换过），一律取 live ?? slot（slot 恒有值）。
      const target = live ?? slot;
      recordAssistantDigest(target, textParts.join(""));
      if (textParts.length > 0 || toolCalls.length > 0) markTurnDelivered(target);
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
    // 上游用量按 turn 记账：两条通道都会报同一个 turn，收尾时只取一份（见 TurnUsageLedger）。
    const usageLedger = new TurnUsageLedger();
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
      // 记下 agent/run 标识，供 UsageReconciler 事后按 agent 回查计费金额。
      if (input.telemetryRef) {
        if (agent.agentId) input.telemetryRef.agentId = agent.agentId;
        if (run.id) input.telemetryRef.runId = run.id;
      }
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
      // 流里只要来过 delta/event（含被丢掉的 task/status），wait() 文本就不能再当助手正文。
      let streamHadItems = false;
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
          streamHadItems = true;
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
          } else if (type === "turn-ended") {
            // turn-ended 的 usage 是可选的，且线上不带 totalTokens；解析不出就什么都不记。
            const turnUsage = parseSdkUsage(update);
            if (turnUsage) {
              usageLedger.addDeltaTurn(turnUsage);
              publishUsageTotal(usageLedger, input.telemetryRef);
            }
          }
        } else if (item.kind === "event") {
          streamHadItems = true;
          const event = item.event;
          captureUsageFromSdkEvent(event, input.telemetryRef, usageLedger);
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
      // 整段流为空才用 wait() 文本；流里已有过 event/delta（含过滤掉的 task）则不用。仪式句丢弃。
      if (!streamHadItems && !toolCalls.length && !textParts.length && waitedText && !isRitualAssistantText(waitedText)) {
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
      if (!this.isStateless(input) && agent.agentId) await this.store.saveSession(id, agent.agentId);
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
    // 包 D：stateless / 旧 resume 路径的上游轮次全文（与 durable 路径同一出口口径）。
    try {
      input.debugRef?.noteUpstreamTurn("sdk", { kind: "stateless-send", message: this.sdkMessage(input) });
    } catch {
      // 观测路径不得影响 send。
    }
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

  private agentOptions(
    input: CursorRunRequest,
    resolved: ResolvedModelRun,
    customTools?: ReturnType<typeof createSdkCustomTools>,
    agentId?: string
  ): Record<string, unknown> {
    return {
      apiKey: input.apiKey,
      model: resolved.model,
      name: "Docker Composer API",
      ...(agentId ? { agentId } : {}),
      // settingSources: [] 显式关闭环境规则加载，绝不把调用方机器/项目/团队的 Cursor 规则
      //（~/.cursor、.cursor/rules、AGENTS.md 等）注入到请求里，避免夹带额外提示词。
      local: {
        cwd: input.workingDirectory || this.input.defaultWorkingDirectory,
        settingSources: [],
        ...(this.input.localAgentStore ? { store: this.input.localAgentStore } : {}),
        ...(customTools ? { customTools } : {})
      },
      clientVersion: this.input.sdkClientVersion,
      // SDK 内置工具限制：IDE 转发路线永远不开放内层 `"task"`（原生 SDK 子代理）。
      // 无客户端工具 → []（纯文本）；有客户端工具 → 只留 "mcp"（customTools 经 custom-user-tools 暴露）。
      // allowBuiltinTools 只放开容器内 shell/edit 等，仍用 disallowedTools 关掉 task，避免静默绕过。
      ...this.innerSdkToolLimits(input),
      ...(resolved.mode ? { mode: resolved.mode } : {})
    };
  }

  private innerSdkToolLimits(input: CursorRunRequest): Record<string, unknown> {
    if (liveFlag(this.input.allowBuiltinTools)) {
      return { disallowedTools: ["task"] };
    }
    return { tools: input.tools.length ? ["mcp"] : [] };
  }

  private sdkMessage(input: CursorRunRequest): unknown {
    return sdkTextMessage(input.prompt, input.images);
  }

  /** 进程级 kill switch、单请求 forceStateless、或未注入 Hub：跳过 Hub 与旧 resume 的 get/save。 */
  private isStateless(input: CursorRunRequest): boolean {
    return Boolean(liveFlag(this.input.disableSessionResume) || input.forceStateless || !this.input.sessionHub);
  }
}

function liveFlag(value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === "function" ? value() : Boolean(value);
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

function durableIdempotencyKey(sessionId: string, runOrdinal: number, kind: string): string {
  return createHash("sha256").update(`${sessionId}:${runOrdinal}:${kind}`).digest("hex");
}

function formatDurableUserMessage(input: { firstSend: boolean; userText: string; systemText?: string }): string {
  const parts: string[] = [];
  if (input.firstSend) {
    parts.push(STABLE_DIRECTIVE);
    const system = input.systemText?.trim();
    if (system) parts.push(`SYSTEM:\n${system}`);
  }
  if (input.userText) parts.push(input.userText);
  return parts.join("\n\n");
}

function formatPathBToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): string {
  return results.map((result) => {
    const tag = result.isError ? "TOOL RESULT ERROR" : "TOOL RESULT";
    return `${tag} (${result.id}):\n${result.content}`;
  }).join("\n\n");
}

function sdkTextMessage(text: string, images?: GatewayImage[]): unknown {
  if (!images?.length) return text;
  return {
    text,
    images: images.map((image) => image.source === "url"
      ? { url: image.data }
      : { data: image.data, mimeType: image.mediaType ?? "image/png" })
  };
}

type DurablePumpItem = HubPumpItem | { kind: "http-abort" };

function nextHubItem(pump: EventPump, signal?: AbortSignal): Promise<DurablePumpItem> {
  if (signal?.aborted) return Promise.resolve({ kind: "http-abort" });
  if (!signal) return pump.next();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (item: DurablePumpItem): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(item);
    };
    const onAbort = (): void => finish({ kind: "http-abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    void pump.next().then(
      (item) => finish(item),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
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

/** 只从 assistant 抽正文；task 等里程碑带 .text，兜底会泄漏并锁死 textSource。 */
export function textFromSdkEvent(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const type = typeof record.type === "string" ? record.type : "";
  if (
    type === "status" ||
    type === "thinking" ||
    type === "thinkingMessage" ||
    type === "task" ||
    type === "system" ||
    type === "user" ||
    type === "tool_call" ||
    type === "request" ||
    type === "usage"
  ) {
    return "";
  }
  if (type === "assistant") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const fromBlocks = content.flatMap((block) => {
      const item = asRecord(block);
      return item && (item.type === "text" || item.type === "output_text") && typeof item.text === "string" ? [item.text] : [];
    }).join("");
    if (fromBlocks) return fromBlocks;
    if (typeof message?.content === "string") return message.content;
    if (typeof message?.text === "string") return message.text;
    if (typeof record.text === "string") return record.text;
    return "";
  }
  return "";
}

/**
 * 从 SDK 的 turn-ended / usage 负载里解析出用量；解析不出返回 undefined。
 *
 * 两种入参形状都接受：外层带 `usage` 字段的整包（turn-ended 更新、SDKUsageMessage），
 * 或已经剥出来的 token 计数对象。四个必备字段（input/output/cacheRead/cacheWrite）
 * 少任何一个都当作「上游这次没报用量」返回 undefined，绝不用半份数据冒充真实用量
 * ——写进日志的 usageSource=sdk 是要拿来对账的。
 */
export function parseSdkUsage(payload: unknown): RequestUsage | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = finiteNumber(source.inputTokens);
  const outputTokens = finiteNumber(source.outputTokens);
  const cacheReadTokens = finiteNumber(source.cacheReadTokens);
  const cacheWriteTokens = finiteNumber(source.cacheWriteTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  const reasoningTokens = finiteNumber(source.reasoningTokens);
  // 即使 SDK 带 totalTokens 也重新按四桶校验；历史与协议估算必须共享同一不变量，不能让矛盾总数流出去：
  // 四个桶互斥，合计是四者之和（reasoning 是 output 的子集，不另计）。
  // 漏掉两个缓存桶会让历史里的合计显著偏小——缓存读取往往比未命中的输入还大一个量级。
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const sdkTotalField = finiteNumber(source.totalTokens);
  console.error(
    `[durable] turn-ended input=${inputTokens} cacheRead=${cacheReadTokens} cacheWrite=${cacheWriteTokens} output=${outputTokens} totalField=${sdkTotalField === undefined ? "absent" : sdkTotalField}`
  );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

/** 字段级累加多个 turn 的用量。两侧都没有 reasoningTokens 时结果也不带这个字段。 */
export function mergeUsage(base: RequestUsage | undefined, next: RequestUsage | undefined): RequestUsage | undefined {
  if (!base) return next ? normalizeRequestUsage(next) : undefined;
  if (!next) return normalizeRequestUsage(base);
  const reasoningTokens = base.reasoningTokens === undefined && next.reasoningTokens === undefined
    ? undefined
    : (base.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  return normalizeRequestUsage({
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    cacheReadTokens: base.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + next.cacheWriteTokens,
    totalTokens: base.totalTokens + next.totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  });
}

/** onDelta 不带 run_id：它只服务当前这一个 run，用这个哨兵 key 归组。 */
const UNKNOWN_RUN_KEY = "";

/**
 * 按 turn 记账，解决两条通道重复上报同一个 turn 的问题。
 *
 * 一次请求可能跑多个 turn，而同一个 turn 会被 onDelta 的 turn-ended 与 run.stream()
 * 的消息级 usage 事件各报一次，直接相加就是双倍计量。去重办法：两条通道各自按
 * 「run_id + 到达序号」建账（onDelta 没有 run_id，归到当前 run），收尾时同一序号
 * 优先取消息级 usage —— 它自带权威 totalTokens；只有消息级没覆盖到的尾部 turn
 * （例如流在 usage 事件到达前就被工具调用打断）才回退用 delta 的数字。
 * 两条通道各自内部序号单调递增，所以只需在收尾时按数量对齐，不依赖跨通道的到达次序。
 */
class TurnUsageLedger {
  private readonly deltaTurns: RequestUsage[] = [];
  private readonly messageTurns = new Map<string, RequestUsage[]>();
  /** onDelta 归属的 run：认第一个见到的 run_id。 */
  private primaryRunKey?: string;

  addDeltaTurn(usage: RequestUsage): void {
    this.deltaTurns.push(usage);
  }

  addMessageTurn(runId: string | undefined, usage: RequestUsage): void {
    const key = runId ?? UNKNOWN_RUN_KEY;
    this.primaryRunKey ??= key;
    const turns = this.messageTurns.get(key);
    if (turns) turns.push(usage);
    else this.messageTurns.set(key, [usage]);
  }

  total(): RequestUsage | undefined {
    let total: RequestUsage | undefined;
    for (const turns of this.messageTurns.values()) {
      for (const usage of turns) total = mergeUsage(total, usage);
    }
    const covered = this.messageTurns.get(this.primaryRunKey ?? UNKNOWN_RUN_KEY)?.length ?? 0;
    for (const usage of this.deltaTurns.slice(covered)) total = mergeUsage(total, usage);
    return total;
  }
}

/** 把账本当前合计写回遥测通道：提前 break / abort 收尾时也能留下已采到的那部分。 */
function publishUsageTotal(ledger: TurnUsageLedger, telemetry: RunTelemetryRef | undefined): void {
  if (!telemetry) return;
  const total = ledger.total();
  if (total) telemetry.usage = total;
}

/**
 * 消息级事件里的用量与标识：system(init) 与 usage 事件都带 agent_id / run_id，
 * usage 事件另带该 turn 的权威 TokenUsage。整段按未知边界防御解析，
 * 畸形负载只会「没采到」，不会把异常抛进流循环。
 */
function captureUsageFromSdkEvent(
  event: unknown,
  telemetry: RunTelemetryRef | undefined,
  ledger: TurnUsageLedger
): void {
  const record = asRecord(event);
  const type = typeof record?.type === "string" ? record.type : "";
  if (!record || (type !== "usage" && type !== "system")) return;
  const runId = stringValue(record.run_id) ?? stringValue(record.runId);
  if (telemetry) {
    const agentId = stringValue(record.agent_id) ?? stringValue(record.agentId);
    if (agentId) telemetry.agentId = agentId;
    if (runId) telemetry.runId = runId;
  }
  if (type !== "usage") return;
  const usage = parseSdkUsage(record);
  if (!usage) return;
  ledger.addMessageTurn(runId, usage);
  publishUsageTotal(ledger, telemetry);
}

/** 把真实下发给上游的模型 / 参数写回遥测通道，用于核对推理强度、1M、fast 是否真的生效。 */
function recordRunTelemetry(input: CursorRunRequest, resolved: ResolvedModelRun): void {
  const telemetry = input.telemetryRef;
  if (!telemetry) return;
  telemetry.upstreamModel = resolved.model.id;
  if (resolved.model.params?.length) telemetry.modelParams = resolved.model.params.map((param) => ({ ...param }));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  if (error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_run_failed") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /stale session|session not found|session expired|unknown agent/i.test(message);
}

function isActiveRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has active run|agent is busy|AgentBusyError/i.test(message)
    || /\b(CREATING|RUNNING)\b/.test(message);
}

function isIdleTimeoutAbort(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason;
  return reason instanceof ApiError && reason.statusCode === 504;
}

function isAgentAlreadyExistsError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "UnknownAgentError" || /already exists/i.test(errorMessage(error));
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
  const id = stringValue(tool.id) ?? stringValue(tool.call_id) ?? stringValue(tool.callId);
  if (!id) return [];
  return [{ id, name, arguments: args }];
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
    const id = stringValue(item.id);
    if (!id) continue;
    toolCalls.push({
      id,
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

function sameToolInvocation(left: GatewayToolCall, right: GatewayToolCall): boolean {
  return left.name === right.name && JSON.stringify(left.arguments) === JSON.stringify(right.arguments);
}

function issuedIdsWithAliases(slot: SessionSlot, toolCalls: GatewayToolCall[]): string[] {
  const ids: string[] = [];
  for (const toolCall of toolCalls) {
    ids.push(toolCall.id);
    ids.push(...toolCallIdTokens(toolCall.id));
    ids.push(responsesCallId(toolCall.id));
    ids.push(responseCallIds(toolCall).callId);
    rememberCallAlias(slot, toolCall.id, responsesCallId(toolCall.id));
    rememberCallAlias(slot, toolCall.id, responseCallIds(toolCall).callId);
    for (const token of toolCallIdTokens(toolCall.id)) {
      rememberCallAlias(slot, toolCall.id, token);
    }
  }
  return ids;
}

/**
 * tool_results 零交集护栏（纯函数）：本轮全部工具结果 id 与槽里已发过的 tool_call id
 * （含 Responses / Chat 别名归一）零交集 = 这批结果是**另一个会话的 agent** 发起的调用，
 * 不是本槽的续聊。正常路径都有交集：path A（held execute，id 在 pending）；path B
 * （上一轮已交付的 tool_call，id 在 issued）。零交集时调用方必须退 stateless，
 * 绝不能 abort 本槽挂起的 execute（那是对方会话正在等待的工具轮）再 send 进来。
 */
export function toolResultsForeignToSlot(
  slot: SessionSlot,
  toolResults: Array<{ id: string }>
): boolean {
  if (!toolResults.length) return false;
  // 两侧按 token 交集比对：剥 call_、拆换行复合 id、以及 64 字符截断前缀。
  // SDK execute id 常为 `call-<uuid>-N\nfc_<uuid>_0`，客户端回传会被截成 64 字符，
  // 只做整串/剥前缀相等会把本槽续聊误判成外来结果。
  const known = [...(slot.issuedToolCallIds ?? []), ...slot.pending.keys()].filter(Boolean);
  if (!known.length) return false;
  return toolResults.every((result) => {
    if (!result.id) return true;
    return !known.some((id) => toolCallIdsOverlap(id, result.id));
  });
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
