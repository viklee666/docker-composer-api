import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type ScriptModule = {
  grokUserDataCandidates: (
    env?: NodeJS.Dict<string>,
    platform?: NodeJS.Platform,
    home?: string
  ) => string[];
  findGrokUserData: (
    env?: NodeJS.Dict<string>,
    platform?: NodeJS.Platform,
    home?: string,
    exists?: (path: string) => boolean
  ) => string | undefined;
  deriveChromeCbcKey: (password: string, iterations: number) => Buffer;
  decryptOsCryptBlob: (blobB64: string, keys: Array<{ key: Buffer; mode: "gcm" | "cbc" }>) => string;
};

const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "import-local-grok-bot.mjs")
).href;
const script = (await import(scriptUrl)) as ScriptModule;

test("grokUserDataCandidates follows Electron userData per OS and GROK_BOT_USERDATA", () => {
  assert.deepEqual(script.grokUserDataCandidates({ GROK_BOT_USERDATA: " /custom/Grok " }, "linux", "/home/u"), [
    "/custom/Grok"
  ]);

  const win = script.grokUserDataCandidates(
    { APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    "win32",
    "C:\\Users\\a"
  );
  assert.ok(win.includes(join("C:\\Users\\a\\AppData\\Roaming", "Grok Bot")));
  assert.ok(win.includes(join("C:\\Users\\a\\AppData\\Local", "Grok Bot")));

  const mac = script.grokUserDataCandidates({}, "darwin", "/Users/a");
  assert.ok(mac.includes(join("/Users/a", "Library", "Application Support", "Grok Bot")));

  const linux = script.grokUserDataCandidates({ XDG_CONFIG_HOME: "/home/a/.config" }, "linux", "/home/a");
  assert.ok(linux.includes(join("/home/a/.config", "Grok Bot")));
  assert.ok(linux.includes(join("/home/a/.config", "grok-bot")));
});

test("findGrokUserData picks the first candidate that has sand-secrets.json", () => {
  const found = script.findGrokUserData({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/a", (path) =>
    path.replaceAll("\\", "/").endsWith("/cfg/Grok Bot/sand-secrets.json")
  );
  assert.equal(found, join("/cfg", "Grok Bot"));
  assert.equal(script.findGrokUserData({}, "darwin", "/Users/a", () => false), undefined);
});

test("decryptOsCryptBlob reads Chromium v10 AES-256-GCM and v10 AES-128-CBC", () => {
  const plain = "eyJhbGciOiJub25lIn0.session-token";

  const gcmKey = randomBytes(32);
  const nonce = randomBytes(12);
  const gcm = createCipheriv("aes-256-gcm", gcmKey, nonce);
  const gcmBlob = Buffer.concat([Buffer.from("v10"), nonce, gcm.update(plain, "utf8"), gcm.final(), gcm.getAuthTag()]);
  assert.equal(script.decryptOsCryptBlob(gcmBlob.toString("base64"), [{ key: gcmKey, mode: "gcm" }]), plain);

  const password = "peanuts";
  const cbcKey = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  assert.deepEqual(script.deriveChromeCbcKey(password, 1), cbcKey);
  const cbc = createCipheriv("aes-128-cbc", cbcKey, Buffer.alloc(16, 0x20));
  const cbcBlob = Buffer.concat([Buffer.from("v11"), cbc.update(plain, "utf8"), cbc.final()]);
  assert.equal(script.decryptOsCryptBlob(cbcBlob.toString("base64"), [{ key: cbcKey, mode: "cbc" }]), plain);
});
