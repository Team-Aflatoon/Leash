/**
 * The agent's ONLY capability: HTTP calls to the gateway's /api/agent/* routes with a propose-only token.
 * This package must never import gateway code, a database driver or PayPal credentials (enforced by a test).
 */
export interface AgentEnv {
  gatewayUrl: string;
  token: string;
  mandateId: string;
}

export function envFromProcess(): AgentEnv {
  const gatewayUrl = process.env.GATEWAY_URL;
  const token = process.env.AGENT_TOKEN;
  const mandateId = process.env.MANDATE_ID;
  if (!gatewayUrl || !token || !mandateId) throw new Error("GATEWAY_URL, AGENT_TOKEN and MANDATE_ID are required");
  return { gatewayUrl: gatewayUrl.replace(/\/$/, ""), token, mandateId };
}

export class GatewayClient {
  constructor(private env: AgentEnv) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.env.gatewayUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.env.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(`gateway ${r.status}: ${j.error ?? "error"}`);
    return j;
  }

  catalog(q = "") {
    return this.req<CatalogEntry[]>("GET", `/api/agent/catalog?q=${encodeURIComponent(q)}`);
  }
  mandate() {
    return this.req<Record<string, unknown>>("GET", `/api/agent/mandates/${this.env.mandateId}`);
  }
  propose(body: Record<string, unknown>) {
    return this.req<Decision>("POST", "/api/agent/proposals", { mandate_id: this.env.mandateId, ...body });
  }
  decision(id: string) {
    return this.req<Decision & { payment_state: string | null; approval: string | null }>("GET", `/api/agent/decisions/${id}`);
  }

  /** Wait until the payment for a decision reaches a state worth showing. */
  async settle(decisionId: string, timeoutMs = 45_000) {
    const t0 = Date.now();
    for (;;) {
      const d = await this.decision(decisionId);
      const s = d.payment_state;
      const done = !d.payment_id || s === "CAPTURED" || s === "VOIDED" || s === "FAILED" || (s === "AUTHORIZED" && d.approval === "PENDING");
      if (done || Date.now() - t0 > timeoutMs) return d;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

export interface CatalogEntry {
  sku: string;
  title: string;
  category: string;
  merchant_id: string;
  unit_price_cents: number;
  currency: string;
  description: string;
}

export interface Decision {
  decision_id: string;
  kind: string;
  replay_of: string | null;
  outcome: "ALLOW" | "HOLD" | "BLOCK";
  reasons: { code: string; outcome: string; message: string; source: string }[];
  lines: { sku: string; title: string; quantity: number; unit_price_cents: number; line_total_cents: number }[];
  total_cents: number;
  intent_verdict: { kind: string; rationale?: string };
  payment_id: string | null;
}

export function emit(event: object) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
