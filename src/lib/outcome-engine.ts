// outcome-engine.ts — THE OUTCOME WRITER (composite expert review §A, "the single most-blocked-on
// item"). A scheduled maturation job that finally writes SocraticDecisionCase.outcome:
//
//   placed decisions    -> joined to their fill_events entry basis and (when the lot has closed)
//                          the FIFO closed-lot realized P&L from performance.calculatePnl;
//   blocked/rejected    -> joined to the skipped-candidate counterfactual row inserted at
//   (incl. Bear vetoes)    veto/block/rejection time (refPrice basis), same pipeline as the
//                          missed-opportunity analytics;
//
// then measures the multi-horizon (15m/1h/1d/1w) forward returns (outcome-horizons.ts), writes
// outcome + measuredAt, emits a receipt per closed case, and triggers the vector-memory lifecycle
// re-index (writeSocraticDecisionOutcome). It piggybacks the counterfactual cadence: strategy.ts
// fires it right after materializeSkippedCandidateCounterfactuals on every run.
//
// When a case reaches a terminal outcome with real data, a budget-gated LLM post-mortem pass turns
// belief + dissent + evidence vs the realized outcome into 1-3 concrete lessons (direction:
// repeat/avoid/adjust-sizing/adjust-timing) plus {verdictOnBelief, whichDissentMattered}; lessons
// replace the creation-time template strings, re-index, and route through ingestLearned (origin
// 'autonomous'). No LLM key / over budget -> skipped WITH a receipt; the job itself never fails.
//
// Honesty contract: nothing here fabricates a price. Horizons that cannot be measured become
// terminal 'unresolvable' with a reason and stay in every denominator (coverage disclosure
// "N/M resolved (X%)" on the job receipt). Advisory throughout — this writes memory, never gates.
//
// Benchmark basis (owner decision, r4): the market series behind every horizon's spyExcessPct is
// now the S&P 500 INDEX (^GSPC), SPY the automatic ETF fallback (resolveMarketBenchmark, below).
// Under policy.benchmarkMode === 'sector', a case grades against its own symbol's GICS sector
// index/ETF instead (resolveGradingBenchmark) — market otherwise. Every row discloses which series
// it actually used via `benchmarkBasis`; see outcome-horizons.ts's header for the live-verified
// ticker table this is built on.
import {
  audit,
  claimDueJobs,
  completeDueJob,
  enqueueDueJob,
  failDueJob,
  getDueJobStats,
  getConnectedAccount,
  getPolicy,
  getSkippedCounterfactualByRunSymbol,
  getSkippedCounterfactualByRunSymbolHorizon,
  getProposal,
  getSkippedCounterfactualCoverage,
  getSocraticDecisionCase,
  getSocraticOutcomeCoverage,
  listFillEvents,
  listFillEventsByProposalId,
  listSocraticDecisionCasesNeedingOutcome,
  markDueJobUnresolvable,
  updateSkippedCounterfactualOutcomes,
  writeSocraticDecisionLessons,
  writeSocraticDecisionOutcome
} from "./db";
import { fetchDailyOHLC } from "./history";
import type { OHLCBar } from "./indicators";
import { ingestLearned } from "./learned-context/store";
import { isOverLlmBudget } from "./llm-budget";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { resolveLlmEndpoint } from "./llm-provider";
import { LLM_OUTPUT_TOKEN_CAPS, llmFetch } from "./llm-request";
import { extractLlmUsage, providerRequestIdFromPayload, recordLlmUsage } from "./llm-usage";
import { addTradingDays } from "./market-calendar";
import { normalizeSymbol } from "./money";
import { withLlmGeneration } from "./observability";
import {
  buildIntradaySampleJobSpecs,
  closeAtOrAfter,
  computeDailyHorizonRows,
  computeIntradayHorizonRows,
  INTRADAY_HORIZONS,
  MARKET_BENCHMARK_FALLBACK,
  MARKET_BENCHMARK_PRIMARY,
  mergeHorizonRows,
  normalizeDailyBars,
  pickHeadlineAlpha,
  resolveBenchmarkSeries,
  sectorBenchmarkEntry,
  UNRESOLVABLE_AFTER_TRADING_DAYS,
  type NormalizedDailyBar,
  type ResolvedBenchmark
} from "./outcome-horizons";
import { aggregateRoundTrip, calculatePnl, type ClosedLot } from "./performance";
import {
  containPromptDataTree,
  scanForInjectionAttempts,
  type UntrustedPromptField
} from "./prompt-safety";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type {
  BenchmarkMode,
  FillEvent,
  OrderSide,
  OutcomeGradingMode,
  SocraticDecisionCase,
  SocraticEvidenceItem,
  SocraticOutcomeHorizonRow
} from "./types";

