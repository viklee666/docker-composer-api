export type ProtocolKind = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface GatewayConfig {
  host: string;
  port: number;
  cursorApiKeys: string[];
  gatewayApiKey?: string;
  adminPassword?: string;
  allowDirectCursorKeys: boolean;
  sqlitePath: string;
  /** 请求历史保留条数上限，0 = 全量保留（默认）。env: REQUEST_LOG_KEEP。 */
  requestLogKeep: number;
  cursorWorkingDirectory: string;
  requestTimeoutMs: number;
  sdkClientVersion: string;
  /**
   * Kill switch：为 true 时强制 `cursorSdkSessionMode=stateless`（每请求 create+全文+假成功+cancel+dispose）。
   * 默认 false；设 `CURSOR_SDK_DISABLE_SESSION_RESUME=true` 后须重启才会生效（无热切换）。
   * env: CURSOR_SDK_DISABLE_SESSION_RESUME。
   */
  cursorSdkDisableSessionResume: boolean;
  /**
   * Agent 会话模式。未设置时默认 durable。kill switch 为 true 时强制 stateless，忽略本字段的 env 值。
   * 显式 `stateless` 仍有效。改 mode 只能改 env 后重启。
   * env: CURSOR_SDK_SESSION_MODE。
   */
  cursorSdkSessionMode: CursorSdkSessionMode;
  /** 挂起工具 execute 的最长等待（毫秒）。env: CURSOR_SDK_TOOL_HOLD_TTL_MS，默认 15min。 */
  cursorSdkToolHoldTtlMs: number;
  /** durable 空闲 agent 回收阈值（毫秒）。env: CURSOR_SDK_SESSION_IDLE_TTL_MS，默认 60min。 */
  cursorSdkSessionIdleTtlMs: number;
  /** SessionHub 同时存活的会话上限（LRU）。env: CURSOR_SDK_MAX_LIVE_SESSIONS，默认 256。 */
  cursorSdkMaxLiveSessions: number;
  /**
   * 是否允许 Cursor agent 在网关容器内使用自己的内置工具（shell/edit/grep 等）。
   * 默认 false：无客户端工具时纯文本模式，有客户端工具时只保留 MCP 元工具通道（customTools 经此暴露），
   * 防止 agent 在网关侧真实执行文件/命令操作后又把调用转发给客户端造成双重执行。
   */
  cursorAllowBuiltinTools: boolean;
  /** 强制 Cursor local agent 使用 HTTP/1.1 + SSE（env: CURSOR_SDK_USE_HTTP1_FOR_AGENT）。 */
  cursorSdkUseHttp1ForAgent: boolean;
  /**
   * 启动时预热 SDK 本地工作区（env: CURSOR_PREWARM，默认开）。
   * 预热只是省掉首请求的冷启动，但它会进 SDK 的原生工作区扫描；
   * 该扫描在部分宿主（实测 Windows + @cursor/sdk 1.0.27）会直接触发 access violation
   * 把进程打挂——原生崩溃是 JS try/catch 抓不到的，所以必须留一个开关能整块关掉。
   */
  cursorPrewarm: boolean;
  /** 单次请求轮换 key 的最大尝试数（env: MAX_KEY_ATTEMPTS）。 */
  maxKeyAttempts: number;
  /** 单次请求软失败（换 key 但不禁用）的最大重试数（env: MAX_TRANSIENT_KEY_ATTEMPTS）。 */
  maxTransientAttempts: number;
  /** 额度/认证类错误是否自动禁用 key（env: AUTO_DISABLE_KEYS，后台可改）。关闭后只轮换、不禁用。 */
  autoDisableKeys: boolean;
  /** 自动禁用前允许的连续失败次数（env: AUTO_DISABLE_THRESHOLD，后台可改）。 */
  autoDisableThreshold: number;
  /** 客户端未显式指定时的默认思考强度/推理强度（env: CURSOR_REASONING_EFFORT），如 low/medium/high/max。 */
  cursorReasoningEffort?: string;
  /** 客户端未显式指定时是否默认开启 Max Mode / 大上下文（env: CURSOR_MAX_MODE）。 */
  cursorMaxMode?: boolean;
  /** 客户端未显式指定时是否默认使用 fast 变体（env: CURSOR_FAST）。 */
  cursorFast?: boolean;
  /** 透传给所有请求的默认 Cursor model.params（env: CURSOR_MODEL_PARAMS，`id=value,id2=value2` 或 JSON）。 */
  cursorModelParams?: ModelParameterValue[];
  /** 默认 Cursor 会话模式 agent/plan（env: CURSOR_AGENT_MODE）。 */
  cursorAgentMode?: AgentMode;
  /**
   * 全局 Sand 通道：把发给 Cursor 的 x-cursor-client-type 从 sdk 改成 sand。
   * 单个 key 可覆盖（inherit / sdk / sand）。env: SAND_CLIENT_MODE，后台可改。
   */
  sandClientMode: boolean;
  /** key 取用策略：fill-first（默认，吃满第一个 key 以命中 Cursor 缓存）或 round-robin。 */
  routingStrategy: RoutingStrategy;
  /** 会话粘性：同一会话固定复用上次成功的 key，保住上游缓存。env: SESSION_AFFINITY，后台可改。 */
  sessionAffinity: boolean;
  /** 会话粘性绑定的存活时长，超时后重新按策略选 key。env: SESSION_AFFINITY_TTL_MS。 */
  sessionAffinityTtlMs: number;
  /** 出站代理（http/https/socks5），空表示直连。env: PROXY_URL，后台可改（需重启生效）。 */
  proxyUrl?: string;
  /** 默认系统提示词的注入方式。env: SYSTEM_PROMPT_MODE，后台可改。 */
  systemPromptMode: SystemPromptMode;
  /** 默认系统提示词正文。env: SYSTEM_PROMPT，后台可改。 */
  systemPrompt?: string;

  /* ------------------------------- Cursor Connect 路线（aiserver.v1.InferenceService/Stream） */

  /**
   * 以下 Connect 字段全部**可选**：既有部署与测试里的 config 字面量不必知道这条路线的存在。
   * 缺省值由 `connectSettings(config)` 统一填，不要在使用处各写各的 `?? default`。
   */

  /**
   * 默认走哪条 provider。默认 `sdk`：Connect 路线的工具循环尚未实测过，
   * 不能默认接管全部流量。env: GATEWAY_PROVIDER，后台可改。
   */
  defaultProvider?: GatewayProvider;
  /** Connect 出站 base URL。env: CURSOR_CONNECT_BASE_URL。 */
  connectBaseUrl?: string;
  /** Connect 请求体编码；json 只作调试。env: CURSOR_CONNECT_CODEC。 */
  connectCodec?: "proto" | "json";
  /** 单帧 payload 上限（字节）。env: CURSOR_CONNECT_MAX_FRAME_BYTES。 */
  connectReadMaxBytes?: number;
  /** 是否向上游声明工具。默认 false，见计划 §P2 未实测的接续假设。env: CURSOR_CONNECT_SEND_TOOLS。 */
  connectSendTools?: boolean;
  /** 允许启用的网关本地工具名（默认全关）。env: CURSOR_CONNECT_LOCAL_TOOLS。 */
  connectLocalTools?: string[];
  /** 是否启用网关编排子代理。env: CURSOR_CONNECT_SUBAGENTS。 */
  connectSubagents?: boolean;
  /** background worker 是否启动。env: CURSOR_CONNECT_BACKGROUND。 */
  connectBackground?: boolean;
  /** 从 env 播种的 Connect session token（首次启动时写入 cc_credentials）。env: CURSOR_CONNECT_TOKEN。 */
  connectSessionToken?: string;
  /** 播种凭据的设备标识；不给则自动生成一个并持久化（**生命周期内不可变**）。env: CURSOR_CONNECT_MACHINE_ID。 */
  connectMachineId?: string;
  /** 播种凭据的客户端版本号。env: CURSOR_CONNECT_CLIENT_VERSION。 */
  connectClientVersion?: string;
}

