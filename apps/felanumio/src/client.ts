import { avatarInnerHtml, learnWallet, myWallet, refreshIdentity, resolveDisplayName, selfPerson, showSelfIdentity, watchWallet } from "../../../src/shared/person.ts";
import { hostBase, routePath, withKeptQuery } from "../../../p2p/src/host-base.ts";
import { caretColor, selectionColor } from "../../../packages/core/src/presence.ts";
import { hexAlpha } from "../../../packages/core/src/palette.ts";
import { a1ToIndex, canonicalNumber, displayValue, evaluate, indexToCol, shiftFormula, type GridRead } from "./formula.ts";
import { bookOds, bookXlsx, chartPoints, convertField, defaultImportOptions, detectSeparator, importBytes, parseDelimited, parseHtmlTable, sheetCsv, uniqueComments, type ImportOptions } from "./import.ts";
import { type Book, type Cell, type CellStyle, type ChartMark, type GridOp, type Merge, type Sheet, cellKey } from "./ot.ts";
import { GridClient } from "./sync.ts";
import type { Thread } from "../../../packages/core/src/threads.ts";

const HEAD_W = 46;
const HEAD_H = 24;
const DEFAULT_W = 100;
const DEFAULT_H = 24;

interface Remote {
  sid: string;
  name: string;
  color: string;
  sheet: string;
  r: number;
  c: number;
  r2: number;
  c2: number;
}

