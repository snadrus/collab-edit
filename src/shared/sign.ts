import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { getAddress, hashTypedData, keccak256, type Hex } from "viem";
import { EMBED, type Attrs, type Delta } from "./delta.ts";
import { type CharStyle, type Doc, docIsSigned, restoreDoc, snapshotDoc } from "./doc.ts";

export const CHAIN_MAINNET = 314;
export const CHAIN_CALIBRATION = 314159;
export const DOMAIN_NAME = "Felarumi";
export const DOMAIN_VERSION = "1";
/** v2 adds a plain-language `purpose` that wallets show first. v1 signatures still verify. */
export const DOMAIN_VERSION_2 = "2";
export const DEFAULT_PURPOSE = "I sign this document.";

const DOCUMENT_FIELDS = [
  { name: "docId", type: "string" },
  { name: "contentHash", type: "string" },
  { name: "contentCid", type: "string" },
  { name: "signerName", type: "string" },
  { name: "signer", type: "address" },
  { name: "timestamp", type: "uint256" },
  { name: "chainId", type: "uint256" },
] as const;

const DOCUMENT_FIELDS_V2 = [{ name: "purpose", type: "string" }, ...DOCUMENT_FIELDS] as const;

export interface SignFields {
  /** Present (even empty-checked) means a v2 signature. */
  purpose?: string;
  docId: string;
  contentHash: string;
  contentCid: string;
  signerName: string;
  signer: string;
  timestamp: bigint;
  chainId: number;
}

export interface AnchorState {
  contentCid: string;
  locked: boolean;
}

export interface StoredSignature extends SignFields {
  signature: string;
}

export function chainIdFor(network: string): number {
  return network === "calibration" ? CHAIN_CALIBRATION : CHAIN_MAINNET;
}

export function chainLabel(chainId: number): string {
  if (chainId === CHAIN_MAINNET) return "Filecoin mainnet (314)";
  if (chainId === CHAIN_CALIBRATION) return "Filecoin Calibration (314159)";
  return String(chainId);
}

export function normalizeAddress(value: string): string {
  return getAddress(value);
}

function sortStyle(style: CharStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(style).sort()) {
    const value = (style as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function unsignedDoc(doc: Doc): Doc {
  const text: string[] = [];
  const styles: CharStyle[] = [];
  for (let i = 0; i < doc.text.length; i++) {
    if (doc.text[i] === EMBED && doc.styles[i]?.embed === "sig") continue;
    text.push(doc.text[i]);
    styles.push(doc.styles[i] || {});
  }
  return { text: text.join(""), styles };
}

/** Deterministic JSON of the snapshot with every signature embed removed. */
export function canonicalUnsigned(doc: Doc): string {
  const snap = snapshotDoc(unsignedDoc(doc));
  return JSON.stringify({
    text: snap.text,
    runs: snap.runs.map((run) => ({ n: run.n, s: sortStyle(run.s) })),
  });
}

export function unsignedBytes(doc: Doc): Uint8Array {
  return new TextEncoder().encode(canonicalUnsigned(doc));
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** sha256 of the canonical snapshot with every signature embed removed. */
export function contentHashOf(doc: Doc): string {
  return hashBytes(unsignedBytes(doc));
}

export function docFromCanonical(raw: string): Doc | null {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; runs?: { n: number; s: CharStyle }[] };
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.runs)) return null;
    return restoreDoc({ text: parsed.text, runs: parsed.runs });
  } catch {
    return null;
  }
}

function isV2(fields: SignFields): boolean {
  return typeof fields.purpose === "string";
}

type TypedData = Parameters<typeof hashTypedData>[0] & { domain: { name: string; version: string; chainId: number } };

export function typedDataFor(fields: SignFields): TypedData {
  const v2 = isV2(fields);
  return {
    domain: { name: DOMAIN_NAME, version: v2 ? DOMAIN_VERSION_2 : DOMAIN_VERSION, chainId: fields.chainId },
    types: { Document: v2 ? DOCUMENT_FIELDS_V2 : DOCUMENT_FIELDS },
    primaryType: "Document" as const,
    message: {
      ...(v2 ? { purpose: fields.purpose as string } : {}),
      docId: fields.docId,
      contentHash: fields.contentHash,
      contentCid: fields.contentCid,
      signerName: fields.signerName,
      signer: fields.signer as Hex,
      timestamp: fields.timestamp,
      chainId: BigInt(fields.chainId),
    },
  } as unknown as TypedData;
}

/** JSON accepted by eth_signTypedData_v4. */
export function typedDataJson(fields: SignFields): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Document: isV2(fields) ? DOCUMENT_FIELDS_V2 : DOCUMENT_FIELDS,
    },
    primaryType: "Document",
    domain: { name: DOMAIN_NAME, version: isV2(fields) ? DOMAIN_VERSION_2 : DOMAIN_VERSION, chainId: fields.chainId },
    message: {
      ...(isV2(fields) ? { purpose: fields.purpose } : {}),
      docId: fields.docId,
      contentHash: fields.contentHash,
      contentCid: fields.contentCid,
      signerName: fields.signerName,
      signer: fields.signer,
      timestamp: fields.timestamp.toString(),
      chainId: String(fields.chainId),
    },
  });
}

export function signatureAttrs(fields: StoredSignature): Attrs {
  return {
    embed: "sig",
    label: fields.signerName,
    alt: fields.signer,
    iso: fields.timestamp.toString(),
    val: fields.contentHash,
    src: fields.signature,
    opts: String(fields.chainId),
    cid: fields.contentCid,
    ...(isV2(fields) ? { pur: fields.purpose } : {}),
  };
}

