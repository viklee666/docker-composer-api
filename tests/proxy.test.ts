import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { getGlobalDispatcher, request as undiciRequest } from "undici";
import { ADMIN_HTML } from "../src/admin-ui.js";
import { ApiError } from "../src/errors.js";
import { ExecutorWarmPool } from "../src/executor-warmup.js";
import { CursorKeyPool } from "../src/key-pool.js";
import { KeyRotatingRunner } from "../src/key-rotating-runner.js";
import { applyProxyConfig, maskProxyUrl, parseProxyUrl, proxyStatus, testProxy } from "../src/proxy.js";
import {
  clearCursorSdkUseHttp1ForAgent,
  loadCursorSdkUseHttp1ForAgent,
  saveCursorSdkUseHttp1ForAgent
} from "../src/sdk-network.js";
import { createApp } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import type { CursorRunResult, CursorRunner, CursorStreamEvent, GatewayConfig, StateStore } from "../src/types.js";

/** 只实现 getSetting/setSetting 的极简 store：三态解析只关心「行在不在」。 */
function settingsStore(initial: Record<string, string> = {}): StateStore {
  const rows = new Map(Object.entries(initial));
  return {
    getSetting: async (key: string) => rows.get(key),
    setSetting: async (key: string, value: string) => {
      rows.set(key, value);
    }
  } as unknown as StateStore;
}

test("parseProxyUrl 认得全部支持的协议并补齐默认端口", () => {
  assert.deepEqual(parseProxyUrl("http://127.0.0.1:7890"), {
    url: "http://127.0.0.1:7890",
    scheme: "http",
    host: "127.0.0.1",
    port: 7890,
    hasAuth: false
  });
  assert.deepEqual(parseProxyUrl("https://proxy.example.com"), {
    url: "https://proxy.example.com:443",
    scheme: "https",
    host: "proxy.example.com",
    port: 443,
    hasAuth: false
  });
  assert.equal(parseProxyUrl("socks5://127.0.0.1:7891").scheme, "socks5");
  assert.equal(parseProxyUrl("socks5h://127.0.0.1:7891").scheme, "socks5h");
  assert.equal(parseProxyUrl("socks4://127.0.0.1:1080").scheme, "socks4");
  // socks:// 是 socks5 的常见简写，端口缺省按 RFC 1928 取 1080。
  assert.deepEqual(parseProxyUrl("socks://127.0.0.1"), {
    url: "socks5://127.0.0.1:1080",
    scheme: "socks5",
    host: "127.0.0.1",
    port: 1080,
    hasAuth: false
  });
});

test("parseProxyUrl 给漏写协议的 host:port 补上 http://", () => {
  assert.deepEqual(parseProxyUrl("127.0.0.1:7890"), {
    url: "http://127.0.0.1:7890",
    scheme: "http",
    host: "127.0.0.1",
    port: 7890,
    hasAuth: false
  });
  // 默认端口会被 WHATWG URL 吞掉，规范化结果必须仍然显式带上端口。
  assert.equal(parseProxyUrl("proxy.example.com:80").url, "http://proxy.example.com:80");
});

test("parseProxyUrl 保留 user:pass 凭据并置上 hasAuth", () => {
  const parsed = parseProxyUrl("socks5h://alice:s3cret@127.0.0.1:7891");
  assert.equal(parsed.url, "socks5h://alice:s3cret@127.0.0.1:7891");
  assert.equal(parsed.hasAuth, true);
  assert.equal(parsed.host, "127.0.0.1");
  // 只有用户名没有密码同样算带凭据。
  assert.equal(parseProxyUrl("http://alice@127.0.0.1:7890").hasAuth, true);
  assert.equal(parseProxyUrl("http://127.0.0.1:7890").hasAuth, false);
});

test("parseProxyUrl 拒绝非法协议 / 缺主机 / 坏端口", () => {
  for (const bad of ["ftp://127.0.0.1:21", "ws://127.0.0.1:80"]) {
    assert.throws(() => parseProxyUrl(bad), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_request_error");
      assert.equal(error.param, "proxyUrl");
      assert.match(error.message, /不支持的代理协议/);
      return true;
    });
  }
  for (const bad of ["http://", "http://:7890", ""]) {
    assert.throws(() => parseProxyUrl(bad), ApiError);
  }
  for (const bad of ["http://127.0.0.1:0", "http://127.0.0.1:70000", "http://127.0.0.1:abc", "127.0.0.1:99999"]) {
    assert.throws(() => parseProxyUrl(bad), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /代理端口/);
      return true;
    });
  }
});

