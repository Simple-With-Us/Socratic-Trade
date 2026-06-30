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

import { normalizeSymbol } from "./money";
import {
  congressReadsEnabled,
  congressFundamentalsEnabled,
  getAppAFundamentals,
  getAppAAnalyst,
  type AppAFundamental,
  type AppAAnalyst,
} from "./congress-trade-client";
import { resolveAlpacaMarketData, resolveApiKeyWithSource, hasDataPoolConsent, type ApiKeySource } from "./db";
import { logApiHealth } from "./db-health";
import { getStreamedHeadlines } from "./streams/news-store";
import { politeFetchText, runRateLimited, secUserAgent } from "./web-sources/http";
import { loadTickerCikMap } from "./web-sources/sec8k";
import { padCik } from "./web-sources/sec-filings";

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
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number;
  // Numeric analyst price targets (FMP price-target-consensus; opt-in FMP_PRICE_TARGETS_ENABLED).
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  // Which provider supplied each scalar field (filled by the cascade).
  sources?: Partial<Record<EnrichmentSourcedField, string>>;
  // Each provider's own analyst read, keyed by provider name (for the Rating tooltip).
  analystBySource?: Record<string, AnalystRatingDetail>;
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
  | "targetMean"
  | "targetHigh"
  | "targetLow"
  | "targetMedian";

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
// Cover the default scan candidate set so every row the dashboard displays is
// enriched — otherwise symbols that climb in rank after enrichment would render
// blank. The 6h cache means only the first run is heavy.
const DEFAULT_MAX_SYMBOLS = 30;
const MAX_SYMBOLS_CAP = 50;
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

