# cursor-byok 侧待办（网关不修，二开 byok 时处理）

> 记录时间：2026-09-16。网关基线：`c444ad0 feat: collision fork for derived-L3 locked-out conversations`。
> 本文只记 **byok 客户端侧** 的问题。这些不是网关缺陷，网关侧无从修复（请求里没有的东西不能凭空发明）。
> 证据全部来自本机 debug 快照（容器内 `/data/debug/<日期>/<logId>.json`，2026-09-15 16:24–16:27 那批）。

---

## 1. Task 工具时有时无 → 子代理“不可用”

### 现象

新开会话 4–5 次里有约 2 次，模型回答「Task 工具不可用，环境没提供子代理，但其他工具支持」。

### 证据：两套不同的工具集，不是随机丢工具

同一时段两个首轮请求的 `tools[]`：

| 快照 | 工具数 | Task | AskQuestion | UpdateCurrentStep |
|---|---|---|---|---|
| `4f4d2c19`（子代理可用） | 20 | ✅ | ✅ | ❌ |
| `752a7db6`（说不可用） | 19 | ❌ | ❌ | ✅ |

`752a7db6` 的完整清单：
`Shell,Grep,Delete,WebSearch,WebFetch,ReadLints,EditNotebook,TodoWrite,StrReplace,Write,Read,Glob,GetMcpTools,FetchMcpResource,SwitchMode,UpdateCurrentStep,CallMcpTool,SembleSearch,SembleFindRelated`

**`UpdateCurrentStep` 在、`Task`/`AskQuestion` 不在**，这正是 byok 的 **Subagent 模式**工具集特征，不是主代理（Agent 模式）的。

### byok 源码对应位置（v0.1.7 / main）

- `server/src/cursor/compile/run.rs:137`
  ```rust
  let checkpoint_mode = if request.subagent_type_name.is_some() { Mode::Subagent } else { mode_from_proto(mode_number)? };
  ```
- `server/src/cursor/compile/run.rs:163`：`if subagents_disabled { checkpoint_prompt.tools.retain(|tool| tool.name != "Task"); }`
- `server/src/cursor/compile/run.rs:604`：`allow_subagents: request.subagent_type_name.is_none() && !subagents_disabled`
- `server/src/cursor/prompting/compiler.rs:55`：`Mode::Subagent && suppress_subagent_progress` 时移除 `UpdateCurrentStep`
- `server/prompt/cursor/subagent/runtime.md`：提示词明写 `The Task tool is unavailable inside subagents, so delegation cannot be nested.`

### 判断

那几次“说不可用”的会话，**模型说的是实话**——它当时的工具集里确实没有 Task。网关侧已在 `983be1f` 拆掉全部宿主元工具过滤，`Task: True` 的会话里 Task 调用与结果全程畅通（同批快照可证）。

### 待查（二开时）

为什么某些**新开的主会话**会拿到 Subagent 工具集 / 或 `subagents_disabled` 被算成 true：
1. `subagent_type_name` 是否在某条新会话初始化路径上被误填；
2. `model::overrides(request)` 得出的 `SubagentModelOverride::Disabled`（`run.rs:148-153`）是否因模型配置（比如给 composer 配了 subagent 覆盖）而命中；
3. Cursor 客户端侧的会话类型（受限会话 / 特定入口）是否本来就不带 Task。

### 现场自证方法

遇到时直接问模型「列出你当前可用的全部工具名」。清单里**有 `UpdateCurrentStep` 而无 `Task`** ⇒ byok 把该会话当子代理模式，与网关无关。

---

## 2. 不带任何会话标识（导致内容推导身份）

### 现象

byok 的 anthropic provider 发出的请求体只有 `model / system / messages / max_tokens / stream / tools`，**没有 `metadata.user_id`、没有 `session_id`**；头也只有 `x-api-key` + `anthropic-version`（+ 用户配的 custom headers）。

`server/src/provider/anthropic.rs:54`：
```rust
let ModelInvocation { call_id, request, .. } = invocation;  // conversation_id 被丢弃
```

byok 内部**有** `ModelInvocation.conversation_id`（`server/src/model/inference.rs:22`，每个 Cursor 会话一个），但组包时没放进请求。

### 后果（网关侧已缓解，非根治）

网关只能落到 L3 内容推导身份（`identitySource=derived-L3`）：同仓库 + 同模板 prompt + 同分钟的并发会话（典型：并行派发的同 prompt 子代理）会推导出同一个 seed，撞进同一个 durable 槽。网关侧已有三道防线（`75264b9` 的 fresh_session / foreign_tool_results 护栏、`deabddd` 的伪装头降权、`c444ad0` 的碰撞分叉），能保证**不串扰、不循环**，但每次碰撞都要付出一次全量 prompt 的代价。

### 二开建议（约 5 行）

`server/src/provider/anthropic.rs`：

```rust
let ModelInvocation { call_id, request, conversation_id, .. } = invocation;
// body 构造处追加：
body["metadata"] = json!({
    "user_id": json!({"session_id": conversation_id}).to_string()
});
```

网关的 `explicitFromMetadataUserId`（`src/durable-id.ts`）会在 L2 命中真会话边界，碰撞彻底消失、durable 缓存命中率回升。

注意与网关的头降权规则配合（`plans/claude-session-header-demotion-plan.md` §2.1）：若同时经过会盖 `X-Claude-Code-Session-Id` 的中间层（CPA），网关只在 `metadata.user_id` 是 **JSON 形态且 session_id 与头逐字相等**时才采信该头；上面的写法产出的正是 JSON 形态，两者可以对上。

---

## 3. claude-cli 伪装头（可选清理）

byok 桌面版给 Anthropic 协议模型预置了「claude-cli 伪装头」（`apps/desktop/src/utils/modelDefaults.ts`，commit `75babb7`）：

```ts
export const defaultCustomHeaders = {
  "User-Agent": "claude-cli/2.1.177 (external, cli)",
  "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,..."
};
```

这套头会让中间层（CPA 等）把 byok 认成原生 Claude Code，从而按 key 盖上共享的 `X-Claude-Code-Session-Id`——那是本轮串会话事故的成因之一（网关侧已用交叉验证降权解决）。若不需要绕过上游的客户端识别，二开时可以在模型配置里清掉这两个头，链路更干净。
