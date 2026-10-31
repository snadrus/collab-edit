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
  if (r < 0 || r > 10000 || c < 0 || c > 700) return null;
  return { sheet, r, c, absC: m[1] === "$", absR: m[3] === "$" };
}

type Tok =
  | { t: "num"; n: number }
  | { t: "str"; s: string }
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
      while (i < src.length && src[i] !== '"') s += src[i++];
      if (src[i] === '"') i++;
      out.push({ t: "str", s });
      continue;
    }
    if ("+-*/&><=:".includes(ch)) {
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
    let left = this.unary();
    while (this.peek().t === "op" && ["*", "/"].includes((this.peek() as { s: string }).s)) {
      const op = (this.take() as { s: string }).s;
      left = { k: "bin", op, l: left, r: this.unary() };
    }
    return left;
  }
  unary(): Expr {
    if (this.peek().t === "op" && (this.peek() as { s: string }).s === "-") {
      this.take();
      return { k: "neg", x: this.unary() };
    }
    return this.primary();
  }
  primary(): Expr {
    const tok = this.take();
    if (tok.t === "num") return { k: "num", n: tok.n };
    if (tok.t === "str") return { k: "str", s: tok.s };
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
  if (v.t === "s" && v.s.trim() !== "" && Number.isFinite(Number(v.s))) return Number(v.s);
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
  return text(a).toLowerCase() === text(b).toLowerCase();
}

export function evaluate(grid: GridRead, sheet: string, raw: string, stack: string[] = []): Value {
  if (!raw.startsWith("=")) {
    if (raw === "") return { t: "z" };
    if (Number.isFinite(Number(raw)) && raw.trim() !== "") return { t: "n", n: Number(raw) };
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
      const range = args[1];
      const sheetName = range.a.sheet || range.b.sheet || sheet;
      const r1 = Math.min(range.a.r, range.b.r);
      const r2 = Math.max(range.a.r, range.b.r);
      const c1 = Math.min(range.a.c, range.b.c);
      for (let r = r1; r <= r2; r++) {
        const cell = evalRef({ sheet: sheetName, r, c: c1, absR: false, absC: false }, seen);
        if (sameKey(cell, key)) return evalRef({ sheet: sheetName, r, c: c1 + index - 1, absR: false, absC: false }, seen);
      }
      return { t: "e", e: "#N/A" };
    }
    return { t: "e", e: "#NAME?" };
  };
  return evalExpr(expr, stack);
}

export function displayValue(value: Value, format = "general"): string {
  if (value.t === "e") return value.e;
  if (value.t === "z") return "";
  if (value.t === "b") return value.b ? "TRUE" : "FALSE";
  if (value.t === "s") return value.s;
  if (format === "number") return value.n.toFixed(2);
  if (format === "percent") return (value.n * 100).toFixed(0) + "%";
  if (format === "currency") return "$" + value.n.toFixed(2);
  if (Number.isInteger(value.n)) return String(value.n);
  return String(Math.round(value.n * 1e6) / 1e6);
}
