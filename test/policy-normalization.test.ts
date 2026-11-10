import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { normalizeExclusivePolicyCaps } from "../src/lib/policy-normalization";

describe("normalizeExclusivePolicyCaps", () => {
  it("drops hidden absolute max-order caps when the visible percent mode is set", () => {
    const policy = normalizeExclusivePolicyCaps({
      ...DEFAULT_POLICY,
      maxOrderNotional: 100,
      maxOrderPctOfNav: 5
    });

    expect(policy.maxOrderNotional).toBeUndefined();
    expect(policy.maxOrderPctOfNav).toBe(5);
  });

  it("drops a hidden daily dollar cap when percent mode is visible", () => {
    const policy = normalizeExclusivePolicyCaps({
      ...DEFAULT_POLICY,
      maxDailyNotional: 1_000,
      maxDailyPctOfNav: 10
    });

    expect(policy.maxDailyNotional).toBeUndefined();
    expect(policy.maxDailyPctOfNav).toBe(10);
  });

  it("preserves an explicit dollar mode when a new percent default was only merged underneath it", () => {
    const policy = normalizeExclusivePolicyCaps(
      {
        ...DEFAULT_POLICY,
        maxDailyNotional: 1_000,
        maxDailyPctOfNav: 20
      },
      { maxDailyNotional: 1_000 }
    );

    expect(policy.maxDailyNotional).toBe(1_000);
    expect(policy.maxDailyPctOfNav).toBeUndefined();
  });

  it("normalizes stop/take controls to the percent mode used by the dashboard", () => {
    const policy = normalizeExclusivePolicyCaps({
      ...DEFAULT_POLICY,
      riskRules: {
        ...DEFAULT_POLICY.riskRules,
        stopLossNotional: 500,
        stopLossPct: 6,
        takeProfitNotional: 900,
        takeProfitPct: 18
      }
    });

    expect(policy.riskRules.stopLossNotional).toBeUndefined();
    expect(policy.riskRules.stopLossPct).toBe(6);
    expect(policy.riskRules.takeProfitNotional).toBeUndefined();
    expect(policy.riskRules.takeProfitPct).toBe(18);
  });
});
