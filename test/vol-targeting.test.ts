import { describe, expect, it } from "vitest";
import {
  computePortfolioHeat,
  positionRiskUsd,
  realizedVolPct,
  volTargetScale
} from "../src/lib/vol-targeting";
import type { OHLCBar } from "../src/lib/indicators";

// Deterministic 21-close vector: alternating +2%/-1% daily returns (20 returns).
// mean = 0.005, stdev (population) = 0.015 → annualized = 0.015 * sqrt(252) * 100 ≈ 23.8118%.
const CLOSES = [
  100, 102, 100.98, 102.9996, 101.969604, 104.00899608, 102.9689061192, 105.028284241584,
  103.97800139916816, 106.05756142715153, 104.99698581288001, 107.09692552913762,
  106.02595627384625, 108.14647539932318, 107.06501064532995, 109.20631085823655,
  108.11424774965418, 110.27653270464727, 109.1737673776008, 111.35724272515282,
  110.24367029790129
];
const KNOWN_BARS: OHLCBar[] = CLOSES.map((close) => ({ close }));
const KNOWN_ANNUALIZED_VOL_PCT = 23.811761799581316;

describe("realizedVolPct", () => {
  it("matches a hand-computed known vector (21 closes, 20 returns, lookback 20)", () => {
    const vol = realizedVolPct(KNOWN_BARS, 20);
    expect(vol).toBeCloseTo(KNOWN_ANNUALIZED_VOL_PCT, 6);
  });

  it("returns undefined with fewer than lookbackDays+1 usable closes", () => {
    expect(realizedVolPct(KNOWN_BARS.slice(0, 10), 20)).toBeUndefined();
    expect(realizedVolPct([], 20)).toBeUndefined();
    expect(realizedVolPct([{ close: 100 }], 20)).toBeUndefined();
  });

  it("returns undefined for a bad lookback (non-integer or <= 0)", () => {
    expect(realizedVolPct(KNOWN_BARS, 0)).toBeUndefined();
    expect(realizedVolPct(KNOWN_BARS, 1.5)).toBeUndefined();
    expect(realizedVolPct(KNOWN_BARS, -5)).toBeUndefined();
  });

  it("is fine with close-only bars (no open/high/low needed)", () => {
    const closeOnly: OHLCBar[] = CLOSES.map((close) => ({ close }));
    expect(realizedVolPct(closeOnly, 20)).toBeCloseTo(KNOWN_ANNUALIZED_VOL_PCT, 6);
  });

  it("never fabricates on non-finite or non-positive close data", () => {
    const bad: OHLCBar[] = [...KNOWN_BARS.slice(0, 19), { close: 0 }, { close: 105 }];
    // A zero close is filtered out by the >0 guard, dropping below the lookback+1 usable-close floor.
    expect(realizedVolPct(bad, 20)).toBeUndefined();
    const nanBars: OHLCBar[] = [...KNOWN_BARS.slice(0, 20), { close: Number.NaN }];
    expect(realizedVolPct(nanBars, 20)).toBeUndefined();
  });

  it("uses only the trailing lookbackDays+1 closes when more history is supplied", () => {
    const padded: OHLCBar[] = [{ close: 50 }, { close: 50 }, { close: 50 }, ...KNOWN_BARS];
    expect(realizedVolPct(padded, 20)).toBeCloseTo(KNOWN_ANNUALIZED_VOL_PCT, 6);
  });
});

describe("volTargetScale", () => {
  it("scales down (tapers) when realized vol exceeds target", () => {
    // target/realized = 15/30 = 0.5
    expect(volTargetScale(30, 15)).toBeCloseTo(0.5, 6);
  });

  it("never sizes UP — clamps at 1 when realized vol is at or below target", () => {
    expect(volTargetScale(10, 20)).toBe(1);
    expect(volTargetScale(20, 20)).toBe(1);
  });

  it("clamps at the floor for extreme vol", () => {
    // target/realized = 15/300 = 0.05, below default floor 0.25
    expect(volTargetScale(300, 15)).toBeCloseTo(0.25, 6);
    // custom floor
    expect(volTargetScale(300, 15, 0.1)).toBeCloseTo(0.1, 6);
  });

  it("degrades to 1 (no taper) for invalid inputs rather than fabricating a scale", () => {
    expect(volTargetScale(0, 15)).toBe(1);
    expect(volTargetScale(-5, 15)).toBe(1);
    expect(volTargetScale(30, 0)).toBe(1);
    expect(volTargetScale(Number.NaN, 15)).toBe(1);
  });
});

