import { describe, expect, it } from "vitest";
import {
  DEMO_CATALOG,
  DEMO_AGENT_ID,
  DEMO_SHIP_TO,
  MandateBody,
  Proposal,
  canonicalize,
  combine,
  demoMandate,
  evaluateRules,
  generateKeyPair,
  ledgerHash,
  GENESIS_HASH,
  signJson,
  verifyChain,
  verifyJson,
  type IntentVerdict,
  type MandateState,
  type Outcome,
  type RuleInput,
  type StoredLedgerEntry,
} from "../src/index.ts";

const NOW = new Date("2026-11-12T12:00:00Z");
const catalog = new Map(DEMO_CATALOG.map((c) => [c.sku, c]));
const MID = "11111111-1111-4111-8111-111111111111";

function mandateState(over: Partial<MandateState> = {}, bodyOver: Partial<MandateBody> = {}): MandateState {
  return { body: { ...demoMandate({ mandate_id: MID, owner_id: "owner-1", now: NOW }), ...bodyOver }, signatureValid: true, revoked: false, paymentConsent: true, ...over };
}

function input(proposal: Partial<Proposal>, over: Partial<RuleInput> = {}): RuleInput {
  return {
    now: NOW,
    agentId: DEMO_AGENT_ID,
    mandate: mandateState(),
    proposal: { mandate_id: MID, idempotency_key: "key-00000001", lines: [{ sku: "BEAN-ESP-1KG", quantity: 2 }], ...proposal },
    catalog,
    periodSpentCents: 0,
    duplicateOfRecent: false,
    ...over,
  };
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code).sort();

