import { canonicalHash, type IntentVerdict, type ResolvedLine } from "@leash/core";
import type { Db } from "./db.ts";

export interface IntentCheckInput {
  intent: string;
  lines: ResolvedLine[];
  total_cents: number;
  merchant_id: string | null;
  /** The agent's free-text rationale. Untrusted. */
  agent_note: string | null;
}

export interface IntentChecker {
  readonly model: string | null;
  readonly promptVersion: string;
  /** Must not throw; returns `{kind: "error"}` instead. */
  check(input: IntentCheckInput): Promise<IntentVerdict>;
}

export const noIntentChecker: IntentChecker = {
  model: null,
  promptVersion: "none",
  async check() {
    return { kind: "not_configured" };
  },
};

/**
 * Caches verdicts by (model, prompt version, input). Same input → same verdict on every run, which makes the demo
 * deterministic. Only definitive verdicts are cached; errors are retried next time.
 */
export function cachedIntentChecker(db: Db, inner: IntentChecker): IntentChecker {
  if (!inner.model) return inner;
  return {
    model: inner.model,
    promptVersion: inner.promptVersion,
    async check(input) {
      const key = canonicalHash({ model: inner.model, v: inner.promptVersion, input: { ...input, lines: input.lines.map((l) => ({ ...l })) } });
      const hit = await db.query<{ response: IntentVerdict }>("SELECT response FROM llm_cache WHERE cache_key = $1", [key]);
      if (hit.rows[0]) {
        const v = hit.rows[0].response;
        return v.kind === "consistent" ? { ...v, cached: true } : v;
      }
      const v = await inner.check(input);
      if (v.kind === "consistent" || v.kind === "suspicious")
        await db.query("INSERT INTO llm_cache(cache_key, model, response) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [key, inner.model, JSON.stringify(v)]);
      return v;
    },
  };
}
