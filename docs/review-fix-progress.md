# 审阅发现修复 · 进度记录

计划见 `docs/review-fix-plan.md`。本文档只记事实：每个工作包的状态、实际改动、验证结果、以及过程中发现的新问题。

**图例**：`未开始` / `定位中` / `执行中` / `待审阅` / `已完成` / `已搁置（附原因）`

---

## 总览

| 包 | 主题 | 优先级 | 状态 | 定位 | 执行 | 审阅 |
|---|---|---|---|---|---|---|
| WP0 | 密钥卫生（`1.py`） | P0 | 待审阅 | — | 完成 | — |
| WP1 | 推理路径强制网关 modelScope | P0 | 待审阅 | 完成 | 完成 | — |
| WP2 | 网关绑定语义 + 快照一致性 | P0 | 待审阅 | 完成 | 完成 | — |
| WP3 | 历史记录（6 子项） | P1 | 待审阅 | 完成 | 完成 | — |
| WP4 | 代理（3 子项） | P1 | 待审阅 | 完成 | 完成 | — |
| WP5a | 模型别名归一化 | P2 | 待审阅 | 完成 | 完成 | — |
| WP5b | 后台模型清单取全池并集 | P2 | 待审阅 | 完成 | 完成 | — |
| WP6 | 铸钥 | P2 | 待审阅 | 完成 | 完成 | — |
| WP7 | 会话粘性 | P2 | 待审阅 | 完成 | 完成 | — |
| WP8 | 系统提示词 | P2 | 待审阅 | 完成 | 完成 | — |

### 第 1 轮执行后的回归门（已验证）

`npx tsc --noEmit` 干净；`npm test` = **340 用例 / 339 通过 / 1 跳过 / 0 失败**（基线 319 通过，净增 21 个用例）。

### WP3 执行后的回归门（已验证）

`npx tsc --noEmit -p tsconfig.json` 干净；`npm test` = **370 用例 / 369 通过 / 1 跳过 / 0 失败**（WP3 开工前 357 通过，净增 12 个用例）。

## 基线

修复开始前的状态，用于对照回归：

- 分支：`main`
- 测试：319 通过 / 1 跳过 / 0 失败
- typecheck：干净
- 未跟踪文件：`1.py`（待删）、6 个新增 `src/*.ts`、7 个新增 `tests/*.ts`

---

## 决策

全部已拍板，结论与理由见 `docs/review-fix-plan.md` 的「决策」表（D1–D7）。
一句话版：绑定用哨兵、env 密钥拒删、不改哈希存储、SOCKS4 上自定义 connector、
direct 模式受 scope 约束、金额基线落库、铸钥前缀走白名单。

---

## 定位阶段（已完成）

六路并行定位，全部只读、无改动。产出已回写进计划文档的「定位结论对本计划的修正」。

| 覆盖范围 | 关键产出 |
|---|---|
| WP1 + WP5 模型范围与别名 | 三个推理入口 + `count_tokens` 全部不校验网关 scope；`normalizeModel` 只折叠 composer 别名；`NO_MODEL_SENTINEL` 走通后确实落到 403 `model_not_allowed`；模型身份只能在 handler 层解析（`selectKey` 拿不到 apiKey） |
| WP2 网关绑定 | 两个 store 都把绑定清成 `[]`；`createTestApp` 从不注入 `gatewayKeyPool`，所以 HTTP 层根本观测不到 2a/2b/2c；哨兵会被后台绑定表单的「不勾选=不限制」在保存时抹掉，必须一起改 |
| WP3 历史与用量 | `integerValue` 拒绝 `"0"`；`finishLog` 同步快照 usage，非流式必须在 `runLogged` 里补估算；`telemetryRef.cost` 生产环境从来没被写过；resume 模式下 agentId 跨重启存活 |
| WP4 代理 | HTTP/1.1 的持久化设置能区分「显式 false」与「从未配置」，但 loader 把两者压平了；env 也压平，需读原始 `process.env`；模型流量真实 host 是 `api2.cursor.sh`（已从 SDK 产物核实）；undici connector 可行 |
| WP7 + WP8 Responses | 续聊不合并 `inputItems`，而是 dump 上一轮快照；按 prompt 前缀做种子会让所有会话撞车；`sanitizePreviousResponseForPrompt` 没剥 `instructions` |
| WP6 + 测试审计 | 真实前缀 `crsr_` 有真账号实测佐证，但 UI 占位符写的是 `key_`；跳过的那个用例是 SDK bundle 补丁测试（`node_modules` 缺失时跳过）；固化错误语义的用例共 4 个 |

### 固化了错误语义、必须改成正确语义的测试

| 文件 | 用例 | 行 | 错在哪 |
|---|---|---|---|
| `tests/store.test.ts` | `gateway keys round-trip and lose allowances when a cursor key is deleted` | 137 | 断言删完剩 `[]`，注释却说「只会让请求选不到 key」——`[]` 恰恰是「不限制」，注释与断言互相矛盾 |
| `tests/store.test.ts` | `memory store matches the sqlite store behaviour` | 250 | 同上 |
| `tests/usage-capture.test.ts` | `parseSdkUsage derives totalTokens for a turn-ended payload` | 19 | 断言 `165 = input+output`，漏掉 cache 900+30；`protocol.ts:524-527` 写明四桶口径应为 1095 |
| `tests/usage-capture.test.ts` | `parseSdkUsage accepts an already unwrapped token-code object` | 52 | 断言 total 为 3，四桶口径应为 10 |

另有两个用例会随 WP6 的随机默认名失效，需同步改：`tests/cursor-account.test.ts:56`（写死 `gateway-20260827-154409`）与 `:91`（正则 `/^gateway-\d{8}-\d{6}$/`）。

---

## 逐包记录

### WP0 · 密钥卫生

状态：待审阅

- 删除 `1.py`。
- `git log --all -S` 搜 token 片段与 cookie 名，**历史里零命中**——该文件从未提交过，只存在于工作区。
- `.gitignore` 增加根目录 `/*.py` `/*.sh` `/*.ps1` 规则（`!scripts/` 保留正常脚本目录）：
  这类文件历来是从 DevTools 复制 curl 粘出来的，天然带凭据，挡在提交之前最省事。
- **仍需用户动手**：删文件不等于凭据失效，见文末待办。

### WP1 · 推理路径强制网关 modelScope

状态：待审阅（第 2 轮已闭合审阅指出的 fail-open）

