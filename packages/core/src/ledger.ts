import { canonicalize } from "./canonical.ts";
import { sha256Hex } from "./crypto.ts";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEntryInput {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

/** hash_n = sha256(hash_{n-1} || "\n" || JCS({seq, ts, type, data})). Changing any field of any entry breaks every later hash. */
export function ledgerHash(prevHash: string, entry: LedgerEntryInput): string {
  return sha256Hex(`${prevHash}\n${canonicalize({ seq: entry.seq, ts: entry.ts, type: entry.type, data: entry.data })}`);
}

export interface StoredLedgerEntry extends LedgerEntryInput {
  prev_hash: string;
  hash: string;
}

export type ChainCheck = { ok: true; head: string; count: number } | { ok: false; brokenAtSeq: number; problem: string };

/** Recompute the chain from genesis. Detects edited, deleted, inserted or reordered entries. */
export function verifyChain(entries: readonly StoredLedgerEntry[]): ChainCheck {
  let prev = GENESIS_HASH;
  let expectedSeq = entries.length ? entries[0]!.seq : 1;
  if (entries.length && expectedSeq !== 1) return { ok: false, brokenAtSeq: expectedSeq, problem: "chain does not start at seq 1" };
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAtSeq: e.seq, problem: `expected seq ${expectedSeq}` };
    if (e.prev_hash !== prev) return { ok: false, brokenAtSeq: e.seq, problem: "prev_hash does not match previous entry" };
    const h = ledgerHash(prev, e);
    if (h !== e.hash) return { ok: false, brokenAtSeq: e.seq, problem: "entry content does not match its hash" };
    prev = h;
    expectedSeq++;
  }
  return { ok: true, head: prev, count: entries.length };
}
