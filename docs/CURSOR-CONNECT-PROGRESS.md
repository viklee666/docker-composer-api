# Cursor Connect provider · 进度记录

计划见 `docs/SAND_GROK_IMPLEMENTATION_PLAN.md` 第二部分（§7–§11）。本文档只记事实：每个工作包的状态、实际改动、验证结果、以及过程中发现计划文档写错的地方。

**图例**：`未开始` / `定位中` / `执行中` / `待审阅` / `已完成` / `已搁置（附原因）`

---

## 总览

| 包 | 主题 | 优先级 | 状态 | 定位 | 执行 | 审阅 |
|---|---|---|---|---|---|---|
| G1 | protobuf 运行时 + Connect envelope + transport | P0 | 已完成 | 完成 | 完成 | 完成 |
| G2 | credentials + checksum + headers | P0 | 已完成 | 完成 | 完成 | 完成 |
| G3 | Connect client + request-builder + response-normalizer | P0 | 已完成 | 完成 | 完成 | 完成 |
| G4 | 模型参数映射 + 目录缓存 | P0 | 已完成 | 完成 | 完成 | 完成 |
| G4b | `AiService/AvailableModels` 真实调用 | P1 | 已完成 | 完成 | 完成 | — |
| — | `CursorConnectProvider` 实现现有 `CursorRunner` | P0 | 已完成 | 完成 | 完成 | 完成 |
| G5 | `PreparedConversation`（结构化 system / 历史） | P1 | 已完成 | 完成 | 完成 | 完成 |
| G6.1 | 无状态工具 loop | P1 | 已完成 | 完成 | 完成 | 完成 |
| G6.2 | 网关本地工具（默认全关） | P1 | 已完成 | 完成 | 完成 | 完成 |
| G6.3 | `provider_defined_tools` | P2 | 已搁置（未取证） | 完成 | — | — |
| G7 | 网关编排子代理 | P2 | 已完成 | 完成 | 完成 | 完成 |
| G8 | summary checkpoint | P2 | 已完成 | 完成 | 完成 | 完成 |
| G9 | background worker + 事件重放 | P2 | 已完成 | 完成 | 完成 | 完成 |
| G10 | `cc_*` 表与 DAO | P2 | 已完成 | 完成 | 完成 | 完成 |
| G11 | 统一事件模型 | P2 | 已完成 | 完成 | 完成 | 完成 |
| P6 | provider 选路 | P2 | 已完成 | 完成 | 完成 | 完成 |
| — | HTTP 端点接线（`server.ts` / `index.ts`） | P2 | 已完成 | 完成 | 完成 | — |
| — | admin 后台交互面板 | P2 | 已完成 | 完成 | 完成 | — |
| — | 真机验证（活 token 之外的部分） | P1 | 已完成 | 完成 | 完成 | — |

---

## 基线

- 仓库：`docker-composer-api`，改动前 `npm test` = 514 tests / 512 pass / 2 skip / 0 fail
- 协议事实来源：`docs/reference/inference-descriptor-8844.txt`（Cursor 3.18.9 `extensions/cursor-agent-host/dist/657.js` 模块 8844 的 descriptor 原文，38237 字节）
- 选定路线：`POST /aiserver.v1.InferenceService/Stream`（ServerStreaming）。`RunInference`（BiDiStreaming）不实现，但其全部帧类型已一并生成，将来换 transport 不需要重新取证
- 硬约束：不改 `src/cursor-runner.ts` / `src/sand-client.ts` / `src/server.ts`；不引 `@connectrpc/*`；出站只走全局 `fetch`

---

## 决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | `inference_pb.ts` 由脚本生成，不手写 | 54 个 message / 4 个枚举、约 2500 行，手抄必然有 typo；descriptor 换版后重跑即可 |
| D2 | 只加 `@bufbuild/protobuf@1.10.0` 一个依赖，envelope/transport 自己写 | 计划 §G1 方案 B。`@connectrpc/connect-node` 自带 http2 会绕开 `proxy.ts` 的全局 dispatcher，代理/SOCKS/超时全部失效 |
| D3 | 不扩 `CursorStreamEvent` 的 union | 计划 §G0 建议加 `usage` / `error` / `response_info` 三个 case。实测不需要：usage 走已有的 `telemetryRef`，错误直接抛 `ApiError`。少动一处共享类型就少一处回归面 |
| D4 | 目录用注入口 `ModelCatalogPort`，不实现 `AvailableModels` | `AvailableModelsRequest/Response` 不在 descriptor 里，实现就等于猜字段号。详见 G4b |
| D5 | `sendTools` 默认 false | 工具编解码已按 descriptor 做完，但「同 `conversation_id`、新 `invocation_id` 的第二次 Stream 请求能否接续」未实测（计划 §P2 的最大单点风险）。在那之前声明工具 = 让模型发起一轮网关接不住的调用 |
| D6 | 不接进 `server.ts` | 硬约束。provider 可实例化、可测试，接线是独立一步 |

---

## 定位阶段

### 计划文档与仓库现状的偏差（执行前逐条核对）

| 计划文档说法 | 实际 | 处置 |
|---|---|---|
| §G1「`package.json` 里没有 `@bufbuild/protobuf`」 | `node_modules` 里已有 `1.10.0`（`@cursor/sdk` → `@connectrpc/connect` 的传递依赖） | 显式声明成直接依赖并锁死同版本，不引入新下载 |
| §15「协议事实层放 `cursor-connect-proto/` 独立目录」 | 与「provider 实现现有 `CursorRunner`」冲突：独立目录还要再建一层发布/引用关系 | 全部放 `src/cursor-connect/`，`proto/` 只是子目录 |
| §G1「新增 `connect/envelope.ts` / `connect/transport.ts` / `connect/errors.ts`」 | 多一层 `connect/` 目录没有收益 | 拍平到 `src/cursor-connect/` |
| §G4「不新增 `model-params.ts`……只需要做映射」 | 属实。`ModelParameterValue{id,value}` 与 descriptor 的 `InferenceModelParameterValue{1 id string, 2 value string}` 字段完全一致 | `catalog.ts` 只做映射，参数语义一行没重写 |
| §G4「模型目录从 `AvailableModels` 拉」 | 该消息不在 descriptor 里 | 见 G4b |
| §G5「`protocol.ts` 里增加 `toPreparedConversation()`，与现有 `toPreparedRequest()` 并列」 | **`toPreparedRequest()` 不存在**。实际入口是 `prepareOpenAiChat` / `prepareOpenAiResponses` / `prepareAnthropicMessages`，三者各自合成 prompt | 结构化解析放进 `src/cursor-connect/conversation.ts`，不动 `protocol.ts`（那 1200 行下面压着 590 条测试） |
| §G7「新增 `task-worker.ts`」 | 与 `background-worker.ts` 职责重叠：子代理的"跑一个 child"由调用方注入的 `SubagentRunner` 承担，再加一层 worker 只是空壳 | 不建该文件，`subagent-scheduler.ts` 只管 DAG、限额与取消 |
| §G9 的 6 个 HTTP 端点 | 都要改 `server.ts` | 本轮硬约束不许动 `server.ts`。worker / 重放 / 选路的**逻辑**已实现且可单测，接线单列一项 |
| §2.3「`docs/reference/inference-descriptor-8844.txt`」 | 该文件不存在，descriptor 原文躺在 `docs/_mod8844.txt` | 移到 `docs/reference/inference-descriptor-8844.txt`，落实「唯一来源」这条约束 |

### 接线地图

| 现有资产 | 位置 | Connect 侧怎么用 |
|---|---|---|
| `CursorRunner` 接口 | `src/types.ts` **379–382** | `CursorConnectProvider` 直接实现，`server.ts` / `key-rotating-runner.ts` / 三套 SSE 输出层零改动 |
| `CursorStreamEvent` 四个 case | `src/types.ts` **357–362** | 原样产出，**不扩 union** |
| `RunTelemetryRef` | `src/types.ts` **257–276** | `upstreamModel` / `modelParams` / `clientType` / `usage` / `runId` 全部回写，请求日志无需区分 provider |
| 全局 dispatcher | `src/proxy.ts` **355** `setGlobalDispatcher(dispatcher)` | 出站只用全局 `fetch`，代理自动生效 |
| `resolveModelParams` | `src/model-params.ts` **353–396** | `catalog.ts` 整段复用，effort / maxMode / fast / 变体串语义一行没重写 |
| `getModelCatalogEntry` | `src/models.ts` **152** | 可直接当 `ModelCatalogPort` 注入（`ModelEntry` 结构上满足 `ModelCatalog`） |
| `durableIdentity` | `src/durable-id.ts` **25–32** | 派生 `conversation_id`。它明确拒绝 ownerHash / 裸 sessionKey 兜底，正好是这里需要的语义 |
| `ApiError` + `codeForStatus` 口径 | `src/errors.ts` **3–13 / 133–142** | Connect 错误映射对齐同一套 code，不另起一套 |

