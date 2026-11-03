import { hostBase, routePath, withKeptQuery } from "../../p2p/src/host-base.ts";
import type { Command } from "../shared/commands.ts";
import type { Role } from "../shared/access.ts";
import type { Heading } from "../shared/doc.ts";
import { docIsSigned, restoreDoc, snapshotDoc } from "../shared/doc.ts";
import {
  canonicalUnsigned,
  chainIdFor,
  chainLabel,
  contentHashOf,
  docFromCanonical,
  hashBytes,
  normalizeAddress,
  readStored,
  signatureAttrs,
  typedDataJson,
  unsignedBytes,
  verifyStored,
} from "../shared/sign.ts";
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
import { type PageSpec } from "../shared/page.ts";
import { DEFAULT_SUBS } from "../shared/spell.ts";
import type { Thread } from "../shared/threads.ts";
import type { SuggestionMeta } from "../shared/suggest.ts";
import { mountChrome, type Chrome } from "./chrome.ts";
import { loadWordText, wordKnown } from "./dict.ts";
import { diffWords, encodeStrokes, lookupWord } from "../shared/tools.ts";
import { loadQueue, saveQueue } from "./offline.ts";
import { MB, ML, MR, MT, PAGE_H, PAGE_W, RULER_H, applyPage, currentPage } from "./layout.ts";
import { Editor, decodeCommands, encodeCommands, type RemoteCaret } from "./editor.ts";
import { openNotifyPanel, openPersonCardAt } from "./mentions.ts";
import { avatarInnerHtml, learnWallet, myWallet, refreshIdentity, resolveDisplayName, selfPerson, showSelfIdentity, watchWallet } from "../shared/person.ts";
import { mountOfflineChip } from "../shared/offline.ts";

interface InitMsg {
  t: "init";
  rev: number;
  snapshot: { text: string; runs: { n: number; s: Record<string, unknown> }[] };
  title: string;
  self: { sid: string; name: string; color: string };
  presence: RemoteCaret[];
  threads?: Thread[];
  suggestions?: SuggestionMeta[];
  page?: PageSpec;
  contentCid?: string;
  locked?: boolean;
  role?: Role;
  trashed?: boolean;
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
  return resolveDisplayName();
}

function docIdFromPath(): string | null {
  const m = routePath().match(/^\/d\/([^/]+)\/?$/);
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
  ctx.fillRect(0, 0, ML, RULER_H);
  ctx.fillRect(PAGE_W - MR, 0, MR, RULER_H);
  const mark = ML + rulerIndentPx;
  ctx.fillStyle = "#202124";
  ctx.beginPath();
  ctx.moveTo(mark, RULER_H - 2);
  ctx.lineTo(mark - 5, RULER_H - 12);
  ctx.lineTo(mark + 5, RULER_H - 12);
  ctx.closePath();
  ctx.fill();
  drawVRuler();
}

function drawVRuler(): void {
  const canvas = document.querySelector("#vruler") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 28 * dpr;
  canvas.height = PAGE_H * dpr;
  canvas.style.height = PAGE_H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 28, PAGE_H);
  ctx.fillStyle = "rgba(11,87,208,0.18)";
  ctx.fillRect(0, 0, 28, MT);
  ctx.fillRect(0, PAGE_H - MB, 28, MB);
  ctx.font = "10px Roboto, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let y = 0; y <= PAGE_H; y += 8) {
    const inch = y % 96 === 0;
    const half = y % 48 === 0;
    const w = inch ? 14 : half ? 9 : 5;
    ctx.strokeStyle = inch ? "#80868b" : "#c4c7c5";
    ctx.beginPath();
    ctx.moveTo(28, y + 0.5);
    ctx.lineTo(28 - w, y + 0.5);
    ctx.stroke();
    if (inch && y > 0) ctx.fillText(String(y / 96), 12, y);
  }
  const mark = (y: number) => {
    ctx.fillStyle = "#202124";
    ctx.beginPath();
    ctx.moveTo(26, y);
    ctx.lineTo(14, y - 5);
    ctx.lineTo(14, y + 5);
    ctx.closePath();
    ctx.fill();
  };
  mark(MT);
  mark(PAGE_H - MB);
}

let rulerIndentPx = 0;

function p2pSecret(kind: "doc" | "book", id: string): string {
  try {
    return localStorage.getItem("felarumi-secret:" + kind + ":" + id) || "";
  } catch {
    return "";
  }
}

function withWire(path: string, hash: string): string {
  return withKeptQuery(path, hash);
}

