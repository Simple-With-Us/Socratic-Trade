export * from "./strategy-execution";
export * from "./strategy-risk";

import {
  acquireStrategyLock,
  audit,
  claimProposalForExecution,
  countDayTradesInLastBusinessDays,
  dailyExecutionStats,
  finishStrategyRun,
  getConnectedAccount,
  getPolicy,
  getProposal,
  getStrategyPrompt,
  ingestedAccessionCountsByDocType,
  insertProposal,
  insertStrategyRun,
  listPendingBrokerReconciliationFills,
  listStalePlacingProposals,
  listFillEvents,
  listFillEventsByProposalId,
  resolveBrokerVerificationNotifications,
  notionalInLastMinutes,
  releaseStrategyLock,
  setPolicy,
  transitionProposalIfPending,
  upsertSocraticDecisionCase,
  createSocraticFrameworkProposal,
  updatePendingProposalReprice,
  updateProposalStatus,
  updateFillEvent
} from "./db";
import { accountEquity, recordAndEvaluateDrawdownBreaker } from "./risk-breaker";
import { mergeQuoteData, pricePosition52w, scanMarket } from "./market";
import { deriveMetrics } from "./derived-metrics";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMarketInternals } from "./market-internals";
import { getMarketSignals } from "./market-signals";
import { fetchMacroData, fetchMacroDataWithLiveVix, pruneMacro, determineMarketRegime, evaluateVolatilityBrake, type MacroData } from "./macro";
import { buildCandidateEvidence } from "./evidence";
import { deriveExecutionState, fillSourceForExecutionMode, llmExecutionMode, llmModeClarification, type ExecutionAccount } from "./execution-mode";
import { checkBrokerHealth } from "./broker-health";
import { interactiveStrategyReasoningEffort, isRetryableLlmError, isRetryableLlmStatus, LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS, LLM_TIMEOUT_MS, llmFetch, llmFetchCapturing, resolveLlmWireOutputCap, strategyLlmTimeoutMs, type LlmCallOutcome } from "./llm-request";
import { buildBullSystem, STRATEGY_PROMPT_VERSION, THESIS_PLAYBOOK } from "./strategy-prompts";
import { resolveLlmEndpoint } from "./llm-provider";
import { resolveModelRotationForRun } from "./model-rotation";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText, extractJsonPayload, detectLlmTruncation } from "./llm-call";
import { humanizeLlmError, humanizeLlmTransportError } from "./llm-errors";
import { LlmCredentialRequiredError, LLM_MODEL_REQUIRED_STRATEGY_MESSAGE, LLM_REQUIRED_STRATEGY_MESSAGE } from "./llm-required";
import { materializeSkippedCandidateCounterfactuals, recordRejectedProposalCounterfactual } from "./counterfactual-learning";
import { dynamicIndexUniversesForPolicy } from "./index-universes";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { notify } from "./notify";
import { planFundingSells } from "./sell-to-fund";
import { isRejectedOrCanceledState } from "./broker-side";
import {
  calibratedConviction,
  getClosedLotCount,
  getConfidenceCalibration,
  type ConfidenceCalibrationStat,
  type PrefetchedFills,
  getFactorScorecard,
  getRegimeScorecard,
  getSectorScorecard,
  getSignalEfficacy,
  getSkippedCandidateReturns,
  getThesisRegimeScorecard,
  getThesisScorecard,
  MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT,
  recordFillFromProposal,
  recordPortfolioSnapshot
} from "./performance";
import { applyMissedOpportunityNudge, summarizeMissedOpportunities } from "./strategy-tuning";
import { fractionalKellySuggestion } from "./kelly";
import { resolveCongressGateMultiplier } from "./congress-score-gate";
import type { ThesisStat, ThesisRegimeStat } from "./performance";
import type { SituationCandidate } from "./experience-memory";
import { allowedSymbolsForPolicy, applyOpeningOrderHeadroom, betaScaledStopPct, estimateNotional, evaluateTradeProposal, isIraTaxRegime } from "./policy";
import { assessProtectiveExitRepriceDrift, extendedHoursExitBufferBps, marketableLimitExitPrice, repriceStoredProtectiveExit } from "./protective-exit-routing";
import type { ProtectiveExitQuote } from "./protective-exit-routing";
import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { atr, atrStopPct } from "./indicators";
import { computePortfolioHeat, positionRiskUsd, realizedVolPct, volTargetScale, type PortfolioHeatResult } from "./vol-targeting";
import { fetchDailyOHLC } from "./history";
import { expireStalePendingProposals, revalidatePendingProposals } from "./proposal-revalidation";
import { getTaxSummary, getUserWashSaleLockProvenance } from "./tax";
import { getBrokerGateway } from "./broker";
import { describeBrokerMinimumOrderBlock, planBrokerMinimumBump, shouldAlertBrokerMinimumOrderBlock } from "./broker-minimum-guard";
import { brokerHeldExitBlockReason, evaluateBrokerHeldExitAvailability } from "./broker-held-orders";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { checkBudgetAndAlert, evaluateBudgetForRun, formatBudgetAdvisory, getBudgetStatusCached, notifyBudgetSkip, previewBudgetDecision, usageBudgetEnforceEnabled } from "./usage-budget";
import { avgReturnCorrelation, correlationProfile } from "./correlation";
import { stressScenario, type StressPositionInput } from "./stress-scenario";
import { assertLivePreflight } from "./preflight-live-guard";
import { startStrategyLockGuard, StrategyLockOwnershipLostError } from "./strategy-lock-guard";
import { checkLlmDailyBudget, checkMonthlyLlmSpendCeiling, releaseLlmReservation, reserveLlmRunBudget } from "./llm-budget";
// (STRATEGY_PROMPT_VERSION comes with the prompt builders from ./strategy-prompts above —
// ./strategy-prompt-version is a thin re-export kept for red-team.ts's cycle-free import.)
import type { BrokerGateway } from "./types";
import { generateReflectionSummary, getReflectionSummary } from "./post-mortem";
import { emitDashboardEvent } from "./events";
import { getInternalSetting, setInternalSetting } from "./db";
import { clearStopPlans, clearTakeProfitTrimBands, filterStopPlansByLiveBasis, getStopPlans, getTakeProfitTrimBands, recordStopPlan } from "./db";
import type { TakeProfitTrimBand } from "./db";
import { recordLlmUsage, extractLlmUsage } from "./llm-usage";
import { withLlmGeneration, recordDecisionObservation } from "./observability";
import { retrieveLearnedContextDetailed } from "./learned-context/store";
import {
  collectEvidenceAgeAnomalies,
  computeEmptyDocTypes,
  scanForInjectionAttempts,
  type EvidenceAgeInput,
  type InjectionFinding,
  type UntrustedPromptField
} from "./prompt-safety";
import { debateProposal, type RedTeamDebateResult, type RedTeamReviewContext } from "./red-team";
import { describeRedTeamFailureKind, routeOnAdversaryUnavailable } from "./red-team-routing";
import { isEscalationRegime } from "./regime-watch";
import { isRiskOffFilterRegime, regimeFromLabel, classifyMarketRegime } from "./market-regime";
import { computeMultiSignalSeverity } from "./regime-severity";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText, summarizeTradeProposals } from "./telemetry-sanitize";
import {
  applySocraticOverrideSizing,
  buildSocraticDecisionCase,
  frameworkProposalFromDecision,
  ragAttributionsFromChunks,
  resolveSocraticOverride,
  socraticStatusFromProposalStatus,
  type SocraticOverrideResolution
} from "./socratic-runtime";
import { indexSocraticDecisionMemory } from "./socratic-memory";
import type { ApprovedEscalation, EquityOrder, EquityPosition, ExecutionMode, FillEvent, FillSource, MarketFactorBreakdown, MarketQuote, MarketQuoteSummary, MarketScan, OrderSide, PolicyDecision, Portfolio, RationaleDiversity, ReviewedOrder, ScoringWeights, SocraticDecisionCase, SocraticEvidenceItem, SocraticRagAttribution, TradingPolicy, TradeProposal, StopPlanStyle } from "./types";
import type { PositionStopPlan } from "./db-api-keys";
import { STOP_PLAN_FALLBACK_STOP_PCT, STOP_PLAN_STYLES } from "./types";
import { computeRationaleDiversity } from "./rationale-diversity";
import { isMarketOpen } from "./market-calendar";
import { isTradingDay } from "./market-calendar";
import { reconcilePendingFills, flagStalePlacingIntents, reconcilePlacementError, LiveApprovalConfirmation, LiveApprovalConfirmationError, coerceProtectiveExitToMarket } from "./strategy-execution";
import { shouldSkipNegativeExpectancy, applyDeterministicSizing, isRiskAddingOpening, applyRedTeamHalfSize, applyEarningsBlackoutTag, applyCorrelationClusterGate, applyRiskReceipts, shouldEscalateDecision, allowedProposalSides, deterministicBearFilter, mapWithConcurrency } from "./strategy-risk";

/**
 * How many top-ranked-but-skipped candidates to persist with full evidence each run.
 * `scanMarket` already caps the scored universe by the user's policy, so this
 * covers the most relevant skipped set while bounding audit-row growth. This log
 * is for learning only (never sent to the LLM), so size affects storage, not tokens.
 */
const MAX_SKIPPED_EVIDENCE = 25;

/**
 * corpus-coverage-receipt (2026-07-06, redesigned same day — see
 * docs/rollouts/2026-07-06-corpus-coverage-receipt.md for the full history): doc types the
 * empty-corpus receipt (below, near `computeEmptyDocTypes`) checks. Deliberately a STATIC
 * allowlist restricted to types whose PRODUCER LEDGER (`ingested_accessions`, via
 * `ingestedAccessionCountsByDocType`) is COMPLETE — i.e. every writer for that type records an
 * accession row, so "zero ingested rows" reliably means "never produced," not "this writer just
 * doesn't track accessions."
 *   - "10-k" / "10-q": src/lib/web-sources/sec-filings.ts's `ingestFiling` (always on) writes an
 *     `ingested_accessions` row for every 10-K/10-Q ingest, stored as the raw form letter
 *     ("10-K"/"10-Q"). Complete ledger — safe to both-conditions-check.
 *
 * "8-k" is EXCLUDED here (though it stays in `requestedFilingsDocTypes` below — harmless,
 * retrieval-only): the default-ON 8-K SUMMARY writer (src/lib/web-sources/sec8k.ts,
 * `refreshEightK`'s `storeContexts` call, `doc_type: "8-k"`) writes retrievable chunks to the
 * vector corpus but NEVER calls `insertIngestedAccession` — only the default-OFF full-body writer
 * (`ingestEightKBody`, under the "8-K-body" sentinel) does. So the ledger cannot distinguish "this
 * account has no 8-K coverage at all" from "8-K summaries exist in the corpus but none ranked this
 * run" — treating a zero producer-count as "never produced" would be wrong, and 8-K is
 * event-sparse enough (frequently won't rank top-3) that a retrieval-only check would false-positive
 * on a large fraction of normal runs. Re-add "8-k" here the day an accurate per-doc_type 8-K corpus
 * signal exists (e.g. a `document_chunks.doc_type` column populated by both writers).
 *
 * "earnings-transcript" also stays EXCLUDED (same as before): no ingestion writer exists anywhere
 * in this repo for it, so it is a genuine, permanent zero-producer — including it would fire a
 * receipt on every single run forever, training the operator to ignore the whole receipt. Re-add
 * it the day a producer lands.
 */
const COVERAGE_CHECKED_DOC_TYPES = ["10-k", "10-q"];

// STRATEGY_PROMPT_VERSION is imported at the top and re-exported here so existing consumers/tests
// can still `import { STRATEGY_PROMPT_VERSION } from "./strategy"`; it lives in its own tiny module
// so red-team.ts can import it too without a circular dep.
export { STRATEGY_PROMPT_VERSION };
type RunnablePolicy = TradingPolicy & { accountNumber: string };

export interface StrategyLlmStep {
  step: "bull" | "bear";
  label: string;
  provider: string;
  model: string;
  transport: string;
  keySource: "operator" | "user";
  status: "started" | "completed" | "skipped" | "fallback" | "failed";
  proposalCount?: number;
  reason?: string;
}

export interface StrategyResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: MarketScan;
  accountNumber?: string | null;
  llmSteps?: StrategyLlmStep[];
  /** Advisory only — rationale-diversity check result (improvement-program item #8). Never affects proposal generation or selection. */
  rationaleDiversity?: RationaleDiversity;
}

class StrategyLlmStepFailure extends Error {
  llmSteps: StrategyLlmStep[];

  constructor(message: string, llmSteps: StrategyLlmStep[], cause: unknown) {
    super(message);
    this.name = "StrategyLlmStepFailure";
    this.llmSteps = llmSteps;
    this.cause = cause;
  }
}

export function liveApprovalText(symbol: string): string {
  return `APPROVE LIVE ${normalizeSymbol(symbol)}`;
}

export function liveBatchApprovalText(count: number): string {
  return `APPROVE ${count} LIVE ${count === 1 ? "ORDER" : "ORDERS"}`;
}

/**
 * Item 3 (opt-in): return the scan-scoring weights for THIS run, applying a small clamped nudge for a
 * factor that keeps showing up among matured missed winners. Transient — the nudge affects only this run's
 * scoring, never the persisted policy weights (that's the item-1 autonomous-apply path). Returns
 * `policy.scoringWeights` UNCHANGED (byte-identical) when the flag is off, no account is configured, or the
 * closed-lot sample gate isn't met. Emits a `missed_opportunity_nudge` audit row when a nudge is applied.
 */
function resolveScanScoringWeights(policy: TradingPolicy, source: FillSource, runId: string, userId: string): ScoringWeights {
  if (!policy.tuning?.missedOpportunityNudge || !policy.accountNumber) return policy.scoringWeights;
  const minLots = policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
  const closedLotCount = getClosedLotCount(policy.accountNumber, source, userId);
  if (closedLotCount < minLots) return policy.scoringWeights;

  const benchmarkRelative = policy.tuning?.benchmarkRelativeMisses ?? false;
  const minRecurringCount = policy.tuning?.recurringFactorMinCount ?? (benchmarkRelative ? 5 : 2);
  // Realized rows only (empty price map) — no live quotes needed here. Benchmark-relative annotation is
  // deliberately skipped in this hot path (it would add a SPY fetch to every run); when the operator opts
  // into benchmarkRelativeMisses without SPY data present the recurring-factor gate simply won't fire,
  // which is the safe direction (no nudge rather than an unvalidated one).
  const summary = summarizeMissedOpportunities(
    getSkippedCandidateReturns({}, userId, { limit: 12, maxAgeDays: 30, connectedAccountId: policy.connectedAccountId }),
    { limit: 8, benchmarkRelative, minRecurringCount }
  );
  if (!summary.recurringFactor) return policy.scoringWeights;

  const nudge = applyMissedOpportunityNudge(policy.scoringWeights, summary);
  if (!nudge.nudgedFactor) return policy.scoringWeights;
  audit("missed_opportunity_nudge", {
    runId,
    userId,
    factor: nudge.nudgedFactor,
    delta: nudge.delta,
    recurringFactorCount: summary.recurringFactorCount,
    closedLotCount,
    benchmarkRelative,
    note: nudge.note
  }, userId, policy.connectedAccountId);
  return nudge.weights;
}

/**
 * Whether a debated OPENING should count toward the sell-to-fund intended-notional. A pre-veto-tagged
 * opening (deterministic-bear / red-team veto, now tag-not-drop) is BLOCKED downstream unless the agent
 * self-overrides it — which only AUTO-EXECUTES in "execute" mode with a requested override thesis
 * ("propose" routes it to requiresHumanReview and is excluded there; "off" / no-thesis stays blocked).
 * Counting a non-auto-executing tagged opening would let `sellToFundBuy: "automated"` liquidate real
 * holdings to fund a buy the system then refuses — the exact regression tag-not-drop introduced, since
 * a vetoed buy used to be dropped and contribute $0. Untagged openings are unaffected (return true).
 * Exported for direct unit testing.
 */
export function preVetoTaggedOpeningWillPlace(
  p: TradeProposal,
  socraticOverrideMode: TradingPolicy["socraticOverrideMode"]
): boolean {
  if (!p.preVetoReasons?.length) return true;
  return (
    socraticOverrideMode === "execute" &&
    p.autonomyOverride?.requested === true &&
    !!p.autonomyOverride.thesis?.trim()
  );
}

