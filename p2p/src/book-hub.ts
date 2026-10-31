import { assignColor } from "../../packages/core/src/palette.ts";
import { type Book, type GridDelta, ServerBook, emptyBook } from "../../apps/felanumio/src/ot.ts";

export interface HubSocket {
  send(data: string): void;
}

interface BookConn {
  socket: HubSocket;
  sid: string;
  name: string;
  color: string;
}

export interface BookRecord {
  title: string;
  rev: number;
  book: Book;
}

export class BookSession {
  id: string;
  server: ServerBook;
  title: string;
  conns: BookConn[] = [];
  save: ((record: BookRecord) => void) | null = null;

  constructor(id: string, record?: BookRecord | null) {
    this.id = id;
    this.title = record?.title || "Untitled spreadsheet";
    this.server = new ServerBook(record?.book || emptyBook());
    if (record) {
      this.server.rev = record.rev;
      this.server.logBase = record.rev;
    }
  }

  static create(id: string, record?: BookRecord | null, save?: (record: BookRecord) => void): BookSession {
    const session = new BookSession(id, record);
    session.save = save || null;
    return session;
  }

  connect(socket: HubSocket, hello: Record<string, unknown>): BookConn {
    const sid = typeof hello.sid === "string" && hello.sid.length < 80 ? hello.sid : "guest";
    const name = typeof hello.name === "string" && hello.name.trim() ? hello.name.trim().slice(0, 40) : "Guest";
    const conn: BookConn = { socket, sid, name, color: assignColor(this.conns.map((item) => item.color), sid) };
    this.conns.push(conn);
    this.pushInit(conn);
    this.broadcast({ t: "join", sid, name, color: conn.color }, conn);
    return conn;
  }

  disconnect(conn: BookConn): void {
    this.conns = this.conns.filter((item) => item !== conn);
    this.broadcast({ t: "bye", sid: conn.sid }, null);
  }

  handle(conn: BookConn, msg: Record<string, unknown>): void {
    if (msg.t !== "op") {
      if (msg.t === "sel") this.broadcast({ t: "sel", sid: conn.sid, name: conn.name, color: conn.color, sheet: msg.sheet, r: msg.r, c: msg.c, r2: msg.r2, c2: msg.c2 }, conn);
      else if (msg.t === "title" && typeof msg.title === "string") {
        this.title = msg.title.slice(0, 200);
        this.broadcast({ t: "title", title: this.title }, null);
        this.persist();
      }
      return;
    }
    const reqId = msg.reqId;
    const rev = msg.rev;
    const delta = msg.delta as GridDelta;
    if (typeof reqId !== "number" || typeof rev !== "number" || !delta || !Array.isArray(delta.ops)) return;
    const result = this.server.submit(conn.sid, reqId, rev, delta);
    if (result.error) {
      this.send(conn, { t: "reject", error: result.error });
      return;
    }
    this.send(conn, { t: "ack", reqId, assignedRev: result.assignedRev, serverRev: result.serverRev, delta: result.delta });
    if (result.delta && result.assignedRev != null) {
      this.broadcast({ t: "op", sid: conn.sid, rev: result.assignedRev, delta: result.delta }, conn);
      this.persist();
    }
  }

  replace(book: Book, title?: string): void {
    if (title) this.title = title.slice(0, 200);
    this.server = new ServerBook(book);
    this.persist();
    for (const conn of this.conns) this.pushInit(conn);
  }

  exportJson(): string {
    return JSON.stringify({ kind: "felanumio-p2p", title: this.title, book: this.server.book });
  }

  pushInit(conn: BookConn): void {
    this.send(conn, {
      t: "init",
      rev: this.server.rev,
      book: this.server.book,
      title: this.title,
      role: "edit",
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: this.conns.filter((item) => item !== conn).map((item) => ({ sid: item.sid, name: item.name, color: item.color })),
      threads: [],
    });
  }

  persist(): void {
    this.save?.({ title: this.title, rev: this.server.rev, book: this.server.book });
  }

  send(conn: BookConn, msg: unknown): void {
    conn.socket.send(JSON.stringify(msg));
  }

  broadcast(msg: unknown, except: BookConn | null): void {
    const data = JSON.stringify(msg);
    for (const conn of this.conns) if (conn !== except) conn.socket.send(data);
  }
}
