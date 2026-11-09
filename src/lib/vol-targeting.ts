// Volatility-targeting sizing + portfolio-heat budget — advisory-first, continuous taper.
//
// Two independent knobs, both opt-in (default OFF, byte-identical when unset):
//   1. Vol targeting: scale an OPENING proposal's size down (never up) toward a target annualized
//      realized-vol %, so a name trading at 3x its target vol gets sized to roughly a third.
//   2. Portfolio-heat budget: an advisory book-wide risk budget (sum of distance-to-stop dollar risk
//      across open positions, as % of equity). When the budget would be exceeded, taper the
//      INCREMENTAL order continuously to fit what's left — never a hard block, never below zero.
//
// House convention: never fabricate. Missing/insufficient data always yields `undefined`/an honest
// "no stop basis" flag rather than a guessed number. This module is dependency-light: it only
// imports the OHLCBar type, never the DB/network layers directly (callers precompute + pass bars).

import type { OHLCBar } from "./indicators";

/** Local clamp — no shared clamp(value, min, max) export exists elsewhere in src/lib. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Annualized realized volatility (%) from daily closes: stdev of simple daily returns × √252 × 100.
 * Returns `undefined` (never fabricated) when there are fewer than `lookbackDays + 1` usable closes
 * or any input/derived value is non-finite. Close-only bars (open/high/low undefined) are fine — only
 * `close` is used.
 */
export function realizedVolPct(bars: OHLCBar[], lookbackDays = 20): number | undefined {
  if (!Array.isArray(bars) || !Number.isInteger(lookbackDays) || lookbackDays <= 0) return undefined;

  const closes = bars
    .map((b) => b.close)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0);
  if (closes.length < lookbackDays + 1) return undefined;

  const tail = closes.slice(-(lookbackDays + 1));
  const returns: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1];
    const cur = tail[i];
    if (!(prev > 0)) return undefined;
    const r = cur / prev - 1;
    if (!Number.isFinite(r)) return undefined;
    returns.push(r);
  }
  if (returns.length < lookbackDays) return undefined;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / returns.length;
  if (!Number.isFinite(variance) || variance < 0) return undefined;

  const dailyStdev = Math.sqrt(variance);
  const annualized = dailyStdev * Math.sqrt(252) * 100;
  return Number.isFinite(annualized) ? annualized : undefined;
}

/**
 * Continuous taper scale from realized vol vs a target: `clamp(targetVol / realizedVol, floor, 1)`.
 * A name at or below the target vol never sizes UP — this is a taper-only brake, capped at 1.
 * `floor` bounds how far a single extreme-vol name can shrink size (default 0.25 = never below 25%).
 */
export function volTargetScale(realizedVol: number, targetVol: number, floor = 0.25): number {
  if (!Number.isFinite(realizedVol) || realizedVol <= 0) return 1;
  if (!Number.isFinite(targetVol) || targetVol <= 0) return 1;
  const raw = targetVol / realizedVol;
  if (!Number.isFinite(raw)) return 1;
  return clamp(raw, floor, 1);
}

/** Dollar risk of one position given its stop DISTANCE as a % of market value: |marketValue| × stopPct/100. */
export function positionRiskUsd(marketValue: number, stopPct: number): number {
  if (!Number.isFinite(marketValue) || !Number.isFinite(stopPct) || stopPct <= 0) return 0;
  return Math.abs(marketValue) * (stopPct / 100);
}

export interface PortfolioHeatPosition {
  symbol: string;
  marketValue: number;
}

export interface PortfolioHeatResult {
  totalRiskUsd: number;
  /** % of equity at risk across positions with a known stop basis; undefined when equity <= 0. */
  heatPct: number | undefined;
  perPosition: Array<{ symbol: string; riskUsd: number; stopPctUsed: number; estimated: boolean }>;
}

/**
 * Portfolio heat: sum of distance-to-stop dollar risk across positions, as % of equity. A position
 * with no resolvable stop basis (no per-symbol stop % and no fallback) is EXCLUDED from
 * `totalRiskUsd`/`heatPct` — it is listed in `perPosition` with `stopPctUsed: 0, estimated: true` so
 * the caller can report "N of M positions have no stop basis" rather than inventing a number.
 * Honesty over completeness: never assumes an 8% (or any) default stop out of thin air.
 */
export function computePortfolioHeat(
  positions: PortfolioHeatPosition[],
  stopPctBySymbol: Record<string, number>,
  fallbackStopPct: number | undefined,
  equity: number
): PortfolioHeatResult {
  const perPosition: PortfolioHeatResult["perPosition"] = [];
  let totalRiskUsd = 0;

  for (const pos of positions) {
    const perSymbolStop = stopPctBySymbol[pos.symbol];
    const stopPct =
      typeof perSymbolStop === "number" && Number.isFinite(perSymbolStop) && perSymbolStop > 0
        ? perSymbolStop
        : typeof fallbackStopPct === "number" && Number.isFinite(fallbackStopPct) && fallbackStopPct > 0
          ? fallbackStopPct
          : undefined;

    if (stopPct == null) {
      perPosition.push({ symbol: pos.symbol, riskUsd: 0, stopPctUsed: 0, estimated: true });
      continue;
    }

    const riskUsd = positionRiskUsd(pos.marketValue, stopPct);
    totalRiskUsd += riskUsd;
    perPosition.push({ symbol: pos.symbol, riskUsd, stopPctUsed: stopPct, estimated: false });
  }

  const heatPct = Number.isFinite(equity) && equity > 0 ? (totalRiskUsd / equity) * 100 : undefined;

  return { totalRiskUsd, heatPct, perPosition };
}
