# Grok Bot Sand 兼容实现计划

## 0. 文档说明

本文档用于规划两条并行但相互提供验证依据的实现路线：

1. 继续修改 Cursor 客户端补丁，使 Cursor UI 能够使用 Grok Bot 的 Sand 推理链路；
2. 在 `E:\docker-composer-api` 上迭代独立 API 网关，直接代理 Grok Bot 的 Sand 推理接口。

本文档是实施计划，不代表当前功能已经实现。文中凡是标注“待确认”的内容，都必须先取证再写入生产代码。

### 0.1 事实来源与优先级

冲突时按以下顺序采信，不允许用低优先级材料推翻高优先级材料：

1. `Cursor 3.18.9` 自带的 protobuf descriptor（`extensions/cursor-agent-host/dist/657.js`）
   —— 协议字段、方法 kind、枚举值的唯一权威来源；
2. `sand_stream_installer_tools_fixed_v126.py`
   —— Cursor 补丁侧的当前基线。本文档与该脚本冲突时以脚本为准；
3. Cursor 3.18.9 官方 bundle 中的 local provider 实现
   （`cursor-agent-exec/dist/main.js:Lge`、`cursor-local-agent-runtime/dist/main.js:HHt`）
   —— “官方原本怎么做”的对照；
4. Grok Bot 0.30.0 解包材料（`_asar_tmp`）
   —— 只对 **鉴权头、checksum、client-type/version、模型目录、sandbox 生命周期** 有权威性；
5. `probe_sand_grok.py`
   —— 只是烟雾测试，其 header 名与 base64 编码已确认有误（见 §9 G2）。

### 0.2 本轮已纠正的事实错误

| 原文说法 | 实际情况 |
|---|---|
| Grok Bot 桌面端调用 `InferenceService` | 不调用。全 bundle 0 处 `InferenceService`/`RunInference` |
| 可以从 Grok Bot 抓到 Stream fixture | 不可以。桌面端只有 6 个 Connect service，推理发生在 Sand box 内 |
| Cursor 原生对话走 `InferenceService/Stream` | 走 `InferenceService/RunInference`（BiDiStreaming） |
| 官方 `taskToolProps` 限制了子代理模型 | 官方 `isModelValid:()=>!0`，限制来自本项目补丁 |
| 请求头是 `x-cursor-version` | 三个 bundle 中均为 0 处；实际是 `x-cursor-client-version` |
| checksum 用标准 base64 | 用 base64url 且不带 padding |

---

## 1. 已确认的约束

### 1.1 两个不同的推理入口

`aiserver.v1.InferenceService` 在 Cursor 3.18.9 里有 4 个方法，其中两个能承载推理：

```text
InferenceService/Stream          kind = ServerStreaming
    I = aiserver.v1.InferenceStreamRequest
    O = aiserver.v1.InferenceStreamResponse

InferenceService/RunInference    kind = BiDiStreaming
    I = aiserver.v1.RunInferenceClientMessage
    O = aiserver.v1.RunInferenceServerMessage
```

descriptor 原文（`657.js`，模块 4410）：

```js
typeName:"aiserver.v1.InferenceService",methods:{
  stream:{name:"Stream",I:r.Zc,O:r.jK,kind:MethodKind.ServerStreaming},
  recordAgentFollowupClassification:{...Unary},
  recordAgentPostTurnLabeling:{...Unary},
  runInference:{name:"RunInference",I:r.jR,O:r.fJ,kind:MethodKind.BiDiStreaming}}
```

**Cursor 原生 managed-local agent 走的是 `RunInference`，不是 `Stream`。** 证据：

- `675.js` 的 managed-local runtime 写死 `reconnectEndpoint:"InferenceService.RunInference"`；
- `657.js` 把该方法映射到专用 transport：
  `_overrideMethodNameToTransportMap[InferenceService.methods.runInference.name] = e.agenticComposerTransport`；
- `657.js` 客户端构造：`managedInferenceClient: E(InferenceService, C)`，
  http2 探测用 `methodName: InferenceService.methods.runInference.name`。

两者的关系是**包含**而不是并列：

```text
RunInference（run 级双向会话）
    invokeModel.request : InferenceStreamRequest   ← 与 Stream 的入参同一个类型
    invocationResponse.response : InferenceStreamResponse ← 与 Stream 的出参同一个类型
```

即：`Stream` 是"一发一收的单次推理"，`RunInference` 是"一条长连接上跑多次推理，并额外提供
路由协商（`runReady`）、取消（`cancelInvocation`）和收尾（`finishRun`）"。二者的请求/响应
**载荷类型完全相同**，所以本项目的 message/tool/model 编解码代码在两条路线间可以 100% 复用。

### 1.2 本项目的路线选择

| 路线 | 端点 | 原因 |
|---|---|---|
| Cursor 补丁（第一部分） | `RunInference` | 原生实现如此。v126 的 `hre` 短路方案绕过它，但上层 `reconnectEndpoint` 仍指向它 |
| 独立 API（第二部分） | `Stream` 优先，`RunInference` 备选 | 网关是无状态 HTTP 服务，单向 ServerStreaming 与 `POST /v1/chat/completions` 的生命周期天然对齐 |

**不采用 `agent.v1.AgentService/Run` 作为任何推理路径。** 它在 `657.js` 里有独立的
`agentBidiTransport`、独立的 SSE 回退（`AgentService.methods.run → runSSE`）和 poll 回退，
是"agent 编排协议"而不是"推理协议"，与本项目目标冲突。

需要注意 `RunInference` **没有** SSE/poll 回退：

```js
// 657.js @268210
_bidiEndpointToSSEMethodMap = {
  [ChatService.methods.streamUnifiedChatWithTools.name]: ...WithToolsSSE,
  [ChatService.methods.streamUnifiedChatWithToolsIdempotent.name]: ...IdempotentSSE,
  [HealthService.methods.streamBidi.name]: streamBidiSSE,
  [AiService.methods.streamStt.name]: streamSttSSE,
  [AiService.methods.streamBugBotAgentic.name]: streamBugBotAgenticSSE,
  [AiService.methods.streamUiBestOfNJudge.name]: streamUiBestOfNJudgeSSE,
  [AgentService.methods.run.name]: runSSE
}   // ← 没有 runInference
```

`_bidiEndpointToPollMethodMap` 同样没有 `runInference`。这意味着走 `RunInference` 时
**必须有真正的双向流（HTTP/2）**，不能靠 SSE 降级。这是独立 API 优先选 `Stream` 的第二个理由。

### 1.3 唯一确定的 wire 事实（来自 descriptor，非推测）

请求：

```text
aiserver.v1.InferenceStreamRequest
  1  messages                          repeated InferenceCoreMessage
  2  tools                             repeated InferenceAgentTool
  3  provider_defined_tools            repeated InferenceNamedProviderDefinedTool
  4  model_config                      optional InferenceModelConfig
  5  model_id                          optional string
  6  invocation_id                     optional string
  7  requested_model                   optional InferenceRequestedModel
  8  conversation_id                   optional string
  9  accepted_unadvertised_tool_names  repeated string
 10  automation_id                     optional string
 11  inference_reason                  optional InferenceReason
 12  conversation_group_id             optional string
```

响应（oneof `response`，10 个 case）：

```text
aiserver.v1.InferenceStreamResponse
  1  text_part            InferenceTextStreamPart   {text, is_final}
  2  tool_call_part       InferenceToolCallStreamPart {tool_call_id, tool_name, args(string), is_complete, tool_index?}
  3  usage                InferenceUsageInfo        {prompt_tokens, completion_tokens, total_tokens?}
  4  response_info        InferenceResponseInfo     {id, model, created_at, messages[], error_message?, inference_extra_data?, supports_self_summary?}
  5  extended_usage       InferenceExtendedUsageInfo
  6  provider_metadata    InferenceProviderMetadataInfo
  7  invocation_id        InferenceInvocationIdInfo {invocation_id}
  8  error                InferenceStreamError      {message, code, is_input_token_limit_error, is_output_token_limit_error, error_type}
  9  thinking_part        InferenceThinkingStreamPart {text, signature?, is_final}
 10  image_descriptions   InferenceImageDescriptionsInfo
```

模型与参数：

```text
aiserver.v1.InferenceRequestedModel
  1 model_id string
  2 max_mode bool
  3 parameters repeated InferenceModelParameterValue {id string, value string}
  4 built_in_model bool
  5 is_variant_string_representation bool
```

消息：

```text
aiserver.v1.InferenceCoreMessage
  1  role  InferenceMessageRole
  oneof content: 2 text(string) | 3 parts(InferenceContentParts) | 6 tool_content(InferenceToolResultContent)
  4  tool_calls        repeated InferenceToolCall {tool_call_id, tool_name, args(Struct), raw_tool_call_args?}
  7  reasoning_parts   repeated InferenceReasoningPart {is_redacted, text, signature?, redacted_data?, model_name?}
  8  model_provider_message_id  optional string
  9  openai_phase / 10 openai_phase_null / 11 cursor_inference_reason / 12 cursor_feature_type
```

枚举（**数值必须按此，不能猜**）：

```text
InferenceMessageRole:  0 UNSPECIFIED  1 USER  2 ASSISTANT  3 TOOL  4 SYSTEM
InferenceStreamErrorType: 0 UNSPECIFIED 1 UNKNOWN 2 INPUT_TOKEN_LIMIT 3 OUTPUT_TOKEN_LIMIT
                          4 RATE_LIMIT 5 AUTHENTICATION 6 PERMISSION 7 OVERLOADED 8 CONTENT_FILTER
InferenceReason:       0 UNSPECIFIED  1 GEMINI_VIDEO_SUBAGENT
RunInferenceRoutingRole: 0 UNSPECIFIED 1 USER 2 ASSISTANT
```

`RunInference` 帧（仅当选备选路线时需要）：

```text
RunInferenceClientMessage  oneof message:
  1 run_request       {conversation_id, conversation_group_id?, requested_model, routing_conversation[], agent_mode?}
  2 invoke_model      {invocation_id, request:InferenceStreamRequest}
  3 cancel_invocation {invocation_id}
  4 finish_run        {}                        ← 空消息

RunInferenceServerMessage  oneof message:
  1 heartbeat         {}                        ← 空消息
  2 run_ready         {resolved_model, supports_self_summary, routed_model_display_name?, prompt_model_metadata}
  3 invocation_response {invocation_id, response:InferenceStreamResponse}
  4 invocation_end    {invocation_id, error?:RunInferenceInvocationError{code:int32, message, details[]}}
```

关键点：`supports_self_summary` / `resolved_model` / `routed_model_display_name` /
`prompt_model_metadata` **只在 `run_ready` 帧里出现**。走 `Stream` 时它们不存在
（`InferenceResponseInfo.supports_self_summary` 是唯一例外，但那是响应末尾而非握手），
所以走 `Stream` 的网关必须自己决定 summary 能力，不能等上游告知。

### 1.4 Grok Bot 是完整 Agent Runtime，且不直接调用 InferenceService

`_asar_tmp/out/package.json`（`name: sand`, `productName: Grok Bot`, `version: 0.30.0`）
声明了 `@anysphere/agent`、`agent-client`、`agent-core`、`agent-exec`、`chat-inference`、
`chat-inference-proto`、`agent-summarization`、`agent-transcript`、`agent-store-sync`、
`local-exec`、`mcp-agent-exec`、`model-selection` 等 workspace 依赖。

**但打包产物里没有 InferenceService。** 实测：

```text
_asar_tmp/out/**            "InferenceService"  0 处
_asar_tmp/app.asar          "InferenceService"  0 处 / "RunInference" 0 处
```

`electron-main/main.cjs` 中出现的全部 Connect service（`typeName:"aiserver.v1.*"`）只有 6 个：

```text
AiService  AnalyticsService  BackgroundComposerService
DashboardService  GrokBotService  SandBoxService
```

实际调用点：

```text
AiService.availableModels        ← fetchSandAvailableModels()
                                  new AvailableModelsRequest({useModelParameters:!0,
                                                              scope: USER_AVAILABLE})
GrokBotService.ensureSandBox    ← BrokeredHostConnector.connect()
GrokBotService.mintSandVoiceCallSecret
AnalyticsService.bootstrapStatsig / trackEvents
DashboardService.getUserPrivacyMode / getMe
```

`node-agent-coordinator/main.cjs` 的出站是**自定义 HTTP**，不是 Connect：

```text
POST  ${baseUrl}/api/<method>      su="/api"
GET   ${baseUrl}/events            Ug="/events"
      ${baseUrl}/health            Bg="/health"
      /cancel                      bE="/cancel"
DNS   ${namespace}.${cluster}.cursorvm.com
```

**结论：Grok Bot 桌面端不是推理客户端，是 sandbox 控制端。** 真正的推理发生在
`*.cursorvm.com` 上的 Sand VM 内部，桌面端只负责鉴权、开箱、转发 prompt、订阅事件。

这直接推翻了原计划的一个前提：**无法通过抓 Grok Bot 桌面端的包得到
`InferenceService/Stream` 的 request/response fixture**。Grok Bot 能提供的只有：

- 鉴权头构造（§1.5）；
- `x-cursor-client-type: "sand"` 的值；
- 模型目录请求形状（`AvailableModelsRequest`）；
- `SAND_DEFAULT_MODEL_ID = "grok-4.5"`。

### 1.5 鉴权头（已逐字取证，两处实现一致）

Grok Bot（`electron-main/main.cjs`）：

```js
u.set("x-cursor-checksum", nw(machineId));
u.set("x-cursor-client-type", W6);            // W6 = "sand"
u.set("x-cursor-client-version", kc());
u.set("x-sand-box-namespace", syt());         // "prod" | "dev" | "lab"
u.set("x-ghost-mode", ghost);
u.set("authorization", `Bearer ${accessToken}`);
u.set("x-cursor-team-id", String(teamId));    // 有 team 时
u.set("x-request-id", crypto.randomUUID());

function nw(machineId) {                       // createCursorChecksum
  const e = Math.floor(Date.now() / 1e6);
  const t = new Uint8Array([e>>40&255, e>>32&255, e>>24&255, e>>16&255, e>>8&255, e&255]);
  return `${Buffer.from(Hwr(t)).toString("base64url")}${machineId}`;
}
function Hwr(n) { let e = 165;
  for (let t = 0; t < n.length; t++) { n[t] = (n[t] ^ e) + t % 256; e = n[t]; } return n; }
```

Cursor 桌面端（`workbench.desktop.main.js`，函数 `AJg`）算法完全相同，只是尾部拼接方式不同：

```js
const C = Math.floor(Date.now()/1e6);
const x = new Uint8Array([C>>40&255, C>>32&255, C>>24&255, C>>16&255, C>>8&255, C&255]);
const I = base64Fn(TJg(x));   // base64Fn = n => iT(Ei.wrap(n), false, true)
                              //           iT(buf, padding=false, urlsafe=true)  → base64url 无 padding
e.header.set("x-cursor-checksum", macMachineId === undefined
    ? `${I}${machineId}` : `${I}${machineId}/${macMachineId}`);
```

因此，三条已确认的更正：

| 项 | 探针里的写法 | 实际 |
|---|---|---|
| 版本头 | `x-cursor-version` | `x-cursor-client-version`（三个 bundle 里 `x-cursor-version` 均 0 处） |
| checksum 编码 | `base64.b64encode`（标准表 + padding） | `base64url` 且 **omitPadding**（`iT(buf,!1,!0)`） |
| checksum 尾部 | 总是 `machineId/macMachineId` | Grok Bot 只拼 `machineId`；Cursor 有 macMachineId 时才拼 `/macMachineId` |

Cursor 桌面端另外还会发（Grok Bot 不发）：

```text
x-cursor-client-layout  x-cursor-client-os  x-cursor-client-arch
x-cursor-client-os-version  x-cursor-client-device-type: "desktop"
x-cursor-timezone  x-cursor-config-version  x-client-key  x-session-id
x-new-onboarding-completed  x-ghost-mode  x-amzn-trace-id: Root=<requestId>
x-cursor-client-commit（仅 Anysphere 内部账号）
```

`x-cursor-streaming: "true"` 由 agent-host 的 `applyStandardRequestHeaders` 添加。

### 1.6 Connect envelope（已从 Grok Bot 的 Connect 运行时取证）

```text
1 byte  flags
4 byte  uint32 big-endian payload length
N byte  payload
```

flags 位定义：

```text
bit0 (值 1) = compressed        UB = 1
bit1 (值 2) = end-of-stream     d6t = 2   → payload 是 EndStreamResponse(JSON)
```