test("maskProxyUrl 遮住用户名和密码但保留主机端口", () => {
  assert.equal(maskProxyUrl("http://alice:s3cret@127.0.0.1:7890"), "http://***:***@127.0.0.1:7890");
  assert.equal(maskProxyUrl("socks5h://alice@10.0.0.2:1080"), "socks5h://***@10.0.0.2:1080");
  // 漏写协议时同样不能把凭据漏出去。
  assert.equal(maskProxyUrl("alice:s3cret@127.0.0.1:7890"), "***:***@127.0.0.1:7890");
  // 没有凭据的地址原样透传，后台要能看清代理指向哪里。
  assert.equal(maskProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(maskProxyUrl("socks5://127.0.0.1:7891"), "socks5://127.0.0.1:7891");
});

test("maskProxyUrl 按最后一个 @ 切分，畸形地址整条遮掉", () => {
  // 密码里带没转义的 @ 是常见写法。按**第一个** @ 切会把 `ss@127.0.0.1:7890` 当成主机名，
  // 密码的后半截原样回显——这里必须仍然只剩掩码与主机端口。
  assert.equal(maskProxyUrl("http://alice:p@ss@127.0.0.1:7890"), "http://***:***@127.0.0.1:7890");
  assert.equal(maskProxyUrl("socks5h://alice:s3cret@x@10.0.0.2:1080"), "socks5h://***:***@10.0.0.2:1080");

  // 主机名都认不出来的输入没有可信的凭据边界，只能整条当敏感处理。
  for (const raw of ["http://alice:@s3cret@bad host", "http://alice:s3cret@bad host", "s3cret@@@"]) {
    const masked = maskProxyUrl(raw);
    assert.doesNotMatch(masked, /s3cret/, `${raw} 掩码后仍然带着密码：${masked}`);
    assert.equal(masked, "***");
  }
});

test("代理地址解析失败时错误信息里不会残留密码", () => {
  // 这条错误会经管理 API 回到浏览器并落进日志，是密码最容易泄漏的一条路。
  assert.throws(
    () => parseProxyUrl("http://alice:@s3cret@bad host"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 400);
      assert.doesNotMatch(error.message, /s3cret/, `错误信息泄漏了密码：${error.message}`);
      return true;
    }
  );
});

test("未经验证的 authority 不会把冒号后的秘密或编码秘密带进输出", () => {
  for (const [raw, secret] of [
    ["http://alice:s3cret", "s3cret"],
    ["http://user%3Asecret%40host", "secret"]
  ] as const) {
    const masked = maskProxyUrl(raw);
    assert.doesNotMatch(masked, new RegExp(secret), `${raw} 的掩码输出泄漏了秘密：${masked}`);
    assert.throws(
      () => parseProxyUrl(raw),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.doesNotMatch(error.message, new RegExp(secret), `${raw} 的解析错误泄漏了秘密：${error.message}`);
        return true;
      }
    );
  }
});

test("applyProxyConfig 装上再卸下后 globalAgent 恢复成原来那两个对象", (t) => {
  const originalHttp = http.globalAgent;
  const originalHttps = https.globalAgent;
  const originalEnv = process.env.HTTPS_PROXY;
  t.after(() => {
    applyProxyConfig(undefined);
  });

  const enabled = applyProxyConfig("socks5://127.0.0.1:7891");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.applied, true);
  assert.equal(enabled.scheme, "socks5");
  assert.equal(enabled.url, "socks5://127.0.0.1:7891");
  // SOCKS 一个 agent 同时服务 http 与 https，两个 globalAgent 都会被换掉。
  assert.notEqual(http.globalAgent, originalHttp);
  assert.notEqual(https.globalAgent, originalHttps);
  assert.equal(process.env.HTTPS_PROXY, "socks5://127.0.0.1:7891");
  assert.equal(process.env.ALL_PROXY, "socks5://127.0.0.1:7891");

  const disabled = applyProxyConfig(undefined);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.applied, false);
  assert.equal(disabled.url, undefined);
  assert.equal(disabled.scheme, undefined);
  assert.deepEqual(disabled.warnings, []);
  assert.equal(http.globalAgent, originalHttp);
  assert.equal(https.globalAgent, originalHttps);
  assert.equal(process.env.HTTPS_PROXY, originalEnv);
});

test("applyProxyConfig 对同一个地址是幂等的，不重建 agent", (t) => {
  t.after(() => {
    applyProxyConfig(undefined);
  });
  applyProxyConfig("http://127.0.0.1:7890");
  const installed = https.globalAgent;
  applyProxyConfig("http://127.0.0.1:7890");
  assert.equal(https.globalAgent, installed);
  // 空串等价于「恢复直连」，不该抛错。
  assert.equal(applyProxyConfig("").enabled, false);
});

test("http 代理只接管 https.globalAgent，http.globalAgent 留在原样", (t) => {
  const originalHttp = http.globalAgent;
  t.after(() => {
    applyProxyConfig(undefined);
  });
  applyProxyConfig("http://127.0.0.1:7890");
  // Cursor 的上游全是 https，明文 http 那条路不需要代理，也就不引 http-proxy-agent。
  assert.equal(http.globalAgent, originalHttp);
  assert.notEqual(https.globalAgent, originalHttp);
});

