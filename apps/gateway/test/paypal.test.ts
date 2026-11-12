import { DEMO_SHIP_TO } from "@leash/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayPalProvider } from "../src/paypal.ts";
import { ProviderRejectedError, ProviderUncertainError } from "../src/provider.ts";

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown };
function stubFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
    const r = handler(url, init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "paypal-debug-id": "dbg" } });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const pp = () => new PayPalProvider({ clientId: "id", clientSecret: "secret", webhookId: "WH-ID", baseUrl: "https://api-m.sandbox.paypal.com" });
const req = {
  requestId: "leash-p1-authorize",
  vaultId: "VAULT",
  paymentId: "6f1c8f0e-0000-4000-8000-000000000001",
  amountCents: 8640,
  currency: "USD" as const,
  shipTo: DEMO_SHIP_TO,
  lines: [
    { sku: "BEAN-ESP-1KG", title: "Beans", category: "coffee", merchant_id: "m", quantity: 2, unit_price_cents: 2400, line_total_cents: 4800 },
    { sku: "MILK-OAT-12", title: "Milk", category: "dairy-alt", merchant_id: "m", quantity: 1, unit_price_cents: 3840, line_total_cents: 3840 },
  ],
};

describe("PayPalProvider", () => {
  it("refuses a non-sandbox base URL", () => {
    expect(() => new PayPalProvider({ clientId: "a", clientSecret: "b", webhookId: null, baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox-only/);
  });

  it("sends a vaulted merchant-initiated AUTHORIZE order with idempotency key, mandate address and exact totals", async () => {
    const calls = stubFetch(() => ({ status: 201, body: { id: "ORDER", status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "AUTH", status: "CREATED" }] } }] } }));
    const r = await pp().authorize(req);
    expect(r).toEqual({ ok: true, orderId: "ORDER", authorizationId: "AUTH", status: "CREATED" });
    const c = calls.find((x) => x.url.endsWith("/v2/checkout/orders"))!;
    const h = c.init.headers as Record<string, string>;
    expect(h["paypal-request-id"]).toBe("leash-p1-authorize");
    const b = JSON.parse(c.init.body as string);
    expect(b.intent).toBe("AUTHORIZE");
    expect(b.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "86.40", breakdown: { item_total: { currency_code: "USD", value: "86.40" } } });
    expect(b.purchase_units[0].items[0]).toMatchObject({ quantity: "2", unit_amount: { value: "24.00" } });
    expect(b.purchase_units[0].shipping.address.address_line_1).toBe("418 Alder Street");
    expect(b.payment_source.paypal).toMatchObject({ vault_id: "VAULT", stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" } });
  });

  it("refuses to send an order whose items don't sum to the amount", async () => {
    stubFetch(() => ({ status: 201, body: {} }));
    expect(await pp().authorize({ ...req, amountCents: 1 })).toMatchObject({ ok: false, definitive: true });
  });

  it("PAYER_ACTION_REQUIRED and DENIED are definitive failures (no money held)", async () => {
    stubFetch(() => ({ status: 201, body: { id: "O", status: "PAYER_ACTION_REQUIRED" } }));
    expect(await pp().authorize(req)).toMatchObject({ ok: false, definitive: true });
    stubFetch(() => ({ status: 201, body: { id: "O", status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "A", status: "DENIED" }] } }] } }));
    expect(await pp().authorize(req)).toMatchObject({ ok: false, definitive: true });
  });

  it("422 is definitive; 500/429/network are uncertain (retry with same key)", async () => {
    stubFetch(() => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } }));
    expect(await pp().authorize(req)).toMatchObject({ ok: false, definitive: true });
    stubFetch(() => ({ status: 500, body: { name: "INTERNAL_SERVER_ERROR" } }));
    await expect(pp().authorize(req)).rejects.toBeInstanceOf(ProviderUncertainError);
    stubFetch(() => ({ status: 429, body: {} }));
    await expect(pp().authorize(req)).rejects.toBeInstanceOf(ProviderUncertainError);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(pp().authorize(req)).rejects.toBeInstanceOf(ProviderUncertainError);
  });

  it("capture: final capture, rejected on 422, uncertain on 503", async () => {
    let calls = stubFetch(() => ({ status: 201, body: { id: "CAP", status: "COMPLETED" } }));
    expect(await pp().capture({ requestId: "r", authorizationId: "AUTH", invoiceId: "x" })).toEqual({ captureId: "CAP", status: "COMPLETED" });
    const c = calls.find((x) => x.url.includes("/capture"))!;
    expect(c.url).toContain("/v2/payments/authorizations/AUTH/capture");
    expect(JSON.parse(c.init.body as string)).toEqual({ final_capture: true });
    calls = stubFetch(() => ({ status: 422, body: { details: [{ issue: "AUTHORIZATION_EXPIRED" }] } }));
    await expect(pp().capture({ requestId: "r", authorizationId: "AUTH", invoiceId: "x" })).rejects.toBeInstanceOf(ProviderRejectedError);
    stubFetch(() => ({ status: 503 }));
    await expect(pp().capture({ requestId: "r", authorizationId: "AUTH", invoiceId: "x" })).rejects.toBeInstanceOf(ProviderUncertainError);
  });

  it("void: already-voided is final, not an error", async () => {
    stubFetch(() => ({ status: 422, body: { details: [{ issue: "AUTHORIZATION_VOIDED" }] } }));
    expect(await pp().voidAuthorization({ requestId: "r", authorizationId: "A" })).toEqual({ status: "ALREADY_FINAL" });
  });

  it("webhook verification posts the raw event bytes back unchanged", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { verification_status: "SUCCESS" } }));
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"86.40"}},"z":1.10}';
    const ok = await pp().verifyWebhook(
      { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-transmission-time": "now" },
      raw,
    );
    expect(ok).toBe(true);
    const body = calls.find((x) => x.url.endsWith("verify-webhook-signature"))!.init.body as string;
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body).webhook_id).toBe("WH-ID");
  });

  it("webhook verification fails closed without headers or webhook id", async () => {
    stubFetch(() => ({ status: 200, body: { verification_status: "SUCCESS" } }));
    expect(await pp().verifyWebhook({}, "{}")).toBe(false);
    const noId = new PayPalProvider({ clientId: "a", clientSecret: "b", webhookId: null, baseUrl: "https://api-m.sandbox.paypal.com" });
    expect(await noId.verifyWebhook({ "paypal-transmission-sig": "s", "paypal-cert-url": "c" }, "{}")).toBe(false);
  });
});
