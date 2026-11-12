import { useCallback, useEffect, useState } from "react";
import { api, createOwner, loadOwner, saveOwner, short, type Dashboard, type OwnerIdentity, type ServerConfig } from "./api";
import { ErrorNote } from "./ui/bits";
import { DecisionsGrid, LedgerView } from "./views/Grids";
import { LiveAgent } from "./views/LiveAgent";
import { MandateView } from "./views/Mandate";
import { Overview } from "./views/Overview";
import { RedTeam } from "./views/RedTeam";

const TABS = ["Red team", "Overview", "Decisions", "Ledger", "Mandate", "Live agent"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [owner, setOwner] = useState<OwnerIdentity | null>(() => loadOwner());
  const [data, setData] = useState<Dashboard | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get("paypal") ? "Mandate" : "Red team"));
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [banner] = useState(() => {
    const q = new URLSearchParams(location.search);
    const p = q.get("paypal");
    if (p) history.replaceState(null, "", "/");
    return p === "linked" ? "PayPal sandbox account linked." : p === "error" ? `PayPal linking failed: ${q.get("message") ?? ""}` : p === "cancelled" ? "PayPal linking was cancelled." : null;
  });

  useEffect(() => {
    api.get<ServerConfig>("/api/config").then(setConfig, (e) => setError(e.message));
  }, []);

  const refresh = useCallback(async () => {
    if (!owner) return;
    try {
      setData(await api.getAsOwner<Dashboard>(`/api/owners/${owner.owner_id}/dashboard`, owner));
      setTick((t) => t + 1);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "unknown owner") {
        saveOwner(null);
        setOwner(null);
      } else setError(msg);
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!owner) return <Onboarding onReady={setOwner} config={config} />;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 md:px-6">
      <header className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <div className="text-lg font-semibold leading-tight">Leash</div>
            <div className="text-sm text-dim">{data?.owner.display_name ?? owner.display_name}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Pill ok={!!config?.paypal_configured} label={`PayPal ${config?.paypal_configured ? "sandbox" : "not configured"}`} />
          <Pill ok={!!data?.owner.paypal_linked} label={data?.owner.paypal_linked ? "wallet linked" : "wallet not linked"} />
          <Pill ok={!!config?.llm_configured} label={config?.llm_configured ? "intent check on" : "LLM off"} />
          <span className="mono text-ink-400" title={owner.public_key_hex}>
            owner key {short(owner.public_key_hex, 10)}
          </span>
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${tab === t ? "border-amber text-fg" : "border-transparent text-dim hover:text-fg"}`}>
            {t}
          </button>
        ))}
      </nav>

      <main className="mt-6 space-y-4">
        {banner && <div className="rounded-lg border border-blue/40 bg-blue/10 px-3 py-2 text-sm text-blue">{banner}</div>}
        <ErrorNote error={error} />
        {!data ? (
          <p className="text-sm text-ink-400">Loading…</p>
        ) : (
          <>
            {tab === "Red team" && <RedTeam owner={owner} paypalLinked={data.owner.paypal_linked} paypalConfigured={!!config?.paypal_configured} onChanged={refresh} />}
            {tab === "Overview" && <Overview owner={owner} data={data} onChanged={refresh} goMandate={() => setTab("Mandate")} />}
            {tab === "Decisions" && <DecisionsGrid rows={data.decisions} />}
            {tab === "Ledger" && <LedgerView refreshKey={Math.floor(tick / 5)} />}
            {tab === "Mandate" && <MandateView owner={owner} data={data} paypalConfigured={!!config?.paypal_configured} onChanged={refresh} />}
            {tab === "Live agent" && <LiveAgent owner={owner} data={data} llm={!!config?.llm_configured} onChanged={refresh} />}
          </>
        )}
      </main>
      <footer className="mt-10 text-xs text-ink-400">PayPal sandbox only. No real money moves; sandbox payments settle to a test merchant.</footer>
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`chip ${ok ? "chip-allow" : ""}`}>{label}</span>;
}

function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0f1829" stroke="#1e2d47" />
      <path d="M9 22V10h3v9h7v3z" fill="#34d399" />
      <circle cx="22.5" cy="11.5" r="2.5" fill="none" stroke="#60a5fa" strokeWidth="1.6" />
    </svg>
  );
}

function Onboarding({ onReady, config }: { onReady: (o: OwnerIdentity) => void; config: ServerConfig | null }) {
  const [name, setName] = useState("Juniper Café");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-3">
        <Logo />
        <span className="text-xl font-semibold">Leash</span>
      </div>
      <h1 className="text-3xl font-semibold leading-tight">Let an AI agent spend money, inside limits it can’t talk its way around.</h1>
      <p className="mt-3 text-ink-300">
        You’ll get an owner key, generated in this browser. It signs your spending mandates and approvals. The gateway only ever sees the public half, so nobody else, including the
        gateway and the agent, can sign as you.
      </p>
      <label className="mt-6 block">
        <span className="label">Business name</span>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <button
        className="btn btn-primary mt-4 self-start px-5 py-3"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onReady(await createOwner(name.trim()));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Creating key…" : "Create owner key"}
      </button>
      <div className="mt-4">
        <ErrorNote error={error} />
      </div>
      {config && !config.paypal_configured && <p className="mt-4 text-xs text-hold">This server has no PayPal sandbox credentials yet. You can explore, but payments will be refused.</p>}
    </div>
  );
}
