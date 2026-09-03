# Fast / Max Mode：三态策略（透传 · 全量强制 · 指定模型）

> 目标：后台不再用「勾上=强制开 / 取消勾=不管」的二态。Fast 与 Max Mode 各自变成三种策略；日常默认不加速，但客户端和按模型强制仍然随时能打开。
> 本文只给**一个**方案。被否决的替代路线在 §6。
> 版本基线：当前工作区（v0.4.2 + 未提交改动）。部署：`git pull` + `sudo docker compose up -d --build`。

## 0. 为什么必须改（已核实）

后台「支持的模型默认开启 Fast」取消勾选后，**所有 Composer / Grok 请求仍按 Fast 计费**。根因不是显示错误。

1. `gateway-settings.ts` 把 off 读成 `undefined`（「交回客户端/模型决定」），不是 `fast=false`。
2. `resolveModelParams` 只要 reasoning / maxMode / fast 任一有值，就先拷目录**默认 variant 的全量参数**。Composer 2.5 默认档是 `{fast:true}`；Grok Extra High 默认档也是 Fast。
3. `intent.fast === undefined` 时 `applyFast` 整段跳过，默认档的 `fast=true` 原样发给上游。
4. 截图里 **Max Mode 是勾上的**，于是每条请求都带 `maxMode=true`，不需要 Claude Code 的 `thinking` 也会走基线拷贝。
5. 现有测试同时关掉 Max Mode 和 Fast，并且只断言 `runner.lastInput.fast === undefined`（意图层），没断言出站 `model.params`，所以这个洞是绿的。

`.env` 的 `CURSOR_FAST` / `CURSOR_MODEL_PARAMS` / `CURSOR_REASONING_EFFORT` 都是空的，不是更高优先级写死了 Fast。

HTTP/1.1 已经是真三态下拉。Fast / Max Mode 继续用 checkbox，会把「没表态」存成「显式关」，再被实现成「不管」——这正是这次账单偏差的形状。

## 1. 产品语义（选定）

Fast 与 Max Mode **各有一份独立策略**，互不合并。客户端显式指定始终覆盖网关策略（与现在文案一致）。

| 档位 | 后台文案 | 网关在客户端未表态时做什么 |
|---|---|---|
| `passthrough` | 透传客户端（默认不加速 / 默认不大上下文） | 对该维下发 **显式 false**（Fast → `fast=false`；Max Mode → 最小 context / `maxMode=false`） |
| `force-all` | 全部支持的模型强制开启 | 对该维下发 **显式 true**（即今天勾上 checkbox 的行为） |
| `force-selected` | 仅下列模型强制开启 | 命中名单 → true；未命中 → 与 `passthrough` 相同（false） |

「支持」= 该模型目录 `parameters` / `variants` 里有对应参数，目录缺失时用 `model-params.ts` 的家族兜底（composer/grok/claude/gpt/codex 有 Fast；claude/gpt 有 context。composer 无 context，Max Mode 强制会被 dropped，这是现行为）。

### 1.1 「透传」为什么不是「什么都不写」

字面透传（`intent.fast = undefined`、出站省略 `fast`）对 Composer **等于开 Fast**：上游默认档就是 Fast。用户目标是「一般不用 Fast，但需要能开」，所以 `passthrough` 的操作定义是：

- 客户端没要 Fast → 网关写 `fast=false`（支持该参数的模型）
- 客户端要了 Fast（请求体 `fast`、头 `x-cursor-fast`、模型后缀 `:fast` / `#fast=true` / `[fast]`）→ 覆盖为 true
- 不支持 Fast 的模型（如 glm）→ 不写该维，避免 `dropped` 噪声

Max Mode 同理：Claude/GPT 目录默认档经常是 `context=1m`。省略参数 = 仍是 1M。`passthrough` 必须显式关掉，客户端再用 `@1m` / `[1m]` / `anthropic-beta: context-1m` / `max_mode` 打开。

### 1.2 优先级（低 → 高，保持现有 merge 顺序）

