import type { Hex } from "viem";
import {
  CasConflict,
  NotAllowed,
  normalizeAddress,
  type CommitArgs,
  type CommitEvent,
  type FolderRegistry,
  type Head,
  type PieceStore,
} from "./types.ts";

interface Slot {
  pieceCid: string;
  version: bigint;
  events: CommitEvent[];
}

export interface RegistryBackend {
  slots: Map<string, Slot>;
  writers: Map<string, boolean>;
}

export function memoryBackend(): RegistryBackend {
  return { slots: new Map(), writers: new Map() };
}

export function memoryStore(): PieceStore {
  const pieces = new Map<string, Uint8Array>();
  let n = 0;
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const id = "bafytest" + (++n).toString(16);
      pieces.set(id, bytes.slice());
      return id;
    },
    async get(pieceCid: string): Promise<Uint8Array> {
      const hit = pieces.get(pieceCid);
      if (!hit) throw new Error("missing piece " + pieceCid);
      return hit.slice();
    },
  };
}

/** In-memory FilRegistry. `signer` is the account that commits and approves writers. */
export function memoryRegistry(backend: RegistryBackend, signer: string): FolderRegistry {
  const account = normalizeAddress(signer);
  return {
    async head(owner: string, app: Hex, key: Hex): Promise<Head> {
      const slot = load(backend, owner, app, key);
      return { pieceCid: slot.pieceCid, version: slot.version };
    },
    async commit(args: CommitArgs): Promise<CommitEvent> {
      const owner = normalizeAddress(args.owner);
      if (owner !== account && backend.writers.get(writerKey(owner, args.app, account)) !== true) throw new NotAllowed();
      const slot = load(backend, owner, args.app, args.key);
      if (slot.pieceCid !== args.prevPieceCid) throw new CasConflict(slot.pieceCid, args.prevPieceCid);
      slot.version += 1n;
      slot.pieceCid = args.pieceCid;
      const event: CommitEvent = {
        owner,
        app: args.app,
        key: args.key,
        pieceCid: args.pieceCid,
        prevPieceCid: args.prevPieceCid,
        version: slot.version,
        timestamp: BigInt(Date.now()),
      };
      slot.events.push(event);
      return event;
    },
    async history(owner: string, app: Hex, key: Hex): Promise<CommitEvent[]> {
      return load(backend, owner, app, key).events.map((event) => ({ ...event }));
    },
    async setWriter(app: Hex, writer: string, allowed: boolean): Promise<void> {
      backend.writers.set(writerKey(account, app, normalizeAddress(writer)), allowed);
    },
  };
}

function load(backend: RegistryBackend, owner: string, app: Hex, key: Hex): Slot {
  const id = slotKey(normalizeAddress(owner), app, key);
  let slot = backend.slots.get(id);
  if (!slot) {
    slot = { pieceCid: "", version: 0n, events: [] };
    backend.slots.set(id, slot);
  }
  return slot;
}

function slotKey(owner: string, app: Hex, key: Hex): string {
  return owner.toLowerCase() + "|" + app + "|" + key;
}

function writerKey(owner: string, app: Hex, writer: string): string {
  return owner.toLowerCase() + "|" + app + "|" + writer.toLowerCase();
}
