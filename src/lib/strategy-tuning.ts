import {
  audit,
  getPolicy,
  getStrategyPrompt,
  getActiveConnectedAccount,
  latestAuditByKind,
  listFillEvents,
  listLearningMutations,
  listStrategyRuns,
  normalizeScoringWeights,
  setPolicy
} from "./db";
import { recordLlmUsage, extractLlmUsage } from "./llm-usage";
import { deriveExecutionState, fillSourceForExecutionMode, llmExecutionMode, llmFillSource, llmModeClarification, type ExecutionState } from "./execution-mode";
import { policyUniverseSymbolCount } from "./index-universes";
import { LLM_OUTPUT_TOKEN_CAPS, llmFetch } from "./llm-request";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText } from "./llm-call";
import { resolveLlmEndpoint } from "./llm-provider";
import { humanizeLlmError } from "./llm-errors";
import { fetchMacroData } from "./macro";
import { withLlmGeneration } from "./observability";
import { calculatePnl, getClosedLotCount, getFactorScorecard, getMissedOpportunityCoverage, getPerformanceSummary, getSkippedCandidateReturns, MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT, type FactorScorecardStat } from "./performance";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import { runWalkForwardOOS, buildSpyReturnToNowMap } from "./backtest";
import { validateTuningInvariants } from "./tuning-invariants";
import { recordLearningMutation, revertLearningMutation, LEARNING_SUBSYSTEM_SCORING_WEIGHTS } from "./learning-ledger";
import type {
  FillEvent,
  MarketFactor,
  MarketScan,
  LlmReasoningEffort,
  PerformanceSummary,
  ScoringWeights,
  StrategyTuningPatch,
  StrategyTuningProposal,
  TradingPolicy
} from "./types";

/**
 * Maximum per-factor weight delta allowed in a single tuning step.
 * Phase-7 §3.E / strategic-framework §5 doc: "no more than a 5-point change per factor at a
 * time." The scoring weights run on a 0.6–1.4 multiplier scale; "5 points" maps to 0.05 on
 * that scale (consistent with treating each 0.01 increment as one "point" on the same
 * percentage basis the doc uses). This is intentionally tighter than the local-rules 0.1-0.2
 * steps: the LLM path is unconstrained by design pressure so we clamp defensively.
 */
export const MAX_WEIGHT_STEP = 0.05;

type LatestDecisionPayload = {
  summary?: string;
  marketScan?: MarketScan;
  proposals?: Array<{ proposal?: { symbol?: string; side?: string; rationale?: string }; status?: string; reasons?: string[] }>;
};

type NullableScoringWeights = Record<keyof ScoringWeights, number | null>;

type LlmTuningPayload = {
  summary: string;
  rationale: string;
  marketContext: string;
  performanceReadout: string;
  proposedPrompt: string;
  scoringWeights: NullableScoringWeights;
  policy: {
    maxOrderNotional: number | null;
    maxOrderPctOfNav: number | null;
    maxDailyNotional: number | null;
    maxSymbolExposurePct: number | null;
    maxGrossExposurePct: number | null;
    maxNetExposurePct: number | null;
    maxDailyOrders: number | null;
    maxProposalsPerRun: number | null;
    runCadenceMinutes: number | null;
    strategyAuthority: TradingPolicy["strategyAuthority"] | null;
    runDuringExtendedHours: boolean | null;
  };
  riskRules: {
    stopLossPct: number | null;
    takeProfitPct: number | null;
    trailingStopPct: number | null;
  };
  cautions: string[];
  confidenceScore: number;
};

/** A skipped candidate's realized outcome, as needed to reason about factor weighting. */
export interface MissedOpportunityInput {
  symbol: string;
  returnPct: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  ageDays?: number;
  /**
   * SPY (or other benchmark) return % over the SAME horizon as this skipped name. Only consulted
   * when `benchmarkRelative` is on: then the "winner" test becomes returnPct − benchmarkReturnPct > 0
   * so a name that only beat zero but LAGGED the market no longer counts as a missed winner.
   */
  benchmarkReturnPct?: number;
}

/** Options for `summarizeMissedOpportunities`. Defaults preserve the original >0 / >=2 behavior. */
export interface SummarizeMissedOpportunitiesOptions {
  /** Item cap. Default 8. */
  limit?: number;
  /**
   * When true, a skipped name only counts as a missed WINNER when its benchmark-relative return
   * (returnPct − benchmarkReturnPct) is positive; rows lacking a benchmark are treated as lagging
   * (excluded) so we never over-credit. Default false (winner = returnPct > 0, no market adjustment).
   */
  benchmarkRelative?: boolean;
  /** Minimum recurrences of a dominant factor before it's flagged. Default 2. */
  minRecurringCount?: number;
  /**
   * P2-1 (default false): require a real HIT RATE, not just a winner count. When on, a factor is flagged as
   * recurring ONLY if — over ALL matured skipped rows carrying it (winners AND losers) — its benchmark-beating
   * hit rate, SHRUNK toward the overall skipped hit rate, is at/above that overall base rate AND it has at
   * least `minHitRateDenominator` matured rows. This kills the failure mode where a factor "recurs" among
   * winners simply because it is the most COMMON skipped factor. Off by default → winners-only count as today.
   */
  requireHitRate?: boolean;
  /** P2-1: minimum matured rows carrying a factor before its hit rate is trusted. Default 5. */
  minHitRateDenominator?: number;
  /** P2-1: Bayesian shrinkage pseudo-count pulling a factor's hit rate toward the overall base rate. Default 5. */
  hitRateShrinkPrior?: number;
  /** Kill-survivorship disclosure ("N/M resolved (X%)") from getMissedOpportunityCoverage, threaded
   *  through untouched so every consumer of the summary can render how survivor-thinned it is. */
  coverageDisclosure?: string;
}

export interface MissedOpportunitySummary {
  items: Array<{ symbol: string; returnPct: number; score?: number; sector?: string; regime?: string; dominantFactor?: string; ageDays?: number }>;
  /** Count of winning skipped names in the window (definition depends on `benchmarkRelative`). */
  count: number;
  /** The dominant factor that recurred across >= minRecurringCount missed winners, if any. */
  recurringFactor?: string;
  recurringFactorCount?: number;
  /** P2-1: the recurring factor's shrunk benchmark-beating hit rate (0–1), present only when requireHitRate is on. */
  recurringFactorHitRate?: number;
  /** P2-1: the overall skipped-candidate base hit rate (0–1), present only when requireHitRate is on. */
  baseHitRate?: number;
  /** Kill-survivorship coverage disclosure ("N/M resolved (X%) — may be survivor-biased"), when supplied. */
  coverageDisclosure?: string;
}

/**
 * Compact matured "missed opportunity" evidence for the auto-tuner: high-scoring
 * candidates the strategy SKIPPED that subsequently rose over their horizon. When one
 * dominant factor keeps showing up among the missed winners, the tuner can weigh whether
 * the current `scoringWeights` under-weight that factor — still gated by the closed-lot
 * sample-size guardrail before any weight actually changes. Pure (no I/O) so it is unit
 * testable; callers pass already-sorted rows from `getSkippedCandidateReturns`.
 */
