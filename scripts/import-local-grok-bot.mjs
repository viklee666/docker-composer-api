#!/usr/bin/env node
/**
 * 从本机 Grok Bot 解密长效 session JWT，并导入网关 Bot 凭据。
 *
 * 浏览器读不到 %APPDATA%\Grok Bot：token 是 Chromium OSCrypt（v10 + Windows DPAPI）。
 * 网关若跑在 Docker Linux 里同样解不了。所以这个脚本必须在「装着 Grok Bot 的
 * 那台 Windows 电脑」上、以当前登录用户运行。
 *
 * 用法：
 *   node scripts/import-local-grok-bot.mjs
 *       在 127.0.0.1:17876 起助手。打开网关后台「Bot 凭据」点「从本机 Grok Bot 导入」。
 *
 *   node scripts/import-local-grok-bot.mjs --gateway http://127.0.0.1:8787
 *       一次性导入（口令读 ADMIN_PASSWORD / --admin-password）。
 *
 * 不要把解密出的 JWT 贴到聊天、日志或截图里。
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_HELPER_PORT = 17876;
const DEFAULT_LABEL = "Grok Bot";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function grokUserData() {
  if (process.env.GROK_BOT_USERDATA) return process.env.GROK_BOT_USERDATA;
  const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appdata, "Grok Bot");
}

function dpapiUnprotect(buffer) {
  if (process.platform !== "win32") {
    throw new Error("Grok Bot 的 token 用 Windows DPAPI 加密，请在安装了 Grok Bot 的 Windows 电脑上运行本脚本。");
  }
  const dir = mkdtempSync(join(tmpdir(), "grok-bot-dpapi-"));
  const input = join(dir, "in.bin");
  const output = join(dir, "out.bin");
  try {
    writeFileSync(input, buffer);
    const script = [
      "Add-Type -AssemblyName System.Security",
      `$in = [IO.File]::ReadAllBytes(${JSON.stringify(input)})`,
      "$plain = [Security.Cryptography.ProtectedData]::Unprotect($in, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      `[IO.File]::WriteAllBytes(${JSON.stringify(output)}, $plain)`
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 20_000,
      stdio: ["ignore", "ignore", "pipe"]
    });
    return readFileSync(output);
  } catch (error) {
    const stderr = error.stderr?.toString("utf8")?.trim();
    throw new Error(stderr || "DPAPI 解密失败（请用安装 Grok Bot 的同一个 Windows 用户运行）。");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function unwrapOsCryptKey(localStatePath) {
  const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
  const wrappedB64 = localState?.os_crypt?.encrypted_key;
  if (typeof wrappedB64 !== "string" || !wrappedB64) {
    throw new Error("Grok Bot 的 Local State 里没有 os_crypt.encrypted_key。");
  }
  const wrapped = Buffer.from(wrappedB64, "base64");
  const payload = wrapped.subarray(0, 5).toString("ascii") === "DPAPI" ? wrapped.subarray(5) : wrapped;
  const key = dpapiUnprotect(payload);
  if (key.length !== 32) {
    throw new Error(`OSCrypt 主密钥长度异常（${key.length}），Grok Bot 可能已换加密方案。`);
  }
  return key;
}

function decryptV10(masterKey, blobB64, field) {
  const blob = Buffer.from(blobB64, "base64");
  const prefix = blob.subarray(0, 3).toString("ascii");
  if (prefix === "v20") {
    throw new Error(`${field} 是 v20 加密，当前脚本只支持 Grok Bot 的 Chromium v10。`);
  }
  if (prefix !== "v10" || blob.length < 3 + 12 + 16) {
    throw new Error(`${field} 不是可识别的 Grok Bot 密文。`);
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function jwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : undefined;
  } catch {
    return undefined;
  }
}

let cachedMasterKey;

function readLocalGrokBot() {
  const root = grokUserData();
  const secretsPath = join(root, "sand-secrets.json");
  const localStatePath = join(root, "Local State");
  if (!existsSync(secretsPath) || !existsSync(localStatePath)) {
    throw new Error(`未找到 Grok Bot 用户数据（${root}）。请确认这台电脑已安装并登录过 Grok Bot。`);
  }
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  if (typeof secrets["cursor-accounts"] !== "string") {
    throw new Error("sand-secrets.json 里没有 cursor-accounts。");
  }
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const table = accounts?.accounts && typeof accounts.accounts === "object" ? accounts.accounts : {};
  const active = typeof accounts.active === "string" ? accounts.active : "";
  const account = table[active] || Object.values(table)[0];
  if (!account || typeof account !== "object") {
    throw new Error("Grok Bot 里没有已登录账号。");
  }
  if (!cachedMasterKey) cachedMasterKey = unwrapOsCryptKey(localStatePath);
  const accessToken = decryptV10(cachedMasterKey, account["cursor-access-token"], "cursor-access-token");
  const machineId = decryptV10(cachedMasterKey, secrets["cursor-machine-id"], "cursor-machine-id").trim();
  let email = "";
  let name = "";
  try {
    const profile = JSON.parse(decryptV10(cachedMasterKey, account["cursor-account-profile"], "cursor-account-profile"));
    if (typeof profile?.email === "string") email = profile.email.trim();
    if (typeof profile?.name === "string") name = profile.name.trim();
  } catch {
    // 没有资料不挡导入。
  }
  const payload = jwtPayload(accessToken) ?? {};
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const exp = typeof payload.exp === "number" && payload.exp > 0 ? payload.exp : undefined;
  if (type === "web") {
    throw new Error("Grok Bot 读出来的是浏览器 web token，不能当作 Bot session。");
  }
  if (!accessToken.startsWith("eyJ") || !machineId) {
    throw new Error("解密结果不是 session JWT / machineId。");
  }
  return {
    accessToken,
    machineId,
    email,
    name,
    tokenType: type,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
    label: email ? `${DEFAULT_LABEL} (${email})` : DEFAULT_LABEL
  };
}

function publicSnapshot(record) {
  return {
    ok: true,
    email: record.email || undefined,
    name: record.name || undefined,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    machineId: record.machineId,
    label: record.label
  };
}

function isLoopbackHost(hostname) {
  const host = (hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function parseAllowList(values) {
  return values
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function originAllowed(origin, allowOrigins) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (isLoopbackHost(url.hostname)) return true;
    return allowOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function gatewayAllowed(gatewayUrl, allowOrigins) {
  const url = new URL(gatewayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("gatewayUrl 只接受 http/https。");
  }
  if (isLoopbackHost(url.hostname) || allowOrigins.includes(url.origin)) return url;
  throw new Error(`拒绝把 token 发往非本机网关 ${url.origin}。加 --allow-origin ${url.origin} 才允许。`);
}

async function pushToGateway(record, gatewayUrl, adminToken, allowOrigins) {
  const url = gatewayAllowed(gatewayUrl, allowOrigins);
  const endpoint = new URL("/admin/api/bot/credentials/from-desktop", url);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sessionToken: record.accessToken,
      machineId: record.machineId,
      label: record.label
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `网关返回 HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function sendJson(response, status, origin, payload) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "origin";
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function serve(port, allowOrigins) {
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && !originAllowed(origin, allowOrigins)) {
      sendJson(response, 403, "", { ok: false, error: "来源不在允许列表里。" });
      return;
    }
    if (request.method === "OPTIONS") {
      if (origin) {
        response.writeHead(204, {
          "access-control-allow-origin": origin,
          vary: "origin",
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "600"
        });
      } else {
        response.writeHead(204);
      }
      response.end();
      return;
    }
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    void (async () => {
      try {
        if (request.method === "GET" && (path === "/health" || path === "/")) {
          sendJson(response, 200, origin || "", { ok: true, app: "grok-bot-local" });
          return;
        }
        if (request.method === "GET" && path === "/status") {
          sendJson(response, 200, origin || "", publicSnapshot(readLocalGrokBot()));
          return;
        }
        if (request.method === "POST" && path === "/import") {
          const body = await readJsonBody(request);
          const gatewayUrl = typeof body.gatewayUrl === "string" ? body.gatewayUrl.trim() : "";
          const adminToken = typeof body.adminToken === "string" ? body.adminToken.trim() : "";
          if (!gatewayUrl || !adminToken) {
            sendJson(response, 400, origin || "", { ok: false, error: "需要 gatewayUrl 与 adminToken。" });
            return;
          }
          const record = readLocalGrokBot();
          const result = await pushToGateway(record, gatewayUrl, adminToken, allowOrigins);
          sendJson(response, 200, origin || "", { ok: true, ...publicSnapshot(record), credential: result.credential });
          return;
        }
        sendJson(response, 404, origin || "", { ok: false, error: "not found" });
      } catch (error) {
        sendJson(response, 500, origin || "", {
          ok: false,
          error: error instanceof Error ? error.message : "本机 Grok Bot 读取失败"
        });
      }
    })();
  });
  server.listen(port, "127.0.0.1", () => {
    let snapshot;
    try {
      snapshot = publicSnapshot(readLocalGrokBot());
    } catch (error) {
      console.error(`警告：现在读不到 Grok Bot（${error instanceof Error ? error.message : error}）。助手仍在听，登录后再点导入。`);
    }
    console.log(`本机 Grok Bot 助手：http://127.0.0.1:${port}`);
    if (snapshot?.email) console.log(`已登录：${snapshot.email}  ${snapshot.tokenType}  过期 ${snapshot.expiresAt || "?"}`);
    console.log("打开网关后台 → Bot 凭据 →「从本机 Grok Bot 导入」。Ctrl+C 结束。");
  });
}

function printHelp() {
  console.log(`从本机 Grok Bot 导入长效 Bot session token（type=session，约 60 天）。

用法:
  node scripts/import-local-grok-bot.mjs                  启动本机助手（后台一键导入）
  node scripts/import-local-grok-bot.mjs --gateway URL    一次性导入网关
  node scripts/import-local-grok-bot.mjs --status         只看账号/过期，不打印 token

选项:
  --port N                 助手端口，默认 ${DEFAULT_HELPER_PORT}
  --admin-password TEXT    一次性导入时的后台口令（默认读 ADMIN_PASSWORD）
  --allow-origin ORIGIN    允许非 127.0.0.1 的网关来源（可重复）
  --print-token            把 JWT 打到 stdout（只给自己粘贴用，别进日志）
  --help`);
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    printHelp();
    return;
  }
  const allowOrigins = parseAllowList([
    argValue("--gateway"),
    argValue("--allow-origin"),
    process.env.GATEWAY_PUBLIC_URL
  ]);
  // 允许重复 --allow-origin
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--allow-origin" && process.argv[i + 1]) {
      allowOrigins.push(...parseAllowList([process.argv[i + 1]]));
    }
  }

  if (hasFlag("--status") || hasFlag("--print-token")) {
    const record = readLocalGrokBot();
    console.log(JSON.stringify(publicSnapshot(record), null, 2));
    if (hasFlag("--print-token")) process.stdout.write(`${record.accessToken}\n`);
    return;
  }

  const gateway = argValue("--gateway");
  if (gateway) {
    const adminToken = argValue("--admin-password") || process.env.ADMIN_PASSWORD || "";
    if (!adminToken) fail("一次性导入需要 --admin-password 或环境变量 ADMIN_PASSWORD。");
    const record = readLocalGrokBot();
    const result = await pushToGateway(record, gateway, adminToken, allowOrigins);
    console.log(`已导入 ${record.label}  ${record.tokenType}  过期 ${record.expiresAt || "?"}`);
    if (result?.credential?.id) console.log(`凭据 id ${result.credential.id}`);
    return;
  }

  const port = Number(argValue("--port") || process.env.GROK_BOT_HELPER_PORT || DEFAULT_HELPER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("无效 --port");
  serve(port, allowOrigins);
}

const isDirect = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isDirect) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
