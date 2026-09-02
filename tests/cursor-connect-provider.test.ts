import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import type { CursorRunRequest, ModelParameterValue, RunTelemetryRef } from "../src/types.js";
import { ModelCatalogCache, resolveRequestedModel } from "../src/cursor-connect/catalog.js";
import { CursorConnectClient } from "../src/cursor-connect/client.js";
import type { CursorConnectCredential } from "../src/cursor-connect/credentials.js";
import { encodeEnvelope } from "../src/cursor-connect/envelope.js";
import { CursorConnectProvider, conversationIdFor } from "../src/cursor-connect/provider.js";
import { buildInferenceStreamRequest } from "../src/cursor-connect/request-builder.js";
import { ResponseNormalizer } from "../src/cursor-connect/response-normalizer.js";
import {
  InferenceExtendedUsageInfo,
  InferenceMessageRole,
  InferenceResponseInfo,
  InferenceStreamError,
  InferenceStreamErrorType,
  InferenceStreamRequest,
  InferenceStreamResponse,
  InferenceTextStreamPart,
  InferenceThinkingStreamPart,
  InferenceToolCallStreamPart,
  InferenceUsageInfo
} from "../src/cursor-connect/proto/inference_pb.js";

const CREDENTIAL: CursorConnectCredential = {
  id: "cred-1",
  sessionToken: "session-token-value",
  machineId: "machine-abc",
  clientVersion: "3.18.9"
};

/* -------------------------------------------------------------- request builder */

test("system instructions go out as role SYSTEM(4), not as user text", () => {
  const request = buildInferenceStreamRequest({
    messages: [
      { role: "system", text: "be terse" },
      { role: "user", text: "hi" }
    ],
    conversationId: "conv-1",
    invocationId: "inv-1",
    requestedModel: { modelId: "grok-4.6" }
  });
  assert.deepEqual(
    request.messages.map((message) => message.role),
    [InferenceMessageRole.SYSTEM, InferenceMessageRole.USER]
  );
  assert.equal(request.messages[0].role, 4);
  assert.deepEqual(request.messages[0].content, { case: "text", value: "be terse" });
});

test("content is a oneof: text, parts and tool_content never coexist", () => {
  const request = buildInferenceStreamRequest({
    messages: [
      { role: "user", text: "look", images: [{ type: "image", source: "base64", data: "AAA", mediaType: "image/png" }] },
      { role: "tool", toolResults: [{ toolCallId: "call-1", toolName: "read", result: { ok: true } }] }
    ],
    conversationId: "conv-1",
    invocationId: "inv-1",
    requestedModel: { modelId: "m" }
  });

  assert.equal(request.messages[0].content.case, "parts");
  const parts = request.messages[0].content.value as { parts: Array<{ part: { case?: string } }> };
  assert.deepEqual(parts.parts.map((part) => part.part.case), ["text", "image"]);

  assert.equal(request.messages[1].content.case, "toolContent");
  const toolContent = request.messages[1].content.value as { parts: Array<{ toolCallId: string; isError: boolean }> };
  assert.equal(toolContent.parts[0].toolCallId, "call-1");
  assert.equal(toolContent.parts[0].isError, false);
});

test("assistant tool_calls coexist with text and carry Struct args", () => {
  const request = buildInferenceStreamRequest({
    messages: [
      {
        role: "assistant",
        text: "calling",
        toolCalls: [{ id: "call-1", name: "search", arguments: { q: "x", n: 2, skip: undefined } }],
        reasoning: [{ text: "thought", signature: "sig-1" }]
      }
    ],
    conversationId: "conv-1",
    invocationId: "inv-1",
    requestedModel: { modelId: "m" }
  });
  const message = request.messages[0];
  assert.deepEqual(message.content, { case: "text", value: "calling" });
  assert.equal(message.toolCalls.length, 1);
  // 请求侧 args 是 Struct（结构化），不是 JSON 字符串——与响应侧的 string 是两回事。
  assert.deepEqual(message.toolCalls[0].args?.toJson(), { q: "x", n: 2 });
  assert.equal(message.reasoningParts[0].signature, "sig-1");
  assert.equal(message.reasoningParts[0].isRedacted, false);
});

