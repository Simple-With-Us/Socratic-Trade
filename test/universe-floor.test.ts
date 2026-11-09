import { describe, expect, it } from "vitest";
import { applyUniverseFloor, passesUniverseFloor, universeFloorActive } from "../src/lib/market";
import type { MarketQuote, UniverseFloor } from "../src/lib/types";

function quote(partial: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    companyName: partial.symbol,
    price: 100,
    volume: 1_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    provider: "test",
    ...partial
  } as MarketQuote;
}

const FLOOR: UniverseFloor = { minPrice: 5, minMarketCapUsd: 100_000_000, minDollarVolume: 1_000_000 };

describe("passesUniverseFloor", () => {
  it("passes everything when the floor is undefined or empty", () => {
    expect(passesUniverseFloor({ price: 0.01, volume: 1, marketCap: 1 }, undefined)).toBe(true);
    expect(passesUniverseFloor({ price: 0.01, volume: 1, marketCap: 1 }, {})).toBe(true);
  });

  it("excludes sub-minPrice names; passes at/above", () => {
    expect(passesUniverseFloor({ price: 4.99, volume: 5_000_000, marketCap: 5e9 }, FLOOR)).toBe(false);
    expect(passesUniverseFloor({ price: 5, volume: 5_000_000, marketCap: 5e9 }, FLOOR)).toBe(true);
  });

  it("excludes below market-cap floor ONLY when market cap is known", () => {
    expect(passesUniverseFloor({ price: 50, volume: 5_000_000, marketCap: 50_000_000 }, FLOOR)).toBe(false);
    // Unknown market cap must NOT exclude (missing data never excludes; price floor is the penny gate).
    expect(passesUniverseFloor({ price: 50, volume: 5_000_000, marketCap: undefined }, FLOOR)).toBe(true);
  });

  it("excludes illiquid names below the dollar-volume floor ONLY when volume is known", () => {
    // price 10 × volume 50_000 = $500k < $1M floor.
    expect(passesUniverseFloor({ price: 10, volume: 50_000, marketCap: 5e9 }, FLOOR)).toBe(false);
    // volume unknown (0) → not excluded by the liquidity floor.
    expect(passesUniverseFloor({ price: 10, volume: 0, marketCap: 5e9 }, FLOOR)).toBe(true);
  });

  it("respects a single-bound floor", () => {
    expect(passesUniverseFloor({ price: 3, volume: 9e9, marketCap: 9e12 }, { minPrice: 5 })).toBe(false);
    expect(passesUniverseFloor({ price: 9, volume: 9e9, marketCap: 9e12 }, { minPrice: 5 })).toBe(true);
  });
});

describe("universeFloorActive", () => {
  it("is false for undefined/empty/all-zero, true when any bound is > 0", () => {
    expect(universeFloorActive(undefined)).toBe(false);
    expect(universeFloorActive({})).toBe(false);
    expect(universeFloorActive({ minPrice: 0, minMarketCapUsd: 0, minDollarVolume: 0 })).toBe(false);
    expect(universeFloorActive({ minPrice: 5 })).toBe(true);
    expect(universeFloorActive({ minDollarVolume: 1 })).toBe(true);
  });
});

describe("applyUniverseFloor", () => {
  const quotes = [
    quote({ symbol: "AAPL", price: 200, volume: 50_000_000, marketCap: 3e12 }), // passes
    quote({ symbol: "PENNY", price: 0.5, volume: 50_000_000, marketCap: 5e6 }), // sub-floor
    quote({ symbol: "ILLIQ", price: 12, volume: 1_000, marketCap: 2e8 }) // sub dollar-volume ($12k)
  ];

  it("drops sub-floor names but keeps passing ones", () => {
    const kept = applyUniverseFloor(quotes, new Set(), FLOOR).map((q) => q.symbol);
    expect(kept).toEqual(["AAPL"]);
  });

  it("ALWAYS keeps exempt symbols (explicit list / held position) even if sub-floor", () => {
    const kept = applyUniverseFloor(quotes, new Set(["PENNY", "ILLIQ"]), FLOOR).map((q) => q.symbol);
    expect(kept).toEqual(["AAPL", "PENNY", "ILLIQ"]);
  });

  it("is a no-op when the floor is inactive", () => {
    expect(applyUniverseFloor(quotes, new Set(), undefined)).toHaveLength(3);
    expect(applyUniverseFloor(quotes, new Set(), {})).toHaveLength(3);
  });
});
