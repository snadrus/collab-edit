import { decryptBytes, encryptBytes } from "./crypto.ts";
import { childPath, decodeManifest, emptyManifest, encodeManifest, ensureDir, findEntry, parsePath, placeNode, removeAt, toStat } from "./manifest.ts";
import {
  FIL_FOLDERS_APP,
  FIL_FOLDERS_VOLUME,
  idOf,
  isCasConflict,
  normalizeAddress,
  type Entry,
  type FolderRegistry,
  type Head,
  type HistoryItem,
  type Manifest,
  type PieceStore,
  type Stat,
} from "./types.ts";
import type { Hex } from "viem";

export interface FoldersConfig {
  storage: PieceStore;
  registry: FolderRegistry;
  owner: string;
  /** Volume name hashed into the registry key. Defaults to `root`. */
  volume?: string;
  encryptionKey?: CryptoKey;
}

const RETRIES = 6;

/** A content-addressed folder tree. The root manifest piece is the registry head. */
export class Folders {
  readonly app = FIL_FOLDERS_APP;
  readonly volume: Hex;
  private storage: PieceStore;
  private registry: FolderRegistry;
  private owner: Hex;
  private encryptionKey: CryptoKey | null;

  constructor(config: FoldersConfig) {
    this.storage = config.storage;
    this.registry = config.registry;
    this.owner = normalizeAddress(config.owner);
    this.volume = config.volume ? idOf(config.volume) : FIL_FOLDERS_VOLUME;
    this.encryptionKey = config.encryptionKey ?? null;
  }

  async mkdir(path: string): Promise<Stat> {
    const parts = parsePath(path);
    if (!parts.length) throw new Error("bad path");
    await this.change((manifest) => {
      if (findEntry(manifest, parts)?.type === "dir") return manifest;
      return { version: 1, entries: ensureDir(manifest.entries, parts, Date.now()) };
    });
    return this.stat(path);
  }

  async put(path: string, bytes: Uint8Array, opts?: { mime?: string; mtime?: number }): Promise<Stat> {
    const parts = parsePath(path);
    if (!parts.length) throw new Error("bad path");
    const sealed = this.encryptionKey ? await encryptBytes(this.encryptionKey, bytes) : { bytes, encryption: undefined };
    const pieceCid = await this.storage.put(sealed.bytes);
    const file: Entry = {
      name: parts[parts.length - 1],
      type: "file",
      pieceCid,
      size: bytes.length,
      mime: opts?.mime || "application/octet-stream",
      mtime: opts?.mtime ?? Date.now(),
      encryption: sealed.encryption,
    };
    await this.change((manifest) => ({ version: 1, entries: placeNode(manifest.entries, parts.slice(0, -1), file) }));
    return toStat(path.startsWith("/") ? path : "/" + path, file);
  }

  async get(path: string): Promise<Uint8Array> {
    const stat = await this.stat(path);
    if (stat.type !== "file") throw new Error("not a file");
    const raw = await this.storage.get(stat.pieceCid);
    if (!stat.encryption) return raw;
    if (!this.encryptionKey) throw new Error("encrypted");
    return decryptBytes(this.encryptionKey, raw, stat.encryption);
  }

  async ls(path = "/"): Promise<Stat[]> {
    const manifest = await this.load();
    const parts = path === "/" ? [] : parsePath(path);
    const node = parts.length ? findEntry(manifest, parts) : null;
    if (parts.length && (!node || node.type !== "dir")) throw new Error("not a directory");
    const children = parts.length ? node?.children ?? [] : manifest.entries;
    const base = parts.length ? "/" + parts.join("/") : "/";
    return children.map((entry) => toStat(childPath(base, entry.name), entry));
  }

  async mv(from: string, to: string): Promise<Stat> {
    const src = parsePath(from);
    const dst = parsePath(to);
    if (!src.length || !dst.length) throw new Error("bad path");
    if (dst.length > src.length && src.every((part, index) => part === dst[index])) throw new Error("bad path");
    await this.change((manifest) => {
      const entry = findEntry(manifest, src);
      if (!entry) throw new Error("missing path");
      const moved: Entry = { ...structuredClone(entry), name: dst[dst.length - 1], mtime: Date.now() };
      const removed = removeAt(manifest.entries, src, Date.now());
      return { version: 1, entries: placeNode(removed, dst.slice(0, -1), moved) };
    });
    return this.stat(to);
  }

  async rm(path: string): Promise<void> {
    const parts = parsePath(path);
    if (!parts.length) throw new Error("bad path");
    await this.change((manifest) => ({ version: 1, entries: removeAt(manifest.entries, parts, Date.now()) }));
  }

  async stat(path: string): Promise<Stat> {
    const parts = parsePath(path);
    if (!parts.length) throw new Error("bad path");
    const entry = findEntry(await this.load(), parts);
    if (!entry) throw new Error("missing path");
    return toStat(path.startsWith("/") ? path : "/" + path, entry);
  }

  /** Registry commits in which `path` existed, oldest first. `/` lists every root. */
  async history(path: string): Promise<HistoryItem[]> {
    const events = await this.registry.history(this.owner, this.app, this.volume);
    const parts = path === "/" ? [] : parsePath(path);
    const out: HistoryItem[] = [];
    for (const event of events) {
      if (!event.pieceCid) continue;
      const manifest = decodeManifest(await this.storage.get(event.pieceCid));
      const entry = parts.length ? findEntry(manifest, parts) : null;
      if (parts.length && !entry) continue;
      out.push({
        version: event.version,
        timestamp: event.timestamp,
        rootCid: event.pieceCid,
        path: parts.length ? "/" + parts.join("/") : "/",
        pieceCid: entry?.pieceCid || event.pieceCid,
        type: entry?.type || "dir",
        size: entry?.size ?? 0,
        mime: entry?.mime || "inode/directory",
      });
    }
    return out;
  }

  private async load(): Promise<Manifest> {
    const head = await this.registry.head(this.owner, this.app, this.volume);
    if (!head.pieceCid) return emptyManifest();
    return decodeManifest(await this.storage.get(head.pieceCid));
  }

  /** Apply `edit` to the latest manifest and CAS-commit, replaying the edit after a conflict. */
  private async change(edit: (manifest: Manifest) => Manifest): Promise<Head> {
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const current = await this.registry.head(this.owner, this.app, this.volume);
      const manifest = current.pieceCid ? decodeManifest(await this.storage.get(current.pieceCid)) : emptyManifest();
      const before = encodeManifest(manifest);
      const next = edit(structuredClone(manifest));
      const after = encodeManifest(next);
      if (sameBytes(before, after)) return current;
      const pieceCid = await this.storage.put(after);
      try {
        const event = await this.registry.commit({
          owner: this.owner,
          app: this.app,
          key: this.volume,
          pieceCid,
          prevPieceCid: current.pieceCid,
        });
        return { pieceCid: event.pieceCid, version: event.version };
      } catch (err) {
        last = err;
        if (!isCasConflict(err)) throw err;
      }
    }
    throw last instanceof Error ? last : new Error("cas conflict");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