function docUrl(id: string): string {
  const path = routePath();
  const here = path === "/d/" + id || path === "/d/" + id + "/";
  const hash = (here ? location.hash.replace(/^#/, "") : "") || p2pSecret("doc", id);
  return withWire(hostBase() + "/d/" + id, hash);
}

async function mountHome(): Promise<void> {
  (document.querySelector("#home") as HTMLElement).hidden = false;
  document.title = "FiPen";
  const recent = document.querySelector("#recent") as HTMLElement;
  const blank = document.querySelector("#blank") as HTMLButtonElement;
  blank.addEventListener("click", async () => {
    const res = await fetch("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await res.json()) as { id: string };
    location.href = docUrl(body.id);
  });
  const docs = (await fetch("/api/docs").then((r) => r.json())) as { id: string; title: string; updated: number }[];
  const trashed = (await fetch("/api/docs?trash=1").then((r) => r.json())) as { id: string; title: string; updated: number }[];
  recent.innerHTML = "";
  if (!docs.length) recent.innerHTML = "<li class='empty'>No documents yet.</li>";
  for (const doc of docs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = docUrl(doc.id);
    const name = document.createElement("span");
    name.textContent = doc.title;
    const time = document.createElement("time");
    time.dateTime = new Date(doc.updated).toISOString();
    time.textContent = new Date(doc.updated).toLocaleString();
    a.append(name, time);
    li.appendChild(a);
    recent.appendChild(li);
  }
  const trash = document.querySelector("#trash") as HTMLElement;
  trash.innerHTML = "";
  if (!trashed.length) trash.innerHTML = "<li class='empty'>Trash is empty.</li>";
  for (const doc of trashed) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = docUrl(doc.id);
    a.textContent = doc.title;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => {
      void fetch("/api/docs/" + encodeURIComponent(doc.id) + "/restore", { method: "POST" }).then(() => location.reload());
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void fetch("/api/docs/" + encodeURIComponent(doc.id), { method: "DELETE" }).then(() => location.reload());
    });
    li.append(a, restore, remove);
    trash.appendChild(li);
  }
}

function mountEditor(id: string, shareToken = ""): void {
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
  let showRuler = true;
  let showOutline = false;
  let spellAt = 0;
  let ws: WebSocket | null = null;
  let chrome: Chrome;
  let anchorWait: (() => void) | null = null;
  const people = () => [{ sid: session, name: displayName(), color: editor.color }, ...editor.remotes.values()];
  const lastPointer = { x: 0, y: 0 };
  document.addEventListener("pointerdown", (e) => Object.assign(lastPointer, { x: e.clientX, y: e.clientY }), true);
  /** After an @-mention (or Notify on a card): offer to notify them. Sending needs the user's click. */
  const notifyPerson = (address: string) => {
    if (address === myWallet()) return;
    openNotifyPanel(address, { docTitle: () => title.value, docUrl: () => location.href, toast });
  };
  const api = {
    ready: false,
    getText: () => editor.getText(),
    setSelection: (a: number, b: number) => editor.setSelection(a, b),
    selection: () => ({ anchor: editor.anchor, head: editor.head }),
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
    paraAt: (index: number) => editor.paraAt(index),
    toggleBold: () => editor.toggleMark("b"),
    dirty: () => editor.dirty(),
    /** The doc as this client sees it (unacked edits included), for a guest's "Save a copy" while the owner is away. */
    copyState: () => ({
      raw: JSON.stringify({ kind: "felarumi-p2p", title: title.value, snapshot: snapshotDoc(editor.doc) }),
      title: title.value,
      rev: editor.sync.rev,
      dirty: editor.dirty(),
    }),
    headings: () => editor.headings(),
    misspelled: () => editor.misspelledWords(),
    showOutline: () => setOutline(true),
    page: () => currentPage(),
    setHeading: (h: Heading) => editor.setHeading(h),
    setMode: (mode: "edit" | "suggest" | "view") => editor.setMode(mode),
    mode: () => editor.mode,
    suggestions: () => editor.suggestionCards().map((card) => ({ id: card.id, kind: card.kind, quote: card.quote })),
    acceptSuggestion: (id: string) => editor.acceptSuggestion(id),
    setPageless: (on: boolean) => setPageless(on),
    insertFootnote: (text: string) => editor.insertFootnote(text),
    spacing: () => editor.paragraphSpacing(),
    setColumns: (cols: 1 | 2 | 3) => editor.setColumns(cols),
    insertSection: (kind: "cont" | "next") => editor.insertSection(kind),
    applyCase: (mode: "lower" | "upper" | "title") => editor.applyCase(mode),
    insertEquation: (src: string) => editor.insertEquation(src),
    insertImage: (src: string, alt: string, w: number, h: number) => editor.insertImage(src, alt, w, h),
    setImageRotation: (index: number, rot: number) => editor.setImageRotation(index, rot),
    role: () => editor.role,
    insertCitation: (author: string, year: string, title: string) => editor.insertCitation(author, year, title),
    insertChart: (label: string) => editor.insertChart(label),
    insertDrawing: (src: string) => editor.insertDrawing(src),
    insertBibliography: () => editor.insertBibliography(),
    setWatermark: (text: string) => {
      usePage({ ...currentPage(), watermark: text });
      editor.render();
      sendPage();
    },
    lookup: (word: string) => lookupWord(word),
    diffWords: (before: string, after: string) => diffWords(before, after),
    signed: () => docIsSigned(editor.doc) || editor.anchorLock || !!editor.contentCid,
    contentCid: () => editor.contentCid,
    signatures: () => signatureRows(),
    signatureBoxes: () => editor.signatureBoxes(),
    forceText: (text: string) => editor.forceText(text),
    signWithCid: (name: string, contentCid: string) => signDocument(name, contentCid),
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
    if (!document.documentElement.dataset.saveOwner) status.textContent = live ? (editor.dirty() ? "Saving…" : "All changes saved") : "Offline, changes will sync";
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
    const spacing = document.querySelector("#spacing") as HTMLSelectElement;
    const lh = String(state.lh);
    spacing.value = [...spacing.options].some((o) => o.value === lh) ? lh : "custom";
    setSelect("font", state.font);
    const size = document.querySelector("#size") as HTMLSelectElement;
    const sizeText = String(state.size);
    if ([...size.options].some((o) => o.value === sizeText)) size.value = sizeText;
    document.title = (title.value || "Untitled document") + " - FiPen";
    syncMode();
    syncSigned();
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
      syncCommentBubble();
    },
    onPaint: () => {
      rulerIndentPx = editor.leftIndent() * 36;
      (document.querySelector("#ruler") as HTMLElement).classList.toggle("off", !showRuler);
      (document.querySelector("#vruler") as HTMLElement).classList.toggle("off", !showRuler);
      if (showRuler) drawRuler();
      renderOutline();
      chrome?.refresh();
    },
    onContext: (x, y, index) => openContext(x, y, index),
    onCommand: (name) => {
      if (name === "find") chrome.openFind(false);
      else if (name === "replace") chrome.openFind(true);
      else if (name === "link") chrome.openLink();
      else if (name === "comment") chrome.openComment();
      else if (name === "wordcount") chrome.openWordCount();
      else if (name === "shortcuts") chrome.openShortcuts();
      else if (name === "saved") toast("All changes saved");
      else if (name === "paste-plain") void pastePlain();
      else if (name === "import") (document.querySelector("#import-file") as HTMLInputElement).click();
      else if (name === "print") openPrintPreview();
      else if (name === "menu-search") openMenuSearch();
      else if (name === "footnote") openFootnoteInsert();
    },
    onAt: (query) => chrome.syncAt(query),
    atKey: (e) => chrome.atKey(e),
    onEmbed: (index) => {
      const st = editor.styleAt(index);
      if (st.embed === "drop") chrome.showDropdown(index);
      else if (st.embed === "fn") openFootnote(index);
      else if (st.embed === "img") openAlt(index);
      else if (st.embed === "eq") openEquation(index);
      else if (st.embed === "sig") openSignatureDetails(index);
      else if (st.embed === "person") openPersonCardAt(lastPointer.x, lastPointer.y, st.addr, st.label || "Person", notifyPerson);
    },
    onSuggestion: (meta) => send({ t: "suggest", suggestion: meta }),
    onMargin: (which) => openMargin(which),
  });
  editor.name = displayName();
  chrome = mountChrome(editor, {
    send: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    toast,
    people,
    participants: () => {
      const out = [...editor.remotes.values()].filter((r) => r.addr).map((r) => ({ address: r.addr!, name: r.name }));
      for (const st of editor.doc.styles) if (st?.embed === "person" && st.addr) out.push({ address: st.addr, name: st.label || "" });
      return out;
    },
    onMention: (address) => notifyPerson(address),
    // Peer-hosted docs: only the owner resolves. The server build keeps its own access rules.
    canResolve: () =>
      !(window as unknown as { __FELARUMI_P2P__?: boolean }).__FELARUMI_P2P__ || localStorage.getItem("felarumi-owner:doc:" + id) === "1",
  });

  const applyZoom = (z: number) => {
    zoom = Math.min(2, Math.max(0.5, z));
    (stack.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
    (document.querySelector("#zoom") as HTMLSelectElement).value = String(nearestZoom(zoom));
    editor.render();
  };

  nameBtn.textContent = displayName();
  const renameSelf = () => {
    nameBtn.textContent = displayName();
    editor.name = displayName();
    ws?.send(JSON.stringify({ t: "name", name: displayName() }));
    paintAvatars(editor, session);
  };
  void learnWallet().then(async (changed) => {
    if (changed) renameSelf();
    if (await refreshIdentity(myWallet())) renameSelf();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "fifolders:display-name" || event.key?.startsWith("fil-identity:")) renameSelf();
  });
  // Wallet account/network switch: rename in place for peers, no reload or prompt.
  (window as unknown as { __walletSwitch?: (a: string[]) => Promise<void> }).__walletSwitch = watchWallet(renameSelf);
  mountOfflineChip();

  // Touch: a floating Comment bubble over a selection (desktop uses the right-click menu).
  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.id = "comment-bubble";
  bubble.textContent = "💬 Comment";
  bubble.hidden = true;
  bubble.style.cssText = "position:fixed;z-index:70;padding:6px 12px;border-radius:16px;border:1px solid #dadce0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);font:500 14px system-ui,sans-serif";
  document.body.append(bubble);
  let lastPoint = { x: 0, y: 0 };
  document.addEventListener("pointerup", (ev) => {
    lastPoint = { x: ev.clientX, y: ev.clientY };
  });
  bubble.addEventListener("pointerdown", (ev) => ev.preventDefault());
  bubble.addEventListener("click", () => {
    bubble.hidden = true;
    chrome.openComment();
  });
  const touchy = () => window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  function syncCommentBubble(): void {
    const show = touchy() && editor.anchor !== editor.head && editor.role !== "view";
    bubble.hidden = !show;
    if (!show) return;
    bubble.style.left = Math.max(8, Math.min(lastPoint.x - 50, window.innerWidth - 130)) + "px";
    bubble.style.top = Math.max(8, lastPoint.y - 56) + "px";
  }
  const localRename = () => {
    const next = window.prompt("Name shown on your cursor", displayName());
    if (!next) return;
    sessionStorage.setItem("felarumi-name", next.trim().slice(0, 40) || "Guest");
    renameSelf();
  };
  const showIdentity = (anchor: HTMLElement) => showSelfIdentity(anchor, localRename);
  nameBtn.addEventListener("click", () => showIdentity(nameBtn));
  (window as unknown as { __showIdentity?: (el: HTMLElement) => void }).__showIdentity = showIdentity;

  title.addEventListener("change", () => sendTitle());
  title.addEventListener("input", () => {
    document.title = title.value + " - FiPen";
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

  document.querySelector("#share")!.addEventListener("click", () => {
    openShare();
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
          location.href = docUrl(body.id);
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
        .then((body: { id: string }) => window.open(docUrl(body.id), "_blank", "noopener"));
    },
    "download-felarumi": () => saveFile(safeName(title.value, ".fipen"), new Blob([toFelarumi(title.value, editor.doc, editor.threads)], { type: "application/json" })),
    "download-docx": () => void toDocx(editor.doc).then((buf) => saveFile(safeName(title.value, ".docx"), new Blob([buf as BlobPart]))),
    "download-odt": () => void toOdt(editor.doc).then((buf) => saveFile(safeName(title.value, ".odt"), new Blob([buf as BlobPart]))),
    "download-html": () => saveFile(safeName(title.value, ".html"), new Blob([toHtml(editor.doc, title.value)], { type: "text/html" })),
    "download-txt": () => saveFile(safeName(title.value, ".txt"), new Blob([toText(editor.doc)], { type: "text/plain" })),
    "download-md": () => saveFile(safeName(title.value, ".md"), new Blob([toMarkdown(editor.doc)], { type: "text/markdown" })),
    "download-pdf": () => saveFile(safeName(title.value, ".pdf"), new Blob([toPdf(editor.doc, title.value) as BlobPart], { type: "application/pdf" })),
    import: () => (document.querySelector("#import-file") as HTMLInputElement).click(),
    print: () => openPrintPreview(),
    trash: () => void moveToTrash(),
    "page-setup": () => openPageSetup(),
    "paste-plain": () => void pastePlain(),
    delete: () => editor.insertText(""),
    ruler: () => {
      showRuler = !showRuler;
      syncView();
    },
    outline: () => setOutline(!showOutline),
    invisibles: () => {
      editor.invisibles = !editor.invisibles;
      editor.render();
      syncView();
    },
    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    },
    compact: () => {
      document.body.classList.toggle("compact");
      syncView();
    },
    spelling: () => openSpelling(),
    dictionary: () => openDictionary(),
    lookup: () => openLookup(),
    compare: () => openCompare(),
    watermark: () => openWatermark(),
    chart: () => openChart(),
    drawing: () => openDrawing(),
    citation: () => openCitation(),
    bibliography: () => editor.insertBibliography(),
    preferences: () => openPreferences(),
    addons: () => openDialog("Add-ons", "FiPen does not run third-party add-ons or scripts."),
    "menu-search": () => openMenuSearch(),
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
    "section-next": () => editor.insertSection("next"),
    "section-cont": () => editor.insertSection("cont"),
    equation: () => openEquation(),
    chars: () => openCharacters(),
    "cols-1": () => editor.setColumns(1),
    "cols-2": () => editor.setColumns(2),
    "cols-3": () => editor.setColumns(3),
    "case-lower": () => editor.applyCase("lower"),
    "case-upper": () => editor.applyCase("upper"),
    "case-title": () => editor.applyCase("title"),
    "small-caps": () => editor.toggleMark("sc"),
    rule: () => editor.insertRule(),
    table: () => editor.insertTable(3, 3),
    image: () => chrome.openImage(),
    link: () => chrome.openLink(),
    vote: () => editor.insertVote("👍"),
    person: () => editor.insertEmbed({ embed: "person", label: displayName() }),
    date: () => editor.insertEmbed({ embed: "date", iso: new Date().toISOString().slice(0, 10) }),
    dropdown: () => editor.insertEmbed({ embed: "drop", opts: JSON.stringify(["Yes", "No", "Maybe"]), val: "Yes" }),
    signature: () => openSignature(),
    "verify-cid": () => openVerifyCid(),
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
    h3: () => editor.setHeading("h3"),
    h4: () => editor.setHeading("h4"),
    h5: () => editor.setHeading("h5"),
    h6: () => editor.setHeading("h6"),
    spacing: () => openSpacing(),
    header: () => openMargin("header"),
    footer: () => openMargin("footer"),
    "page-number": () => insertPageNumber(),
    footnote: () => openFootnoteInsert(),
    toc: () => editor.insertToc(),
    "toc-update": () => editor.updateToc(),
    bookmark: () => toast("Bookmark " + editor.addBookmark()),
    "heading-link": () => openHeadingLink(),
    pageless: () => setPageless(!currentPage().pageless),
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
  document.querySelector("#image-btn")!.addEventListener("click", () => chrome.openImage());
  document.querySelector("#comment")!.addEventListener("click", () => chrome.openComment());
  document.querySelector("#signature")!.addEventListener("click", () => openSignature());
  document.querySelector("#paint")!.addEventListener("click", () => editor.copyFormatting());
  document.querySelector("#clear")!.addEventListener("click", () => editor.clearFormatting());
  document.querySelector("#indent")!.addEventListener("click", () => editor.indent(1));
  document.querySelector("#outdent")!.addEventListener("click", () => editor.indent(-1));
  (document.querySelector("#spacing") as HTMLSelectElement).addEventListener("change", (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    if (value === "custom") openSpacing();
    else editor.setLineSpacing(Number(value));
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
  let compareWait: ((body: { left: string; right: string }) => void) | null = null;
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
    fillCompare(rows);
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
      ws?.send(JSON.stringify({ t: "hello", sid: session, name: displayName(), addr: myWallet() || undefined, resume, since: resume ? queued!.baseRev : undefined, share: shareToken || undefined }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (msg.t === "init") onInit(msg as unknown as InitMsg);
      else if (msg.t === "op") {
        try {
          editor.applyRemote(decodeCommands(msg.commands as Command[]), String(msg.sid), Number(msg.rev), Number(msg.reqId));
        } catch (err) {
          console.error(err);
          ws?.send(JSON.stringify({ t: "hello", sid: session, name: displayName(), addr: myWallet() || undefined, share: shareToken || undefined }));
        }
      } else if (msg.t === "ack") editor.ack(Number(msg.reqId), (msg.assignedRev as number | null) ?? null, Number(msg.serverRev));
      else if (msg.t === "sel") {
        editor.setRemote({
          sid: String(msg.sid),
          name: String(msg.name || "Guest"),
          color: String(msg.color || "#188038"),
          addr: typeof msg.addr === "string" ? msg.addr : undefined,
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
          addr: typeof msg.addr === "string" ? msg.addr : existing?.addr,
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
      } else if (msg.t === "compare") {
        const body = { left: String(msg.left || ""), right: String(msg.right || "") };
        if (compareWait) {
          compareWait(body);
          compareWait = null;
        }
      } else if (msg.t === "page") {
        usePage(msg.page);
        editor.render();
      } else if (msg.t === "suggest") {
        editor.upsertSuggestion(msg.suggestion as SuggestionMeta);
      } else if (msg.t === "named") {
        if (nameWait) {
          nameWait(Number(msg.rev));
          nameWait = null;
        }
        toast("Named this version");
        if (!(document.querySelector("#history") as HTMLElement).hidden) send({ t: "history" });
      } else if (msg.t === "reject") {
        console.warn("op rejected", msg.error);
      } else if (msg.t === "anchor") {
        const cid = typeof msg.contentCid === "string" ? msg.contentCid : "";
        editor.setAnchor(cid, msg.locked !== false || !!cid);
        syncSigned();
        if (anchorWait) {
          const resume = anchorWait;
          anchorWait = null;
          resume();
        }
      } else if (msg.t === "access") {
        const next = msg.role === "view" || msg.role === "comment" ? msg.role : "edit";
        applyAccess(next, false);
        if (next === "edit") editor.setMode("edit");
        const wait = document.querySelector("#p2p-wait") as HTMLElement | null;
        if (wait) {
          wait.hidden = next === "edit";
          if (typeof msg.banner === "string" && next !== "edit") wait.textContent = msg.banner;
        }
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
    editor.setSuggestions(msg.suggestions || []);
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
    if (msg.page) usePage(msg.page);
    const resume = msg.resume === true && editor.dirty() && !editor.sync.transformed;
    if (resume) {
      try {
        for (const op of msg.catchup || []) editor.applyRemote(decodeCommands(op.commands), op.sid, op.rev, op.reqId);
      } catch (err) {
        console.error(err);
        editor.load(msg.snapshot as InitMsg["snapshot"] & { runs: { n: number; s: never }[] }, msg.rev);
        void saveQueue(id, null);
        applyPresence(msg);
        applyAccess(msg.role || "edit", msg.trashed === true);
        applyAnchorMsg(msg);
        pump();
        void maybeVerifyLocation();
        return;
      }
      applyPresence(msg);
      applyAccess(msg.role || "edit", msg.trashed === true);
      applyAnchorMsg(msg);
      editor.sync.resend();
      pump();
      void persistQueue();
      void maybeVerifyLocation();
      return;
    }
    editor.load(msg.snapshot as InitMsg["snapshot"] & { runs: { n: number; s: never }[] }, msg.rev);
    void saveQueue(id, null);
    applyPresence(msg);
    applyAccess(msg.role || "edit", msg.trashed === true);
    applyAnchorMsg(msg);
    pump();
    void maybeVerifyLocation();
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
    if (name.endsWith(".fipen") || name.endsWith(".felarumi") || name.endsWith(".json")) importBundle(fromFelarumi(await file.text()));
    else if (name.endsWith(".docx")) editor.replaceDocument(await fromDocx(new Uint8Array(await file.arrayBuffer())));
    else if (name.endsWith(".md") || name.endsWith(".markdown")) editor.replaceDocument(fromMarkdown(await file.text()));
    else if (name.endsWith(".html") || name.endsWith(".htm")) editor.replaceDocument(fromHtml(await file.text()));
    else editor.replaceDocument(fromPlain(await file.text()));
    editor.focus();
  }

  function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function applyAccess(role: Role, trashed: boolean): void {
    editor.setRole(trashed ? "view" : role);
    (document.querySelector("#trash-banner") as HTMLElement).hidden = !trashed;
    syncMode();
    void loadTabs();
  }

  async function loadTabs(): Promise<void> {
    const rows = (await fetch("/api/docs/" + encodeURIComponent(id) + "/tabs").then((r) => r.json())) as { id: string; title: string }[];
    const bar = document.querySelector("#tabs") as HTMLElement;
    bar.hidden = false;
    bar.replaceChildren();
    for (const tab of rows) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab";
      btn.textContent = tab.title || "Tab";
      if (tab.id === id) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", () => {
        if (tab.id !== id) location.href = docUrl(tab.id);
      });
      btn.addEventListener("dblclick", () => {
        const next = window.prompt("Rename tab", tab.title);
        if (!next?.trim() || editor.role !== "edit") return;
        void fetch("/api/docs/" + encodeURIComponent(tab.id) + "/tab", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: next.trim() }),
        }).then(() => loadTabs());
      });
      bar.append(btn);
    }
    if (editor.role === "edit") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "icon";
      add.title = "Add tab";
      add.innerHTML = '<span class="material-symbols-outlined">add</span>';
      add.addEventListener("click", () => {
        void fetch("/api/docs/" + encodeURIComponent(id) + "/tabs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
          .then((r) => r.json())
          .then((body: { id: string }) => {
            location.href = docUrl(body.id);
          });
      });
      bar.append(add);
    }
  }

  function openPrintPreview(): void {
    document.body.classList.add("print-preview");
    const bar = document.querySelector("#print-preview") as HTMLElement;
    bar.hidden = false;
    (document.querySelector("#print-pages") as HTMLElement).textContent = document.querySelectorAll(".page").length + " pages";
  }

  async function moveToTrash(): Promise<void> {
    await fetch("/api/docs/" + encodeURIComponent(id) + "/trash", { method: "POST" });
    location.href = "/";
  }

  function openShare(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "copy-link";
    btn.textContent = "🔗 Copy Link";
    btn.addEventListener("click", () => {
      const url = location.origin + docUrl(id);
      void navigator.clipboard
        .writeText(url)
        .then(() => {
          btn.textContent = "Copied";
          toast("Copied");
          window.setTimeout(() => (btn.textContent = "🔗 Copy Link"), 1500);
        })
        .catch(() => toast(url));
    });
    wrap.append(btn);
    openDialog("Share", wrap);
  }

  function openEquation(index?: number): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Use ^ and _ for scripts, \\frac{a}{b}, \\sqrt{x}, and names like \\pi.";
    const input = document.createElement("textarea");
    input.rows = 3;
    input.value = index == null ? "E=mc^2" : editor.styleAt(index).label || "";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = index == null ? "Insert" : "Update";
    save.addEventListener("click", () => {
      if (index == null) editor.insertEquation(input.value);
      else editor.setEquation(index, input.value);
      closeDialog();
      editor.focus();
    });
    wrap.append(hint, input, save);
    openDialog(index == null ? "Insert equation" : "Edit equation", wrap);
  }

  function openCharacters(): void {
    const groups = [
      ["Punctuation", "—–…·•“”‘’«»¿¡§¶†‡"],
      ["Symbols", "©®™°‰★☆♠♣♥♦♪♫✓✗"],
      ["Arrows", "←→↑↓↔⇒⇐⇔▲▼▶◀"],
      ["Math", "±×÷≠≤≥≈∞√∑∫∂πµ"],
      ["Currency", "$€£¥¢₹₩₽"],
      ["Latin", "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ"],
    ];
    const wrap = document.createElement("div");
    const search = document.createElement("input");
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search characters");
    const grid = document.createElement("div");
    grid.className = "char-grid";
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      grid.replaceChildren();
      for (const [name, chars] of groups) {
        if (q && !name.toLowerCase().includes(q) && ![...chars].some((ch) => ch.toLowerCase() === q)) continue;
        for (const ch of chars) {
          if (q && q.length === 1 && ch.toLowerCase() !== q && !name.toLowerCase().includes(q)) continue;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = ch;
          btn.title = name;
          btn.addEventListener("click", () => {
            editor.insertText(ch);
            closeDialog();
            editor.focus();
          });
          grid.append(btn);
        }
      }
    };
    search.addEventListener("input", paint);
    wrap.append(search, grid);
    paint();
    openDialog("Special characters", wrap);
    window.setTimeout(() => search.focus(), 0);
  }

  function openDialog(title: string, node: string | HTMLElement): void {
    (document.querySelector("#dialog-title") as HTMLElement).textContent = title;
    const body = document.querySelector("#dialog-body") as HTMLElement;
    body.replaceChildren();
    if (typeof node === "string") {
      const p = document.createElement("p");
      p.textContent = node;
      body.appendChild(p);
    } else body.appendChild(node);
    (document.querySelector("#dialog") as HTMLElement).hidden = false;
  }

  function closeDialog(): void {
    (document.querySelector("#dialog") as HTMLElement).hidden = true;
  }

  async function pastePlain(): Promise<void> {
    try {
      editor.pastePlain(await navigator.clipboard.readText());
    } catch {
      toast("Allow clipboard access to paste");
    }
  }

  function syncView(): void {
    const set = (act: string, on: boolean) => document.querySelector(`[data-act="${act}"]`)?.setAttribute("aria-pressed", on ? "true" : "false");
    set("ruler", showRuler);
    set("outline", showOutline);
    set("invisibles", editor.invisibles);
    set("compact", document.body.classList.contains("compact"));
    set("pageless", currentPage().pageless);
    (document.querySelector("#ruler") as HTMLElement).classList.toggle("off", !showRuler);
    (document.querySelector("#vruler") as HTMLElement).classList.toggle("off", !showRuler);
  }

  function usePage(input: unknown) {
    const page = applyPage(input);
    document.body.classList.toggle("pageless", page.pageless);
    return page;
  }

  function setPageless(on: boolean): void {
    usePage({ ...currentPage(), pageless: on });
    editor.render();
    sendPage();
    syncView();
  }

  function p2pApi(): {
    putUnsigned?: (bytes: Uint8Array) => Promise<string>;
    fetchCid?: (cid: string) => Promise<Uint8Array>;
    pieceCidOf?: (bytes: Uint8Array) => Promise<string>;
    network?: () => string;
  } | undefined {
    return (window as unknown as { __p2p?: ReturnType<typeof p2pApi> }).__p2p;
  }

  function applyAnchorMsg(msg: { contentCid?: unknown; locked?: unknown }): void {
    const cid = typeof msg.contentCid === "string" ? msg.contentCid : "";
    editor.setAnchor(cid, msg.locked === true || !!cid || docIsSigned(editor.doc));
  }

  function waitForAnchor(sendNow: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (anchorWait) anchorWait = null;
        reject(new Error("The owner did not anchor the document"));
      }, 10000);
      anchorWait = () => {
        window.clearTimeout(timer);
        resolve();
      };
      sendNow();
    });
  }

  function syncSigned(): void {
    const banner = document.querySelector("#sign-banner") as HTMLElement | null;
    if (!banner) return;
    const locked = docIsSigned(editor.doc) || editor.anchorLock || !!editor.contentCid;
    banner.hidden = !locked;
    if (locked) banner.textContent = "Signed, locked for edits";
  }

  function signatureRows(): { index: number; name: string; address: string; hash: string; signature: string; chainId: string; contentCid: string; verified: boolean }[] {
    const hash = contentHashOf(editor.doc);
    const out: { index: number; name: string; address: string; hash: string; signature: string; chainId: string; contentCid: string; verified: boolean }[] = [];
    for (let i = 0; i < editor.doc.text.length; i++) {
      const style = editor.doc.styles[i];
      if (editor.doc.text[i] !== "\uFFFC" || style?.embed !== "sig") continue;
      const stored = readStored(style, id);
      out.push({
        index: i,
        name: style.label || "",
        address: style.alt || "",
        hash: style.val || "",
        signature: style.src || "",
        chainId: style.opts || "",
        contentCid: style.cid || "",
        verified: verifyStored(style, id, hash, editor.contentCid) == null && !!stored,
      });
    }
    return out;
  }

  function signingChainId(): number {
    const api = (window as unknown as { __p2p?: { network?: () => string } }).__p2p;
    let network = "mainnet";
    try {
      network = api?.network?.() || sessionStorage.getItem("felarumi-filecoin-net") || "mainnet";
    } catch {
      network = "mainnet";
    }
    return chainIdFor(network);
  }

  function openSignature(): void {
    const wrap = document.createElement("div");
    wrap.id = "sig-form";
    const input = document.createElement("input");
    input.id = "sig-name";
    input.placeholder = "Written name";
    input.value = displayName() === "Guest" ? "" : displayName();
    const go = document.createElement("button");
    go.type = "button";
    go.id = "sig-sign";
    go.textContent = "Sign with wallet";
    go.addEventListener("click", () => {
      go.disabled = true;
      void signDocument(input.value).then(
        () => undefined,
        (err: unknown) => {
          go.disabled = false;
          toast(err instanceof Error ? err.message : "Wallet signature failed");
        },
      );
    });
    wrap.append(input, go);
    openDialog("Signature", wrap);
    window.setTimeout(() => input.focus(), 0);
  }

  async function signDocument(name: string, overrideCid?: string): Promise<void> {
    const written = name.trim().slice(0, 80);
    if (!written) throw new Error("Type your name");
    const eth = (window as unknown as { ethereum?: { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth?.request) throw new Error("Connect a wallet such as MetaMask");
    let contentCid = overrideCid || editor.contentCid;
    if (!overrideCid && !contentCid) {
      const put = p2pApi()?.putUnsigned;
      if (!put) throw new Error("Signing needs the peer host storage adapter");
      editor.setAnchor("", true);
      try {
        await waitForAnchor(() => send({ t: "anchor", phase: "freeze" }));
      } catch (err) {
        editor.setAnchor("", false);
        send({ t: "anchor", phase: "abort" });
        throw err;
      }
      if (!editor.contentCid) {
        try {
          contentCid = await put(unsignedBytes(editor.doc));
        } catch (err) {
          editor.setAnchor("", false);
          send({ t: "anchor", phase: "abort" });
          throw err;
        }
        await waitForAnchor(() => send({ t: "anchor", phase: "cid", contentCid }));
        if (editor.contentCid !== contentCid) throw new Error("content cid mismatch");
      } else {
        contentCid = editor.contentCid;
      }
    }
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    const signer = normalizeAddress(accounts?.[0] || "");
    const fields = {
      docId: id,
      contentHash: contentHashOf(editor.doc),
      contentCid,
      signerName: written,
      signer,
      timestamp: BigInt(Date.now()),
      chainId: signingChainId(),
    };
    const signature = String(await eth.request({ method: "eth_signTypedData_v4", params: [signer, typedDataJson(fields)] }));
    editor.insertSignature(signatureAttrs({ ...fields, signature }));
    closeDialog();
  }

  function copyButton(value: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(value).then(() => toast("Copied")).catch(() => toast("Allow clipboard access to copy"));
    });
    return button;
  }

  function openSignatureDetails(index: number): void {
    const stored = readStored(editor.styleAt(index), id);
    if (!stored) return;
    const hash = contentHashOf(editor.doc);
    const verified = verifyStored(editor.styleAt(index), id, hash, editor.contentCid || stored.contentCid) == null;
    const wrap = document.createElement("div");
    wrap.id = "sig-details";
    const rows: [string, string][] = [
      ["Name", stored.signerName],
      ["Address", stored.signer],
      ["Chain", chainLabel(stored.chainId)],
      ["Timestamp", new Date(Number(stored.timestamp)).toISOString()],
      ["Content hash", stored.contentHash],
      ["Content CID", stored.contentCid],
      ["Signature", stored.signature],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = label;
      const span = document.createElement("span");
      span.textContent = value;
      row.append(strong, span, copyButton(value));
      wrap.append(row);
    }
    const verifiedLine = document.createElement("p");
    verifiedLine.id = "sig-verified";
    verifiedLine.textContent = verified ? "Verified" : "Not verified";
    const pre = document.createElement("pre");
    pre.id = "sig-typed";
    pre.textContent = typedDataJson(stored);
    wrap.append(verifiedLine, pre, copyButton(pre.textContent));
    openDialog("Signature", wrap);
  }

  function openVerifyCid(): void {
    const wrap = document.createElement("div");
    wrap.id = "verify-form";
    const input = document.createElement("input");
    input.id = "verify-cid";
    input.value = editor.contentCid;
    const go = document.createElement("button");
    go.type = "button";
    go.id = "verify-go";
    go.textContent = "Verify";
    const out = document.createElement("div");
    out.id = "verify-signers";
    go.addEventListener("click", () => {
      void renderVerify(input.value.trim(), out).catch((err: unknown) => {
        out.textContent = err instanceof Error ? err.message : "Verification failed";
      });
    });
    wrap.append(input, go, out);
    openDialog("Verify from CID", wrap);
  }

  async function renderVerify(cid: string, host: HTMLElement): Promise<void> {
    if (!cid) throw new Error("Enter a content CID");
    const api = p2pApi();
    if (!api?.fetchCid || !api.pieceCidOf) throw new Error("Storage is not available");
    let bytes = await api.fetchCid(cid);
    let text = new TextDecoder().decode(bytes);
    let requested = cid;
    let source = editor.doc;
    if (text.includes('"felarumi-p2p"')) {
      const parsed = JSON.parse(text) as { contentCid?: string; snapshot?: Parameters<typeof restoreDoc>[0] };
      if (!parsed.contentCid || !parsed.snapshot) throw new Error("This file has no content CID");
      requested = parsed.contentCid;
      source = restoreDoc(parsed.snapshot);
      bytes = await api.fetchCid(requested);
      text = new TextDecoder().decode(bytes);
    }
    const unsigned = docFromCanonical(text);
    if (!unsigned) throw new Error("The CID is not a canonical unsigned snapshot");
    const hash = hashBytes(bytes);
    const recomputed = await api.pieceCidOf(bytes);
    const cidOk = recomputed === requested && canonicalUnsigned(unsigned) === text && hash === contentHashOf(unsigned);
    const docForSigs = editor.contentCid === requested ? editor.doc : source;
    host.id = "verify-signers";
    host.replaceChildren();
    const match = document.createElement("p");
    match.id = "verify-cid-match";
    match.textContent = cidOk ? "CID matches" : "CID does not match";
    host.append(match);
    const cidLine = document.createElement("p");
    cidLine.textContent = requested;
    host.append(cidLine);
    let any = false;
    for (let i = 0; i < docForSigs.text.length; i++) {
      const style = docForSigs.styles[i];
      if (docForSigs.text[i] !== "\uFFFC" || style?.embed !== "sig") continue;
      any = true;
      const err = verifyStored(style, id, hash, requested);
      const row = document.createElement("p");
      row.textContent = `${style.label || "Signed"} ${style.alt || ""} ${err ? err : "Verified"}`;
      host.append(row);
    }
    if (!any) {
      const empty = document.createElement("p");
      empty.textContent = "No signatures";
      host.append(empty);
    }
  }

  async function maybeVerifyLocation(): Promise<void> {
    const cid = new URLSearchParams(location.search).get("cid");
    if (!cid || !p2pApi()?.fetchCid) return;
    try {
      const bytes = await p2pApi()!.fetchCid!(cid);
      const text = new TextDecoder().decode(bytes);
      if (text.includes('"felarumi-p2p"')) {
        const parsed = JSON.parse(text) as { contentCid?: string };
        if (!parsed.contentCid) return;
      } else if (!text.includes('"runs"')) return;
      const host = document.createElement("div");
      openDialog("Verify from CID", host);
      await renderVerify(cid, host);
    } catch {
      /* a file-export cid is not a content commitment */
    }
  }

  function syncMode(): void {
    const mode = editor.mode;
    const select = document.querySelector("#mode") as HTMLSelectElement | null;
    if (select && select.value !== mode) select.value = mode;
    const banner = document.querySelector("#mode-banner") as HTMLElement | null;
    if (!banner) return;
    banner.hidden = mode === "edit";
    banner.classList.toggle("viewing", mode === "view");
    banner.textContent =
      editor.role === "comment"
        ? "Commenting. Suggestions stay marked until an editor accepts them."
        : editor.role === "view"
          ? "Viewing. This document is read-only."
          : mode === "suggest"
            ? "Suggesting. Insertions and deletions stay marked until someone accepts them."
            : "Viewing. This document is read-only until you switch back to Editing.";
  }

  function setOutline(on: boolean): void {
    showOutline = on;
    document.body.classList.toggle("outline-open", on);
    syncView();
    renderOutline();
  }

  function renderOutline(): void {
    const aside = document.querySelector("#outline") as HTMLElement;
    aside.hidden = !showOutline;
    if (!showOutline) return;
    const list = document.querySelector("#outline-list") as HTMLElement;
    const heads = editor.headings();
    const sig = heads.map((h) => h.level + ":" + h.text).join("|");
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren();
    if (!heads.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Headings you apply show up here.";
      list.appendChild(li);
      return;
    }
    for (const heading of heads) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = heading.text;
      btn.style.paddingLeft = 8 + heading.level * 14 + "px";
      btn.addEventListener("click", () => editor.jumpTo(heading.index));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function sendPage(): void {
    send({ t: "page", page: currentPage(), ts: Date.now() });
  }

  function openSpacing(): void {
    const cur = editor.paragraphSpacing();
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Line spacing <input id="sp-lh" type="number" min="0.5" max="3" step="0.05" value="${cur.lh}"></label>
      <label>Before <input id="sp-sb" type="number" min="0" max="72" step="1" value="${cur.sb}"> pt</label>
      <label>After <input id="sp-sa" type="number" min="0" max="72" step="1" value="${cur.sa}"> pt</label>
      <button type="button" id="sp-apply">Apply</button>`;
    openDialog("Line and paragraph spacing", wrap);
    wrap.querySelector("#sp-apply")!.addEventListener("click", () => {
      const num = (id: string) => Number((wrap.querySelector(id) as HTMLInputElement).value);
      editor.setSpacing(num("#sp-lh"), num("#sp-sb"), num("#sp-sa"));
      closeDialog();
      editor.focus();
    });
  }

  function openMargin(which: "header" | "footer"): void {
    const page = currentPage();
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const main = which === "header" ? page.header : page.footer;
    const first = which === "header" ? page.headerFirst : page.footerFirst;
    wrap.innerHTML = `<label>${which === "header" ? "Header" : "Footer"} <input id="hf-main" value="${escapeAttr(main)}"></label>
      <label><input id="hf-diff" type="checkbox"> Different first page</label>
      <label>First page <input id="hf-first" value="${escapeAttr(first)}"></label>
      <p class="hint">Use {page} and {pages} for page numbers.</p>
      <button type="button" id="hf-apply">Apply</button>`;
    openDialog(which === "header" ? "Header" : "Footer", wrap);
    (wrap.querySelector("#hf-diff") as HTMLInputElement).checked = page.differentFirst;
    wrap.querySelector("#hf-apply")!.addEventListener("click", () => {
      const text = (wrap.querySelector("#hf-main") as HTMLInputElement).value;
      const firstText = (wrap.querySelector("#hf-first") as HTMLInputElement).value;
      const differentFirst = (wrap.querySelector("#hf-diff") as HTMLInputElement).checked;
      const next = { ...currentPage(), differentFirst };
      if (which === "header") {
        next.header = text;
        next.headerFirst = firstText;
      } else {
        next.footer = text;
        next.footerFirst = firstText;
      }
      usePage(next);
      editor.render();
      sendPage();
      closeDialog();
    });
  }

  function insertPageNumber(): void {
    const page = currentPage();
    const footer = page.footer.includes("{page}") ? page.footer : (page.footer ? page.footer + " " : "") + "{page}";
    usePage({ ...page, footer });
    editor.render();
    sendPage();
    toast("Page number added to the footer");
  }

  function openFootnoteInsert(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Footnote <textarea id="fn-text" rows="3"></textarea></label><button type="button" id="fn-apply">Insert</button>`;
    openDialog("Footnote", wrap);
    const area = wrap.querySelector("#fn-text") as HTMLTextAreaElement;
    wrap.querySelector("#fn-apply")!.addEventListener("click", () => {
      editor.insertFootnote(area.value);
      closeDialog();
      editor.focus();
    });
    window.setTimeout(() => area.focus(), 0);
  }

  function openFootnote(index: number): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const label = editor.styleAt(index).label || "";
    wrap.innerHTML = `<label>Footnote <textarea id="fn-text" rows="3"></textarea></label><button type="button" id="fn-apply">Apply</button>`;
    openDialog("Footnote", wrap);
    const area = wrap.querySelector("#fn-text") as HTMLTextAreaElement;
    area.value = label;
    wrap.querySelector("#fn-apply")!.addEventListener("click", () => {
      editor.setFootnote(index, area.value);
      closeDialog();
    });
  }

  function openAlt(index: number): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Description <input id="alt-text" value="${escapeAttr(editor.styleAt(index).alt || "")}"></label><button type="button" id="alt-apply">Apply</button>`;
    openDialog("Alt text", wrap);
    wrap.querySelector("#alt-apply")!.addEventListener("click", () => {
      editor.setAltText(index, (wrap.querySelector("#alt-text") as HTMLInputElement).value);
      closeDialog();
    });
  }

  function openHeadingLink(): void {
    editor.ensureHeadingMarks();
    const heads = editor.headings().filter((h) => h.bm);
    const wrap = document.createElement("div");
    if (!heads.length) {
      wrap.textContent = "Apply a heading, then link to it.";
      openDialog("Link to heading", wrap);
      return;
    }
    const list = document.createElement("div");
    list.className = "mention-list";
    for (const head of heads) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = head.text;
      btn.addEventListener("click", () => {
        editor.linkHeading(head.bm, head.text);
        closeDialog();
        editor.focus();
      });
      list.appendChild(btn);
    }
    wrap.appendChild(list);
    openDialog("Link to heading", wrap);
  }

  function openPageSetup(): void {
    const page = currentPage();
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const inch = (px: number) => (px / 96).toFixed(2);
    wrap.innerHTML = `<label>Paper <select id="pg-paper"><option value="letter">Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></label>
      <label>Orientation <select id="pg-orient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <label>Top <input id="pg-mt" type="number" min="0.4" max="3" step="0.1" value="${inch(page.mt)}"> in</label>
      <label>Bottom <input id="pg-mb" type="number" min="0.4" max="3" step="0.1" value="${inch(page.mb)}"> in</label>
      <label>Left <input id="pg-ml" type="number" min="0.4" max="3" step="0.1" value="${inch(page.ml)}"> in</label>
      <label>Right <input id="pg-mr" type="number" min="0.4" max="3" step="0.1" value="${inch(page.mr)}"> in</label>
      <label>Watermark <input id="pg-wm" maxlength="80"></label>
      <button type="button" id="pg-apply">Apply</button>`;
    openDialog("Page setup", wrap);
    (wrap.querySelector("#pg-paper") as HTMLSelectElement).value = page.paper;
    (wrap.querySelector("#pg-orient") as HTMLSelectElement).value = page.orient;
    (wrap.querySelector("#pg-wm") as HTMLInputElement).value = page.watermark;
    wrap.querySelector("#pg-apply")!.addEventListener("click", () => {
      const num = (id: string) => Math.round(Number((wrap.querySelector(id) as HTMLInputElement).value) * 96);
      usePage({
        ...currentPage(),
        paper: (wrap.querySelector("#pg-paper") as HTMLSelectElement).value,
        orient: (wrap.querySelector("#pg-orient") as HTMLSelectElement).value,
        mt: num("#pg-mt"),
        mb: num("#pg-mb"),
        ml: num("#pg-ml"),
        mr: num("#pg-mr"),
        watermark: (wrap.querySelector("#pg-wm") as HTMLInputElement).value,
      });
      editor.render();
      sendPage();
      closeDialog();
    });
  }

  function fillCompare(rows: VersionRow[]): void {
    for (const id of ["cmp-a", "cmp-b"]) {
      const sel = document.querySelector("#" + id) as HTMLSelectElement | null;
      if (!sel) continue;
      const cur = sel.value;
      sel.replaceChildren();
      for (const row of rows) {
        const opt = document.createElement("option");
        opt.value = String(row.rev);
        opt.textContent = (row.label || row.name || "Version") + " · " + row.rev;
        sel.appendChild(opt);
      }
      if (cur && [...sel.options].some((opt) => opt.value === cur)) sel.value = cur;
      else if (id === "cmp-b" && rows.length > 1) sel.selectedIndex = 0;
      else if (id === "cmp-a" && rows.length > 1) sel.selectedIndex = Math.min(1, rows.length - 1);
    }
  }

  function openLookup(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Word <input id="lk-word" maxlength="40"></label><p id="lk-out" class="hint"></p><button type="button" id="lk-go">Look up</button>`;
    const selected = editor.selectedPlain().trim().split(/\s+/)[0] || "";
    openDialog("Dictionary", wrap);
    const input = wrap.querySelector("#lk-word") as HTMLInputElement;
    const out = wrap.querySelector("#lk-out") as HTMLElement;
    input.value = selected.replace(/[^A-Za-z'-]/g, "");
    const run = () => {
      const word = input.value.trim();
      const local = lookupWord(word);
      out.textContent = local ? local.definition : wordKnown(word) ? "In the local word list." : "No local definition.";
      const key = word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
      if (!key) return;
      void fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(key))
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { meanings?: { definitions?: { definition?: string }[] }[] }[] | null) => {
          const definition = data?.[0]?.meanings?.[0]?.definitions?.[0]?.definition;
          if (typeof definition === "string" && definition) out.textContent = definition;
        })
        .catch(() => undefined);
    };
    wrap.querySelector("#lk-go")!.addEventListener("click", run);
    if (input.value) run();
    input.focus();
  }

  function openCompare(): void {
    send({ t: "history" });
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>From <select id="cmp-a"></select></label><label>To <select id="cmp-b"></select></label><button type="button" id="cmp-go">Compare</button><div id="cmp-out" class="hint"></div>`;
    openDialog("Compare versions", wrap);
    fillCompare(historyRows);
    wrap.querySelector("#cmp-go")!.addEventListener("click", () => {
      const a = Number((wrap.querySelector("#cmp-a") as HTMLSelectElement).value);
      const b = Number((wrap.querySelector("#cmp-b") as HTMLSelectElement).value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      compareWait = (body) => {
        const out = wrap.querySelector("#cmp-out");
        if (!out) return;
        out.replaceChildren();
        for (const part of diffWords(body.left, body.right)) {
          const span = document.createElement("span");
          span.textContent = part.text;
          if (part.kind === "add") span.style.background = "#ceead6";
          if (part.kind === "del") {
            span.style.background = "#fad2cf";
            span.style.textDecoration = "line-through";
          }
          out.appendChild(span);
        }
        if (!out.childNodes.length) out.textContent = "No difference.";
      };
      send({ t: "compare", a, b });
    });
  }

  function openWatermark(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Text <input id="wm-text" maxlength="80"></label><p class="hint">Shown faintly behind every page. Leave blank to remove it.</p><button type="button" id="wm-go">Apply</button>`;
    openDialog("Watermark", wrap);
    const input = wrap.querySelector("#wm-text") as HTMLInputElement;
    input.value = currentPage().watermark;
    wrap.querySelector("#wm-go")!.addEventListener("click", () => {
      usePage({ ...currentPage(), watermark: input.value });
      editor.render();
      sendPage();
      closeDialog();
    });
    input.focus();
  }

  function openChart(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Bars <textarea id="ch-data" rows="5" placeholder="North 10&#10;South 40"></textarea></label><button type="button" id="ch-go">Insert</button>`;
    openDialog("Chart", wrap);
    wrap.querySelector("#ch-go")!.addEventListener("click", () => {
      const raw = (wrap.querySelector("#ch-data") as HTMLTextAreaElement).value;
      const label = raw
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("; ");
      if (!label) return;
      editor.insertChart(label);
      closeDialog();
    });
  }

  function openDrawing(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    const canvas = document.createElement("canvas");
    canvas.width = 280;
    canvas.height = 150;
    canvas.style.border = "1px solid #dadce0";
    canvas.style.touchAction = "none";
    const strokes: number[][][] = [];
    let current: number[][] | null = null;
    const ctx = canvas.getContext("2d");
    const paint = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#202124";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      for (const stroke of strokes) {
        ctx.beginPath();
        stroke.forEach((point, n) => (n ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1])));
        ctx.stroke();
      }
    };
    const point = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return [(ev.clientX - rect.left) * (canvas.width / rect.width), (ev.clientY - rect.top) * (canvas.height / rect.height)];
    };
    canvas.addEventListener("pointerdown", (ev) => {
      current = [point(ev)];
      strokes.push(current);
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!current) return;
      current.push(point(ev));
      paint();
    });
    canvas.addEventListener("pointerup", () => {
      current = null;
    });
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Insert";
    go.addEventListener("click", () => {
      const norm = strokes
        .filter((stroke) => stroke.length >= 2)
        .map((stroke) => stroke.map((p) => [(p[0] / canvas.width) * 100, (p[1] / canvas.height) * 100]));
      const src = encodeStrokes(norm);
      if (!src) return;
      editor.insertDrawing(src);
      closeDialog();
    });
    wrap.append(canvas, go);
    openDialog("Drawing", wrap);
  }

  function openCitation(): void {
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML = `<label>Author <input id="ct-author" maxlength="80"></label><label>Year <input id="ct-year" maxlength="16"></label><label>Title <input id="ct-title" maxlength="160"></label><button type="button" id="ct-go">Insert</button>`;
    openDialog("Citation", wrap);
    wrap.querySelector("#ct-go")!.addEventListener("click", () => {
      const author = (wrap.querySelector("#ct-author") as HTMLInputElement).value;
      const year = (wrap.querySelector("#ct-year") as HTMLInputElement).value;
      const title = (wrap.querySelector("#ct-title") as HTMLInputElement).value;
      if (!author.trim() && !title.trim()) return;
      editor.insertCitation(author, year, title);
      closeDialog();
    });
  }

  function openSpelling(): void {
    const hits = editor.spellList();
    const wrap = document.createElement("div");
    if (!hits.length) {
      wrap.textContent = "No spelling suggestions.";
      openDialog("Spelling", wrap);
      return;
    }
    const hit = hits[Math.min(spellAt, hits.length - 1)];
    spellAt = Math.min(spellAt, hits.length - 1);
    const ideas = editor.suggestionsFor(hit.word);
    wrap.innerHTML = `<p><strong>${escapeHtml(hit.word)}</strong></p>`;
    for (const idea of ideas) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = idea;
      btn.addEventListener("click", () => {
        editor.replaceRange(hit.start, hit.end, idea);
        closeDialog();
      });
      wrap.appendChild(btn);
    }
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.textContent = "Ignore";
    ignore.addEventListener("click", () => {
      editor.ignoreWord(hit.word);
      closeDialog();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add to dictionary";
    add.addEventListener("click", () => {
      editor.allowWord(hit.word);
      savePersonal();
      closeDialog();
    });
    wrap.append(ignore, add);
    editor.jumpTo(hit.start);
    openDialog("Spelling", wrap);
  }

  function openDictionary(): void {
    const wrap = document.createElement("div");
    const input = document.createElement("input");
    input.placeholder = "Word";
    input.setAttribute("aria-label", "Dictionary word");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add";
    const list = document.createElement("ul");
    const paint = () => {
      list.replaceChildren();
      for (const word of [...editor.personal].sort()) {
        const li = document.createElement("li");
        li.textContent = word + " ";
        const rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "Remove";
        rm.addEventListener("click", () => {
          editor.personal.delete(word);
          editor.render();
          savePersonal();
          paint();
        });
        li.appendChild(rm);
        list.appendChild(li);
      }
    };
    add.addEventListener("click", () => {
      editor.allowWord(input.value.trim());
      input.value = "";
      savePersonal();
      paint();
    });
    wrap.append(input, add, list);
    paint();
    openDialog("Personal dictionary", wrap);
  }

  function openPreferences(): void {
    const wrap = document.createElement("div");
    const box = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = editor.autocorrect;
    box.append(check, document.createTextNode(" Autocorrect common typos"));
    check.addEventListener("change", () => {
      editor.autocorrect = check.checked;
      localStorage.setItem("felarumi-auto", check.checked ? "1" : "0");
    });
    const note = document.createElement("p");
    note.textContent = "Substitutions such as teh, recieve, (c), and ... apply as you type.";
    wrap.append(box, note);
    openDialog("Preferences", wrap);
  }

  function openMenuSearch(): void {
    const wrap = document.createElement("div");
    const input = document.createElement("input");
    input.placeholder = "Search the menus";
    input.setAttribute("aria-label", "Search the menus");
    const list = document.createElement("div");
    const items = [...document.querySelectorAll<HTMLButtonElement>("#menubar [data-act]")];
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      list.replaceChildren();
      for (const item of items) {
        const label = item.textContent?.trim() || "";
        if (q && !label.toLowerCase().includes(q)) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          closeDialog();
          item.click();
        });
        list.appendChild(btn);
      }
    };
    input.addEventListener("input", paint);
    wrap.append(input, list);
    paint();
    openDialog("Search the menus", wrap);
    window.setTimeout(() => input.focus(), 0);
  }

  function openContext(x: number, y: number, index: number): void {
    const menu = document.querySelector("#context") as HTMLElement;
    menu.replaceChildren();
    const word = editor.wordAt(index);
    const bad = word && editor.spellList().some((hit) => hit.start === word.start);
    if (word && bad) {
      const label = document.createElement("div");
      label.className = "menu-label";
      label.textContent = word.word;
      menu.appendChild(label);
      for (const idea of editor.suggestionsFor(word.word).slice(0, 5)) {
        addCtx(menu, idea, () => editor.replaceRange(word.start, word.end, idea));
      }
      addCtx(menu, "Ignore", () => editor.ignoreWord(word.word));
      addCtx(menu, "Add to personal dictionary", () => {
        editor.allowWord(word.word);
        savePersonal();
      });
    }
    addCtx(menu, "Cut", () => actionsCut());
    addCtx(menu, "Copy", () => actionsCopy());
    addCtx(menu, "Paste", () => void actionsPaste());
    addCtx(menu, "Paste without formatting", () => void pastePlain());
    const style = editor.styleAt(index);
    if (style.embed === "img") {
      addCtx(menu, "Alt text", () => openAlt(index));
      addCtx(menu, "Rotate 90°", () => editor.setImageRotation(index, ((style.rot || 0) + 90) % 360));
    }
    if (style.embed === "eq") addCtx(menu, "Edit equation", () => openEquation(index));
    addCtx(menu, "Comment", () => chrome.openComment());
    addCtx(menu, "Link", () => chrome.openLink());
    addCtx(menu, "Clear formatting", () => editor.clearFormatting());
    menu.hidden = false;
    const width = 240;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 280)) + "px";
  }

  function addCtx(menu: HTMLElement, label: string, run: () => void): void {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      menu.hidden = true;
      run();
    });
    menu.appendChild(btn);
  }

  function actionsCut(): void {
    void navigator.clipboard.writeText(editor.selectedPlain()).catch(() => undefined);
    editor.insertText("");
  }

  function actionsCopy(): void {
    void navigator.clipboard.writeText(editor.selectedPlain()).then(() => toast("Copied")).catch(() => toast("Allow clipboard access to copy"));
  }

  async function actionsPaste(): Promise<void> {
    try {
      editor.paste("", await navigator.clipboard.readText());
    } catch {
      toast("Allow clipboard access to paste");
    }
  }

  function savePersonal(): void {
    localStorage.setItem("felarumi-dict", JSON.stringify([...editor.personal]));
  }

  function loadPrefs(): void {
    try {
      const words = JSON.parse(localStorage.getItem("felarumi-dict") || "[]") as unknown[];
      for (const word of words) if (typeof word === "string") editor.personal.add(word.toLowerCase());
      if (localStorage.getItem("felarumi-auto") === "0") editor.autocorrect = false;
      editor.subs = { ...DEFAULT_SUBS };
    } catch {
      editor.subs = { ...DEFAULT_SUBS };
    }
  }

  const ruler = document.querySelector("#ruler") as HTMLCanvasElement;
  let rulerDrag: "l" | "r" | "i" | null = null;
  const rulerPoint = (ev: PointerEvent) => {
    const rect = ruler.getBoundingClientRect();
    return ((ev.clientX - rect.left) / Math.max(1, rect.width)) * PAGE_W;
  };
  ruler.addEventListener("pointerdown", (ev) => {
    const x = rulerPoint(ev);
    if (Math.abs(x - ML) < 10) rulerDrag = "l";
    else if (Math.abs(x - (PAGE_W - MR)) < 10) rulerDrag = "r";
    else if (Math.abs(x - (ML + rulerIndentPx)) < 10) rulerDrag = "i";
    else return;
    ruler.setPointerCapture(ev.pointerId);
  });
  ruler.addEventListener("pointermove", (ev) => {
    if (!rulerDrag) return;
    const x = Math.max(36, Math.min(PAGE_W - 36, rulerPoint(ev)));
    if (rulerDrag === "i") {
      const steps = Math.max(0, Math.min(8, Math.round((x - ML) / 36)));
      editor.setParagraph({ ind: steps });
      return;
    }
    const page = currentPage();
    if (rulerDrag === "l") usePage({ ...page, ml: Math.min(x, PAGE_W - page.mr - 120) });
    else usePage({ ...page, mr: Math.min(PAGE_W - x, PAGE_W - page.ml - 120) });
    editor.render();
  });
  ruler.addEventListener("pointerup", () => {
    if (rulerDrag === "l" || rulerDrag === "r") sendPage();
    rulerDrag = null;
  });

  const vruler = document.querySelector("#vruler") as HTMLCanvasElement;
  let vDrag: "t" | "b" | null = null;
  const vPoint = (ev: PointerEvent) => {
    const rect = vruler.getBoundingClientRect();
    return ((ev.clientY - rect.top) / Math.max(1, rect.height)) * PAGE_H;
  };
  vruler.addEventListener("pointerdown", (ev) => {
    const y = vPoint(ev);
    if (Math.abs(y - MT) < 10) vDrag = "t";
    else if (Math.abs(y - (PAGE_H - MB)) < 10) vDrag = "b";
    else return;
    vruler.setPointerCapture(ev.pointerId);
  });
  vruler.addEventListener("pointermove", (ev) => {
    if (!vDrag) return;
    const y = Math.max(36, Math.min(PAGE_H - 36, vPoint(ev)));
    const page = currentPage();
    if (vDrag === "t") usePage({ ...page, mt: Math.min(y, PAGE_H - page.mb - 120) });
    else usePage({ ...page, mb: Math.min(PAGE_H - y, PAGE_H - page.mt - 120) });
    editor.render();
  });
  vruler.addEventListener("pointerup", () => {
    if (vDrag) sendPage();
    vDrag = null;
  });

  document.querySelector("#print-go")!.addEventListener("click", () => window.print());
  document.querySelector("#print-close")!.addEventListener("click", () => {
    document.body.classList.remove("print-preview");
    (document.querySelector("#print-preview") as HTMLElement).hidden = true;
    editor.focus();
  });
  document.querySelector("#trash-restore")!.addEventListener("click", () => {
    void fetch("/api/docs/" + encodeURIComponent(id) + "/restore", { method: "POST" }).then(() => location.reload());
  });
  document.querySelector("#trash-delete")!.addEventListener("click", () => {
    void fetch("/api/docs/" + encodeURIComponent(id), { method: "DELETE" }).then(() => {
      location.href = "/";
    });
  });

  document.querySelector("#outline-close")!.addEventListener("click", () => setOutline(false));
  document.addEventListener("mousedown", (ev) => {
    const menu = document.querySelector("#context") as HTMLElement;
    if (!menu.hidden && !(ev.target as HTMLElement).closest("#context")) menu.hidden = true;
  });

  loadPrefs();
  void fetch(hostBase() + "/words.txt")
    .then((res) => (res.ok ? res.text() : ""))
    .then((text) => {
      loadWordText(text);
      editor.render();
    })
    .catch(() => undefined);

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

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
    const mine = person.sid === selfSid;
    el.className = mine ? "avatar self" : "avatar";
    el.style.background = mine ? "#f1f3f4" : hexAlpha(person.color, 0.16);
    el.style.color = mine ? "#202124" : person.color;
    el.style.boxShadow = mine ? "none" : `0 0 0 2px ${person.color}`;
    el.title = person.name;
    el.dataset.sid = person.sid;
    const own = mine ? selfPerson() : null;
    if (own && (own.avatar?.emoji || own.address)) {
      el.innerHTML = avatarInnerHtml(own, 32);
      el.style.overflow = "hidden";
      if (own.avatar?.color && own.avatar.emoji) {
        el.style.background = own.avatar.color;
        el.style.color = "#fff";
      }
    } else el.textContent = (person.name.trim()[0] || "?").toUpperCase();
    el.addEventListener("mouseenter", () => {
      editor.hoverSid = person.sid;
      editor.syncFlags();
    });
    el.addEventListener("mouseleave", () => {
      if (editor.hoverSid === person.sid) editor.hoverSid = null;
      editor.syncFlags();
    });
    el.addEventListener("click", () => {
      const show = (window as unknown as { __showIdentity?: (el: HTMLElement) => void }).__showIdentity;
      if (mine && show) show(el);
      else editor.reveal(person.sid);
    });
    root.appendChild(el);
  }
}

function bindMenus(editor: Editor, actions: Record<string, () => void>): void {
  const bar = document.querySelector("#menubar") as HTMLElement;
  const close = () => {
    for (const pop of bar.querySelectorAll<HTMLElement>(".menu-pop[data-pop]")) pop.hidden = true;
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

function boot(): void {
  const path = routePath();
  const doc = path.match(/^\/d\/([^/]+)\/?$/);
  if (doc) {
    mountEditor(decodeURIComponent(doc[1]), new URLSearchParams(location.search).get("s") || "");
    return;
  }
  const linked = path.match(/^\/([vce])\/([^/]+)\/?$/);
  if (linked) {
    void fetch("/api/open/" + encodeURIComponent(linked[2]))
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { id: string } | null) => {
        if (!body) location.href = "/";
        else mountEditor(body.id, linked[2]);
      });
    return;
  }
  void mountHome();
}

boot();
