import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";
import { maskKey } from "./key-pool.js";
import type { GatewayKeyPatch, GatewayKeyRecord, ModelScope, StateStore } from "./types.js";

/**
 * 入站密钥的最小长度。入站密钥是整个网关唯一的对外门禁，
 * 4 个字符的密钥在公网上几乎等同于不设防，因此在写入前就挡住。
 */
export const MIN_GATEWAY_KEY_LENGTH = 16;

/** generateKey 的随机字节数：32 字节 = 256 bit 熵，base64url 后 43 个字符。 */
const GENERATED_KEY_BYTES = 32;

/** 生成密钥的前缀，方便在日志/配置里一眼认出这是网关入站密钥而不是 Cursor key。 */
const GENERATED_KEY_PREFIX = "gw-";

/** 快照里的一条：记录本身 + 预算好的定长摘要，供 resolve 做等长的时间安全比对。 */
interface SnapshotEntry {
  digest: Buffer;
  record: GatewayKeyRecord;
}

/**
 * 网关入站密钥池（客户端调用本网关时用的密钥，不是 Cursor key）。
 *
 * 与 CursorKeyPool 最大的不同是这里持有一份内存快照：authenticate() 是同步的，
 * 且是八个路由处理器的第一行调用，改成 async 会波及所有端点，还会给每个请求加一次 SQLite 读。
 * 因此启动时 refresh() 一次把整表载入内存，之后每次经由本池的变更都会刷新快照，
 * 后台改动无需重启即刻生效；绕过本池直接写库则需要调用方自行 refresh()。
 */
export class GatewayKeyPool {
  /** 快照主体：apiKey → 记录。含 disabled，供 hasAnyKey / resolveAny 使用。 */
  private snapshot = new Map<string, GatewayKeyRecord>();
  /** 与 snapshot 同源的摘要索引，仅为 resolve 的定长比对服务。 */
  private entries: SnapshotEntry[] = [];

  constructor(private readonly store: StateStore) {}

  /** 从库里载入快照；启动时与每次变更后调用。 */
  async refresh(): Promise<void> {
    const records = await this.store.listGatewayKeys();
    this.snapshot = new Map(records.map((record) => [record.apiKey, record]));
    this.entries = records.map((record) => ({ digest: digest(record.apiKey), record }));
  }

  /** 同步解析 token → 记录，供 authenticate 用。只返回 active 的。 */
  resolve(token: string): GatewayKeyRecord | undefined {
    const record = this.match(token);
    return record?.status === "active" ? record : undefined;
  }

  /**
   * 同步解析 token → 记录，含 disabled。
   * authenticate 用它区分「未知 token」与「认识但已停用的密钥」：
   * 后者必须直接 401，不能顺着 direct 分支被当成客户端自带的 Cursor key 放行。
   */
  resolveAny(token: string): GatewayKeyRecord | undefined {
    return this.match(token);
  }

  /** 快照里是否有任何一条（含 disabled），用于判断是否启用了多密钥模式。 */
  hasAnyKey(): boolean {
    return this.snapshot.size > 0;
  }

  async list(): Promise<GatewayKeyRecord[]> {
    return this.store.listGatewayKeys();
  }

  /**
   * 把当前 env 的 GATEWAY_API_KEY 播种进库，并停用已经不再由 env 管理的旧记录。
   * 旧记录不能删除：临时撤掉变量也应保留请求计数与创建时间，且同值恢复时不能无意复活。
   */
  async seedFromEnv(apiKey: string | undefined): Promise<void> {
    const trimmed = apiKey?.trim() || undefined;
    const records = await this.store.listGatewayKeys();
    for (const record of records) {
      if (record.source !== "env" || record.apiKey === trimmed || record.status === "disabled") continue;
      // 只停用旧行而不删除，才能让撤掉配置的动作既立即收回权限又不抹掉审计轨迹。
      await this.store.updateGatewayKey(record.id, { status: "disabled" });
    }
    const existing = trimmed ? records.find((record) => record.apiKey === trimmed) : undefined;
    if (trimmed && !existing) {
      await this.store.insertGatewayKey({
        id: randomUUID(),
        apiKey: trimmed,
        label: `env-${maskKey(trimmed)}`,
        status: "active",
        source: "env",
        // env 主密钥默认不设任何限制，保持升级前「一把钥匙通全池」的行为。
        allowedCursorKeyIds: [],
        modelScope: emptyScope(),
        requestCount: 0,
        createdAt: new Date().toISOString()
      });
    }
    await this.refresh();
  }

