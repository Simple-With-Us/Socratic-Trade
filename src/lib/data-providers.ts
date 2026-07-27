// Market enrichment: fundamentals (P/E) + analyst-consensus sentiment layered on top of
// the NASDAQ screener scan.
//
// Provider cascade (first non-null value wins per field):
//   1. Finnhub           — news sentiment, analyst recs, profile, basic financials (FINNHUB_API_KEY)
//   2. FMP stable API    — P/E (ratios-ttm), analyst grades-consensus             (FMP_API_KEY)
//   3. Yahoo Finance     — sector, industry, P/E, EPS, div yield, analyst rating  (no key needed)
//
// Each keyed provider is only instantiated when its env key is set. Yahoo Finance is always
// the final real tier — no API key required, uses session crumb auth.
//
// A quota-scarce RapidAPI-hosted FAILOVER tier (Mboum Finance, YH Finance 15, Alpha Vantage's
// RapidAPI transport) is registered AFTER Yahoo Finance, gated on RAPIDAPI_KEY — see the doc
// comment on SteadyApiEnrichmentProvider / AlphaVantageRapidApiEnrichmentProvider below and
// rapidapi-quota.ts for the persisted daily-budget mechanism that keeps it safe.

import { fromAlpacaSymbol, normalizeSymbol, toAlpacaSymbol } from "./money";
import {
  congressFundamentalsEnabled,
  getCongressTradeClient
} from "./api-clients/congress";
import type { FundamentalRow, AnalystRow } from "@jaywedgeworth22/congress-trading-shared";

export type AppAFundamentalRow = FundamentalRow & { source?: string | null };
export type AppAAnalystRow = AnalystRow & { source?: string | null };
import type { EnrichmentSources } from "./types";

import {
  cancelUndispatchedProviderReservation,
  hasDataPoolConsent,
  markProviderDispatchStarted,
  reserveProviderDispatch,
  resolveAlpacaMarketData,
  resolveAlphaVantageKeyPool,
  resolveApiKeyWithSource,
  settleProviderDispatch,
  type ApiKeySource
} from "./db";
import { logApiHealth, getServiceHealthSummaries, HEALTH_REASON_CONSECUTIVE_FAILURES } from "./db-health";
import { apiCircuitBreakerShouldSkip, CircuitOpenError } from "./api-circuit-breaker";
import { recordProviderCall } from "./usage-monitor-push";
import { robinhoodMcpDataEnabled } from "./robinhood";
import { RobinhoodOptionsEnrichmentProvider } from "./robinhood-options";
import { QuiverEnrichmentProvider, resolveQuiverApiKey } from "./quiver-provider";
import { getStreamedHeadlines } from "./streams/news-store";
import { politeFetchText, runRateLimited, secUserAgent } from "./web-sources/http";
import { loadTickerCikMap } from "./web-sources/sec8k";
import { padCik } from "./web-sources/sec-filings";
import { withProviderLimit, admitProviderRequests, refundProviderRequests, resetProviderQuotaState, resolveProviderQuota, scrubProviderErrorText, scrubProviderErrorTextForPool, appendErrorCause } from "./provider-rate-limit";
import { AlphaVantageKeyPool, getPoolForKeys, isAlphaVantageDailyCapMessage, millisUntilNextAlphaVantageDailyReset, tryReserveAlphaVantageCalls, refundAlphaVantageCalls, alphaVantageDailyCallBudget } from "./alpha-vantage-key-pool";
import { tryReserveRapidApiCalls, refundRapidApiCalls, type RapidApiProviderKey } from "./rapidapi-quota";
import {
  arbitrateFieldObservation,
  dedupeUpstreamFamilies,
  type FieldObservation,
  type FieldObservationCandidate,
  type ProviderFailureReceipt,
  type UpstreamFamilyCandidate
} from "./evidence-facts";

// ── Enrichment cache scoping (mirrors src/lib/history.ts) ─────────────────────
// Data fetched with a user's own stored key is scoped to that user (private) or
// shared into the reciprocal data pool (pool) when they consent.  Data from an
// operator/env key or a free source is globally shared (shared), preserving the
// original behaviour and benefiting all users without consent implications.

type CacheScope = "shared" | "private" | "pool";

function cacheScopeForKeySource(source: ApiKeySource, userId: string | undefined): CacheScope {
  if (source !== "user") return "shared";
  if (shareUserKeyedEnrichment()) return "shared";
  if (hasDataPoolConsent(userId ?? "local")) return "pool";
  return "private";
}

function shareUserKeyedEnrichment(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function enrichmentCacheKey(prefix: string, symbol: string, scope: CacheScope, userId: string | undefined): string {
  if (scope === "private") return `user:${userId ?? "local"}:${prefix}:${symbol}`;
  if (scope === "pool") return `pool:${prefix}:${symbol}`;
  return `${prefix}:${symbol}`;
}

/** Read a cached enrichment entry respecting private → pool (if consented) → shared order. */
function readEnrichmentCache(
  prefix: string,
  symbol: string,
  userId: string | undefined,
  consented: boolean,
  now: number
): { expiresAt: number; data: SymbolEnrichment } | undefined {
  const privateHit = cache.get(enrichmentCacheKey(prefix, symbol, "private", userId));
  if (privateHit && privateHit.expiresAt > now) return privateHit;
  if (consented) {
    const poolHit = cache.get(enrichmentCacheKey(prefix, symbol, "pool", userId));
    if (poolHit && poolHit.expiresAt > now) return poolHit;
  }
  const sharedHit = cache.get(enrichmentCacheKey(prefix, symbol, "shared", userId));
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit;
  return undefined;
}

/** Write a cached enrichment entry under the correct scope key. */
function writeEnrichmentCache(
  prefix: string,
  symbol: string,
  scope: CacheScope,
  userId: string | undefined,
  data: SymbolEnrichment,
  expiresAt: number
): void {
  cache.set(enrichmentCacheKey(prefix, symbol, scope, userId), { expiresAt, data });
}

// Per-source analyst breakdown so the Rating column can blend across providers and
// the tooltip can show each provider's individual read.
export interface AnalystRatingDetail {
  score: number;   // 0–100 (Strong Buy = 100 … Strong Sell = 0)
  label: string;   // Strong Buy / Buy / Hold / Sell / Strong Sell
  counts?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  mean?: number;   // analyst mean (1–5) when the source reports one instead of counts
  /** Canonical upstream source family, so re-published consensus is blended once. */
  upstreamFamily?: string;
}

export interface SymbolEnrichment {
  price?: number;
  bid?: number;
  ask?: number;
  intradayChangePct?: number;
  vwap?: number;        // session volume-weighted average price (Alpaca dailyBar.vw)
  asOf?: string;
  sentiment?: number;    // 0–100 news tone (50 = neutral). News-derived only.
  peRatio?: number;
  headlines?: string[];
  analystRating?: string;  // blended consensus label
  analystScore?: number;   // blended 0–100 analyst score
  sector?: string;
  industry?: string;
  volume?: number;
  dividendYield?: number; // annual dividend yield %
  eps?: number;           // earnings per share (TTM)
  companyName?: string;
  pbRatio?: number;
  shortPercentOfFloat?: number;
  // A SECOND source's independent short-interest read (Massive/FINRA: short_interest ÷ free float),
  // carried alongside the primary (Yahoo-first) value ONLY so the cascade can flag a material
  // disagreement. NOT a first-wins sourced field — the winning shortPercentOfFloat is still chosen by
  // registration order via takeScalar. This carrier is deleted after the flag is computed and never
  // leaves the cascade (so it needs no MarketQuote / applyEnrichment wiring).
  shortPercentOfFloatSecondary?: number;
  // Set by the cascade when the primary and the second source's short interest disagree beyond the
  // threshold. Surfaced as an evidence bulletin (applyEnrichment in market.ts) rather than silently
  // trusting one source.
  shortInterestDisagreement?: string;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number;
  // Trading days until the next scheduled earnings date (Yahoo calendarEvents). Undefined when
  // the API returns no future earnings date — never fabricated to 0 / a guess.
  daysToEarnings?: number;
  // % of shares held by institutions (Yahoo institutionOwnership / majorHoldersBreakdown), 0–100.
  institutionOwnershipPct?: number;
  // Near-the-money implied volatility (%) from the opt-in Robinhood option-chain tier.
  nearTheMoneyIv?: number;
  // Put/call open-interest ratio around the money (opt-in Robinhood option-chain tier).
  putCallRatio?: number;
  // Numeric analyst price targets (FMP price-target-consensus; opt-in FMP_PRICE_TARGETS_ENABLED).
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  revenueGrowth?: number;
  freeCashFlowYield?: number;
  grossProfitMargin?: number;
  congressTradesQuiver?: number;
  insiderTradesQuiver?: number;
  govContractsQuiver?: number;
  lobbyingQuiver?: number;
  patentsQuiver?: number;
  // Which provider supplied each scalar field (filled by the cascade).
  sources?: Partial<EnrichmentSources>;
  // Each provider's own analyst read, keyed by provider name (for the Rating tooltip).
  analystBySource?: Record<string, AnalystRatingDetail>;
  /** Per-field evidence receipts; scalar fields above remain the compatibility surface. */
  fieldObservations?: EnrichmentFieldObservations;
  /** Provider failures retained alongside successful fields instead of collapsed to empty output. */
  providerFailures?: Record<string, ProviderFailureReceipt>;
  // Per-field specific 'asOf' dates (e.g. from FMP fundamentals that carry their own 'date').
  fieldDates?: Partial<Record<keyof EnrichmentSources, string>>;
}

export type EnrichmentSourcedField =
  | "price"
  | "bid"
  | "ask"
  | "intradayChangePct"
  | "vwap"
  | "asOf"
  | "sentiment"
  | "peRatio"
  | "analystRating"
  | "sector"
  | "industry"
  | "volume"
  | "dividendYield"
  | "eps"
  | "companyName"
  | "pbRatio"
  | "shortPercentOfFloat"
  | "beta"
  | "fiftyTwoWeekHigh"
  | "fiftyTwoWeekLow"
  | "insiderSentiment"
  | "fcfYield"
  | "debtToEquity"
  | "epsGrowth"
  | "senateTrades"
  | "daysToEarnings"
  | "institutionOwnershipPct"
  | "nearTheMoneyIv"
  | "putCallRatio"
  | "targetMean"
  | "targetHigh"
  | "targetLow"
  | "targetMedian"
  | "returnOnEquity"
  | "returnOnAssets"
  | "revenueGrowth"
  | "freeCashFlowYield"
  | "grossProfitMargin"
  | "congressTradesQuiver"
  | "insiderTradesQuiver"
  | "govContractsQuiver"
  | "lobbyingQuiver"
  | "patentsQuiver";

export type EnrichmentFieldObservations = Partial<
  Record<EnrichmentSourcedField, FieldObservation<unknown>>
>;

/** Per-run hint the cascade passes to paid providers when the short-circuit is on.
 *  `coveredFields[symbol]` is the set of `SymbolEnrichment` keys a free upstream
 *  (App A / congress.trade) already filled for that symbol. A provider may use it to
 *  skip the redundant SUB-calls that would only re-fetch already-covered fields —
 *  while still fetching everything else it uniquely supplies, so no field is lost. */
export interface EnrichmentContext {
  coveredFields?: Record<string, ReadonlySet<string>>;
  /** Per-symbol upstream provider of App A's analyst row (e.g. "fmp"/"finnhub"/
   *  "yahoo-finance"), so a provider only skips its OWN consensus sub-call when App A's
   *  analyst actually came from it — otherwise its independent vote must still be fetched
   *  and blended. Absent/unknown source → don't skip (treat as a distinct vote). */
  analystSource?: Record<string, string>;
}

export interface MarketEnrichmentProvider {
  name: string;
  configured: boolean;
  enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>>;
  /** Registered providers that supplied ≥1 field in the most recent enrich() run (cascade only). */
  activeSources?: string[];
  /** Cost classification for the optional short-circuit (default "free" when unset).
   *  "paid" providers receive a coverage hint so they can skip redundant sub-calls
   *  for symbols a free upstream (App A) already covered. */
  costTier?: "free" | "paid";
  /** Opt-in: this provider's quota is SCARCE enough that dispatching it against symbols a
   *  cheaper source already covered is self-defeating (e.g. YH Finance 15's real cap is 100
   *  requests per MONTH). Setting this — together with a non-empty `suppliesFields` — moves the
   *  provider out of the cascade's single concurrent wave into a SECOND wave that runs only after
   *  the free/cheap providers have resolved, and only over the symbols still missing at least one
   *  of the fields this provider can actually supply. See CascadingEnrichmentProvider.enrich and
   *  `scarceEnrichmentGateEnabled()`. Providers without this flag keep today's behavior exactly
   *  (dispatched concurrently over the full batch). */
  quotaScarce?: boolean;
  /** The `SymbolEnrichment` keys this provider is CAPABLE of supplying. Load-bearing only for a
   *  `quotaScarce` provider: the wave-two gate compares this against what wave one actually filled
   *  per symbol, so a scarce provider is never spent on a symbol where it could not add anything.
   *  Declaring it wider than reality only costs calls; declaring it NARROWER than reality can lose
   *  data (a field it uniquely supplies would never trigger a call) — so keep it in sync with the
   *  provider's parser. A `quotaScarce` provider with this unset/empty is treated as ungated (it
   *  stays in wave one) rather than silently never running. */
  suppliesFields?: readonly (keyof SymbolEnrichment)[];
  /** Credential lane this provider instance actually runs on ("user" | "env").
   *  When set, the circuit breaker only trips this provider when the health lane
   *  matching BOTH its service AND this key source is hard-stopped — so a dead
   *  env-key lane can't disable a healthy user-key provider for the same service
   *  (and vice-versa). Leave unset for keyless providers (Yahoo, etc.), which
   *  fall back to the all-lanes-for-this-service check. */
  healthKeySource?: ApiKeySource | null;
}

function flagEnabled(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
/** Opt-in: skip a *paid* fundamentals provider's fetch for a symbol that App A
 *  (congress.trade) already FULLY covered (the complete fundamentals + analyst
 *  set), to eliminate the duplicate paid call. Default OFF — when off the cascade
 *  runs every provider as before. */
function enrichmentShortCircuitEnabled(): boolean {
  // Needs the fundamentals tier (it supplies the coverage hint), not just price reads.
  return flagEnabled(process.env.ENRICHMENT_SHORT_CIRCUIT_ENABLED) && congressFundamentalsEnabled();
}

/**
 * Per-symbol coverage gate for `quotaScarce` providers — DEFAULT ON, and scoped strictly to
 * providers that opt in via `quotaScarce` + `suppliesFields`. Today that is only the RapidAPI
 * failover tier (Mboum / YH Finance 15 / Alpha Vantage-RapidAPI / Insiders / TwelveData-RapidAPI),
 * which is new and currently spends a MONTHLY-backed quota on whichever symbols happen to be
 * cache-misses first with no regard for whether the free keyless Yahoo scrape already supplied
 * that exact data. Every pre-existing provider is unaffected (they never set the flag), so
 * defaulting this ON has no regression surface for them. Set
 * `ENRICHMENT_SCARCE_TIER_GATE_ENABLED=0` to restore the old all-providers-in-one-concurrent-wave
 * behavior for the scarce tier too.
 */
export function scarceEnrichmentGateEnabled(): boolean {
  const raw = process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return flagEnabled(raw);
}

/**
 * Free-first field-demand planner — DEFAULT ON.
 *
 * Wave A: free/keyless/broker-bundled providers (`costTier !== "paid"`) over the full batch.
 * Wave B: paid non-scarce providers only for symbols that still have a coverage gap, with a
 *         `coveredFields` hint so they can skip redundant sub-calls.
 * Wave C: scarce RapidAPI failover (existing `quotaScarce` gate) for remaining field gaps.
 *
 * When a free-wave provider throws, it is retried once before the paid wave so a transient
 * timeout/429 does not permanently suppress the keyless floor for that scan.
 *
 * Set `ENRICHMENT_FREE_FIRST_ENABLED=0` to restore the prior single concurrent non-scarce wave.
 */
export function freeFirstEnrichmentEnabled(): boolean {
  const raw = process.env.ENRICHMENT_FREE_FIRST_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return flagEnabled(raw);
}

// ── Analyst scoring helpers ───────────────────────────────────────────────────
// Map ratings onto a 0–100 scale so multiple sources can be averaged.

export function labelFromAnalystScore(score: number): string {
  if (score >= 85) return "Strong Buy";
  if (score >= 65) return "Buy";
  if (score >= 45) return "Hold";
  if (score >= 25) return "Sell";
  return "Strong Sell";
}

export function analystScoreFromCounts(c: {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}): number | undefined {
  const total = c.strongBuy + c.buy + c.hold + c.sell + c.strongSell;
  if (total <= 0) return undefined;
  return (c.strongBuy * 100 + c.buy * 75 + c.hold * 50 + c.sell * 25 + c.strongSell * 0) / total;
}

// Analyst mean: 1 = Strong Buy … 5 = Strong Sell.
export function analystScoreFromMean(mean: number): number {
  return Math.max(0, Math.min(100, ((5 - mean) / 4) * 100));
}

const DEFAULT_TTL_MS = 6 * 60 * 60_000; // fundamentals move slowly; cache 6h
const CONCURRENCY = 5;
const cache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();
const originalSet = cache.set.bind(cache);
cache.set = function (key: string, value: { expiresAt: number; data: SymbolEnrichment }) {
  if (cache.size > 2000) {
    const nowMs = Date.now();
    for (const [k, val] of cache.entries()) {
      if (val.expiresAt <= nowMs) {
        cache.delete(k);
      }
    }
  }
  return originalSet(key, value);
};

// Well-known ticker mock data — real-ish values updated periodically.
const MOCK_METRICS: Record<string, Omit<SymbolEnrichment, "volume"> & Required<Pick<SymbolEnrichment, "sector" | "industry" | "peRatio" | "analystRating" | "sentiment" | "dividendYield" | "eps" | "headlines">>> = {
  AAPL: { sector: "Technology", industry: "Consumer Electronics", peRatio: 31.4, analystRating: "Buy", sentiment: 72, dividendYield: 0.44, eps: 6.97, headlines: ["Apple reaches new record high on AI optimism.", "Analysts praise Apple's new consumer AI integrations."] },
  MSFT: { sector: "Technology", industry: "Software—Infrastructure", peRatio: 35.8, analystRating: "Strong Buy", sentiment: 78, dividendYield: 0.71, eps: 12.41, headlines: ["Microsoft expanding Azure cloud capabilities globally.", "Microsoft beats earnings expectations as cloud services surge."] },
  VOO:  { sector: "ETF", industry: "Index Fund", peRatio: 25.2, analystRating: "Buy", sentiment: 60, dividendYield: 1.25, eps: 0, headlines: ["S&P 500 index fund VOO tracking towards new highs.", "Diversified index investing remains popular."] },
  NVDA: { sector: "Technology", industry: "Semiconductors", peRatio: 65.2, analystRating: "Strong Buy", sentiment: 85, dividendYield: 0.02, eps: 2.94, headlines: ["NVIDIA stock surges as AI chip demand reaches unprecedented levels.", "NVIDIA announces next-generation chip architecture."] },
  AMZN: { sector: "Consumer Cyclical", industry: "Internet Retail", peRatio: 40.5, analystRating: "Buy", sentiment: 68, dividendYield: 0, eps: 5.29, headlines: ["Amazon expands fulfillment centers to speed up delivery.", "AWS earnings exceed analyst estimates on cloud growth."] },
  TSLA: { sector: "Consumer Cyclical", industry: "Auto Manufacturers", peRatio: 55.4, analystRating: "Hold", sentiment: 48, dividendYield: 0, eps: 2.18, headlines: ["Tesla deliveries fluctuate amid high global competition.", "Tesla showcases advances in self-driving software."] },
  JPM:  { sector: "Financial Services", industry: "Banks—Diversified", peRatio: 12.1, analystRating: "Buy", sentiment: 58, dividendYield: 2.05, eps: 19.75, headlines: ["JPMorgan Chase reports strong investment banking income.", "JPMorgan expanding physical branch network in key states."] },
  GOOG: { sector: "Technology", industry: "Internet Content & Information", peRatio: 24.5, analystRating: "Buy", sentiment: 70, dividendYield: 0.45, eps: 7.54, headlines: ["Google enhances Search with new AI-powered summaries.", "Alphabet reports steady ad revenue growth."] },
  GOOGL:{ sector: "Technology", industry: "Internet Content & Information", peRatio: 24.5, analystRating: "Buy", sentiment: 70, dividendYield: 0.45, eps: 7.54, headlines: ["Alphabet reports steady ad revenue growth.", "Google AI tools expand across consumer products."] },
  META: { sector: "Technology", industry: "Internet Content & Information", peRatio: 28.2, analystRating: "Buy", sentiment: 74, dividendYield: 0.32, eps: 22.10, headlines: ["Meta platform active user counts continue to climb.", "Meta showcases open-source AI models for developers."] },
  AMD:  { sector: "Technology", industry: "Semiconductors", peRatio: 42.1, analystRating: "Buy", sentiment: 65, dividendYield: 0, eps: 3.31, headlines: ["AMD launches new processors for AI laptops.", "AMD gains server market share against key competitors."] },
  NFLX: { sector: "Communication Services", industry: "Entertainment", peRatio: 36.4, analystRating: "Buy", sentiment: 62, dividendYield: 0, eps: 22.79, headlines: ["Netflix subscriber growth accelerates on new original content.", "Netflix testing ads-supported subscription tier in new markets."] },
  INTC: { sector: "Technology", industry: "Semiconductors", peRatio: 18.2, analystRating: "Hold", sentiment: 44, dividendYield: 1.02, eps: 1.43, headlines: ["Intel reports steady progress on next-gen fabrication nodes.", "Intel cost-cutting measures improve near-term margins."] },
  DIS:  { sector: "Communication Services", industry: "Entertainment", peRatio: 21.5, analystRating: "Buy", sentiment: 56, dividendYield: 0.85, eps: 4.24, headlines: ["Disney streaming subscribers grow amid content slate expansion.", "Disney parks revenue rises on tourism demand."] },
  BA:   { sector: "Industrials", industry: "Aerospace & Defense", peRatio: 28.0, analystRating: "Hold", sentiment: 50, dividendYield: 0, eps: 3.20, headlines: ["Boeing stabilizing production after quality review.", "Boeing secures new international commercial jet orders."] },
  PFE:  { sector: "Healthcare", industry: "Drug Manufacturers", peRatio: 14.2, analystRating: "Hold", sentiment: 45, dividendYield: 6.10, eps: 2.58, headlines: ["Pfizer pipeline shows promise in oncology pipeline.", "Pfizer dividend remains sustainable amid cost restructuring."] },
  JNJ:  { sector: "Healthcare", industry: "Drug Manufacturers", peRatio: 16.4, analystRating: "Buy", sentiment: 58, dividendYield: 3.10, eps: 8.77, headlines: ["J&J pharmaceutical revenue grows on new drug approvals.", "Johnson & Johnson raises full-year revenue guidance."] },
  WMT:  { sector: "Consumer Defensive", industry: "Discount Stores", peRatio: 30.2, analystRating: "Buy", sentiment: 65, dividendYield: 1.12, eps: 2.23, headlines: ["Walmart grocery share gains continue amid consumer value focus.", "Walmart e-commerce growth accelerates internationally."] },
  BRK:  { sector: "Financial Services", industry: "Insurance", peRatio: 22.0, analystRating: "Buy", sentiment: 62, dividendYield: 0, eps: 16.40, headlines: ["Berkshire Hathaway reports strong investment portfolio returns.", "Warren Buffett continues disciplined capital allocation strategy."] },
  V:    { sector: "Financial Services", industry: "Credit Services", peRatio: 31.8, analystRating: "Strong Buy", sentiment: 71, dividendYield: 0.76, eps: 9.88, headlines: ["Visa payment volumes rise on global travel and commerce.", "Visa expanding digital payments in emerging markets."] },
  MA:   { sector: "Financial Services", industry: "Credit Services", peRatio: 35.5, analystRating: "Strong Buy", sentiment: 72, dividendYield: 0.55, eps: 13.58, headlines: ["Mastercard cross-border volumes rise on travel recovery.", "Mastercard services revenue grows ahead of expectations."] },
  UNH:  { sector: "Healthcare", industry: "Healthcare Plans", peRatio: 22.1, analystRating: "Buy", sentiment: 60, dividendYield: 1.65, eps: 26.13, headlines: ["UnitedHealth Group raises annual EPS guidance.", "UNH Optum segment delivers strong growth in care services."] },
};

function getFallbackMetrics(symbol: string): SymbolEnrichment {
  // Deterministic hash-based pseudo-data for unknown symbols.
  const hash = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const sectors = ["Technology", "Financial Services", "Consumer Cyclical", "Healthcare", "Industrials", "Consumer Defensive", "Communication Services"];
  const industries = ["Software", "Banks", "Retail", "Biotechnology", "Manufacturing", "Semiconductors", "Internet Services"];
  const ratings = ["Buy", "Hold", "Strong Buy", "Buy", "Hold"]; // weight towards Buy/Hold
  return {
    sector: sectors[hash % sectors.length],
    industry: industries[hash % industries.length],
    peRatio: 10 + (hash % 40) + 0.5,
    analystRating: ratings[hash % ratings.length],
    sentiment: 40 + (hash % 30),
    dividendYield: (hash % 300) / 100,
    eps: (hash % 2000) / 100,
    headlines: [
      `${symbol} reports quarterly results inline with guidance.`,
      `Analysts maintain stable outlook on ${symbol}.`
    ]
  };
}

function ttlMs(): number {
  const value = Number(process.env.NEWS_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

// Per-data-class TTL for the Alpaca snapshot cache (quote-family: price/bid/ask/volume/vwap) —
// composite review D/high/S: the snapshot used to share the blanket 6h `ttlMs()` fundamentals TTL,
// so real-time prices were pinned to a stale cache entry for up to 6h and `maxQuoteAgeSec` (the
// staleness gate in policy.ts) couldn't see it because `parseAlpacaSnapshot` never stamped `asOf` —
// every scan inside that window silently replayed the same quote. Quote-family data moves in
// seconds, not hours, so this gets its own short, separately-configurable TTL (default ~30s) instead
// of riding the fundamentals cadence. `ALPACA_SNAPSHOT_CACHE_TTL_MS` lets an operator tune it without
// touching the unrelated `NEWS_CACHE_TTL_MS` fundamentals knob.
const DEFAULT_ALPACA_SNAPSHOT_TTL_MS = 30_000; // ~30s — quote-family data, not fundamentals
export function alpacaSnapshotTtlMs(): number {
  const value = Number(process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS ?? DEFAULT_ALPACA_SNAPSHOT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_ALPACA_SNAPSHOT_TTL_MS;
}

// Providers enrich EVERY symbol they're asked for — the scan's candidate list (top-N ranked
// + event outliers + all held positions) IS the budget. A fixed provider-side cap starved
// whatever the scan appended past it (all-dash Fundamentals for the owner's own positions,
// prod 2026-07-09), and any hard ceiling recreates that bug the day the account outgrows it
// (owner ruling 2026-07-09: no hard cap — >50 positions is a supported future).
// FMP_MAX_SYMBOLS stays as an EXPLICIT operator throttle for quota thrift — unclamped,
// because a silently-clamped override is a cage, not a setting. Quota realities live where
// they belong: the per-provider pacers in provider-rate-limit.ts, TwelveData's credit
// window, Alpha Vantage's daily key pool, and the 6h fundamentals cache above.
function maxSymbols(): number {
  const explicit = Number(process.env.FMP_MAX_SYMBOLS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  return Number.POSITIVE_INFINITY;
}

// Collision-resistant, one-way credential lane identity. It is now persisted in the durable
// dispatch ledger, so a 32-bit process-local hash is insufficient: an accidental collision could
// conflate unrelated account quotas. The literal key is never logged or stored.
export async function apiKeyFingerprint(apiKey: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Short negative-cache TTL for symbols a rate-limited provider returns no usable data for, so they
// don't sit at the FRONT of `misses` forever starving lower-ranked symbols of a scarce free-tier
// budget. Default 30 min: long enough to rotate a no-data symbol out for several scans, short enough
// that a symbol which later gains coverage isn't suppressed for long.
const DEFAULT_PROVIDER_NEGATIVE_TTL_MS = 30 * 60_000;
function providerNegativeTtlMs(): number {
  const value = Number(process.env.PROVIDER_NEGATIVE_TTL_MS ?? DEFAULT_PROVIDER_NEGATIVE_TTL_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROVIDER_NEGATIVE_TTL_MS;
  return value;
}

// How many outbound requests one enriched symbol costs a quota'd provider — passed to the request
// quota (which budgets in REQUESTS, not symbols). Only providers in RATE_QUOTAS need this: tiingo
// fires up to 3 sub-calls/symbol (iex, daily, [news]); twelvedata costs 1 credit/symbol; fmp fires
// 2 unconditional (profile + insider) plus up to 3 conditional (ratios-ttm, grades-consensus,
// price-target-consensus). Non-quota'd providers (finnhub, yahoo, alpha-vantage) are paced instead
// and never consult this.
export function callsPerSymbol(
  provider: string,
  opts?: { dropExtra?: boolean; skipPe?: boolean; skipConsensus?: boolean; wantTargets?: boolean }
): number {
  switch (provider) {
    case "tiingo": return opts?.dropExtra ? 2 : 3;  // iex, daily, [news]
    // 2 unconditional (profile + insider) + ratios-ttm (unless skipPe) + grades-consensus (unless
    // skipConsensus) + price-target-consensus (only when wantTargets). Mirrors the fetch-path
    // conditions one-for-one; range 2..5. The caller MUST derive skipPe/skipConsensus/wantTargets
    // from the SAME skipFlagsFor(symbol) + wantTargets formula it dispatches with, so reservation
    // equals dispatch per symbol.
    case "fmp": return 2 + (opts?.skipPe ? 0 : 1) + (opts?.skipConsensus ? 0 : 1) + (opts?.wantTargets ? 1 : 0);
    default: return 1;                               // twelvedata (1 credit/symbol)
  }
}

/** Test-only compatibility shim: the unified request quota replaced the old per-provider window
 *  gates, so resetting "the Twelve Data window" now just clears the shared quota state. */
export function __resetTwelveDataWindowForTests(): void {
  resetProviderQuotaState();
}

export interface FetchWithRetryGuard {
  /** Synchronous durable-ownership assertion run at every transport and telemetry boundary. */
  assertActive: () => void;
  /** Optional cancellation signal used to interrupt an internal 429 backoff. */
  signal?: AbortSignal;
}

function assertFetchWithRetryGuard(guard: FetchWithRetryGuard | undefined): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    throw guard.signal.reason instanceof Error ? guard.signal.reason : new Error("Provider request cancelled.");
  }
  guard.assertActive();
}

async function guardedFetchBackoff(delayMs: number, guard: FetchWithRetryGuard | undefined): Promise<void> {
  assertFetchWithRetryGuard(guard);
  if (delayMs <= 0) return;
  const signal = guard?.signal;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    assertFetchWithRetryGuard(guard);
    return;
  }
  const abortSignal = signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      abortSignal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", abort);
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Provider request cancelled."));
    }
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();
  });
  assertFetchWithRetryGuard(guard);
}

// One retry on HTTP 429 (rate limit) with a short backoff before giving up.
/**
 * Central tracked provider request boundary. Exported for provider-specific modules that live
 * outside this file (for example, earnings-transcript ingestion) so they inherit the same circuit
 * breaker, secret-scrubbed health logging, and usage.jays.services call-volume telemetry.
 *
 * Callers that reserve an exact provider quota should pass `retries: 0` and implement any retry as
 * another invocation of this function. That way every actual upstream attempt is independently
 * reserved and metered instead of hiding an uncounted retry inside one logical call.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    retries?: number;
    backoffMs?: number;
    /**
     * Optional health/circuit lane when it must be narrower than the billable provider name.
     * `service` remains the usage-attribution provider; omitting this preserves legacy behavior.
     */
    healthService?: string;
    service?: string;
    keySource?: string;
    userId?: string;
    deferSuccessLog?: boolean;
    /**
     * Defer successful provider-call telemetry until the caller validates an HTTP-success body.
     * Failure responses and transport errors remain recorded here. The caller must record exactly
     * one success or failure usage event after validating each deferred successful response.
     */
    deferSuccessUsage?: boolean;
    suppressHealthStatuses?: number[];
    /**
     * Optional durable-operation fence. When ownership is lost, the transport result/error is
     * propagated without writing health or provider-call telemetry for the successor's operation.
     */
    guard?: FetchWithRetryGuard;
    /** Lease-independent durable attempt hooks. They run immediately around the actual global
     * fetch call, before any post-response ownership assertion can suppress usage truth. */
    durableAttempt?: {
      onDispatch: () => void;
      onResponse?: (response: Response) => void;
      onTransportError?: (error: unknown) => void;
    };
    // This provider's own API key (if any) — scrubbed out of any errorText logged below so
    // a leaked query-param or echoed-back value never reaches api_health_log verbatim.
    apiKey?: string;
  } = {}
): Promise<Response> {
  const retries = options.retries ?? 1;
  const backoffMs = options.backoffMs ?? 600;
  const healthService = options.healthService ?? options.service;
  assertFetchWithRetryGuard(options.guard);
  // Per-credential-lane circuit breaker: short-circuit a call whose (service, keySource) lane is
  // currently backed off (recently stopped working). Thrown BEFORE the fetch so no health row is
  // written for the skip (which would self-perpetuate the trip); providers catch the rejection and
  // degrade to the next tier exactly like a real fetch failure.
  if (healthService) {
    const breaker = apiCircuitBreakerShouldSkip(healthService, options.keySource ?? null);
    if (breaker.skip) throw new CircuitOpenError(healthService, options.keySource ?? null, breaker.reason);
  }
  const start = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      assertFetchWithRetryGuard(options.guard);
      options.durableAttempt?.onDispatch();
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        options.durableAttempt?.onTransportError?.(error);
        throw error;
      }
      options.durableAttempt?.onResponse?.(response);
      // A transport may settle after its caller's durable lease has moved. Fence the response before
      // any health/provider ledger and before deciding whether an internal retry should run.
      assertFetchWithRetryGuard(options.guard);
      if (response.status === 429 && attempt < retries) {
        if (healthService) {
          assertFetchWithRetryGuard(options.guard);
          logApiHealth({
            service: healthService,
            ok: false,
            latencyMs: Date.now() - start,
            errorText: "HTTP 429 (rate limited, retrying)",
            keySource: options.keySource,
            userId: options.userId,
          });
        }
        await guardedFetchBackoff(backoffMs * (attempt + 1), options.guard);
        continue;
      }
      // When deferSuccessLog is set, skip the auto-success row so the caller can log
      // after validating the response body (e.g. providers that embed errors in HTTP 200).
      // HTTP failure rows are still written here regardless of the flag.
      const suppressHealth = !response.ok && (options.suppressHealthStatuses ?? []).includes(response.status);
      if (healthService && !(response.ok && options.deferSuccessLog) && !suppressHealth) {
        assertFetchWithRetryGuard(options.guard);
        logApiHealth({
          service: healthService,
          ok: response.ok,
          latencyMs: Date.now() - start,
          errorText: response.ok ? undefined : scrubProviderErrorText(`HTTP ${response.status}`, options.apiKey),
          keySource: options.keySource,
          userId: options.userId,
        });
      }
      // Call-volume telemetry: one logical market-data call per fetchWithRetry invocation
      // (no-op unless the usage monitor is configured; never throws).
      if (options.service && !options.durableAttempt && !(response.ok && options.deferSuccessUsage)) {
        assertFetchWithRetryGuard(options.guard);
        recordProviderCall(options.service, { ok: response.ok, keySource: options.keySource, userId: options.userId });
      }
      return response;
    }
  } catch (err) {
    // If this was an abort/lost-ownership race, the guard throws here and deliberately bypasses all
    // failure telemetry. This check also catches a transport error that won the Promise race just
    // before the lease signal itself became observable.
    assertFetchWithRetryGuard(options.guard);
    if (healthService) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      // err.cause carries the actual network-layer failure (ECONNREFUSED, DNS, etc.) that
      // "fetch failed" alone omits — append it (truncated) before scrubbing so the health
      // row is diagnosable without also leaking a URL-embedded API key.
      const errorText = scrubProviderErrorText(appendErrorCause(rawMessage, err), options.apiKey);
      assertFetchWithRetryGuard(options.guard);
      logApiHealth({
        service: healthService,
        ok: false,
        latencyMs: Date.now() - start,
        errorText,
        keySource: options.keySource,
        userId: options.userId,
      });
    }
    if (options.service && !options.durableAttempt) {
      assertFetchWithRetryGuard(options.guard);
      recordProviderCall(options.service, { ok: false, keySource: options.keySource, userId: options.userId });
    }
    throw err;
  }
}

