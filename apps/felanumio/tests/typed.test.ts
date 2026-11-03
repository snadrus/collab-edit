import assert from "node:assert/strict";
import test from "node:test";
import { dateSerial, displayValue, parseTyped } from "../src/formula.ts";

test("typed entry like Sheets: thousands, currency, percent and dates become numbers with a format", () => {
  assert.deepEqual(parseTyped("1,000"), { v: "1000", format: "number", numFmt: "#,##0" });
  assert.deepEqual(parseTyped("-1,234.50"), { v: "-1234.5", format: "number", numFmt: "#,##0.00" });
  assert.deepEqual(parseTyped("$5"), { v: "5", format: "currency" });
  assert.deepEqual(parseTyped("-$1,234.5"), { v: "-1234.5", format: "currency" });
  assert.deepEqual(parseTyped("50%"), { v: "0.5", format: "percent" });
  assert.deepEqual(parseTyped("12.5 %"), { v: "0.125", format: "percent" });
  assert.deepEqual(parseTyped("2026-01-05"), { v: String(dateSerial(2026, 1, 5)), format: "date" });
  assert.deepEqual(parseTyped("1/5/2026"), { v: String(dateSerial(2026, 1, 5)), format: "date" });
  for (const text of ["1,2", "12,34,567", "abc", "2026-02-30", "$", "5$", "42", "=A1", "1/5"]) assert.equal(parseTyped(text), null, text);
  assert.equal(displayValue({ t: "n", n: 1000 }, "number", "#,##0"), "1,000");
  assert.equal(displayValue({ t: "n", n: -1234.5 }, "number", "#,##0.00"), "-1,234.50");
});
