import { DEMO_INTENT, DEMO_SHIP_TO, MandateBody, type Address } from "@leash/core";
import { useState } from "react";
import { api, ownerAction, signAndCreateMandate, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ErrorNote, Mono, Section } from "../ui/bits";
import { MandateFacts } from "./Overview";

interface Draft {
  intent: string;
  budget: { period: "month"; limit_cents: number };
  per_order_cap_cents: number;
  approval_threshold_cents: number;
  allowed_categories: string[];
  allowed_merchants: string[];
  max_units_per_line: number;
  max_units_per_order: number;
  ship_to: Address | null;
  notes: string[];
  source: "llm" | "template";
}

export function MandateView({ owner, data, paypalConfigured, onChanged }: { owner: OwnerIdentity; data: Dashboard; paypalConfigured: boolean; onChanged: () => void }) {
  const [intent, setIntent] = useState(DEMO_INTENT);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const body = (): MandateBody | null => {
    if (!draft) return null;
    const now = new Date();
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const candidate = {
      v: 1 as const,
      mandate_id: crypto.randomUUID(),
      owner_id: owner.owner_id,
      agent_id: "restock-agent",
      intent: draft.intent,
      currency: "USD" as const,
      budget: draft.budget,
      per_order_cap_cents: draft.per_order_cap_cents,
      approval_threshold_cents: draft.approval_threshold_cents,
      allowed_categories: draft.allowed_categories,
      allowed_merchants: draft.allowed_merchants,
      max_units_per_line: draft.max_units_per_line,
      max_units_per_order: draft.max_units_per_order,
      ship_to: draft.ship_to ?? DEMO_SHIP_TO,
      valid_from: iso(new Date(now.getTime() - 60_000)),
      valid_until: iso(new Date(now.getTime() + days * 86_400_000)),
      issued_at: iso(now),
    };
    const p = MandateBody.safeParse(candidate);
    return p.success ? p.data : null;
  };
  const preview = body();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => draft && setDraft({ ...draft, [k]: v });
  const dollars = (c: number) => (c / 100).toString();
  const toCents = (s: string) => Math.max(0, Math.round(Number(s) * 100) || 0);

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-5">
        <Section title="1 · Link PayPal (one-time consent)">
          {data.owner.paypal_linked ? (
            <p className="text-sm text-allow">✓ PayPal sandbox wallet linked{data.owner.paypal_payer_email ? ` (${data.owner.paypal_payer_email})` : ""}. The gateway can authorize within your mandates without asking again.</p>
          ) : (
            <div className="space-y-3 text-sm text-ink-300">
              <p>
                You approve PayPal once. PayPal stores your wallet in its Vault and gives the gateway a token that only works for merchant-initiated payments. The agent never sees it, and the
                gateway uses it only inside limits you sign.
              </p>
              <button
                className="btn btn-primary"
                disabled={!!busy || !paypalConfigured}
                onClick={() =>
                  run("link", async () => {
                    const r = await api.post<{ approve_url: string }>("/api/owners/paypal/link", ownerAction(owner, "paypal-link"));
                    window.location.href = r.approve_url;
                  })
                }
              >
                {busy === "link" ? "Opening PayPal…" : "Link PayPal sandbox account"}
              </button>
              {!paypalConfigured && <p className="text-xs text-hold">PayPal sandbox credentials are not configured on this server.</p>}
            </div>
          )}
        </Section>

        <Section title="2 · Say what the agent may do">
          <textarea className="field h-28 resize-y" value={intent} onChange={(e) => setIntent(e.target.value)} maxLength={1000} />
          <div className="mt-3 flex items-center gap-3">
            <button className="btn btn-primary" disabled={!!busy || !intent.trim()} onClick={() => run("draft", async () => setDraft(await api.post<Draft>("/api/mandates/draft", { intent, ...ownerAction(owner, "draft") })))}>
              {busy === "draft" ? "Drafting…" : "Draft mandate"}
            </button>
            <span className="text-xs text-ink-400">An LLM turns your words into fields. You review every field before signing; the LLM never signs anything.</span>
          </div>
          {draft && (
            <div className="mt-4 space-y-3">
              {draft.notes.length > 0 && (
                <ul className="rounded-md border border-hold/30 bg-hold/5 px-3 py-2 text-xs text-hold">
                  {draft.notes.map((n, i) => (
                    <li key={i}>• {n}</li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Num label="Monthly budget ($)" value={dollars(draft.budget.limit_cents)} onChange={(v) => set("budget", { period: "month", limit_cents: toCents(v) })} />
                <Num label="Per-order cap ($)" value={dollars(draft.per_order_cap_cents)} onChange={(v) => set("per_order_cap_cents", toCents(v))} />
                <Num label="Ask me above ($)" value={dollars(draft.approval_threshold_cents)} onChange={(v) => set("approval_threshold_cents", toCents(v))} />
                <Num label="Valid for (days)" value={String(days)} onChange={(v) => setDays(Math.max(1, Math.min(365, Number(v) || 1)))} />
                <Num label="Max units per item" value={String(draft.max_units_per_line)} onChange={(v) => set("max_units_per_line", Math.max(1, Number(v) || 1))} />
                <Num label="Max units per order" value={String(draft.max_units_per_order)} onChange={(v) => set("max_units_per_order", Math.max(1, Number(v) || 1))} />
              </div>
              <label className="block">
                <span className="label">Categories (comma separated)</span>
                <input className="field mt-1" value={draft.allowed_categories.join(", ")} onChange={(e) => set("allowed_categories", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
              </label>
              <p className="text-xs text-ink-400">
                Ships only to: {(draft.ship_to ?? DEMO_SHIP_TO).name}, {(draft.ship_to ?? DEMO_SHIP_TO).line1}, {(draft.ship_to ?? DEMO_SHIP_TO).city}
                {!draft.ship_to && " (demo café address)"}. Merchants: {draft.allowed_merchants.join(", ")}.
              </p>
            </div>
          )}
        </Section>
      </div>

      <div className="space-y-5">
        <Section title="3 · Review and sign">
          <ErrorNote error={error} />
          {draft ? (
            preview ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-300">
                  This exact JSON is signed with your Ed25519 key in this browser. Changing any byte later breaks the signature, and the gateway re-checks it on every purchase.
                </p>
                <pre className="mono max-h-80 overflow-auto rounded-md bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-300">{JSON.stringify(preview, null, 2)}</pre>
                <button
                  className="btn btn-primary"
                  disabled={!!busy}
                  onClick={() =>
                    run("sign", async () => {
                      const r = await signAndCreateMandate(owner, preview);
                      setDone(`Signed and active. Mandate ${r.mandate_id.slice(0, 8)}, hash ${r.body_hash.slice(0, 16)}…`);
                      setDraft(null);
                      onChanged();
                    })
                  }
                >
                  Sign &amp; activate ({usd(preview.budget.limit_cents)}/month)
                </button>
                <p className="text-xs text-ink-400">Your other active mandates stay active. Revoke them from Overview.</p>
              </div>
            ) : (
              <p className="text-sm text-block">Some fields are invalid (the per-order cap must not exceed the budget, at least one category).</p>
            )
          ) : (
            <p className="text-sm text-ink-400">Draft a mandate first.</p>
          )}
          {done && <p className="mt-3 text-sm text-allow">{done}</p>}
        </Section>

        <Section title="Your mandates">
          {data.mandates.length === 0 ? (
            <p className="text-sm text-ink-400">None yet.</p>
          ) : (
            <ul className="space-y-4">
              {data.mandates.slice(0, 5).map((m) => (
                <li key={m.mandate_id} className="rounded-lg border border-ink-700 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <Mono>{m.mandate_id}</Mono>
                    <span className={`text-xs font-semibold ${m.revoked_at ? "text-ink-400" : "text-allow"}`}>{m.revoked_at ? `revoked (${m.revocation_reason})` : "active"}</span>
                  </div>
                  {!m.revoked_at && <MandateFacts m={m} />}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Num({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="field mono mt-1" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
