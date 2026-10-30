import { type Attrs, type Delta, CELL, ROW, chop, isBreak } from "./delta.ts";
import { type Doc, paraBounds } from "./doc.ts";

export interface TableCell {
  /** Inclusive start of the cell's text. */
  start: number;
  /** Index of the following CELL, or of the row break when this is the last cell. */
  end: number;
}

export interface TableRow {
  start: number;
  /** Index of the ROW character. */
  end: number;
  cols: number;
  cells: TableCell[];
}

export function cellsOf(doc: Doc, start: number, end: number): TableCell[] {
  const cells: TableCell[] = [];
  let s = start;
  for (let i = start; i <= end; i++) {
    if (doc.text[i] === CELL) {
      cells.push({ start: s, end: i });
      s = i + 1;
    } else if (i === end) {
      cells.push({ start: s, end: i });
    }
  }
  return cells;
}

export function tableRowAt(doc: Doc, index: number): TableRow | null {
  if (!doc.text.length) return null;
  const bounds = paraBounds(doc, index);
  if (doc.text[bounds.end] !== ROW) return null;
  const cols = doc.styles[bounds.end]?.cols || cellsOf(doc, bounds.start, bounds.end).length;
  return { start: bounds.start, end: bounds.end, cols, cells: cellsOf(doc, bounds.start, bounds.end) };
}

export function tableAt(doc: Doc, index: number): TableRow[] | null {
  const row = tableRowAt(doc, index);
  if (!row) return null;
  const rows = [row];
  let s = row.start;
  while (s > 0 && doc.text[s - 1] === ROW) {
    const prev = tableRowAt(doc, s - 1);
    if (!prev) break;
    rows.unshift(prev);
    s = prev.start;
  }
  let e = row.end;
  while (e + 1 < doc.text.length) {
    const next = tableRowAt(doc, e + 1);
    if (!next) break;
    rows.push(next);
    e = next.end;
  }
  return rows;
}

function rowAttrs(cols: number): Attrs {
  return { h: "normal", align: "left", cols };
}

function paraBreakAttrs(doc: Doc, index: number): Attrs {
  const prev = doc.styles[paraBounds(doc, index).end] || {};
  const attrs: Attrs = { h: prev.h || "normal", align: prev.align || "left" };
  if (prev.list) attrs.list = prev.list;
  if (prev.lv) attrs.lv = prev.lv;
  if (prev.ind) attrs.ind = prev.ind;
  if (prev.lh) attrs.lh = prev.lh;
  if (prev.check) attrs.check = true;
  return attrs;
}

/** Insert a table as its own block. Text before the caret stays in the previous paragraph. */
export function insertTableDelta(doc: Doc, at: number, rows: number, cols: number): Delta {
  const r = Math.max(1, Math.min(8, rows | 0));
  const c = Math.max(1, Math.min(8, cols | 0));
  const chunk = CELL.repeat(c - 1) + ROW;
  let body = "";
  for (let i = 0; i < r; i++) body += chunk;
  const start = Math.max(0, Math.min(at, Math.max(0, doc.text.length - 1)));
  const needBreak = start > 0 && !isBreak(doc.text[start - 1]);
  const ops = [];
  if (start > 0) ops.push({ t: "r" as const, n: start });
  if (needBreak) ops.push({ t: "i" as const, s: "\n", a: paraBreakAttrs(doc, start) });
  ops.push({ t: "i" as const, s: body, a: rowAttrs(c) });
  if (doc.text[start] === "\n" || doc.text[start] === "\f") {
    ops.push({ t: "r" as const, n: 1, a: { h: "normal", list: null, lv: null, check: null, hr: null, cols: null } });
  }
  return chop(ops);
}

export function addRowDelta(doc: Doc, index: number): Delta | null {
  const row = tableRowAt(doc, index);
  if (!row) return null;
  const chunk = CELL.repeat(Math.max(0, row.cols - 1)) + ROW;
  const at = row.end + 1;
  const ops = [];
  if (at > 0) ops.push({ t: "r" as const, n: at });
  ops.push({ t: "i" as const, s: chunk, a: rowAttrs(row.cols) });
  return chop(ops);
}

export function removeRowDelta(doc: Doc, index: number): Delta | null {
  const row = tableRowAt(doc, index);
  if (!row) return null;
  const ops = [];
  if (row.start > 0) ops.push({ t: "r" as const, n: row.start });
  ops.push({ t: "d" as const, n: row.end - row.start + 1 });
  return chop(ops);
}

export function columnIndex(row: TableRow, index: number): number {
  for (let i = 0; i < row.cells.length; i++) {
    const cell = row.cells[i];
    if (index >= cell.start && index <= cell.end) return i;
  }
  return Math.max(0, row.cells.length - 1);
}

export function addColumnDelta(doc: Doc, index: number): Delta | null {
  const rows = tableAt(doc, index);
  if (!rows) return null;
  const ops = [];
  let cursor = 0;
  for (const row of rows) {
    if (row.cols >= 8) return null;
    if (row.end > cursor) ops.push({ t: "r" as const, n: row.end - cursor });
    ops.push({ t: "i" as const, s: CELL });
    ops.push({ t: "r" as const, n: 1, a: { cols: row.cols + 1 } });
    cursor = row.end + 1;
  }
  return chop(ops);
}

export function removeColumnDelta(doc: Doc, index: number): Delta | null {
  const rows = tableAt(doc, index);
  const current = tableRowAt(doc, index);
  if (!rows || !current || current.cols <= 1) return null;
  const k = Math.min(columnIndex(current, index), current.cols - 1);
  const ops = [];
  let cursor = 0;
  for (const row of rows) {
    const cell = row.cells[k];
    if (!cell) return null;
    const delFrom = k === 0 ? cell.start : cell.start - 1;
    const delTo = k === 0 && doc.text[cell.end] === CELL ? cell.end + 1 : cell.end;
    if (delFrom > cursor) ops.push({ t: "r" as const, n: delFrom - cursor });
    if (delTo > delFrom) ops.push({ t: "d" as const, n: delTo - delFrom });
    const gap = row.end - delTo;
    if (gap > 0) ops.push({ t: "r" as const, n: gap });
    ops.push({ t: "r" as const, n: 1, a: { cols: row.cols - 1 } });
    cursor = row.end + 1;
  }
  return chop(ops);
}
