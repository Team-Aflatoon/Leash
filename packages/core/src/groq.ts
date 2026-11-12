/**
 * Minimal Groq client (OpenAI-compatible chat completions) with a model chain. Shared by the gateway (intent check,
 * mandate drafting) and the agent process (live shopper), which may not import gateway code.
 *
 * Groq is the fallback when Gemini is unavailable (D14). Its free tier limits each model separately (about 8,000
 * tokens a minute), so trying the next model on a 429 roughly multiplies the headroom.
 */
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];

export function parseGroqModels(s: string | undefined): string[] {
  const list = (s ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_GROQ_MODELS];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResult {
  model: string;
  finish_reason: string;
  message: { content: string | null; tool_calls?: ChatToolCall[] };
}

export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when another attempt (or another provider) may succeed: overload, rate limit, timeout, network. */
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/**
 * True for failures that say nothing about the input: capacity (503, 429), timeouts, network errors and broken
 * credentials. Only these may move a request to a fallback provider. A safety block or unusable output is NOT one of
 * them, so tripping one model's filter can never shop the request to a second model.
 */
export function isAvailabilityError(e: unknown): boolean {
  if (e instanceof LlmCallError) return e.transient;
  const s = typeof e === "string" ? e : String((e as Error)?.message ?? e);
  return /\b(500|502|503|504|429|401|403|UNAVAILABLE|RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED|DEADLINE_EXCEEDED|aborted|fetch failed|ECONNRESET|ETIMEDOUT)\b|high demand|overloaded|timed? ?out|API key/i.test(s);
}

export interface GroqOptions {
  timeoutMs?: number;
  /** Longest Retry-After we are willing to wait once every model has been rate limited. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * Sends one chat request, trying each model in turn. Moves to the next model on overload, rate limit, timeout,
 * network error, or a model that produced a malformed tool call or JSON (Groq reports those as 400s). If every model
 * was rate limited with a short Retry-After, waits once and tries the chain again. Any other error throws at once.
 */
export async function groqChat(apiKey: string, models: string[], body: Record<string, unknown>, opts: GroqOptions = {}): Promise<ChatResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = opts.maxRetryAfterMs ?? 8_000;
  let last: LlmCallError = new LlmCallError("no Groq models configured", null, false);
  for (let round = 0; round < 2; round++) {
    let wait: number | null = null;
    for (const model of models) {
      const payload: Record<string, unknown> = { ...body, model };
      // reasoning_effort low/medium/high is a gpt-oss setting; other models reject those values.
      if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = body.reasoning_effort ?? "low";
      else delete payload.reasoning_effort;
      let res: Response;
      try {
        res = await f(GROQ_CHAT_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
      } catch (e) {
        last = new LlmCallError(`groq ${model}: ${(e as Error)?.message ?? e}`, null, true);
        continue;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string }; choices?: { finish_reason?: string; message?: ChatResult["message"] }[] };
      if (res.ok && j.choices?.[0]?.message) return { model, finish_reason: j.choices[0].finish_reason ?? "", message: j.choices[0].message };
      const msg = `groq ${model} ${res.status}: ${j.error?.message ?? "no message"}`.slice(0, 300);
      const modelFault = res.status === 400 && /tool_use_failed|json_validate_failed|output_parse_failed/.test(j.error?.code ?? "");
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2_000;
        wait = wait === null ? ms : Math.min(wait, ms);
        last = new LlmCallError(msg, 429, true);
      } else if (res.status >= 500 || modelFault || res.ok) {
        last = new LlmCallError(msg, res.status, true);
      } else {
        throw new LlmCallError(msg, res.status, res.status === 401 || res.status === 403);
      }
    }
    if (round === 0 && wait !== null && wait <= maxWait) await sleep(wait);
    else break;
  }
  throw last;
}
