import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { cursorChecksum } from "../src/cursor-connect/checksum.js";
import {
  assertUsableCredential,
  cursorTokenType,
  type CursorConnectCredential
} from "../src/cursor-connect/credentials.js";
import {
  DEFAULT_READ_MAX_BYTES,
  EnvelopeTooLargeError,
  TruncatedEnvelopeError,
  encodeEnvelope,
  encodeRequestEnvelope,
  parseCompression,
  readEnvelopes
} from "../src/cursor-connect/envelope.js";
import {
  connectCodeToStatus,
  endStreamError,
  httpTransportError,
  inferenceStreamError,
  parseEndStream
} from "../src/cursor-connect/errors.js";
import { buildConnectHeaders, redactHeaders } from "../src/cursor-connect/headers.js";
import * as pb from "../src/cursor-connect/proto/inference_pb.js";

const DESCRIPTOR_PATH = path.resolve(process.cwd(), "docs/reference/inference-descriptor-8844.txt");

/* ------------------------------------------------------------ descriptor 对照 */

interface DescriptorField {
  no: number;
  name: string;
  kind: string;
  repeated: boolean;
  opt: boolean;
  oneof?: string;
  ref: string;
}

/**
 * 直接解析 descriptor 原文的 `newFieldList`，与生成物逐条比对。
 * 这个测试的意义是「生成物没有偏离 657.js」——所以它必须自己解析原文，
 * 不能复用 scripts/gen-inference-pb.mjs 的解析器，否则解析器错了两边会一起错。
 */
function parseDescriptor(): Map<string, DescriptorField[]> {
  const source = readFileSync(DESCRIPTOR_PATH, "utf8");
  const localToTypeName = new Map<string, string>();
  const enumLocalToTypeName = new Map<string, string>();
  for (const match of source.matchAll(/([\w$]+)\.typeName="([^"]+)"/g)) localToTypeName.set(match[1], match[2]);
  for (const match of source.matchAll(/setEnumType\(([\w$]+),"([^"]+)"/g)) enumLocalToTypeName.set(match[1], match[2]);

  const result = new Map<string, DescriptorField[]>();
  const header = /([\w$]+)\.fields=a\.proto3\.util\.newFieldList\(\(\)=>/g;
  for (const match of source.matchAll(header)) {
    const typeName = localToTypeName.get(match[1]);
    assert.ok(typeName, `descriptor: ${match[1]} 没有 typeName`);
    const array = balanced(source, match.index + match[0].length, "[", "]");
    result.set(typeName, splitObjects(array.slice(1, -1)).map((raw) => toField(raw, localToTypeName, enumLocalToTypeName)));
  }
  return result;
}

function toField(
  raw: string,
  localToTypeName: Map<string, string>,
  enumLocalToTypeName: Map<string, string>
): DescriptorField {
  const pick = (key: string): string | undefined => {
    const match = new RegExp(`(?:^|,)${key}:`).exec(raw);
    if (!match) return undefined;
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = "";
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"') quote = ch;
      else if ("{[(".includes(ch)) depth += 1;
      else if (")]}".includes(ch)) depth -= 1;
      else if (ch === "," && depth === 0) return raw.slice(start, i);
    }
    return raw.slice(start);
  };
  const unquote = (value: string | undefined): string | undefined => value?.replaceAll('"', "");
  const kind = unquote(pick("kind"));
  assert.ok(kind, `descriptor 字段缺 kind：${raw}`);

  // `T` 可能是 ES 简写属性（局部变量恰好叫 T），此时正则取不到值。
  const rawT = pick("T") ?? (/(?:^|,)T(?:,|$)/.test(raw) ? "T" : undefined);
  let ref = "";
  if (kind === "scalar") ref = `scalar:${rawT}`;
  else if (kind === "enum") ref = `enum:${enumLocalToTypeName.get(/getEnumType\(([\w$]+)\)/.exec(rawT ?? "")?.[1] ?? "")}`;
  else if (kind === "message") ref = `message:${wellKnownOrLocal(rawT ?? "", localToTypeName)}`;
  else ref = `map:${pick("K")}:${unquote(pick("V"))}`;

  return {
    no: Number(pick("no")),
    name: unquote(pick("name")) ?? "",
    kind,
    repeated: pick("repeated") === "!0",
    opt: pick("opt") === "!0",
    oneof: unquote(pick("oneof")),
    ref
  };
}

function wellKnownOrLocal(rawT: string, localToTypeName: Map<string, string>): string {
  if (rawT === "a.Struct") return "google.protobuf.Struct";
  if (rawT === "a.Value") return "google.protobuf.Value";
  return localToTypeName.get(rawT) ?? `?${rawT}`;
}

function balanced(source: string, at: number, open: string, close: string): string {
  let depth = 0;
  let quote = "";
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"') quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error("descriptor 括号不配平");
}

function splitObjects(inner: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "{") continue;
    const chunk = balanced(inner, i, "{", "}");
    parts.push(chunk.slice(1, -1));
    i += chunk.length - 1;
  }
  return parts;
}

