# Progress

Last updated: 2026-11-12.

## Status by milestone

| M | Scope | State |
|---|-------|-------|
| M0 | Scaffold, local DB script, CI, license | done |
| M1 | Core: canonical JSON, Ed25519, schemas, policy, combine, ledger chain | done |
| M2 | Gateway: decisions, reservations, idempotency, payments state machine, jobs, ledger, webhooks | done |
| M3 | PayPal sandbox provider, spike + webhook-registration scripts, contract test | code done. **Not yet run against the real sandbox (no credentials yet)** |
| M4 | Claude intent check (cached, fail-closed), mandate drafter, live tool-runner agent | code done. **Not yet run against the real API (no key yet)** |
| M5 | Scripted red team, agent child process, demo endpoints | done (6/6 against the fake provider in tests) |
| M6 | Owner console (React + AG Grid) | builds and is served by the gateway. **Not visually checked in a browser yet** |
| M7 | Deploy files, docs, mutation checks, adversarial review | deploy files and docs done. Mutation 11/11. Review: see below |

## Verified
- `pnpm test`: 88 tests across 4 files (core, gateway integration on real Postgres, PayPal client, agent/red team).
- `bash scripts/mutation-check.sh`: 11 of 11 mutants killed.
- Concurrency suites repeated 3×, with no deadlocks after the D10 fix.
- The server boots with no credentials and serves the console and API.

## Not verified yet (needs the user)
- Real PayPal sandbox: `pnpm --filter @leash/gateway spike` (P4/P5/P9 in docs/PAYPAL_FACTS.md are docs-only until then).
- Claude API calls (drafter, intent check, live agent).
- `docker build`: the Docker daemon was not running locally. Render or CI will build it.
- Visual check of the console in a browser.

## Next steps
1. With sandbox credentials: run the spike. If P4 (no-redirect vaulted authorize) fails, implement the fallback in
   docs/PLAN.md (per-order buyer approval) behind the same `PaymentProvider` interface.
2. With an LLM key: do one live red-team run (warms the verdict cache), then check that the honest scenario gets
   `consistent`.
3. Deploy to Render, register the webhook, fill in the README placeholders, record the video.