// Map a consensus label back to a representative 0–100 score, so App A rows that
// carry only a `rating` string (no buy/sell counts) still flow through the
// cascade's analystBySource blend (it builds the displayed rating from scores,
// not from a raw analystRating scalar).
const ANALYST_LABEL_SCORE: Record<string, number> = {
  "strong buy": 90,
  buy: 70,
  outperform: 70,
  overweight: 70,
  accumulate: 70,
  hold: 50,
  neutral: 50,
  "market perform": 50,
  underperform: 30,
  underweight: 30,
  reduce: 30,
  sell: 30,
  "strong sell": 10,
};
function scoreFromAnalystLabel(label: string): number | undefined {
  return ANALYST_LABEL_SCORE[label.trim().toLowerCase()];
}
// Short TTL for a *negative* App A cache entry (a symbol App A had nothing fresh
// for). Long enough to stop re-hitting both endpoints on back-to-back scans, short
// enough that a newly-pushed row is picked up the same day.
const CONGRESS_NEG_TTL_MS = 60 * 60_000; // 1h
// How stale an App A row may be before we treat it as a cache miss and let the
// fresh paid providers win instead. Fundamentals move slowly, but a paused
// cross-app push or an old backfilled-only row should not override current data.
function congressMaxStaleMs(): number {
  const days = Number(process.env.CONGRESS_TRADE_MAX_STALE_DAYS ?? 21);
  return (Number.isFinite(days) && days > 0 ? days : 21) * 86_400_000;
}
function rowIsFresh(row: { date?: string | null; updatedAt?: string | null }, now: number): boolean {
  // Judge freshness by the row's market-data `date`, NOT `updatedAt`: a backfill run
  // today bumps `updatedAt` while the underlying data is months old, and such a stale
  // row must fall through to the live paid providers rather than override them. Fall
  // back to `updatedAt` only when `date` is absent.
  const stamp = row.date || row.updatedAt;
  if (!stamp) return false;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  // Reject FUTURE-dated rows (clock skew / bad import / accidental future as-of date): a
  // negative age would otherwise sail through the max-stale check and let future-dated
  // fundamentals/analyst data win first-wins ahead of current providers. Allow a small
  // skew so a date-only stamp from a timezone ahead of UTC (parsed as UTC midnight) isn't
  // mistaken for the future; anything beyond that is not real data.
  const FUTURE_SKEW_MS = 2 * 86_400_000;
  if (age < -FUTURE_SKEW_MS) return false;
  return age <= congressMaxStaleMs();
}

// ── Congress.Trade (App A) cross-app read tier ───────────────────────────────
// Reads fundamentals + analyst consensus that App A already stored (it ingests
// the same providers + receives our donated data), so App B doesn't re-derive
// numbers App A has. Default-OFF (CONGRESS_TRADE_READS_ENABLED); fills only
// fundamentals/analyst fields (no price), so it never disturbs real-time quote
// ordering. Seated ahead of the paid fundamentals providers so its free,
// congressional-universe data wins those fields when present. Reads go through
// the same 6h enrichment cache as the other slow-moving providers, and stale App A
// rows fall through so they don't override fresh paid data.
export class CongressTradeEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "congress.trade";
  constructor(private readonly userId?: string) {}
  get configured(): boolean {
    return congressFundamentalsEnabled();
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    if (!congressFundamentalsEnabled()) return {};
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    // Cache hits short-circuit before any HTTP — repeated scans don't re-hit App A.
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, false, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const client = getCongressTradeClient();
    await Promise.all(
      misses.map(async (symbol) => {
        // Track whether EITHER read failed at the transport level (timeout/5xx/401 →
        // []). A genuine "App A has nothing" (both reads OK, no fresh rows) is
        // negative-cached; a transport error is NOT, so a fixed outage/token is retried
        // on the next scan instead of being suppressed for the whole negative TTL.
        let transportError = false;
        // Bound the pull to the freshness window: rowIsFresh discards anything older than
        // CONGRESS_TRADE_MAX_STALE_DAYS, so there's no point downloading the full history.
        const fromDate = new Date(now - congressMaxStaleMs()).toISOString().slice(0, 10);
        const [fundamentals, analyst] = await Promise.all([
          congressFundamentalsEnabled() ? client.getFundamentals(symbol, { from: fromDate }).catch(() => { transportError = true; return [] as FundamentalRow[]; }) : Promise.resolve([] as FundamentalRow[]),
          congressFundamentalsEnabled() ? client.getAnalyst(symbol, { from: fromDate }).catch(() => { transportError = true; return [] as AnalystRow[]; }) : Promise.resolve([] as AnalystRow[]),
        ]);

        // Do NOT log a synthetic health failure here: the shared getCongressTradeClient()
        // fetch wrapper already records a `congress.trade` logApiHealth({ ok: false }) for
        // every failed HTTP/transport call. Adding a per-symbol failure on top would
        // double-count into the last-N health window and trip the enrichment circuit
        // breaker earlier than the real upstream request count warrants. The transportError
        // flag below is retained solely to gate negative-caching.
        // App A may return multiple fresh rows from different sources; merge the LATEST
        // non-null value per field across all of them (rows are date-ascending), so a
        // partial latest row doesn't discard a field an earlier fresh row supplied.
        const freshFunds = fundamentals.filter((r) => rowIsFresh(r, now));
        const freshAnalysts = analyst.filter((r) => rowIsFresh(r, now));
        const latestFund = <K extends keyof FundamentalRow>(
          key: K,
          valid: (v: NonNullable<FundamentalRow[K]>) => boolean = () => true
        ): NonNullable<FundamentalRow[K]> | undefined => {
          for (let i = freshFunds.length - 1; i >= 0; i--) {
            const v = freshFunds[i][key];
            if (v != null && valid(v as NonNullable<FundamentalRow[K]>)) return v as NonNullable<FundamentalRow[K]>;
          }
          return undefined;
        };
        const latestAnalyst = <K extends keyof AnalystRow>(
          key: K,
          valid: (v: NonNullable<AnalystRow[K]>) => boolean = () => true
        ): NonNullable<AnalystRow[K]> | undefined => {
          for (let i = freshAnalysts.length - 1; i >= 0; i--) {
            const v = freshAnalysts[i][key];
            if (v != null && valid(v as NonNullable<AnalystRow[K]>)) return v as NonNullable<AnalystRow[K]>;
          }
          return undefined;
        };
        const e: SymbolEnrichment = {};
        if (freshFunds.length) {
          // Validity filters: a non-positive P/E or 52-week high/low is a sentinel for
          // "no real value", not a usable number — drop so they never win first-wins.
          const pe = latestFund("peRatio", (v) => v > 0); if (pe !== undefined) e.peRatio = pe;
          const eps = latestFund("eps"); if (eps !== undefined) e.eps = eps;
          const beta = latestFund("beta"); if (beta !== undefined) e.beta = beta;
          const dy = latestFund("dividendYield"); if (dy !== undefined) e.dividendYield = dy;
          const hi = latestFund("week52High", (v) => v > 0); if (hi !== undefined) e.fiftyTwoWeekHigh = hi;
          const lo = latestFund("week52Low", (v) => v > 0); if (lo !== undefined) e.fiftyTwoWeekLow = lo;
          const fcf = latestFund("fcfYield"); if (fcf !== undefined) e.fcfYield = fcf;
          const de = latestFund("debtToEquity"); if (de !== undefined) e.debtToEquity = de;
          const eg = latestFund("epsGrowth"); if (eg !== undefined) e.epsGrowth = eg;
        }
        if (freshAnalysts.length) {
          // Targets are independent scalars — fill each from the latest fresh row that has
          // a POSITIVE value (App A can carry a 0/negative sentinel; the direct FMP parser
          // keeps only positives, so a bad App A target must not win first-wins or, under
          // the short-circuit, suppress FMP's valid target call).
          const pos = (v: number) => v > 0;
          const tMean = latestAnalyst("targetMean", pos); if (tMean !== undefined) e.targetMean = tMean;
          const tHigh = latestAnalyst("targetHigh", pos); if (tHigh !== undefined) e.targetHigh = tHigh;
          const tLow = latestAnalyst("targetLow", pos); if (tLow !== undefined) e.targetLow = tLow;
          const tMed = latestAnalyst("targetMedian", pos); if (tMed !== undefined) e.targetMedian = tMed;
          // The rating/counts/source form ONE coherent unit — take them from the latest
          // fresh row that actually yields a score (keeps the source key consistent with
          // the counts it came from), rather than mixing a rating from one source with
          // counts from another.
          for (let i = freshAnalysts.length - 1; i >= 0; i--) {
            const a = freshAnalysts[i] as AppAAnalystRow;
            const counts = {
              strongBuy: a.strongBuy ?? 0,
              buy: a.buy ?? 0,
              hold: a.hold ?? 0,
              sell: a.sell ?? 0,
              strongSell: a.strongSell ?? 0,
            };
            // Prefer counts; fall back to the label so rating-only rows still surface
            // (the cascade derives the rating from analystBySource, not analystRating).
            const score = analystScoreFromCounts(counts) ?? (a.rating ? scoreFromAnalystLabel(a.rating) : undefined);
            if (score === undefined) continue;
            const total = counts.strongBuy + counts.buy + counts.hold + counts.sell + counts.strongSell;
            // Key the analyst entry under the UPSTREAM provider App A got it from (e.g.
            // "fmp"/"finnhub"/"yahoo-finance"), not "congress.trade". The cascade blends
            // analystBySource by key; if that same direct provider also runs, its entry
            // overwrites this one (Object.assign) instead of counting the identical
            // consensus as a second independent vote. Only when App A's source is unknown
            // do we fall back to our own name so it still surfaces as a distinct read.
            const sourceKey = a.source?.trim() ? a.source.trim().toLowerCase() : this.name;
            e.analystRating = a.rating || labelFromAnalystScore(score);
            e.analystScore = Math.round(score);
            e.analystBySource = {
              [sourceKey]: {
                score: Math.round(score),
                label: a.rating || labelFromAnalystScore(score),
                ...(total > 0 ? { counts } : {}),
              },
            };
            break;
          }
        }
        if (Object.keys(e).length > 0) {
          result[symbol] = e;
          // Return e for THIS scan regardless, but only CACHE it when neither read failed:
          // if one endpoint errored, caching the surviving half would suppress retry of the
          // failed side for the whole TTL after the outage/token is fixed.
          if (!transportError) {
            // A PARTIAL hit — one field group actually contributed values and the other did
            // not (e.g. fundamentals landed but the analyst push is minutes behind, OR a fresh
            // row existed but carried only invalid/empty values) — must not be cached as
            // complete under the full TTL, or the late-arriving half can't surface for hours.
            // Judge by CONTRIBUTED fields, not just whether a fresh row existed. Cache a partial
            // briefly (negative TTL); cache a complete both-halves row at the full TTL.
            const FUND_KEYS = ["peRatio", "eps", "beta", "dividendYield", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fcfYield", "debtToEquity", "epsGrowth"] as const;
            const ANALYST_KEYS = ["analystBySource", "analystRating", "analystScore", "targetMean", "targetHigh", "targetLow", "targetMedian"] as const;
            const haveFund = FUND_KEYS.some((k) => e[k] !== undefined);
            const haveAnalyst = ANALYST_KEYS.some((k) => e[k] !== undefined);
            const partial = haveFund !== haveAnalyst;
            const expiry = now + (partial ? CONGRESS_NEG_TTL_MS : ttlMs());
            writeEnrichmentCache(this.name, symbol, "shared", this.userId, e, expiry);
          }
        } else if (!transportError) {
          // Negative cache ONLY a genuine "App A had nothing fresh" — never a transport
          // error. Remember the miss briefly so repeated scans don't re-hit both
          // endpoints every time; short TTL so a newly-pushed row is picked up soon.
          writeEnrichmentCache(this.name, symbol, "shared", this.userId, {}, now + CONGRESS_NEG_TTL_MS);
        }
      })
    );
    return result;
  }
}

// ── Provider factory ────────────────────────────────────────────────────────
// Builds a cascade: [Finnhub?, FMP?] → Yahoo Finance.
// Yahoo Finance requires no API key and is always the final real tier.

// Stamp a keyed provider with the credential lane it actually runs on, so the
// circuit breaker only trips it when the health lane matching BOTH its service
// AND this key source is hard-stopped (see applyCircuitBreaker). Keyless
// providers are pushed without this and keep the all-lanes-for-service behavior.
function withHealthLane(provider: MarketEnrichmentProvider, source: ApiKeySource): MarketEnrichmentProvider {
  provider.healthKeySource = source;
  return provider;
}

