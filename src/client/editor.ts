import { commandsToDelta, deltaToCommands, type Command } from "../shared/commands.ts";
import { type Attrs, type Delta, compose, isBreak, transformPosition } from "../shared/delta.ts";
import {
  type CharStyle,
  type Doc,
  type Heading,
  type Align,
  type ListKind,
  insertedLength,
  paraBounds,
  paragraphStyle,
  plainText,
  restoreDoc,
  splice,
  type Snapshot,
} from "../shared/doc.ts";
import { ClientSync } from "../shared/engine.ts";
import { caretBox, drawPage, hitTest, layoutDoc, PAGE_GAP, PAGE_H, PAGE_W, RULER_H, type Layout } from "./layout.ts";
import { clipboardToDelta } from "./paste.ts";

export interface RemoteCaret {
  sid: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export interface EditorHooks {
  onOutbound: () => void;
  onChange: () => void;
  onSelection: () => void;
}

const TEXT_KEYS = ["b", "i", "u", "font", "size", "color"] as const;

export class Editor {
  sync: ClientSync;
  anchor = 0;
  head = 0;
  remotes = new Map<string, RemoteCaret>();
  typing: CharStyle = {};
  color: string;
  ready = false;
  hooks: EditorHooks;
  pagesEl: HTMLElement;
  overlay: HTMLElement;
  input: HTMLElement;
  localCaret: HTMLElement;
  layout: Layout = { lines: [], pages: 1 };
  measure: CanvasRenderingContext2D;
  zoom = 1;
  private composing = false;
  private ignoreInput = false;
  private dragging = false;
  private raf = 0;

  constructor(sid: string, pagesEl: HTMLElement, overlay: HTMLElement, input: HTMLElement, color: string, hooks: EditorHooks) {
    this.sync = new ClientSync(sid);
    this.pagesEl = pagesEl;
    this.overlay = overlay;
    this.input = input;
    this.color = color;
    this.hooks = hooks;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    this.measure = ctx;
    this.localCaret = document.createElement("div");
    this.localCaret.className = "local-caret";
    this.overlay.appendChild(this.localCaret);
    this.bindInput();
    this.bindPointer();
    this.render();
  }

  get doc(): Doc {
    return this.sync.doc;
  }

  getText(): string {
    return plainText(this.doc);
  }

  dirty(): boolean {
    return !!(this.sync.inflight || this.sync.pending || this.sync.outbound);
  }

  load(snapshot: Snapshot, rev: number): void {
    this.sync.reset(restoreDoc(snapshot), rev);
    this.anchor = 0;
    this.head = 0;
    this.remotes.clear();
    this.sampleTyping();
    this.ready = true;
    this.paint();
  }

  setRemote(c: RemoteCaret): void {
    if (c.sid === this.sync.sid) return;
    this.remotes.set(c.sid, c);
    this.render();
  }

  removeRemote(sid: string): void {
    this.remotes.delete(sid);
    this.render();
  }

  applyRemote(delta: Delta, sid: string, rev: number, reqId?: number): void {
    const applied = this.sync.ingestRemote(delta, sid, rev, reqId);
    if (applied) {
      this.shiftOwn(applied);
      this.shiftRemotes(applied);
    }
    this.clampCarets();
    this.hooks.onOutbound();
    this.hooks.onChange();
    this.render();
  }

  ack(reqId: number, assigned: number | null, serverRev: number): void {
    this.sync.ack(reqId, assigned, serverRev);
    this.hooks.onOutbound();
    this.hooks.onChange();
  }

  focus(): void {
    this.input.focus();
  }

  setSelection(anchor: number, head: number): void {
    this.anchor = this.clamp(anchor);
    this.head = this.clamp(head);
    this.sampleTyping();
    this.focus();
    this.render();
    this.hooks.onSelection();
  }

  undo(): void {
    if (!this.sync.undo()) return;
    if (this.sync.lastDelta) this.shiftOwn(this.sync.lastDelta);
    this.clampCarets();
    this.sampleTyping();
    this.afterEdit();
  }

