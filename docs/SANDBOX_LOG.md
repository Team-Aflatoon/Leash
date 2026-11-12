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

## 2026-11-12 16:20: new US setup (app APP-04219936CG633390X, US business + US personal)

- OAuth: 200. The token now carries `vault/payment-tokens/readwrite` (the IN app never did).
- `POST /v3/vault/setup-tokens` (paypal MERCHANT, paypal PLATFORM, card): all **403 NOT_AUTHORIZED**,
  issue `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` (debug_id f251846060492).
- `POST /v2/checkout/orders` with `attributes.vault.store_in_vault: ON_SUCCESS`: **422**, same issue.
- Reading: the app may vault, but the sandbox *merchant account* isn't enabled to. PayPal community threads report
  the same, fixed only by PayPal enabling the account or after the account propagates
  ([thread](https://www.paypal-community.com/t5/Sandbox-Environment/NOT-ENABLED-TO-VAULT-PAYMENT-SOURCE/m-p/3182847)).
- Decision: keep watching Vault; build the brief's documented fallback (one approval per mandate) in parallel.

## 2026-11-12T11:08:33.449Z: Plan B spike (one approval, partial captures)

- create $400 AUTHORIZE order: HTTP 200, status PAYER_ACTION_REQUIRED, order 2D096375AF742993M
- authorize after buyer approval: HTTP 201, order COMPLETED, authorization 3GP16022CB6725545 CREATED 400.00, expires 2026-12-11T11:09:25Z
- partial capture 1 ($86.40, final_capture false): HTTP 201, COMPLETED 1BV51717H9099461D
- retry capture 1 with same PayPal-Request-Id: HTTP 200, same capture id: true
- partial capture 2 ($108.00, final_capture false): HTTP 201, COMPLETED 39K00985LB548745D
- authorization after captures: PARTIALLY_CAPTURED
- void the remainder: HTTP 200  ""
- authorization after void: VOIDED

## 2026-11-12: first real Gemini calls (free-tier key)

- Models listed for the key include `gemini-flash-latest`, `gemini-3.x-flash`, `gemini-3.1-flash-lite`; `gemini-2.5-*` is
  closed to new users (404).
- Capacity was poor across models (503 "high demand", 429 on `gemini-pro-latest`, timeouts), changing from minute to minute.
- With retry plus fallback models (`gemini-3.6-flash`, `gemini-3.1-flash-lite`), live results:
  - honest café cart → **consistent**;
  - mandate drafted from plain English → **$400 / $250 / $150**, exactly as stated;
  - injected agent note → **suspicious** on one run; on another run every model attempt was overloaded, and the
    checker returned `error`, a HOLD (fail closed).