/** Cursor SDK 会话生命周期：durable 复用 agent；stateless 为今日每请求新建。 */
export type CursorSdkSessionMode = "durable" | "stateless";

/**
 * 多 key 取用策略。
 * - fill-first：按 sort_order 取第一个可用 key，吃满为止。Cursor 侧按 key 缓存 prompt，
 *   换 key 就丢缓存，所以这是默认值。
 * - round-robin：按 weight 加权轮询，摊平各 key 的用量。
 */
export type RoutingStrategy = "fill-first" | "round-robin";

/** 默认系统提示词的注入方式：off 不注入、append 追加在客户端 system 之后、override 覆盖客户端 system。 */
export type SystemPromptMode = "off" | "append" | "override";

/** 网关默认系统提示词设置。 */
export interface SystemPromptSettings {
  mode: SystemPromptMode;
  text?: string;
}

/**
 * 模型可见范围：allowed 非空时只允许其中的模型（白名单），excluded 里的一律拒绝（黑名单优先）。
 * 两个列表都存模型 id（大小写不敏感），空数组表示不限制。
 */
export interface ModelScope {
  allowed: string[];
  excluded: string[];
}

/**
 * 一个模型的全部叫法：归一化后的请求名 + 目录里的 canonical id + 全部 alias。
 * 黑白名单两侧写的都可能只是其中一种叫法，只有把请求展开成整组名字，两侧才对称——
 * 否则用别名请求能绕过按 id 写的黑名单，只写 id 的白名单也会把别名请求误拒。
 */