- 新增「模型身份」概念（`ModelIdentity` = 请求串 + 网关静态别名组 + 目录 canonical id + 全部 alias 的并集），
  在 handler 层解析一次，L1 与 L2 共用。身份另带 `confirmed`，如实记下「上游目录到底有没有确认过这组叫法」。
- L1：四个入口（三协议 + `count_tokens`）在 `prepare*` 之后、`beginLog` 之前校验，
  失败抛 403 `model_not_allowed`（param=`model`），请求不进 runner / key 池 / 请求日志。
- L2：`CursorRunRequest` 增加 `gatewayModelScope` 与 `modelIdentity`；`selectKey` 按
  `intersectScopes(网关范围, key 范围)` 过滤，白名单不相交时落到 `NO_MODEL_SENTINEL` → 403。
- D5：direct 模式若客户端的 key 已在池中登记且带 scope，同样强制（该路径本来就为 clientType 调过 `getByValue`）。
- `createTestApp` 现在支持注入 `gatewayKeyPool` 与 `modelLister`，HTTP 层终于能测受限网关密钥
  与目录降级（WP2 依赖前者）。

#### 第 1 轮记录里这两条说法是错的

1. ~~「目录不可用时降级为『只按规范化后的请求串匹配』，只会更严不会更松」~~ —— **只对白名单成立**。
   白名单要求身份里有一项被点名，少认几个叫法确实更严；
   但**黑名单同样要求身份里有一项被点名，少认几个叫法就是漏判**。
   于是「黑名单写 canonical id + 请求写别名 + 目录冷/挂/没这条」是一条可以主动触发的绕过：
   身份塌成 `["fable"]`，`excluded: ["claude-fable-5"]` 匹配不上，请求照常放行。
   L1 与 L2 消费的是**同一份**残缺身份，所以两层会一起失效——那句「两道防线」在这个场景下
   只是同一层写了两遍。两路审阅独立发现了同一条，按真问题处理。
2. ~~「每个请求多一次 key 池读」~~ —— `catalogueSource()` 走的是 `pickActive()` → `selectKey()`，
   会**推进 `rotationCursor`**，是一次带副作用的选 key，不是只读。
   两把等权 key 跑 round-robin 时，「借来读目录的那把」与「真正执行的那把」会稳定错开：
   加权配比被拉偏是小事，判定依据与执行依据分属两把 key 的目录才是要命的，它直接喂给了上面那条绕过。

#### 第 2 轮改动

- **静态别名组下沉进 `modelIdentity()`**：`STATIC_MODEL_ALIASES` 与 `staticModelAliases()`
  从 `models.ts` 移到 `routing.ts`（`models.ts` 本来就 import routing，反向 import 会成环），
  并改成**双向**查表（给 id 拿别名、给别名拿回 id）。这张表不需要任何网络，
  没有理由跟着目录一起失效；下沉之后身份解析也不再依赖调用方记得传第三个参数——
  原先 `key-pool` 与 `key-rotating-runner` 的兜底 `modelIdentity(model)` 正是漏了这一层。
- **黑名单算不准时 fail closed**：`routing.ts` 新增 `denyRuleUnverifiable(identity, scope)`
  =「身份没被目录确认 且 该范围有非空黑名单」，判定方必须拒绝而不是当作「没命中」。
  - L1（`enforceGatewayModelScope`）命中抛 403 `model_identity_unverified`（param=`model`），
    与真命中规则的 `model_not_allowed` **分开报**：运维要区分的正是「该改可见范围」与「上游目录挂了」。
    顺序上先判 `identityAllowed`——能明确说出「这个模型被排除了」时就照实说，别退而报「算不准」。
  - L2（`selectKey`）同样兜一次，新增 `NoKeyReason: "model-unverified"` → 同一个 403 码。
    第 2 轮只兜网关侧黑名单的判断已被第 3 轮推翻：Cursor key 的 `modelScope`
    是运维对该凭据施加的**硬安全限制**，不是可在目录抖动时忽略的路由偏好；
    未确认身份时，带黑名单的 key 会被排除，不能让动态别名绕过它。
  - 只配白名单的范围不受影响，它本来就只往更严的方向降级。
  - **可用性代价**：目录持续不可用时，配了黑名单的网关密钥会整体 403。
    这是拿一段可观测、可自愈的不可用，换掉一条任何人都能主动复现的绕过，方向上划算；
    目录按 (key, 通道) 缓存 10 分钟、失败另有 60s 负缓存，抖动基本被吃掉。
    用 403 而不是 503：这是一次策略拒绝（网关无法证明请求合规），
    报 5xx 会让客户端对着已经在挣扎的上游狂重试。
- **模型身份改为与 key 无关**：`resolveModelIdentity` 不再借一把 key，改取**全池 active key 目录的并集**
  （`models.ts` 新增 `findModelAcrossCatalogues()`，形状沿用 WP5b 的 `globalModelCatalogue`）。
  授权与执行从此看同一组叫法，判定结果也不再随取用策略与轮询游标漂移。
  取全池而不是只取本网关密钥绑定的那几把：叫法认得越全，黑名单只会越准。
  但「执行时选中的 key 是并集的子集，所以判定不可能比执行方自己看到的更松」
  **只对黑名单方向成立**；对允许名单，全集可能带入另一把 key 才贡献的 alias，
  反而会比实际执行 key 的名字集合更宽，不能把这个子集关系写成双向安全不变量。
  成本：每请求 N 次目录查询（N = active key 数），缓存命中时只是 N 次内存查表；
  key 池读的次数没变（原先 `pickActive` 也要 `listCursorKeys()`）。
- **`pickActive` 不再推进游标**：`CursorKeyPool` 内部拆出 `select(..., advanceCursor)`，
  `selectKey` 推进、`pickActive` 不推进。`pickActive` 全仓只有「借 key 读目录」一个调用点，
  读目录是旁路动作，没有任何理由改变下一次真正执行时选中哪把 key。
- **目录解析有了自己的 deadline**：身份解析发生在 runner 的超时/中断机制建立**之前**，
  而目录调用自己没有请求级 deadline，冷缓存下的一次挂死能把整个请求
  （包括压根不碰 runner 的 `count_tokens`）拖过配置的推理超时。
  现在竞速 `min(requestTimeoutMs, 5s)`，超时按「没查到」处理——于是超时在黑名单侧同样是「算不准」
  而不是「没命中」，与 fail-closed 的判定口径一致。
  是竞速而不是真取消：SDK 的 `models.list` 不收 `AbortSignal`，与 `runWithTimeout` 对 run 的处理同一套路。
