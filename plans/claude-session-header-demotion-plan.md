# x-claude-code-session-id 伪装头降权 —— 修复串会话计划 v2

> 版本基线：HEAD = `75264b9 feat: durable anti-cross-talk guardrails for derived-L3 identity collisions`。
> 部署方式：`git pull` + `sudo docker compose up -d --build`。
>
> **硬约束：durable / reuse（park + 复用 agent）策略不许删、不许绕过。**
> 本计划不删任何复用路径，只修正「会话身份」的判定来源。
>
> **v2 变更（经 Cursor 独立审查后修订）**：
> 1. §0/§1 因果修正：CPA 补 session 头**不依赖**把客户端认成原生 Claude Code——`claude-api-key`
>    链路上客户端没自带 session 头时，CPA 一律按 key 盖（`CachedSessionIDRequired`）。快照里的
>    claude-cli/2.1.63 + Linux + SDK 0.74.0 全套指纹是**服务器上旧版 CPA** 盖的（容器 Linux、
>    本机 Windows、且与 CPA 旧版注释值吻合），不是 byok 预设（那是 2.1.177、无 x-app）。
> 2. §2.1 信任判据收紧（v1 的致命漏洞）：**legacy user_id 一律不采信头**——包括「legacy 且与头
>    一致」。新 CPA 的 `injectFakeUserID(cache-user-id=false)` 会生成 session 段 = per-key 头值的
>    user_id，v1 规则会把它当老版 claude-cli 放行，CPA 一升级洞就重开。
> 3. §2.1 补充 JSON **对象**形态的 `user_id`（现有 `explicitFromMetadataUserId` 认对象，v1 只写
>    了字符串，两边口径打架）。
> 4. §2.5 补充风险：压缩导致 L3 seed 漂移（durable 在压缩点断开）；`stickyKeyFor` 仍读原始头
>    （key 粘性共享，非正确性问题，接受）。
> 5. §4 否决项新增「legacy+一致即采信」。
> 6. 审查确认的实现要点：runner 不收 headers、身份由 server 算好经 `conversationSeed` 传入，
>    因此降权逻辑必须落在 `durableIdentity` + `noteDurableIdentity` 两处且共用同一判定函数。

---

## 0. 一页结论

**症状**：Cursor（经 cursor-byok → CPA/CLIProxyAPI → 本网关）并发多会话时，会话 A 的工作内容/记忆
出现在会话 B 的回答里；伴随子代理不可用、上下文显示膨胀到 1M+ 触发压缩。

**根因（快照实锤，含 Cursor 审查补充的铁证）**：
1. CPA 在 claude-api-key 链路上，对**没自带 session 头的客户端**一律注入
   `X-Claude-Code-Session-Id = CachedSessionIDRequired(apiKey)`——**每把上游 key 缓存一个
   UUID，与客户端是否被认成原生 Claude Code 无关**。byok 不带任何会话头，于是整条链路上
   所有会话共享这一个头值。
2. 本网关身份瀑布 L1 无条件采信 `x-claude-code-session-id`（`durable-id.ts:110`）→
   同头 + 同 ownerHash + 同模型 = 同 `durableSessionId` = 同 SessionHub 槽 = 同一个上游
   SDK agent。
3. `75264b9` 的护栏（fresh_session / foreign_tool_results / 严格模式）全部门控
   `identitySource === "derived-L3"`；本链路被归档为 `header` → 护栏零触发。

**铁证**（`plans/debug/` 四快照，13:35–13:36）：
- 四请求 `x-claude-code-session-id` 恒为 `e2fdb363-…7670`；
- 四请求 `finish.agentId` 全部是 `agent-817ee28e-9695-4ace-bf54-6db11890021e`（不是理论共享，
  是已共享）；start 与 3 还共享同一 `runId`；两段不同 Cursor 对话的工具结果带同一条
  `tool_afee27b1-…` tool id；
- `metadata.user_id` 的 `user_` 段、`account_` 段、`session_` 段**每请求全部随机**（旧版 CPA
  伪造行为），与头对不上；
- 头指纹 `claude-cli/2.1.63 + x-app: cli + Linux + 0.74.0` = 服务器旧版 CPA 的注入值。

**修复（方案 A，v2 判据）**：`x-claude-code-session-id` 头命中时，仅当 body 的
`metadata.user_id` 是 **JSON 形态**（对象或 JSON 字符串）且其 `session_id` 与头**逐字相等**才
采信；其余一切情形（legacy 格式、不一致、user_id 缺失、畸形）→ 忽略该头并把该 body 的
`metadata` 一并从身份推导中剥离 → 身份瀑布落到 L3 内容推导 → `identitySource` 归档为
derived-L3 → 已上线的三个护栏自动接管。