export interface ModelIdentity {
  /** 归一化后的请求名。目录不可用时它与静态别名组就是身份的全部。 */
  requested: string;
  /** 全部叫法，已去空白 + 小写 + 去重。 */
  names: string[];
  /**
   * 所有相关上游目录是否都确认过这组叫法。false 不只表示「没查到」，
   * 也表示多账号并集中有任一目录失败；残缺的并集对黑名单而言可能漏判，
   * 判定方必须按 denyRuleUnverifiable 兜底。
   */
  confirmed: boolean;
}

/** 实际发给 Cursor 的 x-cursor-client-type。 */
export type CursorClientType = "sdk" | "sand";

/** key 级通道：跟随全局总开关，或强制 sdk / sand。 */
export type CursorClientTypeSetting = "inherit" | CursorClientType;

export type AgentMode = "agent" | "plan";

/** 单个 Cursor 模型参数取值，对应 SDK ModelSelection.params 里的一项。 */
export interface ModelParameterValue {
  id: string;
  value: string;
}

/** Cursor.models.list() 返回的单个参数定义里的一个可选值。 */
export interface ModelParameterDefinitionValue {
  value: string;
  displayName?: string;
}

/** Cursor.models.list() 返回的某模型的一个参数定义（如 fast / reasoning / effort / 上下文）。 */
export interface ModelParameterDefinition {
  id: string;
  displayName?: string;
  values: ModelParameterDefinitionValue[];
}

/** Cursor.models.list() 返回的预设参数组合（官方文档：variants 可直接拷进 model selection）。 */
export interface ModelVariantDefinition {
  displayName: string;
  description?: string;
  isDefault?: boolean;
  params: ModelParameterValue[];
}

export interface AuthContext {
  mode: "gateway" | "direct";
  /** 仅 direct 模式有值；gateway 模式在运行时从密钥池解析。 */
  apiKey?: string;
  ownerHash: string;
  /** 命中的网关 API 密钥（gateway 模式且用了 gateway_keys 表里的多密钥时有值）。 */
  gatewayKeyId?: string;
  gatewayKeyLabel?: string;
  /**
   * 该网关密钥允许使用的 Cursor key id；undefined/空表示不限制。
   * 由 KeyRotatingRunner 在选 key 时求交集。
   * 只含 `NO_KEY_SENTINEL` 时表示「什么都不许用」（绑定的 key 已被删光），选 key 必然落空 → 403。
   */
  allowedCursorKeyIds?: string[];
  /** 该网关密钥的模型可见范围；undefined 表示不限制。 */
  modelScope?: ModelScope;
}

