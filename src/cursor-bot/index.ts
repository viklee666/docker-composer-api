/**
 * Cursor Bot provider（`aiserver.v1.InferenceService/Stream`，上游客户端是 Grok Bot）。
 *
 * 与 SDK 路线（`cursor-runner.ts` + `@cursor/sdk`）完全并列、互不引用：
 * 这里自己做 Connect envelope、鉴权头与 protobuf 编解码（协议名是事实，不改），不用 SDK 的 Agent 生命周期，
 * 也不用 `sand-client.ts` 的 ESM loader hook。
 *
 * 协议字段的唯一来源是 `docs/reference/inference-descriptor-8844.txt`
 * （Cursor 3.18.9 `657.js` 模块 8844 的 descriptor 原文），
 * `proto/inference_pb.ts` 由 `scripts/gen-inference-pb.mjs` 机械生成，不手写、不外查。
 */
export {
  DEFAULT_COMPRESS_MIN_BYTES,
  DEFAULT_READ_MAX_BYTES,
  ENVELOPE_HEADER_BYTES,
  EnvelopeSplitter,
  EnvelopeTooLargeError,
  FLAG_COMPRESSED,
  FLAG_END_STREAM,
  TruncatedEnvelopeError,
  encodeEnvelope,
  encodeRequestEnvelope,
  parseCompression,
  readEnvelopes,
  type ConnectCompression,
  type ConnectFrame
} from "./envelope.js";

export {
  connectCodeToStatus,
  endStreamError,
  envelopeError,
  httpTransportError,
  inferenceStreamError,
  isConnectCode,
  parseEndStream,
  type ConnectCode,
  type EndStreamResponse
} from "./errors.js";

export { cursorChecksum } from "./checksum.js";

export {
  SAND_CLIENT_TYPE,
  SAND_DEFAULT_MODEL_ID,
  assertUsableCredential,
  credentialClientType,
  cursorTokenType,
  type CursorBotCredential,
  type CursorTokenType
} from "./credentials.js";

export {
  CONNECT_PROTOCOL_VERSION,
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_PROTO,
  buildConnectHeaders,
  redactHeaders,
  type ConnectCodec
} from "./headers.js";

export { postConnectStream, type ConnectFetch, type ConnectStreamResult } from "./transport.js";

export {
  EXCHANGE_USER_API_KEY_PATH,
  exchangeUrl,
  exchangeUserApiKey,
  type ExchangedCursorTokens
} from "./api-key-exchange.js";

export {
  CursorBotClient,
  DEFAULT_BOT_BASE_URL,
  INFERENCE_SERVICE,
  STREAM_METHOD,
  methodUrl,
  type CursorBotClientOptions
} from "./client.js";

export {
  buildInferenceStreamRequest,
  buildRequestedModel,
  toStruct,
  toValue,
  type BotConversation as BotRequestConversation,
  type BotMessage,
  type BotModelConfig,
  type BotReasoningPart,
  type BotRequestedModel,
  type BotRole,
  type BotToolResult
} from "./request-builder.js";

export { ResponseNormalizer, type BotRunState } from "./response-normalizer.js";

export {
  ToolMarkerFilter,
  markerEventsFromText,
  markerFlushEvents,
  parseToolCallJson,
  parseToolMarkers
} from "./tool-markers.js";

export {
  DEFAULT_CATALOG_FAILURE_TTL_MS,
  DEFAULT_CATALOG_MAX_ENTRIES,
  DEFAULT_CATALOG_TTL_MS,
  ModelCatalogCache,
  resolveRequestedModel,
  type ModelCatalogPort,
  type ResolvedRequestedModel
} from "./catalog.js";

export {
  CursorBotProvider,
  conversationIdFor,
  type CursorBotProviderOptions
} from "./provider.js";

export {
  conversationMessages,
  toPreparedConversation,
  type ConversationOptions,
  type InboundProtocol,
  type PreparedConversation
} from "./conversation.js";

export {
  GATEWAY_EVENT_TYPES,
  UNIFIED_EVENT_VERSION,
  UPSTREAM_EVENT_TYPES,
  draftEventsFromFrame,
  isGatewayGenerated,
  usageFromEvent,
  type DraftEvent,
  type UnifiedEvent,
  type UnifiedEventType
} from "./events.js";

export {
  CursorBotStore,
  isTerminal,
  type BotConversation,
  type BotRun,
  type BotSummary,
  type BotTask,
  type BotToolCall,
  type DeliveryState,
  type RunStatus,
  type TaskStatus,
  type ToolCallStatus
} from "./store.js";

export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  runToolLoop,
  type ToolExecution,
  type ToolExecutor,
  type ToolLoopDeps,
  type ToolLoopOptions,
  type ToolLoopResult
} from "./tool-loop.js";

export {
  DEFAULT_LOCAL_TOOL_MAX_OUTPUT,
  DEFAULT_LOCAL_TOOL_TIMEOUT_MS,
  LocalToolRegistry,
  resolveWithinWorkspace,
  type LocalToolDefinition,
  type LocalToolRegistryOptions
} from "./local-tools.js";

export {
  DEFAULT_SUBAGENT_LIMITS,
  SUBAGENT_TOOL_NAME,
  SubagentScheduler,
  subagentTool,
  type SubagentLimits,
  type SubagentRunContext,
  type SubagentRunner
} from "./subagent-scheduler.js";

export {
  DEFAULT_SUMMARY_PROMPT,
  contextFromSummary,
  hashMessages,
  shouldSummarize,
  summarizeConversation,
  type SummarizeOptions,
  type SummarizeResult,
  type SummaryTriggerInput
} from "./summarizer.js";

export {
  BackgroundWorker,
  DEFAULT_LEASE_MS,
  ReplayBridge,
  nextDeliveryState,
  replayableAfterRerun,
  resumeDecision,
  type RunExecutor
} from "./background-worker.js";

export {
  BOT_MODEL_PREFIX,
  PROVIDER_HEADER,
  ProviderRouter,
  botModelScope,
  isBotModelId,
  selectProvider,
  type ProviderId,
  type ProviderSelection
} from "./router.js";

export * from "./proto/inference_pb.js";
