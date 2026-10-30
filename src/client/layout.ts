import { type Doc, type Heading, chipLabel, dropOptions, paragraphStyle, voteMap } from "../shared/doc.ts";
import { CELL, EMBED, ROW, isBreak } from "../shared/delta.ts";
import { type EqNode, parseEquation } from "../shared/equation.ts";
import { COLLAB_PALETTE, hexAlpha } from "../shared/palette.ts";
import { textColumns } from "../shared/section.ts";

import { type PageSpec, normalizePage, DEFAULT_PAGE, fillPage } from "../shared/page.ts";

export let PAGE_W = DEFAULT_PAGE.w;
export let PAGE_H = DEFAULT_PAGE.h;
export let ML = DEFAULT_PAGE.ml;
export let MR = DEFAULT_PAGE.mr;
export let MT = DEFAULT_PAGE.mt;
export let MB = DEFAULT_PAGE.mb;
let paperName: PageSpec["paper"] = DEFAULT_PAGE.paper;
let orientName: PageSpec["orient"] = DEFAULT_PAGE.orient;
export let PAGELESS = false;
export let FLOW_H = DEFAULT_PAGE.h;
let headerText = "";
let footerText = "";
let headerFirstText = "";
let footerFirstText = "";
let differentFirst = false;
export const PAGE_GAP = 20;
export const RULER_H = 28;

let imageDraft: { index: number; w: number; h: number; rot: number } | null = null;

export function setImageDraft(next: { index: number; w: number; h: number; rot?: number } | null): void {
  imageDraft = next ? { index: next.index, w: next.w, h: next.h, rot: next.rot || 0 } : null;
}

export function rotatedSize(w: number, h: number, rot: number): { w: number; h: number } {
  const rad = (((rot % 360) + 360) % 360) * (Math.PI / 180);
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { w: w * c + h * s, h: w * s + h * c };
}

export function pageSize(): { w: number; h: number } {
  return { w: PAGE_W, h: PAGELESS ? FLOW_H : PAGE_H };
}

export function contentWidth(): number {
  return PAGE_W - ML - MR;
}

export function currentPage(): PageSpec {
  return {
    w: PAGE_W,
    h: PAGE_H,
    ml: ML,
    mr: MR,
    mt: MT,
    mb: MB,
    paper: paperName,
    orient: orientName,
    pageless: PAGELESS,
    differentFirst,
    header: headerText,
    footer: footerText,
    headerFirst: headerFirstText,
    footerFirst: footerFirstText,
  };
}

export function applyPage(input: unknown): PageSpec {
  const next = normalizePage(input);
  PAGE_W = next.w;
  PAGE_H = next.h;
  ML = next.ml;
  MR = next.mr;
  MT = next.mt;
  MB = next.mb;
  paperName = next.paper;
  orientName = next.orient;
  PAGELESS = next.pageless;
  differentFirst = next.differentFirst;
  headerText = next.header;
  footerText = next.footer;
  headerFirstText = next.headerFirst;
  footerFirstText = next.footerFirst;
  if (!PAGELESS) FLOW_H = PAGE_H;
  return next;
}

const HEAD_PT: Record<Heading, number> = { title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14, h4: 12, h5: 11, h6: 11, normal: 11 };
const SPACE_BEFORE: Record<Heading, number> = { title: 0, subtitle: 4, h1: 16, h2: 12, h3: 10, h4: 8, h5: 6, h6: 4, normal: 0 };

export interface Glyph {
  i: number;
  x: number;
  w: number;
}

export interface CellBox {
  x: number;
  w: number;
  start: number;
  end: number;
}

export interface LineBox {
  page: number;
  x: number;
  y: number;
  h: number;
  baseline: number;
  start: number;
  end: number;
  hard: boolean;
  glyphs: Glyph[];
  marker?: string;
  markerX: number;
  rule?: boolean;
  table?: { cols: number; cells: CellBox[] };
  section?: "cont" | "next" | "page";
}

export interface Gutter {
  page: number;
  x: number;
  y0: number;
  y1: number;
}

export interface Footnote {
  page: number;
  index: number;
  n: number;
  text: string;
}

export interface Layout {
  lines: LineBox[];
  pages: number;
  notes: Footnote[];
  gutters: Gutter[];
}

function ptPx(pt: number): number {
  return (pt * 96) / 72;
}

function headingOf(doc: Doc, index: number): Heading {
  const h = paragraphStyle(doc, index).h;
  return h && h in HEAD_PT ? h : "normal";
}

interface Face {
  css: string;
  size: number;
  color: string;
  underline: boolean;
  strike: boolean;
  hl: string;
  script: "sup" | "sub" | "";
}

export function fontString(doc: Doc, index: number): Face {
  const st = doc.styles[index] || {};
  const para = paragraphStyle(doc, index);
  let pt = st.size || HEAD_PT[headingOf(doc, index)];
  const script = st.sup ? "sup" : st.sub ? "sub" : "";
  if (script) pt = Math.max(6, pt * 0.65);
  const size = ptPx(pt);
  const family = st.font || "Open Sans";
  const weight = st.b ? 700 : 400;
  const style = st.i ? "italic" : "normal";
  const color = st.link ? "#1155cc" : st.color || (para.h === "subtitle" ? "#666666" : "#202124");
  return {
    css: `${style} ${weight} ${size}px "${family}"`,
    size,
    color,
    underline: !!st.u || !!st.link,
    strike: !!st.strike,
    hl: st.hl || "",
    script,
  };
}

