import {
  type Attrs,
  type Delta,
  type Op,
  allowsAttr,
  chop,
  isBreak,
  isNoop,
} from "./delta.ts";
import { citeChip } from "./tools.ts";

export type Heading = "normal" | "title" | "subtitle" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type Align = "left" | "center" | "right" | "justify";
export type ListKind = "bullet" | "numbered" | "check";
export type EmbedKind = "vote" | "person" | "date" | "drop" | "img" | "fn" | "eq" | "chart" | "draw" | "cite" | "sig";

export interface CharStyle {
  b?: true;
  i?: true;
  u?: true;
  strike?: true;
  sup?: true;
  sub?: true;
  font?: string;
  size?: number;
  color?: string;
  hl?: string;
  link?: string;
  /** Comment thread id anchored to this character. */
  cmt?: string;
  /** Small caps. Lowercase letters draw as smaller capitals. */
  sc?: true;
  /** Suggestion id for an insertion that is still pending. */
  sug?: string;
  /** Suggestion id for a deletion that is still pending. */
  del?: string;
  embed?: EmbedKind;
  emoji?: string;
  label?: string;
  iso?: string;
  opts?: string;
  val?: string;
  src?: string;
  iw?: number;
  ih?: number;
  alt?: string;
  /** Image rotation in degrees. */
  rot?: number;
  /** Wallet address of a person chip (FiPerson id). */
  addr?: string;
  /** PieceCID of the unsigned document this signature commits to. */
  cid?: string;
  h?: Heading;
  align?: Align;
  list?: ListKind;
  lv?: number;
  /** Line-spacing multiple. Absent means 1.15. */
  lh?: number;
  ind?: number;
  hr?: true;
  check?: true;
  /** Column count. Meaningful on a table-row break. */
  cols?: number;
  /** Bookmark id on a paragraph break. */
  bm?: string;
  /** Space before, in points. Absent uses the heading default. */
  sb?: number;
  /** Space after, in points. Absent means none. */
  sa?: number;
  /** Paragraph was generated as a table-of-contents line. */
  toc?: true;
  /** Section break on a form-feed. `cont` stays on the page; `next` starts a page. */
  sec?: "cont" | "next";
}

export interface Doc {
  text: string;
  styles: CharStyle[];
}

export interface Snapshot {
  text: string;
  runs: { n: number; s: CharStyle }[];
}

export function emptyDoc(): Doc {
  return { text: "\n", styles: [{ h: "normal", align: "left" }] };
}

export function styleEq(a: CharStyle, b: CharStyle): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function docEqual(a: Doc, b: Doc): boolean {
  if (a.text !== b.text || a.styles.length !== b.styles.length) return false;
  for (let i = 0; i < a.styles.length; i++) if (!styleEq(a.styles[i], b.styles[i])) return false;
  return true;
}

export function applyAttrs(style: CharStyle, attrs: Attrs | undefined, ch: string): CharStyle {
  if (!attrs) return style;
  let next: CharStyle | null = null;
  for (const k of Object.keys(attrs)) {
    if (!allowsAttr(ch, k)) continue;
    if (!next) next = { ...style };
    const v = attrs[k];
    if (v == null || v === false) delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v === true ? true : v;
  }
  return next ?? style;
}

export function applyDoc(doc: Doc, delta: Delta): Doc {
  if (isNoop(delta)) return doc;
  const chars: string[] = [];
  const styles: CharStyle[] = [];
  let index = 0;
  for (const op of delta.ops) {
    if (op.t === "r") {
      if (index + op.n > doc.text.length) throw new Error("retain past end");
      for (let k = 0; k < op.n; k++) {
        const ch = doc.text[index];
        chars.push(ch);
        styles.push(op.a ? applyAttrs(doc.styles[index], op.a, ch) : doc.styles[index]);
        index++;
      }
    } else if (op.t === "d") {
      if (index + op.n > doc.text.length) throw new Error("delete past end");
      index += op.n;
    } else {
      for (let k = 0; k < op.s.length; k++) {
        const ch = op.s[k];
        chars.push(ch);
        styles.push(applyAttrs({}, op.a, ch));
      }
    }
  }
  if (index > doc.text.length) throw new Error("delta walked past end");
  while (index < doc.text.length) {
    chars.push(doc.text[index]);
    styles.push(doc.styles[index]);
    index++;
  }
  return { text: chars.join(""), styles };
}

