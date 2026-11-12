# Sandbox log

Real PayPal sandbox runs, appended by `pnpm --filter @leash/gateway spike`.

## 2026-11-12: first real calls (app APP-9AC53532SC340332T)

- OAuth client_credentials: **200**; token issued (P1 confirmed).
- `POST /v3/vault/setup-tokens`: **403 NOT_AUTHORIZED** (debug_id ca594b4d65f76). The token's scopes include
  `payments/payment/authcapture`, `checkout/payment-resources` and `applications/webhooks`, but no
  `vault/payment-tokens` scope, only the legacy `v1/vault/credit-card`. Vault ("Save payment methods") is not enabled
  on this sandbox app (P6 confirmed: it must be switched on in the Developer Dashboard).
- `POST /v2/checkout/orders` with `intent: AUTHORIZE`: **201**, status `PAYER_ACTION_REQUIRED`, links `self, payer-action`
  (P2 confirmed; the buyer-approval link is `rel: payer-action` when `payment_source.paypal.experience_context` is sent).
- Contract test "unknown vault id is a definitive refusal": passed.

## 2026-11-12 15:48: Vault with "Save payment methods" ticked, merchant country IN

- App settings show **Save payment methods** checked (merchant sandbox account country: IN; buyer account country: IN).
- Fresh token still carries no Vault v3 scope (only legacy `v1/vault/credit-card`).
- `POST /v3/vault/setup-tokens` with `payment_source.paypal`: **403 NOT_AUTHORIZED** (debug_id f90296760912c).
- Control, `payment_source.card`: also **403 NOT_AUTHORIZED** (debug_id f225505218a25).
- Rechecked every 2 minutes 15:37 to 15:48: always 403.
- Reading: Vault v3 isn't provisioned for this India-based sandbox merchant, whatever the checkbox says. Next step: a US
  sandbox business account with its own app (Vault ticked) and a US personal buyer.
