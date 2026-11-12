import { demoMandate } from "@leash/core";
import { useEffect, useRef, useState } from "react";
import { api, ownerAction, signAndCreateMandate, usd, type OwnerIdentity } from "../api";
import { ErrorNote, Mono, OutcomeChip, PaymentState } from "../ui/bits";

interface ScenarioDecision {
  decision_id: string;
  kind: string;
  outcome: string;
  reasons: { code: string; outcome: string; message: string; source: string }[];
  total_cents: number;
  payment_id: string | null;
  payment_state?: string | null;
  approval?: string | null;
  replay_of?: string | null;
  intent_verdict?: { kind: string; rationale?: string };
}
interface Scenario {
  type: "scenario";
  id: string;
  title: string;
  attack: string;
  agent_tried: string;
  request: unknown;
  expect: string;
  decisions: ScenarioDecision[];
  pass: boolean;
  verdict: string;
}
interface Run {
  run_id: string;
  status: "running" | "done" | "error";
  events: (Scenario | { type: string; passed?: number; total?: number; error?: string })[];
  stderr: string;
}

const PLAN = [
  { id: "honest", title: "Honest weekly restock" },
  { id: "poisoned-listing", title: "Prompt injection in a product listing" },
  { id: "tampered-cart", title: "Tampered cart: fake price and category" },
  { id: "off-mandate", title: "Gift-card scam" },
  { id: "replay", title: "Replayed request" },
  { id: "runaway-loop", title: "Runaway loop: six orders at once" },
];

