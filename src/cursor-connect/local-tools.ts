import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
import type { GatewayTool, GatewayToolCall } from "../types.js";
import type { ToolExecution } from "./tool-loop.js";

/**
 * 网关本地工具（计划 §G6.2）。**默认全关。**
 *
 * 这里刻意只提供机制，不提供 shell：模型能直接跑命令就等于拿到了 Docker 宿主机权限。
 * 内置的 `read_file` 只是让 containment / 校验 / 截断 / 审计这套机制有一个被真实走通的例子，
 * 它同样要显式列进 allowlist 才会生效。
 */
export interface LocalToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 子集：只支持 object + 顶层属性的类型与 required。 */
  inputSchema: LocalToolSchema;
  execute(args: Record<string, unknown>, context: LocalToolContext): Promise<unknown>;
}

export interface LocalToolSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean"; description?: string }>;
  required?: string[];
}

export interface LocalToolContext {
  workspace: string;
  /** 单次输出的字节上限。工具应在**产生**大输出之前就用它挡住，而不是产生完再截断。 */
  maxBytes: number;
  /** 超时或上游取消时会被 abort。工具必须把它透传给底层 IO，否则超时只是"不再等"。 */
  signal: AbortSignal;
}

export interface LocalToolAudit {
  tool: string;
  callId: string;
  ok: boolean;
  durationMs: number;
  /** 出错时的短消息；成功时为空。参数与结果不进审计日志。 */
  error?: string;
}

export interface LocalToolRegistryOptions {
  /** 工作区根目录。所有路径参数都必须落在它下面。 */
  workspace: string;
  /** 允许启用的工具名。**空数组 = 全关**，这是默认。 */
  allowlist?: string[];
  /** 单次执行超时。 */
  timeoutMs?: number;
  /** 结果字符串截断长度，防止一个大文件把整个 prompt 撑爆。 */
  maxOutputChars?: number;
  /** 审批钩子：返回 false 直接拒绝。默认放行（allowlist 已经是第一道闸）。 */
  approve?: (call: GatewayToolCall) => boolean | Promise<boolean>;
  onAudit?: (entry: LocalToolAudit) => void;
  /** 额外注册的工具（内置之外）。 */
  tools?: LocalToolDefinition[];
}

export const DEFAULT_LOCAL_TOOL_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCAL_TOOL_MAX_OUTPUT = 64 * 1024;

export class LocalToolRegistry {
  private readonly tools = new Map<string, LocalToolDefinition>();
  private readonly allowlist: ReadonlySet<string>;
  private readonly workspace: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(private readonly options: LocalToolRegistryOptions) {
    this.workspace = resolve(options.workspace);
    this.allowlist = new Set(options.allowlist ?? []);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_TOOL_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_LOCAL_TOOL_MAX_OUTPUT;
    for (const tool of builtinTools()) this.tools.set(tool.name, tool);
    for (const tool of options.tools ?? []) {
      // 拒绝覆盖内置工具：悄悄影子掉 `read_file` 的话，allowlist 里那一项就会
      // 在管理员不知情的情况下变成给一个完全不同的实现放行。
      if (this.tools.has(tool.name)) {
        throw new ApiError(`Local tool "${tool.name}" is already registered.`, 500, "invalid_request_error");
      }
      this.tools.set(tool.name, tool);
    }
    const unknown = [...this.allowlist].filter((name) => !this.tools.has(name));
    if (unknown.length) {
      console.warn(`[cursor-connect] local tool allowlist names unknown tools: ${unknown.join(", ")}`);
    }
  }

  /** 实际启用的工具（allowlist ∩ 已注册）。默认为空。 */
  enabled(): LocalToolDefinition[] {
    return [...this.tools.values()].filter((tool) => this.allowlist.has(tool.name));
  }

  /** 可以声明给上游的工具定义。全关时是空数组，请求里就不会有 tools 字段。 */
  advertise(): GatewayTool[] {
    return this.enabled().map((tool) => ({
      name: tool.name,
      description: tool.description,
      // 深拷贝：直接交出去的话，请求侧任何一次改写都会永久改掉本地工具的校验 schema。
      inputSchema: structuredClone(tool.inputSchema)
    }));
  }

  /**
   * 执行一个工具调用。返回 `undefined` 表示「这个工具不归网关管」——
   * tool-loop 会把它交回调用方，而不是当成执行失败。
   */
  async execute(call: GatewayToolCall, signal?: AbortSignal): Promise<ToolExecution | undefined> {
    const tool = this.tools.get(call.name);
    if (!tool || !this.allowlist.has(call.name)) return undefined;

    const startedAt = Date.now();
    // 超时要真的能打断底层 IO，不能只是停止等待——不然一个超大文件"超时"之后还在继续吃内存。
    const controller = new AbortController();
    const abortOnCaller = () => controller.abort();
    signal?.addEventListener("abort", abortOnCaller, { once: true });
    try {
      // 先校验再审批：审批钩子拿到的应该是已经过了类型校验的参数。
      validateArgs(tool, call.arguments);
      if (this.options.approve && !(await this.options.approve(call))) {
        throw new ApiError(`Local tool ${call.name} was denied by policy.`, 403, "forbidden");
      }
      const raw = await withTimeout(
        tool.execute(call.arguments, {
          workspace: this.workspace,
          maxBytes: this.maxOutputChars,
          signal: controller.signal
        }),
        this.timeoutMs,
        call.name,
        controller
      );
      const result = truncate(raw, this.maxOutputChars);
      this.audit({ tool: call.name, callId: call.id, ok: true, durationMs: Date.now() - startedAt });
      return { result };
    } catch (error) {
      // 审计里只记错误**类别**，不记 message：底层 IO 错误的 message 常常原样带着路径，
      // 那就是参数内容，与"参数与结果不进审计日志"的承诺冲突。
      this.audit({
        tool: call.name,
        callId: call.id,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof ApiError ? error.code : "local_tool_failed"
      });
      const message = error instanceof Error ? error.message.slice(0, 200) : "local tool failed";
      // 失败作为 tool result 回灌，模型可以换个做法；抛出去只会把整条流打断。
      return { result: { error: message }, isError: true };
    } finally {
      signal?.removeEventListener("abort", abortOnCaller);
    }
  }