解析逻辑原文（`electron-main/main.cjs`）：

```js
// 读 envelope
head() { const e = this.headerView.getUint8(0), t = this.headerView.getUint32(1);
         assertReadMaxBytes(this.readMaxBytes, t, true);
         return { flags: e, data: new Uint8Array(t) }; }
// 解压
if ((flags & UB) === UB) { data = await compression.decompress(data, readMaxBytes);
                           flags = flags ^ UB; }
// 分派
(flags & endFlag) === endFlag ? { value: endParse(data), end: true }
                              : { value: msgParse(data), end: false }
```

content-type 与协议头：

```text
application/proto            i6t
application/json             s6t
application/connect+proto    a6t
application/connect+json     o6t
Connect-Protocol-Version     Zgt
Connect-Content-Encoding / Connect-Accept-Encoding / Connect-Timeout-Ms
```

Cursor / Grok Bot 客户端一律 `useBinaryFormat: !0`（即 `application/connect+proto`），
压缩 `gzip` 与 `br` 都注册：`sendCompression: gzip, acceptCompression: [gzip, br]`。

探针用 `application/connect+json` 能通说明服务端接受 JSON codec，但 **JSON 与 proto
在 oneof、int64、Struct、bytes 上的表示不同**，fixture 必须标明用的是哪种 codec。

### 1.7 凭据和权限边界

实施时只使用自己有权使用的账号、Sand 资格和凭据。计划不包含伪造会员、绕过账号权限、伪造设备授权或规避服务端访问控制的步骤。

需要特别保护：

- session JWT；
- machine ID / mac machine ID；
- checksum 输入；
- 抓包中的 Authorization、Cookie、请求体和响应体；
- Cursor/Grok Bot 本地状态数据库。

日志和 fixture 必须脱敏，不能把真实 token、cookie 或完整设备标识提交到代码仓库。

---

## 2. 当前材料和问题盘点

### 2.1 工作区中的几个版本

#### `Sand客户端模式安装工具.py`

这是早期客户端模式补丁，主要处理客户端类型和资格判断，改动范围相对小。它没有完整处理新版本的 Stream、Agent Host、工具、Task、摘要和后台恢复。

用途：

- 作为早期最小补丁的对照；
- 作为客户端类型修改范围的历史参考；
- 不作为当前功能基线。

#### `sand_stream_installer(4).py`

该版本引入了直接 Stream 注入思路，但工具调用能力不完整，且把较多逻辑放在高层 session 工厂中。

用途：

- 作为 direct Stream 演进历史；
- 不作为最终实现基线。

#### `_ref_oxen`

这里包含较完整的补丁管理、备份、回滚、hash 和 `move_exec` 处理，也有测试文件。

可以保留的经验：

- `move_exec` 与 Agent Host 执行器资源拓扑的诊断；
- extension hash 和 `product.json` checksum 同步；
- 原子写入、备份、卸载、幂等和版本校验；
- 对 `undefined.execute` 的定位方法。

不能直接采用的部分：

- 把 `AgentService/Run` 当成当前对话链路；
- `direct_stream == 0` 作为当前最终目标；
- 旧版本 Cursor 的变量名、压缩结构和 descriptor。

注意：`_ref_oxen` 里"恢复 `runInference`"的思路本身**不是错的**——Cursor 原生 managed-local
就是走 `RunInference`（§1.1）。它的问题只在于把 `AgentService/Run` 和 `InferenceService/RunInference`
混为一谈。这两者确实不同，但 `RunInference` 与 `Stream` 属于同一个 service、共用同一套载荷类型。

#### `cursor-sand-tool/sand-research/sand_stream_installer.py`

这是中间版本，曾对 direct Stream 做过变量隔离和部分异常处理，但仍然是高层 session 短路方案。

用途：

- 对比不同 direct Stream 注入变体；
- 参考其针对旧 patch 的迁移和回滚处理；
- 不直接作为生产基线。

#### `sand_stream_installer_tools_fixed.py`

版本字符串 `1.2.5-tools-subagents-routing-fixed.1`，目标 Cursor `3.18.9`。已被 v126 取代，
只作为迁移路径上的历史版本保留（v126 仍能识别并升级它注入的 `SAND_MANAGED_TASK_TOOL_V1` marker）。

#### `sand_stream_installer_tools_fixed_v126.py`（**当前基线**）

版本字符串 `1.2.6-subagent-lifecycle-fixed.1`，目标 Cursor `3.18.9`（已核对
`product.json: version 3.18.9, commit 2ba48ff3f751, quality stable`）。

**本文档第一部分与该脚本冲突时，以该脚本为准。** 脚本注入的 marker 及其落点
（已对照当前干净基线逐条验证锚点存在）：

| marker | 目标文件 | 锚点 | 基线命中 |
|---|---|---|---|
| `SAND_CLIENT_MODE_V1` | `workbench.desktop.main.js` | `isGlass?"glass":"ide"` ×7 + `header.set("x-cursor-client-type",g??"ide")` ×1 | 8 |
| `SAND_CLIENT_EXISTING_V1` | `workbench.desktop.main.js` | 同上，但原值已是 `"sand"` 时 | 0（当前无） |
| `SAND_ELIGIBILITY_MODE_V1` | `workbench.desktop.main.js` | `ELIGIBILITY_PREFIXES` 6 个候选函数名 | **0（见下方警告）** |
| `SAND_AGENT_HOST_ENABLEMENT_V1` | `workbench.desktop.main.js` | `this._agentHostEnabled=` | 1 |
| `SAND_SUBAGENT_COMPLETION_WAKE_V1` | `workbench.desktop.main.js` | `.source==="interactive-child"` | 1 |
| `SAND_AGENT_HOST_IDENTITY_V1` | `agent-host/dist/main.js` | `clientIdentity:{clientType:"ide"}` | 1 |
| `SAND_AGENT_HOST_MOVE_EXEC_V1` | `agent-host/dist/main.js` | `p=await Promise.resolve(r.cursor.checkFeatureGate(Us)).catch(()=>!1)` | 1 |
| `SAND_LOCAL_RUNTIME_LOAD_V1` | `agent-host/dist/main.js` | `let t=!1;try{t=await r.cursor.checkFeatureGate(Ds)}` | 1 |
| `SAND_MANAGED_LOCAL_ROUTE_V1` | `agent-host/dist/657.js` | `try{return(yield o.checkFeatureGate(ae))?{runtime:"managed-local"…}` | 1 |
| `SAND_MANAGED_ACTION_ROUTE_V1` | `agent-host/dist/657.js` | action 资格判定 | 1 |
| `SAND_MANAGED_SUBAGENT_ROUTE_V1` | `agent-host/dist/657.js` | `hasUnsupportedRunOptions:…` | 1 |
| `SAND_SUBAGENT_RESUME_AGENT_MODE_V1` | `agent-host/dist/657.js` | `e.resumeAgentId&&e.mode===Mn.FL.UNSPECIFIED&&!e.readonly?` | 1 |
| `SAND_DIRECT_INFERENCE_STREAM_V1` | `agent-host/dist/675.js` | `function hre(e){return t=>{return n=this,o=void 0,s=function*(){` | 1 |
| `SAND_MANAGED_SUBAGENT_SESSION_V1` | `agent-host/dist/675.js` | `const Cre={enableEmptyResponseRetry:!0,…}` | 1 |
| `SAND_MANAGED_TASK_TOOL_V2` | `agent-host/dist/675.js` | `isGenerateImageModelRestricted:!1,taskToolProps:void 0}` | 1 |

**已发现一个 v126 的实际问题：`ELIGIBILITY_PREFIXES` 在 3.18.9 上全部不命中。**

v126 的 `ELIGIBILITY_PREFIXES`（`:1140` 附近）列了 6 个候选：

```python
"function r4g(e){const{adminSettingsService:t"
"function Vj_(t){const{adminSettingsService:e"
"function inf(e){const{adminSettingsService:t"
"function HSy(t){const{adminSettingsService:e"
"function Q_f(e){const{adminSettingsService:t"
"function BpS(t){const{adminSettingsService:e"
```

在当前 `workbench.desktop.main.js` 里这 6 个字符串**各 0 次命中**。实际唯一匹配
`function \w+(\w+){const{adminSettingsService` 的是：

```js
// @21751794
function Nxf(e){const{adminSettingsService:t,aiSettingsService:n,analyticsService:i,
                      composerDataHandle:r,emptyStateDraftHandle:s,modelConfigService:o,
                      modelNudgesEnabled:a,nudge:c,userSettings:l}=e, …
```

但这个函数的函数体是 **model nudge**（`i.trackEvent("model_nudge.received", …)`），
不是资格判定。所以 v126 在 3.18.9 上：

- `stats.eligibility` 恒为 0；
- `SAND_ELIGIBILITY_MODE_V1` marker 永远不会被注入；
- 实际 marker 总数是 **14 个而不是 15 个**（其中 `SAND_CLIENT_MODE_V1` 有 8 处）。

由于脚本的 `stats.total` 是各项之和、且没有对 `eligibility` 做"必须 > 0"的断言，
**这不会导致安装失败**，只是那一项没生效。要判断这是不是问题，需要先确认：
3.18.9 里资格判定是否已经不在 `adminSettingsService` 那个函数里
（可能被 `SAND_CLIENT_MODE_V1` + `SAND_MANAGED_LOCAL_ROUTE_V1` 覆盖了，
因为后者直接把 `checkFeatureGate` 短路成 `{runtime:"managed-local",reason:"sand-client"}`）。

**如果实测 Sand 功能正常，说明 `ELIGIBILITY_PREFIXES` 已是历史残留，可以删除该项
（连同 `stats.eligibility` 与 `LEGACY_SAND_ELIGIBILITY_MARKER` 的迁移逻辑一起清理）——
这属于允许的"优化"。如果不正常，需要重新定位 3.18.9 的资格判定函数。**

v126 相对 v125 的实质改进（这些是**已解决**的问题，不要再作为待办列出）：

- `SAND_MANAGED_ACTION_ROUTE_V1`：把 managed-local 放行的 action 从 `userMessageAction`
  扩到 `["userMessageAction","summarizeAction","resumeAction","backgroundTaskCompletionAction"]`
  ——`/summarize`、resume、后台完成回灌不再在路由层就被判 `action-not-supported`；
- `SAND_SUBAGENT_RESUME_AGENT_MODE_V1`：`resumeAgentId && mode===UNSPECIFIED && !readonly`
  时把 mode 归一到 `AGENT` 而非 `UNSPECIFIED`，修掉 resume 出来的子代理没有工具权限；
- `SAND_SUBAGENT_COMPLETION_WAKE_V1`：把 `source==="subagent"` 加进唤醒条件，
  后台子代理完成能唤醒父会话；
- `taskToolProps.subagentModels.modelsBySlug` 从 `new Map` 变成 `new Map([[i,{slug:i}]])`
  ——至少父模型自身在目录里，Task 工具不再因为空目录而拒绝所有 model 参数。

v126 仍存在的限制（**这些才是第一部分的待办**）：

- `isModelValid:e=>e===i` 把子代理模型钉死为父模型。注意：官方 local provider
  （`cursor-agent-exec/dist/main.js:Lge`、`cursor-local-agent-runtime/dist/main.js:HHt`）
  这一项本来就是 `isModelValid:()=>!0`，**这条限制是本项目自己加的**；
- `subagentModels.modelsBySlug` 只有父模型一项，官方是从 `e.availableModels` 全量构造：

  ```js
  // 官方 Lge / HHt 内联函数
  const n = {};
  for (const r of e.availableModels ?? []) if (r.modelId) n[r.modelId] = { slug: r.modelId };
  n[e.modelId] = { slug: e.modelId };
  ```

- `normalizeCustomSubagents:()=>[]` 清空自定义子代理，官方是 `e=>e`（恒等）；
- `getTaskToolConfig:async()=>({})` 返回空对象。官方返回三件套：

  ```js
  getTaskToolConfig: async (modelId) => {
    const modelInfo = Kde(modelId);
    const o = await cge({ modelId, localProvider: r, userAgent, customHeaders });
    return { agentConfig: Age({...e, modelId, modelInfo, contextLength: o.contextLength}),
             promptSession: o.promptToolSession,
             summarizationHandler: new $a(o.promptSession) };
  }
  ```

  消费方 `675.js:1766987` 直接解构 `const {agentConfig:P, promptSession:B, summarizationHandler:J} = f;`
  ——返回空对象会让这三个变量全 `undefined`。这是子代理生命周期不完整的**直接根因**；

- 官方还有 `modelInfo`、`enableExploreSubagent:!0`、`subagentModelOverrides.explore`
  （用 `Ude("grok-4.5", …)` 解析 explore 子代理的默认模型），v126 全缺；
- `supportsSelfSummary:!1` 关闭自摘要（注意：走 direct 注入时上游不会给 `run_ready`，
  这个值只能自己定；置 `!0` 而不实现 summary invocation 只会让 UI 走进更深的错误路径）；
- `finish:()=>Promise.resolve()` 无实际收尾；
- direct 注入在 `hre` 的 `function*(){` 之后立即 `return`，跳过整个 `RunInference` 握手。

关键锚点（v126 中的行号）：

- `_managed_task_tool_props()`：约 `450-472`；
- `_managed_task_tool_patched()` / `_v124` / `_v125`：约 `475-518`；
- `_direct_stream_injection()`：约 `521-560`；
- `DIRECT_STREAM_ANCHOR`（`"function hre(e){return t=>{return n=this,o=void 0,s=function*(){"`）：约 `434`；
- `MANAGED_ACTION_ROUTE_PATCHED`：约 `379-392`；
- `SUBAGENT_RESUME_MODE_PATCHED`：约 `394-401`；
- `SUBAGENT_COMPLETION_WAKE_RE`：约 `403-412`。


### 2.2 Grok Bot 本地安装和解包材料

已知安装位置：

```text
D:\Program Files\grokBot\Grok Bot
```

工作区中可分析的解包材料位于：

```text
E:\123\cursor2\_asar_tmp
```

`_asar_tmp/out/package.json` 显示：

```text
productName: Grok Bot
version: 0.30.0
main: dist/electron-main/main.cjs
```

目前能确认的 Grok Bot 运行时层包括：

- Electron 主进程（`dist/electron-main/main.cjs`，7.2 MB）；
- Renderer（`dist/renderer/assets/index-*.js`，4.3 MB）；
- agent coordinator（`dist/node-agent-coordinator/main.cjs`，512 KB）；
- local-exec daemon（`dist/local-exec-daemon/main.cjs`，3.5 MB）；
- preload（vnc / webview）；
- native deps（`cursor-proclist`、`tree-sitter*`）。

**这份材料能提供什么、不能提供什么，必须严格区分：**

能提供（已取证）：

- 鉴权头构造与 checksum 算法（§1.5）；
- Connect envelope 与 codec 选择（§1.6）；
- `x-cursor-client-type: "sand"`、`x-sand-box-namespace`、`x-ghost-mode`；
- `AvailableModelsRequest({useModelParameters:true, scope:USER_AVAILABLE})`；
- `SAND_DEFAULT_MODEL_ID = "grok-4.5"`；
- Sand box 生命周期（`GrokBotService.ensureSandBox` / `recreateSandBox`）；
- coordinator 的 `/api`、`/events`、`/health`、`/cancel` 与 `*.cursorvm.com` 拓扑。

**不能提供**（原计划的错误假设）：

- `InferenceService/Stream` 或 `RunInference` 的 request/response fixture
  —— bundle 里 0 处 `InferenceService`；
- 推理 frame 序列、tool call handshake、summary invocation 形状
  —— 这些发生在 Sand VM 内部，桌面端看不到；
- `promptSession` / `promptToolSession` 的实现
  —— 桌面端不构造这些对象。

要拿到推理协议的真实样本，唯一可行来源是 **Cursor 3.18.9 自己**（descriptor 见 §1.3，
运行时行为可在打上 v126 补丁后从 Cursor 侧观察）。

`_asar_tmp` 是 Grok Bot 0.30.0 的行为参考，不等于 Cursor 3.18.9 的原始 bundle。不能把一个版本的压缩变量名直接套到另一个版本。

### 2.3 `docker-composer-api` 当前状态

当前网关的主要链路是：

```text
OpenAI Chat / Responses / Anthropic Messages
    -> protocol.ts 合成 prompt
    -> CursorRunRequest
    -> CursorSdkRunner  (src/cursor-runner.ts, 1214 行)
    -> @cursor/sdk ^1.0.27  Agent.create/send/resume
    -> CursorStreamEvent
    -> SSE 或非流式响应
```

