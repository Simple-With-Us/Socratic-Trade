import {
  acquireStrategyLock,
  audit,
  claimProposalForExecution,
  countDayTradesInLastBusinessDays,
  dailyExecutionStats,
  finishStrategyRun,
  getActiveConnectedAccount,
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
  notionalInLastMinutes,
  releaseStrategyLock,
  setPolicy,
  transitionProposalIfPending,
  upsertSocraticDecisionCase,
  createSocraticFrameworkProposal,
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
import { interactiveStrategyReasoningEffort, isRetryableLlmError, isRetryableLlmStatus, LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS, LLM_TIMEOUT_MS, llmFetch, llmFetchCapturing, strategyLlmTimeoutMs, type LlmCallOutcome } from "./llm-request";
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
import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { atr, atrStopPct } from "./indicators";
import { computePortfolioHeat, positionRiskUsd, realizedVolPct, volTargetScale, type PortfolioHeatResult } from "./vol-targeting";
import { fetchDailyOHLC } from "./history";
import { expireStalePendingProposals, revalidatePendingProposals } from "./proposal-revalidation";
import { getTaxSummary, getUserWashSaleLockProvenance } from "./tax";
import { getBrokerGateway } from "./broker";
import { describeBrokerMinimumOrderBlock, shouldAlertBrokerMinimumOrderBlock } from "./broker-minimum-guard";
import { brokerHeldExitBlockReason, evaluateBrokerHeldExitAvailability } from "./broker-held-orders";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { checkBudgetAndAlert, evaluateBudgetForRun, formatBudgetAdvisory, getBudgetStatusCached, notifyBudgetSkip, previewBudgetDecision, usageBudgetEnforceEnabled } from "./usage-budget";
import { avgReturnCorrelation, correlationProfile } from "./correlation";
import { stressScenario, type StressPositionInput } from "./stress-scenario";
import { assertLivePreflight } from "./preflight-live-guard";
import { checkLlmDailyBudget, checkMonthlyLlmSpendCeiling, releaseLlmReservation, reserveLlmRunBudget } from "./llm-budget";
// (STRATEGY_PROMPT_VERSION comes with the prompt builders from ./strategy-prompts above —
// ./strategy-prompt-version is a thin re-export kept for red-team.ts's cycle-free import.)
import type { BrokerGateway } from "./types";
import { generateReflectionSummary } from "./post-mortem";
import { emitDashboardEvent } from "./events";
import { getInternalSetting, getUserSetting, setInternalSetting } from "./db";
import { clearTakeProfitTrimBands, getTakeProfitTrimBands } from "./db";
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
import type { ApprovedEscalation, EquityOrder, EquityPosition, ExecutionMode, FillSource, MarketFactorBreakdown, MarketQuote, MarketScan, OrderSide, PolicyDecision, Portfolio, RationaleDiversity, ReviewedOrder, ScoringWeights, SocraticDecisionCase, SocraticEvidenceItem, SocraticRagAttribution, TradingPolicy, TradeProposal } from "./types";
import { computeRationaleDiversity } from "./rationale-diversity";
import { isMarketOpen } from "./market-calendar";
import { isTradingDay } from "./market-calendar";

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

export interface LiveApprovalConfirmation {
  proposalId?: string;
  accountNumber?: string | null;
  executionMode?: ExecutionMode | string;
  estimatedNotional?: number | null;
  typedText?: string | null;
}

export class LiveApprovalConfirmationError extends Error {
  code = "LIVE_CONFIRMATION_REQUIRED";
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" "));
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
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
  }, userId);
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
  // Target account: an explicit override (scheduler running a non-active account) or the active
  // account. Everything below derives from this account's policy, so a single override here runs
  // the whole loop against the targeted account.
  const targetAccountId = options.connectedAccountId;
  // Per-account run lock: prevent overlapping runs from double-counting daily limits,
  // scoped to the target account so a different account isn't blocked.
  const connectedAccountId = targetAccountId ?? getPolicy(userId).connectedAccountId;
  if (!acquireStrategyLock(userId, connectedAccountId)) {
    return { runId: "", status: "failed", summary: "A strategy run is already in progress.", proposals: [] };
  }

  const runId = crypto.randomUUID();
  insertStrategyRun(runId, userId, connectedAccountId);
  let result: StrategyResult;
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
    const savedPolicy = getPolicy(userId, targetAccountId);
    const accountNumber = savedPolicy.accountNumber;
    if (!accountNumber) throw new Error("No account selected.");
    if (savedPolicy.systemState === "halted" && !manualRun) throw new Error("System is halted.");
    const policy: RunnablePolicy = manualRun
      ? { ...savedPolicy, accountNumber, systemState: "active" as const, strategyAuthority: "propose" as const }
      : { ...savedPolicy, accountNumber };
    const activeAccount = targetAccountId ? getConnectedAccount(targetAccountId, userId) : getActiveConnectedAccount(userId);
    const executionState = deriveExecutionState(policy, activeAccount);
    // An account is an account: with none connected there is no broker to trade through, and there
    // is no local-simulation fallback. Refuse to run rather than synthesize a fake fill.
    if (!executionState.mode) throw new Error("No connected account. Connect a broker account before running the strategy.");
    const executionMode: ExecutionMode = executionState.mode;

    // Market holiday / closure guard: skip the strategy run when the market is fully closed
    // (holiday or weekend). Manual runs bypass this check so the operator can always force a run.
    if (!manualRun && !isTradingDay()) {
      const reason = "Market is closed (holiday or weekend). Skipping strategy run.";
      console.log(`[Strategy] ${reason}`);
      audit("run_skipped_market_closed", { runId, userId, reason }, userId);
      result = { runId, status: "completed", summary: reason, proposals: [] };
      finishStrategyRun(runId, "completed", reason, userId);
      releaseStrategyLock(userId, connectedAccountId);
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
    } catch {
      /* advisory is best-effort — never break the run */
    }

    const gateway = getBrokerGateway(policy, userId);
    await reconcilePendingFills(gateway, policy.accountNumber, userId);
    // Broker-truth reconcile any order-placement intent left "placing" by a prior run that crashed
    // mid-call: match it against the broker by clientOrderId and recover or abandon it.
    await flagStalePlacingIntents(gateway, policy.accountNumber, userId);
    const [accounts, portfolio, positions, orders] = await Promise.all([
      gateway.getAccounts(),
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
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
      audit("congress_gate_applied", { runId, userId, pass: congressVerdict.pass, reasons: congressVerdict.reasons, stats: congressVerdict.stats }, userId);
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
    await notifyStaleLimitOrders({ userId, policy, orders });

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
          audit("policy_violation_drawdown", { runId, reason: breaker.reason, equity, highWaterMark: breaker.highWaterMark, startOfDayEquity: breaker.startOfDayEquity, from: "active", action: "advisory" }, userId);
        } else {
          // Owner opted into hard enforcement: flip systemState. Persist to the SAME account the run
          // targeted (read via getPolicy(userId, targetAccountId)); omitting it would resolve the ACTIVE
          // account, so a scheduler run of a non-active account could halt the wrong account.
          const revertedTo = breakerAction === "close_only" ? "close_only" : "halted";
          policy.systemState = revertedTo;
          setPolicy(policy, userId, targetAccountId);
          audit("policy_violation_drawdown", { runId, reason: breaker.reason, equity, highWaterMark: breaker.highWaterMark, startOfDayEquity: breaker.startOfDayEquity, from: "active", revertedTo, action: breakerAction }, userId);
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
      const volBrake = evaluateVolatilityBrake(brakeMacro, brakeSignals, policy);
      if (volBrake.brake) {
        policy.systemState = "close_only";
        // Persist to the run's TARGET account (same reason as the drawdown breaker above).
        setPolicy(policy, userId, targetAccountId);
        audit(
          "policy_violation_vol_panic",
          { runId, reason: volBrake.reason, from: "active", revertedTo: "close_only", vixAsOf: brakeMacro?.vixAsOf },
          userId
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
    if (enforceDecision.skip) {
      const reason = enforceDecision.reason ?? "Over budget.";
      audit("usage_budget_enforced", { runId, userId, action: "skip", reason }, userId, connectedAccountId);
      await notifyBudgetSkip(userId, policy, runId, reason);
      const summary = `Strategy run skipped — over usage budget. ${reason}`;
      result = { runId, status: "completed", summary, proposals: [] };
      finishStrategyRun(runId, "completed", summary, userId);
      releaseStrategyLock(userId, connectedAccountId);
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
          userId
        );
      }
    }
    if (skipLlmDueToBudget && budget.ok === false) {
      audit(
        "strategy_run_suppressed_budget",
        { runId, userId, reason: budget.reason, tokensToday: budget.tokensToday, costUsdToday: budget.costUsdToday, tokenLimit: budget.tokenLimit, costLimitUsd: budget.costLimitUsd },
        userId
      );
    }

    // Supplemental tasks before generating new ideas — keep the approval queue honest so a
    // human never mistakes an hours/days-old pending proposal for a fresh recommendation:
    //   (1) deterministic hard-expiry of anything past policy.proposalExpiryMinutes (non-LLM — always
    //       runs, it's safety hygiene), then
    //   (2) an LLM re-check ("does this still stand?") of pending proposals due on their cadence —
    //       SKIPPED when over the LLM budget, since it calls the model (records usage).
    const expiry = await expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber })
      .catch((e) => {
        console.error("[expiry] run error:", e);
        return { expired: 0 };
      });
    const revalidation = skipLlmDueToBudget
      ? null
      // runPolicy (not policy): this LLM re-check must see the run-scoped usage-budget downgrade too.
      : await revalidatePendingProposals({ userId, policy: runPolicy, accountNumber: policy.accountNumber, marketScan })
          .catch((e) => {
            console.error("[revalidation] run error:", e);
            return null;
          });

    const betaBySymbol: Record<string, number> = {};
    for (const [sym, q] of Object.entries(marketScan.quotesBySymbol)) {
      if (typeof q.beta === "number" && Number.isFinite(q.beta)) betaBySymbol[normalizeSymbol(sym)] = q.beta;
    }
    // ATR-based stops (opt-in, default off): precompute a per-symbol stop DISTANCE (% of entry) from each
    // open position's recent daily range so the sync proactive generator can use it (mirrors betaBySymbol).
    // Best-effort + bounded: a fetch error or insufficient bars simply leaves that name on the fixed/beta stop.
    const atrStopPctBySymbol: Record<string, number> = {};
    if (policy.atrStops === true && (policy.riskRules.stopLossPct ?? 0) > 0) {
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
    }
    const proactiveProposals = generateProactiveRiskProposals(workingPositions, currentPrices, policy, betaBySymbol, atrStopPctBySymbol);
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
        promptSafetyEvidence.push({
          kind: "safety",
          tone: "warning",
          title: "Requested filings doc type never ingested",
          summary:
            `${emptyDocTypes.length} requested doc type(s) produced no chunks this run: ` +
            `${emptyDocTypes.join(", ")}. Advisory receipt only — nothing was altered or blocked.`,
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
        audit("run_skipped_score_threshold", { runId, userId, threshold: minScore, candidateCount: before, reason }, userId);
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
          userId
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
        prompt: getStrategyPrompt(userId),
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
          audit("proposal_skipped_negative_ev", { symbol: p.symbol, side: p.side, thesisTag: p.tradeThesisTag, reason: gate.reason }, userId);
        }
        return !gate.skip;
      })
      .map((p) => {
        const sized = applyDeterministicSizing(p, policy, workingPortfolio, learningSource, userId, workingPositions, marketScan, calibrationForSizing, realizedVolPctBySymbol, bookHeat, prefetchedFills);
        const overrideSized = applySocraticOverrideSizing(sized, policy, workingPortfolio);
        return enrichOpeningProposal(overrideSized, policy, marketScan, atrStopPctBySymbol);
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
            userId
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
      userId
    );

    // Advisory correlation/stress/earnings-proximity receipts on the final opening proposal set —
    // receipts only, never a gate. See applyRiskReceipts's doc comment for the flag semantics.
    const proposals = await applyRiskReceipts(gatedProposals, policy, workingPositions, workingPortfolio, marketScan, userId);

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
    }
    // (The rationale-collapse GATE that routes collapsed openings to human review runs EARLIER — before
    // sell-to-fund planning — so a gated buy can't drive automated funding sells. Only the advisory
    // full-set warning above remains here.)

    const results: StrategyResult["proposals"] = [];
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
      const normalizedProposal = { ...proposal, symbol: normalizeSymbol(proposal.symbol) };
      const tradability = await gateway.getEquityTradability(policy.accountNumber, [normalizedProposal.symbol]);
      if (!tradability[normalizedProposal.symbol]?.tradable) {
        const decision = { approved: false, reasons: [tradability[normalizedProposal.symbol]?.reason ?? "Symbol is not tradable."] };
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked" });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        autoRevertOnCapBreach(decision.reasons, policy, userId, targetAccountId);
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        continue;
      }

      const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal });

      // Broker-minimum pre-flight guard: skip an order the broker has already told us (or that basic
      // sizing math tells us) is a GUARANTEED reject for landing below its minimum dollar/fractional
      // order size (e.g. Robinhood's $1 floor) — rather than placing it, getting rejected, and
      // alerting on it every single run forever. The outward alert is cooldown-gated (this condition
      // is NAV-bound and persistent, not transient) but the audit/proposal receipt is not, so the
      // run history and Activity feed stay accurate every time.
      // positionQuantity lets the guard exempt a whole-position dust exit (Robinhood allows
      // selling an entire fractional position even below its $1 minimum).
      const heldForMinimumGuard = workingPositions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(normalizedProposal.symbol));
      const brokerMinimumBlockReason = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...normalizedProposal, positionQuantity: heldForMinimumGuard?.quantity });
      if (brokerMinimumBlockReason) {
        const decision: PolicyDecision = { approved: false, reasons: [brokerMinimumBlockReason] };
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked", review });
        audit(
          "order_skipped_broker_minimum",
          { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, reason: brokerMinimumBlockReason },
          userId,
          connectedAccountId
        );
        if (shouldAlertBrokerMinimumOrderBlock(policy.accountNumber, normalizedProposal.symbol)) {
          await sendNotification(
            {
              type: "block",
              title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} skipped (below broker minimum)`,
              payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
            },
            { policy, userId }
          );
        }
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: [brokerMinimumBlockReason] });
        continue;
      }

      const dailyNow = dailyExecutionStats(policy.accountNumber, new Date(), userId);
      const hourlyNow = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
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
          // R1 §1.4.3 still applies: an autonomous run that TRIPPED a notional/order cap demotes
          // the account back to Ask-first even though the tripping proposal survives as a card.
          autoRevertOnCapBreach(decision.reasons, policy, userId, targetAccountId);
          results.push({ proposal: normalizedProposal, status: "proposed", reasons: decision.reasons });
          continue;
        }

        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "blocked", review, overrideResolution });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        autoRevertOnCapBreach(decision.reasons, policy, userId, targetAccountId);
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
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
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
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision: heldDecision, review, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: heldDecision.reasons });
        continue;
      }

      // Sell-to-fund "propose" mode: funding sells queue for human approval even under "decide"
      // authority — raising cash by selling is the user's call. (Identified by tradeThesisTag so it's
      // robust to any reordering by the cluster gate.)
      if (sellToFundMode === "propose" && normalizedProposal.tradeThesisTag === "Sell-to-Fund") {
        const proposalId = crypto.randomUUID();
        insertProposal({ userId, executionMode, promptVersion: STRATEGY_PROMPT_VERSION, id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "proposed", review, overrideResolution });
        await sendNotification(
          { type: "pending_approval", title: `${normalizedProposal.symbol} funding sell awaiting approval`, payload: { runId, proposalId, proposal: normalizedProposal, review } },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: ["Sell-to-fund-buy: queued for approval."] });
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
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [] });
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
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [`Red Team review unavailable${failureKindSuffix}; routed to human approval.`] });
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
        audit("order_blocked_live_preflight", { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, reason: message }, userId);
        await sendNotification(
          { type: "block", title: `${normalizedProposal.symbol} live order blocked (pre-flight)`, payload: { runId, proposalId, decision: blockedDecision, review, proposal: normalizedProposal, reason: message } },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: [message] });
        continue;
      }

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
        // The broker may or may not have accepted the order. Keep the durable intent row and
        // flag it loudly for reconciliation rather than aborting the whole run.
        updateProposalStatus(proposalId, "placing_failed", undefined, review, review.estimatedNotional, userId, undefined, message);
        recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placing_failed", review, overrideResolution });
        audit("order_placement_uncertain", { runId, proposalId, refId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, error: message }, userId);
        await sendNotification(
          { type: "run_failed", title: `${normalizedProposal.symbol} order placement uncertain — verify with broker`, payload: { runId, proposalId, refId, error: message } },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "error", reasons: [`Order placement failed/uncertain: ${message}`] });
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
        audit("order_rejected_by_broker", { runId, proposalId, refId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, orderId: execution.orderId, brokerState: execution.state }, userId);
        await sendNotification(
          { type: "run_failed", title: `${normalizedProposal.symbol} order declined by broker (${execution.state})`, payload: { runId, proposalId, refId, orderId: execution.orderId, state: execution.state } },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "error", reasons: [message] });
        continue;
      }

      updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional, userId);
      recordSocraticDecision({ proposalId, proposal: normalizedProposal, decision, status: "placed", review, overrideResolution });
      // Wash-sale proceed trail at the actual live placement — see auditWashSaleProceed.
      auditWashSaleProceed(decision, { runId, proposalId, symbol: normalizedProposal.symbol, side: normalizedProposal.side, estimatedNotional: review.estimatedNotional, userId, connectedAccountId });
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
        status: execution.state === "filled" ? "filled" : "pending_reconciliation"
      });
      await sendNotification(
        { type: "fill", title: `${normalizedProposal.symbol} live order ${execution.state}`, payload: { runId, proposalId, fill } },
        { policy, userId }
      );
      // Push so open dashboards refresh on an autonomously-placed order (the approval path
      // already emits this; the run-loop placement previously did not).
      emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { runId, proposalId, symbol: normalizedProposal.symbol, orderId: execution.orderId } });
      results.push({ proposal: normalizedProposal, status: "placed", reasons: [], orderId: execution.orderId });
    }

    // Phase 10 B2 — full EvidenceDigest for the WHOLE scored set (chosen AND skipped):
    // factor sub-scores, source freshness, bulletins, sector, regime, and a decision-time
    // reference price. Persisting the skipped names (not just what we bought) is what lets
    // later learning run counterfactuals ("names you passed that then ran") and attribute
    // outcomes to factors. The run regime is deterministic and shared across candidates.
    const runRegime = determineMarketRegime(await fetchMacroData(userId));
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
    const summary = error instanceof Error ? error.message : "Strategy failed.";
    if (error instanceof StrategyLlmStepFailure) {
      llmSteps = error.llmSteps;
    }
    finishStrategyRun(runId, "failed", summary, userId);
    const policy = getPolicy(userId, targetAccountId);
    result = { runId, status: "failed", summary, proposals: [], accountNumber: policy.accountNumber, ...(llmSteps.length > 0 ? { llmSteps } : {}) };
    if (summary === "Kill switch is active.") {
      await sendNotification({ type: "kill_switch", title: "Kill switch blocked strategy run", payload: { runId, summary } }, { policy, userId });
    } else {
      await sendNotification({ type: "run_failed", title: "Strategy run failed", payload: { runId, summary } }, { policy, userId });
    }
  } finally {
    // Release the strategy lock promptly so this account can run again. The LLM reservation is held a bit
    // longer — until the fire-and-forget post-mortem reflection settles — so that background spend stays
    // inside the reserved headroom instead of racing a queued same-user run (the TTL is the crash backstop).
    // We do NOT await here, so runStrategyOnce's return isn't delayed by the reflection.
    releaseStrategyLock(userId, connectedAccountId);
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

/**
 * Escalation framework — decide whether a policy-refused proposal may become a PENDING-APPROVAL
 * card (with its block reasons on it) instead of dying as a blocked entry.
 *
 * Rules (owner-locked spec):
 * - "wash_sale_ask" failures escalate under BOTH authorities (propose and decide) — that is the
 *   entire point of taxSettings.washSaleHandling = "ask".
 * - Time-context failures (daily/hourly notional caps, daily opening-order cap, quote staleness)
 *   escalate ONLY under "decide" authority: in propose mode every idea already waits for a human,
 *   so a time-gated one stays a visible blocked entry rather than a card implying it can be
 *   approved right now.
 * - EVERY reason must be covered by an escalatable entry. Anything else — red-team veto,
 *   negative-EV skip, and below-threshold conviction happen upstream and never reach this path;
 *   per-order notional caps, shorting disabled, blocklisted/universe symbols, the IRA wash-sale
 *   hard block, margin minimum, etc. produce NO escalation entry — keeps the proposal blocked.
 */
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

/**
 * Approval-path override extraction: the ask-mode wash-sale override handles stored on an
 * escalated proposal row. Reads ONLY the server-written decision JSON (tokens were minted by the
 * run loop at escalation time) — no client input flows in, so this can never be a client-settable
 * bypass. Only "wash_sale_ask" entries yield a handle: time-context escalations carry tokens for
 * audit but are deliberately NOT overridable — their gates simply re-run against current state.
 */
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

// `shouldRunRedTeamDebate`, `redTeamDebateTrigger`, and the conviction/%-of-NAV threshold helpers
// were REMOVED 2026-07-07 (single-adversary consolidation, decision O2): the Red Team review now
// runs on EVERY risk-adding opening — universal, structural coverage instead of conviction- or
// stakes-gated triggering. The only remaining routing question is §3.5's net-risk-direction gate:

/**
 * §3.5 / R5 — net-risk-direction gate for the single Red Team review. TRUE only for a trade that
 * INCREASES |net exposure| in its symbol: a `buy` that opens or adds to a long (net position ≥ 0),
 * or a `short` that opens or adds to a short (net position ≤ 0). FALSE — structurally EXEMPT from
 * review, so the adversary can never block or shrink a risk-reducing trade — for:
 *   - every exit (`sell`/`cover`), and
 *   - the position-flip edge cases raw-side gating gets wrong: a `buy` against an existing net
 *     short (it covers), and a `short` against an existing net long (it trims).
 * Classification is by the SIGN of the existing net position (the same book `applyDeterministicSizing`
 * reads); an oversized opposite-side order that would flip through zero still counts as risk-adding
 * only in the rare sign-boundary case, which errs toward MORE review, never less.
 */
export function isRiskAddingOpening(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "buy" && proposal.side !== "short") return false;
  const sym = normalizeSymbol(proposal.symbol);
  const netQty = positions
    .filter((p) => normalizeSymbol(p.symbol) === sym)
    .reduce((sum, p) => sum + p.quantity, 0);
  return proposal.side === "buy" ? netQty >= 0 : netQty <= 0;
}

/**
 * §3.3 / R1 / R2 — apply the Red Team's `approve-at-half` haircut to a FINALIZED opening, mutating
 * the proposal IN PLACE (reference identity must survive: `requiresHumanReview` and the placement
 * loop key off the object reference). Down-only and placeability-aware:
 *   - quantity-routed (marketable-limit conversion cleared `dollarAmount` and set a whole-share
 *     `quantity`): halve the share count, floored; below 1 share → NOT placeable.
 *   - dollar-routed: halve the notional, floored to a whole dollar. If the order carries a native
 *     broker bracket (bracketStopLoss/bracketTakeProfit priced for the FULL size) and the halved
 *     notional drops below one whole share at the reference price, the bracket the sizer attached
 *     would be invalid at the broker → NOT placeable (never silently strip protective legs).
 * Returns `applied: false` when 0.5× is not placeable — the caller must then HOLD the proposal for
 * human review at full size (R1: never proceed at a size larger than the reviewer approved, never
 * up-size a haircut).
 */
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

/** Small bounded-concurrency worker pool (R4) — `Promise.all` would burst every Red Team request
 *  at once and re-trigger the scheduler-lock / rate-limit starvation the cap exists to avoid. */
async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
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

/**
 * Synchronous, model-free pre-filter applied to Bull proposals before the Bear LLM runs.
 * This is the genuinely independent critique layer: no API call, no model, no chance of
 * the same LLM arguing with itself. Three concrete rules:
 *
 *   1. No-position-to-exit: sell/cover with no matching existing position → hard veto.
 *      The Bear LLM cannot catch phantom exits because it doesn't know the live book.
 *
 *   2. Momentum overextension: buy with momentum subscore > 92 AND value subscore < 20
 *      → prepend a flag to the rationale so the Bear LLM sees the specific concern.
 *      Not a hard veto — momentum breakouts can be real — but forces explicit review.
 *
 *   3. Regime contradiction: buy in Crisis or Risk-Off regime AND name's score is below
 *      the median of the current scan → hard veto. A below-average name in an elevated-
 *      VIX regime is the weakest possible risk-on entry and the Bear LLM is not reliably
 *      calibrated to reject it (same model as Bull, trained to be helpful).
 */
/**
 * SHORT_SELLING two-layer gate, expressed as the set of order sides the proposal generator may emit.
 * short/cover are allowed only when policy.shortSellingEnabled is true AND the connected account
 * reports shortSelling capability. Otherwise long-only. Mirrors the policy.ts execution-time gate so
 * the schema can never surface a side the gate would reject.
 */
export function allowedProposalSides(policy: TradingPolicy, account?: ExecutionAccount): OrderSide[] {
  const shortAllowed = policy.shortSellingEnabled === true && account?.capabilities?.shortSelling === true;
  return shortAllowed ? ["buy", "sell", "short", "cover"] : ["buy", "sell"];
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

/**
 * Pick the most-specific sufficiently-sampled realized scorecard bucket for a proposal's thesis:
 * the thesis×regime bucket once it has ≥5 trades, else the thesis bucket. Pure. Shared by the
 * deterministic sizer and the negative-expectancy gate so both always read the SAME realized edge.
 */
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

/**
 * OPTIONAL negative-expectancy skip gate (policy.tuning.skipNegativeExpectancy, default OFF). Returns
 * skip=true for an OPENING proposal whose thesis is PROVEN (≥ minClosedLotsForWeightShift closed
 * lots) and whose shrunk realized avg edge — already net of the paper cost model — is ≤
 * skipNegativeExpectancyEdgePct. Exits and unproven theses are never skipped (the sizer's
 * exploratory floor on unproven theses is intentional). Pure aside from the realized-scorecard read.
 */
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

/**
 * OPTIONAL correlation cluster gate (policy.maxAvgCorrelation, default off). Returns the proposals to
 * proceed with, DROPPING any OPENING buy/short whose average daily-return correlation to the current
 * holdings exceeds the cap — the precise version of what maxPortfolioBeta approximates. Exits and
 * reductions (sell/cover) always pass; a candidate with too little overlapping bar data is never
 * rejected (avgReturnCorrelation returns undefined). Async because correlation needs historical bars,
 * which the synchronous policy gate (evaluateTradeProposal) cannot fetch. Skips are logged + audited.
 */
export async function applyCorrelationClusterGate(
  proposals: TradeProposal[],
  policy: TradingPolicy,
  positions: EquityPosition[],
  userId: string = "local"
): Promise<TradeProposal[]> {
  const cap = policy.maxAvgCorrelation;
  if (cap == null || !(cap > 0) || positions.length === 0) return proposals;
  const holdings = positions.map((p) => p.symbol);
  const kept: TradeProposal[] = [];
  for (const p of proposals) {
    const isOpening = p.side === "buy" || p.side === "short";
    if (!isOpening) {
      kept.push(p);
      continue;
    }
    const corr = await avgReturnCorrelation(p.symbol, holdings, userId);
    if (corr != null && corr > cap) {
      console.log(`[Corr] Skipped ${p.symbol} ${p.side}: avg correlation ${corr.toFixed(2)} > cap ${cap}`);
      audit("proposal_skipped_correlation", { symbol: p.symbol, side: p.side, avgCorrelation: Number(corr.toFixed(4)), cap }, userId);
      continue;
    }
    kept.push(p);
  }
  return kept;
}

/**
 * Part 3 — earnings-proximity advisory, split out of `applyRiskReceipts` so it can run EARLY in
 * `runStrategyOnce` (right after the debate loop, before the FIX#3 propose-mode pre-routing and the
 * sell-to-fund intended-notional computation both read `preVetoReasons`). Those two steps decide
 * whether an opening will auto-execute (and therefore whether it should count as intended buy
 * notional / drive automated funding sells) based on `preVetoReasons`; if this tag were applied AFTER
 * them (as it was when it lived only inside `applyRiskReceipts`, called at the `gatedProposals` stage
 * near the end of the pipeline), an earnings-blackout-tagged opening would slip through both checks
 * un-excluded for one run — exactly the hazard `preVetoTaggedOpeningWillPlace`'s doc comment warns
 * about, just for this lane's own new tag.
 *
 * The INFORMATIONAL note is unconditional whenever `daysToEarnings` is known (per spec: "Receipt
 * (always when daysToEarnings known and <= 7)"); only the preVetoReasons TAG depends on
 * `earningsBlackout` being on. Unknown daysToEarnings (Yahoo returned no future earnings date) is
 * skipped silently — never fabricated. Mutates proposals IN PLACE (same reference) for the same
 * reason `applyRiskReceipts` does: `requiresHumanReview` Set membership and `preVetoReasons` array
 * identity must survive downstream reference-keyed checks. Idempotent per proposal (checked via the
 * `[Risk] Earnings` marker) so `applyRiskReceipts` can safely call this again at its later stage
 * without double-appending the note or double-tagging preVetoReasons for the same run.
 */
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
          userId
        );
      }
    }
  }
  return proposals;
}

/**
 * Advisory-only per-candidate risk receipts for OPENING (buy/short) proposals: a correlation profile
 * (pearson/EWMA/downside vs current holdings) + a pre-trade parametric stress scenario, both appended
 * to `proposal.rationale` as `\n\n[Risk] …` notes with a matching `audit(...)` event — plus the
 * earnings-proximity advisory (`applyEarningsBlackoutTag`, see its doc comment for why it's a
 * separate, idempotent function called EARLY in `runStrategyOnce` and again here for callers, such as
 * this function's own unit tests, that invoke `applyRiskReceipts` standalone).
 *
 * Correlation + stress receipts are gated behind `policy.tuning.riskReceipts` (default off/undefined):
 * when off and the earnings tag has already run, this function returns `proposals` UNCHANGED and
 * performs zero extra bar fetches — the rationale/prompt/audit trail stays byte-identical to today.
 * The earnings note/tag is independent (per the board row: earnings blackout is its own opt-in via
 * `policy.tuning.earningsBlackout`) and runs regardless of `riskReceipts`, but only ever touches
 * proposals whose `daysToEarnings` is known (never fabricated) — most runs with neither flag on see NO
 * change at all.
 *
 * Never blocks, drops, or resizes a proposal: `preVetoReasons` tagging follows the exact "tag, fold
 * into the sized PolicyDecision, remain overridable" pattern PR #814 established (see the fold-in at
 * the `preVetoReasons?.length` check before `resolveSocraticOverride`) — it is not a new blocking gate.
 */
export async function applyRiskReceipts(
  proposals: TradeProposal[],
  policy: TradingPolicy,
  positions: EquityPosition[],
  portfolio: Portfolio,
  marketScan: MarketScan,
  userId: string = "local"
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
          userId
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
          userId
        );
      }
    }

    out.push(proposal);
  }

  // Part 3 — earnings-proximity advisory. Idempotent: a no-op for any proposal already tagged by an
  // earlier `applyEarningsBlackoutTag` call in this run (see that function's doc comment for why
  // `runStrategyOnce` calls it early, before this function runs).
  applyEarningsBlackoutTag(out, policy, marketScan, userId);

  return out;
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
  prefetched?: PrefetchedFills
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
  const conviction = corroborated ? rawConviction : Math.min(rawConviction, convictionCap);
  const convictionCapBinds = !corroborated && rawConviction > convictionCap;

  // Edge-aware Kelly-lite: scale by win rate AND conviction AND the realized EDGE.
  // A thesis that wins often but with no/negative expectancy shouldn't get full size;
  // one with a proven positive edge earns more. This uses the learned shrunk avg return
  // so a handful of lucky trades can't inflate sizing.
  const edgeFactor = avgReturn > 1 ? 1 : avgReturn >= 0 ? 0.7 : avgReturn > -1 ? 0.5 : 0.3;
  const rawMultiplier = (winRate / 100) * conviction * edgeFactor;

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
  const multiplier = rawMultiplier * volScale;
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
      userId
    );
  }

  // Bounds are configurable (policy.tuning.sizingFloorPct / sizingCeilingPct); default 10–100%.
  const floor = (policy.tuning?.sizingFloorPct ?? 10) / 100;
  const ceiling = (policy.tuning?.sizingCeilingPct ?? 100) / 100;

  const minLotsForSizing = policy.tuning?.minClosedLotsForWeightShift ?? 20;
  const unproven = sampleTrades < minLotsForSizing;
  const boundedMultiplier = unproven
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
      }, userId);
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
            userId
          );
        } else {
          heatNote =
            `\n\n[Risk] Portfolio heat ${currentHeatPct.toFixed(1)}% of equity vs budget ${heatBudgetPct}% (${totalPositionsCount} positions, ${noStopBasisCount} without stop basis); this order adds ${((orderRiskUsd / equity) * 100).toFixed(2)}%.`;
        }
      }
    }
  }

  const bracketMinimum = bracketWholeShareMinimum(proposal, policy, marketScan);
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
    dollarAmount: targetNotional,
    quantity: undefined, // Override any LLM-guessed quantity to force notional routing
    rationale: proposal.rationale + advisedSizeNote + fallbackSizeNote + bracketMinNote + (unproven
      ? ` — EXPLORATORY floor: thesis has ${sampleTrades} closed lot${sampleTrades === 1 ? "" : "s"} (< ${minLotsForSizing}); held to minimum size until validated.`
      : ` from ${winRate}% win rate, ${avgReturn}% avg edge, and ${Math.round(conviction * 100)}% AI conviction.`) + capNote + advCapNote + volTargetNote + heatNote + kellyNote
  };
}

function bracketWholeShareMinimum(proposal: TradeProposal, policy: TradingPolicy, marketScan?: MarketScan): number | undefined {
  if (proposal.side !== "buy" && proposal.side !== "short") return undefined;
  if (policy.brokerBracketsEnabled === false) return undefined;
  if (policy.activeBroker !== "alpaca" && policy.activeBroker !== "alpaca-mcp") return undefined;
  const stopPct = proposal.side === "short"
    ? (policy.riskRules?.shortStopLossPct ?? policy.riskRules?.stopLossPct ?? 0)
    : (policy.riskRules?.stopLossPct ?? 0);
  const takePct = policy.riskRules?.takeProfitPct ?? 0;
  if (stopPct <= 0 && takePct <= 0) return undefined;
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

function estimateOpeningProposalNotional(proposal: TradeProposal, marketScan?: MarketScan): number | undefined {
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

function openingRiskCapacity(
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

function openingPolicyNotionalCap(proposal: TradeProposal, policy: TradingPolicy, portfolio: Portfolio): number {
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

function formatWholeDollars(value: number): string {
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
function auditWashSaleProceed(
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

function autoRevertOnCapBreach(reasons: string[] | undefined, policy: TradingPolicy, userId: string, connectedAccountId?: string): boolean {
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
  audit("policy_violation_cap_exceeded", { reasons, from: "decide", revertedTo: "propose" }, userId);
  return true;
}

function assertLiveApprovalConfirmation(input: {
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

export async function executeProposal(proposalId: string, userId?: string): Promise<{
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}>;
export async function executeProposal(
  proposalId: string,
  userId: string,
  options: { liveConfirmation?: LiveApprovalConfirmation }
): Promise<{
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}>;
export async function executeProposal(
  proposalId: string,
  userId: string = "local",
  options: { liveConfirmation?: LiveApprovalConfirmation } = {}
): Promise<{
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  if (!policy.accountNumber) throw new Error("No account selected.");
  // An account is an account: with none connected there is no broker to trade through, and there is
  // no local-simulation fallback. Refuse to run rather than synthesize a fake fill.
  if (!executionState.mode) throw new Error("No connected account. Connect a broker account before approving trades.");
  const executionMode: ExecutionMode = executionState.mode;
  const executionSource = fillSourceForExecutionMode(executionMode);
  if (policy.systemState === "halted") throw new Error("System is halted.");

  const row = getProposal(proposalId, userId);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Proposal is already ${row.status}.`);
  if (row.accountNumber !== policy.accountNumber) {
    throw new Error("Proposal account no longer matches the selected account. Re-run the strategy before approving.");
  }
  if (row.executionMode && row.executionMode !== executionMode) {
    throw new Error("Proposal execution mode no longer matches the selected mode. Re-run the strategy before approving.");
  }

  const proposal = row.proposal;
  assertLiveApprovalConfirmation({
    executionMode,
    confirmation: options.liveConfirmation,
    proposalId,
    accountNumber: row.accountNumber,
    proposal,
    estimatedNotional: row.estimatedNotional ?? row.review?.estimatedNotional,
    requireTypedConfirmation: policy.requireTypedConfirmation !== false
  });

  // TOCTOU guard on notional/order caps: the daily/hourly cap check reads the
  // trade_proposals table BEFORE inserting the new row. Without this lock, a
  // concurrent autonomous run (which holds acquireStrategyLock) and a manual
  // Approve can each read the same pre-cap totals and both place — jointly
  // exceeding maxDailyNotional / maxHourlyNotional / maxDailyOrders. Acquiring
  // the same lock here serialises approval execution against the strategy loop.
  if (!acquireStrategyLock(userId, policy.connectedAccountId)) {
    return { status: "busy", reasons: ["A strategy run is in progress; try again in a moment."] };
  }

  try {
    const gateway = getBrokerGateway(policy, userId);

    const [portfolio, positions, orders] = await Promise.all([
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
    const allowedSymbols = allowedSymbolsForPolicy(policy);
    const approvalScanBase = await scanMarket(allowedSymbols, positions, policy.scoringWeights, userId, dynamicIndexUniversesForPolicy(policy), {
      candidateLimit: policy.marketScanCandidateLimit,
      outlierReserve: policy.marketScanOutlierReserve,
      universeFloor: policy.universeFloor
    });
    const approvalQuoteSymbols = uniqueSymbols([...approvalScanBase.topCandidates.map((quote) => quote.symbol), proposal.symbol]);
    const approvalScan = mergeQuoteData(
      approvalScanBase,
      await gateway.getEquityQuotes(policy.accountNumber, approvalQuoteSymbols)
    );

    // An account is an account: the approval is always evaluated against the real broker-reported
    // portfolio and positions for the active account — there is no local-simulation alternative.
    const currentPrices = currentPricesFromScan(approvalScan);
    const account = { portfolio, positions };
    await notifyStaleLimitOrders({ userId, policy, orders });

    const tradability = await gateway.getEquityTradability(policy.accountNumber, [proposal.symbol]);
    if (!tradability[proposal.symbol]?.tradable) {
      const reason = tradability[proposal.symbol]?.reason ?? "Symbol is not tradable.";
      const tradabilityDecision: PolicyDecision = { approved: false, reasons: [reason] };
      updateProposalStatus(proposalId, "blocked", undefined, undefined, undefined, userId, undefined, undefined, tradabilityDecision);
      audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reason }, userId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, reason, proposal }
        },
        { policy, userId }
      );
      return { status: "blocked", reasons: [reason] };
    }

    const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });

    // Same broker-minimum pre-flight guard as the autonomous run loop: NAV/sizing can drift between
    // proposal creation and a human clicking Approve, so re-check here too rather than let a
    // known-doomed order reach the broker from this path.
    // Same whole-position dust-exit exemption as the autonomous loop (see the guard).
    const heldForMinimumGuard = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    const brokerMinimumBlockReason = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...proposal, positionQuantity: heldForMinimumGuard?.quantity });
    if (brokerMinimumBlockReason) {
      const blockedDecision: PolicyDecision = { approved: false, reasons: [brokerMinimumBlockReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, blockedDecision);
      audit(
        "order_skipped_broker_minimum",
        { proposalId, symbol: proposal.symbol, side: proposal.side, estimatedNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, action: "approval" },
        userId,
        policy.connectedAccountId
      );
      if (shouldAlertBrokerMinimumOrderBlock(policy.accountNumber, proposal.symbol)) {
        await sendNotification(
          {
            type: "block",
            title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} skipped (below broker minimum)`,
            payload: { proposalId, decision: blockedDecision, review, proposal }
          },
          { policy, userId }
        );
      }
      return { status: "blocked", reasons: [brokerMinimumBlockReason] };
    }

    const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
    const hourly = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
    const isLiveExecution = executionState.environment === "live";
    const decision = evaluateTradeProposal(proposal, {
      policy,
      portfolio: account.portfolio,
      positions: account.positions,
      dailyNotionalUsed: daily.notional,
      hourlyNotionalUsed: hourly.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: review.estimatedNotional,
      marketScan: approvalScan,
      washSaleLocks: getUserWashSaleLockProvenance(userId, new Date()),
      // Escalated-card override handles from the STORED row (server-minted at escalation time).
      // Empty for ordinary proposals. Only the wash-sale gate consults these, and only while
      // taxSettings.washSaleHandling is ask/auto; every other gate re-runs at full strength.
      approvedEscalations: approvedEscalationsFromDecision(row.decision),
      // ConnectedAccount taxationType is the SOURCE OF TRUTH for the buyer's tax regime (wins
      // over policy taxSettings; capabilities can be absent/"brokerage" on legacy IRA rows) —
      // required so the IRA-replacement hard block (Rev. Rul. 2008-5) can never miss an IRA.
      accountTaxationType: activeAccount?.taxationType,
      accountCapabilities: activeAccount?.capabilities,
      isLiveExecution,
      // PDT gate (FINRA Rule 4210): only meaningful for LIVE execution — skip the count entirely otherwise.
      priorDayTradeCount: isLiveExecution
        ? countDayTradesInLastBusinessDays(policy.accountNumber, 5, new Date(), userId)
        : 0
    });

    // Auditable wash-sale trail on the approval path — never silent. For honored overrides the
    // token ties this execution back to the exact escalated card the owner approved; for IRA
    // disregards the record carries the verbatim note + priced provenance.
    //
    // Gated on decision.approved: a re-evaluation at approval time can return approved:false while
    // still carrying an ira_disregarded / auto_proceeded / approved_via_override outcome (the
    // wash-sale gate itself didn't block, but a later gate — daily cap, buying power, staleness —
    // did). Logging the proceed-trail then would tell Activity the wash sale was disregarded and the
    // deduction forfeited even though the order is blocked below and no purchase happens. When
    // approved, this function proceeds to place/fill the order, so the trail is accurate.
    if (
      decision.approved &&
      decision.washSale &&
      (decision.washSale.outcome === "approved_via_override" ||
        decision.washSale.outcome === "auto_proceeded" ||
        decision.washSale.outcome === "ira_disregarded")
    ) {
      audit(
        decision.washSale.outcome === "ira_disregarded" ? "wash_sale_ira_disregarded" : "wash_sale_override_applied",
        {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          estimatedNotional: review.estimatedNotional,
          washSale: decision.washSale
        },
        userId,
        policy.connectedAccountId
      );
    }

    if (!decision.approved) {
      // Wash-sale re-escalation instead of death: when the ONLY thing standing between this
      // approval and execution is an ask-mode wash-sale failure (fresh lock discovered at
      // approval time, or a stale override refused because the priced cost moved past
      // washSaleOverrideCostTolerance — outcome "reescalated_cost_changed"), keep the card
      // PENDING with the freshly priced reason and newly minted server-side tokens so the owner
      // can approve again at the current cost. Every other refusal (still-binding caps, IRA
      // hard block, universe, ...) retires the card as blocked exactly as before.
      const washReescalation =
        (decision.escalations ?? []).some((entry) => entry.kind === "wash_sale_ask") &&
        shouldEscalateDecision(decision, policy);
      if (washReescalation) {
        const reescalated: PolicyDecision = {
          ...decision,
          escalations: (decision.escalations ?? []).map((entry) => ({ ...entry, token: crypto.randomUUID() }))
        };
        // Guarded re-queue: only while the row is STILL pending. The scan/review above is async,
        // so the scheduler can expire this proposal — or another tab can reject it — while this
        // approval was in flight; an unconditional 'proposed' write here would resurrect that
        // withdrawn card with fresh override tokens. If the row left the pending state, honor
        // that outcome instead of re-queuing.
        if (!transitionProposalIfPending(proposalId, "proposed", userId, { review, estimatedNotional: review.estimatedNotional, decision: reescalated })) {
          const current = getProposal(proposalId, userId);
          audit(
            "proposal_reescalation_skipped",
            {
              proposalId,
              symbol: proposal.symbol,
              side: proposal.side,
              reasons: decision.reasons,
              currentStatus: current?.status ?? "missing"
            },
            userId,
            policy.connectedAccountId
          );
          return {
            status: current?.status ?? "unknown",
            reasons: [
              `Proposal is no longer pending (now ${current?.status ?? "missing"}); the wash-sale re-escalation was not re-queued.`,
              ...decision.reasons
            ]
          };
        }
        audit(
          "proposal_reescalated",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            action: "approval",
            result: "reescalated",
            reasons: decision.reasons,
            escalations: reescalated.escalations,
            ...(decision.washSale ? { washSale: decision.washSale } : {})
          },
          userId,
          policy.connectedAccountId
        );
        await sendNotification(
          {
            type: "pending_approval",
            title:
              decision.washSale?.outcome === "reescalated_cost_changed"
                ? `${proposal.symbol} rebuy needs a fresh call (wash-sale cost changed)`
                : `${proposal.symbol} rebuy needs your call (wash sale)`,
            payload: { proposalId, proposal, review, decision: reescalated, escalated: true }
          },
          { policy, userId }
        );
        return { status: "proposed", reasons: decision.reasons };
      }

      // Same in-flight window as the re-escalation above: retire the card as blocked only if it
      // is still pending — never overwrite a rejection/expiry that landed during the async review.
      transitionProposalIfPending(proposalId, "blocked", userId, { review, estimatedNotional: review.estimatedNotional, decision });
      audit("proposal_approved", {
        proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        action: "approval",
        result: "blocked",
        reasons: decision.reasons
      }, userId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision, review, proposal }
        },
        { policy, userId }
      );
      autoRevertOnCapBreach(decision.reasons, policy, userId);
      return { status: "blocked", reasons: decision.reasons };
    }

    // Re-assert the proposal is still pending immediately before we act on it. The awaits above
    // (scan, broker review) take time, during which deterministic expiry (scheduler tick) or a
    // concurrent run's LLM re-validation could have retired this proposal to expired/withdrawn —
    // we must not place an order for an idea the system already pulled from the queue.
    const stillPending = getProposal(proposalId, userId);
    if (!stillPending || stillPending.status !== "proposed") {
      const current = stillPending?.status ?? "removed";
      return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
    }

    const heldExit = evaluateBrokerHeldExitAvailability(proposal, account.positions, orders);
    if (heldExit) {
      const heldReason = brokerHeldExitBlockReason(heldExit);
      const heldDecision: PolicyDecision = { approved: false, reasons: [heldReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, heldDecision);
      audit(
        "proposal_approved",
        { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reasons: heldDecision.reasons, heldExit },
        userId
      );
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision: heldDecision, review, proposal }
        },
        { policy, userId }
      );
      return { status: "blocked", reasons: heldDecision.reasons };
    }

    // Pre-flight live-order guard on the human-approval path too (parity with the autonomous run
    // loop). No-op on broker/paper; on broker/live it ALLOWS by default and refuses ONLY when live
    // trading has been explicitly disabled via the ALLOW_LIVE_TRADING=false escape hatch. It NEVER
    // places or enables a trade — a human-approved pending proposal clears the same live invariant.
    try {
      assertLivePreflight({
        mode: executionMode,
        symbol: proposal.symbol,
        side: proposal.side
      });
    } catch (guardError) {
      const message = guardError instanceof Error ? guardError.message : String(guardError);
      // Persist a REJECTED decision (not the earlier approved one) so the ledger reflects the block.
      const blockedDecision: PolicyDecision = { ...decision, approved: false, reasons: [...decision.reasons, message] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, message, blockedDecision);
      audit("order_blocked_live_preflight", { proposalId, symbol: proposal.symbol, side: proposal.side, reason: message, path: "approval" }, userId);
      await sendNotification(
        { type: "block", title: `${proposal.symbol} live order blocked (pre-flight)`, payload: { proposalId, proposal, review, reason: message, decision: blockedDecision } },
        { policy, userId }
      );
      return { status: "blocked", reasons: [message] };
    }

    // Atomic, crash-recoverable placement (mirrors the autonomous path): persist the
    // idempotency-keyed intent (status "placing" + refId) BEFORE the broker call so a crash or
    // lost broker response can't leave an untracked real order.
    const refId = crypto.randomUUID();
    // Atomic compare-and-swap BEFORE the broker call: only the caller that flips this proposal
    // proposed -> placing proceeds to placeEquityOrder, so concurrent approvals (double-click, two
    // tabs, from-draft) can't both place a real order (defense in depth with the run-lock above).
    if (!claimProposalForExecution(proposalId, "placing", userId, { review, estimatedNotional: review.estimatedNotional, refId, executionMode })) {
      const current = getProposal(proposalId, userId)?.status ?? "removed";
      return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
    }
    let execution: Awaited<ReturnType<typeof gateway.placeEquityOrder>>;
    try {
      execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...proposal, refId });
    } catch (placeError) {
      const message = placeError instanceof Error ? placeError.message : String(placeError);
      updateProposalStatus(proposalId, "placing_failed", undefined, review, review.estimatedNotional, userId, undefined, message);
      audit("order_placement_uncertain", { proposalId, refId, symbol: proposal.symbol, side: proposal.side, estimatedNotional: review.estimatedNotional, error: message }, userId);
      await sendNotification(
        { type: "run_failed", title: `${proposal.symbol} order placement uncertain — verify with broker`, payload: { proposalId, refId, error: message } },
        { policy, userId }
      );
      return { status: "error", reasons: [`Order placement failed/uncertain: ${message}`] };
    }

    // See the matching comment in the autonomous run-loop placement path above: a non-throwing
    // broker response can still be a synchronous rejection/cancellation, and that must not be
    // recorded as "placed".
    if (isRejectedOrCanceledState(execution.state)) {
      const message = `Broker declined the order (state: ${execution.state}).`;
      updateProposalStatus(proposalId, "rejected_by_broker", execution.orderId, review, review.estimatedNotional, userId, undefined, message);
      audit("order_rejected_by_broker", { proposalId, refId, symbol: proposal.symbol, side: proposal.side, orderId: execution.orderId, brokerState: execution.state }, userId);
      await sendNotification(
        { type: "run_failed", title: `${proposal.symbol} order declined by broker (${execution.state})`, payload: { proposalId, refId, orderId: execution.orderId, state: execution.state } },
        { policy, userId }
      );
      return { status: "error", reasons: [message], orderId: execution.orderId, brokerState: execution.state };
    }

    updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional, userId);
    const fillStatus = execution.state === "filled" ? "filled" : "pending_reconciliation";
    const fill = recordFillFromProposal({
      userId,
      accountNumber: row.accountNumber,
      proposalId,
      runId: row.runId,
      source: executionSource,
      executionMode,
      proposal,
      review,
      execution,
      marketScan: approvalScan,
      status: fillStatus
    });
    audit("proposal_approved", {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      action: "approval",
      result: "placed",
      orderId: execution.orderId,
      brokerState: execution.state,
      fillStatus
    }, userId);
    await sendNotification(
      {
        type: "fill",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} ${execution.state}`,
        payload: { proposalId, fill }
      },
      { policy, userId }
    );
    // Push so other open dashboards refresh immediately (the approving client refreshes via its
    // own response).
    emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: execution.orderId, symbol: proposal.symbol } });
    return { status: "placed", orderId: execution.orderId, brokerState: execution.state, fillStatus };
  } finally {
    releaseStrategyLock(userId, policy.connectedAccountId);
  }
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
  const reflection = getUserSetting(input.userId, "reflection_summary", "");
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
            "bracketTakeProfit"
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
            bracketTakeProfit: { type: ["number", "null"], description: "Optional per-trade take-profit PRICE (absolute). For a buy ABOVE the entry, for a short BELOW it. Leave null to use the account default." }
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
  let bullResult: { text?: string; proposals: TradeProposal[]; truncated?: boolean };
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
                onOutcome: (o) => recordLlmOutcome(o, { runId: input.runId, userId: input.userId, step: "bull", provider: attempt.provider, model: attempt.model, softTimeoutMs: bullSoftTimeoutMs })
              }
            );

            if (!response.ok) {
              const detail = await response.text();
              if (!isLast && isRetryableLlmStatus(response.status)) {
                lastError = new Error(humanizeLlmError(detail, { provider: attempt.provider, status: response.status }));
                console.warn(`[Bull] ${attempt.model}/${attempt.provider} failed (HTTP ${response.status}); failing over to ${next.model}/${next.provider}.`);
                audit("strategy_llm_failover", { runId: input.runId, step: "bull", fromModel: attempt.model, fromProvider: attempt.provider, httpStatus: response.status, toModel: next.model, toProvider: next.provider }, input.userId);
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

            if (!text) {
              throw new Error("Empty response returned from LLM API.");
            }

            try {
              // R10 — fence/prose-tolerant extraction on the PRIMARY (Green/Bull) parse path too:
              // fenced JSON on the proposal step must not degrade to zero proposals.
              const parsed = JSON.parse(extractJsonPayload(text)) as { proposals?: TradeProposal[] };
              return { text, proposals: parsed.proposals ?? [], truncated };
            } catch (parseError) {
              // A truncated/malformed model response must not crash the whole autonomous
              // run; degrade to zero proposals for this tick. The `truncated` flag lets the caller
              // record a DISTINCT truncation reason instead of a silent no-op (see below).
              console.warn("Bull Agent returned unparseable JSON; degrading to zero proposals this run", parseError);
              return { text, proposals: [] as TradeProposal[], truncated };
            }
          } catch (err) {
            // Transient transport error / timeout → fail over to the next model when one remains.
            if (!isLast && isRetryableLlmError(err)) {
              lastError = err;
              console.warn(`[Bull] ${attempt.model}/${attempt.provider} errored (${(err as { message?: string })?.message ?? String(err)}); failing over to ${next.model}/${next.provider}.`);
              audit("strategy_llm_failover", { runId: input.runId, step: "bull", fromModel: attempt.model, fromProvider: attempt.provider, reason: "transport_or_timeout", toModel: next.model, toProvider: next.provider }, input.userId);
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
  // no-op. (See Chat A item 5; raise LLM_OUTPUT_TOKEN_CAPS.strategyProposal if this recurs.)
  const bullTruncationReason = bullResult.truncated
    ? `Green Team response hit the ${LLM_OUTPUT_TOKEN_CAPS.strategyProposal}-token output cap (truncated); ${rawBullProposals.length} proposal(s) parsed. Raise LLM_OUTPUT_TOKEN_CAPS.strategyProposal if this recurs.`
    : undefined;
  if (bullTruncationReason) {
    console.warn(`[Bull] ${bullTruncationReason}`);
    audit(
      "strategy_bull_truncated",
      { runId: input.runId, cap: LLM_OUTPUT_TOKEN_CAPS.strategyProposal, parsedProposals: rawBullProposals.length, provider, model },
      input.userId
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

function currentPricesFromScan(scan?: MarketScan): Record<string, number> {
  if (!scan) return {};
  return Object.fromEntries(
    Object.values(scan.quotesBySymbol)
      .filter((quote) => quote.price > 0)
      .map((quote) => [quote.symbol, quote.price] as const)
  );
}

function uniqueSymbols(symbols: string[]): string[] {
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
 * A protective / stop-loss exit (a Risk-Exit sell or cover) must actually GET OUT, so it executes as a
 * MARKET order rather than a resting limit. A non-marketable limit can miss the fill entirely in
 * exactly the falling tape a stop is meant for — the MU incident: a Risk-Exit limit @ $991 never
 * filled as MU slid to -8%, and the stale unfilled order then blocked every re-exit for a day. Other
 * exits (profit-taking trims, rebalances) keep whatever order type the model chose.
 */
export function coerceProtectiveExitToMarket(proposal: TradeProposal): TradeProposal {
  const isProtectiveExit = (proposal.side === "sell" || proposal.side === "cover") && proposal.tradeThesisTag === "Risk-Exit";
  if (!isProtectiveExit) return proposal;
  if (proposal.type !== "limit" && proposal.type !== "stop_limit") return proposal;
  return {
    ...proposal,
    type: "market",
    limitPrice: undefined,
    stopPrice: undefined,
    rationale: (proposal.rationale ?? "") + "\n\n[Risk] Protective Risk-Exit routed as a MARKET order so it actually fills — a resting limit can miss the exit in a fast/falling tape, and a stale unfilled exit then blocks every retry."
  };
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
  ctx: { runId?: string; userId: string; step: "bull" | "bear"; provider: string; model: string; softTimeoutMs: number }
): void {
  audit(
    "llm_call_latency",
    { runId: ctx.runId, step: ctx.step, provider: ctx.provider, model: ctx.model, durationMs: outcome.durationMs, softTimeoutMs: ctx.softTimeoutMs, late: outcome.late, ok: outcome.ok, status: outcome.status, error: outcome.error },
    ctx.userId
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
        ctx.userId
      );
    } catch (err) {
      audit("llm_late_response_capture_error", { runId: ctx.runId, step: ctx.step, error: err instanceof Error ? err.message : String(err) }, ctx.userId);
    }
  })();
}

function sanitizeProposals(proposals: TradeProposal[], max = 3): TradeProposal[] {
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
          : undefined
    }))
    // Protective Risk-Exits execute as market orders so they cannot rest unfilled (see helper above).
    .map(coerceProtectiveExitToMarket);
}

