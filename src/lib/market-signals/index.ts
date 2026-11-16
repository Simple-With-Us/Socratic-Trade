import { fetchCboeVolStats, type CboeVolStats } from "./cboe";
import { fetchCftcSpPositioning } from "./cftc";
import { fetchFamaFrenchFactors, type FamaFrenchFactors } from "./famafrench";
import { fetchFullMarketBreadth } from "./massive";

/**
 * Market-wide regime/sentiment signals from free, no-key sources — Cboe (options-implied
 * tail risk), CFTC (futures positioning), and Kenneth French (equity-factor regime). These
 * slow-moving signals frame single-name decisions, so they are fetched once and cached, then
 * handed to the LLM as one compact `marketSignals` block. Every sub-source is independent and
 * failure-tolerant: a source that is down simply drops out (never fabricated).
 */
export interface MarketSignals {
  /** Cboe SKEW index — tail-risk / crash-hedging demand (~100 normal, >135–145 elevated). */
  skew?: number;
  /** Cboe VVIX — volatility of VIX (uncertainty about volatility itself). */
  vvix?: number;
  /** Cboe VIX9D — 9-day implied vol; below VIX is normal contango, above VIX (backwardation) signals near-term stress. */
  vix9d?: number;
  /** E-mini S&P 500 large-speculator net contracts (+ long / − short). */
  cotSpNonCommNet?: number;
  /** …as a % of total open interest. */
  cotSpNonCommNetPctOI?: number;
  /** CFTC report date (weekly). */
  cotReportDate?: string;
  /** Trailing ~1-month cumulative equity-factor returns (%), from Kenneth French. */
  factors1m?: Partial<Record<"mktRf" | "smb" | "hml" | "mom", number>>;
  /** Latest factor observation date. */
  factorsAsOf?: string;
  /** True full-universe market breadth (% of all US stocks advancing), from Massive grouped daily. */
  marketBreadthPct?: number;
  marketAdvancers?: number;
  marketDecliners?: number;
  /** Biggest liquid movers across the whole market. */
  marketTopGainers?: Array<{ sym: string; pct: number }>;
  marketTopLosers?: Array<{ sym: string; pct: number }>;
  marketBreadthAsOf?: string;
}

// The slow-moving sources (Cboe/CFTC/Fama-French) are cached 1h here; breadth keeps its own
// (shorter) success-only cache in massive.ts and is merged fresh on every call, so a transient
// breadth failure never poisons this bundle. Empty/failed base results are NOT cached, so a
// cold-start hiccup self-heals on the next dashboard poll instead of sticking for an hour.
const CACHE_TTL_MS = 60 * 60_000; // 1h
const cache: { expiresAt: number; base: MarketSignals | null } = { expiresAt: 0, base: null };

export async function getMarketSignals(userId?: string): Promise<MarketSignals> {
  const now = nowMs();
  let base = cache.base && cache.expiresAt > now ? cache.base : null;
  if (!base) {
    const [cboe, cot, ff] = await Promise.all([
      fetchCboeVolStats().catch((): CboeVolStats => ({})),
      fetchCftcSpPositioning().catch(() => undefined),
      fetchFamaFrenchFactors().catch((): FamaFrenchFactors => ({}))
    ]);
    const b: MarketSignals = {};
    if (typeof cboe.skew === "number") b.skew = cboe.skew;
    if (typeof cboe.vvix === "number") b.vvix = cboe.vvix;
    if (typeof cboe.vix9d === "number") b.vix9d = cboe.vix9d;
    if (cot?.nonCommNet !== undefined) b.cotSpNonCommNet = cot.nonCommNet;
    if (cot?.nonCommNetPctOI !== undefined) b.cotSpNonCommNetPctOI = cot.nonCommNetPctOI;
    if (cot?.reportDate) b.cotReportDate = cot.reportDate;
    if (ff.factors1m) b.factors1m = ff.factors1m;
    if (ff.asOf) b.factorsAsOf = ff.asOf;
    if (Object.keys(b).length > 0) {
      cache.base = b;
      cache.expiresAt = now + CACHE_TTL_MS;
    }
    base = b;
  }

  const breadth = await fetchFullMarketBreadth(now, userId).catch(() => undefined);
  const data: MarketSignals = { ...base };
  if (breadth) {
    if (typeof breadth.breadthPct === "number") data.marketBreadthPct = breadth.breadthPct;
    data.marketAdvancers = breadth.advancers;
    data.marketDecliners = breadth.decliners;
    if (breadth.topGainers.length > 0) data.marketTopGainers = breadth.topGainers;
    if (breadth.topLosers.length > 0) data.marketTopLosers = breadth.topLosers;
    if (breadth.asOf) data.marketBreadthAsOf = breadth.asOf;
  }
  return data;
}

// Isolated so the module stays testable; Date.now is fine at runtime here.
function nowMs(): number {
  return Date.now();
}
