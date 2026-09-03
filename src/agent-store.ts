/**
 * Cursor SDK LocalAgentStore 注入点（local.store）。
 *
 * 生产用进程级有界 SQLite（createSqliteAgentStore）：一个 DatabaseSync 文件，
 * 路径由调用方传入（index.ts 用 dirname(sqlitePath)/agents.sqlite → compose 下 /data/agents.sqlite）。
 * 禁止 SDK 默认的 SqliteLocalAgentStore.open（每 agent 一份 store.db，实测残留 7~8 个句柄且 dispose 不释放），
 * 禁止 JsonlLocalAgentStore（按行追加 + 更新时全文件重写），禁止写进 state.sqlite（Connect 已对该文件另开连接）。
 *
 * createEphemeralAgentStore 仍导出：tests/server.test.ts 在用，语义保持 upsert + 有界内存。
 *
 * 网关始终注入 store（禁止 omit 后落到 SDK 每 agent SQLite）。kill switch 只改 TTL：
 * 打开 → 无参默认 10min/256；关闭 → CURSOR_SDK_SESSION_IDLE_TTL_MS / CURSOR_SDK_MAX_LIVE_SESSIONS。
 * 两层回收：闲置超时 + 超量 LRU，SQL DELETE 行，不关连接、不 unlink 每 agent 文件。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/** 与 SQLITE_PATH 同目录；compose 默认 SQLITE_PATH=/data/state.sqlite → /data/agents.sqlite。 */
export const AGENT_STORE_FILENAME = "agents.sqlite";

export type SqliteAgentStore = ReturnType<typeof createSqliteAgentStore>;

/**
 * 进程级有界 SQLite LocalAgentStore。一个连接贯穿进程生命周期，永不 per-agent open/close/unlink。
 */
