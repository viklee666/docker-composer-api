# SDK 路线间歇性「Authentication error … try logging out and back in」问题分析

> 记录时间：2026-09-16。基线 `73b401c`。
> 状态：**已定位到一条确定的网关侧缺陷（P1），但 10–15 分钟自愈的成因未完全证实**。
> 本文既是我方的分析结论，也是可以直接丢给外部（GPT / 其他模型）继续分析的问题陈述。
> §6 是对外提问用的精炼版，§3–§5 是证据与推理，§7 是候选修复与权衡。

---

## 1. 症状（用户报告，原文）

SDK 路线使用一段时间后报：

```
Cursor upstream run ended in error for model "gpt-5.6-luna": Authentication error
If you are logged in, try logging out and back in.; ERROR; Authentication error
If you are logged in, try logging out and back in.. Likely causes: quota/credit
exhausted, a temporary Cursor capacity shortage (often self-recovers), or a model
not runnable via the API/SDK channel. The gateway will try the next pool key
automatically; if it persists, retry shortly or use composer-2.5 / composer-2.5-fast / auto.
```

关键补充事实：

- **十几分钟后自动恢复**（用户观察）；
- 只在**长时间使用**后出现（"使用久了就会报"）；
- 该错误文案是网关自己拼的 502，内嵌的 `Authentication error If you are logged in...` 是**上游原样返回**的；
- 同一时间其它模型（composer 等）可能正常。

---

## 2. 链路与相关组件

```
客户端 → 本网关（/v1/messages 等）
        → KeyRotatingRunner（选 key / 轮换 / 会话粘性）
        → CursorSdkRunner（durable 会话槽 + @cursor/sdk Agent）
        → Cursor 上游（api2）
```

两个关键机制：

- **会话粘性（session affinity）**：一段对话首次成功后被**钉死**在某把 Cursor key 上
  （`session_bindings` 表，TTL = `SESSION_AFFINITY_TTL_MS`，默认/该部署均为 3600000ms = 60min）。
  目的是保住上游 prompt 缓存。
- **SDK 共享执行器**：`@cursor/sdk` 的本地执行器按
  `sha256({workingDirectory, dirs, apiKeyHash, settingSources, ...})` 缓存 + 引用计数，
  引用归零才 dispose。它持有的鉴权拦截器会把「API key 兑换 access token」的失败**永久**
  缓存在闭包里（网关注释明确记录过这一点，`src/executor-warmup.ts:9-12`）。
  网关为此在启动时预取一份租约并保管 release 句柄（`ExecutorWarmPool`），鉴权失败时
  主动 release + 60s 冷却，让引用计数有机会归零、SDK 回收坏执行器。

---

## 3. 已核实的代码路径（带行号）

### 3.1 错误分类：被判定为「会话态认证抖动」→ transient

`src/key-pool.ts:529`：

```ts
const SESSION_AUTH_HICCUP = /log(ging)? ?out and (log ?)?back in|sign(ing)? ?out and (sign ?)?back in/i;
```

注释说明其来历（`key-pool.ts:524-528`）：上游 agent 会话没鉴权成功时会原样吐出 IDE 那句
「Authentication error. If you are logged in, try logging out and back in.」，
**同一个 key 前后都能正常跑**，因此按 transient 处理：换下一个 key，但**不禁用**。

派生影响（三条，全部已核实）：

1. `classifyErrorText`（`key-pool.ts:538-553`）**第一行**就 `if (SESSION_AUTH_HICCUP.test(text)) return undefined;`
   → 该文案不会被判成 auth/quota；
2. `classifyKeyFailure`（`key-pool.ts:589-）` 因此返回 `"transient"`；
3. `upstreamRunError`（`cursor-runner.ts`）据此走**默认 502 分支**，拼出用户看到的那段
   「Likely causes: … The gateway will try the next pool key automatically」。
   —— 用户贴的文案与这条完全吻合，**证明走的确实是这条路径**。

另外 `indicatesUpstreamAuthFailure`（`key-pool.ts:563-570`）对该文案返回 **true**，
于是请求失败后会触发 `recycleExecutorOnAuthFailure`（`cursor-runner.ts:188-198`）→
`executorLeases.recycle(apiKey, cwd)`。

### 3.2 【P1 确定缺陷】钉死后的 durable 会话对任何失败都不重试

`src/key-rotating-runner.ts:131` 取粘性绑定 → `142` 把 `allowedKeyIds` 收窄成只有那一把 →
`217-221`：

```ts
if (pinnedKeyId) {
  // 钉死后任何失败都不换 key：auth/quota 也会 502，而不是试下一把把 execute 弄丢。
  if (signal?.aborted) throw error;
  throw pinnedKeyFailure(error, failure);
}
```

`pinnedKeyFailure`（`key-rotating-runner.ts:321-329`）只在 `auth`/`quota` 上改写文案，
**transient 原样抛出**（→ 502）。

