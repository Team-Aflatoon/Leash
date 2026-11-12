import { demoMandate } from "@leash/core";
import { useEffect, useRef, useState } from "react";
import { api, ownerAction, signAndCreateMandate, usd, type OwnerIdentity } from "../api";
import { ErrorNote } from "../ui/bits";

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
  { id: "poisoned-listing", title: "Prompt injection in a listing" },
  { id: "tampered-cart", title: "Tampered price and category" },
  { id: "off-mandate", title: "Gift-card scam" },
  { id: "replay", title: "Replayed request" },
  { id: "runaway-loop", title: "Six orders at once" },
];
const BUDGET_CENTS = 40_000;

export function RedTeam({ owner, paypalLinked, paypalConfigured, onChanged }: { owner: OwnerIdentity; paypalLinked: boolean; paypalConfigured: boolean; onChanged: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  async function start() {
    setError(null);
    setRun(null);
    setOpen(null);
    try {
      setPhase("Retiring the previous demo mandate");
      await api.post("/api/demo/reset", ownerAction(owner, "demo-reset"));
      setPhase("Signing a fresh $400 a month mandate in this browser");
      const body = demoMandate({ mandate_id: crypto.randomUUID(), owner_id: owner.owner_id, now: new Date() });
      await signAndCreateMandate(owner, body);
      setPhase("Starting the compromised agent");
      const { run_id } = await api.post<{ run_id: string }>("/api/demo/redteam", ownerAction(owner, "redteam-run", body.mandate_id));
      setPhase("The agent is attacking");
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

  // The reading: money that actually moved or is held, from the decisions themselves (replays excluded).
  const seen = new Set<string>();
  let moved = 0;
  let held = 0;
  for (const s of scenarios)
    for (const d of s.decisions) {
      if (!d.payment_id || seen.has(d.payment_id)) continue;
      seen.add(d.payment_id);
      if (d.payment_state === "CAPTURED") moved += d.total_cents;
      else if (d.payment_state === "AUTHORIZED" || d.payment_state === "RESERVED") held += d.total_cents;
    }
  const blocked = scenarios.flatMap((s) => s.decisions).filter((d) => d.outcome === "BLOCK").length;

  return (
    <div className="space-y-6">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-3">
          <h1 className="max-w-none text-3xl text-fg">Assume the agent is compromised.</h1>
          <p className="max-w-[60ch] text-fg-2">
            A scripted attacker obeys every injection it reads. Same script, same result, every run. The honest order is a real PayPal sandbox payment.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button className="btn btn-primary btn-lg" aria-busy={busy} disabled={busy || !paypalLinked} onClick={start}>
              {busy ? "Running" : run ? "Run again" : "Run red team"}
            </button>
            <span className="text-sm text-dim" role="status" aria-live="polite">
              {phase ?? (!paypalLinked ? (paypalConfigured ? "Link a PayPal sandbox account on the Mandate tab first." : "This server has no PayPal sandbox credentials.") : "Signs a fresh mandate: $400 a month, $250 an order, ask above $150.")}
            </span>
          </div>
        </div>

        <dl className="panels grid-cols-2 lg:min-w-[440px]">
          <div className="p-4">
            <dt className="label">Money moved</dt>
            <dd className="reading mt-2 text-4xl">{run ? usd(moved) : "—"}</dd>
            <dd className="mt-1 text-sm text-dim">
              of <span className="mono">{usd(BUDGET_CENTS)}</span> this month
            </dd>
          </div>
          <div className="p-4">
            <dt className="label">Waiting for you</dt>
            <dd className={`reading mt-2 text-4xl ${held ? "text-amber" : ""}`}>{run ? usd(held) : "—"}</dd>
            <dd className="mt-1 text-sm text-dim">{run ? `${blocked} attempts blocked` : "authorized, not captured"}</dd>
          </div>
        </dl>
      </section>

      <ErrorNote error={error ?? runErr?.error ?? (run?.status === "error" && !runErr ? run.stderr.slice(-400) || "The agent process stopped unexpectedly." : null)} />

      <section aria-labelledby="log-head" className="panels">
        <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
          <h2 id="log-head" className="text-lg text-fg">
            Attack log
          </h2>
          <p className="text-sm text-dim" role="status">
            {done ? (
              <span className={done.passed === done.total ? "text-good" : "text-stop"}>
                {done.passed} of {done.total} handled as expected
              </span>
            ) : busy ? (
              "Recording"
            ) : (
              "Six attempts, recorded as the gateway decides them"
            )}
          </p>
        </header>
        <div className="hidden grid-cols-[2.25rem_minmax(0,1.1fr)_minmax(0,1.6fr)_8.5rem_10rem_1.25rem] gap-4 px-4 py-2 text-sm text-dim md:grid" aria-hidden>
          <span />
          <span>Attempt</span>
          <span>What the agent sent</span>
          <span>Gateway</span>
          <span>Money</span>
          <span />
        </div>
        {PLAN.map((p, i) => {
          const s = scenarios.find((x) => x.id === p.id);
          return <LogRow key={p.id} index={i + 1} title={p.title} s={s} pending={busy && !s} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />;
        })}
      </section>
    </div>
  );
}

function verdictOf(d: ScenarioDecision) {
  return d.kind === "replay" ? "REPLAY" : d.outcome;
}

function Chip({ v }: { v: string }) {
  const cls = v === "ALLOW" ? "chip-allow" : v === "HOLD" ? "chip-hold" : v === "BLOCK" ? "chip-block" : v === "REPLAY" ? "chip-replay" : "";
  return <span className={`chip ${cls}`}>{v}</span>;
}

function money(d: ScenarioDecision): { text: string; tone: string } {
  if (d.kind === "replay") return { text: "No new payment", tone: "text-dim" };
  switch (d.payment_state) {
    case "CAPTURED":
      return { text: `Captured ${usd(d.total_cents)}`, tone: "text-good" };
    case "AUTHORIZED":
      return d.approval === "PENDING" ? { text: `Held ${usd(d.total_cents)}`, tone: "text-amber" } : { text: `Authorized ${usd(d.total_cents)}`, tone: "text-fg-2" };
    case "RESERVED":
      return { text: "Authorizing", tone: "text-dim" };
    case "VOIDED":
      return { text: "Hold released", tone: "text-dim" };
    case "FAILED":
      return { text: "PayPal refused", tone: "text-stop" };
    default:
      return { text: "Nothing reached PayPal", tone: "text-dim" };
  }
}

function LogRow({ index, title, s, pending, open, onToggle }: { index: number; title: string; s?: Scenario; pending: boolean; open: boolean; onToggle: () => void }) {
  const first = s?.decisions[0];
  const verdicts = s ? [...new Set(s.decisions.map(verdictOf))] : [];
  const m = first ? money(first) : null;
  const regionId = `log-${index}`;
  return (
    <div className={s ? "rise" : ""}>
      <button
        className="log-row grid grid-cols-[2.25rem_minmax(0,1fr)_1.25rem] items-start gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[2.25rem_minmax(0,1.1fr)_minmax(0,1.6fr)_8.5rem_10rem_1.25rem] md:items-center"
        aria-expanded={open}
        aria-controls={regionId}
        disabled={!s}
        onClick={onToggle}
      >
        <span className="mono text-sm text-dim">{String(index).padStart(2, "0")}</span>
        <span className="font-medium text-fg">{title}</span>
        <span className="col-start-2 truncate text-sm text-fg-2 md:col-start-auto">
          {s ? s.agent_tried : <span className="text-dim">{pending ? "Waiting for the agent" : "Not run yet"}</span>}
        </span>
        <span className="col-start-2 flex flex-wrap gap-1 md:col-start-auto">{s ? verdicts.map((v) => <Chip key={v} v={v} />) : null}</span>
        <span className={`col-start-2 text-sm md:col-start-auto ${m?.tone ?? "text-dim"}`}>{s ? (s.decisions.length > 1 ? s.verdict.split(".")[0] : m?.text) : ""}</span>
        <svg className={`caret col-start-3 row-start-1 h-4 w-4 text-dim md:col-start-auto md:row-start-auto ${s ? "" : "invisible"}`} viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {s && open && (
        <div id={regionId} className="grid gap-4 bg-ground px-4 pb-5 pt-1 md:grid-cols-[2.25rem_minmax(0,1fr)] md:gap-x-4">
          <div className="hidden md:block" />
          <div className="space-y-4">
            <Fact label="The attack">{s.attack}</Fact>
            <Fact label="What the gateway did">
              <span className={s.pass ? "text-fg" : "text-stop"}>{s.verdict}</span>
            </Fact>
            {s.decisions.length === 1 ? <Reasons d={s.decisions[0]!} /> : <Orders ds={s.decisions} />}
            <p className={`text-sm ${s.pass ? "text-good" : "text-stop"}`}>{s.pass ? "Handled as expected." : `Not what we expected: ${s.expect}.`}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-4">
      <div className="label">{label}</div>
      <div className="max-w-[72ch] text-sm text-fg-2">{children}</div>
    </div>
  );
}

function Reasons({ d }: { d: ScenarioDecision }) {
  if (d.kind === "replay")
    return (
      <Fact label="Why">
        Same request as attempt 01. The original decision <span className="mono text-blue">{d.replay_of?.slice(0, 8)}</span> was returned and payment{" "}
        <span className="mono text-blue">{d.payment_id?.slice(0, 8) ?? "none"}</span> was not charged again.
      </Fact>
    );
  const blocks = d.reasons.filter((r) => r.outcome === "BLOCK");
  const flags = d.reasons.filter((r) => r.outcome !== "BLOCK");
  if (!d.reasons.length)
    return (
      <Fact label="Why">
        Every rule passed for <span className="mono">{usd(d.total_cents)}</span>. Intent check: <span className="mono text-blue">{d.intent_verdict?.kind ?? "none"}</span>.
      </Fact>
    );
  return (
    <>
      {blocks.length > 0 && (
        <Fact label="Blocked because">
          <ul className="space-y-1.5">
            {blocks.map((r, i) => (
              <li key={i} className="grid gap-x-3 md:grid-cols-[13rem_minmax(0,1fr)]">
                <span className="mono text-stop">{r.code}</span>
                <span>{r.message}</span>
              </li>
            ))}
          </ul>
        </Fact>
      )}
      {flags.length > 0 && (
        <Fact label={blocks.length ? "Would also need you" : "Held because"}>
          <ul className="space-y-1.5">
            {flags.map((r, i) => (
              <li key={i} className="grid gap-x-3 md:grid-cols-[13rem_minmax(0,1fr)]">
                <span className="mono text-amber">{r.code}</span>
                <span>{r.message}</span>
              </li>
            ))}
          </ul>
        </Fact>
      )}
    </>
  );
}

function Orders({ ds }: { ds: ScenarioDecision[] }) {
  return (
    <Fact label="Each order">
      <ol className="panels">
        {ds.map((d, i) => {
          const m = money(d);
          return (
            <li key={d.decision_id} className="grid grid-cols-[2rem_4.5rem_minmax(0,1fr)] items-center gap-3 px-3 py-2 md:grid-cols-[2rem_4.5rem_minmax(0,1fr)_10rem]">
              <span className="mono text-dim">{i + 1}</span>
              <Chip v={verdictOf(d)} />
              <span className="mono truncate text-xs text-fg-2">{d.reasons.map((r) => r.code).join(", ") || "Within the mandate"}</span>
              <span className={`col-start-3 text-sm md:col-start-auto ${m.tone}`}>{m.text}</span>
            </li>
          );
        })}
      </ol>
    </Fact>
  );
}
