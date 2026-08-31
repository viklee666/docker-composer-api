import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicTokenCount,
  anthropicUsage,
  effectiveUsage,
  openAiUsage,
  prepareAnthropicMessages,
  prepareOpenAiChat,
  prepareOpenAiResponses,
  responsesUsage
} from "../src/protocol.js";
import { normalizeSystemPromptSettings, resolveSystemText, systemPromptActive } from "../src/system-prompt.js";
import type { RequestUsage, SystemPromptSettings } from "../src/types.js";

const CLIENT = "CLIENT RULES";
const GATEWAY = "GATEWAY RULES";

const append: SystemPromptSettings = { mode: "append", text: GATEWAY };
const override: SystemPromptSettings = { mode: "override", text: GATEWAY };
const off: SystemPromptSettings = { mode: "off", text: GATEWAY };

// ---------------------------------------------------------------------------
// normalizeSystemPromptSettings
// ---------------------------------------------------------------------------

test("normalizeSystemPromptSettings trims text and keeps valid combinations", () => {
  assert.deepEqual(normalizeSystemPromptSettings("append", "  hello  "), { mode: "append", text: "hello" });
  assert.deepEqual(normalizeSystemPromptSettings("override", "hello"), { mode: "override", text: "hello" });
  // off 保留正文，后台在三种 mode 之间来回切时不丢草稿。
  assert.deepEqual(normalizeSystemPromptSettings("off", "hello"), { mode: "off", text: "hello" });
  assert.deepEqual(normalizeSystemPromptSettings("  APPEND  ", "hello"), { mode: "append", text: "hello" });
});

test("normalizeSystemPromptSettings downgrades empty text and unknown modes to off", () => {
  assert.deepEqual(normalizeSystemPromptSettings("append", "   \n\t  "), { mode: "off" });
  assert.deepEqual(normalizeSystemPromptSettings("append", ""), { mode: "off" });
  assert.deepEqual(normalizeSystemPromptSettings("append", undefined), { mode: "off" });
  assert.deepEqual(normalizeSystemPromptSettings("append", 42), { mode: "off" });
  assert.deepEqual(normalizeSystemPromptSettings("prepend", "hello"), { mode: "off", text: "hello" });
  assert.deepEqual(normalizeSystemPromptSettings(undefined, "hello"), { mode: "off", text: "hello" });
  assert.deepEqual(normalizeSystemPromptSettings(null, null), { mode: "off" });
});

// ---------------------------------------------------------------------------
// systemPromptActive
// ---------------------------------------------------------------------------

test("systemPromptActive is true only for a non-empty append/override prompt", () => {
  assert.equal(systemPromptActive(undefined), false);
  assert.equal(systemPromptActive({ mode: "off" }), false);
  assert.equal(systemPromptActive({ mode: "off", text: GATEWAY }), false);
  assert.equal(systemPromptActive({ mode: "append" }), false);
  assert.equal(systemPromptActive({ mode: "append", text: "" }), false);
  assert.equal(systemPromptActive({ mode: "append", text: "   \n  " }), false);
  assert.equal(systemPromptActive({ mode: "override", text: "   " }), false);
  assert.equal(systemPromptActive(append), true);
  assert.equal(systemPromptActive(override), true);
});

// ---------------------------------------------------------------------------
// resolveSystemText
// ---------------------------------------------------------------------------

test("resolveSystemText appends after the client system with one blank line", () => {
  assert.equal(resolveSystemText(CLIENT, append), `${CLIENT}\n\n${GATEWAY}`);
  // 客户端原文以换行结尾时不能多出空行。
  assert.equal(resolveSystemText(`${CLIENT}\n`, append), `${CLIENT}\n\n${GATEWAY}`);
  assert.equal(resolveSystemText(`${CLIENT}\n\n\n`, append), `${CLIENT}\n\n${GATEWAY}`);
  // 配置正文两侧的空白也要吃掉，结果不留首尾空行。
  assert.equal(resolveSystemText(CLIENT, { mode: "append", text: `\n  ${GATEWAY}  \n` }), `${CLIENT}\n\n${GATEWAY}`);
});

