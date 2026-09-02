# 持久 Agent + 同 Run 工具往返 · 进度记录

计划见 `docs/DURABLE-AGENT-CACHE-PLAN.md`。本文档只记事实：每个工作包的状态、实际改动、验证结果、以及过程中发现的新问题。

**图例**：`未开始` / `定位中` / `执行中` / `待审阅` / `已完成` / `已搁置（附原因）`

---

## 总览

| 包 | 主题 | 优先级 | 状态 | 定位 | 执行 | 审阅 |
|---|---|---|---|---|---|---|
| WP0 | Spike：挂起 execute 能否跨两次请求 | P0 | 已完成 | 完成 | 完成 | — |
| WP1 | 配置、类型、会话键 | P0 | 已完成 | 完成 | 完成 | — |
| WP2 | 三协议 delta 抽取 | P0 | 已完成 | 完成 | 完成 | — |
| WP3 | SessionHub + 可挂起 execute | P0 | 已完成 | 完成 | 完成 | — |
| WP4 | 接入 CursorSdkRunner | P0 | 已完成 | 完成 | 完成 | — |
| WP5 | 指纹、不兼容、重启 resume、502 防护 | P0 | 已完成 | 完成 | 完成 | 完成 |
| WP6 | Key 粘性、用量、回收与泄漏 | P1 | 已完成 | 完成 | 完成 | 完成 |
| WP7 | 默认打开、文档、回归语义 | P1 | 已完成 | 完成 | 完成 | 完成 |
| WP8 | 人工验证清单 | P1 | 已完成 | — | 完成 | — |

### WP0 判决（门闩）

**held-execute: pass**

- SDK：`@cursor/sdk@1.0.27`
- live：skip（环境无 `CURSOR_API_KEY` / `CURSOR_API_KEYS`）
- 依据：live skip 且类型/源码看不出超时 → `held-execute: pass`（暂记）。WP4 按 A 实现，但必须保留 B 为 marker 旁路（计划 D18）。
- Fake mini-hub：HTTP1 停在 pending execute（不 cancel/dispose），HTTP2 resolve 后同一 Run 继续吐文本 → idle。

---

## 基线

- 仓库：`docker-composer-api`
- 计划：`docs/DURABLE-AGENT-CACHE-PLAN.md`
- 选定方案：持久 Agent + 增量 send + 同 Run 挂起 execute（WP0 fail 则 §2.1 降级 B）
- Kill switch：`CURSOR_SDK_DISABLE_SESSION_RESUME=true` 必须仍是今日 create+全文+假成功+cancel+dispose
- WP7 已翻生产默认：新部署 durable；kill switch 默认 false；`CURSOR_SDK_DISABLE_SESSION_RESUME=true` 仍锁回今日路径（测试锁定）

---

## 决策

全部已拍板，结论与理由见计划 D1–D20。主会话禁止发明第二条架构。

### 子代理 SDK 契约（宿主注入）

Task 子代理**看不到** Cursor `/sdk` skill。主会话从 WP4 起必须把下列契约贴进 prompt（本仓库走 TypeScript `@cursor/sdk`，runtime **local**，禁止 Cloud REST `POST /v1/agents`）。

- 形状是 `Agent.create` + 多次 `send`，**不要** `Agent.prompt()`（那是 create→一轮→dispose）。
- 显式 `local: { cwd, settingSources: [], store, customTools? }`。漏掉 `local` 会静默落到 local 默认；不要为此改成 `cloud:`。
- `customTools`：create/resume 时注册；后续 `send` **省略** `local.customTools`。一旦传入（含 `{}`）会**整表替换**该次 Run。resume **不持久化** inline 工具，必须再传一遍。
- `tools: ["mcp"]` 才暴露 `custom-user-tools`；无客户端工具时 `tools: []`。禁止改策略，禁止把 GetMcpTools/Task 再注册进 customTools。
- `execute` 可返回 `Promise`；结果须 JSON-serializable（`{ content: [{ type: "text", text }] }`）。无 AbortSignal。
- SDK 文档说「几乎总要 `wait()`」。**本计划覆盖**：工具挂起时本条 HTTP **不** `wait`/`cancel`/`dispose`，把 `waitPromise` 留在 SessionHub 槽上；文本终态才 `wait()`，slot=idle 仍不 dispose。kill switch / stateless 仍是今日的 wait+dispose。
- `idempotencyKey` 用稳定哈希，禁止每调用 `randomUUID()`。
- 区分 `CursorAgentError`（没跑起来）与 `result.status === "error"`（跑起来失败了）。busy/stale 走已有判定后 drop+create。

---

## 定位阶段

五路并行定位（只读，已齐）。接线地图如下。

