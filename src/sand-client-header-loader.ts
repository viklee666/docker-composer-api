/**
 * ESM loader hook：在 @cursor/sdk 打包产物求值前，把硬编码的
 *   x-cursor-client-type: "sdk"
 * 换成运行时函数调用，以便按请求切换 sdk / sand（不落盘）。
 *
 * 由 installSandClientHeaderHook() 通过 node:module register() 挂上。
 * register() 的 load 跑在独立线程，不能靠在这里写 globalThis 通知主线程；
 * 成功标志写进替换后的表达式，在应用线程求值时再生效。
 */
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

const SET_PATTERN = 'x-cursor-client-type","sdk"';
const LITERAL_PATTERN = 'x-cursor-client-type":"sdk"';
/** 逗号表达式：先在应用线程打成功标记，再读当前请求的 client-type。 */
const CLIENT_TYPE_EXPR = "((globalThis.__cursorSandHookPatched=true),globalThis.__cursorClientType())";
const SET_REPLACEMENT = `x-cursor-client-type",${CLIENT_TYPE_EXPR}`;
const LITERAL_REPLACEMENT = `x-cursor-client-type":${CLIENT_TYPE_EXPR}`;

type LoaderPort = { postMessage: (value: unknown) => void };
let reportPatched: (() => void) | undefined;

function isSdkBundle(url: string): boolean {
  return (
    typeof url === "string" &&
    !isBuiltin(url) &&
    url.startsWith("file:") &&
    /node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(url) &&
    url.endsWith(".js")
  );
}

function readModuleSource(url: string, source: string | Uint8Array | undefined): string | undefined {
  if (typeof source === "string") return source;
  if (source) {
    try {
      return new TextDecoder().decode(source);
    } catch {
      return undefined;
    }
  }
  // CJS / 部分 Node 版本对 commonjs 的 nextLoad.source 可能是 null，回读文件才能改到。
  if (!url.startsWith("file:")) return undefined;
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return undefined;
  }
}

/** 把 SDK bundle 里两处硬编码 client-type 换成运行时函数；其它源码原样返回。 */
export function patchCursorSdkSource(source: string): { source: string; patched: boolean } {
  const next = source.split(SET_PATTERN).join(SET_REPLACEMENT).split(LITERAL_PATTERN).join(LITERAL_REPLACEMENT);
  return { source: next, patched: next !== source };
}

export async function initialize(data: { port?: LoaderPort } = {}): Promise<void> {
  if (data.port) {
    reportPatched = () => data.port?.postMessage({ patched: true });
  }
}

export async function load(
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<{ source?: string | Uint8Array; format?: string }>
): Promise<{ source?: string | Uint8Array; format?: string }> {
  const result = await nextLoad(url, context);
  if (!isSdkBundle(url)) return result;
  const original = readModuleSource(url, result.source);
  if (typeof original !== "string") return result;
  const { source, patched } = patchCursorSdkSource(original);
  if (!patched) return result;
  reportPatched?.();
  console.error(`[sand-client-loader] patched client-type hook in ${url.split("node_modules").pop() ?? url}`);
  return { ...result, source };
}

export default function registerSelf(): { load: typeof load } {
  return { load };
}
