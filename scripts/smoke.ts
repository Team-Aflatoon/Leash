/**
 * End-to-end smoke test against a running gateway (local or hosted), driving it exactly like the console does.
 *
 *   npx tsx scripts/smoke.ts http://localhost:8080
 *
 * Creates an owner key, signs a demo mandate, reads the dashboard with a signed header, runs the red team and prints
 * each scenario. Without a linked PayPal wallet the honest order is blocked (PAYMENT_CONSENT_MISSING) — expected.
 */
import { demoMandate, generateKeyPair, signJson } from "../packages/core/src/index.ts";

const base = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const kp = generateKeyPair();
const now = () => new Date().toISOString();

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j as any;
}
const action = (owner_id: string, a: string, target?: string) => {
  const statement = { owner_id, action: a, signed_at: now(), ...(target ? { target } : {}) };
  return { statement, signature: signJson("owner-action", statement, kp.secretKeyHex) };
};

const cfg = await call("GET", "/api/config");
console.log("config", cfg);
const { owner_id } = await call("POST", "/api/owners", { display_name: "Smoke Café", public_key_hex: kp.publicKeyHex });
const body = demoMandate({ mandate_id: crypto.randomUUID(), owner_id, now: new Date() });
await call("POST", "/api/mandates", { body, signature: signJson("mandate", body, kp.secretKeyHex) });
const auth = Buffer.from(JSON.stringify(action(owner_id, "read"))).toString("base64url");
const dash = await call("GET", `/api/owners/${owner_id}/dashboard`, undefined, { "x-leash-auth": auth });
console.log(`owner ${owner_id}: ${dash.mandates.length} mandate(s), paypal linked: ${dash.owner.paypal_linked}`);
const { run_id } = await call("POST", "/api/demo/redteam", action(owner_id, "redteam-run", body.mandate_id));
let run: any;
for (let i = 0; i < 240; i++) {
  run = await call("GET", `/api/demo/redteam/${run_id}`);
  if (run.status !== "running") break;
  await new Promise((r) => setTimeout(r, 500));
}
for (const e of run.events) {
  if (e.type === "scenario") console.log(`${e.pass ? "PASS" : "FAIL"}  ${e.id.padEnd(17)} ${e.decisions.map((d: any) => d.kind === "replay" ? "REPLAY" : d.outcome).join(",").padEnd(36)} ${e.decisions[0]?.reasons.map((r: any) => r.code).join(",") ?? ""}`);
  else console.log(e);
}
const v = await call("GET", "/api/ledger/verify");
console.log("ledger", v.chain);
if (run.status !== "done") {
  console.error(run.stderr);
  process.exit(1);
}