export interface GatewayModel {
  id: string;
  name: string;
  cursorModel: string;
}

export interface GatewayImage {
  type: "image";
  source: "url" | "base64";
  data: string;
  mediaType?: string;
}

export interface GatewayTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface GatewayToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 从客户端全量 history 抽出的本轮增量（server 侧算完再传入 runner；rawBody 不进 runner）。
 * WP2 的 extractDurableTurn 产出此形状。
 */
export interface DurableTurn {
  kind: "new_user" | "tool_results" | "incompatible" | "empty";
  userText?: string;
  images?: GatewayImage[];
  systemFingerprint: string;
  toolsFingerprint: string;
  toolResults?: Array<{ id: string; content: string; isError?: boolean }>;
  /**
   * Unhashed system text after gateway append/override (`resolveSystemText`).
   * First durable send may prefix `SYSTEM:\n{systemText}`. Omitted when empty.
   */
  systemText?: string;
}

export interface KeyUsageRef {
  keyId?: string;
  keyLabel?: string;
}

/** 上游真实上报的 token 用量（SDK 的 turn-ended / usage 事件），非估算。 */
export interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

/** 上游计费金额，单位为「美分」浮点数（SDK UsageCost 原样口径）。 */
export interface RequestCost {
  /** 未打折的模型 token 成本；按请求计价的用量为 0。 */
  rawCostCents: number;
  /** 实际扣费金额（含折扣与 Cursor Token Fee）；套餐内 / BYOK / 赠额用量为 0。 */
  chargedCents: number;
}

/**
 * 运行期遥测的可变引出通道，语义同 KeyUsageRef：
 * 请求侧建一个空对象传进 runner，runner 在跑的过程中把真实下发参数与本次 run 的上游用量写回来，
 * 收尾时由 finishLog 落进 request_logs。UsageReconciler 回查到的是 agent 累计值，不能覆盖这里的本次用量。
 */
export interface RunTelemetryRef {
  /** 实际下发给 Cursor 的 model id（去掉后缀、走过 alias 解析后的值）。 */
  upstreamModel?: string;
  /** 实际下发的 Cursor model.params，用于核对推理强度 / 1M / fast 是否真的生效。 */
  modelParams?: ModelParameterValue[];
  /** 本次请求最终使用的通道。 */
  clientType?: CursorClientType;
  /** 本次 run 上游上报的真实 token 用量；上游没报时为 undefined（此时日志按 estimatedUsage 兜底）。 */
  usage?: RequestUsage;
  /**
   * 上游没报用量时按字符数算出的估算值，只服务请求日志。
   * 刻意与 usage 分开：响应体里的用量各协议自有估算口径（openAiUsage / responsesUsage / anthropicUsage），
   * 把估算值塞进 usage 会让它们改走「拿到真实用量」的分支，凭空多出 cached/reasoning 明细。
   */
  estimatedUsage?: RequestUsage;
  /** 上游计费金额。SDK 侧最终一致，可能在 run 结束后才可查，因此按后台异步补写。 */
  cost?: RequestCost;
  agentId?: string;
  runId?: string;
}

