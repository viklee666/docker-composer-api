import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { ADMIN_HTML } from "../src/admin-ui.js";
import { ADMIN_STYLES } from "../src/admin-ui-styles.js";
import { ADMIN_UX_SCRIPT } from "../src/admin-ui-ux.js";

const scripts = Array.from(ADMIN_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => match[1]);
const inlineScript = scripts.join("\n");
// Only actual markup counts: generated modal IDs inside JS strings are not static DOM IDs.
const markup = ADMIN_HTML.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");
const tags = markup.match(/<[a-z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=\\s|/?>)`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : undefined;
}

function tagById(id: string): string {
  const tag = tags.find((candidate) => attribute(candidate, "id") === id);
  assert.ok(tag, `Missing static DOM element #${id}`);
  return tag;
}

/** Extract the shipped function, without executing login, timers or the full DOM bootstrap.
 * Let the JS parser find the closing brace so nested blocks, comments and string braces are safe.
 */
function extractFunction(name: string): string {
  const start = inlineScript.search(new RegExp(`\\bfunction ${name}\\s*\\(`));
  assert.notEqual(start, -1, `Missing inline function ${name}`);
  for (let end = inlineScript.indexOf("}", start); end !== -1; end = inlineScript.indexOf("}", end + 1)) {
    const source = inlineScript.slice(start, end + 1);
    try {
      new vm.Script(`(${source})`);
      return source;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  assert.fail(`Could not extract ${name}`);
}

function makeElement() {
  const classes = new Set<string>();
  return {
    value: "" as string | number,
    checked: false,
    textContent: "",
    innerHTML: "",
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => { classes.add(name); },
      remove: (name: string) => { classes.delete(name); },
      toggle(name: string, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      }
    }
  };
}

type FakeElement = ReturnType<typeof makeElement>;

interface UiFunctions {
  isUiDirty(name: string): boolean;
  setUiDirty(name: string, dirty: boolean): void;
  uiSaveTarget(path: string, body?: Record<string, unknown> | null): string;
  api(method: string, path: string, body?: Record<string, unknown>): Promise<unknown>;
  applySettingsForm(config: Record<string, unknown>, force?: boolean): void;
  applyRoutingForm(config: Record<string, unknown>): void;
  applySysForm(config: Record<string, unknown>): void;
  hydrateSystemPrompt(force?: boolean): Promise<void> | undefined;
  loadQuotaBuckets(force?: boolean): void;
  loadProxy(): Promise<void>;
  openUiForm(id: string): void;
  renderProxy(status: Record<string, unknown>): void;
  trackUiChanges(event: {
    target: { id: string; type: string; closest(selector: string): { dataset: { section: string } } | null };
  }): void;
}

function harness(names: string[] = [], overrides: Record<string, unknown> = {}) {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    let node = elements.get(id);
    if (!node) { node = makeElement(); elements.set(id, node); }
    return node;
  };
  const document: { activeElement: unknown; querySelectorAll: (selector: string) => unknown[] } = {
    activeElement: null,
    querySelectorAll: () => []
  };
  const uiRevision: Record<string, number> = {};
  const uiDirty: Record<string, boolean> = {};
  const context = vm.createContext({
    $: element, document, uiRevision, uiDirty, token: "test-admin-token",
    toast: () => assert.fail("Unexpected error toast"),
    showLogin: () => assert.fail("Unexpected login redirect"),
    ...overrides
  });
  const functions = [...new Set(["isUiDirty", "setUiDirty", "uiSaveTarget", ...names])];
  new vm.Script(functions.map(extractFunction).join("\n")).runInContext(context);
  const ui = context as unknown as UiFunctions;
  return { ui, context, element, elements, document, uiRevision, uiDirty };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(data: unknown = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// loadQuotaBuckets deliberately returns void; drain its promise callbacks without sleeps.
const settleCallbacks = () => new Promise<void>((resolve) => setImmediate(resolve));

test("admin redesign embeds parseable scripts and the offline stylesheet", () => {
  assert.ok(scripts.length > 0, "The admin page must ship an inline script");
  for (const [index, script] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(script, { filename: `admin-inline-${index}.js` }));
  }
  assert.ok(ADMIN_HTML.includes(ADMIN_UX_SCRIPT));
  assert.ok(ADMIN_HTML.includes(`<style>${ADMIN_STYLES}</style>`));
  assert.doesNotMatch(ADMIN_HTML, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(markup, /<link\b[^>]*\brel=["']stylesheet["']/i);
});

test("admin redesign has unique static DOM IDs and preserves existing control IDs", () => {
  const ids = tags.map((tag) => attribute(tag, "id")).filter((id): id is string => id !== undefined);
  assert.ok(ids.length > 100, "The static markup extraction must include the full console");
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], "Static DOM IDs must be unique");
  const required = [
    "login", "login-pass", "login-btn", "login-err", "app", "nav", "sidebar", "sidebar-mask",
    "btn-menu", "crumb", "auto-refresh", "btn-refresh", "btn-logout",
    "st-keys", "st-24h", "st-avg", "st-cost", "st-total", "st-tokens", "st-estimated-tokens",
    "cfg-summary", "durable-summary", "durable-recent",
    "keys-body", "keys-empty", "new-label", "new-key", "new-weight", "new-allowed", "new-excluded",
    "btn-add-key", "key-test-model", "mint-token", "mint-name", "mint-show", "btn-mint",
    "gw-body", "gw-empty", "gw-unwired", "gw-wired", "gw-reveal", "gw-reveal-key",
    "new-gw-label", "new-gw-key", "btn-add-gw", "btn-copy-gw", "btn-hide-gw",
    "bot-body", "bot-token", "bot-from-key", "btn-bot-from-key", "btn-bot-add", "btn-bot-chat",
    "sys-mode", "sys-text", "sys-count", "btn-save-sys", "btn-load-sys",
    "affinity-toggle", "affinity-ttl", "btn-save-routing", "proxy-url", "proxy-status", "btn-save-proxy",
    "logs-body", "logs-empty", "log-model", "log-key", "log-gw", "log-limit", "log-page",
    "btn-log-prev", "btn-log-next", "test-provider", "test-model", "test-key", "test-prompt", "btn-test",
    "session-mode", "sdk-http1-mode", "allow-direct-toggle", "builtin-tools-toggle", "request-timeout",
    "fast-policy", "fast-models-list", "max-mode-policy", "max-mode-models-list",
    "bot-fast-policy", "bot-max-mode-policy", "debug-toggle", "boot-env-body", "btn-save-settings",
    "quota-buckets-json", "quota-buckets-hint", "modal-mask", "modal-title", "modal-close", "toast"
  ];
  for (const id of required) tagById(id);
});

test("admin navigation and the three onboarding steps target existing sections", () => {
  const sections = ["dashboard", "history", "keys", "gateway-keys", "diagnostics", "bot", "routing", "system-prompt", "proxy", "settings"];
  const nav = tags.filter((tag) => attribute(tag, "data-nav") !== undefined);
  assert.deepEqual(nav.map((tag) => attribute(tag, "data-nav")).sort(), [...sections].sort());
  for (const tag of nav) assert.match(tag, /^<button\b/i);
  for (const name of sections) assert.equal(attribute(tagById(`sec-${name}`), "data-section"), name);
  for (const [id, section] of [["setup-upstream", "keys"], ["setup-client", "gateway-keys"], ["setup-test", "diagnostics"]]) {
    const tag = tagById(id);
    assert.match(tag, /^<button\b/i);
    assert.equal(attribute(tag, "data-go"), section);
  }
  for (const id of ["setup-progress", "page-title", "page-description", "page-actions", "key-search", "client-base-url", "copy-base-url"]) tagById(id);
});

test("upstream and client credential forms are native disclosures collapsed by default", () => {
  for (const id of ["add-key-form", "add-gw-form"]) {
    const tag = tagById(id);
    assert.match(tag, /^<details\b/i);
    assert.equal(attribute(tag, "open"), undefined, `${id} should initially be collapsed`);
    assert.ok(tags.some((candidate) => attribute(candidate, "data-close-disclosure") === id), `${id} needs a cancel control`);
  }
});

test("both redesigned credential tables retain five nonempty column headers", () => {
  const tables = markup.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? [];
  for (const id of ["keys-body", "gw-body"]) {
    const table = tables.find((candidate) => candidate.includes(tagById(id)));
    assert.ok(table, `Missing table containing #${id}`);
    const head = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
    assert.ok(head);
    const headers = Array.from(head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi), (match) => match[1].replace(/<[^>]*>/g, "").trim());
    assert.equal(headers.length, 5, `${id} should use the simplified five-column layout`);
    assert.ok(headers.every(Boolean));
  }
});

test("dirty state tracks revisions independently and updates the save indicator", () => {
  const h = harness();
  const state = h.element("save-state-settings");
  assert.equal(h.ui.isUiDirty("settings"), false);
  h.ui.setUiDirty("settings", false);
  const cleanText = state.textContent;
  h.ui.setUiDirty("settings", true);
  assert.equal(h.ui.isUiDirty("settings"), true);
  assert.equal(h.ui.isUiDirty("routing"), false);
  assert.equal(state.classList.contains("dirty"), true);
  assert.ok(state.textContent.length > 0);
  assert.notEqual(state.textContent, cleanText);
  assert.equal(h.uiRevision.settings, 1);
  h.ui.setUiDirty("settings", true);
  assert.equal(h.uiRevision.settings, 2, "Each edit must invalidate pending responses");
  h.ui.setUiDirty("settings", false);
  assert.equal(h.ui.isUiDirty("settings"), false);
  assert.equal(state.classList.contains("dirty"), false);
  assert.equal(state.textContent, cleanText);
  assert.equal(h.uiRevision.settings, 2, "Saving must not erase edit history");
});

test("dirty state works before an optional save indicator exists", () => {
  const h = harness([], { $: () => null });
  h.ui.setUiDirty("quota", true);
  assert.equal(h.ui.isUiDirty("quota"), true);
  h.ui.setUiDirty("quota", false);
  assert.equal(h.ui.isUiDirty("quota"), false);
});

test("form change tracking separates quota edits and ignores search or unrelated inputs", () => {
  const h = harness(["trackUiChanges"]);
  const change = (section: string | null, id: string, type = "text") => h.ui.trackUiChanges({
    target: { id, type, closest: () => section ? { dataset: { section } } : null }
  });
  for (const name of ["settings", "routing", "system-prompt", "proxy"]) {
    change(name, `${name}-control`);
    assert.equal(h.ui.isUiDirty(name), true);
    h.ui.setUiDirty(name, false);
  }
  change("settings", "quota-buckets-json");
  assert.equal(h.ui.isUiDirty("quota"), true);
  assert.equal(h.ui.isUiDirty("settings"), false);
  change("settings", "model-search", "search");
  change("keys", "new-key");
  change(null, "login-pass");
  assert.equal(h.ui.isUiDirty("settings"), false);
  assert.equal(h.ui.isUiDirty("keys"), false);
});

const saveCases: Array<[string, Record<string, unknown>, string]> = [
  ["/admin/api/settings", { systemPromptText: "" }, "system-prompt"],
  ["/admin/api/settings", { routingStrategy: "fill-first" }, "routing"],
  ["/admin/api/settings", { proxyUrl: "" }, "proxy"],
  ["/admin/api/settings", { cursorSdkSessionMode: "durable", requestTimeoutMs: 120000 }, "settings"],
  ["/admin/api/quota-buckets", { models: {}, default: "other" }, "quota"]
];

test("save targets distinguish independent editors, including empty prompt and proxy values", () => {
  const { ui } = harness();
  for (const [path, body, target] of saveCases) assert.equal(ui.uiSaveTarget(path, body), target);
  for (const path of ["/admin/api/settings", "/admin/api/quota-buckets", "/admin/api/overview"]) {
    assert.equal(ui.uiSaveTarget(path), "");
    assert.equal(ui.uiSaveTarget(path, null), "");
  }
  assert.equal(ui.uiSaveTarget("/admin/api/keys", { label: "credential" }), "");
  assert.equal(ui.uiSaveTarget("/admin/api/settings", { cursorSdkUseHttp1ForAgent: true }), "");
});

for (const [path, body, target] of saveCases) {
  test(`successful ${target} saves clear only the submitted editor`, async () => {
    const h = harness(["api"], { fetch: async () => response({ saved: true }) });
    for (const [, , name] of saveCases) h.ui.setUiDirty(name, true);
    const result = await h.ui.api("POST", path, body);
    assert.deepEqual(result, { saved: true });
    for (const [, , name] of saveCases) assert.equal(h.ui.isUiDirty(name), name !== target, name);
  });

  test(`a delayed ${target} save preserves edits made while saving`, async () => {
    const request = deferred<ReturnType<typeof response>>();
    const h = harness(["api"], { fetch: () => request.promise });
    h.ui.setUiDirty(target, true);
    const save = h.ui.api("POST", path, body);
    h.ui.setUiDirty(target, true);
    request.resolve(response());
    await save;
    assert.equal(h.ui.isUiDirty(target), true);
    assert.equal(h.element(`save-state-${target}`).classList.contains("dirty"), true);
  });
}

test("HTTP errors, expired authentication and network failures preserve unsaved state", async () => {
  for (const status of [400, 401, 500]) {
    let loginCount = 0;
    const h = harness(["api"], {
      fetch: async () => response({ error: { message: "save rejected" } }, status),
      showLogin: () => { loginCount++; }
    });
    h.ui.setUiDirty("settings", true);
    await assert.rejects(h.ui.api("POST", "/admin/api/settings", { cursorSdkSessionMode: "durable", requestTimeoutMs: 120000 }));
    assert.equal(h.ui.isUiDirty("settings"), true);
    assert.equal(loginCount, status === 401 ? 1 : 0);
  }
  const h = harness(["api"], { fetch: async () => { throw new Error("offline"); } });
  h.ui.setUiDirty("settings", true);
  await assert.rejects(h.ui.api("POST", "/admin/api/settings", { cursorSdkSessionMode: "durable" }), /offline/);
  assert.equal(h.ui.isUiDirty("settings"), true);
});

test("read requests and unrelated writes do not clear dirty editors", async () => {
  const h = harness(["api"], { fetch: async () => response() });
  for (const [, , name] of saveCases) h.ui.setUiDirty(name, true);
  await h.ui.api("GET", "/admin/api/settings");
  await h.ui.api("GET", "/admin/api/quota-buckets");
  await h.ui.api("POST", "/admin/api/keys", { label: "new key" });
  for (const [, , name] of saveCases) assert.equal(h.ui.isUiDirty(name), true);
});

const formCases = [
  { name: "settings", fn: "applySettingsForm", id: "request-timeout", config: { requestTimeoutMs: 12345 }, expected: 12345 },
  { name: "routing", fn: "applyRoutingForm", id: "affinity-ttl", config: { sessionAffinityTtlMs: 23456 }, expected: 23456 },
  { name: "system-prompt", fn: "applySysForm", id: "sys-mode", config: { systemPromptMode: "append" }, expected: "append" }
] as const;

for (const item of formCases) {
  test(`${item.name} overview refresh respects dirty and focused forms, but updates clean forms`, () => {
    const h = harness([item.fn], {
      applyHttp1Form() {}, applyPolicyForm() {}, togglePolicyModelsField() {}, applyDebugForm() {}, renderBootEnv() {}
    });
    const input = h.element(item.id);
    input.value = "local draft";
    h.ui.setUiDirty(item.name, true);
    h.ui[item.fn](item.config);
    assert.equal(input.value, "local draft");
    h.ui.setUiDirty(item.name, false);
    h.document.activeElement = { closest: (selector: string) => selector === `#sec-${item.name}` ? {} : null };
    h.ui[item.fn](item.config);
    assert.equal(input.value, "local draft");
    h.document.activeElement = null;
    h.ui[item.fn](item.config);
    assert.equal(input.value, item.expected);
  });
}

test("system prompt hydration skips dirty forms and discards responses overtaken by new edits", async () => {
  const request = deferred<unknown>();
  let calls = 0;
  const h = harness(["hydrateSystemPrompt", "updateSysCount"], {
    api: () => { calls++; return request.promise; }
  });
  h.element("sys-text").value = "unsaved prompt";
  h.ui.setUiDirty("system-prompt", true);
  await h.ui.hydrateSystemPrompt();
  assert.equal(calls, 0);
  h.ui.setUiDirty("system-prompt", false);
  const loading = h.ui.hydrateSystemPrompt();
  assert.equal(calls, 1);
  h.ui.setUiDirty("system-prompt", true);
  h.element("sys-mode").value = "override";
  h.element("sys-text").value = "newer local prompt";
  request.resolve({ mode: "append", text: "stale server prompt" });
  await loading;
  assert.equal(h.element("sys-text").value, "newer local prompt");
  assert.equal(h.element("sys-mode").value, "override");
  assert.equal(h.ui.isUiDirty("system-prompt"), true);
});

test("explicit prompt reload replaces the draft only if no newer edit occurred", async () => {
  for (const editDuringLoad of [false, true]) {
    const request = deferred<unknown>();
    const h = harness(["hydrateSystemPrompt", "updateSysCount"], { api: () => request.promise });
    h.ui.setUiDirty("system-prompt", true);
    h.element("sys-text").value = "old draft";
    const loading = h.ui.hydrateSystemPrompt(true);
    if (editDuringLoad) {
      h.element("sys-text").value = "new draft";
      h.ui.setUiDirty("system-prompt", true);
    }
    request.resolve({ mode: "append", text: "saved prompt" });
    await loading;
    assert.equal(h.element("sys-text").value, editDuringLoad ? "new draft" : "saved prompt");
    assert.equal(h.ui.isUiDirty("system-prompt"), editDuringLoad);
    if (!editDuringLoad) assert.match(h.element("sys-count").textContent, /^12\s*\//);
  }
});

test("quota refresh avoids requests while dirty or focused and populates clean JSON", async () => {
  let calls = 0;
  const table = { models: { "model-b": "other", "model-a": "cursor" }, default: "other" };
  const h = harness(["loadQuotaBuckets"], { api: async () => { calls++; return { table }; } });
  const box = h.element("quota-buckets-json");
  box.value = "draft";
  h.ui.setUiDirty("quota", true);
  h.ui.loadQuotaBuckets();
  assert.equal(calls, 0);
  h.ui.setUiDirty("quota", false);
  h.document.activeElement = box;
  h.ui.loadQuotaBuckets();
  assert.equal(calls, 0);
  h.document.activeElement = null;
  h.ui.loadQuotaBuckets();
  await settleCallbacks();
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(String(box.value)), table);
});

for (const protection of ["dirty", "focused", "newer-saved-revision"] as const) {
  test(`quota refresh discards an in-flight response when the editor is ${protection}`, async () => {
    const request = deferred<unknown>();
    const h = harness(["loadQuotaBuckets"], { api: () => request.promise });
    const box = h.element("quota-buckets-json");
    h.ui.loadQuotaBuckets();
    box.value = "new local quota mapping";
    if (protection === "focused") h.document.activeElement = box;
    else {
      h.ui.setUiDirty("quota", true);
      if (protection === "newer-saved-revision") h.ui.setUiDirty("quota", false);
    }
    request.resolve({ table: { models: {}, default: "other" } });
    await settleCallbacks();
    assert.equal(box.value, "new local quota mapping");
  });
}

test("proxy status refresh leaves a locally edited proxy URL untouched", async () => {
  const request = deferred<unknown>();
  const h = harness(["loadProxy", "renderProxy"], {
    api: () => request.promise,
    cfgItem: () => ""
  });
  // This renderer also looks up an optional dynamically-created button.
  h.context.$ = (id: string) => id === "btn-enable-http1" ? null : h.element(id);
  const loading = h.ui.loadProxy();
  h.ui.setUiDirty("proxy", true);
  h.element("proxy-url").value = "http://new-local-proxy:7890";
  request.resolve({ enabled: false, applied: false, modelTrafficProxied: false });
  await loading;
  assert.equal(h.element("proxy-url").value, "http://new-local-proxy:7890");
  assert.equal(h.ui.isUiDirty("proxy"), true);
  assert.ok(h.element("proxy-status").innerHTML.length > 0);
});

test("proxy HTTP/1.1 quick action does not mark an unrelated settings draft as saved", async () => {
  let click: (() => void) | undefined;
  const button = { addEventListener: (event: string, listener: () => void) => { if (event === "click") click = listener; } };
  const h = harness(["api", "renderProxy"], {
    fetch: async () => response(), cfgItem: () => "", esc: String,
    toast() {}, loadAll() {}, loadProxy() {}
  });
  h.context.$ = (id: string) => id === "btn-enable-http1" ? button : h.element(id);
  h.ui.setUiDirty("settings", true);
  h.ui.renderProxy({ enabled: true, applied: true, modelTrafficProxied: false });
  assert.ok(click, "The proxy warning should offer its HTTP/1.1 quick action");
  click();
  await settleCallbacks();
  assert.equal(h.ui.isUiDirty("settings"), true, "Saving only HTTP/1.1 must not clear other unsaved settings");
});

test("opening a credential disclosure expands it and focuses its first input", () => {
  let focused = false;
  let scrolled = false;
  const form = {
    open: false,
    scrollIntoView: () => { scrolled = true; },
    querySelector: (selector: string) => selector === "input" ? { focus: () => { focused = true; } } : null
  };
  const { ui } = harness(["openUiForm"], { $: () => form });
  ui.openUiForm("add-key-form");
  assert.equal(form.open, true);
  assert.equal(scrolled, true);
  assert.equal(focused, true);
});
