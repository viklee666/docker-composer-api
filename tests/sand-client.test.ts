import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { patchCursorSdkSource } from "../src/sand-client-header-loader.js";
import {
  getCurrentCursorClientType,
  iterateWithCursorClientType,
  resolveCursorClientType,
  runWithCursorClientType,
  setGlobalCursorClientType
} from "../src/sand-client.js";

test("resolveCursorClientType honors per-key override then global fallback", () => {
  assert.equal(resolveCursorClientType("sand", "sdk"), "sand");
  assert.equal(resolveCursorClientType("sdk", "sand"), "sdk");
  assert.equal(resolveCursorClientType("inherit", "sand"), "sand");
  assert.equal(resolveCursorClientType(undefined, "sdk"), "sdk");
});

test("patchCursorSdkSource rewrites both hardcoded client-type glyphs", () => {
  const source = [
    's.header.set("x-cursor-client-type","sdk");const l=null',
    '{"x-cursor-client-type":"sdk"};return(null'
  ].join("\n");
  const { source: patched, patched: changed } = patchCursorSdkSource(source);
  assert.equal(changed, true);
  assert.match(patched, /header\.set\("x-cursor-client-type",\(\(globalThis\.__cursorSandHookPatched=true\),globalThis\.__cursorClientType\(\)\)\)/);
  assert.match(patched, /"x-cursor-client-type":\(\(globalThis\.__cursorSandHookPatched=true\),globalThis\.__cursorClientType\(\)\)/);
  assert.doesNotMatch(patched, /x-cursor-client-type":"sdk"/);
  assert.doesNotMatch(patched, /x-cursor-client-type","sdk"/);
});

test("patchCursorSdkSource matches installed @cursor/sdk ESM bundle", {
  skip: !findSdkEsmBundle()
}, () => {
  const bundle = findSdkEsmBundle();
  assert.ok(bundle);
  const source = readFileSync(bundle, "utf8");
  assert.match(source, /x-cursor-client-type","sdk"/);
  assert.match(source, /x-cursor-client-type":"sdk"/);
  const { source: patched, patched: changed } = patchCursorSdkSource(source);
  assert.equal(changed, true);
  assert.doesNotMatch(patched, /x-cursor-client-type":"sdk"/);
  assert.doesNotMatch(patched, /x-cursor-client-type","sdk"/);
  assert.match(patched, /globalThis\.__cursorClientType\(\)/);
});

test("ALS keeps concurrent requests on different client types", async () => {
  setGlobalCursorClientType("sdk");
  const seen: string[] = [];
  async function* ticks(label: string): AsyncIterable<string> {
    await Promise.resolve();
    seen.push(`${label}:${getCurrentCursorClientType()}`);
    yield label;
  }
  const [a, b] = await Promise.all([
    collect(iterateWithCursorClientType("sand", ticks("a"))),
    collect(iterateWithCursorClientType("sdk", ticks("b")))
  ]);
  assert.deepEqual(a, ["a"]);
  assert.deepEqual(b, ["b"]);
  assert.ok(seen.includes("a:sand"));
  assert.ok(seen.includes("b:sdk"));
  assert.equal(getCurrentCursorClientType(), "sdk");
});

test("iterateWithCursorClientType forwards return() so inner cleanup still runs", async () => {
  let returnedIn: string | undefined;
  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false, value: "x" };
        },
        async return() {
          returnedIn = getCurrentCursorClientType();
          return { done: true, value: undefined };
        }
      };
    }
  };
  const iterator = iterateWithCursorClientType("sand", iterable)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  assert.equal(returnedIn, "sand");
});

test("runWithCursorClientType restores the global default afterwards", () => {
  setGlobalCursorClientType("sdk");
  const inside = runWithCursorClientType("sand", () => getCurrentCursorClientType());
  assert.equal(inside, "sand");
  assert.equal(getCurrentCursorClientType(), "sdk");
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function findSdkEsmBundle(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@cursor/sdk/package.json");
    const bundle = join(dirname(pkg), "dist/esm/index.js");
    return existsSync(bundle) ? bundle : undefined;
  } catch {
    return undefined;
  }
}
