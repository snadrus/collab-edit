import { type Book } from "../../apps/felanumio/src/ot.ts";
import { type Snapshot } from "../../src/shared/doc.ts";
import { BookSession, type BookRecord } from "./book-hub.ts";
import { DocSession, type DocRecord } from "./docs-hub.ts";
import { getBlob, listRecords, loadRecord, putBlob, saveRecord } from "./idb.ts";
import {
  CALIBRATION_FROM_BLOCK,
  CALIBRATION_REGISTRY,
  FELANUMIO_DIR,
  FELARUMI_DIR,
  FIGRID_DIR,
  FIPEN_DIR,
  NO_REGISTRY_NOTICE,
  listSnapshots,
  openCalibrationVolume,
  saveSnapshot,
  volumeHistory,
} from "./folder-save.ts";
import { DEFAULT_NETWORK, commpAdapter, commpOf, fileAdapter, ipfsAdapter, lazy, normalizeNetwork, savedVersionUrls, warmSigningModules, synapseAdapter, type FilecoinNetwork, type StorageAdapter, type SynapseLike } from "./storage.ts";
import type { Wire } from "./wire.ts";

const NativeWebSocket = globalThis.WebSocket;
const WAIT = "Waiting for the owner. This document is read-only until they are online.";
const files = fileAdapter();
const pieceMemory = new Map<string, Uint8Array>();

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
  // Only the app's own /ws endpoints are local. Nostr relays and the test relay must stay real sockets.
  const local = parsed.host === location.host && (parsed.pathname === "/ws" || parsed.pathname === "/ws/sheets");
  if (!local) return new NativeWebSocket(url);
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
  const { connectTrystero } = await lazy(() => import("./trystero-wire.ts"));
  return connectTrystero(room, secret);
}

