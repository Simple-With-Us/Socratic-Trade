import { describe, expect, it } from "vitest";
import { safeTopCandidates } from "../app/console/lib/evidence-rows";

describe("safeTopCandidates", () => {
  it("returns [] when scan is missing topCandidates (dashboard white-screen regression)", () => {
    // Mirrors the owner report: truthy latestScan without topCandidates → .slice threw.
    const partial = { source: "yahoo-finance", scannedSymbols: 10, returnedQuotes: 8 } as { topCandidates?: unknown };
    expect(safeTopCandidates(partial)).toEqual([]);
    expect(safeTopCandidates({})).toEqual([]);
    expect(safeTopCandidates(null)).toEqual([]);
    expect(safeTopCandidates(undefined)).toEqual([]);
    expect(safeTopCandidates({ topCandidates: undefined })).toEqual([]);
    expect(safeTopCandidates({ topCandidates: "not-an-array" })).toEqual([]);
  });

  it("keeps only candidates with a non-empty symbol string", () => {
    const result = safeTopCandidates({
      topCandidates: [
        { symbol: "AAPL", price: 100, volume: 1, intradayChangePct: 1, positionMarketValue: 0, score: 50 },
        { symbol: "  ", price: 1, volume: 1, intradayChangePct: 0, positionMarketValue: 0, score: 1 },
        { price: 1, volume: 1, intradayChangePct: 0, positionMarketValue: 0, score: 1 },
        null,
        { symbol: "MSFT", price: 200, volume: 2, intradayChangePct: -0.5, positionMarketValue: 0, score: 40 }
      ]
    });
    expect(result.map((c) => c.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("supports empty arrays (valid scan with no candidates)", () => {
    expect(safeTopCandidates({ topCandidates: [] })).toEqual([]);
  });
});
