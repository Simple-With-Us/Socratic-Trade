import { resolveDailyOpeningCap } from "./policy-caps";
import type { RedTeamDebateResult, RedTeamFinalizedSizing } from "./red-team";
import type { ProposalSizingSnapshot, TradeProposal, TradingPolicy } from "./types";

/** Owner consent to override a final-size Red hold is scoped to the broker estimate shown on the
 * pending card. Fixed-quantity market orders naturally move with the quote, so ignore sub-cent or
 * <=1% upward noise; larger increases need a fresh click. A lower fresh estimate is already within
 * the owner's approved risk envelope. */
export const FINAL_SIZE_CONSENT_UPWARD_DRIFT_PCT = 0.01;
export const FINAL_SIZE_CONSENT_MIN_ABSOLUTE_DRIFT = 0.01;

export function assessFinalSizeConsentDrift(
  consentedNotional: number,
  freshNotional: number
): { materialIncrease: boolean; increase: number; tolerance: number; increasePct?: number } {
  const baseline = Number.isFinite(consentedNotional) ? Math.max(0, consentedNotional) : 0;
  const fresh = Number.isFinite(freshNotional) ? Math.max(0, freshNotional) : 0;
  const increase = Math.max(0, fresh - baseline);
  const tolerance = Math.max(
    FINAL_SIZE_CONSENT_MIN_ABSOLUTE_DRIFT,
    baseline * FINAL_SIZE_CONSENT_UPWARD_DRIFT_PCT
  );
  return {
    materialIncrease: baseline <= 0 ? fresh > 0 : increase > tolerance + Number.EPSILON,
    increase,
    tolerance,
    ...(baseline > 0 ? { increasePct: (increase / baseline) * 100 } : {})
  };
}

/** Capture the exact order shape and broker-reviewed notional that Red/policy are evaluating. */
export function captureProposalSizingSnapshot(input: {
  proposal: TradeProposal;
  estimatedNotional: number;
  policy: TradingPolicy;
  portfolioValue: number;
  dailyNotionalUsed: number;
}): ProposalSizingSnapshot {
  const { proposal, policy } = input;
  const estimatedNotional = Number.isFinite(input.estimatedNotional) ? Math.max(0, input.estimatedNotional) : 0;
  const portfolioValue = Number.isFinite(input.portfolioValue) ? Math.max(0, input.portfolioValue) : 0;
  const dailyNotionalUsed = Number.isFinite(input.dailyNotionalUsed) ? Math.max(0, input.dailyNotionalUsed) : 0;
  const dailyCap = resolveDailyOpeningCap(policy, portfolioValue);
  const usesQuantity = typeof proposal.quantity === "number" && proposal.quantity > 0;
  return {
    portfolioValue,
    estimatedNotional,
    sizeBasis: usesQuantity ? "quantity" : "notional",
    ...(usesQuantity ? { quantity: proposal.quantity } : {}),
    ...(!usesQuantity && typeof proposal.dollarAmount === "number" && proposal.dollarAmount > 0
      ? { dollarAmount: proposal.dollarAmount }
      : {}),
    estimatedPctOfNav:
      portfolioValue > 0 ? Number(((estimatedNotional / portfolioValue) * 100).toFixed(4)) : undefined,
    dailyOpeningCap: dailyCap
      ? {
          mode: dailyCap.mode,
          configuredValue: dailyCap.configuredValue,
          effectiveNotional: Number(dailyCap.notional.toFixed(2)),
          pctOfNav: dailyCap.pctOfNav != null ? Number(dailyCap.pctOfNav.toFixed(2)) : undefined
        }
      : undefined,
    dailyNotionalUsed: Number(dailyNotionalUsed.toFixed(2)),
    remainingDailyNotional: dailyCap
      ? Number(Math.max(0, dailyCap.notional - dailyNotionalUsed).toFixed(2))
      : undefined
  };
}

export function redTeamSizingFromSnapshot(snapshot: ProposalSizingSnapshot): RedTeamFinalizedSizing {
  return {
    sizeBasis: snapshot.sizeBasis ?? "notional",
    estimatedNotional: snapshot.estimatedNotional,
    portfolioValue: snapshot.portfolioValue,
    estimatedPctOfNav: snapshot.estimatedPctOfNav,
    dailyOpeningCap: snapshot.dailyOpeningCap,
    dailyNotionalUsed: snapshot.dailyNotionalUsed,
    remainingDailyNotional: snapshot.remainingDailyNotional
  };
}

/** A final-size rerun must not feed the prior critic's prose/verdict back as if it were Green
 * evidence. The current deterministic sizing snapshot remains attached separately.
 * Also strips any prior `red_team_veto:` preVetoReasons so the fresh Red Team judge sees only
 * Green's adjusted size, not an overridden prior adversary's objection. */
export function proposalForFinalSizeRedReview(proposal: TradeProposal): TradeProposal {
  const cleanPreVetoReasons = proposal.preVetoReasons?.filter(
    (r) => !r.startsWith("red_team_veto:")
  );
  return {
    ...proposal,
    rationale: proposal.greenTeamRationale?.trim() || proposal.rationale,
    redTeamVerdict: undefined,
    reviewedByModel: undefined,
    finalSizeReview: undefined,
    ...(cleanPreVetoReasons !== undefined
      ? { preVetoReasons: cleanPreVetoReasons.length > 0 ? cleanPreVetoReasons : undefined }
      : {})
  };
}

export function stampRedTeamResult(proposal: TradeProposal, result: RedTeamDebateResult): void {
  proposal.redTeamVerdict = {
    ...(result.verdict ? { verdict: result.verdict } : {}),
    rejected: result.rejected,
    available: result.available,
    reason: result.reason,
    ...(result.model ? { model: result.model } : {}),
    trigger: "all_openings",
    ...(result.failureKind ? { failureKind: result.failureKind } : {})
  };
  proposal.reviewedByModel = result.model;
}
