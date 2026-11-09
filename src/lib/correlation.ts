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

/**
 * RiskMetrics-style EWMA (exponentially weighted moving average) correlation of two equal-length
 * return series. Weights are (1-lambda)*lambda^k, newest-first (k=0 is the most recent observation),
 * normalized to sum to 1 across the available samples. Same MIN_CORRELATION_SAMPLES floor and
 * near-zero-variance / [-1,1] clamp guard as `pearson` — an EWMA correlation is more RESPONSIVE to
 * recent regime shifts than the equal-weight Pearson (a name whose correlation to the book is rising
 * recently will show up here before the flat 90-day average moves).
 */
export function ewmaCorrelation(ra: number[], rb: number[], lambda = 0.94): number | undefined {
  const n = Math.min(ra.length, rb.length);
  if (n < MIN_CORRELATION_SAMPLES) return undefined;
  if (!(lambda > 0) || !(lambda < 1)) return undefined;

  // Weight index k=0 is the OLDEST sample in raw array order, but RiskMetrics weights newest-first:
  // the most recent observation (last array element) gets weight (1-lambda), the one before it
  // (1-lambda)*lambda, etc. Build weights aligned to array order (oldest→newest) then normalize.
  const weights: number[] = new Array(n);
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i; // steps back from the newest observation
    const w = (1 - lambda) * Math.pow(lambda, k);
    weights[i] = w;
    weightSum += w;
  }
  // Normalize so weights sum to 1 even over a finite/truncated sample window.
  for (let i = 0; i < n; i++) weights[i] /= weightSum;

  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += weights[i] * ra[i];
    mb += weights[i] * rb[i];
  }
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    cov += weights[i] * da * db;
    va += weights[i] * da * da;
    vb += weights[i] * db * db;
  }
  if (!(va > 1e-12) || !(vb > 1e-12)) return undefined;
  const r = cov / Math.sqrt(va * vb);
  return Math.max(-1, Math.min(1, r));
}

/**
 * Pearson correlation restricted to the HOLDING's down days (rb[i] < 0) — "when what I already own
 * falls, does the candidate fall too?" A candidate that looks diversifying on the full sample (low
 * average-return correlation) can still be a poor hedge in drawdowns if its downside-conditioned
 * correlation is materially higher — the whole point of a "downside correlation" measure. Requires
 * at least `minSamples` down-day pairs (default 10, deliberately lower than MIN_CORRELATION_SAMPLES
 * since down days are a minority subset of any return series); undefined below that floor or on
 * near-zero variance (same guard as `pearson`).
 */
export function downsideCorrelation(ra: number[], rb: number[], minSamples = 10): number | undefined {
  const n = Math.min(ra.length, rb.length);
  const da: number[] = [];
  const db: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rb[i] < 0) {
      da.push(ra[i]);
      db.push(rb[i]);
    }
  }
  if (da.length < minSamples) return undefined;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < da.length; i++) {
    sa += da[i];
    sb += db[i];
  }
  const ma = sa / da.length;
  const mb = sb / da.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < da.length; i++) {
    const x = da[i] - ma;
    const y = db[i] - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
  }
  if (!(va > 1e-12) || !(vb > 1e-12)) return undefined;
  const r = cov / Math.sqrt(va * vb);
  return Math.max(-1, Math.min(1, r));
}

/** Per-holding correlation detail for a `correlationProfile` result. */
export interface HoldingCorrelation {
  symbol: string;
  /** |marketValue| ÷ equity, as a percentage (0-100+). */
  weightPct: number;
  pearson?: number;
  ewma?: number;
  downside?: number;
}

/** Result of `correlationProfile` — a per-candidate correlation receipt against the current book. */
export interface CorrelationProfile {
  candidate: string;
  holdings: HoldingCorrelation[];
  /** The single highest-correlation holding (by ewma, falling back to pearson when ewma is undefined). */
  maxPairwise: { symbol: string; corr: number; weightPct: number };
  /** Simple average of the EWMA correlations across all holdings with a computable EWMA. */
  avgEwma?: number;
  /** True when `holdings` were truncated to the cap (largest |marketValue| first) before computing. */
  truncated: boolean;
  /**
   * Count of holdings in scope AFTER truncation — i.e. how many we attempted to profile. Some of
   * these may lack enough overlapping daily bars to yield a correlation and are therefore absent
   * from `holdings`, so `holdings.length <= consideredCount`. Use `holdings.length` for "how many
   * were actually computed"; this field is the pre-computation attempt count (post-cap).
   */
  consideredCount: number;
}