test("proxyStatus 在 HTTP/1.1 被显式关掉时告警，并把 modelTrafficProxied 置 false", (t) => {
  t.after(() => {
    applyProxyConfig(undefined);
  });

  // 配了代理时 HTTP/1.1 默认是开的，走到这里只可能是运维显式关掉了它——
  // 那就必须继续告警：模型流量还在直连，而这在墙内等于完全不可用。
  const withoutHttp1 = applyProxyConfig("http://127.0.0.1:7890", { useHttp1ForAgent: false });
  assert.equal(withoutHttp1.modelTrafficProxied, false);
  assert.equal(withoutHttp1.warnings.length, 1);
  assert.match(withoutHttp1.warnings[0] ?? "", /HTTP\/1\.1/);

  const withHttp1 = proxyStatus({ useHttp1ForAgent: true });
  assert.equal(withHttp1.enabled, true);
  assert.equal(withHttp1.modelTrafficProxied, true);
  assert.deepEqual(withHttp1.warnings, []);

  // 没配代理时既不告警，也不会声称模型流量走了代理。
  applyProxyConfig(undefined);
  const off = proxyStatus({ useHttp1ForAgent: true });
  assert.equal(off.enabled, false);
  assert.equal(off.modelTrafficProxied, false);
  assert.deepEqual(off.warnings, []);
});

test("socks4 / socks5 的告警说的是 DNS 与地址族，不再声称 fetch 退回直连", (t) => {
  t.after(() => {
    applyProxyConfig(undefined);
  });

  // 自定义 undici connector 之后 socks4 两条链路都被代理覆盖，
  // 原来那句「undici 不支持 SOCKS4，这部分会退回直连」已经是假话，必须消失。
  const socks4 = applyProxyConfig("socks4://127.0.0.1:1080", { useHttp1ForAgent: true });
  assert.equal(socks4.warnings.length, 1);
  assert.match(socks4.warnings[0] ?? "", /SOCKS4/);
  assert.match(socks4.warnings[0] ?? "", /IPv4/);
  assert.doesNotMatch(socks4.warnings[0] ?? "", /直连|undici/);

  // 本机解析域名这件事在 socks5 上依然成立（而且现在两条链路都这样），告警要留着。
  const socks5 = applyProxyConfig("socks5://127.0.0.1:7891", { useHttp1ForAgent: true });
  assert.equal(socks5.warnings.length, 1);
  assert.match(socks5.warnings[0] ?? "", /socks5h/);

  // socks5h 语义正确，不该再唠叨 DNS。
  assert.deepEqual(applyProxyConfig("socks5h://127.0.0.1:7891", { useHttp1ForAgent: true }).warnings, []);
});

test("socks4 也会换掉全局 dispatcher，fetch 路径不再绕过代理", (t) => {
  const original = getGlobalDispatcher();
  t.after(() => {
    applyProxyConfig(undefined);
  });
  applyProxyConfig("socks4://127.0.0.1:1080", { useHttp1ForAgent: true });
  // 改之前这里是 undefined → 装回原 dispatcher，模型列表 / 用量 / 铸钥全部直连。
  assert.notEqual(getGlobalDispatcher(), original);
  applyProxyConfig(undefined);
  assert.equal(getGlobalDispatcher(), original);
});

test("生产 SOCKS connector 使用配置的握手截止时间", async (t) => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    applyProxyConfig(undefined);
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  applyProxyConfig(`socks5://127.0.0.1:${port}`, { timeoutMs: 50 });
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      undiciRequest("http://example.test/", {
        dispatcher: getGlobalDispatcher(),
        signal: AbortSignal.timeout(500)
      }),
    (error: unknown) => {
      return error instanceof Error && error.message.includes("Proxy connection timed out");
    }
  );
  assert.ok(Date.now() - startedAt < 300, "SOCKS 握手不能等到请求 signal 才失败");
  assert.equal(sockets.length, 1);
  sockets.forEach((socket) => socket.destroy());
  sockets.length = 0;

  applyProxyConfig(`socks5://127.0.0.1:${port}`, { timeoutMs: 5_000 });
  const abortedAt = Date.now();
  await assert.rejects(() =>
    undiciRequest("http://example.test/", {
      dispatcher: getGlobalDispatcher(),
      signal: AbortSignal.timeout(50)
    })
  );
  assert.ok(Date.now() - abortedAt < 300, "请求取消时必须立即拆掉 SOCKS 握手");
  sockets.forEach((socket) => socket.destroy());
});

test("socks4 下两条链路各自握手到代理，且目标域名在本机解析成 IPv4", async (t) => {
  const handshakes: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      handshakes.push(chunk);
      socket.destroy();
    });
  });
  const port = await listen(server, t);

  // 两条链路打不同的目标端口，握手才认得出是谁发的。
  // 只数「有没有握手」是不够的：模型那条走的是原生 SocksProxyAgent，它自己就能凑够计数，
  // undici 那侧的自定义 connector 整个失灵也照样过。
  // 目标写成字面量 IP：这条用例要验的是「有没有走 SOCKS4」，不该顺带依赖 DNS 和外网。
  const result = await testProxy(`socks4://127.0.0.1:${port}`, {
    targetUrl: "https://127.0.0.1:9/",
    modelTargetUrl: "https://127.0.0.1:19/",
    timeoutMs: 3_000
  });

  assert.equal(result.ok, false);
  assert.equal(handshakes.length, 2, "两条链路应当各自向 SOCKS4 代理发起一次连接");
  for (const chunk of handshakes) {
    // SOCKS4 CONNECT：VN=4, CD=1, 然后是 2 字节端口与 4 字节 IPv4。
    assert.equal(chunk[0], 0x04);
    assert.equal(chunk[1], 0x01);
    assert.deepEqual([...chunk.subarray(4, 8)], [127, 0, 0, 1]);
  }
  const ports = handshakes.map((chunk) => chunk.readUInt16BE(2));
  assert.ok(ports.includes(9), "REST（undici 自定义 connector）那条没有走 SOCKS4");
  assert.ok(ports.includes(19), "模型（原生代理 agent）那条没有走 SOCKS4");
});