interface GeneratedType {
  typeName: string;
  fields: { list(): ReadonlyArray<Record<string, unknown>> };
}

function generatedTypes(): Map<string, GeneratedType> {
  const found = new Map<string, GeneratedType>();
  for (const value of Object.values(pb)) {
    if (typeof value !== "function") continue;
    const candidate = value as unknown as Partial<GeneratedType>;
    if (typeof candidate.typeName === "string" && candidate.fields) found.set(candidate.typeName, candidate as GeneratedType);
  }
  return found;
}

function generatedRef(field: Record<string, unknown>): string {
  const kind = field.kind as string;
  if (kind === "scalar") return `scalar:${field.T as number}`;
  if (kind === "enum") return `enum:${(field.T as { typeName: string }).typeName}`;
  if (kind === "message") return `message:${(field.T as { typeName: string }).typeName}`;
  const value = field.V as { kind: string; T: unknown };
  const inner = value.kind === "scalar" ? `{kind:scalar,T:${value.T as number}}` : `{kind:message}`;
  return `map:${field.K as number}:${inner}`;
}

test("inference_pb.ts covers every descriptor message with matching field numbers", () => {
  const descriptor = parseDescriptor();
  const generated = generatedTypes();
  assert.equal(descriptor.size, 54);
  assert.equal(generated.size, descriptor.size);

  for (const [typeName, fields] of descriptor) {
    const type = generated.get(typeName);
    assert.ok(type, `生成物缺少 ${typeName}`);
    const actual = type.fields.list();
    assert.equal(actual.length, fields.length, `${typeName} 字段数不一致`);
    for (const [index, expected] of fields.entries()) {
      const got = actual[index];
      const where = `${typeName}.${expected.name}`;
      assert.equal(got.no, expected.no, `${where} 字段号`);
      assert.equal(got.name, expected.name, `${where} 字段名`);
      assert.equal(got.kind, expected.kind, `${where} kind`);
      assert.equal(Boolean(got.repeated), expected.repeated, `${where} repeated`);
      assert.equal(Boolean(got.opt), expected.opt, `${where} opt`);
      assert.equal((got.oneof as { name?: string } | undefined)?.name, expected.oneof, `${where} oneof`);
      assert.equal(generatedRef(got), expected.ref, `${where} 类型引用`);
    }
  }
});

test("enum values match the descriptor numbering", () => {
  assert.deepEqual(
    [
      pb.InferenceMessageRole.UNSPECIFIED,
      pb.InferenceMessageRole.USER,
      pb.InferenceMessageRole.ASSISTANT,
      pb.InferenceMessageRole.TOOL,
      pb.InferenceMessageRole.SYSTEM
    ],
    [0, 1, 2, 3, 4]
  );
  assert.equal(pb.InferenceStreamErrorType.CONTENT_FILTER, 8);
  assert.equal(pb.InferenceReason.GEMINI_VIDEO_SUBAGENT, 1);
  assert.equal(pb.RunInferenceRoutingRole.ASSISTANT, 2);
});

test("InferenceStreamResponse exposes all ten oneof cases", () => {
  const cases = pb.InferenceStreamResponse.fields.list().map((field) => field.name);
  assert.deepEqual(cases, [
    "text_part",
    "tool_call_part",
    "usage",
    "response_info",
    "extended_usage",
    "provider_metadata",
    "invocation_id",
    "error",
    "thinking_part",
    "image_descriptions"
  ]);
});

/* -------------------------------------------------------------------- envelope */

function frameFor(text: string, options: { endStream?: boolean } = {}): Uint8Array {
  return encodeEnvelope(new TextEncoder().encode(text), options);
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, Math.min(i + size, bytes.length));
}

