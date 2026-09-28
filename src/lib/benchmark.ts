// SPY-benchmark equity-curve scoreboard.
//
// Compares the account's equity curve (from portfolio_snapshots) to SPY over the same window —
// the honest "are we beating the market net of cost" readout. Two series share the same knots:
//   - TWR indexes (both start at 100) for manager-skill % tiles.
//   - Same-cash dollars: a shadow S&P book that starts with the same equity, grows with SPY
//     each sub-period, then applies that day's verified deposit/withdrawal at the daily cutoff.
// SPY daily closes come from the same key-free history cascade every chart uses (fetchDailyOHLC).
// Never fabricates: if there isn't enough history or SPY can't be fetched, returns null and the
// UI degrades to "—".
//
// Deposits/withdrawals: prefer the broker transfer ledger when present; otherwise INFERRED per
// snapshot gap (deposits +, withdrawals −, paper resets, ACH). See cash-flows.ts.
// Same-day additions and withdrawals are treated as landing at that day's cutoff (the last
// snapshot of the calendar day).
//
// Multi-period time-weighted return (TWR) — the GIPS-style method:
//   Split the overall window into back-to-back sub-periods at each deposit/withdrawal.
//   Sub-period account growth = V_end / (V_start + flow_at_end)  (flow is the external cash
//   that lands on the end snapshot; 0 when no transfer that day).
//   Sub-period SPY growth = SPY_end / SPY_start over the same calendar dates.
//   Chain: overall = ∏(1 + r_i) − 1 for account and for SPY independently.
// So "$100 for 10 days then $10 for 100 days" weights each regime's market performance by
// geometric linking, not by simple (end−start−flows)/start which overweights the big balance.
//
// Same-cash shadow (dollars):
//   shadow_0 = first equity.  Each later day: shadow *= SPY_factor, then += verified flow.
//   dollarExcess = last account equity − last shadow.  That is "what you would have had if
//   the same cash had tracked the S&P."
//
// excessReturnPct = accountTWR − spyTWR (percentage points).

import { resolveExternalCashFlows } from "./broker-cash-flows";
import type { AlpacaAccountActivity } from "./alpaca-account-insights";
import { fetchDailyOHLC } from "./history";
// The external-cash-flow math lives in its own dependency-free module: the console's client
// components need it, and reaching it through this file dragged history.ts + the db barrel into
// the browser bundle. See the header of ./cash-flows for the full rationale.
import { inferExternalCashFlows, isInferredFlowUnverified, isoDate, round2 } from "./cash-flows";
import type {
  BenchmarkComparison,
  BenchmarkDollarPoint,
  BenchmarkSeriesPoint,
  BenchmarkSubPeriod,
  BenchmarkUnavailability,
  EquityCurvePoint,
  FillEvent
} from "./types";

/**
 * Pure multi-period TWR normalization.
 *
 * Aligns equity with a date→close benchmark series, then walks every consecutive snapshot pair
 * (after the first date that has a SPY close). Each pair is one sub-period:
 *   - Account factor = equity_i / (equity_{i−1} + externalFlow_i)   [flow-neutral TWR]
 *   - SPY factor     = spy_i / spy_{i−1}                           [same calendar window]
 * Both indexes start at 100 and multiply by the factors (geometric chain).
 *
 * When `flowsByDate` is empty/undefined, account factor collapses to equity_i/equity_{i−1}
 * (plain equity growth) and SPY chain equals buy-and-hold over the full window.
 *
 * Returns null when either series has < 2 usable points. Exported for direct unit testing.
 */
