import { describe, expect, it } from "vitest";
import { withMobileEquityCurveCompat } from "../src/lib/mobile-equity-curve-compat";
import type { EquityCurvePoint } from "../src/lib/types";

const point = (timestamp: string): EquityCurvePoint => ({
  timestamp,
  equity: 1000,
  source: "live",
  cash: 10
});

describe("withMobileEquityCurveCompat", () => {
  it("aliases every live and paper curve point with date = timestamp (shipped Swift builds require date)", () => {
    const compat = withMobileEquityCurveCompat({
      liveEquityCurve: [point("2026-08-27T12:00:00.000Z")],
      paperEquityCurve: [point("2026-08-26T12:00:00.000Z")]
    });
    expect(compat.liveEquityCurve?.[0]?.date).toBe("2026-08-27T12:00:00.000Z");
    expect(compat.paperEquityCurve?.[0]?.date).toBe("2026-08-26T12:00:00.000Z");
    expect(compat.liveEquityCurve?.[0]?.timestamp).toBe("2026-08-27T12:00:00.000Z");
    expect(compat.liveEquityCurve?.[0]?.equity).toBe(1000);
    expect(compat.liveEquityCurve?.[0]?.cash).toBe(10);
  });

  it("preserves an already-present date", () => {
    const withDate = { ...point("2026-08-27T12:00:00.000Z"), date: "2026-08-27" } as EquityCurvePoint & {
      date: string;
    };
    const compat = withMobileEquityCurveCompat({ liveEquityCurve: [withDate] });
    expect(compat.liveEquityCurve?.[0]?.date).toBe("2026-08-27");
  });

  it("passes through null/undefined performance and missing curves untouched", () => {
    expect(withMobileEquityCurveCompat(null)).toBeNull();
    expect(withMobileEquityCurveCompat(undefined)).toBeUndefined();
    const performance: { liveRealizedPnl: number; liveEquityCurve?: EquityCurvePoint[] } = { liveRealizedPnl: 5 };
    const compat = withMobileEquityCurveCompat(performance);
    expect(compat.liveEquityCurve).toBeUndefined();
    expect(compat.liveRealizedPnl).toBe(5);
  });
});
