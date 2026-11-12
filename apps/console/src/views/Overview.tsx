import { useState } from "react";
import { decide, revoke, short, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ConfirmButton, ErrorNote, Mono, Notice, OutcomeChip, Section, Stat } from "../ui/bits";

export function Overview({ owner, data, onChanged, goMandate }: { owner: OwnerIdentity; data: Dashboard; onChanged: () => void; goMandate: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const active = data.mandates.find((m) => !m.revoked_at && Date.parse(m.body.valid_until) > Date.now()) ?? null;
  const ds = data.decisions.filter((d) => !active || d.mandate_id === active.mandate_id);
  const pending = data.decisions.filter((d) => d.payment_state === "AUTHORIZED" && d.approval === "PENDING");
  const count = (o: string) => ds.filter((d) => d.kind === "primary" && d.outcome === o).length;

  const act = async (id: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(id);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(success);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <ErrorNote error={error} />
      {done && <Notice tone="good">{done}</Notice>}

      {active ? <Budget m={active} /> : <NoMandate goMandate={goMandate} />}

      <Section title={pending.length ? `Waiting for you (${pending.length})` : "Waiting for you"}>
        {pending.length === 0 ? (
          <p className="text-sm text-dim">Nothing is waiting. Orders over your approval threshold, suspected duplicates and anything the intent check flags arrive here, already authorized at PayPal.</p>
        ) : (
          <ul className="panels">
            {pending.map((d) => (
              <li key={d.decision_id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="reading text-xl text-amber">{usd(d.total_cents)}</span>
                    <span className="truncate text-fg">{d.lines.map((l) => `${l.quantity} × ${l.title}`).join(", ")}</span>
                  </div>
                  <p className="text-sm text-dim">
                    {d.reasons.map((r) => r.message).join(" ")} Authorization <Mono>{short(d.paypal_authorization_id, 12)}</Mono>
                    {d.approval_expires_at && <>, released automatically at <Mono>{new Date(d.approval_expires_at).toLocaleTimeString()}</Mono></>}.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn" aria-busy={busy === d.payment_id} disabled={!!busy} onClick={() => act(d.payment_id!, () => decide(owner, d.payment_id!, "reject"), "Rejected. The PayPal hold is being released.")}>
                    Reject and release
                  </button>
                  <button className="btn btn-primary" aria-busy={busy === d.payment_id} disabled={!!busy} onClick={() => act(d.payment_id!, () => decide(owner, d.payment_id!, "approve"), "Approved. Capturing the payment now.")}>
                    Approve and capture
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-dim">You sign each decision with the key in this browser. The agent has no key, so it cannot approve its own orders.</p>
      </Section>

      <dl className="panels grid-cols-2 md:grid-cols-4">
        <Stat label="Allowed" value={count("ALLOW")} tone="allow" hint="paid within the mandate" />
        <Stat label="Sent to you" value={count("HOLD")} tone="hold" hint="verdicts that needed approval" />
        <Stat label="Blocked" value={ds.filter((d) => d.outcome === "BLOCK").length} tone="block" hint="including malformed and conflicts" />
        <Stat label="Replays caught" value={ds.filter((d) => d.kind === "replay").length} hint="no second payment" />
      </dl>

      {active && (
        <Section
          title="Active mandate"
          right={
            <ConfirmButton
              label="Revoke mandate"
              confirmLabel="Revoke now"
              prompt="The agent is cut off at once and every open hold is released at PayPal. You can sign a new mandate any time."
              disabled={!!busy}
              onConfirm={() => act("revoke", () => revoke(owner, active.mandate_id), "Revoked. The agent can no longer spend, and open holds are being released.")}
            />
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
    <div className="panels">
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="space-y-1">
          <h1 className="text-2xl text-fg">No active mandate</h1>
          <p className="text-fg-2">The agent cannot spend anything until you sign one. Running the red team signs a demo mandate for you.</p>
        </div>
        <button className="btn btn-primary" onClick={goMandate}>
          Create a mandate
        </button>
      </div>
    </div>
  );
}

function Budget({ m }: { m: Dashboard["mandates"][number] }) {
  const limit = m.body.budget.limit_cents;
  const captured = Number(m.captured_cents);
  const held = Number(m.held_cents);
  const pct = (n: number) => `${Math.min(100, (n / limit) * 100)}%`;
  return (
    <section className="panels" aria-labelledby="budget-head">
      <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div>
          <h1 id="budget-head" className="max-w-none text-lg text-fg-2">
            Spent this month against the signed budget
          </h1>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3">
            <span className="reading text-5xl">{usd(captured + held)}</span>
            <span className="mono text-xl text-dim">of {usd(limit)}</span>
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6 text-sm">
          <div>
            <dt className="label">Captured</dt>
            <dd className="mono mt-1 text-good">{usd(captured)}</dd>
          </div>
          <div>
            <dt className="label">Held</dt>
            <dd className="mono mt-1 text-amber">{usd(held)}</dd>
          </div>
          <div>
            <dt className="label">Left</dt>
            <dd className="mono mt-1 text-fg">{usd(limit - captured - held)}</dd>
          </div>
        </dl>
      </div>
      <div className="px-5 pb-5">
        <div className="flex h-2 overflow-hidden rounded-full bg-well" role="img" aria-label={`${usd(captured)} captured and ${usd(held)} held of ${usd(limit)}`}>
          <div className="bg-good" style={{ width: pct(captured) }} />
          <div className="bg-amber" style={{ width: pct(held) }} />
        </div>
      </div>
    </section>
  );
}

export function MandateFacts({ m, narrow = false }: { m: Dashboard["mandates"][number]; narrow?: boolean }) {
  const b = m.body;
  const facts: [string, React.ReactNode][] = [
    ["What it may do", b.intent],
    ["Budget", <span className="mono">{usd(b.budget.limit_cents)} a month</span>],
    ["Per order", <span className="mono">{usd(b.per_order_cap_cents)}</span>],
    ["Ask me above", <span className="mono">{usd(b.approval_threshold_cents)}</span>],
    ["Categories", b.allowed_categories.join(", ")],
    ["Merchants", b.allowed_merchants.join(", ")],
    ["Quantities", `${b.max_units_per_line} per item, ${b.max_units_per_order} per order`],
    ["Ships only to", `${b.ship_to.name}, ${b.ship_to.line1}, ${b.ship_to.city} ${b.ship_to.state} ${b.ship_to.postal_code}`],
    ["Valid until", <span className="mono text-blue">{new Date(b.valid_until).toLocaleString()}</span>],
    ["Signed hash", <Mono title={m.body_hash}>sha256 {short(m.body_hash, 24)}</Mono>],
    ["Signature", <Mono title={m.signature}>ed25519 {short(m.signature, 32)}</Mono>],
  ];
  return (
    <dl className={`grid gap-x-8 gap-y-3 ${narrow ? "" : "md:grid-cols-2"}`}>
      {facts.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 text-sm">
          <dt className="label">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export { OutcomeChip };