export interface CursorRunRequest {
  protocol: ProtocolKind;
  /** direct 模式为客户端 key；useKeyPool 时由 KeyRotatingRunner 注入。 */
  apiKey: string;
  useKeyPool: boolean;
  keyUsageRef?: KeyUsageRef;
  /** 运行期遥测引出通道：实际下发参数与上游 token 用量写回这里，供请求日志落库。 */
  telemetryRef?: RunTelemetryRef;
  /**
   * 本次请求允许使用的 Cursor key id（来自网关密钥的绑定）；undefined/空表示不限制。
   * 与「key 自身的模型白名单」是两个独立维度，都在选 key 时生效。
   */
  allowedKeyIds?: string[];
  /**
   * 入站网关密钥的模型可见范围；undefined 表示不限制。
   * 选 key 时与 key 自身范围求交，这样即使将来新增的入口漏了入口处的校验，
   * 请求也不会被发到一把超出网关密钥范围的 key 上。
   */
  gatewayModelScope?: ModelScope;
  model: string;
  /** 本次请求模型的全部叫法，由 server 解析一次后下传，免得选 key 时再查一遍目录。 */
  modelIdentity?: ModelIdentity;
  prompt: string;
  sessionKey: string;
  /**
   * 会话粘性的身份，与 sessionKey 分开：只有能认出「这是哪一段对话」时才有值。
   * 不能拿 sessionKey 兜底——它在没有会话头时会退化成 ownerHash（每个网关请求都一样），
   * 那样粘性就变成「把整个网关钉死在一把 key 上」，轮询失效、坏 key 也再不会被重试。
   */
  stickyKey?: string;
  /**
   * 本段对话的稳定种子（显式会话头 / Responses 继承 / conversationSeed(body)）。
   * 与 stickyKey 同源，但不带 ownerHash 前缀；无识别身份时不要填。
   * 有值不代表一定进 SessionHub：Hub 复用还要看 reuseDurableAgent。
   */
  conversationSeed?: string;
  /**
   * 入站网关密钥的 owner 散列。M1/M2 填入后参与 durableAgentId；缺省时 durableSessionId 从 stickyKey 前缀回退。
   */
  ownerHash?: string;
  /**
   * 是否把本请求送进 SessionHub 复用本地 Agent。
   * false：即使有 conversationSeed / stickyKey 也走 stateless（create + 全文）。
   * Chat / Messages 有瀑布 identity 也会进 Hub；重叠由 Hub tryAcquire 改 stateless。
   * 未设时保持旧行为（有 seed/sticky 就进 Hub），给直接调 runner 的单测用。
   */
  reuseDurableAgent?: boolean;
  /**
   * durable 路径的本轮增量。由 server 从入站 body 算出后传入；rawBody 本身不进 runner。
   */
  durableTurn?: DurableTurn;
  /**
   * 仅本请求强制走 stateless（跳过 Hub、旧 resume 的 getSession/saveSession，create+全文+cancel+dispose）。
   * 不改进程级 kill switch。Admin 联通性测试使用，避免粘到用户会话或旧 agent。
   */
  forceStateless?: boolean;
  /** 客户端是否以流式消费本请求（影响 key 轮换重试策略：流式下已发出的 thinking 视为已交付）。 */
  stream?: boolean;
  /** thinking 事件是否会被端点真正转发给客户端（messages 未请求 thinking 时为 false，此时不算已交付产出）。 */
  thinkingVisible?: boolean;
  workingDirectory?: string;
  images: GatewayImage[];
  tools: GatewayTool[];
  toolChoice?: unknown;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  /** 客户端/网关期望的思考强度（none/minimal/low/medium/high/xhigh/max，或 Anthropic thinking budget 推导值）。 */
  reasoningEffort?: string;
  /** 是否请求 Max Mode / 大上下文（如 Anthropic 1M context beta）。 */
  maxMode?: boolean;
  /** 是否请求 fast 变体。 */
  fast?: boolean;
  /** 显式透传的 Cursor model.params（优先级最高，原样发给 SDK）。 */
  modelParams?: ModelParameterValue[];
  /** Cursor 会话模式 agent/plan。 */
  mode?: AgentMode;
  /** 本次请求解析后的 Cursor client-type（sdk / sand）。由 KeyRotatingRunner 按 key 设置写入。 */
  clientType?: CursorClientType;
  /**
   * 本次请求走哪条 provider。由 server 在建请求时按 header / 模型前缀 / key 设置选定，
   * 交给 ProviderRoutingRunner 分发。缺省即 SDK 路线，行为与改造前一致。
   */
  provider?: GatewayProvider;
  /** 入站原始请求体，仅 Connect 路线用来做结构化解析（SDK 路线拿不到也用不上）。 */
  rawBody?: unknown;
  /** 入站协议，供 Connect 路线选择结构化解析器。 */
  inboundProtocol?: "openai-chat" | "openai-responses" | "anthropic";
}

