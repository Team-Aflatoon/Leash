import { useState } from "react";
import { decide, revoke, short, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ErrorNote, Mono, OutcomeChip, Section, Stat } from "../ui/bits";

export function Overview({ owner, data, onChanged, goMandate }: { owner: OwnerIdentity; data: Dashboard; onChanged: () => void; goMandate: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const active = data.mandates.find((m) => !m.revoked_at && Date.parse(m.body.valid_until) > Date.now()) ?? null;
  const ds = data.decisions.filter((d) => !active || d.mandate_id === active.mandate_id);
  const pending = data.decisions.filter((d) => d.payment_state === "AUTHORIZED" && d.approval === "PENDING");
  const count = (o: string) => ds.filter((d) => d.kind === "primary" && d.outcome === o).length;
  const blockedAll = ds.filter((d) => d.outcome === "BLOCK").length;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <ErrorNote error={error} />
      {active ? <BudgetCard m={active} /> : <NoMandate goMandate={goMandate} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Allowed" value={count("ALLOW")} tone="allow" hint="paid within the mandate" />
        <Stat label="Held for you" value={count("HOLD")} tone="hold" hint="authorized, not captured" />
        <Stat label="Blocked" value={blockedAll} tone="block" hint="incl. replays & malformed" />
        <Stat label="Replays caught" value={ds.filter((d) => d.kind === "replay").length} hint="no second payment" />
      </div>

      <Section title={`Pending approvals (${pending.length})`}>
        {pending.length === 0 ? (
          <p className="text-sm text-ink-400">Nothing is waiting for you. Orders over the approval threshold, duplicates and anything the intent check flags land here.</p>
        ) : (
          <ul className="divide-y divide-ink-700">
            {pending.map((d) => (
              <li key={d.decision_id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <OutcomeChip outcome="HOLD" />
                    <span className="mono font-medium">{usd(d.total_cents)}</span>
                    <span className="truncate text-sm text-ink-300">{d.lines.map((l) => `${l.quantity} × ${l.title}`).join(", ")}</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-400">
                    {d.reasons.map((r) => r.message).join(" ")} · PayPal authorization <Mono>{short(d.paypal_authorization_id, 10)}</Mono>
                    {d.approval_expires_at && <> · auto-void {new Date(d.approval_expires_at).toLocaleTimeString()}</>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn btn-ghost" disabled={!!busy} onClick={() => act(d.payment_id!, () => decide(owner, d.payment_id!, "reject"))}>
                    Reject &amp; void
                  </button>
                  <button className="btn btn-primary" disabled={!!busy} onClick={() => act(d.payment_id!, () => decide(owner, d.payment_id!, "approve"))}>
                    Approve &amp; capture
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-400">Approvals are signed with your key in this browser. The agent has no key, so it cannot approve its own orders.</p>
      </Section>

      {active && (
        <Section
          title="Active mandate"
          right={
            <button className="btn btn-danger" disabled={!!busy} onClick={() => confirm("Revoke this mandate now? Open holds are voided and the agent is cut off immediately.") && act("revoke", () => revoke(owner, active.mandate_id))}>
              Pull the leash (revoke)
            </button>
          }
        >
          <MandateFacts m={active} />
        </Section>
      )}
    </div>
  );
}

function NoMandate({ goMandate }: { goMandate: () => void }) {
  return (
    <div className="card flex items-center justify-between p-5">
      <div>
        <div className="label">No active mandate</div>
        <p className="mt-1 text-sm text-ink-300">The agent can't spend anything until you sign one. Running the red team signs a demo mandate for you.</p>
      </div>
      <button className="btn btn-primary" onClick={goMandate}>
        Create a mandate
      </button>
    </div>
  );
}

function BudgetCard({ m }: { m: Dashboard["mandates"][number] }) {
  const limit = m.body.budget.limit_cents;
  const cap = (n: number) => `${Math.min(100, (Number(n) / limit) * 100)}%`;
  const left = limit - Number(m.captured_cents) - Number(m.held_cents);
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">Spend this month vs signed budget</div>
          <div className="mono mt-1 text-3xl">
            {usd(Number(m.captured_cents) + Number(m.held_cents))} <span className="text-lg text-ink-400">/ {usd(limit)}</span>
          </div>
        </div>
        <div className="text-right text-sm text-ink-300">
          <div>
            <span className="text-allow">■</span> captured {usd(m.captured_cents)} · <span className="text-hold">■</span> held {usd(m.held_cents)}
          </div>
          <div className="mono text-ink-100">{usd(left)} left</div>
        </div>
      </div>
      <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-ink-800" role="img" aria-label="budget usage">
        <div className="bg-allow transition-all" style={{ width: cap(m.captured_cents) }} />
        <div className="bg-hold transition-all" style={{ width: cap(m.held_cents) }} />
      </div>
    </div>
  );
}

export function MandateFacts({ m }: { m: Dashboard["mandates"][number] }) {
  const b = m.body;
  const facts: [string, string][] = [
    ["Intent", b.intent],
    ["Budget", `${usd(b.budget.limit_cents)} per calendar month`],
    ["Per-order cap", usd(b.per_order_cap_cents)],
    ["Ask me above", usd(b.approval_threshold_cents)],
    ["Categories", b.allowed_categories.join(", ")],
    ["Merchants", b.allowed_merchants.join(", ")],
    ["Quantity limits", `${b.max_units_per_line} per item, ${b.max_units_per_order} per order`],
    ["Ship only to", `${b.ship_to.name}, ${b.ship_to.line1}, ${b.ship_to.city} ${b.ship_to.state} ${b.ship_to.postal_code}`],
    ["Valid", `${new Date(b.valid_from).toLocaleString()} → ${new Date(b.valid_until).toLocaleString()}`],
    ["Agent", b.agent_id],
  ];
  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
      {facts.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[120px_1fr] gap-2 text-sm">
          <div className="label pt-0.5">{k}</div>
          <div className="text-ink-100">{v}</div>
        </div>
      ))}
      <div className="grid grid-cols-[120px_1fr] gap-2 text-sm md:col-span-2">
        <div className="label pt-0.5">Signed</div>
        <div className="space-y-0.5">
          <div>
            <Mono title={m.body_hash}>sha256 {short(m.body_hash, 24)}</Mono>
          </div>
          <div>
            <Mono title={m.signature}>ed25519 {short(m.signature, 32)}</Mono>
          </div>
        </div>
      </div>
    </div>
  );
}
