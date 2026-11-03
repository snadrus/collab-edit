import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDoc, emptyDoc, splice, type Doc } from "../src/shared/doc.ts";
import { transform } from "../src/shared/delta.ts";
import { addTabDelta, deleteTabDelta, moveTabDelta, renameTabDelta, tabText, tabsOf, tocOf, FIRST_TAB_ID } from "../src/shared/tabs.ts";

const typed = (doc: Doc, at: number, s: string) => applyDoc(doc, splice(at, at, [{ t: "i", s }], doc.text.length));
const names = (doc: Doc) => tabsOf(doc).map((t) => t.name + ":" + tabText(doc, t));

describe("document tabs", () => {
  it("an old document is one tab", () => {
    const doc = typed(emptyDoc(), 0, "hello");
    assert.deepEqual(tabsOf(doc).map((t) => [t.id, t.name, t.from, t.end]), [[FIRST_TAB_ID, "Tab 1", 0, 6]]);
  });
  it("adds, renames, reorders and deletes tabs; bodies stay separate", () => {
    let doc = typed(emptyDoc(), 0, "one");
    doc = applyDoc(doc, addTabDelta(doc, { id: "t.b" }));
    const b = tabsOf(doc)[1];
    doc = typed(doc, b.from, "two");
    assert.deepEqual(names(doc), ["Tab 1:one", "Tab 2:two"]);
    doc = applyDoc(doc, renameTabDelta(doc, FIRST_TAB_ID, "Intro")!);
    assert.deepEqual(names(doc), ["Intro:one", "Tab 2:two"]);
    doc = applyDoc(doc, addTabDelta(doc, { id: "t.c", afterId: "t.b", child: true, name: "Kid" }));
    doc = typed(doc, tabsOf(doc)[2].from, "kid");
    assert.equal(tabsOf(doc)[2].level, 1);
    doc = applyDoc(doc, moveTabDelta(doc, "t.b", -1)!);
    assert.deepEqual(names(doc), ["Tab 2:two", "Kid:kid", "Intro:one"]);
    assert.ok(doc.text.endsWith("\n"));
    doc = applyDoc(doc, moveTabDelta(doc, "t.b", { beforeId: null })!);
    assert.deepEqual(names(doc), ["Intro:one", "Tab 2:two", "Kid:kid"]);
    doc = applyDoc(doc, deleteTabDelta(doc, "t.b")!);
    assert.deepEqual(names(doc), ["Intro:one"]);
    assert.equal(deleteTabDelta(doc, tabsOf(doc)[0].id), null);
  });
  it("deleting the first tab promotes the next", () => {
    let doc = typed(emptyDoc(), 0, "a");
    doc = applyDoc(doc, addTabDelta(doc, { id: "t.b", name: "B" }));
    doc = typed(doc, tabsOf(doc)[1].from, "b");
    doc = applyDoc(doc, deleteTabDelta(doc, FIRST_TAB_ID)!);
    assert.deepEqual(names(doc), ["B:b"]);
  });
  it("two users adding tabs at once both keep them", () => {
    const base = typed(emptyDoc(), 0, "x");
    const a = addTabDelta(base, { id: "t.a", name: "A" });
    const b = addTabDelta(base, { id: "t.b", name: "B" });
    const left = applyDoc(applyDoc(base, a), transform(b, a, false));
    const right = applyDoc(applyDoc(base, b), transform(a, b, true));
    assert.equal(left.text, right.text);
    assert.deepEqual(tabsOf(left).map((t) => t.name).sort(), ["A", "B", "Tab 1"]);
  });
  it("toc lists H1-H3 of its own tab", () => {
    let doc = typed(emptyDoc(), 0, "Head\nbody");
    doc = applyDoc(doc, { ops: [{ t: "r", n: 4 }, { t: "r", n: 1, a: { h: "h1" } }, { t: "r", n: doc.text.length - 5 }] });
    doc = applyDoc(doc, addTabDelta(doc, { id: "t.b" }));
    assert.deepEqual(tocOf(doc, tabsOf(doc)[0]).map((e) => e.text), ["Head"]);
    assert.deepEqual(tocOf(doc, tabsOf(doc)[1]), []);
  });
});