export function RedTeam({ owner, paypalLinked, paypalConfigured, onChanged }: { owner: OwnerIdentity; paypalLinked: boolean; paypalConfigured: boolean; onChanged: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  async function start() {
    setError(null);
    setRun(null);
    try {
      setPhase("Retiring previous demo mandate");
      await api.post("/api/demo/reset", ownerAction(owner, "demo-reset"));
      setPhase("Signing a fresh $400/month mandate in your browser");
      const body = demoMandate({ mandate_id: crypto.randomUUID(), owner_id: owner.owner_id, now: new Date() });
      await signAndCreateMandate(owner, body);
      setPhase("Launching the compromised agent");
      const { run_id } = await api.post<{ run_id: string }>("/api/demo/redteam", ownerAction(owner, "redteam-run", body.mandate_id));
      setPhase("Running attacks");
      timer.current = window.setInterval(async () => {
        try {
          const r = await api.get<Run>(`/api/demo/redteam/${run_id}`);
          setRun(r);
          if (r.status !== "running") {
            clearInterval(timer.current!);
            setPhase(null);
            onChanged();
          }
        } catch (e) {
          setError((e as Error).message);
        }
      }, 500);
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    }
  }

  const scenarios = (run?.events ?? []).filter((e): e is Scenario => e.type === "scenario");
  const done = run?.events.find((e) => e.type === "done") as { passed: number; total: number } | undefined;
  const runErr = run?.events.find((e) => e.type === "error") as { error: string } | undefined;
  const busy = !!phase;

  return (
    <div className="space-y-5">
      <div className="card flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
          <div className="label">Red-team mode</div>
          <h1 className="mt-1 text-2xl font-semibold">Assume the agent is compromised. Does money still stay safe?</h1>
          <p className="mt-2 text-sm text-ink-300">
            One click signs a fresh mandate ($400/month, $250 per order, approval over $150, ship only to the café) and runs a scripted agent that obeys every injection it reads. Same
            script, same result, every run. The honest order is a real PayPal sandbox authorization and capture.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <button className="btn btn-primary px-5 py-3 text-base" disabled={busy || !paypalLinked} onClick={start}>
            {busy ? "Running…" : run ? "Run again" : "Run red team"}
          </button>
          {!paypalLinked && <span className="text-xs text-hold">{paypalConfigured ? "Link a PayPal sandbox account first (Mandate tab)." : "PayPal sandbox is not configured on this server."}</span>}
          {phase && <span className="text-xs text-ink-400">{phase}…</span>}
        </div>
      </div>

      <ErrorNote error={error ?? runErr?.error ?? (run?.status === "error" && !runErr ? run.stderr.slice(-400) || "agent process failed" : null)} />

      {done && (
        <div className={`card rise flex items-center justify-between px-5 py-4 ${done.passed === done.total ? "border-allow/50" : "border-block/50"}`}>
          <div>
            <div className="label">Result</div>
            <div className="mt-1 text-lg font-semibold">
              {done.passed === done.total ? "Every attack contained. The honest order went through." : `${done.total - done.passed} scenario(s) did not behave as expected.`}
            </div>
          </div>
          <div className={`mono text-3xl ${done.passed === done.total ? "text-allow" : "text-block"}`}>
            {done.passed}/{done.total}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {PLAN.map((p, i) => {
          const s = scenarios.find((x) => x.id === p.id);
          return <ScenarioCard key={p.id} index={i + 1} title={p.title} s={s} pending={busy && !s} />;
        })}
      </div>
    </div>
  );
}

function ScenarioCard({ index, title, s, pending }: { index: number; title: string; s?: Scenario; pending: boolean }) {
  const outcomes = s ? [...new Set(s.decisions.map((d) => d.outcome))] : [];
  return (
    <article className={`card flex flex-col ${s ? "rise" : "opacity-60"}`}>
      <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-3">
        <div>
          <div className="mono text-xs text-ink-400">#{index}</div>
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          {s && outcomes.map((o) => <OutcomeChip key={o} outcome={s.decisions[0]?.kind === "replay" ? "REPLAY" : o} size="lg" />)}
          {pending && <span className="mono animate-pulse text-xs text-ink-400">running</span>}
        </div>
      </header>
      {s ? (
        <div className="space-y-3 px-4 py-3 text-sm">
          <Row label="Attack">{s.attack}</Row>
          <Row label="Agent tried">
            <span className="mono text-ink-100">{s.agent_tried}</span>
          </Row>
          <Row label="Gateway">
            <span>{s.verdict}</span>
          </Row>
          {s.decisions.length === 1 ? (
            <Reasons d={s.decisions[0]!} />
          ) : (
            <div className="space-y-1">
              {s.decisions.map((d) => (
                <div key={d.decision_id} className="flex items-center justify-between rounded-md bg-ink-950 px-2 py-1">
                  <span className="flex items-center gap-2">
                    <OutcomeChip outcome={d.outcome} />
                    <Mono>{d.reasons.map((r) => r.code).join(", ") || "within mandate"}</Mono>
                  </span>
                  <PaymentState state={d.payment_state ?? null} approval={d.approval} />
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between border-t border-ink-700 pt-2">
            <span className={`text-xs font-semibold ${s.pass ? "text-allow" : "text-block"}`}>{s.pass ? "✓ behaved as expected" : "✗ unexpected"}</span>
            {s.decisions.length === 1 && <PaymentState state={s.decisions[0]!.payment_state ?? null} approval={s.decisions[0]!.approval} />}
          </div>
        </div>
      ) : (
        <div className="px-4 py-6 text-sm text-ink-400">{pending ? "Waiting for the agent…" : "Not run yet."}</div>
      )}
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3">
      <div className="label pt-0.5">{label}</div>
      <div className="text-ink-300">{children}</div>
    </div>
  );
}

function Reasons({ d }: { d: ScenarioDecision }) {
  if (d.kind === "replay")
    return (
      <div className="rounded-md bg-ink-950 px-3 py-2 text-xs text-ink-300">
        Replay of decision <Mono>{d.replay_of?.slice(0, 8)}</Mono>; same payment <Mono>{d.payment_id?.slice(0, 8) ?? "—"}</Mono>, no new money moved.
      </div>
    );
  if (!d.reasons.length)
    return (
      <div className="rounded-md bg-ink-950 px-3 py-2 text-xs text-ink-300">
        All rules passed · {usd(d.total_cents)} · intent check: <span className="mono">{d.intent_verdict?.kind ?? "—"}</span>
      </div>
    );
  return (
    <ul className="space-y-1">
      {d.reasons.map((r, i) => (
        <li key={i} className="flex gap-2 rounded-md bg-ink-950 px-2 py-1.5 text-xs">
          <span className={`mono shrink-0 font-semibold ${r.outcome === "BLOCK" ? "text-block" : "text-hold"}`}>{r.code}</span>
          <span className="text-ink-300">{r.message}</span>
        </li>
      ))}
    </ul>
  );
}
