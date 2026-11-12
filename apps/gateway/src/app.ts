import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { DEMO_CATALOG, DEMO_AGENT_ID, sha256Hex } from "@leash/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { checkpoint, readLedger, verifyLedger } from "./ledger.ts";
import { dashboard, finishPayPalHold, finishPayPalLink, startPayPalLink, verifyOwnerAction } from "./owner.ts";
import {
  HttpError,
  createMandate,
  decideApproval,
  getDecision,
  receiveWebhook,
  registerOwner,
  retireOwnerMandates,
  revokeMandate,
  submitProposal,
  type Deps,
} from "./service.ts";
import type { MandateDrafter } from "./llm.ts";
import type { RedTeamRunner } from "./redteam.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    agentId?: string;
    /** Mandate this agent token is scoped to; null for the unscoped operator token. */
    agentScope?: string | null;
  }
}

export interface AppOptions {
  deps: Deps;
  config: Pick<Config, "gatewayPublicKeyHex" | "gatewaySecretKeyHex" | "demoMode" | "publicUrl"> & { paypalConfigured: boolean; llmConfigured: boolean; llmProvider?: string | null; trustProxyHops?: number | false };
  drafter: MandateDrafter;
  redteam?: RedTeamRunner;
  rateLimit?: boolean;
}

