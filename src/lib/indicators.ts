// Pure technical-analysis indicators computed from OHLC price-history bars.
//
// This is the missing piece in the app's signal stack: every other module scores a
// single snapshot quote (price/PE/52w-band) or cross-sectional aggregates — none of
// them read a price-history series. These functions turn a daily bar series into the
// classic trend/momentum reads (SMA50/200, RSI-14, MACD) and a single normalized
// `technicalScore` (0–100, 50 = neutral) + direction the deterministic ranker can use.
//
// Pure and total: no I/O, no Date.now(), never throws. Both technical-signal producers
// feed the same shape — TradingView pushes a precomputed read via webhook; the in-house
// `technical.ts` computed path runs `computeTechnicals` on bars pulled from a free OHLC
// source. Unit-tested like `parseFinraShortVolume`.

import type { TechnicalDirection } from "./types";
export type { TechnicalDirection };

export interface OHLCBar {
  /** Bar timestamp (ms epoch or ISO) — optional; only the close series is required. */
  time?: number | string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  /** Volume-weighted average price for the bar, when the source supplies it (e.g. Massive `vw`). */
  vwap?: number;
  /**
   * Provenance: which history tier produced this bar series (e.g. "massive", "yahoo-finance",
   * "history-cache-eod"). Applied to every bar in a cascade result so chart/cache consumers can
   * show source without a parallel series metadata object. See source-capability-matrix ohlcv_daily.
   */
  source?: string;
  /** When we fetched/stored this bar (ISO). Distinct from bar `time` (session date). */
  fetchedAt?: string;
}

export interface TechnicalRead {
  /** Composite technical strength, 0–100 (50 = neutral / no edge). */
  score: number;
  direction: TechnicalDirection;
  /** Named conditions that fired this bar, e.g. "sma50_200_golden_cross". */
  signals: string[];
  rsi14?: number;
  sma50?: number;
  sma200?: number;
  macd?: number;
  macdSignal?: number;
  /** Last bar's timestamp as ISO, when derivable. */
  asOf?: string;
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const clamp01to100 = (value: number): number => Math.max(0, Math.min(100, value));

/** Simple moving average over the trailing `len` closes; undefined if too few bars. */
export function sma(values: number[], len: number): number | undefined {
  if (len <= 0 || values.length < len) return undefined;
  let sum = 0;
  for (let i = values.length - len; i < values.length; i++) sum += values[i];
  return sum / len;
}

/**
 * Rate of change over `period` bars, in percent: (last / last-N − 1) × 100.
 * Needs period+1 closes.  Undefined when the lookback close is missing or not positive.
 */
export function rocPct(values: number[], period: number): number | undefined {
  if (!Number.isInteger(period) || period <= 0 || values.length <= period) return undefined;
  const current = values[values.length - 1];
  const prior = values[values.length - 1 - period];
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) return undefined;
  return ((current / prior) - 1) * 100;
}

