# 审阅发现修复计划

四路审阅（Bugbot 4 项、Security Review 1 项、需求核对 1–4 与 5–8）共产出 5 条代码缺陷与 7 条需求缺口。
本文档是修复的**唯一权威计划**：工作包划分、每个包的当前行为 / 目标行为 / 落点 / 验证方式，以及需要拍板的设计决策。
进度与实际改动记录在 `docs/review-fix-progress.md`。

## 执行约定

| 阶段 | 子代理 | 模型 | 产出 |
|---|---|---|---|
| 定位 | explore | `cursor-grok-4.6-xhigh-fast` | 精确行号、全部调用点、隐藏耦合、可行性结论 |
| 执行 | generalPurpose | `claude-opus-5-thinking-max-fast` | 代码改动 + 测试 |
| 审阅 | generalPurpose | `gpt-5.6-sol-max-fast` | 复核改动是否真正闭合发现 |

硬性要求：

1. **不许盲改**。每个工作包必须先有定位结论（文件 + 行号 + 调用点全集），再动代码。
2. `tests/server.test.ts` 是 4297 行的回归网，全套测试（当前 319 通过 / 1 跳过）必须保持全绿；
   审阅指出「有几处测试固化了错误语义」，这些用例要**改成正确语义**，不是删掉。
3. `npx tsc --noEmit -p tsconfig.json` 必须干净。
4. 每个包收工时更新 `docs/review-fix-progress.md`。

## 定位结论对本计划的修正（2026-08-29）

六路定位跑完后，本计划的三处假设被证伪，**以下修正优先于下文各工作包的原始描述**：

1. **WP2b 假设错误**：`MemoryStateStore.deleteCursorKey()` **确实**会剔除网关绑定（`store.ts:771-773`），
   与 SQLite 行为一致。两个 store 都会写成 `[]`，所以两边都有权限扩大问题，需要一起改。
   真正缺的是快照刷新（`DELETE /admin/api/keys/:id` 之后没人调 `gatewayKeyPool.refresh()`）。
2. **WP7a 方案错误**：`prepareOpenAiResponses` **不会**把 `previous.inputItems` 合进对话，
   而是把上一轮 Response 快照整个 `JSON.stringify` 成一段 `PREVIOUS_RESPONSE:` 塞进 prompt。
   因此「从 prepared 取种子，前缀天然稳定」不成立——续聊时 `INSTRUCTIONS:` 变了、
   多了 `PREVIOUS_RESPONSE:`、`INPUT:` 也变了，前缀根本不稳定。
   更糟的是网关提示词就在这个前缀里，按 prompt 前缀做哈希会让**所有会话撞成同一个身份**。
   **改为**：把会话种子作为一列持久化到 `responses` 表，续聊时沿用上一行的种子。
3. **WP8b 定性修正**：网关正文从来没落库（只进 flat prompt），所以不需要「剥掉上一轮注入的网关正文」。
   真正的重复来源是 `sanitizePreviousResponseForPrompt`（`protocol.ts:978`）**没有**剥掉快照里的
   `instructions` 字段，于是客户端上一轮的 instructions 被重新带进 prompt——
   这同时也违反 OpenAI Responses 官方语义（`instructions` 不跨轮继承）。

另外两条实现前必须知道的事实：

4. **`integerValue` 拒绝 `"0"`**（`config.ts:74` 要求 `> 0`），所以 `REQUEST_LOG_KEEP=0`
   用现有解析器表达不出来，必须新增一个接受 `>= 0` 的解析函数。
5. **undici 自定义 connector 可行**：`undici@7.29.0` 的 `Agent({ connect })` 是公开且有类型的 API，
   `socks@2.8.9` 已经在依赖树里（`socks-proxy-agent` 的传递依赖）。SOCKS4 可以真正覆盖 fetch 路径。

