import { describe, expect, it } from "vitest";
import { atr, atrStopPct, trueRange, type OHLCBar } from "../src/lib/indicators";

describe("trueRange", () => {
  it("is the max of (H−L), |H−prevClose|, |L−prevClose|", () => {
    expect(trueRange(110, 100, 105)).toBe(10); // H−L=10 dominates
    expect(trueRange(110, 100, 90)).toBe(20); // gap up: |110−90|=20
    expect(trueRange(110, 100, 130)).toBe(30); // gap down: |100−130|=30
  });
});

describe("atr", () => {
  const bar = (high: number, low: number, close: number): OHLCBar => ({ high, low, close });

  it("averages true range over the period (needs period+1 bars)", () => {
    const bars = [bar(100, 100, 100), bar(110, 100, 105), bar(108, 102, 104), bar(112, 104, 110)];
    // TR(i=1)=max(10,|110−100|,|100−100|)=10; TR(i=2)=max(6,3,3)=6; TR(i=3)=max(8,8,0)=8 → (10+6+8)/3=8
    expect(atr(bars, 3)).toBeCloseTo(8, 6);
  });

  it("returns undefined with too few bars or a bad period", () => {
    expect(atr([bar(1, 1, 1), bar(2, 1, 2)], 14)).toBeUndefined();
    expect(atr([], 14)).toBeUndefined();
    expect(atr([bar(1, 1, 1), bar(2, 1, 2)], 0)).toBeUndefined();
    expect(atr([bar(1, 1, 1), bar(2, 1, 2)], 1.5)).toBeUndefined();
  });

  it("falls back to close when high/low are missing (close-only bars)", () => {
    const bars: OHLCBar[] = [{ close: 100 }, { close: 110 }, { close: 105 }];
    // TR(i=1): H=L=110,prev=100 → max(0,10,10)=10; TR(i=2): H=L=105,prev=110 → max(0,5,5)=5 → 7.5
    expect(atr(bars, 2)).toBeCloseTo(7.5, 6);
  });
});

describe("atrStopPct", () => {
  it("converts ATR to a percent of entry: multiple × ATR ÷ entry × 100", () => {
    expect(atrStopPct(2, 100, 3)).toBeCloseTo(6, 6);
  });

  it("clamps to [floorPct, capPct]", () => {
    expect(atrStopPct(0.01, 100, 1)).toBe(1); // tiny ATR → 1% floor
    expect(atrStopPct(100, 100, 1)).toBe(50); // huge ATR → 50% cap
  });

  it("returns undefined for invalid inputs (so the caller keeps the fixed/beta stop)", () => {
    expect(atrStopPct(undefined, 100, 2)).toBeUndefined();
    expect(atrStopPct(2, 0, 2)).toBeUndefined();
    expect(atrStopPct(2, 100, 0)).toBeUndefined();
    expect(atrStopPct(-1, 100, 2)).toBeUndefined();
  });
});
