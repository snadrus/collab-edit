// Single-pass rich-text deltas. A delta walks the original document once:
// insert writes new characters, retain copies them (optionally restyling),
// delete skips them. Indices inside the editor are UTF-16 code units.

export type Attrs = Record<string, string | number | boolean | null>;

export type Op =
  | { t: "i"; s: string; a?: Attrs }
  | { t: "d"; n: number }
  | { t: "r"; n: number; a?: Attrs };

export interface Delta {
  ops: Op[];
}

/** Object-replacement character. One atomic embed (chip or image). */
export const EMBED = "\uFFFC";
/** Unit separator between table cells. */
export const CELL = "\u001c";
/** Ends a table row. A break, so paragraph attrs (including `cols`) live on it. */
export const ROW = "\u001e";

export const TEXT_KEYS = ["b", "i", "u", "strike", "sup", "sub", "sc", "font", "size", "color", "hl", "link", "cmt"] as const;
export const EMBED_KEYS = ["embed", "emoji", "label", "iso", "opts", "val", "src", "iw", "ih", "alt", "rot", "cid"] as const;
export const PARA_KEYS = ["h", "align", "list", "lv", "lh", "ind", "hr", "check", "cols", "bm", "sb", "sa", "toc", "sec"] as const;

const TEXT_SET = new Set<string>(TEXT_KEYS);
const EMBED_SET = new Set<string>(EMBED_KEYS);
const PARA_SET = new Set<string>(PARA_KEYS);

export function isBreak(ch: string): boolean {
  return ch === "\n" || ch === "\f" || ch === ROW;
}

/** Which attribute keys a character is allowed to carry. Vote ballots are `v.<sessionId>`. */
export function allowsAttr(ch: string, key: string): boolean {
  if ((key === "sug" || key === "del") && ch !== CELL) return true;
  if (isBreak(ch)) return PARA_SET.has(key);
  if (ch === EMBED) return EMBED_SET.has(key) || key.startsWith("v.");
  if (ch === CELL) return false;
  return TEXT_SET.has(key);
}

export function attrEq(a?: Attrs, b?: Attrs): boolean {
  if (a === b) return true;
  if (!a || !b) return !hasKeys(a) && !hasKeys(b);
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function hasKeys(a?: Attrs): boolean {
  return !!a && Object.keys(a).length > 0;
}

/**
 * Compose attribute patches. `null` clears a key.
 * On a retain, clears must survive (`keepNull`). On an insert, a clear just
 * drops that key from the inserted text.
 */
export function composeAttr(first?: Attrs, second?: Attrs, keepNull = true): Attrs | undefined {
  const out: Attrs = {};
  if (first) {
    for (const k of Object.keys(first)) {
      if (second && Object.prototype.hasOwnProperty.call(second, k)) continue;
      if (keepNull || first[k] != null) out[k] = first[k];
    }
  }
  if (second) {
    for (const k of Object.keys(second)) {
      if (keepNull || second[k] != null) out[k] = second[k];
    }
  }
  return hasKeys(out) ? out : undefined;
}

/** Attributes of `ours` after `applied` has already been applied. */
export function transformAttr(applied: Attrs | undefined, ours: Attrs | undefined, weWin: boolean): Attrs | undefined {
  if (!hasKeys(ours)) return undefined;
  if (weWin || !hasKeys(applied)) return { ...ours! };
  const out: Attrs = {};
  for (const k of Object.keys(ours!)) {
    if (!Object.prototype.hasOwnProperty.call(applied, k)) out[k] = ours![k];
  }
  return hasKeys(out) ? out : undefined;
}

export function pickAttrs(attrs: Attrs | undefined, keys: readonly string[]): Attrs | undefined {
  if (!attrs) return undefined;
  const out: Attrs = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(attrs, k)) out[k] = attrs[k];
  }
  return hasKeys(out) ? out : undefined;
}

class Iter {
  i = 0;
  off = 0;
  ops: Op[];
  constructor(ops: Op[]) {
    this.ops = ops;
  }

  hasNext(): boolean {
    return this.i < this.ops.length;
  }

  type(): "i" | "d" | "r" | "end" {
    if (!this.hasNext()) return "end";
    return this.ops[this.i].t;
  }

  len(): number {
    if (!this.hasNext()) return Infinity;
    const op = this.ops[this.i];
    if (op.t === "i") return op.s.length - this.off;
    return op.n - this.off;
  }

  next(n?: number): Op {
    if (!this.hasNext()) throw new Error("delta iterator exhausted");
    const op = this.ops[this.i];
    const avail = this.len();
    const take = n == null ? avail : Math.min(avail, n);
    if (!(take > 0)) throw new Error("bad delta slice");
    let part: Op;
    if (op.t === "i") {
      part = { t: "i", s: op.s.slice(this.off, this.off + take) };
      if (op.a) part.a = { ...op.a };
    } else if (op.t === "d") {
      part = { t: "d", n: take };
    } else {
      part = { t: "r", n: take };
      if (op.a) part.a = { ...op.a };
    }
    this.off += take;
    const full = op.t === "i" ? op.s.length : op.n;
    if (this.off >= full) {
      this.i++;
      this.off = 0;
    }
    return part;
  }
}

