import { type Delta, CELL, EMBED, ROW, chop, isBreak } from "./delta.ts";
import { type Doc, styleEq } from "./doc.ts";
import { styleToAttrs } from "./replace.ts";

export type CaseMode = "lower" | "upper" | "title";

export function transformCase(text: string, mode: CaseMode): string {
  if (mode === "lower") return text.toLowerCase();
  if (mode === "upper") return text.toUpperCase();
  let out = "";
  let cap = true;
  for (const ch of text) {
    if (/[A-Za-z]/.test(ch)) {
      out += cap ? ch.toUpperCase() : ch.toLowerCase();
      cap = false;
    } else {
      out += ch;
      if (/\s/.test(ch)) cap = true;
    }
  }
  return out;
}

function frozen(ch: string): boolean {
  return isBreak(ch) || ch === CELL || ch === EMBED || ch === ROW;
}

/** Rewrites the case of [start, end) and keeps each character's attributes. */
export function caseDelta(doc: Doc, start: number, end: number, mode: CaseMode): Delta | null {
  const max = Math.max(0, doc.text.length - 1);
  const lo = Math.max(0, Math.min(start, end, max));
  const hi = Math.min(max, Math.max(start, end));
  if (hi <= lo) return null;
  const slice = doc.text.slice(lo, hi);
  const next = transformCase(slice, mode);
  if (next === slice) return null;
  const ops: Delta["ops"] = [];
  if (lo > 0) ops.push({ t: "r", n: lo });
  let i = 0;
  while (i < slice.length) {
    if (frozen(slice[i]) || slice[i] === next[i]) {
      let j = i + 1;
      while (j < slice.length && (frozen(slice[j]) || slice[j] === next[j])) j++;
      ops.push({ t: "r", n: j - i });
      i = j;
      continue;
    }
    const style = doc.styles[lo + i];
    let j = i + 1;
    while (j < slice.length && !frozen(slice[j]) && slice[j] !== next[j] && styleEq(style || {}, doc.styles[lo + j] || {})) j++;
    ops.push({ t: "d", n: j - i });
    const attrs = styleToAttrs(style, next[i]);
    const text = next.slice(i, j);
    ops.push(attrs ? { t: "i", s: text, a: attrs } : { t: "i", s: text });
    i = j;
  }
  return chop(ops);
}