interface Measured {
  i: number;
  ch: string;
  w: number;
}

const images = new Map<string, HTMLImageElement>();
let repaint: (() => void) | null = null;

export function onNeedPaint(fn: () => void): void {
  repaint = fn;
}

function loadImage(src: string): HTMLImageElement {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => repaint?.();
    img.onerror = () => repaint?.();
    img.src = src;
    images.set(src, img);
  }
  return img;
}

function imageRaw(st: Doc["styles"][number] | undefined, index: number): { w: number; h: number; rot: number } {
  if (imageDraft && imageDraft.index === index) return imageDraft;
  return { w: st?.iw || 240, h: st?.ih || 160, rot: st?.rot || 0 };
}

function imageExtent(st: Doc["styles"][number] | undefined, index: number): { w: number; h: number; rot: number; rawW: number; rawH: number } {
  const raw = imageRaw(st, index);
  const w = Math.min(contentWidth(), Math.max(24, raw.w));
  const h = Math.min(800, Math.max(24, raw.h));
  const box = rotatedSize(w, h, raw.rot);
  return { w: box.w, h: box.h, rot: raw.rot, rawW: w, rawH: h };
}

function embedWidth(ctx: CanvasRenderingContext2D, doc: Doc, index: number): number {
  const st = doc.styles[index] || {};
  if (st.embed === "fn") return 16;
  if (st.embed === "eq") return Math.min(contentWidth(), Math.max(28, parseEquation(st.label || "").w * 16 + 8));
  if (st.embed === "img") return Math.min(contentWidth(), Math.max(24, imageExtent(st, index).w));
  ctx.font = `500 12px "Roboto", sans-serif`;
  if (st.embed === "vote") return Math.min(280, 46 + Object.keys(voteMap(st)).length * 18);
  return Math.min(280, ctx.measureText(chipLabel(st) || "Chip").width + 28);
}

function smallCapCss(css: string, size: number): string {
  const next = Math.max(6, Math.round(size * 0.75));
  return css.replace(`${size}px`, `${next}px`);
}

function measureRun(ctx: CanvasRenderingContext2D, doc: Doc, from: number, to: number): Measured[] {
  const out: Measured[] = [];
  let pos = from;
  while (pos < to) {
    const ch = doc.text[pos];
    if (ch === EMBED) {
      out.push({ i: pos, ch, w: embedWidth(ctx, doc, pos) });
      pos++;
      continue;
    }
    if (ch === CELL) {
      out.push({ i: pos, ch, w: 0 });
      pos++;
      continue;
    }
    const face = fontString(doc, pos);
    let j = pos + 1;
    while (j < to && doc.text[j] !== EMBED && doc.text[j] !== CELL && fontString(doc, j).css === face.css) j++;
    ctx.font = face.css;
    for (let k = pos; k < j; k++) {
      const glyph = doc.text[k];
      let w = glyph === "\t" ? face.size * 2 : ctx.measureText(glyph).width || face.size * 0.5;
      if (doc.styles[k]?.sc && glyph >= "a" && glyph <= "z") {
        ctx.font = smallCapCss(face.css, face.size);
        w = ctx.measureText(glyph.toUpperCase()).width || w;
        ctx.font = face.css;
      }
      out.push({ i: k, ch: glyph, w });
    }
    pos = j;
  }
  return out;
}

function blockHeight(doc: Doc, from: number, to: number, base: number): number {
  let h = base;
  for (let k = from; k < to; k++) {
    const st = doc.styles[k];
    if (!st) continue;
    if (st.embed === "img") h = Math.max(h, imageExtent(st, k).h + 6);
    else if (st.embed === "eq") h = Math.max(h, (parseEquation(st.label || "").h + parseEquation(st.label || "").d) * 16 + 10);
    else if (st.embed) h = Math.max(h, 26);
  }
  return h;
}

export function stackOffset(page: number, y: number): number {
  if (PAGELESS) return RULER_H + y;
  return RULER_H + page * (PAGE_H + PAGE_GAP) + y;
}

function estimateHeight(doc: Doc, from: number): number {
  let chars = 0;
  for (let i = from; i < doc.text.length; i++) {
    const ch = doc.text[i];
    if (ch === "\f") break;
    if (!isBreak(ch) && ch !== CELL && ch !== EMBED) chars++;
    else if (ch === EMBED) chars += 8;
  }
  return Math.max(1, Math.ceil(chars / 42)) * 24;
}

