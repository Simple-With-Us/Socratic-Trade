import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  assessFinalSizeConsentDrift,
  captureProposalSizingSnapshot,
  proposalForFinalSizeRedReview,
  redTeamSizingFromSnapshot,
  stampRedTeamResult
} from "../src/lib/finalized-sizing-review";
import { applyRedTeamHalfSize } from "../src/lib/strategy-risk";
import type { TradeProposal } from "../src/lib/types";

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "EXE",
    side: "buy",
    type: "market",
    dollarAmount: 4,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Green thesis. Red Team review — stale legacy critique.",
    greenTeamRationale: "Green thesis.",
    tradeThesisTag: "Value-Quality",
    entryMarketRegime: "Neutral (Normal Volatility)",
    ...overrides
  };
}

describe("finalized broker-size Red review helpers", () => {
  it("requires fresh consent only for upward broker-estimate drift above one percent or one cent", () => {
    expect(assessFinalSizeConsentDrift(100, 101)).toMatchObject({ materialIncrease: false, tolerance: 1 });
    expect(assessFinalSizeConsentDrift(100, 101.01)).toMatchObject({ materialIncrease: true, tolerance: 1 });
    expect(assessFinalSizeConsentDrift(1, 1.01)).toMatchObject({ materialIncrease: false, tolerance: 0.01 });
    expect(assessFinalSizeConsentDrift(1, 1.02)).toMatchObject({ materialIncrease: true, tolerance: 0.01 });
    expect(assessFinalSizeConsentDrift(100, 90)).toMatchObject({ materialIncrease: false, increase: 0 });
  });

  it("computes the EXE-style account math centrally: $4 of $100 is 4%, with a $20 effective 20%-NAV daily cap", () => {
    const snapshot = captureProposalSizingSnapshot({
      proposal: proposal(),
      estimatedNotional: 4,
      policy: { ...DEFAULT_POLICY, maxDailyNotional: undefined, maxDailyPctOfNav: 20 },
      portfolioValue: 100,
      dailyNotionalUsed: 3
    });

    expect(snapshot).toEqual({
      portfolioValue: 100,
      estimatedNotional: 4,
      sizeBasis: "notional",
      dollarAmount: 4,
      estimatedPctOfNav: 4,
      dailyOpeningCap: {
        mode: "pct_nav",
        configuredValue: 20,
        effectiveNotional: 20,
        pctOfNav: 20
      },
      dailyNotionalUsed: 3,
      remainingDailyNotional: 17
    });
    expect(redTeamSizingFromSnapshot(snapshot)).toMatchObject({
      estimatedNotional: 4,
      portfolioValue: 100,
      estimatedPctOfNav: 4,
      remainingDailyNotional: 17
    });
  });

  it("reviews Green evidence without feeding the prior critic verdict/prose back as strategist evidence", () => {
    const input = proposal({
      redTeamVerdict: {
        verdict: "reject",
        rejected: true,
        available: true,
        reason: "Old objection",
        model: "old-model"
      },
      reviewedByModel: "old-model",
      finalSizeReview: {
        trigger: "broker_minimum_bump",
        fromNotional: 2,
        toNotional: 4,
        reviewedAt: "2026-07-13T00:00:00.000Z",
        ownerApprovalRequired: true
      }
    });

    const clean = proposalForFinalSizeRedReview(input);
    expect(clean.rationale).toBe("Green thesis.");
    expect(clean.redTeamVerdict).toBeUndefined();
    expect(clean.reviewedByModel).toBeUndefined();
    expect(clean.finalSizeReview).toBeUndefined();
  });

  it("records the exact quantity route instead of inventing a dollar-routed order", () => {
    const snapshot = captureProposalSizingSnapshot({
      proposal: proposal({ quantity: 2, dollarAmount: undefined, limitPrice: 87.77 }),
      estimatedNotional: 175.54,
      policy: { ...DEFAULT_POLICY, maxDailyNotional: 500, maxDailyPctOfNav: undefined },
      portfolioValue: 1_000,
      dailyNotionalUsed: 0
    });
    expect(snapshot).toMatchObject({ sizeBasis: "quantity", quantity: 2, estimatedNotional: 175.54 });
    expect(snapshot.dollarAmount).toBeUndefined();
  });

  it("stamps one structured final verdict and applies a single down-only half-size mutation", () => {
    const input = proposal({ dollarAmount: 20 });
    stampRedTeamResult(input, {
      verdict: "approve-at-half",
      rejected: false,
      available: true,
      reason: "Only half size is justified.",
      model: "gpt-5.6-terra"
    });
    expect(applyRedTeamHalfSize(input)).toEqual({ applied: true, note: "size halved: $20 → $10" });
    expect(input.dollarAmount).toBe(10);
    expect(input.redTeamVerdict).toMatchObject({
      verdict: "approve-at-half",
      trigger: "all_openings",
      model: "gpt-5.6-terra"
    });
  });
});
