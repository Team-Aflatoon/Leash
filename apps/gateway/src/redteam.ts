import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./service.ts";

const AGENT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "src");
const GATEWAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * SAFETY (G1): the agent runs as a separate OS process whose environment is built from an allowlist. It never
 * receives DATABASE_URL, PayPal credentials or the gateway signing key — only the gateway URL and a propose-only
 * token (plus the LLM key in live mode).
 */
export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS"];
  const env: Record<string, string> = { NODE_ENV: "production" };
  for (const k of keep) if (base[k]) env[k] = base[k]!;
  return { ...env, ...extra };
}

interface Run {
  run_id: string;
  kind: "redteam" | "live";
  mandate_id: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  events: Record<string, unknown>[];
  stderr: string;
}

export interface RedTeamRunner {
  start(mandateId: string, ownerId: string): Promise<{ run_id: string }>;
  startLive(mandateId: string, ownerId: string, task: string): Promise<{ run_id: string }>;
  get(runId: string): Promise<Run>;
}

export interface RunnerOptions {
  gatewayUrl: string;
  /** LLM credentials handed to the LIVE agent only. Use a separate, spend-capped key (AGENT_ANTHROPIC_API_KEY). */
  agentLlm: { apiKey: string; model: string } | null;
  /** Mint a per-run token scoped to one mandate (review R1). */
  mint: (mandateId: string) => Promise<string>;
  /** Global cap on concurrently running agent processes (review R4). */
  maxActive?: number;
}

export function createAgentRunner(opts: RunnerOptions): RedTeamRunner {
  const runs = new Map<string, Run>();
  const activeOwners = new Set<string>();
  const maxActive = opts.maxActive ?? 3;

  const launch = async (kind: Run["kind"], mandateId: string, ownerId: string, extra: Record<string, string>) => {
    if (activeOwners.has(ownerId)) throw new HttpError(409, "an agent run is already in progress for this owner");
    if (activeOwners.size >= maxActive) throw new HttpError(429, "too many agent runs right now; try again shortly");
    activeOwners.add(ownerId);
    let agentToken: string;
    try {
      agentToken = await opts.mint(mandateId);
    } catch (e) {
      activeOwners.delete(ownerId);
      throw e;
    }
    const run_id = randomUUID();
    const run: Run = { run_id, kind, mandate_id: mandateId, status: "running", started_at: new Date().toISOString(), finished_at: null, events: [], stderr: "" };
    runs.set(run_id, run);
    if (runs.size > 100) runs.delete(runs.keys().next().value!);
    const script = join(AGENT_SRC, kind === "redteam" ? "redteam.ts" : "shopper.ts");
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: GATEWAY_DIR,
      env: agentEnv(process.env, { GATEWAY_URL: opts.gatewayUrl, AGENT_TOKEN: agentToken, MANDATE_ID: mandateId, RUN_ID: run_id.slice(0, 8), ...extra }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          run.events.push(JSON.parse(line));
        } catch {
          /* ignore non-JSON output */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      run.stderr = (run.stderr + d.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      activeOwners.delete(ownerId);
      run.status = code === 0 ? "done" : "error";
      run.finished_at = new Date().toISOString();
    });
    return { run_id };
  };

  return {
    async start(mandateId, ownerId) {
      return launch("redteam", mandateId, ownerId, {});
    },
    async startLive(mandateId, ownerId, task) {
      if (!opts.agentLlm) throw new HttpError(400, "live agent needs an LLM key");
      return launch("live", mandateId, ownerId, { TASK: task.slice(0, 1000), ANTHROPIC_API_KEY: opts.agentLlm.apiKey, LLM_MODEL: opts.agentLlm.model });
    },
    async get(runId) {
      const r = runs.get(runId);
      if (!r) throw new HttpError(404, "unknown run");
      return r;
    },
  };
}
