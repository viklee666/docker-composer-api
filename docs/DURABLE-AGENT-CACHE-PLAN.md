# 持久 Agent + 同 Run 工具往返（缓存与复读）改造计划

> 供新会话与子代理执行。本文档自包含：背景、根因、已拍板决策、架构、分阶段任务、文件所有权、验收与回滚。
> **三端点对等**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 必须同一套会话生命周期。禁止只修 Anthropic。
> 进度记在 `docs/DURABLE-AGENT-CACHE-PROGRESS.md`（执行开工时创建，本文不写进度）。

## 0. 背景与结论

调研已完成（2026-09-01）：对照本仓库调用链、[`@cursor/sdk` TypeScript 文档](https://cursor.com/docs/sdk/typescript)、[Cloud Agents API](https://cursor.com/cn/docs/cloud-agent/api/endpoints)，以及既有 `docs/CLAUDE-CODE-LOOP-FIX-PLAN.md`（P1–P3 已落地，P4 当时明确不改）。

### 0.1 现象

实际请求的 prompt 缓存率约 **50%**，多轮对话里模型经常把上一轮答案再讲一遍，工具已经返回仍会重调。这不是模型偶发，是网关把 Cursor Agent SDK 当成无状态 Chat Completions 在用。

### 0.2 根因（当前默认路径）

默认 `CURSOR_SDK_DISABLE_SESSION_RESUME=true`。每条 API 请求：

1. `protocol.ts` 把客户端整段 `messages[]` / history 压成一根字符串（含历史 `ASSISTANT:`、`TOOL RESULT`、整份 `TOOLS` JSON、末尾 `REMINDER`）。
2. `CursorSdkRunner` **`Agent.create`** 新建 local agent。
3. **`agent.send(全文 transcript)`**，`idempotencyKey: randomUUID()`。
4. 客户端工具一出现：`customTools.execute` 立刻返回假成功（*Accepted. … End your turn now*），然后 **`run.cancel()`**。
5. `run.wait()` + **`disposeAgent()`**。
6. 下一条 HTTP 再走 1–5。

Cursor SDK 的契约是反过来的：

| 概念 | 官方含义 | 本仓库现状 |
|---|---|---|
| **Agent** | 持久容器，跨多次 `send` 持有对话与工作区 | 每请求新建并扔掉 |
| **Run** | 一次 `send` 的工作单元；工具结果应回到**同一条** Run | 一调工具就 cancel |
| `agent.send(text)` | 只发**本轮新用户消息** | 每轮把全文历史当新任务 |
| `Agent.prompt()` | create → 一轮 → dispose，没有第二轮 | 未使用，但行为等价于每请求 prompt |
| `Agent.resume(id)` | 进程外续上同一会话 | 实现了，默认关；即便打开仍 `send(全文)`，会更糟 |
| Cloud `POST /v1/agents/{id}/runs` | REST 版 `send`，只放新 turn | 本网关走 local runtime，不需要改成 cloud |

缓存率卡在 ~50% 的机制：新 agent 的请求里，Composer 系统前缀 + `custom-user-tools` schema 在同一把 Cursor key 上相对稳定（**cacheRead**）；flattened transcript 每次都是「新 agent 的第一条 user 消息」（**cacheWrite + input**）。两截体积接近时就是一半命中——命中的是 Cursor 自己的固定前缀，**不是对话正文**。对话变长时这个比例通常下降而不是升高。

复读的机制：内层指令是 *Respond to the conversation below directly*，上一轮助手正文被写进新任务里；工具假成功后 Run 被杀掉，真实 `tool_result` 只以纯文本出现在**另一个** agent 里。Composer 从未在同一条 Run 里看到原生工具回传。

P1–P3 已经挡住 GetMcpTools / Task 仪式泄漏与短仪式句回灌。P4（同会话 resume）当时为躲 502 明确不改。本计划是 **P4 的正确版本**，不是把 `CURSOR_SDK_DISABLE_SESSION_RESUME` 拨成 `false`。

### 0.3 为什么「打开旧 resume」不行

旧 resume 路径仍 `send(input.prompt)`，而 `prompt` 仍是全文。Checkpoint 里已有历史，新 user 消息再贴一遍 → 上下文加倍、更爱复读、缓存更差。当时关掉它是因为：busy run 上再 `send`、dispose/store 不一致、远端会话污染后整段 502。正确改法是重做会话生命周期，不是拨开关。

### 0.4 选定方案（最佳）

**持久 Agent + 增量 `send` + 把客户端 `tool_result` resolve 进同一条 Run 的挂起 `execute()`。**

这是官方 dispatcher 形状，并补上网关独有的「工具在客户端执行」这一环。Cloud Agents REST 不是本计划的范围（local 推理已走 Cursor 托管模型；换 cloud VM 不解决缓存）。

降级预案（仅当 WP0 spike 证明 SDK 会超时/取消挂起的 `execute`）：工具路径改为「同一 agent 上 `send` 一条只含工具结果的短消息」，会话与增量 send 仍做。缓存会略差于同 Run 往返，但仍远好于今天。

---

## 1. 目标与非目标

### 1.1 目标

1. **可识别的会话**复用同一个 Cursor `agentId`：首轮 `create`，之后进程内复用 handle，进程重启后 `resume`（无在途挂起工具时）。
2. **`send` 只发增量**：新用户文本，或（降级路径）工具结果摘要。禁止把历史 `ASSISTANT:` / 旧 `USER:` / 整份 `TOOLS` JSON 再塞进 prompt。
3. **工具主路径**：`execute()` 返回未 settle 的 Promise；本条 HTTP 以 `tool_calls` / `tool_use` 结束；下一条带 `tool_result` 的 HTTP **resolve 该 Promise**，同一条 Run 继续。此间 **不 cancel、不 dispose、不 `send`**。
4. **缓存**：同一会话后续请求的 `cacheRead / (input + cacheRead + cacheWrite)` 应随对话变长明显上升（健康多轮常见 80%+），不再卡在 ~50%。
5. **复读**：同一会话内模型不应把上一轮已完成的助手正文再生成一遍；工具结果到达后应基于结果继续，而不是重开任务。
6. **502 防护**：同一 agent 上同一时刻最多一条活动 Run；`awaiting_tools` 时只允许匹配的 tool_result 进入；busy / stale / 指纹不兼容时丢弃该会话并 fresh create，禁止污染后续请求。
7. **对外 wire format 不变**：客户端仍发完整 `messages[]`；SSE / `stop_reason` / `tool_use` 形状保持现有对齐。P1–P3 过滤器在 fallback 路径继续生效。
8. **Kill switch**：`CURSOR_SDK_DISABLE_SESSION_RESUME=true` 必须仍能回到今天的 stateless 行为（每请求 create+全文+cancel+dispose）。

### 1.2 非目标

- 不改 Cloud Agents REST，不把 runtime 从 local 换成 cloud。
- 不改 `tools: ["mcp"]` 策略（无客户端工具仍纯文本；有工具只暴露 MCP 通道，禁止网关容器内 shell/edit）。
- 不把宿主元工具（GetMcpTools / Task 等）重新注册进 `customTools`。
- 不实现 Anthropic `cache_control` 断点（SDK 无此 API）。
- 不让 `temperature` / `max_tokens` 等对上游生效。
- 不保证进程被杀掉后，**正在挂起的 `execute`** 能恢复（内存 Promise 不可持久化）。重启后的 tool_result 走 WP5 降级路径。
- 不把无法识别会话的请求强行并进同一个 agent（禁止用 `ownerHash` 当会话键）。

### 1.3 成功标准（定量 + 定性）

| 指标 | 现在 | 目标 |
|---|---|---|
| 可识别会话、第 2+ 轮（含工具往返）缓存率 | ~50%，且随历史变长不升 | 同会话后续轮次 `cacheRead` 占比明显高于首轮；长对话应持续升高而不是钉在 50% |
| 复读 | 常见 | 同会话内不应复述上一轮已完成的助手正文 |
| 工具往返 | 假成功 + cancel + 新 agent | 主路径同一 `runId` 跨两条 HTTP；降级路径同一 `agentId` 新 Run |
| Stateless kill switch | 默认 | 仍可用，测试锁定 |
| `npm test` / `tsc --noEmit` | 基线全绿 | 保持全绿 |
| 旧 502 类故障 | 关 resume 在躲 | 状态机 + 互斥 + 过期丢弃；不允许「坏 agent 毒死整把 key」 |

---

## 2. 执行约定

| 阶段 | 子代理 | 产出 |
|---|---|---|
| 定位 | explore | 精确行号、调用点全集、spike 结论 |
| 执行 | generalPurpose | 代码 + 测试 + 更新 progress |
| 审阅 | generalPurpose | 是否真正闭合该 WP 的验收，而不是「看起来改了」 |

硬性要求：

1. **不许盲改**。每个 WP 先有定位结论（文件 + 行号 + 调用点），再动代码。
2. WP0 spike **未通过不得进入 WP3 主路径实现**。Spike 失败则全计划改走 §2.1 降级工具路径，并在 progress 里写明证据。
3. `npx tsc --noEmit -p tsconfig.json` 必须干净。
4. `npm test` 必须全绿。`tests/server.test.ts` 是回归网：固化了「每请求 create」的用例要**改成正确语义或显式走 stateless**，不是删掉。
5. 新行为的单测放新文件（`tests/session-hub.test.ts`、`tests/prompt-delta.test.ts` 等），避免无谓合并冲突。
6. 每个 WP 收工更新 `docs/DURABLE-AGENT-CACHE-PROGRESS.md`。
7. 三端点必须一起交付；不允许「messages 已挂起 execute、chat 还在 cancel」。

### 2.1 Spike 失败时的降级（写进计划，避免到时候争论）

若真实 `@cursor/sdk` 在 `execute()` 超过数秒未返回时会：超时、自动填错误结果、cancel Run、或断开 stream，则：

- **取消「同 Run 挂起 execute」作为主路径**。
- 工具路径改为：本条 HTTP 仍下发 `tool_calls` 并结束；**不 dispose agent**；下一条 HTTP 对同一 agent `send` 一条短消息，只含本次新增的工具结果（结构化纯文本，不含历史）。
- SessionHub / 增量 user `send` / 指纹 / 502 防护 / kill switch **全部仍做**。
- 验收里「同一 `runId`」改为「同一 `agentId`，工具结果是新 Run 的唯一 user 消息」。

---

## 3. 已拍板决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 运行时 | **继续 local** `Agent.create` / `resume` / `send` | 网关已有 cwd、customTools、预热执行器。Cloud REST 不提高缓存，只换执行地点 |
| D2 | 工具主路径 | **挂起 `execute()`，同 Run 等待客户端 tool_result** | 唯一能让模型走原生工具通道、前缀几乎全可缓存的办法 |
| D3 | `send` 内容 | **只发增量**；禁止全文 transcript | 全文是复读与 cache miss 的直接原因 |
| D4 | 会话键 | **显式头 > Responses 继承的 conversationSeed > Chat/Anthropic 现算 conversationSeed**。认不出 → **stateless fallback**。禁止 `ownerHash` / 裸 `sessionKey` 兜底 | 与现有 stickyKey 纪律一致，避免整网关钉死在一个 agent 上 |
| D5 | Kill switch | 保留 `CURSOR_SDK_DISABLE_SESSION_RESUME=true` = 今天的 stateless。新模式名 `durable` | 线上出 502 可以立刻退回，不必发版 |
| D6 | 默认值 | 实现期先 **flag 默认 durable**（测试锁两边）。README 写清；旧部署若必须旧行为，设 kill switch | 本计划的目标就是改默认调用方式 |
| D7 | 工具 schema 进 prompt | **durable 路径不再把 TOOLS JSON / REMINDER 写进 `send` 文本** | 工具经 `customTools` → MCP `custom-user-tools` 暴露；写进 prompt 既 bust 缓存又诱导模型用 `<tool_call>` 旁路 |
| D8 | 首轮仍可有一段**稳定**短指令 | 固定字符串（文件护栏 +「用已注册工具」），所有带工具的会话共用同一段 | 给 Composer 的 agent 本能一个闸；必须稳定才能进前缀缓存 |
| D9 | 句柄与 store | **进程内 SessionHub 持有活 handle**；checkpoint 用**一份共享**有界内存 `LocalAgentStore`（拉长 idle TTL），**禁止**回到「每 agent 一份 SQLite」 | 旧 resume 的句柄泄漏就是这么来的 |
| D10 | 进程重启 | 可 `resume(agentId)` 续对话；**挂起的 execute 丢失**。重启后的 tool_result 走降级 `send` 或 fresh | Promise 无法落盘 |
| D11 | 指纹不兼容 | 系统提示 / 工具列表 / 历史被改写 / 模型 id 变化 → **丢弃 slot，新 agent** | 硬续只会污染 checkpoint 并 bust 缓存 |
| D12 | 同一会话并发 | Session 互斥。`running` 时第二请求排队或 409（见 D13）；`awaiting_tools` 只接受匹配的 tool_result | 这是旧 502 的主因 |
| D13 | 并发策略 | **同一 session 串行**（已有 `withSessionLock`）。第二请求在锁上等待，带 HTTP timeout；超时 504，不取消已经 `awaiting_tools` 的 slot | 比 409 更贴 Claude Code（工具结果请求几乎总是紧接着到来） |
| D14 | Key 轮换 | 会话**首个成功 create** 之后钉死这把 key（沿用 session affinity）。`awaiting_tools` / 续 `send` **禁止**换 key | 换 key = 新前缀缓存；换 key 也无法接上挂起的 execute |
| D15 | HTTP timeout vs hold TTL | `REQUEST_TIMEOUT_MS`（默认 180s）只管**这一条 HTTP**。挂起工具另用 `CURSOR_SDK_TOOL_HOLD_TTL_MS`（默认 15min）。空闲 agent 用 `CURSOR_SDK_SESSION_IDLE_TTL_MS`（默认 60min，与粘性 TTL 同量级） | 客户端 bash 可能超过 180s；HTTP 必须先结束并返回 tool_calls |
| D16 | 金额 | durable 下 `trackAgentBaseline=true`（已有落库基线） | `getUsage` 是 agent 累计值 |
| D17 | 本轮 token | 只把**本条 HTTP 期间**收到的 SDK usage 事件记入该请求日志，不拿 agent 累计值覆盖 | 一条 Run 跨两条 HTTP 时各记各的 turn |
| D18 | `<tool_call>` 文本标记 | 仍解析并转发给客户端；**没有 execute 可挂起**，因此这条旁路用「同一 agent、下轮 `send` 工具结果」（D2 降级） | 不能为此重新 cancel+dispose |
| D19 | 不改对外协议 | 客户端继续发全量 history；delta 只在网关内计算 | 兼容 Claude Code / OpenAI 客户端 |
| D20 | Admin 联通性测试 | 继续用唯一 `sessionKey`，**强制 stateless**（已有 `admin-connectivity-test-${uuid}`） | 测试不得粘到用户会话，也不得复用坏 agent |

---

## 4. 目标架构

### 4.1 会话状态机

```
                    ┌─────────────┐
         识别失败    │  STATELESS  │  今日路径：create + 全文 + cancel + dispose
                    └─────────────┘
                           ▲
                           │ kill switch / 无 seed
                           │
  新会话 / 指纹不兼容        │
        ┌──────────────────┴───────────────┐
        ▼                                  │
   ┌─────────┐   send(增量)    ┌─────────┐  │
   │  EMPTY  │ ──────────────▶ │ RUNNING │  │
   └─────────┘                 └─────────┘  │
        ▲                         │    │    │
        │ dispose/TTL             │    │    │
        │                         │    │ tool execute() 挂起
        │                         │    ▼
        │                         │  ┌─────────────────┐
        │                         │  │ AWAITING_TOOLS  │◀── HTTP 1 结束（已下发 tool_calls）
        │                         │  └─────────────────┘
        │                         │          │
        │                         │          │ HTTP 2：匹配的 tool_result → resolve(execute)
        │                         │          ▼
        │                         │  RUNNING（同一 Run 继续）
        │                         │          │
        │                         │          │ 文本结束 / wait() finished
        │                         ▼          ▼
        │                    ┌─────────┐
        └────────────────────│  IDLE   │  handle 仍在；下一轮 user 只 send(新文本)
                             └─────────┘
                                   │
                                   │ busy/stale/TTL/错误
                                   ▼
                             ┌─────────┐
                             │  DEAD   │  删 session 映射，下一请求 create
                             └─────────┘
```

### 4.2 两条 HTTP 的时序（主路径）

**HTTP 1**（用户问「读 README」）

1. 算会话键 + 指纹；无 slot → `Agent.create`（`tools: ["mcp"]`，`customTools` 在 create 时注册，后续 send **省略**以免整表替换）。
2. `send(稳定短指令 + 客户端 system（仅首轮）+ 本轮 user 文本)`。
3. 泵 `onDelta` / `run.stream()` 直到 `execute()` 被调用。
4. `execute` **不返回**；登记 `Map<toolCallId, { resolve, reject }>`。
5. 短暂排空（见 §5 WP3）以收集并行工具。
6. yield `tool_call`… yield `done`（`finish_reason=tool_calls`）。
7. **禁止** `cancel` / `wait` / `dispose`。slot = `AWAITING_TOOLS`。HTTP 结束。Hold TTL 开始计时。

**HTTP 2**（客户端带回 `tool_result`）

1. 同一会话键命中 slot。
2. 从本轮请求抽出 **新增** tool_result（按 `tool_call_id` / `tool_use_id` / `call_id`）。
3. `resolve({ content: [{ type: "text", text: 真实结果 }] })`。禁止再返回假成功文案。
4. 泵继续，直到下一批工具或 `wait()` 终态。
5. 文本终态 → slot = `IDLE`，仍不 dispose。

### 4.3 会话键（实现必须按此优先级）

```
durableId =
  explicitSessionId(headers)             // x-session-affinity / x-opencode-session-id / anthropic-session-id
  ?? inherited conversationSeed          // Responses: previous 行上的种子
  ?? conversationSeed(body)              // system+首条 user，已有 routing.ts
  ?? undefined                           // → stateless，不要用 ownerHash
```

SessionHub 的 Map 键再混入：`apiKey`（或 key id）+ `model` + `workingDirectory`，与今天 `sessionId()` 同构，避免不同模型/key 撞槽。

`stickyKey` 继续只用于 **Cursor key 粘性**，不要把 SessionHub 键退化成 ownerHash。

### 4.4 从全量 history 抽 delta

客户端每次仍发完整消息。网关内部只认「本轮新信息」：

| 入站形态 | 动作 |
|---|---|
| slot 空 / DEAD | `kind=new_user`：取**最后一条**非空 user 文本（加首轮 system + 稳定短指令） |
| `AWAITING_TOOLS` + 带有挂起 id 的 tool_result | `kind=tool_results`：只 resolve，不 `send` |
| `AWAITING_TOOLS` 但结果对不上 / 用户发了新 user 而不是结果 | 取消挂起与 Run，slot DEAD，按新会话 create（用户改主意） |
| `IDLE` + 最后一条是新 user | `kind=new_user`：只 `send` 该 user 文本（+ 本轮新图片） |
| `IDLE` + 看起来像把旧对话又贴了一遍且无新 user | 视为空增量：可 400 或 no-op；优先实现为 **若最后一条 user 与 slot.lastUserText 相同则 400** |
| 系统指纹 / 工具指纹 / 模型变化 | 不兼容 → DEAD + 新 agent |
| 历史被改写（比 slot 记录的前缀更短或校验和不符） | 不兼容 → 新 agent（客户端 compact / 编辑历史） |

三协议抽取统一接口（建议 `src/prompt-delta.ts`）：

```ts
interface DurableTurn {
  kind: "new_user" | "tool_results" | "incompatible" | "empty";
  userText?: string;
  images?: GatewayImage[];
  systemFingerprint: string;
  toolsFingerprint: string;
  toolResults?: Array<{ id: string; content: string; isError?: boolean }>;
}
```

- Chat：`role=tool` + `tool_call_id`
- Anthropic：`type=tool_result` + `tool_use_id`
- Responses：`type=function_call_output` + `call_id`；续聊还要能对上 `previous.output` 里的 call_id

宿主元工具的 result 继续丢弃（P2/P3），不要 resolve 进 execute。

### 4.5 SessionHub 槽位（进程内）

```ts
interface SessionSlot {
  state: "running" | "awaiting_tools" | "idle" | "dead";
  agent: AgentLike;
  agentId: string;
  run?: RunLike;
  runId?: string;
  apiKey: string;
  model: string;
  toolsFingerprint: string;
  systemFingerprint: string;
  pending: Map<string, { name: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  pump: EventPump;           // onDelta + stream 合流队列，可被第二条 HTTP 继续消费
  waitPromise?: Promise<unknown>;
  lastUserText?: string;
  lastUsedAt: number;
  holdDeadline?: number;     // awaiting_tools 的死线
}
```

回收：idle TTL、hold TTL、`MAX_LIVE_SESSIONS` LRU。回收时 `cancel` + `dispose`，并 `store.deleteSession`。

### 4.6 与现有模块的边界

```
server.ts          仍 prepare*（wire 解析、tools、usage 形状）
                   仍 toRunRequest；额外带上 raw body 或 DurableTurn
                   不直接碰 Agent

prompt-delta.ts    纯函数：从 body + slot 指纹 → DurableTurn（新文件）

session-hub.ts     槽位 Map、TTL、互斥、挂起 execute 登记（新文件）

tool-compat.ts     execute 可挂起；假成功文案只留给 stateless 路径

cursor-runner.ts   durable：create/resume/send(增量)/detach/attach
                   stateless：原样保留（kill switch）

key-rotating-runner.ts  续聊禁止换 key；slot 已钉 key 时走 inner.stream 且 apiKey 固定

agent-store.ts     共享内存 store；durable 拉长 idle TTL，仍有界

index.ts           组装 Hub、baseline、默认 durable、kill switch
```

`protocol.ts` 的全文 flatten **保留**，专供 stateless 与「认不出会话」的 fallback。durable 成功路径不再把 `prepared.prompt` 交给 `send`。

---

## 5. 工作包

依赖顺序：

```
WP0 spike（门闩）
  └─ WP1 会话键 + 配置 + 类型
       ├─ WP2 prompt-delta 纯函数
       └─ WP3 SessionHub + 可挂起 execute（FakeAgent）
            └─ WP4 接入 CursorSdkRunner（detach / attach / 增量 send）
                 ├─ WP5 指纹、降级、502 防护、重启 resume
                 ├─ WP6 key 粘性、usage 基线、TTL 回收
                 └─ WP7 默认 durable、README、admin、回归用例语义
                      └─ WP8 人工验证清单（不改代码，除非验证失败）
```

WP2 与 WP3 在 WP1 之后可并行。WP5 与 WP6 在 WP4 之后可并行。

---

### WP0 · Spike：挂起的 `execute` 能否跨两次「请求」活下来（P0，门闩）

**问题**：我们的主路径依赖 SDK 在 `customTools.execute` 返回 Promise 期间保持 Run 为 `running`，且 `onDelta` / `stream()` 在 Promise resolve 之后继续。若 SDK 有隐藏超时，A 方案不成立。

**做法**：

1. 定位 `@cursor/sdk` 里 `SDKCustomTool.execute` 的类型与实现（`node_modules/@cursor/sdk` 的 `custom-tools` / agent runner）。记下是否有超时、是否必须返回 JSON-serializable content。
2. 写 **可提交** 的测试 `tests/sdk-held-execute.test.ts`：
   - 用 FakeAgent（仿 `tests/server.test.ts` 的 FakeSdkRun）证明 **我们的 Hub 状态机**可以：第一次消费停在 pending execute，第二次 resolve 后继续吐文本。
   - 另写一条 **可选 live** 测试（无 `CURSOR_API_KEY` 则 skip）：真实 `Agent.create` + 一个挂起 2s 的 customTool + `send` + 2s 后 resolve + `wait()` 成功。这条是 spike 的判决。
3. 若 live 失败：把错误原文、SDK 版本写入 progress，启用 §2.1，后续 WP 的「resolve execute」改为「同 agent 增量 send 工具结果」。

**验收**：progress 里有一句明确判决：`held-execute: pass | fail (fallback B)`。fail 时 WP4 的实现注释必须指向 B，不能再假装会挂起。

**文件**：`tests/sdk-held-execute.test.ts`；只读 `node_modules/@cursor/sdk/**`。本 WP **不改**生产代码。

---

### WP1 · 配置、类型、会话键（P0）

**当前**：`cursorSdkDisableSessionResume` 默认 true；`sessionId` = hash(apiKey, model, sessionKey, cwd)；`sessionKey` 在无头时退化成 ownerHash；`stickyKey` 才是认得出的对话身份。

**目标**：

- 配置增加（均有默认，可 env）：
  - `cursorSdkSessionMode: "durable" | "stateless"`（kill switch 为 true 时强制 stateless）
  - `cursorSdkToolHoldTtlMs` 默认 `900_000`
  - `cursorSdkSessionIdleTtlMs` 默认 `3_600_000`
  - `cursorSdkMaxLiveSessions` 默认 `256`
- `CursorRunRequest` 增加可选：`durableTurn?: DurableTurn`、`conversationSeed?: string`、`rawBody` 不进 runner（delta 在 server 侧算完再传入）。
- 导出 `durableSessionId(input)`：仅当 `stickyKey` 或 `conversationSeed` 或显式头存在时有值。
- `index.ts`：kill switch 打开 → 不建 Hub、不 track baseline、继续 ephemeral store（今日行为）。durable → 建 Hub、`trackAgentBaseline=true`、**仍用一份共享内存 store**（不要切回每 agent SQLite）。

**测试**：`tests/config` / `tests/routing` 类现有风格：kill switch 覆盖 mode；无 seed 时 `durableSessionId` 为 undefined；有 `anthropic-session-id` 时有值。

**验收**：stateless 默认路径零行为变化，直到 WP7 改默认。若 WP1 就把默认改成 durable，后续 WP 未接好会让生产变差——因此 **WP1 默认仍 stateless，WP7 再翻默认**。与 D6 的关系：D6 的「实现期默认 durable」以 WP7 为翻开关的唯一点；WP1–6 用测试显式传入 `sessionMode: "durable"`。

**文件**：`src/config.ts`、`src/types.ts`、`src/routing.ts` 或小新文件 `src/durable-id.ts`、`src/index.ts`、对应测试。

---

### WP2 · 三协议 delta 抽取（P0）

**当前**：只有全文 flatten（`prepareOpenAiChat` / `prepareOpenAiResponses` / `prepareAnthropicMessages`）。

**目标**：新模块纯函数 `extractDurableTurn(protocol, body, previous?, slotHints?)`。

必须覆盖的用例（写成表驱动测试）：

1. Chat：`[user]` → `new_user`
2. Chat：`[user, assistant+tool_calls, tool]` → `tool_results`（id 对齐）
3. Chat：并行两个 tool_calls + 两个 tool messages
4. Anthropic：`user` text → `new_user`；`tool_result` 块 → `tool_results`
5. Responses：`input` 文本；`function_call_output`；`previous_response_id` 场景下本轮只有 output 项
6. 元工具 GetMcpTools 的 result → 丢弃，不进入 `toolResults`
7. 系统文本变化（相对 slotHints）→ `incompatible`
8. tools 列表 name/schema 变化 → `incompatible`
9. 空增量（最后一条 user 与 lastUserText 相同且无新 tool result）→ `empty`
10. 图片：只把 **本轮新 user 消息**上的图放进 `images`，不要把历史图再发一遍

`toolsFingerprint`：对过滤后的 `GatewayTool[]` 做稳定 JSON（按 name 排序，含 inputSchema）。`systemFingerprint`：与 `conversationSeed` 的 system 部分同一口径。

**不要**在本 WP 改 `send` 行为。`prepare*` 保持原样给 stateless。

**文件**：`src/prompt-delta.ts`、`tests/prompt-delta.test.ts`。可从 `protocol.ts` 复用 `contentToText` 类助手——若复用导致循环依赖，把纯文本抽取再拆一层，禁止为了方便把 flatten 逻辑抄两份后漂移。

**验收**：上述 10 类各至少一条；不改 runner。

---

### WP3 · SessionHub + 可挂起 execute（P0，Fake 即可）

**当前**：`createSdkCustomTools` 的 `execute` 同步返回假成功；runner 在 finally 里必定 dispose。

**目标**：

- `createSdkCustomTools(tools, onToolCall, options?: { hold?: boolean })`
  - `hold: false`（stateless）：保持假成功文案（诱导 agent 停手，随后 cancel）。
  - `hold: true`：`execute` 返回 Promise，经 `onHold(toolCallId, resolve, reject)` 登记。
- `SessionHub`：`acquire` / `release` 互斥、`get` / `put` / `drop`、hold/idle TTL、max LRU、`attachPump`。
- Fake 测试把 Hub 跑完整段：create 假 agent → 第一次 stream 停在 awaiting_tools → 第二次 resolve → 收到后续文本 → idle。

并行工具：第一次 `execute` 之后 `await queueMicrotask` + 再等一个 0ms timeout，把同步并行调用收齐，再结束 HTTP1。把这个 settle 窗口做成常量（如 `PARALLEL_TOOL_SETTLE_MS = 25`），单测可注入。

**文件**：`src/session-hub.ts`、`src/tool-compat.ts`、`tests/session-hub.test.ts`、`tests/host-meta-tools.test.ts`（回归 hold=false）。

**验收**：Hub 单测不碰真实 SDK；stateless execute 文案不变。

---

### WP4 · 接入 CursorSdkRunner（P0）

这是行为变化的核心包。**定位阶段必须列出 `runWithAgent` 里每一处 `cancelRun` / `disposeAgent` / `saveSession` 的新条件。**

**当前（`cursor-runner.ts`）**：`runWithAgent` 从 send 到 dispose 包在一次 try/finally；工具三条路径（marker / SDK event / captured execute）都会 `cancelRun` 然后 `break`；finally 总是 dispose。

**目标行为表**：

| 模式 | 工具出现时 | HTTP 结束时 | 下一条 tool_result |
|---|---|---|---|
| stateless | cancel + 假成功（今） | dispose | 新 agent + 全文 |
| durable + held execute（WP0 pass） | **不** cancel、不 wait、不 dispose | slot=awaiting_tools，泵挂着 | resolve execute，继续泵 |
| durable + fallback B / marker 旁路 | 不 dispose；可让当前 Run 在工具处自然停或 cancel **该 Run 但保留 agent** | slot=idle（agent 活） | `send(工具结果短消息)` |

增量 `send` 文本规则：

- 首轮（该 slot 第一次 send）：`[STABLE_DIRECTIVE]\n\n` + 可选 `SYSTEM:\n{clientSystem}\n\n` + user 文本。**无** `TOOLS:`、**无** `Conversation:` 回放、**无** `REMINDER`。
- 之后用户轮：仅 user 文本（+ images）。
- `STABLE_DIRECTIVE` 必须是模块内常量，禁止拼日期、请求 id、工具名列表。

`customTools`：create/resume 时传入；后续 `send` **省略** `local.customTools`（官方：per-send 整表替换）。工具指纹变化已在 WP5 变成新 agent，不会在同一 slot 上换 schema。

`idempotencyKey`：`sha256(sessionId + ':' + runOrdinal + ':' + kind)`，禁止每调用 `randomUUID()`（重试会双开 Run）。

`stream()` durable 分支：

1. 取锁。
2. 无 slot → create（resume 见 WP5）。
3. `tool_results` → 禁止 `send`，只 resolve + 消费泵。
4. `new_user` 且 idle → `send(增量)` + 新泵。
5. `new_user` 且 awaiting_tools → 视为用户取消工具：reject pending、cancel Run、再 send（记日志）。
6. 吐事件直到本条 HTTP 该结束的条件（工具齐 / run 终态）。
7. 结束条件是工具时：**跳过** wait/dispose；把 wait 留在泵上。
8. 结束条件是 run 终态时：`wait()`，slot=idle，**仍不 dispose**。

HTTP abort（客户端断流）区分：

- `RUNNING` 且还在出文本：cancel + drop slot（与今类似）。
- `AWAITING_TOOLS`：HTTP 结束是正常的，abort 不应 drop slot；只让 hold TTL 负责。

**测试**（`tests/cursor-durable-runner.test.ts`，Fake factory）：

1. 两轮 user：`create` 一次，`send` 两次，第二次 payload **不含**第一轮 ASSISTANT 文本。
2. user → tool_call → tool_result → 文本：`create` 一次，`send` 一次，`execute` resolve 一次，中间无 cancel/dispose。
3. kill switch：两轮两次 create，第二次 payload 含全文（现有语义）。
4. 无 conversationSeed / 无会话头：走 stateless（即使 mode=durable）。
5. 现有「disable session resume」「busy resumed agent」用例仍绿。

**文件**：`src/cursor-runner.ts`、`src/index.ts` 注入 Hub、上述测试。尽量不改 `tests/server.test.ts`，除非有用例在 durable 默认下会误共享 session（WP7 才翻默认）。

**验收**：Fake 级闭环；真实缓存数字在 WP8 看。

---

### WP5 · 指纹、不兼容、重启 resume、502 防护（P0）

**目标**：坏会话不能毒死后续请求。

1. **不兼容**：`incompatible` / 模型变化 / apiKey 变化 → `drop(slot)`（cancel+dispose+deleteSession）→ create。
2. **busy**：SDK `AgentBusyError` / 文案含 CREATING|RUNNING → drop + create（已有 `isActiveRunError`，复用）。
3. **stale resume**：已有 `isRetryableStaleSessionError`，复用。
4. **重启**：`IDLE` 的 `agentId` 写入现有 `sdk_sessions`。进程起来后无活 handle 时 `Agent.resume(id, agentOptions)`，并 **再次传入 customTools**（官方：inline 工具/MCP resume 不持久化）。`AWAITING_TOOLS` 不写「可 resume 的挂起」——重启后 pending 丢失：若下一条是 tool_result，走 fallback B（`send` 结果）或 drop。
5. **Hold TTL**：到期 reject 所有 pending、cancel Run、drop。客户端下一请求 fresh。日志 `[session-hub] tool hold expired`。
6. **Idle TTL / LRU**：到期 dispose。
7. **历史改写**：slot 保存 `historyChecksum`（例如已服务过的 tool_call id 集合 + lastUserText）。入站若缺少已发出的 tool_call id 又不是合法 result → incompatible。

**测试**：busy / stale / TTL / 工具指纹变化 / resume 时 customTools 再传入。

**文件**：`src/session-hub.ts`、`src/cursor-runner.ts`、`src/store.ts`（仅当 sdk_sessions 的读写语义要加 state 列；能不加列就用内存 Hub + 现有 saveSession）。

**验收**：人为制造 busy 时下一请求成功且是新 agentId；不会出现「同一坏 id 连续 502」。

---

### WP6 · Key 粘性、用量、回收与泄漏（P1）

**当前**：KeyRotatingRunner 在发出事件后不换 key；粘性用 stickyKey。UsageReconciler 在 disable resume 时不记 baseline。

**目标**：

1. Durable 续聊：`CursorRunRequest.apiKey` 必须等于 slot.apiKey；KeyRotatingRunner 若 `input.apiKey` 已由 slot 钉死且 `useKeyPool`，**跳过轮换**（或 attempted 集合只含这一把，失败则 502 而不是换 key 把 execute 丢了）。
2. 首轮仍允许轮换；成功 create 后 `bindSession` + 写入 slot.apiKey。
3. `trackAgentBaseline=true`（durable）。
4. 本条 HTTP 的 usage = 本条消费到的 turn-ended/usage 事件之和（泵按 HTTP 边界切一段 ledger）。
5. 进程退出：`SIGTERM` 已有等待在途请求；补上 `hub.dropAll()`（限时 dispose），避免泄漏子进程。
6. Admin overview 可选：活会话数、awaiting_tools 数（最小：日志即可；有余力再挂 `/admin/api/overview`）。

**测试**：钉 key 后上游 401 不换 key；baseline 增量（已有 `usage-capture.test.ts` resume 用例可对齐）。

**文件**：`src/key-rotating-runner.ts`、`src/index.ts`、`src/usage-reconciler.ts`（确认开关）、`src/session-hub.ts` dropAll。

**验收**：两轮同会话同 keyId；金额不把第一轮再加一遍。

---

### WP7 · 默认打开、文档、回归语义（P1）

**目标**：

1. `cursorSdkSessionMode` 默认 `durable`；`cursorSdkDisableSessionResume` 默认 **false**（或：保留默认 true 作为 kill switch，但 `sessionMode` 默认 durable 且 **kill switch 默认 false**）。**最终语义**：新部署 = durable；设 `CURSOR_SDK_DISABLE_SESSION_RESUME=true` 立即回今天。
2. README：删除「不恢复 SDK session resume」那条能力边界；改为解释 durable / kill switch / 会话头 / conversationSeed / 缓存预期。环境变量表补 TTL。
3. `tests/server.test.ts` 里假设「两次请求两次 create」的：加上 kill switch，或给每次唯一 sessionKey，或改为断言「同 seed 则一次 create」。
4. Admin 联通性测试保持唯一 sessionKey + 视为 stateless。
5. 后台运行设置可展示当前 mode（只读即可，避免未做热切换）。**热切换 mode 不在范围**：改 env/重启。

**验收**：`npm test` 全绿；README 与真实默认一致。

---

### WP8 · 验证（人工 + 可脚本化）

见 §6。本 WP 不改功能代码。验证失败则开缺陷回对应 WP，不在本 WP 打补丁堆。

---

## 6. 如何验证

### 6.1 每次 WP 的自动门

```text
npx tsc --noEmit -p tsconfig.json
npm test
```

新增用例最低集（全部 WP 完成后应存在）：

| 用例 | 文件 |
|---|---|
| held execute 状态机 / live skip | `tests/sdk-held-execute.test.ts` |
| 三协议 delta 表驱动 | `tests/prompt-delta.test.ts` |
| Hub TTL / 互斥 / 并行工具 settle | `tests/session-hub.test.ts` |
| 两轮 send 增量、工具同 Run、kill switch、无 seed | `tests/cursor-durable-runner.test.ts` |
| 钉 key、baseline | 扩 `tests/usage-capture.test.ts` 或新文件 |
| 旧 stateless 回归 | `tests/server.test.ts` 显式 kill switch 或唯一 session |

### 6.2 缓存率怎么算

与 SDK 字段一致，**不要**用 `cacheRead/(cacheRead+cacheWrite)` 单独当结论（第一轮会大量 write，看起来像失败）：

```
cache_hit = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
```

对照：

- **首轮**（新 agent）：低 cacheRead、高 cacheWrite 是正常的。
- **同会话第 2+ 轮**（含 tool_result HTTP）：cacheRead 应明显大于首轮；长对话占比应走高。
- **今天的病态**：每轮都 ~50%，且第 N 轮不比第 1 轮更好。

请求日志已存 `cacheReadTokens` / `cacheWriteTokens`。后台请求历史可人工看；不要为了 WP8 新做图表。

### 6.3 人工场景（WP8 清单）

用真实 `GATEWAY_API_KEY` + 至少一把 Cursor key，`CURSOR_SDK_DISABLE_SESSION_RESUME` **不要**设为 true。

**S1 纯文本多轮（无工具）**

```text
1. POST /v1/chat/completions  messages=[{user: "用一句话介绍本仓库"}]
2. 把 assistant 回包拼进 messages，再问 "上一句的最后一个词是什么？"
```

通过：第 2 轮不重复介绍仓库；日志里两次 `cursor_agent_id` 相同；第 2 轮 cacheRead > 第 1 轮。

**S2 工具往返（OpenAI 形状）**

```text
tools=[{function:{name:"lookup",...}}]
1. user: "调用 lookup，参数 q=ping"
2. 模型应 tool_calls；网关返回 finish_reason=tool_calls
3. 立刻 POST 同一会话，messages 带 tool 结果 "pong"
4. 模型应基于 pong 作答，而不是再讲一遍「我要调用 lookup」
```

通过（WP0 pass）：两条日志 **同一 `runId`（若我们把 runId 写入 telemetry）或至少同一 agentId 且第二轮 send 次数为 0**。在 runner 日志打 `[durable] resolve execute id=...` / `[durable] send ...` 以便区分。

通过（fallback B）：同一 agentId，第二轮有 send，payload 仅含 pong、不含第一轮 user 全文。

**S3 Claude Code / Anthropic**

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
真用一轮 Read 工具（或最小 echo 工具）
```

通过：不出现「把上一轮 Read 结果再叙述成新任务」；宿主元工具仍不转发；无双重 shell。

**S4 Responses 续聊**

`previous_response_id` 第二轮只带新 input。通过：同一 agentId；种子继承（已有 conversationSeed 落库）。

**S5 Kill switch**

`CURSOR_SDK_DISABLE_SESSION_RESUME=true` 重启后再跑 S1：两次不同 agentId；行为与改前一致。

**S6 会话隔离**

两个不同 `conversationSeed`（不同首条 user）交错请求：不得串台。

**S7 Hold TTL**

工具调用后不发 result，等到 `TOOL_HOLD_TTL`（测试可把 TTL 降到 2s）：下一请求成功且为新 agent，进程不泄漏（观察一段时间无线性 fd 增长——Windows 上至少确认内存槽位数回到 0，可打 debug 计数）。

**S8 失败隔离**

durable 会话中途把 Cursor key 换成无效值（或停用该 key）：该会话 502/401，**其他会话**仍可用池里下一把 key。

### 6.4 明确的失败信号（验证时对号）

| 信号 | 含义 | 回哪 |
|---|---|---|
| 每轮新 `agentId` | 会话键没对上或误走 stateless | WP1/WP4 |
| 第 2 轮 send 文本含 `ASSISTANT:` | 仍在 flatten 全文 | WP2/WP4 |
| 第 2 轮仍 ~50% 且 send 了全文 | 同上 | WP4 |
| 工具后仍假成功文案进了模型 | hold 没接上或走了 stateless execute | WP3/WP4 |
| 连续 502 | busy send / 未 wait / 坏 resume | WP5 |
| 句柄/内存单调涨 | 未 dispose TTL | WP6 |
| 金额翻倍 | baseline 关了 | WP6 |
| Claude Code 又对齐 schema | 元工具进了 customTools | 禁止回归 P2 |

---

## 7. 回滚

1. **立刻**：环境变量 `CURSOR_SDK_DISABLE_SESSION_RESUME=true` 后重启。应完全回到本计划前的 create+全文+cancel。WP1 必须用测试锁死这条。
2. **部分**：只对无法识别会话的请求走 stateless（D4），不需要开关。
3. **代码**：git revert 本计划相关提交；不改 key 池 schema 的话无需迁移。若 WP5 给 `sdk_sessions` 加了列，回滚代码后多出来的列可留着（SQLite 加列向后兼容）。
4. **禁止**在回滚时手动清 Cursor 云端 agent；local agentId 停用后会被 TTL 回收。

---

## 8. 文件所有权（减少并行冲突）

| 文件 | 主 WP | 他人 |
|---|---|---|
| `src/prompt-delta.ts` | WP2 | 只读 |
| `src/session-hub.ts` | WP3、WP5、WP6 | WP4 只调公开 API |
| `src/tool-compat.ts` | WP3 | WP4 用 hold 开关 |
| `src/cursor-runner.ts` | WP4、WP5 | 最易冲突，WP4 未收工不要并行改 |
| `src/key-rotating-runner.ts` | WP6 | |
| `src/protocol.ts` | 尽量不动 | WP2 可抽公共文本函数；flatten 保留给 stateless |
| `src/server.ts` | WP4 末尾接线 `extractDurableTurn` | 三端点一起改 |
| `src/config.ts` `src/types.ts` `src/index.ts` | WP1、WP7 | |
| `src/agent-store.ts` | WP1 TTL 常量 | 不要改回 SQLite |
| `README.md` | WP7 | |
| `tests/server.test.ts` | WP7 仅改被默认行为破坏的用例 | WP0–6 不要动 |
| `docs/DURABLE-AGENT-CACHE-PROGRESS.md` | 每 WP 收工 | |

---

## 9. 风险与未知数

| 风险 | 缓解 |
|---|---|
| SDK 不支持长时间挂起 execute | WP0 门闩 + §2.1 |
| Claude Code 不发 session 头 | `conversationSeed`（system+首条 user）已存在且稳定 |
| 首条 user 被客户端改写导致 seed 变 | 视为新会话（D11），可接受 |
| 并行工具 settle 窗口漏收 | 25ms + microtask；单测注入；漏收则下一 HTTP 当新调用，可能多一次往返，不致命 |
| Composer 仍用 `<tool_call>` 旁路 | D18 降级 send，不 dispose |
| 共享内存 store 重启丢 checkpoint | idle 会话重启后无法 resume，退化为新 agent（缓存损失可接受）；不回到泄漏 fd 的 SQLite |
| 长 Hold 占着模型连接 | TTL 15min + max live sessions |
| `settingSources: []` 必须保持 | 服务端不要加载宿主编译器的 AGENTS.md |

---

## 10. 与旧文档的关系

- `docs/CLAUDE-CODE-LOOP-FIX-PLAN.md`：P1–P3 已完成，继续有效。其中「P4 明确不改」被 **本文取代**。不要再按那份 P4 把 resume 原样打开。
- `docs/review-fix-plan.md` D6（金额基线落库）：durable 默认打开后必须保持 `trackAgentBaseline=true`。
- 能力边界 README 中「不恢复 SDK session resume」由 WP7 改写。

---

## 11. 建议实施顺序（给执行者）

1. 创建 `docs/DURABLE-AGENT-CACHE-PROGRESS.md` 总览表（WP0–8 均为未开始）。
2. WP0 spike → 写下 held-execute 判决。
3. WP1 → WP2 与 WP3 可并行。
4. WP4（单线程改 `cursor-runner.ts`）。
5. WP5 + WP6。
6. WP7 翻默认 + README。
7. WP8 人工清单；失败只回流对应 WP。
)