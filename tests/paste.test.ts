import assert from "node:assert/strict";
import test from "node:test";
import { plainToOps, clipboardToDelta } from "../src/client/paste.ts";
import { applyDoc, emptyDoc, plainText } from "../src/shared/doc.ts";

test("plain paste splits lines and replaces a selection", () => {
  const ops = plainToOps("one\ntwo\n");
  assert.deepEqual(
    ops.map((op) => (op.t === "i" ? op.s : "")),
    ["one", "\n", "two", "\n"],
  );
  const doc = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "HELLO" }] });
  const delta = clipboardToDelta("", "XY", 0, 5, doc.text.length);
  const next = applyDoc(doc, delta);
  assert.equal(plainText(next), "XY");
});