export function normalizeAgainstBenchmark(
  equityCurve: EquityCurvePoint[],
  benchmarkCloses: Array<{ date: string; close: number }>,
  benchmarkSymbol = "SPY",
  flowsByDate?: Map<string, number>
): BenchmarkComparison | null {
  if (!equityCurve || equityCurve.length < 2 || benchmarkCloses.length < 2) return null;

  // Collapse equity to one (last) point per calendar date. The curve is chronological, so a later
  // entry for the same date overwrites an earlier one.
  const equityByDate = new Map<string, number>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    if (d && Number.isFinite(p.equity) && p.equity > 0) equityByDate.set(d, p.equity);
  }
  const equityDates = [...equityByDate.keys()].sort();
  if (equityDates.length < 2) return null;

  const bench = benchmarkCloses
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bench.length < 2) return null;

  const closeOnOrBefore = (date: string): number | null => {
    let lo = 0;
    let hi = bench.length - 1;
    let ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bench[mid].date <= date) {
        ans = bench[mid].close;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  // Build aligned (date, equity, spy) series starting at first date with a SPY close.
  const aligned: Array<{ date: string; equity: number; spy: number }> = [];
  for (const d of equityDates) {
    const eq = equityByDate.get(d)!;
    const spy = closeOnOrBefore(d);
    if (spy == null) continue;
    aligned.push({ date: d, equity: eq, spy });
  }
  if (aligned.length < 2) return null;

  const equityIndex: BenchmarkSeriesPoint[] = [];
  const benchmarkIndex: BenchmarkSeriesPoint[] = [];
  const accountEquitySeries: BenchmarkDollarPoint[] = [];
  const shadowBenchmarkSeries: BenchmarkDollarPoint[] = [];
  const subPeriods: BenchmarkSubPeriod[] = [];

  // Both series start at 100 on the first aligned date.
  let accountIndex = 100;
  let spyIndex = 100;
  // Same-cash S&P shadow starts with the same dollars that were in the account.
  let shadow = aligned[0].equity;
  equityIndex.push({ date: aligned[0].date, index: 100 });
  benchmarkIndex.push({ date: aligned[0].date, index: 100 });
  accountEquitySeries.push({ date: aligned[0].date, value: round2(aligned[0].equity) });
  shadowBenchmarkSeries.push({ date: aligned[0].date, value: round2(shadow) });

  let flowsApplied = 0;
  let netExternalFlows = 0;
  const unverifiedFlows: Array<{ date: string; amount: number }> = [];

  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1]!;
    const cur = aligned[i]!;
    let flow = flowsByDate?.get(cur.date) ?? 0;

    // Sanity bound (#2557): an inferred transfer must reconcile against its own sub-period's
    // equity delta. A flow that fails is UNVERIFIED — keep it visible on the sub-period row,
    // but compute this segment as if no transfer happened (raw equity growth) so a phantom
    // "withdrawal" can never mint fake TWR.
    const inferredFlow = flow;
    let flowUnverified = false;
    if (flow !== 0 && isInferredFlowUnverified(flow, prev.equity, cur.equity)) {
      unverifiedFlows.push({ date: cur.date, amount: round2(flow) });
      flowUnverified = true;
      flow = 0;
    }

    // ── Account sub-period (flow-neutral TWR) ──────────────────────────────
    // V_end / (V_start + external_flow_at_end). Deposit (+): larger denominator so the
    // injected cash is not counted as a gain. Withdrawal (−): smaller denominator so the
    // cash leaving is not counted as a loss.
    let accountFactor = 1;
    if (flow !== 0) {
      const denominator = prev.equity + flow;
      if (denominator > 0) {
        accountFactor = cur.equity / denominator;
        flowsApplied += 1;
        netExternalFlows += flow;
      } else {
        // Flow wiped (or more than wiped) prior equity — rebase at 0% for this sub-period
        // rather than dividing by a non-positive base.
        accountFactor = 1;
        flowsApplied += 1;
        netExternalFlows += flow;
      }
    } else if (prev.equity > 0) {
      accountFactor = cur.equity / prev.equity;
    }

    // ── SPY sub-period over the same calendar dates ────────────────────────
    // Geometric product of these factors = SPY_end/SPY_start over the full window, but we
    // still step them alongside account segments so each deposit/withdrawal boundary is an
    // explicit back-to-back sub-period (and the chart indexes share the same knots).
    const spyFactor = prev.spy > 0 ? cur.spy / prev.spy : 1;

    accountIndex *= accountFactor;
    spyIndex *= spyFactor;

    equityIndex.push({ date: cur.date, index: round2(accountIndex) });
    benchmarkIndex.push({ date: cur.date, index: round2(spyIndex) });

    // Grow previously invested dollars with this sub-period's SPY return, then apply today's
    // verified flow at the daily cutoff. Unverified inferred transfers are already zeroed.
    shadow = shadow * spyFactor + flow;
    if (!Number.isFinite(shadow) || shadow < 0) shadow = 0;
    accountEquitySeries.push({ date: cur.date, value: round2(cur.equity) });
    shadowBenchmarkSeries.push({ date: cur.date, value: round2(shadow) });

    // Record every sub-period that either has a flow or is a material market move — and always
    // when a flow lands, so the UI can show "between transfers" segments. Snap quiet flat days
    // into coarser segments? Keep every step for honesty; callers may aggregate.
    subPeriods.push({
      startDate: prev.date,
      endDate: cur.date,
      startEquity: round2(prev.equity),
      endEquity: round2(cur.equity),
      // An unverified flow keeps its inferred amount on the row (owner review), even though
      // the return math above ignored it.
      externalFlow: round2(inferredFlow),
      accountReturnPct: round2((accountFactor - 1) * 100),
      benchmarkReturnPct: round2((spyFactor - 1) * 100),
      ...(flowUnverified ? { flowUnverified: true } : {})
    });
  }

  if (equityIndex.length < 2) return null;

  const accountReturnPct = round2(accountIndex - 100);
  const benchmarkReturnPct = round2(spyIndex - 100);
  const flowsDetected = flowsApplied > 0 || Math.abs(netExternalFlows) >= 0.01;

  // Coalesce consecutive zero-flow flat sub-periods for a readable segment list: merge runs of
  // steps that have no external flow into one segment from first to last date (sum isn't needed —
  // recompute factors from endpoints). Keep every flow boundary as a hard cut.
  const coalesced = coalesceSubPeriods(subPeriods);

  const lastAccountEquity = aligned[aligned.length - 1]!.equity;
  return {
    equityIndex,
    benchmarkIndex,
    accountEquitySeries,
    shadowBenchmarkSeries,
    shadowValue: round2(shadow),
    dollarExcess: round2(lastAccountEquity - shadow),
    accountReturnPct,
    benchmarkReturnPct,
    excessReturnPct: round2(accountReturnPct - benchmarkReturnPct),
    startDate: aligned[0].date,
    endDate: equityIndex[equityIndex.length - 1].date,
    points: equityIndex.length,
    benchmarkSymbol,
    subPeriods: coalesced,
    ...(flowsDetected
      ? { cashFlowAdjusted: true, netExternalFlows: round2(netExternalFlows) }
      : { cashFlowAdjusted: false }),
    ...(unverifiedFlows.length > 0 ? { unverifiedFlows } : {})
  };
}