export function getEnrichmentProvider(userId?: string): MarketEnrichmentProvider {
  const providers: MarketEnrichmentProvider[] = [];
  const finnhub = resolveApiKeyWithSource("finnhub", userId);
  const alphaVantage = resolveAlphaVantageKeyPool(userId);
  const fmp = resolveApiKeyWithSource("fmp", userId);
  const roic = resolveApiKeyWithSource("roic", userId);
  const fintech = resolveApiKeyWithSource("fintechstudios", userId);
  const tiingo = resolveApiKeyWithSource("tiingo", userId);
  const twelvedata = resolveApiKeyWithSource("twelvedata", userId);
  const massive = resolveApiKeyWithSource("massive", userId);
  // Single shared operator credential for all three RapidAPI-hosted providers below (Mboum
  // Finance, YH Finance 15, Alpha Vantage RapidAPI transport) — no per-user variant, matching how
  // the owner provisioned it (one RAPIDAPI_KEY env var covers every RapidAPI-hosted product).
  const rapidApiKey = resolveRapidApiKey();
  // Alpaca MARKET DATA: own key (individual) → operator's paper key (shared) for background/tenants.
  // Trading is unaffected (alpaca.ts resolves Alpaca strictly per-user).
  const alpacaData = resolveAlpacaMarketData(userId);
  // ── Freshness-tier ordering (first-wins cascade) ──────────────────────────
  // The cascade below is first-wins per field (takeScalar keeps the first non-undefined
  // value). So provider ORDER decides which source wins the price-family fields
  // (price / bid / ask / volume / vwap / intradayChangePct). To make the MOST CURRENT
  // source win those fields, the real-time market-data provider must resolve FIRST —
  // ahead of delayed sources (webull/robinhood/finnhub/etc.).
  //
  // Tier 1 — REAL-TIME market data: Alpaca's IEX snapshot. It supplies ONLY the
  // price-family fields (price/bid/ask/volume/vwap/intradayChangePct) and no
  // fundamentals/analyst/sentiment, so seating it first wins real-time quotes
  // WITHOUT disturbing fundamentals sourcing (still finnhub/fmp/yahoo below). It
  // self-skips when either Alpaca key is absent — then the delayed sources fill these
  // fields in exactly the same order they would today.
  if (alpacaData.apiKey && alpacaData.secretKey) providers.push(withHealthLane(new AlpacaSnapshotEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey, alpacaData.source, userId), alpacaData.source));
  // Tier 1.5 — Congress.Trade cross-app cache (fundamentals/analyst only, no price).
  // Gated by its OWN flag (CONGRESS_TRADE_FUNDAMENTALS_ENABLED), separate from the
  // price/history reads, so enabling price cache-aside doesn't silently give App A
  // precedence over the direct fundamentals providers. Default-OFF.
  if (congressFundamentalsEnabled()) providers.push(new CongressTradeEnrichmentProvider(userId));
  // Tier 2 — DELAYED quotes + fundamentals, in availability order (unchanged relative ordering).
  if (webullUnofficialEnabled()) providers.push(new WebullUnofficialEnrichmentProvider());
  // First-party Robinhood fundamentals — opt-in: requires ROBINHOOD_ADAPTER=mcp (connected)
  // AND ROBINHOOD_ENRICHMENT_ENABLED, because the broker field set/units should be verified
  // against /api/admin/robinhood-probe before trusting them next to other real numbers.
  // (This is delayed/averaged fundamentals — e.g. average_volume — not a real-time quote,
  // so it stays in the delayed tier rather than next to the Alpaca snapshot.)
  if (robinhoodEnrichmentEnabled()) providers.push(new RobinhoodEnrichmentProvider(userId));
  if (tiingo.key) providers.push(withHealthLane(new TiingoEnrichmentProvider(tiingo.key, tiingo.source, userId), tiingo.source));
  if (fintech.key) providers.push(withHealthLane(new FintechStudiosEnrichmentProvider(fintech.key, fintech.source, userId), fintech.source));
  if (finnhub.key) providers.push(withHealthLane(new FinnhubEnrichmentProvider(finnhub.key, finnhub.source, userId), finnhub.source));
  if (twelvedata.key) providers.push(withHealthLane(new TwelveDataEnrichmentProvider(twelvedata.key, twelvedata.source, userId), twelvedata.source));
  // Alpaca's free Benzinga news (one batched call covers all scan symbols) — placed ahead of
  // Alpha Vantage so it supplies headlines/sentiment, demoting AV's redundant NEWS_SENTIMENT.
  if (alpacaData.apiKey) providers.push(withHealthLane(new AlpacaNewsEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey || undefined, alpacaData.source, userId), alpacaData.source));
  // AV supplies ONLY NEWS_SENTIMENT (see AlphaVantageEnrichmentProvider.enrich). When Alpaca news
  // is already configured (the availability check above — apiKey presence), it fully covers that
  // field and AV would add nothing but burn its 25/day free cap. Skip registering AV in that case
  // so it stops appearing in `source` attribution (which is derived from providers that actually
  // ran) and stops producing a daily quota alert for a field nothing consumes.
  if (alphaVantage.keys.length > 0 && !alpacaData.apiKey) {
    providers.push(withHealthLane(new AlphaVantageEnrichmentProvider(alphaVantage.keys, alphaVantage.source, userId), alphaVantage.source));
  } else if (alphaVantage.keys.length > 0) {
    console.log("[data-providers] Alpha Vantage deregistered: Alpaca news already covers NEWS_SENTIMENT");
  }
  if (fmp.key) providers.push(withHealthLane(new FmpEnrichmentProvider(fmp.key, fmp.source, userId), fmp.source));
  if (roic.key) providers.push(withHealthLane(new RoicAiEnrichmentProvider(roic.key, roic.source, userId), roic.source));
  // Massive REST: REAL second short-interest source (FINRA short interest / free float) for the
  // Yahoo-vs-Massive disagreement cross-check. Supplies ONLY the carrier shortPercentOfFloatSecondary
  // (no price/fundamentals), so ordering doesn't affect first-wins fields. Registered only when a
  // MASSIVE_API_KEY is present AND massiveShortInterestEnabled() (default ON) — inert otherwise.
  if (massive.key && massiveShortInterestEnabled()) providers.push(withHealthLane(new MassiveEnrichmentProvider(massive.key, massive.source, userId), massive.source));
  // SEC EDGAR XBRL: keyless, default-ON. Fills debtToEquity from authoritative SEC filings.
  // Positioned after FMP (paid key wins) but before Yahoo (keyless fallback) so SEC authoritative
  // data supersedes Yahoo's scraped values. Set SEC_XBRL_ENRICHMENT_ENABLED=0 to disable.
  if (secXbrlEnrichmentEnabled()) providers.push(new SecXbrlEnrichmentProvider());
  // FilingAPI.dev (FILINGAPI / FILINGAPI_KEY): company sector/industry, earnings calendar,
  // insider summary — scarce free-tier (50/day) so wave-C only.
  const filingApi = resolveApiKeyWithSource("filingapi", userId);
  if (filingApi.key) {
    providers.push(withHealthLane(new FilingApiEnrichmentProvider(filingApi.key, filingApi.source, userId), filingApi.source));
  }
  // Opt-in Robinhood option-chain tier (near-the-money IV + put/call ratio). Default OFF and inert
  // unless Robinhood MCP is connected — a long-TTL, low-frequency source with its own cache. Seated
  // late so it only fills the options-specific fields nothing else supplies.
  if (robinhoodOptionsEnrichmentEnabled() && robinhoodMcpDataEnabled()) {
    providers.push(new RobinhoodOptionsEnrichmentProvider(userId));
  }
  // QuiverQuant: supplies ONLY the five *Quiver carrier fields (congress/insider trades, gov
  // contracts, lobbying, patents) nothing else in the cascade produces, so seating it here is
  // low-stakes for ordering. Key-gated on QUIVER_API_KEY (process.env only) — absent key means
  // it's never registered, i.e. fully dormant. See src/lib/quiver-provider.ts.
  const quiverKey = resolveQuiverApiKey();
  if (quiverKey) providers.push(withHealthLane(new QuiverEnrichmentProvider(quiverKey), "env"));
  // Keyless Nasdaq quote/summary/holdings — free-wave redundancy beside Yahoo (no crumb handshake).
  // Seated just before Yahoo so both participate in wave A; first-wins still prefers earlier paid
  // tiers when they filled a field.
  providers.push(new NasdaqQuoteEnrichmentProvider());
  providers.push(new YahooFinanceEnrichmentProvider());
  // Tier LAST — RapidAPI-hosted FAILOVER redundancy for the free scrape above (see the big doc
  // comment on the provider classes + rapidapi-quota.ts). Dormant unless RAPIDAPI_KEY is set.
  // Scarce providers (Mboum / YH15 / AV-RapidAPI / Insiders / TwelveData-RapidAPI) declare
  // `quotaScarce` + `suppliesFields` so the free-first planner's wave C only spends them on
  // symbols still missing those fields. FMP-RapidAPI is costTier "free" / not scarce so it
  // participates in the free wave (extra fundamentals without a native FMP key).
  if (rapidApiKey) {
    // Mboum first (owner: prioritize by lowest disclosed RapidAPI-listing latency, 1663ms vs YH
    // Finance 15's 1757ms) — near-identical, so this is a tie-break, not a meaningful difference.
    providers.push(withHealthLane(
      new SteadyApiEnrichmentProvider("mboum-finance", "mboum-finance.p.rapidapi.com", "", "symbol", "symbol", false, rapidApiKey, "env", userId),
      "env"
    ));
    providers.push(withHealthLane(
      new SteadyApiEnrichmentProvider("yahoo-finance15", "yahoo-finance15.p.rapidapi.com", "/api", "ticker", "ticker", true, rapidApiKey, "env", userId),
      "env"
    ));
    providers.push(withHealthLane(new AlphaVantageRapidApiEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    providers.push(withHealthLane(new FmpRapidApiEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    providers.push(withHealthLane(new InsidersRapidApiEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    providers.push(withHealthLane(new TwelveDataRapidApiEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    // Additional RapidAPI free-tier failover lanes. Working Pricing page (verified):
    //   real-time-finance-data: https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-finance-data/pricing
    // yh-finance / seeking-alpha hub listings currently return API not found (delisted);
    // providers stay as scarce failover if a key gains access.
    providers.push(withHealthLane(new YhFinanceApiDojoEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    providers.push(withHealthLane(new RealTimeFinanceDataEnrichmentProvider(rapidApiKey, "env", userId), "env"));
    providers.push(withHealthLane(new SeekingAlphaRapidApiEnrichmentProvider(rapidApiKey, "env", userId), "env"));
  }
  // Opt-in active circuit breaker: skip a lane whose db-health lane is currently `stoppedWorking`,
  // re-probing only after the backoff window. Default OFF so it can't silently black out a
  // currently-working provider. When off, the raw provider list runs exactly as before.
  const effective = enrichmentCircuitBreakerEnabled() ? applyCircuitBreaker(providers) : providers;
  // Always wrap in the cascade — even for a single provider — so per-field source
  // stamping and analyst blending happen uniformly.
  return new CascadingEnrichmentProvider(effective);
}

// A provider that contributes NOTHING (used to no-op a lane the circuit breaker has tripped). It keeps
// the lane's NAME so MarketScan.source attribution and cascade ordering are unaffected structurally,
// but returns empty enrichment so no failing call is issued this scan.
class SkippedEnrichmentProvider implements MarketEnrichmentProvider {
  readonly configured = true;
  constructor(readonly name: string, private readonly reason: string) {}
  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const out: Record<string, SymbolEnrichment> = {};
    for (const s of symbols) out[normalizeSymbol(s)] = {};
    return out;
  }
  get skipReason(): string {
    return this.reason;
  }
}

// Consult db-health and replace any lane currently flagged `stoppedWorking` (5 consecutive failures,
// scoped per credential lane) with a no-op — UNLESS the backoff window has elapsed since its last
// failure, in which case we let it re-probe once. Maps provider names to the `service` names used by
// logApiHealth so the two line up (e.g. "robinhood-fundamentals" logs under "robinhood-broker").
export function applyCircuitBreaker(providers: MarketEnrichmentProvider[]): MarketEnrichmentProvider[] {
  let summaries: ReturnType<typeof getServiceHealthSummaries>;
  try {
    summaries = getServiceHealthSummaries();
  } catch {
    return providers; // health read must never break a scan — fail open.
  }
  if (summaries.length === 0) return providers;
  const backoffMs = enrichmentCircuitBreakerBackoffMinutes() * 60_000;
  const now = Date.now();
  return providers.map((p) => {
    const service = healthServiceForProvider(p.name);
    // A provider maps to one or more health lanes (credential lanes). When the provider declares the
    // credential lane it runs on (healthKeySource), only that lane's health can trip it — a dead env-key
    // lane must not black out a healthy user-key provider for the same service (and vice-versa). Keyless
    // providers (healthKeySource unset) keep the all-lanes-for-service check. Trip only when EVERY
    // considered lane is stopped — a working lane means the provider can still serve someone.
    const lane = p.healthKeySource;
    const lanes = summaries.filter((s) => s.service === service && (lane == null || s.keySource === lane));
    if (lanes.length === 0) return p;
    // Only the 5-consecutive-failure condition trips the breaker. `stoppedWorking` is also set by
    // softer heuristics ("active this hour but no success yet") that a SINGLE cold failure on a
    // newly-configured provider satisfies — those must not black out a provider for the whole
    // backoff window. Trip only when EVERY lane for the service is in hard consecutive-failure.
    const laneHardStopped = (s: (typeof lanes)[number]) =>
      s.stoppedWorking && s.stoppedReason === HEALTH_REASON_CONSECUTIVE_FAILURES;
    const allStopped = lanes.every(laneHardStopped);
    if (!allStopped) return p;
    // Re-probe if enough time has passed since the most recent failure across the stopped lanes.
    const lastFailureTs = lanes
      .map((s) => (s.lastFailureTs ? Date.parse(s.lastFailureTs) : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (lastFailureTs > 0 && now - lastFailureTs >= backoffMs) return p; // backoff elapsed → let it try.
    const reason = lanes.find((s) => s.stoppedReason)?.stoppedReason ?? "stopped working";
    console.warn(`[data-providers] circuit breaker: skipping "${p.name}" (health service "${service}") — ${reason}`);
    return new SkippedEnrichmentProvider(p.name, reason);
  });
}

// Map an enrichment provider name to the db-health `service` name its calls log under. Most match 1:1;
// the Robinhood fundamentals/options tiers both funnel through the "robinhood-broker" MCP lane.
function healthServiceForProvider(providerName: string): string {
  if (providerName === "robinhood-fundamentals" || providerName === "robinhood-options") return "robinhood-broker";
  return providerName;
}

// ── Mock / fallback provider (always configured) ────────────────────────────

export const mockEnrichmentProvider: MarketEnrichmentProvider = {
  name: "mock-enrichment",
  configured: true,
  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const result: Record<string, SymbolEnrichment> = {};
    for (const raw of symbols) {
      const symbol = normalizeSymbol(raw);
      if (!symbol) continue;
      result[symbol] = MOCK_METRICS[symbol] ?? getFallbackMetrics(symbol);
    }
    return result;
  }
};

// Keep the old export name for any code that references it.
export const noopProvider = mockEnrichmentProvider;

// ── Cascading provider ──────────────────────────────────────────────────────
// Runs all child providers in parallel. For each scalar field it takes the first
// non-undefined value (Finnhub fills what it can, FMP fills gaps, Yahoo fills the
// rest) and records which provider supplied it. Analyst ratings are NOT first-wins:
// every provider's read is collected and blended into one 0–100 score + label.

export class CascadingEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name: string;
  readonly configured = true;
  // Provider names that supplied ≥1 accepted field during the most recent enrich() run. Reset each run
  // and exposed via activeSources so MarketScan.source names only providers that ACTUALLY contributed —
  // a keyless/default-OFF provider that returns nothing for a scan (budget timeout, no CIK, no aligned
  // fact) must not appear in the source string just because it was registered.
  private contributingNames = new Set<string>();
  /** Most recent coverage report from enrich(); also mirrored via enrichment-coverage module. */
  private lastCoverageReport: import("./enrichment-coverage").EnrichmentCoverageReport | null = null;

  constructor(private readonly providers: MarketEnrichmentProvider[]) {
    this.name = providers.map((p) => p.name).join("+");
  }

  /** Registered providers that contributed ≥1 field in the last enrich(), in registration order. */
  get activeSources(): string[] {
    return this.providers.map((p) => p.name).filter((n) => this.contributingNames.has(n));
  }

  /** Coverage summary from the most recent enrich() call on this instance. */
  get coverageReport(): import("./enrichment-coverage").EnrichmentCoverageReport | null {
    return this.lastCoverageReport;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    this.contributingNames = new Set();
    this.lastCoverageReport = null;
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean);
    // Each provider's result set, paired with its name, kept in REGISTRATION order
    // so the first-wins merge below is unchanged regardless of how we fetched.
    type ProviderRun = { name: string; data: Record<string, SymbolEnrichment>; failure?: ProviderFailureReceipt };
    const run = (p: MarketEnrichmentProvider, syms: string[], context?: EnrichmentContext): Promise<ProviderRun> =>
      p
        .enrich(syms, context)
        .then((data) => ({ name: p.name, data }))
        .catch((error) => ({
          name: p.name,
          data: {} as Record<string, SymbolEnrichment>,
          failure: {
            source: p.name,
            upstreamFamily: p.name,
            fetchedAt: new Date().toISOString(),
            status: "failed" as const,
            errorKind: error instanceof Error ? error.name : "unknown"
          }
        }));

    // ── Wave split ────────────────────────────────────────────────────────────
    // FREE-FIRST (default ON):
    //   Wave A = free/keyless (`costTier !== "paid"`) over the full batch (+ one retry on throw).
    //   Wave B = paid non-scarce providers only for symbols still missing coverage-gap fields.
    //   Wave C = scarce RapidAPI failover for remaining suppliesFields gaps.
    // LEGACY (ENRICHMENT_FREE_FIRST_ENABLED=0):
    //   Wave one = every non-scarce provider concurrently; wave two = scarce gate only.
    const gateOn = scarceEnrichmentGateEnabled();
    const freeFirstOn = freeFirstEnrichmentEnabled();
    const isGatedScarce = (p: MarketEnrichmentProvider): boolean =>
      gateOn && p.quotaScarce === true && (p.suppliesFields?.length ?? 0) > 0;
    const isFreeTier = (p: MarketEnrichmentProvider): boolean => p.costTier !== "paid";

    const freeIndexes: number[] = [];
    const paidIndexes: number[] = [];
    const scarceIndexes: number[] = [];
    const legacyWaveOneIndexes: number[] = [];
    this.providers.forEach((p, i) => {
      if (isGatedScarce(p)) {
        scarceIndexes.push(i);
        return;
      }
      legacyWaveOneIndexes.push(i);
      if (isFreeTier(p)) freeIndexes.push(i);
      else paidIndexes.push(i);
    });

    // Positional, so the first-wins merge precedence below is registration order regardless of
    // which wave a provider ran in (and regardless of duplicate provider names).
    const results: ProviderRun[] = this.providers.map((p) => ({ name: p.name, data: {} }));

    const {
      collectFilledFields,
      symbolHasCoverageGap,
      buildEnrichmentCoverageReport
    } = await import("./enrichment-coverage");

    const buildFilledBySymbol = (providerIndexes: number[]): Map<string, Set<string>> => {
      const filledBySymbol = new Map<string, Set<string>>();
      for (const symbol of normalized) {
        filledBySymbol.set(symbol, collectFilledFields(results, symbol, providerIndexes));
      }
      return filledBySymbol;
    };

    const coveredFieldsFrom = (filledBySymbol: Map<string, Set<string>>): Record<string, ReadonlySet<string>> => {
      const coveredFields: Record<string, ReadonlySet<string>> = {};
      for (const [symbol, filled] of filledBySymbol) coveredFields[symbol] = filled;
      return coveredFields;
    };

    if (freeFirstOn) {
      // ── Wave A: free / keyless / RapidAPI-free-tier ─────────────────────────
      const freeProviders = freeIndexes.map((i) => this.providers[i]);
      let freeRuns: ProviderRun[];
      if (enrichmentShortCircuitEnabled()) {
        // App A still leads the free wave when short-circuit is on (coverage hint for paid).
        const congressProvider = freeProviders.find((p) => p.name === "congress.trade");
        const appAResult = congressProvider
          ? await run(congressProvider, normalized)
          : { name: "congress.trade", data: {} as Record<string, SymbolEnrichment> } satisfies ProviderRun;
        const otherFree = freeProviders.filter((p) => p.name !== "congress.trade");
        const otherResults = await Promise.all(otherFree.map((p) => run(p, normalized)));
        const byName = new Map<string, ProviderRun>();
        for (const r of [appAResult, ...otherResults]) byName.set(r.name, r);
        freeRuns = freeProviders.map((p) => byName.get(p.name) ?? { name: p.name, data: {} });
      } else {
        freeRuns = await Promise.all(freeProviders.map((p) => run(p, normalized)));
      }
      freeIndexes.forEach((providerIndex, k) => {
        results[providerIndex] = freeRuns[k];
      });

      // One retry for free providers that threw — transient 429/timeout must not permanently
      // suppress the keyless floor before paid/scarce failover runs.
      const retryIndexes = freeIndexes.filter((providerIndex) => results[providerIndex].failure);
      if (retryIndexes.length > 0) {
        const retries = await Promise.all(
          retryIndexes.map(async (providerIndex) => ({
            providerIndex,
            run: await run(this.providers[providerIndex], normalized)
          }))
        );
        for (const { providerIndex, run: providerRun } of retries) {
          // Keep the retry only when it recovered; otherwise preserve the original failure receipt.
          if (!providerRun.failure) results[providerIndex] = providerRun;
        }
      }

      // ── Wave B: paid non-scarce, gap-only ───────────────────────────────────
      if (paidIndexes.length > 0) {
        const filledAfterFree = buildFilledBySymbol(freeIndexes);
        const gapSymbols = normalized.filter((symbol) =>
          symbolHasCoverageGap(filledAfterFree.get(symbol) ?? new Set())
        );
        if (gapSymbols.length > 0) {
          const coveredFields = coveredFieldsFrom(filledAfterFree);
          // Analyst-source hint from App A when present (same semantics as short-circuit).
          const analystSource: Record<string, string> = {};
          const congressIdx = freeIndexes.find((i) => this.providers[i].name === "congress.trade");
          if (congressIdx !== undefined) {
            for (const s of gapSymbols) {
              const e = results[congressIdx].data[s];
              const srcKey = e?.analystBySource ? Object.keys(e.analystBySource)[0] : undefined;
              if (srcKey) analystSource[s] = srcKey;
            }
          }
          const paidContext: EnrichmentContext = { coveredFields, analystSource };
          const paidRuns = await Promise.all(
            paidIndexes.map((providerIndex) => {
              const provider = this.providers[providerIndex];
              const fields = provider.suppliesFields;
              const targets =
                fields && fields.length > 0
                  ? gapSymbols.filter((symbol) => {
                      const filled = filledAfterFree.get(symbol);
                      return fields.some((field) => !filled?.has(field as string));
                    })
                  : gapSymbols;
              if (targets.length === 0) {
                return Promise.resolve({ name: provider.name, data: {} } as ProviderRun);
              }
              return run(provider, targets, paidContext);
            })
          );
          paidIndexes.forEach((providerIndex, k) => {
            results[providerIndex] = paidRuns[k];
          });
        }
      }
    } else if (enrichmentShortCircuitEnabled()) {
      // Legacy short-circuit: App A first, then every other non-scarce provider in parallel.
      const waveOneProviders = legacyWaveOneIndexes.map((i) => this.providers[i]);
      const congressProvider = waveOneProviders.find((p) => p.name === "congress.trade");
      const appAResult = congressProvider
        ? await run(congressProvider, normalized)
        : { name: "congress.trade", data: {} as Record<string, SymbolEnrichment> } satisfies ProviderRun;
      const appA = appAResult.data;
      const coveredFields: Record<string, ReadonlySet<string>> = {};
      const analystSource: Record<string, string> = {};
      for (const s of normalized) {
        const e = appA[s];
        if (e) {
          coveredFields[s] = new Set(Object.keys(e));
          const srcKey = e.analystBySource ? Object.keys(e.analystBySource)[0] : undefined;
          if (srcKey) analystSource[s] = srcKey;
        }
      }
      const context: EnrichmentContext = { coveredFields, analystSource };
      const otherProviders = waveOneProviders.filter((p) => p.name !== "congress.trade");
      const otherResults = await Promise.all(
        otherProviders.map((p) => run(p, normalized, p.costTier === "paid" ? context : undefined))
      );
      const byName = new Map<string, ProviderRun>();
      for (const r of [appAResult, ...otherResults]) byName.set(r.name, r);
      const waveOneRuns = waveOneProviders.map((p) => byName.get(p.name) ?? { name: p.name, data: {} });
      legacyWaveOneIndexes.forEach((providerIndex, k) => {
        results[providerIndex] = waveOneRuns[k];
      });
    } else {
      // Legacy default: every non-scarce provider over every symbol in parallel.
      const waveOneRuns = await Promise.all(
        legacyWaveOneIndexes.map((i) => run(this.providers[i], normalized))
      );
      legacyWaveOneIndexes.forEach((providerIndex, k) => {
        results[providerIndex] = waveOneRuns[k];
      });
    }

    if (scarceIndexes.length > 0) {
      // Prior waves' actual fills. A provider that threw contributed `{}`, so its fields read as
      // NOT covered and the scarce tier can still step in — failure must never suppress failover.
      const priorIndexes = freeFirstOn
        ? [...freeIndexes, ...paidIndexes]
        : legacyWaveOneIndexes;
      const filledBySymbol = buildFilledBySymbol(priorIndexes);
      const coveredFields = coveredFieldsFrom(filledBySymbol);
      const scarceContext: EnrichmentContext = { coveredFields };
      const scarceRuns = await Promise.all(
        scarceIndexes.map(async (providerIndex) => {
          const provider = this.providers[providerIndex];
          const fields = provider.suppliesFields ?? [];
          const gaps = normalized.filter((symbol) => {
            const filled = filledBySymbol.get(symbol);
            return fields.some((field) => !filled?.has(field as string));
          });
          if (gaps.length === 0) return { providerIndex, run: { name: provider.name, data: {} } as ProviderRun };
          return { providerIndex, run: await run(provider, gaps, scarceContext) };
        })
      );
      for (const { providerIndex, run: providerRun } of scarceRuns) results[providerIndex] = providerRun;
    }
    const merged: Record<string, SymbolEnrichment> = {};

    for (const symbol of normalized) {
      const base: SymbolEnrichment = {};
      const sources: Partial<EnrichmentSources> = {};
      const fieldDates: Partial<Record<keyof EnrichmentSources, string>> = {};
      const fieldObservations: EnrichmentFieldObservations = {};
      const providerFailures: Record<string, ProviderFailureReceipt> = {};
      const scalarCandidates: Partial<Record<EnrichmentSourcedField, FieldObservationCandidate<unknown>[]>> = {};
      const cascadeFetchedAt = new Date().toISOString();
      let currentRecord: SymbolEnrichment | undefined;
      let currentRegistrationOrder = 0;
      const analystBySource: Record<string, AnalystRatingDetail> = {};
      // Which provider supplied the SURVIVING entry for each analyst source-key (last
      // writer wins, mirroring Object.assign). Used to credit contributors only after
      // de-dupe — a provider whose entry is overwritten by a same-source provider
      // supplied no final value and must not appear in MarketScan.source.
      const analystKeyOwner: Record<string, string> = {};
      const analystKeyOrder: Record<string, number> = {};
      let analystRegistrationOrder = 0;

      const takeScalar = <K extends EnrichmentSourcedField>(
        field: K,
        sourceName: string,
        value: SymbolEnrichment[K] | undefined
      ) => {
        const supplied = currentRecord?.fieldObservations?.[field] as FieldObservation<SymbolEnrichment[K]> | undefined;
        if (value !== undefined || supplied) {
          const observation: FieldObservation<unknown> = {
            ...supplied,
            value: value ?? supplied?.value,
            source: supplied?.source ?? sourceName,
            upstreamFamily: supplied?.upstreamFamily ?? sourceName,
            observedAt: supplied?.observedAt ?? (field === "asOf" ? undefined : currentRecord?.asOf),
            fetchedAt: supplied?.fetchedAt ?? cascadeFetchedAt,
            asOf: supplied?.asOf ?? currentRecord?.fieldDates?.[field] ?? undefined,
            status: supplied?.status ?? "ok"
          };
          const candidates: FieldObservationCandidate<unknown>[] = scalarCandidates[field] ?? [];
          candidates.push({
            observation,
            providerName: sourceName,
            registrationOrder: currentRegistrationOrder
          });
          scalarCandidates[field] = candidates;
        }
        if (base[field] === undefined && value !== undefined) {
          base[field] = value;
          sources[field] = sourceName;
        }
      };

      for (const [registrationOrder, { name, data, failure }] of results.entries()) {
        currentRegistrationOrder = registrationOrder;
        if (failure) providerFailures[name] = failure;
        const r = data[symbol];
        if (!r) continue;
        currentRecord = r;
        takeScalar("price", name, r.price);
        takeScalar("bid", name, r.bid);
        takeScalar("ask", name, r.ask);
        takeScalar("intradayChangePct", name, r.intradayChangePct);
        takeScalar("vwap", name, r.vwap);
        takeScalar("asOf", name, r.asOf);
        takeScalar("sentiment", name, r.sentiment);
        takeScalar("peRatio", name, r.peRatio);
        takeScalar("sector", name, r.sector);
        takeScalar("industry", name, r.industry);
        takeScalar("volume", name, r.volume);
        takeScalar("dividendYield", name, r.dividendYield);
        takeScalar("eps", name, r.eps);
        takeScalar("companyName", name, r.companyName);
        takeScalar("pbRatio", name, r.pbRatio);
        takeScalar("shortPercentOfFloat", name, r.shortPercentOfFloat);
        // The second source's short read is CARRIED (not first-wins) so the disagreement check below
        // can compare it against the primary. Keep the first non-undefined one.
        if (base.shortPercentOfFloatSecondary === undefined && r.shortPercentOfFloatSecondary !== undefined) {
          base.shortPercentOfFloatSecondary = r.shortPercentOfFloatSecondary;
        }
        takeScalar("beta", name, r.beta);
        takeScalar("fiftyTwoWeekHigh", name, r.fiftyTwoWeekHigh);
        takeScalar("fiftyTwoWeekLow", name, r.fiftyTwoWeekLow);
        takeScalar("insiderSentiment", name, r.insiderSentiment);
        takeScalar("fcfYield", name, r.fcfYield);
        takeScalar("debtToEquity", name, r.debtToEquity);
        takeScalar("epsGrowth", name, r.epsGrowth);
        takeScalar("senateTrades", name, r.senateTrades);
        takeScalar("daysToEarnings", name, r.daysToEarnings);
        takeScalar("institutionOwnershipPct", name, r.institutionOwnershipPct);
        takeScalar("nearTheMoneyIv", name, r.nearTheMoneyIv);
        takeScalar("putCallRatio", name, r.putCallRatio);
        takeScalar("targetMean", name, r.targetMean);
        takeScalar("targetHigh", name, r.targetHigh);
        takeScalar("targetLow", name, r.targetLow);
        takeScalar("targetMedian", name, r.targetMedian);
        takeScalar("returnOnEquity", name, r.returnOnEquity);
        takeScalar("returnOnAssets", name, r.returnOnAssets);
        takeScalar("revenueGrowth", name, r.revenueGrowth);
        takeScalar("freeCashFlowYield", name, r.freeCashFlowYield);
        takeScalar("grossProfitMargin", name, r.grossProfitMargin);
        takeScalar("congressTradesQuiver", name, r.congressTradesQuiver);
        takeScalar("insiderTradesQuiver", name, r.insiderTradesQuiver);
        takeScalar("govContractsQuiver", name, r.govContractsQuiver);
        takeScalar("lobbyingQuiver", name, r.lobbyingQuiver);
        takeScalar("patentsQuiver", name, r.patentsQuiver);
        if (!base.headlines?.length && r.headlines?.length) {
          base.headlines = r.headlines;
          this.contributingNames.add(name);
        }
        // Collect every provider's analyst read. Defer crediting it as a contributor:
        // if its entry is overwritten by a same-source provider that runs later (same
        // analystBySource key), it supplied no FINAL value. Track the last writer per key.
        if (r.analystBySource && Object.keys(r.analystBySource).length > 0) {
          for (const [k, v] of Object.entries(r.analystBySource)) {
            analystBySource[k] = v;
            analystKeyOwner[k] = name;
            analystKeyOrder[k] = analystRegistrationOrder++;
          }
        }
      }

      // Preserve legacy first-wins behavior when no provider exposes metadata (the
      // deterministic tie-breaker is registration order), while allowing explicit
      // field receipts to prefer a fresher, more reliable, or more direct fact.
      for (const field of Object.keys(EMPTY_SOURCED) as EnrichmentSourcedField[]) {
        const candidates = scalarCandidates[field] ?? [];
        const selected = arbitrateFieldObservation(field, candidates);
        if (selected) {
          (base as Record<string, unknown>)[field] = selected.observation.value;
          sources[field] = selected.providerName;
          fieldObservations[field] = selected.observation;
          this.contributingNames.add(selected.providerName);
          continue;
        }
        const unavailable = candidates.find((candidate) => candidate.observation.status !== "ok" && candidate.observation.status !== "stale");
        fieldObservations[field] = unavailable?.observation ?? {
          source: "enrichment-cascade",
          upstreamFamily: "enrichment-cascade",
          fetchedAt: cascadeFetchedAt,
          status: Object.keys(providerFailures).length === results.length ? "failed" : "no_match"
        };
      }

      // A source can republish the same upstream analyst consensus under a different
      // display key. Keep one deterministic (last registered) read per upstream family
      // before blending, so a redistribution cannot count as a second analyst vote.
      const analystFamilyCandidates: UpstreamFamilyCandidate<{ detail: AnalystRatingDetail; owner: string }>[] =
        Object.entries(analystBySource).map(([key, detail]) => ({
          key,
          upstreamFamily: detail.upstreamFamily ?? key,
          value: { detail, owner: analystKeyOwner[key] },
          registrationOrder: analystKeyOrder[key] ?? 0
        }));
      const dedupedAnalysts = dedupeUpstreamFamilies(analystFamilyCandidates);
      for (const key of Object.keys(analystBySource)) {
        delete analystBySource[key];
        delete analystKeyOwner[key];
      }
      for (const candidate of dedupedAnalysts) {
        analystBySource[candidate.key] = candidate.value.detail;
        analystKeyOwner[candidate.key] = candidate.value.owner;
      }

      // A "congress.trade"-keyed entry is a SOURCE-UNKNOWN blended aggregate (App A's
      // donated analyst[] rows carry no per-provider source). When granular per-source
      // votes exist alongside it, those supersede it — counting the aggregate too would
      // double-count the same upstream FMP/Finnhub/Yahoo consensus. Drop it in that case;
      // keep it only when it's the lone analyst signal.
      if (analystBySource["congress.trade"] && Object.keys(analystBySource).length > 1) {
        delete analystBySource["congress.trade"];
        delete analystKeyOwner["congress.trade"];
      }

      // Blend analyst scores across all sources that reported one.
      const detail = Object.values(analystBySource);
      if (detail.length > 0) {
        const blended = detail.reduce((sum, d) => sum + d.score, 0) / detail.length;
        base.analystScore = Math.round(blended);
        base.analystRating = labelFromAnalystScore(blended);
        base.analystBySource = analystBySource;
        sources.analystRating = Object.keys(analystBySource).length > 1 ? "blended" : Object.keys(analystBySource)[0];
        fieldObservations.analystRating = {
          value: base.analystRating,
          source: sources.analystRating,
          upstreamFamily: "analyst-consensus",
          fetchedAt: cascadeFetchedAt,
          status: "ok"
        };
        // Credit only the providers whose analyst entry SURVIVED the de-dupe.
        for (const owner of new Set(Object.values(analystKeyOwner))) this.contributingNames.add(owner);
      }

      // Prefer a REAL model sentiment (Alpha Vantage NEWS_SENTIMENT) over the keyword-proxy
      // sentiment that Finnhub/Alpaca synthesize via scoreHeadlines. The first-wins takeScalar
      // above lets the proxy win because Finnhub runs earlier; override here when AV returned a
      // numeric model score for this symbol (falls back to the proxy when AV has none).
      const avSentiment = results.find((res) => res.name === "alpha-vantage")?.data[symbol]?.sentiment;
      if (typeof avSentiment === "number") {
        base.sentiment = avSentiment;
        sources.sentiment = "alpha-vantage";
        const avReceipt = results.find((res) => res.name === "alpha-vantage")?.data[symbol]?.fieldObservations?.sentiment;
        fieldObservations.sentiment = {
          ...avReceipt,
          value: avSentiment,
          source: avReceipt?.source ?? "alpha-vantage",
          upstreamFamily: avReceipt?.upstreamFamily ?? "alpha-vantage",
          observedAt: avReceipt?.observedAt,
          fetchedAt: avReceipt?.fetchedAt ?? cascadeFetchedAt,
          status: avReceipt?.status ?? "ok"
        };
        this.contributingNames.add("alpha-vantage");
      }

      // Short-interest cross-check: when the primary (Yahoo-first) shortPercentOfFloat and the SECOND
      // source's independent read (Massive/FINRA) disagree by more than SHORT_INTEREST_DISAGREEMENT_PCT_PT
      // percentage points, record a disagreement note surfaced as an evidence bulletin — rather than
      // silently trusting one source. We keep the first-wins primary value; only the flag is added. Both
      // must be present, and the primary must not itself be the second source (defensive; Massive only
      // supplies the carrier, never the first-wins shortPercentOfFloat).
      if (
        typeof base.shortPercentOfFloat === "number" &&
        typeof base.shortPercentOfFloatSecondary === "number" &&
        sources.shortPercentOfFloat !== "massive"
      ) {
        const delta = Math.abs(base.shortPercentOfFloat - base.shortPercentOfFloatSecondary);
        if (delta >= shortInterestDisagreementThresholdPct()) {
          const primarySrc = sources.shortPercentOfFloat ?? "primary";
          base.shortInterestDisagreement =
            `Short interest disagreement: ${primarySrc} ${base.shortPercentOfFloat.toFixed(1)}% vs ` +
            `massive ${base.shortPercentOfFloatSecondary.toFixed(1)}% (${delta.toFixed(1)}pp apart).`;
          if (fieldObservations.shortPercentOfFloat) {
            fieldObservations.shortPercentOfFloat = {
              ...fieldObservations.shortPercentOfFloat,
              conflict: {
                kind: "value_disagreement",
                summary: base.shortInterestDisagreement,
                competingSources: [primarySrc, "massive"]
              }
            };
          }
          this.contributingNames.add("massive");
        }
      }
      // The carrier never leaves the cascade — it exists only to compute the flag above.
      delete base.shortPercentOfFloatSecondary;

      base.sources = sources;
      base.fieldObservations = fieldObservations;
      if (Object.keys(providerFailures).length > 0) base.providerFailures = providerFailures;
      merged[symbol] = base;
    }

    const recordsToSave: import("./db-fundamentals").HistoricalFundamentalRecord[] = [];
    for (const [symbol, enrichment] of Object.entries(merged)) {
      if (!enrichment.fieldObservations) continue;
      for (const [field, obs] of Object.entries(enrichment.fieldObservations)) {
        if (typeof obs.value === "number") {
          const effectiveTs = obs.asOf ?? obs.observedAt ?? obs.effectiveAt ?? obs.fetchedAt;
          if (effectiveTs) {
            recordsToSave.push({
              symbol,
              field,
              value: obs.value,
              provider: obs.source,
              effectiveAt: effectiveTs,
              fetchedAt: obs.fetchedAt ?? new Date().toISOString()
            });
          }
        }
      }
    }
    
    // Dynamic import (not require) so eslint no-require-imports stays clean and unit
    // tests that only partially mock db modules can still no-op when the module is absent.
    void import("./db-fundamentals")
      .then((mod) => {
        if (typeof mod.recordHistoricalFundamentals === "function") {
          mod.recordHistoricalFundamentals(recordsToSave);
        }
      })
      .catch(() => {
        // Silently ignored when db modules are partially mocked in unit tests
      });

    // Persist a field-by-field coverage report for admin/ops (filled / winning source /
    // missing). buildEnrichmentCoverageReport also mirrors into the module-level last-report slot.
    try {
      this.lastCoverageReport = buildEnrichmentCoverageReport(merged, this.activeSources);
    } catch {
      this.lastCoverageReport = null;
    }

    return merged;
  }
}

// Marker set so takeScalar only stamps fields that are actually sourced (not headlines/analyst).
const EMPTY_SOURCED: Record<EnrichmentSourcedField, true> = {
  price: true,
  bid: true,
  ask: true,
  intradayChangePct: true,
  vwap: true,
  asOf: true,
  sentiment: true,
  peRatio: true,
  analystRating: true,
  sector: true,
  industry: true,
  volume: true,
  dividendYield: true,
  eps: true,
  companyName: true,
  pbRatio: true,
  shortPercentOfFloat: true,
  beta: true,
  fiftyTwoWeekHigh: true,
  fiftyTwoWeekLow: true,
  insiderSentiment: true,
  fcfYield: true,
  debtToEquity: true,
  epsGrowth: true,
  senateTrades: true,
  daysToEarnings: true,
  institutionOwnershipPct: true,
  nearTheMoneyIv: true,
  putCallRatio: true,
  targetMean: true,
  targetHigh: true,
  targetLow: true,
  targetMedian: true,
  returnOnEquity: true,
  returnOnAssets: true,
  revenueGrowth: true,
  freeCashFlowYield: true,
  grossProfitMargin: true,
  congressTradesQuiver: true,
  insiderTradesQuiver: true,
  govContractsQuiver: true,
  lobbyingQuiver: true,
  patentsQuiver: true
};

// ── Webull unofficial quote bridge (opt-in, market-data only) ────────────────
// This shells out to scripts/webull_unofficial_quote.py, which uses the community
// tedchou12/webull package without logging in. It is disabled by default and never
// implements broker orders or learning fills.

const WEBULL_UNOFFICIAL_SOURCE = "webull-unofficial";
const DEFAULT_WEBULL_UNOFFICIAL_MAX = 20;

export function webullUnofficialEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.WEBULL_UNOFFICIAL_ENABLED ?? "").trim().toLowerCase());
}

/** SEC EDGAR XBRL debt/equity enrichment — DEFAULT ON (keyless). Set
 *  `SEC_XBRL_ENRICHMENT_ENABLED=0` to disable. */
export function secXbrlEnrichmentEnabled(): boolean {
  const raw = process.env.SEC_XBRL_ENRICHMENT_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return flagEnabled(raw);
}

/**
 * Percentage-point gap between the primary and the second short-interest source above which the cascade
 * emits a `shortInterestDisagreement` bulletin. Env `SHORT_INTEREST_DISAGREEMENT_PCT_PT`, default 5pp.
 */
export function shortInterestDisagreementThresholdPct(): number {
  const value = Number(process.env.SHORT_INTEREST_DISAGREEMENT_PCT_PT);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

/**
 * Whether the Massive REST second short-interest source runs (the disagreement cross-check). Gated on a
 * MASSIVE_API_KEY being present too (see getEnrichmentProvider) — this flag is the operator OFF-switch
 * for the extra 2 calls/symbol, default ON so a configured Massive key is actually used. Massive is a
 * REAL source (FINRA short interest ÷ free float), unlike the removed dead FMP `/v4/short_interest`.
 */
export function massiveShortInterestEnabled(): boolean {
  const raw = (process.env.MASSIVE_SHORT_INTEREST_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return true; // default ON when a key is present
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** TTL for a cached Massive short-interest row. FINRA reports on a ~2-week cadence, so a long TTL avoids
 *  needless calls. Env `MASSIVE_SHORT_INTEREST_TTL_MS`, default 12h. */
export function massiveShortInterestTtlMs(): number {
  const value = Number(process.env.MASSIVE_SHORT_INTEREST_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 12 * 60 * 60 * 1000;
}

/** Base URL for the Massive REST API. Env `MASSIVE_REST_BASE_URL`, default the verified public host. */
export function massiveRestBaseUrl(): string {
  const raw = (process.env.MASSIVE_REST_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return raw || "https://api.massive.com";
}

// Opt-in Robinhood option-chain enrichment tier (near-the-money IV + put/call ratio). Default OFF —
// Robinhood MCP calls are rate/session sensitive, so this is only wired in on explicit opt-in AND
// when Robinhood is connected (ROBINHOOD_ADAPTER=mcp). Long-TTL, low-frequency by design.
export function robinhoodOptionsEnrichmentEnabled(): boolean {
  return flagEnabled(process.env.ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED);
}

// Opt-in active per-provider circuit breaker: skip an enrichment lane whose db-health status is
// `stoppedWorking`, re-probing only after a backoff window. Default OFF so a bad interaction with a
// currently-working provider can't silently black out data.
export function enrichmentCircuitBreakerEnabled(): boolean {
  return flagEnabled(process.env.ENRICHMENT_CIRCUIT_BREAKER_ENABLED);
}

/** Minutes between re-probe attempts for a lane the circuit breaker has tripped. */
export function enrichmentCircuitBreakerBackoffMinutes(): number {
  const value = Number(process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN ?? 15);
  return Number.isFinite(value) && value > 0 ? value : 15;
}

// Opt-in: drop Finnhub's per-symbol `stock/recommendation` REST call (5 sub-calls → 4). Analyst ratings
// are already backstopped elsewhere in the cascade (Yahoo `recommendationMean` on the keyless floor, plus
// FMP grades-consensus / Alpha Vantage), so with this on a symbol still gets a blended analyst score from
// other tiers — never a fabricated one. Default OFF so existing scans stay byte-identical (5 calls/symbol).
export function finnhubDropRecommendationEnabled(): boolean {
  return flagEnabled(process.env.FINNHUB_DROP_RECOMMENDATION);
}

// Default 20 is deliberate (unofficial scraping endpoint; burst-sensitive), but the env
// override is unclamped — an operator raising it is making an explicit decision.
function webullUnofficialMaxSymbols(): number {
  const value = Number(process.env.WEBULL_UNOFFICIAL_MAX_SYMBOLS ?? DEFAULT_WEBULL_UNOFFICIAL_MAX);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WEBULL_UNOFFICIAL_MAX;
  return Math.floor(value);
}

function webullUnofficialTimeoutMs(): number {
  const value = Number(process.env.WEBULL_UNOFFICIAL_TIMEOUT_MS ?? 8000);
  return Number.isFinite(value) && value >= 1000 ? value : 8000;
}

export function parseWebullUnofficialQuote(payload: unknown): SymbolEnrichment {
  if (!payload || typeof payload !== "object" || "_error" in payload) return {};
  const row = payload as Record<string, unknown>;
  const price = firstNumber(row, ["pPrice", "close", "price", "lastPrice", "latestPrice", "last"]);
  const bid = firstNumber(row, ["bid", "bidPrice", "bid_price"]);
  const ask = firstNumber(row, ["ask", "askPrice", "ask_price"]);
  const prevClose = firstNumber(row, ["preClose", "prevClose", "previousClose", "priorClose"]);
  const rawChangePct = firstNumber(row, ["changeRatio", "changePercent", "pctChange", "changePct"]);
  const volume = firstNumber(row, ["volume", "vol", "tradeVolume"]);
  const peRatio = firstNumber(row, ["peTtm", "pe", "peRatio"]);
  const eps = firstNumber(row, ["epsTtm", "eps"]);
  const pbRatio = firstNumber(row, ["pb", "pbRatio", "priceToBook"]);
  const rawDividendYield = firstNumber(row, ["yield", "dividendYield"]);
  const fiftyTwoWeekHigh = firstNumber(row, ["fiftyTwoWkHigh", "high52w", "high52wk", "week52High", "fiftyTwoWeekHigh"]);
  const fiftyTwoWeekLow = firstNumber(row, ["fiftyTwoWkLow", "low52w", "low52wk", "week52Low", "fiftyTwoWeekLow"]);
  const companyName = firstString(row, ["name", "companyName", "disSymbolName"]);
  const asOf = firstString(row, ["timestamp", "tradeTime", "time", "updateTime"]);
  const dividendYield =
    rawDividendYield !== undefined && rawDividendYield >= 0
      ? Math.round((rawDividendYield <= 1 ? rawDividendYield * 100 : rawDividendYield) * 100) / 100
      : undefined;
  const intradayChangePct =
    rawChangePct !== undefined
      ? normalizePercent(rawChangePct)
      : price !== undefined && prevClose !== undefined && prevClose > 0
        ? Math.round(((price - prevClose) / prevClose) * 10000) / 100
        : undefined;

  return {
    ...(price !== undefined && { price }),
    ...(bid !== undefined && { bid }),
    ...(ask !== undefined && { ask }),
    ...(intradayChangePct !== undefined && { intradayChangePct }),
    ...(volume !== undefined && volume > 0 && { volume }),
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(eps !== undefined && { eps }),
    ...(pbRatio !== undefined && pbRatio > 0 && { pbRatio }),
    ...(dividendYield !== undefined && { dividendYield }),
    ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow }),
    ...(companyName !== undefined && { companyName }),
    ...(asOf !== undefined && { asOf })
  };
}

export class WebullUnofficialEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = WEBULL_UNOFFICIAL_SOURCE;
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, webullUnofficialMaxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      // Webull unofficial uses no user-stored API key — always shared scope.
      const cached = cache.get(`${this.name}:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const python = process.env.WEBULL_UNOFFICIAL_PYTHON || "python3";
    const script = process.env.WEBULL_UNOFFICIAL_SCRIPT || `${process.cwd()}/scripts/webull_unofficial_quote.py`;
    try {
      const stdout = await runWebullUnofficialScript(python, script, misses, webullUnofficialTimeoutMs());
      const payload = JSON.parse(stdout || "{}") as Record<string, unknown>;
      for (const symbol of misses) {
        const data = parseWebullUnofficialQuote(payload[symbol]);
        cache.set(`${this.name}:${symbol}`, { expiresAt: now + ttlMs(), data });
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return result;
  }
}

function runWebullUnofficialScript(
  python: string,
  script: string,
  symbols: string[],
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requireFn = eval("require") as (id: string) => unknown;
    const childProcess = requireFn("child_process") as {
      execFile: (
        file: string,
        args: string[],
        options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
      ) => void;
    };
    childProcess.execFile(
      python,
      [script, ...symbols],
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout ?? ""));
      }
    );
  });
}

// ── Robinhood first-party fundamentals (opt-in) ──────────────────────────────
// Sources fundamentals from the authenticated Robinhood MCP `get_equity_fundamentals`
// tool. Only high-confidence fields are mapped (P/E, sector/industry, 52-week range,
// average volume) to avoid unit-ambiguity surprises; verify the raw shape via
// /api/admin/robinhood-probe before relying on it. Inert unless explicitly enabled.

export function robinhoodEnrichmentEnabled(): boolean {
  if (process.env.ROBINHOOD_ADAPTER !== "mcp") return false;
  return ["1", "true", "on", "yes"].includes(String(process.env.ROBINHOOD_ENRICHMENT_ENABLED ?? "").trim().toLowerCase());
}

export function parseRobinhoodFundamentals(row: Record<string, unknown>): SymbolEnrichment {
  const peRatio = firstNumber(row, ["pe_ratio", "peRatio"]);
  const fiftyTwoWeekHigh = firstNumber(row, ["high_52_weeks", "fiftyTwoWeekHigh", "high52Weeks"]);
  const fiftyTwoWeekLow = firstNumber(row, ["low_52_weeks", "fiftyTwoWeekLow", "low52Weeks"]);
  const volume = firstNumber(row, ["average_volume", "average_volume_2_weeks", "volume"]);
  // Deliberately NOT mapping sector/industry: verified live against get_equity_fundamentals
  // (2026-07-01) that Robinhood returns its own idiosyncratic taxonomy (e.g. "Electronic
  // Technology" / "Telecommunications Equipment" for AAPL), not the GICS-style taxonomy the
  // rest of this app uses (Yahoo/Finnhub, and whatever a user configures in
  // policy.sectorCaps). SymbolEnrichment.sector feeds real sector-cap risk enforcement
  // (market.ts merges it into MarketQuote.sector, which policy.ts's sectorForSymbol/
  // sectorCapFor read) — passing Robinhood's raw value through would let it silently win the
  // cascade for a symbol and make that symbol's sector cap stop matching, with no error.
  // Numeric fields (PE, 52-week range, volume) were verified to parse correctly and carry no
  // such taxonomy risk, so only those are mapped.
  return {
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow }),
    ...(volume !== undefined && volume > 0 && { volume })
  };
}

export class RobinhoodEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "robinhood-fundamentals";
  readonly configured = true;
  private readonly scope: CacheScope;

  // SECURITY: the Robinhood OAuth token is per-user. This provider is constructed with the
  // request-scoped userId (see getEnrichmentProvider) and threads it into the fundamentals
  // fetch so user B never resolves user A's ('local') broker token. A pass with no user in
  // scope (undefined) fails closed — it returns empty enrichment rather than borrowing the
  // operator's token for a shared/background scan.
  //
  // The fundamentals themselves (pe_ratio, 52-wk hi/lo, avg volume, sector, industry) are PUBLIC
  // market data — not the user's private account. So, exactly like every other user-keyed source,
  // they are cached consent-pooled: pool tier when the user opted into the reciprocal data pool,
  // otherwise kept private to that user (a `user` keySource is never force-shared without consent).
  constructor(private readonly userId?: string) {
    this.scope = cacheScopeForKeySource("user", userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const result: Record<string, SymbolEnrichment> = {};
    // Fail closed when there is no user in scope: a private per-user broker credential must
    // never be sourced from the dev/operator 'local' identity for an anonymous enrichment pass.
    if (!this.userId) {
      for (const symbol of normalized) result[symbol] = {};
      return result;
    }

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId);
    const misses: string[] = [];
    // Serve from the consent-aware cache first (private → pool-if-consented → shared). A consenting
    // user reads bars/fundamentals another consenting user already fetched, without spending a call.
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("robinhood-fundamentals", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    try {
      const { fetchRobinhoodFundamentals } = await import("./robinhood");
      const raw = await fetchRobinhoodFundamentals(misses, this.userId);
      for (const symbol of misses) {
        const row = raw[symbol];
        const data = row ? parseRobinhoodFundamentals(row) : {};
        if (Object.keys(data).length > 0) {
          writeEnrichmentCache("robinhood-fundamentals", symbol, this.scope, this.userId, data, now + ttlMs());
        }
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return result;
  }
}

// ── Alpaca news provider (free Benzinga feed) ────────────────────────────────
// Keyed by Alpaca paper API key+secret (no IP-reputation issues, reliable from servers).
// One batched call returns recent articles tagged with their symbols; we group headlines
// per symbol and derive a sentiment proxy via scoreHeadlines. Supplies headlines + sentiment.

export class AlpacaNewsEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpaca-news";
  readonly configured = true;
  private readonly base = "https://data.alpaca.markets/v1beta1/news";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret?: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const rawSymbol of symbols) {
      const requested = normalizeSymbol(rawSymbol);
      const canonical = fromAlpacaSymbol(toAlpacaSymbol(requested));
      if (!canonical) continue;
      const aliases = aliasesByCanonical.get(canonical) ?? new Set<string>();
      aliases.add(canonical);
      if (requested) aliases.add(requested);
      aliasesByCanonical.set(canonical, aliases);
    }
    const normalized = Array.from(aliasesByCanonical.keys()).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    const addRequestedAliases = () => {
      for (const [canonical, aliases] of aliasesByCanonical) {
        const data = result[canonical];
        if (!data) continue;
        for (const alias of aliases) {
          if (!result[alias]) result[alias] = data;
        }
      }
      return result;
    };
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alpaca-news", symbol, this.userId, consented, now);
      if (cached) {
        result[symbol] = cached.data;
        continue;
      }
      // Push-first: if the WebSocket worker has fresh streamed headlines for this symbol, use
      // them and skip the REST call. Falls back to REST when the stream is off/has nothing.
      const streamed = getStreamedHeadlines(symbol, ttlMs());
      if (streamed && streamed.length > 0) {
        const data: SymbolEnrichment = { headlines: streamed, sentiment: scoreHeadlines(streamed) };
        // Streamed headlines come from a shared websocket feed — always shared scope.
        writeEnrichmentCache("alpaca-news", symbol, "shared", this.userId, data, now + ttlMs());
        result[symbol] = data;
        continue;
      }
      misses.push(symbol);
    }
    if (misses.length === 0) return addRequestedAliases();

    try {
      // Single batched request: Alpaca tags every article with the symbols it mentions. Alpaca
      // requires dot notation for share classes (BRK.B, not our internal BRK-B) in the filter.
      const url = `${this.base}?symbols=${encodeURIComponent(misses.map(toAlpacaSymbol).join(","))}&limit=50&sort=desc`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let articles: Array<{ headline?: string; symbols?: string[] }> = [];
      try {
        const headers: Record<string, string> = {
          accept: "application/json"
        };
        if (this.apiSecret) {
          headers["APCA-API-KEY-ID"] = this.apiKey;
          headers["APCA-API-SECRET-KEY"] = this.apiSecret;
        } else {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        const response = await fetchWithRetry(url, {
          headers,
          cache: "no-store",
          signal: controller.signal
        }, { service: this.name, keySource: this.keySource, userId: this.userId });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as { news?: Array<{ headline?: string; symbols?: string[] }> };
        articles = Array.isArray(json.news) ? json.news : [];
      } finally {
        clearTimeout(timeout);
      }

      const headlinesBySymbol = new Map<string, string[]>();
      for (const article of articles) {
        const headline = typeof article.headline === "string" ? article.headline.trim() : "";
        if (!headline) continue;
        for (const raw of article.symbols ?? []) {
          // Alpaca tags articles with its own dot notation (BRK.B) — convert back to our
          // hyphenated internal format before matching against `misses`.
          const symbol = fromAlpacaSymbol(raw);
          if (!symbol || !misses.includes(symbol)) continue;
          const list = headlinesBySymbol.get(symbol) ?? [];
          if (list.length < 5 && !list.includes(headline)) list.push(headline);
          headlinesBySymbol.set(symbol, list);
        }
      }

      for (const symbol of misses) {
        const headlines = headlinesBySymbol.get(symbol) ?? [];
        const data: SymbolEnrichment = headlines.length > 0 ? { headlines, sentiment: scoreHeadlines(headlines) } : {};
        if (headlines.length > 0) {
          writeEnrichmentCache("alpaca-news", symbol, this.scope, this.userId, data, now + ttlMs());
        }
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return addRequestedAliases();
  }
}

// ── Alpaca snapshot provider (real bid/ask, price, volume, vwap, intraday change) ──
// Uses Alpaca's batch /v2/stocks/snapshots endpoint. The data feed defaults to
// IEX (free tier) and is configurable via ALPACA_DATA_FEED (iex|sip|otc).
// One request covers all scan symbols (chunked at 100 per call).
// Maps: price = latestTrade.p ?? dailyBar.c, bid = latestQuote.bp,
//       ask = latestQuote.ap, volume = dailyBar.v, vwap = dailyBar.vw,
//       intradayChangePct = (dailyBar.c − prevDailyBar.c) / prevDailyBar.c * 100.
// Only sets a field when the source value is present and > 0 — never fabricates.
// This is the fix for fabricated ±0.1% bid/ask spreads in the Market Scan panel.

const ALPACA_SNAPSHOT_CHUNK = 100; // Alpaca batch limit per request

// Data feed for the snapshot endpoint. The free plan only has IEX; SIP returns
// HTTP 403 ("subscription does not permit querying recent SIP data") unless the
// account has a paid SIP subscription. Configurable via ALPACA_DATA_FEED; any
// value outside the allowed set falls back to "iex".
const ALPACA_ALLOWED_FEEDS = ["iex", "sip", "otc"] as const;
export function alpacaDataFeed(): (typeof ALPACA_ALLOWED_FEEDS)[number] {
  const raw = String(process.env.ALPACA_DATA_FEED ?? "").trim().toLowerCase();
  return (ALPACA_ALLOWED_FEEDS as readonly string[]).includes(raw)
    ? (raw as (typeof ALPACA_ALLOWED_FEEDS)[number])
    : "iex";
}

export class AlpacaSnapshotEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpaca-snapshot";
  readonly configured = true;
  private readonly base = "https://data.alpaca.markets/v2/stocks/snapshots";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alpaca-snapshot", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    // Chunk into batches of up to ALPACA_SNAPSHOT_CHUNK symbols.
    for (let i = 0; i < misses.length; i += ALPACA_SNAPSHOT_CHUNK) {
      const chunk = misses.slice(i, i + ALPACA_SNAPSHOT_CHUNK);
      try {
        // Alpaca requires dot notation for share classes (BRK.B, not our internal BRK-B) — a
        // single unconverted hyphenated symbol in the batch gets the whole chunk rejected with
        // HTTP 400 (confirmed in prod: this was silently failing ~97% of snapshot calls whenever
        // the batch included a symbol like BRK-B from the S&P 500 scan universe).
        const url = `${this.base}?symbols=${encodeURIComponent(chunk.map(toAlpacaSymbol).join(","))}&feed=${alpacaDataFeed()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let snapshots: Record<string, AlpacaSnapshot>;
        try {
          const response = await fetchWithRetry(url, {
            headers: {
              "accept": "application/json",
              "APCA-API-KEY-ID": this.apiKey,
              "APCA-API-SECRET-KEY": this.apiSecret
            },
            cache: "no-store",
            signal: controller.signal
          }, { service: this.name, keySource: this.keySource, userId: this.userId });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          snapshots = (await response.json()) as Record<string, AlpacaSnapshot>;
        } finally {
          clearTimeout(timeout);
        }

        for (const symbol of chunk) {
          const snap = snapshots[toAlpacaSymbol(symbol)];
          const data = parseAlpacaSnapshot(snap);
          const hasData = Object.keys(data).length > 0;
          if (hasData) {
            // Quote-family TTL (~30s default), NOT the blanket 6h fundamentals ttlMs() — see
            // alpacaSnapshotTtlMs() for why real-time price/bid/ask/volume can't share that cadence.
            writeEnrichmentCache("alpaca-snapshot", symbol, this.scope, this.userId, data, now + alpacaSnapshotTtlMs());
          }
          result[symbol] = data;
        }
      } catch {
        for (const symbol of chunk) result[symbol] = {};
      }
    }
    return result;
  }
}

interface AlpacaSnapshot {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { bp?: number; ap?: number; t?: string };
  dailyBar?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number; t?: string };
  prevDailyBar?: { c?: number };
}

export function parseAlpacaSnapshot(snap: AlpacaSnapshot | undefined | null): SymbolEnrichment {
  if (!snap) return {};

  const tradePrice = typeof snap.latestTrade?.p === "number" && snap.latestTrade.p > 0 ? snap.latestTrade.p : undefined;
  const barClose = typeof snap.dailyBar?.c === "number" && snap.dailyBar.c > 0 ? snap.dailyBar.c : undefined;
  const price = tradePrice ?? barClose;

  const bid = typeof snap.latestQuote?.bp === "number" && snap.latestQuote.bp > 0 ? snap.latestQuote.bp : undefined;
  const ask = typeof snap.latestQuote?.ap === "number" && snap.latestQuote.ap > 0 ? snap.latestQuote.ap : undefined;

  const volume = typeof snap.dailyBar?.v === "number" && snap.dailyBar.v > 0 ? snap.dailyBar.v : undefined;

  // Session VWAP comes free on every snapshot via dailyBar.vw. Only map it when
  // it is a real positive number — never fabricate.
  const vwap = typeof snap.dailyBar?.vw === "number" && snap.dailyBar.vw > 0 ? snap.dailyBar.vw : undefined;

  let intradayChangePct: number | undefined;
  const prevClose = typeof snap.prevDailyBar?.c === "number" && snap.prevDailyBar.c > 0 ? snap.prevDailyBar.c : undefined;
  if (barClose !== undefined && prevClose !== undefined && prevClose > 0) {
    intradayChangePct = Math.round(((barClose - prevClose) / prevClose) * 10000) / 100;
  }

  // Stamp asOf from whichever timestamp backs the winning PRICE field, so the staleness gate
  // (policy.ts maxQuoteAgeSec) sees the quote's true age instead of inheriting a screener/enrichment
  // asOf from an unrelated field (or none at all — parseAlpacaSnapshot never set asOf before this).
  // Preference mirrors the price fallback above: latestTrade.t when latestTrade.p won, else
  // dailyBar.t when dailyBar.c won. A malformed/missing timestamp is simply omitted — never guessed.
  const asOfRaw = tradePrice !== undefined ? snap.latestTrade?.t : barClose !== undefined ? snap.dailyBar?.t : undefined;
  const asOf = typeof asOfRaw === "string" && !Number.isNaN(new Date(asOfRaw).getTime()) ? asOfRaw : undefined;

  return {
    ...(price !== undefined && { price }),
    ...(bid !== undefined && { bid }),
    ...(ask !== undefined && { ask }),
    ...(volume !== undefined && { volume }),
    ...(vwap !== undefined && { vwap }),
    ...(intradayChangePct !== undefined && { intradayChangePct }),
    ...(asOf !== undefined && { asOf })
  };
}

// ── Nasdaq.com public quote/summary (no API key) ─────────────────────────────
// Keyless JSON endpoints used by nasdaq.com (same family as the delayed screener in
// market.ts). Complements Yahoo when the crumb handshake fails or Yahoo rate-limits.
const NASDAQ_QUOTE_UA =
  "Mozilla/5.0 (compatible; SocraticTrade/1.0; +https://socratictrade.com; research@socratictrade.com)";

/** Parse `/api/quote/{sym}/info` + `/api/quote/{sym}/summary` (+ optional holdings). */
export function parseNasdaqQuoteInfo(payload: unknown): SymbolEnrichment {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) return {};
  const companyName = typeof data.companyName === "string" && data.companyName.trim()
    ? data.companyName.replace(/\s+Common Stock\s*$/i, "").trim()
    : undefined;
  const pd = (data.primaryData ?? {}) as Record<string, unknown>;
  const price = parseRapidApiNumberString(pd.lastSalePrice);
  const intradayChangePct = parseRapidApiNumberString(pd.percentageChange);
  const volume = parseRapidApiNumberString(pd.volume);
  let fiftyTwoWeekHigh: number | undefined;
  let fiftyTwoWeekLow: number | undefined;
  const range = ((data.keyStats as Record<string, unknown> | undefined)?.fiftyTwoWeekHighLow as
    | { value?: string }
    | undefined)?.value;
  if (typeof range === "string" && range.includes("-")) {
    const parts = range.split(/\s*-\s*/).map((part) => parseRapidApiNumberString(part.trim()));
    if (typeof parts[0] === "number") fiftyTwoWeekLow = parts[0];
    if (typeof parts[1] === "number") fiftyTwoWeekHigh = parts[1];
  }
  return {
    ...(companyName !== undefined && companyName && { companyName }),
    ...(price !== undefined && price > 0 && { price }),
    ...(intradayChangePct !== undefined && { intradayChangePct }),
    ...(volume !== undefined && volume >= 0 && { volume }),
    ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
  };
}

export function parseNasdaqQuoteSummary(payload: unknown): SymbolEnrichment {
  const summaryData = (payload as { data?: { summaryData?: Record<string, { value?: string }> } } | undefined)
    ?.data?.summaryData;
  if (!summaryData) return {};
  const sector = summaryData.Sector?.value?.trim() || undefined;
  const industry = summaryData.Industry?.value?.trim() || undefined;
  const yieldRaw = parseRapidApiNumberString(summaryData.Yield?.value);
  const targetMean = parseRapidApiNumberString(summaryData.OneYrTarget?.value);
  let fiftyTwoWeekHigh: number | undefined;
  let fiftyTwoWeekLow: number | undefined;
  const range = summaryData.FiftTwoWeekHighLow?.value; // Nasdaq's typo in the wire key
  if (typeof range === "string" && range.includes("/")) {
    const parts = range.split("/").map((part) => parseRapidApiNumberString(part.replace(/[$,]/g, "").trim()));
    // Wire format is High/Low
    if (typeof parts[0] === "number") fiftyTwoWeekHigh = parts[0];
    if (typeof parts[1] === "number") fiftyTwoWeekLow = parts[1];
  }
  return {
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry }),
    ...(yieldRaw !== undefined && yieldRaw >= 0 && { dividendYield: yieldRaw }),
    ...(targetMean !== undefined && targetMean > 0 && { targetMean }),
    ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
  };
}

export function parseNasdaqInstitutionalHoldings(payload: unknown): SymbolEnrichment {
  const ownership = (payload as {
    data?: { ownershipSummary?: { SharesOutstandingPCT?: { value?: string } } };
  } | undefined)?.data?.ownershipSummary;
  const pct = parseRapidApiNumberString(ownership?.SharesOutstandingPCT?.value);
  return pct !== undefined && pct >= 0 ? { institutionOwnershipPct: pct } : {};
}

export class NasdaqQuoteEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "nasdaq-quote";
  readonly costTier = "free" as const;
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = cache.get(`nasdaq-quote:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const data = await this.fetchSymbol(symbol);
            if (Object.keys(data).length > 0) {
              cache.set(`nasdaq-quote:${symbol}`, { expiresAt: now + ttlMs(), data });
            }
            result[symbol] = data;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(path: string): Promise<unknown> {
    return withProviderLimit(this.name, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetchWithRetry(
          `https://api.nasdaq.com${path}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: "application/json,text/plain,*/*",
              "User-Agent": NASDAQ_QUOTE_UA,
              Origin: "https://www.nasdaq.com",
              Referer: "https://www.nasdaq.com/"
            }
          },
          { service: this.name, retries: 1 }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private async fetchSymbol(symbol: string): Promise<SymbolEnrichment> {
    // BRK.B works on Nasdaq's API; BRK-B does not — keep dots.
    const enc = encodeURIComponent(symbol);
    const [infoRes, summaryRes, holdingsRes] = await Promise.allSettled([
      this.getJson(`/api/quote/${enc}/info?assetclass=stocks`),
      this.getJson(`/api/quote/${enc}/summary?assetclass=stocks`),
      this.getJson(`/api/company/${enc}/institutional-holdings`)
    ]);
    const merged: SymbolEnrichment = {};
    if (infoRes.status === "fulfilled") Object.assign(merged, parseNasdaqQuoteInfo(infoRes.value));
    if (summaryRes.status === "fulfilled") Object.assign(merged, parseNasdaqQuoteSummary(summaryRes.value));
    if (holdingsRes.status === "fulfilled") Object.assign(merged, parseNasdaqInstitutionalHoldings(holdingsRes.value));
    return merged;
  }
}

