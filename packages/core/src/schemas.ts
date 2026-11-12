import { z } from "zod";

const cents = z.number().int().nonnegative().max(100_000_000);
const isoDate = z.iso.datetime({ offset: false });
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const Address = z
  .object({
    name: shortText(120),
    line1: shortText(200),
    line2: z.string().trim().max(200).optional(),
    city: shortText(120),
    state: z.string().trim().max(60),
    postal_code: shortText(20),
    country_code: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
export type Address = z.infer<typeof Address>;

/** The structured mandate the owner signs. Every field the gateway enforces lives here. */
export const MandateBody = z
  .object({
    v: z.literal(1),
    mandate_id: z.uuid(),
    owner_id: shortText(64),
    agent_id: shortText(64),
    intent: shortText(1000),
    currency: z.literal("USD"),
    budget: z.object({ period: z.literal("month"), limit_cents: cents.min(1) }).strict(),
    per_order_cap_cents: cents.min(1),
    approval_threshold_cents: cents,
    allowed_categories: z.array(shortText(60)).min(1).max(50),
    allowed_merchants: z.array(shortText(60)).min(1).max(20),
    max_units_per_line: z.number().int().min(1).max(1000),
    max_units_per_order: z.number().int().min(1).max(10_000),
    ship_to: Address,
    valid_from: isoDate,
    valid_until: isoDate,
    issued_at: isoDate,
  })
  .strict()
  .refine((m) => Date.parse(m.valid_until) > Date.parse(m.valid_from), { message: "valid_until must be after valid_from" })
  .refine((m) => m.per_order_cap_cents <= m.budget.limit_cents, { message: "per-order cap exceeds budget" });
export type MandateBody = z.infer<typeof MandateBody>;

/** What the agent is allowed to send. Everything in here is untrusted. */
export const ProposalLine = z
  .object({
    sku: shortText(64),
    quantity: z.number().int().min(1).max(1_000_000),
    // Claims are optional and never used to price anything. If present they are compared to the catalog and a
    // mismatch is treated as tampering.
    claimed_unit_price_cents: cents.optional(),
    claimed_category: z.string().max(60).optional(),
    claimed_merchant: z.string().max(60).optional(),
  })
  .strict();
export type ProposalLine = z.infer<typeof ProposalLine>;

export const Proposal = z
  .object({
    mandate_id: z.uuid(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
    lines: z.array(ProposalLine).min(1).max(50),
    ship_to: Address.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

export const ApprovalStatement = z
  .object({
    payment_id: z.uuid(),
    decision: z.enum(["approve", "reject"]),
    signed_at: isoDate,
  })
  .strict();
export type ApprovalStatement = z.infer<typeof ApprovalStatement>;

export const RevocationStatement = z
  .object({
    mandate_id: z.uuid(),
    revoked_at: isoDate,
  })
  .strict();
export type RevocationStatement = z.infer<typeof RevocationStatement>;

/** Signed by the owner for console actions that change state but aren't mandates/approvals/revocations. */
export const OwnerAction = z
  .object({
    owner_id: shortText(64),
    action: z.enum(["paypal-link", "demo-reset", "redteam-run"]),
    target: z.string().max(64).optional(),
    signed_at: isoDate,
  })
  .strict();
export type OwnerAction = z.infer<typeof OwnerAction>;

export interface CatalogItem {
  sku: string;
  title: string;
  category: string;
  merchant_id: string;
  unit_price_cents: number;
  currency: "USD";
  active: boolean;
  /** Untrusted merchant-supplied text. May contain prompt injection. Never used by the rules. */
  description: string;
}