export function layoutDoc(doc: Doc, ctx: CanvasRenderingContext2D): Layout {
  const lines: LineBox[] = [];
  const gutters: Gutter[] = [];
  let page = 0;
  let y = MT;
  const n = doc.text.length;
  let i = 0;
  let numberRun = 0;
  let numberLv = -1;
  let guard = 0;
  let colCount = 1;
  let col = 0;
  let colTop = MT;
  let colLimit = PAGE_H - MB;
  const colBottoms: number[] = [];
  const COL_GAP = 18;

  const notesOf: number[][] = [];
  const noteList = (p: number) => {
    while (notesOf.length <= p) notesOf.push([]);
    return notesOf[p];
  };
  const reserveFor = (p: number, extra: number) => {
    if (PAGELESS) return 0;
    const count = (notesOf[p]?.length || 0) + extra;
    return count ? 12 + count * 18 : 0;
  };
  const fnOf = (glyphs: { i: number }[]) => glyphs.filter((g) => doc.styles[g.i]?.embed === "fn").map((g) => g.i);
  const takeNotes = (ids: number[]) => {
    if (ids.length) noteList(page).push(...ids);
  };
  const bandBottom = () => colBottoms.reduce((max, value) => Math.max(max, value), y);
  const arm = (from: number) => {
    const pageInner = PAGE_H - MT - MB;
    if (colCount <= 1) {
      colLimit = PAGELESS ? Number.POSITIVE_INFINITY : PAGE_H - MB;
      return;
    }
    const want = Math.ceil(estimateHeight(doc, from) / colCount) + 8;
    colLimit = colTop + Math.min(pageInner, Math.max(36, want));
  };
  const origin = (indent: number) => {
    const gap = colCount > 1 ? COL_GAP : 0;
    const band = (contentWidth() - gap * (colCount - 1)) / colCount;
    return { x: ML + col * (band + gap) + indent, inner: Math.max(40, band - indent) };
  };
  const retarget = (next: number) => {
    if (next === colCount) return;
    if (col !== 0 || y > colTop + 1) {
      y = bandBottom();
      col = 0;
      colTop = y;
      colBottoms.length = 0;
    }
    colCount = next;
    arm(i);
  };
  const noteGutter = (y0: number, h: number) => {
    if (colCount < 2) return;
    const gap = COL_GAP;
    const band = (contentWidth() - gap * (colCount - 1)) / colCount;
    for (let c = 1; c < colCount; c++) gutters.push({ page, x: ML + c * (band + gap) - gap / 2, y0, y1: y0 + h });
  };

  const newPage = () => {
    if (PAGELESS) return;
    page++;
    y = MT;
  };
  const overflow = (h: number, extra: number) => {
    if (PAGELESS && colCount <= 1) return false;
    const pageLimit = PAGELESS ? colTop + (PAGE_H - MT - MB) : PAGE_H - MB - reserveFor(page, extra);
    const limit = Math.min(pageLimit, colLimit);
    return y + h > limit && y > colTop + 0.5;
  };
  const bump = () => {
    if (colCount <= 1) {
      newPage();
      col = 0;
      colTop = y;
      colBottoms.length = 0;
      arm(i);
      return;
    }
    colBottoms[col] = y;
    col++;
    if (col >= colCount) {
      if (PAGELESS) y = bandBottom() + 8;
      else newPage();
      col = 0;
      colTop = y;
      colBottoms.length = 0;
      arm(i);
    } else y = colTop;
  };
  const breakSection = (sec?: string) => {
    if (sec === "cont") {
      y = bandBottom();
      col = 0;
      colTop = y;
      colBottoms.length = 0;
      return;
    }
    if (PAGELESS) y += sec ? 16 : 28;
    else newPage();
    col = 0;
    colTop = y;
    colBottoms.length = 0;
    arm(i);
  };

  while (i < n && guard++ < n + 10) {
    const breakAt = (() => {
      let k = i;
      while (k < n && !isBreak(doc.text[k])) k++;
      return Math.min(k, n - 1);
    })();
    const para = paragraphStyle(doc, i);
    const heading = headingOf(doc, breakAt);
    const hardCh = doc.text[breakAt];
    const sample = fontString(doc, i < breakAt ? i : breakAt);
    const mul = para.lh && para.lh > 0 ? para.lh : 1.15;
    const lineH = blockHeight(doc, i, breakAt, Math.max(18, Math.round(sample.size * mul * 1.2)));
    if (hardCh !== ROW) retarget(textColumns(para));
    else if (col !== 0 || y > colTop + 1) {
      y = bandBottom();
      col = 0;
      colTop = y;
      colBottoms.length = 0;
      arm(i);
    }
    const indent = (para.ind || 0) * 36 + (para.list ? 26 : 0) + (para.lv || 0) * 18;
    const inner = hardCh === ROW ? Math.max(40, contentWidth() - indent) : origin(indent).inner;

    let marker: string | undefined;
    if (para.list === "bullet") {
      numberRun = 0;
      numberLv = -1;
      marker = "•";
    } else if (para.list === "numbered") {
      if ((para.lv || 0) !== numberLv) {
        numberRun = 0;
        numberLv = para.lv || 0;
      }
      numberRun += 1;
      marker = numberRun + ".";
    } else if (para.list === "check") {
      numberRun = 0;
      numberLv = -1;
      marker = para.check ? "checked" : "check";
    } else {
      numberRun = 0;
      numberLv = -1;
    }

    const afterPx = para.sa != null && para.sa > 0 ? ptPx(para.sa) : 0;
    const sectionMark = (): LineBox["section"] =>
      hardCh === "\f" ? (para.sec === "cont" || para.sec === "next" ? para.sec : "page") : undefined;
    const place = (glyphs: Glyph[], hard: boolean, endIndex: number, h: number, rule = false, table?: LineBox["table"]) => {
      const ids = fnOf(glyphs);
      if (overflow(h, ids.length)) bump();
      const at = origin(indent);
      lines.push({
        page,
        x: table ? ML : at.x,
        y,
        h,
        baseline: y + Math.round(Math.min(h - 4, sample.size * 1.05)),
        start: glyphs[0]?.i ?? endIndex,
        end: endIndex,
        hard,
        glyphs,
        marker: hard ? marker : undefined,
        markerX: (table ? ML : origin(0).x) + (para.ind || 0) * 36 + (para.lv || 0) * 18,
        rule,
        table,
        section: hard ? sectionMark() : undefined,
      });
      noteGutter(y, h);
      y += h;
      takeNotes(ids);
      if (hard && afterPx) y += afterPx;
    };

    if (para.hr) {
      place([], true, breakAt + 1, 18, true);
      if (hardCh === "\f") breakSection(para.sec);
      i = breakAt + 1;
      continue;
    }

    if (hardCh === ROW && (para.cols || 0) > 0) {
      const cols = para.cols || 1;
      const cellW = contentWidth() / cols;
      const segments: { from: number; to: number }[] = [];
      let seg = i;
      for (let k = i; k <= breakAt; k++) {
        if (doc.text[k] === CELL) {
          segments.push({ from: seg, to: k });
          seg = k + 1;
        } else if (k === breakAt) segments.push({ from: seg, to: k });
      }
      const cells: CellBox[] = [];
      const glyphs: Glyph[] = [];
      const rowH = blockHeight(doc, i, breakAt, Math.max(28, lineH));
      segments.slice(0, cols).forEach((part, ci) => {
        const x = ML + ci * cellW;
        cells.push({ x, w: cellW, start: part.from, end: part.to });
        const measured = measureRun(ctx, doc, part.from, part.to);
        let gx = x + 8;
        for (const g of measured) {
          if (g.ch === CELL) continue;
          glyphs.push({ i: g.i, x: gx, w: g.w });
          gx += g.w;
        }
      });
      place(glyphs, true, breakAt + 1, rowH, false, { cols, cells });
      i = breakAt + 1;
      continue;
    }

    const measured = measureRun(ctx, doc, i, breakAt);
    const defaultBefore = lines.length === 0 || lines[lines.length - 1].page !== page ? 0 : SPACE_BEFORE[heading];
    const beforePx = para.sb != null ? ptPx(para.sb) : defaultBefore;
    const beforeLimit = PAGELESS ? Infinity : PAGE_H - MB - reserveFor(page, 0);
    if (beforePx && y + beforePx + lineH <= beforeLimit) y += beforePx;

    const pushLine = (slice: Measured[], hard: boolean, endIndex: number) => {
      const ids = fnOf(slice);
      if (overflow(lineH, ids.length)) bump();
      const at = origin(indent);
      const width = slice.reduce((s, g) => s + g.w, 0);
      let offset = 0;
      const align = para.align || "left";
      if (align === "center") offset = Math.max(0, (at.inner - width) / 2);
      else if (align === "right") offset = Math.max(0, at.inner - width);
      let extra = 0;
      let gaps = 0;
      if (align === "justify" && !hard) {
        for (const g of slice) if (g.ch === " ") gaps++;
        if (gaps > 0 && width < at.inner) extra = (at.inner - width) / gaps;
      }
      let x = at.x + offset;
      const placed: Glyph[] = [];
      for (const g of slice) {
        const w = g.w + (g.ch === " " ? extra : 0);
        placed.push({ i: g.i, x, w });
        x += w;
      }
      lines.push({
        page,
        x: at.x,
        y,
        h: lineH,
        baseline: y + Math.round(sample.size * 1.05),
        start: placed[0]?.i ?? endIndex,
        end: endIndex,
        hard,
        glyphs: placed,
        marker: hard ? marker : undefined,
        markerX: origin(0).x + (para.ind || 0) * 36 + (para.lv || 0) * 18,
        section: hard ? sectionMark() : undefined,
      });
      noteGutter(y, lineH);
      y += lineH;
      takeNotes(ids);
      if (hard && afterPx) y += afterPx;
    };

    if (!measured.length) pushLine([], true, breakAt + 1);
    else {
      let start = 0;
      while (start < measured.length) {
        let width = 0;
        let end = start;
        let lastSpace = -1;
        while (end < measured.length) {
          const w = measured[end].w;
          if (width + w > inner && end > start) break;
          width += w;
          if (measured[end].ch === " ") lastSpace = end;
          end++;
          if (width > inner) break;
        }
        if (end === start) end = start + 1;
        if (end < measured.length && lastSpace > start) end = lastSpace + 1;
        const slice = measured.slice(start, end);
        const hard = end >= measured.length;
        pushLine(slice, hard, hard ? breakAt + 1 : slice[slice.length - 1].i + 1);
        start = end;
      }
    }

    if (hardCh === "\f") breakSection(para.sec);
    i = breakAt + 1;
    if (i >= n) break;
  }

  if (!lines.length) {
    lines.push({
      page: 0,
      x: ML,
      y: MT,
      h: 20,
      baseline: MT + 16,
      start: 0,
      end: doc.text.length,
      hard: true,
      glyphs: [],
      markerX: ML,
    });
  }
  const order: number[] = [];
  for (let k = 0; k < doc.text.length; k++) if (doc.styles[k]?.embed === "fn") order.push(k);
  const placed = new Set(notesOf.flat());
  for (const idx of order) if (!placed.has(idx)) noteList(PAGELESS ? 0 : page).push(idx);
  const num = new Map(order.map((idx, n) => [idx, n + 1]));
  const notes: Footnote[] = [];
  notesOf.forEach((list, p) => {
    for (const index of list) notes.push({ page: p, index, n: num.get(index) || notes.length + 1, text: doc.styles[index]?.label || "Footnote" });
  });
  if (PAGELESS) {
    let bottom = MT;
    for (const line of lines) bottom = Math.max(bottom, line.y + line.h);
    const block = notes.length ? 20 + notes.length * 18 : 0;
    FLOW_H = Math.max(480, Math.ceil(bottom + block + MB + 8));
  } else FLOW_H = PAGE_H;
  return { lines, pages: PAGELESS ? 1 : page + 1, notes, gutters };
}