test("socks5 隧道打通时两条链路都拿到上游的真实状态码", async (t) => {
  const records: SocksRecord[] = [];
  const origin = await startOriginServer(t);
  const proxyPort = await startSocks5Proxy(t, { records });

  const result = await testProxy(`socks5://127.0.0.1:${proxyPort}`, {
    targetUrl: `http://127.0.0.1:${origin}/rest`,
    modelTargetUrl: `http://127.0.0.1:${origin}/model`,
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true, `隧道应当打通：${result.error ?? ""}`);
  assert.equal(result.rest.status, 204);
  assert.equal(result.model.status, 204);
  // 两条链路各建各的隧道，谁都不能借另一条的光。
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.port).sort(), [origin, origin]);
});

test("socks5 由本机解析域名，socks5h 把域名整个交给代理", async (t) => {
  const localResolved: SocksRecord[] = [];
  const localPort = await startSocks5Proxy(t, { records: localResolved });
  const origin = await startOriginServer(t);

  await testProxy(`socks5://127.0.0.1:${localPort}`, {
    targetUrl: `http://localhost:${origin}/rest`,
    modelTargetUrl: `http://localhost:${origin}/model`,
    timeoutMs: 5_000
  });
  assert.equal(localResolved.length, 2);
  for (const record of localResolved) {
    // ATYP=1/4 都算「已经是地址」；具体是 v4 还是 v6 取决于本机 DNS，不该由用例钉死。
    assert.notEqual(record.atyp, 0x03, "socks5 不该把域名原样交给代理");
    assert.ok(net.isIP(record.host) > 0, `代理收到的应当是地址而不是域名：${record.host}`);
  }

  const remoteResolved: SocksRecord[] = [];
  const remotePort = await startSocks5Proxy(t, { records: remoteResolved });
  await testProxy(`socks5h://127.0.0.1:${remotePort}`, {
    targetUrl: `http://localhost:${origin}/rest`,
    modelTargetUrl: `http://localhost:${origin}/model`,
    timeoutMs: 5_000
  });
  assert.equal(remoteResolved.length, 2);
  for (const record of remoteResolved) {
    assert.equal(record.atyp, 0x03, "socks5h 的全部意义就是域名交给代理解析");
    assert.equal(record.host, "localhost");
  }
});

test("socks5 用户名/密码认证在两条链路上都会被带上", async (t) => {
  const records: SocksRecord[] = [];
  const origin = await startOriginServer(t);
  const proxyPort = await startSocks5Proxy(t, { records, auth: { username: "alice", password: "s3cret" } });

  const result = await testProxy(`socks5://alice:s3cret@127.0.0.1:${proxyPort}`, {
    targetUrl: `http://127.0.0.1:${origin}/rest`,
    modelTargetUrl: `http://127.0.0.1:${origin}/model`,
    timeoutMs: 5_000
  });

  assert.equal(result.ok, true, `带凭据的隧道应当打通：${result.error ?? ""}`);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.username, "alice");
    assert.equal(record.password, "s3cret");
  }
});

test("https 目标经 SOCKS 隧道必须真的做 TLS 升级", async (t) => {
  const records: SocksRecord[] = [];
  const origin = await startOriginServer(t);
  const proxyPort = await startSocks5Proxy(t, { records });

  // 目标是明文 HTTP 端点却按 https 去打：隧道能建，TLS 握手必然失败。
  // 这条用例守的是「connector 不会把裸 socket 当成加密连接交回去」——
  // 真出这种问题的话，流量会在毫无提示的情况下明文发出去。
  const result = await testProxy(`socks5://127.0.0.1:${proxyPort}`, {
    targetUrl: `https://127.0.0.1:${origin}/rest`,
    modelTargetUrl: `https://127.0.0.1:${origin}/model`,
    timeoutMs: 5_000
  });

  assert.equal(result.ok, false);
  assert.equal(result.rest.ok, false);
  assert.equal(records.length, 2, "失败应当发生在 TLS 阶段，隧道本身要先建起来");
  assert.doesNotMatch(result.rest.error ?? "", /ECONNREFUSED/);
});

test("代理自己回绝 CONNECT 时模型探测必须报不通", async (t) => {
  // https-proxy-agent 遇到非 200 的 CONNECT 响应不会抛错，而是把代理那条响应回放给 http 客户端。
  // 于是「密码写错」会表现成一个漂亮的 HTTP 407，探测报绿灯，而模型流量一个字节都过不去。
  const server = http.createServer();
  server.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\nContent-Length: 0\r\n\r\n");
    socket.end();
  });
  const port = await listen(server, t);

  const result = await testProxy(`http://127.0.0.1:${port}`, {
    targetUrl: "https://127.0.0.1:9/",
    modelTargetUrl: "https://127.0.0.1:9/",
    timeoutMs: 3_000
  });

  assert.equal(result.model.ok, false, "代理回绝了 CONNECT，隧道根本不存在，不能报成通");
  assert.match(result.model.error ?? "", /407/);
  assert.equal(result.model.status, undefined);
  assert.equal(result.ok, false);
});

