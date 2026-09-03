# 缓存命中与 499：单一方案计划（Connect 单发单收 + 稳定 conversation_id）

> 目标：同时满足「上游 prompt 缓存命中率显著上升」与「不再触发 499」。
> 本文只给**一个**方案。被否决的替代路线在 §4 说明为什么不选。
> 版本基线：`855fc50`（v0.4.2）。部署方式：服务器 `git pull` + `sudo docker compose up -d --build`。

## 1. 根因（已闭合，无需上游假设）

### 1.1 上游缓存的真实口径（xAI 官方）

- 缓存**自动开启、无写入费用**，命中部分按 0.25x 计费，块粒度 128 token。
  → **`Cache Write` 恒为 0 是 Grok 家族的正常表现，不是故障信号。唯一可用信号是 `Cache Read`。**
- 缓存条目**按服务器存储**。官方要求用 `x-grok-conv-id`（Responses API 侧是 `prompt_cache_key`）把同一段对话的请求**路由到同一台服务器**，否则即使前缀一致也读不到缓存。
- 多轮硬约束：**绝不可编辑 / 删除 / 重排早先消息，只能追加**；推理模型必须把上一轮的 `reasoning_content` 原样回传。
- 缓存可随时被驱逐；命中不保证。

结论：命中率取决于两件事同时成立 ——「前缀逐字节稳定且只追加」+「同一段对话稳定落在同一台上游服务器」。

### 1.2 观测数据的解释

| 行 | Tokens | Cache Read | Input | Output | 机制 |
|---|---|---|---|---|---|
| A | 1.1万 | 5,248 | 5,495 | 451 | 正常完成的小请求，命中了上游共享系统前缀 |
| B | 17.2万 | **0** | 171,965 | 385 | **整段对话被 flatten 成一条新 user，发给一个全新会话** |
| C | 2.8万 | — | — | — | 同批次的第三条 |

B 行的形状（input 17 万 / output 385）就是「模型刚吐出一个工具调用就被网关收尾」，且 `Cache Read=0` 说明这条请求在上游是**一段全新对话**。

### 1.3 代码侧四条根因

1. **每个 Agent 实例 = 一个新的上游 `conversation_id`。** `Agent.create()` 生成 `agent-${randomUUID()}`；local run 传 `sessionId: this.agentId`；本地 runtime 把它当 `conversationId` 写进 `AgentRunRequest.conversation_id`。这是上游唯一的会话主键，也是服务器亲和键的唯一候选。**新 agent = 新 conv id = 落到没有该前缀的服务器 = Cache Read 归零。** 同时 `Agent.create` 每次生成新的随机 32 字节 `blobEncryptionKey`（SDK 自己的类型注释写明该头用于「让服务端保持跨轮 blob 缓存存活」），只有 `Agent.resume` 才复用。
2. **中断一次即毁掉 agent。** 客户端按 ESC / socket close → `cursor-runner.ts:797-809` 在无 pending、非 path B 时直接 `throw 499`，**跳过 `markIdle`**，state 仍是 `running` → `streamDurable` 的 finally 落到 `dropDurableSession`（`:256-262`），agent 与落库映射一起消失。**这条路径不打任何日志**，所以此前一直没被发现。
3. **drop 之后新槽首发不含任何历史。** `formatDurableUserMessage`（`:1489-1498`）= `STABLE_DIRECTIVE + 截断到 4000 字的 SYSTEM + 最后一条 user 文本`。前面 N 轮一个字都没有。用户看到的「重复说上一轮开头」不是复读，是**在没有上下文的情况下重新开了一次头**。
4. **主对话与同模型子代理撞同一把 Hub 锁。** Claude Code 对主 agent 与 Task 子 agent 发**同一个** `x-claude-code-session-id`；网关的 `explicitSessionIdFromHeaders`（`durable-id.ts:74-89`）认这个头但**忽略** `x-claude-code-agent-id`。于是两者算出同一个 Hub 键：谁先拿锁谁赢，另一个被 `tryAcquire` 挤成 `forceStateless` → 整段 flatten（这就是 B 行）；若子 agent 拿到锁，它不同的 `toolsFingerprint` 还会顺手 drop 掉主对话的槽。

四条叠成闭环：中断或并发一次 → 丢 agent → 下一轮全新 conv id + 无历史 → Cache Read 归零 + 模型失忆。

## 1.5 路线修订（2026-09-03，三份开源取证之后）

**本节推翻本文档原先的首选路线。** 原方案把 Claude Code 流量切到 Connect 单发单收；新证据表明**先把 SDK 路线修对更划算**，Connect 降为备选。三条证据：

### 1.5.1 决定性的一条：Connect 单发单收会**丢掉我们已有的最大优化**

我们的 SDK 路线已经实现了「held execute」（path A）：HTTP1 让 `customTools.execute` 返回一个挂起的 Promise、Run 保持打开；HTTP2 带 `tool_result` 进来时 `resolvePending` 让**同一条 Run** 继续。单测已锁死这个语义（`tests/cursor-durable-runner.test.ts`：`http2.runId === http1.runId` 且 `agent.sends.length === 1`）。

**工具续轮的代价因此是「几百字节」，而不是「重发整段历史」。**

`wisdgod/cursor-api` 用另一套机制做同一件事（把上游双向流 park 起来，下一轮只往还开着的流里写一个 `ClientSideToolV2Result` 帧，`src/core/stream/session.rs`），并且它是那五个逆向项目里唯一做到的。这反过来证明这个优化的价值 —— 它是 flatten 问题的真正解法。

而 **Connect 单发单收结构上做不到这一点**：每个 HTTP 独立，工具续轮必须把全量结构化历史再发一遍。即使前缀缓存命中 90%，170k token 仍要付 `0.25×153k + 17k ≈ 55k` 等价 token；held execute 是 **≈0**。Claude Code 是极度工具密集的客户端（每轮多次工具调用），这个差距会主导账单。

### 1.5.2 §1.3 的四条根因**全部在我们自己的代码里**，不是 SDK 的硬限制

| 根因 | 原判断 | 修订后 |
|---|---|---|
| 1 conv_id 每次变 | 「只能靠 create→resume 间接控制」 | **`AgentOptions.agentId` 是公开字段**（`options.d.ts:335`），可直接传确定性值。两个参照项目都没用（`pi-cursor-sdk` 代码注释里写明知道它存在）。这是直接控制，不是绕 |
| 2 中断毁槽 | 需修 | 8 行（阶段 -1），与 provider 无关 |
| 3 新槽无历史 | 需修 | 修好 1+2 后 drop 变罕见；真需要重建时按参照项目做法回落全量 flatten |
| 4 主/子代理撞键 | 需修 | 认 `x-claude-code-agent-id` 即可 |

唯一真正的 SDK 硬限制是 `RequestContext` legacy 全量内联 —— 但我们已经是 `settingSources: []` + 容器内空 `/workspace`，**内联内容是稳定的**，因此它进的是可缓存前缀，不是每轮变化的噪声。这正是 `cursor-sdk2api` 刻意采用的做法，而 `pi-cursor-sdk` 反着做（`settingSources:["all"]` + 真实 cwd）导致前缀不稳。我们的方向已经对了。

### 1.5.3 SDK 路线有实测背书，Connect 一次成功响应都没有

两个独立项目收敛到同一套做法（§3.5、§3.6），其中一份外部实测 **≈90% 命中**（§3.6.2）。而 Connect 路线的 `exchange_user_api_key` 从未真机跑通、`InferenceService/Stream` 从未解析过一次成功响应。

### 1.5.4 修订后的路线

**主线：修 SDK 路线**（阶段 -1 → 1' → 2'，见 §3）。四条根因逐条修，保留 held execute，保留已有的空 workspace 前缀稳定性。

**备选：Connect**（原 §2 内容全部保留，作为 SDK 路线修完仍不达标时的下一步）。它的结构化历史 / 不截断 system / 无锁这三个优点仍然真实，只是**不足以抵偿 held execute 的损失**。

**两条路线共享的工作**：包 D 可观测性（§2.2 包 D）、`conversation_id` 派生串不含上游 apiKey（§2.2 包 B 的核心教训）—— 这两项无论走哪条都要做。

---

## 2. 备选方案：Connect 单发单收（原首选，现降为备选）


