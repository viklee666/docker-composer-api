/**
 * 有界内存版 Cursor SDK LocalAgentStore（对接 @cursor/sdk 的 local.store 注入点）。
 *
 * 为什么需要它：SDK 默认的 SqliteLocalAgentStore 是"每个 Agent.create 各开一份"的生命周期，
 * 实测每个 agent 会残留约 7~8 个内核句柄且 dispose 后不释放（Windows/Linux fd 同理），
 * 网关"每请求 fresh agent"的用法会让句柄随请求数线性增长，长期运行后拖垮进程。
 * SDK 自带的 JsonlLocalAgentStore 虽可全局共享，但按行追加 + 更新时全文件重写，
 * 高流量下磁盘无限增长且重写成本随历史线性上升，同样是慢性死亡。
 *
 * 网关始终注入这一份共享内存 store（禁止 omit 后落到 SDK 每 agent SQLite）。
 * kill switch 打开（CURSOR_SDK_DISABLE_SESSION_RESUME=true）：agent 记录只在单次请求内有意义，
 * idle TTL 用无参默认 10 分钟。durable 默认把 idle TTL 拉长到 CURSOR_SDK_SESSION_IDLE_TTL_MS（60min）。
 * 两层回收：闲置超时清理 + 超量 LRU。进程重启后内存 checkpoint 丢失，下一请求 fresh create（可接受）。
 */

interface AgentDocument {
  readonly agentId: string;
  readonly cwd: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly [key: string]: unknown;
}

interface RunDocument {
  readonly runId: string;
  readonly agentId: string;
  readonly turnNumber: number;
  readonly [key: string]: unknown;
}

interface RunEventDocument {
  readonly runId: string;
  readonly seq: number;
  readonly offset: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly payloadRef: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: number;
}

interface AgentBucket {
  agent: AgentDocument | undefined;
  readonly runs: Map<string, RunDocument>;
  readonly blobs: Map<string, Uint8Array>;
  touchedAt: number;
}

interface RunEventBucket {
  agentId: string | undefined;
  seq: number;
  readonly events: RunEventDocument[];
  touchedAt: number;
}

/** 同时保留的 agent 桶上限（须远大于网关的实际并发请求数）。 */
export const STATELESS_AGENT_STORE_MAX_AGENTS = 256;
/** 闲置桶回收阈值：stateless 请求几秒内结束，10 分钟足够覆盖最长的流式响应。 */
export const STATELESS_AGENT_STORE_IDLE_TTL_MS = 10 * 60 * 1000;

export type EphemeralAgentStore = ReturnType<typeof createEphemeralAgentStore>;

export interface EphemeralAgentStoreOptions {
  /** 闲置超过该毫秒数的桶在下次插入时回收。默认 10min（stateless）。 */
  idleTtlMs?: number;
  /** 桶数量上限，超出按 LRU 淘汰。默认 256。 */
  maxAgents?: number;
}