所以：**一段已建立粘性的 durable 对话，遇到任何一次上游抖动都直接失败，零重试。**
`MAX_TRANSIENT_KEY_ATTEMPTS=3` 的软失败重试对这条路完全无效。
这解释了「为什么是使用久了才出现」——只有建立了绑定的长对话才会走这条分支。

### 3.3 【P2 确定缺陷】durable 会话里的 key 轮换是「假的」

- `createDurableSlot` 用 `agentOptions(input, ...)` 创建 agent，而 `agentOptions` 把
  `apiKey: input.apiKey` 写进 create 选项（`cursor-runner.ts:1836-1840` 附近），
  SDK 据此按 `apiKeyHash` 选执行器 —— **agent 一旦建好，就绑死在创建时那把 key 的执行器上**。
- 复用已有槽时只做 `slot.apiKey = input.apiKey`（`cursor-runner.ts` `ensureDurableSlot` 内），
  **不会重建 agent**；`durableSlotReplaceReason` 也刻意不因 apiKey 变化换槽。

推论：`KeyRotatingRunner` 把 `input.apiKey` 换成下一把再重试，对**已有槽**的 durable 请求
**并不改变实际上游用哪把 key**——inner runner 仍然把消息发到原 agent（原 key 的执行器）。
这带来两个后果：

1. 轮换对 durable 续聊在物理上就是无效的（这其实是 `217-221` 那条「禁止换 key」的**更深层原因**，
   比注释里写的「会丢掉 held execute / 打爆前缀缓存」更根本）。**要真的换 key，必须丢弃槽、
   用新 key 重建 agent 并重发全量 prompt** —— 也就是退化成 stateless。
2. `recycleExecutorOnAuthFailure`（`cursor-runner.ts:188-198`）用的是**当前请求的 `input.apiKey`**
   （`slot.apiKey` 全仓只写不读，不参与此处），而被污染的可能是 agent 实际使用的那把 key。
   两者在「粘性绑定 key 与 agent 创建 key 不一致」时才分叉——已确认的一致场景是：
   首轮建绑定与建 agent 用的是同一把、钉死路径又不轮换，所以**当前部署下这条大概率不会分叉**；
   真正可能分叉的是重启后 `tryResumeDurableSlot` 用新选的 key 去 resume 一个原本由别的 key
   创建的 agent。**这条是理论风险，未在线上观察到，优先级低于 P1。**

### 3.4 执行器回收的其他限制

- `ExecutorWarmPool.recycle`（`src/executor-warmup.ts:159-172`）在 `this.leases.get(id)` 为空时
  **直接 return**；而 `warm()` 全仓只在启动时调用一次，且只预热**第一把 active key**
  （`src/index.ts:371-374`）。因此除那把 key 外，recycle 是 no-op。
- SDK 只在引用计数归零时才 dispose 执行器（`@cursor/sdk/dist/cjs/index.js`，
  `release` 里 `if (!(t.refs > 0 || Ie.get(key) !== t)) { Ie.delete(key); dispose() }`）。
  任何活着的 Agent 都持有一份引用。

---

## 4. 关键推论

1. 用户看到的 502 文案**只可能**来自 `upstreamRunError` 的默认分支，即
   `classifyKeyFailure` 判为 transient。这排除了「被判成 quota/auth 从而禁用 key」的解释
   （禁用了的话错误文案会不同，且后台会看到 key 被禁用）。
2. durable 会话被钉死后**没有重试**，所以一次上游抖动 = 一次可见失败。
   「用久了才出现」与「只有建立绑定后才走这条路」完全对应。
3. 失败轮次会丢弃槽（`streamDurable` 的 finally：state=running 且无 pending ⇒ dropDurableSession），
   所以**下一轮会重建全新 agent**。如果抖动是「agent 会话级」的，下一轮就该好了；
   用户观察到持续十几分钟 ⇒ 抖动更可能是**key 级或上游级**，不是 agent 级。
4. 若是 key 级，正确的自救是换一把 key —— 而 P1 恰好禁止了这件事。

---

## 5. 尚未证实的部分（诚实标注）

- **10–15 分钟这个时长没有任何代码依据**。仓库里 10 分钟量级的常量只有
  `STATELESS_AGENT_STORE_IDLE_TTL_MS`（stateless 的临时 store）与模型目录 `CACHE_TTL_MS`，
  都与鉴权无关；粘性绑定 TTL 是 60 分钟。所以自愈大概率发生在**上游**（Cursor 侧的会话鉴权
  自己恢复），或用户重开了新对话（新对话没有绑定 → 允许轮换 → 换到另一把 key 就好了）。
- **无法确认当时池里有几把 key、是否所有 key 同时不可用**。这把结论分成两种情形：
  - 多把 key 且只有一把坏 ⇒ 换 key 即可恢复，P1 是主因；
  - 只有一把 key（或全坏）⇒ 换 key 也救不了，只能是上游恢复。
    **这两种情形需要用户提供信息才能区分**（见 §6 的待确认项）。
