/**
 * 从 `docs/reference/inference-descriptor-8844.txt` 生成 `src/cursor-connect/proto/inference_pb.ts`。
 *
 * 该 txt 是 Cursor 3.18.9 `extensions/cursor-agent-host/dist/657.js` 里 protobuf descriptor
 * 模块 8844 的原文，是本仓库唯一的协议字段来源：字段号、kind、oneof、枚举值一律从它读，不猜、不外查。
 * Cursor 升版后重新导出该 txt 再跑本脚本即可，禁止手改生成物。
 *
 *   node scripts/gen-inference-pb.mjs [--check]
 *
 * `--check` 只比对不写盘，退出码非 0 表示生成物与 descriptor 已经不一致。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 需要生成的 descriptor → 生成物。新增一份参考文件时在这里加一行。 */
const TARGETS = [
  { descriptor: "docs/reference/inference-descriptor-8844.txt", output: "src/cursor-connect/proto/inference_pb.ts" },
  { descriptor: "docs/reference/available-models-descriptor.txt", output: "src/cursor-connect/proto/available_models_pb.ts" }
];

/** descriptor 的 `kind:"scalar"` T 值 → protobuf-es ScalarType 与 TS 类型/零值。 */
const SCALAR = {
  1: { name: "DOUBLE", ts: "number", zero: "0" },
  2: { name: "FLOAT", ts: "number", zero: "0" },
  3: { name: "INT64", ts: "bigint", zero: "protoInt64.zero" },
  5: { name: "INT32", ts: "number", zero: "0" },
  8: { name: "BOOL", ts: "boolean", zero: "false" },
  9: { name: "STRING", ts: "string", zero: '""' },
  12: { name: "BYTES", ts: "Uint8Array", zero: "new Uint8Array(0)" },
  13: { name: "UINT32", ts: "number", zero: "0" }
};

main();

function main() {
  const check = process.argv.includes("--check");
  for (const target of TARGETS) {
    const descriptor = resolve(ROOT, target.descriptor);
    const output = resolve(ROOT, target.output);
    const source = readFileSync(descriptor, "utf8");
    const enums = parseEnums(source);
    const messages = parseMessages(source, enums);
    const emitted = emit(enums, messages, target.descriptor);

    if (check) {
      if (normalizeEol(readFileSync(output, "utf8")) !== normalizeEol(emitted)) {
        console.error(`${target.output} 与 descriptor 不一致，请重跑 node scripts/gen-inference-pb.mjs`);
        process.exit(1);
      }
      console.log(`ok ${target.output}: ${messages.length} messages / ${enums.length} enums`);
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, emitted, "utf8");
    console.log(`wrote ${target.output}: ${messages.length} messages / ${enums.length} enums`);
  }
}

function normalizeEol(text) {
  return text.replaceAll("\r\n", "\n");
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 枚举成员名直接取 descriptor 自己的 IIFE 体（`e[e.USER=1]="USER"`），
 * 不从 wire 名 `INFERENCE_MESSAGE_ROLE_USER` 反推前缀——反推会在缩写/数字上出错。
 */
function parseEnums(source) {
  const members = new Map();
  const iife = /function\(e\)\{((?:e\[e\.\w+=\d+\]="\w+",?)+)\}\(([\w$]+)\|\|\(\2=\{\}\)\)/g;
  for (const match of source.matchAll(iife)) {
    const list = [...match[1].matchAll(/e\[e\.(\w+)=(\d+)\]/g)].map((m) => ({ name: m[1], no: Number(m[2]) }));
    members.set(match[2], list);
  }

  const enums = [];
  const setEnumType = /a\.proto3\.util\.setEnumType\(([\w$]+),"([^"]+)",(\[[^\]]*\])\)/g;
  for (const match of source.matchAll(setEnumType)) {
    const [, local, typeName, wireRaw] = match;
    const names = members.get(local);
    if (!names) throw new Error(`enum ${typeName}: 找不到本地成员表 ${local}`);
    const wire = parseObjectArray(wireRaw.slice(1, -1)).map((entry) => ({
      no: Number(entry.no),
      name: unquote(entry.name)
    }));
    if (wire.length !== names.length) throw new Error(`enum ${typeName}: 成员数不一致`);
    enums.push({
      local,
      typeName,
      tsName: tsNameOf(typeName),
      values: names.map((member, index) => {
        if (wire[index].no !== member.no) throw new Error(`enum ${typeName}: 第 ${index} 项字段号不一致`);
        return { name: member.name, no: member.no, wireName: wire[index].name };
      })
    });
  }
  return enums;
}