function styleAttrs(style: CharStyle, ch: string): Attrs | undefined {
  const out: Attrs = {};
  for (const k of Object.keys(style)) {
    if (!allowsAttr(ch, k)) continue;
    const v = (style as Record<string, unknown>)[k];
    if (typeof v === "string" || typeof v === "number" || v === true) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function inverseAttrs(style: CharStyle, attrs: Attrs, ch: string): Attrs | undefined {
  const out: Attrs = {};
  let any = false;
  for (const k of Object.keys(attrs)) {
    if (!allowsAttr(ch, k)) continue;
    any = true;
    const old = (style as Record<string, unknown>)[k];
    out[k] = old == null ? null : (old as string | number | boolean);
  }
  return any ? out : undefined;
}

function pushRetain(out: Op[], n: number, attrs?: Attrs) {
  if (n <= 0) return;
  out.push(attrs ? { t: "r", n, a: attrs } : { t: "r", n });
}

/** Inverse of `change`, applicable to the document produced by `change`. */
export function invert(change: Delta, before: Doc): Delta {
  const out: Op[] = [];
  let idx = 0;
  for (const op of change.ops) {
    if (op.t === "i") {
      out.push({ t: "d", n: op.s.length });
    } else if (op.t === "d") {
      let runAttrs: Attrs | undefined;
      let runText = "";
      const flush = () => {
        if (!runText) return;
        out.push(runAttrs ? { t: "i", s: runText, a: runAttrs } : { t: "i", s: runText });
        runText = "";
      };
      for (let k = 0; k < op.n; k++) {
        const ch = before.text[idx + k];
        const attrs = styleAttrs(before.styles[idx + k], ch);
        if (k === 0) {
          runAttrs = attrs;
          runText = ch;
        } else if (!attrsEqual(runAttrs, attrs)) {
          flush();
          runAttrs = attrs;
          runText = ch;
        } else {
          runText += ch;
        }
      }
      flush();
      idx += op.n;
    } else if (op.a) {
      let runStart = 0;
      let runAttr = inverseAttrs(before.styles[idx], op.a, before.text[idx]);
      for (let k = 1; k < op.n; k++) {
        const inv = inverseAttrs(before.styles[idx + k], op.a, before.text[idx + k]);
        if (!attrsEqual(runAttr, inv)) {
          pushRetain(out, k - runStart, runAttr);
          runStart = k;
          runAttr = inv;
        }
      }
      pushRetain(out, op.n - runStart, runAttr);
      idx += op.n;
    } else {
      out.push({ t: "r", n: op.n });
      idx += op.n;
    }
  }
  return chop(out);
}

function attrsEqual(a?: Attrs, b?: Attrs): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function snapshotDoc(doc: Doc): Snapshot {
  const runs: { n: number; s: CharStyle }[] = [];
  let i = 0;
  while (i < doc.text.length) {
    let j = i + 1;
    while (j < doc.text.length && styleEq(doc.styles[i], doc.styles[j])) j++;
    runs.push({ n: j - i, s: doc.styles[i] });
    i = j;
  }
  return { text: doc.text, runs };
}

export function restoreDoc(snap: Snapshot): Doc {
  const styles: CharStyle[] = [];
  for (const run of snap.runs) {
    for (let k = 0; k < run.n; k++) styles.push(run.s);
  }
  if (styles.length !== snap.text.length) throw new Error("snapshot length mismatch");
  return { text: snap.text, styles };
}

export function paraBounds(doc: Doc, index: number): { start: number; end: number } {
  const n = doc.text.length;
  const i = Math.max(0, Math.min(index, n - 1));
  let start = i;
  while (start > 0 && !isBreak(doc.text[start - 1])) start--;
  let end = i;
  while (end < n && !isBreak(doc.text[end])) end++;
  if (end >= n) end = n - 1;
  return { start, end };
}

export function paragraphStyle(doc: Doc, index: number): CharStyle {
  const { end } = paraBounds(doc, index);
  return doc.styles[end] ?? {};
}

/** Build a delta that deletes [start, end) and inserts `inserts` there. End is clamped before the sentinel newline. */
export function splice(start: number, end: number, inserts: Op[], docLength: number): Delta {
  const max = Math.max(0, docLength - 1);
  let s = Math.max(0, Math.min(start, end));
  let e = Math.max(s, Math.min(Math.max(start, end), max));
  s = Math.min(s, e);
  const ops: Op[] = [];
  if (s > 0) ops.push({ t: "r", n: s });
  if (e > s) ops.push({ t: "d", n: e - s });
  for (const op of inserts) ops.push(op);
  return chop(ops);
}

export function insertedLength(ops: Op[]): number {
  let n = 0;
  for (const op of ops) if (op.t === "i") n += op.s.length;
  return n;
}

export function plainText(doc: Doc): string {
  return doc.text.endsWith("\n") ? doc.text.slice(0, -1) : doc.text;
}

/** Ballot map stored as `v.<sessionId>` on a voting chip. Keys do not collide across sessions. */
export function voteMap(style: CharStyle | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith("v.") && typeof v === "string" && v) out[k.slice(2)] = v;
  }
  return out;
}

export function dropOptions(style: CharStyle | undefined): string[] {
  if (!style?.opts) return [];
  try {
    const v = JSON.parse(style.opts) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.slice(0, 20);
  } catch {
    /* ignore bad opts */
  }
  return [];
}

export function docIsSigned(doc: Doc): boolean {
  for (let i = 0; i < doc.text.length; i++) {
    if (doc.text[i] === "\uFFFC" && doc.styles[i]?.embed === "sig") return true;
  }
  return false;
}

export function chipLabel(style: CharStyle | undefined): string {
  if (!style) return "";
  if (style.embed === "vote") return `${style.emoji || "👍"} ${Object.keys(voteMap(style)).length}`;
  if (style.embed === "person") return style.label || "Person";
  if (style.embed === "date") return style.iso || "Date";
  if (style.embed === "drop") return style.val || "Choose";
  if (style.embed === "img") return style.alt || "Image";
  if (style.embed === "fn") return style.label || "Footnote";
  if (style.embed === "eq") return style.label || "Equation";
  if (style.embed === "chart") return "Chart";
  if (style.embed === "draw") return "Drawing";
  if (style.embed === "cite") return citeChip(style.label || "");
  if (style.embed === "sig") {
    const short = style.alt ? style.alt.slice(0, 6) + "…" : "";
    return `${style.label || "Signed"}${short ? " " + short : ""}`;
  }
  return "";
}

export function markedText(doc: Doc, id: string): string {
  let out = "";
  for (let i = 0; i < doc.text.length; i++) if (doc.styles[i]?.cmt === id) out += doc.text[i];
  return out;
}
