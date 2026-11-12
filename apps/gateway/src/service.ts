import { randomUUID } from "node:crypto";
import {
  ApprovalStatement,
  MandateBody,
  Proposal,
  RevocationStatement,
  canonicalHash,
  combine,
  evaluateRules,
  periodStart,
  sha256Hex,
  verifyJson,
  type CatalogItem,
  type IntentVerdict,
  type MandateState,
  type Outcome,
  type Reason,
  type ResolvedLine,
} from "@leash/core";
import { withTx, type Db, type Tx } from "./db.ts";
import type { IntentChecker } from "./intent.ts";
import { appendLedger } from "./ledger.ts";
import { ProviderRejectedError, ProviderUncertainError, type PaymentProvider } from "./provider.ts";

export interface Deps {
  db: Db;
  provider: PaymentProvider;
  intent: IntentChecker;
  now: () => Date;
  config: { approvalTimeoutSeconds: number; publicUrl: string; demoMode: boolean };
  /** Nudge the job worker after a commit that enqueued work. */
  wake: () => void;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

const DUPLICATE_WINDOW_HOURS = 24;
const STATEMENT_MAX_AGE_MS = 5 * 60_000;

// ------------------------------------------------------------------------------------------------------------------
// Owners and mandates
// ------------------------------------------------------------------------------------------------------------------

export async function registerOwner(deps: Deps, input: { display_name: string; public_key_hex: string }) {
  if (!/^[0-9a-f]{64}$/.test(input.public_key_hex)) throw new HttpError(400, "public_key_hex must be 32 bytes hex");
  const name = String(input.display_name ?? "").trim().slice(0, 80) || "Owner";
  const owner_id = `own_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await withTx(deps.db, async (tx) => {
    await tx.query("INSERT INTO owners(owner_id, display_name, public_key_hex) VALUES ($1,$2,$3)", [owner_id, name, input.public_key_hex]);
    await appendLedger(tx, "owner.registered", { owner_id, public_key_hex: input.public_key_hex }, deps.now());
  });
  return { owner_id };
}

async function ownerKey(q: Db | Tx, ownerId: string): Promise<{ public_key_hex: string; paypal_vault_id: string | null } | null> {
  const r = await q.query("SELECT public_key_hex, paypal_vault_id FROM owners WHERE owner_id = $1", [ownerId]);
  return r.rows[0] ?? null;
}

export async function createMandate(deps: Deps, input: { body: unknown; signature: string }) {
  const parsed = MandateBody.safeParse(input.body);
  if (!parsed.success) throw new HttpError(400, "invalid mandate", parsed.error.issues);
  const body = parsed.data;
  const owner = await ownerKey(deps.db, body.owner_id);
  if (!owner) throw new HttpError(404, "unknown owner");
  // Verify against what the owner actually signed (input.body), which must equal the parsed body exactly.
  if (canonicalHash(input.body) !== canonicalHash(body)) throw new HttpError(400, "mandate contains non-canonical fields");
  if (!verifyJson("mandate", body, input.signature, owner.public_key_hex)) throw new HttpError(401, "mandate signature invalid");
  const body_hash = canonicalHash(body);
  await withTx(deps.db, async (tx) => {
    const ins = await tx.query(
      "INSERT INTO mandates(mandate_id, owner_id, agent_id, body, body_hash, signature) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (mandate_id) DO NOTHING",
      [body.mandate_id, body.owner_id, body.agent_id, JSON.stringify(body), body_hash, input.signature],
    );
    if (ins.rowCount === 0) throw new HttpError(409, "mandate id already used");
    await appendLedger(tx, "mandate.signed", { mandate_id: body.mandate_id, owner_id: body.owner_id, body_hash, signature: input.signature, body }, deps.now());
  });
  return { mandate_id: body.mandate_id, body_hash };
}

export async function revokeMandate(deps: Deps, input: { statement: unknown; signature: string }) {
  const st = RevocationStatement.safeParse(input.statement);
  if (!st.success) throw new HttpError(400, "invalid revocation", st.error.issues);
  const now = deps.now();
  if (Math.abs(now.getTime() - Date.parse(st.data.revoked_at)) > STATEMENT_MAX_AGE_MS) throw new HttpError(400, "revocation statement is stale");
  const res = await withTx(deps.db, async (tx) => {
    const m = (await tx.query("SELECT owner_id, revoked_at FROM mandates WHERE mandate_id = $1 FOR UPDATE", [st.data.mandate_id])).rows[0];
    if (!m) throw new HttpError(404, "unknown mandate");
    const owner = await ownerKey(tx, m.owner_id);
    if (!owner || !verifyJson("revocation", st.data, input.signature, owner.public_key_hex)) throw new HttpError(401, "revocation signature invalid");
    if (m.revoked_at) return { already: true, voids: 0 };
    await tx.query("UPDATE mandates SET revoked_at = $2, revocation_signature = $3, revocation_reason = 'owner' WHERE mandate_id = $1", [st.data.mandate_id, now, input.signature]);
    const voids = await enqueueVoidsForMandate(tx, st.data.mandate_id, "mandate revoked");
    await appendLedger(tx, "mandate.revoked", { mandate_id: st.data.mandate_id, statement: st.data, signature: input.signature, holds_voided: voids }, now);
    return { already: false, voids };
  });
  deps.wake();
  return res;
}

/** System-side retirement (demo reset). Stricter-only, so it needs no owner signature. */
export async function retireOwnerMandates(deps: Deps, ownerId: string, reason: string) {
  const now = deps.now();
  const out = await withTx(deps.db, async (tx) => {
    const ms = (await tx.query<{ mandate_id: string }>("SELECT mandate_id FROM mandates WHERE owner_id = $1 AND revoked_at IS NULL FOR UPDATE", [ownerId])).rows;
    let voids = 0;
    for (const m of ms) {
      await tx.query("UPDATE mandates SET revoked_at = $2, revocation_reason = $3 WHERE mandate_id = $1", [m.mandate_id, now, reason]);
      voids += await enqueueVoidsForMandate(tx, m.mandate_id, reason);
      await appendLedger(tx, "mandate.retired", { mandate_id: m.mandate_id, reason }, now);
    }
    return { retired: ms.length, voids };
  });
  deps.wake();
  return out;
}

async function enqueueVoidsForMandate(tx: Tx, mandateId: string, reason: string): Promise<number> {
  // RESERVED payments are handled by the authorize job, which re-checks the mandate after PayPal answers.
  const ps = (await tx.query<{ payment_id: string }>("SELECT payment_id FROM payments WHERE mandate_id = $1 AND state = 'AUTHORIZED'", [mandateId])).rows;
  for (const p of ps) await enqueue(tx, "payment.void", { payment_id: p.payment_id, reason });
  return ps.length;
}

// ------------------------------------------------------------------------------------------------------------------
// Proposals → decisions
// ------------------------------------------------------------------------------------------------------------------

export interface DecisionView {
  decision_id: string;
  kind: "primary" | "replay" | "conflict" | "malformed";
  replay_of: string | null;
  outcome: Outcome;
  reasons: Reason[];
  lines: ResolvedLine[];
  total_cents: number;
  intent_verdict: IntentVerdict;
  payment_id: string | null;
}

function requestHash(raw: unknown): string {
  try {
    return canonicalHash(raw);
  } catch {
    return sha256Hex(JSON.stringify(raw) ?? "null");
  }
}

async function loadCatalog(q: Db | Tx): Promise<Map<string, CatalogItem>> {
  const r = await q.query<CatalogItem>("SELECT sku, title, category, merchant_id, unit_price_cents, currency, active, description FROM catalog");
  return new Map(r.rows.map((c) => [c.sku, c]));
}

interface MandateRow {
  mandate_id: string;
  owner_id: string;
  body: MandateBody;
  body_hash: string;
  signature: string;
  revoked_at: Date | null;
}

async function mandateState(q: Db | Tx, row: MandateRow | undefined): Promise<MandateState | null> {
  if (!row) return null;
  const owner = await ownerKey(q, row.owner_id);
  // SAFETY (G4): re-verify the signature on every decision. If anyone edits the stored body, it stops verifying.
  const signatureValid = !!owner && canonicalHash(row.body) === row.body_hash && verifyJson("mandate", row.body, row.signature, owner.public_key_hex);
  return { body: row.body, signatureValid, revoked: row.revoked_at !== null, paymentConsent: !!owner?.paypal_vault_id };
}

async function existingPrimary(q: Db | Tx, agentId: string, key: string) {
  const r = await q.query("SELECT decision_id, request_hash FROM decisions WHERE agent_id = $1 AND idempotency_key = $2 AND kind = 'primary'", [agentId, key]);
  return (r.rows[0] as { decision_id: string; request_hash: string } | undefined) ?? null;
}

export async function getDecision(q: Db | Tx, decisionId: string): Promise<DecisionView> {
  const d = (await q.query("SELECT d.*, p.payment_id FROM decisions d LEFT JOIN payments p ON p.decision_id = d.decision_id WHERE d.decision_id = $1", [decisionId])).rows[0];
  if (!d) throw new HttpError(404, "unknown decision");
  return {
    decision_id: d.decision_id,
    kind: d.kind,
    replay_of: d.replay_of,
    outcome: d.outcome,
    reasons: d.reasons,
    lines: d.lines,
    total_cents: d.total_cents,
    intent_verdict: d.intent_verdict,
    payment_id: d.payment_id ?? null,
  };
}

async function recordReplayOrConflict(deps: Deps, agentId: string, raw: unknown, reqHash: string, prior: { decision_id: string; request_hash: string }, key: string, mandateId: string | null) {
  const now = deps.now();
  const decision_id = randomUUID();
  if (prior.request_hash === reqHash) {
    // SAFETY (G5): an exact replay returns the original decision and creates no payment.
    const original = await getDecision(deps.db, prior.decision_id);
    await withTx(deps.db, async (tx) => {
      await tx.query(
        `INSERT INTO decisions(decision_id, kind, replay_of, agent_id, idempotency_key, mandate_id, request_body, request_hash, outcome, reasons, lines, total_cents, cart_hash, intent_verdict)
         VALUES ($1,'replay',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12)`,
        [decision_id, prior.decision_id, agentId, key, mandateId, JSON.stringify(raw), reqHash, original.outcome, JSON.stringify(original.reasons), JSON.stringify(original.lines), original.total_cents, JSON.stringify({ kind: "skipped" })],
      );
      await appendLedger(tx, "proposal.replay", { decision_id, replay_of: prior.decision_id, agent_id: agentId, idempotency_key: key }, now);
    });
    return { ...original, decision_id, kind: "replay" as const, replay_of: prior.decision_id, payment_id: original.payment_id };
  }
  const reasons: Reason[] = [{ code: "IDEMPOTENCY_CONFLICT", outcome: "BLOCK", source: "rules", message: "This idempotency key was already used for a different request. Treating as tampering." }];
  await withTx(deps.db, async (tx) => {
    await tx.query(
      `INSERT INTO decisions(decision_id, kind, replay_of, agent_id, idempotency_key, mandate_id, request_body, request_hash, outcome, reasons, lines, total_cents, cart_hash, intent_verdict)
       VALUES ($1,'conflict',$2,$3,$4,$5,$6,$7,'BLOCK',$8,'[]',0,NULL,$9)`,
      [decision_id, prior.decision_id, agentId, key, mandateId, JSON.stringify(raw), reqHash, JSON.stringify(reasons), JSON.stringify({ kind: "skipped" })],
    );
    await appendLedger(tx, "decision", { decision_id, kind: "conflict", agent_id: agentId, outcome: "BLOCK", reasons: reasons.map((r) => r.code), request_hash: reqHash }, now);
  });
  return getDecision(deps.db, decision_id);
}

export async function submitProposal(deps: Deps, agentId: string, raw: unknown): Promise<DecisionView> {
  const reqHash = requestHash(raw);
  const parsed = Proposal.safeParse(raw);
  const now = deps.now();

  if (!parsed.success) {
    const decision_id = randomUUID();
    const reasons: Reason[] = [{ code: "MALFORMED_REQUEST", outcome: "BLOCK", source: "rules", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) }];
    await withTx(deps.db, async (tx) => {
      await tx.query(
        `INSERT INTO decisions(decision_id, kind, agent_id, request_body, request_hash, outcome, reasons, lines, total_cents, intent_verdict)
         VALUES ($1,'malformed',$2,$3,$4,'BLOCK',$5,'[]',0,$6)`,
        [decision_id, agentId, JSON.stringify(raw ?? null), reqHash, JSON.stringify(reasons), JSON.stringify({ kind: "skipped" })],
      );
      await appendLedger(tx, "decision", { decision_id, kind: "malformed", agent_id: agentId, outcome: "BLOCK", request_hash: reqHash }, now);
    });
    return getDecision(deps.db, decision_id);
  }
  const p = parsed.data;

  const prior = await existingPrimary(deps.db, agentId, p.idempotency_key);
  if (prior) return recordReplayOrConflict(deps, agentId, raw, reqHash, prior, p.idempotency_key, p.mandate_id);

  // Pre-check outside the lock so the (slow) LLM call never holds the mandate lock. The authoritative evaluation
  // happens again inside the transaction with fresh budget figures.
  const catalog = await loadCatalog(deps.db);
  const preRow = (await deps.db.query<MandateRow>("SELECT * FROM mandates WHERE mandate_id = $1", [p.mandate_id])).rows[0];
  const pre = evaluateRules({ now, agentId, mandate: await mandateState(deps.db, preRow), proposal: p, catalog, periodSpentCents: 0, duplicateOfRecent: false });
  let verdict: IntentVerdict = { kind: "skipped" };
  if (pre.outcome !== "BLOCK" && preRow) {
    verdict = await deps.intent.check({ intent: preRow.body.intent, lines: pre.lines, total_cents: pre.total_cents, merchant_id: pre.merchant_id, agent_note: p.note ?? null });
  }

  const decision_id = randomUUID();
  try {
    await withTx(deps.db, async (tx) => {
      // SAFETY (G5): the mandate row lock serialises every decision for this mandate, so budget arithmetic below
      // sees all earlier reservations and no two requests can both fit into the same remaining budget.
      const row = (await tx.query<MandateRow>("SELECT * FROM mandates WHERE mandate_id = $1 FOR UPDATE", [p.mandate_id])).rows[0];
      const state = await mandateState(tx, row);
      let spent = 0;
      let dup = false;
      if (row) {
        spent = Number(
          (await tx.query("SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE mandate_id = $1 AND state IN ('RESERVED','AUTHORIZED','CAPTURED') AND created_at >= $2", [row.mandate_id, periodStart(now)])).rows[0].s,
        );
      }
      const rules0 = evaluateRules({ now, agentId, mandate: state, proposal: p, catalog, periodSpentCents: spent, duplicateOfRecent: false });
      if (row && rules0.cart_hash) {
        dup = (
          await tx.query(
            "SELECT 1 FROM decisions WHERE mandate_id = $1 AND cart_hash = $2 AND kind = 'primary' AND outcome IN ('ALLOW','HOLD') AND created_at > $3::timestamptz - make_interval(hours => $4) LIMIT 1",
            [row.mandate_id, rules0.cart_hash, now, DUPLICATE_WINDOW_HOURS],
          )
        ).rowCount! > 0;
      }
      const rules = dup ? evaluateRules({ now, agentId, mandate: state, proposal: p, catalog, periodSpentCents: spent, duplicateOfRecent: true }) : rules0;
      const final = combine(rules, rules.outcome === "BLOCK" ? { kind: "skipped" } : verdict);
      const usedVerdict: IntentVerdict = rules.outcome === "BLOCK" ? { kind: "skipped" } : verdict;

      await tx.query(
        `INSERT INTO decisions(decision_id, kind, agent_id, idempotency_key, mandate_id, request_body, request_hash, outcome, reasons, lines, total_cents, cart_hash, intent_verdict, mandate_hash)
         VALUES ($1,'primary',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [decision_id, agentId, p.idempotency_key, row ? p.mandate_id : null, JSON.stringify(raw), reqHash, final.outcome, JSON.stringify(final.reasons), JSON.stringify(rules.lines), rules.total_cents, rules.cart_hash, JSON.stringify(usedVerdict), row?.body_hash ?? null],
      );
      let payment_id: string | null = null;
      if (final.outcome !== "BLOCK") {
        payment_id = randomUUID();
        const hold = final.outcome === "HOLD";
        await tx.query(
          `INSERT INTO payments(payment_id, decision_id, mandate_id, amount_cents, currency, state, needs_approval, approval) VALUES ($1,$2,$3,$4,'USD','RESERVED',$5,$6)`,
          [payment_id, decision_id, p.mandate_id, rules.total_cents, hold, hold ? "PENDING" : "NOT_REQUIRED"],
        );
        await enqueue(tx, "payment.authorize", { payment_id });
      }
      await appendLedger(
        tx,
        "decision",
        {
          decision_id,
          kind: "primary",
          agent_id: agentId,
          mandate_id: p.mandate_id,
          mandate_hash: row?.body_hash ?? null,
          request_hash: reqHash,
          outcome: final.outcome,
          reasons: final.reasons.map((r) => r.code),
          total_cents: rules.total_cents,
          period_spent_before_cents: spent,
          payment_id,
          intent_verdict: usedVerdict.kind,
        },
        now,
      );
    });
  } catch (e: unknown) {
    // Lost a race with a concurrent request using the same idempotency key: treat as replay/conflict.
    if ((e as { code?: string }).code === "23505") {
      const winner = await existingPrimary(deps.db, agentId, p.idempotency_key);
      if (winner) return recordReplayOrConflict(deps, agentId, raw, reqHash, winner, p.idempotency_key, p.mandate_id);
    }
    throw e;
  }
  deps.wake();
  return getDecision(deps.db, decision_id);
}

