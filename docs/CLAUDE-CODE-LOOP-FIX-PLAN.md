# Claude Code 重复说话 / 对齐 schema 循环修复计划

> 供新会话与子代理执行。本文档自包含：背景、根因、分阶段任务、文件所有权、验收标准、明确不改的范围。
> 范围只覆盖 **1 → 2 → 3**（挡泄漏、滤宿主元工具、打断跨轮回声）。**不改** SDK session resume（避免再引入 502）。
> **三端点对等**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 必须同一套行为。禁止只修 Anthropic。

## 0. 背景与结论

调研已完成（2026-08-18，四个本地子代理 + 官方 SDK 文档）：

1. 本仓库是 Cursor **Agent SDK 适配器**，不是 chat-completions 反代。`Agent.create` + `agent.send` 跑完整 Composer agent。
2. `@cursor/sdk@1.0.27` `custom-tools.d.ts` 原话：`customTools` 注册为合成 MCP 服务器 `custom-user-tools`，模型经 **GetMcpTools / CallMcpTool** 发现和调用。
3. Claude Code 经 `ANTHROPIC_BASE_URL` 接入时变成 **双层 Agent**：外层 Claude Code 带齐 Read / Bash / Task / GetMcpTools；内层 Composer 再开一套 MCP 发现。Cursor IDE 只有一层，所以不循环。
4. 截图中的「任务 A/B 交替」+「搜到工具了，先把完整 schema 拉齐」= 内层 `task` 里程碑 / GetMcpTools 仪式泄漏成 assistant 正文，再被下一轮 `ASSISTANT:` 回灌。

**总体判定**（按用户标准：先压住循环，不动 session resume）：

| 阶段 | 判定 | 处置 |
|---|---|---|
| P1 挡 `task` 旁白 | P0，一流内复读 | `textFromSdkEvent` 只认 `assistant` |
| P2 滤宿主元工具 | P0，对齐 schema / 子代理套娃 | 不把 GetMcpTools / Task 等注册进 customTools，也不写进 TOOLS 清单 |
| P3 打断跨轮回声 | P1，多轮复述 | 历史 assistant 文本里的仪式句不进合成 prompt |
| P4 同会话 resume | 明确不改 | 默认 `CURSOR_SDK_DISABLE_SESSION_RESUME=true` 是为躲 502 |

**能力边界（本计划不碰）**：

- 不恢复 SDK session resume，不把 `tool_result` 送回同一 `Run`。
- 不改 `tools: ["mcp"]` 策略（仍要靠它避免网关容器内双重执行 shell/edit）。
- 不改 wire format（Anthropic `tool_use` 的 `input: {}` + `input_json_delta` 等已对齐的部分）。
- 滤掉的宿主元工具不再经网关转发；Claude Code 本机 MCP 发现不会走这条代理（与现有拒绝 `mcp_servers` 一致）。Read / Bash / Grep / Edit 等客户端文件工具照常转发。

---

## 1. P1 —— 挡 SDK `task` / 非 assistant 旁白

### 现象
官方 `SDKTaskMessage` 是 `{ type: "task", text?: string }`，描述为 milestones / summaries。官方流式示例不把它打进回答。本仓库 `textFromSdkEvent` 在跳过 `status` / `thinking` 后，对任意带 `.text` 的事件兜底，于是「搜到工具了，先拉齐 schema」和任务复述变成助手正文。先到的 `task` 还会把 `textSource` 锁成 `message`，后续 `text-delta` 被丢掉。

### 改法
文件：**只改** `src/cursor-runner.ts`。

`textFromSdkEvent`（约 L731–746）：

- `type === "assistant"`：继续抽 `message.content[]` 里的 text block（现状保留）。
- `type === "status" | "thinking" | "thinkingMessage" | "task" | "system" | "user" | "tool_call" | "request" | "usage"`：**返回空串**。
- **删除**「任意 `record.text` / `record.delta`」兜底。未知类型默认不输出，避免再漏一种里程碑事件。
- **导出** `textFromSdkEvent`，方便单测（现有 `toolCallsFromSdkEvent` 已导出，同一风格）。

`thinkingFromSdkEvent` 不动：思考仍只从 `thinking` / `thinkingMessage` 来。

### 测试
新文件 `tests/sdk-event-filter.test.ts`（不要改 `tests/server.test.ts`，避免合并冲突）。