test("resolveSystemText with an empty client system yields the gateway text alone", () => {
  for (const clientSystem of ["", "   ", "\n\n", " \n \t "]) {
    const resolved = resolveSystemText(clientSystem, append);
    assert.equal(resolved, GATEWAY, `client system ${JSON.stringify(clientSystem)}`);
    assert.ok(!resolved.startsWith("\n"), "no leading blank line");
    assert.equal(resolved, resolved.trimEnd(), "no trailing whitespace");
  }
  assert.equal(resolveSystemText("", override), GATEWAY);
});

test("resolveSystemText override discards the client system entirely", () => {
  assert.equal(resolveSystemText(CLIENT, override), GATEWAY);
  assert.equal(resolveSystemText(`${CLIENT}\n`, override), GATEWAY);
  assert.equal(resolveSystemText(CLIENT, { mode: "override", text: `  ${GATEWAY}\n\n` }), GATEWAY);
});

test("resolveSystemText never blanks the client prompt when nothing is configured", () => {
  const inert: (SystemPromptSettings | undefined)[] = [
    undefined,
    off,
    { mode: "off" },
    { mode: "append" },
    { mode: "append", text: "" },
    { mode: "append", text: "   \n  " },
    { mode: "override", text: "" },
    { mode: "override", text: "\t\n " }
  ];
  for (const settings of inert) {
    // 原样返回：连客户端自己的尾部换行都不动，未启用时与改造前逐字节一致。
    assert.equal(resolveSystemText(CLIENT, settings), CLIENT, JSON.stringify(settings));
    assert.equal(resolveSystemText(`${CLIENT}\n `, settings), `${CLIENT}\n `, JSON.stringify(settings));
    assert.equal(resolveSystemText("", settings), "", JSON.stringify(settings));
  }
});

test("resolveSystemText tolerates an invalid mode coming from storage", () => {
  const bogus = { mode: "prepend", text: GATEWAY } as unknown as SystemPromptSettings;
  assert.equal(systemPromptActive(bogus), false);
  assert.equal(resolveSystemText(CLIENT, bogus), CLIENT);
});

// ---------------------------------------------------------------------------
// injection into the three protocol transcripts
// ---------------------------------------------------------------------------

const chatBody = {
  model: "composer-2.5",
  messages: [
    { role: "system", content: CLIENT },
    { role: "user", content: "hi" }
  ]
};

const responsesBody = { model: "composer-2.5", instructions: CLIENT, input: "hi" };

const anthropicBody = {
  model: "composer-2.5",
  max_tokens: 64,
  system: CLIENT,
  messages: [{ role: "user", content: "hi" }]
};

test("openai chat folds the gateway prompt into a system block ahead of the conversation", () => {
  const appended = prepareOpenAiChat(chatBody, { systemPrompt: append }).prompt;
  assert.ok(appended.includes(`SYSTEM:\n${CLIENT}\n\n${GATEWAY}\n\nConversation:`), appended);
  assert.ok(appended.indexOf(CLIENT) < appended.indexOf(GATEWAY), "client text first");
  // 系统级指令，不是一轮用户发言：整块都在 Conversation 之前。
  assert.ok(appended.indexOf(GATEWAY) < appended.indexOf("Conversation:"), "system block precedes the conversation");
  assert.ok(!appended.includes(`USER: ${GATEWAY}`));
  assert.ok(appended.includes("USER: hi"));
  // 上提之后不再有就地折进对话的那条 system 行。
  assert.ok(!appended.includes(`SYSTEM: ${CLIENT}`));

  const overridden = prepareOpenAiChat(chatBody, { systemPrompt: override }).prompt;
  assert.ok(!overridden.includes(CLIENT), overridden);
  assert.ok(overridden.includes(`SYSTEM:\n${GATEWAY}\n\nConversation:`), overridden);
  assert.ok(overridden.includes("USER: hi"));
});

test("openai chat hoists every system/developer turn and keeps them ordered before the gateway text", () => {
  const body = {
    model: "composer-2.5",
    messages: [
      { role: "system", content: "first" },
      { role: "user", content: "hi" },
      { role: "developer", content: "second" }
    ]
  };
  const prompt = prepareOpenAiChat(body, { systemPrompt: append }).prompt;
  assert.ok(prompt.includes(`SYSTEM:\nfirst\n\nsecond\n\n${GATEWAY}\n\nConversation:`), prompt);
  assert.ok(!prompt.includes("DEVELOPER: second"));
});

