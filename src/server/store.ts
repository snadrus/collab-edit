import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Delta } from "../shared/delta.ts";
import { type Doc, type Snapshot, emptyDoc, snapshotDoc } from "../shared/doc.ts";

export interface OpRow {
  rev: number;
  sid: string;
  reqId: number;
  delta: Delta;
}

export interface LoadedDoc {
  id: string;
  title: string;
  titleTs: number;
  snapRev: number;
  snap: Snapshot;
  ops: OpRow[];
  acks: { sid: string; reqId: number; assigned: number | null }[];
}

export class Store {
  db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "folio.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_ts INTEGER NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snaps (
        doc_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (doc_id, rev)
      );
      CREATE TABLE IF NOT EXISTS oplog (
        doc_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        sid TEXT NOT NULL,
        req_id INTEGER NOT NULL,
        delta TEXT NOT NULL,
        PRIMARY KEY (doc_id, rev)
      );
      CREATE TABLE IF NOT EXISTS reqs (
        doc_id TEXT NOT NULL,
        sid TEXT NOT NULL,
        req_id INTEGER NOT NULL,
        assigned INTEGER,
        PRIMARY KEY (doc_id, sid, req_id)
      );
    `);
  }

  list(): { id: string; title: string; updated: number }[] {
    return this.db
      .prepare("SELECT id, title, updated FROM docs ORDER BY updated DESC LIMIT 100")
      .all() as { id: string; title: string; updated: number }[];
  }

  exists(id: string): boolean {
    const row = this.db.prepare("SELECT id FROM docs WHERE id = ?").get(id);
    return !!row;
  }

  create(id: string, title: string): void {
    const now = Date.now();
    const snap = snapshotDoc(emptyDoc());
    this.db.prepare("INSERT INTO docs (id, title, title_ts, created, updated) VALUES (?, ?, ?, ?, ?)").run(id, title, now, now, now);
    this.db.prepare("INSERT INTO snaps (doc_id, rev, data) VALUES (?, 0, ?)").run(id, JSON.stringify(snap));
  }

  load(id: string): LoadedDoc | null {
    const doc = this.db.prepare("SELECT id, title, title_ts FROM docs WHERE id = ?").get(id) as
      | { id: string; title: string; title_ts: number }
      | undefined;
    if (!doc) return null;
    const snapRow = this.db
      .prepare("SELECT rev, data FROM snaps WHERE doc_id = ? ORDER BY rev DESC LIMIT 1")
      .get(id) as { rev: number; data: string } | undefined;
    const snapRev = snapRow?.rev ?? 0;
    const snap = snapRow ? (JSON.parse(snapRow.data) as Snapshot) : snapshotDoc(emptyDoc());
    const ops = (
      this.db.prepare("SELECT rev, sid, req_id, delta FROM oplog WHERE doc_id = ? ORDER BY rev").all(id) as {
        rev: number;
        sid: string;
        req_id: number;
        delta: string;
      }[]
    ).map((row) => ({ rev: row.rev, sid: row.sid, reqId: row.req_id, delta: JSON.parse(row.delta) as Delta }));
    const acks = (
      this.db.prepare("SELECT sid, req_id, assigned FROM reqs WHERE doc_id = ?").all(id) as {
        sid: string;
        req_id: number;
        assigned: number | null;
      }[]
    ).map((row) => ({ sid: row.sid, reqId: row.req_id, assigned: row.assigned }));
    return { id, title: doc.title, titleTs: doc.title_ts, snapRev, snap, ops, acks };
  }

  appendOp(id: string, rev: number, sid: string, reqId: number, delta: Delta | null, assigned: number | null, doc: Doc | null): void {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO reqs (doc_id, sid, req_id, assigned) VALUES (?, ?, ?, ?)").run(id, sid, reqId, assigned);
      if (delta && assigned != null) {
        this.db
          .prepare("INSERT INTO oplog (doc_id, rev, sid, req_id, delta) VALUES (?, ?, ?, ?, ?)")
          .run(id, rev, sid, reqId, JSON.stringify(delta));
      }
      if (doc && assigned != null && assigned % 32 === 0) {
        this.db.prepare("INSERT OR REPLACE INTO snaps (doc_id, rev, data) VALUES (?, ?, ?)").run(id, assigned, JSON.stringify(snapshotDoc(doc)));
      }
      this.db.prepare("UPDATE docs SET updated = ? WHERE id = ?").run(now, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  setTitle(id: string, title: string, ts: number): void {
    this.db.prepare("UPDATE docs SET title = ?, title_ts = ?, updated = ? WHERE id = ? AND title_ts <= ?").run(title, ts, Date.now(), id, ts);
  }
}
