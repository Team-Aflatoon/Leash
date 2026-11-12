import { ledgerHash, signJson, verifyChain, verifyJson, type ChainCheck, type StoredLedgerEntry } from "@leash/core";
import type { Db, Tx } from "./db.ts";

/**
 * Append one entry inside the caller's transaction. Locking the head row serialises appends, so two concurrent
 * transactions can't both extend the same head (no forks), and an entry only exists if its transaction commits.
 */
export async function appendLedger(tx: Tx, type: string, data: unknown, now: Date): Promise<{ seq: number; hash: string }> {
  const head = (await tx.query<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head WHERE id = 1 FOR UPDATE")).rows[0]!;
  const entry = { seq: head.seq + 1, ts: now.toISOString(), type, data: JSON.parse(JSON.stringify(data)) };
  const hash = ledgerHash(head.hash, entry);
  await tx.query("INSERT INTO ledger(seq, ts, type, data, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6)", [entry.seq, entry.ts, type, JSON.stringify(entry.data), head.hash, hash]);
  await tx.query("UPDATE ledger_head SET seq = $1, hash = $2 WHERE id = 1", [entry.seq, hash]);
  return { seq: entry.seq, hash };
}

export async function readLedger(db: Db | Tx, fromSeq = 1, limit = 100_000): Promise<StoredLedgerEntry[]> {
  const r = await db.query<StoredLedgerEntry>("SELECT seq, ts, type, data, prev_hash, hash FROM ledger WHERE seq >= $1 ORDER BY seq LIMIT $2", [fromSeq, limit]);
  return r.rows;
}

export interface LedgerVerification {
  chain: ChainCheck;
  /** Signed checkpoints that no longer match the chain (evidence of a rewrite). */
  checkpointFailures: { seq: number; reason: string }[];
  checkpointsChecked: number;
}

/** Recompute the hash chain and check every signed checkpoint against it. */
export async function verifyLedger(db: Db, gatewayPublicKeyHex: string): Promise<LedgerVerification> {
  const entries = await readLedger(db);
  const chain = verifyChain(entries);
  const bySeq = new Map(entries.map((e) => [e.seq, e.hash]));
  const cps = (await db.query<{ seq: number; hash: string; signed_at: string; signature: string }>("SELECT seq, hash, signed_at, signature FROM ledger_checkpoints ORDER BY seq")).rows;
  const checkpointFailures: { seq: number; reason: string }[] = [];
  for (const cp of cps) {
    if (!verifyJson("ledger-checkpoint", { seq: cp.seq, hash: cp.hash, signed_at: cp.signed_at }, cp.signature, gatewayPublicKeyHex))
      checkpointFailures.push({ seq: cp.seq, reason: "checkpoint signature invalid" });
    else if (bySeq.get(cp.seq) !== cp.hash) checkpointFailures.push({ seq: cp.seq, reason: "ledger no longer matches signed checkpoint" });
  }
  return { chain, checkpointFailures, checkpointsChecked: cps.length };
}

/** Sign the current head. Exported checkpoints let anyone detect a later rewrite, even by a database superuser. */
export async function checkpoint(db: Db, gatewaySecretKeyHex: string, now: Date) {
  const head = (await db.query<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head WHERE id = 1")).rows[0]!;
  if (head.seq === 0) return null;
  const signed_at = now.toISOString();
  const statement = { seq: head.seq, hash: head.hash, signed_at };
  const signature = signJson("ledger-checkpoint", statement, gatewaySecretKeyHex);
  await db.query("INSERT INTO ledger_checkpoints(seq, hash, signed_at, signature) VALUES ($1,$2,$3,$4) ON CONFLICT (seq) DO NOTHING", [head.seq, head.hash, signed_at, signature]);
  return { ...statement, signature };
}
