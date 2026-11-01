export interface CellStyle {
  b?: boolean;
  i?: boolean;
  color?: string;
  fill?: string;
  format?: "general" | "number" | "percent" | "currency" | "date";
  numFmt?: string;
  align?: "left" | "center" | "right";
  border?: boolean;
}

export interface Cell {
  v?: string;
  style?: CellStyle;
  link?: string;
  note?: string;
}

export interface Merge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface Validation {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  list: string[];
}

export interface CfRule {
  kind: "cell" | "scale";
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  op?: "gt" | "lt" | "eq" | "gte" | "lte";
  value?: number;
  fill?: string;
  minColor?: string;
  maxColor?: string;
}

export interface Sheet {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, Cell>;
  rowH: Record<string, number>;
  colW: Record<string, number>;
  freezeR: number;
  freezeC: number;
  merges?: Merge[];
  validations?: Validation[];
  rules?: CfRule[];
}

export interface ChartMark {
  id: string;
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  kind?: "bar" | "line" | "pie" | "placeholder";
  title?: string;
  note?: string;
}

export interface Book {
  sheets: Sheet[];
  charts: ChartMark[];
}

export interface GridOp {
  t: "set" | "insrow" | "delrow" | "inscol" | "delcol" | "resize" | "freeze" | "addsheet" | "rensheet" | "delsheet" | "chart" | "unchart" | "load";
  sheet: string;
  mode?: "replace" | "insert" | "append" | "patch";
  book?: Book;
  r?: number;
  c?: number;
  n?: number;
  v?: string | null;
  style?: CellStyle | null;
  axis?: "row" | "col";
  index?: number;
  size?: number;
  name?: string;
  rows?: number;
  cols?: number;
  id?: string;
  r1?: number;
  c1?: number;
  r2?: number;
  c2?: number;
  kind?: ChartMark["kind"];
  title?: string;
  note?: string;
}

export interface GridDelta {
  ops: GridOp[];
}

export const DEFAULT_ROWS = 40;
export const DEFAULT_COLS = 16;

export function emptySheet(id: string, name: string): Sheet {
  return { id, name, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: {}, rowH: {}, colW: {}, freezeR: 0, freezeC: 0, merges: [], validations: [], rules: [] };
}

export function emptyBook(): Book {
  return { sheets: [emptySheet("s1", "Sheet1")], charts: [] };
}

export function cellKey(r: number, c: number): string {
  return r + "," + c;
}

export function bookEqual(a: Book, b: Book): boolean {
  return JSON.stringify(normalizeBook(a)) === JSON.stringify(normalizeBook(b));
}

function normalizeBook(book: Book): Book {
  return {
    charts: book.charts.map((chart) => ({ ...chart })).sort((a, b) => a.id.localeCompare(b.id)),
    sheets: book.sheets.map((sheet) => ({
      ...sheet,
      cells: Object.fromEntries(Object.entries(sheet.cells).filter(([, cell]) => cell.v || cell.style || cell.link || cell.note).sort(([a], [b]) => a.localeCompare(b))),
      rowH: { ...sheet.rowH },
      colW: { ...sheet.colW },
      merges: (sheet.merges || []).map((merge) => ({ ...merge })),
      validations: (sheet.validations || []).map((rule) => ({ ...rule, list: [...rule.list] })),
      rules: (sheet.rules || []).map((rule) => ({ ...rule })),
    })),
  };
}

function clone(book: Book): Book {
  return structuredClone(book);
}

function sheetOf(book: Book, id: string): Sheet | undefined {
  return book.sheets.find((sheet) => sheet.id === id);
}

function shiftMap(map: Record<string, number>, at: number, n: number, del: boolean): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, size] of Object.entries(map)) {
    const index = Number(key);
    if (!del) {
      next[String(index >= at ? index + n : index)] = size;
    } else if (index < at) next[key] = size;
    else if (index >= at + n) next[String(index - n)] = size;
  }
  return next;
}

