import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RequestUsage } from "../types.js";
import { cursorTokenType } from "./credentials.js";
import type { DraftEvent, UnifiedEvent, UnifiedEventType } from "./events.js";
import { UNIFIED_EVENT_VERSION } from "./events.js";

/**
 * Connect 路线的持久化（计划 §G10）。
 *
 * 表名一律 `cc_` 前缀，且**不改 `src/store.ts`**：那 1500 行服务着 SDK 路线，
 * 已有大量测试压在上面。这里只借同一个 SQLite 文件（或另开一个），自己建表、自己迁移。
 */

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_tool"
  | "awaiting_child"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * 已经交付出去多少内容，决定「断线后重跑是否安全」（计划 §G9）。
 * 上游没有断点续传（`InferenceStreamRequest` 12 个字段里没有 offset/cursor/resumeToken），
 * 所以重连只能重建请求，而重建是否安全全看这个字段。
 */
export type DeliveryState = "none" | "partial_delivered" | "complete";

export type ToolCallStatus = "streaming" | "complete" | "submitted" | "failed";

export type TaskStatus = "queued" | "running" | "awaiting_tool" | "awaiting_child" | "completed" | "failed" | "cancelled";

export interface CcRun {
  id: string;
  conversationId: string;
  parentRunId?: string;
  parentToolCallId?: string;
  upstreamInvocationId?: string;
  requestedModel: string;
  resolvedModel?: string;
  parametersJson?: string;
  background: boolean;
  status: RunStatus;
  attempt: number;
  deliveryState: DeliveryState;
  lastEventSeq: number;
  usage?: RequestUsage;
  errorJson?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CcToolCall {
  runId: string;
  callId: string;
  toolName: string;
  argumentsJson: string;
  toolIndex?: number;
  status: ToolCallStatus;
  resultJson?: string;
  isError: boolean;
  parentCallId?: string;
  idempotencyKey?: string;
  requestedAt: string;
  completedAt?: string;
}

export interface CcTask {
  taskId: string;
  runId: string;
  parentTaskId?: string;
  taskType: string;
  status: TaskStatus;
  depth: number;
  requestedModel?: string;
  parametersJson?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  retryCount: number;
  nextRunAt?: string;
}

export interface CcSummary {
  id: string;
  conversationId: string;
  runId: string;
  coveredThroughSeq: number;
  summaryText: string;
  model?: string;
  parametersJson?: string;
  sourceHash: string;
  createdAt: string;
}

export interface CcConversation {
  id: string;
  ownerHash: string;
  upstreamConversationId: string;
  upstreamConversationGroupId?: string;
  defaultModel?: string;
  stickyCredentialId?: string;
  latestSummaryId?: string;
  latestEventSeq: number;
  status: string;
}

export interface CreateRunInput {
  id?: string;
  conversationId: string;
  requestedModel: string;
  parentRunId?: string;
  parentToolCallId?: string;
  background?: boolean;
  parametersJson?: string;
  status?: RunStatus;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cc_credentials (
    id TEXT PRIMARY KEY,
    label TEXT,
    encrypted_session_token TEXT NOT NULL,
    token_type TEXT,
    expires_at TEXT,
    machine_id TEXT NOT NULL,
    mac_machine_id TEXT,
    client_version TEXT NOT NULL,
    client_os TEXT,
    client_arch TEXT,
    client_os_version TEXT,
    device_type TEXT,
    client_key TEXT,
    session_id TEXT,
    timezone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    allowed_models TEXT,
    excluded_models TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source_cursor_key_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_credentials_source_key
    ON cc_credentials(source_cursor_key_id)
    WHERE source_cursor_key_id IS NOT NULL AND source_cursor_key_id != '';

  CREATE TABLE IF NOT EXISTS cc_conversations (
    id TEXT PRIMARY KEY,
    owner_hash TEXT NOT NULL,
    upstream_conversation_id TEXT NOT NULL,
    upstream_conversation_group_id TEXT,
    default_model TEXT,
    default_parameters_json TEXT,
    sticky_credential_id TEXT,
    latest_summary_id TEXT,
    latest_event_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_conversations_upstream
  ON cc_conversations(upstream_conversation_id, owner_hash);

  CREATE TABLE IF NOT EXISTS cc_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    parent_run_id TEXT,
    parent_tool_call_id TEXT,
    upstream_invocation_id TEXT,
    requested_model TEXT NOT NULL,
    resolved_model TEXT,
    parameters_json TEXT,
    background INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    delivery_state TEXT NOT NULL DEFAULT 'none',
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT,
    error_json TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    next_run_at TEXT,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cc_runs_conversation ON cc_runs(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_cc_runs_lease ON cc_runs(status, lease_until);
  CREATE INDEX IF NOT EXISTS idx_cc_runs_parent ON cc_runs(parent_run_id);

  CREATE TABLE IF NOT EXISTS cc_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    upstream_case TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_events_event_id ON cc_events(run_id, event_id);
  CREATE INDEX IF NOT EXISTS idx_cc_events_replay ON cc_events(run_id, seq);

  CREATE TABLE IF NOT EXISTS cc_tool_calls (
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    tool_index INTEGER,
    status TEXT NOT NULL,
    result_json TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    parent_call_id TEXT,
    idempotency_key TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (run_id, call_id)
  );

  CREATE TABLE IF NOT EXISTS cc_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_task_id TEXT,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    requested_model TEXT,
    parameters_json TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cc_tasks_run ON cc_tasks(run_id);

  CREATE TABLE IF NOT EXISTS cc_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    covered_through_seq INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    summary_json TEXT,
    model TEXT,
    parameters_json TEXT,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cc_summaries_conversation ON cc_summaries(conversation_id, created_at DESC);

  -- 没有这条唯一索引时，"按 source_hash 去重"只是先查再写，两个并发摘要会各插一行，
  -- 同一段消息被摘两次、计费两次，之后 latestSummary 还会在两行之间任取。
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_summaries_dedupe ON cc_summaries(conversation_id, source_hash);
`;

export interface CcCredential {
  id: string;
  label?: string;
  /** 明文 session token。**只在进程内传递，绝不进日志、响应体或 fixture。** */
  sessionToken: string;
  tokenType?: string;
  machineId: string;
  macMachineId?: string;
  clientVersion: string;
  clientOs?: string;
  clientArch?: string;
  clientOsVersion?: string;
  deviceType?: string;
  clientKey?: string;
  sessionId?: string;
  timezone?: string;
  status: string;
  allowedModels?: string[];
  excludedModels?: string[];
  failureCount: number;
  lastUsedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** 从 Cursor Key 池兑换来的凭据会记下源 key id，再拉一次时换 token、不换 machineId。 */
  sourceCursorKeyId?: string;
}

export interface CcCredentialInput {
  id?: string;
  label?: string;
  sessionToken?: string;
  machineId: string;
  macMachineId?: string;
  clientVersion: string;
  clientOs?: string;
  clientArch?: string;
  clientOsVersion?: string;
  deviceType?: string;
  clientKey?: string;
  sessionId?: string;
  timezone?: string;
  status?: string;
  allowedModels?: string[];
  excludedModels?: string[];
  sourceCursorKeyId?: string;
}

export interface ConnectStoreOptions {
  now?: () => Date;
  newId?: () => string;
  /**
   * token 落库前的处理。默认只做 base64（**不是加密**，只是避免明文出现在 `.sqlite` 的
   * 字符串扫描里）。真正的密钥管理应由 Docker secret / secret manager 承担，
   * 这里留出注入点而不是假装自己在做加密。
   */
  protectToken?: (plain: string) => string;
  revealToken?: (stored: string) => string;
}

export class CursorConnectStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly protect: (plain: string) => string;
  private readonly reveal: (stored: string) => string;

  constructor(
    private readonly db: DatabaseSync,
    options: ConnectStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.protect = options.protectToken ?? ((plain) => Buffer.from(plain, "utf8").toString("base64"));
    this.reveal = options.revealToken ?? ((stored) => Buffer.from(stored, "base64").toString("utf8"));
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 补列。`CREATE TABLE IF NOT EXISTS` 只对空库有用：已经建过表的库不会因为
   * SCHEMA 里多了一列就跟着变，之后要等到某次查询才炸。
   * 与 `src/store.ts` 的 `hasColumn` + `ALTER TABLE` 是同一套做法。
   */
  private migrate(): void {
    const columns: Array<[string, string, string]> = [
      ["cc_runs", "next_run_at", "TEXT"],
      ["cc_runs", "delivery_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["cc_runs", "usage_json", "TEXT"],
      ["cc_events", "attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["cc_tool_calls", "idempotency_key", "TEXT"],
      ["cc_conversations", "latest_event_seq", "INTEGER NOT NULL DEFAULT 0"],
      ["cc_credentials", "note", "TEXT"],
      ["cc_credentials", "source_cursor_key_id", "TEXT"]
    ];
    for (const [table, column, type] of columns) {
      if (this.hasColumn(table, column)) continue;
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // 并发启动时另一个进程可能刚加过；下一次 hasColumn 就能看到。
      }
    }
    try {
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_credentials_source_key
         ON cc_credentials(source_cursor_key_id)
         WHERE source_cursor_key_id IS NOT NULL AND source_cursor_key_id != ''`
      );
    } catch {
      // 同上：并发启动时索引可能已经在。
    }
  }

