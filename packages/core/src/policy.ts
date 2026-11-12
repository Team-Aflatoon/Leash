import { canonicalize } from "./canonical.ts";
import type { Address, CatalogItem, MandateBody, Proposal } from "./schemas.ts";

export type Outcome = "ALLOW" | "HOLD" | "BLOCK";
const RANK: Record<Outcome, number> = { ALLOW: 0, HOLD: 1, BLOCK: 2 };

export function stricter(a: Outcome, b: Outcome): Outcome {
  return RANK[a] >= RANK[b] ? a : b;
}

export type ReasonCode =
  // mandate state
  | "MANDATE_NOT_FOUND"
  | "SIGNATURE_INVALID"
  | "MANDATE_REVOKED"
  | "MANDATE_NOT_YET_VALID"
  | "MANDATE_EXPIRED"
  | "AGENT_NOT_AUTHORIZED"
  | "PAYMENT_CONSENT_MISSING"
  | "PAYMENT_HOLD_EXHAUSTED"
  // cart resolution
  | "UNKNOWN_SKU"
  | "SKU_INACTIVE"
  | "DUPLICATE_LINE"
  | "MULTI_MERCHANT_CART"
  | "CURRENCY_MISMATCH"
  // mandate scope
  | "CATEGORY_NOT_ALLOWED"
  | "MERCHANT_NOT_ALLOWED"
  | "QTY_PER_LINE_EXCEEDED"
  | "QTY_PER_ORDER_EXCEEDED"
  | "ADDRESS_LOCK"
  | "PER_ORDER_CAP_EXCEEDED"
  | "BUDGET_EXCEEDED"
  // tampering
  | "PRICE_MISMATCH"
  | "CATEGORY_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "MALFORMED_REQUEST"
  // escalations
  | "OVER_APPROVAL_THRESHOLD"
  | "DUPLICATE_SUSPECTED"
  | "INTENT_MISMATCH"
  | "INTENT_CHECK_UNAVAILABLE";

export interface Reason {
  code: ReasonCode;
  outcome: Outcome;
  message: string;
  source: "rules" | "llm";
}

export interface MandateState {
  body: MandateBody;
  signatureValid: boolean;
  revoked: boolean;
  /** True once the owner has given PayPal consent (vaulted payment method) for this mandate. */
  paymentConsent: boolean;
}