已有的模块（`src/`，共约 15k 行 TS，`node --test dist/tests/*.test.js`）：

```text
server.ts(1429) protocol.ts(1287) cursor-runner.ts(1214) proxy.ts(1070)
store.ts(1520) admin.ts(951) admin-ui.ts(1917) model-params.ts(617)
key-pool.ts(574) types.ts(564) routing.ts(325) usage-reconciler.ts(324)
executor-warmup.ts(364) models.ts(317) cursor-account.ts(289)
agent-store.ts(271) tool-compat.ts(247) key-rotating-runner.ts(242)
gateway-key-pool.ts(236) sand-client.ts(142) sand-client-header-loader.ts(82)
sdk-network.ts(151) errors.ts(142) auth.ts(136) gateway-settings.ts(131) …
```

可复用部分：

- OpenAI/Anthropic 对外协议解析（`protocol.ts`）；
- SSE 输出和错误封装（`sse.ts` / `errors.ts`）；
- `ModelIntent` 参数意图解析（`model-params.ts`，已有 `effort` / `thinking` / `context`
  / `maxMode` / `fast` 的完整语义映射，**这套代码可以直接产出
  `InferenceRequestedModel.parameters`，不需要重写**）；
- SQLite/WAL 和管理后台（`store.ts` / `admin*.ts`）；
- 鉴权、key 池、模型范围和日志（`auth.ts` / `key-pool.ts` / `gateway-key-pool.ts` / `routing.ts`）；
- 代理与网络层（`proxy.ts`，含 https/socks agent）；
- 超时、取消和连接断开处理。

不能直接复用为 Connect provider 实现的部分：

- `CursorSdkRunner` 的 Agent 生命周期；
- SDK 的 `Agent.create/send/resume`；
- `sand-client.ts` + `sand-client-header-loader.ts`
  —— 这两个文件的作用是用 ESM loader hook 把 SDK bundle 里硬编码的
  `x-cursor-client-type: "sdk"` 改写成运行时函数调用。**新的 Connect provider 自己构造 header，
  不需要这套 hook**；但要注意 `getCurrentCursorClientType()` 的 AsyncLocalStorage 语义
  （按请求切 client-type）在新 provider 里仍然有用，可以直接复用它的 ALS 部分；
- SDK custom tool 的 MCP wrapper；
- `Agent.getUsage()` 计费回查（Connect provider 从 `usage` / `extended_usage` frame 拿）；
- 以 SDK session 为中心的 `CursorRunRequest.prompt: string` 单字段模型。

当前网关的明确缺口：

- 没有 Connect 五字节 envelope 编解码；
- 没有 protobuf 运行时（`package.json` 里没有 `@bufbuild/protobuf`，且没有 `.proto` 文件）
  —— **这是 G1 之前必须先决策的事，见 §9 G1**；
- 没有增量 frame parser；
- 没有 session JWT 与 checksum 管理；
- `background` 目前只在 `protocol.ts:57/185/338` 三处作为 Responses 字段回显，
  没有任何 worker（全仓 grep `background` 只命中 admin-ui 的 CSS 和这三处）；
- 没有持久化 run/event/task 状态；
- `Task` 等宿主元工具被 `tool-compat.ts` 过滤（`:19` 注释：
  "Claude Code 宿主元工具不得进 customTools，否则内层会再演 MCP 发现或 Task 套娃"）；
- 没有工具、子代理和 summary 运行时。

---

## 3. 总体技术决策

### 3.1 两条路线共用一个"协议事实层"

Cursor 补丁和独立 API 不应各自猜测协议。事实层的来源已经确定，**不是 Grok Bot 抓包**：

```text
Cursor 3.18.9  657.js 模块 8844 / 4410 的 protobuf descriptor
    -> 从 descriptor 生成 .proto（字段号、kind、oneof、枚举值全部确定）
    -> 生成 TS 类型 + 序列化代码
    -> Connect codec 单元测试（半包 / 多帧 / 压缩 / endStream）
    -> Cursor 补丁的行为验收
    -> docker-composer-api 的 provider 验收
```

`descriptor → .proto` 是**机械转换**，不需要抓包，也不存在字段猜测。§1.3 已经把
两条推理路径全部消息的字段列全。剩下需要真实网络样本才能确定的只有：

- 服务端在什么情况下发哪些 oneof case，以及顺序（行为，不是结构）；
- `parameters` 里 `id` 的合法取值（`effort` 已确认，其余需从 `AvailableModels` 目录读）；
- 错误码与 HTTP status 的对应；
- `Stream` 与 `RunInference` 在同一账号下的可用性差异。

这些行为样本要从 **Cursor 3.18.9（打过 v126 补丁）** 侧采集，不是从 Grok Bot 侧。

fixture 至少包含：

- 普通文本（`text_part` 增量 + `is_final`）；
- thinking（`thinking_part`，含 `signature`）；
- 指定模型（`requested_model.model_id`）；
- effort/Max Mode（`parameters[{id:"effort"}]` / `max_mode`）；
- 工具调用（`tool_call_part` 的 streaming-start / delta / complete 三态）；
- 工具结果（`InferenceCoreMessage.tool_content`）；
- `usage` / `extended_usage` / `response_info`；
- `error`（8 种 `error_type`）；
- Connect endStream frame（`flags & 2`）；
- 半包、多帧合并、压缩帧；
- 走 `RunInference` 时：`run_ready` / `heartbeat` / `invocation_end`。

### 3.2 Cursor 补丁和独立 API 的职责不同

Cursor 补丁的目标：

```text
保留 Cursor 已有的 Agent UI、工具、Task、Transcript 和后台状态机，
让底层模型推理经由 managed-local 通道走 InferenceService/RunInference。
```

独立 API 的目标：

```text
不依赖 Cursor Desktop 文件，
由网关自己实现 InferenceService/Stream transport、任务状态、工具 loop、子代理和恢复能力。
```

不要试图用一个很小的 JS 注入同时解决所有问题。v126 的 direct 注入用一个手工对象替代了
`RunInference` 握手产物（`run_ready` 里的 `resolved_model` / `supports_self_summary` /
`prompt_model_metadata`），这是 summary 与子代理生命周期不完整的结构性原因。

### 3.3 推荐的长期结构

```text
对外 API / Cursor UI
        |
        v
统一的推理事件语义（text/thinking/toolCall/usage/error）
        |
        +-----------------------+
        |                       |
        v                       v
Cursor 客户端适配层         docker-composer-api
（JS patch, v126）          （CursorConnectProvider）
        |                       |
        v                       v
InferenceService/RunInference   InferenceService/Stream
（BiDiStreaming, HTTP/2）       （ServerStreaming）
        |                       |
        +-----------+-----------+
                    |
        同一套 InferenceStreamRequest / InferenceStreamResponse
```

两条路线端点不同但**载荷类型相同**，所以：

- message / tool / requestedModel 的构造代码可以共用一份 fixture 验证；
- 响应 frame 的 normalizer 逻辑可以共用一份实现；
- 只有 transport 层（单向 vs 双向）和握手（有无 `run_ready`）需要分开。

---

# 第一部分：继续修改 Cursor 补丁

## 4. Cursor 补丁的目标

最终目标不是"能发出一个 Grok 文本请求"，而是：

1. 普通对话实际经由 managed-local 走 `InferenceService`（`RunInference` 优先，direct 注入为备选）；
2. 工具调用能保留正确的 executor/resource；
3. 子代理可以指定独立模型；
4. 子代理可以指定独立 thinking effort；
5. `/summarize` 能完成并写回 transcript；
6. background task 断线后能继续；
7. resume 不重复工具调用、不丢事件；
8. 所有模型轮次都不切换到 `agent.v1.AgentService/Run`；
9. 补丁可验证、可卸载、可回滚；
10. Cursor 自动更新后能明确检测为"不匹配"，而不是假装成功。

## 5. Cursor 补丁实施阶段

### C0：锁定版本和建立可回滚基线

**当前已核实的环境状态**（不要再假设"目标机器上是干净基线"）：

```text
Cursor 安装位置:  D:\Program Files\cursor\resources\app
product.json:     version 3.18.9, commit 2ba48ff3f751, quality stable
当前 marker 数:   0（已确认为干净基线；先前观察到的一轮 marker 已被卸载/还原）
锚点校验:         isGenerateImageModelRestricted 处 taskToolProps:void 0  ✓ 原始
                  function hre(e){...function*(){const n=yield function(e,t){  ✓ 原始
安装包:           E:\123\cursor2\CursorSetup-x64-3.18.9.exe（可重装）
```

执行步骤：

1. 完全退出 Cursor 和 Grok Bot，确认没有残留后台进程。
2. **先跑 v126 的 `--status`（或 uninstall）确认 marker 数为 0。** 如果非 0，
   先卸载再建基线；如果卸载失败或 hash 不匹配，用 `CursorSetup-x64-3.18.9.exe` 重装。
3. 复制一份干净 Cursor 安装目录作为基线。
4. 保存 `product.json` + 5 个目标文件的 SHA-256：

   ```text
   out/vs/workbench/workbench.desktop.main.js
   extensions/cursor-agent-host/dist/main.js
   extensions/cursor-agent-host/dist/657.js
   extensions/cursor-agent-host/dist/675.js
   product.json
   ```

5. 确认实际 Cursor 版本，不要只相信脚本中的 `SUPPORTED_CURSOR_VERSION`
   （v126 已实现该校验：`:2188` `if layout.version != SUPPORTED_CURSOR_VERSION` → 拒绝）。
6. 记录旧版本 marker，避免 `V1`/`V2` 混装。v126 已能识别 `SAND_MANAGED_TASK_TOOL_V1`
   的 v124/v125 两种变体并迁移（`_managed_task_tool_patched_v124/_v125`），
   但仍要在装前记录，装后核对。
7. 为每次实验建立独立目录：

```text
baseline-clean/
candidate-runinference/
candidate-task-config/
candidate-summary/
```

验收条件：

- 能把整个 Cursor app 恢复到原始 SHA-256；
- 装前 marker 数 = 0；装后按 §2.1 表格逐项核对（注意 `SAND_CLIENT_MODE_V1` 有 8 处，
  `SAND_ELIGIBILITY_MODE_V1` 在 3.18.9 上为 0 处），不要用单一总数判定；
- 未知版本会拒绝修改。

### C1：以 Cursor 3.18.9 descriptor 为准建立协议事实层

**不要试图从 Grok Bot 抓 Stream fixture** —— §1.4 已证明它不调用 `InferenceService`。
协议事实全部来自 Cursor 自己的 descriptor（`657.js` 模块 8844 定义消息、模块 4410 定义 service）。

已经确定、无需再取证的部分（§1.3 全文）：

- service 与 method：`Stream`(ServerStreaming) / `RunInference`(BiDiStreaming)；
- `InferenceStreamRequest` 12 个字段及字段号；
- `InferenceStreamResponse` 10 个 oneof case 及字段号；
- `InferenceRequestedModel` / `InferenceModelParameterValue` / `InferenceCoreMessage`
  / `InferenceAgentTool` / `InferenceToolCall` / `InferenceToolResultPart`
  / `InferenceThinkingStreamPart` / `InferenceToolCallStreamPart` / `InferenceStreamError` 等全部字段；
- 4 个枚举的数值；
- `RunInference*` 全部 client/server 帧。

鉴权层（§1.5、§1.6）：

- `x-cursor-checksum` 算法（XOR 链 + base64url 无 padding + machineId[/macMachineId]）；
- `x-cursor-client-type` / `x-cursor-client-version` / `x-cursor-streaming`；
- Connect envelope 与 `flags` 位定义（`1`=compressed，`2`=endStream）；
- `application/connect+proto` 是客户端默认（`useBinaryFormat:!0`）。

**仍需从真实流量取证的（只有行为，不含结构）：**

1. 同一账号下 `Stream` 与 `RunInference` 的可用性差异；
2. 服务端发送 oneof case 的实际顺序（`invocation_id` 先于 `text_part`？`usage` 在 `response_info` 前后？）；
3. `parameters[].id` 的完整合法集合（`effort` 已确认；`thinking`、`context` 等要从
   `AvailableModelsResponse.AvailableModel.parameter_definitions`(field 29) 读）；
4. `error_type` 与 HTTP status / Connect code 的映射；
5. 半包与压缩帧在真实网络下的出现频率（影响 parser 的测试权重，不影响正确性）。

采集方法：在打过 v126 补丁的 Cursor 上跑真实对话，从 agent-host 的
`agenticComposerTransport` 出站侧观察。不要用 `probe_sand_grok.py` 的输出当 fixture ——
它的 header 名（`x-cursor-version`）和 base64 编码（标准表带 padding）都是错的，
且它一次性 `r.read()` 完整响应，没有增量语义。

修正 `probe_sand_grok.py`（作为烟雾测试仍有价值）：

```python
# 错：x-cursor-version                 → 对：x-cursor-client-version
# 错：base64.b64encode(bytes(arr))     → 对：base64.urlsafe_b64encode(bytes(arr)).rstrip(b"=")
# 错：总是拼 "/" + mac_id              → 对：mac_id 为空时不拼（与 Cursor 一致）
# 补：x-cursor-streaming: "true"
# 补：x-ghost-mode（按隐私模式：训练允许="false"，否则="true"）
```

验收条件：

- 由 descriptor 生成的 `.proto` 能被 protobuf 编译器接受，字段号与 657.js 逐条一致；
- 同一响应字节流拆成任意 chunk 边界，解析结果一致；
- `text_part` / `thinking_part` / `tool_call_part` / `error` / endStream 全部可识别；
- fixture 不含真实 token、machineId、macMachineId；
- 明确记录每个 fixture 用的是 `connect+proto` 还是 `connect+json`。

### C2：重写 direct 注入方式

v126 的 direct 注入位于 `sand_stream_installer_tools_fixed_v126.py:521-560`
（`_direct_stream_injection()`），插到 `hre` 的 `function*(){` 之后。它的结构是：

```text
createPromptSession = hre(inferenceClient)
    -> function*(){ 立即 return {
           promptSession:      new Joe(client, requestedModel, undefined, undefined).getSession()
           promptToolSession:  {getExecutor: e => new RK(s.getExecutor(e))}
           attempt: {
               resolvedModel:          cre(requestedModel)
               supportsSelfSummary:    false          ← 硬编码
               routedModelDisplayName: modelId        ← 用请求值冒充服务端解析值
               resolvedModelMetadata:  nre(手工推断的 vendor/promptVersion/isXxx, modelId)
               finish:                 () => Promise.resolve()   ← 空操作
           }}
```

被跳过的原生流程（`hre` 原文，`675.js:2407613` 起）：

```text
inferenceClient.runInference(writable, {signal, headers:{"x-request-id":attemptRequestId}})
  ├─ write  runRequest{conversationId, conversationGroupId, requestedModel,
  │                    routingConversation: Xoe(action), agentMode: pre(action)}
  ├─ await  runReady  →  resolvedModel / supportsSelfSummary
  │                      routedModelDisplayName / promptModelMetadata   ← 服务端权威值
  ├─ 每轮   invokeModel{invocationId, request: <InferenceStreamRequest 去掉 run 级字段>}
  │         ← invocationResponse{invocationId, response}  推进对应 invocation 的队列
  │         ← invocationEnd{invocationId, error?}         结束该 invocation
  ├─ 取消   cancelInvocation{invocationId}
  └─ finish write finishRun{} → close() → 等 reader 退出（5s 超时，wj 包装）
```

注意 direct 注入产出的对象与原生产出的对象**字段名不同**：

```text
原生 hre 返回:  {resolvedModel, supportsSelfSummary, routedModelDisplayName,
                promptModelMetadata, inferenceClient, finish}
                ↓ 由 675.js:2413792 的包装层转成
                {resolvedModel, supportsSelfSummary, routedModelDisplayName,
                 resolvedModelMetadata: nre(promptModelMetadata, resolvedModel.modelId), finish}

v126 直接产出:  {resolvedModel, supportsSelfSummary, routedModelDisplayName,
                resolvedModelMetadata, finish}
```

v126 是对的——它跳过了包装层，所以直接给最终形状 `resolvedModelMetadata`。
下游 `675.js:2384152` 读的正是 `S.attempt.resolvedModelMetadata`，
`675.js:2417988` 的 `Ere` 在 `resolvedModelMetadata === undefined` 时抛 `metadata-unavailable`。
**这一点不要"修正"，改成 `promptModelMetadata` 会直接崩。**

正确方向：

#### 优先方案：保留 `runInference` 握手，只替换 transport 目标

