import assert from "node:assert/strict";
import { test } from "node:test";
import { unadvertisedToolCatalog, withUnadvertisedToolCatalog } from "../src/cursor-bot/tool-catalog.js";

test("grok gets a catalog of the actual client tools, not a hardcoded Cursor list", () => {
  const text = unadvertisedToolCatalog(
    [
      { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "LookupDoc", inputSchema: { type: "object", properties: { id: { type: "string" }, lang: { type: "string" } }, required: ["id"] } }
    ],
    "grok-4.6"
  );
  assert.ok(text);
  assert.match(text, /CLIENT TOOLS/);
  assert.match(text, /^- Read — arguments: path$/m);
  assert.match(text, /^- LookupDoc — arguments: id$/m);
  assert.doesNotMatch(text, /notify_on_output/);
  assert.doesNotMatch(text, /to=/);
  assert.doesNotMatch(text, /ReadFile/);
  assert.doesNotMatch(text, /Reads a file/);
});

test("composer still advertises tools[] so it does not get the shadow catalog", () => {
  assert.equal(
    unadvertisedToolCatalog([{ name: "search" }], "composer-2.5"),
    undefined
  );
});

test("composer on the direct route gets the shadow catalog", () => {
  const text = unadvertisedToolCatalog([{ name: "search" }], "composer-2.5", undefined, "direct");
  assert.ok(text?.includes("- search"));
});

test("forcing advertise off still injects the catalog for non-grok models", () => {
  const text = unadvertisedToolCatalog([{ name: "search" }], "composer-2.5", false);
  assert.ok(text?.includes("- search"));
});

test("claude on the direct route does not get the shadow catalog", () => {
  assert.equal(
    unadvertisedToolCatalog([{ name: "search" }], "claude-sonnet-5", undefined, "direct"),
    undefined
  );
});

test("shell catalog lists command, not notify_on_output", () => {
  const text = unadvertisedToolCatalog(
    [
      {
        name: "Shell",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            notify_on_output: { type: "object" },
            working_directory: { type: "string" }
          },
          required: ["command"]
        }
      }
    ],
    "gpt-5.6-luna",
    undefined,
    "direct"
  );
  assert.ok(text);
  assert.match(text, /^- Shell — arguments: command$/m);
  assert.doesNotMatch(text, /notify_on_output/);
});

test("withUnadvertisedToolCatalog appends after existing system text", () => {
  const next = withUnadvertisedToolCatalog(
    { systemInstructions: ["be terse"], tools: [{ name: "search" }] },
    "grok-4.6"
  );
  assert.equal(next.systemInstructions[0], "be terse");
  assert.match(next.systemInstructions[1] ?? "", /^- search$/m);
});