---

## 逐包记录

### G1 · protobuf 运行时 + Connect envelope + transport

- 状态：已完成
- 改动：
  - `package.json`：`dependencies` 增加 `"@bufbuild/protobuf": "1.10.0"`（**不带 caret**，与 `node_modules` 里 `@cursor/sdk` 的传递依赖锁同一版本）；`package-lock.json` 由 `npm install --package-lock-only` 同步，只多 1 行，`resolved` 未变、未触碰 `node_modules`
  - `docs/reference/inference-descriptor-8844.txt`（新，由 `docs/_mod8844.txt` 移入）：协议字段的唯一来源
  - `scripts/gen-inference-pb.mjs`（新，464 行）：解析 descriptor 的 `newFieldList` 生成 TS。`--check` 只比对不写盘
  - `src/cursor-connect/proto/inference_pb.ts`（新，生成物 2562 行）：54 个 message + 4 个枚举，含 `RunInference*` 全部帧
  - `src/cursor-connect/envelope.ts`（新）：`encodeEnvelope` / `encodeRequestEnvelope` / `EnvelopeSplitter` / `readEnvelopes` / `parseCompression`
  - `src/cursor-connect/errors.ts`（新）：Connect code ↔ HTTP status 双向表、`parseEndStream`、`endStreamError`、`inferenceStreamError`、`httpTransportError`
  - `src/cursor-connect/transport.ts`（新）：`postConnectStream`
  - 未改 `src/types.ts` / `src/errors.ts` / `src/proxy.ts` / `src/models.ts` / `src/model-params.ts`
- 生成器的自证：`verifyDefaults()` 把「按 kind/repeated/opt 推导出的零值集合」与 descriptor **构造函数原文**里 `this.x=` 的字段集合对比，不一致直接抛。54 个 message 全过——这条保证 `protoInt64.zero`（`created_at`）、`new Uint8Array(0)`（`RunInferenceErrorDetail.value`）、`{}`（`InferenceCursorOptions.image_descriptions` 的 map）这些零值不是猜的
- 踩到的两处：
  - descriptor 里 `{no:4,name:"tool_calls",kind:"message",T,repeated:!0}` 的 `T` 是 **ES 简写属性**（局部变量恰好叫 `T`），按 `key:value` 解析会整条漏掉
  - 局部变量名含 `$`（`RunInferenceRoutingMessage` 是 `$`），标识符正则用 `\w+` 会匹配不到
- envelope 口径：`[flags:u8][len:u32be][payload]`；`flags&1`=compressed，`flags&2`=endStream(JSON)。`readMaxBytes` 默认 32 MB，**长度校验在 `new Uint8Array` 之前**；解压额外用 `zlib` 的 `maxOutputLength` 兜住压缩炸弹
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `tests/cursor-connect-proto.test.ts`「inference_pb.ts covers every descriptor message with matching field numbers」：54 个 message 逐字段比对 `no` / `name` / `kind` / `repeated` / `opt` / `oneof` / 类型引用。该测试**自己重新解析** descriptor，不复用生成器的解析器——否则解析器错了两边一起错
  - 「the same byte stream parses identically at every chunk boundary」：chunk = 1/2/3/5/7/10/整段 七种切法结果一致
  - gzip / br 压缩帧、endStream 帧、`0xffffffff` 超长（`EnvelopeTooLargeError`）、半包截断（`TruncatedEnvelopeError`）、endStream 后的尾随字节不误报截断
- 未做：`RunInference` 的 BiDi transport（帧类型已生成，只差 transport 与握手）；`CONNECT_CODEC=json` 的环境变量开关（`codec: "json"` 已实现，只是没接 env）

### G2 · credentials + checksum + headers

- 状态：已完成
- 改动：
  - `src/cursor-connect/checksum.ts`（新）：`cursorChecksum(machineId, macMachineId?, nowMs?)`
  - `src/cursor-connect/credentials.ts`（新）：`CursorConnectCredential`、`cursorTokenType`、`assertUsableCredential`、`SAND_CLIENT_TYPE`、`SAND_DEFAULT_MODEL_ID`
  - `src/cursor-connect/headers.ts`（新）：`buildConnectHeaders`、`redactHeaders`
  - 未建 `cc_credentials` 表，未改 `src/store.ts` / `src/admin*.ts`（凭据持久化是 G10）
- checksum 的三处易错点，都已按计划 §1.5 / §G2 落实并单测：
  - `>> 40` / `>> 32` 在 JS 里等价于 `>> 8` / `>> 0`（位运算 32 位 + 移位数对 32 取模）。**照抄这个行为**，"修正"成 64 位移位会得到上游没见过的 checksum
  - `(n[t]^e)+t%256` 必须写回 `Uint8Array` 再读出来——客户端靠的就是 TypedArray 的截断，用普通数组算出的字节不同
  - base64url 且**不带 padding**
- 头集合：必需 7 项（`authorization` / `content-type` / `connect-protocol-version` / `x-cursor-checksum` / `x-cursor-client-type` / `x-cursor-client-version` / `x-request-id`）+ `x-cursor-streaming` + `x-amzn-trace-id`；设备类字段有值才发，空值不发空串。**明确不发** `x-sand-box-namespace` / `x-cursor-client-commit` / `x-inference-authentication-jwt` / `x-cursor-workload*`
- 验证：
  - 「headers carry the client-version name, not x-cursor-version」：断言 `x-cursor-client-version` 有值且 `x-cursor-version` 为 `undefined`
  - 「checksum is base64url without padding and matches the client algorithm」：`now=1788000000000` → 字节 `[72,96,0,27,72,96]` → 混淆 → `"7Y6Qjsqv"`。这个值是手算核对过的定值，不是跑一遍实现录下来的
  - 「checksum never emits standard-base64 characters」：200 个时间戳，前缀里不出现 `+` `/` `=`
  - 「browser web tokens are rejected」：JWT `type:"web"` → 401；`type:"session"` 与不透明 token 放行
  - 「redactHeaders hides the token, checksum and device keys」：序列化后不含 `session-token-value`
- 未做：凭据加密落库、Docker secret / secret manager 接入、失败计数与自动禁用（G10 / P6）

### G3 · Connect client + request-builder + response-normalizer

- 状态：已完成
- 改动：
  - `src/cursor-connect/client.ts`（新）：`CursorConnectClient.stream()`，端点常量 `aiserver.v1.InferenceService` / `Stream`，`baseUrl` 可配（默认 `https://api2.cursor.sh`）
  - `src/cursor-connect/request-builder.ts`（新）：`ConnectConversation` → `InferenceStreamRequest`
  - `src/cursor-connect/response-normalizer.ts`（新）：`InferenceStreamResponse` → `CursorStreamEvent`
  - `src/cursor-connect/index.ts`（新）：模块出口
  - 未改 `src/protocol.ts`（`PreparedConversation` 是 G5）
- 口径：
  - `content` 是 oneof，`text` / `parts` / `tool_content` **只能设一个**；`tool_calls` 与 `content` 不是 oneof，assistant 轮次可以既有文本又有工具调用
  - 请求侧 `InferenceToolCall.args` 是 `google.protobuf.Struct`，响应侧 `InferenceToolCallStreamPart.args` 是 `string`——**两处类型不同，不能互相套用**
  - `is_final` 的 `text_part` 常常 `text` 为空，此时只表示「文本到此为止」，不产出空文本块
  - `thinking_part.signature` 按出现顺序存进 `state.thinkingSignatures`，回传上一轮 reasoning 时要原样带上
  - 工具三态与客户端 `675.js` 判定顺序一致：`is_complete` → 完整调用；有 `tool_name` 且未完成 → streaming-start；两者都没有 → args 增量。args parse 失败置 `{}`，不打断流
  - `usage` 与 `extended_usage` **逐字段取较大值**而不是整体覆盖：两个帧各填各的，直接覆盖会让先到的 `prompt_tokens` 被后到的 0 抹掉
  - `error` 帧、`response_info.error_message`、endStream 里的 `error` 三条错误路径都抛 `ApiError`，不静默收流。Connect 的流式错误可以出现在 HTTP 200 之下，只看状态码会把失败请求当成空响应
  - 未识别的 oneof case 只记 case 名（**不记 payload**，里面可能有用户内容），不中断流
