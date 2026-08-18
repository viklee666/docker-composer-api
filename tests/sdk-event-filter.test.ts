import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorSdkRunner, textFromSdkEvent, type AgentFactory } from "../src/cursor-runner.js";
import { MemoryStateStore } from "../src/store.js";

const ritualText = "拉齐 schema";

test("textFromSdkEvent returns empty for non-assistant events even when they have .text", () => {
  for (const type of ["task", "status", "user", "system", "tool_call", "thinking"]) {
    assert.equal(textFromSdkEvent({ type, text: ritualText }), "", type);
  }
  assert.equal(textFromSdkEvent({ type: "mystery", text: ritualText }), "");
});

test("textFromSdkEvent extracts assistant message.content[] text blocks", () => {
  assert.equal(
    textFromSdkEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] }
    }),
    "hello"
  );
  assert.equal(
    textFromSdkEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "foo" },
          { type: "tool_use", name: "Read" },
          { type: "text", text: "bar" }
        ]
      }
    }),
    "foobar"
  );
});

test("textFromSdkEvent extracts assistant text from top-level, message.text, string content, and output_text", () => {
  assert.equal(textFromSdkEvent({ type: "assistant", text: "hello" }), "hello");
  assert.equal(textFromSdkEvent({ type: "assistant", message: { text: "hello" } }), "hello");
  assert.equal(textFromSdkEvent({ type: "assistant", message: { content: "hello" } }), "hello");
  assert.equal(
    textFromSdkEvent({
      type: "assistant",
      message: { content: [{ type: "output_text", text: "hello" }] }
    }),
    "hello"
  );
});

test("CursorSdkRunner result.text excludes preceding task milestone text", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "task", text: "搜到工具了，先把完整 schema 拉齐" };
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "the answer" }] }
          };
        },
        waitResult: { status: "finished", result: "the answer" }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });

  assert.equal(result.text, "the answer");
  assert.equal(result.text.includes("搜到工具了"), false);
  assert.equal(result.text.includes("schema"), false);
});

test("CursorSdkRunner does not use wait() ritual text after a streamed task event", async () => {
  const leaked = "搜到工具了，先把完整 schema 拉齐";
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "task", text: leaked };
        },
        waitResult: { status: "finished", result: leaked }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });

  // I-P31: stream already yielded events (even discarded task), so wait() text is not used.
  assert.equal(result.text.includes(leaked), false);
});

test("CursorSdkRunner ignores thinking/status text", async () => {
  const factory: AgentFactory = {
    create: async () => ({
      agentId: "agent-test",
      send: async () => new FakeSdkRun({
        streamEvents: async function* () {
          yield { type: "status", status: "RUNNING", text: "starting" };
          yield { type: "thinking", text: "internal scratchpad" };
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "the answer" }] }
          };
        },
        waitResult: { status: "finished", result: "the answer" }
      })
    })
  };
  const runner = new CursorSdkRunner(new MemoryStateStore(), { defaultWorkingDirectory: "/workspace", sdkClientVersion: "test" }, factory);

  const result = await runner.run({
    protocol: "openai-chat",
    apiKey: "cursor-key",
    useKeyPool: false,
    model: "composer-2.5",
    prompt: "hello",
    sessionKey: "session",
    workingDirectory: "/workspace",
    images: [],
    tools: []
  });

  assert.equal(result.text, "the answer");
  assert.equal(result.text.includes("starting"), false);
  assert.equal(result.text.includes("internal scratchpad"), false);
});

class FakeSdkRun {
  readonly id = "run-test";
  cancelled = false;

  constructor(private readonly input: {
    streamEvents?: () => AsyncIterable<unknown>;
    waitResult?: unknown;
  } = {}) {}

  async *stream(): AsyncIterable<unknown> {
    if (this.input.streamEvents) yield* this.input.streamEvents();
  }

  async wait(): Promise<unknown> {
    return this.input.waitResult ?? { status: "finished", result: "" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}