1. 不动 `hre`，让它照原样跑 `runRequest → runReady`；
2. 在 `657.js` 的 transport 层做替换：
   `_overrideMethodNameToTransportMap[InferenceService.methods.runInference.name]`
   已经指向 `agenticComposerTransport`，只需保证该 transport 的 `baseUrl` 与鉴权头正确；
3. 保留上层 Agent、PromptSession、Task、Summary、Transcript 和 executor 创建流程；
4. 不在 `hre` 开头返回不完整对象。

前提：`RunInference` 必须真的可用（账号有资格 + HTTP/2 双向流可建立）。
`RunInference` **没有 SSE/poll 回退**（§1.2），HTTP/2 不通就完全不可用。
这一点必须先验证，否则优先方案不成立。

#### 备选方案：保留 direct 注入，补全生命周期

如果 `RunInference` 在目标账号上不可用，才继续用 direct 注入。此时必须补全：

- `finish()`：真正释放 `Joe`/`Qoe`/`Koe` 持有的资源，不是 `Promise.resolve()`；
- `supportsSelfSummary`：由 `AvailableModels` 目录或本地策略决定，并同步实现 summary invocation；
- 每次 `Koe.stream()` 的 abort 传播与 `invocationId` 生成（原生用
  `e.get($oe)` 取 requestId、`crypto.randomUUID()` 兜底 invocationId）；
- `resolvedModelMetadata` 的 `vendor` / `promptVersion` / `reasoningEffort` 用目录值而非字符串 includes 推断
  （现在 `i.includes("grok") ? "xai" : …` 对新模型 slug 会静默落到 `"unknown"`，
  而 `ore()` 里 `Zoe.find` 找不到 vendor 会返回 `undefined`，进而触发 `metadata-unavailable`）。

最低代码修复（避免崩溃，不等于完成）：

- `n.parameters.map(...)`：`requestedModel.parameters` 在 proto3 里是 repeated，
  protobuf-es 会给 `[]` 而不是 `undefined`，所以这一条实际不会崩。但若上层传入的是
  plain object 而非 Message 实例，则会。加 `(n.parameters ?? [])` 是零成本的保险；
- 缺 `requestedModel` 时已有明确 throw（v126 已实现）；
- Stream 结束、取消和异常都必须释放资源；
- summary/background action 现在已由 `SAND_MANAGED_ACTION_ROUTE_V1` 放行（v126 已实现），
  不要再重复加。

验收条件：

- 普通消息仍能输出；
- `/summarize` 不再出现“调用后立即终止”；
- `finish()` 之后 transcript 和任务状态一致；
- 不再出现假完成、空 200 或未关闭的 Stream。

### C3：保留并验证 Agent Host 执行器拓扑

`_ref_oxen` 对 `move_exec` 和 `undefined.execute` 的定位仍有价值。

执行步骤：

1. 保留当前版本中与目标 Cursor bundle 匹配的 `move_exec` 修复。
2. 确认 Agent Host 和 agent-host-exec 使用同源 resource token。
3. 检查 `657.js`、`675.js` 和 `agent-host/dist/main.js` 的版本匹配。
4. 验证 Read/Shell/Grep/Glob 的 executor lookup。
5. 检查工具调用是否在取消和重试后释放 executor。

验收条件：

- 不出现 `undefined.execute`；
- 工具调用不会执行两次；
- tool call 与 tool result 的 ID 一致；
- Stream 断开时 executor 能回收。

### C4：恢复真正的 Task 子代理模型选择

v126 的 `_managed_task_tool_props()`（`:450-472`）只能实现同模型客户端子代理。
**必须先纠正一个此前写错的判断：这些限制不是"官方的限制"，而是本项目补丁自己加的。**

官方 local provider 的对照（`cursor-agent-exec/dist/main.js:Lge` @2860368
与 `cursor-local-agent-runtime/dist/main.js:HHt` @8546200，两者实现一致）：

| 字段 | 官方值 | v126 值 | 需要动？ |
|---|---|---|---|
| `isModelValid` | `()=>!0` | `e=>e===i` | **要改**，改成 `()=>!0` |
| `isModelBlocked` | `()=>!1` | `()=>!1` | 一致 |
| `requiresMaxMode` | `()=>!1` | `()=>!1` | 一致 |
| `compareModelCosts` | `()=>0` | `()=>0` | 一致 |
| `requireServerSideSubagent` | `!1` | `!1` | 一致 |
| `subagentModelForcePolicy` | `H9` = `"none"` | `"none"` | **一致**（已核实 `H9="none"`） |
| `normalizeCustomSubagents` | `e=>e` | `()=>[]` | **要改**，改成 `e=>e` |
| `subagentModels` | `$9(o, t)` 从 `availableModels` 全量构造 | `{modelsBySlug:new Map([[i,{slug:i}]])}` | **要改** |
| `getTaskToolConfig` | 返回 `{agentConfig, promptSession, summarizationHandler}` | `async()=>({})` | **要改**（最关键） |
| `modelInfo` | `e.modelInfo` | 缺 | **要加** |
| `enableExploreSubagent` | `!0` | 缺 | 要加 |
| `subagentModelOverrides` | `{explore: …}` | 缺 | 可选 |
| `parentRequestedModelName` | `e.modelId` | `i` | 一致（`i` 就是 modelId） |
| `parentModelParameters` | `e.parentModelParameters` | `e.requestedModel.parameters` | 一致 |

`useClientSideSubagent` 不在 `taskToolProps` 里，而在 `featureFlags` 上
（v126 通过 `SAND_MANAGED_SUBAGENT_SESSION_V1` 注入到 `Cre` 常量表）。
`675.js:1728724` 的 `F1` 读的是 `s.useClientSideSubagent` 与 `s.requireServerSideSubagent`，
计算 `j = Boolean(useClientSideSubagent) && !requireServerSideSubagent`。
`j === true` 走客户端子代理分支（`675.js:1759033`–`1766082`），
`j === false` 走服务端分支（从 `1766193` 起）。

**关键发现：`getTaskToolConfig` 的返回值只在服务端分支被消费。**
`675.js:1766193` 处：

```js
const {prepared: m, taskToolConfig: f} = await ne(t, k, c, C, S);
…
const {agentConfig: P, promptSession: B, summarizationHandler: J} = f;   // @1766987
```

而 `675.js:1757213` 的另一处 `await ne(...)` 只解构 `{prepared: c}`，不取 `taskToolConfig`。
所以当 `useClientSideSubagent:!0` 时，`getTaskToolConfig:async()=>({})` 返回空对象**不会**
立刻报错——它压根没被解构。这解释了为什么 v126 的客户端子代理能跑起来。

但代价是：**客户端子代理路径不使用 `promptSession`/`summarizationHandler`，
所以子代理没有自己的 summary 能力，且模型选择完全依赖 `subagentModels.modelsBySlug`
这张只有一项的表。** 这才是"子代理不能换模型"的真正机制。

#### 需要修改的（按影响排序）

1. `subagentModels.modelsBySlug`：从可用模型目录全量构造。
   官方是两步：先把 `availableModels` 转成 `{slug: {slug}}` 的普通对象，
   再用 `$9()` 转成 `{modelsBySlug: Map}`：

   ```js
   // 内联函数：availableModels → {[modelId]: {slug: modelId}}
   function(e){ const n={};
     for (const r of e.availableModels ?? []) if (r.modelId) n[r.modelId] = {slug: r.modelId};
     n[e.modelId] = {slug: e.modelId}; return n; }
   // $9：普通对象 → {modelsBySlug: Map}，可按 isModelBlocked 过滤
   function $9(e, t){ const n = new Map();
     for (const r of Object.values(e)) t?.(r.slug) || n.set(r.slug, r);
     return { modelsBySlug: n }; }
   ```

   在 675.js 的注入点上，`e.availableModels` 不一定存在（那是 provider 层的入参）。
   需要先确认注入点作用域里能拿到什么。若拿不到，退而求其次：
   从 workbench 侧的模型目录服务经 IPC 取，或在 `taskToolProps` 里放一个惰性 getter
   （`subagentModels` 是被读取的属性，可以用 getter 延迟到首次访问时再构造）。

2. `isModelValid: ()=>!0`（与官方对齐）。注意这一项单独改**不够**：
   `675.js` 的模型解析路径是先在 `modelsBySlug` 里查 slug，查不到就回落父模型，
   `isModelValid` 只是二次校验。所以 1 和 2 必须一起改。

3. `getTaskToolConfig`：即使当前走客户端分支不消费它，也应返回可用值，
   否则一旦 `useClientSideSubagent` 被关掉（或未来 Cursor 改变分支条件）就会
   `undefined` 解构崩溃。最小可用实现需要 `agentConfig` / `promptSession` /
   `summarizationHandler` 三者，而 `promptSession` 只能从 `hre` 的产物里拿——
   这与 C2 的备选方案强耦合。

4. `normalizeCustomSubagents: e=>e`：恢复自定义子代理透传。

5. 补 `modelInfo` 与 `enableExploreSubagent:!0`。

#### 不需要改的（此前误列为"待删除限制"）

- `compareModelCosts:()=>0` —— 官方就是这样，不是限制；
- `requireServerSideSubagent:!1` —— 官方就是 `!1`；这是"不强制服务端"，
  与 `useClientSideSubagent:!0` 配合才让 `j=true`，是本方案的**前提而非障碍**；
- `isModelBlocked:()=>!1`、`requiresMaxMode:()=>!1` —— 与官方一致。

#### 子代理模型请求的真实构造路径

不是手工拼 JSON。`675.js:1762821` 处，客户端子代理通过 executor 下发：

```js
v = await a.execute(t, new CP.Pwd({
      toolCallId: c.toolCallId,
      subagentType: x,
      modelId: M,                                    // ← resolvedModelId
      modelParameters: O?.map(e => ({id:e.id, value:e.value})),   // ← resolvedModelParameters
      credentials: R,
      prompt: k.prompt,
      readonly: l,
      resumeAgentId: G ? undefined : $,
      forkAgentId: G ? d : undefined,
      interrupt: (!(!W || k.interrupt !== !0)) || undefined,
      runInBackground: h,
      continuationConfig: i,
      rootParentConversationId: u,
      parentConversationId: …
    }));
```

`M`（`resolvedModelId`）和 `O`（`resolvedModelParameters`）来自 `675.js:1758076` 的解构，
由上游的模型解析逻辑产出——那里读的就是 `subagentModels.modelsBySlug`。
所以**改对 `modelsBySlug` 就能让 `M`/`O` 变成子代理自己的值**，
不需要在补丁里手工构造 `InferenceRequestedModel`。

验收条件：

- 主模型 A、子代理指定模型 B 时，`Pwd.modelId` 实际为 B（而非 A）；
- 主模型 medium、子代理 high 时，`Pwd.modelParameters` 里 `effort` 值不同；
- 子代理参数不会被主会话覆盖；
- 不同子代理之间不共享同一个 parameters 数组引用；
- 每个 child 的模型轮次仍在 `InferenceService` 上（不落到 `AgentService/Run`）；
- `parentAgentToolCallId`、`rootParentConversationId`、`parentConversationId` 可关联。

### C5：实现 `/summarize` 生命周期

**v126 已经解决了路由层的阻塞**：`SAND_MANAGED_ACTION_ROUTE_V1` 把 `summarizeAction`
加进了放行列表，`/summarize` 不再在 `657.js` 的资格判定处被判 `action-not-supported`。
剩下的问题在能力声明与 invocation 上。

`supportsSelfSummary` 的三个来源：

```text
1. RunInference 的 run_ready 帧    RunInferenceRunReady.supports_self_summary (field 2)
2. Stream 的响应尾部              InferenceResponseInfo.supports_self_summary (field 7, optional)
3. v126 的 direct 注入            硬编码 !1
```

走优先方案（保留 `runInference` 握手）时，第 1 项自动生效，`supportsSelfSummary`
就是服务端的权威值，不需要补丁介入。**这是优先方案相对 direct 注入的最大收益。**

走备选方案（direct 注入）时，必须自己决定，并且：

1. 不能只把 `!1` 改成 `!0` —— 声明能力而不实现 summary invocation，
   会让 UI 走进"已请求摘要但永不返回"的更深错误路径；
2. summary 请求要用自己的 `invocation_id`；
3. summary 结束前不替换当前 transcript；
4. 成功后先写 summary/checkpoint，再更新 active context；
5. 失败时保留原 transcript 和旧 summary；
6. 工具未完成、后台子代理未完成时，summary 必须保留这些状态；
7. summary 的模型请求同样走 `InferenceService`（`Stream` 或 `RunInference`），
   不能落到 `AgentService/Run`。

`675.js:2384528` 显示上层如何消费：

```js
summaryConfig: { promptSession: S.promptToolSession, canUseSelfSummary: () => !0 }
```

注意这里 `canUseSelfSummary` 在该分支里已经是 `()=>!0`——说明上层在某些路径下
并不查 `attempt.supportsSelfSummary`。要先确认 `/summarize` 走的是哪条路径，
再决定改 `supportsSelfSummary` 是否真的有用。

验收条件：

- `/summarize` 完成后能继续对话；
- 摘要内容写入正确 conversation/transcript；
- summary 失败不损坏原对话；
- summary 请求仍在 `InferenceService` 上；
- 摘要期间的 tool/task 状态不丢失。

### C6：实现 background task 和 resume

**v126 已解决两处**：

- `SAND_MANAGED_ACTION_ROUTE_V1` 放行 `resumeAction` 与 `backgroundTaskCompletionAction`；
- `SAND_SUBAGENT_RESUME_AGENT_MODE_V1` 让 resume 出来的子代理 mode 归一到 `AGENT`
  而非 `UNSPECIFIED`（原本会导致 resume 后的子代理没有工具权限）；
- `SAND_SUBAGENT_COMPLETION_WAKE_V1` 让 `source==="subagent"` 也能唤醒父会话。

剩余工作是状态一致性。要对照的状态字段：

- `clientNonce` 与重发 nonce 的映射；
- `conversationId` / `conversationGroupId` / `rootParentConversationId`；
- `invocationId`（`RunInference` 下每轮一个，`Stream` 下每请求一个）；
- `taskId` / `toolCallId` / `parentAgentToolCallId`；
- `traceparent`（`Koe.stream()` 里从 OTel context 构造：
  `00-${traceId}-${spanId}-${flags}`，同时发 `x-backend-traceparent`）；
- ack outcome / `transport-down` / `connected`；
- transcript replica parity；
- event sequence。

最低状态机：

```text
created
  -> queued
  -> running
  -> awaiting_tool
  -> awaiting_child
  -> completed

任意非终态
  -> paused
  -> resuming
  -> running / completed / failed
```

恢复规则：

1. 同一逻辑任务保持稳定 `taskId` 和 `conversationId`；
2. 每次新的传输尝试使用新的 invocation/nonce；
3. 只重放未确认的事件；
4. 已执行的工具调用必须幂等；
5. 已确认的事件不能重复显示；
6. UI 关闭不能自动销毁后台任务；
7. **上游不支持 offset resume。** `InferenceStreamRequest` 里没有任何
   offset / cursor / resumeToken 字段（§1.3 的 12 个字段可逐条核对），
   `RunInferenceRunRequest` 也没有。所以只能从 transcript/checkpoint 重建请求；
8. 重建时必须防止重复副作用；
9. 恢复失败要进入明确的 failed/unknown 状态，而不是把对话标记为正常完成。

验收条件：

- 关闭 UI 后后台任务继续；
- 断网后能重连；
- 重连不重复执行 Shell/Write 等工具；
- 未确认事件最终可见；
- 任务完成后主会话可以继续；
- 进程重启后的恢复行为有明确结果，而不是永久卡在 running。

### C7：补丁管理和回滚

v126 已实现的安全机制（**不要重复实现**）：

- 版本白名单（`SUPPORTED_CURSOR_VERSION = "3.18.9"`，`:2188` 拒绝不匹配版本）；
- marker 唯一性与外部 marker 检测；
- 目标文件完整性校验（4 个 JS + `product.json`）；
- extension 内嵌 hash 与 `product.json` checksum 同步；
- 原子写入、安装前备份、卸载恢复、重复安装幂等；
- 旧 marker 迁移（`V1` → `V2`，含 v124/v125 两种 `taskToolProps` 变体）。

额外需要增加的状态检查（**按功能而非 marker 数量判定**）：

