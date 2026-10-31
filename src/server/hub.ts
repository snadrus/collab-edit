import type { WebSocket } from "ws";
import { deltaToCommands, commandsToDelta, type Command } from "../shared/commands.ts";
import { applyDoc, snapshotDoc, restoreDoc, plainText, type Doc, type Snapshot } from "../shared/doc.ts";
import { insertedRanges } from "../shared/replace.ts";
import { ServerDoc } from "../shared/engine.ts";
import { assignColor } from "../shared/palette.ts";
import { type PageSpec, normalizePage } from "../shared/page.ts";
import { type Reply, type Thread, sanitizeThread, validId } from "../shared/threads.ts";
import { type SuggestionMeta, sanitizeSuggestion } from "../shared/suggest.ts";
import { type Role } from "../shared/access.ts";
import { Store, type LoadedDoc } from "./store.ts";

export function colorFor(used: Iterable<string>, sid: string): string {
  return assignColor(used, sid);
}

interface Conn {
  ws: WebSocket;
  sid: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
  role: Role;
}

interface Room {
  id: string;
  title: string;
  titleTs: number;
  server: ServerDoc;
  conns: Set<Conn>;
  threads: Map<string, Thread>;
  suggestions: Map<string, SuggestionMeta>;
  page: PageSpec;
  pageTs: number;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function permits(role: Role, t: string): boolean {
  if (role === "edit") return true;
  if (role === "view") return t === "sel" || t === "name" || t === "history" || t === "preview" || t === "compare";
  return t !== "title" && t !== "page" && t !== "namever";
}

export class Hub {
  rooms = new Map<string, Room>();
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  open(id: string): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    if (!this.store.exists(id)) this.store.create(id, "Untitled document");
    const loaded = this.store.load(id);
    if (!loaded) throw new Error("missing document");
    const room = this.hydrate(loaded);
    this.rooms.set(id, room);
    return room;
  }

  hydrate(loaded: LoadedDoc): Room {
    const base = restoreDoc(loaded.snap);
    const server = new ServerDoc(base);
    server.rev = loaded.snapRev;
    const ordered = [...loaded.ops].sort((a, b) => a.rev - b.rev);
    server.log = [];
    for (const op of ordered) {
      if (op.rev <= loaded.snapRev) {
        server.log[op.rev - 1] = { delta: op.delta, sid: op.sid, reqId: op.reqId };
        continue;
      }
      server.doc = applyDoc(server.doc, op.delta);
      server.rev = op.rev;
      server.log[op.rev - 1] = { delta: op.delta, sid: op.sid, reqId: op.reqId };
    }
    if (server.log.length !== server.rev || server.log.some((entry) => !entry)) throw new Error("oplog has gaps");
    for (const ack of loaded.acks) server.acks.set(ack.sid + ":" + ack.reqId, ack.assigned);
    const threads = new Map<string, Thread>();
    for (const thread of this.store.loadThreads(loaded.id)) threads.set(thread.id, thread);
    const suggestions = new Map<string, SuggestionMeta>();
    for (const suggestion of this.store.loadSuggestions(loaded.id)) suggestions.set(suggestion.id, suggestion);
    const page = this.store.loadPage(loaded.id);
    return {
      id: loaded.id,
      title: loaded.title,
      titleTs: loaded.titleTs,
      server,
      conns: new Set(),
      threads,
      suggestions,
      page: page.page,
      pageTs: page.ts,
    };
  }

  snapshot(room: Room): Snapshot {
    return snapshotDoc(room.server.doc);
  }

  presence(room: Room) {
    return [...room.conns].map((c) => ({
      sid: c.sid,
      name: c.name,
      color: c.color,
      anchor: c.anchor,
      head: c.head,
    }));
  }

  connect(room: Room, ws: WebSocket, sid: string, name: string, since: number | null, resume: boolean, role: Role = "edit"): Conn {
    const same = [...room.conns].find((c) => c.sid === sid);
    const color = same ? same.color : colorFor([...room.conns].map((c) => c.color), sid);
    const conn: Conn = { ws, sid, name: name.slice(0, 40) || "Guest", color, anchor: 0, head: 0, role };
    room.conns.add(conn);
    this.pushInit(room, conn, since, resume);
    this.broadcast(room, { t: "join", sid: conn.sid, name: conn.name, color: conn.color }, conn);
    return conn;
  }

