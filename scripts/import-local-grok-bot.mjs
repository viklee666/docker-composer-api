#!/usr/bin/env node
/**
 * 从本机已登录的 Grok Bot 取出长效 session JWT，复制到剪贴板。
 *
 * 在「装着 Grok Bot 的那台 Windows 电脑」上运行（必须是当前登录用户，才能解开 DPAPI）：
 *   node grok-bot-token.mjs
 *
 * 然后回到网关后台 → Bot 凭据 → 粘贴 token。同一 Cursor 账号会覆盖原凭据。
 *
 * 不要把终端里的 JWT 发到聊天、截图或日志。
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function grokUserData() {
  if (process.env.GROK_BOT_USERDATA) return process.env.GROK_BOT_USERDATA;
  const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appdata, "Grok Bot");
}

function dpapiUnprotect(buffer) {
  if (process.platform !== "win32") {
    throw new Error("Grok Bot 的 token 用 Windows DPAPI 加密，请在安装了 Grok Bot 的 Windows 电脑上运行。");
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
    throw new Error(`${field} 是 v20 加密，当前脚本只支持 Chromium v10。`);
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
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function copyToClipboard(text) {
  if (process.platform === "win32") {
    execFileSync("clip", { input: text, windowsHide: true, timeout: 5_000 });
    return true;
  }
  if (process.platform === "darwin") {
    execFileSync("pbcopy", { input: text, timeout: 5_000 });
    return true;
  }
  return false;
}

function main() {
  const root = grokUserData();
  const secretsPath = join(root, "sand-secrets.json");
  const localStatePath = join(root, "Local State");
  if (!existsSync(secretsPath) || !existsSync(localStatePath)) {
    fail(`未找到 Grok Bot 用户数据：${root}\n请确认这台电脑已安装并登录过 Grok Bot。`);
  }
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  if (typeof secrets["cursor-accounts"] !== "string") fail("sand-secrets.json 里没有 cursor-accounts。");
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const table = accounts?.accounts && typeof accounts.accounts === "object" ? accounts.accounts : {};
  const active = typeof accounts.active === "string" ? accounts.active : "";
  const account = table[active] || Object.values(table)[0];
  if (!account || typeof account !== "object") fail("Grok Bot 里没有已登录账号。");

  const masterKey = unwrapOsCryptKey(localStatePath);
  const token = decryptV10(masterKey, account["cursor-access-token"], "cursor-access-token");
  if (!token.startsWith("eyJ")) fail("解密结果不是 JWT。");

  let email = "";
  let name = "";
  try {
    const profile = JSON.parse(decryptV10(masterKey, account["cursor-account-profile"], "cursor-account-profile"));
    if (typeof profile?.email === "string") email = profile.email.trim();
    if (typeof profile?.name === "string") name = profile.name.trim();
  } catch {
    // 没有资料不挡复制。
  }
  const payload = jwtPayload(token) ?? {};
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : "";
  if (type === "web") fail("读出来的是浏览器 web token，不能当作 Bot session。");

  let copied = false;
  try {
    copied = copyToClipboard(token);
  } catch {
    copied = false;
  }

  console.log(`账号: ${email || "(token 里没有邮箱)"}`);
  if (name) console.log(`名称: ${name}`);
  console.log(`user: ${userId || sub || "?"}`);
  console.log(`type: ${type}`);
  if (exp) console.log(`过期: ${exp}`);
  console.log("");
  if (copied) console.log("已复制 token 到剪贴板。去网关后台 Bot 凭据里粘贴即可（同一账号会覆盖）。");
  else console.log("自动复制失败，请手动复制下面的 token：");
  console.log("");
  console.log(token);
}

main();