test("openai chat injects a system block even without any client system message", () => {
  const body = { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] };
  const prompt = prepareOpenAiChat(body, { systemPrompt: append }).prompt;
  assert.ok(prompt.includes(`SYSTEM:\n${GATEWAY}\n\nConversation:`), prompt);
  assert.ok(!prompt.includes("SYSTEM:\n\n"), "no leading blank line inside the system block");
});

test("openai chat with mode off is byte-identical to no settings at all", () => {
  const base = prepareOpenAiChat(chatBody).prompt;
  assert.equal(prepareOpenAiChat(chatBody, {}).prompt, base);
  assert.equal(prepareOpenAiChat(chatBody, { systemPrompt: off }).prompt, base);
  assert.equal(prepareOpenAiChat(chatBody, { systemPrompt: { mode: "append", text: "   " } }).prompt, base);
  // off 时 system 轮次仍然就地折进对话，不走上提。
  assert.ok(base.includes(`SYSTEM: ${CLIENT}`), base);
});

test("openai responses injects into the instructions block and leaves the echo untouched", () => {
  const appended = prepareOpenAiResponses(responsesBody, undefined, { systemPrompt: append });
  assert.ok(appended.prompt.includes(`INSTRUCTIONS:\n${CLIENT}\n\n${GATEWAY}\n\nINPUT:`), appended.prompt);
  assert.ok(appended.prompt.indexOf(CLIENT) < appended.prompt.indexOf(GATEWAY));
  // 回显必须还是客户端原值，注入只作用于合成 prompt。
  assert.equal(appended.responsesEcho?.instructions, CLIENT);

  const overridden = prepareOpenAiResponses(responsesBody, undefined, { systemPrompt: override });
  assert.ok(!overridden.prompt.includes(CLIENT), overridden.prompt);
  assert.ok(overridden.prompt.includes(`INSTRUCTIONS:\n${GATEWAY}\n\nINPUT:`), overridden.prompt);
  assert.equal(overridden.responsesEcho?.instructions, CLIENT);

  const withoutInstructions = prepareOpenAiResponses({ model: "composer-2.5", input: "hi" }, undefined, { systemPrompt: append });
  assert.ok(withoutInstructions.prompt.includes(`INSTRUCTIONS:\n${GATEWAY}\n\nINPUT:`), withoutInstructions.prompt);
  assert.equal(withoutInstructions.responsesEcho?.instructions, null);
});

test("openai responses with mode off is byte-identical to no settings at all", () => {
  const base = prepareOpenAiResponses(responsesBody).prompt;
  assert.equal(prepareOpenAiResponses(responsesBody, undefined, {}).prompt, base);
  assert.equal(prepareOpenAiResponses(responsesBody, undefined, { systemPrompt: off }).prompt, base);
  assert.equal(prepareOpenAiResponses(responsesBody, undefined, { systemPrompt: { mode: "override", text: "\n" } }).prompt, base);
});