async function collect(bytes: Uint8Array, size: number, compression?: "gzip" | "br"): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of readEnvelopes(chunked(bytes, size), { compression })) {
    out.push(`${frame.endStream ? "end:" : ""}${Buffer.from(frame.data).toString("utf8")}`);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("envelope header is 1 byte flags plus 4 byte big-endian length", () => {
  const frame = frameFor("hello");
  assert.equal(frame[0], 0);
  assert.deepEqual([...frame.subarray(1, 5)], [0, 0, 0, 5]);
  assert.equal(Buffer.from(frame.subarray(5)).toString("utf8"), "hello");
  assert.equal(frameFor("x", { endStream: true })[0], 2);
});

test("the same byte stream parses identically at every chunk boundary", async () => {
  const stream = concat(frameFor("alpha"), frameFor("beta"), frameFor('{"metadata":{}}', { endStream: true }));
  const expected = ["alpha", "beta", 'end:{"metadata":{}}'];
  // 1 字节一切（每个 header 都是半包）/ 3 字节（切在长度域中间）/ 整帧 / 一个 chunk 塞下全部。
  for (const size of [1, 2, 3, 5, 7, 10, stream.length]) {
    assert.deepEqual(await collect(stream, size), expected, `chunk=${size}`);
  }
});

test("gzip and brotli frames decompress with the compressed flag cleared", async () => {
  for (const [compression, compress] of [
    ["gzip", gzipSync],
    ["br", brotliCompressSync]
  ] as const) {
    const payload = compress(Buffer.from("compressed body"));
    const frame = encodeEnvelope(new Uint8Array(payload), { compressed: true });
    assert.equal(frame[0], 1);
    assert.deepEqual(await collect(concat(frame, frameFor("{}", { endStream: true })), 4, compression), [
      "compressed body",
      "end:{}"
    ]);
  }
});

test("a frame flagged compressed on an identity stream is rejected", async () => {
  const frame = encodeEnvelope(new Uint8Array([1, 2, 3]), { compressed: true });
  await assert.rejects(() => collect(frame, 16), /flagged compressed/);
});

test("an oversized length header throws before allocating", async () => {
  const frame = new Uint8Array(5);
  new DataView(frame.buffer).setUint32(1, 0xffffffff, false);
  await assert.rejects(
    () => collect(frame, 5),
    (error: unknown) =>
      error instanceof EnvelopeTooLargeError &&
      error.declaredBytes === 0xffffffff &&
      error.maxBytes === DEFAULT_READ_MAX_BYTES
  );
});

test("a decompression bomb is capped and reported as an envelope size error", async () => {
  // 4 字节长度域只约束压缩后的大小：几 KB 的 gzip 可以解出几 MB。
  const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024));
  const frame = encodeEnvelope(new Uint8Array(bomb), { compressed: true });
  await assert.rejects(async () => {
    for await (const _ of readEnvelopes(chunked(frame, 512), { compression: "gzip", readMaxBytes: 4096 })) {
      // 只关心错误是否抛出。
    }
  }, EnvelopeTooLargeError);
});

test("a stream that stops mid-envelope is reported as truncated", async () => {
  const partial = frameFor("abcdef").subarray(0, 7);
  await assert.rejects(() => collect(partial, 3), TruncatedEnvelopeError);
});

test("trailing bytes after end-of-stream do not raise truncation", async () => {
  const stream = concat(frameFor("{}", { endStream: true }), new Uint8Array([9, 9, 9]));
  assert.deepEqual(await collect(stream, 1), ["end:{}"]);
});

test("request payloads compress only above the threshold", async () => {
  const small = new Uint8Array(64).fill(65);
  const plain = await encodeRequestEnvelope(small, { compression: "gzip" });
  assert.equal(plain.compressed, false);
  assert.equal(plain.frame[0], 0);

  const large = new Uint8Array(4096).fill(65);
  const compressed = await encodeRequestEnvelope(large, { compression: "gzip" });
  assert.equal(compressed.compressed, true);
  assert.equal(compressed.frame[0], 1);
  assert.ok(compressed.frame.length < large.length);
});

test("parseCompression normalizes the response encoding header", () => {
  assert.equal(parseCompression(undefined), "identity");
  assert.equal(parseCompression(" GZIP "), "gzip");
  assert.equal(parseCompression("br"), "br");
  assert.throws(() => parseCompression("zstd"), /Unsupported Connect content encoding/);
});

/* -------------------------------------------------------------------- checksum */

test("checksum is base64url without padding and matches the client algorithm", () => {
  // 手算核对过的定值：now=1788000000000 → 字节 [72,96,0,27,72,96] → 混淆 → base64url "7Y6Qjsqv"。
  assert.equal(cursorChecksum("machine-abc", undefined, 1788000000000), "7Y6Qjsqvmachine-abc");
  assert.equal(cursorChecksum("machine-abc", "mac-xyz", 1788000000000), "7Y6Qjsqvmachine-abc/mac-xyz");
});

