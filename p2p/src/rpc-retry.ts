/**
 * Load-balanced FEVM RPCs (glif) lag each other: a block seen on one node is "a future epoch"
 * (beyond latest) on another, or its header is not found yet, or the epoch was a null round.
 * Wait and retry those instead of failing a save. Mirrors fil-folders' withTransientRetry.
 */
const TRANSIENT = /future epoch|beyond "?latest"?|header not found|block not found|unknown block|null round|could not find block|requested epoch/i;

export function isTransientRpcError(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (TRANSIENT.test(`${e?.message ?? ""} ${e?.details ?? ""} ${e?.shortMessage ?? ""}`)) return true;
    if (typeof e !== "object") break;
  }
  return typeof error === "string" && TRANSIENT.test(error);
}

export async function retryTransient<T>(fn: () => Promise<T>, maxWaitMs = 90_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<T> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientRpcError(error) || waited >= maxWaitMs) throw error;
      const delay = Math.min(10_000, 1_000 * 2 ** attempt, maxWaitMs - waited);
      waited += delay;
      await sleep(delay);
    }
  }
}

/** Wrap a viem transport factory so each request waits out transient RPC errors. */
export function withTransientRetry<T extends (...args: any[]) => any>(transport: T, sleep?: (ms: number) => Promise<void>): T {
  return ((params: any) => {
    const inner = transport(params);
    return { ...inner, request: (args: unknown, opts: unknown) => retryTransient(() => inner.request(args, opts), undefined, sleep) };
  }) as unknown as T;
}