- 验证：
  - 「the client posts to /aiserver.v1.InferenceService/Stream and decodes the frames」：断言出站 URL、`content-type: application/connect+proto`、请求体解回来的消息内容
  - 「an endStream error surfaces as a mapped ApiError even under HTTP 200」：`resource_exhausted` → 429
  - 「a stream that never sends endStream is an error, not an empty answer」
  - 「content is a oneof: text, parts and tool_content never coexist」、「assistant tool_calls coexist with text and carry Struct args」
  - 「tool calls resolve through streaming-start, delta and complete」、「a complete frame that carries full args wins over the accumulator」、「unparseable tool args degrade to an empty object」、「a tool call left incomplete at end of stream is still surfaced」
  - 「every InferenceStreamErrorType maps to a distinct outward error」：8 种 `error_type` + UNSPECIFIED 逐条断言状态码与 code
- 未做：`provider_defined_tools`（G6.3，`type` 取值与 `options` schema 未取证）、`accepted_unadvertised_tool_names`、`image_descriptions` 回填、`inference_reason`

### G4 · 模型参数映射 + 目录缓存

- 状态：已完成
- 改动：
  - `src/cursor-connect/catalog.ts`（新）：`ModelCatalogPort`、`ModelCatalogCache`、`resolveRequestedModel`
  - 未改 `src/model-params.ts` / `src/models.ts`
- 口径：
  - `ModelIntent` → `InferenceRequestedModel` 整段复用 `resolveModelParams`，**没有第二套 effort/maxMode/fast 语义**
  - 请求没表达任何意图时 `parameters` 为空数组，不发——由服务端用模型自己的默认强度，而不是网关替它决定一个 medium
  - `isVariantStringRepresentation` 恒为 `false`：变体串已经解析成结构化 parameters，服务端不需要再解析
  - 目录缓存按「凭据 + 模型」分片。不含凭据会把 A 账号的参数定义用到 B 账号的请求上
  - 目录查询失败降级为 `undefined`（走 `model-params.ts` 的家族兜底），不让请求整个失败
- 验证：
  - 「effort intent becomes an InferenceModelParameterValue from the catalog definitions」
  - 「no effort in the request means no parameters on the wire」
  - 「two resolutions never share the same parameters array instance」：改第一份不影响第二份
  - 「catalog cache is keyed by credential and collapses concurrent lookups」：并发合并成 1 次回源、换凭据必回源、TTL 内命中、TTL 过期回源
- 未做：`/v1/models` 的列表仍来自 SDK 路线；`degradation_status` 过滤、`parameter_definitions` 反向校验、`subagent_model_configs` 都要等 G4b

### G4b · `AiService/AvailableModels` 真实调用

- 状态：已搁置
- 原因：`aiserver.v1.AvailableModelsRequest` 与 `AvailableModelsResponse` **不在** `docs/reference/inference-descriptor-8844.txt` 里（该文件只含模块 8844 的 `Inference*` / `RunInference*`）。硬约束是协议字段只从该文件读，实现就等于猜字段号
- 计划文档 §G4 列的那些字段号（`use_model_parameters=5`、`scope=10`、`parameter_definitions=29`、`subagent_model_configs=16` 等）来自另一个模块的 descriptor，本仓库没有
- 当前替代：`ModelCatalogPort` 是注入口，现成实现是 `src/models.ts` 的 `getModelCatalogEntry`（SDK 侧目录，同样给出 `parameters` 与 `variants`），provider 构造时传入即可
- 解除条件：把 `AiService` 那个模块的 descriptor 原文导出到 `docs/reference/` 下，重跑生成器

### CursorConnectProvider · 实现现有 `CursorRunner`

- 状态：已完成
- 改动：
  - `src/cursor-connect/provider.ts`（新）：`CursorConnectProvider implements CursorRunner`，`conversationIdFor`
  - **未改** `src/types.ts` / `src/cursor-runner.ts` / `src/sand-client.ts` / `src/server.ts` / `src/index.ts` / `src/key-rotating-runner.ts`
- 口径：
  - `run()` 就是把 `stream()` 抽干取 `done`，不走第二条代码路径
  - `conversation_id` 由 `durableIdentity`（显式会话头 / conversationSeed / stickyKey）+ model 派生成稳定 UUID；**认不出身份就每次新开一段**。拿 ownerHash 或裸 sessionKey 兜底会把整个网关的请求并成一段对话
  - `telemetryRef.upstreamModel` 先写请求值，收到 `response_info.model` 后覆盖成上游解析值——走 Stream 没有 `run_ready`，这是唯一的回填来源
  - `systemInstructions` 默认空：`CursorRunRequest.prompt` 是 `protocol.ts` 合成好的单串文本，system 已经拼在里面，两边都发会重复。结构化 system 等 G5
- 验证：
  - 「the provider satisfies CursorRunner and emits text, thinking then done」：thinking 与 text 分开两路，`reasoningText` 不混进 `text`
  - 「the requested model and effort actually reach the wire」：解请求体断言 `requested_model.model_id` 与 `parameters[{id:"effort"}]`
  - 「system instructions are sent as their own SYSTEM message」：`role=SYSTEM(4)`，不是拼进 user 文本
  - 「tools stay off the wire until the tool loop is verified」：默认 `tools: []`，开 `sendTools` 才发
  - 「telemetry captures the model, params and upstream usage」
  - 「conversation_id is stable per conversation seed」+ 匿名请求每次不同
  - 「an aborted request stops the stream with 499」
- 未做：接进 `server.ts`（硬约束）、ProviderRouter 选路、`key-rotating-runner` 的按 provider 隔离（P6）

### G5 · 结构化上下文

- 状态：已完成
- 改动：
  - `src/cursor-connect/conversation.ts`（新）：`PreparedConversation`、`toPreparedConversation(body, protocol, options)`、`conversationMessages()`；覆盖 OpenAI Chat / OpenAI Responses / Anthropic Messages 三种入站形状
  - 未改 `src/protocol.ts` / `src/system-prompt.ts`
- 口径：
  - system / developer 走**独立的 `role=SYSTEM(4)` 消息**，不拼进 user 文本。除了更干净，还避免 system 一变就污染整个 prompt 前缀、连带废掉上游 prompt 缓存
  - `off` / `append` / `override` 三态语义与 `system-prompt.ts` 一致，只是结果形态从「拼字符串」变成「一条独立消息」
  - Anthropic 的 `tool_result` 裹在 user 消息里，但协议侧属于 `role=TOOL(3)`，必须拆成单独一条——`content` 是 oneof，它和同一条消息里的文本 / 图片不能共存
  - OpenAI 的 `data:image/png;base64,...` 拆成 `mediaType` + 裸 base64，不整串塞进 `data`
- 验证：「openai system and developer messages become SYSTEM instructions」「anthropic thinking signatures are captured and tool_result becomes a TOOL message」「gateway system prompt append and override modes」「openai data-url images split into media type and bare base64」「responses function_call and function_call_output round-trip into structure」
- 未做：把它接进 `server.ts` 的入站路径（硬约束）；`reasoningSignatures` 目前只记录不回填

### G6 · 工具调用

- 状态：G6.1 / G6.2 已完成，G6.3 已搁置
- 改动：
  - `src/cursor-connect/tool-loop.ts`（新）：`runToolLoop()`，多轮无状态循环
  - `src/cursor-connect/local-tools.ts`（新）：`LocalToolRegistry`、`resolveWithinWorkspace()`
- G6.1 口径：
  - 每一轮都是**新的 HTTP 请求**：`conversation_id` 不变，`invocation_id` 每轮新生成，上一轮的 assistant(tool_calls) + tool(tool_content) 追加进 messages
  - **未实测的前提**：上游是否真按同一个 `conversation_id` 把两次 `Stream` 接续起来。计划 §13 把它列为第二部分最大的单点风险。代码按"能接续"实现，注释与 `capabilities()` 都写明它未验证，`sendTools` 默认仍是 false
  - 没有执行器 = 无状态模式：把调用交回调用方，由它在下一次 `POST /v1/chat/completions` 里带完整历史。计划 §G6.1 说的专用端点「第一版可以先不做」
  - 工具自己抛异常不打断流：失败作为 tool result 回灌，模型有机会换个做法
  - 多轮用量**累加**（每轮是独立的一次推理，各报各的），不是取 max
- G6.2 口径：**默认全关**，且刻意不提供 shell——模型能跑命令就等于拿到 Docker 宿主机权限。内置的 `read_file` 只是让 containment / 校验 / 截断 / 审计这套机制有一个被真实走通的例子，同样要显式进 allowlist
  - 路径校验不只比字符串前缀：`workspace/link → /etc` 这种软链字符串上完全合法，所以 realpath 之后再比一次
