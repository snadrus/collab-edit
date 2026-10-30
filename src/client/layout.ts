import { type Doc, type Heading, paragraphStyle } from "../shared/doc.ts";
import { isBreak } from "../shared/delta.ts";

export const PAGE_W = 816;
export const PAGE_H = 1056;
export const MARGIN = 96;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const PAGE_GAP = 20;
export const RULER_H = 28;

const HEAD_PT: Record<Heading, number> = { title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14, normal: 11 };
const SPACE_BEFORE: Record<Heading, number> = { title: 0, subtitle: 4, h1: 16, h2: 12, h3: 10, normal: 0 };

export interface Glyph {
  i: number;
  x: number;
  w: number;
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

export function fontString(doc: Doc, index: number): { css: string; size: number; color: string; underline: boolean } {
  const st = doc.styles[index] || {};
  const para = paragraphStyle(doc, index);
  const size = ptPx(st.size || HEAD_PT[headingOf(doc, index)]);
  const family = st.font || "Open Sans";
  const weight = st.b ? 700 : 400;
  const style = st.i ? "italic" : "normal";
  const color = st.color || (para.h === "subtitle" ? "#666666" : "#202124");
  return { css: `${style} ${weight} ${size}px "${family}"`, size, color, underline: !!st.u };
}

interface Measured {
  i: number;
  ch: string;
  w: number;
}

function measureRun(ctx: CanvasRenderingContext2D, doc: Doc, from: number, to: number): Measured[] {
  const out: Measured[] = [];
  let pos = from;
  while (pos < to) {
    const face = fontString(doc, pos);
    let j = pos + 1;
    while (j < to && fontString(doc, j).css === face.css) j++;
    ctx.font = face.css;
    for (let k = pos; k < j; k++) {
      const ch = doc.text[k];
      const w = ch === "\t" ? face.size * 2 : ctx.measureText(ch).width || face.size * 0.5;
      out.push({ i: k, ch, w });
    }
    pos = j;
  }
  return out;
}

export function layoutDoc(doc: Doc, ctx: CanvasRenderingContext2D): Layout {
  const lines: LineBox[] = [];
  let page = 0;
  let y = MARGIN;
  const n = doc.text.length;
  let i = 0;
  let numberRun = 0;
  let guard = 0;

  const newPage = () => {
    page++;
    y = MARGIN;
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
    const measured = measureRun(ctx, doc, i, breakAt);
    const sample = fontString(doc, measured[0]?.i ?? breakAt);
    const lineH = Math.max(18, Math.round(sample.size * 1.35));
    const lv = para.lv || 0;
    const indent = (para.list ? 28 : 0) + lv * 18;
    const inner = Math.max(40, CONTENT_W - indent);
    const x0 = MARGIN + indent;
    let marker: string | undefined;
    if (para.list === "bullet") marker = "•";
    else if (para.list === "numbered") {
      numberRun += 1;
      marker = numberRun + ".";
    } else numberRun = 0;

    const spaceBefore = lines.length === 0 || lines[lines.length - 1].page !== page ? 0 : SPACE_BEFORE[heading];
    if (spaceBefore && y + spaceBefore + lineH <= PAGE_H - MARGIN) y += spaceBefore;

    const pushLine = (glyphs: Measured[], hard: boolean, endIndex: number) => {
      if (y + lineH > PAGE_H - MARGIN && y > MARGIN) {
        newPage();
      }
      const width = glyphs.reduce((s, g) => s + g.w, 0);
      let offset = 0;
      const align = para.align || "left";
      if (align === "center") offset = Math.max(0, (inner - width) / 2);
      else if (align === "right") offset = Math.max(0, inner - width);
      let extra = 0;
      let gaps = 0;
      if (align === "justify" && !hard) {
        for (const g of glyphs) if (g.ch === " ") gaps++;
        if (gaps > 0 && width < inner) extra = (inner - width) / gaps;
      }
      let x = x0 + offset;
      const placed: Glyph[] = [];
      for (const g of glyphs) {
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
        start: glyphs[0]?.i ?? endIndex,
        end: endIndex,
        hard,
        glyphs: placed,
        marker: hard ? marker : lines.some((ln) => ln.hard === false && ln.end > (glyphs[0]?.i ?? endIndex) && ln.page === page) ? undefined : undefined,
        markerX: MARGIN + lv * 18,
      });
      const line = lines[lines.length - 1];
      if (!hard) line.marker = undefined;
      else line.marker = marker;
      y += lineH;
    };

    if (!measured.length) {
      pushLine([], true, breakAt + 1);
    } else {
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
        while (start < measured.length && measured[start].ch === " " && start > 0 && !hard) {
          // keep leading space on the next line; wrapping already consumed the break space
          break;
        }
      }
    }