test("换代理时只拆空闲连接，在途连接留给它自己收尾", async (t) => {
  const idle = await connectedSocketPair(t);
  const active = await connectedSocketPair(t);
  t.after(() => {
    applyProxyConfig(undefined);
  });

  applyProxyConfig("http://127.0.0.1:7890", { useHttp1ForAgent: true });
  const agent = https.globalAgent;
  // 直接按 http.Agent 的簿记结构塞进去：这两个字段正是 agent.destroy() 会一视同仁拆掉的东西。
  (agent.freeSockets as Record<string, net.Socket[]>)["api2.cursor.sh:443:"] = [idle];
  (agent.sockets as Record<string, net.Socket[]>)["api2.cursor.sh:443:"] = [active];

  applyProxyConfig(undefined);

  assert.equal(idle.destroyed, true, "空闲连接留着只会白占端口");
  assert.equal(active.destroyed, false, "改个设置不该把正在跑的模型请求打成传输错误");
  active.destroy();
});

test("testProxy 分别报告 REST 与模型两条链路，且不碰进程全局", async () => {
  const originalDispatcher = getGlobalDispatcher();
  const originalHttps = https.globalAgent;
  const originalHttp = http.globalAgent;

  // 127.0.0.1:1 上没人监听，两条都会以 ECONNREFUSED 收场——这里要的是结构，不是连通性。
  const result = await testProxy("http://127.0.0.1:1", { timeoutMs: 3_000 });

  assert.equal(result.ok, false);
  assert.equal(result.rest.ok, false);
  assert.equal(result.model.ok, false);
  // 两条链路打的是不同的 host：REST 是 api.cursor.com，模型是 connect-node 的 api2.cursor.sh。
  assert.equal(result.rest.target, "https://api.cursor.com/v1/me");
  assert.equal(result.model.target, "https://api2.cursor.sh/");
  assert.notEqual(result.rest.target, result.model.target);
  assert.match(result.error ?? "", /api\.cursor\.com/);
  assert.match(result.error ?? "", /api2\.cursor\.sh/);
  assert.ok(result.durationMs >= 0);

  // 探测用的都是一次性对象；把正在跑的请求换到测试连接池上是绝对不能发生的。
  assert.equal(getGlobalDispatcher(), originalDispatcher);
  assert.equal(https.globalAgent, originalHttps);
  assert.equal(http.globalAgent, originalHttp);
});

test("HTTP/1.1 三态解析：落库值 > 环境变量 > 配了代理就默认开", async () => {
  const noEnv: NodeJS.ProcessEnv = {};

  // 从没表过态 + 配了代理：网关替运维打开，否则模型流量会绕过代理直连。
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore(), { proxyConfigured: true, env: noEnv }),
    { enabled: true, source: "proxy" }
  );
  // 没代理就没有理由动它，退回调用方给的默认值。
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore(), { proxyConfigured: false, env: noEnv }),
    { enabled: false, source: "default" }
  );
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore(), { proxyConfigured: false, fallback: true, env: noEnv }),
    { enabled: true, source: "default" }
  );

  // 落库的 false 是运维在后台亲手关的，配了代理也不能被顶回去。
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore({ cursorSdkUseHttp1ForAgent: "false" }), { proxyConfigured: true, env: noEnv }),
    { enabled: false, source: "stored" }
  );
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore({ cursorSdkUseHttp1ForAgent: "true" }), { proxyConfigured: false, env: noEnv }),
    { enabled: true, source: "stored" }
  );

  // 环境变量里的显式 false 同样是明确意见；空串则等于没写过，代理仍然能把它顶上去。
  for (const raw of ["false", "0", "no", "off", "FALSE"]) {
    assert.deepEqual(
      await loadCursorSdkUseHttp1ForAgent(settingsStore(), {
        proxyConfigured: true,
        env: { CURSOR_SDK_USE_HTTP1_FOR_AGENT: raw }
      }),
      { enabled: false, source: "env" },
      `CURSOR_SDK_USE_HTTP1_FOR_AGENT=${raw} 应当被当成显式关闭`
    );
  }
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(settingsStore(), {
      proxyConfigured: true,
      env: { CURSOR_SDK_USE_HTTP1_FOR_AGENT: "   " }
    }),
    { enabled: true, source: "proxy" }
  );

  // 落库值优先于环境变量：后台改完不该被启动时的 env 又盖回去。
  const store = settingsStore();
  await saveCursorSdkUseHttp1ForAgent(store, true);
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(store, { proxyConfigured: false, env: { CURSOR_SDK_USE_HTTP1_FOR_AGENT: "false" } }),
    { enabled: true, source: "stored" }
  );
});

