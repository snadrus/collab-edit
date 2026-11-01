import { hexToBytes, type Hex } from "viem";
import { KEY_MESSAGE, type EncryptionMeta } from "./types.ts";

export async function encryptionKeyFromSignature(signature: Hex): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", hexToBytes(signature));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Ask the wallet to sign the fixed key message, then derive an AES-GCM key. */
export async function encryptionKeyFromWallet(signMessage: (message: string) => Promise<Hex>): Promise<CryptoKey> {
  return encryptionKeyFromSignature(await signMessage(KEY_MESSAGE));
}

export async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<{ bytes: Uint8Array; encryption: EncryptionMeta }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  return { bytes: cipher, encryption: { alg: "AES-GCM", iv: bytesToBase64(iv) } };
}

export async function decryptBytes(key: CryptoKey, bytes: Uint8Array, meta: EncryptionMeta): Promise<Uint8Array> {
  if (meta.alg !== "AES-GCM") throw new Error("unsupported encryption");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(meta.iv) }, key, bytes);
  return new Uint8Array(plain);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