一句话：**不再让上游替我们维护会话状态，改为每次请求把完整结构化历史发过去，并用一个逐字节稳定的 `conversation_id` 保证服务器亲和。**

### 2.1 为什么这条路同时解掉两个问题

| 问题 | SDK 路线（现状） | Connect 路线（本方案） |
|---|---|---|
| 上游会话主键 | `agent-${uuid}`，agent 实例一换就变 | `conversation_id` 由入站身份哈希导出，**同一段对话恒定** |
| 历史 | 靠上游 checkpoint；drop 后归零 | 每次请求带**全量结构化历史**（客户端本来就发全量），上游无状态 |
| 并发/中断 | 进程内 Hub 锁 + 状态机；抢锁失败即 flatten，中断即毁槽 | **无锁、无跨请求 agent 生命周期**，每个 HTTP 独立 → 499 的成因结构性不存在 |
| 缓存可测性 | 只能看用量面板猜 | `extended_usage` 直接给 `cacheRead/cacheWrite`，可分桶统计 |
| system 位置 | 拼进 user 文本，且 durable 路径截断到 4000 字 | 独立 `role=SYSTEM(4)` 消息，不截断 |
| 工具历史 | flatten 成 `TOOL RESULT (id):` 纯文本 | 结构化 `tool_calls` / `tool_content` |
| thinking 连续性 | 网关自造签名，历史 thinking 被丢弃 | `reasoning_parts` 带 `signature` 原样回传（xAI 明确要求） |

Connect 侧的协议层已完备并有 193 条测试全绿：envelope/checksum/头/错误映射/取消/usage 四桶/图片/思考/工具编解码。缺的不是协议，是**接线**。

### 2.2 必须落地的四个包

#### 包 A — 结构化历史接进默认路径（核心，缺它整个方案无意义）

现状缺陷：`provider.ts:133` 只发一条消息 —— `messages.push({role:"user", text: input.prompt})`，而 `input.prompt` 是 `protocol.ts` flatten 出的整串文本。**所以今天的 Connect 路线并没有发结构化历史。**

`conversation.ts` 的 `toPreparedConversation` 三协议解析器（Chat / Responses / Anthropic，含 `thinking`/`redacted_thinking`/`tool_use`/`tool_result`/图片/document 拒绝）已写好，但只在 `service.ts:318` 的 `conversationFor()` 里被调用，而 `conversationFor` 只被 `streamWithTools()` 用；后者要求 `orchestratedTools(input).length > 0`，而该函数在 `sendTools === false`（默认）时直接返回 `[]`。**默认路径根本不走结构化解析。**

改法：
1. `CursorConnectProviderOptions` 增加 `conversation?: PreparedConversation`；`buildConversation` 用 `conversationMessages(conversation)` 取代 `provider.ts:133` 那一行。
2. `service.ts` 把 `conversationFor(input, [])` 提到默认路径，两条路共用。
3. 修 **system 双发**：`service.ts:474` 现在既把 `systemInstructions(input)` 传给 provider，又让 `input.prompt` 里带一份（Anthropic 无条件 `SYSTEM:`，`protocol.ts:206-209`）。二者只能留一个 —— 结构化路径留独立 SYSTEM 消息，`prompt` 不再参与。
4. 宿主元工具过滤：`conversation.ts` 没有 `isHostMetaTool` 等价物，Claude Code 的 `Task` / `mcp__*` 历史块会以 `tool_use` 进 wire，而 `tools[]` 里已被过滤 → 「声明没有、历史有」。复用 `tool-compat.ts:20-45` 与 `protocol.ts:946-955`。
5. 图片：`conversation.ts:398-404` 会产出 `source:"url"`，而 `request-builder.ts:187-193` 直接 400。改为 inline（下载转 base64）或在解析阶段就明确拒绝并给可读错误。
6. 顺手修 `service.ts:474` 一行内两次调用 `systemInstructions(input)`（每次全量重解析 body）。
7. **工具表序列化必须确定性。** 工具定义位于请求最开头，而 OpenAI 官方明文说路由哈希取「开头 token，**含工具定义**」——这个位置最不该有非确定性。当前两处口径不一致：`prompt-delta.ts:90-95` 算 `toolsFingerprint` 用 `stableStringify`（按 key 排序），而真正进 prompt 的 `protocol.ts:847` 是裸 `JSON.stringify(tool)`（保留入站 key 序）。后果是二者可能**反向失配**：同一组工具换个 key 序 → 指纹相同（不换槽）但 prompt 字节不同（缓存 miss），网关看不出任何异常。Connect 路线的 `buildAgentTool` → `toStruct` 走 `Struct.fromJson`，key 序同样来自入站对象。改法：结构化路径统一用一份稳定序列化，与指纹口径对齐。


量级：约 150–250 行生产代码 + 8–12 条测试（每协议一条「wire 上 messages 数与角色序列」+ 一条「system 只出现一次」+ 一条「历史 tool_use 与 tools[] 一致」）。

#### 包 B — conversation_id 的身份与租户隔离

`conversationIdFor`（`provider.ts:195-202`）现在：`reuseDurableAgent===false → randomUUID()`，否则 `stableUuid(durableIdentity(...) + "\0" + model)`。而 `server.ts:888-890` 的 `canReuseDurableAgent(seed)` 已是「有 seed 即 true」，所以 Claude Code 场景下 `conversation_id` **确实稳定**，不会退化成随机 UUID。`provider.ts:185-194` 的注释描述的是 `45f6d27` 的旧行为，已过期，需改写。

必须修的两个真实风险：
1. **首条 user 相同即撞车。** 无显式头时身份落到第 3 级 CPA DeriveID（`routing.ts:44-59`：instruction 前 50 rune + 完整第一条 user + callerScope）。Claude Code 的 system 前 50 rune 恒定，区分度全靠第一条 user —— 两个都以 `hi` 开头的会话会共用同一个上游 conversation。
2. **第 3 级不含 ownerHash 时无租户隔离**（`durable-id.ts:26-35` 显式头那一档就是头原值）：两个网关密钥传同一个 `x-session-id` 会共用上游会话。

改法：`conversation_id` 的派生串固定为 `ownerHash \0 identity \0 model`。显式头那一档也要混 ownerHash —— 它是本网关唯一的多租户边界。

**同时必须确认派生串里没有上游 Cursor key 指纹。** 我们现在的 Hub 键 `durable-id.ts:14-19` 混了 `input.apiKey`（上游 key）。在 `fill-first` + session affinity 下它通常稳定，但轮询换 key、或粘性绑定过期（`SESSION_AFFINITY_TTL_MS` 默认 1 小时）之后 Hub 键就会变 —— 这与参照实现 Issue #20 那个「5 账号池 293 决策 / 0 resume」的失效模式是同一个 bug，只是我们的默认配置把它掩盖住了。Connect 路线的 `conversationIdFor` 不含 apiKey，天然避开；但若将来回退到 SDK 路线，这一条要一起修。


3. **认 `x-claude-code-agent-id`。** 官方 gateway 协议文档确认该头存在，且只在子代理请求上出现（`x-claude-code-parent-agent-id` 用于嵌套）。把它并入身份派生串，**主对话与 Task 子代理从此拿到不同的 conversation_id**，不再互相污染上游对话。这一条同时消掉 §1.3 第 4 条根因。

#### 包 C — 凭据自动化（用户只有 Cursor API key 时必做）

`api-key-exchange.ts:14` 已实现 `POST {api2}/auth/exchange_user_api_key`（`Authorization: Bearer <crsr_…>`，body `{}`）→ `{accessToken, refreshToken}`，`accessToken` 即 Connect 要的 session JWT，且会拒绝 web token。`service.ts:427-461` 的 `importFromCursorKey` 已把它接到 `cc_credentials`，后台一键在 `admin.ts:417-432`。

缺三件：
1. **真机从未验证过。** `docs/CURSOR-CONNECT-PROGRESS.md:544` 只到「401 unauthenticated」，本地全是 mock fetch。**这是本方案唯一的硬门槛**（见 §3 阶段 0）。
2. `refreshToken` 兑换后被丢弃（`service.ts:439-452` 没存），`expires_at` 恒 NULL，无自动续期 → 过期后静默 401，5 次后凭据被自动停用并回落 SDK。改：存 refreshToken，从 JWT 读 `exp` 写 `expires_at`，401 时先重兑换再计失败（`service.ts:499-509`）。
3. 没有「启动时按 Key 池自动 import」，只有 env 播种与后台按钮。补一个启动钩子。