export async function runStrategyOnce(
  userId: string = "local",
  options: { manual?: boolean; connectedAccountId?: string } = {}
): Promise<StrategyResult> {
  // Snapshot the target account exactly once. An explicit override targets a scheduler-selected
  // account; otherwise the active policy supplies the id. Every later read/write stays bound to
  // this id even if the user switches the active account while this long-running invocation awaits.
  // Per-account run lock: prevent overlapping runs from double-counting daily limits,
  // scoped to the target account so a different account isn't blocked.
  const connectedAccountId = options.connectedAccountId ?? getPolicy(userId).connectedAccountId;
  
  const runId = crypto.randomUUID();
  if (!acquireStrategyLock(runId, userId, connectedAccountId)) {
    return { runId: "", status: "failed", summary: "A strategy run is already in progress.", proposals: [] };
  }

  const lockGuard = startStrategyLockGuard({ owner: runId, userId, connectedAccountId });

  let result: StrategyResult;
  const completedProposalResults: StrategyResult["proposals"] = [];
  let llmSteps: StrategyLlmStep[] = [];
  // Per-USER LLM budget reservation id (set at the budget gate below, released in the finally). Held
  // for the run so a CONCURRENT same-user account run's reserve sees this hold and skips LLM instead of
  // both reading "under budget" and overshooting the ceiling (the TOCTOU the ledger read can't close).
  let llmReservationId: string | undefined;
  // Fire-and-forget post-mortem reflection promise (set on the success path). The finally holds the LLM
  // reservation until this settles so the reflection's LLM spend stays inside the reserved headroom.
  let reflectionPromise: Promise<unknown> | undefined;
  const manualRun = Boolean(options.manual);

  try {
    // Keep all post-acquire setup inside the protected region. If the run receipt cannot be
    // inserted, the finally block must still stop the heartbeat and release this owner token.
    insertStrategyRun(runId, userId, connectedAccountId);
    const savedPolicy = getPolicy(userId, connectedAccountId);
    const accountNumber = savedPolicy.accountNumber;
    if (!accountNumber) throw new Error("No account selected.");
    if (savedPolicy.systemState === "halted" && !manualRun) throw new Error("System is halted.");
    const policy: RunnablePolicy = manualRun
      ? { ...savedPolicy, accountNumber, systemState: "active" as const, strategyAuthority: "propose" as const }
      : { ...savedPolicy, accountNumber };
    const activeAccount = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    
    // Check broker health before determining execution state (and before making LLM calls).
    // The gateway is required for live broker checks; if missing, checkBrokerHealth safely returns healthy=true.
    const brokerGateway = activeAccount ? getBrokerGateway(policy, userId) : undefined;
    const healthSignals = activeAccount ? await checkBrokerHealth(userId, activeAccount, brokerGateway) : undefined;
    // Broker health performs network reads. Re-prove this invocation still owns the account lease
    // before it records a skip or proceeds into any more run work.
    lockGuard.assertOwned();
    
    if (healthSignals && !healthSignals.isHealthy) {
      const reason = `Broker health check failed: ${healthSignals.reason}. Skipping strategy run to avoid consuming budget.`;
      console.warn(`[Strategy] ${reason}`);
      audit("run_skipped_broker_unhealthy", { runId, userId, reason }, userId, connectedAccountId);
      result = { runId, status: "completed", summary: reason, proposals: [] };
      finishStrategyRun(runId, "completed", reason, userId);
      return result;
    }

    const executionState = deriveExecutionState(policy, activeAccount, healthSignals);
    // An account is an account: with none connected there is no broker to trade through, and there
    // is no local-simulation fallback. Refuse to run rather than synthesize a fake fill.
    if (!executionState.mode) throw new Error("No connected account. Connect a broker account before running the strategy.");
    const executionMode: ExecutionMode = executionState.mode;

    // Market holiday / closure guard: skip the strategy run when the market is fully closed
    // (holiday or weekend). Manual runs bypass this check so the operator can always force a run.
    if (!manualRun && !isTradingDay()) {
      const reason = "Market is closed (holiday or weekend). Skipping strategy run.";
      console.log(`[Strategy] ${reason}`);
      audit("run_skipped_market_closed", { runId, userId, reason }, userId, connectedAccountId);
      result = { runId, status: "completed", summary: reason, proposals: [] };
      finishStrategyRun(runId, "completed", reason, userId);
      return result;
    }

    // ── Model rotation (owner testing option) ─────────────────────────────
    // "__rotate__" as llmModel / redTeamLlmModel round-robins each run through every curated
    // model whose provider credential resolves, so comparative live history accrues across
    // models (`proposedByModel` already stamps the CONCRETE serving model on each proposal).
    // Resolved HERE — after the market-closed early-return (a skipped run must not consume a
    // rotation slot) and BEFORE any budget preview or LLM endpoint resolution — onto a
    // RUN-SCOPED override, the same pattern as the usage-budget downgrade below: the persisted
    // policy keeps the sentinel so the NEXT run rotates again, and the breaker `setPolicy`
    // calls above/below (which persist `policy`) can never overwrite it with a concrete model.
    // Every pick is audited (`model_rotation_pick`). See src/lib/model-rotation.ts.
    // Resolve the picks NOW (so the budget preview/enforcement below can price the concrete models this
    // run would serve), but DEFER the pointer advance + pick audit to `commitRotation()`: it is called
    // late, immediately before the Green proposeTrades call, once the run is actually committed to
    // serving the LLM (after account validation + the usage-budget skip gate). A run that aborts before
    // that point (account unavailable, over budget, no candidate cleared the threshold) leaves the
    // pointer untouched, so it never burns a rotation slot on a run that generated no proposal.
    const { commit: commitRotation, ...rotationOverride } = resolveModelRotationForRun({ userId, accountId: connectedAccountId, runId, policy });

    // Cost-aware budget feedback loop (API Usage Monitor) — Phase 1: fire budget alerts for
    // over-budget providers whenever the monitor is configured (fire-and-forget, never blocks a run).
    void checkBudgetAndAlert(userId, policy).catch(() => {});

    // ADVISORY (always on when the monitor is configured, independent of USAGE_BUDGET_ENFORCE): read
    // budget status once and (a) stamp a receipt so operator spend is auditable per-run even when
    // enforcement is off, (b) format a compact advisory line threaded into the Bull/Bear userContent
    // below (see `budgetAdvisory` on proposeTrades' input) — DATA for the agent, never a command; the
    // agent decides whether a cheaper model or skipping is worth it. Enforcement (Phase 2, below at
    // the LLM budget choke point) is the owner's opt-in override of that same decision via
    // USAGE_BUDGET_ENFORCE. Best-effort: never blocks or fails a run. The fetched status is cached
    // (see `budgetStatus` below) and reused at the enforcement choke point instead of re-fetching.
    let budgetAdvisory: string | undefined;
    let budgetStatus: Awaited<ReturnType<typeof getBudgetStatusCached>> = null;
    try {
      budgetStatus = await getBudgetStatusCached();
      if (budgetStatus) {
        const enforceOn = usageBudgetEnforceEnabled();
        // Rotation-resolved view: the preview must reason about the CONCRETE models this run
        // will serve, not the "__rotate__" sentinel (which has no price entry).
        const wouldDecide = await previewBudgetDecision(userId, { ...policy, ...rotationOverride }, { status: budgetStatus });
        lockGuard.assertOwned();
        audit(
          "usage_budget_status",
          {
            runId,
            enforceOn,
            summary: budgetStatus.summary,
            providers: budgetStatus.providers.map((p) => ({ name: p.name, status: p.status, spentUsd: p.spentUsd, monthlyBudgetUsd: p.monthlyBudgetUsd, percentUsed: p.percentUsed })),
            wouldSkip: wouldDecide.skip,
            wouldDowngrade: wouldDecide.downgraded,
            suggestedLlmModel: wouldDecide.llmModel,
            suggestedRedTeamLlmModel: wouldDecide.redTeamLlmModel,
            reason: wouldDecide.reason
          },
          userId,
          connectedAccountId
        );
        budgetAdvisory = formatBudgetAdvisory(budgetStatus);
      }
    } catch (error) {
      if (error instanceof StrategyLockOwnershipLostError) throw error;
      /* advisory is best-effort — never break the run */
    }

    const gateway = getBrokerGateway(policy, userId);
    lockGuard.assertOwned();
    await reconcilePendingFills(gateway, policy.accountNumber, userId, connectedAccountId);
    lockGuard.assertOwned();
    // Broker-truth reconcile any order-placement intent left "placing" by a prior run that crashed
    // mid-call: match it against the broker by clientOrderId and recover or abandon it.
    await flagStalePlacingIntents(gateway, policy.accountNumber, userId, connectedAccountId);
    lockGuard.assertOwned();
    const [accounts, portfolio, positions, orders] = await Promise.all([
      gateway.getAccounts(),
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
    lockGuard.assertOwned();
    const selected = accounts.find((account) => account.accountNumber === policy.accountNumber);
    if (!selected) throw new Error("Selected account is not available.");
    if (!selected.agenticAllowed) throw new Error("Selected account is not agentic_allowed.");

    const allowedSymbols = allowedSymbolsForPolicy(policy);
    // Item 3 (opt-in): thread a sample-gated, audited per-factor nudge from matured missed-opportunity
    // evidence into THIS run's scan-scoring weights (transient — not persisted). Default OFF → the scan
    // uses policy.scoringWeights byte-identically. The recurring-factor bar is raised (>=5) + SPY-relative
    // only when item-4's benchmarkRelativeMisses is also on; otherwise the historical >0/>=2 test applies.
    const scanWeights = resolveScanScoringWeights(policy, fillSourceForExecutionMode(executionState), runId, userId);
    // Item 2 (opt-in): resolve the cached congress go/no-go gate multiplier (1 default / 0 when a fresh
    // no-go verdict + gating on). Default OFF → multiplier 1 → congress scoring byte-identical.
    const { multiplier: congressMultiplier, verdict: congressVerdict } = resolveCongressGateMultiplier(
      userId,
      policy.tuning?.congressGoNoGoGating ?? false
    );
    if (congressMultiplier === 0 && congressVerdict) {
      audit("congress_gate_applied", { runId, userId, pass: congressVerdict.pass, reasons: congressVerdict.reasons, stats: congressVerdict.stats }, userId, connectedAccountId);
    }
    const baseMarketScan = await scanMarket(allowedSymbols, positions, scanWeights, userId, dynamicIndexUniversesForPolicy(policy), {
      candidateLimit: policy.marketScanCandidateLimit,
      outlierReserve: policy.marketScanOutlierReserve,
      universeFloor: policy.universeFloor,
      congressMultiplier
    });
    const quoteSymbols = uniqueSymbols(baseMarketScan.topCandidates.map((quote) => quote.symbol));
    const marketScan = mergeQuoteData(baseMarketScan, await gateway.getEquityQuotes(policy.accountNumber, quoteSymbols));
    const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
    // Full lock PROVENANCE (binding account, clear date, summed disallowed lossUsd), not just the
    // symbol set — the ask/auto wash-sale handling modes price the forfeited deduction from it.
    const washSaleLocks = getUserWashSaleLockProvenance(userId, new Date());

    // An account is an account: decisions always run against the real broker-reported portfolio and
    // positions for the active (paper or live) account — there is no local-simulation alternative.
    const currentPrices = currentPricesFromScan(marketScan);
    const workingPortfolio = portfolio;
    const workingPositions = positions;
    // Held-position symbol set, hoisted here so every retrieval scope below (filings RAG,
    // learned-context, episodic) can widen its symbol list to include OPEN positions — not just
    // the score-sorted top-N scan candidates — so sell/hold/trim decisions on existing holdings
    // get retrieved memory too. Strictly additive: never used to shrink/reorder the BUY-candidate
    // scan/prompt set. Reused (not recomputed) by the take-profit trim-band pruning below.
    const heldSymbols = new Set(workingPositions.map((p) => normalizeSymbol(p.symbol)));
    const learningSource = fillSourceForExecutionMode(executionMode);
    const runLiveFills = listFillEvents(policy.accountNumber, "live", 500, userId);
    const runPaperFills = listFillEvents(policy.accountNumber, "paper", 500, userId);
    const prefetchedFills: PrefetchedFills = { liveFills: runLiveFills, paperFills: runPaperFills };
    lockGuard.assertOwned();
    await notifyStaleLimitOrders({ userId, policy, orders });

    // Re-prove ownership before entering the first stateful maintenance phase. The awaited setup
    // above takes real wall time; if its heartbeat failed, snapshots and breaker mutations must not
    // run under a successor's account lease.
    lockGuard.assertOwned();

    // Pre-run snapshot: record the account state BEFORE any proposals execute so that
    // post-mortem / reconciliation always has a pre-execution baseline even if the run
    // crashes mid-loop. The post-run snapshot (below) remains for the final state.
    recordPortfolioSnapshot({ userId, runId, accountNumber: policy.accountNumber, source: learningSource, executionMode, portfolio: workingPortfolio, positions: workingPositions });

    // Advisory drawdown context surfaced to the strategist when the breaker breaches in "advisory"
    // mode (the default) — informs the agent, never seizes control.
    let drawdownAdvisory: { reason: string; equity: number; highWaterMark: number; drawdownPct: number } | undefined;
    // Account-level drawdown / daily-loss breaker. The per-trade gate bounds any single mistake; this
    // bounds the whole account's bleed. Per the governing philosophy ("nothing is hard except which
    // account to work in; agent decides, logs everything"), the breaker is ADVISORY by default: on a
    // breach it writes a receipt and surfaces the drawdown to the strategist as decision context (see
    // `drawdownAdvisory` threading below) so the agent can choose to de-risk — it does NOT seize
    // control. Hard enforcement (flip to "close_only" or "halt") is available only when the owner
    // explicitly opts in via `riskRules.drawdownBreakerAction`.
    if (!manualRun && policy.systemState === "active") {
      const equity = accountEquity(workingPortfolio);
      const breaker = recordAndEvaluateDrawdownBreaker({
        accountNumber: policy.accountNumber,
        source: learningSource,
        equity,
        riskRules: policy.riskRules,
        userId
      });
      if (breaker.breached) {
        const breakerAction = policy.riskRules.drawdownBreakerAction ?? "advisory";
        const drawdownPct = breaker.highWaterMark > 0 ? ((breaker.highWaterMark - equity) / breaker.highWaterMark) * 100 : 0;
        if (breakerAction === "advisory") {
          // Advisory (default): receipt + prompt context, NO state change. The account boundary is the
          // only absolute; the agent decides whether to de-risk, and the deviation is logged/coachable.
          drawdownAdvisory = { reason: breaker.reason ?? "drawdown/daily-loss threshold breached", equity, highWaterMark: breaker.highWaterMark, drawdownPct };
          audit("policy_violation_drawdown", { runId, reason: breaker.reason, equity, highWaterMark: breaker.highWaterMark, startOfDayEquity: breaker.startOfDayEquity, from: "active", action: "advisory" }, userId, connectedAccountId);
        } else {
          // Owner opted into hard enforcement: flip systemState. Persist to the SAME account the run
          // targeted (read via getPolicy(userId, connectedAccountId)); omitting it would resolve the ACTIVE
          // account, so a scheduler run of a non-active account could halt the wrong account.
          const revertedTo = breakerAction === "close_only" ? "close_only" : "halted";
          policy.systemState = revertedTo;
          setPolicy(policy, userId, connectedAccountId);
          audit("policy_violation_drawdown", { runId, reason: breaker.reason, equity, highWaterMark: breaker.highWaterMark, startOfDayEquity: breaker.startOfDayEquity, from: "active", revertedTo, action: breakerAction }, userId, connectedAccountId);
          await sendNotification(
            {
              type: "kill_switch",
              title:
                revertedTo === "halted"
                  ? "Circuit breaker HALTED autonomous trading (manual re-arm required)"
                  : "Circuit breaker halted new entries (close-only)",
              payload: { runId, reason: breaker.reason, equity, revertedTo }
            },
            { policy, userId }
          );
        }
      }
    }

    // Volatility panic auto-brake: independent of the drawdown breaker, a rare tail extreme on
    // VIX / VVIX / SKEW flips an active system to close_only so a market-wide panic stops opening
    // new risk even when this account hasn't drawn down yet. Risk-reducing exits still flow.
    // Reads the LIVE (short-TTL) VIX overlay, not the bare 24h-cached fetchMacroData snapshot —
    // pinning the brake to a day-old VIX would leave it up to a day blind on a crash day.
    if (!manualRun && policy.systemState === "active") {
      const [brakeMacro, brakeSignals] = await Promise.all([
        fetchMacroDataWithLiveVix(userId).catch(() => undefined),
        getMarketSignals(userId).catch(() => undefined)
      ]);
      lockGuard.assertOwned();
      const volBrake = evaluateVolatilityBrake(brakeMacro, brakeSignals, policy);
      if (volBrake.brake) {
        policy.systemState = "close_only";
        // Persist to the run's TARGET account (same reason as the drawdown breaker above).
        setPolicy(policy, userId, connectedAccountId);
        audit(
          "policy_violation_vol_panic",
          { runId, reason: volBrake.reason, from: "active", revertedTo: "close_only", vixAsOf: brakeMacro?.vixAsOf },
          userId,
          connectedAccountId
        );
        await sendNotification(
          { type: "kill_switch", title: "Volatility brake halted new entries", payload: { runId, reason: volBrake.reason, vixAsOf: brakeMacro?.vixAsOf } },
          { policy, userId }
        );
      }
    }

    // ── Usage-budget Phase 2 enforcement (opt-in, USAGE_BUDGET_ENFORCE) ────
    // Owner's off-by-default switch on top of the ADVISORY computed above. Placed at this same
    // choke point — AFTER the risk-reducing breakers, BEFORE any LLM call — so it can only ever skip
    // the LLM proposal step, never risk maintenance. skip ends the run gracefully right here (audit +
    // notifyBudgetSkip, no LLM call, no reservation taken); downgrade is carried as a RUN-SCOPED
    // `runLlmOverride`/`runPolicy` (below) — NEVER written onto `policy` itself — so every
    // persistence-adjacent site (autoRevertOnCapBreach, setPolicy) keeps seeing the owner's pristine,
    // configured models and can never persist the downgrade. `runPolicy` (the derived clone with the
    // override merged in) is what actually reaches `resolveLlmEndpoint` in `proposeTrades`,
    // `debateProposal`'s explicit policy argument, and proposal revalidation. Fail-open on any
    // evaluator error (evaluateBudgetForRun never throws, but this is the same posture as everything
    // else in this file's budget handling). The `try` is scoped to ONLY the evaluator call — the skip
    // sequence (audit + notify + finish + release + return) runs OUTSIDE the catch so a transient
    // throw from finishStrategyRun/releaseStrategyLock can't be swallowed and silently fall through
    // into the full LLM/trade path while the audit trail still says "skipped" (mirrors the
    // market-closed early-return above).
    let enforceDecision: Awaited<ReturnType<typeof evaluateBudgetForRun>> = { skip: false, downgraded: false };
    try {
      // Rotation-resolved view (same reason as the advisory preview above): enforcement must
      // evaluate the CONCRETE models this run will serve, never the "__rotate__" sentinel.
      enforceDecision = await evaluateBudgetForRun(userId, { ...policy, ...rotationOverride }, { status: budgetStatus });
    } catch {
      /* fail-open — never let usage-budget enforcement break a run */
    }
    lockGuard.assertOwned();
    if (enforceDecision.skip) {
      const reason = enforceDecision.reason ?? "Over budget.";
      audit("usage_budget_enforced", { runId, userId, action: "skip", reason }, userId, connectedAccountId);
      await notifyBudgetSkip(userId, policy, runId, reason);
      lockGuard.assertOwned();
      const summary = `Strategy run skipped — over usage budget. ${reason}`;
      result = { runId, status: "completed", summary, proposals: [] };
      finishStrategyRun(runId, "completed", summary, userId);
      return result;
    }
    // Run-scoped model override: carried SEPARATELY from `policy` so nothing that persists (setPolicy,
    // autoRevertOnCapBreach) can ever see or write the downgraded models. `runPolicy` below is the ONLY
    // object threaded into LLM-model-resolution call sites for this run.
    const runLlmOverride: { llmModel?: string; redTeamLlmModel?: string } = {};
    if (enforceDecision.downgraded) {
      // "before" = what this run WOULD have served (rotation already resolved), so the
      // downgrade audit shows a concrete-model transition, not the "__rotate__" sentinel.
      const before = {
        llmModel: rotationOverride.llmModel ?? policy.llmModel,
        redTeamLlmModel: rotationOverride.redTeamLlmModel ?? policy.redTeamLlmModel
      };
      if (enforceDecision.llmModel) runLlmOverride.llmModel = enforceDecision.llmModel;
      if (enforceDecision.redTeamLlmModel) runLlmOverride.redTeamLlmModel = enforceDecision.redTeamLlmModel;
      audit(
        "usage_budget_enforced",
        {
          runId,
          userId,
          action: "downgrade",
          reason: enforceDecision.reason,
          before,
          after: { llmModel: runLlmOverride.llmModel ?? before.llmModel, redTeamLlmModel: runLlmOverride.redTeamLlmModel ?? before.redTeamLlmModel }
        },
        userId,
        connectedAccountId
      );
    }
    // Derived, run-scoped policy used ONLY for LLM-model resolution (proposeTrades, debateProposal,
    // proposal revalidation, and the post-mortem reflection pass below) — never passed to setPolicy or
    // autoRevertOnCapBreach, which continue to use the pristine `policy` object so a cap-breach demotion
    // persists ONLY `strategyAuthority`, never the in-run model downgrade.
    // Merge order matters: the usage-budget downgrade (runLlmOverride) intentionally WINS over the
    // rotation pick — enforcement is the owner's opt-in cost override of whatever would have run.
    const runPolicy: RunnablePolicy = { ...policy, ...rotationOverride, ...runLlmOverride };

    // ── Per-user/day LLM budget ceiling ────────────────────────────────────
    // Computed HERE, AFTER the non-LLM safety work (pending-fill reconciliation + drawdown/volatility
    // breakers above) and BEFORE any model call below (proposal REVALIDATION and generation), so a
    // spend cap NEVER disables risk maintenance — it only skips the LLM work. The single choke point
    // for EVERY run entry (event trigger, interval scheduler, manual "Run once" API, mobile command,
    // future). Default OFF unless an operator sets TRIGGER_LLM_DAILY_TOKEN_BUDGET / _COST_BUDGET_USD.
    //
    // Two-part admission control. (1) checkLlmDailyBudget is the ledger READ — already over budget?
    // Then (2) reserveLlmRunBudget is the reservation that closes the TOCTOU the read can't: it CAS-holds
    // this run's worst-case estimate against today's ledger + other live reservations, so a concurrent
    // same-user account run's reserve fails and skips LLM rather than both overshooting the ceiling.
    // A reservation failure (over budget OR fail-closed DB error) degrades to "skip LLM", never a failed
    // run. No ceiling configured → reserve returns ok with no id (default OFF preserved). See
    // src/lib/llm-budget.ts and docs/rollouts/2026-07-01-fg-codex-review-fixes.md.
    const budget = checkLlmDailyBudget(userId, new Date(), connectedAccountId);
    let skipLlmDueToBudget = !budget.ok;
    // Operator-level MONTHLY spend ceiling (LLM_SPEND_CEILING) enforced at this same single
    // choke point so EVERY run entry inherits it — not just the interval scheduler. Event-triggered
    // runs (triggers.ts -> runStrategyOnce), manual "Run once", and mobile commands all pass through
    // here, so checking the ceiling only in the scheduler tick let those paths bypass it. Skips only
    // the LLM proposal step (never the risk breakers above); default OFF when LLM_SPEND_CEILING unset.
    if (!skipLlmDueToBudget) {
      const monthly = checkMonthlyLlmSpendCeiling();
      if (!monthly.ok) {
        skipLlmDueToBudget = true;
        audit(
          "usage_budget_enforced",
          { runId, userId, action: "skip", reason: `Monthly operator LLM spend ceiling reached ($${monthly.totalUsd.toFixed(2)} of $${monthly.ceilingUsd?.toFixed(2)})`, scope: "operator_monthly" },
          userId,
          connectedAccountId
        );
      }
    }
    if (!skipLlmDueToBudget) {
      const reservation = reserveLlmRunBudget(userId, connectedAccountId);
      llmReservationId = reservation.reservationId;
      if (!reservation.ok) {
        skipLlmDueToBudget = true;
        audit(
          "strategy_run_suppressed_budget_reservation",
          { runId, userId, reason: reservation.reason ?? "reservation_unavailable" },
          userId,
          connectedAccountId
        );
      }
    }
    if (skipLlmDueToBudget && budget.ok === false) {
      audit(
        "strategy_run_suppressed_budget",
        { runId, userId, reason: budget.reason, tokensToday: budget.tokensToday, costUsdToday: budget.costUsdToday, tokenLimit: budget.tokenLimit, costLimitUsd: budget.costLimitUsd },
        userId,
        connectedAccountId
      );
    }

    // Supplemental tasks before generating new ideas — keep the approval queue honest so a
    // human never mistakes an hours/days-old pending proposal for a fresh recommendation:
    //   (1) deterministic hard-expiry of anything past policy.proposalExpiryMinutes (non-LLM — always
    //       runs, it's safety hygiene), then
    //   (2) an LLM re-check ("does this still stand?") of pending proposals due on their cadence —
    //       SKIPPED when over the LLM budget, since it calls the model (records usage).
    const assertOwned = () => lockGuard.assertOwned();
    const expiry = await expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber, assertOwned })
      .catch((e) => {
        if (e instanceof StrategyLockOwnershipLostError) throw e;
        console.error("[expiry] run error:", e);
        return { expired: 0 };
      });
    const revalidation = skipLlmDueToBudget
      ? null
      // runPolicy (not policy): this LLM re-check must see the run-scoped usage-budget downgrade too.
      : await revalidatePendingProposals({ userId, policy: runPolicy, accountNumber: policy.accountNumber, marketScan, assertOwned })
          .catch((e) => {
            if (e instanceof StrategyLockOwnershipLostError) throw e;
            console.error("[revalidation] run error:", e);
            return null;
          });
    // Both helpers can spend meaningful wall time and mutate queue state. Re-prove even when they
    // short-circuit so the next phase never inherits an ownership loss hidden by best-effort logic.
    lockGuard.assertOwned();

    const betaBySymbol: Record<string, number> = {};
    for (const [sym, q] of Object.entries(marketScan.quotesBySymbol)) {
      if (typeof q.beta === "number" && Number.isFinite(q.beta)) betaBySymbol[normalizeSymbol(sym)] = q.beta;
    }
    // Per-position stop PLANS (LLM-chosen stop TYPE, persisted at fill time): read the account's plans
    // once here so both the proactive-risk generator and the opening-proposal enricher below see a
    // consistent snapshot for this run. A plan overrides this account's own stop precedence for that
    // one symbol only — "default" (the common case, no row or an explicit default) falls through to the
    // account-wide fixed/ATR/beta chain unchanged.
    let stopPlanBySymbol: Record<string, StopPlanStyle> = {};
    // Rationale-only side map for the SAME live-basis-filtered plans, keyed alongside stopPlanBySymbol
    // — kept separate (rather than widening stopPlanBySymbol's value type everywhere it's threaded)
    // so enrichOpeningProposal can stamp an inherited plan's original rationale onto the returned
    // proposal for the approval card, instead of erasing it (Codex review, PR #1371).
    const stopPlanRationaleBySymbol: Record<string, string | undefined> = {};
    // The UNFILTERED plan set (hoisted out of the try block below) — the stale-symbol cleanup further
    // down must compute its candidates from THIS, not from stopPlanBySymbol. filterStopPlansByLiveBasis
    // already drops any symbol with no live position, so by the time a position actually closes its
    // row is already absent from stopPlanBySymbol — computing staleStopPlanSymbols from that filtered
    // map made the cleanup a no-op exactly when a position closes, leaving the DB row behind for a
    // later re-buy at a similar price to silently inherit (Codex review, PR #1371).
    let rawStopPlans: Record<string, PositionStopPlan> = {};
    if (policy.accountNumber) {
      try {
        rawStopPlans = getStopPlans(policy.accountNumber, userId);
        stopPlanBySymbol = filterStopPlansByLiveBasis(rawStopPlans, workingPositions);
        for (const sym of Object.keys(stopPlanBySymbol)) {
          stopPlanRationaleBySymbol[sym] = rawStopPlans[sym]?.rationale;
        }
      } catch (err) {
        console.warn("[strategy] stop plan lookup failed:", err instanceof Error ? err.message : err);
      }
    }
    // ATR-based stops: precompute a per-symbol stop DISTANCE (% of entry) from each open position's
    // recent daily range so the sync proactive generator can use it (mirrors betaBySymbol). Runs when
    // the account has ATR stops on globally, OR when any held position carries an explicit per-position
    // "atr" stop plan (universal availability — an "atr" plan must work even with atrStops off account-
    // wide). Best-effort + bounded: a fetch error or insufficient bars simply leaves that name on the
    // fixed/beta stop (or the per-position fallback flat %, resolved downstream).
    const atrStopPctBySymbol: Record<string, number> = {};
    const anyHeldAtrPlan = workingPositions.some((p) => stopPlanBySymbol[normalizeSymbol(p.symbol)] === "atr");
    if ((policy.atrStops === true && (policy.riskRules.stopLossPct ?? 0) > 0) || anyHeldAtrPlan) {
      const period = Math.round(policy.riskRules.atrStopPeriod ?? 14);
      const multiple = policy.riskRules.atrStopMultiple ?? 2.0;
      await Promise.all(
        workingPositions
          .filter((p) => Math.abs(p.quantity) > 0.000001 && p.averageCost > 0)
          .map(async (p) => {
            const sym = normalizeSymbol(p.symbol);
            try {
              const bars = await fetchDailyOHLC(sym, Date.now(), userId);
              if (!bars) return;
              const pct = atrStopPct(atr(bars, period), p.averageCost, multiple);
              if (typeof pct === "number") atrStopPctBySymbol[sym] = pct;
            } catch {
              // best-effort — fall back to the fixed/beta stop for this name
            }
          })
      );
      lockGuard.assertOwned();
    }
    // Extended-hours protective-exit routing is decided ONCE here (the run knows the wall-clock
    // session); the pure generator just receives the buffer (undefined ⇒ default market/queue-to-open)
    // plus real bid/ask anchors per symbol — a SELL limit must cross the BID (the composite scan price
    // is ask-biased), a COVER the ASK. Synthesized spread sides never anchor (protectiveExitQuoteFromScan).
    const exitQuotesBySymbol: Record<string, ProtectiveExitQuote> = {};
    for (const [sym, q] of Object.entries(marketScan.quotesBySymbol)) {
      const ref = protectiveExitQuoteFromScan(q);
      if (ref && (ref.bid !== undefined || ref.ask !== undefined)) exitQuotesBySymbol[normalizeSymbol(sym)] = ref;
    }
    const proactiveProposals = generateProactiveRiskProposals(workingPositions, currentPrices, policy, betaBySymbol, atrStopPctBySymbol, extendedHoursExitBufferBps(policy), exitQuotesBySymbol, stopPlanBySymbol);
    // Partial take-profit trims (laddered per band so they trim once per band, not every run). The band
    // is committed only when a trim actually FILLS (recordFillFromProposal), so a proposed/blocked/rejected
    // trim is re-offered next run; here we only read prior bands and prune fully-closed positions (hygiene).
    if (policy.accountNumber) {
      try {
        const lastTpBands = getTakeProfitTrimBands(policy.accountNumber, userId);
        const tpPlan = planTakeProfitTrims(workingPositions, currentPrices, policy, lastTpBands);
        clearTakeProfitTrimBands(policy.accountNumber, Object.keys(lastTpBands).filter((s) => !heldSymbols.has(s)), userId);
        proactiveProposals.push(...tpPlan.proposals);
      } catch (err) {
        console.warn("[strategy] take-profit trim planning failed:", err instanceof Error ? err.message : err);
      }
      try {
        // From rawStopPlans (unfiltered), not stopPlanBySymbol — see rawStopPlans' doc comment above.
        const staleStopPlanSymbols = Object.keys(rawStopPlans).filter((s) => !heldSymbols.has(normalizeSymbol(s)));
        clearStopPlans(policy.accountNumber, staleStopPlanSymbols, userId);
        // Prune the in-memory snapshot too — enrichOpeningProposal (below, same run) reads this same
        // map by closure, and a symbol closed then re-opened within this run must not inherit its old
        // plan from before the DB clear (Codex review, PR #1371).
        for (const s of staleStopPlanSymbols) {
          delete stopPlanBySymbol[s];
          delete stopPlanRationaleBySymbol[s];
        }
      } catch (err) {
        console.warn("[strategy] stop plan cleanup failed:", err instanceof Error ? err.message : err);
      }
    }

    let ragContext = "";
    let socraticRagAttributions: SocraticRagAttribution[] = [];
    // Advisory prompt-safety receipts (CR-H lane): kind-'safety' evidence items attached to every
    // decision case this run records. Populated by the evidence-age check below and the
    // injection scan inside proposeTrades. Receipts only — never a gate on generation/placement.
    const promptSafetyEvidence: SocraticEvidenceItem[] = [];
    const evidenceAgeInputs: EvidenceAgeInput[] = [];
    // corpus-coverage-receipt (2026-07-06): the filings doc types requested below, hoisted so the
    // coverage receipt after this block can report "requested" alongside "retrieved this run" /
    // "empty" without re-declaring the literal. Advisory only — never affects the retrieval call
    // itself. NOTE: the coverage receipt itself only CHECKS the COVERAGE_CHECKED_DOC_TYPES subset
    // (10-k/10-q — narrower than this request list) against retrievedFilingsDocTypes below — "8-k"
    // and "earnings-transcript" stay in this retrieval request list (harmless — retrieveContextDetailed
    // just gets more empty filter values) but are deliberately excluded from the coverage check
    // itself; see COVERAGE_CHECKED_DOC_TYPES's comment near the top of this file.
    const requestedFilingsDocTypes = ["10-k", "10-q", "8-k", "earnings-transcript"];
    const retrievedFilingsDocTypes = new Set<string>();
    // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): one row per symbol (filings
    // pass) plus one PORTFOLIO row (episodic pass), persisted via the `rag_retrieval_status` audit
    // below and mirrored onto the decision case's `ragRetrievalStatus` field. Advisory only — never
    // changes which chunks are retrieved/used; a pure receipt of WHY a pass came back empty/degraded.
    const ragRetrievalStatusRows: { symbol: string; status: string; reason?: string }[] = [];
    // Gate RAG on the budget/reservation skip. When a concurrent same-user run holds the reservation (or
    // we're over budget) skipLlmDueToBudget is set and proposeTrades won't run — and retrieveContextDetailed
    // only checks the committed ledger, NOT live reservations, so retrieving here would still spend
    // Voyage/Pinecone budget the other run has claimed (the RAG half of the TOCTOU). It's advisory context
    // for the (now-skipped) proposal step anyway, so there is nothing to retrieve for.
    if (!skipLlmDueToBudget) {
      try {
        const { retrieveContextDetailed, defaultMinScore, defaultRelevanceFloor, defaultDedupeSimilarity, formatChunkWithProvenance } =
          await import("./vector-db");
        // hyde-multiquery-retrieval (2026-07-05): both flag-gated, default OFF — when off, `variants`
        // is always `[]` below and `retrieveContextDetailed` gets no `queries` option, so this pass is
        // byte-for-byte the single-query call it was before this item.
        const { multiQueryEnabled, hydeEnabled, deriveQueryVariants, generateHydePassages } = await import("./rag/multi-query");
        const { shouldDegradeForBudget } = await import("./rag/run-budget");
        const wantMultiQuery = multiQueryEnabled() && !shouldDegradeForBudget();
        const wantHyde = hydeEnabled() && !shouldDegradeForBudget();
        // Widen retrieval (not the BUY-candidate scan/prompt set) to also cover OPEN positions: a
        // held name outside the top-3 by score still needs a filings-RAG pass so sell/hold/trim
        // decisions on it are informed. Held symbols are unioned in, never substituted for the
        // top-N, and the top-N ordering/membership is untouched.
        const topSymbols = uniqueSymbols([...marketScan.topCandidates.slice(0, 3).map(c => c.symbol), ...heldSymbols]);
        const contexts = await Promise.all(
          topSymbols.map(async (sym) => {
            const query = `Significant financial events, SEC filings, and macro catalysts for ${sym}`;
            let variants: string[] = [];
            if (wantMultiQuery) {
              const candidate = marketScan.topCandidates.find((c) => normalizeSymbol(c.symbol) === normalizeSymbol(sym));
              const breakdown = candidate?.factorBreakdown;
              let dominantFactor: string | undefined;
              if (breakdown) {
                let best = -Infinity;
                for (const [key, value] of Object.entries(breakdown)) {
                  if (key === "weightedTotal" || typeof value !== "number") continue;
                  if (value > best) {
                    best = value;
                    dominantFactor = key;
                  }
                }
              }
              variants = deriveQueryVariants({
                symbol: sym,
                sector: marketScan.sectorBySymbol[normalizeSymbol(sym)] ?? candidate?.sector,
                dominantFactor,
                evidenceBulletins: candidate?.evidenceBulletins
              });
              if (wantHyde && variants.length > 0) {
                // generateHydePassages self-gates on isOverLlmBudget(userId, connectedAccountId) —
                // 2026-07-05 review fix — mirroring retrieveContextDetailed's own budget gate below.
                const hydePassages = await generateHydePassages(variants, { userId, connectedAccountId: policy.connectedAccountId });
                variants = [...variants, ...hydePassages];
              }
            }
            const chunks = await retrieveContextDetailed(query, sym, 3, userId, {
              docType: requestedFilingsDocTypes,
              minScore: defaultMinScore(),
              // 2026-07-04 RAG quick-wins: wire the previously-dormant post-rerank relevance floor
              // + near-duplicate suppression (both existed since 2026-07-01 but no caller passed
              // them, so neither ever ran). dedupeSimilarity is ON by default for this
              // socratic-decision retrieval path per the composite review's guidance.
              minRelevanceScore: defaultRelevanceFloor(),
              dedupeSimilarity: defaultDedupeSimilarity(),
              connectedAccountId: policy.connectedAccountId,
              runId,
              ...(variants.length > 0 ? { queries: variants } : {}),
              // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): advisory only,
              // never affects `chunks` — see RetrievalStatus in vector-db.ts.
              onStatus: (status) => {
                ragRetrievalStatusRows.push({ symbol: normalizeSymbol(sym), status });
              }
            });
            return { sym, query, chunks };
          })
        );
        const validContexts = contexts.flatMap((context) => context.chunks).filter(Boolean);
        socraticRagAttributions = contexts.flatMap((context) => ragAttributionsFromChunks(context.sym, context.query, context.chunks));
        // Evidence-age receipt inputs: a HIGH-relevance chunk dated <24h old is worth a receipt
        // (fresh text steering a same-day decision). Aggregated + audited once below.
        const relevanceFloor = defaultRelevanceFloor();
        for (const context of contexts) {
          for (const chunk of context.chunks) {
            evidenceAgeInputs.push({
              kind: "rag_chunk",
              id: chunk.id,
              label: `${context.sym} ${chunk.doc_type ?? "chunk"}${chunk.as_of ? ` ${String(chunk.as_of).slice(0, 10)}` : ""}`,
              timestamp: chunk.as_of,
              relevanceScore: chunk.relevanceScore ?? chunk.score,
              relevanceFloor
            });
            // corpus-coverage-receipt: track which requested doc types actually produced a chunk
            // THIS run, regardless of symbol — coverage is corpus-wide, not per-symbol.
            if (chunk.doc_type) retrievedFilingsDocTypes.add(chunk.doc_type.toLowerCase());
          }
        }
        if (validContexts.length > 0) {
          // 2026-07-04 RAG quick-wins: prefix each chunk with a compact provenance header
          // (doc_type/section/symbol/date/relevance) so the model can weight a fresh 8-K over a
          // stale 10-K and reference which chunk it drew from — see formatChunkWithProvenance.
          ragContext = contexts
            .flatMap((context) => context.chunks.map((chunk) => formatChunkWithProvenance(chunk, context.sym)))
            .join("\n\n");
        }
      } catch (e) {
        if (e instanceof StrategyLockOwnershipLostError) throw e;
        console.warn("[Strategy] Skipping RAG context, vector-db or keys might not be available.");
        // Typed retrieval-status receipt: this catch covers the WHOLE filings pass (e.g. the
        // dynamic `import("./vector-db")` itself throwing), so no per-symbol onStatus callback may
        // have fired yet — record a fallback row per symbol actually in scope (top-3 UNION held
        // positions — see `topSymbols` above) so the receipt isn't silently absent for a held name.
        for (const sym of uniqueSymbols([...marketScan.topCandidates.slice(0, 3).map((c) => c.symbol), ...heldSymbols])) {
          if (!ragRetrievalStatusRows.some((row) => row.symbol === sym)) {
            ragRetrievalStatusRows.push({ symbol: sym, status: "lookup_failed", reason: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
    // Dynamic imports, HyDE generation, and vector retrieval all await remote work. Ownership must
    // still be current before any evidence audit or cleanup mutates durable run state.
    lockGuard.assertOwned();

    // Parallel to RAG: pull advisory learned-context FACTS (private fact-tier only in this slice).
    // ADVISORY DATA ONLY — this string reaches the prompt beside retrievedFinancialContext and is
    // NEVER threaded into applyDeterministicSizing or scanMarket's scoringWeights. The
    // learned-context safety regression test guards that invariant.
    let learnedContext = "";
    try {
      // Same held-position widening as the filings-RAG pass above: union in open positions so
      // learned facts on a held name outside the top-8 still surface, without touching the
      // top-8 BUY-candidate slice itself.
      const learnedSymbols = uniqueSymbols([...marketScan.topCandidates.slice(0, 8).map((c) => c.symbol), ...heldSymbols]);
      // regime is intentionally omitted here (not yet a retrieval filter in the fact-tier slice).
      const learnedFacts = retrieveLearnedContextDetailed(userId, learnedSymbols);
      if (learnedFacts.lines.length > 0) {
        learnedContext = learnedFacts.lines.join("\n");
      }
      // Evidence-age receipt inputs: a fact FIRST ASSERTED <24h ago entering today's prompt.
      for (const row of learnedFacts.rows) {
        evidenceAgeInputs.push({
          kind: "learned_fact",
          id: row.id,
          label: `${row.symbol ?? "GENERAL"} ${row.subject}`,
          timestamp: row.assertedAt
        });
      }
    } catch (e) {
      console.warn("[Strategy] Skipping learned-context, store unavailable.");
    }

    // ── Evidence-age anomaly receipt (advisory only) ───────────────────────
    // ONE aggregated audit + ONE kind-'safety' evidence item when same-day evidence (a fresh,
    // high-relevance RAG chunk or a fact asserted today) entered this run's prompts. No text is
    // changed, nothing is dropped or blocked — the receipt IS the control.
    const evidenceAgeAnomalies = collectEvidenceAgeAnomalies(evidenceAgeInputs);
    if (evidenceAgeAnomalies.length > 0) {
      audit("evidence_age_anomaly", { runId, items: evidenceAgeAnomalies }, userId, connectedAccountId);
      promptSafetyEvidence.push({
        kind: "safety",
        tone: "warning",
        title: "Same-day evidence entered this run",
        summary:
          `${evidenceAgeAnomalies.length} evidence item(s) first seen <24h before this run: ` +
          `${evidenceAgeAnomalies.map((i) => `${i.label} (${i.kind}, ${i.ageHours}h old)`).join("; ").slice(0, 400)}. ` +
          "Advisory receipt only — nothing was altered or blocked.",
        source: "prompt-safety",
        data: evidenceAgeAnomalies
      });
    }

    // ── Corpus-coverage receipt (advisory only) ────────────────────────────
    // ONE aggregated audit + ONE kind-'safety' evidence item when a COVERAGE-CHECKED filings doc
    // type (COVERAGE_CHECKED_DOC_TYPES — a static allowlist restricted to types whose producer
    // ledger is COMPLETE, currently 10-k/10-q; see its comment for why "8-k" and
    // "earnings-transcript" are excluded) is BOTH not retrieved this run AND has zero ever-ingested
    // producer rows. Both-conditions is load-bearing — see computeEmptyDocTypes's doc comment.
    // Never touches ragContext/sizing/policy — receipt only.
    if (!skipLlmDueToBudget) {
      // ONE bulk query for the whole run (not one query per coverage-checked type), reused as an
      // in-memory lookup — mirrors ingestedAccessionCountForDocType's prefix-tolerant matching
      // (any stored doc_type whose lowercased form starts with the requested lowercased type)
      // without the DB dependency living inside prompt-safety.ts.
      const accessionCountsByDocType = ingestedAccessionCountsByDocType();
      const hasProducerForDocType = (docType: string): boolean => {
        const normalized = docType.toLowerCase();
        for (const [storedType, count] of Object.entries(accessionCountsByDocType)) {
          if (count > 0 && storedType.startsWith(normalized)) return true;
        }
        return false;
      };
      const emptyDocTypes = computeEmptyDocTypes(COVERAGE_CHECKED_DOC_TYPES, retrievedFilingsDocTypes, hasProducerForDocType);
      if (emptyDocTypes.length > 0) {
        const coverageSymbols = marketScan.topCandidates.slice(0, 3).map((c) => c.symbol);
        audit(
          "rag_doc_type_coverage_empty",
          { runId, symbols: coverageSymbols, emptyDocTypes, requestedDocTypes: requestedFilingsDocTypes },
          userId,
          connectedAccountId
        );
        // Copy honesty (owner report 2026-07-09): the old title ("Requested filings doc type never
        // ingested") read on every stock as "a document was looked for and not found" — a per-symbol
        // lookup failure. The real state is a still-warming shared corpus: SEC ingestion is paced,
        // so say that, with the actual count. Neutral tone: an advisory warm-up receipt on every
        // decision card shouldn't wear the same orange as a real safety warning.
        const ingestedFilingsTotal = Object.values(accessionCountsByDocType).reduce((sum, n) => sum + n, 0);
        promptSafetyEvidence.push({
          kind: "safety",
          tone: "neutral",
          title: "Filings library still warming up",
          summary:
            `No ${emptyDocTypes.join(" or ")} filings are in the research library yet ` +
            `(${ingestedFilingsTotal} filing${ingestedFilingsTotal === 1 ? "" : "s"} ingested so far — SEC ingestion is paced ` +
            `and fills watchlist/held names first). This decision used the other evidence; nothing was altered or blocked.`,
          source: "prompt-safety",
          data: { emptyDocTypes, requestedDocTypes: requestedFilingsDocTypes }
        });
      }
    }

    // ── Episodic decision memory: closest historical analogs + owner coaching ──
    // (2026-07-04 composite review A1, [Both] — the highest-leverage item.) A SECOND retrieval
    // pass, distinct from the filings pass above: doc types ['socratic-decision','coach-note',
    // 'lesson'], queried with a SITUATION SKETCH (regime + candidate factor/evidence summary),
    // cross-symbol, same-run neighbors excluded, as-of stamped. The resulting labeled blocks are
    // injected into BOTH the Bull and Bear userContent below (evidence parity). Advisory only —
    // never threaded into sizing or policy. Same budget gate as the filings pass (retrieval
    // spends Voyage/Pinecone budget).
    let experienceAnalogs = "";
    let ownerCoaching = "";
    if (!skipLlmDueToBudget) {
      try {
        const { retrieveDecisionExperiences } = await import("./experience-memory");
        // Regime for the sketch: fetchMacroData is cached (6h TTL), so this is effectively free —
        // the same regime proposeTrades derives later for entryMarketRegime stamping.
        const macroForSketch = await fetchMacroData(userId).catch(() => undefined);
        const regimeForSketch = macroForSketch ? determineMarketRegime(macroForSketch) : "Unknown";
        const toSituationCandidate = (candidate: MarketQuote) => {
          const sym = normalizeSymbol(candidate.symbol);
          const breakdown = candidate.factorBreakdown;
          let topFactor: string | undefined;
          if (breakdown) {
            let best = -Infinity;
            for (const [key, value] of Object.entries(breakdown)) {
              if (key === "weightedTotal" || typeof value !== "number") continue;
              if (value > best) {
                best = value;
                topFactor = key;
              }
            }
          }
          return {
            symbol: sym,
            sector: marketScan.sectorBySymbol[sym] ?? candidate.sector,
            dominantFactor: topFactor,
            evidence: candidate.evidenceBulletins
          };
        };
        const topSlice = marketScan.topCandidates.slice(0, 3);
        const situationCandidates: SituationCandidate[] = topSlice.map(toSituationCandidate);
        // Widen episodic retrieval scope (not the BUY-candidate top-3 itself) to also cover OPEN
        // positions outside that slice, so sell/hold/trim decisions on them get analog/coaching
        // memory too. marketScan.topCandidates force-includes every held symbol (see market.ts
        // heldExtra), so the fuller candidate shape (sector/dominantFactor/evidence) is available
        // via lookup; a minimal symbol+sector fallback covers the defensive case where it's somehow
        // absent (e.g. a mocked/partial marketScan in a test). Lookup map built once so the loop
        // below is O(heldSymbols) rather than O(heldSymbols x topCandidates).
        const coveredSymbols = new Set(topSlice.map((c) => normalizeSymbol(c.symbol)));
        const candidateBySymbol = new Map(marketScan.topCandidates.map((c) => [normalizeSymbol(c.symbol), c]));
        for (const heldSym of heldSymbols) {
          if (coveredSymbols.has(heldSym)) continue;
          coveredSymbols.add(heldSym);
          const fullCandidate = candidateBySymbol.get(heldSym);
          // `held: true` lets buildSituationSketch (experience-memory.ts) fold this candidate into
          // the episodic query text even though it's appended past the top-3 slice — without that
          // flag the sketch's own slice(0, 3)-equivalent would silently drop it (see
          // docs/rollouts/2026-07-06-held-position-retrieval-scope.md follow-up).
          situationCandidates.push(
            fullCandidate
              ? { ...toSituationCandidate(fullCandidate), held: true }
              : { symbol: heldSym, sector: marketScan.sectorBySymbol[heldSym], dominantFactor: undefined, evidence: undefined, held: true }
          );
        }
        const episodic = await retrieveDecisionExperiences({
          userId,
          runId,
          regime: regimeForSketch,
          candidates: situationCandidates,
          connectedAccountId: policy.connectedAccountId
        });
        lockGuard.assertOwned();
        experienceAnalogs = episodic.analogsBlock ?? "";
        ownerCoaching = episodic.coachingBlock ?? "";
        // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): the episodic pass is
        // cross-symbol, so it gets one PORTFOLIO row rather than a per-symbol one.
        ragRetrievalStatusRows.push({ symbol: "PORTFOLIO", status: episodic.status });
        if (episodic.injected.length > 0) {
          // Run-input persistence: record exactly WHICH analog/coaching vector ids entered this
          // run's prompts (plus the as-of stamp and sketch), so retrieval-usefulness scoring can
          // later join injected ids to this run's realized outcomes. The ids also ride along on
          // every decision case via socraticRagAttributions (persisted + re-indexed).
          audit(
            "experience_retrieval",
            {
              runId,
              asOf: episodic.asOf,
              query: episodic.query,
              analogIds: episodic.injected.filter((ref) => ref.kind === "analog").map((ref) => ref.id),
              coachingIds: episodic.injected.filter((ref) => ref.kind === "coaching").map((ref) => ref.id),
              counterexampleIds: episodic.injected.filter((ref) => ref.counterexample).map((ref) => ref.id),
              ...(typeof episodic.topAnalogSimilarity === "number" ? { topAnalogSimilarity: episodic.topAnalogSimilarity } : {})
            },
            userId,
            connectedAccountId
          );
          socraticRagAttributions.push(
            ...ragAttributionsFromChunks("PORTFOLIO", episodic.query, [...episodic.analogChunks, ...episodic.coachingChunks])
          );
        }
      } catch (e) {
        if (e instanceof StrategyLockOwnershipLostError) throw e;
        console.warn("[Strategy] Skipping episodic decision memory, retrieval unavailable:", e instanceof Error ? e.message : String(e));
        // Typed retrieval-status receipt fallback: retrieveDecisionExperiences itself never throws
        // (its own try/catch always resolves to a status-carrying result), but this outer catch
        // covers earlier statements in the block (e.g. fetchMacroData) — record the row if missing.
        if (!ragRetrievalStatusRows.some((row) => row.symbol === "PORTFOLIO")) {
          ragRetrievalStatusRows.push({ symbol: "PORTFOLIO", status: "lookup_failed", reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): persist the per-symbol
    // (filings pass) + PORTFOLIO (episodic pass) classification alongside the existing
    // `experience_retrieval` audit above. Advisory only — this NEVER changes which chunks were used;
    // it is purely a receipt of WHY a pass came back empty/degraded (no-memory vs lookup-failed vs
    // budget-skipped vs degraded), for observability instead of every cause collapsing to silence.
    if (ragRetrievalStatusRows.length > 0) {
      audit("rag_retrieval_status", { runId, rows: ragRetrievalStatusRows }, userId, connectedAccountId);
    }

    // ── "Do nothing" threshold (minProposalScoreThreshold) ─────────────────
    // Filter candidates below the threshold BEFORE they reach the LLM. If none survive,
    // skip the LLM call entirely — the system sits on its hands rather than proposing
    // on mediocre candidates. Default 0 = unfiltered (preserves existing behavior).
    const minScore = policy.tuning?.minProposalScoreThreshold;
    let skipLlmDueToScoreThreshold = false;
    if (typeof minScore === "number" && minScore > 0 && marketScan) {
      const before = marketScan.topCandidates.length;
      const surviving = marketScan.topCandidates.filter((c) => c.score >= minScore);
      if (surviving.length === 0 && before > 0) {
        skipLlmDueToScoreThreshold = true;
        const reason = `No candidates met minimum score threshold (${minScore}). ${before} candidates all scored below ${minScore}.`;
        console.log(`[Strategy] ${reason}`);
        audit("run_skipped_score_threshold", { runId, userId, threshold: minScore, candidateCount: before, reason }, userId, connectedAccountId);
        marketScan.topCandidates = [];
      } else {
        marketScan.topCandidates = surviving;
      }
    }

    // ── Per-user/day LLM budget ceiling ────────────────────────────────────
    // Gate LLM proposal generation on the daily token/$ budget — the single choke point for EVERY run
    // LLM proposal generation is skipped when over the daily budget (skipLlmDueToBudget, computed
    // above before revalidation) or when no candidate cleared the score threshold. Non-LLM safety
    // work already ran regardless.
    // Re-read the budget immediately before generation. The initial check above ran BEFORE revalidation
    // and the RAG retrieval block, both of which record llm_usage/rag_usage — so a run that STARTED just
    // under the ceiling can be over it by now. Using the stale skipLlmDueToBudget here would let
    // proposeTrades call the model and the withLlmGeneration backstop would THROW LlmBudgetExceededError,
    // which the outer catch turns into a FAILED run + failure notification for what is really normal
    // budget exhaustion. Re-reading degrades to a graceful skip instead. Cheap DB read; default OFF
    // (no ceiling) → always ok, so no behavior change when budgets are unset.
    if (!skipLlmDueToBudget) {
      const budgetNow = checkLlmDailyBudget(userId, new Date(), connectedAccountId);
      if (!budgetNow.ok) {
        skipLlmDueToBudget = true;
        audit(
          "strategy_run_suppressed_budget",
          { runId, userId, reason: budgetNow.reason, tokensToday: budgetNow.tokensToday, costUsdToday: budgetNow.costUsdToday, tokenLimit: budgetNow.tokenLimit, costLimitUsd: budgetNow.costLimitUsd, phase: "pre_generation" },
          userId,
          connectedAccountId
        );
      }
    }
    let llmProposals: TradeProposal[] = [];
    // R7 evidence context for the single Red Team review (built inside proposeTrades alongside the
    // Bull userContent so the reviewer fact-checks against the SAME candidate evidence the
    // strategist saw). Undefined when proposal generation was skipped — no openings to review then.
    let adversaryContext: RedTeamReviewContext | undefined;
    if (!skipLlmDueToScoreThreshold && !skipLlmDueToBudget) {
      // The run is now committed to serving the Green LLM: advance the rotation pointer(s) + audit the
      // pick(s) here (a no-op unless a seat is rotating). Committing at this exact point — after account
      // validation and every usage-budget skip gate, immediately before proposeTrades — is what keeps
      // rotation sampling even: an aborted/skipped run above never reached here, so it never burned a
      // slot. Per-account run locks serialize same-account runs, so read-early/commit-late has no TOCTOU.
      commitRotation();
      const proposed = await proposeTrades({
        runId,
        userId,
        policyAllowlist: allowedSymbols,
        prompt: getStrategyPrompt(userId, connectedAccountId),
        // runPolicy (not policy): carries the run-scoped usage-budget model downgrade (if any) into
        // resolveLlmEndpoint without ever mutating/persisting the owner's configured policy.
        policy: runPolicy,
        activeAccount,
        portfolio: workingPortfolio,
        positions: workingPositions,
        recentOrders: compactRecentOrders(orders),
        marketScan,
        dailyNotionalUsed: daily.notional,
        dailyOrderCount: daily.openingOrderCount,
        ragContext,
        learnedContext,
        ...(experienceAnalogs ? { experienceAnalogs } : {}),
        ...(ownerCoaching ? { ownerCoaching } : {}),
        drawdownAdvisory,
        budgetAdvisory,
        prefetched: prefetchedFills
      });
      lockGuard.assertOwned();
      llmProposals = proposed.proposals;
      llmSteps = proposed.llmSteps;
      adversaryContext = proposed.adversaryContext;
      // Advisory injection receipts from the prompt-assembly scan (audited inside proposeTrades):
      // fold into kind-'safety' evidence, one item per flagged field, so every decision case this
      // run records carries the receipt. Never alters proposals or routing.
      if (proposed.promptSafetyFindings && proposed.promptSafetyFindings.length > 0) {
        const byField = new Map<string, InjectionFinding[]>();
        for (const finding of proposed.promptSafetyFindings) {
          byField.set(finding.name, [...(byField.get(finding.name) ?? []), finding]);
        }
        for (const [field, findings] of Array.from(byField.entries()).slice(0, 4)) {
          promptSafetyEvidence.push({
            kind: "safety",
            tone: "warning",
            title: `Possible prompt-injection pattern in ${field}`,
            summary:
              `Deterministic scan matched ${findings.map((f) => f.pattern).join(", ")}: "${findings[0].excerpt.slice(0, 240)}". ` +
              "The text was passed through unmodified — advisory receipt, generation was not blocked.",
            source: "prompt-safety",
            data: findings
          });
        }
      }
    }

    // Item 6: compute the confidence-calibration curve ONCE per run (not per-proposal) when the flag is on,
    // and thread it into every sizing call. Undefined when off → no DB read and byte-identical behavior.
    const calibrationForSizing: ConfidenceCalibrationStat[] | undefined =
      policy.tuning?.calibrationSizing && policy.accountNumber
        ? getConfidenceCalibration(policy.accountNumber, learningSource, {}, userId, prefetchedFills)
        : undefined;

    // Volatility-targeting sizing (opt-in, default off): precompute annualized realized vol (%) per
    // OPENING candidate symbol, mirroring the atrStopPctBySymbol precompute pattern above so the sync
    // sizer can use it. Gated on volTargeting-or-atrStops being on so we never add fetch load purely
    // for an advisory note when the feature is fully off; bars are shared with the ATR precompute's
    // 30-min cache when a symbol is both an open position and a fresh candidate. Best-effort + bounded:
    // a fetch error or insufficient bars simply leaves that symbol's vol-target note/taper skipped.
    const realizedVolPctBySymbol: Record<string, number> = {};
    if (policy.tuning?.volTargeting === true || policy.atrStops === true) {
      const openingSymbols = Array.from(
        new Set(
          llmProposals
            .filter((p) => p.side === "buy" || p.side === "short")
            .map((p) => normalizeSymbol(p.symbol))
        )
      );
      await Promise.all(
        openingSymbols.map(async (sym) => {
          try {
            const bars = await fetchDailyOHLC(sym, Date.now(), userId);
            if (!bars) return;
            const vol = realizedVolPct(bars);
            if (typeof vol === "number") realizedVolPctBySymbol[sym] = vol;
          } catch {
            // best-effort — the vol-target note/taper is simply skipped for this symbol
          }
        })
      );
      lockGuard.assertOwned();
    }

    // Extend the ATR stop-DISTANCE precompute to OPENING candidates too (not just held positions),
    // so an "atr" per-position stop plan is genuinely available at time-of-purchase, not only once a
    // position already exists (universal-availability requirement). Gated the same way as the held-
    // position precompute above: account-wide atrStops on, OR any opening candidate explicitly asked
    // for an "atr" plan. Uses the decision-time referencePrice (falling back to the proposed limit
    // price) as the entry anchor since the position doesn't exist yet. Best-effort + bounded, same as
    // the held-position variant above.
    //
    // A DEDICATED map, never the held-position `atrStopPctBySymbol` — a scale-in add's opening
    // candidate can share a symbol with an existing held position, and that held-position entry was
    // computed from the OLD lot's averageCost. Reusing it for the fresh entry would price the new
    // bracket's ATR distance off a stale, possibly very different anchor if the stock moved
    // materially since the original entry (Codex review, PR #1371) — so opening candidates always
    // get their OWN fresh computation here, never skipped just because the symbol is also held.
    const atrStopPctByOpeningSymbol: Record<string, number> = {};
    // Checks BOTH an explicit stopPlan on the proposal AND an INHERITED one from stopPlanBySymbol —
    // a scale-in that omits stopPlan (inheriting the symbol's persisted "atr" plan) still gets that
    // plan applied by enrichOpeningProposal below, so the opening ATR precompute must gate the same
    // way or the inherited plan prices off the flat/8% fallback instead of a fresh ATR distance
    // (Codex review, PR #1371).
    const anyOpeningAtrPlan = llmProposals.some(
      (p) =>
        (p.side === "buy" || p.side === "short") &&
        (p.stopPlan?.style === "atr" || (!p.stopPlan && stopPlanBySymbol[normalizeSymbol(p.symbol)] === "atr"))
    );
    if (policy.atrStops === true || anyOpeningAtrPlan) {
      const period = Math.round(policy.riskRules.atrStopPeriod ?? 14);
      const multiple = policy.riskRules.atrStopMultiple ?? 2.0;
      // Anchor to the proposal's own referencePrice/limitPrice first, falling back to this run's
      // market-scan quote — a market or stop-entry proposal often has neither price stamped yet, but
      // the scan quote is the same anchor enrichOpeningProposal itself falls back to for these
      // (Codex review, PR #1371).
      const openingEntryEstimate = (p: TradeProposal): number =>
        p.referencePrice ?? p.limitPrice ?? marketScan.quotesBySymbol[normalizeSymbol(p.symbol)]?.price ?? 0;
      const openingCandidates = llmProposals.filter(
        (p) => (p.side === "buy" || p.side === "short") && openingEntryEstimate(p) > 0
      );
      await Promise.all(
        openingCandidates.map(async (p) => {
          const sym = normalizeSymbol(p.symbol);
          const entryEstimate = openingEntryEstimate(p);
          try {
            // Daily bars are cached (~30 min) — a symbol that's ALSO a held position reuses the same
            // fetch the held-position pass above already made; only the pct computation re-runs with
            // this fresh entry anchor.
            const bars = await fetchDailyOHLC(sym, Date.now(), userId);
            if (!bars) return;
            const pct = atrStopPct(atr(bars, period), entryEstimate, multiple);
            if (typeof pct === "number") atrStopPctByOpeningSymbol[sym] = pct;
          } catch {
            // best-effort — falls back to the fixed/beta stop for this candidate
          }
        })
      );
      lockGuard.assertOwned();
    }

    // Portfolio-heat budget (opt-in, default off): compute the CURRENT book's heat ONCE per run (not
    // per-proposal) from existing positions, reusing the SAME stop-basis precedence as
    // generateProactiveRiskProposals' effectiveStopPct (ATR > beta-scaled > flat) so heat reflects the
    // same protective distances the app already manages. Never fabricates a stop for a position with
    // no basis — computePortfolioHeat excludes it from totalRiskUsd and flags it in perPosition instead.
    let bookHeat: PortfolioHeatResult | undefined;
    if (policy.tuning?.volTargeting === true && (policy.tuning?.portfolioHeatBudgetPct ?? 0) > 0) {
      const flatStopPct = policy.riskRules.stopLossPct ?? 0;
      const betaStopsOn = policy.betaScaledStops === true;
      const stopPctBySymbol: Record<string, number> = {};
      for (const p of workingPositions) {
        if (Math.abs(p.quantity) <= 0.000001) continue;
        const sym = normalizeSymbol(p.symbol);
        const baseStop = p.quantity < 0 ? (policy.riskRules.shortStopLossPct ?? flatStopPct) : flatStopPct;
        // A per-position stop PLAN overrides the account-wide distance chain for heat purposes too —
        // without this, a "none" plan (genuinely no stop basis) got counted as if a flat/ATR/beta
        // stop still limited its risk (UNDERSTATING true book risk and letting the heat taper admit
        // more size than it should), while "fixed"/"atr" plans on a bare account (no flatStopPct
        // configured) were excluded as "no stop basis" even though they're GUARANTEED a distance via
        // STOP_PLAN_FALLBACK_STOP_PCT (Codex review, PR #1371).
        const plan: StopPlanStyle = stopPlanBySymbol[sym] ?? "default";
        if (plan === "none") continue; // no stop basis at all — excluded from heat, never estimated
        if (plan === "trailing") {
          // The trail distance IS this position's effective worst-case distance for heat purposes.
          const trailPct = policy.riskRules?.trailingStopPct ?? 0;
          stopPctBySymbol[sym] = trailPct > 0 ? trailPct : STOP_PLAN_FALLBACK_STOP_PCT;
          continue;
        }
        if (plan === "fixed") {
          stopPctBySymbol[sym] = baseStop > 0 ? baseStop : STOP_PLAN_FALLBACK_STOP_PCT;
          continue;
        }
        if (plan === "atr") {
          const atrPct = atrStopPctBySymbol[sym];
          stopPctBySymbol[sym] =
            typeof atrPct === "number" && Number.isFinite(atrPct) && atrPct > 0
              ? atrPct
              : baseStop > 0 ? baseStop : STOP_PLAN_FALLBACK_STOP_PCT;
          continue;
        }
        if (baseStop <= 0) continue;
        const atrPct = atrStopPctBySymbol[sym];
        const resolved =
          typeof atrPct === "number" && Number.isFinite(atrPct) && atrPct > 0
            ? atrPct
            : betaScaledStopPct(baseStop, betaBySymbol[sym], betaStopsOn);
        if (typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0) {
          stopPctBySymbol[sym] = resolved;
        }
      }
      const equity = accountEquity(workingPortfolio);
      bookHeat = computePortfolioHeat(
        workingPositions
          .filter((p) => Math.abs(p.quantity) > 0.000001)
          .map((p) => ({ symbol: normalizeSymbol(p.symbol), marketValue: p.marketValue })),
        stopPctBySymbol,
        flatStopPct > 0 ? flatStopPct : undefined,
        equity
      );
    }

    // OPTIONAL negative-expectancy gate (default off): drop an opening proposal whose PROVEN thesis
    // has a negative post-cost realized edge BEFORE sizing it — the conservative "don't open a proven
    // money-loser" stance. Unproven theses pass through to the sizer's intentional exploratory floor.
    const sizedProposals = llmProposals
      .filter((p) => {
        const gate = shouldSkipNegativeExpectancy(p, policy, learningSource, userId, prefetchedFills);
        if (gate.skip) {
          console.log(`[NegEV] Skipped ${p.symbol} ${p.side}: ${gate.reason}`);
          audit("proposal_skipped_negative_ev", { symbol: p.symbol, side: p.side, thesisTag: p.tradeThesisTag, reason: gate.reason }, userId, connectedAccountId);
        }
        return !gate.skip;
      })
      .map((p) => {
        const sized = applyDeterministicSizing(p, policy, workingPortfolio, learningSource, userId, workingPositions, marketScan, calibrationForSizing, realizedVolPctBySymbol, bookHeat, prefetchedFills, stopPlanBySymbol);
        const overrideSized = applySocraticOverrideSizing(sized, policy, workingPortfolio);
        return enrichOpeningProposal(overrideSized, policy, marketScan, atrStopPctByOpeningSymbol, stopPlanBySymbol, stopPlanRationaleBySymbol);
      });

    const debatedProposals: TradeProposal[] = [];
    // The Red Team review is REQUIRED for every risk-adding opening. If it could not run (no model
    // chosen, no key, provider error, timeout, malformed verdict) we FAIL CLOSED: keep the proposal
    // but route it to a human rather than auto-executing an un-reviewed opening with real capital.
    // The live placement path below checks this set and downgrades these to status "proposed".
    const requiresHumanReview = new Set<TradeProposal>();

    // ── The SINGLE Red Team review (docs/single-adversary-consolidation.md §3) ──────────────────
    // Universal coverage (O2): every risk-adding opening is reviewed — no conviction gate, no
    // stakes-scaled triggering. Exits and net-risk-reducing trades are structurally EXEMPT (§3.5 /
    // R5): they never reach the reviewer, so a verdict can never block or shrink de-risking.
    // Reviews run concurrently with a small bounded pool (R4) so universal coverage doesn't extend
    // the per-user scheduler-lock hold: worst-case wall clock is ceil(openings/3) sequential rounds
    // instead of `openings` sequential calls.
    const openingsToReview = sizedProposals.filter((p) => isRiskAddingOpening(p, workingPositions));
    const reviewResults = new Map<TradeProposal, RedTeamDebateResult>();
    await mapWithConcurrency(openingsToReview, 3, async (proposal) => {
      const quote = marketScan.topCandidates.find(
        (c) => normalizeSymbol(c.symbol) === normalizeSymbol(proposal.symbol)
      );
      try {
        // Pass the run-scoped `runPolicy` explicitly (R17 — rather than letting debateProposal
        // re-read the user-level getPolicy) so the account-scoped Red model/reasoning AND any
        // usage-budget Phase 2 downgrade actually reach the reviewer's model resolution.
        const result = await debateProposal(proposal, quote, userId, runPolicy, {
          context: adversaryContext,
          sizing: {
            estimatedNotional: estimateNotional(proposal),
            sizeBasis: typeof proposal.quantity === "number" && proposal.quantity > 0 ? "quantity" : "notional"
          }
        });
        reviewResults.set(proposal, result);
      } catch (error) {
        // debateProposal's contract is to never throw, but a review that somehow does must still
        // fail CLOSED, not open.
        console.error(`[RedTeam] review threw for ${proposal.symbol} ${proposal.side}:`, error);
        reviewResults.set(proposal, {
          rejected: false,
          available: false,
          reason: `Red Team review threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          failureKind: "provider_error"
        });
      }
    });
    lockGuard.assertOwned();

    for (const proposal of sizedProposals) {
      const redTeamResult = reviewResults.get(proposal);
      if (!redTeamResult) {
        // Exempt by §3.5: an exit or a net-risk-reducing trade — passes through untouched, never
        // reviewed, never holdable by the adversary.
        debatedProposals.push(proposal);
        continue;
      }
      {
        // First-class verdict for the approval card's "Red Team Review" block. Keep the
        // rationale-append text below too for backward compatibility with anything reading the string.
        proposal.redTeamVerdict = {
          ...(redTeamResult.verdict ? { verdict: redTeamResult.verdict } : {}),
          rejected: redTeamResult.rejected,
          available: redTeamResult.available,
          reason: redTeamResult.reason,
          // The model that actually served the review — persisted so the approval card's red-team
          // badge doesn't drift with later policy edits.
          ...(redTeamResult.model ? { model: redTeamResult.model } : {}),
          // Universal coverage: every review since the consolidation runs because the trade is a
          // risk-adding opening. (Legacy persisted verdicts carry the old dissent-trigger values.)
          trigger: "all_openings",
          // Structured failure classification ("RED TEAM FAILED" flag) — absent when available.
          ...(redTeamResult.failureKind ? { failureKind: redTeamResult.failureKind } : {})
        };
        if (redTeamResult.model) {
          proposal.reviewedByModel = redTeamResult.model;
        }
        if (redTeamResult.rejected) {
          console.log(`[Debate] Rejected ${proposal.symbol} ${proposal.side}: ${redTeamResult.reason}`);
          // Pre-veto override (Veto B): an available-and-rejecting Bear is ADVISORY when the agent
          // attaches an autonomyOverride thesis to an OPENING and socraticOverrideMode isn't "off".
          // In that case we TAG the proposal with an overridable `red_team_veto:` reason and fall
          // through to debatedProposals (NO continue) — the sized override decision then happens once
          // at resolveSocraticOverride. Otherwise the Bear genuinely kept the trade out and we keep
          // today's exact behavior (audit + missed-opportunity counterfactual + continue).
          const isOpening = proposal.side === "buy" || proposal.side === "short";
          const overrideRequested =
            isOpening &&
            proposal.autonomyOverride?.requested === true &&
            !!proposal.autonomyOverride.thesis?.trim() &&
            policy.socraticOverrideMode !== "off";

          if (overrideRequested) {
            // ADVISORY path — tag, do NOT continue. FIX #1: emit a DISTINCT audit kind
            // (red_team_veto_overridden) and DO NOT write the missed-opportunity counterfactual. This
            // trade may actually EXECUTE, so recording it as a Bear-vetoed missed opportunity would
            // corrupt getRedTeamEfficacy() (it keys strictly off proposal_rejected_by_red_team joined
            // to the counterfactual return) — double-booking the same symbol as both a missed winner
            // and a real position. Override payoff is measured through the matured-position path
            // (frameworkProposalFromDecision's "Review overridden gate") instead.
            audit(
              "red_team_veto_overridden",
              {
                runId,
                symbol: proposal.symbol,
                side: proposal.side,
                thesisTag: proposal.tradeThesisTag,
                reason: redTeamResult.reason,
                model: redTeamResult.model,
                mode: policy.socraticOverrideMode
              },
              userId,
              connectedAccountId
            );
            proposal.redTeamVerdict = { ...proposal.redTeamVerdict!, rejected: true, overridden: true };
            proposal.preVetoReasons = [...(proposal.preVetoReasons ?? []), `red_team_veto: ${redTeamResult.reason}`];
            // fall through to debatedProposals.push(proposal) — NO continue
          } else {
            // Audit the Bear veto (parity with proposal_skipped_negative_ev / proposal_skipped_correlation)
            // so a rejected high-conviction trade is visible in the Activity/Audit feed, not just console.
            // runId + model are stamped so getRedTeamEfficacy() can join this veto to its matured
            // counterfactual return (joined by runId+symbol) and break efficacy out per red-team model.
            // connectedAccountId keeps the audit ACCOUNT-scoped in multi-account runs, matching the
            // counterfactual row it joins to (Codex review on PR #365) — a user-wide row would let one
            // account's vetoes bleed into another account's efficacy scorecard.
            audit("proposal_rejected_by_red_team", { runId, symbol: proposal.symbol, side: proposal.side, thesisTag: proposal.tradeThesisTag, reason: redTeamResult.reason, model: redTeamResult.model }, userId, connectedAccountId);
            // Feed a Bear-VETOED OPENING proposal into the same counterfactual pipeline as a policy
            // block / human rejection (same three-way parity: policy blocks at ~line 1010, human
            // rejections in rejectProposal) so its post-veto return matures into missed-opportunity
            // analytics and getRedTeamEfficacy() below — the Red Team's own vetoes were previously the
            // one rejection path with zero downstream measurement. Opening sides only (a vetoed exit
            // is not a missed opportunity); best-effort + non-fatal. If this symbol also appears in the
            // run's signal_snapshot (chosen: false), the later snapshot ingestion BACKFILLS the
            // score/sector/factor/bulletin evidence onto this early row — see
            // insertSkippedCounterfactualCandidate's NULL-backfill contract (Codex review on PR #365).
            if (proposal.side === "buy" || proposal.side === "short") {
              try {
                recordRejectedProposalCounterfactual({
                  userId,
                  connectedAccountId,
                  runId,
                  symbol: proposal.symbol,
                  refPrice: proposal.referencePrice,
                  createdAt: new Date().toISOString(),
                  regime: proposal.entryMarketRegime
                });
              } catch (err) {
                console.warn("[strategy] red-team-vetoed counterfactual failed:", err instanceof Error ? err.message : String(err));
              }
            }
            // R8 — persist the rejection as a durable trade_proposals row (status
            // "rejected_by_red_team") before dropping it, matching the policy-block / broker-decline
            // paths, so the adversary's most important negative verdict is visible in operator
            // review and learning telemetry, not just the audit feed. Best-effort + non-fatal.
            try {
              insertProposal({
                userId,
                executionMode,
                promptVersion: STRATEGY_PROMPT_VERSION,
                id: crypto.randomUUID(),
                runId,
                accountNumber: policy.accountNumber,
                proposal,
                decision: {
                  approved: false,
                  reasons: [`red_team_veto: ${redTeamResult.reason}`]
                } satisfies PolicyDecision,
                estimatedNotional: estimateNotional(proposal),
                status: "rejected_by_red_team"
              });
            } catch (err) {
              console.warn("[strategy] persisting red-team rejection row failed:", err instanceof Error ? err.message : String(err));
            }
            // Skip this proposal completely, as the Red Team found a critical flaw
            continue;
          }
        } else if (!redTeamResult.available) {
          // FAIL CLOSED (§3.7): the review could not run for this risk-adding opening — hold it for
          // human approval across ALL failure modes (not-configured / timeout / provider error /
          // rate-limit / malformed verdict). Only openings can reach here (§3.5 exempts everything
          // risk-reducing before the review), so routeOnAdversaryUnavailable's opening branch always
          // holds; the routing note stays authority-aware for the rationale text.
          const routing = routeOnAdversaryUnavailable(
            proposal.side,
            redTeamResult.failureKind,
            redTeamResult.reason,
            policy.tuning?.deRiskExitsOnAdversaryUnavailable,
            policy.strategyAuthority === "decide"
          );
          console.warn(
            `[RedTeam] review unavailable for ${proposal.symbol} ${proposal.side} (${redTeamResult.reason}); routing to human review.`
          );
          proposal.rationale += routing.note;
          if (routing.holdForHuman) requiresHumanReview.add(proposal);
          audit(
            "strategy_red_team_unavailable",
            { runId, symbol: proposal.symbol, side: proposal.side, reason: redTeamResult.reason, failureKind: redTeamResult.failureKind, heldForHuman: routing.holdForHuman },
            userId,
            connectedAccountId
          );
        } else if (redTeamResult.verdict === "approve-at-half") {
          // §3.3 / R1 / R2 — the single allowed discrete haircut, applied to the finalized order.
          // Down-only: when 0.5× is NOT placeable (sub-share limit order, bracket-invalidating
          // notional), the proposal is HELD for human review at full size — never silently traded
          // at a size larger than the reviewer approved, never up-sized.
          const haircut = applyRedTeamHalfSize(proposal);
          if (haircut.applied) {
            proposal.rationale += `\n\nRed Team verdict: approve-at-half — ${redTeamResult.reason} [${haircut.note}]`;
            audit(
              "red_team_approved_at_half",
              { runId, symbol: proposal.symbol, side: proposal.side, thesisTag: proposal.tradeThesisTag, reason: redTeamResult.reason, model: redTeamResult.model, haircut: haircut.note },
              userId,
              connectedAccountId
            );
          } else {
            proposal.rationale += `\n\nRed Team verdict: approve-at-half — ${redTeamResult.reason}\n\n⚠ Half-size is not placeable (${haircut.note}); routed to human approval instead of proceeding at full size.`;
            requiresHumanReview.add(proposal);
            audit(
              "red_team_half_size_unplaceable",
              { runId, symbol: proposal.symbol, side: proposal.side, thesisTag: proposal.tradeThesisTag, reason: redTeamResult.reason, model: redTeamResult.model, why: haircut.note, heldForHuman: true },
              userId,
              connectedAccountId
            );
          }
        } else {
          proposal.rationale += `\n\nRed Team Review Survived: ${redTeamResult.reason}`;
        }
      }
      debatedProposals.push(proposal);
    }

    // Earnings-proximity advisory tag — applied HERE (before the rationale-collapse gate, FIX#3
    // pre-routing, and the sell-to-fund intended-notional computation below), NOT at the later
    // `gatedProposals`/`applyRiskReceipts` stage near the end of the pipeline. Both the FIX#3
    // pre-routing loop and the sell-to-fund notional filter read `preVetoReasons` to decide whether an
    // opening will actually auto-execute; tagging `earnings_blackout` after those checks run would let
    // a blackout-tagged opening slip through un-excluded for one run — the exact hazard
    // `preVetoTaggedOpeningWillPlace`'s doc comment warns about, for this lane's own new tag. See
    // `applyEarningsBlackoutTag`'s doc comment for the idempotency contract with `applyRiskReceipts`.
    applyEarningsBlackoutTag(debatedProposals, policy, marketScan, userId);

    // Rationale-collapse gate (Chat A item 7) — evaluated on the OPENING proposals HERE, BEFORE the
    // sell-to-fund planner below, so a collapse-gated buy (routed to human review) does NOT drive
    // automated funding sells: intendedOpeningNotional excludes requiresHumanReview openings, and by
    // gating first the collapsed buys are already in that set (same hazard the Bear-unavailable gate
    // avoids). Gates on the openings' OWN diversity; default OFF (=== true). Exits are never gated. The
    // full-set advisory warning stays below, after the final proposal set is assembled.
    if (policy.tuning?.gateOnRationaleCollapse === true) {
      const gatedOpenings = debatedProposals.filter((p) => p.side === "buy" || p.side === "short");
      const openingDiversity = computeRationaleDiversity(gatedOpenings.map((p) => p.rationale));
      if (openingDiversity.collapsed) {
        for (const p of gatedOpenings) {
          p.rationale += `\n\nRationale-diversity gate: this run's opening proposals collapsed to near-identical reasoning (mean similarity ${openingDiversity.meanPairwiseSimilarity.toFixed(3)} > ${openingDiversity.threshold}); routed to human approval.`;
          requiresHumanReview.add(p);
        }
        if (gatedOpenings.length > 0) {
          console.warn(`[strategy] Rationale-collapse gate ON — routing ${gatedOpenings.length} opening proposal(s) to human review.`);
          audit(
            "strategy_rationale_collapse_gated",
            { runId, count: gatedOpenings.length, meanSimilarity: openingDiversity.meanPairwiseSimilarity, threshold: openingDiversity.threshold },
            userId,
            connectedAccountId
          );
        }
      }
    }

    // FIX #3 — propose-mode override pre-routing. The pre-veto fold-in + override resolution happen
    // LATER, inside the placement loop (before resolveSocraticOverride), which is AFTER the sell-to-
    // fund planner below reads `requiresHumanReview` (intendedOpeningNotional excludes members of that
    // set). An opening that carries a pre-veto tag + a requested override thesis will, in "propose"
    // mode, route to human — so it must be in requiresHumanReview NOW, or the planner would drive
    // automated funding sells for a buy that never auto-executes. This mirrors the Bear-unavailable
    // and rationale-collapse gates above and works precisely because it sits before line ~882. Cheap
    // pure predicate — no sizing; the AUTHORITATIVE sized cap/mode decision still runs once at the
    // override call inside the loop. (execute mode self-executes and needs no pre-route; off keeps the
    // block, so only propose pre-routes here.)
    if (policy.socraticOverrideMode === "propose") {
      for (const p of debatedProposals) {
        const isOpening = p.side === "buy" || p.side === "short";
        if (isOpening && p.preVetoReasons?.length && p.autonomyOverride?.requested === true && !!p.autonomyOverride.thesis?.trim()) {
          requiresHumanReview.add(p);
        }
      }
    }

    // ── Sell-to-fund-buy (PR 3) ──────────────────────────────────────────────
    // When this run's intended BUYs exceed buying power, optionally raise cash by trimming holdings.
    // Default "off" → no-op. "suggest" only records the plan (audit + run summary); "propose" queues
    // the funding sells for human approval; "automated" lets them ride the account's existing
    // authority (auto-placed only when already in "decide"). Funding sells carry tradeThesisTag
    // "Sell-to-Fund" so the execution loop can route propose-mode ones correctly.
    const sellToFundMode = policy.sellToFundBuy ?? "off";
    let fundingSells: TradeProposal[] = [];
    let sellToFundNote = "";
    if (sellToFundMode !== "off") {
      const isOpening = (p: TradeProposal) => p.side === "buy" || p.side === "short";
      // Only fund openings that will ACTUALLY be placed this run. An opening routed to human review
      // (e.g. a Bear-unavailable or rationale-collapse-gated buy) must not drive automated funding
      // sells — otherwise in "decide" mode we'd auto-liquidate holdings to fund buys that are merely
      // queued for approval and won't execute (potentially leaving the account short on buying power).
      // Also exclude a pre-veto-TAGGED opening that won't auto-execute (no override thesis / mode !=
      // execute): the fold-in below keeps it blocked, so — like the pre-tag-not-drop hard drop — it
      // must contribute $0 and never trigger funding sells (preVetoTaggedOpeningWillPlace).
      const intendedOpeningNotional = debatedProposals.filter((p) => isOpening(p) && !requiresHumanReview.has(p) && preVetoTaggedOpeningWillPlace(p, policy.socraticOverrideMode)).reduce((sum, p) => {
        const price = currentPrices[normalizeSymbol(p.symbol)] ?? p.referencePrice ?? 0;
        const notional = p.dollarAmount ?? (p.quantity ? p.quantity * price : 0);
        return sum + (Number.isFinite(notional) ? notional : 0);
      }, 0);
      // Never sell a name we're trading this run (buy targets, or already-proposed exits/trims).
      const exclude = [
        ...debatedProposals.filter(isOpening).map((p) => normalizeSymbol(p.symbol)),
        ...proactiveProposals.map((p) => normalizeSymbol(p.symbol)),
        ...debatedProposals.filter((p) => p.side === "sell" || p.side === "cover").map((p) => normalizeSymbol(p.symbol))
      ];
      const plan = planFundingSells({
        mode: sellToFundMode,
        buyingPower: workingPortfolio.buyingPower,
        intendedOpeningNotional,
        positions: workingPositions.map((p) => ({ symbol: normalizeSymbol(p.symbol), quantity: p.quantity, marketValue: p.marketValue, averageCost: p.averageCost })),
        currentPrices,
        excludeSymbols: exclude
      });
      if (plan.sells.length > 0) {
        audit(
          "sell_to_fund_plan",
          { mode: sellToFundMode, shortfall: plan.shortfall, raised: plan.raised, summary: plan.summary, sells: plan.sells.map((s) => ({ symbol: s.symbol, quantity: s.quantity })) },
          userId,
          connectedAccountId
        );
        sellToFundNote = `Sell-to-fund-buy (${sellToFundMode}): ${plan.summary}`;
        // suggest = record only; propose/automated = actually emit the sells into the pipeline.
        if (sellToFundMode === "propose" || sellToFundMode === "automated") fundingSells = plan.sells;
      }
    }

    const gatedProposals = await applyCorrelationClusterGate(
      [...fundingSells, ...proactiveProposals, ...debatedProposals],
      policy,
      workingPositions,
      userId,
      assertOwned
    );
    lockGuard.assertOwned();

    // Advisory correlation/stress/earnings-proximity receipts on the final opening proposal set —
    // receipts only, never a gate. See applyRiskReceipts's doc comment for the flag semantics.
    const proposals = await applyRiskReceipts(gatedProposals, policy, workingPositions, workingPortfolio, marketScan, userId, assertOwned);
    lockGuard.assertOwned();

    // Rationale-diversity check (improvement-program item #8). Computed on the final post-debate,
    // post-gate proposal set. Advisory by default; an optional default-off gate can route collapsed
    // runs to human review (Chat A item 7).
    const rationaleDiversity = computeRationaleDiversity(proposals.map((p) => p.rationale));
    if (rationaleDiversity.collapsed) {
      console.warn(
        `[strategy] Rationale collapse detected: mean pairwise similarity ${rationaleDiversity.meanPairwiseSimilarity.toFixed(3)} > threshold ${rationaleDiversity.threshold} across ${rationaleDiversity.count} proposal(s). LLM may be emitting boilerplate reasoning.`
      );
      // Emit the diversity-collapse decision point as a queryable Langfuse observation (no-op when
      // Langfuse is unconfigured). Advisory only — never blocks/drops/modifies proposals.
      await recordDecisionObservation({
        name: "trading.strategy.diversity-collapse",
        userId,
        metadata: {
          promptVersion: STRATEGY_PROMPT_VERSION,
          meanPairwiseSimilarity: Number(rationaleDiversity.meanPairwiseSimilarity.toFixed(4)),
          threshold: rationaleDiversity.threshold,
          proposalCount: rationaleDiversity.count,
          runId
        },
        tags: ["strategy", "diversity-collapse"]
      });
      lockGuard.assertOwned();
    }
    // (The rationale-collapse GATE that routes collapsed openings to human review runs EARLIER — before
    // sell-to-fund planning — so a gated buy can't drive automated funding sells. Only the advisory
    // full-set warning above remains here.)

    const results = completedProposalResults;
    const recordSocraticDecision = (input: {
      proposalId: string;
      proposal: TradeProposal;
      decision: PolicyDecision;
      status: string;
      review?: ReviewedOrder;
      overrideResolution?: SocraticOverrideResolution;
    }) => {
      try {
        const now = new Date().toISOString();
        const caseFile = {
          ...buildSocraticDecisionCase({
            userId,
            connectedAccountId,
            runId,
            proposalId: input.proposalId,
            accountNumber: policy.accountNumber,
            proposal: input.proposal,
            status: socraticStatusFromProposalStatus(input.status),
            authority: policy.strategyAuthority,
            decision: input.decision,
            review: input.review,
            marketScan,
            ragAttributions: socraticRagAttributions,
            overrideResolution: input.overrideResolution,
            // Run-level advisory prompt-safety receipts (injection scan + evidence-age anomalies).
            ...(promptSafetyEvidence.length > 0 ? { extraEvidence: promptSafetyEvidence } : {}),
            // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06) — persistence only.
            ...(ragRetrievalStatusRows.length > 0 ? { ragRetrievalStatus: ragRetrievalStatusRows } : {})
          }),
          createdAt: now,
          updatedAt: now
        } satisfies SocraticDecisionCase;
        upsertSocraticDecisionCase(caseFile);
        void indexSocraticDecisionMemory(caseFile).catch((err) => {
          console.warn("[strategy] Socratic memory indexing failed:", err instanceof Error ? err.message : String(err));
        });
        const framework = frameworkProposalFromDecision(caseFile);
        if (framework) createSocraticFrameworkProposal(framework);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[strategy] Socratic decision recording failed:", message);
        try {
          audit(
            "socratic_case_write_failed",
            { runId, proposalId: input.proposalId, symbol: input.proposal.symbol, status: input.status, error: message },
            userId,
            connectedAccountId
          );
        } catch { /* audit itself must not throw */ }
      }
    };

    for (const proposal of proposals) {
      // A failed heartbeat is sticky for this invocation. Stop before doing any more proposal work,
      // then re-prove ownership again immediately before a broker placement below.
      lockGuard.assertOwned();
      const normalizedProposal = { ...proposal, symbol: normalizeSymbol(proposal.symbol) };
      const tradability = await gateway.getEquityTradability(policy.accountNumber, [normalizedProposal.symbol]);
      lockGuard.assertOwned();
      if (!tradability[normalizedProposal.symbol]?.tradable) {
        const decision = { approved: false, reasons: [tradability[normalizedProposal.symbol]?.reason ?? "Symbol is not tradable."] };
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked" });
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        lockGuard.assertOwned();
        autoRevertOnCapBreach(decision.reasons, policy, userId, connectedAccountId);
        continue;
      }

      let review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal });
      lockGuard.assertOwned();

      // Hoisted above the broker-minimum guard: the bump planner bounds opening bumps by the
      // remaining daily/hourly budget. Values are unchanged for the post-guard consumers (the
      // skip path `continue`s without placing anything).
      const dailyNow = dailyExecutionStats(policy.accountNumber, new Date(), userId);
      const hourlyNow = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);

      // Broker-minimum pre-flight guard. Default handling is BUMP (owner ruling 2026-07-09: an
      // order that lands under the broker's minimum dollar/fractional size — e.g. Robinhood's $1
      // floor, typically a pct-of-NAV-clamped trim on a small account — is raised TO the floor and
      // placed, honestly audited, rather than skipped). brokerMinimumHandling = "skip" restores the
      // old behavior: block it before the broker's guaranteed reject, with a cooldown-gated alert.
      // Bumps the planner can't make safe/executable (unknown floor, unknown held position on
      // exits, opening bumps past the policy cap or remaining daily/hourly budget) fall back to
      // that skip path. positionQuantity lets the guard exempt a whole-position dust exit
      // (Robinhood allows selling an entire fractional position even below its $1 minimum) and
      // caps sell-bumps at the full position; dollar-based exits convert to position-bounded
      // quantity orders. The bumped order is re-reviewed by the broker and then continues into
      // evaluateTradeProposal like any other — a bump never bypasses policy evaluation.
      const heldForMinimumGuard = workingPositions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(normalizedProposal.symbol));
      let brokerMinimumBlockReason = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...normalizedProposal, positionQuantity: heldForMinimumGuard?.quantity });
      let attemptedBumpToNotional: number | undefined;
      if (brokerMinimumBlockReason && (policy.brokerMinimumHandling ?? "bump") === "bump") {
        // Max placeable OPENING notional = the policy engine's own per-order cap (incl. its 5%
        // headroom — evaluateTradeProposal enforces the headroomed value, and deterministic
        // sizing already declines its floor-raise against the same number) further bounded by
        // the remaining daily/hourly budget. Anything the planner bumps past this would be
        // policy-rejected every run — and a cap breach can demote authority via
        // autoRevertOnCapBreach, which the app must never self-inflict with its own up-sizing.
        const effectiveMaxDailyNotional = Math.min(
          policy.maxDailyNotional ?? Infinity,
          policy.maxDailyPctOfNav ? (policy.maxDailyPctOfNav / 100) * workingPortfolio.totalMarketValue : Infinity
        );
        const openingCapNotional = Math.min(
          applyOpeningOrderHeadroom(openingPolicyNotionalCap(normalizedProposal, policy, workingPortfolio)),
          effectiveMaxDailyNotional - dailyNow.notional,
          (policy.maxHourlyNotional ?? Infinity) - hourlyNow.notional,
          // Mirror policy.ts's buying-power gate (binds when finite && > 0): a bump past available
          // buying power would be policy-rejected every run instead of falling back to skip.
          Number.isFinite(workingPortfolio.buyingPower) && workingPortfolio.buyingPower > 0 ? workingPortfolio.buyingPower : Infinity
        );
        // Daily ORDER-COUNT budget (not just notional): when the opening-order count is already
        // spent, no bump can make this order placeable — planning one would only manufacture the
        // policy rejection (and authority demotion) this block exists to avoid.
        const openingCountSpent =
          (normalizedProposal.side === "buy" || normalizedProposal.side === "short") &&
          policy.maxDailyOrders != null &&
          dailyNow.openingOrderCount >= policy.maxDailyOrders;
        const bumpPlan = openingCountSpent ? undefined : planBrokerMinimumBump(
          review,
          policy.activeBroker,
          { ...normalizedProposal, positionQuantity: heldForMinimumGuard?.quantity, positionMarketValue: heldForMinimumGuard?.marketValue },
          { openingCapNotional: Number.isFinite(openingCapNotional) ? openingCapNotional : undefined }
        );
        if (bumpPlan) {
          const originalSizing = { quantity: normalizedProposal.quantity, dollarAmount: normalizedProposal.dollarAmount };
          const originalReview = review;
          Object.assign(normalizedProposal, bumpPlan.patch);
          review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal });
          lockGuard.assertOwned();
          const stillBlocked = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...normalizedProposal, positionQuantity: heldForMinimumGuard?.quantity });
          if (!stillBlocked) {
            // Receipt honesty: the rationale narrates the pre-bump size, so annotate the
            // up-sizing the same way other size-changing steps do.
            normalizedProposal.rationale = `${normalizedProposal.rationale} [Sized up from $${bumpPlan.fromNotional.toFixed(2)} to meet the broker's minimum order size (brokerMinimumHandling: bump).]`;
            audit(
              "order_bumped_broker_minimum",
              { runId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, fromNotional: bumpPlan.fromNotional, toNotional: review.estimatedNotional, reason: brokerMinimumBlockReason },
              userId,
              connectedAccountId
            );
          } else {
            // Failed bump: restore the original sizing + review so the skip receipt shows what
            // the strategy actually proposed, and record that a bump was attempted.
            Object.assign(normalizedProposal, originalSizing);
            review = originalReview;
            attemptedBumpToNotional = bumpPlan.toNotional;
          }
          brokerMinimumBlockReason = stillBlocked ? brokerMinimumBlockReason : undefined;
        }
      }
      if (brokerMinimumBlockReason) {
        const decision: PolicyDecision = { approved: false, reasons: [brokerMinimumBlockReason] };
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked", review });
        audit(
          "order_skipped_broker_minimum",
          { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, ...(attemptedBumpToNotional !== undefined ? { attemptedBumpToNotional } : {}) },
          userId,
          connectedAccountId
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: [brokerMinimumBlockReason] });
        if (shouldAlertBrokerMinimumOrderBlock(policy.accountNumber, normalizedProposal.symbol)) {
          await sendNotification(
            {
              type: "block",
              title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} skipped (below broker minimum)`,
              payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
            },
            { policy, userId }
          );
          lockGuard.assertOwned();
        }
        continue;
      }

      const isLiveExecution = executionMode === "broker/live";
      let decision = evaluateTradeProposal(normalizedProposal, {
        policy,
        portfolio: workingPortfolio,
        positions: workingPositions,
        dailyNotionalUsed: dailyNow.notional,
        hourlyNotionalUsed: hourlyNow.notional,
        dailyOrderCount: dailyNow.openingOrderCount,
        estimatedNotional: review.estimatedNotional,
        marketScan,
        washSaleLocks,
        // ConnectedAccount taxationType is the SOURCE OF TRUTH for the buyer's tax regime (wins
        // over policy taxSettings; capabilities can be absent/"brokerage" on legacy IRA rows) —
        // required so the IRA-replacement hard block (Rev. Rul. 2008-5) can never miss an IRA.
        accountTaxationType: activeAccount?.taxationType,
        accountCapabilities: selected?.capabilities,
        isLiveExecution,
        // PDT gate (FINRA Rule 4210): only meaningful for LIVE execution — skip the count entirely otherwise.
        priorDayTradeCount: isLiveExecution
          ? countDayTradesInLastBusinessDays(policy.accountNumber, 5, new Date(), userId)
          : 0
      });

      // Pre-veto fold-in (Option 2): the two PRE-POLICY vetoes (deterministic-bear filter + approval-
      // time Red Team) no longer DROP a candidate — they TAG it with advisory `preVetoReasons`. Fold
      // those reasons into the single sized PolicyDecision right here, before the one override call, so
      // the SAME resolveSocraticOverride path that governs owner-preference gates also governs the
      // vetoes: `isHardGateReason("deterministic_bear_veto: …")` and `isHardGateReason("red_team_veto:
      // …")` are both false, so they classify as OVERRIDABLE conflicts and an autonomyOverride thesis
      // can pass them on openings (subject to socraticOverrideMode + the override cap on the already-
      // sized notional). With no thesis (or mode "off") they keep the candidate blocked exactly as the
      // old hard-drop did. No parallel override system and no second override call.
      if (normalizedProposal.preVetoReasons?.length) {
        decision = {
          ...decision,
          approved: false,
          reasons: [...decision.reasons, ...normalizedProposal.preVetoReasons]
        };
      }

      // Single-adversary visibility (R18/R19): persist "the Red Team review could not run" and the
      // approve-at-half haircut onto the STORED decision — on EVERY insert path this loop reaches
      // (propose-mode, requiresHumanReview, and even auto-execution) — so the pending-approval
      // badge and later audit reads come from a stable persisted field, not a transient reason
      // array or notification payload. Never flips `approved` here: routing is handled by the
      // requiresHumanReview set / propose authority.
      const redTeamState = normalizedProposal.redTeamVerdict;
      if (redTeamState && !redTeamState.available) {
        decision = {
          ...decision,
          adversaryUnavailable: true,
          adversaryUnavailableReason: redTeamState.reason,
          reasons: [
            ...decision.reasons,
            `Red Team review unavailable (${describeRedTeamFailureKind(redTeamState.failureKind)}): ${redTeamState.reason}`
          ]
        };
      } else if (redTeamState?.verdict === "approve-at-half") {
        decision = {
          ...decision,
          reasons: [...decision.reasons, `Red Team approve-at-half haircut applied: ${redTeamState.reason}`]
        };
      }

      // Wash-sale proceed trails (auto_proceeded / ira_disregarded) are NEVER silent, but they are
      // audited at the ACTUAL execution point (auditWashSaleProceed at the live-placed path below),
      // NOT here. Under Ask-first/propose authority (and Red-Team-unavailable /
      // sell-to-fund-propose) an approved gate result only becomes a PENDING card — no purchase has
      // happened yet — so logging "the wash sale was disregarded / the deduction was forfeited" here
      // would be false if the owner rejects or lets it expire. When such a card is later approved,
      // executeProposal emits the same trail (gated on decision.approved) as the order actually places.
      const overrideResolution = resolveSocraticOverride({
        proposal: normalizedProposal,
        policy,
        portfolio: workingPortfolio,
        estimatedNotional: review.estimatedNotional,
        decision
      });
      decision = overrideResolution.decision;
      if (overrideResolution.applied) {
        audit(
          "socratic_override_applied",
          {
            runId,
            symbol: normalizedProposal.symbol,
            side: normalizedProposal.side,
            conflicts: overrideResolution.conflicts,
            thesis: normalizedProposal.autonomyOverride?.thesis,
            routeToHuman: overrideResolution.routeToHuman,
            mode: policy.socraticOverrideMode
          },
          userId,
          connectedAccountId
        );
        if (overrideResolution.routeToHuman) requiresHumanReview.add(proposal);
      } else if (overrideResolution.requested) {
        audit(
          "socratic_override_refused",
          {
            runId,
            symbol: normalizedProposal.symbol,
            side: normalizedProposal.side,
            conflicts: overrideResolution.conflicts,
            hardReasons: overrideResolution.hardReasons,
            thesis: normalizedProposal.autonomyOverride?.thesis
          },
          userId,
          connectedAccountId
        );
      }

      if (!decision.approved) {
        // ── Escalation framework ─────────────────────────────────────────────────────────────
        // A soft-blocked proposal whose EVERY failure is escalatable (ask-mode wash sale in any
        // authority; time-context caps/staleness in Decide authority — see shouldEscalateDecision)
        // becomes a pending-approval card instead of dying as a blocked entry. The card stores the
        // block reasons plus server-minted override tokens; approval re-runs the FULL policy gate,
        // where only the wash-sale gate honors its stored token (time-context gates simply
        // re-evaluate against then-current caps/quotes). policy.ts stays authoritative throughout.
        if (shouldEscalateDecision(decision, policy)) {
          const proposalId = crypto.randomUUID();
          const escalatedDecision: PolicyDecision = {
            ...decision,
            // Mint one server-side override token per escalatable failure. The token lives ONLY in
            // this stored decision row and the audit ledger; the approval path re-reads it from the
            // DB (approvedEscalationsFromDecision). No client payload can create or alter it.
            escalations: (decision.escalations ?? []).map((entry) => ({ ...entry, token: crypto.randomUUID() }))
          };
          insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision: escalatedDecision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
          recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision: escalatedDecision, status: "proposed", review, overrideResolution });
          audit(
            "proposal_escalated",
            {
              runId,
              proposalId,
              symbol: normalizedProposal.symbol,
              side: normalizedProposal.side,
              reasons: decision.reasons,
              escalations: escalatedDecision.escalations,
              ...(decision.washSale ? { washSale: decision.washSale } : {})
            },
            userId,
            connectedAccountId
          );
          const washAsk = escalatedDecision.escalations?.find((entry) => entry.kind === "wash_sale_ask");
          const askCost = washAsk?.washSale?.estimatedTaxCostUsd;
          results.push({ proposal: normalizedProposal, status: "proposed", reasons: decision.reasons });
          await sendNotification(
            {
              type: "pending_approval",
              title: washAsk
                ? `${normalizedProposal.symbol} rebuy needs your call (wash sale${askCost != null ? ` — ~$${askCost.toFixed(2)} deduction at stake` : ""})`
                : `${normalizedProposal.symbol} awaiting approval (soft-blocked: ${decision.reasons[0]})`,
              payload: { runId, proposalId, proposal: normalizedProposal, review, decision: escalatedDecision, escalated: true }
            },
            { policy, userId }
          );
          lockGuard.assertOwned();
          // R1 §1.4.3 still applies: an autonomous run that TRIPPED a notional/order cap demotes
          // the account back to Ask-first even though the tripping proposal survives as a card.
          autoRevertOnCapBreach(decision.reasons, policy, userId, connectedAccountId);
          continue;
        }

        const proposalId = crypto.randomUUID();
        lockGuard.assertOwned();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked", review, overrideResolution });
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        lockGuard.assertOwned();
        autoRevertOnCapBreach(decision.reasons, policy, userId, connectedAccountId);
        // Feed a policy-BLOCKED OPENING proposal into the counterfactual pipeline (same path as a user
        // rejection) so its post-block return matures into missed-opportunity analytics — closing the
        // gap for names the LLM proposed but the policy gate then blocked. Opening sides only (a blocked
        // exit is not a missed opportunity); best-effort + non-fatal.
        if (normalizedProposal.side === "buy" || normalizedProposal.side === "short") {
          try {
            recordRejectedProposalCounterfactual({
              userId,
              connectedAccountId,
              runId,
              symbol: normalizedProposal.symbol,
              refPrice: normalizedProposal.referencePrice,
              createdAt: new Date().toISOString(),
              regime: normalizedProposal.entryMarketRegime
            });
          } catch (err) {
            console.warn("[strategy] policy-blocked counterfactual failed:", err instanceof Error ? err.message : String(err));
          }
        }
        continue;
      }

      const heldExit = evaluateBrokerHeldExitAvailability(normalizedProposal, workingPositions, orders);
      if (heldExit) {
        const heldReason = brokerHeldExitBlockReason(heldExit);
        const heldDecision: PolicyDecision = { approved: false, reasons: [heldReason] };
        const proposalId = crypto.randomUUID();
        insertProposal({
          userId,
          executionMode,
          id: proposalId,
          runId,
          accountNumber: policy.accountNumber,
          proposal: normalizedProposal,
          decision: heldDecision,
          review,
          estimatedNotional: review.estimatedNotional,
          status: "blocked",
          promptVersion: STRATEGY_PROMPT_VERSION
        });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision: heldDecision, status: "blocked", review, overrideResolution });
        audit(
          "proposal_blocked_broker_held_exit",
          { runId, proposalId, symbol: heldExit.symbol, side: heldExit.side, heldExit },
          userId,
          connectedAccountId
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: heldDecision.reasons });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision: heldDecision, review, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      // Sell-to-fund "propose" mode: funding sells queue for human approval even under "decide"
      // authority — raising cash by selling is the user's call. (Identified by tradeThesisTag so it's
      // robust to any reordering by the cluster gate.)
      if (sellToFundMode === "propose" && normalizedProposal.tradeThesisTag === "Sell-to-Fund") {
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "proposed", review, overrideResolution });
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: ["Sell-to-fund-buy: queued for approval."] });
        await sendNotification(
          { type: "pending_approval", title: `${normalizedProposal.symbol} funding sell awaiting approval`, payload: { runId, proposalId, proposal: normalizedProposal, review } },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      if (policy.strategyAuthority === "propose") {
        // Under "propose" authority EVERY proposal already becomes a pending-approval card
        // regardless of Red Team outcome. The Red-Team-unavailable signal is already on the
        // rationale via routeOnAdversaryUnavailable's note (appended in the debate loop above),
        // which is authority-aware — held/openings read "routed to human approval" and an opt-in
        // de-risk exit reads "surfaced for your approval" under propose authority (never falsely
        // "proceeding") — so no separate corrective note is needed here.
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "proposed", review, overrideResolution });
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [] });
        await sendNotification(
          {
            type: "pending_approval",
            title: `${normalizedProposal.symbol} awaiting approval`,
            // R18 — a propose-mode insert must carry the adversary-unavailable flag too (this
            // branch runs BEFORE the requiresHumanReview one, so without this the flag would only
            // ever surface under decide authority).
            payload: {
              runId,
              proposalId,
              proposal: normalizedProposal,
              review,
              ...(decision.adversaryUnavailable
                ? { adversaryUnavailable: true, adversaryUnavailableReason: decision.adversaryUnavailableReason }
                : {})
            }
          },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      // Fail CLOSED: a high-conviction trade whose REQUIRED Red Team review could not run is
      // routed to a human instead of auto-executed with real capital.
      if (requiresHumanReview.has(proposal)) {
        const proposalId = crypto.randomUUID();
        const failureKindSuffix = normalizedProposal.redTeamVerdict?.failureKind
          ? ` (${describeRedTeamFailureKind(normalizedProposal.redTeamVerdict.failureKind)})`
          : "";
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "proposed", review, overrideResolution });
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [`Red Team review unavailable${failureKindSuffix}; routed to human approval.`] });
        await sendNotification(
          {
            type: "pending_approval",
            title: `${normalizedProposal.symbol} awaiting approval (Red Team unavailable)`,
            // §5.2 — payload metadata flag so formatNotificationDisplay can PRESERVE this title
            // instead of unconditionally overwriting pending_approval titles.
            payload: {
              runId,
              proposalId,
              proposal: normalizedProposal,
              review,
              ...(decision.adversaryUnavailable
                ? { adversaryUnavailable: true, adversaryUnavailableReason: decision.adversaryUnavailableReason }
                : {})
            }
          },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      // Pre-flight live-order guard: a last assertion just before a real-capital order is placed.
      // No-op on the broker/paper path (submitsBrokerOrders, real-capital-free). On the broker/live
      // path it now ALLOWS by default (a live account trades on its environment alone) and throws
      // ONLY when live trading has been explicitly disabled via the ALLOW_LIVE_TRADING=false escape
      // hatch. It NEVER places or enables a trade.
      try {
        assertLivePreflight({
          mode: executionMode,
          symbol: normalizedProposal.symbol,
          side: normalizedProposal.side
        });
      } catch (guardError) {
        const message = guardError instanceof Error ? guardError.message : String(guardError);
        const proposalId = crypto.randomUUID();
        // Persist a REJECTED decision, not the earlier approved one — a blocked live order must not
        // leave an `approved: true` row in the decision/audit ledger.
        const blockedDecision: PolicyDecision = { ...decision, approved: false, reasons: [...decision.reasons, message] };
        insertProposal({ userId, executionMode, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision: blockedDecision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision: blockedDecision, status: "blocked", review, overrideResolution });
        audit("order_blocked_live_preflight", { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, reason: message }, userId, connectedAccountId);
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: [message] });
        await sendNotification(
          { type: "block", title: `${normalizedProposal.symbol} live order blocked (pre-flight)`, payload: { runId, proposalId, decision: blockedDecision, review, proposal: normalizedProposal, reason: message } },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      // Renew synchronously at the last safe boundary. If another invocation stole the lease (or
      // the DB cannot prove ownership), do not write a placing intent or call the broker.
      lockGuard.assertOwned();

      // Atomic, crash-recoverable placement. Persist an idempotency-keyed INTENT row BEFORE the
      // broker call. If the process dies — or the broker accepts the order but the response is
      // lost — between the call and the post-write, the order is no longer an invisible orphan:
      // the "placing" row records refId/symbol/notional so an operator (and the run-start
      // flagStalePlacingIntents sweep) can find it. Each placement is isolated in its own
      // try/catch so one broker outage can't abort the rest of the run's risk exits.
      const refId = crypto.randomUUID();
      const proposalId = crypto.randomUUID();
      insertProposal({
        userId,
        id: proposalId,
        runId,
        accountNumber: policy.accountNumber,
        proposal: normalizedProposal,
        decision,
        review,
        estimatedNotional: review.estimatedNotional,
        refId,
        status: "placing",
        executionMode,
        promptVersion: STRATEGY_PROMPT_VERSION
      });

      let execution: Awaited<ReturnType<typeof gateway.placeEquityOrder>>;
      try {
        execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal, refId });
      } catch (placeError) {
        const message = placeError instanceof Error ? placeError.message : String(placeError);
        const sym = normalizedProposal.symbol;
        // The broker may or may not have accepted the order. Ask the broker what actually happened
        // (via the refId idempotency key) instead of immediately firing a perpetual "verify with
        // broker" alert. Only a truly unreachable broker leaves the durable 'placing' intent behind.
        const outcome = await reconcilePlacementError({
          gateway,
          accountNumber: policy.accountNumber,
          userId,
          proposalId,
          refId,
          proposal: normalizedProposal,
          review,
          marketScan,
          executionMode,
          placeErrorMessage: message,
          runId
        });
        if (outcome.kind === "placed") {
          updateProposalStatus(proposalId, "placed", outcome.orderId, review, review.estimatedNotional, userId);
          recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placed", review, overrideResolution });
          auditWashSaleProceed(decision, { runId, proposalId, symbol: sym, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, userId, connectedAccountId });
          audit("order_placement_recovered_inline", { runId, proposalId, refId, orderId: outcome.orderId, state: outcome.state, alreadyBooked: outcome.alreadyBooked, symbol: sym, side: normalizedProposal.side }, userId, connectedAccountId);
          resolveBrokerVerificationNotifications(userId, { proposalId, refId, resolution: "recovered" });
          results.push({ proposal: normalizedProposal, status: "placed", reasons: [], orderId: outcome.orderId });
          await sendNotification(
            { type: "fill", title: `${sym} live order ${outcome.state} (recovered after placement error)`, payload: { runId, proposalId, refId, fill: outcome.fill, reconcile: "recovered" } },
            { policy, userId }
          );
          emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { runId, proposalId, symbol: sym, orderId: outcome.orderId } });
          lockGuard.assertOwned();
          continue;
        }
        if (outcome.kind === "declined") {
          const declinedMsg = `Broker declined the order (state: ${outcome.state}).`;
          updateProposalStatus(proposalId, "rejected_by_broker", outcome.orderId, review, review.estimatedNotional, userId, undefined, declinedMsg);
          recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision: { ...decision, approved: false, reasons: [...decision.reasons, declinedMsg] }, status: "rejected_by_broker", review, overrideResolution });
          audit("order_rejected_by_broker", { runId, proposalId, refId, symbol: sym, side: normalizedProposal.side, orderId: outcome.orderId, brokerState: outcome.state, via: "inline_reconcile" }, userId, connectedAccountId);
          results.push({ proposal: normalizedProposal, status: "error", reasons: [declinedMsg] });
          await sendNotification(
            { type: "run_failed", title: `${sym} order declined by broker (${outcome.state})`, payload: { runId, proposalId, refId, orderId: outcome.orderId, state: outcome.state, reconcile: "declined" } },
            { policy, userId }
          );
          lockGuard.assertOwned();
          continue;
        }
        if (outcome.kind === "not_placed") {
          const note = "Broker reachable; no order carries our idempotency key — the order never reached the broker. Safe to retry.";
          updateProposalStatus(proposalId, "not_placed", undefined, review, review.estimatedNotional, userId, undefined, note);
          recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placing_failed", review, overrideResolution });
          audit("order_confirmed_not_placed", { runId, proposalId, refId, symbol: sym, side: normalizedProposal.side, error: message }, userId, connectedAccountId);
          results.push({ proposal: normalizedProposal, status: "error", reasons: [`Order not placed (safe to retry): ${message}`] });
          await sendNotification(
            { type: "run_failed", title: `${sym} order was NOT placed — safe to retry`, payload: { runId, proposalId, refId, error: message, reconcile: "not_placed" } },
            { policy, userId }
          );
          lockGuard.assertOwned();
          continue;
        }
        // uncertain: broker unreachable — KEEP status 'placing' (not 'placing_failed') so the sweep
        // retries next run, and emit the (protected) "verify with broker" alert. This is the ONLY
        // path that still produces a perpetual-until-confirmed alert.
        updateProposalStatus(proposalId, "placing", undefined, review, review.estimatedNotional, userId, undefined, outcome.error);
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placing_failed", review, overrideResolution });
        audit("order_placement_uncertain", { runId, proposalId, refId, symbol: sym, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, error: outcome.error, brokerUnreachable: true }, userId, connectedAccountId);
        results.push({ proposal: normalizedProposal, status: "error", reasons: [`Order placement failed/uncertain: ${outcome.error}`] });
        await sendNotification(
          { type: "run_failed", title: `${sym} order placement uncertain — verify with broker`, payload: { runId, proposalId, refId, error: outcome.error, reconcile: "uncertain" } },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      // A broker call that doesn't throw is NOT the same as "the broker accepted the order" —
      // Alpaca and Robinhood can both return HTTP 200 with a synchronous rejected/canceled state
      // (e.g. a risk check, PDT block, or unsupported extended-hours order). Recording this as
      // "placed" would tell the user/dashboard a live order exists when the broker already
      // declined it — broker-agnostic via isRejectedOrCanceledState (handles both spellings and
      // known terminal-decline states across brokers).
      if (isRejectedOrCanceledState(execution.state)) {
        const message = `Broker declined the order (state: ${execution.state}).`;
        updateProposalStatus(proposalId, "rejected_by_broker", execution.orderId, review, review.estimatedNotional, userId, undefined, message);
        recordSocraticDecision({
          proposalId,
          proposal: normalizedProposal,
          decision: { ...decision, approved: false, reasons: [...decision.reasons, message] },
          status: "rejected_by_broker",
          review,
          overrideResolution
        });
        audit("order_rejected_by_broker", { runId, proposalId, refId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, orderId: execution.orderId, brokerState: execution.state }, userId, connectedAccountId);
        results.push({ proposal: normalizedProposal, status: "error", reasons: [message] });
        await sendNotification(
          { type: "run_failed", title: `${normalizedProposal.symbol} order declined by broker (${execution.state})`, payload: { runId, proposalId, refId, orderId: execution.orderId, state: execution.state } },
          { policy, userId }
        );
        lockGuard.assertOwned();
        continue;
      }

      updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional, userId);
      recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placed", review, overrideResolution });
      // Wash-sale proceed trail at the actual live placement — see auditWashSaleProceed.
      auditWashSaleProceed(decision, { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, userId, connectedAccountId });
      const preFillPosition = workingPositions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(normalizedProposal.symbol));
      const fill = recordFillFromProposal({
        userId,
        accountNumber: policy.accountNumber,
        proposalId,
        runId,
        source: learningSource,
        executionMode,
        proposal: normalizedProposal,
        review,
        execution,
        marketScan,
        status: execution.state === "filled" ? "filled" : "pending_reconciliation",
        existingPosition: preFillPosition ? { averageCost: preFillPosition.averageCost, quantity: preFillPosition.quantity } : undefined
      });
      results.push({ proposal: normalizedProposal, status: "placed", reasons: [], orderId: execution.orderId });
      await sendNotification(
        { type: "fill", title: `${normalizedProposal.symbol} live order ${execution.state}`, payload: { runId, proposalId, fill } },
        { policy, userId }
      );
      // Push so open dashboards refresh on an autonomously-placed order (the approval path
      // already emits this; the run-loop placement previously did not).
      emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { runId, proposalId, symbol: normalizedProposal.symbol, orderId: execution.orderId } });
      lockGuard.assertOwned();
    }

    // Phase 10 B2 — full EvidenceDigest for the WHOLE scored set (chosen AND skipped):
    // factor sub-scores, source freshness, bulletins, sector, regime, and a decision-time
    // reference price. Persisting the skipped names (not just what we bought) is what lets
    // later learning run counterfactuals ("names you passed that then ran") and attribute
    // outcomes to factors. The run regime is deterministic and shared across candidates.
    const runRegime = determineMarketRegime(await fetchMacroData(userId));
    // Preserve any fully-durable placement result in the failed receipt, but do not continue into
    // evidence/snapshot writes after a successor has taken the account lease.
    lockGuard.assertOwned();
    const quoteBySymbol = new Map((marketScan?.topCandidates ?? []).map((q) => [normalizeSymbol(q.symbol), q]));
    const chosenSymbols = new Set(results.map((r) => normalizeSymbol(r.proposal.symbol)));

    const chosenEvidence = results.map((r) =>
      buildCandidateEvidence(quoteBySymbol.get(normalizeSymbol(r.proposal.symbol)), {
        symbol: r.proposal.symbol,
        chosen: true,
        regime: runRegime,
        side: r.proposal.side,
        status: r.status,
        thesisTag: r.proposal.tradeThesisTag
      })
    );
    const skippedEvidence = (marketScan?.topCandidates ?? [])
      .filter((candidate) => !chosenSymbols.has(normalizeSymbol(candidate.symbol)))
      .slice(0, MAX_SKIPPED_EVIDENCE)
      .map((candidate) => buildCandidateEvidence(candidate, { symbol: candidate.symbol, chosen: false, regime: runRegime }));

    // Counterfactual decision index: which names we bought vs the top-ranked names we
    // passed. The skipped half now carries full evidence (was symbol/score/sector/change
    // only), so post-mortems can compare like-for-like without re-deriving the scan.
    audit("candidates_considered", {
      runId,
      llmSteps,
      chosen: results.map((r) => ({ symbol: r.proposal.symbol, side: r.proposal.side, status: r.status, thesisTag: r.proposal.tradeThesisTag })),
      topSkipped: skippedEvidence
    }, userId, connectedAccountId);

    // SignalSnapshot: the full scored set, each a complete CandidateEvidence digest.
    // getSignalEfficacy joins closed lots → signals by runId|symbol, so skipped entries
    // (no fills) are simply never matched.
    audit("signal_snapshot", {
      runId,
      asOf: new Date().toISOString(),
      signals: [...chosenEvidence, ...skippedEvidence]
    }, userId, connectedAccountId);
    void materializeSkippedCandidateCounterfactuals(userId, { auditLimit: 100, pendingLimit: 25, connectedAccountId })
      .catch((e) => console.error("[counterfactual-learning] materialization error:", e));
    // Outcome engine piggybacks the counterfactual cadence: matures decision-case outcomes
    // (placed -> fills/closed lots; blocked/rejected -> counterfactual refPrice), writes the
    // multi-horizon outcome + receipt, re-indexes decision memory, and runs the budget-gated
    // post-mortem lesson pass. Fire-and-forget + dynamic import: never blocks or fails the run.
    // INTENTIONALLY EXEMPT from the run-scoped usage-budget model downgrade (`runPolicy` above):
    // this runs detached from THIS run's lifetime/lock (it matures cases across accounts and can
    // still be in flight after `runStrategyOnce` returns), so there is no single well-defined
    // "this run's downgrade" to hand it — `callLessonLlm` in outcome-engine.ts re-reads the owner's
    // persisted (undowngraded) policy via getPolicy(), same as before this branch.
    void import("./outcome-engine")
      .then(({ matureSocraticDecisionOutcomes }) => matureSocraticDecisionOutcomes(userId, { connectedAccountId }))
      .catch((e) => console.error("[outcome-engine] maturation error:", e));

    const placed = results.filter((r) => r.status === "placed").length;
    const proposed = results.filter((r) => r.status === "proposed").length;
    const tradeCount = placed + proposed;
    const summary = [
      `Evaluated ${results.length} proposal(s).`,
      `${manualRun ? "Manual run" : "Scheduled run"} proposed ${tradeCount} Trade${tradeCount === 1 ? "" : "s"}.`,
      placed > 0 ? `Placed: ${placed}.` : "",
      proposed > 0 ? `Awaiting approval: ${proposed}.` : "",
      expiry.expired > 0 ? `Expired ${expiry.expired} stale proposal${expiry.expired === 1 ? "" : "s"}.` : "",
      revalidation && (revalidation.withdrawn > 0 || revalidation.reaffirmed > 0)
        ? `Re-checked ${revalidation.checked} pending: kept ${revalidation.reaffirmed}, withdrew ${revalidation.withdrawn}.`
        : "",
      sellToFundNote
    ]
      .filter(Boolean)
      .join(" ");

    // Persist diversity result as an advisory audit event (no schema migration needed).
    // Account-attributed like strategy_run/signal_snapshot so the Activity feed can say
    // WHICH account's run this analyzed (#8).
    audit("rationale_diversity", { runId, llmSteps, ...rationaleDiversity }, userId, connectedAccountId);
    finishStrategyRun(runId, "completed", summary, userId);
    recordPortfolioSnapshot({
      userId,
      runId,
      accountNumber: policy.accountNumber,
      source: learningSource,
      executionMode,
      portfolio,
      positions
    });
    result = { runId, status: "completed", summary, proposals: results, marketScan, accountNumber: policy.accountNumber, llmSteps, rationaleDiversity };
    
    // Phase 7: Async trigger post-mortem reflection. Skipped when LLM work was budget/reservation-suppressed
    // (it spends LLM via withLlmGeneration + semantic gate, whose checks read only the committed ledger, not
    // the live reservation). The finally holds the reservation until this promise settles so the reflection
    // spend stays inside the reserved headroom rather than racing a queued same-user run.
    reflectionPromise = skipLlmDueToBudget
      ? undefined
      // runPolicy (not policy): the reflection LLM call must see the run-scoped usage-budget
      // downgrade too, rather than re-reading the owner's persisted (undowngraded) policy.
      : generateReflectionSummary(policy.accountNumber, userId, runPolicy).catch((e) => console.error("Post-mortem error:", e));

  } catch (error) {
    const baseSummary = error instanceof Error ? error.message : "Strategy failed.";
    const summary = error instanceof StrategyLockOwnershipLostError && completedProposalResults.length > 0
      ? `${baseSummary} ${completedProposalResults.length} proposal result(s) completed before ownership was lost.`
      : baseSummary;
    if (error instanceof StrategyLlmStepFailure) {
      llmSteps = error.llmSteps;
    }
    finishStrategyRun(runId, "failed", summary, userId);
    const policy = getPolicy(userId, connectedAccountId);
    result = {
      runId,
      status: "failed",
      summary,
      proposals: completedProposalResults,
      accountNumber: policy.accountNumber,
      ...(llmSteps.length > 0 ? { llmSteps } : {})
    };
    if (summary === "Kill switch is active.") {
      await sendNotification({ type: "kill_switch", title: "Kill switch blocked strategy run", payload: { runId, summary } }, { policy, userId });
    } else {
      await sendNotification({ type: "run_failed", title: "Strategy run failed", payload: { runId, summary } }, { policy, userId });
    }
  } finally {
    lockGuard.stop();
    // Release the strategy lock promptly so this account can run again. The LLM reservation is held a bit
    // longer — until the fire-and-forget post-mortem reflection settles — so that background spend stays
    // inside the reserved headroom instead of racing a queued same-user run (the TTL is the crash backstop).
    // We do NOT await here, so runStrategyOnce's return isn't delayed by the reflection.
    releaseStrategyLock(runId, userId, connectedAccountId);
    if (llmReservationId) {
      const rid = llmReservationId;
      void Promise.resolve(reflectionPromise).finally(() => releaseLlmReservation(userId, rid));
    }
  }

  // Audit is written here (inside the domain fn) so the scheduler path records it too.
  audit("strategy_run", result, userId, connectedAccountId);
  // Push a dashboard event so open clients refresh immediately instead of waiting for their
  // next poll (the SSE bus is in-process; no-op when nothing is subscribed).
  emitDashboardEvent({ type: "run-complete", userId, at: new Date().toISOString(), detail: { runId } });
  return result;
}

