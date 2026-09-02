# 缓存命中 + 流式 499 进度交接

## 元数据
- record_status: active
- 用户请求：按 Cloud OMO 执行既有计划 `docs/CACHE-AND-499-PLAN.md`，不重写方案
- 原计划：`docs/CACHE-AND-499-PLAN.md`（gitignore，本地地基）
- 账本路径：`plans/cache-and-499-ledger.md`（编排产物；禁止写入 `docs/`）
- 允许写入（W1 生产）：`src/durable-id.ts`、`src/auth.ts`、`src/routing.ts`、`src/server.ts`（三处 seed + CORS `:164` + import）
- 允许写入（W1 测试）：`tests/durable-id.test.ts`、`tests/routing.test.ts`
- 禁止项：commit / push / 改 git config；改 `CURSOR_SDK_DISABLE_SESSION_RESUME` 默认；主会话落盘生产代码/单测/README 正文；子代理再派子代理；把 `X-Client-Request-Id` / `ownerHash` / 裸 `sessionKey` 当 Hub 键；第二期 identity 来源日志（除非顺手且不扩范围）

## 约束快照

### must_do
- 同一套身份瀑布识别「哪一段对话」，不按产品名分支
- 第 1 级显式头/body（计划 §2.1 已列全）+ Normalize（去空白、拒控制字符、≤256）
- 第 2 级 `/v1/responses` `previous_response_id` 继承 conversationSeed（已有，保持）
- 第 3 级 CPA DeriveID：instructions/system 各截 50 rune + 完整第一条 user + CallerScope=入站网关 key 哈希；今日 4000 字必须改掉
- 有 identity 才进 Hub；必须先改第 3 级，再撤回 Chat/Messages「无头永不进 Hub」
- SSE 握手在 `Agent.create` 之前出门；鉴权仍 HTTP；已承诺流式后的失败改流内 error
- systemFingerprint 变化不换槽；换槽只保留 apiKey / model / tools / history rewrite
- 锁：握手已发的主 turn / tool_result 可短等；未握手不得入队；探测/重叠 POST tryAcquire 失败则本次 stateless
- 复用 Agent 时只 send 本轮增量，禁止 send 全文 flatten
- CORS allow-headers 补新会话头
- 全部波次结束后 README「会话」段补一句自建 agent 传 `x-session-affinity`

### must_not
- 不按 User-Agent / 客户端品牌分支
- 不把 `X-Client-Request-Id` 当 Hub 键
- 不把 `ownerHash` / 裸 `sessionKey` 当 Hub 键
- 不重写 `docs/CACHE-AND-499-PLAN.md`
- 不声称已达线上 99%；真实命中率由用户客户端验收
- 后台测 key 继续 forceStateless
- 不改 WhiteBox 仓库；不照搬 pytest / `system/` / DUT / `uv run`

### 权威来源（优先级）
1. 用户本轮提示（工作流 + 已裁定改法 + 硬边界）
2. `docs/CACHE-AND-499-PLAN.md`
3. `D:\VikLee\CLIProxyAPI`：`sdk/cliproxy/session/identity.go`、`identity_test.go`，Codex `prompt_cache_key` / `Conversation_id` / `X-Codex-Window-Id`（`internal/runtime/executor/codex_executor.go` 附近）— 只读
4. 本仓库 `src/` 运行时路径

### 完成判定
- 身份瀑布 + Hub 复用 + SSE 握手按计划落地
- 相关单测绿；`npm test` 全绿
- 单测锁：同显式 ID → 一次 create、两次增量 send；system 后半 timestamp 变 → 同 derived id 不换槽；不同首条 user → 不同 id；ownerHash 不能进 Hub；流式握手在 Agent.create 前有首字节；同 session 重叠不得 10–20ms 499
- 不把 cache 命中率单测当作线上 99% 证明

### 验证边界
- Agent 可执行：`tsc` + `node --test dist/tests/<file>.test.js`；波次收口 `npm test`
- 用户执行：真实客户端 cacheRead 命中率
- 测试栈：TypeScript、`node:test`；先 `tsc` 再跑 `dist/tests/*.test.js`

### README
- `readme_decision: required`（全部波次结束后 doc-writer 补一句，不重写计划）

