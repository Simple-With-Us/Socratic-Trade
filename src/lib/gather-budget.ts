/**
 * Internal time budget for strategy gather (board 06df80cf leftover).
 *
 * The outer 8-minute `withDeadline` still aborts and last-good still exists
 * (#3013/#3018).  This plan trims the scan/enrichment walk so a live tape can
 * return BEFORE that wall instead of racing keyed/scarce waves until timeout.
 *
 * Leaf module: `market.ts` and `data-providers.ts` import this.  Do not import
 * `strategy-gather.ts` from here (that would cycle through market).
 */

export const STRATEGY_GATHER_DEADLINE_MS = 8 * 60_000;
export const STRATEGY_GATHER_TIMEOUT_MESSAGE = "strategy gather timeout";
/** Short quote refresh after a timed-out scan, using the last completed tape. */
export const STRATEGY_GATHER_QUOTE_FALLBACK_MS = 45_000;
/** Leave this much wall time after enrich so quote refresh can still run. */
export const STRATEGY_GATHER_RETURN_RESERVE_MS = STRATEGY_GATHER_QUOTE_FALLBACK_MS + 5_000;
/** Skip live provider.enrich entirely when usable remaining is below this. */
export const STRATEGY_GATHER_LIVE_ENRICH_MIN_MS = 20_000;
/** Skip keyed Wave B (Finnhub paced free-tier) below this usable remaining. */
export const STRATEGY_GATHER_KEYED_WAVE_MIN_MS = 90_000;
/** Skip scarce RapidAPI Wave C below this usable remaining. */
export const STRATEGY_GATHER_SCARCE_WAVE_MIN_MS = 20_000;
/** Shrink the enrichment pool to the final candidate cut below this usable remaining. */
export const STRATEGY_GATHER_FULL_POOL_MIN_MS = 3 * 60_000;

export type GatherEnrichmentPlan = {
  skipLiveEnrich: boolean;
  skipKeyedWave: boolean;
  skipScarceWave: boolean;
  shrinkPoolToCandidates: boolean;
};

const NO_TRIM: GatherEnrichmentPlan = {
  skipLiveEnrich: false,
  skipKeyedWave: false,
  skipScarceWave: false,
  shrinkPoolToCandidates: false
};

export function gatherRemainingMs(deadlineAt: number, now = Date.now()): number {
  return Math.max(0, deadlineAt - now);
}

/**
 * Map remaining wall-clock ms (until the outer gather deadline) onto which
 * enrichment waves are still worth starting.  `remainingMs` is the time left
 * on the 8-minute clock, not the usable enrich slice — this subtracts the
 * quote-refresh reserve.
 */
export function planGatherEnrichment(remainingMs: number): GatherEnrichmentPlan {
  const usable = Math.max(0, remainingMs - STRATEGY_GATHER_RETURN_RESERVE_MS);
  return {
    skipLiveEnrich: usable < STRATEGY_GATHER_LIVE_ENRICH_MIN_MS,
    skipKeyedWave: usable < STRATEGY_GATHER_KEYED_WAVE_MIN_MS,
    skipScarceWave: usable < STRATEGY_GATHER_SCARCE_WAVE_MIN_MS,
    shrinkPoolToCandidates: usable < STRATEGY_GATHER_FULL_POOL_MIN_MS
  };
}

/** Interactive / unbudgeted scans keep the full cascade. */
export function enrichmentPlanForDeadline(
  deadlineAt: number | undefined,
  now = Date.now()
): GatherEnrichmentPlan {
  if (deadlineAt == null || !Number.isFinite(deadlineAt)) return NO_TRIM;
  return planGatherEnrichment(gatherRemainingMs(deadlineAt, now));
}
