import assert from "node:assert/strict";
import test from "node:test";
import { applyDoc, chipLabel, emptyDoc } from "../src/shared/doc.ts";
import { normalizePage } from "../src/shared/page.ts";
import { misspellings } from "../src/shared/spell.ts";
import { bibliographyLines, citeChip, citeLabel, diffWords, encodeStrokes, lookupWord, parseChart, parseCite, parseStrokes } from "../src/shared/tools.ts";

test("dictionary lookup stays local when the word is known", () => {
  assert.equal(lookupWord("citation")?.definition.includes("source"), true);
  assert.equal(lookupWord("xyzzy"), null);
  assert.equal(lookupWord("  The ")?.word, "the");
});

test("word diff marks the changed word and keeps the rest", () => {
  const parts = diffWords("The cat sat.", "The dog sat.");
  assert.deepEqual(
    parts.map((part) => part.kind + ":" + part.text),
    ["same:The ", "del:cat", "add:dog", "same: sat."],
  );
});

test("spellcheck skips urls, acronyms, contractions, and short hyphen parts", () => {
  const dictionary = new Set(["the", "line", "do", "visit", "existing", "stop", "now"]);
  const text = "Visit https://example.com/Teh now. NASA don't stop the pre-existing line's end.";
  const words = misspellings(text, dictionary, new Set()).map((hit) => hit.word);
  assert.deepEqual(words, ["end"]);
});

test("watermark survives page normalization", () => {
  const page = normalizePage({ watermark: " Draft \ncopy " });
  assert.equal(page.watermark, "Draft  copy");
  assert.equal(normalizePage({}).watermark, "");
});

test("charts, drawings, and citations round-trip their stored form", () => {
  assert.deepEqual(parseChart("North 10; South,4"), [
    { name: "North", value: 10 },
    { name: "South", value: 4 },
  ]);
  const strokes = encodeStrokes([
    [
      [0, 0],
      [50, 100],
    ],
  ]);
  assert.deepEqual(parseStrokes(strokes), [
    [
      [0, 0],
      [50, 100],
    ],
  ]);
  const label = citeLabel("Ada Lovelace", "1843", "Notes");
  assert.equal(citeChip(label), "(Lovelace, 1843)");
  assert.deepEqual(bibliographyLines([label, label]), ["Ada Lovelace (1843). Notes."]);
  const doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "\uFFFC", a: { embed: "cite", label } }] });
  assert.equal(chipLabel(doc.styles[0]), "(Lovelace, 1843)");
  assert.equal(parseCite(label).author, "Ada Lovelace");
});
