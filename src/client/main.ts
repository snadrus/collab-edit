import type { Command } from "../shared/commands.ts";
import type { Heading } from "../shared/doc.ts";
import { restoreDoc } from "../shared/doc.ts";
import {
  base64ToBytes,
  bytesToBase64,
  fromDocx,
  fromFelarumi,
  fromHtml,
  fromMarkdown,
  fromPlain,
  toDocx,
  toFelarumi,
  toHtml,
  toMarkdown,
  toOdt,
  toPdf,
  toText,
} from "../shared/io.ts";
import { hexAlpha } from "../shared/palette.ts";
import type { Thread } from "../shared/threads.ts";
import { mountChrome, type Chrome } from "./chrome.ts";
import { loadQueue, saveQueue } from "./offline.ts";
import { PAGE_W, RULER_H } from "./layout.ts";
import { Editor, decodeCommands, encodeCommands, type RemoteCaret } from "./editor.ts";

interface InitMsg {
  t: "init";
  rev: number;
  snapshot: { text: string; runs: { n: number; s: Record<string, unknown> }[] };
  title: string;
  self: { sid: string; name: string; color: string };
  presence: RemoteCaret[];
  threads?: Thread[];
  resume?: boolean;
  catchup?: { rev: number; sid: string; reqId: number; commands: Command[] }[];
}

