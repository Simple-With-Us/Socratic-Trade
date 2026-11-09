import { describe, expect, it } from "vitest";
import { buildTools, type ToolDeps } from "../src/lib/chat/tools";

// Read-only state tools: get_portfolio_pnl, get_performance_summary, get_reflection. They read app
// state via injected deps and degrade gracefully (null/empty) when a dep isn't wired — chat never
// invents numbers.
const tools = buildTools();
const ctx = (deps: Partial<ToolDeps>) => ({ userId: "u1", deps: deps as ToolDeps });

describe("read-only chat state tools", () => {
  it("get_portfolio_pnl returns the dep's P&L and degrades to null without the dep", async () => {
    const pnl = { liveRealizedPnl: 10, paperRealizedPnl: 5, liveUnrealizedPnl: 2, paperUnrealizedPnl: 1, liveWinRate: 0.6, paperWinRate: 0.5 };
    expect(await tools.get_portfolio_pnl.execute({}, ctx({ getPortfolioPnl: async () => pnl }))).toEqual({ pnl });
    expect(await tools.get_portfolio_pnl.execute({}, ctx({}))).toEqual({ pnl: null });
  });

  it("get_performance_summary returns thesis+regime scorecards and degrades to empty", async () => {
    const summary = { byThesis: [{ key: "breakout", trades: 3, winRate: 0.66, avgReturnPct: 2.1, totalPnl: 30 }], byRegime: [] };
    expect(await tools.get_performance_summary.execute({}, ctx({ getPerformanceSummary: () => summary }))).toEqual(summary);
    expect(await tools.get_performance_summary.execute({}, ctx({}))).toEqual({ byThesis: [], byRegime: [] });
  });

  it("get_reflection returns the reflection text, or null when empty/absent", async () => {
    expect(await tools.get_reflection.execute({}, ctx({ getReflection: () => "Cut losers faster." }))).toEqual({ reflection: "Cut losers faster." });
    expect(await tools.get_reflection.execute({}, ctx({ getReflection: () => "" }))).toEqual({ reflection: null });
    expect(await tools.get_reflection.execute({}, ctx({}))).toEqual({ reflection: null });
  });

  it("all three are flagged read-only (no execution/state mutation)", () => {
    expect(tools.get_portfolio_pnl.readOnly).toBe(true);
    expect(tools.get_performance_summary.readOnly).toBe(true);
    expect(tools.get_reflection.readOnly).toBe(true);
  });
});

// Robinhood-backed read-only research tools: get_earnings_calendar, get_option_chain,
// search_instrument. They call through injected deps and degrade to a clear NOT_SUPPORTED result
// (never a throw) when the dep isn't wired — chat never invents data or fails the turn.
describe("robinhood read-only research tools", () => {
  it("all three are flagged read-only (no order placement)", () => {
    expect(tools.get_earnings_calendar.readOnly).toBe(true);
    expect(tools.get_option_chain.readOnly).toBe(true);
    expect(tools.search_instrument.readOnly).toBe(true);
  });

  it("input schemas match the existing tool style", () => {
    expect(tools.get_earnings_calendar.input_schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        start_date: { type: "string" },
        days: { type: "integer", minimum: -31, maximum: 31 },
        high_market_cap: { type: "boolean" }
      }
    });
    expect(tools.get_option_chain.input_schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: "string" } }
    });
    expect(tools.search_instrument.input_schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        asset_type: { type: "string", enum: ["instrument", "currency_pair", "market_index"] },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      }
    });
  });

  it("get_earnings_calendar validates input and calls through to the dep", async () => {
    let seen: unknown;
    const getEarningsCalendar = async (_userId: string, args: unknown) => {
      seen = args;
      return { earnings: [{ symbol: "AAPL" }] };
    };
    const res = await tools.get_earnings_calendar.execute(
      { start_date: "2026-06-30", days: 7, high_market_cap: true },
      ctx({ getEarningsCalendar })
    );
    expect(seen).toEqual({ start_date: "2026-06-30", days: 7, high_market_cap: true });
    expect(res).toEqual({ earnings: [{ symbol: "AAPL" }] });
    // Out-of-range/zero days and non-string start_date are dropped (undefined) server-side.
    await tools.get_earnings_calendar.execute({ days: 0, start_date: 5, high_market_cap: "yes" }, ctx({ getEarningsCalendar }));
    expect(seen).toEqual({ start_date: undefined, days: undefined, high_market_cap: false });
  });

  it("get_option_chain canonicalizes the symbol and calls through to the dep", async () => {
    let seen: unknown;
    const getOptionChain = async (_userId: string, symbol: string) => {
      seen = symbol;
      return { symbol, chains: [] };
    };
    const res = await tools.get_option_chain.execute({ symbol: "aapl" }, ctx({ getOptionChain }));
    expect(seen).toBe("AAPL");
    expect(res).toEqual({ symbol: "AAPL", chains: [] });
    expect(await tools.get_option_chain.execute({ symbol: "" }, ctx({ getOptionChain }))).toEqual({
      error: "INVALID_INPUT",
      details: "symbol required"
    });
  });

  it("search_instrument validates input and calls through to the dep", async () => {
    let seen: unknown;
    const searchInstrument = async (_userId: string, args: unknown) => {
      seen = args;
      return { results: [] };
    };
    await tools.search_instrument.execute({ query: "apple", asset_type: "instrument", limit: 5 }, ctx({ searchInstrument }));
    expect(seen).toEqual({ query: "apple", asset_type: "instrument", limit: 5 });
    // Unknown asset_type and out-of-range limit are dropped (undefined) server-side.
    await tools.search_instrument.execute({ query: "  tesla  ", asset_type: "bogus", limit: 99 }, ctx({ searchInstrument }));
    expect(seen).toEqual({ query: "tesla", asset_type: undefined, limit: undefined });
    expect(await tools.search_instrument.execute({ query: "   " }, ctx({ searchInstrument }))).toEqual({
      error: "INVALID_INPUT",
      details: "query required"
    });
  });

  it("all three degrade gracefully (NOT_SUPPORTED, no throw) when the dep is absent", async () => {
    expect(await tools.get_earnings_calendar.execute({}, ctx({}))).toEqual({ error: "NOT_SUPPORTED" });
    expect(await tools.get_option_chain.execute({ symbol: "AAPL" }, ctx({}))).toEqual({ error: "NOT_SUPPORTED" });
    expect(await tools.search_instrument.execute({ query: "apple" }, ctx({}))).toEqual({ error: "NOT_SUPPORTED" });
  });
});
