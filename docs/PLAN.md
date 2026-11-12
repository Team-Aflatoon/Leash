# Plan

Milestones are built in order. Each ends with tests green and a commit. Payment correctness and the security
guarantees are never cut; polish and docs are cut first.

| M | Scope | Done when |
|---|-------|-----------|
| M0 | Monorepo scaffold, local Postgres script, CI workflow, license | `pnpm test` runs, CI file present |
| M1 | `packages/core`: JCS canonical JSON, Ed25519 sign/verify, mandate schema, policy engine (pure), decision combinator, ledger hash | Unit tests for every rule and the combinator |
| M2 | Gateway: migrations, catalog fixture, mandates (register/sign/revoke), proposals → decision → reservation, ledger (append-only, hash chain, signed checkpoints), PaymentProvider interface | Integration tests on real Postgres: replay, idempotency conflict, duplicate, 50-way concurrency budget test, revocation, tamper detection |
| M3 | PayPal sandbox provider: OAuth, Vault setup/payment tokens, orders (AUTHORIZE), capture, void, webhook verify + reconcile, jobs (approval timeout, stuck-payment recovery) | Contract test against real sandbox (runs when creds present); unit tests with fake provider |
| M4 | LLM: mandate drafting, intent check (cached), shopping agent (tool use, HTTP only) | Schema-validated outputs; combinator tests; agent isolation test |
| M5 | Red-team runner + demo reset endpoint | Runner test: same outcomes on two consecutive runs |
| M6 | Owner console (React + AG Grid): mandate wizard + signing, red-team view, approvals, spend vs budget, ledger verify | Builds; served by gateway |
| M7 | Dockerfile, render.yaml, README, SECURITY.md, Devpost text, video script, checklist; adversarial review + fixes | Review findings fixed or documented |

## Payment flow (to confirm with real sandbox calls in M3)

Primary: at mandate signing the owner approves a **PayPal Vault setup token** once (one redirect). The gateway
exchanges it for a payment token. Each purchase is a merchant-initiated order with `intent: AUTHORIZE` and
`payment_source.paypal.vault_id` → authorization without a redirect → capture (ALLOW) or hold (HOLD) → capture on
approval, void on reject/timeout.

Fallback if the sandbox app can't vault: each purchase creates an AUTHORIZE order and the owner approves it in
PayPal (redirect per purchase). Rules and holds stay identical; only consent UX changes.

## Test strategy

- Pure core: exhaustive unit tests (vitest).
- Gateway: integration tests against a real Postgres (local cluster via `scripts/dev-db.sh`, CI service
  container). Fake PayPal provider **only** in tests.
- Security claim → test map in `docs/SECURITY.md`; each test must fail if its claim breaks (checked by mutating the
  guard once during development).
- Real sandbox contract test (`pnpm test:sandbox`) when credentials are present.
