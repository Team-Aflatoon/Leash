// Contract tests against the REAL PayPal sandbox. Run with `pnpm test:sandbox` when credentials are set.
import { DEMO_SHIP_TO } from "@leash/core";
import { describe, expect, it } from "vitest";
import { PayPalProvider } from "../src/paypal.ts";

const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
const pp = id && secret ? new PayPalProvider({ clientId: id, clientSecret: secret, webhookId: null, baseUrl: "https://api-m.sandbox.paypal.com" }) : null;

describe.skipIf(!pp)("PayPal sandbox contract", () => {
  it("creates a vault setup token with an approve link (P5)", async () => {
    const s = await pp!.createVaultSetup({ requestId: `ct-${Date.now()}`, returnUrl: "https://example.com/r", cancelUrl: "https://example.com/c" });
    expect(s.setupTokenId).toBeTruthy();
    expect(s.approveUrl).toMatch(/^https:\/\//);
  });

  it("an unknown vault id is a definitive refusal, not an uncertain error", async () => {
    const r = await pp!.authorize({
      requestId: `ct-bad-${Date.now()}`,
      vaultId: "DOESNOTEXIST",
      paymentId: crypto.randomUUID(),
      amountCents: 100,
      currency: "USD",
      shipTo: DEMO_SHIP_TO,
      lines: [{ sku: "X", title: "X", category: "coffee", merchant_id: "m", quantity: 1, unit_price_cents: 100, line_total_cents: 100 }],
    });
    expect(r.ok).toBe(false);
  });
});