  redo(): void {
    if (!this.sync.redo()) return;
    if (this.sync.lastDelta) this.shiftOwn(this.sync.lastDelta);
    this.clampCarets();
    this.sampleTyping();
    this.afterEdit();
  }

  insertText(text: string): void {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    if (!text) {
      if (lo !== hi) this.deleteRange(lo, hi);
      return;
    }
    const ops = this.opsForString(text);
    const delta = splice(lo, hi, ops, this.doc.text.length);
    this.sync.local(delta);
    const at = this.clamp(lo + insertedLength(ops));
    this.anchor = at;
    this.head = at;
    this.sampleTyping();
    this.afterEdit();
  }

  paste(html: string, plain: string): void {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    const delta = clipboardToDelta(html, plain, lo, hi, this.doc.text.length);
    this.sync.local(delta);
    const at = this.clamp(lo + insertedLength(delta.ops));
    this.anchor = at;
    this.head = at;
    this.sampleTyping();
    this.afterEdit();
  }

  toggleMark(key: "b" | "i" | "u"): void {
    if (this.anchor === this.head) {
      if (this.typing[key]) delete this.typing[key];
      else this.typing[key] = true;
      this.hooks.onChange();
      return;
    }
    const on = this.rangeAll(key);
    this.applyText({ [key]: on ? null : true });
  }

