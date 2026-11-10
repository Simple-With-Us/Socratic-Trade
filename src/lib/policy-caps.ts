import type { TradingPolicy } from "./types";

export type DailyOpeningCapMode = "pct_nav" | "dollar";

export interface DailyOpeningCap {
  mode: DailyOpeningCapMode;
  configuredValue: number;
  notional: number;
  pctOfNav?: number;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Finite number including zero (zero-balance accounts must clamp, not treat as "unknown"). */
function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Largest opening spend the account can reasonably fund right now. */
export function accountOpeningSpendLimit(
  portfolioValue: number | undefined,
  buyingPower: number | undefined,
  side: "buy" | "short" = "buy"
): number {
  const bp = nonNegativeFinite(buyingPower) ? buyingPower : -1;
  const pv = nonNegativeFinite(portfolioValue) ? portfolioValue : -1;
  if (bp >= 0 || pv >= 0) return Math.max(bp, pv);
  return Infinity;
}

/** Resolve a per-order cap against the account's current feasible spend. */
export function effectiveOpeningOrderNotionalCap(
  policy: Pick<TradingPolicy, "maxOrderNotional" | "maxOrderPctOfNav" | "maxShortOrderNotional">,
  portfolioValue: number | undefined,
  buyingPower: number | undefined,
  side: "buy" | "short" = "buy"
): number {
  const configured = Math.min(
    positiveFinite(policy.maxOrderNotional) ? policy.maxOrderNotional : Infinity,
    side === "short" && positiveFinite(policy.maxShortOrderNotional) ? policy.maxShortOrderNotional : Infinity,
    positiveFinite(policy.maxOrderPctOfNav) && positiveFinite(portfolioValue)
      ? (policy.maxOrderPctOfNav / 100) * portfolioValue
      : Infinity
  );
  return Math.min(configured, accountOpeningSpendLimit(portfolioValue, buyingPower, side));
}

/**
 * Resolve the one visible daily opening cap into dollars. Percentage mode wins
 * defensively if a legacy policy somehow carries both fields; API writes and
 * policy merges normalize the stored shape to exactly one mode. The returned
 * notional is also capped at current feasible spend; configuredValue remains
 * the user's stored setting for transparent UI/audit display.
 */
export function resolveDailyOpeningCap(
  policy: Pick<TradingPolicy, "maxDailyNotional" | "maxDailyPctOfNav">,
  portfolioValue: number | undefined,
  availableSpend?: number
): DailyOpeningCap | undefined {
  let spendLimit: number | undefined;
  const bp = nonNegativeFinite(availableSpend) ? availableSpend : -1;
  const pv = nonNegativeFinite(portfolioValue) ? portfolioValue : -1;
  if (bp >= 0 || pv >= 0) spendLimit = Math.max(bp, pv);
  if (positiveFinite(policy.maxDailyPctOfNav)) {
    const nav = typeof portfolioValue === "number" && Number.isFinite(portfolioValue)
      ? Math.max(0, portfolioValue)
      : 0;
    const configuredNotional = (policy.maxDailyPctOfNav / 100) * nav;
    return {
      mode: "pct_nav",
      configuredValue: policy.maxDailyPctOfNav,
      notional: spendLimit === undefined ? configuredNotional : Math.min(configuredNotional, spendLimit),
      pctOfNav: policy.maxDailyPctOfNav
    };
  }

  if (positiveFinite(policy.maxDailyNotional)) {
    const pctOfNav = positiveFinite(portfolioValue)
      ? (policy.maxDailyNotional / portfolioValue) * 100
      : undefined;
    return {
      mode: "dollar",
      configuredValue: policy.maxDailyNotional,
      notional: spendLimit === undefined ? policy.maxDailyNotional : Math.min(policy.maxDailyNotional, spendLimit),
      ...(pctOfNav !== undefined ? { pctOfNav } : {})
    };
  }

  return undefined;
}

export function effectiveDailyOpeningNotionalCap(
  policy: Pick<TradingPolicy, "maxDailyNotional" | "maxDailyPctOfNav">,
  portfolioValue: number | undefined,
  availableSpend?: number
): number {
  return resolveDailyOpeningCap(policy, portfolioValue, availableSpend)?.notional ?? Infinity;
}
