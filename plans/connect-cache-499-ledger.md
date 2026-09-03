# 执行账本：缓存命中与 499（SDK 主线）

> 对应方案：`plans/connect-cache-499-plan.md`。本文件只记执行过程，不改方案正文。
> 编排者会话不改 `src/**` / `tests/**`。基线 commit `855fc50`（v0.4.2）。

## 约束偏差

- 用户要求子代理模型 `claude-opus-5`。本环境可选：`inherit` / `composer-2.5-fast` / `cursor-grok-4.6-xhigh`。
- **实际**：探索波子代理全部 `inherit`（与编排者相同的 Grok 4.6）。未静默换成其它 slug。

## 波次 0 — 基线（动手前）

命令：`npm test`（`npm run build && node --test dist/tests/*.test.js`）
工作目录：`E:\docker-composer-api`
HEAD：`855fc50bca9d012c74793324c29ba93b262e585c` `feat: reuse durable agents from protocol identity waterfall`
工作树：`main...origin/main`；未跟踪 `grok-500k-context/`、`plans/connect-cache-499-plan.md`、`src/durable-telemetry.ts`

```
# tests 754
# pass 751
# fail 1
# skipped 2
# duration_ms 6085.7892
exit_code: 1
elapsed_ms: 12753
```

**基线红（不算本任务）**

| # | 测试 | 位置 | 原因 |
|---|---|---|---|
| not ok 363 | 生产 SOCKS connector 使用配置的握手截止时间 | `dist/tests/proxy.test.js:237` | `getaddrinfo ENOTFOUND example.test`（用户提示的 SOCKS 中英文案/环境红项） |

**基线 skip（不算本任务）**

- ok 465 `patchCursorSdkSource matches installed @cursor/sdk ESM bundle` # SKIP
- ok 476 `live SDK held execute survives 2s then wait() finishes` # SKIP no CURSOR_API_KEY or CURSOR_API_KEYS

**未出现的预期红**：用户提示 `cursor-connect-proto` 依赖 `docs/reference/` gitignore fixture。本机 754 条里 Connect proto 相关用例为 pass（fixture 在本工作区可用）。后续对比只认**增量**红。

`npx tsc --noEmit -p tsconfig.json`：未单独跑；`npm test` 先 `tsc -p tsconfig.json` 编译成功（否则到不了 754 tests）。

## 波次 1 — 探索（进行中）

只读。四个并行子代理（均禁止改文件、禁止再派子代理）：

1. 定位阶段 -1 / 1' 改动面与调用点 — **已完成**
2. 验证 `AgentOptions.agentId` 在已安装 SDK bundle 中的真实行为 — **已完成**
3. 验证 60s MCP 超时是否作用于 `customTools` — **已完成：不适用**
4. 梳理持久 store 最小实现面与有界回收 — **已完成**

### 1.1 定位结论（只读，`file:line`）

**阶段 -1 不是 8 行能抄完。** 当前 `http-abort` 在 `src/cursor-runner.ts:797-809`：只保护 path A（`pending.size > 0`）和 path B（`pathB && toolCalls.length`）。纯 text 中断直接 `throw 499`，不 `markIdle`、不打日志。`streamDurable` finally `:255-266` 见 `state==="running"` 且无 pending → `dropDurableSession`。第二条同构泄漏在 `wait()` `:870-879`，只补 pump 分支不够。

语义输出在本文件 = `textParts.length || toolCalls.length`（`:613-633` 局部量）。thinking-only 按方案不算。

现有锁：`tests/cursor-durable-runner.test.ts:547-585`「path B abort after tool_call keeps the idle agent」。新测应对齐：假 agent 先吐 text 再挂起 `wait()`，在首个 `text` 上 abort。

**阶段 1' 调用点：** 生产 `Agent.create`/`resume` 全走 `AgentFactory`，`agentOptions` `:1249-1272` **不传 `agentId`**。`createDurableSlot` `:488-490` create；`tryResumeDurableSlot` `:444-446` resume 的是 store 里那条随机 SDK id。Hub 键唯一生产调用 `cursor-runner.ts:134-140`，**没传 `ownerHash`/`headers`**，身份靠 `conversationSeed` 或 `stickyKey`。

