import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useState } from "react";
import { api, short, usd, type DecisionRow } from "../api";
import { ErrorNote, Mono, OutcomeChip, PaymentState, Section } from "../ui/bits";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  backgroundColor: "#0b1220",
  foregroundColor: "#e6ebf3",
  headerBackgroundColor: "#0f1829",
  headerTextColor: "#a7b2c7",
  borderColor: "#1e2d47",
  rowHoverColor: "#142036",
  selectedRowBackgroundColor: "#1e2d47",
  oddRowBackgroundColor: "#0d1525",
  accentColor: "#60a5fa",
  fontFamily: "IBM Plex Sans, sans-serif",
  fontSize: 13,
  headerFontWeight: 600,
  spacing: 6,
  wrapperBorderRadius: 10,
});

// ---- Decisions ----------------------------------------------------------------------------------------------------

export function DecisionsGrid({ rows }: { rows: DecisionRow[] }) {
  const [sel, setSel] = useState<DecisionRow | null>(null);
  const cols = useMemo<ColDef<DecisionRow>[]>(
    () => [
      { headerName: "Time", field: "created_at", width: 105, valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), sort: "desc" },
      { headerName: "Outcome", field: "outcome", width: 110, cellRenderer: (p: ICellRendererParams<DecisionRow>) => <OutcomeChip outcome={p.data?.kind === "replay" ? "REPLAY" : p.value} />, filter: true },
      { headerName: "Kind", field: "kind", width: 95, filter: true },
      { headerName: "Total", field: "total_cents", width: 105, type: "rightAligned", valueFormatter: (p) => usd(p.value), cellClass: "mono" },
      { headerName: "Cart (gateway-priced)", flex: 2, minWidth: 220, valueGetter: (p) => p.data?.lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "—", tooltipValueGetter: (p) => p.value },
      { headerName: "Reasons", flex: 2, minWidth: 220, valueGetter: (p) => p.data?.reasons.map((r) => r.code).join(", ") || "within mandate", cellClass: "mono", filter: true },
      { headerName: "Intent check", width: 120, valueGetter: (p) => p.data?.intent_verdict?.kind ?? "—", filter: true },
      { headerName: "Payment", width: 165, cellRenderer: (p: ICellRendererParams<DecisionRow>) => <PaymentState state={p.data?.payment_state ?? null} approval={p.data?.approval} /> },
      { headerName: "PayPal capture", field: "paypal_capture_id", width: 150, cellClass: "mono", valueFormatter: (p) => p.value ?? "—" },
      { headerName: "Webhook", field: "reconciliation", width: 115, valueFormatter: (p) => (p.data?.payment_id ? p.value : "—") },
    ],
    [],
  );
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="h-[640px]">
        <AgGridReact<DecisionRow>
          theme={theme}
          rowData={rows}
          columnDefs={cols}
          getRowId={(p) => p.data.decision_id}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onSelectionChanged={(e) => setSel(e.api.getSelectedRows()[0] ?? null)}
          defaultColDef={{ resizable: true, sortable: true }}
          tooltipShowDelay={300}
          animateRows
        />
      </div>
      <Section title="Decision detail">
        {sel ? <DecisionDetail d={sel} /> : <p className="text-sm text-ink-400">Select a row to see exactly what the agent sent and why the gateway decided.</p>}
      </Section>
    </div>
  );
}