export function createSqliteAgentStore(path: string, options?: EphemeralAgentStoreOptions) {
  const idleTtlMs = positiveBound(options?.idleTtlMs, STATELESS_AGENT_STORE_IDLE_TTL_MS);
  const maxAgents = positiveBound(options?.maxAgents, STATELESS_AGENT_STORE_MAX_AGENTS);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  } catch {
    // 内存库等场景不支持 WAL，忽略。
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      document_json TEXT,
      touched_at INTEGER NOT NULL,
      lru_seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_lru ON agents(lru_seq);
    CREATE INDEX IF NOT EXISTS idx_agents_touched ON agents(touched_at);

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      document_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);

    CREATE TABLE IF NOT EXISTS checkpoints (
      agent_id TEXT NOT NULL,
      blob_id TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (agent_id, blob_id)
    );

    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      offset TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      payload_ref TEXT,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_offset ON run_events(run_id, offset);

    CREATE TABLE IF NOT EXISTS run_event_meta (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT,
      touched_at INTEGER NOT NULL
    );
  `);

  let lruClock = Number(db.prepare("SELECT COALESCE(MAX(lru_seq), 0) AS n FROM agents").get()?.n ?? 0);
  let closed = false;

  const nextLru = (): number => {
    lruClock += 1;
    return lruClock;
  };

  const dropAgent = (agentId: string): void => {
    const runIds = new Set<string>();
    for (const row of db.prepare("SELECT run_id FROM runs WHERE agent_id = ?").all(agentId)) {
      if (typeof row.run_id === "string") runIds.add(row.run_id);
    }
    for (const row of db.prepare("SELECT run_id FROM run_event_meta WHERE agent_id = ?").all(agentId)) {
      if (typeof row.run_id === "string") runIds.add(row.run_id);
    }
    const deleteEvents = db.prepare("DELETE FROM run_events WHERE run_id = ?");
    const deleteMeta = db.prepare("DELETE FROM run_event_meta WHERE run_id = ?");
    for (const runId of runIds) {
      deleteEvents.run(runId);
      deleteMeta.run(runId);
    }
    db.prepare("DELETE FROM runs WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM checkpoints WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
  };

  const sweep = (): void => {
    const now = Date.now();
    const idleIds = db
      .prepare("SELECT agent_id FROM agents WHERE ? - touched_at >= ?")
      .all(now, idleTtlMs)
      .flatMap((row) => (typeof row.agent_id === "string" ? [row.agent_id] : []));
    for (const agentId of idleIds) dropAgent(agentId);

    for (;;) {
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n ?? 0);
      if (count < maxAgents) break;
      const oldest = db.prepare("SELECT agent_id FROM agents ORDER BY lru_seq ASC, agent_id ASC LIMIT 1").get();
      if (typeof oldest?.agent_id !== "string") break;
      dropAgent(oldest.agent_id);
    }

    const orphan = db
      .prepare("SELECT run_id FROM run_event_meta WHERE agent_id IS NULL AND ? - touched_at >= ?")
      .all(now, idleTtlMs);
    const deleteEvents = db.prepare("DELETE FROM run_events WHERE run_id = ?");
    const deleteMeta = db.prepare("DELETE FROM run_event_meta WHERE run_id = ?");
    for (const row of orphan) {
      if (typeof row.run_id !== "string") continue;
      deleteEvents.run(row.run_id);
      deleteMeta.run(row.run_id);
    }
  };

  const touch = (agentId: string): void => {
    const existing = db.prepare("SELECT 1 AS ok FROM agents WHERE agent_id = ?").get(agentId);
    const now = Date.now();
    const seq = nextLru();
    if (existing) {
      db.prepare("UPDATE agents SET touched_at = ?, lru_seq = ? WHERE agent_id = ?").run(now, seq, agentId);
      return;
    }
    sweep();
    db.prepare("INSERT INTO agents (agent_id, document_json, touched_at, lru_seq) VALUES (?, NULL, ?, ?)").run(
      agentId,
      now,
      seq
    );
  };

  const writeAgent = (agent: AgentDocument): AgentDocument => {
    touch(agent.agentId);
    db.prepare("UPDATE agents SET document_json = ? WHERE agent_id = ?").run(JSON.stringify(agent), agent.agentId);
    return agent;
  };

  const associateRun = (runId: string, agentId: string): void => {
    db.prepare(
      `INSERT INTO run_event_meta (run_id, agent_id, touched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET agent_id = excluded.agent_id`
    ).run(runId, agentId, Date.now());
  };

  const writeRun = (run: RunDocument): RunDocument => {
    touch(run.agentId);
    db.prepare(
      `INSERT INTO runs (run_id, agent_id, document_json)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET agent_id = excluded.agent_id, document_json = excluded.document_json`
    ).run(run.runId, run.agentId, JSON.stringify(run));
    associateRun(run.runId, run.agentId);
    return run;
  };

  const writeBlob = (agentId: string, blobId: string, data: Uint8Array): void => {
    touch(agentId);
    db.prepare(
      `INSERT INTO checkpoints (agent_id, blob_id, data)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id, blob_id) DO UPDATE SET data = excluded.data`
    ).run(agentId, blobId, data);
  };

  const agents = {
    async get(input: { agentId: string }): Promise<AgentDocument | null> {
      const row = db.prepare("SELECT document_json FROM agents WHERE agent_id = ?").get(input.agentId);
      return parseDocument<AgentDocument>(row?.document_json);
    },
    async create(input: { agent: AgentDocument }): Promise<AgentDocument> {
      return writeAgent(input.agent);
    },
    async update(input: { agent: AgentDocument }): Promise<AgentDocument> {
      return writeAgent(input.agent);
    },
    async delete(input: { filter: { agentIds?: readonly string[]; cwd?: string } }): Promise<void> {
      const rows = db.prepare("SELECT agent_id, document_json FROM agents").all();
      for (const row of rows) {
        if (typeof row.agent_id !== "string") continue;
        if (input.filter.agentIds?.length && !input.filter.agentIds.includes(row.agent_id)) continue;
        const agent = parseDocument<AgentDocument>(row.document_json);
        if (input.filter.cwd !== undefined && agent?.cwd !== input.filter.cwd) continue;
        dropAgent(row.agent_id);
      }
    },
    async list(input?: { filter?: { cursor?: string; limit?: number; cwd?: string } }): Promise<{ items: AgentDocument[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = db
        .prepare("SELECT document_json FROM agents")
        .all()
        .flatMap((row) => {
          const agent = parseDocument<AgentDocument>(row.document_json);
          return agent ? [agent] : [];
        })
        .filter((agent) => filter?.cwd === undefined || agent.cwd === filter.cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.agentId < b.agentId ? 1 : -1));
      return paginate(all, (agent) => agent.agentId, filter?.cursor, filter?.limit);
    }
  };

  const runs = {
    async get(input: { agentId: string; runId: string }): Promise<RunDocument | null> {
      const row = db
        .prepare("SELECT document_json FROM runs WHERE agent_id = ? AND run_id = ?")
        .get(input.agentId, input.runId);
      return parseDocument<RunDocument>(row?.document_json);
    },
    async create(input: { run: RunDocument }): Promise<RunDocument> {
      return writeRun(input.run);
    },
    async update(input: { run: RunDocument }): Promise<RunDocument> {
      return writeRun(input.run);
    },
    async delete(input: { filter: { agentIds?: readonly string[]; runIds?: readonly string[] } }): Promise<void> {
      const rows = db.prepare("SELECT run_id, agent_id FROM runs").all();
      const deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
      const deleteEvents = db.prepare("DELETE FROM run_events WHERE run_id = ?");
      const deleteMeta = db.prepare("DELETE FROM run_event_meta WHERE run_id = ?");
      for (const row of rows) {
        if (typeof row.run_id !== "string" || typeof row.agent_id !== "string") continue;
        if (input.filter.agentIds?.length && !input.filter.agentIds.includes(row.agent_id)) continue;
        if (input.filter.runIds?.length && !input.filter.runIds.includes(row.run_id)) continue;
        deleteEvents.run(row.run_id);
        deleteMeta.run(row.run_id);
        deleteRun.run(row.run_id);
      }
    },
    async list(input?: { filter?: { agentIds?: readonly string[]; runIds?: readonly string[]; cursor?: string; limit?: number } }): Promise<{ items: RunDocument[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = db
        .prepare("SELECT document_json FROM runs")
        .all()
        .flatMap((row) => {
          const run = parseDocument<RunDocument>(row.document_json);
          return run ? [run] : [];
        })
        .filter((run) =>
          (!filter?.agentIds?.length || filter.agentIds.includes(run.agentId)) &&
          (!filter?.runIds?.length || filter.runIds.includes(run.runId)))
        .sort((a, b) => a.turnNumber - b.turnNumber || (a.runId < b.runId ? -1 : 1));
      return paginate(all, (run) => run.runId, filter?.cursor, filter?.limit);
    }
  };

  const checkpoints = {
    async get(input: { agentId: string; blobId: string }): Promise<Uint8Array | null> {
      const row = db
        .prepare("SELECT data FROM checkpoints WHERE agent_id = ? AND blob_id = ?")
        .get(input.agentId, input.blobId);
      return row?.data === undefined || row.data === null ? null : asBytes(row.data);
    },
    async create(input: { agentId: string; blobId: string; data: Uint8Array }): Promise<void> {
      writeBlob(input.agentId, input.blobId, input.data);
    },
    async update(input: { agentId: string; blobId: string; data: Uint8Array }): Promise<void> {
      writeBlob(input.agentId, input.blobId, input.data);
    },
    async delete(input: { filter: { agentIds?: readonly string[]; blobIds?: readonly string[] } }): Promise<void> {
      const rows = db.prepare("SELECT agent_id, blob_id FROM checkpoints").all();
      const del = db.prepare("DELETE FROM checkpoints WHERE agent_id = ? AND blob_id = ?");
      for (const row of rows) {
        if (typeof row.agent_id !== "string" || typeof row.blob_id !== "string") continue;
        if (input.filter.agentIds?.length && !input.filter.agentIds.includes(row.agent_id)) continue;
        if (input.filter.blobIds?.length && !input.filter.blobIds.includes(row.blob_id)) continue;
        del.run(row.agent_id, row.blob_id);
      }
    },
    async list(input?: { filter?: { agentIds?: readonly string[]; blobIds?: readonly string[]; cursor?: string; limit?: number } }): Promise<{ items: string[]; nextCursor?: string }> {
      const filter = input?.filter;
      const all = db
        .prepare("SELECT agent_id, blob_id FROM checkpoints")
        .all()
        .flatMap((row) => {
          if (typeof row.agent_id !== "string" || typeof row.blob_id !== "string") return [];
          if (filter?.agentIds?.length && !filter.agentIds.includes(row.agent_id)) return [];
          if (filter?.blobIds?.length && !filter.blobIds.includes(row.blob_id)) return [];
          return [row.blob_id];
        })
        .sort();
      return paginate(all, (blobId) => blobId, filter?.cursor, filter?.limit);
    }
  };

  const runEventsStore = {
    async append(input: { runId: string; eventType: string; payload?: unknown; payloadRef?: string | null; idempotencyKey?: string | null }): Promise<RunEventDocument> {
      const run = db.prepare("SELECT agent_id FROM runs WHERE run_id = ?").get(input.runId);
      const knownAgent = typeof run?.agent_id === "string" ? run.agent_id : null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO run_event_meta (run_id, agent_id, touched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           touched_at = excluded.touched_at,
           agent_id = COALESCE(run_event_meta.agent_id, excluded.agent_id)`
      ).run(input.runId, knownAgent, now);
      const seq = Number(
        db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?").get(input.runId)?.n ?? 0
      ) + 1;
      const event: RunEventDocument = {
        runId: input.runId,
        seq,
        offset: String(seq).padStart(12, "0"),
        eventType: input.eventType,
        payload: input.payload,
        payloadRef: input.payloadRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now
      };
      db.prepare(
        `INSERT INTO run_events (run_id, seq, offset, event_type, payload_json, payload_ref, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.runId,
        event.seq,
        event.offset,
        event.eventType,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        event.payloadRef,
        event.idempotencyKey,
        event.createdAt
      );
      return event;
    },
    async list(input: { runId: string; afterOffset?: string | null; limit?: number }): Promise<{ items: RunEventDocument[]; nextOffset?: string }> {
      const after = input.afterOffset ?? "";
      const rows = db
        .prepare("SELECT * FROM run_events WHERE run_id = ? AND offset > ? ORDER BY offset ASC")
        .all(input.runId, after);
      const matched = rows.map(rowToRunEvent);
      const items = typeof input.limit === "number" && input.limit >= 0 ? matched.slice(0, input.limit) : matched;
      const last = items.at(-1);
      return last ? { items, nextOffset: last.offset } : { items };
    },
    async delete(input: { filter: { runIds?: readonly string[] } }): Promise<void> {
      const rows = db.prepare("SELECT run_id FROM run_event_meta").all();
      const eventRunIds = db.prepare("SELECT DISTINCT run_id FROM run_events").all();
      const ids = new Set<string>();
      for (const row of [...rows, ...eventRunIds]) {
        if (typeof row.run_id === "string") ids.add(row.run_id);
      }
      const deleteEvents = db.prepare("DELETE FROM run_events WHERE run_id = ?");
      const deleteMeta = db.prepare("DELETE FROM run_event_meta WHERE run_id = ?");
      for (const runId of ids) {
        if (input.filter.runIds?.length && !input.filter.runIds.includes(runId)) continue;
        deleteEvents.run(runId);
        deleteMeta.run(runId);
      }
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return { agents, runs, checkpoints, runEvents: runEventsStore, close };
}

function parseDocument<T>(json: unknown): T | null {
  if (typeof json !== "string" || !json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  return new Uint8Array();
}

function rowToRunEvent(row: Record<string, unknown>): RunEventDocument {
  return {
    runId: String(row.run_id),
    seq: Number(row.seq ?? 0),
    offset: String(row.offset ?? ""),
    eventType: String(row.event_type ?? ""),
    payload: row.payload_json == null ? undefined : JSON.parse(String(row.payload_json)),
    payloadRef: row.payload_ref === null || row.payload_ref === undefined ? null : String(row.payload_ref),
    idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
    createdAt: Number(row.created_at ?? 0)
  };
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