`explicitSessionIdFromHeaders` `:74-89` 认 `x-claude-code-session-id`，**不认** `x-claude-code-agent-id`。`stableUuid` 在 `src/cursor-connect/provider.ts:205-211` 为文件私有；M0 复制进 `durable-id.ts` 导出，禁止改 `provider.ts`。

`durableSlotReplaceReason` `session-hub.ts:230` 仍把 `apiKey` 变化当换槽理由（`tests/cursor-durable-wp5.test.ts:41-51` 锁死）。M0 把 apiKey 移出 Hub 键之后，若 M1 不改这条，轮询换 key 仍会 drop+create。

会翻的既有断言：`tests/durable-id.test.ts:180-188`「不同 apiKey → 不同 Hub id」必须改成**相同** agentId。`routing.test.ts` / `durable-key-pin.test.ts` 不依赖 Hub 公式。

## 已锁死的接口契约（方案为准；待 SDK bundle 子代理交叉确认 agentId 行为）

执行波不得推翻。其余探索子代理只允许补充，不允许改这些决定。

### 身份（M0：`durable-id.ts` / `routing.ts` / `types.ts`）

```ts
export function stableUuid(input: string): string;
// 算法与 provider.ts:205-211 相同：sha256 前 16 字节，version=4，variant RFC 4122，8-4-4-4-12。

export function durableAgentId(input: { ownerHash: string; identity: string; model: string }): string;
// return "agent-" + stableUuid([ownerHash, identity, model].join("\0"))
// 绝不含 apiKey、cwd。

export function durableIdentity(input): string | undefined; // CHANGE
// L1–L4 链保持。命中后若 headers 有合法 x-claude-code-agent-id，追加 `\0agent:${normalized}`。
// explicitSessionIdFromHeaders 仍然不读 agent-id。

export function durableSessionId(input): string | undefined; // CHANGE
// identity = durableIdentity(input)；无 identity → undefined。
// ownerHash = input.ownerHash ?? 从 stickyKey 前缀 `ownerHash:…` 解析。
// 有 identity + model → 返回 durableAgentId（Hub 键 === agentId 字符串）。
// apiKey / workingDirectory 不再参与。字段留在 DurableSessionIdInput 以免旧调用方类型炸。
```

- Hub Map 键、`sdk_sessions`、`Agent.create({ agentId })` **同一字符串**。上线一次冷启动，旧 hex 映射失效，接受。
- `routing.ts` 的 `conversationSeed` **不改**（L3 已混 ownerHash）。
- `types.ts`（M0 独占，M1/M2/M3 只消费）：
  - `CursorRunRequest.ownerHash?: string`
  - `RequestLogRecord.provider?: GatewayProvider`（M3 的 `insertRequestLog` 需要这个字段才能过 tsc；M0 一并加，避免 M3 碰 `types.ts`）
- `provider.ts` 不改（所有权外）。Connect `conversationIdFor` 会间接受益于 identity 折叠 agent-id（server 传入的 seed）。
- M0 测试以改 `tests/durable-id.test.ts` 为主（翻 apiKey 碰撞断言有正当理由）；并加：同 identity 换 apiKey → 同 id；同 session-id 不同 agent-id → 不同 id；不同 ownerHash 同 x-session-id → 不同 id。

### 阶段 -1（M1：`cursor-runner.ts`，`session-hub.ts` 仅在 1' 需要时改）

- 谓词：`textParts.length || toolCalls.length`。thinking-only 仍 499。
- **两条分支都改**：pump `http-abort` `:797-809` **和** `wait()` `:870-879`。
- 有语义输出：`run.cancel()`（不 cancel 则下一轮 `isActiveRunError` → drop+create，阶段 -1 作废）→ **不 dispose agent** → `hub.markIdle` → 正常 `done`。不抛 499，finally 看不到 `running`。
- 零语义输出：保持现在的 499。
- 空闲超时（`signal.reason` 为 504 ApiError）**不**改成 200；只修客户端断连/ESC。
- 新测：吐字中 abort → slot 存活、`state==="idle"`、agent 未 dispose。path B 那条保持绿。

### 阶段 1' runner 侧（M1，M0 落盘且 tsc 过后再动）