test("requested_model mirrors into model_id and defaults the variant flag off", () => {
  const request = buildInferenceStreamRequest({
    messages: [{ role: "user", text: "hi" }],
    conversationId: "conv-1",
    invocationId: "inv-1",
    requestedModel: { modelId: "grok-4.6", maxMode: true, parameters: [{ id: "effort", value: "high" }] }
  });
  assert.equal(request.modelId, "grok-4.6");
  assert.equal(request.requestedModel?.modelId, "grok-4.6");
  assert.equal(request.requestedModel?.maxMode, true);
  assert.equal(request.requestedModel?.builtInModel, true);
  assert.equal(request.requestedModel?.isVariantStringRepresentation, false);
  assert.deepEqual(
    request.requestedModel?.parameters.map((parameter) => [parameter.id, parameter.value]),
    [["effort", "high"]]
  );
});

test("model_config is omitted entirely when nothing was requested", () => {
  const bare = buildInferenceStreamRequest({
    messages: [{ role: "user", text: "hi" }],
    conversationId: "c",
    invocationId: "i",
    requestedModel: { modelId: "m" }
  });
  assert.equal(bare.modelConfig, undefined);

  const configured = buildInferenceStreamRequest({
    messages: [{ role: "user", text: "hi" }],
    conversationId: "c",
    invocationId: "i",
    requestedModel: { modelId: "m" },
    modelConfig: { maxTokens: 100, stopSequences: ["END"] }
  });
  assert.equal(configured.modelConfig?.maxTokens, 100);
  assert.deepEqual(configured.modelConfig?.stopSequences, ["END"]);
  assert.equal(configured.modelConfig?.temperature, undefined);
});

test("a built request survives a binary round trip", () => {
  const request = buildInferenceStreamRequest({
    messages: [
      { role: "system", text: "sys" },
      { role: "user", text: "hi" }
    ],
    conversationId: "conv-1",
    invocationId: "inv-1",
    requestedModel: { modelId: "grok-4.6", parameters: [{ id: "effort", value: "low" }] }
  });
  const decoded = InferenceStreamRequest.fromBinary(request.toBinary());
  assert.equal(decoded.messages[0].role, InferenceMessageRole.SYSTEM);
  assert.deepEqual(decoded.messages[1].content, { case: "text", value: "hi" });
  assert.equal(decoded.requestedModel?.parameters[0].value, "low");
});

/* ---------------------------------------------------------- response normalizer */

function textFrame(text: string, isFinal = false): InferenceStreamResponse {
  return new InferenceStreamResponse({
    response: { case: "textPart", value: new InferenceTextStreamPart({ text, isFinal }) }
  });
}

function thinkingFrame(text: string, signature?: string): InferenceStreamResponse {
  const part = new InferenceThinkingStreamPart({ text });
  if (signature) part.signature = signature;
  return new InferenceStreamResponse({ response: { case: "thinkingPart", value: part } });
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

test("text deltas accumulate and a final empty part emits nothing", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [textFrame("Hel"), textFrame("lo"), textFrame("", true)]);
  assert.deepEqual(events, [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" }
  ]);
  assert.equal(normalizer.result().text, "Hello");
});

test("thinking is a separate event stream and signatures are kept", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [thinkingFrame("plan", "sig-1"), textFrame("answer"), thinkingFrame("", "sig-2")]);
  assert.deepEqual(events, [
    { type: "thinking", text: "plan" },
    { type: "text", text: "answer" }
  ]);
  assert.deepEqual(normalizer.state.thinkingSignatures, ["sig-1", "sig-2"]);
  const result = normalizer.result();
  assert.equal(result.reasoningText, "plan");
  // thinking 不能混进普通文本。
  assert.equal(result.text, "answer");
});

test("tool calls resolve through streaming-start, delta and complete", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "call-1", toolName: "search" }),
    toolFrame({ toolCallId: "call-1", args: '{"q":' }),
    toolFrame({ toolCallId: "call-1", args: '"cats"}' }),
    toolFrame({ toolCallId: "call-1", isComplete: true })
  ]);
  assert.deepEqual(events, [
    { type: "tool_call", toolCall: { id: "call-1", name: "search", arguments: { q: "cats" } } }
  ]);
});

test("a complete frame that carries full args wins over the accumulator", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "c", toolName: "t" }),
    toolFrame({ toolCallId: "c", args: "partial" }),
    toolFrame({ toolCallId: "c", toolName: "t", args: '{"done":true}', isComplete: true })
  ]);
  assert.deepEqual(events[0], { type: "tool_call", toolCall: { id: "c", name: "t", arguments: { done: true } } });
});

