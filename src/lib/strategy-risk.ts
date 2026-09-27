import { avgReturnCorrelation, correlationProfile } from "./correlation";
import { audit } from "./db";
import { ExecutionAccount } from "./execution-mode";
import { deriveVenueContract } from "./venue-contract";
import { fractionalKellySuggestion } from "./kelly";
import { isRiskOffFilterRegime, regimeFromLabel } from "./market-regime";
import { normalizeSymbol } from "./money";
import { ThesisRegimeStat, ThesisStat, PrefetchedFills, getThesisScorecard, getThesisRegimeScorecard, ConfidenceCalibrationStat, getConfidenceCalibration, MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT, calibratedConviction } from "./performance";
import { estimateNotional, applyOpeningOrderHeadroom } from "./policy";
import { degradedCoreInputs } from "./proposal-phase-guard";
import { accountEquity } from "./risk-breaker";
import { signalHealthDriftActive } from "./signal-health";
import { bracketWholeShareMinimum, brokerLabel, brokerMinimumDollarNotional, estimateOpeningProposalNotional, formatWholeDollars, openingPolicyNotionalCap, openingRiskCapacity } from "./strategy";
import { StressPositionInput, stressScenario } from "./stress-scenario";
import { PolicyDecision, TradingPolicy, ApprovedEscalation, TradeProposal, EquityPosition, OrderSide, MarketQuote, MarketFactorBreakdown, FillSource, MarketScan, Portfolio, StopPlanStyle, STOP_PLAN_FALLBACK_STOP_PCT } from "./types";
import { PortfolioHeatResult, volTargetScale, positionRiskUsd } from "./vol-targeting";