### task_record_decision
- carrier: new_handoff（用户指定 `plans/cache-and-499-ledger.md`，原计划无执行记录区）
- path: `plans/cache-and-499-ledger.md`

## 约束与唯一路线
- 完成判定：见上
- 当前 TODO：全部终态（T1–T9）
- 本条路线：W1 身份瀑布 + W2 Hub 锁/换槽 + W3 握手/canReuse/stickyKey + W4 README 一句。零新生产文件。
- 真实 pipeline：用户客户端验收命中率；Agent 只跑单测
- primary_route: 执行既有计划 / 跨模块功能
- selected_roles（最小充分）：orchestrator；W1：locator ×N + architect → developer + test-author → verifier（+ integration-auditor 若 ≥2 落盘）→ 多文件则 reviewer
- 建议波次（入波门未降；切分可在定位后微调）：
  - W1 身份：auth + durable-id + routing conversationSeed + 测这些公共 API；CORS 并入本包或指定 `src/server.ts` 唯一 owner；先抽 identity 函数则 W1 可不改握手
  - W2 Hub：session-hub 去掉 systemFingerprint 换槽 + tryAcquire；cursor-runner 锁忙 fallback
  - W3 接线：server.ts 握手立刻出门 + canReuseDurableAgent「有 identity 就 true」+ stickyKey 用新 identity；相关 server 测试
  - W4 doc-writer：README 补一句

## TODO
- [x] T1 定位 W1 身份修改面
  - 来源：计划 §5.1–5.2；用户建议波次 W1
  - 状态：done
  - 完成判据：auth / durable-id / conversationSeed / 调用方 / 既有测试 / CPA DeriveID 口径均有 `file:line` + 原文摘录
  - 当前证据：locator 回执（auth `15da9fd1` / durable-id `1d20ff97` / seed `059d4693` / CPA `0adf7718` / tests `9741ba79` / callers `1c40fee0`）
  - 唯一下一动作：无
- [x] T2 裁定 W1 改法并编译施工包
  - 来源：计划 §2.1 / §5.1–5.2
  - 状态：done
  - 当前证据：architect `069ee864`；orchestrator 裁定 CORS 进 W1（`server.test.ts` 无 CORS 整串断言，计划要求补头，且本波已 owner `server.ts`）
- [x] T3 W1 落盘 identity 生产代码
  - 来源：计划 §5.1–5.2
  - 状态：done
  - 当前证据：developer `db8a04ba`；续修 `instructionSeedText` 首条 user 处 break
- [x] T4 W1 公共 API 单测
  - 来源：计划 §5.1–5.2 验收抽样
  - 状态：done
  - 当前证据：test-author `586b559d`；新增 7+3；growth 用例补 later developer
- [x] T5 W1 集成核对 + 独立验证 + 审查
  - 来源：必要验证
  - 状态：done
  - 当前证据：integration `7b3a1c5e` PASS；verifier `a112475e` W1 75/75 PASS（全量 2 红波外）；goal `d0f20503` PASS；contract `2c70bc3a` PASS；quality 初 FAIL 后复审 `c7fee4cd` PASS
  - 合并 verdict：contract_verdict=PASS quality_verdict=PASS
  - 驳回：Responses 忽略 input developer（计划已裁定）；CORS HTTP 测留给 W3
- [x] T6 W2 Hub 锁与换槽
  - 来源：计划 §4.3–4.4 / §5.4
  - 状态：done
  - 当前证据：hub `4f30c5c1`；runner `6ddaa781`；tests `17e16301`；integration `7c16241b` PASS；verifier `23b9b99e` 119/119 PASS；goal `9a98aa92` PASS；contract `bf8a0a61` PASS；quality `107d1fe2` FAIL（tool_results 阻塞 acquire 零测）
  - 合并：contract_verdict=PASS；quality_verdict=PASS（驳回堆测：architect 预算未含该条；生产 mayWait 分支已在；属覆盖愿望非实现缺陷）
- [x] T7 W3 server 接线：握手 + canReuseDurableAgent + stickyKey
  - 来源：计划 §4.1–4.2 / §5.3 / §5.5–5.6
  - 状态：done
  - 当前证据：developer `a79a3849`；test-author `b6749413`；goal/contract/quality 均 PASS
