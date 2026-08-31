# Docker Composer API

独立的 Docker 部署版 Cursor Composer API 网关，提供 OpenAI 和 Anthropic 兼容接口，内置多 key 池与 Web 管理后台。

## 功能

- OpenAI Chat Completions / Responses、Anthropic Messages 三种协议兼容
- 真·逐 token 流式：消费 Cursor SDK 的 `onDelta` 回调；带 tools 的请求（如 Claude Code 全部请求）也乐观流式输出，只暂扣可能是 `<tool_call>` 标记前缀的尾部
- 思考过程透传：Anthropic 端点输出 `thinking_delta` 内容块（仅在客户端请求思考时），OpenAI Chat 端点输出 `reasoning_content` 增量，Responses 端点输出 `reasoning` output item 与 `reasoning_summary_text` 事件，消除思考期的长时间静默
- 工具调用按 Anthropic 官方语义流式下发（`tool_use` 的 start `input` 为 `{}`、参数经 `input_json_delta`），Claude Code 等严格实现的客户端不再读到空参数
- 模型参数透传：Claude Code 的 thinking、Codex 的 reasoning effort、1M 上下文（Max Mode）等自动映射为 Cursor `model.params`；实际下发的参数会打 `[model-params] sending params` 日志便于核对
- 默认用 SDK（>=1.0.27）的内置工具限制阻止 Cursor agent 在网关容器里执行 shell/edit，防止与客户端工具双重执行
- Cursor key 池：多 key 取用（默认 fill-first，可切加权轮询），额度不足/key 失效自动切换下一个；连续失败到阈值才自动禁用（阈值可调，也可整个关掉），额度恢复后在后台手动重新启用
- **每个 key 可限定可用模型**（白名单 / 黑名单），`/v1/models` 只列出当前请求真能被服务的模型
- **会话粘性**：同一会话固定复用上次成功的 key，保住 Cursor 侧按 key 的 prompt 缓存；绑定的 key 不可用时自动回退
- **多个对外网关密钥**：每个密钥可限定只能用哪几把 Cursor key、只能用哪些模型
- **用 cursor.com 会话 token 直接铸 API key**，无需手动去网页复制
- **出站代理**（http / https / socks5 / socks5h / socks4），大陆网络访问外国模型用
- **默认系统提示词**（追加 / 覆盖），每个请求都会注入
- **token 用量与花费**：优先从 SDK usage 事件取真实值；缺少上游用量时按字符估算并明确标记，金额带外补写
- `/admin` Web 管理后台：左侧导航栏布局，key 池 / 网关密钥 / 取用策略 / 系统提示词 / 代理 / 请求历史 / 联通性测试
- 请求历史落 SQLite（默认全量留存，`REQUEST_LOG_KEEP` 可设上限），后台可翻页并按 key、网关密钥、模型、成败、时间过滤

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
- `CURSOR_SDK_USE_HTTP1_FOR_AGENT=true` 时，强制 Cursor local agent backend streams 使用 HTTP/1.1 + SSE，可用于代理/网络环境不兼容 HTTP/2 的排查。**建议留空**：配了 `PROXY_URL` 时它会被自动打开（HTTP/2 不支持代理），显式写 `false` 才会让模型流量在有代理时继续直连，详见[出站代理](#出站代理)。注意后台「运行设置」里选过强制态就会落库，落库的值优先级高于这个环境变量——想让环境变量重新说了算，把那个下拉框选回「未设置」。
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
- `/admin/api/*`（管理 API，Bearer `ADMIN_PASSWORD` 鉴权）：`overview`、`models`、`settings`、`proxy` + `proxy/test`、`keys` + `keys/mint` + `keys/:id/{enable,disable,channel,models,weight}` + `keys/reorder`、`gateway-keys` + `gateway-keys/:id{,/enable,/disable}`、`logs`（翻页/过滤）+ `logs/clear`、`test`

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

### 请求历史默认全量留存

`REQUEST_LOG_KEEP` 控制请求历史的保留条数，**默认 0 = 不裁剪**：这条要求就是「记录所有历史」，所以网关不替你决定丢哪一条。代价是状态库会随请求量无界增长（每条记录约 1KB，含用量、金额与模型参数快照），长期高频跑的部署请设一个上限（如 `REQUEST_LOG_KEEP=200000`），或定期在后台「请求历史」里清空。设了上限后每插入 100 条会裁剪一次，只保留最新的那些；启动时也会按当前上限先裁一次积压，所以把上限调小是立即生效的。

### SQLite 文件要按密钥库来保护

Cursor key 和入站网关密钥都**明文**存在 `SQLITE_PATH` 指向的那个文件里。Cursor key 必须是明文——它要原样发给上游；所以这个库无论如何都是一份密钥库，请按密钥库的标准对待：文件权限收紧、挂载卷不要跟着代码仓库走、备份要加密。

入站网关密钥没有改成哈希存储，这是明确的取舍而不是遗漏：拿到这个库的攻击者手里已经有全部 Cursor key，能直接花你的额度，此时再去猜入站密钥没有意义；而只哈希入站密钥要动十来处调用点加一次迁移，换来的防护面很窄。后台永远只回显掩码（完整密钥仅在创建响应里出现一次），所以泄露面主要就是这个文件本身。

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
- **usage 优先用上游真值，拿不到才估算**：SDK（>=1.0.27）会在每轮结束时上报真实 token 数（input / output / cache read / cache write / reasoning），网关直接透出，并按各家规范填到对应字段（OpenAI 的 `prompt_tokens_details.cached_tokens`、Anthropic 的 `cache_read_input_tokens` 等）。上游没上报的请求才退回按字符数 / 4 估算；请求历史里用 `usageSource` 区分 `sdk`（真值）与 `estimated`（估算），不会把估算值伪装成实测值。标 `estimated` 的行一定带着真实的估算数字；连估都估不出来的请求（比如上游立刻报错、根本没有产出）则一个用量字段都不写，也不会声称自己是估算。
- **花费金额是最终一致的旁路数据**：金额由 Cursor 服务端算，`agent.getUsage()` 在 run 刚结束时往往还查不到，因此网关把它放进带外队列延迟补写，绝不拖慢响应。网关模式按跑这次请求的那把 key 回查，客户端直传模式则用客户端自己那把 key；两条路径都会尝试补写，但上游不可达、进程被强杀或计费读数在有限轮询后仍未包含本次 run 时，不能承诺单行一定有金额。队列不设置会静默丢钱的固定条数上限，极端积压的实际约束是进程内存；收到关停信号后会先停止接收新请求，等在途请求跑完，再停止新调度并等待已接受的任务，最多等 30 秒——超时会放弃剩余补写并在日志里打出放弃的条数，因为让 SIGTERM 无限期挂着比丢几笔旁路金额更糟。每条任务默认最多轮询 3 次，单次 `getUsage` 最多等 10 秒，退避单次最多 60 秒。注意 `chargedCents` 对套餐内 / BYOK / 赠额用量本来就是 0，**看到 0 是正常结果而不是没记上**；`Cursor.models.list()` 也不返回价格表，所以网关不会自己编价格算钱。要精确对账仍请以 Cursor 官方仪表盘为准。
- **金额按 agent 记增量，摊不回具体某一次 run**：`agent.getUsage()` 给的是整个 agent 的累计值。关掉 `CURSOR_SDK_DISABLE_SESSION_RESUME` 后一个 agent 会服务多个请求，网关按 agentId 记住上次记过的累计值（落库，重启也不丢），只把新增的那部分写进当前这条日志；基线推进与金额写入在同一事务里，写入失败不会吞掉基线。若累计值相对基线没有新增，网关会继续有限轮询而不是把旧值当成本次完成；即使观察到新增，也无法从累计接口证明它一定属于当前 run。因此同一 agent 上并发结束的两个请求可能一条拿到全部增量、另一条拿到 0——**单行金额是个近似，按 key / 按时间段的合计才是准的**。
- **请求 token 与 agent 累计值分开**：请求路径捕获的本轮 SDK 用量才会写入对应日志；后台回查到的 agent 累计 usage 不会覆盖已有的单次 telemetry，也不会在没有本轮证据时冒充单次用量。概览把上游实测 token 与字符估算 token 分开统计。
- **thinking 签名不可跨 provider 校验**：Anthropic 端点的 thinking 块带的是网关按块随机生成的不透明 `signature`（上游不提供真实签名）。它只保证严格客户端能正常收块，**回传给 Anthropic 官方 API 无法通过校验**；本网关自己也不校验客户端回传的签名，历史 thinking 块不会进入合成 prompt。thinking 块仅在客户端显式请求思考（`thinking` 字段 / `reasoning_effort` / 模型 id 思考强度后缀）时输出；`thinking:{type:"disabled"}` 或 `thinking.display:"omitted"` 时不回传思考内容（但思考强度仍照常下发给上游）。
- **stop_reason 只有 `end_turn` / `tool_use`**：上游不区分 `max_tokens` / `stop_sequence` 等终止原因。
- **Anthropic `max_tokens` 缺失只记日志不拒绝**：官方要求必填，这里为兼容宽松客户端放行（该参数本来也不生效）。
- **不支持的内容与工具**：Anthropic `document` / PDF 内容块返回 400（上游只接受文本与图片，请客户端侧抽取文本后作为 text 块发送）；`n>1`、`audio`、`modalities`、内置工具（web search 等）明确 400 或忽略；`logprobs: true` 返回 400（`logprobs: false` 与 `top_logprobs` 接受但不生效）。
- **宿主元工具不转发、不注册**：Claude Code 等宿主的 `GetMcpTools` / `CallMcpTool` / `Task` 等元工具不会经网关转发给上游，也不注册为 Cursor `customTools`，避免内层再演工具发现或子代理套娃。
- **SDK `task` 里程碑不下发**：Cursor SDK 的 `task` 事件只是里程碑/摘要，不会作为助手正文发给客户端。
- **短仪式句不回灌 prompt**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 三条协议都会丢掉历史 assistant 里的短仪式句（如「对齐 schema」「搜到工具了」），以及 GetMcpTools / Task 等元工具的历史调用与结果。清洗后既无正文也无保留工具调用的空轮整段省略，不会写出 `ASSISTANT: [empty]`。Responses 的 `previous_response_id` 整包转储只清洗写入 prompt 的副本、不改已存快照；续轮里对应 GetMcpTools 的 follow-up `function_call_output` 不回放，`input[]` 的 `reasoning` 项也不注入下一轮 prompt。
- **不恢复 SDK session resume**：默认仍为 `CURSOR_SDK_DISABLE_SESSION_RESUME=true`，每次请求新建 agent，不把 `tool_result` 送回同一 `Run`。

## 多 key 自动切换

- 网关模式按管理后台设置的顺序使用第一个 `active` 的 key（后台可随时用 ↑↓ 调整优先级）
- 上游返回额度不足（usage limit / quota / 402 等）或 key 无效（401 / invalid api key）时：立即换下一个 key 重试，客户端无感；同一个 key **连续**失败到阈值（默认 2 次）才会被自动禁用
- 成功一次即清零该 key 的连续失败计数，偶发抖动不会累积成禁用；后台「启用」也会清零，不会刚启用就被上一次的旧错误再禁掉
- 不想让网关碰 key 的启停状态：后台「运行设置」关掉自动禁用（或 `AUTO_DISABLE_KEYS=false`），出错的 key 只本次跳过，永不自动停用
- 以下情况只换 key、从不计入自动禁用：上游无详情的 run error、Cursor 会话态认证抖动（`Authentication error ... try logging out and back in`，这不代表 key 失效）
- 临时性 429 rate limit 既不换 key 也不禁用，原样按 429 透出让客户端退避
- 全部 key 都被禁用时所有 API 请求统一返回 `429 insufficient_quota`（无有效 key）；只是软失败没被禁用时，透出的是上游真实错误
- 禁用的 key 不会自动恢复；确认额度恢复后在管理后台手动「启用」
- 「选不到 key」会按真实原因区分状态码，而不是一律报额度耗尽：模型被可用范围挡掉是 **403 `model_not_allowed`**，网关密钥绑定的 key 全不可用是 **403 `not_authorized`**，确实没配 / 全禁用 / 轮换用尽才是 **429 `insufficient_quota`**

## 取用策略与会话粘性

后台「取用策略」页可改，改完即时生效并持久化。

| 策略 | 行为 | 何时用 |
| --- | --- | --- |
| `fill-first`（默认） | 按后台排序吃满第一个可用 key | 默认就该用这个 |
| `round-robin` | 按每个 key 的 `weight` 加权轮询 | 只在确实要摊平多账号用量时开 |

**为什么默认不轮询**：Cursor 按 key 缓存 prompt。换 key 就命中不到上一个 key 的缓存，长上下文会被重新完整计费一遍。轮询摊平的是「额度消耗速度」，代价是总消耗变多。

**会话粘性**（`SESSION_AFFINITY`，默认开）把同一会话钉在上次成功的那把 key 上，让后续请求继续命中上游缓存。会话身份优先取客户端显式的 session 头（`x-session-affinity`、`x-opencode-session-id`、`anthropic-session-id` 等），没有时再取 Responses 续聊继承的种子或当前请求的稳定对话前缀（system/developer + 第一条 user）；仍然认不出就不启用粘性，**不会退到鉴权身份**。绑定按 `SESSION_AFFINITY_TTL_MS`（默认 1 小时）过期；绑定的 key 被禁用、删除或不允许当前模型时自动回退到正常选 key，不会把请求卡死。

需要注意的副作用：粘性开着时，队首那把坏 key 失败一次后该会话就换到别的 key 了，它不会再从这个会话累积失败次数，因此可能长期停在「active 但 `lastError` 有红字」的状态。后台 key 列表里能看到，按需手动禁用。

## 每个 key 的可用模型

后台 key 池里每把 Cursor key 都能设白名单 / 黑名单（黑名单优先）。模型清单从 `Cursor.models.list()` 的完整目录里勾选，也支持手填目录里还没有的新模型 id。

供勾选的目录是**全池并集**：`GET /admin/api/models` 会把每把 active key 各自的目录合起来去重，而不是拿其中一把的当全局清单——不同账号 / 通道能看到的模型本来就不一样，只看一把会让另一把才有的模型永远勾不上。目录按 (key, 通道) 缓存 10 分钟，所以并集在缓存命中时只是几次内存查表；某把 key 拉取失败也只是少贡献几条，不影响其余 key。这份清单**刻意不做过滤**：它是设置白/黑名单的源，套上某把 key 的范围会让已被禁掉的模型从名单里消失，再也勾不回来。

`GET /v1/models` 只列出**当前请求真能被服务**的模型：既要过网关密钥自己的范围，也要求至少有一把该请求可用的 Cursor key 允许它。只在其中一把 key 上排除某模型时它仍然可见（因为别的 key 还能服务）；所有可用 key 都排除了才隐藏。请求一个被范围挡掉的模型返回 **403 `model_not_allowed`**，而不是笼统的 429。

## 对外网关密钥（多密钥）

`GATEWAY_API_KEY` 仍然可用，启动时会被播种进密钥表。此外后台「网关密钥」页可以加任意多个对外密钥，每个都能单独限定：

- **可用的 Cursor key**：留空表示可用整个池；绑定的 key 全被禁用时该密钥的请求返回 403 `not_authorized`（明确告诉你是绑定问题，而不是误报额度耗尽）
- **可用模型**：与 Cursor key 自身的范围叠加生效

新建密钥时可以让后台随机生成。**完整密钥只在创建响应里出现一次**，列表里一律只返回掩码，事后无法再取回。

### 绑定的 key 被删掉之后

删除某把 Cursor key 时，所有绑定过它的网关密钥会自动把它从绑定列表里剔除。**如果剔完一个都不剩，这把网关密钥会变成「什么都不能用」**，请求返回 403 `not_authorized`，后台列表里显示「已失效：绑定的 Cursor key 已删除」。

这不是 bug 而是刻意的：空列表的语义是「不限制」，如果删完直接留空，一把本来「只能用 key A」的密钥会在 A 被删后升级成「整个池都能用」——删 key 反而放大了权限。要恢复它，去后台「网关密钥 → 编辑」重新勾选可用的 key；确实想让它用整个池的话，编辑框里有一个显式的「解除限制」开关。**运维自己在后台清空勾选仍然表示「不限制」**，这条语义没变。

### env 播种的那把密钥不能删

来自 `GATEWAY_API_KEY` 的密钥（后台「来源」列显示 `env`）删不掉，`DELETE /admin/api/gateway-keys/:id` 会返回 409：删掉表里那行也没用——鉴权还有一条兼容旧版单密钥的分支会认环境变量里的值，而且下次重启 `seedFromEnv` 又会把它播种回来（还换个新 id）。真正有效的两条路是：

- 从环境变量里移除 `GATEWAY_API_KEY` 再重启；
- 或者直接**停用**它。停用是即刻生效的：鉴权在走兼容分支之前就会先看这条记录是不是 disabled，是就直接 401。

## 用会话 token 铸 Cursor API key

不想手动去 cursor.com 网页复制 key 时，后台 key 池页可以直接粘 `WorkosCursorSessionToken` 让网关替你铸一个：

1. 浏览器登录 cursor.com，从 cookie 里复制 `WorkosCursorSessionToken` 的值（形如 `user_01XXX::eyJ...`）
2. 后台「从会话 token 铸 key」里粘上，`name` 可选（不填自动生成）
3. 网关调 `POST https://cursor.com/api/dashboard/create-user-api-key` 铸一个新 key 并直接加进池

粘贴格式很宽松：整条 cookie 串、带引号、带结尾分号、`::` 被 URL 编码成 `%3A%3A` 都能识别。

**这个 token 是账号级凭据，比它铸出来的 API key 权限大得多。** 网关只在这一次请求里用它，不落库、不写日志、不回显；网关生成的错误信息会按已知 session-token 形状抹掉它。会话过期时返回 401 并提示重新复制（不跟随后台的登录页跳转，避免报成看不懂的「响应不是 JSON」）。

## 出站代理

`PROXY_URL` 或后台「代理设置」页配置，支持 `http` / `https` / `socks5` / `socks5h` / `socks4`，可带账号密码（`socks5://user:pass@host:1080`），只写 `host:port` 时按 `http://` 处理。只写用户名或只写密码也接受，两条链路会带上同一份 `Basic` 凭据（不会出现「REST 407、模型流量却通」这种半通状态）。

正常代理地址以及代理模块能识别的错误凭据会打码：掩码按 authority 里**最后**一个 `@` 切分，所以密码里带没转义的 `@` 也遮得干净；主机名认不出来的地址（多半是写错了）整条显示成 `***`——那种输入没有可信的凭据边界，必须按整条敏感数据处理。错误响应仍会截断，未知凭据格式不能承诺从任意第三方文本中完整识别出来。

**配上代理就够了，不需要再手动打开 HTTP/1.1。** SDK 有两条出站链路，网关会把两条都接管：

| 链路 | 承载 | 怎么被代理 |
| --- | --- | --- |
| 云端 REST（`api.cursor.com`，走全局 `fetch`） | 模型目录、账号信息、用量金额、铸钥 | undici 全局 dispatcher。`http` / `https` 用 undici 自带的 `ProxyAgent`；三种 SOCKS 走网关自己的 undici connector（基于 `socks` 包），**socks4 也覆盖** |
| Agent RPC（`api2.cursor.sh`，走 connect-node） | **真正的模型流量** | 只有 HTTP/1.1 模式下才会落到 `https.globalAgent`。默认的 HTTP/2 走 `node:http2`，而它完全不支持代理 |

因为第二条的存在，`CURSOR_SDK_USE_HTTP1_FOR_AGENT` 按**三态**解析，而不是一个布尔默认值：

1. 数据库里存过（后台选了「强制开启」或「强制关闭」）→ 用存的值；
2. 否则环境变量非空 → 用环境变量，**包括显式的 `false`**（有人就是只想让 REST 走代理）；
3. 否则**配了代理就默认开启**；
4. 都没有 → 关闭。

后台「运行设置」里这个开关因此是个三档下拉框而不是勾选框：**未设置（配了代理就自动开）** / 强制开启 / 强制关闭。勾选框表达不了「没人表过态」，用它提交等于每次保存设置都替你表一次态，配代理时的自动启用从此再也不会发生。停在「未设置」时保存提交的是 `null`，网关会把这条设置清掉、重新跟随环境变量与代理；已经选了强制态的想反悔，也是选回「未设置」。管理 API 同理：`POST /admin/api/settings` 的 `cursorSdkUseHttp1ForAgent` 接受 `true` / `false` / `null`，返回体里的 `cursorSdkUseHttp1Source` 会告诉你当前这个值是谁定的（`stored` / `env` / `proxy` / `default`）。

也就是说只有你亲手关过，模型流量才会在有代理的情况下继续直连；这种情况后台会持续告警（`modelTrafficProxied: false`）。在后台保存代理地址时，如果你从没表过态，网关会顺手把开关打开、落库并在响应里说明——但 SDK 的传输层是**建的时候**读这个配置的，已经建好的连接仍是 HTTP/2，网关只能放掉预热租约让旧执行器可被回收，在途请求收尾后新建的会话才走 HTTP/1.1。要立刻彻底生效就重启网关。预热租约的释放是**有时限**的（池子自己 5 秒、整个传输层重置 15 秒封顶），超时或失败的那份租约会留在池里等下次重试而不是被丢掉句柄，同时写日志并在保存设置的响应里带上 `executorResetWarning`（看到它就重启网关）。「保存设置」不会因为某个预热卡住而一直挂着。

换代理或清代理时，旧的连接池是**优雅收尾**的：空闲连接立刻拆，正在传输的连接等它自己结束（上限 10 分钟）再拆。改个设置不该把在途的模型请求打成传输错误。

后台「测试代理」会**分别探两条链路**并分开报告：REST 那条打 `https://api.cursor.com/v1/me`（走一次性 undici dispatcher），模型那条打 `https://api2.cursor.sh/`（走一次性 `node:https` 代理 agent，即 HTTP/1.1 下模型流量真正走的那条路）。两条都用一次性对象，绝不碰进程里已装上的 dispatcher 与 `globalAgent`。

判「通」的标准是**来自目标站点**的状态码（没带 key 时 401、打根路径时 404 都正常），不是「回来了个状态码」：代理自己回绝 CONNECT 时，`https-proxy-agent` 不抛错，而是把代理那条 407 / 502 原样回放给 HTTP 客户端，看起来和上游的回应一模一样。网关按「这条响应是不是从隧道里的 TLS 连接读出来的」区分两者，代理生成的响应一律报不通并说明原因——密码写错却看到绿灯，是诊断能犯的最严重的错。隧道通仍然只代表网络可达，不等于模型一定可用。

SOCKS 的两点协议限制值得留意：`socks5://` 按协议语义由网关本机解析域名（两条链路都是），DNS 被污染时会连到错误的 IP，想让代理解析域名请用 `socks5h://`；`socks4://` 的地址字段只有 4 字节，只能连 IPv4（解析不出 A 记录会直接报错而不是静默走偏），且鉴权只有 userId、不支持密码。

另外 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 也会被设上，供 agent 的 shell 工具 spawn 的子进程使用；SDK 自己并不读这些变量。

受 SDK 限制，代理只能是**进程级全局**设置，无法按 key 分别配置（SDK 的传输层没有可注入的按请求钩子）。

## 默认系统提示词

后台「系统提示词」页设置，三种模式：

- `off`（默认）：不注入
- `append`：追加在客户端自己的 system 之后
- `override`：覆盖客户端的 system

三种协议都生效（Anthropic 的 `SYSTEM:` 块、Responses 的 `INSTRUCTIONS:` 块、Chat 的 system 消息），`/v1/messages/count_tokens` 也会算上它，所以报出来的 token 数与真实请求同口径。正文留空时永远不会把客户端自己的 system 清掉。

实现上是注入进合成 prompt 的：Cursor SDK 没有 system 入参（wire 协议里有 `custom_system_prompt`，但没有任何公开 API 能碰到它），而本项目刻意用 `settingSources: []` 禁掉了 `AGENTS.md` / `.cursorrules` 之类的宿主规则加载，不会拿它们当注入通道。

## 管理后台

浏览器打开 `http://127.0.0.1:8787/admin`，使用 `ADMIN_PASSWORD` 登录（未设置时退回 `GATEWAY_API_KEY`；两者都为空则后台禁用）。

左侧导航分组：

- **概览**：服务状态、key 数量、请求统计、实测 / 估算 token 用量与花费
- **密钥**：Cursor Key 池（增删启停、排序、通道、可用模型、权重、从会话 token 铸 key）、网关密钥（多密钥 + 绑定 Cursor key + 模型范围）
- **策略**：取用策略与会话粘性、默认系统提示词、代理设置
- **运维**：请求历史（翻页 + 过滤）、联通性测试、运行设置

请求历史每行记录推理强度、是否 fast、是否 1M/Max Mode、通道、会话模式、实际下发的 `model.params`、token 用量、花费与错误，可按 Cursor key、网关密钥、模型、成败、时间过滤，并能一键清空。用量来源会区分「上游真值」与「按字符估算」。

推理强度 / fast / Max Mode 三列优先显示**实际下发**的值（从真正发给上游的 `model.params` 反解），反解不出来才退回客户端的请求意图，并在数值后标一个 `?`：那表示「客户端要了，但网关不知道最后发出去的是什么」。`context=1m` 这类档位型参数光看下发值判断不出是不是最大档，所以 Max Mode 这一列通常带 `?`。

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

宿主机直跑（不走 Docker）时，如果进程在启动阶段直接崩掉、没有任何 JS 异常栈：

```bash
CURSOR_PREWARM=false npm start
```

启动预热会进 SDK 的原生工作区扫描，该扫描在部分宿主（实测 Windows + `@cursor/sdk` 1.0.27）会触发 access violation 把进程整个打挂。原生崩溃是 `try/catch` 抓不到的，所以只能整块跳过。预热只影响首个请求的冷启动时间，功能不受影响。