/** True range for one bar given the prior close: max(H−L, |H−prevClose|, |L−prevClose|). */
export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * Average True Range over the last `period` bars (Wilder's range, simple-averaged). Each true range
 * needs a prior close, so ≥ period+1 bars are required. high/low fall back to close when a source
 * supplies close-only bars (true range degrades, never throws). Returns undefined when there are too
 * few bars or any value is non-finite — callers degrade to the fixed/beta stop, never to a fake number.
 */
export function atr(bars: OHLCBar[], period = 14): number | undefined {
  if (!Number.isInteger(period) || period <= 0 || !Array.isArray(bars) || bars.length < period + 1) return undefined;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const high = typeof cur.high === "number" ? cur.high : cur.close;
    const low = typeof cur.low === "number" ? cur.low : cur.close;
    const prevClose = prev.close;
    if (![high, low, prevClose].every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
    sum += trueRange(high, low, prevClose);
  }
  return sum / period;
}

/**
 * Convert an ATR value to a stop-loss DISTANCE as a percent of entryPrice: (multiple × ATR ÷ entry) × 100.
 * Clamped to [floorPct, capPct] so a near-zero or huge ATR can't produce a degenerate stop (e.g. a 0.1%
 * hair-trigger or a 90% no-op). Returns undefined for invalid inputs so the caller keeps the fixed/beta stop.
 */
export function atrStopPct(
  atrValue: number | undefined,
  entryPrice: number,
  multiple: number,
  floorPct = 1,
  capPct = 50
): number | undefined {
  if (atrValue == null || !Number.isFinite(atrValue) || atrValue <= 0) return undefined;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return undefined;
  if (!Number.isFinite(multiple) || multiple <= 0) return undefined;
  const pct = ((multiple * atrValue) / entryPrice) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return undefined;
  return Math.max(floorPct, Math.min(capPct, pct));
}

/** Full EMA series (aligned to `values`); entries before the seed index are undefined. */
export function emaSeries(values: number[], len: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (len <= 0 || values.length < len) return out;
  const k = 2 / (len + 1);
  // Seed the EMA with the SMA of the first `len` values.
  let prev = 0;
  for (let i = 0; i < len; i++) prev += values[i];
  prev /= len;
  out[len - 1] = prev;
  for (let i = len; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI from a gain/loss pair: 50 when flat (no movement), 100 when only gains. */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder's RSI series (aligned to `values`); undefined until enough bars exist. */
export function rsiSeries(values: number[], len = 14): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (values.length <= len) return out;
  let avgGain = 0;
  let avgLoss = 0;
  // Seed with the simple average of the first `len` deltas.
  for (let i = 1; i <= len; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= len;
  avgLoss /= len;
  out[len] = rsiFrom(avgGain, avgLoss);
  for (let i = len + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (len - 1) + gain) / len;
    avgLoss = (avgLoss * (len - 1) + loss) / len;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** MACD line / signal / histogram series for the standard 12/26/9 parameters. */
export function macdSeries(
  values: number[],
  fast = 12,
  slow = 26,
  signalLen = 9
): { macd: Array<number | undefined>; signal: Array<number | undefined>; hist: Array<number | undefined> } {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macd = values.map((_, i) =>
    typeof emaFast[i] === "number" && typeof emaSlow[i] === "number" ? (emaFast[i] as number) - (emaSlow[i] as number) : undefined
  );
  // The signal line is an EMA of the MACD line over its defined region only.
  const defined: number[] = [];
  const firstIdx = macd.findIndex((v) => typeof v === "number");
  if (firstIdx >= 0) for (let i = firstIdx; i < macd.length; i++) defined.push(macd[i] as number);
  const signalDefined = emaSeries(defined, signalLen);
  const signal: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (firstIdx >= 0) for (let i = 0; i < signalDefined.length; i++) signal[firstIdx + i] = signalDefined[i];
  const hist = macd.map((v, i) =>
    typeof v === "number" && typeof signal[i] === "number" ? v - (signal[i] as number) : undefined
  );
  return { macd, signal, hist };
}

function toIso(time: number | string | undefined): string | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    // TradingView/Yahoo bar times are usually ms epoch, but seconds are common too.
    const ms = time > 1e12 ? time : time * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof time === "string" && time) return time;
  return undefined;
}

/**
 * Compute the normalized technical read from a daily bar series. Returns `undefined`
 * when there are too few bars to say anything (RSI/MACD need ~30+). Never fabricates:
 * components that lack the bars they need (e.g. SMA200) simply don't contribute.
 */
export function computeTechnicals(bars: OHLCBar[]): TechnicalRead | undefined {
  const closes = bars.map((b) => b.close).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (closes.length < 30) return undefined;

  const price = closes[closes.length - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const sma50Prev = sma(closes.slice(0, -1), 50);
  const sma200Prev = sma(closes.slice(0, -1), 200);
  const rsiArr = rsiSeries(closes, 14);
  const rsi14 = rsiArr[rsiArr.length - 1];
  const rsi14Prev = rsiArr[rsiArr.length - 2];
  const { macd, signal } = macdSeries(closes);
  const macdNow = macd[macd.length - 1];
  const macdPrev = macd[macd.length - 2];
  const sigNow = signal[signal.length - 1];
  const sigPrev = signal[signal.length - 2];

  let base = 50;
  const signals: string[] = [];

  // Trend regime from the moving-average stack — the dominant, most reliable component.
  const upTrend = typeof sma50 === "number" && typeof sma200 === "number" && price > sma50 && sma50 > sma200;
  const downTrend = typeof sma50 === "number" && typeof sma200 === "number" && price < sma50 && sma50 < sma200;
  if (typeof sma50 === "number" && typeof sma200 === "number") {
    if (upTrend) base += 18;
    else if (price > sma200) base += 7;
    if (downTrend) base -= 18;
    else if (price < sma200) base -= 7;
  } else if (typeof sma50 === "number") {
    base += price > sma50 ? 8 : -8;
  }

  // SMA50/200 crossover this bar (the classic golden/death cross).
  if (
    typeof sma50 === "number" &&
    typeof sma200 === "number" &&
    typeof sma50Prev === "number" &&
    typeof sma200Prev === "number"
  ) {
    if (sma50Prev <= sma200Prev && sma50 > sma200) {
      base += 12;
      signals.push("sma50_200_golden_cross");
    } else if (sma50Prev >= sma200Prev && sma50 < sma200) {
      base -= 12;
      signals.push("sma50_200_death_cross");
    }
  }

  // RSI: reclaim/fade EVENTS are the actionable bits. Level nudges are gated on trend —
  // overbought within a confirmed uptrend is continuation, not a fade (and vice versa).
  if (typeof rsi14 === "number") {
    if (rsi14 < 30 && !downTrend) base += 5; // oversold bounce setup (not in a downtrend)
    else if (rsi14 > 70 && !upTrend) base -= 5; // overbought fade risk (not in an uptrend)
    if (typeof rsi14Prev === "number") {
      if (rsi14Prev <= 30 && rsi14 > 30) {
        base += 10;
        signals.push("rsi_reclaim_oversold");
      } else if (rsi14Prev >= 70 && rsi14 < 70) {
        base -= 10;
        signals.push("rsi_fade_overbought");
      }
    }
  }

  // MACD position + signal-line cross.
  if (typeof macdNow === "number" && typeof sigNow === "number") {
    base += macdNow > sigNow ? 6 : -6;
    if (typeof macdPrev === "number" && typeof sigPrev === "number") {
      if (macdPrev <= sigPrev && macdNow > sigNow) {
        base += 8;
        signals.push("macd_bull_cross");
      } else if (macdPrev >= sigPrev && macdNow < sigNow) {
        base -= 8;
        signals.push("macd_bear_cross");
      }
    }
  }

  const score = round(clamp01to100(base), 1);
  const direction: TechnicalDirection = score >= 60 ? "bullish" : score <= 40 ? "bearish" : "neutral";

  return {
    score,
    direction,
    signals,
    rsi14: typeof rsi14 === "number" ? round(rsi14, 1) : undefined,
    sma50: typeof sma50 === "number" ? round(sma50, 2) : undefined,
    sma200: typeof sma200 === "number" ? round(sma200, 2) : undefined,
    macd: typeof macdNow === "number" ? round(macdNow, 3) : undefined,
    macdSignal: typeof sigNow === "number" ? round(sigNow, 3) : undefined,
    asOf: toIso(bars[bars.length - 1]?.time)
  };
}