export function summarizeMissedOpportunities(
  rows: MissedOpportunityInput[],
  optionsOrLimit: number | SummarizeMissedOpportunitiesOptions = 8
): MissedOpportunitySummary {
  // Back-compat: a bare number is still the item limit; an options object unlocks the item-4 hardening.
  const options: SummarizeMissedOpportunitiesOptions =
    typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : optionsOrLimit;
  const limit = options.limit ?? 8;
  const benchmarkRelative = options.benchmarkRelative ?? false;
  const minRecurringCount = Math.max(1, options.minRecurringCount ?? 2);
  const requireHitRate = options.requireHitRate ?? false;
  const minHitRateDenominator = Math.max(1, options.minHitRateDenominator ?? 5);
  const hitRateShrinkPrior = Math.max(0, options.hitRateShrinkPrior ?? 5);

  // Winner test: default is the historical `returnPct > 0` (no market adjustment). Benchmark-relative
  // mode requires the name to have BEATEN the benchmark over the same horizon (return − SPY-return > 0);
  // a row with no benchmark can't be certified as a market-beater, so it's excluded (never over-credited).
  // P2-2: the SAME benchmark-relative test classifies losers, so the per-factor hit rate below is net-of-
  // benchmark on BOTH sides (a name beating 0 but lagging SPY is neither a winner nor an avoided loss).
  const isWinner = (row: MissedOpportunityInput): boolean => {
    if (typeof row.returnPct !== "number") return false;
    if (!benchmarkRelative) return row.returnPct > 0;
    if (typeof row.benchmarkReturnPct !== "number") return false;
    return row.returnPct - row.benchmarkReturnPct > 0;
  };
  const winners = rows.filter(isWinner);

  const factorCounts = new Map<string, number>();
  for (const row of winners) {
    if (row.dominantFactor) factorCounts.set(row.dominantFactor, (factorCounts.get(row.dominantFactor) ?? 0) + 1);
  }
  let recurringFactor: string | undefined;
  let recurringFactorCount = 0;
  for (const [factor, count] of factorCounts) {
    if (count > recurringFactorCount) {
      recurringFactor = factor;
      recurringFactorCount = count;
    }
  }
  const items = winners.slice(0, limit).map((row) => ({
    symbol: row.symbol,
    returnPct: row.returnPct,
    ...(typeof row.score === "number" ? { score: row.score } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.regime ? { regime: row.regime } : {}),
    ...(row.dominantFactor ? { dominantFactor: row.dominantFactor } : {}),
    ...(typeof row.ageDays === "number" ? { ageDays: row.ageDays } : {})
  }));

  // ── P2-1 (opt-in): hit-rate gate over ALL matured skipped rows (winners AND losers) ──────────────
  // Default OFF → the winners-only count above governs recurringFactor exactly as before. When on, a factor is
  // flagged ONLY when its shrunk benchmark-beating hit rate clears the overall skipped base rate and it has a
  // minimum denominator. This tallies per-factor total (any row carrying the factor with a usable returnPct)
  // and per-factor winners, computes the overall base hit rate, and shrinks each factor's rate toward it.
  if (requireHitRate) {
    const usable = rows.filter((r) => typeof r.returnPct === "number" && r.dominantFactor
      // P2-2: in benchmark-relative mode a row with no benchmark can't be classified either way → exclude it
      // from the denominator too, so the base rate isn't diluted by unclassifiable names.
      && (!benchmarkRelative || typeof r.benchmarkReturnPct === "number"));
    const totalUsable = usable.length;
    const totalWinners = usable.filter(isWinner).length;
    const baseHitRate = totalUsable > 0 ? totalWinners / totalUsable : 0;

    const perFactor = new Map<string, { total: number; wins: number }>();
    for (const row of usable) {
      const f = row.dominantFactor as string;
      const bucket = perFactor.get(f) ?? { total: 0, wins: 0 };
      bucket.total += 1;
      if (isWinner(row)) bucket.wins += 1;
      perFactor.set(f, bucket);
    }

    // Pick the factor with the highest SHRUNK hit rate that also clears the denominator + winner-count bars.
    let bestFactor: string | undefined;
    let bestHitRate = -Infinity;
    let bestWins = 0;
    for (const [factor, { total, wins }] of perFactor) {
      if (total < minHitRateDenominator) continue;
      if (wins < minRecurringCount) continue;
      // Bayesian shrinkage of the factor's win rate toward the overall base rate (prior mass = shrinkPrior).
      const shrunk = (wins + hitRateShrinkPrior * baseHitRate) / (total + hitRateShrinkPrior);
      if (shrunk >= baseHitRate && shrunk > bestHitRate) {
        bestFactor = factor;
        bestHitRate = shrunk;
        bestWins = wins;
      }
    }

    return {
      items,
      count: winners.length,
      baseHitRate: Number(baseHitRate.toFixed(4)),
      ...(bestFactor
        ? { recurringFactor: bestFactor, recurringFactorCount: bestWins, recurringFactorHitRate: Number(bestHitRate.toFixed(4)) }
        : {}),
      ...(options.coverageDisclosure ? { coverageDisclosure: options.coverageDisclosure } : {})
    };
  }

  return {
    items,
    count: winners.length,
    ...(recurringFactor && recurringFactorCount >= minRecurringCount ? { recurringFactor, recurringFactorCount } : {}),
    ...(options.coverageDisclosure ? { coverageDisclosure: options.coverageDisclosure } : {})
  };
}

/** The scoring-weight factor keys that a missed-opportunity nudge may touch (subset of ScoringWeights). */
const NUDGEABLE_FACTORS = new Set<keyof ScoringWeights>([
  "liquidity", "momentum", "value", "quality", "volatility", "sentiment", "positioning", "diversification"
]);

export interface MissedOpportunityNudgeResult {
  weights: ScoringWeights;
  /** The factor that was nudged, if any (for auditing). */
  nudgedFactor?: keyof ScoringWeights;
  /** The clamped delta actually applied (+step), if any. */
  delta?: number;
  /** Human-readable reason, present only when a nudge was applied. */
  note?: string;
}

/**
 * Item 3: derive a SMALL, CLAMPED, transient per-factor weight nudge from matured missed-opportunity
 * evidence, applied to THIS run's scan-scoring weights only (NOT persisted — persisting is the item-1
 * autonomous-apply path). When a single dominant factor recurred across enough benchmark-beating missed
 * winners (`summary.recurringFactor` set), bump that factor's weight up by `MAX_WEIGHT_STEP`. Pure over
 * (weights, summary); returns the weights unchanged when the sample gate isn't met or the factor isn't a
 * recognized scoring factor. Caller is responsible for the flag check + the closed-lot sample gate and for
 * emitting the audit row using `note`/`nudgedFactor`.
 */
export function applyMissedOpportunityNudge(
  weights: ScoringWeights,
  summary: MissedOpportunitySummary,
  step: number = MAX_WEIGHT_STEP
): MissedOpportunityNudgeResult {
  const factor = summary.recurringFactor as keyof ScoringWeights | undefined;
  if (!factor || !NUDGEABLE_FACTORS.has(factor) || typeof weights[factor] !== "number") {
    return { weights };
  }
  const current = weights[factor];
  const bumped = round(current + step);
  return {
    weights: { ...weights, [factor]: bumped },
    nudgedFactor: factor,
    delta: round(step),
    note: `Missed-opportunity nudge: '${factor}' recurred across ${summary.recurringFactorCount} benchmark-beating skipped winner(s); nudged its scan weight ${current} -> ${bumped} (+${round(step)}) for this run only.`
  };
}

/**
 * Derive the current market regime from the most-recent closed lot that has a regime stamp.
 * Returns undefined when no closed lots have a regime field.
 */
function currentRegimeFromLots(accountNumber: string, source: "paper" | "live", userId: string): string | undefined {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId));
  // Lots are returned oldest-first; iterate in reverse for the most-recent stamped regime.
  for (let i = closedLots.length - 1; i >= 0; i--) {
    const r = closedLots[i].regime?.trim();
    if (r) return r;
  }
  return undefined;
}

function policyForTuningReviewer(policy: TradingPolicy, modelOverride?: string): TradingPolicy {
  const explicitModel = modelOverride?.trim();
  if (explicitModel) return { ...policy, llmModel: explicitModel };
  const teamModel = policy.redTeamLlmModel?.trim() || policy.llmModel?.trim();
  return teamModel ? { ...policy, llmModel: teamModel } : policy;
}