async function readSavedVersion(): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams(location.search);
  const cid = params.get("cid") || params.get("pieceCid") || "";
  if (!cid) return null;
  let bytes = await getBlob(cid).catch(() => null);
  for (const url of bytes ? [] : savedVersionUrls(cid, params.get("owner") || "", currentNetwork())) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        bytes = new Uint8Array(await res.arrayBuffer());
        break;
      }
    } catch {
      // Try the next public source.
    }
  }
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
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
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { snapshot?: Snapshot; title?: string; contentCid?: string };
      if (parsed.snapshot) docSession.replace(parsed.snapshot, parsed.title, parsed.contentCid);
    }
  }
  const remotes = new Map<string, { conn: ReturnType<DocSession["connect"]> | null; socket: { send(data: string): void } }>();
  let local: ReturnType<DocSession["connect"]> | null = null;
  const bridge = { send: (data: string) => sock.deliver(data) };
  sock.toHub = (data: string) => {
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (!docSession) return;
    if (!local) {
      local = docSession.connect(bridge, msg);
      local.owner = true;
    } else docSession.handle(local, msg);
  };
  wire.onJoin((peer) => wire.send(peer, { k: "owner" }));
  wire.onMessage((from, body) => {
    const rec = body as Record<string, unknown>;
    if (!rec || rec.k === "join") {
      wire.send(from, { k: "owner" });
      return;
    }
    if (rec.k === "owner" || !docSession) return;
    // Only the owner resolves comments.
    if (rec.t === "resolve") return;
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
    void loadRecord("doc:" + id).then(async (saved) => {
      if (ownerPeer || inited) return;
      let data = saved?.data as DocRecord | null;
      if (!data?.snapshot) {
        const file = await readSavedVersion();
        if (file?.snapshot) data = { title: String(file.title || "Untitled document"), rev: 0, snapshot: file.snapshot as Snapshot } as unknown as DocRecord;
      }
      if (ownerPeer || inited) return;
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
    void loadRecord("book:" + id).then(async (saved) => {
      if (ownerPeer || inited) return;
      let data = saved?.data as BookRecord | null;
      if (!data?.book) {
        const file = await readSavedVersion();
        if (file?.book) data = { title: String(file.title || "Untitled spreadsheet"), rev: 0, book: file.book as Book } as BookRecord;
      }
      if (ownerPeer || inited) return;
      if (data?.book) {
        inited = true;
        sock.deliver(
          JSON.stringify({
            t: "init",
            rev: data.rev,
            book: data.book,
            title: data.title,
            role: "view",
            self: { sid: "offline", name: "Guest", color: "#188038" },
            presence: [],
            threads: [],
          }),
        );
      }
      lock();
    });
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
  if (saveDownload) download(bytes, docSession ? "fipen.json" : "figrid.json");
  return raw;
}

async function loadActive(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as { kind?: string; title?: string; snapshot?: Snapshot; book?: Book };
  const bytes = new TextEncoder().encode(raw);
  const cid = await files.put(bytes);
  await putBlob(cid, bytes);
  setCid(cid);
  if (parsed.snapshot && docSession) {
    const contentCid = (parsed as { contentCid?: string }).contentCid;
    docSession.replace(parsed.snapshot, parsed.title, contentCid);
  }
  else if (parsed.book && bookSession) bookSession.replace(parsed.book, parsed.title);
  else throw new Error("This file does not match the open editor");
}

async function saveFilecoin(network: FilecoinNetwork, privateKey: string): Promise<{ pieceCid: string; path: string; notice: string }> {
  const raw = docSession ? docSession.exportJson() : bookSession ? bookSession.exportJson() : "";
  if (!raw) throw new Error("Nothing to save");
  const bytes = new TextEncoder().encode(raw);
  const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
  if (network !== "calibration") {
    const adapter: StorageAdapter = await synapseAdapter({
      network,
      privateKey: privateKey || undefined,
      provider: privateKey ? undefined : eth,
    });
    const pieceCid = await adapter.put(bytes);
    await putBlob(pieceCid, bytes);
    setCid(pieceCid);
    markFilecoinSaved(raw, activeTitle());
    return { pieceCid, path: "", notice: NO_REGISTRY_NOTICE };
  }
  const mock = mockSynapse();
  const volume = await openCalibrationVolume({
    privateKey: privateKey || undefined,
    provider: privateKey || mock ? undefined : eth,
    synapse: mock ?? undefined,
  });
  const saved = await saveSnapshot({
    kind: docSession ? "felarumi" : "felanumio",
    title: docSession?.title || bookSession?.title || "Untitled",
    bytes,
    owner: volume.owner,
    storage: volume.storage,
    registry: volume.registry,
  });
  await putBlob(saved.pieceCid, bytes);
  setCid(saved.pieceCid);
  markFilecoinSaved(raw, activeTitle());
  return { pieceCid: saved.pieceCid, path: saved.path, notice: "" };
}

function installUi(): void {
  const style = document.createElement("style");
  style.textContent = "#p2p-wait{position:sticky;top:0;z-index:80;background:#fef7e0;color:#202124;padding:8px 16px;text-align:center}#p2p-dialog{position:fixed;inset:0;background:rgba(32,33,36,.32);display:grid;place-items:center;z-index:90}#p2p-dialog .card{background:#fff;border-radius:12px;padding:16px;width:min(520px,92vw);max-height:88vh;overflow:auto;display:grid;gap:8px}#p2p-dialog[hidden]{display:none}#p2p-files,#p2p-history{display:grid;gap:4px;font-size:12px;word-break:break-all}#p2p-registry{margin:0}.p2p-saverow{display:inline-flex;align-items:center;gap:6px;margin-left:8px;white-space:nowrap;vertical-align:middle}.p2p-saverow .status,.p2p-saverow #status{padding-left:0}.p2p-save{padding:2px 12px;border:1px solid #dadce0;border-radius:14px;background:#fff;color:#1a73e8;font:500 13px system-ui,sans-serif;cursor:pointer}.p2p-save:hover{background:#f1f3f4}";
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
    <p id="p2p-registry">${NO_REGISTRY_NOTICE}</p>
    <button type="button" id="p2p-wallet">Connect wallet</button>
    <input id="p2p-key" type="password" placeholder="Or paste a private key" autocomplete="off">
    <button type="button" id="p2p-key-save">Save with key</button>
    <button type="button" id="p2p-open">Open from Filecoin</button>
    <div id="p2p-files"></div>
    <div id="p2p-history"></div>
    <p>IPFS is optional.</p>
    <input id="p2p-ipfs" type="password" placeholder="IPFS token" autocomplete="off">
    <button type="button" id="p2p-ipfs-save">Save to IPFS</button>
    <button type="button" id="p2p-file">Download file</button>
    <p id="p2p-status"></p>
    <button type="button" id="p2p-close">Close</button></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector("#p2p-status") as HTMLElement;
  const registryNote = dialog.querySelector("#p2p-registry") as HTMLElement;
  const filesEl = dialog.querySelector("#p2p-files") as HTMLElement;
  const historyEl = dialog.querySelector("#p2p-history") as HTMLElement;
  const network = (): FilecoinNetwork => {
    const picked = dialog.querySelector('input[name="p2p-net"]:checked') as HTMLInputElement | null;
    const value = normalizeNetwork(picked?.value);
    sessionStorage.setItem("felarumi-filecoin-net", value);
    return value;
  };
  const showRegistry = (net: FilecoinNetwork) => {
    registryNote.textContent = net === "calibration"
      ? `FolderRegistry ${CALIBRATION_REGISTRY} from block ${CALIBRATION_FROM_BLOCK}`
      : NO_REGISTRY_NOTICE;
  };
  const clearBrowser = () => {
    filesEl.replaceChildren();
    historyEl.replaceChildren();
  };
  for (const input of dialog.querySelectorAll<HTMLInputElement>('input[name="p2p-net"]')) {
    input.addEventListener("change", () => {
      const net = network();
      showRegistry(net);
      if (net !== "calibration") clearBrowser();
    });
  }
  end.addEventListener("click", () => {
    const current = currentNetwork();
    for (const input of dialog.querySelectorAll<HTMLInputElement>('input[name="p2p-net"]')) input.checked = input.value === current;
    showRegistry(current);
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
  const reportSave = (saved: { pieceCid: string; path: string; notice: string }) => {
    const where = saved.path ? saved.path + " " : "PieceCID ";
    status.textContent = where + saved.pieceCid + (saved.notice ? ". " + saved.notice : "");
  };
  dialog.querySelector("#p2p-wallet")!.addEventListener("click", () => {
    const key = dialog.querySelector("#p2p-key") as HTMLInputElement;
    key.value = "";
    void saveFilecoin(network(), "").then(reportSave).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
  dialog.querySelector("#p2p-key-save")!.addEventListener("click", () => {
    const key = dialog.querySelector("#p2p-key") as HTMLInputElement;
    const value = key.value.trim();
    key.value = "";
    void saveFilecoin(network(), value).then(reportSave).catch((err: Error) => {
      status.textContent = err.message;
    });
  });
  dialog.querySelector("#p2p-open")!.addEventListener("click", () => {
    const net = network();
    if (net !== "calibration") {
      clearBrowser();
      status.textContent = NO_REGISTRY_NOTICE;
      return;
    }
    const key = dialog.querySelector("#p2p-key") as HTMLInputElement;
    const value = key.value.trim();
    key.value = "";
    void openFromFilecoin(value).catch((err: Error) => {
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

  async function paintHistory(volume: Awaited<ReturnType<typeof openCalibrationVolume>>, path?: string): Promise<void> {
    historyEl.replaceChildren();
    const heading = document.createElement("div");
    heading.textContent = path ? "Version history " + path : "Version history";
    historyEl.append(heading);
    const versions = await volumeHistory(volume, path);
    if (!versions.length) {
      const empty = document.createElement("div");
      empty.textContent = "No versions yet";
      historyEl.append(empty);
      return;
    }
    for (const entry of versions.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "p2p-version";
      const ms = entry.timestamp < 1e12 ? entry.timestamp * 1000 : entry.timestamp;
      const when = Number.isFinite(ms) ? new Date(ms).toISOString() : "";
      row.textContent = `v${entry.version} ${when} ${entry.pieceCid}`;
      historyEl.append(row);
    }
  }

  async function openFromFilecoin(privateKey: string): Promise<void> {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    const mock = mockSynapse();
    const volume = await openCalibrationVolume({
      privateKey: privateKey || undefined,
      provider: privateKey || mock ? undefined : eth,
      synapse: mock ?? undefined,
    });
    clearBrowser();
    const docs = [...(await listSnapshots(volume, FIPEN_DIR)), ...(await listSnapshots(volume, FELARUMI_DIR))];
    const sheets = [...(await listSnapshots(volume, FIGRID_DIR)), ...(await listSnapshots(volume, FELANUMIO_DIR))];
    const files = [...docs, ...sheets].filter((entry) => entry.type === "file");
    if (!files.length) {
      const empty = document.createElement("p");
      empty.textContent = "No files in /FiPen, /FiGrid, /Felarumi, or /Felanumio";
      filesEl.append(empty);
    }
    for (const entry of files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "p2p-file";
      button.textContent = entry.path;
      button.addEventListener("click", () => {
        void volume.get(entry.path).then(async (bytes) => {
          await loadActive(new TextDecoder().decode(bytes));
          status.textContent = "Opened " + entry.path;
          await paintHistory(volume, entry.path);
        }).catch((err: Error) => {
          status.textContent = err.message;
        });
      });
      filesEl.append(button);
    }
    await paintHistory(volume);
    status.textContent = files.length ? "Choose a file" : "No files in /FiPen, /FiGrid, /Felarumi, or /Felanumio";
  }
}

function mockSynapse(): SynapseLike | null {
  return (window as unknown as { __synapseClient?: SynapseLike }).__synapseClient ?? null;
}

async function signingAdapter(): Promise<StorageAdapter> {
  const mock = mockSynapse();
  if (mock) return synapseAdapter({ client: mock, network: currentNetwork() });
  let mode = "filecoin";
  try {
    mode = sessionStorage.getItem("felarumi-storage") || "filecoin";
  } catch {
    mode = "filecoin";
  }
  if (mode === "file") return commpAdapter(pieceMemory);
  if (mode === "ipfs") {
    const token = sessionStorage.getItem("felarumi-ipfs-token") || "";
    if (!token) throw new Error("Add an IPFS token before signing");
    return ipfsAdapter(token);
  }
  const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
  if (!eth) throw new Error("Connect a wallet to anchor this document on Filecoin");
  return synapseAdapter({ network: currentNetwork(), provider: eth });
}

async function putUnsigned(bytes: Uint8Array): Promise<string> {
  const cid = await (await signingAdapter()).put(bytes);
  pieceMemory.set(cid, bytes);
  await putBlob(cid, bytes);
  return cid;
}

async function fetchCid(cid: string): Promise<Uint8Array> {
  const saved = await getBlob(cid);
  if (saved) return saved;
  const cached = pieceMemory.get(cid);
  if (cached) return cached;
  return (await signingAdapter()).get(cid);
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
    putUnsigned: (bytes: Uint8Array) => putUnsigned(bytes),
    fetchCid: (cid: string) => fetchCid(cid),
    pieceCidOf: (bytes: Uint8Array) => commpOf(bytes),
  };
}

type SaveState = "clean" | "saved" | "dirty" | "saving" | "failed";

const SAVE_TEXT: Record<SaveState, string> = {
  clean: "All changes saved",
  saved: "Saved to Filecoin",
  dirty: "Unsaved changes",
  saving: "Saving…",
  failed: "Save failed",
};

/** Filecoin autosave period. Each save is a paid piece, so it only runs when there are unsaved changes. */
export const AUTOSAVE_MS = 5 * 60 * 1000;

/** Last content known to be on Filecoin. Standalone saves (the dialog) report here too. */
const filecoinMark = { raw: "", title: "", saved: false };

function markFilecoinSaved(raw: string, title: string): void {
  filecoinMark.raw = raw;
  filecoinMark.title = title;
  filecoinMark.saved = true;
}

/** The one writer of #status. The editors skip their own status text once this owns it. */
function paintSave(state: SaveState): void {
  const status = document.querySelector("#status");
  if (!status) return;
  status.textContent = SAVE_TEXT[state];
  status.setAttribute("data-save", state);
}

function activeJson(): string {
  return docSession ? docSession.exportJson() : bookSession ? bookSession.exportJson() : "";
}

function activeTitle(): string {
  const input = document.querySelector("#title") as HTMLInputElement | null;
  return (input?.value || docSession?.title || bookSession?.title || "").trim();
}

/** Puts the save status and a Save button to the right of the title, and binds Cmd/Ctrl+S. */
function installSaveButton(save: () => void): void {
  const place = () => {
    const status = document.querySelector("#status") as HTMLElement | null;
    const title = document.querySelector("#title") as HTMLElement | null;
    if (!status || !title) return false;
    if (document.querySelector("#p2p-save")) return true;
    const row = document.createElement("span");
    row.id = "p2p-saverow";
    row.className = "p2p-saverow";
    title.after(row);
    const button = document.createElement("button");
    button.type = "button";
    button.id = "p2p-save";
    button.className = "p2p-save";
    button.textContent = "Save";
    button.title = "Save to Filecoin (Ctrl+S)";
    button.addEventListener("click", save);
    row.append(status, button);
    return true;
  };
  if (!place()) {
    const timer = window.setInterval(() => {
      if (place()) window.clearInterval(timer);
    }, 250);
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
        save();
      }
    },
    true,
  );
}

function installSaveFlow(): void {
  const params = new URLSearchParams(location.search);
  const embedded = params.get("fifolders") === "1";
  document.documentElement.dataset.saveOwner = embedded ? "fifolders" : "p2p";
  const path = params.get("path") || "";
  const id = "fel:" + path;
  let baseRaw = "";
  let baseTitle = "";
  let sent = "";
  let sentTitle = "";
  const readOps = (): { id?: string; kind?: string; path?: string; stage?: string; status?: string; content?: string }[] => {
    try {
      const parsed = JSON.parse(localStorage.getItem("fifolders:ops") || "{}") as { ops?: unknown };
      return Array.isArray(parsed.ops) ? (parsed.ops as { id?: string }[]) : [];
    } catch {
      return [];
    }
  };
  const ownOp = () => readOps().find((item) => item.id === id || (item.kind === "fel-save" && item.path === path));
  const dirty = (raw: string): boolean => {
    const title = activeTitle();
    const ref = filecoinMark.saved ? filecoinMark : { raw: baseRaw, title: baseTitle };
    return raw !== ref.raw || title !== ref.title;
  };
  const state = (raw: string): SaveState => {
    if (embedded && sent) {
      const op = ownOp();
      if (!op || op.stage === "saved" || op.stage === "done" || op.status === "done") {
        // FiFolders drops the op once the bytes are in the volume.
        markFilecoinSaved(sent, sentTitle);
        sent = "";
      } else if (op.status === "error" || op.stage === "error" || op.stage === "interrupted") return "failed";
      else if (op.content === raw) return "saving";
    }
    if (!dirty(raw)) return filecoinMark.saved ? "saved" : "clean";
    return "dirty";
  };
  const paint = () => {
    const raw = activeJson();
    if (raw) paintSave(state(raw));
  };
  const queueSave = () => {
    const raw = activeJson();
    if (!raw) return;
    const title = activeTitle();
    const name = params.get("name") || "";
    const now = Date.now();
    const ops = readOps().filter((op) => op.id !== id);
    const next = {
      id,
      v: 1,
      kind: "fel-save",
      label: title || name || path || "Save",
      status: "pending",
      stage: "saving",
      path,
      name,
      title,
      content: raw,
      volume: params.get("volume") || "",
      owner: params.get("owner") || "",
      pieceCid: params.get("pieceCid") || undefined,
      created: now,
      updated: now,
    };
    localStorage.setItem("fifolders:ops", JSON.stringify({ v: 1, ops: [...ops, next] }));
    sent = raw;
    sentTitle = title;
    try {
      const channel = new BroadcastChannel("fifolders-ops");
      channel.postMessage({ v: 1 });
      channel.close();
    } catch {
      // The storage write is enough for the FiFolders tab.
    }
    paint();
  };
  const isDirty = () => {
    const raw = activeJson();
    return !!raw && !!baseRaw && dirty(raw) && sent !== raw;
  };
  const save = (auto: boolean) => {
    if (!activeJson()) return;
    if (!isDirty()) {
      paint();
      return;
    }
    if (embedded) queueSave();
    else if (!auto) {
      const dialog = document.querySelector("#p2p-dialog") as HTMLElement | null;
      if (dialog) dialog.hidden = false;
    }
  };
  installSaveButton(() => save(false));
  // Standalone autosave needs a signer the tab does not keep, so only the embedded mode autosaves.
  window.setInterval(() => save(true), Number((window as unknown as { __p2pAutosaveMs?: number }).__p2pAutosaveMs) || AUTOSAVE_MS);
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const tick = () => {
    const title = document.querySelector("#title") as HTMLInputElement | null;
    const name = (params.get("name") || "").replace(/\.(felarumi|felanumio|fipen|figrid)$/i, "");
    if (embedded && title && name && !title.dataset.fifolders) {
      title.dataset.fifolders = "1";
      title.value = name;
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const home = document.querySelector("#home") as HTMLElement | null;
    const blank = document.querySelector("#blank") as HTMLButtonElement | null;
    if (embedded && home && !home.hidden && blank && !blank.dataset.fifolders) {
      blank.dataset.fifolders = "1";
      blank.click();
    }
    const raw = activeJson();
    if (raw && !baseRaw) {
      // The first content (opened from FiFolders or local) is the clean baseline.
      baseRaw = raw;
      baseTitle = activeTitle();
    }
    paint();
  };
  window.setInterval(tick, 1000);
  window.setTimeout(tick, 50);
  window.addEventListener("storage", (event) => {
    if (event.key === "fifolders:ops") paint();
  });
}

if ((window as unknown as { __FELARUMI_P2P__?: boolean }).__FELARUMI_P2P__) {
  window.WebSocket = shimWebSocket as unknown as typeof WebSocket;
  installFetch();
  installApi();
  installUi();
  installSaveFlow();
  window.setTimeout(() => void warmSigningModules(), 3000);
}

export {};