---

## 1. 背景

### 1.1 链路

```
Cursor IDE → cursor-byok（本地网关，anthropic provider，不带任何会话头/user_id）
           → CPA / CLIProxyAPI（服务器上的旧版；本网关是它的 claude-api-key 上游）
           → 本网关（/v1/messages，durable 模式）
           → Cursor SDK 上游（@cursor/sdk Agent）
```

### 1.2 身份瀑布现状（src/durable-id.ts）

| 级 | 来源 | 本链路实际值 |
|---|---|---|
| L1 | 显式会话头（11 个，含 `x-claude-code-session-id`） | CPA 注入的 per-key 常量 → 命中被采信 |
| L2 | body 字段（session_id / metadata.user_id / …） | user_id legacy 随机（L1 先命中没轮到） |
| L3 | conversationSeed = hash(system 前 50 rune + 首条 user 全文 + ownerHash) | 未触达 |

### 1.3 调用路径（Cursor 审查确认）

- **server**：`noteDurableIdentity`（`server.ts`）用 headers+body 调 `durableIdentity` 得 seed →
  经 `loggedRunRequest` 塞进 `run.conversationSeed`，同时按「头里能否抽出显式 id」归档
  `identitySource`（只看头、不看 body）。
- **runner**：`cursor-runner.ts:156-163` 调 `durableSessionId` 时**不传 headers/body**，瀑布第三档
  直接吃 server 传来的 seed。效果等同 L1 采信。
- 推论：**只改 runner 没用；降权必须改 `durableIdentity`（管 seed）+ `noteDurableIdentity`
  （管 identitySource 归档，决定护栏是否激活），且两处共用同一判定函数**，否则会出现
  「seed 已是 L3、source 仍是 header」的劈叉——护栏依旧不生效。

### 1.4 为什么 75264b9 的护栏没拦住

见 §0 根因第 3 条。另（审查补充）：`inboundAssistantTextMismatch` 对 tool_results 轮本身就不
查 digest，两个客户端往同一槽回同一条 tool id 时历史分叉检查也绕开——所以护栏激活是必须的，
不是锦上添花。

### 1.5 为什么不能只改 byok / CPA 配置

- 删 byok 伪装头 / CPA 关 cloak 只救这一个部署；任意客户端只要让 CPA 走出「没带 session 头 →
  按 key 补头」这条既有路径，就会复现。不开源客户端无法要求它带会话 id。
- 网关必须能识别「头与 body 配不上 / 头是孤证」的中间层链路。

---

## 2. 改动设计

### 2.1 核心判据（v2 收紧版）

新增纯函数（`src/durable-id.ts`）：

```ts
/**
 * x-claude-code-session-id 是否被 body 的 metadata.user_id 佐证。
 * 采信条件（全部满足）：
 *   1. user_id 存在且为 JSON 形态——对象 {"session_id": ...} 或 JSON 字符串
 *      "{\"session_id\": ...}"（真 claude-cli ≥2.1.78 的形态，两种都要认，
 *      与 explicitFromMetadataUserId 的解析口径对齐）；
 *   2. 提取出的 session_id 与头值（两侧都过 normalizeExplicitId）逐字相等。
 * 其余一律 false：legacy 串（user_…_session_<uuid>，哪怕尾段与头一致——新 CPA cloak
 * 会造出这种一致，采信即重开洞）、user_id 缺失、session 不一致、畸形 JSON。
 */
export function claudeSessionHeaderTrusted(
  headers: DurableSessionHeaders | undefined,
  body: unknown
): boolean
```

判定矩阵：

| body 的 metadata.user_id | 头 session 一致？ | 结果 |
|---|---|---|
| JSON（对象/字符串），含 session_id | 一致 | **采信**（真 claude-cli） |
| JSON（对象/字符串），含 session_id | 不一致 | 降权 |
| legacy 串（任何形态，含与头一致） | — | **降权**（v1 漏洞修正） |
| 缺失 / 非字符串非对象 / 畸形 | — | 降权（头孤证） |

### 2.2 瀑布改造（durableIdentity）

`claudeSessionHeaderTrusted(headers, body) === false` 且头存在时：

1. **忽略该头**：L1 候选里剔除 `x-claude-code-session-id`（其余 10 个显式头照常——没有
   中间层注入它们的先例，且语义不同，验伪只针对这一个头）；
