# 把「Sand 客户端模式」落地到正式仓库的操作文档

> 写给另一个 AI / 维护者的落地指引。目标仓库：`E:\docker-composer-api`（正式部署，Docker + TS 编译）。
> 原理验证源：`E:\composer-api\docker-composer-api`（实验仓库，已实测，见第四节）。
> 本文档是「怎么改」的操作说明，不是原理探讨；只依赖本仓库现有结构，不引入额外依赖。

---

## 0. 一句话结论（先读完再动手）

Sand 模式 = 把发给 Cursor 后端的 HTTP 头 **`x-cursor-client-type` 从 `sdk` 改成 `sand`**。
`@cursor/sdk` 打包产物里把这个头**硬编码为 `"sdk"`**，且 SDK 没有对外暴露覆盖头的能力，
所以只能二选一：

- **方案 A（推荐，无需改 node_modules）**：运行时用 Node ESM loader hook 在 SDK 模块加载前替换字符串字面量，**不落盘、不破坏依赖完整性**；
- **方案 B（兜底）**：直接改 `node_modules/@cursor/sdk/dist/esm/index.js` 里的字面量（简单，但升级 SDK 后丢失，且 Docker 里是 ci 拉取的，必须打进镜像）。

**实测已确认**：仅改这个头**不会**解除账号级限制（unpaid invoice / hard limit / Grok Bot 额度）。
Sand 通道是否“有用”，取决于目标账号对 Sand/Grok Bot 通道的资格与额度。落地前先确认目标环境的预期。

---

## 1. 原理背景（要改什么、为什么）

### 1.1 Sand 工具（`Sand客户端模式安装工具.py`）在改什么

它 patch Cursor IDE 的 JS 产物，把三处 `x-cursor-client-type: "ide"` → `"sand"`，并注入 `x-ghost-mode` 相关
eligibility 判定 `return !1`。领取 SAND 资格页：`https://cursor.com/bot/onboarding?product=grok-bot`。

### 1.2 本仓库的 SDK 在发什么头

`node_modules/@cursor/sdk/dist/esm/index.js`（单文件 bundle）里**只有 2 处** `x-cursor-client-type`，都硬编码 `"sdk"`：

```js
// 位置1：请求头对象字面量（CloudAgent 的 headers()）
{ Authorization: `Bearer ...`, "x-ghost-mode": ..., "x-cursor-client-version": ..., "x-cursor-client-type":"sdk" }

// 位置2：connect 拦截器
s.header.set("x-cursor-client-type","sdk")
```

`@cursor/sdk@1.0.27` 无任何 API 能覆盖这个头（`configureCursorSdk` 只认 `local.store` / `local.useHttp1ForAgent` /
`local.workspaceScanCacheTtlMs`）。所以只能字符串替换或 loader 注入。

### 1.3 为什么本仓库必须“注入”，而不是 patch 完直接跑

正式仓库是 **Docker + `npm run build`（tsc）** 部署：运行时执行的是 `dist/src/index.js`，
所有 `@cursor/sdk` 的引用都是**动态 `import("@cursor/sdk")`**（见 `dist/src/index.js`、`cursor-runner.js:444`、
`models.js:65`、`sdk-network.js:12`，均非 bundle）。因此 SDK 模块是从 `node_modules` 原样加载的，
loader hook（方案 A）或直接改 node_modules（方案 B）都能对运行时生效。

---

## 2. 正式仓库已落地的方案（按请求可切换，不要改成整进程写死）

**不要**再把字面量一次性替换成 `"sand"`，也**不要**改 `package.json` `start` / Docker `CMD` 去加 `--experimental-loader`。
那样会让所有请求都走 Sand，后台的「总开关 / 每个 key 单独配置」会失效。

当前实现：

1. `src/sand-client-header-loader.ts`（编译进 `dist/src/`，runtime 镜像已拷 `dist`）只把
   `x-cursor-client-type","sdk"` / `x-cursor-client-type":"sdk"` 换成
   `((globalThis.__cursorSandHookPatched=true),globalThis.__cursorClientType())`。
2. `src/index.ts` 在任何 `import("@cursor/sdk")` **之前**调用 `installSandClientHeaderHook()`（`node:module register()`）。
3. 每个请求由 `KeyRotatingRunner` 解析 `inherit | sdk | sand`，`CursorSdkRunner` 用
   `iterateWithCursorClientType` 包住 SDK 调用；该迭代器必须转发 `return()`/`throw()`，
   否则会打断既有的断连 cancel/dispose（见 commit `6afa0ba`）。
