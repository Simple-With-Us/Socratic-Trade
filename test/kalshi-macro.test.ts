import { afterEach, describe, expect, it, vi } from "vitest";
import { clearKalshiCacheForTests } from "../src/lib/kalshi";
import {
  DEFAULT_KALSHI_MACRO_SERIES,
  fetchKalshiMacroContext,
  formatKalshiLinesForPrompt,
  kalshiMacroContextEnabled,
  resolveKalshiMacroSeries
} from "../src/lib/kalshi-macro";

const fixtureMarket = {
  ticker: "KXFEDDECISION-26SEP-C25",
  event_ticker: "KXFEDDECISION-26SEP",
  title: "Fed funds 25bp cut",
  status: "open",
  yes_bid_dollars: "0.42",
  yes_ask_dollars: "0.46",
  last_price_dollars: "0.44",
  open_interest: 12000,
  close_time: "2026-09-17T18:00:00Z"
};

afterEach(() => {
  clearKalshiCacheForTests();
  vi.unstubAllGlobals();
  delete process.env.KALSHI_ENV;
  delete process.env.KALSHI_CONTEXT;
  delete process.env.KALSHI_MACRO_SERIES;
  delete process.env.KALSHI_INCLUDE_ELECTIONS;
});

describe("Kalshi macro series catalog", () => {
  it("defaults to Fed/CPI/recession/labor/GDP and keeps elections off", () => {
    expect(resolveKalshiMacroSeries()).toEqual([...DEFAULT_KALSHI_MACRO_SERIES]);
    process.env.KALSHI_INCLUDE_ELECTIONS = "on";
    expect(resolveKalshiMacroSeries()).toContain("KXPRES");
  });

  it("is inert without KALSHI_ENV even when the context knob is on", () => {
    process.env.KALSHI_CONTEXT = "on";
    expect(kalshiMacroContextEnabled()).toBe(false);
  });
});

describe("fetchKalshiMacroContext", () => {
  it("returns empty when unconfigured and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = await fetchKalshiMacroContext();
    expect(ctx.lines).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats fixture markets into prompt lines without live keys", async () => {
    process.env.KALSHI_ENV = "demo";
    process.env.KALSHI_CONTEXT = "on";
    process.env.KALSHI_MACRO_SERIES = "KXFEDDECISION";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ markets: [fixtureMarket] })
    })));
    const ctx = await fetchKalshiMacroContext();
    expect(ctx.lines.length).toBe(1);
    expect(ctx.lines[0]).toContain("KXFEDDECISION");
    expect(ctx.lines[0]).toContain("yes 44%");
    expect(formatKalshiLinesForPrompt(ctx.signals)[0]).toEqual(ctx.lines[0]);
  });
});