  private hasColumn(table: string, column: string): boolean {
    try {
      return this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => row.name === column);
    } catch {
      return false;
    }
  }

  /** 便于测试与独立部署：自带一个库而不是强行挂到 SDK 路线的库上。 */
  static open(path = ":memory:", options: ConnectStoreOptions = {}): CursorConnectStore {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    } catch {
      // 内存库不支持 WAL。
    }
    return new CursorConnectStore(db, options);
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------ 会话 */

  upsertConversation(input: {
    id?: string;
    ownerHash: string;
    upstreamConversationId: string;
    upstreamConversationGroupId?: string;
    defaultModel?: string;
    stickyCredentialId?: string;
  }): CcConversation {
    const ts = this.iso();
    // 一条 INSERT ... ON CONFLICT 而不是"先查再写"：两个并发的首次接触会各插一行，
    // 之后每次按 (upstream_id, owner) 查都是 `.get()` 任取其一，
    // 同一段对话的粘性凭据、摘要链和 run 历史就被劈成两半了。
    // 空串要当成"没提供"：`COALESCE` 只挡 NULL，`?? null` 也放行 ""，
    // 客户端发一个空 model 就会把已配置的默认值抹掉。
    this.db
      .prepare(
        `INSERT INTO cc_conversations
         (id, owner_hash, upstream_conversation_id, upstream_conversation_group_id, default_model,
          default_parameters_json, sticky_credential_id, latest_summary_id, latest_event_seq, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, 'active', ?, ?)
         ON CONFLICT(upstream_conversation_id, owner_hash) DO UPDATE SET
           default_model = COALESCE(excluded.default_model, default_model),
           sticky_credential_id = COALESCE(excluded.sticky_credential_id, sticky_credential_id),
           updated_at = excluded.updated_at`
      )
      .run(
        input.id ?? this.newId(),
        input.ownerHash,
        input.upstreamConversationId,
        input.upstreamConversationGroupId ?? null,
        blankToNull(input.defaultModel),
        blankToNull(input.stickyCredentialId),
        ts,
        ts
      );
    const row = this.db
      .prepare("SELECT * FROM cc_conversations WHERE upstream_conversation_id = ? AND owner_hash = ?")
      .get(input.upstreamConversationId, input.ownerHash);
    return mapConversation(row!);
  }

