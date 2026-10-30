import { type Attrs, type Delta, type Op, compose, isNoop } from "./delta.ts";
import { type Doc, applyDoc, paragraphStyle, splice } from "./doc.ts";
import { isBreak } from "./delta.ts";

const RANK: Record<string, number> = { title: 0, h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

export interface HeadingEntry {
  index: number;
  breakAt: number;
  level: number;
  text: string;
  bm: string;
}

export function bookmarkId(): string {
  return ("b" + Math.random().toString(36).slice(2, 10)).slice(0, 40);
}

export function headingsOf(doc: Doc): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  let start = 0;
  for (let i = 0; i < doc.text.length; i++) {
    if (!isBreak(doc.text[i])) continue;
    const para = paragraphStyle(doc, start);
    const h = para.h || "normal";
    if (h in RANK && !para.toc) {
      const text = doc.text.slice(start, i).replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
      if (text) out.push({ index: start, breakAt: i, level: RANK[h], text, bm: para.bm || "" });
    }
    start = i + 1;
  }
  return out;
}

export function assignBookmarks(doc: Doc, nextId: () => string = bookmarkId): Delta | null {
  const ops: Op[] = [];
  let cursor = 0;
  for (const heading of headingsOf(doc)) {
    if (heading.bm) continue;
    if (heading.breakAt > cursor) ops.push({ t: "r", n: heading.breakAt - cursor });
    ops.push({ t: "r", n: 1, a: { bm: nextId() } });
    cursor = heading.breakAt + 1;
  }
  if (cursor < doc.text.length && ops.length) ops.push({ t: "r", n: doc.text.length - cursor });
  if (!ops.length) return null;
  const delta = { ops };
  return isNoop(delta) ? null : delta;
}

function tocOps(entries: { level: number; text: string; bm: string }[]): Op[] {
  if (!entries.length) {
    return [
      { t: "i", s: "Table of contents" },
      { t: "i", s: "\n", a: { h: "normal", align: "left", toc: true } },
    ];
  }
  const ops: Op[] = [];
  for (const entry of entries) {
    const para: Attrs = { h: "normal", align: "left", toc: true };
    if (entry.level > 1) para.ind = Math.min(8, entry.level - 1);
    ops.push({ t: "i", s: entry.text, a: { link: "#" + entry.bm } });
    ops.push({ t: "i", s: "\n", a: para });
  }
  return ops;
}

function tocRanges(doc: Doc): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  let run: { start: number; end: number } | null = null;
  for (let i = 0; i < doc.text.length; i++) {
    if (!isBreak(doc.text[i])) continue;
    if (paragraphStyle(doc, start).toc) {
      if (!run) run = { start, end: i + 1 };
      else run.end = i + 1;
    } else if (run) {
      ranges.push(run);
      run = null;
    }
    start = i + 1;
  }
  return ranges;
}

export function insertTocDelta(doc: Doc, at: number, nextId?: () => string): Delta {
  const marks = assignBookmarks(doc, nextId);
  const current = marks ? applyDoc(doc, marks) : doc;
  const entries = headingsOf(current).filter((h) => h.bm);
  const piece = splice(at, at, tocOps(entries), current.text.length);
  return marks ? compose(marks, piece) : piece;
}

export function updateTocDelta(doc: Doc, nextId?: () => string): Delta | null {
  const marks = assignBookmarks(doc, nextId);
  let current = marks ? applyDoc(doc, marks) : doc;
  let delta: Delta = marks || { ops: [] };
  const entries = headingsOf(current).filter((h) => h.bm);
  const ranges = tocRanges(current);
  if (!ranges.length) return marks;
  for (let r = ranges.length - 1; r >= 0; r--) {
    const range = ranges[r];
    const piece = splice(range.start, range.end, tocOps(entries), current.text.length);
    current = applyDoc(current, piece);
    delta = compose(delta, piece);
  }
  return isNoop(delta) ? null : delta;
}

export function bookmarkAt(doc: Doc, id: string): number | null {
  for (let i = 0; i < doc.text.length; i++) {
    if (isBreak(doc.text[i]) && doc.styles[i]?.bm === id) {
      let start = i;
      while (start > 0 && !isBreak(doc.text[start - 1])) start--;
      return start;
    }
  }
  return null;
}