4. 后台：全局 `sandClientMode` 即时保存；单个 key 的通道下拉即时保存。`SAND_CLIENT_MODE` 只是库未写入前的默认。

Docker `CMD` 保持 `["node", "dist/src/index.js"]`。`scripts/sand-client-header-loader.mjs` 只是同逻辑的手工副本，不是生产入口。

---

## 3. 方案 B（兜底）：直接改 node_modules 字符串

- 编辑 `node_modules/@cursor/sdk/dist/esm/index.js`，把两处 `"sdk"`（紧随 `x-cursor-client-type` 的那个）改成 `"sand"`。
- **必须同步改 cjs bundle**（`dist/cjs/index.js`，同样 2 处），否则 `require()` 路径不长记性。
- Docker 里：改完打包进镜像（`npm ci` 之后 `sed`，或在 build 阶段 patch）。
- 缺点：SDK 升级即失效；对“干净依赖”不友好。仅当 loader 在目标 Node/容器里不可用时才选。

---

## 4. 实测记录（实验仓库已验证，正式仓库落地前必读）

实验仓库：`E:\composer-api\docker-composer-api`，SDK `@cursor/sdk@1.0.27`，Node 22。

### 4.1 loader 确实生效

- 跑 `SAND_CLIENT_HEADER=1 node scripts/sand-client-header-experiment.js --runtime=cloud --model=composer-2.5`，
  控制台出现 `[sand-client-loader] patched client-type -> "sand" in @cursor/sdk/dist/esm/index.js`，且后续请求正常完成 → 注入成功。
- 可用 `--list-models` 确认账号可见模型（实测含 `claude-opus-5 / 4-8 / 4-7 / 4-6 / 4-5`、`composer-2.5` 等）。

### 4.2 行为矩阵（确认 key `crsr_00…` 账号）

| runtime | model | sand 头 | 结果 |
|---|---|---|---|
| local | composer-2.5 | 无 | ✅ finished（17s，返回「通」，带 usage） |
| local | composer-2.5 | 有 | ❌ `Grok Bot usage limit`（实测文案：`It resets in 2 days`，Grok Bot 额度用完待重置） |
| local | claude-opus-5 | 无 | ❌ `You have an unpaid invoice … pay in Stripe`（opus 属付费模型触发发票检查） |
| local | claude-opus-5 | 有 | ❌ `Grok Bot usage limit` |
| cloud | composer-2.5 | 无 / 有 | ✅ finished（两类头都能跑） |
| cloud | claude-opus-5 / 4-8 | 无 / 有 | ❌ `Background Agent requires at least $2 remaining until your hard limit` |

### 4.3 对正式仓库落地的重要提醒

1. **改头 ≠ 解除限制**。该账号下 opus 三类卡点分别是：Stripe 未付发票（local）、Background Agent hard limit（cloud）、
   Grok Bot 额度（sand 通道，实测报 `It resets in 2 days`）。这些是**账号级**判定，不是头能绕过的。**落地前先确认目标正式账号的 Sand 资格与额度**。
2. **local 首次可能“看着像卡死”**：不是必现，但 agent 创建/首次 send 有时无输出数秒。实测确认最终能 **finished/error**，
   别把“没立刻有响应”误判成挂死。
3. **Chromium/平台包**：SDK 本地执行器在 Windows 上依赖 `@cursor/sdk-win32-x64`（node_modules 里已有）。
   正式仓库如果是容器（Linux），确认 `@cursor/sdk-linux-x64` 会随 optionalDependencies 装上，否则 local runtime 起不来。
4. **日志位置**：正式仓库别漏配日志盘；本地执行器的 network/result 日志可能很大（本仓库 logs/ 下有几十 MB 的先例）。

---

## 5. 落地 checklist（给执行者）

- [ ] 确认走「函数替换 + register() + 后台可切换」，不要改成整进程写死 sand
- [ ] `src/index.ts` 在首次 import SDK 前调用 `installSandClientHeaderHook()`；Docker CMD 仍是 `node dist/src/index.js`
- [ ] 后台可总切 / 按 key 配置；`SAND_CLIENT_MODE` 只作未落库时的默认
- [ ] 方案 B 仅作兜底：改 esm + cjs 两处字面量；Docker 里在 `npm ci` 后 patch 再打包
- [ ] 用 `--list-models` 确认目标账号可见模型
- [ ] local + cloud 各发一条 composer 对照组，确认两头都通
- [ ] 再分别用 sand 头试 opus，记录错误种类，确认是否符合预期（发票 / hard limit / Grok 额度）
- [ ] 关键日志落盘，监控 GC 与句柄（SDK 本地执行器有历史性的 handle 泄漏背景，见本仓库 src 注释）