function shiftCells(sheet: Sheet, axis: "row" | "col", at: number, n: number, del: boolean): void {
  const next: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const [rs, cs] = key.split(",");
    let r = Number(rs);
    let c = Number(cs);
    const index = axis === "row" ? r : c;
    if (!del) {
      if (index >= at) {
        if (axis === "row") r += n;
        else c += n;
      }
      next[cellKey(r, c)] = cell;
    } else if (index < at) next[key] = cell;
    else if (index >= at + n) {
      if (axis === "row") r -= n;
      else c -= n;
      next[cellKey(r, c)] = cell;
    }
  }
  sheet.cells = next;
  if (axis === "row") {
    sheet.rowH = shiftMap(sheet.rowH, at, n, del);
    sheet.rows = Math.max(1, sheet.rows + (del ? -n : n));
    if (sheet.freezeR > at) sheet.freezeR = Math.max(0, sheet.freezeR + (del ? -Math.min(n, sheet.freezeR - at) : n));
  } else {
    sheet.colW = shiftMap(sheet.colW, at, n, del);
    sheet.cols = Math.max(1, sheet.cols + (del ? -n : n));
    if (sheet.freezeC > at) sheet.freezeC = Math.max(0, sheet.freezeC + (del ? -Math.min(n, sheet.freezeC - at) : n));
  }
}

function shallowBook(book: Book): Book {
  return {
    charts: book.charts.map((chart) => ({ ...chart })),
    sheets: book.sheets.map((sheet) => ({
      ...sheet,
      cells: { ...sheet.cells },
      rowH: { ...sheet.rowH },
      colW: { ...sheet.colW },
      merges: (sheet.merges || []).map((merge) => ({ ...merge })),
      validations: (sheet.validations || []).map((rule) => ({ ...rule, list: [...rule.list] })),
      rules: (sheet.rules || []).map((rule) => ({ ...rule })),
    })),
  };
}

export function applyBook(book: Book, delta: GridDelta): Book {
  const next = shallowBook(book);
  for (const op of delta.ops) applyOp(next, op);
  return next;
}

