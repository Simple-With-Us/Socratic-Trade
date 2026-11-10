import type { TradingPolicy } from "./types";

/**
 * The dashboard presents these risk controls as either/or knobs. Older stored
 * rows can still carry both values, which lets a hidden smaller value bind.
 * Normalize policy API writes so runtime behavior matches the visible control.
 */
type CapPreference = Partial<
  Pick<TradingPolicy, "maxOrderNotional" | "maxOrderPctOfNav" | "maxDailyNotional" | "maxDailyPctOfNav">
>;

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeExclusivePolicyCaps<T extends TradingPolicy>(policy: T, preference: CapPreference = policy): T {
  if (policy.maxOrderPctOfNav != null && policy.maxOrderNotional != null) {
    if (positive(preference.maxOrderNotional) && !positive(preference.maxOrderPctOfNav)) delete policy.maxOrderPctOfNav;
    else delete policy.maxOrderNotional;
  }
  if (policy.maxDailyNotional != null && policy.maxDailyPctOfNav != null) {
    if (positive(preference.maxDailyNotional) && !positive(preference.maxDailyPctOfNav)) delete policy.maxDailyPctOfNav;
    else delete policy.maxDailyNotional;
  }
  if (policy.riskRules.stopLossPct != null && policy.riskRules.stopLossNotional != null) {
    delete policy.riskRules.stopLossNotional;
  }
  if (policy.riskRules.takeProfitPct != null && policy.riskRules.takeProfitNotional != null) {
    delete policy.riskRules.takeProfitNotional;
  }
  return policy;
}
