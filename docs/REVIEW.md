# Adversarial security review: findings and fixes

A fresh reviewer, which had not seen any of the design reasoning, attacked the code under the threat model in
`docs/SECURITY.md`. It confirmed most findings with a proof-of-concept script against the test database. Each
fixed finding now has a regression test in `apps/gateway/test/review.test.ts` (or as named), and the main ones are
also in `scripts/mutation-check.sh`.

| # | Severity | Finding | Fix | Test |
|---|----------|---------|-----|------|
| R1 | High | One shared agent token could spend against **any** owner's mandate. | Per-run tokens, minted when a run starts, scoped to one mandate and expiring after 10 min (`agent_tokens`). A proposal for another mandate is recorded and blocked (`AGENT_NOT_AUTHORIZED`). Agent read routes are scoped too. | R1 tests; mutation "R1 agent token scope ignored" |
| R2 | High | Public ledger and dashboard leaked owner ids, ship-to addresses, payer email and PayPal ids. | The dashboard needs a fresh owner-signed `read` statement (header `x-leash-auth`). Ledger entries carry `owner_ref = sha256(owner id)` and `body_hash`, never bodies or addresses. Drafting needs a signed `draft` action. | R2 tests; mutation "R2 dashboard owner check removed" |
| R3 | High | A void that hit `AUTHORIZATION_ALREADY_CAPTURED` was recorded as VOIDED, which freed the budget after money had moved. | The provider returns `ALREADY_CAPTURED` separately. The gateway records a capture with a MISMATCH flag and never a void. | R3 test, PayPal client test; mutation "R3" |
| R4 | High | `trustProxy: true` let any client pick its IP and bypass the rate limits; LLM drafting and agent runs were unbounded. | Trust exactly `TRUST_PROXY_HOPS` hops (1 on Render). Per-token proposal rate limit; signed and rate-limited drafting; global and per-owner caps on agent runs. | Covered by config and the R2 draft test |
| R5 | Medium | Checkpoints were deletable; ledger verification stopped at 100k entries. | Triggers make checkpoints append-only. Verification pages through the whole ledger. Unverified webhooks no longer append entries. | R5 test |
| R6 | Medium | A forged or transiently unverifiable webhook occupied the event id, so PayPal's genuine redelivery was dropped. | Unverified events are refused and not stored. Cert host (`*.paypal.com`) and transmission-time checks run before the PayPal verify call. | R6 tests; mutation "R6" |
| R7 | Medium | Money jobs gave up after 12 tries, stranding reservations or live holds. | `payment.*` and `approval.expire` jobs never give up (backoff capped at 2 min). A refused void keeps the budget reserved and is flagged MISMATCH. | R7 test |
| R8 | Medium | The live agent receives the gateway's LLM key; same-uid processes can read the parent's environment on Linux. | `AGENT_ANTHROPIC_API_KEY` (a separate, spend-capped key) is preferred, and the gateway warns if it is missing. Process-level isolation (separate uid or container) is documented as a production step. | Limit, documented |
| R9 | Low | Approval accepted after the hold deadline if the expiry job lagged. | Approve checks `approval_expires_at`. | R9 test; mutation "R9" |
| R10 | Low | Revocation did not wait for an in-flight capture. | Revoke locks the mandate's live payment rows first, so it waits for a capture in progress; no capture can start after it commits. | R10 test |
| R11 | Low | If the pre-check blocked but the in-transaction rules passed, money could move without an intent verdict. | That case becomes `INTENT_CHECK_UNAVAILABLE` → HOLD. | Code review (race too narrow to schedule in a test) |
| R12 | Low | PayPal return didn't check which approval came back. | `approval_token_id` must equal the stored setup token. The console shows the linked payer email. | R12 test |
| R13 | Low | HTTP 401 from PayPal was treated as a definitive refusal. | 401 is uncertain: the token is refreshed and the call retried with the same request id. | PayPal client test |

Also fixed from the review notes: an empty `state` is no longer sent as `admin_area_1: ""`.

Still open, and documented in SECURITY.md "Limits": out-of-database anchoring of checkpoints is manual (export
`GET /api/ledger/checkpoints`); process isolation for the agent is environment-only within one container.
