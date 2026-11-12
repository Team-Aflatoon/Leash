import { generateKeyPair, signJson, verifyChain } from "@leash/core";
import { afterEach, describe, expect, it } from "vitest";
import { checkpoint, readLedger, verifyLedger } from "../src/ledger.ts";
import { decideApproval, receiveWebhook, revokeMandate } from "../src/service.ts";
import { key, makeWorld, type World } from "./helpers.ts";

const HONEST = [{ sku: "BEAN-ESP-1KG", quantity: 2 }, { sku: "MILK-OAT-12", quantity: 1 }]; // $86.40
const BIG = [{ sku: "CUP-12OZ-500", quantity: 3 }]; // $162 → over $150 threshold

let w: World;
afterEach(async () => {
  await w?.app.close();
  await w?.db.end();
});

const approve = (world: World, payment_id: string, decision: "approve" | "reject", sk = world.owner.secretKeyHex) => {
  const statement = { payment_id, decision, signed_at: new Date().toISOString() };
  return decideApproval(world.deps, { statement, signature: signJson("approval", statement, sk) });
};

describe("happy paths", () => {
  it("ALLOW → authorized and captured once, priced from the catalog", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.status).toBe(200);
    expect(r.json.outcome).toBe("ALLOW");
    expect(r.json.total_cents).toBe(8640);
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    expect(p.state).toBe("CAPTURED");
    expect(w.provider.count("authorize")).toBe(1);
    expect(w.provider.count("capture")).toBe(1);
    // ship-to sent to PayPal is the mandate's, never the agent's
    const auth = w.provider.calls.find((c) => c.op === "authorize")!.arg as { shipTo: { line1: string }; amountCents: number };
    expect(auth.shipTo.line1).toBe("418 Alder Street");
    expect(auth.amountCents).toBe(8640);
  });

  it("HOLD → authorized, not captured, until the owner approves", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    expect(r.json.outcome).toBe("HOLD");
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("AUTHORIZED");
    expect(w.provider.count("capture")).toBe(0);
    await approve(w, r.json.payment_id, "approve");
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("CAPTURED");
  });

  it("HOLD rejected → voided", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    await approve(w, r.json.payment_id, "reject");
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("VOIDED");
    expect(w.provider.count("capture")).toBe(0);
  });

  it("HOLD timeout → voided, approval EXPIRED", async () => {
    w = await makeWorld({ approvalTimeoutSeconds: 0 });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    expect(p.state).toBe("VOIDED");
    expect(p.approval).toBe("EXPIRED");
  });
});

describe("G1: the agent can only propose", () => {
  it("rejects missing or wrong agent tokens", async () => {
    w = await makeWorld();
    expect((await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST }, "nope")).status).toBe(401);
    const r = await w.app.inject({ method: "POST", url: "/api/agent/proposals", payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it("cannot approve its own held payment (no owner key)", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    await expect(approve(w, r.json.payment_id, "approve", generateKeyPair().secretKeyHex)).rejects.toThrow(/signature invalid/);
    const statement = { payment_id: r.json.payment_id, decision: "approve", signed_at: new Date().toISOString() };
    const viaHttp = await w.app.inject({ method: "POST", url: "/api/payments/approval", headers: { authorization: "Bearer test-agent-token-123456" }, payload: { statement, signature: "00".repeat(64) } });
    expect(viaHttp.statusCode).toBe(401);
    expect((await w.payment(r.json.payment_id)).state).toBe("AUTHORIZED");
  });

  it("an owner-signed approval cannot be replayed to capture twice", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    const statement = { payment_id: r.json.payment_id, decision: "approve" as const, signed_at: new Date().toISOString() };
    const signature = signJson("approval", statement, w.owner.secretKeyHex);
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => decideApproval(w.deps, { statement, signature })));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await w.drain();
    expect(w.provider.count("capture")).toBe(1);
  });
});