describe("positionRiskUsd", () => {
  it("is |marketValue| * stopPct/100", () => {
    expect(positionRiskUsd(10_000, 5)).toBeCloseTo(500, 6);
    expect(positionRiskUsd(-10_000, 5)).toBeCloseTo(500, 6); // shorts: abs()
  });

  it("returns 0 for non-finite or non-positive stopPct", () => {
    expect(positionRiskUsd(10_000, 0)).toBe(0);
    expect(positionRiskUsd(10_000, -1)).toBe(0);
    expect(positionRiskUsd(Number.NaN, 5)).toBe(0);
  });
});

describe("computePortfolioHeat", () => {
  it("mixed stop-basis: sums risk only across positions with a resolvable stop", () => {
    const positions = [
      { symbol: "AAPL", marketValue: 10_000 }, // has per-symbol stop
      { symbol: "TSLA", marketValue: 20_000 }, // falls back to the flat stop
      { symbol: "GME", marketValue: 5_000 } // no per-symbol stop, no fallback below
    ];
    const stopPctBySymbol = { AAPL: 4 };
    const result = computePortfolioHeat(positions, stopPctBySymbol, 6, 100_000);

    // AAPL: 10000*0.04=400; TSLA: 20000*0.06=1200; GME excluded (falls back OK here since fallback=6 -> included)
    expect(result.totalRiskUsd).toBeCloseTo(400 + 1200 + 300, 6); // GME: 5000*0.06=300 via fallback
    expect(result.heatPct).toBeCloseTo(((400 + 1200 + 300) / 100_000) * 100, 6);
    expect(result.perPosition).toHaveLength(3);
    expect(result.perPosition.every((p) => p.estimated === false)).toBe(true);
  });

  it("honesty over completeness: positions with NO stop basis (no per-symbol, no fallback) are excluded and flagged", () => {
    const positions = [
      { symbol: "AAPL", marketValue: 10_000 },
      { symbol: "ZZZZ", marketValue: 5_000 } // no stop info anywhere
    ];
    const stopPctBySymbol = { AAPL: 4 };
    const result = computePortfolioHeat(positions, stopPctBySymbol, undefined, 100_000);

    expect(result.totalRiskUsd).toBeCloseTo(400, 6); // only AAPL counted
    const zzzz = result.perPosition.find((p) => p.symbol === "ZZZZ");
    expect(zzzz).toEqual({ symbol: "ZZZZ", riskUsd: 0, stopPctUsed: 0, estimated: true });
    const aapl = result.perPosition.find((p) => p.symbol === "AAPL");
    expect(aapl?.estimated).toBe(false);
    // heatPct is still computable even though one position lacks a basis — never fabricated,
    // it just reflects the risk that IS knowable.
    expect(result.heatPct).toBeCloseTo(0.4, 6);
  });

  it("never fabricates a number when NO position anywhere has a stop basis", () => {
    const positions = [
      { symbol: "A", marketValue: 1_000 },
      { symbol: "B", marketValue: 2_000 }
    ];
    const result = computePortfolioHeat(positions, {}, undefined, 100_000);
    expect(result.totalRiskUsd).toBe(0);
    expect(result.heatPct).toBe(0);
    expect(result.perPosition.every((p) => p.estimated === true)).toBe(true);
  });

  it("heatPct is undefined when equity is zero or negative (never a divide-by-zero fabrication)", () => {
    const positions = [{ symbol: "AAPL", marketValue: 10_000 }];
    const result = computePortfolioHeat(positions, { AAPL: 5 }, undefined, 0);
    expect(result.heatPct).toBeUndefined();
    expect(result.totalRiskUsd).toBeCloseTo(500, 6);

    const negEquity = computePortfolioHeat(positions, { AAPL: 5 }, undefined, -100);
    expect(negEquity.heatPct).toBeUndefined();
  });

  it("returns zero heat for an empty book", () => {
    const result = computePortfolioHeat([], {}, 5, 100_000);
    expect(result.totalRiskUsd).toBe(0);
    expect(result.heatPct).toBe(0);
    expect(result.perPosition).toHaveLength(0);
  });
});
