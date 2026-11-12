import { groqChat, isAvailabilityError, type GroqOptions, type IntentVerdict } from "@leash/core";
import { INTENT_SYSTEM, buildIntentPrompt } from "./claude.ts";
import { DRAFT_SYSTEM, DraftOut, IntentOut, draftFromModel } from "./gemini.ts";
import type { IntentCheckInput, IntentChecker } from "./intent.ts";
import type { MandateDraft, MandateDrafter } from "./llm.ts";

/**
 * Groq implementations of the two gateway LLM roles, and the wrappers that put Groq behind Gemini (D14).
 * Same contract as the Gemini and Claude ones: JSON output validated with zod, any failure fails closed.
 *
 * Groq's JSON mode (`response_format: json_object`) is used rather than a strict schema; zod is the real check.
 */

const INTENT_JSON = `${INTENT_SYSTEM}

Reply with one JSON object and nothing else: {"verdict": "consistent" | "suspicious", "rationale": "<one or two sentences>"}.`;

const DRAFT_JSON = `${DRAFT_SYSTEM}

Reply with one JSON object and nothing else, with exactly these fields: budget_limit_cents, per_order_cap_cents,
approval_threshold_cents (integers), allowed_categories (array of strings), max_units_per_line, max_units_per_order
(integers), has_address (boolean), address (object with name, line1, city, state, postal_code, country_code, all
strings), notes (array of strings).`;

export class GroqIntentChecker implements IntentChecker {
  readonly promptVersion = "intent-v1-groq";
  readonly model: string;
  constructor(
    private readonly apiKey: string,
    private readonly models: string[],
    private readonly opts: GroqOptions = {},
  ) {
    this.model = `groq:${models[0] ?? "none"}`;
  }

  async check(input: IntentCheckInput): Promise<IntentVerdict> {
    try {
      const r = await groqChat(
        this.apiKey,
        this.models,
        {
          messages: [
            { role: "system", content: INTENT_JSON },
            { role: "user", content: buildIntentPrompt(input) },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        },
        this.opts,
      );
      const parsed = IntentOut.safeParse(JSON.parse(r.message.content ?? ""));
      if (!parsed.success) return { kind: "error", error: "unparseable output" };
      return parsed.data.verdict === "consistent" ? { kind: "consistent", rationale: parsed.data.rationale } : { kind: "suspicious", rationale: parsed.data.rationale };
    } catch (e) {
      return { kind: "error", error: e instanceof Error ? e.message.slice(0, 200) : "LLM call failed" };
    }
  }
}

export class GroqMandateDrafter implements MandateDrafter {
  constructor(
    private readonly apiKey: string,
    private readonly models: string[],
    private readonly opts: GroqOptions = {},
  ) {}

  async draft(intent: string): Promise<MandateDraft> {
    try {
      const r = await groqChat(
        this.apiKey,
        this.models,
        {
          messages: [
            { role: "system", content: DRAFT_JSON },
            { role: "user", content: `<owner_instructions>\n${intent}\n</owner_instructions>` },
          ],
          temperature: 0,
          // One rare call where getting every number right matters: at "low", gpt-oss skipped stated thresholds.
          reasoning_effort: "medium",
          response_format: { type: "json_object" },
        },
        { timeoutMs: 30_000, ...this.opts },
      );
      const p = DraftOut.safeParse(JSON.parse(r.message.content ?? ""));
      return draftFromModel(intent, p.success ? p.data : null);
    } catch {
      return draftFromModel(intent, null);
    }
  }
}

/**
 * SAFETY (G3): asks `secondary` only when `primary` failed for an availability reason (overload, rate limit,
 * timeout, network, credentials). A safety block or unusable output from the primary stays an error, which the
 * policy turns into a HOLD: otherwise an agent could trip one model's filter on purpose to get a second opinion.
 * Either way the verdict can still only tighten the rules' decision (`combine`).
 */
export function fallbackIntentChecker(primary: IntentChecker, secondary: IntentChecker): IntentChecker {
  return {
    model: primary.model ?? secondary.model,
    promptVersion: `${primary.promptVersion}+${secondary.promptVersion}`,
    async check(input) {
      const v = await primary.check(input);
      if (v.kind !== "error" || !isAvailabilityError(v.error)) return v;
      const w = await secondary.check(input);
      return w.kind === "error" ? { kind: "error", error: `${v.error.slice(0, 120)}; fallback: ${w.error.slice(0, 120)}` } : w;
    },
  };
}

/** Drafting has no safety edge (the owner reviews every field before signing): any primary failure tries Groq. */
export function fallbackDrafter(primary: MandateDrafter, secondary: MandateDrafter): MandateDrafter {
  return {
    async draft(intent) {
      const d = await primary.draft(intent);
      return d.source === "llm" ? d : secondary.draft(intent);
    },
  };
}
