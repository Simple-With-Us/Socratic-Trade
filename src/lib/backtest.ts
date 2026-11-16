// Information-coefficient (IC) backtest harness over the persisted `signal_snapshot`
// audit data. Addresses the "factor weights are unvalidated, no backtest" review
// finding: instead of trusting the hand-tuned DEFAULT_SCORING_WEIGHTS, this measures
// each factor sub-score's realized predictive power (rank IC vs forward return) from
// the deterministic evidence we already store at every decision.
//
// Design split (intentional, mirrors counterfactual-learning.ts):
//   - buildFactorObservations is the ONLY IO function. It reads the audit rows and an
//     injectable OHLC fetcher to compute matured forward returns. Never fabricates a
//     price: no matured bar → the observation is omitted (same posture as the
//     counterfactual materializer — unresolved, not invented).
//   - computeFactorICs and deriveWeightsFromICs are PURE and Date.now()-free, so they
//     are deterministic and unit-testable with in-memory fixtures (no db, no network).

import { listSignalSnapshotAuditAfter, type SignalSnapshotAuditRow } from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { addTradingDays, marketDateOf } from "./market-calendar";
import { normalizeSymbol } from "./money";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { OOS_ROUND_TRIP_COST_BPS } from "./execution-cost";
import type { MarketFactor, MarketFactorBreakdown, ScoringWeights } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 5;
const DEFAULT_AUDIT_LIMIT = 500;

/** The eight scored factors, derived from the canonical weight keys (single source of truth). */
export const MARKET_FACTORS = Object.keys(DEFAULT_SCORING_WEIGHTS) as MarketFactor[];

/** Injectable daily-OHLC fetcher; matches `fetchDailyOHLC`'s signature for drop-in defaulting. */
export type BacktestOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;

/**
 * One resolved per-candidate observation: the factor sub-scores recorded at decision
 * time and the realized N-business-day forward return computed from stored `refPrice`
 * (entry) to the first daily close on/after entryDate + N business days (exit).
 */
export interface FactorObservation {
  /** Snapshot business day (YYYY-MM-DD) — the cross-sectional grouping key for IC. */
  date: string;
  symbol: string;
  /** Factor sub-scores at decision time (from `factorBreakdown`, excluding weightedTotal). */
  subScores: Record<MarketFactor, number>;
  /** Realized forward return as a fraction (e.g. 0.05 = +5%). */
  forwardReturn: number;
  /** Market regime stamped on the snapshot at decision time (item 7 per-regime IC report). Optional. */
  regime?: string;
}

/** Averaged cross-sectional rank IC for one factor across all snapshot dates. */
export interface FactorIC {
  factor: MarketFactor;
  /** Mean per-date Spearman rank IC (NaN-free; 0 when no date had ≥2 usable names). */
  ic: number;
  /** Number of snapshot dates that contributed an IC (had ≥2 names with finite values). */
  n: number;
}

export interface BuildFactorObservationsOptions {
  /** Forward-return horizon in business days. Default 5. */
  horizonDays?: number;
  /** Max audit rows to scan. Default 500. */
  auditLimit?: number;
  /** Reference "now" passed to the fetcher (kept out of the pure path). Default Date.now(). */
  now?: number;
  /** Injectable OHLC fetcher; defaults to fetchDailyOHLC. */
  fetchOHLC?: BacktestOHLCFetcher;
  /** Restrict signal-snapshot evidence to one connected account. Omitted preserves user-wide tools. */
  connectedAccountId?: string;
}

interface SignalSnapshotPayload {
  runId?: string;
  asOf?: string;
  signals?: Array<{
    symbol?: string;
    refPrice?: number;
    factorBreakdown?: MarketFactorBreakdown;
    asOf?: string;
    regime?: string;
  }>;
}

/**
 * THE ONLY IO FUNCTION. Reads `signal_snapshot` audit rows for `userId` and, for every
 * candidate that carries both a `refPrice` and a `factorBreakdown`, computes the
 * matured N-business-day forward return (entry = stored refPrice; exit = first daily
 * close on/after entryDate + N business days). Returns one {date, symbol, subScores,
 * forwardReturn} per resolvable candidate and SKIPS anything unresolved (no refPrice,
 * no breakdown, no matured exit bar) — it never fabricates a price.
 */
export async function buildFactorObservations(
  userId: string = "local",
  options: BuildFactorObservationsOptions = {}
): Promise<FactorObservation[]> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const rows = listSignalSnapshotAuditAfter(userId, undefined, auditLimit, options.connectedAccountId);
  const observations: FactorObservation[] = [];
  // Cache bars per symbol across the whole scan; null means "fetched, none available".
  const barsBySymbol = new Map<string, OHLCBar[] | null>();

  for (const row of rows) {
    const parsed = parseSnapshot(row);
    if (!parsed) continue;
    const { snapshotDate, signals } = parsed;
    const targetDate = targetBusinessDate(snapshotDate, horizonDays);

    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol ?? "");
      const refPrice = positiveNumber(signal.refPrice);
      const subScores = extractSubScores(signal.factorBreakdown);
      if (!symbol || !refPrice || !subScores) continue;

      let bars = barsBySymbol.get(symbol);
      if (bars === undefined) {
        bars = await fetchOHLC(symbol, now, userId);
        barsBySymbol.set(symbol, bars);
      }
      const exit = bars ? selectExitClose(bars, targetDate) : undefined;
      if (exit === undefined) continue; // unresolved → omit, never invent

      observations.push({
        date: snapshotDate,
        symbol,
        subScores,
        forwardReturn: (exit - refPrice) / refPrice,
        ...(typeof signal.regime === "string" && signal.regime.trim() ? { regime: signal.regime.trim() } : {})
      });
    }
  }

  return observations;
}

/**
 * PURE (panel P1-4a — HARD look-ahead invariant). The exit bar a forward return is computed from MUST be
 * strictly AFTER the snapshot date — specifically on/after `snapshotDate + horizonDays`, and never on the
 * snapshot day itself. `selectExitClose` already enforces `bar.date >= targetBusinessDate(...)`; this exposes
 * the boundary as a testable predicate so a leakage regression is a CI-failing unit assertion, not a comment.
 * Returns true when `exitBarDate` is a valid point-in-time exit for `(snapshotDate, horizonDays)`.
 */
export function isPointInTimeForwardExit(snapshotDate: string, horizonDays: number, exitBarDate: string): boolean {
  const target = targetBusinessDate(snapshotDate, horizonDays);
  // The exit must be at/after the horizon target AND strictly after the snapshot day (a same-day bar is
  // look-ahead: it uses information not available when the decision was recorded).
  return exitBarDate >= target && exitBarDate > snapshotDate;
}

