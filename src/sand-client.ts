import { AsyncLocalStorage } from "node:async_hooks";
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
import type { CursorClientType, CursorClientTypeSetting } from "./types.js";

declare global {
  // SDK loader 把硬编码 "sdk" 换成这个函数调用；必须挂在 globalThis 上。
  // eslint-disable-next-line no-var
  var __cursorClientType: (() => CursorClientType) | undefined;
  // eslint-disable-next-line no-var
  var __cursorSandHookPatched: boolean | undefined;
}

const als = new AsyncLocalStorage<CursorClientType>();

let globalClientType: CursorClientType = "sdk";
let hookInstalled = false;
let hookInstallError: string | undefined;
const patchedWaiters: Array<() => void> = [];

function readClientType(): CursorClientType {
  return als.getStore() ?? globalClientType;
}

function installGlobalReader(): void {
  globalThis.__cursorClientType = readClientType;
}

function markSandClientHookPatched(): void {
  globalThis.__cursorSandHookPatched = true;
  while (patchedWaiters.length) patchedWaiters.shift()?.();
}

/** 后台总开关 / 环境变量对应的默认通道。单个 key 未单独指定时走这里。 */
export function setGlobalCursorClientType(type: CursorClientType): void {
  globalClientType = type === "sand" ? "sand" : "sdk";
  installGlobalReader();
}

export function getGlobalCursorClientType(): CursorClientType {
  return globalClientType;
}

/** 当前异步上下文里实际会发给 Cursor 的 client-type（请求级覆盖优先于总开关）。 */
export function getCurrentCursorClientType(): CursorClientType {
  return readClientType();
}

export function parseCursorClientTypeSetting(value: unknown): CursorClientTypeSetting | undefined {
  if (value === "inherit" || value === "sdk" || value === "sand") return value;
  return undefined;
}

export function resolveCursorClientType(
  keySetting: CursorClientTypeSetting | undefined,
  fallback: CursorClientType = globalClientType
): CursorClientType {
  if (keySetting === "sand" || keySetting === "sdk") return keySetting;
  return fallback === "sand" ? "sand" : "sdk";
}

export function runWithCursorClientType<T>(type: CursorClientType, fn: () => T): T {
  return als.run(type === "sand" ? "sand" : "sdk", fn);
}

/**
 * 迭代上游 async iterable 时保持 client-type 上下文。
 * 不用 async generator + yield*：生成器在 ALS.run 外被迭代会丢掉 store，
 * 且默认 return() 不会转发到内层，会打断 6afa0ba 的断连 cancel/dispose 收尾。
 */
export function iterateWithCursorClientType<T>(
  type: CursorClientType,
  iterable: AsyncIterable<T>
): AsyncIterable<T> {
  const clientType: CursorClientType = type === "sand" ? "sand" : "sdk";
  const enter = <R>(fn: () => R): R => als.run(clientType, fn);
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]();
      return {
        next: () => enter(() => iterator.next()),
        return: (value?: unknown) => enter(
          () => iterator.return?.(value) ?? Promise.resolve({ done: true as const, value: undefined })
        ),
        throw: (error?: unknown) => enter(() => {
          if (iterator.throw) return iterator.throw(error);
          return Promise.reject(error);
        })
      };
    }
  };
}

export function isSandClientHookPatched(): boolean {
  return globalThis.__cursorSandHookPatched === true;
}

export function sandClientHookInstallError(): string | undefined {
  return hookInstallError;
}

/** SDK import() 返回后等一小段，让 loader 线程的 patched 消息落到主线程。 */
export function waitForSandClientHook(timeoutMs = 1000): Promise<boolean> {
  if (isSandClientHookPatched()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(isSandClientHookPatched()), timeoutMs);
    timer.unref?.();
    patchedWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 必须在首次 import("@cursor/sdk") 之前调用。
 * 用 register() 挂 loader，Docker CMD 不用改；loader 打进 dist，runtime 镜像已有。
 */
export function installSandClientHeaderHook(): void {
  if (hookInstalled || hookInstallError) return;
  installGlobalReader();
  try {
    const { port1, port2 } = new MessageChannel();
    port1.on("message", (data: { patched?: unknown }) => {
      if (data?.patched) markSandClientHookPatched();
    });
    try {
      register("./sand-client-header-loader.js", import.meta.url, {
        data: { port: port2 },
        transferList: [port2]
      });
    } catch {
      // 旧 Node 若不接受 transferList，退回无 port 的 register；成功标记仍靠替换表达式在应用线程写入。
      register("./sand-client-header-loader.js", import.meta.url);
    }
    hookInstalled = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hookInstallError = message;
    console.error(`[sand-client] failed to register header hook: ${message.slice(0, 200)}`);
  }
}