/** Seed the catalog and the demo agent's token hash. Idempotent. */
export async function seed(db: Db, agentToken: string) {
  for (const c of DEMO_CATALOG)
    await db.query(
      `INSERT INTO catalog(sku,title,category,merchant_id,unit_price_cents,currency,active,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (sku) DO UPDATE SET title=EXCLUDED.title, category=EXCLUDED.category, merchant_id=EXCLUDED.merchant_id,
         unit_price_cents=EXCLUDED.unit_price_cents, currency=EXCLUDED.currency, active=EXCLUDED.active, description=EXCLUDED.description`,
      [c.sku, c.title, c.category, c.merchant_id, c.unit_price_cents, c.currency, c.active, c.description],
    );
  await db.query("INSERT INTO agents(agent_id, token_sha256) VALUES ($1,$2) ON CONFLICT (agent_id) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256", [DEMO_AGENT_ID, sha256Hex(agentToken)]);
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { deps } = opts;
    // Review R4: trust exactly the configured number of proxy hops (1 on Render). "true" would let any client pick its
  // own IP via X-Forwarded-For and walk around the rate limits.
  const hops = opts.config.trustProxyHops || 0;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: hops ? (_addr: string, i: number) => i < hops : false });

  // Keep the raw body: PayPal webhook verification must post back the event exactly as received.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new HttpError(400, "invalid JSON");
      done(err, undefined);
    }
  });

  if (opts.rateLimit !== false) await app.register(fastifyRateLimit, { max: 600, timeWindow: "1 minute" });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  // ---- agent auth: bearer token → agent id. The agent can do nothing else. ----------------------------------
  const agentAuth = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!tok) throw new HttpError(401, "agent token required");
    const th = sha256Hex(tok);
    const op = await deps.db.query("SELECT agent_id FROM agents WHERE token_sha256 = $1", [th]);
    if (op.rows[0]) {
      req.agentId = op.rows[0].agent_id;
      req.agentScope = null;
      return;
    }
    const run = await deps.db.query("SELECT agent_id, mandate_id FROM agent_tokens WHERE token_sha256 = $1 AND expires_at > now()", [th]);
    if (!run.rows[0]) throw new HttpError(401, "invalid agent token");
    req.agentId = run.rows[0].agent_id;
    req.agentScope = run.rows[0].mandate_id;
  };
  const tokenKey = (req: FastifyRequest) => sha256Hex(String(req.headers.authorization ?? req.ip));
  const ownerAuthHeader = (req: FastifyRequest) => {
    try {
      return JSON.parse(Buffer.from(String(req.headers["x-leash-auth"] ?? ""), "base64url").toString("utf8"));
    } catch {
      return null;
    }
  };

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({
    demo_mode: opts.config.demoMode,
    paypal_configured: opts.config.paypalConfigured,
    llm_configured: opts.config.llmConfigured,
    llm_provider: opts.config.llmProvider ?? null,
    payment_provider: deps.provider.name,
    gateway_public_key_hex: opts.config.gatewayPublicKeyHex,
    agent_id: DEMO_AGENT_ID,
  }));

  // ---- catalog (public) ----------------------------------------------------------------------------------------
  app.get("/api/catalog", async () => (await deps.db.query("SELECT * FROM catalog ORDER BY category, sku")).rows);

  // ---- owners & mandates ---------------------------------------------------------------------------------------
  app.post("/api/owners", async (req) => registerOwner(deps, req.body as { display_name: string; public_key_hex: string }));
  // Review R2: an owner's dashboard (payer email, PayPal ids, agent requests) requires that owner's signature.
  app.get("/api/owners/:id/dashboard", async (req) => {
    const a = await verifyOwnerAction(deps, ownerAuthHeader(req), "read");
    if (a.owner_id !== (req.params as { id: string }).id) throw new HttpError(403, "not your dashboard");
    return dashboard(deps, a.owner_id);
  });
  app.post("/api/owners/paypal/link", async (req) => {
    const a = await verifyOwnerAction(deps, req.body as never, "paypal-link");
    return startPayPalLink(deps, a.owner_id);
  });
  app.get("/api/paypal/return", async (req, reply) => {
    const q = req.query as { owner_id?: string; approval_token_id?: string };
    try {
      await finishPayPalLink(deps, String(q.owner_id ?? ""), q.approval_token_id ? String(q.approval_token_id) : null);
      return reply.redirect("/?paypal=linked");
    } catch (e) {
      return reply.redirect(`/?paypal=error&message=${encodeURIComponent(e instanceof Error ? e.message : "link failed")}`);
    }
  });
  // Review R4: drafting spends LLM tokens, so it needs an owner signature and has its own tight limit.
  app.get("/api/paypal/hold-return", async (req, reply) => {
    const q = req.query as { owner_id?: string; token?: string };
    try {
      await finishPayPalHold(deps, String(q.owner_id ?? ""), q.token ? String(q.token) : null);
      return reply.redirect("/?paypal=linked");
    } catch (e) {
      return reply.redirect(`/?paypal=error&message=${encodeURIComponent(e instanceof Error ? e.message : "hold failed")}`);
    }
  });
  app.post("/api/mandates/draft", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = req.body as { intent?: string; statement: unknown; signature: string };
    await verifyOwnerAction(deps, b as never, "draft");
    const intent = String(b?.intent ?? "").slice(0, 1000);
    if (!intent.trim()) throw new HttpError(400, "intent required");
    return opts.drafter.draft(intent);
  });
  app.post("/api/mandates", async (req) => createMandate(deps, req.body as { body: unknown; signature: string }));
  app.post("/api/mandates/revoke", async (req) => revokeMandate(deps, req.body as { statement: unknown; signature: string }));
  app.post("/api/payments/approval", async (req) => decideApproval(deps, req.body as { statement: unknown; signature: string }));

  // ---- ledger ----------------------------------------------------------------------------------------------------
  app.get("/api/ledger", async (req) => {
    const q = req.query as { from?: string; limit?: string };
    return readLedger(deps.db, Math.max(1, Number(q.from ?? 1) || 1), Math.min(1000, Number(q.limit ?? 500) || 500));
  });
  app.get("/api/ledger/verify", async () => verifyLedger(deps.db, opts.config.gatewayPublicKeyHex));
  app.post("/api/ledger/checkpoint", async () => checkpoint(deps.db, opts.config.gatewaySecretKeyHex, deps.now()));
  app.get("/api/ledger/checkpoints", async () => ({
    gateway_public_key_hex: opts.config.gatewayPublicKeyHex,
    checkpoints: (await deps.db.query("SELECT * FROM ledger_checkpoints ORDER BY seq DESC LIMIT 50")).rows,
  }));

  // ---- PayPal webhooks -------------------------------------------------------------------------------------------
  app.post("/api/paypal/webhook", async (req, reply) => {
    const h: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    await receiveWebhook(deps, h, req.rawBody ?? "");
    return reply.status(200).send({ ok: true });
  });

  // ---- agent API (bearer token, propose-only) ---------------------------------------------------------------------
  app.register(async (agent) => {
    agent.addHook("preHandler", agentAuth);
    agent.get("/api/agent/catalog", async (req) => {
      const q = String((req.query as { q?: string }).q ?? "").toLowerCase();
      const rows = (await deps.db.query("SELECT sku, title, category, merchant_id, unit_price_cents, currency, description FROM catalog WHERE active ORDER BY sku")).rows;
      return q ? rows.filter((r) => `${r.title} ${r.category} ${r.sku}`.toLowerCase().includes(q)) : rows;
    });
    agent.get("/api/agent/mandates/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      if (req.agentScope && req.agentScope !== id) throw new HttpError(404, "no such mandate for this agent");
      const m = (await deps.db.query("SELECT body, revoked_at FROM mandates WHERE mandate_id = $1 AND agent_id = $2", [id, req.agentId])).rows[0];
      if (!m) throw new HttpError(404, "no such mandate for this agent");
      const b = m.body;
      // The agent sees its scope, not the owner's signature or keys.
      return { mandate_id: b.mandate_id, intent: b.intent, allowed_categories: b.allowed_categories, budget: b.budget, per_order_cap_cents: b.per_order_cap_cents, approval_threshold_cents: b.approval_threshold_cents, max_units_per_line: b.max_units_per_line, valid_until: b.valid_until, revoked: !!m.revoked_at };
    });
    agent.post("/api/agent/proposals", { config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: tokenKey } } }, async (req) => submitProposal(deps, req.agentId!, req.body, req.agentScope ?? null));
    agent.get("/api/agent/decisions/:id", async (req) => {
      const d = await getDecision(deps.db, (req.params as { id: string }).id);
      const owner = (await deps.db.query("SELECT agent_id, mandate_id FROM decisions WHERE decision_id = $1", [d.decision_id])).rows[0];
      if (owner.agent_id !== req.agentId || (req.agentScope && owner.mandate_id !== req.agentScope)) throw new HttpError(404, "unknown decision");
      const p = d.payment_id ? (await deps.db.query("SELECT state, approval FROM payments WHERE payment_id = $1", [d.payment_id])).rows[0] : null;
      return { ...d, payment_state: p?.state ?? null, approval: p?.approval ?? null };
    });
  });

  // ---- demo ----------------------------------------------------------------------------------------------------------
  if (opts.config.demoMode) {
    app.post("/api/demo/reset", async (req) => {
      const a = await verifyOwnerAction(deps, req.body as never, "demo-reset");
      return retireOwnerMandates(deps, a.owner_id, "demo reset");
    });
    if (opts.redteam) {
      const rt = opts.redteam;
      app.post("/api/demo/redteam", async (req) => {
        const a = await verifyOwnerAction(deps, req.body as never, "redteam-run");
        if (!a.target) throw new HttpError(400, "target mandate id required");
        const m = (await deps.db.query("SELECT owner_id FROM mandates WHERE mandate_id = $1", [a.target])).rows[0];
        if (!m || m.owner_id !== a.owner_id) throw new HttpError(404, "mandate not found for this owner");
        return rt.start(a.target, a.owner_id);
      });
      app.get("/api/demo/redteam/:runId", async (req) => rt.get((req.params as { runId: string }).runId));
      app.post("/api/demo/live", async (req) => {
        const b = req.body as { statement: { target?: string }; signature: string; task?: string };
        const a = await verifyOwnerAction(deps, b, "redteam-run");
        const m = (await deps.db.query("SELECT owner_id FROM mandates WHERE mandate_id = $1", [a.target ?? ""])).rows[0];
        if (!m || m.owner_id !== a.owner_id) throw new HttpError(404, "mandate not found for this owner");
        return rt.startLive(a.target!, a.owner_id, String(b.task ?? "Do this week's restock."));
      });
    }
  }

  // ---- console (static SPA) ---------------------------------------------------------------------------------------
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "console", "dist");
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.status(404).send({ error: "not found" }) : reply.sendFile("index.html")));
  }
  return app;
}