  async add(
    apiKey: string,
    options: { label?: string; allowedCursorKeyIds?: string[]; modelScope?: ModelScope } = {}
  ): Promise<GatewayKeyRecord> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new ApiError("网关 API 密钥不能为空。", 400, "invalid_request_error", "key");
    if (trimmed.length < MIN_GATEWAY_KEY_LENGTH) {
      throw new ApiError(
        `网关 API 密钥至少需要 ${MIN_GATEWAY_KEY_LENGTH} 个字符，太短的密钥容易被猜到。`,
        400,
        "invalid_request_error",
        "key"
      );
    }
    const existing = await this.store.getGatewayKeyByValue(trimmed);
    if (existing) throw new ApiError("该网关 API 密钥已存在。", 409, "key_exists", "key");
    const record: GatewayKeyRecord = {
      id: randomUUID(),
      apiKey: trimmed,
      label: options.label?.trim() || maskKey(trimmed),
      status: "active",
      source: "manual",
      allowedCursorKeyIds: normalizeIds(options.allowedCursorKeyIds),
      modelScope: normalizeScope(options.modelScope),
      requestCount: 0,
      createdAt: new Date().toISOString()
    };
    await this.store.insertGatewayKey(record);
    await this.refresh();
    return record;
  }

  /**
   * 生成一个高强度随机密钥，供后台「一键生成」。
   * 32 字节 CSPRNG = 256 bit 熵，远超暴力破解可及范围；base64url 保证可直接放进
   * Authorization 头与 URL，不会因转义变形。
   */
  static generateKey(): string {
    return `${GENERATED_KEY_PREFIX}${randomBytes(GENERATED_KEY_BYTES).toString("base64url")}`;
  }

  async update(id: string, patch: GatewayKeyPatch): Promise<GatewayKeyRecord | undefined> {
    // 绑定列表与模型范围来自后台表单，先去空去重再落库，避免脏值污染快照与后续的交集运算。
    const normalized: GatewayKeyPatch = {
      ...patch,
      ...(patch.allowedCursorKeyIds === undefined
        ? {}
        : { allowedCursorKeyIds: normalizeIds(patch.allowedCursorKeyIds) }),
      ...(patch.modelScope === undefined ? {} : { modelScope: normalizeScope(patch.modelScope) })
    };
    const changed = await this.store.updateGatewayKey(id, normalized);
    if (!changed) return undefined;
    await this.refresh();
    return this.get(id);
  }

  async enable(id: string): Promise<boolean> {
    return this.setStatus(id, "active");
  }

  async disable(id: string): Promise<boolean> {
    return this.setStatus(id, "disabled");
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.store.deleteGatewayKey(id);
    if (removed) await this.refresh();
    return removed;
  }

  async get(id: string): Promise<GatewayKeyRecord | undefined> {
    return (await this.store.listGatewayKeys()).find((key) => key.id === id);
  }

  /** 记账一次使用（异步、调用方 fire-and-forget）。 */
  async recordUse(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.store.updateGatewayKey(id, { lastUsedAt: now, incrementRequestCount: true });
    // 记账在请求热路径上，且只动计数不动身份/启停，就地补快照即可，不值得为它整表 refresh。
    const cached = this.findInSnapshot(id);
    if (cached) {
      cached.requestCount += 1;
      cached.lastUsedAt = now;
    }
  }

  private async setStatus(id: string, status: GatewayKeyRecord["status"]): Promise<boolean> {
    const changed = await this.store.updateGatewayKey(id, { status });
    if (changed) await this.refresh();
    return changed;
  }

  private findInSnapshot(id: string): GatewayKeyRecord | undefined {
    for (const record of this.snapshot.values()) {
      if (record.id === id) return record;
    }
    return undefined;
  }

  /**
   * 时间安全地把 token 比对快照里的每一条密钥。
   * 两处刻意的处理：
   * 1) 两侧先各自 sha256 成定长 32 字节再比。timingSafeEqual 要求入参等长，
   *    直接比原文遇到长度不同会抛错或提前返回，把「正确密钥有多长」泄漏出去；
   *    摘要固定长度，长度差异不再产生任何可观测的分支。
   * 2) 命中后不 break，始终扫完整表，避免响应时间随命中位置变化而泄漏密钥在表中的排序。
   * 旧的单密钥路径仍用明文 === 比较（保持既有行为逐字节不变），这里是对新路径的主动加固。
   */
  private match(token: string): GatewayKeyRecord | undefined {
    if (!token || !this.entries.length) return undefined;
    const probe = digest(token);
    let matched: GatewayKeyRecord | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(probe, entry.digest)) matched = entry.record;
    }
    return matched;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function emptyScope(): ModelScope {
  return { allowed: [], excluded: [] };
}

/** 去掉空串与重复项：后台表单常带上空行，脏值会让「不限制」的判断（长度为 0）失真。 */
function normalizeIds(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function normalizeScope(scope: ModelScope | undefined): ModelScope {
  return { allowed: normalizeIds(scope?.allowed), excluded: normalizeIds(scope?.excluded) };
}