// `shouldRunRedTeamDebate`, `redTeamDebateTrigger`, and the conviction/%-of-NAV threshold helpers
// were REMOVED 2026-07-07 (single-adversary consolidation, decision O2): the Red Team review now
// runs on EVERY risk-adding opening — universal, structural coverage instead of conviction- or
// stakes-gated triggering. The only remaining routing question is §3.5's net-risk-direction gate:

export function bracketWholeShareMinimum(
  proposal: TradeProposal,
  policy: TradingPolicy,
  marketScan?: MarketScan,
  stopPlanBySymbol: Record<string, StopPlanStyle> = {}
): number | undefined {
  if (proposal.side !== "buy" && proposal.side !== "short") return undefined;
  if (policy.brokerBracketsEnabled === false) return undefined;
  if (policy.activeBroker !== "alpaca" && policy.activeBroker !== "alpaca-mcp") return undefined;
  // A "trailing"/"none" plan strips BOTH bracket legs entirely at enrichOpeningProposal (protection
  // is the trailing lane instead of a fixed bracket stop; a resting take-profit-only leg would itself
  // look like broker-held exit coverage and suppress the trailing stop — see enrichOpeningProposal's
  // doc comment) — bumping the size here to support a bracket that will never be sent would needlessly
  // oversize a sub-share entry (Codex review, PR #1371).
  const plan: StopPlanStyle = proposal.stopPlan?.style ?? stopPlanBySymbol[normalizeSymbol(proposal.symbol)] ?? "default";
  if (plan === "trailing" || plan === "none") return undefined;
  const stopPct = proposal.side === "short"
    ? (policy.riskRules?.shortStopLossPct ?? policy.riskRules?.stopLossPct ?? 0)
    : (policy.riskRules?.stopLossPct ?? 0);
  const takePct = policy.riskRules?.takeProfitPct ?? 0;
  // An explicit "fixed"/"atr" plan ALWAYS attaches a stop leg at enrichOpeningProposal — falling back
  // to STOP_PLAN_FALLBACK_STOP_PCT (or the real ATR pct) even when the account's own stopPct is
  // 0/unset (universal availability) — so the whole-share bump must still apply for these plans, or
  // the order stays sub-share and the fallback stop it's guaranteed to get later gets stripped by the
  // sub-share branch below instead (Codex review, PR #1371).
  const planGuaranteesStopLeg = plan === "fixed" || plan === "atr";
  if (!planGuaranteesStopLeg && stopPct <= 0 && takePct <= 0) return undefined;
  const symbol = normalizeSymbol(proposal.symbol);
  const referencePrice =
    proposal.limitPrice ??
    proposal.stopPrice ??
    proposal.referencePrice ??
    marketScan?.quotesBySymbol[symbol]?.price ??
    marketScan?.topCandidates.find((quote) => normalizeSymbol(quote.symbol) === symbol)?.price;
  return typeof referencePrice === "number" && Number.isFinite(referencePrice) && referencePrice > 0
    ? referencePrice
    : undefined;
}

