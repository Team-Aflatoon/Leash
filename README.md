# Leash: a spending gateway for AI agents

**Let an AI agent spend real money for you, inside limits it can't talk its way around, with a provable record of
every decision.**

Leash sits between a shopping agent and PayPal. The agent never holds payment credentials. It can only *propose*
a purchase. The gateway checks the proposal against a mandate the owner signed with their own key, decides
ALLOW, HOLD or BLOCK with plain deterministic rules, and only then moves money through the PayPal sandbox.

- **Live demo:** `<DEMO_URL>`. Click **Run red team**.
- **Video (< 3 min):** `<VIDEO_URL>`
- **License:** MIT

> Sandbox only. No real money moves. Payments settle to a sandbox merchant we created, and the catalog is a fixture
> café-supplies catalog.

## What it does

1. **Mandate.** The owner writes their intent in plain English ("restock café supplies, max $400 a month, ask me
   above $150, ship only to the café"). Claude drafts structured fields, the owner reviews them, and the browser
   signs the exact JSON with an Ed25519 key that never leaves the browser.
2. **One-time PayPal consent.** The owner approves PayPal Vault once. The gateway receives a token for
   merchant-initiated payments. The agent never sees it.
3. **Agent proposes.** The agent searches the catalog and submits SKUs and quantities over HTTP.
4. **Gateway decides.** Deterministic rules run first: signature, expiry, revocation, categories, merchants,
   quantity limits, address lock, catalog price, per-order cap, monthly budget, replay and duplicate detection.
   Then a Claude intent check can escalate ALLOW to HOLD, never the other way.
5. **PayPal.** An ALLOW is authorized and captured. A HOLD is **authorized but not captured** until the owner
   approves with a signature; reject or timeout voids it.
6. **Audit.** Every step goes into a hash-chained, append-only ledger with gateway-signed checkpoints. Verified
   PayPal webhooks are reconciled against it.
7. **Red team.** One click runs a scripted *compromised* agent through six scenarios: an honest order, a poisoned
   product listing, a tampered cart, a gift-card scam, a replayed request, and a runaway loop of six parallel
   orders. The results are identical on every run.

## Architecture

```
 Owner browser ──signed mandate / approvals / revocations (Ed25519)──┐
                                                                     ▼
 Agent process ──HTTP, propose-only token──►  Gateway (Fastify)  ──► Postgres (decisions, payments, jobs, ledger)
 (no DB, no PayPal creds,                      rules → LLM check        │
  allowlisted env)                             → reservation (row lock) └──► PayPal sandbox (Vault, Orders v2,
                                                                              Authorizations, Webhooks)
```

| Path | What |
|------|------|
| `packages/core` | Canonical JSON (RFC 8785), Ed25519, schemas, the pure policy engine, ledger hashing |
| `apps/gateway` | API, decision and payment state machine, Postgres job worker, PayPal client, webhook reconciliation |
| `apps/agent` | HTTP-only agent: scripted red team and a live Claude tool-use agent |
| `apps/console` | Owner console (React + AG Grid) |
| `docs/` | Spec, plan, decisions, security write-up, PayPal facts with sources, sandbox log |

## Run it locally

Requires Node 22+, pnpm 10 and PostgreSQL 15+.

```bash
pnpm install
pnpm db:start                      # local cluster on :54329 (or point DATABASE_URL at your own Postgres)
cp .env.example .env               # fill in PayPal sandbox credentials + GEMINI_API_KEY (see below)
pnpm build                         # builds the console
pnpm test                          # 136 tests, needs the DB from db:start
set -a; source .env; set +a; pnpm start   # http://localhost:8080
```

Without PayPal credentials the server still runs, but every payment is refused: there is no simulated payment
path. `GROQ_API_KEY` adds a fallback for when Gemini is overloaded. Without an LLM key (`GEMINI_API_KEY`, `GROQ_API_KEY`, or `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic`) the rules still
decide everything, and the intent check reports "not configured".

### PayPal sandbox setup

1. At developer.paypal.com, go to **Apps & Credentials → Sandbox → Create App** (merchant). Copy the client ID
   and secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. In the app settings, enable **Vault** (save payment methods).
3. Under **Sandbox → Accounts**, use the default *Personal* account as the buyer. Its email and password are
   what you log in with when linking PayPal in the console.
4. Webhooks: with the app deployed, run
   `PUBLIC_URL=https://… PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… pnpm --filter @leash/gateway register-webhook`
   and set the printed `PAYPAL_WEBHOOK_ID`.
5. Optional: run `pnpm --filter @leash/gateway spike` to exercise vault → authorize → capture → void against the
   real sandbox. Results are appended to `docs/SANDBOX_LOG.md`.

### Judge walkthrough (hosted demo)

1. Open the demo URL and click **Create owner key**.
2. Go to **Mandate → Link PayPal sandbox account** and log in with the sandbox buyer below.
   - Buyer email: `<SANDBOX_BUYER_EMAIL>`
   - Password: `<SANDBOX_BUYER_PASSWORD>`
3. Go to **Red team → Run red team** and watch six scenarios resolve.
4. **Overview:** approve or reject the held duplicate, and revoke the mandate with "Pull the leash".
5. **Decisions:** see what the agent sent and why the gateway decided. **Ledger:** verify the chain.

## Deploy (Render)

Free plans only: Render free web service (`render.yaml` Blueprint, Docker) plus Neon free Postgres. Step-by-step
guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Security

See [docs/SECURITY.md](docs/SECURITY.md). It covers the threat model, each guarantee with the test that proves
it, and the mutation-test results (`bash scripts/mutation-check.sh`: 20 of 20 mutants killed), plus [docs/REVIEW.md](docs/REVIEW.md), the adversarial review and its fixes. `npx tsx scripts/smoke.ts <url>` drives a running gateway end to end.

## Tools used

| Tool | How Leash uses it |
|------|-------------------|
| **PayPal REST (sandbox)** | Vault v3 setup and payment tokens (one-time consent). Orders v2 `intent: AUTHORIZE` with `vault_id` and merchant-initiated `stored_credential`. Authorizations v2 capture and void. `PayPal-Request-Id` idempotency. Webhooks with `verify-webhook-signature`. Facts and sources are in [docs/PAYPAL_FACTS.md](docs/PAYPAL_FACTS.md). |
| **Gemini API** (`gemini-flash-latest`, default) or **Claude API** | Mandate drafting from plain English (JSON-schema output), the intent-match check (can only escalate, fails closed), and the live shopping agent (function calling). `LLM_PROVIDER` picks the adapter; both share one prompt and one contract. |
| **Groq API** (`gpt-oss-120b`, free tier) | Fallback when Gemini is overloaded: the live agent switches to it mid-run, and the intent check and drafter retry on it. Only availability errors fall back, so a blocked answer still holds the order (D14). |
| **AG Grid** (Community) | Decisions grid and ledger grid in the owner console. |
| **Render** | Hosting: Docker web service and Postgres (`render.yaml`). |
| Postgres, Fastify, React, Vite, Tailwind, `@noble/curves` | Storage and locking, API, console, Ed25519 |