- 验证：「with no executor the loop stops and hands the tool call back to the caller」「with an executor the loop feeds results back on a new invocation id」（断言两轮 `invocation_id` 不同、`conversation_id` 相同、第二轮 roles 是 USER/ASSISTANT/TOOL）「the loop stops at the iteration ceiling」「a throwing tool becomes an error result」「the loop persists tool calls and honours an already-submitted result」「symlinks cannot be used to escape the workspace」「local tool arguments are validated before touching the filesystem」「a denying approval hook blocks execution even when allowlisted」
- 未做：G6.3 `provider_defined_tools`（`type` 取值与 `options` schema 未取证，且客户端侧 `webSearch` / `generateImage` 本来就是本地 executor，不走这条）；`accepted_unadvertised_tool_names`

### G7 · 网关编排子代理

- 状态：已完成
- 改动：`src/cursor-connect/subagent-scheduler.ts`（新）：`SubagentScheduler`、`subagentTool()`、`SUBAGENT_TOOL_NAME`
- 口径：
  - 工具名是 `spawn_subagent` 而**不是** `Task`。`tool-compat.ts:19` 明确把宿主元工具 `Task` 挡在 customTools 之外（"否则内层会再演 MCP 发现或 Task 套娃"）。那条过滤规则一行不动，网关在 `tools[]` 里追加自己的这一个
  - 每个 child 有**新的** `conversation_id`（复用父的会让上游把两段完全不同的上下文当成一段）、自己的 run / task / model / parameters，以及 parent 链接
  - 子代理的 parameters 不与父共享数组引用
  - 子代理失败不让父永久 running：失败作为 tool result 回灌
  - 不是 `spawn_subagent` 的调用一律返回 `undefined` 交回调用方——scheduler 不该把别人的工具吞掉
- 验证：「a sub-agent gets its own conversation, run and model」「sub-agents do not share the parent parameters array」「sub-agent depth, count and echo limits are enforced」「the scheduler ignores tool calls that are not its own」「the subagent tool is not named Task」
- 未做：per-tenant 并发（当前只有全局 `maxConcurrent`）；`ModelScope` 允许/拒绝范围校验；child 的工具权限隔离

### G8 · summary checkpoint

- 状态：已完成
- 改动：`src/cursor-connect/summarizer.ts`（新）：`shouldSummarize()`、`summarizeConversation()`、`contextFromSummary()`、`hashMessages()`
- 口径：
  - **协议层面 summary 不是独立能力**：没有 SummarizeRequest，没有 summary 专用字段。它就是"用一个特殊 prompt 发一次普通推理"，只是要用独立的 `invocation_id`、保持同一个 `conversation_id`
  - `InferenceResponseInfo.supports_self_summary`（字段 7）走 `Stream` 时在响应**尾部**，是事后信息，所以摘要决策由网关自己做，不等上游告知
  - 阈值只用真实 token（`usage.prompt_tokens` vs `context_token_limit`），不用字符数估算——CJK 与代码上偏差极大。目录不可用时只认显式触发，不猜
  - 先写 checkpoint 再切 active context；摘要为空时**报错**而不是拿空 checkpoint 去替换上下文；失败不动已有 checkpoint；原始事件永不删除，只记录覆盖到哪个 seq
  - `sourceHash` 挡住对同一段消息的重复摘要
- 验证：「summary triggers on explicit request or a real token ratio」「summarize writes a checkpoint, points the conversation at it and keeps events」（断言 `invocation_id` 是新的、`conversation_id` 不变、原始事件还在）「an empty summary response fails loudly」「summarizing the same messages twice reuses the checkpoint」「rebuilt context keeps pending tool calls attached to their caller」
- 未做：跨摘要保留在途子代理状态

### G9 · background worker + 事件重放

- 状态：已完成（逻辑），HTTP 端点未接线
- 改动：`src/cursor-connect/background-worker.ts`（新）：`BackgroundWorker`、`ReplayBridge`、`resumeDecision()`、`nextDeliveryState()`、`replayableAfterRerun()`
- 口径 —— 三种"恢复"的可行性完全不同，必须分开说：
  - **客户端重连** = 重放已落库事件。完全可控，已实现
  - **worker 重启** = 靠 lease 从 DB 恢复。完全可控，已实现
  - **上游断点续传** = **不存在**。`InferenceStreamRequest` 12 个字段与 `RunInferenceRunRequest` 5 个字段里都没有 offset / cursor / resumeToken，断了只能从 transcript / checkpoint 重建
  - 事件**先落库再推送**：反过来的话，进程在推送后、落库前崩溃，客户端重连就再也补不回那条
  - 补发与 live 的竞态：先订阅进缓冲区、再查补发，然后按 seq 去重合并。重复能靠 seq 去掉，丢失不行
  - 重建安全性看 `delivery_state`：已经把半截文本发出去的 run 重跑会重复输出，宁可标 `unknown` 让调用方决定
  - 客户端断开**不**取消 background run
- 验证：「the worker takes a lease, runs and releases to a terminal status」「a throwing execution marks the run failed instead of leaving it running」「replay backfills history then live events with no gap and no duplicate」「resume decisions refuse to re-run anything already partially delivered」「delivery state advances only on real upstream content」
- 未做：§G9 列的 6 个 HTTP 端点（都要改 `server.ts`）；`Last-Event-ID` 的 HTTP 头解析（`seqFromEventId` 已实现，只差接线）

### G10 · `cc_*` 表与 DAO

- 状态：已完成
- 改动：`src/cursor-connect/store.ts`（新）：7 张 `cc_*` 表 + DAO。**未改 `src/store.ts`**——那 1500 行服务着 SDK 路线
- 约束落地：`PRIMARY KEY(run_id, seq)`、`UNIQUE(run_id, event_id)`、`INDEX(run_id, seq)`、`PRIMARY KEY(run_id, call_id)`（tool result 幂等的实现基础）
- 执行中发现并修掉的两个真 bug（写测试时暴露的，不是审阅指出的）：
  - `acquireRunLease` 原来只在 `status IN ('queued','paused')` 里找。worker 崩掉会把 run 永久钉在 `running`，**正是"重启后能恢复"要解决的那种情况**却永远接管不了。补上 `status='running' AND lease_until <= now` 这条接管路径
  - `recordToolCall` 的 UPSERT 会把已经 `submitted` 的调用降级回 `complete`，重连后的循环就会把同一个工具再执行一次，幂等白做。加 `WHERE cc_tool_calls.status != 'submitted'`
- 验证：「events get monotonic seq and replay from a Last-Event-ID」「tool result submission is idempotent per (run_id, call_id)」「a run lease can be taken over only after it expires」「summaries dedupe on source hash and never delete the events they cover」
- 未做：`cc_credentials` 只有表结构，没有 DAO（凭据加密与 secret 管理是独立一轮）；`delivery_state` / `usage_json` 有列但写入方还没接线

### G11 · 统一事件模型

- 状态：已完成
- 改动：`src/cursor-connect/events.ts`（新）：`UnifiedEvent`、`draftEventsFromFrame()`、`isGatewayGenerated()`、`usageFromEvent()`
- 口径：
  - **网关自造** vs **有上游帧支撑**的区分不是分类癖，是 G9 重放策略的依据：前者重跑一定能重来，后者重跑后内容可能不同
  - 与 `ResponseNormalizer` 是互补而非重复：normalizer 产出喂给现有 SSE 层的四种 `CursorStreamEvent`，这里产出可落库、可按 seq 重放的完整事件流
  - 工具三态在事件流里**不做累积**——累积是有状态的，属于 tool-loop；事件流要如实记录每一帧，否则重放出来的不是上游真实发生过的东西
  - `response_info.created_at` 是 int64 → `bigint`，`JSON.stringify` 会抛，落库前先 `.toString()`
- 验证：「frames map to unified events with the right upstream case」「response_info with an error becomes run.failed, not run.completed」（并断言 payload 可 `JSON.stringify`）「gateway-generated and upstream-backed events are distinguishable」「usage events convert back into the four-bucket RequestUsage」

### P6 · provider 选路

- 状态：已完成（未接线）
- 改动：`src/cursor-connect/router.ts`（新）：`selectProvider()`（纯函数）、`ProviderRouter`
- 口径：
  - 优先级 显式 header > 模型前缀 `connect/` > key 设置 > 全局默认。越显式越优先——运维用 header 压测某条路线时不该被 key 上的设置盖掉
  - 默认仍是 `sdk`：Connect 路线的工具循环没实测过，不能默认接管流量
  - Connect 不可用时**明确回落**而不是报错，并在 `reason` 里留痕
  - 选路是纯函数，不持有任何跨 provider 状态，一条路线的 key / 重试 / 错误污染不到另一条
  - `capabilities()` 不声明未实现的能力：Connect 的 `tools` 报 false，因为"同 conversation_id 的第二次 Stream 能否接续"未验证