export function shouldEscalateDecision(decision: PolicyDecision, policy: TradingPolicy): boolean {
  if (decision.approved || decision.reasons.length === 0) return false;
  const escalations = decision.escalations ?? [];
  if (escalations.length === 0) return false;
  return decision.reasons.every((reason) => {
    const entry = escalations.find((candidate) => candidate.reason === reason);
    if (!entry) return false;
    if (entry.kind === "wash_sale_ask") return true;
    return policy.strategyAuthority === "decide";
  });
}
export function approvedEscalationsFromDecision(decision: PolicyDecision | undefined): ApprovedEscalation[] {
  return (decision?.escalations ?? [])
    .filter((entry) => entry.kind === "wash_sale_ask" && typeof entry.token === "string" && entry.token.length > 0)
    .map((entry) => ({
      kind: entry.kind,
      symbol: entry.symbol,
      token: entry.token as string,
      // The cost PRICED ON THE CARD the user approved. The gate honors the token only while the
      // freshly recomputed cost stays within washSaleOverrideCostTolerance of this (stale-price
      // guard) — otherwise it re-escalates at the current price instead of executing.
      ...(entry.washSale?.estimatedTaxCostUsd != null ? { approvedCostUsd: entry.washSale.estimatedTaxCostUsd } : {})
    }));
}
export function isRiskAddingOpening(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "buy" && proposal.side !== "short") return false;
  const sym = normalizeSymbol(proposal.symbol);
  const netQty = positions
    .filter((p) => normalizeSymbol(p.symbol) === sym)
    .reduce((sum, p) => sum + p.quantity, 0);
  return proposal.side === "buy" ? netQty >= 0 : netQty <= 0;
}
export function applyRedTeamHalfSize(proposal: TradeProposal): { applied: boolean; note: string } {
  const quantityRouted =
    typeof proposal.quantity === "number" &&
    proposal.quantity > 0 &&
    (proposal.dollarAmount == null || proposal.dollarAmount <= 0);
  if (quantityRouted) {
    const halvedQty = Math.floor((proposal.quantity as number) / 2);
    if (halvedQty < 1) {
      return { applied: false, note: "half of this whole-share limit order is below one share" };
    }
    const fromQty = proposal.quantity;
    proposal.quantity = halvedQty;
    return { applied: true, note: `size halved: ${fromQty} → ${halvedQty} shares` };
  }
  if (typeof proposal.dollarAmount === "number" && proposal.dollarAmount > 0) {
    const halved = Math.floor(proposal.dollarAmount / 2);
    if (halved < 1) {
      return { applied: false, note: "half of this notional rounds to $0" };
    }
    const hasNativeBracket = proposal.bracketStopLoss != null || proposal.bracketTakeProfit != null;
    const entryPrice = proposal.referencePrice;
    if (hasNativeBracket && typeof entryPrice === "number" && entryPrice > 0 && halved < entryPrice) {
      return {
        applied: false,
        note: "half notional drops below one whole share at the reference price, which would invalidate the attached broker bracket"
      };
    }
    const fromNotional = proposal.dollarAmount;
    proposal.dollarAmount = halved;
    return { applied: true, note: `size halved: $${fromNotional} → $${halved}` };
  }
  return { applied: false, note: "order has neither a positive notional nor a positive quantity" };
}
export async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
export function allowedProposalSides(policy: TradingPolicy, account?: ExecutionAccount): OrderSide[] {
  return deriveVenueContract(policy, account).sides;
}
export function deterministicBearFilter(
  proposals: TradeProposal[],
  positions: EquityPosition[],
  topCandidates: MarketQuote[],
  regime: string,
  vetoThresholds?: { fcfYieldFloorPct?: number; debtToEquityCeiling?: number }
): { kept: TradeProposal[]; vetoed: Array<{ symbol: string; side: string; reason: string }> } {
  // All EquityPosition entries are long positions (the app is equity-only; short positions
  // are not represented in the live book yet). Cover proposals would require short positions,
  // which we can't verify here — skip Rule 1 for cover to avoid false positives.
  const heldLong = new Set(positions.map((p) => normalizeSymbol(p.symbol)));
  const quoteBySymbol = new Map(topCandidates.map((q) => [normalizeSymbol(q.symbol), q]));

  // Pre-compute median score for Rule 3 (only meaningful with ≥2 candidates)
  const sortedScores = topCandidates.map((q) => q.score).sort((a, b) => a - b);
  const medianScore = sortedScores.length > 1
    ? sortedScores[Math.floor(sortedScores.length / 2)]
    : -Infinity;
  // Typed-enum adoption (risk lane): classify the persisted regime label via the shared
  // ./market-regime source of truth instead of an ad-hoc startsWith, so a regime relabel can't
  // silently desync this risk-off veto from the crisis cap / escalation gates. Canonical-label
  // behavior is unchanged (pinned by test/market-regime.test.ts and test/deterministic-bear.test.ts)
  // and the veto reason below still quotes the original `regime` label. "Cautious (Inverted Curve)"
  // deliberately does NOT trip this risk-off veto (it trips only the crisis cap) — the exact
  // asymmetry the typed matrix documents. Imported from ./market-regime (not ./macro) so a
  // macro-module test mock can't intercept the classifier.
  const riskOffRegime = isRiskOffFilterRegime(regimeFromLabel(regime));

  const kept: TradeProposal[] = [];
  const vetoed: Array<{ symbol: string; side: string; reason: string }> = [];

  for (const p of proposals) {
    const sym = normalizeSymbol(p.symbol);
    const quote = quoteBySymbol.get(sym);

    // Rule 1: can't sell a long position that doesn't exist in the live book.
    // DELIBERATELY a hard `continue` DROP and NOT tagged as an overridable pre-veto: it is an
    // accounting impossibility (a phantom sell/cover), not a risk preference, and it fires only on
    // NON-opening sides which resolveSocraticOverride refuses anyway — so there is nothing to override.
    // Do not "fix" this into a preVetoReasons tag; that would surface a non-openable, non-overridable
    // reason on a card as if it could be overridden.
    if (p.side === "sell" && !heldLong.has(sym)) {
      vetoed.push({ symbol: sym, side: "sell", reason: "No existing long position to sell" });
      continue;
    }

    // Rule 2: momentum overextension flag on buys (non-blocking — prepends to rationale)
    if (p.side === "buy" && quote?.factorBreakdown) {
      const momentum = (quote.factorBreakdown as MarketFactorBreakdown).momentum ?? null;
      const value    = (quote.factorBreakdown as MarketFactorBreakdown).value    ?? null;
      if (momentum !== null && value !== null && momentum > 92 && value < 20) {
        p.rationale =
          `[Deterministic flag: momentum overextension (momentum=${Math.round(momentum)}, value=${Math.round(value)}). ` +
          `Verify this is a breakout, not a chase.]\n\n${p.rationale}`;
      }
    }

    // Rule 4: model-free fundamentals veto on buys (independent of the Bull/Bear LLMs, which
    // share one model and can rationalize a weak long). Catches cash-burning / over-levered names
    // regardless of what the LLMs agree on. Skipped when the threshold is unset OR the field is
    // unavailable, so a missing fundamental never false-vetoes a legitimate name.
    //
    // ⚠️ OWNER-RATIFICATION FLAG (2026-07-05): Rule 4 was DELIBERATELY model-INDEPENDENT — it exists
    // precisely because the Bull and Bear share one model and can jointly rationalize a weak long, so
    // it vetoed cash-burning / over-levered names no matter what the LLMs agreed on. This change makes
    // it OVERRIDABLE by an autonomyOverride thesis authored BY THAT SAME MODEL (per owner philosophy
    // "nothing is hard but the account boundary"). That re-couples the exact failure mode Rule 4 was
    // built to be independent of. It is now tag-not-drop (kept + preVetoReasons) rather than a hard
    // `continue`. TO REVERT to a non-overridable hard veto, change the two lines below back to
    // `vetoed.push({...}); continue;` (drop the preVetoReasons tag + kept.push). Flagged for explicit
    // owner ratification — see the rollout note.
    if (p.side === "buy" && quote) {
      const fcfFloor = vetoThresholds?.fcfYieldFloorPct;
      const deCeil = vetoThresholds?.debtToEquityCeiling;
      if (fcfFloor != null && typeof quote.fcfYield === "number" && Number.isFinite(quote.fcfYield) && quote.fcfYield < fcfFloor) {
        const reason = `Fundamentals veto: FCF yield ${quote.fcfYield.toFixed(2)}% below floor ${fcfFloor}% (cash-burning)`;
        vetoed.push({ symbol: sym, side: "buy", reason }); // telemetry parity — still recorded even when kept
        p.preVetoReasons = [...(p.preVetoReasons ?? []), `deterministic_bear_veto: ${reason}`];
        kept.push(p);
        continue;
      }
      if (deCeil != null && typeof quote.debtToEquity === "number" && Number.isFinite(quote.debtToEquity) && quote.debtToEquity > deCeil) {
        const reason = `Fundamentals veto: debt/equity ${quote.debtToEquity.toFixed(2)} exceeds ceiling ${deCeil} (over-levered)`;
        vetoed.push({ symbol: sym, side: "buy", reason }); // telemetry parity — still recorded even when kept
        p.preVetoReasons = [...(p.preVetoReasons ?? []), `deterministic_bear_veto: ${reason}`];
        kept.push(p);
        continue;
      }
    }

    // Rule 3: below-median buy in a risk-off/crisis regime → advisory pre-veto (tag-not-drop). Was a
    // hard `continue` drop; now tagged as an OVERRIDABLE `deterministic_bear_veto:` reason and KEPT, so
    // an autonomyOverride thesis can pass it on the opening at the single resolveSocraticOverride call.
    // With no thesis (or socraticOverrideMode "off") the tag keeps it blocked exactly as the old drop.
    if (p.side === "buy" && riskOffRegime && quote && quote.score < medianScore) {
      const reason = `${regime} regime with below-median scan score (${quote.score.toFixed(1)} < median ${medianScore.toFixed(1)}); risk-on entry too weak`;
      vetoed.push({ symbol: sym, side: "buy", reason }); // telemetry parity — still recorded even when kept
      p.preVetoReasons = [...(p.preVetoReasons ?? []), `deterministic_bear_veto: ${reason}`];
      kept.push(p);
      continue;
    }

    kept.push(p);
  }

  return { kept, vetoed };
}
export function selectThesisStat(
  regimeScorecard: ThesisRegimeStat[],
  thesisScorecard: ThesisStat[],
  proposal: TradeProposal
): ThesisStat | ThesisRegimeStat | undefined {
  // Exact-string join against `entryMarketRegime`, which is stamped from one of the
  // MARKET_REGIME_LABELS values (src/lib/macro.ts) at proposal-creation time. Both sides
  // are typed as plain `string` (older rows may carry a retired label), but the values in
  // practice are the persisted-contract labels — see that const's doc comment before
  // touching either side of this comparison.
  const comboStat = regimeScorecard.find((s) => s.thesisTag === proposal.tradeThesisTag && s.regime === proposal.entryMarketRegime);
  const thesisStat = thesisScorecard.find((s) => s.thesisTag === proposal.tradeThesisTag);
  return comboStat && comboStat.trades >= 5 ? comboStat : thesisStat;
}
export function shouldSkipNegativeExpectancy(
  proposal: TradeProposal,
  policy: TradingPolicy,
  source: FillSource,
  userId: string = "local",
  prefetched?: PrefetchedFills
): { skip: boolean; reason?: string } {
  if (!policy.tuning?.skipNegativeExpectancy) return { skip: false };
  if (proposal.side === "sell" || proposal.side === "cover") return { skip: false }; // exits unaffected
  const account = policy.accountNumber;
  if (!account) return { skip: false };

  const thesisScorecard = getThesisScorecard(account, source, {}, userId, prefetched);
  const parentStat = thesisScorecard.find((s) => s.thesisTag === proposal.tradeThesisTag);
  const parentTrades = parentStat?.trades ?? 0;
  const minLots = policy.tuning?.minClosedLotsForWeightShift ?? 20;
  if (parentTrades < minLots) return { skip: false }; // parent thesis is unproven

  const regimeScorecard = getThesisRegimeScorecard(account, source, {}, userId, prefetched);
  const stat = selectThesisStat(regimeScorecard, thesisScorecard, proposal);
  const sampleTrades = stat?.trades ?? 0;
  const avgReturn = stat?.shrunkAvgReturnPct ?? 0;
  const threshold = policy.tuning?.skipNegativeExpectancyEdgePct ?? 0;
  if (avgReturn <= threshold) {
    return {
      skip: true,
      reason: `Negative-expectancy skip: thesis "${proposal.tradeThesisTag ?? "—"}" has a proven negative post-cost edge (shrunk avg ${avgReturn}% over ${sampleTrades} closed lots ≤ ${threshold}%).`
    };
  }
  return { skip: false };
}
export async function applyCorrelationClusterGate(
  proposals: TradeProposal[],
  policy: TradingPolicy,
  positions: EquityPosition[],
  userId: string = "local",
  assertOwned?: () => void
): Promise<TradeProposal[]> {
  const cap = policy.maxAvgCorrelation;
  if (cap == null || !(cap > 0) || positions.length === 0) return proposals;
  const holdings = positions.map((p) => p.symbol);
  const kept: TradeProposal[] = [];
  for (const p of proposals) {
    assertOwned?.();
    const isOpening = p.side === "buy" || p.side === "short";
    if (!isOpening) {
      kept.push(p);
      continue;
    }
    const corr = await avgReturnCorrelation(p.symbol, holdings, userId);
    // The correlation fetch can outlive the caller's account lease. Prove ownership before an
    // audit, mutation, or advancing to another proposal; non-strategy callers omit the callback.
    assertOwned?.();
    if (corr != null && corr > cap) {
      console.log(`[Corr] Skipped ${p.symbol} ${p.side}: avg correlation ${corr.toFixed(2)} > cap ${cap}`);
      audit("proposal_skipped_correlation", { symbol: p.symbol, side: p.side, avgCorrelation: Number(corr.toFixed(4)), cap }, userId, policy.connectedAccountId);
      continue;
    }
    kept.push(p);
  }
  return kept;
}
export function applyEarningsBlackoutTag(
  proposals: TradeProposal[],
  policy: TradingPolicy,
  marketScan: MarketScan,
  userId: string = "local"
): TradeProposal[] {
  const earningsBlackoutOn = policy.tuning?.earningsBlackout === true;
  const earningsWindow = policy.tuning?.earningsBlackoutDays != null && policy.tuning.earningsBlackoutDays > 0
    ? policy.tuning.earningsBlackoutDays
    : 3;

  for (const proposal of proposals) {
    const isOpening = proposal.side === "buy" || proposal.side === "short";
    if (!isOpening) continue;
    if (proposal.rationale.includes("\n\n[Risk] Earnings in ")) continue; // already tagged this run (match the exact prefix this fn appends, not a bare substring that LLM rationale could contain)

    const quote = marketScan.quotesBySymbol[normalizeSymbol(proposal.symbol)] ?? marketScan.topCandidates.find((c) => normalizeSymbol(c.symbol) === normalizeSymbol(proposal.symbol));
    const daysToEarnings = quote?.daysToEarnings;
    if (typeof daysToEarnings === "number" && Number.isFinite(daysToEarnings) && daysToEarnings <= 7) {
      const insideWindow = earningsBlackoutOn && daysToEarnings <= earningsWindow;
      const windowSuffix = insideWindow ? " — inside advisory blackout window" : "";
      const earningsNote = `\n\n[Risk] Earnings in ${daysToEarnings} trading day(s)${windowSuffix}`;
      proposal.rationale += earningsNote;
      if (insideWindow) {
        proposal.preVetoReasons = [
          ...(proposal.preVetoReasons ?? []),
          `earnings_blackout: opening within ${daysToEarnings} day(s) of earnings (window ${earningsWindow})`
        ];
        audit(
          "proposal_tagged_earnings_blackout",
          { symbol: proposal.symbol, side: proposal.side, daysToEarnings, window: earningsWindow },
          userId,
          policy.connectedAccountId
        );
      }
    }
  }
  return proposals;
}
export async function applyRiskReceipts(
  proposals: TradeProposal[],
  policy: TradingPolicy,
  positions: EquityPosition[],
  portfolio: Portfolio,
  marketScan: MarketScan,
  userId: string = "local",
  assertOwned?: () => void
): Promise<TradeProposal[]> {
  const riskReceiptsOn = policy.tuning?.riskReceipts === true;

  const equity = accountEquity(portfolio);
  const holdingsForCorrelation = positions.map((p) => ({ symbol: p.symbol, marketValue: p.marketValue }));
  const stressPositions: StressPositionInput[] = positions.map((p) => ({
    symbol: p.symbol,
    marketValue: p.marketValue,
    beta: marketScan.quotesBySymbol[normalizeSymbol(p.symbol)]?.beta
  }));

  const out: TradeProposal[] = [];
  for (const p of proposals) {
    assertOwned?.();
    const isOpening = p.side === "buy" || p.side === "short";
    if (!isOpening) {
      out.push(p);
      continue;
    }

    // Mutate the SAME object reference throughout (never rebuild via spread): every other stage in
    // this pipeline (Bear-unavailable, rationale-collapse gate, FIX#3 pre-routing) adds this exact
    // object to `requiresHumanReview` (a Set<TradeProposal> keyed by reference), and the placement
    // loop's `requiresHumanReview.has(proposal)` check depends on that reference surviving unchanged
    // through this function. Rebuilding the object here would silently break Set membership for any
    // proposal that was routed to human review by an earlier gate and also picks up a risk-receipt
    // note — defeating the Fail-CLOSED safety net in "decide" (auto-execute) mode.
    const proposal = p;
    const quote = marketScan.quotesBySymbol[normalizeSymbol(p.symbol)] ?? marketScan.topCandidates.find((c) => normalizeSymbol(c.symbol) === normalizeSymbol(p.symbol));

    // Part 2 — correlation receipt (gated on riskReceipts; costs extra fetchDailyOHLC calls).
    if (riskReceiptsOn && equity > 0) {
      const profile = await correlationProfile(proposal.symbol, holdingsForCorrelation, equity, userId);
      assertOwned?.();
      if (profile) {
        const max = profile.maxPairwise;
        const maxIsDownsideDriven = profile.holdings.some(
          (h) => h.symbol === max.symbol && h.downside != null && h.pearson != null && h.downside > h.pearson
        );
        const downsideNote = maxIsDownsideDriven
          ? `; downside corr ${(profile.holdings.find((h) => h.symbol === max.symbol)!.downside! * 100).toFixed(0)}% — diversification weakens in drawdowns`
          : "";
        const avgEwmaText = profile.avgEwma != null ? `${(profile.avgEwma * 100).toFixed(0)}%` : "n/a";
        const correlationNote = `\n\n[Risk] Correlation: max ${(max.corr * 100).toFixed(0)}% w/ ${max.symbol} (${max.weightPct.toFixed(1)}% of book), avg EWMA ${avgEwmaText} across ${profile.holdings.length} holdings${downsideNote}`;
        proposal.rationale += correlationNote;
        audit(
          "correlation_receipt",
          { symbol: proposal.symbol, maxPairwise: max, avgEwma: profile.avgEwma, consideredCount: profile.consideredCount, truncated: profile.truncated },
          userId,
          policy.connectedAccountId
        );
      }
    }

    // Part 4 — pre-trade stress scenario receipt (gated on riskReceipts; free — betas come from the scan).
    if (riskReceiptsOn && equity > 0) {
      const candidateBeta = quote?.beta;
      // No run-level VIX is plumbed into MarketScan today (see macro.ts's separate MacroData for the
      // live VIX read) — omitting `vix` here falls back to stressScenario's own default (20, long-run
      // average), which is the documented, tested behavior when a live level isn't available.
      const stress = stressScenario({
        positions: stressPositions,
        candidate: { symbol: proposal.symbol, notional: estimateNotional(proposal), side: proposal.side, beta: candidateBeta },
        equity
      });
      if (stress) {
        const estimatedNote = stress.betasEstimated
          ? ` (betas estimated for ${stress.betaEstimatedCount} of ${stress.betaTotalCount} positions)`
          : "";
        const topText = stress.topContributors.map((c) => `${c.symbol} ${formatWholeDollars(c.impactUsd)}`).join(", ");
        // Omit the "; top: …" clause entirely for an empty/new book (no contributors) rather than
        // rendering a blank "top: " in the user-visible rationale.
        const topClause = topText ? `; top: ${topText}` : "";
        const stressNote = `\n\n[Risk] Stress ${stress.shockPct.toFixed(1)}% (mkt): book ${stress.bookImpactPctOfEquity.toFixed(1)}% of equity; with this order ${stress.withCandidateImpactPctOfEquity.toFixed(1)}%${topClause}${estimatedNote}`;
        proposal.rationale += stressNote;
        audit(
          "stress_receipt",
          {
            symbol: proposal.symbol,
            shockPct: stress.shockPct,
            bookImpactPctOfEquity: stress.bookImpactPctOfEquity,
            withCandidateImpactPctOfEquity: stress.withCandidateImpactPctOfEquity,
            candidateMarginalUsd: stress.candidateMarginalUsd
          },
          userId,
          policy.connectedAccountId
        );
      }
    }

    out.push(proposal);
  }

  // Part 3 — earnings-proximity advisory. Idempotent: a no-op for any proposal already tagged by an
  // earlier `applyEarningsBlackoutTag` call in this run (see that function's doc comment for why
  // `runStrategyOnce` calls it early, before this function runs).
  assertOwned?.();
  applyEarningsBlackoutTag(out, policy, marketScan, userId);

  return out;
}
/**
 * Stop distance as a PERCENT of entry, for the equal-risk cap. Prefers the stop the order will
 * actually carry, so the cap reflects real risk rather than a policy average:
 *
 *  1. `proposal.stopPrice` against `proposal.referencePrice` — the concrete order.
 *  2. `policy.riskRules.stopLossPct` — the configured distance the app places.
 *  3. `STOP_PLAN_FALLBACK_STOP_PCT` — the SAME shared fallback the rest of the codebase uses when an
 *     account runs with no configured stop (`synthetic-stops.ts`, `broker-protective-stops.ts`).
 *
 * Falls back rather than returning 0 because a 0 distance would make `budget ÷ fraction` infinite
 * and silently disable the cap, which is the exact failure a risk cap must not have. Returns 0 only
 * when a stop was configured at a non-positive distance, which the caller treats as "skip the cap".
 */
