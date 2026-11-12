// Plan B (DECISIONS D13): one standing PayPal hold approved once; purchases are partial captures from it.
import { signJson } from "@leash/core";
import { afterEach, describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs.ts";
import { finishPayPalHold, startPayPalLink } from "../src/owner.ts";
import { decideApproval, revokeMandate } from "../src/service.ts";
import { key, makeWorld, type World } from "./helpers.ts";

const HONEST = [{ sku: "BEAN-ESP-1KG", quantity: 2 }, { sku: "MILK-OAT-12", quantity: 1 }]; // $86.40
const BIG = [{ sku: "CUP-12OZ-500", quantity: 3 }]; // $162 → HOLD

let w: World;
afterEach(async () => {
  await w?.app.close();
  await w?.db.end();
});

/** A world whose owner linked PayPal through the hold fallback (Vault refused). */
async function holdWorld(holdCents = 200_000) {
  w = await makeWorld({ linkPayPal: false });
  w.provider.vaultEnabled = false;
  w.provider.holdCents = holdCents;
  const link = await startPayPalLink(w.deps, w.owner.owner_id);
  expect(link.mode).toBe("hold");
  const orderId = (await w.db.query("SELECT paypal_hold_order_id FROM owners WHERE owner_id = $1", [w.owner.owner_id])).rows[0].paypal_hold_order_id;
  await finishPayPalHold(w.deps, w.owner.owner_id, orderId);
  return w;
}

describe("Plan B: standing hold", () => {
  it("auto mode falls back to a hold when PayPal refuses Vault, and the owner counts as linked", async () => {
    await holdWorld();
    const o = (await w.db.query("SELECT paypal_hold_status, paypal_hold_cents, paypal_vault_id FROM owners WHERE owner_id = $1", [w.owner.owner_id])).rows[0];
    expect(o).toMatchObject({ paypal_hold_status: "AUTHORIZED", paypal_hold_cents: 200_000, paypal_vault_id: null });
    expect(w.provider.calls.map((c) => c.op)).toEqual(["setup", "hold-order", "hold-authorize"]);
  });

  it("the return must carry the order this owner started (review R12)", async () => {
    w = await makeWorld({ linkPayPal: false });
    w.provider.vaultEnabled = false;
    await startPayPalLink(w.deps, w.owner.owner_id);
    await expect(finishPayPalHold(w.deps, w.owner.owner_id, "SOMEONE-ELSES-ORDER")).rejects.toThrow(/different approval/);
  });

  it("ALLOW is a partial capture of the exact amount from the hold, with no per-order PayPal authorization", async () => {
    await holdWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.outcome).toBe("ALLOW");
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    expect(p).toMatchObject({ state: "CAPTURED", funding: "hold" });
    expect(w.provider.count("authorize")).toBe(0);
    const cap = w.provider.calls.find((c) => c.op === "hold-capture")!;
    expect(cap.arg).toMatchObject({ amountCents: 8640, invoiceId: r.json.payment_id, requestId: `leash-${r.json.payment_id}-capture` });
  });

  it("a rejected HOLD is released without touching PayPal; an approved one is captured", async () => {
    await holdWorld();
    const a = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    expect((await w.payment(a.json.payment_id)).state).toBe("AUTHORIZED");
    const sign = (payment_id: string, decision: "approve" | "reject") => {
      const statement = { payment_id, decision, signed_at: new Date().toISOString() };
      return decideApproval(w.deps, { statement, signature: signJson("approval", statement, w.owner.secretKeyHex) });
    };
    await sign(a.json.payment_id, "reject");
    await w.drain();
    expect((await w.payment(a.json.payment_id)).state).toBe("VOIDED");
    expect(w.provider.count("void")).toBe(0);
    expect(w.provider.count("hold-capture")).toBe(0);

    const b = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "LID-12OZ-500", quantity: 5 }] }); // $155
    await w.drain();
    await sign(b.json.payment_id, "approve");
    await w.drain();
    expect((await w.payment(b.json.payment_id)).state).toBe("CAPTURED");
  });

  it("blocks an order the remaining hold can't cover, even when the mandate budget could", async () => {
    await holdWorld(10_000); // $100 hold, $400 mandate budget
    const first = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST }); // $86.40
    expect(first.json.outcome).toBe("ALLOW");
    const second = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }] }); // $24 > $13.60 left
    expect(second.json.outcome).toBe("BLOCK");
    expect(second.json.reasons.map((x: { code: string }) => x.code)).toContain("PAYMENT_HOLD_EXHAUSTED");
  });

  it("concurrent orders across two mandates never overdraw one hold", async () => {
    await holdWorld(30_000); // $300 hold
    const m2 = await w.newMandate();
    const lines = [{ sku: "BEAN-ESP-1KG", quantity: 4 }]; // $96 each → at most 3 fit in $300
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => w.propose({ mandate_id: i % 2 ? w.mandateId : m2, idempotency_key: key(), lines })));
    const committed = Number((await w.db.query("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE funding = 'hold' AND state IN ('RESERVED','AUTHORIZED','CAPTURED')")).rows[0].s);
    expect(committed).toBeLessThanOrEqual(30_000);
    expect(rs.filter((r) => r.json.outcome !== "BLOCK")).toHaveLength(3);
  });

  it("a capture whose answer was lost is completed with the same request id, never released, even after revocation", async () => {
    await holdWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await drainJobs(w.deps, 1); // authorize (no PayPal call for hold funding)
    // Simulate: the capture request left (sent mark committed) but the response was lost.
    await w.db.query("UPDATE payments SET capture_sent_at = now() WHERE payment_id = $1", [r.json.payment_id]);
    await w.db.query("UPDATE jobs SET done_at = now() WHERE kind = 'payment.capture'");
    const statement = { mandate_id: w.mandateId, revoked_at: new Date().toISOString() };
    await revokeMandate(w.deps, { statement, signature: signJson("revocation", statement, w.owner.secretKeyHex) });
    await w.drain();
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    expect(p.state).toBe("CAPTURED");
    const ids = w.provider.calls.filter((c) => c.op === "hold-capture").map((c) => c.requestId);
    expect(new Set(ids)).toEqual(new Set([`leash-${r.json.payment_id}-capture`]));
  });

  it("a definitively refused capture is released (nothing was captured)", async () => {
    await holdWorld();
    w.provider.captureBehaviour = "reject";
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("VOIDED");
  });
});