- `task` / `status` / `user` / `system` / `tool_call` / 未知类型 → `textFromSdkEvent` 为空。
- `assistant` 的 text block 仍抽出。
- 通过 `CursorSdkRunner` + `FakeSdkRun`：先 yield `task`（含「拉齐 schema」），再 yield `assistant` 正文；`result.text` 只有正文，不含 task 文本。
- 现有用例「ignores thinking/status text」行为保持（可在新文件复述一条，不必改旧文件）。

复用 `tests/server.test.ts` 里的 `FakeSdkRun` 模式：若不想跨文件引用未导出的 Fake，在新测试文件内复制一份最小 Fake（streamEvents + waitResult）即可。

### 验收
- `task.text` 不再进入 `CursorRunResult.text`，也不再经 SSE 发给 Claude Code。
- 真 `assistant` 文本与 `onDelta` `text-delta` 不受影响。
- `npm test` 里本文件全绿；旧 `server.test.ts` 不因本阶段失败。

---

## 2. P2 —— 滤宿主元工具，禁止注册进 customTools

### 现象
Claude Code 几乎每个请求都带 `GetMcpTools` / `CallMcpTool` / `Task`。网关把它们当成普通 `GatewayTool`：

1. `createSdkCustomTools` 注册进 `custom-user-tools`；
2. `appendToolInstructions` 把完整 JSON 写进 TOOLS；
3. 内层模型再演一遍「先拉齐 schema」或「派 Task」；
4. `execute` 返回假成功「Accepted… End your turn」后 `cancel`；
5. 若转发给 Claude Code，外层再开子代理，子代理又打回本网关 → 套娃。

### 改法
文件：**只改** `src/tool-compat.ts`。

新增并导出：

```ts
export function isHostMetaTool(name: string): boolean
export function filterHostMetaTools(tools: GatewayTool[]): GatewayTool[]
```

`isHostMetaTool` 大小写不敏感，匹配下列**精确名字**（不要用模糊包含，以免误伤用户自定义工具）：

| 类别 | 名字 |
|---|---|
| MCP 元工具 | `GetMcpTools`, `CallMcpTool`, `FetchMcpResource`, `ListMcpResources`, `mcp_auth` |
| 子代理 | `Task`, `TaskOutput`, `TaskStop`, `Agent` |
| 宿主编排 | `Skill`, `SlashCommand`, `EnterPlanMode`, `ExitPlanMode`, `SwitchMode` |
| 交互 / 配置 | `AskUserQuestion`, `AskQuestion` |

