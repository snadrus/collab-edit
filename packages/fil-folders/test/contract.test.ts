import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filecoinCalibration } from "../src/registry.ts";
import { Folders, contractRegistry, memoryStore } from "../src/index.ts";

const ANVIL = [process.env.ANVIL_BIN, `${process.env.HOME}/.foundry/bin/anvil`].find((item) => item && existsSync(item));
const FORGE = ANVIL ? ANVIL.replace(/anvil$/, "forge") : "";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const WRITER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PORT = 8546;
const ROOT = path.resolve(import.meta.dirname, "../../fil-registry");

async function waitForRpc(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* anvil is still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("anvil did not start");
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error(err || out));
    });
  });
}

describe("fil registry on a local chain", { skip: !ANVIL }, () => {
  let anvil: ChildProcess | null = null;

  it("deploys the calibration script and commits a folder through viem", async () => {
    anvil = spawn(ANVIL!, ["--port", String(PORT), "--chain-id", "314159", "--hardfork", "shanghai", "--silent"], { stdio: "ignore" });
    try {
      await waitForRpc();
      const output = await run(FORGE, [
        "script",
        "script/DeployCalibration.s.sol",
        "--rpc-url",
        "http://127.0.0.1:" + PORT,
        "--broadcast",
        "--private-key",
        KEY,
      ]);
      const address = (output.match(/FilRegistry (0x[a-fA-F0-9]{40})/)?.[1] ?? output.match(/Contract Address: (0x[a-fA-F0-9]{40})/)?.[1]) as Hex | undefined;
      assert.ok(address, output);
      const transport = http("http://127.0.0.1:" + PORT);
      const account = privateKeyToAccount(KEY);
      const writer = privateKeyToAccount(WRITER_KEY);
      const publicClient = createPublicClient({ chain: filecoinCalibration, transport });
      const walletClient = createWalletClient({ account, chain: filecoinCalibration, transport });
      const registry = contractRegistry({ address, publicClient, walletClient });
      const storage = memoryStore();
      const folders = new Folders({ storage, registry, owner: account.address });
      await folders.put("/Felarumi/Notes.felarumi", new TextEncoder().encode("signed-doc"));
      assert.equal(new TextDecoder().decode(await folders.get("/Felarumi/Notes.felarumi")), "signed-doc");
      const head = await registry.head(account.address, folders.app, folders.volume);
      assert.equal(head.version, 1n);
      await registry.setWriter(folders.app, writer.address, true);
      const writerRegistry = contractRegistry({
        address,
        publicClient,
        walletClient: createWalletClient({ account: writer, chain: filecoinCalibration, transport }),
      });
      const shared = new Folders({ storage, registry: writerRegistry, owner: account.address });
      await shared.put("/Felanumio/Budget.felanumio", new TextEncoder().encode("sheet"));
      assert.equal((await registry.head(account.address, folders.app, folders.volume)).version, 2n);
      const history = await folders.history("/");
      assert.equal(history.length, 2);
      await assert.rejects(() => registry.commit({
        owner: account.address,
        app: folders.app,
        key: folders.volume,
        pieceCid: "bafystale",
        prevPieceCid: "",
      }), /cas conflict/);
      assert.equal(new TextDecoder().decode(await folders.get("/Felanumio/Budget.felanumio")), "sheet");
    } finally {
      anvil?.kill();
    }
  });
});
