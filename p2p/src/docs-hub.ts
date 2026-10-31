import { assignColor } from "../../packages/core/src/palette.ts";
import { commandsToDelta, deltaToCommands, type Command } from "../../src/shared/commands.ts";
import { type Snapshot, emptyDoc, restoreDoc, snapshotDoc } from "../../src/shared/doc.ts";
import { ServerDoc } from "../../src/shared/engine.ts";
import { DEFAULT_PAGE, type PageSpec } from "../../src/shared/page.ts";

export interface HubSocket {
  send(data: string): void;
}

export interface DocConn {
  socket: HubSocket;
  sid: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export interface DocRecord {
  title: string;
  rev: number;
  snapshot: Snapshot;
  page: PageSpec;
}

export class DocSession {
  id: string;
  server: ServerDoc;
  title: string;
  page: PageSpec;
  conns: DocConn[] = [];
  save: ((record: DocRecord) => void) | null = null;

  constructor(id: string, record?: DocRecord | null) {
    this.id = id;
    this.title = record?.title || "Untitled document";
    this.page = record?.page || { ...DEFAULT_PAGE };
    this.server = new ServerDoc(record ? restoreDoc(record.snapshot) : emptyDoc());
    if (record) this.server.rev = record.rev;
  }

  static create(id: string, record?: DocRecord | null, save?: (record: DocRecord) => void): DocSession {
    const session = new DocSession(id, record);
    session.save = save || null;
    return session;
  }

  connect(socket: HubSocket, hello: Record<string, unknown>): DocConn {
    const sid = typeof hello.sid === "string" && hello.sid.length < 80 ? hello.sid : "guest";
    const name = typeof hello.name === "string" && hello.name.trim() ? hello.name.trim().slice(0, 40) : "Guest";
    const conn: DocConn = {
      socket,
      sid,
      name,
      color: assignColor(this.conns.map((item) => item.color), sid),
      anchor: 0,
      head: 0,
    };
    this.conns.push(conn);
    this.pushInit(conn);
    this.broadcast({ t: "join", sid, name, color: conn.color }, conn);
    return conn;
  }

  disconnect(conn: DocConn): void {
    this.conns = this.conns.filter((item) => item !== conn);
    this.broadcast({ t: "bye", sid: conn.sid }, null);
  }

  handle(conn: DocConn, msg: Record<string, unknown>): void {
    const t = msg.t;
    if (t === "op") this.onOp(conn, msg);
    else if (t === "sel" && typeof msg.anchor === "number" && typeof msg.head === "number") {
      conn.anchor = msg.anchor;
      conn.head = msg.head;
      this.broadcast(
        { t: "sel", sid: conn.sid, name: conn.name, color: conn.color, anchor: conn.anchor, head: conn.head, rev: this.server.rev },
        conn,
      );
    } else if (t === "title" && typeof msg.title === "string") {
      this.title = msg.title.slice(0, 200);
      this.broadcast({ t: "title", title: this.title }, null);
      this.persist();
    }
  }

  replace(snapshot: Snapshot, title?: string): void {
    if (title) this.title = title.slice(0, 200);
    this.server = new ServerDoc(restoreDoc(snapshot));
    this.persist();
    for (const conn of this.conns) this.pushInit(conn);
  }

  exportJson(): string {
    return JSON.stringify({ kind: "felarumi-p2p", title: this.title, snapshot: snapshotDoc(this.server.doc) });
  }

  pushInit(conn: DocConn): void {
    this.send(conn, {
      t: "init",
      rev: this.server.rev,
      snapshot: snapshotDoc(this.server.doc),
      title: this.title,
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: this.conns.map((item) => ({ sid: item.sid, name: item.name, color: item.color, anchor: item.anchor, head: item.head })),
      threads: [],
      suggestions: [],
      page: this.page,
      role: "edit",
      trashed: false,
      resume: false,
      catchup: [],
    });
  }

  onOp(conn: DocConn, msg: Record<string, unknown>): void {
    const sid = typeof msg.sid === "string" ? msg.sid : conn.sid;
    const reqId = msg.reqId;
    const rev = msg.rev;
    if (typeof reqId !== "number" || typeof rev !== "number" || !Array.isArray(msg.commands)) {
      this.send(conn, { t: "reject", reqId: reqId ?? null, error: "bad op" });
      return;
    }
    let delta;
    try {
      delta = commandsToDelta(msg.commands as Command[]);
    } catch (err) {
      this.send(conn, { t: "reject", reqId, error: err instanceof Error ? err.message : "bad commands" });
      return;
    }
    const res = this.server.submit(sid, reqId, rev, delta);
    if (res.error) {
      this.send(conn, { t: "reject", reqId, error: res.error, serverRev: res.serverRev });
      this.pushInit(conn);
      return;
    }
    if (res.duplicate || res.assignedRev == null) {
      this.send(conn, { t: "ack", reqId, assignedRev: res.assignedRev, serverRev: res.serverRev });
      return;
    }
    const commands = deltaToCommands(res.delta!);
    this.broadcast({ t: "op", rev: res.assignedRev, sid, reqId, commands }, null);
    this.persist();
  }

  persist(): void {
    this.save?.({ title: this.title, rev: this.server.rev, snapshot: snapshotDoc(this.server.doc), page: this.page });
  }

  send(conn: DocConn, msg: unknown): void {
    conn.socket.send(JSON.stringify(msg));
  }

  broadcast(msg: unknown, except: DocConn | null): void {
    const data = JSON.stringify(msg);
    for (const conn of this.conns) if (conn !== except) conn.socket.send(data);
  }
}
