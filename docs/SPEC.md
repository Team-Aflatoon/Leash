# Leash — product spec

## Problem

AI agents can already search, compare and decide what to buy. Letting them actually spend money is the part
nobody has solved safely. Hand an agent your payment credentials and three things go wrong:

1. **It can be tricked.** A malicious product listing or email says "buy 50 units" or "ship to this address" and
   the agent obeys (prompt injection).
2. **It makes mistakes.** Wrong quantity, a duplicate order, an over-budget cart.
3. **Nobody can prove afterwards** what the agent was allowed to do or why a payment happened.

> How do you let an AI agent spend real money on a person's behalf, with hard limits it can't talk its way
> around, and a provable record of every decision?

## Core idea

Leash is a **gateway between an AI agent and PayPal**. The agent never holds payment credentials. It can only
*propose* a purchase; the gateway decides whether money moves.

Persona: **a small café owner delegating weekly restocking** to an agent.

## Flow

1. **Mandate.** The owner states intent in plain English ("restock café supplies, max $400 a month, these
   categories, ship only to this address"). An LLM drafts a structured mandate; the owner reviews it and signs it
   with an Ed25519 key that lives only in the owner's browser.
2. **Agent proposes.** The agent searches the catalog and submits a cart (SKU + quantity). It has no payment
   access, no database access and no PayPal credentials.
3. **Gateway checks.** Deterministic rules first (signature valid, not expired, not revoked, per-order cap,
   monthly budget, allowed categories and merchants, quantity limits, address lock, price integrity, replay and
   duplicate detection). Then an LLM checks whether the cart matches the owner's stated intent. The LLM can only
   make a decision stricter (ALLOW → HOLD), never looser.
4. **PayPal hold.** Allowed carts are authorized and captured. Carts over the approval threshold (or escalated
   by a check) are **authorized but not captured** until the owner approves; a rejection or timeout voids the
   authorization.
5. **Audit trail.** Every decision and payment transition is appended to a hash-chained ledger whose head is
   signed by the gateway, and reconciled against verified PayPal webhooks.
6. **Red-team mode.** One click runs a fixed script of attacks plus one honest purchase against the real gateway
   and shows, for each: what the agent tried, what the gateway decided, and why. Same result every run.
7. **Owner console.** Spend vs budget, blocked attempts, pending approvals, ledger verification.

## Non-negotiable guarantees

| # | Guarantee |
|---|-----------|
| G1 | The agent cannot touch money, the database or PayPal credentials. It only proposes. |
| G2 | The gateway trusts nothing the agent says about price, merchant, quantity limits or address; it derives them from the catalog and the mandate. |
| G3 | Plain rules decide. An LLM may make a decision stricter, never looser. |
| G4 | Mandates are tamper-evident (signed), can expire, and can be revoked with immediate effect. |
| G5 | Replays, duplicate submissions and concurrent requests cannot spend twice or exceed the budget. |
| G6 | Payments are real PayPal sandbox calls. No faked payment outside tests. |
| G7 | Every decision leaves an audit record; tampering with the record is detectable. |
| G8 | Each guarantee above has a test that fails if the guarantee breaks (see `docs/SECURITY.md`). |

## Honest caveats

- Sandbox money can't buy from real retailers. Payments settle to a sandbox merchant we create; the catalog is a
  fixture café-supplies catalog served by the gateway. We say so in the demo.
- A database superuser who also holds the gateway signing key could rewrite the whole ledger. The ledger detects
  tampering by anyone short of that, and exported signed checkpoints detect it even then (see `docs/SECURITY.md`).