export function chop(ops: Op[]): Delta {
  const out: Op[] = [];
  const push = (op: Op) => {
    if (op.t === "i") {
      if (op.s.length === 0) return;
      const prev = out[out.length - 1];
      if (prev && prev.t === "i" && attrEq(prev.a, op.a)) prev.s += op.s;
      else out.push(op.a ? { t: "i", s: op.s, a: op.a } : { t: "i", s: op.s });
      return;
    }
    if (op.t === "d") {
      if (op.n === 0) return;
      const prev = out[out.length - 1];
      if (prev && prev.t === "d") prev.n += op.n;
      else out.push({ t: "d", n: op.n });
      return;
    }
    if (op.n === 0) return;
    const prev = out[out.length - 1];
    if (prev && prev.t === "r" && attrEq(prev.a, op.a)) prev.n += op.n;
    else out.push(op.a ? { t: "r", n: op.n, a: op.a } : { t: "r", n: op.n });
  };
  for (const op of ops) push(op);
  while (out.length && out[out.length - 1].t === "r" && !out[out.length - 1].a) out.pop();
  return { ops: out };
}

export function isNoop(delta: Delta): boolean {
  return delta.ops.every((op) => op.t === "r" && !op.a);
}

export function compose(a: Delta, b: Delta): Delta {
  const ia = new Iter(a.ops);
  const ib = new Iter(b.ops);
  const out: Op[] = [];
  while (ia.hasNext() || ib.hasNext()) {
    if (ib.hasNext() && ib.type() === "i") {
      out.push(ib.next());
      continue;
    }
    if (ia.hasNext() && ia.type() === "d") {
      out.push(ia.next());
      continue;
    }
    if (!ib.hasNext()) {
      out.push(ia.next());
      continue;
    }
    if (!ia.hasNext()) {
      out.push(ib.next());
      continue;
    }
    const n = Math.min(ia.len(), ib.len());
    const oa = ia.next(n);
    const ob = ib.next(n);
    if (ob.t === "r") {
      const attrs = composeAttr(oa.t === "d" ? undefined : oa.a, ob.a, oa.t === "r");
      if (oa.t === "r") out.push(attrs ? { t: "r", n, a: attrs } : { t: "r", n });
      else if (oa.t === "i") out.push(attrs ? { t: "i", s: oa.s, a: attrs } : { t: "i", s: oa.s });
      else throw new Error("compose: delete under retain");
    } else if (ob.t === "d") {
      if (oa.t === "r") out.push({ t: "d", n });
      else if (oa.t === "i") {
        /* inserted then deleted */
      } else throw new Error("compose: delete under delete");
    } else {
      throw new Error("compose: unexpected insert");
    }
  }
  return chop(out);
}

/**
 * Transform `op` so it applies after `other`.
 * When both insert at the same position, `opWinsTies` puts `op`'s text first.
 * The two sides of a concurrent pair must use opposite tie breaks.
 */
export function transform(op: Delta, other: Delta, opWinsTies: boolean): Delta {
  const otherWins = !opWinsTies;
  const io = new Iter(op.ops);
  const ib = new Iter(other.ops);
  const out: Op[] = [];
  while (io.hasNext()) {
    if (ib.hasNext() && ib.type() === "i" && (otherWins || io.type() !== "i")) {
      const ins = ib.next();
      if (ins.t !== "i") throw new Error("transform insert");
      out.push({ t: "r", n: ins.s.length });
      continue;
    }
    if (io.type() === "i" && (!otherWins || ib.type() !== "i")) {
      out.push(io.next());
      continue;
    }
    if (!ib.hasNext()) {
      out.push(io.next());
      continue;
    }
    const n = Math.min(io.len(), ib.len());
    const oo = io.next(n);
    const ob = ib.next(n);
    if (ob.t === "d") continue;
    if (oo.t === "d") out.push({ t: "d", n });
    else if (oo.t === "r" && ob.t === "r") {
      const attrs = transformAttr(ob.a, oo.a, opWinsTies);
      out.push(attrs ? { t: "r", n, a: attrs } : { t: "r", n });
    } else if (oo.t === "i") {
      out.push(oo);
    } else {
      throw new Error("transform: bad pair " + oo.t + "/" + ob.t);
    }
  }
  return chop(out);
}

/** Map an index in the pre-image to an index in the post-image. */
export function transformPosition(delta: Delta, pos: number, insertAfter: boolean): number {
  let index = 0;
  let out = 0;
  for (const op of delta.ops) {
    if (op.t === "i") {
      if (index < pos || (index === pos && insertAfter)) out += op.s.length;
      else if (index > pos) return out;
      continue;
    }
    if (op.t === "d") {
      if (pos < index) return out + (pos - index);
      if (pos < index + op.n) return out;
      index += op.n;
      continue;
    }
    if (pos < index + op.n) return out + (pos - index);
    index += op.n;
    out += op.n;
  }
  if (pos < index) return out;
  return out + (pos - index);
}

export function allowedAttrSet(ch: string): Set<string> {
  if (isBreak(ch)) return PARA_SET;
  if (ch === EMBED) return EMBED_SET;
  if (ch === CELL) return new Set();
  return TEXT_SET;
}
