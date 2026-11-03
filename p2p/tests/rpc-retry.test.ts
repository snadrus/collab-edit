import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientRpcError, retryTransient } from "../src/rpc-retry.ts";

describe("transient RPC errors", () => {
  it("retries glif's future-epoch error until the block exists, not real errors", async () => {
    const future = Object.assign(new Error("RPC Request failed."), { details: 'requested a future epoch (beyond "latest")' });
    assert.equal(isTransientRpcError(future), true);
    assert.equal(isTransientRpcError(new Error("execution reverted")), false);
    let n = 0;
    const out = await retryTransient(async () => { if (++n < 3) throw future; return "block"; }, 90_000, async () => {});
    assert.equal(out, "block");
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(retryTransient(async () => { n++; throw new Error("execution reverted"); }, 90_000, async () => {}));
    assert.equal(n, 1);
  });
});
