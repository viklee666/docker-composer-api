# 管理后台：敏感凭据一键复制 + 联通性测试交互重构

> 目标：两个独立但同属「后台运维体验」的改动。
> ① 所有敏感内容（Cursor Key、网关密钥、Bot session token）支持**点击复制**——明文只进剪贴板，不落 DOM、不显示在页面上。
> ② 联通性测试交互补齐：Key 池行内测试**就地选模型**（不再绑死诊断页的模型下拉）；诊断页支持**指定某把 key** 测试（不再只能整池从头逐个尝试）。
> 版本基线：v0.4.2，工作区（未提交改动不影响本计划）。部署：`git pull` + `sudo docker compose up -d --build`。

## 0. 现状与根因（已核实）

### 0.1 敏感内容无法复制

| 内容 | 后端现状 | 前端现状 |
|---|---|---|
| Cursor Key | `publicKey()` 只回 `maskedKey`（admin.ts:1216），无任何明文接口 | 表格只显示掩码，无复制按钮 |
| 网关密钥 | 仅 `POST /admin/api/gateway-keys` 创建时 `reveal:true` 回一次明文（admin.ts:861），之后**永远取不回** | 创建后有一次性 secret-box + 复制按钮（admin-ui.ts:2095-2099）；关闭/刷新后失效 |
| Bot session token | `publicCredential()` 只回 `tokenHint`（首尾 4 位），注释明确「绝不回传 token」 | 表格只显示 hint，无复制按钮 |

运维要把某把 key 配到客户端时，唯一出路是作废重发。这是设计出来的安全约束（防「能读列表就能导出全部凭据」），但本项目的实际威胁模型是**单人运维、后台已 password 鉴权**，「防止管理员自己拿到自己配的 key」没有价值。

### 0.2 联通性测试交互

- **行内测试的模型来自另一个页面**：Key 池每行的「测试」按钮（`testKey()`，admin-ui.ts:1636-1658）提交的 `model` 取自诊断页的 `$('test-model')`（admin-ui.ts:1643）。要换测试模型必须切到「联通性测试」页改下拉再切回来——这就是用户抱怨的「必须要到连通性测试那里去换模型」。
- **诊断页不能按 key 测**：`runAdminChatTest`（admin-ui.ts:2593-2622）的 payload 从不带 `keyId`，永远 `useKeyPool: true`，由密钥池从队首开始逐个尝试。而后端 `/admin/api/test` **早已支持** `keyId` 定向（admin.ts:1009-1017：指定时绕过池轮换、直接用该 key、成功回写健康、失败按 transient 记），tests/server.test.ts:2127 也有覆盖。纯粹是前端没接。
- 附带一个已存在的小毛病：`testKey()` 里 `model: testProvider() === 'bot' ? (modelIds()[0] || 'composer-2.5') : $('test-model').value`——行内测试（固定 `provider:'sdk'`）的模型却取决于诊断页 provider 下拉的当前值，行为不可预测。

## 1. 方案总览

两个改动互相独立，可分开落地、分开提交：

- **A. 复制功能**：后端新增三个 reveal 端点（管理员鉴权下按 id 返回明文，一次性、不落库不落日志）；前端三处表格每行加「复制」按钮，点击 → reveal → 直接写剪贴板 → toast。明文**始终不渲染进 DOM**。
- **B. 测试交互**：Key 池面板头部加「测试模型」下拉（行内测试就地取值）；诊断页加「指定 Cursor Key」下拉（默认「自动（整池）」，选中即走 `keyId` 定向测试）。

## 2. 改动 A：敏感凭据点击复制

### 2.1 后端：三个 reveal 端点

| 端点 | 返回 |
|---|---|
| `POST /admin/api/keys/:id/reveal` | `{ apiKey }` |
| `POST /admin/api/gateway-keys/:id/reveal` | `{ apiKey }` |
| `POST /admin/api/bot/credentials/:id/reveal` | `{ sessionToken }` |

设计要点：

- **POST 而非 GET**：这是敏感读取操作，不该被浏览器预取、被代理缓存、出现在书签/分享链接里。与 `/admin/api/proxy/test`、`/admin/api/bot/credentials/:id/test` 的既有风格一致。
- 鉴权照走 `requireAdmin`（口令或启用的网关密钥）。404 语义与各自现有路由一致（`Key not found.` / `Gateway key not found.` / `Credential not found.`）。
- **不写请求日志**：admin API 本就不经 `loggedRunRequest`，reveal 端点也不新增任何落库（不记「谁在何时复制了什么」，保持和现状同一水位——现有 admin 读接口同样无审计）。
- **不设频控、不设过期**：后台是单人口令保护的内页，加节流只会再制造一次「运维自己被挡在外面」。风险声明见 §2.3。
- env 播种的网关密钥（`source === "env"`）同样允许 reveal：GATEWAY_API_KEY 的值运维本来就在 env 里握着，遮它没有意义。
- Bot token 是 JWT，reveal 后原样返回 `sessionToken`，不附 machineId 等字段（复制场景用不到，别多给）。