function maxSymbols(): number {
  const value = Number(process.env.FMP_MAX_SYMBOLS ?? process.env.MARKET_SCAN_LIMIT ?? DEFAULT_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.min(value, MAX_SYMBOLS_CAP);
}

// One retry on HTTP 429 (rate limit) with a short backoff before giving up.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    retries?: number;
    backoffMs?: number;
    service?: string;
    keySource?: string;
    userId?: string;
    deferSuccessLog?: boolean;
    suppressHealthStatuses?: number[];
  } = {}
): Promise<Response> {
  const retries = options.retries ?? 1;
  const backoffMs = options.backoffMs ?? 600;
  const start = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init);
      if (response.status === 429 && attempt < retries) {
        if (options.service) {
          logApiHealth({
            service: options.service,
            ok: false,
            latencyMs: Date.now() - start,
            errorText: "HTTP 429 (rate limited, retrying)",
            keySource: options.keySource,
            userId: options.userId,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
        continue;
      }
      // When deferSuccessLog is set, skip the auto-success row so the caller can log
      // after validating the response body (e.g. providers that embed errors in HTTP 200).
      // HTTP failure rows are still written here regardless of the flag.
      const suppressHealth = !response.ok && (options.suppressHealthStatuses ?? []).includes(response.status);
      if (options.service && !(response.ok && options.deferSuccessLog) && !suppressHealth) {
        logApiHealth({
          service: options.service,
          ok: response.ok,
          latencyMs: Date.now() - start,
          errorText: response.ok ? undefined : `HTTP ${response.status}`,
          keySource: options.keySource,
          userId: options.userId,
        });
      }
      return response;
    }
  } catch (err) {
    if (options.service) {
      logApiHealth({
        service: options.service,
        ok: false,
        latencyMs: Date.now() - start,
        errorText: err instanceof Error ? err.message : String(err),
        keySource: options.keySource,
        userId: options.userId,
      });
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
        const [funds, analysts] = await Promise.all([
          getAppAFundamentals(symbol, { from: fromDate }).catch(() => { transportError = true; return [] as AppAFundamental[]; }),
          getAppAAnalyst(symbol, { from: fromDate }).catch(() => { transportError = true; return [] as AppAAnalyst[]; }),
        ]);
        // App A may return multiple fresh rows from different sources; merge the LATEST
        // non-null value per field across all of them (rows are date-ascending), so a
        // partial latest row doesn't discard a field an earlier fresh row supplied.
        const freshFunds = funds.filter((r) => rowIsFresh(r, now));
        const freshAnalysts = analysts.filter((r) => rowIsFresh(r, now));
        const latestFund = <K extends keyof AppAFundamental>(
          key: K,
          valid: (v: NonNullable<AppAFundamental[K]>) => boolean = () => true
        ): NonNullable<AppAFundamental[K]> | undefined => {
          for (let i = freshFunds.length - 1; i >= 0; i--) {
            const v = freshFunds[i][key];
            if (v != null && valid(v as NonNullable<AppAFundamental[K]>)) return v as NonNullable<AppAFundamental[K]>;
          }
          return undefined;
        };
        const latestAnalyst = <K extends keyof AppAAnalyst>(
          key: K,
          valid: (v: NonNullable<AppAAnalyst[K]>) => boolean = () => true
        ): NonNullable<AppAAnalyst[K]> | undefined => {
          for (let i = freshAnalysts.length - 1; i >= 0; i--) {
            const v = freshAnalysts[i][key];
            if (v != null && valid(v as NonNullable<AppAAnalyst[K]>)) return v as NonNullable<AppAAnalyst[K]>;
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
            const a = freshAnalysts[i];
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

export function getEnrichmentProvider(userId?: string): MarketEnrichmentProvider {
  const providers: MarketEnrichmentProvider[] = [];
  const finnhub = resolveApiKeyWithSource("finnhub", userId);
  const alphaVantage = resolveApiKeyWithSource("alphavantage", userId);
  const fmp = resolveApiKeyWithSource("fmp", userId);
  const fintech = resolveApiKeyWithSource("fintechstudios", userId);
  const intrinio = resolveApiKeyWithSource("intrinio", userId);
  const tiingo = resolveApiKeyWithSource("tiingo", userId);
  const twelvedata = resolveApiKeyWithSource("twelvedata", userId);
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
  if (alpacaData.apiKey && alpacaData.secretKey) providers.push(new AlpacaSnapshotEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey, alpacaData.source, userId));
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
  if (intrinio.key) providers.push(new IntrinioEnrichmentProvider(intrinio.key, intrinio.source, userId));
  if (tiingo.key) providers.push(new TiingoEnrichmentProvider(tiingo.key, tiingo.source, userId));
  if (fintech.key) providers.push(new FintechStudiosEnrichmentProvider(fintech.key, fintech.source, userId));
  if (finnhub.key) providers.push(new FinnhubEnrichmentProvider(finnhub.key, finnhub.source, userId));
  if (twelvedata.key) providers.push(new TwelveDataEnrichmentProvider(twelvedata.key, twelvedata.source, userId));
  // Alpaca's free Benzinga news (one batched call covers all scan symbols) — placed ahead of
  // Alpha Vantage so it supplies headlines/sentiment, demoting AV's redundant NEWS_SENTIMENT.
  if (alpacaData.apiKey) providers.push(new AlpacaNewsEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey || undefined, alpacaData.source, userId));
  if (alphaVantage.key) providers.push(new AlphaVantageEnrichmentProvider(alphaVantage.key, alphaVantage.source, userId));
  if (fmp.key) providers.push(new FmpEnrichmentProvider(fmp.key, fmp.source, userId));
  // SEC EDGAR XBRL: keyless, default-OFF. Fills debtToEquity from authoritative SEC filings.
  // Positioned after FMP (paid key wins) but before Yahoo (keyless fallback) so SEC authoritative
  // data supersedes Yahoo's scraped values when enabled.
  if (secXbrlEnrichmentEnabled()) providers.push(new SecXbrlEnrichmentProvider());
  providers.push(new YahooFinanceEnrichmentProvider());
  // Always wrap in the cascade — even for a single provider — so per-field source
  // stamping and analyst blending happen uniformly.
  return new CascadingEnrichmentProvider(providers);
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

  constructor(private readonly providers: MarketEnrichmentProvider[]) {
    this.name = providers.map((p) => p.name).join("+");
  }

  /** Registered providers that contributed ≥1 field in the last enrich(), in registration order. */
  get activeSources(): string[] {
    return this.providers.map((p) => p.name).filter((n) => this.contributingNames.has(n));
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    this.contributingNames = new Set();
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean);
    // Each provider's result set, paired with its name, kept in REGISTRATION order
    // so the first-wins merge below is unchanged regardless of how we fetched.
    const run = (p: MarketEnrichmentProvider, syms: string[], context?: EnrichmentContext) =>
      p
        .enrich(syms, context)
        .then((data) => ({ name: p.name, data }))
        .catch(() => ({ name: p.name, data: {} as Record<string, SymbolEnrichment> }));

    let results: Array<{ name: string; data: Record<string, SymbolEnrichment> }>;
    if (enrichmentShortCircuitEnabled()) {
      // Short-circuit: ONLY the Congress.Trade tier feeds the coverage hint, so await
      // just it first, then run EVERY other provider (free AND paid) in parallel. Paid
      // providers use the per-symbol hint to skip only the redundant SUB-calls (e.g.
      // FMP's ratios-ttm + grades-consensus when App A already has P/E + analyst) while
      // STILL fetching the fields they uniquely supply — insider/senate, news/sentiment,
      // quotes. No whole provider is skipped, so no field is lost; only duplicate upstream
      // calls are eliminated. Crucially, paid providers are NOT serialized behind
      // unrelated free tiers (Yahoo/Alpaca/SEC) — only behind the single App A read.
      const congressProvider = this.providers.find((p) => p.name === "congress.trade");
      const appAResult = congressProvider
        ? await run(congressProvider, normalized)
        : { name: "congress.trade", data: {} as Record<string, SymbolEnrichment> };
      const appA = appAResult.data;
      const coveredFields: Record<string, ReadonlySet<string>> = {};
      const analystSource: Record<string, string> = {};
      for (const s of normalized) {
        const e = appA[s];
        if (e) {
          coveredFields[s] = new Set(Object.keys(e));
          // App A keys its analyst entry under the upstream provider it came from, so the
          // single key here IS that source. A paid provider uses it to skip its own
          // consensus sub-call only when App A's analyst is genuinely its data.
          const srcKey = e.analystBySource ? Object.keys(e.analystBySource)[0] : undefined;
          if (srcKey) analystSource[s] = srcKey;
        }
      }
      const context: EnrichmentContext = { coveredFields, analystSource };
      const otherProviders = this.providers.filter((p) => p.name !== "congress.trade");
      const otherResults = await Promise.all(
        otherProviders.map((p) => run(p, normalized, p.costTier === "paid" ? context : undefined))
      );
      // Reassemble in registration order so the merge precedence is identical.
      const byName = new Map<string, Record<string, SymbolEnrichment>>();
      for (const r of [appAResult, ...otherResults]) byName.set(r.name, r.data);
      results = this.providers.map((p) => ({ name: p.name, data: byName.get(p.name) ?? {} }));
    } else {
      // Default: run every provider over every symbol in parallel.
      results = await Promise.all(this.providers.map((p) => run(p, normalized)));
    }
    const merged: Record<string, SymbolEnrichment> = {};

    for (const symbol of normalized) {
      const base: SymbolEnrichment = {};
      const sources: Partial<Record<EnrichmentSourcedField, string>> = {};
      const analystBySource: Record<string, AnalystRatingDetail> = {};
      // Which provider supplied the SURVIVING entry for each analyst source-key (last
      // writer wins, mirroring Object.assign). Used to credit contributors only after
      // de-dupe — a provider whose entry is overwritten by a same-source provider
      // supplied no final value and must not appear in MarketScan.source.
      const analystKeyOwner: Record<string, string> = {};

      const takeScalar = <K extends keyof SymbolEnrichment>(
        field: K,
        sourceName: string,
        value: SymbolEnrichment[K] | undefined
      ) => {
        if (base[field] === undefined && value !== undefined) {
          base[field] = value;
          this.contributingNames.add(sourceName);
          if (field in EMPTY_SOURCED) sources[field as EnrichmentSourcedField] = sourceName;
        }
      };

      for (const { name, data } of results) {
        const r = data[symbol];
        if (!r) continue;
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
        takeScalar("beta", name, r.beta);
        takeScalar("fiftyTwoWeekHigh", name, r.fiftyTwoWeekHigh);
        takeScalar("fiftyTwoWeekLow", name, r.fiftyTwoWeekLow);
        takeScalar("insiderSentiment", name, r.insiderSentiment);
        takeScalar("fcfYield", name, r.fcfYield);
        takeScalar("debtToEquity", name, r.debtToEquity);
        takeScalar("epsGrowth", name, r.epsGrowth);
        takeScalar("senateTrades", name, r.senateTrades);
        takeScalar("targetMean", name, r.targetMean);
        takeScalar("targetHigh", name, r.targetHigh);
        takeScalar("targetLow", name, r.targetLow);
        takeScalar("targetMedian", name, r.targetMedian);
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
          }
        }
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
        this.contributingNames.add("alpha-vantage");
      }

      base.sources = sources;
      merged[symbol] = base;
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
  targetMean: true,
  targetHigh: true,
  targetLow: true,
  targetMedian: true
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

export function secXbrlEnrichmentEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.SEC_XBRL_ENRICHMENT_ENABLED ?? "").trim().toLowerCase());
}

