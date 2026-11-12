# Leash security write-up

## Threat model

| Actor | Assumed capability |
|-------|--------------------|
| Shopping agent | **Fully compromised.** Sends anything over HTTP with its bearer token, at any rate and concurrency, can replay or alter its own requests. |
| Merchant catalog text | Hostile. Product descriptions contain prompt injection (our demo catalog ships one). |
| Internet | Can call every public endpoint of the hosted demo and forge webhook requests. |
| Network to PayPal | Can time out or fail mid-call. |
| Out of scope | A database superuser who **also** holds the gateway signing key (see "Limits"). The owner's own browser/device. |

## Architecture in one paragraph

The agent runs as a separate OS process with an allowlisted environment: gateway URL, a propose-only token, and the
LLM key in live mode. It has no database URL, no PayPal credentials and no signing key. It can call four endpoints:
read the catalog, read its own mandate scope, submit a proposal, and read a decision. The gateway resolves every
proposal against the catalog and the owner-signed mandate inside one Postgres transaction that locks the mandate
row. It records an ALLOW/HOLD/BLOCK decision and, for ALLOW and HOLD, a budget reservation, then executes PayPal
calls from a job queue using deterministic idempotency keys. Every step is appended to a hash-chained ledger.

## Guarantees → tests

Each test below fails if its guarantee breaks. `scripts/mutation-check.sh` removes each guard in turn and confirms
the test fails (last run: **20 of 20 mutants killed**, 0 survived, 0 non-compiling). An independent adversarial review found 13
more issues; they are fixed and regression-tested, see [REVIEW.md](REVIEW.md).

| # | Guarantee | Mechanism | Test(s) | Mutation killed |
|---|-----------|-----------|---------|-----------------|
| G1 | Agent can't touch money, DB or credentials | Separate process, env allowlist (`agentEnv`), HTTP-only client, per-run token scoped to one mandate with expiry, propose-only routes | `agent.test.ts` "imports nothing from the gateway…", "environment is an allowlist without secrets"; `gateway.test.ts` "rejects missing or wrong agent tokens" | agent env not filtered |
| G1 | Agent can't release held money | Approvals are Ed25519-signed by the owner key (browser only), verified per request; CAS on `approval = 'PENDING'` | "cannot approve its own held payment", "owner-signed approval cannot be replayed to capture twice" | approval signature not checked |
| G2 | Gateway derives price, merchant, category, quantity limits, address | `evaluateRules` prices from the catalog; agent claims only compared (mismatch = BLOCK); PayPal order built from gateway-resolved lines and the mandate's `ship_to` | core "blocks a claimed price…", "blocks any ship-to…"; gateway "blocks a lowballed price claim and never sends it to PayPal", "blocks a redirected shipping address", "ALLOW → … ship-to sent to PayPal is the mandate's" | address lock disabled; price claim ignored |
| G3 | LLM can only tighten | `combine()` folds verdicts with `max(severity)`; LLM not called when rules BLOCK; LLM error/refusal = HOLD; the Groq fallback runs only when Gemini was unavailable, never after a safety block (D14) | core "G3" matrix (3 outcomes × 5 verdicts); gateway "suspicious verdict turns ALLOW into HOLD", "LLM failure fails closed", "'consistent' cannot unblock"; `groq.test.ts` "a safety block does not fall back" | LLM may loosen; fallback on any LLM error |
| G4 | Mandates tamper-evident, expire, revocable at once | JCS + Ed25519 with domain separation; signature re-verified on every decision; `valid_from/until`; revocation locks the mandate, voids open holds, and the authorize and capture jobs re-check after every PayPal call | core signature tests; gateway "mandate edited in the database stops verifying", "signed by someone else", "expired mandate blocks", "revocation is immediate", "revocation that lands while PayPal is authorizing still prevents capture" | signature not re-verified; revocation ignored at capture |
| G5 | No double spend, no budget overrun | Mandate row lock (`FOR NO KEY UPDATE`) around spend computation and reservation; `UNIQUE(agent_id, idempotency_key)`; exact replay returns the original decision; same key + different body = BLOCK; duplicate cart = HOLD; deterministic `PayPal-Request-Id` | "50 concurrent distinct orders never exceed the $400 budget", "20 concurrent copies of one request → 1 decision, 1 payment", "exact replay…", "same key with a different body…", "uncertain authorize is retried with the same PayPal-Request-Id" | mandate row lock removed; idempotency unique index removed |
| G6 | Real PayPal sandbox, never faked | `PayPalProvider` (sandbox base URL enforced); without credentials the server uses a provider that **refuses** every money call; the fake exists only in `test/` | `paypal.test.ts` request-shape tests; `paypal.sandbox.test.ts` + `pnpm spike` against the real sandbox (`docs/SANDBOX_LOG.md`) | n/a |
| G7 | Tampering with the audit trail is detectable | Hash chain (`hash_n = sha256(hash_{n-1} ‖ JCS(entry))`); DB trigger blocks UPDATE/DELETE/TRUNCATE; gateway-signed checkpoints | core chain tests; gateway "refuses UPDATE, DELETE and TRUNCATE", "detects tampering by a superuser who bypasses the trigger, and signed checkpoints catch a full rewrite" | ledger trigger removed |
| — | Forged webhooks can't change state | `verify-webhook-signature` with raw-body postback; unverified events stored for audit only; event-id dedupe | "unverified webhooks are recorded but never change state", "redelivery is ignored" | webhook verification bypassed |

