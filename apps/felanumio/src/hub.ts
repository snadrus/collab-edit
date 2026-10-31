import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import { type Role, type ShareTokens, emptyTokens, normalizeRole, parseTokens, roleForToken } from "../../../packages/core/src/access.ts";
import { assignColor } from "../../../packages/core/src/palette.ts";
import { type Thread, sanitizeThread } from "../../../packages/core/src/threads.ts";
import { type Book, type GridDelta, ServerBook, emptyBook } from "./ot.ts";

export interface BookConn {
  ws: WebSocket;
  sid: string;
  name: string;
  color: string;
  role: Role;
}

interface Room {
  id: string;
  title: string;
  titleTs: number;
  server: ServerBook;
  conns: Set<BookConn>;
  threads: Map<string, Thread>;
}

function freshTokens(): ShareTokens {
  const tok = () => randomBytes(9).toString("base64url");
  return { edit: tok(), comment: tok(), view: tok() };
}

export class BookStore {
  db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "felanumio.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_ts INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        updated INTEGER NOT NULL,
        access TEXT NOT NULL DEFAULT 'edit',
        share TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS book_versions (
        book_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        sid TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        PRIMARY KEY (book_id, rev)
      );
      CREATE TABLE IF NOT EXISTS book_threads (
        book_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (book_id, id)
      );
    `);
  }

  list(): { id: string; title: string; updated: number }[] {
    return this.db.prepare("SELECT id, title, updated FROM books ORDER BY updated DESC").all() as { id: string; title: string; updated: number }[];
  }

  create(id: string, title: string): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO books (id, title, title_ts, rev, data, updated, access, share) VALUES (?, ?, ?, 0, ?, ?, 'edit', ?)")
      .run(id, title, now, JSON.stringify(emptyBook()), now, JSON.stringify(freshTokens()));
  }

  load(id: string): { title: string; titleTs: number; rev: number; book: Book; access: Role; tokens: ShareTokens } | null {
    const row = this.db.prepare("SELECT title, title_ts, rev, data, access, share FROM books WHERE id = ?").get(id) as
      | { title: string; title_ts: number; rev: number; data: string; access: string; share: string }
      | undefined;
    if (!row) return null;
    let book = emptyBook();
    try {
      book = JSON.parse(row.data) as Book;
    } catch {
      book = emptyBook();
    }
    let tokens = emptyTokens();
    try {
      tokens = parseTokens(JSON.parse(row.share));
    } catch {
      tokens = emptyTokens();
    }
    if (!tokens.edit) {
      tokens = freshTokens();
      this.db.prepare("UPDATE books SET share = ? WHERE id = ?").run(JSON.stringify(tokens), id);
    }
    return { title: row.title, titleTs: row.title_ts, rev: row.rev, book, access: normalizeRole(row.access), tokens };
  }

  save(id: string, book: Book, rev: number): void {
    this.db.prepare("UPDATE books SET data = ?, rev = ?, updated = ? WHERE id = ?").run(JSON.stringify(book), rev, Date.now(), id);
  }

  setTitle(id: string, title: string, ts: number): void {
    this.db.prepare("UPDATE books SET title = ?, title_ts = ?, updated = ? WHERE id = ? AND title_ts <= ?").run(title, ts, Date.now(), id, ts);
  }

  tokensFor(id: string): { access: Role; tokens: ShareTokens } {
    const loaded = this.load(id);
    return loaded ? { access: loaded.access, tokens: loaded.tokens } : { access: "edit", tokens: emptyTokens() };
  }

  setAccess(id: string, access: Role): void {
    this.db.prepare("UPDATE books SET access = ? WHERE id = ?").run(access, id);
  }

  roleFor(id: string, token: string): Role {
    const loaded = this.load(id);
    if (!loaded) return "view";
    return roleForToken(loaded.access, loaded.tokens, token);
  }

  idForToken(token: string): { id: string; role: Role } | null {
    const rows = this.db.prepare("SELECT id, access, share FROM books").all() as { id: string; access: string; share: string }[];
    for (const row of rows) {
      let tokens = emptyTokens();
      try {
        tokens = parseTokens(JSON.parse(row.share));
      } catch {
        continue;
      }
      const role = roleForToken(normalizeRole(row.access), tokens, token);
      if (token && (token === tokens.edit || token === tokens.comment || token === tokens.view)) return { id: row.id, role };
    }
    return null;
  }

  threads(id: string): Thread[] {
    const rows = this.db.prepare("SELECT data FROM book_threads WHERE book_id = ?").all(id) as { data: string }[];
    return rows.map((row) => sanitizeThread(JSON.parse(row.data))).filter((thread): thread is Thread => !!thread);
  }

  saveThread(id: string, thread: Thread): void {
    this.db.prepare("INSERT OR REPLACE INTO book_threads (book_id, id, data) VALUES (?, ?, ?)").run(id, thread.id, JSON.stringify(thread));
  }

  noteVersion(id: string, rev: number, sid: string, name: string, book: Book, label = ""): void {
    this.db
      .prepare("INSERT OR REPLACE INTO book_versions (book_id, rev, ts, sid, name, label, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, rev, Date.now(), sid, name, label.slice(0, 80), JSON.stringify(book));
  }

  versions(id: string): { rev: number; ts: number; name: string; label: string }[] {
    return this.db.prepare("SELECT rev, ts, name, label FROM book_versions WHERE book_id = ? ORDER BY rev DESC").all(id) as {
      rev: number;
      ts: number;
      name: string;
      label: string;
    }[];
  }

  versionBook(id: string, rev: number): Book | null {
    const row = this.db.prepare("SELECT data FROM book_versions WHERE book_id = ? AND rev = ?").get(id, rev) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as Book;
  }
}

function permits(role: Role, t: string): boolean {
  if (role === "edit") return true;
  if (role === "view") return t === "sel" || t === "history" || t === "preview";
  return t !== "op" && t !== "title" && t !== "namever" && t !== "restore";
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export class BookHub {
  rooms = new Map<string, Room>();
  store: BookStore;

  constructor(store: BookStore) {
    this.store = store;
  }

  open(id: string): Room | null {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const loaded = this.store.load(id);
    if (!loaded) return null;
    const server = new ServerBook(loaded.book);
    server.rev = loaded.rev;
    server.logBase = loaded.rev;
    const room: Room = { id, title: loaded.title, titleTs: loaded.titleTs, server, conns: new Set(), threads: new Map() };
    for (const thread of this.store.threads(id)) room.threads.set(thread.id, thread);
    this.rooms.set(id, room);
    return room;
  }

  connect(room: Room, ws: WebSocket, sid: string, name: string, role: Role): BookConn {
    const used = [...room.conns].map((conn) => conn.color);
    const conn: BookConn = { ws, sid, name: name.slice(0, 40) || "Guest", color: assignColor(used, sid), role };
    room.conns.add(conn);
    this.pushInit(room, conn);
    this.broadcast(room, { t: "join", sid, name: conn.name, color: conn.color }, conn);
    return conn;
  }

  pushInit(room: Room, conn: BookConn): void {
    send(conn.ws, {
      t: "init",
      rev: room.server.rev,
      book: room.server.book,
      title: room.title,
      role: conn.role,
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: [...room.conns].filter((other) => other !== conn).map((other) => ({ sid: other.sid, name: other.name, color: other.color })),
      threads: [...room.threads.values()],
    });
  }

  handle(room: Room, conn: BookConn, msg: Record<string, unknown>): void {
    const t = msg.t;
    if (typeof t !== "string" || !permits(conn.role, t)) return;
    if (t === "op") this.onOp(room, conn, msg);
    else if (t === "sel") this.broadcast(room, { t: "sel", sid: conn.sid, name: conn.name, color: conn.color, sheet: msg.sheet, r: msg.r, c: msg.c, r2: msg.r2, c2: msg.c2 }, conn);
    else if (t === "title" && typeof msg.title === "string" && typeof msg.ts === "number") {
      if (msg.ts < room.titleTs) return;
      room.title = msg.title.slice(0, 200);
      room.titleTs = msg.ts;
      this.store.setTitle(room.id, room.title, msg.ts);
      this.broadcast(room, { t: "title", title: room.title, ts: msg.ts }, null);
    } else if (t === "thread") {
      const thread = sanitizeThread(msg.thread);
      if (!thread) return;
      thread.sid = conn.sid;
      thread.name = conn.name;
      thread.color = conn.color;
      room.threads.set(thread.id, thread);
      this.store.saveThread(room.id, thread);
      this.broadcast(room, { t: "thread", thread }, null);
    } else if (t === "history") send(conn.ws, { t: "history", versions: this.store.versions(room.id) });
    else if (t === "namever" && typeof msg.label === "string") {
      this.store.noteVersion(room.id, room.server.rev, conn.sid, conn.name, room.server.book, msg.label);
      send(conn.ws, { t: "named", rev: room.server.rev });
    } else if (t === "preview") {
      const rev = Number(msg.rev);
      const book = this.store.versionBook(room.id, rev);
      if (book) send(conn.ws, { t: "preview", rev, book });
    } else if (t === "restore") {
      const rev = Number(msg.rev);
      const book = this.store.versionBook(room.id, rev);
      if (!book) return;
      room.server.book = book;
      room.server.rev++;
      room.server.log.push({ delta: { ops: [] }, sid: conn.sid, reqId: -1 });
      this.store.save(room.id, book, room.server.rev);
      this.broadcast(room, { t: "reset", rev: room.server.rev, book }, null);
    }
  }

  onOp(room: Room, conn: BookConn, msg: Record<string, unknown>): void {
    const reqId = msg.reqId;
    const rev = msg.rev;
    const delta = msg.delta as GridDelta;
    if (typeof reqId !== "number" || typeof rev !== "number" || !delta || !Array.isArray(delta.ops)) return;
    const result = room.server.submit(conn.sid, reqId, rev, delta);
    if (result.error) {
      send(conn.ws, { t: "reject", error: result.error });
      return;
    }
    send(conn.ws, { t: "ack", reqId, assignedRev: result.assignedRev, serverRev: result.serverRev, delta: result.delta });
    if (result.delta && result.assignedRev != null) {
      this.store.save(room.id, room.server.book, room.server.rev);
      if (room.server.rev % 16 === 0) this.store.noteVersion(room.id, room.server.rev, conn.sid, conn.name, room.server.book);
      this.broadcast(room, { t: "op", sid: conn.sid, rev: result.assignedRev, delta: result.delta }, conn);
    }
  }

  disconnect(room: Room, conn: BookConn): void {
    room.conns.delete(conn);
    this.broadcast(room, { t: "bye", sid: conn.sid }, null);
  }

  broadcast(room: Room, msg: unknown, except: BookConn | null): void {
    for (const conn of room.conns) if (conn !== except) send(conn.ws, msg);
  }
}
