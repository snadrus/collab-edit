import { type Attrs, type Delta, CELL, EMBED, allowsAttr, chop, isBreak } from "./delta.ts";
import { type CharStyle, type Doc, styleEq } from "./doc.ts";

function sameClass(a: string, b: string): boolean {
  if (isBreak(a) || isBreak(b)) return isBreak(a) && isBreak(b);
  if (a === EMBED || b === EMBED) return a === EMBED && b === EMBED;
  if (a === CELL || b === CELL) return a === CELL && b === CELL;
  return true;
}

export function styleToAttrs(style: CharStyle | undefined, ch: string): Attrs | undefined {
  if (!style) return undefined;
  const attrs: Attrs = {};
  for (const k of Object.keys(style)) {
    if (!allowsAttr(ch, k)) continue;
    const v = (style as Record<string, unknown>)[k];
    if (typeof v === "string" || typeof v === "number" || v === true) attrs[k] = v;
  }
  return Object.keys(attrs).length ? attrs : undefined;
}

function stylePatch(from: CharStyle | undefined, to: CharStyle | undefined, ch: string): Attrs | undefined {
  const keys = new Set([...Object.keys(from || {}), ...Object.keys(to || {})]);
  const attrs: Attrs = {};
  let any = false;
  for (const k of keys) {
    if (!allowsAttr(ch, k)) continue;
    const a = (from as Record<string, unknown> | undefined)?.[k];
    const b = (to as Record<string, unknown> | undefined)?.[k];
    if (a === b) continue;
    any = true;
    attrs[k] = b == null || b === false ? null : (b as string | number | boolean);
  }
  return any ? attrs : undefined;
}

/** Delta that turns `current` into `target`, keeping the sentinel newline so undo can invert it. */
export function replaceDelta(current: Doc, target: Doc): Delta {
  if (!current.text.endsWith("\n") || !target.text.endsWith("\n")) throw new Error("sentinel");
  const ops: Delta["ops"] = [];
  const del = current.text.length - 1;
  if (del > 0) ops.push({ t: "d", n: del });
  const body = target.text.slice(0, -1);
  const styles = target.styles.slice(0, -1);
  let i = 0;
  while (i < body.length) {
    let j = i + 1;
    while (j < body.length && styleEq(styles[i] || {}, styles[j] || {}) && sameClass(body[i], body[j])) j++;
    const attrs = styleToAttrs(styles[i], body[i]);
    ops.push(attrs ? { t: "i", s: body.slice(i, j), a: attrs } : { t: "i", s: body.slice(i, j) });
    i = j;
  }
  const patch = stylePatch(current.styles[del], target.styles[target.text.length - 1], "\n");
  if (patch) ops.push({ t: "r", n: 1, a: patch });
  return chop(ops);
}

/** Ranges of `after` that were inserted relative to `before`. */
export function insertedRanges(before: string, after: string): { start: number; end: number }[] {
  const n = before.length;
  const m = after.length;
  let p = 0;
  while (p < n && p < m && before[p] === after[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && before[n - 1 - s] === after[m - 1 - s]) s++;
  const aa = before.slice(p, n - s);
  const bb = after.slice(p, m - s);
  if (!bb) return [];
  if (!aa) return [{ start: p, end: p + bb.length }];
  if (aa.length * bb.length > 1_500_000) return [{ start: p, end: m - s }];
  const cols = bb.length + 1;
  const dp = new Uint32Array((aa.length + 1) * cols);
  const at = (i: number, j: number) => i * cols + j;
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      dp[at(i, j)] = aa[i - 1] === bb[j - 1] ? dp[at(i - 1, j - 1)] + 1 : Math.max(dp[at(i - 1, j)], dp[at(i, j - 1)]);
    }
  }
  const ranges: { start: number; end: number }[] = [];
  let i = aa.length;
  let j = bb.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aa[i - 1] === bb[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[at(i, j - 1)] >= dp[at(i - 1, j)])) {
      const idx = p + j - 1;
      const last = ranges[ranges.length - 1];
      if (last && last.start === idx + 1) last.start = idx;
      else ranges.push({ start: idx, end: idx + 1 });
      j--;
    } else i--;
  }
  ranges.reverse();
  return ranges;
}