/** 两条推理路线：SDK（@cursor/sdk）与 Connect（aiserver.v1.InferenceService/Stream）。 */
export type GatewayProvider = "sdk" | "connect";

export interface CursorRunResult {
  text: string;
  toolCalls: GatewayToolCall[];
  /** 非流式聚合出的思考全文（流式下思考已逐块发出，这里只服务 run()）。 */
  reasoningText?: string;
  agentId?: string;
  runId?: string;
}

export type CursorStreamEvent =
  | { type: "text"; text: string }
  /** 模型思考过程增量（Anthropic thinking_delta / OpenAI reasoning_content），可选消费。 */
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCall: GatewayToolCall }
  | { type: "done"; result: CursorRunResult };

/**
 * Cursor SDK 共享本地执行器的预热租约管理。
 * warm 让执行器留在 SDK 的进程内缓存里省掉冷启动；recycle 释放租约并冷却，
 * 让引用计数能归零、SDK 得以 dispose 掉鉴权闭包已被污染的执行器。
 */
export interface ExecutorLeaseManager {
  warm(apiKey: string, workingDirectory: string): Promise<void>;
  recycle(apiKey: string, workingDirectory: string): Promise<void>;
  /** 运行期切换传输层或关停时释放全部预热租约。 */
  releaseAll(options?: { timeoutMs?: number }): Promise<{
    ok: boolean;
    failures: readonly string[];
  }>;
}

export interface CursorRunner {
  run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult>;
  stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent>;
}

export interface StoredResponse {
  id: string;
  ownerHash: string;
  response: Record<string, unknown>;
  inputItems: unknown[];
  /**
   * 这条响应所属对话的粘性身份（conversationSeed 的结果）。
   * 续聊请求体里只有新一轮输入，system 与第一条 user 都不在，现算必然每轮都变；
   * 落库后由下一轮继承，整条链才共用同一个身份。纯服务端字段，绝不回显给客户端。
   * 老库补列前的记录读出来是 undefined，此时退回按请求体现算（认不出就不启用粘性）。
   */
  conversationSeed?: string;
  createdAt: string;
  updatedAt: string;
}

export type CursorKeyStatus = "active" | "disabled";

export interface CursorKeyRecord {
  id: string;
  apiKey: string;
  label: string;
  status: CursorKeyStatus;
  source: "env" | "manual";
  /** 取用优先级，越小越先用；由管理后台排序维护。 */
  sortOrder: number;
  disabledReason?: string;
  disabledAt?: string;
  lastUsedAt?: string;
  lastError?: string;
  requestCount: number;
  /** 连续失败次数（成功或人工启用即归零），达到自动禁用阈值才会被禁用。 */
  failureCount: number;
  /** 该 key 的通道：跟随全局 / 强制 SDK / 强制 Sand。 */
  clientType: CursorClientTypeSetting;
  /** 该 key 允许 / 禁止服务的模型；空表示不限制。黑名单优先于白名单。 */
  modelScope: ModelScope;
  /** round-robin 的加权份额，越大越常被选中。fill-first 策略下不生效。 */
  weight: number;
  createdAt: string;
}

export interface CursorKeyPatch {
  status?: CursorKeyStatus;
  label?: string;
  sortOrder?: number;
  disabledReason?: string | null;
  disabledAt?: string | null;
  lastUsedAt?: string;
  lastError?: string | null;
  failureCount?: number;
  incrementRequestCount?: boolean;
  incrementFailureCount?: boolean;
  clientType?: CursorClientTypeSetting;
  modelScope?: ModelScope;
  weight?: number;
}

