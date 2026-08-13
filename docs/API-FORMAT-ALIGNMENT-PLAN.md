# 对外 API 格式对齐计划(/v1/chat/completions、/v1/responses、/v1/messages)

> 供新会话执行。本文档自包含:背景、逐端点判定、分阶段任务、验收标准、参考资料。
> 范围仅限**对外(客户端可见)的 wire format**;内部仍是"对外格式 → Cursor SDK 上游"的转换,内部转换逻辑不在本计划范围内,除非对外格式修复需要内部补充数据(已逐条注明)。

## 0. 背景与结论

两份调研已完成(2026-08-13):

1. **本项目对外格式审计**:逐字段对照 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 官方规范,偏差按 `BREAKS-CLIENTS`(标准客户端会坏)/ `SPEC-GAP`(违规但多数客户端容忍)/ `COSMETIC` 定级。
2. **CLIProxyAPI 参考实现调研**:基于 router-for-me/CLIProxyAPI@`f43aad7`(2026-08-12,47k stars,被 Claude Code / Codex 生态大量使用),提取了三端点的完整对外事件状态机与字段形状,含源码文件级引用。

**总体判定**(按用户标准:格式正确的不动,不正确的参考 CLIProxyAPI 修):

| 端点 | 判定 | 处置 |
|---|---|---|
| `/v1/chat/completions` | 基本正确,3 处破坏性问题 | 局部修补(P0×2 + P1) |
| `/v1/responses` | **不合格**:工具解析格式就是错的,流式事件状态机残缺 | 按 CLIProxyAPI 状态机重做(P0) |
| `/v1/messages` | 基本正确,thinking/错误流/stop_reason 有缺口 | 局部修补(P1) |
| 错误信封 & 状态码 | 主结构正确,taxonomy 与状态码映射有缺口 | 修补(P1) |

**能力边界(明确不修,写入 README 即可)**:`max_tokens`/`temperature`/`top_p`/`stop`/`response_format`/`text.format` 等行为参数 Cursor SDK 不支持,无法真正生效。CLIProxyAPI 在 Codex 上游也同样丢弃这些参数(它甚至主动删除 temperature/top_p),所以"接受但不生效"本身不算不合格——但 README 声称"采样参数作为提示词附注传递"与实际代码不符,需要改 README 或实现该附注(二选一,见 P2-6)。

---

## 1. `/v1/chat/completions` —— 局部修补

### 判定为正确、不动的部分
- 非流式对象骨架:`id/object/created/model/choices[].{index,message,logprobs,finish_reason}/usage`,`message.refusal:null`、`annotations:[]` 均已合规。
- 流式:首块 `delta.role`、text delta、tool_calls delta(一次性完整 arguments 是合法粒度,CLIProxyAPI 的 Gemini/Claude 路径也这么做)、finish chunk、`data: [DONE]`。
- `reasoning_content` 扩展字段:与 CLIProxyAPI 的统一约定一致(流式 `delta.reasoning_content`),保留。
- 错误信封 `{error:{message,type,param,code}}` 主结构。

### P0-1 `stream_options.include_usage` 语义(BREAKS-CLIENTS)
现状:无论客户端是否请求,总是追加一个 `choices:[]` 的 usage chunk。大量无脑取 `choices[0]` 的消费端会崩。
改法(对齐官方语义,比 CLIProxyAPI 更严格——它的合成路径也没做对,不作参考):
- 解析 `stream_options.include_usage`(`src/protocol.ts` 的 `basePrepared`,存入 `PreparedRequest`)。
- 未请求时:**不发** usage chunk(usage 并入 finish chunk 也不行,直接不发独立块;可把 usage 放进 finish chunk 同一对象里?官方是"不含 usage"——finish chunk `usage` 字段省略)。
- 请求时:按官方规范,所有普通 chunk 带 `usage: null`,最后一个 `choices:[]` chunk 带完整 usage。
- 位置:`src/server.ts` `chatStream`。
- 测试:两种模式各一条,断言 usage chunk 是否存在、普通 chunk 的 `usage:null`。