量级：约 100 行 + 4 条测试。

#### 包 D — 可观测性（必做，否则下次仍然「给不了调试」）

用户这次拿不出日志，是因为诊断信号只有两条通道，且都缺口：
- `console.error` 门槛是 `status >= 500 || error`（`server.ts:696`），要排查的 401/403/404/499 大多只落库、无 stdout 行。
- 更严重的黑洞：**`beginLog` 之前抛出的错误既不落 `request_logs`、也不打任何日志** —— `authFor()` 的 401/403、`prepare*()` 的 400、`scopedModelIdentity()` 的 403 全在此列，直接走 `setErrorHandler` → `sendProtocolError`。客户端明明收到错误码，后台一片空白。

改法（全部低风险、纯读、不碰鉴权）：
1. **`/health` 加构建溯源**：`gitCommit`（build 阶段 `ARG GIT_SHA` 注入）、`builtAt`、`sessionMode`、`provider`、`uptimeSeconds`。有了它，「服务器在跑哪份代码」从「exec 进容器 grep JS」变成一条 curl。注意 `/health` 目前无鉴权公开（`server.ts:187`），只放非敏感字段。
2. **接上 `src/durable-telemetry.ts`**（已定义好数据结构、尚未接线），在 `/admin/api/overview` 暴露快照：按 provider 分桶的 `cacheRead/(input+cacheRead+cacheWrite)` 命中率、决策计数、`identitySource` 计数（header / body-field / derived-L3 / none）、最近 50 条决策（session id 截前 12 位）。`/health` 只留极简摘要。
3. `finishLog` 的 console 门槛从 `status>=500` 放宽到 `status>=400`。
4. `setErrorHandler` 里对未 finish 的请求补一条 `request_logs`（endpoint + status + error，model/key 留空）。
5. 请求日志加 `provider` 列（`store.ts:117-147` 现无此字段），否则无法按 provider 比命中率。

补充事实（供排查时对号，无需改动）：`REQUEST_LOG_KEEP` 默认 0，而 `trimRequestLogs()` 首行就是 `if (!this.requestLogKeep) return;`（`store.ts:181`）——**0 = 永久全量保留，历史为空绝不可能是自动裁剪造成的**。`docker compose down -v` 会删掉命名卷 `composer-api-data`（`/data/state.sqlite` 在其中），key 池 / 网关密钥 / 运行设置 / 请求历史全部清零；不带 `-v` 的 `down` 保留卷，安全。


### 2.3 选路与回滚

`selectProvider`（`router.ts:58-84`）四级优先级：显式头 `x-gateway-provider` > 模型名 `connect/` 前缀 > key 设置 > 全局默认；`connectAvailable===false` 时一律回落 SDK（`:64-67`），请求不会失败。

上线用 `GATEWAY_PROVIDER=connect`。**回滚只需把它改回 `sdk` 并重启**，SDK 路线一行未动。

需要同时处理的三处不一致：
1. 裸模型名走 connect 时 `isConnectModelId` 为 false（`server.ts:557`），只存在于 Connect 目录的模型 `confirmed=false`；若网关密钥配了任何黑名单 → `denyRuleUnverifiable` fail-closed 403（`server.ts:571-578`）。
2. 池里无 active Cursor key 时 `/v1/models` 退化成静态兜底表（`models.ts:86-88`）。
3. `defaultProvider` 目前只能改 env，后台 Connect 面板是只读回显（`admin-ui.ts:964`）。

### 2.4 明确不做

- **不动 SDK 路线的任何代码。** 它继续作为回退路径，`CURSOR_SDK_DISABLE_SESSION_RESUME` / `CURSOR_SDK_SESSION_MODE` 语义不变。
- **不开 `CURSOR_CONNECT_SEND_TOOLS`。** 「同 conversation_id、新 invocation_id 的第二次 Stream 能否接续」未实测（`provider.ts:40-46`、`tool-loop.ts:80-84`）。Claude Code 自己执行工具，网关只需把结构化历史发上去 —— **单发单收足够**，工具循环留到后续实测。
- **不填 `InferenceProviderOptions.anthropic.cache_control`。** 该字段在 descriptor 里存在（`inference_pb.ts:1721`、`:1752`），但网关一处都没填，且是否生效未知。拿到一次成功响应 + 命中率基线之后再单独评估。
- **不接子代理 / background / summary / 事件重放。** `capabilities()` 已诚实报 false。
- **不做 429 跨凭据 failover。** 单凭据场景可延后（`service.ts:499-509` 现在只对 401/403 计数）。

## 3. 执行阶段与门禁

### 阶段 -1 — 断连不毁槽（**不依赖任何前提，立刻做**）

这一条与 provider 选择无关，是 §1.3 第 2 条根因的直接修复，也是参照实现里唯一 8 行就能抄的东西（§3.5.2 第 1 项）。

改 `cursor-runner.ts:797-809` 的 `http-abort` 分支：当本次 HTTP **已经产出过 text 或 tool_call**（即 `textParts.length || toolCalls.length`）时，走 `hub.markIdle(sessionId)` + 正常 `done` 收尾，**不抛 499、不落进 finally 的 `dropDurableSession`**；只有零语义输出时才保持现在的 499 行为。

验收：新增单测「吐字中 abort → slot 仍存活且 state=idle，agent 未 dispose」；现有 `path B abort after tool_call keeps the idle agent` 保持绿。

做完这一条，「中断一次就失忆 + 缓存归零」立刻消失，无论后面走哪条 provider。

### 阶段 0 — 真机验证（**Connect 备选路线的门闩**；走 SDK 主线可跳过）


这是整个方案唯一的不可推导前提。在服务器上执行，目标是拿到一次**成功的 Stream 响应**。

```bash
# 0.1 先确认容器在跑哪份代码 + durable 是否真开着
sudo docker compose exec composer-api node -e "console.log(require('./package.json').version)"
sudo docker compose logs composer-api 2>&1 | grep -E "listening on http|session mode|kill switch|Cursor Connect" | tail -8

# 0.2 确认三条 855fc50 独有标记都在（全为 0 = 容器里是旧代码，先解决部署再谈其它）
sudo docker compose exec composer-api node -e "const f=p=>require('fs').readFileSync(p,'utf8'),c=(s,r)=>(s.match(r)||[]).length;console.log(JSON.stringify({tryAcquire:c(f('dist/src/session-hub.js'),/tryAcquire/g),deferRunnerStream:c(f('dist/src/server.js'),/deferRunnerStream/g),codexTurnMeta:c(f('dist/src/durable-id.js'),/x-codex-turn-metadata/g)}))"

# 0.3 最近 2 小时的 durable 决策：大量 `send first` 而几乎无 `drop+create` = 命中 §1.3 第 2 条静默毁槽
sudo docker compose logs composer-api --since 2h 2>&1 | grep -E "\[durable\]|\[session-hub\]|\[request\]" | tail -100

# 0.4 request_logs 最近 20 条（只读打开，不改数据）
sudo docker compose exec composer-api node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/state.sqlite',{readOnly:true});console.log('total =',d.prepare('SELECT COUNT(*) n FROM request_logs').get().n);console.table(d.prepare('SELECT ts,endpoint,model,status,duration_ms ms,input_tokens inTok,cache_read_tokens cacheRead,output_tokens outTok,usage_source,substr(COALESCE(error,\"\"),1,60) err FROM request_logs ORDER BY ts DESC, rowid DESC LIMIT 20').all());d.close()"

# 0.5 后台「Connect」面板 → 从 Cursor Key 导入凭据（POST /admin/api/connect/credentials/from-key）
#     成功后点「测试」按钮：它走 AvailableModels(Unary)，能返回模型数即 exchange + checksum + 头全对
```

上线前先留档（`--build` 会换掉容器，旧容器的 json-file 日志随之消失）：
```bash
sudo docker compose logs --no-log-prefix composer-api > /tmp/gateway-$(date +%Y%m%d-%H%M).log 2>&1
```


