import dns from "node:dns";
import type { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksClient, type SocksProxy } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
  Agent,
  buildConnector,
  getGlobalDispatcher,
  ProxyAgent,
  request as undiciRequest,
  setGlobalDispatcher,
  type Dispatcher
} from "undici";
import { ApiError } from "./errors.js";

export type ProxyScheme = "http" | "https" | "socks5" | "socks5h" | "socks4";

export interface ParsedProxy {
  /** 规范化后的完整 URL（含凭据，只供内部构造 agent；对外一律先过 maskProxyUrl）。 */
  url: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  hasAuth: boolean;
}

export interface ProxyStatus {
  enabled: boolean;
  /** 已掩码的代理地址，未配置时为 undefined。 */
  url?: string;
  scheme?: ProxyScheme;
  /** 是否已把全局 dispatcher / globalAgent 装上。 */
  applied: boolean;
  /**
   * 模型流量是否真的会走代理。connect-node 默认 HTTP/2 不支持代理，
   * 只有开了 useHttp1ForAgent 才会落到 https.globalAgent 上。
   */
  modelTrafficProxied: boolean;
  /** 需要提醒用户的问题，如「配了代理但没开 HTTP/1.1」。 */
  warnings: string[];
}

export interface ProxyProbeResult {
  ok: boolean;
  durationMs: number;
  status?: number;
  error?: string;
  /** 这一条探的是哪个地址。两条链路打的 host 不同，不写出来运维分不清失败的是哪一条。 */
  target: string;
}

export interface ProxyTestResult {
  /** 两条链路都通才算通：只要有一条不通，代理对网关来说就是半残的。 */
  ok: boolean;
  durationMs: number;
  /** REST 那条的状态码。保留顶层字段是为了老客户端仍能读到一个「主结果」。 */
  status?: number;
  error?: string;
  /** 云端 REST：模型目录 / 用量金额 / 铸钥，走全局 fetch（undici dispatcher）。 */
  rest: ProxyProbeResult;
  /** 模型流量：connect-node 在 HTTP/1.1 下的 https.request，落到 https.globalAgent。 */
  model: ProxyProbeResult;
}

/** 只有形如 `scheme://` 才算带协议；`127.0.0.1:7890` 会被 WHATWG URL 误当成 protocol="127.0.0.1:"。 */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

/** URL protocol → 归一化 scheme。`socks:` 是 socks5 的常见简写。 */
const SCHEMES: Readonly<Record<string, ProxyScheme>> = {
  "http:": "http",
  "https:": "https",
  "socks:": "socks5",
  "socks5:": "socks5",
  "socks5h:": "socks5h",
  "socks4:": "socks4"
};

const DEFAULT_PORTS: Readonly<Record<ProxyScheme, number>> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
  socks4: 1080
};

/**
 * 连通性探测的默认目标：SDK 云端 REST 真会打的端点（Cursor.me()）。
 * 不带 key 时它稳定返回 401，而这正好够用——只要能拿回任意 HTTP 状态码，
 * 就证明代理隧道已经通到 api.cursor.com，剩下的是鉴权问题而不是网络问题。
 * 刻意不用 /health 这类猜出来的路径：那种路径可能压根不存在，
 * 404 反而分不清是「代理坏了」还是「路径写错了」。
 */
const DEFAULT_PROBE_URL = "https://api.cursor.com/v1/me";

/**
 * 模型流量的真实去处。SDK 打包产物里是 `process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh"`，
 * 且这个值在 SDK 模块加载时就被读走存进常量了，configureCursorSdk 改不动它——
 * 所以探测这一条只能自己按同一套规则算出 host，不能问 SDK 要。
 * 打根路径就够：connect-node 的 RPC 路径全是 POST，GET / 会被上游以某个状态码回绝，
 * 而任何一个回得来的状态码都已经证明隧道通到了这个 host，剩下的是协议层的事。
 */
const DEFAULT_MODEL_BACKEND_URL = "https://api2.cursor.sh";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/**
 * 这些环境变量只影响 agent 的 shell 工具 spawn 出去的子进程（curl / git / npm）。
 * SDK 自己一个都不读——打包产物里那段 HTTPS_PROXY 逻辑是死代码，
 * 所以光设环境变量不会让 SDK 走代理，真正生效的是下面的 dispatcher 与 globalAgent。
 */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

const MAX_ERROR_LENGTH = 300;

/** 结构认不出来的地址整条遮成这个：宁可让运维看不出自己写错了什么，也不能赌那串垃圾里没有密码。 */
const FULLY_MASKED = "***";

/**
 * 换代理时留给旧 agent 的排空窗口。取值只需满足「比一次正常的模型请求长」：
 * 流式对话可以跑好几分钟，窗口太短就等于回到「直接把在途 socket 拆掉」。
 */
const AGENT_DRAIN_TIMEOUT_MS = 10 * 60_000;
const AGENT_DRAIN_POLL_MS = 500;
const DISPATCHER_DRAIN_TIMEOUT_MS = 10 * 60_000;

interface OriginalNetworking {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  dispatcher: Dispatcher;
  env: Map<string, string | undefined>;
}