  conversation(id: string): CcConversation | undefined {
    const row = this.db.prepare("SELECT * FROM cc_conversations WHERE id = ?").get(id);
    return row ? mapConversation(row) : undefined;
  }

  setLatestSummary(conversationId: string, summaryId: string): void {
    this.db
      .prepare("UPDATE cc_conversations SET latest_summary_id = ?, updated_at = ? WHERE id = ?")
      .run(summaryId, this.iso(), conversationId);
  }

  /* ------------------------------------------------------------ 凭据 */

  upsertCredential(input: CcCredentialInput): CcCredential {
    const ts = this.iso();
    const id = input.id ?? this.newId();
    const existing = input.id ? this.credential(input.id) : undefined;
    if (existing) {
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const put = (column: string, value: string | number | null | undefined) => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      put("label", input.label);
      if (input.sessionToken) put("encrypted_session_token", this.protect(input.sessionToken));
      if (input.sessionToken) put("token_type", cursorTokenType(input.sessionToken));
      put("machine_id", input.machineId);
      put("mac_machine_id", input.macMachineId);
      put("client_version", input.clientVersion);
      put("client_os", input.clientOs);
      put("client_arch", input.clientArch);
      put("client_os_version", input.clientOsVersion);
      put("device_type", input.deviceType);
      put("client_key", input.clientKey);
      put("session_id", input.sessionId);
      put("timezone", input.timezone);
      put("status", input.status);
      if (input.allowedModels !== undefined) put("allowed_models", JSON.stringify(input.allowedModels));
      if (input.excludedModels !== undefined) put("excluded_models", JSON.stringify(input.excludedModels));
      const sourceKey = blankToNull(input.sourceCursorKeyId);
      if (sourceKey) put("source_cursor_key_id", sourceKey);
      put("updated_at", ts);
      if (sets.length) this.db.prepare(`UPDATE cc_credentials SET ${sets.join(", ")} WHERE id = ?`).run(...values, input.id!);
      return this.credential(input.id!)!;
    }

    if (!input.sessionToken) throw new Error("a new Cursor Connect credential needs a session token.");
    this.db
      .prepare(
        `INSERT INTO cc_credentials
         (id, label, encrypted_session_token, token_type, expires_at, machine_id, mac_machine_id, client_version,
          client_os, client_arch, client_os_version, device_type, client_key, session_id, timezone,
          status, allowed_models, excluded_models, failure_count, last_used_at, last_error, created_at, updated_at,
          source_cursor_key_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`
      )
      .run(
        id,
        input.label ?? null,
        this.protect(input.sessionToken),
        cursorTokenType(input.sessionToken),
        input.machineId,
        input.macMachineId ?? null,
        input.clientVersion,
        input.clientOs ?? null,
        input.clientArch ?? null,
        input.clientOsVersion ?? null,
        input.deviceType ?? null,
        input.clientKey ?? null,
        input.sessionId ?? null,
        input.timezone ?? null,
        input.status ?? "active",
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.excludedModels ? JSON.stringify(input.excludedModels) : null,
        ts,
        ts,
        blankToNull(input.sourceCursorKeyId)
      );
    return this.credential(id)!;
  }