/** 对外提供给客户端的网关 API 密钥（不是 Cursor key）。 */
export interface GatewayKeyRecord {
  id: string;
  apiKey: string;
  label: string;
  status: CursorKeyStatus;
  /** env = 由 GATEWAY_API_KEY 播种，manual = 后台添加。 */
  source: "env" | "manual";
  /**
   * 该密钥允许使用的 Cursor key id；空数组表示不限制（可用整个池）。
   * 绑定的 key 被删除时会自动从这里剔除；剔完为空则写入 `NO_KEY_SENTINEL` 表示「什么都不许用」——
   * 留成空数组会让权限从「只能用那一把」反向放大成整池可用。
   * 运维在后台显式清空仍然是「不限制」，那是有意为之。
   */
  allowedCursorKeyIds: string[];
  /** 该密钥的模型可见范围，与 Cursor key 自身的范围叠加生效。 */
  modelScope: ModelScope;
  requestCount: number;
  lastUsedAt?: string;
  createdAt: string;
}

export interface GatewayKeyPatch {
  status?: CursorKeyStatus;
  label?: string;
  allowedCursorKeyIds?: string[];
  modelScope?: ModelScope;
  lastUsedAt?: string;
  incrementRequestCount?: boolean;
}

/**
 * 请求日志里那三列参数的取值来源。列出来的字段是从「真正下发的 model.params」反解出的**实际生效值**，
 * 没列出来的只是客户端的请求意图——上游可能压根不支持、也可能被互斥组合改掉了。
 */
export type EffectiveParamField = "reasoningEffort" | "maxMode" | "fast";

export interface RequestLogRecord {
  id: string;
  ts: string;
  endpoint: string;
  model?: string;
  authMode: "gateway" | "direct" | "admin";
  keyId?: string;
  keyLabel?: string;
  status: number;
  durationMs: number;
  stream: boolean;
  error?: string;
  /** 命中的网关 API 密钥（多密钥模式下用于分账）。 */
  gatewayKeyId?: string;
  gatewayKeyLabel?: string;
  /** 本次请求的思考/推理强度，取值来源见 effectiveParams。 */
  reasoningEffort?: string;
  /** 是否开启了 Max Mode / 1M 大上下文，取值来源见 effectiveParams。 */
  maxMode?: boolean;
  /** 是否使用了 fast 变体，取值来源见 effectiveParams。 */
  fast?: boolean;
  /** 上面三列里哪些是实际生效值；其余是请求意图（未能确认上游最终收到什么）。 */
  effectiveParams?: EffectiveParamField[];
  /** 实际使用的通道（sdk / sand）。 */
  clientType?: CursorClientType;
  /** 本次请求走哪条推理路线（sdk / connect）。M3/M2 落库。 */
  provider?: GatewayProvider;
  agentMode?: AgentMode;
  /** 实际下发给 Cursor 的 model.params，JSON 序列化后存库。 */
  modelParams?: ModelParameterValue[];
  usage?: RequestUsage;
  /** usage 的来源：sdk = 上游真实上报，estimated = 按字符数估算。 */
  usageSource?: "sdk" | "estimated";
  cost?: RequestCost;
}

/** 请求日志的分页 + 过滤查询。 */
export interface RequestLogQuery {
  limit: number;
  offset?: number;
  /** 只看某个 Cursor key。 */
  keyId?: string;
  /** 只看某个网关密钥。 */
  gatewayKeyId?: string;
  /** 只看某个模型。 */
  model?: string;
  /** "success" 只看 <400，"error" 只看 >=400。 */
  outcome?: "success" | "error";
  /** ISO 时间下界（含）。 */
  since?: string;
}

export interface RequestLogPage {
  logs: RequestLogRecord[];
  /** 满足过滤条件的总条数，用于前端分页。 */
  total: number;
}