| 覆盖范围 | 状态 | 关键产出 |
|---|---|---|
| 定位-1 runner 生命周期 | 完成 | 在 `stream` 92–109 分叉；勿改 `runWithAgent` finally |
| 定位-2 协议与会话身份 | 完成 | 三端点 prepare 后、loggedRunRequest 前插入 extractDurableTurn |
| 定位-3 工具 / key / 用量 / 配置 | 完成 | 假成功文案 tool-compat.ts:106；三处 GatewayConfig 字面量 |
| 定位-4 SDK held execute | 完成 | @cursor/sdk@1.0.27 无 execute 超时；2s live 预期可过 |
| 定位-5 回归网 | 完成 | WP7 清单：kill switch 保留 / 断言改语义 / 唯一 session |

### 接线地图（执行子代理必读）

#### A. Durable 分叉（禁止把 stateless 拆丢）

- **插入点 1（WP4）**：`src/cursor-runner.ts` `stream` **92–109**。`disableSessionResume || !durableEligible` → 今日路径 `streamLocked` → `runWithAgent` **一字不改**。durable → 新 sibling `streamDurable`（禁止在 `runWithAgent` 的 cancel/finally 里加 if）。
- `isDurableEligible`：kill switch 关 **且** 有可识别会话（sticky / conversationSeed / 显式头 / `durableTurn`）。认不出 → 仍走 `streamLocked`（D4）。
- `runWithAgent` **206–475**：stateless 全生命周期。工具三处 cancel **345 / 366 / 376** + missed **399**；`wait` **408–412**；`saveSession` **465**（disable 时跳过）；**finally 473 永远 dispose**。durable 不得共用此 finally。
- `sendWithOptionalCustomTools` **477–504**：stateless 专用。今日 `idempotencyKey: randomUUID()` **487**（customTools 重试会再生成一次 UUID）。durable 用 `sha256(sessionId + ':' + runOrdinal + ':' + kind)`。
- `sdkMessage` **547–555**：stateless 全文 `input.prompt`。durable 禁止把 `prepared.prompt`（含 ASSISTANT: / TOOLS JSON / REMINDER）交给 send。
- `agentOptions` **526–545**：`settingSources: []` **535** 保持；`tools: ["mcp"]` 或 `[]` **542** 不改。今日 customTools 只在 send；WP4 改为 create/resume 注册，后续 send **省略** `local.customTools`。
- `disposeAgent` **1199–1210**；late create **609**；late send cancel **621**。
- HTTP abort：`server.ts` socket close **866–876**、idle 504 **870**、非流 `REQUEST_TIMEOUT_MS` **835–845**。durable：RUNNING 才 cancel+drop；AWAITING_TOOLS 不 drop。

#### B. 协议 / 会话身份 / DurableTurn 插入点（WP2 纯函数，WP4 接线 server）

- `prepareOpenAiChat` `protocol.ts` **77–136**；`prepareOpenAiResponses` **138–188**；`prepareAnthropicMessages` **195–223**。flatten 保留给 stateless。
- `toRunRequest` **237–273**：尚无 `durableTurn` / `conversationSeed`。
- Chat：`server.ts` **192–217**，prepare **195**，loggedRunRequest **200–207**。**WP4 insert**：195 后、200 前 `extractDurableTurn("openai-chat", body)`。
- Responses：**219–264**，prepare **226**，seed **235**，loggedRunRequest **237–245**。**insert**：235 后、237 前，传入 `previous`。
- Messages：**312–336**，prepare **315**，loggedRunRequest **319–326**。**insert**：315 后、319 前。
- **不要**在 count_tokens **297–310** 调 extract。
- 工具结果字段：Chat `role=tool` + `tool_call_id`；Anthropic `type=tool_result` + `tool_use_id`；Responses `function_call_output` + `call_id`（`output ?? content`）。
- `stickyKeyFor` `server.ts` **731–735**：explicitSessionId > inherited seed > conversationSeed(body) > undefined。禁止 ownerHash。
- `explicitSessionId` `auth.ts` **104–119**：`x-session-affinity` / `x-opencode-session-id` / `x-opencode-session` / `anthropic-session-id`。
- `conversationSeed` `routing.ts` **42–52**；`systemSeedText` **55–80**（WP2 systemFingerprint 同一口径，需导出）。
- 文本助手：私有 `contentToTextAndImages` **1078–1098** 等。prompt-delta 可 import protocol（protocol **禁止** import prompt-delta）。若拆共享层：`src/content-text.ts`。
- Host-meta：`tool-compat.ts` **19–45**；`collectHostMetaCallIds` `protocol.ts` **983–1023**。GetMcpTools result 不得进 `toolResults`。

#### C. 工具 / key / 用量 / 配置 / store

