import { describe, expect, it } from "vitest";
import { dispersionPenalty, fractionalKellySuggestion, kellyFraction } from "../src/lib/kelly";

describe("kellyFraction", () => {
  it("hand-computed: p=0.6, b=2 -> f* = 0.6 - 0.4/2 = 0.4", () => {
    expect(kellyFraction(0.6, 2)).toBeCloseTo(0.4, 10);
  });

  it("hand-computed: p=0.5, b=1 -> f* = 0.5 - 0.5/1 = 0", () => {
    expect(kellyFraction(0.5, 1)).toBeCloseTo(0, 10);
  });

  it("negative edge clamps to 0 (never short-the-size)", () => {
    // p=0.3, b=1 -> f* = 0.3 - 0.7/1 = -0.4 -> clamped to 0
    expect(kellyFraction(0.3, 1)).toBe(0);
  });

  it("b <= 0 is undefined (no meaningful payoff ratio)", () => {
    expect(kellyFraction(0.6, 0)).toBeUndefined();
    expect(kellyFraction(0.6, -1)).toBeUndefined();
  });

  it("p outside (0,1) is undefined", () => {
    expect(kellyFraction(0, 2)).toBeUndefined();
    expect(kellyFraction(1, 2)).toBeUndefined();
    expect(kellyFraction(-0.1, 2)).toBeUndefined();
    expect(kellyFraction(1.1, 2)).toBeUndefined();
  });

  it("non-finite inputs are undefined", () => {
    expect(kellyFraction(NaN, 2)).toBeUndefined();
    expect(kellyFraction(0.6, NaN)).toBeUndefined();
    expect(kellyFraction(0.6, Infinity)).toBeUndefined();
  });
});