// ── Yahoo Finance provider (no API key required) ─────────────────────────────
// Uses Yahoo Finance session-crumb auth to call v10/finance/quoteSummary.
// Provides: sector, industry, P/E, EPS, dividend yield, and analyst rating.

interface YfCreds { cookie: string; crumb: string; expiresAt: number; }
let yfCreds: YfCreds | null = null;
const YF_CRUMB_TTL_MS = 55 * 60_000; // 55 min (crumbs expire ~1 hr)
const YF_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
// A single failed cookie/crumb handshake otherwise blanks the ENTIRE Yahoo enrichment batch
// for every symbol this run — retry once after this short backoff before giving up.
const YF_CREDS_RETRY_BACKOFF_MS = 500;

class YahooFinanceEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "yahoo-finance";
  /** Keyless floor — always free-wave under the free-first planner. */
  readonly costTier = "free" as const;
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      // Yahoo Finance uses no user-stored API key — always shared scope.
      const cached = cache.get(`yf:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    let creds: YfCreds;
    try { creds = await this.getCreds(); } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      logApiHealth({ service: this.name, ok: false, errorText: scrubProviderErrorText(appendErrorCause(rawMessage, err)) });
      return result;
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const data = await this.fetchSymbol(symbol, creds);
            cache.set(`yf:${symbol}`, { expiresAt: now + ttlMs(), data });
            result[symbol] = data;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getCreds(): Promise<YfCreds> {
    const now = Date.now();
    if (yfCreds && yfCreds.expiresAt > now) return yfCreds;

    try {
      return await this.fetchCreds(now);
    } catch {
      // One retry with a short backoff — a transient network blip or momentary 429 on the
      // handshake shouldn't blank Yahoo enrichment for every symbol this run.
      await new Promise((resolve) => setTimeout(resolve, YF_CREDS_RETRY_BACKOFF_MS));
      return await this.fetchCreds(Date.now());
    }
  }

  private async fetchCreds(now: number): Promise<YfCreds> {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "user-agent": YF_UA },
      redirect: "follow"
    });
    const rawCookies: string[] =
      typeof (cookieRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (cookieRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [cookieRes.headers.get("set-cookie") ?? ""].filter(Boolean);
    const cookie = rawCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": YF_UA, "Cookie": cookie, "accept": "text/plain" }
    });
    if (!crumbRes.ok) throw new Error(`Yahoo Finance crumb failed: ${crumbRes.status}`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.startsWith("{")) throw new Error("Invalid Yahoo Finance crumb");

    yfCreds = { cookie, crumb, expiresAt: now + YF_CRUMB_TTL_MS };
    return yfCreds;
  }

  private async fetchSymbol(symbol: string, creds: YfCreds): Promise<SymbolEnrichment> {
    // calendarEvents → next earnings date (daysToEarnings); institutionOwnership +
    // majorHoldersBreakdown → institutional ownership %. Both ride the SAME authenticated
    // quoteSummary call (zero additional API cost) and degrade to undefined when Yahoo omits them.
    const modules =
      "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,institutionOwnership,majorHoldersBreakdown";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(creds.crumb)}`;
    // The new prod egress IP gets HTTP 429 from Yahoo on a cold/parallel burst; gate through
    // the shared per-provider pacer (provider-rate-limit.ts) so requests stay gently paced
    // instead of firing CONCURRENCY-wide. The AbortController/timeout is armed INSIDE the
    // pacer callback so the 8s HTTP timeout starts counting at actual dispatch time, not
    // when this call joins the queue — otherwise queue wait eats into the timeout.
    const res = await withProviderLimit(this.name, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        return await fetchWithRetry(url, {
          headers: { "user-agent": YF_UA, "Cookie": creds.cookie, "accept": "application/json" },
          cache: "no-store",
          signal: controller.signal
        }, { service: this.name });
      } finally {
        clearTimeout(timeout);
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
    const r = json?.quoteSummary?.result?.[0] as Record<string, unknown> | undefined;
    if (!r) return {};

    const sd = (r.summaryDetail ?? {}) as Record<string, { raw?: number }>;
    const ks = (r.defaultKeyStatistics ?? {}) as Record<string, { raw?: number }>;
    const fd = (r.financialData ?? {}) as Record<string, { raw?: number } | string>;
    const ap = (r.assetProfile ?? {}) as Record<string, unknown>;
    const ce = (r.calendarEvents ?? {}) as Record<string, unknown>;
    const io = (r.institutionOwnership ?? {}) as Record<string, unknown>;
    const mh = (r.majorHoldersBreakdown ?? {}) as Record<string, { raw?: number }>;

    const rawPe = (sd.trailingPE as { raw?: number })?.raw;
    const rawDiv = (sd.trailingAnnualDividendYield as { raw?: number })?.raw;
    const rawEps = (ks.trailingEps as { raw?: number })?.raw;
    const rawRecMean = (fd.recommendationMean as { raw?: number })?.raw;
    const rawPb = (ks.priceToBook as { raw?: number })?.raw;
    const rawShortFloat = (ks.shortPercentOfFloat as { raw?: number })?.raw;
    const rawBeta = (ks.beta as { raw?: number })?.raw;
    const raw52High = (sd.fiftyTwoWeekHigh as { raw?: number })?.raw;
    const raw52Low = (sd.fiftyTwoWeekLow as { raw?: number })?.raw;
    const rawDebtToEquity = (fd.debtToEquity as { raw?: number })?.raw;
    const rawEarningsGrowth = (fd.earningsGrowth as { raw?: number })?.raw;
    const rawFcf = (fd.freeCashflow as { raw?: number })?.raw;
    const rawMarketCap = (sd.marketCap as { raw?: number })?.raw;

    const peRatio = typeof rawPe === "number" && rawPe > 0 ? rawPe : undefined;
    // Yahoo returns yield as decimal fraction (0.0036 = 0.36%); store as percentage points.
    const dividendYield = typeof rawDiv === "number" && rawDiv >= 0 ? Math.round(rawDiv * 10000) / 100 : undefined;
    const eps = typeof rawEps === "number" ? rawEps : undefined;
    const pbRatio = typeof rawPb === "number" && rawPb > 0 ? rawPb : undefined;
    const shortPercentOfFloat = typeof rawShortFloat === "number" && rawShortFloat >= 0 ? Math.round(rawShortFloat * 10000) / 100 : undefined;
    const beta = typeof rawBeta === "number" ? rawBeta : undefined;
    const fiftyTwoWeekHigh = typeof raw52High === "number" ? raw52High : undefined;
    const fiftyTwoWeekLow = typeof raw52Low === "number" ? raw52Low : undefined;
    const debtToEquity = typeof rawDebtToEquity === "number" ? rawDebtToEquity : undefined;
    const epsGrowth = typeof rawEarningsGrowth === "number" ? rawEarningsGrowth : undefined;
    let fcfYield: number | undefined;
    if (typeof rawFcf === "number" && typeof rawMarketCap === "number" && rawMarketCap > 0) {
      fcfYield = Math.round((rawFcf / rawMarketCap) * 10000) / 100;
    }
    const sector = typeof ap.sector === "string" && ap.sector ? ap.sector : undefined;
    const industry = typeof ap.industry === "string" && ap.industry ? ap.industry : undefined;

    // Next-earnings signal: calendarEvents.earnings.earningsDate is an array of {raw:<unix seconds>}
    // ranges (sometimes a single point, sometimes a lo/hi window). Take the EARLIEST future date
    // and convert to whole calendar days out. Undefined when there is no future date — never 0/guess.
    const daysToEarnings = parseDaysToEarnings(ce);

    // Institutional ownership %: prefer majorHoldersBreakdown.institutionsPercentHeld (0–1 fraction);
    // fall back to summing institutionOwnership.ownershipList[].pctHeld. Stored as 0–100 percentage.
    const institutionOwnershipPct = parseInstitutionOwnershipPct(mh, io);

    // Analyst rating comes from the 1–5 recommendation mean → blended by the cascade.
    let analystBySource: Record<string, AnalystRatingDetail> | undefined;
    if (typeof rawRecMean === "number" && rawRecMean > 0) {
      const score = analystScoreFromMean(rawRecMean);
      analystBySource = {
        [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), mean: Math.round(rawRecMean * 100) / 100 }
      };
    }

    return {
      ...(peRatio !== undefined && { peRatio }),
      ...(dividendYield !== undefined && { dividendYield }),
      ...(eps !== undefined && { eps }),
      ...(sector !== undefined && { sector }),
      ...(industry !== undefined && { industry }),
      ...(pbRatio !== undefined && { pbRatio }),
      ...(shortPercentOfFloat !== undefined && { shortPercentOfFloat }),
      ...(beta !== undefined && { beta }),
      ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
      ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow }),
      ...(debtToEquity !== undefined && { debtToEquity }),
      ...(epsGrowth !== undefined && { epsGrowth }),
      ...(fcfYield !== undefined && { fcfYield }),
      ...(daysToEarnings !== undefined && { daysToEarnings }),
      ...(institutionOwnershipPct !== undefined && { institutionOwnershipPct }),
      ...(analystBySource !== undefined && { analystBySource })
    };
  }
}

// ── Yahoo quoteSummary parsers (calendarEvents / institution ownership) ──────
// Kept as pure functions so tests can exercise the shape-tolerance without a live call.

/** Earliest FUTURE earnings date from Yahoo calendarEvents → whole days out. Undefined when
 *  no future date is present (never fabricated to 0). Accepts both the single-date and the
 *  lo/hi window shapes Yahoo returns. */
export function parseDaysToEarnings(calendarEvents: Record<string, unknown>, now: number = Date.now()): number | undefined {
  const earnings = (calendarEvents?.earnings ?? {}) as Record<string, unknown>;
  const rawDates = earnings?.earningsDate;
  if (!Array.isArray(rawDates)) return undefined;
  const futureSeconds: number[] = [];
  for (const entry of rawDates) {
    const raw = (entry as { raw?: number } | undefined)?.raw ?? (typeof entry === "number" ? entry : undefined);
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) futureSeconds.push(raw);
  }
  if (futureSeconds.length === 0) return undefined;
  const nowSec = now / 1000;
  // Keep today + future dates (1-day grace so a midnight-UTC "today" timestamp or a lo/hi window
  // whose low edge just passed still counts); drop only genuinely-stale (>1 day) past earnings.
  const withinWindow = futureSeconds.filter((s) => s >= nowSec - 86_400);
  if (withinWindow.length === 0) return undefined;
  // Prefer the earliest STRICTLY-upcoming date; fall back to the grace window only when every date is
  // already (just) past — so `Math.min` can't pick a past window edge and shadow a real future date.
  const upcoming = withinWindow.filter((s) => s >= nowSec);
  const earliest = Math.min(...(upcoming.length > 0 ? upcoming : withinWindow));
  const days = Math.round((earliest - nowSec) / 86_400);
  // Clamp the grace window to 0 rather than returning undefined, so the signal stays visible on
  // earnings day / during a straddling window instead of silently disappearing.
  return Math.max(0, days);
}

/** Institutional ownership % (0–100) from majorHoldersBreakdown (preferred) or a summed
 *  institutionOwnership list. Undefined when neither is present. */
export function parseInstitutionOwnershipPct(
  majorHolders: Record<string, { raw?: number }>,
  institutionOwnership: Record<string, unknown>
): number | undefined {
  const pctHeld = majorHolders?.institutionsPercentHeld?.raw;
  if (typeof pctHeld === "number" && Number.isFinite(pctHeld) && pctHeld >= 0) {
    // Yahoo returns a 0–1 fraction; clamp to a sane 0–100 range.
    return Math.round(Math.min(pctHeld, 1) * 10000) / 100;
  }
  const list = (institutionOwnership?.ownershipList ?? []) as Array<{ pctHeld?: { raw?: number } }>;
  if (Array.isArray(list) && list.length > 0) {
    let sum = 0;
    let any = false;
    for (const row of list) {
      const v = row?.pctHeld?.raw;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        sum += v;
        any = true;
      }
    }
    if (any) return Math.round(Math.min(sum, 1) * 10000) / 100;
  }
  return undefined;
}

// ── Finnhub provider ─────────────────────────────────────────────────────────

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate limit|too many requests|quota|reservation|denied/i.test(message)) return true;
  if (/\btimeout\b|abort|network|fetch|conn|socket|eai_again|dns|504|502|503/i.test(message)) return true;
  return false;
}