- `inferenceEndpoint`：报告当前是 `RunInference`（原生握手保留）还是 direct 注入；
- `taskModelCatalog`：`subagentModels.modelsBySlug` 的条目数（1 = 未修复，>1 = 已修复）；
- `taskToolConfig`：`getTaskToolConfig` 是否返回三件套而非 `{}`；
- `summaryCapability`：`supportsSelfSummary` 的来源（服务端 `run_ready` / 本地硬编码）；
- `actionRoute`：放行的 action 列表是否含 4 项。

不能只用 marker 数量宣称功能完成。marker 齐全（15 个）只说明"注入成功"，
不说明"功能可用"——v126 就是 marker 齐全但子代理换模型仍不可用的状态。

## 6. Cursor 补丁验证矩阵

每个候选版本都要在干净安装上测试：

| 场景 | 检查内容 | 通过标准 |
|---|---|---|
| 普通文本 | 出站 method、frame、文本顺序 | `InferenceService`（`RunInference` 或 `Stream`），文本完整 |
| thinking | `thinking_part` 帧、`parameters[effort]` | 参数实际出现在 `InferenceRequestedModel.parameters` |
| 工具 | executor、`tool_call_id` | 不出现 `undefined.execute` |
| 子代理同模型 | parent/child session | 子代理能结束并回传 |
| 子代理换模型 | `Pwd.modelId` | 子请求确实使用指定模型（不是父模型） |
| 子代理换 effort | `Pwd.modelParameters` | 不回落到默认 medium |
| `/summarize` | summary invocation、transcript | 完成后可以继续对话 |
| background | UI 关闭/断网 | 任务继续运行 |
| resume | nonce、ack、event seq、mode=AGENT | 不丢事件、不重复工具、子代理有工具权限 |
| 取消 | `cancelInvocation` / abort 传播 | 流与 executor 释放 |
| 升级检测 | 新版 Cursor | 明确拒绝，不误打补丁 |
| 卸载 | marker/hash | 恢复原始 SHA-256 |

硬失败条件：

- 任意推理轮次访问 `agent.v1.AgentService/Run`；
- 出站不带 `x-cursor-checksum` 或 checksum 编码错误（标准 base64 而非 base64url）；
- `thinking_part` 被拼进普通文本或直接丢失；
- 子代理请求没有独立 model/parameters；
- `/summarize` 直接返回完成但没有摘要；
- background resume 重复工具调用；
- `finish()` 是空操作且没有其他资源回收路径；
- 只改了 `supportsSelfSummary` 就宣称修复完成；
- 把 `resolvedModelMetadata` 改成 `promptModelMetadata`（会触发 `metadata-unavailable`）。

---

# 第二部分：在 docker-composer-api 上迭代独立 API

## 7. 独立 API 的目标

独立 API 的目标是：

1. 不修改 Cursor Desktop 文件；
2. 模型推理直接访问 `aiserver.v1.InferenceService/Stream`（ServerStreaming）；
3. 对外继续提供 OpenAI/Anthropic 兼容接口；
4. 支持指定模型和 thinking effort；
5. 支持工具调用；
6. 支持网关编排的子代理；
7. 支持 summary checkpoint；
8. 支持真正的 background task；
9. 支持断线重连和事件回放；
10. SDK 路线和 Connect 路线互不污染。

### 7.1 为什么网关选 `Stream` 而不是 `RunInference`

| 维度 | `Stream` (ServerStreaming) | `RunInference` (BiDiStreaming) |
|---|---|---|
| 传输要求 | 普通 HTTP POST + chunked/Connect 流 | 必须真正的双向流（HTTP/2） |
| 降级 | 可用普通 fetch + ReadableStream | **无 SSE/poll 回退**（§1.2 已核对映射表） |
| 与 HTTP 请求生命周期 | 1:1 对齐 `POST /v1/chat/completions` | 需要跨请求维持 run 会话 |
| undici/Node 支持 | `undici` 已在依赖里，直接可用 | 需 HTTP/2 client + 可写流双工 |
| 服务端路由协商 | 无 `run_ready`，模型解析结果不回传 | 有 `run_ready` |
| 载荷类型 | `InferenceStreamRequest/Response` | 同上（包在 `invokeModel`/`invocationResponse` 里） |

结论：**第一版走 `Stream`。** 代价是没有 `run_ready`，因此：

- `resolved_model` 未知 → 网关自己回显请求的 `model_id`；
- `supports_self_summary` 只能从响应尾部 `InferenceResponseInfo.supports_self_summary`(field 7) 读，
  是"事后"而非"事前"，summary 决策必须由网关自己做；
- `routed_model_display_name` 未知 → 用目录里的 `client_display_name`。

如果后续证明 `Stream` 在目标账号上不可用，再加 `RunInference` transport——
**因为载荷类型相同，届时只需换 transport 与握手，编解码代码 100% 复用**。

### 7.2 术语纠正

第一版的子代理是**网关编排的子代理（adapter-managed subagent）**，不是上游原生 Task。
`InferenceStreamRequest` 里没有任何 subagent/parentTask 字段（§1.3 可逐条核对），
上游原生 Task 语义存在于 Cursor 客户端的 `TASK` 工具与 agent-host executor 里，
不在推理协议层。网关只能自己维护 DAG。

同理，本文档统一不再使用"Grok Stream"这个说法——协议是 `aiserver.v1.InferenceService`，
与 Grok 模型无关，`grok-4.5` 只是 `model_id` 的一个取值（`SAND_DEFAULT_MODEL_ID`）。
命名统一为 `cursor-connect` / `CursorConnectProvider`。

## 8. 网关目标架构

保留现有 SDK provider，增加独立 Connect provider：

```text
Fastify API (server.ts)
    |
    v
ProviderRouter                        ← 新增，按 key 设置 / 模型前缀 / 显式 header 选路
    |
    +-- CursorSdkProvider             ← 现有 cursor-runner.ts 原样封装
    |       `-- @cursor/sdk Agent.create/send/resume
    |
    `-- CursorConnectProvider         ← 新增
            +-- proto/                    生成的 TS 消息类型（见 G1）
            +-- connect/envelope.ts       5 字节 envelope 编解码
            +-- connect/transport.ts      undici → 增量 envelope 流
            +-- connect/errors.ts         Connect code ↔ HTTP status ↔ 对外错误
            +-- credentials.ts            session JWT / machineId / checksum
            +-- headers.ts                §1.5 的完整头集合
            +-- request-builder.ts        PreparedConversation → InferenceStreamRequest
            +-- response-normalizer.ts    InferenceStreamResponse → 统一事件
            +-- catalog.ts                AvailableModels 缓存 + 参数定义
            +-- tool-loop.ts
            +-- subagent-scheduler.ts
            +-- summarizer.ts
            +-- background-worker.ts
            `-- event-store.ts            落库 + seq + Last-Event-ID 回放
```

Connect provider 不使用：

- `@cursor/sdk Agent.create/send`；
- `sand-client.ts` 的 ESM loader hook（但可复用它的 AsyncLocalStorage client-type 语义）；
- `agent.v1.AgentService/Run`；
- SDK 的 `Agent.resume()`。

## 9. 网关实施阶段

### G0：拆分 provider 抽象

先不要改坏现有 SDK 路线。现有 `CursorRunner` 接口（`types.ts:328`）是：

```ts
export interface CursorRunner {
  run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult>;
  stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent>;
}
```

`CursorStreamEvent`（`types.ts:306`）只有 4 个 case：

```ts
| { type: "text";      text: string }
| { type: "thinking";  text: string }
| { type: "tool_call"; toolCall: GatewayToolCall }
| { type: "done";      result: CursorRunResult }
```

**做法：不替换 `CursorRunner`，而是让 `CursorConnectProvider` 也实现它。**
这样现有 `server.ts` / `key-rotating-runner.ts` / SSE 输出层完全不动，
第一版（G1–G4，文本 + thinking + 模型/effort）就能端到端跑通，且不回归 SDK 路线。

`CursorStreamEvent` 需要扩的 case（用可选 union 成员，旧消费者忽略即可）：

```ts
| { type: "usage";     usage: RequestUsage }          // 从 usage/extended_usage frame
| { type: "error";     error: InferenceStreamErrorLike }  // 从 error frame，含 error_type
| { type: "response_info"; id: string; model: string; supportsSelfSummary?: boolean }
```

只有到 G6（tool loop 需要"提交 result 后继续同一 run"）和 G9（background/replay）
才真正需要新的 provider 接口。到那时再引入：

```ts
export interface InferenceProvider extends CursorRunner {
  listModels(cred: CredentialRef): Promise<GatewayModel[]>;
  startRun(req: PreparedConversation): Promise<{ runId: string }>;
  streamEvents(runId: string, fromSeq?: number): AsyncIterable<UnifiedEvent>;
  submitToolResult(runId: string, result: ToolResultInput): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}
```

不要在 G0 就把这套接口写出来——现在还不知道 tool loop 的真实约束，
提前定接口会导致 G6 推翻重写。

### G1：protobuf 运行时与 Connect envelope

**这一步必须先做一个决策，此前的计划遗漏了它。**

现状：`docker-composer-api/package.json` 依赖只有
`@cursor/sdk`、`fastify`、`https-proxy-agent`、`socks`、`socks-proxy-agent`、`undici`。
**没有 protobuf 运行时**，仓库里也没有 `.proto` 文件。

三个选项：

| 方案 | 依赖 | 优点 | 缺点 |
|---|---|---|---|
| A. `connect+json` + 手写 TS 类型 | 0 新依赖 | 最快出第一版，可读性好，便于调试 | JSON 与 proto 在 int64/Struct/bytes/oneof 上表示不同；服务端 JSON 支持程度未验证；`InferenceToolCall.args` 是 `google.protobuf.Struct`，JSON 表示需手工处理 |
| B. `@bufbuild/protobuf` + 从 descriptor 生成 `.proto` | +1 依赖 | 与客户端 `useBinaryFormat:!0` 完全一致，最不容易踩坑 | 需要 descriptor → `.proto` 的转换工作 |
| C. `@connectrpc/connect` + `@connectrpc/connect-node` | +2 依赖 | envelope/压缩/错误映射全部现成 | 引入完整 Connect 客户端栈，与现有 undici + proxy.ts 的代理配置需要打通 |

**建议 B**：只加 `@bufbuild/protobuf`，自己写 envelope（就 30 行）和 transport
（复用现有 `proxy.ts` 的 agent 配置）。理由：

- 客户端实际发的是 `application/connect+proto`，跟着走风险最小；
- envelope 逻辑已在 §1.6 逐字取证，自己写完全可控且可单测；
- 不引入 `@connectrpc/connect-node`，避免它自己的 http2/agent 逻辑与 `proxy.ts` 冲突
  （现有网关的代理、SOCKS、超时都在 `proxy.ts` 里，Connect 客户端栈会绕过它）。

A 可以作为**调试模式**保留（`CONNECT_CODEC=json` 环境变量），但不作为默认。

`.proto` 的生成方式：从 `657.js` 模块 8844 的 `newFieldList` 机械转换。
§1.3 已给出全部字段与字段号，转换脚本只需处理 kind 映射：

```text
kind:"scalar", T:9  → string      T:8  → bool     T:5  → int32
                T:1  → double     T:2  → float    T:3  → int64
                T:13 → uint32     T:12 → bytes
kind:"message", T:X → 对应 message
kind:"enum",  T:getEnumType(X) → 对应 enum
kind:"map", K:9, V:{kind:"message",T:X} → map<string, X>
opt:!0 → optional          repeated:!0 → repeated
oneof:"name" → oneof name { … }
T:a.Struct → google.protobuf.Struct     T:a.Value → google.protobuf.Value
```

新增文件：

```text
src/cursor-connect/proto/inference.proto      从 descriptor 生成
src/cursor-connect/proto/inference_pb.ts      protoc-gen-es 输出
src/cursor-connect/connect/envelope.ts
src/cursor-connect/connect/transport.ts
src/cursor-connect/connect/errors.ts
```

envelope 实现要点（对照 §1.6 的原文逻辑）：

```text
写：  flags = compressed ? 1 : 0
      [flags:u8][len:u32be][payload]
      压缩阈值：客户端在 payload >= compressMinBytes 时才压（默认 1024，Jir=1024）

读：  增量缓冲，先凑满 5 字节 header，再凑满 len 字节 payload
      (flags & 1) === 1  → 先解压，然后 flags ^= 1
      (flags & 2) === 2  → payload 是 EndStreamResponse(JSON)：{metadata?, error?}
      否则               → payload 是 InferenceStreamResponse
```

必须实现：

- 增量解析（半包 header / 半包 payload / 一个 chunk 内多帧 / 帧跨多 chunk）；
- `readMaxBytes` 上限（客户端默认 `0xFFFFFFFF`，网关应设小得多的值，
  如 32 MB，并在超限时抛 `ResourceExhausted` 而不是分配内存）；
- gzip + br 解压（Node 内建 `zlib`，与客户端 `acceptCompression:[gzip, br]` 对齐）；
- `AbortSignal` 触发时销毁底层 socket；
- HTTP status 与 Connect code 的区分：
  Connect 的流式响应即使有错也可能是 HTTP 200 + endStream frame 里带 error，
  必须两条路径都处理；
- endStream frame 里的 `error.code` 是 Connect code 字符串（如 `"unauthenticated"`），
  要映射成对外的 OpenAI/Anthropic 错误。

测试必须用多种 chunk 切分方式回放同一 fixture（1 字节一切、随机切、整帧切、超大帧）。

验收条件：

- 生成的 `inference_pb.ts` 字段号与 `657.js` 逐条一致（可写一个对照测试，
  把 `657.js` 的 `newFieldList` 文本解析出来跟生成结果比）；
- 同一字节流任意切分，解析结果一致；
- 压缩帧、endStream 帧、错误帧全部可识别；
- 超长 length 不导致内存分配，抛 `ResourceExhausted`；
- abort 后底层 socket 立即释放。

### G2：credentials 和 headers

新增：

```text
src/cursor-connect/credentials.ts
src/cursor-connect/checksum.ts
src/cursor-connect/headers.ts
```

#### checksum 的正确实现（此前探针里的三处错误已定位）

```ts
// 与 workbench.desktop.main.js:AJg / Grok Bot:nw 完全一致
function xorChain(buf: Uint8Array): Uint8Array {
  let e = 165;
  for (let i = 0; i < buf.length; i++) { buf[i] = (buf[i] ^ e) + i % 256; e = buf[i]; }
  return buf;
}

