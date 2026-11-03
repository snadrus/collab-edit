export interface Ref {
  sheet: string | null;
  r: number;
  c: number;
  absR: boolean;
  absC: boolean;
}

export type Value =
  | { t: "n"; n: number }
  | { t: "s"; s: string }
  | { t: "b"; b: boolean }
  | { t: "e"; e: string }
  | { t: "z" };

type Expr =
  | { k: "num"; n: number }
  | { k: "str"; s: string }
  | { k: "bool"; b: boolean }
  | { k: "ref"; ref: Ref }
  | { k: "range"; a: Ref; b: Ref }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "neg"; x: Expr };

export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(index: number): string {
  let s = "";
  let x = index + 1;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export function formatRef(ref: Ref): string {
  const sheet = ref.sheet ? (/[^A-Za-z0-9_]/.test(ref.sheet) ? `'${ref.sheet.replace(/'/g, "''")}'` : ref.sheet) + "!" : "";
  return sheet + (ref.absC ? "$" : "") + indexToCol(ref.c) + (ref.absR ? "$" : "") + (ref.r + 1);
}

const CELL = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;

function parseCell(token: string, sheet: string | null): Ref | null {
  const m = CELL.exec(token);
  if (!m) return null;
  const c = colToIndex(m[2]);
  const r = Number(m[4]) - 1;
  if (r < 0 || r > 1048575 || c < 0 || c > 16383) return null;
  return { sheet, r, c, absC: m[1] === "$", absR: m[3] === "$" };
}

type Tok =
  | { t: "num"; n: number }
  | { t: "str"; s: string }
  | { t: "bool"; b: boolean }
  | { t: "id"; s: string }
  | { t: "ref"; ref: Ref }
  | { t: "op"; s: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "eof" };

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const src = input.trim();
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    if (ch === ",") {
      out.push({ t: "comma" });
      i++;
      continue;
    }
    if (ch === "'" ) {
      let name = "";
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i++;
          break;
        }
        name += src[i++];
      }
      if (src[i] === "!") {
        i++;
        const start = i;
        while (i < src.length && /[A-Za-z0-9$]/.test(src[i])) i++;
        const ref = parseCell(src.slice(start, i), name);
        if (!ref) throw new Error("#REF!");
        out.push({ t: "ref", ref });
      } else out.push({ t: "str", s: name });
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: "str", s });
      continue;
    }
    if ("+-*/^%&><=:".includes(ch)) {
      const two = src.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "<>") {
        out.push({ t: "op", s: two });
        i += 2;
      } else {
        out.push({ t: "op", s: ch });
        i++;
      }
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      out.push({ t: "num", n: Number(src.slice(start, i)) });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
      const word = src.slice(start, i);
      if ((word.toUpperCase() === "TRUE" || word.toUpperCase() === "FALSE") && src[i] !== "(") {
        out.push({ t: "bool", b: word.toUpperCase() === "TRUE" });
        continue;
      }
      if (src[i] === "!") {
        i++;
        const c0 = i;
        while (i < src.length && /[A-Za-z0-9$]/.test(src[i])) i++;
        const ref = parseCell(src.slice(c0, i), word);
        if (!ref) throw new Error("#REF!");
        out.push({ t: "ref", ref });
      } else {
        const ref = parseCell(word, null);
        if (ref && (i >= src.length || src[i] !== "(")) out.push({ t: "ref", ref });
        else out.push({ t: "id", s: word });
      }
      continue;
    }
    throw new Error("#NAME?");
  }
  out.push({ t: "eof" });
  return out;
}