function applyOp(book: Book, op: GridOp): void {
  if (op.t === "addsheet") {
    if (book.sheets.some((sheet) => sheet.id === op.sheet)) return;
    book.sheets.push(emptySheet(op.sheet, (op.name || "Sheet").slice(0, 40)));
    return;
  }
  if (op.t === "delsheet") {
    if (book.sheets.length <= 1) return;
    book.sheets = book.sheets.filter((sheet) => sheet.id !== op.sheet);
    book.charts = book.charts.filter((chart) => chart.sheet !== op.sheet);
    return;
  }
  if (op.t === "rensheet") {
    const sheet = sheetOf(book, op.sheet);
    if (sheet && op.name) sheet.name = op.name.slice(0, 40);
    return;
  }
  if (op.t === "unchart") {
    book.charts = book.charts.filter((chart) => chart.id !== op.id);
    return;
  }
  if (op.t === "load" && op.book) {
    applyLoad(book, op);
    return;
  }
  if (op.t === "chart" && op.id) {
    const mark: ChartMark = {
      id: op.id,
      sheet: op.sheet,
      r1: op.r1 || 0,
      c1: op.c1 || 0,
      r2: op.r2 || 0,
      c2: op.c2 || 0,
      kind: op.kind,
      title: op.title,
      note: op.note,
    };
    const at = book.charts.findIndex((chart) => chart.id === op.id);
    if (at >= 0) book.charts[at] = mark;
    else book.charts.push(mark);
    return;
  }
  const sheet = sheetOf(book, op.sheet);
  if (!sheet) return;
  if (op.t === "freeze") {
    sheet.freezeR = Math.max(0, Math.min(sheet.rows - 1, op.rows || 0));
    sheet.freezeC = Math.max(0, Math.min(sheet.cols - 1, op.cols || 0));
    return;
  }
  if (op.t === "resize" && op.index != null && op.size) {
    const size = Math.max(20, Math.min(400, Math.round(op.size)));
    if (op.axis === "col") sheet.colW[String(op.index)] = size;
    else sheet.rowH[String(op.index)] = size;
    return;
  }
  if (op.t === "insrow" || op.t === "delrow" || op.t === "inscol" || op.t === "delcol") {
    const n = Math.max(1, Math.min(20, op.n || 1));
    const at = Math.max(0, op.index || 0);
    const axis = op.t.endsWith("row") ? "row" : "col";
    const del = op.t.startsWith("del");
    shiftCells(sheet, axis, at, n, del);
    sheet.merges = shiftRects(sheet.merges || [], axis, at, n, del);
    sheet.validations = shiftRects(sheet.validations || [], axis, at, n, del);
    sheet.rules = shiftRects(sheet.rules || [], axis, at, n, del);
    for (const chart of book.charts) {
      if (chart.sheet !== sheet.id) continue;
      const axis = op.t.endsWith("row") ? "r" : "c";
      const a = axis === "r" ? chart.r1 : chart.c1;
      const b = axis === "r" ? chart.r2 : chart.c2;
      const mapped = mapSpan(a, b, at, n, op.t.startsWith("del"));
      if (axis === "r") {
        chart.r1 = mapped[0];
        chart.r2 = mapped[1];
      } else {
        chart.c1 = mapped[0];
        chart.c2 = mapped[1];
      }
    }
    return;
  }
  if (op.t === "set" && op.r != null && op.c != null) {
    const key = cellKey(op.r, op.c);
    const prev = sheet.cells[key] || {};
    const cell: Cell = { ...prev };
    if ("v" in op) {
      if (op.v) cell.v = op.v.slice(0, 2000);
      else delete cell.v;
    }
    if ("style" in op) {
      if (op.style) cell.style = { ...op.style };
      else delete cell.style;
    }
    if (!cell.v && !cell.style && !cell.link && !cell.note) delete sheet.cells[key];
    else sheet.cells[key] = cell;
    sheet.rows = Math.max(sheet.rows, op.r + 1);
    sheet.cols = Math.max(sheet.cols, op.c + 1);
  }
}

function shiftRects<T extends { r1: number; c1: number; r2: number; c2: number }>(items: T[], axis: "row" | "col", at: number, n: number, del: boolean): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (axis === "row") {
      const [r1, r2] = mapSpan(item.r1, item.r2, at, n, del);
      if (r2 < r1) continue;
      out.push({ ...item, r1, r2 });
    } else {
      const [c1, c2] = mapSpan(item.c1, item.c2, at, n, del);
      if (c2 < c1) continue;
      out.push({ ...item, c1, c2 });
    }
  }
  return out;
}

function adoptSheet(src: Sheet): Sheet {
  return {
    ...src,
    cells: { ...src.cells },
    rowH: { ...src.rowH },
    colW: { ...src.colW },
    merges: (src.merges || []).map((merge) => ({ ...merge })),
    validations: (src.validations || []).map((rule) => ({ ...rule, list: [...rule.list] })),
    rules: (src.rules || []).map((rule) => ({ ...rule })),
  };
}