判定：
- `exchange_user_api_key` 返回 `{accessToken, refreshToken}` 且 `accessToken` 是 session JWT（不是 web token）→ **通过**
- 「测试」按钮返回模型数 → **通过**，进入阶段 1
- 若 exchange 返回 403 `sign_in_policy_violation` 或测试按钮 503 → **停止**，把错误原文交回。此时本方案不成立，改走次优路线：**SDK 路线 + 确定性 `agentId`（§3.6.6）+ 持久 SQLite store（§3.6.3）+ 池化复用/resume/增量 send（§3.5.1、§3.6.1 的共识做法）**。该路线有两个独立项目的实测背书（其中一份外部实测约 90% 命中，§3.6.2），但仍受 `RequestContext` legacy 全量内联所限，且 system 在 durable 首发被截断到 4000 字。


### 阶段 1' — SDK 主线：确定性 agentId + 认 agent-id + 持久 store（**主线核心**）

三项一起落，都在 SDK 路线内，不碰 Connect。

1. **确定性 `agentId`**（对治根因 1）：`agentId = "agent-" + stableUuid(ownerHash \0 identity \0 model)`，首次 `Agent.create({agentId, ...})`、后续 `Agent.resume(agentId, ...)`。同 id 二次 create 会抛 `Agent ${id} already exists`（SDK `createAgent`），所以必须先查 store —— 我们已有的 `ensureDurableSlot → tryResumeDurableSlot` 结构天然契合。
   派生串**绝不能含上游 `apiKey`**：现在的 Hub 键 `durable-id.ts:14-19` 混了它，轮询换 key 或粘性绑定过期（默认 1 小时）就会变 —— 这与 `cursor-sdk2api` Issue #20「5 账号池 293 决策 / 0 resume」是同一个 bug，只是被 `fill-first` 默认配置掩盖。
   `stableUuid` 要产出**合法 uuid 形状**（sha256 前 32 hex 按 8-4-4-4-12 格式化 + 设版本位），不要直接塞裸 hex —— `NGLSG/Cursor2API:worker/cursor.ts:1076-1079` 专门这么做，上游可能不认非 uuid 形状。我们 `cursor-connect/provider.ts:205-211` 已有现成的 `stableUuid`，直接复用。

2. **认 `x-claude-code-agent-id`**（对治根因 4）：并入身份派生串，主对话与 Task 子代理从此拿到不同 agentId，不再互抢 Hub 锁、不再互相 drop。官方 gateway 协议文档确认该头只在子代理请求上出现。

3. **持久 store**（让 blob key 跨重启也能复用）：现在注入的是 `createEphemeralAgentStore()`（有界**内存**），进程重启后 metadata 全失，`Agent.resume` 拿不回 `blobEncryptionKey`。改成落盘 store（参照 `pi-cursor-sdk` 的 per-session SQLite，刻意不共用 workspace 级 `index.db` 以避免并发争锁）。注意仍要保留有界回收，不能回到 SDK 默认「每 agent 一份 SQLite」的句柄泄漏。

验收：
- 单测：同一 identity 两轮 → **同一个 agentId**、`create` 只调一次、第二轮走 `resume`；不同 `x-claude-code-agent-id` → 不同 agentId；换 apiKey（模拟轮询）→ **agentId 不变**。
- 真机：后台命中率按 §3 阶段 3' 口径观察。

### 阶段 2' — 包 D 可观测性（与 1' 并行，两条路线共用）

内容见 §2.2 包 D。先落 `/health` 构建溯源与 `beginLog` 之前的错误落库这两项 —— 它们是后续所有判断的地基。

额外两个探针（来自参照项目，成本低、价值高）：
- **`GetPromptDryRun` 当 token 探针**：`wisdgod/src/core/service.rs:2254-2340` 把 `/v1/messages/count_tokens` 直接打上游 `ChatService/GetPromptDryRun`，返回 `{user_message_token_count, full_conversation_token_count}`。这是排查「17 万 token 从哪来」的现成探针，比自己估算准。**注意它是 ChatService 通道的方法，SDK 路线不一定可达** —— 先确认，不可达就跳过。
- **真实缓存用量查询**：`wisdgod/src/common/utils.rs:424-472` 请求结束后 POST `cursor.com/api/dashboard/get-filtered-usage-events`，轮询 5×1s 读 `tokenUsage.{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens}`。这与我们已有的 `UsageReconciler` 是同一类带外补写，可作为「流内 usage 口径可疑」时的交叉校验源。

### 阶段 3' — 观察与验收（SDK 主线）

阶段 -1 + 1' + 2' 落完即可上线观察，**不需要改 provider**。观察窗口至少 20 轮真实对话，且必须包含：一次用户中断（ESC）、一次工具往返、一次 Task 子代理。

**验收口径（唯一标准）**：
```
cacheRead / (input + cacheRead + cacheWrite)
```
- 首轮低是正常的（新对话、新上游服务器）。
- **同一段对话第 2 轮起该比值应显著上升，且随对话变长继续走高。** 参照基准：外部实测同一 pooled agent 第二轮 ≈90%（§3.6.2）。
- `Cache Write` 恒为 0 不算失败（Grok 家族正常表现，见 §1.1）。
- **中断一次之后的下一轮仍应是同一个 agentId**（阶段 -1 + 1' 的直接验收点）。
- 全程不应出现 499。

**先决校验（必须在算命中率之前做）**：确认 `cacheRead` 是 `inputTokens` 的**划分**还是**加项**（§3.6.5 第 1 项）。若是划分口径，`parseSdkUsage` 的 `totalTokens` 与上面这个分母都要改，否则命中率算出来是错的。

达标 → 结束，Connect 不必启动。
不达标 → 进入 §2 的 Connect 备选路线（先跑它的阶段 0 门闩）。

### 阶段 4' — README / `.env.example`

写清：确定性 agentId 的语义与副作用（同一会话恒定复用一个上游 agent）、`x-claude-code-agent-id` 的作用、缓存命中率怎么看、`Cache Write=0` 是正常的、kill switch 仍可退回 stateless。

---

### 【备选路线的阶段】以下三段仅在走 Connect 时执行

#### 备选阶段 1 — 包 A（结构化历史）

先落地、先跑测试，**不改默认 provider**。用 `x-gateway-provider: connect` 头对单条请求灰度。

验收：
- `npx tsc --noEmit` 干净；`npm test` 不引入新红。
- 新增测试：三协议各一条「wire 上 messages 数与角色序列正确」+ 「system 只出现一次」+ 「历史 tool_use 与 tools[] 一致」+ 「Anthropic thinking signature 原样回传」。
- 灰度请求返回 200 且内容正确。

#### 备选阶段 2 — 包 B（身份）

验收：单测锁：同一 `x-claude-code-session-id` + 不同 `x-claude-code-agent-id` → **不同** conversation_id；不同 ownerHash + 同一 `x-session-id` → 不同 conversation_id；同一会话连续两轮 → 同一 conversation_id。

#### 备选阶段 3 — 包 C（凭据续期）+ 切默认 provider

`GATEWAY_PROVIDER=connect` 重启。验收口径同阶段 3'，但需按 provider 分桶对比 SDK 路线的基线。
**注意：Connect 单发单收会丢掉 held execute**（§1.5.1），所以工具密集场景下即使命中率更高，等价 token 也可能不降反升。分桶对比时必须把「工具轮次的 input token」单独看。


## 3.5 参照实现：`Sunnyender-org/cursor-sdk2api`

同架构（`@cursor/sdk` 包成 OpenAI/Anthropic API，锁 1.0.30，42 star，2026-09-01 仍在推）。它**没有**走 Connect，而是把 SDK 路线做到了上限，且实测拿到 `cache_read_input_tokens > 0`。它证明的与踩到的坑，都要吸收。

### 3.5.1 它证明了「SDK 路线也能命中缓存」

做法：给每个普通轮算一个**血缘指纹**（`cursor-agent-turn.ts:232-244`：tenantScope + route + channelId + model + parentAssistantAnchor + historyDigest + turnIndex + toolCatalogDigest + policyFingerprint），完成后写一个**预测式** `nextLineageKey`；下一轮反查父记录，命中则复用，三级 fallback：

