# Decisions

Each entry: what we chose, why, and what we gave up. Newest at the bottom.

## D1. TypeScript monorepo, one deployable service + Postgres

- `packages/core`: pure, dependency-light domain code (canonical JSON, Ed25519, mandate schema, policy engine,
  ledger hashing). Shared by gateway, agent (types only) and console (signing).
- `apps/gateway`: Fastify API. The **only** process holding `DATABASE_URL`, PayPal credentials and the gateway
  signing key. Also serves the built console.
- `apps/agent`: the shopping agent and the scripted red-team "compromised agent". Talks to the gateway over HTTP
  with a propose-only bearer token. A test asserts it imports nothing from the gateway and its child-process
  environment has no secrets.
- `apps/console`: Vite + React + AG Grid owner console.

Why: one service is the simplest thing judges can run and we can host. Process separation (agent as a child
process with a scrubbed env, talking HTTP) keeps the "agent can't touch money" claim real, not just a module
boundary.

## D2. Postgres job table instead of BullMQ/Redis

The PDF suggested BullMQ. We use a `jobs` table polled with `FOR UPDATE SKIP LOCKED`. Why: jobs (approval
timeouts, capture retries, webhook processing) are created in the **same transaction** as the decision that needs
them, so a crash can never leave a hold without its timeout. One fewer service to host. Cost: polling latency
(1 s), irrelevant at this scale.

## D3. Ed25519 via `@noble/curves`, canonical JSON via RFC 8785 (JCS)

Same audited library in the browser and in Node. The owner's private key is generated and kept in the browser
(IndexedDB/localStorage); the gateway stores only the public key, so the gateway cannot forge a mandate,
approval or revocation. Signatures cover the JCS-canonical bytes of the mandate body.

## D4. Money as integer cents, single currency (USD)

No floats anywhere. PayPal amounts are formatted from cents at the edge.

## D5. Budget enforcement = row lock on the mandate + reservations

Every proposal runs in one transaction that `SELECT … FOR UPDATE`s the mandate row, recomputes period spend from
`payments` in non-terminal or captured states, and inserts the new payment (a reservation) before commit. Voided
or failed payments release budget. Concurrent proposals serialise on the lock, so N parallel requests can never
exceed the budget. PayPal calls happen **after** commit, never inside the lock.

## D6. Idempotency

Agent supplies an `idempotency_key` per proposal. `UNIQUE(agent_id, idempotency_key)`:
- same key, same body → the original decision is returned, flagged `replay`, no new payment;
- same key, different body → `BLOCK: IDEMPOTENCY_CONFLICT` (tampering signal).
Different key, same cart within 24 h → `HOLD: DUPLICATE_SUSPECTED` (a human decides; it might be legitimate).
Every PayPal call carries a deterministic `PayPal-Request-Id` derived from our payment id + operation, so our own
retries cannot double-charge.

## D7. LLM checks can only tighten

Decision severity is ordered ALLOW < HOLD < BLOCK. Final = max(rules, llm). The LLM verdict is either
`consistent` (no change) or `suspicious` (escalate to HOLD). LLM error/timeout when an LLM is configured → HOLD
(fail closed). The combinator is a pure function with a test that enumerates all inputs.

## D8. Deterministic demo

Red-team attacks are executed by a **scripted compromised agent** that always obeys the injection — the worst
case we must survive. Every attack is stopped by deterministic rules, so outcomes don't depend on the LLM.
LLM intent verdicts are cached by `sha256(model, prompt version, input)`, so the honest purchase gets the same
verdict on every run. Demo reset never deletes anything: it retires the owner's active mandates (voiding their
open holds at PayPal) and the console signs a fresh demo mandate, so each run starts with a fresh $400 budget while
the ledger keeps the full history.

## D9. Hosting: Render (Docker web service + Render Postgres)

Sponsor-eligible per the PDF, `render.yaml` blueprint in the repo. Railway works identically from the Dockerfile.

## D10. Lock ordering (found by the red-team test)

The first full red-team run deadlocked: a transaction that already held the ledger-head lock updated a payment row
a second time, which fires Postgres's FK check (`KEY SHARE` on the mandate), while a proposal held the mandate with
`FOR UPDATE` and waited for the ledger head. Rules now:
1. Mandate and payment rows are locked with `FOR NO KEY UPDATE` (still serialises proposals per mandate; doesn't
   conflict with FK checks).
2. `appendLedger` is the **last statement** of every transaction, so the global head lock is held only for the
   final insert.
3. A row is updated at most once per transaction where possible.
Regression coverage: the red-team test (6 concurrent orders while the worker authorizes and captures) and the
50-way budget test, repeated 3× with zero `deadlock detected` lines in the server log after the fix.

## D11. LLM usage

- Model `claude-opus-5-5` (configurable via `LLM_MODEL`), structured outputs via Zod, server-side refusal
  fallback (`fallbacks: "default"`). A refusal or unparseable answer is an `error` verdict → HOLD (fail closed).
- Intent check runs at effort `low` (it is a classification), mandate drafting at `medium`, the live shopping agent
  at `medium` with the SDK tool runner (max 10 iterations).
- The intent checker never sees product descriptions (merchant-controlled text), only titles, categories,
  quantities and prices the gateway resolved. The agent's note is passed as delimited, untrusted data.

## D12. Gemini by default, Claude optional

The team supplies a Gemini key. `LLM_PROVIDER` picks the adapter; by default it is Gemini when `GEMINI_API_KEY` is set.
Both adapters implement the same `IntentChecker` and `MandateDrafter` interfaces and share the auditor prompt
(`buildIntentPrompt`), and the live agent shares one set of tool definitions. Gemini output is constrained with a
hand-written JSON schema (the supported subset: no nullable unions) and validated with zod. A safety block, a
non-STOP finish, bad JSON or an HTTP or network error is an `error` verdict, which is a HOLD (fail closed, D7).
SDK `@google/genai` is pinned to 2.32.0; 3.x was under two weeks old.

## D13. Plan B payment consent: one approval per mandate (confirmed in the sandbox)

PayPal refused Vault for both sandbox merchants (`NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`, SANDBOX_LOG). The brief's
fallback, a one-time approval at mandate signing, was tested end to end against the real sandbox:
- one `intent: AUTHORIZE` order for the monthly budget, approved once by the buyer;
- `/authorize` gives a $400 authorization valid for 29 days;
- partial captures with `final_capture: false` return COMPLETED, and the authorization ends PARTIALLY_CAPTURED;
- a capture retried with the same `PayPal-Request-Id` returns the same capture;
- voiding the remainder leaves the authorization VOIDED.
Purchases still need no redirect. If Vault is enabled later, the Vault path is used unchanged.
