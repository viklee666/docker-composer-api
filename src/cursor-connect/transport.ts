import { ApiError } from "../errors.js";
import { endStreamError, httpTransportError } from "./errors.js";
import {
  DEFAULT_READ_MAX_BYTES,
  parseCompression,
  readEnvelopes,
  type ConnectFrame
} from "./envelope.js";

/**
 * 出站一律走全局 `fetch`。
 *
 * `proxy.ts` 是用 `setGlobalDispatcher()` 把代理装到 undici 全局 dispatcher 上的，
 * 所以只有走全局 fetch 的请求才会被代理拦住。自带 HTTP/2 客户端的 Connect 运行时
 * （`@connectrpc/connect-node`）会绕开这套配置，代理、SOCKS、超时全部失效——
 * 这就是本模块自己实现 envelope 与 transport、不引那套栈的原因。
 */
export type ConnectFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ConnectStreamOptions {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal?: AbortSignal;
  readMaxBytes?: number;
  fetchImpl?: ConnectFetch;
}

export interface ConnectStreamResult {
  status: number;
  headers: Headers;
  frames: AsyncGenerator<ConnectFrame>;
}

/** 上游返回非 Connect 流时，最多读这么多字节用于错误消息。 */
const ERROR_BODY_LIMIT = 8 * 1024;

export async function postConnectStream(options: ConnectStreamOptions): Promise<ConnectStreamResult> {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      // Connect 端点不会重定向；跟着跳只会把 Authorization 送到别处。
      redirect: "manual"
    });
  } catch (error) {
    if (isAbortError(error)) throw new ApiError("Request was aborted.", 499, "request_aborted");
    throw new ApiError(`Cursor Connect transport failed: ${transportErrorText(error)}`, 502, "upstream_error");
  }

  if (response.status < 200 || response.status >= 300) {
    throw httpTransportError(response.status, await readLimited(response));
  }
  if (!response.body) {
    throw new ApiError("Cursor Connect response carried no body.", 502, "upstream_error");
  }

  let compression;
  try {
    compression = parseCompression(
      response.headers.get("connect-content-encoding") ?? response.headers.get("content-encoding")
    );
  } catch (error) {
    // 这里已经拿到了响应体：直接抛会把 socket 留在半开状态，必须先 cancel 再报错。
    await response.body.cancel().catch(() => undefined);
    throw new ApiError(`Cursor Connect response is unreadable: ${transportErrorText(error)}`, 502, "upstream_error");
  }

  const frames = readEnvelopes(iterateBody(response.body), {
    compression,
    readMaxBytes: options.readMaxBytes ?? DEFAULT_READ_MAX_BYTES
  });
  return { status: response.status, headers: response.headers, frames };
}

export interface ConnectUnaryOptions {
  url: string;
  headers: Record<string, string>;
  /** 裸 protobuf / JSON，**不带 envelope**。 */
  body: Uint8Array;
  signal?: AbortSignal;
  fetchImpl?: ConnectFetch;
}

/**
 * Connect 的一元调用。
 *
 * 与流式的差别不只是"少了 envelope"：content-type 也不同（`application/proto`
 * 而非 `application/connect+proto`），发错会被服务端以 **415** 拒掉——这是实测到的。
 * 错误也不同：一元的错误就是 HTTP 状态码 + JSON body `{code, message, details}`，
 * 没有 endStream 帧那一层。
 */
export async function postConnectUnary(options: ConnectUnaryOptions): Promise<Uint8Array> {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      redirect: "manual"
    });
  } catch (error) {
    if (isAbortError(error)) throw new ApiError("Request was aborted.", 499, "request_aborted");
    throw new ApiError(`Cursor Connect transport failed: ${transportErrorText(error)}`, 502, "upstream_error");
  }

  if (response.status < 200 || response.status >= 300) {
    throw unaryError(response.status, await readLimited(response));
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * 一元错误体是 Connect 的 JSON 形状 `{code, message}`。
 * 能解析出 code 就按 Connect code 映射，否则退回 HTTP 状态。
 */
function unaryError(status: number, bodyText: string): ApiError {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: string; message?: string };
      if (parsed.code) return endStreamError(parsed);
    } catch {
      // 落到下面按 HTTP 状态处理。
    }
  }
  return httpTransportError(status, bodyText);
}

/**
 * 手动持 reader 而不是 `for await (const c of body)`：
 * 消费方提前 break（客户端断连、命中 endStream）时 `finally` 必须能 cancel 掉 reader，
 * 否则底层 socket 会一直挂着直到上游自己超时。
 */
async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readLimited(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, ERROR_BODY_LIMIT);
  } catch {
    return "";
  }
}

/** `AbortSignal` 打断 fetch 时抛的是 DOMException(AbortError)，undici 还可能再包一层 cause。 */
function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as { name?: unknown; cause?: unknown };
    if (record.name === "AbortError" || record.name === "TimeoutError") return true;
    current = record.cause;
  }
  return false;
}

/** 传输层异常可能把整条 URL（含查询串）带进消息，只取错误类型与短消息。 */
function transportErrorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown transport error";
}