/** 首次装载代理前的原件，只捕获一次：恢复直连必须还回这几个原对象，而不是 new 一个新的。 */
let originals: OriginalNetworking | undefined;

/** 本模块自己装上去的代理对象，换代理/停用时要销毁，否则连接池里的 socket 会一直泄漏。 */
let installedDispatcher: Dispatcher | undefined;
let installedAgents: http.Agent[] = [];
let installedSocksTimeoutMs: number | undefined;

let current: ParsedProxy | undefined;
let applied = false;

/** 解析并校验代理 URL；非法时抛 ApiError(400, "invalid_request_error", "proxyUrl")。 */
export function parseProxyUrl(raw: string): ParsedProxy {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw invalidProxy("代理地址不能为空。");

  // Clash / v2ray 面板上就是 `127.0.0.1:7890` 这么显示的，是最常见的手写形式；
  // 不补 scheme 的话 WHATWG URL 会把它解析成 protocol="127.0.0.1:"，报一个用户看不懂的错。
  const candidate = SCHEME_PREFIX.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    // 端口越界/非数字时 new URL 只抛通用的 "Invalid URL"；只能在 URL 已经拒绝后
    // 再判断是否像坏端口，而且绝不能把未经验证的 authority 片段原样放进错误信息。
    const portText = authorityPort(candidate);
    if (portText !== undefined && !isValidPortText(portText)) {
      throw invalidProxy("代理端口格式非法，必须是 1-65535 之间的整数。");
    }
    throw invalidProxy(
      `代理地址 "${maskProxyUrl(trimmed)}" 无法解析。正确写法如 http://127.0.0.1:7890 或 socks5h://user:pass@127.0.0.1:7891。`
    );
  }

  const scheme = SCHEMES[url.protocol.toLowerCase()];
  if (!scheme) {
    throw invalidProxy(
      `不支持的代理协议 "${url.protocol.replace(":", "")}"，只支持 http、https、socks5、socks5h、socks4。`
    );
  }
  if (!url.hostname) throw invalidProxy("代理地址缺少主机名，正确写法如 http://127.0.0.1:7890。");

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
  if (!isValidPort(port)) {
    throw invalidProxy(`代理端口 "${url.port}" 非法，必须是 1-65535 之间的整数。`);
  }

  const hasAuth = url.username !== "" || url.password !== "";
  const auth = hasAuth ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return {
    // 端口一律显式写出：URL 会把 http 的 80、https 的 443 当默认端口吞掉，
    // 而代理地址一旦缺端口，下游 agent 会按「目标协议」而不是「代理协议」猜错。
    url: `${scheme}://${auth}${url.hostname}:${port}`,
    scheme,
    host: url.hostname,
    port,
    hasAuth
  };
}

/**
 * 把 URL 里的用户名/密码替换成掩码，用于后台展示与日志（绝不能明文回显凭据）。
 * 刻意不用 new URL：这个函数会在解析失败的分支里被调用，
 * 输入本来就可能是解析不了的垃圾，它自己绝不能再抛。scheme 也做成可选，
 * 这样 `user:pass@host:port` 这种漏写协议的输入同样能被遮住。
 *
 * 边界一律取 authority 里**最后**一个 `@`：`@` 在密码里不转义是常见写法，
 * 按第一个 `@` 切会把 `ss@host` 当主机名回显出去，密码的后半截原样泄漏。
 */
export function maskProxyUrl(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return trimmed;
  const scheme = SCHEME_PREFIX.exec(trimmed)?.[0] ?? "";
  const rest = trimmed.slice(scheme.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const host = authority.slice(at + 1);
  // 主机名认不出来，说明整条地址的结构都是猜的，凭据边界也就无从谈起——
  // 与其赌剩下那截里没有密码，不如整条遮掉。
  if (!isMaskableHost(host)) return FULLY_MASKED;
  if (at === -1) return trimmed;
  const userinfo = authority.slice(0, at).includes(":") ? "***:***" : "***";
  return `${scheme}${userinfo}@${host}${cut === -1 ? "" : rest.slice(cut)}`;
}

/** host[:port] 的形状：IPv6 字面量带方括号，端口允许为空（WHATWG 下等于「用默认端口」）。 */
const HOST_AND_PORT = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~+-]+)(?::\d*)?$/;

function isMaskableHost(host: string): boolean {
  return HOST_AND_PORT.test(host);
}

/**
 * 装上/卸下进程级代理。传空字符串或 undefined 表示恢复直连。
 * useHttp1ForAgent 只用于算 status 里的告警，不在这里改 SDK 配置。
 */
export function applyProxyConfig(
  proxyUrl: string | undefined,
  options: { useHttp1ForAgent?: boolean; timeoutMs?: number } = {}
): ProxyStatus {
  const trimmed = proxyUrl?.trim() ?? "";
  if (!trimmed) {
    restoreDirect();
    return proxyStatus(options);
  }
  const parsed = parseProxyUrl(trimmed);
  const socksTimeoutMs = resolveProxyTimeout(options.timeoutMs);
  // 幂等：启动时装一次、后台保存同一个地址再装一次，不该重建连接池，更不该报错。
  if (applied && current?.url === parsed.url && installedSocksTimeoutMs === socksTimeoutMs) return proxyStatus(options);
  install(parsed, socksTimeoutMs);
  return proxyStatus(options);
}