test("checksum never emits standard-base64 characters", () => {
  for (let i = 0; i < 200; i += 1) {
    const prefix = cursorChecksum("", undefined, 1_700_000_000_000 + i * 1e6).slice(0, 8);
    assert.equal(prefix.length, 8);
    assert.ok(!/[+/=]/.test(prefix), `base64url 里不该出现 + / =：${prefix}`);
  }
});

test("checksum omits the slash when there is no mac machine id", () => {
  assert.ok(!cursorChecksum("only-machine", undefined, 1788000000000).includes("/"));
  assert.ok(!cursorChecksum("only-machine", "", 1788000000000).includes("/"));
});

/* --------------------------------------------------------------------- headers */

const CREDENTIAL: CursorConnectCredential = {
  id: "cred-1",
  sessionToken: "session-token-value",
  machineId: "machine-abc",
  macMachineId: "mac-xyz",
  clientVersion: "3.18.9",
  clientOs: "linux",
  clientArch: "x64",
  deviceType: "desktop",
  timezone: "UTC",
  clientKey: "client-key-value",
  sessionId: "session-id-value",
  teamId: "42",
  ghostMode: true
};

test("headers carry the client-version name, not x-cursor-version", () => {
  const headers = buildConnectHeaders({ credential: CREDENTIAL, nowMs: 1788000000000, requestId: "req-1" });
  assert.equal(headers["x-cursor-client-version"], "3.18.9");
  assert.equal(headers["x-cursor-version"], undefined);
  assert.equal(headers["x-cursor-client-type"], "sand");
  assert.equal(headers["content-type"], "application/connect+proto");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(headers["x-cursor-checksum"], "7Y6Qjsqvmachine-abc/mac-xyz");
  assert.equal(headers["x-cursor-streaming"], "true");
  assert.equal(headers["x-request-id"], "req-1");
  assert.equal(headers["x-amzn-trace-id"], "Root=req-1");
  assert.equal(headers["x-ghost-mode"], "true");
  assert.equal(headers["x-cursor-team-id"], "42");
});

test("headers omit sandbox and internal-only names", () => {
  const headers = buildConnectHeaders({ credential: CREDENTIAL });
  for (const name of [
    "x-sand-box-namespace",
    "x-cursor-client-commit",
    "x-inference-authentication-jwt",
    "x-cursor-workload-id"
  ]) {
    assert.equal(headers[name], undefined, `不应发送 ${name}`);
  }
});

test("optional device fields are dropped rather than sent empty", () => {
  const headers = buildConnectHeaders({
    credential: { id: "c", sessionToken: "t", machineId: "m", clientVersion: "1" }
  });
  assert.equal(headers["x-cursor-client-os"], undefined);
  assert.equal(headers["x-cursor-team-id"], undefined);
  assert.equal(headers["x-ghost-mode"], undefined);
  assert.ok(!headers["x-cursor-checksum"].includes("/"));
});

test("json codec switches only the content type", () => {
  const headers = buildConnectHeaders({ credential: CREDENTIAL, codec: "json" });
  assert.equal(headers["content-type"], "application/connect+json");
});

test("redactHeaders hides the token, checksum and device keys", () => {
  const redacted = redactHeaders(buildConnectHeaders({ credential: CREDENTIAL }));
  assert.equal(redacted.authorization, "***");
  assert.equal(redacted["x-cursor-checksum"], "***");
  assert.equal(redacted["x-client-key"], "***");
  assert.equal(redacted["x-session-id"], "***");
  assert.equal(redacted["x-cursor-team-id"], "***");
  assert.equal(redacted["x-cursor-client-version"], "3.18.9");
  assert.ok(!JSON.stringify(redacted).includes("session-token-value"));
});