describe("canonical JSON", () => {
  it("sorts keys and is independent of insertion order", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it("rejects floats so money can't drift", () => {
    expect(() => canonicalize({ amount: 1.5 })).toThrow();
  });
});

describe("Ed25519 signatures (G4 tamper-evidence)", () => {
  const kp = generateKeyPair();
  const body = demoMandate({ mandate_id: MID, owner_id: "o", now: NOW });
  const sig = signJson("mandate", body, kp.secretKeyHex);

  it("verifies an untouched mandate", () => {
    expect(verifyJson("mandate", body, sig, kp.publicKeyHex)).toBe(true);
  });
  it("rejects any edit to the mandate", () => {
    expect(verifyJson("mandate", { ...body, budget: { ...body.budget, limit_cents: 4_000_000 } }, sig, kp.publicKeyHex)).toBe(false);
    expect(verifyJson("mandate", { ...body, ship_to: { ...body.ship_to, line1: "77 Harbor Rd" } }, sig, kp.publicKeyHex)).toBe(false);
  });
  it("rejects a signature from another key", () => {
    expect(verifyJson("mandate", body, sig, generateKeyPair().publicKeyHex)).toBe(false);
  });
  it("is domain-separated: a mandate signature is not a valid approval or revocation", () => {
    expect(verifyJson("approval", body, sig, kp.publicKeyHex)).toBe(false);
    expect(verifyJson("revocation", body, sig, kp.publicKeyHex)).toBe(false);
  });
  it("returns false (not throw) on garbage", () => {
    expect(verifyJson("mandate", body, "zz", kp.publicKeyHex)).toBe(false);
    expect(verifyJson("mandate", body, sig, "00")).toBe(false);
  });
});

describe("mandate schema", () => {
  it("accepts the demo mandate", () => {
    expect(MandateBody.safeParse(demoMandate({ mandate_id: MID, owner_id: "o", now: NOW })).success).toBe(true);
  });
  it("rejects unknown fields, floats, and inverted validity", () => {
    const m = demoMandate({ mandate_id: MID, owner_id: "o", now: NOW });
    expect(MandateBody.safeParse({ ...m, extra: 1 }).success).toBe(false);
    expect(MandateBody.safeParse({ ...m, per_order_cap_cents: 10.5 }).success).toBe(false);
    expect(MandateBody.safeParse({ ...m, valid_until: m.valid_from }).success).toBe(false);
  });
});

describe("policy rules", () => {
  it("allows an honest in-scope order and prices it from the catalog", () => {
    const r = evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 2 }, { sku: "MILK-OAT-12", quantity: 1 }] }));
    expect(r.outcome).toBe("ALLOW");
    expect(r.reasons).toEqual([]);
    expect(r.total_cents).toBe(2 * 2400 + 3840);
  });

  it("G2: blocks a claimed price that differs from the catalog, and never uses the claim", () => {
    const r = evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1, claimed_unit_price_cents: 1 }] }));
    expect(r.outcome).toBe("BLOCK");
    expect(codes(r)).toContain("PRICE_MISMATCH");
    expect(r.total_cents).toBe(2400);
  });

  it("G2: blocks a relabelled category or merchant", () => {
    const r = evaluateRules(input({ lines: [{ sku: "MACH-ESP-2G", quantity: 1, claimed_category: "coffee", claimed_merchant: "x" }] }));
    expect(codes(r)).toEqual(expect.arrayContaining(["CATEGORY_MISMATCH", "MERCHANT_MISMATCH", "CATEGORY_NOT_ALLOWED", "PER_ORDER_CAP_EXCEEDED", "BUDGET_EXCEEDED"]));
  });

  it("G2: blocks any ship-to that differs from the mandate", () => {
    const r = evaluateRules(input({ ship_to: { ...DEMO_SHIP_TO, line1: "77 Harbor Rd" } }));
    expect(r.outcome).toBe("BLOCK");
    expect(codes(r)).toContain("ADDRESS_LOCK");
  });

  it("accepts the mandate address restated (case/spacing differences)", () => {
    const r = evaluateRules(input({ ship_to: { ...DEMO_SHIP_TO, line1: "418  alder street" } }));
    expect(r.outcome).toBe("ALLOW");
  });

  it("blocks the poisoned-listing order (50 units, other address)", () => {
    const r = evaluateRules(input({ lines: [{ sku: "SYRUP-VAN-750", quantity: 50 }], ship_to: { ...DEMO_SHIP_TO, line1: "77 Harbor Rd", city: "Newark", state: "NJ", postal_code: "07105" } }));
    expect(r.outcome).toBe("BLOCK");
    expect(codes(r)).toEqual(expect.arrayContaining(["QTY_PER_LINE_EXCEEDED", "QTY_PER_ORDER_EXCEEDED", "ADDRESS_LOCK"]));
  });

  it("blocks off-mandate merchants, unknown SKUs, duplicate lines and multi-merchant carts", () => {
    expect(codes(evaluateRules(input({ lines: [{ sku: "GIFT-500", quantity: 1 }] })))).toEqual(expect.arrayContaining(["MERCHANT_NOT_ALLOWED", "CATEGORY_NOT_ALLOWED"]));
    expect(codes(evaluateRules(input({ lines: [{ sku: "NOPE", quantity: 1 }] })))).toContain("UNKNOWN_SKU");
    expect(codes(evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }, { sku: "BEAN-ESP-1KG", quantity: 1 }] })))).toContain("DUPLICATE_LINE");
    expect(codes(evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }, { sku: "GIFT-500", quantity: 1 }] })))).toContain("MULTI_MERCHANT_CART");
  });

  it("blocks inactive SKUs", () => {
    const c = new Map(catalog);
    c.set("BEAN-ESP-1KG", { ...catalog.get("BEAN-ESP-1KG")!, active: false });
    expect(codes(evaluateRules(input({}, { catalog: c })))).toContain("SKU_INACTIVE");
  });

  it("budget: allows exactly up to the limit, blocks one cent over", () => {
    const limit = 40_000;
    expect(evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }] }, { periodSpentCents: limit - 2400 })).outcome).toBe("ALLOW");
    const r = evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }] }, { periodSpentCents: limit - 2399 }));
    expect(r.outcome).toBe("BLOCK");
    expect(codes(r)).toContain("BUDGET_EXCEEDED");
  });

  it("per-order cap and approval threshold", () => {
    expect(codes(evaluateRules(input({ lines: [{ sku: "CUP-12OZ-500", quantity: 5 }] })))).toContain("PER_ORDER_CAP_EXCEEDED"); // $270
    const held = evaluateRules(input({ lines: [{ sku: "CUP-12OZ-500", quantity: 3 }] })); // $162
    expect(held.outcome).toBe("HOLD");
    expect(codes(held)).toEqual(["OVER_APPROVAL_THRESHOLD"]);
    // threshold is inclusive-allow: exactly $150.00 is not "over"
    const atThreshold = evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 1 }] }, { mandate: mandateState({}, { approval_threshold_cents: 2400 }) }));
    expect(atThreshold.outcome).toBe("ALLOW");
  });

  it("G4: blocks bad signature, revoked, expired, not-yet-valid, wrong agent, missing consent", () => {
    expect(codes(evaluateRules(input({}, { mandate: mandateState({ signatureValid: false }) })))).toContain("SIGNATURE_INVALID");
    expect(codes(evaluateRules(input({}, { mandate: mandateState({ revoked: true }) })))).toContain("MANDATE_REVOKED");
    expect(codes(evaluateRules(input({}, { now: new Date(NOW.getTime() + 31 * 86_400_000) })))).toContain("MANDATE_EXPIRED");
    expect(codes(evaluateRules(input({}, { now: new Date(NOW.getTime() - 3_600_000) })))).toContain("MANDATE_NOT_YET_VALID");
    expect(codes(evaluateRules(input({}, { agentId: "other-agent" })))).toContain("AGENT_NOT_AUTHORIZED");
    expect(codes(evaluateRules(input({}, { mandate: mandateState({ paymentConsent: false }) })))).toContain("PAYMENT_CONSENT_MISSING");
    expect(evaluateRules(input({}, { mandate: null })).outcome).toBe("BLOCK");
  });

  it("duplicate cart within window is held for a human", () => {
    const r = evaluateRules(input({}, { duplicateOfRecent: true }));
    expect(r.outcome).toBe("HOLD");
    expect(codes(r)).toEqual(["DUPLICATE_SUSPECTED"]);
  });

  it("cart hash ignores agent claims and line order", () => {
    const a = evaluateRules(input({ lines: [{ sku: "BEAN-ESP-1KG", quantity: 2 }, { sku: "MILK-OAT-12", quantity: 1 }] }));
    const b = evaluateRules(input({ lines: [{ sku: "MILK-OAT-12", quantity: 1 }, { sku: "BEAN-ESP-1KG", quantity: 2, claimed_unit_price_cents: 2400 }] }));
    expect(a.cart_hash).toBe(b.cart_hash);
  });
});