export function markerHit(layout: Layout, page: number, x: number, y: number): number | null {
  for (const line of layout.lines) {
    if (line.page !== page || !line.marker || !line.hard) continue;
    if (y < line.y || y > line.y + line.h) continue;
    if (x >= line.markerX - 2 && x <= line.markerX + 22) return line.end - 1;
  }
  return null;
}

export function hitTest(doc: Doc, layout: Layout, page: number, x: number, y: number): number {
  const onPage = layout.lines.filter((ln) => ln.page === page);
  if (!onPage.length) return 0;
  let line = onPage[0];
  for (const ln of onPage) if (y >= ln.y - 2) line = ln;
  if (line.table) {
    const cell = line.table.cells.find((c) => x >= c.x && x < c.x + c.w) || line.table.cells[line.table.cells.length - 1];
    if (!cell) return Math.min(line.start, doc.text.length - 1);
    const glyphs = line.glyphs.filter((g) => g.i >= cell.start && g.i < cell.end);
    if (!glyphs.length) return cell.start;
    if (x <= glyphs[0].x) return glyphs[0].i;
    for (const g of glyphs) if (x < g.x + g.w / 2) return g.i;
    return cell.end;
  }
  if (!line.glyphs.length) return Math.min(line.start, doc.text.length - 1);
  if (x <= line.glyphs[0].x) return line.glyphs[0].i;
  for (const g of line.glyphs) if (x < g.x + g.w / 2) return g.i;
  const endGap = line.hard ? line.end - 1 : line.end;
  return Math.max(0, Math.min(endGap, doc.text.length - 1));
}