  private audit(entry: LocalToolAudit): void {
    this.options.onAudit?.(entry);
  }
}

/**
 * 把相对路径解析到工作区内，并挡住符号链接逃逸。
 *
 * 只做字符串前缀比较是不够的：`workspace/link → /etc` 这种软链，字符串上完全合法。
 * 所以要 realpath 之后再比一次；目标不存在时退一步校验它的父目录，
 * 否则「写一个还不存在的文件」这类操作会永远被拒。
 */
export async function resolveWithinWorkspace(workspace: string, candidate: string): Promise<string> {
  if (typeof candidate !== "string" || !candidate) {
    throw new ApiError("path must be a non-empty string.", 400, "invalid_request_error");
  }
  const root = await realpath(resolve(workspace));
  // 绝对路径也要过一遍 resolve 归一化。不归一化的话 `/ws/link/x/..` 这种写法会走进下面的
  // "目标不存在"分支，而那条分支只做字符串拼接，会把 `link` 这个软链原样留在结果里——
  // 前缀检查看着在根内，实际读的时候 OS 会跟着软链出去。
  const target = resolve(isAbsolute(candidate) ? candidate : resolve(root, candidate));

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    // 只允许**最后一段**未解析（那是还不存在的文件名）。用 dirname/basename 而不是
    // 按字符串长度切，才能保证中间不会残留任何未解析的软链。
    const realParent = await realpath(dirname(target)).catch(() => {
      throw new ApiError("path escapes the workspace.", 403, "forbidden");
    });
    real = resolve(realParent, basename(target));
  }

  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new ApiError("path escapes the workspace.", 403, "forbidden");
  }
  return real;
}

function builtinTools(): LocalToolDefinition[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the gateway workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace root." } },
        required: ["path"]
      },
      async execute(args, context) {
        const path = await resolveWithinWorkspace(context.workspace, String(args.path));
        // 只 open 一次，之后的 stat / read 都对着同一个 fd。
        // 用路径重新 syscall 的话，检查与读取之间被换成软链就会读到工作区外面。
        const handle = await open(path, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new ApiError("path is not a regular file.", 400, "invalid_request_error");
          // 只读上限那么多字节，而不是整个读进来再切：后者对一个 100MB 的文件
          // 依然要先吃掉 100MB 内存，截断只是把结果变短了而已。
          const buffer = Buffer.alloc(Math.min(info.size, context.maxBytes + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const text = buffer.subarray(0, bytesRead).toString("utf8");
          return bytesRead > context.maxBytes ? text.slice(0, context.maxBytes) : text;
        } finally {
          await handle.close();
        }
      }
    }
  ];
}

/**
 * `InferenceAgentTool.parameters` 是 Struct，上游不会替我们校验，
 * 所以参数校验必须在网关这边做——否则一个类型不对的参数会一路传到本地文件系统调用上。
 */
function validateArgs(tool: LocalToolDefinition, args: Record<string, unknown>): void {
  for (const name of tool.inputSchema.required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      throw new ApiError(`${tool.name}: missing required argument "${name}".`, 400, "invalid_request_error");
    }
  }
  for (const [name, value] of Object.entries(args)) {
    // `Object.hasOwn` 而不是索引取值：`__proto__` / `constructor` 这类键
    // 从原型链上取得到一个真值，会被当成"这个参数是合法的"。
    const spec = Object.hasOwn(tool.inputSchema.properties, name) ? tool.inputSchema.properties[name] : undefined;
    if (!spec) {
      throw new ApiError(`${tool.name}: unexpected argument "${name}".`, 400, "invalid_request_error");
    }
    if (typeof value !== spec.type) {
      throw new ApiError(
        `${tool.name}: argument "${name}" must be ${spec.type}, got ${typeof value}.`,
        400,
        "invalid_request_error"
      );
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  tool: string,
  controller: AbortController
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // 先 abort 再 reject：只 reject 的话调用方不再等了，底层工作还在跑。
          controller.abort();
          reject(new ApiError(`Local tool ${tool} timed out.`, 504, "timeout_error"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 非字符串结果同样要封顶：一个巨大的数组或对象照样能把 prompt 撑爆。 */
function truncate(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
  }
  if (value === null || value === undefined || typeof value !== "object") return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { error: "tool result is not serializable" };
  }
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: `${serialized.slice(0, maxChars)}…`, originalChars: serialized.length };
}