/**
 * Merge consecutive sub-periods that have no external flow into single segments so the
 * UI shows one row per capital regime (between deposits/withdrawals), not one row per snapshot.
 * Periods with a non-zero externalFlow always start a new segment (the flow sits on endDate).
 */
export function coalesceSubPeriods(periods: BenchmarkSubPeriod[]): BenchmarkSubPeriod[] {
  if (periods.length === 0) return [];
  const out: BenchmarkSubPeriod[] = [];
  let acc: BenchmarkSubPeriod | null = null;
  let accAccountFactor = 1;
  let accSpyFactor = 1;

  const flush = () => {
    if (!acc) return;
    out.push({
      ...acc,
      accountReturnPct: round2((accAccountFactor - 1) * 100),
      benchmarkReturnPct: round2((accSpyFactor - 1) * 100)
    });
    acc = null;
    accAccountFactor = 1;
    accSpyFactor = 1;
  };

  for (const p of periods) {
    const aFactor = 1 + p.accountReturnPct / 100;
    const sFactor = 1 + p.benchmarkReturnPct / 100;
    const hasFlow = Math.abs(p.externalFlow) >= 0.01;

    if (!acc) {
      acc = { ...p };
      accAccountFactor = aFactor;
      accSpyFactor = sFactor;
      if (hasFlow) flush();
      continue;
    }

    // Extend the open no-flow run.
    if (!hasFlow && Math.abs(acc.externalFlow) < 0.01) {
      acc.endDate = p.endDate;
      acc.endEquity = p.endEquity;
      accAccountFactor *= aFactor;
      accSpyFactor *= sFactor;
      continue;
    }

    // Flow boundary (on this period or we already had a flow pending): close prior, start new.
    flush();
    acc = { ...p };
    accAccountFactor = aFactor;
    accSpyFactor = sFactor;
    if (hasFlow) flush();
  }
  flush();
  return out;
}