interface VersionRow {
  rev: number;
  ts: number;
  sid: string;
  name: string;
  color: string;
  label: string;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function sid(): string {
  let id = sessionStorage.getItem("felarumi-sid") || sessionStorage.getItem("folio-sid");
  if (!id) id = crypto.randomUUID();
  sessionStorage.setItem("felarumi-sid", id);
  return id;
}

function displayName(): string {
  return sessionStorage.getItem("felarumi-name") || sessionStorage.getItem("folio-name") || "Guest";
}

function docIdFromPath(): string | null {
  const m = location.pathname.match(/^\/d\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function toast(text: string): void {
  const el = document.querySelector("#toast") as HTMLElement;
  el.textContent = text;
  el.hidden = false;
  window.setTimeout(() => {
    el.hidden = true;
  }, 1800);
}

function drawRuler(): void {
  const canvas = document.querySelector("#ruler") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = PAGE_W * dpr;
  canvas.height = RULER_H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, RULER_H);
  ctx.strokeStyle = "#c4c7c5";
  ctx.fillStyle = "#444746";
  ctx.font = "11px Roboto, sans-serif";
  ctx.textBaseline = "top";
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(PAGE_W, RULER_H - 0.5);
  ctx.stroke();
  for (let x = 0; x <= PAGE_W; x += 8) {
    const inch = x % 96 === 0;
    const half = x % 48 === 0;
    const h = inch ? 14 : half ? 9 : 5;
    ctx.strokeStyle = inch ? "#80868b" : "#c4c7c5";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_H);
    ctx.lineTo(x + 0.5, RULER_H - h);
    ctx.stroke();
    if (inch && x > 0) ctx.fillText(String(x / 96), x + 3, 2);
  }
  ctx.fillStyle = "rgba(11,87,208,0.18)";
  ctx.fillRect(0, 0, 96, RULER_H);
  ctx.fillRect(PAGE_W - 96, 0, 96, RULER_H);
}

async function mountHome(): Promise<void> {
  (document.querySelector("#home") as HTMLElement).hidden = false;
  document.title = "Felarumi";
  const recent = document.querySelector("#recent") as HTMLElement;
  const blank = document.querySelector("#blank") as HTMLButtonElement;
  blank.addEventListener("click", async () => {
    const res = await fetch("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await res.json()) as { id: string };
    location.href = "/d/" + body.id;
  });
  const docs = (await fetch("/api/docs").then((r) => r.json())) as { id: string; title: string; updated: number }[];
  recent.innerHTML = "";
  if (!docs.length) {
    recent.innerHTML = "<li class='empty'>No documents yet.</li>";
    return;
  }
  for (const doc of docs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "/d/" + doc.id;
    const name = document.createElement("span");
    name.textContent = doc.title;
    const time = document.createElement("time");
    time.dateTime = new Date(doc.updated).toISOString();
    time.textContent = new Date(doc.updated).toLocaleString();
    a.append(name, time);
    li.appendChild(a);
    recent.appendChild(li);
  }
}

function mountEditor(id: string): void {
  (document.querySelector("#editor") as HTMLElement).hidden = false;
  drawRuler();
  const session = sid();
  const pages = document.querySelector("#pages") as HTMLElement;
  const overlay = document.querySelector("#overlay") as HTMLElement;
  const input = document.querySelector("#input") as HTMLElement;
  const stack = document.querySelector("#stack") as HTMLElement;
  const title = document.querySelector("#title") as HTMLInputElement;
  const status = document.querySelector("#status") as HTMLElement;
  const avatars = document.querySelector("#avatars") as HTMLElement;
  const nameBtn = document.querySelector("#name-btn") as HTMLButtonElement;
  let zoom = 1;
  let editor!: Editor;
  let ws: WebSocket | null = null;
  let chrome: Chrome;
  const people = () => [{ sid: session, name: displayName(), color: editor.color }, ...editor.remotes.values()];
  const api = {
    ready: false,
    getText: () => editor.getText(),
    setSelection: (a: number, b: number) => editor.setSelection(a, b),
    insertText: (text: string) => editor.insertText(text),
    remoteCount: () => editor.remotes.size,
    color: () => editor.color,
    insertVote: (emoji: string) => editor.insertVote(emoji),
    toggleVote: (index: number) => editor.toggleVote(index),
    voteNames: () => editor.voteNames(),
    addComment: (text: string) => {
      const id = ("c" + Math.random().toString(36).slice(2, 12)).slice(0, 40);
      const quote = editor.addCommentMark(id);
      if (quote == null) return false;
      const thread: Thread = { id, sid: session, name: editor.name, color: editor.color, text, ts: Date.now(), quote, resolved: false, replies: [] };
      chrome.upsert(thread);
      ws?.send(JSON.stringify({ t: "thread", id, text, quote }));
      return true;
    },
    reply: (id: string, text: string) => {
      const replyId = ("r" + Math.random().toString(36).slice(2, 12)).slice(0, 40);
      ws?.send(JSON.stringify({ t: "reply", id, replyId, text }));
    },
    threads: () => editor.threads.map((t) => ({ id: t.id, text: t.text, resolved: t.resolved, replies: t.replies.map((r) => r.text), name: t.name })),
    insertTable: (rows: number, cols: number) => editor.insertTable(rows, cols),
    tableRows: () => editor.tableRowCount(),
    nameVersion: (label: string) =>
      new Promise<number>((resolve) => {
        nameWait = resolve;
        send({ t: "namever", label });
      }),
    versions: () => historyRows.slice(),
    previewVersion: (rev: number) =>
      new Promise<void>((resolve) => {
        previewWait = resolve;
        openHistory();
        send({ t: "preview", rev });
      }),
    restorePreview: () => {
      const target = editor.preview;
      if (target) editor.replaceDocument(target);
      closeHistory();
    },
    exportFelarumi: () => toFelarumi(title.value, editor.doc, editor.threads),
    importFelarumi: (raw: string) => importBundle(fromFelarumi(raw)),
    exportDocx: async () => bytesToBase64(await toDocx(editor.doc)),
    importDocx: async (b64: string) => editor.replaceDocument(await fromDocx(base64ToBytes(b64))),
    styleAt: (index: number) => editor.styleAt(index),
    toggleBold: () => editor.toggleMark("b"),
    dirty: () => editor.dirty(),
  };
  (window as unknown as { __editor: typeof api }).__editor = api;

  const pump = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = editor.sync.takeOutbound();
    if (!msg) return;
    ws.send(JSON.stringify({ t: "op", sid: session, reqId: msg.reqId, rev: msg.baseRev, commands: encodeCommands(msg.delta) }));
  };

  const sendSel = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !editor.ready) return;
    ws.send(JSON.stringify({ t: "sel", anchor: editor.anchor, head: editor.head }));
  };

  const refreshChrome = () => {
    const live = navigator.onLine && !!ws && ws.readyState === WebSocket.OPEN;
    status.textContent = live ? (editor.dirty() ? "Saving…" : "All changes saved") : "Offline, changes will sync";
    const state = editor.markState();
    press("bold", state.b);
    press("italic", state.i);
    press("underline", state.u);
    press("align-left", state.align === "left");
    press("align-center", state.align === "center");
    press("align-right", state.align === "right");
    press("align-justify", state.align === "justify");
    press("list-bullet", state.list === "bullet");
    press("list-numbered", state.list === "numbered");
    press("list-check", state.list === "check");
    press("strike", state.strike);
    setSelect("style", state.heading);
    setSelect("spacing", String(state.lh));
    setSelect("font", state.font);
    const size = document.querySelector("#size") as HTMLSelectElement;
    const sizeText = String(state.size);
    if ([...size.options].some((o) => o.value === sizeText)) size.value = sizeText;
    document.title = (title.value || "Untitled document") + " - Felarumi";
  };

  editor = new Editor(session, pages, overlay, input, "#f44336", {
    onOutbound: pump,
    onChange: () => {
      refreshChrome();
      chrome?.refresh();
      void persistQueue();
    },
    onSelection: () => {
      refreshChrome();
      sendSel();
      chrome?.refresh();
    },
    onPaint: () => chrome?.refresh(),
    onCommand: (name) => {
      if (name === "find") chrome.openFind(false);
      else if (name === "replace") chrome.openFind(true);
      else if (name === "link") chrome.openLink();
      else if (name === "comment") chrome.openComment();
      else if (name === "wordcount") chrome.openWordCount();
      else if (name === "shortcuts") chrome.openShortcuts();
      else if (name === "saved") toast("All changes saved");
    },
    onAt: (query) => chrome.syncAt(query),
    atKey: (e) => chrome.atKey(e),
    onEmbed: (index) => chrome.showDropdown(index),
  });
  editor.name = displayName();
  chrome = mountChrome(editor, {
    send: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    toast,
    people,
  });

  const applyZoom = (z: number) => {
    zoom = Math.min(2, Math.max(0.5, z));
    (stack.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
    (document.querySelector("#zoom") as HTMLSelectElement).value = String(nearestZoom(zoom));
    editor.render();
  };

  nameBtn.textContent = displayName();
  nameBtn.addEventListener("click", () => {
    const next = window.prompt("Name shown on your cursor", displayName());
    if (!next) return;
    sessionStorage.setItem("felarumi-name", next.trim().slice(0, 40) || "Guest");
    nameBtn.textContent = displayName();
    editor.name = displayName();
    ws?.send(JSON.stringify({ t: "name", name: displayName() }));
    paintAvatars(editor, session);
  });

  title.addEventListener("change", () => sendTitle());
  title.addEventListener("input", () => {
    document.title = title.value + " - Felarumi";
  });
  let titleTimer = 0;
  title.addEventListener("input", () => {
    window.clearTimeout(titleTimer);
    titleTimer = window.setTimeout(sendTitle, 400);
  });

  function sendTitle(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "title", title: title.value, ts: Date.now() }));
  }

  document.querySelector("#share")!.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(url);
    }
  });

  document.querySelector("#toolbar")!.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest("select, input")) return;
    ev.preventDefault();
  });
  for (const sel of ["#table-tools", "#findbar"]) {
    document.querySelector(sel)!.addEventListener("mousedown", (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest("input, textarea, select")) return;
      ev.preventDefault();
    });
  }
  document.querySelector("#menubar")!.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
  });

  bindMenus(editor, {
    new: () => {
      fetch("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then((r) => r.json())
        .then((body: { id: string }) => {
          location.href = "/d/" + body.id;
        });
    },
    rename: () => title.focus(),
    history: () => openHistory(),
    "name-version": () => {
      const label = window.prompt("Name this version");
      if (label && label.trim()) send({ t: "namever", label: label.trim() });
    },
    makecopy: () => {
      void fetch("/api/docs/" + encodeURIComponent(id) + "/copy", { method: "POST" })
        .then((r) => r.json())
        .then((body: { id: string }) => window.open("/d/" + body.id, "_blank", "noopener"));
    },
    "download-felarumi": () => saveFile(safeName(title.value, ".felarumi"), new Blob([toFelarumi(title.value, editor.doc, editor.threads)], { type: "application/json" })),
    "download-docx": () => void toDocx(editor.doc).then((buf) => saveFile(safeName(title.value, ".docx"), new Blob([buf]))),
    "download-odt": () => void toOdt(editor.doc).then((buf) => saveFile(safeName(title.value, ".odt"), new Blob([buf]))),
    "download-html": () => saveFile(safeName(title.value, ".html"), new Blob([toHtml(editor.doc, title.value)], { type: "text/html" })),
    "download-txt": () => saveFile(safeName(title.value, ".txt"), new Blob([toText(editor.doc)], { type: "text/plain" })),
    "download-md": () => saveFile(safeName(title.value, ".md"), new Blob([toMarkdown(editor.doc)], { type: "text/markdown" })),
    "download-pdf": () => saveFile(safeName(title.value, ".pdf"), new Blob([toPdf(editor.doc, title.value)], { type: "application/pdf" })),
    import: () => (document.querySelector("#import-file") as HTMLInputElement).click(),
    print: () => window.print(),
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    cut: () => {
      void navigator.clipboard.writeText(editor.selectedPlain()).catch(() => undefined);
      editor.insertText("");
    },
    copy: () => {
      void navigator.clipboard.writeText(editor.selectedPlain()).then(() => toast("Copied")).catch(() => toast("Allow clipboard access to copy"));
    },
    paste: async () => {
      try {
        const text = await navigator.clipboard.readText();
        editor.paste("", text);
        editor.focus();
      } catch {
        toast("Allow clipboard access to paste");
      }
    },
    "select-all": () => editor.selectAll(),
    "zoom-in": () => applyZoom(nextZoom(zoom, 1)),
    "zoom-out": () => applyZoom(nextZoom(zoom, -1)),
    "zoom-100": () => applyZoom(1),
    "zoom-fit": () => {
      const scroll = document.querySelector("#scroll") as HTMLElement;
      applyZoom((scroll.clientWidth - 48) / PAGE_W);
    },
    "page-break": () => editor.insertPageBreak(),
    rule: () => editor.insertRule(),
    table: () => editor.insertTable(3, 3),
    image: () => chrome.openImage(),
    link: () => chrome.openLink(),
    vote: () => editor.insertVote("👍"),
    person: () => editor.insertEmbed({ embed: "person", label: displayName() }),
    date: () => editor.insertEmbed({ embed: "date", iso: new Date().toISOString().slice(0, 10) }),
    dropdown: () => editor.insertEmbed({ embed: "drop", opts: JSON.stringify(["Yes", "No", "Maybe"]), val: "Yes" }),
    comment: () => chrome.openComment(),
    find: () => chrome.openFind(false),
    replace: () => chrome.openFind(true),
    wordcount: () => chrome.openWordCount(),
    shortcuts: () => chrome.openShortcuts(),
    strike: () => editor.toggleMark("strike"),
    sup: () => editor.toggleMark("sup"),
    sub: () => editor.toggleMark("sub"),
    check: () => editor.toggleList("check"),
    indent: () => editor.indent(1),
    outdent: () => editor.indent(-1),
    bold: () => editor.toggleMark("b"),
    italic: () => editor.toggleMark("i"),
    underline: () => editor.toggleMark("u"),
    h1: () => editor.setHeading("h1"),
    h2: () => editor.setHeading("h2"),
    normal: () => editor.setHeading("normal"),
    "align-left": () => editor.setAlign("left"),
    "align-center": () => editor.setAlign("center"),
    "align-right": () => editor.setAlign("right"),
    bullet: () => editor.toggleList("bullet"),
    numbered: () => editor.toggleList("numbered"),
    clear: () => editor.clearFormatting(),
  });

  document.querySelector("#undo")!.addEventListener("click", () => editor.undo());
  document.querySelector("#redo")!.addEventListener("click", () => editor.redo());
  document.querySelector("#bold")!.addEventListener("click", () => editor.toggleMark("b"));
  document.querySelector("#italic")!.addEventListener("click", () => editor.toggleMark("i"));
  document.querySelector("#underline")!.addEventListener("click", () => editor.toggleMark("u"));
  document.querySelector("#align-left")!.addEventListener("click", () => editor.setAlign("left"));
  document.querySelector("#align-center")!.addEventListener("click", () => editor.setAlign("center"));
  document.querySelector("#align-right")!.addEventListener("click", () => editor.setAlign("right"));
  document.querySelector("#align-justify")!.addEventListener("click", () => editor.setAlign("justify"));
  document.querySelector("#list-bullet")!.addEventListener("click", () => editor.toggleList("bullet"));
  document.querySelector("#list-numbered")!.addEventListener("click", () => editor.toggleList("numbered"));
  document.querySelector("#list-check")!.addEventListener("click", () => editor.toggleList("check"));
  document.querySelector("#strike")!.addEventListener("click", () => editor.toggleMark("strike"));
  document.querySelector("#link")!.addEventListener("click", () => chrome.openLink());
  document.querySelector("#comment")!.addEventListener("click", () => chrome.openComment());
  document.querySelector("#paint")!.addEventListener("click", () => editor.copyFormatting());
  document.querySelector("#clear")!.addEventListener("click", () => editor.clearFormatting());
  document.querySelector("#indent")!.addEventListener("click", () => editor.indent(1));
  document.querySelector("#outdent")!.addEventListener("click", () => editor.indent(-1));
  (document.querySelector("#spacing") as HTMLSelectElement).addEventListener("change", (ev) => {
    editor.setLineSpacing(Number((ev.target as HTMLSelectElement).value));
    editor.focus();
  });
  (document.querySelector("#highlight") as HTMLInputElement).addEventListener("input", (ev) => {
    const value = (ev.target as HTMLInputElement).value;
    (document.querySelector("#highlight-bar") as HTMLElement).style.background = value;
    editor.setTextAttr({ hl: value });
  });
  (document.querySelector("#style") as HTMLSelectElement).addEventListener("change", (ev) => {
    editor.setHeading((ev.target as HTMLSelectElement).value as Heading);
    editor.focus();
  });
  (document.querySelector("#font") as HTMLSelectElement).addEventListener("change", (ev) => {
    editor.setTextAttr({ font: (ev.target as HTMLSelectElement).value });
    editor.focus();
  });
  (document.querySelector("#size") as HTMLSelectElement).addEventListener("change", (ev) => {
    editor.setTextAttr({ size: Number((ev.target as HTMLSelectElement).value) });
    editor.focus();
  });
  (document.querySelector("#zoom") as HTMLSelectElement).addEventListener("change", (ev) => {
    applyZoom(Number((ev.target as HTMLSelectElement).value));
    editor.focus();
  });
  (document.querySelector("#color") as HTMLInputElement).addEventListener("input", (ev) => {
    const value = (ev.target as HTMLInputElement).value;
    (document.querySelector("#color-bar") as HTMLElement).style.background = value;
    editor.setTextAttr({ color: value });
  });

  let historyRows: VersionRow[] = [];
  let nameWait: ((rev: number) => void) | null = null;
  let previewWait: (() => void) | null = null;

  function send(msg: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function persistQueue(): Promise<void> {
    const queued = editor.sync.exportQueue();
    if (!queued) return saveQueue(id, null);
    return saveQueue(id, { docId: id, ...queued });
  }

  function safeName(value: string, ext: string): string {
    return (value || "document").replace(/[^\w.-]+/g, "_") + ext;
  }

  function saveFile(filename: string, blob: Blob): void {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importBundle(parsed: { doc: import("../shared/doc.ts").Doc; threads: Thread[] }): void {
    editor.replaceDocument(parsed.doc);
    for (const thread of parsed.threads) {
      chrome.upsert(thread);
      send({ t: "thread", id: thread.id, text: thread.text, quote: thread.quote });
      for (const reply of thread.replies) send({ t: "reply", id: thread.id, replyId: reply.id, text: reply.text });
    }
  }

  function openHistory(): void {
    (document.querySelector("#history") as HTMLElement).hidden = false;
    send({ t: "history" });
  }

  function closeHistory(): void {
    (document.querySelector("#history") as HTMLElement).hidden = true;
    editor.exitPreview();
    (document.querySelector("#history-banner") as HTMLElement).hidden = true;
    (document.querySelector("#history-restore") as HTMLButtonElement).hidden = true;
  }

  function renderHistory(rows: VersionRow[]): void {
    historyRows = rows;
    const list = document.querySelector("#history-list") as HTMLElement;
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = "<li class='empty'>Versions appear as you edit.</li>";
      return;
    }
    let day = "";
    for (const row of rows) {
      const label = dayLabel(row.ts);
      if (label !== day) {
        day = label;
        const head = document.createElement("li");
        head.className = "history-day";
        head.textContent = label;
        list.appendChild(head);
      }
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";
      const title = document.createElement("strong");
      title.textContent = row.label || row.name;
      const meta = document.createElement("span");
      meta.textContent = (row.label ? row.name + " · " : "") + new Date(row.ts).toLocaleTimeString();
      const swatch = document.createElement("i");
      swatch.style.background = row.color;
      btn.append(swatch, title, meta);
      btn.addEventListener("click", () => send({ t: "preview", rev: row.rev }));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function dayLabel(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString();
  }

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?doc=${encodeURIComponent(id)}`);
    ws.onopen = () => {
      const queued = editor.sync.exportQueue();
      const resume = !!(queued && !queued.transformed);
      ws?.send(JSON.stringify({ t: "hello", sid: session, name: displayName(), resume, since: resume ? queued!.baseRev : undefined }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (msg.t === "init") onInit(msg as unknown as InitMsg);
      else if (msg.t === "op") {
        try {
          editor.applyRemote(decodeCommands(msg.commands as Command[]), String(msg.sid), Number(msg.rev), Number(msg.reqId));
        } catch (err) {
          console.error(err);
          ws?.send(JSON.stringify({ t: "hello", sid: session, name: displayName() }));
        }
      } else if (msg.t === "ack") editor.ack(Number(msg.reqId), (msg.assignedRev as number | null) ?? null, Number(msg.serverRev));
      else if (msg.t === "sel") {
        editor.setRemote({
          sid: String(msg.sid),
          name: String(msg.name || "Guest"),
          color: String(msg.color || "#188038"),
          anchor: Number(msg.anchor),
          head: Number(msg.head),
        });
        paintAvatars(editor, session);
      } else if (msg.t === "join") {
        const existing = editor.remotes.get(String(msg.sid));
        editor.setRemote({
          sid: String(msg.sid),
          name: String(msg.name || "Guest"),
          color: String(msg.color || "#188038"),
          anchor: existing?.anchor ?? 0,
          head: existing?.head ?? 0,
        });
        paintAvatars(editor, session);
      } else if (msg.t === "bye") {
        editor.removeRemote(String(msg.sid));
        paintAvatars(editor, session);
      } else if (msg.t === "title") {
        if (document.activeElement !== title) title.value = String(msg.title);
        refreshChrome();
      } else if (msg.t === "thread") {
        chrome.upsert(msg.thread as Thread);
      } else if (msg.t === "history") {
        renderHistory((msg.versions as VersionRow[]) || []);
      } else if (msg.t === "preview") {
        const snap = msg.snapshot as InitMsg["snapshot"];
        editor.showPreview(restoreDoc(snap as never), (msg.marks as { start: number; end: number; color: string }[]) || []);
        const banner = document.querySelector("#history-banner") as HTMLElement;
        banner.hidden = false;
        banner.textContent = "Previewing " + (msg.label || msg.name || "this version") + ". Edits are highlighted.";
        (document.querySelector("#history-restore") as HTMLButtonElement).hidden = false;
        if (previewWait) {
          previewWait();
          previewWait = null;
        }
      } else if (msg.t === "named") {
        if (nameWait) {
          nameWait(Number(msg.rev));
          nameWait = null;
        }
        toast("Named this version");
        if (!(document.querySelector("#history") as HTMLElement).hidden) send({ t: "history" });
      } else if (msg.t === "reject") {
        console.warn("op rejected", msg.error);
      }
      refreshChrome();
    };
    ws.onclose = () => {
      status.textContent = "Offline, changes will sync";
      window.setTimeout(connect, 800);
    };
  };

  function applyPresence(msg: InitMsg): void {
    editor.color = msg.self.color;
    editor.name = msg.self.name || displayName();
    chrome.setThreads(msg.threads || []);
    title.value = msg.title;
    editor.remotes.clear();
    for (const person of msg.presence) {
      if (person.sid !== session) editor.setRemote(person);
    }
    api.ready = true;
    paintAvatars(editor, session);
    refreshChrome();
    editor.focus();
  }

  function onInit(msg: InitMsg): void {
    const resume = msg.resume === true && editor.dirty() && !editor.sync.transformed;
    if (resume) {
      try {
        for (const op of msg.catchup || []) editor.applyRemote(decodeCommands(op.commands), op.sid, op.rev, op.reqId);
      } catch (err) {
        console.error(err);
        editor.load(msg.snapshot as InitMsg["snapshot"] & { runs: { n: number; s: never }[] }, msg.rev);
        void saveQueue(id, null);
        applyPresence(msg);
        pump();
        return;
      }
      applyPresence(msg);
      editor.sync.resend();
      pump();
      void persistQueue();
      return;
    }
    editor.load(msg.snapshot as InitMsg["snapshot"] & { runs: { n: number; s: never }[] }, msg.rev);
    void saveQueue(id, null);
    applyPresence(msg);
    pump();
  }

  window.setInterval(() => {
    if (editor.sync.inflight) {
      editor.sync.resend();
      pump();
    }
  }, 1500);

  document.querySelector("#history-close")!.addEventListener("click", () => closeHistory());
  document.querySelector("#history-restore")!.addEventListener("click", () => {
    const target = editor.preview;
    if (target) editor.replaceDocument(target);
    closeHistory();
  });
  (document.querySelector("#import-file") as HTMLInputElement).addEventListener("change", () => {
    const input = document.querySelector("#import-file") as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void importFile(file);
  });

  async function importFile(file: File): Promise<void> {
    const name = file.name.toLowerCase();
    if (name.endsWith(".felarumi") || name.endsWith(".json")) importBundle(fromFelarumi(await file.text()));
    else if (name.endsWith(".docx")) editor.replaceDocument(await fromDocx(new Uint8Array(await file.arrayBuffer())));
    else if (name.endsWith(".md") || name.endsWith(".markdown")) editor.replaceDocument(fromMarkdown(await file.text()));
    else if (name.endsWith(".html") || name.endsWith(".htm")) editor.replaceDocument(fromHtml(await file.text()));
    else editor.replaceDocument(fromPlain(await file.text()));
    editor.focus();
  }

  document.fonts.ready.then(() => editor.render()).catch(() => undefined);
  window.addEventListener("offline", () => {
    status.textContent = "Offline, changes will sync";
  });
  window.addEventListener("online", () => refreshChrome());
  window.addEventListener("pagehide", () => void persistQueue());
  void loadQueue(id).then((saved) => {
    if (saved && !saved.transformed && saved.baseSnap && (saved.inflight || saved.pending)) {
      editor.sync.restoreUnacked(restoreDoc(saved.baseSnap), saved.baseRev, saved.inflight, saved.pending);
      editor.ready = true;
      editor.paint();
      api.ready = true;
      refreshChrome();
    }
    connect();
  });
}

function press(id: string, on: boolean): void {
  document.querySelector("#" + id)?.setAttribute("aria-pressed", on ? "true" : "false");
}

function setSelect(id: string, value: string): void {
  const el = document.querySelector("#" + id) as HTMLSelectElement | null;
  if (el && [...el.options].some((o) => o.value === value)) el.value = value;
}

function nearestZoom(z: number): number {
  return ZOOMS.reduce((best, n) => (Math.abs(n - z) < Math.abs(best - z) ? n : best));
}

function nextZoom(z: number, dir: number): number {
  const i = ZOOMS.findIndex((n) => n >= z - 0.01);
  const idx = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, idx + dir))];
}

function paintAvatars(editor: Editor, selfSid: string): void {
  const root = document.querySelector("#avatars") as HTMLElement;
  root.innerHTML = "";
  const people = [{ sid: selfSid, name: displayName(), color: editor.color }, ...editor.remotes.values()];
  for (const person of people) {
    const el = document.createElement("div");
    el.className = "avatar";
    el.style.background = hexAlpha(person.color, 0.16);
    el.style.color = person.color;
    el.style.boxShadow = `0 0 0 2px ${person.color}`;
    el.title = person.name;
    el.dataset.sid = person.sid;
    el.textContent = (person.name.trim()[0] || "?").toUpperCase();
    el.addEventListener("mouseenter", () => {
      editor.hoverSid = person.sid;
      editor.syncFlags();
    });
    el.addEventListener("mouseleave", () => {
      if (editor.hoverSid === person.sid) editor.hoverSid = null;
      editor.syncFlags();
    });
    el.addEventListener("click", () => editor.reveal(person.sid));
    root.appendChild(el);
  }
}

function bindMenus(editor: Editor, actions: Record<string, () => void>): void {
  const bar = document.querySelector("#menubar") as HTMLElement;
  const close = () => {
    for (const pop of bar.querySelectorAll(".menu-pop")) (pop as HTMLElement).hidden = true;
    for (const btn of bar.querySelectorAll(".menu-btn")) btn.setAttribute("aria-expanded", "false");
  };
  bar.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const menuBtn = target.closest(".menu-btn") as HTMLElement | null;
    if (menuBtn) {
      const name = menuBtn.dataset.menu;
      const pop = bar.querySelector(`[data-pop="${name}"]`) as HTMLElement;
      const open = pop.hidden;
      close();
      pop.hidden = !open;
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    const act = target.closest("[data-act]") as HTMLElement | null;
    if (act?.dataset.act) {
      close();
      actions[act.dataset.act]?.();
      editor.focus();
    }
  });
  document.addEventListener("mousedown", (ev) => {
    if (!(ev.target as HTMLElement).closest("#menubar")) close();
  });
}

const id = docIdFromPath();
if (id) mountEditor(id);
else void mountHome();