- 假成功文案唯一出处：`tool-compat.ts` **106**：`Accepted. The caller will execute this tool and return the result in the next request. End your turn now without calling more tools.` WP3 `hold:false` 文案不变；`hold:true` 返回未 settle 的 Promise。
- `createSdkCustomTools` **82–114** 今日无 hold；生产唯一调用 `cursor-runner.ts` **225–228**。
- Key 轮换：`key-rotating-runner.ts` **82–178**。**尚无** slot 钉 key 禁换。`bindSession` **156–164**。WP6：slot 已钉则禁止轮换，401 → 502 不换 key。
- Usage：`index.ts` **153–157** `trackAgentBaseline: !cursorSdkDisableSessionResume`（今日默认 false）。durable 必须 true。
- `GatewayConfig` 全量字面量（漏字段会 tsc 失败）：`tests/server.test.ts` **34–59**；`tests/proxy.test.ts` **952–978**；`tests/gateway-keys.test.ts` **596–623**。新字段可先 `?` 可选。
- `agent-store.ts` `IDLE_TTL_MS` **58–61** 现 10min；durable 拉长 idle TTL，仍一份共享内存 store。**禁止** `index.ts` **130–140** 在 disable=false 时退回每 agent SQLite。
- SIGTERM `index.ts` **217–230**：尚无 `hub.dropAll()`（WP6）。
- Admin 联通性 `admin.ts` **632–640** 唯一 `admin-connectivity-test-${uuid}`，强制 stateless。

#### D. SDK held-execute（WP0 证据）

- `@cursor/sdk@1.0.27`。`SDKCustomTool.execute`：`options.d.ts`；返回 `SDKCustomToolResult | Promise<...>`；content 须 JSON-serializable；**无 AbortSignal**。
- 实现 `node_modules/@cursor/sdk/dist/esm/357.js` `createSdkCustomToolMcpExecutor`：**无** Promise.race / 超时包住 execute。
- 30s stall detector 针对 inbound stream 静默，**不是** execute 超时。2s live 不应因此失败。15min hold 是后续风险（D15），非 WP0 失败条件。
- Fake：无 `FakeAgent` 类。仿 `tests/server.test.ts` **3897** `FakeSdkRun`。`AgentLike` `cursor-runner.ts` **28–45**。
- per-send `customTools`：`??` 替换；省略则用 create/resume 上的表。

#### E. WP7 回归网（本阶段不改测试）

- 保留 kill switch：`server.test.ts` ~1889（两次 create）、~2812（无锁）。
- 改断言/语义：~1641 成功 dispose、~1743/~2594/~2992 工具 cancel、~1787 串行、~1846 busy resume。
- `baseConfig` 现 `cursorSdkDisableSessionResume: true`；WP7 才翻生产默认。
- flatten 用例 ~1152、~3241：kill switch 或改 delta 断言。勿删。

#### F. 文件所有权（并行禁区）

- WP2：`src/prompt-delta.ts` + `tests/prompt-delta.test.ts`；protocol 仅导出助手，不改 flatten。
- WP3：`src/session-hub.ts`、`src/tool-compat.ts`、`tests/session-hub.test.ts`。
- WP4 未收工 **禁止** 改 `cursor-runner.ts`。
- WP2∥WP3 文件不重叠。WP5∥WP6 在 WP4 之后。禁止并行改 `cursor-runner.ts`。

---

## 逐包记录

### WP0 · Spike：挂起的 execute