- 验证：「provider selection follows header, then model prefix, then key setting」「selection falls back to sdk when the connect provider is not configured」「the router hands back the right runner and never invents capabilities」
- 未做：接进 `server.ts`；`RequestLogRecord` 加 `provider` 字段；`key-rotating-runner` 按 provider 隔离；后台 CRUD 与连通性测试

### 审阅一轮（2026-09-02）

- 状态：已完成
- 范围：只修审阅指出的缺陷，不改架构、不接线、不扩 `CursorStreamEvent`
- 审阅方式：独立子代理，对 descriptor 抽查 16 个 message、对 `EnvelopeSplitter` 跑 3000 轮随机分片模糊测试（0 不一致）、独立手算 checksum 定值

代码已修：

1. **`errors.ts` HTTP 状态被改写**（真 bug）：`httpTransportError` 原来把状态绕道 Connect code 再换算回来，而那张表是有损的——429→unavailable→**503**、404→**501**、400→**500**。「配额用完」被说成「服务不可用」，调用方的重试策略跟着一起错。改为原样透传上游状态，非 4xx/5xx 归 502。顺带删掉已无生产调用方的 `statusToConnectCode` / `STATUS_CONNECT_CODE`
2. **`response-normalizer.ts` 工具调用重复产出**（真 bug）：重复的 `is_complete` 帧会把同一个调用发两遍；完成之后迟到的 args 增量还会新建一个 `name` 为空的幽灵调用，在 `flush()` 时冒出来。加 `completed` 键集合
3. **`response-normalizer.ts` 用量重复计数**（真 bug）：`usage.prompt_tokens` 是**含缓存的总输入**，`extended_usage.input_tokens` 是**缓存之外的部分**，逐字段取 max 会算出 `input=100 + cacheRead=80 = 180`，而 `totalTokens` 只有 120。改为 `extended_usage` 一到就整体接管，并把 `totalTokens` 修正成四桶之和（`src/protocol.ts:554` 的不变量）
4. **`request-builder.ts` 凭空发明图片语义**（真 bug）：`GatewayImage.source === "url"` 时把 URL 字符串塞进 `InferenceImagePart.data`。descriptor 里该字段只有 `data` + `mime_type`，没有任何证据说它收 URL，模型拿到的会是一串无意义文本。改为明确抛 400，不静默送错也不静默丢弃
5. **envelope 错误未映射**（真 bug）：`EnvelopeTooLargeError` / `TruncatedEnvelopeError` 是普通 `Error`，`normalizeError()` 会把它们归成 500 `internal_error` 并把「网关自己的 `readMaxBytes` 是多少」透给调用方。新增 `envelopeError()`，在 `client.stream` 里转成 502 `upstream_error`
6. **`parseEndStream` 静默成功**：非空但解析不出来的 endStream payload 原来当作正常收尾。那段 payload 里本来可能装着 error，吞掉会把失败请求变成截断的成功响应。改为返回 `error{code:"internal"}`
7. **失败时丢用量**：`recordResponseTelemetry` 只在成功路径调用。上游可能发完 usage 帧才报错，那部分计费会凭空消失。改成 `try/finally`
8. **`readEnvelopes` 多拉一次**：收到 endStream 后用 `break` 只跳出内层，外层 `for await` 还会再向上游要一个 chunk。改成 `return`
9. **`unknownCases` 无上限**：`providerMetadata` / `imageDescriptions` 分支无条件 push，500 个帧就是 500 项。与 `default` 分支统一走去重
10. **目录缓存无上限**：缓存键含 `modelId`，而 `modelId` 是调用方可控的，一串随便编的模型名就能把表撑爆。加 `DEFAULT_CATALOG_MAX_ENTRIES = 512` + 过期优先的 FIFO 淘汰
11. **并行工具调用可能挤成一个**：pending 只按 `tool_call_id` 归并，上游若在增量帧里只带 `tool_index`（descriptor 字段 5，存在的意义正是关联）而不重复 id，所有并行调用会挤进同一个空 id 的槽。改为按 `toolCallId || "#" + toolIndex` 归并
12. **`connect-accept-encoding` 默认不发**：计划 §1.6 记录客户端是 `acceptCompression: [gzip, br]`。默认补上 `gzip, br`（envelope 层本来就两种都能解）
13. `provider.ts` 丢弃了 `resolveModelParams` 的 `dropped` / `usedFallback`，与 SDK 路线的 `logDroppedIntent` 不一致。补一条 warn

订正一处此前写错的自述：

- ~~`checksum.ts`「必须写回 Uint8Array……用普通数组算会得到不同的字节」~~ —— **不成立**。溢出多出来的高位在后面每一轮 XOR 里都原样保留，最后编码成字节时又被掩掉。实测 20 万个时间戳里 9018 个发生溢出，输出**无一不同**。代码仍照抄客户端写法（不依赖这个巧合），但注释已改成事实描述，也没有为此加一个不可能失败的测试

14. **目录失败被按完整 TTL 记住**：`.catch(() => undefined)` 把「目录里没有这个模型」和「目录接口抽了一下」压成同一件事，然后缓存 5 分钟。一次网络抖动就让之后 5 分钟的请求全部降级到家族兜底，且期间一次都不重试。改为成功/失败分开处理，失败只缓存 `DEFAULT_CATALOG_FAILURE_TTL_MS = 10s`
15. **过期条目只在表满时才清**：改为读到就删，不再等 `evictIfFull`
16. **`clear()` 清不干净**：只清了 `entries`，在途请求回来还会把刚清掉的值写回去。加代次计数器，代次已变就不写；`inflight` 也一并清
17. **凭据校验晚于目录查询**：`buildConversation` 可能走一次网络才轮到 `new CursorConnectClient` 校验凭据。把 client 的构造提前

按计划保留：

- `run()` 里 `result ?? { text: "", toolCalls: [] }` 是防御性兜底，审阅认为是死代码。保留：`stream()` 抛异常时不会走到这里，但接口契约要求 `run()` 返回一个 `CursorRunResult`
- `checksum.ts` 用真值判断而非 `macMachineId === undefined`。空串是录入残留而不是真实设备标识，当作缺席更稳；测试已把这条行为钉住
- `cursorTokenType` 不查 `exp`。凭据过期属于 G10 的凭据模型，本轮只做「web token 不能当 session token 用」这一条本地可判定的校验
- `InferenceResponseInfo.messages`（descriptor 字段 4）仍未消费。计划 §G3 说它「比自己拼更可靠」，但用它需要先有结构化历史（G5）
- 未知 frame 只记 case 名，不记计划 §G3 说的「payload 长度」。长度本身会泄漏用户内容规模，且对排查没有帮助

测试补齐（本轮新增 16 个）：

- 「a transient catalog failure is not remembered for the full TTL」：失败缓存 10s、期间不回源、过后立刻恢复、成功后才走长 TTL
- 「expired entries are dropped on read, not only when the table fills up」（用新增的 `cache.size` 观测）、「clear() also discards lookups that are still in flight」

- 「http transport errors pass the upstream status through unchanged」：400/402/404/413/429/500/503/302 逐条
- 「a repeated complete frame does not emit the same tool call twice」、「an args delta arriving after completion does not create a phantom tool call」、「parallel tool calls stay separate when deltas carry only tool_index」
- 「extended_usage takes over wholesale and never double-counts the cached tokens」（用真实的 100/20/80 缓存拆分，旧实现会算出 180）、「a late coarse usage frame cannot clobber the detailed one」
- 「URL images are rejected instead of being passed off as inline data」、「base64 images do go out as an image content part」
- 「envelope-level failures become upstream errors, not internal 500s」（并断言消息里不含 `readMaxBytes`）、「an unreadable end-of-stream frame fails the run instead of truncating it silently」、「a decompression bomb is capped and reported as an envelope size error」
- 「usage collected before a failure is still written to telemetry」
- 「the caller's AbortSignal reaches fetch and surfaces as 499」（旧版只断言错误码，不验证 `signal` 是否真的透传，删掉 `transport.ts` 的 `signal:` 也能过）
- 「the catalog cache is bounded because model ids come from the caller」
- 「an unsupported content encoding cancels the body instead of leaking the socket」

- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：595 tests，593 pass，2 skip，0 fail
- 未 git commit；未改 README / `.env.example`；未接线 `server.ts`；未翻任何生产默认

### 审阅二轮 · 分模块五路（2026-09-02）

- 状态：已完成
- 方式：5 个独立子代理，按模块分路，各自只审自己那一块并驱动 `dist/` 复现。分路：G5+G11 / G10 / G6 / G7+G8 / G9+P6
- 范围：只修审阅指出的缺陷。未接线 `server.ts`、未翻默认、未改任何既有文件

代码已修（按模块）：

**G6 工具（最严重的一条在这里）**