/** Survivorship / look-ahead certification report (panel P1-4b — SOFT diagnostic; gates NOTHING). */
export interface ForwardResolutionCertification {
  /** Total snapshotted (symbol, date) candidate pairs that had a usable refPrice + factor breakdown. */
  totalCandidates: number;
  /** How many of those resolved to a matured forward price (a point-in-time exit bar exists). */
  resolvedForward: number;
  /** resolvedForward / totalCandidates (0 when none). A SURVIVORSHIP PROXY — see `note`. */
  forwardCoveragePct: number;
  /** How many resolved-forward pairs also satisfy the strict point-in-time exit invariant (should equal all). */
  pointInTimeExits: number;
  /** True when every resolved exit satisfied the point-in-time invariant (no look-ahead detected). */
  pointInTimeClean: boolean;
  /** Human coverage disclosure ("N/M resolved (X%) — may be survivor-biased"): unresolved candidates
   *  stay in the denominator so the reader sees exactly how survivor-thinned the learner's join is. */
  coverageDisclosure: string;
  note: string;
}

/**
 * IO (panel P1-4b). SOFT survivorship / look-ahead certification: reports the fraction of snapshotted
 * candidates whose forward price is resolvable, plus a check that every resolved exit is point-in-time. This
 * is a PROXY — it does NOT certify absence of survivorship bias (the `signal_snapshot` log may itself be
 * survivor-only, e.g. a delisted name whose bars vanished simply drops out) — and it GATES NOTHING. Reuses
 * the same `selectExitClose` + `targetBusinessDate` path as `buildFactorObservations`, so its resolution
 * decision is identical to what actually feeds the learner.
 */
export async function certifyForwardResolution(
  userId: string = "local",
  options: BuildFactorObservationsOptions = {}
): Promise<ForwardResolutionCertification> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const rows = listSignalSnapshotAuditAfter(userId, undefined, auditLimit);
  const barsBySymbol = new Map<string, OHLCBar[] | null>();
  let totalCandidates = 0;
  let resolvedForward = 0;
  let pointInTimeExits = 0;

  for (const row of rows) {
    const parsed = parseSnapshot(row);
    if (!parsed) continue;
    const { snapshotDate, signals } = parsed;
    const targetDate = targetBusinessDate(snapshotDate, horizonDays);
    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol ?? "");
      const refPrice = positiveNumber(signal.refPrice);
      const subScores = extractSubScores(signal.factorBreakdown);
      if (!symbol || !refPrice || !subScores) continue;
      totalCandidates += 1;

      let bars = barsBySymbol.get(symbol);
      if (bars === undefined) {
        bars = await fetchOHLC(symbol, now, userId);
        barsBySymbol.set(symbol, bars);
      }
      // Find the exit bar's DATE (not just its close) so we can assert the point-in-time invariant.
      const exitBar = bars
        ? bars
            .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
            .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
            .sort((a, b) => a.date.localeCompare(b.date))
            .find((bar) => bar.date >= targetDate)
        : undefined;
      if (!exitBar) continue;
      resolvedForward += 1;
      if (isPointInTimeForwardExit(snapshotDate, horizonDays, exitBar.date)) pointInTimeExits += 1;
    }
  }

  const coveragePct = totalCandidates > 0 ? Number(((resolvedForward / totalCandidates) * 100).toFixed(1)) : 0;
  return {
    totalCandidates,
    resolvedForward,
    forwardCoveragePct: totalCandidates > 0 ? Number((resolvedForward / totalCandidates).toFixed(4)) : 0,
    pointInTimeExits,
    pointInTimeClean: resolvedForward === pointInTimeExits,
    coverageDisclosure:
      totalCandidates > 0
        ? `${resolvedForward}/${totalCandidates} resolved (${coveragePct}%) — may be survivor-biased`
        : "0 candidates — nothing to resolve",
    note: "SURVIVORSHIP PROXY — forwardCoveragePct measures resolvable forward prices, NOT absence of survivorship bias (the signal_snapshot log may itself be survivor-only). Diagnostic only; gates nothing."
  };
}

/**
 * PURE. Cross-sectional Spearman rank IC between each factor sub-score and forward
 * return, computed PER snapshot date and then averaged across dates. Tie-aware:
 * ties share their average rank and the correlation is the Pearson correlation of
 * those average ranks (the standard tie-corrected Spearman). Date.now()-free.
 *
 * Returns one entry per market factor (stable order). A factor's `ic` is the mean of
 * its per-date ICs; `n` is how many dates contributed (a date contributes only if it
 * has ≥2 names with finite sub-score AND finite forward return AND non-degenerate
 * variance in both after ranking).
 */
export function computeFactorICs(observations: FactorObservation[]): FactorIC[] {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  return MARKET_FACTORS.map((factor) => {
    let sum = 0;
    let dates = 0;
    for (const group of byDate.values()) {
      const scores: number[] = [];
      const returns: number[] = [];
      for (const obs of group) {
        const s = obs.subScores[factor];
        const r = obs.forwardReturn;
        if (Number.isFinite(s) && Number.isFinite(r)) {
          scores.push(s);
          returns.push(r);
        }
      }
      if (scores.length < 2) continue;
      const ic = spearmanRankIC(scores, returns);
      if (ic === undefined) continue; // degenerate (zero variance after ranking)
      sum += ic;
      dates += 1;
    }
    return { factor, ic: dates > 0 ? sum / dates : 0, n: dates };
  });
}

/** Per-regime factor-IC report (item 7). Application of regime-conditioned weights is intentionally NOT
 * wired: per-regime buckets in this research app are almost always far below the sample size needed to
 * avoid overfitting, so this is a READ-ONLY diagnostic. `sufficient` flags whether the regime had enough
 * distinct snapshot dates for its ICs to be trustworthy — application stays off regardless. */
export interface PerRegimeFactorIC {
  regime: string;
  /** Distinct snapshot dates observed in this regime bucket. */
  dates: number;
  /** Total observations in this regime bucket. */
  observations: number;
  /** Per-factor IC within this regime. */
  ics: FactorIC[];
  /** True when `dates >= minDates` (i.e. the per-regime sample is large enough to be worth reading). */
  sufficient: boolean;
}

/**
 * PURE. Group `FactorObservation`s by their stamped `regime` and compute per-factor IC within each regime.
 * Observations with no regime are bucketed under "Unspecified". `minDates` (default 8) is the sufficiency
 * bar below which a regime's ICs are statistically too thin to act on — this function REPORTS them either
 * way (with `sufficient` set) but never itself applies regime-conditioned weights. Date.now()-free.
 */
export function computePerRegimeFactorICs(observations: FactorObservation[], minDates = 8): PerRegimeFactorIC[] {
  const byRegime = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const regime = obs.regime && obs.regime.trim() ? obs.regime.trim() : "Unspecified";
    const bucket = byRegime.get(regime);
    if (bucket) bucket.push(obs);
    else byRegime.set(regime, [obs]);
  }
  return Array.from(byRegime.entries())
    .map(([regime, group]) => {
      const dates = new Set(group.map((o) => o.date)).size;
      return {
        regime,
        dates,
        observations: group.length,
        ics: computeFactorICs(group),
        sufficient: dates >= minDates
      };
    })
    .sort((a, b) => b.observations - a.observations);
}

