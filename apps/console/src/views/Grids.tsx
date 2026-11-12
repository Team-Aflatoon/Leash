import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useState } from "react";
import { api, short, usd, type DecisionRow } from "../api";
import { ErrorNote, Mono, Notice, OutcomeChip, PaymentState } from "../ui/bits";

ModuleRegistry.registerModules([AllCommunityModule]);

// The grid reads the Console tokens, so it changes with them.
const theme = themeQuartz.withParams({
  backgroundColor: "var(--color-paper-2)",
  foregroundColor: "var(--color-ink)",
  textColor: "var(--color-ink)",
  subtleTextColor: "var(--color-muted)",
  headerBackgroundColor: "var(--color-paper-2)",
  headerTextColor: "var(--color-muted)",
  headerFontWeight: 500,
  borderColor: "var(--color-rule)",
  rowBorder: { color: "var(--color-rule)" },
  rowHoverColor: "var(--color-paper)",
  selectedRowBackgroundColor: "var(--color-paper-3)",
  oddRowBackgroundColor: "var(--color-paper-2)",
  accentColor: "var(--color-accent)",
  inputFocusBorder: { color: "var(--color-focus)" },
  fontFamily: "var(--font-body)",
  fontSize: 14,
  spacing: 7,
  wrapperBorderRadius: 10,
  headerColumnResizeHandleColor: "var(--color-rule-2)",
});

// ---- Decisions ----------------------------------------------------------------------------------------------------

export function DecisionsGrid({ rows }: { rows: DecisionRow[] }) {
  const [sel, setSel] = useState<DecisionRow | null>(null);
  const cols = useMemo<ColDef<DecisionRow>[]>(
    () => [
      { headerName: "Time", field: "created_at", width: 130, valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), sort: "desc", cellClass: "mono" },
      { headerName: "Verdict", field: "outcome", width: 110, cellClass: "cell-center", cellRenderer: (p: ICellRendererParams<DecisionRow>) => <OutcomeChip outcome={p.data?.kind === "replay" ? "REPLAY" : p.value} />, filter: true },
      { headerName: "Total", field: "total_cents", width: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value), cellClass: "mono" },
      { headerName: "Cart, priced by the gateway", flex: 2, minWidth: 240, valueGetter: (p) => p.data?.lines.map((l) => `${l.quantity} × ${l.title}`).join(", ") || "None", tooltipValueGetter: (p) => p.value },
      { headerName: "Reasons", flex: 2, minWidth: 220, valueGetter: (p) => p.data?.reasons.map((r) => r.code).join(", ") || "Within the mandate", cellClass: "mono", filter: true },
      { headerName: "Intent check", width: 130, valueGetter: (p) => p.data?.intent_verdict?.kind ?? "none", filter: true },
      { headerName: "Payment", width: 180, cellClass: "cell-center", cellRenderer: (p: ICellRendererParams<DecisionRow>) => <PaymentState state={p.data?.payment_state ?? null} approval={p.data?.approval} /> },
      { headerName: "PayPal capture", field: "paypal_capture_id", width: 170, cellClass: "mono", valueFormatter: (p) => p.value ?? "None" },
      { headerName: "Webhook", field: "reconciliation", width: 120, valueFormatter: (p) => (p.data?.payment_id ? String(p.value).toLowerCase() : "n/a") },
      { headerName: "Kind", field: "kind", width: 100, filter: true },
    ],
    [],
  );
  if (rows.length === 0)
    return (
      <div className="panels">
        <div className="space-y-2 p-6">
          <h1 className="text-2xl text-fg">No decisions yet</h1>
          <p className="text-fg-2">Every request the agent makes lands here with the gateway’s verdict. Run the red team to fill it.</p>
        </div>
      </div>
    );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl text-fg">Every decision the gateway made</h1>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="h-[640px] min-w-0">
          <AgGridReact<DecisionRow>
            theme={theme}
            rowData={rows}
            columnDefs={cols}
            getRowId={(p) => p.data.decision_id}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onSelectionChanged={(e) => setSel(e.api.getSelectedRows()[0] ?? null)}
            defaultColDef={{ resizable: true, sortable: true }}
            tooltipShowDelay={300}
          />
        </div>
        <aside className="panels self-start" aria-label="Decision detail">
          {sel ? <DecisionDetail d={sel} /> : <p className="p-4 text-sm text-dim">Pick a row to see exactly what the agent sent and why the gateway decided.</p>}
        </aside>
      </div>
    </div>
  );
}

