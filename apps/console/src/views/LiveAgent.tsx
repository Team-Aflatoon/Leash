import { useEffect, useRef, useState } from "react";
import { api, ownerAction, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ErrorNote, OutcomeChip, Section } from "../ui/bits";

interface Ev {
  type: string;
  name?: string;
  input?: unknown;
  result?: { outcome?: string; reasons?: { code: string; message: string }[]; total_cents?: number } & Record<string, unknown>;
  error?: string;
  text?: string;
}

export function LiveAgent({ owner, data, llm, onChanged }: { owner: OwnerIdentity; data: Dashboard; llm: boolean; onChanged: () => void }) {
  const active = data.mandates.find((m) => !m.revoked_at && Date.parse(m.body.valid_until) > Date.now());
  const [task, setTask] = useState("Do this week's restock. We're low on espresso beans and oat milk, and the vanilla syrup is nearly gone.");
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const start = async () => {
    if (!active) return;
    setError(null);
    setEvents([]);
    try {
      const { run_id } = await api.post<{ run_id: string }>("/api/demo/live", { ...ownerAction(owner, "redteam-run", active.mandate_id), task });
      setStatus("running");
      timer.current = window.setInterval(async () => {
        const r = await api.get<{ status: string; events: Ev[]; stderr: string }>(`/api/demo/redteam/${run_id}`);
        setEvents(r.events);
        if (r.status !== "running") {
          clearInterval(timer.current!);
          setStatus(null);
          if (r.status === "error" && !r.events.some((e) => e.type === "error")) setError(r.stderr.slice(-300) || "agent failed");
          onChanged();
        }
      }, 700);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
      <Section title="Live Claude agent">
        <p className="mb-3 text-sm text-ink-300">
          A real Claude agent with three tools: read its mandate, search the catalog, propose an order. It reads merchant descriptions, including the poisoned one. Whatever it decides,
          the gateway has the final word. Live runs vary; red-team mode is the deterministic demo.
        </p>
        <textarea className="field h-28" value={task} onChange={(e) => setTask(e.target.value)} maxLength={1000} />
        <button className="btn btn-primary mt-3" disabled={!llm || !active || !!status} onClick={start}>
          {status ? "Agent working…" : "Send to agent"}
        </button>
        {!llm && <p className="mt-2 text-xs text-hold">No LLM key configured on this server.</p>}
        {!active && <p className="mt-2 text-xs text-hold">Sign a mandate first.</p>}
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      </Section>
      <Section title="Transcript">
        {events.length === 0 ? (
          <p className="text-sm text-ink-400">{status ? "Waiting for the first tool call…" : "No run yet."}</p>
        ) : (
          <ol className="space-y-3">
            {events.map((e, i) => (
              <li key={i} className="rise rounded-lg border border-ink-700 bg-ink-950 p-3 text-sm">
                {e.type === "tool" && (
                  <>
                    <div className="mono text-xs text-accent">→ {e.name}</div>
                    <pre className="mono mt-1 overflow-auto text-[11px] text-ink-300">{JSON.stringify(e.input)}</pre>
                    {e.name === "propose_order" && e.result?.outcome ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <OutcomeChip outcome={e.result.outcome} />
                        <span className="mono text-xs">{usd(e.result.total_cents ?? 0)}</span>
                        <span className="text-xs text-ink-300">{e.result.reasons?.map((r) => r.message).join(" ") || "Within mandate."}</span>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-ink-400">{e.error ? `error: ${e.error}` : `${Array.isArray(e.result) ? `${e.result.length} results` : "ok"}`}</div>
                    )}
                  </>
                )}
                {e.type === "final" && <div className="whitespace-pre-wrap text-ink-100">{e.text}</div>}
                {e.type === "error" && <div className="text-block">{e.error}</div>}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
