import { type Entry, type Manifest, type Stat } from "./types.ts";

export function emptyManifest(): Manifest {
  return { version: 1, entries: [] };
}

export function parsePath(path: string): string[] {
  if (path.includes("\\") || path.includes("\0")) throw new Error("bad path");
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("bad path");
  return parts;
}

export function encodeManifest(manifest: Manifest): Uint8Array {
  const body = { version: 1 as const, entries: sortEntries(manifest.entries).map(entryJson) };
  return new TextEncoder().encode(JSON.stringify(body));
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; entries?: Entry[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("bad manifest");
  return { version: 1, entries: parsed.entries };
}

export function findEntry(manifest: Manifest, parts: string[]): Entry | null {
  let entries = manifest.entries;
  let found: Entry | null = null;
  for (const part of parts) {
    found = entries.find((entry) => entry.name === part) ?? null;
    if (!found) return null;
    entries = found.children ?? [];
  }
  return found;
}

export function placeNode(entries: Entry[], dirs: string[], node: Entry): Entry[] {
  if (!dirs.length) return upsert(entries, node);
  const head = dirs[0];
  const rest = dirs.slice(1);
  const existing = entries.find((entry) => entry.name === head);
  if (existing && existing.type !== "dir") throw new Error("not a directory");
  const children = placeNode(existing?.children ?? [], rest, node);
  return upsert(entries, directory(head, children, existing?.mtime));
}

export function ensureDir(entries: Entry[], parts: string[], mtime: number): Entry[] {
  if (!parts.length) return entries;
  const head = parts[0];
  const rest = parts.slice(1);
  const existing = entries.find((entry) => entry.name === head);
  if (existing && existing.type !== "dir") throw new Error("not a directory");
  const children = ensureDir(existing?.children ?? [], rest, mtime);
  return upsert(entries, directory(head, children, mtime));
}

export function removeAt(entries: Entry[], parts: string[], mtime: number): Entry[] {
  if (!parts.length) throw new Error("bad path");
  if (parts.length === 1) {
    if (!entries.some((entry) => entry.name === parts[0])) throw new Error("missing path");
    return entries.filter((entry) => entry.name !== parts[0]);
  }
  const head = parts[0];
  const existing = entries.find((entry) => entry.name === head);
  if (!existing || existing.type !== "dir") throw new Error("missing path");
  const children = removeAt(existing.children ?? [], parts.slice(1), mtime);
  return upsert(entries, directory(head, children, mtime));
}

export function toStat(path: string, entry: Entry): Stat {
  return {
    path,
    name: entry.name,
    type: entry.type,
    pieceCid: entry.pieceCid,
    size: entry.size,
    mime: entry.mime,
    mtime: entry.mtime,
    encryption: entry.encryption,
  };
}

export function childPath(parent: string, name: string): string {
  if (parent === "/" || parent === "") return "/" + name;
  return parent.replace(/\/+$/, "") + "/" + name;
}

function directory(name: string, children: Entry[], mtime = Date.now()): Entry {
  return { name, type: "dir", pieceCid: "", size: 0, mime: "inode/directory", mtime, children };
}

function upsert(entries: Entry[], entry: Entry): Entry[] {
  return [...entries.filter((item) => item.name !== entry.name), entry];
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function entryJson(entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: entry.name,
    type: entry.type,
    pieceCid: entry.pieceCid,
    size: entry.size,
    mime: entry.mime,
    mtime: entry.mtime,
  };
  if (entry.encryption) out.encryption = { alg: entry.encryption.alg, iv: entry.encryption.iv };
  if (entry.type === "dir") out.children = sortEntries(entry.children ?? []).map(entryJson);
  return out;
}
