import { ApiError } from "../errors.js";
import { encodeRequestEnvelope, type ConnectCompression } from "./envelope.js";
import { endStreamError, envelopeError, parseEndStream } from "./errors.js";
import { buildConnectHeaders, type ConnectCodec } from "./headers.js";
import { assertUsableCredential, type CursorConnectCredential } from "./credentials.js";
import { postConnectStream, type ConnectFetch } from "./transport.js";
import { InferenceStreamRequest, InferenceStreamResponse } from "./proto/inference_pb.js";

export const DEFAULT_CONNECT_BASE_URL = "https://api2.cursor.sh";

/** 与客户端的 `acceptCompression: [gzip, br]` 对齐；envelope 层两种都能解。 */
export const DEFAULT_ACCEPT_ENCODING = "gzip, br";

/**
 * 推理服务与方法。第二部分走 ServerStreaming 的 `Stream`：
 * 它与 `POST /v1/chat/completions` 的生命周期 1:1 对齐，且不需要 HTTP/2 双向流。
 * `RunInference`（BiDiStreaming）没有 SSE/poll 回退，留到确有需要时再加——
 * 两者载荷类型相同，届时换的只是 transport 与握手。
 */
export const INFERENCE_SERVICE = "aiserver.v1.InferenceService";
export const STREAM_METHOD = "Stream";

export interface CursorConnectClientOptions {
  credential: CursorConnectCredential;
  /** 必须可配置：客户端自己也是从配置读 baseUrl 的，不能写死。 */
  baseUrl?: string;
  /** 默认 proto（客户端 `useBinaryFormat:!0`）。json 只作调试用。 */
  codec?: ConnectCodec;
  /** 请求体压缩；默认 identity。 */
  requestCompression?: ConnectCompression;
  /** 声明可接受的响应压缩。 */
  acceptEncoding?: string;
  readMaxBytes?: number;
  fetchImpl?: ConnectFetch;
  /** 测试注入固定时间，让 checksum 可断言。 */
  nowMs?: () => number;
}

export function methodUrl(baseUrl: string, service: string, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${service}/${method}`;
}

export class CursorConnectClient {
  private readonly baseUrl: string;
  private readonly codec: ConnectCodec;

  constructor(private readonly options: CursorConnectClientOptions) {
    assertUsableCredential(options.credential);
    this.baseUrl = options.baseUrl?.trim() || DEFAULT_CONNECT_BASE_URL;
    this.codec = options.codec ?? "proto";
  }

  get streamUrl(): string {
    return methodUrl(this.baseUrl, INFERENCE_SERVICE, STREAM_METHOD);
  }

  /**
   * `InferenceService/Stream`：发一条 `InferenceStreamRequest`，收一串 `InferenceStreamResponse`。
   *
   * endStream 帧里带 error 时抛出，不当成正常收流——Connect 的流式错误可以出现在 HTTP 200 之下，
   * 只看状态码会把失败的请求当成空响应交给客户端。
   */
  async *stream(request: InferenceStreamRequest, signal?: AbortSignal): AsyncGenerator<InferenceStreamResponse> {
    const payload = this.encode(request);
    const { frame, compressed } = await encodeRequestEnvelope(payload, {
      compression: this.options.requestCompression
    });
    const headers = buildConnectHeaders({
      credential: this.options.credential,
      codec: this.codec,
      acceptEncoding: this.options.acceptEncoding ?? DEFAULT_ACCEPT_ENCODING,
      contentEncoding: compressed ? (this.options.requestCompression as "gzip" | "br") : undefined,
      nowMs: this.options.nowMs?.()
    });

    const { frames } = await postConnectStream({
      url: this.streamUrl,
      headers,
      body: frame,
      signal,
      readMaxBytes: this.options.readMaxBytes,
      fetchImpl: this.options.fetchImpl
    });

    let sawEndStream = false;
    try {
      for await (const item of frames) {
        if (item.endStream) {
          sawEndStream = true;
          const end = parseEndStream(item.data);
          if (end.error) throw endStreamError(end.error);
          return;
        }
        yield this.decode(item.data);
      }
    } catch (error) {
      // 超长帧 / 半包截断在 envelope 层是普通 Error，不转成 ApiError 就会被
      // normalizeError 归成 500 internal_error 并把内部消息透给调用方。
      throw envelopeError(error) ?? error;
    }
    if (!sawEndStream) {
      throw new ApiError("Cursor Connect stream ended without an end-of-stream frame.", 502, "upstream_error");
    }
  }

  private encode(request: InferenceStreamRequest): Uint8Array {
    return this.codec === "json"
      ? new TextEncoder().encode(request.toJsonString())
      : request.toBinary();
  }

  private decode(payload: Uint8Array): InferenceStreamResponse {
    return this.codec === "json"
      ? InferenceStreamResponse.fromJsonString(Buffer.from(payload).toString("utf8"))
      : InferenceStreamResponse.fromBinary(payload);
  }
}