- `agentOptions` 传入 `agentId: durableAgentId(...)`。
- 首次 `create({ agentId })`，后续 `resume(agentId)`；同 id 二次 create 会抛，沿用 `ensureDurableSlot → tryResumeDurableSlot`。
- `stream()` 算 Hub 键时传入 `ownerHash: input.ownerHash`（及 sticky 回退，与 M0 一致）。
- **删除** `durableSlotReplaceReason` 的 apiKey 换槽（`:230`）。换 key 只更新 `slot.apiKey`，不 drop。wp5 相关断言在回执里说明理由后改。

### 接线（M2 `server.ts`，与 M1 并行但依赖 M0 类型）

- 建 `CursorRunRequest` 时写入 `ownerHash`（来自 `AuthContext`）。CORS 补 `x-claude-code-agent-id`（浏览器预检，非主线）。

### 1.3 60s MCP 超时（已完成，低优先）

**裁决：DOES NOT APPLY，不进执行波。**

path A `customTools.execute` 是进程内 `McpExecutor` 回调，不经过 `318.js` 的 `Protocol.request` / `_setupTimeout` / `timeout ?? 6e4`。`357.js` 把 custom-user-tools 并进工具表只用于 listing；真正 `callTool` 的 60s 只打在真实 MCP server。pi-cursor-sdk 的 `setTimeout` monkey-patch 针对 loopback MCP，我们不开那个口。

不写 70s 挂起单测：现有 mock（`HeldToolAgent` 直接调 `execute`）根本不加载 MCP Protocol，假绿。若以后要交叉验证，只扩 `sdk-held-execute.test.ts` 那条已 skip 的 live 测（>60s），不进默认 `npm test`。

### 存储与接线（M3：`agent-store.ts` / `store.ts` / `index.ts` / `config.ts` / `Dockerfile`）

- **一个**进程级 `node:sqlite` 文件，路径 `join(dirname(SQLITE_PATH), "agents.sqlite")` → 容器内 `/data/agents.sqlite`。禁止 SDK `SqliteLocalAgentStore.open`（每 agent 一份 `store.db`），禁止 Jsonl，禁止写进 `state.sqlite`。
- 实现完整 `LocalAgentStore` 四面（agents/checkpoints/runs/runEvents），`sdkMetadata.blobEncryptionKey` 原样落盘。有界回收：idle TTL + LRU `DELETE` 行，**不关连接、不 unlink 每 agent 文件**。上限/TTL 复用已有 `CURSOR_SDK_MAX_LIVE_SESSIONS` / `CURSOR_SDK_SESSION_IDLE_TTL_MS`；kill switch 开时仍注入 store，TTL 10min/256（与今日 ephemeral 三元式相同）。
- `createEphemeralAgentStore` **保留**（`tests/server.test.ts:5578` 在用；M3 不能改那个文件）。
- `CURSOR_SDK_DISABLE_SESSION_RESUME` 语义不动。
- `request_logs` 加 `provider TEXT`：CREATE + `migrateRequestLogColumns` + `insertRequestLog` + `rowToLog` + MemoryStateStore 同步。`updateRequestLogUsage` 不加 provider。
- Dockerfile runtime 阶段：`ARG GIT_SHA=unknown` / `ARG BUILT_AT=unknown` → `ENV`。M3 只注入；M2 读 `process.env` 填 `/health`。compose 未传 build-arg 时显示 `unknown`，接受（`docker-compose.yml` 非 M3 所有权）。
- 新测只写 `tests/agent-store.test.ts`：重开同 path 读回 blob key；LRU=2 淘汰含 blob；单文件无 `agents/*/store.db`；`request_logs.provider` 往返 + 缺列迁移。

### 1.2 SDK `agentId`（已安装 `@cursor/sdk@1.0.27`）

- `AgentOptions.agentId` 是公开字段（`options.d.ts:335`），无 JSDoc。
- `conversation_id === agentId`，无变换（`sessionId: this.agentId` → `AgentRunRequest.conversation_id`）。
- 同 id 二次 `create`：store 层抛 `Error("Agent ${id} already exists")`，`Agent.create` 包成 `UnknownAgentError`，`isRetryable: false`。**dispose 不删 store 行**，必须 `resume`，禁止再 create。
- 本地**不校验** uuid 形状；`bc-` 前缀会把 `resume` 打到 cloud。我们仍用 `agent-` + `stableUuid`（方案要求）。
- `blobEncryptionKey` 在 `sdkMetadata`；resume 时缺失会**静默新造**一把（缓存失效），所以持久 store 必须原样落盘。
- 无 `exists()`；查重 = `store.agents.get`（现有 `ensureDurableSlot → tryResumeDurableSlot` 对得上）。
- 网关 ephemeral 的 `agents.create` 是 upsert，SDK adapter 仍先 get 再抛 already exists；TTL 淘汰后同 id create 会变成新会话+新 blob key。

