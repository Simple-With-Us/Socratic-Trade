import { describe, expect, it } from "vitest";
import { effectiveDailyOpeningNotionalCap, effectiveOpeningOrderNotionalCap, resolveDailyOpeningCap } from "../src/lib/policy-caps";

describe("daily opening cap resolution", () => {
  it("uses current NAV for percentage mode", () => {
    expect(resolveDailyOpeningCap({ maxDailyPctOfNav: 20 }, 100)).toEqual({
      mode: "pct_nav",
      configuredValue: 20,
      notional: 20,
      pctOfNav: 20
    });
  });

  it("clamps a legacy explicit dollar mode to NAV and reports its configured scale", () => {
    expect(resolveDailyOpeningCap({ maxDailyNotional: 1_000 }, 100)).toEqual({
      mode: "dollar",
      configuredValue: 1_000,
      notional: 100,
      pctOfNav: 1_000
    });
  });

  it("defensively prefers percent if a corrupt legacy shape carries both", () => {
    expect(effectiveDailyOpeningNotionalCap({ maxDailyNotional: 1_000, maxDailyPctOfNav: 20 }, 100)).toBe(20);
  });

  it("clamps an oversized dollar daily cap to current portfolio or buying power without changing the configured value", () => {
    expect(resolveDailyOpeningCap({ maxDailyNotional: 1_000 }, 100, 37)).toEqual({
      mode: "dollar",
      configuredValue: 1_000,
      notional: 100,
      pctOfNav: 1_000
    });
  });

  it("clamps percentage and dollar per-order caps to feasible account spend", () => {
    // Spend limit is Math.max(buyingPower, portfolioValue); order caps still bind under that.
    expect(effectiveOpeningOrderNotionalCap({ maxOrderNotional: 1_000 }, 100, 37)).toBe(100);
    expect(effectiveOpeningOrderNotionalCap({ maxOrderPctOfNav: 80 }, 100, 37)).toBe(80);
    expect(effectiveOpeningOrderNotionalCap({ maxOrderNotional: 1_000 }, 100, 0)).toBe(100);
  });

  it("resolves $0 daily notional for zero-balance / zero-buying-power accounts", () => {
    expect(resolveDailyOpeningCap({ maxDailyNotional: 1_000 }, 0, 0)).toEqual({
      mode: "dollar",
      configuredValue: 1_000,
      notional: 0
    });
  });
});