- 状态：已完成
- 改动：
  - 新增 `tests/sdk-held-execute.test.ts`（inline MiniHub + FakeAgent/FakeSdkRun；未改 `src/`）
  - 未创建 `src/session-hub.ts`，未改 `tool-compat.ts` / `cursor-runner.ts`
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npx tsc -p tsconfig.json && node --test dist/tests/sdk-held-execute.test.js`：Fake 绿（1 pass）；live skip（`no CURSOR_API_KEY or CURSOR_API_KEYS`）；0 fail
- live：skip（进程环境未设置 `CURSOR_API_KEY` / `CURSOR_API_KEYS`）
- SDK 版本：`1.0.27`（`node_modules/@cursor/sdk/package.json`）
- 源码复核（只读）：`createSdkCustomToolMcpExecutor`（`dist/esm/357.js` / `custom-tools.ts`）对 `execute()` 是 `yield n.execute(...)`，无 `Promise.race` / 超时包层；`SDKCustomTool.execute` 无 `AbortSignal`。30s stall 针对 inbound stream 静默，不是 execute 超时。
- held-execute 判决：`held-execute: pass`

### WP1 · 配置、类型、会话键

- 状态：已完成
- 改动：
  - `src/types.ts`：`GatewayConfig` 增加 `cursorSdkSessionMode` / `cursorSdkToolHoldTtlMs` / `cursorSdkSessionIdleTtlMs` / `cursorSdkMaxLiveSessions`（均必填）；新增 `CursorSdkSessionMode`、`DurableTurn`；`CursorRunRequest` 增加可选 `durableTurn` / `conversationSeed`（rawBody 不进 runner）
  - `src/config.ts`：从 env 读上述字段；`CURSOR_SDK_DISABLE_SESSION_RESUME=true`（默认）强制 `sessionMode=stateless`；默认仍 stateless；导出 `shouldUseDurableHub(config)` 给 WP3/WP4
  - `src/durable-id.ts`（新）：导出 `durableSessionId(input)` / `durableIdentity(input)`。仅当显式会话头 / `conversationSeed` / `stickyKey` / body 能算出 seed 时有值。忽略 `ownerHash` 与裸 `sessionKey`
  - `src/agent-store.ts`：`createEphemeralAgentStore({ idleTtlMs, maxAgents })`；无参默认仍 10min / 256（今日 stateless）
  - `src/index.ts`：始终注入共享内存 store（kill switch 关也不再 omit → 不会落到 SDK 每 agent SQLite）；idle TTL 在 kill switch 关闭时用 `cursorSdkSessionIdleTtlMs`。**未** `new SessionHub()`。`trackAgentBaseline` 仍为 kill switch 打开 → false，关闭（含 durable）→ true
  - `tests/durable-id.test.ts`（新）：kill switch 覆盖 mode、无 seed、anthropic-session-id、仅 ownerHash/sessionKey
  - `tests/server.test.ts` / `tests/proxy.test.ts` / `tests/gateway-keys.test.ts`：只给 `GatewayConfig` 字面量补字段，未改用例语义
  - 未创建 `src/session-hub.ts` / `src/prompt-delta.ts`，未改 `src/cursor-runner.ts` / README
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：444 tests，442 pass，2 skip（含 WP0 live skip），0 fail
- 默认路径：`cursorSdkDisableSessionResume=true`、`cursorSdkSessionMode=stateless`、`shouldUseDurableHub=false`。WP7 才翻默认。
- 未改 WP0 判决（`held-execute: pass`）

### WP2 · 三协议 delta 抽取

- 状态：已完成
- 改动：
  - 新增 `src/prompt-delta.ts`：纯函数 `extractDurableTurn(protocol, body, previous?, slotHints?) → DurableTurn`
  - 新增 `tests/prompt-delta.test.ts`（表驱动，计划 10 类各至少一条，另加元工具 / 指纹稳定 / 仪式句 / 图片补充）
  - `src/routing.ts`：导出 `systemSeedText`（systemFingerprint 与 conversationSeed 的 system 段同一口径，未重实现 flatten SYSTEM: 块）
  - `src/protocol.ts`：仅导出 `parseOpenAiTools` / `parseResponsesTools` / `parseAnthropicTools` / `contentToTextAndImages` / `responseContentToText` / `imageFromUrl`。**未改** `prepare*` flatten 行为。`protocol.ts` 不 import `prompt-delta.ts`
  - 未改 `src/session-hub.ts` / `tool-compat.ts` / `cursor-runner.ts` / `server.ts` / `index.ts` / README；未改 send
- 签名：
  ```ts
  extractDurableTurn(
    protocol: ProtocolKind, // "openai-chat" | "openai-responses" | "anthropic-messages"
    body: unknown,
    previous?: { response?: Record<string, unknown>; inputItems?: unknown[] },
    slotHints?: { lastUserText?: string; systemFingerprint?: string; toolsFingerprint?: string }
  ): DurableTurn
  ```
- 口径：
  - `systemFingerprint` = sha256(`systemSeedText(body)`)
  - `toolsFingerprint` = 过滤后 `GatewayTool[]` 按 name 排序的稳定 JSON（含 `inputSchema`）；经 parse* + `filterHostMetaTools`，不直接 parse `body.tools`
  - Chat：尾部连续 `role=tool|function`；Anthropic：最后一条 user 里的 `tool_result`（`is_error` → `isError`）；Responses：尾部 `function_call_output` / `tool_result`（`output ?? content`），`previous.output` 对 call_id / 元工具
  - GetMcpTools / `collectHostMetaCallIds` 结果不进 `toolResults`；仪式 assistant 文本不当 tool result
  - `images[]` 只来自本轮新 user 消息
- 10 类覆盖（见 `tests/prompt-delta.test.ts` 表）：
  1. Chat `[user]` → `new_user`
  2. Chat `[user, assistant+tool_calls, tool]` → `tool_results`（id 对齐）
  3. Chat 并行两个 tool_calls + 两个 tool messages
  4. Anthropic user text → `new_user`；`tool_result` 块 → `tool_results`
  5. Responses input 文本；`function_call_output`；`previous_response_id` 本轮只有 output 项
  6. GetMcpTools result 丢弃，不进 `toolResults`
  7. 系统文本变化 vs slotHints → `incompatible`
  8. tools 列表 name/schema 变化 → `incompatible`
  9. 空增量（最后一条 user === `lastUserText` 且无新 tool result）→ `empty`
  10. 图片：只放本轮新 user 消息上的图
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npx tsc -p tsconfig.json && node --test dist/tests/prompt-delta.test.js`：22 pass, 0 fail（未跑全量 `npm test`，避免与并行 WP3 抢 `dist/`）
- 未进入 WP4；未 git commit

### WP3 · SessionHub + 可挂起 execute