## 探索波收口

四份只读报告齐。契约已锁（上文）。60s MCP 不进执行波。接下来只派 **M0**，`tsc` 过后再并行 M1/M2/M3。

## 波次 2 — 执行

### M0 身份 — **已完成**（编排者复核 `npx tsc --noEmit` exit 0）

- `src/durable-id.ts`：`stableUuid` / `durableAgentId`；Hub 键 === `agent-`+uuid；identity 折叠 `x-claude-code-agent-id`
- `src/types.ts`：`CursorRunRequest.ownerHash`、`RequestLogRecord.provider`
- `tests/durable-id.test.ts`：26 pass / 0 fail
- `src/routing.ts` 未改

### 执行波收口（编排者）

```
npx tsc --noEmit -p tsconfig.json   # exit 0
npm test                            # tests 791 / pass 789 / fail 0 / skipped 2
```

基线是 754 / 751 / **fail 1** / skip 2。增量约 +37 测；**无新红**。基线 SOCKS `not ok 363` 这次未复现（环境闪烁，不记功也不记过）。

改动面（相对 HEAD `855fc50`）：`Dockerfile`、`src/{admin,admin-ui,agent-store,cursor-runner,durable-id,index,server,session-hub,store,types}.ts`、`tests/{durable-id,cursor-durable-wp5}.test.ts`；新文件 `src/durable-telemetry.ts`、`tests/{agent-store,cursor-durable-cache-499,durable-telemetry,health-observability}.test.ts`。

进入审阅波（只读）。

### 审阅回流

- 契约/质量：**PASS**
- 目标达成：**FAIL**（SSE `return()` 仍会 finally-drop）→ 回流 M1
- M1 补丁：`consumeDurablePump` `try/finally`（`src/cursor-runner.ts:877-1033`）在有语义输出且非 504 时 `await parkKeepAlive()`；`parkKeepAlive` 记 `reuse/keep-alive-abort`
- 新测：`generator return after text parks keep-alive without aborting the signal`
- 编排者复核：`tsc` 0；定向 23/23；全量 **792 tests / 790 pass / 0 fail / 2 skip**（较执行波收口 +1 测）

## 波次 3 — Docker live（阶段 0' + 3'）

```
docker compose build --build-arg GIT_SHA=855fc50bca9d-dirty --build-arg BUILT_AT=2026-09-03T11:12:30.5045807Z
docker compose up -d
curl http://127.0.0.1:8787/health
LIVE_GATEWAY_URL=http://127.0.0.1:8787 node scripts/live-durable-smoke.mjs
```

`/health`：`gitCommit=855fc50bca9d-dirty`，`sessionMode=durable`，`uptimeSeconds` 正常。冒烟后 `hitRatio≈0.335`，`decisions={create:4, reuse:3}`。

启动日志：`Cursor SDK session mode: durable`。`GATEWAY_API_KEY` 空，走 `CURSOR_API_KEY` + `allowDirectCursorKeys`（direct）。

### 冒烟 `ALL LIVE CHECKS PASSED`（grok-4.6）

| 场景 | 结果 | SDK 桶（turn-ended） | 命中率 cacheRead/(input+cacheRead+cacheWrite) |
|---|---|---|---|
| S1-turn1 | 200，未复读 | input=3403 cacheRead=0 output=512 totalField=3915 | 0 |
| S1-turn2 | 200，未再介绍仓库 | input=3973 cacheRead=3392 output=206 totalField=7571 | **3392/7365 ≈ 46.1%** |
| S2-tool-call | tool_calls / lookup | 首包 usage estimated | — |
| S2-tool-result | 200，含 pong | input=15677 cacheRead=10304 output=238 totalField=26219 | **10304/25981 ≈ 39.7%** |
| S4 两轮 Responses | 200 | turn2 input=4030 cacheRead=3392 totalField=7770 | 3392/7422 ≈ 45.7% |
| S3 messages | 200 | input=3397 cacheRead=0 | 首轮 0 |