export async function proposeStrategyTuning(
  userId: string = "local",
  modelOverride?: string,
  reasoningEffortOverride?: LlmReasoningEffort
): Promise<StrategyTuningProposal> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  const prompt = getStrategyPrompt(userId);
  const latestDecision = (policy.connectedAccountId
    ? latestAuditByKind("strategy_run", userId, policy.connectedAccountId)
    : latestAuditByKind("strategy_run", userId))?.payload as LatestDecisionPayload | undefined;
  const macro = await fetchMacroData(userId);
  const accountNumber = policy.accountNumber;
  const performance = accountNumber ? getPerformanceSummary(accountNumber, {}, userId) : undefined;
  const source = fillSourceForExecutionMode(executionState);
  const fills = accountNumber ? listFillEvents(accountNumber, source, 30, userId) : [];
  const closedLotCount = accountNumber ? getClosedLotCount(accountNumber, source, userId) : 0;
  const minLotsForWeights = policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
  const runs = listStrategyRuns(10, userId);
  // Matured skipped-candidate counterfactuals (empty price map => realized rows only,
  // no live quotes needed). Lets the tuner learn from high-scoring names it passed on.
  // Item 4 (opt-in): raise the recurring-factor bar to >=5 and require SPY-beating over each row's OWN
  // entry→now window before a skipped name counts as a "missed winner". Default OFF → byte-identical.
  // The SPY excess return is injected in getSkippedCandidateReturns (keeping summarize pure), reusing the
  // backtest SPY fetch. A missing SPY row → benchmarkReturnPct absent → excluded by the winner test (never
  // falls back to raw returnPct>0).
  const benchmarkRelative = policy.tuning?.benchmarkRelativeMisses ?? false;
  const minRecurringCount = policy.tuning?.recurringFactorMinCount ?? (benchmarkRelative ? 5 : 2);
  // P2-1: the hit-rate gate needs the FULL matured skipped set (winners AND losers) to compute a real base
  // rate, so widen the fetch limit when it's on. Default off → the historical top-12 window is unchanged.
  const requireHitRate = policy.tuning?.missedOpportunityRequireHitRate ?? false;
  const skippedLimit = requireHitRate ? 100 : 12;
  let benchmarkReturnBySnapshotDate: Map<string, number> | undefined;
  if (benchmarkRelative) {
    // Pre-scan the snapshot dates the skipped rows will span, then build one SPY entry→now map for them.
    const preScan = getSkippedCandidateReturns({}, userId, { limit: skippedLimit, maxAgeDays: 30, connectedAccountId: policy.connectedAccountId });
    const dates = Array.from(new Set(preScan.map((r) => r.asOf?.slice(0, 10)).filter((d): d is string => Boolean(d))));
    benchmarkReturnBySnapshotDate = await buildSpyReturnToNowMap(dates).catch(() => new Map<string, number>());
  }
  const skippedRows = getSkippedCandidateReturns({}, userId, { limit: skippedLimit, maxAgeDays: 30, connectedAccountId: policy.connectedAccountId, benchmarkReturnBySnapshotDate });
  // Kill-survivorship disclosure: the tuner (and anything rendering this summary) sees how many
  // counterfactuals actually resolved vs terminally failed, instead of a silently survivor-thinned list.
  const missedOpportunityCoverage = getMissedOpportunityCoverage(userId, policy.connectedAccountId);
  const missedOpportunities = summarizeMissedOpportunities(skippedRows, { limit: 8, benchmarkRelative, minRecurringCount, requireHitRate, coverageDisclosure: missedOpportunityCoverage.disclosure });
  // Factor-outcome history: realized win-rate and avg-return grouped by dominant entry factor.
  // Gated by the same closed-lot minimum — below the gate the sample is too thin to trust
  // per-factor attribution.
  // Task 2: prefer same-regime evidence when the current regime bucket meets the closed-lot
  // threshold; fall back to all-regime aggregate when the regime bucket is too thin.
  const currentRegime = accountNumber ? currentRegimeFromLots(accountNumber, source, userId) : undefined;
  const factorScorecard: FactorScorecardStat[] = accountNumber && closedLotCount >= minLotsForWeights
    ? (() => {
        if (currentRegime) {
          const regime = currentRegime;
          // Attempt regime-filtered scorecard; fall back to all-regime when regime bucket is too thin.
          const regimeScorecard = getFactorScorecard(accountNumber, source, {}, userId, { regime });
          const regimeLots = regimeScorecard.reduce((s, r) => s + r.trades, 0);
          if (regimeLots >= minLotsForWeights) return regimeScorecard;
          // Regime bucket too thin — use all-regime aggregate.
        }
        return getFactorScorecard(accountNumber, source, {}, userId);
      })()
    : [];

  const executionMode = llmExecutionMode(executionState);
  const context = {
    currentDate: new Date().toISOString(),
    activeMode: executionMode,
    activeModeClarification: llmModeClarification(executionState),
    accountConfigured: Boolean(accountNumber),
    policy: compactPolicy(policy, executionState),
    strategyPrompt: prompt,
    performance: compactPerformance(performance, executionState.mode !== "broker/live", getPolicy(userId).tuning?.useEntryRunAttribution ?? false),
    closedLotCount,
    minClosedLotsForWeightShift: minLotsForWeights,
    recentFills: fills.slice(0, 20).map((fill) => compactFill(fill, executionState)),
    recentRuns: runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
      totalCount: run.totalCount,
      placedCount: run.placedCount,
      proposedCount: run.proposedCount,
      blockedCount: run.blockedCount,
      summary: run.summary
    })),
    latestDecision: latestDecision
      ? {
          summary: latestDecision.summary,
          marketScan: compactMarketScan(latestDecision.marketScan),
          proposals: latestDecision.proposals?.map((item) => ({
            symbol: item.proposal?.symbol,
            side: item.proposal?.side,
            status: item.status,
            reasons: item.reasons,
            rationale: item.proposal?.rationale
          }))
        }
      : undefined,
    ...(missedOpportunities.count > 0 ? { missedOpportunities } : {}),
    ...(factorScorecard.length > 0 ? { factorScorecard } : {}),
    macro
  };

  const policyForResolution = policyForTuningReviewer(policy, modelOverride);
  const { key: llmKey } = resolveLlmEndpoint(policyForResolution, userId);
  if (!llmKey) {
    const localProposal = localRulesProposal({ policy, prompt, performance, fills, latestDecision, closedLotCount, missedOpportunities, factorScorecard, showPaperSide: source === "paper" });
    return applyOosGate(localProposal, userId);
  }

  const payload = await requestLlmTuning(context, userId, modelOverride, reasoningEffortOverride);
  const proposedPatch = toPatch(payload, prompt, policy.scoringWeights);
  const cautions = Array.isArray(payload.cautions) ? [...payload.cautions] : [];
  // Hard-enforce the §3.E sample-size guardrail: the system prompt asks the model to
  // null factor weights below the gate, but never trust prose for a safety rule —
  // strip any weight changes it returned anyway when the closed-lot sample is too thin.
  if (closedLotCount < minLotsForWeights && proposedPatch.scoringWeights && Object.keys(proposedPatch.scoringWeights).length > 0) {
    delete proposedPatch.scoringWeights;
    cautions.push(`Withheld model-proposed factor-weight changes: only ${closedLotCount}/${minLotsForWeights} closed lots (insufficient evidence).`);
  }
  const llmProposal: StrategyTuningProposal = {
    summary: payload.summary || "No summary provided by LLM.",
    rationale: payload.rationale || "No rationale provided by LLM.",
    marketContext: payload.marketContext || "No market context provided by LLM.",
    performanceReadout: payload.performanceReadout || "No performance readout provided by LLM.",
    proposedPatch,
    cautions,
    confidenceScore: typeof payload.confidenceScore === "number" ? clamp(payload.confidenceScore, 0, 100) : 50,
    generatedBy: "llm"
  };
  return applyOosGate(llmProposal, userId);
}

/**
 * OOS walk-forward gate for proposed `scoringWeights`. Called after both the LLM and local-rules
 * paths complete. If the proposal includes `scoringWeights`:
 *  - Runs `runWalkForwardOOS` with the ACTUAL proposed weights (merged over the current policy as
 *    the full candidate vector) and the current weights as the baseline.
 *  - If the candidate's OOS composite IC does NOT beat the current weights' OOS IC, strips the
 *    weights and emits a caution.
 *  - Otherwise, attaches an OOS readout to the cautions array (informational).
 * Returns the proposal unchanged when no scoring-weight changes are proposed, or when OOS
 * data is insufficient (< 4 snapshot dates → runWalkForwardOOS returns null).
 */
/**
 * Handles unvalidated OOS weight changes. When withhold=true (the default), STRIPS proposed
 * scoringWeights from the patch — strictly more conservative than keeping them. When withhold=false,
 * restores the prior behavior: keeps weights but appends a caution (opt-out via oosWithholdUnvalidated=false).
 */
function withOosUnvalidatedCaution(proposal: StrategyTuningProposal, reason: string, withhold = true): StrategyTuningProposal {
  if (!proposal.proposedPatch.scoringWeights || Object.keys(proposal.proposedPatch.scoringWeights).length === 0) return proposal;
  const patch = { ...proposal.proposedPatch };
  if (withhold) delete patch.scoringWeights;
  const caution = withhold
    ? `Withheld factor-weight changes: NOT out-of-sample validated (${reason}) — too risky to apply unvalidated weight changes; stripped from the patch.`
    : `Proposed factor-weight changes were NOT out-of-sample validated (${reason}) — they are kept as proposed, so apply with extra care.`;
  return { ...proposal, proposedPatch: patch, cautions: [...proposal.cautions, caution] };
}

async function applyOosGate(proposal: StrategyTuningProposal, userId: string): Promise<StrategyTuningProposal> {
  const proposedWeights = proposal.proposedPatch.scoringWeights;
  if (!proposedWeights || Object.keys(proposedWeights).length === 0) return proposal;

  // Change C: read the withhold flag (default true = strip unvalidated weight changes).
  const withhold = getPolicy(userId).tuning?.oosWithholdUnvalidated ?? true;

  // The status-quo weights this proposal would replace, and the full candidate vector that WOULD be
  // applied. A proposed patch only names the factors it changes, so merge it over the baseline and
  // normalize — exactly mirroring how db-profiles persists a weight patch.
  const baselineWeights = getPolicy(userId).scoringWeights;
  const candidateWeights = normalizeScoringWeights({ ...baselineWeights, ...proposedWeights });

  let oosResult;
  try {
    // Validate the ACTUAL proposed weights (and the current baseline) on held-out data — not the
    // data-derived IC weights, which answer a different question.
    oosResult = await runWalkForwardOOS(userId, { candidateWeights, baselineWeights });
  } catch {
    // OOS fetch failed (e.g. network error in test); skip the gate gracefully — but flag non-validation.
    return withOosUnvalidatedCaution(proposal, "the OOS data fetch failed", withhold);
  }

  if (!oosResult) {
    // Insufficient snapshot history (< 4 dates) to run OOS — skip the gate, but flag non-validation.
    return withOosUnvalidatedCaution(proposal, "insufficient snapshot history — need ≥4 distinct snapshot dates", withhold);
  }

  // Gate on the CANDIDATE weights vs the CURRENT weights — "does what's proposed beat what's
  // running today on held-out data?". We always pass both weight vectors into runWalkForwardOOS, so
  // these are present on the real path; if they're somehow absent, skip the gate (keep weights, no
  // misleading "validated" caution) rather than falling back to a comparison that ignores the
  // proposed weights — the exact bug this fix removes.
  const candidateIC = oosResult.oosICCandidate;
  const baselineIC = oosResult.oosICBaseline;
  if (candidateIC == null || baselineIC == null) return withOosUnvalidatedCaution(proposal, "the OOS run returned no composite IC", withhold);
  const improves = candidateIC > baselineIC;
  const oosReadout = `OOS walk-forward: proposed-weights composite IC=${candidateIC.toFixed(3)} vs current IC=${baselineIC.toFixed(3)}, ICIR=${oosResult.oosICIR.toFixed(2)}.`;

  const cautions = [...proposal.cautions];
  const patch = { ...proposal.proposedPatch };

  if (!improves) {
    // Proposed weights did not beat the current weights OOS → strip them, keep prompt/risk nudges.
    delete patch.scoringWeights;
    cautions.push(
      `Withheld model-proposed factor-weight changes: ${oosReadout} Proposed weights did not improve OOS IC over the current weights — withheld to avoid overfitting.`
    );
  } else {
    // Proposed weights improved OOS IC over the current weights → attach informational readout.
    cautions.push(`OOS-validated weight changes: ${oosReadout} Proposed weights improved OOS IC over the current weights. Apply with care.`);
  }

  return { ...proposal, proposedPatch: patch, cautions };
}

