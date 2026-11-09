import { describe, expect, it } from "vitest";
import { evaluatePriceSignal, type PriceSignalRef, type PriceSignalThresholds } from "../src/lib/streams/alpaca-price-events-stream";

const T: PriceSignalThresholds = {
  movePct: 3,
  volumeMult: 1.5,
  enableBreakout: true,
  enableMove: true,
  enableVolume: true
};

function ref(over: Partial<PriceSignalRef> = {}): PriceSignalRef {
  return { priorClose: 100, priorDayHigh: 105, avgDayVolume: 1_000_000, todayHigh: 0, todayVolume: 0, ...over };
}

describe("evaluatePriceSignal", () => {
  it("returns nothing in calm conditions", () => {
    expect(evaluatePriceSignal(101, ref({ todayHigh: 102, todayVolume: 500_000 }), T)).toEqual([]);
  });

  it("flags a prior-day-high break", () => {
    expect(evaluatePriceSignal(106, ref({ todayHigh: 106 }), T)).toContain("prior_day_high_break");
  });

  it("flags a large intraday move (up or down)", () => {
    expect(evaluatePriceSignal(104, ref(), T)).toContain("intraday_move"); // +4% vs priorClose 100
    expect(evaluatePriceSignal(96, ref(), T)).toContain("intraday_move");  // -4%
    expect(evaluatePriceSignal(102, ref(), T)).not.toContain("intraday_move"); // +2% < 3%
  });

  it("flags a volume spike", () => {
    expect(evaluatePriceSignal(101, ref({ todayVolume: 1_600_000 }), T)).toContain("volume_spike");
    expect(evaluatePriceSignal(101, ref({ todayVolume: 1_400_000 }), T)).not.toContain("volume_spike");
  });

  it("can flag multiple signals at once", () => {
    const hits = evaluatePriceSignal(106, ref({ todayHigh: 107, todayVolume: 2_000_000 }), T);
    expect(hits).toEqual(expect.arrayContaining(["prior_day_high_break", "intraday_move", "volume_spike"]));
  });

  it("respects disable flags", () => {
    const off: PriceSignalThresholds = { ...T, enableBreakout: false, enableMove: false, enableVolume: false };
    expect(evaluatePriceSignal(106, ref({ todayHigh: 999, todayVolume: 9_000_000 }), off)).toEqual([]);
  });

  it("never trips when reference gauges are missing/zero (no false positives on partial data)", () => {
    expect(evaluatePriceSignal(106, ref({ priorClose: 0, priorDayHigh: 0, avgDayVolume: 0, todayHigh: 999, todayVolume: 9e9 }), T)).toEqual([]);
  });

  it("ignores non-positive close", () => {
    expect(evaluatePriceSignal(0, ref({ todayHigh: 999 }), T)).toEqual([]);
  });
});
