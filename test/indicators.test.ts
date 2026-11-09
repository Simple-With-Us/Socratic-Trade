import { describe, expect, it } from "vitest";
import { computeTechnicals, emaSeries, macdSeries, rocPct, rsiSeries, sma, type OHLCBar } from "../src/lib/indicators";

const bars = (closes: number[]): OHLCBar[] => closes.map((close, i) => ({ time: 1_700_000_000_000 + i * 86_400_000, close }));
const upTrend = (n: number): number[] => Array.from({ length: n }, (_, i) => 100 + i * 0.5);
const downTrend = (n: number): number[] => Array.from({ length: n }, (_, i) => 200 - i * 0.5);

describe("rocPct", () => {
  it("returns the percent change over period bars and stays undefined when the lookback is missing", () => {
    expect(rocPct([100, 110], 1)).toBeCloseTo(10);
    expect(rocPct([80, 84, 88, 92, 96, 100], 5)).toBeCloseTo(25);
    expect(rocPct([100], 1)).toBeUndefined();
    expect(rocPct([0, 10], 1)).toBeUndefined();
    expect(rocPct([100, 110], 0)).toBeUndefined();
  });
});

describe("sma", () => {
  it("averages the trailing window and returns undefined when too few bars", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2, 3, 4], 4)).toBe(2.5);
    expect(sma([1, 2], 5)).toBeUndefined();
  });
});

describe("emaSeries", () => {
  it("equals the constant for a flat series and is undefined before the seed index", () => {
    const ema = emaSeries([5, 5, 5, 5, 5], 3);
    expect(ema[0]).toBeUndefined();
    expect(ema[1]).toBeUndefined();
    expect(ema[2]).toBe(5);
    expect(ema[4]).toBe(5);
  });
});

describe("rsiSeries (Wilder)", () => {
  it("approaches 100 in a pure uptrend and 0 in a pure downtrend", () => {
    const up = rsiSeries(upTrend(40));
    const down = rsiSeries(downTrend(40));
    expect(up[up.length - 1]).toBeGreaterThan(95);
    expect(down[down.length - 1]).toBeLessThan(5);
  });

  it("reads neutral (50) for a flat series rather than the avgLoss==0 artifact", () => {
    const flat = rsiSeries(new Array(40).fill(100));
    expect(flat[flat.length - 1]).toBe(50);
  });
});

describe("macdSeries", () => {
  it("holds a positive MACD line in a sustained uptrend (line and signal converge)", () => {
    const { macd, signal } = macdSeries(upTrend(120));
    const m = macd[macd.length - 1];
    const s = signal[signal.length - 1];
    expect(typeof m).toBe("number");
    expect(typeof s).toBe("number");
    expect(m as number).toBeGreaterThan(0); // 12/26 EMA spread is positive while rising
    expect(Math.abs((m as number) - (s as number))).toBeLessThan(0.5); // converged on a linear ramp
  });
});

describe("computeTechnicals", () => {
  it("returns a bullish read with defined MAs for a long uptrend", () => {
    const read = computeTechnicals(bars(upTrend(220)));
    expect(read).toBeDefined();
    expect(read!.direction).toBe("bullish");
    expect(read!.score).toBeGreaterThanOrEqual(60);
    expect(typeof read!.sma50).toBe("number");
    expect(typeof read!.sma200).toBe("number");
    expect(read!.rsi14!).toBeGreaterThan(50);
    expect(read!.asOf).toBeTruthy();
  });

  it("returns a bearish read for a long downtrend", () => {
    const read = computeTechnicals(bars(downTrend(220)));
    expect(read).toBeDefined();
    expect(read!.direction).toBe("bearish");
    expect(read!.score).toBeLessThanOrEqual(40);
    expect(read!.rsi14!).toBeLessThan(50);
  });

  it("returns undefined when there are too few bars to say anything", () => {
    expect(computeTechnicals(bars(upTrend(20)))).toBeUndefined();
  });
});