describe("G2: the gateway derives everything itself", () => {
  it("blocks a lowballed price claim and never sends it to PayPal", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "MACH-ESP-2G", quantity: 1, claimed_unit_price_cents: 1899, claimed_category: "coffee" }] });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(["PRICE_MISMATCH", "CATEGORY_MISMATCH", "CATEGORY_NOT_ALLOWED"]));
    await w.drain();
    expect(w.provider.calls).toHaveLength(0);
  });

  it("blocks a redirected shipping address", async () => {
    w = await makeWorld();
    const r = await w.propose({
      mandate_id: w.mandateId,
      idempotency_key: key(),
      lines: [{ sku: "SYRUP-VAN-750", quantity: 2 }],
      ship_to: { name: "Warehouse", line1: "77 Harbor Rd", city: "Newark", state: "NJ", postal_code: "07105", country_code: "US" },
    });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("ADDRESS_LOCK");
  });

  it("malformed input is recorded and blocked, not crashed on", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "BEAN-ESP-1KG", quantity: 1.5 }] });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons[0].code).toBe("MALFORMED_REQUEST");
  });
});

describe("G3: the LLM can only tighten", () => {
  it("suspicious verdict turns ALLOW into HOLD", async () => {
    w = await makeWorld({ withIntent: true });
    w.intent.verdict = { kind: "suspicious", rationale: "not café supplies" };
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.outcome).toBe("HOLD");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toEqual(["INTENT_MISMATCH"]);
  });
  it("LLM failure fails closed (HOLD)", async () => {
    w = await makeWorld({ withIntent: true });
    w.intent.verdict = { kind: "error", error: "timeout" };
    expect((await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST })).json.outcome).toBe("HOLD");
  });
  it("a 'consistent' verdict cannot unblock a rule violation; the LLM isn't even asked", async () => {
    w = await makeWorld({ withIntent: true });
    w.intent.verdict = { kind: "consistent", rationale: "looks fine" };
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "GIFT-500", quantity: 1 }] });
    expect(r.json.outcome).toBe("BLOCK");
    expect(w.intent.calls).toBe(0);
  });
});

describe("G4: mandate integrity, expiry, revocation", () => {
  it("a mandate edited in the database stops verifying", async () => {
    w = await makeWorld();
    await w.db.query("UPDATE mandates SET body = jsonb_set(body, '{budget,limit_cents}', '4000000') WHERE mandate_id = $1", [w.mandateId]);
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("SIGNATURE_INVALID");
  });

  it("rejects a mandate signed by someone else", async () => {
    w = await makeWorld();
    const { createMandate } = await import("../src/service.ts");
    const { demoMandate } = await import("@leash/core");
    const body = demoMandate({ mandate_id: crypto.randomUUID(), owner_id: w.owner.owner_id, now: new Date() });
    await expect(createMandate(w.deps, { body, signature: signJson("mandate", body, generateKeyPair().secretKeyHex) })).rejects.toThrow(/signature invalid/);
  });

  it("expired mandate blocks", async () => {
    w = await makeWorld();
    w.clock.now = new Date(Date.now() + 31 * 86_400_000);
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("MANDATE_EXPIRED");
  });

  it("revocation is immediate: blocks new proposals and voids open holds", async () => {
    w = await makeWorld();
    const held = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    const statement = { mandate_id: w.mandateId, revoked_at: new Date().toISOString() };
    await expect(revokeMandate(w.deps, { statement, signature: signJson("revocation", statement, generateKeyPair().secretKeyHex) })).rejects.toThrow(/signature invalid/);
    await revokeMandate(w.deps, { statement, signature: signJson("revocation", statement, w.owner.secretKeyHex) });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("MANDATE_REVOKED");
    await w.drain();
    expect((await w.payment(held.json.payment_id)).state).toBe("VOIDED");
    expect(w.provider.count("capture")).toBe(0);
  });

  it("revocation that lands while PayPal is authorizing still prevents capture", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    // Revoke before the authorize job runs (payment is RESERVED)
    const statement = { mandate_id: w.mandateId, revoked_at: new Date().toISOString() };
    await revokeMandate(w.deps, { statement, signature: signJson("revocation", statement, w.owner.secretKeyHex) });
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("VOIDED");
    expect(w.provider.count("capture")).toBe(0);
  });

  it("without PayPal consent nothing can be spent", async () => {
    w = await makeWorld({ linkPayPal: false });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("PAYMENT_CONSENT_MISSING");
  });
});

