import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import type { CursorKeyRecord, StateStore } from "./types.js";

export type KeyFailureKind = "quota" | "auth" | "transient";

/** 自动禁用策略：连续失败达到 threshold 次才禁用；enabled=false 时永不自动禁用，只轮换。 */
export interface AutoDisablePolicy {
  enabled: boolean;
  threshold: number;
}

/**
 * 默认连续失败 2 次才禁用：上游偶发的额度/认证抖动（Cursor 侧会话问题、瞬时误报）不该一次就废掉一个好 key，
 * 真正失效的 key 也只多浪费一次尝试就会被禁用。
 */
export const DEFAULT_AUTO_DISABLE_THRESHOLD = 2;

/**
 * Cursor key 池：网关模式下按后台设置的顺序（sort_order 升序）取第一个 active key；
 * 上游报错时由 KeyRotatingRunner 调用 reportFailure 记账，达到自动禁用策略的阈值才禁用并换下一个。
 * 被禁用的 key 仅支持人工在管理后台重新启用；启用会清空失败计数，不会被上一次的旧错误立刻再禁掉。
 */
export class CursorKeyPool {
  private policy: AutoDisablePolicy;

  constructor(private readonly store: StateStore, policy: Partial<AutoDisablePolicy> = {}) {
    this.policy = normalizePolicy({ enabled: true, threshold: DEFAULT_AUTO_DISABLE_THRESHOLD }, policy);
  }

  get autoDisablePolicy(): AutoDisablePolicy {
    return { ...this.policy };
  }

  /** 后台改设置后即时生效，无需重启进程。 */
  setAutoDisablePolicy(patch: Partial<AutoDisablePolicy>): AutoDisablePolicy {
    this.policy = normalizePolicy(this.policy, patch);
    return this.autoDisablePolicy;
  }

  /** 把环境变量里的 key 幂等地播种进库（已存在的不动，保留其启停状态与排序）。 */
  async seedFromEnv(keys: string[]): Promise<void> {
    for (const apiKey of keys) {
      const existing = await this.store.getCursorKeyByValue(apiKey);
      if (existing) continue;
      await this.store.insertCursorKey({
        id: randomUUID(),
        apiKey,
        label: `env-${maskKey(apiKey)}`,
        status: "active",
        source: "env",
        sortOrder: await this.nextSortOrder(),
        requestCount: 0,
        failureCount: 0,
        createdAt: new Date().toISOString()
      });
    }
  }

  async list(): Promise<CursorKeyRecord[]> {
    return this.store.listCursorKeys();
  }

  async pickActive(excludedIds: ReadonlySet<string>): Promise<CursorKeyRecord | undefined> {
    const keys = await this.store.listCursorKeys();
    return keys.find((key) => key.status === "active" && !excludedIds.has(key.id));
  }

  async hasAnyKey(): Promise<boolean> {
    return (await this.store.listCursorKeys()).length > 0;
  }