- 状态：已完成
- 改动：
  - 新增 `src/session-hub.ts`：`SessionHub`（`acquire`/`release`、`get`/`put`/`drop`、`attachPump`、`registerHold`、`resolvePending`、`beginAwaitingTools`、hold/idle TTL、max LRU、`settleParallelTools`）。Map 键由调用方提供（`durableSessionId`），不用 ownerHash。**未**在 `index.ts` `new SessionHub()`
  - `src/tool-compat.ts`：`createSdkCustomTools(tools, onToolCall, options?: { hold?: boolean; onHold? })`。默认 `hold:false` 双参签名不变，同步返回假成功文案；`hold:true` 返回未 settle 的 Promise，不返回假成功文案
  - 新增 `tests/session-hub.test.ts`：FakeAgent HTTP1 awaiting_tools → HTTP2 resolve → idle；并行 settle；mutex；idle/hold TTL；LRU。不碰真实 SDK
  - `tests/host-meta-tools.test.ts`：锁定 `hold:false` 假成功原文；`hold:true` 仍只注册 Read（GetMcpTools/Task 不进 customTools）
  - 未改 `src/cursor-runner.ts` / `src/index.ts` / `src/config.ts` / README / WP2 文件
- 假成功文案（`hold:false`，与改前逐字相同）：
  `Accepted. The caller will execute this tool and return the result in the next request. End your turn now without calling more tools.`
- 公开 API（WP4）：
  ```ts
  acquire(sessionId, signal?) => Promise<() => void>  // 返回值即 release
  get / put / drop(sessionId)
  attachPump(sessionId, pump?)
  registerHold(sessionId, toolCallId, name, resolve, reject)
  resolvePending(sessionId, toolCallId, result)
  beginAwaitingTools / markIdle / markRunning
  settleParallelTools(ms?)  // 默认 PARALLEL_TOOL_SETTLE_MS = 25
  ```
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - 本切片测试 21 pass / 0 fail（`session-hub` + `host-meta-tools`）。为避免与并行 WP2 抢 `dist/`，emit 用 `--outDir dist-wp3`
- held-execute：沿用 WP0 `pass`（path A 挂起 Promise）。未做 marker 旁路（WP4/D18）
- 未进入 WP4；未 git commit

### WP4 · 接入 CursorSdkRunner

- 状态：已完成
- 改动：
  - `src/cursor-runner.ts`：`stream()` 在 92–109 分叉。`disableSessionResume === true` → 今日 `streamLocked` → `runWithAgent`（create + 全文 + 假成功 + cancel + wait + 永远 dispose），**未**改 `runWithAgent` 的 cancel/finally。Hub 已注入 **且** kill switch 关 **且** `durableSessionId(...)` 有值 → sibling `streamDurable`（`hub.acquire`，不叠 `withSessionLock`）。无 Hub 或认不出会话 → 今日 `streamLocked` + 旧 resume 锁。
  - Durable 主路径 A（WP0 `held-execute: pass`）：`createSdkCustomTools(..., { hold: true, onHold })` 在 **create** 注册；后续 `send` 省略 `local.customTools`；工具挂起时本条 HTTP **不** cancel/wait/dispose，`waitPromise` 留在槽上；下一条 `tool_results` **只** `resolvePending`，同一 `runId`，禁止第二次 send。
  - Path B（D18 `<tool_call>` marker 旁路 + 无 pending execute 的 callable fallback）：cancel **该 Run** 但保留 agent，slot=idle；下一条 tool_result 只 `send(TOOL RESULT 短消息)`。
  - 增量 send：首轮 `STABLE_DIRECTIVE`（模块常量，无日期/请求 id/工具名）+ 可选 `SYSTEM:\n{systemText}` + user 文本；之后仅 user 文本（+ `durableTurn.images`）。禁止 `ASSISTANT:` / `TOOLS:` / `REMINDER` / Conversation 回放。`idempotencyKey = sha256(sessionId + ':' + runOrdinal + ':' + kind)`。
  - `src/server.ts`：三端点对等插入 `extractDurableTurn`（Chat / Responses 含 previous / Messages）；`count_tokens` 不调。`loggedRunRequest` 把 `durableTurn` 与 `conversationSeed` 铺到 `CursorRunRequest`。Admin 联通性仍无 seed → `durableSessionId` undefined。
  - `src/prompt-delta.ts` / `types.ts`：`DurableTurn.systemText` 可选项（`systemSeedText(body)` 未哈希），WP2 10 类断言未破。
  - `src/index.ts`：`shouldUseDurableHub(config)` 为 true 时 `new SessionHub({ hold/idle TTL, max, store })` 注入 `CursorSdkRunner`。WP1–6 默认 `shouldUseDurableHub=false`，生产仍无 Hub。未翻 `loadConfig` 默认（kill switch 仍默认 true / sessionMode stateless）。
  - 新增 `tests/cursor-durable-runner.test.ts`（Fake factory）。**未改** `tests/server.test.ts`。
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：486 tests，484 pass，2 skip（含 WP0 live skip），0 fail
  - 本切片：`cursor-durable-runner` 7 pass（两轮增量 send / held execute 同 runId / kill switch 全文 flatten / 无 seed 走 streamLocked / D18 marker path B / 三端点 durableTurn / empty 400）
  - 回归：`prompt-delta`、`session-hub`、`host-meta-tools`、`sdk-held-execute`、server.test 里「disable session resume」「busy resumed agent」「dispose-after-success」仍绿
