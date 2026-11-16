import { describe, expect, it } from "vitest";
import { formatScanCandidateBreakdown, scanCandidateBreakdown } from "../app/console/lib/scan";

describe("scanCandidateBreakdown (item 26: '75/50 candidates' was a cap-violation illusion)", () => {
  it("decomposes the production case: 50 ranked + 14 held + 11 outliers = 75 total under a 50 cap", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 75, limit: 50, outlierCandidateCount: 11, heldCandidateCount: 14 });
    expect(b).toEqual({ ranked: 50, held: 14, outliers: 11, total: 75, limit: 50, hasHeldBreakdown: true });
    expect(formatScanCandidateBreakdown(b)).toBe("50 ranked + 14 held + 11 outliers");
  });

  it("omits zero-valued parts", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 30, limit: 30, outlierCandidateCount: 0, heldCandidateCount: 0 });
    expect(formatScanCandidateBreakdown(b)).toBe("30 ranked");
  });

  it("singularizes a lone outlier", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 32, limit: 30, outlierCandidateCount: 1, heldCandidateCount: 1 });
    expect(formatScanCandidateBreakdown(b)).toBe("30 ranked + 1 held + 1 outlier");
  });

  it("falls back to the coarser total/limit form for legacy scans without a held count — never guesses", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 75, limit: 50, outlierCandidateCount: 11, heldCandidateCount: undefined });
    expect(b.hasHeldBreakdown).toBe(false);
    expect(formatScanCandidateBreakdown(b)).toBe("75/50 candidates · 11 outliers");
  });

  it("legacy scan with no outliers either renders the plain total/limit form", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 30, limit: 30 });
    expect(formatScanCandidateBreakdown(b)).toBe("30/30 candidates");
  });

  it("never renders a negative ranked count on inconsistent inputs", () => {
    const b = scanCandidateBreakdown({ totalCandidates: 5, limit: 30, outlierCandidateCount: 4, heldCandidateCount: 4 });
    expect(b.ranked).toBe(0);
  });
});