/** Result of the SPY comparison with an honest "why not" when it cannot be computed. */
export interface SpyBenchmarkResult {
  comparison: BenchmarkComparison | null;
  /** Present whenever `comparison` is null, naming the reason (feed failure vs young account).
   *  Carries the machine-readable feed facts (`lastCloseDate`, `staleDays`, `stale`,
   *  `fellBackToStaleCache`) alongside the human `detail`, so a consumer never has to parse prose
   *  to tell "the feed is dead" from "the account is young". */
  unavailable?: BenchmarkUnavailability & BenchmarkFeedFacts;
  /** `ok` only when a real comparison was computed. Optional because the two deadline/catch
   *  fallbacks in src/lib/dashboard.ts hand-build this shape; absent means "unknown", and the safe
   *  read for a consumer is "no comparison" — never a 0.00%. */
  status?: "ok" | "unavailable";
  /** True when the SPY series itself is frozen/short — the feed died, as opposed to the account
   *  being too young to compare. Present on both outcomes so a consumer can flag the feed. */
  stale?: boolean;
  /** What the history cascade actually returned, on BOTH outcomes. Diagnostic only — the comparison
   *  numbers are never derived from it. */
  feed?: BenchmarkFeedDiagnostic;
}

/** Machine-readable facts about the benchmark series, never prose-only. */
export interface BenchmarkFeedFacts {
  /** Newest usable close date in the series (undefined when the cascade returned nothing usable). */
  lastCloseDate?: string;
  /** Calendar days between the newest close and the reference clock. 0 on a fresh series. */
  staleDays?: number;
  /** True when the series is older than BENCHMARK_STALE_GRACE_DAYS. */
  stale?: boolean;
  /** Provenance stamped on the newest bar by the history cascade (e.g. "yahoo-finance"). */
  source?: string;
  /** When that bar was FETCHED. A recent `fetchedAt` on an old close date is the exact signature of
   *  the history module's stale-local-cache fallback: the fetch "succeeded", the data did not. */
  fetchedAt?: string;
  /** True when the newest bar came from that stale-cache fallback — i.e. every live provider in the
   *  cascade returned null. See the staleness note on computeSpyBenchmarkDetailed for why the error
   *  itself is unrecoverable here. */
  fellBackToStaleCache?: boolean;
}

/** Full per-call feed diagnostic — the same facts `unavailable` carries, plus the bar count and a
 *  `detail` sentence. Always populated by computeSpyBenchmarkDetailed, on success and failure alike. */
export interface BenchmarkFeedDiagnostic extends BenchmarkFeedFacts {
  symbol: string;
  /** Bars the history cascade returned, before the finite-close filter. */
  bars: number;
  /** Human sentence naming the failure; safe to render verbatim. */
  detail?: string;
}

/** Calendar-day lag allowed between the last benchmark close and the account window's end before
 *  the series counts as stale (covers weekends/holidays + a same-day snapshot vs yesterday's close).
 *  ALSO the lag allowed between the last close and the wall clock before the series counts as stale
 *  on its own (see `assessBenchmarkSeriesAge`) — a frozen feed is stale whether or not the account's
 *  own snapshots happened to move. */
export const BENCHMARK_STALE_GRACE_DAYS = 5;

/** Provenance stamp the history cascade puts on bars it fell back to when EVERY live provider failed
 *  (src/lib/history.ts, the `history-cache-eod-stale` branch). It re-stamps `fetchedAt` with "now"
 *  while the bar DATES stay frozen, so the stamp is the only in-band signal that the series is
 *  cached history rather than a live quote. */
const STALE_CACHE_BAR_SOURCE = "history-cache-eod-stale";