export class FinnhubEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "finnhub";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = "https://finnhub.io/api/v1";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const dropRecommendation = finnhubDropRecommendationEnabled();
    // Key the cache by the flag: a row fetched with the recommendation DROPPED is missing Finnhub's
    // analyst vote, so if the operator later turns the flag off we must not keep serving that partial
    // row until TTL. A distinct namespace makes flipping the flag a natural cache miss (→ refetch),
    // while still caching normally within each flag state.
    const cacheKey = dropRecommendation ? "finnhub-norec" : "finnhub";
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(cacheKey, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const toDate = new Date(now).toISOString().split("T")[0];
    const fromDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Finnhub (60/min free) is NOT quota-capped here: each symbol fires separate per-symbol calls, so the
    // PACER (withProviderLimit minIntervalMs, provider-rate-limit.ts) spaces them under the per-minute cap
    // while still covering EVERY symbol over time — scan-size-agnostic without dropping coverage. Only
    // providers with a hard windowed cap you can't space around (twelvedata batch credits, tiingo 50/hour)
    // go through admitProviderRequests(). See RATE_QUOTAS for the pacer-vs-quota rationale.
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            // Run all Finnhub calls in parallel per symbol. When FINNHUB_DROP_RECOMMENDATION is on we skip
            // issuing the `stock/recommendation` HTTP call entirely (4 calls/symbol instead of 5); recRaw
            // resolves to null so no analyst rating is derived from Finnhub and the cascade backstops it.
            const recCall = dropRecommendation
              ? Promise.resolve(null)
              : this.getJson(`${this.base}/stock/recommendation?symbol=${symbol}&token=${this.apiKey}`);
            const [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${this.apiKey}`),
              this.getJson(`${this.base}/quote?symbol=${symbol}&token=${this.apiKey}`),
              recCall,
              this.getJson(`${this.base}/stock/profile2?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/metric?symbol=${symbol}&metric=all&token=${this.apiKey}`)
            ]);

            // News → headlines + fallback sentiment
            let headlines: string[] = [];
            let sentiment: number | undefined;
            if (newsRaw.status === "fulfilled" && Array.isArray(newsRaw.value)) {
              headlines = (newsRaw.value as Array<{ headline: string }>).slice(0, 5).map((n) => n.headline).filter(Boolean);
              if (headlines.length > 0) sentiment = scoreHeadlines(headlines);
            }

            // Quote → volume
            let volume: number | undefined;
            if (quoteRaw.status === "fulfilled") {
              const q = quoteRaw.value as Record<string, unknown>;
              if (typeof q?.v === "number" && q.v > 0) volume = q.v;
            }

            // Analyst recommendations → 0–100 score + label + counts (blended by the cascade)
            let analystBySource: Record<string, AnalystRatingDetail> | undefined;
            if (recRaw.status === "fulfilled" && Array.isArray(recRaw.value) && (recRaw.value as Record<string, unknown>[]).length > 0) {
              const latest = (recRaw.value as Record<string, unknown>[])[0];
              const counts = {
                strongBuy: num(latest.strongBuy),
                buy: num(latest.buy),
                hold: num(latest.hold),
                sell: num(latest.sell),
                strongSell: num(latest.strongSell)
              };
              const score = analystScoreFromCounts(counts);
              if (score !== undefined) {
                analystBySource = { [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), counts } };
              }
            }

            // Company profile → sector + industry + company name
            let sector: string | undefined;
            let industry: string | undefined;
            let companyName: string | undefined;
            if (profileRaw.status === "fulfilled") {
              const profile = profileRaw.value as Record<string, unknown>;
              if (profile?.finnhubIndustry) { sector = String(profile.finnhubIndustry); industry = String(profile.finnhubIndustry); }
              if (profile?.sector) sector = String(profile.sector);
              if (typeof profile?.name === "string" && profile.name.trim()) companyName = profile.name.trim();
            }

            // Basic financials → P/E, dividend yield, EPS, average volume
            let peRatio: number | undefined;
            let dividendYield: number | undefined;
            let eps: number | undefined;
            let volumeFromMetric: number | undefined;
            if (metricRaw.status === "fulfilled") {
              const metric = (metricRaw.value as { metric?: Record<string, unknown> })?.metric ?? {};
              const pe = metric.peBasicExclExtraTTM ?? metric.peTTM;
              if (typeof pe === "number" && pe > 0) peRatio = pe;
              const dy = metric.dividendYieldIndicatedAnnual ?? metric.dividendYieldAnnual;
              if (typeof dy === "number" && dy >= 0) dividendYield = dy;
              const epsVal = metric.epsBasicExclExtraItemsTTM ?? metric.epsAnnual;
              if (typeof epsVal === "number") eps = epsVal;
              // Average trading volume in millions (10-day avg preferred, fall back to 3-month).
              const avgVolM = metric["10DayAverageTradingVolume"] ?? metric["3MonthAverageTradingVolume"];
              if (typeof avgVolM === "number" && avgVolM > 0) volumeFromMetric = Math.round(avgVolM * 1_000_000);
            }

            // Prefer the current session volume; fall back to metric average when session volume is 0 (e.g. after hours).
            const resolvedVolume = (volume && volume > 0 ? volume : undefined) ?? volumeFromMetric;
            const data: SymbolEnrichment = {
              ...(sentiment !== undefined && { sentiment }),
              ...(headlines.length > 0 && { headlines }),
              ...(peRatio !== undefined && { peRatio }),
              ...(analystBySource !== undefined && { analystBySource }),
              ...(sector !== undefined && { sector }),
              ...(industry !== undefined && { industry }),
              ...(companyName !== undefined && { companyName }),
              ...(resolvedVolume !== undefined && { volume: resolvedVolume }),
              ...(dividendYield !== undefined && { dividendYield }),
              ...(eps !== undefined && { eps })
            };

            const promises = [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw];
            const allRejected = promises.every((p) => p.status === "rejected");
            const hasTransientError = promises.some(
              (p) => p.status === "rejected" && isTransientError(p.reason)
            );
            const isEmpty = Object.keys(data).length === 0;

            if (allRejected || hasTransientError || isEmpty) {
              console.warn(
                `[data-providers] Finnhub enrichment for ${symbol} skipped caching: ` +
                `(allRejected=${allRejected}, hasTransientError=${hasTransientError}, isEmpty=${isEmpty})`
              );
            } else {
              writeEnrichmentCache(cacheKey, symbol, this.scope, this.userId, data, now + ttlMs());
            }
            result[symbol] = data;
          } catch {
            result[symbol] = {}; // empty; later cascade tiers can still fill gaps.
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    // Finnhub's free tier is 60 req/min; the 5-wide symbol chunking above fires 5
    // endpoints/symbol, so gate actual dispatch through the shared per-provider pacer
    // (see provider-rate-limit.ts) instead of bursting 25-wide per chunk. The
    // AbortController/timeout is armed INSIDE the pacer callback so the 6s HTTP timeout
    // starts counting at actual dispatch time, not when this call joins the queue —
    // otherwise queue wait eats into the timeout and every request dispatched after ~6s
    // arrives already aborted.
    const response = await withProviderLimit(this.name, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        return await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId, apiKey: this.apiKey });
      } finally {
        clearTimeout(timeout);
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
}

// ── FMP stable API provider ───────────────────────────────────────────────────
// Stable FMP company-data lane. Company profile + insider activity are always
// requested for a cold symbol; ratios/analyst/targets remain coverage-aware.

/** Opt-in: fetch FMP price-target-consensus (an extra call per symbol; not on every key tier). */
export function fmpPriceTargetsEnabled(): boolean {
  const v = (process.env.FMP_PRICE_TARGETS_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export class FmpEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fmp";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = "https://financialmodelingprep.com/stable";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    // Per-symbol coverage-hint skip flags (short-circuit only). Shared by the cache-hit
    // path AND the fetch path so a cached FMP row is trimmed the same way a fresh fetch is.
    const skipFlagsFor = (symbol: string) => {
      const covered = context?.coveredFields?.[symbol];
      // P/E is first-wins (App A registered first wins anyway); analyst consensus is
      // blended, so skip it only when App A's analyst genuinely came from FMP; targets
      // are first-wins but skip the call only when App A covers all four.
      const skipPe = covered?.has("peRatio") ?? false;
      const skipConsensus = (covered?.has("analystRating") ?? false) && context?.analystSource?.[symbol] === this.name;
      const skipTargets = ["targetMean", "targetHigh", "targetLow", "targetMedian"].every((k) => covered?.has(k));
      return { skipPe, skipConsensus, skipTargets };
    };
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("fmp", symbol, this.userId, consented, now);
      if (cached) {
        // A cache hit bypasses the fetch-path skip logic, so apply the hint here too:
        // if App A covers FMP's OWN consensus with a fresher row, drop the cached FMP
        // analyst (analystBySource merges last-writer-wins, so a stale cached fmp entry
        // would otherwise overwrite App A's fresher fmp-keyed analyst in the blend).
        if (skipFlagsFor(symbol).skipConsensus && cached.data.analystBySource) {
          const { analystBySource, analystRating, analystScore, ...rest } = cached.data;
          // A leftover field is only USEFUL if App A doesn't ALSO cover it. A cached
          // { peRatio, analystBySource } leaves { peRatio } after stripping the consensus,
          // but App A's first-wins peRatio (or covered targets) makes that contribute
          // nothing — so the entry is effectively empty and FMP's unique fields
          // (insider/senate, enabled targets) would never be refetched. Treat it as a MISS
          // unless a NON-covered field survives, so the fetch path runs.
          const covered = context?.coveredFields?.[symbol];
          const usefulKeys = Object.keys(rest).filter((k) => !(covered?.has(k) ?? false));
          if (usefulKeys.length > 0) result[symbol] = rest;
          else misses.push(symbol);
        } else {
          result[symbol] = cached.data;
        }
      } else misses.push(symbol);
    }

    if (misses.length === 0) return result;

    // UNIFORM request quota (provider-rate-limit.ts RATE_QUOTAS): fmp = 290/min account-wide (Starter
    // is 300/min; 290 leaves headroom). Unlike tiingo/twelvedata, FMP's per-symbol cost is VARIABLE —
    // 2..5 requests depending on this symbol's skip flags — so we budget per symbol, not scan-uniform.
    // Build a plan per miss (same skipFlagsFor + wantTargets formula the fetch path uses, so reservation
    // == dispatch), admit the total, then greedily take a best-first prefix of WHOLE symbols and defer
    // the rest best-effort (the cascade + shared 6h cache cover them; coverage accretes across scans).
    const targetsEnabled = fmpPriceTargetsEnabled(); // read once per scan
    const plans = misses.map((symbol) => {
      const { skipPe, skipConsensus, skipTargets } = skipFlagsFor(symbol);
      const wantTargets = targetsEnabled && !skipTargets;
      const cost = callsPerSymbol("fmp", { skipPe, skipConsensus, wantTargets });
      return { symbol, skipPe, skipConsensus, wantTargets, cost };
    });
    const credKey = await apiKeyFingerprint(this.apiKey);
    const totalWanted = plans.reduce((n, p) => n + p.cost, 0);
    const allowed = admitProviderRequests("fmp", credKey, totalWanted);
    // Greedy best-first prefix walk: misses arrive best-first, so take whole symbols in order until the
    // next one doesn't fit, then defer it AND everything after it (preserves priority; mirrors tiingo's
    // slice tail). `remaining` after the walk is the sub-symbol leftover admit() over-reserved.
    let remaining = allowed;
    const toQuery: typeof plans = [];
    for (const p of plans) {
      if (p.cost <= remaining) { toQuery.push(p); remaining -= p.cost; }
      else break;
    }
    refundProviderRequests("fmp", credKey, remaining); // hand back the sub-symbol remainder
    for (const p of plans.slice(toQuery.length)) result[p.symbol] = {}; // deferred; not queried/cached this run
    if (toQuery.length === 0) return result; // no minute budget left — best-effort only

    for (let i = 0; i < toQuery.length; i += CONCURRENCY) {
      const chunk = toQuery.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (plan) => {
          // Reuse the reserved plan flags (do NOT recompute) so dispatch == reservation exactly.
          const { symbol, skipPe, skipConsensus, wantTargets } = plan;
          // Coverage hint (short-circuit only): when a free upstream (App A) already
          // supplied P/E, analyst consensus, or price targets for this symbol, skip the
          // matching FMP SUB-call — but always keep fetching FMP profile + insider data.
          // (Same flags are
          // applied to cache hits above.) skipTargets is folded into wantTargets already.
          const skipTargets = !wantTargets;
          const [peRaw, consensusRaw, profileRaw, insiderRaw, targetRaw] = await Promise.allSettled([
            skipPe
              ? Promise.resolve(undefined)
              : this.getJson(`${this.base}/ratios-ttm?symbol=${encodeURIComponent(symbol)}`),
            skipConsensus
              ? Promise.resolve(undefined)
              : this.getJson(`${this.base}/grades-consensus?symbol=${encodeURIComponent(symbol)}`),
            this.getJson(`${this.base}/profile?symbol=${encodeURIComponent(symbol)}`),
            this.getJson(
              `${this.base}/insider-trading/search?symbol=${encodeURIComponent(symbol)}&page=0&limit=100`,
              false,
              [402, 403]
            ),
            wantTargets
              ? this.getJson(
                  `${this.base}/price-target-consensus?symbol=${encodeURIComponent(symbol)}`,
                  false,
                  [402, 403]
                )
              : Promise.resolve(undefined)
            // NOTE: FMP does NOT provide short interest — there is no /short_interest (or equivalent)
            // endpoint (verified via FMP's API docs + official MCP surface, 2026-07). A second
            // short-interest source would need a real provider such as Massive or Finnhub.
          ]);

          let peRatio: number | undefined;
          let pbRatio: number | undefined;
          let debtToEquity: number | undefined;
          let returnOnEquity: number | undefined;
          let returnOnAssets: number | undefined;
          let grossProfitMargin: number | undefined;
          let ratiosDividendYield: number | undefined;
          let peDate: string | undefined;
          if (peRaw.status === "fulfilled" && Array.isArray(peRaw.value)) {
            const row = (peRaw.value as Array<Record<string, unknown>>)[0];
            const finite = (value: unknown) => {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : undefined;
            };
            const percent = (value: unknown) => {
              const parsed = finite(value);
              return parsed === undefined ? undefined : Math.round(parsed * 10_000) / 100;
            };
            const pe = finite(row?.priceToEarningsRatioTTM);
            const pb = finite(row?.priceToBookRatioTTM);
            if (pe !== undefined && pe > 0) peRatio = pe;
            if (pb !== undefined && pb > 0) pbRatio = pb;
            debtToEquity = finite(row?.debtToEquityRatioTTM ?? row?.debtEquityRatioTTM);
            returnOnEquity = percent(row?.returnOnEquityTTM);
            returnOnAssets = percent(row?.returnOnAssetsTTM);
            grossProfitMargin = percent(row?.grossProfitMarginTTM);
            ratiosDividendYield = percent(row?.dividendYieldTTM);
            if (typeof row?.date === "string") peDate = row.date;
          }

          // Stable company profile -> identity + durable operating/market facts. This
          // replaces the duplicate per-symbol Senate call (Congress.Trade is the
          // congressional system of record) without increasing the baseline call count.
          let companyName: string | undefined;
          let sector: string | undefined;
          let industry: string | undefined;
          let beta: number | undefined;
          let dividendYield: number | undefined = ratiosDividendYield;
          let fiftyTwoWeekHigh: number | undefined;
          let fiftyTwoWeekLow: number | undefined;
          if (profileRaw.status === "fulfilled" && Array.isArray(profileRaw.value)) {
            const row = (profileRaw.value as Array<Record<string, unknown>>)[0];
            if (row) {
              const clean = (value: unknown) =>
                typeof value === "string" && value.trim() ? value.trim() : undefined;
              const finite = (value: unknown) => {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
              };
              companyName = clean(row.companyName);
              sector = clean(row.sector);
              industry = clean(row.industry);
              beta = finite(row.beta);
              const lastDividend = finite(row.lastDividend ?? row.lastDiv);
              const profilePrice = finite(row.price);
              if (lastDividend !== undefined && lastDividend >= 0 && profilePrice !== undefined && profilePrice > 0) {
                dividendYield = Math.round((lastDividend / profilePrice) * 10_000) / 100;
              }
              const range = clean(row.range)?.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/);
              if (range) {
                fiftyTwoWeekLow = finite(range[1]);
                fiftyTwoWeekHigh = finite(range[2]);
              }
            }
          }

          // Analyst grades-consensus → 0–100 score + label + counts (blended by the cascade).
          // FMP does not provide news, so it contributes no sentiment.
          let analystBySource: Record<string, AnalystRatingDetail> | undefined;
          if (consensusRaw.status === "fulfilled" && Array.isArray(consensusRaw.value)) {
            const row = (consensusRaw.value as Array<Record<string, unknown>>)[0];
            if (row) {
              const counts = {
                strongBuy: num(row.strongBuy),
                buy: num(row.buy),
                hold: num(row.hold),
                sell: num(row.sell),
                strongSell: num(row.strongSell)
              };
              const score = analystScoreFromCounts(counts);
              if (score !== undefined) {
                analystBySource = { [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), counts } };
              }
            }
          }

          let insiderSentiment: number | undefined;
          if (insiderRaw.status === "fulfilled" && Array.isArray(insiderRaw.value)) {
            const trades = insiderRaw.value as Array<Record<string, unknown>>;
            let buys = 0;
            let sells = 0;
            for (const trade of trades.slice(0, 100)) {
              const type = String(trade.transactionType || "").toLowerCase();
              const acqDisp = String(
                trade.acquisitionOrDisposition ?? trade.acquistionOrDisposition ?? ""
              ).toLowerCase();
              if (type.includes("buy") || type.includes("purchase") || acqDisp === "a") buys++;
              else if (type.includes("sell") || type.includes("sale") || acqDisp === "d") sells++;
            }
            const total = buys + sells;
            if (total > 0) {
              insiderSentiment = Math.round((buys / total) * 100);
            }
          }

          // Price-target-consensus → numeric targets. FMP stable shape:
          // [{ symbol, targetHigh, targetLow, targetConsensus, targetMedian }]. Only positive values kept.
          let targetMean: number | undefined;
          let targetHigh: number | undefined;
          let targetLow: number | undefined;
          let targetMedian: number | undefined;
          if (wantTargets && targetRaw.status === "fulfilled" && Array.isArray(targetRaw.value)) {
            const row = (targetRaw.value as Array<Record<string, unknown>>)[0];
            if (row) {
              const pos = (v: unknown) => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : undefined;
              };
              targetMean = pos(row.targetConsensus);
              targetHigh = pos(row.targetHigh);
              targetLow = pos(row.targetLow);
              targetMedian = pos(row.targetMedian);
            }
          }

          const fieldDates: Partial<Record<keyof EnrichmentSources, string>> = {};
          if (peDate) {
            if (peRatio !== undefined) fieldDates.peRatio = peDate;
            if (pbRatio !== undefined) fieldDates.pbRatio = peDate;
            if (debtToEquity !== undefined) fieldDates.debtToEquity = peDate;
            if (returnOnEquity !== undefined) fieldDates.returnOnEquity = peDate;
            if (returnOnAssets !== undefined) fieldDates.returnOnAssets = peDate;
            if (grossProfitMargin !== undefined) fieldDates.grossProfitMargin = peDate;
            if (ratiosDividendYield !== undefined) fieldDates.dividendYield = peDate;
          }

          const data: SymbolEnrichment = {
            ...(peRatio !== undefined && { peRatio }),
            ...(pbRatio !== undefined && { pbRatio }),
            ...(debtToEquity !== undefined && { debtToEquity }),
            ...(returnOnEquity !== undefined && { returnOnEquity }),
            ...(returnOnAssets !== undefined && { returnOnAssets }),
            ...(grossProfitMargin !== undefined && { grossProfitMargin }),
            ...(analystBySource !== undefined && { analystBySource }),
            ...(companyName !== undefined && { companyName }),
            ...(sector !== undefined && { sector }),
            ...(industry !== undefined && { industry }),
            ...(beta !== undefined && { beta }),
            ...(dividendYield !== undefined && { dividendYield }),
            ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
            ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow }),
            ...(insiderSentiment !== undefined && { insiderSentiment }),
            ...(targetMean !== undefined && { targetMean }),
            ...(targetHigh !== undefined && { targetHigh }),
            ...(targetLow !== undefined && { targetLow }),
            ...(targetMedian !== undefined && { targetMedian }),
            ...(Object.keys(fieldDates).length > 0 && { fieldDates })
          };

          // Breaker-skip refund: only the sub-calls we ACTUALLY dispatched count (skipped conditional
          // slots are Promise.resolve(undefined) → "fulfilled", never a real request). When every
          // dispatched sub-call rejected with CircuitOpenError the breaker threw before any request left
          // the process — nothing was spent upstream, so hand back this symbol's reservation and don't
          // cache. The per-service breaker gates all sub-calls of a symbol together, so a partial-symbol
          // breaker skip can't occur. Mirrors tiingo's `if (breakerSkipped) refund(perSymbol)`.
          const madeCalls = [
            ...(skipPe ? [] : [peRaw]),
            ...(skipConsensus ? [] : [consensusRaw]),
            profileRaw,
            insiderRaw,
            ...(wantTargets ? [targetRaw] : [])
          ];
          const breakerSkipped = madeCalls.length > 0 && madeCalls.every(
            (p) => p.status === "rejected" && p.reason instanceof CircuitOpenError
          );
          if (breakerSkipped) {
            refundProviderRequests("fmp", credKey, plan.cost);
            result[symbol] = data; // leave a miss to retry once the breaker closes; do NOT cache
            return;
          }

          const promises = [peRaw, consensusRaw, profileRaw, insiderRaw];
          const allRejected = promises.every((p) => p.status === "rejected");
          const hasTransientError = promises.some((p) => p.status === "rejected" && isTransientError(p.reason));
          const isEmpty = Object.keys(data).length === 0;
          // A coverage-trimmed fetch (we skipped ratios-ttm and/or grades-consensus)
          // yields a PARTIAL row. Don't write it to the normal fmp cache: a later scan
          // with App A off/stale, or with the short-circuit flag off, would otherwise
          // treat the partial as a full FMP hit and never refetch P/E/analyst until TTL.
          // The covered fields come from App A live each scan; FMP refetches its uniques.
          // A skipped target call only "trims" the result when targets would actually have
          // been fetched (FMP_PRICE_TARGETS_ENABLED on); otherwise the row is complete and
          // must still be cached, or FMP's calls would repeat every scan.
          const trimmed = skipPe || skipConsensus || (skipTargets && fmpPriceTargetsEnabled());

          if (allRejected || hasTransientError || isEmpty || trimmed) {
            if (!trimmed) {
              console.warn(
                `[data-providers] FMP enrichment for ${symbol} skipped caching: ` +
                `(allRejected=${allRejected}, hasTransientError=${hasTransientError}, isEmpty=${isEmpty})`
              );
            }
          } else {
            // 14-day TTL to preserve hoarded FMP data and avoid 403s on the free tier.
            writeEnrichmentCache("fmp", symbol, this.scope, this.userId, data, now + 14 * 24 * 60 * 60 * 1000);
          }
          result[symbol] = data;
        })
      );
    }
    return result;
  }

  private async getJson(url: string, logHealth = true, suppressStatuses?: number[]): Promise<unknown> {
    const operation = (() => {
      try {
        return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "request";
      } catch {
        return "request";
      }
    })();
    const reservation = reserveProviderDispatch({
      provider: "fmp",
      operation: `enrichment-${operation}`,
      credentialRef: await apiKeyFingerprint(this.apiKey),
      userId: this.userId ?? "local",
      units: 1,
      estimatedCostUsd: 0,
      maxEstimatedCostUsdPer24h: 0,
      windows: (resolveProviderQuota("fmp") ?? []).map((window) => ({
        maxUnits: window.maxRequests,
        windowMs: window.windowMs
      }))
    });
    if (!reservation.admitted) throw new Error(`FMP durable ${reservation.reason} reservation denied.`);
    let dispatched = false;
    let settled = false;
    let classificationAttempted = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        {
          cache: "no-store",
          signal: controller.signal,
          // Header authentication keeps the credential out of URLs, thrown
          // errors, proxy logs, and upstream diagnostics.
          headers: { apikey: this.apiKey }
        },
        {
          service: this.name,
          keySource: this.keySource,
          userId: this.userId,
          // retries: 0 — each of the up-to-5 endpoints reserves exactly one request in the quota above;
          // a built-in 429 retry would emit a second UNCOUNTED call and blow past the 290/min reservation
          // (headroom is only 10). Same rationale as tiingo/twelvedata's getJson.
          retries: 0,
          durableAttempt: {
            onDispatch: () => {
              markProviderDispatchStarted(reservation.attemptId);
              dispatched = true;
            },
            onResponse: (received) => {
              if (!received.ok) {
                classificationAttempted = true;
                settleProviderDispatch(reservation.attemptId, "failed", {
                  outcomeCode: `http-${received.status}`
                });
                settled = true;
              }
            },
            onTransportError: (error) => {
              classificationAttempted = true;
              settleProviderDispatch(reservation.attemptId, "failed", {
                outcomeCode: error instanceof Error ? error.name : "transport-error"
              });
              settled = true;
            }
          },
          // An explicit suppress list wins; otherwise fall back to the old logHealth behavior (403 only).
          suppressHealthStatuses: suppressStatuses ?? (logHealth ? undefined : [403])
        }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      classificationAttempted = true;
      settleProviderDispatch(reservation.attemptId, "succeeded", {
        outcomeCode: "validated-json"
      });
      settled = true;
      return payload;
    } catch (error) {
      if (!dispatched) cancelUndispatchedProviderReservation(reservation.attemptId, "pre-dispatch-failure");
      else if (!settled && !classificationAttempted) settleProviderDispatch(reservation.attemptId, "failed", {
        outcomeCode: error instanceof SyntaxError ? "invalid-json" : "response-failure"
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Massive REST provider (second short-interest source) ─────────────────────
//
// A REAL second short-interest read for the primary-vs-secondary disagreement cross-check. Massive
// exposes FINRA-reported short interest (shares short, ~2-week cadence) and free float (shares) as
// separate REST endpoints; short % of float = short_interest / free_float * 100 — apples-to-apples
// with Yahoo's shortPercentOfFloat. Auth is `Authorization: Bearer <MASSIVE_API_KEY>` against
// https://api.massive.com (base + auth verified against Massive's official REST docs + MCP server,
// 2026-07). Populates ONLY the carrier field shortPercentOfFloatSecondary; the cascade computes the
// disagreement flag and then drops the carrier. Registered only when a MASSIVE_API_KEY is present AND
// massiveShortInterestEnabled(), so it is inert (no calls) in the default keyless setup.
export class MassiveEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "massive";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = massiveRestBaseUrl();
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("massive", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            // Two independent reads: FINRA short interest (shares) + free float (shares). Both are
            // needed to compute short % of float — Massive returns neither as a ready-made percentage.
            const [shortRaw, floatRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/stocks/v1/short-interest?ticker=${encodeURIComponent(symbol)}&limit=1&sort=settlement_date.desc`),
              this.getJson(`${this.base}/stocks/vX/float?ticker=${encodeURIComponent(symbol)}&limit=1`)
            ]);

            const shortInterest = shortRaw.status === "fulfilled" ? massiveFirstResult(shortRaw.value)?.short_interest : undefined;
            const freeFloat = floatRaw.status === "fulfilled" ? massiveFirstResult(floatRaw.value)?.free_float : undefined;

            let shortPercentOfFloatSecondary: number | undefined;
            const si = Number(shortInterest);
            const ff = Number(freeFloat);
            if (Number.isFinite(si) && si >= 0 && Number.isFinite(ff) && ff > 0) {
              shortPercentOfFloatSecondary = Math.round((si / ff) * 100 * 100) / 100; // % of float, 2dp
            }

            const data: SymbolEnrichment =
              shortPercentOfFloatSecondary !== undefined ? { shortPercentOfFloatSecondary } : {};

            // Only cache when BOTH calls succeeded — a transient failure on either shouldn't freeze an
            // empty row for the full TTL and suppress the cross-check until expiry. A 404 (no row for
            // this ticker) is a "fulfilled" empty result and DOES cache (a real, stable "no data").
            if (shortRaw.status === "fulfilled" && floatRaw.status === "fulfilled") {
              writeEnrichmentCache("massive", symbol, this.scope, this.userId, data, now + massiveShortInterestTtlMs());
            }
            result[symbol] = data;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${this.apiKey}` } },
        {
          service: this.name,
          keySource: this.keySource,
          userId: this.userId,
          // 404 = no short-interest / float row for this ticker (expected for some symbols) — don't log
          // it as a lane failure. Real auth/quota errors (401/403/429/5xx) still surface to health.
          suppressHealthStatuses: [404]
        }
      );
      if (response.status === 404) return { results: [] };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── ROIC.ai provider ──────────────────────────────────────────────────────────

/** Maps a ROIC.ai `/v2/company/profile/{sym}` row (snake_case) into SymbolEnrichment.
 *  Ratios endpoint paths historically 404'd on free keys — profile alone still fills
 *  company/sector/industry/dividend/short-interest/price when present. */
export function parseRoicProfile(profile: unknown, now: number = Date.now()): SymbolEnrichment {
  const p = (Array.isArray(profile) ? profile[0] : profile) as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return {};

  const companyName = firstString(p, ["company_name", "companyName", "name"]);
  const sector = firstString(p, ["sector"]);
  const industry = firstString(p, ["industry"]);
  const price = firstNumber(p, ["price"]);
  const dividendYield = firstNumber(p, ["dividend_yield", "dividendYield"]);
  const shortPercentOfFloat = firstNumber(p, [
    "short_shares_outstanding_percentage",
    "shortPercentOfFloat",
    "short_percent_of_float"
  ]);
  const institutionOwnershipPct = firstNumber(p, [
    "percentage_held_by_institutions",
    "institutionOwnershipPct"
  ]);

  let daysToEarnings: number | undefined;
  const earningsRaw = firstString(p, ["earnings_date", "earningsDate"]);
  if (earningsRaw) {
    const ts = Date.parse(earningsRaw);
    if (Number.isFinite(ts) && ts > now) {
      daysToEarnings = Math.max(0, Math.ceil((ts - now) / 86_400_000));
    }
  }

  return {
    ...(companyName !== undefined && { companyName }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry }),
    ...(price !== undefined && price > 0 && { price }),
    ...(dividendYield !== undefined && dividendYield >= 0 && { dividendYield: normalizePercent(dividendYield) }),
    ...(shortPercentOfFloat !== undefined && shortPercentOfFloat >= 0 && { shortPercentOfFloat: normalizePercent(shortPercentOfFloat) }),
    ...(institutionOwnershipPct !== undefined && institutionOwnershipPct >= 0 && {
      institutionOwnershipPct: normalizePercent(institutionOwnershipPct)
    }),
    ...(daysToEarnings !== undefined && { daysToEarnings })
  };
}

export function parseRoicRatios(ratios: unknown): SymbolEnrichment {
  const r = (Array.isArray(ratios) ? ratios[0] : ratios) as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return {};
  const peRatio = firstNumber(r, ["peRatio", "pe", "pe_ratio"]);
  const pbRatio = firstNumber(r, ["pbRatio", "pb", "pb_ratio", "priceToBook"]);
  const eps = firstNumber(r, ["eps"]);
  const returnOnEquity = firstNumber(r, ["roe", "returnOnEquity", "return_on_equity"]);
  const debtToEquity = firstNumber(r, ["debtToEquity", "debt_to_equity"]);
  return {
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(pbRatio !== undefined && pbRatio > 0 && { pbRatio }),
    ...(eps !== undefined && { eps }),
    ...(returnOnEquity !== undefined && { returnOnEquity: normalizePercent(returnOnEquity) }),
    ...(debtToEquity !== undefined && debtToEquity >= 0 && { debtToEquity })
  };
}

export class RoicAiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "roic";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = "https://api.roic.ai/v2";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("roic", symbol, this.userId, consented, now);
      if (cached) {
        result[symbol] = cached.data;
      } else {
        misses.push(symbol);
      }
    }

    if (misses.length === 0) return result;

    const credKey = `${this.keySource}:${this.userId ?? ""}`;
    // Profile is the reliable free-tier endpoint; ratios paths currently 404 — reserve 1/symbol
    // for the profile call (ratios are best-effort and do not block admission).
    const allowed = admitProviderRequests("roic", credKey, misses.length);
    if (!allowed) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const covered = context?.coveredFields?.[symbol];
            const needProfile =
              !covered ||
              !covered.has("companyName") ||
              !covered.has("sector") ||
              !covered.has("industry") ||
              !covered.has("dividendYield") ||
              !covered.has("shortPercentOfFloat") ||
              !covered.has("price");
            const needRatios =
              !covered ||
              !covered.has("peRatio") ||
              !covered.has("pbRatio") ||
              !covered.has("eps") ||
              !covered.has("returnOnEquity") ||
              !covered.has("debtToEquity");

            const [profileRes, ratiosRes] = await Promise.allSettled([
              needProfile
                ? fetchWithRetry(
                    `${this.base}/company/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(this.apiKey)}`,
                    {},
                    { service: "roic", keySource: this.keySource, userId: this.userId }
                  )
                : Promise.resolve(undefined),
              needRatios
                ? fetchWithRetry(
                    `${this.base}/financial-ratios/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(this.apiKey)}`,
                    {},
                    { service: "roic", keySource: this.keySource, userId: this.userId, retries: 0 }
                  )
                : Promise.resolve(undefined),
            ]);

            const profile =
              profileRes.status === "fulfilled" && profileRes.value?.ok
                ? await profileRes.value.json()
                : undefined;
            const ratios =
              ratiosRes.status === "fulfilled" && ratiosRes.value?.ok
                ? await ratiosRes.value.json()
                : undefined;

            const item: SymbolEnrichment = {
              ...parseRoicProfile(profile, now),
              ...parseRoicRatios(ratios)
            };

            if (Object.keys(item).length > 0) {
              result[symbol] = item;
              writeEnrichmentCache("roic", symbol, this.scope, this.userId, item, now + 30 * 60_000);
            }
          } catch (err) {
            console.warn(`[roic] failed enrichment for ${symbol}:`, err);
          }
        })
      );
    }

    return result;
  }
}

// ── Alpha Vantage provider ───────────────────────────────────────────────────

export class AlphaVantageEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpha-vantage";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = "https://www.alphavantage.co/query";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;
  private readonly pool: AlphaVantageKeyPool;
  // Guards the all-exhausted health-log row so ONE enrich() call across many symbol chunks
  // logs at most once, not once per chunk/symbol. Reset at the top of every enrich() call.
  private allExhaustedLogged = false;

  /**
   * `apiKeyOrKeys` accepts either a single key — kept for backward compatibility with existing
   * single-key call sites/tests (e.g. `new AlphaVantageEnrichmentProvider("test-key")`) — or the
   * full key list from `resolveAlphaVantageKeyPool`. `pool` is injectable for tests (each test
   * constructs and passes its own instance so exhaustion state never leaks between tests). When
   * omitted (the production path, e.g. `getEnrichmentProvider()`), the pool is resolved via
   * `getPoolForKeys(keys)` (alpha-vantage-key-pool.ts): a registry keyed by the exact SET of keys,
   * so a per-user stored key and the scheduler's env-key pool get DISTINCT, coexisting pool
   * instances instead of one construction's key set wholesale-replacing another's rotation/
   * exhaustion state on a single shared singleton (see `getPoolForKeys`'s doc comment for the
   * incident this replaces). Two constructions with the SAME key set still share one pool
   * instance, so `AlphaVantageKeyPool.configure`'s idempotent value-diff (see its own doc comment)
   * keeps exhaustion memory intact across the per-scan provider reconstruction.
   */
  constructor(
    apiKeyOrKeys: string | string[],
    keySource: ApiKeySource = "env",
    private readonly userId?: string,
    pool?: AlphaVantageKeyPool
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
    const keys = Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys];
    if (pool) {
      this.pool = pool;
      this.pool.configure(keys);
    } else {
      this.pool = getPoolForKeys(keys);
    }
  }

  /** Logs the "entire key pool exhausted" health row AT MOST ONCE per `enrich()` call — shared by
   *  both the once-per-chunk gate and the per-symbol dispatch-time gate below (see their call
   *  sites for why exhaustion can newly appear at either checkpoint). */
  private logAllExhaustedOnce(): void {
    if (this.allExhaustedLogged) return;
    this.allExhaustedLogged = true;
    const total = this.pool.size();
    const now = Date.now();
    // This is a daily-quota exhaustion, not a transient connection failure — it cannot clear
    // before Alpha Vantage's own daily reset, so tell logApiHealth exactly when that is instead
    // of letting the generic 6h cooldown re-alert the operator every 6h for one still-ongoing
    // outage (confirmed prod pattern: 1:31 AM and 8:02 AM alerts for the same exhausted key pool).
    const quotaResetAt = new Date(now + millisUntilNextAlphaVantageDailyReset(now)).toISOString();
    logApiHealth({
      service: this.name,
      ok: false,
      errorText: `Alpha Vantage: entire key pool exhausted for today (${total}/${total} keys hit the 25/day cap)`,
      keySource: this.keySource,
      userId: this.userId,
      quotaResetAt
    });
  }

  /**
   * Same alert semantics/plumbing as `logAllExhaustedOnce` (quotaResetAt, api_health_log row) —
   * and shares its `allExhaustedLogged` once-per-`enrich()`-call guard, so whichever exhaustion
   * signal fires first this call (this proactive self-imposed budget, or AV's own reactive
   * daily-cap message) wins and the other never double-alerts the operator for one ongoing
   * outage. Fired when `tryReserveAlphaVantageCalls` admits 0 while misses remain — i.e. this
   * app's own persisted daily ceiling ran out, distinct from AV itself having rejected a key.
   */
  private logBudgetExhaustedOnce(): void {
    if (this.allExhaustedLogged) return;
    this.allExhaustedLogged = true;
    const now = Date.now();
    const quotaResetAt = new Date(now + millisUntilNextAlphaVantageDailyReset(now)).toISOString();
    const budget = alphaVantageDailyCallBudget();
    logApiHealth({
      service: this.name,
      ok: false,
      errorText: `Alpha Vantage: proactive daily call budget exhausted (self-limited to ${budget}/day, PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY)`,
      keySource: this.keySource,
      userId: this.userId,
      quotaResetAt
    });
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alphavantage", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    this.allExhaustedLogged = false;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      // All-exhausted fast-fail, checked once per CONCURRENCY-sized chunk BEFORE dispatching any
      // network call: a scan that finds every pool key already capped skips the remaining
      // per-symbol fetch loop entirely instead of paying N x 1.1s of guaranteed-fail serial-paced
      // latency and writing N near-identical api_health_log rows per scan cycle — the exact prod
      // pattern this pool is meant to fix (2026-07-09 grounding: 9-19 wasted failures/minute).
      if (this.pool.allExhausted(now)) {
        this.logAllExhaustedOnce();
        for (let j = i; j < misses.length; j++) result[misses[j]] = {};
        break;
      }

      const chunk = misses.slice(i, i + CONCURRENCY);

      // Proactive, self-imposed daily budget (default 23/day — see alpha-vantage-key-pool.ts),
      // checked BEFORE dispatching any call in this chunk, same spot/shape as the reactive
      // allExhausted() fast-fail above. AV's real 25/day cap is enforced per source IP, not per
      // key, so this app self-limits below it instead of relying purely on AV's own rejection —
      // see the module doc comment on tryReserveAlphaVantageCalls for why this must be persisted
      // rather than an in-memory window. Symbols beyond the admitted count are left unenriched
      // exactly like the allExhausted() skip path above (result[symbol] = {}).
      const admitted = tryReserveAlphaVantageCalls(chunk.length, now);
      if (admitted < chunk.length) {
        for (let j = admitted; j < chunk.length; j++) result[chunk[j]] = {};
        if (admitted === 0) {
          this.logBudgetExhaustedOnce();
          for (let j = i + chunk.length; j < misses.length; j++) result[misses[j]] = {};
          break;
        }
      }
      const dispatchable = chunk.slice(0, admitted);

      await Promise.all(
        dispatchable.map(async (symbol) => {
          let dispatchKey: string | undefined;
          let keyIndex = 0;
          let dispatchedToNetwork = false;
          try {
            // deferSuccessLog: true — don't mark 200 healthy until body validates;
            // Alpha Vantage embeds quota/error messages in HTTP 200 responses. Free tier is
            // ~1 req/sec — gate through the shared per-provider pacer (provider-rate-limit.ts)
            // so this stays strictly serial instead of bursting CONCURRENCY-wide. The pool's
            // CURRENT key is read INSIDE the pacer callback (as close to actual dispatch time
            // as possible, not captured once at construction) so a rotation triggered by an
            // earlier symbol in the same chunk/batch is honored by later symbols once the
            // strictly-serial pacer gets to them. The AbortController/timeout is armed in the
            // same callback so the 6s HTTP timeout starts counting at actual dispatch time, not
            // when this call joins the (strictly-serial, so potentially long) queue.
            const response = await withProviderLimit(this.name, async () => {
              // Per-symbol re-check AT DISPATCH TIME (in addition to the once-per-chunk gate
              // above): every symbol in this CONCURRENCY-sized chunk starts together, but the
              // alpha-vantage pacer forces effectively serial dispatch (concurrency: 1 in
              // provider-rate-limit.ts's HARD_DEFAULTS) — so by the time THIS symbol's turn to
              // actually reach the network arrives, an earlier symbol in the SAME chunk may have
              // just exhausted the last live key. Without this check, `currentKey()` below would
              // still happily hand back the earliest-to-recover (but still dead) key — it only
              // returns undefined for an empty pool, never for an all-exhausted one — so every
              // remaining queued symbol in the chunk would dispatch one more guaranteed-fail call.
              if (this.pool.allExhausted(Date.now())) {
                this.logAllExhaustedOnce();
                throw new Error("Alpha Vantage: key pool exhausted");
              }
              const current = this.pool.currentKey(Date.now());
              // Shouldn't happen — the allExhausted() gate above already skips this chunk when
              // every key is capped — but never dispatch a request with no key to attach.
              if (!current) throw new Error("Alpha Vantage: key pool exhausted");
              dispatchKey = current.key;
              keyIndex = current.index;
              const url = `${this.base}?function=NEWS_SENTIMENT&tickers=${symbol}&apikey=${dispatchKey}`;
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 6000);
              try {
                return await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, {
                  service: this.name,
                  keySource: this.keySource,
                  userId: this.userId,
                  deferSuccessLog: true,
                  apiKey: dispatchKey,
                  // Exact-quota reserver (fetchWithRetry's own contract): a built-in 429 retry
                  // would re-dispatch under the SAME daily-budget reservation — one reserved
                  // call must never cost two real AV calls when the headroom is only 25-23=2.
                  retries: 0,
                  // Marks the reserved proactive-budget call (see tryReserveAlphaVantageCalls
                  // above) as actually spent the instant it reaches the real network — fires
                  // right before fetchWithRetry's own `fetch()` call, i.e. AFTER the per-
                  // credential circuit breaker and the allExhausted()/no-key throws above have
                  // already had their chance to skip this call without ever touching AV. The
                  // catch block below refunds the reservation when this never flips true.
                  // Passing durableAttempt makes this call self-recording: fetchWithRetry
                  // suppresses its default recordProviderCall on both paths for durable
                  // callers, so the usage-monitor call-volume row is written here instead
                  // (exactly one per invocation, matching the pre-budget telemetry).
                  durableAttempt: {
                    onDispatch: () => { dispatchedToNetwork = true; },
                    onResponse: (r) => {
                      recordProviderCall(this.name, { ok: r.ok, keySource: this.keySource, userId: this.userId });
                    },
                    onTransportError: () => {
                      recordProviderCall(this.name, { ok: false, keySource: this.keySource, userId: this.userId });
                    },
                  }
                });
              } finally {
                clearTimeout(timeout);
              }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json() as Record<string, unknown>;
            // Non-secret key-index tag for health-log visibility (see connections-health / the
            // ops snapshot) — only shown once the pool actually has >1 key, so a single-key
            // deployment's log text is byte-identical to before this feature existed.
            const keyTag = this.pool.size() > 1 ? ` [key ${keyIndex + 1}/${this.pool.size()}]` : "";

            if (payload && (payload.Note || payload.Information || payload["Error Message"])) {
              const rawMsg = String(payload.Note || payload.Information || payload["Error Message"]);
              // Alpha Vantage's own quota/error text has been observed echoing the caller's
              // API key (e.g. referencing the request URL) — scrub every pool key (not just the
              // one that dispatched this call) before it ever reaches api_health_log / the ops
              // snapshot.
              const msg = scrubProviderErrorTextForPool(rawMsg, this.pool.allKeys());
              // Discriminator: ONLY the genuine daily-cap message ("detected your api key")
              // means this key is dead until the next reset. The transient per-second burst
              // warning shares the same "25 requests per day" upsell text but never contains
              // that phrase — leave the sticky key in place for it; the existing 1.1s pacer is
              // what actually addresses that case.
              if (dispatchKey && isAlphaVantageDailyCapMessage(rawMsg)) {
                this.pool.markExhausted(dispatchKey);
              }
              logApiHealth({ service: this.name, ok: false, errorText: `Alpha Vantage API warning/error${keyTag}: ${msg}`, keySource: this.keySource, userId: this.userId });
              throw new Error(`Alpha Vantage API warning/error: ${msg}`);
            }
            // Same [key i/N] tag on the success row too (stored in errorText, the only free-form
            // field logApiHealth offers) — for symmetry when diagnosing which key served a given
            // request. logApiHealth only feeds api_health_error_patterns when !ok, so this never
            // creates a spurious error-pattern row.
            logApiHealth({ service: this.name, ok: true, errorText: keyTag ? `key ${keyIndex + 1}/${this.pool.size()}` : undefined, keySource: this.keySource, userId: this.userId });

            let sentiment: number | undefined;
            let headlines: string[] = [];

            if (payload && Array.isArray(payload.feed)) {
              const feed = payload.feed as Array<Record<string, unknown>>;

              // Extract headlines
              headlines = feed
                .slice(0, 5)
                .map(item => typeof item.title === "string" ? item.title.trim() : "")
                .filter(Boolean);

              // Calculate average sentiment score from ticker_sentiment
              let scoreSum = 0;
              let scoreCount = 0;

              for (const item of feed.slice(0, 20)) { // look at top 20 news items
                const tickerArr = Array.isArray(item.ticker_sentiment) ? item.ticker_sentiment : [];
                const targetTicker = tickerArr.find((t: { ticker?: string }) => t.ticker === symbol);
                if (targetTicker && typeof targetTicker.ticker_sentiment_score === "string") {
                  const score = Number(targetTicker.ticker_sentiment_score);
                  if (Number.isFinite(score)) {
                    scoreSum += score;
                    scoreCount++;
                  }
                }
              }

              if (scoreCount > 0) {
                const avgScore = scoreSum / scoreCount;
                // Alpha vantage sentiment ranges roughly [-0.35, 0.35]. Map it to 0-100.
                sentiment = Math.max(0, Math.min(100, Math.round(50 + (avgScore * 100))));
              }
            }

            const data: SymbolEnrichment = {
              ...(sentiment !== undefined && { sentiment }),
              ...(headlines.length > 0 && { headlines })
            };

            // AV only writes to cache on a valid feed (warning/error detection above throws).
            writeEnrichmentCache("alphavantage", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
          } catch {
            // This symbol's reserved proactive-budget call never reached the real network
            // (reactive key-pool exhaustion discovered mid-chunk, a per-credential circuit-
            // breaker skip, or any other throw before dispatch) — give the budget back so a
            // genuinely-skipped call doesn't silently shrink today's remaining quota. A call
            // that DID reach the network (dispatchedToNetwork === true) is never refunded here,
            // even though it went on to fail/error — it already spent AV's real quota.
            if (!dispatchedToNetwork) refundAlphaVantageCalls(1);
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }
}

// ── RapidAPI-hosted enrichment providers (Mboum Finance, YH Finance 15, Alpha Vantage OVERVIEW) ──
// Three additional REDUNDANT/FAILOVER sources for the SAME fundamentals fields the free keyless
// Yahoo scrape (registered last, unconditionally, above) already fills reasonably well — added for
// extra throughput against a single shared RapidAPI subscription (owner: "request as often as we
// want almost" for data this app already gets elsewhere; NOT new fields — see the 2026-07-19
// rollout note's MVP SCOPE). All three are dormant unless RAPIDAPI_KEY is set (resolveRapidApiKey /
// getEnrichmentProvider), and each self-limits to a tiny persisted daily call budget
// (rapidapi-quota.ts) far below its real plan cap: Mboum's and YH Finance 15's real limits are
// MONTHLY (500/mo and 100/mo respectively, NOT daily), so a naive per-scan dispatch against a
// normal watchlist could exhaust an entire MONTH's quota in one run — the persisted budget divides
// that monthly cap into a small daily allowance instead. See rapidapi-quota.ts's module doc comment
// for the exact numbers/provenance and the combined 900/day safety ceiling across all three.
//
// Ordering (see getEnrichmentProvider): all three are registered AFTER YahooFinanceEnrichmentProvider
// — first-wins per field (takeScalar) means they only actually WIN a field the free scrape (and
// every earlier paid tier) left empty for that symbol. This deliberately makes them a deep failover
// tier rather than competing with the free source for fields it already covers well.

export function resolveRapidApiKey(): string | undefined {
  const key = (process.env.RAPIDAPI_KEY ?? "").trim();
  return key || undefined;
}

/** Mboum Finance and YH Finance 15 (RapidAPI's own listing describes both as fronting the same
 *  "steadyapi.com" backend) return every numeric quote field as a FORMATTED STRING ("$333.74",
 *  "+0.48", "+0.14%", "63,407,283") rather than a JSON number. Strips "$", ",", "%", and a leading
 *  "+" before parsing. Returns undefined for anything that doesn't parse to a finite number (never
 *  fabricates 0). */
export function parseRapidApiNumberString(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[$,%\s]/g, "").replace(/^\+/, "");
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Shared RapidAPI HTTP helper: attaches the `x-rapidapi-host`/`x-rapidapi-key` headers every
 * RapidAPI-hosted product requires (auth via HEADERS, never a query param — see SECRET HANDLING in
 * the 2026-07-19 rollout note), goes through the same fetchWithRetry telemetry/circuit-breaker/
 * health-log boundary every other provider in this file uses, and scrubs the key out of any error
 * text via fetchWithRetry's own `apiKey` scrub param.
 *
 * `dispatchTracker`, when passed, is flipped true the instant the real network `fetch()` is about
 * to fire (fetchWithRetry's `durableAttempt.onDispatch`) — mirroring AlphaVantageEnrichmentProvider's
 * `dispatchedToNetwork` pattern above, so a caller's persisted-budget reservation is refunded ONLY
 * when the call never actually reached the network (a circuit-breaker skip, etc.), never when it
 * reached the network and merely failed/errored (that already spent real RapidAPI quota). Passing a
 * tracker switches usage-monitor call-volume telemetry to durable self-recording (matching AV's
 * `durableAttempt` contract — fetchWithRetry suppresses its own default `recordProviderCall` for any
 * durable caller), so it is recorded explicitly in `onResponse`/`onTransportError` below instead.
 */
async function rapidApiGetJson(
  host: string,
  path: string,
  apiKey: string,
  options: { service: string; keySource: ApiKeySource; userId?: string; timeoutMs?: number },
  dispatchTracker?: { dispatched: boolean }
): Promise<unknown> {
  // Gated through the shared per-provider pacer (provider-rate-limit.ts — see the
  // mboum-finance/yahoo-finance15/alpha-vantage-rapidapi HARD_DEFAULTS entries) so requests stay
  // within each host's real Basic-tier rate limit (1 req/sec for the steadyapi hosts, 5 req/min for
  // Alpha Vantage's RapidAPI plan) instead of bursting CONCURRENCY-wide. The AbortController/timeout
  // is armed INSIDE the pacer callback, same as YahooFinanceEnrichmentProvider/
  // AlphaVantageEnrichmentProvider above, so the timeout starts counting at actual dispatch time,
  // not when this call joins the (potentially long, strictly-serial) pacer queue.
  const response = await withProviderLimit(options.service, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
    try {
      return await fetchWithRetry(
        `https://${host}${path}`,
        {
          cache: "no-store",
          signal: controller.signal,
          headers: { "x-rapidapi-host": host, "x-rapidapi-key": apiKey }
        },
        {
          service: options.service,
          keySource: options.keySource,
          userId: options.userId,
          apiKey,
          // retries: 0 — every caller here reserves exactly one unit via tryReserveRapidApiCalls
          // before invoking this helper (see fetchWithRetry's own doc comment on this convention,
          // and the AlphaVantageEnrichmentProvider call sites above). A built-in 429 retry would
          // fire a second real fetch() against the RapidAPI host while the persisted daily budget
          // only ever gets decremented by 1, silently letting a single admitted reservation spend
          // two real upstream calls right when the scarce monthly-backed quota is closest to empty.
          retries: 0,
          durableAttempt: {
            onDispatch: () => { if (dispatchTracker) dispatchTracker.dispatched = true; },
            onResponse: (r) => recordProviderCall(options.service, { ok: r.ok, keySource: options.keySource, userId: options.userId }),
            onTransportError: () => recordProviderCall(options.service, { ok: false, keySource: options.keySource, userId: options.userId })
          }
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

interface SteadyApiQuoteBody {
  symbol?: string;
  companyName?: string;
  primaryData?: { lastSalePrice?: string; netChange?: string; percentageChange?: string; volume?: string };
  keyStats?: { fiftyTwoWeekHighLow?: { value?: string } };
}

/** Parses the shared Mboum/YH-Finance-15 quote response shape into the price-family + companyName
 *  + 52-week-range fields. Every numeric leaf is a formatted string — see parseRapidApiNumberString.
 *  Tolerant of a missing/malformed body: returns {} rather than throwing, so one odd response never
 *  takes down the whole symbol's enrichment. */
export function parseSteadyApiQuote(payload: unknown): SymbolEnrichment {
  const body = (payload as { body?: SteadyApiQuoteBody } | undefined)?.body;
  if (!body) return {};
  const pd = body.primaryData ?? {};
  const price = parseRapidApiNumberString(pd.lastSalePrice);
  const intradayChangePct = parseRapidApiNumberString(pd.percentageChange);
  const volume = parseRapidApiNumberString(pd.volume);
  const companyName = typeof body.companyName === "string" && body.companyName ? body.companyName : undefined;

  let fiftyTwoWeekHigh: number | undefined;
  let fiftyTwoWeekLow: number | undefined;
  const range = body.keyStats?.fiftyTwoWeekHighLow?.value;
  if (typeof range === "string" && range.includes("-")) {
    // Split only on a "-" with whitespace on both sides (the observed separator, e.g.
    // "201.50 - 334.68"), not on a bare "-" — a naive `split("-")` would mis-tokenize a
    // negative bound (e.g. "-5.00 - 10.00") into 3 parts and silently misassign lo/hi.
    const parts = range.split(/\s+-\s+/).map((part) => parseRapidApiNumberString(part.trim()));
    const [lo, hi] = parts;
    if (typeof lo === "number") fiftyTwoWeekLow = lo;
    if (typeof hi === "number") fiftyTwoWeekHigh = hi;
  }

  return {
    ...(price !== undefined && price > 0 && { price }),
    ...(intradayChangePct !== undefined && { intradayChangePct }),
    ...(volume !== undefined && volume >= 0 && { volume }),
    ...(companyName !== undefined && { companyName }),
    ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
  };
}

/** Tolerant extraction of sector/industry from the "asset-profile" module response — the ONLY
 *  module name confirmed live against either host (multi-module and other module names are
 *  explicitly UNCONFIRMED — see the 2026-07-19 rollout note). The exact wrapper shape around
 *  `{sector, industry}` was only directly observed on the YH Finance 15 host; this scans several
 *  plausible nesting levels (bare, `.body`, `.assetProfile`, `.body.assetProfile`) rather than
 *  assuming one, so a shape difference on the Mboum host degrades to {} instead of throwing. */
export function parseSteadyApiAssetProfile(payload: unknown): SymbolEnrichment {
  const root = payload as Record<string, unknown> | undefined;
  if (!root) return {};
  const bodyRec = root.body as Record<string, unknown> | undefined;
  const candidates: Array<Record<string, unknown> | undefined> = [
    root,
    bodyRec,
    root.assetProfile as Record<string, unknown> | undefined,
    bodyRec?.assetProfile as Record<string, unknown> | undefined
  ];
  for (const candidate of candidates) {
    const sector = typeof candidate?.sector === "string" && candidate.sector ? candidate.sector : undefined;
    const industry = typeof candidate?.industry === "string" && candidate.industry ? candidate.industry : undefined;
    if (sector || industry) {
      return { ...(sector !== undefined && { sector }), ...(industry !== undefined && { industry }) };
    }
  }
  return {};
}

/**
 * Shared implementation for Mboum Finance and YH Finance 15 — RapidAPI's own listing describes both
 * as fronting the same "steadyapi.com" backend, and their confirmed response shapes are byte-
 * identical (2026-07-19 ground truth). Only the host, the "/api" path prefix (YH Finance 15 only),
 * and the quote endpoint's symbol query-param name (`symbol` vs `ticker`) differ between the two.
 *
 * MVP-narrow by design: only the confirmed "quote" (price-family + companyName + 52-week range)
 * and "asset-profile" (sector/industry) calls are made — up to 2 requests/symbol, EACH gated by
 * this provider's own tiny persisted daily budget (rapidapi-quota.ts) before it dispatches. A
 * symbol that doesn't clear the budget gate is simply left unenriched by this provider this run and
 * falls through to whatever else in the cascade can fill it (the free Yahoo scrape, in practice).
 */
export class SteadyApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly configured = true;
  readonly costTier = "paid" as const;
  // Quota-scarce: YH Finance 15's Basic tier is 100 requests per MONTH (Mboum ~500/month), so this
  // lane must only ever be spent on symbols the free keyless Yahoo scrape (and every earlier tier)
  // left with a real gap. See the cascade's wave-two gate in CascadingEnrichmentProvider.enrich.
  readonly quotaScarce = true;
  // Exactly the keys parseSteadyApiQuote + parseSteadyApiAssetProfile can produce — keep in sync
  // with those two parsers (a field omitted here would never trigger a call and would be lost).
  readonly suppliesFields = [
    "price",
    "intradayChangePct",
    "volume",
    "companyName",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "sector",
    "industry"
  ] as const;
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;
  // Mboum's modules-endpoint param name is UNCONFIRMED (only Mboum's OWN quote endpoint —
  // `symbol=` — and the sibling YH Finance host's modules endpoint — `ticker=` — were directly
  // tested; see the rollout note). Rather than hardcode a guess, the first modules call this
  // process makes tries `initialModuleParam`; if that response yields neither sector nor industry,
  // it retries ONCE with the other param name and remembers whichever one worked for the rest of
  // this process's lifetime (cheap to re-learn after a restart — this is a low-volume failover
  // source, and `moduleParamConfirmed` skips the guesswork entirely on the host where it's known).
  private resolvedModuleParam: string | undefined;

  constructor(
    readonly name: RapidApiProviderKey,
    private readonly host: string,
    private readonly apiPathPrefix: string,
    private readonly quoteSymbolParam: string,
    private readonly initialModuleParam: string,
    private readonly moduleParamConfirmed: boolean,
    private readonly apiKey: string,
    keySource: ApiKeySource,
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((symbol) => this.enrichOne(symbol, context, now, result)));
    }
    return result;
  }

  private async enrichOne(
    symbol: string,
    context: EnrichmentContext | undefined,
    now: number,
    result: Record<string, SymbolEnrichment>
  ): Promise<void> {
    // Short-circuit coverage hint (see EnrichmentContext doc comment): only skip the modules call
    // when a free upstream already filled BOTH fields it would supply. The quote call has no such
    // skip — App A's coverage hint never includes price-family fields, so checking would be a no-op.
    const covered = context?.coveredFields?.[symbol];
    const wantModules = !covered || !covered.has("sector") || !covered.has("industry");

    let quoteData: SymbolEnrichment = {};
    const quoteAdmitted = tryReserveRapidApiCalls(this.name, 1, now) > 0;
    if (quoteAdmitted) {
      const tracker = { dispatched: false };
      try {
        const payload = await rapidApiGetJson(
          this.host,
          `${this.apiPathPrefix}/v1/markets/quote?${this.quoteSymbolParam}=${encodeURIComponent(symbol)}&type=STOCKS`,
          this.apiKey,
          { service: this.name, keySource: this.keySource, userId: this.userId },
          tracker
        );
        quoteData = parseSteadyApiQuote(payload);
      } catch {
        if (!tracker.dispatched) refundRapidApiCalls(this.name, 1, now);
      }
    }

    const moduleData = wantModules ? await this.fetchAssetProfile(symbol, now) : {};

    const merged: SymbolEnrichment = { ...quoteData, ...moduleData };
    if (Object.keys(merged).length > 0) {
      writeEnrichmentCache(this.name, symbol, this.scope, this.userId, merged, now + ttlMs());
    }
    result[symbol] = merged;
  }

  private async fetchAssetProfile(symbol: string, now: number): Promise<SymbolEnrichment> {
    const firstParam = this.resolvedModuleParam ?? this.initialModuleParam;
    const params = this.moduleParamConfirmed || this.resolvedModuleParam
      ? [firstParam]
      : [firstParam, this.otherParam(firstParam)];

    for (const param of params) {
      const admitted = tryReserveRapidApiCalls(this.name, 1, now) > 0;
      if (!admitted) return {};
      const tracker = { dispatched: false };
      try {
        const payload = await rapidApiGetJson(
          this.host,
          `${this.apiPathPrefix}/v1/markets/stock/modules?${param}=${encodeURIComponent(symbol)}&module=asset-profile`,
          this.apiKey,
          { service: this.name, keySource: this.keySource, userId: this.userId },
          tracker
        );
        const parsed = parseSteadyApiAssetProfile(payload);
        if (Object.keys(parsed).length > 0) {
          this.resolvedModuleParam = param; // remember what worked — skip the guesswork next time
          return parsed;
        }
        // Reached the network and got a response, but neither sector nor industry was present —
        // worth trying the other param name once on an unconfirmed host before giving up.
      } catch {
        if (!tracker.dispatched) refundRapidApiCalls(this.name, 1, now);
      }
    }
    return {};
  }

  private otherParam(param: string): string {
    return param === "symbol" ? "ticker" : "symbol";
  }
}

