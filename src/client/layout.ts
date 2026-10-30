import { type Doc, type Heading, chipLabel, dropOptions, paragraphStyle, voteMap } from "../shared/doc.ts";
import { CELL, EMBED, ROW, isBreak } from "../shared/delta.ts";
import { COLLAB_PALETTE, hexAlpha } from "../shared/palette.ts";

import { type PageSpec, normalizePage, DEFAULT_PAGE } from "../shared/page.ts";

export let PAGE_W = DEFAULT_PAGE.w;
export let PAGE_H = DEFAULT_PAGE.h;
export let ML = DEFAULT_PAGE.ml;
export let MR = DEFAULT_PAGE.mr;
export let MT = DEFAULT_PAGE.mt;
export let MB = DEFAULT_PAGE.mb;
let paperName: PageSpec["paper"] = DEFAULT_PAGE.paper;
let orientName: PageSpec["orient"] = DEFAULT_PAGE.orient;
export const PAGE_GAP = 20;
export const RULER_H = 28;

export function contentWidth(): number {
  return PAGE_W - ML - MR;
}

export function currentPage(): PageSpec {
  return { w: PAGE_W, h: PAGE_H, ml: ML, mr: MR, mt: MT, mb: MB, paper: paperName, orient: orientName };
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
  return next;
}

const HEAD_PT: Record<Heading, number> = { title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14, normal: 11 };
const SPACE_BEFORE: Record<Heading, number> = { title: 0, subtitle: 4, h1: 16, h2: 12, h3: 10, normal: 0 };

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
}

export interface Layout {
  lines: LineBox[];
  pages: number;
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

function embedWidth(ctx: CanvasRenderingContext2D, doc: Doc, index: number): number {
  const st = doc.styles[index] || {};
  if (st.embed === "img") return Math.min(contentWidth(), Math.max(48, st.iw || 240));
  ctx.font = `500 12px "Roboto", sans-serif`;
  if (st.embed === "vote") return Math.min(280, 46 + Object.keys(voteMap(st)).length * 18);
  return Math.min(280, ctx.measureText(chipLabel(st) || "Chip").width + 28);
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
      const w = glyph === "\t" ? face.size * 2 : ctx.measureText(glyph).width || face.size * 0.5;
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
    if (st.embed === "img") h = Math.max(h, Math.min(360, st.ih || 160) + 6);
    else if (st.embed) h = Math.max(h, 26);
  }
  return h;
}

export function stackOffset(page: number, y: number): number {
  return RULER_H + page * (PAGE_H + PAGE_GAP) + y;
}

export function layoutDoc(doc: Doc, ctx: CanvasRenderingContext2D): Layout {
  const lines: LineBox[] = [];
  let page = 0;
  let y = MT;
  const n = doc.text.length;
  let i = 0;
  let numberRun = 0;
  let numberLv = -1;
  let guard = 0;

  const newPage = () => {
    page++;
    y = MT;
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
    const indent = (para.ind || 0) * 36 + (para.list ? 26 : 0) + (para.lv || 0) * 18;
    const inner = Math.max(40, contentWidth() - indent);
    const x0 = ML + indent;

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

    const place = (glyphs: Glyph[], hard: boolean, endIndex: number, h: number, rule = false, table?: LineBox["table"]) => {
      if (y + h > PAGE_H - MB && y > MT) newPage();
      lines.push({
        page,
        x: x0,
        y,
        h,
        baseline: y + Math.round(Math.min(h - 4, sample.size * 1.05)),
        start: glyphs[0]?.i ?? endIndex,
        end: endIndex,
        hard,
        glyphs,
        marker: hard ? marker : undefined,
        markerX: ML + (para.ind || 0) * 36 + (para.lv || 0) * 18,
        rule,
        table,
      });
      y += h;
    };

    if (para.hr) {
      place([], true, breakAt + 1, 18, true);
      if (hardCh === "\f") newPage();
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
    const spaceBefore = lines.length === 0 || lines[lines.length - 1].page !== page ? 0 : SPACE_BEFORE[heading];
    if (spaceBefore && y + spaceBefore + lineH <= PAGE_H - MB) y += spaceBefore;

    const pushLine = (slice: Measured[], hard: boolean, endIndex: number) => {
      if (y + lineH > PAGE_H - MB && y > MT) newPage();
      const width = slice.reduce((s, g) => s + g.w, 0);
      let offset = 0;
      const align = para.align || "left";
      if (align === "center") offset = Math.max(0, (inner - width) / 2);
      else if (align === "right") offset = Math.max(0, inner - width);
      let extra = 0;
      let gaps = 0;
      if (align === "justify" && !hard) {
        for (const g of slice) if (g.ch === " ") gaps++;
        if (gaps > 0 && width < inner) extra = (inner - width) / gaps;
      }
      let x = x0 + offset;
      const placed: Glyph[] = [];
      for (const g of slice) {
        const w = g.w + (g.ch === " " ? extra : 0);
        placed.push({ i: g.i, x, w });
        x += w;
      }
      lines.push({
        page,
        x: x0,
        y,
        h: lineH,
        baseline: y + Math.round(sample.size * 1.05),
        start: placed[0]?.i ?? endIndex,
        end: endIndex,
        hard,
        glyphs: placed,
        marker: hard ? marker : undefined,
        markerX: ML + (para.ind || 0) * 36 + (para.lv || 0) * 18,
      });
      y += lineH;
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

    if (hardCh === "\f") newPage();
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
  return { lines, pages: page + 1 };
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
  const w = Math.min(glyph.w, st.iw || 240);
  const h = Math.min(line.h - 4, st.ih || 160);
  const y = line.y + 2;
  if (!st.src) return;
  const img = loadImage(st.src);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, glyph.x, y, w, h);
  else {
    ctx.fillStyle = "#f1f3f4";
    ctx.strokeStyle = "#dadce0";
    ctx.fillRect(glyph.x, y, w, h);
    ctx.strokeRect(glyph.x, y, w, h);
    ctx.fillStyle = "#5f6368";
    ctx.font = `12px "Roboto", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(st.alt || "Image", glyph.x + 8, y + h / 2);
  }
}

export interface PaintOpts {
  spell?: { start: number; end: number }[];
  invisibles?: boolean;
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

export function drawPage(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  layout: Layout,
  page: number,
  ranges: { start: number; end: number; color: string }[],
  colors: Record<string, string>,
  opts?: PaintOpts,
): void {
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.textAlign = "left";

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
        else drawChip(ctx, doc, glyphs[runStart], line, colors);
        runStart++;
        continue;
      }
      const face = fontString(doc, index);
      let runEnd = runStart + 1;
      while (runEnd < glyphs.length) {
        const next = glyphs[runEnd].i;
        const prevG = glyphs[runEnd - 1];
        if (doc.text[next] === EMBED || doc.text[next] === CELL) break;
        if (glyphs[runEnd].x > prevG.x + prevG.w + 1) break;
        const other = fontString(doc, next);
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
      let text = "";
      for (let k = runStart; k < runEnd; k++) text += doc.text[glyphs[k].i] === "\t" ? " " : doc.text[glyphs[k].i];
      ctx.fillText(text, glyphs[runStart].x, baseline);
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
    paintExtras(ctx, doc, line, opts);
  }
}

export { hexAlpha };
