import { describe, it, expect } from "vitest";
import { deriveMetrics } from "../src/lib/derived-metrics";

describe("deriveMetrics", () => {
  it("computes PEG from P/E and EPS growth (growth is a fraction)", () => {
    // pe 20, epsGrowth 0.20 (20% YoY) -> 20 / 20 = 1.0
    expect(deriveMetrics({ price: 100, peRatio: 20, epsGrowth: 0.2 }).peg).toBe(1);
    // pe 30, epsGrowth 0.10 (10%) -> 30 / 10 = 3.0
    expect(deriveMetrics({ price: 100, peRatio: 30, epsGrowth: 0.1 }).peg).toBe(3);
  });

  it("omits PEG for unprofitable, no-growth, or sub-1% growth names", () => {
    expect("peg" in deriveMetrics({ price: 100, peRatio: -5, epsGrowth: 0.2 })).toBe(false);
    expect("peg" in deriveMetrics({ price: 100, peRatio: 20, epsGrowth: -0.1 })).toBe(false);
    expect("peg" in deriveMetrics({ price: 100, peRatio: 20, epsGrowth: 0.005 })).toBe(false); // 0.5% < 1% floor
    expect("peg" in deriveMetrics({ price: 100, peRatio: 20 })).toBe(false); // no growth field
  });

  it("computes earnings yield % and preserves a negative sign for losses", () => {
    expect(deriveMetrics({ price: 100, eps: 5 }).earnYld).toBe(5);
    expect(deriveMetrics({ price: 50, eps: -2 }).earnYld).toBe(-4);
    expect("earnYld" in deriveMetrics({ price: 0, eps: 5 })).toBe(false);
    expect("earnYld" in deriveMetrics({ price: 100 })).toBe(false);
  });

  it("computes ROE % from EPS, P/B and price (BVPS = price / P/B)", () => {
    // BVPS = 100 / 2 = 50; ROE = 5 / 50 = 10%
    expect(deriveMetrics({ price: 100, eps: 5, pbRatio: 2 }).roe).toBe(10);
    // negative earnings -> negative ROE
    expect(deriveMetrics({ price: 100, eps: -5, pbRatio: 2 }).roe).toBe(-10);
    expect("roe" in deriveMetrics({ price: 100, eps: 5, pbRatio: 0 })).toBe(false);
  });

  it("prefers the provider-reported returnOnEquity over the eps*pb approximation", () => {
    // approximation would say 10%; the real reported value (already a percent) wins
    expect(deriveMetrics({ price: 100, eps: 5, pbRatio: 2, returnOnEquity: 23.46 }).roe).toBe(23.5);
    // sign-preserving: a real negative ROE is shown, not the positive approximation
    expect(deriveMetrics({ price: 100, eps: 5, pbRatio: 2, returnOnEquity: -4.2 }).roe).toBe(-4.2);
    // absent real value -> approximation fallback unchanged
    expect(deriveMetrics({ price: 100, eps: 5, pbRatio: 2, returnOnEquity: undefined }).roe).toBe(10);
    // real value present but approximation inputs missing -> still emitted
    expect(deriveMetrics({ price: 100, returnOnEquity: 17.3 }).roe).toBe(17.3);
  });

  it("computes dividend payout ratio % (dividendYield is already a percent)", () => {
    // div 2% of price 100 = $2 DPS; payout = 2 / 4 = 50%
    expect(deriveMetrics({ price: 100, eps: 4, dividendYield: 2 }).payout).toBe(50);
    // unsustainable: $2 DPS on $1 EPS = 200%
    expect(deriveMetrics({ price: 100, eps: 1, dividendYield: 2 }).payout).toBe(200);
    expect("payout" in deriveMetrics({ price: 100, eps: -1, dividendYield: 2 })).toBe(false);
    expect("payout" in deriveMetrics({ price: 100, eps: 4, dividendYield: 0 })).toBe(false);
  });

  it("computes daily dollar volume in $millions", () => {
    expect(deriveMetrics({ price: 100, volume: 2_000_000 }).dollarVolM).toBe(200);
    expect("dollarVolM" in deriveMetrics({ price: 100, volume: 0 })).toBe(false);
    expect("dollarVolM" in deriveMetrics({ price: 100 })).toBe(false);
  });

  it("computes bid-ask spread in basis points", () => {
    // mid 100, spread 0.2 -> 20 bps
    expect(deriveMetrics({ price: 100, bid: 99.9, ask: 100.1 }).spreadBps).toBe(20);
    expect("spreadBps" in deriveMetrics({ price: 100, bid: 100.1, ask: 99.9 })).toBe(false); // crossed
    expect("spreadBps" in deriveMetrics({ price: 100, bid: 100 })).toBe(false); // one-sided
  });

  it("computes the Graham number and margin of safety for profitable names", () => {
    // BVPS = 100/2 = 50; Graham = sqrt(22.5 * 5 * 50) = sqrt(5625) = 75; margin = (75-100)/100 = -25%
    const m = deriveMetrics({ price: 100, eps: 5, pbRatio: 2 });
    expect(m.grahamNumber).toBe(75);
    expect(m.marginOfSafety).toBe(-25);
    // A name trading below book (BVPS = 50/1 = 50, Graham = sqrt(22.5*5*50) = 75) has a positive margin.
    expect(deriveMetrics({ price: 50, eps: 5, pbRatio: 1 }).marginOfSafety).toBe(50); // (75-50)/50
    expect("grahamNumber" in deriveMetrics({ price: 100, eps: -5, pbRatio: 2 })).toBe(false); // unprofitable
  });

  it("computes % from the 52-week high (negative below the high) and reward:risk to the band", () => {
    const m = deriveMetrics({ price: 90, fiftyTwoWeekHigh: 120, fiftyTwoWeekLow: 60 });
    expect(m.pctFromHigh).toBe(-25); // (90-120)/120
    expect(m.rr52w).toBe(1); // (120-90)/(90-60) = 30/30
    // At the high there is no upside room → rr52w omitted; % from high is 0.
    const atHigh = deriveMetrics({ price: 120, fiftyTwoWeekHigh: 120, fiftyTwoWeekLow: 60 });
    expect(atHigh.pctFromHigh).toBe(0);
    expect("rr52w" in atHigh).toBe(false);
  });

  it("returns an empty object when no inputs are usable", () => {
    expect(deriveMetrics({ price: 0 })).toEqual({});
  });

  it("handles a realistic full quote without throwing", () => {
    const m = deriveMetrics({
      price: 190,
      eps: 6.97,
      peRatio: 27.3,
      pbRatio: 45,
      dividendYield: 0.44,
      epsGrowth: 0.08,
      volume: 50_000_000,
      bid: 189.9,
      ask: 190.1
    });
    expect(m.peg).toBeCloseTo(27.3 / 8, 2);
    expect(m.earnYld).toBeCloseTo((6.97 / 190) * 100, 2);
    expect(m.roe).toBeCloseTo(((6.97 * 45) / 190) * 100, 1);
    expect(m.dollarVolM).toBe(9500);
    expect(m.spreadBps).toBeGreaterThan(0);
  });
});