test("unparseable tool args degrade to an empty object instead of breaking the stream", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [toolFrame({ toolCallId: "c", toolName: "t", args: "{oops", isComplete: true })]);
  assert.deepEqual(events[0], { type: "tool_call", toolCall: { id: "c", name: "t", arguments: {} } });
});

test("a repeated complete frame does not emit the same tool call twice", () => {
  const normalizer = new ResponseNormalizer();
  const complete = { toolCallId: "c", toolName: "t", args: '{"a":1}', isComplete: true };
  const events = drain(normalizer, [toolFrame(complete), toolFrame(complete)]);
  assert.equal(events.length, 1);
  assert.equal(normalizer.result().toolCalls.length, 1);
});

test("an args delta arriving after completion does not create a phantom tool call", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "c", toolName: "t", args: '{"a":1}', isComplete: true }),
    toolFrame({ toolCallId: "c", args: "trailing" })
  ]);
  assert.deepEqual(events, [{ type: "tool_call", toolCall: { id: "c", name: "t", arguments: { a: 1 } } }]);
});

test("parallel tool calls stay separate when deltas carry only tool_index", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "", toolName: "alpha", toolIndex: 0 }),
    toolFrame({ toolCallId: "", toolName: "beta", toolIndex: 1 }),
    toolFrame({ toolCallId: "", args: '{"x":1}', toolIndex: 0 }),
    toolFrame({ toolCallId: "", args: '{"y":2}', toolIndex: 1 })
  ]);
  assert.deepEqual(
    events.map((event) => (event.type === "tool_call" ? [event.toolCall.name, event.toolCall.arguments] : event)),
    [
      ["alpha", { x: 1 }],
      ["beta", { y: 2 }]
    ]
  );
});

test("a tool call left incomplete at end of stream is still surfaced", () => {
  const normalizer = new ResponseNormalizer();
  const events = drain(normalizer, [
    toolFrame({ toolCallId: "c", toolName: "t" }),
    toolFrame({ toolCallId: "c", args: '{"a":1}' })
  ]);
  assert.deepEqual(events, [{ type: "tool_call", toolCall: { id: "c", name: "t", arguments: { a: 1 } } }]);
});

test("usage alone maps prompt/completion into the two-bucket form", () => {
  const normalizer = new ResponseNormalizer();
  drain(normalizer, [
    new InferenceStreamResponse({
      response: { case: "usage", value: new InferenceUsageInfo({ promptTokens: 100, completionTokens: 20 }) }
    })
  ]);
  assert.deepEqual(normalizer.state.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120
  });
});

test("extended_usage takes over wholesale and never double-counts the cached tokens", () => {
  const normalizer = new ResponseNormalizer();
  // 真实的缓存拆分：prompt_tokens=100 是含缓存的总输入，input_tokens=20 是缓存之外的部分。
  // 逐字段取 max 会算出 input=100 + cacheRead=80 = 180，比实际输入多出 80。
  drain(normalizer, [
    new InferenceStreamResponse({
      response: { case: "usage", value: new InferenceUsageInfo({ promptTokens: 100, completionTokens: 20 }) }
    }),
    new InferenceStreamResponse({
      response: {
        case: "extendedUsage",
        value: new InferenceExtendedUsageInfo({ inputTokens: 20, outputTokens: 20, cacheReadTokens: 80 })
      }
    })
  ]);
  assert.deepEqual(normalizer.state.usage, {
    inputTokens: 20,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 120
  });
  // RequestUsage 是四桶互斥口径：totalTokens 必须等于四个桶之和。
  const usage = normalizer.state.usage!;
  assert.equal(
    usage.totalTokens,
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  );
});

test("a late coarse usage frame cannot clobber the detailed one", () => {
  const normalizer = new ResponseNormalizer();
  drain(normalizer, [
    new InferenceStreamResponse({
      response: {
        case: "extendedUsage",
        value: new InferenceExtendedUsageInfo({ inputTokens: 20, outputTokens: 20, cacheReadTokens: 80 })
      }
    }),
    new InferenceStreamResponse({
      response: { case: "usage", value: new InferenceUsageInfo({ promptTokens: 100, completionTokens: 20 }) }
    })
  ]);
  assert.equal(normalizer.state.usage?.cacheReadTokens, 80);
  assert.equal(normalizer.state.usage?.inputTokens, 20);
});