| 档 | 条件 | 做法 |
|---|---|---|
| A 进程内活体 | Session 在内存、`completed`、凭据/模型/policy 全等 | 同一个 `SDKAgent` 再 `send()`，零 SDK 调用零 store IO |
| B 持久化 resume | 进程重启后 journal 有记录 | `Agent.resume(parent.agentId, shared)` |
| C 冷重建 | fork / 压缩 / 模型或工具目录变 / 过期 / 首轮 | `Agent.create` + 全量 flatten |

复用路径的 send 只发**最后一条 user 的纯文本**（`cursor-agent-turn.ts:310-320`），历史一个字不重发。live smoke 量化：4KB padding 首轮 `send_chars>=4096`，第二轮 `send_chars<80`。

它还顺手拿到两个副产品（作者本人未必知道机制）：
- `Agent.resume` 从 store metadata 读回原 `blobEncryptionKey` → **跨轮 blob 缓存自动保活**（对应我们 §1.3 第 1 条的后半段）。
- `local.cwd` 指向**按凭据指纹分区的空目录** + `settingSources: []` + `disallowedTools` 关掉全部环境工具（`cursor-runtime.ts:265-279`）→ 没有 git status / notes / 可变工具表，`RequestContext` 每轮内联的那一大块**内容稳定**。这是绕过 legacy 全量内联的唯一现实办法。

### 3.5.2 它的三条做法我们直接采纳（与本方案不冲突）

以下四条与 provider 无关，SDK 与 Connect 两条路都受益，并入包 D 与包 A：

1. **断连不 cancel 已产出内容的 run**（`run-coordinator.ts:1534-1541`，逻辑 8 行）：
   ```ts
   if (!session.hasSemanticOutput && (state==="running"||state==="creating"))
     void this.cancel(session, "client_closed_before_output");
   ```
   只在**零语义输出**时才取消。这正面回答我们 §1.3 第 2 条 —— 我们现在是无条件 `throw 499` 然后 finally 里 drop 掉整个 agent。改法：`consumeDurablePump` 的 `http-abort` 分支在**已产出 text/tool_call** 时走 `markIdle` + 正常收尾，不抛 499、不毁槽。**这一条不依赖 Connect，应当立即修，优先级高于其它所有包。**

2. **等 tool_result 的会话不占并发配额**（`session-registry.ts:59-91`）：`awaiting_tools` 状态不计入 active run 上限。我们现在 `MAX_LIVE_SESSIONS=256` 是一刀切的 LRU，挂起中的槽会和活跃槽抢位置。

3. **usage 不编数字**：工具边界返回 `usage_status:"deferred"` 而不是填 0（`usage.ts:5-12`），字段缺失整个省略。我们的 `parseSdkUsage` 已经是「四个桶少一个就返回 undefined」，口径一致，保持。

4. **`TOOL_BATCH_SETTLE_MS=1500`**：它实测同轮并行工具回调间隔 Sonnet 318–697ms、Fable 713–1189ms，所以 100ms 级别的窗口会把并行批次切碎。我们的 `PARALLEL_TOOL_SETTLE_MS = 25` 明显偏小 —— 但这只影响「一次 HTTP 能否收齐并行工具」，不影响缓存，作为独立小项记录，不进本方案的关键路径。

### 3.5.3 它踩的坑，我们的方案天然避开或必须避开

| 它的缺陷 | 证据 | 我们的处置 |
|---|---|---|
| **`tenantScope = 上游账号指纹`** → 多账号池 100% 失效 | Issue #20 生产数据：5 账号池 **293 条决策 / 0 次 resume**，send_chars 中位 25,397、p90 197,431、max 672,557。credential-free 复现：1 账号 → 3 次 resume；5 账号 → **0 次**。作者未回复、直接 close，main 0.4.0 仍未修 | **这正是我们 §2.2 包 B 的内容**：`conversation_id` 派生串必须是 `ownerHash（客户端身份）\0 identity \0 model`，**绝不能混入上游 Cursor key 指纹**。注意我们现在的 Hub 键 `durable-id.ts:14-19` 恰好混了 `input.apiKey`（上游 key）—— 在 `fill-first` + session affinity 下通常稳定，但一旦轮询换 key 或粘性绑定过期（默认 1 小时），Hub 键就会变，同样踩这个坑。**Connect 路线的 `conversationIdFor` 不含 apiKey，天然避开。** |
| **anchor 用 `result.result`，而流式客户端只收到 delta 拼接** | `event-pump.ts:172` vs `writer.ts:72-76`（#20 Defect 4，未修） | 我们是流式客户端，会直接踩。本方案不用 assistant 文本做身份 —— identity 来自请求头/首条 user，与 assistant 输出无关，天然避开 |
| **anchor 含 `thinking` 且 block 顺序敏感** | `cursor-agent-turn.ts:82-127` | 同上，我们不拿 assistant 内容做身份 |
| **`turnIndex` 靠 `role==="user"` 计数** | `cursor-agent-turn.ts:276`，被 tool_result / 角色改写 / 客户端压缩各踩一次 | 我们不用轮次序号 |
| **`traceOrdinary` 裸 `catch {}`** | `run-coordinator.ts:500-508`，#20 提交者因此误判「请求没到网关」 | 直接对应我们包 D：诊断路径绝不能静默失败。这也是用户「后台没 log」的同类症状 |
| **patch `node_modules` 把 `x-cursor-client-type` 从 sdk 改成 sand** | `sand-patch-contract.ts:22-41`，改 SDK bundle 并锁 sha256 | 我们已有正规的 `sand-client.ts` loader hook，不改 node_modules。ToS 风险自负那部分不采纳 |

### 3.5.4 它没有回答的问题（所以不能替代本方案的阶段 0）

- **上游是否真把 agentId 当 xAI 服务器亲和键**：该仓库零讨论，无法交叉验证。
- **缓存命中率的绝对数字**：live smoke 只把 `cache_read` 放进 `counts` 不进 `ok` 判定，**全仓没有任何「命中率 X%」或「省了多少 token」的公开数字**。所以「SDK 路线做对了能到多高」仍是未知，只知道「> 0」。
- 它对 `conversation_id` / `cache_control` / `requestContextBlobTransportMode` **零认知**（三个标识符全仓零命中）—— 它是靠复用 agent 间接稳定 conv id，没有主动控制这一层。

结论：它把 SDK 路线的**会话复用**做到了上限，值得抄的具体做法见 §3.5.2；但它并未触达「主动控制上游会话身份」与「结构化历史」这两层，因此不改变本方案的选择。**它最大的贡献是那 8 行断连处理和 Issue #20 那份生产数据** —— 前者我们立刻采纳，后者证明「把上游账号指纹混进会话身份」是一个已被生产验证的错误。

## 3.6 参照实现二：`fitchmultz/pi-cursor-sdk`

不是网关（是 pi 编码代理的 provider extension，README 明文拒绝做协议翻译，把「OpenAI 兼容 Cursor 代理」这类需求推给别的项目），但它同样 pin `@cursor/sdk@1.0.27`、同样面对「无状态调用 vs 有状态 Agent」，且**独立地走到了和 `cursor-sdk2api` 几乎一样的架构**。315 star / 55 fork / 34 open issues，最后 push 2026-08-18（约两周半无新提交，此前节奏很密）。

### 3.6.1 两个项目独立收敛到同一套做法 —— 这是本方案 §3.5.2 的交叉验证

| 维度 | `cursor-sdk2api` | `pi-cursor-sdk` |
|---|---|---|
| 进程内复用同一 `SDKAgent` | 血缘指纹命中即 `{type:"existing"}` | `sessionAgentsByScope` 池，`status==="ready"` 即复用（`cursor-session-agent.ts:139,567-569`）|
| 跨进程 | `Agent.resume(parent.agentId)` | `Agent.resume(resumeHandle.agentId)`（`:496-509`），**默认开启** |
| 复用键 | lineageKey（含 historyDigest / toolCatalogDigest）| poolKey = `scopeKey \0 cwd \0 model \0 settingSources \0 localSafety \0 http1 \0 sha256(apiKey)[:16] \0 工具面签名`（`:214-229`）|
| 只发增量 | 复用路径只发最后一条 user | bootstrap / incremental 双模（`context.ts:377-402` vs `:404-443`）|
| 前缀分歧检测 | historyDigest 不匹配即冷重建 | `{systemHash, messageHashes[]}` 指纹：systemHash 变 / 消息变少 / 前缀被改写 → re-bootstrap（`context.ts:338-367`）|
| 是否传 `agentId` | 否 | 否（知道能传，`cursor-session-agent-resume.ts:16` 有注释，但从未用）|
| `conversation_id` / `cache_control` / `blobEncryptionKey` | 全仓零命中 | 全仓零命中 |