function compactPolicy(policy: TradingPolicy, executionState: ExecutionState) {
  return {
    systemState: policy.systemState,
    executionMode: llmExecutionMode(executionState),
    executionModeClarification: llmModeClarification(executionState),
    includedIndices: policy.includedIndices,
    additionalWatchlistCount: policy.additionalSymbols.length,
    ignoredSymbolCount: policy.blocklist?.length ?? 0,
    allowedCount: policyUniverseSymbolCount(policy).count,
    marketScanCandidateLimit: policy.marketScanCandidateLimit,
    marketScanOutlierReserve: policy.marketScanOutlierReserve,
    strategyAuthority: policy.strategyAuthority,
    maxOrderNotional: policy.maxOrderNotional,
    maxDailyNotional: policy.maxDailyNotional,
    maxSymbolExposurePct: policy.maxSymbolExposurePct,
    maxDailyOrders: policy.maxDailyOrders,
    maxProposalsPerRun: policy.maxProposalsPerRun,
    runCadenceMinutes: policy.runCadenceMinutes,
    runDuringExtendedHours: policy.runDuringExtendedHours,
    scoringWeights: policy.scoringWeights,
    riskRules: policy.riskRules,
    sectorCaps: policy.sectorCaps
  };
}

export function compactPerformance(performance: PerformanceSummary | undefined, showPaperSide: boolean, useEntryAttribution = false) {
  if (!performance) return undefined;
  const recentAttribution = performance.attribution.slice(-8);
  return {
    realizedPnl: showPaperSide ? performance.paperRealizedPnl : performance.liveRealizedPnl,
    unrealizedPnl: showPaperSide ? performance.paperUnrealizedPnl : performance.liveUnrealizedPnl,
    winRate: showPaperSide ? performance.paperWinRate : performance.liveWinRate,
    averageReturnPct: showPaperSide ? performance.paperAverageReturnPct : performance.liveAverageReturnPct,
    fillCount: performance.fills.length,
    // Change A (consumer, flag OFF by default): when useEntryAttribution=false (default), strip the new
    // entry/exit credit fields from the context object so the tuner's serialized input is byte-for-byte
    // identical to today. When opted in, the extra keys appear for advisory LLM context only (no math change).
    recentAttribution: useEntryAttribution
      ? recentAttribution
      : recentAttribution.map(({ realizedPnlAsEntry: _e, realizedPnlAsExit: _x, ...rest }) => rest)
  };
}

function compactFill(fill: FillEvent, executionState: ExecutionState) {
  return {
    filledAt: fill.filledAt,
    source: llmFillSource(fill.source, executionState),
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    notional: fill.notional,
    status: fill.status
  };
}

function compactMarketScan(scan?: MarketScan) {
  if (!scan) return undefined;
  return {
    source: scan.source,
    generatedAt: scan.generatedAt,
    scannedSymbols: scan.scannedSymbols,
    returnedQuotes: scan.returnedQuotes,
    warnings: scan.warnings,
    topCandidates: scan.topCandidates.slice(0, 10).map((quote, index) => ({
      rank: index + 1,
      symbol: quote.symbol,
      price: quote.price,
      intradayChangePct: quote.intradayChangePct,
      volume: quote.volume,
      marketCap: quote.marketCap,
      peRatio: quote.peRatio,
      sentiment: quote.sentiment,
      analystRating: quote.analystRating,
      sector: quote.sector,
      score: quote.score,
      factorBreakdown: quote.factorBreakdown
    }))
  };
}

async function requestLlmTuning(
  context: unknown,
  userId: string,
  modelOverride?: string,
  reasoningEffortOverride?: LlmReasoningEffort
): Promise<LlmTuningPayload> {
  const policy = getPolicy(userId);
  const policyForResolution = policyForTuningReviewer(policy, modelOverride);
  const { url, key: openaiKey, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(policyForResolution, userId);
  const schema = tuningSchema();
  const systemPrompt = [
    "You are the strategy improvement reviewer for Socratic Trade, an autonomous equity-reasoning desk.",
    "Review recent paper vs live performance, latest market scan context, macro context, current risk policy, scoring weights, and the current strategy prompt.",
    "Suggest conservative improvements that can be manually reviewed before being applied.",
    "Do not propose placing trades. Do not remove explicit safety controls.",
    `Sample-size guardrail: only propose scoringWeights (factor weight) changes when closedLotCount >= minClosedLotsForWeightShift (${MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT} closed lots). Below that the realized sample is too thin to attribute P&L to factors; return null for every scoringWeights JSON field, but describe that to the user as "no scoring-weight changes until there is enough closed-lot evidence" and focus on prompt clarity and risk sizing.`,
    "`missedOpportunities` (when present): high-scoring candidates the strategy SKIPPED that then rose over their horizon — each with realized returnPct, score, sector, regime, and dominantFactor; `recurringFactor` flags a factor that dominated multiple missed winners. If it appears, weigh whether scoringWeights under-weight that factor, but still obey the sample-size guardrail above before changing any weight.",
    "Return strict JSON only."
  ].join("\n");

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent: JSON.stringify(context),
      schema: { name: "strategy_tuning", schema, description: "Conservative, reviewable strategy-tuning suggestions." },
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyTuning,
      reasoningEffort: reasoningEffortOverride ?? policyForResolution.llmReasoningEffort
    }
  );

  const traced = await withLlmGeneration(
    {
      name: "trading.strategy.tuning",
      model,
      userId,
      input: summarizeOpenAiRequest(body),
      metadata: {
        endpoint: url,
        transport
      },
      tags: ["strategy-tuning"],
      output: (result) => ({
        ...summarizeOpenAiResponseText(result.text),
        confidenceScore: result.payload.confidenceScore,
        cautionCount: result.payload.cautions.length,
        proposedPromptChars: result.payload.proposedPrompt.length,
        summaryChars: result.payload.summary.length
      })
    },
    async () => {
      const response = await llmFetch(url, {
        method: "POST",
        headers: llmAuthHeaders({ provider, key: openaiKey }),
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(humanizeLlmError(detail, { provider, status: response.status }));
      }

      const payload = await response.json();
      recordLlmUsage({ userId, provider, model, context: "strategy-tuning", keySource, keyRef, ...extractLlmUsage(payload) });
      const text = extractLlmText(payload);
      if (!text) throw new Error("Empty strategy tuning response returned from LLM API.");
      return { text, payload: JSON.parse(text) as LlmTuningPayload };
    }
  );

  return traced.payload;
}

function tuningSchema() {
  const nullableNumber = { type: ["number", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "rationale",
      "marketContext",
      "performanceReadout",
      "proposedPrompt",
      "scoringWeights",
      "policy",
      "riskRules",
      "cautions",
      "confidenceScore"
    ],
    properties: {
      summary: { type: "string" },
      rationale: { type: "string" },
      marketContext: { type: "string" },
      performanceReadout: { type: "string" },
      proposedPrompt: { type: "string" },
      scoringWeights: {
        type: "object",
        additionalProperties: false,
        required: ["liquidity", "momentum", "value", "quality", "volatility", "sentiment", "positioning", "diversification"],
        properties: {
          liquidity: nullableNumber,
          momentum: nullableNumber,
          value: nullableNumber,
          quality: nullableNumber,
          volatility: nullableNumber,
          sentiment: nullableNumber,
          positioning: nullableNumber,
          diversification: nullableNumber
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxOrderNotional",
          "maxDailyNotional",
          "maxSymbolExposurePct",
          "maxDailyOrders",
          "maxProposalsPerRun",
          "runCadenceMinutes",
          "strategyAuthority",
          "runDuringExtendedHours"
        ],
        properties: {
          maxOrderNotional: nullableNumber,
          maxDailyNotional: nullableNumber,
          maxSymbolExposurePct: nullableNumber,
          maxDailyOrders: nullableNumber,
          maxProposalsPerRun: nullableNumber,
          runCadenceMinutes: nullableNumber,
          strategyAuthority: { enum: ["propose", "decide", null] },
          runDuringExtendedHours: { type: ["boolean", "null"] }
        }
      },
      riskRules: {
        type: "object",
        additionalProperties: false,
        required: ["stopLossPct", "takeProfitPct", "trailingStopPct"],
        properties: {
          stopLossPct: nullableNumber,
          takeProfitPct: nullableNumber,
          trailingStopPct: nullableNumber
        }
      },
      cautions: { type: "array", items: { type: "string" }, maxItems: 6 },
      confidenceScore: { type: "number" }
    }
  };
}

