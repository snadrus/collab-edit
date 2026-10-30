import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientSync, ServerDoc } from "../src/shared/engine.ts";
import { EMBED } from "../src/shared/delta.ts";
import { applyDoc, docEqual, emptyDoc, plainText, restoreDoc, type Doc } from "../src/shared/doc.ts";
import { fromDocx, fromFelarumi, fromMarkdown, toDocx, toFelarumi, toMarkdown, toPdf, toText } from "../src/shared/io.ts";
import { insertedRanges, replaceDelta } from "../src/shared/replace.ts";
import { type Thread } from "../src/shared/threads.ts";
import { Store } from "../src/server/store.ts";

function docWith(ops: { t: "i"; s: string; a?: Record<string, string | number | boolean> }[]): Doc {
  return applyDoc(emptyDoc(), { ops });
}

const thread: Thread = {
  id: "cmtthread1",
  sid: "session-a",
  name: "Avery",
  color: "#1a73e8",
  text: "Please check the wording",
  ts: 1,
  quote: "Keep",
  resolved: false,
  replies: [{ id: "replythread1", sid: "session-b", name: "Blair", text: "On it", ts: 2 }],
};

test("replaceDelta round-trips text, bold, and a chip", () => {
  const current = docWith([{ t: "i", s: "old draft" }]);
  const target = docWith([
    { t: "i", s: "Hello", a: { b: true } },
    { t: "i", s: " " },
    { t: "i", s: EMBED, a: { embed: "person", label: "Ada" } },
  ]);
  const next = applyDoc(current, replaceDelta(current, target));
  assert.ok(docEqual(next, target));
  assert.equal(next.styles[0].b, true);
  assert.equal(next.styles[6].embed, "person");
  assert.equal(next.styles[6].label, "Ada");
  const again = applyDoc(next, replaceDelta(next, current));
  assert.ok(docEqual(again, current));
});

test("inserted ranges mark only the new middle", () => {
  assert.deepEqual(insertedRanges("\n", "First draft\n"), [{ start: 0, end: "First draft".length }]);
  assert.deepEqual(insertedRanges("First draft\n", "First draft MORE\n"), [{ start: "First draft".length, end: "First draft MORE".length }]);
});

test("felarumi export keeps chips, marks, and comments", () => {
  const doc = docWith([
    { t: "i", s: "Keep", a: { b: true, cmt: "cmtthread1" } },
    { t: "i", s: EMBED, a: { embed: "date", iso: "2026-10-30" } },
  ]);
  const raw = toFelarumi("Notes", doc, [thread]);
  const back = fromFelarumi(raw);
  assert.equal(back.title, "Notes");
  assert.ok(docEqual(back.doc, doc));
  assert.equal(back.threads.length, 1);
  assert.equal(back.threads[0].text, "Please check the wording");
  assert.equal(back.threads[0].replies[0].text, "On it");
  assert.equal(back.doc.styles[0].cmt, "cmtthread1");
  assert.equal(back.doc.styles[4].iso, "2026-10-30");
});

test("docx export and import keep plain text and bold", async () => {
  const doc = docWith([{ t: "i", s: "Hello", a: { b: true } }]);
  const back = await fromDocx(await toDocx(doc));
  assert.equal(plainText(back), "Hello");
  assert.equal(back.styles[0].b, true);
  assert.equal(back.styles[4].b, true);
});

test("markdown and plain text stay readable", () => {
  const doc = docWith([{ t: "i", s: "Hello", a: { b: true } }]);
  assert.match(toMarkdown(doc), /\*\*Hello\*\*/);
  assert.equal(toText(doc), "Hello");
  const md = fromMarkdown("# Title\n\nBody");
  assert.equal(plainText(md).includes("Title"), true);
  assert.equal(md.styles[md.text.indexOf("\n")].h, "h1");
  assert.ok(toPdf(doc, "Notes").byteLength > 100);
});

test("a reopened store replays the op log", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "felarumi-"));
  try {
    const store = new Store(dir);
    store.create("d1", "Notes");
    const server = new ServerDoc();
    const client = new ClientSync("sid-a");
    client.local({ ops: [{ t: "i", s: "Keep" }] });
    const wire = client.takeOutbound();
    assert.ok(wire);
    const res = server.submit("sid-a", wire.reqId, wire.baseRev, wire.delta);
    assert.equal(res.assignedRev, 1);
    store.appendOp("d1", res.assignedRev!, "sid-a", wire.reqId, res.delta, res.assignedRev, server.doc);
    store.noteVersion("d1", 1, 1_000, "sid-a", "Avery", "#e53935");
    store.noteVersion("d1", 2, 2_000, "sid-a", "Avery", "#e53935");
    assert.equal(store.versions("d1").length, 1);
    assert.equal(store.versions("d1")[0].rev, 2);
    store.nameVersion("d1", 2, 2_000, "sid-a", "Avery", "#e53935", "First");
    store.noteVersion("d1", 3, 3_000, "sid-a", "Avery", "#e53935");
    assert.deepEqual(store.versions("d1").map((v) => v.label).sort(), ["", "First"]);
    store.db.close();

    const reopened = new Store(dir);
    const loaded = reopened.load("d1");
    assert.ok(loaded);
    let doc = restoreDoc(loaded.snap);
    for (const op of loaded.ops) if (op.rev > loaded.snapRev) doc = applyDoc(doc, op.delta);
    assert.equal(plainText(doc), "Keep");
    assert.equal(reopened.versions("d1").some((v) => v.label === "First"), true);
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline edits replay through the server after a reload", () => {
  const server = new ServerDoc();
  const blair = new ClientSync("sid-b");
  blair.local({ ops: [{ t: "i", s: "X" }] });
  const blairWire = blair.takeOutbound()!;
  const blairRes = server.submit("sid-b", blairWire.reqId, blairWire.baseRev, blairWire.delta);
  blair.ack(blairWire.reqId, blairRes.assignedRev, blairRes.serverRev);

  const avery = new ClientSync("sid-a");
  avery.local({ ops: [{ t: "i", s: "Hello" }] });
  const queued = avery.exportQueue();
  assert.ok(queued);
  assert.equal(queued.transformed, false);

  const restored = new ClientSync("sid-a");
  restored.restoreUnacked(restoreDoc(queued.baseSnap), queued.baseRev, queued.inflight, queued.pending);
  assert.equal(plainText(restored.doc), "Hello");
  const catchup = server.log[0];
  restored.ingestRemote(catchup.delta, "sid-b", 1, catchup.reqId);
  const wire = restored.inflight!.wire;
  const res = server.submit("sid-a", wire.reqId, wire.baseRev, wire.delta);
  assert.equal(res.error, undefined);
  restored.ack(wire.reqId, res.assignedRev, res.serverRev);
  assert.equal(plainText(restored.doc), plainText(server.doc));
  assert.equal(plainText(server.doc).includes("Hello"), true);
  assert.equal(plainText(server.doc).includes("X"), true);
  assert.equal(restored.exportQueue(), null);
});