export function proxyStatus(options: { useHttp1ForAgent?: boolean } = {}): ProxyStatus {
  const useHttp1ForAgent = options.useHttp1ForAgent === true;
  const enabled = current !== undefined;
  return {
    enabled,
    url: current ? maskProxyUrl(current.url) : undefined,
    scheme: current?.scheme,
    applied,
    modelTrafficProxied: enabled && useHttp1ForAgent,
    warnings: collectWarnings(current, useHttp1ForAgent)
  };
}

/**
 * 用给定代理做一次真实连通性探测。两条链路分开报：
 * REST 通不代表模型通——它们走的是完全不同的两套客户端（undici dispatcher vs node:https 的 agent），
 * host 也不一样。过去只探 api.cursor.com，结果是「测试通过」但模型请求照样超时，
 * 这正是本函数要杜绝的误读。
 */
export async function testProxy(
  proxyUrl: string,
  options: { timeoutMs?: number; targetUrl?: string; modelTargetUrl?: string } = {}
): Promise<ProxyTestResult> {
  const proxy = parseProxyUrl(proxyUrl);
  const restTarget = options.targetUrl?.trim() || DEFAULT_PROBE_URL;
  const modelTarget = options.modelTargetUrl?.trim() || modelProbeUrl();
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  // 并发跑：代理不通时两条都得等满超时，串行会让后台的「测试代理」按钮转两倍时间。
  const [rest, model] = await Promise.all([
    probeRestPath(proxy, restTarget, timeoutMs),
    probeModelPath(proxy, modelTarget, timeoutMs)
  ]);
  const failures = [rest, model].filter((probe) => !probe.ok);
  return {
    ok: failures.length === 0,
    durationMs: Date.now() - startedAt,
    ...(rest.status === undefined ? {} : { status: rest.status }),
    ...(failures.length === 0 ? {} : { error: failures.map((probe) => `${probe.target}: ${probe.error}`).join("；") }),
    rest,
    model
  };
}

/** 云端 REST 那条：与全局 fetch 同款的 undici dispatcher，只是换成一次性对象。 */
async function probeRestPath(proxy: ParsedProxy, target: string, timeoutMs: number): Promise<ProxyProbeResult> {
  // 一次性对象：探测绝不能碰模块已装上的全局 dispatcher / globalAgent，
  // 否则后台点一下「测试代理」就把正在跑的请求的连接池换掉了。
  // 构造放进 probe 的 try 里：dispatcher 的构造异常同样会带出整条代理 URL。
  let dispatcher: Dispatcher | undefined;
  try {
    return await probe(proxy, target, () => {
      dispatcher ??= buildDispatcher(proxy, timeoutMs);
      return probeWithDispatcher(dispatcher, target, timeoutMs);
    });
  } finally {
    await disposeDispatcher(dispatcher, timeoutMs);
  }
}

/** 模型那条：node:https + 一次性代理 agent，复刻 connect-node 在 HTTP/1.1 下真正走的路径。 */
function probeModelPath(proxy: ParsedProxy, target: string, timeoutMs: number): Promise<ProxyProbeResult> {
  return probe(proxy, target, () => probeWithAgent(proxy, target, timeoutMs));
}

async function probe(proxy: ParsedProxy, target: string, run: () => Promise<number>): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  try {
    const status = await run();
    // 走到这里的状态码一定来自目标站点，隧道也就一定通了（没带 key 时 401、打根路径时 404 都是正常结果）。
    // 代理自己回绝的那些响应（407、CONNECT 被拒）已经在下面两个 probeWith* 里被认出来并转成异常了。
    return { ok: true, durationMs: Date.now() - startedAt, status, target };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: scrubCredentials(describeError(error), proxy),
      target
    };
  }
}

function modelProbeUrl(): string {
  const raw = process.env.CURSOR_BACKEND_URL?.trim() || DEFAULT_MODEL_BACKEND_URL;
  try {
    return new URL("/", raw).toString();
  } catch {
    return `${DEFAULT_MODEL_BACKEND_URL}/`;
  }
}

function install(proxy: ParsedProxy, socksTimeoutMs: number): void {
  // 先把对象都造出来再改全局：构造失败时进程还停在原来的状态，不会留下装了一半的代理。
  const { dispatcher, httpAgent, httpsAgent } = buildProxyClients(proxy, socksTimeoutMs);
  const origin = captureOriginals();
  const staleDispatcher = installedDispatcher;
  const staleAgents = installedAgents;

  // (a) 全局 fetch：云端 REST（models.list / me / usage / 云端 agent）走的是 bare fetch，
  //     由 undici 承载，换掉全局 dispatcher 就能拦住。
  setGlobalDispatcher(dispatcher);
  // (b) node:http(s) 的 globalAgent：connect-node 在 HTTP/1.1 模式下不传 agent，
  //     于是落到 globalAgent 上——这是模型流量唯一能被代理的入口。
  http.globalAgent = httpAgent ?? origin.httpAgent;
  https.globalAgent = httpsAgent;
  // (c) 环境变量：只给 agent shell 工具 spawn 的子进程用。
  for (const key of PROXY_ENV_KEYS) process.env[key] = proxy.url;

  installedDispatcher = dispatcher;
  installedAgents = httpAgent && httpAgent !== httpsAgent ? [httpAgent, httpsAgent] : [httpsAgent];
  installedSocksTimeoutMs = socksTimeoutMs;
  current = proxy;
  applied = true;

  void disposeDispatcher(staleDispatcher);
  disposeAgents(staleAgents);
}