## 决策（已拍板）

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 空绑定列表表达「全禁」 | **哨兵 `NO_KEY_SENTINEL`，只在删除路径写入**；后台显式存 `[]` 仍是「不限制」 | 沿用 `NO_MODEL_SENTINEL` 既有先例，不动 schema。后台显式清空是运维明确意图，README 也这么写着，不改语义 |
| D2 | env 来源网关密钥能否删除 | **拒绝，返回 409**，提示改用停用或先从环境变量移除 | 停用已经有效（`auth.ts:33-36` 在 legacy 分支之前拦下 disabled）。为一个有替代方案的场景加 tombstone 表不划算 |
| D3 | 网关密钥改哈希存储 | **不改，写清理由** | 定位确认后台只回显掩码（创建时一次性明文），所以技术上可行；但 Cursor key **必须**明文（要发给上游），这个库本来就是密钥库。只哈希入站密钥要改 10 处调用点 + 迁移 + 补掩码列，而攻击者拿到库之后直接就有 Cursor key，收益与代价不成比例。审阅自己的优先级清单也没列它 |
| D4 | SOCKS4 覆盖方式 | **实现 undici 自定义 connector**，统一覆盖 socks4/5/5h | API 公开、依赖已在树里；直接拒绝 socks4 反而会砍掉「模型流量本来就能走」的既有能力（`buildNativeAgents` 对所有 SOCKS 都可用） |
| D5 | direct 模式是否受该 key 已登记的 modelScope 约束 | **受约束** | direct 路径已经为了 clientType 调过 `getByValue`，顺手读 `modelScope` 成本极低；运维给这把 key 配了范围就是想限制它。注意这不是提权修复（客户端手里已经有裸 Cursor key），纯粹是语义一致性 |
| D6 | session resume 下金额基线 | **落库**（新表 `agent_usage_baselines`） | `sdk_sessions` 与 SDK 默认的 `SqliteLocalAgentStore` 都跨重启存活，同一个 agentId 会在重启后继续服务请求，纯内存基线必然丢 |
| D7 | 铸钥返回值的前缀校验 | **允许 `crsr_` 与 `key_`，其余一律 502** | `docs/sand-rollout-guide.md:93` 是真账号实测记录，确认真实前缀是 `crsr_`；但后台 UI 占位符写的是 `key_...`。用白名单而不是死磕单一前缀，既能挡住「上游改了响应结构」，又不会因为占位符所述格式真的出现而把好 key 拒掉。顺手修正 UI 里那句误导的占位符 |

## 优先级与依赖

```
P0  WP0 密钥卫生 ────────────────────────────── 独立
P0  WP1 推理路径强制网关 modelScope ──┐
P2  WP5 别名归一化                   ├── WP1 与 WP5 共用「模型身份解析」，WP5 先出工具函数
P0  WP2 网关绑定语义 + 快照刷新 ────────────── 独立
P1  WP3 历史记录（5 个子项）────────────────── 独立
P1  WP4 代理 ─────────────────────────────── 独立
P2  WP6 铸钥 ─────────────────────────────── 独立
P2  WP7 会话粘性 ──┐
P2  WP8 系统提示词 ─┴── 都要动 protocol.ts 的 Responses 分支，串行做，避免互相踩
```

---

## WP0 · 密钥卫生（P0）

**发现**：`1.py` 里有明文 `WorkosCursorSessionToken`，并会打印新铸造的 API key。

- 当前：`1.py` 在工作区根目录，git 状态为 `?? 1.py`（未跟踪，从未提交）。
- 目标：文件从工作区删除；`.gitignore` 补上防误提交的规则；确认 git 历史里没有该 token。
- 落点：`1.py`（删除）、`.gitignore`。
- **需要用户动手的部分**：该 session token 权限高于普通 API key，必须由用户自己去 cursor.com 后台
  登出全部会话 / 轮换。代码侧删文件不等于凭据失效。用户在需求原文里贴的那个 token 同理。
- 验证：`git log -S` 搜 token 片段无命中；`git status` 里不再出现 `1.py`。

---

## WP1 · 推理路径强制网关 modelScope（P0）

**发现**：Bugbot High（`src/server.ts:404`）+ Security Medium（同一问题的安全视角）。