function alphaVantageOverviewErrorMessage(payload: unknown): string | undefined {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) return undefined;
  const raw = p.Note || p.Information || p["Error Message"];
  return typeof raw === "string" && raw ? raw : undefined;
}

function avOverviewNumber(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "None" || trimmed === "-") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function avOverviewString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed && trimmed !== "None" ? trimmed : undefined;
}

/**
 * Maps Alpha Vantage's OVERVIEW response into EXISTING SymbolEnrichment fundamentals fields ONLY
 * (owner instruction: no new schema fields this pass) — restricted to fields whose scale AV's
 * documented schema makes unambiguous, cross-checked against how YahooFinanceEnrichmentProvider
 * already stores the SAME field so the two sources stay unit-consistent under first-wins merging:
 *   - dividendYield: AV's `DividendYield` is a decimal fraction (e.g. "0.0068"), same convention as
 *     Yahoo's `trailingAnnualDividendYield` — converted to percentage points (*100), matching Yahoo.
 *   - epsGrowth: AV's `QuarterlyEarningsGrowthYOY` is also a decimal fraction, but
 *     YahooFinanceEnrichmentProvider stores its `epsGrowth` as the RAW fraction with NO *100
 *     conversion (see `fetchSymbol` above) — mirrored here unconverted so the two sources can't
 *     disagree by a factor of 100 depending on which one wins first-wins for a given symbol.
 * Deliberately SKIPS a few OVERVIEW fields that would otherwise map onto existing SymbolEnrichment
 * properties:
 *   - PercentInstitutions → institutionOwnershipPct: AV's documented scale for this field could not
 *     be confirmed (unlike Yahoo's institutionOwnership, an unambiguous 0-1 fraction) — mapping it
 *     on an unverified assumption risks silently reporting institutional ownership off by 100x.
 *     Left unmapped until confirmed against a real response.
 *   - ReturnOnEquityTTM/ReturnOnAssetsTTM/AnalystTargetPrice: OVERVIEW does supply these, but they're
 *     outside the MVP field list this pass targets — kept out to hold the surface area to what was
 *     actually scoped, not because AV lacks them.
 *   - shortPercentOfFloat/debtToEquity/fcfYield/daysToEarnings: OVERVIEW has no equivalent field at
 *     all (no short-interest, no leverage ratio, no FCF, no calendar) — never fabricated.
 */
export function parseAlphaVantageOverview(payload: Record<string, unknown>): SymbolEnrichment {
  const peRatio = avOverviewNumber(payload.PERatio);
  const dividendYieldRaw = avOverviewNumber(payload.DividendYield);
  const eps = avOverviewNumber(payload.EPS);
  const sector = avOverviewString(payload.Sector);
  const industry = avOverviewString(payload.Industry);
  const pbRatio = avOverviewNumber(payload.PriceToBookRatio);
  const beta = avOverviewNumber(payload.Beta);
  const fiftyTwoWeekHigh = avOverviewNumber(payload["52WeekHigh"]);
  const fiftyTwoWeekLow = avOverviewNumber(payload["52WeekLow"]);
  const epsGrowthRaw = avOverviewNumber(payload.QuarterlyEarningsGrowthYOY);

  const strongBuy = avOverviewNumber(payload.AnalystRatingStrongBuy);
  const buy = avOverviewNumber(payload.AnalystRatingBuy);
  const hold = avOverviewNumber(payload.AnalystRatingHold);
  const sell = avOverviewNumber(payload.AnalystRatingSell);
  const strongSell = avOverviewNumber(payload.AnalystRatingStrongSell);
  let analystBySource: Record<string, AnalystRatingDetail> | undefined;
  if ([strongBuy, buy, hold, sell, strongSell].some((v) => typeof v === "number")) {
    const counts = { strongBuy: strongBuy ?? 0, buy: buy ?? 0, hold: hold ?? 0, sell: sell ?? 0, strongSell: strongSell ?? 0 };
    const score = analystScoreFromCounts(counts);
    if (score !== undefined) {
      analystBySource = { "alpha-vantage-rapidapi": { score: Math.round(score), label: labelFromAnalystScore(score), counts } };
    }
  }

  return {
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(dividendYieldRaw !== undefined && dividendYieldRaw >= 0 && { dividendYield: Math.round(dividendYieldRaw * 10000) / 100 }),
    ...(eps !== undefined && { eps }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry }),
    ...(pbRatio !== undefined && pbRatio > 0 && { pbRatio }),
    ...(beta !== undefined && { beta }),
    ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow }),
    ...(epsGrowthRaw !== undefined && { epsGrowth: epsGrowthRaw }),
    ...(analystBySource !== undefined && { analystBySource })
  };
}

