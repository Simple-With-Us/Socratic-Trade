import { describe, it, expect } from "vitest";
import { computeMarketInternals } from "../src/lib/market-internals";
import type { MarketQuote, MarketScan } from "../src/lib/types";

function q(o: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 50,
    ...o
  };
}

function scan(candidates: MarketQuote[], breadthPct?: number): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-06-17T00:00:00.000Z",
    scannedSymbols: 500,
    returnedQuotes: candidates.length,
    breadthPct,
    topCandidates: candidates,
    sectorBySymbol: {},
    quotesBySymbol: {},
    warnings: []
  };
}

describe("computeMarketInternals", () => {
  const candidates = [
    q({ symbol: "A", sector: "Technology", intradayChangePct: 2, eps: 5, price: 100, peRatio: 20, fiftyTwoWeekHigh: 120, fiftyTwoWeekLow: 80 }),
    q({ symbol: "B", sector: "Technology", intradayChangePct: 4, eps: 4, price: 100, peRatio: 25, fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 50 }),
    q({ symbol: "C", sector: "Energy", intradayChangePct: -1, eps: 10, price: 50, peRatio: 5, fiftyTwoWeekHigh: 60, fiftyTwoWeekLow: 40 }),
    q({ symbol: "D", sector: "Energy", intradayChangePct: -3, eps: -2, price: 40, fiftyTwoWeekHigh: 80, fiftyTwoWeekLow: 30 })
  ];
  const internals = computeMarketInternals(scan(candidates, 47));

  it("counts advancers and decliners and carries full-screener breadth", () => {
    expect(internals.advancers).toBe(2); // A, B
    expect(internals.decliners).toBe(2); // C, D
    expect(internals.breadthPct).toBe(47);
  });

  it("computes median P/E (positive only) and median earnings yield", () => {
    expect(internals.medianPE).toBe(20); // [5, 20, 25] -> 20
    expect(internals.medianEarnYld).toBe(4.5); // earnYld [-5, 4, 5, 20] -> (4+5)/2
  });

  it("computes the share of names above their 52-week midpoint", () => {
    // positions: A 50, B 83.3, C 50, D 20 -> only B is >50 -> 25%
    expect(internals.pctAboveRangeMid).toBe(25);
  });

  it("ranks sectors by average intraday move, leaders first", () => {
    expect(internals.sectorRotation[0]).toEqual({ sector: "Technology", avgChangePct: 3, count: 2 });
    expect(internals.sectorRotation[1]).toEqual({ sector: "Energy", avgChangePct: -2, count: 2 });
  });
});
