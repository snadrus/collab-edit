import type { WebSocket } from "ws";
import { deltaToCommands, commandsToDelta, type Command } from "../shared/commands.ts";
import { applyDoc, snapshotDoc, restoreDoc, type Snapshot } from "../shared/doc.ts";
import { ServerDoc } from "../shared/engine.ts";
import { Store, type LoadedDoc } from "./store.ts";

const PALETTE = ["#1a73e8", "#188038", "#d93025", "#e37400", "#9334e6", "#007b83", "#c5221f", "#1967d2"];

export function colorFor(sid: string): string {
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (h * 33 + sid.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

interface Conn {
  ws: WebSocket;
  sid: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

interface Room {
  id: string;
  title: string;
  titleTs: number;
  server: ServerDoc;
  conns: Set<Conn>;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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
    return { id: loaded.id, title: loaded.title, titleTs: loaded.titleTs, server, conns: new Set() };
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

  connect(room: Room, ws: WebSocket, sid: string, name: string): Conn {
    const conn: Conn = { ws, sid, name: name.slice(0, 40) || "Guest", color: colorFor(sid), anchor: 0, head: 0 };
    room.conns.add(conn);
    this.pushInit(room, conn);
    this.broadcast(room, { t: "join", sid: conn.sid, name: conn.name, color: conn.color }, conn);
    return conn;
  }

  pushInit(room: Room, conn: Conn): void {
    send(conn.ws, {
      t: "init",
      rev: room.server.rev,
      snapshot: this.snapshot(room),
      title: room.title,
      self: { sid: conn.sid, name: conn.name, color: conn.color },
      presence: this.presence(room),
    });
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
    if (t === "op") this.onOp(room, conn, msg);
    else if (t === "sel") this.onSel(room, conn, msg);
    else if (t === "title") this.onTitle(room, conn, msg);
    else if (t === "name") this.onName(room, conn, msg);
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
}