    if (hardCh === "\f") newPage();
    i = breakAt + 1;
    if (i >= n) break;
  }

  if (!lines.length) {
    lines.push({
      page: 0,
      x: MARGIN,
      y: MARGIN,
      h: 20,
      baseline: MARGIN + 16,
      start: 0,
      end: doc.text.length,
      hard: true,
      glyphs: [],
      markerX: MARGIN,
    });
  }
  return { lines, pages: page + 1 };
}

export function hitTest(doc: Doc, layout: Layout, page: number, x: number, y: number): number {
  const onPage = layout.lines.filter((ln) => ln.page === page);
  if (!onPage.length) return 0;
  let line = onPage[0];
  for (const ln of onPage) {
    if (y >= ln.y - 2) line = ln;
  }
  if (!line.glyphs.length) return Math.min(line.start, doc.text.length - 1);
  if (x <= line.glyphs[0].x) return line.glyphs[0].i;
  for (const g of line.glyphs) {
    if (x < g.x + g.w / 2) return g.i;
  }
  const endGap = line.hard ? line.end - 1 : line.end;
  return Math.max(0, Math.min(endGap, doc.text.length - 1));
}

export function caretBox(layout: Layout, index: number): { page: number; x: number; y: number; h: number } {
  let fallback = { page: 0, x: MARGIN, y: MARGIN, h: 20 };
  for (const line of layout.lines) {
    fallback = { page: line.page, x: line.x, y: line.y, h: line.h };
    const owns =
      line.glyphs.some((g) => g.i === index) || (line.hard && index === line.end - 1) || (!line.glyphs.length && index === line.start);
    if (!owns) continue;
    if (!line.glyphs.length) return { page: line.page, x: line.x, y: line.y, h: line.h };
    for (const g of line.glyphs) {
      if (g.i === index) return { page: line.page, x: g.x, y: line.y, h: line.h };
    }
    const last = line.glyphs[line.glyphs.length - 1];
    return { page: line.page, x: last.x + last.w, y: line.y, h: line.h };
  }
  return fallback;
}

export function drawPage(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  layout: Layout,
  page: number,
  ranges: { start: number; end: number; color: string }[],
): void {
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  for (const line of layout.lines) {
    if (line.page !== page) continue;
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
    if (line.marker) {
      ctx.font = `400 ${Math.max(12, Math.round(line.h * 0.55))}px "Open Sans"`;
      ctx.fillStyle = "#202124";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(line.marker, line.markerX, line.baseline);
    }
    let runStart = 0;
    const glyphs = line.glyphs;
    while (runStart < glyphs.length) {
      const face = fontString(doc, glyphs[runStart].i);
      let runEnd = runStart + 1;
      while (runEnd < glyphs.length && fontString(doc, glyphs[runEnd].i).css === face.css && fontString(doc, glyphs[runEnd].i).color === face.color) runEnd++;
      ctx.font = face.css;
      ctx.fillStyle = face.color;
      ctx.textBaseline = "alphabetic";
      let text = "";
      for (let k = runStart; k < runEnd; k++) text += doc.text[glyphs[k].i];
      ctx.fillText(text, glyphs[runStart].x, line.baseline);
      if (face.underline) {
        const last = glyphs[runEnd - 1];
        const x2 = last.x + last.w;
        ctx.strokeStyle = face.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(glyphs[runStart].x, line.baseline + 3);
        ctx.lineTo(x2, line.baseline + 3);
        ctx.stroke();
      }
      runStart = runEnd;
    }
  }
}