test("退回「未设置」之后，代理仍然有资格把 HTTP/1.1 顶上去", async () => {
  const noEnv: NodeJS.ProcessEnv = {};
  const store = settingsStore();

  await saveCursorSdkUseHttp1ForAgent(store, false);
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(store, { proxyConfigured: true, env: noEnv }),
    { enabled: false, source: "stored" }
  );

  // 清掉之后必须与「从没配过」完全等价。少了这条路，后台只要保存过一次设置，
  // 落库值就永远压着代理，模型流量再也不会自动走代理。
  await clearCursorSdkUseHttp1ForAgent(store);
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(store, { proxyConfigured: true, env: noEnv }),
    { enabled: true, source: "proxy" }
  );
  assert.deepEqual(
    await loadCursorSdkUseHttp1ForAgent(store, { proxyConfigured: false, env: { CURSOR_SDK_USE_HTTP1_FOR_AGENT: "false" } }),
    { enabled: false, source: "env" }
  );
});

test("保存运行设置不会替运维对 HTTP/1.1 表过态", async (t) => {
  const { app, store } = await settingsApp(t);

  // 全新安装：这个开关谁都没碰过。
  assert.equal(await store.getSetting("cursorSdkUseHttp1ForAgent"), undefined);

  // 后台改的是别的设置，HTTP/1.1 控件停在「未设置」——此时送上来的必须是 null，
  // 而不是把控件的当前显示压成一个布尔值。
  const saved = await postSettings(app, { cursorSdkUseHttp1ForAgent: null, cursorFast: true });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().config.cursorSdkUseHttp1Source, "default");
  assert.equal(saved.json().config.cursorSdkUseHttp1ForAgent, false);

  // 关键：此后再配代理，网关仍然认得出「没人表过态」，自动把 HTTP/1.1 打开。
  const proxied = await postSettings(app, { proxyUrl: "socks5h://127.0.0.1:7891" });
  assert.equal(proxied.statusCode, 200);
  assert.equal(proxied.json().http1AutoEnabled, true);
  assert.equal(proxied.json().config.cursorSdkUseHttp1ForAgent, true);
  assert.equal(proxied.json().config.cursorSdkUseHttp1Source, "stored");
  assert.equal(await store.getSetting("cursorSdkUseHttp1ForAgent"), "true");
  assert.deepEqual(proxied.json().config.proxy.warnings, []);
});

test("显式关掉的 HTTP/1.1 仍然被尊重，改回未设置才重新跟随代理", async (t) => {
  const { app, store } = await settingsApp(t);

  const off = await postSettings(app, { cursorSdkUseHttp1ForAgent: false });
  assert.equal(off.json().config.cursorSdkUseHttp1Source, "stored");
  assert.equal(await store.getSetting("cursorSdkUseHttp1ForAgent"), "false");

  // 运维亲手关过，配代理时网关不能替他改回来，但必须持续告警。
  const proxied = await postSettings(app, { proxyUrl: "socks5h://127.0.0.1:7891" });
  assert.equal(proxied.json().http1AutoEnabled, undefined);
  assert.equal(proxied.json().config.cursorSdkUseHttp1ForAgent, false);
  assert.equal(proxied.json().config.proxy.modelTrafficProxied, false);
  assert.equal(proxied.json().config.warnings.length, 1);

  // 改回「未设置」＝清掉这条设置，生效值当场按三态重算成「跟随代理」。
  const auto = await postSettings(app, { cursorSdkUseHttp1ForAgent: null });
  assert.equal(auto.json().config.cursorSdkUseHttp1ForAgent, true);
  assert.equal(auto.json().config.cursorSdkUseHttp1Source, "proxy");
  assert.equal(auto.json().config.proxy.modelTrafficProxied, true);
});

test("后台设置表单用三态控件承载 HTTP/1.1，不再用 checkbox 压平", () => {
  assert.match(ADMIN_HTML, /<select id="sdk-http1-mode"/);
  // checkbox 只有两个状态，拿它提交等于每次保存都替运维表一次态。
  assert.doesNotMatch(ADMIN_HTML, /sdk-http1-toggle/);
  // 「未设置」必须是第一个 option：表单还没被回填过时浏览器默认选中的就是它，
  // 那一次保存同样不能凭空造出一个显式取值。
  assert.match(ADMIN_HTML, /<select id="sdk-http1-mode"[^>]*>\s*<option value="auto"/);
  // 只有实际改过三态控件才提交值；auto 这一档仍然送 null。
  assert.match(ADMIN_HTML, /if \(http1ModeDirty\) body\.cursorSdkUseHttp1ForAgent = http1Mode === 'auto' \? null :/);
  // 回显要认来源，否则 stored:false 与「没配过」在界面上是同一个样子。
  assert.match(ADMIN_HTML, /cursorSdkUseHttp1Source/);
});