- **direct 模式的目录查询加了闸**：未在池中登记的直传 token **一律不查目录**。
  这条路上身份没人用（direct 不选 key，也没有网关范围），而拿调用方随手给的 token 去查，
  等于让任何人都能撬动一次上游调用，还会把按 key 分桶的目录缓存冲成一次性的。
- **`count_tokens` 补上 D5 的那一半**：另外三个入口的「已登记 direct key 可见范围」是 runner 兜住的，
  这个入口不进 runner，原先只看 `auth.modelScope`（direct 模式下恒为 undefined），
  于是一把配了范围的直传 key 可以在这里估算范围外模型的 token。
  现在入口自己查一次 `getByValue` 并强制该范围；这份范围是运维对该凭据施加的硬限制，
  目录未确认完整且范围含黑名单时也 fail-closed，避免 `count_tokens` 成为 direct 绕过口。
  两种范围都不可能存在时（网关密钥不限制、又不是直传）连目录都不解析，热路径不受影响。
- `selectKey()` 在无 active key 时不解析模型身份，直接保留 `none-configured` /
  `all-disabled` 的 429；`model-unverified` 只在仍有可授权 active key、但其相关目录
  无法完整确认时出现。HTTP 的 L1 网关范围检查发生在 runner 之前，若网关本身配置了
  黑名单且池为空，仍可能先报 `model_identity_unverified`；这不改变请求无法执行的事实，
  但属于诊断顺序差异，未让 count_tokens 通过未验证的黑名单。

#### 第 2 轮的用例（净增 14 + 加强 1）

审阅点名 `tests/routing.test.ts` 那条「never loosens」是**弱用例**：它用的是与黑名单逐字相同的请求名，
从没走过「身份没解析全」这条路，所以**带着 fail-open 也照样通过**。已改成显式断言两个方向的失效差异。

| 用例 | 覆盖 | 改动前为什么必然失败 |
|---|---|---|
| `static aliases fold without any catalogue…` | 静态别名下界 | 改动前 `modelIdentity("composer-latest").names` 只有请求串，黑名单写 `composer-2.5` 匹配不上 |
| `an unresolved identity leaves a deny rule unevaluated…` | fail-closed 信号 | `denyRuleUnverifiable` 此前不存在，且 `identityAllowed` 对这组入参返回「放行」 |
| `identityAllowed never loosens…`（加强） | 弱用例补强 | 新增的 `denyRuleUnverifiable` 断言 |
| `selection refuses rather than guesses…` | L2 fail-closed | 改动前 `selectKey` 会正常选出 key |
| `a gateway deny list stays enforced when the catalogue cannot confirm the model` | HTTP 层三种目录降级（挂了 / 没这条 / 陈旧到还没那个别名） | 三种形态改动前一律 200 |
| `a streaming request is refused the same way when the catalogue is down` | 流式下同一条 | 同上 |
| `borrowing a key to read the catalogue does not distort round-robin` | 游标副作用 | 改动前 `pickActive` 推进游标，第二次借用就漂到另一把 |
| `model identity does not depend on which key the router happens to pick` | 判定/执行用不同 key 的目录 | 改动前判定读 a 的目录（不认识该别名）→ 放行，执行落在 b 上 |
| `reading the catalogue no longer steals a slot from round-robin` | 同上的可观测面 | 改动前执行序列是 `[b, a]` 而不是 `[a, b]` |
| `intersectScopes keeps two spellings of the same model…` | 别名等价白名单求交 | 改动前按字符串求交落空成 `NO_MODEL_SENTINEL` |
| `a gateway whitelist and a key whitelist naming the same model differently…` | 同上（选 key 层） | 改动前落到 `model-not-allowed` |
| `a gateway allow list and a key allow list may spell the same model differently` | 同上（HTTP 层） | 改动前 403 |
| `count_tokens honours the scope registered for a direct Cursor key` | D5 缺口 | 改动前该入口只看 `auth.modelScope`，direct 恒为 undefined → 200 |

上表 12 条 + 加强的那条已用「只回退对应那一处实现、其余保持不变」的方式逐组跑过，确认改动前必然失败。
另有两条是**回归护栏**，改动前也通过，加进来是为了钉住行为而不是暴露缺陷：
`the streaming variants of every entry point are refused before any SSE is opened`
（L1 此前完全没有流式用例，且要断言拒绝走信封而不是流内 error 事件）与
`an allow-list-only gateway key keeps working while the catalogue is down`
（钉住 fail-closed **没有**扩散到白名单侧）。

- 回归：typecheck 干净；`npm test` = **384 用例 / 383 通过 / 1 跳过 / 0 失败**（本轮开工前 370 / 369 / 1）。

### WP2 · 网关绑定语义 + 快照一致性

状态：待审阅

- 2a：`routing.ts` 新增 `NO_KEY_SENTINEL`（与 `NO_MODEL_SENTINEL` 同值同套路）。
  两个 store 的删除路径共用一个 `dropBoundKey()`：剔完为空写哨兵，否则原样写剩下的 id。
  只有删除路径写它——后台显式清空仍是「不限制」，这是 D1 拍板的语义，README 也照此写。
- 哨兵会被沿途抹掉的三个点全部堵上：
  `resolveAllowedCursorKeyIds` 放行哨兵（勾了真实 key 就以真实绑定为准，哨兵作废，其余未知 id 照旧 400）；
  `bindSummary` 改成「已失效：绑定的 Cursor key 已删除」而不是把 NUL 塞进 title；
  绑定表单在失效状态下换掉「不勾选表示不限制」的文案、空表单保存时回填哨兵，
  要放开必须显式勾一个「解除限制」开关。
- 2b：`DELETE /admin/api/keys/:id` 成功后 `await deps.gatewayKeyPool?.refresh()`。
  用可选链而不是 `requireGatewayKeyPool`——池是可选依赖，没接多密钥模式时删 key 不能变成 503。
- 2c：`DELETE /admin/api/gateway-keys/:id` 对 `source === "env"` 返回 409 `gateway_key_env_managed`，
  `seedFromEnv` 会把移除或轮换后的旧 env 行停用并保留审计记录；409 只给出两条有效出路：
  立即停用，或移除环境变量后重启（启动时会停用保留行）。后台列表加「来源」列，
  env 行的删除按钮 disabled 并在 title 里写清原因。停用照旧有效：auth 在 legacy 分支之前就拦 disabled。
