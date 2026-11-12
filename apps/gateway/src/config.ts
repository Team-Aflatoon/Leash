import { randomBytes } from "node:crypto";
import { generateKeyPair, parseGroqModels, publicKeyFromSecret, sha256Hex } from "@leash/core";

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
  /** The LLM used by the gateway (intent check, mandate drafting). Null = rules only. */
  llm: LlmConfig | null;
  /** Credentials handed to the live agent process. Prefer a separate, spend-capped key (review R8). */
  agentLlm: LlmConfig | null;
  /** Groq: the fallback behind Gemini, or the only LLM when it is the only key (D14). */
  groq: GroqConfig | null;
  agentGroq: GroqConfig | null;
  trustProxyHops: number | false;
  maxAgentRuns: number;
  /** auto: try Vault, fall back to a standing hold if PayPal refuses (D13). */
  consentMode: "auto" | "vault" | "hold";
  holdCents: number;
}

export type LlmProvider = "gemini" | "anthropic";
export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
}

export interface GroqConfig {
  apiKey: string;
  models: string[];
}

/** Groq key and model chain. AGENT_GROQ_API_KEY lets the live agent use its own key. */
export function pickGroq(env: NodeJS.ProcessEnv, forAgent: boolean): GroqConfig | null {
  const apiKey = (forAgent ? env.AGENT_GROQ_API_KEY : undefined) ?? env.GROQ_API_KEY;
  return apiKey ? { apiKey, models: parseGroqModels(env.GROQ_MODELS) } : null;
}

const DEFAULT_MODEL: Record<LlmProvider, string> = { gemini: "gemini-flash-latest", anthropic: "claude-opus-5-5" };

/** LLM_PROVIDER picks explicitly; otherwise Gemini when GEMINI_API_KEY is set, else Anthropic when its key is set. */
export function pickLlm(env: NodeJS.ProcessEnv, forAgent: boolean): LlmConfig | null {
  const keys: Record<LlmProvider, string | undefined> = {
    gemini: (forAgent ? env.AGENT_GEMINI_API_KEY : undefined) ?? env.GEMINI_API_KEY,
    anthropic: (forAgent ? env.AGENT_ANTHROPIC_API_KEY : undefined) ?? env.ANTHROPIC_API_KEY,
  };
  if (env.LLM_PROVIDER === "groq") return null; // Groq only: see pickGroq
  const explicit = env.LLM_PROVIDER as LlmProvider | undefined;
  if (explicit && explicit !== "gemini" && explicit !== "anthropic") throw new Error("LLM_PROVIDER must be gemini, anthropic or groq");
  const provider: LlmProvider | null = explicit ?? (keys.gemini ? "gemini" : keys.anthropic ? "anthropic" : null);
  if (!provider || !keys[provider]) return null;
  const model = (provider === "gemini" ? env.GEMINI_MODEL : env.ANTHROPIC_MODEL) ?? env.LLM_MODEL ?? DEFAULT_MODEL[provider];
  return { provider, apiKey: keys[provider]!, model };
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
    llm: pickLlm(env, false),
    agentLlm: pickLlm(env, true),
    groq: pickGroq(env, false),
    agentGroq: pickGroq(env, true),
    trustProxyHops: env.TRUST_PROXY_HOPS ? Number(env.TRUST_PROXY_HOPS) : false,
    maxAgentRuns: Number(env.MAX_AGENT_RUNS ?? 3),
    consentMode: env.PAYPAL_CONSENT_MODE === "vault" || env.PAYPAL_CONSENT_MODE === "hold" ? env.PAYPAL_CONSENT_MODE : "auto",
    holdCents: Number(env.PAYPAL_HOLD_CENTS ?? 200_000),
  };
}
