/**
 * 从 Grok Bot 的 proto bundle 机械导出 GrokBotService/EnsureSandBox 的 descriptor dump。
 *
 * 用法：
 *   node scripts/extract-grokbot-descriptor.mjs [--proto-cjs <已解包的 proto.cjs 路径>]
 *
 * 取证方式（零人工录入，全部来自 protobuf-es 运行时本体）：
 *   1. 定位 Grok Bot 安装目录 resources/app.asar，用 asar extract-file 抽出
 *      dist/electron-main/proto.cjs（--proto-cjs 可直接给已解包文件）；
 *   2. require 之，从 GrokBotService.methods.ensureSandBox 取 I/O 类型；
 *   3. 字段号/kind/类型/opt/repeated/localName 读静态字段表；枚举的 wire 名与
 *      TS 成员名读字段 T 上的注册信息（typeName + values[{no, name, localName}]）；
 *   4. 构造零值读 `new Type()` 的自有字段（等价于 descriptor 构造函数赋值）。
 *
 * 输出：docs/reference/grokbot-service-descriptor.txt —— 是
 * src/cursor-bot/proto/grokbot_service_pb.ts 的唯一字段来源（经
 * gen-inference-pb.mjs 的 grokbot-dump 解析器转写），勿手改。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs/reference/grokbot-service-descriptor.txt");

function main() {
  const protoCjs = locateProtoCjs();
  console.log(`proto bundle: ${protoCjs}`);
  const requireCjs = createRequire(import.meta.url);
  const proto = requireCjs(protoCjs);

  const method = proto.GrokBotService?.methods?.ensureSandBox;
  if (!method || method.I?.typeName !== "aiserver.v1.EnsureSandBoxRequest") {
    fail("proto bundle 里找不到 GrokBotService.ensureSandBox（Grok Bot 版本不对？）");
  }

  const enums = [];
  const messages = [];
  for (const type of [method.I, method.O]) {
    const fields = typeFields(type).map((field) => runtimeField(field));
    // 交叉验证：camelCase 推导的 localName 必须与构造零值（运行时权威）对得上。
    const defaults = new Set(Object.keys(new type()));
    for (const field of fields) {
      if (defaults.has(field.localName)) defaults.delete(field.localName);
    }
    if (defaults.size) {
      fail(`${type.typeName}: 构造零值里有推导不出的字段：${[...defaults].join(",")}`);
    }
    for (const field of fields) {
      if (field.kind === "enum" && !enums.some((item) => item.typeName === field.enumTypeName)) {
        enums.push(dumpEnum(field.enumInfo, field.enumTypeName));
      }
    }
    messages.push({ typeName: type.typeName, fields, defaults: Object.keys(new type()).sort() });
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, render(enums, messages), "utf8");
  console.log(`wrote docs/reference/grokbot-service-descriptor.txt: ${messages.length} messages / ${enums.length} enums`);
}

/* ------------------------------------------------------------------ 运行时取证 */

function typeFields(type) {
  const fields = type.fields;
  // proto.cjs 的 newFieldList 把工厂存在 _fields（惰性）；标准 FieldList 是数组。
  if (typeof fields?._fields === "function") return fields._fields();
  if (Array.isArray(fields)) return fields;
  return Array.from(fields ?? []);
}

function runtimeField(field) {
  const record = {
    no: field.no,
    name: field.name,
    // 运行时 FieldInfo 不带 localName（codegen 派生属性）；按 protobuf-es 同规则
    // camelCase(name) 推导，随后在 main 里与构造零值交叉验证。
    localName: field.localName || camelCase(field.name),
    kind: field.kind,
    opt: field.opt === true,
    repeated: field.repeated === true,
    oneof: field.oneof || undefined
  };
  if (field.kind === "scalar") {
    record.scalarT = Number(field.T);
  } else if (field.kind === "enum") {
    // protobuf-es 1.10：enum 字段的 T 是注册信息对象 {typeName, values}。
    record.enumTypeName = field.T?.typeName;
    record.enumInfo = field.T;
    if (!record.enumTypeName || !Array.isArray(field.T?.values)) {
      fail(`enum 字段 ${field.name} 的 T 上没有注册信息（protobuf-es 版本差异？）`);
    }
  } else if (field.kind === "message") {
    record.messageTypeName = field.T?.typeName;
    if (!record.messageTypeName) fail(`message 字段 ${field.name} 缺少 typeName`);
  } else {
    fail(`未支持的 field kind：${field.kind}（${field.name}）——按需扩展 dump 格式与解析器`);
  }
  return record;
}

