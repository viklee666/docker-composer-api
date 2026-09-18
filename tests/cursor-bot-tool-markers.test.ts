import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponseNormalizer } from "../src/cursor-bot/response-normalizer.js";
import {
  ToolMarkerFilter,
  markerEventsFromText,
  markerFlushEvents,
  parseToolMarkers
} from "../src/cursor-bot/tool-markers.js";
import {
  InferenceStreamResponse,
  InferenceTextStreamPart,
  InferenceToolCallStreamPart
} from "../src/cursor-bot/proto/inference_pb.js";

/** 正文中一段完整的标记（name + 字符串化 arguments，OpenAI 原生形态）。 */
const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const oneCall = OPEN + "{\"name\":\"Bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}" + CLOSE;

function textFrame(text: string, isFinal = false): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "textPart", value: new InferenceTextStreamPart({ text, isFinal }) }
  });
}

function toolFrame(part: Partial<InferenceToolCallStreamPart>): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "toolCallPart", value: new InferenceToolCallStreamPart(part) }
  });
}

function drain(normalizer: ResponseNormalizer, frames: InferenceStreamResponse[]) {
  const events = [];
  for (const frame of frames) events.push(...normalizer.accept(frame));
  events.push(...normalizer.flush());
  return events;
}

/* ------------------------------------------------------------- 非流式解析 */

test("a full marker in the body becomes a tool call and leaves no residue", () => {
  const parsed = parseToolMarkers("先看目录 " + oneCall + " 再决定");
  assert.deepEqual(parsed.text, "先看目录  再决定");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Bash");
  assert.deepEqual(parsed.toolCalls[0].arguments, { command: "ls" });
  assert.match(parsed.toolCalls[0].id, /^call_[0-9a-f]{32}$/);
});

test("two markers in one body both parse", () => {
  const two = oneCall + OPEN + '{"name":"Read","arguments":{"path":"a"}}' + CLOSE;
  const parsed = parseToolMarkers(two);
  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.toolCalls.map((call) => call.name), ["Bash", "Read"]);
  assert.equal(parsed.text.trim(), "");
});

test("a broken marker is kept verbatim instead of vanishing", () => {
  const broken = OPEN + "not json at all" + CLOSE;
  const parsed = parseToolMarkers(broken);
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(parsed.text, broken);
});

test("a missing name makes the marker unparseable and it stays as text", () => {
  const anonymous = OPEN + '{"arguments":{}}' + CLOSE;
  const parsed = parseToolMarkers(anonymous);
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(parsed.text, anonymous);
});

test("fenced markers survive the code fence stripping", () => {
  const fenced = OPEN + "\u0060\u0060\u0060json\n{\"name\":\"Grep\",\"arguments\":{}}\n\u0060\u0060\u0060" + CLOSE;
  const parsed = parseToolMarkers(fenced);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Grep");
});

test("a custom id is preserved instead of being regenerated", () => {
  const withId = OPEN + '{"id":"toolu_01ABC","name":"Read","arguments":{}}' + CLOSE;
  const parsed = parseToolMarkers(withId);
  assert.equal(parsed.toolCalls[0].id, "toolu_01ABC");
});

const leakedLuna =
  "我先读取并梳理这份计划，随后用中文概括目标、实施步骤、涉及文件和潜在风险。" +
  ' to=Read 代上 code: {"path":"E:\\\\docker-composer-api\\\\grok-500k-context\\\\docker-composer-api-500k-plan.md"}' +
  "嗷 to=Read code: {\"path\":\"E:\\\\docker-composer-api\\\\grok-500k-context\\\\docker-composer-api-500k-plan.md\"}" +
  " у to=Read (json在线观看中文字幕) {\"path\":\"E:\\\\docker-composer-api\\\\grok-500k-context\\\\docker-composer-api-500k-plan.md\"}";

