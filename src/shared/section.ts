import { type Delta, ROW, chop, isBreak } from "./delta.ts";
import { type Doc, paraBounds, paragraphStyle, splice } from "./doc.ts";

export type SectionKind = "cont" | "next";

export function textColumns(style: { cols?: number } | undefined): 1 | 2 | 3 {
  return style?.cols === 2 || style?.cols === 3 ? style.cols : 1;
}

/** Range of the section containing `index`, including its closing break when there is one. */
export function sectionSpan(doc: Doc, index: number): { start: number; end: number } {
  const i = Math.max(0, Math.min(index, Math.max(0, doc.text.length - 1)));
  let start = 0;
  for (let k = i - 1; k >= 0; k--) {
    const sec = doc.styles[k]?.sec;
    if (doc.text[k] === "\f" && (sec === "cont" || sec === "next")) {
      start = k + 1;
      break;
    }
  }
  let end = doc.text.length - 1;
  for (let k = Math.max(start, i); k < doc.text.length; k++) {
    const sec = doc.styles[k]?.sec;
    if (doc.text[k] === "\f" && (sec === "cont" || sec === "next")) {
      end = k;
      break;
    }
  }
  return { start, end };
}

/** Sets the column count on paragraph and section breaks. Table rows keep their own `cols`. */
export function setColumnsDelta(doc: Doc, index: number, cols: 1 | 2 | 3): Delta {
  const span = sectionSpan(doc, index);
  const ops: Delta["ops"] = [];
  let cursor = 0;
  for (let k = span.start; k <= span.end; k++) {
    const ch = doc.text[k];
    if (!isBreak(ch) || ch === ROW) continue;
    const current = doc.styles[k]?.cols;
    const next = cols === 1 ? null : cols;
    if (current === next || (next == null && (current == null || current === 1))) continue;
    if (k > cursor) ops.push({ t: "r", n: k - cursor });
    ops.push({ t: "r", n: 1, a: { cols: next } });
    cursor = k + 1;
  }
  return chop(ops);
}

export function insertSectionDelta(doc: Doc, index: number, kind: SectionKind): Delta {
  const para = paragraphStyle(doc, index);
  const at = paraBounds(doc, index).end;
  const cols = textColumns(para);
  const attrs: Record<string, string | number | boolean | null> = {
    h: para.h || "normal",
    align: para.align || "left",
    sec: kind,
  };
  if (para.list) attrs.list = para.list;
  if (para.lh) attrs.lh = para.lh;
  if (cols > 1) attrs.cols = cols;
  return splice(at, at, [{ t: "i", s: "\f", a: attrs }], doc.text.length);
}