/** Newest usable close in a series (undefined when nothing usable), by date order. */
function newestClose(closes: Array<{ date: string; close: number }>): { date: string; close: number } | undefined {
  let newest: { date: string; close: number } | undefined;
  for (const c of closes) {
    if (!Number.isFinite(c.close) || c.close <= 0) continue;
    if (!newest || c.date > newest.date) newest = { date: c.date, close: c.close };
  }
  return newest;
}

/**
 * Pure staleness gate on the wall clock, independent of the account's equity window (#2557 follow-up,
 * 2026-09-25 review: the SPY series was stale since Jul 24 and the card just went blank).
 *
 * The original gate compared the newest close against the account window's END. That works while the
 * account keeps taking snapshots and misses the case that actually bit: a dormant account whose
 * snapshots froze the same week the feed died, where lastEquityDate and lastCloseDate are both months
 * old and the gate passes — leaving a comparison whose every sub-period is 0.00% and whose "vs SPY"
 * line silently re-prints the account number. A dead feed is not a flat market, so it is judged
 * against `now` as well. Returns the unavailability, or null when the series is fresh. Exported for
 * direct unit testing.
 */
export function assessBenchmarkSeriesAge(
  closes: Array<{ date: string; close: number }>,
  now: number = Date.now(),
  benchmarkSymbol = "SPY"
): (BenchmarkUnavailability & BenchmarkFeedFacts) | null {
  const usable = closes.filter((c) => Number.isFinite(c.close) && c.close > 0);
  if (usable.length < 2) return null; // short/empty series is `no-bars` — a different verdict.
  const last = newestClose(usable);
  if (!last) return null;
  const lagMs = now - Date.parse(`${last.date}T00:00:00Z`);
  if (!Number.isFinite(lagMs)) return null;
  const staleDays = Math.max(0, Math.floor(lagMs / 86_400_000));
  if (staleDays <= BENCHMARK_STALE_GRACE_DAYS) return null;
  return {
    reason: "stale-series",
    detail: `${benchmarkSymbol} newest close is ${last.date}, ${staleDays} calendar days behind the reference clock (grace ${BENCHMARK_STALE_GRACE_DAYS}d)`,
    lastCloseDate: last.date,
    staleDays,
    stale: true
  };
}

/**
 * Pure staleness gate (#2557): a benchmark series whose last close predates the account window's
 * end by more than the grace period would map every later account date onto one frozen close —
 * SPY "0.00%" for every sub-period, and "vs SPY" silently re-printing the account number. That is
 * a dead feed, not a flat market. Returns the unavailability, or null when the series is usable.
 * Exported for direct unit testing.
 */
export function assessBenchmarkSeries(
  closes: Array<{ date: string; close: number }>,
  firstEquityDate: string,
  lastEquityDate: string,
  benchmarkSymbol = "SPY",
  seriesSource?: string
): BenchmarkUnavailability | null {
  const valid = closes.filter((c) => Number.isFinite(c.close) && c.close > 0);
  if (valid.length < 2) {
    return { reason: "no-bars", detail: `${benchmarkSymbol} history returned ${valid.length} usable close(s)` };
  }
  let lastCloseDate = valid[0].date;
  for (const c of valid) if (c.date > lastCloseDate) lastCloseDate = c.date;
  const lagMs = Date.parse(lastEquityDate) - Date.parse(lastCloseDate);
  if (Number.isFinite(lagMs) && lagMs > BENCHMARK_STALE_GRACE_DAYS * 86_400_000) {
    const source = seriesSource ? ` (source: ${seriesSource})` : "";
    return {
      reason: "stale-series",
      detail: `${benchmarkSymbol} closes end ${lastCloseDate}${source}; account window runs ${firstEquityDate} → ${lastEquityDate}`
    };
  }
  return null;
}