- 2d：按 D3 不改哈希存储，README「鉴权」节的说明仍需补全环境变量 / 进程配置暴露面，
  以及 SQLite `-wal`、`-shm` sidecar 也可能包含密钥内容；本轮不改 README。
- 测试：`tests/store.test.ts` 两处固化错误语义的断言改成哨兵语义（并补了「还剩别的绑定时只剔一把」）；
  `tests/gateway-keys.test.ts` 改写配置漂移用例，并新增重启移除 env、轮换新旧 token、
  删除同值 manual 记录、以及池为空时死绑定的覆盖；HTTP 用例验证 409 / 401 / 403 与快照一致性。
  哨兵优先于 `none-configured` / `all-disabled`，所以删掉唯一 Cursor key 后仍返回 403 `not_authorized`；
  未绑定密钥的整池可用与后台显式清空「不限制」语义仍保留。

#### 第 3 轮安全修复

- High 1：`requireAdmin()` 在配置口令恰好回退为 `GATEWAY_API_KEY` 时，也查询
  `gatewayKeyPool.resolveAny()`；对应 env 密钥一旦被停用，管理 API（包括 enable 自救路径）
  与 `/v1` 一样返回 401。若显式 `ADMIN_PASSWORD` 使用了不同的口令，它不受网关记录状态影响；
  若两者故意使用同一字符串则无法在认证层区分，停用记录会按安全口径拒绝该字符串；
  未接密钥池的 legacy 单密钥模式没有可查询的停用记录，行为仍由配置口令本身控制。
  停用密钥仍可访问公开健康检查和 `/admin` 页面等不需要鉴权的端点，但不能访问管理 API、
  推理 API 或 `/v1/models`；未知 token 的兼容性 fallback 仍然存在，但已知停用 token 不会
  被当成未知值，也不会被交给上游，更不能经 direct / legacy 分支把自身当作 Cursor key 使用。
  `src/config.ts` 不需要再改：
  admin 口令的回退关系保持不变，修复点是认证时同时尊重池内停用状态。
- Medium 4：`selectKey()` 的原因优先级固定为「绑定授权（`not-authorized`，包括哨兵和
  绑定目标全部停用）→ 无配置（`none-configured`）→ 整池停用（`all-disabled`）
  → 模型范围（明确拒绝 `model-not-allowed`，无法验证黑名单 `model-unverified`）
  → 已尝试完（`exhausted`）」。因此绑定只指向已停用 Cursor key 时返回 403，
  未绑定的整池停用仍是 429；`model-unverified` 不会把授权失败或根本无 key 的状态改写。
- Medium 5：停用是 Cursor key 的全局撤销语义，direct 模式先查池记录并在 status 为
  `disabled` 时返回 401；这与 High 3 对 `modelScope` 的硬限制决定保持一致。
- 测试：`tests/gateway-keys.test.ts` 新增 env 停用 key 在 `/v1/models` 与 admin API
  自启路径上的 401，以及绑定的 Cursor key 全部停用时的 403（改动前分别能继续发现、
  能自启、返回 429）；`tests/server.test.ts` 也钉住已登记停用 direct key 的发现路径 401。

### WP3 · 历史记录

状态：待审阅

- 3a：`DEFAULT_REQUEST_LOG_KEEP` 50000 → **0（不裁剪）**，新增 `REQUEST_LOG_KEEP` 环境变量，
  由 `index.ts` 传进 `SqliteStateStore`（此前 `requestLogKeep` 只是个没人传的构造参数）。
  `config.ts` 另起一个 `nonNegativeIntegerValue`（`>= 0`）而不是放宽 `integerValue`——
  后者 `> 0` 的契约被超时、阈值、端口等一票设置依赖，而这里 `0` 恰恰是唯一能表达「无上限」的值。
  端到端确认过 `normalizeKeep(0)` 一路走到 `trimRequestLogs` 直接短路，不是「上限极大」而是真的不删。
  README 与 `.env.example` 都写明了默认全量留存意味着状态库无界增长，并给了设上限 / 定期清空两条出路。
- 3b：`parseSdkUsage` 的兜底合计改成四桶之和（`protocol.ts` 的口径是权威）。
  新增 `normalizeRequestUsage()` 作为边界归一化：`mergeUsage` 与 `effectiveUsage(real)` 也会修复
  外部传入的矛盾 `totalTokens`，不会把「上游已解析」当成可盲信的前置条件。
  下游（后台 token 列、`openAiUsage` / `responsesUsage` / `anthropicUsage`）一律按桶重算；
  两个固化错误公式的用例按要求改成 1095 与 10（没删）。
- 3c：`RunTelemetryRef` 加 `estimatedUsage`，与 `usage`（上游实测）分开存，
  这样响应体仍按「有没有实测值」决定要不要输出缓存/推理明细，不会被估算值带偏。
  `finishLog` 改走 `loggedUsage()`：有实测记 `sdk`，只有估算记 `estimated` **并带上数字**，
  两样都没有就一个用量字段都不写、也不声称 estimated。写回点：
  非流式在 `runLogged` 里 `runWithTimeout` 返回之后、`finishLog` 之前（`finishLog` 同步拍快照，
  而响应体要等 `runLogged` 返回才构造，这是唯一能拿到产出字符数的时机）；
  流式在三条流各自的收尾处（`chatStream` 收完最后一块之后、`responsesStream` 算完 `outputChars`、
  `anthropicStream` 合完 `completionChars`），刻意放在 `include_usage` 分支之外——
  客户端要不要看用量，与请求历史要不要有数字是两回事。
- 3d：`RequestLog` 记下 direct 模式客户端自带的那把 key，`scheduleCostBackfill` 在没有 `keyId` 时用它排队。
  原先这条路径直接 `return`，直传请求永远没有金额。