### P0-2 流中错误事件(BREAKS-CLIENTS,三端点通用)
现状:SSE 已开始后 runner 抛错 → 连接直接截断,无任何终止标记。
改法(参考 CLIProxyAPI 的三套约定,`sdk/api/handlers/`):
- chat:`data: {"error":{"message":"...","type":"server_error","code":"..."}}` 后关闭,**不发** `[DONE]`。
- responses:`event: error` + `data: {"type":"error","code":"server_error","message":"...","sequence_number":<接续>}`(或对 Codex 类客户端 `response.failed`,首期只做 `error` 事件即可)。
- messages:`event: error` + `data: {"type":"error","error":{"type":"api_error","message":"..."}}`,不补 `message_stop`。
- 实现:在 `src/server.ts` 三个 stream 生成器外层各包一个 try/catch(注意与 `withStreamLog` 的日志逻辑协调:错误已发给客户端,日志记真实 status)。
- 测试:FakeRunner 中途抛错,断言各端点的错误事件形状,且 chat 不出现 `[DONE]`。

### P1-3 请求解析宽容度
- `logprobs: false` / `top_logprobs` 不应 400(`rejectCommonUnsupported` 只在 `logprobs===true` 时拒绝;`top_logprobs` 对 Responses 是合法参数,移出公共拒绝列表)。
- `max_completion_tokens` 纳入解析(与 `max_tokens` 同义,虽不生效但不应表现不一致)。
- 位置:`src/protocol.ts`。

### P2-4 非流式 `message.reasoning_content`
CLIProxyAPI 非流式把推理放 `message.reasoning_content`。本网关 run() 聚合器目前丢弃 thinking。改法:`CursorRunner.run()` 聚合 thinking 文本,`chatCompletionObject` 在有值时输出 `message.reasoning_content`。涉及 `src/cursor-runner.ts` run()、`src/key-rotating-runner.ts` run()、`src/protocol.ts`。

---

## 2. `/v1/responses` —— 按 CLIProxyAPI 状态机重做(P0)

这是唯一判定"不合格"的端点。现状五个致命问题:工具定义解析用了 Chat 的嵌套格式(官方扁平格式被静默丢弃)、全部事件缺 `sequence_number`、无 `response.function_call_arguments.delta/done`、`response.created/in_progress` 不是完整 Response 快照、`store:false` 仍持久化。

### P0-5 请求:工具解析改为 Responses 扁平格式
```json
{"type":"function","name":"lookup","description":"...","parameters":{...},"strict":true}
```
- `src/protocol.ts` `prepareOpenAiResponses` 停止复用 `parseOpenAiTools`,新写 `parseResponsesTools`:支持扁平 function(必须)、`custom` 工具(可选,首期可跳过但不静默丢——不认识的工具类型记日志)。
- **注意**:现有测试用的就是错误的嵌套格式,要一并改正(`tests/server.test.ts` 两个 responses 工具测试)。
- 同时:`function_call_output.output` 为字符串时不要再二次 `JSON.stringify`。

### P0-6 流式:完整事件状态机
对齐 CLIProxyAPI 的合成器(`internal/translator/*/openai/responses/*_response.go`)与官方规范:

1. **`sequence_number`**:从 1 起对本次响应内所有事件全局递增。实现一个 `let seq = 1;` 计数器,`sse()` 调用处统一注入。
2. **完整 Response 快照**:`response.created` / `response.in_progress` / `response.completed` 的 `response` 对象补齐官方字段:`instructions、max_output_tokens、model、reasoning、temperature、top_p、text、truncation、user、metadata、parallel_tool_calls、tool_choice、tools、store、background、error、incomplete_details`(无值的回显请求值或 null;`parallel_tool_calls`/`tool_choice` 回显请求而非硬编码)。抽一个 `responseSnapshot(prepared, status, output?)` 助手,非流式 `responseObject` 复用同一实现(消除两处漂移)。
3. **function_call 事件序列**:
```text
response.output_item.added   (item: {id:"fc_<uuid>", type:"function_call", status:"in_progress", call_id:"call_*", name, arguments:""})
response.function_call_arguments.delta  (item_id, output_index, delta:<完整JSON一次发出即可>)
response.function_call_arguments.done   (item_id, output_index, arguments:<完整JSON>)
response.output_item.done    (item: {... status:"completed", arguments:<完整JSON>})
```
   item `id` 用 `fc_` 前缀、`call_id` 保持 `call_*`(CLIProxyAPI 惯例 `fc_<callID>`)。非流式 `responseToolCallItem` 同步:`id: fc_*`,`call_id: call_*`(当前两者同值)。