- 默认路径：kill switch 默认 true，无 Hub；durable 仅测试注入 Hub + `disableSessionResume: false` + 可识别会话
- 未改 WP0 判决（`held-execute: pass`）。未 git commit；未改 README（WP7）；未翻生产默认

### 审阅小修（Stage 4）

- 状态：已完成
- 范围：只修 Stage 4 两条 should-fix。未改架构、未翻默认、未开 WP8、未改 WP0 判决。
- Fix 1 D4：`src/cursor-runner.ts` `stream()` — Hub 已注入且 `durableSessionId(...)` 为空时，对该请求 `forceStateless: true` 走 `streamLocked`（跳过 Hub、`withSessionLock`、getSession/saveSession）。no-seed 不再用 ownerHash 共享旧 resume。无 Hub 时仍是今日旧 resume 锁。
- Fix 2 Path B abort：marker 抽出 `tool_call` 后立刻 `hub.markIdle`；cancel 该 Run 后 **跳过 wait** 并 `yield done`。wait 上若仍碰到 499 且 path B tools 已出，catch 后 markIdle + done，不 drop。`streamDurable` finally 见到 idle 而不是 running+pending=0。
- 测试（`tests/cursor-durable-runner.test.ts`）：
  - 无 conversationSeed/stickyKey/durableTurn：Hub + kill switch off，两轮 → 两次 create，`resumeCount === 0`，`sessions.size === 0`，`hub.size === 0`
  - path B marker 后 abort：agent 未 dispose，slot 仍 `get()` 得到且 `idle`
- 未修（按指示）：SYSTEM_PROMPT_MODE 不进 durable send；SESSION_MODE=stateless 无 kill switch 仍走 streamLocked；WP5 mismatched tool_results drop+create
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npx tsc -p tsconfig.json && node --test dist/tests/cursor-durable-runner.test.js dist/tests/cursor-durable-wp5.test.js dist/tests/session-hub.test.js`：32 pass / 0 fail（durable-runner 8 + wp5 13 + session-hub 11）
  - `npm test`：506 tests / 504 pass / 2 skip / 0 fail
- 未改 WP0 判决（`held-execute: pass`）。未 git commit。未开 WP8。

### WP5 · 指纹、不兼容、重启 resume、502 防护

- 状态：待审阅
- 改动：
  - `src/session-hub.ts`（additive）：`issuedToolCallIds` / `historyChecksum` / `resumed`；导出 `historyChecksum` / `recordIssuedToolCalls` / `touchSlotHistory` / `durableSlotReplaceReason` / `inboundHistoryIncompatible`。Idle/hold/LRU `recycle` 仍 `cancel+dispose+deleteSession`（防 resume 复活已 dispose 的 agent）。**未**改 hold/idle TTL 实现（WP3 已有，`[session-hub] tool hold expired` 仍由 Hub 打印）。**未**给 `sdk_sessions` 加 state 列。
  - `src/cursor-runner.ts`：D11 `incompatible` / model / apiKey / systemFingerprint / toolsFingerprint / 历史改写 → `drop+create`，**不再 400**。Busy（复用并扩展 `isActiveRunError`：`AgentBusyError` + 文案 `CREATING|RUNNING`）与 stale（复用 `isRetryableStaleSessionError`，含 502 `upstream_run_failed`）→ 同请求 drop+create 一次，禁止同一坏 agentId 连续 502。进程无活 handle 时 `Agent.resume(id, agentOptions)` **再传 customTools**（`settingSources: []`）；后续 send 仍省略 `local.customTools`。Resume 槽为 idle，不恢复 pending execute。重启后 `tool_results`：store 有 agentId → resume + path B send；无 agentId / resume 失败 → 400 且不 create（不 poison）。`dropDurableSession` 同时 `hub.drop` + `store.deleteSession`。
  - 新增 `tests/cursor-durable-wp5.test.ts`。**未改** `tests/cursor-durable-runner.test.ts` / `tests/server.test.ts` / `src/config.ts` / `src/index.ts` / `src/store.ts` / README。未开 WP7。
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - 为避开与并行 WP6 抢 `dist/`，emit 用 `--outDir dist-wp5`
  - `node --test dist-wp5/tests/cursor-durable-runner.test.js dist-wp5/tests/cursor-durable-wp5.test.js dist-wp5/tests/session-hub.test.js`：31 pass / 0 fail（WP4 7 + WP5 13 + session-hub 11）
- WP4 leftover：`kind===incompatible` 已改为 drop+create；`!slot && tool_results` 重启走 resume+path B，死 map 上不 `resolvePending`
- Hold TTL / idle TTL / LRU：沿用 WP3 Hub；单测确认过期 drop 后下一请求 create 而非 resume 已 dispose 的 id
- 未改 WP0 判决（`held-execute: pass`）。未 git commit；未翻生产默认

### WP6 · Key 粘性、用量、回收与泄漏

- 状态：已完成
- 改动：
  - `src/key-rotating-runner.ts`：`durableTurn` + `stickyKey` 已有 `session_binding` → 钉死那一把 Cursor key。401/auth 与 quota 失败改 502，**不**试下一把（换 key 会丢掉 held execute / 打爆前缀缓存）。无绑定的首轮仍允许轮换，成功后走既有 `bindSession`。钉死路径不把 `sessionHash` 交给 `selectKey`（粘性回落会删绑定并改选）。未改 `selectKey` 本身；无 `durableTurn` 的轮换/回落保持今日行为。
  - `src/key-pool.ts`：薄封装 `getSessionBinding(sessionHash, ttl?)`（只读，不删绑定、不改选）。实现提示需要它；不能按 Hub 的 `durableSessionId` 反查（哈希含 apiKey，鸡生蛋）。
  - `src/index.ts`：SIGTERM/SIGINT 在 `closeAppThenDrainUsage` 之后、`executorLeases.releaseAll` 之前 `await sessionHub.dropAll()`（仅当 Hub 已建）。`trackAgentBaseline: useDurableHub || !cursorSdkDisableSessionResume` 未改：kill switch true → false；durable（kill switch false）→ true。未翻 WP7 生产默认。
  - `src/usage-reconciler.ts`：仅注释。`getUsage` 是 agent 累计值；durable 必须记增量。本条 HTTP token 仍由 WP4 `consumeDurablePump` 的 `TurnUsageLedger` 按消费边界记账，未改 `cursor-runner.ts`。
  - 新增 `tests/durable-key-pin.test.ts`；`tests/usage-capture.test.ts` 增量用例显式 `trackAgentBaseline: true`（kill-switch `false` 用例未改）。
  - 未改 `src/cursor-runner.ts` / `src/session-hub.ts`（只调用已有 `dropAll()`）/ `src/prompt-delta.ts` / `src/tool-compat.ts` / `src/protocol.ts` / `tests/server.test.ts` / README / `tests/cursor-durable-runner.test.ts`。未建 admin UI（关停日志打 live session 数即可）。
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npx tsc -p tsconfig.json && node --test dist/tests/durable-key-pin.test.js dist/tests/usage-capture.test.js`：29 pass / 0 fail（pin 4 + usage-capture 25）。未跑全量 `npm test`（WP5 并行编译）
  - pin：绑 key A 后上游 401 → 502，只尝试一把；首轮无绑定仍可轮到 key B；无 `durableTurn` 时粘性绑定 401 仍回落到 key B；两轮成功钉在同一把
  - baseline：resume/durable 第二条只记增量（12+18，不是把 12 再加一遍）；`trackAgentBaseline:false` 仍按累计值原样写入（kill-switch 计费）