function toPatch(payload: LlmTuningPayload, currentPrompt: string, currentWeights?: ScoringWeights): StrategyTuningPatch {
  const rawWeights = pruneNumeric(payload.scoringWeights);
  const scoringWeights: Partial<Record<keyof ScoringWeights, number>> = {};
  for (const [key, proposed] of Object.entries(rawWeights) as [keyof ScoringWeights, number][]) {
    const current = currentWeights?.[key];
    if (typeof current === "number") {
      scoringWeights[key] = round(clamp(proposed, current - MAX_WEIGHT_STEP, current + MAX_WEIGHT_STEP));
    } else {
      scoringWeights[key] = proposed;
    }
  }
  const policyPatch = prunePolicy(payload.policy);
  const riskRules = pruneNumeric(payload.riskRules);
  return {
    ...(payload.proposedPrompt && typeof payload.proposedPrompt === "string" && payload.proposedPrompt.trim() && payload.proposedPrompt.trim() !== currentPrompt.trim()
      ? { prompt: payload.proposedPrompt.trim() }
      : {}),
    ...(Object.keys(scoringWeights).length ? { scoringWeights } : {}),
    ...(Object.keys(policyPatch).length || Object.keys(riskRules).length
      ? { policy: { ...policyPatch, ...(Object.keys(riskRules).length ? { riskRules } : {}) } }
      : {})
  };
}

function pruneNumeric<T extends Record<string, number | null | undefined>>(value: T | null | undefined): Partial<Record<keyof T, number>> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
  ) as Partial<Record<keyof T, number>>;
}

function prunePolicy(value: LlmTuningPayload["policy"] | null | undefined): NonNullable<StrategyTuningPatch["policy"]> {
  if (!value) return {};
  const patch: NonNullable<StrategyTuningPatch["policy"]> = {};
  for (const key of [
    "maxOrderNotional",
    "maxDailyNotional",
    "maxSymbolExposurePct",
    "maxDailyOrders",
    "maxProposalsPerRun",
    "runCadenceMinutes"
  ] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) patch[key] = value[key];
  }

  if (value.strategyAuthority) patch.strategyAuthority = value.strategyAuthority;
  if (typeof value.runDuringExtendedHours === "boolean") patch.runDuringExtendedHours = value.runDuringExtendedHours;
  return patch;
}

