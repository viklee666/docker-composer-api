#!/usr/bin/env node
/**
 * 从本机已登录的 Grok Bot 取出长效 session JWT，复制到剪贴板。
 *
 *   node grok-bot-token.mjs
 *
 * 在装着 Grok Bot 的那台电脑上、用登录过它的那个系统用户运行。
 * 脚本找的是 Electron 用户数据目录，不是安装目录：
 *   Windows  %APPDATA%\Grok Bot
 *   macOS    ~/Library/Application Support/Grok Bot
 *   Linux    $XDG_CONFIG_HOME/Grok Bot 或 ~/.config/Grok Bot
 * 路径不对时设 GROK_BOT_USERDATA。macOS 首次可能弹出钥匙串授权。
 *
 * 然后回到网关后台 → Bot 凭据 → 粘贴 token。同一 Cursor 账号会覆盖原凭据。
 * 不要把终端里的 JWT 发到聊天、截图或日志。
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USER_DATA_NAMES = ["Grok Bot", "GrokBot", "grok-bot"];
const SECRET_APP_NAMES = ["Grok Bot", "GrokBot", "grok-bot", "Chromium", "Electron"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function grokUserDataCandidates(env = process.env, platform = process.platform, home = homedir()) {
  const override = typeof env.GROK_BOT_USERDATA === "string" ? env.GROK_BOT_USERDATA.trim() : "";
  if (override) return [override];

  const dirs = [];
  const pushAll = (root) => {
    for (const name of USER_DATA_NAMES) dirs.push(join(root, name));
  };

  if (platform === "win32") {
    pushAll(env.APPDATA || join(home, "AppData", "Roaming"));
    pushAll(env.LOCALAPPDATA || join(home, "AppData", "Local"));
  } else if (platform === "darwin") {
    pushAll(join(home, "Library", "Application Support"));
  } else {
    pushAll(env.XDG_CONFIG_HOME || join(home, ".config"));
  }
  return dirs;
}

export function findGrokUserData(env = process.env, platform = process.platform, home = homedir(), exists = existsSync) {
  const candidates = grokUserDataCandidates(env, platform, home);
  for (const dir of candidates) {
    if (exists(join(dir, "sand-secrets.json"))) return dir;
  }
  return undefined;
}

export function deriveChromeCbcKey(password, iterations) {
  return pbkdf2Sync(String(password), "saltysalt", iterations, 16, "sha1");
}

function decryptGcm(masterKey, blob) {
  if (blob.length < 3 + 12 + 16) throw new Error("gcm blob too short");
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(15, blob.length - 16);
  const algo = masterKey.length === 16 ? "aes-128-gcm" : "aes-256-gcm";
  const decipher = createDecipheriv(algo, masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function decryptCbc(masterKey, blob) {
  if (masterKey.length !== 16) throw new Error("cbc key must be 16 bytes");
  if (blob.length < 3 + 16) throw new Error("cbc blob too short");
  const data = blob.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv("aes-128-cbc", masterKey, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * @param {string} blobB64
 * @param {Array<{ key: Buffer, mode: "gcm" | "cbc" }>} keys
 */
