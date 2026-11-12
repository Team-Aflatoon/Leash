import { useEffect, useRef, useState } from "react";
import { api, ownerAction, usd, type Dashboard, type OwnerIdentity } from "../api";
import { ErrorNote, Notice, OutcomeChip, Section } from "../ui/bits";

interface Ev {
  type: string;
  name?: string;
  input?: unknown;
  result?: { outcome?: string; reasons?: { code: string; message: string }[]; total_cents?: number } & Record<string, unknown>;
  error?: string;
  text?: string;
}

export function LiveAgent({ owner, data, llm, provider, onChanged }: { owner: OwnerIdentity; data: Dashboard; llm: boolean; provider: "gemini" | "anthropic" | null; onChanged: () => void }) {
  const active = data.mandates.find((m) => !m.revoked_at && Date.parse(m.body.valid_until) > Date.now());
  const [task, setTask] = useState("Do this week’s restock. We’re low on espresso beans and oat milk, and the vanilla syrup is nearly gone.");
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
          if (r.status === "error" && !r.events.some((e) => e.type === "error")) setError(r.stderr.slice(-300) || "The agent process stopped unexpectedly.");
          onChanged();
        }
      }, 700);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl text-fg">Give the real agent a task</h1>
        <p className="max-w-[70ch] text-fg-2">
          A live {provider === "anthropic" ? "Claude" : provider === "gemini" ? "Gemini" : "LLM"} agent with three tools: read its mandate, search the catalog, propose an order. It reads every merchant description, the poisoned one too. Whatever it
          decides, the gateway has the last word. Live runs vary; the red team is the repeatable demo.
        </p>
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Section title="Task">
          <label className="block space-y-1.5">
            <span className="label">What should it do?</span>
            <textarea className="field h-32" value={task} onChange={(e) => setTask(e.target.value)} maxLength={1000} />
          </label>
          <button className="btn btn-primary mt-3" aria-busy={!!status} disabled={!llm || !active || !!status} onClick={start}>
            {status ? "The agent is working" : "Send to the agent"}
          </button>
          <div className="mt-3 space-y-2">
            {!llm && <Notice tone="amber">This server has no LLM key, so the live agent is off.</Notice>}
            {!active && <Notice tone="amber">Sign a mandate first; the agent can only act inside one.</Notice>}
            <ErrorNote error={error} />
          </div>
        </Section>
        <Section title="What it did">
          {events.length === 0 ? (
            <p className="text-sm text-dim">{status ? "Waiting for its first step." : "No run yet. Each tool call and each gateway verdict appears here in order."}</p>
          ) : (
            <ol className="relative space-y-4 border-l border-line-2 pl-5">
              {events.map((e, i) => (
                <li key={i} className="rise space-y-1.5 text-sm">
                  {e.type === "tool" && (
                    <>
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className="font-medium text-fg">{TOOL_LABEL[e.name ?? ""] ?? e.name}</span>
                        <span className="mono text-xs text-dim">{e.name}</span>
                      </div>
                      <pre className="mono overflow-auto rounded-[var(--radius-pill)] border border-line bg-well px-3 py-2 text-xs text-fg-2">{JSON.stringify(e.input)}</pre>
                      {e.name === "propose_order" && e.result?.outcome ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <OutcomeChip outcome={e.result.outcome} />
                          <span className="mono text-fg">{usd(e.result.total_cents ?? 0)}</span>
                          <span className="text-fg-2">{e.result.reasons?.map((r) => r.message).join(" ") || "Within the mandate."}</span>
                        </div>
                      ) : (
                        <p className={e.error ? "text-stop" : "text-dim"}>{e.error ? `Failed: ${e.error}` : Array.isArray(e.result) ? `${e.result.length} results` : "Done"}</p>
                      )}
                    </>
                  )}
                  {e.type === "final" && (
                    <>
                      <span className="font-medium text-fg">The agent’s summary</span>
                      <p className="whitespace-pre-wrap text-fg-2">{e.text}</p>
                    </>
                  )}
                  {e.type === "error" && <p className="text-stop">{e.error}</p>}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  get_mandate: "Read its mandate",
  search_catalog: "Searched the catalog",
  propose_order: "Proposed an order",
};
