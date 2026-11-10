import { describe, expect, it } from "vitest";
import {
  STRATEGY_GATHER_DEADLINE_MS,
  STRATEGY_GATHER_FULL_POOL_MIN_MS,
  STRATEGY_GATHER_KEYED_WAVE_MIN_MS,
  STRATEGY_GATHER_LIVE_ENRICH_MIN_MS,
  STRATEGY_GATHER_RETURN_RESERVE_MS,
  STRATEGY_GATHER_SCARCE_WAVE_MIN_MS,
  enrichmentPlanForDeadline,
  gatherRemainingMs,
  planGatherEnrichment
} from "../src/lib/gather-budget";

describe("planGatherEnrichment", () => {
  it("keeps the full cascade when the 8-minute clock just started", () => {
    const plan = planGatherEnrichment(STRATEGY_GATHER_DEADLINE_MS);
    expect(plan).toEqual({
      skipLiveEnrich: false,
      skipKeyedWave: false,
      skipScarceWave: false,
      shrinkPoolToCandidates: false
    });
  });

  it("shrinks the pool before skipping keyed Finnhub", () => {
    const remaining = STRATEGY_GATHER_RETURN_RESERVE_MS + STRATEGY_GATHER_FULL_POOL_MIN_MS - 1;
    const plan = planGatherEnrichment(remaining);
    expect(plan.shrinkPoolToCandidates).toBe(true);
    expect(plan.skipKeyedWave).toBe(false);
    expect(plan.skipLiveEnrich).toBe(false);
  });

  it("skips keyed Wave B when usable remaining is under 90s", () => {
    const remaining = STRATEGY_GATHER_RETURN_RESERVE_MS + STRATEGY_GATHER_KEYED_WAVE_MIN_MS - 1;
    const plan = planGatherEnrichment(remaining);
    expect(plan.skipKeyedWave).toBe(true);
    expect(plan.skipScarceWave).toBe(false);
    expect(plan.skipLiveEnrich).toBe(false);
  });

  it("skips scarce Wave C then live enrich as the wall closes", () => {
    expect(
      planGatherEnrichment(STRATEGY_GATHER_RETURN_RESERVE_MS + STRATEGY_GATHER_SCARCE_WAVE_MIN_MS - 1)
        .skipScarceWave
    ).toBe(true);
    expect(
      planGatherEnrichment(STRATEGY_GATHER_RETURN_RESERVE_MS + STRATEGY_GATHER_LIVE_ENRICH_MIN_MS - 1)
        .skipLiveEnrich
    ).toBe(true);
  });

  it("does not trim interactive scans with no deadline", () => {
    expect(enrichmentPlanForDeadline(undefined)).toEqual({
      skipLiveEnrich: false,
      skipKeyedWave: false,
      skipScarceWave: false,
      shrinkPoolToCandidates: false
    });
  });

  it("treats a past deadline as skip-everything", () => {
    expect(gatherRemainingMs(Date.now() - 1_000)).toBe(0);
    expect(enrichmentPlanForDeadline(Date.now() - 1_000).skipLiveEnrich).toBe(true);
    expect(enrichmentPlanForDeadline(Date.now() - 1_000).skipKeyedWave).toBe(true);
  });
});