日志：S1 同一 `session=agent-fb9f23` **create 一次 + send first + send follow-up**，无 `drop+create`。S2 见 `[durable] resolve execute`（path A held execute 真机成立）。新会话先 `resume failed ... not found` 再 create，是空 store 冷启动，不是中断毁槽。

### 阶段 0' usage 口径（已确认）

`totalField`（SDK 自带 totalTokens）= `input + output + cacheRead + cacheWrite`：
- 3973+206+3392+0 = **7571**
- 15677+238+10304+0 = **26219**

**加法口径，不是划分。** `parseSdkUsage` 的 `totalTokens` 公式保持不变是对的。OpenAI `prompt_tokens` 往往已经是 input+cacheRead（7365=3973+3392），冒烟脚本用 `cacheRead/(prompt+cacheRead)` 会把分母算重（报 0.315，真实 0.461）。后台应按 SDK 四桶。

Cache Write 恒 0，符合 Grok 家族。

### 未覆盖（需用户用 Claude Code 指过来）

- ≥20 轮真实对话、ESC 吐字中中断、Task 子代理：冒烟只有短会话。额外流式 abort 脚本在 3ms 就 499（零语义输出，走旧路径），**没有**打出 `[durable] keep-alive abort`；单测已锁 `generator.return()`。
- 第二轮未到外部参照 ≈90%：上下文太短（follow-up 32 字）。同 agent 已从 0 升到 ~46%，方向对。
- `docker-compose.yml` 未写死 build-arg（非模块所有权）；本次 CLI `--build-arg` 已注入。

`request_logs`：7 条冒烟全 200，`provider=sdk`，无 499（abort 实验另有 1 条 3ms 499）。抽样见上表。

## 根因结案

| 根因 | 状态 | 证据 |
|---|---|---|
| 1 conv_id 每轮变 | **修好** | 同 session 两轮同一 `agentId`；create 一次、第二轮 `send follow-up` |
| 2 中断毁槽 | **单测修好；live ESC 未跑成** | `try/finally` parkKeepAlive + `generator return` 测绿；live 3ms 零输出 499 是预期 |
| 3 新槽无历史 | **随 1+2 修好** | S1-turn2 未复读开场；依赖不再 drop |
| 4 主/子代理撞键 | **代码修好；Task live 未测** | identity 折叠 `x-claude-code-agent-id`；单测分槽 |

## 明确未做

Connect / cache_control / settingSources / MCP 60s（已确认不适用）/ PARALLEL_TOOL_SETTLE_MS / 工具表 JSON 序 / README 阶段 4' / commit+push / 每 20 轮强制重建 / kill switch 语义。


**M1 runner — 已完成**（定向 51 测全绿）

- 阶段 -1：有语义输出的客户端 abort → cancel Run + `markIdle` + `done`，不 499；504 空闲超时不改成 200
- 阶段 1'：durable create/resume 传 Hub 键为 `agentId`；无 live 槽先 resume(sessionId)；already-exists 回落 resume
- 去掉 apiKey 换槽；活槽换 key 只更新 `slot.apiKey`
- 新测 `tests/cursor-durable-cache-499.test.ts`；`wp5` apiKey 断言已翻
- 已接 `recordDurableDecision`；`parseSdkUsage` 打原始 turn-ended 桶（total 公式未改）

**M2 可观测性 — 已完成**（17 新测全绿）

- `src/durable-telemetry.ts`：进程内计数，导出 `recordDurableDecision` / `recordDurableCache` / `recordIdentitySource` / `durableTelemetrySnapshot`
- `/health`：`gitCommit` / `builtAt` / `sessionMode` / `uptimeSeconds` + 无 session id 的 durable 摘要
- `/admin/api/overview` + admin-ui Durable 面板
- `finishLog` 门槛 `status >= 400`；`setErrorHandler` 对未 `beginLog` 的错误补 `request_logs`
- `loggedRunRequest` 写 `ownerHash`；CORS 加 `x-claude-code-agent-id`

**M3 持久 store — 已完成**（`tsc` exit 0；agent-store 6/6、store 15/15）

- 一份 `dirname(SQLITE_PATH)/agents.sqlite`，idle TTL + LRU，`createEphemeralAgentStore` 仍导出
- `request_logs.provider` 列 + 迁移
- Dockerfile runtime `GIT_SHA` / `BUILT_AT`
- kill switch 仍始终注入 store，只改 TTL
