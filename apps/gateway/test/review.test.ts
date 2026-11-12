// Regression tests for the adversarial review findings (docs/REVIEW.md). Each one reproduced an exploit before the fix.
import { generateKeyPair, signJson } from "@leash/core";
import { afterEach, describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs.ts";
import { readLedger } from "../src/ledger.ts";
import { finishPayPalLink } from "../src/owner.ts";
import { decideApproval, mintAgentToken, receiveWebhook, registerOwner, revokeMandate } from "../src/service.ts";
import { key, makeWorld, type World } from "./helpers.ts";

const HONEST = [{ sku: "BEAN-ESP-1KG", quantity: 2 }, { sku: "MILK-OAT-12", quantity: 1 }];
const BIG = [{ sku: "CUP-12OZ-500", quantity: 3 }];

let w: World;
afterEach(async () => {
  await w?.app.close();
  await w?.db.end();
});

const ownerHeader = (owner_id: string, sk: string) => {
  const statement = { owner_id, action: "read", signed_at: new Date().toISOString() };
  return Buffer.from(JSON.stringify({ statement, signature: signJson("owner-action", statement, sk) })).toString("base64url");
};

describe("R1: agent tokens are scoped to one mandate", () => {
  it("a run token for mandate A cannot spend against mandate B, read B, or read B's decisions", async () => {
    w = await makeWorld();
    const other = await w.newMandate(); // stands in for another owner's mandate
    const tokenA = await mintAgentToken(w.db, w.mandateId);
    const r = await w.propose({ mandate_id: other, idempotency_key: key(), lines: HONEST }, tokenA);
    expect(r.json.outcome).toBe("BLOCK");
    expect(r.json.reasons.map((x: { code: string }) => x.code)).toContain("AGENT_NOT_AUTHORIZED");
    await w.drain();
    expect(w.provider.count("authorize")).toBe(0);
    const read = await w.app.inject({ method: "GET", url: `/api/agent/mandates/${other}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(read.statusCode).toBe(404);
    const ok = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST }, tokenA);
    expect(ok.json.outcome).toBe("ALLOW");
  });

  it("expired run tokens are rejected", async () => {
    w = await makeWorld();
    const t = await mintAgentToken(w.db, w.mandateId, 0);
    expect((await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST }, t)).status).toBe(401);
  });
});

describe("R2: no cross-owner disclosure", () => {
  it("dashboard requires the owner's own signature", async () => {
    w = await makeWorld();
    const url = `/api/owners/${w.owner.owner_id}/dashboard`;
    expect((await w.app.inject({ method: "GET", url })).statusCode).toBe(400);
    const intruder = generateKeyPair();
    const { owner_id: other } = await registerOwner(w.deps, { display_name: "x", public_key_hex: intruder.publicKeyHex });
    expect((await w.app.inject({ method: "GET", url, headers: { "x-leash-auth": ownerHeader(other, intruder.secretKeyHex) } })).statusCode).toBe(403);
    expect((await w.app.inject({ method: "GET", url, headers: { "x-leash-auth": ownerHeader(w.owner.owner_id, intruder.secretKeyHex) } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: "GET", url, headers: { "x-leash-auth": ownerHeader(w.owner.owner_id, w.owner.secretKeyHex) } })).statusCode).toBe(200);
  });

  it("the public ledger carries no owner ids, addresses or mandate bodies", async () => {
    w = await makeWorld();
    const text = JSON.stringify(await readLedger(w.db));
    expect(text).not.toContain(w.owner.owner_id);
    expect(text).not.toContain("Alder Street");
    expect(text).not.toContain("allowed_categories");
  });

  it("mandate drafting (LLM spend) requires an owner signature", async () => {
    w = await makeWorld();
    const r = await w.app.inject({ method: "POST", url: "/api/mandates/draft", payload: { intent: "buy coffee" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("R3: a void that finds the money already captured records a capture", () => {
  it("budget stays counted and the ledger says captured, not voided", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG }); // HOLD $162
    await w.drain();
    w.provider.voidBehaviour = "already_captured";
    await approveOrReject(w, r.json.payment_id, "reject");
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    expect(p.state).toBe("CAPTURED");
    expect(p.reconciliation).toBe("MISMATCH");
    const types = (await readLedger(w.db)).map((e) => e.type);
    expect(types).not.toContain("payment.voided");
  });
});

describe("R5: checkpoints are append-only", () => {
  it("the database refuses to delete or edit signed checkpoints", async () => {
    w = await makeWorld();
    await w.db.query("INSERT INTO ledger_checkpoints(seq, hash, signed_at, signature) VALUES (1, 'h', 't', 's')");
    await expect(w.db.query("DELETE FROM ledger_checkpoints")).rejects.toThrow(/append-only/);
    await expect(w.db.query("UPDATE ledger_checkpoints SET hash = 'x'")).rejects.toThrow(/append-only/);
  });
});

describe("R6: forged webhooks can't shadow genuine ones", () => {
  it("an unverified event is not stored, so PayPal's genuine delivery of the same id is processed", async () => {
    w = await makeWorld();
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await w.drain();
    const p = await w.payment(r.json.payment_id);
    const body = JSON.stringify({ id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: p.paypal_capture_id, custom_id: p.payment_id } });
    w.provider.webhookValid = false;
    await expect(receiveWebhook(w.deps, {}, body)).rejects.toThrow(/not verified/);
    expect(Number((await w.db.query("SELECT count(*) FROM webhook_events")).rows[0].count)).toBe(0);
    w.provider.webhookValid = true;
    await receiveWebhook(w.deps, {}, body);
    await w.drain();
    expect((await w.payment(r.json.payment_id)).reconciliation).toBe("CONFIRMED");
  });
});

describe("R7: money jobs never give up", () => {
  it("an authorize that stays uncertain keeps retrying instead of stranding the reservation", async () => {
    w = await makeWorld();
    w.provider.authorizeBehaviour = "uncertain";
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    for (let i = 0; i < 15; i++) {
      await w.db.query("UPDATE jobs SET run_at = now() WHERE done_at IS NULL");
      await drainJobs(w.deps);
    }
    const job = (await w.db.query("SELECT attempts, done_at FROM jobs WHERE kind = 'payment.authorize'")).rows[0];
    expect(job.attempts).toBeGreaterThanOrEqual(13);
    expect(job.done_at).toBeNull();
  });
});

describe("R9: expired holds can't be approved", () => {
  it("approval after the deadline is refused even if the expiry job hasn't run", async () => {
    w = await makeWorld({ approvalTimeoutSeconds: 60 });
    const r = await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: BIG });
    await drainJobs(w.deps); // authorize; expiry job not yet due
    w.clock.now = new Date(Date.now() + 3600_000);
    const statement = { payment_id: r.json.payment_id, decision: "approve" as const, signed_at: w.clock.now.toISOString() };
    await expect(decideApproval(w.deps, { statement, signature: signJson("approval", statement, w.owner.secretKeyHex) })).rejects.toThrow(/expired/);
  });
});

describe("R10: revocation waits for an in-flight capture", () => {
  it("once revoke returns, no capture is still in flight", async () => {
    w = await makeWorld();
    w.provider.delayMs = 400;
    await w.propose({ mandate_id: w.mandateId, idempotency_key: key(), lines: HONEST });
    await drainJobs(w.deps, 1); // authorize (slow)
    const capturing = drainJobs(w.deps, 1); // capture job now talking to "PayPal"
    await new Promise((r) => setTimeout(r, 100));
    const statement = { mandate_id: w.mandateId, revoked_at: new Date().toISOString() };
    await revokeMandate(w.deps, { statement, signature: signJson("revocation", statement, w.owner.secretKeyHex) });
    const capturesAtRevoke = w.provider.count("capture");
    const stateAtRevoke = (await w.db.query("SELECT state FROM payments")).rows[0].state;
    await capturing;
    expect(stateAtRevoke).toBe("CAPTURED"); // the in-flight capture finished before revoke committed
    expect(w.provider.count("capture")).toBe(capturesAtRevoke);
  });
});

describe("R12: PayPal return must match the setup token this owner started", () => {
  it("rejects a different approval token", async () => {
    w = await makeWorld({ linkPayPal: false });
    await w.db.query("UPDATE owners SET paypal_setup_token = 'ST-mine' WHERE owner_id = $1", [w.owner.owner_id]);
    await expect(finishPayPalLink(w.deps, w.owner.owner_id, "ST-attacker")).rejects.toThrow(/different approval/);
  });
});

async function approveOrReject(world: World, payment_id: string, decision: "approve" | "reject") {
  const statement = { payment_id, decision, signed_at: new Date().toISOString() };
  return decideApproval(world.deps, { statement, signature: signJson("approval", statement, world.owner.secretKeyHex) });
}