/**
 * PURE. Per-factor IC — an alias for `computeFactorICs` that returns the same per-factor
 * IC and sample-size data. Accepts the same `FactorObservation[]` produced by
 * `buildFactorObservations`. Exported under the singular name for callers that prefer it.
 *
 * @returns One entry per market factor in canonical order: { factor, ic, n }
 */
export function computePerFactorIC(
  observations: FactorObservation[]
): { factor: MarketFactor; ic: number; n: number }[] {
  return computeFactorICs(observations);
}

/**
 * PURE. Derive scoring weights from per-factor ICs with a minimum sample-size gate.
 * - Factors with `n < minN` are excluded (insufficient data) and receive their DEFAULT weight.
 * - Negative ICs are floored to 0.
 * - Positive ICs are scaled so their sum matches the sum of DEFAULT_SCORING_WEIGHTS (~8.6)
 *   rather than 1.0, so the derived weights are in the same magnitude as the hand-tuned defaults.
 * - If no factor clears both the minN gate AND has a positive IC, returns DEFAULT_SCORING_WEIGHTS.
 *
 * @param perFactorIC  Output of `computePerFactorIC` or `computeFactorICs`.
 * @param minN         Minimum number of contributing snapshot dates to use a factor's IC. Default 20.
 * @returns Partial<ScoringWeights> — factors below minN carry their DEFAULT value.
 */
export function deriveWeightsFromIC(
  perFactorIC: { factor: MarketFactor; ic: number; n: number }[],
  minN: number = 20
): Partial<ScoringWeights> {
  const defaultSum = MARKET_FACTORS.reduce((s, f) => s + DEFAULT_SCORING_WEIGHTS[f], 0);

  const qualified = new Map<MarketFactor, number>();
  let positiveTotal = 0;
  for (const { factor, ic, n } of perFactorIC) {
    if (n >= minN && Number.isFinite(ic) && ic > 0) {
      qualified.set(factor, ic);
      positiveTotal += ic;
    }
  }

  // If nothing qualifies, fall back to defaults entirely.
  if (positiveTotal <= 0) return { ...DEFAULT_SCORING_WEIGHTS };

  const out: Partial<ScoringWeights> = {};
  for (const factor of MARKET_FACTORS) {
    if (qualified.has(factor)) {
      // Scale so positive ICs sum to the same total as the defaults.
      out[factor] = (qualified.get(factor)! / positiveTotal) * defaultSum;
    } else {
      // Below minN (or negative IC) → keep default weight unchanged.
      out[factor] = DEFAULT_SCORING_WEIGHTS[factor];
    }
  }
  return out;
}

/**
 * PURE. Turns measured ICs into a normalized weight vector: floor each negative IC at
 * 0, then normalize the positives to sum to 1. If every IC is ≤ 0 (no factor showed
 * positive predictive power), fall back to `fallbackWeights` (DEFAULT_SCORING_WEIGHTS)
 * unchanged. Date.now()-free.
 *
 * `shrinkage` (panel P2-4, default 0 = OFF → byte-identical): a λ in [0,1] that pulls the derived vector
 * toward `DEFAULT_SCORING_WEIGHTS` — `w_final = λ·w_IC + (1−λ)·w_default` — normalized so the result still
 * sums to 1. Damps a single high-IC factor on a thin fold. λ is clamped to [0,1]; the all-negative-IC
 * fallback path is unaffected (it already returns the defaults). λ=0 short-circuits to the unshrunk vector.
 */
export function deriveWeightsFromICs(
  ics: FactorIC[],
  fallbackWeights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  shrinkage: number = 0
): ScoringWeights {
  const floored = new Map<MarketFactor, number>();
  let total = 0;
  for (const { factor, ic } of ics) {
    const positive = Number.isFinite(ic) && ic > 0 ? ic : 0;
    floored.set(factor, positive);
    total += positive;
  }

  if (total <= 0) return { ...fallbackWeights };

  // Start from a full key set so every ScoringWeights field is present even if an IC
  // entry was missing for some factor (defensive — missing factor → 0 weight).
  const out = {} as ScoringWeights;
  for (const factor of MARKET_FACTORS) {
    out[factor] = (floored.get(factor) ?? 0) / total;
  }

  // P2-4: no shrinkage (λ<=0) → return the pure-IC vector unchanged (byte-identical default).
  const lambda = Number.isFinite(shrinkage) ? Math.max(0, Math.min(1, shrinkage)) : 0;
  if (lambda <= 0) return out;

  // Blend toward a normalized default prior, then renormalize the mix so it sums to 1.
  const defaultSum = MARKET_FACTORS.reduce((s, f) => s + (DEFAULT_SCORING_WEIGHTS[f] ?? 0), 0) || 1;
  const shrunk = {} as ScoringWeights;
  let mixTotal = 0;
  for (const factor of MARKET_FACTORS) {
    const prior = (DEFAULT_SCORING_WEIGHTS[factor] ?? 0) / defaultSum;
    const blended = lambda * out[factor] + (1 - lambda) * prior;
    shrunk[factor] = blended;
    mixTotal += blended;
  }
  if (mixTotal <= 0) return out;
  for (const factor of MARKET_FACTORS) shrunk[factor] = shrunk[factor] / mixTotal;
  return shrunk;
}

// --- internal helpers (pure unless noted) -------------------------------------------

function parseSnapshot(row: SignalSnapshotAuditRow): { snapshotDate: string; signals: NonNullable<SignalSnapshotPayload["signals"]> } | undefined {
  const payload = row.payload as SignalSnapshotPayload | undefined;
  if (!payload || !Array.isArray(payload.signals)) return undefined;
  // Prefer the snapshot's own asOf; fall back to the audit row's createdAt. The date is
  // derived in America/New_York (marketDateOf), NOT the UTC day: an after-hours ET snapshot
  // (e.g. Mon 19:30 ET = Tue 00:30 UTC) belongs to Monday's market day — slicing the UTC ISO
  // string shifted those snapshots one session forward (same fix as counterfactual-learning's
  // targetBusinessDate; Codex review on PR #365). Bar dates elsewhere keep toBusinessDay:
  // daily-OHLC bar times at UTC midnight ARE the date and must not be timezone-shifted.
  const snapshotDate =
    (typeof payload.asOf === "string" ? marketDateOf(payload.asOf) : undefined) ?? marketDateOf(row.createdAt);
  if (!snapshotDate) return undefined;
  return { snapshotDate, signals: payload.signals };
}