export interface RequestTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RequestLogStats {
  total: number;
  success: number;
  errors: number;
  avgDurationMs: number | null;
  last24h: { total: number; errors: number };
  /** 上游实测用量累计；估算行单列在 estimatedTokens，不与实测混合。 */
  tokens: RequestTokenTotals;
  /** 按字符估算的用量累计，供后台明确标注其不确定性。 */
  estimatedTokens: RequestTokenTotals;
  cost: { rawCostCents: number; chargedCents: number };
}

/** 会话粘性绑定：把一个会话固定到某个 Cursor key，保住上游的 prompt 缓存。 */
export interface SessionBinding {
  sessionHash: string;
  keyId: string;
  updatedAt: string;
}

export interface StateStore {
  getSession(id: string): Promise<string | undefined>;
  saveSession(id: string, agentId: string): Promise<void>;
  deleteSession(id: string): Promise<boolean>;
  saveResponse(record: StoredResponse): Promise<void>;
  getResponse(id: string, ownerHash: string): Promise<StoredResponse | undefined>;
  deleteResponse(id: string, ownerHash: string): Promise<boolean>;

  /** 返回顺序即取用优先级（sort_order 升序，后台可调整）。 */
  listCursorKeys(): Promise<CursorKeyRecord[]>;
  getCursorKeyByValue(apiKey: string): Promise<CursorKeyRecord | undefined>;
  insertCursorKey(record: CursorKeyRecord): Promise<void>;
  updateCursorKey(id: string, patch: CursorKeyPatch): Promise<boolean>;
  deleteCursorKey(id: string): Promise<boolean>;
  /** 按给定 id 序列重排取用优先级；未包含的 key 保持相对顺序排在末尾。 */
  reorderCursorKeys(ids: string[]): Promise<void>;

  listGatewayKeys(): Promise<GatewayKeyRecord[]>;
  getGatewayKeyByValue(apiKey: string): Promise<GatewayKeyRecord | undefined>;
  insertGatewayKey(record: GatewayKeyRecord): Promise<void>;
  updateGatewayKey(id: string, patch: GatewayKeyPatch): Promise<boolean>;
  deleteGatewayKey(id: string): Promise<boolean>;

  /** 读取未过期的会话绑定；过期的视为不存在。 */
  getSessionBinding(sessionHash: string, ttlMs: number): Promise<SessionBinding | undefined>;
  saveSessionBinding(sessionHash: string, keyId: string): Promise<void>;
  deleteSessionBinding(sessionHash: string): Promise<boolean>;
  /** 清掉超过 ttl 的绑定，避免表无界增长。 */
  pruneSessionBindings(ttlMs: number): Promise<number>;

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  insertRequestLog(record: RequestLogRecord): Promise<void>;
  /** 上游用量/计费是 run 结束后才可查的，按 id 事后补写。 */
  updateRequestLogUsage(id: string, usage?: RequestUsage, cost?: RequestCost, usageSource?: "sdk" | "estimated"): Promise<boolean>;
  listRequestLogs(query: RequestLogQuery): Promise<RequestLogPage>;
  requestLogStats(): Promise<RequestLogStats>;
  /** 清空请求日志（后台手动操作）。 */
  clearRequestLogs(): Promise<number>;

  /**
   * 把某个 agent 的上游**累计**金额换算成本次应记的增量，并把基线推进到已记账的位置。
   * 开着 session resume 时一个 agent 会服务多个请求，累计值直接入账等于把前几次的钱再记一遍。
   * 基线必须落库：`sdk_sessions` 与 SDK 自带的 agent store 都跨重启存活，重启后同一个 agentId 会继续服务请求。
   */
  bookAgentUsageDelta(agentId: string, cumulative: RequestCost): Promise<RequestCost>;
  /**
   * 把累计金额的基线推进与对应请求日志的金额写入放进同一个原子操作。
   * 若本次累计值只是旧副本、没有新增金额，则不向该行写入 0，交给调用方继续轮询。
   */
  bookAgentUsageDeltaForRequest(logId: string, agentId: string, cumulative: RequestCost): Promise<RequestCost | undefined>;
}
