import { type Delta, type Op, chop } from "./delta.ts";
import { type Doc, paraBounds, styleEq } from "./doc.ts";
import { styleToAttrs } from "./replace.ts";

function sameRun(text: string, styles: Doc["styles"], i: number, j: number): boolean {
  const a = text[i];
  const b = text[j];
  if (a === "\n" || b === "\n" || a === "\f" || b === "\f") return false;
  return styleEq(styles[i] || {}, styles[j] || {});
}

function pushInsert(ops: Op[], text: string, styles: Doc["styles"], from: number): void {
  let i = 0;
  while (i < text.length) {
    let j = i + 1;
    while (j < text.length && sameRun(text, styles, i, j)) j++;
    const attrs = styleToAttrs(styles[i], text[i]);
    ops.push(attrs ? { t: "i", s: text.slice(i, j), a: attrs } : { t: "i", s: text.slice(i, j) });
    i = j;
  }
  void from;
}

/** Move [lo, hi) to `to`, which must sit outside that range. The final newline stays put. */
export function moveSliceDelta(doc: Doc, lo: number, hi: number, to: number): Delta | null {
  const end = doc.text.length - 1;
  const a = Math.max(0, Math.min(lo, end));
  const b = Math.max(a, Math.min(hi, end));
  let dest = Math.max(0, Math.min(to, end));
  if (b <= a) return null;
  if (dest > a && dest < b) return null;
  if (dest === a || dest === b) return null;
  const text = doc.text.slice(a, b);
  const styles = doc.styles.slice(a, b);
  const ops: Op[] = [];
  if (dest < a) {
    if (dest > 0) ops.push({ t: "r", n: dest });
    pushInsert(ops, text, styles, 0);
    if (a - dest > 0) ops.push({ t: "r", n: a - dest });
    ops.push({ t: "d", n: b - a });
  } else {
    if (a > 0) ops.push({ t: "r", n: a });
    ops.push({ t: "d", n: b - a });
    if (dest - b > 0) ops.push({ t: "r", n: dest - b });
    pushInsert(ops, text, styles, 0);
  }
  return chop(ops);
}

export function moveParagraphDelta(doc: Doc, index: number, dir: -1 | 1): Delta | null {
  const cur = paraBounds(doc, Math.max(0, Math.min(index, doc.text.length - 1)));
  if (dir < 0) {
    if (cur.start === 0) return null;
    const prev = paraBounds(doc, cur.start - 1);
    return swapParagraphs(doc, prev.start, prev.end, cur.start, cur.end);
  }
  if (cur.end >= doc.text.length - 1) return null;
  const next = paraBounds(doc, cur.end + 1);
  if (next.start <= cur.end) return null;
  return swapParagraphs(doc, cur.start, cur.end, next.start, next.end);
}

function swapParagraphs(doc: Doc, a0: number, a1: number, b0: number, b1: number): Delta | null {
  const sentinel = b1 === doc.text.length - 1;
  if (!sentinel) return moveSliceDelta(doc, a0, a1 + 1, b1 + 1);
  const bodyA = doc.text.slice(a0, a1);
  const stylesA = doc.styles.slice(a0, a1);
  const breakCh = doc.text[a1];
  const breakStyle = doc.styles[a1];
  const bodyB = doc.text.slice(b0, b1);
  const stylesB = doc.styles.slice(b0, b1);
  const text = bodyB + breakCh + bodyA;
  const styles = [...stylesB, breakStyle, ...stylesA];
  const ops: Op[] = [];
  if (a0 > 0) ops.push({ t: "r", n: a0 });
  ops.push({ t: "d", n: b1 - a0 });
  pushInsert(ops, text, styles, 0);
  return chop(ops);
}