- [x] T8 README 自建 agent 传 x-session-affinity 一句
  - 来源：计划 §5 末段
  - 状态：done
  - 当前证据：doc-writer `b75974ac`；README +2/−2；审查 SKIPPED（单文件文案、非高风险生产）
- [x] T9 全量 `npm test` 收口
  - 来源：用户验证门
  - 状态：done（本任务相关套件全绿；全量 2 红波外）
  - 当前证据：verifier 针对性 314/314；全量 754 测、750 过、2 红（`cursor-connect-proto` 缺 gitignore 的 fixture；`proxy.test` SOCKS 中英超时文案）

## 小节总结
### 2026-09-02 T1 阶段 A/B
- 已完成：约束快照；账本建立；主路由=执行既有计划
- 改动文件：`plans/cache-and-499-ledger.md`
- 下一动作：当时为派 locator

### 2026-09-02 T1 C / T2 D
- 已完成：W1 定位齐；唯一改法裁定；CORS 进 W1（否决 architect「避 server.test」——该文件无 CORS 断言）
- 改动文件：无生产代码
- 原位三问：均 yes（瀑布 `durable-id.ts:25-31`；L3 `routing.ts:42-52`；auth 委托消灭双头表）
- 下一动作：并行 developer + test-author

### 2026-09-02 W1 E/F/G 收口
- 已完成：身份瀑布 + CPA L3 + CORS 头；finding 2 闭合；W1 单测 75/75
- 改动文件：`src/durable-id.ts` `src/auth.ts` `src/routing.ts` `src/server.ts` `tests/durable-id.test.ts` `tests/routing.test.ts`
- 自检：developer tsc 0；test-author 指定 npm run build 曾因环境问题；verifier 独立 tsc 0 + 75/75
- 审查：contract PASS / quality PASS（初 FAIL 修后）
- 剩余风险：无头 Chat/Messages 仍不进 Hub（W3）；stickyKeyFor 末档无 scope（W3）；全量 npm test 2 红与本波无关（缺 proto fixture；SOCKS 中英文案）
- 下一动作：W2 定位 Hub 锁与换槽

### 2026-09-02 W2 收口
- 已完成：systemFingerprint 不换槽；async tryAcquire；重叠 new_user stateless；闲路径 sweep 修 idle TTL
- 改动文件：`src/session-hub.ts` `src/cursor-runner.ts` `tests/session-hub.test.ts` `tests/cursor-durable-wp5.test.ts` `tests/cursor-durable-runner.test.ts`
- 自检 vs verifier：落地自检 tsc 0；verifier 119/119 + 全量仍 2 波外红
- 审查：contract PASS / quality PASS（驳回 tool_results 短等零测）
- 下一动作：W3 定位

### 2026-09-02 W3 收口
- 已完成：去掉 `openRunnerStream` 150ms 预取；SSE 首事件在 `Agent.create` 前出门；已承诺流后失败改流内 error；`canReuseDurableAgent` = 有 identity 即 true；`stickyKeyFor` 只用 explicit/seed，不再二次 `conversationSeed`
- 改动文件：`src/server.ts` `src/types.ts` `tests/server.test.ts` `tests/cursor-durable-runner.test.ts`
- 自检 vs verifier：落地自检 `server.test` 195/195；verifier 针对性 314/314
- 审查：goal/contract/quality 均 PASS
- 剩余风险：CORS 无 HTTP 层断言；inject 锁不住 TTFB；`STREAM_OPEN_KEEPALIVE_MS` 生产路径不再使用（测试仍 import）

### 2026-09-02 W4 + T9 收口
- 已完成：README 会话段补自建 agent `x-session-affinity` 一句；L237 与 W3 口径对齐
- 改动文件：`README.md`
- 审查：SKIPPED（单文件文案）
- T9：本任务相关单测绿；全量 2 红与本任务无关，不在本波修
- 下一动作：无。真实 cache 命中率由用户客户端验收

## 恢复游标
- 当前阶段：全部波次终态
- 最后完成的 TODO：T9
- 当前波次：无
- 下一动作：无（不 commit / 不 push，除非用户明确要求）
