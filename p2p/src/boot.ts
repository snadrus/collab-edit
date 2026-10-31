import { type Book } from "../../apps/felanumio/src/ot.ts";
import { type Snapshot } from "../../src/shared/doc.ts";
import { BookSession, type BookRecord } from "./book-hub.ts";
import { DocSession, type DocRecord } from "./docs-hub.ts";
import { getBlob, listRecords, loadRecord, putBlob, saveRecord } from "./idb.ts";
import { DEFAULT_NETWORK, fileAdapter, ipfsAdapter, normalizeNetwork, synapseAdapter, type FilecoinNetwork, type StorageAdapter } from "./storage.ts";
import type { Wire } from "./wire.ts";

const NativeWebSocket = globalThis.WebSocket;
const WAIT = "Waiting for the owner. This document is read-only until they are online.";
const files = fileAdapter();

let docSession: DocSession | null = null;
let bookSession: BookSession | null = null;

function randomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secretKey(kind: "doc" | "book", id: string): string {
  return "felarumi-secret:" + kind + ":" + id;
}

function ownerKey(kind: "doc" | "book", id: string): string {
  return "felarumi-owner:" + kind + ":" + id;
}

function rememberSecret(kind: "doc" | "book", id: string): string {
  const fromHash = location.hash.replace(/^#/, "");
  if (fromHash) {
    localStorage.setItem(secretKey(kind, id), fromHash);
    return fromHash;
  }
  const saved = localStorage.getItem(secretKey(kind, id)) || "";
  if (saved) {
    history.replaceState(null, "", location.pathname + location.search + "#" + saved);
    return saved;
  }
  if (localStorage.getItem(ownerKey(kind, id)) !== "1") return "";
  const secret = randomId() + randomId();
  localStorage.setItem(secretKey(kind, id), secret);
  history.replaceState(null, "", location.pathname + location.search + "#" + secret);
  return secret;
}

function isOwner(kind: "doc" | "book", id: string): boolean {
  return localStorage.getItem(ownerKey(kind, id)) === "1";
}

function currentNetwork(): FilecoinNetwork {
  try {
    return normalizeNetwork(sessionStorage.getItem("felarumi-filecoin-net"));
  } catch {
    return DEFAULT_NETWORK;
  }
}

function setCid(cid: string): void {
  const url = new URL(location.href);
  url.searchParams.set("cid", cid);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

class AppSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  toHub: (data: string) => void = () => undefined;

  send(data: string): void {
    this.toHub(data);
  }

  deliver(data: string): void {
    this.onmessage?.({ data });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function shimWebSocket(url: string): WebSocket {
  const parsed = new URL(url, location.href);
  if (parsed.pathname === "/relay") return new NativeWebSocket(url);
  const sock = new AppSocket();
  if (parsed.pathname === "/ws") void attachDoc(sock, parsed.searchParams.get("doc") || "");
  else if (parsed.pathname === "/ws/sheets") void attachBook(sock, parsed.searchParams.get("book") || "");
  else sock.close();
  return sock as unknown as WebSocket;
}
(shimWebSocket as unknown as { OPEN: number; CONNECTING: number; CLOSING: number; CLOSED: number }).OPEN = 1;
(shimWebSocket as unknown as { CONNECTING: number }).CONNECTING = 0;
(shimWebSocket as unknown as { CLOSING: number }).CLOSING = 2;
(shimWebSocket as unknown as { CLOSED: number }).CLOSED = 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(): void {
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.origin);
    if (!url.pathname.startsWith("/api/")) return orig(input, init);
    const method = (init?.method || "GET").toUpperCase();
    if (url.pathname === "/api/docs" && method === "GET") {
      if (url.searchParams.get("trash") === "1") return jsonResponse([]);
      const rows = await listRecords("doc");
      return jsonResponse(rows.map((row) => ({ id: row.id, title: row.title, updated: row.updated })));
    }
    if (url.pathname === "/api/docs" && method === "POST") return jsonResponse(await createRoom("doc"), 201);
    if (url.pathname === "/api/books" && method === "GET") {
      const rows = await listRecords("book");
      return jsonResponse(rows.map((row) => ({ id: row.id, title: row.title, updated: row.updated })));
    }
    if (url.pathname === "/api/books" && method === "POST") return jsonResponse(await createRoom("book"), 201);
    const tabs = url.pathname.match(/^\/api\/docs\/([A-Za-z0-9_-]+)\/tabs$/);
    if (tabs && method === "GET") return jsonResponse([{ id: tabs[1], title: "Tab" }]);
    const share = url.pathname.match(/^\/api\/(?:docs|books)\/([A-Za-z0-9_-]+)\/share$/);
    if (share && method === "GET") return jsonResponse({ access: "edit", tokens: { edit: "editor", comment: "comment", view: "viewer" } });
    return jsonResponse({ ok: true, access: "edit" });
  };
}

async function createRoom(kind: "doc" | "book"): Promise<{ id: string; title: string }> {
  const id = randomId();
  const secret = randomId() + randomId();
  const title = kind === "doc" ? "Untitled document" : "Untitled spreadsheet";
  localStorage.setItem(ownerKey(kind, id), "1");
  localStorage.setItem(secretKey(kind, id), secret);
  await saveRecord({ key: kind + ":" + id, kind, id, title, updated: Date.now(), rev: 0, data: null });
  return { id, title };
}

function connectTest(room: string): Promise<Wire> {
  const peerId = randomId();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new NativeWebSocket(`${proto}://${location.host}/relay?room=${encodeURIComponent(room)}&peer=${encodeURIComponent(peerId)}`);
  return new Promise((resolve, reject) => {
    let message: (from: string, body: unknown) => void = () => undefined;
    let join: (peerId: string) => void = () => undefined;
    let leave: (peerId: string) => void = () => undefined;
    ws.onopen = () => resolve(wire);
    ws.onerror = () => reject(new Error("relay failed"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string; peer?: string; peers?: string[]; from?: string; body?: unknown };
      if (msg.t === "join" && msg.peer) join(msg.peer);
      else if (msg.t === "leave" && msg.peer) leave(msg.peer);
      else if (msg.t === "peers") for (const peer of msg.peers || []) join(peer);
      else if (msg.t === "msg" && msg.from) message(msg.from, msg.body);
    };
    const wire: Wire = {
      peerId,
      send(to: string, body: unknown): void {
        ws.send(JSON.stringify({ t: "msg", to, body }));
      },
      onMessage(fn: (from: string, body: unknown) => void): void {
        message = fn;
      },
      onJoin(fn: (peerId: string) => void): void {
        join = fn;
      },
      onLeave(fn: (peerId: string) => void): void {
        leave = fn;
      },
      close(): void {
        ws.close();
      },
    };
  });
}

async function connectWire(room: string, secret: string): Promise<Wire> {
  if (new URLSearchParams(location.search).get("wire") === "test") return connectTest(room);
  const { connectTrystero } = await import("./trystero-wire.ts");
  return connectTrystero(room, secret);
}

function showWait(): void {
  const bar = document.querySelector("#p2p-wait") as HTMLElement | null;
  if (!bar) return;
  bar.hidden = false;
  bar.textContent = WAIT;
}

function hideWait(): void {
  const bar = document.querySelector("#p2p-wait") as HTMLElement | null;
  if (bar) bar.hidden = true;
}

async function attachDoc(sock: AppSocket, id: string): Promise<void> {
  if (!id) {
    sock.close();
    return;
  }
  const owner = isOwner("doc", id);
  const secret = rememberSecret("doc", id);
  const wire = await connectWire("doc:" + id, secret);
  if (owner) await hostDoc(sock, wire, id);
  else joinDoc(sock, wire, id);
  sock.open();
}

async function hostDoc(sock: AppSocket, wire: Wire, id: string): Promise<void> {
  const saved = await loadRecord("doc:" + id);
  const data = saved?.data as DocRecord | null;
  docSession = DocSession.create(id, data && data.snapshot ? data : null, (record) => {
    void saveRecord({ key: "doc:" + id, kind: "doc", id, title: record.title, updated: Date.now(), rev: record.rev, data: record });
  });
  const cid = new URLSearchParams(location.search).get("cid");
  if (cid && docSession.server.rev === 0) {
    const bytes = await getBlob(cid);
    if (bytes) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { snapshot?: Snapshot; title?: string };
      if (parsed.snapshot) docSession.replace(parsed.snapshot, parsed.title);
    }
  }
  const remotes = new Map<string, { conn: ReturnType<DocSession["connect"]> | null; socket: { send(data: string): void } }>();
  let local: ReturnType<DocSession["connect"]> | null = null;
  const bridge = { send: (data: string) => sock.deliver(data) };
  sock.toHub = (data: string) => {
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (!docSession) return;
    if (!local) local = docSession.connect(bridge, msg);
    else docSession.handle(local, msg);
  };
  wire.onJoin((peer) => wire.send(peer, { k: "owner" }));
  wire.onMessage((from, body) => {
    const rec = body as Record<string, unknown>;
    if (!rec || rec.k === "join") {
      wire.send(from, { k: "owner" });
      return;
    }
    if (rec.k === "owner" || !docSession) return;
    let remote = remotes.get(from);
    if (!remote) {
      const socket = { send: (data: string) => wire.send(from, JSON.parse(data) as unknown) };
      remote = { conn: null, socket };
      remotes.set(from, remote);
    }
    if (!remote.conn) remote.conn = docSession.connect(remote.socket, rec);
    else docSession.handle(remote.conn, rec);
  });
  wire.onLeave((peer) => {
    const remote = remotes.get(peer);
    if (remote?.conn && docSession) docSession.disconnect(remote.conn);
    remotes.delete(peer);
  });
  wire.send("*", { k: "owner" });
}