function resolveStopDistancePct(proposal: TradeProposal, policy: TradingPolicy): number {
  const ref = proposal.referencePrice;
  const stop = proposal.stopPrice;
  if (typeof ref === "number" && Number.isFinite(ref) && ref > 0 && typeof stop === "number" && Number.isFinite(stop) && stop > 0) {
    const distancePct = (Math.abs(ref - stop) / ref) * 100;
    if (distancePct > 0) return distancePct;
  }
  const configured = policy.riskRules?.stopLossPct;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return configured;
  return STOP_PLAN_FALLBACK_STOP_PCT;
}

export function applyDeterministicSizing(
  proposal: TradeProposal,
  policy: TradingPolicy,
  portfolio: Portfolio,
  source: FillSource,
  userId: string = "local",
  positions: EquityPosition[] = [],
  marketScan?: MarketScan,
  precomputedCalibration?: ConfidenceCalibrationStat[],
  // Precomputed annualized realized-vol (%) per OPENING candidate symbol — mirrors
  // precomputedCalibration's "compute once per run, pass in" pattern. Undefined/missing symbol →
  // the vol-target note/taper is simply skipped (never fabricated).
  realizedVolPctBySymbol?: Record<string, number>,
  // Precomputed CURRENT book heat (existing positions only, computed once per run) — undefined when
  // the heat budget isn't configured or volTargeting is off. This proposal's own incremental risk is
  // computed fresh below and added to bookHeat.totalRiskUsd for the remaining-budget taper.
  bookHeat?: PortfolioHeatResult,
  prefetched?: PrefetchedFills,
  // Per-position stop plans, keyed by symbol — needed so the bracket-whole-share-minimum bump below
  // knows a "trailing"/"none" plan will strip BOTH bracket legs at enrichOpeningProposal and never
  // needs a whole-share bump to support a bracket that won't be sent (Codex review, PR #1371).
  stopPlanBySymbol: Record<string, StopPlanStyle> = {}
): TradeProposal {
  if (proposal.side === "sell" || proposal.side === "cover") {
    // Exits skip opening-sizing, but a size-less exit (the LLM emitted neither quantity nor
    // dollarAmount) must be resolved to the FULL position. Otherwise it books a 0-quantity
    // phantom fill the dashboard reports as a successful close while the position stays open —
    // a silent no-op stop/take-profit in live mode. (policy.ts also hard-rejects size-less
    // exits as a backstop for any path that doesn't pass through here.)
    if (proposal.quantity == null && proposal.dollarAmount == null) {
      const pos = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
      const fullQty = pos ? Math.abs(pos.quantity) : 0;
      if (fullQty > 0) {
        return {
          ...proposal,
          quantity: fullQty,
          rationale: proposal.rationale + `\n\n[Sizing] Exit size resolved to the full ${normalizeSymbol(proposal.symbol)} position (${fullQty} sh) — the proposal carried no quantity.`
        };
      }
    }
    return proposal; // Preserve explicit exit sizes
  }
  const account = policy.accountNumber;
  if (!account) return proposal;

  const regimeScorecard = getThesisRegimeScorecard(account, source, {}, userId, prefetched);
  const thesisScorecard = getThesisScorecard(account, source, {}, userId, prefetched);
  
  // Prefer the thesis×regime bucket once it has enough samples; otherwise the thesis bucket.
  const stat = selectThesisStat(regimeScorecard, thesisScorecard, proposal);
  const sampleTrades = stat?.trades ?? 0;
  const winRate = stat?.shrunkWinRate ?? 50;
  const avgReturn = stat?.shrunkAvgReturnPct ?? 0; // shrunk realized edge (%)
  // Item 6 (opt-in, panel-hardened): remap confidenceScore through the account's realized confidence-
  // calibration curve BEFORE it becomes the conviction multiplier — a poorly-calibrated high-confidence
  // band is sized DOWN toward its (isotonic, shrunk) realized win rate, never inflated. Composes as a
  // reduction fed into the existing conviction-cap MIN below. Default OFF → raw confidenceScore/100 as
  // today. Only applies to BUYS (getConfidenceCalibration is long-only; shorts fall back to raw). The
  // per-band sample gate uses minClosedLotsForWeightShift. Calibration is computed once per run and passed
  // in (precomputedCalibration); falls back to an internal read when a direct caller doesn't supply it.
  const rawScore = proposal.confidenceScore ?? 50;
  let rawConviction = rawScore / 100;
  if (policy.tuning?.calibrationSizing && proposal.side === "buy") {
    const calibration = precomputedCalibration ?? getConfidenceCalibration(account, source, {}, userId, prefetched);
    const minLots = policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
    rawConviction = calibratedConviction(rawScore, calibration, minLots);
  }

  // Conviction-cap on PROVEN theses (panel finding): the LLM's confidenceScore is a direct linear
  // multiplier on size, and a learned "fact" can inflate it — so AI confidence alone could size up
  // a proven-but-mediocre thesis past the 20-lot evidence floor (which only protects UNPROVEN ones).
  // Mitigation: cap confidence's UPSIDE contribution UNLESS the thesis's own realized edge
  // independently corroborates high conviction. Low confidence still shrinks size fully (only the
  // upside above the cap is removed). This reads ONLY the realized scorecard stats already in scope
  // (winRate/avgReturn) + the proposal's own confidenceScore — it must NEVER read learned_context
  // (Phase-0 byte-identical invariant). Knobs are policy.tuning, conservative defaults ON by default.
  const convictionCap = policy.tuning?.convictionCapUncorroborated ?? 0.6;
  const corrobWinRate = policy.tuning?.corroborationWinRatePct ?? 58;
  const corrobEdge = policy.tuning?.corroborationEdgePct ?? 0;
  const corroborated = winRate >= corrobWinRate && avgReturn > corrobEdge;
  const uncorroboratedConviction = corroborated ? rawConviction : Math.min(rawConviction, convictionCap);
  const convictionCapBinds = !corroborated && rawConviction > convictionCap;

  // Degraded-data confidence cap (receipts ladder): when the proposal's CORE scan inputs were
  // observably degraded (degradedCoreInputs reads only the symbol's own quote off the marketScan
  // already in scope — an honest signal at this seam, never an invented proxy), cap confidence's
  // UPSIDE contribution exactly like the uncorroborated cap above and compose AFTER it. Same knob
  // semantics too (`?? default`; 1 never binds; explicit 0 removes the contribution). No marketScan
  // → no claim, no cap. When it BINDS, a kind-prefixed dataAdjustments receipt (below) names which
  // inputs were degraded — a visible haircut, never a silent one.
  const degradedCap = policy.tuning?.confidenceCapDataDegraded ?? 0.7;
  const degradedInputs = degradedCoreInputs(proposal.symbol, marketScan);
  const conviction = degradedInputs.length > 0 ? Math.min(uncorroboratedConviction, degradedCap) : uncorroboratedConviction;
  const degradedCapBinds = degradedInputs.length > 0 && uncorroboratedConviction > degradedCap;
  const degradedCapReceipt = degradedCapBinds
    ? `confidence_capped_degraded_data: AI conviction capped to ${degradedCap} for sizing (was ${uncorroboratedConviction.toFixed(2)}).  Degraded core inputs: ${degradedInputs.join("; ")}.`
    : null;
  if (degradedCapBinds) {
    audit(
      "sizing_degraded_data_cap_applied",
      { symbol: normalizeSymbol(proposal.symbol), side: proposal.side, cap: degradedCap, preCapConviction: Number(uncorroboratedConviction.toFixed(4)), degradedInputs },
      userId,
      policy.connectedAccountId
    );
  }

  // Signal-health auto-throttle (opt-in — policy.tuning.signalHealthAutoThrottle, default OFF):
  // while a CONFIRMED confidence-drift alarm is active (signal-health.ts: declining rolling rank
  // IC of confidenceScore vs matured outcomes), cap confidence's UPSIDE contribution at the SAME
  // convictionCapUncorroborated value even when the thesis is corroborated — a decaying confidence
  // signal shouldn't ride realized-edge corroboration past the cap. Composes AFTER the caps above;
  // off (default) the alarm only notifies/logs and sizing is byte-identical to today. The drift
  // read fails OPEN to inactive (settings-store failure must never shrink or abort sizing).
  const driftAlarm: ReturnType<typeof signalHealthDriftActive> =
    policy.tuning?.signalHealthAutoThrottle === true ? signalHealthDriftActive(userId) : { active: false, horizons: [] };
  const throttledConviction = driftAlarm.active ? Math.min(conviction, convictionCap) : conviction;
  const throttleBinds = driftAlarm.active && conviction > convictionCap;
  const throttleReceipt = throttleBinds
    ? `confidence_capped_signal_drift: AI conviction capped to ${convictionCap} for sizing (was ${conviction.toFixed(2)}).  Signal-health drift alarm active for ${driftAlarm.horizons.join("+")}${driftAlarm.detectedAt ? ` since ${driftAlarm.detectedAt.slice(0, 10)}` : ""} with the auto-throttle enabled.`
    : null;
  if (throttleBinds) {
    audit(
      "sizing_signal_health_throttle_applied",
      { symbol: normalizeSymbol(proposal.symbol), side: proposal.side, cap: convictionCap, preCapConviction: Number(conviction.toFixed(4)), horizons: driftAlarm.horizons },
      userId,
      policy.connectedAccountId
    );
  }

  // Edge-aware Kelly-lite: scale by win rate AND conviction AND the realized EDGE.
  // A thesis that wins often but with no/negative expectancy shouldn't get full size;
  // one with a proven positive edge earns more. This uses the learned shrunk avg return
  // so a handful of lucky trades can't inflate sizing.
  const edgeFactor = avgReturn > 1 ? 1 : avgReturn >= 0 ? 0.7 : avgReturn > -1 ? 0.5 : 0.3;
  const rawMultiplier = (winRate / 100) * throttledConviction * edgeFactor;

  // Operator per-thesis dial (policy.tuning.thesisSizeMultipliers), applied on top of the learned
  // edge factor rather than replacing it. The learned path above is DERIVED from realized stats and
  // already shrinks a weak thesis on its own; this exists for the case it cannot cover — parking a
  // thesis whose sample is too thin or too regime-specific for its edgeFactor to be trustworthy
  // (the 2026-09-25 performance review's "Value-Quality, 25 lots, -$79.18, the most consistent
  // negative thesis in the data" is the motivating case).
  //
  // Clamped to [0, 1] so a misconfigured value can only ever SHRINK a position. A knob that could
  // inflate sizing on a typo is not a knob anyone should leave in a policy file. Unset, a
  // non-finite, or out-of-range value is ignored and sizes exactly as before.
  const thesisKey = proposal.tradeThesisTag?.trim();
  const configuredThesisMultiplier = thesisKey ? policy.tuning?.thesisSizeMultipliers?.[thesisKey] : undefined;
  const thesisScale =
    typeof configuredThesisMultiplier === "number" && Number.isFinite(configuredThesisMultiplier)
      ? Math.min(1, Math.max(0, configuredThesisMultiplier))
      : 1;
  // An operator writing an explicit 0 for this thesis means "stop trading this". It is honoured as
  // written and is NOT raised to `sizingFloorPct` below: the floor exists to stop the sizer emitting
  // dust, but silently sizing a parked thesis at the floor would make the dial lie. The
  // `avgReturn < 0` branch already takes exactly this hard-zero path, so this is the same rule
  // reached by configuration instead of by learned stats.
  //
  // Safe in practice: a 0-notional order cannot reach a broker — the small-account/broker-minimum
  // guards reject it — so honouring the zero degrades to "proposal never places", which is the
  // intent, with no possibility of an accidental fill.
  const thesisParked = thesisScale === 0;
  if (thesisScale < 1) {
    audit(
      "sizing_thesis_multiplier_applied",
      {
        symbol: normalizeSymbol(proposal.symbol),
        thesisTag: thesisKey,
        configured: configuredThesisMultiplier,
        applied: thesisScale,
        rawMultiplier
      },
      userId,
      policy.connectedAccountId
    );
  }

  // Volatility-targeting sizing (opt-in, default off): taper the Kelly-lite multiplier by
  // targetVol/realizedVol (never up, floored at 0.25) BEFORE the floor/ceiling clamp below, so it
  // composes with (and stays bounded by) the existing sizingFloorPct/sizingCeilingPct clamps exactly
  // like every other input to `multiplier`. The realized-vol number itself is surfaced in the
  // rationale whenever cheaply available, independent of whether the taper is actually applied —
  // an honest receipt even when the feature is off or no target is configured.
  const realizedVol = realizedVolPctBySymbol?.[normalizeSymbol(proposal.symbol)];
  const targetVol = policy.tuning?.targetPortfolioVolPct;
  const volScaleApplies = policy.tuning?.volTargeting === true && typeof targetVol === "number" && targetVol > 0;
  const volScale =
    volScaleApplies && typeof realizedVol === "number"
      ? volTargetScale(realizedVol, targetVol as number)
      : 1;
  const multiplier = rawMultiplier * volScale * thesisScale;
  // Honest receipt, same convention as volTargetNote: say what was applied and why, not just that
  // a number came out smaller. Silent shrinkage is indistinguishable from a bug in the log.
  const thesisNote =
    thesisScale < 1
      ? `\n\n[Sizing] Thesis ${thesisKey} held to ${(thesisScale * 100).toFixed(0)}% size by policy.tuning.thesisSizeMultipliers (configured ${configuredThesisMultiplier}).` +
        (thesisParked ? " An explicit 0 parks this thesis: the sizing floor does not override it." : "")
      : "";
  const volTargetNote =
    typeof realizedVol === "number"
      ? `\n\n[Sizing] Realized vol ${realizedVol.toFixed(1)}%${typeof targetVol === "number" && targetVol > 0
          ? ` vs target ${targetVol}% → vol-target scale ${volScale.toFixed(2)}x (${volScaleApplies ? "applied" : "advisory-only"})`
          : " (no vol target configured — advisory-only)"}.`
      : "";
  if (volScaleApplies && volScale < 1) {
    audit(
      "sizing_vol_target_applied",
      { symbol: normalizeSymbol(proposal.symbol), side: proposal.side, realizedVolPct: realizedVol, targetPortfolioVolPct: targetVol, volScale },
      userId,
      policy.connectedAccountId
    );
  }

  // Bounds are configurable (policy.tuning.sizingFloorPct / sizingCeilingPct); default 10–100%.
  const floor = (policy.tuning?.sizingFloorPct ?? 10) / 100;
  const ceiling = (policy.tuning?.sizingCeilingPct ?? 100) / 100;

  const minLotsForSizing = policy.tuning?.minClosedLotsForWeightShift ?? 20;
  const unproven = sampleTrades < minLotsForSizing;
  // `thesisParked` is declared alongside `thesisScale` above; see its comment for why an explicit 0
  // bypasses the floor.
  const boundedMultiplier = thesisParked
    ? 0
    : unproven
      ? floor
      : avgReturn < 0
        ? 0
        : Math.max(floor, Math.min(ceiling, multiplier));

  // Fractional-Kelly sizing on realized payoff (downside-dispersion-aware, advisory). Runs BESIDE
  // the Kelly-lite heuristic above (never replaces it): computes a suggested multiplier from the
  // bucket's realized win/loss payoff split (avgWinPct/avgLossPct) and downside-dispersion
  // penalty (downsideDeviationPct), added to performance.ts's aggregateClosedLots alongside this
  // feature. A receipt is appended whenever the bucket clears the sample gate AND the payoff ratio
  // is computable (informational only) — the size itself only changes when
  // policy.tuning.fractionalKellySizing is explicitly on, and even then Kelly may only REDUCE size
  // vs today (min of the existing multiplier and the Kelly suggestion), never increase it.
  // Validate/clamp to a finite [0,1] fraction: a non-finite or out-of-range policy value must not
  // leak into the sizing math or print a misleading "NaN-Kelly" receipt. Falls back to 0.5 when unset
  // or non-finite; clamps stray >1 / <0 values into range.
  const kellyFractionRaw = policy.tuning?.kellyFraction ?? 0.5;
  const kellyFractionSetting = Number.isFinite(kellyFractionRaw) ? Math.max(0, Math.min(1, kellyFractionRaw)) : 0.5;
  const kellySuggestion = fractionalKellySuggestion(
    {
      winRate,
      avgWinPct: stat?.avgWinPct,
      avgLossPct: stat?.avgLossPct,
      downsideDeviationPct: stat?.downsideDeviationPct,
      avgReturnPct: avgReturn,
      trades: sampleTrades
    },
    { fraction: kellyFractionSetting, minTrades: minLotsForSizing }
  );
  // Calibration (and by extension this Kelly payoff split) is long-only — getConfidenceCalibration
  // filters side==='long'. Shorts have no calibration curve to lean on, so the receipt says so
  // rather than silently presenting the raw split as if it were calibrated the same way.
  const kellyUncalibratedShort = proposal.side === "short";
  let kellyNote = "";
  let kellyApplied = false;
  let finalMultiplier = boundedMultiplier;
  if (kellySuggestion && !("insufficient" in kellySuggestion)) {
    const { suggestedPctOfCeiling, p, b, penalty } = kellySuggestion;
    const applyKelly = policy.tuning?.fractionalKellySizing === true && suggestedPctOfCeiling < boundedMultiplier;
    if (applyKelly) {
      // Kelly is allowed to cut BELOW the normal sizingFloorPct — that is the entire point of the
      // "reduce, never increase" guardrail (a poor risk-adjusted edge should be able to shrink size
      // past the ordinary exploratory floor). Only clamp to sane absolute bounds: never negative,
      // never above the ceiling, and never above the multiplier Kelly is replacing.
      finalMultiplier = Math.max(0, Math.min(ceiling, Math.min(boundedMultiplier, suggestedPctOfCeiling)));
      kellyApplied = true;
    }
    kellyNote = `\n\n[Sizing] Fractional-Kelly (p=${p.toFixed(2)}, b=${b.toFixed(2)}, σ_down=${(stat?.downsideDeviationPct ?? 0).toFixed(2)}%, penalty=${penalty.toFixed(2)}): suggests ${Math.round(suggestedPctOfCeiling * 100)}% of max (${kellyFractionSetting}-Kelly)${kellyApplied ? " — applied" : " — informational only, not applied"}${kellyUncalibratedShort ? " (short: uncalibrated)" : ""}`;
    if (kellyApplied) {
      audit("sizing_fractional_kelly_applied", {
        symbol: proposal.symbol,
        thesisTag: proposal.tradeThesisTag,
        p: Number(p.toFixed(4)),
        b: Number(b.toFixed(4)),
        penalty: Number(penalty.toFixed(4)),
        suggested: Number(suggestedPctOfCeiling.toFixed(4)),
        previousMultiplier: Number(boundedMultiplier.toFixed(4)),
        applied: Number(finalMultiplier.toFixed(4))
      }, userId, policy.connectedAccountId);
    }
  }

  const openingCapacity = openingRiskCapacity(proposal, policy, portfolio, positions, marketScan);
  const policyHeadroomCap = applyOpeningOrderHeadroom(openingPolicyNotionalCap(proposal, policy, portfolio));
  const rawOpeningCap = Math.min(openingCapacity.cap, policyHeadroomCap);
  // When marketable-limit entries are enabled, this deterministic dollar market order is later
  // converted to a whole-share LIMIT priced through the quote (ask×(1+bufferBps)); that conversion can
  // push the realized notional slightly above a dollar-routed size. Reserve that buffer in the cap now
  // so deterministic sizing never produces an order the later policy review rejects for exceeding the
  // per-order headroom. Only shrinks the cap when the flag is on, so dollar-routed sizing is
  // unchanged otherwise. (Review: PR #278.)
  const marketableLimitBufferFactor =
    policy.marketableLimitEntries === true && (policy.permittedOrderTypes?.includes("limit") ?? true)
      ? 1 + (policy.tuning?.marketableLimitBufferBps ?? 15) / 10_000
      : 1;
  const openingSizingCap = marketableLimitBufferFactor > 1 ? Math.floor(rawOpeningCap / marketableLimitBufferFactor) : rawOpeningCap;
  const openingSizingReason = Number.isFinite(policyHeadroomCap) && policyHeadroomCap < openingCapacity.cap
    ? `${proposal.side === "short" && policy.maxShortOrderNotional != null && policy.maxShortOrderNotional > 0 ? "max short order limit" : "per-order cap"}, with 5% execution buffer`
    : openingCapacity.reason;
  // The bracket-minimum raise below must respect the SAME buffered/per-order cap, not the raw risk
  // capacity — otherwise a one-share bracket raise can lift the order above the headroom cap and the
  // later policy review rejects it instead of skipping the broker bracket. (Review: PR #278.)
  let effectiveOpeningCap = openingSizingCap;
  const fallbackBase = Number.isFinite(openingCapacity.cap) ? openingCapacity.cap : (policy.maxOrderNotional ?? 0);
  const fallbackNotional = Math.floor(Math.max(0, fallbackBase) * finalMultiplier);
  const advisedNotional = estimateOpeningProposalNotional(proposal, marketScan);
  let targetNotional = advisedNotional && advisedNotional > 0
    ? Math.min(Math.floor(advisedNotional), openingSizingCap)
    : Math.min(fallbackNotional, openingSizingCap);

  // Equal-risk sizing (opt-in, default off): cap the DOLLAR risk one position may carry, as a % of
  // account equity, so size = risk budget ÷ stop distance. Everything upstream sizes to a NOTIONAL,
  // which means a name whose stop sits further from entry silently risks proportionally more — and
  // the 2026-09-25 performance review found exactly that shape: 4 lots accounted for 70% of the
  // account's total loss, and Insider-Accumulation was positive in PERCENT while negative in DOLLARS
  // purely because its losing positions were the bigger ones. A notional cap cannot see that; a
  // dollar-risk cap can.
  //
  // Applied BEFORE the ADV cap and the minimum raises below, and re-asserted after the bracket-minimum
  // raise (a preference-based raise that must not silently undo a risk cap). The broker-dollar
  // minimum is a HARD constraint and is left to win, with an audit if it breaches the cap — refusing
  // to trade is the owner's call, not this function's.
  const stopDistancePct = resolveStopDistancePct(proposal, policy);
  const maxRiskPct = policy.tuning?.maxPositionRiskPctOfEquity;
  const equityForRisk = accountEquity(portfolio);
  const riskBudgetUsd =
    typeof maxRiskPct === "number" && Number.isFinite(maxRiskPct) && maxRiskPct > 0 && equityForRisk > 0
      ? (equityForRisk * maxRiskPct) / 100
      : 0;
  // risk = notional × stopFraction, so the notional that exactly spends the budget is budget ÷ fraction.
  // Guard the division: a zero/unknown stop distance must skip the cap entirely rather than collapse
  // every order to zero (the same reason `positionRiskUsd` returns 0 for a non-positive stop).
  const equalRiskCap = riskBudgetUsd > 0 && stopDistancePct > 0 ? riskBudgetUsd / (stopDistancePct / 100) : 0;
  let equalRiskNote = "";
  const applyEqualRiskCap = () => {
    if (equalRiskCap > 0 && targetNotional > 0 && targetNotional > equalRiskCap) {
      equalRiskNote =
        (equalRiskNote ? equalRiskNote : "") +
        `\n\n[Sizing] Equal-risk cap: trimmed ${formatWholeDollars(targetNotional)} → ${formatWholeDollars(equalRiskCap)} so a ${stopDistancePct.toFixed(1)}% stop risks at most ${formatWholeDollars(riskBudgetUsd)} (${maxRiskPct}% of equity).`;
      targetNotional = Math.floor(equalRiskCap);
    }
  };
  if (riskBudgetUsd > 0 && stopDistancePct > 0) {
    const before = targetNotional;
    applyEqualRiskCap();
    if (targetNotional < before) {
      effectiveOpeningCap = Math.min(effectiveOpeningCap, targetNotional);
      audit(
        "sizing_equal_risk_capped",
        {
          symbol: normalizeSymbol(proposal.symbol),
          from: before,
          to: targetNotional,
          stopDistancePct,
          riskBudgetUsd: Number(riskBudgetUsd.toFixed(2)),
          maxPositionRiskPctOfEquity: maxRiskPct
        },
        userId,
        policy.connectedAccountId
      );
    }
  }

  // Market-impact (ADV) cap: keep the order from sizing into a name far past what the tape can
  // absorb. ADV is approximated by the latest scan daily $-volume (price × volume) since the app
  // ingests no historical bars. Skipped when the gauge is unavailable so it never false-shrinks.
  let advCapNote = "";
  if (policy.maxOrderPctOfAdv != null && policy.maxOrderPctOfAdv > 0 && marketScan) {
    const nSym = normalizeSymbol(proposal.symbol);
    const full = marketScan.topCandidates.find((c) => normalizeSymbol(c.symbol) === nSym);
    const dollarVol = full && full.price > 0 && full.volume > 0 ? full.price * full.volume : undefined;
    if (dollarVol != null) {
      const advCap = Math.floor((policy.maxOrderPctOfAdv / 100) * dollarVol);
      if (advCap > 0 && advCap < targetNotional) {
        advCapNote = `\n\n[Sizing] ADV cap: trimmed ${formatWholeDollars(targetNotional)} → ${formatWholeDollars(advCap)} (${policy.maxOrderPctOfAdv}% of ~$${Math.round(dollarVol).toLocaleString("en-US")} daily $-volume) to bound market impact.`;
        targetNotional = advCap;
      }
      if (advCap > 0) effectiveOpeningCap = Math.min(effectiveOpeningCap, advCap);
    }
  }

  // Portfolio-heat budget (opt-in, default off, continuous taper — never a hard block): if the
  // CURRENT book's heat (bookHeat, precomputed once per run from existing positions) plus this
  // order's OWN incremental risk would exceed portfolioHeatBudgetPct of equity, taper this order's
  // notional to fit whatever budget remains. Never sizes below zero; when no budget remains at all,
  // floors at the existing exploratory-floor notional and tags an OVERRIDABLE advisory reason —
  // it still places unless another gate says otherwise. Uses the FLAT stop % (no ATR/beta history
  // exists yet for a name that isn't already a position) for this order's own risk basis; honest
  // "no stop basis" skip when no flat stop is configured either.
  let heatNote = "";
  const heatBudgetPct = policy.tuning?.portfolioHeatBudgetPct;
  if (policy.tuning?.volTargeting === true && bookHeat && typeof heatBudgetPct === "number" && heatBudgetPct > 0) {
    const ownStopPct = proposal.side === "short"
      ? (policy.riskRules.shortStopLossPct ?? policy.riskRules.stopLossPct ?? 0)
      : (policy.riskRules.stopLossPct ?? 0);
    if (ownStopPct > 0) {
      const equity = accountEquity(portfolio);
      if (equity > 0) {
        const budgetUsd = (heatBudgetPct / 100) * equity;
        const orderRiskUsd = positionRiskUsd(targetNotional, ownStopPct);
        const currentHeatUsd = bookHeat.totalRiskUsd;
        const noStopBasisCount = bookHeat.perPosition.filter((p) => p.estimated).length;
        const totalPositionsCount = bookHeat.perPosition.length;
        const currentHeatPct = bookHeat.heatPct ?? 0;
        if (orderRiskUsd > 0 && currentHeatUsd + orderRiskUsd > budgetUsd) {
          const remainingUsd = Math.max(0, budgetUsd - currentHeatUsd);
          const taperFactor = orderRiskUsd > 0 ? Math.min(1, remainingUsd / orderRiskUsd) : 1;
          const taperedNotional = Math.floor(targetNotional * taperFactor);
          if (remainingUsd <= 0) {
            // No budget left at all: hold at the existing floor rather than a hard cage, and tag an
            // OVERRIDABLE advisory reason (not a policy block) — the order still places.
            targetNotional = Math.min(targetNotional, Math.max(fallbackNotional, taperedNotional));
            heatNote =
              `\n\n[Risk] Portfolio heat ${currentHeatPct.toFixed(1)}% of equity vs budget ${heatBudgetPct}% (${totalPositionsCount} positions, ${noStopBasisCount} without stop basis); ` +
              `no remaining budget — held to exploratory floor (overridable advisory, not a block).`;
          } else if (taperedNotional < targetNotional) {
            targetNotional = Math.max(0, taperedNotional);
            heatNote =
              `\n\n[Risk] Portfolio heat ${currentHeatPct.toFixed(1)}% of equity vs budget ${heatBudgetPct}% (${totalPositionsCount} positions, ${noStopBasisCount} without stop basis); ` +
              `this order tapered to add ${(Math.max(0, (budgetUsd - currentHeatUsd) / equity * 100)).toFixed(2)}% (fit remaining budget).`;
          }
          // Distinct audit kind from the vol-target scale above: this is the heat-budget taper, a
          // separate mechanism, and conflating the two in telemetry would hide which brake fired.
          audit(
            "sizing_heat_budget_applied",
            {
              symbol: normalizeSymbol(proposal.symbol),
              side: proposal.side,
              currentHeatPct,
              budgetPct: heatBudgetPct,
              orderRiskUsd,
              remainingUsd,
              taperFactor,
              targetNotional
            },
            userId,
            policy.connectedAccountId
          );
        } else {
          heatNote =
            `\n\n[Risk] Portfolio heat ${currentHeatPct.toFixed(1)}% of equity vs budget ${heatBudgetPct}% (${totalPositionsCount} positions, ${noStopBasisCount} without stop basis); this order adds ${((orderRiskUsd / equity) * 100).toFixed(2)}%.`;
        }
      }
    }
  }

  const bracketMinimum = bracketWholeShareMinimum(proposal, policy, marketScan, stopPlanBySymbol);
  let bracketMinNote = "";
  if (bracketMinimum != null && targetNotional > 0 && targetNotional < bracketMinimum) {
    const minNotional = Math.ceil(bracketMinimum);
    if (minNotional <= effectiveOpeningCap) {
      bracketMinNote = `\n\n[Sizing] Raised ${formatWholeDollars(targetNotional)} to ${formatWholeDollars(minNotional)} so Alpaca can place a native whole-share bracket at the reference price.`;
      targetNotional = minNotional;
    } else {
      bracketMinNote = `\n\n[Sizing] Native Alpaca bracket requires about ${formatWholeDollars(minNotional)} for one whole share at the reference price, but available opening capacity is ${formatWholeDollars(effectiveOpeningCap)}; broker bracket will be skipped for this sub-share order.`;
    }
  }

  // Re-assert the equal-risk cap AFTER the bracket raise above. That raise exists only so Alpaca can
  // place a NATIVE whole-share bracket — a convenience, not a risk requirement — so it must not be
  // allowed to quietly push an order back above the configured dollar-risk budget. The cost is that
  // such an order loses its broker bracket and places unbracketed, which is the right way round: the
  // risk budget wins, the bracket does not.
  if (riskBudgetUsd > 0 && stopDistancePct > 0) applyEqualRiskCap();

  // Broker-dollar-minimum floor: Robinhood (and potentially other brokers) reject
  // dollar-based/fractional orders below a hard minimum notional (Robinhood: $1).
  // Raise the sized notional to at least that floor when capacity allows, so
  // proposals never reach the broker with notional values that are certain to be
  // rejected. When capacity does NOT allow even the minimum, the order is too small
  // to place — the policy review will block it on per-order-cap grounds.
  const brokerMinDollar = brokerMinimumDollarNotional(policy);
  let brokerMinNote = "";
  // Guard on the PRE-rounding source intent, not the post-rounding `targetNotional`. A positive
  // source size — the LLM-advised notional or the fallback size — that rounded DOWN below the floor
  // (e.g. an advised $0.22, or any positive fallback under $1) otherwise collapses to $0 and skips
  // this raise, reaching the broker as a guaranteed reject — the exact zero-notional path this floor
  // exists to eliminate. Only raise when capacity can actually cover the minimum.
  const rawSourceNotional = advisedNotional && advisedNotional > 0
    ? advisedNotional
    : Math.max(0, fallbackBase) * finalMultiplier;
  if (
    // Honor brokerMinimumHandling here too: under "skip" the owner asked for sub-minimum orders
    // to be SKIPPED (cooldown-gated), not silently raised — an unconditional raise here would
    // make skip mode unreachable for autonomous openings because the pre-flight guard downstream
    // would never see a sub-minimum order.
    (policy.brokerMinimumHandling ?? "bump") === "bump" &&
    brokerMinDollar > 0 &&
    targetNotional < brokerMinDollar &&
    (targetNotional > 0 || rawSourceNotional > 0) &&
    brokerMinDollar <= effectiveOpeningCap
  ) {
    brokerMinNote = `\n\n[Sizing] Raised ${formatWholeDollars(targetNotional)} to ${formatWholeDollars(brokerMinDollar)} to meet ${brokerLabel(policy)}'s minimum dollar-based order size.`;
    targetNotional = brokerMinDollar;
    // The broker minimum is a HARD constraint, so unlike the bracket raise it is allowed to win over
    // the equal-risk cap. But "allowed to win" is not "fine to do silently": record the breach so an
    // owner can see that a real risk budget was exceeded, and why. Only reachable when the budget
    // itself is smaller than a broker minimum, which is a misconfiguration worth surfacing, not a
    // routine trim.
    if (equalRiskCap > 0 && brokerMinDollar > equalRiskCap) {
      audit(
        "sizing_equal_risk_breached_by_broker_minimum",
        {
          symbol: normalizeSymbol(proposal.symbol),
          budgetNotional: Math.floor(equalRiskCap),
          brokerMinDollar,
          riskBudgetUsd: Number(riskBudgetUsd.toFixed(2)),
          maxPositionRiskPctOfEquity: maxRiskPct
        },
        userId,
        policy.connectedAccountId
      );
    }
  }

  // Visibility: when the conviction cap actually BINDS (uncorroborated thesis whose raw AI
  // conviction exceeded the cap), surface that the size could not ride confidence alone. Suppressed
  // for unproven theses, which already report the exploratory-floor reason below.
  const capNote = convictionCapBinds && !unproven
    ? `\n\n[Sizing] Conviction capped to ${convictionCap} — thesis not yet corroborated by realized edge (winRate ${winRate}%, avgReturn ${avgReturn}%); AI confidence alone cannot drive size up.`
    : "";
  const advisedSizeNote = advisedNotional && advisedNotional > 0
    ? targetNotional < Math.floor(advisedNotional)
      ? `\n\n[Sizing] LLM advised ${formatWholeDollars(advisedNotional)}; risk controls limited it to ${formatWholeDollars(targetNotional)}${openingSizingReason ? ` (${openingSizingReason})` : ""}.`
      : targetNotional > Math.ceil(advisedNotional)
        ? `\n\n[Sizing] LLM advised ${formatWholeDollars(advisedNotional)}; raised to ${formatWholeDollars(targetNotional)} for broker/order constraints.`
        : `\n\n[Sizing] LLM advised ${formatWholeDollars(advisedNotional)}; preserved within risk limits.`
    : "";
  const fallbackSizeNote = advisedNotional && advisedNotional > 0
    ? ""
    : `\n\n[Sizing] No explicit opening size from the LLM; fallback sized to ${formatWholeDollars(targetNotional)} (${Math.round(finalMultiplier * 100)}% of max)`;

  return {
    ...proposal,
    ...(degradedCapReceipt || throttleReceipt
      ? {
          dataAdjustments: [
            ...(proposal.dataAdjustments ?? []),
            ...(degradedCapReceipt ? [degradedCapReceipt] : []),
            ...(throttleReceipt ? [throttleReceipt] : [])
          ]
        }
      : {}),
    dollarAmount: targetNotional,
    quantity: undefined, // Override any LLM-guessed quantity to force notional routing
    rationale: proposal.rationale + advisedSizeNote + fallbackSizeNote + bracketMinNote + brokerMinNote + (unproven
      ? ` — EXPLORATORY floor: thesis has ${sampleTrades} closed lot${sampleTrades === 1 ? "" : "s"} (< ${minLotsForSizing}); held to minimum size until validated.`
      : ` from ${winRate}% win rate, ${avgReturn}% avg edge, and ${Math.round(throttledConviction * 100)}% AI conviction.`) + capNote + advCapNote + equalRiskNote + volTargetNote + heatNote + kellyNote + thesisNote
  };
}
