import { generateKeyPair, signJson, type MandateBody, type OwnerAction, type SignPurpose } from "@leash/core";

/**
 * The owner's Ed25519 key is generated and kept in this browser. The gateway only ever sees the public key, so it
 * cannot forge a mandate, an approval or a revocation.
 */
export interface OwnerIdentity {
  owner_id: string;
  display_name: string;
  public_key_hex: string;
  secret_key_hex: string;
}

const KEY = "leash.owner.v1";

export function loadOwner(): OwnerIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OwnerIdentity) : null;
  } catch {
    return null;
  }
}

export function saveOwner(o: OwnerIdentity | null) {
  try {
    if (o) localStorage.setItem(KEY, JSON.stringify(o));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: key lives only in memory for this tab */
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export const api = {
  get: <T,>(p: string) => call<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => call<T>("POST", p, b ?? {}),
};

export async function createOwner(display_name: string): Promise<OwnerIdentity> {
  const kp = generateKeyPair();
  const r = await api.post<{ owner_id: string }>("/api/owners", { display_name, public_key_hex: kp.publicKeyHex });
  const o = { owner_id: r.owner_id, display_name, public_key_hex: kp.publicKeyHex, secret_key_hex: kp.secretKeyHex };
  saveOwner(o);
  return o;
}

export const sign = (o: OwnerIdentity, purpose: SignPurpose, value: unknown) => signJson(purpose, value, o.secret_key_hex);
const iso = () => new Date().toISOString();

export function ownerAction(o: OwnerIdentity, action: OwnerAction["action"], target?: string) {
  const statement: OwnerAction = { owner_id: o.owner_id, action, signed_at: iso(), ...(target ? { target } : {}) };
  return { statement, signature: sign(o, "owner-action", statement) };
}

export async function signAndCreateMandate(o: OwnerIdentity, body: MandateBody) {
  return api.post<{ mandate_id: string; body_hash: string }>("/api/mandates", { body, signature: sign(o, "mandate", body) });
}

export async function revoke(o: OwnerIdentity, mandate_id: string) {
  const statement = { mandate_id, revoked_at: iso() };
  return api.post("/api/mandates/revoke", { statement, signature: sign(o, "revocation", statement) });
}

export async function decide(o: OwnerIdentity, payment_id: string, decision: "approve" | "reject") {
  const statement = { payment_id, decision, signed_at: iso() };
  return api.post("/api/payments/approval", { statement, signature: sign(o, "approval", statement) });
}

// ---- server shapes ------------------------------------------------------------------------------------------------
export interface ServerConfig {
  demo_mode: boolean;
  paypal_configured: boolean;
  llm_configured: boolean;
  payment_provider: string;
  gateway_public_key_hex: string;
  agent_id: string;
}

export interface Reason {
  code: string;
  outcome: "ALLOW" | "HOLD" | "BLOCK";
  message: string;
  source: "rules" | "llm";
}

export interface DecisionRow {
  decision_id: string;
  kind: string;
  replay_of: string | null;
  agent_id: string;
  idempotency_key: string | null;
  mandate_id: string | null;
  request_body: Record<string, unknown>;
  outcome: "ALLOW" | "HOLD" | "BLOCK";
  reasons: Reason[];
  lines: { sku: string; title: string; quantity: number; unit_price_cents: number; line_total_cents: number }[];
  total_cents: number;
  intent_verdict: { kind: string; rationale?: string; cached?: boolean; error?: string };
  created_at: string;
  payment_id: string | null;
  payment_state: string | null;
  approval: string | null;
  approval_expires_at: string | null;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  reconciliation: string | null;
  reconciliation_note: string | null;
  last_error: string | null;
}

export interface MandateRow {
  mandate_id: string;
  body: MandateBody;
  body_hash: string;
  signature: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  captured_cents: number;
  held_cents: number;
}

export interface Dashboard {
  owner: { owner_id: string; display_name: string; public_key_hex: string; paypal_linked: boolean; paypal_payer_email: string | null };
  period_start: string;
  mandates: MandateRow[];
  decisions: DecisionRow[];
}

export const usd = (cents: number) => `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const short = (s: string | null | undefined, n = 8) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "—");
