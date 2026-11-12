import { DEMO_INTENT, DEMO_SHIP_TO, MandateBody, type Address } from "@leash/core";
import { useState } from "react";
import { api, ownerAction, signAndCreateMandate, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ErrorNote, Notice, Section } from "../ui/bits";
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
  // One id per draft, so the record shown is exactly the record signed (it doesn't change on refresh).
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
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
      mandate_id: draftId,
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
  const ship = draft?.ship_to ?? DEMO_SHIP_TO;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <h1 className="text-2xl text-fg">Set what the agent may spend</h1>
        <Section title="1. Link PayPal once">
          {data.owner.paypal_linked && data.owner.consent_mode === "hold" ? (
            <div className="space-y-3">
              <Notice tone="good">
                PayPal approved a standing hold{data.owner.paypal_payer_email ? ` from ${data.owner.paypal_payer_email}` : ""}. Each purchase your mandates allow is captured
                from it, with no redirect.
              </Notice>
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="label">Hold</dt>
                  <dd className="mono mt-1 text-fg">{usd(Number(data.owner.paypal_hold_cents ?? 0))}</dd>
                </div>
                <div>
                  <dt className="label">Left</dt>
                  <dd className="mono mt-1 text-good">{usd(Number(data.owner.paypal_hold_remaining_cents ?? 0))}</dd>
                </div>
                <div>
                  <dt className="label">Expires</dt>
                  <dd className="mono mt-1 text-blue">{data.owner.paypal_hold_expires_at ? new Date(data.owner.paypal_hold_expires_at).toLocaleDateString() : "n/a"}</dd>
                </div>
              </dl>
              <p className="text-sm text-dim">PayPal keeps an authorization for up to 29 days. Your mandate limits still decide every purchase; the hold is only the most that can ever be captured.</p>
            </div>
          ) : data.owner.paypal_linked ? (
            <Notice tone="good">
              PayPal sandbox wallet saved{data.owner.paypal_payer_email ? ` (${data.owner.paypal_payer_email})` : ""}. The gateway can charge inside your mandates without asking PayPal again.
            </Notice>
          ) : (
            <div className="space-y-3 text-sm text-fg-2">
              <p>
                You approve PayPal once. Where PayPal allows it, your wallet is saved for merchant-initiated payments; otherwise you approve one standing hold that purchases are
                captured from. Either way the agent never sees it, and the gateway only uses it inside limits you sign.
              </p>
              <button
                className="btn btn-primary"
                aria-busy={busy === "link"}
                disabled={!!busy || !paypalConfigured}
                onClick={() =>
                  run("link", async () => {
                    const r = await api.post<{ approve_url: string }>("/api/owners/paypal/link", ownerAction(owner, "paypal-link"));
                    window.location.href = r.approve_url;
                  })
                }
              >
                {busy === "link" ? "Opening PayPal" : "Link PayPal sandbox account"}
              </button>
              {!paypalConfigured && <p className="text-amber">This server has no PayPal sandbox credentials yet.</p>}
            </div>
          )}
        </Section>

        <Section title="2. Say what it may buy">
          <label className="block space-y-1.5">
            <span className="label">In your own words</span>
            <textarea className="field h-28 resize-y" value={intent} onChange={(e) => setIntent(e.target.value)} maxLength={1000} />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="btn btn-primary"
              aria-busy={busy === "draft"}
              disabled={!!busy || !intent.trim()}
              onClick={() =>
                run("draft", async () => {
                  setDraft(await api.post<Draft>("/api/mandates/draft", { intent, ...ownerAction(owner, "draft") }));
                  setDraftId(crypto.randomUUID());
                })
              }
            >
              {busy === "draft" ? "Drafting" : "Draft the limits"}
            </button>
            <span className="text-sm text-dim">The model fills in the fields. You check each one, and only you sign.</span>
          </div>
          {draft && (
            <div className="mt-5 space-y-4">
              {draft.notes.length > 0 && (
                <Notice tone="amber">
                  <ul className="space-y-1">
                    {draft.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </Notice>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Num label="Monthly budget, $" value={dollars(draft.budget.limit_cents)} onChange={(v) => set("budget", { period: "month", limit_cents: toCents(v) })} />
                <Num label="Most per order, $" value={dollars(draft.per_order_cap_cents)} onChange={(v) => set("per_order_cap_cents", toCents(v))} />
                <Num label="Ask me above, $" value={dollars(draft.approval_threshold_cents)} onChange={(v) => set("approval_threshold_cents", toCents(v))} />
                <Num label="Valid for, days" value={String(days)} onChange={(v) => setDays(Math.max(1, Math.min(365, Number(v) || 1)))} />
                <Num label="Most units per item" value={String(draft.max_units_per_line)} onChange={(v) => set("max_units_per_line", Math.max(1, Number(v) || 1))} />
                <Num label="Most units per order" value={String(draft.max_units_per_order)} onChange={(v) => set("max_units_per_order", Math.max(1, Number(v) || 1))} />
              </div>
              <label className="block space-y-1.5">
                <span className="label">Categories, comma separated</span>
                <input className="field" value={draft.allowed_categories.join(", ")} onChange={(e) => set("allowed_categories", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
              </label>
              <p className="text-sm text-dim">
                Ships only to {ship.name}, {ship.line1}, {ship.city}
                {!draft.ship_to && " (the demo café)"}. Merchants: {draft.allowed_merchants.join(", ")}.
              </p>
            </div>
          )}
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="3. Read it, then sign">
          <div className="space-y-3">
            <ErrorNote error={error} />
            {draft ? (
              preview ? (
                <>
                  <p className="text-sm text-fg-2">This exact record is signed with your key in this browser. Change one byte later and the signature breaks; the gateway checks it on every purchase.</p>
                  <pre className="mono max-h-80 overflow-auto rounded-[var(--radius-pill)] border border-line bg-well p-3 text-xs leading-relaxed text-fg-2">{JSON.stringify(preview, null, 2)}</pre>
                  <button
                    className="btn btn-primary"
                    aria-busy={busy === "sign"}
                    disabled={!!busy}
                    onClick={() =>
                      run("sign", async () => {
                        const r = await signAndCreateMandate(owner, preview);
                        setDone(`Signed and active. Mandate ${r.mandate_id.slice(0, 8)}, hash ${r.body_hash.slice(0, 16)}.`);
                        setDraft(null);
                        onChanged();
                      })
                    }
                  >
                    Sign and activate, {usd(preview.budget.limit_cents)} a month
                  </button>
                  <p className="text-sm text-dim">Your other active mandates stay active. Revoke them on Overview.</p>
                </>
              ) : (
                <p className="text-sm text-stop">Some fields don’t fit together: the per-order limit can’t exceed the budget, and at least one category is needed.</p>
              )
            ) : (
              <p className="text-sm text-dim">Draft the limits first; the record to sign appears here.</p>
            )}
            {done && <Notice tone="good">{done}</Notice>}
          </div>
        </Section>

        <Section title="Your mandates">
          {data.mandates.length === 0 ? (
            <p className="text-sm text-dim">None yet.</p>
          ) : (
            <ul className="space-y-4">
              {data.mandates.slice(0, 5).map((m) => (
                <li key={m.mandate_id} className="rounded-[var(--radius-card)] border border-line p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="mono text-sm text-blue">{m.mandate_id}</span>
                    <span className={`chip ${m.revoked_at ? "" : "chip-allow"}`}>{m.revoked_at ? (m.revocation_reason === "owner" ? "revoked" : "retired") : "active"}</span>
                  </div>
                  {!m.revoked_at && <MandateFacts m={m} narrow />}
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
    <label className="block space-y-1.5">
      <span className="label">{label}</span>
      <input className="field mono" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