class Parser {
  i = 0;
  toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.i];
  }
  take(): Tok {
    return this.toks[this.i++];
  }
  parse(): Expr {
    const expr = this.comparison();
    if (this.peek().t !== "eof") throw new Error("#NAME?");
    return expr;
  }
  comparison(): Expr {
    let left = this.add();
    while (this.peek().t === "op" && [">", "<", ">=", "<=", "=", "<>"].includes((this.peek() as { s: string }).s)) {
      const op = (this.take() as { s: string }).s;
      left = { k: "bin", op, l: left, r: this.add() };
    }
    return left;
  }
  add(): Expr {
    let left = this.mul();
    while (this.peek().t === "op" && ["+", "-", "&"].includes((this.peek() as { s: string }).s)) {
      const op = (this.take() as { s: string }).s;
      left = { k: "bin", op, l: left, r: this.mul() };
    }
    return left;
  }
  mul(): Expr {
    let left = this.power();
    while (this.peek().t === "op" && ["*", "/"].includes((this.peek() as { s: string }).s)) {
      const op = (this.take() as { s: string }).s;
      left = { k: "bin", op, l: left, r: this.power() };
    }
    return left;
  }
  /** `^` binds tighter than * and /, looser than unary minus (Sheets: -2^2 = 4), left to right. */
  power(): Expr {
    let left = this.unary();
    while (this.peek().t === "op" && (this.peek() as { s: string }).s === "^") {
      this.take();
      left = { k: "bin", op: "^", l: left, r: this.unary() };
    }
    return left;
  }
  unary(): Expr {
    if (this.peek().t === "op" && (this.peek() as { s: string }).s === "-") {
      this.take();
      return { k: "neg", x: this.unary() };
    }
    let x = this.primary();
    // Postfix percent: 50% = 0.5.
    while (this.peek().t === "op" && (this.peek() as { s: string }).s === "%") {
      this.take();
      x = { k: "bin", op: "*", l: x, r: { k: "num", n: 0.01 } };
    }
    return x;
  }
  primary(): Expr {
    const tok = this.take();
    if (tok.t === "num") return { k: "num", n: tok.n };
    if (tok.t === "str") return { k: "str", s: tok.s };
    if (tok.t === "bool") return { k: "bool", b: tok.b };
    if (tok.t === "ref") {
      if (this.peek().t === "op" && (this.peek() as { s: string }).s === ":") {
        this.take();
        const end = this.take();
        if (end.t !== "ref") throw new Error("#REF!");
        return { k: "range", a: tok.ref, b: end.ref };
      }
      return { k: "ref", ref: tok.ref };
    }
    if (tok.t === "id") {
      if (this.peek().t !== "lp") throw new Error("#NAME?");
      this.take();
      const args: Expr[] = [];
      if (this.peek().t !== "rp") {
        args.push(this.comparison());
        while (this.peek().t === "comma") {
          this.take();
          args.push(this.comparison());
        }
      }
      if (this.take().t !== "rp") throw new Error("#NAME?");
      return { k: "call", name: tok.s.toUpperCase(), args };
    }
    if (tok.t === "lp") {
      const inner = this.comparison();
      if (this.take().t !== "rp") throw new Error("#NAME?");
      return inner;
    }
    throw new Error("#NAME?");
  }
}

export function parseFormula(input: string): Expr {
  const body = input.startsWith("=") ? input.slice(1) : input;
  return new Parser(tokenize(body)).parse();
}

export function isValidFormula(input: string): boolean {
  try {
    parseFormula(input.startsWith("=") ? input : "=" + input);
    return true;
  } catch {
    return false;
  }
}

