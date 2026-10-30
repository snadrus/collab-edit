import { commandsToDelta, deltaToCommands, type Command } from "../shared/commands.ts";
import { type Attrs, type Delta, CELL, EMBED, compose, isBreak, transformPosition } from "../shared/delta.ts";
import {
  type CharStyle,
  type Doc,
  type Heading,
  type Align,
  type ListKind,
  chipLabel,
  insertedLength,
  paraBounds,
  paragraphStyle,
  plainText,
  restoreDoc,
  splice,
  voteMap,
  type Snapshot,
} from "../shared/doc.ts";
import { ClientSync } from "../shared/engine.ts";
import { hexAlpha } from "../shared/palette.ts";
import { type Thread } from "../shared/threads.ts";
import { addColumnDelta, addRowDelta, insertTableDelta, removeColumnDelta, removeRowDelta, tableAt, tableRowAt } from "../shared/table.ts";
import { caretBox, drawPage, hitTest, layoutDoc, markerHit, onNeedPaint, PAGE_GAP, PAGE_H, PAGE_W, RULER_H, stackOffset, type Layout } from "./layout.ts";
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
  onCommand?: (name: string) => void;
  onAt?: (query: string | null) => void;
  atKey?: (e: KeyboardEvent) => boolean;
  onEmbed?: (index: number) => void;
  onPaint?: () => void;
}