function DecisionDetail({ d }: { d: DecisionRow }) {
  const blocks = d.reasons.filter((r) => r.outcome === "BLOCK");
  const flags = d.reasons.filter((r) => r.outcome !== "BLOCK");
  return (
    <div className="space-y-5 p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <OutcomeChip outcome={d.kind === "replay" ? "REPLAY" : d.outcome} />
        <Mono title={d.decision_id}>{short(d.decision_id, 13)}</Mono>
      </div>
      <div>
        <h3 className="label mb-2">What the agent sent, untrusted</h3>
        <pre className="mono max-h-56 overflow-auto rounded-[var(--radius-pill)] border border-line bg-well p-3 text-xs leading-relaxed text-fg-2">{JSON.stringify(d.request_body, null, 2)}</pre>
      </div>
      <div className="space-y-2">
        <h3 className="label">Why</h3>
        {d.reasons.length === 0 && <p className="text-fg-2">Every rule passed.</p>}
        <ul className="space-y-2">
          {[...blocks, ...flags].map((r, i) => (
            <li key={i}>
              <span className={`mono ${r.outcome === "BLOCK" ? "text-stop" : "text-amber"}`}>{r.code}</span>
              <span className="text-dim"> from {r.source === "llm" ? "the intent check" : "the rules"}</span>
              <p className="text-fg-2">{r.message}</p>
            </li>
          ))}
        </ul>
        {d.intent_verdict?.rationale && <p className="text-dim">Intent check: {d.intent_verdict.rationale}</p>}
      </div>
      {d.payment_id && (
        <dl className="space-y-1.5">
          <h3 className="label mb-2">PayPal sandbox</h3>
          <Row k="Payment">
            <PaymentState state={d.payment_state} approval={d.approval} />
          </Row>
          <Row k="Order">
            <Mono>{d.paypal_order_id ?? "none"}</Mono>
          </Row>
          <Row k="Authorization">
            <Mono>{d.paypal_authorization_id ?? "none"}</Mono>
          </Row>
          <Row k="Capture">
            <Mono>{d.paypal_capture_id ?? "none"}</Mono>
          </Row>
          <Row k="Webhook">
            <span className="text-fg-2">
              {String(d.reconciliation).toLowerCase()}
              {d.reconciliation_note ? `, ${d.reconciliation_note}` : ""}
            </span>
          </Row>
          {d.last_error && (
            <Row k="Error">
              <span className="text-stop">{d.last_error}</span>
            </Row>
          )}
        </dl>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
      <dt className="label">{k}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
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
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setRows(await api.get<LedgerEntry[]>("/api/ledger?from=1&limit=1000"));
      setV(await api.get<Verification>("/api/ledger/verify"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), [refreshKey]);

  const cols = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { headerName: "Seq", field: "seq", width: 90, sort: "desc", cellClass: "mono" },
      { headerName: "Time", field: "ts", width: 130, valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), cellClass: "mono" },
      { headerName: "Event", field: "type", width: 200, filter: true },
      { headerName: "Recorded", flex: 1, minWidth: 320, valueGetter: (p) => summarize(p.data?.data ?? {}), tooltipValueGetter: (p) => JSON.stringify(p.data?.data), cellClass: "mono" },
      { headerName: "Hash", field: "hash", width: 160, cellClass: "mono", valueFormatter: (p) => short(p.value, 14), tooltipField: "hash" },
      { headerName: "Previous", field: "prev_hash", width: 160, cellClass: "mono", valueFormatter: (p) => short(p.value, 14), tooltipField: "prev_hash" },
    ],
    [],
  );

  const intact = v && v.chain.ok && v.checkpointFailures.length === 0;
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <section className="panels" aria-labelledby="ledger-head">
        <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="space-y-2">
            <h1 id="ledger-head" className="text-2xl text-fg">
              {!v ? "Checking the ledger" : intact ? "The ledger is intact" : "Tampering detected"}
            </h1>
            {v && v.chain.ok && (
              <p className="text-fg-2">
                <span className="mono text-fg">{v.chain.count}</span> entries recomputed from the first one;{" "}
                <span className="mono text-fg">{v.checkpointsChecked}</span> signed checkpoints match. Head <Mono title={v.chain.head}>{short(v.chain.head, 18)}</Mono>
              </p>
            )}
            {v && !intact && (
              <p className="text-stop">
                {v.chain.ok ? "" : `The chain breaks at entry ${v.chain.brokenAtSeq}: ${v.chain.problem}. `}
                {v.checkpointFailures.map((f) => `Checkpoint ${f.seq}: ${f.reason}.`).join(" ")}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={load}>
              Verify again
            </button>
            <button
              className="btn"
              aria-busy={busy}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<{ seq: number; hash: string; signature: string } | null>("/api/ledger/checkpoint");
                  setCp(r ? `The gateway signed checkpoint ${r.seq}. Keep a copy outside this server: it proves later rewrites.` : "Nothing new to sign yet.");
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sign a checkpoint
            </button>
          </div>
        </div>
      </section>
      {cp && <Notice>{cp}</Notice>}
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
      if (k.endsWith("_cents")) return `${k.replace("_cents", "")} ${usd(Number(v))}`;
      if (k.endsWith("_id")) return `${k.replace("_id", "")} ${String(v).slice(0, 8)}`;
      return `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`;
    })
    .join("   ");
}
