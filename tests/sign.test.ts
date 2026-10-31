import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { EMBED, type Attrs } from "../src/shared/delta.ts";
import { applyDoc, docIsSigned, emptyDoc, plainText, restoreDoc, snapshotDoc, splice } from "../src/shared/doc.ts";
import { ServerDoc } from "../src/shared/engine.ts";
import {
  CHAIN_CALIBRATION,
  CHAIN_MAINNET,
  contentHashOf,
  signatureAttrs,
  signatureGate,
  typedDataFor,
  verifyStored,
  type StoredSignature,
} from "../src/shared/sign.ts";

const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const DOC = "doc-sign";

function sigCount(doc: { text: string; styles: { embed?: string }[] }): number {
  let n = 0;
  for (let i = 0; i < doc.text.length; i++) if (doc.text[i] === EMBED && doc.styles[i]?.embed === "sig") n++;
  return n;
}

async function signedAttrs(doc: ReturnType<typeof emptyDoc>, name: string, key: Hex = KEY_A, chainId = CHAIN_MAINNET, docId = DOC): Promise<Attrs> {
  const account = privateKeyToAccount(key);
  const fields = {
    docId,
    contentHash: contentHashOf(doc),
    signerName: name,
    signer: account.address,
    timestamp: 1_700_000_000_000n,
    chainId,
  };
  const signature = await account.signTypedData(typedDataFor(fields));
  return signatureAttrs({ ...fields, signature });
}

function insertSig(doc: ReturnType<typeof emptyDoc>, attrs: Attrs) {
  const at = Math.max(0, doc.text.length - 1);
  return splice(at, at, [{ t: "i", s: EMBED, a: attrs }], doc.text.length);
}

describe("document signatures", () => {
  it("verifies a wallet signature and freezes every other op", async () => {
    const server = new ServerDoc(emptyDoc());
    server.gate = signatureGate(DOC);
    const typed = server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Hello" }], 1));
    assert.equal(typed.error, undefined);
    const before = contentHashOf(server.doc);
    const attrs = await signedAttrs(server.doc, "Ada Lovelace");
    const signed = server.submit("a", 2, server.rev, insertSig(server.doc, attrs));
    assert.equal(signed.error, undefined);
    assert.equal(docIsSigned(server.doc), true);
    assert.equal(contentHashOf(server.doc), before);
    assert.equal(verifyStored(styleFrom(attrs), DOC, before), null);
    const rev = server.rev;
    const edit = server.submit("a", 3, rev, splice(0, 0, [{ t: "i", s: "X" }], server.doc.text.length));
    assert.equal(edit.error, "locked");
    assert.equal(server.rev, rev);
    assert.equal(plainText(server.doc).includes("X"), false);
    const restyle = server.submit("a", 4, rev, { ops: [{ t: "r", n: 1, a: { b: true } }] });
    assert.equal(restyle.error, "locked");
    const attrsB = await signedAttrs(server.doc, "Grace Hopper", KEY_B, CHAIN_CALIBRATION);
    const second = server.submit("b", 1, server.rev, insertSig(server.doc, attrsB));
    assert.equal(second.error, undefined);
    assert.equal(sigCount(server.doc), 2);
    const snap = snapshotDoc(server.doc);
    const restored = restoreDoc(snap);
    assert.equal(contentHashOf(restored), before);
    const again = new ServerDoc(restored);
    again.gate = signatureGate(DOC);
    assert.equal(again.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Z" }], restored.text.length)).error, "locked");
  });

  it("rejects a tampered signature and a stale content hash", async () => {
    const server = new ServerDoc(emptyDoc());
    server.gate = signatureGate(DOC);
    server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Body" }], 1));
    const attrs = await signedAttrs(server.doc, "Ada Lovelace");
    const tampered = { ...attrs, src: flip(String(attrs.src)) };
    const bad = server.submit("a", 2, server.rev, insertSig(server.doc, tampered));
    assert.equal(bad.error, "bad signature");
    assert.equal(docIsSigned(server.doc), false);
    const renamed = { ...attrs, label: "Eve" };
    assert.equal(server.submit("a", 3, server.rev, insertSig(server.doc, renamed)).error, "signer mismatch");
    const staleDoc = server.doc;
    const stale = await signedAttrs(staleDoc, "Ada Lovelace");
    const staleDelta = insertSig(staleDoc, stale);
    server.submit("z", 1, server.rev, splice(0, 0, [{ t: "i", s: "Z" }], server.doc.text.length));
    const rejected = server.submit("a", 4, server.rev - 1, staleDelta);
    assert.ok(rejected.error);
    assert.equal(docIsSigned(server.doc), false);
    const mixed = splice(0, 0, [{ t: "i", s: "Q" + EMBED, a: attrs }], server.doc.text.length);
    assert.equal(server.submit("a", 5, server.rev, mixed).error, "bad signature");
  });

  it("accepts two concurrent signatures of the same unsigned content", async () => {
    const server = new ServerDoc(emptyDoc());
    server.gate = signatureGate(DOC);
    server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Same" }], 1));
    const base = server.rev;
    const doc = server.doc;
    const first = insertSig(doc, await signedAttrs(doc, "Ada Lovelace"));
    const second = insertSig(doc, await signedAttrs(doc, "Grace Hopper", KEY_B));
    assert.equal(server.submit("b", 1, base, second).error, undefined);
    assert.equal(server.submit("a", 2, base, first).error, undefined);
    assert.equal(sigCount(server.doc), 2);
    const applied = applyDoc(doc, first);
    assert.equal(contentHashOf(applied), contentHashOf(doc));
  });
});

function styleFrom(attrs: Attrs): StoredSignature | { embed?: string; label?: string; alt?: string; iso?: string; val?: string; src?: string; opts?: string } {
  return {
    embed: "sig",
    label: String(attrs.label),
    alt: String(attrs.alt),
    iso: String(attrs.iso),
    val: String(attrs.val),
    src: String(attrs.src),
    opts: String(attrs.opts),
  };
}

function flip(hex: string): string {
  const chars = hex.split("");
  chars[10] = chars[10] === "a" ? "b" : "a";
  return chars.join("");
}