describe("G5: replays, duplicates and concurrency can't double-spend", () => {
  it("exact replay returns the original decision and creates no payment", async () => {
    w = await makeWorld();
    const body = { mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST };
    const a = await w.propose(body);
    await w.drain();
    const b = await w.propose(body);
    expect(b.json.kind).toBe("replay");
    expect(b.json.replay_of).toBe(a.json.decision_id);
    expect(b.json.payment_id).toBe(a.json.payment_id);
    await w.drain();
    expect(w.provider.count("authorize")).toBe(1);
    expect(w.provider.count("capture")).toBe(1);
    expect(Number((await w.db.query("SELECT count(*) FROM payments")).rows[0].count)).toBe(1);
  });

  it("same key with a different body is blocked as tampering", async () => {
    w = await makeWorld();
    const k = key();
    await w.propose({ mandate_id: w.mandateId, idempotency_key: k, lines: HONEST });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: k, lines: [{ sku: "BEAN-ESP-1KG", quantity: 12 }] });
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons[0].code).toBe("IDEMPOTENCY_CONFLICT");
    expect(Number((await w.db.query("SELECT count(*) FROM payments")).rows[0].count)).toBe(1);
  });

  it("20 concurrent copies of one request → 1 decision, 1 payment", async () => {
    w = await makeWorld();
    const body = { mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST };
    const rs = await Promise.all(Array.from({ length: 20 }, () => w.propose(body)));
    expect(rs.filter((r) => r.json.kind === "primary")).toHaveLength(1);
    expect(rs.filter((r) => r.json.kind === "replay")).toHaveLength(19);
    await w.drain();
    expect(w.provider.count("authorize")).toBe(1);
    expect(w.provider.count("capture")).toBe(1);
  });

  it("50 concurrent distinct orders never exceed the $400 budget", async () => {
    w = await makeWorld();
    const lines = [{ sku: "BEAN-ESP-1KG", quantity: 4 }]; // $96 each → at most 4 fit
    const rs = await Promise.all(Array.from({ length: 50 }, () => w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines })));
    const passed = rs.filter((r) => r.json.outcome !== "BLOCK");
    expect(passed).toHaveLength(4);
    expect(rs.filter((r) => r.json.reasons.some((x: { code: string }) => x.code === "BUDGET_EXCEEDED"))).toHaveLength(46);
    const committed = Number((await w.db.query("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE state IN ('RESERVED','AUTHORIZED','CAPTURED')")).rows[0].s);
    expect(committed).toBeLessThanOrEqual(40_000);
    expect(committed).toBe(4 * 9600);
  });

  it("a different key with the same cart is held as a suspected duplicate", async () => {
    w = await makeWorld();
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    expect(r.json.outcome).toBe("HOLD");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toEqual(["DUPLICATE_SUSPECTED"]);
  });
});

describe("payment correctness against PayPal failures", () => {
  it("a definitive decline marks FAILED and releases the budget", async () => {
    w = await makeWorld();
    w.provider.authorizeBehaviour = "decline";
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "CUP-12OZ-500", quantity: 2 }] });
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("FAILED");
    w.provider.authorizeBehaviour = "ok";
    // $108 + $96 + $120 = $324 fits in $400 only if the failed $108 was released (else 432)
    for (const lines of [[{ sku: "CUP-12OZ-500", quantity: 2 }], [{ sku: "BEAN-ESP-1KG", quantity: 4 }], [{ sku: "BEAN-ESP-1KG", quantity: 5 }]]) {
      expect((await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines })).json.outcome).not.toBe("BLOCK");
    }
  });

  it("an uncertain authorize is retried with the same PayPal-Request-Id and only authorizes once", async () => {
    w = await makeWorld();
    w.provider.authorizeBehaviour = "uncertain-once";
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("RESERVED"); // budget stays reserved while uncertain
    await w.db.query("UPDATE jobs SET run_at = now() WHERE done_at IS NULL");
    await w.drain();
    const ids = w.provider.calls.filter((c) => c.op === "authorize").map((c) => c.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect((await w.payment(r.json.payment_id)).state).toBe("CAPTURED");
  });

  it("a rejected capture voids the authorization instead of leaving it dangling", async () => {
    w = await makeWorld();
    w.provider.captureBehaviour = "reject";
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("VOIDED");
  });
});

