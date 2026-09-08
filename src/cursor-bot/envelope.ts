import { brotliDecompress, brotliCompress, gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const brotliDecompressAsync = promisify(brotliDecompress);
const brotliCompressAsync = promisify(brotliCompress);

/** envelope 头固定 5 字节：1 字节 flags + 4 字节大端 payload 长度。 */
export const ENVELOPE_HEADER_BYTES = 5;

/** flags 位 0：payload 已按 connect-content-encoding 压缩。 */
export const FLAG_COMPRESSED = 0b01;
/** flags 位 1：payload 是 EndStreamResponse(JSON) 而不是业务消息，且它一定是最后一帧。 */
export const FLAG_END_STREAM = 0b10;

/**
 * 单帧 payload 上限。客户端自己用的是 0xFFFFFFFF，网关不能跟——
 * 那等于让上游的一个 4 字节长度域直接决定我们分配多少内存。
 */
export const DEFAULT_READ_MAX_BYTES = 32 * 1024 * 1024;

/** 低于该长度不压缩：压缩收益抵不上 CPU 与延迟。 */
export const DEFAULT_COMPRESS_MIN_BYTES = 1024;

export type ConnectCompression = "identity" | "gzip" | "br";

export interface ConnectFrame {
  /** 解压后的 payload。 */
  data: Uint8Array;
  /** 该帧是否是 EndStreamResponse。 */
  endStream: boolean;
}

/** payload 长度超过 readMaxBytes 时抛出，调用方应映射成 resource_exhausted。 */
export class EnvelopeTooLargeError extends Error {
  constructor(
    readonly declaredBytes: number,
    readonly maxBytes: number
  ) {
    super(`Connect envelope declares ${declaredBytes} bytes, over the ${maxBytes} byte limit.`);
    this.name = "EnvelopeTooLargeError";
  }
}

/** 流在半个 envelope 中间结束（半包 header 或半包 payload）。 */
export class TruncatedEnvelopeError extends Error {
  constructor(readonly pendingBytes: number) {
    super(`Connect stream ended mid-envelope with ${pendingBytes} buffered bytes.`);
    this.name = "TruncatedEnvelopeError";
  }
}

export function encodeEnvelope(payload: Uint8Array, options: { endStream?: boolean; compressed?: boolean } = {}): Uint8Array {
  const frame = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.length);
  frame[0] = (options.compressed ? FLAG_COMPRESSED : 0) | (options.endStream ? FLAG_END_STREAM : 0);
  new DataView(frame.buffer, frame.byteOffset, ENVELOPE_HEADER_BYTES).setUint32(1, payload.length, false);
  frame.set(payload, ENVELOPE_HEADER_BYTES);
  return frame;
}

/**
 * 按 connect-content-encoding 压缩一条请求 payload。
 * 小于 minBytes 时原样返回并置 compressed=false —— 客户端也是这么做的，
 * 强行压小包只会让请求变大。
 */
export async function encodeRequestEnvelope(
  payload: Uint8Array,
  options: { compression?: ConnectCompression; minBytes?: number } = {}
): Promise<{ frame: Uint8Array; compressed: boolean }> {
  const compression = options.compression ?? "identity";
  const minBytes = options.minBytes ?? DEFAULT_COMPRESS_MIN_BYTES;
  if (compression === "identity" || payload.length < minBytes) {
    return { frame: encodeEnvelope(payload), compressed: false };
  }
  const compressed = await compress(payload, compression);
  return { frame: encodeEnvelope(compressed, { compressed: true }), compressed: true };
}

/**
 * 增量 envelope 切帧器：只负责「凑够 5 字节头 + len 字节体」，不解压。
 * chunk 边界与帧边界无关，半包 header、半包 payload、一个 chunk 里挤多帧、
 * 一帧跨多个 chunk 四种情况都必须走同一条路径，所以缓冲与切帧要与解压分离。
 */
export class EnvelopeSplitter {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  /** chunks[0] 里已经被消费掉的字节数，避免每次读都重新拼整段。 */
  private offset = 0;

  constructor(private readonly readMaxBytes: number = DEFAULT_READ_MAX_BYTES) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  /** 取出当前缓冲里所有完整帧；不足一帧时返回空数组，剩余字节留到下次。 */
  takeFrames(): Array<{ flags: number; data: Uint8Array }> {
    const frames: Array<{ flags: number; data: Uint8Array }> = [];
    for (;;) {
      if (this.buffered < ENVELOPE_HEADER_BYTES) return frames;
      const header = this.peek(ENVELOPE_HEADER_BYTES);
      const length = new DataView(header.buffer, header.byteOffset, ENVELOPE_HEADER_BYTES).getUint32(1, false);
      // 长度校验必须在分配之前：先 new Uint8Array(length) 再判断，等于把 OOM 交给上游决定。
      if (length > this.readMaxBytes) throw new EnvelopeTooLargeError(length, this.readMaxBytes);
      if (this.buffered < ENVELOPE_HEADER_BYTES + length) return frames;
      this.skip(ENVELOPE_HEADER_BYTES);
      frames.push({ flags: header[0], data: this.read(length) });
    }
  }

