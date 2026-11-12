import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize } from "./canonical.ts";

export { bytesToHex, hexToBytes };

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

/** Hash of the canonical form of a JSON value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export interface KeyPair {
  secretKeyHex: string;
  publicKeyHex: string;
}

export function generateKeyPair(): KeyPair {
  const sk = ed25519.utils.randomSecretKey();
  return { secretKeyHex: bytesToHex(sk), publicKeyHex: bytesToHex(ed25519.getPublicKey(sk)) };
}

export function publicKeyFromSecret(secretKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));
}

/**
 * Domain-separated signing: the signed message is `leash:<purpose>:v1\n<canonical json>`, so a signature over a
 * mandate can never be replayed as an approval or a revocation.
 */
export type SignPurpose = "mandate" | "approval" | "revocation" | "ledger-checkpoint";

function message(purpose: SignPurpose, value: unknown): Uint8Array {
  return utf8ToBytes(`leash:${purpose}:v1\n${canonicalize(value)}`);
}

export function signJson(purpose: SignPurpose, value: unknown, secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(message(purpose, value), hexToBytes(secretKeyHex)));
}

export function verifyJson(purpose: SignPurpose, value: unknown, signatureHex: string, publicKeyHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
    return ed25519.verify(hexToBytes(signatureHex), message(purpose, value), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
