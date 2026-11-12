import { randomBytes } from "node:crypto";
import { generateKeyPair, publicKeyFromSecret } from "@leash/core";

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
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(env = process.env): Config {
  const sk = env.GATEWAY_SIGNING_KEY ?? generateKeyPair().secretKeyHex;
  if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error("GATEWAY_SIGNING_KEY must be 32 bytes hex");
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
  };
}
