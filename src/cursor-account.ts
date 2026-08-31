/**
 * 用 cursor.com 后台会话直接铸一个新的 Cursor API key，让管理后台能一键入池，
 * 而不必让用户自己去网站上复制粘贴。
 *
 * 为什么打未公开的 dashboard 接口而不用 @cursor/sdk：SDK 里唯一能产出 key 的入口是
 * Cursor.auth.login()，它必须拉起浏览器走交互式授权；网关跑在容器里，既没有浏览器
 * 也没有人点「同意」，headless 环境下这条路根本走不通。
 * 代价是这个接口没有兼容性承诺，上游一旦改动只会表现为非 2xx，因此错误映射里保留了
 * 上游状态码与截断后的响应片段，出问题时才有得查。
 */
import { randomBytes } from "node:crypto";
import { ApiError } from "./errors.js";

/** 用户从 cursor.com 复制的 WorkosCursorSessionToken cookie 值。 */
export interface MintApiKeyInput {
  sessionToken: string;
  /** API key 在 Cursor 后台显示的名字；不填时自动生成。 */
  name?: string;
}

export interface MintedApiKey {
  apiKey: string;
  name: string;
}

const CREATE_API_KEY_URL = "https://cursor.com/api/dashboard/create-user-api-key";
const SESSION_COOKIE_NAME = "WorkosCursorSessionToken";
const DASHBOARD_ORIGIN = "https://cursor.com";
const DASHBOARD_REFERER = "https://cursor.com/dashboard/api?section=user-keys";
/** 后台接口只服务浏览器，固定一个普通桌面 Chrome/Edge UA，避免被当成脚本流量拦掉。 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
/** 上游挂死时不能把管理后台的请求一起拖住，30s 没回就当超时。 */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_NAME_LENGTH = 64;
/** 异常响应可能是整页 HTML，截断后再进错误信息，免得刷屏日志与后台弹窗。 */
const MAX_BODY_SNIPPET = 300;
/** 只放字母数字与 - _ . 空格：既不会破坏 JSON，也不会在 Cursor 后台列表里显示成乱码。 */
const NAME_PATTERN = /^[A-Za-z0-9._ -]+$/;
/** session token 形如 `user_<id>::<jwt>`，两段齐全才可能是有效会话。 */
const SESSION_TOKEN_PATTERN = /^user_[A-Za-z0-9_-]+::.+$/;
/** 默认名的随机后缀取 6 字节（48 bit）：批量铸钥也撞不上，展开成 12 位十六进制后总长仍远小于 MAX_NAME_LENGTH。 */
const DEFAULT_NAME_RANDOM_BYTES = 6;
/**
 * 实测铸出来的 key 前缀是 `crsr_`（`docs/sand-rollout-guide.md` 的真账号记录），
 * 而后台占位符长期写的是 `key_`。两个都放行而不是死磕一个：白名单足以挡住「上游换了响应结构」，
 * 又不至于因为占位符所述格式真的出现就把一把好 key 拒之门外。
 */
const API_KEY_PREFIXES = ["crsr_", "key_"] as const;
/** 前缀不认识时回显的字符数：够看出上游换成了什么格式，又远不足以还原一把 key。 */
const KEY_HINT_PREFIX_LENGTH = 6;

/**
 * 校验 / 规范化用户粘贴的 session token。
 * 用户可能从 DevTools 复制整条 cookie、连引号一起复制、带结尾分号，或复制到 URL 编码后的形式，
 * 这里一律还原成裸 token。校验失败时绝不回显 token 本身——它等价于账号密码。
 */
export function normalizeSessionToken(raw: string): string {
  if (typeof raw !== "string") throw invalidSessionToken();
  let value = stripWrapping(raw);
  const cookieMatch = new RegExp(`${SESSION_COOKIE_NAME}\\s*=\\s*([^;]*)`, "i").exec(value);
  if (cookieMatch) value = cookieMatch[1];
  // 裸 token 里不会有分号，截到第一个分号顺带丢掉整条 cookie 串里的其它键值对。
  value = stripWrapping(value.split(";")[0]);
  value = decodeIfEncoded(value);
  if (!SESSION_TOKEN_PATTERN.test(value)) throw invalidSessionToken();
  return value;
}

/**
 * 生成默认 key 名（用户没指定时）。
 * 固定按 UTC 取时间：容器时区常与用户本地不一致，UTC 才能保证名字在后台列表里有序可比。
 * 但时间只到秒，同一秒里连铸两把就会重名，所以再缀一段 CSPRNG 随机值；
 * 取十六进制而不是 base64，是因为 NAME_PATTERN 收不下 `+` `/` `=`。
 */
