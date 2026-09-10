# Bot 路线 Box Relay 自动化计划

> 状态：**已完成**（2026-09-10，P0-P4 全部落地并实测）
> 前置事实：全部经本机实测（2026-09-09/10，Grok Bot 0.44.0）
>
> 落地清单：
> - P0 ✅ `scripts/ensure_sandbox_smoke.py`（session JWT 直调 EnsureSandBox 实测通过）
> - P1 ✅ `scripts/extract-grokbot-descriptor.mjs`（运行时取证）→ `docs/reference/grokbot-service-descriptor.txt`
>   → `scripts/gen-inference-pb.mjs`（grokbot-dump 解析器）→ `src/cursor-bot/proto/grokbot_service_pb.ts`；
>   `src/cursor-bot/box-relay.ts`（ensureBoxConnection + BoxRelayConnectionManager）
> - P2 ✅ `inferenceRoute`（env CURSOR_BOT_INFERENCE_ROUTE + botOverrides 运行时可改）；
>   service 的 inferenceTarget/streamPlain 重试；实弹验证 `scripts/ensure-box-connection-smoke.mjs`
>   （JWT → EnsureSandBox 二进制 proto → relay 推理，5.9s 回 RELAY TEST OK）
> - P3 ✅ `src/cursor-bot/relay-provision.ts`（probeRelay/listBoxAgents/provisionRelay）；
>   admin 路由 relay-status / provision-relay；后台「推理出口」下拉 + 凭据行 Relay 按钮 + 装配轮询
> - P4 ✅ 测试 909/912（唯一失败为存量 SOCKS 网络测试）；`.env.example` / README 章节；
>   存量 descriptor 对照测试改为缺文件时 skip
> - 后续观察项：上游若封 relay 路由（probe 状态实时可见），届时只剩 SDK 路线

## 1. 背景与现状

| 链路 | 状态 | 说明 |
|---|---|---|
| key 兑换 session JWT（api2 `/auth/exchange_user_api_key`） | ✅ 可用 | 不动 |
| 模型目录（api2 `AiService/AvailableModels`，session JWT） | ✅ 可用 | 不动 |
| 推理直连（api2 `InferenceService/Stream`，session JWT） | ❌ 0.44 起被拒 | 上游要求 Box 内部 token（endStream `unauthenticated`） |
| 推理经 Box relay | ✅ 已实测打通 | relay 路由 = `{gatewayUrl}/sand-stream-relay/aiserver.v1.InferenceService/Stream`，鉴权 Bearer gatewayToken + 头 `x-anyrun-network-token`（缺一头即 404/拒路由） |

手动模式（昨天的临时方案）要人工同步三样东西：`CURSOR_BOT_BASE_URL`、`CURSOR_BOT_EXTRA_HEADERS`、凭据 sessionToken 换 Box token——根源是**网关不会自己获取 Box 连接**。

**关键事实**：桌面端自己就是调 `GrokBotService/EnsureSandBox`（api2、session JWT 鉴权、空请求体）拿到
`{gatewayUrl, gatewayToken, networkToken}` 的（bundle 逆向确认：`ensureBox()` → `ensureSandBox({})` → `q_e(...)` 组连接）。
网关做同样的事即可全自动化。proto 字段号已从 0.44.0 bundle 核对：

```
EnsureSandBoxRequest  { 2: wake(bool, opt) }                    // 桌面端传 {}，空体可用
EnsureSandBoxResponse { 1: cluster, 2: tenant_id, 3: pod_id,
                        4: network_token, 5: exec_daemon_auth_token,
                        6: exec_daemon_url, 7: vnc_url, 8: terminals_folder,
                        9: image_update_available(bool, opt),
                        10: gateway_url, 11: gateway_token,
                        12: fork_vnc_base_url, 13: run_state(enum) }
```

## 2. 目标

1. admin 后台**零手工 token 操作**：凭据保持 session JWT，Box token 网关自己取自己换；
2. token 轮换**自动恢复**（401/403 → 重取重试，用户无感）；
3. Box 重建（relay 补丁丢失）→ 后台**一键重新装配**；
4. 目录/兑换继续走 api2 直连，目录功能恢复（手动模式下是 404 降级）。

## 3. 架构

```
direct 模式（现状保留，兼容旧后端/测试床）:
  推理 → api2 InferenceService/Stream（session JWT）        【0.44+ 上游已拒】

relay 模式（新增，推荐）:
  兑换 / 目录 / EnsureSandBox ──→ api2（session JWT，全部现有代码不动）
  推理 ──→ {gatewayUrl}/sand-stream-relay/InferenceService/Stream
            Bearer gatewayToken + x-anyrun-network-token: networkToken
  连接来源: ensureBoxConnection(credential)
            → EnsureSandBox → 按凭据缓存 → 401/403 失效重取
```

推理请求流程（relay 模式）：

```
run(stream) 请求
  → resolveCredential（session JWT，不变）
  → boxConnectionManager.get(credential.id)        命中缓存 ↓ / 未命中 EnsureSandBox
  → 造转发上下文: baseUrl={gatewayUrl}/sand-stream-relay
                  credential'={…credential, sessionToken: gatewayToken}
                  extraHeaders={x-anyrun-network-token: networkToken}
  → InferenceService/Stream
  → 若 0 帧产出时 401/403/unauthenticated → 失效连接 → 重取 → 重试一次
  → 若 404 → relay 未装配 → 报错指引后台装配
```

## 4. 实施步骤

### P0 — EnsureSandBox 冒烟验证（先行，半小时）
- 写一次性脚本：用解密出的 session JWT + `postConnectUnary`（现有 transport/headers，kind=unary）
  以 **JSON codec**（`content-type: application/json`，body `{}`）调 `api2/aiserver.v1.GrokBotService/EnsureSandBox`，
  确认返回 `gatewayUrl/gatewayToken/networkToken` 且与 `grok-box-relay.json` 同源。