export function cursorChecksum(machineId: string, macMachineId?: string): string {
  const t = Math.floor(Date.now() / 1e6);          // 注意是 1e6 不是 1e3
  const b = new Uint8Array([t>>40&255, t>>32&255, t>>24&255, t>>16&255, t>>8&255, t&255]);
  const p = Buffer.from(xorChain(b)).toString("base64url");   // base64url，Node 自动不带 padding
  return macMachineId ? `${p}${machineId}/${macMachineId}` : `${p}${machineId}`;
}
```

三处必须修正（对照 `probe_sand_grok.py:57-65`）：

| 项 | 探针 | 正确 |
|---|---|---|
| 编码 | `base64.b64encode` → 标准表 + `=` padding | `base64url` 无 padding（`iT(buf,!1,!0)`） |
| 版本头名 | `x-cursor-version` | `x-cursor-client-version` |
| 尾部拼接 | `mac_id` 存在就拼 | 与客户端一致：`macMachineId === undefined` 时不拼 |

#### header 集合（按 §1.5 取证，分必需/推荐/可选）

必需：

```text
authorization:            Bearer <session JWT>
content-type:             application/connect+proto   （或 +json 调试模式）
connect-protocol-version: 1
x-cursor-checksum:        <上面的算法>
x-cursor-client-type:     sand          （Grok Bot 的 W6 常量值）
x-cursor-client-version:  <版本串>
x-request-id:             <uuid>
```

推荐（Cursor 桌面端实际会发，缺失可能被判为异常客户端）：

```text
x-cursor-streaming:         true
x-ghost-mode:               true | false   （隐私模式：训练允许 → "false"，否则 "true"）
x-cursor-client-os:         win32 | darwin | linux
x-cursor-client-arch:       x64 | arm64
x-cursor-client-device-type: desktop
x-cursor-client-os-version: <版本>
x-cursor-timezone:          <IANA tz>
x-client-key:               <hex>
x-session-id:               <uuid>
x-new-onboarding-completed: true | false
x-amzn-trace-id:            Root=<requestId>
```

可选（有 team 时才发）：

```text
x-cursor-team-id: <数字>
```

**不要发**：`x-sand-box-namespace`（Grok Bot 专用于 sandbox 路由，网关不需要）、
`x-cursor-client-commit`（仅 Anysphere 内部账号）、
`x-inference-authentication-jwt` / `x-cursor-workload*`（Grok Bot 的 inference proxy 上下文）。

`Connect-Accept-Encoding: gzip, br` 与 `Connect-Content-Encoding: gzip`
按实际压缩情况发（envelope 层已经处理，见 G1）。

#### 凭据模型

凭据不能直接复用现有 `CURSOR_API_KEYS` 表——SDK 路线用的是 SDK key，
Connect 路线需要的是 session JWT + 设备元数据。

建议保存（`cc_credentials` 表，字段见 §9 G10）：

- credential id / label；
- 加密后的 session token + token type + 过期时间；
- machineId / macMachineId（**两者都要，且要与实际发的 checksum 一致**）；
- clientVersion / clientOs / clientArch / deviceType / osVersion / timezone；
- clientKey / sessionId；
- status / lastError / failureCount / lastUsedAt；
- allowedModels / excludedModels。

**设备标识一致性是硬约束**：同一 credential 的 machineId 在整个生命周期内不能变，
否则服务端会把它当成不同设备。不要每次请求随机生成。

部署方式优先级：

1. Docker secret；
2. 外部 secret manager；
3. 权限受限的加密配置；
4. 最后才是本地数据库。

禁止：

- 把 JWT 写入普通请求日志（现有 `store.ts` 的 `RequestLogRecord` 要确认不落 header）；
- 把 token 放入错误消息；
- 把 token 或完整 machineId 写入测试 fixture；
- 把浏览器 web token 当成 session token（`probe_sand_grok.py:68` 的 `jwt_type()`
  就是在查这个，保留该校验）；
- 随意拼接未经验证的 header。

### G3：Connect client 与请求构造

新增：

```text
src/cursor-connect/client.ts
src/cursor-connect/request-builder.ts
src/cursor-connect/response-normalizer.ts
```

请求端点：

```text
POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream
```

`baseUrl` 必须可配置（Grok Bot 的 `hn()` 就是从配置读的），不能硬编码。

#### 请求构造（字段名用 proto 的 snake_case，JSON 模式用 camelCase）

以下是**按 descriptor 确定的形状，不是猜测**：

```text
InferenceStreamRequest {
  messages: [
    { role: SYSTEM(4),    text: "<system prompt>" },        // 可选，见下
    { role: USER(1),      text: "<用户消息>" },
    { role: ASSISTANT(2), text: "<助手消息>",
                          tool_calls: [{tool_call_id, tool_name, args:<Struct>}],
                          reasoning_parts: [{is_redacted:false, text, signature?}] },
    { role: TOOL(3),      tool_content: {parts: [{tool_call_id, tool_name,
                                                  result:<Value>, is_error}]} }
  ]
  tools: [{name, description, parameters:<Struct>, custom_tool_format?}]
  requested_model: { model_id, max_mode, parameters:[{id,value}],
                     built_in_model, is_variant_string_representation }
  model_id: "<同 requested_model.model_id>"
  conversation_id: "<uuid，同一对话稳定>"
  conversation_group_id: "<可选>"
  invocation_id: "<uuid，每次请求新生成>"
  model_config: { max_tokens?, temperature?, top_p?, stop_sequences[] }   // 可选
  inference_reason: <仅 GEMINI_VIDEO_SUBAGENT(1) 有意义，一般不发>
}
```

要点：

- `role` 是枚举**数值**：`UNSPECIFIED=0, USER=1, ASSISTANT=2, TOOL=3, SYSTEM=4`。
  探针里 `"role": 1` 恰好对（USER），但没有覆盖其他角色。
  **`SYSTEM=4` 的存在意味着不需要把 system prompt 塞进 user 消息**——
  这是相对现有 `protocol.ts` 合成单一 prompt 字符串的实质改进；
- `content` 是 oneof（`text` / `parts` / `tool_content`），
  **不能同时设**。纯文本用 `text`（field 2），带图片/文件用 `parts`（field 3），
  工具结果用 `tool_content`（field 6）；
- `tool_calls`（field 4）与 `content` 不是 oneof，可以共存
  （assistant 消息既有文本又有工具调用）；
- `args` 是 `google.protobuf.Struct`，不是 JSON 字符串。
  但流式响应里 `InferenceToolCallStreamPart.args` **是 string**（field 3, T:9）——
  两处类型不同，不要混；
- `reasoning_parts` 用于把上一轮的 thinking 回传（Anthropic 的 signature 保留），
  `signature` 存在时必须原样带回，否则会破坏 extended thinking 的连续性；
- `built_in_model`：内置模型为 `true`。BYOK/自定义模型为 `false`；
- `is_variant_string_representation`：当 `model_id` 是 `gpt-5.5@1m:high` 这类
  变体串形式时为 `true`。现有 `model-params.ts:158` 已经在解析这种语法，
  要决定是"解析成 parameters" 还是"原样传 + 置该标志"。**优先前者**，
  因为 parameters 是结构化的，服务端不需要再解析。

#### 响应 normalizer

必须处理全部 10 个 oneof case（§1.3），映射到扩展后的 `CursorStreamEvent`：

| frame | 处理 |
|---|---|
| `text_part` | `is_final ? finish : {type:"text", text}` —— 注意 `is_final=true` 的帧 `text` 可能为空，此时**只发结束不发文本** |
| `thinking_part` | `{type:"thinking", text}`；`signature` 单独记录，回传时要用 |
| `tool_call_part` | 三态：`tool_name && !is_complete` → streaming-start；`!tool_name` → args delta；`is_complete` → 完整 tool call（`args` 是 JSON string，需 `JSON.parse` 且要 try/catch，客户端原文就是 catch 后置 `{}`） |
| `usage` | `{prompt_tokens, completion_tokens, total_tokens?}` → `RequestUsage` |
| `extended_usage` | 更详细的用量，写日志与计费 |
| `response_info` | `{id, model, created_at, messages[], error_message?, supports_self_summary?}` —— **这里的 `messages` 是服务端回传的完整消息，可用于下一轮上下文，比自己拼更可靠** |
| `provider_metadata` | 记日志 |
| `invocation_id` | 服务端确认的 invocation id，与请求里的对比 |
| `error` | `{message, code, is_input_token_limit_error, is_output_token_limit_error, error_type}` → 按 `error_type` 映射（8 种，见 §1.3） |
| `image_descriptions` | 图片描述回填，第一版可只记录 |

`error_type` → 对外错误的映射：

```text
INPUT_TOKEN_LIMIT / OUTPUT_TOKEN_LIMIT → 400 context_length_exceeded
RATE_LIMIT                              → 429 rate_limit_error
AUTHENTICATION                          → 401 authentication_error
PERMISSION                              → 403 permission_error
OVERLOADED                              → 529 / 503 overloaded_error
CONTENT_FILTER                          → 400 content_policy_violation
UNKNOWN / UNSPECIFIED                   → 500 api_error
```

未知 frame（新版本加的 case）不应静默丢失：记录 case 名与 payload 长度，
payload 本身脱敏。**不要因为遇到未知 case 就中断流**。

验收条件：

- 文本、thinking、tool call 三类内容都能端到端出现在对外 SSE；
- `is_final` 的空 `text_part` 不产生空文本块；
- tool call 的 `args` 累积正确（streaming delta 拼接后能 parse）；
- 8 种 `error_type` 各有对应的对外错误码；
- 未知 case 只记日志不中断。

### G4：模型目录和参数

新增：

```text
src/cursor-connect/catalog.ts
```

**不新增 `model-params.ts`** —— 现有 `src/model-params.ts`（617 行）已经实现了完整的
参数意图解析，包括：

```text
ModelIntent { reasoningEffort, maxMode, fast, modelParams }
enumDef("effort", ["low","medium","high"])        // :122
boolDef("thinking")                              // :104
变体串语法 gpt-5.5@1m:high#fast=false            // :158
claude-opus-4-8[thinking=true,context=1m,effort=xhigh]
Anthropic thinking budget → effort 等级           // :334
maxMode 与 fast 的互斥降级                        // :423-436
"跟随模型默认强度"的软等级                         // :512
```

这套代码的输出就是 `ModelParameterValue[]`（`types.ts:123`：`{id, value}`），
**与 `InferenceModelParameterValue` 的字段完全一致**（§1.3：`1 id string, 2 value string`）。
所以 G4 只需要做映射，不需要重写参数逻辑：

```ts
// request-builder.ts
requested_model: new InferenceRequestedModel({
  modelId: identity.canonicalId,
  maxMode: intent.maxMode ?? false,
  parameters: resolvedParams.map(p => new InferenceModelParameterValue({id: p.id, value: p.value})),
  builtInModel: !identity.isByok,
  isVariantStringRepresentation: false          // 因为我们已经解析成 parameters 了
})
```

#### 模型目录

数据源：`aiserver.v1.AiService/AvailableModels`（Unary），与推理同一个 backend。
Grok Bot 的调用方式已取证：

```js
// electron-main/main.cjs: fetchSandAvailableModels
new AvailableModelsRequest({ useModelParameters: true, scope: AvailableModelsScope.USER_AVAILABLE })
```

`AvailableModelsRequest` 的可用字段（descriptor 已确认）：

```text
 1 is_nightly                              8 variants_will_be_shown_in_exploded_list?
 2 include_long_context_models             9 for_automations?
 3 exclude_max_named_models               10 scope?              ← Grok Bot 用 USER_AVAILABLE
 4 additional_model_names[]               11 use_react_model_picker?
 5 use_model_parameters?  ← Grok Bot 置 true  12 use_cloud_agent_effort_modes?
 6 include_hidden_models?                 13 admin_settings_group_public_id?
 7 do_not_use_markdown?                   14 byok_enabled?
```

`AvailableModelsResponse.AvailableModel` 的关键字段（共 34+ 个，摘取对网关有用的）：

```text
 1 name                                   ← 模型 slug（即 model_id）
 2 default_on                            18 server_model_name?
 5 supports_agent?                        17 client_display_name?
 9 supports_thinking?                     24 inputbox_short_model_name?
10 supports_images?                       15 context_token_limit?
14 supports_max_mode?                     16 context_token_limit_for_max_mode?
19 supports_non_max_mode?                 12 auto_context_max_tokens?
22 supports_plan_mode?                    13 auto_context_extended_max_tokens?
26 supports_cmd_k?                         7 price?
27 only_supports_cmd_k?                    6 degradation_status?  (UNSPECIFIED/DEGRADED/DISABLED)
29 parameter_definitions[]   ← **参数 ID 与值域的权威来源**
30 variants[]                             33 cloud_migrate_to_model?
32 cloud_agent_effort_mode?               34 upgrade_model_id?
```

**field 29 `parameter_definitions` 解决了此前"参数 ID 只能猜"的问题** ——
不需要 fixture，直接从目录读。现有 `model-params.ts` 里 `enumDef`/`boolDef` 的硬编码定义
（`:79-122` 那段注释说"claude 系全型号都有 thinking；effort/context 仅新型号有"）
应改为**以目录为准、硬编码为 fallback**。

响应还有 feature-specific 配置：

```text
 4 composer_model_config       ← 对话默认模型
 5 cmd_k_model_config
 6 background_composer_model_config
 7 plan_execution_model_config
16 subagent_model_configs   map<string, FeatureModelConfig>   ← 子代理默认模型（G7 会用）
```

流程：

1. 用 `AvailableModels(useModelParameters:true, scope:USER_AVAILABLE)` 拉目录；
2. 按 credential 缓存（不同账号可见模型不同），TTL + 手动刷新；
3. 缓存 `name` / `client_display_name` / `parameter_definitions` / `variants`
   / `supports_*` / `context_token_limit*` / `degradation_status`；
4. 请求的模型不在目录里 → 触发一次受限刷新（带速率限制），仍不在则 404；
5. **不硬编码模型名**。`grok-4.5`（`SAND_DEFAULT_MODEL_ID`）只作为
   目录不可用时的最后 fallback，且要明确标记为降级状态；
6. `degradation_status === DISABLED` 的模型不对外暴露；
   `DEGRADED` 暴露但在 `/v1/models` 里标注。

验收条件：

- `/v1/models` 的列表来自目录而非硬编码；
- 主请求可指定模型，参数从 `parameter_definitions` 校验；
- 不同请求的 `parameters` 数组不共享引用（现有 `model-params.ts` 已注意此点，要保持）；
- 请求未指定 effort 时，不主动塞默认值（让服务端用模型默认，
  而不是网关替它决定 medium）；
- 目录不可用时有明确降级路径与日志，不静默回落到过期缓存。

### G5：复用对外协议，保留结构化上下文

现有 `protocol.ts`（1287 行）可以继续承担：

- OpenAI Chat / Responses 解析；
- Anthropic Messages 解析；
- 对外错误格式与 SSE。

**但 `CursorRunRequest.prompt: string`（`types.ts:264`）是单字段合成 prompt，
对 Connect provider 不够用。** 原因：`InferenceCoreMessage` 是结构化的，
有 `role`（含 `SYSTEM=4`）、`tool_calls`、`reasoning_parts`、`tool_content`，
合成成一个字符串会丢掉全部结构。

新增 `PreparedConversation`，与 `CursorRunRequest` 并存（不替换）：

```ts
export interface PreparedConversation {
  /** 结构化消息，直接对应 InferenceCoreMessage[] */
  messages: PreparedMessage[];
  /** system/developer 指令单独保留，映射到 role=SYSTEM(4) */
  systemInstructions: string[];
  /** 工具定义，映射到 InferenceAgentTool[] */
  tools: GatewayTool[];
  /** 会话级标识 */
  conversationId: string;
  conversationGroupId?: string;
  /** 本轮 invocation */
  invocationId: string;
  /** 上一轮的 thinking signature，回传时必须原样带上 */
  reasoningSignatures?: Map<string, string>;
  /** summary checkpoint 引用 */
  summaryId?: string;
  /** parent/child（G7） */
  parentRunId?: string;
  parentToolCallId?: string;
}
```

保留 `CursorRunRequest.prompt` 给 SDK 路线用；Connect 路线走 `PreparedConversation`。
`protocol.ts` 里增加一个 `toPreparedConversation()`，与现有 `toPreparedRequest()` 并列，
共用同一份入站解析结果。

**system prompt 处理的实质改进**：现有 `system-prompt.ts`（50 行）有
`off/append/override` 三种模式，把 system 内容拼进 prompt 字符串。
Connect 路线应改为发 `role=SYSTEM` 的独立消息 —— 这不只是更干净，
还避免了 prompt cache 失效（system 内容变动不再污染整个 prompt 前缀）。

### G6：工具调用

分三步实现。

#### G6.1 外部调用方工具（第一版做这个）

协议侧已确认可行（§1.3）：

```text
出： InferenceStreamRequest.tools[] = [{name, description, parameters:<Struct>}]
回： InferenceStreamResponse.tool_call_part = {tool_call_id, tool_name,
                                              args(string), is_complete, tool_index?}
再出：InferenceCoreMessage{role:TOOL(3),
        tool_content:{parts:[{tool_call_id, tool_name, result:<Value>, is_error}]}}
