import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { signJson } from "@leash/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker } from "../../gateway/src/jobs.ts";
import { agentEnv, createAgentRunner } from "../../gateway/src/redteam.ts";
import { mintAgentToken } from "../../gateway/src/service.ts";
import { makeWorld, type World } from "../../gateway/test/helpers.ts";
import { GatewayClient } from "../src/client.ts";
import { runRedTeam, type ScenarioResult } from "../src/redteam.ts";

describe("G1: the agent is isolated from money", () => {
  const src = join(import.meta.dirname, "..", "src");
  const files = readdirSync(src).filter((f) => f.endsWith(".ts"));

  it("agent code imports nothing from the gateway, no database driver, no PayPal client", () => {
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(/gateway|^pg$|paypal|postgres/i);
      }
      expect(text, f).not.toMatch(/DATABASE_URL|PAYPAL_|GATEWAY_SIGNING_KEY/);
    }
  });

  it("the agent process environment is an allowlist without secrets", () => {
    const env = agentEnv(
      { PATH: "/bin", DATABASE_URL: "postgres://x", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", GATEWAY_SIGNING_KEY: "k", ANTHROPIC_API_KEY: "a", AGENT_TOKEN: "old" },
      { GATEWAY_URL: "http://127.0.0.1:1", AGENT_TOKEN: "t", MANDATE_ID: "m" },
    );
    expect(Object.keys(env).sort()).toEqual(["AGENT_TOKEN", "GATEWAY_URL", "MANDATE_ID", "NODE_ENV", "PATH"]);
  });
});

describe("red-team mode", () => {
  let w: World;
  let url: string;
  let stopWorker: () => void;

  beforeAll(async () => {
    w = await makeWorld();
    await w.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = w.app.server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const worker = startWorker(w.deps, 50);
    w.deps.wake = worker.wake;
    stopWorker = worker.stop;
  });
  afterAll(async () => {
    stopWorker();
    await w.app.close();
    await w.db.end();
  });

  const summarize = (rs: ScenarioResult[]) => rs.map((r) => ({ id: r.id, pass: r.pass, outcomes: r.decisions.map((d) => d.outcome).sort(), states: r.decisions.map((d) => d.payment_state ?? null).sort() }));

  it("every scenario passes, and two runs on fresh mandates give identical results", async () => {
    const runs: ScenarioResult[][] = [];
    for (const runId of ["a", "b"]) {
      const mandateId = await w.newMandate();
      const client = new GatewayClient({ gatewayUrl: url, token: await mintAgentToken(w.db, mandateId), mandateId });
      runs.push(await runRedTeam(client, runId, () => {}));
    }
    for (const r of runs[0]!) expect(r.pass, `${r.id}: ${r.verdict}`).toBe(true);
    expect(summarize(runs[1]!)).toEqual(summarize(runs[0]!));
    // Money check: per mandate, never more than the budget committed.
    const rows = (await w.db.query("SELECT mandate_id, SUM(amount_cents) s FROM payments WHERE state IN ('RESERVED','AUTHORIZED','CAPTURED') GROUP BY mandate_id")).rows;
    for (const r of rows) expect(Number(r.s)).toBeLessThanOrEqual(40_000);
  }, 120_000);

  it("runs as a separate OS process through the gateway's runner", async () => {
    const mandateId = await w.newMandate();
    const runner = createAgentRunner({ gatewayUrl: url, agentLlm: null, mint: (id) => mintAgentToken(w.db, id) });
    const { run_id } = await runner.start(mandateId, w.owner.owner_id);
    let run = await runner.get(run_id);
    for (let i = 0; i < 200 && run.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      run = await runner.get(run_id);
    }
    expect(run.status, run.stderr).toBe("done");
    const done = run.events.find((e) => e.type === "done");
    expect(done).toMatchObject({ passed: 6, total: 6 });
  }, 90_000);

  it("the demo endpoints require the owner's signature", async () => {
    const statement = { owner_id: w.owner.owner_id, action: "redteam-run", target: w.mandateId, signed_at: new Date().toISOString() };
    const bad = await w.app.inject({ method: "POST", url: "/api/demo/reset", payload: { statement: { ...statement, action: "demo-reset" }, signature: signJson("owner-action", statement, w.owner.secretKeyHex) } });
    expect(bad.statusCode).toBe(401);
  });
});