function joinDoc(sock: AppSocket, wire: Wire, id: string): void {
  let ownerPeer: string | null = null;
  let inited = false;
  let locked = false;
  const queue: string[] = [];
  const flush = () => {
    if (!ownerPeer) return;
    for (const data of queue.splice(0)) wire.send(ownerPeer, JSON.parse(data) as unknown);
  };
  sock.toHub = (data: string) => {
    queue.push(data);
    flush();
  };
  const lock = () => {
    locked = true;
    showWait();
    if (inited) sock.deliver(JSON.stringify({ t: "access", role: "view", banner: WAIT }));
  };
  const unlock = () => {
    if (!locked) {
      hideWait();
      return;
    }
    locked = false;
    hideWait();
    if (inited) sock.deliver(JSON.stringify({ t: "access", role: "edit" }));
  };
  wire.onMessage((from, body) => {
    const rec = body as Record<string, unknown>;
    if (rec?.k === "owner") {
      ownerPeer = from;
      flush();
      unlock();
      return;
    }
    if (!rec || rec.k) return;
    if (rec.t === "init") inited = true;
    sock.deliver(JSON.stringify(rec));
    if (rec.t === "init" && ownerPeer) {
      void saveRecord({
        key: "doc:" + id,
        kind: "doc",
        id,
        title: String(rec.title || "Untitled document"),
        updated: Date.now(),
        rev: Number(rec.rev) || 0,
        data: { title: rec.title, rev: rec.rev, snapshot: rec.snapshot, page: rec.page },
      });
      unlock();
    }
  });
  wire.onLeave((peer) => {
    if (peer === ownerPeer) {
      ownerPeer = null;
      lock();
    }
  });
  wire.send("*", { k: "join" });
  window.setTimeout(() => {
    if (ownerPeer || inited) return;
    void loadRecord("doc:" + id).then((saved) => {
      if (ownerPeer || inited) return;
      const data = saved?.data as DocRecord | null;
      if (data?.snapshot) {
        inited = true;
        sock.deliver(
          JSON.stringify({
            t: "init",
            rev: data.rev,
            snapshot: data.snapshot,
            title: data.title,
            self: { sid: "offline", name: "Guest", color: "#188038" },
            presence: [],
            threads: [],
            suggestions: [],
            page: data.page,
            role: "view",
            trashed: false,
            resume: false,
            catchup: [],
          }),
        );
      }
      lock();
    });
  }, 1500);
}

