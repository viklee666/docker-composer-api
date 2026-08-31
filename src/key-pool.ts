import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import {
  denyRuleUnverifiable,
  identityAllowed,
  intersectScopes,
  modelIdentity,
  normalizeModelList,
  normalizeWeight,
  pickWeighted,
  NO_KEY_SENTINEL
} from "./routing.js";
import type {
  CursorClientTypeSetting,
  CursorKeyRecord,
  ModelIdentity,
  ModelScope,
  RoutingStrategy,
  StateStore
} from "./types.js";

export type KeyFailureKind = "quota" | "auth" | "transient";

/** 自动禁用策略：连续失败达到 threshold 次才禁用；enabled=false 时永不自动禁用，只轮换。 */
export interface AutoDisablePolicy {
  enabled: boolean;
  threshold: number;
}

/**
 * key 取用策略。
 * - strategy：fill-first 吃满 sort_order 最靠前的 key（Cursor 按 key 缓存 prompt，换 key 就丢缓存），
 *   round-robin 按 weight 加权轮询摊平各 key 用量。
 * - sessionAffinity：同一会话固定复用上次成功的 key，让后续请求继续命中上游 prompt 缓存。
 */
export interface RoutingPolicy {
  strategy: RoutingStrategy;
  sessionAffinity: boolean;
  sessionAffinityTtlMs: number;
}

export interface KeySelection {
  /** 选中的 key。 */
  key: CursorKeyRecord;
  /** 是否来自会话粘性绑定（命中缓存），用于日志与后台展示。 */
  sticky: boolean;
}

export interface PickOptions {
  /** 本次请求的模型；给了就只选能服务该模型的 key。 */
  model?: string;
  /**
   * 该模型的全部叫法，由调用方解析一次后传入（选 key 这一层拿不到 apiKey，查不了目录）。
   * 不传就只按 model 这一个名字匹配，别名可能绕过 key 的黑白名单。
   */
  modelIdentity?: ModelIdentity;
  /** 入站网关密钥的模型可见范围；与 key 自身范围求交后才是本次请求的有效范围。 */
  gatewayModelScope?: ModelScope;
  /** 网关密钥限定的 key id；空/undefined = 不限制。 */
  allowedKeyIds?: string[];
  /** 会话粘性标识（已散列）；配合 sessionAffinity 生效。 */
  sessionHash?: string;
}

/** 候选为空的原因，让上层能给出准确报错而不是笼统的额度耗尽。 */
export type NoKeyReason =
  | "none-configured"
  | "all-disabled"
  | "model-not-allowed"
  | "model-unverified"
  | "not-authorized"
  | "exhausted";

/** add() 的可选字段，保证既有三参调用不受影响。 */
export interface AddKeyOptions {
  modelScope?: ModelScope;
  weight?: number;
}

/**
 * 默认连续失败 2 次才禁用：上游偶发的额度/认证抖动（Cursor 侧会话问题、瞬时误报）不该一次就废掉一个好 key，
 * 真正失效的 key 也只多浪费一次尝试就会被禁用。
 */
export const DEFAULT_AUTO_DISABLE_THRESHOLD = 2;

/** 会话粘性绑定的默认存活时长，与 config 的 SESSION_AFFINITY_TTL_MS 默认值一致。 */
export const DEFAULT_SESSION_AFFINITY_TTL_MS = 60 * 60 * 1000;

/** 每绑定 N 次顺带清一次过期绑定：避免 session_bindings 无界增长，又不给每次请求加固定开销。 */
const SESSION_BINDING_PRUNE_EVERY = 200;

/** 轮询游标的回绕点，只为长期运行后不越过安全整数，对分布没有实际影响。 */
const ROTATION_CURSOR_MODULUS = 1_000_000_000;

/**
 * Cursor key 池：网关模式下按后台设置的顺序（sort_order 升序）取第一个 active key；
 * 上游报错时由 KeyRotatingRunner 调用 reportFailure 记账，达到自动禁用策略的阈值才禁用并换下一个。
 * 被禁用的 key 仅支持人工在管理后台重新启用；启用会清空失败计数，不会被上一次的旧错误立刻再禁掉。
 */
export class CursorKeyPool {
  private policy: AutoDisablePolicy;
  private routing: RoutingPolicy;
  /** round-robin 的进程内单调游标；只影响取用顺序，不需要跨进程一致，故不落库。 */
  private rotationCursor = 0;
  private bindCount = 0;

  constructor(
    private readonly store: StateStore,
    policy: Partial<AutoDisablePolicy> = {},
    routing: Partial<RoutingPolicy> = {}
  ) {
    this.policy = normalizePolicy({ enabled: true, threshold: DEFAULT_AUTO_DISABLE_THRESHOLD }, policy);
    // 没显式传取用策略的池保持旧行为：fill-first + 不粘会话。
    // 粘性会让同一会话跳过重新选 key，属于要由调用方按 config 显式打开的行为改变。
    this.routing = normalizeRouting(
      {
        strategy: "fill-first",
        sessionAffinity: false,
        sessionAffinityTtlMs: DEFAULT_SESSION_AFFINITY_TTL_MS
      },
      routing
    );
  }