- 3e：新增 `agent_usage_baselines` 表（`agent_id` 主键 + `raw_cost_cents` / `charged_cents` / `updated_at`，
  沿用邻居的 `CREATE TABLE IF NOT EXISTS` 写法），`StateStore` 加 `bookAgentUsageDelta()`，两个 store 都实现。
  **并发**：SQLite 侧整个读-改-写包在 `BEGIN IMMEDIATE`/`COMMIT` 里（写锁在事务开头就拿到，
  两条补写不可能读到同一个基线）；内存 store 全同步、天然原子。同一 agent 撞车时先到的拿走全部增量、
  后到的拿到 0，合计仍然正确——累计口径本来就摊不回具体哪一次 run，这点写进了 README 的能力边界。
  **失败回滚**：内存 store 在 request log 的 cost 属性写入失败时恢复原基线，和 SQLite 事务回滚保持同一语义；
  否则下一次重试会读到已经推进过的高水位，把金额静默吞掉。
  **重试**：累计接口没有「本次 run 已纳入」的完成信号；即使返回了 cost，若相对基线没有新增仍可能只是旧副本。
  因此 tracked 模式在没有新增时按有界次数继续轮询，stateless 模式拿到 cost 即结束，避免把不同语义混在一起。
  每次新增金额的基线推进与 request log 写入共用一个事务，重复累计值不会重复记账；但在轮询上界后仍未纳入本次
  run 的上游读数、进程被强杀或上游不可达，网关无法保证单行金额已经完整。
  **累计值倒退**：累计接口没有可靠的 reset / id 复用信号，任何低于高水位的读数（包括严格递增的
  `1 → 2`）都只记 0 且不降低基线；因此 `1 → 2 → 100` 不可能把已记过的 100 再拆成 2 + 98，
  代价是实际 reset 后可能暂时少记，优先避免重复收费。若上游只返回一个不再增长的低值，
  无法仅凭累计接口判断它是旧副本还是 reset，这个边界不能靠高水位算法消除。
  **重启与清理**：基线不再按时间自动删除，也不尝试从「安静」推断 agent 已死亡；
  `sdk_sessions` 与 SDK 自带的 agent store 都可能跨重启继续使用同一个 agent。这样 liveness 不会误判，
  代价是 `agent_usage_baselines` 无界增长，运维需自行清理状态库或接受这项开销。
  **零金额与关停**：tracked 模式在有 cost 但始终没有新增时，轮询上界写入明确的
  `{ rawCostCents: 0, chargedCents: 0 }`，不再和「从未查到」混淆。每次 `getUsage` 最多等 10s，
  `drain()` 最多等 30s；超时会记录待处理任务数、清掉尚未开始的任务并继续关停，无法取消的在途调用
  由其自身超时/进程退出收尾。HTTP 入口先关闭，等在途请求完成排队后才关闭 reconciler。
  **启动恢复**：本轮不扫描 cost-less 日志。现有请求日志没有持久化 agentId 与直传 Cursor key，
  仅凭 logId / keyId 无法安全重建 `getUsage` 参数；强行猜测会把金额记到错误 agent 或 key。
  因而 SIGKILL、OOM、断电发生在内存队列落库前仍可能丢补写，这是明确的已知边界。
  `index.ts` 在 `CURSOR_SDK_DISABLE_SESSION_RESUME=true`（默认）时关掉基线：那时每个请求都是全新 agent，
  增量恒等于累计值，不必让基线表跟着无 resume 的请求数增长。
- 3f：`model-params.ts` 新增 `effectiveIntentFromParams()`（`resolveModelParams` 的逆向），
  `finishLog` 优先记反解出的实际下发值、反解不出才退回请求意图，并把哪几列是实测的记进
  `request_logs.effective_params`（新列，`PRAGMA table_info` + `ALTER TABLE` 增量迁移）。
  后台在只是意图的那几列后面缀 `?` 并给悬停说明。
  **三个字段的可反解程度不同**：fast 与布尔形态的 maxMode 可以直接从实际参数反解，reasoningEffort 可以从分级参数
  取值反解；但 `context=1m` / `272k` 这类 tier-valued Max Mode 只看下发值无法确认它是不是该模型的最大档，
  要对照整张档位表——`telemetryRef.modelParams` 里没有那张表。无法确认的部分宁可留空退回意图，也不猜一个会被当成实测值的数。
- 测试：`store.test.ts` 加 `REQUEST_LOG_KEEP` 解析 + 跨 100 条裁剪周期的全量/限量对照、
  agent 基线的增量/多 agent 隔离/**换一个 store 实例模拟重启**/倒退记 0；内存 store 的 parity 用例同步补上基线语义。
  `usage-capture.test.ts` 加同一 agent 两次请求只记增量、两条补写并发时合计恰好等于累计值一次、关掉基线时逐条全额，
  并覆盖 stale cumulative、日志写失败后的基线回滚、205 条突发不丢任务、HTTP 关停竞态、挂起的 `getUsage()`、
  不变的正累计写明确零、聚合器修复矛盾的 `totalTokens`，以及不同本轮 token 不被累计 usage 覆盖；
  `store.test.ts` 另覆盖 `1 → 2 → 100` stale 递增低读数、持久化安静 agent 的基线保留和内存/SQLite 回滚语义。
  本轮新增的回归断言分别锁定旧实现的失败路径：`1 → 2 → 100` 会被 reset heuristic 拆成
  `2 + 98` 而重复收费；启动清理会删掉安静 agent 的基线并把 `120` 全额计入；
  关停竞态会在 reconciler 提前关闭后丢掉在途请求；无界的 drain 会被挂起 `getUsage()` 永久阻塞；
  不变的正累计只会耗尽重试而不落明确零；内存 store 的日志写失败会留下已推进的基线。
  `server.test.ts` 加非流式与流式估算数字按各协议渲染形状对齐（不是完整 JSON 字节数）、实测值压过估算、无产出时不谎称 estimated、
  直传模式用客户端自己的 key 补写金额、实测参数压过意图且 maxMode 如实退回意图。
  测试脚手架：`createTestApp` 支持注入 `usageReconciler`，`FakeRunner` 补上真实 runner 的 telemetry 回写
  （agentId/runId，以及可注入的实测用量与实际下发 params）——不补的话金额补写在 HTTP 层根本观测不到。
  验证：`npx tsc --noEmit -p tsconfig.json` 干净；`npm test` = **429 用例 / 428 通过 / 1 跳过 / 0 失败**。

### WP4 · 代理

状态：待审阅

- 4a：HTTP/1.1 改成三态解析——持久化设置 > 非空原始 env（含显式 false）> **配了代理即默认开** > 兜底关。
  `loadCursorSdkUseHttp1ForAgent` 返回 `{ enabled, source }`；`GatewayConfig` 仍是布尔，未动 `types.ts`。
  后台保存代理时，只在「没人表过态」（`source === "proxy"`）的情况下自动打开并持久化，返回 `http1AutoEnabled` + 提示文案；
  清空代理不会反向关掉。
