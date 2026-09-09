# SDK durable 丢掉空轮次（`(no content)` / 空 user_query）

给 `E:\docker-composer-api` 的落地计划。**只改 SDK durable**，不要动 `src/cursor-bot/**`。

**作用范围：SDK 路线上的全部模型**（Composer / Claude / GPT / Grok / 其它目录条目），不是 Grok 专属。判定只看入站最后一条 user 有没有有效意图，**不要**按 `model` / `isGrokContextTarget` 过滤。Bot / `bot/` 前缀不改。

与 `grok-500k-context/docker-composer-api-500k-plan.md` 无关，不要混进那份。

---

## 0. 现象

Cursor agent（Claude Code）经本网关 **SDK 路线**打任意模型时，人没输入新问题，界面仍会出现一条模型回复。Grok 上常见「上一则没有新的问题或指令」；Composer / Claude / GPT 同样会各自编一句「没看到问题」之类的话。根因在 durable 增量发送，与模型 id 无关。

入站最后一条 user 的有效意图是空的，但正文不是空字符串，常见形状：

```xml
<user_query>
(no content)
</user_query>
```

或夹在 harness 壳里（`local-command-caveat`、slash command 的空 stdout、`/clear`、`/effort` Cancelled 之后又打一枪）。

这不是 Bot / Connect 路径，也不是最近两次 commit 引入的：

| commit | 关系 |
|---|---|
| `be9e161` 修 admin-ui 模板 | 无关 |
| `aff0a15` durable 护栏 | **没引入，也没修好**。`(no content)` 当有字的 `new_user` 发出去；真·空 `userText` 还 `streamStatelessFallback`，模型照样跑 |
| durable 增量发送（`5d14c4c` / `855fc50`） | 根因：最后一条 user「有字」就 `durableSend` |

### 0.1 实测快照（2026-09-09，必须按这个形状写判定）

对照文件：`plans/normal.json`（真问题，log `658322e7b9664c8a8bd2abc165ae05d6`）与 `plans/empty.json`（空轮，log `815b227573ec49dd884ca05e1d7d6274`）。都是 `POST /v1/messages` + `grok-4.6` + `claude-cli`，同一 `x-claude-code-session-id`。

空轮 `upstreamTurns` 原文（网关已经抽完增量、即将 `durableSend` 的东西）：

```json
{
  "kind": "new_user",
  "firstSend": false,
  "message": "(no content)"
}
```

入站 `messages` 里对应的最后一条 user **不是** `<user_query>` 包裹，而是：

```json
{ "role": "user", "content": "(no content)" }
```

`content` 是字符串，不是 text 块数组。同一份 body 里这种 user 行已经出现多次（空轮被写进了 transcript）。

对比正常轮：`upstreamTurns` 为空（那次出站是 tool_use，不是 new_user 增量）；SSE `stop_reason=tool_use`，还带了三次 Cursor `Edit`。空轮 SSE `stop_reason=end_turn`，thinking 里写着 “The user sent another empty message.”，正文「还是空轮，没有新指令。」——模型看见的就是那 11 个字符。

计费：空轮仍 200、3.7s、后台实测约 205k input / 75 output；快照 SSE 里是 `input_tokens: 211949`、`cache_read_input_tokens: 211712`、`output_tokens: 62`。修完后这条不应再打 SDK send，upstreamTurns 应为 `blocked: empty_turn_noop`，用量接近 0。

两份快照时间重叠（04:44:17 工具轮还在跑，04:44:22 空轮已经发了）。空轮可以和上一轮 tool_use **并发**，判定不能假设「同一 session 同时只有一个 HTTP」。


---

## 1. 目标

开关打开时（默认开，可关，便于对照）：

1. 抽增量时把「无有效用户意图」收成 `kind: "empty"`。
2. SDK durable **不** `durableSend`，**不**退 stateless 全量重跑。
3. HTTP 仍正常收尾（流式握手 + 空 assistant），客户端不要 400 重试，上游 **任何模型**都不要出字。
4. 真问题、工具结果、纯图片轮次行为不变。
5. Bot 路线零改动。

关掉：恢复今天的转发（占位符仍当 `new_user`）。

---

## 2. 什么叫「无有效用户意图」

在 `extractDurableTurn` 已经拿到 `userText`、且没有 `toolResults`、且没有图片之后做。**不要**只判断 `!userText`。

新建纯函数（放 `prompt-delta.ts`，导出便于测）：

```ts
export function hasSendableUserIntent(userText: string): boolean
```

算法（先处理实测形状，再兜底 harness）。函数只拿已经抽好的 `userText: string`，不要再谈 `content` 类型：

1. trim 后整段等于 `(no content)`（忽略大小写）→ 无意图。**empty.json 实锤就是这一条，测试必须覆盖。**
2. 去掉这些 harness 块（大小写不敏感，非贪婪，可重复）：
   - `<local-command-caveat>...</local-command-caveat>`
   - `<command-name>...</command-name>` / `<command-message>...</command-message>` / `<command-args>...</command-args>` / `<command-stdout>...</command-stdout>` / `<local-command-stdout>...</local-command-stdout>`
   - `<system-reminder>...</system-reminder>`
