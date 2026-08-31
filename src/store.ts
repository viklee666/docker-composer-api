import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NO_KEY_SENTINEL } from "./routing.js";
import type {
  CursorKeyPatch,
  CursorKeyRecord,
  EffectiveParamField,
  GatewayKeyPatch,
  GatewayKeyRecord,
  ModelScope,
  RequestCost,
  RequestLogPage,
  RequestLogQuery,
  RequestLogRecord,
  RequestLogStats,
  RequestUsage,
  SessionBinding,
  StateStore,
  StoredResponse
} from "./types.js";

/**
 * 请求日志默认保留条数，0 = 不裁剪。
 * 后台要按推理强度/用量/花费做长期用量核对，任何固定上限都会在高频使用下悄悄吃掉早期数据，
 * 所以默认全量保留；磁盘吃不消的部署用 REQUEST_LOG_KEEP 自己设上限。
 */
export const DEFAULT_REQUEST_LOG_KEEP = 0;
/** 每 N 条插入才跑一次日志裁剪，避免热路径上每条日志都带一次 OFFSET 全表扫描的 DELETE。 */
const REQUEST_LOG_CLEANUP_EVERY = 100;
/** 单页返回上限：分页由 offset 承担，单页再大只会把后台页面拖慢。 */
const REQUEST_LOG_PAGE_MAX = 1000;