function applyLoad(book: Book, op: GridOp): void {
  const incoming = op.book;
  if (!incoming) return;
  if (op.mode === "insert") {
    for (const sheet of incoming.sheets) {
      if (!book.sheets.some((item) => item.id === sheet.id)) book.sheets.push(adoptSheet(sheet));
    }
    for (const chart of incoming.charts) {
      if (!book.charts.some((item) => item.id === chart.id)) book.charts.push({ ...chart });
    }
    return;
  }
  if (op.mode === "append" || op.mode === "patch") {
    const sheet = sheetOf(book, op.sheet) || book.sheets[0];
    const src = incoming.sheets[0];
    if (!sheet || !src) return;
    let dr = 0;
    if (op.mode === "append") {
      for (const key of Object.keys(sheet.cells)) dr = Math.max(dr, Number(key.split(",")[0]) + 1);
    }
    let maxR = sheet.rows;
    let maxC = sheet.cols;
    for (const [key, cell] of Object.entries(src.cells)) {
      const [rs, cs] = key.split(",");
      const r = Number(rs) + dr;
      const c = Number(cs);
      const next: Cell = { ...cell, style: cell.style ? { ...cell.style } : undefined };
      if (!next.v && !next.style && !next.link && !next.note) delete sheet.cells[cellKey(r, c)];
      else sheet.cells[cellKey(r, c)] = next;
      maxR = Math.max(maxR, r + 1);
      maxC = Math.max(maxC, c + 1);
    }
    sheet.rows = maxR;
    sheet.cols = maxC;
    return;
  }
  book.sheets = incoming.sheets.map(adoptSheet);
  book.charts = incoming.charts.map((chart) => ({ ...chart }));
  if (!book.sheets.length) book.sheets.push(emptySheet("s1", "Sheet1"));
}

function mapSpan(a: number, b: number, at: number, n: number, del: boolean): [number, number] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!del) {
    const shift = (p: number) => (p >= at ? p + n : p);
    return [shift(lo), shift(hi)];
  }
  const keep = (p: number) => (p >= at + n ? p - n : p < at ? p : at);
  return [keep(lo), Math.max(keep(lo), keep(hi))];
}

function mapPoint(index: number, at: number, n: number, del: boolean): number | null {
  if (!del) return index >= at ? index + n : index;
  if (index >= at + n) return index - n;
  if (index >= at) return null;
  return index;
}

export function transformGrid(incoming: GridDelta, applied: GridDelta, incomingWins: boolean): GridDelta {
  // Ops in a delta are sequential. After transforming one incoming op, later
  // ops were created in the document that already includes it, so the applied
  // ops move into that same space before the next incoming op is transformed.
  let pending = applied.ops.map((op) => ({ ...op }));
  const out: GridOp[] = [];
  for (const op of incoming.ops) {
    let pieces: GridOp[] = [{ ...op }];
    for (const other of pending) {
      const next: GridOp[] = [];
      for (const piece of pieces) next.push(...transformOp(other, piece, incomingWins));
      pieces = next;
    }
    out.push(...pieces);
    const shifted: GridOp[] = [];
    for (const other of pending) shifted.push(...transformOp(op, other, !incomingWins));
    pending = shifted;
  }
  return { ops: out };
}

function transformOp(applied: GridOp, ours: GridOp, weWin: boolean): GridOp[] {
  if (ours.t === "load") return mapLoad(applied, ours, weWin);
  if (applied.t === "load") return mapAgainstLoad(applied, ours, weWin);
  if (applied.t === "delsheet" && ours.sheet === applied.sheet && ours.t !== "addsheet") return [];
  if (ours.t === "addsheet" || applied.t === "addsheet") {
    if (ours.t === "addsheet" && applied.t === "addsheet" && ours.sheet === applied.sheet) return weWin ? [ours] : [];
    return [ours];
  }
  if (ours.t === "rensheet" && applied.t === "rensheet" && ours.sheet === applied.sheet) return weWin ? [ours] : [];
  if (ours.t === "chart" && applied.t === "chart" && ours.id && ours.id === applied.id) return weWin ? [ours] : [];
  if (ours.t === "unchart" && applied.t === "unchart" && ours.id === applied.id) return [];
  if (ours.t === "chart" && applied.t === "unchart" && ours.id === applied.id) return [];
  if (ours.t === "freeze" && structAxis(applied.t) && ours.sheet === applied.sheet) {
    const axis = structAxis(applied.t);
    const at = applied.index || 0;
    const n = applied.n || 1;
    const del = applied.t.startsWith("del");
    let rows = ours.rows || 0;
    let cols = ours.cols || 0;
    const count = axis === "row" ? rows : cols;
    let next = count;
    if (!del && at < count) next = count + n;
    else if (del && at < count) next = Math.max(0, count - Math.min(n, count - at));
    if (axis === "row") rows = next;
    else cols = next;
    return [{ ...ours, rows, cols }];
  }
  if ((ours.t === "freeze" || ours.t === "resize") && applied.t === ours.t && ours.sheet === applied.sheet) {
    if (ours.t === "resize" && (ours.axis !== applied.axis || ours.index !== applied.index)) return [mapResize(applied, ours)];
    if (ours.t === "resize") return weWin ? [mapResize(applied, ours)] : [];
    return weWin ? [ours] : [];
  }
  if (ours.sheet !== applied.sheet) return [ours];
  if (ours.t === "set") return mapSet(applied, ours, weWin);
  if (ours.t === "insrow" || ours.t === "inscol" || ours.t === "delrow" || ours.t === "delcol") return mapStruct(applied, ours, weWin);
  if (ours.t === "resize") return [mapResize(applied, ours)].filter((op) => op.index != null && op.index >= 0);
  if (ours.t === "chart") return [mapChart(applied, ours)];
  return [ours];
}

