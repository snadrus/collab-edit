import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { displayValue, evaluate, type GridRead } from "../src/formula.ts";
import {
  chartPoints,
  convertField,
  defaultImportOptions,
  detectSeparator,
  importBytes,
  importText,
  odsFormula,
  parseDelimited,
  parseHtmlTable,
  uniqueComments,
  bookXlsx,
  bookOds,
} from "../src/import.ts";
import { type Book, applyBook, cellKey, emptyBook } from "../src/ot.ts";

const root = new URL("../fixtures/", import.meta.url);

function read(book: Book): GridRead {
  return {
    sheets: () => book.sheets.map((sheet) => sheet.name),
    raw: (name, r, c) => book.sheets.find((sheet) => sheet.name === name)?.cells[cellKey(r, c)]?.v || "",
  };
}

function show(book: Book, sheet: string, r: number, c: number): string {
  const host = book.sheets.find((item) => item.name === sheet) || book.sheets[0];
  const cell = host.cells[cellKey(r, c)];
  return displayValue(evaluate(read(book), host.name, cell?.v || ""), cell?.style?.format || "general", cell?.style?.numFmt);
}

function load(name: string): Book {
  const bytes = readFileSync(new URL(name, root));
  return importBytes(name, bytes, defaultImportOptions(), ["s1"]);
}

test("delimited text keeps quotes, newlines, and the anchor field", () => {
  const rows = parseDelimited('a,"b""c"\n"hello\nworld",x\n', ",");
  assert.deepEqual(rows, [["a", 'b"c'], ["hello\nworld", "x"]]);
  assert.equal(detectSeparator("a;b;c\n1;2;3\n"), ";");
  const html = parseHtmlTable("<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B&amp;B</td></tr></table>");
  assert.deepEqual(html, [["A1", "B1"], ["A2", "B&B"]]);
});

test("conversion keeps leading zeros and refuses invalid formulas", () => {
  const on = defaultImportOptions();
  assert.equal(convertField("02134", on, ",").v, "02134");
  assert.equal(convertField("00000", on, ",").v, "00000");
  assert.equal(convertField("=1+1 formula-looking", on, ",").v, "'=1+1 formula-looking");
  assert.equal(convertField("=B2*C2", on, ",").v, "=B2*C2");
  const dated = convertField("2026-11-01", on, ",");
  assert.equal(dated.style?.format, "date");
  assert.equal(displayValue({ t: "n", n: Number(dated.v) }, "date", dated.style?.numFmt), "2026-11-01");
  const eu = convertField("1.234,56", { ...on, locale: "eu" }, ";");
  assert.equal(eu.v, "1234.56");
  const coerced = convertField("02134", { ...on, keepLeadingZeros: false }, ",");
  assert.equal(coerced.v, "2134");
  assert.equal(odsFormula("of:=SUM([.B2:.B3])"), "=SUM(B2:B3)");
  assert.equal(odsFormula("of:=[$Sheet1.B4]"), "=Sheet1!B4");
});

test("small csv, tsv, semicolon, and utf-8 fixtures", () => {
  const small = load("corpus/small.csv");
  assert.equal(small.sheets[0].cells["0,0"].v, "Item");
  assert.equal(show(small, "small", 1, 3), "1.5");
  assert.equal(show(small, "small", 6, 1), "124");
  assert.equal(show(small, "small", 6, 3), "30.9");
  const tsv = load("corpus/data.tsv");
  assert.equal(tsv.sheets[0].cells["0,0"].v, "Region");
  assert.equal(tsv.sheets[0].cells["0,1"].v, "Q1");
  assert.equal(show(tsv, "data", 1, 5), "2398");
  assert.equal(tsv.sheets[0].cells["5,0"].v, "Note, with comma");
  assert.equal(tsv.sheets[0].cells["5,1"].v, '"quoted"');
  const semi = load("corpus/quirks_semicolon.csv");
  assert.equal(semi.sheets[0].cells["1,0"].v, "Käse");
  assert.equal(semi.sheets[0].cells["2,0"].v, "Brot; groß");
  assert.equal(show(semi, "quirks_semicolon", 1, 2), "4.5");
  assert.equal(show(semi, "quirks_semicolon", 3, 2), "1234.56");
  assert.equal(show(semi, "quirks_semicolon", 1, 3), "01.11.2026");
  const utf = load("corpus/quirks_utf8.csv");
  assert.equal(utf.sheets[0].cells["1,0"].v, "001");
  assert.equal(utf.sheets[0].cells["1,2"].v, "02134");
  assert.equal(utf.sheets[0].cells["5,2"].v, "00000");
  assert.ok(utf.sheets[0].cells["1,1"].v?.includes("😀"));
  assert.equal(utf.sheets[0].cells["3,1"].v, "multi\nline cell");
  assert.equal(show(utf, "quirks_utf8", 1, 3), "2026-11-01");
  assert.equal(show(utf, "quirks_utf8", 5, 7), "=1+1 formula-looking");
  const pm = utf.sheets[0].cells["5,4"];
  assert.equal(pm.style?.numFmt, "m/d/yy h:mm AM/PM");
  const frac = Number(pm.v) - Math.floor(Number(pm.v));
  assert.ok(Math.abs(frac - (13 * 60 + 45) / 1440) < 1e-8);
  assert.equal(show(utf, "quirks_utf8", 5, 4), "7/4/26 1:45 PM");
  const am = convertField("7/4/26 1:45 AM", defaultImportOptions(), ",");
  const amFrac = Number(am.v) - Math.floor(Number(am.v));
  assert.ok(Math.abs(amFrac - (60 + 45) / 1440) < 1e-8);
  assert.equal(displayValue({ t: "n", n: Number(am.v) }, "date", am.style?.numFmt), "7/4/26 1:45 AM");
});

