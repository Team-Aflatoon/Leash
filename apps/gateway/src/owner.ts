import { OwnerAction, periodStart, verifyJson } from "@leash/core";
import { withTx } from "./db.ts";
import { appendLedger } from "./ledger.ts";
import { HttpError, ownerRef, type Deps } from "./service.ts";

const MAX_AGE_MS = 5 * 60_000;

/** Verify a signed owner action (fresh, right owner, right action). Returns the owner id. */
export async function verifyOwnerAction(deps: Deps, input: { statement: unknown; signature: string }, action: OwnerAction["action"]): Promise<OwnerAction> {
  const st = OwnerAction.safeParse(input?.statement);
  if (!st.success) throw new HttpError(400, "invalid owner action", st.error.issues);
  if (st.data.action !== action) throw new HttpError(400, "wrong action");
  if (Math.abs(deps.now().getTime() - Date.parse(st.data.signed_at)) > MAX_AGE_MS) throw new HttpError(400, "owner action is stale");
  const o = (await deps.db.query("SELECT public_key_hex FROM owners WHERE owner_id = $1", [st.data.owner_id])).rows[0];
  if (!o || !verifyJson("owner-action", st.data, String(input.signature ?? ""), o.public_key_hex)) throw new HttpError(401, "owner signature invalid");
  return st.data;
}

export async function startPayPalLink(deps: Deps, ownerId: string) {
  const returnUrl = `${deps.config.publicUrl}/api/paypal/return?owner_id=${encodeURIComponent(ownerId)}`;
  const cancelUrl = `${deps.config.publicUrl}/?paypal=cancelled`;
  const s = await deps.provider.createVaultSetup({ requestId: `leash-setup-${ownerId}-${Date.now()}`, returnUrl, cancelUrl });
  await deps.db.query("UPDATE owners SET paypal_setup_token = $2 WHERE owner_id = $1", [ownerId, s.setupTokenId]);
  return { approve_url: s.approveUrl };
}

export async function finishPayPalLink(deps: Deps, ownerId: string, returnedToken: string | null) {
  const o = (await deps.db.query("SELECT paypal_setup_token FROM owners WHERE owner_id = $1", [ownerId])).rows[0];
  if (!o?.paypal_setup_token) throw new HttpError(400, "no PayPal link in progress");
  // Review R12: PayPal echoes the approved setup token on return; it must be the one this owner started.
  if (returnedToken && returnedToken !== o.paypal_setup_token) throw new HttpError(400, "PayPal returned a different approval than the one started");
  const v = await deps.provider.finalizeVault({ requestId: `leash-vault-${o.paypal_setup_token}`, setupTokenId: o.paypal_setup_token });
  await withTx(deps.db, async (tx) => {
    await tx.query("UPDATE owners SET paypal_vault_id = $2, paypal_payer_email = $3, paypal_setup_token = NULL WHERE owner_id = $1", [ownerId, v.vaultId, v.payerEmail]);
    await appendLedger(tx, "owner.paypal_linked", { owner_ref: ownerRef(ownerId), vault_id_suffix: v.vaultId.slice(-4) }, deps.now());
  });
}

export async function dashboard(deps: Deps, ownerId: string) {
  const db = deps.db;
  const owner = (await db.query("SELECT owner_id, display_name, public_key_hex, paypal_vault_id IS NOT NULL AS paypal_linked, paypal_payer_email, created_at FROM owners WHERE owner_id = $1", [ownerId])).rows[0];
  if (!owner) throw new HttpError(404, "unknown owner");
  const start = periodStart(deps.now());
  const mandates = (
    await db.query(
      `SELECT m.mandate_id, m.body, m.body_hash, m.signature, m.revoked_at, m.revocation_reason, m.created_at,
         COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.mandate_id = m.mandate_id AND p.state = 'CAPTURED' AND p.created_at >= $2),0) AS captured_cents,
         COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.mandate_id = m.mandate_id AND p.state IN ('RESERVED','AUTHORIZED') AND p.created_at >= $2),0) AS held_cents
       FROM mandates m WHERE m.owner_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
      [ownerId, start],
    )
  ).rows;
  const decisions = (
    await db.query(
      `SELECT d.decision_id, d.kind, d.replay_of, d.agent_id, d.idempotency_key, d.mandate_id, d.request_body, d.outcome, d.reasons, d.lines, d.total_cents,
              d.intent_verdict, d.created_at, p.payment_id, p.state AS payment_state, p.approval, p.approval_expires_at,
              p.paypal_order_id, p.paypal_authorization_id, p.paypal_capture_id, p.reconciliation, p.reconciliation_note, p.last_error
       FROM decisions d LEFT JOIN payments p ON p.decision_id = d.decision_id
       WHERE d.mandate_id IN (SELECT mandate_id FROM mandates WHERE owner_id = $1)
       ORDER BY d.created_at DESC LIMIT 300`,
      [ownerId],
    )
  ).rows;
  return { owner, period_start: start.toISOString(), mandates, decisions };
}