/** 客户端把 system 写进 input[] 而不是顶层 instructions——官方 schema 允许，网关必须一视同仁。 */
const responsesInputSystemBody = {
  model: "composer-2.5",
  input: [
    { type: "message", role: "system", content: [{ type: "input_text", text: CLIENT }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }
  ]
};

test("openai responses hoists input[] system items into the instructions block", () => {
  const appended = prepareOpenAiResponses(responsesInputSystemBody, undefined, { systemPrompt: append }).prompt;
  assert.ok(appended.includes(`INSTRUCTIONS:\n${CLIENT}\n\n${GATEWAY}\n\nINPUT:`), appended);
  // 上提之后 INPUT: 里不能再留那条 SYSTEM 行，否则 override 分支根本删不干净。
  assert.ok(!appended.includes(`SYSTEM: ${CLIENT}`), appended);
  assert.ok(appended.includes("USER: hi"));

  const overridden = prepareOpenAiResponses(responsesInputSystemBody, undefined, { systemPrompt: override });
  assert.ok(!overridden.prompt.includes(CLIENT), overridden.prompt);
  assert.ok(overridden.prompt.includes(`INSTRUCTIONS:\n${GATEWAY}\n\nINPUT:`), overridden.prompt);
  assert.ok(overridden.prompt.includes("USER: hi"));
  // 上提只作用于合成 prompt：input_items 端点仍要逐字回显客户端发来的数组。
  assert.deepEqual(overridden.inputItems, responsesInputSystemBody.input);
});

test("openai responses folds top-level instructions and input[] system items in written order", () => {
  const body = {
    model: "composer-2.5",
    instructions: CLIENT,
    input: [
      // type 省略的 EasyInputMessage：不认的话它会以 JSON 块的形式把客户端 system 留在 INPUT: 里。
      { role: "developer", content: "developer rule" },
      { type: "message", role: "system", content: "second system" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }
    ]
  };
  const appended = prepareOpenAiResponses(body, undefined, { systemPrompt: append }).prompt;
  assert.ok(appended.includes(`INSTRUCTIONS:\n${CLIENT}\n\ndeveloper rule\n\nsecond system\n\n${GATEWAY}\n\nINPUT:`), appended);
  assert.ok(!appended.includes('"role":"developer"'), appended);
  assert.ok(appended.includes("USER: hi"));

  const overridden = prepareOpenAiResponses(body, undefined, { systemPrompt: override }).prompt;
  for (const text of [CLIENT, "developer rule", "second system"]) {
    assert.ok(!overridden.includes(text), `override 漏掉了「${text}」：${overridden}`);
  }
});

test("openai responses leaves input[] system items inline when the mode is off", () => {
  const base = prepareOpenAiResponses(responsesInputSystemBody).prompt;
  assert.equal(prepareOpenAiResponses(responsesInputSystemBody, undefined, {}).prompt, base);
  assert.equal(prepareOpenAiResponses(responsesInputSystemBody, undefined, { systemPrompt: off }).prompt, base);
  assert.equal(prepareOpenAiResponses(responsesInputSystemBody, undefined, { systemPrompt: { mode: "append", text: "  " } }).prompt, base);
  // off 时既不上提也不生成 INSTRUCTIONS 块，system 条目仍就地渲染在 INPUT: 里。
  assert.ok(base.includes(`SYSTEM: ${CLIENT}`), base);
  assert.ok(!base.includes("INSTRUCTIONS:"), base);
});

test("anthropic messages injects into the SYSTEM block", () => {
  const appended = prepareAnthropicMessages(anthropicBody, { systemPrompt: append }).prompt;
  assert.ok(appended.includes(`SYSTEM:\n${CLIENT}\n\n${GATEWAY}\n\nConversation:`), appended);
  assert.ok(appended.indexOf(CLIENT) < appended.indexOf(GATEWAY));

  const overridden = prepareAnthropicMessages(anthropicBody, { systemPrompt: override }).prompt;
  assert.ok(!overridden.includes(CLIENT), overridden);
  assert.ok(overridden.includes(`SYSTEM:\n${GATEWAY}\n\nConversation:`), overridden);

  // 客户端没有 system 时也要出现 SYSTEM 块，且不带前导空行。
  const bare = prepareAnthropicMessages({ model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, { systemPrompt: append }).prompt;
  assert.ok(bare.includes(`SYSTEM:\n${GATEWAY}\n\nConversation:`), bare);
});

test("anthropic messages with mode off is byte-identical to no settings at all", () => {
  const base = prepareAnthropicMessages(anthropicBody).prompt;
  assert.equal(prepareAnthropicMessages(anthropicBody, {}).prompt, base);
  assert.equal(prepareAnthropicMessages(anthropicBody, { systemPrompt: off }).prompt, base);
  assert.equal(prepareAnthropicMessages(anthropicBody, { systemPrompt: { mode: "append", text: "" } }).prompt, base);
});

test("count_tokens sees the injected prompt so budgets do not under-report", () => {
  const plain = prepareAnthropicMessages(anthropicBody, { countTokens: true });
  const injected = prepareAnthropicMessages(anthropicBody, { countTokens: true, systemPrompt: append });
  assert.ok(injected.prompt.includes(GATEWAY), injected.prompt);
  assert.ok(injected.prompt.length > plain.prompt.length);

  const counted = anthropicTokenCount(injected).input_tokens as number;
  const baseline = anthropicTokenCount(plain).input_tokens as number;
  assert.ok(counted > baseline, `${counted} > ${baseline}`);
  // 与真实请求同口径：count_tokens 与 /v1/messages 走的是同一段合成 prompt。
  assert.equal(counted, anthropicTokenCount(prepareAnthropicMessages(anthropicBody, { systemPrompt: append })).input_tokens);
});

// ---------------------------------------------------------------------------
// real vs estimated usage
// ---------------------------------------------------------------------------

const real: RequestUsage = {
  inputTokens: 1000,
  outputTokens: 300,
  cacheReadTokens: 700,
  cacheWriteTokens: 50,
  totalTokens: 2050,
  reasoningTokens: 120
};

test("effectiveUsage prefers the real usage and otherwise estimates by characters", () => {
  assert.equal(effectiveUsage(real, 4000, 4000), real);
  assert.deepEqual(effectiveUsage(undefined, 40, 8), {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12
  });
  assert.deepEqual(effectiveUsage(undefined, 0, 0), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0
  });
});

test("openai chat usage keeps the estimated shape when no real usage is reported", () => {
  const usage = openAiUsage(40, 8);
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  // 估不出缓存/推理，就不能凭空发 detail 字段。
  assert.deepEqual(Object.keys(usage), ["prompt_tokens", "completion_tokens", "total_tokens"]);
});

test("openai chat usage folds cache buckets into prompt_tokens and exposes the details", () => {
  const usage = openAiUsage(40, 8, real) as Record<string, Record<string, number> | number>;
  // OpenAI 口径：cached_tokens 是 prompt_tokens 的子集，所以两个缓存桶并回输入侧。
  assert.equal(usage.prompt_tokens, 1750);
  assert.equal(usage.completion_tokens, 300);
  assert.equal(usage.total_tokens, 2050);
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 700 });
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 120 });
  // 三个数自洽，且与 SDK 的四桶合计一致。
  assert.equal(usage.total_tokens, (usage.prompt_tokens as number) + (usage.completion_tokens as number));
  assert.equal(usage.total_tokens, real.totalTokens);
});