/** Collect string leaves under a path for advisory injection scanning (bounded). */
function flattenPromptScanFields(value: unknown, path: string, out: UntrustedPromptField[] = [], depth = 0): UntrustedPromptField[] {
  if (out.length >= 24 || depth > 6) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push({ name: path, text: value });
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < 24; i++) {
      flattenPromptScanFields(value[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (out.length >= 24) break;
      flattenPromptScanFields(child, path ? `${path}.${key}` : key, out, depth + 1);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
const DEFAULT_CASE_LIMIT = 25;
const DEFAULT_RECHECK_MS = 6 * 60 * 60_000;
const DEFAULT_LESSON_BATCH_CAP = 3;
const LESSON_DIRECTIONS = ["repeat", "avoid", "adjust-sizing", "adjust-timing"] as const;
type LessonDirection = (typeof LESSON_DIRECTIONS)[number];

export type OutcomeOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;
/** Live-quote sampler for the 15m/1h forward-sampling windows. Return undefined when no quote. */
export type OutcomeQuoteFetcher = (symbol: string, userId?: string) => Promise<number | undefined>;
/** Test seam for the post-mortem LLM: gets the prompts, returns the raw model text (JSON). */
export type OutcomeLessonLlm = (input: { systemPrompt: string; userContent: string }) => Promise<string | undefined>;

export interface OutcomeEngineOptions {
  now?: number;
  /** Scope to one connected account's decision cases (job runs per-account off the strategy cadence). */
  connectedAccountId?: string;
  /** Max cases examined per run (oldest owed first). */
  limit?: number;
  /** Min gap before re-measuring a still-'open' case. */
  recheckMs?: number;
  /** Max LLM post-mortem passes per run (budget containment on top of the daily LLM budget gate). */
  lessonBatchCap?: number;
  fetchOHLC?: OutcomeOHLCFetcher;
  fetchQuote?: OutcomeQuoteFetcher;
  llm?: OutcomeLessonLlm;
}

export interface OutcomeEngineResult {
  scanned: number;
  /** Cases whose outcome object was written/refreshed this run (incl. still-'open' partials). */
  measured: number;
  /** Cases that reached a terminal outcome status this run (won/lost/flat/unknown/unresolvable). */
  closed: number;
  /** Subset of `closed` that terminated 'unresolvable' (counted, never dropped). */
  unresolvable: number;
  lessonsWritten: number;
  lessonsSkipped: number;
  /** "N/M resolved (X%)" disclosure across decision cases + skipped counterfactuals. */
  coverageDisclosure: string;
}

const TERMINAL_OUTCOME_STATUSES = new Set(["won", "lost", "flat", "unknown", "unresolvable"]);

/**
 * The scheduled maturation pass. Never throws for a single bad case; per-case failures are logged
 * and skipped so one delisted symbol cannot stall the whole ledger.
 */
export async function matureSocraticDecisionOutcomes(
  userId: string = "local",
  options: OutcomeEngineOptions = {}
): Promise<OutcomeEngineResult> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const nowDate = nowIso.slice(0, 10);
  const limit = boundedInteger(options.limit, 1, 200, DEFAULT_CASE_LIMIT);
  const recheckMs = boundedInteger(options.recheckMs, 60_000, 7 * DAY_MS, DEFAULT_RECHECK_MS);
  const lessonBatchCap = boundedInteger(options.lessonBatchCap, 0, 20, DEFAULT_LESSON_BATCH_CAP);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;
  const fetchQuote = options.fetchQuote ?? defaultQuoteFetcher;
  const gradingMode = resolveOutcomeGradingMode(userId, options.connectedAccountId);
  const benchmarkMode = resolveBenchmarkMode(userId, options.connectedAccountId);

  const cases = listSocraticDecisionCasesNeedingOutcome(userId, {
    limit,
    measuredBefore: new Date(now - recheckMs).toISOString(),
    connectedAccountId: options.connectedAccountId
  });

  const barsCache = new Map<string, NormalizedDailyBar[] | null>();
  const getBars = async (symbol: string): Promise<NormalizedDailyBar[] | null> => {
    const key = normalizeSymbol(symbol);
    if (barsCache.has(key)) return barsCache.get(key) ?? null;
    const raw = await fetchOHLC(key, now, userId).catch(() => null);
    const bars = raw ? normalizeDailyBars(raw) : null;
    barsCache.set(key, bars);
    return bars;
  };
  const marketBenchmark = await resolveMarketBenchmark(cases.length > 0, getBars);

  let measured = 0;
  let closed = 0;
  let unresolvable = 0;
  const newlyClosed: SocraticDecisionCase[] = [];

  for (const decisionCase of cases) {
    try {
      const outcome = await measureCase(decisionCase, {
        userId,
        now,
        nowIso,
        nowDate,
        getBars,
        marketBenchmark,
        fetchQuote,
        gradingMode,
        benchmarkMode
      });
      if (!outcome) continue; // nothing decidable yet (e.g. awaiting fill reconciliation)
      const updated = await writeSocraticDecisionOutcome(decisionCase.id, outcome, userId);
      measured += 1;
      // THE alpha-mode observability signal: the market's beta and the decision's quality disagreed
      // (e.g. raw 'won' but SPY-excess 'lost'). Receipted once — terminal cases are never re-measured.
      if (outcome.alphaStatus && outcome.alphaStatus !== outcome.status) {
        audit(
          "outcome_alpha_grading",
          {
            event: "divergence",
            decisionId: decisionCase.id,
            symbol: decisionCase.symbol,
            rawStatus: outcome.status,
            alphaStatus: outcome.alphaStatus,
            alphaPct: outcome.alphaPct,
            returnPct: outcome.returnPct
          },
          userId,
          decisionCase.connectedAccountId
        );
      }
      if (TERMINAL_OUTCOME_STATUSES.has(outcome.status)) {
        closed += 1;
        if (outcome.status === "unresolvable") unresolvable += 1;
        if (updated) newlyClosed.push(updated);
      }
    } catch (err) {
      console.warn(
        `[outcome-engine] failed to measure case ${decisionCase.id} (${decisionCase.symbol ?? "?"}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── Per-decision post-mortem lessons (budget-gated, batch-capped, receipt on every skip) ──────
  let lessonsWritten = 0;
  let lessonsSkipped = 0;
  const lessonCandidates = newlyClosed.filter(
    (c) => c.outcome && c.outcome.status !== "unresolvable" && c.outcome.outcomes.some((row) => row.resolution === "ok")
  );
  // Alpha mode additionally wants alphaStatus resolved before grading a lesson — but a case whose
  // spyExcessPct could not be measured falls back to RAW grading with a receipt (never blocks
  // lesson generation; the candidate list is unchanged either way).
  if (gradingMode === "alpha") {
    for (const candidate of lessonCandidates) {
      if (!candidate.outcome?.alphaStatus) {
        audit(
          "outcome_alpha_grading",
          {
            event: "raw_fallback",
            reason: "no_spy_excess",
            decisionId: candidate.id,
            symbol: candidate.symbol,
            rawStatus: candidate.outcome?.status
          },
          userId,
          // The case's own account, not the run filter — an unfiltered maturation pass would
          // otherwise strip per-account attribution from this receipt.
          candidate.connectedAccountId
        );
      }
    }
  }
  if (lessonCandidates.length > 0 && isOverLlmBudget(userId, options.connectedAccountId)) {
    lessonsSkipped = lessonCandidates.length;
    audit(
      "socratic_lessons_skipped",
      { reason: "over_llm_budget", decisionIds: lessonCandidates.map((c) => c.id) },
      userId,
      options.connectedAccountId
    );
  } else if (lessonCandidates.length > 0) {
    let index = 0;
    for (; index < Math.min(lessonCandidates.length, lessonBatchCap); index += 1) {
      const candidate = lessonCandidates[index];
      const result = await generatePostMortemLessons(candidate, userId, options.llm, gradingMode).catch((err) => {
        console.warn("[outcome-engine] post-mortem lesson pass failed:", err instanceof Error ? err.message : String(err));
        return { written: false, skippedReason: "llm_error" as string | undefined };
      });
      if (result.written) {
        lessonsWritten += 1;
        continue;
      }
      lessonsSkipped += 1;
      audit(
        "socratic_lessons_skipped",
        { reason: result.skippedReason ?? "unknown", decisionIds: [candidate.id] },
        userId,
        options.connectedAccountId
      );
      // No key configured -> every remaining candidate skips identically; receipt once, no retries.
      if (result.skippedReason === "no_llm_key") {
        const rest = lessonCandidates.slice(index + 1);
        if (rest.length > 0) {
          lessonsSkipped += rest.length;
          audit(
            "socratic_lessons_skipped",
            { reason: "no_llm_key", decisionIds: rest.map((c) => c.id) },
            userId,
            options.connectedAccountId
          );
        }
        index = lessonCandidates.length;
        break;
      }
    }
    // Batch cap containment: candidates beyond the per-run cap wait for the next cadence run —
    // receipted so the deferral is visible, not silent.
    const deferred = lessonCandidates.slice(Math.max(index, lessonBatchCap));
    if (index < lessonCandidates.length && deferred.length > 0) {
      lessonsSkipped += deferred.length;
      audit(
        "socratic_lessons_skipped",
        { reason: "batch_cap", decisionIds: deferred.map((c) => c.id) },
        userId,
        options.connectedAccountId
      );
    }
  }

  const decisionCoverage = getSocraticOutcomeCoverage(userId, options.connectedAccountId);
  const counterfactualCoverage = getSkippedCounterfactualCoverage(userId, options.connectedAccountId);
  const coverageDisclosure = `decisions: ${decisionCoverage.disclosure}; skipped counterfactuals: ${counterfactualCoverage.disclosure}`;

  // Job-level maturation receipt (the per-case receipts are emitted inside writeSocraticDecisionOutcome).
  audit(
    "socratic_outcome_job",
    { scanned: cases.length, measured, closed, unresolvable, lessonsWritten, lessonsSkipped, coverage: coverageDisclosure },
    userId,
    options.connectedAccountId
  );

  return { scanned: cases.length, measured, closed, unresolvable, lessonsWritten, lessonsSkipped, coverageDisclosure };
}

// ── Case measurement ──────────────────────────────────────────────────────────────────────────

interface MeasureContext {
  userId: string;
  now: number;
  nowIso: string;
  nowDate: string;
  getBars: (symbol: string) => Promise<NormalizedDailyBar[] | null>;
  /** The market benchmark for this run (^GSPC primary, SPY fallback) — undefined only when there
   * were no cases to grade. */
  marketBenchmark: ResolvedBenchmark | undefined;
  fetchQuote: OutcomeQuoteFetcher;
  gradingMode: OutcomeGradingMode;
  benchmarkMode: BenchmarkMode;
}

/** Read the owner's grading-mode knob, failing OPEN to "raw" — a settings-store failure must never
 * stall outcome maturation (same contract as getUserSourceSettingsMap, source-settings.ts). */
function resolveOutcomeGradingMode(userId: string, connectedAccountId?: string): OutcomeGradingMode {
  try {
    return getPolicy(userId, connectedAccountId).outcomeGradingMode ?? "raw";
  } catch {
    return "raw";
  }
}

/** Read the owner's benchmark-mode knob, failing OPEN to "market" (byte-identical to before this
 * knob existed) — same fail-open contract as resolveOutcomeGradingMode above. */
function resolveBenchmarkMode(userId: string, connectedAccountId?: string): BenchmarkMode {
  try {
    return getPolicy(userId, connectedAccountId).benchmarkMode ?? "market";
  } catch {
    return "market";
  }
}

/** Resolve the run's market benchmark ONCE (shared by every case this pass): ^GSPC primary, SPY
 * the automatic ETF fallback when the index series is unavailable — the SAME fetchDailyOHLC
 * cascade every daily-bar consumer uses (see outcome-horizons.ts's header for the live-verified
 * bar counts). Skips the fetch entirely when there are no cases to grade. */
async function resolveMarketBenchmark(
  needed: boolean,
  getBars: (symbol: string) => Promise<NormalizedDailyBar[] | null>
): Promise<ResolvedBenchmark | undefined> {
  if (!needed) return undefined;
  const primaryBars = await getBars(MARKET_BENCHMARK_PRIMARY);
  const fallbackBars = primaryBars && primaryBars.length >= 2 ? null : await getBars(MARKET_BENCHMARK_FALLBACK);
  return resolveBenchmarkSeries(
    { symbol: MARKET_BENCHMARK_PRIMARY, bars: primaryBars },
    { symbol: MARKET_BENCHMARK_FALLBACK, bars: fallbackBars }
  );
}

/** Choose the benchmark series for THIS case's daily horizons: policy.benchmarkMode === 'sector'
 * with a known, live-mappable sector tries the sector index (falling back to the sector ETF, then
 * the market benchmark) — 'market' mode (default) or an unmapped/unknown sector uses the market
 * benchmark directly. Always the SAME fetchDailyOHLC cascade (ctx.getBars, memoized per run). */
async function resolveGradingBenchmark(
  ctx: MeasureContext,
  sector: string | undefined
): Promise<ResolvedBenchmark | undefined> {
  if (ctx.benchmarkMode !== "sector") return ctx.marketBenchmark;
  const entry = sectorBenchmarkEntry(sector);
  if (!entry) return ctx.marketBenchmark; // unmapped/unknown sector: honest market fallback
  const primarySymbol = entry.indexSymbol ?? entry.etfSymbol;
  const primaryBars = await ctx.getBars(primarySymbol);
  const fallbackBars = primaryBars && primaryBars.length >= 2 ? null : await ctx.getBars(entry.etfSymbol);
  const resolved = resolveBenchmarkSeries(
    { symbol: primarySymbol, bars: primaryBars },
    { symbol: entry.etfSymbol, bars: fallbackBars }
  );
  return resolved ?? ctx.marketBenchmark; // sector series entirely unavailable: honest market fallback
}

/** The symbol's sector at grading time, from whatever was already stored on the decision — the
 * candidate evidence item's quote data (placed AND blocked/rejected cases both carry it via
 * evidenceForDecision, socratic-runtime.ts) or, as a defense-in-depth fallback for blocked/rejected
 * cases, the skipped-candidate counterfactual row's own `sector` column. Never fetched fresh (this
 * is a grading-time lookup, not a new enrichment call) — undefined when neither source has it. */
function sectorForDecisionCase(evidence: SocraticEvidenceItem[], symbol: string, counterfactualSector?: string): string | undefined {
  for (const item of evidence) {
    if (item.kind !== "candidate") continue;
    if (item.symbol && normalizeSymbol(item.symbol) !== symbol) continue;
    const data = item.data;
    if (data && typeof data === "object" && "sector" in data) {
      const sector = (data as { sector?: unknown }).sector;
      if (typeof sector === "string" && sector.trim()) return sector;
    }
  }
  return counterfactualSector;
}

/** Input for gradeSniperAccuracy — the scorecard's stop/take levels vs the matured daily closes. */
export interface SniperAccuracyInput {
  side?: OrderSide;
  stopLoss?: number;
  takeProfit?: number;
  /** The SAME daily series measureCase already fetched — never a new fetch pipeline. */
  bars: NormalizedDailyBar[] | null | undefined;
  /** YYYY-MM-DD of the entry basis; only bars strictly AFTER it participate. */
  basisDate: string;
}

/**
 * Pure sniper-point grading (scorecard r3): did any post-basis DAILY CLOSE breach the proposal's
 * stop / reach its take-profit?  Close basis only — an intraday touch between closes is invisible
 * here, which the receipt's `priceBasis` discloses.  Undefined when the proposal carried no
 * levels or no bars cover the window (the receipt is omitted, never fabricated).
 */
export function gradeSniperAccuracy(
  input: SniperAccuracyInput
): NonNullable<SocraticDecisionCase["outcome"]>["sniperAccuracy"] | undefined {
  const positive = (v: number | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const stop = positive(input.stopLoss);
  const take = positive(input.takeProfit);
  if (stop === undefined && take === undefined) return undefined;
  const bars = (input.bars ?? []).filter((bar) => bar.date > input.basisDate);
  if (bars.length === 0) return undefined;
  // Long: stop breaches DOWN, take-profit hits UP. Short: mirrored (price up = loss).
  const short = input.side === "short";
  return {
    ...(stop !== undefined ? { stopHit: bars.some((bar) => (short ? bar.close >= stop : bar.close <= stop)) } : {}),
    ...(take !== undefined ? { takeProfitHit: bars.some((bar) => (short ? bar.close <= take : bar.close >= take)) } : {}),
    priceBasis: "daily_close"
  };
}

/** Companion alpha grade for a terminal case ('alpha' mode only): verdict + figure from the
 * headline spyExcessPct row, or {} when no resolved horizon carried one (never fabricated). */
function headlineAlphaFields(
  outcomes: SocraticOutcomeHorizonRow[]
): Pick<NonNullable<SocraticDecisionCase["outcome"]>, "alphaStatus" | "alphaPct"> {
  const row = pickHeadlineAlpha(outcomes);
  if (!row || typeof row.spyExcessPct !== "number") return {};
  return {
    alphaStatus: row.spyExcessPct > 0 ? "won" : row.spyExcessPct < 0 ? "lost" : "flat",
    alphaPct: row.spyExcessPct
  };
}

async function measureCase(
  decisionCase: SocraticDecisionCase,
  ctx: MeasureContext
): Promise<NonNullable<SocraticDecisionCase["outcome"]> | undefined> {
  const symbol = decisionCase.symbol ? normalizeSymbol(decisionCase.symbol) : undefined;
  if (!symbol) return undefined; // portfolio-level cases have no per-symbol forward path (yet)

  // 1) Resolve the entry basis (real prices only; provenance recorded in priceBasis).
  let basisPrice: number | undefined;
  let basisAtMs: number | undefined;
  let priceBasisPrefix = "ref_price";
  let realizedLot: ClosedLot | undefined;
  let note: string | undefined;
  // Defense-in-depth sector source for blocked/rejected cases (sectorForDecisionCase prefers the
  // candidate evidence item, which both branches below carry — see evidenceForDecision).
  let counterfactualSector: string | undefined;

  if (decisionCase.status === "placed" || decisionCase.status === "filled") {
    const fills = listFillEventsByProposalId(decisionCase.proposalId ?? decisionCase.id, ctx.userId).filter(
      (fill) => normalizeSymbol(fill.symbol) === symbol
    );
    const entryFill = fills[0];
    if (entryFill && entryFill.price > 0) {
      basisPrice = entryFill.price;
      basisAtMs = Date.parse(entryFill.filledAt);
      priceBasisPrefix = "fill";
      realizedLot = findRealizedLot(entryFill, ctx.userId);
      note = realizedLot
        ? "Realized from the FIFO closed lot opened by this decision's fill."
        : "Position still open; horizon returns measured from the entry fill.";
    } else {
      // Placed but no usable fill row: wait for reconciliation inside the bounded window, then be
      // honest that the join is impossible rather than pending forever.
      const unresolvableAfter = addTradingDays(decisionCase.createdAt.slice(0, 10), UNRESOLVABLE_AFTER_TRADING_DAYS);
      if (ctx.nowDate > unresolvableAfter) {
        return {
          status: "unresolvable",
          ...(decisionCase.outcome?.sniperAccuracy ? { sniperAccuracy: decisionCase.outcome.sniperAccuracy } : {}),
          note: "No fill event ever joined this placed decision (no entry basis).",
          measuredAt: ctx.nowIso,
          outcomes: mergeHorizonRows(decisionCase.outcome?.outcomes, [])
        };
      }
      return undefined;
    }
  } else {
    // blocked / rejected (incl. Bear vetoes) -> counterfactual forward return from refPrice.
    const counterfactual =
      decisionCase.runId ? getSkippedCounterfactualByRunSymbol(ctx.userId, decisionCase.runId, symbol) : undefined;
    if (counterfactual) {
      basisPrice = counterfactual.refPrice;
      basisAtMs = Date.parse(counterfactual.snapshotAt);
      priceBasisPrefix = "ref_price";
      counterfactualSector = counterfactual.sector;
    } else {
      // No counterfactual row (older decisions predate the veto/block insert): fall back to the
      // decision day's daily close as the basis — a real price with its provenance disclosed.
      const bars = await ctx.getBars(symbol);
      const createdDate = decisionCase.createdAt.slice(0, 10);
      const entryBar = bars ? closeAtOrAfter(bars, createdDate) : undefined;
      if (entryBar) {
        basisPrice = entryBar.close;
        basisAtMs = Date.parse(decisionCase.createdAt);
        priceBasisPrefix = `decision_day_close(${entryBar.date})`;
      } else {
        const unresolvableAfter = addTradingDays(createdDate, UNRESOLVABLE_AFTER_TRADING_DAYS);
        if (ctx.nowDate > unresolvableAfter) {
          return {
            status: "unresolvable",
            ...(decisionCase.outcome?.sniperAccuracy ? { sniperAccuracy: decisionCase.outcome.sniperAccuracy } : {}),
            note: "No counterfactual row and no price series for the decision window.",
            measuredAt: ctx.nowIso,
            outcomes: mergeHorizonRows(decisionCase.outcome?.outcomes, [])
          };
        }
        return undefined;
      }
    }
    note = "Counterfactual — this decision was not executed; returns are hypothetical forward moves from the reference price.";
  }

  if (!basisPrice || !Number.isFinite(basisAtMs ?? NaN)) return undefined;
  const basisAt = basisAtMs as number;

  // 1.5) Durable due-jobs: enqueue 'sample_intraday_horizon' jobs (15m/1h after basisAt) the moment
  // this case's entry basis is known, so sampling survives process downtime instead of depending on
  // a strategy run coincidentally landing inside the narrow tolerance window below. Idempotent via
  // dedupe_key (decision:<caseId>:<horizon>) — safe to call on every measureCase pass for this case.
  // Belt-and-suspenders with the inline sampling in step 2: mergeHorizonRows treats an existing
  // terminal row as authoritative, so whichever path (worker or inline) samples first wins and the
  // other becomes a no-op merge, never a duplicate/conflicting row.
  enqueueIntradayDecisionSampleJobs(decisionCase, symbol, basisPrice, basisAt, priceBasisPrefix);

  // 2) Intraday horizons: sample a live quote ONLY when a 15m/1h window is currently open and not
  //    already terminal — the cheap sampling path. Missed windows terminate honestly.
  const existingTerminal = new Set(
    (decisionCase.outcome?.outcomes ?? []).map((row) => row.horizon)
  );
  const elapsedMs = ctx.now - basisAt;
  const samplableNow = INTRADAY_HORIZONS.some(
    ({ horizon, ms, toleranceMs }) => !existingTerminal.has(horizon) && elapsedMs >= ms && elapsedMs <= ms + toleranceMs
  );
  const quotePrice = samplableNow ? await ctx.fetchQuote(symbol, ctx.userId).catch(() => undefined) : undefined;
  const intradayRows = computeIntradayHorizonRows({
    basisPrice,
    basisAtMs: basisAt,
    side: decisionCase.side,
    nowMs: ctx.now,
    quotePrice,
    priceBasisPrefix,
    measuredAt: ctx.nowIso
  });

  // 3) Daily horizons from the cascade's daily closes, benchmark-relative (market, or the symbol's
  // own GICS sector under policy.benchmarkMode === 'sector' — resolveGradingBenchmark).
  const bars = await ctx.getBars(symbol);
  const sector = sectorForDecisionCase(decisionCase.evidence, symbol, counterfactualSector);
  const benchmark = await resolveGradingBenchmark(ctx, sector);
  const dailyRows = computeDailyHorizonRows({
    basisPrice,
    basisDate: new Date(basisAt).toISOString().slice(0, 10),
    side: decisionCase.side,
    bars,
    benchmark,
    nowDate: ctx.nowDate,
    priceBasisPrefix,
    measuredAt: ctx.nowIso
  });

  const outcomes = mergeHorizonRows(decisionCase.outcome?.outcomes, [...intradayRows, ...dailyRows]);

  // 3.5) Sniper-point grading (scorecard r3): compare the proposal's persisted stop/take levels
  // against the SAME daily closes fetched above — a pure additive receipt on the outcome, never a
  // new fetch pipeline and never a gate. Best-effort: a missing proposal row simply omits it.
  // A pass that cannot recompute (transient bars/proposal miss, or a terminal realized-lot write
  // that needed no bars) falls back to the receipt already persisted on the case — matching
  // writeIntradaySampleRow's preservation — instead of silently dropping it.
  const sniperAccuracy =
    (() => {
      try {
        const proposalRow = getProposal(decisionCase.proposalId ?? decisionCase.id, ctx.userId);
        const sniper = proposalRow?.proposal.scorecard?.sniperPoints;
        if (!sniper) return undefined;
        return gradeSniperAccuracy({
          side: decisionCase.side,
          stopLoss: sniper.stopLoss,
          takeProfit: sniper.takeProfit,
          bars,
          basisDate: new Date(basisAt).toISOString().slice(0, 10)
        });
      } catch {
        return undefined;
      }
    })() ?? decisionCase.outcome?.sniperAccuracy;

  // 4) Case-level verdict. Alpha mode ADDS the companion SPY-excess grade on terminal verdicts;
  // the raw status/returnPct are always written unchanged (raw mode is byte-identical to before).
  if (realizedLot) {
    return {
      status: realizedLot.pnl > 0 ? "won" : realizedLot.pnl < 0 ? "lost" : "flat",
      returnPct: realizedLot.returnPct,
      pnlUsd: Number(realizedLot.pnl.toFixed(2)),
      ...(ctx.gradingMode === "alpha" ? headlineAlphaFields(outcomes) : {}),
      ...(sniperAccuracy ? { sniperAccuracy } : {}),
      note,
      measuredAt: ctx.nowIso,
      outcomes
    };
  }

  const allHorizonsTerminal = outcomes.length === 4;
  const okRows = outcomes.filter((row) => row.resolution === "ok");
  if (decisionCase.status !== "placed" && decisionCase.status !== "filled" && allHorizonsTerminal) {
    const headline = pickHeadlineRow(okRows);
    if (headline && typeof headline.returnPct === "number") {
      return {
        status: headline.returnPct > 0 ? "won" : headline.returnPct < 0 ? "lost" : "flat",
        returnPct: headline.returnPct,
        ...(ctx.gradingMode === "alpha" ? headlineAlphaFields(outcomes) : {}),
        ...(sniperAccuracy ? { sniperAccuracy } : {}),
        note: `${note} Headline horizon: ${headline.horizon}.`,
        measuredAt: ctx.nowIso,
        outcomes
      };
    }
    return {
      status: "unresolvable",
      ...(sniperAccuracy ? { sniperAccuracy } : {}),
      note: `${note} No horizon could be measured (${outcomes.map((row) => `${row.horizon}:${row.reason ?? "?"}`).join(", ")}).`,
      measuredAt: ctx.nowIso,
      outcomes
    };
  }

  // Still maturing (placed-with-open-lot, or horizons not yet due): write the partial ledger so the
  // memory doc reflects everything measured so far; the job re-visits after recheckMs.
  return { status: "open", note, ...(sniperAccuracy ? { sniperAccuracy } : {}), measuredAt: ctx.nowIso, outcomes };
}

/** Fire-safe enqueue of the 15m/1h 'sample_intraday_horizon' due-jobs for a decision case whose
 * entry basis was just resolved. Never throws into measureCase's caller. */
function enqueueIntradayDecisionSampleJobs(
  decisionCase: SocraticDecisionCase,
  symbol: string,
  basisPrice: number,
  basisAtMs: number,
  priceBasisPrefix: string
): void {
  try {
    const specs = buildIntradaySampleJobSpecs({
      caseKind: "decision",
      caseId: decisionCase.id,
      runId: decisionCase.runId,
      symbol,
      basisPrice,
      basisAtMs,
      side: decisionCase.side,
      priceBasisPrefix
    });
    for (const spec of specs) {
      enqueueDueJob({
        jobType: "sample_intraday_horizon",
        dedupeKey: spec.dedupeKey,
        dueAt: spec.dueAt,
        notAfter: spec.notAfter,
        payload: spec.payload,
        userId: decisionCase.userId,
        connectedAccountId: decisionCase.connectedAccountId
      });
    }
  } catch (err) {
    console.warn("[outcome-engine] intraday sample job enqueue failed:", err instanceof Error ? err.message : String(err));
  }
}

// ── Durable due-jobs worker: 'sample_intraday_horizon' ───────────────────────────────────────────
// Drains jobs enqueued above (from either the decision-case or the counterfactual pipeline) that
// are now due: samples a live quote, writes the same SocraticOutcomeHorizonRow shape the inline
// samplableNow path in measureCase writes, through the SAME merge path (mergeHorizonRows +
// writeSocraticDecisionOutcome / markSkippedCounterfactual*), so there is exactly one code path for
// "what a resolved 15m/1h row looks like" regardless of which trigger sampled it.

interface IntradaySampleJobPayload {
  caseKind: "decision" | "counterfactual";
  caseId: string;
  /** The owning decision/signal-snapshot run, carried explicitly from enqueue time. Required for
   * caseKind 'counterfactual' (the exact-match lookup key); optional/informational for 'decision'
   * (which is looked up directly by caseId). */
  runId?: string;
  symbol: string;
  /** Only present for caseKind === 'counterfactual' — the exact horizon_days of the owning row. */
  horizonDays?: number;
  horizon: "15m" | "1h";
  basisPrice: number;
  basisAtMs: number;
  side?: OrderSide;
  priceBasisPrefix: string;
}

function parseIntradaySampleJobPayload(raw: Record<string, unknown>): IntradaySampleJobPayload | undefined {
  const caseKind = raw.caseKind === "decision" || raw.caseKind === "counterfactual" ? raw.caseKind : undefined;
  const caseId = typeof raw.caseId === "string" ? raw.caseId : undefined;
  const runId = typeof raw.runId === "string" ? raw.runId : undefined;
  const symbol = typeof raw.symbol === "string" ? raw.symbol : undefined;
  const horizonDays = typeof raw.horizonDays === "number" && Number.isFinite(raw.horizonDays) ? raw.horizonDays : undefined;
  const horizon = raw.horizon === "15m" || raw.horizon === "1h" ? raw.horizon : undefined;
  const basisPrice = typeof raw.basisPrice === "number" && Number.isFinite(raw.basisPrice) ? raw.basisPrice : undefined;
  const basisAtMs = typeof raw.basisAtMs === "number" && Number.isFinite(raw.basisAtMs) ? raw.basisAtMs : undefined;
  const side = raw.side === "buy" || raw.side === "sell" || raw.side === "short" || raw.side === "cover" ? raw.side : undefined;
  const priceBasisPrefix = typeof raw.priceBasisPrefix === "string" ? raw.priceBasisPrefix : undefined;
  if (!caseKind || !caseId || !symbol || !horizon || basisPrice === undefined || basisAtMs === undefined || !priceBasisPrefix) {
    return undefined;
  }
  // For 'counterfactual' jobs, runId + horizonDays are required for the exact-match lookup — a
  // payload missing either (e.g. a pre-fix enqueued job surviving a deploy) cannot be resolved
  // precisely and is treated as malformed rather than silently falling back to a fuzzy match.
  if (caseKind === "counterfactual" && (!runId || horizonDays === undefined)) {
    return undefined;
  }
  return { caseKind, caseId, runId, symbol, horizonDays, horizon, basisPrice, basisAtMs, side, priceBasisPrefix };
}

export interface DrainDueIntradaySampleJobsResult {
  drained: number;
  completed: number;
  unresolvable: number;
  /** Jobs that hit a caught error this pass (owning case not found, quote fetch/exception, etc.) and
   * were routed through failDueJob — MOST of these are retried (pushed-out due_at, back to
   * 'pending'), not terminally failed (db-jobs.ts has no 'failed' status; failDueJob only ever
   * yields 'pending' or 'unresolvable'). Named to avoid implying a persisted "failed" job state —
   * see review finding #3: this used to be called `failed`, which collided in meaning with
   * getDueJobStats().failed, a status value nothing ever produces. */
  erroredRetried: number;
}

/**
 * Claim and process up to `limit` due 'sample_intraday_horizon' jobs. For each: sample a live quote
 * (via `fetchQuote`, defaulting to the same defaultQuoteFetcher the inline path uses), compute the
 * horizon row with computeIntradayHorizonRows, merge it into the owning decision case / skipped
 * counterfactual's persisted outcomes via the exact same helpers writeSocraticDecisionOutcome /
 * markSkippedCounterfactualMatured-adjacent path uses, then complete/fail/unresolvable the job.
 * Never throws — a per-job failure is caught, failDueJob'd (retried with backoff or terminated), and
 * draining continues with the rest of the batch.
 */
export async function drainDueIntradaySampleJobs(
  now: number = Date.now(),
  options: { limit?: number; leaseMs?: number; claimant?: string; fetchQuote?: OutcomeQuoteFetcher } = {}
): Promise<DrainDueIntradaySampleJobsResult> {
  const fetchQuote = options.fetchQuote ?? defaultQuoteFetcher;
  const claimant = options.claimant ?? `outcome-engine:${process.pid}`;
  const jobs = claimDueJobs("sample_intraday_horizon", {
    limit: options.limit ?? 20,
    leaseMs: options.leaseMs ?? 5 * 60_000,
    claimant,
    now: new Date(now)
  });

  let completed = 0;
  let unresolvable = 0;
  let erroredRetried = 0;

  for (const job of jobs) {
    try {
      const payload = parseIntradaySampleJobPayload(job.payload);
      if (!payload) {
        markDueJobUnresolvable(job.id, claimant, "malformed_payload");
        unresolvable += 1;
        continue;
      }

      const nowIso = new Date(now).toISOString();
      const elapsedMs = now - payload.basisAtMs;
      const horizonSpec = INTRADAY_HORIZONS.find((h) => h.horizon === payload.horizon);
      const pastWindow = horizonSpec ? elapsedMs > horizonSpec.ms + horizonSpec.toleranceMs : true;

      const existingOutcomes = readExistingOutcomes(payload, job.userId ?? "local");
      if (existingOutcomes?.some((row) => row.horizon === payload.horizon && row.resolution === "ok")) {
        // The inline path (or an earlier worker pass) already resolved this horizon — nothing to do.
        completeDueJob(job.id, claimant, { skipped: "already_resolved" }, nowIso);
        completed += 1;
        continue;
      }

      const quotePrice = pastWindow ? undefined : await fetchQuote(payload.symbol, job.userId).catch(() => undefined);
      const rows = computeIntradayHorizonRows({
        basisPrice: payload.basisPrice,
        basisAtMs: payload.basisAtMs,
        side: payload.side,
        nowMs: now,
        quotePrice,
        priceBasisPrefix: payload.priceBasisPrefix,
        measuredAt: nowIso
      });
      const row = rows.find((r) => r.horizon === payload.horizon);

      if (!row) {
        // Window still open and no quote sampled yet — not an error, just not due for completion.
        // Leave the job claimed; its lease will expire and a later drain pass retries the sample.
        continue;
      }

      const wrote = await writeIntradaySampleRow(payload, row, job.userId ?? "local");
      if (!wrote) {
        failDueJob(job.id, claimant, "owning_case_not_found");
        erroredRetried += 1;
        continue;
      }

      if (row.resolution === "unresolvable") {
        completeDueJob(job.id, claimant, { resolution: "unresolvable", reason: row.reason }, nowIso);
        unresolvable += 1;
      } else {
        completeDueJob(job.id, claimant, { resolution: "ok", returnPct: row.returnPct }, nowIso);
        completed += 1;
      }
    } catch (err) {
      failDueJob(job.id, claimant, err instanceof Error ? err.message : String(err));
      erroredRetried += 1;
    }
  }

  if (jobs.length > 0) {
    audit("due_jobs_intraday_sample_drain", {
      drained: jobs.length,
      completed,
      unresolvable,
      erroredRetried,
      stats: getDueJobStats("sample_intraday_horizon")
    });
  }

  return { drained: jobs.length, completed, unresolvable, erroredRetried };
}

/** Existing persisted outcome rows for the job's owning case, read fresh so the "already resolved
 * by the inline path" check can't race a stale in-payload snapshot. Looks up the counterfactual by
 * its exact natural key (runId + symbol + horizonDays, all carried explicitly in the job payload
 * since the enqueue-time fix) rather than parsing caseId — a caseId is an opaque identifier, not a
 * format contract, so string-splitting it was fragile and (worse) ignored horizonDays entirely,
 * silently matching the wrong row whenever a run/symbol pair had more than one horizon. */
function readExistingOutcomes(payload: IntradaySampleJobPayload, userId: string): SocraticOutcomeHorizonRow[] | undefined {
  if (payload.caseKind === "decision") {
    return getSocraticDecisionCase(payload.caseId, userId)?.outcome?.outcomes;
  }
  if (!payload.runId || payload.horizonDays === undefined) return undefined;
  const counterfactual = getSkippedCounterfactualByRunSymbolHorizon(userId, payload.runId, payload.symbol, payload.horizonDays);
  return counterfactual?.outcomes;
}

/** Merge one freshly-computed horizon row into the owning case's persisted outcomes and write it
 * back through the SAME writer the case's own maturation pass uses. Returns false when the owning
 * case/counterfactual no longer exists (e.g. deleted) — not an error, just nothing to write. */
async function writeIntradaySampleRow(
  payload: IntradaySampleJobPayload,
  row: SocraticOutcomeHorizonRow,
  userId: string
): Promise<boolean> {
  if (payload.caseKind === "decision") {
    const decisionCase = getSocraticDecisionCase(payload.caseId, userId);
    if (!decisionCase) return false;
    const outcomes = mergeHorizonRows(decisionCase.outcome?.outcomes, [row]);
    const status = decisionCase.outcome?.status ?? "open";
    await writeSocraticDecisionOutcome(
      payload.caseId,
      {
        status,
        returnPct: decisionCase.outcome?.returnPct,
        pnlUsd: decisionCase.outcome?.pnlUsd,
        // Preserve an already-written alpha companion grade — this write only adds a horizon row.
        alphaStatus: decisionCase.outcome?.alphaStatus,
        alphaPct: decisionCase.outcome?.alphaPct,
        // Same for the sniper-accuracy receipt (written by the daily maturation pass).
        sniperAccuracy: decisionCase.outcome?.sniperAccuracy,
        note: decisionCase.outcome?.note,
        measuredAt: row.maturedAt ?? new Date().toISOString(),
        outcomes
      },
      userId
    );
    return true;
  }

  if (!payload.runId || payload.horizonDays === undefined) return false;
  const counterfactual = getSkippedCounterfactualByRunSymbolHorizon(userId, payload.runId, payload.symbol, payload.horizonDays);
  if (!counterfactual) return false;
  const outcomes = mergeHorizonRows(counterfactual.outcomes, [row]);
  // The counterfactual pipeline's own writer (markSkippedCounterfactualMatured /
  // markSkippedCounterfactualUnresolvable) requires an exit bar / terminal-reason argument this
  // worker doesn't have — an intraday sample alone doesn't close the whole counterfactual, only one
  // horizon row within it. Persist via the shared low-level updater instead (no-ops harmlessly once
  // the row has already gone terminal, since that writer is also status='pending'-gated).
  updateSkippedCounterfactualOutcomes(counterfactual.id, userId, outcomes);
  return true;
}

/** Longest resolved horizon wins the headline: 1w > 1d > 1h > 15m. */
function pickHeadlineRow(okRows: SocraticOutcomeHorizonRow[]): SocraticOutcomeHorizonRow | undefined {
  const priority: Array<SocraticOutcomeHorizonRow["horizon"]> = ["1w", "1d", "1h", "15m"];
  for (const horizon of priority) {
    const row = okRows.find((r) => r.horizon === horizon);
    if (row) return row;
  }
  return undefined;
}

/**
 * The COMPLETED round trip opened by this exact fill (symbol + entry timestamp join), if the whole
 * entry quantity has been closed.
 *
 * A scaled-out position closes across several exits, producing one ClosedLot per exit against the
 * same opening lot. Taking the first of those graded the decision on its first trim: two profitable
 * trims followed by a stopped-out remainder read as "won" at the trim's P&L, and the case went
 * terminal before the trade was over. So: aggregate EVERY exit against this entry, and only grade
 * once they add up to the entry quantity. Until then the position is still open and the horizon
 * returns (measured from the entry fill) remain the honest read.
 */
function findRealizedLot(entryFill: FillEvent, userId: string): ClosedLot | undefined {
  try {
    // Unbounded: FIFO replay needs the COMPLETE ledger — see listFillEvents in db-fills.ts.
    const fills = listFillEvents(entryFill.accountNumber, entryFill.source, undefined, userId);
    const { closedLots } = calculatePnl(fills);
    const exits = closedLots.filter(
      (lot) => normalizeSymbol(lot.symbol ?? "") === normalizeSymbol(entryFill.symbol) && lot.entryAt === entryFill.filledAt
    );
    return aggregateRoundTrip(exits, entryFill.quantity);
  } catch {
    return undefined;
  }
}

const defaultQuoteFetcher: OutcomeQuoteFetcher = async (symbol) => {
  try {
    const { fetchYahooFinanceQuote } = await import("./yahoo-finance");
    const quote = await fetchYahooFinanceQuote(normalizeSymbol(symbol));
    return quote && quote.price > 0 ? quote.price : undefined;
  } catch {
    return undefined;
  }
};

// ── Post-mortem lessons ───────────────────────────────────────────────────────────────────────

interface LessonPassResult {
  written: boolean;
  skippedReason?: string;
}

const LESSON_SYSTEM_PROMPT = `You are the per-decision Post-Mortem Engine for a Socratic trading agent.
You receive ONE closed decision case: the original belief (thesis + rationale), the dissent raised against it (Red Team / policy counterarguments), the evidence used, and the REALIZED multi-horizon outcome (15m/1h/1d/1w returns, SPY-relative where available; 'unresolvable' horizons could not be measured — never treat them as zero).
Judge the belief against what actually happened and extract 1-3 CONCRETE lessons. Do not restate the outcome; each lesson must be an actionable behavioral adjustment. Avoid numeric position-size or percent prescriptions — direction words only.
Respond with STRICT JSON only (no markdown, no prose outside the JSON):
{"lessons":[{"lesson":"<one concrete sentence>","direction":"repeat|avoid|adjust-sizing|adjust-timing"}],"verdictOnBelief":"<one sentence: was the original belief right, wrong, or right-for-the-wrong-reason?>","whichDissentMattered":"<one sentence: which recorded dissent, if any, proved material — or 'none'>"}`;

async function generatePostMortemLessons(
  decisionCase: SocraticDecisionCase,
  userId: string,
  llmOverride?: OutcomeLessonLlm,
  gradingMode: OutcomeGradingMode = "raw"
): Promise<LessonPassResult> {
  const outcome = decisionCase.outcome;
  if (!outcome) return { written: false, skippedReason: "no_outcome" };

  // #838: fence untrusted persisted model text (thesis/rationale/dissent/evidence/coach notes)
  // the same way strategy-tuning and framework-review do — quarantine instruction-like spans
  // and keep advisory receipts; never block generation.
  const rawUserPayload = {
    symbol: decisionCase.symbol,
    side: decisionCase.side,
    status: decisionCase.status,
    action: decisionCase.action,
    thesisTag: decisionCase.thesisTag,
    regime: decisionCase.regime,
    confidenceScore: decisionCase.confidenceScore,
    belief: { thesis: decisionCase.thesis, rationale: truncate(decisionCase.rationale, 900) },
    dissent: decisionCase.dissent.slice(0, 6).map((item) => ({ title: item.title, summary: truncate(item.summary, 300) })),
    evidence: decisionCase.evidence.slice(0, 6).map((item) => ({ kind: item.kind, title: item.title, summary: truncate(item.summary, 300) })),
    coachNotes: decisionCase.coachNotes.slice(-5),
    realizedOutcome: outcome,
    // Alpha mode: make the benchmark-relative grade explicit so the post-mortem judges DECISION
    // QUALITY (SPY-excess), not market beta. The raw-fallback note is honest disclosure, not a gate.
    ...(gradingMode === "alpha"
      ? {
          outcomeGrading:
            outcome.alphaStatus !== undefined
              ? {
                  mode: "alpha",
                  alphaStatus: outcome.alphaStatus,
                  alphaPct: outcome.alphaPct,
                  note: "Judge the belief on the SPY-excess (alpha) figures, not the raw return alone."
                }
              : {
                  mode: "alpha",
                  fallback: "raw",
                  note: "spyExcessPct was unmeasurable for this case; graded on raw return."
                }
        }
      : {})
  };
  const contained = containPromptDataTree(rawUserPayload, "unknown", "outcomePostMortem");
  const injectionFindings = scanForInjectionAttempts(
    flattenPromptScanFields(contained.value, "outcomePostMortem").slice(0, 24)
  );
  if (contained.receipts.length > 0 || injectionFindings.length > 0) {
    audit(
      "outcome_postmortem_prompt_safety",
      {
        decisionId: decisionCase.id,
        symbol: decisionCase.symbol,
        containment: contained.receipts.slice(0, 12).map(({ path, result }) => ({
          path,
          status: result.status,
          patterns: result.findings.map((f) => f.pattern)
        })),
        injectionFindings: injectionFindings.slice(0, 12).map((f) => ({
          name: f.name,
          pattern: f.pattern,
          excerpt: f.excerpt.slice(0, 240)
        }))
      },
      userId,
      decisionCase.connectedAccountId
    );
  }
  const userContent = JSON.stringify(contained.value);

  const text = llmOverride
    ? await llmOverride({ systemPrompt: LESSON_SYSTEM_PROMPT, userContent })
    : await callLessonLlm(userId, userContent);
  if (text === undefined) return { written: false, skippedReason: llmOverride ? "llm_empty" : "no_llm_key" };

  const parsed = parseLessonResponse(text);
  if (!parsed || parsed.lessons.length === 0) return { written: false, skippedReason: "unparseable_llm_response" };

  const lessonLines = parsed.lessons.map(({ lesson, direction }) => `(${direction}) ${lesson}`);
  const lessons = [
    ...lessonLines,
    `Belief verdict: ${parsed.verdictOnBelief}`,
    `Decisive dissent: ${parsed.whichDissentMattered}`
  ];
  await writeSocraticDecisionLessons(decisionCase.id, lessons, userId);

  audit(
    "socratic_decision_postmortem",
    {
      decisionId: decisionCase.id,
      symbol: decisionCase.symbol,
      lessons: parsed.lessons,
      verdictOnBelief: parsed.verdictOnBelief,
      whichDissentMattered: parsed.whichDissentMattered,
      outcomeStatus: outcome.status
    },
    userId,
    decisionCase.connectedAccountId
  );

  // Route each lesson as PORTFOLIO-scoped learned context so paper and live accounts both
  // contribute to model/task comparison (owner 2026-08-04: an account is an account; paper is
  // first-class learning evidence unless a definite paper-exclusive cause applies — that
  // exception is enforced by the daily Learning Review, not by scoping lessons away).
  // A historical case without a connected account may still write with unknown environment;
  // we only refuse when we cannot identify a user at all (userId is required by ingestLearned).
  const lessonAccount = decisionCase.connectedAccountId
    ? getConnectedAccount(decisionCase.connectedAccountId, userId)
    : undefined;
  const accountEnvironment = lessonAccount?.environment ?? null;
  if (decisionCase.connectedAccountId && !lessonAccount) {
    // Account id was stamped but the row is gone — still write the lesson, but audit so we
    // notice orphaned provenance. Do not drop model/task evidence for missing account metadata.
    audit(
      "learned_context.account_provenance_missing",
      { userId, decisionId: decisionCase.id, connectedAccountId: decisionCase.connectedAccountId, note: "wrote portfolio lesson with null environment" },
      userId,
      decisionCase.connectedAccountId
    );
  }

  for (const { lesson, direction } of parsed.lessons) {
    try {
      const envNote = accountEnvironment ? ` on a ${accountEnvironment} broker account` : "";
      await ingestLearned(
        userId,
        {
          kind: "decision",
          subject: `decision_lesson:${decisionCase.symbol ?? "portfolio"}:${decisionCase.thesisTag ?? "untagged"}`,
          value: `${lesson} (direction: ${direction}; from the ${decisionCase.symbol ?? "portfolio"} ${decisionCase.status} decision${envNote}, outcome ${outcome.status})`,
          symbol: decisionCase.symbol,
          // Distinct from the generic "inferred" source so a lesson written HERE is identifiable in
          // the brain's provenance line (`source=postmortem-outcome`) without a schema change.
          source: "postmortem-outcome",
          confidence: 0.55,
          // PROVENANCE (2026-09-27). This text is derived by this app from its OWN closed, measured
          // trade outcome — it is a statement about what already happened, not a claim about how to
          // trade next. The semantic gate's LLM layer used to read it, answer "yes, this would
          // influence trading behavior" (which is what a sizing lesson literally is), upgrade it to
          // 'risk', and park it in learned_context_pending — a queue read only by a human click or the
          // nightly Learning Review. That made the single highest-quality artifact the system produces
          // effectively unreadable to the system. The marker skips the LLM layer only; the keyword
          // layer still runs, so a lesson naming an actual risk knob is still queued for approval.
          provenance: "system-postmortem"
        },
        "autonomous",
        {
          // No connectedAccountId → learningScope defaults to "portfolio" (cross-account).
          // Keep paper/live on accountEnvironment for Learning Review attribution only.
          ...(accountEnvironment ? { accountEnvironment } : {}),
          learningScope: "portfolio"
        }
      );
    } catch (err) {
      console.warn("[outcome-engine] ingestLearned for lesson failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return { written: true };
}

/**
 * Real LLM call (same plumbing as post-mortem.ts). Returns undefined when no key is configured.
 *
 * INTENTIONALLY EXEMPT from strategy.ts's run-scoped usage-budget model downgrade: this job runs
 * fire-and-forget, detached from any single `runStrategyOnce` call's lifetime (it matures cases
 * across accounts/runs and can still be in flight after the triggering run returns), so there is no
 * single well-defined "this run's downgrade" to hand it. It always re-reads the owner's persisted
 * (undowngraded) policy — same behavior as before the usage-budget downgrade existed.
 */
export async function callLessonLlm(userId: string, userContent: string): Promise<string | undefined> {
  const policy = getPolicy(userId);
  const { url, key, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(
    policy,
    userId,
    "https://api.openai.com/v1/chat/completions"
  );
  // No-defaults / rotation-sentinel safety net: resolveLlmEndpoint maps an unconfigured OR "__rotate__"
  // model to "" outside a strategy run (rotation is resolved only inside runStrategyOnce), so a blank
  // model with a present key must be treated as unconfigured — skip cleanly rather than POST model:""
  // (which 400s on every post-mortem lesson call). Same contract as strategy-tuning's local-rules gate.
  if (!key || !model) return undefined;

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt: LESSON_SYSTEM_PROMPT,
      userContent,
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.postMortemReflection,
      reasoningEffort: policy.llmReasoningEffort,
      userId,
      keyRef,
      service: "strategy",
      feature: "outcome-postmortem"
    }
  );

  const traced = await withLlmGeneration(
    {
      name: "trading.outcome-engine.postmortem",
      model,
      userId,
      input: summarizeOpenAiRequest(body),
      metadata: { endpoint: url, transport },
      tags: ["outcome-engine", "post-mortem"],
      output: (result: { text?: string }) => summarizeOpenAiResponseText(result.text)
    },
    async () => {
      const response = await llmFetch(url, {
        method: "POST",
        headers: llmAuthHeaders({ provider, key }),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn(
          "[outcome-engine] post-mortem LLM call failed:",
          humanizeLlmError(await response.text().catch(() => ""), { provider, status: response.status })
        );
        return { text: undefined };
      }
      const payload = await response.json();
      recordLlmUsage({ userId, provider, model, context: "outcome-postmortem", keySource, keyRef, connectedAccountId: policy.connectedAccountId, providerRequestId: providerRequestIdFromPayload(provider, payload), ...extractLlmUsage(payload) });
      const text = extractLlmText(payload);
      return { text: typeof text === "string" ? text : undefined };
    }
  );
  return traced.text;
}

interface ParsedLessonResponse {
  lessons: Array<{ lesson: string; direction: LessonDirection }>;
  verdictOnBelief: string;
  whichDissentMattered: string;
}

function parseLessonResponse(text: string): ParsedLessonResponse | undefined {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as { lessons?: unknown; verdictOnBelief?: unknown; whichDissentMattered?: unknown };
  const lessons = Array.isArray(obj.lessons)
    ? obj.lessons
        .map((entry) => {
          const item = entry as { lesson?: unknown; direction?: unknown };
          const lesson = typeof item.lesson === "string" ? item.lesson.trim() : "";
          const direction = LESSON_DIRECTIONS.find((d) => d === item.direction);
          return lesson && direction ? { lesson, direction } : undefined;
        })
        .filter((entry): entry is { lesson: string; direction: LessonDirection } => Boolean(entry))
        .slice(0, 3)
    : [];
  return {
    lessons,
    verdictOnBelief: typeof obj.verdictOnBelief === "string" && obj.verdictOnBelief.trim() ? obj.verdictOnBelief.trim() : "not stated",
    whichDissentMattered:
      typeof obj.whichDissentMattered === "string" && obj.whichDissentMattered.trim() ? obj.whichDissentMattered.trim() : "none"
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}