1. 网关策略（按**当前请求的模型 id** 解析成 `true` / `false` / 省略）
2. 请求头（`x-cursor-fast` / `x-cursor-max-mode` / `anthropic-beta` 的 1m）
3. 请求体 + 模型 id 后缀（`extractModelControls` + `parseModelSpec`）
4. 显式 `model.params` / `CURSOR_MODEL_PARAMS`（`resolveModelParams` 最后覆盖，原样发给 SDK）

`CURSOR_MODEL_PARAMS=fast=true` 仍然能盖过策略，后台文案里写一句，避免再踩。

### 1.3 推荐默认（本仓库运维画像）

- **Fast = `passthrough`**：日常不加速；Claude Code / Codex 仍可用请求打开。
- **Max Mode = `force-all`**：与当前后台勾选一致；迁移时 `cursorMaxModeDefault=on` 直接变成这一档。
- 新部署、库里没有旧键、env 也空：两维都是 `passthrough`（不再靠目录默认档「碰巧」变成 1M/Fast）。

### 1.4 `force-selected` 细则

- 名单存 **canonical 模型 id**（大小写不敏感），匹配走现成的 `identityAllowed` / `modelIdentity`（别名、静态 alias 组一起认）。
- 空名单 ≡ `passthrough`（强制了零个模型）。
- `composer-2.5` 与 `composer-2.5-fast` 是两条目录项；勾前者不会自动勾后者。后者本身就是 Fast 型号，不勾策略也不影响它以自己的 id 计费。
- 勾选 UI 只列出「目录显示支持该参数」的模型；允许手动加尚未出现在目录里的 id（复用密钥范围弹窗的「添加」）。
- 保存时不因「目录暂时没这条」而拒绝：目录会抖。运行时不支持就 `dropped`，与今天强制 Max Mode 打到 Composer 上一样。

### 1.5 与 context×fast 白名单的关系

不改 `resolveContextFastConflict`。GPT 1M 只能 `fast=false` 时仍是 **Max Mode 优先**（除非客户端/策略只显式要了 Fast、没要 Max Mode）。Claude 1M+Fast 合法则不动。后台 hint 沿用这句话。

## 2. 数据与配置

### 2.1 新键（settings 表，字符串）

| key | 值 |
|---|---|
| `cursorFastPolicy` | `passthrough` \| `force-all` \| `force-selected` |
| `cursorFastModels` | JSON 数组，如 `["composer-2.5","grok-4.6"]`；非法 JSON 当 `[]` |
| `cursorMaxModePolicy` | 同上 |
| `cursorMaxModeModels` | 同上 |

不再把三态压进现有的 `on`/`off` 布尔键。HTTP/1.1 开关已经证明：checkbox 存布尔会毁掉第三态。

### 2.2 迁移（启动加载，一次性语义）

读取顺序：

1. 若存在 `cursorFastPolicy` 且合法 → 用新键（`cursorFastModels` 一并读）。
2. 否则看旧键 `cursorFastDefault`：`on` → `force-all`；`off` → `passthrough`；未设置 → env。
3. env：`CURSOR_FAST=true` / `force-all` → `force-all`；`false` / `off` / `passthrough` / 空 → `passthrough`；`force-selected` → 该档，名单来自 `CURSOR_FAST_MODELS`（逗号/换行）。

Max Mode 对称（`CURSOR_MAX_MODE` / `CURSOR_MAX_MODE_MODELS` / `cursorMaxModeDefault`）。

首次用新 API 保存后写入新键。同时把旧键写成兼容投影，方便回滚到旧二进制时不至于全空白：`force-all` → `on`，其余 → `off`。

**行为变化（有意的）：** 旧「Fast 关闭」从「不管 → Composer 仍 Fast」变成「透传 → 下发 `fast=false`」。这就是本需求要修的账单问题。

### 2.3 `GatewayConfig`

用策略对象替换 `cursorFast?: boolean` / `cursorMaxMode?: boolean`：

