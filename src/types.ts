export type ProtocolKind = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface GatewayConfig {
  host: string;
  port: number;
  cursorApiKeys: string[];
  gatewayApiKey?: string;
  adminPassword?: string;
  allowDirectCursorKeys: boolean;
  sqlitePath: string;
  cursorWorkingDirectory: string;
  requestTimeoutMs: number;
  sdkClientVersion: string;
  /** 默认禁用 SDK agent resume，避免长期复用同一远端 agent 导致跨请求状态污染/老会话卡死。 */
  cursorSdkDisableSessionResume: boolean;
  /**
   * 是否允许 Cursor agent 在网关容器内使用自己的内置工具（shell/edit/grep 等）。
   * 默认 false：无客户端工具时纯文本模式，有客户端工具时只保留 MCP 元工具通道（customTools 经此暴露），
   * 防止 agent 在网关侧真实执行文件/命令操作后又把调用转发给客户端造成双重执行。
   */
  cursorAllowBuiltinTools: boolean;
  /** 强制 Cursor local agent 使用 HTTP/1.1 + SSE（env: CURSOR_SDK_USE_HTTP1_FOR_AGENT）。 */
  cursorSdkUseHttp1ForAgent: boolean;
  /** 单次请求轮换 key 的最大尝试数（env: MAX_KEY_ATTEMPTS）。 */
  maxKeyAttempts: number;
  /** 单次请求 transient 软失败的最大重试数（env: MAX_TRANSIENT_KEY_ATTEMPTS）。 */
  maxTransientAttempts: number;
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
}

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

export interface KeyUsageRef {
  keyId?: string;
  keyLabel?: string;
}

export interface CursorRunRequest {
  protocol: ProtocolKind;
  /** direct 模式为客户端 key；useKeyPool 时由 KeyRotatingRunner 注入。 */
  apiKey: string;
  useKeyPool: boolean;
  keyUsageRef?: KeyUsageRef;
  model: string;
  prompt: string;
  sessionKey: string;
  /** 客户端是否以流式消费本请求（影响 key 轮换重试策略：流式下已发出的 thinking 视为已交付）。 */
  stream?: boolean;
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
}

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

export interface CursorRunner {
  run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult>;
  stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent>;
}

export interface StoredResponse {
  id: string;
  ownerHash: string;
  response: Record<string, unknown>;
  inputItems: unknown[];
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
  incrementRequestCount?: boolean;
}

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
}

export interface RequestLogStats {
  total: number;
  success: number;
  errors: number;
  avgDurationMs: number | null;
  last24h: { total: number; errors: number };
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

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  insertRequestLog(record: RequestLogRecord): Promise<void>;
  listRequestLogs(limit: number): Promise<RequestLogRecord[]>;
  requestLogStats(): Promise<RequestLogStats>;
}