function dumpEnum(enumInfo, typeName) {
  return {
    typeName,
    values: enumInfo.values.map(({ no, name, localName }) => {
      if (localName === undefined) fail(`枚举 ${typeName} 值 ${name}(${no}) 缺少 localName`);
      return { no, wireName: name, memberName: localName };
    })
  };
}

/* ------------------------------------------------------------------ proto.cjs 定位 */

function locateProtoCjs() {
  const argIndex = process.argv.indexOf("--proto-cjs");
  if (argIndex >= 0) {
    const path = process.argv[argIndex + 1];
    if (!path || !existsSync(path)) fail("--proto-cjs 路径无效");
    return resolve(path);
  }
  if (process.env.GROKBOT_PROTO_CJS && existsSync(process.env.GROKBOT_PROTO_CJS)) {
    return resolve(process.env.GROKBOT_PROTO_CJS);
  }

  const candidates = [];
  if (process.env.GROKBOT_DIR) candidates.push(process.env.GROKBOT_DIR);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Grok Bot"));
  candidates.push("D:/software/grokBot/Grok Bot");

  const install = candidates.find((dir) => existsSync(join(dir, "resources", "app.asar")));
  if (!install) fail("未找到 Grok Bot 安装目录；用 --proto-cjs 给已解包的 proto.cjs，或设 GROKBOT_DIR");

  const temp = mkdtempSync(join(tmpdir(), "grokbot-proto-"));
  try {
    const asar = join(install, "resources", "app.asar");
    // asar 的 extract-file 按平台分隔符匹配条目（win32 为反斜杠），path.join 正确。
    const inner = join("dist", "electron-main", "proto.cjs");
    // Node ≥18.20 对 .cmd 必须 shell；路径含空格（Grok Bot 目录）需要手工引号。
    const quote = (value) => (/[^\w/.-]/.test(value) ? `"${value}"` : value);
    execFileSync(`npx --yes @electron/asar extract-file ${quote(asar)} ${quote(inner)}`, {
      shell: true,
      cwd: temp,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000
    });
    const extracted = join(temp, "proto.cjs");
    if (!existsSync(extracted)) fail("asar extract-file 未产出 proto.cjs");
    return extracted;
  } catch (error) {
    fail(`从 app.asar 抽取 proto.cjs 失败：${error.stderr?.toString() || error.message}`);
  }
}

/* ------------------------------------------------------------------ 渲染 */

const SCALAR_NAMES = { 1: "double", 2: "float", 3: "int64", 5: "int32", 8: "bool", 9: "string", 12: "bytes", 13: "uint32" };

function render(enums, messages) {
  const lines = [
    "# Grok Bot GrokBotService descriptor dump（EnsureSandBox 子集）",
    "# 重新生成：node scripts/extract-grokbot-descriptor.mjs（会覆盖本文件）",
    "# 来源：Grok Bot resources/app.asar → dist/electron-main/proto.cjs",
    "# 取证：加载 proto bundle 运行时读取 ensureSandBox I/O 的静态字段表、枚举注册信息",
    "#       与构造零值；字段号 / kind / wire 名 / TS 成员名一律来自运行时本体。",
    "# 本文件是 src/cursor-bot/proto/grokbot_service_pb.ts 的唯一字段来源，勿手改。",
    "",
    "version grokbot-proto-dump/1",
    ""
  ];
  for (const item of enums) {
    lines.push(`enum ${item.typeName}`);
    for (const value of item.values) lines.push(`  ${value.memberName} = ${value.no} as ${value.wireName}`);
    lines.push("end", "");
  }
  for (const item of messages) {
    lines.push(`message ${item.typeName}`);
    for (const field of item.fields) {
      const parts = [`  field ${field.no} ${field.name} ${describeKind(field)}`];
      if (field.opt) parts.push("optional");
      if (field.repeated) parts.push("repeated");
      if (field.oneof) parts.push(`oneof ${field.oneof}`);
      lines.push(parts.join(" "));
    }
    lines.push(item.defaults.length ? `  defaults ${item.defaults.join(",")}` : "  defaults none");
    lines.push("end", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function describeKind(field) {
  if (field.kind === "scalar") {
    const name = SCALAR_NAMES[field.scalarT];
    if (!name) fail(`未知 scalar T=${field.scalarT}（${field.name}）——在 SCALAR_NAMES 补条目`);
    return name;
  }
  if (field.kind === "enum") return `enum ${field.enumTypeName}`;
  return `message ${field.messageTypeName}`;
}

function fail(message) {
  console.error(`extract-grokbot-descriptor: ${message}`);
  process.exit(1);
}

/** protobuf-es 的 localName 推导规则：snake_case → camelCase。 */
function camelCase(name) {
  return name
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

main();
