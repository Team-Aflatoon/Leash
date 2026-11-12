/**
 * Day-1 spike: prove the no-redirect flow against the REAL PayPal sandbox.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... pnpm --filter @leash/gateway spike
 *
 * 1. creates a Vault setup token and prints the approve URL: open it, log in as the sandbox BUYER, approve;
 * 2. exchanges it for a vault id;
 * 3. merchant-initiated AUTHORIZE $1.00 with no buyer present, then captures it;
 * 4. AUTHORIZE $2.00, replays it with the same PayPal-Request-Id (must return the same authorization), voids it.
 * Results are appended to docs/SANDBOX_LOG.md.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_SHIP_TO } from "@leash/core";
import { PayPalProvider } from "../src/paypal.ts";

const base = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) throw new Error("set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
const pp = new PayPalProvider({ clientId: id, clientSecret: secret, webhookId: null, baseUrl: base });
const log: string[] = [`\n## Spike run ${new Date().toISOString()}\n`];
const note = (s: string) => {
  console.log(s);
  log.push(`- ${s}`);
};
const run = Date.now().toString(36);

async function token() {
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

const line = (cents: number) => [{ sku: "SPIKE", title: "Spike item", category: "coffee", merchant_id: "m", quantity: 1, unit_price_cents: cents, line_total_cents: cents }];

try {
  const setup = await pp.createVaultSetup({ requestId: `spike-${run}-setup`, returnUrl: "https://example.com/leash/return", cancelUrl: "https://example.com/leash/cancel" });
  note(`setup token ${setup.setupTokenId} created; approve link: ${new URL(setup.approveUrl).pathname} (P5)`);
  console.log(`\nOPEN THIS URL, log in as the sandbox BUYER, approve:\n\n  ${setup.approveUrl}\n\nWaiting for approval (up to 10 min)...`);
  const t = await token();
  let status = "";
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/v3/vault/setup-tokens/${setup.setupTokenId}`, { headers: { authorization: `Bearer ${t}` } });
    status = ((await r.json()) as { status: string }).status;
    if (status === "APPROVED") break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  note(`setup token status ${status}`);
  const vault = await pp.finalizeVault({ requestId: `spike-${run}-vault`, setupTokenId: setup.setupTokenId });
  note(`vault id ...${vault.vaultId.slice(-4)} for ${vault.payerEmail ?? "(no email)"}`);

  const a1 = await pp.authorize({ requestId: `spike-${run}-a1`, vaultId: vault.vaultId, paymentId: crypto.randomUUID(), amountCents: 100, currency: "USD", lines: line(100), shipTo: DEMO_SHIP_TO });
  note(`merchant-initiated authorize $1.00 -> ${JSON.stringify(a1)} (P4 ${a1.ok ? "CONFIRMED" : "FAILED"})`);
  if (a1.ok) note(`capture -> ${JSON.stringify(await pp.capture({ requestId: `spike-${run}-c1`, authorizationId: a1.authorizationId, invoiceId: "x" }))} (P7 capture)`);

  const pid = crypto.randomUUID();
  const a2 = await pp.authorize({ requestId: `spike-${run}-a2`, vaultId: vault.vaultId, paymentId: pid, amountCents: 200, currency: "USD", lines: line(200), shipTo: DEMO_SHIP_TO });
  const a2again = await pp.authorize({ requestId: `spike-${run}-a2`, vaultId: vault.vaultId, paymentId: pid, amountCents: 200, currency: "USD", lines: line(200), shipTo: DEMO_SHIP_TO });
  note(`replayed authorize with same PayPal-Request-Id returned same authorization: ${a2.ok && a2again.ok && a2.authorizationId === a2again.authorizationId} (P9)`);
  if (a2.ok) note(`void -> ${JSON.stringify(await pp.voidAuthorization({ requestId: `spike-${run}-v2`, authorizationId: a2.authorizationId }))} (P7 void)`);
} catch (e) {
  note(`FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  appendFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "SANDBOX_LOG.md"), log.join("\n") + "\n");
}
