import { type Attrs, type Delta, type Op } from "../shared/delta.ts";
import { splice } from "../shared/doc.ts";

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TR", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);

function mapFont(family: string): string | undefined {
  const f = family.toLowerCase();
  if (f.includes("lora")) return "Lora";
  if (f.includes("mono") || f.includes("consolas") || f.includes("courier")) return "Roboto Mono";
  if (f.includes("roboto")) return "Roboto";
  if (f.includes("open sans") || f.includes("arial") || f.includes("helvetica") || f.includes("sans")) return "Open Sans";
  const name = family.split(",")[0].replace(/["']/g, "").trim();
  return name || undefined;
}

function textFromEl(el: HTMLElement): Attrs {
  const attrs: Attrs = {};
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") attrs.b = true;
  if (tag === "I" || tag === "EM") attrs.i = true;
  if (tag === "U") attrs.u = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") attrs.strike = true;
  if (tag === "SUP") attrs.sup = true;
  if (tag === "SUB") attrs.sub = true;
  if (tag === "A") {
    const href = el.getAttribute("href");
    if (href) attrs.link = href;
  }
  if (tag === "MARK") attrs.hl = el.style.backgroundColor || "#fff59d";
  const style = el.style;
  if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600) attrs.b = true;
  if (style.fontStyle === "italic") attrs.i = true;
  const deco = style.textDecoration || style.textDecorationLine || "";
  if (deco.includes("underline")) attrs.u = true;
  if (deco.includes("line-through")) attrs.strike = true;
  if (style.color) attrs.color = style.color;
  if (style.fontFamily) {
    const font = mapFont(style.fontFamily);
    if (font) attrs.font = font;
  }
  if (style.fontSize) {
    const n = parseFloat(style.fontSize);
    if (Number.isFinite(n) && n > 0) {
      if (style.fontSize.endsWith("px")) attrs.size = Math.max(8, Math.round(n * 0.75));
      else if (style.fontSize.endsWith("pt")) attrs.size = Math.max(8, Math.round(n));
    }
  }
  return attrs;
}

function paraFromEl(el: HTMLElement): Attrs {
  const attrs: Attrs = {};
  const tag = el.tagName;
  if (tag === "H1") attrs.h = "h1";
  else if (tag === "H2") attrs.h = "h2";
  else if (tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") attrs.h = "h3";
  const align = el.style.textAlign;
  if (align === "center" || align === "right" || align === "justify" || align === "left") attrs.align = align;
  if (tag === "LI") {
    const parent = el.parentElement?.tagName;
    attrs.list = parent === "OL" ? "numbered" : "bullet";
  }
  return attrs;
}

function pushText(ops: Op[], text: string, attrs: Attrs): void {
  const clean = text.replace(/\u00a0/g, " ").replace(/[\r\t\v\f]/g, " ");
  if (!clean) return;
  const prev = ops[ops.length - 1];
  if (prev && prev.t === "i" && !prev.s.endsWith("\n") && same(prev.a, attrs)) prev.s += clean;
  else ops.push(Object.keys(attrs).length ? { t: "i", s: clean, a: { ...attrs } } : { t: "i", s: clean });
}

function same(a?: Attrs, b?: Attrs): boolean {
  const ak = Object.keys(a || {});
  const bk = Object.keys(b || {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!b || a![k] !== b[k]) return false;
  return true;
}

function ensureBreak(ops: Op[], para: Attrs): void {
  const last = ops[ops.length - 1];
  if (last && last.t === "i" && last.s.endsWith("\n")) return;
  const attrs: Attrs = {};
  for (const k of ["h", "align", "list", "lv"]) if (para[k] != null) attrs[k] = para[k];
  if (!attrs.h) attrs.h = "normal";
  if (!attrs.align) attrs.align = "left";
  ops.push({ t: "i", s: "\n", a: attrs });
}

function walk(node: Node, text: Attrs, para: Attrs, ops: Op[]): void {
  if (node.nodeType === 3) {
    pushText(ops, node.textContent || "", text);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE") return;
  if (tag === "BR") {
    ensureBreak(ops, para);
    return;
  }
  const nextText = { ...text, ...textFromEl(el) };
  const nextPara = { ...para, ...paraFromEl(el) };
  if (BLOCKS.has(tag) && ops.length) ensureBreak(ops, para);
  for (const child of el.childNodes) walk(child, nextText, nextPara, ops);
  if (BLOCKS.has(tag)) ensureBreak(ops, nextPara);
}

function stripTrailingBreak(ops: Op[]): void {
  const last = ops[ops.length - 1];
  if (last && last.t === "i" && last.s.endsWith("\n")) {
    last.s = last.s.slice(0, -1);
    if (!last.s) ops.pop();
  }
}

export function htmlToOps(html: string): Op[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const ops: Op[] = [];
  walk(parsed.body, {}, { h: "normal", align: "left" }, ops);
  stripTrailingBreak(ops);
  return ops;
}

export function plainToOps(plain: string): Op[] {
  const text = plain.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text) return [];
  const lines = text.split("\n");
  const ops: Op[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) ops.push({ t: "i", s: lines[i] });
    if (i < lines.length - 1) ops.push({ t: "i", s: "\n", a: { h: "normal", align: "left" } });
  }
  return ops;
}

export function clipboardToDelta(html: string, plain: string, start: number, end: number, docLength: number): Delta {
  const ops = html.trim() ? htmlToOps(html) : plainToOps(plain);
  if (!ops.length) return { ops: [] };
  return splice(start, end, ops, docLength);
}
