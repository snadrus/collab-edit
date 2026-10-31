const DB = "felarumi-p2p";
const STORE = "records";

export interface SavedRecord {
  key: string;
  kind: "doc" | "book" | "blob";
  id: string;
  title: string;
  updated: number;
  rev: number;
  data: unknown;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRecord(record: SavedRecord): Promise<void> {
  const db = await openDb();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(record));
}

export async function loadRecord(key: string): Promise<SavedRecord | null> {
  const db = await openDb();
  const row = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
  return (row as SavedRecord | undefined) ?? null;
}

export async function listRecords(kind: "doc" | "book"): Promise<SavedRecord[]> {
  const db = await openDb();
  const rows = (await done(db.transaction(STORE, "readonly").objectStore(STORE).getAll())) as SavedRecord[];
  return rows.filter((row) => row.kind === kind).sort((a, b) => b.updated - a.updated);
}

export async function putBlob(cid: string, bytes: Uint8Array): Promise<void> {
  await saveRecord({ key: "blob:" + cid, kind: "blob", id: cid, title: "", updated: Date.now(), rev: 0, data: bytes });
}

export async function getBlob(cid: string): Promise<Uint8Array | null> {
  const row = await loadRecord("blob:" + cid);
  return row?.data instanceof Uint8Array ? row.data : null;
}
