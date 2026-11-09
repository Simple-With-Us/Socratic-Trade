import type { FillSource } from "./types";
import { normalizeSymbol } from "./money";
import { getClosedLotsDetailed } from "./performance";
import type { ClosedLot } from "./performance";

export interface TradeExcursion {
  mae: number;
  mfe: number;
}

/** Aggregate MAE/MFE timing stats grouped by thesis. */
export interface ExcursionStat {
  thesisTag: string;
  trades: number;
  avgMaePct: number; // avg max adverse excursion during the hold (negative = pain endured)
  avgMfePct: number; // avg max favorable excursion during the hold (the move available)
  capturePct: number; // realized return as a % of the favorable move (low = exited winners early)
}

/**
 * Calculates Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE)
 * for a given trade.
 */
export async function calculateExcursions(
  symbol: string,
  entryDate: Date,
  exitDate: Date,
  side: "buy" | "short",
  entryPrice: number
): Promise<TradeExcursion | null> {
  const normSymbol = normalizeSymbol(symbol);
  
  // Note: This relies on Yahoo Finance historical data. In production, a reliable 
  // OHLCV provider should be used.
  const startPeriod = Math.floor(entryDate.getTime() / 1000);
  const endPeriod = Math.floor(exitDate.getTime() / 1000);
  
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${normSymbol}?period1=${startPeriod}&period2=${endPeriod}&interval=1d`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    
    const result = json.chart?.result?.[0];
    if (!result || !result.indicators?.quote?.[0]) return null;
    
    const highs = result.indicators.quote[0].high as number[];
    const lows = result.indicators.quote[0].low as number[];
    
    if (!highs || !lows) return null;
    
    let highestHigh = entryPrice;
    let lowestLow = entryPrice;
    
    for (let i = 0; i < highs.length; i++) {
      if (highs[i] != null && highs[i] > highestHigh) highestHigh = highs[i];
      if (lows[i] != null && lows[i] < lowestLow) lowestLow = lows[i];
    }
    
    if (side === "buy") {
      return {
        mae: ((lowestLow - entryPrice) / entryPrice) * 100, // Negative percent usually, or absolute? Let's keep it signed
        mfe: ((highestHigh - entryPrice) / entryPrice) * 100
      };
    } else {
      // For short, high is adverse, low is favorable
      return {
        mae: ((entryPrice - highestHigh) / entryPrice) * 100, // Price goes up -> loss
        mfe: ((entryPrice - lowestLow) / entryPrice) * 100    // Price goes down -> profit
      };
    }
  } catch (err) {
    console.error("Failed to calculate excursion", err);
    return null;
  }
}

type ExcursionFetcher = typeof calculateExcursions;

/**
 * MAE/MFE timing scorecard grouped by thesis: for recent closed lots, fetch the
 * holding-period high/low and aggregate how much pain was endured (MAE), how much
 * favorable move was available (MFE), and what share of it was actually captured.
 * Bounded to `maxLots` recent closes and computed only in the async post-mortem,
 * so the synchronous proposal path never makes these network calls.
 */
export async function getExcursionsByThesis(
  accountNumber: string,
  source: FillSource,
  options: { maxLots?: number; compute?: ExcursionFetcher; userId?: string } = {}
): Promise<ExcursionStat[]> {
  const maxLots = options.maxLots ?? 16;
  const compute = options.compute ?? calculateExcursions;
  const lots = getClosedLotsDetailed(accountNumber, source, options.userId ?? "local")
    .filter(
      (lot) =>
        !!lot.symbol &&
        !!lot.entryAt &&
        !!lot.exitAt &&
        typeof lot.entryPrice === "number" &&
        lot.entryPrice > 0 &&
        (lot.side === "long" || lot.side === "short")
    )
    .slice(-maxLots);
  if (lots.length === 0) return [];

  const cache = new Map<string, TradeExcursion | null>();
  const byTag = new Map<string, { mae: number; mfe: number; capture: number; trades: number }>();

  for (const lot of lots) {
    const side = lot.side === "short" ? "short" : "buy";
    const symbol = normalizeSymbol(lot.symbol!);
    const key = `${symbol}:${lot.entryAt}:${lot.exitAt}:${side}`;
    let excursion = cache.get(key);
    if (excursion === undefined) {
      excursion = await compute(symbol, new Date(lot.entryAt!), new Date(lot.exitAt!), side, lot.entryPrice!);
      cache.set(key, excursion);
    }
    if (!excursion) continue;
    const tag = lot.thesisTag && lot.thesisTag.trim() ? lot.thesisTag.trim() : "Untagged";
    const cur = byTag.get(tag) ?? { mae: 0, mfe: 0, capture: 0, trades: 0 };
    cur.mae += excursion.mae;
    cur.mfe += excursion.mfe;
    // Share of the favorable move actually captured (clamped); low => exited winners early.
    cur.capture += excursion.mfe > 0 ? Math.max(0, Math.min(200, (lot.returnPct / excursion.mfe) * 100)) : 0;
    cur.trades += 1;
    byTag.set(tag, cur);
  }

  return Array.from(byTag.entries())
    .map(([thesisTag, s]) => ({
      thesisTag,
      trades: s.trades,
      avgMaePct: Number((s.mae / s.trades).toFixed(2)),
      avgMfePct: Number((s.mfe / s.trades).toFixed(2)),
      capturePct: Number((s.capture / s.trades).toFixed(0))
    }))
    .sort((a, b) => b.avgMfePct - a.avgMfePct);
}

/**
 * Enrich a list of ClosedLots with MAE/MFE excursion data.
 *
 * This is intentionally async and MUST NOT be called in any synchronous
 * order/proposal hot path — calculateExcursions performs live Yahoo OHLCV
 * fetches. Call this only from background/post-mortem paths.
 *
 * Lots that lack the required fields (symbol, entryAt, exitAt, entryPrice,
 * long/short side) are returned unchanged. Lots where calculateExcursions
 * returns null (e.g. network failure) are also returned unchanged.
 */
export async function enrichClosedLotsWithExcursions(
  lots: ClosedLot[],
  compute: ExcursionFetcher = calculateExcursions
): Promise<ClosedLot[]> {
  const cache = new Map<string, TradeExcursion | null>();
  const result: ClosedLot[] = [];

  for (const lot of lots) {
    if (
      !lot.symbol ||
      !lot.entryAt ||
      !lot.exitAt ||
      typeof lot.entryPrice !== "number" ||
      lot.entryPrice <= 0 ||
      (lot.side !== "long" && lot.side !== "short")
    ) {
      result.push(lot);
      continue;
    }

    const side: "buy" | "short" = lot.side === "short" ? "short" : "buy";
    const symbol = normalizeSymbol(lot.symbol);
    const key = `${symbol}:${lot.entryAt}:${lot.exitAt}:${side}`;

    let excursion = cache.get(key);
    if (excursion === undefined) {
      excursion = await compute(symbol, new Date(lot.entryAt), new Date(lot.exitAt), side, lot.entryPrice);
      cache.set(key, excursion);
    }

    if (!excursion) {
      result.push(lot);
      continue;
    }

    result.push({ ...lot, mae: excursion.mae, mfe: excursion.mfe });
  }

  return result;
}