1. **本地工具可以逃出工作区（Linux 上是真逃逸）**：绝对路径分支没走 `resolve()` 归一化，`/ws/link/x/..` 会落进"目标不存在"分支，而那条分支按字符串长度切余下部分，把软链原样留在结果里——前缀检查看着在根内，OS 读的时候跟着链出去。审阅在 82,740 个 POSIX 候选里跑出 180 条可逃逸路径。改为绝对路径先 `resolve()`，余下部分用 `dirname`/`basename` 取，保证只有**最后一段**（还不存在的文件名）可以未解析
2. **`maxOutputChars` 不约束内存**：96MB 文件配 `maxOutputChars: 10` 会先吃掉 195MB RSS 再切成 10 个字符。改为 `open()` 一次，对同一个 fd 做 `stat` + 定长 `read`，只读上限那么多字节。顺带关掉了审阅指出的 TOCTOU（检查与读取之间路径被换成软链）
3. **超时只是"不再等"，不是取消**：400ms 的工具在 `timeoutMs: 50` 下 62ms 返回超时，底层还在跑。改为超时先 `abort()` 再 reject，并把 signal 透传进 `LocalToolContext`
4. **已提交的工具结果被丢掉而不是重发**：命中幂等分支时只 `continue`，第二轮请求就少了一条 tool result，上游收到一个"声明了调用却没给结果"的请求。改为把库里存的结果取出来重发
5. **网关执行完的结果会凭空蒸发**：一轮里既有网关能执行的、又有要交回调用方的时，前者已经记成 `submitted`，却既没发给上游也没交给调用方。`ToolLoopResult` 增加 `completedToolResults`
6. **`maxIterations: NaN` 一次请求都不发**：`NaN < 1` 是 false，`iteration < NaN` 也是 false。改为 `Number.isInteger` 校验，且错误码从 500 改成 400
7. 取消：每轮开头检查 `signal.aborted`；执行器上下文补 `signal`（原来 `LocalToolContext.signal` 从循环里根本够不着）
8. 其它：非字符串结果也截断；`advertise()` 深拷贝 schema；注册重名工具直接拒绝（原来会静默影子掉内置的 `read_file` 并继承它的 allowlist 条目）；`validateArgs` 用 `Object.hasOwn` 挡住 `__proto__`/`constructor`；先校验再审批；审计只记错误**类别**不记 message（底层 IO 错误的 message 原样带着路径，那就是参数内容）

**G7 子代理**

9. **深度上限差一**：`parent.depth + 1 >= maxDepth + 1` 化简后是 `parent.depth >= maxDepth`，`maxDepth: 2` 实际放行了三代。改为 `parent.depth + 1 >= maxDepth`
10. **模型范围完全没校验**（本轮唯一一条安全问题）：child 的 model 来自模型自己写的工具参数，一个被钉在便宜模型上的 key 可以靠 `spawn_subagent` 把自己升到任意模型。接入 `routing.ts` 的 `modelAllowed` + 新增 `modelScope` 选项
11. **token 预算是死代码**：`addUsage` 零调用方，`tokensUsed` 恒为 0。改为 `SubagentRunner` 回报 `usage`，`spawn` 自动累计；并补 `wallClockBudgetMs`
12. 补全局子任务总数上限 `maxChildrenTotal`（原来只有单 parent 上限，进程生命周期内可无限起）
13. **child run 崩溃后无人接管**：原来直接建成 `running` 且不取租约，`lease_until` 是 NULL，崩溃接管分支永远看不到它。改为建成 `queued` 再用新增的 `store.leaseRun()` 上租约
14. **`cancelAll` 三处问题**：同步清空 `inflight` 让 `activeCount` 立刻归零而 child 还活着（并发上限当场失效）；没有粘性，同一轮里第二个工具调用照样能起新 child；取消被记成 `failed`。三处都修，取消现在在 store 里记 `cancelled`
15. 每 parent 的累计计数表加上限（`SPAWN_LEDGER_MAX`），不再随 parent 数无限增长

**G8 摘要**

16. **`contextFromSummary` 会把未完成的工具调用裁掉**——正是 G8 说必须保留的东西。改为按原下标过滤：还没拿到结果的调用、以及尾部结果对应的发起者，都强制保留。按下标过滤而不是"拼接头尾"，顺带保证补回来的发起者不会排到它自己的结果后面

**G9 background / 重放**

17. **非终态结局让 run 永久搁浅**：`awaiting_tool` / `awaiting_child` 时租约没释放，既不会被本 worker 继续跑，也没人能接管。改为无论终态与否都释放租约
18. **关停把在途 run 记成 failed**：`stop()` abort 之后走进 catch。加 `stopping` 标志，关停时把 run 放回 `queued`
19. **`cancel()` 会改别的 worker 的行**：跨 worker 写入会和持有者的收尾互相覆盖。改为只动本 worker 手上的
20. **重放静默丢中间段**：`eventsAfter` 单页上限 1000，只查一页就切 live。改为翻页翻到空
21. 重复 `backfill` 会把客户端已收过的事件再发一遍；缓冲区在 `backfill` 从不被调用时无上限。两处都修
22. **`delivery_state` 从来没被写过**，`resumeDecision` 在生产里永远返回不了 `unknown`——整条重建安全规则是空转的。改为在 `appendEvents` 的**同一个事务**里推进
23. `resumeDecision` 补 `awaiting_child`；`deliveryState === "complete"` 时即使 status 还没落成 completed 也判 `skip`

**G10 存储**

