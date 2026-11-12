# PayPal API facts we rely on

Each fact links the official page or OpenAPI spec it came from. **Status** says whether we have confirmed it
with a real sandbox call (`docs/SANDBOX_LOG.md`) or only read it in the docs.

Specs: [Orders v2](https://developer.paypal.com/api/orders/v2/schema.json) ·
[Vault v3](https://developer.paypal.com/api/payment-tokens/v3/schema.json) ·
[Payments v2](https://developer.paypal.com/api/payments/v2/schema.json) ·
[Webhooks v1](https://developer.paypal.com/api/webhooks/v1/schema.json)

| # | Fact | Source | Status |
|---|------|--------|--------|
| P1 | Sandbox base `https://api-m.sandbox.paypal.com`; token via `POST /v1/oauth2/token`, Basic auth `client_id:secret`, form body `grant_type=client_credentials`; response `expires_in` seconds. | [Authentication](https://developer.paypal.com/api/rest/authentication/) | docs |
| P2 | `POST /v2/checkout/orders` requires `intent` + `purchase_units`. `amount.breakdown.item_total` must equal Σ `unit_amount × quantity` when items are sent. Item `quantity` is a string. | [Orders create](https://developer.paypal.com/api/orders/v2/orders-create) | docs |
| P3 | `intent: AUTHORIZE` not supported with more than one purchase unit. Authorizations "best captured within three days … available to capture for up to 29 days". | Orders spec | docs |
| P4 | Order with `payment_source.paypal.vault_id` + `stored_credential {payment_initiator: MERCHANT, usage: SUBSEQUENT}` and `intent: AUTHORIZE` returns `201 status: COMPLETED` with `purchase_units[0].payments.authorizations[0]` — no redirect, no separate `/authorize` call. | Orders spec sample "Create and authorize an order for a PayPal wallet vaulted account holder (Single Shot)" | docs — **must confirm** |
| P5 | Vault: `POST /v3/vault/setup-tokens` with `payment_source.paypal {usage_type, experience_context{return_url, cancel_url}}` → payer approval → `POST /v3/vault/payment-tokens` with `payment_source.token {id: <setup token>, type: SETUP_TOKEN}` → `id` = vault id. | [Vault v3](https://developer.paypal.com/docs/api/payment-tokens/v3/), [Save PayPal](https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/js-sdk/paypal/) | docs — approve link `rel` **must confirm** |
| P6 | Vault must be enabled on the sandbox app in the Developer Dashboard; only the sandbox business account can save payment methods. | Save PayPal guide | docs |
| P7 | Capture `POST /v2/payments/authorizations/{id}/capture` (omitting `amount` captures all; `final_capture`); void `POST /v2/payments/authorizations/{id}/void`; can't void a fully captured authorization. | [Payments v2](https://developer.paypal.com/docs/api/payments/v2/) | docs |
| P8 | Honor period 3 days; reauthorize allowed day 4–29. | Payments v2 | docs |
| P9 | `PayPal-Request-Id`: server stores the id "for a period of time"; retries on timeout/500 don't repeat the operation. Vault keeps keys 3 h. Idempotent replay of authorize returns 200 instead of 201. | [Requests](https://developer.paypal.com/api/rest/requests/), Vault spec, Orders spec | docs |
| P10 | `Prefer: return=representation` returns the full body (default `return=minimal`). | Orders spec | docs |
| P11 | Webhook events: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED` (`…DECLINED` in v2 list — subscribe to both), `VAULT.PAYMENT-TOKEN.CREATED`. | [Event names](https://developer.paypal.com/api/rest/webhooks/event-names/) | docs |
| P12 | Verify via `POST /v1/notifications/verify-webhook-signature` with `auth_algo, cert_url, transmission_id, transmission_sig, transmission_time` (from `PAYPAL-*` headers), `webhook_id`, `webhook_event` (posted back exactly as received) → `verification_status: SUCCESS`. | [Webhooks v1](https://developer.paypal.com/docs/api/webhooks/v1/), [Webhooks REST](https://developer.paypal.com/api/rest/webhooks/rest/) | docs |
| P13 | Simulator events (`/v1/notifications/simulate-event`) **cannot** be verified with verify-webhook-signature. | Webhooks REST | docs |
| P14 | Webhooks can be registered via `POST /v1/notifications/webhooks`. | Webhooks v1 | docs |
| P15 | PayPal Agent Toolkit / MCP server exists (local and remote `mcp.paypal.com`); no evidence it supports vault or authorize/capture. We call REST directly. | [Blog](https://developer.paypal.com/community/blog/paypal-mcp-agenttoolkit) | docs |

## Design consequences

- Primary flow = P5 once per mandate + P4 per purchase + P7. If P4 fails in sandbox, fall back to per-order buyer
  approval (`docs/PLAN.md`).
- Every mutating call sends a deterministic `PayPal-Request-Id` (P9).
- Webhook verification is tested with real sandbox events, not the simulator (P13).