test("response_info records the resolved model and self-summary capability", () => {
  const normalizer = new ResponseNormalizer();
  drain(normalizer, [
    new InferenceStreamResponse({
      response: {
        case: "responseInfo",
        value: new InferenceResponseInfo({ id: "resp-1", model: "grok-4.6", supportsSelfSummary: true })
      }
    })
  ]);
  assert.equal(normalizer.state.responseId, "resp-1");
  assert.equal(normalizer.state.resolvedModel, "grok-4.6");
  assert.equal(normalizer.state.supportsSelfSummary, true);
});

test("an error frame throws instead of ending the run quietly", () => {
  const normalizer = new ResponseNormalizer();
  assert.throws(
    () =>
      drain(normalizer, [
        new InferenceStreamResponse({
          response: {
            case: "error",
            value: new InferenceStreamError({
              message: "slow down",
              errorType: InferenceStreamErrorType.RATE_LIMIT
            })
          }
        })
      ]),
    (error: unknown) => error instanceof ApiError && error.statusCode === 429
  );
});

test("response_info.error_message is treated as a failure too", () => {
  const normalizer = new ResponseNormalizer();
  assert.throws(
    () =>
      drain(normalizer, [
        new InferenceStreamResponse({
          response: { case: "responseInfo", value: new InferenceResponseInfo({ errorMessage: "upstream said no" }) }
        })
      ]),
    (error: unknown) => error instanceof ApiError && error.message === "upstream said no"
  );
});

test("frames the gateway does not consume are logged by case name, not dropped silently", () => {
  const normalizer = new ResponseNormalizer();
  const metadata = new InferenceStreamResponse({ response: { case: "providerMetadata", value: { metadata: undefined } } });
  const events = drain(normalizer, [metadata, metadata, metadata, new InferenceStreamResponse(), textFrame("still flowing")]);
  assert.deepEqual(events, [{ type: "text", text: "still flowing" }]);
  // 去重是必须的：case 名列表活到 run 结束，几百个 provider_metadata 帧会把它撑成几百项。
  assert.deepEqual(normalizer.state.unknownCases, ["providerMetadata", "(empty)"]);
});

/* --------------------------------------------------------------------- catalog */

test("resolveRequestedModel sends no parameters when the request expressed no intent", () => {
  const resolved = resolveRequestedModel({ modelId: "grok-4.6", intent: {} });
  assert.deepEqual(resolved.parameters, []);
  assert.equal(resolved.requestedModel.maxMode, false);
  assert.equal(resolved.requestedModel.isVariantStringRepresentation, false);
});

test("effort intent becomes an InferenceModelParameterValue from the catalog definitions", () => {
  const resolved = resolveRequestedModel({
    modelId: "grok-4.6",
    intent: { reasoningEffort: "high" },
    catalog: { parameters: [{ id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] }] }
  });
  assert.deepEqual(resolved.parameters, [{ id: "effort", value: "high" }]);
  assert.deepEqual(resolved.requestedModel.parameters, [{ id: "effort", value: "high" }]);
});

test("two resolutions never share the same parameters array instance", () => {
  const intent = { reasoningEffort: "high" };
  const catalog = { parameters: [{ id: "effort", values: [{ value: "high" }] }] };
  const first = resolveRequestedModel({ modelId: "m", intent, catalog });
  const second = resolveRequestedModel({ modelId: "m", intent, catalog });
  assert.notEqual(first.parameters, second.parameters);
  (first.parameters as ModelParameterValue[])[0].value = "mutated";
  assert.equal(second.parameters[0].value, "high");
});

test("catalog cache is keyed by credential and collapses concurrent lookups", async () => {
  let calls = 0;
  let now = 0;
  const cache = new ModelCatalogCache(
    async (_modelId, credentialKey) => {
      calls += 1;
      return { parameters: [{ id: credentialKey ?? "none", values: [{ value: "v" }] }] };
    },
    { ttlMs: 1000, now: () => now }
  );

  const [a, b] = await Promise.all([cache.get("m", "cred-a"), cache.get("m", "cred-a")]);
  assert.equal(calls, 1);
  assert.equal(a?.parameters?.[0].id, "cred-a");
  assert.equal(b, a);

  await cache.get("m", "cred-b");
  assert.equal(calls, 2, "不同凭据必须各查各的目录");

  await cache.get("m", "cred-a");
  assert.equal(calls, 2, "TTL 内命中缓存");

  now = 2000;
  await cache.get("m", "cred-a");
  assert.equal(calls, 3, "TTL 过期后回源");
});