  async add(apiKey: string, label?: string): Promise<CursorKeyRecord> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new ApiError("Cursor key must not be empty.", 400, "invalid_request_error", "key");
    const existing = await this.store.getCursorKeyByValue(trimmed);
    if (existing) throw new ApiError("This Cursor key already exists.", 409, "key_exists", "key");
    const record: CursorKeyRecord = {
      id: randomUUID(),
      apiKey: trimmed,
      label: label?.trim() || maskKey(trimmed),
      status: "active",
      source: "manual",
      sortOrder: await this.nextSortOrder(),
      requestCount: 0,
      failureCount: 0,
      createdAt: new Date().toISOString()
    };
    await this.store.insertCursorKey(record);
    return record;
  }

  /** 按给定 id 序列调整取用顺序；id 必须全部存在于池中。 */
  async reorder(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new ApiError("ids must be a non-empty array of key ids.", 400, "invalid_request_error", "ids");
    }
    const known = new Set((await this.store.listCursorKeys()).map((key) => key.id));
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw new ApiError(`Unknown key id: ${unknown}`, 404, "not_found", "ids");
    await this.store.reorderCursorKeys(ids);
  }

  private async nextSortOrder(): Promise<number> {
    const keys = await this.store.listCursorKeys();
    return keys.reduce((max, key) => Math.max(max, key.sortOrder), 0) + 1;
  }

  async remove(id: string): Promise<boolean> {
    return this.store.deleteCursorKey(id);
  }

  /** 人工启用：连同失败计数与旧错误一起清干净，否则刚启用就会被上一次的失败streak立刻再禁掉。 */
  async enable(id: string): Promise<boolean> {
    return this.store.updateCursorKey(id, {
      status: "active",
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      failureCount: 0
    });
  }

  async disable(id: string, kind: "quota" | "auth" | "manual", detail?: string): Promise<boolean> {
    const reason = kind === "quota" ? "额度不足" : kind === "auth" ? "key 无效/未授权" : "手动禁用";
    return this.store.updateCursorKey(id, {
      status: "disabled",
      disabledReason: reason,
      disabledAt: new Date().toISOString(),
      lastError: detail ? truncate(detail, 500) : null,
      // 人工禁用是运维动作而非 key 变坏，计数归零，避免启用后残留旧 streak。
      ...(kind === "manual" ? { failureCount: 0 } : {})
    });
  }

  /**
   * 记录一次 key 级失败并按策略决定是否禁用，返回是否真的禁用了。
   * - transient：原因不明（上游临时容量/会话问题），只留错误痕迹，不计入自动禁用。
   * - quota/auth：累计连续失败次数，达到阈值且开启自动禁用时才禁；否则本次只是软失败，换下一个 key。
   */
  async reportFailure(id: string, kind: KeyFailureKind, detail?: string): Promise<boolean> {
    const lastError = detail ? truncate(detail, 500) : null;
    if (kind === "transient") {
      await this.store.updateCursorKey(id, { lastError });
      return false;
    }
    await this.store.updateCursorKey(id, { lastError, incrementFailureCount: true });
    if (!this.policy.enabled) return false;
    const failures = (await this.get(id))?.failureCount ?? 1;
    if (failures < this.policy.threshold) return false;
    return this.disable(id, kind, detail);
  }

  /** 一次成功即认为 key 健康：清空连续失败计数与残留错误，让后台不再挂着早已恢复的红字。 */
  async recordSuccess(id: string): Promise<void> {
    await this.store.updateCursorKey(id, { failureCount: 0, lastError: null });
  }

  async recordUse(id: string): Promise<void> {
    await this.store.updateCursorKey(id, {
      lastUsedAt: new Date().toISOString(),
      incrementRequestCount: true
    });
  }

  async get(id: string): Promise<CursorKeyRecord | undefined> {
    return (await this.store.listCursorKeys()).find((key) => key.id === id);
  }
}

function normalizePolicy(current: AutoDisablePolicy, patch: Partial<AutoDisablePolicy>): AutoDisablePolicy {
  const threshold = patch.threshold;
  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    threshold: typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1
      ? Math.floor(threshold)
      : current.threshold
  };
}

/**
 * Cursor 侧的会话态认证抖动，而不是 key 失效：上游 agent 会话没鉴权成功时会原样吐出 IDE 的那句
 * "Authentication error. If you are logged in, try logging out and back in."。
 * 同一个 key 前后都能正常跑，据此永久禁用会误伤好 key，因此按 transient 处理：换下一个 key，但不禁用。
 */
const SESSION_AUTH_HICCUP = /log(ging)? ?out and (log ?)?back in|sign(ing)? ?out and (sign ?)?back in/i;

/**
 * 仅凭错误文本（不看 HTTP 状态码）判断额度/认证类失败的关键词归因，quota 优先于 auth。
 * 两处复用：
 * 1) classifyKeyFailure：结合状态码判定 key 轮换语义；
 * 2) cursor-runner：SDK run 以 error 收场但带出详情时，据此把固定的 upstream_run_failed
 *    解耦为更精确的 402/401，让真正额度耗尽/失效的 key 能被禁用，而非被 transient 吞掉一直占着队首。
 */
export function classifyErrorText(text: string): "quota" | "auth" | undefined {
  if (SESSION_AUTH_HICCUP.test(text)) return undefined;
  if (
    /usage[ _-]?limit|quota|payment required|unpaid invoice|past due invoice|pay your invoice|spend(ing)? limit|usage[ -]?based|free trial/i.test(text) ||
    /insufficient\s+(credit|balance|fund|quota)|(credit|balance|quota)s?\s+(is|are)?\s*(insufficient|exhausted|depleted)/i.test(text) ||
    /out of credit|no (remaining|more) (credit|quota|request)|run out of|hard limit reached|limit (reached|exceeded)/i.test(text)
  ) {
    return "quota";
  }
  if (
    /invalid (api ?)?(key|token)|api ?key (is )?(invalid|expired|revoked|disabled|not found)|unauthorized|authentication (fail|error)|not authenticated/i.test(text)
  ) {
    return "auth";
  }
  return undefined;
}