const TYPE_KEYS = ["b", "i", "u", "strike", "sup", "sub", "font", "size", "color", "hl"] as const;
type MarkKey = "b" | "i" | "u" | "strike" | "sup" | "sub";
const SIZES = [8, 9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

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
  name = "Guest";
  threads: Thread[] = [];
  formatPaint: Attrs | null = null;
  atMark: number | null = null;
  findQuery = "";
  findIndex = 0;
  findMatches: { start: number; end: number }[] = [];
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
    onNeedPaint(() => this.render());
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
    const opening = text === "@" && this.atMark == null;
    this.sync.local(delta);
    const at = this.clamp(lo + insertedLength(ops));
    this.anchor = at;
    this.head = at;
    if (opening) this.atMark = lo;
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

  toggleMark(key: MarkKey): void {
    const other = key === "sup" ? "sub" : key === "sub" ? "sup" : null;
    if (this.anchor === this.head) {
      if (this.typing[key]) delete this.typing[key];
      else {
        this.typing[key] = true;
        if (other) delete this.typing[other];
      }
      this.hooks.onChange();
      return;
    }
    const on = this.rangeAll(key);
    const patch: Attrs = { [key]: on ? null : true };
    if (other && !on) patch[other] = null;
    this.applyText(patch);
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
    const wipe: Attrs = { b: null, i: null, u: null, strike: null, sup: null, sub: null, font: null, size: null, color: null, hl: null, link: null };
    if (this.anchor !== this.head) this.applyText(wipe);
    this.setParagraph({ h: "normal", align: "left", list: null, lv: null, lh: null, ind: null, hr: null, check: null });
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

  markState(): {
    b: boolean;
    i: boolean;
    u: boolean;
    strike: boolean;
    sup: boolean;
    sub: boolean;
    font: string;
    size: number;
    heading: Heading;
    align: Align;
    list: ListKind | "";
    lh: number;
    hl: string;
  } {
    const para = paragraphStyle(this.doc, this.head);
    const collapsed = this.anchor === this.head;
    const probe = collapsed ? this.typing : this.doc.styles[Math.min(this.anchor, this.doc.text.length - 1)] || {};
    const heading = (para.h || "normal") as Heading;
    const size = (collapsed ? this.typing.size : probe.size) || headPt(heading);
    return {
      b: collapsed ? !!this.typing.b : this.rangeAll("b"),
      i: collapsed ? !!this.typing.i : this.rangeAll("i"),
      u: collapsed ? !!this.typing.u : this.rangeAll("u"),
      strike: collapsed ? !!this.typing.strike : this.rangeAll("strike"),
      sup: collapsed ? !!this.typing.sup : this.rangeAll("sup"),
      sub: collapsed ? !!this.typing.sub : this.rangeAll("sub"),
      font: (collapsed ? this.typing.font : probe.font) || "Open Sans",
      size,
      heading,
      align: para.align || "left",
      list: para.list || "",
      lh: para.lh || 1.15,
      hl: (typeof probe.hl === "string" ? probe.hl : "") || "",
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
      drawPage(ctx, doc, this.layout, p, ranges, this.colorMap());
    }
    this.placeCarets();
    this.hooks.onPaint?.();
  }

  private colorMap(): Record<string, string> {
    const colors: Record<string, string> = { [this.sync.sid]: this.color };
    for (const remote of this.remotes.values()) colors[remote.sid] = remote.color;
    for (const thread of this.threads) colors[thread.sid] = thread.color;
    return colors;
  }

  private selectionRanges(): { start: number; end: number; color: string }[] {
    const ranges: { start: number; end: number; color: string }[] = [];
    this.findMatches.forEach((m, n) => {
      ranges.push({ start: m.start, end: m.end, color: n === this.findIndex ? "rgba(255,167,38,0.55)" : "rgba(255,235,59,0.45)" });
    });
    for (const thread of this.threads) {
      if (thread.resolved) continue;
      for (const span of this.commentSpans(thread.id)) {
        ranges.push({ start: span.start, end: span.end, color: hexAlpha(thread.color, 0.28) });
      }
    }
    for (const remote of this.remotes.values()) {
      if (remote.anchor === remote.head) continue;
      ranges.push({
        start: Math.min(remote.anchor, remote.head),
        end: Math.max(remote.anchor, remote.head),
        color: hexAlpha(remote.color, 0.28),
      });
    }
    if (this.anchor !== this.head) {
      ranges.push({ start: Math.min(this.anchor, this.head), end: Math.max(this.anchor, this.head), color: hexAlpha(this.color, 0.28) });
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
      const point = this.pointFromEvent(ev as MouseEvent, pageEl);
      const marker = markerHit(this.layout, page, point.x, point.y);
      if (marker != null && paragraphStyle(this.doc, marker).list === "check") {
        this.toggleCheck(marker);
        return;
      }
      const idx = this.clamp(hitTest(this.doc, this.layout, page, point.x, point.y));
      const st = this.doc.styles[idx];
      if (this.doc.text[idx] === EMBED && st?.embed === "vote") {
        this.toggleVote(idx);
        return;
      }
      if (this.doc.text[idx] === EMBED && st?.embed === "drop") {
        this.anchor = idx;
        this.head = idx;
        this.render();
        this.hooks.onEmbed?.(idx);
        return;
      }
      if (((ev as MouseEvent).metaKey || (ev as MouseEvent).ctrlKey) && st?.link) {
        window.open(st.link, "_blank", "noopener");
        return;
      }
      if (this.atMark != null) this.closeAt();
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
      if (this.formatPaint && this.anchor !== this.head) {
        this.applyText(this.formatPaint);
        this.formatPaint = null;
        this.hooks.onChange();
      }
      this.hooks.onSelection();
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing || this.composing) return;
    if (this.atMark != null && this.hooks.atKey?.(e)) {
      e.preventDefault();
      return;
    }
    if (this.handleShortcut(e)) return;
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
      const para = paragraphStyle(this.doc, this.head);
      if (tableRowAt(this.doc, this.head)) this.moveCell(e.shiftKey ? -1 : 1);
      else if (para.list) this.indent(e.shiftKey ? -1 : 1);
      else this.insertText("\t");
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
    this.syncAt();
    this.hooks.onOutbound();
    this.hooks.onChange();
    this.hooks.onSelection();
    this.render();
  }

  /** Enter keeps the heading on the first half and starts the next paragraph in normal text. */
  insertParagraphBreak(): void {
    if (tableRowAt(this.doc, this.head)) {
      this.addRow();
      return;
    }
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
    for (const k of TYPE_KEYS) {
      const v = (this.typing as Record<string, unknown>)[k];
      if (v != null) attrs[k] = v as string | number | boolean;
    }
    if (this.head > 0) {
      const prev = this.doc.styles[this.head - 1]?.cmt;
      const here = this.doc.styles[this.head]?.cmt;
      if (prev && prev === here) attrs.cmt = prev;
    }
    return attrs;
  }

  private paraAttrs(): Attrs {
    const para = paragraphStyle(this.doc, this.head);
    const attrs: Attrs = { h: para.h || "normal", align: para.align || "left" };
    if (para.list) attrs.list = para.list;
    if (para.lv) attrs.lv = para.lv;
    if (para.ind) attrs.ind = para.ind;
    if (para.lh) attrs.lh = para.lh;
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

  private rangeAll(key: MarkKey): boolean {
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
    if (!isBreak(doc.text[i]) && doc.text[i] !== EMBED) {
      if (st.b) next.b = true;
      if (st.i) next.i = true;
      if (st.u) next.u = true;
      if (st.strike) next.strike = true;
      if (st.sup) next.sup = true;
      if (st.sub) next.sub = true;
      if (st.font) next.font = st.font;
      if (st.size) next.size = st.size;
      if (st.color) next.color = st.color;
      if (st.hl) next.hl = st.hl;
    }
    next.h = para.h;
    next.align = para.align;
    next.list = para.list;
    next.lv = para.lv;
    next.ind = para.ind;
    next.lh = para.lh;
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

  private pointFromEvent(ev: MouseEvent, pageEl: HTMLElement): { x: number; y: number } {
    const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - rect.left) / rect.width) * PAGE_W, y: ((ev.clientY - rect.top) / rect.height) * PAGE_H };
  }

  private indexFromEvent(ev: MouseEvent, pageEl: HTMLElement, page: number): number {
    const point = this.pointFromEvent(ev, pageEl);
    return this.clamp(hitTest(this.doc, this.layout, page, point.x, point.y));
  }

  private pageFromPoint(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y);
    return (el?.closest(".page") as HTMLElement) || null;
  }

  selectionPoint(): { x: number; y: number; h: number; collapsed: boolean } {
    const box = caretBox(this.layout, this.head);
    return { x: box.x, y: stackOffset(box.page, box.y), h: box.h, collapsed: this.anchor === this.head };
  }

  anchorPoint(index: number): { y: number } {
    const box = caretBox(this.layout, this.clamp(index));
    return { y: stackOffset(box.page, box.y) };
  }

  commentSpans(id?: string): { id: string; start: number; end: number }[] {
    const spans: { id: string; start: number; end: number }[] = [];
    let i = 0;
    const doc = this.doc;
    while (i < doc.text.length) {
      const mark = doc.styles[i]?.cmt;
      if (!mark || (id && mark !== id) || isBreak(doc.text[i])) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < doc.text.length && doc.styles[j]?.cmt === mark) j++;
      spans.push({ id: mark, start: i, end: j });
      i = j;
    }
    return spans;
  }

  setThreads(list: Thread[]): void {
    this.threads = list;
    this.render();
  }

  upsertThread(thread: Thread): void {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
    this.render();
  }

  addCommentMark(id: string): string | null {
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    if (hi <= lo) return null;
    const quote = this.doc.text.slice(lo, hi).replace(/\s+/g, " ").trim().slice(0, 240);
    this.applyText({ cmt: id });
    return quote;
  }

  inTable(): boolean {
    return !!tableRowAt(this.doc, this.head);
  }

  tableRowCount(): number {
    let n = 0;
    for (const ch of this.doc.text) if (ch === "\u001e") n++;
    return n;
  }

  insertTable(rows: number, cols: number): void {
    this.closeAt();
    const at = Math.min(this.anchor, this.head);
    const needBreak = at > 0 && !isBreak(this.doc.text[Math.min(at, this.doc.text.length - 1) - 1]);
    this.localDelta(insertTableDelta(this.doc, at, rows, cols), at + (needBreak ? 1 : 0));
  }

  addRow(): void {
    const delta = addRowDelta(this.doc, this.head);
    if (!delta) return;
    const row = tableRowAt(this.doc, this.head);
    this.localDelta(delta, row ? row.end + 1 : this.head);
  }

  removeRow(): void {
    const row = tableRowAt(this.doc, this.head);
    const delta = removeRowDelta(this.doc, this.head);
    if (!delta || !row) return;
    this.localDelta(delta, row.start);
  }

  addColumn(): void {
    const delta = addColumnDelta(this.doc, this.head);
    if (delta) this.localDelta(delta, this.head);
  }

  removeColumn(): void {
    const delta = removeColumnDelta(this.doc, this.head);
    if (delta) this.localDelta(delta, this.head);
  }

  insertRule(): void {
    this.closeAt();
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    const bounds = paraBounds(this.doc, lo);
    const para = paragraphStyle(this.doc, lo);
    if (bounds.start === bounds.end && !para.hr && !para.cols) {
      this.setParagraph({ hr: true, list: null });
      return;
    }
    const open = this.paraAttrs();
    const delta = splice(lo, hi, [
      { t: "i", s: "\n", a: open },
      { t: "i", s: "\n", a: { h: "normal", align: "left", hr: true } },
    ], this.doc.text.length);
    this.localDelta(delta, lo + 2);
  }

  insertPageBreak(): void {
    this.closeAt();
    this.insertText("\f");
  }

  insertEmbed(attrs: Attrs): void {
    this.commitQuery([{ t: "i", s: EMBED, a: attrs }]);
  }

  insertVote(emoji: string): void {
    this.insertEmbed({ embed: "vote", emoji });
  }

  insertImage(src: string, alt: string, w: number, h: number): void {
    this.insertEmbed({ embed: "img", src, alt, iw: Math.round(w), ih: Math.round(h) });
  }

  toggleVote(index: number): void {
    const st = this.doc.styles[index];
    if (!st || st.embed !== "vote") return;
    const key = "v." + this.sync.sid;
    const cur = (st as Record<string, unknown>)[key];
    this.localDelta(this.patchIndices([index], { [key]: typeof cur === "string" ? null : this.name || "Guest" }), index);
  }

  voteNames(): string[] {
    const names: string[] = [];
    for (let i = 0; i < this.doc.text.length; i++) {
      if (this.doc.styles[i]?.embed !== "vote") continue;
      names.push(...Object.values(voteMap(this.doc.styles[i])));
    }
    return names;
  }

  setDropdown(index: number, val: string): void {
    if (this.doc.styles[index]?.embed !== "drop") return;
    this.localDelta(this.patchIndices([index], { val }), index);
  }

  toggleCheck(index: number): void {
    const end = paraBounds(this.doc, index).end;
    const on = !!this.doc.styles[end]?.check;
    this.localDelta(this.patchIndices([end], { check: on ? null : true }), this.head);
  }

  indent(dir: 1 | -1): void {
    const para = paragraphStyle(this.doc, this.head);
    if (para.list) {
      const lv = para.lv || 0;
      if (dir < 0 && lv === 0) this.setParagraph({ list: null, lv: null });
      else this.setParagraph({ lv: Math.max(0, lv + dir) });
      return;
    }
    this.setParagraph({ ind: Math.max(0, Math.min(8, (para.ind || 0) + dir)) });
  }

  setLineSpacing(lh: number): void {
    this.setParagraph({ lh });
  }

  setLink(url: string | null): void {
    const value = url?.trim() || "";
    if (!value) {
      if (this.anchor !== this.head) this.applyText({ link: null });
      return;
    }
    if (this.anchor === this.head) {
      const attrs = this.textAttrs();
      attrs.link = value;
      const lo = this.head;
      this.localDelta(splice(lo, lo, [{ t: "i", s: value, a: attrs }], this.doc.text.length), lo + value.length);
      return;
    }
    this.applyText({ link: value });
  }

  currentLink(): string | null {
    const i = Math.min(this.anchor, this.head, Math.max(0, this.doc.text.length - 1));
    const link = this.doc.styles[i]?.link;
    return typeof link === "string" ? link : null;
  }

  copyFormatting(): void {
    const i = this.anchor === this.head ? Math.max(0, this.head - 1) : Math.min(this.anchor, this.head);
    const st = this.doc.styles[i] || {};
    const attrs: Attrs = {};
    for (const k of ["b", "i", "u", "strike", "sup", "sub", "font", "size", "color", "hl", "link"] as const) {
      const v = st[k];
      attrs[k] = v == null ? null : (v as string | number | boolean);
    }
    this.formatPaint = attrs;
    this.hooks.onChange();
  }

  pasteFormatting(): void {
    if (!this.formatPaint) return;
    if (this.anchor === this.head) this.setTextAttr(this.formatPaint);
    else {
      this.applyText(this.formatPaint);
      this.formatPaint = null;
    }
  }

  bumpSize(dir: number): void {
    const cur = this.markState().size;
    let i = SIZES.findIndex((s) => s >= cur);
    if (i < 0) i = SIZES.length - 1;
    if (SIZES[i] !== cur) i = dir < 0 ? Math.max(0, i - 1) : i;
    else i = Math.max(0, Math.min(SIZES.length - 1, i + dir));
    this.setTextAttr({ size: SIZES[Math.max(0, Math.min(SIZES.length - 1, i))] });
  }

  wordCount(): { words: number; characters: number; charactersNoSpaces: number; selection: boolean } {
    const selected = this.anchor !== this.head;
    const lo = Math.min(this.anchor, this.head);
    const hi = Math.max(this.anchor, this.head);
    let raw = "";
    const from = selected ? lo : 0;
    const to = selected ? hi : this.doc.text.length;
    for (let i = from; i < to; i++) {
      const ch = this.doc.text[i];
      if (ch === EMBED) raw += " " + chipLabel(this.doc.styles[i]) + " ";
      else if (ch === CELL || ch === "\f" || ch === "\u001e") raw += " ";
      else raw += ch;
    }
    const trimmed = raw.trim();
    return {
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      characters: [...raw].length,
      charactersNoSpaces: [...raw.replace(/\s/g, "")].length,
      selection: selected,
    };
  }

  setFind(query: string, index = 0): void {
    this.findQuery = query;
    this.findMatches = [];
    if (query) {
      const hay = this.doc.text.toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      while (from < hay.length) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        this.findMatches.push({ start: at, end: at + needle.length });
        from = at + Math.max(1, needle.length);
      }
    }
    this.findIndex = this.findMatches.length ? ((index % this.findMatches.length) + this.findMatches.length) % this.findMatches.length : 0;
    const m = this.findMatches[this.findIndex];
    if (m) this.setSelection(m.start, Math.min(m.end, this.doc.text.length - 1));
    else this.render();
    this.scrollHeadIntoView();
  }

  findStep(dir: number): void {
    if (!this.findMatches.length) return;
    this.setFind(this.findQuery, this.findIndex + dir);
  }

  replaceOne(repl: string): void {
    const m = this.findMatches[this.findIndex];
    if (!m) return;
    this.anchor = m.start;
    this.head = Math.min(m.end, this.doc.text.length - 1);
    this.insertText(repl);
    this.setFind(this.findQuery, this.findIndex);
  }

  replaceAll(repl: string): number {
    const matches = this.findMatches.filter((m, n) => n === 0 || m.start >= this.findMatches[n - 1].end);
    if (!matches.length) return 0;
    const ops = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start < cursor) continue;
      if (m.start > cursor) ops.push({ t: "r" as const, n: m.start - cursor });
      if (m.end > m.start) ops.push({ t: "d" as const, n: m.end - m.start });
      if (repl) ops.push({ t: "i" as const, s: repl });
      cursor = m.end;
    }
    this.sync.local({ ops });
    const count = matches.length;
    this.afterEdit();
    this.setFind(this.findQuery, 0);
    return count;
  }

  atQuery(): string | null {
    if (this.atMark == null) return null;
    if (this.head < this.atMark || this.doc.text[this.atMark] !== "@") {
      this.atMark = null;
      return null;
    }
    return this.doc.text.slice(this.atMark + 1, this.head).replace(/\n/g, "");
  }

  closeAt(): void {
    if (this.atMark == null) return;
    this.atMark = null;
    this.hooks.onAt?.(null);
  }

  commitQuery(ops: { t: "i"; s: string; a?: Attrs }[]): void {
    const start = this.atMark == null ? Math.min(this.anchor, this.head) : this.atMark;
    const end = this.atMark == null ? Math.max(this.anchor, this.head) : this.head;
    this.atMark = null;
    this.hooks.onAt?.(null);
    const delta = splice(start, end, ops, this.doc.text.length);
    this.localDelta(delta, start + insertedLength(ops));
  }

  private localDelta(delta: Delta, caret: number): void {
    this.sync.local(delta);
    const at = this.clamp(caret);
    this.anchor = at;
    this.head = at;
    this.sampleTyping();
    this.afterEdit();
  }

  private moveCell(dir: number): void {
    const rows = tableAt(this.doc, this.head);
    const row = tableRowAt(this.doc, this.head);
    if (!rows || !row) return;
    const spots: number[] = [];
    for (const item of rows) for (const cell of item.cells) spots.push(cell.start);
    let cur = 0;
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i];
      if (this.head >= cell.start && this.head <= cell.end) cur = spots.indexOf(cell.start);
    }
    const next = spots[cur + dir];
    if (next == null) return;
    this.setSelection(next, next);
  }

  private syncAt(): void {
    if (this.atMark == null) return;
    this.hooks.onAt?.(this.atQuery());
  }

  private scrollHeadIntoView(): void {
    const box = caretBox(this.layout, this.head);
    const top = stackOffset(box.page, box.y);
    const scroller = this.pagesEl.closest("#scroll") as HTMLElement | null;
    if (!scroller) return;
    if (top < scroller.scrollTop + 40 || top > scroller.scrollTop + scroller.clientHeight - 80) {
      scroller.scrollTop = Math.max(0, top - 80);
    }
  }

  private handleShortcut(e: KeyboardEvent): boolean {
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const code = e.code;
    if (meta && e.altKey && key === "m") {
      e.preventDefault();
      this.hooks.onCommand?.("comment");
      return true;
    }
    if (meta && key === "k") {
      e.preventDefault();
      this.hooks.onCommand?.("link");
      return true;
    }
    if (meta && key === "f") {
      e.preventDefault();
      this.hooks.onCommand?.("find");
      return true;
    }
    if (meta && key === "h") {
      e.preventDefault();
      this.hooks.onCommand?.("replace");
      return true;
    }
    if (meta && key === "g") {
      e.preventDefault();
      this.findStep(e.shiftKey ? -1 : 1);
      return true;
    }
    if (meta && key === "s") {
      e.preventDefault();
      this.hooks.onCommand?.("saved");
      return true;
    }
    if (meta && (key === "/" || code === "Slash")) {
      e.preventDefault();
      this.hooks.onCommand?.("shortcuts");
      return true;
    }
    if (meta && e.shiftKey && code === "Digit7") {
      e.preventDefault();
      this.toggleList("numbered");
      return true;
    }
    if (meta && e.shiftKey && code === "Digit8") {
      e.preventDefault();
      this.toggleList("bullet");
      return true;
    }
    if (meta && e.shiftKey && code === "Digit9") {
      e.preventDefault();
      this.toggleList("check");
      return true;
    }
    if (meta && e.shiftKey && code === "KeyL") {
      e.preventDefault();
      this.setAlign("left");
      return true;
    }
    if (meta && e.shiftKey && code === "KeyE") {
      e.preventDefault();
      this.setAlign("center");
      return true;
    }
    if (meta && e.shiftKey && code === "KeyR") {
      e.preventDefault();
      this.setAlign("right");
      return true;
    }
    if (meta && e.shiftKey && code === "KeyJ") {
      e.preventDefault();
      this.setAlign("justify");
      return true;
    }
    if (meta && e.altKey && code === "Digit0") {
      e.preventDefault();
      this.setHeading("normal");
      return true;
    }
    if (meta && e.altKey && code === "Digit1") {
      e.preventDefault();
      this.setHeading("h1");
      return true;
    }
    if (meta && e.altKey && code === "Digit2") {
      e.preventDefault();
      this.setHeading("h2");
      return true;
    }
    if (meta && e.altKey && code === "Digit3") {
      e.preventDefault();
      this.setHeading("h3");
      return true;
    }
    if (meta && code === "BracketRight") {
      e.preventDefault();
      this.indent(1);
      return true;
    }
    if (meta && code === "BracketLeft") {
      e.preventDefault();
      this.indent(-1);
      return true;
    }
    if (meta && e.shiftKey && code === "Period") {
      e.preventDefault();
      this.bumpSize(1);
      return true;
    }
    if (meta && e.shiftKey && code === "Comma") {
      e.preventDefault();
      this.bumpSize(-1);
      return true;
    }
    if (meta && !e.shiftKey && code === "Period") {
      e.preventDefault();
      this.toggleMark("sup");
      return true;
    }
    if (meta && !e.shiftKey && code === "Comma") {
      e.preventDefault();
      this.toggleMark("sub");
      return true;
    }
    if (meta && e.altKey && code === "KeyC") {
      e.preventDefault();
      this.copyFormatting();
      return true;
    }
    if (meta && e.altKey && code === "KeyV") {
      e.preventDefault();
      this.pasteFormatting();
      return true;
    }
    if ((meta && code === "Backslash") || (meta && code === "Space")) {
      e.preventDefault();
      this.clearFormatting();
      return true;
    }
    if (e.altKey && e.shiftKey && code === "Digit5") {
      e.preventDefault();
      this.toggleMark("strike");
      return true;
    }
    if (meta && code === "Enter") {
      e.preventDefault();
      this.insertPageBreak();
      return true;
    }
    if (meta && e.shiftKey && !e.altKey && code === "KeyC") {
      e.preventDefault();
      this.hooks.onCommand?.("wordcount");
      return true;
    }
    return false;
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
