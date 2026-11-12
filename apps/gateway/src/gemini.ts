import { GoogleGenAI } from "@google/genai";
import { DEMO_CATALOG, DEMO_MANDATE_DEFAULTS, type IntentVerdict } from "@leash/core";
import { z } from "zod";
import { INTENT_SYSTEM, buildIntentPrompt, templateDraft } from "./claude.ts";
import type { IntentCheckInput, IntentChecker } from "./intent.ts";
import type { MandateDraft, MandateDrafter } from "./llm.ts";

/**
 * Gemini implementations of the two gateway LLM roles. Same contract as the Claude ones:
 * structured JSON, validated with zod, and any failure (error, safety block, bad JSON) fails closed.
 */

const IntentOut = z.object({ verdict: z.enum(["consistent", "suspicious"]), rationale: z.string() });
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["consistent", "suspicious"] },
    rationale: { type: "string" },
  },
  required: ["verdict", "rationale"],
};

function blocked(res: { promptFeedback?: { blockReason?: unknown }; candidates?: { finishReason?: unknown }[] }): string | null {
  if (res.promptFeedback?.blockReason) return `prompt blocked (${String(res.promptFeedback.blockReason)})`;
  const fr = res.candidates?.[0]?.finishReason;
  if (fr && fr !== "STOP" && fr !== "MAX_TOKENS") return `finished with ${String(fr)}`;
  return null;
}

export class GeminiIntentChecker implements IntentChecker {
  readonly promptVersion = "intent-v1-gemini";
  private ai: GoogleGenAI;
  constructor(apiKey: string, readonly model: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async check(input: IntentCheckInput): Promise<IntentVerdict> {
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: buildIntentPrompt(input),
        config: { systemInstruction: INTENT_SYSTEM, responseMimeType: "application/json", responseJsonSchema: INTENT_SCHEMA, temperature: 0, abortSignal: AbortSignal.timeout(45_000) },
      });
      const why = blocked(res);
      if (why) return { kind: "error", error: why };
      const parsed = IntentOut.safeParse(JSON.parse(res.text ?? ""));
      if (!parsed.success) return { kind: "error", error: "unparseable output" };
      return parsed.data.verdict === "consistent" ? { kind: "consistent", rationale: parsed.data.rationale } : { kind: "suspicious", rationale: parsed.data.rationale };
    } catch (e) {
      return { kind: "error", error: e instanceof Error ? e.message.slice(0, 200) : "LLM call failed" };
    }
  }
}

const CATEGORIES = [...new Set(DEMO_CATALOG.map((c) => c.category))];
const cents = z.number().int().min(0).max(10_000_000);
const DraftOut = z.object({
  budget_limit_cents: cents,
  per_order_cap_cents: cents,
  approval_threshold_cents: cents,
  allowed_categories: z.array(z.string()),
  max_units_per_line: z.number().int().min(1).max(1000),
  max_units_per_order: z.number().int().min(1).max(10000),
  has_address: z.boolean(),
  address: z.object({ name: z.string(), line1: z.string(), city: z.string(), state: z.string(), postal_code: z.string(), country_code: z.string() }),
  notes: z.array(z.string()),
});
const str = { type: "string" };
const int = { type: "integer" };
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    budget_limit_cents: int,
    per_order_cap_cents: int,
    approval_threshold_cents: int,
    allowed_categories: { type: "array", items: { type: "string", enum: CATEGORIES } },
    max_units_per_line: int,
    max_units_per_order: int,
    has_address: { type: "boolean" },
    address: { type: "object", properties: { name: str, line1: str, city: str, state: str, postal_code: str, country_code: str }, required: ["name", "line1", "city", "state", "postal_code", "country_code"] },
    notes: { type: "array", items: str },
  },
  required: ["budget_limit_cents", "per_order_cap_cents", "approval_threshold_cents", "allowed_categories", "max_units_per_line", "max_units_per_order", "has_address", "address", "notes"],
};

const DRAFT_SYSTEM = `You turn a business owner's plain-English spending instructions into a structured mandate for a
shopping agent. The owner reviews every field before signing, so be conservative and explicit.
Rules: money is integer US cents ("$400 a month" is budget_limit_cents 40000). Use only these categories:
${CATEGORIES.join(", ")}. If no per-order cap is given use the monthly budget; if no approval threshold, half the
per-order cap; if no quantity limits, 12 per line and 40 per order. Set has_address true only if the owner gave a full
address (otherwise fill address with empty strings). Add one short note for every assumption you made.`;

export class GeminiMandateDrafter implements MandateDrafter {
  private ai: GoogleGenAI;
  constructor(apiKey: string, private readonly model: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async draft(intent: string): Promise<MandateDraft> {
    let d: z.infer<typeof DraftOut> | null = null;
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: `<owner_instructions>\n${intent}\n</owner_instructions>`,
        config: { systemInstruction: DRAFT_SYSTEM, responseMimeType: "application/json", responseJsonSchema: DRAFT_SCHEMA, temperature: 0, abortSignal: AbortSignal.timeout(60_000) },
      });
      if (!blocked(res)) {
        const p = DraftOut.safeParse(JSON.parse(res.text ?? ""));
        if (p.success) d = p.data;
      }
    } catch {
      d = null;
    }
    if (!d) return templateDraft(intent, ["The model could not draft this mandate; showing the template. Edit before signing."]);
    const cats = d.allowed_categories.filter((c) => CATEGORIES.includes(c));
    const budget = Math.max(1, d.budget_limit_cents);
    const addr = d.address;
    return {
      intent,
      budget: { period: "month", limit_cents: budget },
      per_order_cap_cents: Math.max(1, Math.min(d.per_order_cap_cents || budget, budget)),
      approval_threshold_cents: d.approval_threshold_cents,
      allowed_categories: cats.length ? cats : DEMO_MANDATE_DEFAULTS.allowed_categories,
      allowed_merchants: [...DEMO_MANDATE_DEFAULTS.allowed_merchants],
      max_units_per_line: d.max_units_per_line,
      max_units_per_order: d.max_units_per_order,
      ship_to: d.has_address && addr.line1 && /^[A-Z]{2}$/.test(addr.country_code) ? addr : null,
      notes: d.notes,
      source: "llm",
    };
  }
}