**不要**过滤：`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `LS` / `WebFetch` / `WebSearch` / `TodoWrite` 以及用户自定义名字。

`createSdkCustomTools` 开头先 `filterHostMetaTools`。`matchesClientTool` / `keepDeclaredOnly` 路径：未注册的元工具本来就会被丢掉（名字对不上已注册的客户端工具时）；为防解析层仍留下元工具，`matchesClientTool` 对 `isHostMetaTool(name)` 直接返回 `false`（解包 MCP 之后再判断）。这样内层若发出 `GetMcpTools` / `CallMcpTool` 包装，也不会转发给 Claude Code。

`unwrapMcpToolCall` 逻辑保留：`providerIdentifier === "custom-user-tools"` 且内层 `toolName` 是 `Read` 等，仍正常解包转发。

### 协议侧配合（由 P3 落地，见下节）
`protocol.ts` 三个 parse（`parseOpenAiTools` / `parseResponsesTools` / `parseAnthropicTools`）在 return 前调用 `filterHostMetaTools`。这样 TOOLS 清单、REMINDER、customTools 共用同一份已过滤列表。P2 只提供函数；P3 负责接入 parse。

### 测试
新文件 `tests/host-meta-tools.test.ts`。

- `isHostMetaTool("GetMcpTools")` / `"getmcptools"` / `"Task"` / `"CallMcpTool"` → true。
- `isHostMetaTool("Read")` / `"Bash"` / `"my_get_mcp_tools"`（自定义，非精确名）→ false。
- `createSdkCustomTools` 传入含 GetMcpTools + Read 的列表，返回的 map **只有 Read**。
- `matchesClientTool({ name: "GetMcpTools" }, [GetMcpTools, Read])` → false；`matchesClientTool(Read 调用)` → true。
- `normalizeToolCallForClient` 对 `mcp` + `custom-user-tools` + `toolName: Read` 仍解包为 Read（回归）。

### 验收
- 内层 customTools 不再出现 GetMcpTools / Task。
- 内层若仍调用这些名字，网关丢弃、不转发给 Claude Code。
- Read / Grep 别名与 MCP 解包回归通过。

---

## 3. P3 —— 历史仪式句不进合成 prompt + parse 接入过滤

### 现象
默认每次请求新建 SDK agent。上一轮泄漏的「先拉齐 schema / 先钉某某任务」作为 `ASSISTANT:` 回灌；思考块已被剥掉，模型不记得已经对齐过，仪式重来。末尾 REMINDER 再催一次工具调用。

### 改法
文件：**只改** `src/protocol.ts`（可 import `filterHostMetaTools`）。

**3a. parse 接入（P2 的函数）**

`parseOpenAiTools` / `parseResponsesTools` / `parseAnthropicTools` 在拼好 `GatewayTool[]` 之后 `return filterHostMetaTools(...)`。`tool_choice: "none"` 仍返回 `[]`。

**3b. 仪式文本过滤**

新增并导出：

```ts
export function isRitualAssistantText(text: string): boolean
export function stripRitualAssistantText(text: string): string
```

`isRitualAssistantText` 只用于**整段**判断是否该丢（短句规划）。匹配（大小写不敏感，中英都要）：

- `拉齐 schema` / `对齐 schema` / `align schema` / `complete schema` / `fetch.*schema`
- `对齐工具` / `拉齐工具` / `align tools` / `align the tool`
- `搜到工具了` / `found the tool` / `GetMcpTools` / `CallMcpTool`（作为规划句，不是代码引用长文）
- 仅当整段很短（建议 ≤ 200 字）且命中上述模式时才视为纯仪式句，避免误删用户讨论 schema 的长回复

`stripRitualAssistantText`：

- 若整段 `isRitualAssistantText` → 返回空串。
- 否则原样返回（首期不做逐句裁剪，降低误伤）。

接入点（三个接口都要，缺一不可）：

| 通道 | 位置 | 行为 |
|---|---|---|
| Anthropic `/v1/messages` | assistant `text` | 仪式句 strip；空则跳过 |
| Anthropic `/v1/messages` | `tool_use` / `tool_result` | GetMcpTools / Task 等元工具及其结果不进 prompt |
| OpenAI Chat `/v1/chat/completions` | assistant `content`（字符串或 text part） | 仪式句 strip；user/system 不动 |
| OpenAI Chat `/v1/chat/completions` | `tool_calls` / `role:tool` | 元工具调用及其 tool 结果不进 prompt；Read 等保留 |
| Responses `/v1/responses` | `input[]` assistant message | 仪式句 strip |
| Responses `/v1/responses` | `function_call` / `function_call_output` | 元工具调用及其输出不进 prompt |
| Responses `/v1/responses` | `previous_response_id` 整包转储 | 只清洗写入 prompt 的副本：去掉 reasoning、仪式 output_text、元工具；不改已存快照 |
| 思考块 | Anthropic thinking / Responses reasoning dump | 不进合成 prompt |

**不要** strip 用户消息。客户端文件工具的 `TOOL RESULT` 要保留。

### 测试
新文件 `tests/ritual-history.test.ts`。

走 HTTP inject + `FakeRunner`（从 `server.test.ts` 复制最小 `createTestApp` / `FakeRunner` / `baseConfig`，或只测纯函数）：

- 纯函数：`isRitualAssistantText("搜到工具了，先把完整 schema 拉齐再扫课程路径。")` → true。
- 纯函数：长文里偶尔提到 schema（>200 字、无规划句式）→ false。
- Anthropic：历史 assistant 只有仪式句 → `runner.lastInput.prompt` 不含该句；user「Continue」仍在；普通 assistant「earlier answer」仍在（对齐现有 thinking 排除测试）。
- Anthropic：TOOLS / REMINDER 不含 `GetMcpTools` / `Task`，仍含 `Read`。
- OpenAI Chat：assistant `content` 为仪式句时 prompt 不含该句。

若复制 `createTestApp` 过重，优先测导出纯函数 + 一条 Anthropic inject（可把 `createTestApp` 需要的最小依赖写在新文件；不要改 `server.test.ts`）。

更省事的 Anthropic inject 做法：新文件 import `prepareAnthropicMessages` / `prepareOpenAiChat`，直接断言 `.prompt`，不必起 Fastify。**优先这条**，零依赖 `createTestApp`。

### 验收
- 下一轮合成 prompt 不再回放「拉齐 schema / 搜到工具了」短句。
- 正常助手回答、tool_use、tool_result 仍在。
- TOOLS 清单无宿主元工具。

---

## 4. README（可选，单独代理）

文件：**只改** `README.md`「能力边界」一节，补 3～5 行，不要另开章节：

- Claude Code 等宿主的元工具（GetMcpTools / Task 等）不会经网关转发给上游，也不再注册为 Cursor customTools，避免内层再演工具发现 / 子代理套娃。
- Cursor SDK 的 `task` 里程碑不会作为助手正文下发。
- 历史里的短仪式句（对齐 schema 等）不会进入下一轮合成 prompt。
- 仍然不恢复 SDK session resume。

---

## 5. 子代理文件所有权（必须遵守）

并行时**禁止**两个代理改同一个文件。

| 代理 | 只许改的文件 | 任务 |
|---|---|---|
| A-P1 | `src/cursor-runner.ts` | P1 `textFromSdkEvent` |
| B-P2 | `src/tool-compat.ts` | P2 `isHostMetaTool` / filter / createSdkCustomTools / matchesClientTool |
| C-P3 | `src/protocol.ts` | P3 parse 接入 + 仪式句 strip |
| D-T1 | `tests/sdk-event-filter.test.ts`（新建） | P1 测试 |
| E-T2 | `tests/host-meta-tools.test.ts`（新建） | P2 测试 |
| F-T3 | `tests/ritual-history.test.ts`（新建） | P3 测试 |
| G-DOC | `README.md` | 能力边界 3～5 行 |

协调约定：

- P3 可以 `import { filterHostMetaTools } from "./tool-compat.js"`。若 B-P2 尚未落地，C-P3 仍写上 import，typecheck 会在两代理都完成后变绿。
- D-T1 可以 `import { textFromSdkEvent, CursorSdkRunner } from "../src/cursor-runner.js"`。
- 任何代理都**不要**改 `tests/server.test.ts`、`src/server.ts`、`src/types.ts`、配置默认值、session resume。
- 不要加新依赖。不要提交 git。
- 代码风格跟现有文件：中文注释只解释非显然的「为什么」，不写叙述性废话。

---

## 6. 验收总单

全部代理完成后由主会话跑：

```bash
npm run typecheck
npm test
```

必须全部通过。额外抽查：

1. `task` 事件文本不出现在 runner 的 `result.text`。
2. `createSdkCustomTools([GetMcpTools, Read])` 只有 `Read`。
3. `prepareAnthropicMessages` 的 prompt 不含 GetMcpTools、不含仪式短句、含 Read 与普通 assistant 文本。
4. 现有 Claude Code Grep 别名 / MCP unwrap / thinking 排除 / builtin tools 限制用例仍绿。

---

## 7. 明确后续（P4 仍不做）

- 同会话 `Agent.resume` + 把 tool_result 送回同一 Run（P4）。要做需单独开计划，先解决 502 / 远端 agent 污染。
- 关掉 `tools: ["mcp"]` 或改用非 MCP 暴露 customTools（SDK 没有这条路）。
- 改 thinking 可见性默认值。
- 改 wire format。

---

## 8. P3.1 —— 审阅后修补（尽量贴近原生三端历史语义）

四次审阅（2026-08-19）认定：TOOLS 过滤与同请求内元工具回声已齐；仍有几条会把 schema / reasoning / 空轮喂回下一轮。本阶段只补这些，仍不改 resume / `tools:["mcp"]`。

### 文件所有权

| 代理 | 只许改的文件 |
|---|---|
| H-P31 | `src/protocol.ts` |
| I-P31 | `src/cursor-runner.ts` |
| J-P31 | `src/tool-compat.ts` |
| K-T31 | `tests/ritual-history.test.ts` |
| L-T31 | `tests/sdk-event-filter.test.ts` |
| M-T31 | `tests/host-meta-tools.test.ts` |
| N-DOC | `docs/CLAUDE-CODE-LOOP-FIX-PLAN.md` 本节验收勾选（可改本文件第 8 节）+ `README.md` 能力边界一句 |

不要改 `tests/server.test.ts`、`src/server.ts`、session resume。

### H-P31 `protocol.ts`（贴近原生：空轮不发明、思考不回灌、上一轮 output 的 id 要能对上本轮 result）

1. **Responses `previous_response_id` 孤儿 output**  
   从 `previous.response.output` 和 `previous.inputItems` 收集宿主元工具的 `call_id` / `id`，传入 `responseInputToTextAndImages`。当前 `input` 只有 `function_call_output` 时也要丢掉。sanitize 转储里同样丢掉对应 `function_call_output`。

2. **Responses `input[]` 的 `reasoning`**  
   `responseInputToTextAndImages` 跳过 `type === "reasoning"`（与 Anthropic 不回灌 thinking、sanitize 已丢 reasoning 对齐）。

3. **Responses 内容块 `type === "text"`**  
   `responseContentToText` 与 sanitize 把 `text` 与 `output_text`/`input_text` 同等对待。

4. **空轮不写 `[empty]`**  
   Chat / Anthropic：strip 后既无正文也无保留的工具调用 → **整轮不写入 transcript**（对齐 Responses 已有的 skip）。不要再发明 `ASSISTANT: [empty]` / `USER: [empty]`。有 Read 等真实 `tool_calls` 时只写 TOOL_CALLS 行。

5. **两遍收集 id**  
   Chat / Anthropic / Responses 都先扫完全部调用再 flatten，这样 result 出现在 call 前面也不会漏。Chat 额外兼容旧字段 `function_call` 与 `role: "function"`。

6. **仪式正则**  
   - 要能命中 `先把完整 schema 拉齐`（schema 在前）。  
   - 删掉 `fetch[\s\S]*schema`（会误伤 “fetch notes then schema”）。  
   - 删掉会命中 `incomplete schema` 的 `complete\s+schema`。  
   - `GetMcpTools` / `CallMcpTool` 用词边界，且仍受 ≤200 字整段限制。  
   - 保留 搜到工具了 / 对齐工具 / align schema / align tools。

7. **Chat 未知 assistant part**  
   跳过 reasoning / thinking 类 part，不要 `JSON.stringify` 进 prompt。

8. **sanitize 字符串 `content`**  
   若 stored message.content 是字符串，也做仪式 strip，空则丢该 message。

### I-P31 `cursor-runner.ts`

1. `textFromSdkEvent` 在 `type === "assistant"` 时除 `content[]` text block 外，还认：`message.content` 为字符串、`content[].type === "output_text"`、`message.text`、顶层 `.text`。其它 type 仍返回空。
2. `wait()` 兜底：若流里已经来过 event/delta（包括被丢掉的 task），**不要**再用 `wait()` 的文本当助手正文。只有整段流为空时才用 `wait()` 文本；若该文本 `isRitualAssistantText` 也丢弃。可从 `protocol.ts` import `isRitualAssistantText`（cursor-runner 已依赖 protocol）。

### J-P31 `tool-compat.ts`

`matchesClientTool` / unwrap 后：`mcp`/`CallMcpTool` + `toolName: GetMcpTools`（或其它宿主元名）必须 false。若已如此，只补注释，不要扩模糊匹配、不要把 Read 滤掉。

### 测试（K/L/M）

K `ritual-history.test.ts` 必须新增（保持旧用例绿）：

- `"先把完整 schema 拉齐再扫。"` → ritual true；`"I'll fetch the notes, then discuss the schema."` → false；`"incomplete schema ok"` 短句 → false。
- Chat / Anthropic 仪式-only 轮 **没有** `ASSISTANT: [empty]`。
- Anthropic 整轮 user 只有 GetMcpTools `tool_result` → 没有 `USER: [empty]`，也没有 schema-pack。
- Responses：`previous_response` 里有 GetMcpTools `function_call`，当前 `input` 只有对应 `function_call_output`（schema-pack）→ prompt 无 schema-pack。
- Responses：`input[]` 含 `type:"reasoning"` → prompt 无该思考文本。
- Responses：`output_text` 与 `type:"text"` 仪式句都 strip。
- Chat：`function_call_output`/`role:tool` 出现在 assistant `tool_calls` 之前也能丢掉元工具结果。

L `sdk-event-filter.test.ts`：

- assistant `{ text: "hello" }`、`message.text`、`content: "hello"`、`output_text` 都能抽出。
- 流只 yield `task`、`wait()` result 为仪式句或同一句 task 文本 → `result.text` 为空或不含该句（按 I-P31 规则）。

M `host-meta-tools.test.ts`：

- `matchesClientTool` 对 `{ name:"mcp", arguments:{ providerIdentifier:"custom-user-tools", toolName:"GetMcpTools" } }` 为 false。

### 验收

`npm test` 全绿。抽查：三端空轮不发明 `[empty]`；Responses 官方 previous_response_id 续轮不回灌 schema-pack；reasoning 不进 Responses prompt。