24. **事件批次不原子**：中途某条插入失败时前几条已落库而 `last_event_seq` 没更新，之后每次 append 都撞 PRIMARY KEY——这条 run 的事件流**永久写不进去**。整批包进 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`
25. 新增 `leaseRun(runId, owner, ms)`：给指定 run 上租约（`acquireRunLease` 是调度用的，会挑最早那条）

**G5 结构化对话 / G11 事件**

26. 旧式 `function_call` / `role:"function"` 整轮工具调用被丢掉（`protocol.ts` 是支持的）
27. 工具参数在三种形态下被抹成 `{}`：已经是对象、坏掉的 JSON、非对象 JSON。改为对象直接用、坏 JSON 保留原文
28. Responses 的 `reasoning` / `item_reference` / 裸字符串会变成 role=USER 但 content 未设的空消息
29. 缺 role / role 不认识的消息被整条丢掉，改为按 user（同 `protocol.ts`）
30. Anthropic `document` 块静默消失——模型会被问一份它从没收到的 PDF。改为像 `protocol.ts` 那样明确抛 400；其它不认识的块序列化进文本留痕
31. assistant 消息里出现 `tool_result` 时，结果会排到发起它的 assistant 消息之前
32. `usageFromEvent` 与 `ResponseNormalizer` 对同一条流算出不同用量（事件流上 last-wins 丢掉了"extended 覆盖 coarse"的规则）。新增 `reduceUsage()`，聚合一律走它

按计划保留（记明理由）：

- **per-tenant 并发**：`SubagentSchedulerOptions` 里没有租户身份，补它要把 `AuthContext` 一路穿到 scheduler。当前只有全局 `maxConcurrent`。属于接线时一并做，不在本轮
- **child 工具权限隔离只做到"默认不继承"**：`SubagentRunContext.tools` 默认空数组，想继承必须显式传 `childTools`。没有做更细的 per-tool 授权
- **`cc_credentials` 仍只有表结构**：凭据加密与 secret 管理是独立一轮
- **`raw_tool_call_args`（descriptor 字段 4）未接线**：坏掉的 JSON 现在存进 `arguments.__raw`，要原样回传给上游得改 `ConnectMessage` 与 `request-builder`，跨模块，留到 G6 接线时做

#### 二轮补修（读完五份完整报告后）

前一批是照着子代理的中途输出修的。五份完整报告到齐后又暴露出 15 条，多数集中在 `store.ts` 的并发路径——那部分之前只按"能不能跑通"审过，没按"两个 worker 同时来会怎样"审过。

33. **`appendEvents` 的 seq 读在事务外**：上一轮把插入包进了事务，但取 `last_event_seq` 那句留在外面，两个并发 append 仍会读到同一个起点，输家撞 UNIQUE 抛出、事件直接丢。读也挪进事务，并把 payload 序列化提到动库之前
34. **终态 run 会被复活**：`acquireRunLease` / `leaseRun` 的 UPDATE 只复查租约。`releaseRunLease` 会把 `lease_until` 置 NULL，于是一条在 SELECT 与 UPDATE 之间被收成 completed 的 run 照样被抓成 running，还带着已经写好的 `finished_at`。两处 UPDATE 都补上 status 复查
35. **非终态释放会抹掉 `finished_at`**：`finished_at = ?` 无条件绑定 `null`。改成 `CASE WHEN`，并禁止改写已经终态的 run（跨 worker 的 cancel 会覆盖别人刚写完的结果）
36. **`seqFromEventId` 不夹范围**：值来自不可信的 `Last-Event-ID` 头，一个超大数字让 `eventsAfter` 一条都查不到，客户端拿到空流且无报错。改为夹到本 run 的真实水位，并只收十进制（`Number()` 认十六进制和科学计数法）
37. **`submitToolResult` 先查再写**：并发下两个提交者都读到 `complete`、都返回 true，各自再发一轮推理——正是 `UNIQUE(run_id, call_id)` 想挡的重复计费。改为让 UPDATE 自己当闸门，用 `changes` 定返回值
38. **`upsertConversation` 会把一段对话劈成两条**：先查再写，两个并发首次接触各插一行，之后粘性凭据 / 摘要链 / run 历史各走一半。加 `UNIQUE(upstream_conversation_id, owner_hash)` + `ON CONFLICT DO UPDATE`
39. **空串 `defaultModel` 抹掉已存默认值**：`COALESCE` 只挡 NULL，`?? null` 放行 `""`。加 `blankToNull()`
40. **`createSummary` 去重是先查再写**：并发下两个摘要各插一行，摘两次、计费两次。加 `UNIQUE(conversation_id, source_hash)` + `ON CONFLICT DO NOTHING`
41. **`cc_conversations.latest_event_seq` 永远是 0**：只推进了 run 级水位。在同一事务里一并推进
42. **给不存在的 run 追加事件会静默成功一次**，第二次就撞 UNIQUE 并从此写不进去。改为直接拒绝
43. **cancel 被执行器的结局悄悄撤销**：`cancel()` 写了 cancelled，随后 `runOne` 又用 `completed` 覆盖回去。加 `cancelled` 集合，被取消过就不再写结局
44. **只有抛异常的 run 才发终态事件**：正常返回 `failed` 的 run，SSE 客户端看到 `run.started` 之后就是沉默。所有路径都补终态事件
45. **SSE 订阅方抛异常会带走 worker**：`onEvent` 的异常会让 `runOne` 在执行器跑之前就退出。包 try/catch
46. **router 的 `keySetting` 未归一化**：一个大小写不对的旧库值会被记成 Connect、在 SDK runner 上执行、capability 又报 Connect 那张表。走 `normalizeProvider`
47. **`capabilities()` 会为没接 runner 的路线宣传能力**：加可用性判断，没 runner 就全 false
48. `model: "connect/"` 会解析成空串（"有值"），下游 `?? default` 就不回落。改为返回 undefined

事件模型与结构化对话：

49. **`summary.completed` 声明了却没人产出**，而 worker 的终态又借用了上游语义的 `run.completed`。拆开：网关侧用 `run.finished` / `run.errored`，上游帧保留 `run.completed` / `run.failed`。两张表现在严格不相交，且有测试钉住
50. **未知 oneof case 被记成 `provider.metadata`**，导致"上游加了新 case 吗"这个问题再也答不出来。新增 `provider.unknown`
51. **删掉 `reasoningSignatures`**：它按消息下标索引，而下标会被 `conversationMessages()` 前置的 system 消息顶掉、被 `contextFromSummary()` 的裁剪打乱；记的东西又已经结构化地挂在 `ConnectReasoningPart.signature` 上。一个指向私有可变数组的位置下标不是稳定身份。写这条的测试时我自己也踩了同一个坑（断言 `[0]` 拿到的是 system 消息），改成按角色找
52. Anthropic 的 role 未小写归一，`"Assistant"` 会落到 user 分支并丢掉该消息的 `tool_use` 与 `thinking`；非 assistant 角色的 `tool_use` / `thinking` 也整段丢弃。两处都修
53. 符号链接测试在 Windows 上因缺少 `SeCreateSymbolicLinkPrivilege` 而整条静默跳过（还报 pass），而它是唯一的 containment 测试。改用 `junction`（不需要提权），现在开发机上也真的会跑

按计划保留（第二批）：

- **`cc_runs` 没有 `next_run_at`**：`ORDER BY rowid LIMIT 1` 在有非终态释放时会让最老那条被反复抢占。要修得给 `cc_runs` 加退避列，属于 schema 变更，与下面的迁移一起做
- **`cc_*` 没有迁移机制**：`src/store.ts` 有 `hasColumn` + `ALTER TABLE ADD COLUMN` 的成例，这里只有 `CREATE TABLE IF NOT EXISTS`。首次部署之后任何 schema 变更都会在查询时才炸。接线前必须补上
- **`cc_credentials` / `cc_tasks` 的租约列 / `idempotency_key` / `summary_json` / `default_parameters_json` 仍是死列**，与凭据管理一并做
- **per-tenant 并发**：仍需把租户身份穿到 scheduler

- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：685 tests，683 pass，2 skip，0 fail
  - 两批合计新增 47 条测试，每条都对着上面某一条缺陷，且在修复前会失败
- 未 git commit；未改 README / `.env.example`；未接线 `server.ts`；未翻任何生产默认

### 接线与后台（2026-09-02，约束解除后）

- 状态：已完成
- 前提变化：用户解除了"不动 `server.ts`"与"照计划做"的约束，并提供了登录 token。本机装有 Cursor `3.18.9`，所以 G4b 缺的那份 descriptor 也能自己取。

**G4b 解除搁置：`AvailableModels` 的 descriptor 自己抽**

- `scripts/extract-descriptor.mjs`（新）：从 Cursor bundle 里按**可达性闭包**抽一个 descriptor 子图。三件事让结果可信：
  - **按 webpack 模块分域**。压缩后的局部名（`go`/`To`/`W`）在同一个 bundle 的不同模块里会重复。第一版全文件建索引，`T:go` 直接解析到了另一个模块的 `git_forge.v1.CreateBranchRequest`——字段号看着像模像样，其实是完全不同的消息。这类错误比"抽不出来"危险得多
  - **跟随跨模块引用**。`T:g.SRo` 要顺着 `n.d(t,{SRo:()=>X})` 的导出表找回去；模块还可能在另一个 chunk 文件里，所以要扫整个 dist 目录
  - **归一化命名空间**。各模块给运行时起的别名不同（`a.proto3` / `_.proto3`），不统一的话下游生成器找构造函数边界时会跳过本类、把别人的零值算到这个消息头上
- `docs/reference/available-models-descriptor.txt`（新）：24 messages / 6 enums 的闭包
- `src/cursor-connect/proto/available_models_pb.ts`（新，生成物）：生成器现在支持多份 descriptor，嵌套类型用 `Parent_Child` 命名（只取最后一段会撞名——多个父消息各有一个 `EnumParameterValue`）
- `src/cursor-connect/available-models.ts`（新）：真实的目录调用。`parameter_definitions` 现在是 effort/thinking 值域的权威来源，`model-params.ts` 的硬编码退为兜底

**真机验证发现的协议 bug（这一条只有真发请求才能发现）**

- 第一次连通性测试拿到 **HTTP 415**。原因：我把一元调用当成流式发了。Connect 的 content-type 分两套，计划 §1.6 抄下的四个常量（`i6t`/`s6t`/`a6t`/`o6t`）正是这件事：
  - 流式：`application/connect+proto`，body 是 5 字节 envelope 帧序列，压缩头 `connect-*`
  - 一元：`application/proto`，body 是**裸** protobuf、**没有 envelope**，压缩头是标准 `content-encoding`
- 修完之后同一个请求变成 **401 unauthenticated**——占位 token 被正确拒绝，说明**协议层已经被真实服务端接受**。这是本轮唯一一条靠单测发现不了的缺陷
- 顺带修：上游错误体常常只有一个 `"Error"`，对运维毫无信息量。现在消息里始终带 Connect code（`Cursor Connect rejected the request: unauthenticated`），一眼能看出该换 token

**store 接线前的欠账（上一轮列为"接线前必做"的三项）**

- `migrate()`：`hasColumn` + `ALTER TABLE ADD COLUMN`，与 `src/store.ts` 同一套做法。之前只有 `CREATE TABLE IF NOT EXISTS`，对已建过表的库等于不生效，改 schema 要等到某次查询才炸
- `cc_runs.next_run_at` + `releaseRunLease(id, status, backoffMs)`：退避闸门。没有它时 `ORDER BY rowid LIMIT 1` 会让一条被反复非终态释放的 run 永远排在最前，把后面全饿死
- `cc_credentials` 的 DAO：`upsertCredential` / `listCredentials` / `activeCredentials` / `setCredentialStatus` / `recordCredentialUse` / `recordCredentialFailure`。token 落库前过一层 `protectToken`（默认只是 base64，**不是加密**——真正的密钥管理该由 Docker secret / secret manager 承担，这里只留注入点，不假装自己在做加密）

**装配与选路**

- `src/cursor-connect/service.ts`（新）：Connect 路线的装配层。凭据轮换（按 `lastUsedAt` fill-first，与 SDK 路线一致，换凭据会丢上游 prompt 缓存）、目录缓存（按凭据分片）、失败归因（**只有 401/403 计入凭据失败**，429/5xx 是上游状态，按失败累计会把一次限流演变成停用凭据）、连续 5 次鉴权失败自动停用
- `src/cursor-connect/routing-runner.ts`（新）：按 `CursorRunRequest.provider` 分发。选路本身仍是 `router.ts` 的纯函数，在 `server.ts` 建请求时定好；两条路线的 key / 重试 / 错误彻底隔离
- `server.ts`：`loggedRunRequest` 里选一次路（三套对外协议都经过它，分散到各 handler 会让"哪条规则命中"再也说不清），把 `provider` / `rawBody` / `inboundProtocol` 写进请求。**没有改动任何既有分支的行为**
- `index.ts`：建 `CursorConnectStore`（共用同一个 SQLite 文件，表名 `cc_` 前缀，`src/store.ts` 一行没动）、播种 env 凭据、组 `ProviderRoutingRunner`、按开关起 background worker、关停时把在途 run 放回 `queued`

**工具循环 / 子代理真正可达**

- `service.ts` 的 `stream()` 现在分两条：网关需要代跑工具（本地工具 / 子代理）时走 `runToolLoop`，否则单发单收。两条都产出同样的 `CursorStreamEvent`，对外 SSE 层不区分
- 走工具循环时会落 `cc_conversations` + `cc_runs`，工具调用的幂等、事件重放、background 恢复才有挂靠
- 子代理的 `runChild` 接上真实 client：独立 conversation、可以是不同模型、默认不继承父的工具

**HTTP 面（G9 的六个端点）**

- `src/cursor-connect/routes.ts`（新）：`status` / `models` / `runs` / `runs/:id` / `runs/:id/events`（SSE，认 `Last-Event-ID`，先订阅再翻页补发，终态直接收流，20s 心跳）/ `cancel` / `resume` / `tool-results` / `conversations/:id/summaries`
- `tool-results` 校验结果**确实属于这个 run 且 tool_call_id 存在**——否则任何人都能往别人的 run 里塞结果；重复提交幂等；只有全部结果到齐才把 run 放回队列
- 与主 API 共用同一套入站鉴权，不给 Connect 端点开后门。没装载这条路线时明确回 503 而不是 404（运维才能分清"没装"和"URL 打错了"）

**admin 后台（可交互）**

- 侧栏新增「Connect 凭据」，四个面板：状态/凭据表、运行设置回显、模型目录、Run 列表
- 交互操作：添加凭据、**测试连通性**（真打一次 `AvailableModels`）、启用/停用、**换 token**（machineId 保持不变）、删除、拉取/强制刷新目录、刷新 Run、查看 Run 详情（含事件）、取消 Run
- 安全口径：后台**绝不回传 token 明文**，只给 `bran…oken(15)` 这样的首尾提示；machineId 也只给前 8 位。添加成功后立刻清空输入框（这个页面可能正开在共享屏幕上）
- 运行设置只做**回显**不做修改：这些值来自 env，后台改了却与实际出站不一致比不能改更糟

- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：713 tests，711 pass，2 skip，0 fail
  - 本轮新增 28 条测试（`cursor-connect-wiring` 15 + `cursor-connect-routes` 13）
  - 真机：进程起得来（`Cursor Connect: 1 credential(s) ready`）、`/v1/cursor-connect/status` 与 `/admin/api/connect` 正常、后台页面含 Connect 导航、连通性测试打到真实 Cursor 并按预期返回 401（占位 token）
  - `git diff` 确认 `cursor-runner.ts` / `sand-client.ts` / `store.ts` / `protocol.ts` / `routing.ts` / `models.ts` / `model-params.ts` 全部零改动
- 仍未验证（**需要一把真 token**）：计划 §P2 那条"同一个 `conversation_id` 的第二次 `Stream` 请求上游是否接续"。代码按"能接续"实现，`CURSOR_CONNECT_SEND_TOOLS` 默认关，`capabilities().tools` 报 false

---

## 门禁

| 阶段 | 条件 | 结果 |
|---|---|---|
| 协议事实层 | 生成物字段号与 descriptor 逐条一致 | 已过（54 messages / 4 enums，对照测试自带独立解析器） |
| envelope | 任意 chunk 切分结果一致；压缩 / endStream / 超长 / 截断可识别 | 已过（7 种切法 + gzip + br + `0xffffffff` + 半包） |
| checksum | base64url 无 padding，与客户端算法逐字节一致 | 已过（手算定值 `7Y6Qjsqv`） |
| 端点 | 严格 `POST /aiserver.v1.InferenceService/Stream` | 已过（全仓无 `agent.v1.AgentService`） |
| 依赖 | `@bufbuild/protobuf` 显式直接依赖且锁 `1.10.0` | 已过（lock 只多 1 行，`resolved` 未变） |
| 出站路径 | 只走全局 `fetch`，不引 `@connectrpc/*` / `node:http2` | 已过 |
| 不动现有逻辑 | `cursor-runner.ts` / `sand-client.ts` / `server.ts` / `types.ts` 零改动 | 已过（`git status` 只有 `package.json` + `package-lock.json` 是 M） |
| 审阅收口（G1–G4） | 审阅指出的真 bug 全修，并各有一条能失败的测试 | 已过（17 项已修；4 项按计划保留并记明理由；1 处自述错误已订正） |
| 第二部分覆盖 | G0–G11 + P6 各有实现或有记明理由的搁置 | 已过（G4b / G6.3 / server.ts 接线三项搁置，理由分别是缺 descriptor、未取证、硬约束） |
| 审阅收口（G5–G11 + P6） | 分 5 路按模块审阅，真 bug 全修且各有一条能失败的测试 | 已过（53 项已修；8 项按计划保留并记明理由） |
| 接线前必做 | `cc_*` 迁移机制 + `cc_runs.next_run_at` + `cc_credentials` DAO | 已过 |
| 协议层真机验证 | 出站被真实 Cursor 接受（不是被 415 拒） | 已过（415 → 修一元 framing → 401 unauthenticated） |
| 后台可交互 | 凭据 CRUD / 连通性测试 / 换 token / 目录 / Run 取消 | 已过 |
| 端到端 | 进程起得来，Connect 端点与后台面板可用 | 已过（真机 `Cursor Connect: 1 credential(s) ready`） |
| 工具循环接续 | 同 `conversation_id` 的第二次 `Stream` 是否接续 | **未验证**（需真 token；`sendTools` 默认关） |
| 全量测试 | `npx tsc --noEmit` 干净；`npm test` 全绿 | 已过（接线后：713 tests / 711 pass / 2 skip / 0 fail，基线 514/512/2/0） |

---

## 怎么用

```bash
# 最小配置：一把 session token 就够，其余全有默认值
CURSOR_CONNECT_TOKEN=<session token>

# 让 Connect 成为默认路线（不设则默认仍走 SDK，按请求指定即可）
GATEWAY_PROVIDER=connect
```

按请求指定路线（不改全局默认）：

```bash
curl -H "x-gateway-provider: connect" ...     # 显式 header，优先级最高
curl -d '{"model":"connect/grok-4.6", ...}'   # 模型名前缀，前缀会被剥掉再发给上游
```

凭据也可以完全不走 env，直接在后台「Connect 凭据」页添加——那里还能测连通性、换 token、看目录与 Run。

---

## 下一步的先后

只剩一件需要真 token 才能做的事，以及三件可选的收尾。

1. **拿真 token 验计划 §P2**：先在后台「测试连通性」确认 401 变成成功、目录能拉到；再发一次普通 `/v1/chat/completions`（带 `x-gateway-provider: connect`）确认文本与 thinking 通；最后才开 `CURSOR_CONNECT_SEND_TOOLS=true`，验"同 `conversation_id` 的第二次 `Stream` 是否接续"。不接续就要切 `RunInference`——载荷类型相同，换的只是 transport 与握手
2. **`RunInference` 备选 transport**：只有第 1 步失败才需要。BiDiStreaming 没有 SSE/poll 回退，必须真的 HTTP/2 双向流
3. **per-tenant 子代理并发**：要把租户身份（`AuthContext`）一路穿到 scheduler，当前只有全局 `maxConcurrent`
4. **凭据的真加密**：现在 `protectToken` 默认只是 base64，注入点已经留好。生产上应接 Docker secret / 外部 secret manager，而不是在这一层自己发明加密
