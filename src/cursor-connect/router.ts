import type { CursorRunner } from "../types.js";

/**
 * Provider 选路（计划 §P6）。
 *
 * 两条路线必须互不污染：SDK 路线用 Cursor API key + `@cursor/sdk` 的 Agent 生命周期，
 * Connect 路线用 session JWT + 自己的 transport。一条路线的 key、重试和错误
 * 不能影响另一条，所以选路是**纯函数**，不持有任何跨 provider 的状态。
 */
export type ProviderId = "sdk" | "connect";

export const CONNECT_MODEL_PREFIX = "connect/";
export const PROVIDER_HEADER = "x-gateway-provider";

export interface ProviderSelectionInput {
  /** 入站请求头（已小写化或大小写不敏感查找）。 */
  headers?: Record<string, string | string[] | undefined>;
  /** 客户端请求的模型名，可能带 `connect/` 前缀。 */
  model?: string;
  /** 网关密钥上的显式设置。取值来自库里，可能是任意字符串，内部会归一化。 */
  keySetting?: string;
  /** 全局默认。缺省 sdk——Connect 路线还没有实测过工具循环，不能默认接管流量。 */
  defaultProvider?: ProviderId;
  /** Connect provider 是否真的可用（有凭据、已构造）。不可用时一律回落 sdk。 */
  connectAvailable?: boolean;
}

export interface ProviderSelection {
  provider: ProviderId;
  /** 去掉 `connect/` 前缀后的模型名，供下游使用。 */
  model?: string;
  /** 选中的理由，进请求日志用；出问题时能一眼看出是哪条规则命中的。 */
  reason: string;
}

/**
 * 优先级：显式 header > 模型前缀 > key 设置 > 全局默认。
 * 越显式的越优先——运维临时用 header 压测某条路线时，不该被 key 上的设置盖掉。
 */
export function selectProvider(input: ProviderSelectionInput): ProviderSelection {
  const requested = requestedFrom(input) ?? { provider: input.defaultProvider ?? "sdk", reason: "default" };
  const model = stripPrefix(input.model, requested.provider);

  // 可用性检查必须覆盖**默认**那条路径，不只是显式指定的：
  // `defaultProvider: "connect"` 而 Connect 没配好时，漏掉这里就会一路走到 runnerFor 抛错。
  if (requested.provider === "connect" && input.connectAvailable === false) {
    // 明确回落而不是报错：Connect 凭据没配好时，请求不该整体失败。
    return { provider: "sdk", ...model, reason: `${requested.reason}-unavailable-fallback-sdk` };
  }
  return { provider: requested.provider, ...model, reason: requested.reason };
}

function requestedFrom(input: ProviderSelectionInput): { provider: ProviderId; reason: string } | undefined {
  const header = normalizeProvider(headerValue(input.headers, PROVIDER_HEADER));
  if (header) return { provider: header, reason: "header" };

  if (input.model?.toLowerCase().startsWith(CONNECT_MODEL_PREFIX)) {
    return { provider: "connect", reason: "model-prefix" };
  }
  // key 设置来自数据库/后台，同样要过归一化。直接信任的话一个大小写不对的旧值
  // 会一路带到 `runnerFor`，那里按 `=== "connect"` 判断，于是请求被记成 Connect、
  // 却在 SDK runner 上执行，capability 又报的是 Connect 那张表。
  const keyed = normalizeProvider(input.keySetting);
  if (keyed) return { provider: keyed, reason: "key-setting" };
  return undefined;
}

/**
 * `connect/` 只是选路命名空间，不是模型名的一部分，所以选中 Connect 时要去掉。
 * 回落到 SDK 时同样要去掉——否则 SDK 会拿着一个目录里根本不存在的 `connect/x` 去查。
 */
function stripPrefix(model: string | undefined, _provider: ProviderId): { model?: string } {
  if (!model) return {};
  if (!model.toLowerCase().startsWith(CONNECT_MODEL_PREFIX)) return { model };
  const stripped = model.slice(CONNECT_MODEL_PREFIX.length);
  // 只有前缀、没有模型名时返回空对象而不是空串：空串是"有值"，
  // 下游 `selection.model ?? default` 就不会回落到默认模型。
  return stripped ? { model: stripped } : {};
}

function normalizeProvider(value: string | undefined): ProviderId | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "connect" || trimmed === "cursor-connect") return "connect";
  if (trimmed === "sdk" || trimmed === "cursor-sdk") return "sdk";
  return undefined;
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value.find((item) => typeof item === "string" && item.trim());
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export interface ProviderRouterOptions {
  sdk: CursorRunner;
  connect?: CursorRunner;
  defaultProvider?: ProviderId;
}

/**
 * 按选路结果取 runner。两个 runner 都实现同一个 `CursorRunner`，
 * 所以路由层不需要知道任何 provider 细节，也不需要新增抽象层。
 */
export class ProviderRouter {
  constructor(private readonly options: ProviderRouterOptions) {}

  get connectAvailable(): boolean {
    return Boolean(this.options.connect);
  }

  select(input: Omit<ProviderSelectionInput, "connectAvailable" | "defaultProvider">): ProviderSelection {
    return selectProvider({
      ...input,
      connectAvailable: this.connectAvailable,
      defaultProvider: this.options.defaultProvider
    });
  }

  runnerFor(provider: ProviderId): CursorRunner {
    if (provider === "connect") {
      // select() 已经处理过不可用的回落；走到这里还没有就是接线错误，不该静默降级。
      if (!this.options.connect) throw new Error("Connect provider is not configured.");
      return this.options.connect;
    }
    return this.options.sdk;
  }

  /** 能力声明。对外 capability 必须与实际能力一致，宁可少报不能多报。 */
  capabilities(provider: ProviderId): Record<string, boolean> {
    // 没接 runner 的路线什么都不能做。不判这一下，后台会把一条一个请求都服务不了的
    // 路线宣传成「支持文本与思考」。
    if (provider === "connect" && !this.connectAvailable) {
      return { text: false, thinking: false, tools: false, subagents: false, background: false, replay: false };
    }
    if (provider === "sdk") {
      // SDK 路线走 server.ts，工具是真的通的；子代理 / background / 重放在这条路线上没有。
      return { text: true, thinking: true, tools: true, subagents: false, background: false, replay: false };
    }
    return {
      text: true,
      thinking: true,
      // 以下四项模块都已实现，但都**还没接进 server.ts**，且工具循环那条
      // "同 conversation_id 的第二次 Stream 能否接续"仍未实测。接线并实测前一律报 false：
      // "模块写完了"和"这条路线对外真能用"是两回事，调用方关心的是后者。
      tools: false,
      subagents: false,
      background: false,
      replay: false
    };
  }
}
