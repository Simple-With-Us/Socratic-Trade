import { describe, expect, it } from "vitest";
import { drawdownSeries, maxDrawdownFraction } from "../app/console/lib/equity-drawdown";

/** W30 / OD-11: the equity chart's drawdown shading is built from this series —
 *  the math must be honest (window running peak, no fabricated baseline). */

describe("drawdownSeries (W30)", () => {
  it("tracks the running peak and reports the fraction below it", () => {
    const series = drawdownSeries([100, 110, 99, 121, 108.9]);
    expect(series.map((p) => p.peak)).toEqual([100, 110, 110, 121, 121]);
    expect(series[0].drawdown).toBe(0);
    expect(series[1].drawdown).toBe(0);
    expect(series[2].drawdown).toBeCloseTo((99 - 110) / 110);
    expect(series[3].drawdown).toBe(0);
    expect(series[4].drawdown).toBeCloseTo((108.9 - 121) / 121);
  });

  it("reports the deepest drawdown across the window", () => {
    const series = drawdownSeries([100, 90, 95, 80, 120]);
    expect(maxDrawdownFraction(series)).toBeCloseTo(-0.2);
  });

  it("returns null drawdowns for a window with no positive peak", () => {
    const series = drawdownSeries([0, 0, 0]);
    expect(series.every((p) => p.drawdown === null)).toBe(true);
    expect(maxDrawdownFraction(series)).toBeNull();
  });

  it("handles the empty window", () => {
    expect(drawdownSeries([])).toEqual([]);
    expect(maxDrawdownFraction([])).toBeNull();
  });
});