/**
 * Parse Alpha Vantage NEWS_SENTIMENT feed (native or RapidAPI — byte-identical shape) into
 * sentiment 0–100 + up to 5 headlines. Shared by the RapidAPI failover lane.
 */
export function parseAlphaVantageNewsSentiment(
  payload: Record<string, unknown>,
  symbol: string
): Pick<SymbolEnrichment, "sentiment" | "headlines"> {
  if (!payload || !Array.isArray(payload.feed)) return {};
  const feed = payload.feed as Array<Record<string, unknown>>;
  const headlines = feed
    .slice(0, 5)
    .map((item) => (typeof item.title === "string" ? item.title.trim() : ""))
    .filter(Boolean);

  let scoreSum = 0;
  let scoreCount = 0;
  for (const item of feed.slice(0, 20)) {
    const tickerArr = Array.isArray(item.ticker_sentiment) ? item.ticker_sentiment : [];
    const targetTicker = tickerArr.find((t: { ticker?: string }) => t.ticker === symbol);
    if (targetTicker && typeof targetTicker.ticker_sentiment_score === "string") {
      const score = Number(targetTicker.ticker_sentiment_score);
      if (Number.isFinite(score)) {
        scoreSum += score;
        scoreCount++;
      }
    } else if (typeof item.overall_sentiment_score === "number" && Number.isFinite(item.overall_sentiment_score)) {
      // Fallback when ticker_sentiment is absent (some RapidAPI responses only carry overall).
      scoreSum += item.overall_sentiment_score;
      scoreCount++;
    }
  }

  const sentiment =
    scoreCount > 0
      ? Math.max(0, Math.min(100, Math.round(50 + (scoreSum / scoreCount) * 100)))
      : undefined;

  return {
    ...(sentiment !== undefined && { sentiment }),
    ...(headlines.length > 0 && { headlines })
  };
}

/**
 * Alpha Vantage via RapidAPI (host alpha-vantage.p.rapidapi.com) — a DIFFERENT credential/transport
 * from the native AlphaVantageEnrichmentProvider above (query-param `apikey=`, own key pool, 25/day
 * native per-source-IP cap). This lane authenticates via the x-rapidapi-host/x-rapidapi-key headers
 * instead, and its real quota shape is a flat 500/day (RapidAPI dashboard, owner-confirmed) + 5
 * req/min — nothing like the native key-pool's daily cap, so it gets its OWN persisted budget
 * (rapidapi-quota.ts) rather than sharing tryReserveAlphaVantageCalls. Confirmed byte-identical JSON
 * shape to native (2026-07-19 ground truth). Wires OVERVIEW (fundamentals) plus NEWS_SENTIMENT
 * (headlines/sentiment) when the coveredFields hint still shows those gaps — so Alpaca/Yahoo news
 * winners do not burn this quota.
 */
export class AlphaVantageRapidApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpha-vantage-rapidapi";
  readonly costTier = "paid" as const;
  readonly configured = true;
  // Quota-scarce (500/day shared against the 900/day combined ceiling) — gated into the cascade's
  // second wave so it is never spent on a symbol every field it supplies is already filled for.
  readonly quotaScarce = true;
  // Keep in sync with parseAlphaVantageOverview + parseAlphaVantageNewsSentiment.
  readonly suppliesFields = [
    "peRatio",
    "dividendYield",
    "eps",
    "sector",
    "industry",
    "pbRatio",
    "beta",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "epsGrowth",
    "analystBySource",
    "sentiment",
    "headlines"
  ] as const;
  private readonly host = "alpha-vantage.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(private readonly apiKey: string, keySource: ApiKeySource = "env", private readonly userId?: string) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const overviewFields = [
      "peRatio", "dividendYield", "eps", "sector", "industry", "pbRatio", "beta",
      "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "epsGrowth", "analystBySource"
    ] as const;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const covered = context?.coveredFields?.[symbol];
          const needOverview = !covered || overviewFields.some((f) => !covered.has(f));
          const needNews = !covered || !covered.has("sentiment") || !covered.has("headlines");
          if (!needOverview && !needNews) {
            result[symbol] = {};
            return;
          }

          const merged: SymbolEnrichment = {};

          if (needOverview) {
            const admitted = tryReserveRapidApiCalls("alpha-vantage-rapidapi", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                const errorMessage = alphaVantageOverviewErrorMessage(payload);
                if (errorMessage) {
                  logApiHealth({
                    service: this.name,
                    ok: false,
                    errorText: scrubProviderErrorText(`Alpha Vantage (RapidAPI) API warning/error: ${errorMessage}`, this.apiKey),
                    keySource: this.keySource,
                    userId: this.userId
                  });
                  throw new Error("Alpha Vantage (RapidAPI) API warning/error");
                }
                Object.assign(merged, parseAlphaVantageOverview(payload as Record<string, unknown>));
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("alpha-vantage-rapidapi", 1, now);
              }
            }
          }

          if (needNews) {
            const admitted = tryReserveRapidApiCalls("alpha-vantage-rapidapi", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&limit=50`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                if (payload && typeof payload === "object") {
                  const errMsg = alphaVantageOverviewErrorMessage(payload);
                  if (errMsg) throw new Error(errMsg);
                  Object.assign(merged, parseAlphaVantageNewsSentiment(payload as Record<string, unknown>, symbol));
                }
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("alpha-vantage-rapidapi", 1, now);
              }
            }
          }

          if (Object.keys(merged).length > 0) {
            writeEnrichmentCache(this.name, symbol, this.scope, this.userId, merged, now + ttlMs());
          }
          result[symbol] = merged;
        })
      );
    }
    return result;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Massive REST responses wrap rows in `{ status, request_id, results: [...] }`. Return the first row.
function massiveFirstResult(value: unknown): Record<string, unknown> | undefined {
  const results = (value as { results?: unknown } | null)?.results;
  if (Array.isArray(results) && results.length > 0 && typeof results[0] === "object" && results[0] !== null) {
    return results[0] as Record<string, unknown>;
  }
  return undefined;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function normalizePercent(value: number): number {
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.round(pct * 100) / 100;
}

// Lightweight headline sentiment proxy: counts positive vs negative finance keywords.
const POSITIVE_WORDS = ["beat", "beats", "surge", "surges", "soar", "soars", "rally", "rallies", "upgrade", "upgraded", "record", "growth", "gains", "jumps", "outperform", "buy", "bullish", "strong", "raises", "profit", "wins"];
const NEGATIVE_WORDS = ["miss", "misses", "plunge", "plunges", "drop", "drops", "fall", "falls", "downgrade", "downgraded", "cut", "cuts", "loss", "losses", "warning", "warns", "lawsuit", "probe", "bearish", "weak", "slump", "decline", "fraud", "recall"];

export function scoreHeadlines(headlines: string[]): number {
  let positive = 0;
  let negative = 0;
  for (const headline of headlines) {
    for (const word of headline.toLowerCase().split(/[^a-z]+/)) {
      if (POSITIVE_WORDS.includes(word)) positive += 1;
      if (NEGATIVE_WORDS.includes(word)) negative += 1;
    }
  }
  if (positive + negative === 0) return 50;
  // Damped tanh on the NET signal so a few positive words no longer peg the score at 100.
  // net 1→66, 2→74, 3→81, 5→91 … and it never reaches a hard 0/100 (clamped to 5–95).
  const net = positive - negative;
  const raw = 50 + 50 * Math.tanh(net / 3.5);
  return Math.max(5, Math.min(95, Math.round(raw)));
}

export function clearEnrichmentCache(): void {
  cache.clear();
  yfCreds = null;
}

export class FintechStudiosEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fintechstudios";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base: string;
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.base = process.env.FINTECH_STUDIOS_BASE_URL ?? "https://studio.fintechstudios.com/api/v1";
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("fintechstudios", symbol, this.userId, consented, now);
      if (cached) {
        result[symbol] = cached.data;
      } else {
        misses.push(symbol);
      }
    }

    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            let headlines: string[] = [];
            let sentiment: number | undefined;

            try {
              const url = `${this.base.replace(/\/$/, "")}/search`;
              const response = await fetchWithRetry(url, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${this.apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query: `${symbol} stock`,
                  limit: 5,
                }),
                cache: "no-store",
                signal: controller.signal,
              }, { service: this.name, keySource: this.keySource, userId: this.userId });

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
              }

              const json = (await response.json()) as {
                data?: {
                  articles?: Array<{ title?: string }>;
                };
              };

              const articles = json.data?.articles || [];
              headlines = articles
                .map((a) => (typeof a.title === "string" ? a.title.trim() : ""))
                .filter(Boolean)
                .slice(0, 5);

              if (headlines.length > 0) {
                sentiment = scoreHeadlines(headlines);
              }
            } finally {
              clearTimeout(timeout);
            }

            const data: SymbolEnrichment = {
              ...(headlines.length > 0 && { headlines }),
              ...(sentiment !== undefined && { sentiment }),
            };

            if (headlines.length > 0) {
              writeEnrichmentCache("fintechstudios", symbol, this.scope, this.userId, data, now + ttlMs());
            }
            result[symbol] = data;
          } catch (err) {
            console.error(`[data-providers] Fintech Studios error for ${symbol}:`, err);
            result[symbol] = {};
          }
        })
      );
    }

    return result;
  }
}

// ── Tiingo provider ───────────────────────────────────────────────────────────
// Free plan: IEX real-time quotes, ticker meta (company name), and news.

export class TiingoEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "tiingo";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    // Namespace the cache by news-drop mode: a TIINGO_DROP_NEWS row has no headlines/sentiment, so it
    // must NOT be served once the flag is turned back off (mirrors finnhub's "finnhub-norec" keying).
    const dropNews = flagEnabled(process.env.TIINGO_DROP_NEWS);
    const cacheKey = dropNews ? "tiingo-nonews" : "tiingo";

    for (const symbol of normalized) {
      const cached = readEnrichmentCache(cacheKey, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const headers = { "Authorization": `Token ${this.apiKey}`, "Accept": "application/json" };
    if (misses.length === 0) return result;

    // UNIFORM request quota (provider-rate-limit.ts RATE_QUOTAS): tiingo = 50/hour + 1000/day, and each
    // symbol costs `perSymbol` requests (iex + daily [+ news]). admit() returns how many REQUESTS fit
    // right now; we query floor(that / perSymbol) best-first symbols and defer the rest best-effort.
    // Scan-size-agnostic + per-credential; never stalls. (Owner's Tiingo dashboard showed hourly at
    // -10/50 — an unpaced 30-symbol scan fires ~90 requests and 403s.)
    const perSymbol = callsPerSymbol("tiingo", { dropExtra: dropNews });
    const credKey = await apiKeyFingerprint(this.apiKey);
    const allowedRequests = admitProviderRequests("tiingo", credKey, misses.length * perSymbol);
    const symbolsAllowed = Math.floor(allowedRequests / perSymbol);
    // admit() budgets in REQUESTS but we only dispatch whole symbols — hand back the partial remainder
    // (e.g. 50/hour leaves 2 after 16×3) so those phantom reservations don't drain the daily window or
    // block the last symbols of a later scan.
    refundProviderRequests("tiingo", credKey, allowedRequests - symbolsAllowed * perSymbol);
    const toQuery = misses.slice(0, symbolsAllowed);
    for (const symbol of misses.slice(symbolsAllowed)) result[symbol] = {}; // deferred; not queried this run
    if (toQuery.length === 0) return result; // no hourly budget left — best-effort only
    const negativeCache = (symbol: string) => {
      writeEnrichmentCache(cacheKey, symbol, this.scope, this.userId, {}, now + providerNegativeTtlMs());
      result[symbol] = {};
    };

    for (let i = 0; i < toQuery.length; i += CONCURRENCY) {
      const chunk = toQuery.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const ticker = symbol.toLowerCase();
            const tiingoCalls = [
              this.getJson(`https://api.tiingo.com/iex/${ticker}?token=${this.apiKey}`, headers),
              this.getJson(`https://api.tiingo.com/tiingo/daily/${ticker}?token=${this.apiKey}`, headers)
            ];
            if (!dropNews) tiingoCalls.push(this.getJson(`https://api.tiingo.com/tiingo/news?tickers=${ticker}&limit=5&token=${this.apiKey}`, headers));
            const [iexRaw, metaRaw, newsRaw = { status: "rejected" as const, reason: new Error("news skipped") }] = await Promise.allSettled(tiingoCalls);

            let price: number | undefined;
            let bid: number | undefined;
            let ask: number | undefined;
            let volume: number | undefined;
            let intradayChangePct: number | undefined;

            if (iexRaw.status === "fulfilled") {
              const arr = Array.isArray(iexRaw.value) ? iexRaw.value : [iexRaw.value];
              if (arr.length > 0 && arr[0] && typeof arr[0] === "object") {
                const q = arr[0] as Record<string, unknown>;
                const last = firstNumber(q, ["tngoLast", "mid", "lastPrice", "last"]);
                if (last && last > 0) price = last;
                const b = firstNumber(q, ["bidPrice"]);
                if (b && b > 0) bid = b;
                const a = firstNumber(q, ["askPrice"]);
                if (a && a > 0) ask = a;
                const v = firstNumber(q, ["volume"]);
                if (v && v > 0) volume = v;
                const prevClose = firstNumber(q, ["prevClose"]);
                if (price && prevClose && prevClose > 0) {
                  intradayChangePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
                }
              }
            }

            let companyName: string | undefined;
            if (metaRaw.status === "fulfilled" && metaRaw.value && typeof metaRaw.value === "object") {
              companyName = firstString(metaRaw.value as Record<string, unknown>, ["name"]);
            }

            let headlines: string[] | undefined;
            let sentiment: number | undefined;
            if (newsRaw.status === "fulfilled" && Array.isArray(newsRaw.value)) {
              const items = newsRaw.value as Array<Record<string, unknown>>;
              const titles = items.slice(0, 5).map((n) => firstString(n, ["title"])).filter((t): t is string => Boolean(t));
              if (titles.length > 0) {
                headlines = titles;
                sentiment = scoreHeadlines(titles);
              }
            }

            const data: SymbolEnrichment = {
              ...(price !== undefined && { price }),
              ...(bid !== undefined && { bid }),
              ...(ask !== undefined && { ask }),
              ...(volume !== undefined && { volume }),
              ...(intradayChangePct !== undefined && { intradayChangePct }),
              ...(companyName !== undefined && { companyName }),
              ...(headlines !== undefined && { headlines }),
              ...(sentiment !== undefined && { sentiment })
            };

            // Only the calls we actually made count (news is a synthetic "rejected" when dropped).
            const madeCalls = dropNews ? [iexRaw, metaRaw] : [iexRaw, metaRaw, newsRaw];
            const allRejected = madeCalls.every((p) => p.status === "rejected");
            const hasTransientErr = madeCalls.some(
              (p) => p.status === "rejected" && isTransientError(p.reason)
            );
            // The circuit breaker throws BEFORE any request is sent, so a breaker-skipped symbol never
            // touched the upstream — refund its quota reservation and never negative-cache it.
            const breakerSkipped = allRejected && madeCalls.some(
              (p) => p.status === "rejected" && p.reason instanceof CircuitOpenError
            );

            if (!allRejected && !hasTransientErr && Object.keys(data).length > 0) {
              writeEnrichmentCache(cacheKey, symbol, this.scope, this.userId, data, now + ttlMs());
              result[symbol] = data;
            } else if (!allRejected && !hasTransientErr) {
              negativeCache(symbol); // provider RESPONDED with no usable data — rotate out; don't burn budget
            } else {
              // All sub-calls FAILED (transient 429/5xx, a 401/403 credential/plan error, or a breaker
              // skip). Don't poison the cache — leave the symbol a miss to retry once the issue clears.
              if (breakerSkipped) refundProviderRequests("tiingo", credKey, perSymbol);
              result[symbol] = data;
            }
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // retries: 0 — the quota reserves exactly one request per endpoint, so a built-in 429 retry
      // would emit a second uncounted call and re-break the 50/hour cap this gate enforces.
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal, headers }, { service: this.name, keySource: this.keySource, userId: this.userId, retries: 0 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Twelve Data provider ──────────────────────────────────────────────────────
// Rich /quote endpoint: price, % change, volume, company name, sector, industry,
// P/E, EPS, beta, 52-week range — one batched call for all scan symbols.

export class TwelveDataEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "twelvedata";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("twelvedata", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    if (misses.length === 0) return result;

    // Free-tier CREDIT budget, not symbol count, is the real ceiling: Twelve Data's /quote endpoint
    // charges ONE credit PER SYMBOL in a comma-separated batch, and the free Basic tier allows only
    // ~8 credits/minute. The old code sent up to 120 symbols in a single call = 120 credits at once,
    // which instantly 429s the whole call (observed: 100% failure in prod). So cap a call to at most
    // `creditsPerMin` symbols (default 8) and make exactly ONE call per enrich() covering the
    // highest-priority misses (the scan passes candidates best-first). The per-provider pacer
    // (provider-rate-limit.ts, twelvedata default now 1 call / 60s) then keeps concurrent-account
    // scans from stacking past the per-minute credit budget. Symbols beyond the budget are left
    // best-effort — the enrichment cascade fills them from other providers and the shared cache
    // covers repeats, so coverage accretes across the hourly scans instead of failing outright.
    // UNIFORM request quota (provider-rate-limit.ts RATE_QUOTAS): twelvedata = 8 credits/min + 800/day,
    // 1 credit per symbol. admit() returns how many fit RIGHT NOW under both windows — scan-size-agnostic
    // (works for any number of tickers) and per-credential — and the rest defer best-effort (the cascade
    // + shared cache cover them; coverage accretes across scans). Never blocks/stalls the scan.
    const credKey = await apiKeyFingerprint(this.apiKey);
    const symbolsAllowed = admitProviderRequests(this.name, credKey, misses.length);
    const toQuery = misses.slice(0, symbolsAllowed);
    const skipped = misses.length - toQuery.length;
    for (const symbol of misses.slice(symbolsAllowed)) result[symbol] = {}; // deferred; not queried this run
    if (toQuery.length === 0) return result; // no budget left this window — best-effort only
    if (skipped > 0) {
      // Deliberately NOT a logApiHealth(ok:true) row: that would inflate the success ratio and keep
      // the circuit breaker from ever seeing a genuinely dead Twelve Data lane. Debug-only; the real
      // call's ok/fail is logged below.
      console.debug(`[data-providers] TwelveData quota: queried ${toQuery.length}/${misses.length} symbols (${skipped} deferred this scan)`);
    }
    for (const batch of [toQuery]) {
      try {
        const url = `https://api.twelvedata.com/quote?symbol=${batch.join(",")}&apikey=${this.apiKey}&country=US`;
        // `batch` is already capped to the per-minute credit budget above, so this single request
        // costs at most that many credits. The pacer (provider-rate-limit.ts, twelvedata = 60s
        // serial) spaces successive calls a full minute apart so concurrent-account scans can't sum
        // past the budget. The AbortController/timeout is armed INSIDE the pacer callback so the 10s
        // HTTP timeout starts counting at actual dispatch time, not when this call joins the
        // (strictly-serial) queue — otherwise queue wait eats into the timeout.
        const response = await withProviderLimit(this.name, async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            // deferSuccessLog: true — Twelve Data embeds errors in HTTP 200 responses
            // (e.g. {"status":"error","message":"Invalid API key"}); log only after body validates.
            // retries: 0 — the quota reserved exactly one batch call; a 429 retry would spend a second,
            // uncounted round of credits and re-break the per-minute budget this gate enforces.
            return await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId, deferSuccessLog: true, retries: 0 });
          } finally {
            clearTimeout(timeout);
          }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw: unknown = await response.json();

        if (!raw || typeof raw !== "object") continue;

        // Normalise to a map symbol → quote object.
        // Single symbol → { symbol: "AAPL", close: "..." }
        // Multiple symbols → { AAPL: { symbol: "AAPL", ... }, MSFT: { ... } }
        const quoteMap: Record<string, Record<string, unknown>> = {};
        const rawObj = raw as Record<string, unknown>;

        // Check for a top-level API error (invalid key, quota exhausted, etc.)
        if (rawObj.status === "error" || (rawObj.message && !rawObj.symbol && !rawObj.data)) {
          const msg = typeof rawObj.message === "string" ? rawObj.message : "TwelveData API error";
          logApiHealth({ service: this.name, ok: false, errorText: `TwelveData API error: ${msg}`, keySource: this.keySource, userId: this.userId });
          continue;
        }
        if (typeof rawObj.symbol === "string") {
          // Single-symbol response
          quoteMap[rawObj.symbol as string] = rawObj;
        } else {
          for (const [key, val] of Object.entries(rawObj)) {
            if (val && typeof val === "object" && !Array.isArray(val)) {
              quoteMap[key] = val as Record<string, unknown>;
            }
          }
        }

        // Short negative-cache for a symbol Twelve Data returned NO usable data for (not in the
        // response, an error row, or all-empty fields). Without this it would stay at the FRONT of
        // `misses` every scan and permanently starve lower-ranked symbols of the tiny credit budget
        // (they'd be deferred forever). A short TTL rotates it out for a few scans so others get a
        // turn; it's per-provider so other providers still enrich the symbol.
        const negativeCache = (symbol: string) => {
          writeEnrichmentCache("twelvedata", symbol, this.scope, this.userId, {}, now + providerNegativeTtlMs());
          result[symbol] = {};
        };
        // Tracked across the batch so an ALL-transient batch (mis-sized credit budget, upstream
        // outage) can be flagged below — the ok:true logged above only reflects the outer HTTP
        // 200/JSON-parse success, not whether any embedded per-symbol data was actually usable.
        let anyUsableSymbolData = false;
        let anyEmbeddedTransientError = false;
        for (const symbol of batch) {
          const q = quoteMap[symbol];
          if (!q) {
            negativeCache(symbol); // Twelve Data didn't return this symbol at all
            continue;
          }
          // Skip error responses. A per-symbol code of 429 (rate limit) or 5xx (upstream hiccup) is
          // TRANSIENT, not "this symbol has no data" — same convention as the whole-request error path
          // above (continues without caching) and the App A provider's transportError flag. Negative-
          // caching it would suppress a high-priority symbol for the full negative TTL over a condition
          // that clears on its own. Permanent rows (400/403 plan-restricted/404 not-found, or an error
          // with no code) still rotate out via the negative cache so they don't starve the credit budget.
          if (q.code || q.status === "error" || q.message) {
            const code = Number(q.code);
            if (code === 429 || code >= 500) {
              result[symbol] = {}; // transient — retry next scan, no cache write
              anyEmbeddedTransientError = true;
            } else {
              negativeCache(symbol);
            }
            continue;
          }

          const price = firstNumber(q, ["close", "last"]);
          const volume = firstNumber(q, ["volume"]);
          const companyName = firstString(q, ["name"]);
          const sector = firstString(q, ["sector"]);
          const industry = firstString(q, ["industry"]);
          const peRatio = firstNumber(q, ["pe"]);
          const eps = firstNumber(q, ["eps"]);
          const beta = firstNumber(q, ["beta"]);

          const pctChange = q.percent_change !== undefined ? firstNumber(q, ["percent_change"]) : undefined;

          const fw = q.fifty_two_week && typeof q.fifty_two_week === "object"
            ? q.fifty_two_week as Record<string, unknown>
            : null;
          const fiftyTwoWeekHigh = fw ? firstNumber(fw, ["high"]) : undefined;
          const fiftyTwoWeekLow = fw ? firstNumber(fw, ["low"]) : undefined;

          const data: SymbolEnrichment = {
            ...(price !== undefined && price > 0 && { price }),
            ...(volume !== undefined && volume > 0 && { volume }),
            ...(pctChange !== undefined && { intradayChangePct: pctChange }),
            ...(companyName && { companyName }),
            ...(sector && { sector }),
            ...(industry && { industry }),
            ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
            ...(eps !== undefined && { eps }),
            ...(beta !== undefined && { beta }),
            ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
            ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow })
          };

          if (Object.keys(data).length > 0) {
            writeEnrichmentCache("twelvedata", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
            anyUsableSymbolData = true;
          } else {
            negativeCache(symbol); // returned a row but no usable fields — rotate it out briefly
          }
        }

        // Log exactly ONE health row for this batch, deferred until after per-symbol validation. If the
        // whole batch surfaced embedded transient errors (429/5xx inside the HTTP 200 body) and produced
        // NO usable symbol data, log only the failure — logging ok:true here (reflecting only the outer
        // HTTP/JSON success) AND ok:false below for the same batch would pair them up, and getLaneHealth's
        // circuit breaker trips only when the LAST 5 rows are all failures: alternating success/failure
        // rows for repeated all-transient batches would never reach that state, defeating the point of
        // this health signal. A partial batch (at least one usable symbol) still logs ok:true.
        if (!anyUsableSymbolData && anyEmbeddedTransientError) {
          logApiHealth({
            service: this.name,
            ok: false,
            errorText: "TwelveData batch: no usable symbol data, embedded transient error(s) (429/5xx) in HTTP 200 body",
            keySource: this.keySource,
            userId: this.userId
          });
        } else {
          logApiHealth({ service: this.name, ok: true, keySource: this.keySource, userId: this.userId });
        }
      } catch (err) {
        // A tripped circuit breaker throws before any request is sent, so the batch's admitted credits
        // never reached Twelve Data — hand them back so the breaker cooldown doesn't also drain the
        // local per-minute/day budget and keep the lane deferred after it half-opens.
        if (err instanceof CircuitOpenError) refundProviderRequests(this.name, credKey, batch.length);
        else if (isTransientError(err)) {
          console.warn("[data-providers] TwelveData transient error:", err instanceof Error ? err.message : err);
        }
        for (const symbol of batch) {
          if (!result[symbol]) result[symbol] = {};
        }
      }
    }

    return result;
  }
}

// ── SEC EDGAR XBRL company-facts provider (keyless, DEFAULT ON) ──────────────
// Fills debtToEquity from authoritative SEC 10-K filings via the public
// companyfacts API (https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json).
// Polite 300 ms inter-symbol delay per SEC fair-access guidance.
// Disable with: SEC_XBRL_ENRICHMENT_ENABLED=0

const SEC_XBRL_TTL_MS = 24 * 60 * 60_000; // 24h — filings move slowly
const SEC_XBRL_DELAY_MS = 300; // polite inter-request delay
const SEC_XBRL_FETCH_TIMEOUT_MS = 6_000; // per-symbol fetch cap (kept short — SEC is on the scan path)
const SEC_XBRL_BUDGET_MS = 8_000; // overall wall-clock budget for the SEC pass during a scan

// Only audited PERIODIC reports carry the balance-sheet facts we want. companyfacts also includes
// facts from non-periodic filings (earnings-release 8-K, S-1, pro-forma); a newer 8-K equity fact with
// no aligned debt fact would otherwise win the latest-period reducer and either null out enrichment or
// publish non-periodic leverage. Restrict to 10-K/10-Q and their amendments.
const SEC_XBRL_PERIODIC_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A"]);

// Symbols whose companyfacts fetch is in progress, shared across concurrent enrich() calls. The SEC pass
// keeps warming the cache in the background past the per-scan budget; without this guard a second scan
// that starts before the first's warm finishes would re-fetch the same companyfacts URLs concurrently.
const secXbrlInFlight = new Set<string>();

/** Parse a SEC EDGAR companyfacts JSON blob into debtToEquity (from debt-specific concepts).
 *  EPS is intentionally NOT returned — see the note below (annual SEC EPS ≠ TTM).
 *  Pure function — no I/O. Safe to call with any unknown input; never throws. */