test("the catalog cache is bounded because model ids come from the caller", async () => {
  let calls = 0;
  const cache = new ModelCatalogCache(
    async () => {
      calls += 1;
      return { parameters: [] };
    },
    { maxEntries: 4 }
  );
  for (let i = 0; i < 50; i += 1) await cache.get(`made-up-model-${i}`, "cred");
  assert.equal(calls, 50);
  // 最早的键已经被挤掉，再查会重新回源，说明表没有无限增长。
  await cache.get("made-up-model-0", "cred");
  assert.equal(calls, 51);
});

test("a failing catalog lookup degrades to undefined rather than failing the request", async () => {
  const cache = new ModelCatalogCache(async () => {
    throw new Error("catalog down");
  });
  assert.equal(await cache.get("m", "cred"), undefined);
});

test("a transient catalog failure is not remembered for the full TTL", async () => {
  let now = 0;
  let failing = true;
  let calls = 0;
  const cache = new ModelCatalogCache(
    async () => {
      calls += 1;
      if (failing) throw new Error("catalog down");
      return { parameters: [{ id: "effort", values: [{ value: "high" }] }] };
    },
    { ttlMs: 300_000, failureTtlMs: 10_000, now: () => now }
  );

  assert.equal(await cache.get("m", "cred"), undefined);
  assert.equal(calls, 1);

  // 失败也要缓存一小会儿，否则目录持续挂掉时每个请求都去砸它。
  now = 5_000;
  assert.equal(await cache.get("m", "cred"), undefined);
  assert.equal(calls, 1);

  // 但绝不能按成功的 TTL 记住：一次抖动不该让之后 5 分钟全部降级且不重试。
  now = 15_000;
  failing = false;
  assert.equal((await cache.get("m", "cred"))?.parameters?.[0].id, "effort");
  assert.equal(calls, 2);

  // 成功之后才轮到长 TTL。
  now = 20_000;
  await cache.get("m", "cred");
  assert.equal(calls, 2);
});

test("expired entries are dropped on read, not only when the table fills up", async () => {
  let now = 0;
  const cache = new ModelCatalogCache(async () => ({ parameters: [] }), { ttlMs: 1000, now: () => now });
  for (let i = 0; i < 20; i += 1) await cache.get(`model-${i}`, "cred");
  assert.equal(cache.size, 20);

  // 过期后逐个读一遍：每次读都应该顺手把过期项删掉，而不是一直占着直到表满。
  now = 5000;
  for (let i = 0; i < 20; i += 1) await cache.get(`model-${i}`, "cred");
  assert.equal(cache.size, 20, "重查后条目数不该翻倍");

  cache.clear();
  assert.equal(cache.size, 0);
});

test("clear() also discards lookups that are still in flight", async () => {
  let release: ((value: { parameters: [] }) => void) | undefined;
  let calls = 0;
  const cache = new ModelCatalogCache(async () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  });

  const inflight = cache.get("m", "cred");
  cache.clear();
  release?.({ parameters: [] });
  await inflight;
  assert.equal(cache.size, 0, "清完之后在途请求回来不能把刚清掉的值又写回去");

  // 缓存是空的，所以下一次查询必须重新回源，而不是命中那个迟到的旧结果。
  const refreshed = cache.get("m", "cred");
  release?.({ parameters: [] });
  await refreshed;
  assert.equal(calls, 2);
});

/* ---------------------------------------------------------------------- client */

function streamBody(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    }
  });
}

function messageFrame(message: InferenceStreamResponse): Uint8Array {
  return encodeEnvelope(message.toBinary());
}

function endFrame(body: unknown = {}): Uint8Array {
  return encodeEnvelope(new TextEncoder().encode(JSON.stringify(body)), { endStream: true });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  request: InferenceStreamRequest;
}

function fakeUpstream(frames: Uint8Array[], init: ResponseInit = {}) {
  const captured: Captured[] = [];
  const fetchImpl = async (url: string, options: RequestInit): Promise<Response> => {
    const body = options.body as Uint8Array;
    captured.push({
      url,
      headers: options.headers as Record<string, string>,
      // 去掉 5 字节 envelope 头，剩下就是 InferenceStreamRequest 的 proto 编码。
      request: InferenceStreamRequest.fromBinary(body.subarray(5))
    });
    return new Response(streamBody(frames), { status: 200, ...init });
  };
  return { captured, fetchImpl };
}

