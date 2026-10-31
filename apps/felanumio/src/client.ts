import { caretColor, selectionColor } from "../../../packages/core/src/presence.ts";
import { hexAlpha } from "../../../packages/core/src/palette.ts";
import { displayValue, evaluate, indexToCol, shiftFormula, type GridRead } from "./formula.ts";
import { type Book, type CellStyle, type ChartMark, type GridOp, type Sheet, cellKey } from "./ot.ts";
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
    const here = location.pathname === "/sheets/b/" + id || location.pathname.startsWith("/sheets/b/" + id + "/");
    hash = (here ? location.hash.replace(/^#/, "") : "") || localStorage.getItem("felarumi-secret:book:" + id) || "";
  } catch {
    hash = "";
  }
  const wire = new URLSearchParams(location.search).get("wire");
  return "/sheets/b/" + id + (wire ? "?wire=" + encodeURIComponent(wire) : "") + (hash ? "#" + hash : "");
}

const sid = sessionStorage.getItem("felanumio-sid") || crypto.randomUUID().replace(/-/g, "").slice(0, 16);
sessionStorage.setItem("felanumio-sid", sid);
const displayName = () => sessionStorage.getItem("felarumi-name") || "Guest";

function boot(): void {
  const bookPath = location.pathname.match(/^\/sheets\/b\/([A-Za-z0-9_-]+)/);
  const tokenPath = location.pathname.match(/^\/sheets\/([vce])\/([A-Za-z0-9_-]+)/);
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

function mount(id: string, share: string): void {
  (document.querySelector("#app") as HTMLElement).hidden = false;
  const client = new GridClient(sid);
  const canvas = document.querySelector("#grid") as HTMLCanvasElement;
  const formula = document.querySelector("#formula") as HTMLInputElement;
  const namebox = document.querySelector("#namebox") as HTMLElement;
  const title = document.querySelector("#title") as HTMLInputElement;
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
  const canEdit = () => role === "edit" && !preview;

  const book = () => preview || client.view();
  const sheet = (): Sheet => book().sheets[Math.min(sheetIndex, book().sheets.length - 1)];
  const reader = (): GridRead => ({
    sheets: () => book().sheets.map((item) => item.name),
    raw: (name, r, c) => book().sheets.find((item) => item.name === name)?.cells[cellKey(r, c)]?.v || "",
  });

  const send = (msg: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const submit = (ops: GridOp[]) => {
    if (!canEdit() || !ops.length) return;
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
  function colX(s: Sheet, c: number): number {
    let x = HEAD_W;
    const frozen = Math.min(s.freezeC, s.cols);
    if (c < frozen) {
      for (let i = 0; i < c; i++) x += colW(s, i);
      return x;
    }
    for (let i = 0; i < frozen; i++) x += colW(s, i);
    for (let i = frozen; i < c; i++) x += colW(s, i);
    return x - scrollX;
  }
  function rowY(s: Sheet, r: number): number {
    let y = HEAD_H;
    const frozen = Math.min(s.freezeR, s.rows);
    if (r < frozen) {
      for (let i = 0; i < r; i++) y += rowH(s, i);
      return y;
    }
    for (let i = 0; i < frozen; i++) y += rowH(s, i);
    for (let i = frozen; i < r; i++) y += rowH(s, i);
    return y - scrollY;
  }

  function paint(): void {
    const s = sheet();
    const width = Math.max(900, colX(s, s.cols) + scrollX + 40);
    const height = Math.max(600, rowY(s, s.rows) + scrollY + 40);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    const r1 = Math.min(anchor.r, head.r);
    const r2 = Math.max(anchor.r, head.r);
    const c1 = Math.min(anchor.c, head.c);
    const c2 = Math.max(anchor.c, head.c);
    ctx.font = `13px Roboto, sans-serif`;
    ctx.textBaseline = "middle";
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const x = colX(s, c);
        const y = rowY(s, r);
        const w = colW(s, c);
        const h = rowH(s, r);
        if (x > width || y > height || x + w < 0 || y + h < 0) continue;
        const selected = r >= r1 && r <= r2 && c >= c1 && c <= c2;
        if (selected) {
          ctx.fillStyle = selectionColor(true, selfColor);
          ctx.fillRect(x, y, w, h);
        }
        const cell = s.cells[cellKey(r, c)];
        if (cell?.style?.fill) {
          ctx.fillStyle = cell.style.fill;
          ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
        }
        ctx.strokeStyle = cell?.style?.border ? "#202124" : "#e1e3e1";
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        const raw = cell?.v || "";
        const shown = displayValue(evaluate(reader(), s.name, raw), cell?.style?.format || "general");
        ctx.fillStyle = cell?.style?.color || "#202124";
        ctx.font = `${cell?.style?.i ? "italic " : ""}${cell?.style?.b ? "700 " : ""}13px Roboto, sans-serif`;
        ctx.textAlign = cell?.style?.align === "center" ? "center" : cell?.style?.align === "right" ? "right" : "left";
        const tx = cell?.style?.align === "center" ? x + w / 2 : cell?.style?.align === "right" ? x + w - 6 : x + 6;
        ctx.fillText(shown, tx, y + h / 2, w - 10);
      }
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, width, HEAD_H);
    ctx.fillRect(0, 0, HEAD_W, height);
    ctx.fillStyle = "#444746";
    ctx.font = "12px Roboto, sans-serif";
    for (let c = 0; c < s.cols; c++) ctx.fillText(indexToCol(c), colX(s, c) + colW(s, c) / 2, HEAD_H / 2);
    for (let r = 0; r < s.rows; r++) ctx.fillText(String(r + 1), HEAD_W / 2, rowY(s, r) + rowH(s, r) / 2);
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
    const ctx = (document.querySelector("#chart") as HTMLCanvasElement).getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 280, 160);
    const values: { name: string; n: number }[] = [];
    for (let r = chart.r1; r <= chart.r2; r++) {
      for (let c = chart.c1; c <= chart.c2; c++) {
        const raw = sheet().cells[cellKey(r, c)]?.v || "";
        const value = evaluate(reader(), sheet().name, raw);
        if (value.t === "n") values.push({ name: indexToCol(c) + (r + 1), n: value.n });
      }
    }
    const max = Math.max(1, ...values.map((item) => Math.abs(item.n)));
    values.slice(0, 8).forEach((item, n) => {
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
    for (const thread of threads) {
      const card = document.createElement("div");
      card.className = "note";
      card.textContent = thread.name + ": " + thread.text;
      list.appendChild(card);
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
      el.textContent = (person.name[0] || "?").toUpperCase();
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
    head = { r: Math.max(0, Math.min(sheet().rows - 1, head.r + dr)), c: Math.max(0, Math.min(sheet().cols - 1, head.c + dc)) };
    if (!extend) anchor = { ...head };
    sendSel();
    paint();
  }

  function sendSel(): void {
    send({ t: "sel", sheet: sheet().id, r: anchor.r, c: anchor.c, r2: head.r, c2: head.c });
  }

  function hit(x: number, y: number): { r: number; c: number; edge: "col" | "row" | "" } {
    const s = sheet();
    for (let c = 0; c < s.cols; c++) {
      const left = colX(s, c);
      if (Math.abs(x - (left + colW(s, c))) < 4 && y < HEAD_H) return { r: 0, c, edge: "col" };
    }
    for (let r = 0; r < s.rows; r++) {
      const top = rowY(s, r);
      if (Math.abs(y - (top + rowH(s, r))) < 4 && x < HEAD_W) return { r, c: 0, edge: "row" };
    }
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const left = colX(s, c);
        const top = rowY(s, r);
        if (x >= left && x < left + colW(s, c) && y >= top && y < top + rowH(s, r)) return { r, c, edge: "" };
      }
    }
    return { r: head.r, c: head.c, edge: "" };
  }

  let resizing: { edge: "col" | "row"; index: number; start: number; size: number } | null = null;
  let filling = false;
  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const s = sheet();
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

  formula.addEventListener("focus", () => {
    editing = true;
  });
  formula.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitFormula();
      move(1, 0, false);
    } else if (ev.key === "Escape") {
      editing = false;
      paint();
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

  document.querySelector("#bold")!.addEventListener("click", () => setStyle({ b: !styleOf().b }));
  document.querySelector("#italic")!.addEventListener("click", () => setStyle({ i: !styleOf().i }));
  document.querySelector("#format")!.addEventListener("change", (ev) => setStyle({ format: (ev.target as HTMLSelectElement).value as CellStyle["format"] }));
  document.querySelector("#align")!.addEventListener("change", (ev) => setStyle({ align: (ev.target as HTMLSelectElement).value as CellStyle["align"] }));
  document.querySelector("#color")!.addEventListener("change", (ev) => setStyle({ color: (ev.target as HTMLInputElement).value }));
  document.querySelector("#fill")!.addEventListener("change", (ev) => setStyle({ fill: (ev.target as HTMLInputElement).value === "#ffffff" ? undefined : (ev.target as HTMLInputElement).value }));
  document.querySelector("#border")!.addEventListener("click", () => setStyle({ border: !styleOf().border }));
  title.addEventListener("change", () => send({ t: "title", title: title.value, ts: Date.now() }));

  const actions: Record<string, () => void> = {
    insrow: () => submit([{ t: "insrow", sheet: sheet().id, index: head.r, n: 1 }]),
    inscol: () => submit([{ t: "inscol", sheet: sheet().id, index: head.c, n: 1 }]),
    delrow: () => submit([{ t: "delrow", sheet: sheet().id, index: head.r, n: 1 }]),
    delcol: () => submit([{ t: "delcol", sheet: sheet().id, index: head.c, n: 1 }]),
    bold: () => setStyle({ b: !styleOf().b }),
    italic: () => setStyle({ i: !styleOf().i }),
    freeze: () => submit([{ t: "freeze", sheet: sheet().id, rows: head.r, cols: head.c }]),
    copy: () => {
      const lines: string[] = [];
      for (let r = Math.min(anchor.r, head.r); r <= Math.max(anchor.r, head.r); r++) {
        const cols: string[] = [];
        for (let c = Math.min(anchor.c, head.c); c <= Math.max(anchor.c, head.c); c++) cols.push(sheet().cells[cellKey(r, c)]?.v || "");
        lines.push(cols.join("\t"));
      }
      void navigator.clipboard.writeText(lines.join("\n"));
    },
    paste: () => {
      void navigator.clipboard.readText().then((text) => {
        const ops: GridOp[] = [];
        text.split(/\r?\n/).forEach((line, dr) => {
          line.split("\t").forEach((value, dc) => {
            ops.push({ t: "set", sheet: sheet().id, r: anchor.r + dr, c: anchor.c + dc, v: value });
          });
        });
        submit(ops);
      });
    },
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
      const mark: ChartMark = {
        id: "h" + Math.random().toString(36).slice(2, 8),
        sheet: sheet().id,
        r1: Math.min(anchor.r, head.r),
        c1: Math.min(anchor.c, head.c),
        r2: Math.max(anchor.r, head.r),
        c2: Math.max(anchor.c, head.c),
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
    if (role !== "edit") {
      void navigator.clipboard.writeText(location.href);
      return;
    }
    void fetch("/api/books/" + id + "/share")
      .then((res) => res.json())
      .then((body: { access: string; tokens: { edit: string; comment: string; view: string } }) => {
        const card = document.querySelector("#dialog-card") as HTMLElement;
        card.innerHTML = `<h2>Share</h2><p>General access</p><select id="access"><option value="edit">Editor</option><option value="comment">Commenter</option><option value="view">Viewer</option></select>
          <button type="button" id="copy-edit">Copy editor link</button>
          <button type="button" id="copy-comment">Copy commenter link</button>
          <button type="button" id="copy-view">Copy viewer link</button>
          <button type="button" id="dlg-close">Close</button>`;
        (card.querySelector("#access") as HTMLSelectElement).value = body.access;
        (document.querySelector("#dialog") as HTMLElement).hidden = false;
        const origin = location.origin;
        const copy = (token: string, kind: string) => void navigator.clipboard.writeText(origin + "/sheets/" + kind + "/" + token);
        card.querySelector("#copy-edit")!.addEventListener("click", () => copy(body.tokens.edit, "e"));
        card.querySelector("#copy-comment")!.addEventListener("click", () => copy(body.tokens.comment, "c"));
        card.querySelector("#copy-view")!.addEventListener("click", () => copy(body.tokens.view, "v"));
        card.querySelector("#access")!.addEventListener("change", (ev) => {
          void fetch("/api/books/" + id + "/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access: (ev.target as HTMLSelectElement).value }) });
        });
        card.querySelector("#dlg-close")!.addEventListener("click", () => {
          (document.querySelector("#dialog") as HTMLElement).hidden = true;
        });
      });
  });

  document.querySelector("#history-close")!.addEventListener("click", () => {
    preview = null;
    (document.querySelector("#history") as HTMLElement).hidden = true;
    (document.querySelector("#banner") as HTMLElement).hidden = true;
    paint();
  });

  const stage = document.querySelector("#stage") as HTMLElement;
  stage.addEventListener("scroll", () => {
    scrollX = stage.scrollLeft;
    scrollY = stage.scrollTop;
    paint();
  });

  const api = {
    ready: false,
    setCell: (r: number, c: number, v: string) => {
      anchor = { r, c };
      head = { r, c };
      submit([{ t: "set", sheet: sheet().id, r, c, v }]);
    },
    display: (r: number, c: number) => {
      const s = sheet();
      const raw = s.cells[cellKey(r, c)]?.v || "";
      return displayValue(evaluate(reader(), s.name, raw), s.cells[cellKey(r, c)]?.style?.format);
    },
    raw: (r: number, c: number) => sheet().cells[cellKey(r, c)]?.v || "",
    sheetNames: () => book().sheets.map((item) => item.name),
    role: () => role,
  };

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
        const self = msg.self as { color: string };
        selfColor = self.color;
        threads = (msg.threads as Thread[]) || [];
        remotes = [];
        api.ready = true;
        (document.querySelector("#banner") as HTMLElement).hidden = role === "edit";
        (document.querySelector("#banner") as HTMLElement).textContent = role === "view" ? "Viewing" : role === "comment" ? "Commenting" : "";
        paintAvatars(sid);
        paint();
      } else if (msg.t === "ack") {
        const next = client.ack(Number(msg.reqId), (msg.assignedRev as number | null) ?? null, Number(msg.serverRev), (msg.delta as { ops: GridOp[] } | null) || null);
        if (next) send({ t: "op", reqId: next.reqId, rev: next.baseRev, delta: next.delta });
        paint();
      } else if (msg.t === "op") {
        client.remote(String(msg.sid), msg.delta as { ops: GridOp[] }, Number(msg.rev));
        paint();
      } else if (msg.t === "reset") {
        client.load(msg.book as Book, Number(msg.rev));
        preview = null;
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
      } else if (msg.t === "title" && document.activeElement !== title) title.value = String(msg.title || "");
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
      (document.querySelector("#status") as HTMLElement).textContent = "Saved";
    };
    sock.onclose = () => {
      if (gen === socketGen) window.setTimeout(connect, 800);
    };
  }
  connect();
  paint();
}

boot();