function localRulesProposal(input: {
  policy: TradingPolicy;
  prompt: string;
  performance?: PerformanceSummary;
  fills: FillEvent[];
  latestDecision?: LatestDecisionPayload;
  closedLotCount: number;
  missedOpportunities?: MissedOpportunitySummary;
  factorScorecard?: FactorScorecardStat[];
  showPaperSide: boolean;
}): StrategyTuningProposal {
  const perf = compactPerformance(input.performance, input.showPaperSide);
  const weakPerformance = typeof perf?.averageReturnPct === "number" && perf.averageReturnPct < 0;
  const lowSample = input.fills.length < 5;
  // Phase-7 §3.E guardrail: don't shift factor weights until enough lots have closed.
  const minLotsForWeights = input.policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
  const enoughLotsForWeights = input.closedLotCount >= minLotsForWeights;
  const proposedPrompt = input.prompt.includes("LEARNING LOOP")
    ? input.prompt
    : `${input.prompt.trim()}\n\nLEARNING LOOP\nBefore proposing trades, review recent fills, blocked proposals, and the latest market scan. If the recent sample is small, prefer smaller exploratory orders. If average return is negative, tighten risk and demand a clearer signal from price momentum, volume, valuation, and news sentiment before adding exposure.`;

  const riskMultiplier = weakPerformance ? 0.8 : 1;
  const maxOrderNotional = Math.max(1, Math.round((input.policy.maxOrderNotional ?? 100) * riskMultiplier));

  // Derive factor-outcome weight nudges: factors with negative avg return get a small downward
  // nudge (−MAX_WEIGHT_STEP); factors with both positive avg return AND win rate ≥ 60% get a
  // small upward nudge (+MAX_WEIGHT_STEP). Only applied when the closed-lot gate is satisfied
  // and the factor has at least 3 trades (thin per-factor buckets shouldn't drive changes).
  // These nudges override the general weakPerformance deltas for the specific factors they cover.
  const factorNudges: Partial<Record<MarketFactor, number>> = {};
  const factorNudgeCautions: string[] = [];
  if (enoughLotsForWeights && input.factorScorecard && input.factorScorecard.length > 0) {
    for (const stat of input.factorScorecard) {
      if (stat.trades < 3) continue;
      const current = input.policy.scoringWeights[stat.factor as keyof ScoringWeights];
      if (typeof current !== "number") continue;
      if (stat.avgReturnPct < 0) {
        factorNudges[stat.factor as MarketFactor] = round(clamp(current - MAX_WEIGHT_STEP, 0, Infinity));
        factorNudgeCautions.push(`Factor '${stat.factor}' has negative avg return (${stat.avgReturnPct.toFixed(2)}%) across ${stat.trades} trades — nudging weight down by ${MAX_WEIGHT_STEP}.`);
      } else if (stat.shrunkWinRate >= 60 && stat.avgReturnPct > 0) {
        factorNudges[stat.factor as MarketFactor] = round(current + MAX_WEIGHT_STEP);
        factorNudgeCautions.push(`Factor '${stat.factor}' has strong outcomes (${stat.shrunkWinRate}% win rate, ${stat.avgReturnPct.toFixed(2)}% avg return, ${stat.trades} trades) — nudging weight up by ${MAX_WEIGHT_STEP}.`);
      }
    }
  }

  // Only adjust factor weights once the realized sample is large enough to trust;
  // below the gate we still improve the prompt and risk sizing, just not the weights.
  // Factor-outcome nudges (if any) take precedence over the general weakPerformance adjustment
  // for the keys they cover; the rest of the general adjustment still applies.
  const scoringWeights: Partial<ScoringWeights> = !enoughLotsForWeights
    ? {}
    : (() => {
        const base: Partial<ScoringWeights> = weakPerformance
          ? {
              volatility: round(input.policy.scoringWeights.volatility + 0.2),
              quality: round(input.policy.scoringWeights.quality + 0.1),
              momentum: Math.max(0, round(input.policy.scoringWeights.momentum - 0.1))
            }
          : {
              diversification: round(input.policy.scoringWeights.diversification + 0.1),
              sentiment: round(input.policy.scoringWeights.sentiment + 0.1)
            };
        // Apply factor nudges on top; they replace any key already set by the base rule.
        return { ...base, ...factorNudges };
      })();

  return {
    summary: lowSample
      ? "Collect more trade evidence, but add an explicit learning loop to the prompt now."
      : weakPerformance
        ? "Recent average return is negative; tighten order size and require higher-quality signals."
        : "Recent performance is not flashing a drawdown warning; improve the prompt feedback loop and keep risk steady.",
    rationale:
      "This local rules review uses recent fills, run history, and latest scan metadata. Use the LLM review button again after configuring OPENAI_API_KEY for a model-generated rewrite.",
    marketContext:
      input.latestDecision?.marketScan
        ? `Latest scan covered ${input.latestDecision.marketScan.scannedSymbols} symbols from ${input.latestDecision.marketScan.source}.`
        : "No recent market scan is available yet; run the strategy once before relying on tuning suggestions.",
    performanceReadout: perf
      ? `Average return ${perf.averageReturnPct.toFixed(2)}%, win rate ${perf.winRate.toFixed(0)}%, realized P&L ${perf.realizedPnl.toFixed(2)}.`
      : "No performance summary is available because no account is selected.",
    proposedPatch: {
      prompt: proposedPrompt,
      scoringWeights,
      policy: {
        ...(weakPerformance ? { maxOrderNotional, maxProposalsPerRun: Math.max(1, input.policy.maxProposalsPerRun - 1) } : {}),
        riskRules: weakPerformance
          ? {
              stopLossPct: Math.max(1, round((input.policy.riskRules.stopLossPct ?? 8) * 0.85)),
              takeProfitPct: round(input.policy.riskRules.takeProfitPct ?? 20)
            }
          : {}
      }
    },
    cautions: [
      "Manual approval is required before changes are applied.",
      enoughLotsForWeights
        ? "Validate with another run after applying changes."
        : `Only ${input.closedLotCount}/${minLotsForWeights} closed lots — withholding factor-weight changes until the realized sample is large enough to trust.`,
      ...(lowSample ? ["The trade sample is still small, so avoid overfitting."] : []),
      ...(input.missedOpportunities?.recurringFactor && input.missedOpportunities.recurringFactorCount
        ? [`Missed-opportunity signal: ${input.missedOpportunities.count} skipped name(s) rose; '${input.missedOpportunities.recurringFactor}' was the recurring dominant factor in ${input.missedOpportunities.recurringFactorCount} of them — consider whether scoringWeights under-weight it (subject to the closed-lot gate).`]
        : []),
      ...factorNudgeCautions
    ],
    confidenceScore: lowSample ? 45 : weakPerformance ? 65 : 55,
    generatedBy: "local_rules"
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── Item 1: opt-in autonomous factor-weight tuning (close the loop) ─────────────────────────────

export interface AutonomousWeightApplyResult {
  /** Whether weights were actually persisted this run. */
  applied: boolean;
  /** Why nothing was applied (present only when applied=false). */
  reason?: string;
  /** The prior full weight vector (for revert), present when applied. */
  previousWeights?: ScoringWeights;
  /** The new full weight vector actually persisted, present when applied. */
  newWeights?: ScoringWeights;
  /** The OOS/clamp cautions attached to the underlying proposal (audit trail). */
  cautions?: string[];
}

/** Audit kind for an autonomous weight application (also the revert lookup key). */
export const AUTO_WEIGHT_APPLY_AUDIT_KIND = "auto_weight_apply";
/** Ledger trigger for a P1-3 SHADOW row (what the tuner WOULD have applied — never persisted to policy). */
export const AUTO_WEIGHT_SHADOW_TRIGGER = "auto_weight_shadow";
/** P2-7 audit kind: the reproducibility/decision-provenance snapshot written on each autonomous apply. */
export const TUNING_APPLY_PROVENANCE_AUDIT_KIND = "tuning_apply_provenance";

/**
 * Panel P1-1: the full, side-effect-FREE decision an autonomous apply WOULD make. Produced by the shared
 * evaluator and consumed by both the real apply (`applyAutonomousWeightTuning`) and the read-only dry-run
 * (`dryRunAutonomousWeightTuning`). Computing this performs NO writes: no `setPolicy`, no ledger row, no
 * cadence-key advance, no audit.
 */
export interface AutonomousWeightDecision {
  /** Would the gate persist these weights on a real apply? */
  wouldApply: boolean;
  /** Machine reason when `wouldApply` is false (mirrors the apply-path reasons). */
  reason?: string;
  /** The status-quo weight vector (normalized) the apply would replace. */
  before?: ScoringWeights;
  /** The candidate vector the apply would persist (clamped + normalized). Present when a candidate was built. */
  after?: ScoringWeights;
  /** The OOS composite ICs on the shared fold. */
  oosICCandidate?: number;
  oosICBaseline?: number;
  /** The clamped per-factor deltas (after − before) for the changed factors. */
  clampedDeltas?: Partial<Record<keyof ScoringWeights, number>>;
  /** The full OOS readout justifying the decision (nulls if OOS couldn't run). */
  oosReadout?: {
    icDelta?: number;
    icir?: number;
    testDates?: number;
    pairedTStat?: number;
    pairedN?: number;
    candidateMaxDrawdownPct?: number;
    baselineMaxDrawdownPct?: number;
    /** P2-7 provenance: fold shape so an apply can be reproduced/audited. */
    trainDates?: number;
    trainObservations?: number;
    testObservations?: number;
  };
  /** The autonomous thresholds in effect. */
  thresholds?: ReturnType<typeof autonomousOosThresholds>;
  /** The changed factor keys the proposal named. */
  changedFactors?: string[];
  /** Underlying proposal metadata for the audit trail. */
  confidenceScore?: number;
  generatedBy?: StrategyTuningProposal["generatedBy"];
  cautions?: string[];
}

/**
 * STRICTER-than-manual autonomous OOS thresholds (panel B1). The manual gate (`applyOosGate`) only checks
 * `candidateIC > baselineIC` with no margin/significance — fine for a human-reviewed suggestion, but too
 * weak to auto-apply. For the AUTONOMOUS path we additionally require: a minimum IC-delta MARGIN over the
 * baseline (not a razor-thin edge), a POSITIVE absolute candidate IC, a minimum ICIR (signal stability),
 * and a minimum test-date count. All env-tunable for operators who want to loosen/tighten.
 */
export function autonomousOosThresholds(
  tuning?: TradingPolicy["tuning"]
): { minICDelta: number; minCandidateIC: number; minICIR: number; minTestDates: number; minPairedTStat: number } {
  const num = (name: string, dflt: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  // Panel P0-2: the policy-level `minOosICImprovement` (default 0) raises the IC-delta MARGIN above the env
  // floor; `minOosPairedTStat` (default 0 = no-op) adds a proper paired-t significance requirement on the
  // per-date IC-difference series. Both default to preserving current behavior.
  const envMargin = num("AUTO_TUNE_MIN_IC_DELTA", 0.005);
  const policyMargin = typeof tuning?.minOosICImprovement === "number" && tuning.minOosICImprovement >= 0
    ? tuning.minOosICImprovement
    : 0;
  const minPairedTStat = typeof tuning?.minOosPairedTStat === "number" && tuning.minOosPairedTStat >= 0
    ? tuning.minOosPairedTStat
    : 0;
  return {
    minICDelta: Math.max(envMargin, policyMargin),
    minCandidateIC: num("AUTO_TUNE_MIN_CANDIDATE_IC", 0.0),
    minICIR: num("AUTO_TUNE_MIN_ICIR", 0.2),
    minTestDates: num("AUTO_TUNE_MIN_TEST_DATES", 4),
    minPairedTStat
  };
}

/**
 * Item 1 (panel-hardened): cadence-gated AUTONOMOUS application of the auto-tuner's factor-weight changes.
 *
 * DEFAULT OFF (`policy.tuning.autoApplyWeights`): a no-op returning `{ applied: false, reason }`, so default
 * behavior is byte-identical. When on:
 *   1. runs `proposeStrategyTuning` (already clamps every delta to MAX_WEIGHT_STEP and runs the manual OOS
 *      gate, stripping weights that don't beat baseline / can't be validated);
 *   2. WRITE-SCOPE SAFETY: builds the delta from `proposedPatch.scoringWeights` ONLY — the patch's `policy`
 *      sub-patch (maxDailyNotional, strategyAuthority, riskRules, sectorCaps) and free-text `prompt` are
 *      NEVER auto-applied, so an autonomous run can't loosen a risk cap or set strategyAuthority='decide';
 *   3. re-validates the merged candidate against a STRICTER autonomous OOS gate (min IC-delta margin,
 *      candidateIC>0, ICIR floor, min test-dates). A null OOS run (<4 dates) is a HARD no-apply regardless
 *      of `oosWithholdUnvalidated`;
 *   4. re-asserts the MAX_WEIGHT_STEP clamp on the POST-normalization vector (normalizeScoringWeights
 *      re-normalizes after merge, so a pre-normalization clamp can drift past ±step);
 *   5. persists ONLY via `setPolicy` (so mirrorPolicyToActiveAccount syncs account_strategy_state + the
 *      active-profile mirror) and writes an `auto_weight_apply` audit row carrying the PRIOR vector for revert.
 */
/**
 * Panel P1-1: SHARED, SIDE-EFFECT-FREE evaluator for the autonomous weight-tuning decision. Runs the full
 * gate path — propose → write-scope-strip → clamp → STRICTER autonomous OOS re-validation (margin, paired-t,
 * ICIR floor, test-date floor P2-6, optional drawdown guard P2-5) — and returns exactly what a real apply
 * WOULD do, performing ZERO writes. Both the real apply and the read-only dry-run consume this. The invariant
 * guard is NOT run here (it decides whether to enter the autonomous path at all and emits an audit row on
 * violation); callers run it before consuming a decision when they intend to persist.
 */
async function evaluateAutonomousWeightTuning(userId: string, modelOverride?: string): Promise<AutonomousWeightDecision> {
  const policy = getPolicy(userId);
  const proposal = await proposeStrategyTuning(userId, modelOverride);
  // WRITE-SCOPE SAFETY (panel B1): scoringWeights ONLY — never the patch's policy/prompt sub-fields.
  const proposedWeights = proposal.proposedPatch.scoringWeights;
  const proposalMeta = { confidenceScore: proposal.confidenceScore, generatedBy: proposal.generatedBy, cautions: proposal.cautions };
  if (!proposedWeights || Object.keys(proposedWeights).length === 0) {
    return { wouldApply: false, reason: "no_validated_weight_changes", ...proposalMeta };
  }

  const previousWeights = normalizeScoringWeights({ ...policy.scoringWeights });
  const mergedCandidate = normalizeScoringWeights({ ...policy.scoringWeights, ...proposedWeights });
  // Re-assert the per-factor step clamp AFTER normalization: normalizeScoringWeights re-scales the whole
  // vector, so a delta clamped to ±step pre-normalization can end up past ±step. Clamp each factor to
  // [prev-step, prev+step] and re-normalize once more so the candidate vector is both clamped and valid.
  const clampedToPrev: Partial<ScoringWeights> = {};
  for (const key of Object.keys(mergedCandidate) as (keyof ScoringWeights)[]) {
    const prev = previousWeights[key];
    clampedToPrev[key] = round(clamp(mergedCandidate[key], prev - MAX_WEIGHT_STEP, prev + MAX_WEIGHT_STEP));
  }
  const newWeights = normalizeScoringWeights(clampedToPrev);
  const changedFactors = Object.keys(proposedWeights);
  const clampedDeltas: Partial<Record<keyof ScoringWeights, number>> = {};
  for (const key of changedFactors as (keyof ScoringWeights)[]) {
    clampedDeltas[key] = round(newWeights[key] - previousWeights[key]);
  }
  const base: AutonomousWeightDecision = { wouldApply: false, before: previousWeights, after: newWeights, clampedDeltas, changedFactors, ...proposalMeta };

  // STRICTER autonomous OOS re-validation on the ACTUAL vector we would persist. Thresholds are policy-driven
  // (P0-2: minOosICImprovement raises the margin, minOosPairedTStat adds a paired-t significance gate). P1-2:
  // the purged-&-embargoed split + P2-4 IC-weight shrinkage are opt-in, default-off pass-throughs.
  const th = autonomousOosThresholds(policy.tuning);
  let oos;
  try {
    oos = await runWalkForwardOOS(userId, {
      candidateWeights: newWeights,
      baselineWeights: previousWeights,
      purgeEmbargo: policy.tuning?.oosPurgeEmbargo ?? false,
      icWeightShrinkage: policy.tuning?.icWeightShrinkage ?? 0
    });
  } catch {
    return { ...base, reason: "oos_fetch_failed" };
  }
  if (!oos) return { ...base, reason: "oos_insufficient_history" }; // <4 dates → HARD no-apply
  const candidateIC = oos.oosICCandidate;
  const baselineIC = oos.oosICBaseline;
  if (candidateIC == null || baselineIC == null) return { ...base, reason: "oos_no_composite_ic" };
  // P0-2 PAIRED SIGNIFICANCE: the two composite ICs are measured on the SAME test fold and are correlated, so
  // the difference's SE must come from the PAIRED per-date IC-difference series (oos.pairedICDiff). Default 0.
  const pairedT = oos.pairedICDiff?.tStat ?? 0;
  const pairedN = oos.pairedICDiff?.n ?? 0;
  const passesPairedT = th.minPairedTStat <= 0 || (pairedN >= 2 && pairedT >= th.minPairedTStat);
  // P2-6 STARVATION GUARD: raise the distinct-test-date floor above the env default when the policy asks.
  const minTestDates = Math.max(th.minTestDates, policy.tuning?.minOosTestDates ?? 0);
  const oosReadout = {
    icDelta: candidateIC - baselineIC,
    icir: oos.oosICIR,
    testDates: oos.testDates,
    pairedTStat: pairedT,
    pairedN,
    candidateMaxDrawdownPct: oos.candidateMaxDrawdownPct,
    baselineMaxDrawdownPct: oos.baselineMaxDrawdownPct,
    // P2-7 provenance: fold shape (distinct dates + observation counts) so an apply is reproducible/auditable.
    trainDates: oos.trainDates,
    trainObservations: oos.trainObservations,
    testObservations: oos.testObservations
  };
  const withOos: AutonomousWeightDecision = { ...base, oosICCandidate: candidateIC, oosICBaseline: baselineIC, oosReadout, thresholds: th };

  const passesAutonomousGate =
    candidateIC - baselineIC >= th.minICDelta &&
    candidateIC > th.minCandidateIC &&
    oos.oosICIR >= th.minICIR &&
    oos.testDates >= minTestDates &&
    passesPairedT;
  if (!passesAutonomousGate) {
    return {
      ...withOos,
      reason: `autonomous_oos_gate_failed (ΔIC=${(candidateIC - baselineIC).toFixed(4)}, IC=${candidateIC.toFixed(4)}, ICIR=${oos.oosICIR.toFixed(2)}, testDates=${oos.testDates}/${minTestDates}, pairedT=${pairedT.toFixed(2)}, pairedN=${pairedN})`
    };
  }

  // P2-5 DRAWDOWN GUARD (opt-in): refuse a candidate whose OOS max-drawdown exceeds the baseline's beyond a
  // small tolerance — but only when the fold is deep enough (below the floor the IC/paired-t gate governs).
  if (policy.tuning?.autoApplyDrawdownGuard && oos.testDates >= Math.max(minTestDates, AUTO_TUNE_DRAWDOWN_GUARD_MIN_TEST_DATES)) {
    const candDd = oos.candidateMaxDrawdownPct;
    const baseDd = oos.baselineMaxDrawdownPct;
    if (typeof candDd === "number" && typeof baseDd === "number" && candDd > baseDd + AUTO_TUNE_DRAWDOWN_TOLERANCE_PCT) {
      return {
        ...withOos,
        reason: `autonomous_drawdown_guard_failed (candidateDD=${candDd.toFixed(2)}% > baselineDD=${baseDd.toFixed(2)}% + ${AUTO_TUNE_DRAWDOWN_TOLERANCE_PCT}%)`
      };
    }
  }

  return { ...withOos, wouldApply: true };
}

/** P2-5 drawdown-guard constants. Tolerance in drawdown percentage points; min fold depth for the guard. */
const AUTO_TUNE_DRAWDOWN_TOLERANCE_PCT = 2;
const AUTO_TUNE_DRAWDOWN_GUARD_MIN_TEST_DATES = 8;

/**
 * Item 1 (panel-hardened): cadence-gated AUTONOMOUS application of the auto-tuner's factor-weight changes.
 *
 * DEFAULT OFF (`policy.tuning.autoApplyWeights`): a no-op returning `{ applied: false, reason }`, so default
 * behavior is byte-identical. When on it runs the shared gate evaluator (write-scope-strip → clamp →
 * stricter OOS + paired-t + P2-5/P2-6 guards) and, only if `wouldApply`, persists via `setPolicy` ONLY and
 * records the P0-4 unified ledger row + legacy `auto_weight_apply` audit row.
 *
 * P1-3 SHADOW: when `policy.tuning.shadowWeightLedger` is on and NO real apply fired this evaluation, records
 * a passive shadow ledger row (subsystem `scoring_weights`, trigger `auto_weight_shadow`) capturing what the
 * tuner WOULD have applied + the OOS readout — never touching policy — so an operator can forward-validate
 * the tuner's decisions before trusting autonomy.
 */
export async function applyAutonomousWeightTuning(userId: string = "local", modelOverride?: string): Promise<AutonomousWeightApplyResult> {
  const policy = getPolicy(userId);
  const shadowEnabled = policy.tuning?.shadowWeightLedger ?? false;

  // The invariant guard and the autoApplyWeights flag decide whether a REAL apply may run. The SHADOW ledger
  // (P1-3) is independent — it may record what WOULD happen even when auto-apply is off — so evaluate the
  // decision first when either path is active.
  const autoApplyOn = policy.tuning?.autoApplyWeights ?? false;
  if (!autoApplyOn && !shadowEnabled) return { applied: false, reason: "autoApplyWeights_off" };

  // P0-3 FAIL-CLOSED CONFIG GUARD (real-apply path only): validate the tuning invariants at the TOP. On any
  // violation, SKIP the apply and write an audited "skipped: invariant violation" row — never throw (a throw
  // would wedge the scheduler tick). The shadow path is diagnostic-only and does not persist, so it is not
  // blocked by the guard (a shadow row on a mis-configured account is still useful evidence).
  if (autoApplyOn) {
    const invariants = validateTuningInvariants(policy.tuning);
    if (!invariants.ok) {
      audit("auto_weight_apply_skipped", {
        userId,
        connectedAccountId: policy.connectedAccountId,
        reason: "invariant_violation",
        violations: invariants.violations
      }, userId, policy.connectedAccountId);
      // Still allow a shadow row (below) to capture the would-be decision for the operator.
      if (!shadowEnabled) {
        return { applied: false, reason: `invariant_violation (${invariants.violations.map((v) => v.code).join(",")})` };
      }
    }
  }

  const decision = await evaluateAutonomousWeightTuning(userId, modelOverride);

  // Real apply: only when auto-apply is on AND the invariant guard passed AND the gate says wouldApply.
  const invariantsOk = autoApplyOn ? validateTuningInvariants(policy.tuning).ok : false;
  if (autoApplyOn && invariantsOk && decision.wouldApply && decision.after) {
    const newWeights = decision.after;
    // P0-4: capture `before` ATOMICALLY — re-read effective policy immediately before the setPolicy write so a
    // concurrent multi-agent weight write doesn't cause a stale baseline to be recorded/reverted-to.
    const beforePolicy = getPolicy(userId, policy.connectedAccountId);
    const beforeWeights = normalizeScoringWeights({ ...beforePolicy.scoringWeights });
    setPolicy({ ...beforePolicy, scoringWeights: newWeights }, userId, policy.connectedAccountId);

    const evidence = {
      candidateIC: decision.oosICCandidate,
      baselineIC: decision.oosICBaseline,
      icDelta: decision.oosReadout?.icDelta,
      icir: decision.oosReadout?.icir,
      testDates: decision.oosReadout?.testDates,
      pairedTStat: decision.oosReadout?.pairedTStat,
      pairedN: decision.oosReadout?.pairedN,
      candidateMaxDrawdownPct: decision.oosReadout?.candidateMaxDrawdownPct,
      baselineMaxDrawdownPct: decision.oosReadout?.baselineMaxDrawdownPct,
      thresholds: decision.thresholds,
      changedFactors: decision.changedFactors,
      confidenceScore: decision.confidenceScore,
      generatedBy: decision.generatedBy,
      cautions: decision.cautions
    };

    // P0-4: record ONE canonical ledger row (before/after full vectors, subsystem, trigger, evidence, flag).
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      connectedAccountId: policy.connectedAccountId,
      trigger: AUTO_WEIGHT_APPLY_AUDIT_KIND,
      flag: "autoApplyWeights",
      before: { scoringWeights: beforeWeights },
      after: { scoringWeights: newWeights },
      evidence
    });

    // Keep the existing audit row for backward-compat (dashboard + prior tests read `auto_weight_apply`); the
    // unified ledger is now the source of truth for revert.
    audit(AUTO_WEIGHT_APPLY_AUDIT_KIND, {
      userId,
      connectedAccountId: policy.connectedAccountId,
      previousWeights: beforeWeights,
      newWeights,
      changedFactors: decision.changedFactors,
      oos: {
        candidateIC: decision.oosICCandidate,
        baselineIC: decision.oosICBaseline,
        icDelta: decision.oosReadout?.icDelta,
        icir: decision.oosReadout?.icir,
        testDates: decision.oosReadout?.testDates,
        pairedTStat: decision.oosReadout?.pairedTStat,
        pairedN: decision.oosReadout?.pairedN
      },
      thresholds: decision.thresholds,
      confidenceScore: decision.confidenceScore,
      generatedBy: decision.generatedBy,
      cautions: decision.cautions
    }, userId);

    // P2-7 REPRODUCIBILITY / DECISION-PROVENANCE: runWalkForwardOOS is IO + time-dependent, so a later re-run
    // can't reproduce the fold that justified this apply. Record the fold shape, ICs, ICIR, margin/thresholds,
    // and the flags in effect so an operator can audit exactly what evidence authorized the mutation.
    audit(TUNING_APPLY_PROVENANCE_AUDIT_KIND, {
      userId,
      connectedAccountId: policy.connectedAccountId,
      trainObservations: decision.oosReadout?.trainObservations,
      testObservations: decision.oosReadout?.testObservations,
      trainDates: decision.oosReadout?.trainDates,
      testDates: decision.oosReadout?.testDates,
      candidateIC: decision.oosICCandidate,
      baselineIC: decision.oosICBaseline,
      icir: decision.oosReadout?.icir,
      icDelta: decision.oosReadout?.icDelta,
      pairedTStat: decision.oosReadout?.pairedTStat,
      pairedN: decision.oosReadout?.pairedN,
      candidateMaxDrawdownPct: decision.oosReadout?.candidateMaxDrawdownPct,
      baselineMaxDrawdownPct: decision.oosReadout?.baselineMaxDrawdownPct,
      thresholds: decision.thresholds,
      changedFactors: decision.changedFactors,
      // The flags whose settings shaped this decision (for reproducibility of the config, not just the data).
      flagsInEffect: {
        autoApplyWeights: policy.tuning?.autoApplyWeights ?? false,
        oosPurgeEmbargo: policy.tuning?.oosPurgeEmbargo ?? false,
        icWeightShrinkage: policy.tuning?.icWeightShrinkage ?? 0,
        autoApplyDrawdownGuard: policy.tuning?.autoApplyDrawdownGuard ?? false,
        minOosTestDates: policy.tuning?.minOosTestDates ?? 0,
        minOosICImprovement: policy.tuning?.minOosICImprovement ?? 0,
        minOosPairedTStat: policy.tuning?.minOosPairedTStat ?? 0
      }
    }, userId, policy.connectedAccountId);

    return { applied: true, previousWeights: beforeWeights, newWeights, cautions: decision.cautions };
  }

  // P1-3 SHADOW LEDGER: no real apply fired — record what the tuner WOULD have done (when the flag is on and a
  // candidate vector was actually built). Passive: it writes ONLY a shadow ledger row (a distinct trigger), so
  // no revert path will restore it and it never mutates policy.
  if (shadowEnabled && decision.after && decision.before) {
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      connectedAccountId: policy.connectedAccountId,
      trigger: AUTO_WEIGHT_SHADOW_TRIGGER,
      flag: "shadowWeightLedger",
      before: { scoringWeights: decision.before, shadow: true },
      after: { scoringWeights: decision.after, shadow: true },
      evidence: {
        shadow: true,
        wouldApply: decision.wouldApply,
        reason: decision.reason,
        candidateIC: decision.oosICCandidate,
        baselineIC: decision.oosICBaseline,
        oosReadout: decision.oosReadout,
        thresholds: decision.thresholds,
        changedFactors: decision.changedFactors,
        confidenceScore: decision.confidenceScore,
        generatedBy: decision.generatedBy
      }
    });
  }

  return { applied: false, reason: decision.reason ?? (autoApplyOn ? "no_validated_weight_changes" : "autoApplyWeights_off"), cautions: decision.cautions };
}