function copyLoad(op: GridOp, sheets: Sheet[]): GridOp {
  return { ...op, book: op.book ? { charts: op.book.charts.map((chart) => ({ ...chart })), sheets } : op.book };
}

function shiftSheetCells(sheet: Sheet, axis: "row" | "col", at: number, n: number, del: boolean): Sheet {
  const cells: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(sheet.cells)) {
    let r = Number(key.split(",")[0]);
    let c = Number(key.split(",")[1]);
    const next = mapPoint(axis === "row" ? r : c, at, n, del);
    if (next == null) continue;
    if (axis === "row") r = next;
    else c = next;
    cells[cellKey(r, c)] = cell;
  }
  const rowH = axis === "row" ? shiftMap(sheet.rowH, at, n, del) : { ...sheet.rowH };
  const colW = axis === "col" ? shiftMap(sheet.colW, at, n, del) : { ...sheet.colW };
  return {
    ...sheet,
    cells,
    rowH,
    colW,
    rows: Math.max(1, sheet.rows + (axis === "row" ? (del ? -n : n) : 0)),
    cols: Math.max(1, sheet.cols + (axis === "col" ? (del ? -n : n) : 0)),
    merges: shiftRects(sheet.merges || [], axis, at, n, del),
    validations: shiftRects(sheet.validations || [], axis, at, n, del),
    rules: shiftRects(sheet.rules || [], axis, at, n, del),
  };
}

function mapLoad(applied: GridOp, ours: GridOp, weWin: boolean): GridOp[] {
  if (!ours.book) return [ours];
  if (applied.t === "load" && applied.mode === "replace" && ours.mode === "replace") return weWin ? [ours] : [];
  if (applied.t === "load" && applied.mode === "patch" && ours.mode === "patch" && applied.sheet === ours.sheet && !weWin) {
    const theirs = applied.book?.sheets[0]?.cells || {};
    const sheets = ours.book.sheets.map((sheet, index) => {
      if (index !== 0) return sheet;
      const cells = { ...sheet.cells };
      for (const key of Object.keys(theirs)) delete cells[key];
      return { ...sheet, cells };
    });
    return [copyLoad(ours, sheets)];
  }
  const axis = structAxis(applied.t);
  if (axis && (ours.mode === "replace" || ours.mode === "patch")) {
    const hit = ours.mode === "replace" || applied.sheet === ours.sheet;
    if (!hit) return [ours];
    if (ours.mode === "replace" && weWin) return [ours];
    const n = Math.max(1, applied.n || 1);
    const at = Math.max(0, applied.index || 0);
    const sheets = ours.book.sheets.map((sheet) => (ours.mode === "patch" || sheet.id === applied.sheet ? shiftSheetCells(sheet, axis, at, n, applied.t.startsWith("del")) : sheet));
    return [copyLoad(ours, sheets)];
  }
  if (applied.t === "set" && !weWin && (ours.mode === "replace" || (ours.mode === "patch" && applied.sheet === ours.sheet))) {
    const sheets = ours.book.sheets.map((sheet) => {
      if (sheet.id !== applied.sheet && !(ours.mode === "patch" && sheet === ours.book!.sheets[0])) return sheet;
      if (ours.mode === "replace" && sheet.id !== applied.sheet) return sheet;
      const cells = { ...sheet.cells };
      const key = cellKey(applied.r || 0, applied.c || 0);
      if (ours.mode === "patch") {
        delete cells[key];
        return { ...sheet, cells };
      }
      const prev = cells[key] || {};
      const cell: Cell = { ...prev };
      if ("v" in applied) {
        if (applied.v) cell.v = applied.v;
        else delete cell.v;
      }
      if ("style" in applied) {
        if (applied.style) cell.style = { ...applied.style };
        else delete cell.style;
      }
      if (!cell.v && !cell.style && !cell.link && !cell.note) delete cells[key];
      else cells[key] = cell;
      return { ...sheet, cells };
    });
    return [copyLoad(ours, sheets)];
  }
  return [ours];
}

