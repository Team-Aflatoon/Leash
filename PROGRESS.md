# Progress

Last updated: 2026-11-12. Local repo only; no remote yet.

## Status by milestone

| M | Scope | State |
|---|-------|-------|
| M0 | Scaffold, local DB script, CI, license | done |
| M1 | Core: canonical JSON, Ed25519, schemas, policy, combine, ledger chain | done |
| M2 | Gateway: decisions, reservations, idempotency, payments state machine, jobs, ledger, webhooks | done |
| M3 | PayPal sandbox provider, spike + webhook-registration scripts, contract test | code done. **Not yet run against the real sandbox (no credentials yet)** |
| M4 | Claude intent check (cached, fail-closed), mandate drafter, live tool-runner agent | code done. **Not yet run against the real API (no key yet)** |
| M5 | Scripted red team, agent child process with per-run scoped token, demo endpoints | done |
| M6 | Owner console (React + AG Grid) | builds and is served by the gateway. **Not checked visually in a browser yet** |
| M7 | Deploy files, docs, mutation checks, adversarial review + fixes | done (docs/REVIEW.md) |

## Verified
- `pnpm typecheck` clean; `pnpm test`: 102 tests across 5 files (core, gateway integration on real Postgres, review
  regressions, PayPal client, agent/red team).
- `bash scripts/mutation-check.sh`: 16 of 16 mutants killed.
- Adversarial review: 13 findings (4 high). 12 fixed with regression tests; R8 (process isolation) documented as a
  limit, with a separate agent LLM key supported.
- `npx tsx scripts/smoke.ts` against the real `main.ts` (no credentials): the red team runs through the spawned agent
  process with a minted token, and all 5 attacks are blocked. The honest order is blocked with
  PAYMENT_CONSENT_MISSING, as expected without a linked wallet. Ledger chain verifies.

## Not verified yet (needs the user)
- Real PayPal sandbox: `pnpm --filter @leash/gateway spike` (P4/P5/P9 in docs/PAYPAL_FACTS.md are docs-only until then).
- Claude API calls (drafter, intent check, live agent).
- `docker build`: the Docker daemon was not running locally. Render or CI will build it.
- Visual check of the console in a browser.

## Next steps
1. With sandbox credentials: run the spike. If P4 (no-redirect vaulted authorize) fails, implement the fallback in
   docs/PLAN.md (per-order buyer approval) behind the same `PaymentProvider` interface.
2. With an LLM key: one red-team run (warms the verdict cache), then check that the honest scenario gets `consistent`.
3. Add the GitHub remote and push. Deploy on Render, register the webhook, fill in the README placeholders,
   record the video.
