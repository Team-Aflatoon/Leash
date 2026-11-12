# Leash — project notes for Claude sessions

PayPal AI Hackathon 2026 entry. A gateway between an AI shopping agent and PayPal: the agent proposes, signed
owner limits + deterministic rules decide, PayPal sandbox moves the money. Product concept: `docs/SPEC.md`.
Status and next steps: `PROGRESS.md`. Why things are the way they are: `docs/DECISIONS.md`.

## Layout
- `packages/core` — pure domain: JCS canonical JSON, Ed25519 (`@noble/curves`), zod schemas, policy rules,
  `combine()` (LLM can only tighten), ledger hash chain, demo catalog/mandate.
- `apps/gateway` — Fastify + Postgres. Only process with DB / PayPal / signing secrets. `service.ts` is the
  decision + payment state machine; `jobs.ts` the Postgres job worker; `paypal.ts` the sandbox REST provider.
- `apps/agent` — HTTP-only agent: `redteam.ts` (scripted compromised agent), `shopper.ts` (live Claude agent).
  Spawned as a child process by `apps/gateway/src/redteam.ts` with an allowlisted env.
- `apps/console` — Vite + React + AG Grid owner console (served by the gateway from `apps/console/dist`).

## Commands
- `pnpm db:start` — local Postgres cluster in `.pgdata` on port 54329 (uses `C:\Program Files\PostgreSQL\17\bin`).
- `pnpm test` — all tests (needs the local DB). `pnpm typecheck`. `pnpm test:sandbox` with PayPal creds.
- `pnpm --filter @leash/gateway spike` — real-sandbox Day-1 spike (needs a human to approve one PayPal page).
- Dev server: `DATABASE_URL=postgres://postgres@127.0.0.1:54329/leash pnpm dev`.

## Invariants — never break these
- Money is integer cents. No floats (canonicalize throws on them).
- The agent never gets DATABASE_URL, PayPal creds or the signing key (`agentEnv` allowlist + import test).
- Rules decide; `combine()` is the only place LLM verdicts touch outcomes and it can only raise severity.
- Every PayPal mutation carries a deterministic `PayPal-Request-Id` (`leash-<paymentId>-<op>`).
- Lock mandates/payments with `FOR NO KEY UPDATE`; `appendLedger` is the last statement of a transaction
  (DECISIONS D10 — a deadlock happened when this was violated).
- No fake payment provider outside `apps/gateway/test/`. Without creds the server uses a refusing provider.
- Agent tokens are per-run and scoped to one mandate (`mintAgentToken`); the ledger carries no PII (`ownerRef`).
- Each security claim has a test (map in `docs/SECURITY.md`, review fixes in `docs/REVIEW.md`). If you change a guard, run the suite and the
  mutation checks in `scripts/mutation-check.sh`.

## Conventions
- External API facts go in `docs/PAYPAL_FACTS.md` with the official URL. Real sandbox runs log to
  `docs/SANDBOX_LOG.md`.
- Commit per milestone, tests green first. Co-author trailer per the session's attribution rule.
