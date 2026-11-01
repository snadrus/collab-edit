import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import {
  FIL_FOLDERS_APP,
  Folders,
  KEY_MESSAGE,
  bytesToCid,
  cidToBytes,
  encryptionKeyFromWallet,
  memoryBackend,
  memoryRegistry,
  memoryStore,
  type CommitArgs,
  type FolderRegistry,
} from "../src/index.ts";

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WRITER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function open(): { folders: Folders; registry: FolderRegistry } {
  const registry = memoryRegistry(memoryBackend(), OWNER);
  const folders = new Folders({ storage: memoryStore(), registry, owner: OWNER });
  return { folders, registry };
}

describe("fil-folders", () => {
  it("stays free of app imports", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files = readdirSync(path.join(root, "src")).filter((name) => name.endsWith(".ts"));
    for (const name of files) {
      const source = readFileSync(path.join(root, "src", name), "utf8");
      assert.equal(/from\s+["'][^"']*\/(src|p2p|apps)\//.test(source), false, name);
    }
  });

  it("mkdir, put, get, ls, mv, rm, and stat a tree", async () => {
    const { folders, registry } = open();
    await folders.mkdir("/Felarumi");
    const again = await registry.head(OWNER, folders.app, folders.volume);
    await folders.mkdir("/Felarumi");
    const same = await registry.head(OWNER, folders.app, folders.volume);
    assert.equal(same.version, again.version);
    const stat = await folders.put("/Felarumi/Notes.felarumi", utf8("hello"), { mime: "application/vnd.felarumi+json" });
    assert.equal(text(await folders.get("/Felarumi/Notes.felarumi")), "hello");
    assert.equal(stat.mime, "application/vnd.felarumi+json");
    assert.equal(stat.size, 5);
    const names = (await folders.ls("/Felarumi")).map((entry) => entry.name);
    assert.deepEqual(names, ["Notes.felarumi"]);
    await folders.mv("/Felarumi/Notes.felarumi", "/Felanumio/Notes.felanumio");
    assert.equal(text(await folders.get("/Felanumio/Notes.felanumio")), "hello");
    await assert.rejects(() => folders.stat("/Felarumi/Notes.felarumi"), /missing path/);
    await folders.rm("/Felanumio/Notes.felanumio");
    await assert.rejects(() => folders.get("/Felanumio/Notes.felanumio"), /missing path/);
  });

  it("keeps history from registry commits", async () => {
    const { folders } = open();
    await folders.put("/Felarumi/A.felarumi", utf8("one"));
    await folders.put("/Felarumi/A.felarumi", utf8("two"));
    const history = await folders.history("/Felarumi/A.felarumi");
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 1n);
    assert.equal(history[1].version, 2n);
    assert.notEqual(history[0].pieceCid, history[1].pieceCid);
    assert.equal(text(await folders.get("/Felarumi/A.felarumi")), "two");
    assert.equal((await folders.history("/")).length, 2);
  });

  it("retries and merges when another commit wins the head", async () => {
    const backend = memoryBackend();
    const store = memoryStore();
    const registry = memoryRegistry(backend, OWNER);
    const first = new Folders({ storage: store, registry, owner: OWNER });
    await first.put("/Felarumi/a.felarumi", utf8("a"));
    let raced = false;
    const racing: FolderRegistry = {
      head: (owner, app, key) => registry.head(owner, app, key),
      history: (owner, app, key) => registry.history(owner, app, key),
      setWriter: (app, writer, allowed) => registry.setWriter(app, writer, allowed),
      commit: async (args: CommitArgs) => {
        if (!raced) {
          raced = true;
          const other = new Folders({ storage: store, registry, owner: OWNER });
          await other.put("/Felanumio/b.felanumio", utf8("b"));
        }
        return registry.commit(args);
      },
    };
    const second = new Folders({ storage: store, registry: racing, owner: OWNER });
    await second.put("/Felarumi/c.felarumi", utf8("c"));
    assert.equal(text(await second.get("/Felarumi/a.felarumi")), "a");
    assert.equal(text(await second.get("/Felanumio/b.felanumio")), "b");
    assert.equal(text(await second.get("/Felarumi/c.felarumi")), "c");
    assert.equal(raced, true);
  });

  it("lets an approved writer commit into the owner volume", async () => {
    const backend = memoryBackend();
    const store = memoryStore();
    const ownerRegistry = memoryRegistry(backend, OWNER);
    const writerRegistry = memoryRegistry(backend, WRITER);
    await ownerRegistry.setWriter(FIL_FOLDERS_APP, WRITER, true);
    const folders = new Folders({ storage: store, registry: writerRegistry, owner: OWNER });
    await folders.put("/Felarumi/shared.felarumi", utf8("shared"));
    const head = await ownerRegistry.head(OWNER, FIL_FOLDERS_APP, folders.volume);
    assert.equal(head.version, 1n);
    assert.equal(text(await folders.get("/Felarumi/shared.felarumi")), "shared");
    const stranger = new Folders({ storage: store, registry: memoryRegistry(backend, "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"), owner: OWNER });
    await assert.rejects(() => stranger.put("/Felarumi/nope.felarumi", utf8("no")), /not allowed/);
  });

  it("encrypts file bytes with a key derived from a wallet signature", async () => {
    const account = privateKeyToAccount(KEY);
    const encryptionKey = await encryptionKeyFromWallet((message) => account.signMessage({ message }));
    assert.equal(KEY_MESSAGE.includes("fil-folders"), true);
    const store = memoryStore();
    const registry = memoryRegistry(memoryBackend(), OWNER);
    const folders = new Folders({ storage: store, registry, owner: OWNER, encryptionKey });
    await folders.put("/Felarumi/secret.felarumi", utf8("plaintext"));
    const stat = await folders.stat("/Felarumi/secret.felarumi");
    assert.equal(stat.encryption?.alg, "AES-GCM");
    const stored = await store.get(stat.pieceCid);
    assert.equal(text(stored).includes("plaintext"), false);
    assert.equal(text(await folders.get("/Felarumi/secret.felarumi")), "plaintext");
    const locked = new Folders({ storage: store, registry, owner: OWNER });
    await assert.rejects(() => locked.get("/Felarumi/secret.felarumi"), /encrypted/);
    assert.equal(bytesToCid(cidToBytes("bafyexample")), "bafyexample");
    assert.equal(bytesToCid("0x"), "");
  });
});
