import { buildApp, seed } from "./app.ts";
import { ClaudeIntentChecker, ClaudeMandateDrafter, templateDrafter } from "./claude.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { cachedIntentChecker, noIntentChecker } from "./intent.ts";
import { startWorker } from "./jobs.ts";
import { checkpoint } from "./ledger.ts";
import { PayPalProvider } from "./paypal.ts";
import { ProviderRejectedError, type PaymentProvider } from "./provider.ts";
import { createAgentRunner } from "./redteam.ts";
import type { Deps } from "./service.ts";

/** Used when PayPal credentials are absent. It refuses every money operation; there is no simulated payment path. */
const unconfiguredProvider: PaymentProvider = {
  name: "unconfigured",
  async createVaultSetup() {
    throw new ProviderRejectedError("PayPal sandbox credentials are not configured on this server");
  },
  async finalizeVault() {
    throw new ProviderRejectedError("PayPal sandbox credentials are not configured on this server");
  },
  async authorize() {
    return { ok: false, definitive: true, error: "PayPal sandbox credentials are not configured on this server" };
  },
  async capture() {
    throw new ProviderRejectedError("PayPal not configured");
  },
  async voidAuthorization() {
    throw new ProviderRejectedError("PayPal not configured");
  },
  async verifyWebhook() {
    return false;
  },
};

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
await seed(db, config.agentToken);

const provider = config.paypal ? new PayPalProvider(config.paypal) : unconfiguredProvider;
const intent = config.anthropic ? cachedIntentChecker(db, new ClaudeIntentChecker(config.anthropic.apiKey, config.anthropic.model)) : noIntentChecker;
const drafter = config.anthropic ? new ClaudeMandateDrafter(config.anthropic.apiKey, config.anthropic.model) : templateDrafter;

let wake = () => {};
const deps: Deps = {
  db,
  provider,
  intent,
  now: () => new Date(),
  config: { approvalTimeoutSeconds: config.approvalTimeoutSeconds, publicUrl: config.publicUrl, demoMode: config.demoMode },
  wake: () => wake(),
};
const worker = startWorker(deps);
wake = worker.wake;

const app = await buildApp({
  deps,
  config: { ...config, paypalConfigured: !!config.paypal, llmConfigured: !!config.anthropic },
  drafter,
  redteam: createAgentRunner({ gatewayUrl: `http://127.0.0.1:${config.port}`, anthropic: config.anthropic }),
});

// Sign a ledger checkpoint every minute (only when the head moved).
const cp = setInterval(() => void checkpoint(db, config.gatewaySecretKeyHex, new Date()).catch(() => {}), 60_000);

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[leash] gateway on :${config.port} | payments: ${provider.name} | llm: ${config.anthropic?.model ?? "off"} | demo: ${config.demoMode}`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    clearInterval(cp);
    worker.stop();
    await app.close();
    await db.end();
    process.exit(0);
  });