4. **`output_index` 连续分配**:用递增计数器替代现在的 `(textStarted ? 1 : 0) + toolCalls.length - 1`(工具先于文本时会撞 index 0)。
5. **reasoning item**(替换现在的 `: thinking` SSE 注释):
```text
response.output_item.added   (item: {id:"rs_*", type:"reasoning", summary:[]})
response.reasoning_summary_part.added
response.reasoning_summary_text.delta*
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done    (item 含 summary:[{type:"summary_text",text:<全文>}])
```
   thinking 事件已由 runner 产出,只是这里换协议表达;非流式 `output[]` 里也加对应 reasoning item(需要 run() 聚合 thinking,与 P2-4 共用)。保活效果由真实事件天然达成,删除 `: thinking` 注释。
6. **`output_text.delta` 带 `logprobs:[]`**,`output_text` content part 带 `logprobs:[]`(官方 schema 现字段)。
7. **终止事件**:成功 `response.completed`;失败 `event: error`(P0-2);不发 `[DONE]`(现状正确,保持)。

### P0-7 `store:false` 语义(数据保留契约)
`store === false` 时**不调用** `saveResponse`(非流式与流式两处,`src/server.ts`),`previous_response_id` 引用不存在时维持现有 404。`metadata` 不再被塞入 `store` 键(`basePrepared` 里分离存储)。

### P1-8 usage 形状
`input_tokens_details.cached_tokens: 0` 保留;`output_tokens_details.reasoning_tokens` 用 thinking 字符 `/4` 估算(CLIProxyAPI Claude 路径同款做法),不再恒 0。

---

## 3. `/v1/messages` —— 局部修补

### 判定为正确、不动的部分
- 基础事件序列 `message_start → content_block_* → message_delta → message_stop`,SSE `event:` 与 JSON `type` 一致。
- text 块、tool_use 块(`start.input:{}` + 一次完整 `input_json_delta`——CLIProxyAPI 的 OpenAI/Gemini 路径同款粒度)。
- `message_delta.usage.output_tokens` 累计语义。
- 工具 id `call_*` 前缀:规范只要求 opaque string,CLIProxyAPI 也不保证 `toolu_*`,不改。
- 不发 `ping`:官方为 "may include",CLIProxyAPI 合成路径也不发,不改。
- 历史 `thinking`/`redacted_thinking` 不进 prompt(上轮已实现),保留。

### P1-9 thinking 块形状(BREAKS-CLIENTS)
- `content_block_start` 的 thinking 块补 `signature:""` 字段:`{type:"thinking", thinking:"", signature:""}`(严格 union 解码器需要)。
- 伪签名保留现状(网关无真实签名可给;CLIProxyAPI 在 OpenAI 上游同样无 signature 可携带)。在 README 明确标注:**本网关的 thinking 签名不可跨 provider 回传验证**。
- 仅当客户端请求启用了 thinking(请求带 `thinking` 字段或推理强度意图)才输出 thinking 块;未请求时丢弃(现状是无条件输出)。`PreparedRequest` 已有 intent 可判断。
- 非流式响应在启用 thinking 时返回 `{type:"thinking", thinking:<全文>, signature:<占位>}` 内容块(依赖 run() 聚合 thinking,见 P2-4)。

### P1-10 stop_reason 与错误映射
- `max_tokens`/`stop_sequence` 等 stop_reason 上游不可得,维持 `end_turn`/`tool_use`(能力边界,README 注明)。
- 错误 taxonomy 补全(`src/errors.ts` `anthropicErrorType`):402→`billing_error`、404→`not_found_error`(已有则确认)、413→`request_too_large`、429→`rate_limit_error`、504→`timeout_error`、529→`overloaded_error`,其余 5xx→`api_error`;响应体加顶层 `request_id`(生成 uuid,同时设 `request-id` 响应头)。
- `message_start.usage` 形状保持,但补 `cache_creation_input_tokens:0`、`cache_read_input_tokens:0`(常见客户端读取这些字段做统计)。

### P2-11 请求宽容度
- `max_tokens` 缺失不再默默放行——官方必填,但为兼容宽松客户端仅记日志不拒绝(维持现状,文档注明)。
- `document` 块:维持 400(能力边界),但错误信息注明是网关限制。

---

## 4. 错误信封与 HTTP 状态(P1-12)

