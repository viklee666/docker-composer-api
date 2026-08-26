/**
 * 与 src/sand-client-header-loader.ts 同逻辑的手工入口。
 * 生产路径走 dist 里编译后的 loader + register()，不要用 --experimental-loader 把字面量写死成 sand。
 */
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

const SET_PATTERN = 'x-cursor-client-type","sdk"';
const LITERAL_PATTERN = 'x-cursor-client-type":"sdk"';
const CLIENT_TYPE_EXPR = "((globalThis.__cursorSandHookPatched=true),globalThis.__cursorClientType())";

function isSdkBundle(url) {
  return (
    typeof url === "string" &&
    !isBuiltin(url) &&
    url.startsWith("file:") &&
    /node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(url) &&
    url.endsWith(".js")
  );
}

function readModuleSource(url, source) {
  if (typeof source === "string") return source;
  if (source) {
    try {
      return new TextDecoder().decode(source);
    } catch {
      return undefined;
    }
  }
  if (!url.startsWith("file:")) return undefined;
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return undefined;
  }
}

export function patchCursorSdkSource(source) {
  const next = source
    .split(SET_PATTERN)
    .join(`x-cursor-client-type",${CLIENT_TYPE_EXPR}`)
    .split(LITERAL_PATTERN)
    .join(`x-cursor-client-type":${CLIENT_TYPE_EXPR}`);
  return { source: next, patched: next !== source };
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!isSdkBundle(url)) return result;
  const original = readModuleSource(url, result.source);
  if (typeof original !== "string") return result;
  const { source, patched } = patchCursorSdkSource(original);
  if (!patched) return result;
  console.error(`[sand-client-loader] patched client-type hook in ${url.split("node_modules").pop()}`);
  return { ...result, source };
}

export default function registerSelf() {
  return { load };
}
