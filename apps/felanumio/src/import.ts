import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { a1ToIndex, canonicalNumber, dateSerial, displayValue, evaluate, indexToCol, isValidFormula, type GridRead } from "./formula.ts";
import { type Book, type Cell, type CellStyle, type CfRule, type ChartMark, type ChartSeries, type Merge, type Sheet, type Validation, cellKey } from "./ot.ts";

export interface ImportOptions {
  separator: "auto" | "," | ";" | "\t" | string;
  convert: boolean;
  keepLeadingZeros: boolean;
  invalidFormulaAsText: boolean;
  locale: "auto" | "us" | "eu";
  mode: "replace" | "insert" | "append";
}

export function defaultImportOptions(): ImportOptions {
  return {
    separator: "auto",
    convert: true,
    keepLeadingZeros: true,
    invalidFormulaAsText: true,
    locale: "auto",
    mode: "replace",
  };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export function detectSeparator(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  const sample = text.slice(0, 16000);
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      if (quoted && sample[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === "," || ch === ";" || ch === "\t")) counts[ch]++;
  }
  let best = ",";
  let n = -1;
  for (const sep of [",", ";", "\t"]) {
    if (counts[sep] > n) {
      best = sep;
      n = counts[sep];
    }
  }
  return best;
}

export function parseDelimited(text: string, sep: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function decimalComma(options: ImportOptions, sep: string): boolean {
  if (options.locale === "eu") return true;
  if (options.locale === "us") return false;
  return sep === ";";
}

function dateLocale(options: ImportOptions, sep: string): "us" | "eu" {
  if (options.locale === "eu" || (options.locale === "auto" && sep === ";")) return "eu";
  return "us";
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseDate(raw: string, locale: "us" | "eu"): { serial: number; fmt: string } | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (!validYmd(y, mo, d)) return null;
    const hh = +(m[4] || 0);
    const mi = +(m[5] || 0);
    const ss = +(m[6] || 0);
    return { serial: dateSerial(y, mo, d, hh, mi, ss), fmt: m[4] ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd" };
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    const y = +m[3];
    if (!validYmd(y, mo, d)) return null;
    return { serial: dateSerial(y, mo, d), fmt: "dd.mm.yyyy" };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    let mo = a;
    let d = b;
    if (locale === "eu" || a > 12) {
      d = a;
      mo = b;
    }
    if (!validYmd(y, mo, d)) return null;
    let hh = m[4] ? +m[4] : 0;
    const mi = m[5] ? +m[5] : 0;
    const ss = m[6] ? +m[6] : 0;
    const ap = (m[7] || "").toUpperCase();
    if (ap === "PM" && hh < 12) hh += 12;
    if (ap === "AM" && hh === 12) hh = 0;
    const yearTok = m[3].length <= 2 ? "yy" : "yyyy";
    const euOrder = locale === "eu" || a > 12;
    const left = (euOrder ? m[1] : m[1]).length >= 2 ? (euOrder ? "dd" : "mm") : euOrder ? "d" : "m";
    const right = m[2].length >= 2 ? (euOrder ? "mm" : "dd") : euOrder ? "m" : "d";
    const dateFmt = m[4] ? `${left}/${right}/${yearTok}` : locale === "eu" ? "dd/mm/yyyy" : "mm/dd/yyyy";
    const fmt = !m[4] ? dateFmt : ap ? `${dateFmt} h:mm AM/PM` : locale === "eu" ? `${dateFmt} hh:mm` : `${dateFmt} h:mm`;
    return { serial: dateSerial(y, mo, d, hh, mi, ss), fmt };
  }
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (!mo || !validYmd(y, mo, d)) return null;
    return { serial: dateSerial(y, mo, d), fmt: "mmm d, yyyy" };
  }
  m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTHS[m[2].toLowerCase()];
    const y = +m[3];
    if (!mo || !validYmd(y, mo, d)) return null;
    return { serial: dateSerial(y, mo, d), fmt: "d mmm yyyy" };
  }
  return null;
}

function parseLocaleNumber(raw: string, comma: boolean): number | null {
  let s = raw.trim();
  if (comma) {
    if (!/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s) && !/^-?\d+(?:,\d+)?$/.test(s)) return null;
    s = s.replace(/\./g, "").replace(",", ".");
  }
  return canonicalNumber(s);
}

export function convertField(raw: string, options: ImportOptions, sep: string): Cell {
  if (!options.convert) {
    if (raw.startsWith("=")) return { v: "'" + raw };
    return raw ? { v: raw } : {};
  }
  const trimmed = raw.trim();
  if (raw.startsWith("=")) {
    const formula = raw.startsWith("=") ? raw : "=" + raw;
    if (isValidFormula(formula)) return { v: formula.startsWith("=") ? formula : "=" + formula };
    if (options.invalidFormulaAsText) return { v: "'" + raw };
    return { v: raw };
  }
  if (/^0\d+$/.test(trimmed)) {
    if (options.keepLeadingZeros) return { v: raw };
    return { v: String(Number(trimmed)) };
  }
  const dated = parseDate(raw, dateLocale(options, sep));
  if (dated) return { v: String(dated.serial), style: { format: "date", numFmt: dated.fmt } };
  const n = parseLocaleNumber(raw, decimalComma(options, sep));
  if (n != null && trimmed !== "") return { v: String(n) };
  return raw ? { v: raw } : {};
}