- 预热执行器问题真解决了而不是只写文档：`setAgentTransportResetter` 接到 `executorLeases.releaseAll()`，
  改完 SDK 模块态就释放预热租约让引用计数能归零；在途连接仍留在 HTTP/2，这点在提示与 README 里讲明了。
- 4b：新增 undici 自定义 connector（把 SOCKS socket 作为 `httpSocket` 交给 undici 自己的 `buildConnector`，
  ALPN 与 TLS 会话缓存行为与直连一致），socks4/5/5h 全部覆盖 fetch 路径。
  顺带修掉一处真实的不一致：原先 undici 总把域名交给代理（socks5h 语义）而原生 agent 本地解析，同一个网关两套 DNS 行为。
  `socks@^2.8.9` 提为直接依赖；**发现 lockfile 是脏的**——根依赖里原本连 `undici` / `https-proxy-agent` / `socks-proxy-agent` 都没有，已修正。
- 4c：探测拆成 REST（undici → `api.cursor.com`）与模型（`https.request` + 一次性原生 agent → `CURSOR_BACKEND_URL || api2.cursor.sh`）
  两条并行上报，聚合 `ok` 需两条都通；断言过程中进程级 dispatcher 与两个 `globalAgent` 均未被动过。
- **人工证据（提交的用例复现不了这一条）**：执行代理用本机 SOCKS4/SOCKS5 服务器对**真实上游**做了端到端验证：
  三种 SOCKS 在 REST 拿到 401、模型通道拿到 200，代理侧观察到 socks5/socks4 是 ATYP=1（已解析 IP）、socks5h 是 ATYP=3（域名）。
  真实上游、真实证书链、真实 401/200 都进不了单元测试；第 2 轮把其中能本机复现的部分补成了自动化用例（见下），
  剩下「打通到 api.cursor.com / api2.cursor.sh」这一段仍然只有这条人工记录。

#### 第 2 轮修复

- **三态曾经被后台表单毁掉**（本轮最高价值的一处）：loader 的三态是对的，但后台把它渲染成勾选框，
  勾选框只有两态，于是随便改条别的运行设置就替操作者提交了一次显式 `false` 并落库；
  之后再配代理，loader 看到 `source === "stored"` 就不再自动开 HTTP/1.1，模型流量继续直连——
  操作者根本没碰过那个控件。上一轮那句「只在没人表过态时自动打开」因此在真实使用里几乎必然落空。
  改成三档 `<select>`：**未设置（配了代理就自动开）** / 强制开启 / 强制关闭。
  「未设置」在线上传的是 `null`，`POST /admin/api/settings` 收到 `null` 走 `clearCursorSdkUseHttp1ForAgent()`
  把设置写成空串，而 loader 只认非空串为「存过」，空串等价于从没配过；
  表单每次都从 `cursorSdkUseHttp1Source` 回填（`stored` 才显示强制态），所以没动过控件的往返提交的一定是 `null`，
  造不出显式取值。响应体里回带 `cursorSdkUseHttp1Source`，后台会把「当前这个值是谁定的」写在开关下面。
- `maskProxyUrl` 原先按**第一个** `@` 切分，密码里有没转义的 `@`（`http://alice:@s3cret@bad host`）时后半截照样漏进
  管理 API 的报错和后台 toast。改成按 authority 里最后一个 `@` 切；
  主机部分不像主机名/IP 的输入整条打成 `***`——那种字符串没有可信的凭据边界，尽力而为的掩码就是漏密码。
  同时把构造 dispatcher / 原生 agent 的异常也过一遍 `scrubCredentials`：
  第三方库的报错会把整条代理 URL 抄进 message。
- 模型探测原先「回来个状态码就算通」。`https-proxy-agent` 在代理回绝 CONNECT 时不抛错，
  而是把代理自己那条 407 / 502 当成响应回放，形状与上游的回应完全一致——密码写错却看到绿灯。
  改成按「这条响应是不是从隧道内的 TLS 连接上读出来的」区分：
  探测目标是 https 时响应 socket 必须 `encrypted === true`，否则判定为代理生成并转成失败（407 额外提示是鉴权问题）。
  http 目标不适用（本来就没有隧道），保持原判定。
- 换代理不再把在途请求打断：旧的原生 agent 从 `destroy()` 改成排空——立刻拆空闲连接，
  在途连接轮询等它自己结束（上限 10 分钟）后再 `destroy()`。undici 那侧本来就是 `close()`，一直是优雅的。
- HTTP 代理的半截凭据（只有用户名或只有密码）两条链路口径统一了：
  原先 undici 只在用户名与密码都非空时才带 `Proxy-Authorization`，原生 agent 有一个就带，
  于是同一个地址能出现「REST 407、模型流量却通」。现在两侧都用同一份 `Basic` token。
- 代理告警里那句「把 `CURSOR_SDK_USE_HTTP1_FOR_AGENT` 留空或设为 true 并重启」是错的：
  落库的显式 `false` 优先级高于 env，改环境变量不解决问题。改成指向后台那个三档开关。
- 用例侧（`tests/proxy.test.ts`）：SOCKS 握手改成**按链路归因**——REST 与模型探测打不同的目标端口，
  dummy 代理按端口把握手分别记账，两条各断言一次；原先只断言「收到过一次握手」，
  把 undici 的自定义 connector 整个换成直连也照样能过。
  新增本机 SOCKS5 服务器覆盖：隧道打通、socks5 本地解析 vs socks5h 交给代理（断言 ATYP 与代理侧看到的地址）、
  用户名密码鉴权（RFC 1929）、以及目标证书不被信任时 TLS 升级必须失败（自签证书 + 不放宽校验）。
  还补了「代理回绝 CONNECT 时模型探测必须报不通」与「换代理只拆空闲连接」两条。
- 第 3 轮修复：生产 SOCKS connector 的握手、代理 TCP 连接与 TLS 升级都按 `REQUEST_TIMEOUT_MS` 设截止时间，
  能拿到请求 signal 时会在取消时拆掉握手 socket；探测路径继续使用调用方传入的 5/10 秒截止时间。
  替换下来的 undici dispatcher 的 `close()` 也加了 10 分钟排空上限，超时后强制 `destroy()`，避免后台清理 promise
  永久挂住。