```ts
export type ModelParamPolicyMode = "passthrough" | "force-all" | "force-selected";

export interface ModelParamPolicy {
  mode: ModelParamPolicyMode;
  models: string[]; // 仅 force-selected 有意义；其它档忽略但保留以便切回去不丢勾选
}
```

字段：`cursorFastPolicy`、`cursorMaxModePolicy`。派生函数（纯函数，单测友好）：

```ts
function policyIntent(policy: ModelParamPolicy, modelId: string): boolean
// passthrough / 未点名 → false；force-all / 点名 → true
```

不支持该维的模型由 `resolveModelParams` dropped，派生函数不必查目录。

### 2.4 管理 API

`GET /admin/api/overview` 与 `POST /admin/api/settings` 的 config 回显：

```json
{
  "cursorFastPolicy": "passthrough",
  "cursorFastModels": [],
  "cursorMaxModePolicy": "force-all",
  "cursorMaxModeModels": []
}
```

删除对前端的 `cursorFast` / `cursorMaxMode` 布尔压平。旧 POST 若仍丢 `{cursorFast: true}`：接受一个版本，`true`→`force-all`，`false`→`passthrough`，减少半截前端 400。测试全部改走新字段。

`GET /admin/api/models`：并集条目补上 `parameters`（及可选 `variants`）。今天 `CatalogueEntry` 注释写着「参数对勾选没用」——指定模型档需要用它过滤「支持 Fast / 支持 context」的列表。合并规则：parameters 按 id 去重并集。

联通性测试（`POST /admin/api/test`）按**测试所选模型**走 `policyIntent`，不要再读已经不存在的全局布尔。

## 3. 解析层（必须一起改，否则透传仍会漏 Fast）

`requestModelControls` 增加当前 `model` 参数（`prepared.model`，已经是去后缀的 canonical id）：

```ts
fast: policyIntent(config.cursorFastPolicy, model),
maxMode: policyIntent(config.cursorMaxModePolicy, model)
```

这样 `passthrough` 在意图层就是 `false`，`applyFast(false)` 会覆盖默认档里的 `true`。

防御性再改 `resolveModelParams` 的基线拷贝：默认 variant 里，**客户端/网关没表态的维不要拷**。

- `intent.fast === undefined` → 跳过 id 匹配 `/fast/i` 的项
- `intent.maxMode === undefined` → 跳过 `MAX_MODE_PARAM` 的项（context / maxMode / 1m）
- thinking / effort / 其它参数照旧拷，避免「只发部分参数掉到第一允许值」

两层一起做的原因：只改意图、不改拷贝，将来任何路径再留下 `fast === undefined`（测试、admin test、漏传 model）Composer 仍会漏；只改拷贝、意图仍是 undefined，则出站省略 `fast`，上游 Composer 仍按默认档 Fast 计费。

`hasSemantic` 在 `passthrough` 下会因 `false` 为真而走解析——这是我们要的，因为必须把 `fast=false` 写出去。

## 4. 后台 UI

对照已有的 HTTP/1.1 三态 `<select>`，不要再上 checkbox。

运行设置里 Fast / Max Mode 各一块：

1. 下拉：透传客户端（默认不加速） / 全部支持的模型强制开启 / 仅下列模型强制开启
2. 第三档才显示勾选列表（目录过滤 + 手动添加），交互抄 `openScopeModal` 的 checkbox 列表，但只是单列「强制开启」，没有黑名单。
3. hint（短）：
   - Fast：Composer / Grok 目录默认档就是 Fast；选「透传」时网关会下发 `fast=false`，否则客户端没写也会按 Fast 计费。请求里显式指定仍以客户端为准。
   - Max Mode：Claude / GPT 目录默认档常为 1M；「透传」会下发最小 context。GPT 的 1M 与 Fast 不能共存时 Max Mode 优先。

保存 payload 带四个新字段。`force-selected` 但列表为空时允许保存（≡透传），不要 400。

## 5. 实施顺序

单 PR 即可，按层落地、每层可测：