test("to=Read junk {json} is stripped from the body and becomes a tool call", () => {
  const parsed = parseToolMarkers(leakedLuna);
  assert.equal(parsed.toolCalls.length, 3);
  assert.ok(parsed.toolCalls.every((call) => call.name === "Read"));
  assert.equal(
    parsed.toolCalls[0].arguments.path,
    "E:\\docker-composer-api\\grok-500k-context\\docker-composer-api-500k-plan.md"
  );
  assert.equal(parsed.text.includes("to="), false);
  assert.match(parsed.text, /我先读取并梳理这份计划/);
});

test("to=functions.Read drops the functions. prefix", () => {
  const parsed = parseToolMarkers('go to=functions.Read code {"path":"a.ts"}');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Read");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "a.ts" });
});

test("streaming: to=Read split across chunks is reassembled and not leaked", () => {
  const filter = new ToolMarkerFilter();
  const events = [
    ...markerEventsFromText(filter, "先看 "),
    ...markerEventsFromText(filter, "to=Re"),
    ...markerEventsFromText(filter, 'ad code: {"path":"a.md"}'),
    ...markerFlushEvents(filter)
  ];
  const calls = events.filter((event) => event.type === "tool_call");
  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolCall.name, "Read");
  assert.deepEqual(calls[0].toolCall.arguments, { path: "a.md" });
  assert.equal(text.includes("to="), false);
  assert.equal(text.trim(), "先看");
});

test("normalizer drops a structured Read that duplicates an earlier to=Read", () => {
  const readTool = {
    name: "Read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  };
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true, tools: [readTool] });
  const events = drain(normalizer, [
    textFrame('先看 to=Read code: {"path":"a.md"}'),
    toolFrame({ toolCallId: "c1", toolName: "Read", args: '{"path":"a.md"}', isComplete: true })
  ]);
  const calls = events.filter((event) => event.type === "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolCall.name, "Read");
  assert.equal(normalizer.state.text.includes("to="), false);
  assert.match(normalizer.state.text, /先看/);
});