function restoreDirect(): void {
  if (!originals) {
    // 从没装过代理：什么都别动。尤其是环境变量——运维可能在 compose 里预置了 HTTPS_PROXY，
    // 「用户没在后台配代理」不等于「要把运维配的那份也删掉」。
    current = undefined;
    applied = false;
    return;
  }
  setGlobalDispatcher(originals.dispatcher);
  http.globalAgent = originals.httpAgent;
  https.globalAgent = originals.httpsAgent;
  for (const [key, value] of originals.env) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const staleDispatcher = installedDispatcher;
  const staleAgents = installedAgents;
  installedDispatcher = undefined;
  installedAgents = [];
  installedSocksTimeoutMs = undefined;
  current = undefined;
  applied = false;

  void disposeDispatcher(staleDispatcher);
  disposeAgents(staleAgents);
}

function captureOriginals(): OriginalNetworking {
  originals ??= {
    httpAgent: http.globalAgent,
    httpsAgent: https.globalAgent,
    dispatcher: getGlobalDispatcher(),
    env: new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  };
  return originals;
}

/**
 * agent 与 dispatcher 的构造函数会把整条代理 URL 原样塞进异常信息（undici 的 InvalidArgumentError 尤其如此），
 * 而这条异常会一路冒到管理接口的响应里。凭据必须在离开本模块之前就被抹掉。
 */
function buildProxyClients(
  proxy: ParsedProxy,
  socksTimeoutMs: number
): { dispatcher: Dispatcher; httpAgent?: http.Agent; httpsAgent: https.Agent } {
  try {
    return { dispatcher: buildDispatcher(proxy, socksTimeoutMs), ...buildNativeAgents(proxy) };
  } catch (error) {
    throw invalidProxy(`无法为该代理创建客户端：${scrubCredentials(describeError(error), proxy)}`);
  }
}

/**
 * 三种 SOCKS 统一走自定义 connector，不再用 undici 的 ProxyAgent：
 * ProxyAgent 只认 http:/https:/socks5:/socks:，socks4 会直接抛错——而抛错的后果不是「报个错」，
 * 是全局 fetch 悄悄退回直连，模型目录、用量金额、铸钥在墙内全部超时，状态里还看不出来。
 * 顺带修掉 socks5 的语义偏差：undici 一律把域名原样发给代理（那是 socks5h 的行为），
 * 与 node:http(s) 那条路的本机解析不一致；同一个网关两条链路的 DNS 行为不同是排查噩梦。
 */
function buildDispatcher(proxy: ParsedProxy, timeoutMs?: number): Dispatcher {
  if (proxy.scheme === "http" || proxy.scheme === "https") {
    const token = basicProxyToken(proxy);
    return new ProxyAgent(token === undefined ? proxy.url : { uri: proxy.url, token });
  }
  return new AbortAwareAgent(socksConnector(proxy, resolveProxyTimeout(timeoutMs)));
}

/**
 * 凭据只写了一半（`http://user@proxy` 或 `http://:pass@proxy`）时两条链路必须一致。
 * undici 只在用户名与密码**都**非空时才自动带 Proxy-Authorization，而 https-proxy-agent
 * 只要有一半就带——同一个地址于是 REST 407、模型流量却通，是最难排查的那种「半通」。
 * 这里按原生 agent 的口径显式算出 token 交给 undici，两边逐字节相同。
 */
function basicProxyToken(proxy: ParsedProxy): string | undefined {
  if (!proxy.hasAuth) return undefined;
  const { username, password } = new URL(proxy.url);
  return `Basic ${Buffer.from(`${safeDecode(username)}:${safeDecode(password)}`).toString("base64")}`;
}

type RequestSignal = AbortSignal | EventEmitter;
type SocksConnectorOptions = buildConnector.Options & { signal?: RequestSignal | null };

interface PendingConnectSignal {
  signal?: RequestSignal | null;
}

type DispatchOptionsWithSignal = Agent.DispatchOptions & { signal?: RequestSignal | null };

/**
 * undici 的 Client 会把请求 signal 留在 RequestHandler 里，却不会传进自定义 connector；
 * 连接建立前请求若被取消，connector 既看不到取消，也就没有机会拆掉正在握手的 SOCKS socket。
 * 每个 origin 按待处理请求顺序暂存 signal，connector 消费真正触发建连的那一项；
 * 请求若复用现有连接，则在完成时把没被消费的项移除，避免下一次重连误用旧 signal。
 */
class AbortAwareAgent extends Agent {
  private readonly pendingSignals: Map<string, PendingConnectSignal[]>;