export interface SqliteStoreOptions {
  /** 请求日志保留条数，0 / 缺省表示不裁剪（自行承担增长）。 */
  requestLogKeep?: number;
}

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  private readonly requestLogKeep: number;
  private requestLogInsertCount = 0;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.requestLogKeep = normalizeKeep(options.requestLogKeep);
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
        conversation_seed TEXT,
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
        client_type TEXT NOT NULL DEFAULT 'inherit',
        allowed_models TEXT,
        excluded_models TEXT,
        weight INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_keys (
        id TEXT PRIMARY KEY,
        api_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'manual',
        allowed_cursor_key_ids TEXT,
        allowed_models TEXT,
        excluded_models TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_bindings (
        session_hash TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_bindings_updated
      ON session_bindings(updated_at DESC);

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
        error TEXT,
        gateway_key_id TEXT,
        gateway_key_label TEXT,
        reasoning_effort TEXT,
        max_mode INTEGER,
        fast INTEGER,
        effective_params TEXT,
        client_type TEXT,
        agent_mode TEXT,
        model_params TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        usage_source TEXT,
        raw_cost_cents REAL,
        charged_cents REAL
      );

      CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_request_logs_key ON request_logs(key_id, ts DESC);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_usage_baselines (
        agent_id TEXT PRIMARY KEY,
        raw_cost_cents REAL NOT NULL DEFAULT 0,
        charged_cents REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        raw_regression_count INTEGER NOT NULL DEFAULT 0,
        raw_regression_last REAL,
        charged_regression_count INTEGER NOT NULL DEFAULT 0,
        charged_regression_last REAL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_usage_baselines_updated
      ON agent_usage_baselines(updated_at);
    `);
    this.migrateCursorKeyColumns();
    this.migrateRequestLogColumns();
    this.migrateResponseColumns();
    this.migrateAgentUsageBaselineColumns();
    // 启动时先裁剪一次：cleanup 每 100 条才跑，计数器重启归零后历史积压需要这里兜底。
    this.trimRequestLogs();
  }

  private trimRequestLogs(): void {
    if (!this.requestLogKeep) return;
    this.db
      .prepare(
        `DELETE FROM request_logs WHERE id IN (
           SELECT id FROM request_logs ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(this.requestLogKeep);
  }

  private columnNames(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
    return new Set(rows.map((column) => String(column.name)));
  }

  /** 老库升级：补后加的列。sort_order 按原插入顺序（rowid）回填，保持既有取用顺序不变。 */
  private migrateCursorKeyColumns(): void {
    const columns = this.columnNames("cursor_keys");
    if (!columns.has("sort_order")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("UPDATE cursor_keys SET sort_order = rowid WHERE sort_order = 0");
    if (!columns.has("failure_count")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("client_type")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN client_type TEXT NOT NULL DEFAULT 'inherit'");
    }
    if (!columns.has("allowed_models")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN allowed_models TEXT");
    }
    if (!columns.has("excluded_models")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN excluded_models TEXT");
    }
    if (!columns.has("weight")) {
      this.db.exec("ALTER TABLE cursor_keys ADD COLUMN weight INTEGER NOT NULL DEFAULT 1");
    }
  }

  /**
   * 老库升级：请求日志补上参数快照与用量列。
   * 全部可空，老记录读出来就是 undefined，后台按「上游未上报」展示。
   */
  private migrateRequestLogColumns(): void {
    const columns = this.columnNames("request_logs");
    const added: [string, string][] = [
      ["gateway_key_id", "TEXT"],
      ["gateway_key_label", "TEXT"],
      ["reasoning_effort", "TEXT"],
      ["max_mode", "INTEGER"],
      ["fast", "INTEGER"],
      ["effective_params", "TEXT"],
      ["client_type", "TEXT"],
      ["agent_mode", "TEXT"],
      ["model_params", "TEXT"],
      ["input_tokens", "INTEGER"],
      ["output_tokens", "INTEGER"],
      ["cache_read_tokens", "INTEGER"],
      ["cache_write_tokens", "INTEGER"],
      ["reasoning_tokens", "INTEGER"],
      ["total_tokens", "INTEGER"],
      ["usage_source", "TEXT"],
      ["raw_cost_cents", "REAL"],
      ["charged_cents", "REAL"]
    ];
    for (const [name, type] of added) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${type}`);
    }
    // 旧版本只有真实 usage 才会填 token 列；迁移时把这类无来源记录归为 sdk，避免升级后统计凭空归零。
    this.db.exec("UPDATE request_logs SET usage_source = 'sdk' WHERE usage_source IS NULL AND total_tokens IS NOT NULL");
  }

  /**
   * 老库升级：responses 补会话种子列。可空，老记录读出来是 undefined，
   * 续聊时退回按请求体现算——认不出对话就不启用粘性，不会因为缺列而报错。
   */
  private migrateResponseColumns(): void {
    if (!this.columnNames("responses").has("conversation_seed")) {
      this.db.exec("ALTER TABLE responses ADD COLUMN conversation_seed TEXT");
    }
  }

  /** 老库升级：保留旧版本的回退观测列；累计接口无法可靠确认 reset，现行记账逻辑不依赖这些列。 */
  private migrateAgentUsageBaselineColumns(): void {
    const columns = this.columnNames("agent_usage_baselines");
    const added: [string, string][] = [
      ["raw_regression_count", "INTEGER NOT NULL DEFAULT 0"],
      ["raw_regression_last", "REAL"],
      ["charged_regression_count", "INTEGER NOT NULL DEFAULT 0"],
      ["charged_regression_last", "REAL"]
    ];
    for (const [name, type] of added) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_usage_baselines ADD COLUMN ${name} ${type}`);
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
        `INSERT INTO responses (id, owner_hash, response_json, input_items_json, conversation_seed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_hash = excluded.owner_hash,
           response_json = excluded.response_json,
           input_items_json = excluded.input_items_json,
           conversation_seed = excluded.conversation_seed,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.ownerHash,
        JSON.stringify(record.response),
        JSON.stringify(record.inputItems),
        record.conversationSeed ?? null,
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
      ...(typeof row.conversation_seed === "string" && row.conversation_seed
        ? { conversationSeed: row.conversation_seed }
        : {}),
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
        `INSERT INTO cursor_keys (id, api_key, label, status, source, sort_order, disabled_reason, disabled_at, last_used_at, last_error, request_count, failure_count, client_type, allowed_models, excluded_models, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.clientType,
        encodeList(record.modelScope?.allowed),
        encodeList(record.modelScope?.excluded),
        normalizeWeight(record.weight),
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
    if (patch.clientType !== undefined) {
      sets.push("client_type = ?");
      values.push(patch.clientType);
    }
    if (patch.modelScope !== undefined) {
      sets.push("allowed_models = ?", "excluded_models = ?");
      values.push(encodeList(patch.modelScope.allowed), encodeList(patch.modelScope.excluded));
    }
    if (patch.weight !== undefined) {
      sets.push("weight = ?");
      values.push(normalizeWeight(patch.weight));
    }
    if (!sets.length) return false;
    const result = this.db
      .prepare(`UPDATE cursor_keys SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return Number(result.changes) > 0;
  }

  async deleteCursorKey(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM cursor_keys WHERE id = ?").run(id);
    const removed = Number(result.changes) > 0;
    if (removed) {
      // 绑定到这个 key 的会话粘性立刻失效，否则下一次请求会取到一个已不存在的 key。
      this.db.prepare("DELETE FROM session_bindings WHERE key_id = ?").run(id);
      this.dropCursorKeyFromGatewayKeys(id);
    }
    return removed;
  }

  /** key 被删除后，把它从所有网关密钥的绑定列表里剔除，避免残留一个指向空的授权。 */
  private dropCursorKeyFromGatewayKeys(keyId: string): void {
    const rows = this.db.prepare("SELECT id, allowed_cursor_key_ids FROM gateway_keys").all();
    const update = this.db.prepare("UPDATE gateway_keys SET allowed_cursor_key_ids = ? WHERE id = ?");
    for (const row of rows) {
      const ids = decodeList(row.allowed_cursor_key_ids);
      if (!ids.includes(keyId)) continue;
      update.run(encodeList(dropBoundKey(ids, keyId)), String(row.id));
    }
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

  async listGatewayKeys(): Promise<GatewayKeyRecord[]> {
    const rows = this.db.prepare("SELECT * FROM gateway_keys ORDER BY rowid ASC").all();
    return rows.map(rowToGatewayKey);
  }

  async getGatewayKeyByValue(apiKey: string): Promise<GatewayKeyRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM gateway_keys WHERE api_key = ? LIMIT 1").get(apiKey);
    return row ? rowToGatewayKey(row) : undefined;
  }

  async insertGatewayKey(record: GatewayKeyRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO gateway_keys (id, api_key, label, status, source, allowed_cursor_key_ids, allowed_models, excluded_models, request_count, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.apiKey,
        record.label,
        record.status,
        record.source,
        encodeList(record.allowedCursorKeyIds),
        encodeList(record.modelScope?.allowed),
        encodeList(record.modelScope?.excluded),
        record.requestCount,
        record.lastUsedAt ?? null,
        record.createdAt
      );
  }

  async updateGatewayKey(id: string, patch: GatewayKeyPatch): Promise<boolean> {
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
    if (patch.allowedCursorKeyIds !== undefined) {
      sets.push("allowed_cursor_key_ids = ?");
      values.push(encodeList(patch.allowedCursorKeyIds));
    }
    if (patch.modelScope !== undefined) {
      sets.push("allowed_models = ?", "excluded_models = ?");
      values.push(encodeList(patch.modelScope.allowed), encodeList(patch.modelScope.excluded));
    }
    if (patch.lastUsedAt !== undefined) {
      sets.push("last_used_at = ?");
      values.push(patch.lastUsedAt);
    }
    if (patch.incrementRequestCount) {
      sets.push("request_count = request_count + 1");
    }
    if (!sets.length) return false;
    const result = this.db
      .prepare(`UPDATE gateway_keys SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return Number(result.changes) > 0;
  }

  async deleteGatewayKey(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM gateway_keys WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async getSessionBinding(sessionHash: string, ttlMs: number): Promise<SessionBinding | undefined> {
    // 严格大于：绑定有效的条件是「年龄 < ttl」，用 >= 会让 ttl=0 在同一毫秒内写读时仍判为有效。
    const row = this.db
      .prepare("SELECT * FROM session_bindings WHERE session_hash = ? AND updated_at > ? LIMIT 1")
      .get(sessionHash, cutoffIso(ttlMs));
    if (!row) return undefined;
    return {
      sessionHash: String(row.session_hash),
      keyId: String(row.key_id),
      updatedAt: String(row.updated_at)
    };
  }

  async saveSessionBinding(sessionHash: string, keyId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_bindings (session_hash, key_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_hash) DO UPDATE SET key_id = excluded.key_id, updated_at = excluded.updated_at`
      )
      .run(sessionHash, keyId, new Date().toISOString());
  }

  async deleteSessionBinding(sessionHash: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM session_bindings WHERE session_hash = ?").run(sessionHash);
    return Number(result.changes) > 0;
  }

  async pruneSessionBindings(ttlMs: number): Promise<number> {
    // 与 getSessionBinding 互补：那里「> cutoff」才有效，这里就要删掉「<= cutoff」的全部。
    const result = this.db.prepare("DELETE FROM session_bindings WHERE updated_at <= ?").run(cutoffIso(ttlMs));
    return Number(result.changes);
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
        `INSERT INTO request_logs (
           id, ts, endpoint, model, auth_mode, key_id, key_label, status, duration_ms, stream, error,
           gateway_key_id, gateway_key_label, reasoning_effort, max_mode, fast, effective_params, client_type, agent_mode, model_params,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
           usage_source, raw_cost_cents, charged_cents
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.error ?? null,
        record.gatewayKeyId ?? null,
        record.gatewayKeyLabel ?? null,
        record.reasoningEffort ?? null,
        encodeBool(record.maxMode),
        encodeBool(record.fast),
        encodeList(record.effectiveParams),
        record.clientType ?? null,
        record.agentMode ?? null,
        record.modelParams?.length ? JSON.stringify(record.modelParams) : null,
        record.usage?.inputTokens ?? null,
        record.usage?.outputTokens ?? null,
        record.usage?.cacheReadTokens ?? null,
        record.usage?.cacheWriteTokens ?? null,
        record.usage?.reasoningTokens ?? null,
        record.usage?.totalTokens ?? null,
        record.usageSource ?? (record.usage ? "sdk" : null),
        record.cost?.rawCostCents ?? null,
        record.cost?.chargedCents ?? null
      );
    this.requestLogInsertCount += 1;
    if (this.requestLogInsertCount % REQUEST_LOG_CLEANUP_EVERY === 0) {
      this.trimRequestLogs();
    }
  }

  async updateRequestLogUsage(
    id: string,
    usage?: RequestUsage,
    cost?: RequestCost,
    usageSource?: "sdk" | "estimated"
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (usage) {
      sets.push(
        "input_tokens = ?",
        "output_tokens = ?",
        "cache_read_tokens = ?",
        "cache_write_tokens = ?",
        "reasoning_tokens = ?",
        "total_tokens = ?"
      );
      values.push(
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.reasoningTokens ?? null,
        usage.totalTokens
      );
    }
    if (cost) {
      sets.push("raw_cost_cents = ?", "charged_cents = ?");
      values.push(cost.rawCostCents, cost.chargedCents);
    }
    if (usageSource) {
      sets.push("usage_source = ?");
      values.push(usageSource);
    }
    if (!sets.length) return false;
    const result = this.db.prepare(`UPDATE request_logs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return Number(result.changes) > 0;
  }

  async listRequestLogs(query: RequestLogQuery): Promise<RequestLogPage> {
    const { clause, values } = requestLogFilter(query);
    const limit = normalizePageSize(query.limit);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM request_logs ${clause}`).get(...values);
    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${clause} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset);
    return { logs: rows.map(rowToLog), total: Number(totalRow?.total ?? 0) };
  }

  async requestLogStats(): Promise<RequestLogStats> {
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END), 0) AS success,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
                AVG(duration_ms) AS avg_duration,
                COALESCE(SUM(CASE WHEN usage_source = 'sdk' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'sdk' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'sdk' THEN cache_read_tokens ELSE 0 END), 0) AS cache_read_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'sdk' THEN cache_write_tokens ELSE 0 END), 0) AS cache_write_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'sdk' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN input_tokens ELSE 0 END), 0) AS estimated_input_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN output_tokens ELSE 0 END), 0) AS estimated_output_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN cache_read_tokens ELSE 0 END), 0) AS estimated_cache_read_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN cache_write_tokens ELSE 0 END), 0) AS estimated_cache_write_tokens,
                COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated_total_tokens,
                COALESCE(SUM(raw_cost_cents), 0) AS raw_cost_cents,
                COALESCE(SUM(charged_cents), 0) AS charged_cents
         FROM request_logs`
      )
      .get();
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
         FROM request_logs WHERE ts >= ?`
      )
      .get(cutoffIso(24 * 60 * 60 * 1000));
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
      },
      tokens: {
        input: Number(total?.input_tokens ?? 0),
        output: Number(total?.output_tokens ?? 0),
        cacheRead: Number(total?.cache_read_tokens ?? 0),
        cacheWrite: Number(total?.cache_write_tokens ?? 0),
        total: Number(total?.total_tokens ?? 0)
      },
      estimatedTokens: {
        input: Number(total?.estimated_input_tokens ?? 0),
        output: Number(total?.estimated_output_tokens ?? 0),
        cacheRead: Number(total?.estimated_cache_read_tokens ?? 0),
        cacheWrite: Number(total?.estimated_cache_write_tokens ?? 0),
        total: Number(total?.estimated_total_tokens ?? 0)
      },
      cost: {
        rawCostCents: Number(total?.raw_cost_cents ?? 0),
        chargedCents: Number(total?.charged_cents ?? 0)
      }
    };
  }

  async clearRequestLogs(): Promise<number> {
    const result = this.db.prepare("DELETE FROM request_logs").run();
    this.requestLogInsertCount = 0;
    return Number(result.changes);
  }

  async bookAgentUsageDelta(agentId: string, cumulative: RequestCost): Promise<RequestCost> {
    /*
     * 读-改-写必须是一次原子操作：同一个 agent 的两条补写可能同时走到这里，
     * 各自读到同一个基线就会把同一笔金额记两遍——正是本方法要消除的那个重复。
     * node:sqlite 是同步 API 且这个方法体里没有 await，进程内天然串行；
     * IMMEDIATE 事务补上「多个进程共用同一个库文件」的情形（延迟事务会在升级写锁时才发现冲突）。
     */
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT raw_cost_cents, charged_cents, raw_regression_count, raw_regression_last,
                  charged_regression_count, charged_regression_last
           FROM agent_usage_baselines WHERE agent_id = ? LIMIT 1`
        )
        .get(agentId) as BaselineRow | undefined;
      const previous = rowToBaselineState(row);
      const advanced = advanceAgentUsageBaseline(previous, cumulative);
      this.db
        .prepare(
          `INSERT INTO agent_usage_baselines (
             agent_id, raw_cost_cents, charged_cents, updated_at,
             raw_regression_count, raw_regression_last,
             charged_regression_count, charged_regression_last
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             raw_cost_cents = excluded.raw_cost_cents,
             charged_cents = excluded.charged_cents,
             updated_at = excluded.updated_at,
             raw_regression_count = excluded.raw_regression_count,
             raw_regression_last = excluded.raw_regression_last,
             charged_regression_count = excluded.charged_regression_count,
             charged_regression_last = excluded.charged_regression_last`
        )
        .run(
          agentId,
          advanced.state.baseline.rawCostCents,
          advanced.state.baseline.chargedCents,
          new Date().toISOString(),
          advanced.state.rawRegressionCount,
          advanced.state.rawRegressionLast ?? null,
          advanced.state.chargedRegressionCount,
          advanced.state.chargedRegressionLast ?? null
        );
      this.db.exec("COMMIT");
      return advanced.booked;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async bookAgentUsageDeltaForRequest(
    logId: string,
    agentId: string,
    cumulative: RequestCost
  ): Promise<RequestCost | undefined> {
    /*
     * 基线推进和 request_logs 写入必须共用一个事务；否则先提交基线、后写日志时，
     * 进程在两步之间退出会让这笔累计金额永久变成「已经记过」但历史里没有金额。
     */
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const log = this.db
        .prepare("SELECT raw_cost_cents, charged_cents FROM request_logs WHERE id = ? LIMIT 1")
        .get(logId) as { raw_cost_cents?: unknown; charged_cents?: unknown } | undefined;
      if (!log) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const row = this.db
        .prepare(
          `SELECT raw_cost_cents, charged_cents, raw_regression_count, raw_regression_last,
                  charged_regression_count, charged_regression_last
           FROM agent_usage_baselines WHERE agent_id = ? LIMIT 1`
        )
        .get(agentId) as BaselineRow | undefined;
      const previous = rowToBaselineState(row);
      const advanced = advanceAgentUsageBaseline(previous, cumulative);
      this.db
        .prepare(
          `INSERT INTO agent_usage_baselines (
             agent_id, raw_cost_cents, charged_cents, updated_at,
             raw_regression_count, raw_regression_last,
             charged_regression_count, charged_regression_last
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             raw_cost_cents = excluded.raw_cost_cents,
             charged_cents = excluded.charged_cents,
             updated_at = excluded.updated_at,
             raw_regression_count = excluded.raw_regression_count,
             raw_regression_last = excluded.raw_regression_last,
             charged_regression_count = excluded.charged_regression_count,
             charged_regression_last = excluded.charged_regression_last`
        )
        .run(
          agentId,
          advanced.state.baseline.rawCostCents,
          advanced.state.baseline.chargedCents,
          new Date().toISOString(),
          advanced.state.rawRegressionCount,
          advanced.state.rawRegressionLast ?? null,
          advanced.state.chargedRegressionCount,
          advanced.state.chargedRegressionLast ?? null
        );

      const writeCost = hasPositiveCost(advanced.booked);
      if (writeCost) {
        const nextCost = {
          rawCostCents: Number(log.raw_cost_cents ?? 0) + advanced.booked.rawCostCents,
          chargedCents: Number(log.charged_cents ?? 0) + advanced.booked.chargedCents
        };
        this.db
          .prepare("UPDATE request_logs SET raw_cost_cents = ?, charged_cents = ? WHERE id = ?")
          .run(nextCost.rawCostCents, nextCost.chargedCents, logId);
      }
      this.db.exec("COMMIT");
      return writeCost ? advanced.booked : undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class MemoryStateStore implements StateStore {
  readonly sessions = new Map<string, string>();
  readonly responses = new Map<string, StoredResponse>();
  readonly cursorKeys: CursorKeyRecord[] = [];
  readonly gatewayKeys: GatewayKeyRecord[] = [];
  readonly sessionBindings = new Map<string, SessionBinding>();
  readonly requestLogs: RequestLogRecord[] = [];
  readonly settings = new Map<string, string>();
  readonly agentUsageBaselines = new Map<string, AgentUsageBaselineState>();

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
      .map((item) => cloneKey(item.key));
  }

  async getCursorKeyByValue(apiKey: string): Promise<CursorKeyRecord | undefined> {
    const found = this.cursorKeys.find((key) => key.apiKey === apiKey);
    return found ? cloneKey(found) : undefined;
  }

  async insertCursorKey(record: CursorKeyRecord): Promise<void> {
    this.cursorKeys.push(cloneKey(record));
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
    if (patch.clientType !== undefined) key.clientType = patch.clientType;
    if (patch.modelScope !== undefined) key.modelScope = cloneScope(patch.modelScope);
    if (patch.weight !== undefined) key.weight = normalizeWeight(patch.weight);
    return true;
  }

  async deleteCursorKey(id: string): Promise<boolean> {
    const index = this.cursorKeys.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.cursorKeys.splice(index, 1);
    for (const [hash, binding] of this.sessionBindings) {
      if (binding.keyId === id) this.sessionBindings.delete(hash);
    }
    for (const gatewayKey of this.gatewayKeys) {
      if (!gatewayKey.allowedCursorKeyIds.includes(id)) continue;
      gatewayKey.allowedCursorKeyIds = dropBoundKey(gatewayKey.allowedCursorKeyIds, id);
    }
    return true;
  }

  async reorderCursorKeys(ids: string[]): Promise<void> {
    const ordered = resolveKeyOrder(await this.listCursorKeys(), ids);
    ordered.forEach((keyId, index) => {
      const key = this.cursorKeys.find((item) => item.id === keyId);
      if (key) key.sortOrder = index + 1;
    });
  }

  async listGatewayKeys(): Promise<GatewayKeyRecord[]> {
    return this.gatewayKeys.map(cloneGatewayKey);
  }

  async getGatewayKeyByValue(apiKey: string): Promise<GatewayKeyRecord | undefined> {
    const found = this.gatewayKeys.find((key) => key.apiKey === apiKey);
    return found ? cloneGatewayKey(found) : undefined;
  }

  async insertGatewayKey(record: GatewayKeyRecord): Promise<void> {
    this.gatewayKeys.push(cloneGatewayKey(record));
  }

  async updateGatewayKey(id: string, patch: GatewayKeyPatch): Promise<boolean> {
    const key = this.gatewayKeys.find((item) => item.id === id);
    if (!key) return false;
    if (patch.status !== undefined) key.status = patch.status;
    if (patch.label !== undefined) key.label = patch.label;
    if (patch.allowedCursorKeyIds !== undefined) key.allowedCursorKeyIds = [...patch.allowedCursorKeyIds];
    if (patch.modelScope !== undefined) key.modelScope = cloneScope(patch.modelScope);
    if (patch.lastUsedAt !== undefined) key.lastUsedAt = patch.lastUsedAt;
    if (patch.incrementRequestCount) key.requestCount += 1;
    return true;
  }

  async deleteGatewayKey(id: string): Promise<boolean> {
    const index = this.gatewayKeys.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.gatewayKeys.splice(index, 1);
    return true;
  }

  async getSessionBinding(sessionHash: string, ttlMs: number): Promise<SessionBinding | undefined> {
    const binding = this.sessionBindings.get(sessionHash);
    if (!binding) return undefined;
    return binding.updatedAt > cutoffIso(ttlMs) ? { ...binding } : undefined;
  }

  async saveSessionBinding(sessionHash: string, keyId: string): Promise<void> {
    this.sessionBindings.set(sessionHash, { sessionHash, keyId, updatedAt: new Date().toISOString() });
  }

  async deleteSessionBinding(sessionHash: string): Promise<boolean> {
    return this.sessionBindings.delete(sessionHash);
  }

  async pruneSessionBindings(ttlMs: number): Promise<number> {
    const cutoff = cutoffIso(ttlMs);
    let removed = 0;
    for (const [hash, binding] of this.sessionBindings) {
      if (binding.updatedAt <= cutoff) {
        this.sessionBindings.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async insertRequestLog(record: RequestLogRecord): Promise<void> {
    this.requestLogs.push({
      ...record,
      ...(record.usageSource === undefined && record.usage ? { usageSource: "sdk" } : {})
    });
  }

  async updateRequestLogUsage(
    id: string,
    usage?: RequestUsage,
    cost?: RequestCost,
    usageSource?: "sdk" | "estimated"
  ): Promise<boolean> {
    const log = this.requestLogs.find((item) => item.id === id);
    if (!log) return false;
    if (usage) log.usage = { ...usage };
    if (cost) log.cost = { ...cost };
    if (usageSource) log.usageSource = usageSource;
    return true;
  }

  async listRequestLogs(query: RequestLogQuery): Promise<RequestLogPage> {
    const filtered = this.requestLogs
      .filter((log) => matchesLogQuery(log, query))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    return {
      logs: filtered.slice(offset, offset + normalizePageSize(query.limit)),
      total: filtered.length
    };
  }

  async requestLogStats(): Promise<RequestLogStats> {
    const recent = this.requestLogs.filter((log) => log.ts >= cutoffIso(24 * 60 * 60 * 1000));
    const errors = this.requestLogs.filter((log) => log.status >= 400).length;
    const avg = this.requestLogs.length
      ? Math.round(this.requestLogs.reduce((sum, log) => sum + log.durationMs, 0) / this.requestLogs.length)
      : null;
    const sum = (pick: (log: RequestLogRecord) => number | undefined): number =>
      this.requestLogs.reduce((acc, log) => acc + (pick(log) ?? 0), 0);
    const sumSource = (
      source: "sdk" | "estimated",
      pick: (log: RequestLogRecord) => number | undefined
    ): number => sum((log) => log.usageSource === source ? pick(log) : undefined);
    return {
      total: this.requestLogs.length,
      success: this.requestLogs.length - errors,
      errors,
      avgDurationMs: avg,
      last24h: {
        total: recent.length,
        errors: recent.filter((log) => log.status >= 400).length
      },
      tokens: {
        input: sumSource("sdk", (log) => log.usage?.inputTokens),
        output: sumSource("sdk", (log) => log.usage?.outputTokens),
        cacheRead: sumSource("sdk", (log) => log.usage?.cacheReadTokens),
        cacheWrite: sumSource("sdk", (log) => log.usage?.cacheWriteTokens),
        total: sumSource("sdk", (log) => log.usage?.totalTokens)
      },
      estimatedTokens: {
        input: sumSource("estimated", (log) => log.usage?.inputTokens),
        output: sumSource("estimated", (log) => log.usage?.outputTokens),
        cacheRead: sumSource("estimated", (log) => log.usage?.cacheReadTokens),
        cacheWrite: sumSource("estimated", (log) => log.usage?.cacheWriteTokens),
        total: sumSource("estimated", (log) => log.usage?.totalTokens)
      },
      cost: {
        rawCostCents: sum((log) => log.cost?.rawCostCents),
        chargedCents: sum((log) => log.cost?.chargedCents)
      }
    };
  }

  async clearRequestLogs(): Promise<number> {
    const removed = this.requestLogs.length;
    this.requestLogs.length = 0;
    return removed;
  }

  async bookAgentUsageDelta(agentId: string, cumulative: RequestCost): Promise<RequestCost> {
    // 与 SQLite 版同样是原子的：方法体里没有 await，事件循环插不进第二次读-改-写。
    const advanced = advanceAgentUsageBaseline(
      this.agentUsageBaselines.get(agentId) ?? emptyAgentUsageBaseline(),
      cumulative
    );
    this.agentUsageBaselines.set(agentId, advanced.state);
    return advanced.booked;
  }

  async bookAgentUsageDeltaForRequest(
    logId: string,
    agentId: string,
    cumulative: RequestCost
  ): Promise<RequestCost | undefined> {
    // 内存实现没有外部写锁；保持无 await 的单段操作，避免测试 store 与 SQLite 语义分叉。
    const log = this.requestLogs.find((item) => item.id === logId);
    if (!log) return undefined;
    const previous = this.agentUsageBaselines.get(agentId);
    const previousState = previous ?? emptyAgentUsageBaseline();
    const previousCost = log.cost ? { ...log.cost } : undefined;
    const hadCostProperty = Object.prototype.hasOwnProperty.call(log, "cost");
    try {
      const advanced = advanceAgentUsageBaseline(previousState, cumulative);
      this.agentUsageBaselines.set(agentId, advanced.state);
      const writeCost = hasPositiveCost(advanced.booked);
      if (!writeCost) return undefined;
      log.cost = {
        rawCostCents: (log.cost?.rawCostCents ?? 0) + advanced.booked.rawCostCents,
        chargedCents: (log.cost?.chargedCents ?? 0) + advanced.booked.chargedCents
      };
      return advanced.booked;
    } catch (error) {
      // SQLite 版本会回滚整个事务；内存版也必须撤销已推进的高水位，否则重试会把这笔钱吞掉。
      if (previous === undefined) this.agentUsageBaselines.delete(agentId);
      else this.agentUsageBaselines.set(agentId, previous);
      try {
        if (hadCostProperty) log.cost = previousCost;
        else delete log.cost;
      } catch {
        // 失败对象可能是只读的；金额写入已抛错，基线回滚仍是关键不变量。
      }
      throw error;
    }
  }
}

interface BaselineRow {
  raw_cost_cents?: unknown;
  charged_cents?: unknown;
  raw_regression_count?: unknown;
  raw_regression_last?: unknown;
  charged_regression_count?: unknown;
  charged_regression_last?: unknown;
}

interface AgentUsageBaselineState {
  baseline: RequestCost;
  rawRegressionCount: number;
  rawRegressionLast?: number;
  chargedRegressionCount: number;
  chargedRegressionLast?: number;
}

interface BaselineAdvance {
  state: AgentUsageBaselineState;
  booked: RequestCost;
}

function emptyAgentUsageBaseline(): AgentUsageBaselineState {
  return {
    baseline: { rawCostCents: 0, chargedCents: 0 },
    rawRegressionCount: 0,
    chargedRegressionCount: 0
  };
}

function rowToBaselineState(row: BaselineRow | undefined): AgentUsageBaselineState {
  if (!row) return emptyAgentUsageBaseline();
  return {
    baseline: {
      rawCostCents: Number(row.raw_cost_cents ?? 0),
      chargedCents: Number(row.charged_cents ?? 0)
    },
    rawRegressionCount: Number(row.raw_regression_count ?? 0),
    rawRegressionLast: row.raw_regression_last === null || row.raw_regression_last === undefined
      ? undefined
      : Number(row.raw_regression_last),
    chargedRegressionCount: Number(row.charged_regression_count ?? 0),
    chargedRegressionLast: row.charged_regression_last === null || row.charged_regression_last === undefined
      ? undefined
      : Number(row.charged_regression_last)
  };
}

function advanceAgentUsageBaseline(
  previous: AgentUsageBaselineState,
  cumulative: RequestCost
): BaselineAdvance {
  const raw = advanceCostComponent(
    previous.baseline.rawCostCents,
    cumulative.rawCostCents,
    previous.rawRegressionCount,
    previous.rawRegressionLast
  );
  const charged = advanceCostComponent(
    previous.baseline.chargedCents,
    cumulative.chargedCents,
    previous.chargedRegressionCount,
    previous.chargedRegressionLast
  );
  return {
    state: {
      baseline: { rawCostCents: raw.baseline, chargedCents: charged.baseline },
      rawRegressionCount: raw.regressionCount,
      rawRegressionLast: raw.regressionLast,
      chargedRegressionCount: charged.regressionCount,
      chargedRegressionLast: charged.regressionLast
    },
    booked: { rawCostCents: raw.booked, chargedCents: charged.booked }
  };
}

function advanceCostComponent(
  previous: number,
  cumulative: number,
  _regressionCount: number,
  _regressionLast: number | undefined
): { baseline: number; booked: number; regressionCount: number; regressionLast?: number } {
  if (cumulative >= previous) {
    return {
      baseline: cumulative,
      booked: cumulative - previous,
      regressionCount: 0
    };
  }
  // 累计接口没有「agent 已重置」信号，低读数既可能是旧副本也可能是新周期；
  // 自动降低高水位会把旧周期的钱再记一遍，所以这里宁可暂时少记，也不允许高水位回退。
  return {
    baseline: previous,
    booked: 0,
    regressionCount: 0
  };
}

function hasPositiveCost(cost: RequestCost): boolean {
  return cost.rawCostCents > 0 || cost.chargedCents > 0;
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

/** 把 RequestLogQuery 编译成共享的 WHERE 子句，让分页查询与 COUNT 用同一套过滤条件。 */
function requestLogFilter(query: RequestLogQuery): { clause: string; values: (string | number)[] } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (query.keyId) {
    conditions.push("key_id = ?");
    values.push(query.keyId);
  }
  if (query.gatewayKeyId) {
    conditions.push("gateway_key_id = ?");
    values.push(query.gatewayKeyId);
  }
  if (query.model) {
    conditions.push("model = ?");
    values.push(query.model);
  }
  if (query.outcome === "success") conditions.push("status < 400");
  if (query.outcome === "error") conditions.push("status >= 400");
  if (query.since) {
    conditions.push("ts >= ?");
    values.push(query.since);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", values };
}

function matchesLogQuery(log: RequestLogRecord, query: RequestLogQuery): boolean {
  if (query.keyId && log.keyId !== query.keyId) return false;
  if (query.gatewayKeyId && log.gatewayKeyId !== query.gatewayKeyId) return false;
  if (query.model && log.model !== query.model) return false;
  if (query.outcome === "success" && log.status >= 400) return false;
  if (query.outcome === "error" && log.status < 400) return false;
  if (query.since && log.ts < query.since) return false;
  return true;
}

function normalizePageSize(limit: number): number {
  const parsed = Number.isFinite(limit) ? Math.floor(limit) : 0;
  return Math.max(1, Math.min(parsed || 50, REQUEST_LOG_PAGE_MAX));
}

/** 0 是合法取值（不裁剪），所以下界是 >= 0 而不是 > 0；负数与非数只能是配置写错，退回默认。 */
function normalizeKeep(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : DEFAULT_REQUEST_LOG_KEEP;
}

function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 1 ? Math.floor(value as number) : 1;
}

function cutoffIso(ttlMs: number): string {
  const span = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  return new Date(Date.now() - span).toISOString();
}

/**
 * 从一条网关绑定里剔除被删除的 Cursor key。
 * 剔完为空时写哨兵而不是空数组：空数组的语义是「不限制」，直接留空会让一把
 * 「只能用这把 key」的网关密钥在 key 被删后拿到整池权限，权限反而扩大。
 */
function dropBoundKey(ids: string[], removedId: string): string[] {
  const remaining = ids.filter((id) => id !== removedId);
  return remaining.length ? remaining : [NO_KEY_SENTINEL];
}

/** 空列表统一存 null，读回来就是空数组，避免库里出现 "[]" 与 NULL 两种「不限制」表示。 */
function encodeList(values: string[] | undefined): string | null {
  return values?.length ? JSON.stringify(values) : null;
}

function decodeList(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
  } catch {
    return [];
  }
}

function encodeBool(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function decodeBool(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value) === 1;
}

function decodeScope(allowed: unknown, excluded: unknown): ModelScope {
  return { allowed: decodeList(allowed), excluded: decodeList(excluded) };
}

function cloneScope(scope: ModelScope | undefined): ModelScope {
  return { allowed: [...(scope?.allowed ?? [])], excluded: [...(scope?.excluded ?? [])] };
}

function cloneKey(key: CursorKeyRecord): CursorKeyRecord {
  return { ...key, modelScope: cloneScope(key.modelScope) };
}

function cloneGatewayKey(key: GatewayKeyRecord): GatewayKeyRecord {
  return { ...key, allowedCursorKeyIds: [...key.allowedCursorKeyIds], modelScope: cloneScope(key.modelScope) };
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
    clientType: row.client_type === "sdk" || row.client_type === "sand" ? row.client_type : "inherit",
    modelScope: decodeScope(row.allowed_models, row.excluded_models),
    weight: normalizeWeight(Number(row.weight ?? 1)),
    createdAt: String(row.created_at)
  };
}

function rowToGatewayKey(row: Record<string, unknown>): GatewayKeyRecord {
  return {
    id: String(row.id),
    apiKey: String(row.api_key),
    label: String(row.label),
    status: row.status === "disabled" ? "disabled" : "active",
    source: row.source === "env" ? "env" : "manual",
    allowedCursorKeyIds: decodeList(row.allowed_cursor_key_ids),
    modelScope: decodeScope(row.allowed_models, row.excluded_models),
    requestCount: Number(row.request_count ?? 0),
    lastUsedAt: optional(row.last_used_at),
    createdAt: String(row.created_at)
  };
}

function rowToLog(row: Record<string, unknown>): RequestLogRecord {
  const usage = decodeUsage(row);
  const cost = decodeCost(row);
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
    error: optional(row.error),
    gatewayKeyId: optional(row.gateway_key_id),
    gatewayKeyLabel: optional(row.gateway_key_label),
    reasoningEffort: optional(row.reasoning_effort),
    maxMode: decodeBool(row.max_mode),
    fast: decodeBool(row.fast),
    effectiveParams: decodeEffectiveParams(row.effective_params),
    clientType: row.client_type === "sand" ? "sand" : row.client_type === "sdk" ? "sdk" : undefined,
    agentMode: row.agent_mode === "plan" ? "plan" : row.agent_mode === "agent" ? "agent" : undefined,
    modelParams: decodeModelParams(row.model_params),
    ...(usage ? { usage } : {}),
    usageSource: row.usage_source === "sdk" ? "sdk" : row.usage_source === "estimated" ? "estimated" : undefined,
    ...(cost ? { cost } : {})
  };
}

/** 任一 token 列有值就认为上游报过用量；全 NULL 的老记录返回 undefined。 */
function decodeUsage(row: Record<string, unknown>): RequestUsage | undefined {
  const fields = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"];
  if (fields.every((field) => row[field] === null || row[field] === undefined)) return undefined;
  const reasoning = row.reasoning_tokens;
  return {
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    ...(reasoning === null || reasoning === undefined ? {} : { reasoningTokens: Number(reasoning) })
  };
}

function decodeCost(row: Record<string, unknown>): RequestCost | undefined {
  if (
    (row.raw_cost_cents === null || row.raw_cost_cents === undefined) &&
    (row.charged_cents === null || row.charged_cents === undefined)
  ) {
    return undefined;
  }
  return {
    rawCostCents: Number(row.raw_cost_cents ?? 0),
    chargedCents: Number(row.charged_cents ?? 0)
  };
}

/** 老记录没有这一列，读出来是 undefined——后台据此把三列一律按「请求意图」展示，不会谎称实测。 */
function decodeEffectiveParams(value: unknown): EffectiveParamField[] | undefined {
  const fields = decodeList(value).filter((field): field is EffectiveParamField =>
    field === "reasoningEffort" || field === "maxMode" || field === "fast");
  return fields.length ? fields : undefined;
}

function decodeModelParams(value: unknown): RequestLogRecord["modelParams"] {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const params = parsed.flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      const id = typeof record?.id === "string" ? record.id : "";
      const paramValue = typeof record?.value === "string" ? record.value : "";
      return id && paramValue ? [{ id, value: paramValue }] : [];
    });
    return params.length ? params : undefined;
  } catch {
    return undefined;
  }
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
