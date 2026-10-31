import assert from "node:assert/strict";
import test from "node:test";
import { displayValue, evaluate, formulaDeps, shiftFormula, type GridRead } from "../src/formula.ts";
import {
  type Book,
  type GridDelta,
  type GridOp,
  ServerBook,
  applyBook,
  bookEqual,
  cellKey,
  emptyBook,
  transformGrid,
} from "../src/ot.ts";

function read(book: Book): GridRead {
  return {
    sheets: () => book.sheets.map((sheet) => sheet.name),
    raw: (name, r, c) => book.sheets.find((sheet) => sheet.name === name)?.cells[cellKey(r, c)]?.v || "",
  };
}

function put(book: Book, sheet: string, r: number, c: number, v: string): Book {
  const id = book.sheets.find((item) => item.name === sheet)?.id || book.sheets[0].id;
  return applyBook(book, { ops: [{ t: "set", sheet: id, r, c, v }] });
}

test("formulas cover aggregates, lookup, conditions, and other sheets", () => {
  let book = emptyBook();
  book = put(book, "Sheet1", 0, 0, "1");
  book = put(book, "Sheet1", 1, 0, "2");
  book = put(book, "Sheet1", 2, 0, "3");
  book = put(book, "Sheet1", 0, 1, "apple");
  book = put(book, "Sheet1", 1, 1, "pear");
  book = put(book, "Sheet1", 0, 2, "10");
  book = put(book, "Sheet1", 1, 2, "20");
  book = applyBook(book, { ops: [{ t: "addsheet", sheet: "s2", name: "Sheet2" }] });
  book = put(book, "Sheet2", 0, 0, "5");
  const grid = read(book);
  const show = (raw: string) => displayValue(evaluate(grid, "Sheet1", raw));
  assert.equal(show("=SUM(A1:A3)"), "6");
  assert.equal(show("=AVERAGE(A1:A3)"), "2");
  assert.equal(show("=MIN(A1:A3)"), "1");
  assert.equal(show("=MAX(A1:A3)"), "3");
  assert.equal(show("=COUNT(A1:B2)"), "2");
  assert.equal(show('=IF(A2>1,"yes","no")'), "yes");
  assert.equal(show('=CONCAT(B1," ",B2)'), "apple pear");
  assert.equal(show("=VLOOKUP(B2,B1:C2,2)"), "20");
  assert.equal(show("=A1+A2*3"), "7");
  assert.equal(show("=Sheet2!A1+1"), "6");
  assert.equal(show("=Sheet9!A1"), "#REF!");
  book = put(book, "Sheet1", 3, 0, "=A5");
  book = put(book, "Sheet1", 4, 0, "=A4");
  assert.equal(displayValue(evaluate(read(book), "Sheet1", "=A4")), "#CYCLE!");
});

test("fill shifts relative refs and keeps absolute ones", () => {
  assert.equal(shiftFormula("=B1+1", 1, 0), "=B2+1");
  assert.equal(shiftFormula("=$B$1+C1", 2, 1), "=$B$1+D3");
  const deps = formulaDeps("=SUM(Sheet2!A1:A2)+B1");
  assert.equal(deps.length, 3);
  assert.equal(deps[0].sheet, "Sheet2");
  assert.equal(deps[2].c, 1);
});

function ri(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(book: Book, rng: () => number): GridOp {
  const sheet = book.sheets[Math.floor(rng() * book.sheets.length)];
  const roll = rng();
  if (roll < 0.55) {
    const op: GridOp = { t: "set", sheet: sheet.id, r: ri(rng, 0, 5), c: ri(rng, 0, 4), v: rng() < 0.2 ? "=" + "A1" : String(ri(rng, 0, 9)) };
    if (rng() < 0.3) op.style = { b: rng() < 0.5, format: rng() < 0.5 ? "number" : "general" };
    return op;
  }
  if (roll < 0.7) return { t: rng() < 0.5 ? "insrow" : "inscol", sheet: sheet.id, index: ri(rng, 0, 4), n: ri(rng, 1, 2) };
  if (roll < 0.85) return { t: rng() < 0.5 ? "delrow" : "delcol", sheet: sheet.id, index: ri(rng, 0, 4), n: 1 };
  if (roll < 0.93) return { t: "resize", sheet: sheet.id, axis: rng() < 0.5 ? "row" : "col", index: ri(rng, 0, 4), size: ri(rng, 24, 80) };
  return { t: "freeze", sheet: sheet.id, rows: ri(rng, 0, 2), cols: ri(rng, 0, 2) };
}

test("concurrent grid ops converge and the server tie-break matches", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 400; i++) {
    let book = emptyBook();
    for (let k = 0; k < 4; k++) book = applyBook(book, { ops: [randomOp(book, rng)] });
    const a: GridDelta = { ops: [randomOp(book, rng), randomOp(book, rng)] };
    const b: GridDelta = { ops: [randomOp(book, rng)] };
    const left = applyBook(applyBook(book, a), transformGrid(b, a, false));
    const right = applyBook(applyBook(book, b), transformGrid(a, b, true));
    assert.equal(bookEqual(left, right), true, "pair " + i);
  }
  const serverA = new ServerBook();
  const serverB = new ServerBook();
  const rand = mulberry32(99);
  let revA = 0;
  let revB = 0;
  for (let i = 0; i < 80; i++) {
    const sid = i % 2 === 0 ? "a" : "b";
    const base = sid === "a" ? revA : revB;
    const book = sid === "a" ? serverA.book : serverB.book;
    const delta = { ops: [randomOp(book, rand)] };
    const result = (sid === "a" ? serverA : serverB).submit(sid, i, base, delta);
    if (result.delta) {
      const other = sid === "a" ? serverB : serverA;
      other.submit(sid, i, sid === "a" ? revB : revA, result.delta);
    }
    revA = serverA.rev;
    revB = serverB.rev;
    assert.equal(bookEqual(serverA.book, serverB.book), true, "server " + i);
  }
});