  get autoDisablePolicy(): AutoDisablePolicy {
    return { ...this.policy };
  }

  /** 后台改设置后即时生效，无需重启进程。 */
  setAutoDisablePolicy(patch: Partial<AutoDisablePolicy>): AutoDisablePolicy {
    this.policy = normalizePolicy(this.policy, patch);
    return this.autoDisablePolicy;
  }

  get routingPolicy(): RoutingPolicy {
    return { ...this.routing };
  }

  /** 同 setAutoDisablePolicy：后台改完即时生效，无需重启进程。 */
  setRoutingPolicy(patch: Partial<RoutingPolicy>): RoutingPolicy {
    this.routing = normalizeRouting(this.routing, patch);
    return this.routingPolicy;
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
        clientType: "inherit",
        modelScope: emptyScope(),
        weight: 1,
        createdAt: new Date().toISOString()
      });
    }
  }

  async list(): Promise<CursorKeyRecord[]> {
    return this.store.listCursorKeys();
  }

  /**
   * 只读地借一把可用 key（拉模型目录用），**不推进轮询游标**。
   * 走 selectKey 会让「读目录」这个旁路动作改变下一次真正执行时选中的 key：
   * 加权轮询的配比被拉偏，两把等权 key 还会稳定退化成「目录永远读 A、执行永远打 B」，
   * 于是判定依据与执行依据分属两把 key 的目录，这正是别名绕过的温床。
   */
  async pickActive(excludedIds: ReadonlySet<string>, options?: PickOptions): Promise<CursorKeyRecord | undefined> {
    const selection = await this.select(excludedIds, options ?? {}, false);
    return "key" in selection ? selection.key : undefined;
  }

  /**
   * 带 sticky 信息与失败归因的选择入口，供 KeyRotatingRunner 使用。
   * 候选依次过 status / excludedIds / 网关密钥绑定 / 模型可见范围四道筛子，
   * 落空时按「哪一道筛干净的」回报原因，让上层能报出可操作的错误而不是笼统的额度耗尽。
   * advanceCursor=false 只用于确认「还有没有候选」：候选不会真的执行时，不能消耗轮询额度。
   */
  async selectKey(
    excludedIds: ReadonlySet<string>,
    options: PickOptions = {},
    advanceCursor = true
  ): Promise<KeySelection | { reason: NoKeyReason }> {
    return this.select(excludedIds, options, advanceCursor);
  }

  private async select(
    excludedIds: ReadonlySet<string>,
    options: PickOptions,
    advanceCursor: boolean
  ): Promise<KeySelection | { reason: NoKeyReason }> {
    const allowedKeyIds = new Set((options.allowedKeyIds ?? []).filter(Boolean));
    if (allowedKeyIds.size === 1 && allowedKeyIds.has(NO_KEY_SENTINEL)) {
      // 哨兵代表「绑定已失效」，即使池里没有任何 key 也应报权限拒绝而不是诱导客户端重试 429。
      return { reason: "not-authorized" };
    }
    const keys = await this.store.listCursorKeys();
    const active = keys.filter((key) => key.status === "active");
    let authorized: CursorKeyRecord[];
    if (allowedKeyIds.size) {
      // 绑定是入站密钥的授权边界：绑定目标全被删掉/停用时，不能因为池里还有别的状态
      // 就把它解释成「没有 key」或「稍后重试」，否则 403 会被错误降成 429。
      authorized = active.filter((key) => allowedKeyIds.has(key.id));
      if (!authorized.length) return { reason: "not-authorized" };
    } else {
      if (!keys.length) return { reason: "none-configured" };
      if (!active.length) return { reason: "all-disabled" };
      authorized = active;
    }

    const model = options.model?.trim();
    const identity = model ? options.modelIdentity ?? modelIdentity(model) : undefined;
    // 网关侧黑名单是多租户边界，目录没确认完整时必须先拒绝，不能让某一把 key
    // 恰好能跑就把「尚未求值的规则」带过第二层。
    if (identity && options.gatewayModelScope) {
      if (!identityAllowed(identity, options.gatewayModelScope)) return { reason: "model-not-allowed" };
      if (denyRuleUnverifiable(identity, options.gatewayModelScope)) return { reason: "model-unverified" };
    }
    let uncertainKeyScope = false;
    const servable = identity
      ? authorized.filter((key) => {
        if (!identityAllowed(identity, effectiveScope(options.gatewayModelScope, key.modelScope, identity))) return false;
        // Cursor key 的黑名单是硬限制：身份没确认全时，未知 alias 不能让请求绕过这把 key
        // 的 deny 规则。只排除这把不确定的 key，池里其它没有该限制的 key 仍可服务。
        if (denyRuleUnverifiable(identity, key.modelScope)) {
          uncertainKeyScope = true;
          return false;
        }
        return true;
      })
      : authorized;
    // 能明确说出「这个模型被排除了」时就照实说，别退而报「算不准」，后者会把运维引去查上游。
    if (!servable.length) return { reason: uncertainKeyScope ? "model-unverified" : "model-not-allowed" };

    // 只有走到这里才可能是「试过但都失败了」，前面几种落空都比 exhausted 更具体。
    const candidates = servable.filter((key) => !excludedIds.has(key.id));
    if (!candidates.length) return { reason: "exhausted" };

    const sticky = await this.stickyKey(candidates, options.sessionHash);
    if (sticky) return { key: sticky, sticky: true };

    const key = this.routing.strategy === "round-robin"
      ? pickWeighted(candidates, advanceCursor ? this.nextRotationCursor() : this.rotationCursor)
      : candidates[0];
    // candidates 非空时两条分支都必然有值，兜底只为收窄类型。
    return key ? { key, sticky: false } : { reason: "exhausted" };
  }

  /**
   * 会话粘性：绑定仍指向一个可用候选才复用它。
   * 绑定的 key 已被删除/禁用/本次已试过/不能服务该模型时，顺手删掉这条绑定再回落到正常选择——
   * 留着它只会让后续请求每次都白查一遍，而下一次成功后本来就会重新绑定。
   */
  private async stickyKey(candidates: CursorKeyRecord[], sessionHash?: string): Promise<CursorKeyRecord | undefined> {
    if (!this.routing.sessionAffinity || !sessionHash) return undefined;
    const binding = await this.store.getSessionBinding(sessionHash, this.routing.sessionAffinityTtlMs);
    if (!binding) return undefined;
    const bound = candidates.find((key) => key.id === binding.keyId);
    if (bound) return bound;
    await this.store.deleteSessionBinding(sessionHash);
    return undefined;
  }

  private nextRotationCursor(): number {
    const current = this.rotationCursor;
    this.rotationCursor = (current + 1) % ROTATION_CURSOR_MODULUS;
    return current;
  }

  /** 请求成功后把会话钉到这个 key 上，让后续同会话请求命中上游 prompt 缓存。 */
  async bindSession(sessionHash: string, keyId: string): Promise<void> {
    if (!this.routing.sessionAffinity || !sessionHash || !keyId) return;
    await this.store.saveSessionBinding(sessionHash, keyId);
    this.bindCount += 1;
    if (this.bindCount % SESSION_BINDING_PRUNE_EVERY !== 0) return;
    // 过期绑定清理属于后台维护，失败不该冒泡影响正在收尾的请求。
    await this.store.pruneSessionBindings(this.routing.sessionAffinityTtlMs).catch(() => 0);
  }

  async setModelScope(id: string, scope: ModelScope): Promise<boolean> {
    return this.store.updateCursorKey(id, {
      modelScope: {
        allowed: normalizeModelList(scope?.allowed),
        excluded: normalizeModelList(scope?.excluded)
      }
    });
  }

  /** 非法/小于 1 的权重按 1 收敛，与 store 的归一化一致，避免出现永远选不中的候选。 */
  async setWeight(id: string, weight: number): Promise<boolean> {
    return this.store.updateCursorKey(id, { weight: normalizeWeight(weight) });
  }

  async hasAnyKey(): Promise<boolean> {
    return (await this.store.listCursorKeys()).length > 0;
  }

  async add(
    apiKey: string,
    label?: string,
    clientType: CursorClientTypeSetting = "inherit",
    options: AddKeyOptions = {}
  ): Promise<CursorKeyRecord> {
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
      clientType,
      modelScope: {
        allowed: normalizeModelList(options.modelScope?.allowed),
        excluded: normalizeModelList(options.modelScope?.excluded)
      },
      weight: normalizeWeight(options.weight),
      createdAt: new Date().toISOString()
    };
    await this.store.insertCursorKey(record);
    return record;
  }

  async getByValue(apiKey: string): Promise<CursorKeyRecord | undefined> {
    return this.store.getCursorKeyByValue(apiKey);
  }

  async setClientType(id: string, clientType: CursorClientTypeSetting): Promise<boolean> {
    return this.store.updateCursorKey(id, { clientType });
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

function normalizeRouting(current: RoutingPolicy, patch: Partial<RoutingPolicy>): RoutingPolicy {
  const ttl = patch.sessionAffinityTtlMs;
  return {
    strategy: patch.strategy === "round-robin" || patch.strategy === "fill-first" ? patch.strategy : current.strategy,
    sessionAffinity: typeof patch.sessionAffinity === "boolean" ? patch.sessionAffinity : current.sessionAffinity,
    sessionAffinityTtlMs: typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0
      ? Math.floor(ttl)
      : current.sessionAffinityTtlMs
  };
}

function emptyScope(): ModelScope {
  return { allowed: [], excluded: [] };
}

/**
 * 本次请求对某把 key 的有效可见范围。网关侧不限制时直接用 key 自己的，省掉每个候选一次交集运算。
 * 带上身份是为了让两侧写同一个模型的不同叫法时交集不落空（否则会误拒）。
 */
function effectiveScope(gateway: ModelScope | undefined, key: ModelScope, identity: ModelIdentity): ModelScope {
  return gateway ? intersectScopes(gateway, key, identity) : key;
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
