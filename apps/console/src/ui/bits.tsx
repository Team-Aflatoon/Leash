import type { ReactNode } from "react";

const CHIP: Record<string, string> = { ALLOW: "chip-allow", HOLD: "chip-hold", BLOCK: "chip-block", REPLAY: "chip-replay" };

/** A verdict the gateway wrote. Always text, never colour alone. */
export function OutcomeChip({ outcome }: { outcome: string; size?: "sm" | "lg" }) {
  return <span className={`chip ${CHIP[outcome] ?? ""}`}>{outcome}</span>;
}

const STATE: Record<string, { text: string; tone: string }> = {
  CAPTURED: { text: "Captured", tone: "text-good" },
  AUTHORIZED: { text: "Authorized", tone: "text-fg-2" },
  RESERVED: { text: "Authorizing", tone: "text-dim" },
  VOIDED: { text: "Hold released", tone: "text-dim" },
  FAILED: { text: "PayPal refused", tone: "text-stop" },
};

export function PaymentState({ state, approval }: { state: string | null; approval?: string | null }) {
  if (!state) return <span className="text-sm text-dim">No payment</span>;
  if (state === "AUTHORIZED" && approval === "PENDING") return <span className="text-sm text-amber">Held, waiting for you</span>;
  const s = STATE[state] ?? { text: state, tone: "text-fg-2" };
  return <span className={`text-sm ${s.tone}`}>{s.text}</span>;
}

/** A figure and its label. Tabular numerals, no icon tile. */
export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "allow" | "hold" | "block"; hint?: string }) {
  const color = tone === "allow" ? "text-good" : tone === "hold" ? "text-amber" : tone === "block" ? "text-stop" : "text-fg";
  return (
    <div className="p-4">
      <div className="label">{label}</div>
      <div className={`reading mt-2 text-3xl ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-sm text-dim">{hint}</div>}
    </div>
  );
}

export function Section({ title, right, children, id }: { title: string; right?: ReactNode; children: ReactNode; id?: string }) {
  const hid = id ?? `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="panels" aria-labelledby={hid}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <h2 id={hid} className="text-lg text-fg">
          {title}
        </h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Mono({ children, title, tone = "text-blue" }: { children: ReactNode; title?: string; tone?: string }) {
  return (
    <span className={`mono text-sm ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-[var(--radius-pill)] border border-stop/40 bg-stop-soft px-3 py-2 text-sm text-stop">
      {error}
    </div>
  );
}

export function Notice({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "amber" | "good" }) {
  const cls = tone === "amber" ? "border-amber/40 bg-amber-soft text-amber" : tone === "good" ? "border-good/40 bg-good-soft text-good" : "border-blue/40 bg-blue-soft text-blue";
  return (
    <div role="status" className={`rounded-[var(--radius-pill)] border px-3 py-2 text-sm ${cls}`}>
      {children}
    </div>
  );
}

/** A destructive action asks inline, never through a browser dialog. */
export function ConfirmButton({ label, confirmLabel, prompt, onConfirm, disabled }: { label: string; confirmLabel: string; prompt: string; onConfirm: () => void; disabled?: boolean }) {
  return (
    <details className="group relative">
      <summary className="btn btn-danger list-none [&::-webkit-details-marker]:hidden" aria-disabled={disabled}>
        {label}
      </summary>
      <div className="panels absolute right-0 z-[var(--z-dropdown)] mt-2 w-80">
        <div className="space-y-3 p-4">
          <p className="text-sm text-fg-2">{prompt}</p>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={(e) => ((e.currentTarget.closest("details") as HTMLDetailsElement).open = false)}>
              Keep it
            </button>
            <button className="btn btn-danger" disabled={disabled} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
