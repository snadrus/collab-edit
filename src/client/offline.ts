import type { Delta } from "../shared/delta.ts";
import type { Snapshot } from "../shared/doc.ts";

export interface QueueRec {
  docId: string;
  baseRev: number;
  baseSnap: Snapshot;
  inflight: { reqId: number; delta: Delta } | null;
  pending: Delta | null;
  transformed: boolean;
}

const DB = "felarumi";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "docId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadQueue(docId: string): Promise<QueueRec | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(docId);
      req.onsuccess = () => resolve((req.result as QueueRec | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveQueue(docId: string, rec: QueueRec | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = rec ? store.put({ ...rec, docId }) : store.delete(docId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* private mode */
  }
}