  constructor(connector: buildConnector.connector) {
    const pendingSignals = new Map<string, PendingConnectSignal[]>();
    super({
      connect: (options, callback) => {
        const pending = takePendingSignal(pendingSignals, connectOriginKey(options));
        const connectOptions = pending?.signal ? { ...options, signal: pending.signal } : options;
        connector(connectOptions, callback);
      }
    });
    this.pendingSignals = pendingSignals;
  }

  override dispatch(options: DispatchOptionsWithSignal, handler: Dispatcher.DispatchHandler): boolean {
    const key = options.origin === undefined ? undefined : originKey(options.origin);
    const pending = key === undefined ? undefined : { signal: options.signal };
    if (key !== undefined && pending) {
      const queue = this.pendingSignals.get(key) ?? [];
      queue.push(pending);
      this.pendingSignals.set(key, queue);
    }
    const wrapped = pending === undefined || key === undefined
      ? handler
      : wrapPendingSignalHandler(handler, pending, this.pendingSignals, key);
    try {
      return super.dispatch(options, wrapped);
    } catch (error) {
      if (pending !== undefined && key !== undefined) removePendingSignal(this.pendingSignals, key, pending);
      throw error;
    }
  }
}

function originKey(origin: string | URL): string {
  try {
    return new URL(String(origin)).origin;
  } catch {
    return String(origin);
  }
}

function connectOriginKey(options: buildConnector.Options): string {
  const hostname = options.hostname || options.host || "";
  const authority = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return originKey(`${options.protocol}//${authority}${options.port ? `:${options.port}` : ""}`);
}

function takePendingSignal(
  pendingSignals: Map<string, PendingConnectSignal[]>,
  key: string
): PendingConnectSignal | undefined {
  const queue = pendingSignals.get(key);
  const pending = queue?.shift();
  if (queue?.length === 0) pendingSignals.delete(key);
  return pending;
}

function removePendingSignal(
  pendingSignals: Map<string, PendingConnectSignal[]>,
  key: string,
  pending: PendingConnectSignal
): void {
  const queue = pendingSignals.get(key);
  if (!queue) return;
  const index = queue.indexOf(pending);
  if (index !== -1) queue.splice(index, 1);
  if (queue.length === 0) pendingSignals.delete(key);
}

function wrapPendingSignalHandler(
  handler: Dispatcher.DispatchHandler,
  pending: PendingConnectSignal,
  pendingSignals: Map<string, PendingConnectSignal[]>,
  key: string
): Dispatcher.DispatchHandler {
  return new Proxy(handler, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        (property === "onError" || property === "onComplete" ||
          property === "onResponseError" || property === "onResponseEnd") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          removePendingSignal(pendingSignals, key, pending);
          return Reflect.apply(value, target, args);
        };
      }
      return value;
    }
  });
}

function socksConnector(proxy: ParsedProxy, timeoutMs?: number): buildConnector.connector {
  const socksProxy = toSocksProxy(proxy);
  const connectTimeoutMs = resolveProxyTimeout(timeoutMs);
  // socks5h 的全部意义就是「域名交给代理解析」，本机再查一次等于把 DNS 污染请回来。
  const resolveLocally = proxy.scheme !== "socks5h";
  // TLS 升级交回 undici 自己的 connector（httpSocket 就是为这个留的口子），
  // 这样 ALPN 协商、servername 推导、TLS session 复用与直连时逐字节一致，
  // 不会出现「只有走代理时才复现」的握手怪象。
  const upgradeTls = buildConnector({ timeout: connectTimeoutMs });
  return (rawOptions, callback) => {
    const options = rawOptions as SocksConnectorOptions;
    const signal = options.signal;
    if (signalAborted(signal)) {
      callback(abortError(signal), null);
      return;
    }
    openSocksTunnel(socksProxy, proxy.scheme, options, resolveLocally, connectTimeoutMs, signal).then(
      (socket) => {
        if (options.protocol !== "https:") {
          if (signalAborted(signal)) {
            socket.destroy();
            callback(abortError(signal), null);
            return;
          }
          callback(null, socket);
          return;
        }
        let finished = false;
        const onAbort = () => {
          if (finished) return;
          finished = true;
          socket.destroy();
          callback(abortError(signal), null);
        };
        addSignalListener(signal, onAbort);
        const onUpgraded: buildConnector.Callback = (error, secure) => {
          if (finished) {
            if (!error) secure?.destroy();
            return;
          }
          finished = true;
          removeSignalListener(signal, onAbort);
          // undici 只会销毁它自己造的那层 TLSSocket，底下这条 SOCKS 连接会一直挂到超时。
          if (error) socket.destroy();
          if (error) callback(error, null);
          else callback(null, secure as Socket | TLSSocket);
        };
        if (signalAborted(signal)) {
          onAbort();
          return;
        }
        upgradeTls({ ...options, httpSocket: socket }, onUpgraded);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null)
    );
  };
}

