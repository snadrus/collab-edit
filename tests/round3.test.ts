import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/server/store.ts";
import { caseDelta, transformCase } from "../src/shared/case.ts";
import { canon } from "../src/shared/commands.ts";
import { CELL, ROW } from "../src/shared/delta.ts";
import { applyDoc, emptyDoc, paragraphStyle, plainText } from "../src/shared/doc.ts";
import { parseEquation } from "../src/shared/equation.ts";
import { applyReplacement, findRanges } from "../src/shared/find.ts";
import { insertSectionDelta, setColumnsDelta, textColumns } from "../src/shared/section.ts";

test("columns skip table rows and section breaks survive canon", () => {
  let doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "Alpha\nBeta\nx" + CELL + "y" + ROW }] });
  const row = doc.text.lastIndexOf(ROW);
  doc = applyDoc(doc, { ops: [{ t: "r", n: row }, { t: "r", n: 1, a: { cols: 3 } }] });
  doc = applyDoc(doc, setColumnsDelta(doc, 0, 2));
  assert.equal(textColumns(paragraphStyle(doc, 0)), 2);
  assert.equal(doc.styles[row].cols, 3);
  doc = applyDoc(doc, canon(insertSectionDelta(doc, 0, "cont")));
  assert.equal(doc.text.includes("\f"), true);
  assert.equal(doc.styles.some((style) => style.sec === "cont"), true);
  doc = applyDoc(doc, setColumnsDelta(doc, 0, 1));
  assert.equal(paragraphStyle(doc, 0).cols, undefined);
});

test("capitalization keeps marks and small caps survive canon", () => {
  assert.equal(transformCase("don't stop", "title"), "Don't Stop");
  let doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "Hello", a: { b: true } }] });
  doc = applyDoc(doc, caseDelta(doc, 0, 5, "upper")!);
  assert.equal(plainText(doc), "HELLO");
  assert.equal(doc.styles[0].b, true);
  doc = applyDoc(doc, caseDelta(doc, 0, 5, "lower")!);
  assert.equal(plainText(doc), "hello");
  doc = applyDoc(doc, canon({ ops: [{ t: "r", n: 5, a: { sc: true } }] }));
  assert.equal(doc.styles[0].sc, true);
  assert.equal(doc.styles[doc.text.length - 1].sc, undefined);
});

test("regex find and replacement groups", () => {
  const text = "Hello world";
  assert.deepEqual(findRanges(text, "H.llo", true), [{ start: 0, end: 5 }]);
  assert.deepEqual(findRanges(text, "[", true), []);
  assert.equal(findRanges(text, "hello", false)[0].end, 5);
  assert.equal(applyReplacement("Hello world", "(\\w+) (\\w+)", "$2 $1", true), "world Hello");
  assert.equal(applyReplacement("Hello", "x", "y", false), "y");
});

test("equations parse fractions, roots, and symbols", () => {
  const frac = parseEquation("\\frac{a}{b}");
  assert.equal(frac.kids?.[0].t, "frac");
  assert.equal(parseEquation("\\sqrt{x}").kids?.[0].t, "sqrt");
  const sup = parseEquation("E=mc^2");
  const script = JSON.stringify(sup);
  assert.equal(script.includes('"t":"script"'), true);
  assert.equal(parseEquation("\\pi").kids?.[0].s, "π");
  assert.equal(parseEquation("").kids?.[0].s, "□");
});

test("tabs, trash, and share roles persist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "felarumi-"));
  try {
    const store = new Store(dir);
    store.create("doc", "Notes");
    const share = store.tokensFor("doc");
    assert.equal(store.roleFor("doc", ""), "edit");
    assert.equal(store.roleFor("doc", share.tokens.view), "view");
    assert.equal(store.roleFor("doc", share.tokens.comment), "comment");
    store.setAccess("doc", "view");
    assert.equal(store.roleFor("doc", ""), "view");
    assert.equal(store.roleFor("doc", share.tokens.edit), "edit");
    store.addTab("doc", "tab2", "Sources");
    assert.deepEqual(store.tabs("doc").map((tab) => tab.title), ["Tab 1", "Sources"]);
    assert.equal(store.list().some((row) => row.id === "tab2"), false);
    store.trash("doc");
    assert.equal(store.list().length, 0);
    assert.equal(store.listTrash()[0].id, "doc");
    assert.equal(store.roleFor("doc", share.tokens.edit), "view");
    const again = new Store(dir);
    assert.equal(again.trashedAt("doc") > 0, true);
    again.restore("doc");
    assert.equal(again.list()[0].id, "doc");
    again.purge("doc");
    assert.equal(again.exists("doc"), false);
    assert.equal(again.exists("tab2"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
