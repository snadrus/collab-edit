export interface EqNode {
  t: "row" | "char" | "frac" | "sqrt" | "script";
  s?: string;
  w: number;
  h: number;
  d: number;
  kids?: EqNode[];
}

const SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Sigma: "Σ",
  Omega: "Ω",
  times: "×",
  cdot: "·",
  pm: "±",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  infty: "∞",
  sum: "∑",
  int: "∫",
  partial: "∂",
};

function text(s: string): EqNode {
  return { t: "char", s, w: Math.max(0.35, [...s].length * 0.55), h: 0.8, d: 0.2 };
}

function row(kids: EqNode[]): EqNode {
  const used = kids.filter((kid) => kid.w > 0 || kid.s);
  if (!used.length) return text("");
  return {
    t: "row",
    kids: used,
    w: used.reduce((sum, kid) => sum + kid.w, 0),
    h: Math.max(...used.map((kid) => kid.h)),
    d: Math.max(...used.map((kid) => kid.d)),
  };
}

function frac(num: EqNode, den: EqNode): EqNode {
  return { t: "frac", kids: [num, den], w: Math.max(num.w, den.w) + 0.4, h: num.h + num.d + 0.2, d: den.h + den.d + 0.15 };
}

function radical(body: EqNode): EqNode {
  return { t: "sqrt", kids: [body], w: body.w + 0.75, h: body.h + 0.2, d: body.d };
}

function script(base: EqNode, arg: EqNode, sup: boolean): EqNode {
  return {
    t: "script",
    s: sup ? "sup" : "sub",
    kids: [base, arg],
    w: base.w + arg.w * 0.72,
    h: sup ? Math.max(base.h, arg.h * 0.72 + 0.45) : base.h,
    d: sup ? base.d : Math.max(base.d, arg.d * 0.72 + 0.35),
  };
}

class Parser {
  i = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }

  parseRow(): EqNode {
    const kids: EqNode[] = [];
    while (this.i < this.src.length && this.src[this.i] !== "}") {
      const atom = this.parseAtom();
      if (!atom) break;
      kids.push(atom);
    }
    return row(kids);
  }

  parseAtom(): EqNode | null {
    if (this.i >= this.src.length || this.src[this.i] === "}" || this.src[this.i] === "^" || this.src[this.i] === "_") return null;
    const ch = this.src[this.i];
    if (ch === " ") {
      this.i++;
      return text(" ");
    }
    if (ch === "{") {
      this.i++;
      const body = this.parseRow();
      if (this.src[this.i] === "}") this.i++;
      return this.scripts(body);
    }
    if (ch === "\\") {
      this.i++;
      let name = "";
      while (this.i < this.src.length && /[A-Za-z]/.test(this.src[this.i])) name += this.src[this.i++];
      if (name === "frac") return this.scripts(frac(this.parseGroup(), this.parseGroup()));
      if (name === "sqrt") return this.scripts(radical(this.parseGroup()));
      return this.scripts(text(SYMBOLS[name] || name || "□"));
    }
    this.i++;
    return this.scripts(text(ch));
  }

  scripts(base: EqNode): EqNode {
    let node = base;
    while (this.src[this.i] === "^" || this.src[this.i] === "_") {
      const sup = this.src[this.i] === "^";
      this.i++;
      node = script(node, this.parseGroup(), sup);
    }
    return node;
  }

  parseGroup(): EqNode {
    if (this.src[this.i] === "{") {
      this.i++;
      const body = this.parseRow();
      if (this.src[this.i] === "}") this.i++;
      return body;
    }
    const atom = this.parseAtom();
    return atom || text("?");
  }
}

export function parseEquation(src: string): EqNode {
  const clean = src.replace(/[\u0000-\u001f]/g, "").slice(0, 400);
  try {
    return new Parser(clean || "□").parseRow();
  } catch {
    return text(clean || "□");
  }
}