/** Sub-scores from a factorBreakdown, excluding `weightedTotal`. Undefined if unusable. */
function extractSubScores(breakdown?: MarketFactorBreakdown): Record<MarketFactor, number> | undefined {
  if (!breakdown) return undefined;
  const out = {} as Record<MarketFactor, number>;
  let any = false;
  for (const factor of MARKET_FACTORS) {
    const value = Number(breakdown[factor]);
    if (Number.isFinite(value)) {
      out[factor] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Shared with counterfactual-learning's `targetBusinessDate`: snapshot day + N TRADING
 * days (see `market-calendar.addTradingDays`), not N calendar days. Prior to 2026-07 this
 * added `horizonDays * 86_400_000` ms of calendar time under a "business date" name, so a
 * Friday snapshot matured after only 3 trading sessions while a Monday one matured after
 * the full 5 — see docs/rollouts/2026-07-04-w1-learning-loops.md for the discontinuity note.
 * The anchor date resolves via `marketDateOf` (America/New_York for timestamps, passthrough
 * for date-only strings) so after-hours snapshots stay on their market day.
 */
function targetBusinessDate(snapshotDate: string, horizonDays: number): string {
  const normalized = marketDateOf(snapshotDate);
  if (!normalized) return snapshotDate;
  return addTradingDays(normalized, horizonDays);
}

/** First daily close on/after `targetDate`. Undefined → not matured (never fabricate). */
function selectExitClose(bars: OHLCBar[], targetDate: string): number | undefined {
  const exit = bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
    .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((bar) => bar.date >= targetDate);
  return exit?.close;
}

/**
 * Tie-corrected Spearman rank IC: Pearson correlation of the average ranks of `xs` and
 * `ys`. Returns undefined when either side has zero variance after ranking (correlation
 * undefined). Assumes xs.length === ys.length >= 2. Exported for the signal-health
 * monitor (src/lib/signal-health.ts) — one rank-IC implementation, not two.
 */
export function spearmanRankIC(xs: number[], ys: number[]): number | undefined {
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  return pearson(rx, ry);
}

/** Average ranks (1-based), ties sharing the mean of the positions they span. Pure. */
function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    // positions i..j (0-based) → ranks (i+1)..(j+1); average them
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].index] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; undefined if either series has zero variance. Pure. */
function pearson(xs: number[], ys: number[]): number | undefined {
  const n = xs.length;
  if (n < 2) return undefined;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return undefined;
  return cov / Math.sqrt(vx * vy);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

// =============================================================================
// Walk-forward OOS validation
// =============================================================================

/** A single point on the cumulative equity curve. */
export interface EquityCurvePoint {
  date: string;
  nNames: number;
  /** Mean net return of the top-K names on this date (cost+tax adjusted). */
  periodReturn: number;
  /** SPY forward return over the same horizon (null = SPY data unavailable). */
  benchmarkReturn: number | null;
  /** Compounded strategy return since the first OOS date (fraction; 0.12 = +12%). */
  cumulativeReturn: number;
  /** Compounded SPY return since first OOS date (null if no SPY data). */
  benchmarkCumulativeReturn: number | null;
}

/** Options for a full walk-forward OOS run — extends the observation-build options. */
export interface OOSRunOptions extends BuildFactorObservationsOptions {
  /** Fraction of unique snapshot dates used for training IC derivation. Default 0.7. */
  trainFraction?: number;
  /** Estimated total round-trip transaction cost in basis points. Default OOS_ROUND_TRIP_COST_BPS (20 = 10 bps/leg). */
  costRoundTripBps?: number;
  /** Short-term capital-gains tax rate applied to positive OOS returns. Default 0.24. */
  taxRate?: number;
  /** Number of top-ranked names per date included in the simulated long portfolio. Default 3. */
  topK?: number;
  /**
   * Candidate scoring weights to validate OOS — e.g. a tuning proposal's proposed weights merged
   * over the current policy. When supplied, the result includes `oosICCandidate`: the OOS composite
   * IC of THESE weights. This is what lets the tuning gate validate the actual PROPOSED weights
   * rather than the data-derived IC weights (which `oosIC` measures).
   */
  candidateWeights?: ScoringWeights;
  /**
   * Baseline weights the candidate is compared against — e.g. the current policy weights (the
   * status quo a proposal would replace). When supplied, the result includes `oosICBaseline`.
   */
  baselineWeights?: ScoringWeights;
  /**
   * P1-2 (default false): apply the PURGE side of the purged-&-embargoed split — drop train-date buckets whose
   * forward window overlaps the first test date. Off → embargo-only (byte-identical to today).
   */
  purgeEmbargo?: boolean;
  /**
   * P2-4 (default 0 = OFF): shrinkage λ pulling the data-derived `icWeights` toward `DEFAULT_SCORING_WEIGHTS`.
   * Only affects the `icWeights`/`oosIC` report path; the candidate/baseline composite ICs are unchanged.
   */
  icWeightShrinkage?: number;
}

/** Full walk-forward OOS validation result. */
export interface OOSResult {
  trainObservations: number;
  testObservations: number;
  trainDates: number;
  testDates: number;
  /**
   * qlib walk-forward window report: the exact chronological folds this result was computed on.
   * Consumers that gate a candidate on this result should surface these dates — a validation is
   * only as honest as the window it held out is visible.
   */
  window: OOSWindowReport;
  trainICs: FactorIC[];
  icWeights: ScoringWeights;
  /** Mean cross-sectional IC of the IC-weighted composite score on OOS dates. */
  oosIC: number;
  /** OOS composite IC of `options.candidateWeights` (the proposed weights), when supplied. */
  oosICCandidate?: number;
  /** OOS composite IC of `options.baselineWeights` (the status-quo weights), when supplied. */
  oosICBaseline?: number;
  /**
   * Paired per-date IC-difference statistics (candidate − baseline) over the SAME OOS test fold.
   * Present only when BOTH `candidateWeights` and `baselineWeights` are supplied. This is the correct
   * SE source for a significance test on the candidate-vs-baseline edge (the two ICs are correlated
   * because they share the same fold), used by the autonomous paired-t gate (panel P0-2).
   */
  pairedICDiff?: PairedICDiffStats;
  /**
   * P2-5: OOS max-drawdown (%) of a top-K equity curve built under `candidateWeights` / `baselineWeights`,
   * on the SAME test fold + top-K + SPY inputs as the main curve. Present only when the respective weight
   * vector is supplied. Lets the autonomous drawdown guard refuse a candidate that spikes drawdown vs the
   * baseline. Distinct from `maxDrawdownPct`, which is off the data-derived `icWeights` curve.
   */
  candidateMaxDrawdownPct?: number;
  baselineMaxDrawdownPct?: number;
  /**
   * OOS IC information ratio (mean / sample-std of per-date ICs).
   * Values > 0.5 are conventionally considered evidence of a real signal.
   */
  oosICIR: number;
  /** OOS composite IC using the default hand-tuned weights — baseline to beat. */
  oosICDefault: number;
  equityCurve: EquityCurvePoint[];
  /** Annualized strategy return over the OOS period (null when <2 OOS dates). */
  annualizedReturn: number | null;
  /** Annualized SPY return over same period (null when no SPY data). */
  benchmarkAnnualizedReturn: number | null;
  /** annualizedReturn − benchmarkAnnualizedReturn. */
  activeReturn: number | null;
  /** Annualized Sharpe ratio of the OOS strategy (null when all periods equal). */
  sharpeRatio: number | null;
  /** Max peak-to-trough drawdown of the OOS equity curve (expressed as %). */
  maxDrawdownPct: number;
  note: string;
}

/**
 * qlib walk-forward window report (docs/oss-lessons.md §6 slice 3): the exact chronological folds
 * an OOS result was computed on, so a consumer can SEE — and disclose — what was held out.
 */
export interface OOSWindowReport {
  /** First/last unique snapshot date in the train fold (after any purge). */
  trainStartDate: string;
  trainEndDate: string;
  /** Unique dates embargoed between the train fold and the surviving test fold. */
  embargoDates: number;
  /** Unique train-side dates dropped by the P1-2 purge (0 when purge is off). */
  purgedTrainDates: number;
  /** First/last unique snapshot date in the surviving (held-out) test fold. */
  testStartDate: string;
  testEndDate: string;
}

/** PURE. Compact one-clause rendering of the window report for readouts/cautions. */
export function formatOosWindow(window: OOSWindowReport, testDates: number, trainDates: number): string {
  return (
    `held-out window ${window.testStartDate}→${window.testEndDate} (${testDates} dates; ` +
    `train ${window.trainStartDate}→${window.trainEndDate}, ${trainDates} dates; ` +
    `embargo ${window.embargoDates}, purge ${window.purgedTrainDates})`
  );
}

/** Extra split controls (panel P1-2). All default-preserving. */
export interface SplitWalkForwardOptions {
  /**
   * PURGE (default false): additionally drop the LAST `horizonDays` train-date buckets — the train rows
   * closest to the boundary whose forward-return window `[date, date+horizonDays]` overlaps the first test
   * date and therefore share realized bars with the test fold (leakage that inflates OOS IC). Off by default →
   * the split is byte-identical to today's embargo-only behavior. Applied in unique-snapshot-date terms, not
   * calendar days, matching how the embargo already trims the test side.
   */
  purge?: boolean;
}

/**
 * PURE. Chronological walk-forward split: the first `trainFraction` of unique sorted snapshot
 * dates become the train set; the rest become the test set. Order within each group is preserved.
 *
 * `horizonDays` (default 0) EMBARGOES the first `horizonDays` test-date buckets after the boundary (they
 * would share realized bars with the tail of the train fold). This embargo predates the P1-2 flag and is
 * always applied. The optional `purge` (panel P1-2, default OFF) additionally removes the train-side rows
 * whose forward window straddles the boundary — see `SplitWalkForwardOptions`. With `purge` unset the result
 * is byte-identical to the prior two/three-argument behavior.
 */
export function splitWalkForward(
  observations: FactorObservation[],
  trainFraction: number = 0.7,
  horizonDays: number = 0,
  options: SplitWalkForwardOptions = {}
): { train: FactorObservation[]; test: FactorObservation[]; boundary: WalkForwardBoundary } {
  const dates = [...new Set(observations.map((o) => o.date))].sort();
  if (dates.length < 2) {
    return {
      train: observations,
      test: [],
      boundary: { totalDates: dates.length, cutIdx: 0, trainCutIdx: 0, testCutIdx: dates.length }
    };
  }
  const cutIdx = Math.max(1, Math.floor(dates.length * trainFraction));

  // PURGE (P1-2, opt-in): the train rows whose forward-return window overlaps the first test date are the
  // last `horizonDays` train-date buckets. Dropping them removes the train↔test bar-overlap leakage. At least
  // one train date is always kept. Default OFF → trainDates spans the full [0, cutIdx) prefix as before.
  const purgeCount = options.purge ? Math.max(0, Math.min(cutIdx - 1, horizonDays)) : 0;
  const trainCutIdx = cutIdx - purgeCount;
  const trainDates = new Set(dates.slice(0, trainCutIdx));

  // EMBARGO (predates P1-2): remove the first `horizonDays` test-date buckets after the training fold's end.
  const testCutIdx = Math.min(cutIdx + horizonDays, dates.length);
  const testDates = new Set(dates.slice(testCutIdx));

  return {
    train: observations.filter((o) => trainDates.has(o.date)),
    test: observations.filter((o) => testDates.has(o.date)),
    boundary: { totalDates: dates.length, cutIdx, trainCutIdx, testCutIdx }
  };
}

/** Exact fold-boundary indices (into the sorted unique-date array) a split produced — the qlib-style
 *  walk-forward window report's raw material. */
export interface WalkForwardBoundary {
  totalDates: number;
  /** Index where the test side would start before the embargo. */
  cutIdx: number;
  /** First train-side index dropped by the P1-2 purge (= cutIdx when purge is off). */
  trainCutIdx: number;
  /** First surviving test-side index after the always-on embargo. */
  testCutIdx: number;
}

/**
 * PURE. Adjust forward returns for round-trip transaction cost and short-term tax drag.
 * Cost is always debited (positive or negative gross return). Tax is applied only to
 * positive after-cost returns: net = (gross − cost) × (1 − taxRate).
 */
export function adjustReturns(
  observations: FactorObservation[],
  options: { costRoundTripBps?: number; taxRate?: number } = {}
): FactorObservation[] {
  const costFrac = (options.costRoundTripBps ?? OOS_ROUND_TRIP_COST_BPS) / 1e4;
  const taxRate = options.taxRate ?? 0.24;
  return observations.map((obs) => {
    const afterCost = obs.forwardReturn - costFrac;
    const taxDrag = afterCost > 0 ? afterCost * taxRate : 0;
    return { ...obs, forwardReturn: afterCost - taxDrag };
  });
}

/** PURE. Weighted-sum composite score for one observation. */
function compositeScore(obs: FactorObservation, weights: ScoringWeights): number {
  let score = 0;
  for (const factor of MARKET_FACTORS) {
    score += (weights[factor] ?? 0) * (obs.subScores[factor] ?? 0);
  }
  return score;
}

/**
 * PURE. Compute the IC of a single composite (weighted-sum) score column vs forward return,
 * per date, then average across dates. Returns meanIC and ICIR (mean / sample-std), which
 * is the primary signal-quality summary for a composite predictor.
 */
export function computeCompositeIC(
  observations: FactorObservation[],
  weights: ScoringWeights
): { meanIC: number; icIR: number } {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  const perDateICs: number[] = [];
  for (const group of byDate.values()) {
    const scores: number[] = [];
    const returns: number[] = [];
    for (const obs of group) {
      const s = compositeScore(obs, weights);
      const r = obs.forwardReturn;
      if (Number.isFinite(s) && Number.isFinite(r)) {
        scores.push(s);
        returns.push(r);
      }
    }
    if (scores.length < 2) continue;
    const ic = spearmanRankIC(scores, returns);
    if (ic !== undefined) perDateICs.push(ic);
  }

  if (perDateICs.length === 0) return { meanIC: 0, icIR: 0 };
  const n = perDateICs.length;
  const mean = perDateICs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { meanIC: mean, icIR: 0 };
  const sampleVar = perDateICs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(sampleVar);
  return { meanIC: mean, icIR: std > 0 ? mean / std : 0 };
}

/** Paired per-date IC-difference statistics for candidate-vs-baseline weights (panel P0-2). */
export interface PairedICDiffStats {
  /** Number of dates that produced a valid IC for BOTH weight vectors (the paired sample size). */
  n: number;
  /** Mean of the per-date (candidateIC − baselineIC) series. */
  meanDiff: number;
  /** Sample standard deviation of the per-date difference series (n−1 denominator). */
  stdDiff: number;
  /** Standard error of the mean difference (stdDiff / sqrt(n)). */
  seDiff: number;
  /**
   * Paired t-statistic: meanDiff / seDiff. Positive ⇒ candidate beats baseline. Special cases:
   *  - `n < 2` → 0 (no SE from one point);
   *  - ZERO variance with a NONZERO mean (every date's diff is the same nonzero value) → ±Infinity,
   *    NOT 0: a candidate that UNIFORMLY beats baseline is, in the limit, infinitely significant. Treating
   *    that as 0 would wrongly reject the strongest possible edge;
   *  - zero variance with a zero mean → 0 (truly no difference).
   */
  tStat: number;
}

/**
 * PURE (panel P0-2). Compute the PAIRED per-date IC-difference series between two weight vectors on
 * the SAME observations, then summarize it. Because both composite ICs are measured on the identical
 * test fold and are highly correlated, the difference's standard error MUST come from this paired
 * per-date difference series — NOT from differencing two independently-estimated ICIRs. Only dates that
 * yield a finite IC for BOTH vectors contribute a paired point (a date with <2 valid names for either
 * side is dropped from the pair). Returns `n=0` stats when no date pairs.
 */
export function pairedICDiffStats(
  observations: FactorObservation[],
  candidateWeights: ScoringWeights,
  baselineWeights: ScoringWeights
): PairedICDiffStats {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  const diffs: number[] = [];
  for (const group of byDate.values()) {
    const candScores: number[] = [];
    const baseScores: number[] = [];
    const returns: number[] = [];
    for (const obs of group) {
      const cs = compositeScore(obs, candidateWeights);
      const bs = compositeScore(obs, baselineWeights);
      const r = obs.forwardReturn;
      if (Number.isFinite(cs) && Number.isFinite(bs) && Number.isFinite(r)) {
        candScores.push(cs);
        baseScores.push(bs);
        returns.push(r);
      }
    }
    if (returns.length < 2) continue;
    const candIC = spearmanRankIC(candScores, returns);
    const baseIC = spearmanRankIC(baseScores, returns);
    if (candIC === undefined || baseIC === undefined) continue;
    diffs.push(candIC - baseIC);
  }

  const n = diffs.length;
  if (n === 0) return { n: 0, meanDiff: 0, stdDiff: 0, seDiff: 0, tStat: 0 };
  const meanDiff = diffs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { n, meanDiff, stdDiff: 0, seDiff: 0, tStat: 0 };
  const sampleVar = diffs.reduce((s, x) => s + (x - meanDiff) ** 2, 0) / (n - 1);
  const stdDiff = Math.sqrt(sampleVar);
  const seDiff = stdDiff / Math.sqrt(n);
  // Zero variance: if the mean is nonzero (every date's diff is the same nonzero value — a candidate that
  // UNIFORMLY beats or lags baseline), the t-stat is infinite (Math.sign gives its direction). Only a truly
  // zero mean-difference yields 0. Otherwise the standard meanDiff/seDiff.
  const tStat = seDiff > 0
    ? meanDiff / seDiff
    : (meanDiff === 0 ? 0 : Math.sign(meanDiff) * Infinity);
  return { n, meanDiff, stdDiff, seDiff, tStat };
}

/**
 * PURE. Build an equity curve: on each OOS date (chronological), score all names with
 * `weights`, select the top-K, compute their mean net return as the period return, and
 * compound cumulatively. Benchmark (SPY) returns are compounded in parallel.
 *
 * Note: overlapping holding periods (e.g. daily snapshots with a 5-day horizon) are
 * treated as independent cross-sections per standard IC-backtest convention — each date
 * represents one equal-weighted investment decision, not a physically non-overlapping trade.
 */
export function buildEquityCurve(
  oosObservations: FactorObservation[],
  weights: ScoringWeights,
  spyReturnByDate: Map<string, number>,
  topK: number = 3
): EquityCurvePoint[] {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of oosObservations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  const sortedDates = [...byDate.keys()].sort();
  const curve: EquityCurvePoint[] = [];
  let cumStrategy = 1.0;
  let cumBenchmark: number | null = null;

  for (const date of sortedDates) {
    const group = byDate.get(date)!;
    const scored = group
      .map((obs) => ({ obs, score: compositeScore(obs, weights) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((a, b) => b.score - a.score);

    const topGroup = scored.slice(0, topK);
    if (topGroup.length === 0) continue;

    const periodReturn = topGroup.reduce((s, { obs }) => s + obs.forwardReturn, 0) / topGroup.length;
    const benchmarkReturn = spyReturnByDate.has(date) ? (spyReturnByDate.get(date) as number) : null;

    cumStrategy *= 1 + periodReturn;
    if (benchmarkReturn !== null) {
      cumBenchmark = (cumBenchmark ?? 1.0) * (1 + benchmarkReturn);
    }

    curve.push({
      date,
      nNames: topGroup.length,
      periodReturn,
      benchmarkReturn,
      cumulativeReturn: cumStrategy - 1,
      benchmarkCumulativeReturn: cumBenchmark !== null ? cumBenchmark - 1 : null
    });
  }

  return curve;
}

/**
 * PURE (panel P2-5). Max peak-to-trough drawdown (as a %) of an equity curve's cumulative-return path.
 * Mirrors the inline calculation `runWalkForwardOOS` uses for the main curve. Returns 0 for an empty curve.
 */
export function maxDrawdownOfCurve(curve: EquityCurvePoint[]): number {
  let peak = 1.0;
  let maxDd = 0;
  for (const pt of curve) {
    const equity = 1 + pt.cumulativeReturn;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

/**
 * NOT EXPORTED. Fetch SPY OHLC and compute forward returns for each supplied date.
 * Uses the same selectExitClose + targetBusinessDate logic as buildFactorObservations.
 * Returns an empty Map if SPY bars are unavailable.
 */
async function buildSpyReturnMap(
  dates: string[],
  horizonDays: number,
  now: number,
  fetchOHLC: BacktestOHLCFetcher
): Promise<Map<string, number>> {
  const spyBars = await fetchOHLC("SPY", now);
  if (!spyBars || spyBars.length === 0) return new Map();

  const result = new Map<string, number>();
  for (const date of dates) {
    const entryClose = selectExitClose(spyBars, date);
    if (entryClose === undefined) continue;
    const exitClose = selectExitClose(spyBars, targetBusinessDate(date, horizonDays));
    if (exitClose === undefined) continue;
    result.set(date, (exitClose - entryClose) / entryClose);
  }
  return result;
}

/**
 * EXPORTED (panel B4). SPY % return (as a fraction) from each snapshot business-day to `now`, over the SAME
 * variable window a skipped-candidate return uses (entry snapshot date → current price). Reuses the single
 * SPY OHLC fetch + `selectExitClose` machinery (no hand-rolled 2nd fetch). A date with no SPY bar at/before
 * `now` or at/after the entry date is OMITTED — the caller must treat a missing entry as "exclude", never
 * fall back to a raw >0 test. Returns an empty Map when SPY is unavailable.
 */
export async function buildSpyReturnToNowMap(
  dates: string[],
  now: number = Date.now(),
  fetchOHLC: BacktestOHLCFetcher = fetchDailyOHLC
): Promise<Map<string, number>> {
  const spyBars = await fetchOHLC("SPY", now);
  if (!spyBars || spyBars.length === 0) return new Map();
  const nowDate = new Date(now).toISOString().slice(0, 10);
  const result = new Map<string, number>();
  for (const date of new Set(dates)) {
    const entryClose = selectExitClose(spyBars, date);
    if (entryClose === undefined || !(entryClose > 0)) continue;
    // Exit = the last SPY close at/before "now" (mirrors the skipped-candidate "current price" endpoint).
    const exitClose = selectExitClose(spyBars, nowDate) ?? lastCloseAtOrBefore(spyBars, nowDate);
    if (exitClose === undefined || !(exitClose > 0)) continue;
    result.set(date, (exitClose - entryClose) / entryClose);
  }
  return result;
}

/** Last usable SPY close at/before a date (fallback endpoint when no bar lands exactly on/after "now"). */
function lastCloseAtOrBefore(bars: OHLCBar[], date: string): number | undefined {
  const dated = bars
    .map((b) => ({ d: toBusinessDayLocal(b.time), c: b.close }))
    .filter((b): b is { d: string; c: number } => Boolean(b.d) && typeof b.c === "number" && b.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  const before = dated.filter((b) => b.d <= date);
  return before.length > 0 ? before[before.length - 1].c : undefined;
}

function toBusinessDayLocal(time: number | string | undefined): string | undefined {
  if (time === undefined) return undefined;
  const d = typeof time === "number" ? new Date(time) : new Date(time);
  const iso = d.toISOString();
  return Number.isNaN(d.getTime()) ? undefined : iso.slice(0, 10);
}

/**
 * Where the OOS test fold begins for evidence-cutoff purposes (§6 slice-3 follow-up —
 * time-bounded proposal evidence). Everything the tuner sees must be realized BEFORE this date
 * or the candidate is partly fitted on evaluation-period outcomes.
 */
export interface OOSEvidenceCutoff {
  /** First surviving held-out (test-fold) snapshot date. Evidence realized before this date is PIT-clean. */
  cutoffDate: string;
  /** Last train-fold snapshot date. */
  trainEndDate: string;
  /** Unique matured snapshot dates considered (after the audit-limit window). */
  totalDates: number;
}

/**
 * IO-lite (audit read only, NO OHLC fetches). Computes where `runWalkForwardOOS`'s surviving test
 * fold STARTS, so `proposeStrategyTuning` can cut its evidence off there — the definitive fix for
 * the "partially in-sample" caveat: candidate weights are then generated WITHOUT seeing
 * evaluation-period outcomes.
 *
 * Replicates the fold arithmetic on the same signal_snapshot source with the same defaults
 * (horizonDays, auditLimit, trainFraction 0.7, embargo = horizonDays date-buckets), restricted to
 * MATURED dates (forward window fully elapsed) to mirror what buildFactorObservations can resolve.
 * Approximation: the actual fold uses dates with resolved per-symbol observations; a date bucket
 * whose symbols all fail to resolve shifts the real fold slightly. Bias is acceptable for an
 * evidence filter — and when in doubt, less-recent evidence is the safe side. Returns undefined
 * when no surviving test fold exists (< 4 matured dates, or the embargo swallows the tail) — the
 * caller then applies no cutoff (and keeps the partially-in-sample caveat).
 */
export function computeOosEvidenceCutoff(
  userId: string = "local",
  options: {
    horizonDays?: number;
    auditLimit?: number;
    trainFraction?: number;
    now?: number;
    connectedAccountId?: string;
  } = {}
): OOSEvidenceCutoff | undefined {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const trainFraction = Math.max(0.5, Math.min(0.9, options.trainFraction ?? 0.7));

  const rows = listSignalSnapshotAuditAfter(userId, undefined, auditLimit, options.connectedAccountId);
  const today = marketDateOf(new Date(now).toISOString());
  const dates = [
    ...new Set(
      rows
        .map((row) => parseSnapshot(row)?.snapshotDate)
        .filter((d): d is string => Boolean(d))
        // Maturity mirror: only dates whose forward window has fully elapsed can resolve.
        .filter((d) => !today || targetBusinessDate(d, horizonDays) <= today)
    )
  ].sort();
  if (dates.length < 4) return undefined;

  const cutIdx = Math.max(1, Math.floor(dates.length * trainFraction));
  const testCutIdx = Math.min(cutIdx + horizonDays, dates.length);
  if (testCutIdx >= dates.length) return undefined; // embargo swallows the tail → no surviving fold
  return { cutoffDate: dates[testCutIdx], trainEndDate: dates[cutIdx - 1], totalDates: dates.length };
}

/**
 * IO. Walk-forward out-of-sample validation.
 *
 * 1. Builds factor observations from the `signal_snapshot` audit log.
 * 2. Splits chronologically: train (default 70%) / test (30%).
 * 3. Derives IC weights from the train period.
 * 4. Measures OOS composite IC + ICIR of those IC weights vs the test period.
 * 5. Compares against the default (hand-tuned) weights as a baseline.
 * 6. Builds a cost+tax-adjusted equity curve for the test period, with SPY benchmark.
 *
 * Returns null when fewer than 4 unique snapshot dates are available — insufficient
 * to perform a meaningful split.
 */
export async function runWalkForwardOOS(
  userId: string = "local",
  options: OOSRunOptions = {}
): Promise<OOSResult | null> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const trainFraction = Math.max(0.5, Math.min(0.9, options.trainFraction ?? 0.7));
  const topK = boundedInteger(options.topK ?? 3, 1, 20, 3);
  const costRoundTripBps = options.costRoundTripBps ?? OOS_ROUND_TRIP_COST_BPS;
  const taxRate = options.taxRate ?? 0.24;
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const rawObservations = await buildFactorObservations(userId, {
    horizonDays,
    auditLimit,
    now,
    fetchOHLC,
    connectedAccountId: options.connectedAccountId
  });

  const uniqueDates = [...new Set(rawObservations.map((o) => o.date))].sort();
  if (uniqueDates.length < 4) return null;

  // P1-2: the purge is opt-in via `purgeEmbargo`; the embargo (`horizonDays`) is always applied. Default OFF
  // → byte-identical split. Fails safe: purging shrinks the train sample, which can only strip weights.
  const { train, test, boundary } = splitWalkForward(rawObservations, trainFraction, horizonDays, { purge: options.purgeEmbargo ?? false });
  if (train.length === 0 || test.length === 0) return null;

  const trainICs = computeFactorICs(train);
  // P2-4: optional shrinkage toward the default prior (default 0 = pure-IC vector, unchanged).
  const icWeights = deriveWeightsFromICs(trainICs, DEFAULT_SCORING_WEIGHTS, options.icWeightShrinkage ?? 0);

  const adjustedTest = adjustReturns(test, { costRoundTripBps, taxRate });

  const { meanIC: oosIC, icIR: oosICIR } = computeCompositeIC(adjustedTest, icWeights);
  const { meanIC: oosICDefault } = computeCompositeIC(adjustedTest, DEFAULT_SCORING_WEIGHTS);
  // Validate the ACTUAL proposed/candidate weights (and the status-quo baseline) against the same
  // held-out test fold, so callers can gate on whether the candidate beats what's running today —
  // not on whether the data-derived IC weights beat default (which `oosIC` measures).
  const oosICCandidate = options.candidateWeights
    ? computeCompositeIC(adjustedTest, options.candidateWeights).meanIC
    : undefined;
  const oosICBaseline = options.baselineWeights
    ? computeCompositeIC(adjustedTest, options.baselineWeights).meanIC
    : undefined;
  // Panel P0-2: when BOTH candidate and baseline weights are supplied, compute the paired per-date IC
  // difference series on the same fold. Its SE (not a difference of independent ICIRs) is the correct
  // basis for a significance test on the candidate-vs-baseline edge.
  const pairedICDiff = options.candidateWeights && options.baselineWeights
    ? pairedICDiffStats(adjustedTest, options.candidateWeights, options.baselineWeights)
    : undefined;

  const oosDates = [...new Set(adjustedTest.map((o) => o.date))];
  const spyReturnByDate = await buildSpyReturnMap(oosDates, horizonDays, now, fetchOHLC);

  const equityCurve = buildEquityCurve(adjustedTest, icWeights, spyReturnByDate, topK);

  // P2-5: candidate/baseline OOS max-drawdown on the SAME fold + top-K + SPY inputs. Built only when the
  // respective weight vector is supplied (autonomous path passes both). Reuses the pure buildEquityCurve.
  const candidateMaxDrawdownPct = options.candidateWeights
    ? maxDrawdownOfCurve(buildEquityCurve(adjustedTest, options.candidateWeights, spyReturnByDate, topK))
    : undefined;
  const baselineMaxDrawdownPct = options.baselineWeights
    ? maxDrawdownOfCurve(buildEquityCurve(adjustedTest, options.baselineWeights, spyReturnByDate, topK))
    : undefined;

  let annualizedReturn: number | null = null;
  let benchmarkAnnualizedReturn: number | null = null;
  let activeReturn: number | null = null;
  let sharpeRatio: number | null = null;
  let maxDrawdownPct = 0;

  if (equityCurve.length >= 2) {
    const firstTs = Date.parse(equityCurve[0].date);
    const lastTs = Date.parse(equityCurve[equityCurve.length - 1].date);
    const calendarDays = Math.max(1, (lastTs - firstTs) / DAY_MS);
    const annualFactor = 365 / calendarDays;
    const last = equityCurve[equityCurve.length - 1];

    annualizedReturn = Math.pow(1 + last.cumulativeReturn, annualFactor) - 1;

    if (last.benchmarkCumulativeReturn !== null) {
      benchmarkAnnualizedReturn = Math.pow(1 + last.benchmarkCumulativeReturn, annualFactor) - 1;
      activeReturn = annualizedReturn - benchmarkAnnualizedReturn;
    }

    const rets = equityCurve.map((p) => p.periodReturn);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sampleVar = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    const std = Math.sqrt(sampleVar);
    if (std > 0) sharpeRatio = (mean / std) * Math.sqrt(252 / horizonDays);

    let peak = 1.0;
    for (const pt of equityCurve) {
      const equity = 1 + pt.cumulativeReturn;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
    maxDrawdownPct *= 100;
  }

  const trainDates = new Set(train.map((o) => o.date)).size;
  const testDates = new Set(adjustedTest.map((o) => o.date)).size;

  // qlib window report (§6 slice 3): exact fold dates, straight from the split boundary indices —
  // a gate consumer can show WHAT was held out, not just that something was.
  const trainUnique = [...new Set(train.map((o) => o.date))].sort();
  const testUnique = [...new Set(adjustedTest.map((o) => o.date))].sort();
  const window: OOSWindowReport = {
    trainStartDate: trainUnique[0],
    trainEndDate: trainUnique[trainUnique.length - 1],
    embargoDates: boundary.testCutIdx - boundary.cutIdx,
    purgedTrainDates: boundary.cutIdx - boundary.trainCutIdx,
    testStartDate: testUnique[0],
    testEndDate: testUnique[testUnique.length - 1]
  };

  return {
    trainObservations: train.length,
    testObservations: adjustedTest.length,
    trainDates,
    testDates,
    window,
    trainICs,
    icWeights,
    oosIC,
    oosICIR,
    oosICDefault,
    oosICCandidate,
    oosICBaseline,
    pairedICDiff,
    candidateMaxDrawdownPct,
    baselineMaxDrawdownPct,
    equityCurve,
    annualizedReturn,
    benchmarkAnnualizedReturn,
    activeReturn,
    sharpeRatio,
    maxDrawdownPct,
    note: `Walk-forward: ${trainDates} train dates → IC weights; ${testDates} OOS dates (${costRoundTripBps}bps round-trip cost, ${Math.round(taxRate * 100)}% tax). Top-${topK} names/date.`
  };
}