test("the client posts to /aiserver.v1.InferenceService/Stream and decodes the frames", async () => {
  const { captured, fetchImpl } = fakeUpstream([
    messageFrame(textFrame("hi")),
    messageFrame(textFrame(" there")),
    endFrame()
  ]);
  const client = new CursorConnectClient({ credential: CREDENTIAL, fetchImpl, baseUrl: "https://api2.example.test/" });

  const texts: string[] = [];
  for await (const frame of client.stream(
    buildInferenceStreamRequest({
      messages: [{ role: "user", text: "hello" }],
      conversationId: "c",
      invocationId: "i",
      requestedModel: { modelId: "m" }
    })
  )) {
    if (frame.response.case === "textPart") texts.push(frame.response.value.text);
  }

  assert.deepEqual(texts, ["hi", " there"]);
  assert.equal(captured[0].url, "https://api2.example.test/aiserver.v1.InferenceService/Stream");
  assert.equal(captured[0].headers["content-type"], "application/connect+proto");
  assert.equal(captured[0].request.messages[0].content.value, "hello");
});

test("an endStream error surfaces as a mapped ApiError even under HTTP 200", async () => {
  const { fetchImpl } = fakeUpstream([
    messageFrame(textFrame("partial")),
    endFrame({ error: { code: "resource_exhausted", message: "quota" } })
  ]);
  const client = new CursorConnectClient({ credential: CREDENTIAL, fetchImpl });
  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) =>
      error instanceof ApiError && error.statusCode === 429 && error.message === "quota (connect: resource_exhausted)"
  );
});

test("a stream that never sends endStream is an error, not an empty answer", async () => {
  const { fetchImpl } = fakeUpstream([messageFrame(textFrame("truncated"))]);
  const client = new CursorConnectClient({ credential: CREDENTIAL, fetchImpl });
  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) => error instanceof ApiError && /end-of-stream/.test(error.message)
  );
});

test("an unsupported content encoding cancels the body instead of leaking the socket", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 0, 0, 0, 1, 65]));
    },
    cancel() {
      cancelled = true;
    }
  });
  const client = new CursorConnectClient({
    credential: CREDENTIAL,
    fetchImpl: async () => new Response(body, { status: 200, headers: { "connect-content-encoding": "zstd" } })
  });

  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) => error instanceof ApiError && error.statusCode === 502
  );
  assert.equal(cancelled, true, "解析响应编码失败时必须把响应体 cancel 掉");
});

test("an HTTP error status becomes an ApiError with the upstream status", async () => {
  const client = new CursorConnectClient({
    credential: CREDENTIAL,
    fetchImpl: async () => new Response("no", { status: 401 })
  });
  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) => error instanceof ApiError && error.statusCode === 401
  );
});

/* -------------------------------------------------------------------- provider */

function runRequest(overrides: Partial<CursorRunRequest> = {}): CursorRunRequest {
  return {
    protocol: "openai",
    apiKey: "unused-by-connect",
    useKeyPool: false,
    model: "grok-4.6",
    prompt: "hello",
    sessionKey: "owner-hash",
    images: [],
    tools: [],
    ...overrides
  } as CursorRunRequest;
}

function provider(frames: Uint8Array[], options: Partial<ConstructorParameters<typeof CursorConnectProvider>[0]> = {}) {
  const upstream = fakeUpstream(frames);
  const instance = new CursorConnectProvider({
    resolveCredential: () => CREDENTIAL,
    fetchImpl: upstream.fetchImpl,
    newInvocationId: () => "inv-fixed",
    ...options
  });
  return { instance, captured: upstream.captured };
}

test("the provider satisfies CursorRunner and emits text, thinking then done", async () => {
  const { instance } = provider([
    messageFrame(thinkingFrame("thinking hard", "sig-1")),
    messageFrame(textFrame("the ")),
    messageFrame(textFrame("answer")),
    messageFrame(textFrame("", true)),
    endFrame()
  ]);

  const events = [];
  for await (const event of instance.stream(runRequest())) events.push(event);

  assert.deepEqual(events, [
    { type: "thinking", text: "thinking hard" },
    { type: "text", text: "the " },
    { type: "text", text: "answer" },
    { type: "done", result: { text: "the answer", toolCalls: [], reasoningText: "thinking hard" } }
  ]);
});