### 2.2 前端：行内「复制」按钮

三张表格各加一个按钮，交互完全一致：

```
点击「复制」
  → 按钮 disabled + 文案「复制中…」
  → api('POST', '.../reveal')
  → copyText(明文)          // 复用现有 copyText()（admin-ui.ts:2088）
  → toast('已复制到剪贴板')   // 失败 toast(错误, true)
  → 恢复按钮
```

- **明文不进 DOM**：不经任何 `innerHTML`/`textContent`，只作为 `copyText` 的实参存在。页面上继续显示掩码/hint 不变。这把「显示后复制」的两步交互缩成一步，同时把明文暴露面收窄到剪贴板写入那一个瞬间。
- 落点：
  - Key 池行（`renderKeys`）：操作列 `测试` 前加「复制」，调 `/admin/api/keys/:id/reveal`。
  - 网关密钥行（`renderGatewayKeys`）：操作列加「复制」，调 `/admin/api/gateway-keys/:id/reveal`。创建时的一次性 secret-box 照旧（它还承担「自动生成密钥的首次告知」职责），行内复制解决「之后任何时候要再拿」。
  - Bot 凭据行（`renderBotCredentials`）：操作列加「复制」，调 `/admin/api/bot/credentials/:id/reveal`。
- 事件分发沿用现有模式：Key 池 / 网关密钥走 `keys-body`/`gw-body` 的 `data-action` 委托（新增 `action === 'copy'`）；Bot 走 `bot-body` 委托（新增 `data-bot-copy`）。
- 三个 handler 收敛成一个 `copySecret(path, button)` 工具函数，避免三份重复的 disabled/toast/finally 样板。
- 复制失败（非安全上下文、剪贴板被拒）时 fallback：`window.prompt` 兜底显示明文让用户手动复制——比静默失败好，且只在 clipboard API 不可用时才走。提示语注明「剪贴板不可用，请手动复制」。

### 2.3 安全边界（如实写进代码注释）

- reveal 端点等于「持有后台口令即可导出全部凭据明文」。这是有意的取舍：之前靠「永不回传」挡的是**已拿到后台会话的攻击者**，但该攻击者本来就能增删 key、改路由、看请求历史（含 keyLabel），后台沦陷本就是全量失守。真正的边界仍是 `requireAdmin` 的口令强度。
- 明文不落 DOM、不落日志、不落 localStorage；`copyText` 的 toast 只说「已复制」，不复述内容。
- 若未来要多人运维，再加审计行（who/when/which id）与频控——本计划不做，注释里留这句话。

### 2.4 明确不做

- 不做「眼睛图标切换显示/隐藏明文」：把明文渲染出来再复制，暴露面（XSS、截图、肩窥）远大于直接写剪贴板。
- 不给 `/admin/api/keys` 列表接口加 `reveal` 参数：一次性端点比「列表带明文」好审计也好撤。
- 不改 `maskedKey`/`tokenHint` 的现有展示：认钥匙靠掩码，复制靠按钮，两件事分开。

## 3. 改动 B：联通性测试交互

### 3.1 Key 池行内测试：就地选模型

Key 池面板（`sec-keys`）的「添加 Key」输入行下方加一行：

```html
<div class="row" style="margin-bottom:14px">
  <select id="key-test-model" style="min-width:200px" title="行内「测试」按钮使用的模型"></select>
  <span class="hint">行内「测试」使用上面选中的模型</span>
</div>
```

- 选项来自 `modelCatalog`（`fillModelSelects()` 里同步 `fillSelect($('key-test-model'), modelIds(), null)`，沿用保留当前选中值的逻辑）。
- `testKey()` 的 `model` 改为 `$('key-test-model').value || modelIds()[0] || 'composer-2.5'`（兜底顺序：用户选择 → 目录第一个 → 硬编码默认）。**删掉**对 `$('test-model')` 和 `testProvider()` 的引用——行内测试从此与诊断页状态完全解耦，顺手修掉 0.2 里那个 provider 串扰的小毛病。
- 模型目录还没拉到时 select 为空，行内测试点下去走硬编码兜底 `composer-2.5`，与现状一致（现状在空目录时也是拿不到值就发 undefined，后端 `normalizeModel` 会兜底；显式写兜底值让行为可预期）。

### 3.2 诊断页：指定 Cursor Key 测试

「联通性测试」面板的控件行加一个下拉（放在 provider 与 model 之间）：

```html
<select id="test-key" style="min-width:180px" title="留空走密钥池轮换；选某把 key 则定向测试">
  <option value="">自动（密钥池轮换）</option>
  <!-- lastKeys 各项：<option value="id">备注/掩码（状态）</option> -->
</select>
```

