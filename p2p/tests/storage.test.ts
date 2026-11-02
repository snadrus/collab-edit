import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_NETWORK, RPC_URLS, UNANCHORED, commpOf, fileAdapter, ipfsAdapter, normalizeNetwork, pieceCidOf, savedVersionUrls, synapseAdapter, trysteroOptions } from "../src/storage.ts";

describe("filecoin defaults", () => {
  it("uses mainnet unless the toggle asks for calibration", () => {
    assert.equal(DEFAULT_NETWORK, "mainnet");
    assert.equal(normalizeNetwork(undefined), "mainnet");
    assert.equal(normalizeNetwork("nope"), "mainnet");
    assert.equal(normalizeNetwork("calibration"), "calibration");
    assert.match(RPC_URLS.mainnet, /glif\.io/);
    assert.match(RPC_URLS.calibration, /calibration/);
    assert.deepEqual(trysteroOptions("fragment-secret"), { appId: "felarumi.collab", password: "fragment-secret" });
  });

  it("records a mock synapse piece cid and reads it back", async () => {
    const stored = new Map<string, Uint8Array>();
    const adapter = await synapseAdapter({
      network: "mainnet",
      client: {
        storage: {
          async upload(data: Uint8Array) {
            stored.set("bafypiece", data);
            return { pieceCid: { toString: () => "bafypiece" } };
          },
          async download(options: { pieceCid: string }) {
            const hit = stored.get(options.pieceCid);
            if (!hit) throw new Error("missing");
            return hit;
          },
        },
      },
    });
    const bytes = new TextEncoder().encode("hello");
    assert.equal(await adapter.put(bytes), "bafypiece");
    assert.equal(new TextDecoder().decode(await adapter.get("bafypiece")), "hello");
    assert.equal(pieceCidOf("plain"), "plain");
  });

  it("round-trips a file snapshot and posts an ipfs token", async () => {
    const files = fileAdapter();
    const bytes = new TextEncoder().encode('{"kind":"felarumi-p2p"}');
    const cid = await files.put(bytes);
    assert.match(cid, /^file:[0-9a-f]{64}$/);
    assert.deepEqual(await files.get(cid), bytes);

    let auth = "";
    const ipfs = ipfsAdapter("runtime-token", async (input, init) => {
      auth = String((init?.headers as { authorization?: string } | undefined)?.authorization || "");
      if (String(input).includes("w3s.link")) return new Response(bytes);
      return new Response(JSON.stringify({ cid: "bafyipfs" }), { headers: { "content-type": "application/json" } });
    });
    assert.equal(await ipfs.put(bytes), "bafyipfs");
    assert.equal(auth, "Bearer runtime-token");
    assert.equal(new TextDecoder().decode(await ipfs.get("bafyipfs")), '{"kind":"felarumi-p2p"}');
  });

  it("computes a stable local piece cid", async () => {
    const bytes = new TextEncoder().encode("hello");
    const first = await commpOf(bytes);
    assert.equal(first, await commpOf(bytes));
    assert.notEqual(first, UNANCHORED);
    assert.notEqual(await commpOf(new TextEncoder().encode("other")), first);
  });
});

describe("savedVersionUrls", () => {
  it("reads piece CIDs from FilBeam with the payer address and IPFS CIDs from a gateway", () => {
    const owner = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331";
    assert.deepEqual(savedVersionUrls("bafkzcibabc", owner, "mainnet")[0], "https://0x4893fff3611240fbb4be68efe4aa0ec634279331.filbeam.io/bafkzcibabc");
    assert.match(savedVersionUrls("bafkzcibabc", owner, "calibration")[0], /\.calibration\.filbeam\.io\//);
    assert.deepEqual(savedVersionUrls("bafybeigabc", "", "mainnet"), ["https://w3s.link/ipfs/bafybeigabc"]);
    assert.deepEqual(savedVersionUrls("sha256-abc", owner, "mainnet"), []);
  });
});
