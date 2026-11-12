import type { MandateBody } from "@leash/core";

/** Fields of a mandate the LLM may propose. Ids, owner, times are filled by the console before signing. */
export type MandateDraft = Pick<
  MandateBody,
  "intent" | "budget" | "per_order_cap_cents" | "approval_threshold_cents" | "allowed_categories" | "allowed_merchants" | "max_units_per_line" | "max_units_per_order"
> & { ship_to: MandateBody["ship_to"] | null; notes: string[]; source: "llm" | "template" };

export interface MandateDrafter {
  draft(intent: string): Promise<MandateDraft>;
}