/**
 * Panel P1-1: READ-ONLY deterministic dry-run/replay of the autonomous decision. Runs the SAME shared gate
 * evaluator as `applyAutonomousWeightTuning` and returns exactly what an apply WOULD do — `{ before, after,
 * clampedDeltas, oosICCandidate, oosICBaseline, oosReadout, wouldApply }` — with ZERO writes (no `setPolicy`,
 * no ledger row, no audit, no cadence-key advance). It ignores the `autoApplyWeights` flag entirely (an
 * operator can inspect the decision before enabling autonomy) but surfaces any invariant violations so the
 * operator sees a config that WOULD block a real apply.
 */
export async function dryRunAutonomousWeightTuning(userId: string = "local", modelOverride?: string): Promise<AutonomousWeightDecision & { invariantViolations?: ReturnType<typeof validateTuningInvariants>["violations"] }> {
  const policy = getPolicy(userId);
  const invariants = validateTuningInvariants(policy.tuning);
  const decision = await evaluateAutonomousWeightTuning(userId, modelOverride);
  return invariants.ok ? decision : { ...decision, invariantViolations: invariants.violations };
}

export interface AutonomousWeightRevertResult {
  reverted: boolean;
  reason?: string;
  restoredWeights?: ScoringWeights;
}

/**
 * Item 1 (P0-4-unified): revert the most recent autonomous weight application. Prefers the UNIFIED learning-
 * mutation ledger (`revertLearningMutation`, subsystem `scoring_weights`) so there is ONE revert path that
 * restores via `setPolicy` (keeping account_strategy_state + the active-profile mirror in sync). For pre-
 * ledger applies (only the legacy `auto_weight_apply` audit row exists), falls back to that snapshot. Returns
 * `{ reverted: false }` when nothing is revertible. Writes an `auto_weight_revert` audit row for traceability.
 */