test("<|recipient|>Shell {json} is stripped and becomes a Shell call", () => {
  const parsed = parseToolMarkers(
    '先执行。<|recipient|>Shell {"command":"Get-Location","working_directory":"E:\\\\docker-composer-api"}'
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Shell");
  assert.equal(parsed.toolCalls[0].arguments.command, "Get-Location");
  assert.equal(parsed.text.includes("<|recipient|>"), false);
  assert.match(parsed.text, /先执行/);
});

test("<|recipient|>Glob<|content|>{json}<|end|> is stripped and becomes a Glob call", () => {
  const parsed = parseToolMarkers(
    '<|recipient|>Glob<|content|>{"glob_pattern":"README*","path":"E:\\\\docker-composer-api"}<|end|>'
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Glob");
  assert.equal(parsed.toolCalls[0].arguments.glob_pattern, "README*");
  assert.equal(parsed.text.includes("<|recipient|>"), false);
  assert.equal(parsed.text.includes("<|content|>"), false);
});

test("to=Shell envelope JSON unwraps to the inner arguments", () => {
  const parsed = parseToolMarkers(
    'to=Shell junk {"name":"Shell","arguments":{"command":"Get-Location","working_directory":"E:\\\\docker-composer-api"}}'
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Shell");
  assert.equal(parsed.toolCalls[0].arguments.command, "Get-Location");
  assert.equal(parsed.toolCalls[0].arguments.name, undefined);
});

test("bare argument JSON without a name tag infers Shell and Read", () => {
  const parsed = parseToolMarkers(
    '正在执行只读目录检查。{"command":"Get-Location","block_until_ms":1000}{"path":"E:\\\\docker-composer-api\\\\package.json","limit":40}'
  );
  assert.deepEqual(parsed.toolCalls.map((call) => call.name), ["Shell", "Read"]);
  assert.equal(parsed.toolCalls[1].arguments.path, "E:\\docker-composer-api\\package.json");
  assert.equal(parsed.text.includes("{"), false);
  assert.match(parsed.text, /正在执行只读目录检查/);
});

/* -------------------------------------------------------------- 流式过滤 */

test("streaming: marker split across chunks is reassembled", () => {
  const filter = new ToolMarkerFilter();
  const chunks = [
    "先看目录 " + OPEN.slice(0, 5),
    OPEN.slice(5) + '{"name":"Ba',
    'sh","arguments":{"command":"ls"}}' + CLOSE
  ];
  let text = "";
  const calls = [];
  for (const chunk of chunks) {
    for (const event of markerEventsFromText(filter, chunk)) {
      if (event.type === "tool_call") calls.push(event.toolCall);
      else if (event.type === "text") text += event.text;
    }
  }
  for (const event of markerFlushEvents(filter)) {
    if (event.type === "text") text += event.text;
  }
  assert.equal(text.trim(), "先看目录");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Bash");
  assert.deepEqual(calls[0].arguments, { command: "ls" });
});

test("streaming: a partial open marker at the tail is held, not leaked", () => {
  const filter = new ToolMarkerFilter();
  const safe = filter.push("正文" + OPEN.slice(0, 6));
  // 尾部 6 个字符是 marker 前缀，必须暂扣等待下一个 chunk，不能先漏出去。
  assert.equal(safe, "正文");
  const rest = filter.push(OPEN.slice(6) + '{"name":"Read","arguments":{}}' + CLOSE + "结尾");
  const calls = filter.takeToolCalls();
  const held = filter.takeHeldText();
  // 标记闭合后：调用解析出来，marker 之后的正文从 held 恢复。
  assert.equal(calls.length, 1);
  assert.equal(rest + held, "结尾");
});

test("streaming: plain text with no markers passes through untouched", () => {
  const filter = new ToolMarkerFilter();
  const events = markerEventsFromText(filter, "就是一段普通回复，没有任何标记。");
  assert.deepEqual(events, [{ type: "text", text: "就是一段普通回复，没有任何标记。" }]);
  assert.deepEqual(markerFlushEvents(filter), []);
});

test("streaming: an unclosed marker is released as text at flush", () => {
  const filter = new ToolMarkerFilter();
  const events = markerEventsFromText(filter, "开头 " + OPEN + "body never closes");
  assert.deepEqual(events, [{ type: "text", text: "开头 " }]);
  const tail = markerFlushEvents(filter);
  // 未闭合的 marker 原文不能凭空蒸发。
  assert.deepEqual(tail, [{ type: "text", text: OPEN + "body never closes" }]);
});

test("streaming: an unclosed marker beyond 64KB is released as plain text, not buffered forever", () => {
  const filter = new ToolMarkerFilter();
  // marker 已开但迟迟不闭合：超过上限（按 UTF-16 code unit 计）必须整段放行，避免无界缓冲。
  const big = OPEN + "x".repeat(64 * 1024);
  const safe = filter.push(big);
  assert.equal(safe, big, "超限后按普通文本放行");
  assert.deepEqual(filter.takeToolCalls(), []);
  assert.equal(filter.flush(), "", "放行之后缓冲清空，flush 无残文");
});

test("streaming: text after the first marker is held until the call is emitted", () => {
  const filter = new ToolMarkerFilter();
  const events = [
    ...markerEventsFromText(filter, "前文 " + oneCall + " 后文"),
    ...markerFlushEvents(filter)
  ];
  // 顺序语义：前文 → 后文（held 补放）→ 工具调用。后文不能先于工具调用下发。
  const toolCallEvents = events.filter((event) => event.type === "tool_call");
  const textEvents = events.filter((event) => event.type === "text");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.name, "Bash");
  assert.deepEqual(textEvents.map((event) => event.text), ["前文 ", " 后文"]);
  // 工具调用必须在后文之前。
  assert.ok(events.indexOf(toolCallEvents[0]) > events.indexOf(textEvents[0]));
  assert.ok(events.indexOf(toolCallEvents[0]) > events.indexOf(textEvents[1]));
});

/* ---------------------------------------------------- ResponseNormalizer */

test("normalizer with markers on reconstitutes a tool_call from body text", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true });
  const events = drain(normalizer, [textFrame("我来查一下 " + oneCall), textFrame("", true)]);
  const toolCallEvents = events.filter((event) => event.type === "tool_call");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.name, "Bash");
  // 已消费的标记不得残留在正文里。
  assert.ok(!normalizer.state.text.includes(OPEN));
  assert.equal(normalizer.state.text.trim(), "我来查一下");
  assert.equal(normalizer.result().toolCalls.length, 1);
});