- 选项由 `renderKeys()` 之后统一回填（新建一个 `fillTestKeySelect()`，在 `loadAll()` 的 keys 渲染后调用；沿用 `fillCcKeySelect` 的「保留当前选中 + 标注已禁用」写法）。
- provider 切到 `bot` 时：`test-key` disabled 并清空选中（Bot 路线不用 Cursor Key 池，选了也是 400）；切回 `sdk` 恢复。`updateTestRouteHint()` 文案随之更新：
  - sdk + 未选 key：现文案不变（「下方按钮走密钥池（测当前队首可用 key）」）。
  - sdk + 已选 key：'定向测试选中的 key：绕过密钥池轮换，直接用这一把（成功会清它的失败计数，失败按 transient 记、不计入自动禁用）。'
  - bot：现文案不变。
- `runAdminChatTest` 提交诊断页测试时附 `keyId`（`opts.provider === 'sdk' && $('test-key').value` 时带上；其余不带）。行内 `testKey` 的 keyId 逻辑不变。
- 结果展示（`test-result`）成功时已有 `keyLabel` 回显，够用，不动。

### 3.3 连带清理

- `testKey()` 顺带修复：模型来源改掉后，`provider` 仍固定 `'sdk'`、`prompt` 仍取 `$('test-prompt').value`——**prompt 也改**：行内测试不该共用诊断页的 prompt 输入框（同样是跨页隐藏耦合）。行内测试固定发默认 `'Reply with exactly: pong'`（现状里 prompt 取诊断页输入框的值，用户在诊断页改过 prompt 会悄悄影响行内测试，属于同一类病）。

## 4. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/admin.ts` | 新增 3 个 reveal 路由（§2.1）；`publicCredential` 不动 |
| `src/admin-ui.ts` | ① 三张表格行内「复制」按钮 + `copySecret()` + prompt 兜底（§2.2）② Key 池「测试模型」下拉 + `testKey` 解耦（§3.1、§3.3）③ 诊断页「指定 Cursor Key」下拉 + `fillTestKeySelect()` + hint 联动 + `runAdminChatTest` 带 keyId（§3.2） |
| `tests/gateway-keys.test.ts` | 网关密钥 reveal 端点：明文正确、鉴权 401、未知 id 404 |
| `tests/server.test.ts` | ① Cursor Key reveal 端点同上三断言 ② `/admin/api/test` 指定 keyId + 自定义 model 组合（现有用例只测了默认 model 的 keyId 定向） |
| `tests/cursor-bot-routes.test.ts` | Bot 凭据 reveal 端点：明文正确、未知 id 404 |

前端内联 JS 无自动化测试（仓库现状：admin-ui.ts 不在测试覆盖内），前端部分靠 typecheck + 手工验收清单（§6）。

## 5. 测试计划

```bash
npm run typecheck && npm test
```

新增用例（全部走 `app.inject`，风格与现有一致）：

1. **reveal 三端点**：各自「返回的明文 == 入库明文」「无鉴权 401」「未知 id 404」。网关密钥加一条「env 播种的 key 也能 reveal」。
2. **admin test 定向组合**：`POST /admin/api/test` 带 `{ keyId, model }`——断言 `runner.lastApiKey` 是指定 key、`runner.lastInput.model` 是指定模型（现有用例只断言了 key 定向没断言 model 透传）。

## 6. 手工验收清单（部署后）

1. Key 池行「复制」→ 粘贴到别处 == 入库的 crsr_ 明文；页面无任何明文残留。
2. 网关密钥行「复制」同上；创建新密钥的一次性展示框照旧工作。
3. Bot 凭据行「复制」→ 粘贴出来是完整 JWT。
4. Key 池页头部选模型 → 行内「测试」→ 请求历史里该次 `/admin/api/test` 的模型 == 所选。
5. 诊断页选某把 key 测试 → 结果里 keyLabel == 该 key；选「自动」→ 行为同旧版（队首 key）。
6. 诊断页 provider 切 bot → key 下拉禁用，测试照常走 Bot。
7. 换到诊断页改模型/prompt → 回 Key 池行内测试，行为不受影响（解耦验收）。

## 7. 被否决的替代方案

- **显示/隐藏切换（眼睛图标）**：明文渲染进 DOM 再复制。被否，理由见 §2.4——暴露面大于直接进剪贴板，且多一步交互。
- **列表接口带明文（`?reveal=true`）**：一次拉全量明文，缓存/误打印风险大，且和「列表给掩码、按需取明文」的分层冲突。被否。
- **网关密钥沿用「创建时一次性显示」并支持重建**：对存量密钥无效，运维还是要作废重配。被否。
- **行内测试用弹窗选模型**：一个 modal 只为选一个模型，比面板头部一个常驻下拉重得多；且 10s 轮询会重建表格，modal 状态管理又要多一套。被否。
- **诊断页 key 下拉做进 provider 切换逻辑（bot+key 二选一）**：不 disable 下拉而是提交时静默忽略 keyId，会复刻「选了没生效」这类静默失败——当前代码里这类坑（如行内测试模型串扰）正是本次要修的对象。被否，必须显式 disable + hint 说明。
