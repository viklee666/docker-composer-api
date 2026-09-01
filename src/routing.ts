import { createHash } from "node:crypto";
import type { ModelIdentity, ModelScope } from "./types.js";

/**
 * 白名单交集落空时的占位项。ModelScope 用「allowed 为空」表示不限制，没法直接表达「全部拒绝」，
 * 两侧白名单不相交时若返回空 allowed，可见范围反而会从「什么都不给」放大成「全都给」。
 * 因此塞一个正常模型 id 不可能命中的哨兵，让交集结果继续满足 modelAllowed 的语义。
 */
export const NO_MODEL_SENTINEL = "\u0000none";

/**
 * 网关密钥绑定被删空时的占位项。`allowedCursorKeyIds` 用「空数组」表示不限制（整池可用），
 * 因此删掉最后一把被绑定的 Cursor key 后若原样写回空数组，这把密钥的权限会从「只能用那一把」
 * 反向放大成「整池可用」。写入哨兵让列表保持非空，且永远匹配不上任何真实 key id，
 * 选 key 时落到 `not-authorized` → 403。
 * 注意只有删除路径会写它：运维在后台显式清空绑定仍然是「不限制」，那是有意为之的语义。
 */
export const NO_KEY_SENTINEL = "\u0000none";

/** 会话绑定 hash 的保留长度：128 bit 足以避免碰撞，同时让 session_bindings 的主键短一些。 */
const SESSION_HASH_LENGTH = 32;

/**
 * 参与会话身份的每段文本的截断长度。
 *
 * 每段最多取 4000 字，避免让某个上兆字节的首轮输入拖慢每次请求；
 * 稳定性也可以通过完整的首轮 system/user 内容或落库继承来实现，前缀不是唯一方案。
 * system/developer 会全部参与（而不是只取第一条），否则后面的约束变化会错误复用同一粘性 key。
 */
const SEED_SEGMENT_LENGTH = 4000;

/**
 * 从请求体推导「这是哪一段对话」，用于客户端不发 session 头时的粘性身份。
 *
 * 取会话的稳定身份部分（全部 system/developer 文本 + 第一条 user 消息），刻意不含后续普通轮次：
 * 同一段对话追加 user/assistant 轮次时值不变，换一条有效系统约束就换一个值。
 * 也刻意不含 assistant 回复——含了的话第一轮与第二轮身份不同，还得再补一层继承逻辑。
 *
 * 认不出对话（没有任何 user 文本）时返回 undefined，此时调用方应当不启用粘性，
 * 而不是退回一个所有请求共享的常量。
 */
export function conversationSeed(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const system = systemSeedText(record);
  const user = truncate(firstUserSeedText(record));
  if (!user) return undefined;
  return createHash("sha256")
    .update(`sys:${system}\nusr:${user}`)
    .digest("hex")
    .slice(0, SESSION_HASH_LENGTH);
}