async function attachBook(sock: AppSocket, id: string): Promise<void> {
  if (!id) {
    sock.close();
    return;
  }
  const owner = isOwner("book", id);
  const secret = rememberSecret("book", id);
  const wire = await connectWire("book:" + id, secret);
  if (owner) await hostBook(sock, wire, id);
  else joinBook(sock, wire, id);
  sock.open();
}

async function hostBook(sock: AppSocket, wire: Wire, id: string): Promise<void> {
  const saved = await loadRecord("book:" + id);
  const data = saved?.data as BookRecord | null;
  bookSession = BookSession.create(id, data && data.book ? data : null, (record) => {
    void saveRecord({ key: "book:" + id, kind: "book", id, title: record.title, updated: Date.now(), rev: record.rev, data: record });
  });
  const remotes = new Map<string, { conn: ReturnType<BookSession["connect"]> | null }>();
  let local: ReturnType<BookSession["connect"]> | null = null;
  const bridge = { send: (data: string) => sock.deliver(data) };
  sock.toHub = (data: string) => {
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (!bookSession) return;
    if (!local) local = bookSession.connect(bridge, msg);
    else bookSession.handle(local, msg);
  };
  wire.onJoin((peer) => wire.send(peer, { k: "owner" }));
  wire.onMessage((from, body) => {
    const rec = body as Record<string, unknown>;
    if (!rec || rec.k === "join") {
      wire.send(from, { k: "owner" });
      return;
    }
    if (rec.k === "owner" || !bookSession) return;
    let remote = remotes.get(from);
    if (!remote) {
      const socket = { send: (data: string) => wire.send(from, JSON.parse(data) as unknown) };
      remote = { conn: bookSession.connect(socket, rec) };
      remotes.set(from, remote);
      return;
    }
    if (remote.conn) bookSession.handle(remote.conn, rec);
  });
  wire.onLeave((peer) => {
    const remote = remotes.get(peer);
    if (remote?.conn && bookSession) bookSession.disconnect(remote.conn);
    remotes.delete(peer);
  });
  wire.send("*", { k: "owner" });
}

