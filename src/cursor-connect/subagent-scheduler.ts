import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { modelAllowed } from "../routing.js";
import type { GatewayTool, GatewayToolCall, ModelParameterValue, ModelScope, RequestUsage } from "../types.js";
import type { PreparedConversation } from "./conversation.js";
import type { ConnectRequestedModel } from "./request-builder.js";
import type { CursorConnectStore } from "./store.js";
import type { ToolExecution } from "./tool-loop.js";

/**
 * 网关编排的子代理（计划 §G7）。
 *
 * **协议层面没有子代理概念**：`InferenceStreamRequest` 的 12 个字段里没有
 * subagent / parentTask / taskId，`conversation_group_id` 的语义是"同一组对话"而不是父子关系。
 * 所以父子 DAG 完全由网关自己维护，这里叫 adapter-managed subagent，不是上游原生 Task。
 */

/**
 * 工具名刻意不叫 `Task`。
 * `tool-compat.ts:19` 明确把宿主元工具 `Task` 挡在 customTools 之外
 * （"否则内层会再演 MCP 发现或 Task 套娃"）。那条过滤规则不动，
 * 网关在 `tools[]` 里追加自己的这一个，两者不撞名。
 */
export const SUBAGENT_TOOL_NAME = "spawn_subagent";

/** child run 的租约时长。够长以免正常运行中被别人抢走，够短以免崩溃后长期无人接管。 */
const SUBAGENT_LEASE_MS = 300_000;

/** 每 parent 累计 spawn 数账本的条目上限，防止长驻进程里这张表无限增长。 */
const SPAWN_LEDGER_MAX = 1024;

export interface SubagentLimits {
  /** 层数上限。2 = parent(depth 0) → child(depth 1)，child 不能再 spawn。 */
  maxDepth: number;
  /** 单个 parent 能起的子任务数。 */
  maxChildrenPerRun: number;
  /** 本 scheduler 生命周期内的子任务总数上限；0 表示不限。 */
  maxChildrenTotal: number;
  /** 同时在跑的子任务数。 */
  maxConcurrent: number;
  /** 整棵树的 token 预算，由 `SubagentRunner` 回报的 usage 累计；0 表示不限。 */
  tokenBudget: number;
  /** 整棵树的墙钟预算，从第一个 child 起算；0 表示不限。 */
  wallClockBudgetMs: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxDepth: 2,
  maxChildrenPerRun: 4,
  maxChildrenTotal: 64,
  maxConcurrent: 8,
  tokenBudget: 0,
  wallClockBudgetMs: 0
};

export interface SubagentRequest {
  prompt: string;
  model?: string;
  parameters?: ModelParameterValue[];
  description?: string;
}

export interface SubagentRunContext {
  taskId: string;
  runId: string;
  /** **新的** conversation_id，不复用父的。 */
  conversationId: string;
  invocationId: string;
  parentRunId: string;
  parentToolCallId: string;
  depth: number;
  requestedModel: ConnectRequestedModel;
  prompt: string;
  /**
   * child 可用的工具。**默认空数组**——child 不继承 parent 的本地工具。
   * 想让它继承必须由调用方显式给 `childTools`，不能靠 runner "顺手"复用 parent 的。
   */
  tools: GatewayTool[];
  signal?: AbortSignal;
}

/**
 * 真正跑一个 child run。由调用方注入，scheduler 只管 DAG、限额与取消。
 * 回报 `usage` 才能让 token 预算生效——不报就等于预算永远不触发。
 */
export type SubagentRunner = (
  context: SubagentRunContext
) => Promise<{ text: string; isError?: boolean; usage?: RequestUsage }>;

export interface SubagentSchedulerOptions {
  store: CursorConnectStore;
  runChild: SubagentRunner;
  limits?: Partial<SubagentLimits>;
  /** 子代理默认模型；不传就继承父模型。 */
  defaultModel?: string;
  /**
   * 子代理可用模型范围。child 的 model 来自**模型自己写的工具参数**，
   * 不校验就等于让模型绕过网关密钥的模型白名单自我提权。
   */
  modelScope?: ModelScope;
  /** child 能用的工具；缺省为空（不继承 parent 的）。 */
  childTools?: GatewayTool[];
  newId?: () => string;
  now?: () => number;
}

/** 暴露给模型的子代理工具定义。 */
export function subagentTool(): GatewayTool {
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      "Delegate a self-contained sub-task to a fresh agent with its own conversation. " +
      "Returns the sub-agent's final text. Use for work that does not need this conversation's history.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full instruction for the sub-agent." },
        model: { type: "string", description: "Optional model id for the sub-agent." },
        description: { type: "string", description: "Short label for tracking." }
      },
      required: ["prompt"]
    }
  };
}