function parseMessages(source, enums) {
  const enumByLocal = new Map(enums.map((item) => [item.local, item]));

  // 先扫一遍拿到 局部变量 → typeName 的全表，字段里的前向引用才解析得出来。
  // 局部变量名是压缩产物，可能是 `$`、`ee` 这种，标识符类必须带 `$`。
  const header = /([\w$]+)\.runtime=a\.proto3,\1\.typeName="([^"]+)",\1\.fields=a\.proto3\.util\.newFieldList\(\(\)=>/g;
  const messageByLocal = new Map();
  const found = [];
  for (const match of source.matchAll(header)) {
    const entry = { local: match[1], typeName: match[2], tsName: tsNameOf(match[2]), at: match.index + match[0].length };
    messageByLocal.set(entry.local, entry);
    found.push(entry);
  }

  for (const entry of found) {
    const array = readBalanced(source, entry.at, "[", "]");
    entry.fields = parseObjectArray(array.slice(1, -1)).map((raw) =>
      normalizeField(raw, entry.typeName, messageByLocal, enumByLocal)
    );
    entry.ctorDefaults = parseCtorDefaults(source, entry.local, entry.typeName);
  }

  for (const entry of found) verifyDefaults(entry);
  return found;
}

function normalizeField(raw, owner, messageByLocal, enumByLocal) {
  const field = {
    no: Number(raw.no),
    name: unquote(raw.name),
    kind: unquote(raw.kind),
    opt: raw.opt === "!0",
    repeated: raw.repeated === "!0",
    oneof: raw.oneof === undefined ? undefined : unquote(raw.oneof)
  };
  field.localName = camelCase(field.name);

  if (field.kind === "scalar") {
    field.scalar = requireScalar(raw.T, owner, field.name);
  } else if (field.kind === "enum") {
    field.enumRef = resolveEnum(raw.T, enumByLocal, owner, field.name);
  } else if (field.kind === "message") {
    field.messageRef = resolveMessage(raw.T, messageByLocal, owner, field.name);
  } else if (field.kind === "map") {
    field.mapKey = requireScalar(raw.K, owner, field.name);
    const value = parseObject(raw.V.slice(1, -1));
    const valueKind = unquote(value.kind);
    field.mapValue =
      valueKind === "scalar"
        ? { kind: "scalar", scalar: requireScalar(value.T, owner, field.name) }
        : { kind: "message", messageRef: resolveMessage(value.T, messageByLocal, owner, field.name) };
  } else {
    throw new Error(`${owner}.${field.name}: 未知 kind ${field.kind}`);
  }
  return field;
}

function requireScalar(rawT, owner, name) {
  const scalar = SCALAR[Number(rawT)];
  if (!scalar) throw new Error(`${owner}.${name}: 未知 scalar T=${rawT}`);
  return { ...scalar, T: Number(rawT) };
}

function resolveEnum(rawT, enumByLocal, owner, name) {
  const match = /^a\.proto3\.getEnumType\(([\w$]+)\)$/.exec(rawT);
  if (!match) throw new Error(`${owner}.${name}: 无法解析 enum 引用 ${rawT}`);
  const target = enumByLocal.get(match[1]);
  if (!target) throw new Error(`${owner}.${name}: 未知 enum 局部变量 ${match[1]}`);
  return target;
}

function resolveMessage(rawT, messageByLocal, owner, name) {
  if (rawT === "a.Struct") return { tsName: "Struct", wellKnown: true };
  if (rawT === "a.Value") return { tsName: "Value", wellKnown: true };
  const target = messageByLocal.get(rawT);
  if (!target) throw new Error(`${owner}.${name}: 未知 message 局部变量 ${rawT}`);
  return target;
}