function joinBook(sock: AppSocket, wire: Wire, id: string): void {
  let ownerPeer: string | null = null;
  let inited = false;
  let locked = false;
  const queue: string[] = [];
  const flush = () => {
    if (!ownerPeer) return;
    for (const data of queue.splice(0)) wire.send(ownerPeer, JSON.parse(data) as unknown);
  };
  sock.toHub = (data: string) => {
    queue.push(data);
    flush();
  };
  const lock = () => {
    locked = true;
    showWait();
    if (inited) sock.deliver(JSON.stringify({ t: "access", role: "view", banner: WAIT }));
  };
  const unlock = () => {
    if (!locked) {
      hideWait();
      return;
    }
    locked = false;
    hideWait();
    if (inited) sock.deliver(JSON.stringify({ t: "access", role: "edit" }));
  };
  wire.onMessage((from, body) => {
    const rec = body as Record<string, unknown>;
    if (rec?.k === "owner") {
      ownerPeer = from;
      flush();
      unlock();
      return;
    }
    if (!rec || rec.k) return;
    if (rec.t === "init") inited = true;
    sock.deliver(JSON.stringify(rec));
    if (rec.t === "init" && rec.book) {
      void saveRecord({
        key: "book:" + id,
        kind: "book",
        id,
        title: String(rec.title || "Untitled spreadsheet"),
        updated: Date.now(),
        rev: Number(rec.rev) || 0,
        data: { title: rec.title, rev: rec.rev, book: rec.book },
      });
      if (ownerPeer) unlock();
    }
  });
  wire.onLeave((peer) => {
    if (peer === ownerPeer) {
      ownerPeer = null;
      lock();
    }
  });
  wire.send("*", { k: "join" });
  window.setTimeout(() => {
    if (ownerPeer || inited) return;
    showWait();
  }, 1500);
}

function download(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function exportActive(saveDownload = false): Promise<string> {
  const raw = docSession ? docSession.exportJson() : bookSession ? bookSession.exportJson() : "";
  if (!raw) throw new Error("Nothing to save");
  const bytes = new TextEncoder().encode(raw);
  const cid = await files.put(bytes);
  await putBlob(cid, bytes);
  setCid(cid);
  if (saveDownload) download(bytes, docSession ? "felarumi.json" : "felanumio.json");
  return raw;
}

async function loadActive(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as { kind?: string; title?: string; snapshot?: Snapshot; book?: Book };
  const bytes = new TextEncoder().encode(raw);
  const cid = await files.put(bytes);
  await putBlob(cid, bytes);
  setCid(cid);
  if (parsed.snapshot && docSession) docSession.replace(parsed.snapshot, parsed.title);
  else if (parsed.book && bookSession) bookSession.replace(parsed.book, parsed.title);
  else throw new Error("This file does not match the open editor");
}

async function saveFilecoin(network: FilecoinNetwork, privateKey: string): Promise<string> {
  const raw = docSession ? docSession.exportJson() : bookSession ? bookSession.exportJson() : "";
  if (!raw) throw new Error("Nothing to save");
  const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<unknown> } }).ethereum;
  const adapter: StorageAdapter = await synapseAdapter({
    network,
    privateKey: privateKey || undefined,
    provider: privateKey ? undefined : eth,
  });
  const cid = await adapter.put(new TextEncoder().encode(raw));
  await putBlob(cid, new TextEncoder().encode(raw));
  setCid(cid);
  return cid;
}