/** Hard minimum dollar notional a broker requires for dollar-based/fractional orders.
 *  Returns 0 when the broker has no known minimum (whole-share orders bypass this floor). */
export function brokerMinimumDollarNotional(policy: TradingPolicy): number {
  // Robinhood rejects dollar-based orders below $1 ("must be at least $1").
  if (policy.activeBroker === "robinhood") return 1;
  return 0;
}

/** Human-readable broker name for sizing notes. */
export function brokerLabel(policy: TradingPolicy): string {
  if (policy.activeBroker === "robinhood") return "Robinhood";
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") return "Alpaca";
  if (policy.activeBroker === "tradier") return "Tradier";
  return policy.activeBroker ?? "broker";
}

export function estimateOpeningProposalNotional(proposal: TradeProposal, marketScan?: MarketScan): number | undefined {
  if (typeof proposal.dollarAmount === "number" && Number.isFinite(proposal.dollarAmount) && proposal.dollarAmount > 0) {
    return proposal.dollarAmount;
  }
  if (typeof proposal.quantity !== "number" || !Number.isFinite(proposal.quantity) || proposal.quantity <= 0) return undefined;
  const symbol = normalizeSymbol(proposal.symbol);
  const referencePrice =
    proposal.limitPrice ??
    proposal.stopPrice ??
    marketScan?.quotesBySymbol[symbol]?.price ??
    marketScan?.topCandidates.find((quote) => normalizeSymbol(quote.symbol) === symbol)?.price;
  return typeof referencePrice === "number" && Number.isFinite(referencePrice) && referencePrice > 0
    ? proposal.quantity * referencePrice
    : undefined;
}