```

三态解析（客户端 `675.js:2400458` 原文的逻辑，照抄即可）：

```js
if (is_complete)      { args = JSON.parse(argsStr) /* catch → {} */; → tool-call }
else if (tool_name)   { → tool-call-streaming-start }
else                  { → tool-call-delta (argsTextDelta = args) }
```

流程：

1. 上游返回结构化 tool call；
2. 网关落库 `tool_call_id` + 累积的 args；
3. 对外按 OpenAI/Anthropic 格式返回工具调用；
4. 调用方提交 tool result；
5. 网关校验 result 属于该 run 且 `tool_call_id` 存在；
6. **以新的 `invocation_id` 发起新的 `Stream` 请求**，
   messages 里追加 assistant(tool_calls) + tool(tool_content)；
7. 重复提交同一个 result 幂等（用 `(run_id, tool_call_id)` 唯一约束）。

注意第 6 步：走 `Stream` 时每一轮工具循环都是**一个新的 HTTP 请求**，
`conversation_id` 保持不变，`invocation_id` 每次新生成。
这与 `RunInference` 的"一条连接上多个 `invokeModel`"不同，
但从服务端看应该等价（同一个 conversation 下的多次推理）。**这一点需要实测确认**——
如果服务端依赖 invocation 之间的连接级状态，`Stream` 路线的工具循环就不成立，
届时必须切到 `RunInference`。**这是第二部分最大的单点风险，应在 P2 最先验证。**

建议端点：

```text
POST /v1/cursor-connect/runs/:id/tool-results
```

对 OpenAI 兼容路径，调用方本来就是在下一次 `POST /v1/chat/completions` 里
带上完整历史（含 tool 消息），所以这个专用端点只服务于 background/durable 场景（G9）。
**第一版可以先不做这个端点**：无状态的 OpenAI 风格工具循环已经够用。

#### G6.2 网关本地工具

默认关闭。需要：

- allowlist；
- JSON Schema 校验（`InferenceAgentTool.parameters` 是 Struct，需自己校验）；
- workspace containment + symlink 防逃逸；
- 超时、取消、资源限制；
- 审批策略、输出截断、审计日志。

不能让模型直接获得 Docker 宿主机权限。

#### G6.3 上游原生工具

`InferenceStreamRequest.provider_defined_tools`（field 3）
= `InferenceNamedProviderDefinedTool{name, id, type, options:<Struct>}`
是上游预置工具的入口（如 web search、image generation）。

但**具体 `type` 取值与 `options` schema 未取证**，且 Cursor 客户端侧的
`webSearch` / `generateImage` 都是本地 executor 实现（`675.js` 里
`bre(t,{modelId:i})` / `Tre(t,{modelId:i,maxMode:l})`），不走 provider-defined tool。
所以这一项优先级最低，等有真实样本再做。

`accepted_unadvertised_tool_names`（field 9）用于声明"我接受这些没在 tools 里声明的工具"，
这是 Cursor 客户端处理内置工具的机制。网关暂不需要。

### G7：网关编排子代理（adapter-managed subagent）

新增：

```text
src/cursor-connect/subagent-scheduler.ts
src/cursor-connect/task-worker.ts
src/cursor-connect/tool-loop.ts
```

**协议层面没有子代理概念**（§7.2）：`InferenceStreamRequest` 的 12 个字段里
没有 subagent / parentTask / taskId。`conversation_group_id`（field 12）是唯一
可能用于关联的字段，但它的语义在客户端是"同一组对话"（`675.js` 里
`conversationGroupId ?? conversationId`），不是父子关系。

所以网关的子代理完全是自己实现的：向模型暴露一个 `Task` 工具，
模型调用它时网关起一个新的 run。

```text
parent run (conversation_id: C1, invocation_id: I1)
    |
    `-- tool_call_part{tool_call_id: T1, tool_name: "Task", args:{prompt, model?, ...}}
            |
            `-- child run (conversation_id: C2, invocation_id: I2)
                    |    parent_run_id = <parent>, parent_tool_call_id = T1
                    `-- 完成后把结果作为 T1 的 tool result 回灌 parent
```

注意与现有 `tool-compat.ts:19` 的冲突：那里明确过滤掉 `Task`
（"Claude Code 宿主元工具不得进 customTools，否则内层会再演 MCP 发现或 Task 套娃"）。
G7 要引入网关自己的 `Task` 工具时，必须：

- 用不同的工具名（如 `spawn_subagent`）避免与客户端宿主的 `Task` 撞名；
- 或保留过滤，只在 Connect provider 内部注入，不透传调用方声明的 `Task`。

**建议后者**：过滤规则不动，网关在 `tools[]` 里追加自己的子代理工具。

每个 child 必须拥有：

- child task ID / run ID；
- child `conversation_id`（**新的，不复用父的**）；
- child `invocation_id`；
- `requested_model` + `parameters`（可与父不同，这是子代理的核心价值）；
- parent run ID + parent tool call ID；
- status / event sequence / cancellation linkage。

子代理默认模型可以从目录读：`AvailableModelsResponse.subagent_model_configs`
（field 16, `map<string, FeatureModelConfig>`）就是服务端给的子代理模型配置。

限制：

- 最大深度（建议 2，即 parent → child，不允许 child 再 spawn）；
- 最大子任务数量（单 parent 与全局各一个上限）；
- 单租户并发；
- 总 token/时间预算（用 `usage` frame 累计）；
- 父任务取消传播（parent abort → 所有 child abort）；
- 子任务循环检测（child 的 prompt 与 parent 相同时拒绝）；
- 模型 allow/deny scope（复用现有 `ModelScope`，`types.ts:91`）；
- 工具权限隔离（child 默认不继承 parent 的本地工具）。

第一版称为 `adapter-managed subagent`，不是上游原生 subagent。

### G8：summary checkpoint

新增：

```text
src/cursor-connect/summarizer.ts
```

**协议层面 summary 也不是独立能力**：没有 `SummarizeRequest`，
没有 summary 专用字段。summary 就是"用一个特殊 prompt 发一次普通推理"。

唯一相关的协议字段是 `InferenceResponseInfo.supports_self_summary`（field 7, optional）
——服务端在响应尾部告知"这个模型支持自摘要"。走 `Stream` 时这是**事后**信息，
所以第一版的 summary 决策由网关自己做，不依赖它。
（对比：`RunInference` 的 `run_ready.supports_self_summary` 是事前信息。）

summary 规则：

1. 显式 `/summarize`（或对外 API 的等价入口）或达到上下文阈值时触发；
2. 用**独立的 `invocation_id`** 发一次推理，`conversation_id` 保持不变；
3. 生成 summary checkpoint，记录覆盖到的事件序号；
4. 保留未完成工具和子代理状态（不能因为摘要就丢掉 pending tool call）；
5. summary 成功后才更新 active context；
6. 失败时继续使用旧 checkpoint；
7. 原始事件不能删除（只标记为"已被 summary 覆盖"）。

阈值判断的数据源：`AvailableModel.context_token_limit`(field 15) /
`context_token_limit_for_max_mode`(field 16)，加上 `usage.prompt_tokens` 的实际值。
不要用字符长度估算。

建议 summary 记录：

```text
summary_id
conversation_id
run_id                  ← 产生该 summary 的 run
covered_through_seq     ← 覆盖到哪个事件序号
summary_text
summary_model           ← 用哪个模型做的摘要（可与主模型不同）
summary_parameters_json
source_hash             ← 被摘要的消息序列的 hash，用于检测重复摘要
created_at
```

### G9：真正的 background、resume 和 SSE replay

现状：`background` 只在 `protocol.ts:57/185/338` 三处作为 Responses 字段回显，
没有 worker。要做成真的：

```text
POST /v1/responses  (background:true)
    -> 落库 run，状态 queued
    -> 立即返回 response id（status: queued）
    -> worker 取 lease，跑推理
    -> 每个事件先落库（分配 seq）再推送
    -> GET 查询 或 SSE 订阅（支持 Last-Event-ID）
```

新增端点：

```text
GET  /v1/cursor-connect/runs/:id
GET  /v1/cursor-connect/runs/:id/events        （SSE，支持 Last-Event-ID）
POST /v1/cursor-connect/runs/:id/resume
POST /v1/cursor-connect/runs/:id/cancel
POST /v1/cursor-connect/runs/:id/tool-results
POST /v1/cursor-connect/runs/:id/summarize
```

同时保持 OpenAI Responses 的 `GET /v1/responses/:id` 兼容
（现有 `store.ts` 的 `StoredResponse` 已有骨架，`types.ts:333`）。

SSE 规则：

1. 事件先落库，再发送（崩溃后不丢已发事件）；
2. 网关自己生成单调递增 `seq`（不依赖上游）；
3. 支持 `Last-Event-ID`；
4. 先补发缺失事件，再订阅 live stream（注意补发与 live 之间的竞态：
   要在同一事务里取"补发上界"和"订阅起点"）；
5. 终态事件幂等（重复投递 `run.completed` 不重复触发下游）；
6. 客户端断开不取消 background worker；
7. worker 重启后通过 lease 恢复 queued/paused 任务（lease 超时后可被其他 worker 接管）。

必须区分三种"恢复"：

```text
客户端重新连接
    = 重放网关已落库的事件         ← 完全可控，必须实现

网关 worker 重启
    = 从 DB 恢复任务状态并续跑     ← 完全可控，必须实现

上游断点续传
    = 不存在                      ← 已确认，见下
```

**上游不支持断点续传，这是已确认的结论而非"未证明"**：
`InferenceStreamRequest` 的 12 个字段（§1.3）里没有 offset / cursor / resume token；
`RunInferenceRunRequest` 的 5 个字段也没有。所以上游连接断掉后，唯一做法是
**从 transcript/checkpoint 重建一个新请求**。

重建的安全规则：

- 已完整收到 `response_info` 的 run：视为完成，不重跑；
- 收到部分 `text_part` 但无终止帧：文本已部分交付给客户端，重跑会重复输出。
  应标记 `partial_delivered`，重跑时对外声明"重试导致内容可能重复"，
  或（更安全）直接标记 `unknown` 让调用方决定；
- 有 pending tool call（`tool_call_part` 已完整但 result 未提交）：
  重建时带上已有的 tool call，等 result，不重发推理；
- 有已执行的、有副作用的本地工具（G6.2）：**绝不自动重跑**，标记 `unknown`。

### G10：数据库设计

现有 SQLite（`store.ts`，1520 行，WAL 模式）继续使用，新增 Connect 专用表。
表名前缀统一用 `cc_`（cursor-connect），避免与现有表混淆。

#### `cc_credentials`

```text
id
label
encrypted_session_token
token_type              ← 从 JWT 的 type claim 读，拒绝 web token
expires_at
machine_id              ← 生命周期内不可变
mac_machine_id          ← 可为 NULL（此时 checksum 不拼 "/"）
client_version
client_os
client_arch
client_os_version
device_type
client_key
session_id
timezone
status
allowed_models
excluded_models
failure_count
last_used_at
last_error
created_at
updated_at
```

#### `cc_conversations`

```text
id
owner_hash
upstream_conversation_id     ← 发给上游的 conversation_id（uuid，同一对话稳定）
upstream_conversation_group_id
default_model
default_parameters_json
sticky_credential_id         ← 会话粘性（复用现有 stickyKey 思路）
latest_summary_id
latest_event_seq
status
created_at
updated_at
```

#### `cc_runs`

```text
id
conversation_id
parent_run_id                ← 子代理（G7）
parent_tool_call_id
upstream_invocation_id       ← 每次尝试新生成
requested_model
resolved_model               ← 走 Stream 时从 response_info.model 回填，走 RunInference 时从 run_ready
parameters_json
background
status                       ← queued/running/awaiting_tool/awaiting_child/paused/completed/failed/cancelled/unknown
attempt
delivery_state               ← none/partial_delivered/complete（决定重跑是否安全，见 G9）
last_event_seq
usage_json                   ← 从 usage / extended_usage frame 累计
error_json
lease_owner
lease_until
started_at
finished_at
```

`delivery_state` 是 G9 重建安全规则的落地字段，原设计的
`last_upstream_frame_seq` 没有意义——上游不给 frame 序号，
且即使自己数也无法用于续传（协议无 offset 字段）。

#### `cc_events`

```text
run_id
seq                          ← 网关自己生成，单调递增
event_id                     ← 对外暴露给 Last-Event-ID
event_type
payload_json
upstream_case                ← InferenceStreamResponse 的 oneof case 名，便于排查
created_at
```

约束：

```text
UNIQUE(run_id, seq)
UNIQUE(run_id, event_id)
INDEX (run_id, seq)          ← Last-Event-ID 补发用
```

#### `cc_tool_calls`

```text
run_id
call_id                      ← 上游给的 tool_call_id
tool_name
arguments_json               ← streaming delta 累积完成后的完整 args
tool_index                   ← tool_call_part.tool_index，用于并行工具调用排序
status                       ← streaming/complete/submitted/failed
result_json
is_error
parent_call_id
idempotency_key
requested_at
completed_at
```

约束：`UNIQUE(run_id, call_id)` —— 这是 tool result 幂等的实现基础。

#### `cc_tasks`

```text
task_id
run_id
parent_task_id
task_type
status
depth                        ← 深度上限校验
requested_model
parameters_json
lease_owner
lease_until
retry_count
next_run_at
created_at
updated_at
```

#### `cc_summaries`

```text
id
conversation_id
run_id
covered_through_seq
summary_text
summary_json
model
parameters_json
source_hash                  ← 被摘要消息序列的 hash，防重复摘要
created_at
```

### G11：事件统一模型

内部统一事件格式：

```json
{
  "version": 1,
  "event_id": "evt_xxx",
  "run_id": "run_xxx",
  "conversation_id": "conv_xxx",
  "seq": 42,
  "type": "text.delta",
  "attempt": 1,
  "upstream_case": "textPart",
  "payload": {}
}
```

事件类型（按来源分组，标注哪些有上游 frame 支撑、哪些是网关自造）：

```text
# 网关自造（协议里没有对应帧）
run.accepted            ← 收到 HTTP 请求，落库
run.started             ← worker 取到 lease，开始发上游请求
run.paused / run.resumed
run.cancelled
task.created / task.started / task.awaiting_tool / task.awaiting_child / task.completed
summary.started
tool.result.accepted

# 有上游 frame 支撑
text.delta              ← text_part (is_final=false)
text.final              ← text_part (is_final=true)
thinking.delta          ← thinking_part
thinking.signature      ← thinking_part.signature
tool.call.start         ← tool_call_part (tool_name && !is_complete)
tool.call.delta         ← tool_call_part (!tool_name)
tool.call.complete      ← tool_call_part (is_complete)
usage                   ← usage
usage.extended          ← extended_usage
provider.metadata       ← provider_metadata
invocation.confirmed    ← invocation_id
image.descriptions      ← image_descriptions
run.completed           ← response_info（无 error_message）
run.failed              ← error 或 response_info.error_message 或 endStream.error
summary.completed       ← summary run 的 response_info
```

明确区分这两类很重要：**网关自造的事件在上游重跑后可以重新生成，
有上游 frame 支撑的事件重跑后可能不同**（模型输出不确定），
这直接决定 G9 的重放策略。

这样现有 OpenAI Responses、Chat SSE 和 Anthropic SSE 可以分别把统一事件转换成各自 wire format。

## 10. 独立 API 的分阶段验收

### P0：协议事实层

交付：

- `inference.proto`（从 657.js descriptor 生成）+ 生成的 TS 类型；
- 字段号对照测试（解析 657.js 的 `newFieldList` 与生成结果比对）；
- envelope 编解码 + 多种 chunk 切分测试；
- checksum 实现 + 与 Cursor/Grok Bot 算法一致性测试（同一时间戳同一输入，输出相同）；
- header 构造 + 脱敏日志测试；
- text/thinking/toolCall/error/endStream 的合成 fixture（不需要真实流量就能构造）。

验收：

- parser 对任意 chunk 切分结果一致；
- fixture 里没有真实凭据；
- 端点与 method 严格为 `POST /aiserver.v1.InferenceService/Stream`；
- checksum 是 base64url 无 padding。

### P1：文本和 thinking

交付：

- `CursorConnectClient`（envelope + transport + 复用 `proxy.ts` 的 agent）；
- `CursorConnectProvider`（实现现有 `CursorRunner` 接口，见 G0）；
- model catalog（`AvailableModels`）；
- `model-params.ts` → `InferenceModelParameterValue[]` 的映射；
- 复用现有 OpenAI/Anthropic 输出转换。

验收：

- 目录里的有效模型能生成文本（**不预设是 `grok-4.6` 还是别的**，
  以目录实际返回为准）；
- `requested_model.model_id` 确实是请求的模型；
- `thinking_part` 不丢，`signature` 被记录；
- `parameters[{id:"effort"}]` 确实出现在请求里；
- system 消息走 `role=SYSTEM(4)` 而不是拼进 user 文本；
- 任何请求都不访问 `agent.v1.AgentService/Run`；
- 现有 SDK 路线的测试全部仍通过（`npm test`）。

### P2：工具 loop

**先验证最大风险点**：连续两次 `Stream` 请求（同 `conversation_id`、
不同 `invocation_id`、第二次 messages 里带 assistant tool_calls + tool result）
上游是否正确接续。如果不行，说明 `Stream` 不支持无状态工具循环，
必须切 `RunInference`——**这个结论会推翻 §7.1 的路线选择，所以要最先做**。

交付：

- tool call 三态 parser（streaming-start / delta / complete）；
- args 累积与 `JSON.parse` 容错；
- `cc_tool_calls` 落库 + `UNIQUE(run_id, call_id)` 幂等；
- tool result 回灌（`InferenceCoreMessage{role:TOOL, tool_content}`）；
- 并行工具调用（`tool_index`）排序；
- 取消传播。

验收：

- 工具参数不丢（delta 拼接后能 parse）；
- `tool_call_id` 稳定，回灌时一致；
- 重复提交同一 result 不重复推理；
- 并行工具调用的结果按 `tool_index` 正确对应；
- 无状态工具循环在上游确实接续（或明确记录"不接续，已切 RunInference"）。