function allowedChain(chainId: number): boolean {
  return chainId === CHAIN_MAINNET || chainId === CHAIN_CALIBRATION;
}

export function readStored(style: CharStyle | undefined, docId: string): StoredSignature | null {
  if (!style || style.embed !== "sig") return null;
  const signerName = style.label || "";
  const signer = style.alt || "";
  const iso = style.iso || "";
  const contentHash = style.val || "";
  const signature = style.src || "";
  const contentCid = style.cid || "";
  const chainId = Number(style.opts);
  if (!signerName || signerName.length > 80 || /[\n\uFFFC]/.test(signerName)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) return null;
  if (!/^\d+$/.test(iso)) return null;
  if (!/^[0-9a-f]{64}$/i.test(contentHash)) return null;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  if (!contentCid || contentCid.length > 200 || /\s/.test(contentCid)) return null;
  if (!allowedChain(chainId) || String(chainId) !== style.opts) return null;
  if (!docId) return null;
  const purpose = typeof style.pur === "string" ? style.pur : undefined;
  if (purpose !== undefined && (purpose.length > 200 || /[\n\uFFFC]/.test(purpose))) return null;
  return {
    ...(purpose !== undefined ? { purpose } : {}),
    docId,
    contentHash,
    contentCid,
    signerName,
    signer,
    timestamp: BigInt(iso),
    chainId,
    signature,
  };
}

function recoverSigner(fields: SignFields, signature: string): string {
  const hash = hashTypedData(typedDataFor(fields));
  const hex = signature.toLowerCase();
  const yParityOrV = Number.parseInt(hex.slice(130), 16);
  const recoveryBit = yParityOrV >= 27 ? yParityOrV - 27 : yParityOrV;
  if (recoveryBit !== 0 && recoveryBit !== 1) throw new Error("bad recovery bit");
  const sig = secp256k1.Signature.fromCompact(hex.slice(2, 130)).addRecoveryBit(recoveryBit);
  const publicKey = sig.recoverPublicKey(hash.slice(2)).toHex(false);
  const body = publicKey.startsWith("04") ? publicKey.slice(2) : publicKey;
  const digest = keccak256(`0x${body}`);
  return getAddress(`0x${digest.slice(-40)}`);
}

/** Null when the stored signature recovers to its address over this doc id, hash, and content CID. */
export function verifyStored(style: CharStyle | undefined, docId: string, expectedHash: string, expectedCid: string): string | null {
  const stored = readStored(style, docId);
  if (!stored) return "bad signature";
  if (!expectedCid) return "missing content cid";
  if (stored.contentCid !== expectedCid) return "content cid mismatch";
  if (stored.contentHash.toLowerCase() !== expectedHash.toLowerCase()) return "content changed";
  let recovered = "";
  try {
    recovered = recoverSigner(stored, stored.signature);
  } catch {
    return "bad signature";
  }
  if (recovered.toLowerCase() !== stored.signer.toLowerCase()) return "signer mismatch";
  return null;
}

function styleFromAttrs(attrs: Attrs | undefined): CharStyle {
  const style: CharStyle = {};
  if (!attrs) return style;
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (typeof value === "string" || typeof value === "number" || value === true) {
      (style as Record<string, unknown>)[key] = value;
    }
  }
  return style;
}

function classify(delta: Delta): { kind: "edit" } | { kind: "bad" } | { kind: "sigs"; sigs: CharStyle[] } {
  const sigs: CharStyle[] = [];
  let other = false;
  let tainted = false;
  for (const op of delta.ops) {
    if (op.t === "d") {
      other = true;
      continue;
    }
    if (op.t === "r") {
      if (op.a && Object.keys(op.a).length) other = true;
      continue;
    }
    const pure = op.s.length > 0 && [...op.s].every((ch) => ch === EMBED);
    if (op.a?.embed === "sig" && pure) {
      for (let i = 0; i < op.s.length; i++) sigs.push(styleFromAttrs(op.a));
    } else {
      other = true;
      if (op.a?.embed === "sig") tainted = true;
    }
  }
  if (tainted || (sigs.length > 0 && other)) return { kind: "bad" };
  if (sigs.length > 0) return { kind: "sigs", sigs };
  return { kind: "edit" };
}

/** Freeze, record the unsigned PieceCID, or drop the freeze when the upload fails before a CID exists. */
export function applyAnchor(state: AnchorState, doc: Doc, phase: string, contentCid = ""): { state: AnchorState; error?: string } {
  const signed = docIsSigned(doc);
  if (phase === "abort") {
    if (signed || state.contentCid) return { state: { contentCid: state.contentCid, locked: true } };
    return { state: { contentCid: "", locked: false } };
  }
  if (phase === "cid") {
    if (!contentCid || contentCid.length > 200 || /\s/.test(contentCid)) return { state, error: "bad content cid" };
    if (state.contentCid && state.contentCid !== contentCid) return { state, error: "content cid mismatch" };
    return { state: { contentCid, locked: true } };
  }
  return { state: { contentCid: state.contentCid, locked: true } };
}

/** Reject every op except a verified signature insert once the document is frozen. */
export function signatureGate(docId: string, read: () => AnchorState): (doc: Doc, delta: Delta) => string | null {
  return (doc, delta) => {
    const state = read();
    const frozen = docIsSigned(doc) || state.locked || !!state.contentCid;
    const verdict = classify(delta);
    if (verdict.kind === "edit") return frozen ? "locked" : null;
    if (verdict.kind === "bad") return frozen ? "locked" : "bad signature";
    if (!state.contentCid) return "missing content cid";
    const hash = contentHashOf(doc);
    for (const style of verdict.sigs) {
      const err = verifyStored(style, docId, hash, state.contentCid);
      if (err) return err;
    }
    return null;
  };
}