  /** 流结束时调用：还有残留字节说明上游截断了。 */
  end(): void {
    if (this.buffered > 0) throw new TruncatedEnvelopeError(this.buffered);
  }

  private peek(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let written = 0;
    let offset = this.offset;
    for (const chunk of this.chunks) {
      const available = chunk.length - offset;
      const take = Math.min(available, count - written);
      out.set(chunk.subarray(offset, offset + take), written);
      written += take;
      offset = 0;
      if (written === count) break;
    }
    return out;
  }

  private read(count: number): Uint8Array {
    const out = this.peek(count);
    this.skip(count);
    return out;
  }

  private skip(count: number): void {
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.offset;
      if (available > remaining) {
        this.offset += remaining;
        remaining = 0;
      } else {
        this.chunks.shift();
        this.offset = 0;
        remaining -= available;
      }
    }
    this.buffered -= count;
  }
}

/**
 * 把字节流切成解压后的帧。
 * `endStream` 帧之后不再产出任何帧——Connect 规定它是流的最后一帧，
 * 之后还有字节说明上游有问题，直接忽略比继续解析更安全。
 */
export async function* readEnvelopes(
  chunks: AsyncIterable<Uint8Array>,
  options: { compression?: ConnectCompression; readMaxBytes?: number } = {}
): AsyncGenerator<ConnectFrame> {
  const compression = options.compression ?? "identity";
  const readMaxBytes = options.readMaxBytes ?? DEFAULT_READ_MAX_BYTES;
  const splitter = new EnvelopeSplitter(readMaxBytes);

  for await (const chunk of chunks) {
    splitter.push(chunk);
    for (const frame of splitter.takeFrames()) {
      const decoded = await decodeFrame(frame, compression, readMaxBytes);
      yield decoded;
      // 直接 return 而不是 break：break 只跳出内层，外层 for await 还会再向上游要一个 chunk，
      // 而 endStream 之后上游通常不再发任何东西，那一次读只会白等。
      // 提前 return 还会让 finally 链把底层 reader cancel 掉。
      if (decoded.endStream) return;
    }
  }
  // 走到这里说明上游把连接关了却没发过 endStream；此时还有残留字节就是截断。
  splitter.end();
}

async function decodeFrame(
  frame: { flags: number; data: Uint8Array },
  compression: ConnectCompression,
  readMaxBytes: number
): Promise<ConnectFrame> {
  let data = frame.data;
  if ((frame.flags & FLAG_COMPRESSED) === FLAG_COMPRESSED) {
    if (compression === "identity") {
      throw new Error("Connect frame is flagged compressed but the response declared no content encoding.");
    }
    data = await decompress(data, compression, readMaxBytes);
  }
  return { data, endStream: (frame.flags & FLAG_END_STREAM) === FLAG_END_STREAM };
}

/** 响应头里的 connect-content-encoding / content-encoding 归一化；空值按 identity。 */
export function parseCompression(value: string | null | undefined): ConnectCompression {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "identity") return "identity";
  if (normalized === "gzip") return "gzip";
  if (normalized === "br") return "br";
  throw new Error(`Unsupported Connect content encoding: ${normalized}`);
}

async function compress(payload: Uint8Array, compression: Exclude<ConnectCompression, "identity">): Promise<Uint8Array> {
  const out = compression === "gzip" ? await gzipAsync(payload) : await brotliCompressAsync(payload);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * 解压同样要有上限：压缩帧的 4 字节长度域只约束压缩后的大小，
 * 一个几 KB 的 gzip 炸弹可以解出几 GB。
 *
 * 超限时 zlib 抛的是 `ERR_BUFFER_TOO_LARGE`，消息里带的是 Node 的内部缓冲区上限。
 * 换成 `EnvelopeTooLargeError`，与「声明长度超限」走同一条对外错误路径，
 * 也免得把 Node 的内部数字透给调用方。
 */
async function decompress(
  payload: Uint8Array,
  compression: Exclude<ConnectCompression, "identity">,
  readMaxBytes: number
): Promise<Uint8Array> {
  try {
    const out =
      compression === "gzip"
        ? await gunzipAsync(payload, { maxOutputLength: readMaxBytes })
        : await brotliDecompressAsync(payload, { maxOutputLength: readMaxBytes });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new EnvelopeTooLargeError(readMaxBytes + 1, readMaxBytes);
    }
    throw error;
  }
}
