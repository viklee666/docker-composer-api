import type { CursorRunRequest, CursorRunResult, CursorRunner, CursorStreamEvent } from "../types.js";

/**
 * 按 `CursorRunRequest.provider` 把请求分给两条互不相干的 runner。
 *
 * 选路本身在 `router.ts` 的纯函数里，`server.ts` 建请求时就已经定好并写进 `provider` 字段；
 * 这里只负责分发。这样两条路线的 key、重试和错误彻底隔离——
 * SDK 路线的 `KeyRotatingRunner` 看不到 Connect 的凭据，反过来也一样。
 */
export interface ProviderRoutingRunnerOptions {
  sdk: CursorRunner;
  connect?: CursorRunner;
}

export class ProviderRoutingRunner implements CursorRunner {
  constructor(private readonly options: ProviderRoutingRunnerOptions) {}

  run(input: CursorRunRequest, signal?: AbortSignal): Promise<CursorRunResult> {
    return this.pick(input).run(input, signal);
  }

  stream(input: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorStreamEvent> {
    return this.pick(input).stream(input, signal);
  }

  private pick(input: CursorRunRequest): CursorRunner {
    // Connect 没装就回落 SDK，而不是抛错：选路层已经做过一次可用性回落，
    // 走到这里还是 connect 只可能是接线漏了，回落比让请求 500 更可取。
    return input.provider === "connect" && this.options.connect ? this.options.connect : this.options.sdk;
  }
}