describe("G3: LLM verdict can only tighten", () => {
  const outcomes: Outcome[] = ["ALLOW", "HOLD", "BLOCK"];
  const verdicts: IntentVerdict[] = [
    { kind: "not_configured" },
    { kind: "skipped" },
    { kind: "consistent", rationale: "fine" },
    { kind: "suspicious", rationale: "off-intent" },
    { kind: "error", error: "timeout" },
  ];
  const rank = { ALLOW: 0, HOLD: 1, BLOCK: 2 } as const;
  for (const o of outcomes)
    for (const v of verdicts)
      it(`rules=${o} + llm=${v.kind} is never looser than ${o}`, () => {
        const r = combine({ outcome: o, reasons: [] }, v);
        expect(rank[r.outcome]).toBeGreaterThanOrEqual(rank[o]);
        if (v.kind === "suspicious" || v.kind === "error") expect(rank[r.outcome]).toBeGreaterThanOrEqual(rank.HOLD);
        if (v.kind === "consistent" || v.kind === "not_configured" || v.kind === "skipped") expect(r.outcome).toBe(o);
      });
});

describe("G7: ledger hash chain", () => {
  function build(n: number): StoredLedgerEntry[] {
    const out: StoredLedgerEntry[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const e = { seq: i, ts: `2026-11-12T12:00:0${i}Z`, type: "decision", data: { n: i, outcome: "ALLOW" } };
      const hash = ledgerHash(prev, e);
      out.push({ ...e, prev_hash: prev, hash });
      prev = hash;
    }
    return out;
  }
  it("verifies an intact chain", () => {
    expect(verifyChain(build(5))).toMatchObject({ ok: true, count: 5 });
  });
  it("detects an edited entry", () => {
    const c = build(5);
    c[2] = { ...c[2]!, data: { n: 3, outcome: "BLOCK" } };
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
  it("detects a deleted entry", () => {
    const c = build(5);
    c.splice(1, 1);
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
  it("detects a re-hashed edit (attacker recomputes that entry's hash) at the next entry", () => {
    const c = build(5);
    const edited = { ...c[1]!, data: { n: 2, outcome: "BLOCK" } };
    edited.hash = ledgerHash(edited.prev_hash, edited);
    c[1] = edited;
    expect(verifyChain(c)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
});