  setTextAttr(attrs: Attrs): void {
    if (this.anchor === this.head) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) delete (this.typing as Record<string, unknown>)[k];
        else (this.typing as Record<string, unknown>)[k] = v;
      }
      this.hooks.onChange();
      return;
    }
    this.applyText(attrs);
  }

  setParagraph(patch: Attrs): void {
    const indices = this.paragraphBreaks();
    if (!indices.length) return;
    const delta = this.patchIndices(indices, patch);
    this.sync.local(delta);
    this.sampleTyping();
    this.afterEdit();
  }

  setHeading(h: Heading): void {
    this.setParagraph({ h, size: null });
  }

  setAlign(align: Align): void {
    this.setParagraph({ align });
  }

  toggleList(kind: ListKind): void {
    const para = paragraphStyle(this.doc, this.head);
    if (para.list === kind) this.setParagraph({ list: null, lv: null });
    else this.setParagraph({ list: kind, lv: para.lv || 0 });
  }

  clearFormatting(): void {
    if (this.anchor !== this.head) {
      this.applyText({ b: null, i: null, u: null, font: null, size: null, color: null });
    }
    this.setParagraph({ h: "normal", align: "left", list: null, lv: null });
    this.typing = {};
  }

  selectAll(): void {
    this.setSelection(0, Math.max(0, this.doc.text.length - 1));
  }

  selectedPlain(): string {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    return this.doc.text.slice(lo, hi);
  }

  selectedHtml(): string {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    let html = "";
    for (let i = lo; i < hi; i++) {
      const ch = this.doc.text[i];
      if (ch === "\n" || ch === "\f") {
        html += "<br>";
        continue;
      }
      const st = this.doc.styles[i] || {};
      let piece = escapeHtml(ch);
      if (st.b) piece = `<b>${piece}</b>`;
      if (st.i) piece = `<i>${piece}</i>`;
      if (st.u) piece = `<u>${piece}</u>`;
      html += piece;
    }
    return html;
  }

  markState(): { b: boolean; i: boolean; u: boolean; font: string; size: number; heading: Heading; align: Align; list: ListKind | "" } {
    const para = paragraphStyle(this.doc, this.head);
    const collapsed = this.anchor === this.head;
    const probe = collapsed ? this.typing : this.doc.styles[Math.min(this.anchor, this.doc.text.length - 1)] || {};
    const heading = (para.h || "normal") as Heading;
    const size = (collapsed ? this.typing.size : probe.size) || headPt(heading);
    return {
      b: collapsed ? !!this.typing.b : this.rangeAll("b"),
      i: collapsed ? !!this.typing.i : this.rangeAll("i"),
      u: collapsed ? !!this.typing.u : this.rangeAll("u"),
      font: (collapsed ? this.typing.font : probe.font) || "Open Sans",
      size,
      heading,
      align: para.align || "left",
      list: para.list || "",
    };
  }

  render(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private paint(): void {
    const doc = this.doc;
    this.layout = layoutDoc(doc, this.measure);
    const pages = this.layout.pages;
    while (this.pagesEl.childElementCount < pages) {
      const page = document.createElement("div");
      page.className = "page";
      const canvas = document.createElement("canvas");
      page.appendChild(canvas);
      this.pagesEl.appendChild(page);
    }
    while (this.pagesEl.childElementCount > pages) this.pagesEl.lastElementChild?.remove();
    const dpr = window.devicePixelRatio || 1;
    const ranges = this.selectionRanges();
    for (let p = 0; p < pages; p++) {
      const page = this.pagesEl.children[p] as HTMLElement;
      page.dataset.page = String(p);
      page.style.width = PAGE_W + "px";
      page.style.height = PAGE_H + "px";
      const canvas = page.querySelector("canvas") as HTMLCanvasElement;
      canvas.width = Math.floor(PAGE_W * dpr);
      canvas.height = Math.floor(PAGE_H * dpr);
      canvas.style.width = PAGE_W + "px";
      canvas.style.height = PAGE_H + "px";
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPage(ctx, doc, this.layout, p, ranges);
    }
    this.placeCarets();
  }

  private selectionRanges(): { start: number; end: number; color: string }[] {
    const ranges: { start: number; end: number; color: string }[] = [];
    if (this.anchor !== this.head) {
      ranges.push({ start: Math.min(this.anchor, this.head), end: Math.max(this.anchor, this.head), color: "rgba(26,115,232,0.28)" });
    }
    for (const remote of this.remotes.values()) {
      if (remote.anchor === remote.head) continue;
      ranges.push({
        start: Math.min(remote.anchor, remote.head),
        end: Math.max(remote.anchor, remote.head),
        color: hexAlpha(remote.color, 0.28),
      });
    }
    return ranges;
  }

  private placeCarets(): void {
    const local = caretBox(this.layout, this.head);
    this.localCaret.style.left = local.x + "px";
    this.localCaret.style.top = stackTop(local.page, local.y) + "px";
    this.localCaret.style.height = local.h + "px";
    this.localCaret.style.background = this.color;
    for (const el of [...this.overlay.querySelectorAll(".remote-caret")]) el.remove();
    for (const remote of this.remotes.values()) {
      const box = caretBox(this.layout, this.clamp(remote.head));
      const flag = document.createElement("div");
      flag.className = "remote-caret";
      flag.style.left = box.x + "px";
      flag.style.top = stackTop(box.page, box.y) + "px";
      flag.style.height = box.h + "px";
      flag.style.background = remote.color;
      const name = document.createElement("div");
      name.className = "remote-flag";
      name.textContent = remote.name || "Guest";
      name.style.background = remote.color;
      flag.appendChild(name);
      if (remote.anchor !== remote.head) flag.dataset.selection = "1";
      this.overlay.appendChild(flag);
    }
  }

  private bindInput(): void {
    const input = this.input;
    input.addEventListener("keydown", (ev) => this.onKey(ev as KeyboardEvent));
    input.addEventListener("input", () => {
      if (this.ignoreInput || this.composing) return;
      const text = input.textContent || "";
      if (!text) return;
      this.ignoreInput = true;
      input.textContent = "";
      this.ignoreInput = false;
      this.insertText(text);
    });
    input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    input.addEventListener("compositionend", (ev) => {
      this.composing = false;
      const text = (ev as CompositionEvent).data || input.textContent || "";
      this.ignoreInput = true;
      input.textContent = "";
      this.ignoreInput = false;
      if (text) this.insertText(text);
    });
    input.addEventListener("paste", (ev) => {
      const e = ev as ClipboardEvent;
      e.preventDefault();
      const html = e.clipboardData?.getData("text/html") || "";
      const plain = e.clipboardData?.getData("text/plain") || "";
      this.paste(html, plain);
    });
    input.addEventListener("copy", (ev) => this.onCopy(ev as ClipboardEvent, false));
    input.addEventListener("cut", (ev) => this.onCopy(ev as ClipboardEvent, true));
  }

  private bindPointer(): void {
    this.pagesEl.addEventListener("mousedown", (ev) => {
      if ((ev as MouseEvent).button !== 0) return;
      const pageEl = (ev.target as HTMLElement).closest(".page") as HTMLElement | null;
      if (!pageEl) return;
      ev.preventDefault();
      this.focus();
      const page = Number(pageEl.dataset.page || 0);
      const idx = this.indexFromEvent(ev as MouseEvent, pageEl, page);
      if ((ev as MouseEvent).detail >= 3) {
        const b = paraBounds(this.doc, idx);
        this.anchor = b.start;
        this.head = b.end;
      } else if ((ev as MouseEvent).detail === 2) {
        const [a, b] = wordBounds(this.doc, idx);
        this.anchor = a;
        this.head = b;
      } else if ((ev as MouseEvent).shiftKey) {
        this.head = idx;
      } else {
        this.anchor = idx;
        this.head = idx;
      }
      this.dragging = (ev as MouseEvent).detail === 1;
      this.sampleTyping();
      this.render();
      this.hooks.onSelection();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!this.dragging) return;
      const pageEl = this.pageFromPoint(ev.clientX, ev.clientY);
      if (!pageEl) return;
      const page = Number(pageEl.dataset.page || 0);
      this.head = this.indexFromEvent(ev, pageEl, page);
      this.render();
    });
    window.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.hooks.onSelection();
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing || this.composing) return;
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (meta && key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (meta && key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (meta && key.toLowerCase() === "a") {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && key.toLowerCase() === "b") {
      e.preventDefault();
      this.toggleMark("b");
      return;
    }
    if (meta && key.toLowerCase() === "i") {
      e.preventDefault();
      this.toggleMark("i");
      return;
    }
    if (meta && key.toLowerCase() === "u") {
      e.preventDefault();
      this.toggleMark("u");
      return;
    }
    if (key === "Backspace") {
      e.preventDefault();
      this.backspace();
      return;
    }
    if (key === "Delete") {
      e.preventDefault();
      this.delKey();
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      this.insertParagraphBreak();
      return;
    }
    if (key === "Tab") {
      e.preventDefault();
      this.insertText("\t");
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") {
      e.preventDefault();
      this.move(key, e.shiftKey, meta);
    }
  }

  private move(key: string, shift: boolean, meta: boolean): void {
    const doc = this.doc;
    let next = this.head;
    if (key === "ArrowLeft") next = meta ? wordBounds(doc, Math.max(0, this.head - 1))[0] : Math.max(0, this.head - 1);
    else if (key === "ArrowRight") next = meta ? wordBounds(doc, this.head)[1] : Math.min(doc.text.length - 1, this.head + 1);
    else if (key === "Home") next = paraBounds(doc, this.head).start;
    else if (key === "End") next = paraBounds(doc, this.head).end;
    else if (key === "ArrowUp" || key === "ArrowDown") {
      const box = caretBox(this.layout, this.head);
      const y = key === "ArrowUp" ? box.y - 4 : box.y + box.h + 4;
      let page = box.page;
      if (y < 0 && page > 0) page -= 1;
      if (y > PAGE_H && page < this.layout.pages - 1) page += 1;
      const pageEl = this.pagesEl.children[page] as HTMLElement | undefined;
      if (pageEl) {
        const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const scale = rect.height / PAGE_H || 1;
        const clientY = rect.top + (key === "ArrowUp" ? Math.max(0, y) : Math.min(PAGE_H - 1, y)) * scale;
        next = this.indexFromEvent({ clientX: rect.left + box.x * (rect.width / PAGE_W), clientY } as MouseEvent, pageEl, page);
      }
    }
    next = this.clamp(next);
    if (shift) this.head = next;
    else {
      this.anchor = next;
      this.head = next;
    }
    this.sampleTyping();
    this.render();
    this.hooks.onSelection();
  }

  private backspace(): void {
    if (this.anchor !== this.head) {
      this.deleteRange(Math.min(this.anchor, this.head), Math.max(this.anchor, this.head));
      return;
    }
    if (this.head === 0) {
      const para = paragraphStyle(this.doc, 0);
      if (para.list) this.setParagraph({ list: null, lv: null });
      return;
    }
    const bounds = paraBounds(this.doc, this.head);
    if (this.head === bounds.start && paragraphStyle(this.doc, this.head).list && bounds.start === bounds.end) {
      this.setParagraph({ list: null, lv: null });
      return;
    }
    this.deleteRange(this.head - 1, this.head);
  }

  private delKey(): void {
    if (this.anchor !== this.head) {
      this.deleteRange(Math.min(this.anchor, this.head), Math.max(this.anchor, this.head));
      return;
    }
    if (this.head >= this.doc.text.length - 1) return;
    this.deleteRange(this.head, this.head + 1);
  }

  private deleteRange(start: number, end: number): void {
    const delta = splice(start, end, [], this.doc.text.length);
    this.sync.local(delta);
    const at = this.clamp(start);
    this.anchor = at;
    this.head = at;
    this.sampleTyping();
    this.afterEdit();
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.anchor === this.head) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", this.selectedPlain());
    e.clipboardData?.setData("text/html", this.selectedHtml());
    if (cut) this.deleteRange(Math.min(this.anchor, this.head), Math.max(this.anchor, this.head));
  }

  private afterEdit(): void {
    if (this.sync.lastDelta) this.shiftRemotes(this.sync.lastDelta);
    this.clampCarets();
    this.hooks.onOutbound();
    this.hooks.onChange();
    this.hooks.onSelection();
    this.render();
  }

  /** Enter keeps the heading on the first half and starts the next paragraph in normal text. */
  insertParagraphBreak(): void {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    const para = paragraphStyle(this.doc, lo);
    const end = paraBounds(this.doc, lo).end;
    let delta = splice(lo, hi, [{ t: "i", s: "\n", a: this.paraAttrs() }], this.doc.text.length);
    if (para.h && para.h !== "normal" && end >= hi) {
      const newBreak = end - (hi - lo) + 1;
      const patch: Delta = { ops: [] };
      if (newBreak > 0) patch.ops.push({ t: "r", n: newBreak });
      patch.ops.push({ t: "r", n: 1, a: { h: "normal" } });
      delta = compose(delta, patch);
    }
    this.sync.local(delta);
    const at = this.clamp(lo + 1);
    this.anchor = at;
    this.head = at;
    this.sampleTyping();
    this.afterEdit();
  }

  private opsForString(text: string): { t: "i"; s: string; a?: Attrs }[] {
    const para = this.paraAttrs();
    const textAttrs = this.textAttrs();
    const parts = text.split(/(\n|\f)/);
    const ops: { t: "i"; s: string; a?: Attrs }[] = [];
    for (const part of parts) {
      if (!part) continue;
      if (part === "\n" || part === "\f") ops.push({ t: "i", s: part, a: para });
      else ops.push(Object.keys(textAttrs).length ? { t: "i", s: part, a: textAttrs } : { t: "i", s: part });
    }
    return ops;
  }

  private textAttrs(): Attrs {
    const attrs: Attrs = {};
    for (const k of TEXT_KEYS) {
      const v = (this.typing as Record<string, unknown>)[k];
      if (v != null) attrs[k] = v as string | number | boolean;
    }
    return attrs;
  }

  private paraAttrs(): Attrs {
    const para = paragraphStyle(this.doc, this.head);
    const attrs: Attrs = { h: para.h || "normal", align: para.align || "left" };
    if (para.list) attrs.list = para.list;
    if (para.lv) attrs.lv = para.lv;
    return attrs;
  }

  private applyText(attrs: Attrs): void {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    if (hi <= lo) return;
    const ops = [];
    if (lo > 0) ops.push({ t: "r" as const, n: lo });
    ops.push({ t: "r" as const, n: hi - lo, a: attrs });
    this.sync.local({ ops });
    this.afterEdit();
  }

  private paragraphBreaks(): number[] {
    const doc = this.doc;
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    const out: number[] = [];
    let p = lo;
    const last = hi === lo ? lo : hi - 1;
    while (p <= last && p < doc.text.length) {
      const b = paraBounds(doc, p);
      out.push(b.end);
      if (b.end >= doc.text.length - 1) break;
      p = b.end + 1;
    }
    return out;
  }

  private patchIndices(indices: number[], attrs: Attrs): Delta {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const ops = [];
    let cursor = 0;
    for (const i of sorted) {
      if (i < cursor || i >= this.doc.text.length) continue;
      if (i > cursor) ops.push({ t: "r" as const, n: i - cursor });
      ops.push({ t: "r" as const, n: 1, a: attrs });
      cursor = i + 1;
    }
    return { ops };
  }

  private rangeAll(key: "b" | "i" | "u"): boolean {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    let any = false;
    for (let i = lo; i < hi; i++) {
      if (isBreak(this.doc.text[i])) continue;
      any = true;
      if (!this.doc.styles[i]?.[key]) return false;
    }
    return any;
  }

  private sampleTyping(): void {
    if (this.anchor !== this.head) return;
    const doc = this.doc;
    let i = Math.max(0, this.head - 1);
    if (isBreak(doc.text[i]) && this.head < doc.text.length - 1 && !isBreak(doc.text[this.head])) i = this.head;
    const st = doc.styles[i] || {};
    const para = paragraphStyle(doc, this.head);
    const next: CharStyle = {};
    if (!isBreak(doc.text[i])) {
      if (st.b) next.b = true;
      if (st.i) next.i = true;
      if (st.u) next.u = true;
      if (st.font) next.font = st.font;
      if (st.size) next.size = st.size;
      if (st.color) next.color = st.color;
    }
    next.h = para.h;
    next.align = para.align;
    next.list = para.list;
    next.lv = para.lv;
    this.typing = next;
  }

  private shiftOwn(delta: Delta): void {
    if (this.anchor === this.head) {
      const next = transformPosition(delta, this.head, true);
      this.anchor = next;
      this.head = next;
      return;
    }
    this.anchor = transformPosition(delta, this.anchor, this.anchor > this.head);
    this.head = transformPosition(delta, this.head, this.head >= this.anchor);
  }

  private shiftRemotes(delta: Delta): void {
    for (const remote of this.remotes.values()) {
      remote.anchor = transformPosition(delta, remote.anchor, false);
      remote.head = transformPosition(delta, remote.head, false);
    }
  }

  private clamp(i: number): number {
    return Math.max(0, Math.min(i, Math.max(0, this.doc.text.length - 1)));
  }

  private clampCarets(): void {
    this.anchor = this.clamp(this.anchor);
    this.head = this.clamp(this.head);
    for (const remote of this.remotes.values()) {
      remote.anchor = this.clamp(remote.anchor);
      remote.head = this.clamp(remote.head);
    }
  }

  private indexFromEvent(ev: MouseEvent, pageEl: HTMLElement, page: number): number {
    const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * PAGE_W;
    const y = ((ev.clientY - rect.top) / rect.height) * PAGE_H;
    return this.clamp(hitTest(this.doc, this.layout, page, x, y));
  }

  private pageFromPoint(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y);
    return (el?.closest(".page") as HTMLElement) || null;
  }
}

function stackTop(page: number, y: number): number {
  return RULER_H + page * (PAGE_H + PAGE_GAP) + y;
}

function headPt(h: Heading): number {
  return { title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14, normal: 11 }[h] || 11;
}

function wordBounds(doc: Doc, index: number): [number, number] {
  const isWord = (ch: string) => !!ch && !isBreak(ch) && !/\s/.test(ch);
  let a = Math.max(0, Math.min(index, doc.text.length - 1));
  let b = a;
  if (!isWord(doc.text[a]) && a > 0 && isWord(doc.text[a - 1])) a -= 1;
  while (a > 0 && isWord(doc.text[a - 1])) a--;
  while (b < doc.text.length - 1 && isWord(doc.text[b])) b++;
  return [a, b];
}

function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function escapeHtml(ch: string): string {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  return ch;
}

export function encodeCommands(delta: Delta): Command[] {
  return deltaToCommands(delta);
}

export function decodeCommands(commands: Command[]): Delta {
  return commandsToDelta(commands);
}
