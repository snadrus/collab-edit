import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadHunspell, spellHits, spellSuggestions } from "../src/client/dict.ts";
import { assignColor, COLLAB_PALETTE } from "../packages/core/src/palette.ts";

test("Hunspell en_US: inflections, contractions and possessives pass; typos flag with good suggestions", () => {
  loadHunspell(fs.readFileSync("public/dict/en_US.aff", "utf8"), fs.readFileSync("public/dict/en_US.dic", "utf8"));
  const text = "The children's toys were happily organized. Running quickly, she didn't realize the analyses mattered on Monday. Anwser goverment wierd.";
  assert.deepEqual(spellHits(text, new Set()).map((hit) => hit.word), ["Anwser", "goverment", "wierd"]);
  assert.deepEqual(spellHits(text, new Set(["goverment"])).map((hit) => hit.word), ["Anwser", "wierd"]);
  assert.equal(spellSuggestions("teh")[0], "the");
  assert.equal(spellSuggestions("goverment")[0], "government");
  assert.ok(spellSuggestions("wierd").includes("weird"));
  // Lowercase proper nouns are wrong, like Docs.
  assert.deepEqual(spellHits("see you monday", new Set()).map((hit) => hit.word), ["monday"]);
});

test("collaborator colors are stable per person regardless of join order", () => {
  const a = assignColor([], "pAlice");
  const b = assignColor([], "pBob");
  assert.equal(assignColor([b], "pAlice"), a === b ? assignColor([b], "pAlice") : a);
  assert.equal(assignColor([], "pAlice"), a);
  // A taken color moves to the next free one, never a duplicate.
  const taken = [a];
  assert.notEqual(assignColor(taken, "pAlice"), a);
  const all = COLLAB_PALETTE.slice();
  assert.ok(!all.includes(assignColor(all, "pAnyone")));
});