export async function reconcilePendingFills(gateway: BrokerGateway, accountNumber: string, userId: string = "local"): Promise<void> {
  const pending = listPendingBrokerReconciliationFills(accountNumber, userId);
  if (pending.length === 0) return;

  try {
    const brokerOrders = await gateway.getEquityOrders(accountNumber);
    for (const fill of pending) {
      const matched = brokerOrders.find((bo) => bo.id === fill.brokerOrderId);
      if (!matched) continue;

      const execQty = matched.filledQuantity ?? 0;
      const execPrice = matched.averagePrice ?? fill.price;
      // Book the executed portion of an order. Idempotent: reconcile UPDATES the
      // existing fill record (by fill.id), so a later poll overwriting with a larger
      // executed quantity never double counts; the realtime trade_updates stream funnels
      // into the same record too.
      const bookExecuted = (auditStatus: string) => {
        updateFillEvent(fill.id, {
          status: "filled",
          price: execPrice,
          quantity: execQty,
          notional: execPrice * execQty,
          filledAt: matched.updatedAt ?? new Date().toISOString(),
          raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
        }, userId);
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: auditStatus, price: execPrice, quantity: execQty }, userId);
      };

      if (matched.state === "filled") {
        const price = matched.averagePrice ?? fill.price;
        const qty = matched.filledQuantity ?? fill.quantity;
        updateFillEvent(fill.id, {
          status: "filled",
          price,
          quantity: qty,
          notional: price * qty,
          filledAt: matched.updatedAt ?? new Date().toISOString(),
          raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
        }, userId);
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: "filled", price, quantity: qty }, userId);
      } else if (matched.state === "partially_filled") {
        // A live order that has executed some-but-not-all shares: book the executed
        // portion now so it enters P&L/exposure instead of being silently dropped.
        if (execQty > 0) bookExecuted("partially_filled");
      } else if (isRejectedOrCanceledState(matched.state)) {
        if (execQty > 0) {
          // Order terminated AFTER a partial execution — book the executed shares
          // rather than marking the whole fill cancelled and losing them.
          bookExecuted(`${matched.state}_partial`);
        } else {
          updateFillEvent(fill.id, {
            status: matched.state,
            raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
          }, userId);
          audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: matched.state }, userId);
        }
      }
    }
  } catch (error) {
    console.error("[reconciliation] failed to reconcile pending fills:", error);
  }
}

