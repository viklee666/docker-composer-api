import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorApiKey, defaultApiKeyName, normalizeSessionToken } from "../src/cursor-account.js";
import { ApiError } from "../src/errors.js";

const SESSION_TOKEN = "user_01ABCDEF::eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln";
const CREATE_API_KEY_URL = "https://cursor.com/api/dashboard/create-user-api-key";

type FetchCall = Parameters<typeof fetch>;

/** 记录调用参数的假 fetch：既断言请求形状，也避免测试真的打到 cursor.com。 */
function recordingFetch(calls: FetchCall[], respond: () => Response): typeof fetch {
  return async (...args: FetchCall) => {
    calls.push(args);
    return respond();
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("normalizeSessionToken accepts every shape users paste from the browser", () => {
  assert.equal(normalizeSessionToken(SESSION_TOKEN), SESSION_TOKEN);
  assert.equal(normalizeSessionToken(`WorkosCursorSessionToken=${SESSION_TOKEN}`), SESSION_TOKEN);
  assert.equal(normalizeSessionToken(`  "WorkosCursorSessionToken=${SESSION_TOKEN};"  `), SESSION_TOKEN);
  assert.equal(normalizeSessionToken(`'${SESSION_TOKEN}';`), SESSION_TOKEN);
  assert.equal(normalizeSessionToken(SESSION_TOKEN.replace("::", "%3A%3A")), SESSION_TOKEN);
  assert.equal(
    normalizeSessionToken(`NEXT_LOCALE=en; WorkosCursorSessionToken=${SESSION_TOKEN}; ph_phc=1`),
    SESSION_TOKEN
  );
});

test("normalizeSessionToken rejects empty and malformed input", () => {
  for (const bad of ["", "   ", "not-a-token", "WorkosCursorSessionToken=", "eyJhbGciOiJIUzI1NiJ9.x.y"]) {
    assert.throws(
      () => normalizeSessionToken(bad),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 400 &&
        error.code === "invalid_request_error" &&
        error.param === "sessionToken",
      bad
    );
  }
});

test("normalizeSessionToken never echoes the credential it rejected", () => {
  assert.throws(
    () => normalizeSessionToken("user_01SECRETVALUE::"),
    (error) => error instanceof ApiError && !error.message.includes("SECRETVALUE")
  );
});

test("defaultApiKeyName stays dashboard-safe, sortable, and unique within one second", () => {
  // 同一个 Date 反复取名，模拟同一秒内连续铸钥——秒级时间戳时代这里会全撞在一起。
  const names = Array.from({ length: 50 }, () => defaultApiKeyName(new Date("2026-08-27T15:44:09.123Z")));

  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9._ -]+$/, `${name} must satisfy NAME_PATTERN`);
    assert.ok(name.length <= 64, `${name} must fit MAX_NAME_LENGTH`);
    assert.ok(name.includes("20260827"), `${name} must keep the UTC date so the dashboard list stays sortable`);
  }
  assert.equal(new Set(names).size, names.length, "two keys minted in the same second must not share a name");
});

test("createCursorApiKey posts the dashboard request and returns the minted key", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = recordingFetch(calls, () => jsonResponse({ apiKey: "crsr_minted_key" }));

  const minted = await createCursorApiKey(
    { sessionToken: `WorkosCursorSessionToken=${SESSION_TOKEN};`, name: "pool-key" },
    { fetchImpl }
  );

  assert.deepEqual(minted, { apiKey: "crsr_minted_key", name: "pool-key" });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(String(url), CREATE_API_KEY_URL);
  assert.equal(init?.method, "POST");
  assert.equal(init?.body, '{"name":"pool-key"}');
  assert.ok(init?.signal, "a timeout signal must be attached so a hung upstream cannot wedge the admin panel");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("origin"), "https://cursor.com");
  assert.equal(headers.get("referer"), "https://cursor.com/dashboard/api?section=user-keys");
  assert.match(headers.get("user-agent") ?? "", /Mozilla\/5\.0/);
  assert.equal(headers.get("cookie"), `WorkosCursorSessionToken=${SESSION_TOKEN}`);
});

test("createCursorApiKey falls back to the generated name when none is given", async () => {
  const calls: FetchCall[] = [];
  const minted = await createCursorApiKey(
    { sessionToken: SESSION_TOKEN },
    { fetchImpl: recordingFetch(calls, () => jsonResponse({ apiKey: "crsr_auto" })) }
  );

  assert.match(minted.name, /^gateway-\d{8}-\d{6}-[0-9a-f]{12}$/);
  assert.equal(calls[0][1]?.body, JSON.stringify({ name: minted.name }));
});

test("createCursorApiKey rejects names that would break the dashboard", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = recordingFetch(calls, () => jsonResponse({ apiKey: "crsr_unused" }));
  for (const name of ["   ", "bad/name", 'quote"name', "x".repeat(65)]) {
    await assert.rejects(
      () => createCursorApiKey({ sessionToken: SESSION_TOKEN, name }, { fetchImpl }),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 400 &&
        error.code === "invalid_request_error" &&
        error.param === "name",
      name
    );
  }
  assert.equal(calls.length, 0, "name validation must happen before touching the network");
});

test("createCursorApiKey maps 401 and 403 to an expired-session error", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      () =>
        createCursorApiKey(
          { sessionToken: SESSION_TOKEN },
          { fetchImpl: async () => jsonResponse({ error: "unauthorized" }, status) }
        ),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 401 &&
        error.code === "unauthorized" &&
        error.param === "sessionToken" &&
        error.message === "Cursor session token 无效或已过期，请重新从浏览器复制。",
      String(status)
    );
  }
});

