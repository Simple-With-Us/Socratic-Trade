import { listStrategyOverlays } from "./db-overlays";
import { selectActiveOverlays, type StrategyOverlay } from "./overlay-router";
import type { MarketRegime } from "./market-regime";
import type { TradingPolicy } from "./types";

export function loadActiveOverlays(input: {
  userId: string;
  policy: TradingPolicy;
  regime: MarketRegime | string;
}): StrategyOverlay[] {
  if (!input.policy.tuning?.strategyOverlaysEnabled) return [];
  try {
    return selectActiveOverlays({
      overlays: listStrategyOverlays(input.userId),
      regime: input.regime,
      maxCount: input.policy.tuning.maxActiveOverlays ?? 2
    });
  } catch {
    return [];
  }
}