describe("dispersionPenalty", () => {
  it("no downside deviation (bucket has no losers) + POSITIVE edge -> full penalty (1), nothing to damp", () => {
    expect(dispersionPenalty(5, 0)).toBe(1);
  });

  it("non-positive edge is fully damped (0) even with no measured downside (precedence: edge<=0 wins)", () => {
    // avgReturnPct <= 0 takes precedence over the downsideDeviationPct<=0 short-circuit, so a net
    // loser never reads as full Kelly merely because the bucket recorded no losing lots.
    expect(dispersionPenalty(-5, 0)).toBe(0);
    expect(dispersionPenalty(0, 0)).toBe(0);
  });

  it("mean edge >= 2x sigma_down -> full Kelly (penalty 1)", () => {
    expect(dispersionPenalty(4, 2)).toBe(1); // ratio 2 -> clamp(2,0,2)/2 = 1
    expect(dispersionPenalty(10, 2)).toBe(1); // ratio 5 -> clamped to 2 -> /2 = 1
  });

  it("mean edge == sigma_down -> half penalty (0.5)", () => {
    expect(dispersionPenalty(2, 2)).toBeCloseTo(0.5, 10);
  });

  it("zero or negative mean edge -> zero penalty", () => {
    expect(dispersionPenalty(0, 2)).toBe(0);
    expect(dispersionPenalty(-3, 2)).toBe(0);
  });

  it("is monotonically non-decreasing in avgReturnPct for a fixed positive sigma_down", () => {
    const sigma = 3;
    const returns = [-5, -1, 0, 1, 2, 3, 5, 8, 20];
    let prev = -Infinity;
    for (const r of returns) {
      const penalty = dispersionPenalty(r, sigma);
      expect(penalty).toBeGreaterThanOrEqual(prev);
      prev = penalty;
    }
  });

  it("stays within [0, 1] across a range of inputs", () => {
    for (const avg of [-100, -10, -1, 0, 0.5, 1, 5, 10, 100]) {
      for (const sigma of [0, 0.5, 1, 5, 50]) {
        const p = dispersionPenalty(avg, sigma);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("fractionalKellySuggestion", () => {
  it("below minTrades -> insufficient, no suggestion computed", () => {
    const result = fractionalKellySuggestion(
      { winRate: 60, avgWinPct: 10, avgLossPct: 5, downsideDeviationPct: 3, avgReturnPct: 4, trades: 3 },
      { minTrades: 20 }
    );
    expect(result).toEqual({ insufficient: true, trades: 3, minTrades: 20 });
  });

  it("hand-computed: p=0.6 b=2, fraction 0.5, full penalty -> suggested 0.2", () => {
    // f* = 0.6 - 0.4/2 = 0.4; half-Kelly = 0.2; penalty=1 (avgReturn 8 >= 2*sigma_down 4)
    const result = fractionalKellySuggestion(
      { winRate: 60, avgWinPct: 20, avgLossPct: 10, downsideDeviationPct: 4, avgReturnPct: 8, trades: 25 },
      { fraction: 0.5, minTrades: 20 }
    );
    expect(result).toBeDefined();
    expect(result && "insufficient" in result).toBe(false);
    const s = result as { suggestedPctOfCeiling: number; f: number; b: number; p: number; penalty: number };
    expect(s.f).toBeCloseTo(0.4, 10);
    expect(s.b).toBeCloseTo(2, 10);
    expect(s.p).toBeCloseTo(0.6, 10);
    expect(s.penalty).toBe(1);
    expect(s.suggestedPctOfCeiling).toBeCloseTo(0.2, 10);
  });

  it("default fraction is 0.5 when opts.fraction is omitted", () => {
    const withDefault = fractionalKellySuggestion(
      { winRate: 60, avgWinPct: 20, avgLossPct: 10, downsideDeviationPct: 4, avgReturnPct: 8, trades: 25 },
      { minTrades: 20 }
    );
    const withExplicitHalf = fractionalKellySuggestion(
      { winRate: 60, avgWinPct: 20, avgLossPct: 10, downsideDeviationPct: 4, avgReturnPct: 8, trades: 25 },
      { fraction: 0.5, minTrades: 20 }
    );
    expect(withDefault).toEqual(withExplicitHalf);
  });

  it("negative edge -> f=0 -> suggested 0", () => {
    const result = fractionalKellySuggestion(
      { winRate: 30, avgWinPct: 5, avgLossPct: 10, downsideDeviationPct: 6, avgReturnPct: -2, trades: 30 },
      { minTrades: 20 }
    );
    expect(result).toBeDefined();
    const s = result as { suggestedPctOfCeiling: number; f: number };
    expect(s.f).toBe(0);
    expect(s.suggestedPctOfCeiling).toBe(0);
  });

  it("b undefined (no winners in bucket) -> undefined, never fabricated", () => {
    const result = fractionalKellySuggestion(
      { winRate: 0, avgWinPct: undefined, avgLossPct: 8, downsideDeviationPct: 5, avgReturnPct: -3, trades: 25 },
      { minTrades: 20 }
    );
    expect(result).toBeUndefined();
  });

  it("b undefined (no losers in bucket) -> undefined, never fabricated", () => {
    const result = fractionalKellySuggestion(
      { winRate: 100, avgWinPct: 12, avgLossPct: undefined, downsideDeviationPct: 0, avgReturnPct: 12, trades: 25 },
      { minTrades: 20 }
    );
    expect(result).toBeUndefined();
  });

  it("avgLossPct of 0 is treated as uncomputable (never divide by zero into an infinite b)", () => {
    const result = fractionalKellySuggestion(
      { winRate: 80, avgWinPct: 10, avgLossPct: 0, downsideDeviationPct: 0, avgReturnPct: 8, trades: 25 },
      { minTrades: 20 }
    );
    expect(result).toBeUndefined();
  });

  it("dispersion penalty damps the suggestion for a high-dispersion thesis", () => {
    // Same p/b as the full-penalty case above, but avgReturn is small relative to sigma_down.
    const result = fractionalKellySuggestion(
      { winRate: 60, avgWinPct: 20, avgLossPct: 10, downsideDeviationPct: 20, avgReturnPct: 1, trades: 25 },
      { fraction: 0.5, minTrades: 20 }
    );
    const s = result as { suggestedPctOfCeiling: number; penalty: number };
    expect(s.penalty).toBeCloseTo(0.025, 10); // ratio 1/20=0.05 -> /2 = 0.025
    expect(s.suggestedPctOfCeiling).toBeLessThan(0.01);
  });
});
