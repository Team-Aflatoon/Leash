/**
 * Plan B spike: one buyer approval, then several partial captures from one authorization, then void the rest.
 *
 *   pnpm --filter @leash/gateway exec tsx scripts/capture-spike.ts create      # prints the approval URL
 *   (buyer approves in the browser)
 *   pnpm --filter @leash/gateway exec tsx scripts/capture-spike.ts finish <id> # authorize, capture x2, idempotent retry, void
 *
 * Every result is appended to docs/SANDBOX_LOG.md.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const base = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) throw new Error("set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
const LOG = join(import.meta.dirname, "..", "..", "..", "docs", "SANDBOX_LOG.md");
const log = (s: string) => {
  console.log(s);
  appendFileSync(LOG, `- ${s}\n`);
};

async function token() {
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function call(tok: string, method: string, path: string, body?: unknown, requestId?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", prefer: "return=representation", ...(requestId ? { "paypal-request-id": requestId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}

const mode = process.argv[2];
const tok = await token();
if (mode === "create") {
  appendFileSync(LOG, `\n## ${new Date().toISOString()}: Plan B spike (one approval, partial captures)\n\n`);
  const r = await call(
    tok,
    "POST",
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "mandate-spike", description: "Leash mandate hold (spike)", amount: { currency_code: "USD", value: "400.00" } }],
      payment_source: { paypal: { experience_context: { brand_name: "Leash", user_action: "CONTINUE", shipping_preference: "NO_SHIPPING", return_url: "https://example.com/leash/return", cancel_url: "https://example.com/leash/cancel" } } },
    },
    `spike-b-${Date.now()}`,
  );
  const link = r.json.links?.find((l: { rel: string }) => l.rel === "payer-action")?.href;
  log(`create $400 AUTHORIZE order: HTTP ${r.status}, status ${r.json.status}, order ${r.json.id}`);
  console.log(`ORDER=${r.json.id}`);
  console.log(`APPROVE=${link}`);
} else if (mode === "finish") {
  const orderId = process.argv[3]!;
  const a = await call(tok, "POST", `/v2/checkout/orders/${orderId}/authorize`, {}, `spike-b-auth-${orderId}`);
  const auth = a.json.purchase_units?.[0]?.payments?.authorizations?.[0];
  log(`authorize after buyer approval: HTTP ${a.status}, order ${a.json.status}, authorization ${auth?.id} ${auth?.status} ${auth?.amount?.value}, expires ${auth?.expiration_time}`);
  if (!auth) process.exit(1);
  const c1 = await call(tok, "POST", `/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: "USD", value: "86.40" }, final_capture: false, invoice_id: `spike-c1-${Date.now()}` }, `spike-b-c1-${auth.id}`);
  log(`partial capture 1 ($86.40, final_capture false): HTTP ${c1.status}, ${c1.json.status ?? c1.json.name} ${c1.json.id ?? JSON.stringify(c1.json.details ?? "")}`);
  const c1again = await call(tok, "POST", `/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: "USD", value: "86.40" }, final_capture: false, invoice_id: "ignored-on-retry" }, `spike-b-c1-${auth.id}`);
  log(`retry capture 1 with same PayPal-Request-Id: HTTP ${c1again.status}, same capture id: ${c1again.json.id === c1.json.id}`);
  const c2 = await call(tok, "POST", `/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: "USD", value: "108.00" }, final_capture: false, invoice_id: `spike-c2-${Date.now()}` }, `spike-b-c2-${auth.id}`);
  log(`partial capture 2 ($108.00, final_capture false): HTTP ${c2.status}, ${c2.json.status ?? c2.json.name} ${c2.json.id ?? JSON.stringify(c2.json.details ?? "")}`);
  const g = await call(tok, "GET", `/v2/payments/authorizations/${auth.id}`);
  log(`authorization after captures: ${g.json.status}`);
  const v = await call(tok, "POST", `/v2/payments/authorizations/${auth.id}/void`, undefined, `spike-b-void-${auth.id}`);
  log(`void the remainder: HTTP ${v.status} ${v.json.name ?? ""} ${JSON.stringify(v.json.details ?? "")}`);
  const g2 = await call(tok, "GET", `/v2/payments/authorizations/${auth.id}`);
  log(`authorization after void: ${g2.json.status}`);
}