export function openingRiskCapacity(
  proposal: TradeProposal,
  policy: TradingPolicy,
  portfolio: Portfolio,
  positions: EquityPosition[],
  marketScan?: MarketScan
): { cap: number; reason?: string } {
  if (portfolio.totalMarketValue <= 0) {
    return { cap: 0, reason: "Account NAV is zero or negative — entries blocked." };
  }
  const symbol = normalizeSymbol(proposal.symbol);
  const totalValue = portfolio.totalMarketValue;
  const caps: Array<{ value: number; reason: string }> = [];
  if (policy.maxOrderNotional != null && policy.maxOrderNotional > 0) {
    caps.push({ value: policy.maxOrderNotional, reason: "per-order cap" });
  }
  if (proposal.side === "short" && policy.maxShortOrderNotional != null && policy.maxShortOrderNotional > 0) {
    caps.push({ value: policy.maxShortOrderNotional, reason: "max short order limit" });
  }
  if (policy.maxOrderPctOfNav != null && policy.maxOrderPctOfNav > 0 && totalValue > 0) {
    caps.push({ value: (policy.maxOrderPctOfNav / 100) * totalValue, reason: `${policy.maxOrderPctOfNav}% NAV cap` });
  }
  if (proposal.side === "buy" && portfolio.buyingPower > 0) {
    caps.push({ value: portfolio.buyingPower, reason: "buying power" });
  }

  const currentSymbolValue = Math.abs(positions.find((position) => normalizeSymbol(position.symbol) === symbol)?.marketValue ?? 0);
  if (policy.maxSymbolExposurePct != null && policy.maxSymbolExposurePct > 0 && totalValue > 0) {
    const symbolRoom = (policy.maxSymbolExposurePct / 100) * totalValue - currentSymbolValue;
    caps.push({ value: Math.max(0, symbolRoom), reason: `${policy.maxSymbolExposurePct}% ${symbol} exposure cap` });
  }
  if (policy.maxSymbolExposureNotional != null && policy.maxSymbolExposureNotional > 0) {
    caps.push({ value: Math.max(0, policy.maxSymbolExposureNotional - currentSymbolValue), reason: `${symbol} notional exposure cap` });
  }

  const sector = sectorForSizing(symbol, positions, marketScan);
  const sectorCapPct = sector ? sectorCapPctForSizing(policy, sector) : undefined;
  if (sector && sectorCapPct != null && sectorCapPct > 0 && totalValue > 0) {
    const currentSectorValue = positions
      .filter((position) => sectorForSizing(normalizeSymbol(position.symbol), positions, marketScan) === sector)
      .reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
    const sectorRoom = (sectorCapPct / 100) * totalValue - currentSectorValue;
    caps.push({ value: Math.max(0, sectorRoom), reason: `${sector} sector cap` });
  }

  if (caps.length === 0) return { cap: Infinity };
  const limitingCap = caps.reduce((min, cap) => cap.value < min.value ? cap : min);
  return { cap: limitingCap.value, reason: limitingCap.reason };
}

