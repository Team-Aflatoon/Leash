/**
 * Register the gateway's webhook URL with the PayPal sandbox app and print the webhook id.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PUBLIC_URL=https://your-app.onrender.com pnpm --filter @leash/gateway register-webhook
 *
 * Then set PAYPAL_WEBHOOK_ID to the printed id. (Same as: Developer Dashboard -> your app -> Add Webhook.)
 */
const base = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
const pub = process.env.PUBLIC_URL;
if (!id || !secret || !pub) throw new Error("set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PUBLIC_URL");

const tokRes = await fetch(`${base}/v1/oauth2/token`, {
  method: "POST",
  headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const tok = ((await tokRes.json()) as { access_token: string }).access_token;
const events = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "VAULT.PAYMENT-TOKEN.CREATED",
];
const r = await fetch(`${base}/v1/notifications/webhooks`, {
  method: "POST",
  headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
  body: JSON.stringify({ url: `${pub.replace(/\/$/, "")}/api/paypal/webhook`, event_types: events.map((name) => ({ name })) }),
});
const j = await r.json();
if (!r.ok) {
  console.error(JSON.stringify(j, null, 2));
  process.exit(1);
}
console.log(`PAYPAL_WEBHOOK_ID=${(j as { id: string }).id}`);