  pushInit(room: Room, conn: Conn, since: number | null = null, resume = false): void {
    const catchup = [];
    if (since != null && since >= 0 && since < room.server.rev) {
      for (let rev = since + 1; rev <= room.server.rev; rev++) {
        const entry = room.server.log[rev - 1];
        if (!entry) break;
        catchup.push({ rev, sid: entry.sid, reqId: entry.reqId, commands: deltaToCommands(entry.delta) });
      }
    }
    send(conn.ws, {
      t: "init",
      rev: room.server.rev,
      snapshot: this.snapshot(room),
      title: room.title,
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: this.presence(room),
      threads: [...room.threads.values()],
      suggestions: [...room.suggestions.values()],
      page: room.page,
      role: conn.role,
      trashed: this.store.trashedAt(room.id) > 0,
      resume: resume && since != null && catchup.length === room.server.rev - since,
      catchup,
    });
  }

  docAt(room: Room, rev: number): Doc {
    if (rev >= room.server.rev) return room.server.doc;
    const base = this.store.snapAt(room.id, Math.max(0, rev));
    let doc = restoreDoc(base.snap);
    for (let r = base.rev + 1; r <= rev; r++) {
      const entry = room.server.log[r - 1];
      if (!entry) break;
      doc = applyDoc(doc, entry.delta);
    }
    return doc;
  }

  disconnect(room: Room, conn: Conn): void {
    room.conns.delete(conn);
    const still = [...room.conns].some((c) => c.sid === conn.sid);
    if (!still) this.broadcast(room, { t: "bye", sid: conn.sid }, null);
    if (room.conns.size === 0) this.rooms.delete(room.id);
  }

  broadcast(room: Room, msg: unknown, except: Conn | null): void {
    for (const c of room.conns) {
      if (c !== except) send(c.ws, msg);
    }
  }

  handle(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const t = msg.t;
    if (typeof t !== "string" || !permits(conn.role, t)) return;
    if (t === "op") this.onOp(room, conn, msg);
    else if (t === "sel") this.onSel(room, conn, msg);
    else if (t === "title") this.onTitle(room, conn, msg);
    else if (t === "name") this.onName(room, conn, msg);
    else if (t === "thread") this.onThread(room, conn, msg);
    else if (t === "reply") this.onReply(room, conn, msg);
    else if (t === "resolve") this.onResolve(room, conn, msg);
    else if (t === "history") this.onHistory(room, conn);
    else if (t === "preview") this.onPreview(room, conn, msg);
    else if (t === "compare") this.onCompare(room, conn, msg);
    else if (t === "namever") this.onNameVersion(room, conn, msg);
    else if (t === "page") this.onPage(room, msg);
    else if (t === "suggest") this.onSuggest(room, conn, msg);
  }

  onOp(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const sid = typeof msg.sid === "string" ? msg.sid : conn.sid;
    const reqId = msg.reqId;
    const rev = msg.rev;
    if (typeof reqId !== "number" || typeof rev !== "number" || !Array.isArray(msg.commands)) {
      send(conn.ws, { t: "reject", reqId: reqId ?? null, error: "bad op" });
      return;
    }
    let delta;
    try {
      delta = commandsToDelta(msg.commands as Command[]);
    } catch (err) {
      send(conn.ws, { t: "reject", reqId, error: err instanceof Error ? err.message : "bad commands" });
      return;
    }
    const res = room.server.submit(sid, reqId, rev, delta);
    if (res.error) {
      send(conn.ws, { t: "reject", reqId, error: res.error, serverRev: res.serverRev });
      this.pushInit(room, conn);
      return;
    }
    if (!res.duplicate) {
      try {
        this.store.appendOp(room.id, res.assignedRev ?? room.server.rev, sid, reqId, res.delta, res.assignedRev, res.delta ? room.server.doc : null);
        if (res.assignedRev != null) this.store.noteVersion(room.id, res.assignedRev, Date.now(), conn.sid, conn.name, conn.color);
      } catch (err) {
        console.error("persist failed", err);
      }
    }
    if (res.duplicate || res.assignedRev == null) {
      send(conn.ws, { t: "ack", reqId, assignedRev: res.assignedRev, serverRev: res.serverRev });
      return;
    }
    const commands = deltaToCommands(res.delta!);
    this.broadcast(room, { t: "op", rev: res.assignedRev, sid, reqId, commands }, null);
  }

  onSel(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    if (typeof msg.anchor !== "number" || typeof msg.head !== "number") return;
    conn.anchor = msg.anchor;
    conn.head = msg.head;
    this.broadcast(
      room,
      { t: "sel", sid: conn.sid, name: conn.name, color: conn.color, anchor: conn.anchor, head: conn.head, rev: room.server.rev },
      conn,
    );
  }