export function openingPolicyNotionalCap(proposal: TradeProposal, policy: TradingPolicy, portfolio: Portfolio): number {
  return Math.min(
    policy.maxOrderNotional ?? Infinity,
    proposal.side === "short" && policy.maxShortOrderNotional != null && policy.maxShortOrderNotional > 0
      ? policy.maxShortOrderNotional
      : Infinity,
    policy.maxOrderPctOfNav != null && policy.maxOrderPctOfNav > 0 && portfolio.totalMarketValue > 0
      ? (policy.maxOrderPctOfNav / 100) * portfolio.totalMarketValue
      : Infinity
  );
}

function sectorForSizing(symbol: string, positions: EquityPosition[], marketScan?: MarketScan): string | undefined {
  return (
    positions.find((position) => normalizeSymbol(position.symbol) === symbol)?.sector ??
    marketScan?.sectorBySymbol[symbol] ??
    marketScan?.quotesBySymbol[symbol]?.sector
  );
}

function sectorCapPctForSizing(policy: TradingPolicy, sector: string): number | undefined {
  const exact = policy.sectorCaps[sector];
  if (exact !== undefined) return exact;
  const match = Object.entries(policy.sectorCaps).find(([key]) => key.toLowerCase() === sector.toLowerCase());
  return match?.[1];
}

export function formatWholeDollars(value: number): string {
  if (Math.abs(value) < 100 && !Number.isInteger(value)) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

// R1 §1.4.3 — if an autonomous ("decide") run trips a notional/order cap, drop the account back to
// "propose" so a human is back in the loop before any further orders. Returns true if it reverted.
const CAP_BREACH_REASONS = ["Daily notional limit", "Hourly notional limit", "Daily order count limit", "Daily opening-order count limit"];
/**
 * Emit the wash-sale "proceed" trail at the point an order ACTUALLY executes (paper fill or live
 * placement) — never at gate-eval time, where an approved result may still only become a pending
 * card. No-op unless the decision carries an auto_proceeded / ira_disregarded outcome, so it is safe
 * to call on every executed proposal. Keeps the run loop's two execution paths from drifting.
 */
export function auditWashSaleProceed(
  decision: PolicyDecision,
  meta: { runId?: string; proposalId?: string; symbol: string; side: OrderSide; estimatedNotional?: number; userId?: string; connectedAccountId?: string }
): void {
  const outcome = decision.washSale?.outcome;
  if (outcome !== "auto_proceeded" && outcome !== "ira_disregarded") return;
  audit(
    outcome === "ira_disregarded" ? "wash_sale_ira_disregarded" : "wash_sale_auto_proceed",
    {
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.proposalId ? { proposalId: meta.proposalId } : {}),
      symbol: meta.symbol,
      side: meta.side,
      estimatedNotional: meta.estimatedNotional,
      washSale: decision.washSale
    },
    meta.userId,
    meta.connectedAccountId
  );
}

export function autoRevertOnCapBreach(reasons: string[] | undefined, policy: TradingPolicy, userId: string, connectedAccountId?: string): boolean {
  if (policy.strategyAuthority !== "decide" || !reasons) return false;
  if (!reasons.some((r) => CAP_BREACH_REASONS.some((c) => r.includes(c)))) return false;
  // Scope the demotion save to the run's target account. Omitting it resolves the ACTIVE account, so a
  // scheduler run of a non-active account could demote — and, because the drawdown breaker may have
  // already mutated this same policy object's systemState to "halted", HALT — the wrong account. The
  // manual executeProposal path passes no id because it already operates on the active account.
  setPolicy({ ...policy, strategyAuthority: "propose" }, userId, connectedAccountId);
  // The demotion must bind the REST of this run, not just the next one: callers keep using this
  // same policy object for subsequent proposals in the loop, and shouldEscalateDecision treats
  // decide-mode cap breaches as escalatable — without this in-place update a run that tripped a
  // cap on proposal N would keep queueing decide-style soft-blocked cards for N+1... even though
  // the account was just demoted to Ask-first.
  policy.strategyAuthority = "propose";
  audit("policy_violation_cap_exceeded", { reasons, from: "decide", revertedTo: "propose" }, userId, connectedAccountId);
  return true;
}

export function assertLiveApprovalConfirmation(input: {
  executionMode: ExecutionMode;
  confirmation?: LiveApprovalConfirmation;
  proposalId: string;
  accountNumber: string;
  proposal: TradeProposal;
  estimatedNotional?: number;
  requireTypedConfirmation: boolean;
}): void {
  if (input.executionMode !== "broker/live") return;
  // Owner-adjustable preference (policy.requireTypedConfirmation): when the owner has turned typed
  // confirmation off, a live approval is a one-click action like any other — no phrase required.
  // Real money is the app's normal, in-domain case, not a gated exception.
  if (!input.requireTypedConfirmation) return;
  const confirmation = input.confirmation;
  const expectedText = liveApprovalText(input.proposal.symbol);
  const reasons: string[] = [];
  const typedText = String(confirmation?.typedText ?? "").trim().toUpperCase();
  const expectedNotional = input.estimatedNotional;

  if (!confirmation) reasons.push("Live Brokerage approvals require a typed confirmation payload.");
  if (confirmation?.proposalId !== input.proposalId) reasons.push("Confirmation proposal id did not match.");
  if (confirmation?.accountNumber !== input.accountNumber) reasons.push("Confirmation account did not match.");
  if (confirmation?.executionMode !== "broker/live") reasons.push("Confirmation execution mode did not match Brokerage live.");
  if (typedText !== expectedText) reasons.push(`Type ${expectedText} to approve this live order.`);
  if (typeof expectedNotional === "number" && Number.isFinite(expectedNotional)) {
    const confirmedNotional = Number(confirmation?.estimatedNotional);
    if (!Number.isFinite(confirmedNotional) || Math.abs(confirmedNotional - expectedNotional) > 0.01) {
      reasons.push("Confirmation estimated notional did not match the reviewed proposal.");
    }
  }

  if (reasons.length > 0) throw new LiveApprovalConfirmationError(reasons, expectedText);
}

export function rejectProposal(proposalId: string, userId: string = "local"): void {
  const proposal = getProposal(proposalId, userId);
  const connectedAccountId = getPolicy(userId).connectedAccountId;
  updateProposalStatus(proposalId, "rejected", undefined, undefined, undefined, userId);
  audit("proposal_rejected", {
    proposalId,
    symbol: proposal?.proposal.symbol,
    side: proposal?.proposal.side,
    action: "rejection"
  }, userId, connectedAccountId);
  // Feed the rejection into the counterfactual pipeline so its post-rejection return matures and
  // shows up in missed-opportunity analytics — "the app analyzes it anyway". Best-effort, non-fatal.
  if (proposal) {
    try {
      recordRejectedProposalCounterfactual({
        userId,
        connectedAccountId,
        runId: proposal.runId,
        symbol: proposal.proposal.symbol,
        refPrice: proposal.proposal.referencePrice,
        createdAt: proposal.createdAt,
        regime: proposal.entryMarketRegime ?? proposal.proposal.entryMarketRegime
      });
    } catch (err) {
      console.warn("[strategy] recordRejectedProposalCounterfactual failed:", err instanceof Error ? err.message : String(err));
    }
  }
  emitDashboardEvent({ type: "proposal", userId, at: new Date().toISOString(), detail: { proposalId, status: "rejected" } });
}

// THESIS_PLAYBOOK, the prompt guides, and the versioned Bull/Bear system prompts live in the
// leaf module ./strategy-prompts (Chat A item 2). Re-exported (imported at top) so existing
// consumers of `import { THESIS_PLAYBOOK } from "./strategy"` keep working.
export { THESIS_PLAYBOOK };

interface ProposeTradesResult {
  /** The deterministic-filtered Bull proposals (R6). NO second LLM pass runs in here anymore —
   *  the single Red Team review happens post-sizing in the strategy loop. */
  proposals: TradeProposal[];
  llmSteps: StrategyLlmStep[];
  /**
   * R7 — evidence context for the single Red Team review: the same structured candidate evidence
   * + macro/portfolio/scorecard context the Bull prompt carried, so the reviewer can fact-check
   * the strategist's claims. Threaded by the caller into every debateProposal call this run.
   */
  adversaryContext?: RedTeamReviewContext;
  /**
   * Advisory findings from the deterministic prompt-injection scan over the untrusted text
   * blocks assembled into the Bull prompt (see src/lib/prompt-safety.ts). Already audited
   * (kind 'prompt_injection_suspected') inside proposeTrades; the caller folds them into
   * decision-case evidence. NEVER affects the proposals themselves.
   */
  promptSafetyFindings?: InjectionFinding[];
}

