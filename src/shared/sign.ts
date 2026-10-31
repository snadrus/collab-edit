import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { getAddress, hashTypedData, keccak256, type Hex } from "viem";
import { EMBED, type Attrs, type Delta } from "./delta.ts";
import { type CharStyle, type Doc, docIsSigned, snapshotDoc } from "./doc.ts";

export const CHAIN_MAINNET = 314;
export const CHAIN_CALIBRATION = 314159;
export const DOMAIN_NAME = "Felarumi";
export const DOMAIN_VERSION = "1";

const DOCUMENT_FIELDS = [
  { name: "docId", type: "string" },
  { name: "contentHash", type: "string" },
  { name: "signerName", type: "string" },
  { name: "signer", type: "address" },
  { name: "timestamp", type: "uint256" },
  { name: "chainId", type: "uint256" },
] as const;

export interface SignFields {
  docId: string;
  contentHash: string;
  signerName: string;
  signer: string;
  timestamp: bigint;
  chainId: number;
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

/** sha256 of the canonical snapshot with every signature embed removed. */
export function contentHashOf(doc: Doc): string {
  const text: string[] = [];
  const styles: CharStyle[] = [];
  for (let i = 0; i < doc.text.length; i++) {
    if (doc.text[i] === EMBED && doc.styles[i]?.embed === "sig") continue;
    text.push(doc.text[i]);
    styles.push(doc.styles[i] || {});
  }
  const snap = snapshotDoc({ text: text.join(""), styles });
  const body = JSON.stringify({
    text: snap.text,
    runs: snap.runs.map((run) => ({ n: run.n, s: sortStyle(run.s) })),
  });
  return bytesToHex(sha256(new TextEncoder().encode(body)));
}

export function typedDataFor(fields: SignFields) {
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: fields.chainId },
    types: { Document: DOCUMENT_FIELDS },
    primaryType: "Document" as const,
    message: {
      docId: fields.docId,
      contentHash: fields.contentHash,
      signerName: fields.signerName,
      signer: fields.signer as Hex,
      timestamp: fields.timestamp,
      chainId: BigInt(fields.chainId),
    },
  };
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
      Document: DOCUMENT_FIELDS,
    },
    primaryType: "Document",
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: fields.chainId },
    message: {
      docId: fields.docId,
      contentHash: fields.contentHash,
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
  const chainId = Number(style.opts);
  if (!signerName || signerName.length > 80 || /[\n\uFFFC]/.test(signerName)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) return null;
  if (!/^\d+$/.test(iso)) return null;
  if (!/^[0-9a-f]{64}$/i.test(contentHash)) return null;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  if (!allowedChain(chainId) || String(chainId) !== style.opts) return null;
  if (!docId) return null;
  return {
    docId,
    contentHash,
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

/** Null when the stored signature recovers to its address over this doc id and hash. */
export function verifyStored(style: CharStyle | undefined, docId: string, expectedHash: string): string | null {
  const stored = readStored(style, docId);
  if (!stored) return "bad signature";
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

/** Reject every op except a verified signature insert once the document is signed. */
export function signatureGate(docId: string): (doc: Doc, delta: Delta) => string | null {
  return (doc, delta) => {
    const frozen = docIsSigned(doc);
    const verdict = classify(delta);
    if (verdict.kind === "edit") return frozen ? "locked" : null;
    if (verdict.kind === "bad") return frozen ? "locked" : "bad signature";
    const hash = contentHashOf(doc);
    for (const style of verdict.sigs) {
      const err = verifyStored(style, docId, hash);
      if (err) return err;
    }
    return null;
  };
}