test("run() drains the stream into the same result", async () => {
  const { instance } = provider([messageFrame(textFrame("done")), endFrame()]);
  assert.deepEqual(await instance.run(runRequest()), { text: "done", toolCalls: [] });
});

test("the requested model and effort actually reach the wire", async () => {
  const { instance, captured } = provider([messageFrame(textFrame("ok")), endFrame()], {
    getModelCatalog: async () => ({
      parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }]
    })
  });
  await instance.run(runRequest({ model: "grok-4.6", reasoningEffort: "high" }));

  const request = captured[0].request;
  assert.equal(request.requestedModel?.modelId, "grok-4.6");
  assert.equal(request.modelId, "grok-4.6");
  assert.deepEqual(
    request.requestedModel?.parameters.map((parameter) => [parameter.id, parameter.value]),
    [["effort", "high"]]
  );
  assert.equal(request.invocationId, "inv-fixed");
});

test("no effort in the request means no parameters on the wire", async () => {
  const { instance, captured } = provider([messageFrame(textFrame("ok")), endFrame()], {
    getModelCatalog: async () => ({ parameters: [{ id: "effort", values: [{ value: "medium" }] }] })
  });
  await instance.run(runRequest());
  assert.deepEqual(captured[0].request.requestedModel?.parameters, []);
});

test("system instructions are sent as their own SYSTEM message", async () => {
  const { instance, captured } = provider([messageFrame(textFrame("ok")), endFrame()], {
    systemInstructions: ["gateway policy", "   "]
  });
  await instance.run(runRequest());
  const roles = captured[0].request.messages.map((message) => message.role);
  assert.deepEqual(roles, [InferenceMessageRole.SYSTEM, InferenceMessageRole.USER]);
  assert.equal(captured[0].request.messages[0].content.value, "gateway policy");
});

test("tools stay off the wire until the tool loop is verified", async () => {
  const tools = [{ name: "search", description: "d", inputSchema: { type: "object" } }];
  const off = provider([messageFrame(textFrame("ok")), endFrame()]);
  await off.instance.run(runRequest({ tools }));
  assert.deepEqual(off.captured[0].request.tools, []);

  const on = provider([messageFrame(textFrame("ok")), endFrame()], { sendTools: true });
  await on.instance.run(runRequest({ tools }));
  assert.equal(on.captured[0].request.tools[0].name, "search");
});

test("telemetry captures the model, params and upstream usage", async () => {
  const telemetryRef: RunTelemetryRef = {};
  const { instance } = provider(
    [
      messageFrame(
        new InferenceStreamResponse({
          response: { case: "usage", value: new InferenceUsageInfo({ promptTokens: 11, completionTokens: 7 }) }
        })
      ),
      messageFrame(
        new InferenceStreamResponse({
          response: { case: "responseInfo", value: new InferenceResponseInfo({ id: "resp-9", model: "grok-4.6-routed" }) }
        })
      ),
      endFrame()
    ],
    { getModelCatalog: async () => ({ parameters: [{ id: "effort", values: [{ value: "high" }] }] }) }
  );

  await instance.run(runRequest({ reasoningEffort: "high", telemetryRef }));
  assert.equal(telemetryRef.clientType, "sand");
  assert.deepEqual(telemetryRef.modelParams, [{ id: "effort", value: "high" }]);
  // 走 Stream 时没有 run_ready，解析结果只能从 response_info.model 回填。
  assert.equal(telemetryRef.upstreamModel, "grok-4.6-routed");
  assert.equal(telemetryRef.runId, "resp-9");
  assert.equal(telemetryRef.usage?.inputTokens, 11);
  assert.equal(telemetryRef.usage?.outputTokens, 7);
});

test("conversation_id is stable per conversation seed and never merges unrelated callers", () => {
  const first = conversationIdFor(runRequest({ conversationSeed: "seed-a" }));
  const second = conversationIdFor(runRequest({ conversationSeed: "seed-a" }));
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  assert.notEqual(first, conversationIdFor(runRequest({ conversationSeed: "seed-b" })));
  assert.notEqual(first, conversationIdFor(runRequest({ conversationSeed: "seed-a", model: "other" })));

  // 认不出身份时每次新开一段；拿 ownerHash / sessionKey 兜底会把整个网关并成一段对话。
  const anonymous = runRequest({ sessionKey: "owner-hash" });
  assert.notEqual(conversationIdFor(anonymous), conversationIdFor(anonymous));
});

