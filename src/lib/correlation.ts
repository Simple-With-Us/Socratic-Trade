// Daily-return correlation between a candidate and the current holdings — the precise version of
// what the maxPortfolioBeta cap approximates. Used by the OPT-IN correlation cluster gate
// (policy.maxAvgCorrelation, default off) to refuse opening a name that would add to an
// already-correlated cluster (concentrated drawdown risk the per-symbol/sector/beta caps miss).
//
// Pure math (closesByDate/alignedReturns/pearson) is unit-testable; avgReturnCorrelation fetches
// bars via the shared OHLC cascade (fetchDailyOHLC) with an injectable fetcher for tests. Returns
// undefined whenever there is not enough overlapping data, so the gate can never false-reject.

import type { OHLCBar } from "./indicators";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import { normalizeSymbol } from "./money";

/** Minimum overlapping daily returns required before a correlation is trusted. */
export const MIN_CORRELATION_SAMPLES = 20;
/** Default lookback in trading days for the correlation window. */
export const DEFAULT_CORRELATION_LOOKBACK = 90;

/** Map of business-day → close for a bar series (last write wins on duplicate days). */
export function closesByDate(bars: OHLCBar[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bars) {
    const d = toBusinessDay(b.time);
    if (d && typeof b.close === "number" && Number.isFinite(b.close) && b.close > 0) m.set(d, b.close);
  }
  return m;
}

/**
 * Daily simple returns for the two series over their COMMON business days (intersection, ascending),
 * limited to the last `lookback` returns. Aligning by date makes it robust to holiday/gap mismatches.
 */
export function alignedReturns(a: OHLCBar[], b: OHLCBar[], lookback = DEFAULT_CORRELATION_LOOKBACK): { ra: number[]; rb: number[] } {
  const ma = closesByDate(a);
  const mb = closesByDate(b);
  const common = [...ma.keys()].filter((d) => mb.has(d)).sort();
  const recent = common.slice(-(lookback + 1)); // lookback+1 closes → lookback returns
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const pa0 = ma.get(recent[i - 1])!;
    const pa1 = ma.get(recent[i])!;
    const pb0 = mb.get(recent[i - 1])!;
    const pb1 = mb.get(recent[i])!;
    ra.push(pa1 / pa0 - 1);
    rb.push(pb1 / pb0 - 1);
  }
  return { ra, rb };
}

/** Pearson correlation of two equal-length return series; undefined when too few samples or zero variance. */
export function pearson(a: number[], b: number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n < MIN_CORRELATION_SAMPLES) return undefined;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  // Treat (near-)zero variance as undefined: a constant series has no correlation, and a tiny
  // float-noise variance would otherwise yield a spurious ±1. EPS is far below any real return variance.
  if (!(va > 1e-12) || !(vb > 1e-12)) return undefined;
  const r = cov / Math.sqrt(va * vb);
  return Math.max(-1, Math.min(1, r)); // clamp tiny float overshoot to [-1, 1]
}

/**
 * Average pairwise daily-return correlation of `candidate` to each current holding. Returns undefined
 * when there are no other holdings or not enough overlapping data for ANY pair (gate can't false-reject).
 * `opts.fetchBars` is injectable for tests; production fetches ~5y daily bars via fetchDailyOHLC.
 */
export async function avgReturnCorrelation(
  candidate: string,
  holdings: string[],
  userId: string | undefined,
  now: number = Date.now(),
  opts?: { fetchBars?: (symbol: string) => Promise<OHLCBar[] | null>; lookback?: number }
): Promise<number | undefined> {
  const cand = normalizeSymbol(candidate);
  const others = Array.from(new Set(holdings.map(normalizeSymbol).filter((s) => s && s !== cand)));
  if (others.length === 0) return undefined;

  const fetchBars = opts?.fetchBars ?? ((symbol: string) => fetchDailyOHLC(symbol, now, userId));
  const candBars = await fetchBars(cand);
  if (!candBars || candBars.length < MIN_CORRELATION_SAMPLES + 1) return undefined;

  const corrs: number[] = [];
  for (const h of others) {
    const hBars = await fetchBars(h);
    if (!hBars || hBars.length < MIN_CORRELATION_SAMPLES + 1) continue;
    const { ra, rb } = alignedReturns(candBars, hBars, opts?.lookback ?? DEFAULT_CORRELATION_LOOKBACK);
    const c = pearson(ra, rb);
    if (c != null) corrs.push(c);
  }
  if (corrs.length === 0) return undefined;
  return corrs.reduce((sum, c) => sum + c, 0) / corrs.length;
}
