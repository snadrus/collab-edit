import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Folders, memoryBackend, memoryRegistry, memoryStore } from "../../packages/fil-folders/src/index.ts";
import { saveSnapshot, snapshotPath } from "../src/folder-save.ts";

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

describe("folder saves", () => {
  it("stores Felarumi and Felanumio snapshots on one volume", async () => {
    assert.equal(snapshotPath("felarumi", "My/Doc"), "/Felarumi/My Doc.felarumi");
    assert.equal(snapshotPath("felanumio", ""), "/Felanumio/Untitled.felanumio");
    const storage = memoryStore();
    const registry = memoryRegistry(memoryBackend(), OWNER);
    const doc = new TextEncoder().encode('{"kind":"felarumi-p2p","contentCid":"bafyunsigned"}');
    const book = new TextEncoder().encode('{"kind":"felanumio-p2p"}');
    const saved = await saveSnapshot({ kind: "felarumi", title: "Notes", bytes: doc, owner: OWNER, storage, registry });
    const sheet = await saveSnapshot({ kind: "felanumio", title: "Budget", bytes: book, owner: OWNER, storage, registry });
    assert.equal(saved.path, "/Felarumi/Notes.felarumi");
    assert.equal(sheet.path, "/Felanumio/Budget.felanumio");
    assert.notEqual(saved.rootCid, sheet.rootCid);
    const folders = new Folders({ storage, registry, owner: OWNER });
    assert.equal(new TextDecoder().decode(await folders.get(saved.path)), new TextDecoder().decode(doc));
    assert.equal(new TextDecoder().decode(await folders.get(sheet.path)), new TextDecoder().decode(book));
    assert.equal((await folders.ls("/Felarumi")).length, 1);
    assert.equal((await folders.ls("/Felanumio")).length, 1);
  });
});
