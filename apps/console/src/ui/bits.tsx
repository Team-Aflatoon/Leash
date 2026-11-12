import type { ReactNode } from "react";

const OUTCOME_STYLE: Record<string, string> = {
  ALLOW: "bg-allow/12 text-allow ring-allow/40",
  HOLD: "bg-hold/12 text-hold ring-hold/40",
  BLOCK: "bg-block/12 text-block ring-block/40",
};

export function OutcomeChip({ outcome, size = "sm" }: { outcome: string; size?: "sm" | "lg" }) {
  const cls = OUTCOME_STYLE[outcome] ?? "bg-ink-800 text-ink-300 ring-ink-600";
  return (
    <span className={`mono inline-flex items-center rounded-md font-semibold ring-1 ring-inset ${cls} ${size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs"}`}>
      {outcome}
    </span>
  );
}

const STATE_STYLE: Record<string, string> = {
  CAPTURED: "text-allow",
  AUTHORIZED: "text-hold",
  RESERVED: "text-ink-300",
  VOIDED: "text-ink-400",
  FAILED: "text-block",
};

export function PaymentState({ state, approval }: { state: string | null; approval?: string | null }) {
  if (!state) return <span className="text-ink-400 text-xs">no payment</span>;
  const label = state === "AUTHORIZED" && approval === "PENDING" ? "HELD · awaiting you" : state;
  return <span className={`mono text-xs font-medium ${STATE_STYLE[state] ?? "text-ink-300"}`}>{label}</span>;
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "allow" | "hold" | "block"; hint?: string }) {
  const color = tone === "allow" ? "text-allow" : tone === "hold" ? "text-hold" : tone === "block" ? "text-block" : "text-ink-100";
  return (
    <div className="card px-4 py-3">
      <div className="label">{label}</div>
      <div className={`mono mt-1 text-2xl font-medium ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-100">{title}</h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="mono text-xs text-ink-300" title={title}>
      {children}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-block/40 bg-block/10 px-3 py-2 text-sm text-block">{error}</div>;
}