2. **剥离该 body 的 metadata**：L2 求值时不含 `metadata.user_id`（legacy 随机 user_id 若留在
   L2 会给出每请求都变的身份 = durable 直接失效，比串更糟）。`session_id` / `conversation_id` /
   `prompt_cache_key` 等其他 body 字段不受影响；
3. 瀑布继续：Responses 继承 seed → L3 conversationSeed → stickyKey。

实现：`durableIdentity` 内部先做降权（单一事实源），导出两个小工具供 server 复用：

```ts
export function claudeSessionHeaderDemoted(headers, body): boolean; // 是否触发降权
export function withoutClaudeSessionHeader(headers): DurableSessionHeaders | undefined;
export function withoutBodyMetadata(body: unknown): unknown;
```

`durableIdentity(input)` 开头：

```ts
const demoted = claudeSessionHeaderDemoted(input.headers, input.body);
const headers = demoted ? withoutClaudeSessionHeader(input.headers) : input.headers;
const body = demoted ? withoutBodyMetadata(input.body) : input.body;
// 现有瀑布不动，全部改用局部 headers/body
```

幂等：对已剥离的输入再判一次 `claudeSessionHeaderDemoted` = false（头已不在），server 预剥离
后传入不会双重处理出歧义。

### 2.3 server 归档同步（noteDurableIdentity）

现状只看 `explicitSessionIdFromHeaders(request.headers)` 就归档 header。改为：

```ts
const demoted = claudeSessionHeaderDemoted(request.headers, body);
const effectiveHeaders = demoted ? withoutClaudeSessionHeader(request.headers) : request.headers;
const effectiveBody = demoted ? withoutBodyMetadata(body) : body;
// seed 用 durableIdentity（内部自带降权，传原始/预剥离皆可，结果一致）
// 归档与 fromBody/derived 比对全部用 effectiveHeaders / effectiveBody
```

- `explicitSessionIdFromHeaders(effectiveHeaders)` 命中 → source=header（真 claude-cli 不变）；
- 否则按原逻辑落 body-field / derived-L3——**降权链路落 derived-L3，三个护栏激活**；
- 降权发生时打一行日志（与既有 `[durable-identity]` 同格式）：
  `[durable-identity] demoted=x-claude-code-session-id source=derived-L3 seed=<12位> protocol=…`，
  便于线上确认降权生效面。

### 2.4 客户端兼容矩阵（改后行为推演）

| 客户端 | 表现 | 改后身份 | 结果 |
|---|---|---|---|
| 真 claude-cli 直连（≥2.1.78，JSON user_id 与头一致） | 头+body 配对 | L1 header | **不变** |
| 极老 claude-cli（legacy user_id） | legacy 串 | L3 derived | 退到 L3（审查认可的代价）；同机同天会话可能撞 seed → fresh_session 护栏兜底 |
| **byok + CPA（本链路）** | 头 = per-key 常量；user_id legacy 随机 | **L3 derived** | 会话区分度恢复；同模板同分钟碰撞由护栏拦；严格模式可用 |
| claude-cli 经 CPA 且被 Confirmed | CPA 透传原生头+user_id，配对一致 | L1 header | 不变 |
| claude-cli 经 CPA 未被 Confirmed | CPA 盖 per-key 头，user_id 可能保留客户端原值 → 不一致 | L3 derived | 不串；丢 durable（审查指出的代价，接受：正确性优先） |
| OpenCode / Codex 等（x-session-id 等其他头） | 不带 x-claude-code-session-id | L1 其他头照常 | 不变 |
| OpenAI chat / responses 端点 | 该头不在候选 | 原逻辑 | 不变 |

### 2.5 边界与风险（v2 补全）

1. **残余漏洞（知情接受）**：若中间层同时伪造「JSON user_id（session=头值）+ per-key 头」——
   即新 CPA cloak 在 claude-api-key 条目上显式配置后的行为——交叉验证会通过，洞重开。
   缓解：a) 本部署不要在 CPA 该条目上配 cloak / fingerprint-profile（运维约束，写入部署说明）；
   b) 网关侧留了降权日志，若降权计数骤降为 0 而串扰复现即是此场景；c) 未来硬化方向：
   device_id 跨请求稳定性校验（真 CLI 同会话 device 恒定，cloak 每请求随机）——需要跨请求
   状态，本期不做，记录在此。
2. **压缩导致 seed 漂移**（审查发现）：byok 压缩后首条 user 变（2.json 已是 compact 形态），
   L3 seed 随之变化 → 同一对话在压缩点换 agent、durable 断开一轮。不串（正确性优先），
   接受；快照 `upstreamTurns` 可观测。