### P3：子代理

交付：

- task DAG；
- child run；
- child model/parameters；
- 父子取消；
- 深度/并发限制。

验收：

- 主模型 A、子代理模型 B；
- 子代理 high effort；
- 子代理使用独立 conversation/invocation；
- 父子状态可追踪；
- 子代理失败不会让父任务永久 running。

### P4：summary

交付：

- summary trigger；
- summary provider；
- checkpoint；
- 上下文重建。

验收：

- summary 完成后继续对话；
- 原始事件保留；
- summary 失败不破坏会话；
- tool/task 状态被保留。

### P5：background/resume

交付：

- worker；
- lease；
- event store；
- `Last-Event-ID`；
- status/resume/cancel API；
- worker 崩溃恢复。

验收：

- HTTP 连接关闭后任务继续；
- SSE 重连只补发缺失事件；
- worker 重启后 queued/paused 任务可恢复；
- 未确认的工具不会盲目重复；
- 终态幂等。

### P6：双 provider 灰度

交付：

- provider router（按 key 设置 / 模型前缀 / 显式 header 选路）；
- provider 独立日志（现有 `RequestLogRecord` 加 `provider` 字段）；
- Connect credential 管理（后台 CRUD + 连通性测试）；
- 管理后台能力显示（哪条路线支持什么）；
- health/connectivity test。

验收：

- SDK 路线原有测试全部仍通过；
- Connect 路线只访问 `aiserver.v1.InferenceService`；
- 一条路线的 key、重试和错误不会污染另一条
  （现有 `key-rotating-runner.ts` 的轮换逻辑要按 provider 隔离）；
- API 返回的 capability 与实际能力一致（不声明未实现的能力）。

---

## 11. 推荐实际执行顺序

### 第一阶段：建立协议事实层（不改任何运行中的东西）

1. 从 `657.js` 模块 8844 的 `newFieldList` 生成 `inference.proto`；
2. 生成 TS 类型，写字段号对照测试；
3. 实现 envelope 编解码 + checksum，写单元测试；
4. 用合成 fixture 验证 parser（不需要真实流量）；
5. 修正 `probe_sand_grok.py` 的三处错误（header 名、base64url、尾部拼接），
   跑一次真实烟雾测试确认端点可达。

这一阶段**不修改 Cursor 安装文件，不实现 Task，不动 docker-composer-api 现有代码**。
产出是一个独立的 `cursor-connect-proto/` 目录，两条路线都能引用。

已确认的环境前提：Cursor `3.18.9` / commit `2ba48ff3f751`，当前 marker 数 0（干净基线），
`CursorSetup-x64-3.18.9.exe` 在手可重装。

### 第二阶段：在 docker-composer-api 实现 Connect provider（文本层）

原因：

- TypeScript 代码更容易单元测试；
- 可以用 fixture 测 parser；
- 可以独立验证指定模型和 effort；
- 不会反复修改 Cursor 安装目录；
- 可以提前建立 durable task/event 数据模型。

顺序：

```text
protobuf 运行时决策（G1，建议 @bufbuild/protobuf）
-> envelope + transport
-> credentials + headers
-> catalog（AvailableModels）
-> request-builder（复用 model-params.ts）
-> response-normalizer
-> 实现现有 CursorRunner 接口，接进 server.ts
```

**关键：第二阶段结束时不新增任何接口抽象**，`CursorConnectProvider` 直接实现
现有 `CursorRunner`，这样 SDK 路线零改动、对外 SSE 零改动。

不要一开始就实现工具、子代理、background。

### 第三阶段：验证工具循环可行性（决定路线的分水岭）

这一步单独列出来，因为它可能推翻第二阶段的路线选择：

1. 用 Connect provider 发一次带 `tools[]` 的请求，确认能收到 `tool_call_part`；
2. 构造第二次请求（同 `conversation_id`、新 `invocation_id`、
   messages 追加 assistant(tool_calls) + tool(tool_content)），确认上游正确接续；
3. 如果不接续 → 实现 `RunInference` transport（载荷类型相同，只换传输与握手），
   并记录"`Stream` 不支持无状态工具循环"这一结论。

### 第四阶段：回到 Cursor 补丁

以第一阶段的协议事实为基准，按 v126 现状增量改：

1. 保留 v126 已实现的全部 marker（不要重写脚本）；
2. 先验证 `RunInference` 在目标账号上是否可用（HTTP/2 双向流）；
3. 可用 → 走 C2 优先方案（去掉 direct 注入，保留原生握手）；
   不可用 → 走 C2 备选方案（保留 direct 注入，补 `finish()` 与 metadata 来源）；
4. 修 C4 的 4 项（`modelsBySlug` 全量、`isModelValid:()=>!0`、
   `normalizeCustomSubagents:e=>e`、`getTaskToolConfig` 三件套）；
5. 验证 `/summarize`（路由已放行，只剩能力声明与 invocation）；
6. 最后处理 background/resume 的状态一致性。

### 第五阶段：补齐独立 API 的运行时

依次实现：

1. adapter-managed subagent（G7）；
2. summary checkpoint（G8）；
3. background worker + event store + replay（G9）；
4. 管理后台与生产安全（P6）。

### 第六阶段：双线对照验收

相同的模型/effort/工具场景，分别在：

- Cursor patched（走 `RunInference` 或 direct 注入）；
- docker-composer-api Connect provider（走 `Stream`）；

中运行并比较：

- 出站 method（`RunInference` vs `Stream`）；
- `requested_model.model_id` 与 `parameters`；
- `conversation_id` / `invocation_id` 的分配方式；
- 响应 frame 的 oneof case 顺序；
- tool call/result 的 ID 对应；
- summary 行为；
- 断线后的恢复结果；
- 最终状态。

**不再把 Grok Bot 列为对照项** —— 它不调用 `InferenceService`，
拿它对照推理协议没有意义。它只作为鉴权头与模型目录的对照。

---

## 12. 哪些方案明确不采用

### 不采用 1：把 `agent.v1.AgentService/Run` 当推理回退

它有独立的 `agentBidiTransport`、独立的 SSE/poll 回退，是 agent 编排协议而非推理协议。
与本项目目标冲突，直接排除。

### 不采用 2：继续扩大 v126 的 direct 注入范围

direct 注入是 `RunInference` 不可用时的备选，不是终点。
继续在它上面叠加 `supportsSelfSummary`、Task 和 resume 字段，
会形成越来越难维护的假对象。**但也不要为了"纯净"就删掉它**——
在 `RunInference` 未验证可用前，它是唯一能出文本的路径。

### 不采用 3：只把 `supportsSelfSummary` 改成 true

能力声明不等于能力实现。没有 summary invocation、transcript commit 和失败回滚，
改标志只会让 UI 进入更深的错误路径。

另外注意 `675.js:2384528` 处 `canUseSelfSummary:()=>!0` 是硬编码的，
说明某些路径根本不查 `attempt.supportsSelfSummary`——先确认 `/summarize`
走哪条路径，再决定改它是否有意义。

### 不采用 4：只把 `isModelValid` 改成永真就宣称修好了子代理

**此前的表述有误，需要纠正：**

- 官方 local provider 的 `isModelValid` **本来就是 `()=>!0`**
  （`cursor-agent-exec/dist/main.js:Lge`、`cursor-local-agent-runtime/dist/main.js:HHt`），
  所以"改成永真"是**向官方对齐**，不是"绕过校验"；
- 但单独改它不够：模型解析路径先查 `subagentModels.modelsBySlug`，
  查不到就回落父模型，`isModelValid` 只是二次校验。
  v126 的 `modelsBySlug` 只有父模型一项，所以子代理永远解析不出别的模型；
- 正确做法是 `modelsBySlug` 全量构造 + `isModelValid:()=>!0` **一起改**（见 C4）。

原文说"可能让非法模型进入 Stream"——这个担心是多余的：
服务端本来就会校验 `model_id`，客户端侧的 `isModelValid` 只是 UI 层的提前拒绝。
官方选择 `()=>!0` 说明它把校验交给服务端。

### 不采用 5：把 `docker-composer-api` 的 SDK runner 改成裸 fetch

会同时破坏现有 SDK 的工具、错误、会话和测试。
应增加独立 provider（实现同一个 `CursorRunner` 接口），
而不是在原 runner 中混入两套生命周期。

### 不采用 6：把 Grok Bot Electron bundle 整体搬进 Docker

Electron 主进程、Renderer、local-exec、IPC、平台原生模块和本地状态强耦合。
且**它根本不含推理客户端代码**（§1.4），搬进去也拿不到 `InferenceService`。
应提取协议（从 Cursor descriptor）与鉴权行为（从 Grok Bot），重写 Docker 侧 provider。

### 不采用 7：从 Grok Bot 抓包获取推理协议 fixture

**这是原计划的核心错误，必须明确排除。** Grok Bot 桌面端只有 6 个 Connect service，
0 处 `InferenceService`，推理发生在 `*.cursorvm.com` 的 Sand VM 内部。
抓它的包只能得到 `ensureSandBox` / `availableModels` / `bootstrapStatsig` 和
coordinator 的 `/api` `/events`，得不到任何推理 frame。

协议事实的来源是 **Cursor 3.18.9 自带的 protobuf descriptor**，
行为样本的来源是 **打过补丁的 Cursor 自己**。

### 不采用 8：在网关侧假设上游支持断点续传

`InferenceStreamRequest`（12 字段）与 `RunInferenceRunRequest`（5 字段）
都没有 offset / cursor / resume token。断线后只能从 transcript/checkpoint 重建，
并按 `delivery_state` 判断重跑是否安全（见 G9）。

---

## 13. 风险和停止条件

### 高风险项

1. `aiserver.v1.InferenceService` 是私有协议，字段可能随 Cursor 版本更新
   —— 缓解：descriptor 从安装目录读，随版本重新生成，不手写；
2. **`Stream` 是否支持无状态工具循环未验证** —— 若不支持，第二部分必须切
   `RunInference`，需要 HTTP/2 双向流（无 SSE/poll 回退）。这是最大单点风险，
   P2 第一步就要验；
3. session JWT 和 checksum 依赖设备上下文（machineId 必须稳定）；
4. 上游无断点续传（已确认），断线只能重建请求；
5. 上游 tool result 的 exactly-once 语义未证明 —— 幂等要在网关侧做；
6. 模型目录和 `parameter_definitions` 按账号/资格变化 —— 必须按 credential 缓存；
7. Cursor 自动更新会改变压缩字符串和完整性 hash —— v126 的版本白名单会拒绝，
   但要确认拒绝时不留下半成品状态；
8. `675.js` 的 `useClientSideSubagent` 分支条件若在未来版本变化，
   `getTaskToolConfig:async()=>({})` 会从"不被消费"变成"解构 undefined 崩溃"；
9. Docker 的工作区与 Cursor 本地执行环境不同 —— 本地工具（G6.2）默认关闭；
10. `_ref_oxen` 的旧测试断言 `AgentService/Run`，与当前目标不兼容，
    引用它的诊断方法可以，引用它的断言不行。

已从风险清单移除（已确认为事实，不再是不确定项）：

- ~~Grok Bot 0.30.0 与 Cursor 3.18.9 可能不是同一 bundle 结构~~
  → 已确认：Grok Bot 不含推理客户端，两者不可比，不存在"套用变量名"的问题；
- ~~`conversationId` 不自动证明上游支持恢复~~
  → 已确认：协议无 offset 字段，上游不支持恢复；
- ~~Stream frame 可能无法独立表达完整 Agent/Task~~
  → 已确认：确实不能，Task/subagent 不在推理协议层，必须网关自己实现。

### 必须停止并重新取证的情况

- 当前 Cursor 版本与 `3.18.9` 不一致（v126 会自动拒绝，但要人工确认）；
- `657.js` 的 descriptor 与本文档 §1.3 记录的字段号不一致
  （说明版本变了，必须重新生成 `.proto`）；
- 连续两次 `Stream` 请求上游不接续（切 `RunInference`，并重写第二部分的 transport）；
- `RunInference` 的 HTTP/2 双向流建不起来（第一部分只能走 direct 注入）；
- 响应中出现 §1.3 之外的 oneof case（记录后继续，不中断，但要更新 `.proto`）；
- resume 发生重复工具副作用；
- 只能靠 marker 数量判断成功；
- 需要伪造权限或绕过认证才能继续。

---

## 14. 最终完成定义

### Cursor 补丁完成

只有同时满足以下条件，才称为完成：

- 所有模型轮次都访问 `aiserver.v1.InferenceService`
  （`RunInference` 或 direct 注入下的 `Stream`，二者之一，明确记录是哪个）；
- 普通文本、thinking、工具、子代理、summary、background 均通过 §6 验证矩阵；
- 子代理可以使用独立模型（`Pwd.modelId` 与父不同）；
- 子代理可以使用独立 effort（`Pwd.modelParameters` 与父不同）；
- `subagentModels.modelsBySlug` 条目数 > 1；
- `getTaskToolConfig` 返回 `{agentConfig, promptSession, summarizationHandler}` 而非 `{}`；
- `/summarize` 能完成并写回 transcript；
- background resume 不重复工具、不丢事件，且 resume 后子代理 mode 为 `AGENT`；
- Agent Host executor 不出现 `undefined.execute`；
- 安装、卸载、升级检测和回滚通过，卸载后 SHA-256 与基线一致；
- 不依赖 `agent.v1.AgentService/Run`。

### 独立 API 完成

只有同时满足以下条件，才称为完成：

- `CursorConnectProvider` 与 `CursorSdkProvider` 隔离，互不污染 key/重试/错误；
- 推理严格访问 `POST /aiserver.v1.InferenceService/Stream`（或明确记录已切 `RunInference`）；
- envelope parser 经过半包/多帧/压缩/endStream/超长异常测试；
- checksum 为 base64url 无 padding，与 Cursor 算法逐字节一致；
- 模型目录来自 `AvailableModels` 而非硬编码，参数由 `parameter_definitions` 校验；
- 模型和 effort 实际出现在 `requested_model`；
- system 消息走 `role=SYSTEM(4)`；
- 工具调用有持久化和幂等（`UNIQUE(run_id, call_id)`）；
- 子代理有独立 `conversation_id` / model / parameters 和父子 DAG；
- summary 有 checkpoint 和失败回滚；
- background 有 worker、lease 和状态查询；
- SSE 支持 `Last-Event-ID` 事件回放，补发与 live 无竞态；
- worker 重启后按 `delivery_state` 判断，不盲目重复有副作用的操作；
- 凭据不进入日志和 fixture；
- 现有 SDK API 测试不回归（`npm test` 全绿）。

---

## 15. 建议的下一步交付物

下一步不要直接改补丁，先交付以下三个小成果：

### 1. `cursor-connect-proto/`（两条路线共用）

```text
cursor-connect-proto/
  extract-descriptor.mjs      从 657.js 的 newFieldList 生成 .proto
  inference.proto             生成结果（含 InferenceService + 全部消息 + 4 个枚举）
  gen/inference_pb.ts         protoc-gen-es 输出
  envelope.ts                 5 字节 envelope 编解码
  checksum.ts                 base64url 版 checksum
  tests/
    field-numbers.test.ts     与 657.js 逐条对照
    envelope.test.ts          多种 chunk 切分
    checksum.test.ts          与 Cursor/Grok Bot 算法一致性
```

不含真实凭据，不含真实 machineId。

### 2. `docker-composer-api/src/cursor-connect/`

- 只实现 envelope、transport、credentials、headers、catalog、
  request-builder、response-normalizer；
- 实现现有 `CursorRunner` 接口，接进 `server.ts`；
- 只支持文本 + thinking + 模型/effort；
- 不接入工具、子代理、background；
- SDK 路线零改动，`npm test` 保持全绿。

### 3. Cursor 补丁：先做一次可行性验证，不改脚本

在打上 v126 的 Cursor 上验证两件事，**结果决定第一部分的路线**：

1. `RunInference` 的 HTTP/2 双向流能否建立（去掉 direct 注入试跑一次）；
2. 若能，`run_ready` 是否返回 `supports_self_summary: true`。

验证完再决定改 C2 的哪个方案。**这一步不需要改脚本代码**，
只需要临时手工编辑一次 675.js（并保留备份）即可确认。

之后再修 C4 的 4 项（`modelsBySlug` / `isModelValid` /
`normalizeCustomSubagents` / `getTaskToolConfig`），
这几项与 `RunInference` 是否可用无关，可以并行做。

完成这三个成果后，再决定是先完善 Cursor 原生 UI，还是先把网关推进到工具、子代理和后台任务。
