import { ProviderRejectedError, ProviderUncertainError, type AuthorizeRequest, type AuthorizeResult, type PaymentProvider } from "./provider.ts";

/**
 * PayPal REST (sandbox) provider. Every fact used here is listed with its source in docs/PAYPAL_FACTS.md.
 *
 * Error classification matters for money safety:
 *  - 4xx (except 408/429): PayPal definitively refused → caller may release the reservation.
 *  - network errors, timeouts, 408, 429, 5xx: outcome unknown → ProviderUncertainError; the job retries with the
 *    same PayPal-Request-Id so PayPal de-duplicates (P9).
 */
export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  webhookId: string | null;
  baseUrl: string;
  timeoutMs?: number;
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  details?: { issue?: string; description?: string }[];
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly body: PayPalErrorBody | null, readonly debugId: string | null) {
    super(`PayPal ${status} ${body?.name ?? ""} ${body?.details?.map((d) => d.issue).join(",") ?? body?.message ?? ""} (debug_id ${debugId ?? "-"})`.trim());
  }
  get issue(): string {
    return this.body?.details?.[0]?.issue ?? this.body?.name ?? "";
  }
  get definitive(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

const money = (cents: number, currency: string) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });

export class PayPalProvider implements PaymentProvider {
  readonly name = "paypal-sandbox";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: PayPalConfig) {
    if (!cfg.baseUrl.includes("sandbox")) throw new Error("Leash is a sandbox-only build");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new ProviderUncertainError(`PayPal OAuth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body: unknown, requestId?: string, rawJson?: string): Promise<T> {
    let res: Response;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", prefer: "return=representation" };
      if (requestId) headers["paypal-request-id"] = requestId;
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        body: rawJson ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      });
    } catch (e) {
      if (e instanceof ProviderUncertainError) throw e;
      throw new ProviderUncertainError(`PayPal network error on ${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 401) this.token = null;
    if (!res.ok) {
      let parsed: PayPalErrorBody | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON error */
      }
      throw new HttpFailure(res.status, parsed, res.headers.get("paypal-debug-id"));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Map HTTP failures to the provider error contract. */
  private classify(e: unknown): never {
    if (e instanceof HttpFailure) {
      if (e.definitive) throw new ProviderRejectedError(e.message, e.issue);
      throw new ProviderUncertainError(e.message);
    }
    throw e;
  }

  async createVaultSetup(req: { requestId: string; returnUrl: string; cancelUrl: string }) {
    try {
      const r = await this.call<{ id: string; status: string; links?: { rel: string; href: string }[] }>(
        "POST",
        "/v3/vault/setup-tokens",
        {
          payment_source: {
            paypal: {
              description: "Leash: let your restock agent pay within the limits you sign",
              usage_type: "MERCHANT",
              customer_type: "CONSUMER",
              usage_pattern: "UNSCHEDULED_PREPAID",
              permit_multiple_payment_tokens: false,
              experience_context: { brand_name: "Leash", return_url: req.returnUrl, cancel_url: req.cancelUrl, shipping_preference: "NO_SHIPPING" },
            },
          },
        },
        req.requestId,
      );
      const approve = r.links?.find((l) => l.rel === "approve") ?? r.links?.find((l) => /approve/i.test(l.rel) || /approve|checkoutnow|agreements/i.test(l.href));
      if (!approve) throw new ProviderRejectedError(`setup token ${r.id} (${r.status}) has no approve link`);
      return { setupTokenId: r.id, approveUrl: approve.href };
    } catch (e) {
      return this.classify(e);
    }
  }

  async finalizeVault(req: { requestId: string; setupTokenId: string }) {
    try {
      const r = await this.call<{ id: string; payment_source?: { paypal?: { email_address?: string } } }>(
        "POST",
        "/v3/vault/payment-tokens",
        { payment_source: { token: { id: req.setupTokenId, type: "SETUP_TOKEN" } } },
        req.requestId,
      );
      return { vaultId: r.id, payerEmail: r.payment_source?.paypal?.email_address ?? null };
    } catch (e) {
      return this.classify(e);
    }
  }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const items = req.lines.map((l) => ({
      name: l.title.slice(0, 127),
      sku: l.sku,
      quantity: String(l.quantity),
      unit_amount: money(l.unit_price_cents, req.currency),
      category: "PHYSICAL_GOODS",
    }));
    const body = {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: req.paymentId,
          custom_id: req.paymentId,
          invoice_id: req.paymentId,
          description: "Leash agent restock order",
          amount: { ...money(req.amountCents, req.currency), breakdown: { item_total: money(req.amountCents, req.currency) } },
          items,
          shipping: {
            type: "SHIPPING",
            name: { full_name: req.shipTo.name },
            address: {
              address_line_1: req.shipTo.line1,
              ...(req.shipTo.line2 ? { address_line_2: req.shipTo.line2 } : {}),
              admin_area_2: req.shipTo.city,
              admin_area_1: req.shipTo.state,
              postal_code: req.shipTo.postal_code,
              country_code: req.shipTo.country_code,
            },
          },
        },
      ],
      payment_source: {
        paypal: {
          vault_id: req.vaultId,
          stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_PREPAID" },
          experience_context: { shipping_preference: "SET_PROVIDED_ADDRESS" },
        },
      },
    };
    // Sanity: amount must equal item_total (P2). The gateway computed both; assert before sending.
    const sum = req.lines.reduce((s, l) => s + l.unit_price_cents * l.quantity, 0);
    if (sum !== req.amountCents) return { ok: false, definitive: true, error: `internal: item total ${sum} != amount ${req.amountCents}` };
    try {
      const r = await this.call<{ id: string; status: string; purchase_units?: { payments?: { authorizations?: { id: string; status: string }[] } }[] }>(
        "POST",
        "/v2/checkout/orders",
        body,
        req.requestId,
      );
      const auth = r.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (r.status === "COMPLETED" && auth && (auth.status === "CREATED" || auth.status === "PENDING"))
        return { ok: true, orderId: r.id, authorizationId: auth.id, status: auth.status };
      // PAYER_ACTION_REQUIRED or DENIED: no money is held; nothing to void.
      return { ok: false, definitive: true, error: `order ${r.id} status ${r.status}${auth ? `, authorization ${auth.status}` : ""}` };
    } catch (e) {
      if (e instanceof HttpFailure && e.definitive) return { ok: false, definitive: true, error: e.message };
      return this.classify(e);
    }
  }

  async capture(req: { requestId: string; authorizationId: string; invoiceId: string }) {
    try {
      const r = await this.call<{ id: string; status: string }>("POST", `/v2/payments/authorizations/${encodeURIComponent(req.authorizationId)}/capture`, { final_capture: true }, req.requestId);
      if (r.status === "DECLINED" || r.status === "FAILED") throw new ProviderRejectedError(`capture ${r.id} ${r.status}`);
      return { captureId: r.id, status: r.status };
    } catch (e) {
      if (e instanceof ProviderRejectedError) throw e;
      return this.classify(e);
    }
  }

  async voidAuthorization(req: { requestId: string; authorizationId: string }) {
    try {
      await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(req.authorizationId)}/void`, undefined, req.requestId);
      return { status: "VOIDED" as const };
    } catch (e) {
      if (e instanceof HttpFailure && e.status === 422 && /VOIDED|ALREADY/i.test(e.issue)) return { status: "ALREADY_FINAL" as const };
      return this.classify(e);
    }
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => headers[k] ?? "";
    if (!h("paypal-transmission-sig") || !h("paypal-cert-url")) return false;
    // P12: the event must be posted back exactly as received, so splice the raw bytes in rather than re-serialising.
    const prefix = JSON.stringify({
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: this.cfg.webhookId,
    });
    const raw = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`;
    try {
      const r = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", undefined, undefined, raw);
      return r.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }
}