export class SubagentScheduler {
  private readonly limits: SubagentLimits;
  private readonly newId: () => string;
  private readonly inflight = new Map<string, AbortController>();
  /**
   * parentRunId → 该 parent **累计**起过的 child 数。
   *
   * 是累计而不是当前在跑数：计划把"子任务数量"和"并发"列为两条独立限额，
   * 前者要挡住"一个 parent 反复起 child 磨到天亮"，按并发计根本挡不住。
   * 代价是这张表会随 parent 数增长，所以下面用 `SPAWN_LEDGER_MAX` 封顶。
   */
  private readonly spawned = new Map<string, number>();
  private readonly now: () => number;
  private tokensUsed = 0;
  private totalSpawned = 0;
  private startedAt?: number;
  /** cancelAll 之后不再接新 child：否则同一轮里模型发的第二个工具调用会起一个新的。 */
  private cancelledAll = false;

  constructor(private readonly options: SubagentSchedulerOptions) {
    this.limits = { ...DEFAULT_SUBAGENT_LIMITS, ...options.limits };
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  get activeCount(): number {
    return this.inflight.size;
  }

  get spentTokens(): number {
    return this.tokensUsed;
  }

  /** 把已消耗的 token 计进预算。`spawn` 会用 runner 回报的 usage 自动调用它。 */
  addUsage(totalTokens: number): void {
    this.tokensUsed += Math.max(0, totalTokens);
  }

  /**
   * 作为 tool-loop 的执行器接入。不是 `spawn_subagent` 的调用一律返回 `undefined`，
   * 交回调用方——scheduler 不该把别人的工具也吞掉。
   */
  executor(parent: { runId: string; conversation: PreparedConversation; depth: number; model: ConnectRequestedModel }) {
    return async (call: GatewayToolCall): Promise<ToolExecution | undefined> => {
      if (call.name !== SUBAGENT_TOOL_NAME) return undefined;
      try {
        const text = await this.spawn(parent, call);
        return { result: { output: text } };
      } catch (error) {
        // 子代理失败不能让父任务永久 running：把失败作为 tool result 回灌。
        return { result: { error: error instanceof Error ? error.message : "subagent failed" }, isError: true };
      }
    };
  }

  private async spawn(
    parent: { runId: string; conversation: PreparedConversation; depth: number; model: ConnectRequestedModel },
    call: GatewayToolCall
  ): Promise<string> {
    const request = parseRequest(call.arguments);
    this.assertWithinLimits(parent);

    const childModel = request.model ?? this.options.defaultModel ?? parent.model.modelId;
    // child 的 model 是模型自己在工具参数里写的字符串。不校验范围，
    // 一个被钉在便宜模型上的 key 就能靠 spawn_subagent 把自己升级到任意模型。
    if (!modelAllowed(childModel, this.options.modelScope)) {
      throw new ApiError(`Model ${childModel} is not allowed for sub-agents.`, 403, "model_not_allowed");
    }

    // 循环检测：child 的 prompt 与父的最后一条 user 文本相同，说明模型在原地打转。
    if (isEchoOfParent(request.prompt, parent.conversation)) {
      throw new ApiError("Sub-agent prompt repeats the parent prompt; refusing to recurse.", 400, "invalid_request_error");
    }

    const runId = this.newId();
    const task = this.options.store.createTask({
      runId,
      taskType: SUBAGENT_TOOL_NAME,
      depth: parent.depth + 1,
      requestedModel: childModel,
      parametersJson: request.parameters ? JSON.stringify(request.parameters) : undefined
    });

    const conversation = this.options.store.upsertConversation({
      ownerHash: `subagent:${parent.runId}`,
      // 新的 conversation_id：复用父的会让上游把两段完全不同的上下文当成一段。
      upstreamConversationId: this.newId()
    });
    this.options.store.createRun({
      id: runId,
      conversationId: conversation.id,
      requestedModel: childModel,
      parentRunId: parent.runId,
      parentToolCallId: call.id,
      // 建成 queued 再取租约，而不是直接写 running：直接写 running 的话 lease_until 是 NULL，
      // 进程中途死掉时崩溃接管分支（status=running AND lease_until<=now）永远看不到它。
      status: "queued"
    });
    this.options.store.leaseRun(runId, `subagent:${parent.runId}`, SUBAGENT_LEASE_MS);

    const controller = new AbortController();
    this.inflight.set(runId, controller);
    this.noteSpawn(parent.runId);
    this.totalSpawned += 1;
    this.startedAt ??= this.now();
    this.options.store.updateTaskStatus(task.taskId, "running");

    try {
      const result = await this.options.runChild({
        taskId: task.taskId,
        runId,
        conversationId: conversation.upstreamConversationId,
        invocationId: this.newId(),
        parentRunId: parent.runId,
        parentToolCallId: call.id,
        depth: parent.depth + 1,
        requestedModel: {
          modelId: childModel,
          // 子代理有自己的 parameters；不传就继承父的，但**不共享同一个数组引用**。
          parameters: request.parameters ?? [...(parent.model.parameters ?? [])],
          maxMode: parent.model.maxMode ?? false,
          builtInModel: parent.model.builtInModel ?? true
        },
        prompt: request.prompt,
        // 默认不继承 parent 的工具。
        tools: this.options.childTools ?? [],
        signal: controller.signal
      });
      this.addUsage(result.usage?.totalTokens ?? 0);
      const cancelled = controller.signal.aborted;
      const status = cancelled ? "cancelled" : result.isError ? "failed" : "completed";
      this.options.store.updateTaskStatus(task.taskId, status);
      this.options.store.releaseRunLease(runId, status);
      if (cancelled) throw new ApiError("Sub-agent was cancelled.", 499, "request_aborted");
      if (result.isError) throw new ApiError(result.text || "sub-agent failed", 502, "upstream_error");
      return result.text;
    } catch (error) {
      // 取消与失败在 store 里必须可区分，否则事后分不清是上游出错还是父任务撤了。
      const status = controller.signal.aborted ? "cancelled" : "failed";
      this.options.store.updateTaskStatus(task.taskId, status);
      this.options.store.releaseRunLease(runId, status);
      throw error;
    } finally {
      this.inflight.delete(runId);
    }
  }

  /**
   * 记一次 spawn，并给账本封顶。
   * 超上限时按插入顺序丢最旧的 parent——那些 parent 早就跑完了，
   * 让它们理论上"恢复配额"远好过让这张表无限长。
   */
  private noteSpawn(parentRunId: string): void {
    this.spawned.set(parentRunId, (this.spawned.get(parentRunId) ?? 0) + 1);
    while (this.spawned.size > SPAWN_LEDGER_MAX) {
      const oldest = this.spawned.keys().next();
      if (oldest.done || oldest.value === parentRunId) break;
      this.spawned.delete(oldest.value);
    }
  }

  /**
   * 父任务取消要传播到所有 child，否则 parent 走了 child 还在烧 token。
   *
   * 不在这里清 `inflight`：清了之后 `activeCount` 立刻归零，而 child 其实还活着，
   * 并发上限当场失效。让每个 child 自己在 `finally` 里摘除。
   */
  cancelAll(): void {
    this.cancelledAll = true;
    for (const controller of this.inflight.values()) controller.abort();
  }

  private assertWithinLimits(parent: { runId: string; depth: number }): void {
    if (this.cancelledAll) {
      throw new ApiError("Sub-agent scheduling was cancelled for this run.", 499, "request_aborted");
    }
    // maxDepth 数的是层数：maxDepth=2 → parent(0) + child(1)，child 不能再 spawn。
    if (parent.depth + 1 >= this.limits.maxDepth) {
      throw new ApiError(`Sub-agent depth limit (${this.limits.maxDepth}) reached.`, 400, "invalid_request_error");
    }
    if ((this.spawned.get(parent.runId) ?? 0) >= this.limits.maxChildrenPerRun) {
      throw new ApiError(
        `Sub-agent count limit (${this.limits.maxChildrenPerRun}) reached for this run.`,
        429,
        "rate_limit_exceeded"
      );
    }
    if (this.limits.maxChildrenTotal > 0 && this.totalSpawned >= this.limits.maxChildrenTotal) {
      throw new ApiError(`Sub-agent total limit (${this.limits.maxChildrenTotal}) reached.`, 429, "rate_limit_exceeded");
    }
    if (this.inflight.size >= this.limits.maxConcurrent) {
      throw new ApiError(`Sub-agent concurrency limit (${this.limits.maxConcurrent}) reached.`, 429, "rate_limit_exceeded");
    }
    if (this.limits.tokenBudget > 0 && this.tokensUsed >= this.limits.tokenBudget) {
      throw new ApiError("Sub-agent token budget exhausted.", 429, "rate_limit_exceeded");
    }
    if (
      this.limits.wallClockBudgetMs > 0 &&
      this.startedAt !== undefined &&
      this.now() - this.startedAt >= this.limits.wallClockBudgetMs
    ) {
      throw new ApiError("Sub-agent time budget exhausted.", 429, "rate_limit_exceeded");
    }
  }
}

function parseRequest(args: Record<string, unknown>): SubagentRequest {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new ApiError("spawn_subagent requires a non-empty prompt.", 400, "invalid_request_error");
  return {
    prompt,
    ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
    ...(typeof args.description === "string" ? { description: args.description } : {})
  };
}

function isEchoOfParent(prompt: string, conversation: PreparedConversation): boolean {
  const lastUser = [...conversation.messages].reverse().find((message) => message.role === "user")?.text ?? "";
  if (!lastUser.trim()) return false;
  return normalizeText(lastUser) === normalizeText(prompt);
}

function normalizeText(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ")).digest("hex");
}