/**
 * Fetch SPY daily closes and compare them to the account equity curve. userId scopes the history
 * cache (consent-pooled). Optional `fills` (the same source's recorded fills) enable external
 * cash-flow inference so the account line is deposit/withdrawal-aware (TWR). Never throws into
 * the dashboard path; `comparison` is null on any failure, with `unavailable.reason` saying why —
 * feed failures (fetch-failed / no-bars / stale-series) are distinguished from the ordinary
 * young-account insufficient-history state so the UI can render a first-class "benchmark
 * unavailable" state instead of a fake 0.00% comparison.
 *
 * Synthetic fill-only curves (no real portfolio snapshots) are refused — those start at a fake
 * $100 equity base and are not comparable to SPY for an account holding real capital.
 *
 * WHY THE FEED GOES STALE (2026-09-25 review: "SPY stale since Jul 24", diagnosed here, not guessed).
 * `fetchDailyOHLC` (src/lib/history.ts) is a cascade: local SQLite EOD cache → imported EOD →
 * congress.trade → Tradier → Alpaca → Robinhood → Massive → ROIC → Tiingo → Yahoo → Marketstack.
 * Every one of those per-source fetchers wraps its HTTP call in `try { … } catch { recordProviderCall(
 * source, { ok: false }); return null; }` — the error is reduced to a boolean metric and DISCARDED.
 * When the whole cascade returns null, the cascade does not return null to its caller: it returns
 * the last local EOD cache, re-stamped with `fetchedAt = now` and `source = "history-cache-eod-stale"`,
 * and writes one `eod_cache_stale` audit row whose payload is a fixed sentence with no provider
 * names. So the caller cannot tell WHICH provider died, and the bar DATES never advance. That frozen
 * series is what makes the benchmark blank and (before the wall-clock gate below) what made
 * `alphaPct` disappear from every thesis row in src/lib/performance.ts.
 *
 * The two knobs this function can honestly turn without touching history.ts: (1) judge the series
 * against the WALL CLOCK as well as the account window, so a feed frozen alongside a dormant account
 * is caught instead of rendering a flat 0.00% "vs SPY"; (2) hand the caller the machine-readable
 * feed facts (newest close, its age, its provenance, whether it came off the stale-cache fallback) so
 * the blank says WHY. The provider error itself is NOT recoverable here — it was discarded upstream.
 * Making it actionable means recording per-source failures in the history.ts cascade.
 */