export interface ResolvedLine {
  sku: string;
  title: string;
  category: string;
  merchant_id: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface RuleInput {
  now: Date;
  agentId: string;
  mandate: MandateState | null;
  proposal: Proposal;
  catalog: ReadonlyMap<string, CatalogItem>;
  /** Spend already committed in this budget period (authorized, pending or captured), from the database. */
  periodSpentCents: number;
  /** Another proposal with the same cart hash was decided ALLOW/HOLD in the duplicate window. */
  duplicateOfRecent: boolean;
  /** When paid from the owner's standing PayPal hold: what is left of it (cents). Null when paid from a vaulted wallet. */
  fundingRemainingCents?: number | null;
}

export interface RuleResult {
  outcome: Outcome;
  reasons: Reason[];
  lines: ResolvedLine[];
  total_cents: number;
  merchant_id: string | null;
  /** Hash of (mandate, merchant, sku+qty lines) used for duplicate detection. Agent claims are excluded. */
  cart_hash: string | null;
}

const rule = (code: ReasonCode, outcome: Outcome, message: string): Reason => ({ code, outcome, message, source: "rules" });

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

function sameAddress(a: Address, b: Address): boolean {
  const norm = (x: Address) => canonicalize({ ...x, line2: x.line2 ?? "" }).toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/** First day of the UTC calendar month containing `now`. Budget period boundaries. */
export function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The deterministic policy. Pure: same input, same output. Collects every violated rule (rather than stopping at
 * the first) so the owner sees the full picture of what an attack tried.
 */
export function evaluateRules(input: RuleInput): RuleResult {
  const reasons: Reason[] = [];
  const { mandate, proposal, catalog, now } = input;
  const lines: ResolvedLine[] = [];

  // --- mandate state -------------------------------------------------------------------------------------------
  if (!mandate) {
    reasons.push(rule("MANDATE_NOT_FOUND", "BLOCK", "No mandate with this id."));
    return { outcome: "BLOCK", reasons, lines, total_cents: 0, merchant_id: null, cart_hash: null };
  }
  const m = mandate.body;
  if (!mandate.signatureValid) reasons.push(rule("SIGNATURE_INVALID", "BLOCK", "Mandate signature does not verify against the owner's key."));
  if (mandate.revoked) reasons.push(rule("MANDATE_REVOKED", "BLOCK", "The owner revoked this mandate."));
  if (now.getTime() < Date.parse(m.valid_from)) reasons.push(rule("MANDATE_NOT_YET_VALID", "BLOCK", `Mandate starts ${m.valid_from}.`));
  if (now.getTime() >= Date.parse(m.valid_until)) reasons.push(rule("MANDATE_EXPIRED", "BLOCK", `Mandate expired ${m.valid_until}.`));
  if (m.agent_id !== input.agentId) reasons.push(rule("AGENT_NOT_AUTHORIZED", "BLOCK", "This agent is not the one named in the mandate."));
  if (!mandate.paymentConsent) reasons.push(rule("PAYMENT_CONSENT_MISSING", "BLOCK", "Owner has not linked a PayPal payment method to this mandate."));

  // --- resolve the cart from the catalog (never from agent claims) ---------------------------------------------
  const seen = new Set<string>();
  for (const pl of proposal.lines) {
    if (seen.has(pl.sku)) {
      reasons.push(rule("DUPLICATE_LINE", "BLOCK", `SKU ${pl.sku} appears twice in one cart.`));
      continue;
    }
    seen.add(pl.sku);
    const item = catalog.get(pl.sku);
    if (!item) {
      reasons.push(rule("UNKNOWN_SKU", "BLOCK", `SKU ${pl.sku} is not in the catalog.`));
      continue;
    }
    if (!item.active) reasons.push(rule("SKU_INACTIVE", "BLOCK", `${item.title} is not for sale.`));
    if (item.currency !== m.currency) reasons.push(rule("CURRENCY_MISMATCH", "BLOCK", `${item.title} is priced in ${item.currency}.`));
    if (pl.claimed_unit_price_cents !== undefined && pl.claimed_unit_price_cents !== item.unit_price_cents)
      reasons.push(rule("PRICE_MISMATCH", "BLOCK", `Agent claimed ${fmt(pl.claimed_unit_price_cents)} for ${item.title}; catalog price is ${fmt(item.unit_price_cents)}.`));
    if (pl.claimed_category !== undefined && pl.claimed_category !== item.category)
      reasons.push(rule("CATEGORY_MISMATCH", "BLOCK", `Agent labelled ${item.title} as "${pl.claimed_category}"; catalog category is "${item.category}".`));
    if (pl.claimed_merchant !== undefined && pl.claimed_merchant !== item.merchant_id)
      reasons.push(rule("MERCHANT_MISMATCH", "BLOCK", `Agent named merchant "${pl.claimed_merchant}"; catalog merchant is "${item.merchant_id}".`));
    if (!m.allowed_categories.includes(item.category))
      reasons.push(rule("CATEGORY_NOT_ALLOWED", "BLOCK", `Category "${item.category}" (${item.title}) is outside the mandate.`));
    if (!m.allowed_merchants.includes(item.merchant_id))
      reasons.push(rule("MERCHANT_NOT_ALLOWED", "BLOCK", `Merchant "${item.merchant_id}" is outside the mandate.`));
    if (pl.quantity > m.max_units_per_line)
      reasons.push(rule("QTY_PER_LINE_EXCEEDED", "BLOCK", `${pl.quantity} × ${item.title} exceeds the per-item limit of ${m.max_units_per_line}.`));
    lines.push({
      sku: item.sku,
      title: item.title,
      category: item.category,
      merchant_id: item.merchant_id,
      quantity: pl.quantity,
      unit_price_cents: item.unit_price_cents,
      line_total_cents: item.unit_price_cents * pl.quantity,
    });
  }

  const units = proposal.lines.reduce((s, l) => s + l.quantity, 0);
  if (units > m.max_units_per_order) reasons.push(rule("QTY_PER_ORDER_EXCEEDED", "BLOCK", `${units} units exceeds the per-order limit of ${m.max_units_per_order}.`));

  const merchants = new Set(lines.map((l) => l.merchant_id));
  if (merchants.size > 1) reasons.push(rule("MULTI_MERCHANT_CART", "BLOCK", "One order may pay one merchant."));
  const merchant_id = merchants.size === 1 ? [...merchants][0]! : null;

  // SAFETY: the agent can never choose where goods go. Orders always ship to the mandate's address; an agent that
  // tries to set a different one is treated as compromised.
  if (proposal.ship_to && !sameAddress(proposal.ship_to, m.ship_to))
    reasons.push(rule("ADDRESS_LOCK", "BLOCK", `Agent tried to ship to "${proposal.ship_to.line1}, ${proposal.ship_to.city}"; the mandate locks delivery to "${m.ship_to.line1}, ${m.ship_to.city}".`));

  const total = lines.reduce((s, l) => s + l.line_total_cents, 0);
  if (!Number.isSafeInteger(total)) throw new Error("cart total overflow");
  if (total > m.per_order_cap_cents) reasons.push(rule("PER_ORDER_CAP_EXCEEDED", "BLOCK", `Order total ${fmt(total)} exceeds the per-order cap of ${fmt(m.per_order_cap_cents)}.`));
  if (input.fundingRemainingCents !== undefined && input.fundingRemainingCents !== null && total > input.fundingRemainingCents)
    reasons.push(rule("PAYMENT_HOLD_EXHAUSTED", "BLOCK", `Order total ${fmt(total)} is more than the ${fmt(Math.max(0, input.fundingRemainingCents))} left on your PayPal hold.`));
  if (input.periodSpentCents + total > m.budget.limit_cents)
    reasons.push(
      rule("BUDGET_EXCEEDED", "BLOCK", `Order total ${fmt(total)} with ${fmt(input.periodSpentCents)} already committed this month exceeds the ${fmt(m.budget.limit_cents)} budget.`),
    );

  // --- escalations (only matter if nothing blocked) ------------------------------------------------------------
  if (total > m.approval_threshold_cents) reasons.push(rule("OVER_APPROVAL_THRESHOLD", "HOLD", `Order total ${fmt(total)} is over the ${fmt(m.approval_threshold_cents)} approval threshold.`));
  if (input.duplicateOfRecent) reasons.push(rule("DUPLICATE_SUSPECTED", "HOLD", "An identical cart was already ordered in the last 24 hours."));

  const outcome = reasons.reduce<Outcome>((o, r) => stricter(o, r.outcome), "ALLOW");
  const cart_hash = lines.length
    ? canonicalize({ mandate_id: m.mandate_id, merchant_id, lines: [...lines].sort((a, b) => (a.sku < b.sku ? -1 : 1)).map((l) => [l.sku, l.quantity]) })
    : null;
  return { outcome, reasons, lines, total_cents: total, merchant_id, cart_hash };
}

export type IntentVerdict =
  | { kind: "not_configured" }
  /** Rules already blocked, so the LLM was not consulted. */
  | { kind: "skipped" }
  | { kind: "consistent"; rationale: string; cached?: boolean }
  | { kind: "suspicious"; rationale: string }
  | { kind: "error"; error: string };

/**
 * Combine the rules' outcome with the LLM's intent verdict.
 *
 * SAFETY (G3): the result is never less strict than `rules.outcome`. The LLM can only add a HOLD reason.
 */
export function combine(rules: { outcome: Outcome; reasons: Reason[] }, verdict: IntentVerdict): { outcome: Outcome; reasons: Reason[] } {
  const reasons = [...rules.reasons];
  if (verdict.kind === "suspicious")
    reasons.push({ code: "INTENT_MISMATCH", outcome: "HOLD", message: verdict.rationale, source: "llm" });
  if (verdict.kind === "error")
    reasons.push({ code: "INTENT_CHECK_UNAVAILABLE", outcome: "HOLD", message: `Intent check failed (${verdict.error}); holding for a human.`, source: "llm" });
  const outcome = reasons.reduce<Outcome>((o, r) => stricter(o, r.outcome), rules.outcome);
  return { outcome, reasons };
}