test("the caller's AbortSignal reaches fetch and surfaces as 499", async () => {
  const controller = new AbortController();
  let sawSignal: AbortSignal | undefined;
  const instance = new CursorConnectProvider({
    resolveCredential: () => CREDENTIAL,
    fetchImpl: async (_url, options) => {
      sawSignal = options.signal ?? undefined;
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
  });
  await assert.rejects(
    () => instance.run(runRequest(), controller.signal),
    (error: unknown) => error instanceof ApiError && error.statusCode === 499
  );
  // 断言 signal 真的透传到了 fetch：否则请求超时/客户端断连都停不下上游这一路。
  assert.equal(sawSignal, controller.signal);
});

test("usage collected before a failure is still written to telemetry", async () => {
  const telemetryRef: RunTelemetryRef = {};
  const { instance } = provider([
    messageFrame(
      new InferenceStreamResponse({
        response: { case: "usage", value: new InferenceUsageInfo({ promptTokens: 42, completionTokens: 8 }) }
      })
    ),
    messageFrame(
      new InferenceStreamResponse({
        response: {
          case: "error",
          value: new InferenceStreamError({ message: "boom", errorType: InferenceStreamErrorType.OVERLOADED })
        }
      })
    ),
    endFrame()
  ]);

  await assert.rejects(
    () => instance.run(runRequest({ telemetryRef })),
    (error: unknown) => error instanceof ApiError && error.statusCode === 529
  );
  assert.equal(telemetryRef.usage?.inputTokens, 42);
  assert.equal(telemetryRef.usage?.outputTokens, 8);
});

test("URL images are rejected instead of being passed off as inline data", async () => {
  const { instance } = provider([messageFrame(textFrame("ok")), endFrame()]);
  await assert.rejects(
    () => instance.run(runRequest({ images: [{ type: "image", source: "url", data: "https://example.test/cat.png" }] })),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400 && /base64/.test(error.message)
  );
});

test("base64 images do go out as an image content part", async () => {
  const { instance, captured } = provider([messageFrame(textFrame("ok")), endFrame()]);
  await instance.run(
    runRequest({ images: [{ type: "image", source: "base64", data: "AAAA", mediaType: "image/png" }] })
  );
  const content = captured[0].request.messages[0].content;
  assert.equal(content.case, "parts");
  const parts = content.value as { parts: Array<{ part: { case?: string; value?: unknown } }> };
  assert.deepEqual(parts.parts.map((part) => part.part.case), ["text", "image"]);
});

test("the accept-encoding header matches the reference client's gzip+br profile", async () => {
  const { instance, captured } = provider([messageFrame(textFrame("ok")), endFrame()]);
  await instance.run(runRequest());
  assert.equal(captured[0].headers["connect-accept-encoding"], "gzip, br");
  // 请求体默认不压缩，所以不该声明 content-encoding。
  assert.equal(captured[0].headers["connect-content-encoding"], undefined);
});

test("an unreadable end-of-stream frame fails the run instead of truncating it silently", async () => {
  const { fetchImpl } = fakeUpstream([
    messageFrame(textFrame("partial")),
    encodeEnvelope(new TextEncoder().encode("<html>gateway timeout</html>"), { endStream: true })
  ]);
  const client = new CursorConnectClient({ credential: CREDENTIAL, fetchImpl });
  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) => error instanceof ApiError && /unreadable end-of-stream/.test(error.message)
  );
});

test("envelope-level failures become upstream errors, not internal 500s", async () => {
  const oversized = new Uint8Array(5);
  new DataView(oversized.buffer).setUint32(1, 0xffffffff, false);
  const { fetchImpl } = fakeUpstream([oversized]);
  const client = new CursorConnectClient({ credential: CREDENTIAL, fetchImpl });

  await assert.rejects(
    async () => {
      for await (const _ of client.stream(new InferenceStreamRequest())) {
        // 只关心错误是否抛出。
      }
    },
    (error: unknown) =>
      error instanceof ApiError &&
      error.statusCode === 502 &&
      error.code === "upstream_error" &&
      // 不把网关自己的 readMaxBytes 透给调用方。
      !/\d{4,}/.test(error.message)
  );
});
