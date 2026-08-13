import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CursorKeyPatch,
  CursorKeyRecord,
  RequestLogRecord,
  RequestLogStats,
  StateStore,
  StoredResponse
} from "./types.js";

const REQUEST_LOG_KEEP = 5000;
/** 每 N 条插入才跑一次日志裁剪，避免热路径上每条日志都带一次 OFFSET 全表扫描的 DELETE。 */
const REQUEST_LOG_CLEANUP_EVERY = 100;

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  private requestLogInsertCount = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // WAL 显著降低写入对读的阻塞；node:sqlite 是同步 API，写路径短暂阻塞事件循环，WAL 让它更短。
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    } catch {
      // 内存库等场景不支持 WAL，忽略。
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        owner_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        input_items_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_responses_owner_updated
      ON responses(owner_hash, updated_at DESC);

      CREATE TABLE IF NOT EXISTS cursor_keys (
        id TEXT PRIMARY KEY,
        api_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'manual',
        sort_order INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        disabled_at TEXT,
        last_used_at TEXT,
        last_error TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT,
        auth_mode TEXT NOT NULL,
        key_id TEXT,
        key_label TEXT,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts DESC);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateCursorKeyColumns();
    // 启动时先裁剪一次：cleanup 每 100 条才跑，计数器重启归零后历史积压需要这里兜底。
    this.trimRequestLogs();
  }

  private trimRequestLogs(): void {
    this.db
      .prepare(
        `DELETE FROM request_logs WHERE id IN (
           SELECT id FROM request_logs ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(REQUEST_LOG_KEEP);
  }

  /** 老库升级：补后加的列。sort_order 按原插入顺序（rowid）回填，保持既有取用顺序不变。 */
  private migrateCursorKeyColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(cursor_keys)").all() as { name?: unknown }[])
        .map((column) => String(column.name))
    );
    if (!columns.has("sort_order")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("UPDATE cursor_keys SET sort_order = rowid WHERE sort_order = 0");
    if (!columns.has("failure_count")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  async getSession(id: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT agent_id FROM sdk_sessions WHERE id = ? LIMIT 1").get(id);
    return typeof row?.agent_id === "string" ? row.agent_id : undefined;
  }

  async saveSession(id: string, agentId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sdk_sessions (id, agent_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`
      )
      .run(id, agentId, now);
  }

  async deleteSession(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM sdk_sessions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async saveResponse(record: StoredResponse): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO responses (id, owner_hash, response_json, input_items_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_hash = excluded.owner_hash,
           response_json = excluded.response_json,
           input_items_json = excluded.input_items_json,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.ownerHash,
        JSON.stringify(record.response),
        JSON.stringify(record.inputItems),
        record.createdAt,
        record.updatedAt
      );
  }

  async getResponse(id: string, ownerHash: string): Promise<StoredResponse | undefined> {
    const row = this.db
      .prepare("SELECT * FROM responses WHERE id = ? AND owner_hash = ? LIMIT 1")
      .get(id, ownerHash);
    if (!row) return undefined;
    return {
      id: String(row.id),
      ownerHash: String(row.owner_hash),
      response: parseJsonObject(row.response_json),
      inputItems: parseJsonArray(row.input_items_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  async deleteResponse(id: string, ownerHash: string): Promise<boolean> {
    const existing = await this.getResponse(id, ownerHash);
    if (!existing) return false;
    this.db.prepare("DELETE FROM responses WHERE id = ? AND owner_hash = ?").run(id, ownerHash);
    return true;
  }

  async listCursorKeys(): Promise<CursorKeyRecord[]> {
    const rows = this.db.prepare("SELECT * FROM cursor_keys ORDER BY sort_order ASC, rowid ASC").all();
    return rows.map(rowToKey);
  }

  async getCursorKeyByValue(apiKey: string): Promise<CursorKeyRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM cursor_keys WHERE api_key = ? LIMIT 1").get(apiKey);
    return row ? rowToKey(row) : undefined;
  }

  async insertCursorKey(record: CursorKeyRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO cursor_keys (id, api_key, label, status, source, sort_order, disabled_reason, disabled_at, last_used_at, last_error, request_count, failure_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.apiKey,
        record.label,
        record.status,
        record.source,
        record.sortOrder,
        record.disabledReason ?? null,
        record.disabledAt ?? null,
        record.lastUsedAt ?? null,
        record.lastError ?? null,
        record.requestCount,
        record.failureCount,
        record.createdAt
      );
  }

  async updateCursorKey(id: string, patch: CursorKeyPatch): Promise<boolean> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.label !== undefined) {
      sets.push("label = ?");
      values.push(patch.label);
    }
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      values.push(patch.sortOrder);
    }
    if (patch.disabledReason !== undefined) {
      sets.push("disabled_reason = ?");
      values.push(patch.disabledReason);
    }
    if (patch.disabledAt !== undefined) {
      sets.push("disabled_at = ?");
      values.push(patch.disabledAt);
    }
    if (patch.lastUsedAt !== undefined) {
      sets.push("last_used_at = ?");
      values.push(patch.lastUsedAt);
    }
    if (patch.lastError !== undefined) {
      sets.push("last_error = ?");
      values.push(patch.lastError);
    }
    if (patch.failureCount !== undefined) {
      sets.push("failure_count = ?");
      values.push(patch.failureCount);
    }
    if (patch.incrementRequestCount) {
      sets.push("request_count = request_count + 1");
    }
    if (patch.incrementFailureCount) {
      sets.push("failure_count = failure_count + 1");
    }
    if (!sets.length) return false;
    const result = this.db
      .prepare(`UPDATE cursor_keys SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return Number(result.changes) > 0;
  }

  async deleteCursorKey(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM cursor_keys WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async reorderCursorKeys(ids: string[]): Promise<void> {
    const ordered = resolveKeyOrder(await this.listCursorKeys(), ids);
    const update = this.db.prepare("UPDATE cursor_keys SET sort_order = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      ordered.forEach((keyId, index) => update.run(index + 1, keyId));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1").get(key);
    return typeof row?.value === "string" ? row.value : undefined;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  async insertRequestLog(record: RequestLogRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO request_logs (id, ts, endpoint, model, auth_mode, key_id, key_label, status, duration_ms, stream, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.ts,
        record.endpoint,
        record.model ?? null,
        record.authMode,
        record.keyId ?? null,
        record.keyLabel ?? null,
        record.status,
        record.durationMs,
        record.stream ? 1 : 0,
        record.error ?? null
      );
    this.requestLogInsertCount += 1;
    if (this.requestLogInsertCount % REQUEST_LOG_CLEANUP_EVERY === 0) {
      this.trimRequestLogs();
    }
  }

  async listRequestLogs(limit: number): Promise<RequestLogRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM request_logs ORDER BY ts DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500)));
    return rows.map(rowToLog);
  }

  async requestLogStats(): Promise<RequestLogStats> {
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END), 0) AS success,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
                AVG(duration_ms) AS avg_duration
         FROM request_logs`
      )
      .get();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
         FROM request_logs WHERE ts >= ?`
      )
      .get(dayAgo);
    return {
      total: Number(total?.total ?? 0),
      success: Number(total?.success ?? 0),
      errors: Number(total?.errors ?? 0),
      avgDurationMs: total?.avg_duration === null || total?.avg_duration === undefined
        ? null
        : Math.round(Number(total.avg_duration)),
      last24h: {
        total: Number(recent?.total ?? 0),
        errors: Number(recent?.errors ?? 0)
      }
    };
  }
}

export class MemoryStateStore implements StateStore {
  readonly sessions = new Map<string, string>();
  readonly responses = new Map<string, StoredResponse>();
  readonly cursorKeys: CursorKeyRecord[] = [];
  readonly requestLogs: RequestLogRecord[] = [];
  readonly settings = new Map<string, string>();

  async getSession(id: string): Promise<string | undefined> {
    return this.sessions.get(id);
  }

  async saveSession(id: string, agentId: string): Promise<void> {
    this.sessions.set(id, agentId);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async saveResponse(record: StoredResponse): Promise<void> {
    this.responses.set(`${record.ownerHash}:${record.id}`, record);
  }

  async getResponse(id: string, ownerHash: string): Promise<StoredResponse | undefined> {
    return this.responses.get(`${ownerHash}:${id}`);
  }

  async deleteResponse(id: string, ownerHash: string): Promise<boolean> {
    return this.responses.delete(`${ownerHash}:${id}`);
  }

  async listCursorKeys(): Promise<CursorKeyRecord[]> {
    return this.cursorKeys
      .map((key, index) => ({ key, index }))
      .sort((a, b) => a.key.sortOrder - b.key.sortOrder || a.index - b.index)
      .map((item) => ({ ...item.key }));
  }

  async getCursorKeyByValue(apiKey: string): Promise<CursorKeyRecord | undefined> {
    const found = this.cursorKeys.find((key) => key.apiKey === apiKey);
    return found ? { ...found } : undefined;
  }

  async insertCursorKey(record: CursorKeyRecord): Promise<void> {
    this.cursorKeys.push({ ...record });
  }

  async updateCursorKey(id: string, patch: CursorKeyPatch): Promise<boolean> {
    const key = this.cursorKeys.find((item) => item.id === id);
    if (!key) return false;
    if (patch.status !== undefined) key.status = patch.status;
    if (patch.label !== undefined) key.label = patch.label;
    if (patch.sortOrder !== undefined) key.sortOrder = patch.sortOrder;
    if (patch.disabledReason !== undefined) key.disabledReason = patch.disabledReason ?? undefined;
    if (patch.disabledAt !== undefined) key.disabledAt = patch.disabledAt ?? undefined;
    if (patch.lastUsedAt !== undefined) key.lastUsedAt = patch.lastUsedAt;
    if (patch.lastError !== undefined) key.lastError = patch.lastError ?? undefined;
    if (patch.failureCount !== undefined) key.failureCount = patch.failureCount;
    if (patch.incrementRequestCount) key.requestCount += 1;
    if (patch.incrementFailureCount) key.failureCount += 1;
    return true;
  }

  async deleteCursorKey(id: string): Promise<boolean> {
    const index = this.cursorKeys.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.cursorKeys.splice(index, 1);
    return true;
  }

  async reorderCursorKeys(ids: string[]): Promise<void> {
    const ordered = resolveKeyOrder(await this.listCursorKeys(), ids);
    ordered.forEach((keyId, index) => {
      const key = this.cursorKeys.find((item) => item.id === keyId);
      if (key) key.sortOrder = index + 1;
    });
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async insertRequestLog(record: RequestLogRecord): Promise<void> {
    this.requestLogs.push({ ...record });
  }

  async listRequestLogs(limit: number): Promise<RequestLogRecord[]> {
    return [...this.requestLogs]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async requestLogStats(): Promise<RequestLogStats> {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = this.requestLogs.filter((log) => log.ts >= dayAgo);
    const errors = this.requestLogs.filter((log) => log.status >= 400).length;
    const avg = this.requestLogs.length
      ? Math.round(this.requestLogs.reduce((sum, log) => sum + log.durationMs, 0) / this.requestLogs.length)
      : null;
    return {
      total: this.requestLogs.length,
      success: this.requestLogs.length - errors,
      errors,
      avgDurationMs: avg,
      last24h: {
        total: recent.length,
        errors: recent.filter((log) => log.status >= 400).length
      }
    };
  }
}

/** 计算重排后的完整 id 序列：先按传入顺序，库里未提及的 key 维持原相对顺序排在末尾。 */
function resolveKeyOrder(existing: CursorKeyRecord[], ids: string[]): string[] {
  const known = new Set(existing.map((key) => key.id));
  const ordered = [...new Set(ids)].filter((id) => known.has(id));
  for (const key of existing) {
    if (!ordered.includes(key.id)) ordered.push(key.id);
  }
  return ordered;
}

function rowToKey(row: Record<string, unknown>): CursorKeyRecord {
  return {
    id: String(row.id),
    apiKey: String(row.api_key),
    label: String(row.label),
    status: row.status === "disabled" ? "disabled" : "active",
    source: row.source === "env" ? "env" : "manual",
    sortOrder: Number(row.sort_order ?? 0),
    disabledReason: optional(row.disabled_reason),
    disabledAt: optional(row.disabled_at),
    lastUsedAt: optional(row.last_used_at),
    lastError: optional(row.last_error),
    requestCount: Number(row.request_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    createdAt: String(row.created_at)
  };
}

function rowToLog(row: Record<string, unknown>): RequestLogRecord {
  return {
    id: String(row.id),
    ts: String(row.ts),
    endpoint: String(row.endpoint),
    model: optional(row.model),
    authMode: row.auth_mode === "direct" ? "direct" : row.auth_mode === "admin" ? "admin" : "gateway",
    keyId: optional(row.key_id),
    keyLabel: optional(row.key_label),
    status: Number(row.status ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    stream: Number(row.stream ?? 0) === 1,
    error: optional(row.error)
  };
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}
