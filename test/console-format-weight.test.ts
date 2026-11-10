/**
 * Owner mobile punch list 2026-08-08:
 * - fmtPct must never render negative zero ("-0.0%" artifacts on short weights).
 * - Position Weight is the UNSIGNED share of gross exposure (|value| / Σ|values|);
 *   direction is carried by the SHORT tag, never by a signed weight.
 * - SENTENCE_GAP is the owner-wide two-space sentence separator (NBSP + space so
 *   HTML can't collapse it).
 */
import { describe, expect, it } from "vitest";

import { fmtPct, SENTENCE_GAP } from "../app/console/lib/format";
import { grossExposure, grossExposureWeightPct } from "../app/console/lib/derive";

describe("fmtPct — never renders negative zero", () => {
  it("normalizes exact -0 to 0", () => {
    expect(fmtPct(-0, 1)).toBe("0.0%");
    expect(fmtPct(-0)).toBe("0.00%");
  });

  it("normalizes tiny negatives that round to -0.0", () => {
    expect(fmtPct(-0.04, 1)).toBe("0.0%");
    expect(fmtPct(-0.004, 2)).toBe("0.00%");
  });

  it("keeps real negatives, positives, and the signed flag intact", () => {
    expect(fmtPct(-1.8, 1)).toBe("-1.8%");
    expect(fmtPct(-0.05, 1)).toBe("-0.1%");
    expect(fmtPct(2.5, 1)).toBe("2.5%");
    expect(fmtPct(2.5, 1, true)).toBe("+2.5%");
    expect(fmtPct(undefined)).toBe("—");
  });
});

describe("SENTENCE_GAP — owner two-space sentence separator", () => {
  it("is NBSP + space so HTML cannot collapse it to one space", () => {
    expect(SENTENCE_GAP).toBe("\u00A0 ");
    expect(SENTENCE_GAP).toHaveLength(2);
  });
});

describe("position weight — unsigned share of gross exposure", () => {
  const positions = [
    { marketValue: 8_000 }, // long
    { marketValue: -1_800 }, // short (PG-style)
    { marketValue: -0.4 } // dust short (T-style — used to render "-0.0%")
  ];

  it("gross exposure sums absolute market values", () => {
    expect(grossExposure(positions)).toBeCloseTo(9_800.4);
  });

  it("weights are unsigned for shorts and longs alike", () => {
    const gross = grossExposure(positions);
    const shortWeight = grossExposureWeightPct(-1_800, gross);
    expect(shortWeight).toBeGreaterThan(0);
    expect(shortWeight).toBeCloseTo((1_800 / 9_800.4) * 100);
    expect(grossExposureWeightPct(8_000, gross)).toBeCloseTo((8_000 / 9_800.4) * 100);
  });

  it("a dust short renders 0.0%, never -0.0%", () => {
    const gross = grossExposure(positions);
    const dust = grossExposureWeightPct(-0.4, gross);
    expect(dust).toBeGreaterThanOrEqual(0);
    expect(fmtPct(dust, 1)).toBe("0.0%");
  });

  it("returns undefined when the gross total or value can't answer", () => {
    expect(grossExposureWeightPct(100, 0)).toBeUndefined();
    expect(grossExposureWeightPct(Number.NaN, 1_000)).toBeUndefined();
    expect(grossExposureWeightPct(100, Number.NaN)).toBeUndefined();
  });

  it("ignores non-finite position values in the gross total", () => {
    expect(grossExposure([{ marketValue: Number.NaN }, { marketValue: 100 }])).toBe(100);
  });
});
