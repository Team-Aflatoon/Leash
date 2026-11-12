import { OwnerAction, periodStart, verifyJson } from "@leash/core";
import { withTx } from "./db.ts";
import { appendLedger } from "./ledger.ts";
import { ProviderRejectedError } from "./provider.ts";
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
  const mode = deps.config.consentMode ?? "auto";
  if (mode !== "hold") {
    try {
      const s = await deps.provider.createVaultSetup({ requestId: `leash-setup-${ownerId}-${Date.now()}`, returnUrl, cancelUrl });
      await deps.db.query("UPDATE owners SET paypal_setup_token = $2 WHERE owner_id = $1", [ownerId, s.setupTokenId]);
      return { approve_url: s.approveUrl, mode: "vault" as const };
    } catch (e) {
      // PayPal refuses Vault for merchants it hasn't enabled (SANDBOX_LOG). In auto mode, fall back to Plan B.
      if (mode === "vault" || !(e instanceof ProviderRejectedError)) throw e;
    }
  }
  return startPayPalHold(deps, ownerId);
}

/** Plan B (DECISIONS D13): one AUTHORIZE order for a standing hold, approved once by the owner. */
export async function startPayPalHold(deps: Deps, ownerId: string) {
  const cents = deps.config.holdCents ?? 200_000;
  const returnUrl = `${deps.config.publicUrl}/api/paypal/hold-return?owner_id=${encodeURIComponent(ownerId)}`;
  const cancelUrl = `${deps.config.publicUrl}/?paypal=cancelled`;
  const h = await deps.provider.createHoldOrder({ requestId: `leash-hold-${ownerId}-${Date.now()}`, amountCents: cents, currency: "USD", returnUrl, cancelUrl });
  await withTx(deps.db, async (tx) => {
    await tx.query("UPDATE owners SET paypal_hold_order_id = $2, paypal_hold_status = 'AWAITING_BUYER' WHERE owner_id = $1", [ownerId, h.orderId]);
    await appendLedger(tx, "owner.paypal_hold_requested", { owner_ref: ownerRef(ownerId), amount_cents: cents }, deps.now());
  });
  return { approve_url: h.approveUrl, mode: "hold" as const };
}

export async function finishPayPalHold(deps: Deps, ownerId: string, returnedOrderId: string | null) {
  const o = (await deps.db.query("SELECT paypal_hold_order_id, paypal_hold_status FROM owners WHERE owner_id = $1", [ownerId])).rows[0];
  if (!o?.paypal_hold_order_id || o.paypal_hold_status !== "AWAITING_BUYER") throw new HttpError(400, "no PayPal hold waiting for approval");
  // PayPal appends ?token=<order id> to the return URL; it must be the order this owner started (review R12).
  if (returnedOrderId && returnedOrderId !== o.paypal_hold_order_id) throw new HttpError(400, "PayPal returned a different approval than the one started");
  const a = await deps.provider.authorizeHoldOrder({ requestId: `leash-holdauth-${o.paypal_hold_order_id}`, orderId: o.paypal_hold_order_id });
  await withTx(deps.db, async (tx) => {
    await tx.query(
      "UPDATE owners SET paypal_hold_auth_id = $2, paypal_hold_cents = $3, paypal_hold_expires_at = $4, paypal_hold_status = 'AUTHORIZED', paypal_payer_email = COALESCE($5, paypal_payer_email) WHERE owner_id = $1",
      [ownerId, a.authorizationId, a.amountCents, a.expiresAt, a.payerEmail],
    );
    await appendLedger(tx, "owner.paypal_hold_authorized", { owner_ref: ownerRef(ownerId), amount_cents: a.amountCents, authorization_suffix: a.authorizationId.slice(-4), expires_at: a.expiresAt }, deps.now());
  });
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
  const owner = (
    await db.query(
      `SELECT owner_id, display_name, public_key_hex, paypal_payer_email, created_at,
         (paypal_vault_id IS NOT NULL OR (paypal_hold_status = 'AUTHORIZED' AND (paypal_hold_expires_at IS NULL OR paypal_hold_expires_at > now()))) AS paypal_linked,
         CASE WHEN paypal_vault_id IS NOT NULL THEN 'vault' WHEN paypal_hold_status = 'AUTHORIZED' THEN 'hold' ELSE NULL END AS consent_mode,
         paypal_hold_cents, paypal_hold_expires_at, paypal_hold_status,
         CASE WHEN paypal_hold_auth_id IS NULL THEN NULL ELSE paypal_hold_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.funding_ref = owners.paypal_hold_auth_id AND p.state IN ('RESERVED','AUTHORIZED','CAPTURED')),0) END AS paypal_hold_remaining_cents
       FROM owners WHERE owner_id = $1`,
      [ownerId],
    )
  ).rows[0];
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