export function createEphemeralAgentStore(options?: EphemeralAgentStoreOptions) {
  const idleTtlMs = positiveBound(options?.idleTtlMs, STATELESS_AGENT_STORE_IDLE_TTL_MS);
  const maxAgents = positiveBound(options?.maxAgents, STATELESS_AGENT_STORE_MAX_AGENTS);
  const buckets = new Map<string, AgentBucket>();
  const runEvents = new Map<string, RunEventBucket>();
  const runToAgent = new Map<string, string>();

  const touch = (agentId: string): AgentBucket => {
    let bucket = buckets.get(agentId);
    if (bucket) {
      // Map 重插维持 LRU 顺序（最新的在尾部）。
      buckets.delete(agentId);
    } else {
      bucket = { agent: undefined, runs: new Map(), blobs: new Map(), touchedAt: 0 };
      sweep();
    }
    bucket.touchedAt = Date.now();
    buckets.set(agentId, bucket);
    return bucket;
  };

  const dropAgent = (agentId: string): void => {
    const bucket = buckets.get(agentId);
    if (!bucket) return;
    buckets.delete(agentId);
    for (const runId of bucket.runs.keys()) {
      runEvents.delete(runId);
      runToAgent.delete(runId);
    }
  };

  const sweep = (): void => {
    const now = Date.now();
    for (const [agentId, bucket] of buckets) {
      if (now - bucket.touchedAt >= idleTtlMs) dropAgent(agentId);
    }
    while (buckets.size >= maxAgents) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      dropAgent(oldest);
    }
    // 极端情况下（run 未关联到已知 agent）孤儿事件桶也按同样的闲置阈值回收。
    for (const [runId, bucket] of runEvents) {
      if (bucket.agentId === undefined && now - bucket.touchedAt >= idleTtlMs) {
        runEvents.delete(runId);
        runToAgent.delete(runId);
      }
    }
  };

  const eventBucket = (runId: string): RunEventBucket => {
    let bucket = runEvents.get(runId);
    if (!bucket) {
      bucket = { agentId: runToAgent.get(runId), seq: 0, events: [], touchedAt: 0 };
      runEvents.set(runId, bucket);
    }
    bucket.touchedAt = Date.now();
    return bucket;
  };

  const agents = {
    async get(input: { agentId: string }): Promise<AgentDocument | null> {
      return buckets.get(input.agentId)?.agent ?? null;
    },
    async create(input: { agent: AgentDocument }): Promise<AgentDocument> {
      touch(input.agent.agentId).agent = input.agent;
      return input.agent;
    },
    // update 按 upsert 处理：桶被回收后 SDK 的状态更新不应报错。
    async update(input: { agent: AgentDocument }): Promise<AgentDocument> {
      touch(input.agent.agentId).agent = input.agent;
      return input.agent;
    },
    async delete(input: { filter: { agentIds?: readonly string[]; cwd?: string } }): Promise<void> {
      for (const [agentId, bucket] of [...buckets]) {
        if (input.filter.agentIds?.length && !input.filter.agentIds.includes(agentId)) continue;
        if (input.filter.cwd !== undefined && bucket.agent?.cwd !== input.filter.cwd) continue;
        dropAgent(agentId);
      }
    },
    async list(input?: { filter?: { cursor?: string; limit?: number; cwd?: string } }): Promise<{ items: AgentDocument[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = [...buckets.values()]
        .flatMap((bucket) => (bucket.agent ? [bucket.agent] : []))
        .filter((agent) => filter?.cwd === undefined || agent.cwd === filter.cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.agentId < b.agentId ? 1 : -1));
      return paginate(all, (agent) => agent.agentId, filter?.cursor, filter?.limit);
    }
  };

  const runs = {
    async get(input: { agentId: string; runId: string }): Promise<RunDocument | null> {
      return buckets.get(input.agentId)?.runs.get(input.runId) ?? null;
    },
    async create(input: { run: RunDocument }): Promise<RunDocument> {
      touch(input.run.agentId).runs.set(input.run.runId, input.run);
      runToAgent.set(input.run.runId, input.run.agentId);
      const bucket = runEvents.get(input.run.runId);
      if (bucket) bucket.agentId = input.run.agentId;
      return input.run;
    },
    async update(input: { run: RunDocument }): Promise<RunDocument> {
      touch(input.run.agentId).runs.set(input.run.runId, input.run);
      runToAgent.set(input.run.runId, input.run.agentId);
      return input.run;
    },
    async delete(input: { filter: { agentIds?: readonly string[]; runIds?: readonly string[] } }): Promise<void> {
      for (const bucket of buckets.values()) {
        for (const [runId, run] of [...bucket.runs]) {
          if (input.filter.agentIds?.length && !input.filter.agentIds.includes(run.agentId)) continue;
          if (input.filter.runIds?.length && !input.filter.runIds.includes(runId)) continue;
          bucket.runs.delete(runId);
          runEvents.delete(runId);
          runToAgent.delete(runId);
        }
      }
    },
    async list(input?: { filter?: { agentIds?: readonly string[]; runIds?: readonly string[]; cursor?: string; limit?: number } }): Promise<{ items: RunDocument[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = [...buckets.values()]
        .flatMap((bucket) => [...bucket.runs.values()])
        .filter((run) =>
          (!filter?.agentIds?.length || filter.agentIds.includes(run.agentId)) &&
          (!filter?.runIds?.length || filter.runIds.includes(run.runId)))
        .sort((a, b) => a.turnNumber - b.turnNumber || (a.runId < b.runId ? -1 : 1));
      return paginate(all, (run) => run.runId, filter?.cursor, filter?.limit);
    }
  };

  const checkpoints = {
    async get(input: { agentId: string; blobId: string }): Promise<Uint8Array | null> {
      return buckets.get(input.agentId)?.blobs.get(input.blobId) ?? null;
    },
    async create(input: { agentId: string; blobId: string; data: Uint8Array }): Promise<void> {
      touch(input.agentId).blobs.set(input.blobId, input.data);
    },
    async update(input: { agentId: string; blobId: string; data: Uint8Array }): Promise<void> {
      touch(input.agentId).blobs.set(input.blobId, input.data);
    },
    async delete(input: { filter: { agentIds?: readonly string[]; blobIds?: readonly string[] } }): Promise<void> {
      for (const [agentId, bucket] of buckets) {
        if (input.filter.agentIds?.length && !input.filter.agentIds.includes(agentId)) continue;
        for (const blobId of [...bucket.blobs.keys()]) {
          if (input.filter.blobIds?.length && !input.filter.blobIds.includes(blobId)) continue;
          bucket.blobs.delete(blobId);
        }
      }
    },
    async list(input?: { filter?: { agentIds?: readonly string[]; blobIds?: readonly string[]; cursor?: string; limit?: number } }): Promise<{ items: string[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = [...buckets.entries()]
        .filter(([agentId]) => !filter?.agentIds?.length || filter.agentIds.includes(agentId))
        .flatMap(([, bucket]) => [...bucket.blobs.keys()])
        .filter((blobId) => !filter?.blobIds?.length || filter.blobIds.includes(blobId))
        .sort();
      return paginate(all, (blobId) => blobId, filter?.cursor, filter?.limit);
    }
  };

  const runEventsStore = {
    async append(input: { runId: string; eventType: string; payload?: unknown; payloadRef?: string | null; idempotencyKey?: string | null }): Promise<RunEventDocument> {
      const bucket = eventBucket(input.runId);
      bucket.seq += 1;
      const event: RunEventDocument = {
        runId: input.runId,
        seq: bucket.seq,
        // offset 是不透明字符串；固定宽度十进制保证字典序 == 数值序。
        offset: String(bucket.seq).padStart(12, "0"),
        eventType: input.eventType,
        payload: input.payload,
        payloadRef: input.payloadRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: Date.now()
      };
      bucket.events.push(event);
      return event;
    },
    async list(input: { runId: string; afterOffset?: string | null; limit?: number }): Promise<{ items: RunEventDocument[]; nextOffset?: string }> {
      const bucket = runEvents.get(input.runId);
      if (!bucket) return { items: [] };
      const after = input.afterOffset ?? "";
      const matched = bucket.events.filter((event) => event.offset > after);
      const items = typeof input.limit === "number" && input.limit >= 0 ? matched.slice(0, input.limit) : matched;
      const last = items.at(-1);
      return last ? { items, nextOffset: last.offset } : { items };
    },
    async delete(input: { filter: { runIds?: readonly string[] } }): Promise<void> {
      for (const runId of [...runEvents.keys()]) {
        if (input.filter.runIds?.length && !input.filter.runIds.includes(runId)) continue;
        runEvents.delete(runId);
        runToAgent.delete(runId);
      }
    }
  };

  return { agents, runs, checkpoints, runEvents: runEventsStore };
}

function positiveBound(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function paginate<T>(items: T[], idOf: (item: T) => string, cursor?: string, limit?: number): { items: T[]; nextCursor?: string } {
  let start = 0;
  if (cursor) {
    const index = items.findIndex((item) => idOf(item) === cursor);
    if (index >= 0) start = index + 1;
  }
  const page = typeof limit === "number" && limit >= 0 ? items.slice(start, start + limit) : items.slice(start);
  const hasMore = start + page.length < items.length;
  const last = page.at(-1);
  return hasMore && last ? { items: page, nextCursor: idOf(last) } : { items: page };
}