/**
 * 错误是否属于「上游鉴权失败」。用于判断要不要回收 SDK 的共享本地执行器：
 * 执行器的鉴权拦截器把「API key → access token 兑换」的失败**永久**缓存在闭包里，
 * 命中之后该执行器上的每个请求都立刻重抛同一个错误，没有 TTL 也没有自愈路径，
 * 只有执行器被 dispose 才能恢复。
 * 覆盖三类：明确的 401/无效 key、Cursor 会话态认证抖动、SDK 自己的 key 兑换失败文案。
 * 额度类失败不在此列——它不会被闭包缓存，回收执行器解决不了问题。
 */
export function indicatesUpstreamAuthFailure(error: unknown): boolean {
  const { statuses, text } = collectErrorInfo(error);
  if (statuses.includes(429) || /rate[ _-]?limit/i.test(text)) return false;
  if (SESSION_AUTH_HICCUP.test(text)) return true;
  if (/api key exchange|no access token|unauthenticated/i.test(text)) return true;
  if (statuses.includes(401)) return true;
  return classifyErrorText(text) === "auth";
}

/** 上游临时性 429 / rate limit：不该轮换 key，也不该按 500 透出，应映射成 429 让客户端退避重试。 */
export function isRateLimitError(error: unknown): boolean {
  const { statuses, text } = collectErrorInfo(error);
  return statuses.includes(429) || /rate[ _-]?limit/i.test(text);
}

/**
 * 判断上游错误对 key 轮换的含义。
 * - quota：额度/配额耗尽（402、usage limit、quota、credit 等）→ 计入连续失败，达到阈值后禁用并换下一个。
 * - auth：key 无效/被吊销（401、invalid api key 等）→ 同上。
 * - transient：原因不确定的软失败——上游以"无详情 error"收场（网关自抛的 upstream_run_failed），
 *   或 Cursor 会话态认证抖动。换下一个 key 重试但从不计入自动禁用，避免把临时故障误判成永久而误伤好 key。
 * - undefined：临时性 429 rate limit、网络/超时等非 key 级错误 → 让上层原样抛出，不换 key。
 *
 * 注意 transient 判定优先于 quota/auth：upstream_run_failed 的文案本身会提到 quota 等字样，
 * 必须先按 code 命中 transient，否则会被 quota 正则误判为额度耗尽而错误禁用。
 */
export function classifyKeyFailure(error: unknown): KeyFailureKind | undefined {
  const { statuses, text } = collectErrorInfo(error);
  if (statuses.includes(429) || /rate[ _-]?limit/i.test(text)) return undefined;
  if (/\bupstream_run_failed\b/.test(text)) return "transient";
  // 会话态认证抖动优先于 401：状态码同样不足以证明 key 本身失效，只换 key 不禁用。
  if (SESSION_AUTH_HICCUP.test(text)) return "transient";
  if (statuses.includes(402)) return "quota";
  const byText = classifyErrorText(text);
  if (byText === "quota") return "quota";
  if (statuses.includes(401)) return "auth";
  if (byText === "auth") return "auth";
  if (statuses.includes(403) && /key|token|credential/i.test(text)) return "auth";
  return undefined;
}

export function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 10) return `${trimmed.slice(0, 3)}***`;
  return `${trimmed.slice(0, 7)}***${trimmed.slice(-4)}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function collectErrorInfo(error: unknown): { statuses: number[]; text: string } {
  const statuses: number[] = [];
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "string") {
      texts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    for (const field of ["status", "statusCode", "httpStatus"]) {
      const value = record[field];
      if (typeof value === "number") statuses.push(value);
    }
    for (const field of ["message", "code", "type", "detail", "error"]) {
      const value = record[field];
      if (typeof value === "string") texts.push(value);
    }
    current = record.cause;
  }
  return { statuses, text: texts.join(" | ") };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