两个互不相关的项目、不同产品形态，都收敛到「池化复用 + resume + 增量 send + 前缀指纹」这四件事上。这把 §3.5.2 从「一个项目的经验」升级为**这条路径的共识做法**。

### 3.6.2 它提供了我们最缺的一件东西：外部实测的命中率数字

`cursor-sdk2api` 全仓没有命中率数字。`pi-cursor-sdk` 的 issue #196 报告者顺手测了一组，现在固化成 fixture（`test/fixtures/cursor-sdk-turn-ended-usage-1.0.23.json`）：

> 同一个 pooled agent：turn-001 `cacheRead: 0 / cacheWrite: 46944`；turn-002 `cacheRead: 42036 / inputTokens: 46965` → **约 90% 命中**

这是「复用同一 agent 就能拿到高命中」的第一份可核对的外部证据。注意它同时**推翻了我们的一个记账假设**：那份 fixture 里 `inputTokens` 是**整个 prompt**，`cacheRead/cacheWrite` 是它的**划分**而非**加项**。而我们的 `parseSdkUsage`（`cursor-runner.ts:1617`）算的是 `totalTokens = input + output + cacheRead + cacheWrite` —— 若上游确实是「划分」口径，我们的 total 会把缓存部分重复计一遍。SDK 自己的 `toTokenUsage` 也是相加口径，两者矛盾。**这条必须实测确认**（见 §3.6.5），它直接影响后台命中率分母对不对。

### 3.6.3 blobEncryptionKey 的自动复用得到第二份独立确认

两个项目都零处理 `blobEncryptionKey`，但都通过 `Agent.resume` 白拿了它。`pi-cursor-sdk` 的调查从 SDK dist 读出更完整的链路：create 时 `metadata[pt] = blobEncryptionKey`，resume 时 `{blobEncryptionKey: ft(s.metadata)}` —— `ft` 从 store metadata 读回，**合法就复用，缺失才新生成**；`SqliteLocalAgentStore` 双向映射 `sdkMetadata ↔ record.metadata` 落盘。

**这一条对我们有一个直接后果**：我们 `index.ts:138` 注入的是 `createEphemeralAgentStore()`（有界**内存** store，进程重启即失）。也就是说即使我们将来走 resume，**跨重启也拿不回 blob key** —— 内存 store 里没有 metadata 可读。`pi-cursor-sdk` 用的是**持久 per-session SQLite store**（`cursor-session-store.ts:44-47`，且刻意不共用 workspace 级 `index.db`，避免并发争锁）。若走 SDK 回退路线，这是必须一起改的。

### 3.6.4 它踩的坑与我们的处置

| 缺陷 | 证据 | 处置 |
|---|---|---|
| **每 20 次增量强制重建** | `cursor-session-send-policy.ts:12,28` `MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP = 20`，注释理由是「tool-call behavior drift」，**与缓存无关** | 不抄。代价是每 20 轮缓存归零 + 新 blob key。若真需要防漂移，阈值应远大于 20 且可配 |
| **`settingSources: ["all"]` + 真实 cwd + 不用 `disallowedTools`** | README:337；`cursor-session-agent.ts:161`；`buildAgentOptions()` 无 disallowedTools | **与 `cursor-sdk2api` 完全相反**，前缀不稳定（git status / 项目规则每轮都活）。它是刻意的产品取向（"let Cursor remain Cursor"）。我们已经是 `settingSources: []` + 容器内 `/workspace`（`docker-compose.yml:17`）＝ 空目录，方向正确，**保持不变** |
| **不传 `agentId`** | `cursor-session-agent.ts:481-492` 的 `buildAgentOptions()` 无 `agentId` | 两个参照项目都没传。但 SDK **公开支持**（`options.d.ts:335`）。见 §3.6.6 —— 这是它们都漏掉的杠杆 |
| **usage 三道 gate 丢掉真实数据** | issue #219：1036 条消息只 1.4% 带非零 cacheRead，根因是 `contextWindow` guard 拿累积多步值比单请求容量。#219/#245/#246 至今 open、作者 0 回复 | 不抄。我们原样记 `turn-ended.usage`，不加二次校验 |
| **monkey-patch `globalThis.setTimeout`** 绕 SDK 的 MCP 60s 硬超时 | `cursor-mcp-timeout-override.ts:32-51`，按栈匹配 `@cursor/sdk` + `_setupTimeout` + `callTool` | 不抄（进程级全局副作用）。但**这个 60s 超时对我们同样存在**：SDK bundle `318.js` 里 `const g = n?.timeout ?? 6e4` 就是 MCP 请求默认超时。见 §3.6.5 第 2 项 |
| **loopback MCP 靠不可猜路径当凭据** | `cursor-pi-tool-bridge-run.ts:93` `http://127.0.0.1:<随机端口>/<uuid>/mcp`，防护只有回环地址校验，**无 Authorization** | 我们用 `local.customTools`（进程内回调，不开端口），无此风险。保持 |
| **按栈帧形状白名单抑制 uncaughtException** | `cursor-sdk-process-error-guard.ts`；issue #174→#194→#182→#195 一路追着 SDK 形状变 | 不抄。我们已有 `index.ts:49` 的 `unhandledRejection` 兜底 + 截断日志，方向对 |

### 3.6.5 它暴露的两个我们需要自己验证的点

1. **usage 口径：`cacheRead` 是 `inputTokens` 的划分还是加项？** 见 §3.6.2。做法：真机跑一轮有缓存命中的请求，把 `turn-ended` 原始 payload 打进日志（包 D 的 telemetry 顺带记），核对 `inputTokens` 是否已含 `cacheReadTokens`。**若是划分口径，`parseSdkUsage:1617` 的 `totalTokens` 与后台命中率分母都要改。**

2. **SDK 的 MCP 调用默认 60s 超时会不会掐断我们的 held execute。** 我们的 path A 让 `customTools.execute` 返回一个挂起的 Promise，等下一条 HTTP 来 resolve，`CURSOR_SDK_TOOL_HOLD_TTL_MS` 默认 15 分钟。但 SDK bundle `318.js` 的 MCP 请求默认 `timeout ?? 6e4`（60 秒）。`pi-cursor-sdk` 正是因为撞上这个才去 monkey-patch。
   我们的 `customTools` 走的是 `extraMcpTools` 通道（`357.js` 把它并进 `custom-user-tools` server，服务名常量在 `:116287`），**是否同样经过那个 60s 计时器尚未确认**。若经过，则「客户端执行工具超过 60 秒」会让 execute 被 RequestTimeout 打断 —— 这在 Claude Code 跑长 bash 时很常见。
   **验证方式**：单测里让 execute 挂起 70 秒，看是否收到 `RequestTimeout`。这条与本方案的 provider 选择无关，但影响工具路径的正确性，列为独立小项。

### 3.6.6 两个参照项目都漏掉的杠杆：直接传 `agentId`

它们都靠「先 create、再赌 resume 命中」来间接稳定上游 conversation_id。但 `AgentOptions.agentId` 是**公开字段**（`node_modules/@cursor/sdk/dist/esm/options.d.ts:335`），可以直接传一个由会话身份派生的确定性值：

```
agentId = `agent-${stableUuid(ownerHash \0 identity \0 model)}`
```

这样上游 conversation_id 从「赌复用命中」变成「确定性可控」。约束：同 id 二次 `create` 会抛 `Agent ${id} already exists`（SDK bundle `index.js` 的 `createAgent`），所以正确用法是**首次 create、后续 resume**，与我们已有的 `ensureDurableSlot → tryResumeDurableSlot` 结构天然契合。

**这是 SDK 回退路线（§4 表格第一行）的关键改进**，把它从「上限被钉死」提升到「能主动控制上游会话身份」。若阶段 0 的 Connect 门闩不通过，这条 + §3.6.3 的持久 store 就是次优方案的核心。

