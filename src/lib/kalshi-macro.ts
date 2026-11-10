/**
 * Kalshi macro event-market context for the strategist prompt.
 *
 * Wave 2 of the Kalshi integration: fetch curated Fed/CPI/recession/labor
 * series through the existing public-data client and format them next to
 * Polymarket / marketSignals.  Fail-open.  Never fabricates a probability.
 */

import { resolveSourceBool, resolveSourceNumber, resolveSourceString } from "./source-settings";
import {
  getKalshiEventSignals,
  isKalshiConfigured,
  type KalshiEventSignal
} from "./kalshi";

export const DEFAULT_KALSHI_MACRO_SERIES = [
  "KXFEDDECISION",
  "KXCPIYOY",
  "KXRECSSNBER",
  "KXNFP",
  "KXGDP"
] as const;

export const KALSHI_ELECTION_SERIES = ["KXPRES", "KXSENATE", "KXHOUSE"] as const;

export interface KalshiMacroContext {
  asOf?: string;
  series: string[];
  lines: string[];
  signals: KalshiEventSignal[];
}

export function resolveKalshiMacroSeries(userId?: string): string[] {
  const raw = resolveSourceString("KALSHI_MACRO_SERIES", userId).trim();
  const fromKnob = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  const base = fromKnob.length > 0 ? fromKnob : [...DEFAULT_KALSHI_MACRO_SERIES];
  if (resolveSourceBool("KALSHI_INCLUDE_ELECTIONS", userId)) {
    for (const ticker of KALSHI_ELECTION_SERIES) {
      if (!base.includes(ticker)) base.push(ticker);
    }
  }
  return [...new Set(base)];
}

import type { TradingPolicy } from "./types";

export function kalshiMacroContextEnabled(userId?: string, policy?: TradingPolicy): boolean {
  if (policy && policy.kalshiMacroEnabled === false) return false;
  if (!resolveSourceBool("KALSHI_CONTEXT", userId)) return false;
  return isKalshiConfigured();
}

export function formatKalshiLinesForPrompt(signals: KalshiEventSignal[]): string[] {
  return signals.map((s) => {
    const pct = Math.round(s.probability * 1000) / 10;
    const liq =
      s.openInterest != null
        ? ` oi=${Math.round(s.openInterest)}`
        : s.volume24h != null
          ? ` vol24h=${Math.round(s.volume24h)}`
          : "";
    const close = s.closeTime ? ` close=${s.closeTime.slice(0, 10)}` : "";
    return `${s.seriesTicker} ${s.marketTicker}: ${s.title} — yes ${pct}% (${s.probabilityBasis}${liq}${close})`;
  });
}

export async function fetchKalshiMacroContext(userId?: string, policy?: TradingPolicy): Promise<KalshiMacroContext> {
  if (!kalshiMacroContextEnabled(userId, policy)) return { series: [], lines: [], signals: [] };
  const series = resolveKalshiMacroSeries(userId);
  const maxPerSeries = Math.max(1, Math.floor(resolveSourceNumber("KALSHI_MAX_MARKETS_PER_SERIES", userId) || 4));
  const signals = await getKalshiEventSignals(series, { maxMarketsPerSeries: maxPerSeries });
  return {
    asOf: signals[0]?.asOf,
    series,
    lines: formatKalshiLinesForPrompt(signals),
    signals
  };
}