async function openSocksTunnel(
  proxy: SocksProxy,
  scheme: ProxyScheme,
  options: buildConnector.Options,
  resolveLocally: boolean,
  timeoutMs: number | undefined,
  signal?: RequestSignal | null
): Promise<Socket> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const host = resolveLocally
    ? await raceWithSignal(
      resolveDestination(options.hostname, scheme === "socks4"),
      signal,
      undefined,
      remainingTimeout(deadline)
    )
    : options.hostname;
  const proxySocket = await connectSocksProxy(proxy, remainingTimeout(deadline), signal);
  try {
    const result = await raceWithSignal(
      SocksClient.createConnection({
        command: "connect",
        proxy,
        destination: { host, port: Number(options.port) || (options.protocol === "https:" ? 443 : 80) },
        existing_socket: proxySocket,
        ...(remainingTimeout(deadline) === undefined ? {} : { timeout: remainingTimeout(deadline) })
      }),
      signal,
      () => proxySocket.destroy()
    );
    return result.socket;
  } catch (error) {
    proxySocket.destroy();
    throw error;
  }
}

function connectSocksProxy(
  proxy: SocksProxy,
  timeoutMs: number | undefined,
  signal?: RequestSignal | null
): Promise<Socket> {
  const host = proxy.host ?? proxy.ipaddress;
  if (!host) return Promise.reject(new Error("SOCKS 代理缺少主机名。"));
  return new Promise<Socket>((resolve, reject) => {
    const socket = net.connect({ host, port: proxy.port });
    let settled = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => fail(new Error(`连接 SOCKS 代理超时（${timeoutMs}ms）。`)), timeoutMs);
    timer?.unref();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      removeSignalListener(signal, onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("SOCKS 代理连接在握手前关闭。"));
    const onAbort = () => fail(abortError(signal));

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal) {
      addSignalListener(signal, onAbort);
      if (signalAborted(signal)) onAbort();
    }
  });
}

function raceWithSignal<T>(
  work: Promise<T>,
  signal: RequestSignal | null | undefined,
  onAbort?: () => void,
  timeoutMs?: number
): Promise<T> {
  if (!signal && timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        onAbort?.();
        finish(() => reject(new Error("SOCKS 连接超时。")));
      }, timeoutMs);
    timer?.unref();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      removeSignalListener(signal, abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      onAbort?.();
      finish(() => reject(abortError(signal)));
    };
    addSignalListener(signal, abort);
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    );
    if (signalAborted(signal)) abort();
  });
}

function signalAborted(signal: RequestSignal | null | undefined): boolean {
  return signal !== null &&
    signal !== undefined &&
    "aborted" in signal &&
    Boolean((signal as { aborted?: unknown }).aborted);
}

function addSignalListener(signal: RequestSignal | null | undefined, listener: () => void): void {
  if (!signal) return;
  if ("addEventListener" in signal && typeof (signal as AbortSignal).addEventListener === "function") {
    (signal as AbortSignal).addEventListener("abort", listener, { once: true });
    return;
  }
  (signal as EventEmitter).once("abort", listener);
}

function removeSignalListener(signal: RequestSignal | null | undefined, listener: () => void): void {
  if (!signal) return;
  if ("removeEventListener" in signal && typeof (signal as AbortSignal).removeEventListener === "function") {
    (signal as AbortSignal).removeEventListener("abort", listener);
    return;
  }
  (signal as EventEmitter).removeListener("abort", listener);
}

function remainingTimeout(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(1, deadline - Date.now());
}

function abortError(signal?: RequestSignal | null): Error {
  const reason = signal && "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  return reason instanceof Error ? reason : new Error("SOCKS 连接已取消。");
}

/**
 * socks4/socks5 的协议语义就是「客户端先把域名解析好，交给代理的是 IP」，所以这里必须自己查 DNS。
 * SOCKS4 的地址字段只有 4 字节，IPv6 根本写不进去：与其把一个 v6 地址硬塞进去、
 * 换回一个看不懂的 91 request-rejected，不如在这里就把原因说清楚。
 */
async function resolveDestination(hostname: string, ipv4Only: boolean): Promise<string> {
  if (net.isIP(hostname)) {
    if (ipv4Only && !net.isIPv4(hostname)) throw socks4Ipv6Error(hostname);
    return hostname;
  }
  let address: string;
  try {
    ({ address } = await dns.promises.lookup(hostname, ipv4Only ? { family: 4 } : {}));
  } catch (error) {
    if (!ipv4Only) throw error;
    throw new Error(`SOCKS4 只能连 IPv4，而 ${hostname} 没解析出 A 记录（${describeError(error)}）。改用 socks5h:// 可以把域名整个交给代理解析。`);
  }
  if (ipv4Only && !net.isIPv4(address)) throw socks4Ipv6Error(hostname);
  return address;
}

function socks4Ipv6Error(hostname: string): Error {
  return new Error(`SOCKS4 只能连 IPv4，而 ${hostname} 解析出的是 IPv6 地址。请改用 socks5h://。`);
}

/**
 * SOCKS4 的鉴权只有一个 userId 字段（用户名/密码认证是 SOCKS5 才有的扩展），
 * 把密码一起塞过去会被代理当成协议错误，所以按版本分别取。
 */
function toSocksProxy(proxy: ParsedProxy): SocksProxy {
  const { username, password } = new URL(proxy.url);
  const userId = safeDecode(username);
  const secret = safeDecode(password);
  return {
    host: proxy.host,
    port: proxy.port,
    type: proxy.scheme === "socks4" ? 4 : 5,
    ...(userId ? { userId } : {}),
    ...(proxy.scheme !== "socks4" && secret ? { password: secret } : {})
  };
}