export function caretBox(layout: Layout, index: number): { page: number; x: number; y: number; h: number } {
  let fallback = { page: 0, x: ML, y: MT, h: 20 };
  for (const line of layout.lines) {
    fallback = { page: line.page, x: line.x, y: line.y, h: line.h };
    if (line.table) {
      for (const cell of line.table.cells) {
        if (index < cell.start || index > cell.end) continue;
        const gs = line.glyphs.filter((g) => g.i >= cell.start && g.i < cell.end);
        if (!gs.length || index === cell.end) {
          const x = gs.length ? gs[gs.length - 1].x + gs[gs.length - 1].w : cell.x + 8;
          return { page: line.page, x, y: line.y, h: line.h };
        }
        for (const g of gs) if (g.i === index) return { page: line.page, x: g.x, y: line.y, h: line.h };
        const last = gs[gs.length - 1];
        return { page: line.page, x: last.x + last.w, y: line.y, h: line.h };
      }
    }
    const owns =
      line.glyphs.some((g) => g.i === index) || (line.hard && index === line.end - 1) || (!line.glyphs.length && index === line.start);
    if (!owns) continue;
    if (!line.glyphs.length) return { page: line.page, x: line.x, y: line.y, h: line.h };
    for (const g of line.glyphs) if (g.i === index) return { page: line.page, x: g.x, y: line.y, h: line.h };
    const last = line.glyphs[line.glyphs.length - 1];
    return { page: line.page, x: last.x + last.w, y: line.y, h: line.h };
  }
  return fallback;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawChip(ctx: CanvasRenderingContext2D, doc: Doc, glyph: Glyph, line: LineBox, colors: Record<string, string>): void {
  const st = doc.styles[glyph.i] || {};
  const y = line.baseline - 14;
  const h = 20;
  ctx.fillStyle = st.embed === "date" ? "#fef7e0" : st.embed === "person" ? "#e8f0fe" : "#f8f9fa";
  ctx.strokeStyle = "#dadce0";
  roundRect(ctx, glyph.x, y, Math.max(20, glyph.w - 2), h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.font = `500 12px "Roboto", sans-serif`;
  ctx.fillStyle = "#202124";
  ctx.textBaseline = "middle";
  if (st.embed === "vote") {
    const votes = Object.entries(voteMap(st));
    ctx.fillText(st.emoji || "👍", glyph.x + 6, y + 10);
    ctx.fillText(String(votes.length), glyph.x + 26, y + 10);
    votes.slice(0, 4).forEach((entry, n) => {
      const [sid, name] = entry;
      const color = colors[sid] || COLLAB_PALETTE[n % COLLAB_PALETTE.length];
      const cx = glyph.x + 44 + n * 16;
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(cx, y + 10, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 8px "Roboto", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText((name[0] || "?").toUpperCase(), cx, y + 10);
      ctx.textAlign = "left";
    });
    return;
  }
  const label = st.embed === "drop" ? (st.val || dropOptions(st)[0] || "Choose") + " ▾" : chipLabel(st);
  ctx.fillText(label, glyph.x + 8, y + 10);
}

function drawImage(ctx: CanvasRenderingContext2D, doc: Doc, glyph: Glyph, line: LineBox): void {
  const st = doc.styles[glyph.i] || {};
  const ext = imageExtent(st, glyph.i);
  const w = Math.min(glyph.w, ext.w);
  const h = Math.min(line.h - 4, ext.h);
  const y = line.y + 2;
  const scale = Math.min(w / Math.max(1, ext.w), h / Math.max(1, ext.h));
  ctx.save();
  ctx.translate(glyph.x + w / 2, y + h / 2);
  ctx.rotate((ext.rot * Math.PI) / 180);
  const dw = ext.rawW * scale;
  const dh = ext.rawH * scale;
  if (!st.src) {
    ctx.restore();
    return;
  }
  const img = loadImage(st.src);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  else {
    ctx.fillStyle = "#f1f3f4";
    ctx.strokeStyle = "#dadce0";
    ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
    ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);
    ctx.fillStyle = "#5f6368";
    ctx.font = `12px "Roboto", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(st.alt || "Image", 0, 0);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

function paintEq(ctx: CanvasRenderingContext2D, node: EqNode, x: number, baseline: number, em: number): void {
  if (node.t === "char") {
    ctx.font = `${em}px Lora, "Times New Roman", serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(node.s || "", x, baseline);
    return;
  }
  if (node.t === "row") {
    let cx = x;
    for (const kid of node.kids || []) {
      paintEq(ctx, kid, cx, baseline, em);
      cx += kid.w * em;
    }
    return;
  }
  if (node.t === "frac") {
    const [num, den] = node.kids || [];
    const w = node.w * em;
    const mid = baseline - em * 0.1;
    if (num) paintEq(ctx, num, x + (w - num.w * em) / 2, mid - num.d * em - 1, em);
    ctx.beginPath();
    ctx.moveTo(x + 1, mid);
    ctx.lineTo(x + w - 1, mid);
    ctx.stroke();
    if (den) paintEq(ctx, den, x + (w - den.w * em) / 2, mid + den.h * em + 2, em);
    return;
  }
  if (node.t === "sqrt") {
    const body = node.kids?.[0];
    const h = ((body ? body.h + body.d : 1) + 0.15) * em;
    ctx.beginPath();
    ctx.moveTo(x, baseline - h * 0.45);
    ctx.lineTo(x + 0.22 * em, baseline + (body?.d || 0.2) * em * 0.2);
    ctx.lineTo(x + 0.48 * em, baseline - h);
    ctx.lineTo(x + node.w * em - 1, baseline - h);
    ctx.stroke();
    if (body) paintEq(ctx, body, x + 0.62 * em, baseline, em);
    return;
  }
  const [base, arg] = node.kids || [];
  if (base) paintEq(ctx, base, x, baseline, em);
  if (arg) {
    const up = node.s !== "sub";
    paintEq(ctx, arg, x + (base?.w || 0) * em, baseline + (up ? -0.45 * em : 0.4 * em), em * 0.7);
  }
}

function drawEquation(ctx: CanvasRenderingContext2D, doc: Doc, glyph: Glyph, line: LineBox): void {
  const node = parseEquation(doc.styles[glyph.i]?.label || "");
  ctx.save();
  ctx.fillStyle = "#202124";
  ctx.strokeStyle = "#202124";
  ctx.lineWidth = 1;
  paintEq(ctx, node, glyph.x + 2, line.baseline, 16);
  ctx.restore();
}

export interface PaintOpts {
  spell?: { start: number; end: number }[];
  invisibles?: boolean;
  suggest?: Record<string, string>;
}

function paintExtras(ctx: CanvasRenderingContext2D, doc: Doc, line: LineBox, opts: PaintOpts | undefined): void {
  if (!opts) return;
  if (opts.invisibles) {
    ctx.fillStyle = "#5b7c99";
    ctx.font = `12px "Roboto", sans-serif`;
    ctx.textBaseline = "alphabetic";
    for (const g of line.glyphs) {
      const ch = doc.text[g.i];
      if (ch === " ") {
        ctx.beginPath();
        ctx.arc(g.x + Math.max(1, g.w / 2), line.baseline - 3, 1.15, 0, Math.PI * 2);
        ctx.fill();
      } else if (ch === "\t") ctx.fillText("→", g.x, line.baseline);
    }
    if (line.hard) {
      const last = line.glyphs[line.glyphs.length - 1];
      const x = last ? last.x + last.w + 2 : line.x;
      ctx.fillText(doc.text[Math.max(0, line.end - 1)] === "\f" ? "↵" : "¶", x, line.baseline);
    }
  }
  if (!opts.spell?.length) return;
  ctx.strokeStyle = "#d32f2f";
  ctx.lineWidth = 0.8;
  for (const span of opts.spell) {
    const gs = line.glyphs.filter((g) => g.i >= span.start && g.i < span.end && /[A-Za-z']/.test(doc.text[g.i] || ""));
    let run: Glyph[] = [];
    const wave = () => {
      if (!run.length) return;
      const x1 = run[0].x;
      const x2 = run[run.length - 1].x + run[run.length - 1].w;
      const y = line.baseline + 3;
      ctx.beginPath();
      let n = 0;
      for (let x = x1; x <= x2; x += 2.5) {
        const yy = y + (n % 2 === 0 ? 0 : 2);
        if (n === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
        n++;
      }
      ctx.stroke();
      run = [];
    };
    for (const g of gs) {
      const prev = run[run.length - 1];
      if (prev && (g.i !== prev.i + 1 || g.x > prev.x + prev.w + 2)) wave();
      run.push(g);
    }
    wave();
  }
}

function markedFace(doc: Doc, index: number, colors?: Record<string, string>): Face {
  const face = fontString(doc, index);
  const st = doc.styles[index];
  if (!st?.del && !st?.sug) return face;
  if (st.del) return { ...face, color: colors?.[st.del] || "#c5221f", strike: true, underline: face.underline || !!st.sug };
  return { ...face, color: colors?.[st.sug || ""] || "#188038", underline: true };
}

function drawFootnoteMark(ctx: CanvasRenderingContext2D, doc: Doc, glyph: Glyph, line: LineBox): void {
  let n = 0;
  for (let i = 0; i <= glyph.i; i++) if (doc.styles[i]?.embed === "fn") n++;
  ctx.font = `600 10px "Open Sans"`;
  ctx.fillStyle = "#1155cc";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(n), glyph.x + 1, line.baseline - 6);
}

function paintMargin(ctx: CanvasRenderingContext2D, page: number, pages: number, kind: "header" | "footer"): void {
  const first = page === 0 && differentFirst;
  const raw = kind === "header" ? (first ? headerFirstText : headerText) : first ? footerFirstText : footerText;
  if (!raw) return;
  ctx.save();
  ctx.font = `11px "Open Sans"`;
  ctx.fillStyle = "#3c4043";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fillPage(raw, page + 1, Math.max(1, pages)), PAGE_W / 2, kind === "header" ? 42 : pageSize().h - 32);
  ctx.restore();
}

function paintNotes(ctx: CanvasRenderingContext2D, layout: Layout, page: number): void {
  const mine = (layout.notes || []).filter((note) => note.page === page);
  if (!mine.length) return;
  let top = PAGE_H - MB - (8 + mine.length * 18);
  if (PAGELESS) {
    let bottom = MT;
    for (const line of layout.lines) if (line.page === page) bottom = Math.max(bottom, line.y + line.h);
    top = bottom + 8;
  }
  ctx.strokeStyle = "#80868b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ML, top);
  ctx.lineTo(ML + 120, top);
  ctx.stroke();
  ctx.font = `11px "Open Sans"`;
  ctx.fillStyle = "#202124";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  mine.forEach((note, i) => ctx.fillText((note.n + ". " + note.text).slice(0, 140), ML, top + 16 + i * 18));
}

export function imageBox(layout: Layout, index: number): { page: number; x: number; y: number; w: number; h: number } | null {
  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (g.i !== index) continue;
      return { page: line.page, x: g.x, y: line.y + 2, w: Math.max(24, g.w), h: Math.max(24, line.h - 6) };
    }
  }
  return null;
}

export function drawPage(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  layout: Layout,
  page: number,
  ranges: { start: number; end: number; color: string }[],
  colors: Record<string, string>,
  opts?: PaintOpts,
): void {
  const box = pageSize();
  ctx.clearRect(0, 0, box.w, box.h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, box.w, box.h);
  ctx.textAlign = "left";
  paintMargin(ctx, page, layout.pages, "header");
  paintMargin(ctx, page, layout.pages, "footer");
  ctx.strokeStyle = "#dadce0";
  ctx.lineWidth = 1;
  for (const gutter of layout.gutters || []) {
    if (gutter.page !== page) continue;
    ctx.beginPath();
    ctx.moveTo(gutter.x, gutter.y0);
    ctx.lineTo(gutter.x, gutter.y1);
    ctx.stroke();
  }

  for (const line of layout.lines) {
    if (line.page !== page) continue;
    if (line.rule) {
      ctx.strokeStyle = "#80868b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ML, line.y + line.h / 2);
      ctx.lineTo(PAGE_W - MR, line.y + line.h / 2);
      ctx.stroke();
      continue;
    }
    if (line.table) {
      ctx.strokeStyle = "#bdbdbd";
      ctx.lineWidth = 1;
      for (const cell of line.table.cells) ctx.strokeRect(cell.x + 0.5, line.y + 0.5, cell.w, line.h);
    }
    for (const range of ranges) {
      const a = Math.min(range.start, range.end);
      const b = Math.max(range.start, range.end);
      if (b <= line.start && !(line.hard && b === line.end - 1)) continue;
      const from = Math.max(a, line.glyphs[0]?.i ?? line.start);
      const to = Math.min(b, line.hard ? line.end - 1 : line.end);
      if (to <= from && !(line.hard && a <= line.end - 1 && b > line.start && !line.glyphs.length)) continue;
      let x1 = line.x;
      let x2 = line.x + 8;
      if (!line.glyphs.length) {
        x1 = line.x;
        x2 = line.x + 6;
      } else {
        x1 = line.glyphs[0].x;
        x2 = line.glyphs[line.glyphs.length - 1].x + line.glyphs[line.glyphs.length - 1].w;
        for (const g of line.glyphs) {
          if (g.i === from) x1 = g.x;
          if (g.i < to) x2 = g.x + g.w;
        }
        if (from >= (line.hard ? line.end - 1 : line.end)) continue;
      }
      if (x2 < x1) continue;
      ctx.fillStyle = range.color;
      ctx.fillRect(x1, line.y + 1, Math.max(2, x2 - x1), line.h - 2);
    }
    if (line.marker === "check" || line.marker === "checked") {
      const s = 12;
      const x = line.markerX;
      const boxY = line.baseline - 11;
      ctx.strokeStyle = "#202124";
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x + 0.5, boxY + 0.5, s, s);
      if (line.marker === "checked") {
        ctx.beginPath();
        ctx.moveTo(x + 2, boxY + 6);
        ctx.lineTo(x + 5, boxY + 10);
        ctx.lineTo(x + 11, boxY + 3);
        ctx.stroke();
      }
    } else if (line.marker) {
      ctx.font = `400 ${Math.max(12, Math.round(line.h * 0.55))}px "Open Sans"`;
      ctx.fillStyle = "#202124";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(line.marker, line.markerX, line.baseline);
    }
    const glyphs = line.glyphs;
    const clipCells = line.table?.cells;
    if (clipCells?.length) {
      ctx.save();
      ctx.beginPath();
      for (const cell of clipCells) ctx.rect(cell.x + 3, line.y + 2, Math.max(0, cell.w - 6), Math.max(0, line.h - 4));
      ctx.clip();
    }
    let runStart = 0;
    while (runStart < glyphs.length) {
      const index = glyphs[runStart].i;
      const ch = doc.text[index];
      if (ch === EMBED) {
        const st = doc.styles[index];
        if (st?.embed === "img") drawImage(ctx, doc, glyphs[runStart], line);
        else if (st?.embed === "fn") drawFootnoteMark(ctx, doc, glyphs[runStart], line);
        else if (st?.embed === "eq") drawEquation(ctx, doc, glyphs[runStart], line);
        else drawChip(ctx, doc, glyphs[runStart], line, colors);
        runStart++;
        continue;
      }
      const face = markedFace(doc, index, opts?.suggest);
      let runEnd = runStart + 1;
      while (runEnd < glyphs.length) {
        const next = glyphs[runEnd].i;
        const prevG = glyphs[runEnd - 1];
        if (doc.text[next] === EMBED || doc.text[next] === CELL) break;
        if (glyphs[runEnd].x > prevG.x + prevG.w + 1) break;
        const other = markedFace(doc, next, opts?.suggest);
        if (other.css !== face.css || other.color !== face.color || other.strike !== face.strike || other.hl !== face.hl || other.underline !== face.underline || other.script !== face.script) break;
        runEnd++;
      }
      if (face.hl) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = face.hl;
        const last = glyphs[runEnd - 1];
        ctx.fillRect(glyphs[runStart].x, line.baseline - face.size, last.x + last.w - glyphs[runStart].x, face.size + 3);
        ctx.restore();
      }
      ctx.font = face.css;
      ctx.fillStyle = face.color;
      ctx.textBaseline = "alphabetic";
      let baseline = line.baseline;
      if (face.script === "sup") baseline -= face.size * 0.55;
      if (face.script === "sub") baseline += face.size * 0.25;
      const small = glyphs.slice(runStart, runEnd).some((g) => doc.styles[g.i]?.sc);
      if (small) {
        for (let k = runStart; k < runEnd; k++) {
          const g = glyphs[k];
          const ch = doc.text[g.i] === "\t" ? " " : doc.text[g.i];
          if (doc.styles[g.i]?.sc && ch >= "a" && ch <= "z") {
            ctx.font = smallCapCss(face.css, face.size);
            ctx.fillText(ch.toUpperCase(), g.x, baseline);
            ctx.font = face.css;
          } else ctx.fillText(ch, g.x, baseline);
        }
      } else {
        let text = "";
        for (let k = runStart; k < runEnd; k++) text += doc.text[glyphs[k].i] === "\t" ? " " : doc.text[glyphs[k].i];
        ctx.fillText(text, glyphs[runStart].x, baseline);
      }
      const last = glyphs[runEnd - 1];
      const x2 = last.x + last.w;
      if (face.underline) {
        ctx.strokeStyle = face.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(glyphs[runStart].x, baseline + 3);
        ctx.lineTo(x2, baseline + 3);
        ctx.stroke();
      }
      if (face.strike) {
        ctx.strokeStyle = face.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(glyphs[runStart].x, baseline - face.size * 0.28);
        ctx.lineTo(x2, baseline - face.size * 0.28);
        ctx.stroke();
      }
      runStart = runEnd;
    }
    if (clipCells?.length) ctx.restore();
    if (line.section === "cont" || line.section === "next") {
      const y = line.y + line.h + 2;
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = "#1a73e8";
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(PAGE_W - MR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `10px Roboto, sans-serif`;
      ctx.fillStyle = "#1a73e8";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(line.section === "cont" ? "Section break (continuous)" : "Section break (next page)", ML, Math.max(line.y + 10, y - 4));
      ctx.restore();
    }
    paintExtras(ctx, doc, line, opts);
  }
  paintNotes(ctx, layout, page);
}

export { hexAlpha };
