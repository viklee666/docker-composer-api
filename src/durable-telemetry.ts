/**
 * durable 会话决策与缓存命中的进程内计数器。
 *
 * 存在的理由只有一个：线上出问题时**不能**要求运维去翻 stdout。
 * 三套端点在 finishLog 时把用量喂进来，runner 在每个岔路口喂一条决策，
 * `/health` 与 `/admin/api/overview` 直接把快照吐出来——一次 curl 就能回答
 * 「durable 到底有没有生效」「是不是每轮都在换 agent」「缓存命中率是多少」。
 *
 * 只记结构化标签与数字：会话 id 一律截断成前 12 位（与 `[durable]` 日志同口径），
 * 绝不落任何提示词、密钥或模型输出。
 */

/** 快照里保留最近多少条决策：够看清一段对话的走向，又不会把内存吃掉。 */
export const RECENT_DECISION_LIMIT = 50;

/**
 * - `create` 首轮新建 agent；`reuse` 命中活槽（缓存最好的那条路）
 * - `resume` 重启后续上落库的 agentId；`recreate` 丢弃旧槽重建（reason 说明为什么）
 * - `fallback` durable 中途放弃、退回整段 flatten；`stateless` 压根没进 durable
 */
export type DurableDecisionKind = "create" | "reuse" | "resume" | "recreate" | "fallback" | "stateless";

export type DurableIdentitySource = "header" | "body-field" | "derived-L3" | "none";

export interface DurableDecisionInput {
  decision: DurableDecisionKind;
  /** drop / fallback / stateless 的具体原因，进 counters 的二级键。 */
  reason?: string;
  /** durableSessionId 前 12 位；认不出会话时为 undefined。 */
  session?: string;
  /** 本轮增量类型（new_user / tool_results / incompatible / empty）。 */
  kind?: string;
  /** 记录时 Hub 里的活槽数。 */
  liveSessions?: number;
}

export interface DurableDecisionRecord extends DurableDecisionInput {
  at: string;
}

export interface DurableCacheTotals {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite)，与计划 §6.2 同口径；无样本时为 null。 */
  hitRatio: number | null;
}

export interface DurableTelemetrySnapshot {
  liveSessions: number;
  decisions: Record<string, number>;
  cache: DurableCacheTotals;
  recent: DurableDecisionRecord[];
  identitySource: Record<string, number>;
}

interface TelemetryState {
  decisions: Record<string, number>;
  identitySource: Record<DurableIdentitySource, number>;
  recent: DurableDecisionRecord[];
  cache: Omit<DurableCacheTotals, "hitRatio">;
  lastLiveSessions: number;
}

function emptyIdentitySource(): Record<DurableIdentitySource, number> {
  return { header: 0, "body-field": 0, "derived-L3": 0, none: 0 };
}

function emptyState(): TelemetryState {
  return {
    decisions: {},
    identitySource: emptyIdentitySource(),
    recent: [],
    cache: {
      requests: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0
    },
    lastLiveSessions: 0
  };
}

let state = emptyState();

function truncateSession(session: string | undefined): string | undefined {
  if (!session) return undefined;
  return session.slice(0, 12);
}

function hitRatioOf(cache: Omit<DurableCacheTotals, "hitRatio">): number | null {
  const denominator = cache.inputTokens + cache.cacheReadTokens + cache.cacheWriteTokens;
  if (denominator <= 0) return null;
  return cache.cacheReadTokens / denominator;
}

export function recordDurableDecision(input: DurableDecisionInput): void {
  const key = input.decision;
  state.decisions[key] = (state.decisions[key] ?? 0) + 1;
  if (input.reason) {
    const nested = `${input.decision}:${input.reason}`;
    state.decisions[nested] = (state.decisions[nested] ?? 0) + 1;
  }
  if (input.liveSessions !== undefined) state.lastLiveSessions = input.liveSessions;
  const session = truncateSession(input.session);
  const record: DurableDecisionRecord = {
    decision: input.decision,
    at: new Date().toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(session ? { session } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.liveSessions !== undefined ? { liveSessions: input.liveSessions } : {})
  };
  state.recent.push(record);
  if (state.recent.length > RECENT_DECISION_LIMIT) state.recent.shift();
}

export function recordDurableCache(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}): void {
  state.cache.requests += 1;
  state.cache.inputTokens += usage.inputTokens;
  state.cache.cacheReadTokens += usage.cacheReadTokens;
  state.cache.cacheWriteTokens += usage.cacheWriteTokens;
  state.cache.outputTokens += usage.outputTokens;
}

export function recordIdentitySource(source: DurableIdentitySource): void {
  state.identitySource[source] += 1;
}

export function durableTelemetrySnapshot(liveSessions?: number): DurableTelemetrySnapshot {
  return {
    liveSessions: liveSessions ?? state.lastLiveSessions,
    decisions: { ...state.decisions },
    cache: {
      ...state.cache,
      hitRatio: hitRatioOf(state.cache)
    },
    recent: state.recent.map((item) => ({ ...item })),
    identitySource: { ...state.identitySource }
  };
}

/** 单测隔离用：计数器是进程内单例，用例之间必须清零。 */
export function resetDurableTelemetry(): void {
  state = emptyState();
}