test("openai usage never lets reasoning_tokens exceed completion_tokens", () => {
  const skewed: RequestUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, reasoningTokens: 99 };
  const chat = openAiUsage(0, 0, skewed) as Record<string, Record<string, number>>;
  assert.deepEqual(chat.completion_tokens_details, { reasoning_tokens: 5 });
  const responses = responsesUsage(0, 0, 0, skewed) as Record<string, Record<string, number>>;
  assert.deepEqual(responses.output_tokens_details, { reasoning_tokens: 5 });

  const noReasoning: RequestUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 };
  assert.deepEqual((openAiUsage(0, 0, noReasoning) as Record<string, Record<string, number>>).completion_tokens_details, { reasoning_tokens: 0 });
});

test("openai responses usage keeps the estimated shape when no real usage is reported", () => {
  const usage = responsesUsage(40, 8, 4);
  assert.deepEqual(usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 13
  });
});

test("openai responses usage reports cached and reasoning details from the real usage", () => {
  const usage = responsesUsage(40, 8, 4, real) as Record<string, Record<string, number> | number>;
  assert.equal(usage.input_tokens, 1750);
  assert.deepEqual(usage.input_tokens_details, { cached_tokens: 700 });
  // reasoning 已经是 outputTokens 的子集，不再像估算分支那样另加一次。
  assert.equal(usage.output_tokens, 300);
  assert.deepEqual(usage.output_tokens_details, { reasoning_tokens: 120 });
  assert.equal(usage.total_tokens, 2050);
  assert.equal(usage.total_tokens, (usage.input_tokens as number) + (usage.output_tokens as number));
});

test("anthropic usage keeps the estimated shape when no real usage is reported", () => {
  const usage = anthropicUsage(40, 8);
  assert.deepEqual(usage, {
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 2
  });
  assert.deepEqual(Object.keys(usage).sort(), [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens"
  ]);
});

test("anthropic usage keeps cache reads out of input_tokens as its own bucket", () => {
  const usage = anthropicUsage(40, 8, real);
  // Anthropic 口径与 OpenAI 相反：缓存读写是并列的桶，不含在 input_tokens 里。
  assert.deepEqual(usage, {
    input_tokens: 1000,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 700,
    output_tokens: 300
  });
  assert.equal(
    (usage.input_tokens as number) + (usage.cache_read_input_tokens as number) + (usage.cache_creation_input_tokens as number) + (usage.output_tokens as number),
    real.totalTokens
  );
});