test("xlsx keeps sheets, formulas, formats, and chart", () => {
  const book = load("corpus/features.xlsx");
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ["Sales", "Products", "Summary"]);
  const sales = book.sheets[0];
  assert.equal(sales.freezeR, 1);
  assert.equal(sales.cells["0,0"].style?.b, true);
  assert.equal(sales.cells["0,0"].style?.fill?.toLowerCase(), "#4472c4");
  assert.equal(sales.cells["0,0"].style?.color?.toLowerCase(), "#ffffff");
  assert.equal(sales.cells["0,0"].style?.border, true);
  assert.equal(sales.cells["0,0"].note, "Order date (weekly)");
  assert.equal(show(book, "Sales", 1, 0), "01/15/2026");
  assert.equal(show(book, "Sales", 1, 1), "South");
  assert.equal(show(book, "Sales", 1, 4), "$9.99");
  assert.equal(show(book, "Sales", 1, 5), "$279.72");
  assert.equal(show(book, "Sales", 1, 7), "No");
  assert.equal(show(book, "Sales", 1, 8), "2026-01-15 P1");
  assert.equal(show(book, "Sales", 23, 1), "6");
  assert.equal(show(book, "Sales", 24, 1), "24.5");
  assert.ok(sales.merges?.some((merge) => merge.c1 === 10 && merge.c2 === 12 && merge.r1 === 0));
  assert.equal(sales.cells["0,10"].v, "Merged header");
  assert.equal(sales.cells["2,10"].link, "https://www.google.com");
  assert.equal(sales.cells["3,10"].link, "#Products!A1");
  assert.ok(sales.validations?.some((rule) => rule.list.includes("West")));
  assert.ok(sales.rules?.some((rule) => rule.kind === "cell" && rule.op === "gt"));
  assert.ok(sales.rules?.some((rule) => rule.kind === "scale"));
  assert.ok((sales.colW["0"] || 0) > (sales.colW["3"] || 0));
  assert.equal(show(book, "Products", 1, 1), "$9.99");
  assert.equal(show(book, "Summary", 1, 0), "North");
  assert.equal(show(book, "Summary", 1, 1).replace(/[$,]/g, ""), "2244.85");
  assert.equal(show(book, "Summary", 2, 1).replace(/[$,]/g, ""), "1235.22");
  assert.equal(book.charts[0]?.kind, "bar");
  assert.equal(book.charts[0]?.title, "Revenue by region");
  assert.ok(sales.cols > 12);
  assert.equal(sales.cells["0,10"].style?.fill?.toLowerCase(), "#ffc000");
  assert.equal(sales.cells["0,10"].style?.align, "center");
  const points = chartPoints(book, book.charts[0]);
  assert.deepEqual(points.map((point) => point.name), ["North", "South", "East", "West"]);
  assert.equal(points[0].n.toFixed(2), "2244.85");
  const cross = chartPoints(book, {
    ...book.charts[0],
    series: [{ name: "Sales!F2", sheet: "Sales", r1: 1, c1: 5, r2: 1, c2: 5, catSheet: "Sales", catR1: 1, catC1: 1, catR2: 1, catC2: 1 }],
  });
  assert.equal(cross[0]?.name, "South");
  assert.equal(cross[0]?.n.toFixed(2), "279.72");
  assert.equal(sales.cells["0,0"].note, "Order date (weekly)");
  assert.equal(uniqueComments([{ quote: "A1", text: "Order date (weekly)" }], [{ quote: "A1", text: "Order date (weekly)" }]).length, 1);
  const days = Number(show(book, "Sales", 25, 1));
  assert.equal(days, Number(show(book, "Sales", 25, 1)));
  assert.ok(days > 200 && days < 400);
});

test("ods keeps both sheets and cross-sheet formulas", () => {
  const book = load("corpus/basic.ods");
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ["Sheet1", "Second"]);
  assert.equal(book.sheets[0].cells["0,0"].v, "Name");
  assert.equal(show(book, "Sheet1", 1, 1), "90");
  assert.equal(show(book, "Sheet1", 1, 2), "180");
  assert.equal(show(book, "Sheet1", 3, 1), "165");
  assert.equal(show(book, "Second", 1, 0), "165");
});

test("10k csv parses and loads as one op", () => {
  const bytes = readFileSync(new URL("corpus/large_10k_x20.csv", root));
  const started = Date.now();
  const imported = importBytes("large_10k_x20.csv", bytes, defaultImportOptions(), ["s1"]);
  const book = applyBook(emptyBook(), { ops: [{ t: "load", mode: "replace", sheet: "s1", book: imported }] });
  const ms = Date.now() - started;
  assert.ok(ms < 2000, "parse+load " + ms);
  assert.equal(book.sheets[0].cells["0,0"].v, "col1");
  assert.equal(book.sheets[0].cells["5000,1"].v, "name4999");
  assert.equal(book.sheets[0].cells["10000,1"].v, "name9999");
  assert.equal(book.sheets[0].rows, 10001);
});

test("xlsx and ods export round-trip values", () => {
  const book = importText("tiny.csv", "A,B\n1,=A2*2\n", defaultImportOptions(), ["s1"]);
  const again = importBytes("tiny.xlsx", bookXlsx(book), defaultImportOptions(), ["s1"]);
  assert.equal(again.sheets[0].cells["0,0"].v, "A");
  assert.equal(again.sheets[0].cells["1,1"].v, "=A2*2");
  const ods = importBytes("tiny.ods", bookOds(book), defaultImportOptions(), ["s1"]);
  assert.equal(ods.sheets[0].cells["0,0"].v, "A");
  assert.equal(show(ods, ods.sheets[0].name, 1, 1), "2");
});