function webullUnofficialMaxSymbols(): number {
  const value = Number(process.env.WEBULL_UNOFFICIAL_MAX_SYMBOLS ?? DEFAULT_WEBULL_UNOFFICIAL_MAX);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WEBULL_UNOFFICIAL_MAX;
  return Math.min(value, MAX_SYMBOLS_CAP);
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
  const sector = firstString(row, ["sector"]);
  const industry = firstString(row, ["industry"]);
  return {
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow }),
    ...(volume !== undefined && volume > 0 && { volume }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry })
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
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
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
    if (misses.length === 0) return result;

    try {
      // Single batched request: Alpaca tags every article with the symbols it mentions.
      const url = `${this.base}?symbols=${encodeURIComponent(misses.join(","))}&limit=50&sort=desc`;
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
          const symbol = normalizeSymbol(raw);
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
    return result;
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
        const url = `${this.base}?symbols=${encodeURIComponent(chunk.join(","))}&feed=${alpacaDataFeed()}`;
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
          const snap = snapshots[symbol];
          const data = parseAlpacaSnapshot(snap);
          const hasData = Object.keys(data).length > 0;
          if (hasData) {
            writeEnrichmentCache("alpaca-snapshot", symbol, this.scope, this.userId, data, now + ttlMs());
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
  latestTrade?: { p?: number };
  latestQuote?: { bp?: number; ap?: number };
  dailyBar?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number };
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

  return {
    ...(price !== undefined && { price }),
    ...(bid !== undefined && { bid }),
    ...(ask !== undefined && { ask }),
    ...(volume !== undefined && { volume }),
    ...(vwap !== undefined && { vwap }),
    ...(intradayChangePct !== undefined && { intradayChangePct })
  };
}