function installUi(): void {
  const style = document.createElement("style");
  style.textContent = "#p2p-wait{position:sticky;top:0;z-index:80;background:#fef7e0;color:#202124;padding:8px 16px;text-align:center}#p2p-dialog{position:fixed;inset:0;background:rgba(32,33,36,.32);display:grid;place-items:center;z-index:90}#p2p-dialog .card{background:#fff;border-radius:12px;padding:16px;width:min(420px,92vw);display:grid;gap:8px}#p2p-dialog[hidden]{display:none}";
  document.head.append(style);
  const bar = document.createElement("div");
  bar.id = "p2p-wait";
  bar.hidden = true;
  bar.textContent = WAIT;
  document.body.prepend(bar);

  const fileMenu = document.querySelector("[data-pop=file]");
  if (!fileMenu) return;
  const end = document.createElement("button");
  end.type = "button";
  end.id = "p2p-end";
  end.textContent = "End session";
  fileMenu.append(end);

  const dialog = document.createElement("div");
  dialog.id = "p2p-dialog";
  dialog.hidden = true;
  dialog.innerHTML = `<div class="card"><h2>Save this session</h2><p>Filecoin is the default. The key stays in this tab.</p>
    <label><input type="radio" name="p2p-net" value="mainnet" checked> Filecoin mainnet</label>
    <label><input type="radio" name="p2p-net" value="calibration"> Calibration testnet</label>
    <button type="button" id="p2p-wallet">Connect wallet</button>
    <input id="p2p-key" type="password" placeholder="Or paste a private key" autocomplete="off">
    <button type="button" id="p2p-key-save">Save with key</button>
    <p>IPFS is optional.</p>
    <input id="p2p-ipfs" type="password" placeholder="IPFS token" autocomplete="off">
    <button type="button" id="p2p-ipfs-save">Save to IPFS</button>
    <button type="button" id="p2p-file">Download file</button>
    <p id="p2p-status"></p>
    <button type="button" id="p2p-close">Close</button></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector("#p2p-status") as HTMLElement;
  const network = (): FilecoinNetwork => {
    const picked = dialog.querySelector('input[name="p2p-net"]:checked') as HTMLInputElement | null;
    const value = normalizeNetwork(picked?.value);
    sessionStorage.setItem("felarumi-filecoin-net", value);
    return value;
  };
  end.addEventListener("click", () => {
    const current = currentNetwork();
    for (const input of dialog.querySelectorAll<HTMLInputElement>('input[name="p2p-net"]')) input.checked = input.value === current;
    dialog.hidden = false;
  });
  dialog.querySelector("#p2p-close")!.addEventListener("click", () => {
    dialog.hidden = true;
  });
  dialog.querySelector("#p2p-file")!.addEventListener("click", () => {
    void exportActive(true).then(() => {
      status.textContent = "Saved a file. The content id is in this link.";
    }).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
  dialog.querySelector("#p2p-wallet")!.addEventListener("click", () => {
    const key = dialog.querySelector("#p2p-key") as HTMLInputElement;
    key.value = "";
    void saveFilecoin(network(), "").then((cid) => {
      status.textContent = "PieceCID " + cid;
    }).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
  dialog.querySelector("#p2p-key-save")!.addEventListener("click", () => {
    const key = dialog.querySelector("#p2p-key") as HTMLInputElement;
    const value = key.value.trim();
    key.value = "";
    void saveFilecoin(network(), value).then((cid) => {
      status.textContent = "PieceCID " + cid;
    }).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
  dialog.querySelector("#p2p-ipfs-save")!.addEventListener("click", () => {
    const token = (dialog.querySelector("#p2p-ipfs") as HTMLInputElement).value.trim();
    (dialog.querySelector("#p2p-ipfs") as HTMLInputElement).value = "";
    const raw = docSession ? docSession.exportJson() : bookSession ? bookSession.exportJson() : "";
    void ipfsAdapter(token).put(new TextEncoder().encode(raw)).then((cid) => {
      setCid(cid);
      status.textContent = "IPFS " + cid;
    }).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
}

function installApi(): void {
  (window as unknown as { __p2p: unknown }).__p2p = {
    network: () => currentNetwork(),
    setNetwork: (value: string) => {
      sessionStorage.setItem("felarumi-filecoin-net", normalizeNetwork(value));
    },
    exportFile: () => exportActive(),
    loadFile: (raw: string) => loadActive(raw),
    pieceCid: () => new URLSearchParams(location.search).get("cid") || "",
  };
}

if ((window as unknown as { __FELARUMI_P2P__?: boolean }).__FELARUMI_P2P__) {
  window.WebSocket = shimWebSocket as unknown as typeof WebSocket;
  installFetch();
  installApi();
  installUi();
}

export {};
