import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/server/store.ts";
import { canon } from "../src/shared/commands.ts";
import { type Delta, transform } from "../src/shared/delta.ts";
import { applyDoc, emptyDoc, paragraphStyle, plainText } from "../src/shared/doc.ts";
import { ServerDoc } from "../src/shared/engine.ts";
import { normalizePage } from "../src/shared/page.ts";
import { acceptDelta, deletionDelta, rejectDelta, suggestionSpans } from "../src/shared/suggest.ts";
import { headingsOf, insertTocDelta, updateTocDelta } from "../src/shared/toc.ts";

function ids(): () => string {
  let n = 0;
  return () => "bm" + ++n + "xxxx";
}

test("suggestion marks survive canon and a concurrent insert", () => {
  const server = new ServerDoc(emptyDoc());
  const insert = canon({ ops: [{ t: "i", s: "Hello", a: { sug: "sugone" } }] });
  const bang = canon({ ops: [{ t: "i", s: "!" }] });
  const first = server.submit("a", 1, 0, insert);
  const second = server.submit("b", 1, 0, bang);
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(server.doc.styles.some((style) => style.sug === "sugone"), true);
  assert.equal(server.doc.text.includes("Hello"), true);
  assert.equal(server.doc.text.includes("!"), true);

  const base = applyDoc(emptyDoc(), insert);
  const other = canon({ ops: [{ t: "r", n: 5 }, { t: "i", s: "!" }] });
  const left = applyDoc(applyDoc(base, other), transform(canon({ ops: [{ t: "i", s: "X", a: { sug: "sugtwo" } }] }), other, false));
  const right = applyDoc(applyDoc(base, canon({ ops: [{ t: "i", s: "X", a: { sug: "sugtwo" } }] })), transform(other, canon({ ops: [{ t: "i", s: "X", a: { sug: "sugtwo" } }] }), true));
  assert.equal(left.text, right.text);
  assert.equal(left.styles[left.text.indexOf("X")].sug, "sugtwo");
});

test("accept and reject keep the sentinel and the other mark", () => {
  const inserted = applyDoc(emptyDoc(), canon({ ops: [{ t: "i", s: "Hello", a: { sug: "sugone" } }] }));
  const marked = applyDoc(inserted, deletionDelta(inserted, 0, 5, "delone", new Set()) as Delta);
  assert.equal(marked.text.startsWith("Hello"), true);
  assert.equal(marked.styles[0].del, "delone");
  assert.equal(marked.styles[0].sug, "sugone");
  const acceptedDel = applyDoc(marked, acceptDelta(marked, "delone") as Delta);
  assert.equal(plainText(acceptedDel), "");
  assert.equal(acceptedDel.text, "\n");
  const rejectedDel = applyDoc(marked, rejectDelta(marked, "delone") as Delta);
  assert.equal(rejectedDel.styles[0].del, undefined);
  assert.equal(rejectedDel.styles[0].sug, "sugone");
  const acceptedIns = applyDoc(rejectedDel, acceptDelta(rejectedDel, "sugone") as Delta);
  assert.equal(acceptedIns.styles[0].sug, undefined);
  assert.equal(plainText(acceptedIns), "Hello");
  const rejectedIns = applyDoc(inserted, rejectDelta(inserted, "sugone") as Delta);
  assert.equal(rejectedIns.text, "\n");
  assert.equal(suggestionSpans(acceptedIns).length, 0);
});

test("table of contents links to heading 4 and updates", () => {
  let doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "Chapter\nBody" }] });
  const br = doc.text.indexOf("\n");
  doc = applyDoc(doc, { ops: [{ t: "r", n: br }, { t: "r", n: 1, a: { h: "h4" } }] });
  doc = applyDoc(doc, insertTocDelta(doc, 0, ids()));
  const heads = headingsOf(doc);
  assert.equal(heads[0].text, "Chapter");
  assert.equal(heads[0].level, 4);
  assert.equal(heads[0].bm.startsWith("bm"), true);
  assert.equal(doc.styles.some((style) => style.link === "#" + heads[0].bm), true);
  assert.equal(doc.styles.some((style) => style.toc === true), true);
  const body = doc.text.indexOf("Body");
  doc = applyDoc(doc, { ops: [{ t: "r", n: body }, { t: "i", s: " line" }] });
  const chapter = doc.text.lastIndexOf("Chapter");
  doc = applyDoc(doc, { ops: [{ t: "r", n: chapter + "Chapter".length }, { t: "i", s: "s" }] });
  doc = applyDoc(doc, updateTocDelta(doc, ids()) as Delta);
  assert.equal(doc.text.includes("Chapters"), true);
  assert.equal((doc.text.match(/Chapters/g) || []).length, 2);
});

test("custom spacing and a header survive canon and reload", () => {
  const styled = applyDoc(emptyDoc(), canon({ ops: [{ t: "i", s: "A" }, { t: "r", n: 1, a: { h: "h5", sb: 8, sa: 4, lh: 1.4 } }] }));
  const para = paragraphStyle(styled, 0);
  assert.equal(para.h, "h5");
  assert.equal(para.sb, 8);
  assert.equal(para.sa, 4);
  assert.equal(para.lh, 1.4);
  const page = normalizePage({ pageless: true, header: "Notes", footer: "{page}", differentFirst: true, headerFirst: "Cover" });
  assert.equal(page.pageless, true);
  assert.equal(page.header, "Notes");
  assert.equal(page.footer, "{page}");
  assert.equal(page.headerFirst, "Cover");
  const dir = mkdtempSync(path.join(tmpdir(), "felarumi-round-"));
  try {
    const store = new Store(dir);
    store.create("d", "T");
    assert.equal(store.setPage("d", page, 3), true);
    store.saveSuggestion("d", { id: "sugone", sid: "session", name: "Avery", color: "#1e88e5", ts: 1 });
    store.db.close();
    const again = new Store(dir);
    assert.equal(again.loadPage("d").page.pageless, true);
    assert.equal(again.loadPage("d").page.header, "Notes");
    assert.equal(again.loadSuggestions("d")[0].name, "Avery");
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
