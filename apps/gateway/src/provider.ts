import type { Address, ResolvedLine } from "@leash/core";

/**
 * The only door to money. The real implementation is `PayPalProvider` (sandbox REST calls). A fake exists only
 * under `test/` — production code never constructs one.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Start one-time consent: vault the owner's PayPal wallet. Returns a URL the owner opens to approve. */
  createVaultSetup(req: { requestId: string; returnUrl: string; cancelUrl: string }): Promise<{ setupTokenId: string; approveUrl: string }>;
  /** Exchange an approved setup token for a reusable vault id. */
  finalizeVault(req: { requestId: string; setupTokenId: string }): Promise<{ vaultId: string; payerEmail: string | null }>;
  /** Merchant-initiated order with intent AUTHORIZE against the vaulted wallet. No redirect. */
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  capture(req: { requestId: string; authorizationId: string; invoiceId: string }): Promise<{ captureId: string; status: string }>;
  /** Plan B consent: an AUTHORIZE order for the hold amount; the owner approves it once at `approveUrl`. */
  createHoldOrder(req: { requestId: string; amountCents: number; currency: "USD"; returnUrl: string; cancelUrl: string }): Promise<{ orderId: string; approveUrl: string }>;
  /** Authorize the approved hold order. */
  authorizeHoldOrder(req: { requestId: string; orderId: string }): Promise<{ authorizationId: string; amountCents: number; expiresAt: string | null; payerEmail: string | null }>;
  /** Partial capture from the hold (final_capture false). Rejects with ProviderRejectedError on a definitive refusal. */
  captureFromHold(req: { requestId: string; authorizationId: string; amountCents: number; currency: "USD"; invoiceId: string }): Promise<{ captureId: string; status: string }>;
  /**
   * VOIDED: the hold is released (now, or earlier, or it expired). ALREADY_CAPTURED: the money DID move — the caller
   * must record a capture, never a void (review R3).
   */
  voidAuthorization(req: { requestId: string; authorizationId: string }): Promise<{ status: "VOIDED" | "ALREADY_CAPTURED" }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
}

export interface AuthorizeRequest {
  requestId: string;
  vaultId: string;
  /** Our payment id; sent as PayPal `custom_id`/`invoice_id` so webhooks reconcile to it. */
  paymentId: string;
  amountCents: number;
  currency: "USD";
  lines: ResolvedLine[];
  shipTo: Address;
}

export type AuthorizeResult =
  | { ok: true; orderId: string; authorizationId: string; status: string }
  /** PayPal definitively refused (4xx / declined): safe to release the reservation. */
  | { ok: false; definitive: true; error: string };

/** Thrown for outcomes we can't classify (timeouts, 5xx). Callers must retry with the same request id. */
export class ProviderUncertainError extends Error {}

/** Thrown when PayPal definitively rejects a capture/void (4xx). */
export class ProviderRejectedError extends Error {
  constructor(message: string, readonly issue?: string) {
    super(message);
  }
}