`src/errors.ts` / `src/server.ts`:
- OpenAI `type` 字段改用官方 taxonomy:4xx 参数类 → `invalid_request_error`,401 → `authentication_error`,403 → `permission_error`,429 → `rate_limit_error`,5xx → `server_error`;具体语义保留在 `code`(参考 CLIProxyAPI `sdk/api/handlers/handlers.go:L33-L98` 的映射表)。
- `normalizeError` 尊重普通 Error 上的 `statusCode`(Fastify 的 400 JSON 解析错、413 body 超限,当前被改写成 500)。
- 499(客户端断连)仅用于内部日志,对外不可能送达,无需改;非流式超时对外改用 504 + `timeout_error`(现在可能透出 499)。
- 402 直传 key 的额度错误:OpenAI 端点改 429 + `insufficient_quota`(官方无 402);Anthropic 端点 402 + `billing_error` 合规,保留。

---

## 5. 不改动清单(判定正确或刻意保留)

| 项 | 理由 |
|---|---|
| chat `id` 前缀 `chatcmpl_`、messages `msg_`、models `created:0` | 规范只要求唯一字符串;CLIProxyAPI 也不保证前缀 |
| `cursor_agent_id`/`cursor_run_id`/`cursor_parameters` 扩展字段 | 有用的可观测性;宽松客户端忽略 |
| usage 为 chars/4 估算 | Cursor SDK 不透出 token 计数(getUsage 对本账号 feature_unavailable);README 已注明,补充"不可用于计费"措辞 |
| 采样/长度参数不生效 | Cursor SDK 能力边界;CLIProxyAPI 对 Codex 上游同样丢弃 |
| `/v1/models` 宽容鉴权 | 设计如此,README 已注明 |
| `n>1`、`audio`、`modalities`、内置工具(web search 等) | 明确 400 或忽略,能力边界 |
| Responses 不发 `[DONE]` | 正确行为 |

---

## 6. 执行顺序与验收

建议按 P0-5 → P0-6 → P0-7 → P0-1 → P0-2 → P1(9,10,12,8,3) → P2(4,11,6) 执行,每项独立提交。

**P2-6(二选一)**:实现 README 所述"采样参数作为提示词附注"(在合成 prompt 尾部追加 `CONSTRAINTS: max_tokens≈N, stop=[...]` 提示行),或删除 README 中该句。推荐后者(提示词附注不可靠且污染 prompt)。

验收标准:
1. `npm run typecheck` + `npm test` 全绿;每个修复项配 wire-format 回归测试(断言精确 JSON 形状与事件顺序,不只是"事件存在")。
2. 用**官方 SDK** 做 E2E 冒烟(`.env` 有真实 key,本地起服务):
   - `openai` npm 包:`chat.completions.create`(stream + 非流,带工具)、`responses.create`(stream + 非流,带扁平工具定义)——重点验证 SDK 内置的流式 accumulator 不报错、工具调用能完整取出;
   - `@anthropic-ai/sdk`:`messages.create` + `messages.stream`(带工具与 thinking)——验证 `finalMessage()` 聚合成功;
   - Claude Code 实测一轮工具调用往返。
3. 流中错误:kill 上游/用假 key 触发,三端点各自出现规范的错误事件而非裸断连。
4. `store:false` 创建的 response,GET `/v1/responses/:id` 返回 404。

## 7. 关键参考

- 本项目涉改文件:`src/protocol.ts`(请求解析/响应对象)、`src/server.ts`(三个 SSE 生成器/错误处理)、`src/errors.ts`(信封与映射)、`src/cursor-runner.ts` + `src/key-rotating-runner.ts`(run() 聚合 thinking)、`tests/server.test.ts`。
- CLIProxyAPI(commit `f43aad7`)关键文件:
  - Responses 状态机:`internal/translator/claude/openai/responses/claude_openai-responses_response.go:L234-L714`、`internal/translator/openai/openai/responses/openai_openai-responses_response.go:L216-L694`
  - 流中错误:`sdk/api/handlers/openai_responses_stream_error.go:L56-L210`、`sdk/api/handlers/claude/code_handlers.go:L219-L481`
  - 错误映射:`sdk/api/handlers/handlers.go:L33-L98`
- 官方规范:OpenAI Chat/Responses API reference(含 streaming-events 子页)、Anthropic Messages API + streaming + errors 文档。
- 两份完整调研报告见本会话(2026-08-13):对外格式审计(逐字段偏差表)、CLIProxyAPI 格式调研(逐端点事件形状与源码引用)。