function bookUrl(id: string): string {
  let hash = "";
  try {
    const path = routePath();
    const here =
      path === "/sheets/b/" + id ||
      path.startsWith("/sheets/b/" + id + "/") ||
      path === "/b/" + id ||
      path.startsWith("/b/" + id + "/");
    hash = (here ? location.hash.replace(/^#/, "") : "") || localStorage.getItem("felarumi-secret:book:" + id) || "";
  } catch {
    hash = "";
  }
  const base = hostBase();
  const prefix = base.endsWith("/felanumio") || base.endsWith("/figrid") ? base : base + "/sheets";
  return withKeptQuery(prefix + "/b/" + id, hash);
}

const sid = sessionStorage.getItem("felanumio-sid") || crypto.randomUUID().replace(/-/g, "").slice(0, 16);
sessionStorage.setItem("felanumio-sid", sid);
const displayName = () => resolveDisplayName();
const identityReady = learnWallet().then(() => refreshIdentity(myWallet()));

function boot(): void {
  const path = routePath();
  const bookPath = path.match(/^\/(?:sheets\/)?b\/([A-Za-z0-9_-]+)/);
  const tokenPath = path.match(/^\/(?:sheets\/)?([vce])\/([A-Za-z0-9_-]+)/);
  if (tokenPath) {
    void fetch("/api/books/open/" + tokenPath[2])
      .then((res) => res.json())
      .then((body: { id?: string }) => {
        if (body.id) {
          const p2p = (window as unknown as { __FELARUMI_P2P__?: boolean }).__FELARUMI_P2P__;
          location.replace(p2p ? bookUrl(body.id) : "/sheets/b/" + body.id + "?s=" + tokenPath[2]);
        }
        else location.replace("/sheets");
      });
    return;
  }
  if (bookPath) mount(bookPath[1], new URLSearchParams(location.search).get("s") || "");
  else mountHome();
}

function mountHome(): void {
  (document.querySelector("#home") as HTMLElement).hidden = false;
  const recent = document.querySelector("#recent") as HTMLElement;
  void fetch("/api/books")
    .then((res) => res.json())
    .then((rows: { id: string; title: string }[]) => {
      recent.innerHTML = "";
      for (const row of rows) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = bookUrl(row.id);
        a.textContent = row.title;
        li.appendChild(a);
        recent.appendChild(li);
      }
    });
  document.querySelector("#blank")!.addEventListener("click", () => {
    void fetch("/api/books", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((res) => res.json())
      .then((body: { id: string }) => {
        location.href = bookUrl(body.id);
      });
  });
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quoteField(value: string, sep: string): string {
  if (value.includes('"') || value.includes("\n") || value.includes("\r") || value.includes(sep)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
  };
  const pa = parse(a);
  const pb = parse(b);
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.min(1, Math.max(0, t))).toString(16).padStart(2, "0")).join("");
}

function mount(id: string, share: string): void {
  (document.querySelector("#app") as HTMLElement).hidden = false;
  const client = new GridClient(sid);
  const canvas = document.querySelector("#grid") as HTMLCanvasElement;
  const sizer = document.querySelector("#sizer") as HTMLElement;
  const stage = document.querySelector("#stage") as HTMLElement;
  const formula = document.querySelector("#formula") as HTMLInputElement;
  const namebox = document.querySelector("#namebox") as HTMLElement;
  const title = document.querySelector("#title") as HTMLInputElement;
  const valid = document.querySelector("#valid") as HTMLSelectElement;
  let ws: WebSocket | null = null;
  let role = "edit";
  let sheetIndex = 0;
  let anchor = { r: 0, c: 0 };
  let head = { r: 0, c: 0 };
  let scrollX = 0;
  let scrollY = 0;
  let editing = false;
  let remotes: Remote[] = [];
  let threads: Thread[] = [];
  let selfColor = "#0f9d58";
  let preview: Book | null = null;
  let sizeVersion = 0;
  let prefixKey = "";
  let prefixR: number[] = [0];
  let prefixC: number[] = [0];
  let lastFrame = 0;
  let lastPainted: string[] = [];
  let viewW = 800;
  let viewH = 600;
  let tileEpoch = "";
  const tileCache = new Map<string, { canvas: HTMLCanvasElement; texts: string[]; w: number; h: number }>();
  const TILE_R = 4;
  const TILE_C = 4;
  const canEdit = () => role === "edit" && !preview;

  const book = () => preview || client.view();
  const sheet = (): Sheet => book().sheets[Math.min(sheetIndex, book().sheets.length - 1)] || book().sheets[0];
  const reader = (): GridRead => ({
    sheets: () => book().sheets.map((item) => item.name),
    raw: (name, r, c) => book().sheets.find((item) => item.name === name)?.cells[cellKey(r, c)]?.v || "",
    format: (name, r, c) => book().sheets.find((item) => item.name === name)?.cells[cellKey(r, c)]?.style?.format,
  });

  const send = (msg: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  /** Browser tab reads "<title> - FiGrid", like "<title> - Google Sheets". */
  const syncTabTitle = () => { document.title = (title.value.trim() || "Untitled spreadsheet") + " - FiGrid"; };
  syncTabTitle();
  // Local undo/redo for cell edits (values and styles), like Sheets' Ctrl+Z / Ctrl+Y. Row/column/sheet
  // changes (ours or a peer's) shift coordinates, so they clear the history rather than undo the wrong cell.
  type UndoStep = { undo: GridOp[]; redo: GridOp[] };
  let undoStack: UndoStep[] = [];
  let redoStack: UndoStep[] = [];
  const clearHistory = () => { undoStack = []; redoStack = []; };
  const inverseOf = (ops: GridOp[]): GridOp[] | null => {
    const out: GridOp[] = [];
    for (const op of ops) {
      if (op.t !== "set" || op.r == null || op.c == null) return null;
      const target = book().sheets.find((item) => item.id === op.sheet);
      const prev = target?.cells[cellKey(op.r, op.c)];
      const back: GridOp = { t: "set", sheet: op.sheet, r: op.r, c: op.c };
      if ("v" in op) back.v = prev?.v ?? null;
      if ("style" in op) back.style = prev?.style ? { ...prev.style } : null;
      out.unshift(back);
    }
    return out;
  };
  const send0 = (ops: GridOp[]) => {
    sizeVersion++;
    const wire = client.push({ ops });
    if (wire) send({ t: "op", reqId: wire.reqId, rev: wire.baseRev, delta: wire.delta });
    paint();
  };
  const undoRedo = (redo: boolean) => {
    if (!canEdit()) return;
    const step = (redo ? redoStack : undoStack).pop();
    if (!step) return;
    (redo ? undoStack : redoStack).push(step);
    const ops = redo ? step.redo : step.undo;
    const first = ops[0];
    if (first?.r != null && first.c != null) { anchor = { r: first.r, c: first.c }; head = { ...anchor }; }
    send0(ops);
  };
  const submit = (ops: GridOp[]) => {
    if (!canEdit() || !ops.length) return;
    const inverse = inverseOf(ops);
    if (inverse) {
      undoStack.push({ undo: inverse, redo: ops });
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    } else clearHistory();
    sizeVersion++;
    const wire = client.push({ ops });
    if (wire) send({ t: "op", reqId: wire.reqId, rev: wire.baseRev, delta: wire.delta });
    paint();
  };
  const styleOf = (): CellStyle => sheet().cells[cellKey(head.r, head.c)]?.style || {};
  const setStyle = (patch: CellStyle) => {
    submit([{ t: "set", sheet: sheet().id, r: head.r, c: head.c, style: { ...styleOf(), ...patch } }]);
  };

  function colW(s: Sheet, c: number): number {
    return s.colW[String(c)] || DEFAULT_W;
  }
  function rowH(s: Sheet, r: number): number {
    return s.rowH[String(r)] || DEFAULT_H;
  }
  function ensurePrefix(s: Sheet): void {
    const key = sizeVersion + ":" + s.rows + "x" + s.cols + ":" + s.freezeR + ":" + s.freezeC;
    if (key === prefixKey) return;
    prefixR = new Array(s.rows + 1);
    prefixC = new Array(s.cols + 1);
    prefixR[0] = 0;
    prefixC[0] = 0;
    for (let r = 0; r < s.rows; r++) prefixR[r + 1] = prefixR[r] + rowH(s, r);
    for (let c = 0; c < s.cols; c++) prefixC[c + 1] = prefixC[c] + colW(s, c);
    prefixKey = key;
    const totalW = HEAD_W + prefixC[s.cols] + 48;
    const totalH = HEAD_H + prefixR[s.rows] + 48;
    sizer.style.width = totalW + "px";
    sizer.style.height = totalH + "px";
  }
  function colX(s: Sheet, c: number): number {
    const frozen = Math.min(s.freezeC, s.cols);
    if (c < frozen) return HEAD_W + prefixC[c];
    return HEAD_W + prefixC[c] - scrollX;
  }
  function rowY(s: Sheet, r: number): number {
    const frozen = Math.min(s.freezeR, s.rows);
    if (r < frozen) return HEAD_H + prefixR[r];
    return HEAD_H + prefixR[r] - scrollY;
  }
  function bounds(): { r1: number; c1: number; r2: number; c2: number } {
    return {
      r1: Math.min(anchor.r, head.r),
      c1: Math.min(anchor.c, head.c),
      r2: Math.max(anchor.r, head.r),
      c2: Math.max(anchor.c, head.c),
    };
  }
  function shown(s: Sheet, r: number, c: number): string {
    const cell = s.cells[cellKey(r, c)];
    const raw = cell?.v || "";
    if (!raw) return "";
    if (raw.startsWith("'") && !raw.startsWith("'=")) return raw.slice(1);
    if (raw.startsWith("'")) return raw.slice(1);
    const format = cell?.style?.format || "general";
    if (!raw.startsWith("=") && format === "general") return raw;
    return displayValue(evaluate(reader(), s.name, raw), format, cell?.style?.numFmt);
  }
  function cellNumber(s: Sheet, r: number, c: number): number | null {
    const raw = s.cells[cellKey(r, c)]?.v || "";
    if (!raw) return null;
    if (raw.startsWith("=")) {
      const value = evaluate(reader(), s.name, raw);
      return value.t === "n" ? value.n : null;
    }
    return canonicalNumber(raw);
  }
  function ruleFill(s: Sheet, r: number, c: number): string {
    let scale = "";
    for (const rule of s.rules || []) {
      if (r < rule.r1 || r > rule.r2 || c < rule.c1 || c > rule.c2) continue;
      if (rule.kind === "scale") {
        let min = Infinity;
        let max = -Infinity;
        for (let rr = rule.r1; rr <= rule.r2; rr++) {
          for (let cc = rule.c1; cc <= rule.c2; cc++) {
            const n = cellNumber(s, rr, cc);
            if (n == null) continue;
            min = Math.min(min, n);
            max = Math.max(max, n);
          }
        }
        const n = cellNumber(s, r, c);
        if (n == null || min === Infinity) continue;
        const t = max === min ? 0 : (n - min) / (max - min);
        scale = mixHex(rule.minColor || "#f8696b", rule.maxColor || "#63be7b", t);
      } else if (rule.kind === "cell" && rule.fill) {
        const n = cellNumber(s, r, c);
        if (n == null) continue;
        const target = rule.value ?? 0;
        const ok =
          rule.op === "gt" ? n > target :
          rule.op === "lt" ? n < target :
          rule.op === "gte" ? n >= target :
          rule.op === "lte" ? n <= target :
          n === target;
        if (ok) return rule.fill;
      }
    }
    return scale;
  }
  function mergeOf(s: Sheet, r: number, c: number): Merge | null {
    for (const merge of s.merges || []) {
      if (r >= merge.r1 && r <= merge.r2 && c >= merge.c1 && c <= merge.c2) return merge;
    }
    return null;
  }
  function listFor(s: Sheet, r: number, c: number): string[] | null {
    for (const rule of s.validations || []) {
      if (r >= rule.r1 && r <= rule.r2 && c >= rule.c1 && c <= rule.c2 && rule.list.length) return rule.list;
    }
    return null;
  }

  function layout(s: Sheet): void {
    viewW = Math.max(320, stage.clientWidth);
    viewH = Math.max(200, stage.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.floor(viewW * dpr);
    const bh = Math.floor(viewH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = viewW + "px";
      canvas.style.height = viewH + "px";
    }
    ensurePrefix(s);
  }

  function renderTile(s: Sheet, tr: number, tc: number): { canvas: HTMLCanvasElement; texts: string[]; w: number; h: number } {
    const r0 = tr * TILE_R;
    const c0 = tc * TILE_C;
    const r1 = Math.min(s.rows, r0 + TILE_R);
    const c1 = Math.min(s.cols, c0 + TILE_C);
    const w = Math.max(1, prefixC[c1] - prefixC[c0]);
    const h = Math.max(1, prefixR[r1] - prefixR[r0]);
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement("canvas");
    off.width = Math.ceil(w * dpr);
    off.height = Math.ceil(h * dpr);
    const o = off.getContext("2d");
    const texts: string[] = [];
    if (!o) return { canvas: off, texts, w, h };
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.fillStyle = "#fff";
    o.fillRect(0, 0, w, h);
    o.strokeStyle = "#e1e3e1";
    o.beginPath();
    let edge = 0;
    for (let r = r0; r < r1; r++) {
      edge += rowH(s, r);
      o.moveTo(0, edge + 0.5);
      o.lineTo(w, edge + 0.5);
    }
    edge = 0;
    for (let c = c0; c < c1; c++) {
      edge += colW(s, c);
      o.moveTo(edge + 0.5, 0);
      o.lineTo(edge + 0.5, h);
    }
    o.stroke();
    o.font = "13px Roboto, sans-serif";
    o.textBaseline = "middle";
    o.textAlign = "left";
    o.fillStyle = "#202124";
    let font = "13px Roboto, sans-serif";
    let align = "left";
    let color = "#202124";
    let py = 0;
    for (let r = r0; r < r1; r++) {
      const rh = rowH(s, r);
      let px = 0;
      for (let c = c0; c < c1; c++) {
        const cw = colW(s, c);
        if (mergeOf(s, r, c)) {
          px += cw;
          continue;
        }
        const cell = s.cells[cellKey(r, c)];
        const fill = cell?.style?.fill || (s.rules?.length ? ruleFill(s, r, c) : "");
        if (fill) {
          o.fillStyle = fill;
          o.fillRect(px + 1, py + 1, Math.max(0, cw - 2), Math.max(0, rh - 2));
          color = "";
        }
        if (cell?.style?.border) {
          o.strokeStyle = "#202124";
          o.strokeRect(px + 0.5, py + 0.5, cw, rh);
          o.strokeStyle = "#e1e3e1";
        }
        const text = shown(s, r, c);
        if (text) {
          texts.push(text);
          const style = cell?.style;
          const nextColor = style?.color || (cell?.link ? "#0563c1" : "#202124");
          const nextFont = `${style?.i ? "italic " : ""}${style?.b ? "700 " : ""}13px Roboto, sans-serif`;
          const nextAlign = style?.align === "center" ? "center" : style?.align === "right" ? "right" : "left";
          if (nextColor !== color) {
            color = nextColor;
            o.fillStyle = color;
          }
          if (nextFont !== font) {
            font = nextFont;
            o.font = font;
          }
          if (nextAlign !== align) {
            align = nextAlign;
            o.textAlign = nextAlign;
          }
          const tx = nextAlign === "center" ? px + cw / 2 : nextAlign === "right" ? px + cw - 6 : px + 6;
          o.fillText(text, tx, py + rh / 2);
        }
        px += cw;
      }
      py += rh;
    }
    return { canvas: off, texts, w, h };
  }

  function paintGrid(): void {
    const started = performance.now();
    const s = sheet();
    layout(s);
    if (tileEpoch !== prefixKey) {
      tileCache.clear();
      tileEpoch = prefixKey;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, viewW, viewH);
    lastPainted = [];
    const sel = bounds();
    const frozenR = Math.min(s.freezeR, s.rows);
    const frozenC = Math.min(s.freezeC, s.cols);
    const frozenH = prefixR[frozenR];
    const frozenW = prefixC[frozenC];
    const colStart = visibleStart(prefixC, frozenC, s.cols, scrollX, viewW - HEAD_W);
    const colEnd = visibleEnd(prefixC, colStart, s.cols, scrollX, viewW - HEAD_W);
    const rowStart = visibleStart(prefixR, frozenR, s.rows, scrollY, viewH - HEAD_H);
    const rowEnd = visibleEnd(prefixR, rowStart, s.rows, scrollY, viewH - HEAD_H);
    const paintOne = (r: number, c: number) => {
      const merge = mergeOf(s, r, c);
      if (merge && (r !== merge.r1 || c !== merge.c1)) return;
      const x = colX(s, c);
      const y = rowY(s, r);
      const w = merge ? colX(s, merge.c2) + colW(s, merge.c2) - x : colW(s, c);
      const h = merge ? rowY(s, merge.r2) + rowH(s, merge.r2) - y : rowH(s, r);
      if (x + w < 0 || y + h < 0 || x > viewW || y > viewH) return;
      const selected = r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
      if (selected) {
        ctx.fillStyle = selectionColor(true, selfColor);
        ctx.fillRect(x, y, w, h);
      }
      const cell = s.cells[cellKey(r, c)];
      const fill = cell?.style?.fill || (s.rules?.length ? ruleFill(s, r, c) : "");
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
      }
      ctx.strokeStyle = cell?.style?.border ? "#202124" : "#e1e3e1";
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      const text = shown(s, r, c);
      if (text) {
        lastPainted.push(text);
        ctx.fillStyle = cell?.style?.color || (cell?.link ? "#0563c1" : "#202124");
        ctx.font = `${cell?.style?.i ? "italic " : ""}${cell?.style?.b ? "700 " : ""}13px Roboto, sans-serif`;
        ctx.textAlign = cell?.style?.align === "center" ? "center" : cell?.style?.align === "right" ? "right" : "left";
        ctx.textBaseline = "middle";
        const tx = cell?.style?.align === "center" ? x + w / 2 : cell?.style?.align === "right" ? x + w - 6 : x + 6;
        ctx.fillText(text, tx, y + h / 2, Math.max(8, w - 10));
      }
    };
    const blit = (r0: number, r1: number, c0: number, c1: number) => {
      if (r0 > r1 || c0 > c1) return;
      for (let tr = Math.floor(r0 / TILE_R); tr <= Math.floor(r1 / TILE_R); tr++) {
        for (let tc = Math.floor(c0 / TILE_C); tc <= Math.floor(c1 / TILE_C); tc++) {
          const key = s.id + ":" + tr + ":" + tc;
          let tile = tileCache.get(key);
          if (tile) {
            tileCache.delete(key);
            tileCache.set(key, tile);
          } else {
            tile = renderTile(s, tr, tc);
            tileCache.set(key, tile);
            while (tileCache.size > 96) {
              const oldest = tileCache.keys().next().value;
              if (oldest === undefined) break;
              tileCache.delete(oldest);
            }
          }
          ctx.drawImage(tile.canvas, colX(s, tc * TILE_C), rowY(s, tr * TILE_R), tile.w, tile.h);
          for (const text of tile.texts) lastPainted.push(text);
        }
      }
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEAD_W + frozenW, HEAD_H + frozenH, Math.max(0, viewW - HEAD_W - frozenW), Math.max(0, viewH - HEAD_H - frozenH));
    ctx.clip();
    blit(Math.max(rowStart, frozenR), rowEnd, Math.max(colStart, frozenC), colEnd);
    for (let r = Math.max(rowStart, frozenR); r <= rowEnd; r++) {
      for (let c = Math.max(colStart, frozenC); c <= colEnd; c++) {
        if (r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2) paintOne(r, c);
      }
    }
    ctx.restore();
    for (let r = 0; r < frozenR; r++) for (let c = colStart; c <= colEnd; c++) paintOne(r, c);
    for (let c = 0; c < frozenC; c++) for (let r = rowStart; r <= rowEnd; r++) paintOne(r, c);
    for (let r = 0; r < frozenR; r++) for (let c = 0; c < frozenC; c++) paintOne(r, c);
    for (const merge of s.merges || []) paintOne(merge.r1, merge.c1);
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, viewW, HEAD_H);
    ctx.fillRect(0, 0, HEAD_W, viewH);
    ctx.fillStyle = "#444746";
    ctx.font = "12px Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const headerCols = new Set<number>();
    for (let c = 0; c < frozenC; c++) headerCols.add(c);
    for (let c = colStart; c <= colEnd; c++) headerCols.add(c);
    for (const c of headerCols) ctx.fillText(indexToCol(c), colX(s, c) + colW(s, c) / 2, HEAD_H / 2);
    const headerRows = new Set<number>();
    for (let r = 0; r < frozenR; r++) headerRows.add(r);
    for (let r = rowStart; r <= rowEnd; r++) headerRows.add(r);
    for (const r of headerRows) ctx.fillText(String(r + 1), HEAD_W / 2, rowY(s, r) + rowH(s, r) / 2);
    for (const remote of remotes) {
      if (remote.sheet !== s.id) continue;
      const x = colX(s, Math.min(remote.c, remote.c2));
      const y = rowY(s, Math.min(remote.r, remote.r2));
      const x2 = colX(s, Math.max(remote.c, remote.c2)) + colW(s, Math.max(remote.c, remote.c2));
      const y2 = rowY(s, Math.max(remote.r, remote.r2)) + rowH(s, Math.max(remote.r, remote.r2));
      ctx.fillStyle = selectionColor(false, remote.color);
      ctx.fillRect(x, y, x2 - x, y2 - y);
      ctx.strokeStyle = caretColor(false, remote.color);
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, x2 - x - 2, y2 - y - 2);
      ctx.lineWidth = 1;
    }
    const ax = colX(s, head.c);
    const ay = rowY(s, head.r);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(ax + 1, ay + 1, colW(s, head.c) - 2, rowH(s, head.r) - 2);
    ctx.fillStyle = "#000";
    ctx.fillRect(ax + colW(s, head.c) - 5, ay + rowH(s, head.r) - 5, 6, 6);
    ctx.lineWidth = 1;
    namebox.textContent = indexToCol(head.c) + (head.r + 1);
    if (!editing) formula.value = s.cells[cellKey(head.r, head.c)]?.v || "";
    placeValidation(s);
    lastFrame = performance.now() - started;
  }

  function visibleStart(prefix: number[], frozen: number, count: number, scroll: number, view: number): number {
    if (count <= frozen) return frozen;
    const top = scroll + prefix[frozen];
    let lo = frozen;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefix[mid + 1] <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function visibleEnd(prefix: number[], start: number, count: number, scroll: number, view: number): number {
    if (count <= start) return start;
    const bottom = scroll + view;
    let lo = start;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] < bottom) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function placeValidation(s: Sheet): void {
    const list = listFor(s, head.r, head.c);
    if (!list || preview) {
      valid.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const host = (document.querySelector("#body") as HTMLElement).getBoundingClientRect();
    valid.hidden = false;
    const x = colX(s, head.c);
    const y = rowY(s, head.r);
    valid.style.left = rect.left - host.left + x + colW(s, head.c) - 18 + "px";
    valid.style.top = rect.top - host.top + y + 1 + "px";
    const current = s.cells[cellKey(head.r, head.c)]?.v || "";
    const options = ["", ...list];
    if (valid.dataset.items !== options.join("\n")) {
      valid.innerHTML = "";
      for (const item of options) {
        const opt = document.createElement("option");
        opt.value = item;
        opt.textContent = item || "▾";
        valid.appendChild(opt);
      }
      valid.dataset.items = options.join("\n");
    }
    valid.value = list.includes(current) ? current : "";
  }

  function paint(): void {
    paintGrid();
    paintTabs();
    paintChart();
    paintThreads();
    (window as unknown as { __sheet: unknown }).__sheet = api;
  }

  function paintTabs(): void {
    const root = document.querySelector("#tabs") as HTMLElement;
    root.innerHTML = "";
    book().sheets.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      if (index === sheetIndex) btn.className = "on";
      btn.addEventListener("click", () => {
        sheetIndex = index;
        anchor = { r: 0, c: 0 };
        head = anchor;
        paint();
      });
      btn.addEventListener("dblclick", () => {
        const name = window.prompt("Rename sheet", item.name);
        if (name && canEdit()) submit([{ t: "rensheet", sheet: item.id, name }]);
      });
      root.appendChild(btn);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.addEventListener("click", () => {
      const sheetId = "s" + Math.random().toString(36).slice(2, 8);
      submit([{ t: "addsheet", sheet: sheetId, name: "Sheet" + (book().sheets.length + 1) }]);
      sheetIndex = book().sheets.length - 1;
      paint();
    });
    root.appendChild(add);
  }

  function paintChart(): void {
    const box = document.querySelector("#chartbox") as HTMLElement;
    const charts = book().charts.filter((chart) => chart.sheet === sheet().id);
    box.hidden = charts.length === 0;
    if (!charts.length) return;
    const chart = charts[charts.length - 1];
    const heading = box.querySelector("h3");
    if (heading) heading.textContent = chart.kind === "placeholder" ? chart.note || "Chart" : chart.title || "Chart";
    const ctx = (document.querySelector("#chart") as HTMLCanvasElement).getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 280, 160);
    if (chart.kind === "placeholder") {
      ctx.fillStyle = "#444746";
      ctx.font = "14px Roboto, sans-serif";
      ctx.fillText(chart.note || "Chart", 16, 80);
      return;
    }
    const values = chartPoints(book(), chart);
    (document.querySelector("#chart") as HTMLCanvasElement).dataset.labels = values.map((item) => item.name).join("|");
    const max = Math.max(1, ...values.map((item) => Math.abs(item.n)));
    const slice = values.slice(0, 8);
    if (chart.kind === "pie") {
      const total = slice.reduce((sum, item) => sum + Math.abs(item.n), 0) || 1;
      const colors = ["#0f9d58", "#4285f4", "#f4b400", "#db4437", "#ab47bc", "#00acc1"];
      let angle = -Math.PI / 2;
      slice.forEach((item, n) => {
        const sweep = (Math.abs(item.n) / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(110, 78);
        ctx.arc(110, 78, 58, angle, angle + sweep);
        ctx.fillStyle = colors[n % colors.length];
        ctx.fill();
        angle += sweep;
      });
      return;
    }
    if (chart.kind === "line") {
      ctx.beginPath();
      slice.forEach((item, n) => {
        const x = 20 + n * 32;
        const y = 140 - (Math.abs(item.n) / max) * 110;
        if (n === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#0f9d58";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      return;
    }
    slice.forEach((item, n) => {
      const h = (Math.abs(item.n) / max) * 110;
      ctx.fillStyle = "#0f9d58";
      ctx.fillRect(16 + n * 32, 140 - h, 22, h);
      ctx.fillStyle = "#444746";
      ctx.font = "10px Roboto";
      ctx.fillText(item.name, 16 + n * 32, 154);
    });
  }

  function paintThreads(): void {
    const list = document.querySelector("#thread-list") as HTMLElement;
    list.innerHTML = "";
    const notes: { quote: string; text: string }[] = [];
    for (const [key, cell] of Object.entries(sheet().cells)) {
      if (!cell.note) continue;
      const [rs, cs] = key.split(",");
      notes.push({ quote: indexToCol(Number(cs)) + (Number(rs) + 1), text: cell.note });
    }
    for (const card of uniqueComments(threads, notes)) {
      const el = document.createElement("div");
      el.className = "note";
      el.textContent = card.thread ? card.thread.name + ": " + card.text : card.text;
      list.appendChild(el);
    }
  }

  function paintAvatars(selfSid: string): void {
    const root = document.querySelector("#avatars") as HTMLElement;
    root.innerHTML = "";
    const people = [{ sid: selfSid, name: displayName(), color: selfColor }, ...remotes];
    const seen = new Set<string>();
    for (const person of people) {
      if (seen.has(person.sid)) continue;
      seen.add(person.sid);
      const el = document.createElement("div");
      const mine = person.sid === selfSid;
      el.className = mine ? "avatar self" : "avatar";
      const own = mine ? selfPerson() : null;
      if (own && (own.avatar?.emoji || own.address)) {
        el.innerHTML = avatarInnerHtml(own, 32);
        el.style.overflow = "hidden";
        if (own.avatar?.color && own.avatar.emoji) {
          el.style.background = own.avatar.color;
          el.style.color = "#fff";
        }
      } else el.textContent = (person.name[0] || "?").toUpperCase();
      el.title = person.name;
      if (mine) {
        el.dataset.testid = "self-avatar";
        el.style.cursor = "pointer";
        el.addEventListener("click", () =>
          showSelfIdentity(el, () => {
            const next = window.prompt("Name shown to others", displayName());
            if (!next) return;
            sessionStorage.setItem("felarumi-name", next.trim().slice(0, 40) || "Guest");
            paintAvatars(selfSid);
          }),
        );
      }
      if (!mine) {
        el.style.background = hexAlpha(person.color, 0.16);
        el.style.color = person.color;
        el.style.boxShadow = `0 0 0 2px ${person.color}`;
      }
      root.appendChild(el);
    }
  }

  function commitFormula(): void {
    if (!editing) return;
    editing = false;
    submit([{ t: "set", sheet: sheet().id, r: head.r, c: head.c, v: formula.value }]);
  }

  function move(dr: number, dc: number, extend: boolean): void {
    commitFormula();
    jumpTo(head.r + dr, head.c + dc, extend);
  }

  /** Put the cursor at (r, c), clamped, and scroll the stage so the cell is on screen (as Sheets does). */
  function jumpTo(r: number, c: number, extend: boolean): void {
    commitFormula();
    const s = sheet();
    head = { r: Math.max(0, Math.min(s.rows - 1, r)), c: Math.max(0, Math.min(s.cols - 1, c)) };
    if (!extend) anchor = { ...head };
    ensurePrefix(s);
    const fr = Math.min(s.freezeR, s.rows);
    const fc = Math.min(s.freezeC, s.cols);
    if (head.r >= fr) {
      const top = prefixR[head.r] - prefixR[fr];
      const bottom = prefixR[head.r + 1] - prefixR[fr];
      const viewH = stage.clientHeight - HEAD_H - prefixR[fr];
      if (top < stage.scrollTop) stage.scrollTop = top;
      else if (viewH > 0 && bottom > stage.scrollTop + viewH) stage.scrollTop = bottom - viewH;
      scrollY = stage.scrollTop;
    }
    if (head.c >= fc) {
      const left = prefixC[head.c] - prefixC[fc];
      const right = prefixC[head.c + 1] - prefixC[fc];
      const viewW = stage.clientWidth - HEAD_W - prefixC[fc];
      if (left < stage.scrollLeft) stage.scrollLeft = left;
      else if (viewW > 0 && right > stage.scrollLeft + viewW) stage.scrollLeft = right - viewW;
      scrollX = stage.scrollLeft;
    }
    sendSel();
    paint();
  }

  const filled = (r: number, c: number) => !!sheet().cells[cellKey(r, c)]?.v;
  /** Ctrl+Arrow: jump to the edge of the current block of data, or to the next filled cell (Sheets behaviour). */
  function edge(dr: number, dc: number): { r: number; c: number } {
    const s = sheet();
    let r = head.r;
    let c = head.c;
    const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < s.rows && cc < s.cols;
    if (filled(r, c) && inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
      while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) { r += dr; c += dc; }
      return { r, c };
    }
    while (inside(r + dr, c + dc)) {
      r += dr; c += dc;
      if (filled(r, c)) return { r, c };
    }
    return { r, c };
  }
  function lastUsed(): { r: number; c: number } {
    let r = 0;
    let c = 0;
    for (const key of Object.keys(sheet().cells)) {
      if (!sheet().cells[key]?.v) continue;
      const [kr, kc] = key.split(",").map(Number);
      if (Number.isFinite(kr) && Number.isFinite(kc)) { r = Math.max(r, kr); c = Math.max(c, kc); }
    }
    return { r, c };
  }

  function sendSel(): void {
    send({ t: "sel", sheet: sheet().id, r: anchor.r, c: anchor.c, r2: head.r, c2: head.c });
  }

  function hitCol(x: number): number {
    const s = sheet();
    const frozen = Math.min(s.freezeC, s.cols);
    const local = x - HEAD_W;
    const content = local < prefixC[frozen] ? local : local + scrollX;
    let lo = 0;
    let hi = Math.max(0, s.cols - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefixC[mid] <= content) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  function hitRow(y: number): number {
    const s = sheet();
    const frozen = Math.min(s.freezeR, s.rows);
    const local = y - HEAD_H;
    const content = local < prefixR[frozen] ? local : local + scrollY;
    let lo = 0;
    let hi = Math.max(0, s.rows - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefixR[mid] <= content) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  function hit(x: number, y: number): { r: number; c: number; edge: "col" | "row" | "" } {
    const s = sheet();
    ensurePrefix(s);
    if (y < HEAD_H && x >= HEAD_W) {
      const c = hitCol(x);
      const left = colX(s, c);
      if (Math.abs(x - (left + colW(s, c))) < 4) return { r: 0, c, edge: "col" };
      return { r: head.r, c: head.c, edge: "" };
    }
    if (x < HEAD_W && y >= HEAD_H) {
      const r = hitRow(y);
      const top = rowY(s, r);
      if (Math.abs(y - (top + rowH(s, r))) < 4) return { r, c: 0, edge: "row" };
      return { r: head.r, c: head.c, edge: "" };
    }
    if (x < HEAD_W || y < HEAD_H) return { r: head.r, c: head.c, edge: "" };
    return { r: hitRow(y), c: hitCol(x), edge: "" };
  }

  function follow(link: string): void {
    if (link.startsWith("#")) {
      const body = link.slice(1);
      const bang = body.lastIndexOf("!");
      const name = bang >= 0 ? body.slice(0, bang).replace(/^'/, "").replace(/'$/, "") : body;
      const ref = bang >= 0 ? body.slice(bang + 1) : "A1";
      const index = book().sheets.findIndex((item) => item.name === name);
      const at = a1ToIndex(ref);
      if (index >= 0) {
        sheetIndex = index;
        if (at) {
          anchor = at;
          head = at;
        }
        paint();
      }
      return;
    }
    window.open(link, "_blank", "noopener");
  }

  let resizing: { edge: "col" | "row"; index: number; start: number; size: number } | null = null;
  let filling = false;
  // The canvas is not focusable: without this the click's default focus change moves focus from the formula bar to <body>,
  // and typing into the selected cell goes nowhere.
  canvas.addEventListener("mousedown", (ev) => ev.preventDefault());
  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const s = sheet();
    ensurePrefix(s);
    const hx = colX(s, head.c) + colW(s, head.c);
    const hy = rowY(s, head.r) + rowH(s, head.r);
    if (Math.abs(x - hx) < 6 && Math.abs(y - hy) < 6) {
      filling = true;
      return;
    }
    const cell = hit(x, y);
    if (cell.edge) {
      resizing = { edge: cell.edge, index: cell.edge === "col" ? cell.c : cell.r, start: cell.edge === "col" ? x : y, size: cell.edge === "col" ? colW(s, cell.c) : rowH(s, cell.r) };
      return;
    }
    const link = s.cells[cellKey(cell.r, cell.c)]?.link;
    if (link && head.r === cell.r && head.c === cell.c && !ev.shiftKey) {
      follow(link);
      return;
    }
    commitFormula();
    head = { r: cell.r, c: cell.c };
    if (!ev.shiftKey) anchor = { ...head };
    sendSel();
    paint();
    formula.focus();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!resizing && !filling) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (resizing) {
      const size = Math.max(20, resizing.size + (resizing.edge === "col" ? x - resizing.start : y - resizing.start));
      submit([{ t: "resize", sheet: sheet().id, axis: resizing.edge, index: resizing.index, size }]);
      resizing = { ...resizing, start: resizing.edge === "col" ? x : y, size };
      return;
    }
    const cell = hit(x, y);
    head = { r: cell.r, c: cell.c };
    paint();
  });
  canvas.addEventListener("pointerup", () => {
    if (filling) {
      const sr = anchor.r;
      const sc = anchor.c;
      const raw = sheet().cells[cellKey(sr, sc)]?.v || "";
      const ops: GridOp[] = [];
      const r1 = Math.min(sr, head.r);
      const r2 = Math.max(sr, head.r);
      const c1 = Math.min(sc, head.c);
      const c2 = Math.max(sc, head.c);
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (r === sr && c === sc) continue;
          ops.push({ t: "set", sheet: sheet().id, r, c, v: raw.startsWith("=") ? shiftFormula(raw, r - sr, c - sc) : raw });
        }
      }
      submit(ops);
    }
    filling = false;
    resizing = null;
  });
  canvas.addEventListener("dblclick", () => {
    editing = true;
    formula.focus();
  });

  formula.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitFormula();
      move(ev.shiftKey ? -1 : 1, 0, false);
    } else if (ev.key === "Escape") {
      editing = false;
      paint();
    } else if (!editing && (ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "z" || ev.key.toLowerCase() === "y")) {
      ev.preventDefault();
      undoRedo(ev.key.toLowerCase() === "y" || ev.shiftKey);
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      commitFormula();
      move(0, ev.shiftKey ? -1 : 1, false);
    } else if (!editing && (ev.ctrlKey || ev.metaKey) && (ev.key === "Home" || ev.key === "End")) {
      ev.preventDefault();
      const to = ev.key === "Home" ? { r: 0, c: 0 } : lastUsed();
      jumpTo(to.r, to.c, ev.shiftKey);
    } else if (!editing && (ev.ctrlKey || ev.metaKey) && ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      const to = edge(ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0, ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0);
      jumpTo(to.r, to.c, ev.shiftKey);
    } else if (!editing && (ev.key === "Delete" || ev.key === "Backspace") && canEdit()) {
      ev.preventDefault();
      const box = bounds();
      const ops: GridOp[] = [];
      for (let r = box.r1; r <= box.r2; r++) for (let c = box.c1; c <= box.c2; c++) if (filled(r, c)) ops.push({ t: "set", sheet: sheet().id, r, c, v: "" });
      if (ops.length) submit(ops);
      formula.value = "";
      paint();
    } else if (!editing && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && canEdit()) {
      // Typing on a selected cell replaces it, like Sheets (instead of appending to the old value).
      formula.value = "";
      editing = true;
    } else if (!editing && ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      move(ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0, ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0, ev.shiftKey);
    } else if (ev.key === "b" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      setStyle({ b: !styleOf().b });
    }
  });
  formula.addEventListener("input", () => {
    editing = true;
  });
  valid.addEventListener("change", () => {
    if (!canEdit() || valid.value === "") return;
    editing = false;
    submit([{ t: "set", sheet: sheet().id, r: head.r, c: head.c, v: valid.value }]);
  });

  document.querySelector("#bold")!.addEventListener("click", () => setStyle({ b: !styleOf().b }));
  document.querySelector("#italic")!.addEventListener("click", () => setStyle({ i: !styleOf().i }));
  document.querySelector("#format")!.addEventListener("change", (ev) => setStyle({ format: (ev.target as HTMLSelectElement).value as CellStyle["format"] }));
  document.querySelector("#align")!.addEventListener("change", (ev) => setStyle({ align: (ev.target as HTMLSelectElement).value as CellStyle["align"] }));
  document.querySelector("#color")!.addEventListener("change", (ev) => setStyle({ color: (ev.target as HTMLInputElement).value }));
  document.querySelector("#fill")!.addEventListener("change", (ev) => setStyle({ fill: (ev.target as HTMLInputElement).value === "#ffffff" ? undefined : (ev.target as HTMLInputElement).value }));
  document.querySelector("#border")!.addEventListener("click", () => setStyle({ border: !styleOf().border }));
  title.addEventListener("change", () => {
    send({ t: "title", title: title.value, ts: Date.now() });
    syncTabTitle();
  });

  function selectionGrid(): string[][] {
    const box = bounds();
    const s = sheet();
    const grid: string[][] = [];
    for (let r = box.r1; r <= box.r2; r++) {
      const line: string[] = [];
      for (let c = box.c1; c <= box.c2; c++) {
        const raw = s.cells[cellKey(r, c)]?.v || "";
        line.push(raw.startsWith("'") ? raw.slice(1) : raw);
      }
      grid.push(line);
    }
    return grid;
  }
  /** What the cells show (values), for other apps — Sheets puts values, not formulas, in text/plain. */
  function selectionShown(): string[][] {
    const box = bounds();
    const s = sheet();
    const out: string[][] = [];
    for (let r = box.r1; r <= box.r2; r++) {
      const line: string[] = [];
      for (let c = box.c1; c <= box.c2; c++) line.push(shown(s, r, c));
      out.push(line);
    }
    return out;
  }
  /** HTML table of shown values; FiGrid-to-FiGrid paste reads the raw cells (formulas) from data attributes. */
  function copyHtml(): string {
    const box = bounds();
    const raw = selectionGrid();
    const vis = selectionShown();
    return `<table data-figrid-origin="${box.r1},${box.c1}">` + vis.map((row, i) => "<tr>" + row.map((value, j) => `<td data-figrid-raw="${esc(raw[i][j])}">${esc(value)}</td>`).join("") + "</tr>").join("") + "</table>";
  }
  /** Raw cells from a FiGrid copy, formulas shifted to the paste position like Sheets; null for other sources. */
  function figridPaste(html: string): string[][] | null {
    if (!html.includes("data-figrid-origin")) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = doc.querySelector("table[data-figrid-origin]");
    if (!table) return null;
    const [sr, sc] = (table.getAttribute("data-figrid-origin") || "0,0").split(",").map(Number);
    const dest = bounds();
    const dr = dest.r1 - (sr || 0);
    const dc = dest.c1 - (sc || 0);
    return [...table.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => {
      const raw = td.getAttribute("data-figrid-raw") ?? td.textContent ?? "";
      return raw.startsWith("=") ? shiftFormula(raw, dr, dc) : raw;
    }));
  }
  /** Paste raw FiGrid cells verbatim (no CSV/number conversion of formulas). */
  function pasteRaw(grid: string[][]): void {
    editing = false;
    const origin = bounds();
    const ops: GridOp[] = [];
    for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) ops.push({ t: "set", sheet: sheet().id, r: origin.r1 + r, c: origin.c1 + c, v: grid[r][c] });
    submit(ops);
  }
  function gridTsv(grid: string[][]): string {
    return grid.map((row) => row.map((value) => quoteField(value, "\t")).join("\t")).join("\n");
  }
  function pasteGrid(grid: string[][], sep: string): void {
    editing = false;
    const origin = bounds();
    const options = defaultImportOptions();
    const cells: Record<string, Cell> = {};
    let rows = 1;
    let cols = 1;
    for (let r = 0; r < grid.length; r++) {
      rows = Math.max(rows, origin.r1 + r + 1);
      for (let c = 0; c < grid[r].length; c++) {
        cols = Math.max(cols, origin.c1 + c + 1);
        const cell = convertField(grid[r][c], options, sep);
        cells[cellKey(origin.r1 + r, origin.c1 + c)] = cell.v || cell.style ? cell : {};
      }
    }
    const host = sheet();
    submit([{
      t: "load",
      mode: "patch",
      sheet: host.id,
      book: {
        charts: [],
        sheets: [{ id: host.id, name: host.name, rows, cols, cells, rowH: {}, colW: {}, freezeR: 0, freezeC: 0, merges: [], validations: [], rules: [] }],
      },
    }]);
  }
  async function loadFile(file: File, options: ImportOptions): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const existing = book().sheets.map((item) => item.id);
    const loaded = importBytes(file.name, bytes, options, options.mode === "replace" ? existing : []);
    editing = false;
    const before = book().sheets.length;
    submit([{ t: "load", mode: options.mode, sheet: sheet().id, book: loaded }]);
    if (options.mode === "replace") sheetIndex = 0;
    if (options.mode === "insert") sheetIndex = Math.min(before, book().sheets.length - 1);
    anchor = { r: 0, c: 0 };
    head = anchor;
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    scrollX = 0;
    scrollY = 0;
    for (const item of loaded.sheets) {
      for (const [key, cell] of Object.entries(item.cells)) {
        if (!cell.note) continue;
        const [rs, cs] = key.split(",");
        const thread: Thread = {
          id: ("note" + Math.random().toString(36).slice(2, 12)).slice(0, 20),
          sid,
          name: displayName(),
          color: selfColor,
          text: cell.note,
          ts: Date.now(),
          quote: indexToCol(Number(cs)) + (Number(rs) + 1),
          resolved: false,
          replies: [],
        };
        threads = threads.concat(thread);
        send({ t: "thread", thread });
      }
    }
    paint();
  }
  function openImport(mode: ImportOptions["mode"], heading = "Import"): void {
    const card = document.querySelector("#dialog-card") as HTMLElement;
    card.innerHTML = `<h2>${heading}</h2>
      <label>Location <select id="imp-mode"><option value="replace">Replace spreadsheet</option><option value="insert">Insert new sheet(s)</option><option value="append">Append</option></select></label>
      <label>Separator <select id="imp-sep"><option value="auto">Detect automatically</option><option value=",">Comma</option><option value=";">Semicolon</option><option value="\\t">Tab</option><option value="custom">Custom</option></select></label>
      <input id="imp-custom" placeholder="Custom separator">
      <label><input id="imp-convert" type="checkbox" checked> Convert text to numbers, dates, formulas</label>
      <label><input id="imp-zeros" type="checkbox" checked> Keep leading zeros</label>
      <label><input id="imp-text" type="checkbox" checked> Keep values that are not valid formulas as text</label>
      <label>Locale <select id="imp-locale"><option value="auto">Auto</option><option value="us">United States</option><option value="eu">Europe (decimal comma)</option></select></label>
      <input id="imp-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.ods,text/csv,text/tab-separated-values">
      <button type="button" id="dlg-close">Close</button>`;
    (card.querySelector("#imp-mode") as HTMLSelectElement).value = mode;
    (document.querySelector("#dialog") as HTMLElement).hidden = false;
    card.querySelector("#dlg-close")!.addEventListener("click", () => {
      (document.querySelector("#dialog") as HTMLElement).hidden = true;
    });
    card.querySelector("#imp-file")!.addEventListener("change", () => {
      const file = (card.querySelector("#imp-file") as HTMLInputElement).files?.[0];
      if (!file) return;
      const sepPick = (card.querySelector("#imp-sep") as HTMLSelectElement).value;
      const custom = (card.querySelector("#imp-custom") as HTMLInputElement).value;
      const options: ImportOptions = {
        mode: (card.querySelector("#imp-mode") as HTMLSelectElement).value as ImportOptions["mode"],
        separator: sepPick === "custom" ? custom || "," : (sepPick as ImportOptions["separator"]),
        convert: (card.querySelector("#imp-convert") as HTMLInputElement).checked,
        keepLeadingZeros: (card.querySelector("#imp-zeros") as HTMLInputElement).checked,
        invalidFormulaAsText: (card.querySelector("#imp-text") as HTMLInputElement).checked,
        locale: (card.querySelector("#imp-locale") as HTMLSelectElement).value as ImportOptions["locale"],
      };
      (document.querySelector("#dialog") as HTMLElement).hidden = true;
      void loadFile(file, options);
    });
  }
  function download(kind: "csv" | "xlsx" | "ods"): void {
    const base = (title.value || "sheet").replace(/[^\w.-]+/g, "_");
    if (kind === "csv") {
      const csv = sheetCsv(sheet(), (cell) => displayValue(evaluate(reader(), sheet().name, cell.v || ""), cell.style?.format || "general", cell.style?.numFmt));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = base + ".csv";
      a.click();
      return;
    }
    const bytes = kind === "xlsx" ? bookXlsx(book()) : bookOds(book());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = base + "." + kind;
    a.click();
  }

  const actions: Record<string, () => void> = {
    insrow: () => submit([{ t: "insrow", sheet: sheet().id, index: head.r, n: 1 }]),
    inscol: () => submit([{ t: "inscol", sheet: sheet().id, index: head.c, n: 1 }]),
    delrow: () => submit([{ t: "delrow", sheet: sheet().id, index: head.r, n: 1 }]),
    delcol: () => submit([{ t: "delcol", sheet: sheet().id, index: head.c, n: 1 }]),
    bold: () => setStyle({ b: !styleOf().b }),
    italic: () => setStyle({ i: !styleOf().i }),
    freeze: () => submit([{ t: "freeze", sheet: sheet().id, rows: head.r, cols: head.c }]),
    undo: () => undoRedo(false),
    redo: () => undoRedo(true),
    copy: () => {
      const tsv = gridTsv(selectionShown());
      const html = copyHtml();
      const item = new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      void navigator.clipboard.write([item]).catch(() => navigator.clipboard.writeText(tsv));
    },
    paste: () => {
      editing = false;
      void (async () => {
        try {
          for (const item of await navigator.clipboard.read()) {
            if (!item.types.includes("text/html")) continue;
            const own = figridPaste(await (await item.getType("text/html")).text());
            if (own) return pasteRaw(own);
          }
        } catch {
          // fall back to plain text below
        }
        const text = await navigator.clipboard.readText();
        const sep = text.includes("\t") ? "\t" : detectSeparator(text);
        pasteGrid(parseDelimited(text, sep), sep);
      })();
    },
    import: () => openImport("replace", "Import"),
    open: () => openImport("replace", "Open"),
    csv: () => download("csv"),
    xlsx: () => download("xlsx"),
    ods: () => download("ods"),
    comment: () => {
      const text = window.prompt("Comment");
      if (!text) return;
      const thread: Thread = {
        id: ("c" + Math.random().toString(36).slice(2, 12)).slice(0, 20),
        sid,
        name: displayName(),
        color: selfColor,
        text,
        ts: Date.now(),
        quote: indexToCol(head.c) + (head.r + 1),
        resolved: false,
        replies: [],
      };
      threads = [...threads, thread];
      send({ t: "thread", thread });
      paint();
    },
    chart: () => {
      const box = bounds();
      const mark: ChartMark = {
        id: "h" + Math.random().toString(36).slice(2, 8),
        sheet: sheet().id,
        r1: box.r1,
        c1: box.c1,
        r2: box.r2,
        c2: box.c2,
        kind: "bar",
      };
      submit([{ t: "chart", ...mark }]);
    },
    history: () => {
      (document.querySelector("#history") as HTMLElement).hidden = false;
      send({ t: "history" });
    },
    namever: () => {
      const label = window.prompt("Version name", "Checkpoint");
      if (label) send({ t: "namever", label });
    },
  };

  document.addEventListener("paste", (ev) => {
    if (!canEdit()) return;
    const data = ev.clipboardData;
    if (!data) return;
    const html = data.getData("text/html");
    const plain = data.getData("text/plain");
    const own = html ? figridPaste(html) : null;
    if (own && own.length) {
      ev.preventDefault();
      pasteRaw(own);
      return;
    }
    const table = html ? parseHtmlTable(html) : null;
    const sep = plain.includes("\t") ? "\t" : detectSeparator(plain || "");
    const grid = table && table.length ? table : plain ? parseDelimited(plain, sep) : null;
    if (!grid || !grid.length) return;
    const multi = !!table || grid.length > 1 || (grid[0]?.length || 0) > 1;
    if (!multi && editing && document.activeElement === formula) return;
    ev.preventDefault();
    pasteGrid(grid, table ? "," : sep);
  }, true);
  document.addEventListener("copy", (ev) => {
    if (editing && document.activeElement === formula) return;
    if (!ev.clipboardData) return;
    ev.preventDefault();
    ev.clipboardData.setData("text/plain", gridTsv(selectionShown()));
    ev.clipboardData.setData("text/html", copyHtml());
  });
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    stage.addEventListener(type, (ev) => {
      ev.preventDefault();
      if (type !== "drop" || !canEdit()) return;
      const file = ev.dataTransfer?.files?.[0];
      if (file) void loadFile(file, defaultImportOptions());
    });
  }

  document.querySelector("#menubar")!.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const menu = target.closest(".menu-btn") as HTMLElement | null;
    if (menu) {
      const pop = menu.parentElement?.querySelector(".menu-pop") as HTMLElement;
      const open = pop.hidden;
      for (const el of document.querySelectorAll<HTMLElement>(".menu-pop")) el.hidden = true;
      pop.hidden = !open;
      return;
    }
    const act = target.closest("[data-act]") as HTMLElement | null;
    if (!act?.dataset.act) return;
    for (const el of document.querySelectorAll<HTMLElement>(".menu-pop")) el.hidden = true;
    actions[act.dataset.act]?.();
  });

  document.querySelector("#share")!.addEventListener("click", () => {
    const card = document.querySelector("#dialog-card") as HTMLElement;
    card.innerHTML = `<h2>Share</h2><button type="button" id="copy-link">🔗 Copy Link</button><button type="button" id="dlg-close">Close</button>`;
    (document.querySelector("#dialog") as HTMLElement).hidden = false;
    const btn = card.querySelector("#copy-link") as HTMLButtonElement;
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(location.href).then(() => {
        btn.textContent = "Copied";
        window.setTimeout(() => (btn.textContent = "🔗 Copy Link"), 1500);
      });
    });
    card.querySelector("#dlg-close")!.addEventListener("click", () => {
      (document.querySelector("#dialog") as HTMLElement).hidden = true;
    });
  });

  document.querySelector("#history-close")!.addEventListener("click", () => {
    preview = null;
    (document.querySelector("#history") as HTMLElement).hidden = true;
    (document.querySelector("#banner") as HTMLElement).hidden = true;
    paint();
  });

  let raf = 0;
  stage.addEventListener("scroll", () => {
    scrollX = stage.scrollLeft;
    scrollY = stage.scrollTop;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paintGrid();
    });
  });

  const api = {
    ready: false,
    setCell: (r: number, c: number, v: string) => {
      anchor = { r, c };
      head = { r, c };
      editing = false;
      submit([{ t: "set", sheet: sheet().id, r, c, v }]);
    },
    display: (r: number, c: number) => shown(sheet(), r, c),
    raw: (r: number, c: number) => sheet().cells[cellKey(r, c)]?.v || "",
    sheetNames: () => book().sheets.map((item) => item.name),
    role: () => role,
    /** The book as this client sees it (unacked edits included), for a guest's "Save a copy" while the owner is away. */
    copyState: () => ({
      raw: JSON.stringify({ kind: "felanumio-p2p", title: title.value, book: book() }),
      title: title.value,
      rev: client.rev,
      dirty: !!(client.inflight || client.pending),
    }),
    selectSheet: (name: string) => {
      const index = book().sheets.findIndex((item) => item.name === name);
      if (index >= 0) {
        sheetIndex = index;
        anchor = { r: 0, c: 0 };
        head = anchor;
        paint();
      }
    },
    selectRange: (r1: number, c1: number, r2: number, c2: number) => {
      anchor = { r: r1, c: c1 };
      head = { r: r2, c: c2 };
      editing = false;
      paint();
    },
    style: (r: number, c: number) => sheet().cells[cellKey(r, c)]?.style || null,
    note: (r: number, c: number) => sheet().cells[cellKey(r, c)]?.note || "",
    link: (r: number, c: number) => sheet().cells[cellKey(r, c)]?.link || "",
    freeze: () => ({ r: sheet().freezeR, c: sheet().freezeC }),
    colWidth: (c: number) => colW(sheet(), c),
    rowHeight: (r: number) => rowH(sheet(), r),
    merges: () => sheet().merges || [],
    validations: () => sheet().validations || [],
    rules: () => sheet().rules || [],
    charts: () => book().charts,
    scrollToRow: (r: number) => {
      ensurePrefix(sheet());
      const frozen = Math.min(sheet().freezeR, sheet().rows);
      const max = Math.max(0, sheet().rows - 1);
      stage.scrollTop = Math.max(0, prefixR[Math.min(max, r)] - prefixR[frozen]);
      scrollY = stage.scrollTop;
      paintGrid();
    },
    painted: () => lastPainted.slice(),
    frameMs: () => lastFrame,
    threads: () => threads.map((thread) => thread.text),
  };

  // A fresh browser learns the identity from chain; repaint self (peers get it on the next hello).
  void identityReady.then((changed) => {
    if (changed) paintAvatars(sid);
  });
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith("fil-identity:")) paintAvatars(sid);
  });
  // Wallet account/network switch: repaint self in place (peers get it on the next hello), no reload or prompt.
  (window as unknown as { __walletSwitch?: (a: string[]) => Promise<void> }).__walletSwitch = watchWallet(() => paintAvatars(sid));

  let socketGen = 0;
  function connect(): void {
    const gen = ++socketGen;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws/sheets?book=${encodeURIComponent(id)}`);
    ws = sock;
    sock.onopen = () => send({ t: "hello", sid, name: displayName(), share });
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (msg.t === "init") {
        client.load(msg.book as Book, Number(msg.rev));
        role = String(msg.role || "edit");
        title.value = String(msg.title || "");
        syncTabTitle();
        const self = msg.self as { color: string };
        selfColor = self.color;
        threads = (msg.threads as Thread[]) || [];
        remotes = [];
        api.ready = true;
        sizeVersion++;
        // Ready to type: the selected cell (A1 on open) takes keystrokes without a click, like a new sheet elsewhere.
        if (role === "edit" && !document.activeElement?.closest("input, textarea, select, [contenteditable]")) formula.focus();
        (document.querySelector("#banner") as HTMLElement).hidden = role === "edit";
        (document.querySelector("#banner") as HTMLElement).textContent = role === "view" ? "Viewing" : role === "comment" ? "Commenting" : "";
        paintAvatars(sid);
        paint();
      } else if (msg.t === "ack") {
        const next = client.ack(Number(msg.reqId), (msg.assignedRev as number | null) ?? null, Number(msg.serverRev), (msg.delta as { ops: GridOp[] } | null) || null);
        if (next) send({ t: "op", reqId: next.reqId, rev: next.baseRev, delta: next.delta });
        sizeVersion++;
        paint();
      } else if (msg.t === "op") {
        client.remote(String(msg.sid), msg.delta as { ops: GridOp[] }, Number(msg.rev));
        if ((msg.delta as { ops: GridOp[] }).ops.some((op) => op.t !== "set")) clearHistory();
        sizeVersion++;
        paint();
      } else if (msg.t === "reset") {
        client.load(msg.book as Book, Number(msg.rev));
        clearHistory();
        preview = null;
        sizeVersion++;
        paint();
      } else if (msg.t === "sel") {
        remotes = remotes.filter((remote) => remote.sid !== msg.sid);
        remotes.push({
          sid: String(msg.sid),
          name: String(msg.name || "Guest"),
          color: String(msg.color),
          sheet: String(msg.sheet),
          r: Number(msg.r),
          c: Number(msg.c),
          r2: Number(msg.r2),
          c2: Number(msg.c2),
        });
        paintAvatars(sid);
        paint();
      } else if (msg.t === "join") {
        paintAvatars(sid);
      } else if (msg.t === "bye") {
        remotes = remotes.filter((remote) => remote.sid !== msg.sid);
        paintAvatars(sid);
        paint();
      } else if (msg.t === "title" && document.activeElement !== title) {
        title.value = String(msg.title || "");
        syncTabTitle();
      }
      else if (msg.t === "thread") {
        const thread = msg.thread as Thread;
        threads = threads.filter((item) => item.id !== thread.id).concat(thread);
        paint();
      } else if (msg.t === "history") {
        const list = document.querySelector("#history-list") as HTMLElement;
        list.innerHTML = "";
        for (const row of (msg.versions as { rev: number; label: string; name: string }[]) || []) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = (row.label || row.name) + " · " + row.rev;
          btn.addEventListener("click", () => send({ t: "preview", rev: row.rev }));
          list.appendChild(btn);
        }
      } else if (msg.t === "preview") {
        preview = msg.book as Book;
        (document.querySelector("#banner") as HTMLElement).hidden = false;
        (document.querySelector("#banner") as HTMLElement).textContent = "Previewing version " + msg.rev;
        paint();
      } else if (msg.t === "reject") {
        client.load(client.book, client.rev);
        paint();
      } else if (msg.t === "access") {
        role = msg.role === "view" || msg.role === "comment" ? String(msg.role) : "edit";
        const banner = document.querySelector("#banner") as HTMLElement;
        const wait = document.querySelector("#p2p-wait") as HTMLElement | null;
        const waiting = role !== "edit";
        banner.hidden = !waiting;
        banner.textContent = typeof msg.banner === "string" && waiting ? msg.banner : waiting ? "Viewing" : "";
        if (wait) {
          wait.hidden = !waiting;
          if (typeof msg.banner === "string" && waiting) wait.textContent = msg.banner;
        }
        paint();
      }
      if (!document.documentElement.dataset.saveOwner) (document.querySelector("#status") as HTMLElement).textContent = "Saved";
    };
    sock.onclose = () => {
      if (gen === socketGen) window.setTimeout(connect, 800);
    };
  }
  connect();
  paint();
}

boot();