## 3.7 参照实现三：逆向 Connect RPC 家族（五个项目）

不走 `@cursor/sdk`，直接手搓 `aiserver.v1.ChatService/StreamUnifiedChatWithTools`。调查了 5 个：`wisdgod/cursor-api`（694★，已归档）、`7836246/cursor2api`（1887★）、`NGLSG/Cursor2API`（65★）、`egoist/cursor-openai-api`（37★）、`zhx47/cursor-api`（268★）。

### 3.7.1 最重要的发现：`wisdgod` 用另一套机制实现了我们已有的 held execute

`src/core/stream/session.rs` + `service.rs:376-409,896-918`：流结束时若有 pending tool_call，**把上游双向流 park 起来**（不 drop，塞进 stash —— `stream/droppable.rs`），下一轮只往还开着的流里写一个 `ClientSideToolV2Result` 帧。键是 pending tool_call_id **排序后**拼接再 `xxh3_64`（`session.rs:41-50`，排序保证顺序无关），TTL 300s。

它是五个逆向项目里**唯一**做到这件事的。而我们的 SDK 路线**已经有等价能力**（held execute / path A，单测锁死 `http2.runId === http1.runId` 且只 send 一次）。

**这条直接决定了路线选择** —— 见 §1.5.1：Connect 单发单收结构上做不到，工具续轮必须重发全量历史。这是本次修订的核心依据。

### 3.7.2 会话标识：逆向路线的主流做法和我们一样错

| 项目 | 字段 | 生成 | 稳定？ |
|---|---|---|---|
| `wisdgod` | `StreamUnifiedChatRequest.conversation_id`（field 23）| `traits.rs:169` ← `service.rs:368` `Uuid::new_v4()` | ❌ 每请求随机 |
| `egoist` | `AgentRunRequest.conversation_id`（field 5）| `proxy.ts:544` `crypto.randomUUID()` | ❌ |
| `zhx47` | `ChatMessage.conversationId`（field 15）| `utils.js:26` `uuidv4()` | ❌ |
| `7836246` | JSON `id` | `converter.ts:1383` `sha256(system前500 + 首条user前1000)` | ✅ **内容派生** |
| `NGLSG` | field 23 | `cursor.ts:60-62`，`x-session-affinity` 等头驱动 | ✅ 条件稳定 |

**7836246 的动机值得注意**：它做内容派生是为了修 issue #56「`/clear` 后上下文残留」—— 即 conversation_id 确实影响**服务端会话状态**。但**没有任何项目证明它影响 prompt 缓存**，这两件事在 Cursor 上游可能独立。所以稳定 conv id 是「有理由做」而非「已证明有效」。

两个可抄的细节：
- `NGLSG:worker/cursor.ts:1076-1079` 的 `stableUuid` 把 sha256 前 32 hex 格式化成**合法 uuid 形状**，不直接塞裸 hex（上游可能不认）。我们 `cursor-connect/provider.ts:205-211` 已有同款实现。
- 内容派生只取 system 前 500 + 首条 user 前 1000 字符 —— 比我们 L3 的「instruction 前 50 rune + **完整**首条 user」更抗长首条消息，但区分度更低。两者各有取舍，不必改。

### 3.7.3 `should_cache` 存在，但不在我们能用的通道上

`wisdgod/lite.proto:601` 有 `optional bool should_cache = 13`，它硬编码 `Some(true)`（`traits.rs:155`）。我在本地 SDK bundle 里核对：该字段属于 `StreamChatRequest` / `GetPromptRequest` 这类 **ChatService 消息**，而 `agent.v1.AgentRunRequest`（SDK 实际发的）**没有任何缓存开关字段**。

所以「显式要求缓存」这个杠杆在 SDK 路线上不可达。但也没证据表明它有效（零项目做过 A/B，README/issues 零讨论，可能已废弃）。**不作为路线选择依据。**

### 3.7.4 `PrewarmRequest`：一个零项目用过的低成本验证路径

我在本地 SDK bundle 核对确认：`agent.v1.AgentClientMessage` 的 field 8 就是 `prewarm_request`，`PrewarmRequest` 含 `{model_details, requested_model, conversation_id, conversation_state, mcp_tools, custom_system_prompt, ...}` 共 26 个字段 —— **与 `AgentRunRequest` 高度同构**。五个逆向项目零调用，SDK 也不发。

它的存在本身是一条证据：**上游会为「一个 conversation_id + conversation_state」做预热，说明 conversation_id 是服务端状态/亲和键，不只是日志标签。** 这间接支持阶段 1' 的确定性 agentId。

但它在 SDK 公开 API 上不可达（`AgentClientMessage` 是内部 wire 类型），所以只是**佐证**，不是可执行项。

### 3.7.5 `bubble_id`：一个我们看不见但可能重要的维度

`lite.proto:624-625,651-652` 有 `bubble_id` / `server_bubble_id`，还有 `full_conversation_headers_only`（field 30，只含 bubble_id + type 的轻量头列表）。`wisdgod` **每轮把所有历史消息的 bubble_id 全部重新生成**（`adapter.rs:277-291`）—— 如果上游按 bubble 粒度做增量识别，这等于每轮宣布「这是全新历史」。**明确的反面教材。**

本地核对：SDK bundle 里 `bubble_id` 只出现在 `ReportAgentMessageFeedbackRequest` / `StreamChatResponse` / `ConversationSummary` 这些 **ChatService / 反馈类**消息上，`agent.v1` 的 turn 结构不含它。**所以这个维度对 SDK 路线不适用**，记录备查。

### 3.7.6 其余可抄 / 不该抄

**可抄**：
- `GetPromptDryRun` 当 token 探针（`wisdgod/service.rs:2254-2340`）—— 已并入阶段 2'，但需先确认 SDK 路线可达性。
- 真实缓存用量查询（`wisdgod/utils.rs:424-472`，POST `cursor.com/api/dashboard/get-filtered-usage-events`）—— 与我们 `UsageReconciler` 同类，可作交叉校验源。已并入阶段 2'。
- tool id 打包（`utils/tool_id.rs:5-25`，用分隔符把 tool_call_id + model_call_id 打包成单个对外 id，无状态还原）—— 我们已有 `callAliases` 机制，等价。
- `egoist` 的 system prompt 内容寻址（`proxy.ts:502-509`，sha256 当 blob id，上游 KV 握手才索要内容）—— 天然去重，但那是 `agent.v1` blob 通道，SDK 已自动处理。

**不该抄**：
- `bubble_id` 每轮重生成（§3.7.5）。
- `NGLSG` 全量 flatten 成一条字符串 + 塞假的 agent 模式 few-shot。
- `7836246` 那套 prompt 工程补丁：伪造工具协议、few-shot、拒绝话术正则清洗、**虚增 input_tokens 骗客户端提前压缩**。它的上游是 cursor.com 文档问答口，不是真 agent，一条都不适用。
- `wisdgod` 的 OpenAI 流式路径**丢 thinking**（`service.rs:595-760` 只处理 Content/ToolCall/StreamEnd；非流式 `:1019` 收进 `thinking_text` 后从未使用），只有 Anthropic 路径完整。
- 断连处理：`wisdgod` 完全没有断连监听，`7836246` 只有 idle timeout，`egoist` 的 ReadableStream 不实现 `cancel()` 且 bridge 子进程与 heartbeat 都泄漏。**五个逆向项目里没有一个做对**，唯一做对的是 `cursor-sdk2api`（§3.5.2 第 1 项，即我们的阶段 -1）。

### 3.7.7 若真要走 ChatService（第三条路，本次不选）

`wisdgod` 证明了 `ChatService/StreamUnifiedChatWithTools` 能发**完全结构化历史**（`repeated ConversationMessage`，`MESSAGE_TYPE_HUMAN`/`AI` 分开，thinking 带 `signature` + `redacted_thinking` 原样回传，`messages.rs:100-390`），且有 `should_cache`。这在协议能力上强于 Connect 的 `InferenceService/Stream` 和 SDK。

但它需要：`WorkosCursorSessionToken` + 17 个 header + `x-cursor-checksum`（`common/utils/checksum.rs:1-60` 的滚动异或算法，`NGLSG:worker/cursor.ts:1057-1074` 独立逆向出同一结果）。且**同样丢掉 held execute**，除非把 `wisdgod` 的 park-stream 机制一起实现。