export async function computeSpyBenchmarkDetailed(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[],
  brokerActivities?: AlpacaAccountActivity[]
): Promise<SpyBenchmarkResult> {
  if (!equityCurve || equityCurve.length < 2) {
    return { comparison: null, unavailable: { reason: "insufficient-history" }, status: "unavailable", stale: false };
  }
  // Defense in depth against fabricated-equity curves (getPerformanceSummary no longer builds one
  // when there are no persisted portfolio snapshots, but this filter stays as a second guard for
  // any caller that hands in a hand-built curve without cash/positionsValue). IMPORTANT: do not
  // let a single live tip (which has cash) "upgrade" a curve with no real snapshots into a real
  // TWR — that made $100-base fill curves + $100k tip read as +tens of % "account return" on
  // paper/sandbox accounts. Require ≥2 real snapshot points.
  const realCurve = equityCurve.filter(
    (p) => typeof p.cash === "number" || typeof p.positionsValue === "number"
  );
  if (realCurve.length < 2) {
    return { comparison: null, unavailable: { reason: "insufficient-history" }, status: "unavailable", stale: false };
  }
  // Prefer the real-snapshot sub-curve (includes a live tip when present).
  equityCurve = realCurve;
  let bars;
  try {
    bars = await fetchDailyOHLC("SPY", now, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      comparison: null,
      unavailable: { reason: "fetch-failed", detail: message.slice(0, 200) },
      status: "unavailable",
      stale: false
    };
  }
  if (!bars || bars.length < 2) {
    return {
      comparison: null,
      unavailable: { reason: "no-bars", detail: `SPY history cascade returned ${bars?.length ?? 0} bar(s)` },
      status: "unavailable",
      stale: false,
      feed: { symbol: "SPY", bars: bars?.length ?? 0, staleDays: 0, stale: false, detail: `SPY history cascade returned ${bars?.length ?? 0} bar(s)` }
    };
  }
  const closes = bars
    .map((b) => ({ date: isoDate(b.time), close: b.close }))
    .filter((b): b is { date: string; close: number } => b.date != null && Number.isFinite(b.close));

  // Feed facts first, so EVERY return below can carry them. `newestClose` reads the same finite-close
  // filter as the gates, and `source`/`fetchedAt` come off the newest BAR (not the newest close) so
  // the stale-cache fallback signature survives a merged series.
  const lastBar = bars[bars.length - 1];
  const newest = newestClose(closes);
  const barSource = typeof lastBar?.source === "string" ? lastBar.source : undefined;
  const barFetchedAt = typeof lastBar?.fetchedAt === "string" ? lastBar.fetchedAt : undefined;
  const staleDays = newest
    ? Math.max(0, Math.floor((now - Date.parse(`${newest.date}T00:00:00Z`)) / 86_400_000))
    : 0;
  const feed: BenchmarkFeedDiagnostic = {
    symbol: "SPY",
    bars: bars.length,
    ...(newest ? { lastCloseDate: newest.date } : {}),
    staleDays,
    ...(barSource ? { source: barSource } : {}),
    ...(barFetchedAt ? { fetchedAt: barFetchedAt } : {}),
    fellBackToStaleCache: barSource === STALE_CACHE_BAR_SOURCE,
    stale: staleDays > BENCHMARK_STALE_GRACE_DAYS
  };

  // Wall-clock gate FIRST: a series that is months old is a dead feed no matter what the account
  // window says. The account-window gate below can only catch it when the account kept moving.
  const ageVerdict = assessBenchmarkSeriesAge(closes, now, "SPY");
  if (ageVerdict) {
    const detail = `${ageVerdict.detail}${barSource ? ` (source: ${barSource})` : ""}`;
    return {
      comparison: null,
      unavailable: { ...ageVerdict, detail, ...feedFacts(feed) },
      status: "unavailable",
      stale: true,
      feed: { ...feed, detail }
    };
  }

  // Staleness gate BEFORE computing: a series frozen before the account window would print
  // 0.00% for every sub-period (the live 2026-08-06 failure — stale local bars fallback).
  const equityDates = equityCurve
    .map((p) => isoDate(p.timestamp))
    .filter((d): d is string => d != null)
    .sort();
  if (equityDates.length >= 2) {
    const stale = assessBenchmarkSeries(closes, equityDates[0], equityDates[equityDates.length - 1], "SPY", barSource);
    if (stale) {
      return {
        comparison: null,
        unavailable: { ...stale, lastCloseDate: feed.lastCloseDate, staleDays: feed.staleDays, stale: false, ...feedFacts(feed) },
        status: "unavailable",
        stale: false,
        feed: { ...feed, detail: stale.detail }
      };
    }
  }

  const { flows, source } = resolveExternalCashFlows({ equityCurve, fills, brokerActivities });
  const comparison = normalizeAgainstBenchmark(equityCurve, closes, "SPY", flows.size > 0 ? flows : undefined);
  if (!comparison) {
    return { comparison: null, unavailable: { reason: "insufficient-overlap" }, status: "unavailable", stale: false, feed };
  }
  if (source === "broker" && flows.size > 0) comparison.cashFlowAdjusted = true;
  return { comparison, status: "ok", stale: false, feed };
}

/** The subset of a feed diagnostic that can be spread onto an `unavailable` object. */
function feedFacts(feed: BenchmarkFeedDiagnostic): BenchmarkFeedFacts {
  return {
    ...(feed.lastCloseDate ? { lastCloseDate: feed.lastCloseDate } : {}),
    staleDays: feed.staleDays,
    ...(feed.source ? { source: feed.source } : {}),
    ...(feed.fetchedAt ? { fetchedAt: feed.fetchedAt } : {}),
    ...(feed.fellBackToStaleCache ? { fellBackToStaleCache: true } : {})
  };
}

/** Back-compat wrapper: the comparison alone (null on any failure). Prefer the detailed variant. */
export async function computeSpyBenchmark(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[],
  brokerActivities?: AlpacaAccountActivity[]
): Promise<BenchmarkComparison | null> {
  return (await computeSpyBenchmarkDetailed(equityCurve, userId, now, fills, brokerActivities)).comparison;
}
