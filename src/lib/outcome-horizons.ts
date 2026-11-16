// outcome-horizons.ts — PURE multi-horizon forward-return math shared by the skipped-candidate
// counterfactual materializer (counterfactual-learning.ts) and the decision outcome engine
// (outcome-engine.ts). No I/O, no Date.now(): callers pass bars/quotes/now explicitly.
//
// Honesty contract (binding, from the composite expert review §A):
//  - A horizon row is written ONLY from real prices (daily closes via the cascade, or a live quote
//    actually sampled inside the horizon's tolerance window). Nothing is interpolated or fabricated.
//  - A horizon that CANNOT be measured becomes resolution 'unresolvable' with a reason — a terminal,
//    countable state (kill-survivorship) — never a silent drop and never a made-up number.
//  - All horizon arithmetic is TRADING days (market-calendar.addTradingDays), never calendar-ms.
//
// Benchmark basis (owner decision, r4): spyExcessPct is measured against the S&P 500 INDEX
// (^GSPC) by default, not the SPY ETF — SPY remains the automatic, honestly-labeled fallback when
// the index series is unavailable (see resolveBenchmarkSeries + outcome-engine.ts's
// resolveMarketBenchmark). Under policy.benchmarkMode === 'sector', a symbol grades against its
// own GICS sector index/ETF instead (sectorBenchmarkEntry) — market otherwise. Every row that
// carries spyExcessPct also carries `benchmarkBasis` disclosing exactly which ticker backed it
// (the field NAME spyExcessPct is kept as-is so existing history/dashboards aren't orphaned).
//
// LIVE-VERIFIED ticker table (query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1y&interval=1d
// — the exact request fetchYahoo() issues, the free/keyless tier every fetchDailyOHLC call can
// always reach; verified 2026-08-13):
//   ^GSPC (S&P 500 index)                    -> 252 daily bars. WORKS.
//   SPY   (S&P 500 ETF, existing fallback)    -> 252 daily bars. WORKS.
//   ^SP500-60 (Real Estate GICS sector index) -> 252 daily bars. WORKS — the only sector index that does.
//   ^SP500-45/-40/-35/-25/-30/-20/-50/-15/-55 (Technology/Financials/Health Care/Consumer
//     Discretionary/Consumer Staples/Industrials/Communication Services/Materials/Utilities),
//     and ^GSPE (Energy) -> exactly 1 bar each, every `range` tried (5d/1mo/6mo/1y): Yahoo's free
//     chart endpoint serves a live snapshot for these composite sub-indices but no historical
//     series, so fetchYahoo()'s `bars.length >= 2` guard returns null for all of them. EXCLUDED
//     from `SECTOR_BENCHMARK_TABLE`'s indexSymbol; grading falls straight to the sector ETF.
//   XLK/XLF/XLV/XLY/XLP/XLI/XLC/XLE/XLB/XLRE/XLU (the 11 sector SPDR ETFs) -> 251-252 daily bars
//     each. WORKS for every sector — the reliable fallback tier.
import { toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { addTradingDays } from "./market-calendar";
import type { OrderSide, SocraticOutcomeHorizonRow } from "./types";

/** Daily-close horizons: measured from the provider-cascade daily OHLC series. */
export const DAILY_HORIZONS: ReadonlyArray<{ horizon: "1d" | "1w"; tradingDays: number }> = [
  { horizon: "1d", tradingDays: 1 },
  { horizon: "1w", tradingDays: 5 }
];

/** Intraday horizons: resolvable ONLY by sampling a live quote while the tolerance window is open
 * (no intraday history source exists in the stack). Once the window closes unsampled, the row is
 * terminally 'unresolvable(no_intraday_source)'. The durable due-jobs substrate (db-jobs.ts +
 * outcome-engine.ts's drainDueIntradaySampleJobs) enqueues a 'sample_intraday_horizon' job at
 * basisAt+ms for each horizon below so sampling survives process downtime instead of depending on
 * a strategy run coincidentally landing inside the window. */
export const INTRADAY_HORIZONS: ReadonlyArray<{ horizon: "15m" | "1h"; ms: number; toleranceMs: number }> = [
  { horizon: "15m", ms: 15 * 60_000, toleranceMs: 30 * 60_000 },
  { horizon: "1h", ms: 60 * 60_000, toleranceMs: 60 * 60_000 }
];

/** caseKind used in a 'sample_intraday_horizon' job's dedupe_key / payload — identifies which
 * pipeline (placed decision case, blocked/rejected decision case, or skipped-candidate
 * counterfactual) owns the case identity carried in the payload. */
export type IntradaySampleJobCaseKind = "decision" | "counterfactual";

export interface IntradaySampleJobSpec {
  dedupeKey: string;
  dueAt: string;
  notAfter: string;
  payload: {
    caseKind: IntradaySampleJobCaseKind;
    caseId: string;
    /** The decision/signal-snapshot run this case belongs to. Carried explicitly (rather than
     * parsed back out of caseId) so the worker can look up the exact owning row without any
     * string-splitting assumption about caseId's shape. */
    runId?: string;
    symbol: string;
    horizon: "15m" | "1h";
    /** Only present for caseKind === 'counterfactual': the exact horizon_days the owning
     * skipped_candidate_counterfactuals row was inserted with (a run+symbol pair can have more than
     * one row across different horizons — this disambiguates instead of picking min(horizon_days)). */
    horizonDays?: number;
    basisPrice: number;
    basisAtMs: number;
    side?: OrderSide;
    priceBasisPrefix: string;
  };
}

/**
 * Pure builder for the pair of 'sample_intraday_horizon' due-job specs (one per INTRADAY_HORIZONS
 * entry) for a single decision case / counterfactual whose entry basis just became known. No I/O —
 * callers pass the resulting specs to enqueueDueJob (db-jobs.ts). dedupe_key is
 * `${caseKind}:${caseId}:${horizon}` so a re-established basis (e.g. a re-run) or a double call from
 * both the inline path and this enqueue path can never create a duplicate job row.
 */
export function buildIntradaySampleJobSpecs(input: {
  caseKind: IntradaySampleJobCaseKind;
  caseId: string;
  runId?: string;
  symbol: string;
  horizonDays?: number;
  basisPrice: number;
  basisAtMs: number;
  side?: OrderSide;
  priceBasisPrefix: string;
}): IntradaySampleJobSpec[] {
  if (!(input.basisPrice > 0) || !Number.isFinite(input.basisAtMs)) return [];
  return INTRADAY_HORIZONS.map(({ horizon, ms, toleranceMs }) => ({
    dedupeKey: `${input.caseKind}:${input.caseId}:${horizon}`,
    dueAt: new Date(input.basisAtMs + ms).toISOString(),
    notAfter: new Date(input.basisAtMs + ms + toleranceMs).toISOString(),
    payload: {
      caseKind: input.caseKind,
      caseId: input.caseId,
      ...(input.runId ? { runId: input.runId } : {}),
      symbol: input.symbol,
      ...(input.horizonDays !== undefined ? { horizonDays: input.horizonDays } : {}),
      horizon,
      basisPrice: input.basisPrice,
      basisAtMs: input.basisAtMs,
      ...(input.side ? { side: input.side } : {}),
      priceBasisPrefix: input.priceBasisPrefix
    }
  }));
}

/** Trading days PAST a horizon's target date after which a still-unresolved daily horizon is
 * terminal 'unresolvable' (bounded recheck window — delisted/renamed symbols stop pending forever). */
export const UNRESOLVABLE_AFTER_TRADING_DAYS = 10;

export interface NormalizedDailyBar {
  date: string;
  close: number;
}

/** Sorted (date asc) close-only view of an OHLC series; drops bars without a positive close. */
export function normalizeDailyBars(bars: OHLCBar[] | null | undefined): NormalizedDailyBar[] {
  if (!bars) return [];
  return bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: bar.close }))
    .filter((bar): bar is NormalizedDailyBar => Boolean(bar.date) && typeof bar.close === "number" && Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** First bar at/after `targetDate` (the point-in-time exit convention shared with backtest.ts). */
export function closeAtOrAfter(bars: NormalizedDailyBar[], targetDate: string): NormalizedDailyBar | undefined {
  return bars.find((bar) => bar.date >= targetDate);
}

/** Side-adjusted % (positive = the decided direction worked), mirroring returnSinceProposalPct. */
export function sideAdjustPct(rawPct: number, side?: OrderSide): number {
  return side === "sell" || side === "short" ? -rawPct : rawPct;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

// ── Benchmark series resolution (market + sector) ────────────────────────────────────────────
// Pure "prefer the index, fall back to the ETF" arithmetic; callers do the actual fetchDailyOHLC
// I/O (outcome-engine.ts, counterfactual-learning.ts) and hand both results in.

/** Market benchmark tickers — same fetchDailyOHLC cascade every other daily-bar consumer uses.
 * See the file header for the live-verified bar counts. */
export const MARKET_BENCHMARK_PRIMARY = "^GSPC";
export const MARKET_BENCHMARK_FALLBACK = "SPY";

export interface ResolvedBenchmark {
  bars: NormalizedDailyBar[];
  /** Honest disclosure of exactly which series backed this benchmark: the primary ticker as-is,
   * or "<ticker>(fallback)" when the primary series had fewer than 2 usable bars this run. */
  basis: string;
}

/**
 * Prefer `primary`'s bars; fall back to `fallback`'s when the primary series has fewer than 2
 * usable daily closes (fetch failure, delisted ticker, or — per the live verification above — a
 * GICS sector sub-index that Yahoo's free chart endpoint only ever serves one bar for). Pure;
 * returns undefined only when BOTH series are unusable (never fabricates a benchmark).
 */
export function resolveBenchmarkSeries(
  primary: { symbol: string; bars: NormalizedDailyBar[] | null | undefined },
  fallback: { symbol: string; bars: NormalizedDailyBar[] | null | undefined }
): ResolvedBenchmark | undefined {
  if (primary.bars && primary.bars.length >= 2) return { bars: primary.bars, basis: primary.symbol };
  if (fallback.bars && fallback.bars.length >= 2) return { bars: fallback.bars, basis: `${fallback.symbol}(fallback)` };
  return undefined;
}

export interface SectorBenchmarkEntry {
  /** GICS sector S&P 500 sub-index ticker. Present ONLY for sectors live-verified (file header,
   * 2026-08-13) to serve >=2 daily bars via the same Yahoo chart endpoint — today just Real
   * Estate. Undefined means "go straight to the ETF" for every other sector. */
  indexSymbol?: string;
  /** Sector SPDR ETF — live-verified for all 11 sectors; the honest fallback when indexSymbol is
   * unset or its live fetch comes back short (never fabricated). */
  etfSymbol: string;
}

const SECTOR_BENCHMARK_TABLE: Record<string, SectorBenchmarkEntry> = {
  technology: { etfSymbol: "XLK" },
  "financial services": { etfSymbol: "XLF" },
  healthcare: { etfSymbol: "XLV" },
  "consumer cyclical": { etfSymbol: "XLY" },
  "consumer defensive": { etfSymbol: "XLP" },
  industrials: { etfSymbol: "XLI" },
  "communication services": { etfSymbol: "XLC" },
  energy: { etfSymbol: "XLE" },
  "basic materials": { etfSymbol: "XLB" },
  "real estate": { indexSymbol: "^SP500-60", etfSymbol: "XLRE" },
  utilities: { etfSymbol: "XLU" }
};

/** Alternate spellings other providers/GICS use for the same 11 sectors above (Alpha Vantage
 * returns strict GICS names in caps, Finnhub/FMP vary too) -> the canonical lowercase key. */
const SECTOR_ALIASES: Record<string, string> = {
  "information technology": "technology",
  financials: "financial services",
  "health care": "healthcare",
  "consumer discretionary": "consumer cyclical",
  "consumer staples": "consumer defensive",
  materials: "basic materials"
};

/** Case-insensitive GICS/Yahoo sector name -> benchmark ticker(s) lookup. Returns undefined for an
 * unmapped/unknown/missing sector — callers fall back to the market benchmark for those (honest,
 * never a guess). */
export function sectorBenchmarkEntry(sector: string | undefined | null): SectorBenchmarkEntry | undefined {
  const key = sector?.trim().toLowerCase();
  if (!key) return undefined;
  return SECTOR_BENCHMARK_TABLE[SECTOR_ALIASES[key] ?? key];
}

export interface DailyHorizonInput {
  basisPrice: number;
  /** YYYY-MM-DD of the entry basis (fill date or snapshot date). */
  basisDate: string;
  side?: OrderSide;
  /** Daily series for the symbol; null = the fetch itself returned nothing (no series at all). */
  bars: NormalizedDailyBar[] | null;
  /** Resolved benchmark series (resolveBenchmarkSeries) + its honest basis label; omit/null to
   * skip spyExcessPct entirely (never fabricated). */
  benchmark?: ResolvedBenchmark | null;
  /** YYYY-MM-DD "today" — horizons whose target is beyond this are simply not yet due (omitted). */
  nowDate: string;
  /** Provenance prefix: "fill" | "ref_price" | "decision_day_close" ... */
  priceBasisPrefix: string;
  measuredAt: string;
}

/**
 * Compute 1d/1w horizon rows. Returns rows ONLY for horizons that are decidable now:
 *  - due + exit bar found            -> resolution 'ok'
 *  - due + no exit bar + past the bounded recheck window -> resolution 'unresolvable' (+reason)
 *  - not yet due, or due-but-awaiting-data inside the window -> omitted (caller retries later)
 */
export function computeDailyHorizonRows(input: DailyHorizonInput): SocraticOutcomeHorizonRow[] {
  const rows: SocraticOutcomeHorizonRow[] = [];
  if (!(input.basisPrice > 0)) return rows;
  const benchBars = input.benchmark?.bars ?? [];
  const benchEntry = benchBars.length > 0 ? closeAtOrAfter(benchBars, input.basisDate) : undefined;

  for (const { horizon, tradingDays } of DAILY_HORIZONS) {
    const targetDate = addTradingDays(input.basisDate, tradingDays);
    if (input.nowDate < targetDate) continue; // not yet due

    const exit = input.bars ? closeAtOrAfter(input.bars, targetDate) : undefined;
    if (exit) {
      const rawPct = ((exit.close - input.basisPrice) / input.basisPrice) * 100;
      const returnPct = round2(sideAdjustPct(rawPct, input.side));
      let spyExcessPct: number | undefined;
      let benchmarkBasis: string | undefined;
      const benchExit = benchEntry ? closeAtOrAfter(benchBars, targetDate) : undefined;
      if (benchEntry && benchExit && benchEntry.close > 0) {
        const benchRawPct = ((benchExit.close - benchEntry.close) / benchEntry.close) * 100;
        // Same side convention applied to the benchmark: a short is compared against shorting it.
        spyExcessPct = round2(returnPct - sideAdjustPct(benchRawPct, input.side));
        benchmarkBasis = input.benchmark?.basis;
      }
      rows.push({
        horizon,
        returnPct,
        ...(spyExcessPct !== undefined ? { spyExcessPct } : {}),
        ...(benchmarkBasis !== undefined ? { benchmarkBasis } : {}),
        maturedAt: input.measuredAt,
        // The exit bar can land AFTER the target date (halt/no-trade day); disclose the actual date.
        priceBasis: `${input.priceBasisPrefix}->daily_close(${exit.date})`,
        resolution: "ok"
      });
      continue;
    }

    // Due but unresolved: terminal only past the bounded recheck window, else retried next run.
    const unresolvableAfter = addTradingDays(targetDate, UNRESOLVABLE_AFTER_TRADING_DAYS);
    if (input.nowDate > unresolvableAfter) {
      rows.push({
        horizon,
        maturedAt: input.measuredAt,
        priceBasis: `${input.priceBasisPrefix}->daily_close`,
        resolution: "unresolvable",
        reason: !input.bars || input.bars.length === 0 ? "no_price_series" : "no_bar_at_or_after_target"
      });
    }
  }
  return rows;
}

export interface IntradayHorizonInput {
  basisPrice: number;
  /** Epoch ms of the entry basis (fill time or snapshot time). */
  basisAtMs: number;
  side?: OrderSide;
  nowMs: number;
  /** Live quote price sampled at `nowMs`, when the caller had a cheap sampling path. */
  quotePrice?: number;
  priceBasisPrefix: string;
  measuredAt: string;
}

/**
 * Compute 15m/1h horizon rows from an optionally-sampled live quote:
 *  - elapsed inside [horizon, horizon+tolerance] AND a quote was sampled -> 'ok' (actual elapsed
 *    minutes disclosed in priceBasis — this is a forward SAMPLE, not an exact-horizon bar)
 *  - elapsed past the tolerance window with no sample -> 'unresolvable(no_intraday_source)'
 *  - not yet due, or due-with-no-quote while the window is still open -> omitted (retry later)
 */
export function computeIntradayHorizonRows(input: IntradayHorizonInput): SocraticOutcomeHorizonRow[] {
  const rows: SocraticOutcomeHorizonRow[] = [];
  if (!(input.basisPrice > 0) || !Number.isFinite(input.basisAtMs)) return rows;
  const elapsedMs = input.nowMs - input.basisAtMs;

  for (const { horizon, ms, toleranceMs } of INTRADAY_HORIZONS) {
    if (elapsedMs < ms) continue; // not yet due
    const withinWindow = elapsedMs <= ms + toleranceMs;
    if (withinWindow && typeof input.quotePrice === "number" && input.quotePrice > 0) {
      const rawPct = ((input.quotePrice - input.basisPrice) / input.basisPrice) * 100;
      rows.push({
        horizon,
        returnPct: round2(sideAdjustPct(rawPct, input.side)),
        maturedAt: input.measuredAt,
        priceBasis: `${input.priceBasisPrefix}->live_quote(+${Math.round(elapsedMs / 60_000)}m)`,
        resolution: "ok"
      });
      continue;
    }
    if (!withinWindow) {
      rows.push({
        horizon,
        maturedAt: input.measuredAt,
        priceBasis: `${input.priceBasisPrefix}->live_quote`,
        resolution: "unresolvable",
        reason: "no_intraday_source"
      });
    }
    // due + window open + no quote: omitted, a later run inside the window may still sample it
  }
  return rows;
}

/** Longest resolved horizon that actually carries a benchmark figure wins the ALPHA headline:
 * 1w > 1d > 1h > 15m (mirrors pickHeadlineRow in outcome-engine.ts), but ONLY over rows with a
 * defined spyExcessPct — today that is the daily horizons; 15m/1h have no intraday SPY basis.
 * Returns undefined when no row qualifies (never fabricated). */
export function pickHeadlineAlpha(
  outcomes: SocraticOutcomeHorizonRow[] | undefined
): SocraticOutcomeHorizonRow | undefined {
  const priority: Array<SocraticOutcomeHorizonRow["horizon"]> = ["1w", "1d", "1h", "15m"];
  for (const horizon of priority) {
    const row = (outcomes ?? []).find(
      (r) =>
        r.horizon === horizon &&
        r.resolution === "ok" &&
        typeof r.spyExcessPct === "number" &&
        Number.isFinite(r.spyExcessPct)
    );
    if (row) return row;
  }
  return undefined;
}

/** Merge previously-persisted horizon rows with newly-computed ones: an existing TERMINAL row
 * (ok or unresolvable) is never overwritten; new rows fill the gaps. Order: 15m, 1h, 1d, 1w.
 *
 * This is what makes the belt-and-suspenders double-sampling of a 15m/1h horizon safe: the same
 * case can be sampled both by the inline `samplableNow` path inside measureCase (outcome-engine.ts)
 * AND by the durable due-jobs worker (drainDueIntradaySampleJobs), whichever runs first for that
 * horizon. WHICHEVER SIDE WRITES (persists) A RESOLVED ROW FIRST WINS — `existing` is layered in
 * after `computed` below, so a previously-persisted terminal row always survives; the other path's
 * later attempt reads that same persisted row as already-terminal and skips re-computing it (see the
 * "already_resolved" short-circuit in drainDueIntradaySampleJobs). Neither path re-prices a
 * horizon once it's terminal, so there is exactly one authoritative row per horizon, ever. */
export function mergeHorizonRows(
  existing: SocraticOutcomeHorizonRow[] | undefined,
  computed: SocraticOutcomeHorizonRow[]
): SocraticOutcomeHorizonRow[] {
  const order = ["15m", "1h", "1d", "1w"] as const;
  const byHorizon = new Map<string, SocraticOutcomeHorizonRow>();
  for (const row of computed) byHorizon.set(row.horizon, row);
  for (const row of existing ?? []) byHorizon.set(row.horizon, row); // existing terminal rows win
  return order.map((h) => byHorizon.get(h)).filter((row): row is SocraticOutcomeHorizonRow => Boolean(row));
}