const CANON = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A numeric literal with no leading zeros. "02134" and "00000" stay text. */
export function canonicalNumber(raw: string): number | null {
  const text = raw.trim();
  if (!CANON.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function dateSerial(y: number, m: number, d: number, hh = 0, mi = 0, ss = 0): number {
  const ms = Date.UTC(y, m - 1, d, hh, mi, ss) - Date.UTC(1899, 11, 30);
  return ms / 86400000;
}

export function todaySerial(now = new Date()): number {
  return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function nowSerial(now = new Date()): number {
  return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatSerial(serial: number, fmt: string): string {
  const whole = Math.floor(serial + 1e-8);
  let frac = serial - whole;
  if (frac < 0) frac = 0;
  const d = new Date(Date.UTC(1899, 11, 30) + whole * 86400000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  let secs = Math.round(frac * 86400);
  if (secs >= 86400) secs = 0;
  const hh24 = Math.floor(secs / 3600);
  const mi = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  let i = 0;
  let out = "";
  while (i < fmt.length) {
    if (fmt.startsWith("yyyy", i)) {
      out += String(y);
      i += 4;
      continue;
    }
    if (fmt.startsWith("yy", i)) {
      out += String(y).slice(-2);
      i += 2;
      continue;
    }
    if (fmt.startsWith("mmmm", i)) {
      out += MONTHS[m - 1];
      i += 4;
      continue;
    }
    if (fmt.startsWith("mmm", i)) {
      out += MONS[m - 1];
      i += 3;
      continue;
    }
    if (fmt.startsWith("mm", i)) {
      const prev = fmt[i - 1] || "";
      const next = fmt[i + 2] || "";
      const minute = /[hHsS:]/.test(prev) || next === ":";
      out += pad(minute ? mi : m);
      i += 2;
      continue;
    }
    if (fmt.startsWith("dd", i)) {
      out += pad(day);
      i += 2;
      continue;
    }
    if (fmt.startsWith("hh", i)) {
      out += pad(hh24);
      i += 2;
      continue;
    }
    if (fmt.startsWith("ss", i)) {
      out += pad(ss);
      i += 2;
      continue;
    }
    if (fmt.startsWith("AM/PM", i) || fmt.startsWith("am/pm", i)) {
      out += hh24 >= 12 ? "PM" : "AM";
      i += 5;
      continue;
    }
    if (fmt[i] === "m") {
      out += String(m);
      i++;
      continue;
    }
    if (fmt[i] === "d") {
      out += String(day);
      i++;
      continue;
    }
    if (fmt[i] === "h") {
      out += String(hh24 % 12 || 12);
      i++;
      continue;
    }
    out += fmt[i++];
  }
  return out;
}

export function a1ToIndex(token: string): { r: number; c: number } | null {
  const ref = parseCell(token, null);
  return ref ? { r: ref.r, c: ref.c } : null;
}

function walk(expr: Expr, fn: (ref: Ref) => Ref): Expr {
  if (expr.k === "ref") return { k: "ref", ref: fn(expr.ref) };
  if (expr.k === "range") return { k: "range", a: fn(expr.a), b: fn(expr.b) };
  if (expr.k === "neg") return { k: "neg", x: walk(expr.x, fn) };
  if (expr.k === "bin") return { k: "bin", op: expr.op, l: walk(expr.l, fn), r: walk(expr.r, fn) };
  if (expr.k === "call") return { k: "call", name: expr.name, args: expr.args.map((arg) => walk(arg, fn)) };
  return expr;
}

function printExpr(expr: Expr): string {
  if (expr.k === "num") return String(expr.n);
  if (expr.k === "bool") return expr.b ? "TRUE" : "FALSE";
  if (expr.k === "str") return `"${expr.s.replace(/"/g, '""')}"`;
  if (expr.k === "ref") return formatRef(expr.ref);
  if (expr.k === "range") return formatRef(expr.a) + ":" + formatRef(expr.b);
  if (expr.k === "neg") return "-" + printExpr(expr.x);
  if (expr.k === "bin") return printExpr(expr.l) + expr.op + printExpr(expr.r);
  return expr.name + "(" + expr.args.map(printExpr).join(",") + ")";
}

export function formulaDeps(formula: string): Ref[] {
  if (!formula.startsWith("=")) return [];
  const refs: Ref[] = [];
  const visit = (node: Expr) => {
    if (node.k === "ref") refs.push(node.ref);
    else if (node.k === "range") refs.push(node.a, node.b);
    else if (node.k === "neg") visit(node.x);
    else if (node.k === "bin") {
      visit(node.l);
      visit(node.r);
    } else if (node.k === "call") node.args.forEach(visit);
  };
  try {
    visit(parseFormula(formula));
  } catch {
    return [];
  }
  return refs;
}

export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!formula.startsWith("=") || (dr === 0 && dc === 0)) return formula;
  try {
    const expr = walk(parseFormula(formula), (ref) => ({
      ...ref,
      r: ref.absR ? ref.r : Math.max(0, ref.r + dr),
      c: ref.absC ? ref.c : Math.max(0, ref.c + dc),
    }));
    return "=" + printExpr(expr);
  } catch {
    return formula;
  }
}

export interface GridRead {
  raw(sheet: string, r: number, c: number): string;
  sheets(): string[];
}

function truthy(v: Value): boolean {
  if (v.t === "b") return v.b;
  if (v.t === "n") return v.n !== 0;
  if (v.t === "s") return v.s !== "";
  return false;
}

function num(v: Value): number | null {
  if (v.t === "n") return v.n;
  if (v.t === "b") return v.b ? 1 : 0;
  if (v.t === "s") return canonicalNumber(v.s);
  return null;
}

function text(v: Value): string {
  if (v.t === "s") return v.s;
  if (v.t === "n") return String(v.n);
  if (v.t === "b") return v.b ? "TRUE" : "FALSE";
  if (v.t === "e") return v.e;
  return "";
}

function sameKey(a: Value, b: Value): boolean {
  if (a.t === "n" && b.t === "n") return a.n === b.n;
  if (a.t === "b" && b.t === "b") return a.b === b.b;
  return text(a).toLowerCase() === text(b).toLowerCase();
}

function criteriaMatch(value: Value, crit: Value): boolean {
  if (crit.t === "s") {
    const m = /^(>=|<=|<>|>|<|=)([\s\S]*)$/.exec(crit.s);
    if (m) {
      const rest = m[2];
      const rhsN = canonicalNumber(rest.trim());
      const rhs: Value = rhsN != null ? { t: "n", n: rhsN } : { t: "s", s: rest };
      if (m[1] === "=") return sameKey(value, rhs);
      if (m[1] === "<>") return !sameKey(value, rhs);
      const ln = num(value);
      const rn = num(rhs);
      if (ln == null || rn == null) {
        const ls = text(value);
        const rs = text(rhs);
        if (m[1] === ">") return ls > rs;
        if (m[1] === "<") return ls < rs;
        if (m[1] === ">=") return ls >= rs;
        return ls <= rs;
      }
      if (m[1] === ">") return ln > rn;
      if (m[1] === "<") return ln < rn;
      if (m[1] === ">=") return ln >= rn;
      return ln <= rn;
    }
  }
  return sameKey(value, crit);
}

export function evaluate(grid: GridRead, sheet: string, raw: string, stack: string[] = []): Value {
  if (!raw.startsWith("=")) {
    if (raw === "") return { t: "z" };
    if (raw.startsWith("'")) return { t: "s", s: raw.slice(1) };
    const plain = canonicalNumber(raw);
    if (plain != null) return { t: "n", n: plain };
    return { t: "s", s: raw };
  }
  let expr: Expr;
  try {
    expr = parseFormula(raw);
  } catch (err) {
    return { t: "e", e: err instanceof Error && err.message.startsWith("#") ? err.message : "#NAME?" };
  }
  const evalExpr = (node: Expr, seen: string[]): Value => {
    if (node.k === "num") return { t: "n", n: node.n };
    if (node.k === "bool") return { t: "b", b: node.b };
    if (node.k === "str") return { t: "s", s: node.s };
    if (node.k === "neg") {
      const inner = evalExpr(node.x, seen);
      if (inner.t === "e") return inner;
      const n = num(inner);
      return n == null ? { t: "e", e: "#VALUE!" } : { t: "n", n: -n };
    }
    if (node.k === "ref") return evalRef(node.ref, seen);
    if (node.k === "range") return { t: "e", e: "#VALUE!" };
    if (node.k === "bin") return evalBin(node.op, evalExpr(node.l, seen), evalExpr(node.r, seen));
    return evalCall(node.name, node.args, seen);
  };
  const cellsOf = (node: Expr, seen: string[]): Value[] => {
    if (node.k === "range") {
      const sheetName = node.a.sheet || node.b.sheet || sheet;
      const r1 = Math.min(node.a.r, node.b.r);
      const r2 = Math.max(node.a.r, node.b.r);
      const c1 = Math.min(node.a.c, node.b.c);
      const c2 = Math.max(node.a.c, node.b.c);
      const values: Value[] = [];
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) values.push(evalRef({ sheet: sheetName, r, c, absR: false, absC: false }, seen));
      return values;
    }
    return [evalExpr(node, seen)];
  };
  const evalRef = (ref: Ref, seen: string[]): Value => {
    const name = ref.sheet || sheet;
    const id = name + "!" + ref.r + "," + ref.c;
    if (seen.includes(id)) return { t: "e", e: "#CYCLE!" };
    if (!grid.sheets().includes(name)) return { t: "e", e: "#REF!" };
    return evaluate(grid, name, grid.raw(name, ref.r, ref.c), [...seen, id]);
  };
  const evalBin = (op: string, l: Value, r: Value): Value => {
    if (l.t === "e") return l;
    if (r.t === "e") return r;
    if (op === "&") return { t: "s", s: text(l) + text(r) };
    const ln = num(l);
    const rn = num(r);
    if (ln == null || rn == null) {
      if (op === "=") return { t: "b", b: sameKey(l, r) };
      if (op === "<>") return { t: "b", b: !sameKey(l, r) };
      return { t: "e", e: "#VALUE!" };
    }
    if (op === "+") return { t: "n", n: ln + rn };
    if (op === "-") return { t: "n", n: ln - rn };
    if (op === "*") return { t: "n", n: ln * rn };
    if (op === "^") return { t: "n", n: ln ** rn };
    if (op === "/") return rn === 0 ? { t: "e", e: "#DIV/0!" } : { t: "n", n: ln / rn };
    if (op === ">") return { t: "b", b: ln > rn };
    if (op === "<") return { t: "b", b: ln < rn };
    if (op === ">=") return { t: "b", b: ln >= rn };
    if (op === "<=") return { t: "b", b: ln <= rn };
    if (op === "=") return { t: "b", b: ln === rn };
    if (op === "<>") return { t: "b", b: ln !== rn };
    return { t: "e", e: "#NAME?" };
  };
  const numbers = (args: Expr[], seen: string[]) => args.flatMap((arg) => cellsOf(arg, seen)).map(num).filter((n): n is number => n != null);
  const evalCall = (name: string, args: Expr[], seen: string[]): Value => {
    if (name === "SUM") return { t: "n", n: numbers(args, seen).reduce((a, b) => a + b, 0) };
    if (name === "AVERAGE") {
      const ns = numbers(args, seen);
      return ns.length ? { t: "n", n: ns.reduce((a, b) => a + b, 0) / ns.length } : { t: "e", e: "#DIV/0!" };
    }
    if (name === "MIN") {
      const ns = numbers(args, seen);
      return ns.length ? { t: "n", n: Math.min(...ns) } : { t: "n", n: 0 };
    }
    if (name === "MAX") {
      const ns = numbers(args, seen);
      return ns.length ? { t: "n", n: Math.max(...ns) } : { t: "n", n: 0 };
    }
    if (name === "COUNT") return { t: "n", n: numbers(args, seen).length };
    if (name === "CONCAT") {
      return { t: "s", s: args.flatMap((arg) => cellsOf(arg, seen)).map(text).join("") };
    }
    if (name === "IF") {
      const cond = evalExpr(args[0], seen);
      if (cond.t === "e") return cond;
      return evalExpr(truthy(cond) ? args[1] : args[2] || { k: "str", s: "" }, seen);
    }
    if (name === "VLOOKUP") {
      if (args[1]?.k !== "range") return { t: "e", e: "#VALUE!" };
      const key = evalExpr(args[0], seen);
      if (key.t === "e") return key;
      const index = num(evalExpr(args[2], seen));
      if (index == null || index < 1) return { t: "e", e: "#VALUE!" };
      let exact = true;
      if (args[3]) {
        const flag = evalExpr(args[3], seen);
        const approx = flag.t === "b" ? flag.b : flag.t === "n" ? flag.n !== 0 : flag.t === "s" && flag.s.toUpperCase() === "TRUE";
        exact = !approx;
      }
      const range = args[1];
      const sheetName = range.a.sheet || range.b.sheet || sheet;
      const r1 = Math.min(range.a.r, range.b.r);
      const r2 = Math.max(range.a.r, range.b.r);
      const c1 = Math.min(range.a.c, range.b.c);
      let approxRow = -1;
      for (let r = r1; r <= r2; r++) {
        const cell = evalRef({ sheet: sheetName, r, c: c1, absR: false, absC: false }, seen);
        if (exact) {
          if (sameKey(cell, key)) return evalRef({ sheet: sheetName, r, c: c1 + index - 1, absR: false, absC: false }, seen);
        } else {
          const ln = num(cell);
          const kn = num(key);
          if (ln != null && kn != null && ln <= kn) approxRow = r;
          else if (ln != null && kn != null && ln > kn) break;
        }
      }
      if (!exact && approxRow >= 0) return evalRef({ sheet: sheetName, r: approxRow, c: c1 + index - 1, absR: false, absC: false }, seen);
      return { t: "e", e: "#N/A" };
    }
    if (name === "INDEX") {
      if (args[0]?.k !== "range") return { t: "e", e: "#VALUE!" };
      const row = num(evalExpr(args[1], seen));
      const col = args[2] ? num(evalExpr(args[2], seen)) : 1;
      if (row == null || col == null || row < 1 || col < 1) return { t: "e", e: "#VALUE!" };
      const range = args[0];
      const r1 = Math.min(range.a.r, range.b.r);
      const c1 = Math.min(range.a.c, range.b.c);
      const r = r1 + row - 1;
      const c = c1 + col - 1;
      if (r > Math.max(range.a.r, range.b.r) || c > Math.max(range.a.c, range.b.c)) return { t: "e", e: "#REF!" };
      return evalRef({ sheet: range.a.sheet || range.b.sheet, r, c, absR: false, absC: false }, seen);
    }
    if (name === "MATCH") {
      if (args[1]?.k !== "range") return { t: "e", e: "#VALUE!" };
      const key = evalExpr(args[0], seen);
      if (key.t === "e") return key;
      const mode = args[2] ? num(evalExpr(args[2], seen)) : 1;
      const values = cellsOf(args[1], seen);
      if (mode === 0) {
        for (let i = 0; i < values.length; i++) if (sameKey(values[i], key)) return { t: "n", n: i + 1 };
        return { t: "e", e: "#N/A" };
      }
      let found = -1;
      for (let i = 0; i < values.length; i++) {
        const ln = num(values[i]);
        const kn = num(key);
        if (ln == null || kn == null) continue;
        if (mode === -1 ? ln >= kn : ln <= kn) found = i;
        else break;
      }
      return found >= 0 ? { t: "n", n: found + 1 } : { t: "e", e: "#N/A" };
    }
    if (name === "COUNTIF") {
      if (args[0]?.k !== "range") return { t: "e", e: "#VALUE!" };
      const crit = evalExpr(args[1], seen);
      if (crit.t === "e") return crit;
      return { t: "n", n: cellsOf(args[0], seen).filter((value) => criteriaMatch(value, crit)).length };
    }
    if (name === "SUMIF") {
      if (args[0]?.k !== "range") return { t: "e", e: "#VALUE!" };
      const crit = evalExpr(args[1], seen);
      if (crit.t === "e") return crit;
      const keys = cellsOf(args[0], seen);
      const sums = args[2] ? cellsOf(args[2], seen) : keys;
      let total = 0;
      for (let i = 0; i < keys.length; i++) if (criteriaMatch(keys[i], crit)) total += num(sums[i] || { t: "z" }) || 0;
      return { t: "n", n: total };
    }
    if (name === "TEXT") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return value;
      const fmt = args[1] ? text(evalExpr(args[1], seen)) : "";
      if (value.t === "n" && /[yd]/i.test(fmt)) return { t: "s", s: formatSerial(value.n, fmt) };
      if (value.t === "n" && fmt.includes("%")) {
        const decimals = (fmt.split("%")[0].split(".")[1] || "").length;
        return { t: "s", s: (value.n * 100).toFixed(decimals) + "%" };
      }
      if (value.t === "n") return { t: "s", s: String(value.n) };
      return { t: "s", s: text(value) };
    }
    if (name === "TODAY") return { t: "n", n: todaySerial() };
    if (name === "NOW") return { t: "n", n: nowSerial() };
    if (name === "AND" || name === "OR") {
      const values = args.flatMap((arg) => cellsOf(arg, seen));
      const bad = values.find((value) => value.t === "e");
      if (bad) return bad;
      if (!values.length) return { t: "e", e: "#VALUE!" };
      const flags = values.map(truthy);
      return { t: "b", b: name === "AND" ? flags.every(Boolean) : flags.some(Boolean) };
    }
    if (name === "ROUND") {
      const n = num(evalExpr(args[0], seen));
      const digits = args[1] ? num(evalExpr(args[1], seen)) : 0;
      if (n == null || digits == null) return { t: "e", e: "#VALUE!" };
      const factor = 10 ** Math.trunc(digits);
      return { t: "n", n: Math.round(n * factor) / factor };
    }
    if (name === "LEN") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return value;
      return { t: "n", n: text(value).length };
    }
    if (name === "LEFT" || name === "RIGHT") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return value;
      const count = args[1] ? num(evalExpr(args[1], seen)) : 1;
      if (count == null) return { t: "e", e: "#VALUE!" };
      const s = text(value);
      const n = Math.max(0, count);
      return { t: "s", s: name === "LEFT" ? s.slice(0, n) : s.slice(s.length - n) };
    }
    if (name === "MID") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return value;
      const start = num(evalExpr(args[1], seen));
      const count = num(evalExpr(args[2], seen));
      if (start == null || count == null) return { t: "e", e: "#VALUE!" };
      const at = Math.max(0, start - 1);
      return { t: "s", s: text(value).slice(at, at + Math.max(0, count)) };
    }
    if (name === "COUNTA") return { t: "n", n: args.flatMap((arg) => cellsOf(arg, seen)).filter((value) => value.t !== "z" && !(value.t === "s" && value.s === "")).length };
    if (name === "CONCATENATE") return { t: "s", s: args.flatMap((arg) => cellsOf(arg, seen)).map(text).join("") };
    if (name === "UPPER" || name === "LOWER" || name === "TRIM") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return value;
      const s = text(value);
      return { t: "s", s: name === "UPPER" ? s.toUpperCase() : name === "LOWER" ? s.toLowerCase() : s.trim().replace(/ +/g, " ") };
    }
    if (name === "NOT") {
      const value = evalExpr(args[0], seen);
      return value.t === "e" ? value : { t: "b", b: !truthy(value) };
    }
    if (name === "ABS" || name === "SQRT" || name === "INT") {
      const n = num(evalExpr(args[0], seen));
      if (n == null) return { t: "e", e: "#VALUE!" };
      if (name === "SQRT" && n < 0) return { t: "e", e: "#NUM!" };
      return { t: "n", n: name === "ABS" ? Math.abs(n) : name === "SQRT" ? Math.sqrt(n) : Math.floor(n) };
    }
    if (name === "MOD" || name === "POWER") {
      const a = num(evalExpr(args[0], seen));
      const b = num(evalExpr(args[1], seen));
      if (a == null || b == null) return { t: "e", e: "#VALUE!" };
      if (name === "MOD") return b === 0 ? { t: "e", e: "#DIV/0!" } : { t: "n", n: a - b * Math.floor(a / b) };
      return { t: "n", n: a ** b };
    }
    if (name === "PRODUCT") {
      const ns = numbers(args, seen);
      return { t: "n", n: ns.length ? ns.reduce((a, b) => a * b, 1) : 0 };
    }
    if (name === "MEDIAN") {
      const ns = numbers(args, seen).sort((a, b) => a - b);
      if (!ns.length) return { t: "e", e: "#NUM!" };
      const mid = ns.length >> 1;
      return { t: "n", n: ns.length % 2 ? ns[mid] : (ns[mid - 1] + ns[mid]) / 2 };
    }
    if (name === "IFERROR") {
      const value = evalExpr(args[0], seen);
      if (value.t === "e") return evalExpr(args[1] || { k: "str", s: "" }, seen);
      return value;
    }
    return { t: "e", e: "#NAME?" };
  };
  return evalExpr(expr, stack);
}