/** 取 descriptor 构造函数里显式赋了初值的字段名，用来反证下面 defaultOf 的推导规则。 */
function parseCtorDefaults(source, local, typeName) {
  const marker = `class ${local} extends a.Message{constructor(e){super(),`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`${typeName}: 找不到构造函数`);
  const body = source.slice(at + marker.length, source.indexOf("a.proto3.util.initPartial(e,this)", at));
  return new Set([...body.matchAll(/this\.(\w+)=/g)].map((m) => m[1]));
}

/**
 * descriptor 的构造函数是「哪些字段有零值」的权威事实。
 * 推导规则若与它不符就直接报错，避免生成物默默偏离 wire 行为。
 */
function verifyDefaults(entry) {
  const derived = new Set();
  for (const field of entry.fields) {
    if (field.oneof) {
      derived.add(field.oneof);
      continue;
    }
    if (defaultOf(field) !== undefined) derived.add(field.localName);
  }
  const missing = [...entry.ctorDefaults].filter((name) => !derived.has(name));
  const extra = [...derived].filter((name) => !entry.ctorDefaults.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `${entry.typeName}: 零值推导与 descriptor 构造函数不一致（缺 ${missing.join(",") || "-"}；多 ${extra.join(",") || "-"}）`
    );
  }
}

/** 返回该字段的 TS 初值；undefined 表示这是可选字段（`?:`，不带初值）。 */
function defaultOf(field) {
  if (field.repeated) return "[]";
  if (field.kind === "map") return "{}";
  if (field.opt) return undefined;
  if (field.kind === "message") return undefined;
  if (field.kind === "scalar") return field.scalar.zero;
  const zero = field.enumRef.values.find((value) => value.no === 0);
  if (!zero) throw new Error(`${field.name}: enum ${field.enumRef.typeName} 没有 0 值`);
  return `${field.enumRef.tsName}.${zero.name}`;
}

/* ------------------------------------------------------------ 微型字面量解析 */

/** 从 `at` 处的 `open` 开始返回配平后的整段（含两端括号）。字符串里的括号不计数。 */
function readBalanced(source, at, open, close) {
  if (source[at] !== open) throw new Error(`位置 ${at} 不是 ${open}`);
  let depth = 0;
  let quote = "";
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`从 ${at} 起括号不配平`);
}

/** `{...},{...}` → 每个 `{...}` 的键值表。 */
function parseObjectArray(inner) {
  const objects = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "{") continue;
    const chunk = readBalanced(inner, i, "{", "}");
    objects.push(parseObject(chunk.slice(1, -1)));
    i += chunk.length - 1;
  }
  return objects;
}

/**
 * `no:1,name:"x",kind:"message",T,repeated:!0` → `{no:"1",name:'"x"',...,T:"T"}`。
 * 值一律保留原文（含引号），由调用方决定怎么解释；`T` 这种 ES 简写属性回填成同名值。
 */
function parseObject(inner) {
  const result = {};
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === "," || inner[i] === " ")) i += 1;
    if (i >= inner.length) break;
    const keyStart = i;
    while (i < inner.length && /[\w$]/.test(inner[i])) i += 1;
    const key = inner.slice(keyStart, i);
    if (!key) throw new Error(`无法解析对象字面量：${inner.slice(keyStart, keyStart + 40)}`);
    if (inner[i] !== ":") {
      result[key] = key;
      continue;
    }
    i += 1;
    const valueStart = i;
    let depth = 0;
    let quote = "";
    while (i < inner.length) {
      const ch = inner[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) break;
      i += 1;
    }
    result[key] = inner.slice(valueStart, i).trim();
  }
  return result;
}