export function rowsToSheet(rows: string[][], name: string, id: string, options: ImportOptions, sep: string): Sheet {
  const cells: Record<string, Cell> = {};
  let cols = 1;
  for (let r = 0; r < rows.length; r++) {
    cols = Math.max(cols, rows[r].length);
    for (let c = 0; c < rows[r].length; c++) {
      const cell = convertField(rows[r][c], options, sep);
      if (cell.v || cell.style) cells[cellKey(r, c)] = cell;
    }
  }
  return {
    id,
    name: name.slice(0, 40) || "Sheet1",
    rows: Math.max(1, rows.length),
    cols,
    cells,
    rowH: {},
    colW: {},
    freezeR: 0,
    freezeC: 0,
    merges: [],
    validations: [],
    rules: [],
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : "";
}

function zipText(files: Record<string, Uint8Array>, name: string): string {
  const data = files[name.replace(/^\//, "")];
  return data ? strFromU8(data) : "";
}

export function parseHtmlTable(html: string): string[][] | null {
  const table = /<table\b[\s\S]*?<\/table>/i.exec(html);
  if (!table) return null;
  const rows: string[][] = [];
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(table[0]))) {
    const cells: string[] = [];
    const cellRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[0]))) {
      const text = decodeXml(cell[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\u00a0/g, " ");
      cells.push(text);
      const span = Number(/colspan="(\d+)"/i.exec(cell[1])?.[1] || 1);
      for (let i = 1; i < span; i++) cells.push("");
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? rows : null;
}

function sheetTitle(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.slice(0, 40) || "Sheet1";
}

function freshId(index: number, existing: string[]): string {
  if (existing[index]) return existing[index];
  return "s" + Math.random().toString(36).slice(2, 10);
}

export function importText(filename: string, text: string, options: ImportOptions, existingIds: string[] = []): Book {
  const sep = !options.separator || options.separator === "auto" ? detectSeparator(text) : options.separator === "\\t" ? "\t" : options.separator;
  const rows = parseDelimited(text, sep);
  const sheet = rowsToSheet(rows, sheetTitle(filename), freshId(0, options.mode === "replace" ? existingIds : []), options, sep);
  return { sheets: [sheet], charts: [] };
}

const BUILTIN_FMT: Record<number, string> = {
  0: "general",
  1: "0",
  2: "0.00",
  9: "0%",
  10: "0.00%",
  14: "mm-dd-yy",
  49: "@",
};

function cssColor(token: string): string {
  if (!token) return "";
  const theme = /^(\d+)$/.exec(token);
  if (theme) {
    const table = ["#000000", "#FFFFFF", "#44546A", "#E7E6E6", "#4472C4", "#ED7D31", "#A9D08E", "#FFC000", "#5B9BD5", "#70AD47", "#0563C1", "#954F72"];
    return table[Number(theme[1])] || "";
  }
  const rgb = token.replace(/^#/, "");
  if (rgb.length === 8) return "#" + rgb.slice(2).toUpperCase();
  if (rgb.length === 6) return "#" + rgb.toUpperCase();
  return "";
}

function isDateFmt(fmt: string): boolean {
  const f = fmt.toLowerCase();
  if (!f || f === "general" || f === "@") return false;
  if (f.includes("#") || f.includes("%") || f.includes("$")) return false;
  return /[dy]/.test(f) && f.includes("m");
}

interface XStyle {
  style: CellStyle;
  text: boolean;
}

function grab(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?![A-Za-z0-9])`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const at = match.index;
    const gt = xml.indexOf(">", at);
    if (gt < 0) break;
    const head = xml.slice(at, gt + 1);
    if (head.endsWith("/>")) {
      out.push(head);
      re.lastIndex = gt + 1;
      continue;
    }
    const close = `</${name}>`;
    const end = xml.indexOf(close, gt);
    if (end < 0) break;
    out.push(xml.slice(at, end + close.length));
    re.lastIndex = end + close.length;
  }
  return out;
}

function parseStyles(xml: string): { xfs: XStyle[]; dxfs: string[] } {
  if (!xml) return { xfs: [], dxfs: [] };
  const fmts = { ...BUILTIN_FMT };
  for (const tag of grab(/<numFmts\b[\s\S]*?<\/numFmts>/.exec(xml)?.[0] || "", "numFmt")) fmts[Number(attr(tag, "numFmtId"))] = attr(tag, "formatCode");
  const fonts: { b: boolean; i: boolean; color: string }[] = [];
  for (const font of grab(/<fonts\b[\s\S]*?<\/fonts>/.exec(xml)?.[0] || "", "font")) {
    const colorTag = /<color\b[^>]*\/?>/.exec(font)?.[0] || "";
    const rgb = attr(colorTag, "rgb");
    const theme = attr(colorTag, "theme");
    fonts.push({
      b: /<b\b/.test(font) && attr(font.match(/<b\b[^>]*\/?>/)?.[0] || "", "val") !== "0",
      i: /<i\b/.test(font) && attr(font.match(/<i\b[^>]*\/?>/)?.[0] || "", "val") !== "0",
      color: rgb ? cssColor(rgb) : theme === "10" ? "#0563C1" : "",
    });
  }
  const fills: string[] = [];
  for (const fill of grab(/<fills\b[\s\S]*?<\/fills>/.exec(xml)?.[0] || "", "fill")) {
    const fg = /<fgColor\b[^>]*\/?>/.exec(fill)?.[0] || "";
    const pattern = /<patternFill\b[^>]*>/.exec(fill)?.[0] || "";
    const solid = attr(pattern, "patternType") === "solid";
    fills.push(solid ? cssColor(attr(fg, "rgb") || attr(fg, "theme")) : "");
  }
  const borders: boolean[] = [];
  for (const border of grab(/<borders\b[\s\S]*?<\/borders>/.exec(xml)?.[0] || "", "border")) borders.push(/style="[^"]+"/.test(border));
  const xfs: XStyle[] = [];
  for (const xf of grab(/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml)?.[0] || "", "xf")) {
    const open = xf.match(/<xf\b[^>]*>/)?.[0] || xf;
    const font = fonts[Number(attr(open, "fontId") || 0)] || { b: false, i: false, color: "" };
    const fmt = fmts[Number(attr(open, "numFmtId") || 0)] || "general";
    const style: CellStyle = {};
    if (font.b) style.b = true;
    if (font.i) style.i = true;
    if (font.color && font.color.toUpperCase() !== "#000000") style.color = font.color;
    const fill = fills[Number(attr(open, "fillId") || 0)] || "";
    if (fill && fill.toUpperCase() !== "#FFFFFF") style.fill = fill;
    if (borders[Number(attr(open, "borderId") || 0)]) style.border = true;
    const align = /<alignment\b[^>]*\/?>/.exec(xf)?.[0] || "";
    const horizontal = attr(align, "horizontal");
    if (horizontal === "center" || horizontal === "right" || horizontal === "left") style.align = horizontal;
    if (fmt.includes("%")) {
      style.format = "percent";
      style.numFmt = fmt;
    } else if (fmt.includes("$")) {
      style.format = "currency";
      style.numFmt = fmt;
    } else if (isDateFmt(fmt)) {
      style.format = "date";
      style.numFmt = fmt;
    } else if (fmt === "0.00" || fmt === "0") {
      style.format = "number";
      style.numFmt = fmt;
    }
    xfs.push({ style, text: attr(open, "quotePrefix") === "1" || fmt === "@" });
  }
  const dxfs: string[] = [];
  const dxfXml = /<dxfs\b[\s\S]*?<\/dxfs>/.exec(xml)?.[0] || "";
  for (const dxf of dxfXml.match(/<dxf\b[\s\S]*?<\/dxf>/g) || []) {
    const fg = /<fgColor\b[^>]*\/?>/.exec(dxf)?.[0] || "";
    dxfs.push(cssColor(attr(fg, "rgb") || attr(fg, "theme")));
  }
  return { xfs, dxfs };
}

function colLetters(cellRef: string): { r: number; c: number } | null {
  return a1ToIndex(cellRef.replace(/\$/g, ""));
}

function rangeOf(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const parts = ref.split(":");
  const a = colLetters(parts[0]);
  const b = colLetters(parts[1] || parts[0]);
  if (!a || !b) return null;
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

function rangesOf(sqref: string): Merge[] {
  const out: Merge[] = [];
  for (const part of sqref.split(/\s+/)) {
    const range = rangeOf(part);
    if (range) out.push(range);
  }
  return out;
}

function sharedStrings(xml: string): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) || []) {
    const texts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    out.push(texts.join(""));
  }
  return out;
}

function cellText(inner: string, kind: string, shared: string[]): string {
  if (kind === "inlineStr" || /<is\b/.test(inner)) {
    return [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (!v) return "";
  const raw = decodeXml(v[1]);
  if (kind === "s") return shared[Number(raw)] || "";
  if (kind === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function parseWorksheet(xml: string, rels: string, files: Record<string, Uint8Array>, styles: { xfs: XStyle[]; dxfs: string[] }, comments: Map<string, string>): {
  cells: Record<string, Cell>;
  rows: number;
  cols: number;
  rowH: Record<string, number>;
  colW: Record<string, number>;
  freezeR: number;
  freezeC: number;
  merges: Merge[];
  validations: Validation[];
  rules: CfRule[];
} {
  const shared = sharedStrings(zipText(files, "xl/sharedStrings.xml"));
  const cells: Record<string, Cell> = {};
  let rows = 1;
  let cols = 1;
  const rowH: Record<string, number> = {};
  const colW: Record<string, number> = {};
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const open = row.match(/<row\b[^>]*>/)?.[0] || "";
    const rIndex = Number(attr(open, "r") || 0) - 1;
    if (attr(open, "customHeight") === "1" && attr(open, "ht")) {
      const px = Math.round(Number(attr(open, "ht")) * (96 / 72));
      if (px >= 20 && px <= 400 && rIndex >= 0) rowH[String(rIndex)] = px;
    }
    for (const cell of row.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || []) {
      const tag = cell.match(/<c\b[^>]*>/)?.[0] || cell;
      const at = colLetters(attr(tag, "r"));
      if (!at) continue;
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cell);
      const kind = attr(tag, "t");
      let value = formula ? "=" + decodeXml(formula[1]) : cellText(cell, kind, shared);
      const xf = styles.xfs[Number(attr(tag, "s") || 0)];
      const style = xf ? { ...xf.style } : {};
      if (xf?.text && value && !value.startsWith("=")) value = "'" + value;
      if (!formula && style.format === "date" && canonicalNumber(value) != null) {
        /* serial stays numeric */
      } else if (!formula && value && canonicalNumber(value) == null && style.format === "date") {
        delete style.format;
        delete style.numFmt;
      }
      const item: Cell = {};
      if (value) item.v = value;
      if (Object.keys(style).length) item.style = style;
      const note = comments.get(attr(tag, "r").toUpperCase());
      if (note) item.note = note;
      if (item.v || item.style || item.note) cells[cellKey(at.r, at.c)] = item;
      rows = Math.max(rows, at.r + 1);
      cols = Math.max(cols, at.c + 1);
    }
  }
  const colsXml = /<cols\b[\s\S]*?<\/cols>/.exec(xml)?.[0] || "";
  for (const col of colsXml.match(/<col\b[^>]*\/?>/g) || []) {
    if (attr(col, "customWidth") !== "1") continue;
    const width = Number(attr(col, "width"));
    if (!Number.isFinite(width)) continue;
    const px = Math.max(20, Math.min(400, Math.round(width * 7 + 5)));
    const min = Number(attr(col, "min") || 1) - 1;
    const max = Number(attr(col, "max") || attr(col, "min") || 1) - 1;
    for (let c = min; c <= max && c < 256; c++) colW[String(c)] = px;
  }
  const pane = /<pane\b[^>]*\/?>/.exec(xml)?.[0] || "";
  const freezeR = attr(pane, "state") === "frozen" || attr(pane, "ySplit") || attr(pane, "xSplit") ? Number(attr(pane, "ySplit") || 0) : 0;
  const freezeC = attr(pane, "state") === "frozen" || attr(pane, "xSplit") ? Number(attr(pane, "xSplit") || 0) : 0;
  const merges: Merge[] = [];
  for (const tag of xml.match(/<mergeCell\b[^>]*\/?>/g) || []) {
    const range = rangeOf(attr(tag, "ref"));
    if (!range) continue;
    merges.push(range);
    rows = Math.max(rows, range.r2 + 1);
    cols = Math.max(cols, range.c2 + 1);
  }
  const linkRels = new Map<string, string>();
  for (const rel of rels.match(/<Relationship\b[^>]*\/?>/g) || []) {
    if (!attr(rel, "Type").includes("hyperlink")) continue;
    linkRels.set(attr(rel, "Id"), attr(rel, "Target"));
  }
  for (const link of xml.match(/<hyperlink\b[^>]*\/?>/g) || []) {
    const at = colLetters(attr(link, "ref"));
    if (!at) continue;
    const target = attr(link, "location") ? "#" + attr(link, "location") : linkRels.get(attr(link, "r:id") || attr(link, "id")) || "";
    if (!target) continue;
    const key = cellKey(at.r, at.c);
    const prev = cells[key] || {};
    cells[key] = { ...prev, link: target };
  }
  const validations: Validation[] = [];
  for (const rule of xml.match(/<dataValidation\b[\s\S]*?<\/dataValidation>/g) || []) {
    const open = rule.match(/<dataValidation\b[^>]*>/)?.[0] || "";
    if (attr(open, "type") && attr(open, "type") !== "list") continue;
    const formula = decodeXml(/<formula1>([\s\S]*?)<\/formula1>/.exec(rule)?.[1] || "");
    let list: string[] = [];
    if (formula.startsWith('"')) list = formula.replace(/^"|"$/g, "").split(",").map((item) => item.trim()).filter(Boolean);
    for (const range of rangesOf(attr(open, "sqref"))) validations.push({ ...range, list });
  }
  const rules: CfRule[] = [];
  for (const block of xml.match(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g) || []) {
    const sqref = attr(block.match(/<conditionalFormatting\b[^>]*>/)?.[0] || "", "sqref");
    for (const cf of block.match(/<cfRule\b[\s\S]*?<\/cfRule>/g) || []) {
      const open = cf.match(/<cfRule\b[^>]*>/)?.[0] || "";
      const type = attr(open, "type");
      for (const range of rangesOf(sqref)) {
        if (type === "cellIs") {
          const op = attr(open, "operator");
          const mapped = op === "greaterThan" ? "gt" : op === "lessThan" ? "lt" : op === "greaterThanOrEqual" ? "gte" : op === "lessThanOrEqual" ? "lte" : "eq";
          const formula = Number(decodeXml(/<formula>([\s\S]*?)<\/formula>/.exec(cf)?.[1] || "0"));
          rules.push({ kind: "cell", ...range, op: mapped, value: formula, fill: styles.dxfs[Number(attr(open, "dxfId") || 0)] || "#c6efce" });
        } else if (type === "colorScale") {
          const colors = [...cf.matchAll(/<color\b[^>]*\/?>/g)].map((m) => cssColor(attr(m[0], "rgb") || attr(m[0], "theme"))).filter(Boolean);
          rules.push({ kind: "scale", ...range, minColor: colors[0] || "#f8696b", maxColor: colors[colors.length - 1] || "#63be7b" });
        }
      }
    }
  }
  return { cells, rows, cols, rowH, colW, freezeR, freezeC, merges, validations, rules };
}

function commentsOf(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const comment of xml.match(/<comment\b[\s\S]*?<\/comment>/g) || []) {
    const ref = attr(comment.match(/<comment\b[^>]*>/)?.[0] || "", "ref").toUpperCase();
    const parts = [...comment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).filter((part) => part.length);
    const text = parts.length && parts.every((part) => part === parts[0]) ? parts[0] : parts.join("");
    if (!ref || !text) continue;
    const prev = map.get(ref);
    if (!prev) map.set(ref, text);
    else if (prev !== text && !prev.split("\n").includes(text)) map.set(ref, prev + "\n" + text);
  }
  return map;
}

/** One card per quote+text, so a cell note and the thread created from it do not both show. */
export function uniqueComments<T extends { quote?: string; text: string }>(
  threads: T[],
  notes: { quote: string; text: string }[],
): { quote: string; text: string; thread?: T }[] {
  const seen = new Set<string>();
  const out: { quote: string; text: string; thread?: T }[] = [];
  for (const thread of threads) {
    const quote = thread.quote || "";
    const key = quote + "\n" + thread.text;
    if (!thread.text || seen.has(key)) continue;
    seen.add(key);
    out.push({ quote, text: thread.text, thread });
  }
  for (const note of notes) {
    const key = note.quote + "\n" + note.text;
    if (!note.text || seen.has(key)) continue;
    seen.add(key);
    out.push({ quote: note.quote, text: note.text });
  }
  return out;
}

function relTarget(rels: string, id: string): string {
  for (const rel of rels.match(/<Relationship\b[^>]*\/?>/g) || []) {
    if (attr(rel, "Id") === id) return attr(rel, "Target");
  }
  return "";
}

function parseChartRef(ref: string): { sheet: string; r1: number; c1: number; r2: number; c2: number } | null {
  let body = decodeXml(ref).trim().replace(/\$/g, "");
  let sheet = "";
  const bang = body.lastIndexOf("!");
  if (bang >= 0) {
    sheet = body.slice(0, bang).replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
    body = body.slice(bang + 1);
  }
  const range = rangeOf(body);
  if (!range) return null;
  return { sheet, ...range };
}

function parseChart(xml: string, sheetId: string): ChartMark | null {
  if (!xml) return null;
  const title = decodeXml(/<a:t>([\s\S]*?)<\/a:t>/.exec(xml)?.[1] || "");
  const kind = /<barChart\b/.test(xml) ? "bar" : /<lineChart\b/.test(xml) ? "line" : /<pieChart\b/.test(xml) || /<ofPieChart\b/.test(xml) ? "pie" : "placeholder";
  const series: ChartSeries[] = [];
  for (const ser of xml.match(/<ser\b[\s\S]*?<\/ser>/g) || []) {
    const nameRef = /<tx\b[\s\S]*?<f>([\s\S]*?)<\/f>/.exec(ser)?.[1] || "";
    const catRef = /<cat\b[\s\S]*?<f>([\s\S]*?)<\/f>/.exec(ser)?.[1] || "";
    const valRef = /<val\b[\s\S]*?<f>([\s\S]*?)<\/f>/.exec(ser)?.[1] || "";
    const val = parseChartRef(valRef);
    const cat = parseChartRef(catRef);
    if (!val) continue;
    series.push({
      name: decodeXml(nameRef).replace(/\$/g, ""),
      sheet: val.sheet,
      r1: val.r1,
      c1: val.c1,
      r2: val.r2,
      c2: val.c2,
      catSheet: cat?.sheet || val.sheet,
      catR1: cat?.r1 ?? val.r1,
      catC1: cat?.c1 ?? val.c1,
      catR2: cat?.r2 ?? val.r2,
      catC2: cat?.c2 ?? val.c1,
    });
  }
  const first = series[0];
  const r1 = first?.r1 ?? 0;
  const c1 = first?.c1 ?? 0;
  const r2 = first?.r2 ?? 0;
  const c2 = first?.c2 ?? 0;
  const note = kind === "placeholder" ? (title ? `Chart: ${title}` : "Chart") : title;
  return { id: "h" + Math.random().toString(36).slice(2, 10), sheet: sheetId, r1, c1, r2, c2, kind, title, note, series };
}

function chartWalk(r1: number, c1: number, r2: number, c2: number): { r: number; c: number }[] {
  const pts: { r: number; c: number }[] = [];
  if (c2 - c1 > r2 - r1) {
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) pts.push({ r, c });
  } else {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) pts.push({ r, c });
  }
  return pts;
}

/** Category labels and series values, including refs like Sales!$B$2:$B$4. */
export function chartPoints(book: Book, chart: ChartMark): { name: string; n: number }[] {
  const host = book.sheets.find((sheet) => sheet.id === chart.sheet)?.name || book.sheets[0]?.name || "";
  const read: GridRead = {
    sheets: () => book.sheets.map((sheet) => sheet.name),
    raw: (name, r, c) => book.sheets.find((sheet) => sheet.name === name)?.cells[cellKey(r, c)]?.v || "",
  };
  const sheetName = (name: string) => name || host;
  const label = (name: string, r: number, c: number): string => {
    const sheet = sheetName(name);
    const cell = book.sheets.find((item) => item.name === sheet)?.cells[cellKey(r, c)];
    const raw = cell?.v || "";
    if (!raw) return "";
    if (raw.startsWith("'")) return raw.slice(1);
    if (raw.startsWith("=") || (cell?.style?.format && cell.style.format !== "general")) {
      return displayValue(evaluate(read, sheet, raw), cell?.style?.format || "general", cell?.style?.numFmt);
    }
    return raw;
  };
  const num = (name: string, r: number, c: number): number | null => {
    const sheet = sheetName(name);
    const raw = read.raw(sheet, r, c);
    if (!raw || raw.startsWith("'")) return null;
    const value = evaluate(read, sheet, raw);
    return value.t === "n" ? value.n : null;
  };
  const series = chart.series?.length ? chart.series : [];
  const out: { name: string; n: number }[] = [];
  if (!series.length) {
    for (const pt of chartWalk(chart.r1, chart.c1, chart.r2, chart.c2)) {
      const n = num(host, pt.r, pt.c);
      if (n == null) continue;
      out.push({ name: indexToCol(pt.c) + (pt.r + 1), n });
    }
    return out;
  }
  for (const ser of series) {
    const vals = chartWalk(ser.r1, ser.c1, ser.r2, ser.c2);
    const cats = chartWalk(ser.catR1, ser.catC1, ser.catR2, ser.catC2);
    vals.forEach((pt, i) => {
      const n = num(ser.sheet, pt.r, pt.c);
      if (n == null) return;
      const cat = cats[i];
      const name = cat ? label(ser.catSheet, cat.r, cat.c) : "";
      out.push({ name: name || indexToCol(pt.c) + (pt.r + 1), n });
    });
  }
  return out;
}

function chartsFor(files: Record<string, Uint8Array>, sheetPath: string, sheetId: string): ChartMark[] {
  const rels = zipText(files, sheetPath.replace(/([^/]+)$/, "_rels/$1.rels"));
  const out: ChartMark[] = [];
  for (const rel of rels.match(/<Relationship\b[^>]*\/?>/g) || []) {
    if (!attr(rel, "Type").includes("/drawing")) continue;
    const target = attr(rel, "Target").replace(/^\//, "");
    const drawingPath = target.startsWith("xl/") ? target : "xl/" + target.replace(/^\.\.\//, "");
    const drawing = zipText(files, drawingPath);
    const drawingRels = zipText(files, drawingPath.replace(/([^/]+)$/, "_rels/$1.rels"));
    for (const chartRel of drawing.match(/r:id="([^"]+)"/g) || []) {
      const id = chartRel.slice(6, -1);
      const chartTarget = relTarget(drawingRels, id);
      if (!chartTarget.includes("chart")) continue;
      const chartPath = chartTarget.startsWith("/") ? chartTarget.slice(1) : drawingPath.replace(/[^/]+$/, "") + chartTarget.replace(/^\.\.\//, "");
      const normalized = chartPath.replace(/[^/]+\/\.\.\//g, "");
      const chart = parseChart(zipText(files, normalized) || zipText(files, "xl/charts/" + chartTarget.split("/").pop()), sheetId);
      if (chart) out.push(chart);
    }
  }
  return out;
}

function importXlsx(bytes: Uint8Array, existingIds: string[]): Book {
  const files = unzipSync(bytes);
  const workbook = zipText(files, "xl/workbook.xml");
  const wbRels = zipText(files, "xl/_rels/workbook.xml.rels");
  const styles = parseStyles(zipText(files, "xl/styles.xml"));
  const sheets: Sheet[] = [];
  const charts: ChartMark[] = [];
  const tags = workbook.match(/<sheet\b[^>]*\/?>/g) || [];
  tags.forEach((tag, index) => {
    const name = attr(tag, "name") || "Sheet" + (index + 1);
    const id = freshId(index, existingIds);
    const rid = attr(tag, "r:id") || attr(tag, "id");
    let target = relTarget(wbRels, rid).replace(/^\//, "");
    if (target.startsWith("../")) target = "xl/" + target.replace(/^\.\.\//, "");
    if (!target.startsWith("xl/")) target = "xl/" + target;
    const xml = zipText(files, target);
    const rels = zipText(files, target.replace(/([^/]+)$/, "_rels/$1.rels"));
    const commentTarget = relTarget(rels, "comments") || [...rels.matchAll(/Target="([^"]*comment[^"]*)"/g)].map((m) => m[1])[0] || "";
    const commentPath = commentTarget.startsWith("/") ? commentTarget.slice(1) : commentTarget ? "xl/" + commentTarget.replace(/^\.\.\//, "") : "";
    const parsed = parseWorksheet(xml, rels, files, styles, commentsOf(commentPath ? zipText(files, commentPath) : ""));
    sheets.push({
      id,
      name: name.slice(0, 40),
      rows: parsed.rows,
      cols: parsed.cols,
      cells: parsed.cells,
      rowH: parsed.rowH,
      colW: parsed.colW,
      freezeR: parsed.freezeR,
      freezeC: parsed.freezeC,
      merges: parsed.merges,
      validations: parsed.validations,
      rules: parsed.rules,
    });
    charts.push(...chartsFor(files, target, id));
  });
  return { sheets: sheets.length ? sheets : [{ id: "s1", name: "Sheet1", rows: 1, cols: 1, cells: {}, rowH: {}, colW: {}, freezeR: 0, freezeC: 0, merges: [], validations: [], rules: [] }], charts };
}

export function odsFormula(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("of:")) s = s.slice(3);
  if (!s.startsWith("=")) s = "=" + s;
  s = s.replace(/\[\$([^.\]]+)\.([A-Za-z]+\d+)\s*:\s*\.?\$?(?:[^.\]]+)\.([A-Za-z]+\d+)\]/g, "$1!$2:$3");
  s = s.replace(/\[\$([^.\]]+)\.([A-Za-z]+\d+)\]/g, "$1!$2");
  s = s.replace(/\[\.([A-Za-z]+\d+)\s*:\s*\.([A-Za-z]+\d+)\]/g, "$1:$2");
  s = s.replace(/\[\.([A-Za-z]+\d+)\]/g, "$1");
  return s;
}

function importOds(bytes: Uint8Array, options: ImportOptions, existingIds: string[]): Book {
  const files = unzipSync(bytes);
  const xml = zipText(files, "content.xml");
  const sheets: Sheet[] = [];
  const tables = xml.split(/<table:table(?![A-Za-z0-9_-])/).slice(1);
  tables.forEach((table, index) => {
    const chunk = table.split(/<\/table:table>/)[0];
    const name = attr(chunk.slice(0, 300), "table:name") || "Sheet" + (index + 1);
    const rows: string[][] = [];
    const formulas = new Map<string, string>();
    for (const rowXml of chunk.split(/<table:table-row\b/).slice(1)) {
      const rowChunk = rowXml.split(/<\/table:table-row>/)[0];
      const rowRepeat = Math.min(100, Number(attr(rowChunk.slice(0, 200), "table:number-rows-repeated") || 1));
      const line: string[] = [];
      for (const cellXml of rowChunk.split(/<table:table-cell\b/).slice(1)) {
        const cell = cellXml.split(/<\/table:table-cell>/)[0];
        const open = cell.match(/^[^>]*>/)?.[0] || "";
        const repeat = Math.min(50, Number(attr(open, "table:number-columns-repeated") || 1));
        const formula = attr(open, "table:formula");
        const type = attr(open, "office:value-type");
        const value = attr(open, "office:value");
        const text = [...cell.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => decodeXml(m[1].replace(/<[^>]+>/g, ""))).join("\n");
        let shown = formula ? formula : type === "float" && value ? value : text;
        for (let n = 0; n < repeat; n++) {
          if (formula) formulas.set(rows.length + "," + line.length, formula);
          line.push(shown);
        }
      }
      for (let n = 0; n < (line.some((item) => item) ? 1 : Math.min(rowRepeat, 1)); n++) rows.push([...line]);
      if (!line.some((item) => item) && rowRepeat > 1) {
        /* repeated empty rows are padding */
      } else if (line.some((item) => item)) {
        for (let n = 1; n < rowRepeat; n++) rows.push([...line]);
      }
    }
    const sheet = rowsToSheet(rows, name, freshId(index, existingIds), { ...options, convert: true }, ",");
    for (const [key, formula] of formulas) {
      const converted = odsFormula(formula);
      const prev = sheet.cells[key] || {};
      sheet.cells[key] = { ...prev, v: isValidFormula(converted) ? converted : options.invalidFormulaAsText ? "'" + converted : converted };
    }
    sheets.push(sheet);
  });
  return { sheets, charts: [] };
}

export function importBytes(filename: string, bytes: Uint8Array, options: ImportOptions, existingIds: string[] = []): Book {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || (!lower.endsWith(".ods") && bytes[0] === 0x50 && bytes[1] === 0x4b && !lower.endsWith(".csv") && !lower.endsWith(".tsv"))) {
    try {
      const files = unzipSync(bytes);
      if (files["content.xml"] || (files["mimetype"] && strFromU8(files["mimetype"]).includes("opendocument"))) return importOds(bytes, options, options.mode === "replace" ? existingIds : []);
      if (files["xl/workbook.xml"]) return importXlsx(bytes, options.mode === "replace" ? existingIds : []);
    } catch {
      /* fall through to text */
    }
  }
  if (lower.endsWith(".ods")) return importOds(bytes, options, options.mode === "replace" ? existingIds : []);
  return importText(filename, strFromU8(bytes), options, existingIds);
}

export function sheetCsv(sheet: Sheet, display: (cell: Cell) => string): string {
  const lines: string[] = [];
  for (let r = 0; r < sheet.rows; r++) {
    const cols: string[] = [];
    let last = -1;
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.cells[cellKey(r, c)];
      const raw = cell?.v || "";
      const text = raw.startsWith("'") ? raw.slice(1) : raw.startsWith("=") ? raw : display(cell || {});
      if (text) last = c;
      cols.push(text);
    }
    lines.push(cols.slice(0, Math.max(0, last + 1)).map((value) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(","));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function colName(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(sheet: Sheet): string {
  const rows: string[] = [];
  for (let r = 0; r < sheet.rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.cells[cellKey(r, c)];
      if (!cell?.v) continue;
      const ref = colName(c) + (r + 1);
      const value = cell.v.startsWith("'") ? cell.v.slice(1) : cell.v;
      if (value.startsWith("=")) cells.push(`<c r="${ref}"><f>${escXml(value.slice(1))}</f></c>`);
      else if (canonicalNumber(value) != null) cells.push(`<c r="${ref}" t="n"><v>${escXml(value)}</v></c>`);
      else cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escXml(value)}</t></is></c>`);
    }
    if (cells.length) rows.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

