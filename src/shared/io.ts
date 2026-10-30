import { type Attrs } from "./delta.ts";
import { CELL, EMBED, ROW } from "./delta.ts";
import {
  type CharStyle,
  type Doc,
  type Heading,
  type Snapshot,
  applyAttrs,
  chipLabel,
  emptyDoc,
  plainText,
  restoreDoc,
  snapshotDoc,
} from "./doc.ts";
import { type Thread, sanitizeThread } from "./threads.ts";
import { zipFiles, unzip } from "./zip.ts";

export interface FelarumiFile {
  format: "felarumi";
  version: 1;
  title: string;
  snapshot: Snapshot;
  threads: Thread[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface Run {
  text: string;
  a?: Attrs;
}

interface Para {
  para: Attrs;
  runs: Run[];
}

function buildDoc(paras: Para[]): Doc {
  if (!paras.length) return emptyDoc();
  let text = "";
  const styles: CharStyle[] = [];
  for (const para of paras) {
    for (const run of para.runs) {
      for (const ch of run.text) {
        text += ch;
        styles.push(run.a ? applyAttrs({}, run.a, ch) : {});
      }
    }
    text += "\n";
    styles.push(applyAttrs({ h: "normal", align: "left" }, para.para, "\n"));
  }
  if (!text.endsWith("\n")) {
    text += "\n";
    styles.push({ h: "normal", align: "left" });
  }
  return { text, styles };
}

function parasOf(doc: Doc): Para[] {
  const paras: Para[] = [];
  let runs: Run[] = [];
  let buf = "";
  let cur: Attrs | undefined;
  const flush = () => {
    if (!buf) return;
    const prev = runs[runs.length - 1];
    if (prev && JSON.stringify(prev.a || {}) === JSON.stringify(cur || {})) prev.text += buf;
    else runs.push(cur && Object.keys(cur).length ? { text: buf, a: cur } : { text: buf });
    buf = "";
  };
  for (let i = 0; i < doc.text.length; i++) {
    const ch = doc.text[i];
    if (ch === "\n" || ch === "\f" || ch === ROW) {
      flush();
      const st = doc.styles[i] || {};
      const para: Attrs = { h: st.h || "normal", align: st.align || "left" };
      if (st.list) para.list = st.list;
      if (st.lv) para.lv = st.lv;
      if (ch === "\f") para.hr = false;
      paras.push({ para, runs });
      if (ch === "\f") paras.push({ para: { h: "normal", align: "left" }, runs: [{ text: "\f" }] });
      runs = [];
      continue;
    }
    if (ch === CELL) {
      flush();
      buf = "\t";
      cur = undefined;
      flush();
      continue;
    }
    const label = ch === EMBED ? chipLabel(doc.styles[i]) || " " : ch;
    const st = doc.styles[i] || {};
    const a: Attrs = {};
    if (st.b) a.b = true;
    if (st.i) a.i = true;
    if (st.u) a.u = true;
    if (st.strike) a.strike = true;
    if (st.link) a.link = st.link;
    if (st.sup) a.sup = true;
    if (st.sub) a.sub = true;
    const key = JSON.stringify(a);
    if (buf && JSON.stringify(cur || {}) !== key) flush();
    cur = Object.keys(a).length ? a : undefined;
    buf += label;
  }
  flush();
  if (runs.length) paras.push({ para: { h: "normal", align: "left" }, runs });
  return paras;
}

export function toFelarumi(title: string, doc: Doc, threads: Thread[]): string {
  const file: FelarumiFile = {
    format: "felarumi",
    version: 1,
    title,
    snapshot: snapshotDoc(doc),
    threads: threads.map((t) => sanitizeThread(t)).filter((t): t is Thread => !!t),
  };
  return JSON.stringify(file);
}

export function fromFelarumi(raw: string): { title: string; doc: Doc; threads: Thread[] } {
  const data = JSON.parse(raw) as Partial<FelarumiFile>;
  if (data.format !== "felarumi" || !data.snapshot || typeof data.snapshot.text !== "string" || !Array.isArray(data.snapshot.runs)) {
    throw new Error("not a felarumi file");
  }
  const doc = restoreDoc(data.snapshot as Snapshot);
  if (!doc.text.endsWith("\n")) throw new Error("felarumi file is missing its final paragraph");
  const threads = (data.threads || []).map((t) => sanitizeThread(t)).filter((t): t is Thread => !!t);
  return { title: typeof data.title === "string" ? data.title.slice(0, 200) : "", doc, threads };
}

export function toText(doc: Doc): string {
  return plainText(doc).replace(/\u000c/g, "\n").replace(/\u001c/g, "\t").replace(/\u001e/g, "\n").replace(/\uFFFC/g, "");
}

export function toMarkdown(doc: Doc): string {
  const lines: string[] = [];
  for (const para of parasOf(doc)) {
    if (para.runs.length === 1 && para.runs[0].text === "\f") {
      lines.push("", "---", "");
      continue;
    }
    let body = "";
    for (const run of para.runs) {
      let t = run.text;
      if (run.a?.b) t = `**${t}**`;
      if (run.a?.i) t = `*${t}*`;
      if (run.a?.strike) t = `~~${t}~~`;
      if (run.a?.link) t = `[${t}](${run.a.link})`;
      body += t;
    }
    const h = para.para.h as Heading | undefined;
    if (h === "title" || h === "h1") body = "# " + body;
    else if (h === "subtitle" || h === "h2") body = "## " + body;
    else if (h === "h3") body = "### " + body;
    else if (h === "h4") body = "#### " + body;
    else if (h === "h5") body = "##### " + body;
    else if (h === "h6") body = "###### " + body;
    if (para.para.list === "bullet") body = "- " + body;
    else if (para.para.list === "numbered") body = "1. " + body;
    else if (para.para.list === "check") body = "- [ ] " + body;
    lines.push(body);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function toHtml(doc: Doc, title: string): string {
  const blocks: string[] = [];
  for (const para of parasOf(doc)) {
    if (para.runs.length === 1 && para.runs[0].text === "\f") {
      blocks.push("<hr>");
      continue;
    }
    let inner = "";
    for (const run of para.runs) {
      let t = xml(run.text);
      if (run.a?.b) t = `<strong>${t}</strong>`;
      if (run.a?.i) t = `<em>${t}</em>`;
      if (run.a?.u) t = `<u>${t}</u>`;
      if (run.a?.strike) t = `<s>${t}</s>`;
      if (run.a?.sup) t = `<sup>${t}</sup>`;
      if (run.a?.sub) t = `<sub>${t}</sub>`;
      if (typeof run.a?.link === "string") t = `<a href="${xml(String(run.a.link))}">${t}</a>`;
      inner += t;
    }
    const h = para.para.h;
    const tag = h === "title" || h === "h1" ? "h1" : h === "subtitle" || h === "h2" ? "h2" : h === "h3" ? "h3" : h === "h4" ? "h4" : h === "h5" ? "h5" : h === "h6" ? "h6" : para.para.list ? "li" : "p";
    blocks.push(`<${tag}>${inner}</${tag}>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${xml(title)}</title></head><body>\n${blocks.join("\n")}\n</body></html>`;
}

function inlineMarkdown(src: string): Run[] {
  const runs: Run[] = [];
  const push = (text: string, a?: Attrs) => {
    if (!text) return;
    runs.push(a && Object.keys(a).length ? { text, a } : { text });
  };
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const i = m.index ?? 0;
    push(src.slice(last, i));
    const tok = m[0];
    if (tok.startsWith("**")) push(tok.slice(2, -2), { b: true });
    else if (tok.startsWith("~~")) push(tok.slice(2, -2), { strike: true });
    else if (tok.startsWith("*")) push(tok.slice(1, -1), { i: true });
    else {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) push(mm[1], { link: mm[2] });
    }
    last = i + tok.length;
  }
  push(src.slice(last));
  return runs;
}

export function fromPlain(text: string): Doc {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (text.endsWith("\n")) lines.pop();
  return buildDoc(lines.map((line) => ({ para: { h: "normal", align: "left" }, runs: [{ text: line }] })));
}

export function fromMarkdown(text: string): Doc {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const paras: Para[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trim() === "---") {
      paras.push({ para: { h: "normal", align: "left" }, runs: [{ text: "\f" }] });
      continue;
    }
    let rest = line;
    const para: Attrs = { h: "normal", align: "left" };
    const heading = /^(#{1,6})\s+(.*)$/.exec(rest);
    if (heading) {
      const level = heading[1].length;
      para.h = level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : level === 4 ? "h4" : level === 5 ? "h5" : "h6";
      rest = heading[2];
    }
    const check = /^[-*]\s+\[(?: |x|X)\]\s+(.*)$/.exec(rest);
    const bullet = /^[-*]\s+(.*)$/.exec(rest);
    const num = /^\d+\.\s+(.*)$/.exec(rest);
    if (check) {
      para.list = "check";
      if (/\[x\]/i.test(rest)) para.check = true;
      rest = check[1];
    } else if (num) {
      para.list = "numbered";
      rest = num[1];
    } else if (bullet && !heading) {
      para.list = "bullet";
      rest = bullet[1];
    }
    paras.push({ para, runs: inlineMarkdown(rest) });
  }
  return buildDoc(paras);
}

export function fromHtml(html: string): Doc {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const paras: Para[] = [];
  const chunks = body.split(/<(p|h1|h2|h3|h4|h5|h6|li|div|blockquote|pre)\b[^>]*>/i).slice(1);
  const take = chunks.length ? chunks : ["p", body];
  for (let i = 0; i < take.length; i += 2) {
    const tag = (take[i] || "p").toLowerCase();
    const inner = (take[i + 1] || "").split(/<\/(p|h1|h2|h3|h4|h5|h6|li|div|blockquote|pre)>/i)[0];
    if (/^\s*$/.test(inner.replace(/<[^>]+>/g, ""))) continue;
    const para: Attrs = {
      h: tag === "h1" ? "h1" : tag === "h2" ? "h2" : tag === "h3" ? "h3" : tag === "h4" ? "h4" : tag === "h5" ? "h5" : tag === "h6" ? "h6" : "normal",
      align: "left",
    };
    if (tag === "li") para.list = "bullet";
    const runs: Run[] = [];
    const re = /<(strong|b|em|i|u|s|strike|sup|sub|a)\b([^>]*)>|<\/(strong|b|em|i|u|s|strike|sup|sub|a)>|([^<]+)/gi;
    const stack: Attrs[] = [];
    const cur = (): Attrs => Object.assign({}, ...stack);
    for (const m of inner.matchAll(re)) {
      if (m[1]) {
        const a: Attrs = {};
        const t = m[1].toLowerCase();
        if (t === "strong" || t === "b") a.b = true;
        if (t === "em" || t === "i") a.i = true;
        if (t === "u") a.u = true;
        if (t === "s" || t === "strike") a.strike = true;
        if (t === "sup") a.sup = true;
        if (t === "sub") a.sub = true;
        if (t === "a") {
          const href = /href\s*=\s*"([^"]*)"/i.exec(m[2] || "") || /href\s*=\s*'([^']*)'/i.exec(m[2] || "");
          if (href) a.link = decodeXml(href[1]);
        }
        stack.push(a);
      } else if (m[3]) stack.pop();
      else if (m[4]) {
        const text = decodeXml(m[4].replace(/\s+/g, " "));
        if (text.trim()) runs.push(Object.keys(cur()).length ? { text, a: cur() } : { text });
      }
    }
    if (runs.length) paras.push({ para, runs });
  }
  return buildDoc(paras);
}

function headingOf(h: unknown): string {
  if (h === "title" || h === "h1") return "Heading1";
  if (h === "subtitle" || h === "h2") return "Heading2";
  if (h === "h3") return "Heading3";
  if (h === "h4") return "Heading4";
  if (h === "h5") return "Heading5";
  if (h === "h6") return "Heading6";
  return "";
}

function documentXml(doc: Doc): string {
  const ps = parasOf(doc)
    .map((para) => {
      if (para.runs.length === 1 && para.runs[0].text === "\f") return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
      const style = headingOf(para.para.h);
      const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
      const runs = para.runs
        .map((run) => {
          const bits = [
            run.a?.b ? "<w:b/>" : "",
            run.a?.i ? "<w:i/>" : "",
            run.a?.u ? `<w:u w:val="single"/>` : "",
            run.a?.strike ? "<w:strike/>" : "",
            run.a?.sup ? `<w:vertAlign w:val="superscript"/>` : "",
            run.a?.sub ? `<w:vertAlign w:val="subscript"/>` : "",
          ].join("");
          return `<w:r>${bits ? `<w:rPr>${bits}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
        })
        .join("");
      return `<w:p>${pPr}${runs}</w:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

const DOCX_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const WORD_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const WORD_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style></w:styles>`;

export async function toDocx(doc: Doc): Promise<Uint8Array> {
  const u = (s: string) => enc.encode(s);
  return zipFiles([
    { name: "[Content_Types].xml", data: u(DOCX_TYPES) },
    { name: "_rels/.rels", data: u(DOCX_RELS) },
    { name: "word/document.xml", data: u(documentXml(doc)) },
    { name: "word/styles.xml", data: u(WORD_STYLES) },
    { name: "word/_rels/document.xml.rels", data: u(WORD_RELS) },
  ]);
}

export async function fromDocx(data: Uint8Array): Promise<Doc> {
  const files = await unzip(data);
  const xmlBytes = files.get("word/document.xml");
  if (!xmlBytes) throw new Error("docx is missing word/document.xml");
  const xml = dec.decode(xmlBytes);
  const paras: Para[] = [];
  for (const part of xml.split(/<w:p[\s>]/).slice(1)) {
    const body = part.split(/<\/w:p>/)[0];
    const para: Attrs = { h: "normal", align: "left" };
    if (/Heading1/.test(body)) para.h = "h1";
    else if (/Heading2/.test(body)) para.h = "h2";
    else if (/Heading3/.test(body)) para.h = "h3";
    else if (/Heading4/.test(body)) para.h = "h4";
    else if (/Heading5/.test(body)) para.h = "h5";
    else if (/Heading6/.test(body)) para.h = "h6";
    const runs: Run[] = [];
    if (/<w:br[^>]*w:type="page"/.test(body)) runs.push({ text: "\f" });
    for (const raw of body.split(/<w:r[\s>]/).slice(1)) {
      const chunk = raw.split(/<\/w:r>/)[0];
      const a: Attrs = {};
      if (/<w:b\/>|<w:b[\s>]/.test(chunk) && !/w:val="(?:0|false)"/.test(chunk.match(/<w:b[^>]*\/>/)?.[0] || "")) a.b = true;
      if (/<w:i\/>|<w:i[\s>]/.test(chunk) && !/w:val="(?:0|false)"/.test(chunk.match(/<w:i[^>]*\/>/)?.[0] || "")) a.i = true;
      if (/<w:u[\s/>]/.test(chunk)) a.u = true;
      if (/<w:strike[\s/>]/.test(chunk)) a.strike = true;
      if (/superscript/.test(chunk)) a.sup = true;
      if (/subscript/.test(chunk)) a.sub = true;
      const text = [...chunk.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1])).join("");
      if (text) runs.push(Object.keys(a).length ? { text, a } : { text });
    }
    if (runs.length || /<w:pStyle/.test(body)) paras.push({ para, runs });
  }
  return buildDoc(paras);
}

function odtXml(doc: Doc): string {
  const ps = parasOf(doc)
    .map((para) => {
      if (para.runs.length === 1 && para.runs[0].text === "\f") return `<text:p text:style-name="PageBreak"/>`;
      const style = headingOf(para.para.h).replace("Heading", "Heading_20_");
      const name = style || "Text";
      const inner = para.runs
        .map((run) => {
          const styleName = run.a?.b ? "Bold" : run.a?.i ? "Italic" : run.a?.u ? "Underline" : run.a?.strike ? "Strike" : "";
          const t = xml(run.text);
          return styleName ? `<text:span text:style-name="${styleName}">${t}</text:span>` : t;
        })
        .join("");
      return `<text:p text:style-name="${name}">${inner}</text:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text>${ps}</office:text></office:body></office:document-content>`;
}

const ODT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:styles>
<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
<style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
<style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="Strike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
</office:styles></office:document-styles>`;

const ODT_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;

export async function toOdt(doc: Doc): Promise<Uint8Array> {
  const u = (s: string) => enc.encode(s);
  return zipFiles([
    { name: "mimetype", data: u("application/vnd.oasis.opendocument.text"), store: true },
    { name: "content.xml", data: u(odtXml(doc)) },
    { name: "styles.xml", data: u(ODT_STYLES) },
    { name: "META-INF/manifest.xml", data: u(ODT_MANIFEST) },
  ]);
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function toPdf(doc: Doc, title: string): Uint8Array {
  const lines: string[] = [];
  for (const para of parasOf(doc)) {
    const text = para.runs.map((r) => r.text).join("").replace(/\t/g, "    ");
    const prefix = para.para.list === "bullet" ? "• " : para.para.list === "numbered" ? "1. " : para.para.list === "check" ? "☐ " : "";
    const full = prefix + text;
    for (let i = 0; i < full.length || i === 0; i += 90) lines.push(full.slice(i, i + 90) || "");
    if (!full) lines.push("");
  }
  if (title) lines.unshift(title, "");
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += 46) pages.push(lines.slice(i, i + 46));
  const objects: string[] = [];
  const kids: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjs: number[] = [];
  const fontObj = 3 + pages.length * 2;
  for (let p = 0; p < pages.length; p++) {
    const pageId = 3 + p * 2;
    const contentId = pageId + 1;
    pageObjs.push(pageId);
    kids.push(`${pageId} 0 R`);
    const cmds = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"];
    pages[p].forEach((line, idx) => {
      const safe = pdfEscape([...line].map((ch) => (ch.charCodeAt(0) < 128 ? ch : "?")).join(""));
      cmds.push(idx === 0 ? `(${safe}) Tj` : `T* (${safe}) Tj`);
    });
    cmds.push("ET");
    const stream = cmds.join("\n");
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`;
    objects[contentId - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  objects[fontObj - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets[i] = body.length;
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc.encode(body);
}

export function bytesToBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
