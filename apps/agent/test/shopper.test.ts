import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../src/client.ts";
import { groqDriver, makeTools, runShopper, toOpenAi, type Driver, type Reply, type Turn } from "../src/shopper.ts";

function fakeClient() {
  const proposals: Record<string, unknown>[] = [];
  const counts = { mandate: 0, catalog: 0 };
  const client = {
    mandate: async () => (counts.mandate++, { budget: 40000 }),
    catalog: async () => (counts.catalog++, [{ sku: "BEAN-ESP-1KG" }]),
    propose: async (b: Record<string, unknown>) => (proposals.push(b), { decision_id: `d${proposals.length}`, outcome: "ALLOW" }),
  } as unknown as GatewayClient;
  return { client, proposals, counts };
}

/** A scripted driver: each step returns the next reply, or throws the next error. */
function scripted(provider: "gemini" | "groq", steps: (Reply | Error)[]) {
  const seen: Turn[][] = [];
  const d: Driver & { seen: Turn[][] } = {
    provider,
    model: `${provider}-model`,
    seen,
    async next(h) {
      seen.push(structuredClone(h));
      const s = steps.shift();
      if (!s) throw new Error("script ran out");
      if (s instanceof Error) throw s;
      return s;
    },
  };
  return d;
}
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, args });
const order = { lines: [{ sku: "BEAN-ESP-1KG", quantity: 2 }], note: "Beans are low." };

describe("live agent: Gemini to Groq failover", () => {
  it("switches once on overload, keeps the history, and never runs a tool twice", async () => {
    const { client, proposals, counts } = fakeClient();
    const events: Record<string, unknown>[] = [];
    const tools = makeTools(client, "r1", (e) => events.push(e));
    const gemini = scripted("gemini", [{ text: "", calls: [call("g1", "get_mandate")] }, new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"high demand"}}')]);
    const groq = scripted("groq", [
      { text: "", calls: [call("q1", "propose_order", order)] },
      // the same cart again with a reworded note, as a model does after a timeout
      { text: "", calls: [call("q2", "propose_order", { ...order, note: "Retrying the bean order." })] },
      { text: "Ordered beans.", calls: [] },
    ]);
    await runShopper(tools, "restock", [gemini, groq], (e) => events.push(e));

    expect(events.filter((e) => e.type === "provider").map((e) => [e.provider, !!e.reason])).toEqual([["gemini", false], ["groq", true]]);
    expect(events.at(-1)).toEqual({ type: "final", text: "Ordered beans." });
    expect(gemini.seen).toHaveLength(2); // never asked again after the switch
    expect(counts.mandate).toBe(1);
    // Groq picked up the conversation Gemini started, including the tool result.
    const handed = groq.seen[0]!;
    expect(handed.map((t) => t.role)).toEqual(["user", "model", "tool"]);
    expect(handed[2]).toMatchObject({ role: "tool", results: [{ call: { id: "g1", name: "get_mandate" }, result: { budget: 40000 } }] });
    // The repeated cart resent the first request byte for byte, so the gateway replays its decision.
    expect(proposals).toHaveLength(2);
    expect(proposals[1]).toEqual(proposals[0]);
    expect(proposals[0]).toMatchObject({ idempotency_key: "live-r1-1", note: "Beans are low." });
  });

  it("a different cart gets a new idempotency key", async () => {
    const { client, proposals } = fakeClient();
    const tools = makeTools(client, "r2", () => {});
    const d = scripted("groq", [{ text: "", calls: [call("a", "propose_order", order), call("b", "propose_order", { lines: [{ sku: "BEAN-ESP-1KG", quantity: 3 }], note: "More." })] }, { text: "done", calls: [] }]);
    await runShopper(tools, "restock", [d], () => {});
    expect(proposals.map((p) => p.idempotency_key)).toEqual(["live-r2-1", "live-r2-2"]);
  });

  it("does not switch on an error that is not about availability", async () => {
    const { client } = fakeClient();
    const tools = makeTools(client, "r3", () => {});
    const groq = scripted("groq", [{ text: "x", calls: [] }]);
    await expect(runShopper(tools, "t", [scripted("gemini", [new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}')]), groq], () => {})).rejects.toThrow(/400/);
    expect(groq.seen).toHaveLength(0);
  });

  it("renders the history as OpenAI-style messages with tool results paired to their calls", () => {
    const msgs = toOpenAi([
      { role: "user", text: "restock" },
      { role: "model", text: "", calls: [call("c1", "search_catalog", { query: "oat" })] },
      { role: "tool", results: [{ call: call("c1", "search_catalog", { query: "oat" }), result: [{ sku: "OAT" }] }] },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_catalog", arguments: '{"query":"oat"}' } }] });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '[{"sku":"OAT"}]' });
  });

  it("the Groq driver sends the three tools and parses tool calls, including malformed arguments", async () => {
    const sent: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "propose_order", arguments: "{bad" } }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client } = fakeClient();
    const d = groqDriver(makeTools(client, "r4", () => {}), "k", ["openai/gpt-oss-120b"], { fetchImpl });
    const r = await d.next([{ role: "user", text: "restock" }]);
    expect(sent[0].tools.map((t: any) => t.function.name)).toEqual(["get_mandate", "search_catalog", "propose_order"]);
    expect(r.calls).toEqual([{ id: "t1", name: "propose_order", args: { _invalid: "{bad" } }]);
  });
});