function unquote(raw) {
  if (raw === undefined) return undefined;
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

/**
 * `aiserver.v1.AvailableModelsResponse.AvailableModel` → `AvailableModelsResponse_AvailableModel`。
 * 嵌套消息只取最后一段会撞名（多个父消息各有一个 `EnumParameterValue`）。
 */
function tsNameOf(typeName) {
  const withoutPackage = typeName.replace(/^[a-z_0-9]+(?:\.[a-z_0-9]+)*\./, "");
  return withoutPackage.replaceAll(".", "_");
}

function camelCase(name) {
  return name
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

/* ------------------------------------------------------------------ 生成 */

function emit(enums, messages, descriptorPath) {
  const lines = [];
  const usesInt64 = messages.some((m) => m.fields.some((f) => !f.oneof && !f.opt && !f.repeated && f.scalar?.T === 3));
  const wellKnown = new Set();
  for (const message of messages) {
    for (const field of message.fields) {
      if (field.messageRef?.wellKnown) wellKnown.add(field.messageRef.tsName);
      if (field.mapValue?.messageRef?.wellKnown) wellKnown.add(field.mapValue.messageRef.tsName);
    }
  }

  const runtime = ["Message", "proto3", ...(usesInt64 ? ["protoInt64"] : []), ...[...wellKnown].sort()];
  lines.push(
    `// @generated by scripts/gen-inference-pb.mjs from ${descriptorPath}`,
    "// 该文件是 Cursor 3.18.9 protobuf descriptor 的机械转写，请勿手改。",
    "// 重新生成：node scripts/gen-inference-pb.mjs   校验：node scripts/gen-inference-pb.mjs --check",
    "/* eslint-disable */",
    "",
    'import type { BinaryReadOptions, FieldList, JsonReadOptions, JsonValue, PartialMessage, PlainMessage } from "@bufbuild/protobuf";',
    `import { ${runtime.join(", ")} } from "@bufbuild/protobuf";`,
    ""
  );

  for (const item of enums) lines.push(...emitEnum(item), "");
  for (const item of messages) lines.push(...emitMessage(item), "");

  return `${lines.join("\n").trimEnd()}\n`;
}

function emitEnum(item) {
  const lines = [`/** @generated from enum ${item.typeName} */`, `export enum ${item.tsName} {`];
  for (const value of item.values) {
    lines.push(`  /** @generated from enum value: ${value.wireName} = ${value.no}; */`);
    lines.push(`  ${value.name} = ${value.no},`);
  }
  lines.push("}");
  lines.push(`proto3.util.setEnumType(${item.tsName}, "${item.typeName}", [`);
  for (const value of item.values) lines.push(`  { no: ${value.no}, name: "${value.wireName}" },`);
  lines.push("]);");
  return lines;
}

function emitMessage(item) {
  const name = item.tsName;
  const lines = [
    `/** @generated from message ${item.typeName} */`,
    `export class ${name} extends Message<${name}> {`
  ];

  const emittedOneofs = new Set();
  for (const field of item.fields) {
    if (field.oneof) {
      if (emittedOneofs.has(field.oneof)) continue;
      emittedOneofs.add(field.oneof);
      lines.push(...emitOneof(item, field.oneof).map(indent));
      continue;
    }
    lines.push(...emitField(field).map(indent));
  }

  if (lines.at(-1) !== "") lines.push("");
  lines.push(
    `  constructor(data?: PartialMessage<${name}>) {`,
    "    super();",
    "    proto3.util.initPartial(data, this);",
    "  }",
    "",
    "  static readonly runtime: typeof proto3 = proto3;",
    `  static readonly typeName = "${item.typeName}";`,
    "  static readonly fields: FieldList = proto3.util.newFieldList(() => ["
  );
  for (const field of item.fields) lines.push(`    ${fieldDescriptor(field)},`);
  lines.push(
    "  ]);",
    "",
    `  static fromBinary(bytes: Uint8Array, options?: Partial<BinaryReadOptions>): ${name} {`,
    `    return new ${name}().fromBinary(bytes, options);`,
    "  }",
    "",
    `  static fromJson(jsonValue: JsonValue, options?: Partial<JsonReadOptions>): ${name} {`,
    `    return new ${name}().fromJson(jsonValue, options);`,
    "  }",
    "",
    `  static fromJsonString(jsonString: string, options?: Partial<JsonReadOptions>): ${name} {`,
    `    return new ${name}().fromJsonString(jsonString, options);`,
    "  }",
    "",
    `  static equals(a: ${name} | PlainMessage<${name}> | undefined, b: ${name} | PlainMessage<${name}> | undefined): boolean {`,
    `    return proto3.util.equals(${name}, a, b);`,
    "  }",
    "}"
  );
  return lines;
}

function indent(line) {
  return line ? `  ${line}` : line;
}

function emitField(field) {
  const doc = `/** @generated from field: ${wireSignature(field)} = ${field.no}; */`;
  const type = tsTypeOf(field);
  const zero = defaultOf(field);
  return [doc, zero === undefined ? `${field.localName}?: ${type};` : `${field.localName}: ${type} = ${zero};`, ""];
}

function emitOneof(item, oneof) {
  const members = item.fields.filter((field) => field.oneof === oneof);
  const lines = [`/** @generated from oneof ${item.typeName}.${oneof} */`, `${camelCase(oneof)}: {`];
  for (const [index, field] of members.entries()) {
    lines.push(`  /** @generated from field: ${wireSignature(field)} = ${field.no}; */`);
    lines.push("  value: " + tsTypeOf(field) + ";");
    lines.push(`  case: "${field.localName}";`);
    lines.push(index === members.length - 1 ? "} | { case: undefined; value?: undefined } = { case: undefined };" : "} | {");
  }
  return [...lines, ""];
}

function tsTypeOf(field) {
  if (field.kind === "map") {
    const key = field.mapKey.ts === "bigint" ? "string" : field.mapKey.ts;
    const value = field.mapValue.kind === "scalar" ? field.mapValue.scalar.ts : field.mapValue.messageRef.tsName;
    return `{ [key: ${key}]: ${value} }`;
  }
  const base =
    field.kind === "scalar" ? field.scalar.ts : field.kind === "enum" ? field.enumRef.tsName : field.messageRef.tsName;
  return field.repeated ? `${base}[]` : base;
}

/** 生成注释里的 proto 签名，便于与 descriptor / .proto 对读。 */
function wireSignature(field) {
  const prefix = field.repeated ? "repeated " : field.opt ? "optional " : "";
  if (field.kind === "map") {
    const value = field.mapValue.kind === "scalar" ? field.mapValue.scalar.name.toLowerCase() : field.mapValue.messageRef.tsName;
    return `map<${field.mapKey.name.toLowerCase()}, ${value}> ${field.name}`;
  }
  const type =
    field.kind === "scalar"
      ? field.scalar.name.toLowerCase()
      : field.kind === "enum"
        ? field.enumRef.typeName
        : field.messageRef.wellKnown
          ? `google.protobuf.${field.messageRef.tsName}`
          : field.messageRef.typeName;
  return `${prefix}${type} ${field.name}`;
}

function fieldDescriptor(field) {
  const parts = [`no: ${field.no}`, `name: "${field.name}"`, `kind: "${field.kind}"`];
  if (field.kind === "scalar") parts.push(`T: ${field.scalar.T} /* ScalarType.${field.scalar.name} */`);
  else if (field.kind === "enum") parts.push(`T: proto3.getEnumType(${field.enumRef.tsName})`);
  else if (field.kind === "message") parts.push(`T: ${field.messageRef.tsName}`);
  else {
    parts.push(`K: ${field.mapKey.T} /* ScalarType.${field.mapKey.name} */`);
    parts.push(
      field.mapValue.kind === "scalar"
        ? `V: { kind: "scalar", T: ${field.mapValue.scalar.T} /* ScalarType.${field.mapValue.scalar.name} */ }`
        : `V: { kind: "message", T: ${field.mapValue.messageRef.tsName} }`
    );
  }
  if (field.oneof) parts.push(`oneof: "${field.oneof}"`);
  if (field.repeated) parts.push("repeated: true");
  if (field.opt) parts.push("opt: true");
  return `{ ${parts.join(", ")} }`;
}