/* ----------------------------------------------------------------- credentials */

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("browser web tokens are rejected, session tokens are accepted", () => {
  assert.equal(cursorTokenType(jwt({ type: "web" })), "web");
  assert.equal(cursorTokenType(jwt({ type: "session" })), "session");
  assert.equal(cursorTokenType("opaque-token"), "unknown");

  const base = { id: "c", machineId: "m", clientVersion: "1" };
  assert.throws(
    () => assertUsableCredential({ ...base, sessionToken: jwt({ type: "web" }) }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 401
  );
  assertUsableCredential({ ...base, sessionToken: jwt({ type: "session" }) });
  assertUsableCredential({ ...base, sessionToken: "opaque-token" });
});

test("credential validation names the missing fields without echoing the token", () => {
  assert.throws(
    () => assertUsableCredential({ id: "c", sessionToken: "", machineId: "", clientVersion: "1" }),
    (error: unknown) =>
      error instanceof ApiError && error.statusCode === 500 && /sessionToken, machineId/.test(error.message)
  );
});

/* ---------------------------------------------------------------------- errors */

test("connect codes map to http statuses", () => {
  assert.equal(connectCodeToStatus("unauthenticated"), 401);
  assert.equal(connectCodeToStatus("resource_exhausted"), 429);
  assert.equal(connectCodeToStatus("permission_denied"), 403);
  assert.equal(connectCodeToStatus("unavailable"), 503);
  assert.equal(connectCodeToStatus("not_a_code"), 500);
});

test("endStream payloads parse into metadata or error", () => {
  assert.deepEqual(parseEndStream(new TextEncoder().encode("{}")), {});
  assert.deepEqual(parseEndStream(new Uint8Array(0)), {});
  const parsed = parseEndStream(new TextEncoder().encode('{"error":{"code":"unauthenticated","message":"nope"}}'));
  const error = endStreamError(parsed.error!);
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, "unauthorized");
  // 消息里始终带 Connect code：上游经常只回一个 "Error"，光看它运维不知道该换 token。
  assert.equal(error.message, "nope (connect: unauthenticated)");
  assert.match(endStreamError({ code: "unauthenticated", message: "Error" }).message, /unauthenticated/);
});

test("a non-empty endStream frame that will not parse is treated as a failure", () => {
  // 那段 payload 里本来可能装着 error；解析不出来就当没事，会把失败的请求变成截断的成功响应。
  const parsed = parseEndStream(new TextEncoder().encode("<html>gateway timeout</html>"));
  assert.equal(parsed.error?.code, "internal");
  assert.equal(endStreamError(parsed.error!).statusCode, 500);
});

test("every InferenceStreamErrorType maps to a distinct outward error", () => {
  const cases: Array<[pb.InferenceStreamErrorType, number, string]> = [
    [pb.InferenceStreamErrorType.INPUT_TOKEN_LIMIT, 400, "context_length_exceeded"],
    [pb.InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT, 400, "context_length_exceeded"],
    [pb.InferenceStreamErrorType.RATE_LIMIT, 429, "rate_limit_exceeded"],
    [pb.InferenceStreamErrorType.AUTHENTICATION, 401, "unauthorized"],
    [pb.InferenceStreamErrorType.PERMISSION, 403, "forbidden"],
    [pb.InferenceStreamErrorType.OVERLOADED, 529, "overloaded"],
    [pb.InferenceStreamErrorType.CONTENT_FILTER, 400, "content_policy_violation"],
    [pb.InferenceStreamErrorType.UNKNOWN, 500, "upstream_error"],
    [pb.InferenceStreamErrorType.UNSPECIFIED, 500, "upstream_error"]
  ];
  for (const [errorType, status, code] of cases) {
    const error = inferenceStreamError(new pb.InferenceStreamError({ message: "boom", errorType }));
    assert.equal(error.statusCode, status, `errorType=${errorType}`);
    assert.equal(error.code, code, `errorType=${errorType}`);
  }
});

test("token-limit booleans win even when error_type is unset", () => {
  const error = inferenceStreamError(
    new pb.InferenceStreamError({ message: "too long", isInputTokenLimitError: true })
  );
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "context_length_exceeded");
});

test("http transport errors keep the status and truncate the body", () => {
  const error = httpTransportError(401, "unauthorized\n");
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, "unauthorized");
  assert.match(error.message, /HTTP 401/);
  assert.ok(httpTransportError(500, "x".repeat(5000)).message.length < 600);
});

test("http transport errors pass the upstream status through unchanged", () => {
  // 绕道 Connect code 再换算回来是有损的：429→unavailable→503 会把「配额用完」说成「服务不可用」。
  for (const [status, code] of [
    [400, "invalid_request_error"],
    [402, "invalid_request_error"],
    [404, "not_found"],
    [413, "request_too_large"],
    [429, "rate_limit_exceeded"],
    [500, "upstream_error"],
    [503, "upstream_error"]
  ] as const) {
    const error = httpTransportError(status, "");
    assert.equal(error.statusCode, status, `HTTP ${status} 不应被改写`);
    assert.equal(error.code, code, `HTTP ${status} 的 code`);
  }
  // 非 4xx/5xx（例如 redirect: manual 下的 0 / 3xx）没有可透传的语义，归到 502。
  assert.equal(httpTransportError(302, "").statusCode, 502);
});