- 执行器租约的 `releaseAll()` 现在返回 `{ ok, failures }`；release 失败或超时会继续保留句柄并标成 retiring，
  后续 `warm()` 先重试释放、成功后才建新租约，不会复用可能仍钉住旧传输层的那一份。超过上限的淘汰也走同一
  个有时限、留存、告警路径。
- 未通过 URL 校验的 authority 不再把候选端口片段写进错误信息；主机结构含 `%` 等无法确认边界时掩码整条输入。
- 后台设置表单只有实际改过 HTTP/1.1 下拉框才提交三态字段，避免旧页面的 `null` 清掉另一位管理员的显式选择；
  绑定编辑保存前刷新 Cursor key 快照，检测到原绑定已被删除且结果为空时回填全禁哨兵。GET 与 POST 的竞态仍需
  后端用版本 / 原绑定条件做原子校验。
 - 回归用例覆盖 release report 与 warm 重试、溢出释放失败留存、两条残余代理凭据泄漏路径，以及 transport error
  中携带真实 `crsr_` key 时的脱敏；这些断言均针对旧实现的实际失败路径。
 - undici 的 `Client` 不会把 request signal 传给自定义 connector，所以生产 SOCKS dispatcher 另包一层按 origin 排队并转交 signal，
   同时清理复用现有连接的未消费项，避免取消后的 signal 污染后续重连。
- `releaseAll()` 还会等待已经启动但尚未回表的溢出回收动作，避免 reset 在失败报告落地前误报成功。

### WP5a · 模型别名归一化

状态：待审阅

- `modelAllowed` 保留单字符串签名（大量测试与 `selectKey` 依赖它），旁边新增 `modelIdentity()` / `identityAllowed()`。
- 匹配改成对称：身份里任意一项命中黑名单即拒；白名单非空时任意一项命中即放行。
  `filterModelsByScope` 的黑名单也改成看 alias（原先只看 id）。
- 导出 `staticModelAliases()`：`normalizeModel` 会在任何 scope 检查**之前**把 `composer-latest` 折叠成 `composer-2.5`，
  而真实目录没理由把 `composer-latest` 列为 alias，不补这一层的话黑名单写 `composer-latest` 永远命中不了。
- 刻意走 `deps.modelLister ?? listAvailableModels` 而不是 `getModelCatalogEntry`：既能在测试里打桩，
  又绕开后者的强制刷新分支（乱填模型 id 的请求本来可以借它打爆上游）。

#### 第 2 轮改动

- `intersectScopes()` 改成认别名：多收一个可选 `identity`，白名单求交时
  「两侧各写了同一个模型的不同叫法」算命中——网关写 canonical id、Cursor key 写别名，
  描述的本来就是同一个模型，按字符串求交却会落空成 `NO_MODEL_SENTINEL`，把本该放行的请求拒掉。
  这是**误拒**不是提权，所以只放宽白名单这一侧；黑名单仍然取并集，一侧禁掉就是禁掉。
  不传 identity 时行为逐字节不变（`modelAllowed` 等旧调用点不受影响）。
- `staticModelAliases()` 搬到 `routing.ts` 并改成双向查表（理由见 WP1）。
  `models.ts` 的 `normalizeModel` 改用同一张表导出的 `staticCanonicalModel()`，
  「折叠成哪个 id」与「这个 id 还有哪些叫法」从此不可能对不上。

### WP5b · 后台模型清单取全池并集

状态：待审阅

- `GET /admin/api/models` 改成全池 active key 目录的并集：按 id 大小写不敏感去重，
  同一模型在不同账号下的别名取并集，任一把 key 报 `source: "cursor"` 整体就算 cursor。
  仍然不过滤（这里是勾 allow/deny 的源）。
- 成本：目录按 (apiKey, 通道) 缓存 10 分钟，并集在缓存命中时只是 N 次内存查表；
  只有冷缓存的第一次会串行打上游 N 次。这条路径只有管理员打开后台才会走。
- 单把 key 失败非致命，用 `try/catch` 而不是 `.catch()`——`runWithCursorClientType` 是同步转发，
  同步抛出的异常不会变成 rejected promise。全部失败或一把 active key 都没有时退回无 key 目录
  （进程缓存 / 静态兜底），避免后台勾选框整片空白。被禁用的 key 不参与并集。

#### 第 2 轮补充

- 推理路径解析模型身份时复用了同一套「按 key 求并集、单把失败只是少贡献几条」的形状
  （`models.ts::findModelAcrossCatalogues`，只解析一个模型的叫法）。
  刻意**没有**把后台那份「不过滤」语义带过去：后台那份是给运营勾 allow/deny 的源，
  推理路径要的只是叫法本身，两者的取舍不一样。
  另有一处口径差异：推理侧只认 `source === "cursor"` 的目录，静态兜底列表不算「确认过身份」——
  那是网关自己的猜测，拿它去证明「这个模型不在黑名单上」是不成立的。
- `admin.ts` 本轮归另一个代理所有，没有把 `globalModelCatalogue` 改成与推理侧共用同一个 helper；
  两者形状一致但目标不同，合并与否留给后续判断。

#### 第 3 轮安全修复

- High 2：`findModelAcrossCatalogues()` 现在返回 `{ entry, confirmed }`。
  `confirmed` 的含义是「本次决定所依赖的相关目录都成功返回，并集因此完整」，
  不是「至少一把 key 找到了 entry」。只要任一 active key 的目录查询失败，
  即使另一把 key 成功找到 canonical id，也保留合并 entry 但标记 `confirmed=false`；
  没有 entry 或没有可查询目录同样不算确认。`server.ts` 将该标记原样放入
  `ModelIdentity`，L1/L2 共同触发黑名单的 fail-closed，避免部分并集重新打开 alias bypass。
- Medium 6：`/v1/models` 的 direct 路径只有在 token 对应 active 的登记记录时才向
  `modelLister` 传 Cursor key；未登记 token 改走无 key 的缓存/兜底列表，不再让调用者
  驱动上游目录查询。已登记 direct key 的列表按该 key 自己的 model scope 过滤，
  与推理及 `count_tokens` 的限制口径一致。