async function proposeTrades(input: {
  runId: string;
  userId: string;
  policyAllowlist: string[];
  prompt: string;
  policy: TradingPolicy;
  activeAccount?: ExecutionAccount;
  portfolio: Portfolio;
  positions: EquityPosition[];
  recentOrders: unknown[];
  marketScan?: MarketScan;
  dailyNotionalUsed: number;
  dailyOrderCount: number;
  ragContext?: string;
  learnedContext?: string;
  /**
   * Episodic decision memory blocks (2026-07-04 composite review A1). Pre-formatted, labeled,
   * ADVISORY-ONLY strings injected into BOTH the Bull and Bear userContent (evidence parity):
   * `experienceAnalogs` = "Closest historical analogs" (k-NN priors incl. labeled
   * counterexamples with opposite realized sign); `ownerCoaching` = "Owner coaching"
   * (doc_type coach-note). Never threaded into deterministic sizing or policy.
   */
  experienceAnalogs?: string;
  ownerCoaching?: string;
  drawdownAdvisory?: { reason: string; equity: number; highWaterMark: number; drawdownPct: number };
  /**
   * Usage-budget ADVISORY (formatBudgetAdvisory output): a compact 1-2 line summary of operator LLM
   * spend vs budget, injected next to `drawdownAdvisory` below. DATA for the agent, never a command —
   * present whenever the usage monitor is configured and at least one provider is at warning/exceeded,
   * independent of whether USAGE_BUDGET_ENFORCE is on.
   */
  budgetAdvisory?: string;
  prefetched?: PrefetchedFills;
}): Promise<ProposeTradesResult> {
  const { url, key: openaiKey, model: resolvedModel, provider, keySource: llmKeySource, keyRef: llmKeyRef, transport } = resolveLlmEndpoint(input.policy, input.userId);
  // No resolvable LLM credential (neither the user's own key nor the operator failover) → HARD ERROR.
  // We deliberately do NOT fabricate a rule-based stub here: a strategy session is an LLM-driven action,
  // and silently substituting a non-LLM "Development Fallback" proposal misrepresents what ran. The
  // run loop's catch surfaces this message as the run summary; the route also pre-checks and 412s early.
  if (!openaiKey) throw new LlmCredentialRequiredError(LLM_REQUIRED_STRATEGY_MESSAGE);
  // NO MODEL DEFAULTS (owner directive 2026-07-07): a blank Green model resolves to "" and MUST fail
  // closed here — never send an empty-model request. Same legible-failure path as the missing key:
  // the run summary carries the actionable message and the route pre-checks and 412s early. The Red
  // (reviewer) model has its own fail-closed backstop inside debateProposal (not_configured), which
  // routes every un-reviewed opening to human approval rather than aborting the whole run.
  if (!resolvedModel) throw new LlmCredentialRequiredError(LLM_MODEL_REQUIRED_STRATEGY_MESSAGE);

  const maxProposals = input.policy.maxProposalsPerRun ?? 3;
  const remainingNotional = Math.max(0, (input.policy.maxDailyNotional ?? Infinity) - input.dailyNotionalUsed);
  const remainingOrders = Math.max(0, input.policy.maxDailyOrders - input.dailyOrderCount);

  // Phase 2 fix: build a full symbol→sector map from ALL scan candidates (not just
  // topCandidates) so holdings outside the top-30 still attribute to a sector.
  // We use the position's sector field (populated from the gateway) first, then
  // fall back to the scan for symbols not in the position data.
  const scanSectorBySymbol = new Map<string, string>(Object.entries(input.marketScan?.sectorBySymbol ?? {}));

  const sectorMap: Record<string, number> = {};
  for (const position of input.positions) {
    const sector =
      (position as EquityPosition & { sector?: string }).sector ??
      scanSectorBySymbol.get(normalizeSymbol(position.symbol));
    if (sector) {
      sectorMap[sector] = (sectorMap[sector] ?? 0) + position.marketValue;
    }
  }
  const sectorComposition =
    Object.keys(sectorMap).length > 0
      ? Object.fromEntries(
          Object.entries(sectorMap).map(([sector, value]) => [
            sector,
            input.portfolio.totalMarketValue > 0
              ? Math.round((value / input.portfolio.totalMarketValue) * 100)
              : 0
          ])
        )
      : undefined;

  const currentPrices = currentPricesFromScan(input.marketScan);
  // Account-scoped (with legacy shared-row fallback): keyed by the same broker accountNumber
  // the post-mortem writer uses, so a live account never reads a sibling account's reflection.
  const reflection = getReflectionSummary(input.userId, input.policy.accountNumber);
  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  const source = fillSourceForExecutionMode(executionState);
  const thesisScorecard = input.policy.accountNumber ? getThesisScorecard(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [];
  const regimeScorecard = input.policy.accountNumber ? getRegimeScorecard(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [];
  // Multi-dimensional learning: thesis × regime buckets with >=5 closed lots. Fewer than
  // 5 trades produce a statistic that is dominated by the Bayesian shrinkage prior anyway
  // and adds noise to the agent's reasoning without improving signal quality.
  const thesisRegimeScorecard = (input.policy.accountNumber ? getThesisRegimeScorecard(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [])
    .filter((bucket) => bucket.trades >= 5)
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  // Signal efficacy: realized win rate of buys that had a congressional/insider tailwind
  // at entry vs the baseline — so the agent learns which evidence actually predicts wins.
  const signalEfficacy = input.policy.accountNumber ? getSignalEfficacy(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [];
  // Confidence calibration: realized outcomes by the agent's own entry confidence band —
  // since confidence now drives position size, this surfaces over/under-confidence.
  const confidenceCalibration = input.policy.accountNumber ? getConfidenceCalibration(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [];
  // Sector learning: realized outcomes grouped by the sector each position was opened in.
  const sectorScorecard = (input.policy.accountNumber ? getSectorScorecard(input.policy.accountNumber, source, {}, input.userId, input.prefetched) : [])
    .filter((bucket) => bucket.trades >= 5 && bucket.sector !== "Unknown")
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  const factorScorecard = (input.policy.accountNumber ? getFactorScorecard(input.policy.accountNumber, source, {}, input.userId, undefined, input.prefetched) : [])
    .filter((bucket) => bucket.trades >= 5)
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  const skippedCounterfactuals = getSkippedCandidateReturns(currentPrices, input.userId, { limit: 8, maxAgeDays: 14, connectedAccountId: input.policy.connectedAccountId })
    .filter((row) => row.returnPct >= 3)
    .slice(0, 8);
  const taxSummary = input.policy.accountNumber
    ? getTaxSummary(input.policy.accountNumber, source, currentPrices, input.policy.taxSettings, new Date(), input.userId, input.prefetched)
    : null;
  // ask/auto wash-sale handling: give the model the PRICED cost of rebuying each locked name
  // (disallowed loss × shortTermRatePct, from the cross-account provenance map) so it can weigh a
  // locked rebuy honestly instead of just seeing a forbidden list. Only in "block" mode (a
  // stricter opt-in, no longer the default) does the context stay byte-identical (locked names
  // remain a hard no).
  const washSaleHandling = input.policy.taxSettings?.washSaleHandling ?? DEFAULT_TAX_SETTINGS.washSaleHandling ?? "auto";
  // IRA-disregard: when the buyer is an IRA whose owner is on iraWashSaleHandling "disregard"
  // (the default), the gate PERMITS locked rebuys (annotated + audited). The prompt must know this
  // or the model, still told "NEVER propose a locked buy", would never surface the very rebuys the
  // setting exists to allow. IRA detection uses the SAME source-of-truth precedence as the gate
  // (isIraTaxRegime).
  const iraWashSaleDisregard =
    (input.policy.taxSettings?.iraWashSaleHandling ?? DEFAULT_TAX_SETTINGS.iraWashSaleHandling ?? "disregard") === "disregard" &&
    isIraTaxRegime(
      input.activeAccount?.taxationType,
      input.policy.taxSettings?.taxationType,
      input.activeAccount?.capabilities?.accountType
    );
  const washSaleRebuyCosts = (() => {
    if (washSaleHandling === "block" || !taxSummary) return undefined;
    const stRate = input.policy.taxSettings?.shortTermRatePct ?? DEFAULT_TAX_SETTINGS.shortTermRatePct;
    const locks = getUserWashSaleLockProvenance(input.userId, new Date());
    if (locks.size === 0) return undefined;
    return Array.from(locks.entries()).map(([sym, lock]) => ({
      symbol: sym,
      lossAccount: lock.account,
      clearsOn: lock.clearDate.toISOString().slice(0, 10),
      disallowedLossUsd: Number(lock.lossUsd.toFixed(2)),
      estimatedTaxCostUsd: Number(((lock.lossUsd * stRate) / 100).toFixed(2))
    }));
  })();
  const taxContext = taxSummary
    ? {
        taxYear: taxSummary.taxYear,
        shortTermRealizedYTD: taxSummary.shortTermRealized,
        longTermRealizedYTD: taxSummary.longTermRealized,
        estimatedTaxLiability: taxSummary.estimatedTaxLiability,
        washSaleLockedSymbols: taxSummary.lockedSymbols,
        ...(washSaleHandling !== "block" ? { washSaleHandling } : {}),
        ...(iraWashSaleDisregard ? { iraWashSaleDisregard: true } : {}),
        ...(washSaleRebuyCosts ? { washSaleRebuyCosts } : {}),
        positionsNearLongTerm: taxSummary.openLots
          .filter((lot) => !lot.isLongTerm && lot.daysToLongTerm <= 45)
          .map((lot) => ({
            symbol: lot.symbol,
            daysToLongTerm: lot.daysToLongTerm,
            ...(lot.earlyExitTaxPremium != null && lot.earlyExitTaxPremium > 0
              ? { earlyExitTaxPremium: Math.round(lot.earlyExitTaxPremium) }
              : {})
          })),
        harvestableLosses: taxSummary.harvestCandidates.slice(0, 6)
      }
    : null;
  const executionMode = llmExecutionMode(executionState) ?? "no-account";
  const executionModeClarification = llmModeClarification(executionState);
  // SHORT_SELLING: expose short/cover sides to the model ONLY when shorting is enabled in policy AND
  // the connected account actually supports it (capability-gated). Otherwise the schema is long-only
  // and the model cannot emit a short/cover. The policy.ts gate enforces the same two-layer check at
  // execution time as a backstop. Declared here (before the prompt) so both the prompt and schema use it.
  const allowedSides = allowedProposalSides(input.policy, input.activeAccount);
  const shortAllowed = allowedSides.includes("short");
  const systemPrompt = buildBullSystem({
    shortAllowed,
    executionMode,
    executionModeClarification,
    strategyPrompt: input.prompt,
    // reflection deliberately NOT interpolated into the SYSTEM prompt anymore (prompt-safety
    // lane, agentic-strategy@1.5.0): the post-mortem writer persists raw LLM output, so it rides
    // in userContent as the fenced `reflectionSummary` DATA field below instead.
    hasTaxContext: taxContext != null,
    washSaleHandling,
    iraWashSaleDisregard,
    holdingHorizon: input.policy.holdingHorizon ?? "swing",
    maxSymbolExposurePct: input.policy.maxSymbolExposurePct ?? 0,
    stopLossPct: input.policy.riskRules.stopLossPct ?? 8,
    takeProfitPct: input.policy.riskRules.takeProfitPct ?? 20
  });

  // Delta-only macro: macro moves slowly, so on repeat runs send just the changed
  // (plus regime-critical) fields and note the rest as unchanged to save tokens.
  const macro = await fetchMacroData(input.userId);
  const macroCacheKey = `last_macro_sent:${input.userId}`;
  const previousMacro = getInternalSetting<MacroData>(macroCacheKey);
  const { macro: macroForPrompt, omitted: macroOmitted } = pruneMacro(macro, previousMacro);
  setInternalSetting(macroCacheKey, macro);
  const macroeconomicData =
    macroOmitted.length > 0
      ? { ...macroForPrompt, unchangedSinceLastRun: macroOmitted }
      : macroForPrompt;

  const currentMarketRegime = determineMarketRegime(macro);

  // Market internals (breadth, sector rotation, median valuation) across the scan candidates,
  // and backend-derived macro metrics (curve spread, real rates, misery index, equity risk
  // premium). The median earnings yield feeds the ERP so it reflects today's actual universe.
  const marketInternals = input.marketScan ? computeMarketInternals(input.marketScan) : undefined;
  const macroDerived = deriveMacroMetrics(macro, { marketEarningsYield: marketInternals?.medianEarnYld });

  // Market-wide regime/sentiment from free, no-key sources (Cboe tail-risk, CFTC positioning,
  // Fama-French factor regime). Cached 6h; failure-tolerant — never blocks a run.
  const marketSignals = await getMarketSignals(input.userId).catch(() => undefined);

  // Multi-signal regime severity (Lane 5, composite review E/high/S follow-up): blends VIX term
  // structure, HY credit spread, and market breadth (+ VVIX/SKEW when available) into one
  // continuous [0,1] severity reading, floored by the classified enum's own severity so it can
  // only ADD caution vs. today's boolean-gate channel. Data-only receipt (prompt context +
  // proposal stamp) — does NOT change any cap/gate behavior. Best-effort: a scorer failure must
  // never fail the run.
  //
  // OPT-IN (DEFAULT false via policy.tuning.regimeSeverityScoring): default behavior is
  // byte-identical — the scorer is not invoked, so no regimeSeverity block, entryRegimeSeverity
  // stamp, or downstream receipt exists unless an operator opts in.
  const regimeSeverity = !input.policy.tuning?.regimeSeverityScoring
    ? undefined
    : (() => {
        try {
          const hyCreditSpreadPct = macro.hyCreditSpread ? parseFloat(macro.hyCreditSpread) : undefined;
          return computeMultiSignalSeverity({
            regime: classifyMarketRegime(macro).regime,
            vix: macro.vix ? parseFloat(macro.vix) : undefined,
            vixTermStructure: macroDerived.vixTermStructure,
            hyCreditSpreadPct: Number.isFinite(hyCreditSpreadPct) ? hyCreditSpreadPct : undefined,
            breadthPct: marketSignals?.marketBreadthPct ?? input.marketScan?.breadthPct,
            vvix: marketSignals?.vvix,
            skew: marketSignals?.skew
          });
        } catch {
          return undefined;
        }
      })();

  // [PHASE 2 OPTIMIZATION] Total Allowlist Abstraction
  // Instead of sending hundreds of allowed symbols to the LLM, we just tell it to only trade
  // from the provided topCandidates (which the backend pre-filters). We enforce this at the gateway.
  const allowedSymbolsForPrompt = {
    note: "All proposals must strictly be selected from `marketScan.topCandidates`. Do not propose symbols outside this list. You may SELL/TRIM any current position."
  };

  const effectiveMaxOrderNotional = Math.min(
    input.policy.maxOrderNotional ?? Infinity,
    input.policy.maxOrderPctOfNav && input.portfolio.totalMarketValue > 0
      ? (input.policy.maxOrderPctOfNav / 100) * input.portfolio.totalMarketValue
      : Infinity
  );
  const preferredMaxOrderNotional = applyOpeningOrderHeadroom(effectiveMaxOrderNotional);
  const userContent = {
    currentDate: new Date().toISOString(),
    executionMode,
    executionModeClarification,
    currentMarketRegime,
    ...(regimeSeverity
      ? {
          regimeSeverity: {
            severity: Number(regimeSeverity.severity.toFixed(2)),
            topComponents: [...regimeSeverity.components]
              .sort((a, b) => b.normalized * b.weight - a.normalized * a.weight)
              .slice(0, 3)
              .map((c) => ({ signal: c.signal, normalized: Number(c.normalized.toFixed(2)), weight: Number(c.weight.toFixed(2)) })),
            inputsUsed: regimeSeverity.inputsUsed,
            inputsAvailable: regimeSeverity.inputsAvailable
          }
        }
      : {}),
    portfolio: input.portfolio,
    positions: input.positions,
    recentOrders: input.recentOrders,
    allowedSymbols: allowedSymbolsForPrompt,
    marketScan: compactMarketScanForPrompt(input.marketScan),
    limits: {
      maxOrderNotional: Number.isFinite(effectiveMaxOrderNotional) ? Number(effectiveMaxOrderNotional.toFixed(2)) : undefined,
      preferredMaxOrderNotional: Number.isFinite(preferredMaxOrderNotional) ? Number(preferredMaxOrderNotional.toFixed(2)) : undefined,
      maxOrderPctOfNav: input.policy.maxOrderPctOfNav,
      remainingDailyNotional: remainingNotional,
      remainingDailyOrders: remainingOrders
    },
    ...(input.drawdownAdvisory
      ? {
          drawdownAdvisory: {
            note: "ADVISORY, not a block: this account has breached its drawdown circuit-breaker threshold. YOU decide whether to reduce risk, tighten sizing, favor exits, or proceed on conviction — every choice is logged and coachable. The only hard rule is the account boundary.",
            drawdownPctFromHighWaterMark: Number(input.drawdownAdvisory.drawdownPct.toFixed(2)),
            equity: input.drawdownAdvisory.equity,
            highWaterMark: input.drawdownAdvisory.highWaterMark,
            detail: input.drawdownAdvisory.reason
          }
        }
      : {}),
    ...(input.budgetAdvisory
      ? {
          budgetAdvisory: {
            note: "ADVISORY, not a block: operator LLM spend context. YOU decide whether a cheaper model tier or skipping this cycle is worth it — every choice is logged and coachable.",
            detail: input.budgetAdvisory
          }
        }
      : {}),
    socraticAuthority: {
      overrideMode: input.policy.socraticOverrideMode ?? "off",
      overrideMaxPctOfNav: input.policy.socraticOverrideMaxPctOfNav,
      note:
        "Use autonomyOverride only for evidence-backed conflicts with owner preference gates. Do not use it for broker/account/integrity constraints."
    },
    macroeconomicData,
    ...(Object.keys(macroDerived).length > 0 ? { macroDerived } : {}),
    ...(marketInternals ? { marketInternals } : {}),
    ...(marketSignals && Object.keys(marketSignals).length > 0 ? { marketSignals } : {}),
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { thesisOutcomes: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { regimeOutcomes: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { comboOutcomes: thesisRegimeScorecard } : {}),
    ...(signalEfficacy.length > 1 ? { signalEfficacy } : {}),
    ...(confidenceCalibration.length > 1 ? { confidenceCalibration } : {}),
    ...(sectorScorecard.length > 0 ? { sectorOutcomes: sectorScorecard } : {}),
    ...(factorScorecard.length > 0 ? { factorOutcomes: factorScorecard } : {}),
    ...(skippedCounterfactuals.length > 0 ? { skippedCounterfactuals } : {}),
    ...(taxContext ? { taxContext } : {}),
    ...(input.ragContext ? { retrievedFinancialContext: input.ragContext } : {}),
    ...(input.learnedContext ? { learnedContext: input.learnedContext } : {}),
    // Historical reflection RELOCATED here from the Bull SYSTEM prompt (prompt-safety lane): it is
    // persisted raw LLM output, so it enters as fenced, labeled user-role DATA — the system prompt
    // references it by name and the data-not-command clause covers it.
    ...(reflection ? { reflectionSummary: `<reflection_summary>\n${reflection}\n</reflection_summary>` } : {}),
    // Episodic decision memory (composite review A1): labeled analogs + owner-coaching blocks.
    // Mirrored into the Red Team review's adversaryContext below — evidence parity between the
    // strategist and its reviewer is the point.
    ...(input.experienceAnalogs ? { closestHistoricalAnalogs: input.experienceAnalogs } : {}),
    ...(input.ownerCoaching ? { ownerCoaching: input.ownerCoaching } : {})
  };

  // ── Advisory prompt-injection scan (CR-H prompt-safety lane) ─────────────
  // Deterministic receipts over the UNTRUSTED text blocks entering the Bull/Bear prompts. The
  // per-candidate fields mirror EXACTLY what compactCandidateForPrompt injects (news = first 2
  // headlines, smartMoney = first 3 bulletins). Detection IS the control: on a hit we audit and
  // surface evidence — the text is NEVER altered or dropped, and generation always proceeds.
  const untrustedPromptFields: UntrustedPromptField[] = [
    { name: "owner_strategy_prompt", text: input.prompt },
    { name: "reflection_summary", text: reflection },
    { name: "retrievedFinancialContext", text: input.ragContext ?? "" },
    { name: "learnedContext", text: input.learnedContext ?? "" },
    { name: "closestHistoricalAnalogs", text: input.experienceAnalogs ?? "" },
    { name: "ownerCoaching", text: input.ownerCoaching ?? "" },
    ...(input.marketScan?.topCandidates ?? []).flatMap((candidate) => {
      const sym = normalizeSymbol(candidate.symbol);
      const fields: UntrustedPromptField[] = [];
      const news = candidate.headlines?.slice(0, 2) ?? [];
      if (news.length > 0) fields.push({ name: `headlines:${sym}`, text: news.join("\n") });
      const bulletins = candidate.evidenceBulletins?.slice(0, 3) ?? [];
      if (bulletins.length > 0) fields.push({ name: `smartMoney:${sym}`, text: bulletins.join("\n") });
      return fields;
    })
  ];
  const promptSafetyFindings = scanForInjectionAttempts(untrustedPromptFields);
  if (promptSafetyFindings.length > 0) {
    audit(
      "prompt_injection_suspected",
      {
        runId: input.runId,
        fields: [...new Set(promptSafetyFindings.map((f) => f.name))],
        patterns: [...new Set(promptSafetyFindings.map((f) => f.pattern))],
        findings: promptSafetyFindings.slice(0, 12).map((f) => ({ ...f, excerpt: f.excerpt.slice(0, 240) }))
      },
      input.userId,
      input.policy.connectedAccountId
    );
  }

  const model = resolvedModel;
  const llmSteps: StrategyLlmStep[] = [];

  const recordStep = (step: StrategyLlmStep, options: { includeInResult?: boolean } = {}) => {
    if (options.includeInResult !== false) llmSteps.push(step);
    audit("llm_step", { runId: input.runId, ...step }, input.userId, input.policy.connectedAccountId);
  };

  const autonomyOverrideSchema = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["requested", "thesis", "preferenceConflicts", "invalidation", "cashDeploymentPct"],
        properties: {
          requested: { type: "boolean" },
          thesis: { type: "string" },
          preferenceConflicts: { type: "array", items: { type: "string" } },
          invalidation: { type: ["string", "null"] },
          cashDeploymentPct: { type: ["number", "null"] }
        }
      },
      { type: "null" }
    ]
  };

  // Per-position stop-loss TYPE (distinct from bracketStopLoss, a per-trade stop PRICE). Only
  // meaningful on an OPENING (buy/short) proposal — set for a sell/cover, it is dropped by
  // sanitizeProposals. Persisted for the position's life once the opening order fills, so this
  // choice (including "none") governs every stop-enforcement layer until the position closes, not
  // just the entry order.
  const stopPlanSchema = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["style", "rationale"],
        properties: {
          style: {
            enum: ["default", "fixed", "atr", "trailing", "none"],
            description: "'default' = RESET this position to the account's own stop precedence, clearing any existing fixed/atr/trailing/none override on file for it — a deliberate choice, not a no-op. If you have no reason to change this position's existing stop handling (including on a scale-in add to a position with a prior override), leave the whole stopPlan field null/omitted instead of setting 'default' — that inherits whatever is already on file unchanged. 'fixed' = pin this position to the account's flat base stop %, skipping ATR/beta adjustment. 'atr' = pin to the name's own realized-volatility stop distance (falls back to the flat % if bars are unavailable). 'trailing' = protect this position with a high-water-mark trail instead of a fixed stop. 'none' = carry NO stop-loss on this position — a real, risk-increasing choice; use only with a strong justification in `rationale`."
          },
          rationale: { type: ["string", "null"], description: "Why this style (required, in plain language, when style is 'none' — optional otherwise)." }
        }
      },
      { type: "null" }
    ]
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: maxProposals,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "symbol",
            "side",
            "type",
            "quantity",
            "dollarAmount",
            "limitPrice",
            "stopPrice",
            "timeInForce",
            "marketHours",
            "rationale",
            "tradeThesisTag",
            "confidenceScore",
            "autonomyOverride",
            "bracketStopLoss",
            "bracketTakeProfit",
            "stopPlan"
          ],
          properties: {
            symbol: { type: "string" },
            // SHORT_SELLING: short/cover included only when `allowedSides` (computed above) permits —
            // i.e. policy.shortSellingEnabled AND the connected account reports shortSelling. Default long-only.
            side: { enum: allowedSides },
            type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
            quantity: { type: ["number", "null"] },
            dollarAmount: { type: ["number", "null"] },
            limitPrice: { type: ["number", "null"] },
            stopPrice: { type: ["number", "null"] },
            timeInForce: { enum: ["gfd", "gtc"] },
            marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
            rationale: { type: "string" },
            tradeThesisTag: { enum: THESIS_PLAYBOOK },
            confidenceScore: { type: "number", minimum: 1, maximum: 100, description: "Conviction score from 1 to 100" },
            autonomyOverride: autonomyOverrideSchema,
            bracketStopLoss: { type: ["number", "null"], description: "Per-trade protective stop PRICE (absolute price, not a percent) for this position. For a buy set it BELOW the entry, for a short ABOVE it. Derive it from the setup's own structure — a support/resistance level, a multiple of ATR, or the price that invalidates the thesis — sized to conviction, not a fixed one-size percentage. Leave null to fall back to the account's default per-symbol stop." },
            bracketTakeProfit: { type: ["number", "null"], description: "Optional per-trade take-profit PRICE (absolute). For a buy ABOVE the entry, for a short BELOW it. Leave null to use the account default." },
            stopPlan: stopPlanSchema
          }
        }
      }
    }
  };

  const bullReasoningEffort = interactiveStrategyReasoningEffort(model, input.policy.llmReasoningEffort);
  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent: JSON.stringify(userContent),
      schema: { name: "trade_proposals", schema, description: "The trade proposals the strategy advises this run." },
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
      reasoningEffort: bullReasoningEffort
    }
  );

  // Cross-provider FAILOVER chain (Chat A item 4): primary first, then each policy.llmFallbackModels
  // entry that has a credential. Empty list => primary only (default; byte-identical behavior). On a
  // TRANSIENT failure (HTTP 429/5xx or timeout) the SAME request is re-issued against the next model.
  const bullAttempts = [
    { url, provider, model, transport, key: openaiKey, keySource: llmKeySource, keyRef: llmKeyRef, body }
  ];
  const fallbackModelList = Array.isArray(input.policy.llmFallbackModels) ? input.policy.llmFallbackModels : [];
  for (const fallbackModel of fallbackModelList.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean)) {
    const ep = resolveLlmEndpoint({ ...input.policy, llmModel: fallbackModel }, input.userId);
    if (!ep.key) continue; // No credential for this provider's model — skip it rather than fail.
    bullAttempts.push({
      url: ep.url,
      provider: ep.provider,
      model: ep.model,
      transport: ep.transport,
      key: ep.key,
      keySource: ep.keySource,
      keyRef: ep.keyRef,
      body: buildLlmRequestBody(
        { provider: ep.provider, transport: ep.transport },
        {
          model: ep.model,
          systemPrompt,
          userContent: JSON.stringify(userContent),
          schema: { name: "trade_proposals", schema, description: "The trade proposals the strategy advises this run." },
          maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
          reasoningEffort: interactiveStrategyReasoningEffort(ep.model, input.policy.llmReasoningEffort)
        }
      )
    });
  }
  // Which endpoint actually served the run (starts as the primary; updated on failover). Transport
  // and keySource are tracked too so the served step/audit trail reports the FALLBACK's transport
  // (e.g. anthropic-messages vs the primary's responses), not the primary's — accurate money-path tracing.
  let bullServedProvider = provider;
  let bullServedModel = model;
  let bullServedTransport = transport;
  let bullServedKeySource = llmKeySource;
  let bullFailoverNote: string | undefined;

  const bullStepBase = {
    step: "bull" as const,
    label: "Green Team proposal",
    provider,
    model,
    transport,
    keySource: llmKeySource
  };
  recordStep({ ...bullStepBase, status: "started" }, { includeInResult: false });
  let bullResult: { text?: string; proposals: TradeProposal[]; truncated?: boolean; wireOutputCap?: number; finishReason?: string };
  // Raw provider finish/stop-reason string for the strategy_bull_truncated audit below — same
  // transports `detectLlmTruncation` (llm-call.ts) inspects, but that helper only returns a bool;
  // this surfaces the actual reason value so the audit says WHY the model stopped, not just that it did.
  const extractBullFinishReason = (payload: unknown): string | undefined => {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as {
      stop_reason?: unknown;
      choices?: Array<{ finish_reason?: unknown }>;
      incomplete_details?: { reason?: unknown } | null;
      status?: unknown;
      output?: Array<{ status?: unknown } | null>;
    };
    if (typeof p.stop_reason === "string") return p.stop_reason;
    const chatReason = p.choices?.[0]?.finish_reason;
    if (typeof chatReason === "string") return chatReason;
    if (typeof p.incomplete_details?.reason === "string") return p.incomplete_details.reason;
    if (typeof p.status === "string") return p.status;
    // Responses-API shape with only per-item statuses (no top-level status/incomplete_details):
    // detectLlmTruncation treats any output item with status "incomplete" as truncation.
    if (Array.isArray(p.output) && p.output.some((o) => o?.status === "incomplete")) return "incomplete";
    return undefined;
  };
  try {
    bullResult = await withLlmGeneration(
      {
        name: "trading.strategy.bull",
        model,
        userId: input.userId,
        connectedAccountId: input.policy.connectedAccountId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport,
          maxProposals,
          executionMode,
          currentMarketRegime,
          promptVersion: STRATEGY_PROMPT_VERSION
        },
        tags: ["strategy", "bull-agent"],
        output: (result) => ({
          ...summarizeOpenAiResponseText(result.text),
          ...summarizeTradeProposals(result.proposals)
        })
      },
      async () => {
        let lastError: unknown;
        for (let i = 0; i < bullAttempts.length; i++) {
          const attempt = bullAttempts[i];
          const isLast = i === bullAttempts.length - 1;
          const next = bullAttempts[i + 1];
          try {
            const bullSoftTimeoutMs = strategyLlmTimeoutMs(attempt.model, input.policy.llmReasoningEffort);
            // Reasoning-class-aware SOFT wall-clock: a thinking-enabled model gets the widened bound.
            // The request is NOT severed at the wall — if it's slow the tick moves on, but the eventual
            // reply + its true latency are captured for debug (recordLlmOutcome), instead of discarded.
            const response = await llmFetchCapturing(
              attempt.url,
              {
                method: "POST",
                headers: llmAuthHeaders({ provider: attempt.provider, key: attempt.key }),
                body: JSON.stringify(attempt.body)
              },
              {
                softTimeoutMs: bullSoftTimeoutMs,
                onOutcome: (o) => recordLlmOutcome(o, { runId: input.runId, userId: input.userId, step: "bull", provider: attempt.provider, model: attempt.model, softTimeoutMs: bullSoftTimeoutMs, connectedAccountId: input.policy.connectedAccountId })
              }
            );

            if (!response.ok) {
              const detail = await response.text();
              if (!isLast && isRetryableLlmStatus(response.status)) {
                lastError = new Error(humanizeLlmError(detail, { provider: attempt.provider, status: response.status }));
                console.warn(`[Bull] ${attempt.model}/${attempt.provider} failed (HTTP ${response.status}); failing over to ${next.model}/${next.provider}.`);
                audit("strategy_llm_failover", { runId: input.runId, step: "bull", fromModel: attempt.model, fromProvider: attempt.provider, httpStatus: response.status, toModel: next.model, toProvider: next.provider }, input.userId, input.policy.connectedAccountId);
                continue;
              }
              throw new Error(humanizeLlmError(detail, { provider: attempt.provider, status: response.status }));
            }
            const payload = await response.json();
            recordLlmUsage({ userId: input.userId, provider: attempt.provider, model: attempt.model, context: "strategy", keySource: attempt.keySource, keyRef: attempt.keyRef, connectedAccountId: input.policy.connectedAccountId, ...extractLlmUsage(payload) });
            if (i > 0) {
              bullServedProvider = attempt.provider;
              bullServedModel = attempt.model;
              bullServedTransport = attempt.transport;
              bullServedKeySource = attempt.keySource;
              bullFailoverNote = `Primary Green Team model ${model}/${provider} was unavailable; served by fallback ${attempt.model}/${attempt.provider} (attempt ${i + 1}/${bullAttempts.length}).`;
            }
            const text = extractLlmText(payload);
            const truncated = detectLlmTruncation(payload);
            // The wire cap actually sent for THIS attempt (base cap + provider reasoning headroom —
            // e.g. Gemini/xAI/Mistral/DeepSeek add up to +16000), not the pre-headroom constant.
            const wireOutputCap = resolveLlmWireOutputCap(attempt.transport, {
              maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
              model: attempt.model,
              reasoningEffort: interactiveStrategyReasoningEffort(attempt.model, input.policy.llmReasoningEffort)
            });
            const finishReason = extractBullFinishReason(payload);

            if (!text) {
              throw new Error("Empty response returned from LLM API.");
            }

            try {
              // R10 — fence/prose-tolerant extraction on the PRIMARY (Green/Bull) parse path too:
              // fenced JSON on the proposal step must not degrade to zero proposals.
              const parsed = JSON.parse(extractJsonPayload(text)) as { proposals?: TradeProposal[] };
              return { text, proposals: parsed.proposals ?? [], truncated, wireOutputCap, finishReason };
            } catch (parseError) {
              // A truncated/malformed model response must not crash the whole autonomous
              // run; degrade to zero proposals for this tick. The `truncated` flag lets the caller
              // record a DISTINCT truncation reason instead of a silent no-op (see below).
              console.warn("Bull Agent returned unparseable JSON; degrading to zero proposals this run", parseError);
              return { text, proposals: [] as TradeProposal[], truncated, wireOutputCap, finishReason };
            }
          } catch (err) {
            // Transient transport error / timeout → fail over to the next model when one remains.
            if (!isLast && isRetryableLlmError(err)) {
              lastError = err;
              console.warn(`[Bull] ${attempt.model}/${attempt.provider} errored (${(err as { message?: string })?.message ?? String(err)}); failing over to ${next.model}/${next.provider}.`);
              audit("strategy_llm_failover", { runId: input.runId, step: "bull", fromModel: attempt.model, fromProvider: attempt.provider, reason: "transport_or_timeout", toModel: next.model, toProvider: next.provider }, input.userId, input.policy.connectedAccountId);
              continue;
            }
            throw err;
          }
        }
        throw lastError ?? new Error("All Green Team endpoints failed.");
      }
    );
  } catch (error) {
    const reason = humanizeLlmTransportError(error, { provider, model, stepLabel: "Green Team proposal", timeoutMs: strategyLlmTimeoutMs(model, input.policy.llmReasoningEffort) });
    const failedStep: StrategyLlmStep = { ...bullStepBase, status: "failed", reason };
    recordStep(failedStep);
    throw new StrategyLlmStepFailure(reason, llmSteps, error);
  }

  const rawBullProposals = sanitizeProposals(bullResult.proposals, maxProposals).map(p => ({
    ...p,
    entryMarketRegime: currentMarketRegime,
    ...(regimeSeverity ? { entryRegimeSeverity: Number(regimeSeverity.severity.toFixed(2)) } : {}),
    // FAILOVER-AWARE attribution: the model that actually served this run (not necessarily
    // policy.llmModel). Persisted with the proposal so approval-time attribution stays accurate.
    proposedByModel: bullServedModel
  }));
  // TRUNCATION-AWARE: if the Bull answer hit the output-token cap, a zero/partial parse is NOT a
  // genuine "do nothing" — record a DISTINCT reason + audit so it's diagnosable and never a silent
  // no-op. (See Chat A item 5; raise LLM_OUTPUT_TOKEN_CAPS.strategyProposal if this recurs.) The
  // reason string and audit payload report the ACTUAL wire cap (post reasoning-headroom), not the
  // pre-headroom LLM_OUTPUT_TOKEN_CAPS constant, which can understate what was really sent.
  const bullTruncationReason = bullResult.truncated
    ? `Green Team response hit the ${bullResult.wireOutputCap ?? LLM_OUTPUT_TOKEN_CAPS.strategyProposal}-token output cap (truncated${bullResult.finishReason ? `, finish_reason=${bullResult.finishReason}` : ""}); ${rawBullProposals.length} proposal(s) parsed. Raise LLM_OUTPUT_TOKEN_CAPS.strategyProposal if this recurs.`
    : undefined;
  if (bullTruncationReason) {
    console.warn(`[Bull] ${bullTruncationReason}`);
    audit(
      "strategy_bull_truncated",
      {
        runId: input.runId,
        cap: LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
        wireOutputCap: bullResult.wireOutputCap,
        finishReason: bullResult.finishReason,
        parsedProposals: rawBullProposals.length,
        provider,
        model
      },
      input.userId,
      input.policy.connectedAccountId
    );
  }
  // Record the served provider/model (may differ from the primary after failover) plus a clear reason
  // combining any failover note and truncation note, so the run record shows exactly what happened.
  const bullCompletedReason = [bullFailoverNote, bullTruncationReason].filter(Boolean).join(" ") || undefined;
  recordStep({
    ...bullStepBase,
    provider: bullServedProvider,
    model: bullServedModel,
    transport: bullServedTransport,
    keySource: bullServedKeySource,
    status: "completed",
    proposalCount: rawBullProposals.length,
    ...(bullCompletedReason ? { reason: bullCompletedReason } : {})
  });

  // Deterministic pre-filter: model-independent veto layer that runs before the Bear LLM.
  // See deterministicBearFilter for the rules (no-phantom-exit HARD drop, momentum overextension
  // flag, and the ADVISORY fundamentals + below-median-in-risk-off pre-vetoes which now TAG the
  // candidate with `preVetoReasons` and keep it rather than dropping it). Vetoed proposals are logged
  // and — FIX #2b — durably AUDITED below so an overridden pre-veto is recorded even when the trade
  // proceeds (the filter previously recorded nothing but a console.log, leaving an overridden
  // fundamentals veto invisible in the audit feed).
  const { kept: bullProposals, vetoed: deterministicVetoed } = deterministicBearFilter(
    rawBullProposals,
    input.positions,
    input.marketScan?.topCandidates ?? [],
    currentMarketRegime,
    {
      fcfYieldFloorPct: input.policy.tuning?.bearVetoFcfYieldFloorPct,
      debtToEquityCeiling: input.policy.tuning?.bearVetoDebtToEquityCeiling
    }
  );
  if (deterministicVetoed.length > 0) {
    console.log("[DeterministicBear] Vetoed before Bear LLM:", deterministicVetoed.map(v => `${v.symbol} ${v.side}: ${v.reason}`).join(" | "));
    // FIX #2b: durably audit each deterministic-bear veto (kept-and-tagged OR hard-dropped) so an
    // overridden fundamentals/regime veto is visible in the Activity/Audit feed, not just console.
    // ACCOUNT-scoped (connectedAccountId) to match the counterfactual rows and the red-team audits.
    for (const v of deterministicVetoed) {
      audit(
        "deterministic_bear_veto",
        { runId: input.runId, symbol: v.symbol, side: v.side, reason: v.reason, regime: currentMarketRegime },
        input.userId,
        input.policy.connectedAccountId
      );
    }
  }

  // ── The in-flow Bear LLM pass was DELETED 2026-07-07 (single-adversary consolidation §3.1) ──
  // proposeTrades now returns the deterministic-filtered Bull output directly (R6) with NO second
  // LLM call. The one surviving adversary is the post-sizing Red Team review in the strategy loop
  // (debateProposal), which inherited BOTH of the Bear's jobs. The model-free deterministic
  // pre-filter above (deterministicBearFilter) is NOT part of the deleted redundancy and stays.
  // Main's Bear-side additions (bearSchema bracket fields, parseBearSurvivors — PR #1036/#1095)
  // die with the inline Bear; the Bull schema + enrichOpeningProposal carry the bracket features.
  //
  // R7 — evidence context for that single review: the reviewer must fact-check the strategist's
  // claims against the SAME structured candidate evidence + macro/portfolio context the Bull saw
  // (a counterexample the Bull rationalized away is reviewer ammunition). Built here so it reuses
  // the exact userContent blocks assembled above, and returned to the caller for the review calls.
  const proposedSymbols = new Set(bullProposals.map((proposal) => normalizeSymbol(proposal.symbol)));
  const candidatesUnderReview = userContent.marketScan?.topCandidates?.filter((candidate) =>
    typeof candidate.sym === "string" && proposedSymbols.has(normalizeSymbol(candidate.sym))
  );
  const adversaryContext: RedTeamReviewContext = {
    currentDate: userContent.currentDate,
    currentMarketRegime: userContent.currentMarketRegime,
    ...(userContent.regimeSeverity ? { regimeSeverity: userContent.regimeSeverity } : {}),
    macroeconomicData: userContent.macroeconomicData,
    limits: userContent.limits,
    socraticAuthority: userContent.socraticAuthority,
    portfolio: input.portfolio,
    positions: input.positions,
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { thesisOutcomes: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { regimeOutcomes: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { comboOutcomes: thesisRegimeScorecard } : {}),
    ...(input.experienceAnalogs ? { closestHistoricalAnalogs: input.experienceAnalogs } : {}),
    ...(input.ownerCoaching ? { ownerCoaching: input.ownerCoaching } : {}),
    candidatesUnderReview
  };

  return {
    proposals: bullProposals,
    llmSteps,
    adversaryContext,
    ...(promptSafetyFindings.length > 0 ? { promptSafetyFindings } : {})
  };
}

export function currentPricesFromScan(scan?: MarketScan): Record<string, number> {
  if (!scan) return {};
  return Object.fromEntries(
    Object.values(scan.quotesBySymbol)
      .filter((quote) => quote.price > 0)
      .map((quote) => [quote.symbol, quote.price] as const)
  );
}

/**
 * Real (non-synthetic, positive) bid/ask off a scan quote for anchoring a protective-exit
 * marketable limit, with the composite price as the fallback anchor. A synthesized (price-derived)
 * spread side never anchors — same guard the entry marketable-limit applies, judged per side.
 */
export function protectiveExitQuoteFromScan(quote: MarketQuoteSummary | undefined): ProtectiveExitQuote | undefined {
  if (!quote) return undefined;
  return {
    price: quote.price > 0 ? quote.price : undefined,
    bid: !quote.syntheticBid && quote.bid && quote.bid > 0 ? quote.bid : undefined,
    ask: !quote.syntheticAsk && quote.ask && quote.ask > 0 ? quote.ask : undefined
  };
}

export function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

// Broker order objects are verbose; the agent only needs recent intent/outcome.
// Send a slim, recent slice instead of 20 raw records.
function compactRecentOrders(orders: EquityOrder[]): Array<Record<string, unknown>> {
  return orders.slice(0, 8).map((order) => {
    const quantity = order.filledQuantity ?? order.quantity;
    return {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      state: order.state,
      ...(order.dollarAmount ? { dollarAmount: order.dollarAmount } : {}),
      ...(quantity ? { quantity } : {}),
      ...(order.averagePrice ? { avgPrice: order.averagePrice } : {}),
      createdAt: order.createdAt
    };
  });
}

/** A real, quoted ask — excludes a synthesized (price-derived) spread. A synthetic ask must
 *  NEVER anchor ask-relative limit-price math; it degrades to the refPrice-based branch instead. */
function hasRealAsk(quote: MarketQuote): boolean {
  return Boolean(quote.ask && quote.ask > 0 && !quote.syntheticAsk);
}

function compactMarketScanForPrompt(marketScan?: MarketScan) {
  if (!marketScan) return undefined;
  const hasAskData = marketScan.topCandidates.some(hasRealAsk);
  return {
    source: marketScan.source,
    generatedAt: marketScan.generatedAt,
    scannedSymbols: marketScan.scannedSymbols,
    returnedQuotes: marketScan.returnedQuotes,
    candidateLimit: marketScan.candidateLimit,
    outlierReserve: marketScan.outlierReserve,
    outlierCandidateCount: marketScan.outlierCandidateCount,
    cacheTtlMs: marketScan.cacheTtlMs,
    cached: marketScan.cached,
    hasAskData,
    topCandidates: marketScan.topCandidates.map(compactCandidateForPrompt),
    instructions: hasAskData
      ? "Ask-relative buy limits are allowed only for candidates that include ask."
      : "No ask prices are available in this scan. Do not invent ask-relative limit prices."
  };
}

function compactCandidateForPrompt(quote: MarketScan["topCandidates"][number], index: number): Record<string, unknown> {
  // Never feed a SYNTHETIC (price-derived) bid/ask to the LLM as if it were a real quoted spread —
  // it would wrongly anchor ask-relative limit-price reasoning. Emit each side only when it is not
  // synthetic (compactPromptObject drops undefined keys, matching hasAskData).
  const realBid = !quote.syntheticBid ? quote.bid : undefined;
  const realAsk = !quote.syntheticAsk ? quote.ask : undefined;
  return compactPromptObject({
    rank: index + 1,
    sym: quote.symbol,
    px: quote.price,
    bid: realBid,
    ask: realAsk,
    vol: quote.volume,
    mktCap: quote.marketCap,
    chgPct: quote.intradayChangePct,
    pe: quote.peRatio,
    eps: quote.eps,
    div: quote.dividendYield,
    fcf: quote.fcfYield,
    de: quote.debtToEquity,
    epsGr: quote.epsGrowth,
    pb: quote.pbRatio,
    shortFloat: quote.shortPercentOfFloat,
    beta: quote.beta,
    earnIn: quote.daysToEarnings,
    instOwn: quote.institutionOwnershipPct,
    iv: quote.nearTheMoneyIv,
    putCall: quote.putCallRatio,
    range52w: pricePosition52w(quote),
    // Backend-derived ratios (PEG, earnings yield, ROE, payout, $ volume, spread) are
    // computed deterministically, then omitted when their inputs are unavailable. Pass the
    // synthetic-stripped bid/ask so a price-derived (synthetic) spread doesn't leak into the prompt
    // as a fabricated `spreadBps` execution-cost signal — matching the bid/ask omission above.
    ...deriveMetrics({ ...quote, bid: realBid, ask: realAsk }),
    secRelStr: quote.sectorRelStrength,
    newsSent: quote.sentiment,
    insiderSent: quote.insiderSentiment,
    senateNet: quote.senateTrades,
    congressScore: quote.congressCompositeScore,
    congressDir: quote.congressCompositeDirection,
    congressConf: quote.congressCompositeConfidence,
    smartMoney: quote.evidenceBulletins?.slice(0, 3),
    rating: quote.analystRating,
    ratingScore: quote.analystScore,
    news: quote.headlines?.slice(0, 2),
    sec: quote.sector,
    ind: quote.industry,
    posMV: quote.positionMarketValue,
    score: quote.score,
    factors: quote.factorBreakdown,
    techScore: quote.technicalScore,
    techDir: quote.technicalDirection,
    techSignals: quote.technicalSignals?.slice(0, 5),
    provider: quote.provider,
    asOf: quote.asOf
  });
}

function compactPromptObject(values: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === "posMV" && value === 0) continue;
    compacted[key] = value;
  }
  return compacted;
}

// The LLM is told confidenceScore is 1–100, but json_schema strict mode does not
// reliably enforce numeric bounds, and the value deterministically drives position
// size. Clamp it before it can reach sizing or the calibration scorecard.
function clampConfidence(score: number | undefined): number | undefined {
  if (typeof score !== "number" || Number.isNaN(score)) return undefined;
  return Math.min(100, Math.max(1, score));
}

/**
 * Record the outcome of a strategy Green/Bear LLM call for observability. Fires for EVERY call (fast
 * or late): an `llm_call_latency` audit captures the real duration so the timeout can be tuned from
 * data instead of a guess. When the call was slow (the tick already moved on) or errored, it ALSO
 * captures the eventual reply we paid for — text snippet + token usage — in an `llm_late_response`
 * audit, rather than discarding it.
 */
function recordLlmOutcome(
  outcome: LlmCallOutcome,
  ctx: { runId?: string; userId: string; step: "bull" | "bear"; provider: string; model: string; softTimeoutMs: number; connectedAccountId?: string }
): void {
  audit(
    "llm_call_latency",
    { runId: ctx.runId, step: ctx.step, provider: ctx.provider, model: ctx.model, durationMs: outcome.durationMs, softTimeoutMs: ctx.softTimeoutMs, late: outcome.late, ok: outcome.ok, status: outcome.status, error: outcome.error },
    ctx.userId,
    ctx.connectedAccountId
  );
  // Only the LATE path reads the body: there the tick bailed at the soft timeout and never touched the
  // response, so we alone can drain it. A FAST response (success, or a non-ok like a 429 that fails
  // over) is read by the normal flow — recording must NOT also read it or the two race on the body.
  if (!outcome.late) return;
  void (async () => {
    try {
      let textSnippet: string | undefined;
      let usage: unknown;
      if (outcome.response) {
        const payload = await outcome.response.json().catch(() => undefined);
        if (payload) {
          const text = extractLlmText(payload);
          textSnippet = typeof text === "string" && text ? text.slice(0, 4000) : undefined;
          usage = extractLlmUsage(payload);
        }
      }
      audit(
        "llm_late_response",
        { runId: ctx.runId, step: ctx.step, provider: ctx.provider, model: ctx.model, durationMs: outcome.durationMs, late: outcome.late, ok: outcome.ok, status: outcome.status, error: outcome.error, textSnippet, usage },
        ctx.userId,
        ctx.connectedAccountId
      );
    } catch (err) {
      audit("llm_late_response_capture_error", { runId: ctx.runId, step: ctx.step, error: err instanceof Error ? err.message : String(err) }, ctx.userId, ctx.connectedAccountId);
    }
  })();
}

