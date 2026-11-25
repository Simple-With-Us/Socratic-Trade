// Pure bar-derived optional quote fields for the multi-horizon momentum, realized-volatility
// and 20-day ADV scan reads (ST-4679 OD-1). PR #5465 added readers for these fields on the scan
// candidate (market.ts ExtendedFactorQuote / strategy-risk.ts ADV cap) but nothing wrote them, so
// the logic was inert in production. This module is the producer side: it turns a stored nightly
// OHLC series (history_cache_eod, oldest -> newest) into exactly the optional fields those readers
// consume, and omits any field whose literal window has a hole or too few bars.
//
// Pure and total: no I/O, no Date.now(), never throws. It mirrors the hole-handling of
// scorecardIndicatorsFromBars (strategy.ts) WITHOUT importing strategy.ts (that would cycle through
// market.ts). Units match the readers exactly:
//   - returnNd / realizedVolNd / atrPct are PERCENT (the momentum tanh scales and the volatility
//     `105 - vol * 1.33` map are calibrated to percent, e.g. annualized vol 15 -> ~85).
//   - avgVolume20d is a SHARE COUNT (liquidityScore and the ADV cap multiply it by price).
// Annualization uses sqrt(252) * 100, the same house convention as vol-targeting.ts realizedVolPct.

import { atr, rocPct, type OHLCBar } from "./indicators";

/** Optional multi-horizon fields derived from a daily bar series. Only defined keys are emitted. */
export interface BarDerivedQuoteFields {
  avgVolume20d?: number;
  return5d?: number;
  return20d?: number;
  return60d?: number;
  return126d?: number;
  realizedVol20d?: number;
  realizedVol60d?: number;
  atrPct?: number;
}

const TRADING_DAYS_PER_YEAR = 252;

/** Every close in the literal trailing window must be a real positive number; any hole omits. */
function windowCloses(bars: OHLCBar[], lookback: number): number[] | undefined {
  if (!Array.isArray(bars) || bars.length < lookback + 1) return undefined;
  const window = bars.slice(-(lookback + 1));
  const closes: number[] = [];
  for (const bar of window) {
    if (typeof bar.close !== "number" || !Number.isFinite(bar.close) || bar.close <= 0) return undefined;
    closes.push(bar.close);
  }
  return closes;
}

/**
 * Percent close-to-close return over the literal trailing `lookback` bars: (last / last-N - 1) * 100.
 * Needs lookback+1 closes (N intervals); reuses rocPct's percent convention after validating the
 * whole window so a hole anywhere in it omits the field rather than silently spanning the gap.
 */
function windowReturnPct(bars: OHLCBar[], lookback: number): number | undefined {
  const closes = windowCloses(bars, lookback);
  if (!closes) return undefined;
  return rocPct(closes, lookback);
}

/**
 * Annualized realized volatility (%) from daily LOG returns over the literal trailing `lookback`
 * bars: population stdev of ln(close_i / close_{i-1}) * sqrt(252) * 100. Needs lookback+1 closes
 * (lookback returns); any hole or non-finite value omits the field. Mirrors vol-targeting.ts's
 * annualization + population-variance convention, but uses log returns and strict hole omission.
 */
function windowRealizedVolPct(bars: OHLCBar[], lookback: number): number | undefined {
  const closes = windowCloses(bars, lookback);
  if (!closes) return undefined;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (!Number.isFinite(r)) return undefined;
    logReturns.push(r);
  }
  if (logReturns.length < lookback) return undefined;
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) / logReturns.length;
  if (!Number.isFinite(variance) || variance < 0) return undefined;
  const annualized = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  return Number.isFinite(annualized) ? annualized : undefined;
}

/**
 * Derive the optional multi-horizon quote fields from a daily bar series (oldest -> newest, the
 * shape fetchHistoryCacheEod returns). Each field is emitted only when its literal window is fully
 * present; absent/insufficient windows leave the key off so a merge onto a quote stays byte-identical
 * to today's fallback when bars are missing.
 */
export function barDerivedQuoteFields(bars: OHLCBar[]): BarDerivedQuoteFields {
  if (!Array.isArray(bars) || bars.length === 0) return {};
  const fields: BarDerivedQuoteFields = {};

  // Trailing 20-day average volume — the LAST 20 BARS literally, every one carrying a real volume;
  // any hole omits the field. Mirrors scorecardIndicatorsFromBars (strategy.ts) exactly.
  const volumeTail = bars
    .slice(-20)
    .map((bar) => bar.volume)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (bars.length >= 20 && volumeTail.length === 20) {
    fields.avgVolume20d = Math.round(volumeTail.reduce((sum, v) => sum + v, 0) / volumeTail.length);
  }

  const return5d = windowReturnPct(bars, 5);
  if (return5d !== undefined) fields.return5d = return5d;
  const return20d = windowReturnPct(bars, 20);
  if (return20d !== undefined) fields.return20d = return20d;
  const return60d = windowReturnPct(bars, 60);
  if (return60d !== undefined) fields.return60d = return60d;
  const return126d = windowReturnPct(bars, 126);
  if (return126d !== undefined) fields.return126d = return126d;

  const realizedVol20d = windowRealizedVolPct(bars, 20);
  if (realizedVol20d !== undefined) fields.realizedVol20d = realizedVol20d;
  const realizedVol60d = windowRealizedVolPct(bars, 60);
  if (realizedVol60d !== undefined) fields.realizedVol60d = realizedVol60d;

  // ATR14 as a percent of the last close. atr() degrades high/low to close on close-only bars and
  // returns undefined when there are too few bars or a non-finite value; omit atrPct then.
  const atr14 = atr(bars, 14);
  const lastClose = bars[bars.length - 1].close;
  if (
    typeof atr14 === "number" &&
    typeof lastClose === "number" &&
    Number.isFinite(lastClose) &&
    lastClose > 0
  ) {
    const atrPct = (atr14 / lastClose) * 100;
    if (Number.isFinite(atrPct)) fields.atrPct = atrPct;
  }

  return fields;
}