  onTitle(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    if (typeof msg.title !== "string" || typeof msg.ts !== "number") return;
    const title = msg.title.trim().slice(0, 200) || "Untitled document";
    if (msg.ts < room.titleTs) return;
    room.title = title;
    room.titleTs = msg.ts;
    this.store.setTitle(room.id, title, msg.ts);
    this.broadcast(room, { t: "title", title, ts: msg.ts }, null);
  }

  onName(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    if (typeof msg.name !== "string") return;
    conn.name = msg.name.trim().slice(0, 40) || "Guest";
    this.broadcast(room, { t: "join", sid: conn.sid, name: conn.name, color: conn.color }, null);
  }

  publishThread(room: Room, thread: Thread): void {
    this.store.saveThread(room.id, thread);
    this.broadcast(room, { t: "thread", thread }, null);
  }

  onThread(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const id = validId(msg.id);
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
    if (!id || !text) return;
    const existing = room.threads.get(id);
    if (existing) {
      this.broadcast(room, { t: "thread", thread: existing }, null);
      return;
    }
    const thread: Thread = {
      id,
      sid: conn.sid,
      name: conn.name,
      color: conn.color,
      text,
      ts: Date.now(),
      quote: typeof msg.quote === "string" ? msg.quote.replace(/\s+/g, " ").trim().slice(0, 240) : "",
      resolved: false,
      replies: [],
    };
    const clean = sanitizeThread(thread);
    if (!clean) return;
    room.threads.set(id, clean);
    this.publishThread(room, clean);
  }

  onReply(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const id = validId(msg.id);
    const replyId = validId(msg.replyId);
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
    const thread = id ? room.threads.get(id) : undefined;
    if (!thread || !replyId || !text) return;
    if (thread.replies.some((r) => r.id === replyId)) {
      this.broadcast(room, { t: "thread", thread }, null);
      return;
    }
    const reply: Reply = { id: replyId, sid: conn.sid, name: conn.name, text, ts: Date.now() };
    thread.replies.push(reply);
    this.publishThread(room, thread);
  }

  onResolve(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const id = validId(msg.id);
    const thread = id ? room.threads.get(id) : undefined;
    if (!thread || typeof msg.resolved !== "boolean") return;
    void conn;
    thread.resolved = msg.resolved;
    this.publishThread(room, thread);
  }

  onSuggest(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const clean = sanitizeSuggestion(msg.suggestion);
    if (!clean) return;
    clean.sid = conn.sid;
    clean.name = conn.name;
    clean.color = conn.color;
    room.suggestions.set(clean.id, clean);
    this.store.saveSuggestion(room.id, clean);
    this.broadcast(room, { t: "suggest", suggestion: clean }, null);
  }

  onPage(room: Room, msg: Record<string, unknown>): void {
    if (typeof msg.ts !== "number") return;
    const page = normalizePage(msg.page);
    if (msg.ts < room.pageTs) return;
    room.page = page;
    room.pageTs = msg.ts;
    this.store.setPage(room.id, page, msg.ts);
    this.broadcast(room, { t: "page", page, ts: msg.ts }, null);
  }

  onHistory(room: Room, conn: Conn): void {
    send(conn.ws, { t: "history", versions: this.store.versions(room.id) });
  }

  onPreview(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const rev = msg.rev;
    if (typeof rev !== "number" || rev < 0 || rev > room.server.rev) return;
    const versions = this.store.versions(room.id);
    const current = versions.find((v) => v.rev === rev) || versions.find((v) => v.rev <= rev);
    const prevRev = versions.filter((v) => v.rev < rev).reduce((m, v) => Math.max(m, v.rev), 0);
    const doc = this.docAt(room, rev);
    const prev = this.docAt(room, prevRev);
    const color = current?.color || conn.color;
    const marks = insertedRanges(prev.text, doc.text).map((span) => ({ ...span, color }));
    send(conn.ws, { t: "preview", rev, snapshot: snapshotDoc(doc), marks, name: current?.name || "", label: current?.label || "" });
  }

  onCompare(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const a = msg.a;
    const b = msg.b;
    if (typeof a !== "number" || typeof b !== "number" || a < 0 || b < 0) return;
    const cap = room.server.rev;
    const left = plainText(this.docAt(room, Math.min(cap, Math.floor(a))));
    const right = plainText(this.docAt(room, Math.min(cap, Math.floor(b))));
    send(conn.ws, { t: "compare", a, b, left, right });
  }

  onNameVersion(room: Room, conn: Conn, msg: Record<string, unknown>): void {
    const label = typeof msg.label === "string" ? msg.label : "";
    this.store.nameVersion(room.id, room.server.rev, Date.now(), conn.sid, conn.name, conn.color, label);
    send(conn.ws, { t: "named", rev: room.server.rev, label: label.trim().slice(0, 80) });
  }
}