function mapAgainstLoad(applied: GridOp, ours: GridOp, weWin: boolean): GridOp[] {
  if (applied.mode === "insert") return [ours];
  if (ours.t === "load") return weWin ? [ours] : [];
  if (applied.mode === "replace") {
    if (!weWin && ours.sheet && applied.book?.sheets.some((sheet) => sheet.id === ours.sheet)) return [];
    if (!weWin && (ours.t === "set" || ours.t === "resize" || ours.t === "freeze" || structAxis(ours.t))) return [];
    return [ours];
  }
  if (applied.mode === "patch" && ours.t === "set" && ours.sheet === applied.sheet && !weWin) {
    const key = cellKey(ours.r || 0, ours.c || 0);
    if (applied.book?.sheets[0]?.cells[key]) return [];
  }
  return [ours];
}

function structAxis(t: string): "row" | "col" | null {
  if (t === "insrow" || t === "delrow") return "row";
  if (t === "inscol" || t === "delcol") return "col";
  return null;
}

function mapSet(applied: GridOp, ours: GridOp, weWin: boolean): GridOp[] {
  let r = ours.r || 0;
  let c = ours.c || 0;
  const axis = structAxis(applied.t);
  if (axis) {
    const at = applied.index || 0;
    const n = applied.n || 1;
    const del = applied.t.startsWith("del");
    if (axis === "row") {
      const next = mapPoint(r, at, n, del);
      if (next == null) return [];
      r = next;
    } else {
      const next = mapPoint(c, at, n, del);
      if (next == null) return [];
      c = next;
    }
  }
  if (applied.t === "set" && applied.r === r && applied.c === c) {
    const next: GridOp = { ...ours, r, c };
    if ("v" in applied && "v" in ours && !weWin) delete next.v;
    if ("style" in applied && "style" in ours && !weWin) delete next.style;
    if (!("v" in next) && !("style" in next)) return [];
    return [next];
  }
  return [{ ...ours, r, c }];
}

function mapResize(applied: GridOp, ours: GridOp): GridOp {
  const axis = structAxis(applied.t);
  if (!axis || ours.axis !== axis) return ours;
  const next = mapPoint(ours.index || 0, applied.index || 0, applied.n || 1, applied.t.startsWith("del"));
  if (next == null) return { ...ours, index: -1 };
  return { ...ours, index: next };
}