export function decryptOsCryptBlob(blobB64, keys) {
  const blob = Buffer.from(blobB64, "base64");
  const prefix = blob.subarray(0, 3).toString("ascii");
  if (prefix === "v20") {
    throw new Error("密文是 v20 加密，当前脚本只支持 Chromium v10/v11。");
  }
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error("不是可识别的 Grok Bot 密文。");
  }
  const errors = [];
  for (const item of keys) {
    try {
      const text = item.mode === "cbc" ? decryptCbc(item.key, blob) : decryptGcm(item.key, blob);
      if (text) return text;
    } catch (error) {
      errors.push(`${item.mode}/${item.key.length}B: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(errors[0] ? `解不开 token（${errors[0]}）` : "解不开 token。");
}

function commandExists(file) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [file], {
      timeout: 3_000,
      windowsHide: true,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(file, args, options = {}) {
  try {
    const out = execFileSync(file, args, {
      timeout: 8_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      ...options
    });
    const text = String(out ?? "").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function dpapiUnprotect(buffer) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI 只在 Windows 上可用。");
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

function unwrapWindowsOsCryptKey(localStatePath) {
  if (!existsSync(localStatePath)) {
    throw new Error("Windows 需要 Local State 才能解开 OSCrypt 主密钥。");
  }
  const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
  const wrappedB64 = localState?.os_crypt?.encrypted_key;
  if (typeof wrappedB64 !== "string" || !wrappedB64) {
    throw new Error("Grok Bot 的 Local State 里没有 os_crypt.encrypted_key。");
  }
  const wrapped = Buffer.from(wrappedB64, "base64");
  const payload = wrapped.subarray(0, 5).toString("ascii") === "DPAPI" ? wrapped.subarray(5) : wrapped;
  const key = dpapiUnprotect(payload);
  if (key.length !== 16 && key.length !== 32) {
    throw new Error(`OSCrypt 主密钥长度异常（${key.length}），Grok Bot 可能已换加密方案。`);
  }
  return [{ key, mode: key.length === 16 ? "cbc" : "gcm" }];
}

function macKeychainPasswords() {
  const found = [];
  const seen = new Set();
  for (const name of SECRET_APP_NAMES) {
    const accounts = [name, `${name} Key`, `${name} App Store Key`];
    for (const account of accounts) {
      const password = commandOutput("security", ["find-generic-password", "-w", "-s", `${name} Safe Storage`, "-a", account]);
      if (password && !seen.has(password)) {
        seen.add(password);
        found.push(password);
      }
    }
  }
  return found;
}

function linuxSecretPasswords() {
  const found = [];
  const seen = new Set();
  const add = (password) => {
    if (password && !seen.has(password)) {
      seen.add(password);
      found.push(password);
    }
  };
  if (commandExists("secret-tool")) {
    for (const name of SECRET_APP_NAMES) {
      add(commandOutput("secret-tool", ["lookup", "application", name], { timeout: 5_000 }));
    }
  }
  if (commandExists("kwallet-query")) {
    const lookups = [
      ["Grok Bot Keys", "Grok Bot Safe Storage"],
      ["Chrome Keys", "Chrome Safe Storage"],
      ["Chromium Keys", "Chromium Safe Storage"]
    ];
    for (const wallet of ["kdewallet", "kdewallet5"]) {
      for (const [folder, entry] of lookups) {
        add(commandOutput("kwallet-query", ["-f", folder, "-r", entry, wallet], { timeout: 5_000 }));
      }
    }
  }
  return found;
}

function keysFromPassword(password, iterationsList) {
  const keys = [];
  for (const iterations of iterationsList) {
    keys.push({ key: deriveChromeCbcKey(password, iterations), mode: "cbc" });
  }
  const raw = Buffer.from(password, "utf8");
  if (raw.length === 16 || raw.length === 32) keys.push({ key: raw, mode: "gcm" });
  const b64 = Buffer.from(password, "base64");
  if (b64.length === 16 || b64.length === 32) keys.push({ key: b64, mode: "gcm" });
  return keys;
}

function collectOsCryptKeys(localStatePath) {
  if (process.platform === "win32") return unwrapWindowsOsCryptKey(localStatePath);

  const passwords = process.platform === "darwin" ? macKeychainPasswords() : linuxSecretPasswords();
  if (process.platform !== "darwin" && !passwords.length) passwords.push("peanuts");
  if (!passwords.length) {
    throw new Error(
      process.platform === "darwin"
        ? "钥匙串里没有 Grok Bot / Chromium Safe Storage。首次运行请在弹出框里选「始终允许」。"
        : "gnome-keyring / KWallet 里没有 OSCrypt 密钥，basic_text 回退也失败了。"
    );
  }
  const iterations = process.platform === "darwin" ? [1003] : [1, 1003];
  const keys = passwords.flatMap((password) => keysFromPassword(password, iterations));
  if (existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
      const wrappedB64 = localState?.os_crypt?.encrypted_key;
      if (typeof wrappedB64 === "string" && wrappedB64) {
        const wrapped = Buffer.from(wrappedB64, "base64");
        const payload = wrapped.subarray(0, 5).toString("ascii") === "DPAPI" ? wrapped.subarray(5) : wrapped;
        if (payload.length === 16 || payload.length === 32) {
          keys.push({ key: payload, mode: payload.length === 16 ? "cbc" : "gcm" });
        }
      }
    } catch {
      // Local State 读失败不挡钥匙串路径。
    }
  }
  return keys;
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

export function copyToClipboard(text) {
  if (process.platform === "win32") {
    execFileSync("clip", { input: text, windowsHide: true, timeout: 5_000 });
    return true;
  }
  if (process.platform === "darwin") {
    execFileSync("pbcopy", { input: text, timeout: 5_000 });
    return true;
  }
  const tools = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]]
  ];
  for (const [file, args] of tools) {
    try {
      execFileSync(file, args, { input: text, timeout: 5_000, stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      // 试下一个剪贴板工具。
    }
  }
  return false;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

export function loadGrokBotSession() {
  const candidates = grokUserDataCandidates();
  const root = findGrokUserData();
  if (!root) {
    fail(
      `未找到 Grok Bot 用户数据（sand-secrets.json）。\n试过：\n${candidates.map((dir) => `  ${dir}`).join("\n")}\n可设 GROK_BOT_USERDATA 指向实际目录。`
    );
  }
  const secretsPath = join(root, "sand-secrets.json");
  const localStatePath = join(root, "Local State");
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  if (typeof secrets["cursor-accounts"] !== "string") fail("sand-secrets.json 里没有 cursor-accounts。");
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const table = accounts?.accounts && typeof accounts.accounts === "object" ? accounts.accounts : {};
  const active = typeof accounts.active === "string" ? accounts.active : "";
  const account = table[active] || Object.values(table)[0];
  if (!account || typeof account !== "object") fail("Grok Bot 里没有已登录账号。");

  const keys = collectOsCryptKeys(localStatePath);
  const token = decryptOsCryptBlob(account["cursor-access-token"], keys);
  if (!token.startsWith("eyJ")) fail("解密结果不是 JWT。");

  let email = "";
  let name = "";
  try {
    const profile = JSON.parse(decryptOsCryptBlob(account["cursor-account-profile"], keys));
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

  const machineId =
    (typeof account["machine-id"] === "string" && account["machine-id"].trim()) ||
    (typeof account.machineId === "string" && account.machineId.trim()) ||
    (typeof secrets["machine-id"] === "string" && secrets["machine-id"].trim()) ||
    "";

  return { root, token, email, name, userId, sub, type, exp, machineId };
}

function main() {
  const session = loadGrokBotSession();
  let copied = false;
  try {
    copied = copyToClipboard(session.token);
  } catch {
    copied = false;
  }

  console.log(`数据目录: ${session.root}`);
  console.log(`账号: ${session.email || "(token 里没有邮箱)"}`);
  if (session.name) console.log(`名称: ${session.name}`);
  console.log(`user: ${session.userId || session.sub || "?"}`);
  console.log(`type: ${session.type}`);
  if (session.exp) console.log(`过期: ${session.exp}`);
  console.log("");
  if (copied) console.log("已复制 token 到剪贴板。去网关后台 Bot 凭据里粘贴即可（同一账号会覆盖）。");
  else console.log("自动复制失败，请手动复制下面的 token：");
  console.log("");
  console.log(session.token);
}

if (isDirectRun()) main();