1. **纯函数**：`policyIntent`、env/旧键迁移、`resolveModelParams` 基线跳过未表态维。单测不启服务。
2. **配置/落库**：`GatewayConfig`、`gateway-settings.ts`、`config.ts`、`index.ts` 启动加载。
3. **请求路径**：`server.ts` `requestModelControls(model)`、`admin.ts` 测试与 settings API、catalogue 带 parameters。
4. **UI**：`admin-ui.ts` 下拉 + 条件列表。
5. **文档**：`.env.example` 注释；运行设置旁 hint。

### 5.1 主要改动文件

- `src/types.ts` — 策略类型，替换两个可选布尔
- `src/gateway-settings.ts` — 读写新键 + 迁移
- `src/config.ts` — 解析 `CURSOR_FAST` / `CURSOR_MAX_MODE` 及 `*_MODELS`
- `src/index.ts` — 启动加载
- `src/model-params.ts` — 基线拷贝跳过；导出 `policyIntent`（或新建 `src/model-param-policy.ts` 避免该文件再胀）
- `src/server.ts` — 按模型套策略
- `src/admin.ts` / `src/admin-ui.ts` — API + 三态 UI + catalogue parameters
- `.env.example`
- `tests/server.test.ts` — 替换布尔 settings 用例；补 Composer 回归

### 5.2 必须锁死的测试

1. Composer 目录默认档 `fast=true` + 策略 `passthrough` + `maxMode` 强制 → 出站 `fast=false`（本 bug 的最小复现）。
2. 同上 + 请求 `fast: true` / `:fast` → 出站 `fast=true`（客户端覆盖）。
3. `force-all` + Composer → `fast=true`（旧「勾上」）。
4. `force-selected` 仅 `composer-2.5`：该模型 true，`claude-opus-4-8` 出站 `fast=false`（默认档虽是 false，断言的是策略 false 而不是「碰巧拷了默认档」）。
5. 旧库 `cursorFastDefault=on` 启动后策略为 `force-all`；`off` 启动后为 `passthrough`。
6. GPT `force-all` Fast + `force-all` Max Mode → 仍降 Fast 保 1M（现有冲突测试保留）。
7. 管理 API 回显四个新字段，不再把 `passthrough` 显示成 `cursorFast: false` 那种「关了其实不管」。
8. 原「关 Fast 后 `lastInput.fast === undefined`」作废：透传时意图层应是 `false`，并且要断言 **resolved params**，不能只断言 intent。

## 6. 否决的替代

| 方案 | 否决原因 |
|---|---|
| 只把 off 改成 `fast=false`，UI 仍是 checkbox | 满足「一般不用 Fast」，但没有「只给某几个模型强制 Fast」；Max Mode 同理。用户点名要第三档。 |
| 真三态含「省略参数、让上游默认档生效」 | Composer/Grok 上游默认就是 Fast，等于把 bug 做成一档。 |
| 按模型存独立布尔表（每个模型一行 Fast/MaxMode） | 与已有 settings 键模型不一致；目录一抖就出现幽灵行。策略 + id 名单够用。 |
| 用模型 id 后缀代替后台（人人写 `:slow`） | 客户端（Claude Code）管不了；网关默认必须自己把 false 发出去。 |
| 改 `CURSOR_MODEL_PARAMS=fast=false` 当全局默认 | 优先级最高，客户端再也开不了 Fast，和「需要提供」相反。 |
| Fast 与 Max Mode 合成一个控件 | 用户现在 Max Mode 开、Fast 关，两维本来就该独立。 |

## 7. 验收

- 后台 Fast = 透传、Max Mode = 全部强制（迁移后你的现网形状）：Composer 请求日志 Fast 为否且无 `?`；Max Mode 在支持的模型上为是。
- 同一客户端给 Composer 发 `fast: true` 或 `composer-2.5:fast`：该条为 Fast，其它条仍否。
- 切到「仅下列模型」只勾 Grok：Grok Fast、Composer 否。
- GPT 同时强制 1M 与 Fast：日志里 Fast 被互斥打成否，dropped 有说明（现行为）。
- 重启进程后策略与勾选名单仍在。