/**
 * 只换 https.globalAgent 的理由：Cursor 的两个上游（api.cursor.com、api2.cursor.sh）全是 https，
 * connect-node 在 HTTP/1.1 模式下调 https.request 且不传 agent，正好落到 https.globalAgent。
 * 明文 http 上游在本网关里根本不存在，为它再引一个 http-proxy-agent 依赖不划算。
 * SOCKS 是另一回事：一个 SocksProxyAgent 实例同时能服务 http 与 https，顺手两个都换掉。
 */
function buildNativeAgents(proxy: ParsedProxy): { httpAgent?: http.Agent; httpsAgent: https.Agent } {
  if (proxy.scheme === "http" || proxy.scheme === "https") {
    return { httpsAgent: asHttpsAgent(new HttpsProxyAgent(proxy.url)) };
  }
  const socks = asHttpsAgent(new SocksProxyAgent(proxy.url));
  return { httpAgent: socks, httpsAgent: socks };
}

/**
 * 两个代理 agent 都继承自 http.Agent 而不是 https.Agent（差别只在 options 的类型标注上）。
 * node 在发请求时只会用到 createConnection/addRequest，运行时完全兼容，这里只是补上类型。
 */
function asHttpsAgent(agent: http.Agent): https.Agent {
  return agent as https.Agent;
}

function collectWarnings(proxy: ParsedProxy | undefined, useHttp1ForAgent: boolean): string[] {
  if (!proxy) return [];
  const warnings: string[] = [];
  if (!useHttp1ForAgent) {
    warnings.push(
      "已配置代理，但「Cursor SDK HTTP/1.1」被显式关掉了：模型流量（api2.cursor.sh）走 connect-node 的 HTTP/2，" +
        "而 node:http2 完全不支持代理，这部分仍会直连，在墙内基本必然超时。" +
        "请到后台「运行设置」把这个开关改成「强制开启」或「未设置（配了代理就自动开）」——" +
        "只改 CURSOR_SDK_USE_HTTP1_FOR_AGENT 不一定有用：落库的显式取值优先级高于环境变量。"
    );
  }
  if (proxy.scheme === "socks4") {
    warnings.push(
      "SOCKS4 的地址字段只有 4 字节：目标域名由网关本机解析成 IPv4 再交给代理，DNS 被污染时会连到错误的 IP，" +
        "只有 AAAA 记录的站点则直接连不上；鉴权也只有 userId、不支持密码。建议改用 socks5h://。"
    );
  }
  if (proxy.scheme === "socks5") {
    warnings.push(
      "socks5:// 按协议语义由网关本机解析域名（REST 与模型两条路都是），DNS 被污染时会连到错误的 IP。" +
        "想把域名交给代理解析，请改用 socks5h://。"
    );
  }
  return warnings;
}

async function probeWithDispatcher(dispatcher: Dispatcher, target: string, timeoutMs: number): Promise<number> {
  const response = await undiciRequest(target, {
    dispatcher,
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs)
  });
  // 不读完 body，socket 会一直挂在连接池里等到超时。
  await response.body.dump();
  return response.statusCode;
}

/**
 * 模型那条路只能这么探：connect-node 在 HTTP/1.1 下调的就是 https.request 且不传 agent。
 * 这里显式传一个一次性 agent 而不是临时改 https.globalAgent——后者会在探测的几秒里
 * 把正在跑的对话一起换到测试用的连接池上。
 */
function probeWithAgent(proxy: ParsedProxy, target: string, timeoutMs: number): Promise<number> {
  const agent = buildProbeAgent(proxy, timeoutMs);
  const options = { agent, method: "GET", signal: AbortSignal.timeout(timeoutMs) };
  const plaintext = target.toLowerCase().startsWith("http://");
  return new Promise<number>((resolve, reject) => {
    const onResponse = (res: http.IncomingMessage) => {
      res.resume();
      const status = res.statusCode ?? 0;
      // https-proxy-agent 在 CONNECT 被回绝时**不抛错**：它拆掉真 socket，另造一个假 socket
      // 把代理那条响应原样回放给 http 客户端。于是密码写错的代理会以「HTTP 407」的形态
      // 交到这里，看起来和上游的回应一模一样，而通往 api2.cursor.sh 的隧道从未存在。
      // TLS 是唯一可靠的分界：真上游的响应必然是从隧道里那层 TLSSocket 读出来的，
      // 回放出来的假 socket 不可能是加密的。
      if (!plaintext && !isEncrypted(res.socket)) {
        reject(proxyRejectedTunnel(status));
        return;
      }
      resolve(status);
    };
    const request = plaintext
      ? http.request(target, options, onResponse)
      : https.request(target, options, onResponse);
    request.on("error", reject);
    request.end();
  }).finally(() => agent.destroy());
}

function isEncrypted(socket: Socket | null | undefined): boolean {
  return (socket as TLSSocket | null | undefined)?.encrypted === true;
}