**结论：协议能力最强，但工程量最大且要自建凭据体系。只在 SDK 主线与 Connect 备选都不达标时才考虑。**

## 4. 为什么不选其它路线


| 备选 | 否决理由 |
|---|---|
| 继续修 SDK durable Hub（补 `markIdle`、认 agent-id、首发带历史） | 能缓解，但**上限被 SDK 钉死**：`conversation_id` 只能通过 agentId 间接控制且必须先 create 后 resume；`x-blob-encryption-key` 无公开 options 可达；`requestContextBlobTransportMode` 恒为 legacy 导致整个 `RequestContext`（env / git status / notes 路径）**每轮全量内联进前缀**，而 `git status` 每次 execute 重算 —— agent 自己改一个文件就打断下一轮缓存。这条路修完仍是「靠上游状态 + 进程内锁」，499 只能靠补丁绕。<br>**参照实现 `cursor-sdk2api` 就是这条路的上限**（§3.5）：它做到了活体复用 + resume + 空 workspace + 只发增量，实测 `cache_read > 0`，但全仓没有任何命中率数字，且多账号池下因把上游账号指纹混进会话身份而**完全失效**（293 决策 / 0 resume）。它的会话复用值得抄，路线选择不改。 |

| 只修 499（保持 flatten） | 那正是现在的状态：为消 499 把并发请求改成 stateless flatten，把并发问题换成了每轮全量重发的计费问题（B 行 17 万 token）。 |
| 开 `CURSOR_CONNECT_SEND_TOOLS` 走工具循环 | 「同 conv_id 第二次 Stream 能否接续」未实测，声明工具会让模型发起一轮网关接不住的调用。Claude Code 自己执行工具，不需要它。 |
| 填 `cache_control` | descriptor 里有字段，但是否生效无任何证据，且它是 Anthropic 语义 —— 当前模型是 Grok。先拿到命中率基线再谈。 |
| 加 `x-grok-conv-id` 头 | 我们打的是 Cursor（api2.cursor.sh），不是 xAI。该头是 xAI 侧的，网关无法越过 Cursor 直接设置。稳定 `conversation_id` 是我们能触达的等价杠杆。 |

### 4.1 一条被否决的假设，记录在此以免重复调查

**H1「被取消的 run 不写入缓存」——不成立。** 曾怀疑：网关在 stateless 路径上一见工具调用就 `run.cancel()`，若上游只在 run 正常结束时才写缓存，则每轮大请求都写不进去、下一轮也读不到。四条独立证据否掉它：

- Anthropic 官方推荐的预热做法就是发 `max_tokens: 0` 的请求——「API 跑 prefill，**在 cache_control 断点写入缓存**，然后立刻返回 `content: []` 与 `stop_reason: "max_tokens"`」。一个什么都没生成、根本没正常完成的请求照样完整写入缓存。
- 可读时点是「**首个响应开始流式输出之后**」，门槛是「开始流」不是「结束」。观测行 B 有 385 output token，说明 prefill 早已完成、decode 已开始流，写入窗口在 `cancel()` 之前就打开了。
- 生命周期从「写入或读取该条目的**请求开始**」算起，不是从完成算起。
- 引擎层（vLLM 设计文档）：块在分配时即入缓存，请求结束也不删缓存，且释放是逆序入队——**前缀块最后才被逐出**。

所以「cancel 导致缓存写不进去」这条路不必修。真正成立的是它的变体：cancel → dispose → 下一轮 `Agent.create` 开新 agent/新 conversation，换掉了上游亲和键 —— 那就是 §1.3 第 1 条，本方案正面解决它。


## 5. 风险与未知

| 项 | 状态 |
|---|---|
| `exchange_user_api_key` 真机可用性 | **未验证**，阶段 0 门闩 |
| Cursor 是否把自己的 `conversation_id` 映射成 xAI 的服务器亲和键 | 无公开证据。这是本方案效果的主要不确定性 —— 但即使不映射，「结构化历史 + 只追加 + 不截断 system」这三条本身就直接满足 xAI 的前缀缓存要求 |
| descriptor 与线上 schema 对齐 | `cursor-connect-proto.test.ts` 用独立解析器逐条比对 54 messages / 4 enums，可信；但「descriptor == 线上」只在 3.18.9 成立，真机只验到「不是 415」+「401」 |
| `cursor-connect-proto.test.ts` 在干净 clone 上会红 | fixture 在 `docs/reference/`，被 `.gitignore` 排除。修法：把 descriptor 挪进 `tests/fixtures/` 或让该测试在缺 fixture 时 skip |
| Connect 侧 cost 补写永远为空 | `server.ts:921-947` 依赖 `telemetryRef.agentId`，Connect 从不写。只影响金额列，token 用量不受影响 |
| URL 图片 | `request-builder.ts:187` 直接 400；带图 URL 的请求会失败。包 A 第 5 点处理 |
| 两条路线并存的代价 | key 池两套独立（`cc_credentials` vs `cursor_keys`），粘性两套机制，`usage_source` 硬编码 `"sdk"`（实义是「上游上报」）。请求日志加 provider 列后即可分桶 |
| 并发同前缀互相读不到对方正在写的条目 | Anthropic 官方明文「N 个并发请求带相同前缀会全部付全价，谁都读不到别人还在写的东西」。你现在每轮三条请求、30~60 秒一批，若近似并发就会命中这条。包 B 让主/子代理拿到不同 conv id 之后，它们本就该是不同前缀，此风险随之下降；若观测期仍见批量 0 命中，再考虑同一 conv id 内串行化（先发一条、等首字节再发其余）|
| Cursor Grok 4.6 不是 xAI 原生 grok-4.6 | Cursor 员工明确说是「a different configuration」（256k vs 500k 窗口）。所以 xAI 文档只能作强参考，不是字面契约。128 分块这条有强提示（观测到的 5,248 = 41×128，社区多条 Cursor cache read 也都是 128 整数倍）但未被 Cursor 官方确认 |
| `fast` 与非 `fast` 是否共享缓存池 | 未知。Cursor 有先例：Composer 2 缓存恒 0 而 Composer 2 Fast 正常，员工确认是「a backend caching issue specific to Composer 2」。当前用的是 `-fast` 变体；若观测期命中率仍不动，把「切非 fast 变体」作为一次对照实验 |
| 换模型必丢缓存 | Cursor 员工原话：前缀缓存绑定具体模型，换模型即重置。所以 `model` 必须进 conv id 派生串（现已如此），且同一段对话内不要切模型 |

### 5.1 观测数据的另一种解读（不影响方案，但影响预期）

Cursor 官方对「cache read 巨大而 input 小」的口径是：**面板一行 = 一次用户轮次内所有 LLM 调用的聚合**。支持工程师原话：「你看到的数字是**每一次 LLM 调用**的合计，不是单次调用……假设第一条消息发 20k 上下文，整轮需要 10 次 LLM 请求，你会看到 20k input 和大约 180k cached」。这解释了为什么单行总量能超过模型上下文窗口。

对我们的意义：那三条记录（1.1万 / 17.2万 / 2.8万）**可能不是三个独立请求，而是三个用户轮次的聚合**。17.2 万那条 Cache Read 彻底为 0 仍然异常——按聚合口径，它至少该命中与 1.1 万那条同量级的公共头部。所以 §1.3 的四条根因不受影响，但「修好之后单行数字会变多大」不好预测，验收只能看**比值**而不是绝对值。


## 6. 一句话

**先把 SDK 路线修对，而不是换路线。** 四条根因（conv_id 每轮变、中断毁槽、新槽无历史、主/子代理撞键）全部在我们自己的代码里：`AgentOptions.agentId` 是公开字段可直接传确定性值、断连不毁槽只要 8 行、认 `x-claude-code-agent-id` 即可分开子代理。两个独立开源项目收敛到同一套复用做法且有 ≈90% 命中的外部实测背书。而 Connect 单发单收会**丢掉我们已有的 held execute**（工具续轮从「几百字节」变回「重发全量历史」），对 Claude Code 这种工具密集客户端是净损失 —— 所以它降为备选，在 SDK 主线修完仍不达标时才启动。