/**
 * Crash-recovery sweep (companion to the atomic placement path). A "placing" row is an order
 * intent persisted just before the broker call; it flips to "placed"/"placing_failed"
 * synchronously, so one older than the cutoff means a prior run died mid-placement. We can't yet
 * auto-match it to a broker order (that needs client_order_id plumbing into EquityOrder — a
 * follow-up), so we surface it loudly in the audit trail and mark it "placing_stale" so it isn't
 * re-flagged every run. An operator (or the future broker-truth sweep) then reconciles it.
 */
async function flagStalePlacingIntents(gateway: BrokerGateway, accountNumber: string, userId: string): Promise<void> {
  const STALE_PLACING_MS = 2 * 60_000;
  const cutoff = new Date(Date.now() - STALE_PLACING_MS).toISOString();
  let stale: ReturnType<typeof listStalePlacingProposals>;
  try {
    stale = listStalePlacingProposals(accountNumber, cutoff, userId);
  } catch (e) {
    console.error("[placing-sweep] failed to list stale placing intents:", e);
    return;
  }
  if (stale.length === 0) return;

  // Broker-truth-first reconcile: a stale "placing" intent means a prior run died between the
  // broker call and the post-write. Ask the broker for the order carrying our idempotency key
  // (refId → clientOrderId). If it exists, the order DID reach the broker — recover it into P&L/
  // accounting at the broker's real fill price. If no order carries our key, it never executed and
  // is safe to abandon. If the broker is unreachable, leave the row 'placing' for a later retry.
  let brokerOrders: EquityOrder[];
  try {
    brokerOrders = await gateway.getEquityOrders(accountNumber);
  } catch (e) {
    console.error("[placing-sweep] broker unreachable for recovery; will retry next run:", e);
    for (const row of stale) {
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, note: "Stale placing intent; broker unreachable for recovery — will retry." }, userId);
    }
    return;
  }

  for (const row of stale) {
    const p = row.proposal as TradeProposal | undefined;
    const matched = row.refId ? brokerOrders.find((o) => o.clientOrderId && o.clientOrderId === row.refId) : undefined;
    if (matched) {
      updateProposalStatus(row.id, "placed", matched.id, undefined, undefined, userId);
      if (p) {
        const recoveredExecutionMode = row.executionMode ?? "broker/live";
        const recoveredSource: FillSource = recoveredExecutionMode === "broker/live" ? "live" : "paper";
        recordFillFromProposal({
          userId,
          accountNumber,
          proposalId: row.id,
          source: recoveredSource,
          executionMode: recoveredExecutionMode,
          proposal: p,
          execution: { orderId: matched.id, refId: row.refId ?? "", state: matched.state, filledQuantity: matched.filledQuantity, averagePrice: matched.averagePrice, raw: matched },
          status: matched.state === "filled" ? "filled" : "pending_reconciliation"
        });
      }
      audit("order_placement_recovered", { proposalId: row.id, refId: row.refId, orderId: matched.id, state: matched.state, symbol: p?.symbol, side: p?.side }, userId);
    } else {
      updateProposalStatus(row.id, "placing_failed", undefined, undefined, undefined, userId, undefined, "Order never confirmed — broker record not found during reconciliation.");
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, symbol: p?.symbol, side: p?.side, createdAt: row.createdAt, note: "Stale 'placing' intent had no matching broker order — never executed; abandoned." }, userId);
    }
  }
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
export function enrichOpeningProposal(proposal: TradeProposal, policy: TradingPolicy, marketScan: MarketScan, atrStopPctBySymbol: Record<string, number> = {}): TradeProposal {
  if (proposal.side !== "buy" && proposal.side !== "short") return proposal;
  const sym = normalizeSymbol(proposal.symbol);
  const marketPrice = marketScan.quotesBySymbol[sym]?.price;
  const refPrice = proposal.referencePrice ?? marketPrice ?? proposal.limitPrice ?? proposal.stopPrice;
  if (refPrice == null || !(refPrice > 0)) return proposal;
  const entryPrice = proposal.limitPrice ?? proposal.stopPrice ?? refPrice;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let next: TradeProposal = { ...proposal, referencePrice: refPrice };

  const bracketsEnabled = policy.brokerBracketsEnabled !== false; // default ON
  const brokerSupportsBrackets = policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp";
  const dollarOrderBracketQty = next.dollarAmount != null && next.quantity == null ? Math.floor(next.dollarAmount / entryPrice) : undefined;
  const canUseWholeShareBracket = dollarOrderBracketQty == null || dollarOrderBracketQty >= 1;
  if (bracketsEnabled && brokerSupportsBrackets && canUseWholeShareBracket) {
    const flatStopPct = proposal.side === "short"
      ? (policy.riskRules?.shortStopLossPct ?? policy.riskRules?.stopLossPct ?? 0)
      : (policy.riskRules?.stopLossPct ?? 0);
    // Per-symbol FALLBACK stop distance (used only when the LLM did not propose a valid per-trade
    // stop): ATR-scaled when available, else beta-scaled, else the flat policy stop — mirroring
    // generateProactiveRiskProposals' effectiveStopPct precedence (ATR > beta > flat) so a name gets
    // the SAME intelligent stop on the opening bracket as on its proactive exit, never a flat 8% here
    // and an ATR stop there.
    const beta = marketScan.quotesBySymbol[sym]?.beta;
    const atrPct = policy.atrStops === true ? atrStopPctBySymbol[sym] : undefined;
    const stopPct = (typeof atrPct === "number" && atrPct > 0)
      ? atrPct
      : betaScaledStopPct(flatStopPct, beta, policy.betaScaledStops === true);
    const takePct = policy.riskRules?.takeProfitPct ?? 0;
    // Honor a VALID LLM-proposed per-trade stop/take (must sit on the correct side of entry — below
    // for a long, above for a short); a nonsensical one is discarded so the per-symbol fallback fills
    // it in (a stop on the wrong side is worse than the default).
    const llmStop = next.bracketStopLoss;
    const llmStopValid = typeof llmStop === "number" && Number.isFinite(llmStop) && llmStop > 0 &&
      (proposal.side === "buy" ? llmStop < entryPrice : llmStop > entryPrice);
    if (next.bracketStopLoss != null && !llmStopValid) next = { ...next, bracketStopLoss: undefined };
    const llmTake = next.bracketTakeProfit;
    const llmTakeValid = typeof llmTake === "number" && Number.isFinite(llmTake) && llmTake > 0 &&
      (proposal.side === "buy" ? llmTake > entryPrice : llmTake < entryPrice);
    if (next.bracketTakeProfit != null && !llmTakeValid) next = { ...next, bracketTakeProfit: undefined };
    // Long: stop below / take above entry. Short: stop above / take below (price up = loss).
    if (proposal.side === "buy") {
      if (stopPct > 0 && next.bracketStopLoss == null) next = { ...next, bracketStopLoss: round2(entryPrice * (1 - stopPct / 100)) };
      if (takePct > 0 && next.bracketTakeProfit == null) next = { ...next, bracketTakeProfit: round2(entryPrice * (1 + takePct / 100)) };
    } else {
      if (stopPct > 0 && next.bracketStopLoss == null) next = { ...next, bracketStopLoss: round2(entryPrice * (1 + stopPct / 100)) };
      if (takePct > 0 && next.bracketTakeProfit == null) next = { ...next, bracketTakeProfit: round2(entryPrice * (1 - takePct / 100)) };
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
  atrStopPctBySymbol: Record<string, number> = {}
): TradeProposal[] {
  const proactiveProposals: TradeProposal[] = [];
  const stopLossPct = policy.riskRules.stopLossPct ?? 0;
  const shortStopLossPct = policy.riskRules.shortStopLossPct ?? 0;
  const betaStops = policy.betaScaledStops === true;
  const atrStops = policy.atrStops === true;

  // Take-profit trims are handled by planTakeProfitTrims (a stateful, laddered band ratchet); this
  // generator emits only stateless FULL-position stop-loss / short-stop exits.
  if (stopLossPct <= 0 && shortStopLossPct <= 0) return proactiveProposals;

  // Resolve the effective stop DISTANCE for a base stop %: ATR-based when enabled and available
  // (it sets the distance of the configured stop), else beta-scaled, else flat. ATR takes precedence
  // over beta-scaling when both are on — it's the more direct, per-name volatility measure.
  const effectiveStopPct = (sym: string, baseStopPct: number, beta: number | undefined): number => {
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
      proactiveProposals.push({
        symbol: normalizeSymbol(pos.symbol),
        side: exitSide,
        type: "market",
        quantity: Math.abs(pos.quantity),
        timeInForce: "gfd",
        marketHours: "regular_hours",
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