- 当前：`auth.modelScope` 只在 `filterListedModels()`（`server.ts:444`）里用于过滤 `/v1/models` 目录。
  八个推理端点（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`）
  都不校验请求的模型是否在网关密钥的可见范围内。`CursorRunRequest` 只带 `allowedKeyIds`，不带 `modelScope`，
  于是 `CursorKeyPool.selectKey()`（`key-pool.ts:158`）只按 **Cursor key 自己的** scope 过滤。
  结果：受限网关密钥可以直接请求被目录隐藏的模型，配额 / 成本策略被绕过，
  与文档承诺的 403 `model_not_allowed` 矛盾。`routing.ts:109` 的 `intersectScopes()` 写好了但生产代码从未调用。
- 目标：两层防御。
  - **L1 快速拒绝**：推理入口在 `prepare*` 之后立刻用「解析后的模型身份」比对 `auth.modelScope`，
    不通过就抛 403 `model_not_allowed`（param=`model`），与 `key-rotating-runner.ts:188` 的现有错误语义一致。
  - **L2 选 key 时求交集**：`CursorRunRequest` 增加 `gatewayModelScope`，`selectKey()` 用
    `intersectScopes(gatewayScope, key.modelScope)` 作为有效范围。这一层保证即使将来新增入口漏了 L1，
    也不会把请求发到超范围的 key 上。`NO_MODEL_SENTINEL` 的存在正是为这一层设计的。
- 待定位：
  - 全部会打到 runner 的入口（含 `count_tokens` 是否要一致拒绝）；
  - `direct` 模式下客户端自带的 key 若已在池中登记且带 scope，是否应当同样受限（需求核对第 1 项列为缺口）；
  - `NO_MODEL_SENTINEL` 走通 `modelAllowed()` 后 `selectKey` 会落到 `model-not-allowed` 还是 `exhausted`。
- 落点：`src/server.ts`、`src/types.ts`（`CursorRunRequest`）、`src/key-pool.ts`、`src/protocol.ts`（`toRunRequest`）。
- 验证：受限网关密钥请求被排除的模型 → 403 `model_not_allowed`；请求范围内模型 → 正常；
  不受限密钥行为逐字节不变。新增用例覆盖三个协议 + 直传模式。

---

## WP2 · 网关绑定语义与快照一致性（P0）

**发现**：Bugbot High（`src/store.ts:390`）+ 需求核对第 6 项（含一条「严重」）。

三个独立问题：

### 2a 绑定被清成 `[]` 导致权限扩大（严重）

- 当前：`SqliteStateStore.dropCursorKeyFromGatewayKeys()`（`store.ts:402`）在 Cursor key 被删时
  把该 id 从每个网关密钥的绑定列表里剔除。若剔完剩下空数组，而 `[]` 在
  `auth.ts:59`、`key-pool.ts:167`、`server.ts:447` 三处的语义都是**不限制**，
  于是「只能用 key A」的网关密钥在 A 被删后变成「全池可用」——权限反而扩大。
- 目标：空集合必须表达「什么都不许用」，落到 403 `not_authorized`。
  采用与 `NO_MODEL_SENTINEL` 同一套路：引入 `NO_KEY_SENTINEL`，剔除后为空时写入哨兵，
  让列表保持非空、且永不匹配任何真实 key id。
- 备选（不首选）：给 `gateway_keys` 加 `restricts_cursor_keys` 布尔列。语义更直白但要改 schema、
  迁移、三处判定与后台表单，代价明显大于哨兵。

### 2b `GatewayKeyPool` 内存快照不刷新

- 当前：`deleteCursorKey()` 直接改 `gateway_keys` 表，绕过 `GatewayKeyPool`。
  池的注释（`gateway-key-pool.ts:29`）已声明「绕过本池直接写库则需要调用方自行 refresh()」，
  但删 Cursor key 的调用点没有 refresh，`authenticate()` 在重启前一直看到已删除的 key id。
- 目标：删 Cursor key 成功后刷新网关密钥快照。
- 待定位：`deleteCursorKey` 的全部调用点；`MemoryStateStore.deleteCursorKey()`（`store.ts:764`）
  看起来只清 session binding、**不清**网关绑定，两个 store 的行为必须对齐，否则测试测不到真实语义。

### 2c env 播种的网关密钥删不掉

- 当前：删掉 DB 行后，`authenticate()` 的 legacy 分支（`auth.ts:38`）仍因 `token === config.gatewayApiKey` 放行；
  且重启时 `seedFromEnv()` 会重新播种。删除按钮实际无效。
- 目标：删除 env 来源的网关密钥时返回可操作的 409，明确告知「请先从环境变量移除 `GATEWAY_API_KEY`，
  或改用停用」（停用是有效的：`resolveAny` 会返回 disabled 记录并 401）。
  这比默默失败诚实，也不需要引入 tombstone 表。
- 备选：加 tombstone 表让删除持久生效。功能更"全"，但为一个可用停用替代的场景增加一张表与一层迁移，不划算。

### 2d 明文存储（决策项，非缺陷）

- 现状：网关密钥明文存 SQLite。审阅列为观察项而非评级发现。
- 需要拍板：Cursor key **必须**明文（要发给上游），所以这个 DB 本来就是密钥库；
  只把入站密钥换成哈希存储，实际收益有限，且会影响后台能否回显密钥。
  定位阶段要先确认后台 UI 是否展示完整密钥；若只展示掩码，则改哈希的代价可接受。
- 落点：`src/store.ts`、`src/gateway-key-pool.ts`、`src/admin.ts`、`src/auth.ts`。

---

## WP3 · 历史记录（P1）

**发现**：Bugbot Medium（`src/server.ts:353`）+ 需求核对第 5 项（5 个子项）。

### 3a 默认仍裁剪到 5 万条，且无配置入口

- 当前：`DEFAULT_REQUEST_LOG_KEEP = 50_000`（`store.ts:25`）；`requestLogKeep` 只是
  `SqliteStoreOptions` 的构造参数，`index.ts:45` 从不传，因此既不是「默认全部记录」，也没有配置入口。
- 目标：默认不裁剪（`0` = 无上限，`normalizeKeep` 已支持该语义），并新增 `REQUEST_LOG_KEEP` 环境变量
  让运维按需设上限；`index.ts` 把它传进 store；README / `.env.example` 补文档。

### 3b token 合计漏算 cache 读写

- 当前：`cursor-runner.ts:830` 在 `turn-ended` 缺 `totalTokens` 时按 `input + output` 推导，
  而 `protocol.ts:527` 明确写了 SDK 口径是四桶互斥、`totalTokens = input + output + cacheRead + cacheWrite`。
  两处口径不一致，历史里的合计偏小。
- 目标：推导公式补上两个 cache 桶，与 `protocol.ts` 的口径统一。

### 3c 估算用量不落库但标了 `estimated`

- 当前：`finishLog()`（`server.ts:376`）在 `telemetryRef.usage` 缺失时写 `usageSource: "estimated"`，
  但 usage 字段全为 null，后台显示「估算」而 token 列为空。
- 目标：真有估算值就落库（`protocol.ts:517` 的 `effectiveUsage()` 已能算），否则不要声称 estimated。
  待定位：估算所需的 prompt/completion 字符数只在响应构造处可得（`server.ts:665`、`848`、`957`），
  需要确认把估算结果回写 `telemetryRef` 的最干净接点。

### 3d direct 模式没有金额

- 当前：`scheduleCostBackfill()`（`server.ts:460`）要求 `log.keyUsageRef.keyId`，
  而 direct 模式不经过 key 池、没有 keyId，于是永远不补金额。
- 目标：direct 模式用 `auth.apiKey` 调 `getUsage()` 补金额。

### 3e 开启 session resume 后金额重复计入

- 当前：`agent.getUsage()` 返回的是**整个 agent 的累计值**。
  `CURSOR_SDK_DISABLE_SESSION_RESUME=false` 时同一 agent 会服务多个请求，第二次补写会把第一次的金额再算一遍。
- 目标：按 agentId 记住上次已归账的累计值，只写增量。
  待定位：`usage-reconciler.ts` 的调度与去重结构、agentId 在 resume 模式下的复用规律，
  以及「跨进程重启后累计基线丢失」要如何收敛（可能需要落库而非仅内存）。

### 3f fast / 1M / 推理强度记的是意图不是实际生效值

- 当前：`loggedRunRequest()`（`server.ts:418-421`）把 `run.*` 的**请求意图**写进日志，
  而真正下发的是 runner 解析后的 `telemetryRef.modelParams`。
- 目标：优先记录实际生效值，拿不到时退回意图并可区分。
  待定位：`cursor-runner.ts` 往 `telemetryRef.modelParams` 写什么、能否反解出 fast / maxMode / effort。

---

## WP4 · 代理（P1）

**发现**：需求核对第 7 项。

### 4a 模型流量默认不走代理

- 当前：`collectWarnings()`（`proxy.ts:324`）承认模型流量（`api2.cursor.sh`）走 connect-node 的 HTTP/2，
  而 `node:http2` 不支持代理；只有手动打开 `CURSOR_SDK_USE_HTTP1_FOR_AGENT` 才会落到 `https.globalAgent`。
  默认值是 `false`（`config.ts:19`），所以「配了代理即生效」不成立——在墙内基本必然超时。
- 目标：配置了代理时默认启用 HTTP/1.1（用户显式关闭时尊重其选择并保留告警）。
  待定位：`config.ts` / `sdk-network.ts` / `index.ts` 如何区分「用户显式设为 false」与「没设过」；
  后台保存代理时（`admin.ts:270`）要同步打开开关并在响应里说明。

### 4b SOCKS4 覆盖不全

- 当前：`buildDispatcher()`（`proxy.ts:293`）对 socks4 返回 undefined，全局 fetch 退回直连，只靠告警提示。
- 目标（按可行性择一）：
  - 优先：给 undici 装自定义 connector，用 `socks` 包（`socks-proxy-agent` 的既有依赖）统一覆盖
    socks4 / socks5 / socks5h，让 fetch 路径对所有协议都真的走代理。
  - 退路：保存时直接拒绝 socks4 并说明原因，而不是半通半不通。
  - 定位阶段必须给出 undici 自定义 connector 的可行性结论（API 形状 + 依赖是否已在 lockfile 里）。

### 4c 代理测试只探 api.cursor.com

- 当前：`DEFAULT_PROBE_URL = "https://api.cursor.com/v1/me"`（`proxy.ts:70`），
  走的是 undici dispatcher（fetch 路径）。测试通过不代表模型流量可用。
- 目标：探测拆成两条并分别报告——REST 通道（fetch / undici）与模型通道
  （node:http(s) + 代理 agent，即 HTTP/1.1 下模型流量真正走的那条路）。
  待定位：模型流量的真实 host（需从 SDK 打包产物确认，注释里写的是 `api2.cursor.sh`）。

---

## WP5 · 模型别名归一化（P2）

**发现**：Bugbot Medium（`src/key-pool.ts:171`）+ 需求核对第 1 项。

### 5a 别名可绕过黑白名单

- 当前：`selectKey()` 把原始模型字符串交给 `modelAllowed()`（`routing.ts:98`），只做 trim + 小写比较；
  而目录过滤 `filterModelsByScope()`（`routing.ts:132`）会识别 `aliases`。
  于是用别名请求可绕过黑名单，反过来白名单只写了 id 时用别名请求会被误拒。
- 目标：先把请求的模型解析成「模型身份」（canonical id + 全部 alias 的集合），再做匹配：
  身份里任意一项命中黑名单即拒；白名单非空时身份里任意一项命中即放行。两侧对称。
- 待定位：`getModelCatalogEntry()`（`models.ts:146`）是异步且需要 apiKey，
  而 `selectKey()` 在选 key **之前**就要判断——需要确定解析发生在哪一层
  （倾向 server.ts 解析一次后通过 `PickOptions` / `CursorRunRequest` 传下去），
  以及目录不可用（fallback）时的降级行为（不能因为拉不到目录就放宽限制）。
- 同时修正 `filterModelsByScope()` 里「黑名单只看 id、白名单看 id+alias」的不对称。

### 5b 模型目录并非真正全局统一

- 当前：目录按 `(apiKey, 通道)` 分桶缓存（`models.ts:43`），后台的模型选择器拿到的是某一把 key 的目录，
  与需求「从全局列表加载」不符。
- 目标：后台 `GET /admin/api/models` 返回全池 active key 目录的并集（去重），作为真正的全局清单。

---

## WP6 · 铸钥（P2）

**发现**：需求核对第 3 项。

- 当前：`defaultApiKeyName()`（`cursor-account.ts:63`）用秒级 UTC 时间戳，同一秒内铸两把会重名，
  违反需求原文明确要求的「随机」；`readApiKey()`（`cursor-account.ts:188`）不校验 `crsr_` 前缀。
- 目标：默认名带真随机后缀（须满足 `NAME_PATTERN` 与 `MAX_NAME_LENGTH`）；
  返回值校验 `crsr_` 前缀，不符合就报 502「接口可能已变更」而不是把疑似非 key 的字符串入池。
- 落点：`src/cursor-account.ts`、`tests/cursor-account.test.ts`（现有断言可能固化了时间戳格式）。

---

## WP7 · 会话粘性（P2）

**发现**：需求核对第 2 项。

### 7a `previous_response_id` 续聊时粘性失效

- 当前：`stickyKeyFor()`（`server.ts:434`）用 `conversationSeed(request.body)` 算身份，
  而 Responses 续聊的 body 里只有新一轮输入，system + 第一条 user 都不在，哈希每轮都变，粘性完全失效。
- 目标：身份从**合并后**的会话推导。`prepareOpenAiResponses()` 已经把 previous 的 inputItems 合并进来，
  改成从 `prepared` 而不是原始 body 取种子，前缀天然稳定。
- 待定位：`prepared` 的确切形状（`prompt` 是拼好的文本还是结构化 items）、
  `conversationSeed` 需不需要为此加一个「从 prepared 取」的入口，以及 chat/messages 两个协议是否受影响。

### 7b 哈希只取前 200 字，独立会话可能碰撞

- 当前：`SEED_SEGMENT_LENGTH = 200`（`routing.ts:18`）。共享同一段长 system prompt 的不同会话会算出同一身份。
- 目标：大幅提高截断长度（前缀语义不变，仍然逐轮稳定，但碰撞概率显著下降）。
  注意不能改成「全量」——那会让身份随对话增长而变化，正是当初取前缀的原因。

---

## WP8 · 系统提示词（P2）

**发现**：需求核对第 8 项。

### 8a Responses `input[]` 里的 system/developer 绕过 override

- 当前：三协议顶层的 append/override 已正确（`system-prompt.ts:37`），
  但 Responses 的 `input[]` 数组里如果带 role=system/developer 的条目，它们被当普通内容处理，
  override 模式下没被丢掉，网关正文与客户端 system 会同时进 prompt。
- 目标：把 `input[]` 里的 system/developer 条目一并纳入 `resolveSystemText()` 的输入。

### 8b `previous_response_id` 会把旧 instructions 重新带进 prompt

- 当前：续聊时合并进来的历史里已含上一轮注入过的网关正文，本轮再注入一次。
- 目标：续聊时不重复注入（或识别并剥掉上一轮注入的那段）。
- 待定位：`protocol.ts` 的 `prepareOpenAiResponses()` 合并逻辑、注入发生的确切位置，
  以及 8a / 8b 两个改动会不会互相影响（都在同一个函数里，必须一起设计）。

---

## 收尾

1. 全套测试 + typecheck 全绿；固化错误语义的用例改成正确语义。
2. README / `.env.example` 同步新增的配置项（`REQUEST_LOG_KEEP`、代理默认行为变化等）。
3. `gpt-5.6-sol-max-fast` 复核：逐条对照本文档确认发现真的闭合，而不是被绕过。
4. 向用户明确交代**代码之外**必须由用户执行的动作：撤销 / 轮换 `1.py` 与需求原文里那个 session token。
