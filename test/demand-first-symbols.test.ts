import { describe, expect, it } from "vitest";
import { rankDemandFirstSymbols, rankHighInterestSymbols } from "../src/lib/rag/demand-first-symbols";

describe("demand-first symbol rank", () => {
  it("honors an explicit symbol list without inventing others", () => {
    expect(rankDemandFirstSymbols({ symbols: ["aapl", "AAPL", "msft"] })).toEqual(["AAPL", "MSFT"]);
  });

  it("high-interest is a prefix of the full demand-first rank", () => {
    const high = rankHighInterestSymbols();
    const all = rankDemandFirstSymbols();
    expect(all.slice(0, high.length)).toEqual(high);
    expect(all.length).toBeGreaterThanOrEqual(high.length);
  });
});