- 覆盖：`tests/server.test.ts` 增加混合目录失败（A 失败、B 成功仍为 unconfirmed）、
  未登记 direct token 的 lister 调用计数、已登记 direct key 的 scope 过滤，以及
  Cursor key 黑名单在目录不可用时的 fail-closed；这些高风险用例在回退实现到修复前
  版本时分别复现放行、上游收到裸 token 或错误列表，修复后才通过。

### WP6 · 铸钥

状态：待审阅

- 默认名改为 `gateway-<YYYYMMDD>-<HHMMSS>-<12 位 hex>`（`randomBytes(6)`，48 bit 熵），
  固定 36 字符、满足 `NAME_PATTERN` 与 `MAX_NAME_LENGTH`；保留 UTC 日期是为了后台列表仍可排序。
  选 hex 而非 base64 是因为 `+` `/` `=` 违反 `NAME_PATTERN`。
- `readApiKey` 按 D7 校验前缀白名单 `crsr_` / `key_`，其余抛 502 `upstream_error`，
  错误信息带截断前缀 + 总长度（至少扣掉一个字符，任何情况下都拼不回原值），
  这两项正是区分「上游返回错误串」与「上游换了新前缀」所必需的。
- 未给 `key-pool.ts` 加任何前缀校验：env 播种与后台粘贴是独立路径，
  加了会连带打挂整套用 `key-a` / `server-cursor-key` 这类 fixture 的回归测试。
- 顺手修掉 `admin-ui.ts` 两处误导文案：占位符原写 `key_...`、铸钥提示原说名字「由上游自动生成」（实际是本网关生成的）。

#### 第 2 轮修复

- 上一轮只把「2xx 但形状不对」这条路径用 `apiKeyShapeHint()` 保护起来了，密钥保密并没有覆盖整个铸钥动作：
  非 2xx 的响应体原样截 300 字符拼进 502。上游真在 500 里回了 `{"apiKey":"crsr_..."}`，
  整把新 key 就经由管理 API 和后台 toast 泄出去——铸钥失败本来就是最可能触发这条路径的时刻。
  进入错误信息的上游响应片段会先过 `redactSecrets()`：
  JSON 里 `api_key` / `token` / `secret` / `password` / `cookie` / `authorization` 这类字段的值、
  可识别的 `crsr_` / `key_` 开头的串、以及被回显的会话 token 与 `WorkosCursorSessionToken=` cookie，
  换成 `apiKeyShapeHint()` 那种「前缀 + 总长度」的形状；这不是对任意未知凭据格式的完整保证。
  代理解析失败的 authority 另行整条掩码，传输层错误也会经过同一套已知形状清理。
- D7 要的诊断能力没被削掉：字段名、HTTP 状态码、响应体里的非密文字（`error` / `message` 这些）都原样保留，
  被遮的地方也仍然看得出「这里原本是个 `crsr_` 开头、长 N 的串」。
  「上游返回错误串」与「上游换了响应形状」照样分得开——区分这两者靠的是形状与字段名，从来不需要密钥本身。

### WP7 · 会话粘性

状态：待审阅

- 7a：会话种子改为**落库 + 逐轮继承**。`responses` 表加 `conversation_seed` 列（可空，
  `PRAGMA table_info` + `ALTER TABLE` 增量迁移，沿用本文件既有套路），`StoredResponse` 加同名字段；
  `MemoryStateStore` 直接存整条记录，无需改动。
  `/v1/responses` 取 `previous?.conversationSeed ?? conversationSeed(body)`，
  并把结果同时写进本轮记录——链上只存直接父节点，靠「每轮回写」而不是「回溯整条链」撑起第三轮往后。
  流式与非流式两条 `saveResponse` 路径都带上种子。
- 种子不进 `response` / `metadata` / 任何回显字段：它是选 key 用的服务端状态，
  客户端拿到就能自己指定这次打到哪把 key。
- 降级路径：老库记录无种子、`store:false` 压根不落库（续聊照旧 404）——两种情况都退回按请求体现算，
  认不出就不启用粘性，不会抛错。副产品：只带 `function_call_output` 的续请求原先必然认不出对话，
  继承之后也能粘住了。
- 刻意没动 `sessionKey`：它在 `/v1/responses` 下退化成 `previousResponseId ?? ownerHash`，逐跳都变，
  与 stickyKey 是两码事，拿它兜底只会把整个网关钉死在一把 key 上。
- 7b：`SEED_SEGMENT_LENGTH` 200 → 4000；system/developer 指令现在全部参与种子，而不是只取第一条。
  种子仍只取稳定身份部分（system/developer + 第一条 user），所以追加普通 user/assistant 轮次时不变；
  完整首轮内容或落库继承也能提供稳定性，前缀不是唯一保证。

### WP8 · 系统提示词

状态：待审阅

- 8a：`input[]` 里 role=system/developer 的条目与顶层 `instructions` 一并交给 `resolveSystemText()`，
  并从 `INPUT:` 渲染中摘出（顺序＝客户端书写顺序，append 才能保证网关正文收尾）。
  `type` 省略的 EasyInputMessage 同样识别——不认的话它会以 JSON 块的形式把客户端 system 留在 `INPUT:` 里。
  只在 `systemPromptActive()` 为真时上提，与 Chat 分支同一套路；mode 为 off 时一条都不动，逐字节不变。
  `INSTRUCTIONS:` 块改成先占位、渲染完 input 再 `splice` 回原位，位置与改造前一致。
- `prepared.inputItems` 仍是原始数组：上提只作用于合成 prompt，
  `GET /v1/responses/:id/input_items` 照旧逐字回显客户端发来的内容。
- 8b：`sanitizePreviousResponseForPrompt` 删掉快照副本上的 `instructions`。
  官方语义下 `instructions` 是逐轮参数、不跨 `previous_response_id` 继承，
  原先它会经 `PREVIOUS_RESPONSE:` 的 JSON dump 把上一轮的客户端 system 重新灌进 prompt。
  剥的是深拷贝，客户端取回的已存 Response 不受影响（已在用例里断言）。
  网关正文本来就只活在 flat prompt 里、从未落库，所以没有「我们自己那段」需要剥。

---

## 过程中发现的新问题

（定位 / 执行 / 审阅阶段冒出来的、不在原始四路审阅清单里的问题记在这里）

---

## 用户侧待办（代码改不了的部分）

- [ ] 去 cursor.com 后台撤销 / 轮换 `1.py` 里那个 `WorkosCursorSessionToken`
- [ ] 同样撤销需求原文里贴出的那个 session token