export function parseCompanyFacts(json: unknown): { debtToEquity?: number } {
  try {
    if (!json || typeof json !== "object") return {};
    const root = json as Record<string, unknown>;
    const facts = root.facts;
    if (!facts || typeof facts !== "object") return {};
    const gaap = (facts as Record<string, unknown>)["us-gaap"];
    if (!gaap || typeof gaap !== "object") return {};
    const concepts = gaap as Record<string, unknown>;

    type Fact = { end: string; val: number; form?: string; filed?: string };

    // Helper: extract entries array for a concept + unit (keeping form + filed date).
    function getEntries(concept: string, unit: string): Fact[] {
      const c = concepts[concept];
      if (!c || typeof c !== "object") return [];
      const units = (c as Record<string, unknown>).units;
      if (!units || typeof units !== "object") return [];
      const arr = (units as Record<string, unknown>)[unit];
      if (!Array.isArray(arr)) return [];
      const out: Fact[] = [];
      for (const e of arr) {
        if (e === null || typeof e !== "object") continue;
        const r = e as Record<string, unknown>;
        if (typeof r.end !== "string" || typeof r.val !== "number" || !Number.isFinite(r.val)) continue;
        // Keep only PERIODIC reports — drop 8-K/S-1/pro-forma so a non-periodic fact can't win the
        // latest-period reducer (which would null out enrichment or publish non-periodic leverage).
        const form = typeof r.form === "string" ? r.form : undefined;
        if (!form || !SEC_XBRL_PERIODIC_FORMS.has(form)) continue;
        out.push({
          end: r.end,
          val: r.val,
          form,
          filed: typeof r.filed === "string" ? r.filed : undefined
        });
      }
      return out;
    }

    // Helper: pick the entry for the latest reporting PERIOD across ALL forms (10-K, 10-K/A, AND 10-Q).
    // debtToEquity is a point-in-time balance-sheet ratio, so a newer 10-Q balance sheet supersedes the
    // prior fiscal-year 10-K — preferring the annual filing would publish last year's leverage for most of
    // the year after Q1/Q2/Q3. Tie-break a shared period end by the latest `filed` (an amendment beats the
    // original) so a 10-K/A restatement supersedes the superseded 10-K.
    function latestEntry(entries: Fact[]): Fact | undefined {
      if (entries.length === 0) return undefined;
      return entries.reduce((best, e) => {
        if (e.end > best.end) return e;
        if (e.end === best.end && (e.filed ?? "") > (best.filed ?? "")) return e;
        return best;
      }, entries[0]);
    }

    // Helper: the value of a concept AT a specific reporting-period end date — the latest `filed` at that
    // end wins (an amendment supersedes the original) — so debt + equity facts stay aligned on the SAME
    // period regardless of form (the equity anchor may be a 10-Q quarter).
    function valueAtEnd(entries: Fact[], end: string): number | undefined {
      const atEnd = entries.filter((e) => e.end === end);
      if (atEnd.length === 0) return undefined;
      return atEnd.reduce((best, e) => ((e.filed ?? "") > (best.filed ?? "") ? e : best), atEnd[0]).val;
    }

    // Total DEBT at a period end from debt-specific concepts (never total Liabilities). Returns undefined
    // when no debt concept is present (so we omit debtToEquity rather than fabricate it).
    function debtAtEnd(end: string): number | undefined {
      // Long-term debt, NONCURRENT portion — prefer the pure concept, fall back to the combined
      // debt+finance-lease concept some filers tag instead.
      const noncurrent =
        valueAtEnd(getEntries("LongTermDebtNoncurrent", "USD"), end) ??
        valueAtEnd(getEntries("LongTermDebtAndFinanceLeaseObligationsNoncurrent", "USD"), end);
      // The COMPLETE long-term total (incl. current maturities) — pure concept then combined-lease variant.
      const ltdTotal =
        valueAtEnd(getEntries("LongTermDebt", "USD"), end) ??
        valueAtEnd(getEntries("LongTermDebtAndCapitalLeaseObligations", "USD"), end);
      const debtCurrentAgg = valueAtEnd(getEntries("DebtCurrent", "USD"), end);
      // Current maturities of LT debt — pure concept then combined-lease variant.
      const ltdCurrent =
        valueAtEnd(getEntries("LongTermDebtCurrent", "USD"), end) ??
        valueAtEnd(getEntries("LongTermDebtAndFinanceLeaseObligationsCurrent", "USD"), end);
      // Short-term borrowings OUTSIDE long-term debt (revolver / commercial paper).
      const shortTerm =
        valueAtEnd(getEntries("ShortTermBorrowings", "USD"), end) ??
        valueAtEnd(getEntries("CommercialPaper", "USD"), end);

      // Current-debt portion: prefer the aggregate DebtCurrent; otherwise SUM the separate components
      // (current maturities of LT debt + short-term borrowings) so neither is dropped.
      let current: number | undefined;
      if (debtCurrentAgg !== undefined) current = debtCurrentAgg;
      else if (ltdCurrent !== undefined || shortTerm !== undefined) current = (ltdCurrent ?? 0) + (shortTerm ?? 0);

      if (noncurrent !== undefined) {
        // When NO separate current maturity of LT debt is tagged (LongTermDebtCurrent / aggregate
        // DebtCurrent) but the complete LongTermDebt total is larger, use that total — it bundles the
        // current maturities the noncurrent concept omits — so leverage isn't understated. This gates on
        // the LT-current concepts ONLY, not on `shortTerm`: a separate ShortTermBorrowings/CommercialPaper
        // fact is orthogonal (revolver/CP outside LT debt) and is added on top either way, so its presence
        // must not suppress the ltdTotal-bundles-current-maturities fallback.
        const hasSeparateLtCurrent = debtCurrentAgg !== undefined || ltdCurrent !== undefined;
        if (!hasSeparateLtCurrent && ltdTotal !== undefined && ltdTotal > noncurrent) return ltdTotal + (shortTerm ?? 0);
        return noncurrent + (current ?? 0); // noncurrent-only LT debt + current portion
      }
      // LongTermDebt is the COMPLETE long-term total (don't re-add its current maturities), but add any
      // genuinely-separate ShortTermBorrowings (commercial paper / revolver) — not part of long-term debt.
      if (ltdTotal !== undefined) return ltdTotal + (shortTerm ?? 0);
      if (current !== undefined) return current; // only current-debt concepts present
      return undefined;
    }

    // ── debtToEquity: DEBT-specific concepts ÷ StockholdersEquity, aligned on equity's latest period ──
    // The app treats `debtToEquity` as debt/equity for quality scoring + the bear-veto, so total
    // Liabilities (which includes operating payables/leases/deferred revenue) would over-state leverage.
    // Compute from debt concepts at the SAME period as equity; omit when no debt concept exists there.
    //
    // NOTE: this provider intentionally does NOT publish `eps`. SymbolEnrichment.eps is documented as
    // TRAILING-TWELVE-MONTHS, but SEC companyfacts EPS facts are per-period (annual 10-K / quarterly
    // 10-Q) — the latest annual 10-K EPS is last fiscal year's figure, not current TTM. Since this
    // provider sits ahead of Yahoo in the cascade, publishing annual EPS would override Yahoo's real
    // TTM EPS mid-year with a stale value. debtToEquity is a point-in-time balance-sheet ratio, so the
    // latest reporting PERIOD (annual OR quarterly) is correct for it — see latestEntry above. (A true
    // trailing EPS from quarterly facts could be added later if a TTM-correct computation is wired.)
    let debtToEquity: number | undefined;
    // Anchor on the latest equity PERIOD available under EITHER standard equity concept. Some filers tag
    // the current balance-sheet period only under StockholdersEquityIncludingPortionAttributableToNon-
    // controllingInterest (total equity incl. minority interest), not the parent-only StockholdersEquity;
    // anchoring on the pure concept alone would publish a stale older period (or omit SEC leverage) despite
    // aligned current debt. At the anchored period, PREFER the parent-only value (the conventional D/E
    // denominator), falling back to the inclusive total when only it is tagged there.
    const equityPure = getEntries("StockholdersEquity", "USD");
    const equityIncl = getEntries("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "USD");
    const equityAnchor = latestEntry([...equityPure, ...equityIncl]);
    const equityVal = equityAnchor && (valueAtEnd(equityPure, equityAnchor.end) ?? valueAtEnd(equityIncl, equityAnchor.end));
    if (equityAnchor !== undefined && equityVal !== undefined && equityVal > 0) {
      const totalDebt = debtAtEnd(equityAnchor.end);
      if (totalDebt !== undefined && Number.isFinite(totalDebt) && totalDebt >= 0) {
        const ratio = Math.round((totalDebt / equityVal) * 100) / 100;
        // Publish the RAW true ratio (e.g. 1.5, or 12 for a genuinely 12x-levered name). The bear-veto
        // (strategy.ts) and analytics/exports compare this value directly, so it must NOT be capped or
        // pre-normalized — a cap would let a >ceiling name escape a strict `> ceiling` veto and would
        // understate leverage in exports. Display + quality (market.ts, dashboard-client.tsx) apply a
        // `>10 → ÷100` percentage heuristic for providers that report D/E as a percentage; those call
        // sites are SOURCE-AWARE and skip the heuristic for sec-xbrl (which always emits a true ratio),
        // so a raw 12 is no longer misread as 0.12 there. See market.ts qualityScore / the D/E column.
        debtToEquity = ratio;
      }
    }

    return debtToEquity !== undefined ? { debtToEquity } : {};
  } catch {
    return {};
  }
}

export class SecXbrlEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "sec-xbrl";
  readonly costTier = "free" as const;
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = cache.get(`sec-xbrl:${symbol}`);
      if (cached && cached.expiresAt > now) {
        result[symbol] = cached.data;
      } else {
        misses.push(symbol);
      }
    }
    if (misses.length === 0) return result;

    const deadline = now + SEC_XBRL_BUDGET_MS;

    // Ticker→CIK map (weekly-cached; preserves dual-class tickers that share a CIK). Bound the load by
    // the SAME budget so a cold/expired map fetch (its own 9s timeout + retry) can't block the cascade
    // before the scan budget even starts. On timeout/error, skip SEC this pass and fall through to
    // FMP/Yahoo; the load keeps running in the background to warm its cache for the next scan.
    let tickerToCik: Record<string, string>;
    try {
      const mapPromise = loadTickerCikMap(now);
      mapPromise.catch(() => {});
      const loaded = await Promise.race([
        mapPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())))
      ]);
      if (!loaded) return result;
      tickerToCik = loaded;
    } catch {
      return result;
    }

    const ua = secUserAgent();

    // Bound the SEC pass on the interactive market-scan critical path: the rate-limited loop keeps
    // running in the BACKGROUND to warm the cache, but enrich() returns within the budget with whatever
    // SEC data completed. Symbols not yet fetched fall through to FMP/Yahoo this pass and resolve from
    // the warmed cache on the next scan — a slow/timing-out SEC endpoint can't hang a scan.
    //
    // The budget is enforced SOLELY by the outer Promise.race below — the per-symbol loop deliberately
    // has NO `Date.now() > deadline` short-circuit. A deadline check here would make every symbol after
    // the first slow miss return without fetching, so the cache would never warm past that leading miss
    // and repeated scans would keep retrying it instead of converging. Letting the continuation run to
    // completion (rate-limited + in-flight-deduped, so it never double-hits SEC) warms the full 24h
    // cache; the awaited race still caps interactive latency regardless of how long the loop runs.
    const work = runRateLimited(misses, SEC_XBRL_DELAY_MS, async (symbol) => {
      const cik = tickerToCik[symbol];
      if (!cik) return;
      const cacheKey = `sec-xbrl:${symbol}`;
      // A concurrent scan may have warmed this symbol since we snapshotted misses — use it, don't refetch.
      const fresh = cache.get(cacheKey);
      if (fresh && fresh.expiresAt > Date.now()) { result[symbol] = fresh.data; return; }
      // Dedup concurrent background warms: if another enrich() is already fetching this symbol, skip it
      // (it falls through to Yahoo this pass and resolves from the warmed cache next scan).
      if (secXbrlInFlight.has(symbol)) return;
      secXbrlInFlight.add(symbol);
      try {
        const paddedCik = padCik(cik);
        const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
        const text = await politeFetchText(url, { headers: { "user-agent": ua }, timeoutMs: SEC_XBRL_FETCH_TIMEOUT_MS });
        const json = JSON.parse(text) as unknown;
        const data = parseCompanyFacts(json);
        cache.set(cacheKey, { expiresAt: now + SEC_XBRL_TTL_MS, data });
        result[symbol] = data;
      } catch {
        // best-effort — this symbol falls through to the next provider
      } finally {
        secXbrlInFlight.delete(symbol);
      }
    });
    work.catch(() => {}); // the background continuation must never surface as an unhandled rejection
    // Use the REMAINING budget (the CIK-map race already consumed part of it) so the whole SEC pass —
    // map load + companyfacts fetches — shares one SEC_XBRL_BUDGET_MS, not two.
    await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);

    // Return a SNAPSHOT of what completed within the budget. The background continuation keeps warming
    // the cache (and may still write into `result` for symbols fetched after the race), but it must not
    // retroactively change what THIS pass returns: a late SEC write into the already-returned object
    // could flip a symbol's winning source after enrich() resolved, making the cascade merge order
    // timing-dependent. The spread decouples the returned value from those post-race mutations.
    return { ...result };
  }
}

// ── RapidAPI: Financial Modeling Prep ────────────────────────────────────────

export class FmpRapidApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fmp-rapidapi";
  readonly costTier = "free" as const;
  readonly configured = true;
  readonly quotaScarce = false; // "doubles the quota" per inventory - putting it in wave 1!
  private readonly base = "https://financial-modeling-prep.p.rapidapi.com/v3";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("fmp-rapidapi", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("fmp-rapidapi", 2, now);
          if (admitted < 2) {
            // Give back whatever partial we got, skip this symbol
            refundRapidApiCalls("fmp-rapidapi", admitted, now);
            result[symbol] = {};
            return;
          }
          try {
            const [profileRaw, ratiosRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/profile/${encodeURIComponent(symbol)}`),
              this.getJson(`${this.base}/ratios-ttm/${encodeURIComponent(symbol)}`)
            ]);

            let companyName: string | undefined;
            let sector: string | undefined;
            let industry: string | undefined;
            let beta: number | undefined;
            let dividendYield: number | undefined;
            let fiftyTwoWeekHigh: number | undefined;
            let fiftyTwoWeekLow: number | undefined;

            if (profileRaw.status === "fulfilled" && Array.isArray(profileRaw.value)) {
              const row = (profileRaw.value as Array<Record<string, unknown>>)[0];
              if (row) {
                const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
                const finite = (value: unknown) => {
                  const parsed = Number(value);
                  return Number.isFinite(parsed) ? parsed : undefined;
                };
                companyName = clean(row.companyName);
                sector = clean(row.sector);
                industry = clean(row.industry);
                beta = finite(row.beta);
                const lastDividend = finite(row.lastDividend ?? row.lastDiv);
                const profilePrice = finite(row.price);
                if (lastDividend !== undefined && lastDividend >= 0 && profilePrice !== undefined && profilePrice > 0) {
                  dividendYield = Math.round((lastDividend / profilePrice) * 10_000) / 100;
                }
                const range = clean(row.range)?.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/);
                if (range) {
                  fiftyTwoWeekLow = finite(range[1]);
                  fiftyTwoWeekHigh = finite(range[2]);
                }
              }
            }

            let peRatio: number | undefined;
            let pbRatio: number | undefined;
            let debtToEquity: number | undefined;
            let returnOnEquity: number | undefined;
            let returnOnAssets: number | undefined;
            let grossProfitMargin: number | undefined;

            if (ratiosRaw.status === "fulfilled" && Array.isArray(ratiosRaw.value)) {
              const row = (ratiosRaw.value as Array<Record<string, unknown>>)[0];
              if (row) {
                const finite = (value: unknown) => {
                  const parsed = Number(value);
                  return Number.isFinite(parsed) ? parsed : undefined;
                };
                const percent = (value: unknown) => {
                  const parsed = finite(value);
                  return parsed === undefined ? undefined : Math.round(parsed * 10_000) / 100;
                };
                const pe = finite(row.priceToEarningsRatioTTM);
                const pb = finite(row.priceToBookRatioTTM);
                if (pe !== undefined && pe > 0) peRatio = pe;
                if (pb !== undefined && pb > 0) pbRatio = pb;
                debtToEquity = finite(row.debtToEquityRatioTTM ?? row.debtEquityRatioTTM);
                returnOnEquity = percent(row.returnOnEquityTTM);
                returnOnAssets = percent(row.returnOnAssetsTTM);
                grossProfitMargin = percent(row.grossProfitMarginTTM);
                if (dividendYield === undefined) {
                  dividendYield = percent(row.dividendYieldTTM);
                }
              }
            }

            const data: SymbolEnrichment = {
              ...(peRatio !== undefined && { peRatio }),
              ...(pbRatio !== undefined && { pbRatio }),
              ...(debtToEquity !== undefined && { debtToEquity }),
              ...(returnOnEquity !== undefined && { returnOnEquity }),
              ...(returnOnAssets !== undefined && { returnOnAssets }),
              ...(grossProfitMargin !== undefined && { grossProfitMargin }),
              ...(companyName !== undefined && { companyName }),
              ...(sector !== undefined && { sector }),
              ...(industry !== undefined && { industry }),
              ...(beta !== undefined && { beta }),
              ...(dividendYield !== undefined && { dividendYield }),
              ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
              ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
            };

            writeEnrichmentCache("fmp-rapidapi", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
          } catch (err) {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        {
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "x-rapidapi-host": "financial-modeling-prep.p.rapidapi.com",
            "x-rapidapi-key": this.apiKey
          }
        },
        { service: this.name, keySource: this.keySource, userId: this.userId }
      );
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── RapidAPI: Insiders ───────────────────────────────────────────────────────

export class InsidersRapidApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "insiders-rapidapi";
  readonly costTier = "free" as const;
  readonly configured = true;
  readonly quotaScarce = true; // Use sparingly — wave-two only when insiderSentiment is still empty.
  readonly suppliesFields = ["insiderSentiment"] as const;
  private readonly base = "https://insiders.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("insiders-rapidapi", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("insiders-rapidapi", 1, now) > 0;
          if (!admitted) { result[symbol] = {}; return; }
          try {
            const raw = await this.getJson(`${this.base}/gedetailedtinsiders/${encodeURIComponent(symbol)}?timeframe=1y`);
            
            let insiderSentiment: number | undefined;
            if (raw && typeof raw === "object" && Array.isArray((raw as any).transactions)) {
              let buys = 0;
              let sells = 0;
              
              const txns = (raw as any).transactions;
              for (const group of txns) {
                if (Array.isArray(group.transactions)) {
                  for (const trade of group.transactions) {
                    const type = String(trade.transactionLabel || "").toLowerCase();
                    const code = String(trade.transactionAcquiredDisposedCode || "").toLowerCase();
                    if (type.includes("buy") || type.includes("purchase") || code === "a") buys++;
                    else if (type.includes("sell") || type.includes("sale") || code === "d") sells++;
                  }
                }
              }
              const total = buys + sells;
              if (total > 0) {
                insiderSentiment = Math.round((buys / total) * 100);
              }
            }

            const data: SymbolEnrichment = {
              ...(insiderSentiment !== undefined && { insiderSentiment })
            };

            writeEnrichmentCache("insiders-rapidapi", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
          } catch (err) {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        {
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "x-rapidapi-host": "insiders.p.rapidapi.com",
            "x-rapidapi-key": this.apiKey
          }
        },
        { service: this.name, keySource: this.keySource, userId: this.userId }
      );
      if (response.status === 404) return { transactions: [] };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── RapidAPI: Twelve Data ────────────────────────────────────────────────────

export class TwelveDataRapidApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "twelvedata-rapidapi";
  readonly costTier = "free" as const;
  readonly configured = true;
  readonly quotaScarce = true; // Use sparingly — wave-two only when 52w range is still empty.
  readonly suppliesFields = ["fiftyTwoWeekHigh", "fiftyTwoWeekLow"] as const;
  private readonly base = "https://twelve-data1.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("twelvedata-rapidapi", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("twelvedata-rapidapi", 1, now) > 0;
          if (!admitted) { result[symbol] = {}; return; }
          try {
            const raw = await this.getJson(`${this.base}/quote?symbol=${encodeURIComponent(symbol)}&interval=1day`);
            
            let fiftyTwoWeekHigh: number | undefined;
            let fiftyTwoWeekLow: number | undefined;
            
            if (raw && typeof raw === "object") {
              const fiftyTwo = (raw as any).fifty_two_week;
              if (fiftyTwo) {
                const high = Number(fiftyTwo.high);
                const low = Number(fiftyTwo.low);
                if (Number.isFinite(high) && high > 0) fiftyTwoWeekHigh = high;
                if (Number.isFinite(low) && low > 0) fiftyTwoWeekLow = low;
              }
            }

            const data: SymbolEnrichment = {
              ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
              ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
            };

            writeEnrichmentCache("twelvedata-rapidapi", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
          } catch (err) {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        {
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "x-rapidapi-host": "twelve-data1.p.rapidapi.com",
            "x-rapidapi-key": this.apiKey
          }
        },
        { service: this.name, keySource: this.keySource, userId: this.userId }
      );
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── FilingAPI.dev (FILINGAPI) ────────────────────────────────────────────────
// https://filingapi.dev — X-API-Key header (company/calendar); some routes also
// accept ?api_key=. Free tier ~50 req/day → scarce wave-C only.

export function parseFilingApiCompany(payload: unknown): SymbolEnrichment {
  const row = payload as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") return {};
  const ticker = firstString(row, ["ticker", "symbol"]);
  const sector = firstString(row, ["sector"]);
  const industry = firstString(row, ["industry"]);
  const companyName = firstString(row, ["company_name", "companyName", "name"]) ?? ticker;
  return {
    ...(companyName !== undefined && { companyName }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry })
  };
}

export function parseFilingApiEarningsCalendar(
  payload: unknown,
  symbol: string,
  now: number = Date.now()
): Pick<SymbolEnrichment, "daysToEarnings"> {
  const earnings = (payload as { earnings?: Array<Record<string, unknown>> } | undefined)?.earnings;
  if (!Array.isArray(earnings) || earnings.length === 0) return {};
  const upper = symbol.toUpperCase();
  const future = earnings
    .filter((e) => String(e.symbol ?? "").toUpperCase() === upper && typeof e.date === "string")
    .map((e) => Date.parse(String(e.date)))
    .filter((ts) => Number.isFinite(ts) && ts >= now - 12 * 3_600_000)
    .sort((a, b) => a - b);
  if (future.length === 0) return {};
  const days = Math.max(0, Math.ceil((future[0] - now) / 86_400_000));
  return { daysToEarnings: days };
}

/** Map FilingAPI insider summary → 0–100 insiderSentiment (50 = neutral). */
export function parseFilingApiInsiderSummary(payload: unknown): Pick<SymbolEnrichment, "insiderSentiment"> {
  const row = payload as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") return {};
  const sellRatio = firstNumber(row, ["sell_ratio", "sellRatio"]);
  const signal = firstString(row, ["signal"]);
  let score: number | undefined;
  if (sellRatio !== undefined) {
    score = Math.max(5, Math.min(95, Math.round(50 - (sellRatio - 0.5) * 80)));
  } else if (signal === "net_selling") {
    score = 30;
  } else if (signal === "net_buying") {
    score = 70;
  }
  return score !== undefined ? { insiderSentiment: score } : {};
}

export class FilingApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "filingapi";
  readonly costTier = "paid" as const;
  readonly configured = true;
  readonly quotaScarce = true;
  readonly suppliesFields = ["companyName", "sector", "industry", "daysToEarnings", "insiderSentiment"] as const;
  private readonly base = "https://filingapi.dev";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const credKey = `${this.keySource}:${this.userId ?? ""}`;
    // ~50/day free tier — admit at most one symbol-bundle per reservation unit.
    const allowed = admitProviderRequests(this.name, credKey, misses.length);
    if (!allowed) return result;
    const work = misses.slice(0, allowed);

    for (let i = 0; i < work.length; i += CONCURRENCY) {
      const chunk = work.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const covered = context?.coveredFields?.[symbol];
            const needCompany =
              !covered || !covered.has("companyName") || !covered.has("sector") || !covered.has("industry");
            const needEarnings = !covered || !covered.has("daysToEarnings");
            const needInsiders = !covered || !covered.has("insiderSentiment");
            const [companyRes, earningsRes, insiderRes] = await Promise.allSettled([
              needCompany ? this.getJson(`/v1/company/${encodeURIComponent(symbol)}`) : Promise.resolve(undefined),
              needEarnings
                ? this.getJson(`/v1/calendar/earnings?ticker=${encodeURIComponent(symbol)}`)
                : Promise.resolve(undefined),
              needInsiders
                ? this.getJson(`/v1/insiders/${encodeURIComponent(symbol)}/summary?api_key=${encodeURIComponent(this.apiKey)}`)
                : Promise.resolve(undefined)
            ]);
            const merged: SymbolEnrichment = {
              ...(companyRes.status === "fulfilled" ? parseFilingApiCompany(companyRes.value) : {}),
              ...(earningsRes.status === "fulfilled"
                ? parseFilingApiEarningsCalendar(earningsRes.value, symbol, now)
                : {}),
              ...(insiderRes.status === "fulfilled" ? parseFilingApiInsiderSummary(insiderRes.value) : {})
            };
            if (Object.keys(merged).length > 0) {
              writeEnrichmentCache(this.name, symbol, this.scope, this.userId, merged, now + 6 * 60 * 60_000);
            }
            result[symbol] = merged;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getJson(path: string): Promise<unknown> {
    return withProviderLimit(this.name, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetchWithRetry(
          `${this.base}${path}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "X-API-Key": this.apiKey
            }
          },
          { service: this.name, keySource: this.keySource, userId: this.userId, apiKey: this.apiKey, retries: 0 }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

// ── RapidAPI: Yahoo Finance (API Dojo) ───────────────────────────────────────
// Hub listing currently API-not-found (delisted); host still answers 403 if unsubscribed.
// Host: yh-finance.p.rapidapi.com

function yahooChartRaw(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "raw" in (value as object)) {
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

export function parseYhFinanceApiDojoSummary(payload: unknown): SymbolEnrichment {
  const root = payload as Record<string, unknown> | undefined;
  if (!root) return {};
  const quoteType = (root.quoteType ?? {}) as Record<string, unknown>;
  const summaryProfile = (root.summaryProfile ?? {}) as Record<string, unknown>;
  const summaryDetail = (root.summaryDetail ?? {}) as Record<string, unknown>;
  const defaultKeyStatistics = (root.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const financialData = (root.financialData ?? {}) as Record<string, unknown>;
  const priceNode = (root.price ?? {}) as Record<string, unknown>;

  const companyName =
    firstString(quoteType, ["longName", "shortName"]) ??
    firstString(priceNode, ["longName", "shortName"]);
  const sector = firstString(summaryProfile, ["sector"]);
  const industry = firstString(summaryProfile, ["industry"]);
  const price = yahooChartRaw(priceNode.regularMarketPrice) ?? yahooChartRaw(financialData.currentPrice);
  const changePct = yahooChartRaw(priceNode.regularMarketChangePercent);
  const volume = yahooChartRaw(priceNode.regularMarketVolume);
  const peRatio = yahooChartRaw(summaryDetail.trailingPE) ?? yahooChartRaw(defaultKeyStatistics.trailingPE);
  const dividendYieldRaw = yahooChartRaw(summaryDetail.dividendYield);
  const beta = yahooChartRaw(summaryDetail.beta) ?? yahooChartRaw(defaultKeyStatistics.beta);
  const fiftyTwoWeekHigh = yahooChartRaw(summaryDetail.fiftyTwoWeekHigh);
  const fiftyTwoWeekLow = yahooChartRaw(summaryDetail.fiftyTwoWeekLow);
  const shortPct = yahooChartRaw(defaultKeyStatistics.shortPercentOfFloat);
  const targetMean = yahooChartRaw(financialData.targetMeanPrice);
  const eps = yahooChartRaw(defaultKeyStatistics.trailingEps);
  const pbRatio = yahooChartRaw(defaultKeyStatistics.priceToBook);
  const roe = yahooChartRaw(financialData.returnOnEquity);

  let analystBySource: Record<string, AnalystRatingDetail> | undefined;
  const recMean = yahooChartRaw(financialData.recommendationMean);
  if (recMean !== undefined && recMean > 0) {
    const score = analystScoreFromMean(recMean);
    analystBySource = {
      "yh-finance-apidojo": {
        score: Math.round(score),
        label: labelFromAnalystScore(score),
        mean: Math.round(recMean * 100) / 100
      }
    };
  }

  return {
    ...(companyName !== undefined && { companyName }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry }),
    ...(price !== undefined && price > 0 && { price }),
    ...(changePct !== undefined && { intradayChangePct: Math.abs(changePct) <= 1 ? changePct * 100 : changePct }),
    ...(volume !== undefined && volume >= 0 && { volume }),
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(dividendYieldRaw !== undefined && dividendYieldRaw >= 0 && { dividendYield: normalizePercent(dividendYieldRaw) }),
    ...(beta !== undefined && { beta }),
    ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow }),
    ...(shortPct !== undefined && shortPct >= 0 && { shortPercentOfFloat: normalizePercent(shortPct) }),
    ...(targetMean !== undefined && targetMean > 0 && { targetMean }),
    ...(eps !== undefined && { eps }),
    ...(pbRatio !== undefined && pbRatio > 0 && { pbRatio }),
    ...(roe !== undefined && { returnOnEquity: normalizePercent(roe) }),
    ...(analystBySource !== undefined && { analystBySource })
  };
}

export class YhFinanceApiDojoEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "yh-finance-apidojo";
  readonly costTier = "paid" as const;
  readonly configured = true;
  readonly quotaScarce = true;
  readonly suppliesFields = [
    "companyName", "sector", "industry", "price", "intradayChangePct", "volume",
    "peRatio", "dividendYield", "beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow",
    "shortPercentOfFloat", "targetMean", "eps", "pbRatio", "returnOnEquity", "analystBySource"
  ] as const;
  private readonly host = "yh-finance.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(private readonly apiKey: string, keySource: ApiKeySource = "env", private readonly userId?: string) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("yh-finance-apidojo", 1, now) > 0;
          if (!admitted) { result[symbol] = {}; return; }
          const tracker = { dispatched: false };
          try {
            const payload = await rapidApiGetJson(
              this.host,
              `/stock/v2/get-summary?symbol=${encodeURIComponent(symbol)}&region=US`,
              this.apiKey,
              { service: this.name, keySource: this.keySource, userId: this.userId },
              tracker
            );
            const data = parseYhFinanceApiDojoSummary(payload);
            if (Object.keys(data).length > 0) {
              writeEnrichmentCache(this.name, symbol, this.scope, this.userId, data, now + ttlMs());
            }
            result[symbol] = data;
          } catch {
            if (!tracker.dispatched) refundRapidApiCalls("yh-finance-apidojo", 1, now);
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }
}

// ── RapidAPI: Real-Time Finance Data ─────────────────────────────────────────
// Pricing: https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-finance-data/pricing
// Host: real-time-finance-data.p.rapidapi.com (confirmed 200 with stock-quote + stock-news)

export function parseRealTimeFinanceQuote(payload: unknown): SymbolEnrichment {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) return {};
  const companyName = firstString(data, ["name"]);
  const price = firstNumber(data, ["price"]);
  const changePct = firstNumber(data, ["change_percent", "changePercent"]);
  const volume = firstNumber(data, ["volume"]);
  return {
    ...(companyName !== undefined && { companyName }),
    ...(price !== undefined && price > 0 && { price }),
    ...(changePct !== undefined && { intradayChangePct: changePct }),
    ...(volume !== undefined && volume >= 0 && { volume })
  };
}

export function parseRealTimeFinanceNews(payload: unknown): Pick<SymbolEnrichment, "headlines" | "sentiment"> {
  const news = (payload as { data?: { news?: Array<Record<string, unknown>> } } | undefined)?.data?.news;
  if (!Array.isArray(news) || news.length === 0) return {};
  const headlines = news
    .slice(0, 5)
    .map((n) => firstString(n, ["article_title", "title"]) ?? "")
    .filter(Boolean);
  if (headlines.length === 0) return {};
  return { headlines, sentiment: scoreHeadlines(headlines) };
}

export class RealTimeFinanceDataEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "real-time-finance-data";
  readonly costTier = "paid" as const;
  readonly configured = true;
  readonly quotaScarce = true;
  readonly suppliesFields = ["companyName", "price", "intradayChangePct", "volume", "headlines", "sentiment"] as const;
  private readonly host = "real-time-finance-data.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(private readonly apiKey: string, keySource: ApiKeySource = "env", private readonly userId?: string) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const covered = context?.coveredFields?.[symbol];
          const needQuote =
            !covered ||
            !covered.has("price") ||
            !covered.has("companyName") ||
            !covered.has("intradayChangePct") ||
            !covered.has("volume");
          const needNews = !covered || !covered.has("headlines") || !covered.has("sentiment");
          const merged: SymbolEnrichment = {};

          if (needQuote) {
            const admitted = tryReserveRapidApiCalls("real-time-finance-data", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/stock-quote?symbol=${encodeURIComponent(symbol)}`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                Object.assign(merged, parseRealTimeFinanceQuote(payload));
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("real-time-finance-data", 1, now);
              }
            }
          }

          if (needNews) {
            const admitted = tryReserveRapidApiCalls("real-time-finance-data", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/stock-news?symbol=${encodeURIComponent(symbol)}`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                Object.assign(merged, parseRealTimeFinanceNews(payload));
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("real-time-finance-data", 1, now);
              }
            }
          }

          if (Object.keys(merged).length > 0) {
            writeEnrichmentCache(this.name, symbol, this.scope, this.userId, merged, now + ttlMs());
          }
          result[symbol] = merged;
        })
      );
    }
    return result;
  }
}

// ── RapidAPI: Seeking Alpha (API Dojo) ───────────────────────────────────────
// Hub listing currently API-not-found (delisted); host still answers 403 if unsubscribed.
// Host: seeking-alpha.p.rapidapi.com

export function parseSeekingAlphaKeyStats(payload: unknown): SymbolEnrichment {
  const root = payload as Record<string, unknown> | undefined;
  if (!root) return {};
  // Tolerate several nesting shapes RapidAPI SA products have used over time.
  const candidates: Array<Record<string, unknown> | undefined> = [
    root,
    root.data as Record<string, unknown> | undefined,
    (root.data as { attributes?: Record<string, unknown> } | undefined)?.attributes,
    Array.isArray(root.data) ? (root.data[0] as Record<string, unknown>) : undefined
  ];
  for (const row of candidates) {
    if (!row) continue;
    const peRatio = firstNumber(row, ["peRatio", "pe_ratio", "priceEarningsRatio", "pe"]);
    const eps = firstNumber(row, ["eps", "earningsPerShare", "diluted_eps"]);
    const dividendYield = firstNumber(row, ["dividendYield", "div_yield", "yield"]);
    const beta = firstNumber(row, ["beta"]);
    const companyName = firstString(row, ["companyName", "name", "company"]);
    const sector = firstString(row, ["sector"]);
    const industry = firstString(row, ["industry"]);
    if (
      peRatio !== undefined ||
      eps !== undefined ||
      dividendYield !== undefined ||
      beta !== undefined ||
      companyName ||
      sector ||
      industry
    ) {
      return {
        ...(companyName !== undefined && { companyName }),
        ...(sector !== undefined && { sector }),
        ...(industry !== undefined && { industry }),
        ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
        ...(eps !== undefined && { eps }),
        ...(dividendYield !== undefined && dividendYield >= 0 && { dividendYield: normalizePercent(dividendYield) }),
        ...(beta !== undefined && { beta })
      };
    }
  }
  return {};
}

export function parseSeekingAlphaArticles(payload: unknown): Pick<SymbolEnrichment, "headlines" | "sentiment"> {
  const root = payload as Record<string, unknown> | undefined;
  if (!root) return {};
  const list =
    (Array.isArray(root.data) ? root.data : undefined) ??
    (Array.isArray(root.articles) ? root.articles : undefined) ??
    ((root.data as { articles?: unknown } | undefined)?.articles as unknown[] | undefined) ??
    [];
  if (!Array.isArray(list) || list.length === 0) return {};
  const headlines = list
    .slice(0, 5)
    .map((item) => {
      const row = item as Record<string, unknown>;
      const attrs = (row.attributes ?? row) as Record<string, unknown>;
      return firstString(attrs, ["title", "article_title"]) ?? "";
    })
    .filter(Boolean);
  if (headlines.length === 0) return {};
  return { headlines, sentiment: scoreHeadlines(headlines) };
}

export class SeekingAlphaRapidApiEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "seeking-alpha-rapidapi";
  readonly costTier = "paid" as const;
  readonly configured = true;
  readonly quotaScarce = true;
  readonly suppliesFields = [
    "companyName", "sector", "industry", "peRatio", "eps", "dividendYield", "beta", "headlines", "sentiment"
  ] as const;
  private readonly host = "seeking-alpha.p.rapidapi.com";
  private readonly scope: CacheScope;
  private readonly keySource: ApiKeySource;

  constructor(private readonly apiKey: string, keySource: ApiKeySource = "env", private readonly userId?: string) {
    this.scope = cacheScopeForKeySource(keySource, userId);
    this.keySource = keySource;
  }

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache(this.name, symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const covered = context?.coveredFields?.[symbol];
          const needStats =
            !covered ||
            !covered.has("peRatio") ||
            !covered.has("eps") ||
            !covered.has("sector") ||
            !covered.has("companyName");
          const needNews = !covered || !covered.has("headlines") || !covered.has("sentiment");
          const merged: SymbolEnrichment = {};

          if (needStats) {
            const admitted = tryReserveRapidApiCalls("seeking-alpha-rapidapi", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/symbols/get-key-stats?symbol=${encodeURIComponent(symbol)}`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                Object.assign(merged, parseSeekingAlphaKeyStats(payload));
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("seeking-alpha-rapidapi", 1, now);
              }
            }
          }

          if (needNews) {
            const admitted = tryReserveRapidApiCalls("seeking-alpha-rapidapi", 1, now) > 0;
            if (admitted) {
              const tracker = { dispatched: false };
              try {
                const payload = await rapidApiGetJson(
                  this.host,
                  `/articles/list?symbol=${encodeURIComponent(symbol)}&size=5`,
                  this.apiKey,
                  { service: this.name, keySource: this.keySource, userId: this.userId },
                  tracker
                );
                Object.assign(merged, parseSeekingAlphaArticles(payload));
              } catch {
                if (!tracker.dispatched) refundRapidApiCalls("seeking-alpha-rapidapi", 1, now);
              }
            }
          }

          if (Object.keys(merged).length > 0) {
            writeEnrichmentCache(this.name, symbol, this.scope, this.userId, merged, now + ttlMs());
          }
          result[symbol] = merged;
        })
      );
    }
    return result;
  }
}