export function revertAutonomousWeightTuning(userId: string = "local"): AutonomousWeightRevertResult {
  const policy = getPolicy(userId);

  // Preferred path: the unified ledger (the source of truth for applies made after P0-4 landed).
  const ledgerResult = revertLearningMutation({
    subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
    userId,
    connectedAccountId: policy.connectedAccountId,
    revertedBy: "revertAutonomousWeightTuning"
  });
  if (ledgerResult.reverted && ledgerResult.restoredWeights) {
    audit("auto_weight_revert", { userId, connectedAccountId: policy.connectedAccountId, restoredWeights: ledgerResult.restoredWeights, via: "ledger", entryId: ledgerResult.entryId }, userId);
    return { reverted: true, restoredWeights: ledgerResult.restoredWeights };
  }

  // Back-compat fallback: ONLY for a genuine PRE-LEDGER apply — i.e. NO learning-mutation ledger row exists
  // for this (user, account, scoring_weights) at all. If a ledger row DOES exist (even one already reverted),
  // the ledger is authoritative and the legacy `auto_weight_apply` audit snapshot is STALE — using it on a
  // 2nd revert would restore old previousWeights and clobber any manual weight change made since (finding #2).
  const anyLedgerRow = listLearningMutations(userId, {
    connectedAccountId: policy.connectedAccountId,
    subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
    limit: 1
  }).length > 0;
  if (anyLedgerRow) {
    return { reverted: false, reason: "no_unreverted_ledger_mutation" };
  }

  const last = (policy.connectedAccountId
    ? latestAuditByKind(AUTO_WEIGHT_APPLY_AUDIT_KIND, userId, policy.connectedAccountId)
    : latestAuditByKind(AUTO_WEIGHT_APPLY_AUDIT_KIND, userId))?.payload as { previousWeights?: Partial<ScoringWeights> } | undefined;
  if (!last?.previousWeights || Object.keys(last.previousWeights).length === 0) {
    return { reverted: false, reason: "no_prior_snapshot" };
  }
  const restoredWeights = normalizeScoringWeights({ ...policy.scoringWeights, ...last.previousWeights });
  setPolicy({ ...policy, scoringWeights: restoredWeights }, userId, policy.connectedAccountId);
  audit("auto_weight_revert", { userId, connectedAccountId: policy.connectedAccountId, restoredWeights, via: "legacy_audit" }, userId);
  return { reverted: true, restoredWeights };
}