- 未改 WP0 判决（`held-execute: pass`）。未翻生产默认。未进入 WP7。未 git commit

### WP7 · 默认打开、文档、回归语义

- 状态：待审阅
- 改动：
  - `src/config.ts`：`cursorSdkDisableSessionResume` 默认 **false**；`parseSessionMode` 未设置 / 非法 → **durable**，显式 `stateless` 仍有效。kill switch true 仍强制 `sessionMode=stateless` 且 `shouldUseDurableHub=false`
  - `src/index.ts`：生产默认建 SessionHub + `trackAgentBaseline true` + idle TTL 60min 共享内存 store（未回 SQLite）。kill switch 日志改为明确是 kill switch；durable 日志保留。无热切换
  - `src/types.ts` / `src/admin.ts` / `src/cursor-runner.ts`：`CursorRunRequest.forceStateless`。Admin 联通性 `forceStateless: true` + 唯一 `admin-connectivity-test-${uuid}`。runner 将该请求当 kill switch（跳过 Hub / getSession / saveSession，仍 create+cancel+dispose）
  - README / `.env.example`：默认 durable；kill switch 注释掉（不是默认值）；补 `CURSOR_SDK_SESSION_MODE` / `CURSOR_SDK_TOOL_HOLD_TTL_MS` / `CURSOR_SDK_SESSION_IDLE_TTL_MS` / `CURSOR_SDK_MAX_LIVE_SESSIONS`。SDK 契约：local `Agent.create` + `send`，不是 `Agent.prompt`，不是 Cloud REST。P1–P3 宿主元工具 / 仪式句过滤未改
  - 测试：`durable-id.test.ts` 默认 durable / disable false / Hub true，kill-switch-forces-stateless 保留；`store.test.ts` 加默认锁；`server.test.ts` 的 `createTestApp` **仍** `disable=true`（HTTP FakeRunner 不共享 Hub）。Admin 断言 sessionKey `^admin-connectivity-test-` + `forceStateless`。tools [] vs mcp 用唯一 sessionKey。新增 forceStateless runner 用例。kill switch「can disable SDK session resume」「skips the session lock」保留。未删用例
- 验证：
  - `npx tsc --noEmit -p tsconfig.json`：干净（exit 0）
  - `npm test`：505 tests，503 pass，2 skip（含 WP0 live skip），0 fail