function mapChart(applied: GridOp, ours: GridOp): GridOp {
  const axis = structAxis(applied.t);
  if (!axis || ours.r1 == null || ours.r2 == null || ours.c1 == null || ours.c2 == null) return ours;
  const at = applied.index || 0;
  const n = applied.n || 1;
  const del = applied.t.startsWith("del");
  if (axis === "row") {
    const [r1, r2] = mapSpan(ours.r1, ours.r2, at, n, del);
    return { ...ours, r1, r2 };
  }
  const [c1, c2] = mapSpan(ours.c1, ours.c2, at, n, del);
  return { ...ours, c1, c2 };
}

function mapStruct(applied: GridOp, ours: GridOp, weWin: boolean): GridOp[] {
  const ourAxis = structAxis(ours.t);
  const appAxis = structAxis(applied.t);
  if (!ourAxis || !appAxis || ourAxis !== appAxis) return [ours];
  const at = ours.index || 0;
  const n = ours.n || 1;
  const aAt = applied.index || 0;
  const aN = applied.n || 1;
  const ourIns = ours.t.startsWith("ins");
  const appIns = applied.t.startsWith("ins");
  if (ourIns && appIns) {
    if (at > aAt || (at === aAt && !weWin)) return [{ ...ours, index: at + aN }];
    return [ours];
  }
  if (ourIns && !appIns) {
    if (at >= aAt + aN) return [{ ...ours, index: at - aN }];
    if (at >= aAt) return [{ ...ours, index: aAt }];
    return [ours];
  }
  if (!ourIns && appIns) {
    if (aAt <= at) return [{ ...ours, index: at + aN }];
    if (aAt < at + n) {
      if (weWin) return [{ ...ours, n: n + aN }];
      const left = aAt - at;
      const ops: GridOp[] = [];
      if (left > 0) ops.push({ ...ours, n: left });
      const right = at + n - aAt;
      if (right > 0) ops.push({ ...ours, index: aAt + aN, n: right });
      return ops;
    }
    return [ours];
  }
  const end = at + n;
  const aEnd = aAt + aN;
  if (end <= aAt) return [ours];
  if (at >= aEnd) return [{ ...ours, index: at - aN }];
  const left = Math.max(0, Math.min(end, aAt) - at);
  const right = Math.max(0, end - Math.max(at, aEnd));
  const start = at < aAt ? at : aAt;
  if (left + right <= 0) return [];
  return [{ ...ours, index: start, n: left + right }];
}

export interface SubmitResult {
  duplicate: boolean;
  assignedRev: number | null;
  serverRev: number;
  delta: GridDelta | null;
  error?: string;
}

interface LogEntry {
  delta: GridDelta;
  sid: string;
  reqId: number;
}

/** Server log. Incoming wins a tie when its session id sorts first. */
export class ServerBook {
  rev = 0;
  /** Revision of the snapshot this process loaded. log[0] is the op that produced rev logBase+1. */
  logBase = 0;
  book: Book;
  log: LogEntry[] = [];
  acks = new Map<string, number | null>();

  constructor(book?: Book) {
    this.book = book ?? emptyBook();
  }

  submit(sid: string, reqId: number, baseRev: number, delta: GridDelta): SubmitResult {
    const key = sid + ":" + reqId;
    if (this.acks.has(key)) {
      return { duplicate: true, assignedRev: this.acks.get(key) ?? null, serverRev: this.rev, delta: null };
    }
    if (!Number.isInteger(baseRev) || baseRev < 0 || baseRev > this.rev) {
      return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null, error: "bad revision" };
    }
    let d = delta;
    for (let i = baseRev; i < this.rev; i++) {
      const hist = this.log[i - this.logBase];
      if (!hist) continue;
      d = transformGrid(d, hist.delta, sid < hist.sid);
    }
    d = { ops: d.ops.filter((op) => op.t) };
    if (!d.ops.length) {
      this.acks.set(key, null);
      return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null };
    }
    this.book = applyBook(this.book, d);
    this.rev++;
    this.log.push({ delta: d, sid, reqId });
    this.acks.set(key, this.rev);
    return { duplicate: false, assignedRev: this.rev, serverRev: this.rev, delta: d };
  }
}
