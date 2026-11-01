import { getAddress, keccak256, toBytes, type Hex } from "viem";

/** Registry application id for this library. `keccak256("fil-folders")`. */
export const FIL_FOLDERS_APP = keccak256(toBytes("fil-folders"));

/** Default volume key. `keccak256("root")`. */
export const FIL_FOLDERS_VOLUME = keccak256(toBytes("root"));

export const KEY_MESSAGE = "fil-folders encryption key v1";

export const FILECOIN_CHAIN_ID = { mainnet: 314, calibration: 314159 } as const;

export function idOf(text: string): Hex {
  return keccak256(toBytes(text));
}

export function normalizeAddress(value: string): Hex {
  return getAddress(value);
}

/** Piece upload and download. Synapse is the default live adapter. */
export interface PieceStore {
  put(bytes: Uint8Array): Promise<string>;
  get(pieceCid: string): Promise<Uint8Array>;
}

export interface Head {
  pieceCid: string;
  version: bigint;
}

export interface CommitEvent {
  owner: string;
  app: Hex;
  key: Hex;
  pieceCid: string;
  prevPieceCid: string;
  version: bigint;
  timestamp: bigint;
}

export interface CommitArgs {
  owner: string;
  app: Hex;
  key: Hex;
  pieceCid: string;
  prevPieceCid: string;
}

/** Compare-and-swap registry. The in-memory mock and the viem contract client both implement this. */
export interface FolderRegistry {
  head(owner: string, app: Hex, key: Hex): Promise<Head>;
  commit(args: CommitArgs): Promise<CommitEvent>;
  history(owner: string, app: Hex, key: Hex): Promise<CommitEvent[]>;
  setWriter(app: Hex, writer: string, allowed: boolean): Promise<void>;
}

export interface EncryptionMeta {
  alg: "AES-GCM";
  iv: string;
}

export interface Entry {
  name: string;
  type: "file" | "dir";
  pieceCid: string;
  size: number;
  mime: string;
  mtime: number;
  encryption?: EncryptionMeta;
  children?: Entry[];
}

export interface Manifest {
  version: 1;
  entries: Entry[];
}

export interface Stat {
  path: string;
  name: string;
  type: "file" | "dir";
  pieceCid: string;
  size: number;
  mime: string;
  mtime: number;
  encryption?: EncryptionMeta;
}

export interface HistoryItem {
  version: bigint;
  timestamp: bigint;
  rootCid: string;
  path: string;
  pieceCid: string;
  type: "file" | "dir";
  size: number;
  mime: string;
}

export class CasConflict extends Error {
  current: string;
  expected: string;
  constructor(current: string, expected: string) {
    super("cas conflict");
    this.name = "CasConflict";
    this.current = current;
    this.expected = expected;
  }
}

export class NotAllowed extends Error {
  constructor() {
    super("not allowed");
    this.name = "NotAllowed";
  }
}

export function isCasConflict(err: unknown): boolean {
  if (err instanceof CasConflict) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("PrevMismatch") || message.includes("cas conflict");
}
