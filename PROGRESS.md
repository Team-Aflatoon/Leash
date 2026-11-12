# Progress

Last updated: 2026-11-12. Local repo only; no remote yet.

## Status by milestone

| M | Scope | State |
|---|-------|-------|
| M0 | Scaffold, local DB script, CI, license | done |
| M1 | Core: canonical JSON, Ed25519, schemas, policy, combine, ledger chain | done |
| M2 | Gateway: decisions, reservations, idempotency, payments state machine, jobs, ledger, webhooks | done |
| M3 | PayPal sandbox provider, spike + webhook-registration scripts, contract test | **verified in the real sandbox**. Vault is refused by PayPal for our merchant, so Plan B (standing hold + partial captures) is used automatically (D13) |
| M4 | LLM intent check, drafter and live agent; Gemini (default) and Claude adapters | **Gemini verified live**; Claude adapter untested (no key) |
| M5 | Scripted red team, agent child process with per-run scoped token, demo endpoints | done |
| M6 | Owner console (React + AG Grid) | redesigned (Hallmark Console theme) and checked in a browser at 1440 and 390 wide |
| M7 | Deploy files, docs, mutation checks, adversarial review + fixes | done (docs/REVIEW.md) |

## Verified
- `pnpm typecheck` clean; `pnpm test`: 119 tests across 5 files (core, gateway integration on real Postgres, review
  regressions, PayPal client, agent/red team).
- `bash scripts/mutation-check.sh`: 18 of 18 mutants killed.
- Adversarial review: 13 findings (4 high). 12 fixed with regression tests; R8 (process isolation) documented as a
  limit, with a separate agent LLM key supported.
- `npx tsx scripts/smoke.ts` against the real `main.ts` (no credentials): the red team runs through the spawned agent
  process with a minted token, and all 5 attacks are blocked. The honest order is blocked with
  PAYMENT_CONSENT_MISSING, as expected without a linked wallet. Ledger chain verifies.

- `docker build` succeeds; the container serves the console, and inside it the red team spawns the agent as the non-root `node` user (smoke: 5/5 attacks blocked).
- Console checked in a browser at 1440 and 390 wide. This found a red-team accounting bug, now fixed. All six screens are redesigned with the Hallmark Console theme; sloplint reports 0 FAIL. Browser flows checked: create key, sign a mandate, revoke with inline confirm, run the red team, read the decisions and ledger.
- GitHub: https://github.com/Team-Aflatoon/Leash (private), CI green.

- **Real end to end (2026-11-12):** owner linked PayPal through the hold (buyer approval once, $2,000). Red team: 6/6, with the honest $86.40 and the burst $108 captured at PayPal (checked via GET /v2/payments/captures: COMPLETED, invoice = our payment id). Live Gemini agent: blocked at $254.70 (over cap and budget), then two allowed orders ($148.80, $9.75) captured; it did not follow the poisoned listing.
- 119 tests; `bash scripts/mutation-check.sh`: 18 of 18 mutants killed (incl. Plan B hold limit and in-doubt capture).

## Not verified yet
- Webhook verification with real PayPal events (needs a public URL: deploy first).
- Claude adapter against the real API (no Anthropic key; Gemini is the default).
- Gemini free tier is often overloaded (503/429): checks fail closed to HOLD; the red-team verdict cache keeps demo runs stable once warmed.

## Next steps
1. With sandbox credentials: run the spike. If P4 (no-redirect vaulted authorize) fails, implement the fallback in
   docs/PLAN.md (per-order buyer approval) behind the same `PaymentProvider` interface.
2. With an LLM key: one red-team run (warms the verdict cache), then check that the honest scenario gets `consistent`.
3. Deploy on Render, set the env vars, register the webhook, link PayPal once on the hosted demo, run the red team
   once to warm the verdict cache, fill in the README placeholders, record the video.