/** system 文本来自三种协议的所有有效 system/developer 项，不能只取第一条。 */
export function systemSeedText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const message of messageList(record)) {
    const role = asRecord(message)?.role;
    if (role === "system" || role === "developer") {
      const text = truncate(contentText(asRecord(message)?.content));
      if (text) parts.push(text);
    }
  }
  if (record.system !== undefined) {
    const text = truncate(contentText(record.system));
    if (text) parts.push(text);
  }
  if (typeof record.instructions === "string") {
    const text = truncate(record.instructions);
    if (text) parts.push(text);
  }
  for (const item of inputItems(record)) {
    const role = asRecord(item)?.role;
    if (role === "system" || role === "developer") {
      const text = truncate(contentText(asRecord(item)?.content ?? asRecord(item)?.text));
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function firstUserSeedText(record: Record<string, unknown>): string {
  const fromMessages = messageList(record).find((message) => asRecord(message)?.role === "user");
  if (fromMessages) return contentText(asRecord(fromMessages)?.content);
  // Responses 端点：input 既可能是纯字符串，也可能是 item 数组。
  const input = record.input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const item = input.find((entry) => {
      const role = asRecord(entry)?.role;
      return role === undefined || role === "user";
    });
    if (item) return contentText(asRecord(item)?.content ?? asRecord(item)?.text);
  }
  return "";
}

function messageList(record: Record<string, unknown>): unknown[] {
  return Array.isArray(record.messages) ? record.messages : [];
}

function inputItems(record: Record<string, unknown>): unknown[] {
  return Array.isArray(record.input) ? record.input : [];
}

/** content 可能是字符串，也可能是内容块数组；只收文本块，图片等一律忽略。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record) return "";
      const text = record.text ?? record.input_text ?? record.output_text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join(" ");
}

function truncate(value: string): string {
  return value.trim().slice(0, SEED_SEGMENT_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * 网关自己认的别名组，与上游目录的 aliases 无关。
 *
 * 表放在这里而不是 models.ts：身份解析是判可见范围的第一步，必须零 I/O、零依赖，
 * 而 models.ts 是拉目录的那一层（它反过来 import 本文件）。
 */
const STATIC_MODEL_ALIASES: Record<string, string[]> = {
  "composer-2.5": ["composer-latest", "composer", "composer-2-5", "composer-2.5-sdk"],
  "composer-2.5-fast": ["composer-2-5-fast"]
};

/**
 * 静态别名表里与该名字同组的全部叫法（含 canonical id 自身）；表里没有就返回空数组。
 * 双向查：给 canonical id 要能拿到别名，给别名也要能拿回 canonical id——
 * 只做单向的话，一条按别名写的黑名单遇上按 id 发来的请求就形同虚设。
 */
export function staticModelAliases(model: string): string[] {
  const normalized = normalizeEntry(model);
  if (!normalized) return [];
  for (const [id, aliases] of Object.entries(STATIC_MODEL_ALIASES)) {
    if (normalized === id || aliases.includes(normalized)) return [id, ...aliases];
  }
  return [];
}

/** 静态别名表把这个名字折叠成哪个 canonical id；表里没有就返回 undefined（调用方保留原样）。 */
export function staticCanonicalModel(model: string): string | undefined {
  return staticModelAliases(model)[0];
}

/**
 * 把一次请求的模型名与目录条目合成模型身份。
 *
 * entry 缺失（上游不可达 / 目录里没有该模型）时身份只剩请求名与静态别名组，
 * 这时 `confirmed` 为 false：叫法认得不全，**黑名单会漏判**，判定方必须自己兜底，
 * 详见 denyRuleUnverifiable。多账号并集即使找到了 entry，也只有在调用方确认
 * 所有相关目录都成功返回后才能把它标成 true；「至少一把查成功」不等于名字完整。
 *
 * 静态别名组无论有没有目录都要并进来：这张表不需要任何网络，
 * 让它跟着目录一起失效，等于白白把已经确定知道的叫法丢掉。
 */
export function modelIdentity(
  requested: string,
  entry?: { id: string; aliases?: string[] },
  confirmed: boolean = Boolean(entry)
): ModelIdentity {
  const names = new Set<string>();
  addIdentityName(names, requested);
  addIdentityName(names, entry?.id ?? "");
  for (const alias of entry?.aliases ?? []) addIdentityName(names, alias);
  return { requested: normalizeEntry(requested), names: [...names], confirmed };
}

function addIdentityName(names: Set<string>, value: string): void {
  const normalized = normalizeEntry(value);
  if (!normalized) return;
  names.add(normalized);
  for (const alias of staticModelAliases(normalized)) names.add(alias);
}

/** 模型身份是否在给定可见范围内。任一叫法命中 excluded 即拒绝；allowed 非空时必须有一个叫法命中。 */
export function identityAllowed(identity: ModelIdentity, scope: ModelScope | undefined): boolean {
  if (identity.names.some((name) => excludes(scope, name))) return false;
  const allowed = scope?.allowed ?? [];
  if (!allowed.length) return true;
  // 没有任何叫法配非空白名单只能算不命中：白名单是「只允许这些」，没名字就没有被允许的依据。
  const wanted = new Set(allowed.map(normalizeEntry));
  return identity.names.some((name) => wanted.has(name));
}

/**
 * 这条黑名单在当前身份下**算不准**——判定方必须拒绝，不能当作「没命中」放行。
 *
 * 身份认得不全时，黑白名单的失效方向是相反的，这一点极容易在「简化」时被抹掉：
 * - 白名单要求身份里有一项被点名，少认几个叫法只会更严，降级是安全的；
 * - 黑名单同样要求身份里有一项被点名，少认几个叫法就直接**漏判**。
 *
 * 于是「黑名单写 canonical id + 请求写别名 + 目录冷/挂/没这条」就是一条可以主动触发的旁路：
 * 攻击者只要让目录查不到（换个没缓存的别名、或赶在缓存过期时打），黑名单就失效了。
 * 「查不到就放行」把黑名单变成了尽力而为，所以这里必须反过来：查不到就不许过。
 *
 * 代价是目录长时间不可用会让配了黑名单的密钥整体被拒（目录按 key/通道缓存 10 分钟，
 * 挡得掉绝大多数抖动）。这条口径同样适用于 Cursor key 的 modelScope：它是凭据的硬安全限制，
 * 不是可以在目录抖动时忽略的路由偏好。用一段可观测的不可用换掉一条可复现的绕过，这个方向是划算的；
 * 只配白名单的范围不受影响，它本来就只会往更严的方向降级。
 */
export function denyRuleUnverifiable(identity: ModelIdentity, scope: ModelScope | undefined): boolean {
  return !identity.confirmed && Boolean(scope?.excluded?.length);
}

/** 模型是否在给定可见范围内。只认单个名字，调用方能解析出别名时应改用 identityAllowed。 */
export function modelAllowed(model: string, scope: ModelScope | undefined): boolean {
  return identityAllowed(modelIdentity(model), scope);
}

/**
 * 求两个可见范围的交集语义（网关密钥范围 ∩ Cursor key 范围）。
 *
 * 传了 identity 时白名单按「叫法」而不是按字符串求交：两侧各写了同一个模型的不同叫法
 * （网关写 canonical id、key 写别名）本来描述的是同一件事，按字符串求交会落空成
 * NO_MODEL_SENTINEL，把一个本该放行的请求拒掉。只放宽白名单这一侧——
 * 黑名单是取并集，永远不会因为认得多而变松。
 */
export function intersectScopes(
  a: ModelScope | undefined,
  b: ModelScope | undefined,
  identity?: ModelIdentity
): ModelScope {
  const excluded = dedupe([...(a?.excluded ?? []), ...(b?.excluded ?? [])]);
  const left = dedupe(a?.allowed ?? []);
  const right = dedupe(b?.allowed ?? []);
  // 一侧不限制时，交集就是另一侧的白名单。
  if (!left.length) return { allowed: right, excluded };
  if (!right.length) return { allowed: left, excluded };
  const rightKeys = new Set(right.map(normalizeEntry));
  const names = new Set(identity?.names ?? []);
  // 右侧也点名了本次请求的这个模型时，左侧任何一个指向同一模型的叫法都算命中。
  const rightNamesRequest = right.some((entry) => names.has(normalizeEntry(entry)));
  const allowed = left.filter((entry) => {
    const key = normalizeEntry(entry);
    return rightKeys.has(key) || (rightNamesRequest && names.has(key));
  });
  return { allowed: allowed.length ? allowed : [NO_MODEL_SENTINEL], excluded };
}

/**
 * 规范化用户输入的模型列表：去空白、去重、丢空串。保留原始大小写用于展示。
 * 除数组外也接受后台输入框的原始字符串（逗号/换行分隔）。
 */
export function normalizeModelList(values: unknown): string[] {
  if (Array.isArray(values)) return dedupe(values.filter((value): value is string => typeof value === "string"));
  if (typeof values === "string") return dedupe(values.split(/[\n,]/));
  return [];
}

/** 从模型 id 与 alias 里挑出对给定范围可见的条目，用于过滤 /v1/models。 */
export function filterModelsByScope<T extends { id: string; aliases?: string[] }>(
  models: T[],
  scope: ModelScope | undefined
): T[] {
  if (!scope?.allowed?.length && !scope?.excluded?.length) return models;
  // 两侧都按整组叫法匹配：黑名单只写别名同样要把整条隐藏，白名单只写 id 也不该漏掉别名请求。
  return models.filter((model) => identityAllowed(modelIdentity(model.id, model), scope));
}

/** 会话粘性的绑定键：把会话标识散列成定长 hash，避免把原始 session key（可能含用户内容）落库。 */
export function sessionBindingHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, SESSION_HASH_LENGTH);
}

/**
 * 加权轮询选择器。传入候选与一个单调递增的游标，返回选中项。
 * 按 cursor % 总权重在累计权重上走一步，因此同一候选顺序下结果稳定可预期，
 * 且非空候选一定有返回值。weight ≤ 0 / 非法值按 1 处理。
 */
export function pickWeighted<T extends { id: string; weight: number }>(candidates: T[], cursor: number): T | undefined {
  if (!candidates.length) return undefined;
  const weights = candidates.map((candidate) => normalizeWeight(candidate.weight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const start = Number.isFinite(cursor) ? Math.floor(cursor) : 0;
  let offset = ((start % total) + total) % total;
  for (let index = 0; index < candidates.length; index += 1) {
    offset -= weights[index] as number;
    if (offset < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

/** 与 store 的 weight 归一化保持一致：非法值与 <1 一律按 1 计。 */
export function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 1 ? Math.floor(value as number) : 1;
}

function excludes(scope: ModelScope | undefined, target: string): boolean {
  return (scope?.excluded ?? []).some((entry) => {
    const normalized = normalizeEntry(entry);
    return Boolean(normalized) && normalized === target;
  });
}

function normalizeEntry(value: string): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
