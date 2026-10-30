import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Delta } from "../shared/delta.ts";
import { type Doc, type Snapshot, emptyDoc, snapshotDoc } from "../shared/doc.ts";
import { type PageSpec, normalizePage } from "../shared/page.ts";
import { type Thread, sanitizeThread } from "../shared/threads.ts";

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
    this.db = new DatabaseSync(path.join(dir, "felarumi.sqlite"));
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
      CREATE TABLE IF NOT EXISTS threads (
        doc_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (doc_id, id)
      );
      CREATE TABLE IF NOT EXISTS versions (
        doc_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        sid TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (doc_id, rev)
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(docs)").all() as { name: string }[];
    if (!cols.some((col) => col.name === "page")) this.db.exec("ALTER TABLE docs ADD COLUMN page TEXT NOT NULL DEFAULT ''");
    if (!cols.some((col) => col.name === "page_ts")) this.db.exec("ALTER TABLE docs ADD COLUMN page_ts INTEGER NOT NULL DEFAULT 0");
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

  loadThreads(id: string): Thread[] {
    const rows = this.db.prepare("SELECT data FROM threads WHERE doc_id = ?").all(id) as { data: string }[];
    const out: Thread[] = [];
    for (const row of rows) {
      const thread = sanitizeThread(JSON.parse(row.data) as unknown);
      if (thread) out.push(thread);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  replaceSnapshot(id: string, doc: Doc): void {
    this.db.prepare("INSERT OR REPLACE INTO snaps (doc_id, rev, data) VALUES (?, 0, ?)").run(id, JSON.stringify(snapshotDoc(doc)));
  }

  snapAt(id: string, rev: number): { rev: number; snap: Snapshot } {
    const row = this.db
      .prepare("SELECT rev, data FROM snaps WHERE doc_id = ? AND rev <= ? ORDER BY rev DESC LIMIT 1")
      .get(id, rev) as { rev: number; data: string } | undefined;
    if (!row) return { rev: 0, snap: snapshotDoc(emptyDoc()) };
    return { rev: row.rev, snap: JSON.parse(row.data) as Snapshot };
  }

  noteVersion(docId: string, rev: number, ts: number, sid: string, name: string, color: string): void {
    const last = this.db
      .prepare("SELECT rev, ts, sid, label FROM versions WHERE doc_id = ? ORDER BY rev DESC LIMIT 1")
      .get(docId) as { rev: number; ts: number; sid: string; label: string } | undefined;
    const windowMs = 5 * 60 * 1000;
    if (last && !last.label && last.sid === sid && ts - last.ts < windowMs && rev > last.rev) {
      this.db.prepare("DELETE FROM versions WHERE doc_id = ? AND rev = ?").run(docId, last.rev);
      this.db
        .prepare("INSERT INTO versions (doc_id, rev, ts, sid, name, color, label) VALUES (?, ?, ?, ?, ?, ?, '')")
        .run(docId, rev, last.ts, sid, name, color);
      return;
    }
    if (last && last.rev === rev) return;
    this.db
      .prepare("INSERT OR REPLACE INTO versions (doc_id, rev, ts, sid, name, color, label) VALUES (?, ?, ?, ?, ?, ?, '')")
      .run(docId, rev, ts, sid, name, color);
  }

  nameVersion(docId: string, rev: number, ts: number, sid: string, name: string, color: string, label: string): void {
    const clean = label.trim().slice(0, 80);
    if (!clean) return;
    const row = this.db.prepare("SELECT rev FROM versions WHERE doc_id = ? AND rev = ?").get(docId, rev) as { rev: number } | undefined;
    if (row) this.db.prepare("UPDATE versions SET label = ? WHERE doc_id = ? AND rev = ?").run(clean, docId, rev);
    else {
      this.db
        .prepare("INSERT INTO versions (doc_id, rev, ts, sid, name, color, label) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(docId, rev, ts, sid, name, color, clean);
    }
  }

  versions(docId: string): { rev: number; ts: number; sid: string; name: string; color: string; label: string }[] {
    return this.db
      .prepare("SELECT rev, ts, sid, name, color, label FROM versions WHERE doc_id = ? ORDER BY rev DESC")
      .all(docId) as { rev: number; ts: number; sid: string; name: string; color: string; label: string }[];
  }

  loadPage(id: string): { page: PageSpec; ts: number } {
    const row = this.db.prepare("SELECT page, page_ts FROM docs WHERE id = ?").get(id) as { page: string; page_ts: number } | undefined;
    if (!row || !row.page) return { page: normalizePage({}), ts: row?.page_ts || 0 };
    try {
      return { page: normalizePage(JSON.parse(row.page)), ts: row.page_ts || 0 };
    } catch {
      return { page: normalizePage({}), ts: 0 };
    }
  }

  setPage(id: string, page: PageSpec, ts: number): boolean {
    const current = this.db.prepare("SELECT page_ts FROM docs WHERE id = ?").get(id) as { page_ts: number } | undefined;
    if (!current || ts < current.page_ts) return false;
    this.db.prepare("UPDATE docs SET page = ?, page_ts = ?, updated = ? WHERE id = ?").run(JSON.stringify(page), ts, Date.now(), id);
    return true;
  }

  saveThread(docId: string, thread: Thread): void {
    this.db
      .prepare("INSERT INTO threads (doc_id, id, data) VALUES (?, ?, ?) ON CONFLICT(doc_id, id) DO UPDATE SET data = excluded.data")
      .run(docId, thread.id, JSON.stringify(thread));
  }
}
