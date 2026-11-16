// Pure-function tests for outcome-horizons.ts's benchmark resolution (r4: index-vs-ETF basis).
// No DB, no I/O — resolveBenchmarkSeries/sectorBenchmarkEntry/computeDailyHorizonRows are all pure.
import { describe, expect, it } from "vitest";
import {
  computeDailyHorizonRows,
  MARKET_BENCHMARK_FALLBACK,
  MARKET_BENCHMARK_PRIMARY,
  resolveBenchmarkSeries,
  sectorBenchmarkEntry,
  type NormalizedDailyBar
} from "../src/lib/outcome-horizons";

const GSPC_BARS: NormalizedDailyBar[] = [
  { date: "2026-06-10", close: 5000 },
  { date: "2026-06-17", close: 5100 }
];
const SPY_BARS: NormalizedDailyBar[] = [
  { date: "2026-06-10", close: 500 },
  { date: "2026-06-17", close: 505 }
];

describe("resolveBenchmarkSeries — index-primary, ETF-fallback resolution", () => {
  it("prefers the primary series when it has >=2 usable bars, basis = the bare symbol", () => {
    const resolved = resolveBenchmarkSeries(
      { symbol: MARKET_BENCHMARK_PRIMARY, bars: GSPC_BARS },
      { symbol: MARKET_BENCHMARK_FALLBACK, bars: SPY_BARS }
    );
    expect(resolved).toEqual({ bars: GSPC_BARS, basis: "^GSPC" });
  });

  it("falls back to the ETF, honestly labeled '(fallback)', when the primary series is null", () => {
    const resolved = resolveBenchmarkSeries(
      { symbol: MARKET_BENCHMARK_PRIMARY, bars: null },
      { symbol: MARKET_BENCHMARK_FALLBACK, bars: SPY_BARS }
    );
    expect(resolved).toEqual({ bars: SPY_BARS, basis: "SPY(fallback)" });
  });

  it("falls back to the ETF when the primary series has fewer than 2 bars (Yahoo's live-quote-only response for some tickers)", () => {
    const resolved = resolveBenchmarkSeries(
      { symbol: "^SP500-45", bars: [{ date: "2026-06-17", close: 7072.64 }] },
      { symbol: "XLK", bars: SPY_BARS }
    );
    expect(resolved).toEqual({ bars: SPY_BARS, basis: "XLK(fallback)" });
  });

  it("returns undefined (never fabricates) when BOTH series are unusable", () => {
    expect(
      resolveBenchmarkSeries({ symbol: "^GSPC", bars: null }, { symbol: "SPY", bars: [] })
    ).toBeUndefined();
  });
});

describe("sectorBenchmarkEntry — GICS sector -> live-verified ticker lookup", () => {
  it("returns the ETF-only entry for a sector whose index isn't Yahoo-servable (Technology, live-verified 2026-08-13)", () => {
    const entry = sectorBenchmarkEntry("Technology");
    expect(entry).toEqual({ etfSymbol: "XLK" });
    expect(entry?.indexSymbol).toBeUndefined();
  });

  it("returns the index+ETF entry for Real Estate — the one sector index Yahoo actually serves history for", () => {
    const entry = sectorBenchmarkEntry("Real Estate");
    expect(entry).toEqual({ indexSymbol: "^SP500-60", etfSymbol: "XLRE" });
  });

  it("is case-insensitive", () => {
    expect(sectorBenchmarkEntry("technology")).toEqual({ etfSymbol: "XLK" });
    expect(sectorBenchmarkEntry("TECHNOLOGY")).toEqual({ etfSymbol: "XLK" });
  });

  it("resolves strict-GICS/alternate provider spellings to the same entry as the Yahoo taxonomy name", () => {
    expect(sectorBenchmarkEntry("Information Technology")).toEqual(sectorBenchmarkEntry("Technology"));
    expect(sectorBenchmarkEntry("Financials")).toEqual(sectorBenchmarkEntry("Financial Services"));
    expect(sectorBenchmarkEntry("Health Care")).toEqual(sectorBenchmarkEntry("Healthcare"));
    expect(sectorBenchmarkEntry("Consumer Discretionary")).toEqual(sectorBenchmarkEntry("Consumer Cyclical"));
    expect(sectorBenchmarkEntry("Consumer Staples")).toEqual(sectorBenchmarkEntry("Consumer Defensive"));
    expect(sectorBenchmarkEntry("Materials")).toEqual(sectorBenchmarkEntry("Basic Materials"));
  });

  it("returns undefined for an unmapped/unknown/missing sector (honest fallback to market, not a guess)", () => {
    expect(sectorBenchmarkEntry("ETF")).toBeUndefined();
    expect(sectorBenchmarkEntry("Some Made Up Sector")).toBeUndefined();
    expect(sectorBenchmarkEntry(undefined)).toBeUndefined();
    expect(sectorBenchmarkEntry(null)).toBeUndefined();
    expect(sectorBenchmarkEntry("")).toBeUndefined();
    expect(sectorBenchmarkEntry("   ")).toBeUndefined();
  });
});

describe("computeDailyHorizonRows — benchmarkBasis stamped alongside spyExcessPct", () => {
  const bars: NormalizedDailyBar[] = [
    { date: "2026-06-10", close: 100 },
    { date: "2026-06-11", close: 104 },
    { date: "2026-06-17", close: 115 }
  ];

  it("stamps benchmarkBasis on every row that carries spyExcessPct when a benchmark is provided", () => {
    const rows = computeDailyHorizonRows({
      basisPrice: 100,
      basisDate: "2026-06-10",
      bars,
      benchmark: { bars: GSPC_BARS, basis: "^GSPC" },
      nowDate: "2026-06-20",
      priceBasisPrefix: "fill",
      measuredAt: "2026-06-20T00:00:00.000Z"
    });
    const oneDay = rows.find((row) => row.horizon === "1d");
    const oneWeek = rows.find((row) => row.horizon === "1w");
    expect(oneDay?.spyExcessPct).toBeDefined();
    expect(oneDay?.benchmarkBasis).toBe("^GSPC");
    expect(oneWeek?.spyExcessPct).toBeDefined();
    expect(oneWeek?.benchmarkBasis).toBe("^GSPC");
  });

  it("carries the fallback label through to the row when the resolved benchmark used the fallback", () => {
    const rows = computeDailyHorizonRows({
      basisPrice: 100,
      basisDate: "2026-06-10",
      bars,
      benchmark: { bars: SPY_BARS, basis: "SPY(fallback)" },
      nowDate: "2026-06-20",
      priceBasisPrefix: "fill",
      measuredAt: "2026-06-20T00:00:00.000Z"
    });
    const oneWeek = rows.find((row) => row.horizon === "1w");
    expect(oneWeek?.benchmarkBasis).toBe("SPY(fallback)");
  });

  it("omits both spyExcessPct and benchmarkBasis when no benchmark is provided (never fabricated)", () => {
    const rows = computeDailyHorizonRows({
      basisPrice: 100,
      basisDate: "2026-06-10",
      bars,
      nowDate: "2026-06-20",
      priceBasisPrefix: "fill",
      measuredAt: "2026-06-20T00:00:00.000Z"
    });
    for (const row of rows) {
      expect(row.spyExcessPct).toBeUndefined();
      expect(row.benchmarkBasis).toBeUndefined();
    }
  });
});
