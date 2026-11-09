import type { MarketQuote, MarketScan } from "./types";
import { deriveMetrics } from "./derived-metrics";

/**
 * Market-internal aggregates computed across the scan's candidate set — breadth,
 * valuation, and sector rotation. These summarize "what the whole tape is doing"
 * so the agent can frame single-name decisions against the broader market, and they
 * feed the equity-risk-premium calc (via `medianEarnYld`). Computed in-house from data
 * we already have; not returned by any provider.
 *
 * Note: aggregates are over `topCandidates` (the ranked, score-filtered opportunity set),
 * not the full universe — `breadthPct` (from the full screener) carries true breadth.
 */
export interface MarketInternals {
  /** Count of candidates with a positive intraday move. */
  advancers: number;
  /** Count of candidates with a negative intraday move. */
  decliners: number;
  /** Full-screener breadth (% advancing) when the scan provides it. */
  breadthPct?: number;
  /** % of candidates trading above the midpoint of their 52-week range (range52w > 50). */
  pctAboveRangeMid?: number;
  /** Median P/E across candidates with positive earnings. */
  medianPE?: number;
  /** Median earnings yield % across candidates — also the input to equity risk premium. */
  medianEarnYld?: number;
  /** Sector rotation: average intraday move per sector, leaders first. */
  sectorRotation: Array<{ sector: string; avgChangePct: number; count: number }>;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(m * 100) / 100;
}

function pricePosition(q: MarketQuote): number | undefined {
  const { fiftyTwoWeekHigh: hi, fiftyTwoWeekLow: lo, price } = q;
  if (typeof hi !== "number" || typeof lo !== "number" || hi <= lo) return undefined;
  return ((price - lo) / (hi - lo)) * 100;
}

export function computeMarketInternals(scan: MarketScan): MarketInternals {
  const candidates = scan.topCandidates ?? [];

  const changes = candidates.map((q) => q.intradayChangePct).filter((c) => Number.isFinite(c));
  const advancers = changes.filter((c) => c > 0).length;
  const decliners = changes.filter((c) => c < 0).length;

  const positions = candidates.map(pricePosition).filter((p): p is number => typeof p === "number");
  const pctAboveRangeMid = positions.length > 0
    ? Math.round((positions.filter((p) => p > 50).length / positions.length) * 100)
    : undefined;

  const medianPE = median(candidates.map((q) => q.peRatio).filter((p): p is number => typeof p === "number" && p > 0));
  const medianEarnYld = median(
    candidates.map((q) => deriveMetrics(q).earnYld).filter((e): e is number => typeof e === "number")
  );

  const sectorAgg = new Map<string, { sum: number; count: number }>();
  for (const q of candidates) {
    if (!q.sector || !Number.isFinite(q.intradayChangePct)) continue;
    const agg = sectorAgg.get(q.sector) ?? { sum: 0, count: 0 };
    agg.sum += q.intradayChangePct;
    agg.count += 1;
    sectorAgg.set(q.sector, agg);
  }
  const sectorRotation = [...sectorAgg.entries()]
    .map(([sector, { sum, count }]) => ({ sector, avgChangePct: Math.round((sum / count) * 100) / 100, count }))
    .sort((a, b) => b.avgChangePct - a.avgChangePct);

  return {
    advancers,
    decliners,
    breadthPct: scan.breadthPct,
    pctAboveRangeMid,
    medianPE,
    medianEarnYld,
    sectorRotation
  };
}