  /**
   * 未经 `revealToken` 的原始行。
   * 只服务一件事：断言落库的值不是明文 token。除此之外不要用它。
   */
  rawCredentialRow(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM cc_credentials WHERE id = ?").get(id);
  }

  credential(id: string): CcCredential | undefined {
    const row = this.db.prepare("SELECT * FROM cc_credentials WHERE id = ?").get(id);
    return row ? this.mapCredential(row) : undefined;
  }

  credentialBySourceKeyId(sourceCursorKeyId: string): CcCredential | undefined {
    const id = sourceCursorKeyId.trim();
    if (!id) return undefined;
    const row = this.db.prepare("SELECT * FROM cc_credentials WHERE source_cursor_key_id = ?").get(id);
    return row ? this.mapCredential(row) : undefined;
  }

  listCredentials(): CcCredential[] {
    return this.db.prepare("SELECT * FROM cc_credentials ORDER BY created_at").all().map((row) => this.mapCredential(row));
  }

  activeCredentials(): CcCredential[] {
    return this.listCredentials().filter((credential) => credential.status === "active");
  }

  deleteCredential(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM cc_credentials WHERE id = ?").run(id).changes) > 0;
  }

  setCredentialStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE cc_credentials SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.iso(), id);
  }

  recordCredentialUse(id: string): void {
    this.db
      .prepare("UPDATE cc_credentials SET last_used_at = ?, failure_count = 0, last_error = NULL WHERE id = ?")
      .run(this.iso(), id);
  }

  /** 记一次失败并返回累计次数，让调用方决定要不要自动停用。 */
  recordCredentialFailure(id: string, error: string): number {
    this.db
      .prepare("UPDATE cc_credentials SET failure_count = failure_count + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 400), this.iso(), id);
    return Number(this.db.prepare("SELECT failure_count FROM cc_credentials WHERE id = ?").get(id)?.failure_count ?? 0);
  }

  /* -------------------------------------------------------------- run */

  createRun(input: CreateRunInput): CcRun {
    const id = input.id ?? this.newId();
    this.db
      .prepare(
        `INSERT INTO cc_runs
         (id, conversation_id, parent_run_id, parent_tool_call_id, upstream_invocation_id, requested_model,
          resolved_model, parameters_json, background, status, attempt, delivery_state, last_event_seq,
          usage_json, error_json, lease_owner, lease_until, started_at, finished_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 0, 'none', 0, NULL, NULL, NULL, NULL, NULL, NULL)`
      )
      .run(
        id,
        input.conversationId,
        input.parentRunId ?? null,
        input.parentToolCallId ?? null,
        input.requestedModel,
        input.parametersJson ?? null,
        input.background ? 1 : 0,
        input.status ?? "queued"
      );
    return this.run(id)!;
  }

  run(id: string): CcRun | undefined {
    const row = this.db.prepare("SELECT * FROM cc_runs WHERE id = ?").get(id);
    return row ? mapRun(row) : undefined;
  }

  /** 后台/接口用的 run 列表。按创建顺序倒序，最新的在前。 */
  listRuns(options: { conversationId?: string; limit?: number } = {}): CcRun[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const rows = options.conversationId
      ? this.db
          .prepare("SELECT * FROM cc_runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?")
          .all(options.conversationId, limit)
      : this.db.prepare("SELECT * FROM cc_runs ORDER BY rowid DESC LIMIT ?").all(limit);
    return rows.map(mapRun);
  }

  childRuns(parentRunId: string): CcRun[] {
    return this.db.prepare("SELECT * FROM cc_runs WHERE parent_run_id = ?").all(parentRunId).map(mapRun);
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        CcRun,
        | "status"
        | "deliveryState"
        | "resolvedModel"
        | "upstreamInvocationId"
        | "attempt"
        | "errorJson"
        | "startedAt"
        | "finishedAt"
      >
    > & { usage?: RequestUsage }
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (column: string, value: string | number | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    put("status", patch.status);
    put("delivery_state", patch.deliveryState);
    put("resolved_model", patch.resolvedModel);
    put("upstream_invocation_id", patch.upstreamInvocationId);
    put("attempt", patch.attempt);
    put("error_json", patch.errorJson);
    put("started_at", patch.startedAt);
    put("finished_at", patch.finishedAt);
    put("usage_json", patch.usage ? JSON.stringify(patch.usage) : undefined);
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE cc_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * 抢占一个可跑的 run。
   *
   * 租约到期即可被其他 worker 接管——否则一个 worker 崩掉，它手上的任务就永远卡在 running。
   * 用带条件的 UPDATE 而不是「先查再写」：node:sqlite 是同步的，但多进程共享同一个库时
   * 先查再写仍会两个 worker 同时抢到。
   */
  acquireRunLease(owner: string, leaseMs: number, statuses: RunStatus[] = ["queued", "paused"]): CcRun | undefined {
    const now = this.now();
    const nowIso = now.toISOString();
    const until = new Date(now.getTime() + leaseMs).toISOString();
    const placeholders = statuses.map(() => "?").join(", ");
    // `status = 'running' AND lease_until <= now` 是 worker 崩掉后的接管路径。
    // 少了它，一个进程挂掉就会把它手上的 run 永久钉在 running——那正是「重启后能恢复」要解决的情况。
    // `next_run_at` 是退避闸门。没有它的话，一条被反复非终态释放的 run 会因为
    // `ORDER BY rowid` 永远排在最前，把后面所有 run 饿死。
    const candidate = this.db
      .prepare(
        `SELECT id FROM cc_runs
         WHERE (next_run_at IS NULL OR next_run_at <= ?)
           AND ((status IN (${placeholders}) AND (lease_until IS NULL OR lease_until <= ?))
             OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?))
         ORDER BY rowid LIMIT 1`
      )
      .get(nowIso, ...statuses, nowIso, nowIso);
    if (!candidate) return undefined;

    // 带条件的 UPDATE 而不是「先查再写」：多进程共享同一个库时，
    // 两个 worker 可能同时查到同一行，只有 changes>0 的那个才真的抢到。
    // WHERE 里必须**同时**复查 status。只复查租约的话，run 在 SELECT 与 UPDATE 之间被
    // `releaseRunLease` 收成 completed（它会把 lease_until 置 NULL）时，这条 UPDATE 依然命中，
    // 于是一个已完成的 run 被复活成 running，还带着已经写好的 finished_at。
    const claimed = this.db
      .prepare(
        `UPDATE cc_runs SET lease_owner = ?, lease_until = ?, status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?)
         WHERE id = ?
           AND ((status IN (${placeholders}) AND (lease_until IS NULL OR lease_until <= ?))
             OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?))`
      )
      .run(owner, until, nowIso, candidate.id as string, ...statuses, nowIso, nowIso);
    if (Number(claimed.changes) === 0) return undefined;
    return this.run(candidate.id as string);
  }

  /**
   * 给一条**指定**的 run 上租约并置 running。
   *
   * 与 `acquireRunLease` 的区别是不做调度：调用方已经知道要跑哪一条（例如刚建出来的 child）。
   * 仍然要走租约而不是直接写 running——直接写的话 `lease_until` 是 NULL，
   * 进程中途死掉时崩溃接管分支永远看不到它。
   */
  leaseRun(id: string, owner: string, leaseMs: number): CcRun | undefined {
    const now = this.now();
    const nowIso = now.toISOString();
    const claimed = this.db
      .prepare(
        // 终态的 run 不能被重新上租约：`releaseRunLease` 把 lease_until 置了 NULL，
        // 只看租约的话一条已完成的 run 会被复活成 running。
        `UPDATE cc_runs SET lease_owner = ?, lease_until = ?, status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
           AND (lease_until IS NULL OR lease_until <= ?)`
      )
      .run(owner, new Date(now.getTime() + leaseMs).toISOString(), nowIso, id, nowIso);
    return Number(claimed.changes) === 0 ? undefined : this.run(id);
  }

  /** 非终态释放时给一个退避窗口，避免同一条 run 被立刻重新抢占把别人饿死。 */
  releaseRunLease(id: string, status: RunStatus, backoffMs = 0): void {
    const nextRunAt = isTerminal(status) || backoffMs <= 0 ? null : new Date(this.now().getTime() + backoffMs).toISOString();
    this.releaseInternal(id, status, nextRunAt);
  }

  private releaseInternal(id: string, status: RunStatus, nextRunAt: string | null): void {
    // 非终态释放时**不能动** finished_at：无条件绑定会把已有的时间戳抹成 NULL。
    // 同时不允许把已经终态的 run 改写掉——跨 worker 的 cancel 会把别人刚写完的结果覆盖。
    this.db
      .prepare(
        `UPDATE cc_runs
         SET lease_owner = NULL, lease_until = NULL, status = ?, next_run_at = ?,
             finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`
      )
      .run(status, nextRunAt, isTerminal(status) ? 1 : 0, this.iso(), id);
  }

  /* ------------------------------------------------------------ 事件 */

  /**
   * 追加事件并分配 seq。
   *
   * seq 由网关自己生成（上游不给帧序号），且必须**先落库再推送**：
   * 反过来做的话，进程在推送后、落库前崩溃，客户端重连就再也补不回那条事件。
   */
  appendEvents(runId: string, conversationId: string, drafts: DraftEvent[], attempt = 0): UnifiedEvent[] {
    if (!drafts.length) return [];
    const createdAt = this.iso();
    // payload 先全部序列化：BigInt 之类序列化不了的值要在动库之前就暴露出来，
    // 否则第一条已经插进去了才发现第三条不行。
    const payloads = drafts.map((draft) => JSON.stringify(draft.payload));

    const insert = this.db.prepare(
      `INSERT INTO cc_events (run_id, seq, event_id, event_type, payload_json, upstream_case, attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const events: UnifiedEvent[] = [];

    // 整批必须原子：中途某一条插入失败而前几条已经落库时，`last_event_seq` 就会落后于
    // 实际最大 seq，之后每一次 append 都会撞 PRIMARY KEY，这条 run 的事件流从此永久写不进去。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // seq 的读也必须在事务里。放在事务外的话两个并发 append 会读到同一个起点，
      // 输家撞 UNIQUE 抛出，那条事件就直接丢了。
      const row = this.db.prepare("SELECT last_event_seq, delivery_state FROM cc_runs WHERE id = ?").get(runId);
      if (!row) throw new Error(`cc_runs row ${runId} does not exist; refusing to append orphan events.`);
      let seq = Number(row.last_event_seq);
      let delivery = (row.delivery_state as DeliveryState | undefined) ?? "none";

      for (const [index, draft] of drafts.entries()) {
        seq += 1;
        const eventId = `evt_${runId}_${seq}`;
        insert.run(
          runId,
          seq,
          eventId,
          draft.type,
          payloads[index],
          draft.upstreamCase ?? null,
          attempt,
          createdAt
        );
        delivery = advanceDelivery(delivery, draft.type);
        events.push({
          version: UNIFIED_EVENT_VERSION,
          eventId,
          runId,
          conversationId,
          seq,
          type: draft.type,
          attempt,
          ...(draft.upstreamCase ? { upstreamCase: draft.upstreamCase } : {}),
          payload: draft.payload,
          createdAt
        });
      }
      // delivery_state 与事件在同一个事务里推进：它是 G9 判断「断线后重跑是否安全」的唯一依据，
      // 分开写就会出现「事件已交付但状态还说什么都没发过」的窗口。
      this.db
        .prepare("UPDATE cc_runs SET last_event_seq = ?, delivery_state = ? WHERE id = ?")
        .run(seq, delivery, runId);
      // 会话级水位同样在这里推进，否则 latest_event_seq 永远是 0。
      this.db
        .prepare("UPDATE cc_conversations SET latest_event_seq = MAX(latest_event_seq, ?), updated_at = ? WHERE id = ?")
        .run(seq, createdAt, conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return events;
  }

  /**
   * Last-Event-ID 补发：返回 seq 严格大于 afterSeq 的事件。
   * `limit` 是单页上限，**调用方必须翻页翻到空**——只查一页就切 live 会把中间那段永久丢掉。
   */
  eventsAfter(runId: string, afterSeq = 0, limit = 1000): UnifiedEvent[] {
    const conversationId = (this.db.prepare("SELECT conversation_id FROM cc_runs WHERE id = ?").get(runId)
      ?.conversation_id ?? "") as string;
    return this.db
      .prepare("SELECT * FROM cc_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(runId, afterSeq, limit)
      .map((row) => mapEvent(row, conversationId));
  }

  /**
   * 从 event_id 解析 seq。格式是 `evt_<runId>_<seq>`，解析不出来按 0（全量重放）。
   *
   * 值来自不可信的 `Last-Event-ID` 头，所以还要**夹到本 run 的真实水位**：
   * 一个超大的数字会让 `eventsAfter` 什么都查不到，客户端拿到一个空流且没有任何报错。
   * `Number()` 还认十六进制和科学计数法，所以只收十进制。
   */
  seqFromEventId(runId: string, eventId: string | undefined): number {
    if (!eventId) return 0;
    const prefix = `evt_${runId}_`;
    if (!eventId.startsWith(prefix)) return 0;
    const digits = eventId.slice(prefix.length);
    if (!/^\d+$/.test(digits)) return 0;
    const seq = Number(digits);
    if (!Number.isSafeInteger(seq) || seq <= 0) return 0;
    return Math.min(seq, this.run(runId)?.lastEventSeq ?? 0);
  }

  /* ---------------------------------------------------------- 工具调用 */

  /**
   * 记录一个完整的工具调用。`UNIQUE(run_id, call_id)` 是幂等的实现基础：
   * 重复的完成帧不会变成第二条记录。
   */
  recordToolCall(input: {
    runId: string;
    callId: string;
    toolName: string;
    args: unknown;
    toolIndex?: number;
    status?: ToolCallStatus;
    parentCallId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cc_tool_calls (run_id, call_id, tool_name, arguments_json, tool_index, status, is_error, parent_call_id, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(run_id, call_id) DO UPDATE SET
           tool_name = excluded.tool_name,
           arguments_json = excluded.arguments_json,
           tool_index = excluded.tool_index,
           status = excluded.status
         -- 已经提交过结果的调用不能被重新记录降级回 complete：
         -- 那会让重连后的循环把同一个工具再执行一次，幂等就白做了。
         WHERE cc_tool_calls.status != 'submitted'`
      )
      .run(
        input.runId,
        input.callId,
        input.toolName,
        JSON.stringify(input.args ?? {}),
        input.toolIndex ?? null,
        input.status ?? "complete",
        input.parentCallId ?? null,
        this.iso()
      );
  }

  /**
   * 提交工具结果。返回 false 表示这一条**已经提交过**，调用方不应据此再发一轮推理。
   * 重复提交是常态（客户端重试、SSE 重连后重放），必须幂等。
   */
  submitToolResult(runId: string, callId: string, result: unknown, isError = false): boolean {
    // UPDATE 本身就是闸门，不再"先查再写"：并发下两个提交者会同时读到 complete、
    // 同时返回 true，然后各自再发一轮推理——正是 UNIQUE(run_id, call_id) 想挡住的重复计费。
    const changed = this.db
      .prepare(
        `UPDATE cc_tool_calls SET status = 'submitted', result_json = ?, is_error = ?, completed_at = ?
         WHERE run_id = ? AND call_id = ? AND status != 'submitted'`
      )
      .run(JSON.stringify(result ?? null), isError ? 1 : 0, this.iso(), runId, callId);
    return Number(changed.changes) > 0;
  }

  toolCalls(runId: string): CcToolCall[] {
    return this.db
      .prepare("SELECT * FROM cc_tool_calls WHERE run_id = ? ORDER BY COALESCE(tool_index, 0), rowid")
      .all(runId)
      .map(mapToolCall);
  }

  pendingToolCalls(runId: string): CcToolCall[] {
    return this.toolCalls(runId).filter((call) => call.status !== "submitted");
  }

  /* ------------------------------------------------------------ 任务 */

  createTask(input: {
    taskId?: string;
    runId: string;
    parentTaskId?: string;
    taskType: string;
    depth: number;
    requestedModel?: string;
    parametersJson?: string;
  }): CcTask {
    const taskId = input.taskId ?? this.newId();
    const ts = this.iso();
    this.db
      .prepare(
        `INSERT INTO cc_tasks (task_id, run_id, parent_task_id, task_type, status, depth, requested_model, parameters_json, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)`
      )
      .run(
        taskId,
        input.runId,
        input.parentTaskId ?? null,
        input.taskType,
        input.depth,
        input.requestedModel ?? null,
        input.parametersJson ?? null,
        ts,
        ts
      );
    return this.task(taskId)!;
  }

  task(taskId: string): CcTask | undefined {
    const row = this.db.prepare("SELECT * FROM cc_tasks WHERE task_id = ?").get(taskId);
    return row ? mapTask(row) : undefined;
  }

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    this.db.prepare("UPDATE cc_tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, this.iso(), taskId);
  }

  tasksForRun(runId: string): CcTask[] {
    return this.db.prepare("SELECT * FROM cc_tasks WHERE run_id = ? ORDER BY rowid").all(runId).map(mapTask);
  }

  /* ------------------------------------------------------------ 摘要 */

  /**
   * 写入 summary checkpoint。`sourceHash` 用来挡住对同一段消息的重复摘要。
   * 原始事件**不删**，只记录被覆盖到哪个 seq。
   */
  createSummary(input: {
    id?: string;
    conversationId: string;
    runId: string;
    coveredThroughSeq: number;
    summaryText: string;
    model?: string;
    parametersJson?: string;
    sourceHash: string;
  }): CcSummary {
    // 去重交给 UNIQUE 索引，不再先查再写：并发下"两个都没查到"会插出两行。
    this.db
      .prepare(
        `INSERT INTO cc_summaries (id, conversation_id, run_id, covered_through_seq, summary_text, summary_json, model, parameters_json, source_hash, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, source_hash) DO NOTHING`
      )
      .run(
        input.id ?? this.newId(),
        input.conversationId,
        input.runId,
        input.coveredThroughSeq,
        input.summaryText,
        input.model ?? null,
        input.parametersJson ?? null,
        input.sourceHash,
        this.iso()
      );
    const row = this.db
      .prepare("SELECT * FROM cc_summaries WHERE conversation_id = ? AND source_hash = ?")
      .get(input.conversationId, input.sourceHash);
    return mapSummary(row!);
  }

  summary(id: string): CcSummary | undefined {
    const row = this.db.prepare("SELECT * FROM cc_summaries WHERE id = ?").get(id);
    return row ? mapSummary(row) : undefined;
  }

  latestSummary(conversationId: string): CcSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_summaries WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(conversationId);
    return row ? mapSummary(row) : undefined;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private mapCredential(row: Record<string, unknown>): CcCredential {
    return {
      id: row.id as string,
      label: optional(row.label),
      sessionToken: this.reveal(row.encrypted_session_token as string),
      tokenType: optional(row.token_type),
      machineId: row.machine_id as string,
      macMachineId: optional(row.mac_machine_id),
      clientVersion: row.client_version as string,
      clientOs: optional(row.client_os),
      clientArch: optional(row.client_arch),
      clientOsVersion: optional(row.client_os_version),
      deviceType: optional(row.device_type),
      clientKey: optional(row.client_key),
      sessionId: optional(row.session_id),
      timezone: optional(row.timezone),
      status: row.status as string,
      allowedModels: parseList(optional(row.allowed_models)),
      excludedModels: parseList(optional(row.excluded_models)),
      failureCount: Number(row.failure_count ?? 0),
      lastUsedAt: optional(row.last_used_at),
      lastError: optional(row.last_error),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      sourceCursorKeyId: optional(row.source_cursor_key_id)
    };
  }
}

function parseList(json: string | undefined): string[] | undefined {
  if (!json) return undefined;
  const parsed = safeParse(json);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * 事件类型 → delivery_state 的推进。
 * 只有**有上游帧支撑**的内容事件才算「已交付」：网关自造的 run.accepted 之类重跑一定能重来，
 * 而已经发出去的模型文本重跑会重复。
 */
function advanceDelivery(current: DeliveryState, type: string): DeliveryState {
  if (current === "complete") return current;
  if (type === "run.completed") return "complete";
  if (type === "text.delta" || type === "text.final" || type === "thinking.delta") return "partial_delivered";
  return current;
}

function mapConversation(row: Record<string, unknown>): CcConversation {
  return {
    id: row.id as string,
    ownerHash: row.owner_hash as string,
    upstreamConversationId: row.upstream_conversation_id as string,
    upstreamConversationGroupId: optional(row.upstream_conversation_group_id),
    defaultModel: optional(row.default_model),
    stickyCredentialId: optional(row.sticky_credential_id),
    latestSummaryId: optional(row.latest_summary_id),
    latestEventSeq: Number(row.latest_event_seq ?? 0),
    status: row.status as string
  };
}

function mapRun(row: Record<string, unknown>): CcRun {
  const usageJson = optional(row.usage_json);
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    parentRunId: optional(row.parent_run_id),
    parentToolCallId: optional(row.parent_tool_call_id),
    upstreamInvocationId: optional(row.upstream_invocation_id),
    requestedModel: row.requested_model as string,
    resolvedModel: optional(row.resolved_model),
    parametersJson: optional(row.parameters_json),
    background: Number(row.background) === 1,
    status: row.status as RunStatus,
    attempt: Number(row.attempt ?? 0),
    deliveryState: row.delivery_state as DeliveryState,
    lastEventSeq: Number(row.last_event_seq ?? 0),
    usage: usageJson ? (safeParse(usageJson) as RequestUsage | undefined) : undefined,
    errorJson: optional(row.error_json),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    startedAt: optional(row.started_at),
    finishedAt: optional(row.finished_at)
  };
}

function mapEvent(row: Record<string, unknown>, conversationId: string): UnifiedEvent {
  return {
    version: UNIFIED_EVENT_VERSION,
    eventId: row.event_id as string,
    runId: row.run_id as string,
    conversationId,
    seq: Number(row.seq),
    type: row.event_type as UnifiedEventType,
    attempt: Number(row.attempt ?? 0),
    ...(row.upstream_case ? { upstreamCase: row.upstream_case as string } : {}),
    payload: (safeParse(row.payload_json as string) as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string
  };
}

function mapToolCall(row: Record<string, unknown>): CcToolCall {
  return {
    runId: row.run_id as string,
    callId: row.call_id as string,
    toolName: row.tool_name as string,
    argumentsJson: row.arguments_json as string,
    toolIndex: row.tool_index === null || row.tool_index === undefined ? undefined : Number(row.tool_index),
    status: row.status as ToolCallStatus,
    resultJson: optional(row.result_json),
    isError: Number(row.is_error) === 1,
    parentCallId: optional(row.parent_call_id),
    idempotencyKey: optional(row.idempotency_key),
    requestedAt: row.requested_at as string,
    completedAt: optional(row.completed_at)
  };
}

function mapTask(row: Record<string, unknown>): CcTask {
  return {
    taskId: row.task_id as string,
    runId: row.run_id as string,
    parentTaskId: optional(row.parent_task_id),
    taskType: row.task_type as string,
    status: row.status as TaskStatus,
    depth: Number(row.depth ?? 0),
    requestedModel: optional(row.requested_model),
    parametersJson: optional(row.parameters_json),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    retryCount: Number(row.retry_count ?? 0),
    nextRunAt: optional(row.next_run_at)
  };
}

function mapSummary(row: Record<string, unknown>): CcSummary {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    runId: row.run_id as string,
    coveredThroughSeq: Number(row.covered_through_seq),
    summaryText: row.summary_text as string,
    model: optional(row.model),
    parametersJson: optional(row.parameters_json),
    sourceHash: row.source_hash as string,
    createdAt: row.created_at as string
  };
}

/** 空串一律当成"没提供"。`?? null` 只挡 undefined，会让一个空字符串抹掉已有的值。 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