// filterStopPlansByLiveBasis lives in db-api-keys.ts (alongside getStopPlans/PositionStopPlan) so
// synthetic-stops.ts can import it too without depending on this module — re-exported here (as the
// same binding imported above) so existing consumers (tests included) keep importing it from
// "./strategy" unchanged.
export { filterStopPlansByLiveBasis };

export function sanitizeProposals(proposals: TradeProposal[], max = 3): TradeProposal[] {
  return proposals
    .filter((proposal) => proposal.symbol && proposal.side && proposal.type)
    .slice(0, max)
    .map((proposal) => ({
      ...proposal,
      symbol: normalizeSymbol(proposal.symbol),
      confidenceScore: clampConfidence(proposal.confidenceScore),
      quantity: proposal.quantity ?? undefined,
      dollarAmount: proposal.dollarAmount ?? undefined,
      limitPrice: proposal.limitPrice ?? undefined,
      stopPrice: proposal.stopPrice ?? undefined,
      // Per-trade protective bracket the LLM may now propose (schema-exposed). Carry a finite, positive
      // price through; enrichOpeningProposal validates the SIDE (below entry for a long, above for a
      // short) and falls back to the per-symbol default when absent or nonsensical.
      bracketStopLoss: Number.isFinite(proposal.bracketStopLoss) && (proposal.bracketStopLoss ?? 0) > 0 ? proposal.bracketStopLoss : undefined,
      bracketTakeProfit: Number.isFinite(proposal.bracketTakeProfit) && (proposal.bracketTakeProfit ?? 0) > 0 ? proposal.bracketTakeProfit : undefined,
      timeInForce: proposal.timeInForce ?? "gfd",
      marketHours: proposal.marketHours ?? "regular_hours",
      tradeThesisTag: proposal.tradeThesisTag ?? undefined,
      entryMarketRegime: proposal.entryMarketRegime ?? undefined,
      autonomyOverride:
        proposal.autonomyOverride?.requested === true
          ? {
              requested: true,
              thesis: String(proposal.autonomyOverride.thesis ?? "").slice(0, 2000),
              preferenceConflicts: Array.isArray(proposal.autonomyOverride.preferenceConflicts)
                ? proposal.autonomyOverride.preferenceConflicts.map(String).slice(0, 8)
                : [],
              ...(proposal.autonomyOverride.invalidation ? { invalidation: String(proposal.autonomyOverride.invalidation).slice(0, 1000) } : {}),
              ...(typeof proposal.autonomyOverride.cashDeploymentPct === "number" && Number.isFinite(proposal.autonomyOverride.cashDeploymentPct)
                ? { cashDeploymentPct: Math.max(0, Math.min(100, proposal.autonomyOverride.cashDeploymentPct)) }
                : {})
            }
          : undefined,
      // Per-position stop TYPE the LLM may choose (schema-exposed) — only meaningful on an OPENING
      // side; a sell/cover proposal has nothing to set a forward-looking stop plan for. An
      // unrecognized style is dropped entirely (equivalent to "no plan set" — falls through to
      // whatever's persisted for this symbol, unchanged from before this field existed). Unlike an
      // unrecognized style, an explicit "default" IS preserved (not dropped) rather than collapsed to
      // `undefined` — collapsing it would be indistinguishable from "the LLM never touched this
      // field," which falls through to a STALE persisted override instead of the owner/LLM's actual,
      // deliberate choice to reset a scale-in back to the account's own precedence (Codex review, PR
      // #1371). Downstream, both `enrichOpeningProposal`'s and `recordFillFromProposal`'s precedence
      // treat this same non-nullish "default" string exactly like the fallback default already did.
      stopPlan: ((): TradeProposal["stopPlan"] => {
        if (!(proposal.side === "buy" || proposal.side === "short")) return undefined;
        if (!proposal.stopPlan || !STOP_PLAN_STYLES.includes(proposal.stopPlan.style)) return undefined;
        const rationale =
          typeof proposal.stopPlan.rationale === "string" && proposal.stopPlan.rationale.trim()
            ? proposal.stopPlan.rationale.slice(0, 2000)
            : undefined;
        // "none" is a real, risk-increasing choice — the schema asks for a rationale, but the LLM
        // isn't guaranteed to supply one. Without it, "none" is indistinguishable from an oversight,
        // so it must never persist unexplained. Treat it as ABSENT (undefined), not as an explicit
        // "default" — "default" has RESET semantics downstream (enrichOpeningProposal ignores any
        // persisted plan for the symbol, and the fill path CLEARS the row), so manufacturing one from
        // a malformed "none" could silently wipe out an existing fixed/ATR/trailing/none override the
        // owner deliberately set earlier. Absent falls through to whatever's on file, unchanged —
        // the same as any other unrecognized/missing plan (Codex review, PR #1371).
        if (proposal.stopPlan.style === "none" && !rationale) return undefined;
        return { style: proposal.stopPlan.style, ...(rationale ? { rationale } : {}) };
      })()
    }))
    // Protective Risk-Exits execute as market orders so they cannot rest unfilled (see helper above).
    .map(coerceProtectiveExitToMarket);
}

/**
 * Stamp an opening proposal with the entry anchor (referencePrice) the deterministic entry-drift
 * guard compares against at approval time, and — on brokers with native bracket support (Alpaca),
 * when policy.brokerBracketsEnabled is not disabled — attach broker-held stop-loss/take-profit legs
 * derived from riskRules so protective exits rest at the matching engine and survive local downtime
 * (a crash/DB-lock/disconnect no longer leaves a position unprotected). No-op for non-opening sides
 * and for brokers without native brackets (the synthetic scheduler-tick monitor remains the fallback
 * there). Pre-existing bracket fields on the proposal are never overwritten.
 */
export function enrichOpeningProposal(
  proposal: TradeProposal,
  policy: TradingPolicy,
  marketScan: MarketScan,
  atrStopPctBySymbol: Record<string, number> = {},
  // Persisted per-position stop plans (position_stop_plans), keyed by symbol — the EXISTING plan on
  // record for a scale-in add to an already-open position. The proposal's OWN `stopPlan` (freshly
  // chosen by the LLM this run, if any) always takes precedence over a stale persisted one — a new
  // opening decision reconsidering the position's protection wins over whatever was on file.
  stopPlanBySymbol: Record<string, StopPlanStyle> = {},
  // The SAME persisted plans' original rationale, keyed alongside stopPlanBySymbol — carried onto an
  // inherited plan stamp below so a "none" plan's required explanation survives a scale-in instead of
  // being erased (Codex review, PR #1371).
  stopPlanRationaleBySymbol: Record<string, string | undefined> = {}
): TradeProposal {
  if (proposal.side !== "buy" && proposal.side !== "short") return proposal;
  const sym = normalizeSymbol(proposal.symbol);
  const marketPrice = marketScan.quotesBySymbol[sym]?.price;
  const refPrice = proposal.referencePrice ?? marketPrice ?? proposal.limitPrice ?? proposal.stopPrice;
  if (refPrice == null || !(refPrice > 0)) return proposal;
  const entryPrice = proposal.limitPrice ?? proposal.stopPrice ?? refPrice;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let next: TradeProposal = { ...proposal, referencePrice: refPrice };
  const plan: StopPlanStyle = proposal.stopPlan?.style ?? stopPlanBySymbol[sym] ?? "default";
  // A scale-in proposal that omits its OWN stopPlan but inherits a persisted one (stopPlanBySymbol)
  // still has that plan applied below (stripping/repricing brackets) — stamp it onto the returned
  // proposal too, or the approval card's disclosure (which reads p.stopPlan directly) never shows
  // the owner an inherited "none"/"trailing"/fixed/atr choice actually governed this order (Codex
  // review, PR #1371). A fresh, explicit stopPlan from THIS proposal is never overwritten.
  if (!next.stopPlan && plan !== "default") {
    const inheritedRationale = stopPlanRationaleBySymbol[sym];
    next = { ...next, stopPlan: { style: plan, ...(inheritedRationale ? { rationale: inheritedRationale } : {}) } };
  }
  // A "trailing"/"none" plan means NO bracket at all, regardless of whole-share eligibility below —
  // strip any LLM-supplied bracket legs UNCONDITIONALLY, right here. Stripping them only INSIDE the
  // whole-share branch left them on a sub-share dollar order (`canUseWholeShareBracket === false`):
  // the Alpaca gateway's `isBracket = !!(bracketTakeProfit || bracketStopLoss)` check would still see
  // it as a bracket dollar order and REJECT it for being below one whole share, even though the plan
  // never wanted a bracket to begin with (Codex review, PR #1371).
  if (plan === "trailing" || plan === "none") {
    if (next.bracketStopLoss != null) next = { ...next, bracketStopLoss: undefined };
    if (next.bracketTakeProfit != null) next = { ...next, bracketTakeProfit: undefined };
  }

  const bracketsEnabled = policy.brokerBracketsEnabled !== false; // default ON
  const brokerSupportsBrackets = policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp";
  const dollarOrderBracketQty = next.dollarAmount != null && next.quantity == null ? Math.floor(next.dollarAmount / entryPrice) : undefined;
  const canUseWholeShareBracket = dollarOrderBracketQty == null || dollarOrderBracketQty >= 1;
  if (bracketsEnabled && brokerSupportsBrackets && canUseWholeShareBracket) {
    const flatStopPct = proposal.side === "short"
      ? (policy.riskRules?.shortStopLossPct ?? policy.riskRules?.stopLossPct ?? 0)
      : (policy.riskRules?.stopLossPct ?? 0);
    // Per-symbol FALLBACK stop distance (used only when the LLM did not propose a valid per-trade
    // stop): an explicit plan PINS to that one rule (fixed/atr — using the fallback % when the
    // account has none configured, same as generateProactiveRiskProposals; "trailing"/"none" skip
    // the stop leg entirely, below); absent a plan, ATR-scaled when available, else beta-scaled,
    // else the flat policy stop — mirroring generateProactiveRiskProposals' effectiveStopPct
    // precedence (ATR > beta > flat) so a name gets the SAME intelligent stop on the opening
    // bracket as on its proactive exit, never a flat 8% here and an ATR stop there.
    const beta = marketScan.quotesBySymbol[sym]?.beta;
    const stopPct = plan === "fixed"
      ? (flatStopPct > 0 ? flatStopPct : STOP_PLAN_FALLBACK_STOP_PCT)
      : plan === "atr"
        ? (typeof atrStopPctBySymbol[sym] === "number" && atrStopPctBySymbol[sym] > 0
          ? atrStopPctBySymbol[sym]
          : (flatStopPct > 0 ? flatStopPct : STOP_PLAN_FALLBACK_STOP_PCT))
        : plan === "trailing" || plan === "none"
          ? 0
          // No explicit plan: ATR only SCALES an already-enabled flat stop (mirrors the held-position
          // precompute's own gate, `atrStops === true && stopLossPct > 0`, a few hundred lines above)
          // — atrStops alone, with no flat % configured, means "no base stop to scale," not "attach
          // an 8% stop the account never asked for" (Codex review, PR #1371).
          : (typeof (policy.atrStops === true && flatStopPct > 0 ? atrStopPctBySymbol[sym] : undefined) === "number" && (atrStopPctBySymbol[sym] ?? 0) > 0
            ? atrStopPctBySymbol[sym]
            : betaScaledStopPct(flatStopPct, beta, policy.betaScaledStops === true));
    const takePct = policy.riskRules?.takeProfitPct ?? 0;
    // Honor a VALID LLM-proposed per-trade stop/take (must sit on the correct side of entry — below
    // for a long, above for a short); a nonsensical one is discarded so the per-symbol fallback fills
    // it in (a stop on the wrong side is worse than the default). A "trailing"/"none" plan's bracket
    // legs were already stripped unconditionally above (this position's protection is a trail, or
    // nothing, run entirely by the synthetic/broker-held trailing lane — never a fixed bracket stop
    // leg, and a resting take-profit-only leg left in place would itself count as a live exit order
    // under the coverage-aware placement checks in broker-protective-stops.ts/synthetic-stops.ts,
    // making those think the position is already fully covered and skip registering the real
    // trailing stop). The laddered take-profit-trim system (planTakeProfitTrims, above) still manages
    // taking profits over time independently of this entry-time bracket leg.
    if (plan === "fixed" || plan === "atr") {
      // An explicit "fixed"/"atr" plan pins an EXACT stop distance (stopPct, computed above) — every
      // other enforcement layer for this symbol (generateProactiveRiskProposals, the synthetic
      // monitor, broker-protective-stops.ts) prices off that SAME distance. Honoring a "valid"
      // LLM-proposed stop here instead would let this one bracket leg silently diverge from the
      // pinned plan (Codex review, PR #1371) — always reprice from the plan, never keep the LLM's.
      next = { ...next, bracketStopLoss: undefined };
    } else {
      const llmStop = next.bracketStopLoss;
      const llmStopValid = typeof llmStop === "number" && Number.isFinite(llmStop) && llmStop > 0 &&
        (proposal.side === "buy" ? llmStop < entryPrice : llmStop > entryPrice);
      if (next.bracketStopLoss != null && !llmStopValid) next = { ...next, bracketStopLoss: undefined };
    }
    if (plan !== "trailing" && plan !== "none") {
      const llmTake = next.bracketTakeProfit;
      const llmTakeValid = typeof llmTake === "number" && Number.isFinite(llmTake) && llmTake > 0 &&
        (proposal.side === "buy" ? llmTake > entryPrice : llmTake < entryPrice);
      if (next.bracketTakeProfit != null && !llmTakeValid) next = { ...next, bracketTakeProfit: undefined };
    }
    // Long: stop below / take above entry. Short: stop above / take below (price up = loss).
    if (proposal.side === "buy") {
      if (stopPct > 0 && next.bracketStopLoss == null) next = { ...next, bracketStopLoss: round2(entryPrice * (1 - stopPct / 100)) };
      if (plan !== "trailing" && plan !== "none" && takePct > 0 && next.bracketTakeProfit == null) next = { ...next, bracketTakeProfit: round2(entryPrice * (1 + takePct / 100)) };
    } else {
      if (stopPct > 0 && next.bracketStopLoss == null) next = { ...next, bracketStopLoss: round2(entryPrice * (1 + stopPct / 100)) };
      if (plan !== "trailing" && plan !== "none" && takePct > 0 && next.bracketTakeProfit == null) next = { ...next, bracketTakeProfit: round2(entryPrice * (1 - takePct / 100)) };
    }
  } else if (bracketsEnabled && brokerSupportsBrackets && !canUseWholeShareBracket) {
    next = {
      ...next,
      rationale: next.rationale + `\n\n[Risk] Native Alpaca bracket skipped because ${formatWholeDollars(next.dollarAmount ?? 0)} is below one whole share at the ${formatWholeDollars(entryPrice)} intended entry price; this avoids a broker rejection for sub-share brackets.`
    };
  } else if (bracketsEnabled && !brokerSupportsBrackets && (policy.riskRules?.stopLossPct ?? 0) > 0) {
    // Transparency for non-bracket brokers (e.g. Robinhood): the broker can't hold an OCO bracket at
    // its matching engine, so this position's protective exit is the synthetic scheduler-tick monitor
    // ONLY — a single point of failure if the app is down. Surface it so the operator knows. (The
    // synthetic monitor still runs every tick; this is honesty, not a behavior change.)
    next = {
      ...next,
      rationale: next.rationale + `\n\n[Risk] ${policy.activeBroker ?? "this broker"} does not support broker-held brackets — the stop is enforced by the app's synthetic monitor only (no protection while the app is offline).`
    };
  }

  // Marketable-limit entries: convert a deterministic OPENING market order into a limit priced
  // through the quote, so a fast tape can't fill it arbitrarily past the quote. Requires a notional
  // (dollar-routed) market order and a whole-share quantity ≥ 1 (sub-share notional can't be cleanly
  // expressed as a quantity-based limit); otherwise we leave it as a market order.
  if (
    policy.marketableLimitEntries === true &&
    next.type === "market" &&
    next.dollarAmount != null &&
    next.dollarAmount > 0 &&
    (policy.permittedOrderTypes?.includes("limit") ?? true)
  ) {
    const quote = marketScan.quotesBySymbol[sym];
    const qty = Math.floor(next.dollarAmount / entryPrice);
    if (qty >= 1) {
      const bufferBps = policy.tuning?.marketableLimitBufferBps ?? 15;
      const buffer = bufferBps / 10_000;
      // A synthesized (price-derived) Yahoo spread is not a real quote — never anchor the
      // marketable-limit through it. Judge each side INDEPENDENTLY: a synthetic ask must not discard a
      // real bid (or vice-versa), e.g. a quote-only ask alongside a later provider's real bid. Fall
      // back to refPrice only for the side that is actually synthetic so the limit is honest.
      const realAsk = !quote?.syntheticAsk && quote?.ask && quote.ask > 0 ? quote.ask : undefined;
      const realBid = !quote?.syntheticBid && quote?.bid && quote.bid > 0 ? quote.bid : undefined;
      const limitPrice = proposal.side === "buy"
        ? round2((realAsk ?? refPrice) * (1 + buffer))
        : round2((realBid ?? refPrice) * (1 - buffer));
      if (limitPrice > 0) {
        next = {
          ...next,
          type: "limit",
          limitPrice,
          quantity: qty,
          dollarAmount: undefined,
          rationale: next.rationale + `\n\n[Execution] Marketable-limit entry: ${qty} sh @ limit $${limitPrice} (${bufferBps} bps through the ${proposal.side === "buy" ? "ask" : "bid"}) instead of a raw market order, to cap fast-tape slippage.`
        };
      }
    }
  }
  return next;
}

export function generateProactiveRiskProposals(
  positions: EquityPosition[],
  currentPrices: Record<string, number>,
  policy: TradingPolicy,
  betaBySymbol: Record<string, number> = {},
  // Precomputed ATR-based stop DISTANCE (% of entry) per symbol — supplied by the caller (which has
  // bars) when policy.atrStops is on. Mirrors the betaBySymbol precompute pattern so this stays a pure
  // sync function. Empty/absent → fall back to the fixed/beta stop (a name is never left unprotected).
  atrStopPctBySymbol: Record<string, number> = {},
  // Marketable-limit buffer (bps) for an extended-hours protective exit, or undefined for the default
  // market/queue-to-open routing. Resolved by the async caller (it knows the session) so this stays
  // pure; see extendedHoursExitBufferBps. When set, the stop exit becomes a limit tagged extended_hours.
  extHoursBufferBps?: number,
  // Real bid/ask anchors per symbol for the extended-hours marketable-limit (see the caller's
  // protectiveExitQuoteFromScan filter). Missing entries fall back to currentPrice as the anchor.
  exitQuotesBySymbol: Record<string, ProtectiveExitQuote> = {},
  // The LLM's per-position stop-loss TYPE choice, persisted at fill time (position_stop_plans) and
  // keyed by symbol. A "fixed"/"atr" plan PINS this position to that one distance rule regardless of
  // the account's own atrStops/betaScaledStops toggles; "trailing" hands this position's protection
  // to the trailing-stop lane instead (skipped here — see runSyntheticStopMonitor); "none" is a
  // genuine, owner-accepted no-stop choice. Absent/"default" → the account's own precedence,
  // unchanged from before this parameter existed.
  stopPlanBySymbol: Record<string, StopPlanStyle> = {}
): TradeProposal[] {
  const proactiveProposals: TradeProposal[] = [];
  const stopLossPct = policy.riskRules.stopLossPct ?? 0;
  const shortStopLossPct = policy.riskRules.shortStopLossPct ?? 0;
  const betaStops = policy.betaScaledStops === true;
  const atrStops = policy.atrStops === true;

  // Take-profit trims are handled by planTakeProfitTrims (a stateful, laddered band ratchet); this
  // generator emits only stateless FULL-position stop-loss / short-stop exits. An account with BOTH
  // base %'s off still needs to run the loop when any position carries an explicit fixed/atr plan —
  // only skip entirely when nothing anywhere could possibly want a stop.
  const anyExplicitDistancePlan = Object.values(stopPlanBySymbol).some((s) => s === "fixed" || s === "atr");
  if (stopLossPct <= 0 && shortStopLossPct <= 0 && !anyExplicitDistancePlan) return proactiveProposals;

  // Resolve the effective stop DISTANCE for a base stop %: an explicit per-position plan wins
  // outright (fixed/atr pin to that one rule, using the fallback % when the account has none
  // configured; trailing/none return 0 — this function's fixed/ATR exit does not apply to them).
  // Absent a plan (or "default"), the existing precedence applies: ATR-based when enabled and
  // available (it sets the distance of the configured stop), else beta-scaled, else flat. ATR takes
  // precedence over beta-scaling when both are on — it's the more direct, per-name volatility measure.
  const effectiveStopPct = (sym: string, baseStopPct: number, beta: number | undefined): number => {
    const plan = stopPlanBySymbol[sym];
    if (plan === "none" || plan === "trailing") return 0;
    if (plan === "fixed") return baseStopPct > 0 ? baseStopPct : STOP_PLAN_FALLBACK_STOP_PCT;
    if (plan === "atr") {
      const atrPct = atrStopPctBySymbol[sym];
      if (typeof atrPct === "number" && Number.isFinite(atrPct) && atrPct > 0) return atrPct;
      return baseStopPct > 0 ? baseStopPct : STOP_PLAN_FALLBACK_STOP_PCT;
    }
    if (baseStopPct <= 0) return baseStopPct;
    if (atrStops) {
      const atrPct = atrStopPctBySymbol[sym];
      if (typeof atrPct === "number" && Number.isFinite(atrPct) && atrPct > 0) return atrPct;
    }
    return betaScaledStopPct(baseStopPct, beta, betaStops);
  };

  for (const pos of positions) {
    if (Math.abs(pos.quantity) <= 0.000001 || pos.averageCost <= 0) continue;
    const sym = normalizeSymbol(pos.symbol);
    const currentPrice = currentPrices[sym] ?? (pos.marketValue / pos.quantity);
    if (!currentPrice || currentPrice <= 0) continue;
    // Volatility-aware stop distance: ATR-based (realized range) or beta-scaled (widen high-beta,
    // tighten low-beta), else a flat %. Take-profit stays flat (a target, not a stop).
    const beta = betaBySymbol[sym];
    const effStopLossPct = effectiveStopPct(sym, stopLossPct, beta);

    let reason = "";
    let exitSide: "sell" | "cover" = "sell";

    if (pos.quantity > 0) {
      // Long: profit when price rises; exit a breach with a SELL.
      const returnPct = ((currentPrice - pos.averageCost) / pos.averageCost) * 100;
      if (effStopLossPct > 0 && returnPct <= -effStopLossPct) {
        reason = `Proactive stop-loss exit: ${pos.symbol} returned ${returnPct.toFixed(2)}% breaching -${effStopLossPct.toFixed(2)}% limit.`;
      }
      exitSide = "sell";
    } else {
      // Short: profit when price FALLS; exit a breach with a COVER. Only managed when
      // short selling is enabled (the only path that can open a short in the first place).
      if (!policy.shortSellingEnabled) continue;
      const returnPct = ((pos.averageCost - currentPrice) / pos.averageCost) * 100;
      const baseShortStop = shortStopLossPct > 0 ? shortStopLossPct : stopLossPct;
      const effShortStop = effectiveStopPct(sym, baseShortStop, beta);
      if (effShortStop > 0 && returnPct <= -effShortStop) {
        reason = `Proactive short stop-loss cover: ${pos.symbol} returned ${returnPct.toFixed(2)}% breaching -${effShortStop.toFixed(2)}% limit.`;
      }
      exitSide = "cover";
    }

    if (reason) {
      // Extended-hours routing (only when the caller resolved a live pre/post session with the toggle
      // on): a marketable-limit anchored to the real bid (SELL) / ask (COVER) — currentPrice as the
      // fallback anchor — that can actually fill after hours, else the default market order that
      // queues to the regular open. A FRACTIONAL quantity never takes the limit path: fractional
      // orders are regular-hours-only at the broker (a policy hard gate), so routing one to
      // extended_hours would block the protective exit instead of queuing it.
      const exitQuantity = Math.abs(pos.quantity);
      const exitLimitPrice = extHoursBufferBps != null && Number.isInteger(exitQuantity)
        ? marketableLimitExitPrice({ ...exitQuotesBySymbol[sym], price: currentPrice }, exitSide, extHoursBufferBps)
        : undefined;
      const useExtLimit = exitLimitPrice != null;
      proactiveProposals.push({
        symbol: normalizeSymbol(pos.symbol),
        side: exitSide,
        type: useExtLimit ? "limit" : "market",
        quantity: exitQuantity,
        limitPrice: useExtLimit ? exitLimitPrice : undefined,
        timeInForce: "gfd",
        marketHours: useExtLimit ? "extended_hours" : "regular_hours",
        rationale: reason,
        tradeThesisTag: "Risk-Exit",
        entryMarketRegime: "Active Risk Check"
      });
    }
  }
  return proactiveProposals;
}

/** Clamp a take-profit trim percent to (0,100]; undefined/invalid → 100 (full exit, back-compat). */
export function clampTakeProfitTrimPct(pct: number | undefined): number {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) return 100;
  return Math.min(100, pct);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Quantity to sell for a take-profit trim. Exits fully at >=100%. For a WHOLE-share position the trim is
 * floored to whole shares (so it never forces a fractional order a non-fractional broker would reject); a
 * sub-1-share slice or a <1-share remainder becomes a full exit. An already-fractional position keeps a
 * fractional trim (the broker already supports fractional for it), avoiding a dust remainder.
 */
export function takeProfitTrimQuantity(qty: number, trimPct: number): number {
  const q = Math.abs(qty);
  if (q <= 0) return 0;
  if (trimPct >= 100) return round6(q);
  const raw = q * (trimPct / 100);
  if (Number.isInteger(q)) {
    const whole = Math.floor(raw);
    if (whole < 1 || q - whole < 1) return round6(q); // no clean whole-share slice → full exit at target
    return whole;
  }
  if (q - raw < 0.0001) return round6(q); // negligible remainder → full exit, no dust
  return round6(raw);
}

export interface TakeProfitTrimPlan {
  proposals: TradeProposal[];
  /**
   * Symbols + bands the trims emitted this run target (each proposal also carries `takeProfitBand`/
   * `takeProfitBasis`). The band is persisted on FILL by recordFillFromProposal, NOT here — so a
   * proposed/blocked/rejected trim is re-offered next run rather than silently ratcheted past.
   */
  advancedBands: Array<{ symbol: string; band: number }>;
}

/**
 * Plan partial take-profit trims with a monotonic, lot-keyed band ratchet. For each position at/above its
 * take-profit target, the take-profit BAND = floor(returnPct / takeProfitPct); a trim of
 * `takeProfitTrimPct`% of the CURRENT position is emitted ONLY when that band exceeds the highest band
 * already TRIMMED for this lot (`lastBandBySymbol[sym]`, matched by cost basis). So a partial take-profit
 * trims once per band (e.g. at +20%, +40%, …) instead of laddering out the position every run, and a
 * close+rebuy (different cost basis) starts fresh. Pure/sync. The caller reads prior bands from
 * `take_profit_trims`; the band is committed only when the trim actually FILLS (recordFillFromProposal).
 */
export function planTakeProfitTrims(
  positions: EquityPosition[],
  currentPrices: Record<string, number>,
  policy: TradingPolicy,
  lastBandBySymbol: Record<string, TakeProfitTrimBand> = {}
): TakeProfitTrimPlan {
  const proposals: TradeProposal[] = [];
  const advancedBands: Array<{ symbol: string; band: number }> = [];
  const takeProfitPct = policy.riskRules.takeProfitPct ?? 0;
  if (takeProfitPct <= 0) return { proposals, advancedBands };
  const trimPct = clampTakeProfitTrimPct(policy.riskRules.takeProfitTrimPct);

  for (const pos of positions) {
    const qty = Math.abs(pos.quantity);
    if (qty <= 0.000001 || pos.averageCost <= 0) continue;
    const sym = normalizeSymbol(pos.symbol);
    const currentPrice = currentPrices[sym] ?? (pos.quantity !== 0 ? pos.marketValue / pos.quantity : 0);
    if (!currentPrice || currentPrice <= 0) continue;

    const isShort = pos.quantity < 0;
    if (isShort && !policy.shortSellingEnabled) continue; // only manage shorts the app could have opened
    const returnPct = isShort
      ? ((pos.averageCost - currentPrice) / pos.averageCost) * 100
      : ((currentPrice - pos.averageCost) / pos.averageCost) * 100;
    if (returnPct < takeProfitPct) continue;

    const band = Math.floor(returnPct / takeProfitPct);
    // Ratchet keyed to THIS lot: a stored band only counts if its cost basis still matches the live
    // position (otherwise it's a new lot from a close+rebuy → start fresh at band 0).
    const prior = lastBandBySymbol[sym];
    const lastBand = prior && Math.abs(prior.avgCost - pos.averageCost) < 0.005 ? prior.band : 0;
    if (band <= lastBand) continue; // already trimmed at/above this band for this lot (monotonic)

    const trimQty = takeProfitTrimQuantity(qty, trimPct);
    if (trimQty <= 0) continue;
    const side: "sell" | "cover" = isShort ? "cover" : "sell";
    const label = trimPct >= 100 ? "full exit" : `${trimPct}% trim`;
    proposals.push({
      symbol: sym,
      side,
      type: "market",
      quantity: trimQty,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: `Proactive take-profit ${label}: ${pos.symbol} +${returnPct.toFixed(2)}% (band ${band} @ ${takeProfitPct}% step) — ${side === "cover" ? "covering" : "selling"} ${trimQty}, letting the rest ride.`,
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "Active Risk Check",
      takeProfitBand: band,
      takeProfitBasis: pos.averageCost
    });
    advancedBands.push({ symbol: sym, band });
  }
  return { proposals, advancedBands };
}
