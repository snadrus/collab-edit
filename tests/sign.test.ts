import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { DocSession } from "../p2p/src/docs-hub.ts";
import { EMBED, type Attrs } from "../src/shared/delta.ts";
import { type CharStyle, applyDoc, docIsSigned, emptyDoc, plainText, restoreDoc, snapshotDoc, splice } from "../src/shared/doc.ts";
import { ServerDoc } from "../src/shared/engine.ts";
import {
  CHAIN_CALIBRATION,
  CHAIN_MAINNET,
  applyAnchor,
  canonicalUnsigned,
  contentHashOf,
  signatureAttrs,
  signatureGate,
  typedDataFor,
  verifyStored,
  type AnchorState,
} from "../src/shared/sign.ts";

const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const DOC = "doc-sign";
const CID = "bafkzcibc4examplepiececidofunsigneddoc";
const OTHER = "bafkzcibc4otherpiececidthatdoesnotmatch";

function sigCount(doc: { text: string; styles: { embed?: string }[] }): number {
  let n = 0;
  for (let i = 0; i < doc.text.length; i++) if (doc.text[i] === EMBED && doc.styles[i]?.embed === "sig") n++;
  return n;
}

function bind(server: ServerDoc, docId = DOC): AnchorState {
  const state: AnchorState = { contentCid: "", locked: false };
  server.gate = signatureGate(docId, () => state);
  return state;
}

function anchor(state: AnchorState, doc: ReturnType<typeof emptyDoc>, phase: string, contentCid = ""): void {
  const next = applyAnchor(state, doc, phase, contentCid);
  assert.equal(next.error, undefined);
  state.contentCid = next.state.contentCid;
  state.locked = next.state.locked;
}

