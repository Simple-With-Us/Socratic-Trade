import { describe, expect, it, vi } from "vitest";
import { buildTools, type ToolDeps } from "../src/lib/chat/tools";

const tools = buildTools();
const ctx = (deps: Partial<ToolDeps> = {}) => ({ userId: "u1", deps: deps as ToolDeps });

describe("draft_order — fail-closed validation", () => {
  it("rejects invalid side values instead of coercing to buy", async () => {
    const result = await tools.draft_order.execute({ symbol: "AAPL", side: "Short", qty: 5 }, ctx());
    expect(result).toMatchObject({ error: "INVALID_SIDE" });
    expect(result).not.toHaveProperty("draft_id");
    expect(result).not.toHaveProperty("side", "buy");
  });

  it("rejects invalid order_type values instead of coercing to market", async () => {
    const result = await tools.draft_order.execute(
      { symbol: "AAPL", side: "buy", qty: 5, order_type: "stop", limit_usd: 150 },
      ctx()
    );
    expect(result).toMatchObject({ error: "INVALID_ORDER_TYPE" });
    expect(result).not.toHaveProperty("draft_id");
  });

  it("rejects limit orders missing a positive limit_usd", async () => {
    const result = await tools.draft_order.execute(
      { symbol: "AAPL", side: "buy", qty: 5, order_type: "limit" },
      ctx()
    );
    expect(result).toMatchObject({ error: "INVALID_LIMIT" });
    expect(result).not.toHaveProperty("draft_id");
  });

  it("accepts case-insensitive buy/sell and market/limit", async () => {
    const sell = await tools.draft_order.execute(
      { symbol: "AAPL", side: "Sell", qty: 2, order_type: "LIMIT", limit_usd: 200 },
      ctx()
    );
    expect(sell).toMatchObject({ symbol: "AAPL", side: "sell", order_type: "limit", limit_usd: 200, qty: 2 });
    expect(sell).toHaveProperty("draft_id");

    const buy = await tools.draft_order.execute({ symbol: "MSFT", side: "BUY", qty: 1 }, ctx());
    expect(buy).toMatchObject({ symbol: "MSFT", side: "buy", order_type: "market", limit_usd: null, qty: 1 });
  });
});

describe("kb_search — k clamping", () => {
  it("clamps k to [1, 20] and defaults to 5 when absent", async () => {
    const searchKnowledge = vi.fn().mockResolvedValue([]);
    await tools.kb_search.execute({ query: "earnings", k: 999 }, ctx({ searchKnowledge }));
    expect(searchKnowledge).toHaveBeenCalledWith(expect.objectContaining({ k: 20 }), "u1");

    searchKnowledge.mockClear();
    await tools.kb_search.execute({ query: "earnings" }, ctx({ searchKnowledge }));
    expect(searchKnowledge).toHaveBeenCalledWith(expect.objectContaining({ k: 5 }), "u1");

    searchKnowledge.mockClear();
    await tools.kb_search.execute({ query: "earnings", k: 0 }, ctx({ searchKnowledge }));
    expect(searchKnowledge).toHaveBeenCalledWith(expect.objectContaining({ k: 1 }), "u1");
  });

  it("documents maximum k in the input schema", () => {
    const schema = tools.kb_search.input_schema as { properties?: { k?: { maximum?: number } } };
    expect(schema.properties?.k?.maximum).toBe(20);
  });
});