export function defaultApiKeyName(now: Date = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return `gateway-${stamp}-${randomBytes(DEFAULT_NAME_RANDOM_BYTES).toString("hex")}`;
}

/**
 * 用后台会话铸一个新的 Cursor API key，成功后调用方即可直接把它塞进 key 池。
 * fetchImpl 可注入，便于测试；不传时用全局 fetch。
 */
export async function createCursorApiKey(
  input: MintApiKeyInput,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<MintedApiKey> {
  const sessionToken = normalizeSessionToken(input.sessionToken);
  const name = resolveApiKeyName(input.name);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(CREATE_API_KEY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        origin: DASHBOARD_ORIGIN,
        referer: DASHBOARD_REFERER,
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        "user-agent": BROWSER_USER_AGENT
      },
      body: JSON.stringify({ name }),
      // 会话过期时后台是 302 跳登录页，跟着跳会拿到一张 HTML 登录页并以「响应不是 JSON」收场；
      // 不跟跳才能把 3xx 原样看见，归因成「会话失效」这个用户真正需要的提示。
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiError("请求 Cursor 后台超时，请稍后重试。", 504, "upstream_timeout");
    }
    throw new ApiError(`无法连接 Cursor 后台：${errorText(error)}`, 502, "upstream_error");
  }

  const status = response.status;
  const bodyText = await readBody(response);
  // 401 / 403 / 跳登录页的 3xx 对用户是同一件事：这份会话不能用了，得回浏览器重新复制。
  // （redirect: "manual" 下 undici 会把 0 或 3xx 原样交回来，两种都算。）
  if (status === 401 || status === 403 || status === 0 || (status >= 300 && status < 400)) {
    throw new ApiError(
      "Cursor session token 无效或已过期，请重新从浏览器复制。",
      401,
      "unauthorized",
      "sessionToken"
    );
  }
  if (status === 429) {
    throw new ApiError("Cursor 后台限流，请稍后再试。", 429, "rate_limit_exceeded");
  }
  if (status < 200 || status >= 300) {
    throw new ApiError(`Cursor 后台返回 ${status}：${bodySnippet(bodyText)}`, 502, "upstream_error");
  }
  return { apiKey: readApiKey(bodyText), name };
}

/** 错误信息统一从这里出，保证任何失败路径都不会把 token 带进消息里。 */
function invalidSessionToken(): ApiError {
  return new ApiError(
    `${SESSION_COOKIE_NAME} 格式不正确，请从浏览器 cookie 里完整复制该值（形如 user_xxx::xxx）。`,
    400,
    "invalid_request_error",
    "sessionToken"
  );
}

/** 剥掉粘贴时常见的包裹物：首尾空白、成对引号、结尾分号；它们可能叠加，所以循环剥。 */
function stripWrapping(value: string): string {
  let result = value.trim();
  for (let round = 0; round < 4; round += 1) {
    const before = result;
    if (result.endsWith(";")) result = result.slice(0, -1).trim();
    const quote = result[0];
    if (result.length >= 2 && (quote === '"' || quote === "'") && result.endsWith(quote)) {
      result = result.slice(1, -1).trim();
    }
    if (result === before) return result;
  }
  return result;
}

/** DevTools 的 Copy value 有时给 URL 编码后的形式（`::` 变成 `%3A%3A`）；JWT 本身不含 %，解码是安全的。 */
function decodeIfEncoded(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** name 缺省时才自动生成：显式传了空白串是用户输入错了，不该被默认名悄悄盖过去。 */
function resolveApiKeyName(raw: unknown): string {
  if (raw === undefined || raw === null) return defaultApiKeyName();
  if (typeof raw !== "string") {
    throw new ApiError("API key 名称必须是字符串。", 400, "invalid_request_error", "name");
  }
  const name = raw.trim();
  if (!name) throw new ApiError("API key 名称不能为空。", 400, "invalid_request_error", "name");
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(`API key 名称不能超过 ${MAX_NAME_LENGTH} 个字符。`, 400, "invalid_request_error", "name");
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError("API key 名称只能包含字母、数字、空格和 - _ . 三种符号。", 400, "invalid_request_error", "name");
  }
  return name;
}

/** 响应体读不出来不该盖掉真正的状态码语义，读失败按空响应处理。 */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * 只认 {"apiKey":"crsr_..."}：字段缺失或前缀陌生都说明上游多半换了响应结构，
 * 宁可报 502 也不能把一串疑似不是 key 的东西塞进 key 池——那要等到真有人发请求才会暴雷。
 * 这道校验只管铸钥这一条路径：`CURSOR_API_KEYS` 播种与后台手工粘贴的 key 由用户自己负责，
 * 在那两处按前缀设限只会拦下历史格式。
 */
