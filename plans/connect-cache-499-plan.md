# Debug 模式 / 499 / 轮次错位 / Bot 工具 / 运行设置隔离 / 额度分桶 —— 修复计划 v2

> 版本基线：当前工作区（HEAD，含 `855fc50 feat: reuse durable agents from protocol identity waterfall` + `9bd6a38 fix: keep durable agents across turns and client disconnects`）。
> 部署：`git pull` + `sudo docker compose up -d --build`。
> 本文档只给**一个**方案，被否决的替代路线在 §4 说明。
>
> **硬约束：durable / reuse（park + 复用 agent）策略不许删、不许绕过。** 它是「缓存命中 + 模型能力接近原生」的唯一来源。
> 本计划所有改动要么不碰 park 路径，要么只在其上加**一致性护栏与回退**，绝不移除复用。
>
> v2 相对 v1 的改动见 §0。v1 的三包（A 设置隔离 / B 额度禁用 / C 499）保留了两包半，
> 但 **499 那一包的根因是错的**，另外补了三件 v1 完全没有的事。

---

## -1. 背景（新会话先读这一节）

### -1.1 这个项目是什么

一个 Docker 部署的 API 网关，把 Cursor Composer 包成 OpenAI / Anthropic 兼容接口。对外三套协议端点：
`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（另有 `/v1/messages/count_tokens`、`/v1/models`）。
带一个 `/admin` 后台：Cursor Key 池、入站网关密钥、请求日志、运行设置、Bot 凭据。
实际使用场景以 **Claude Code 指向本网关**为主，所以 Anthropic 协议与工具循环的保真度是硬指标。

### -1.2 两条上游通道（本计划反复提到的 sdk / bot）

| 通道 | 标识 | 实现 | 说明 |
|---|---|---|---|
| **SDK** | `provider = "sdk"` | `src/cursor-runner.ts` + `@cursor/sdk@1.0.27` | 主通道，durable / reuse 就长在这条上 |
| **Bot** | `provider = "bot"`，模型 id 前缀 `bot/` | `src/cursor-bot/*` | 直连 Cursor Connect 协议，不经过 SDK |

Bot 通道的协议要点（逐条实测得出，缺一不可）：

- 路由 `POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`（旧路由 `/agent.v1.AgentService/Run` 已废弃）
- Connect JSON 流，请求体要加 **5 字节信封头**（`0x00` + uint32be 长度），裸 JSON 会报 `protocol error: incomplete envelope`
- `Authorization: Bearer <session 型 JWT>`。浏览器 cookie 的 web 型 token 只能过 AuthService，敲 Stream 必 16
- `x-cursor-checksum` 必带，缺失会被当旧客户端报 `ERROR_OUTDATED_CLIENT`
- 参考资料：`docs/sand_patch.txt`、`docs/cursor_proxy.txt`、`docs/reference/*`
- 命名沿革：`d33b96f` 引入时叫 Connect，`a7abfcc` 改名 Bot；`8bb3304` 删除了 Sand 通道。
  **老文档与老账本里的 `cursor-connect` / `connect/` / `sand` 字样指的就是今天的 bot。**

### -1.3 durable / reuse：本仓最重要的既有资产

同一段对话复用同一个上游 Agent，**每轮只发增量而不是全量 transcript**，从而拿到 prompt cache 命中，
模型表现接近原生。构件：

- `src/durable-id.ts` —— 会话身份瀑布（显式会话头 / Responses 继承 / CPA DeriveID），Hub 键 === `agent-`+uuid
- `src/session-hub.ts` —— 会话槽、互斥锁、held execute、TTL / LRU 回收
- `src/prompt-delta.ts` —— `extractDurableTurn`，把入站 transcript 算成本轮增量
- `src/agent-store.ts` —— `agents.sqlite` 持久化（含 `blobEncryptionKey`，丢了缓存就失效）
- `src/cursor-runner.ts` —— `streamDurable` / `runDurableLocked` / `consumeDurablePump` / `parkKeepAlive` / `parkPathB`

实测收益记在 `plans/connect-cache-499-ledger.md`（第二轮缓存命中 ~46%，同一 agent 不再 drop+create）。

> **硬约束：不得删除、关闭或变相削弱 reuse。** 若某个修复看上去需要关掉它，那就是方案错了，不是约束错了。

### -1.4 这份计划从哪来

用户对网关提了五组问题：Bot/SDK 运行设置不隔离、额度耗尽不立即禁用且不分额度桶、
Bot 代理出来的 API 工具调用不可用、全局性的 499、没有 debug 模式。
上一版计划（v1）写了三包，经评审发现 499 根因定错、额度分桶与需求相互矛盾、debug 与 Bot 工具两件事完全缺失。
本文件是 v2，六包；§0 是逐条差异，§1 是带 `file:line` 证据的根因，§7 是未证实清单。

### -1.5 关键文件地图

| 文件 | 职责 |
|---|---|
| `src/server.ts` | 三套协议端点、SSE 生成器、请求日志、`streamAbort`、选路接线 |
| `src/cursor-runner.ts` | SDK 通道 runner，durable 主逻辑 |
| `src/session-hub.ts` | durable 会话槽与锁 |
| `src/key-pool.ts` | Cursor Key 池、失败分类、自动禁用 |
| `src/key-rotating-runner.ts` | 换 key 重试 |
| `src/cursor-bot/*` | Bot 通道（transport / envelope / checksum / tool-loop / response-normalizer / service / store） |
| `src/admin.ts` / `src/admin-ui.ts` | 后台 API 与单文件前端 |
| `src/store.ts` | SQLite（请求日志、key、设置）与列迁移 |
| `src/types.ts` | `GatewayConfig` / `CursorRunRequest` / `RequestLogRecord` 等共用类型 |

### -1.6 环境、命令与基线

- 主目录 `E:\docker-composer-api`，Windows + Git Bash；Node 锁 `>=22.13`，镜像 `node:22-bookworm-slim`
- 部署：`git pull` + `sudo docker compose up -d --build`
- 测试：`npm test`（= `npm run build && node --test dist/tests/*.test.js`）
- 类型：`npx tsc --noEmit -p tsconfig.json`
- **测试基线**：754 tests / 751 pass / **fail 1** / 2 skip。那 1 条红是 `tests/proxy.test.ts:237` 的 SOCKS
  `getaddrinfo ENOTFOUND example.test`，环境问题，**不算本任务的锅**。只认增量红。
- 当前 HEAD `de188c9`，`main` 领先 `origin/main` 1 个提交；工作区有未跟踪的 `grok-500k-context/` 等，与本任务无关

### -1.7 干活约束

1. **不得删除或削弱 durable / reuse**（见 -1.3）。
2. 改文件前先读文件。
3. 中文回复。
4. 不擅自 `commit` / `push`，除非用户明说。
5. 改完跑 `npx tsc --noEmit` 与 `npm test`，并与上面的基线对比。
6. 本文 §7 里的假设未经包 D 关闭前，相关包不得宣布「已修复」。

---

## -1. 背景（新会话先读这一节）

### -1.1 这个项目是什么

一个 Docker 部署的 API 网关，把 Cursor Composer 包成 OpenAI / Anthropic 兼容接口。对外三套协议端点：
`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（另有 `/v1/messages/count_tokens`、`/v1/models`）。
带一个 `/admin` 后台：Cursor Key 池、入站网关密钥、请求日志、运行设置、Bot 凭据。
实际使用场景以 **Claude Code 指向本网关**为主，所以 Anthropic 协议与工具循环的保真度是硬指标。

### -1.2 两条上游通道（本计划反复提到的 sdk / bot）

| 通道 | 标识 | 实现 | 说明 |
|---|---|---|---|
| **SDK** | `provider = "sdk"` | `src/cursor-runner.ts` + `@cursor/sdk@1.0.27` | 主通道，durable / reuse 就长在这条上 |
| **Bot** | `provider = "bot"`，模型 id 前缀 `bot/` | `src/cursor-bot/*` | 直连 Cursor Connect 协议，不经过 SDK |

Bot 通道的协议要点（逐条实测得出，缺一不可）：

- 路由 `POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`（旧路由 `/agent.v1.AgentService/Run` 已废弃）
- Connect JSON 流，请求体要加 **5 字节信封头**（`0x00` + uint32be 长度），裸 JSON 会报 `protocol error: incomplete envelope`
- `Authorization: Bearer <session 型 JWT>`。浏览器 cookie 的 web 型 token 只能过 AuthService，敲 Stream 必 16
- `x-cursor-checksum` 必带，缺失会被当旧客户端报 `ERROR_OUTDATED_CLIENT`
- 参考资料：`docs/sand_patch.txt`、`docs/cursor_proxy.txt`、`docs/reference/*`
- 命名沿革：`d33b96f` 引入时叫 Connect，`a7abfcc` 改名 Bot；`8bb3304` 删除了 Sand 通道。
  **老文档与老账本里的 `cursor-connect` / `connect/` / `sand` 字样指的就是今天的 bot。**

### -1.3 durable / reuse：本仓最重要的既有资产

同一段对话复用同一个上游 Agent，**每轮只发增量而不是全量 transcript**，从而拿到 prompt cache 命中，
模型表现接近原生。构件：

- `src/durable-id.ts` —— 会话身份瀑布（显式会话头 / Responses 继承 / CPA DeriveID），Hub 键 === `agent-`+uuid
- `src/session-hub.ts` —— 会话槽、互斥锁、held execute、TTL / LRU 回收
- `src/prompt-delta.ts` —— `extractDurableTurn`，把入站 transcript 算成本轮增量
- `src/agent-store.ts` —— `agents.sqlite` 持久化（含 `blobEncryptionKey`，丢了缓存就失效）
- `src/cursor-runner.ts` —— `streamDurable` / `runDurableLocked` / `consumeDurablePump` / `parkKeepAlive` / `parkPathB`

实测收益记在 `plans/connect-cache-499-ledger.md`（第二轮缓存命中 ~46%，同一 agent 不再 drop+create）。

> **硬约束：不得删除、关闭或变相削弱 reuse。** 若某个修复看上去需要关掉它，那就是方案错了，不是约束错了。

### -1.4 这份计划从哪来

用户对网关提了五组问题：Bot/SDK 运行设置不隔离、额度耗尽不立即禁用且不分额度桶、
Bot 代理出来的 API 工具调用不可用、全局性的 499、没有 debug 模式。
上一版计划（v1）写了三包，经评审发现 499 根因定错、额度分桶与需求相互矛盾、debug 与 Bot 工具两件事完全缺失。
本文件是 v2，六包；§0 是逐条差异，§1 是带 `file:line` 证据的根因，§7 是未证实清单。

### -1.5 关键文件地图

| 文件 | 职责 |
|---|---|
| `src/server.ts` | 三套协议端点、SSE 生成器、请求日志、`streamAbort`、选路接线 |
| `src/cursor-runner.ts` | SDK 通道 runner，durable 主逻辑 |
| `src/session-hub.ts` | durable 会话槽与锁 |
| `src/key-pool.ts` | Cursor Key 池、失败分类、自动禁用 |
| `src/key-rotating-runner.ts` | 换 key 重试 |
| `src/cursor-bot/*` | Bot 通道（transport / envelope / checksum / tool-loop / response-normalizer / service / store） |
| `src/admin.ts` / `src/admin-ui.ts` | 后台 API 与单文件前端 |
| `src/store.ts` | SQLite（请求日志、key、设置）与列迁移 |
| `src/types.ts` | `GatewayConfig` / `CursorRunRequest` / `RequestLogRecord` 等共用类型 |

### -1.6 环境、命令与基线

- 主目录 `E:\docker-composer-api`，Windows + Git Bash；Node 锁 `>=22.13`，镜像 `node:22-bookworm-slim`
- 部署：`git pull` + `sudo docker compose up -d --build`
- 测试：`npm test`（= `npm run build && node --test dist/tests/*.test.js`）
- 类型：`npx tsc --noEmit -p tsconfig.json`
- **测试基线**：754 tests / 751 pass / **fail 1** / 2 skip。那 1 条红是 `tests/proxy.test.ts:237` 的 SOCKS
  `getaddrinfo ENOTFOUND example.test`，环境问题，**不算本任务的锅**。只认增量红。
- 当前 HEAD `de188c9`，`main` 领先 `origin/main` 1 个提交；工作区有未跟踪的 `grok-500k-context/` 等，与本任务无关

### -1.7 干活约束

1. **不得删除或削弱 durable / reuse**（见 -1.3）。
2. 改文件前先读文件。
3. 中文回复。
4. 不擅自 `commit` / `push`，除非用户明说。
5. 改完跑 `npx tsc --noEmit` 与 `npm test`，并与上面的基线对比。
6. 本文 §7 里的假设未经包 D 关闭前，相关包不得宣布「已修复」。

---

## 0. v2 相对 v1 的差异

| v1 的结论 | 核对结果 | v2 的处置 |
|---|---|---|
| 499 来自 `withStreamLog()` 的兜底 `client disconnected before the stream completed`（`src/server.ts:1092`） | **错**。线上日志文案是 `Request was aborted.`，只可能来自 `reportStreamError`（`src/server.ts:1275-1283`）。两条路径被 `finishLog` 幂等 + `!log.finished` 守卫互斥 | 包 C 重写，改判据而不是改日志 |
| 499 是「成对日志 / 双记」 | **错**。499 与 200 是两条独立 HTTP 请求（499 那条 tokens「未记录」，200 那条有完整用量），时间升序是「先 499 后 200」 | 删掉「双记」说法；§5 的双记断言作废 |
| 「客户端断连后不再单独记 499，只要有 semantic output 就走 `pathBDone()`」 | **已经做过了**（`cursor-runner.ts:891-895`、`967-971`、`1020-1030` 的 `parkKeepAlive`） | 从计划中删除，避免重复劳动 |
| §2/§3.3 要改 abort 行为，§6 又说「只在日志里打 reason，park 路径保持原样」 | **自相矛盾** | v2 明确：**不改 park 行为**，只改 abort 的**触发判据** |
| 额度耗尽「立即 `disable(id, "quota")`」 | 与用户「按打进来的模型禁用对应额度桶、不要盲目禁 key」的要求**冲突**；`getCursorModelQuotaType` 在 v1 里只用于打日志，分桶逻辑白写 | 包 B 重写，补数据模型 / 选 key / 恢复路径 |
| 「从目录里看 `cursorModel` / `vendorId` / `included` / `usageBased`」 | **字段不存在**。`AvailableModelsResponse.AvailableModel`（`src/cursor-bot/proto/available_models_pb.ts:349-489`）只有 `price` / `vendor` / `vendorName` / `degradation_status` 等 | 改为「人工维护表 + `vendor`/`price` 兜底推断」 |
| 包 A「最简单、无副作用」 | 偏乐观。要动 `config.ts` env、`gateway-settings.ts` 的 DB 设置行、admin-ui 现有表单 | 补迁移方案，落地顺序后移 |
| §5「`tests/server.test.ts` 增加 499 断言」 | **测不出来**。全套网关测试走 `app.inject()`（`tests/` 里除 `proxy.test.ts` 自建 net server 外无任何真实 `listen`），模拟 socket 的 `destroyed` 语义与真实 Node HTTP server 不同 | §5 重写测试策略 |
| debug 模式 | v1 **完全没提**，而 `src/**/*.ts` 里 `debug` 命中 0 次 | 新增包 D，且排在最前 |
| Bot 工具调用不可用 | v1 只在测试章节提了一句，无任何修复项 | 新增包 F |
| 轮次错位 / 空轮次送到上游 | v1 完全没提 | 新增包 E（**严重度仅次于 debug**，见 §1.2） |

---

## 1. 根因

> 每条给 `file:line` 证据。**未证实的一律标注「假设（待包 D 验证）」**，不做「已核实、无遗漏」这类断言。

### 1.1 499：请求进网关 5-10ms 内被本地 abort，从未打到上游

**已确认的事实链：**

1. 日志文案 `Request was aborted.` 来自 `reportStreamError`（`src/server.ts:1275-1283`）：
   `aborted = statusCode===499 && signal.aborted`，纯断连无 `signal.reason`，于是原样落 499。
   返回 `undefined` ⇒ 不写流内错误事件；`finishLog` 幂等 ⇒ `withStreamLog` 的兜底（`src/server.ts:1092`）不会再记一条。
2. 0.0s + 无 agentId + 用量「未记录」⇒ runner 第一次被拉取时 `signal` 已 aborted，
   直接命中 `src/cursor-runner.ts:120`（或 durable 的 `:1049`）抛 499。**上游没被调用过。**
3. 全网关唯一能在 0ms 置 aborted 的只有 `streamAbort` 的早退分支：

   ```ts
   // src/server.ts:1136-1144
   const socket = request.raw.socket;
   const onClose = () => { clearTimeout(timer); socket?.removeListener?.("close", onClose); controller.abort(); };
   socket?.once?.("close", onClose);
   if (request.raw.destroyed || socket?.destroyed) onClose();
   ```
4. 旁证：`plans/connect-cache-499-ledger.md:221` 已记过「额外流式 abort 脚本在 3ms 就 499（零语义输出，走旧路径）」。
5. 该分支**零测试覆盖**：现有 499 用例（`tests/server.test.ts:1654 / 3274 / 3456`）全是直接构造已 abort 的 signal 注入，不经过 `streamAbort`。

**完整会话取样（2026-09-08 22:20:33 → 22:23:25，单一用户请求的全部网关行）把两件事定死了：**

- **不是偶发，是确定性的 1:1**。该窗口内 9 个成功 200 对应 9 条 0.0s 的 499，一个不少。
  每条 499 都落在「上一次 200 结束 / 下一次 200 开始」的同一秒；早先 19:56 那组采样里两者相隔 7s，
  499 落在**下一次 200 开始前 1s**，所以 499 归属于**下一个请求的头**，不是上一个的尾。
- **499 行不是日志伪影，是真实的独立入站请求**。`persistHandlerError`（`src/server.ts:699-715`）在已有 log 时
  直接 return，而它造的 stub **不写 `model` 字段**；观测到的 499 行却带着 `claude-opus-5`、网关 key 与流式标记，
  说明它们都走过 `beginLog`（`:770-786`）。同时它们的 agent id 列为空、用量未记录，
  印证了「进了 handler、没进 runner」。

**由此得出的完整形态（首选假设）：每一个客户端请求都会先被网关在 0ms 误杀一次，客户端 SDK 自动重试，重试才成功。**
重试之所以能成功，最可能是它开了**新连接**，而被误杀的那一发复用的是上一轮的 keep-alive 连接——
这也解释了为什么是 100% 而不是偶发。对用户的直接代价：**每一轮都白搭一个往返 + 一次 SDK 重试退避**。

**被误杀的那一发，客户端实际收到的是一段截断的 SSE（已读代码确认，非推测）：**

`anthropicStream` 先 `yield message_start`（`src/server.ts:1486-1498`），**之后**才进 `for await (const event of input.events)`
（`:1517`）去拉 runner。而 0ms abort 恰好在第一次拉取时抛出。于是：

1. `sendSse` 已提交响应 → 客户端收到 **HTTP 200 + 完整的 SSE 头**；
2. 客户端收到一条 `message_start`；
3. 然后连接直接 EOF：**没有 `message_delta`、没有 `message_stop`、也没有 `error` 事件**
   （`reportStreamError` 对 abort 返回 `undefined`，`:1281-1282` 有意不写流内错误）。

即：**网关内部记的是 499，但对客户端呈现的是一个 200 开头、半途断掉的流**。
Anthropic SDK 把它当连接错误 → 重试 → 重试成功。这就是 1:1 重试的机制。

**推论（待包 D 坐实，但直接影响优先级）：§1.2 那个「多余的尾部请求」很可能也是它的下游。**
客户端在截断流上可能已经落下一个空的 / 未完成的 assistant 消息，重试成功后 transcript 多了一截，
于是它再发一发去「接着写」—— 而那一发没有新的用户消息，就撞上了 400 / 空轮次。
**若成立，修好包 C 会连带消掉 400 与幻影空轮次，包 E 则从「修复」降为「兵库式护栏」。**

### 1.1.1 提交考古（`git log -S`，已核）

| 东西 | 引入提交 |
|---|---|
| `request.raw.destroyed \|\| socket?.destroyed` 这个误判 | `2a26ed7 fix(api): align outbound wire format with OpenAI and Anthropic specs` |
| `const abort = streamAbort(...)` 调用点 | `0bbf31b feat: upgrade @cursor/sdk to 1.0.27…` |
| `scopedModelIdentity`（streamAbort 前的 await） | `da57217 优化` |
| `noteDurableIdentity`（streamAbort 前又一道处理） | `9bd6a38` |
| `deferRunnerStream` | `855fc50` |

**结论：错误的判据本身早就存在（`2a26ed7`，远早于 durable），但 `855fc50` 改变了它的发作形态。**

`855fc50` 之前是 `openRunnerStream`：**先预取 runner 的首个事件，成功了才提交 SSE**。
预取阶段报错走 `catch` → `finishLog` → `throw resolved` → Fastify 错误处理器 → 客户端收到**一个真正的 HTTP 错误响应**。
`855fc50` 换成 `deferRunnerStream`：runner 到第一次 `next()` 才启动，而那时 `message_start` 早已出门、SSE 已提交。
于是同一个 0ms abort 从「干净的 HTTP 错误」变成了「200 + 半截流」，而半截流正好是 SDK 重试的触发条件。

**所以用户的直觉是对的，但不能回滚 `855fc50`。** 它本身修的是另一个真问题：
旧注释写得很清楚——「等首个上游事件太久才提交 SSE 时，Claude Code / CLIProxyAPI 会按 TTFB 断连，网关日志就是 499」。
回滚等于把 TTFB 499 换回来。正确做法是**保留早提交 SSE，同时修掉误判**（包 C），并补上下一条防御：

**包 C 追加一条**：`reportStreamError`（`src/server.ts:1275-1283`）现在把「signal.aborted」等同于「客户端已走」，
因此不写流内 error 事件。误判场景下客户端**还连着**，这一假设不成立。
改为按真实 socket 状态判断：客户端仍在线就必须发一个规范的 `error` 事件再收尾，绝不能裸 EOF。

**假设（待包 D 验证）：** `request.raw.destroyed` 是误判源。`request.raw` 是 `IncomingMessage`，
Node ≥16 起它在**请求体被读完之后**即为 `true`，并不代表连接断开；项目锁 Node ≥22.13（`package.json:27`、`Dockerfile:2`）。
POST body 被 Fastify 解析完，到 handler 调 `streamAbort` 之间隔着 `await scopedModelIdentity(...)`（`src/server.ts:391`），
这段时序竞争能同时解释：偶发、0ms、SDK 与 Bot 都有（这行在共用的 `server.ts`）、durable 两个 commit 之后变明显（它们在 `streamAbort` 之前加了 await）。

正确判据应为 `socket.destroyed`，或 `request.raw.destroyed && !request.raw.complete`。

**与 durable 无关。** 这条路径在 `streamAbort` 里，早于任何 Hub / park 逻辑。修它不需要碰 reuse。

### 1.2 轮次错位：网关会把「空的 / 不对应本次请求的」轮次送给上游（新增，严重）

**一手证据（已复现两次）：** 2026-09-08 的评审会话中，上游模型两度收到**内容为空的用户轮次**（~14:14、~14:17 UTC），
而用户两次都确认未发送任何消息。即：网关侧凭空产生了上游调用。这不是日志问题，是**正确性问题**。

**循环形态（用户确认）：** `对话结束 → 空用户轮次 → 再次结束 → 400`。

**三次复现的计数与时序规律（~14:14 / ~14:17 / ~14:22 UTC，新增，比「含工具调用」更锐利）：**

- **与真实用户消息 1:1**。每一条真实用户消息之后恰好跟一个幻影轮次；
  而幻影轮次之后的助手轮次**不会**再产生下一个幻影。即：不是无限循环，是**每次真实请求被复制成两份**。
  （这条反例排除了「含工具调用就触发」：幻影后的那两个助手轮次同样调了工具，却没有幻影。）
- **落地时点不是固定延迟，而是「前一个助手轮次刚好结束那一刻」**（两分钟的长轮就等两分钟）。
  这指向「第二份请求被串行阻塞在第一份后面，锁释放才被服务」，而不是客户端独立发起的定时重试。
  候选阻塞点：`hub.acquire(durableId, signal)`（`src/cursor-runner.ts:253-255`、`src/session-hub.ts:363`）。
  **判别器**：该分支只对 `tool_results` 类型的轮次阻塞等锁，`new_user` 走的是非阻塞 `tryAcquire`。
  所以包 D 快照里这两份请求各自被归为哪种 `durableTurn.kind`，直接决定阻塞假设成不成立。

尾巴那条 400 已抓到：

```
09/08 22:19:06  /v1/messages  claude-opus-5  gateway  env-sk-***  400  0.0s  …  Empty durable turn: the last user message is unchanged.
```

**这条 400 是决定性证据，它证明：**

1. 确实存在一次**真实的额外入站 HTTP 请求**（它进了 `request_logs`），不是网关内部凭空多驱动一次 Run。
2. 报错来自 `runDurableLocked` 的两个 400 分支之一（`src/cursor-runner.ts:294-296` 的 `kind==="empty"`，
   或 `:300-307` 的 `new_user` 且 `turn.userText === slot.lastUserText`）。
   **两个分支抛的是完全相同的字符串**，目前无法从日志区分—— 这本身是个得先修的可诊断性缺陷。

**因果链（已根据 22:23 那组采样修正）。** 早前版本把 400 归因于「499 污染了 `lastUserText`」，那是错的：
采样显示 499 请求**从未进入 runner**（agent id 为空、用量未记录），它根本谈不上调用
`touchSlotHistory`（`src/cursor-runner.ts:398`），也就污染不了任何东西。真正的链是：

1. 本轮请求正常成功（200），`sendRecoverable` 之后 `touchSlotHistory(slot, userText)` 把
   `slot.lastUserText` 写成本轮文本。**这是正常行为。**
2. 助手轮次结束后，客户端**又多发了一发**，而这一发没有新的用户消息。
3. 这一发照例先被 0ms 误杀成 499（§1.1），SDK 重试。
4. 重试进入 `runDurableLocked`，`userText === slot.lastUserText` → 命中 `:300-307` → **400**。

所以 499 与 400 不是因果关系，而是**同一个「多余的尾部请求」先后经历的两道关卡**。
根因分两层，必须分别修：

- **为什么每一发都先 499** → §1.1，包 C。
- **为什么助手轮次结束后还会多出一发** → 尚未定位；它才是「空轮次」与 400 的源头。
  当前最可能：客户端认为上一条 SSE 流没有正常收尾（`message_stop` 缺失，或被 0ms abort 干扰）而补发一次。
  **包 D 必须把这一发的完整入站 body 落盘**，看它到底带没带新的用户消息。

**仍未解释的缺口：** 上游到底怎么收到一个**真空轮次**而不是被 400 拦住的。
`kind:"empty"` 在 `:294` 就抛 400，按理说到不了上游。候选：slot 被重建导致 `lastUserText === undefined`
后落入 `formatDurableUserMessage({ userText: turn?.userText ?? "" })`（`:385-396`），或 held execute 续跑多驱动了一次
（`:347-367`）。见 §7 第 3 / 3b。

**机理（部分确认 + 部分假设）：**

- durable 路径对上游只发**增量**，不发完整 transcript：`extractDurableTurn`（`src/prompt-delta.ts:48-88`）
  只取最后一条用户消息，历史全靠 park 住的 agent 自己记。
- 送出的文本是 `formatDurableUserMessage({ firstSend, userText: turn?.userText ?? "", systemText })`
  （`src/cursor-runner.ts:385-396`）。**`turn` 缺失或 `userText` 为空时，送出的就是一条空用户消息。**
- 唯一的「历史是否还对得上」护栏是 `inboundHistoryIncompatible`（`src/session-hub.ts:241-255`），
  但它 `if (!issued.length) return false` —— **纯文本对话（从未发生工具调用）完全不做一致性检查**。
- `kind:"empty"` 的 400 守卫（`src/cursor-runner.ts:294-307`）只覆盖「最后一条用户消息与上轮完全相同」，
  不覆盖「slot 的上游历史已与客户端 transcript 分叉」。
- 与 1.1 的联系（假设，待验证）：0ms 499 之后客户端会重试；重试打到一个**已 park、仍持有上一轮 Run** 的 slot 时，
  `consumeDurablePump`（`src/cursor-runner.ts:874-1030`）可能把**上一轮**残留的事件当作本轮输出排空 ——
  这正好解释线上那些「0.0s、有 token 估算、却不可能真生成完」的 200 行。

**结论：一个会静默送出空轮次的 reuse 路径，比缓存未命中更糟。** 但**解决办法不是关掉 reuse**，
而是加「证明不了一致就退回 stateless 全量」的护栏（包 E）。

### 1.3 Bot 代理下工具调用不可用

现象（用户提供）：在 Claude Code 里走 bot 路，模型把 `<invoke name="Bash">…` 当**正文**吐出来，随后会话终止。

根因（已确认代码，效果待包 F 实测）：

- `botSendTools` 默认 **false**：`src/config.ts:72` `booleanValue(env.CURSOR_BOT_SEND_TOOLS, false)`。
- ⇒ `src/cursor-bot/provider.ts:137` 不给上游带 `tools`。
- ⇒ `src/cursor-bot/service.ts:166` `orchestratedTools()` 直接 `return []`。

模型没被告知有工具可用 → 自己编 XML → 网关没有 `tool_use` 可回 → Claude Code 收到纯文本就停。

### 1.4 运行设置 SDK / Bot 不隔离

- `requestModelControls()`（`src/server.ts:1606-1615`）只读 `config.cursorFastPolicy` / `cursorMaxModePolicy` /
  `cursorReasoningEffort` / `cursorAgentMode` / `cursorModelParams`，**不区分 provider**。
- 调用点 `src/server.ts:945` 与 `selectProvider(...)`（`:931`）在同一个函数里，**`selection.provider` 当场就能拿到** ——
  改造只需把它传进去。（v1 写的 `prepared.provider` 这个字段不存在。）
- Bot 自己的 `sendTools` / `botCodec` 在后台只读回显（`src/admin-ui.ts:1084`），无独立可写表单。
- 自动禁用阈值 `autoDisableThreshold`（`src/types.ts:56`）全局一份。

### 1.5 额度耗尽不会立即禁用，且没有额度分桶

- SDK：`classifyKeyFailure()`（`src/key-pool.ts:525-538`）能把 402 / unpaid invoice 判成 `quota`，
  但 `reportFailure()`（`:397-408`）仍要 `failures >= policy.threshold` 才 `disable`。
- Bot：`noteFailure()`（`src/cursor-bot/service.ts:499-509`）**只认 401/403**，且 `CREDENTIAL_FAILURE_LIMIT = 5`（`:64`）；
  `resource_exhausted` 映射成 429（`src/cursor-bot/errors.ts:35`），既不计数也不禁用。
- 没有 cursor models / other models 的额度桶概念，key 记录里也没有承载它的字段。
- **注意**：402 `unpaid invoice` 是**账号级欠费**（整把 key 该禁），与**某个额度桶耗尽**（只该禁那个桶）是两回事，不能用同一条规则。

---

## 2. 方案总览（六包，按依赖排序）

| 包 | 内容 | 依赖 | 碰 park 吗 |
|---|---|---|---|
| **D** | Debug 模式：全链路请求/响应/网关决策落盘 | 无 | 否 |
| **C** | 499：收紧 `streamAbort` 的断连判据 | D（取证） | 否 |
| **E** | 轮次一致性护栏 + 不一致时退回 stateless | D | **加护栏，不删复用** |
| **F** | Bot 工具链打通 | D | 否 |
| **A** | SDK / Bot 运行设置隔离 | 无（可并行） | 否 |
| **B** | 额度分桶 + 立即禁用 | A（共用设置面） | 否 |

---

## 3. 详细实施

### 3.1 包 D：Debug 模式（**先做，其余包的取证基础**）

**为什么排第一**：`src/**/*.ts` 里 `debug` 命中 0 次；1.1 的根因假设、1.2 的机理、1.3 的修复效果，
全都只能靠它确认。v1 把最需要证据的 499 排在最后，却没安排任何取证手段。

1. 开关：`GATEWAY_DEBUG`（env）+ 后台可切换的运行时开关（存 `gateway-settings.ts`，与 `autoDisableThreshold` 同机制）。
   默认关。开启后按 owner / endpoint / 模型可过滤，避免全量刷盘。
2. 落盘内容（每请求一条 JSON，带 `logId` 与 `request_logs` 关联）：
   - 入站：完整 headers（`authorization` / `x-api-key` 掩码）、完整 body。
   - 选路：`selectProvider` 结果、选中的 key（掩码）、`durableSessionId`、`reuseDurableAgent`、`durableTurn.kind`。
   - **上游实际发出的轮次全文**（`formatDurableUserMessage` 的产物 / Bot 的 Connect 请求体）—— 这是 1.2 的关键证据，不能只记摘要。
   - abort 归因：触发 `onClose` 的分支、`request.raw.destroyed` / `request.raw.complete` / `socket.destroyed` 三个值、`signal.reason`。
   - 出站：SSE 逐事件 / 非流式响应体、`finishLog` 的 status 与 error。
3. 存放：`dirname(SQLITE_PATH)/debug/<date>/<logId>.json`，带条数与总体积上限 + LRU 清理（复用包 M3 的有界回收思路）。
4. 后台：请求日志「详情」里加「Debug 快照」页签，直接读这条 JSON。

**安全**：session token / API key / `sessionToken` 一律掩码，与 `maskKey`（`src/key-pool.ts:540`）同一套。
debug 文件不进 git，`.gitignore` 补一条。

**验收**：开关打开后，能对一条 499 请求答出「是哪个分支 abort 的、三个 destroyed 值分别是什么」。

### 3.2 包 C：499

1. 用包 D 的 abort 归因确认 1.1 的假设。
2. 确认后，把 `src/server.ts:1144` 的判据从 `request.raw.destroyed || socket?.destroyed`
   收紧为 `socket?.destroyed === true || (request.raw.destroyed && !request.raw.complete)`。
   保留原注释想解决的问题（监听注册前就真断连），只是不再把「body 读完」当成断连。
3. `request_logs` 增加 `abortReason` 列（`client_disconnect` / `idle_timeout` / `upstream_canceled` / `local_abort`），
   后台在 499 行展示。迁移与 `provider TEXT` 同一套 `migrateRequestLogColumns`。
4. **不动** `parkKeepAlive` / `parkPathB` / `pathBDone` 的任何行为。

**验收**：正常流式请求（客户端不断连）不再出现 0ms 499；真断连仍记 499 且 `abortReason=client_disconnect`；
空闲超时仍记 504。

### 3.3 包 E：轮次一致性护栏（**不删 reuse**）

1. **禁止发空轮次**：`src/cursor-runner.ts:385-396`，`userText` 为空且无 images 且非 `tool_results` 时，
   不得 `send`。此时按「不一致」处理（走第 3 步），并在包 D 快照里标红。
2. **补齐一致性检查**：`inboundHistoryIncompatible`（`src/session-hub.ts:241-255`）当前在 `!issued.length` 时直接放行，
   纯文本会话完全没有护栏。改为额外比对「入站 transcript 里上一条 assistant 文本」与 slot 记录的上一轮输出摘要
   （哈希即可，不存原文）；对不上 ⇒ `history` 不兼容。
3. **不一致时的行为**：退回 `streamLocked({ ...input, forceStateless: true })`（这条路径已存在，见 `src/cursor-runner.ts:264`），
   即本轮发全量 transcript。**只牺牲这一轮的缓存命中，不销毁 agent、不关闭 reuse。**
   同时 `recordDurableDecision({ decision:"fallback", reason:"history_mismatch" })`，让 `/health` 与后台能看到发生频率。
4. **park 住的 Run 与新请求的绑定**：`consumeDurablePump` 排空 pump 前，校验 pump 里的事件属于当前 `runId`；
   属于上一轮的残留事件必须丢弃而不是当作本轮输出。（这条直接对应线上那些 0.0s 的 200。）
5. **「没有新用户消息」不是错误，是「本轮不适用增量」**—— 本包最关键的一条。
   `src/cursor-runner.ts:294-296` 与 `:300-307` 现在都直接抛 400，把客户端的正常重试打成硬失败。改为：
   - **先让两个分支抛不同的 message / code**，否则日志里分不清是哪条（一行改动，最先做）。
   - `kind==="empty"`（入站请求真的没给新内容）→ 维持 400，但文案要说清是请求体本身无可发送内容。
   - `new_user` 且 `userText === slot.lastUserText`（**重试**）→ **不得 400**。这一轮的消息上游其实已经收到，
     正确动作是继续消费该 slot 的输出（park 住的 Run / pump）；拿不到就退回 stateless 全量重跑，绝不报错。
6. **`slot.lastUserText` 的写入时机**：`touchSlotHistory(slot, userText)`（`:398`）在 send 之后立即写，
   于是「已发给上游但客户端一个字没拿到」的中断会留下污染记录（§1.2 因果链第 1-2 步）。
   改为分开记「已发送」与「已向客户端交付过语义输出」两个状态，重试时据此决定是续播还是重发。
7. **held execute 续跑只能被驱动一次**：`resolvePending` 成功后走 `markRunning` + `consumeDurablePump`
   （`:347-367`）继续同一个 Run。加幂等标记（键：`runId` + 已解决的 execute id 集合），
   避免上游多收到一个无输入的轮次（§1.2 未解释缺口的候选之一）。

**验收**：包 D 快照里，每一次上游调用都能对上一条客户端请求，且没有空 `userText` 的 send；
`hitRatio` 不得因本包显著下降（下降说明护栏过严，需要调哈希口径而不是撤护栏）。

### 3.4 包 F：Bot 工具链

1. 先做最小验证：`CURSOR_BOT_SEND_TOOLS=true` 跑一遍 Claude Code 的工具循环，用包 D 快照看
   （a）上游请求里有没有 `tools`；（b）上游回的是结构化 tool call 还是正文 XML。
2. 若上游回结构化 → 只需把默认值改掉 + 在包 A 的 Bot 表单里暴露开关。
3. 若上游仍回正文 XML → 走 `parseToolMarkers` / `keepDeclaredOnly` 那条已有的 marker 解析链
   （SDK 侧同款逻辑在 `src/cursor-runner.ts:979-991`），在 `src/cursor-bot/response-normalizer.ts` 里补等价还原，
   把正文里的调用还原成 `tool_use` 块。
4. `src/cursor-bot/tool-loop.ts` 的多轮工具循环要能在 Anthropic 协议下把 `tool_result` 正确回灌。

**验收**：Claude Code 走 `bot/*` 模型，能完成「列目录 → 读文件 → 回答」的至少三轮工具循环，不出现正文 XML。

### 3.5 包 A：SDK / Bot 运行设置隔离

1. `GatewayConfig`（`src/types.ts`）下拆 `sdkConfig` / `botConfig`，各自持有
   `cursorFastPolicy` / `cursorMaxModePolicy` / `cursorReasoningEffort` / `cursorAgentMode` / `cursorModelParams` /
   `autoDisableKeys` / `autoDisableThreshold` / `requestTimeoutMs`；`botConfig` 另含 `botSendTools` / `botCodec`。
2. `requestModelControls(request, config, model)` 增加 `provider: GatewayProvider` 参数，
   调用点 `src/server.ts:945` 直接传 `selection.provider`（`:931` 已算好）。
3. **迁移**：`config.ts` 的旧 env 名保留为两侧的共同默认值（不破坏现有部署）；
   `gateway-settings.ts` 里已存的旧 setting key 读取时映射到 `sdkConfig`，写入时按新 key 双写一个版本，
   一个版本后再删旧 key。**升级不得让线上现有设置回默认值。**
4. `admin.ts` / `admin-ui.ts` 拆成「SDK 运行设置」「Bot 运行设置」两块，Bot 的 `sendTools` / `botCodec` 改为可写。

### 3.6 包 B：额度分桶 + 立即禁用

1. **先分类，再决定禁什么**：
   - **账号级**（402 unpaid invoice / payment required）⇒ 立即整把 `disable(id, "quota")`，不看阈值。
   - **桶级**（某类模型额度耗尽）⇒ 只把该 key 的**该桶**标记为耗尽，key 保持 active。
   - auth 类 ⇒ 维持现有阈值累计逻辑（`autoDisableThreshold` 字段只留给它）。
2. **数据模型**（v1 缺失）：`cursor_keys` 增列 `exhaustedBuckets TEXT`（JSON：`{"other":"2026-10-01T00:00:00Z"}`，值为过期时间）。
   写 `migrateCursorKeyColumns`，`MemoryStateStore` 同步。
3. **选 key**：`effectiveScope()`（`src/key-pool.ts:456`）之外增加一层过滤 ——
   本次请求模型所属桶已耗尽且未到期的 key 不参与候选。全池都耗尽时按原顺序照常尝试（不能因为分桶把请求打成无 key 可用）。
4. **恢复路径**：到期自动清除；后台每把 key 提供「清除额度标记」按钮；一次成功即清掉该桶标记（与 `recordSuccess` 同处）。
5. **桶归属来源**：
   - 主：`data/model-quota-buckets.json` 人工维护表（用户已同意人工更新），后台可编辑。
   - 兜底：`vendor` / `vendorName` / `price`（`src/cursor-bot/proto/available_models_pb.ts:467-471, 368-369`）推断，
     推断不出按 `other` 处理（更保守）。
   - **不要**写「从目录里读 `usageBased` / `included`」—— 这些字段不存在。
6. **与现有优先级的关系**：`classifyKeyFailure` 里 `upstream_run_failed` ⇒ `transient` 优先于 quota（`src/key-pool.ts:528`）。
   新的「立即禁用」必须明确插在这条**之后**（即仍先排除 transient），否则会把上游临时故障当成欠费。
7. **Bot 侧**：`noteFailure`（`src/cursor-bot/service.ts:499-509`）接受 429 `resource_exhausted`，但**必须先排除非额度来源**：
   本地 `EnvelopeTooLargeError` 也要求映射成 `resource_exhausted`（`src/cursor-bot/envelope.ts:35`）。
   判据写死：**只有上游 EndStream 帧带回来的 `resource_exhausted` 才算额度**，本地抛的一律不算。
8. **双向联动**：bot 凭据因额度停用时，通过 `sourceCursorKeyId`（`src/cursor-bot/store.ts:292`）同步标记对应 key 的桶；
   反之 SDK 侧标记桶时，同步标记由该 key 兑换出来的 bot 凭据。

---

## 4. 被否决的替代路线

- **关闭 / 弱化 durable reuse 来消灭 499 与轮次错位**：reuse 是缓存命中与「接近原生能力」的唯一来源，代价不可接受。
  且 499 的根因在 `streamAbort`，与 reuse 无关 —— 关掉它 499 照旧。
- **只把 499 从日志里隐藏**（v1 包 C 第 3 步）：499 是真实失败的请求，隐藏后失去唯一证据，问题变成不可观测。
- **所有失败都立即禁用 key**：会误杀协议非法（多 system / 同角色 / 超长）与本地 envelope 超限触发的 `resource_exhausted`。
- **额度耗尽一律整把禁 key**：与「按模型禁对应额度桶」的要求冲突；一把 key 的 cursor models 额度往往还能用。
- **先做包 A/B 再做 debug**：A/B 不需要证据也能做，但 C/E/F 三包没有 debug 就只能靠猜 —— v1 的顺序问题正在于此。
- **靠 `app.inject()` 覆盖 499**：模拟 socket 的 `destroyed` 语义与真实 server 不同，永远测不出真问题（见 §5）。

---

## 5. 测试策略

**v1 的 §5 不成立**：全套网关测试走 `app.inject()`（`tests/` 里除 `proxy.test.ts` 自建 net server 外无任何真实 `.listen`），
light-my-request 的模拟 socket 与真实 Node HTTP server 在 `request.raw.destroyed` / `socket.destroyed` 上行为不同，
现有 499 用例（`tests/server.test.ts:1654 / 3274 / 3456`）全是注入已 abort 的 signal，**绕过了出问题的那段代码**。

| 包 | 单测 | 集成 / live |
|---|---|---|
| D | 掩码不泄漏 token；体积上限与 LRU 清理 | 手动开关一次，检查快照字段齐全 |
| C | 新增 `tests/server-http.test.ts`：**真实 `app.listen(0)`**，发正常流式 POST（客户端不断连），断言不出 499；再发一条中途 `req.destroy()` 的，断言记 499 且 `abortReason=client_disconnect` | `scripts/live-durable-smoke.mjs` 跑一遍，`request_logs` 里 0 条 0ms 499 |
| E | 历史分叉 ⇒ 走 stateless 回退且 slot 存活；空 `userText` ⇒ 不 send；上一轮残留事件不计入本轮 | Claude Code ≥20 轮真实对话，包 D 快照逐条核对「上游轮次 ↔ 客户端请求」一一对应 |
| F | `response-normalizer` 把正文 XML 还原成 `tool_use` | Claude Code 走 `bot/*` 完成三轮工具循环 |
| A | provider 不同 ⇒ 解析出不同 `ModelIntent`；旧 setting key 迁移后值不变 | 后台两张表单互不影响 |
| B | 402 ⇒ 整把禁；桶耗尽 ⇒ key 仍 active 但该桶不被选中；到期自动恢复；本地 `EnvelopeTooLargeError` **不**触发禁用 | 后台手动清除标记 |

**基线**：`npm test` 当前 754 tests / 751 pass / **fail 1**（`tests/proxy.test.ts:237` SOCKS `ENOTFOUND example.test`，环境红项）/ 2 skip。
只认**增量**红。

---

## 6. 落地顺序与风险

1. **包 D**（debug）—— 无行为改动，纯增量，风险最低，且是后面三包的前提。
2. **包 C**（499）—— 单行判据 + 一列日志，不碰 park，但**性价比最高**。
   它不只是消掉日志里的红字：按 §1.1 的量化，现在**每一个客户端请求都白搭一个往返加一次 SDK 重试退避**；
   若 §1.1 末尾那个推论成立，它还会连带消掉 400 与幻影空轮次。
   风险：判据收得过松会让真断连变成 504 空转，由 `abortReason` 统计兜底观察。
3. **包 E**（轮次一致性）—— **本计划风险最高的一包**。护栏过严会拉低 `hitRatio`，
   缓解：护栏只触发「本轮退回 stateless」，不销毁 agent、不关 reuse；`recordDurableDecision` 全量打点，
   上线后先看 `fallback/history_mismatch` 的占比再调哈希口径。**任何情况下不得以「简化」为由删除 park。**
4. **包 F**（Bot 工具）—— 独立，可与 E 并行。
5. **包 A**（设置隔离）—— 破坏性在配置迁移，不在逻辑；必须验证升级后线上既有设置不回默认值。
6. **包 B**（额度分桶）—— 依赖 A 的设置面；需要 DB 迁移，要先在测试库验证 `migrateCursorKeyColumns`。

---

## 7. 未证实清单（上线前必须由包 D 关闭）

| # | 假设 | 关闭方式 |
|---|---|---|
| 1 | 0ms 499 的直接原因是 `request.raw.destroyed` 在 body 读完后为 true | 包 D 打出 abort 分支与三个 destroyed 值 |
| 2 | 线上 0.0s 却有 token 估算的 200 行，是 park 住的上一轮 Run 残留事件被当作本轮输出 | 包 D 比对 `runId` 与响应内容 |
| 3 | **499 → 400 因果链**：abort 发生在 send 之后，`slot.lastUserText` 已被污染，客户端重试即撞 `:300-307` | 包 D 核对 400 请求的 transcript 与上一条 499 是否同一份；证据已很强，仍需快照坐实 |
| 3b | 真空轮次抵达上游的路径：slot 重建后 `userText` 为空仍 send（`:385-396`），或 held execute 续跑多驱动一次（`:347-367`） | 同一份快照；两条互斥，看落在哪一边 |
| 4 | Bot 工具失效只是 `botSendTools=false`，上游本身支持结构化工具 | 包 F 第 1 步实测 |

> 以上四条在关闭之前，相关包**不得**进入「已修复」状态。
