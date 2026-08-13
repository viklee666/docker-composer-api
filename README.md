# Docker Composer API

独立的 Docker 部署版 Cursor Composer API 网关，提供 OpenAI 和 Anthropic 兼容接口，内置多 key 池与 Web 管理后台。

## 功能

- OpenAI Chat Completions / Responses、Anthropic Messages 三种协议兼容
- 真·逐 token 流式：消费 Cursor SDK 的 `onDelta` 回调；带 tools 的请求（如 Claude Code 全部请求）也乐观流式输出，只暂扣可能是 `<tool_call>` 标记前缀的尾部
- 思考过程透传：Anthropic 端点输出 `thinking_delta` 内容块（仅在客户端请求思考时），OpenAI Chat 端点输出 `reasoning_content` 增量，Responses 端点输出 `reasoning` output item 与 `reasoning_summary_text` 事件，消除思考期的长时间静默
- 工具调用按 Anthropic 官方语义流式下发（`tool_use` 的 start `input` 为 `{}`、参数经 `input_json_delta`），Claude Code 等严格实现的客户端不再读到空参数
- 模型参数透传：Claude Code 的 thinking、Codex 的 reasoning effort、1M 上下文（Max Mode）等自动映射为 Cursor `model.params`；实际下发的参数会打 `[model-params] sending params` 日志便于核对
- 默认用 SDK（>=1.0.27）的内置工具限制阻止 Cursor agent 在网关容器里执行 shell/edit，防止与客户端工具双重执行
- Cursor key 池：多 key 顺序取用，额度不足/key 失效自动切换下一个；连续失败到阈值才自动禁用（阈值可调，也可整个关掉），额度恢复后在后台手动重新启用
- `/admin` Web 管理后台：key 增删启停、请求日志、用量统计、联通性测试
- 请求日志落 SQLite（保留约 5000 条，批量裁剪）

## 快速开始

### 1. 准备配置

复制环境变量模板，并至少填写 `CURSOR_API_KEYS`、`GATEWAY_API_KEY`：

```bash
cp .env.example .env
```

`.env` 最小配置示例：

```env
CURSOR_API_KEYS=cursor-key-1,cursor-key-2
GATEWAY_API_KEY=change-me-to-a-long-random-token
ADMIN_PASSWORD=change-me-to-an-admin-password
ALLOW_DIRECT_CURSOR_KEYS=true
```

- `CURSOR_API_KEYS` 是服务端 Cursor key 池，多个 key 用逗号、分号或换行分隔；也可以启动后在 Web 管理后台添加。
- `GATEWAY_API_KEY` 是客户端调用本项目 API 时使用的网关 key。
- `ADMIN_PASSWORD` 是 `/admin` 后台密码；留空时会退回使用 `GATEWAY_API_KEY`。
- `ALLOW_DIRECT_CURSOR_KEYS=true` 时，也允许客户端直接把 Cursor key 当作 API key 传入。
- `CURSOR_SDK_DISABLE_SESSION_RESUME=true`（默认）时，每次 API 请求都创建 fresh Cursor SDK agent，不恢复旧 agent。OpenAI/Anthropic 客户端本身会把上下文放在请求里，这个模式能避免服务运行一段时间后旧 SDK 会话/远端 agent 状态污染，导致所有请求持续 502。该模式下并发请求不加会话锁，可以真正并行；同时网关会给每个 agent 注入共享的有界内存 agent store（自动按闲置时间 + LRU 回收），规避 SDK 默认按 agent 各开一份 SQLite 存储导致的句柄随请求数线性泄漏、长期运行后拖垮进程的问题。
- `CURSOR_SDK_USE_HTTP1_FOR_AGENT=true` 时，强制 Cursor local agent backend streams 使用 HTTP/1.1 + SSE，可用于代理/网络环境不兼容 HTTP/2 的排查。
- `CURSOR_ALLOW_BUILTIN_TOOLS=false`（默认）时，通过 SDK 的 `tools` 限制禁止 Cursor agent 在网关容器内使用内置工具（shell/edit/grep 等）：无客户端工具的请求为纯文本模式，有客户端工具的请求只保留 MCP 元工具通道。
- SSE 响应带 `x-accel-buffering: no`；用 Nginx 反代时仍建议显式配置 `proxy_buffering off`，否则流式会被反代攒成大块。

Web 管理后台 key 池示例：