3. 若存在 `<user_query>...</user_query>`：只取**最后一个** user_query 的 inner。否则用整段剩余文本。
4. trim。空、或整段等于 `(no content)`、或去掉空白后为空 → 无意图。
5. 其它一律有意图。

`anthropicUserText` 已经认 `typeof content === "string"`，empty.json 那种最后一条会抽成 `userText === "(no content)"`，第 1 步直接命中。不要只在「text 块数组 + user_query 标签」上做判定，否则线上空轮仍会漏。

硬约束：

- 用户正文里讨论「no content」三个词，但 user_query inner 不是整段占位 → **有意图**。
- 只有 tool_result / 图片、没有文本 → 现有分支已经处理，本函数不参与。
- 不要用「含有 `(no content)` 子串」这种模糊匹配。

`extractDurableTurn`：

```ts
const userText = bits.userText ?? "";
const images = bits.images?.length ? bits.images : undefined;
if (slotHints?.lastUserText !== undefined && slotHints.lastUserText === userText) {
  return withDigest({ kind: "empty", ... });
}
if (!images && !hasSendableUserIntent(userText)) {
  return withDigest({ kind: "empty", ... });
}
```

三套协议（chat / anthropic / responses）共用这一层，不要只改 anthropic。Cursor agent 走 `/v1/messages`，但 chat 同样能被 harness 打到。

---

## 3. runner：empty 要静默，禁止再打模型

今天 `src/cursor-runner.ts`：

```ts
if (turn?.kind === "empty") {
  throw new ApiError("Empty durable turn: ...", 400, "request_empty");
}
if ((turn?.kind ?? "new_user") === "new_user" && !turn?.userText && !turn?.images?.length) {
  yield* this.streamStatelessFallback(input, signal); // 仍会 create+全文
  return;
}
```

改成：

1. `kind === "empty"`：**不要 400**，**不要** `streamStatelessFallback`。
2. 不要 `ensureDurableSlot`（空轮不该建槽、不该碰 `lastUserText` / `lastAssistantDigest`）。
3. `yield { type: "done", result: { text: "", toolCalls: [] } }` 后 return。
4. debug 快照：`noteUpstreamTurn("sdk", { kind: "empty", blocked: "empty_turn_noop", remark: "..." })`。对照 empty.json 今天记的是 `{ kind: "new_user", firstSend: false, message: "(no content)" }`，修完不应再出现这种 send。
5. `recordDurableDecision({ decision: "reuse", reason: "empty_turn_noop", ... })`（没有活槽就只打 debug，不要为记一笔去建 Hub）。

`new_user` 且 `!userText && !images` 的旧守卫：与 extract 对齐后应几乎走不到。留下当兜底，**同样 noop**，禁止再退 stateless。改掉 `tests/cursor-durable-guardrails.test.ts` 里「空 userText 退 stateless 全量、模型仍 reply」那条——新断言是：0 次 `create`/`send`，结果 `text === ""`，hub 不增槽。

### 为什么不 400、不退 stateless

- 400：Claude Code 容易重试或打出错误条，空轮会更吵。
- stateless 全量：正是 `aff0a15` 护栏测到的「拦了 durable send，模型照样出字」。占位符若在 flatten prompt 末尾，当前模型仍会编一句「没有新问题」。

### 槽字段

空轮 **不要** `touchSlotHistory(slot, userText)`。否则 `lastUserText` 变成占位符，下一句真问题仍能发，但「重复占位」的判定会乱。槽保持上一轮真问题 / 真回复。

digest 风险（必须写进实现注释，线上用一轮验证）：

- 返回 200 空 assistant 时，若客户端把空回复写进 transcript，下一轮 `assistantDigest` 可能对不上槽里上一轮真回复，触发 `history_mismatch` → 粘性 stateless（`aff0a15` 包 E 已有意如此）。
- 先 **不改 digest**。若验收时发现空轮之后下一句真问题掉进 stateless：再在 noop 路径把 `lastAssistantDigest` 更新成「我们返回的空串摘要」，并补一条护栏测试。不要预先改，以免 Cursor 其实不落空 assistant 时误伤。

---

## 4. HTTP 层

`/v1/messages`、`/v1/chat/completions`、`/v1/responses` 已有的流生成器在 `result.text === ""` 时本来就不会吐 content delta，只需正常 `message_stop` / `done`。不必为 empty 开新信封。

请求日志：`finishLog` 记 `abort_reason` 不要用；可在 debug 快照看到 `empty_turn_noop`。不必新加 DB 列。

`server.ts` 的 `extractDurableTurn(..., undefined, undefined, promptSettings)` 仍然不传 `slotHints`。本任务 **不** 把 hints 提前到选 key 之前（没 sessionId）。占位符判定不依赖 slot。

---

## 5. 开关

可选，默认开：