function grouped(n: number, decimals: number): string {
  const sign = n < 0 ? "-" : "";
  const [whole, frac] = Math.abs(n).toFixed(decimals).split(".");
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}

export function displayValue(value: Value, format = "general", numFmt?: string): string {
  if (value.t === "e") return value.e;
  if (value.t === "z") return "";
  if (value.t === "b") return value.b ? "TRUE" : "FALSE";
  if (value.t === "s") return value.s;
  const fmt = numFmt || "";
  if (format === "date" || (/[yd]/i.test(fmt) && /m/i.test(fmt))) return formatSerial(value.n, fmt || "yyyy-mm-dd");
  if (format === "number") {
    const decimals = fmt.includes(".") ? (fmt.split(".")[1] || "").replace(/[^0#]/g, "").length : 2;
    return value.n.toFixed(decimals || 2);
  }
  if (format === "percent" || fmt.includes("%")) {
    const decimals = ((fmt.includes("%") ? fmt.split("%")[0] : "").split(".")[1] || "").length;
    return (value.n * 100).toFixed(format === "percent" && !fmt ? 0 : decimals) + "%";
  }
  if (format === "currency" || fmt.includes("$")) {
    const decimals = fmt.includes(".") ? (fmt.split(".")[1] || "").replace(/[^0#]/g, "").length : 2;
    return (value.n < 0 ? "-$" : "$") + grouped(Math.abs(value.n), decimals);
  }
  if (Number.isInteger(value.n)) return String(value.n);
  return String(Math.round(value.n * 1e6) / 1e6);
}