test("释放预热租约有时限，卡住的那份留在池里等下次重试", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const pool = new ExecutorWarmPool({
    // release 永不返回：模拟 SDK 的 dispose 卡死。管理接口正在等这个调用返回。
    loadPlatform: async () => ({ prewarmLocalWorkspace: async () => () => new Promise<void>(() => undefined) })
  });
  await pool.warm("key-a", "/workspace");

  await pool.releaseAll({ timeoutMs: 50 });

  assert.equal(pool.size, 1, "那个 release 函数是解开这份引用的唯一句柄，不能连同失败一起丢掉");
  assert.equal(pool.releaseFailures.length, 1);
  assert.equal(warn.mock.callCount(), 1, "静默吞掉失败等于把执行器泄漏藏起来");
});

test("释放失败会被记下来并留待重试，而不是悄悄吞掉", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  let attempts = 0;
  const pool = new ExecutorWarmPool({
    loadPlatform: async () => ({
      prewarmLocalWorkspace: async () => async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("dispose failed");
      }
    })
  });
  await pool.warm("key-a", "/workspace");

  await pool.releaseAll();
  assert.equal(pool.size, 1);
  assert.match(pool.releaseFailures[0] ?? "", /dispose failed/);

  // 真失败（不是超时）会清掉在途 promise，下一次释放能重新发起一次干净的调用。
  await pool.releaseAll();
  assert.equal(attempts, 2);
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.releaseFailures, []);
});

test("releaseAll 返回失败并且 warm 不会复用未释放的旧租约", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  let prewarmCount = 0;
  let releaseAttempts = 0;
  const pool = new ExecutorWarmPool({
    loadPlatform: async () => ({
      prewarmLocalWorkspace: async () => {
        prewarmCount += 1;
        return async () => {
          releaseAttempts += 1;
          if (releaseAttempts === 1) throw new Error("dispose failed once");
        };
      }
    })
  });

  await pool.warm("key-a", "/workspace");
  const failed = await pool.releaseAll({ timeoutMs: 100 });
  assert.equal(failed.ok, false);
  assert.equal(failed.failures.length, 1);
  assert.equal(pool.size, 1);

  await pool.warm("key-a", "/workspace");
  assert.equal(releaseAttempts, 2, "再次 warm 前必须先重试旧租约的 release");
  assert.equal(prewarmCount, 2, "旧租约释放成功后才允许重新预热");
  await pool.releaseAll();
});

test("租约溢出时释放失败仍保留句柄并报告告警", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const attempts = new Map<string, number>();
  const pool = new ExecutorWarmPool({
    maxLeases: 1,
    loadPlatform: async () => ({
      prewarmLocalWorkspace: async ({ apiKey }) => {
        return async () => {
          const count = (attempts.get(apiKey as string) ?? 0) + 1;
          attempts.set(apiKey as string, count);
          if (apiKey === "key-a" && count === 1) throw new Error("overflow dispose failed");
        };
      }
    })
  });

  await pool.warm("key-a", "/workspace");
  await pool.warm("key-b", "/workspace");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(attempts.get("key-a"), 1);
  assert.equal(pool.size, 2, "溢出回收失败时旧租约必须留在池里");
  assert.equal(pool.releaseFailures.length, 1);
  assert.match(pool.releaseFailures[0] ?? "", /overflow dispose failed/);
});

test("proxyStatus 回显的地址已经掩码", (t) => {
  t.after(() => {
    applyProxyConfig(undefined);
  });
  const status = applyProxyConfig("http://alice:s3cret@127.0.0.1:7890", { useHttp1ForAgent: true });
  assert.equal(status.url, "http://***:***@127.0.0.1:7890");
  assert.doesNotMatch(JSON.stringify(status), /s3cret|alice/);
});

/* ===== 本地假服务器与 HTTP 层脚手架 ===== */

interface SocksRecord {
  atyp: number;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

function listen(server: net.Server | http.Server, t: TestContext): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise<void>((done) => {
        server.close(() => done());
      }));
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** 隧道另一端的目标站点：只要一个稳定的状态码，用来证明字节真的走通了。 */
function startOriginServer(t: TestContext): Promise<number> {
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  return listen(server, t);
}

/**
 * 够用的 SOCKS5 代理：认得免鉴权与用户名/密码两种方式，记下每条 CONNECT 的地址类型与凭据，
 * 然后真的把字节转发到目标。DNS 归属、鉴权、隧道能不能通这三件事，只有真握手才验得出来。
 */
function startSocks5Proxy(
  t: TestContext,
  options: { records: SocksRecord[]; auth?: { username: string; password: string } }
): Promise<number> {
  const server = net.createServer((socket) => handleSocks5(socket, options));
  return listen(server, t);
}