## Payment correctness

- **State machine:** `RESERVED → AUTHORIZED → CAPTURED`, with `→ VOIDED` and `→ FAILED`. Every transition is a
  conditional update under a row lock, so each happens exactly once.
- **Uncertain outcomes** (timeouts, 5xx, 429) keep the reservation and retry with the *same* `PayPal-Request-Id`.
  The budget stays reserved until the outcome is known. That fails safe.
- **Definitive refusals** (4xx, DENIED, PAYER_ACTION_REQUIRED) mark the payment `FAILED` and release the budget.
- **A rejected capture** voids the authorization rather than leaving money held.
- **Holds** auto-void after `APPROVAL_TIMEOUT_SECONDS`. The job is enqueued in the same transaction as the
  authorization, so a crash can't lose it.
- **Lock ordering:** decisions D10. A deadlock found by the red-team test led to `FOR NO KEY UPDATE`, and the ledger
  append is now always the last statement of a transaction.

## Prompt-injection posture

The rules never read free text. Product descriptions reach only the agent. The intent checker sees
gateway-resolved titles, categories, quantities and prices, plus the agent's note as delimited, untrusted data.
Its only power is to add a HOLD. The red-team "poisoned listing" scenario assumes the agent fully obeys the
injection, and the deterministic rules stop it.

## Limits (honest)

- A DB superuser can disable the trigger and rewrite the chain consistently. Signed checkpoints detect that unless
  the attacker also holds `GATEWAY_SIGNING_KEY`. Export checkpoints off-box (`GET /api/ledger/checkpoints`) for
  stronger anchoring.
- The owner key lives in browser storage. That is fine for a demo, but production would use WebAuthn or a hardware
  key.
- The dashboard requires a fresh owner signature. The ledger is public **by design** so anyone can verify it, and it
  therefore holds only commitments (`owner_ref`, `body_hash`), mandate ids, outcomes and amounts. It never holds
  addresses, emails or mandate bodies.
- The agent runs as a separate process with no secrets in its environment, but in the same container and under the
  same OS user. Code execution inside the agent could read the parent process's environment on Linux. The live
  agent has only three HTTP tools and no code execution. For production, run it in its own container or uid, and
  give it its own spend-capped LLM key (`AGENT_ANTHROPIC_API_KEY`).
- Payment jobs retry forever by design. A stuck job is visible through `last_error`, and its budget stays reserved,
  which fails safe.
- Sandbox only: `PayPalProvider` refuses a non-sandbox base URL.
