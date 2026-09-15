import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskKey } from "./key-pool.js";
import type { AbortReason, KeyUsageRef, RunTelemetryRef } from "./types.js";

/**
 * Debug 快照（计划 §3.1 包 D）。
 *
 * 每个请求一条 JSON，文件名 = logId，与 request_logs 的行一一对应。
 * 存在的理由与 durable-telemetry 相同：线上出问题时不能要求运维去翻 stdout，
 * 而 499 / 轮次错位这两类问题的证据（入站原文、选路、上游轮次全文、abort 三值）
 * 只在请求路径上出现一次，错过就没了。
 *
 * 安全红线：任何落盘文本先过 maskSecrets；authorization / x-api-key 头直接 maskKey；
 * JSON 全文里的 Bearer / sk- / crsr_ / crsk_ / ghp_ / JWT 一律替换。开关默认关，且按 owner / endpoint /
 * 模型过滤，避免全量刷盘。
 *
 * 本模块是**纯观测**：任何 record 调用失败都不许影响请求本身（全部吞掉 + console.error）。
 */

/** 快照格式版本。字段演进时递增，读取端按版本解释。 */
export const DEBUG_SNAPSHOT_VERSION = 1;

/** 单条快照的体积与内存预算（字节）。全文取证是本模块的意义，但一条快照不能吃掉半页内存。 */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** 每写多少个快照跑一次 LRU 清理（同 store.ts REQUEST_LOG_CLEANUP_EVERY 的思路）。 */
const CLEANUP_EVERY = 20;

/** 单日默认条数上限。env / 后台可改。 */
export const DEFAULT_DEBUG_MAX_ENTRIES = 2_000;
/** 总体积默认上限（200MB）。env / 后台可改。 */
export const DEFAULT_DEBUG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** 这些头里的值等同于凭据，落盘前必须掩码。 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie"
]);

/** 按 owner / endpoint / 模型收窄落盘范围；全部留空 = 不过滤。 */
export interface DebugFilters {
  /** 匹配网关密钥 label（多密钥模式下按客户端过滤），无 label 时按 ownerHash 前缀。 */
  owner?: string;
  /** 子串匹配请求端点，如 /v1/messages。 */
  endpoint?: string;
  /** 子串匹配模型名。 */
  model?: string;
}

export interface DebugRecorderSettings {
  enabled: boolean;
  filters: DebugFilters;
  /** 单日条数上限，0 = 不限制。 */
  maxEntries: number;
  /** debug 目录总体积上限（字节），0 = 不限制。 */
  maxTotalBytes: number;
}

/** runner / bot 侧的注入点：server 在 CursorRunRequest.debugRef 上挂这里。 */
export interface DebugUpstreamSink {
  /** 上游实际发出的轮次全文（SDK 的 send 消息 / Bot 的 Connect 请求体），不摘要。 */
  noteUpstreamTurn(channel: "sdk" | "bot", payload: unknown): void;
  /** 选 key 后回填（key 明文必须先 maskKey）。 */
  noteSelectedKey(maskedApiKey: string, keyId?: string, keyLabel?: string): void;
}

/** streamAbort 的归因快照：包 C 的判据依据。 */
export interface DebugAbortAttribution {
  /** 触发 onClose 的分支：early-destroyed-check（注册监听前的早退判定）或 socket-close-listener。 */
  branch: "early-destroyed-check" | "socket-close-listener" | "idle-timeout";
  /** request.raw.destroyed——Node ≥16 在 body 读完后即为 true，不代表断连（§1.1 假设）。 */
  rawDestroyed: boolean | undefined;
  /** request.raw.complete——body 是否读完；与 rawDestroyed 联合才是有效判据。 */
  rawComplete: boolean | undefined;
  /** socket.destroyed——连接层的真实状态。 */
  socketDestroyed: boolean | undefined;
  /** controller.abort 的 reason（空闲超时是 ApiError；纯断连没有）。 */
  signalReason?: string;
  /** 归因（包 C）：与 request_logs.abortReason 同一份取值。 */
  abortReason?: AbortReason;
}

