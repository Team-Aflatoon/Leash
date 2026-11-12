import { randomBytes } from "node:crypto";
import { generateKeyPair, publicKeyFromSecret, sha256Hex } from "@leash/core";

export interface Config {
  port: number;
  databaseUrl: string;
  publicUrl: string;
  demoMode: boolean;
  approvalTimeoutSeconds: number;
  agentToken: string;
  gatewaySecretKeyHex: string;
  gatewayPublicKeyHex: string;
  paypal: { clientId: string; clientSecret: string; webhookId: string | null; baseUrl: string } | null;
  anthropic: { apiKey: string; model: string } | null;
  /** Key handed to the live agent process. Prefer a separate, spend-capped key (review R8). */
  agentLlm: { apiKey: string; model: string } | null;
  trustProxyHops: number | false;
  maxAgentRuns: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(env = process.env): Config {
  // Accept 32-byte hex, or any high-entropy string (e.g. a host-generated secret) which is hashed into a key.
  const raw = env.GATEWAY_SIGNING_KEY;
  const sk = !raw ? generateKeyPair().secretKeyHex : /^[0-9a-f]{64}$/.test(raw) ? raw : sha256Hex(`leash-gateway-key:${raw}`);
  if (raw && raw.length < 32) throw new Error("GATEWAY_SIGNING_KEY is too short");
  if (!env.GATEWAY_SIGNING_KEY) console.warn("[leash] GATEWAY_SIGNING_KEY not set: using an ephemeral key; ledger checkpoints won't verify after restart");
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? {
          clientId: env.PAYPAL_CLIENT_ID,
          clientSecret: env.PAYPAL_CLIENT_SECRET,
          webhookId: env.PAYPAL_WEBHOOK_ID ?? null,
          // Sandbox only. Live is deliberately not configurable in this hackathon build.
          baseUrl: "https://api-m.sandbox.paypal.com",
        }
      : null;
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? req("DATABASE_URL"),
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/$/, ""),
    demoMode: env.DEMO_MODE !== "false",
    approvalTimeoutSeconds: Number(env.APPROVAL_TIMEOUT_SECONDS ?? 600),
    agentToken: env.AGENT_TOKEN ?? randomBytes(24).toString("base64url"),
    gatewaySecretKeyHex: sk,
    gatewayPublicKeyHex: publicKeyFromSecret(sk),
    paypal,
    anthropic: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL ?? "claude-opus-5-5" } : null,
    agentLlm: (env.AGENT_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY) ? { apiKey: (env.AGENT_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY)!, model: env.LLM_MODEL ?? "claude-opus-5-5" } : null,
    trustProxyHops: env.TRUST_PROXY_HOPS ? Number(env.TRUST_PROXY_HOPS) : false,
    maxAgentRuns: Number(env.MAX_AGENT_RUNS ?? 3),
  };
}