![Web 管理后台 key 池](docs/images/cursor-admin-key-pool.png)

### 2. 启动 Docker 服务

```bash
docker compose up --build -d
```

compose 只用项目自带的默认网络，不需要预先创建任何 docker network。若要把网关挂到宿主机上已有的共享反代网络，叠加 `docker-compose.shared-proxy.yml`（网络名默认 `shared_proxy`，可用 `PROXY_NETWORK` 覆盖）：

```bash
docker network create shared_proxy   # 仅首次，已存在则跳过
docker compose -f docker-compose.yml -f docker-compose.shared-proxy.yml up --build -d
```

本机验证：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $GATEWAY_API_KEY"
```

默认端口只绑定宿主机 `127.0.0.1:8787`。如果要从另一台电脑访问，推荐用同一 Docker 网络里的 Nginx/Caddy 反代到 `http://composer-api:8787` 并启用 HTTPS；仅内网测试时也可以把 compose 端口映射改成 `"${PORT:-8787}:8787"`。

### 3. 调用 OpenAI 兼容接口

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

### 4. 配置 Claude Code 走本项目网关

本项目实现了 Anthropic Messages 兼容接口，Claude Code 可通过 `ANTHROPIC_BASE_URL` 指向网关。`ANTHROPIC_AUTH_TOKEN` 会以 `Authorization: Bearer ...` 发送，正好对应 `GATEWAY_API_KEY`。

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN = "<GATEWAY_API_KEY>"
$env:ANTHROPIC_MODEL = "composer-2.5"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
claude
```

Bash / Zsh：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="<GATEWAY_API_KEY>"
export ANTHROPIC_MODEL="composer-2.5"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

远程服务器部署时，把 `ANTHROPIC_BASE_URL` 改成你的反代地址，例如 `https://composer-api.example.com`。进入 Claude Code 后可运行 `/status`，确认 `Anthropic base URL` 指向本项目网关。

### 5. 管理后台

浏览器打开：

```txt
http://127.0.0.1:8787/admin
```

使用 `ADMIN_PASSWORD` 登录，可管理 key 池、查看请求日志、调整 key 顺序和做联通性测试。

