# Docker Composer API

独立的 Docker 部署版 Cursor Composer API 网关，提供 OpenAI 和 Anthropic 兼容接口，内置多 key 池与 Web 管理后台。

## 功能

- OpenAI Chat Completions / Responses、Anthropic Messages 三种协议兼容
- 模型参数透传：Claude Code 的 thinking、Codex 的 reasoning effort、1M 上下文（Max Mode）等自动映射为 Cursor `model.params`
- Cursor key 池：多 key 顺序取用，额度不足/key 失效自动禁用并切换下一个；额度恢复后在后台手动重新启用
- `/admin` Web 管理后台：key 增删启停、请求日志、用量统计、联通性测试
- 请求日志落 SQLite（保留最近 5000 条）

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
- `CURSOR_SDK_DISABLE_SESSION_RESUME=true`（默认）时，每次 API 请求都创建 fresh Cursor SDK agent，不恢复旧 agent。OpenAI/Anthropic 客户端本身会把上下文放在请求里，这个模式能避免服务运行一段时间后旧 SDK 会话/远端 agent 状态污染，导致所有请求持续 502。
- `CURSOR_SDK_USE_HTTP1_FOR_AGENT=true` 时，强制 Cursor local agent backend streams 使用 HTTP/1.1 + SSE，可用于代理/网络环境不兼容 HTTP/2 的排查。

Web 管理后台 key 池示例：

![Web 管理后台 key 池](docs/images/cursor-admin-key-pool.png)

### 2. 启动 Docker 服务

`docker-compose.yml` 默认加入外部网络 `shared_proxy`，首次部署先创建一次：

```bash
docker network create shared_proxy
docker compose up --build -d
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
- `GET /admin`（管理后台页面）
- `/admin/api/*`（管理 API，Bearer `ADMIN_PASSWORD` 鉴权）

## 运行

compose 使用外部共享网络 `shared_proxy`（用于挂接反向代理），首次部署需先创建：

```bash
docker network create shared_proxy
cp .env.example .env
docker compose up --build -d
```

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
claude-opus-4-8@1m:xhigh          # @1m 开 Max Mode，:xhigh 思考强度
gpt-5.5@1m:high#fast=false        # #id=value 显式 model.params
claude-opus-4-8[thinking=true,context=1m,effort=xhigh]   # ACP 风格显式参数
composer-2.5:fast                 # fast 变体
```

请求头（适合能配自定义 header 的客户端）：`x-cursor-reasoning-effort`、`x-cursor-max-mode`、`x-cursor-fast`、`x-cursor-mode`（agent/plan）、`x-cursor-model-params`。

环境变量默认值（客户端未显式指定时生效）：`CURSOR_REASONING_EFFORT`、`CURSOR_MAX_MODE`、`CURSOR_FAST`、`CURSOR_MODEL_PARAMS`、`CURSOR_AGENT_MODE`。

优先级（低 → 高）：env 默认 < 请求头 < 请求体语义字段 < 模型 id 后缀 < 显式 `model_params`。

说明：

- 映射基于 `Cursor.models.list()` 返回的该模型参数定义与默认 variant（补全默认参数组合，避免只发部分参数时其余参数掉到首个允许值）；目录发现失败时按模型家族已知惯例兜底映射，命中不了的意图会记入服务日志（`[model-params]`）而不是静默丢弃。
- `GET /v1/models` 会在每个模型上返回 `cursor_parameters`（参数定义）与 `cursor_variants`（预设组合），可用来确认某模型支持哪些参数与取值。
- `temperature` / `top_p` / `max_tokens` 等采样参数 Cursor SDK 不支持，仅作为提示词附注传递。

## 多 key 自动切换

- 网关模式按管理后台设置的顺序使用第一个 `active` 的 key（后台可随时用 ↑↓ 调整优先级）
- 上游返回额度不足（usage limit / quota / 402 等）或 key 无效（401 / invalid api key）时：自动禁用该 key 并立即换下一个重试，客户端无感
- 全部 key 不可用时所有 API 请求统一返回 `429 insufficient_quota`（无有效 key）
- 禁用的 key 不会自动恢复；确认额度恢复后在管理后台手动「启用」
- 临时性 429 rate limit 不会触发禁用

## 管理后台

浏览器打开 `http://127.0.0.1:8787/admin`，使用 `ADMIN_PASSWORD` 登录（未设置时退回 `GATEWAY_API_KEY`；两者都为空则后台禁用）。

功能：服务状态与用量统计、key 池管理（添加/启用/禁用/删除/排序，key 仅显示掩码）、最近请求日志、真实联通性测试。

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
