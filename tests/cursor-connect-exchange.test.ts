import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import {
  EXCHANGE_USER_API_KEY_PATH,
  exchangeUrl,
  exchangeUserApiKey
} from "../src/cursor-connect/api-key-exchange.js";

const API_KEY = "crsr_supersecret_exchange_key_value";
const SESSION = jwt({ type: "session", sub: "acct" });
const WEB = jwt({ type: "web", sub: "acct" });

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function fetchJson(status: number, body: unknown, captured: Array<Record<string, string>> = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    captured.push({
      url,
      method: String(init?.method ?? ""),
      authorization: String(headers?.authorization ?? ""),
      contentType: String(headers?.["content-type"] ?? headers?.["Content-Type"] ?? ""),
      redirect: String(init?.redirect ?? ""),
      headerKeys: Object.keys(headers ?? {}).sort().join(","),
      body: String(init?.body ?? "")
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  };
}

test("exchange posts Bearer api key to /auth/exchange_user_api_key with empty JSON body", async () => {
  const captured: Array<Record<string, string>> = [];
  const tokens = await exchangeUserApiKey({
    apiKey: API_KEY,
    baseUrl: "https://api2.cursor.sh/",
    fetchImpl: fetchJson(200, { accessToken: SESSION, refreshToken: "refresh-one" }, captured)
  });
  assert.equal(tokens.accessToken, SESSION);
  assert.equal(tokens.refreshToken, "refresh-one");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://api2.cursor.sh/auth/exchange_user_api_key");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].authorization, `Bearer ${API_KEY}`);
  assert.equal(captured[0].contentType, "application/json");
  assert.equal(captured[0].redirect, "manual");
  assert.equal(captured[0].headerKeys, "authorization,content-type");
  assert.equal(captured[0].body, "{}");
});

test("exchangeUrl strips trailing slashes", () => {
  assert.equal(exchangeUrl("https://api2.cursor.sh/"), `https://api2.cursor.sh${EXCHANGE_USER_API_KEY_PATH}`);
});

test("exchange refuses a web token even if the HTTP call succeeded", async () => {
  await assert.rejects(
    () =>
      exchangeUserApiKey({
        apiKey: API_KEY,
        fetchImpl: fetchJson(200, { accessToken: WEB, refreshToken: "refresh-one" })
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.statusCode === 502 &&
      /web token/.test(error.message) &&
      !error.message.includes(WEB)
  );
});

test("exchange requires both accessToken and refreshToken", async () => {
  for (const body of [{ accessToken: SESSION }, { accessToken: SESSION, refreshToken: "" }, { accessToken: SESSION, refreshToken: null }]) {
    await assert.rejects(
      () => exchangeUserApiKey({ apiKey: API_KEY, fetchImpl: fetchJson(200, body) }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 502 && /accessToken/.test(error.message)
    );
  }
});

test("exchange maps 403 without leaking the api key or tokens", async () => {
  await assert.rejects(
    () =>
      exchangeUserApiKey({
        apiKey: API_KEY,
        fetchImpl: fetchJson(403, { error: "nope", accessToken: SESSION, apiKey: API_KEY })
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 403);
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
      assert.doesNotMatch(error.message, new RegExp(SESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /没有兑换权限|无效/);
      return true;
    }
  );
});

test("exchange treats a 302 login redirect as a refused key, not a token", async () => {
  await assert.rejects(
    () =>
      exchangeUserApiKey({
        apiKey: API_KEY,
        fetchImpl: fetchJson(302, "<html>login</html>")
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 403
  );
});

test("exchange maps MDM sign_in_policy_violation to 403", async () => {
  await assert.rejects(
    () =>
      exchangeUserApiKey({
        apiKey: API_KEY,
        fetchImpl: fetchJson(403, { error: "sign_in_policy_violation" })
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 403 && /登录策略/.test(error.message)
  );
});

test("exchange redacts secrets in non-2xx JSON snippets", async () => {
  await assert.rejects(
    () =>
      exchangeUserApiKey({
        apiKey: API_KEY,
        fetchImpl: fetchJson(500, { accessToken: SESSION, detail: API_KEY })
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 502);
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
      assert.doesNotMatch(error.message, new RegExp(SESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(error.message.includes(API_KEY.slice(0, 12)), false);
      assert.match(error.message, /500/);
      return true;
    }
  );
});
