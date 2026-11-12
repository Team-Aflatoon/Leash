import { randomUUID } from "node:crypto";
import { demoMandate, generateKeyPair, signJson, type IntentVerdict, type KeyPair } from "@leash/core";
import { buildApp, seed } from "../src/app.ts";
import { createPool, migrate, type Db } from "../src/db.ts";
import { noIntentChecker, type IntentChecker } from "../src/intent.ts";
import { drainJobs } from "../src/jobs.ts";
import { ProviderRejectedError, ProviderUncertainError, type AuthorizeRequest, type AuthorizeResult, type PaymentProvider } from "../src/provider.ts";
import { createMandate, registerOwner, type Deps } from "../src/service.ts";

export const TEST_DB = process.env.DATABASE_URL_TEST ?? "postgres://postgres@127.0.0.1:54329/leash_test";
export const AGENT_TOKEN = "test-agent-token-123456";

/** In-memory PayPal stand-in. TEST ONLY — production code has no fake path. */
export class FakePayPal implements PaymentProvider {
  readonly name = "fake";
  calls: { op: string; requestId: string; arg?: unknown }[] = [];
  authorizeBehaviour: "ok" | "decline" | "uncertain-once" | "uncertain" = "ok";
  captureBehaviour: "ok" | "reject" = "ok";
  voidBehaviour: "ok" | "already_captured" = "ok";
  webhookValid = true;
  delayMs = 0;
  private byRequest = new Map<string, unknown>();
  private uncertainSeen = new Set<string>();

  async createVaultSetup(req: { requestId: string }) {
    this.calls.push({ op: "setup", requestId: req.requestId });
    return { setupTokenId: `ST-${randomUUID()}`, approveUrl: "https://sandbox.example/approve" };
  }
  async finalizeVault(req: { requestId: string }) {
    this.calls.push({ op: "vault", requestId: req.requestId });
    return { vaultId: `V-${randomUUID()}`, payerEmail: "buyer@example.com" };
  }
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    this.calls.push({ op: "authorize", requestId: req.requestId, arg: req });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.authorizeBehaviour === "decline") return { ok: false, definitive: true, error: "INSTRUMENT_DECLINED" };
    if (this.authorizeBehaviour === "uncertain") throw new ProviderUncertainError("timeout");
    if (this.authorizeBehaviour === "uncertain-once" && !this.uncertainSeen.has(req.requestId)) {
      this.uncertainSeen.add(req.requestId);
      throw new ProviderUncertainError("timeout");
    }
    // Idempotent like PayPal-Request-Id: same request id → same authorization.
    const prev = this.byRequest.get(req.requestId) as AuthorizeResult | undefined;
    if (prev) return prev;
    const res: AuthorizeResult = { ok: true, orderId: `O-${randomUUID()}`, authorizationId: `A-${randomUUID()}`, status: "CREATED" };
    this.byRequest.set(req.requestId, res);
    return res;
  }
  async capture(req: { requestId: string; authorizationId: string }) {
    this.calls.push({ op: "capture", requestId: req.requestId, arg: req });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.captureBehaviour === "reject") throw new ProviderRejectedError("AUTHORIZATION_EXPIRED");
    return { captureId: `C-${req.authorizationId}`, status: "COMPLETED" };
  }
  async voidAuthorization(req: { requestId: string; authorizationId: string }) {
    this.calls.push({ op: "void", requestId: req.requestId, arg: req });
    if (this.voidBehaviour === "already_captured") return { status: "ALREADY_CAPTURED" as const };
    return { status: "VOIDED" as const };
  }
  async verifyWebhook() {
    return this.webhookValid;
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

export class FakeIntent implements IntentChecker {
  model = "fake-model";
  promptVersion = "t1";
  verdict: IntentVerdict = { kind: "consistent", rationale: "matches intent" };
  calls = 0;
  async check() {
    this.calls++;
    return this.verdict;
  }
}

export async function freshDb(): Promise<Db> {
  const admin = createPool(TEST_DB, 2);
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
  const db = createPool(TEST_DB, 60);
  await migrate(db);
  await seed(db, AGENT_TOKEN);
  return db;
}

export interface World {
  db: Db;
  provider: FakePayPal;
  intent: FakeIntent;
  deps: Deps;
  clock: { now: Date };
  owner: KeyPair & { owner_id: string };
  mandateId: string;
  app: Awaited<ReturnType<typeof buildApp>>;
  propose(body: unknown, token?: string): Promise<{ status: number; json: any }>;
  drain(): Promise<number>;
  payment(id: string): Promise<any>;
  newMandate(over?: Record<string, unknown>): Promise<string>;
}

export async function makeWorld(opts: { approvalTimeoutSeconds?: number; withIntent?: boolean; linkPayPal?: boolean } = {}): Promise<World> {
  const db = await freshDb();
  const provider = new FakePayPal();
  const intent = new FakeIntent();
  const clock = { now: new Date() };
  const deps: Deps = {
    db,
    provider,
    intent: opts.withIntent ? intent : noIntentChecker,
    now: () => clock.now,
    config: { approvalTimeoutSeconds: opts.approvalTimeoutSeconds ?? 600, publicUrl: "http://localhost", demoMode: true },
    wake: () => {},
  };
  const kp = generateKeyPair();
  const { owner_id } = await registerOwner(deps, { display_name: "Test Café", public_key_hex: kp.publicKeyHex });
  if (opts.linkPayPal !== false) await db.query("UPDATE owners SET paypal_vault_id = 'V-test' WHERE owner_id = $1", [owner_id]);
  const owner = { ...kp, owner_id };
  const newMandate = async (over: Record<string, unknown> = {}) => {
    const body = { ...demoMandate({ mandate_id: randomUUID(), owner_id, now: clock.now }), ...over };
    await createMandate(deps, { body, signature: signJson("mandate", body, kp.secretKeyHex) });
    return body.mandate_id;
  };
  const mandateId = await newMandate();
  const app = await buildApp({
    deps,
    config: { gatewayPublicKeyHex: "00".repeat(32), gatewaySecretKeyHex: "11".repeat(32), demoMode: true, publicUrl: "http://localhost", paypalConfigured: false, llmConfigured: false },
    drafter: { draft: async () => ({}) as never },
    rateLimit: false,
  });
  return {
    db,
    provider,
    intent,
    deps,
    clock,
    owner,
    mandateId,
    app,
    newMandate,
    async propose(body, token = AGENT_TOKEN) {
      const r = await app.inject({ method: "POST", url: "/api/agent/proposals", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
      return { status: r.statusCode, json: r.json() };
    },
    drain: () => drainJobs(deps),
    async payment(id) {
      return (await db.query("SELECT * FROM payments WHERE payment_id = $1", [id])).rows[0];
    },
  };
}

export const key = () => `k-${randomUUID()}`;