test("normalizer without markers leaves marker text as plain body", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [textFrame("示例：" + oneCall), textFrame("", true)]);
  // 未声明 tools 的轮次不解析：模型讨论 XML 是正常行为，不能误拆。
  assert.deepEqual(events.filter((event) => event.type === "tool_call"), []);
  assert.equal(normalizer.state.text, "示例：" + oneCall);
  assert.deepEqual(normalizer.result().toolCalls, []);
});

test("normalizer result() strips consumed markers from the aggregated text", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true });
  drain(normalizer, [textFrame(oneCall + "完成")]);
  const result = normalizer.result();
  assert.equal(result.text.trim(), "完成");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "Bash");
});

test("structured tool_call frames and body markers can coexist", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true });
  // 上游有时回结构化帧、有时回正文标记：两条通道的调用都要活下来。
  const events = drain(normalizer, [
    textFrame(oneCall),
    toolFrame({ toolCallId: "c9", toolName: "Read", args: '{"path":"a"}', isComplete: true })
  ]);
  const names = events.filter((event) => event.type === "tool_call").map((event) => event.toolCall.name);
  assert.deepEqual(names.sort(), ["Bash", "Read"]);
  assert.equal(normalizer.result().toolCalls.length, 2);
});

/* ------------------------------------------- 声明过滤与别名归一（包 F 复审） */

const bashTool = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } } }
};

test("marker tool calls not declared by the caller are dropped", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true, tools: [bashTool] });
  const undeclared = OPEN + '{"name":"NotARealTool","arguments":{}}' + CLOSE;
  const events = drain(normalizer, [textFrame("幻觉调用 " + undeclared)]);
  // 与 SDK 侧 keepDeclaredOnly 同口径：客户端没声明的工具名不转发。
  assert.deepEqual(events.filter((event) => event.type === "tool_call"), []);
  assert.deepEqual(normalizer.result().toolCalls, []);
});

test("structured Readfile frames collapse to the declared Read tool", () => {
  const readTool = {
    name: "Read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  };
  const normalizer = new ResponseNormalizer({ tools: [readTool] });
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "c1", toolName: "Readfile", args: '{"target_file":"a.ts"}', isComplete: true })
  ]);
  const calls = events.filter((event) => event.type === "tool_call").map((event) => event.toolCall);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Read");
  assert.deepEqual(calls[0].arguments, { path: "a.ts" });
});

test("marker tool call names are alias-normalized (shell → Bash)", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true, tools: [bashTool] });
  const aliased = OPEN + '{"name":"shell","arguments":{"command":"ls"}}' + CLOSE;
  const events = drain(normalizer, [textFrame(aliased)]);
  const calls = events.filter((event) => event.type === "tool_call").map((event) => event.toolCall);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Bash", "别名归一到声明侧的工具名");
  assert.deepEqual(calls[0].arguments, { command: "ls" });
  assert.equal(normalizer.result().toolCalls[0].name, "Bash");
});

test("marker tool calls without a declared-tool list pass through unchanged", () => {
  // 旧装配（不传 tools）：过滤与归一都不做，保持改造前行为。
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true });
  const events = drain(normalizer, [textFrame(oneCall)]);
  assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
});

test("flush tail text is folded into the aggregated result, not only the event stream", () => {
  const normalizer = new ResponseNormalizer({ parseToolMarkers: true });
  const events = drain(normalizer, [textFrame("结论在前 " + OPEN.slice(0, 6))]);
  // 尾部是未闭合 marker 的前缀：flush 作为正文放行，且必须进聚合口径——
  // 只出现在事件流里的话，聚合结果会比流式订阅者看到的少一截。
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.text),
    ["结论在前 ", OPEN.slice(0, 6)]
  );
  assert.equal(normalizer.result().text, "结论在前 " + OPEN.slice(0, 6));
});
