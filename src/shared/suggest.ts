import { type Attrs, type Delta, type Op, chop, isNoop } from "./delta.ts";
import { type Doc } from "./doc.ts";
import { validId } from "./threads.ts";

export interface SuggestionMeta {
  id: string;
  sid: string;
  name: string;
  color: string;
  ts: number;
}

export interface SuggestionSpan {
  id: string;
  kind: "ins" | "del";
  start: number;
  end: number;
  quote: string;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

export function sanitizeSuggestion(input: unknown): SuggestionMeta | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = validId(raw.id);
  const sid = clip(raw.sid, 80);
  if (!id || !sid) return null;
  return {
    id,
    sid,
    name: clip(raw.name, 40) || "Guest",
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color).toLowerCase() : "#1e88e5",
    ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
  };
}

export function suggestionSpans(doc: Doc): SuggestionSpan[] {
  const spans: SuggestionSpan[] = [];
  for (const key of ["sug", "del"] as const) {
    let i = 0;
    while (i < doc.text.length) {
      const id = doc.styles[i]?.[key];
      if (typeof id !== "string" || !id) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < doc.text.length && doc.styles[j]?.[key] === id) j++;
      const quote = doc.text.slice(i, j).replace(/\uFFFC/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      spans.push({ id, kind: key === "sug" ? "ins" : "del", start: i, end: j, quote: quote || (key === "sug" ? "Insertion" : "Deletion") });
      i = j;
    }
  }
  return spans;
}

/** Mark [start, end) deleted, except a caller's own pending insertions, which are removed. */
export function deletionDelta(doc: Doc, start: number, end: number, id: string, own: ReadonlySet<string>): Delta | null {
  const last = Math.max(0, doc.text.length - 1);
  const hi = Math.min(end, last);
  if (!(hi > start) || start < 0) return null;
  const ops: Op[] = [];
  if (start > 0) ops.push({ t: "r", n: start });
  let i = start;
  while (i < hi) {
    const st = doc.styles[i] || {};
    const owned = typeof st.sug === "string" && own.has(st.sug);
    if (owned) {
      let j = i + 1;
      while (j < hi && typeof doc.styles[j]?.sug === "string" && own.has(doc.styles[j]!.sug!)) j++;
      ops.push({ t: "d", n: j - i });
      i = j;
      continue;
    }
    if (st.del) {
      let j = i + 1;
      while (j < hi && doc.styles[j]?.del && !(typeof doc.styles[j]?.sug === "string" && own.has(doc.styles[j]!.sug!))) j++;
      ops.push({ t: "r", n: j - i });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < hi) {
      const other = doc.styles[j] || {};
      if (other.del || (typeof other.sug === "string" && own.has(other.sug))) break;
      j++;
    }
    ops.push({ t: "r", n: j - i, a: { del: id } });
    i = j;
  }
  const delta = chop(ops);
  return isNoop(delta) ? null : delta;
}

function patchFor(st: Doc["styles"][number] | undefined, id: string): Attrs | undefined {
  const attrs: Attrs = {};
  if (st?.sug === id) attrs.sug = null;
  if (st?.del === id) attrs.del = null;
  return Object.keys(attrs).length ? attrs : undefined;
}

/** Accept an insertion by clearing it, or a deletion by removing the characters. */
export function acceptDelta(doc: Doc, id: string): Delta | null {
  return resolveDelta(doc, id, true);
}

/** Reject an insertion by removing it, or a deletion by clearing the mark. */
export function rejectDelta(doc: Doc, id: string): Delta | null {
  return resolveDelta(doc, id, false);
}

function resolveDelta(doc: Doc, id: string, accept: boolean): Delta | null {
  const ops: Op[] = [];
  const last = Math.max(0, doc.text.length - 1);
  let i = 0;
  while (i < doc.text.length) {
    const st = doc.styles[i] || {};
    const remove = (accept ? st.del === id : st.sug === id) && i < last;
    if (remove) {
      let j = i + 1;
      while (j < last && (accept ? doc.styles[j]?.del === id : doc.styles[j]?.sug === id)) j++;
      ops.push({ t: "d", n: j - i });
      i = j;
      continue;
    }
    const attrs = patchFor(st, id);
    if (attrs) {
      let j = i + 1;
      while (j < doc.text.length) {
        const other = doc.styles[j] || {};
        const otherRemove = (accept ? other.del === id : other.sug === id) && j < last;
        if (otherRemove) break;
        const next = patchFor(other, id);
        const keys = new Set([...Object.keys(attrs), ...Object.keys(next || {})]);
        let same = !!next;
        for (const k of keys) if (attrs[k] !== next?.[k]) same = false;
        if (!same) break;
        j++;
      }
      ops.push({ t: "r", n: j - i, a: attrs });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < doc.text.length && doc.styles[j]?.sug !== id && doc.styles[j]?.del !== id) j++;
    if (j === i) j = i + 1;
    ops.push({ t: "r", n: j - i });
    i = j;
  }
  const delta = chop(ops);
  return isNoop(delta) ? null : delta;
}

export function withSuggestion(delta: Delta, id: string): Delta {
  return {
    ops: delta.ops.map((op) => (op.t === "i" ? { ...op, a: { ...(op.a || {}), sug: id } } : op)),
  };
}

export function deltaSets(delta: Delta, key: string, id: string): boolean {
  return delta.ops.some((op) => op.t !== "d" && op.a?.[key] === id);
}
