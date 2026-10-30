import { type Attrs, type Delta, type Op, PARA_KEYS, TEXT_KEYS, chop, compose, pickAttrs } from "./delta.ts";

export type StyleMap = Record<string, { op: "set"; opValue: string | number | boolean | null }>;

export type Command =
  | { ty: "is"; ibi: number; s: string }
  | { ty: "ds"; si: number; ei: number }
  | { ty: "as"; st: "text" | "paragraph" | "list"; si: number; ei: number; sm: StyleMap }
  | { ty: "mlti"; mts: Command[] }
  | { ty: "null" };

const LIST_KEYS = ["list", "lv"] as const;
const HEAD_KEYS = ["h", "align"] as const;

function toSm(attrs: Attrs): StyleMap {
  const sm: StyleMap = {};
  for (const k of Object.keys(attrs)) sm[k] = { op: "set", opValue: attrs[k] };
  return sm;
}

function fromSm(sm: StyleMap): Attrs {
  const attrs: Attrs = {};
  for (const k of Object.keys(sm)) {
    const entry = sm[k];
    if (!entry || entry.op !== "set") continue;
    attrs[k] = entry.opValue;
  }
  return attrs;
}

function flatten(cmds: Command[]): Command[] {
  const out: Command[] = [];
  for (const c of cmds) {
    if (c.ty === "mlti") out.push(...flatten(c.mts));
    else if (c.ty !== "null") out.push(c);
  }
  return out;
}

function commandToDelta(c: Command): Delta {
  if (c.ty === "is") {
    if (!(c.ibi >= 1) || typeof c.s !== "string") throw new Error("bad insert");
    const at = c.ibi - 1;
    const ops: Op[] = [];
    if (at > 0) ops.push({ t: "r", n: at });
    if (c.s.length) ops.push({ t: "i", s: c.s });
    return { ops };
  }
  if (c.ty === "ds") {
    if (!(c.si >= 1) || c.ei < c.si) throw new Error("bad delete");
    const at = c.si - 1;
    const n = c.ei - c.si + 1;
    const ops: Op[] = [];
    if (at > 0) ops.push({ t: "r", n: at });
    ops.push({ t: "d", n });
    return { ops };
  }
  if (c.ty === "as") {
    if (!(c.si >= 1) || c.ei < c.si) throw new Error("bad style");
    const at = c.si - 1;
    const n = c.ei - c.si + 1;
    const attrs = fromSm(c.sm);
    const ops: Op[] = [];
    if (at > 0) ops.push({ t: "r", n: at });
    ops.push({ t: "r", n, a: attrs });
    return chop(ops);
  }
  if (c.ty === "mlti") return commandsToDelta(c.mts);
  return { ops: [] };
}

export function canon(delta: Delta): Delta {
  return commandsToDelta(deltaToCommands(delta));
}

export function commandsToDelta(commands: Command[]): Delta {
  let delta: Delta = { ops: [] };
  for (const c of flatten(commands)) delta = compose(delta, commandToDelta(c));
  return delta;
}

function pushAs(cmds: Command[], st: "text" | "paragraph" | "list", si: number, ei: number, attrs?: Attrs) {
  if (!attrs || ei < si) return;
  cmds.push({ ty: "as", st, si, ei, sm: toSm(attrs) });
}

/** Kix-style commands. A multi-command change is wrapped in one atomic `mlti`. */
export function deltaToCommands(delta: Delta): Command[] {
  const cmds: Command[] = [];
  let cursor = 0;
  for (const op of delta.ops) {
    if (op.t === "i") {
      if (!op.s.length) continue;
      const ibi = cursor + 1;
      cmds.push({ ty: "is", ibi, s: op.s });
      cursor += op.s.length;
      const ei = cursor;
      pushAs(cmds, "text", ibi, ei, pickAttrs(op.a, TEXT_KEYS));
      pushAs(cmds, "paragraph", ibi, ei, pickAttrs(op.a, HEAD_KEYS));
      pushAs(cmds, "list", ibi, ei, pickAttrs(op.a, LIST_KEYS));
    } else if (op.t === "d") {
      if (op.n <= 0) continue;
      cmds.push({ ty: "ds", si: cursor + 1, ei: cursor + op.n });
    } else {
      if (op.a) {
        const si = cursor + 1;
        const ei = cursor + op.n;
        pushAs(cmds, "text", si, ei, pickAttrs(op.a, TEXT_KEYS));
        pushAs(cmds, "paragraph", si, ei, pickAttrs(op.a, HEAD_KEYS));
        pushAs(cmds, "list", si, ei, pickAttrs(op.a, LIST_KEYS));
      }
      cursor += op.n;
    }
  }
  if (cmds.length <= 1) return cmds;
  return [{ ty: "mlti", mts: cmds }];
}