- 上游为何返回这句、触发条件是什么，属黑盒，无法从本仓库确定。

---

## 6. 对外提问用的精炼陈述（可直接复制）

> 背景：一个 Node.js 网关（TypeScript）把 Cursor 包成 OpenAI/Anthropic 兼容接口，走
> `@cursor/sdk` 的 `Agent.create/resume`。它有一套「会话粘性」：一段对话首次成功后钉死在某把
> Cursor API key 上（SQLite 表，TTL 60 分钟），目的是保住上游 prompt 缓存。
>
> 现象：长时间使用的对话（已建立粘性）会间歇性失败，客户端收到 502，内嵌上游原文
> `Authentication error If you are logged in, try logging out and back in.`。
> 大约十几分钟后自行恢复。同一时刻其它模型/新对话可能正常。
>
> 已核实的代码行为：
>
> 1. 这句文案被网关的正则 `/log(ging)? ?out and (log ?)?back in/i` 识别为「会话态认证抖动」，
>    归类为 **transient**（换 key 但不禁用）。因此错误以 502 形式透出。
> 2. 走粘性路径时（`pinnedKeyId` 非空），代码**在任何失败上立即 throw，不做任何重试**，
>    注释理由是「换 key 会丢掉挂起的 execute / 打爆前缀缓存」。
> 3. Agent 创建时把 apiKey 写进 SDK 的 create 选项，SDK 的执行器缓存键含 apiKeyHash；
>    复用已有 agent 时不会重建。也就是说**已有会话的 key 轮换在物理上无效**，
>    请求仍然走原 agent（原 key 的执行器）。
> 4. 失败轮次会丢弃会话槽，下一轮重建全新 agent；但用户观察到持续十几分钟，
>    说明不是 agent 会话级的问题。
>
> 想请你分析：
> - 这句话在 Cursor 侧的触发条件是什么？（是 per-key 会话失效？per-agent？还是纯服务端抖动？）
> - 「十几分钟自愈」最可能的机制是什么？是否有已知的 token/session 生命周期能对上？
> - 对第 2 点，正确的重试策略应该是什么？在「同一个 agent 绑死一把 key」的前提下，
>   要恢复是不是只能**丢弃会话槽 + 用新 key 重建 agent 并重发全量 prompt**（即退化成 stateless）？
> - 有没有办法在不丢会话状态的前提下切换 key？（例如 SDK 是否支持给已有 agent 换凭证？）
>
> 待确认的环境信息（用户侧提供）：key 池里有几把 key；出问题时是否所有 key 都不可用；
> 同一时刻新开一个对话是否正常。

---

## 7. 候选修复与权衡（供决策，尚未实施）

### P1：给钉死的 durable 会话加「一次重试」，但只在安全的时候

核心矛盾：粘性存在的意义是保住缓存与挂起的 execute，而这两者在换 key 时都会丢。
所以不能简单放开轮换。可分档：

- **有挂起 execute 的轮次**（`durableTurn.kind === "tool_results"` 或槽 `pending.size > 0`）：
  维持现状（立即失败是最好的选择——换 key 会让 execute 永远等不到结果）。
- **无挂起的轮次**（普通 `new_user`）：允许一次「**丢槽 + 用下一把 key 重建 agent + 全量重发**」
  的恢复路径（等价于该轮退化为 stateless，但对话可以继续）。
  代价：该轮丢一次 prompt 缓存；收益：把十几分钟的不可用压缩成一次降级。

这需要一个新分支，跟 `streamStatelessFallback` 类似但**要真的换 key**（`streamStatelessFallback`
保持同一 key）。注意 §3.3：光换 `input.apiKey` 没用，必须重建 agent。

### P2（降级为待观察）：`recycleExecutorOnAuthFailure` 的 key 归属

理论上应该用「agent 实际使用的 key」而不是「本次请求选中的 key」；但如 §3.3 所述，
当前部署下两者在触发回收的路径上大概率是一致的，**没有证据表明它是本次故障的成因**。
先不作为修复项，等 §5 的待确认信息回来再判断。

### P3：transient 语义复核

`SESSION_AUTH_HICCUP` 目前**同时**被判成 transient（不禁用 key）和
`indicatesUpstreamAuthFailure`（回收执行器）。如果这句其实是上游服务端抖动，
那么回收执行器是无用且有害的（白白 dispose 一个健康执行器，下次请求冷启动）。
值得复核：这句到底该不该触发执行器回收。

### P4（可选）：把粘性绑定 TTL 与「多久自愈」对齐

如果确认上游的会话态恢复窗口是固定的，可以把绑定 TTL 或失败后的退避策略对齐，
让「恢复」这件事自动发生，而不是等用户重开对话。
