import { assignColor } from "../../packages/core/src/palette.ts";
import { commandsToDelta, deltaToCommands, type Command } from "../../src/shared/commands.ts";
import { type Snapshot, docIsSigned, emptyDoc, restoreDoc, snapshotDoc } from "../../src/shared/doc.ts";
import { ServerDoc } from "../../src/shared/engine.ts";
import { applyAnchor, signatureGate } from "../../src/shared/sign.ts";
import { DEFAULT_PAGE, type PageSpec } from "../../src/shared/page.ts";
import { type Reply, type Thread, sanitizeThread, validId } from "../../src/shared/threads.ts";

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
  /** The host's own tab. Only the owner resolves comments. */
  owner?: boolean;
}

export interface DocRecord {
  title: string;
  rev: number;
  snapshot: Snapshot;
  page: PageSpec;
  contentCid?: string;
  threads?: Thread[];
}

export class DocSession {
  id: string;
  server: ServerDoc;
  title: string;
  page: PageSpec;
  contentCid = "";
  locked = false;
  conns: DocConn[] = [];
  threads = new Map<string, Thread>();
  save: ((record: DocRecord) => void) | null = null;

  constructor(id: string, record?: DocRecord | null) {
    this.id = id;
    this.title = record?.title || "Untitled document";
    this.page = record?.page || { ...DEFAULT_PAGE };
    this.contentCid = record?.contentCid || "";
    this.server = new ServerDoc(record ? restoreDoc(record.snapshot) : emptyDoc());
    this.server.gate = signatureGate(this.id, () => ({ contentCid: this.contentCid, locked: this.locked }));
    if (record) this.server.rev = record.rev;
    for (const thread of record?.threads || []) {
      const clean = sanitizeThread(thread);
      if (clean) this.threads.set(clean.id, clean);
    }
    this.locked = !!this.contentCid || docIsSigned(this.server.doc);
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
    } else if (t === "anchor") this.onAnchor(conn, msg);
    else if (t === "thread") this.onThread(conn, msg);
    else if (t === "reply") this.onReply(conn, msg);
    else if (t === "resolve") this.onResolve(conn, msg);
  }

  onThread(conn: DocConn, msg: Record<string, unknown>): void {
    const id = validId(msg.id);
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
    if (!id || !text) return;
    const existing = this.threads.get(id);
    if (existing) {
      this.broadcast({ t: "thread", thread: existing }, null);
      return;
    }
    const clean = sanitizeThread({
      id,
      sid: conn.sid,
      name: conn.name,
      color: conn.color,
      text,
      ts: Date.now(),
      quote: typeof msg.quote === "string" ? msg.quote.replace(/\s+/g, " ").trim().slice(0, 240) : "",
      resolved: false,
      replies: [],
    });
    if (!clean) return;
    this.threads.set(id, clean);
    this.publishThread(clean);
  }

  onReply(conn: DocConn, msg: Record<string, unknown>): void {
    const id = validId(msg.id);
    const replyId = validId(msg.replyId);
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
    const thread = id ? this.threads.get(id) : undefined;
    if (!thread || !replyId || !text) return;
    if (!thread.replies.some((r) => r.id === replyId)) {
      const reply: Reply = { id: replyId, sid: conn.sid, name: conn.name, text, ts: Date.now() };
      thread.replies.push(reply);
    }
    this.publishThread(thread);
  }

  /** Resolved threads stay in the document data; clients hide them. */
  onResolve(conn: DocConn, msg: Record<string, unknown>): void {
    if (!conn.owner) return;
    const id = validId(msg.id);
    const thread = id ? this.threads.get(id) : undefined;
    if (!thread || typeof msg.resolved !== "boolean") return;
    thread.resolved = msg.resolved;
    this.publishThread(thread);
  }

  publishThread(thread: Thread): void {
    this.broadcast({ t: "thread", thread }, null);
    this.persist();
  }

  onAnchor(conn: DocConn, msg: Record<string, unknown>): void {
    const phase = typeof msg.phase === "string" ? msg.phase : "freeze";
    const next = applyAnchor(this, this.server.doc, phase, typeof msg.contentCid === "string" ? msg.contentCid : "");
    if (next.error) {
      this.send(conn, { t: "reject", reqId: null, error: next.error });
      return;
    }
    this.contentCid = next.state.contentCid;
    this.locked = next.state.locked;
    this.broadcast({ t: "anchor", locked: this.locked, contentCid: this.contentCid }, null);
    this.persist();
  }

  replace(snapshot: Snapshot, title?: string, contentCid?: string): void {
    if (title) this.title = title.slice(0, 200);
    this.contentCid = contentCid || "";
    this.server = new ServerDoc(restoreDoc(snapshot));
    this.server.gate = signatureGate(this.id, () => ({ contentCid: this.contentCid, locked: this.locked }));
    this.locked = !!this.contentCid || docIsSigned(this.server.doc);
    this.persist();
    for (const conn of this.conns) this.pushInit(conn);
  }

  exportJson(): string {
    return JSON.stringify({
      kind: "felarumi-p2p",
      title: this.title,
      contentCid: this.contentCid,
      snapshot: snapshotDoc(this.server.doc),
    });
  }

  pushInit(conn: DocConn): void {
    this.send(conn, {
      t: "init",
      rev: this.server.rev,
      snapshot: snapshotDoc(this.server.doc),
      title: this.title,
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: this.conns.map((item) => ({ sid: item.sid, name: item.name, color: item.color, anchor: item.anchor, head: item.head })),
      threads: [...this.threads.values()],
      suggestions: [],
      page: this.page,
      contentCid: this.contentCid,
      locked: this.locked,
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
    this.save?.({
      title: this.title,
      rev: this.server.rev,
      snapshot: snapshotDoc(this.server.doc),
      page: this.page,
      contentCid: this.contentCid,
      threads: [...this.threads.values()],
    });
  }

  send(conn: DocConn, msg: unknown): void {
    conn.socket.send(JSON.stringify(msg));
  }

  broadcast(msg: unknown, except: DocConn | null): void {
    const data = JSON.stringify(msg);
    for (const conn of this.conns) if (conn !== except) conn.socket.send(data);
  }
}