function DecisionDetail({ d }: { d: DecisionRow }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <OutcomeChip outcome={d.outcome} size="lg" />
        <Mono>{d.decision_id}</Mono>
      </div>
      <div>
        <div className="label mb-1">What the agent sent (untrusted)</div>
        <pre className="mono max-h-56 overflow-auto rounded-md bg-ink-950 p-2 text-[11px] leading-relaxed text-ink-300">{JSON.stringify(d.request_body, null, 2)}</pre>
      </div>
      <div>
        <div className="label mb-1">Why</div>
        {d.reasons.length ? (
          <ul className="space-y-1">
            {d.reasons.map((r, i) => (
              <li key={i} className="text-xs">
                <span className={`mono font-semibold ${r.outcome === "BLOCK" ? "text-block" : "text-hold"}`}>{r.code}</span> <span className="text-ink-400">[{r.source}]</span> <span className="text-ink-300">{r.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-300">Every rule passed.</p>
        )}
        {d.intent_verdict?.rationale && <p className="mt-2 text-xs text-ink-400">Intent check: {d.intent_verdict.rationale}</p>}
      </div>
      {d.payment_id && (
        <div className="space-y-1 text-xs">
          <div className="label mb-1">PayPal sandbox</div>
          <div>
            Payment <Mono>{short(d.payment_id, 13)}</Mono> · <PaymentState state={d.payment_state} approval={d.approval} />
          </div>
          <div>
            Order <Mono>{d.paypal_order_id ?? "—"}</Mono>
          </div>
          <div>
            Authorization <Mono>{d.paypal_authorization_id ?? "—"}</Mono>
          </div>
          <div>
            Capture <Mono>{d.paypal_capture_id ?? "—"}</Mono>
          </div>
          <div>
            Webhook reconciliation: <span className="mono">{d.reconciliation}</span> {d.reconciliation_note && <span className="text-ink-400">({d.reconciliation_note})</span>}
          </div>
          {d.last_error && <div className="text-block">Error: {d.last_error}</div>}
        </div>
      )}
    </div>
  );
}

// ---- Ledger ---------------------------------------------------------------------------------------------------------

interface LedgerEntry {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}
interface Verification {
  chain: { ok: true; head: string; count: number } | { ok: false; brokenAtSeq: number; problem: string };
  checkpointFailures: { seq: number; reason: string }[];
  checkpointsChecked: number;
}

export function LedgerView({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [v, setV] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cp, setCp] = useState<string | null>(null);

  const load = async () => {
    try {
      const all = await api.get<LedgerEntry[]>("/api/ledger?from=1&limit=1000");
      setRows(all.slice(-1000));
      setV(await api.get<Verification>("/api/ledger/verify"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), [refreshKey]);

  const cols = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { headerName: "#", field: "seq", width: 80, sort: "desc", cellClass: "mono" },
      { headerName: "Time", field: "ts", width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
      { headerName: "Event", field: "type", width: 190, cellClass: "mono", filter: true },
      { headerName: "Data", flex: 1, minWidth: 300, valueGetter: (p) => summarize(p.data?.data ?? {}), tooltipValueGetter: (p) => JSON.stringify(p.data?.data), cellClass: "mono" },
      { headerName: "Hash", field: "hash", width: 150, cellClass: "mono", valueFormatter: (p) => short(p.value, 14), tooltipField: "hash" },
      { headerName: "Prev", field: "prev_hash", width: 150, cellClass: "mono", valueFormatter: (p) => short(p.value, 14), tooltipField: "prev_hash" },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <div className="card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="text-sm">
          <div className="label">Tamper-evident ledger</div>
          {v ? (
            v.chain.ok && v.checkpointFailures.length === 0 ? (
              <p className="mt-1 text-allow">
                ✓ Chain intact: {v.chain.count} entries recomputed from genesis; {v.checkpointsChecked} signed checkpoint(s) match. Head <Mono>{short(v.chain.head, 16)}</Mono>
              </p>
            ) : (
              <p className="mt-1 text-block">
                ✗ Tampering detected: {v.chain.ok ? "" : `chain breaks at #${v.chain.brokenAtSeq} (${v.chain.problem}). `}
                {v.checkpointFailures.map((f) => `checkpoint #${f.seq}: ${f.reason}`).join("; ")}
              </p>
            )
          ) : (
            <p className="mt-1 text-ink-400">Verifying…</p>
          )}
          {cp && <p className="mt-1 text-xs text-ink-400">{cp}</p>}
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={load}>
            Re-verify
          </button>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const r = await api.post<{ seq: number; hash: string; signature: string } | null>("/api/ledger/checkpoint");
              setCp(r ? `Gateway signed checkpoint #${r.seq} (${short(r.signature, 16)}). Keep a copy outside this server.` : "Nothing to checkpoint yet.");
              load();
            }}
          >
            Sign checkpoint
          </button>
        </div>
      </div>
      <div className="h-[600px]">
        <AgGridReact<LedgerEntry> theme={theme} rowData={rows} columnDefs={cols} getRowId={(p) => String(p.data.seq)} defaultColDef={{ resizable: true, sortable: true }} tooltipShowDelay={300} />
      </div>
    </div>
  );
}

function summarize(d: Record<string, unknown>): string {
  const keys = ["outcome", "reasons", "total_cents", "amount_cents", "payment_id", "decision_id", "mandate_id", "reason", "event_type", "result"];
  return keys
    .filter((k) => d[k] !== undefined && d[k] !== null)
    .map((k) => {
      const v = d[k];
      if (k.endsWith("_cents")) return `${k.replace("_cents", "")}=${usd(Number(v))}`;
      if (k.endsWith("_id")) return `${k}=${String(v).slice(0, 8)}`;
      return `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`;
    })
    .join("  ");
}