function readApiKey(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ApiError(`Cursor 后台返回了非 JSON 响应：${bodySnippet(bodyText)}`, 502, "upstream_error");
  }
  const apiKey = (parsed as { apiKey?: unknown } | null)?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ApiError("Cursor 后台响应里没有 apiKey 字段，接口可能已变更。", 502, "upstream_error");
  }
  const value = apiKey.trim();
  if (!API_KEY_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new ApiError(
      `Cursor 后台返回的 apiKey 不像 Cursor key：收到 ${apiKeyShapeHint(value)}，` +
        `期望以 ${API_KEY_PREFIXES.join(" 或 ")} 开头，接口可能已变更。`,
      502,
      "upstream_error"
    );
  }
  return value;
}

/**
 * 拒绝时只交代开头一小截与总长度，够运维判断上游到底换成了什么格式。
 * 始终少给至少一个字符：万一这真是把新前缀的合法 key，落盘的错误信息里也拼不回完整凭据。
 */
function apiKeyShapeHint(value: string): string {
  const keep = Math.min(KEY_HINT_PREFIX_LENGTH, Math.max(0, value.length - 1));
  return `${value.slice(0, keep)}…（共 ${value.length} 字符）`;
}

/**
 * 上游响应片段：压平空白 → 抹掉像凭据的值 → 再截断。
 *
 * 脱敏不是可选项：这段片段会进 502 的 message，而 message 一路回到管理 API 的响应、
 * 后台弹窗与日志。上游把**刚铸好的 key** 连同一个非 2xx 一起返回是完全可能的
 *（后台接口本来就是这么组织响应体的），那样「铸钥失败」的提示里就带着一把完整可用的 key。
 * 抹的是值、不是结构：状态码、字段名、错误串一律留着——
 * 502 要能区分「上游返回了一段错误文本」和「上游换了响应结构」，靠的正是这些。
 * 截断必须排在脱敏之后，否则会把残缺但仍可辨认的凭据留在消息里。
 */
function bodySnippet(bodyText: string): string {
  const redacted = redactSecrets(bodyText.replace(/\s+/g, " ").trim());
  if (!redacted) return "(空响应体)";
  return redacted.length > MAX_BODY_SNIPPET ? `${redacted.slice(0, MAX_BODY_SNIPPET)}…` : redacted;
}

/** 敏感字段名：值一律换成形状提示。字段名留着，上游换没换响应结构全靠它。 */
const SECRET_FIELD_PATTERN =
  /("(?:api_?key|access_?token|refresh_?token|session_?token|token|secret|password|cookie|authorization)"\s*:\s*")([^"]*)(")/gi;
/** 裸露在正文里的 key：JSON 之外（HTML 错误页、纯文本）同样得挡。 */
const BARE_KEY_PATTERN = new RegExp(`(?:${API_KEY_PREFIXES.join("|")})[A-Za-z0-9_-]{4,}`, "g");
/** session token 形如 `user_<id>::<jwt>`，它比 key 权限还大。 */
const SESSION_TOKEN_ECHO_PATTERN = /user_[A-Za-z0-9_-]+::[^\s;"']+/g;

function redactSecrets(text: string): string {
  return text
    .replace(SECRET_FIELD_PATTERN, (_match, prefix: string, value: string, suffix: string) =>
      value ? `${prefix}${apiKeyShapeHint(value)}${suffix}` : `${prefix}${suffix}`)
    .replace(BARE_KEY_PATTERN, (match: string) => apiKeyShapeHint(match))
    .replace(SESSION_TOKEN_ECHO_PATTERN, "user_***::***")
    .replace(new RegExp(`${SESSION_COOKIE_NAME}\\s*=\\s*[^\\s;"']*`, "gi"), `${SESSION_COOKIE_NAME}=***`);
}

/** AbortSignal.timeout 打断 fetch 时抛的是 DOMException(TimeoutError)，undici 还可能再包一层 cause。 */
function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (record.name === "TimeoutError" || record.name === "AbortError") return true;
    if (record.code === "ABORT_ERR" || record.code === "UND_ERR_ABORTED") return true;
    current = record.cause;
  }
  return false;
}

/** 传输层异常同样要过一遍脱敏：连接失败的消息里偶尔会带上被拼进 URL 或 header 的凭据。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return typeof error === "string" ? redactSecrets(error) : "未知错误";
}