async function signedAttrs(
  doc: ReturnType<typeof emptyDoc>,
  name: string,
  key: Hex = KEY_A,
  chainId = CHAIN_MAINNET,
  docId = DOC,
  contentCid = CID,
): Promise<Attrs> {
  const account = privateKeyToAccount(key);
  const fields = {
    docId,
    contentHash: contentHashOf(doc),
    contentCid,
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
  it("verifies a wallet signature over one content cid and freezes every other op", async () => {
    const server = new ServerDoc(emptyDoc());
    const state = bind(server);
    const typed = server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Hello" }], 1));
    assert.equal(typed.error, undefined);
    const before = contentHashOf(server.doc);
    const unsigned = canonicalUnsigned(server.doc);
    const attrs = await signedAttrs(server.doc, "Ada Lovelace");
    assert.equal(server.submit("a", 2, server.rev, insertSig(server.doc, attrs)).error, "missing content cid");
    anchor(state, server.doc, "freeze");
    assert.equal(state.locked, true);
    anchor(state, server.doc, "cid", CID);
    const signed = server.submit("a", 3, server.rev, insertSig(server.doc, attrs));
    assert.equal(signed.error, undefined);
    assert.equal(docIsSigned(server.doc), true);
    assert.equal(contentHashOf(server.doc), before);
    assert.equal(canonicalUnsigned(server.doc), unsigned);
    assert.equal(server.doc.styles.find((style) => style.embed === "sig")?.cid, CID);
    assert.equal(verifyStored(styleFrom(attrs), DOC, before, CID), null);
    assert.equal(verifyStored(styleFrom(attrs), DOC, before, OTHER), "content cid mismatch");
    const rev = server.rev;
    const edit = server.submit("a", 4, rev, splice(0, 0, [{ t: "i", s: "X" }], server.doc.text.length));
    assert.equal(edit.error, "locked");
    assert.equal(server.rev, rev);
    assert.equal(plainText(server.doc).includes("X"), false);
    const restyle = server.submit("a", 5, rev, { ops: [{ t: "r", n: 1, a: { b: true } }] });
    assert.equal(restyle.error, "locked");
    const attrsB = await signedAttrs(server.doc, "Grace Hopper", KEY_B, CHAIN_CALIBRATION);
    const second = server.submit("b", 1, server.rev, insertSig(server.doc, attrsB));
    assert.equal(second.error, undefined);
    assert.equal(sigCount(server.doc), 2);
    assert.equal(server.doc.styles.filter((style) => style.embed === "sig").every((style) => style.cid === CID), true);
    const snap = snapshotDoc(server.doc);
    const restored = restoreDoc(snap);
    assert.equal(contentHashOf(restored), before);
    const again = new ServerDoc(restored);
    again.gate = signatureGate(DOC, () => ({ contentCid: CID, locked: true }));
    assert.equal(again.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Z" }], restored.text.length)).error, "locked");
  });

  it("rejects a tampered signature, a mismatched cid, and a stale content hash", async () => {
    const server = new ServerDoc(emptyDoc());
    const state = bind(server);
    server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Body" }], 1));
    const attrs = await signedAttrs(server.doc, "Ada Lovelace");
    const mixed = splice(0, 0, [{ t: "i", s: "Q" + EMBED, a: attrs }], server.doc.text.length);
    assert.equal(server.submit("a", 2, server.rev, mixed).error, "bad signature");
    anchor(state, server.doc, "cid", CID);
    assert.equal(server.submit("a", 3, server.rev, mixed).error, "locked");
    const tampered = { ...attrs, src: flip(String(attrs.src)) };
    const bad = server.submit("a", 4, server.rev, insertSig(server.doc, tampered));
    assert.equal(bad.error, "bad signature");
    assert.equal(docIsSigned(server.doc), false);
    const renamed = { ...attrs, label: "Eve" };
    assert.equal(server.submit("a", 5, server.rev, insertSig(server.doc, renamed)).error, "signer mismatch");
    const wrongCid = await signedAttrs(server.doc, "Ada Lovelace", KEY_A, CHAIN_MAINNET, DOC, OTHER);
    assert.equal(server.submit("a", 6, server.rev, insertSig(server.doc, wrongCid)).error, "content cid mismatch");
    const decoy = new ServerDoc(emptyDoc());
    decoy.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Other" }], 1));
    const staleHash = await signedAttrs(decoy.doc, "Ada Lovelace");
    assert.equal(server.submit("a", 7, server.rev, insertSig(server.doc, staleHash)).error, "content changed");
    const stale = await signedAttrs(server.doc, "Ada Lovelace");
    const staleDelta = insertSig(server.doc, stale);
    const rejected = server.submit("a", 8, server.rev - 1, staleDelta);
    assert.ok(rejected.error);
    assert.equal(docIsSigned(server.doc), false);
    assert.equal(applyAnchor(state, server.doc, "cid", OTHER).error, "content cid mismatch");
    assert.equal(state.contentCid, CID);
  });

  it("accepts two concurrent signatures of the same unsigned content and cid", async () => {
    const server = new ServerDoc(emptyDoc());
    const state = bind(server);
    server.submit("a", 1, 0, splice(0, 0, [{ t: "i", s: "Same" }], 1));
    anchor(state, server.doc, "cid", CID);
    const base = server.rev;
    const doc = server.doc;
    const first = insertSig(doc, await signedAttrs(doc, "Ada Lovelace"));
    const second = insertSig(doc, await signedAttrs(doc, "Grace Hopper", KEY_B));
    assert.equal(server.submit("b", 1, base, second).error, undefined);
    assert.equal(server.submit("a", 2, base, first).error, undefined);
    assert.equal(sigCount(server.doc), 2);
    const applied = applyDoc(doc, first);
    assert.equal(contentHashOf(applied), contentHashOf(doc));
    assert.equal(canonicalUnsigned(applied).includes("Ada Lovelace"), false);
  });

  it("drops a freeze when the upload aborts before a cid exists", async () => {
    const session = DocSession.create(DOC);
    const sock = { send(_data: string) {} };
    const conn = session.connect(sock, { sid: "a", name: "Ada" });
    const hello = splice(0, 0, [{ t: "i", s: "Hello" }], 1);
    assert.equal(session.server.submit("a", 1, 0, hello).error, undefined);
    session.handle(conn, { t: "anchor", phase: "freeze" });
    assert.equal(session.locked, true);
    assert.equal(session.contentCid, "");
    const early = await signedAttrs(session.server.doc, "Ada Lovelace");
    assert.equal(session.server.submit("a", 2, session.server.rev, insertSig(session.server.doc, early)).error, "missing content cid");
    session.handle(conn, { t: "anchor", phase: "abort" });
    assert.equal(session.locked, false);
    assert.equal(session.contentCid, "");
    assert.equal(session.server.submit("a", 3, session.server.rev, splice(0, 0, [{ t: "i", s: "!" }], session.server.doc.text.length)).error, undefined);
    session.handle(conn, { t: "anchor", phase: "freeze" });
    session.handle(conn, { t: "anchor", phase: "cid", contentCid: CID });
    assert.equal(session.contentCid, CID);
    assert.equal(session.locked, true);
    assert.equal(session.exportJson().includes(CID), true);
    session.handle(conn, { t: "anchor", phase: "abort" });
    assert.equal(session.locked, true);
    assert.equal(session.contentCid, CID);
    const ok = await signedAttrs(session.server.doc, "Ada Lovelace");
    assert.equal(session.server.submit("a", 4, session.server.rev, insertSig(session.server.doc, ok)).error, undefined);
    const mismatch = await signedAttrs(session.server.doc, "Grace Hopper", KEY_B, CHAIN_MAINNET, DOC, OTHER);
    assert.equal(session.server.submit("b", 1, session.server.rev, insertSig(session.server.doc, mismatch)).error, "content cid mismatch");
    assert.equal(sigCount(session.server.doc), 1);
  });
});

function styleFrom(attrs: Attrs): { embed: CharStyle["embed"]; label: string; alt: string; iso: string; val: string; src: string; opts: string; cid: string } {
  return {
    embed: "sig",
    label: String(attrs.label),
    alt: String(attrs.alt),
    iso: String(attrs.iso),
    val: String(attrs.val),
    src: String(attrs.src),
    opts: String(attrs.opts),
    cid: String(attrs.cid),
  };
}

function flip(hex: string): string {
  const chars = hex.split("");
  chars[10] = chars[10] === "a" ? "b" : "a";
  return chars.join("");
}

describe("v2 signatures carry a plain-language purpose (Andy decision 5)", () => {
  async function sign(purpose: string | undefined) {
    const doc = restoreDoc({ text: "Lease for 12 Elm St", runs: [{ n: 19, s: {} }] });
    const account = privateKeyToAccount(KEY_A);
    const fields = {
      ...(purpose !== undefined ? { purpose } : {}),
      docId: DOC,
      contentHash: contentHashOf(doc),
      contentCid: CID,
      signerName: "Andy",
      signer: account.address,
      timestamp: 1700000000000n,
      chainId: CHAIN_CALIBRATION,
    };
    const signature = await account.signTypedData(typedDataFor(fields) as never);
    return { doc, attrs: signatureAttrs({ ...fields, signature }) };
  }
  it("v2 verifies, names its purpose and uses domain version 2", async () => {
    const { doc, attrs } = await sign("I approve this lease");
    assert.equal(attrs.pur, "I approve this lease");
    assert.equal(verifyStored(attrs as CharStyle, DOC, contentHashOf(doc), CID), null);
    assert.equal(typedDataFor({ purpose: "x", docId: DOC, contentHash: "", contentCid: CID, signerName: "a", signer: "0x0000000000000000000000000000000000000001", timestamp: 1n, chainId: CHAIN_CALIBRATION }).domain.version, "2");
  });
  it("a changed purpose no longer verifies", async () => {
    const { doc, attrs } = await sign("I approve this lease");
    assert.equal(verifyStored({ ...(attrs as CharStyle), pur: "I reject this lease" }, DOC, contentHashOf(doc), CID), "signer mismatch");
  });
  it("old v1 signatures (no purpose) still verify", async () => {
    const { doc, attrs } = await sign(undefined);
    assert.equal(attrs.pur, undefined);
    assert.equal(verifyStored(attrs as CharStyle, DOC, contentHashOf(doc), CID), null);
    // Adding a purpose to a v1 signature must not verify (it would be a forged statement).
    assert.notEqual(verifyStored({ ...(attrs as CharStyle), pur: "anything" }, DOC, contentHashOf(doc), CID), null);
  });
});