- 风险点：兑换来的 session JWT 是否被 EnsureSandBox 放行（目录同族服务已放行，预期低风险）。
  **P0 不过则整个方案换路线**（备选：本地 descriptor sidecar 同步）。

### P1 — proto 与连接管理
- `scripts/extract-grokbot-descriptor.mjs`：从 Grok Bot 0.44.0 bundle 机械抽取 GrokBotService
  相关消息字段 → `docs/reference/grokbot-service-descriptor.txt`（遵守本仓库「字段只从取证文件读」的硬约束，
  也顺手修掉 `inference-descriptor-8844.txt` 缺失导致的存量测试失败——把该测试的参考文件路径改指向新文档或补齐文件）。
- `src/cursor-bot/proto/grokbot_service_pb.ts`：只实现 `EnsureSandBoxRequest/Response` 两个消息
  （风格对齐现有手写 `available_models_pb.ts`）。
- `src/cursor-bot/box-relay.ts`：
  - `ensureBoxConnection(credential, {baseUrl, fetchImpl})` → `{gatewayUrl, gatewayToken, networkToken}`
  - 按凭据缓存 + 单飞（对齐目录 inflight 模式）+ `invalidate(credentialId)` + 刷新冷却 60s
    （对齐桌面端 unauthenticated-recovery 的冷却语义，取更短值）。

### P2 — 推理路由与自动刷新
- `ProviderRunOverrides` 增加 `inferenceRoute?: "direct" | "relay"`；
  env `CURSOR_BOT_INFERENCE_ROUTE`（顶层默认 `direct`，保守不变更现状；后台「运行设置」可改，回落顺序同 codec）。
- `service.ts`：
  - `BotSettings` 增加 `inferenceRoute`；
  - `providerFor` 在 relay 模式下从连接管理取连接，注入 baseUrl / 转发凭据 / extraHeaders；
  - 目录与 `testCredential` 永远走 api2 直连（不进 relay）。
- `provider.ts`：`stream()` 增加一次性重试——**尚未产出任何帧**时遇 401/403 或 endStream
  `unauthenticated` → 失效连接 → 重取连接重建 client → 重试一次；已产出帧的流绝不重试（客户端已收到内容）。
- 404 → `ApiError("Box relay 未装配…请在后台凭据行点「装配 relay」", 502)`。

### P3 — 探测与一键装配（admin）
- `src/cursor-bot/relay-provision.ts`：
  - `probeRelay(connection)`：POST 空 envelope 帧（`0x00×5`）+ connect+proto 头 →
    200 且含 end 帧 = OK；404 = 未装配；401/403 = token 失效（顺带触发连接刷新）。
  - `provisionRelay(credential)`：`/api/listAgents` 取最近活跃 agent →
    `/api/sendPrompt` 发装配指令（用 2026-09-10 实测成功的「知情接受临时性」文本，存为常量）→
    轮询 probe（上限 5 分钟，容忍装配期间 host 重启的 502/拒连）。
- admin 路由：
  - `POST /admin/api/bot/credentials/:id/provision-relay`（异步任务，立即返回 taskId）
  - `GET /admin/api/bot/credentials/:id/relay-status`（probe 结果 + 缓存连接年龄 + 装配任务状态）
- admin-ui「Bot 凭据」每行：relay 状态徽标（已连接 / 未装配 / 装配中 / token 失效）+ 「装配 / 修复」按钮；
  「运行设置」加推理出口下拉（直连 / Box relay）。
- 已知行为：装配指令会出现在所选 bot 的聊天记录里（Grok Bot 客户端可见）——文档写明，属预期。

### P4 — 测试与文档
- 测试：proto 字段号对照（读 descriptor 文档断言）、连接管理（缓存/单飞/失效/冷却）、
  relay 路由包装（baseUrl/凭据/头）、401 重试一次、已出帧不重试、probe/provision（mock fetch）、admin 路由。
- `README.md` Bot 路线章节改写 + `.env.example` 更新（relay 模式 = 一个开关，无手工 token）。
- `CURSOR_BOT_EXTRA_HEADERS` 保留为逃生舱（relay 模式不再需要），手动模式文档标注「过渡方案」。

## 5. 后台最终交互（自动化后 admin 要做什么）

1. 「从 Key 拉取」凭据（现状不变）；
2. 运行设置 → Bot 推理出口 → **Box relay**（一次性）；
3. 凭据行点「**装配 relay**」（仅 Box 重建后才会再次出现）；
4. 之后 token 轮换、过期、重试全部自动，无感。

## 6. 风险与未知

| 风险 | 评估 | 缓解 |
|---|---|---|
| session JWT 调 EnsureSandBox 被拒 | 低（目录同族已放行） | P0 第一时间验证，不过则换 sidecar 方案 |
| EnsureSandBox 冷启动建 Box 慢 | 中（秒~分钟级） | 首请求延迟可接受；可选启动预热 |
| 装配指令被 agent 拒绝（模型降级/收紧） | 中（今天实测成功过一次） | admin 显示 agent 回复原文，转人工贴指令 |
| relay 补丁临时性（Box 重建即失） | 确定会发生 | P3 一键装配就是为此设计 |
| 多凭据 = 多账号 = 多 Box | 架构性事实 | 连接与装配均按凭据隔离 |
| 上游封 relay 路由 | 不可控 | probe 状态实时可见；届时只剩 SDK 路线 |

## 7. 工作量

P0 半小时 / P1 半天 / P2 一天 / P3 一天 / P4 半天 ≈ **3 天**（含测试与文档）。