// ── Yahoo Finance provider (no API key required) ─────────────────────────────
// Uses Yahoo Finance session-crumb auth to call v10/finance/quoteSummary.
// Provides: sector, industry, P/E, EPS, dividend yield, and analyst rating.

interface YfCreds { cookie: string; crumb: string; expiresAt: number; }
let yfCreds: YfCreds | null = null;
const YF_CRUMB_TTL_MS = 55 * 60_000; // 55 min (crumbs expire ~1 hr)
const YF_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

class YahooFinanceEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "yahoo-finance";
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
      logApiHealth({ service: this.name, ok: false, errorText: err instanceof Error ? err.message : String(err) });
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
    const modules = "summaryDetail,defaultKeyStatistics,financialData,assetProfile";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(creds.crumb)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchWithRetry(url, {
        headers: { "user-agent": YF_UA, "Cookie": creds.cookie, "accept": "application/json" },
        cache: "no-store",
        signal: controller.signal
      }, { service: this.name });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
      const r = json?.quoteSummary?.result?.[0] as Record<string, unknown> | undefined;
      if (!r) return {};

      const sd = (r.summaryDetail ?? {}) as Record<string, { raw?: number }>;
      const ks = (r.defaultKeyStatistics ?? {}) as Record<string, { raw?: number }>;
      const fd = (r.financialData ?? {}) as Record<string, { raw?: number } | string>;
      const ap = (r.assetProfile ?? {}) as Record<string, unknown>;

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
        ...(analystBySource !== undefined && { analystBySource })
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Finnhub provider ─────────────────────────────────────────────────────────

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate limit|too many requests/i.test(message)) return true;
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
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("finnhub", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const toDate = new Date(now).toISOString().split("T")[0];
    const fromDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            // Run all Finnhub calls in parallel per symbol.
            const [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${this.apiKey}`),
              this.getJson(`${this.base}/quote?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/recommendation?symbol=${symbol}&token=${this.apiKey}`),
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
              writeEnrichmentCache("finnhub", symbol, this.scope, this.userId, data, now + ttlMs());
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── FMP stable API provider ───────────────────────────────────────────────────
// Supplies P/E (ratios-ttm) and analyst consensus (grades-consensus).
// Sector/industry/headlines are not available on the free plan.

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

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          // Coverage hint (short-circuit only): when a free upstream (App A) already
          // supplied P/E, analyst consensus, or price targets for this symbol, skip the
          // matching FMP SUB-call — but always keep fetching insider/senate, which App A
          // never supplies, so nothing FMP uniquely provides is lost. (Same flags are
          // applied to cache hits above.)
          const { skipPe, skipConsensus, skipTargets } = skipFlagsFor(symbol);
          // Price-target-consensus is OPT-IN (FMP_PRICE_TARGETS_ENABLED): an extra FMP call per symbol,
          // and not on every key tier. When off, targets stay undefined and ride null downstream.
          const wantTargets = fmpPriceTargetsEnabled() && !skipTargets;
          const [peRaw, consensusRaw, insiderRaw, senateRaw, targetRaw] = await Promise.allSettled([
            skipPe
              ? Promise.resolve(undefined)
              : this.getJson(`${this.base}/ratios-ttm?symbol=${symbol}&apikey=${this.apiKey}`),
            skipConsensus
              ? Promise.resolve(undefined)
              : this.getJson(`${this.base}/grades-consensus?symbol=${symbol}&apikey=${this.apiKey}`),
            this.getJson(`https://financialmodelingprep.com/api/v4/insider-trading?symbol=${symbol}&apikey=${this.apiKey}`, false),
            this.getJson(`https://financialmodelingprep.com/api/v4/senate-trading?symbol=${symbol}&apikey=${this.apiKey}`, false),
            wantTargets
              ? this.getJson(`${this.base}/price-target-consensus?symbol=${symbol}&apikey=${this.apiKey}`, false)
              : Promise.resolve(undefined)
          ]);

          let peRatio: number | undefined;
          if (peRaw.status === "fulfilled" && Array.isArray(peRaw.value)) {
            const pe = Number((peRaw.value as Array<Record<string, unknown>>)[0]?.priceToEarningsRatioTTM);
            if (Number.isFinite(pe) && pe > 0) peRatio = pe;
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
              const acqDisp = String(trade.acquistionOrDisposition || "").toLowerCase();
              if (type.includes("buy") || type.includes("purchase") || acqDisp === "a") buys++;
              else if (type.includes("sell") || type.includes("sale") || acqDisp === "d") sells++;
            }
            const total = buys + sells;
            if (total > 0) {
              insiderSentiment = Math.round((buys / total) * 100);
            }
          }

          let senateTrades: number | undefined;
          if (senateRaw.status === "fulfilled" && Array.isArray(senateRaw.value)) {
            const trades = senateRaw.value as Array<Record<string, unknown>>;
            let net = 0;
            for (const trade of trades.slice(0, 100)) {
              const type = String(trade.type || "").toLowerCase();
              if (type.includes("purchase")) net++;
              else if (type.includes("sale")) net--;
            }
            if (trades.length > 0) senateTrades = net;
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

          const data: SymbolEnrichment = {
            ...(peRatio !== undefined && { peRatio }),
            ...(analystBySource !== undefined && { analystBySource }),
            ...(insiderSentiment !== undefined && { insiderSentiment }),
            ...(senateTrades !== undefined && { senateTrades }),
            ...(targetMean !== undefined && { targetMean }),
            ...(targetHigh !== undefined && { targetHigh }),
            ...(targetLow !== undefined && { targetLow }),
            ...(targetMedian !== undefined && { targetMedian })
          };

          const promises = [peRaw, consensusRaw, insiderRaw, senateRaw];
          const allRejected = promises.every((p) => p.status === "rejected");
          const hasTransientError = promises.some(
            (p) => p.status === "rejected" && isTransientError(p.reason)
          );
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
            writeEnrichmentCache("fmp", symbol, this.scope, this.userId, data, now + ttlMs());
          }
          result[symbol] = data;
        })
      );
    }
    return result;
  }

  private async getJson(url: string, logHealth = true): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(
        url,
        { cache: "no-store", signal: controller.signal },
        {
          service: this.name,
          keySource: this.keySource,
          userId: this.userId,
          suppressHealthStatuses: logHealth ? undefined : [403]
        }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
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
      const cached = readEnrichmentCache("alphavantage", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const url = `${this.base}?function=NEWS_SENTIMENT&tickers=${symbol}&apikey=${this.apiKey}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            let payload: Record<string, unknown>;
            try {
              // deferSuccessLog: true — don't mark 200 healthy until body validates;
              // Alpha Vantage embeds quota/error messages in HTTP 200 responses.
              const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId, deferSuccessLog: true });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              payload = await response.json() as Record<string, unknown>;

              if (payload && (payload.Note || payload.Information || payload["Error Message"])) {
                const msg = String(payload.Note || payload.Information || payload["Error Message"]);
                logApiHealth({ service: this.name, ok: false, errorText: `Alpha Vantage API warning/error: ${msg}`, keySource: this.keySource, userId: this.userId });
                throw new Error(`Alpha Vantage API warning/error: ${msg}`);
              }
              logApiHealth({ service: this.name, ok: true, keySource: this.keySource, userId: this.userId });
            } finally {
              clearTimeout(timeout);
            }

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
            result[symbol] = {};
          }
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

// ── Intrinio provider ─────────────────────────────────────────────────────────
// Real-time delayed quotes + company fundamentals from Intrinio v2 API.
// 14-day trial covers prices/realtime, companies, and data_point endpoints.

export class IntrinioEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "intrinio";
  readonly costTier = "paid" as const;
  readonly configured = true;
  private readonly base = "https://api-v2.intrinio.com";
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
      const cached = readEnrichmentCache("intrinio", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const k = this.apiKey;
            const [realtimeRaw, companyRaw, peRaw, epsRaw, divRaw, hiRaw, loRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/securities/${symbol}/prices/realtime?api_key=${k}`),
              this.getJson(`${this.base}/companies/${symbol}?api_key=${k}`),
              this.getJson(`${this.base}/securities/${symbol}/data_point/pe_ratio?api_key=${k}`),
              this.getJson(`${this.base}/securities/${symbol}/data_point/eps_basic?api_key=${k}`),
              this.getJson(`${this.base}/securities/${symbol}/data_point/dividend_yield?api_key=${k}`),
              this.getJson(`${this.base}/securities/${symbol}/data_point/52_week_high?api_key=${k}`),
              this.getJson(`${this.base}/securities/${symbol}/data_point/52_week_low?api_key=${k}`)
            ]);

            let price: number | undefined;
            let bid: number | undefined;
            let ask: number | undefined;
            let volume: number | undefined;
            let intradayChangePct: number | undefined;
            let asOf: string | undefined;

            if (realtimeRaw.status === "fulfilled" && realtimeRaw.value && typeof realtimeRaw.value === "object") {
              const rt = realtimeRaw.value as Record<string, unknown>;
              const last = firstNumber(rt, ["last_price", "close_price", "adj_close_price"]);
              if (last && last > 0) price = last;
              const b = firstNumber(rt, ["bid_price"]);
              if (b && b > 0) bid = b;
              const a = firstNumber(rt, ["ask_price"]);
              if (a && a > 0) ask = a;
              const v = firstNumber(rt, ["market_volume", "exchange_volume"]);
              if (v && v > 0) volume = v;
              const chg = firstNumber(rt, ["change_percent"]);
              if (typeof chg === "number") intradayChangePct = chg;
              if (typeof rt.last_time === "string") asOf = rt.last_time;
            }

            let companyName: string | undefined;
            let sector: string | undefined;
            let industry: string | undefined;

            if (companyRaw.status === "fulfilled" && companyRaw.value && typeof companyRaw.value === "object") {
              const co = companyRaw.value as Record<string, unknown>;
              companyName = firstString(co, ["name", "legal_name"]);
              // Intrinio nests sector/industry differently depending on plan
              sector = firstString(co, ["sector"]);
              if (!sector && co.industry_template && typeof co.industry_template === "object") {
                sector = firstString(co.industry_template as Record<string, unknown>, ["sector", "name"]);
              }
              industry = firstString(co, ["industry_category"]);
            }

            const peRatio = peRaw.status === "fulfilled" && typeof peRaw.value === "number" && peRaw.value > 0 ? peRaw.value : undefined;
            const eps = epsRaw.status === "fulfilled" && typeof epsRaw.value === "number" ? epsRaw.value : undefined;
            let dividendYield: number | undefined;
            if (divRaw.status === "fulfilled" && typeof divRaw.value === "number" && divRaw.value >= 0) {
              dividendYield = divRaw.value <= 1 ? normalizePercent(divRaw.value) : divRaw.value;
            }
            const fiftyTwoWeekHigh = hiRaw.status === "fulfilled" && typeof hiRaw.value === "number" && hiRaw.value > 0 ? hiRaw.value : undefined;
            const fiftyTwoWeekLow = loRaw.status === "fulfilled" && typeof loRaw.value === "number" && loRaw.value > 0 ? loRaw.value : undefined;

            const data: SymbolEnrichment = {
              ...(price !== undefined && { price }),
              ...(bid !== undefined && { bid }),
              ...(ask !== undefined && { ask }),
              ...(volume !== undefined && { volume }),
              ...(intradayChangePct !== undefined && { intradayChangePct }),
              ...(asOf !== undefined && { asOf }),
              ...(companyName !== undefined && { companyName }),
              ...(sector !== undefined && { sector }),
              ...(industry !== undefined && { industry }),
              ...(peRatio !== undefined && { peRatio }),
              ...(eps !== undefined && { eps }),
              ...(dividendYield !== undefined && { dividendYield }),
              ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
              ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow })
            };

            const allRejected = [realtimeRaw, companyRaw, peRaw, epsRaw, divRaw, hiRaw, loRaw].every((p) => p.status === "rejected");
            const hasTransientErr = [realtimeRaw, companyRaw, peRaw, epsRaw, divRaw, hiRaw, loRaw].some(
              (p) => p.status === "rejected" && isTransientError(p.reason)
            );

            if (!allRejected && !hasTransientErr && Object.keys(data).length > 0) {
              writeEnrichmentCache("intrinio", symbol, this.scope, this.userId, data, now + ttlMs());
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
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
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

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("tiingo", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const headers = { "Authorization": `Token ${this.apiKey}`, "Accept": "application/json" };

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const ticker = symbol.toLowerCase();
            const [iexRaw, metaRaw, newsRaw] = await Promise.allSettled([
              this.getJson(`https://api.tiingo.com/iex/${ticker}?token=${this.apiKey}`, headers),
              this.getJson(`https://api.tiingo.com/tiingo/daily/${ticker}?token=${this.apiKey}`, headers),
              this.getJson(`https://api.tiingo.com/tiingo/news?tickers=${ticker}&limit=5&token=${this.apiKey}`, headers)
            ]);

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

            const allRejected = [iexRaw, metaRaw, newsRaw].every((p) => p.status === "rejected");
            const hasTransientErr = [iexRaw, metaRaw, newsRaw].some(
              (p) => p.status === "rejected" && isTransientError(p.reason)
            );

            if (!allRejected && !hasTransientErr && Object.keys(data).length > 0) {
              writeEnrichmentCache("tiingo", symbol, this.scope, this.userId, data, now + ttlMs());
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

  private async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal, headers }, { service: this.name, keySource: this.keySource, userId: this.userId });
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

    // Batch all misses in one request (Twelve Data supports comma-separated symbols).
    // Chunk at 120 symbols (API limit) in case the scan is very large.
    const BATCH_SIZE = 120;
    for (let i = 0; i < misses.length; i += BATCH_SIZE) {
      const batch = misses.slice(i, i + BATCH_SIZE);
      try {
        const url = `https://api.twelvedata.com/quote?symbol=${batch.join(",")}&apikey=${this.apiKey}&country=US`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let raw: unknown;
        try {
          // deferSuccessLog: true — Twelve Data embeds errors in HTTP 200 responses
        // (e.g. {"status":"error","message":"Invalid API key"}); log only after body validates.
          const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal }, { service: this.name, keySource: this.keySource, userId: this.userId, deferSuccessLog: true });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          raw = await response.json();
        } finally {
          clearTimeout(timeout);
        }

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
        logApiHealth({ service: this.name, ok: true, keySource: this.keySource, userId: this.userId });
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

        for (const symbol of batch) {
          const q = quoteMap[symbol];
          if (!q) continue;
          // Skip error responses
          if (q.code || q.status === "error" || q.message) {
            result[symbol] = {};
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
          }
          result[symbol] = data;
        }
      } catch (err) {
        if (isTransientError(err)) {
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

// ── SEC EDGAR XBRL company-facts provider (keyless, default-OFF) ─────────────
// Fills debtToEquity from authoritative SEC 10-K filings via the public
// companyfacts API (https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json).
// Polite 300 ms inter-symbol delay per SEC fair-access guidance.
// Enable with: SEC_XBRL_ENRICHMENT_ENABLED=on

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