describe("G7: audit ledger", () => {
  it("records every decision and payment step in a verifiable chain", async () => {
    w = await makeWorld();
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: [{ sku: "GIFT-500", quantity: 1 }] });
    await w.drain();
    const entries = await readLedger(w.db);
    expect(entries.map((e) => e.type)).toEqual(expect.arrayContaining(["owner.registered", "mandate.signed", "decision", "payment.authorized", "payment.captured"]));
    expect(verifyChain(entries).ok).toBe(true);
  });

  it("the database refuses UPDATE, DELETE and TRUNCATE on the ledger", async () => {
    w = await makeWorld();
    await expect(w.db.query("UPDATE ledger SET type = 'x' WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(w.db.query("DELETE FROM ledger WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(w.db.query("TRUNCATE ledger")).rejects.toThrow(/append-only/);
  });

  it("detects tampering by a superuser who bypasses the trigger, and signed checkpoints catch a full rewrite", async () => {
    w = await makeWorld();
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    const gw = generateKeyPair();
    await checkpoint(w.db, gw.secretKeyHex, new Date());
    expect((await verifyLedger(w.db, gw.publicKeyHex)).chain.ok).toBe(true);

    await w.db.query("ALTER TABLE ledger DISABLE TRIGGER USER");
    await w.db.query(`UPDATE ledger SET data = jsonb_set(data, '{outcome}', '"BLOCK"') WHERE type = 'decision'`);
    const v1 = await verifyLedger(w.db, gw.publicKeyHex);
    expect(v1.chain.ok).toBe(false);

    // Full rewrite: recompute every hash so the chain is self-consistent again.
    const { ledgerHash, GENESIS_HASH } = await import("@leash/core");
    let prev = GENESIS_HASH;
    for (const e of await readLedger(w.db)) {
      const h = ledgerHash(prev, e);
      await w.db.query("UPDATE ledger SET prev_hash = $2, hash = $3 WHERE seq = $1", [e.seq, prev, h]);
      prev = h;
    }
    const v2 = await verifyLedger(w.db, gw.publicKeyHex);
    expect(v2.chain.ok).toBe(true); // chain alone can't tell…
    expect(v2.checkpointFailures.length).toBeGreaterThan(0); // …the signed checkpoint can.
  });
});

describe("webhooks", () => {
  const evt = (id: string, type: string, resource: Record<string, unknown>) => JSON.stringify({ id, event_type: type, resource });

  it("unverified webhooks are recorded but never change state", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    w.provider.webhookValid = false;
    const p = await w.payment(r.json.payment_id);
    await expect(receiveWebhook(w.deps, {}, evt("WH-1", "PAYMENT.AUTHORIZATION.VOIDED", { id: p.paypal_authorization_id }))).rejects.toThrow(/not verified/);
    await w.drain();
    expect((await w.payment(r.json.payment_id)).state).toBe("AUTHORIZED");
  });

  it("verified capture webhook confirms reconciliation; redelivery is ignored", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    const body = evt("WH-2", "PAYMENT.CAPTURE.COMPLETED", { id: p.paypal_capture_id, custom_id: p.payment_id, status: "COMPLETED" });
    await receiveWebhook(w.deps, {}, body);
    await receiveWebhook(w.deps, {}, body);
    await w.drain();
    expect((await w.payment(r.json.payment_id)).reconciliation).toBe("CONFIRMED");
    expect(Number((await w.db.query("SELECT count(*) FROM webhook_events")).rows[0].count)).toBe(1);
  });

  it("PayPal voiding a hold we still hold releases the budget and flags a mismatch", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    await receiveWebhook(w.deps, {}, evt("WH-3", "PAYMENT.AUTHORIZATION.VOIDED", { id: p.paypal_authorization_id }));
    await w.drain();
    const after = await w.payment(r.json.payment_id);
    expect(after.state).toBe("VOIDED");
    expect(after.reconciliation).toBe("MISMATCH");
  });
});