3. **stickyKey 仍读原始头**：`stickyKeyFor` 的 `explicitSessionId` 不降权 → 全部会话钉在同一把
   Cursor key。这不是正确性问题（只影响 key 选择），且对上游 prompt 缓存反而有利，接受不改。
4. **`x-claude-code-agent-id` 追加逻辑**：identity 命中后才追加（`durable-id.ts:59-60`）。降权后
   L3 命中时该头仍会追加——本链路 byok 不发它，无影响；真 CLI 走采信分支，不变。
5. **runner 与 server 一致性**：runner 不传 headers/body，identity = server 传来的（已降权）
   seed；server/runner 两处 `durableIdentity` 调用结果恒一致（降权幂等）。
6. **Responses 继承 seed** 优先级在 L3 之前，降权不影响；Responses 端点本就不经过 CPA 注入。

### 2.6 测试计划

`tests/durable-id.test.ts` 追加（纯函数）：
1. `claudeSessionHeaderTrusted`：
   - JSON 字符串 user_id + session 与头一致 → true；
   - JSON 字符串 + 不一致 → false；
   - **JSON 对象形态** user_id + 一致 → true（与 explicitFromMetadataUserId 口径对齐）；
   - **legacy 串且尾段与头一致 → false**（v1 漏洞回归用例）；
   - legacy 串随机 → false；无 metadata → false；user_id 畸形 → false。
2. `durableIdentity` 降权：
   - 伪装头 + legacy user_id → 身份与「无头无 metadata」相同（落 L3）；两条不同 body → 不同身份；
   - 同头 + 同首条 user（同会话续聊）→ 同身份（durable 保持）；
   - 真 claude-cli 形态（头 + JSON user_id 一致）→ 身份 = 头值（现状不变）；
   - 其他显式头（x-session-id）在降权场景仍照常命中。
3. `tests/server.test.ts` 追加（FakeRunner 集成，仿 strict-mode 用例）：
   - 带伪装头 + legacy user_id 的请求 → `identitySource=derived-L3`；
   - 真 claude-cli 形态 → `identitySource=header` 不变。
4. 全量 `npm test`（936 既有用例全绿为门槛）。

### 2.7 部署与验证

1. 服务器 `git pull && sudo docker compose up -d --build`；
2. 复测：两窗口同分钟问同一问题 → 日志出现 `[durable-identity] demoted=x-claude-code-session-id`，
   两请求 seed 不同（或同 seed 但 fresh_session 拦截）；`/health` 的 `identitySource`
   计数从 header 转移到 derived-L3，`fallback:fresh_session` 出现计数；
3. claude-cli 直连回归：`identitySource=header` 照常、durable reuse 照常；
4. 子代理 / 上下文膨胀症状：预期随串会话消失而缓解；子代理若仍不可用，单独排查 byok 工具声明
   （不在本计划范围）。

---

## 3. 不改的东西

- 不改 CPA（其行为对原生 claude-cli 是正确的；洞在「无会话头客户端 + 本网关 L1 无条件采信」的组合上）；
- 不改 byok（用户可删伪装头作临时缓解，但网关必须有自保能力）；
- 不动 75264b9 的三个护栏（它们在 derived-L3 上是对的，本计划把伪装链路导回其管辖范围）；
- 不加 DB 迁移、不加新配置项（协议形态判定，非运维开关）。

## 4. 被否决的替代方案

| 方案 | 否决原因 |
|---|---|
| 完全不认 `x-claude-code-session-id` 头 | 真 claude-cli 直连是主要合法客户端，丢 L1 全体退 L3，durable 精度损失最大化 |
| **legacy user_id 与头一致即采信（v1 方案）** | 新 CPA cloak（`injectFakeUserID` + `cache-user-id`）恰好生成 session 段 = 头值的 legacy/JSON user_id，采信即重开洞（Cursor 审查发现） |
| 按 UA 判伪装 | 伪装客户端伪造的恰恰是 UA；白名单是猫鼠游戏 |
| CPA 关 cloak / 换配置 | 用户已确认未开 cloak；且只修这一个部署，不修这一类链路 |
| byok patch 带真会话 id | 只救开源客户端；不开源客户端无法要求改造 |
| 头值出现频率统计（per-key 常量检测） | 跨请求状态、窗口难定、误伤慢速多轮会话 |
| device_id 跨请求稳定性校验（本期） | 能关死 §2.5.1 残余漏洞，但引入跨请求状态与失效逻辑，当前部署无此威胁；记录为未来硬化方向 |