export function bookXlsx(book: Book): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const overrides = book.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  const sheetTags = book.sheets.map((sheet, i) => `<sheet name="${escXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`);
  const rels = book.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
  book.sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files);
}

function toOdsFormula(formula: string): string {
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  const next = body.replace(/((?:'[^']+'|[A-Za-z_][A-Za-z0-9_]*)!)?(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?/g, (_full, sheet: string, a: string, b: string) => {
    const name = sheet ? sheet.slice(0, -1).replace(/'/g, "") : "";
    if (b) return name ? `[$${name}.${a}:.${b}]` : `[.${a}:.${b}]`;
    return name ? `[$${name}.${a}]` : `[.${a}]`;
  });
  return "of:=" + next;
}

export function bookOds(book: Book): Uint8Array {
  const tables = book.sheets.map((sheet) => {
    const rows: string[] = [];
    for (let r = 0; r < sheet.rows; r++) {
      const cells: string[] = [];
      let any = false;
      for (let c = 0; c < sheet.cols; c++) {
        const cell = sheet.cells[cellKey(r, c)];
        const value = cell?.v?.startsWith("'") ? cell.v.slice(1) : cell?.v || "";
        if (!value) {
          cells.push(`<table:table-cell/>`);
          continue;
        }
        any = true;
        if (value.startsWith("=")) cells.push(`<table:table-cell table:formula="${escXml(toOdsFormula(value))}" office:value-type="float"/>`);
        else if (canonicalNumber(value) != null) cells.push(`<table:table-cell office:value-type="float" office:value="${escXml(value)}"><text:p>${escXml(value)}</text:p></table:table-cell>`);
        else cells.push(`<table:table-cell office:value-type="string"><text:p>${escXml(value)}</text:p></table:table-cell>`);
      }
      if (any) rows.push(`<table:table-row>${cells.join("")}</table:table-row>`);
    }
    return `<table:table table:name="${escXml(sheet.name)}">${rows.join("")}</table:table>`;
  });
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet>${tables.join("")}</office:spreadsheet></office:body></office:document-content>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return zipSync({
    mimetype: [strToU8("application/vnd.oasis.opendocument.spreadsheet"), { level: 0 }],
    "META-INF/manifest.xml": strToU8(manifest),
    "content.xml": strToU8(content),
  });
}
