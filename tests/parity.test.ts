import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/server/store.ts";
import { applyDoc, emptyDoc, plainText } from "../src/shared/doc.ts";
import { moveParagraphDelta } from "../src/shared/edit.ts";
import { normalizePage } from "../src/shared/page.ts";
import { autocorrectSpan, misspellings, suggestions } from "../src/shared/spell.ts";

test("page setup swaps landscape paper and clamps margins", () => {
  const page = normalizePage({ paper: "a4", orient: "landscape", ml: 10, mr: 400 });
  assert.equal(page.w > page.h, true);
  assert.equal(page.paper, "a4");
  assert.equal(page.ml, 36);
  assert.equal(page.mr, 288);
  assert.equal(normalizePage({}).w, 816);
});

test("spellcheck flags an unknown word and suggests the transposition", () => {
  const dictionary = new Set(["the", "and", "line"]);
  const hits = misspellings("Teh line\n", dictionary, new Set());
  assert.deepEqual(hits.map((hit) => hit.word), ["Teh"]);
  assert.equal(suggestions("teh", dictionary)[0], "the");
});

test("autocorrect rewrites a finished typo and a symbol", () => {
  assert.deepEqual(autocorrectSpan("teh ", 4, { teh: "the", "...": "…" }), { start: 0, end: 3, value: "the" });
  assert.deepEqual(autocorrectSpan("See ...", 7, { "...": "…" }), { start: 4, end: 7, value: "…" });
});

test("moving a paragraph keeps the sentinel newline", () => {
  const doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "AAA\nBBB" }] });
  const delta = moveParagraphDelta(doc, doc.text.indexOf("BBB"), -1);
  assert.ok(delta);
  const next = applyDoc(doc, delta);
  assert.equal(plainText(next), "BBB\nAAA");
  assert.equal(next.text.endsWith("\n"), true);
  const back = moveParagraphDelta(next, 0, 1);
  assert.ok(back);
  assert.equal(plainText(applyDoc(next, back)), "AAA\nBBB");
});

test("saved page setup reloads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "felarumi-page-"));
  try {
    const store = new Store(dir);
    store.create("d", "T");
    const page = normalizePage({ paper: "legal", orient: "landscape", ml: 72 });
    assert.equal(store.setPage("d", page, 5), true);
    store.db.close();
    const again = new Store(dir);
    const loaded = again.loadPage("d");
    assert.equal(loaded.page.orient, "landscape");
    assert.equal(loaded.page.paper, "legal");
    assert.equal(loaded.page.ml, 72);
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