- env：`DROP_EMPTY_DURABLE_TURNS`（`booleanValue(..., true)`）
- `GatewayConfig.dropEmptyDurableTurns?`（可选布尔，缺省开，测试字面量不必全改）
- **先不要后台 checkbox**，避免和管理设置搅在一起。要用 env / 代码默认值就够。若对照需要关：`.env` 写 `DROP_EMPTY_DURABLE_TURNS=false`。

extract 侧始终把占位收成 `empty`（纯函数、好测）。runner 读开关：关上则 `empty` 保持今天行为（400 或你们选择的旧路径）。更干净的做法：关上时把占位当普通 `new_user` 发出去——那才是「恢复今天」。所以：

- **关**：`hasSendableUserIntent` 不调用，空串才 `empty`（旧 extract）；`(no content)` 仍 `new_user`。
- **开**：占位也 `empty`，runner noop。

开关放 extract 或 runner 一处即可，不要两处各判一次。建议只放 extract + runner 对 `empty` 一律 noop（旧的「unchanged last user」也变成 noop 而不 400）。

「unchanged last user」以前 400。本任务顺手改成同样 noop：客户端重试同一轮不应再报错。`retryDurableTurn` 已经处理「kind=new_user 且文本相同」；extract 在无 hints 时几乎不会给出 unchanged-empty。若 extract 因 hints 给出 `empty`，noop 即可。

---

## 6. 建议文件

| 文件 | 动作 |
|---|---|
| `src/prompt-delta.ts` | `hasSendableUserIntent`；extract 用它收 `empty` |
| `src/cursor-runner.ts` | `empty` / 空 new_user：noop，禁止 fallback / 400 |
| `src/types.ts` | 可选 `dropEmptyDurableTurns?`（若开关放 config） |
| `src/config.ts` | 读 env，默认 true |
| `tests/prompt-delta.test.ts` | 占位 / 真问题 / 夹杂讨论 / 带 caveat 的空 query |
| `tests/cursor-durable-guardrails.test.ts` | 空轮 0 send、0 create；真 `new_user` 仍 send |
| `.env.example` | 一行说明 |
| `README.md` | 短一节：丢掉 Cursor 空轮，不打上游 |

不要改：`src/cursor-bot/**`、`model-params.ts`、key 池、500k 计划文件。

---

## 7. 测试清单

`hasSendableUserIntent`：

1. `""` / 空白 → false
2. `"(no content)"` / `"(NO CONTENT)"` → false  **（empty.json 实锤）**
3. anthropic 最后一条 `{ role: "user", content: "(no content)" }`（字符串，不是数组）→ `kind === "empty"`
4. `"<user_query>\\n(no content)\\n</user_query>"` → false（本机 harness 壳，防御）
5. 仅 caveat + 空 user_query → false
6. `"<user_query>另起一个计划</user_query>"` → true
7. `"请解释什么叫 (no content) 占位"` → true
8. `"<user_query>请解释 (no content)</user_query>"` → true

`extractDurableTurn` anthropic：

- 最后一条 user 为形状 3 → `kind === "empty"`
- 最后一条 user 为真问题 → `new_user`，userText 保留原样（不要剥掉 harness，send 仍发客户端原文；只用于是否 empty 的判定。若剥壳后再 send 会和 Cursor 对不齐。）
- 最后一条 user 是 tool_result → 仍 `tool_results`

runner：

- `durableTurn.kind === "empty"`：TrackingAgent `create` 次数 0，`sends.length === 0`，`result.text === ""`
- `new_user` + `userText: ""`：同上（兜底）
- `new_user` + 真文本：仍 1 次 send
- 现有 history_mismatch / retry 用例全绿

不要接真 Cursor 账号。

---

## 8. 明确不要做的事

- 不要 hook Bot 的 fetch / Stream。
- 不要按模型 id 过滤（不要只对 grok-4.6 丢掉空轮）。
- 不要在 `formatDurableUserMessage` 里把占位换成「请忽略」之类提示再发给上游。
- 不要为了空轮去 `drop+create` 或 `applyCursorSdkNetworkConfig`。
- 不要把 Fast / Max Mode / 500k 和这件事做成一个开关。
- 不要用正则误伤用户真正文。
- 不要在 noop 时 `touchSlotHistory`。

---

## 9. 验收

1. `npm test` 全绿。
2. Cursor 里对 SDK 任意模型（至少抽测 Composer 与 Grok）：发一句真问题有回复；工具跑完或 slash command 空 stdout 之后 **不再**冒出「没看到问题」类回复。
3. 下一句真问题仍走 durable 增量（没被粘性 stateless）。若被粘住，按第 3 节 digest 补丁做，不要整段回滚。
4. Bot / `bot/` 前缀行为与今天一致。

---

## 10. 实施顺序

1. `hasSendableUserIntent` + `prompt-delta` 测试绿。
2. extract 接入；旧 empty 用例（空串）保持 `empty`。
3. runner noop，改护栏测试；禁止 fallback。
4. env 开关 + `.env.example` / README。
5. 全量 `npm test`。有 Cursor 会话时用 SDK 路线实点一轮空轮 + 下一句真问题（不必限定 Grok）。