## 支持的端点

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `DELETE /v1/responses/:id`
- `GET /v1/responses/:id/input_items`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`（按合成 prompt 估算 `input_tokens`，与真实请求的 usage 同口径；不消耗上游额度）
- `GET /admin`（管理后台页面）
- `/admin/api/*`（管理 API，Bearer `ADMIN_PASSWORD` 鉴权）

## 运行

```bash
cp .env.example .env
docker compose up --build -d
```

默认只用 compose 自建的项目网络，无需预先创建 docker network。需要挂接已有的共享反代网络时，见上文的 `docker-compose.shared-proxy.yml` 叠加用法。

服务默认监听：

```txt
http://127.0.0.1:8787
```

## 鉴权

服务支持两种模式：

1. 服务端 key 池：`.env` 配置 `CURSOR_API_KEYS`（多个用逗号分隔）和 `GATEWAY_API_KEY`，客户端传 `Authorization: Bearer <GATEWAY_API_KEY>`，网关按顺序使用池中第一个可用 key。
2. 客户端直传：客户端传 `Authorization: Bearer <Cursor API Key>` 或 `x-api-key: <Cursor API Key>`。可用 `ALLOW_DIRECT_CURSOR_KEYS=false` 禁用。

## 模型参数透传（思考强度 / Max Mode / fast）

按 Cursor SDK 官方做法（`Cursor.models.list()` 发现参数定义与 variants，选好的值放进 `model.params`），网关把客户端的语义参数自动映射为该模型真实支持的 Cursor 参数：

| 客户端写法 | 映射结果 |
| --- | --- |
| Claude Code：`thinking: {type:"enabled", budget_tokens:N}` / `{type:"adaptive"}` / `output_config.effort` | Claude 系 → `thinking=true` + `effort=<就近档位>`（adaptive 保留模型默认强度） |
| Codex / OpenAI：`reasoning_effort: "high"`、`reasoning: {effort:"xhigh"}` | GPT/Codex 系 → `reasoning=<就近档位>`，Claude 系 → `thinking+effort` |
| Anthropic 1M beta 头：`anthropic-beta: context-1m-...` | `context=1m`（即 Cursor Max Mode 大上下文档位） |
| 请求体：`max_mode: true` / `fast: true` / `model_params: "id=value,..."` | 对应参数（`model_params` 原样透传，优先级最高） |

模型 id 后缀（适合只能改模型名的客户端，如 `ANTHROPIC_MODEL`）：

```txt
claude-opus-4-8[1m]               # 方括号后缀（Claude Code 原生写法），[1m] 开 Max Mode
claude-opus-4-8[1m,xhigh,fast]    # 方括号里可组合：1m=Max Mode、xhigh=思考强度、fast
claude-opus-4-8@1m:xhigh          # @1m 开 Max Mode，:xhigh 思考强度
gpt-5.5@1m:high#fast=false        # #id=value 显式 model.params
claude-opus-4-8[thinking=true,context=1m,effort=xhigh]   # ACP 风格显式参数
composer-2.5:fast                 # fast 变体
```

请求头（适合能配自定义 header 的客户端）：`x-cursor-reasoning-effort`、`x-cursor-max-mode`、`x-cursor-fast`、`x-cursor-mode`（agent/plan）、`x-cursor-model-params`。

环境变量默认值（客户端未显式指定时生效）：`CURSOR_REASONING_EFFORT`、`CURSOR_MAX_MODE`、`CURSOR_FAST`、`CURSOR_MODEL_PARAMS`、`CURSOR_AGENT_MODE`。

优先级（低 → 高）：env 默认 < 请求头 < 请求体语义字段 < 模型 id 后缀 < 显式 `model_params`。

### Claude Code 的 Max Mode / 1M 特别说明

Claude Code 指向自定义 `ANTHROPIC_BASE_URL` 时**不会**发送 `anthropic-beta: context-1m` 头（[claude-code#68522](https://github.com/anthropics/claude-code/issues/68522) 已确认），`/model` 里选的 `opus[1m]` 也不会保留。所以只在 Claude Code 界面里选 1M，网关收不到 Max Mode 信号，计费不会按 Max Mode 计。

可靠做法是用 `ANTHROPIC_MODEL` 带 `[1m]` 后缀（Claude Code 在网关模式下会把它原样透传进请求体 model 字段，本网关会识别为 Max Mode）：

```powershell
$env:ANTHROPIC_MODEL = "gpt-5.6-sol[1m]"   # 或 claude-sonnet-5[1m] 等带 context 参数的模型
```

注意：

- Max Mode 需要模型本身带 `context` 参数（claude 系、gpt-5.x 系等）。`composer-2.5` 只有 `fast`、**没有 context 档位，无法开 Max Mode**，带 `[1m]` 也会被忽略。
- 想全局强制开启，也可以在网关侧设 `CURSOR_MAX_MODE=true`（对所有请求生效）。
- 用 `GET /v1/models` 看某模型的 `cursor_parameters` 是否包含 `context`，即可判断它能否 Max Mode。

说明：

- 映射基于 `Cursor.models.list()` 返回的该模型参数定义与默认 variant（补全默认参数组合，避免只发部分参数时其余参数掉到首个允许值）；目录发现失败或目录条目缺参数定义时按模型家族已知惯例兜底映射，命中不了的意图会记入服务日志（`[model-params]`）而不是静默丢弃；实际下发的参数也会打 `[model-params] sending params` 日志（同组合 10 分钟内一条）。
- 模型目录缓存 10 分钟；请求了缓存里没有的模型会立刻强刷一次目录（30 秒限频），新上线的模型无需等缓存过期。
- 上游 run 失败时透传 SDK（>=1.0.23）的结构化错误详情；命中区域限制（如 "This model provider is not supported in your region"，Claude 系模型在部分出口区域不可用）时返回 403 `model_unavailable` 并附原文，而不是笼统的 502。命中上游按 key 限速（如 get_models 每分钟 30 次，单 key 并发突发时常见）时返回 429 `rate_limit_exceeded`，客户端可按标准语义退避重试。
- 所有对上游 SDK 的调用（agent 创建、发送、目录拉取、结果等待）都与请求级超时/断连信号竞速：即使上游传输层完全挂死（不返回也不报错），请求也会在 `REQUEST_TIMEOUT_MS`（空闲超时）内以 504 收尾并释放资源，不会永久悬挂堆积拖垮服务器；取消/释放等清理调用另有 5 秒上限，清理挂死不会阻塞请求收尾。
- `GET /v1/models` 会在每个模型上返回 `cursor_parameters`（参数定义）与 `cursor_variants`（预设组合），可用来确认某模型支持哪些参数与取值。

## 能力边界

对外 wire format 按 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 官方规范实现，但受 Cursor SDK 上游能力限制，以下行为无法真正生效或只能近似：

- **采样与长度参数不生效**：`temperature` / `top_p` / `max_tokens`（含 `max_completion_tokens` / `max_output_tokens`）/ `stop` / `response_format` / `text.format` 等 Cursor SDK 不支持。网关接受这些字段并在 Responses 快照里原样回显，但不会改变生成行为，也不会作为提示词附注注入 prompt。
- **usage 是估算值**：Cursor SDK 不透出 token 计数，所有 `usage` 字段按字符数 / 4 估算（Responses 的 `reasoning_tokens` 同样按思考文本估算并计入 `output_tokens`）。**仅供粗略参考，不可用于计费或配额核算**，请以 Cursor 官方仪表盘为准。
- **thinking 签名不可跨 provider 校验**：Anthropic 端点的 thinking 块带的是网关按块随机生成的不透明 `signature`（上游不提供真实签名）。它只保证严格客户端能正常收块，**回传给 Anthropic 官方 API 无法通过校验**；本网关自己也不校验客户端回传的签名，历史 thinking 块不会进入合成 prompt。thinking 块仅在客户端显式请求思考（`thinking` 字段 / `reasoning_effort` / 模型 id 思考强度后缀）时输出；`thinking:{type:"disabled"}` 或 `thinking.display:"omitted"` 时不回传思考内容（但思考强度仍照常下发给上游）。
- **stop_reason 只有 `end_turn` / `tool_use`**：上游不区分 `max_tokens` / `stop_sequence` 等终止原因。
- **Anthropic `max_tokens` 缺失只记日志不拒绝**：官方要求必填，这里为兼容宽松客户端放行（该参数本来也不生效）。
- **不支持的内容与工具**：Anthropic `document` / PDF 内容块返回 400（上游只接受文本与图片，请客户端侧抽取文本后作为 text 块发送）；`n>1`、`audio`、`modalities`、内置工具（web search 等）明确 400 或忽略；`logprobs: true` 返回 400（`logprobs: false` 与 `top_logprobs` 接受但不生效）。

## 多 key 自动切换

- 网关模式按管理后台设置的顺序使用第一个 `active` 的 key（后台可随时用 ↑↓ 调整优先级）
- 上游返回额度不足（usage limit / quota / 402 等）或 key 无效（401 / invalid api key）时：立即换下一个 key 重试，客户端无感；同一个 key **连续**失败到阈值（默认 2 次）才会被自动禁用
- 成功一次即清零该 key 的连续失败计数，偶发抖动不会累积成禁用；后台「启用」也会清零，不会刚启用就被上一次的旧错误再禁掉
- 不想让网关碰 key 的启停状态：后台「运行设置」关掉自动禁用（或 `AUTO_DISABLE_KEYS=false`），出错的 key 只本次跳过，永不自动停用
- 以下情况只换 key、从不计入自动禁用：上游无详情的 run error、Cursor 会话态认证抖动（`Authentication error ... try logging out and back in`，这不代表 key 失效）
- 临时性 429 rate limit 既不换 key 也不禁用，原样按 429 透出让客户端退避
- 全部 key 都被禁用时所有 API 请求统一返回 `429 insufficient_quota`（无有效 key）；只是软失败没被禁用时，透出的是上游真实错误
- 禁用的 key 不会自动恢复；确认额度恢复后在管理后台手动「启用」

## 管理后台

浏览器打开 `http://127.0.0.1:8787/admin`，使用 `ADMIN_PASSWORD` 登录（未设置时退回 `GATEWAY_API_KEY`；两者都为空则后台禁用）。

功能：服务状态与用量统计、key 池管理（添加/启用/禁用/删除/排序，key 仅显示掩码）、自动禁用策略（开关 + 连续失败阈值，改完即时生效并持久化）、最近请求日志、真实联通性测试。

## 示例

OpenAI Chat Completions：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

OpenAI Responses：

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","input":"Write a short TypeScript debounce."}'
```

Anthropic Messages：

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $GATEWAY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

## 本地验证

```bash
npm install
npm run typecheck
npm test
npm run build
```