test("createCursorApiKey maps 429 to a rate limit error", async () => {
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        { fetchImpl: async () => new Response("slow down", { status: 429 }) }
      ),
    (error) => error instanceof ApiError && error.statusCode === 429 && error.code === "rate_limit_exceeded"
  );
});

test("createCursorApiKey maps other non-2xx to 502 with a truncated body snippet", async () => {
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        { fetchImpl: async () => new Response(`<html>${"boom ".repeat(200)}</html>`, { status: 500 }) }
      ),
    (error) =>
      error instanceof ApiError &&
      error.statusCode === 502 &&
      error.code === "upstream_error" &&
      error.message.includes("500") &&
      error.message.endsWith("…") &&
      error.message.length < 360
  );
});

test("createCursorApiKey never lets a failed mint echo the key it just minted", async () => {
  // 上游把刚铸好的 key 连同一个 5xx 一起返回是完全可能的（后台接口本来就是这么组织响应体的）。
  // 这条错误会经管理 API 回到浏览器弹窗并落进日志，整把 key 绝不能出现在里面。
  const minted = "crsr_live_9f2c4d6a8b0e2f4a6c8e0b2d";
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        { fetchImpl: async () => jsonResponse({ apiKey: minted, error: "internal" }, 500) }
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 502);
      assert.ok(!error.message.includes(minted), `错误信息里带着完整的 key：${error.message}`);
      assert.ok(!error.message.includes(minted.slice(0, 12)), `回显的前缀长到能拼回 key：${error.message}`);
      // 诊断价值要留住：状态码、字段名、上游的错误串都还在，
      // 「上游返回了错误串」与「上游换了响应结构」仍然分得开。
      assert.ok(error.message.includes("500"));
      assert.ok(error.message.includes("apiKey"));
      assert.ok(error.message.includes("internal"));
      return true;
    }
  );
});

test("createCursorApiKey redacts key-shaped and session-shaped material in any body", async () => {
  const key = "crsr_live_abcdef1234567890";
  // 非 JSON 分支（HTML 错误页里裸奔的 key）走的是另一条错误路径，同样得挡住。
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        { fetchImpl: async () => new Response(`<html>your new key: ${key}</html>`, { status: 200 }) }
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 502);
      assert.ok(!error.message.includes(key), `错误信息里带着 key：${error.message}`);
      assert.ok(error.message.includes("非 JSON"));
      return true;
    }
  );

  // session token 比 key 权限还大，即使上游把它回显在正文里也不能带出去。
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        { fetchImpl: async () => new Response(`session ${SESSION_TOKEN} expired`, { status: 500 }) }
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.ok(!error.message.includes(SESSION_TOKEN), `错误信息里带着 session token：${error.message}`);
      assert.ok(error.message.includes("500"));
      return true;
    }
  );
});

test("createCursorApiKey treats a 2xx without an apiKey as an upstream error", async () => {
  for (const body of [{}, { apiKey: "" }, { apiKey: 42 }]) {
    await assert.rejects(
      () => createCursorApiKey({ sessionToken: SESSION_TOKEN }, { fetchImpl: async () => jsonResponse(body) }),
      (error) => error instanceof ApiError && error.statusCode === 502 && error.code === "upstream_error",
      JSON.stringify(body)
    );
  }
});

test("createCursorApiKey accepts both documented Cursor key prefixes", async () => {
  for (const apiKey of ["crsr_real_shape", "key_placeholder_shape"]) {
    const minted = await createCursorApiKey(
      { sessionToken: SESSION_TOKEN },
      { fetchImpl: async () => jsonResponse({ apiKey }) }
    );
    assert.equal(minted.apiKey, apiKey);
  }
});

test("createCursorApiKey rejects a 2xx whose apiKey does not look like a Cursor key", async () => {
  for (const apiKey of ["abc123", "sk-live-xyz", "crsr-missing-underscore"]) {
    await assert.rejects(
      () => createCursorApiKey({ sessionToken: SESSION_TOKEN }, { fetchImpl: async () => jsonResponse({ apiKey }) }),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 502 &&
        error.code === "upstream_error" &&
        error.message.includes("接口可能已变更") &&
        // 前缀要能看见，好判断上游换成了什么；但完整值绝不能进错误信息——它可能就是把新格式的真 key。
        error.message.includes(apiKey.slice(0, 4)) &&
        !error.message.includes(apiKey),
      apiKey
    );
  }
});

test("createCursorApiKey maps aborts to 504 and other transport failures to 502", async () => {
  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        {
          fetchImpl: async () => {
            throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
          }
        }
      ),
    (error) => error instanceof ApiError && error.statusCode === 504 && error.code === "upstream_timeout"
  );

  await assert.rejects(
    () =>
      createCursorApiKey(
        { sessionToken: SESSION_TOKEN },
        {
          fetchImpl: async () => {
            throw new Error("fetch failed while using crsr_transport_secret_abcdef123456");
          }
        }
      ),
    (error) =>
      error instanceof ApiError &&
      error.statusCode === 502 &&
      error.code === "upstream_error" &&
      !error.message.includes("crsr_transport_secret_abcdef123456") &&
      error.message.includes("fetch failed")
  );
});