// ------------------------------------------------------------------------------------------------------------------
// Approvals
// ------------------------------------------------------------------------------------------------------------------

export async function decideApproval(deps: Deps, input: { statement: unknown; signature: string }) {
  const st = ApprovalStatement.safeParse(input.statement);
  if (!st.success) throw new HttpError(400, "invalid approval", st.error.issues);
  const now = deps.now();
  if (Math.abs(now.getTime() - Date.parse(st.data.signed_at)) > STATEMENT_MAX_AGE_MS) throw new HttpError(400, "approval statement is stale");
  const out = await withTx(deps.db, async (tx) => {
    const p = (await tx.query("SELECT p.*, m.owner_id FROM payments p JOIN mandates m USING (mandate_id) WHERE p.payment_id = $1 FOR UPDATE OF p", [st.data.payment_id])).rows[0];
    if (!p) throw new HttpError(404, "unknown payment");
    const owner = await ownerKey(tx, p.owner_id);
    // SAFETY: only the owner's key can release held money. The agent has no key, so it cannot approve itself.
    if (!owner || !verifyJson("approval", st.data, input.signature, owner.public_key_hex)) throw new HttpError(401, "approval signature invalid");
    if (p.approval !== "PENDING") throw new HttpError(409, `payment approval is ${p.approval}`);
    if (p.state !== "AUTHORIZED") throw new HttpError(409, `payment is ${p.state}; wait for the PayPal authorization`);
    const approved = st.data.decision === "approve";
    await tx.query("UPDATE payments SET approval = $2, approval_signature = $3, updated_at = now() WHERE payment_id = $1", [p.payment_id, approved ? "APPROVED" : "REJECTED", input.signature]);
    await enqueue(tx, approved ? "payment.capture" : "payment.void", { payment_id: p.payment_id, reason: approved ? "owner approved" : "owner rejected" });
    await appendLedger(tx, approved ? "approval.approved" : "approval.rejected", { payment_id: p.payment_id, statement: st.data, signature: input.signature }, now);
    return { payment_id: p.payment_id, approval: approved ? "APPROVED" : "REJECTED" };
  });
  deps.wake();
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// Jobs
// ------------------------------------------------------------------------------------------------------------------

export async function enqueue(tx: Tx, kind: string, payload: unknown, delaySeconds = 0) {
  await tx.query("INSERT INTO jobs(kind, payload, run_at) VALUES ($1, $2, now() + make_interval(secs => $3))", [kind, JSON.stringify(payload), delaySeconds]);
}

interface PaymentRow {
  payment_id: string;
  mandate_id: string;
  amount_cents: number;
  state: string;
  needs_approval: boolean;
  approval: string;
  paypal_authorization_id: string | null;
  paypal_order_id: string | null;
}

async function lockPayment(tx: Tx, id: string): Promise<(PaymentRow & { revoked_at: Date | null; body: MandateBody; owner_id: string; paypal_vault_id: string | null }) | undefined> {
  return (
    await tx.query(
      `SELECT p.*, m.revoked_at, m.body, m.owner_id, o.paypal_vault_id FROM payments p
       JOIN mandates m USING (mandate_id) JOIN owners o ON o.owner_id = m.owner_id WHERE p.payment_id = $1 FOR UPDATE OF p`,
      [id],
    )
  ).rows[0];
}

function mandateStillLive(m: { revoked_at: Date | null; body: MandateBody }, now: Date): string | null {
  if (m.revoked_at) return "mandate revoked";
  if (now.getTime() >= Date.parse(m.body.valid_until)) return "mandate expired";
  return null;
}

export async function jobAuthorize(deps: Deps, paymentId: string) {
  // Read outside a lock: the PayPal call can be slow. The CAS update below makes the transition exactly-once.
  const p = await withTx(deps.db, (tx) => lockPayment(tx, paymentId));
  if (!p || p.state !== "RESERVED") return;
  const decision = (await deps.db.query("SELECT lines FROM decisions WHERE decision_id = (SELECT decision_id FROM payments WHERE payment_id = $1)", [paymentId])).rows[0];
  if (!p.paypal_vault_id) {
    await failPayment(deps, paymentId, "owner has no vaulted PayPal payment method");
    return;
  }
  const res = await deps.provider.authorize({
    requestId: `leash-${paymentId}-authorize`,
    vaultId: p.paypal_vault_id,
    paymentId,
    amountCents: p.amount_cents,
    currency: "USD",
    lines: decision.lines,
    shipTo: p.body.ship_to,
  }); // ProviderUncertainError propagates → job retried with the same PayPal-Request-Id.
  if (!res.ok) {
    await failPayment(deps, paymentId, res.error);
    return;
  }
  const now = deps.now();
  await withTx(deps.db, async (tx) => {
    const cur = await lockPayment(tx, paymentId);
    if (!cur || cur.state !== "RESERVED") return;
    await tx.query("UPDATE payments SET state = 'AUTHORIZED', paypal_order_id = $2, paypal_authorization_id = $3, updated_at = now() WHERE payment_id = $1", [paymentId, res.orderId, res.authorizationId]);
    await appendLedger(tx, "payment.authorized", { payment_id: paymentId, amount_cents: cur.amount_cents, paypal_order_id: res.orderId, paypal_authorization_id: res.authorizationId }, now);
    // SAFETY (G4): the owner may have revoked while PayPal was answering. Re-check before any capture.
    const dead = mandateStillLive(cur, now);
    if (dead) await enqueue(tx, "payment.void", { payment_id: paymentId, reason: dead });
    else if (cur.needs_approval) {
      await tx.query("UPDATE payments SET approval_expires_at = now() + make_interval(secs => $2) WHERE payment_id = $1", [paymentId, deps.config.approvalTimeoutSeconds]);
      await enqueue(tx, "approval.expire", { payment_id: paymentId }, deps.config.approvalTimeoutSeconds);
    } else await enqueue(tx, "payment.capture", { payment_id: paymentId });
  });
  deps.wake();
}

async function failPayment(deps: Deps, paymentId: string, error: string) {
  await withTx(deps.db, async (tx) => {
    const r = await tx.query("UPDATE payments SET state = 'FAILED', last_error = $2, updated_at = now() WHERE payment_id = $1 AND state = 'RESERVED'", [paymentId, error.slice(0, 500)]);
    if (r.rowCount) await appendLedger(tx, "payment.failed", { payment_id: paymentId, error: error.slice(0, 500) }, deps.now());
  });
}

export async function jobCapture(deps: Deps, paymentId: string) {
  let enqueuedVoid = false;
  await withTx(deps.db, async (tx) => {
    // Holding the row lock across the capture call: approve/void/webhook processing for this payment wait for us.
    const p = await lockPayment(tx, paymentId);
    if (!p || p.state !== "AUTHORIZED") return;
    if (!(p.approval === "NOT_REQUIRED" || p.approval === "APPROVED")) return;
    const now = deps.now();
    const dead = mandateStillLive(p, now);
    if (dead) {
      await enqueue(tx, "payment.void", { payment_id: paymentId, reason: dead });
      enqueuedVoid = true;
      return;
    }
    try {
      const c = await deps.provider.capture({ requestId: `leash-${paymentId}-capture`, authorizationId: p.paypal_authorization_id!, invoiceId: paymentId });
      await tx.query("UPDATE payments SET state = 'CAPTURED', paypal_capture_id = $2, updated_at = now() WHERE payment_id = $1", [paymentId, c.captureId]);
      await appendLedger(tx, "payment.captured", { payment_id: paymentId, amount_cents: p.amount_cents, paypal_capture_id: c.captureId, status: c.status }, now);
    } catch (e) {
      if (!(e instanceof ProviderRejectedError)) throw e;
      // Capture definitively refused: release the hold rather than leave money in limbo.
      await tx.query("UPDATE payments SET last_error = $2, updated_at = now() WHERE payment_id = $1", [paymentId, e.message.slice(0, 500)]);
      await appendLedger(tx, "payment.capture_rejected", { payment_id: paymentId, error: e.message.slice(0, 500) }, now);
      await enqueue(tx, "payment.void", { payment_id: paymentId, reason: "capture rejected" });
      enqueuedVoid = true;
    }
  });
  if (enqueuedVoid) deps.wake();
}

export async function jobVoid(deps: Deps, paymentId: string, reason: string): Promise<"done" | "retry"> {
  return withTx(deps.db, async (tx) => {
    const p = await lockPayment(tx, paymentId);
    if (!p) return "done";
    if (p.state === "RESERVED") return "retry"; // authorize still in flight; it re-checks the mandate itself
    if (p.state !== "AUTHORIZED") return "done";
    const now = deps.now();
    try {
      await deps.provider.voidAuthorization({ requestId: `leash-${paymentId}-void`, authorizationId: p.paypal_authorization_id! });
    } catch (e) {
      if (!(e instanceof ProviderRejectedError)) throw e;
      await appendLedger(tx, "payment.void_rejected", { payment_id: paymentId, error: e.message.slice(0, 500) }, now);
      return "done";
    }
    await tx.query(
      `UPDATE payments SET state = 'VOIDED', approval = CASE WHEN approval = 'PENDING' THEN 'EXPIRED' ELSE approval END, updated_at = now() WHERE payment_id = $1`,
      [paymentId],
    );
    await appendLedger(tx, "payment.voided", { payment_id: paymentId, amount_cents: p.amount_cents, reason }, now);
    return "done";
  });
}

export async function jobExpireApproval(deps: Deps, paymentId: string) {
  await withTx(deps.db, async (tx) => {
    const r = await tx.query("UPDATE payments SET approval = 'EXPIRED', updated_at = now() WHERE payment_id = $1 AND approval = 'PENDING' AND state = 'AUTHORIZED' RETURNING payment_id", [paymentId]);
    if (!r.rowCount) return;
    await appendLedger(tx, "approval.expired", { payment_id: paymentId }, deps.now());
    await enqueue(tx, "payment.void", { payment_id: paymentId, reason: "approval timed out" });
  });
  deps.wake();
}

// ------------------------------------------------------------------------------------------------------------------
// Webhooks: verified PayPal events reconcile against our payment state.
// ------------------------------------------------------------------------------------------------------------------

export async function receiveWebhook(deps: Deps, headers: Record<string, string | undefined>, rawBody: string) {
  let event: { id?: string; event_type?: string; resource?: { id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!event.id || !event.event_type) throw new HttpError(400, "not a PayPal event");
  const verified = await deps.provider.verifyWebhook(headers, rawBody);
  await withTx(deps.db, async (tx) => {
    const ins = await tx.query(
      "INSERT INTO webhook_events(event_id, event_type, resource_id, verified, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING",
      [event.id, event.event_type, event.resource?.id ?? null, verified, rawBody],
    );
    if (!ins.rowCount) return; // PayPal redelivery: already have it
    await appendLedger(tx, verified ? "webhook.received" : "webhook.rejected_unverified", { event_id: event.id, event_type: event.event_type, resource_id: event.resource?.id ?? null }, deps.now());
    if (verified) await enqueue(tx, "webhook.process", { event_id: event.id });
  });
  deps.wake();
  // SAFETY: unverified events are stored for audit but never change payment state.
  if (!verified) throw new HttpError(400, "webhook signature not verified");
}

export async function jobProcessWebhook(deps: Deps, eventId: string) {
  await withTx(deps.db, async (tx) => {
    const ev = (await tx.query("SELECT * FROM webhook_events WHERE event_id = $1 FOR UPDATE", [eventId])).rows[0];
    if (!ev || ev.processed_at || !ev.verified) return;
    const payload = ev.payload as { event_type: string; resource: { id: string; custom_id?: string; invoice_id?: string; status?: string; supplementary_data?: { related_ids?: { authorization_id?: string } } } };
    const r = payload.resource ?? ({} as never);
    const candidates = [r.custom_id, r.invoice_id].filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x));
    let pay = candidates.length ? (await tx.query("SELECT payment_id FROM payments WHERE payment_id = ANY($1::uuid[])", [candidates])).rows[0] : undefined;
    if (!pay) pay = (await tx.query("SELECT payment_id FROM payments WHERE paypal_authorization_id = $1 OR paypal_capture_id = $1 OR paypal_authorization_id = $2", [r.id, r.supplementary_data?.related_ids?.authorization_id ?? null])).rows[0];
    const now = deps.now();
    if (!pay) {
      await appendLedger(tx, "reconcile.unmatched", { event_id: eventId, event_type: payload.event_type, resource_id: r.id }, now);
    } else {
      const p = (await lockPayment(tx, pay.payment_id))!;
      const t = payload.event_type;
      let status: "CONFIRMED" | "MISMATCH" | null = null;
      let note = "";
      if (t === "PAYMENT.CAPTURE.COMPLETED") {
        status = p.state === "CAPTURED" ? "CONFIRMED" : "MISMATCH";
        note = `PayPal says captured; we have ${p.state}`;
      } else if (t === "PAYMENT.AUTHORIZATION.CREATED") {
        status = ["AUTHORIZED", "CAPTURED", "VOIDED"].includes(p.state) ? null : "MISMATCH";
        note = `PayPal says authorized; we have ${p.state}`;
      } else if (t === "PAYMENT.AUTHORIZATION.VOIDED") {
        if (p.state === "AUTHORIZED") {
          // PayPal is authoritative that the hold is gone (e.g. expired). Release the budget.
          await tx.query("UPDATE payments SET state = 'VOIDED', updated_at = now() WHERE payment_id = $1", [p.payment_id]);
          note = "PayPal voided an authorization we still held; marked VOIDED";
          status = "MISMATCH";
        } else {
          status = p.state === "VOIDED" ? "CONFIRMED" : "MISMATCH";
          note = `PayPal says voided; we have ${p.state}`;
        }
      } else if (t === "PAYMENT.CAPTURE.DENIED" || t === "PAYMENT.CAPTURE.DECLINED") {
        if (p.state === "CAPTURED") await tx.query("UPDATE payments SET state = 'FAILED', updated_at = now() WHERE payment_id = $1", [p.payment_id]);
        status = "MISMATCH";
        note = "PayPal denied the capture";
      }
      if (status) await tx.query("UPDATE payments SET reconciliation = $2, reconciliation_note = $3 WHERE payment_id = $1", [p.payment_id, status, note]);
      await appendLedger(tx, "reconcile", { event_id: eventId, event_type: t, payment_id: p.payment_id, our_state: p.state, result: status ?? "NOTED" }, now);
    }
    await tx.query("UPDATE webhook_events SET processed_at = now() WHERE event_id = $1", [eventId]);
  });
}

export { ProviderUncertainError };