function proxyRejectedTunnel(status: number): Error {
  return new Error(
    `代理自己回了 HTTP ${status} 并拒绝建立 CONNECT 隧道，请求根本没到达目标站点。` +
      (status === 407
        ? "407 是代理要求鉴权：多半是代理地址里的用户名/密码不对或没写。"
        : "请确认该代理允许 CONNECT 到这个主机和端口。")
  );
}

/** 与 buildNativeAgents 同一套构造逻辑，区别只在于这个 agent 用完即弃，绝不进 globalAgent。 */
function buildProbeAgent(proxy: ParsedProxy, timeoutMs: number): http.Agent {
  return proxy.scheme === "http" || proxy.scheme === "https"
    ? new HttpsProxyAgent(proxy.url, { timeout: timeoutMs })
    : new SocksProxyAgent(proxy.url, { timeout: timeoutMs });
}

/** 优雅关闭：close() 会等在途请求收尾，失败再强拆，避免换代理时打断正在跑的对话。 */
async function disposeDispatcher(dispatcher: Dispatcher | undefined, timeoutMs = DISPATCHER_DRAIN_TIMEOUT_MS): Promise<void> {
  if (!dispatcher) return;
  try {
    await withTimeout(dispatcher.close(), timeoutMs);
  } catch {
    await dispatcher.destroy().catch(() => undefined);
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dispatcher drain timeout")), timeoutMs);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function disposeAgents(agents: http.Agent[]): void {
  // 后台动作：调用方（后台保存代理）不该为排空等待，新代理此刻已经装好了。
  for (const agent of agents) void drainAgent(agent);
}

/**
 * 旧 agent 不能直接 destroy()——那不只是关掉连接池，而是把**正在传输**的 socket 一起拆掉：
 * 换代理或清代理的那一瞬间，所有在途的 HTTP/1.1 模型请求都会变成传输错误，
 * 而运维只是改了个设置。undici 那侧的 close() 本来就会等在途请求收尾，这边要对齐。
 * 空闲连接立刻拆（留着只会白占端口，也不会有新请求再落到旧 agent 上），
 * 活跃连接等它自己收尾；超时才强拆兜底，免得一条挂死的 socket 让 agent 永远留在内存里。
 */
async function drainAgent(agent: http.Agent): Promise<void> {
  try {
    destroyIdleSockets(agent);
    const deadline = Date.now() + AGENT_DRAIN_TIMEOUT_MS;
    while (activeSocketCount(agent) > 0 && Date.now() < deadline) {
      await sleep(AGENT_DRAIN_POLL_MS);
      destroyIdleSockets(agent);
    }
    agent.destroy();
  } catch {
    // 排空失败最坏只是几条 socket 多活一会儿，不该反过来影响新代理已经装好的事实。
  }
}

function destroyIdleSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets ?? {})) {
    for (const socket of sockets ?? []) socket.destroy();
  }
}

function activeSocketCount(agent: http.Agent): number {
  let count = 0;
  for (const sockets of Object.values(agent.sockets ?? {})) count += sockets?.length ?? 0;
  return count;
}

/** 排空跑在后台，定时器必须 unref：否则关掉代理之后进程会被这串轮询多吊住十分钟。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** SOCKS 握手的截止时间跟请求超时走同一套配置；探测则由调用方传入自己的 5/10 秒窗口。 */
function resolveProxyTimeout(value?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const raw = process.env.REQUEST_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * 从候选 URL 里抠出端口文本。只在 new URL 已经拒绝后用，用于把「端口写错」和「整条地址写错」分开报错；
 * 返回值只用于选择错误类别，绝不回显，因为没有通过 URL 校验的 authority 不能确认凭据边界。
 * 需要自己处理 userinfo 里可能出现的冒号，以及 IPv6 字面量的方括号。
 */
function authorityPort(candidate: string): string | undefined {
  const authority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  const searchFrom = hostPart.startsWith("[") ? hostPart.indexOf("]") : 0;
  if (searchFrom < 0) return undefined;
  const colon = hostPart.indexOf(":", searchFrom);
  if (colon === -1) return undefined;
  // `http://host:` 按 WHATWG 就是「用默认端口」，不算写错。
  return hostPart.slice(colon + 1) || undefined;
}

function isValidPortText(text: string): boolean {
  return /^\d+$/.test(text) && isValidPort(Number(text));
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function describeError(error: unknown): string {
  const base = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  // undici / node 常把真正的原因（ECONNREFUSED、ETIMEDOUT）塞在 cause 里，只看 message 会得到一句空话。
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  const text = `${base}${cause}`;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** 代理报错里经常原样带出配置的 URL，凭据必须在返回给调用方之前抹掉。 */
function scrubCredentials(text: string, proxy: ParsedProxy): string {
  if (!proxy.hasAuth) return text;
  let scrubbed = text.split(proxy.url).join(maskProxyUrl(proxy.url));
  const { username, password } = new URL(proxy.url);
  for (const secret of [password, username, safeDecode(password), safeDecode(username)]) {
    if (secret) scrubbed = scrubbed.split(secret).join("***");
  }
  return scrubbed;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function invalidProxy(message: string): ApiError {
  return new ApiError(message, 400, "invalid_request_error", "proxyUrl");
}