export interface DebugSnapshot {
  version: number;
  logId: string;
  startedAt: string;
  endpoint: string;
  model?: string;
  ownerLabel?: string;
  inbound?: {
    headers: Record<string, string>;
    body?: unknown;
  };
  routing?: {
    provider: string;
    model?: string;
    reason: string;
    keyId?: string;
    keyLabel?: string;
    maskedApiKey?: string;
  };
  durable?: {
    sessionId?: string;
    /** 身份瀑布命中层级（header / body-field / derived-L3 / none）：核对内容推导碰撞用。 */
    identitySource?: string;
    reuseDurableAgent?: boolean;
    turnKind?: string;
    turnUserText?: string;
    turnImages?: number;
    turnToolResults?: Array<{ id: string; isError?: boolean }>;
  };
  upstreamTurns: Array<{ at: string; channel: string; payload: unknown }>;
  sse?: {
    /** 逐事件的 SSE 原文（受单条快照预算约束）。 */
    events: string[];
    /** 预算耗尽后只计数不再留全文。 */
    omitted: number;
  };
  response?: unknown;
  abort?: DebugAbortAttribution;
  finish?: {
    status: number;
    error?: string;
    durationMs: number;
    at: string;
    agentId?: string;
    runId?: string;
  };
  truncated?: boolean;
}

/** 单请求的记录句柄。开关关闭或被过滤器排除时 open 返回 undefined，调用方全部走 ?. 短路。 */
export interface DebugSession extends DebugUpstreamSink {
  noteRouting(routing: { provider: string; model?: string; reason: string }): void;
  noteDurable(durable: NonNullable<DebugSnapshot["durable"]>): void;
  noteAbort(attribution: DebugAbortAttribution): void;
  noteSseEvent(chunk: string): void;
  noteResponse(body: unknown): void;
  /** finishLog 幂等，这里同样只落一次盘。 */
  finish(status: number, error?: string): void;
}

export interface DebugRecorder {
  open(input: DebugOpenInput): DebugSession | undefined;
  /** 后台「Debug 快照」读取端：找到就返回文件全文（已掩码），找不到返回 undefined。 */
  read(logId: string): string | undefined;
}

export interface DebugOpenInput {
  logId: string;
  endpoint: string;
  model?: string;
  ownerLabel?: string;
  ownerHash?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** finish 时读 keyId / keyLabel（可变引出通道，此刻还没填）。 */
  keyUsageRef: KeyUsageRef;
  /** finish 时读 agentId / runId（可变引出通道，此刻还没填）。 */
  telemetryRef: RunTelemetryRef;
}