function handleSocks5(
  socket: net.Socket,
  options: { records: SocksRecord[]; auth?: { username: string; password: string } }
): void {
  let stage: "greeting" | "auth" | "request" | "tunnel" = "greeting";
  let buffer = Buffer.alloc(0);
  let upstream: net.Socket | undefined;
  let username: string | undefined;
  let password: string | undefined;
  socket.on("error", () => undefined);
  socket.on("data", (chunk: Buffer) => {
    if (stage === "tunnel") {
      if (upstream) upstream.write(chunk);
      else buffer = Buffer.concat([buffer, chunk]);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const count = buffer[1];
        if (buffer.length < 2 + count) return;
        const methods = [...buffer.subarray(2, 2 + count)];
        buffer = buffer.subarray(2 + count);
        const method = options.auth ? 0x02 : 0x00;
        if (!methods.includes(method)) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }
        socket.write(Buffer.from([0x05, method]));
        stage = options.auth ? "auth" : "request";
        continue;
      }
      if (stage === "auth") {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 3 + ulen) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        username = buffer.subarray(2, 2 + ulen).toString();
        password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        buffer = buffer.subarray(3 + ulen + plen);
        const accepted = username === options.auth?.username && password === options.auth?.password;
        socket.write(Buffer.from([0x01, accepted ? 0x00 : 0x01]));
        if (!accepted) {
          socket.end();
          return;
        }
        stage = "request";
        continue;
      }
      // CONNECT 请求：VER CMD RSV ATYP ADDR PORT
      if (buffer.length < 5) return;
      const atyp = buffer[3];
      let addrEnd: number;
      let host: string;
      if (atyp === 0x01) {
        addrEnd = 8;
        if (buffer.length < addrEnd + 2) return;
        host = [...buffer.subarray(4, 8)].join(".");
      } else if (atyp === 0x04) {
        addrEnd = 20;
        if (buffer.length < addrEnd + 2) return;
        host = ipv6Text(buffer.subarray(4, 20));
      } else if (atyp === 0x03) {
        addrEnd = 5 + buffer[4];
        if (buffer.length < addrEnd + 2) return;
        host = buffer.subarray(5, addrEnd).toString();
      } else {
        socket.end();
        return;
      }
      const port = buffer.readUInt16BE(addrEnd);
      buffer = buffer.subarray(addrEnd + 2);
      options.records.push({
        atyp,
        host,
        port,
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password })
      });
      stage = "tunnel";
      // socks5h 会把域名交过来，本机把它当 127.0.0.1 解析即可——记录里留的仍是收到的原值。
      const target = net.connect(port, host === "localhost" ? "127.0.0.1" : host);
      target.on("error", () => socket.destroy());
      target.on("data", (data: Buffer) => socket.write(data));
      target.on("close", () => socket.end());
      target.on("connect", () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        upstream = target;
        if (buffer.length) {
          target.write(buffer);
          buffer = Buffer.alloc(0);
        }
      });
      socket.on("close", () => target.destroy());
      return;
    }
  });
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

/** 一条真的连着的 socket：排空用例要验的是「谁被 destroy 了」，假对象证明不了这件事。 */
async function connectedSocketPair(t: TestContext): Promise<net.Socket> {
  const server = net.createServer((socket) => socket.on("error", () => undefined));
  const port = await listen(server, t);
  const client = net.connect(port, "127.0.0.1");
  client.on("error", () => undefined);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  t.after(() => {
    client.destroy();
  });
  return client;
}

const ADMIN_PASSWORD = "admin-password";

/** 一个只关心「请求有没有走到上游」的假 runner。 */
class StubRunner implements CursorRunner {
  async run(): Promise<CursorRunResult> {
    return { text: "ok", toolCalls: [] };
  }

  async *stream(): AsyncIterable<CursorStreamEvent> {
    yield { type: "done", result: { text: "ok", toolCalls: [] } };
  }
}

/**
 * 起真实的 Fastify 实例：三态开关的完整语义只有在 HTTP 层才验得出来——
 * 表单送了什么、库里落了什么、下一次配代理时网关还认不认得出「没人表过态」，是三件独立的事。
 */
async function settingsApp(t: TestContext): Promise<{ app: FastifyInstance; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  const keyPool = new CursorKeyPool(store);
  await keyPool.seedFromEnv(["cursor-key-a"]);
  const app = createApp({
    config: settingsConfig(),
    store,
    keyPool,
    runner: new KeyRotatingRunner(new StubRunner(), keyPool),
    // 注入桩：真实实现会 import("@cursor/sdk")，而这几条用例一个字节都不该发到上游。
    applyCursorSdkNetworkConfig: async () => undefined,
    modelLister: async () => ({ models: [{ id: "composer-2.5", name: "Composer 2.5", aliases: [] }], source: "cursor" })
  });
  t.after(() => {
    applyProxyConfig(undefined);
  });
  return { app, store };
}

function postSettings(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/admin/api/settings",
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
    payload
  });
}

function settingsConfig(): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    cursorApiKeys: [],
    adminPassword: ADMIN_PASSWORD,
    gatewayApiKey: "gateway-key-for-settings-tests",
    allowDirectCursorKeys: true,
    sqlitePath: ":memory:",
    requestLogKeep: 0,
    cursorWorkingDirectory: "/tmp",
    requestTimeoutMs: 30_000,
    sdkClientVersion: "sdk-test",
    cursorSdkDisableSessionResume: true,
    cursorAllowBuiltinTools: false,
    cursorSdkUseHttp1ForAgent: false,
    cursorPrewarm: false,
    maxKeyAttempts: 10,
    maxTransientAttempts: 3,
    autoDisableKeys: true,
    autoDisableThreshold: 2,
    sandClientMode: false,
    routingStrategy: "fill-first",
    sessionAffinity: true,
    sessionAffinityTtlMs: 3_600_000,
    systemPromptMode: "off"
  };
}