/** Cap on holdings considered per correlationProfile call (bounds bar-fetch cost per candidate). */
export const MAX_CORRELATION_PROFILE_HOLDINGS = 15;

/**
 * Builds a per-holding correlation receipt for `candidate` against the current book: for each
 * holding (capped at MAX_CORRELATION_PROFILE_HOLDINGS by |marketValue| descending — the same
 * cost-bounding idea as avgReturnCorrelation, made explicit here since a receipt computes THREE
 * correlation flavors per holding instead of one), computes weightPct, pearson, ewma, and downside
 * correlation. Returns undefined when there are no holdings, equity <= 0, or the candidate's own
 * bars are insufficient. A holding with insufficient data is simply omitted from `holdings` (never
 * fabricated) — the profile can still be returned with the remaining holdings.
 * `opts.fetchBars` is injectable for tests; production fetches via fetchDailyOHLC (30-min cached).
 */
export async function correlationProfile(
  candidate: string,
  holdings: Array<{ symbol: string; marketValue: number }>,
  equity: number,
  userId?: string,
  opts?: { fetchBars?: (symbol: string) => Promise<OHLCBar[] | null>; now?: number; lookback?: number }
): Promise<CorrelationProfile | undefined> {
  if (!(equity > 0)) return undefined;
  const cand = normalizeSymbol(candidate);
  const deduped = new Map<string, number>();
  for (const h of holdings) {
    const sym = normalizeSymbol(h.symbol);
    if (!sym || sym === cand) continue;
    deduped.set(sym, h.marketValue); // last write wins on duplicate symbols
  }
  if (deduped.size === 0) return undefined;

  const ranked = Array.from(deduped.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const truncated = ranked.length > MAX_CORRELATION_PROFILE_HOLDINGS;
  const capped = ranked.slice(0, MAX_CORRELATION_PROFILE_HOLDINGS);

  const now = opts?.now ?? Date.now();
  const fetchBars = opts?.fetchBars ?? ((symbol: string) => fetchDailyOHLC(symbol, now, userId));
  const candBars = await fetchBars(cand);
  if (!candBars || candBars.length < MIN_CORRELATION_SAMPLES + 1) return undefined;

  const results: HoldingCorrelation[] = [];
  const ewmaValues: number[] = [];
  for (const [sym, marketValue] of capped) {
    const hBars = await fetchBars(sym);
    if (!hBars || hBars.length < MIN_CORRELATION_SAMPLES + 1) continue;
    const { ra, rb } = alignedReturns(candBars, hBars, opts?.lookback ?? DEFAULT_CORRELATION_LOOKBACK);
    const p = pearson(ra, rb);
    const e = ewmaCorrelation(ra, rb);
    const d = downsideCorrelation(ra, rb);
    if (p == null && e == null) continue; // nothing computable for this holding — omit, never fabricate
    if (e != null) ewmaValues.push(e);
    results.push({
      symbol: sym,
      weightPct: (Math.abs(marketValue) / equity) * 100,
      ...(p != null ? { pearson: p } : {}),
      ...(e != null ? { ewma: e } : {}),
      ...(d != null ? { downside: d } : {})
    });
  }
  if (results.length === 0) return undefined;

  let max = results[0];
  let maxCorr = max.ewma ?? max.pearson ?? -Infinity;
  for (const r of results.slice(1)) {
    const c = r.ewma ?? r.pearson;
    if (c != null && c > maxCorr) {
      max = r;
      maxCorr = c;
    }
  }
  if (maxCorr === -Infinity) return undefined; // defensive: shouldn't happen given the filter above

  const avgEwma = ewmaValues.length > 0 ? ewmaValues.reduce((sum, v) => sum + v, 0) / ewmaValues.length : undefined;

  return {
    candidate: cand,
    holdings: results,
    maxPairwise: { symbol: max.symbol, corr: maxCorr, weightPct: max.weightPct },
    ...(avgEwma != null ? { avgEwma } : {}),
    truncated,
    consideredCount: capped.length
  };
}