- `loadConfig({})`：`cursorSdkDisableSessionResume=false`、`cursorSdkSessionMode=durable`、`shouldUseDurableHub=true`
- 未改 WP0 判决（`held-execute: pass`）。未进入 WP8（S1–S8）。未 git commit

### WP8 · 人工验证

- 状态：Fake 已完成；live 部分完成（key/目录/durable create+send 已见，S1 首轮后 Windows SDK AV 中断）
- 已做（Fake / 单测等价，非 live）：
  - S1 纯文本多轮：`tests/cursor-durable-runner.test.ts`「durable two user turns」— 一次 create、两次增量 send、第二次 payload 无 `ASSISTANT:`
  - S2 工具往返（WP0 pass / path A）：同文件「durable held execute」— 一次 create、一次 send、`resolve execute`、同一 runId、中间无 cancel/dispose
  - S5 Kill switch：同文件「kill switch stays stateless」+ `tests/server.test.ts`「can disable SDK session resume」— 两次 create、全文 flatten
  - 无 seed：同文件「unidentifiable session is true stateless」（审阅小修后：不 persist resume）
  - D18 path B：marker 短 send；abort 后 slot 仍 idle
  - 三端点 `durableTurn` 接线：chat / responses / messages
  - WP5 busy/stale/指纹 drop+create；WP6 钉 key 401 不换 key
- live（2026-09-02，Windows 宿主机 + `.env` 真实 Cursor key，模型目录含 `grok-4.6`）：
  - **已过**：网关启动日志 `Cursor SDK session mode: durable`；`GET /v1/models` 200，目录有 `grok-4.6`；S1 走到 `[durable] create agentId=...` + `[durable] send first`（增量路径已接线）
  - **未完成 S1 及之后**：`Agent.send` 加载 `@cursor/sdk` 的 `357.js`（local runtime）后进程以 **0xC0000005 ACCESS_VIOLATION** 退出，客户端 `ECONNRESET`。空工作区同样崩。`CURSOR_PREWARM=false` 挡不住这次崩溃（README 只覆盖了启动预热扫描）
  - Linux 旁路未跑成：Docker Desktop 引擎起不来（`com.docker.service` 未开、引擎 `_ping` HTTP 500；WSL Ubuntu `HCS/0x800705aa` 资源不足，当时空闲物理内存约 1.6GB）
  - 脚本：`scripts/live-durable-smoke.mjs`（勿把密钥打进日志）。Linux/Docker 起来后：`node scripts/live-durable-smoke.mjs`，或已有网关时 `LIVE_GATEWAY_URL=http://127.0.0.1:8787 node scripts/live-durable-smoke.mjs`
- 仍未做（需 Linux 宿主或可用的 Docker）：S1 第二轮 cacheRead、S2 path A `resolve execute`、S3/S4/S5 live、S6–S8、WP0 live held-execute 2s

### 审阅十项（2026-09-02）

代码已修：

1. Responses `call_${suffix}` 与 hung execute id 别名：`registerHold` / `resolvePending` / `inboundHistoryIncompatible`
2. `SESSION_MODE=stateless` 且无 Hub = 真 stateless（create+全文+cancel+dispose），不再走旧 resume；`trackAgentBaseline` 只在 durable Hub
3. `tool_results` 对不上 pending 时先 reject/cancel 挂起 execute，再 path B send
4. `SYSTEM_PROMPT` append|override 进入 `extractDurableTurn` / 首轮 `SYSTEM:` send
6. SDK 事件缺 tool id 不再 `randomUUID()`
7. parkHeld 优先 execute 捕获，同一次 park 只下发一次 tool_call，并记下 Responses call_id 别名

按计划保留：

5. server 入口仍不传 `slotHints`（durableSessionId 含 apiKey，gateway 要等选 key）。runner 的 `ensureDurableSlot` + lastUserText 400 仍对齐指纹 / empty
8. WP0 仍为 `held-execute: pass`（源码/类型；live skip / Windows AV）。不假装 live 过
9. 共享内存 store：重启后续不上 checkpoint（D9/D10）。idle 续聊 = 新 agent；重启 leftover `tool_results` = 400
10. 相同 last user 再发仍 400 `Empty durable turn`，不是幂等回放（避免对 idle agent 再 send 同一句）

- 验证：`npx tsc --noEmit -p tsconfig.json` 干净；`npm test` 514 tests / 512 pass / 2 skip / 0 fail

---

## 门禁

| 阶段 | 条件 | 结果 |
|---|---|---|
| 阶段 1 定位齐 | 五路定位回写接线地图 | 已过 |
| WP0 判决写入 | `held-execute: pass \| fail (fallback B)` | 已过（`held-execute: pass`） |
| WP4 开工 | WP0 判决已写；WP1–3 收工 | 已过 |
| 全量测试 | `npx tsc --noEmit -p tsconfig.json` 干净；`npm test` 全绿 | 已过（审阅小修后：506 tests / 504 pass / 2 skip / 0 fail） |
| 审阅后收口 | 明确小 bug 已修；WP8 清单 | 已过（D4 无 seed 真 stateless；path B abort 不 drop；live 写入未做项） |
