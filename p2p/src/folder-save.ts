import { Folders, type FolderRegistry, type PieceStore } from "../../packages/fil-folders/src/index.ts";

/** Document path inside the fil-folders volume. */
export function snapshotPath(kind: "felarumi" | "felanumio", title: string): string {
  const clean = title.replace(/[\\/\u0000]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
  return kind === "felarumi" ? `/Felarumi/${clean}.felarumi` : `/Felanumio/${clean}.felanumio`;
}

/** Write a snapshot into the folder tree and CAS-commit the new root. */
export async function saveSnapshot(opts: {
  kind: "felarumi" | "felanumio";
  title: string;
  bytes: Uint8Array;
  owner: string;
  storage: PieceStore;
  registry: FolderRegistry;
  encryptionKey?: CryptoKey;
}): Promise<{ path: string; pieceCid: string; rootCid: string }> {
  const folders = new Folders({
    storage: opts.storage,
    registry: opts.registry,
    owner: opts.owner,
    encryptionKey: opts.encryptionKey,
  });
  const path = snapshotPath(opts.kind, opts.title);
  const mime = opts.kind === "felarumi" ? "application/vnd.felarumi+json" : "application/vnd.felanumio+json";
  const stat = await folders.put(path, opts.bytes, { mime });
  const head = await opts.registry.head(opts.owner, folders.app, folders.volume);
  return { path, pieceCid: stat.pieceCid, rootCid: head.pieceCid };
}
