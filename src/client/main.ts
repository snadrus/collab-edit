import type { Command } from "../shared/commands.ts";
import type { Heading } from "../shared/doc.ts";
import { PAGE_W, RULER_H } from "./layout.ts";
import { Editor, decodeCommands, encodeCommands, type RemoteCaret } from "./editor.ts";

interface InitMsg {
  t: "init";
  rev: number;
  snapshot: { text: string; runs: { n: number; s: Record<string, unknown> }[] };
  title: string;
  self: { sid: string; name: string; color: string };
  presence: RemoteCaret[];
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function sid(): string {
  let id = sessionStorage.getItem("folio-sid");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("folio-sid", id);
  }
  return id;
}

function displayName(): string {
  return sessionStorage.getItem("folio-name") || "Guest";
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
  document.title = "Folio";
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
  const api = {
    ready: false,
    getText: () => editor.getText(),
    setSelection: (a: number, b: number) => editor.setSelection(a, b),
    remoteCount: () => editor.remotes.size,
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
    status.textContent = editor.dirty() ? "Saving…" : "All changes saved";
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
    setSelect("style", state.heading);
    setSelect("font", state.font);
    const size = document.querySelector("#size") as HTMLSelectElement;
    const sizeText = String(state.size);
    if ([...size.options].some((o) => o.value === sizeText)) size.value = sizeText;
    document.title = (title.value || "Untitled document") + " - Folio";
  };

  editor = new Editor(session, pages, overlay, input, "#1a73e8", {
    onOutbound: pump,
    onChange: refreshChrome,
    onSelection: () => {
      refreshChrome();
      sendSel();
    },
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
    sessionStorage.setItem("folio-name", next.trim().slice(0, 40) || "Guest");
    nameBtn.textContent = displayName();
    ws?.send(JSON.stringify({ t: "name", name: displayName() }));
    paintAvatars(editor, session);
  });

  title.addEventListener("change", () => sendTitle());
  title.addEventListener("input", () => {
    document.title = title.value + " - Folio";
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
    download: () => download(title.value, editor.getText()),
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
    "page-break": () => editor.insertText("\f"),
    rule: () => editor.insertText("────────"),
    date: () => editor.insertText(new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })),
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

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?doc=${encodeURIComponent(id)}`);
    ws.onopen = () => {
      ws?.send(JSON.stringify({ t: "hello", sid: session, name: displayName() }));
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
      } else if (msg.t === "reject") {
        console.warn("op rejected", msg.error);
      }
      refreshChrome();
    };
    ws.onclose = () => {
      status.textContent = "Reconnecting…";
      window.setTimeout(connect, 800);
    };
  };

  function onInit(msg: InitMsg): void {
    editor.color = msg.self.color;
    editor.load(msg.snapshot as InitMsg["snapshot"] & { runs: { n: number; s: never }[] }, msg.rev);
    title.value = msg.title;
    for (const person of msg.presence) {
      if (person.sid !== session) editor.setRemote(person);
    }
    api.ready = true;
    paintAvatars(editor, session);
    refreshChrome();
    editor.focus();
    pump();
  }

  window.setInterval(() => {
    if (editor.sync.inflight) {
      editor.sync.resend();
      pump();
    }
  }, 1500);

  document.fonts.ready.then(() => editor.render()).catch(() => undefined);
  connect();
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
    el.style.background = person.color;
    el.title = person.name;
    el.textContent = (person.name.trim()[0] || "?").toUpperCase();
    root.appendChild(el);
  }
}

function download(title: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (title || "document").replace(/[^\w.-]+/g, "_") + ".txt";
  a.click();
  URL.revokeObjectURL(a.href);
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