export function createDebugRecorder(input: {
  rootDir: string;
  resolveSettings: () => DebugRecorderSettings;
  now?: () => Date;
}): DebugRecorder {
  const rootDir = input.rootDir;
  const now = input.now ?? (() => new Date());
  let writesSinceCleanup = 0;

  const cleanup = (): void => {
    try {
      cleanupOnce(rootDir, input.resolveSettings());
    } catch (error) {
      console.error(`[debug] snapshot cleanup failed: ${errorMessage(error)}`);
    }
  };

  return {
    open(openInput): DebugSession | undefined {
      const settings = input.resolveSettings();
      if (!settings.enabled) return undefined;
      if (!matchesFilters(settings.filters, openInput)) return undefined;

      const startedAt = now().toISOString();
      const snapshot: DebugSnapshot = {
        version: DEBUG_SNAPSHOT_VERSION,
        logId: openInput.logId,
        startedAt,
        endpoint: openInput.endpoint,
        ...(openInput.model ? { model: openInput.model } : {}),
        ...(openInput.ownerLabel ? { ownerLabel: openInput.ownerLabel } : {}),
        upstreamTurns: [],
        sse: { events: [], omitted: 0 }
      };

      let approxBytes = JSON.stringify(snapshot).length + SNAPSHOT_BUDGET_RESERVE;
      let finished = false;

      const budget = (bytes: number): boolean => approxBytes + bytes <= SNAPSHOT_MAX_BYTES;

      try {
        const headers = maskHeaders(openInput.headers);
        // 请求体与 SSE / 上游轮次一样受快照预算约束：超预算时不持有全文，只留 omitted 标记 + 字符数。
        // headers 的体积不单独计数，由 SNAPSHOT_BUDGET_RESERVE 兜底。
        let inbound: NonNullable<DebugSnapshot["inbound"]> = { headers };
        if (openInput.body !== undefined) {
          const serialized = JSON.stringify(openInput.body) ?? "null";
          if (budget(serialized.length)) {
            approxBytes += serialized.length;
            inbound = { headers, body: openInput.body };
          } else {
            inbound = { headers, body: { omittedBySizeBudget: true, bodyChars: serialized.length } };
          }
        }
        snapshot.inbound = inbound;
      } catch (error) {
        console.error(`[debug] mask inbound failed (log=${openInput.logId}): ${errorMessage(error)}`);
      }

      const session: DebugSession = {
        noteRouting(routing) {
          if (finished) return;
          snapshot.routing = { ...routing, keyId: openInput.keyUsageRef.keyId, keyLabel: openInput.keyUsageRef.keyLabel };
        },
        noteDurable(durable) {
          if (finished) return;
          snapshot.durable = durable;
        },
        noteAbort(attribution) {
          if (finished) return;
          // 归因只写一次（先到先得）：后续分支（如早退后 socket 才真关闭）不得整体覆盖已拍下的现场。
          snapshot.abort ??= attribution;
        },
        noteUpstreamTurn(channel, payload) {
          if (finished) return;
          try {
            const serialized = JSON.stringify(payload) ?? "null";
            if (budget(serialized.length)) {
              approxBytes += serialized.length;
              snapshot.upstreamTurns.push({ at: now().toISOString(), channel, payload });
            } else {
              // 预算外也要留痕：发生了第几次上游调用、payload 有多大，只是不留全文。
              snapshot.upstreamTurns.push({
                at: now().toISOString(),
                channel,
                payload: { omittedBySizeBudget: true, payloadChars: serialized.length }
              });
            }
          } catch (error) {
            console.error(`[debug] capture upstream turn failed (log=${openInput.logId}): ${errorMessage(error)}`);
          }
        },
        noteSelectedKey(maskedApiKey, keyId, keyLabel) {
          if (finished) return;
          snapshot.routing = { ...(snapshot.routing ?? { provider: "sdk", reason: "unknown" }), maskedApiKey, ...(keyId ? { keyId } : {}), ...(keyLabel ? { keyLabel } : {}) };
        },
        noteSseEvent(chunk) {
          if (finished) return;
          const sse = snapshot.sse;
          if (!sse) return;
          if (budget(chunk.length)) {
            approxBytes += chunk.length;
            sse.events.push(chunk);
          } else {
            sse.omitted += 1;
          }
        },
        noteResponse(body) {
          if (finished) return;
          try {
            const serialized = JSON.stringify(body) ?? "null";
            if (budget(serialized.length)) {
              approxBytes += serialized.length;
              snapshot.response = body;
            } else {
              snapshot.response = { omittedBySizeBudget: true, responseChars: serialized.length };
            }
          } catch (error) {
            console.error(`[debug] capture response failed (log=${openInput.logId}): ${errorMessage(error)}`);
          }
        },
        finish(status, error) {
          if (finished) return;
          finished = true;
          try {
            snapshot.finish = {
              status,
              ...(error ? { error } : {}),
              durationMs: Date.now() - Date.parse(startedAt),
              at: now().toISOString(),
              ...(openInput.telemetryRef.agentId ? { agentId: openInput.telemetryRef.agentId } : {}),
              ...(openInput.telemetryRef.runId ? { runId: openInput.telemetryRef.runId } : {})
            };
            if (snapshot.sse && !snapshot.sse.events.length && !snapshot.sse.omitted) delete snapshot.sse;
            const text = maskSecrets(JSON.stringify(snapshot, null, 2));
            const limited = text.length > SNAPSHOT_MAX_BYTES;
            const finalText = limited ? `${text.slice(0, SNAPSHOT_MAX_BYTES)}\n[truncated by snapshot size budget]` : text;
            const dir = dayDir(rootDir, now());
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${openInput.logId}.json`), finalText, "utf8");
            writesSinceCleanup += 1;
            if (writesSinceCleanup >= CLEANUP_EVERY) {
              writesSinceCleanup = 0;
              cleanup();
            }
          } catch (error) {
            console.error(`[debug] snapshot persist failed (log=${openInput.logId}): ${errorMessage(error)}`);
          }
        }
      };
      return session;
    },
    read(logId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(logId)) return undefined;
      if (!existsSync(rootDir)) return undefined;
      try {
        for (const day of readdirSync(rootDir)) {
          const file = join(rootDir, day, `${logId}.json`);
          if (existsSync(file)) return readFileSync(file, "utf8");
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
  };
}

/** 预留给 finish 补写阶段的估算余量（finish / routing / durable 等字段在 open 之后才填）。 */
const SNAPSHOT_BUDGET_RESERVE = 65_536;

function matchesFilters(filters: DebugFilters, openInput: DebugOpenInput): boolean {
  if (filters.endpoint && !openInput.endpoint.toLowerCase().includes(filters.endpoint.toLowerCase())) return false;
  if (filters.model && !(openInput.model ?? "").toLowerCase().includes(filters.model.toLowerCase())) return false;
  if (filters.owner) {
    const wanted = filters.owner.toLowerCase();
    const label = openInput.ownerLabel?.toLowerCase() ?? "";
    const hash = openInput.ownerHash?.slice(0, 16).toLowerCase() ?? "";
    if (!label.includes(wanted) && !hash.startsWith(wanted) && !hash.includes(wanted)) return false;
  }
  return true;
}

/** 敏感头掩码；其余头原样保留（取证需要完整的客户端指纹）。 */
function maskHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const flat = Array.isArray(value) ? value.join(", ") : value;
    if (flat === undefined) continue;
    masked[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? maskKey(String(flat)) : String(flat);
  }
  return masked;
}

/**
 * JSON 全文兜底掩码：请求体 / 上游轮次里可能混进凭据（Bearer 头的副本、sk- key、crsr_ / crsk_ token、ghp_ PAT、JWT）。
 * 替换只发生在字符串值内部，不会破坏 JSON 结构。
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]")
    .replace(/\b(sk-|crsr_|crsk_|ghp_)[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]");
}

function dayDir(rootDir: string, at: Date): string {
  // UTC 日期：目录名只用于分组与 LRU，不承担时区语义。
  return join(rootDir, at.toISOString().slice(0, 10));
}

/**
 * LRU 清理：单日目录内按 mtime 留最新 maxEntries 条；全局体积超限时从最旧的天 / 最旧的文件开始删。
 * 目录扫失败（并发写 / 平台差异）按尽力而为处理，绝不抛。
 */
function cleanupOnce(rootDir: string, settings: DebugRecorderSettings): void {
  if (!existsSync(rootDir)) return;
  const days = readdirSync(rootDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const day of days) {
    const dir = join(rootDir, day);
    // 单日目录读取失败（并发写 / 平台差异）：跳过该日，不让整个 cleanup 中断。
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const stats = statSync(path);
        files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        // 文件在扫描与 stat 之间被删/被写：跳过即可。
      }
    }
  }
  // 总体积：从最旧开始删到预算内。
  if (settings.maxTotalBytes > 0) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > settings.maxTotalBytes) {
      const byOldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
      let excess = total - settings.maxTotalBytes;
      for (const file of byOldest) {
        if (excess <= 0) break;
        rmSync(file.path, { force: true });
        excess -= file.size;
      }
    }
  }
  // 单日条数：仅裁今天的目录（历史目录按体积规则整体滚动，不逐日重复裁）。
  if (settings.maxEntries > 0 && days.length) {
    const today = days[days.length - 1];
    const dir = join(rootDir, today);
    const todays = files
      .filter((file) => file.path.startsWith(dir))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of todays.slice(settings.maxEntries)) {
      rmSync(file.path, { force: true });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}
