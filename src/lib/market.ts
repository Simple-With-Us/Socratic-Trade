import { shareScanRefs } from "./congress-share";
import { congressLongScore, scoreCongressSignal } from "./congress-score";
import { getEnrichmentProvider, type SymbolEnrichment } from "./data-providers";
import type { GroupedDailyBar } from "./market-signals/massive";
import { getSymbolWebSignals, setTechnicalWatchlist } from "./web-sources";
import type { SymbolWebSignal } from "./web-sources";
import { clearFundHoldingsCache, fetchBlackRockHoldingSymbols, isBlackRockHoldingUniverse } from "./fund-holdings";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { enrichmentPlanForDeadline } from "./gather-budget";
import { INDEX_UNIVERSES, isIndexMemberSymbol } from "./index-universes";
import { expiresAtRespectingMarketClose } from "./market-hours";
import { normalizeSymbol } from "./money";
import { fetchHistoryCacheEodBulk, fetchHistoryCacheEodBulkAsync } from "./history-cache";
import { isBarSeriesFresh } from "./history";
import { barDerivedQuoteFields, type BarDerivedQuoteFields } from "./bar-quote-fields";
import {
  DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "./scan-settings";
import { fetchYahooFinanceChartQuotes, fetchYahooFinanceQuotesBatch, type YahooFinanceQuote } from "./yahoo-finance";
import type {
  BrokerQuote,
  EnrichmentFieldObservations,
  EnrichmentSources,
  EquityPosition,
  IndexUniverse,
  MarketDataProvider,
  MarketDataProviderOptions,
  MarketFactor,
  MarketFactorBreakdown,
  MarketQuote,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights,
  UniverseFloor
} from "./types";
import { stampFieldObservation } from "./evidence-facts";
import { paperPricePolicyForUser } from "./paper-delayed-price-account";
import {
  choosePaperPrice,
  paperDelayedPricePolicy,
  paperPolicyFromStamp,
  type PaperDelayedPricePolicy
} from "./paper-delayed-price-policy";
import {
  fetchNasdaqScreenerResponse,
  nasdaqScreenerUrl,
  NASDAQ_SCREENER_TIMEOUT_MESSAGE,
  NASDAQ_SCREENER_TIMEOUT_MS,
  readNasdaqScreenerJson
} from "./nasdaq-screener-fetch";
import { fetchFallbackUniverseRows } from "./nasdaq-universe-fallback";
import { parseNasdaqScreenerPayload, type NasdaqScreenerRow } from "./nasdaq-screener-schema";
import { recoverUniverseQuotesFromBroker } from "./scan-broker-universe-recovery";
import {
  LIVE_QUOTE_RECOVERY_BUDGET_MS,
  registerScanRecovery,
  resolveSeedPricesAsOf,
  type LiveQuoteRecoveryResult
} from "./scan-seed-preview";

export { NASDAQ_SCREENER_TIMEOUT_MESSAGE, NASDAQ_SCREENER_TIMEOUT_MS };

/**
 * A web signal worth pulling a below-cutoff name into the candidate set for.
 * `congressMultiplier` (item 2): scales the congressional terms; 1 = no change (default), 0 = the
 * go/no-go gate zeroed a statistically-unvalidated congress signal. Non-congress signals are unaffected.
 */
export function hasNotableWebSignal(sig?: SymbolWebSignal, congressMultiplier = 1): boolean {
  return outlierInterestScore(sig, congressMultiplier) > 0;
}

export function outlierInterestScore(sig?: SymbolWebSignal, congressMultiplier = 1): number {
  if (!sig) return 0;
  // Congress: require at least 2 distinct members buying AND net >= 2 (more buys than sells).
  // Single-member disclosures are too thin to justify overriding the scan score cutoff.
  const congressNotable =
    (sig.congress?.buyCount ?? 0) >= 2 &&
    (sig.congress?.netSignal ?? 0) >= 2;
  const congressScore = congressNotable
    ? (70 + Math.min(25, (sig.congress?.netSignal ?? 0) * 5 + (sig.congress?.buyCount ?? 0) * 2)) * congressMultiplier
    : 0;
  // App A analytics boost (the "Trends" composite): a strong dollar-weighted net buy flow, a cluster
  // buy (many members → same ticker), or multiple distinct members + high-track-record members can
  // surface a name even when the scraped per-member netSignal is thin. Only present when
  // CONGRESS_ANALYTICS_ENABLED is on; absent → 0 → no behavior change (back-compatible).
  const analyticsScore = notableCongressAnalyticsScore(sig) * congressMultiplier;
  const insiderScore = typeof sig.insiderSentiment === "number" && sig.insiderSentiment >= 60
    ? sig.insiderSentiment
    : 0;
  const shortScore = typeof sig.shortVolumeRatio === "number" && sig.shortVolumeRatio >= 55
    ? Math.min(90, sig.shortVolumeRatio)
    : 0;
  const technicalScore = sig.technical?.direction === "bullish" && (sig.technical?.score ?? 0) >= 70
    ? sig.technical.score
    : 0;
  return Math.max(congressScore, analyticsScore, insiderScore, shortScore, technicalScore);
}

/** 0–100 outlier weight from App A's aggregate congressional analytics; 0 unless there is net buying. */
export function congressAnalyticsScore(a?: SymbolWebSignal["congressAnalytics"]): number {
  return congressLongScore({ congressAnalytics: a });
}

function notableCongressAnalyticsScore(sig?: SymbolWebSignal): number {
  const analytics = sig?.congressAnalytics;
  if (!analytics) return 0;
  const composite = scoreCongressSignal({ congress: sig?.congress, congressAnalytics: analytics });
  if (composite.direction !== "BUY" || composite.score < 60 || composite.confidence < 0.6) return 0;
  const hasSupport =
    analytics.cluster === true ||
    (analytics.memberCount ?? analytics.clusterMemberCount ?? 0) >= 2 ||
    (analytics.tradeCount ?? 0) >= 3 ||
    (analytics.netFlowUsd ?? 0) >= 100_000 ||
    ((analytics.topMemberScoreSource === "realized_skill_filing" ||
      analytics.topMemberScoreSource === "realized_skill_trade" ||
      analytics.topMemberScoreSource === "realized_skill") &&
      (analytics.topMemberScore ?? 0) >= 60);
  return hasSupport ? composite.score : 0;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
// Verified abort cause (prod d0359642, every scan since 2026-08-13T22:30Z):
// fetchNasdaqScreener armed `setTimeout(() => controller.abort(), 8000)` with NO
// reason and left it armed through `response.json()` of the 8000-row table.
// abort() with no reason throws "This operation was aborted" — that is NOT the
// 20s withScanDeadline (that message is "Interactive market scan deadline exceeded.").
// nasdaq-quote / nasdaq-calendar already use BROWSER_UA because stub / bot UAs
// hang on api.nasdaq.com (live-verified 2026-08-05). The screener still sent
// "Mozilla/5.0". Coolify fetch+parse of ~7k rows can also land near 8s, so the
// timer aborted the body read. Last good: 2026-08-13T16:15:45Z, 513 quotes.
const DEFAULT_ENRICHMENT_POOL_MULTIPLIER = 5;
const DEFAULT_ENRICHMENT_POOL_CAP = 500;
const MAX_ENRICHMENT_POOL_MULTIPLIER = 10;
const MAX_ENRICHMENT_POOL_CAP = 1_000;

type NasdaqExchange = "nasdaq" | "nyse";

// Nasdaq screener is a public, unauthenticated endpoint — no user API key is
// consumed, so this single shared cache is safe to serve to all users.
// Rows are the parsed schema, not the raw JSON, so a drifted envelope is not cached.
let screenerCache = new Map<string, { expiresAt: number; rows: NasdaqScreenerRow[]; asOf?: string }>();
/** Last successful screener parse — served stale while a refresh runs or when live fetch fails. */
let screenerLastGood = new Map<string, { rows: NasdaqScreenerRow[]; asOf?: string }>();
const screenerRefreshInFlight = new Map<string, Promise<void>>();

/**
 * True if a quote clears the universe floor. Each bound applies only when set (`> 0`); market-cap and
 * dollar-volume are checked only when that datum is known (missing data never excludes — the price floor
 * is the reliable penny gate). Pure; exported for testing and reuse by the share/backfill universe.
 */
export function passesUniverseFloor(
  quote: Pick<MarketQuote, "price" | "volume" | "marketCap">,
  floor?: UniverseFloor
): boolean {
  if (!floor) return true;
  const { minPrice, minMarketCapUsd, minDollarVolume } = floor;
  if (minPrice != null && minPrice > 0 && !(quote.price >= minPrice)) return false;
  if (
    minMarketCapUsd != null &&
    minMarketCapUsd > 0 &&
    typeof quote.marketCap === "number" &&
    quote.marketCap > 0 &&
    quote.marketCap < minMarketCapUsd
  ) {
    return false;
  }
  if (minDollarVolume != null && minDollarVolume > 0 && quote.volume > 0) {
    const dollarVolume = (quote.price > 0 ? quote.price : 0) * quote.volume;
    if (dollarVolume < minDollarVolume) return false;
  }
  return true;
}

/** True if the floor has at least one active (`> 0`) bound. */
export function universeFloorActive(floor?: UniverseFloor): boolean {
  return (
    !!floor &&
    ((floor.minPrice ?? 0) > 0 || (floor.minMarketCapUsd ?? 0) > 0 || (floor.minDollarVolume ?? 0) > 0)
  );
}

/**
 * Drop sub-floor names from the scanned candidate set, EXEMPTING `exempt` (explicitly-listed symbols +
 * held positions) — those are deliberate and an exit must never be trapped. No-op when the floor is empty.
 */
export function applyUniverseFloor(
  quotes: MarketQuote[],
  exempt: Set<string>,
  floor?: UniverseFloor
): MarketQuote[] {
  if (!universeFloorActive(floor)) return quotes;
  return quotes.filter((q) => exempt.has(q.symbol) || passesUniverseFloor(q, floor));
}

/**
 * Right-tail cutoff (mean + nσ) for a list of values, used to flag statistically extreme names
 * (an unusually large daily move or trading volume relative to the whole scanned universe). Returns
 * undefined when there are too few samples to be meaningful, so the caller skips the outlier path.
 */
function tailThreshold(values: number[], sigma: number): number | undefined {
  if (values.length < 20) return undefined;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (!(std > 0)) return undefined;
  return mean + sigma * std;
}

/**
 * Bounded first-stage candidate set for enrichment. Holdings and event/statistical outliers lead
 * the list because providers with their own budgets consume first-wins; the remaining capacity is
 * filled in initial rank order. The cap never falls below the final candidate limit, preserving the
 * prior guarantee that every normal top-N candidate can be enriched.
 */
export function buildEnrichmentPreselectionPool(
  ranked: MarketQuote[],
  eventExtra: MarketQuote[],
  heldSymbols: Set<string>,
  candidateLimit: number,
  poolCapOverride?: number
): MarketQuote[] {
  const multiplier = clampInteger(
    envNumber("MARKET_SCAN_ENRICHMENT_POOL_MULTIPLIER", DEFAULT_ENRICHMENT_POOL_MULTIPLIER),
    1,
    MAX_ENRICHMENT_POOL_MULTIPLIER
  );
  const configuredCap = clampInteger(
    envNumber("MARKET_SCAN_ENRICHMENT_POOL_CAP", DEFAULT_ENRICHMENT_POOL_CAP),
    candidateLimit,
    MAX_ENRICHMENT_POOL_CAP
  );
  const effectiveCap =
    typeof poolCapOverride === "number" && Number.isFinite(poolCapOverride)
      ? Math.max(candidateLimit, Math.min(configuredCap, Math.round(poolCapOverride)))
      : configuredCap;
  const targetSize = Math.min(ranked.length, Math.min(candidateLimit * multiplier, effectiveCap));
  const seen = new Set<string>();
  const add = (quote: MarketQuote, pool: MarketQuote[]) => {
    if (pool.length >= targetSize || seen.has(quote.symbol)) return;
    seen.add(quote.symbol);
    pool.push(quote);
  };
  const pool: MarketQuote[] = [];

  for (const quote of ranked) if (heldSymbols.has(quote.symbol)) add(quote, pool);
  for (const quote of eventExtra) add(quote, pool);
  for (const quote of ranked) add(quote, pool);
  return pool;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function compareMarketQuotes(a: MarketQuote, b: MarketQuote): number {
  return b.score - a.score || a.symbol.localeCompare(b.symbol);
}

/**
 * ST-4679 OD-1: how much of the ranked tape beyond the enrichment pool gets bar-derived fields
 * attached/rescored. Covers the candidate cut several times over while bounding the windowed cache
 * read to a few hundred small queries instead of the whole tape.
 */
const BAR_DERIVED_RANKED_COVERAGE = 250;

function uniqueQuotesBySymbol(quotes: MarketQuote[]): MarketQuote[] {
  const seen = new Set<string>();
  return quotes.filter((quote) => {
    if (seen.has(quote.symbol)) return false;
    seen.add(quote.symbol);
    return true;
  });
}

export const SCAN_QUOTES_UNAVAILABLE_CODE = "scan_quotes_unavailable";

const STALE_SCAN_SNAPSHOT_WARNING =
  "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback.";

/** Thrown when the live screener and quote fallback both return nothing for a
 *  non-empty universe and no usable audit seed remains. Callers must not turn
 *  this into a 200 empty candidate table — that looks like "no names today." */
export class ScanQuotesUnavailableError extends Error {
  readonly code = SCAN_QUOTES_UNAVAILABLE_CODE;
  readonly scannedSymbols: number;
  readonly returnedQuotes = 0;
  readonly warnings: string[];

  constructor(input: { scannedSymbols: number; warnings: string[] }) {
    super(
      "Quotes were unavailable for this universe.  Refresh after the quote feed recovers."
    );
    this.name = "ScanQuotesUnavailableError";
    this.scannedSymbols = input.scannedSymbols;
    this.warnings = input.warnings;
  }
}

export function isScanQuotesUnavailableError(error: unknown): error is ScanQuotesUnavailableError {
  return error instanceof ScanQuotesUnavailableError;
}

export async function scanMarket(
  symbols: string[],
  positions: EquityPosition[],
  scoringWeights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  userId?: string,
  dynamicUniverses: IndexUniverse[] = [],
  scanOptions: {
    candidateLimit?: number;
    outlierReserve?: number;
    universeFloor?: UniverseFloor;
    congressMultiplier?: number;
    enrichmentMode?: "full" | "skip";
    signal?: AbortSignal;
    /** Slow-changing fields from the last completed strategy scan. Interactive
     * refreshes can reuse these locally while replacing price-family fields. */
    seedEnrichment?: Record<string, MarketQuoteSummary>;
    deadlineAt?: number;
    /** Connected account the scan operates for (account-scoped market-data tape). */
    connectedAccountId?: string;
    /** False disables the whole-set Yahoo fallback (freshness lane fail-fast). Default true. */
    allowWholeSetYahooFallback?: boolean;
    /** Interactive only: show a usable seed before Yahoo/broker recovery finishes. */
    previewSeedBeforeLiveRecovery?: boolean;
    /** Audit timestamp for the seed, used when seed rows have no asOf. */
    seedAsOf?: string;
  } = {}
): Promise<MarketScan> {
  const scan = await nasdaqDelayedProvider.scan(symbols, positions, {
    scoringWeights,
    ttlMs: marketCacheTtlMs(),
    signal: scanOptions.signal,
    userId,
    dynamicUniverses,
    candidateLimit: scanOptions.candidateLimit,
    outlierReserve: scanOptions.outlierReserve,
    universeFloor: scanOptions.universeFloor,
    congressMultiplier: scanOptions.congressMultiplier,
    enrichmentMode: scanOptions.enrichmentMode,
    seedEnrichment: scanOptions.seedEnrichment,
    deadlineAt: scanOptions.deadlineAt,
    connectedAccountId: scanOptions.connectedAccountId,
    allowWholeSetYahooFallback: scanOptions.allowWholeSetYahooFallback,
    previewSeedBeforeLiveRecovery: scanOptions.previewSeedBeforeLiveRecovery,
    seedAsOf: scanOptions.seedAsOf
  });
  // Forward the candidate company refs to congress.trade (App A) so it can avoid spending the shared
  // FMP quota. No-op unless CONGRESS_TRADE_TOKEN + CONGRESS_SHARE_ENABLED are set; per-symbol
  // throttled and fully self-guarded, so it never delays or breaks a scan. Fire-and-forget.
  // PRIVACY: holdings are personal account data and are force-included in `topCandidates` so the agent
  // can exit them — but they must NEVER leave the box. Share only the publicly-ranked candidates.
  const heldSymbols = new Set(positions.map((p) => normalizeSymbol(p.symbol)).filter(Boolean));
  void shareScanRefs({ topCandidates: scan.topCandidates.filter((quote) => !heldSymbols.has(quote.symbol)) });
  return scan;
}

export const nasdaqDelayedProvider: MarketDataProvider = {
  name: "nasdaq-delayed-screener",
  async scan(symbols, positions, options) {
    const allowed = new Set([
      ...symbols.map(normalizeSymbol).filter(Boolean),
      ...positions.map((p) => normalizeSymbol(p.symbol)).filter(Boolean)
    ]);
    const dynamicUniverses = Array.from(new Set(options?.dynamicUniverses ?? []));
    const weights = options?.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;
    // Item 2: congressional gate multiplier (1 = no change / default; 0 = go/no-go verdict zeroed it).
    const congressMultiplier = typeof options?.congressMultiplier === "number" ? options.congressMultiplier : 1;
    const allowWholeSetYahooFallback = options?.allowWholeSetYahooFallback ?? true;
    const warnings: string[] = [];
    let quotes: MarketQuote[] = [];
    let cached = false;
    let breadthPct: number | undefined;
    let quoteFallbackAttempted = false;
    let universeQuoteRecoverySource: string | undefined;
    const universeSources = new Set<string>();
    const paperPolicy = options?.userId
      ? paperPricePolicyForUser(options.userId, options.connectedAccountId)
      : paperDelayedPricePolicy(undefined);

    try {
      // 15s header budget + one transport retry live in the helper.  The scan
      // deadline signal aborts that wait and the JSON body.  A deadline abort
      // throws; it must not become a silent empty table.
      const result = options?.skipNasdaqScreener === true
        ? { rows: [], cached: false }
        : await fetchNasdaqScreener(options?.ttlMs ?? marketCacheTtlMs(), undefined, options?.signal);
      cached = result.cached;
      const allQuotes = result.rows.flatMap((row) => toMarketQuote(row, positions, this.name, result.asOf));
      quotes = allQuotes.filter((quote) => allowed.has(quote.symbol));

      const dynamicResult = await loadDynamicUniverseQuotes({
        dynamicUniverses: options?.skipNasdaqScreener === true ? [] : dynamicUniverses,
        allQuotes,
        positions,
        providerName: this.name,
        ttlMs: options?.ttlMs ?? marketCacheTtlMs(),
        signal: options?.signal
      });
      quotes = uniqueQuotes([...quotes, ...dynamicResult.quotes]);
      dynamicResult.warnings.forEach((warning) => warnings.push(warning));
      dynamicResult.sources.forEach((source) => universeSources.add(source));
      if (dynamicResult.cached) cached = true;

      if (quotes.length === 0 && allowed.size > 0) {
        // Yahoo whole-set pricing, then broker universe recovery, then last-good
        // seed (ST-4590).  Live Refresh of a 5k-name universe used to start
        // Yahoo-only fallback and miss the interactive budget / edge 503.
        // Interactive scans with a usable seed return that snapshot first when
        // the screener itself is down (no rows). A live screener that simply
        // missed this universe still prices through Yahoo below.
        if (result.rows.length === 0 && options?.skipNasdaqScreener !== true) {
          const preview = beginInteractiveSeedPreview({
            symbols,
            positions,
            allowed,
            seed: options?.seedEnrichment,
            seedAsOf: options?.seedAsOf,
            weights,
            warnings,
            options,
            allowWholeSetYahooFallback
          });
          if (preview) return preview;
        }
        quoteFallbackAttempted = true;
        const recovered = await recoverQuotesWhenScreenerEmpty({
          allowed,
          positions,
          seed: options?.seedEnrichment,
          // The fail-fast opt-out targets a DOWN screener.  This branch only
          // runs when no priced screener row intersects `allowed` (quotes is
          // empty), so overlap cannot reach here.  Any raw row (priced or not)
          // means the screener is live and the universe is custom-only: not an
          // outage, so keep the Yahoo fallback.
          allowWholeSetYahooFallback: allowWholeSetYahooFallback || result.rows.length > 0,
          userId: options?.userId,
          connectedAccountId: options?.connectedAccountId,
          signal: options?.signal,
          deadlineAt: options?.deadlineAt
        });
        quotes = [...quotes, ...recovered.quotes];
        warnings.push(...recovered.warnings);
        if (recovered.usedSeed) cached = true;
        if (recovered.recoverySource) {
          universeQuoteRecoverySource = recovered.recoverySource;
          universeSources.add(recovered.recoverySource);
        }
        for (const q of recovered.quotes) if (q.provider) universeSources.add(q.provider);
      } else {
        const returnedSymbols = new Set(quotes.map((quote) => quote.symbol));
        const customSymbolsMissingFromScreener = Array.from(allowed)
          .filter((symbol) => !returnedSymbols.has(symbol) && !isIndexMemberSymbol(symbol));
        if (customSymbolsMissingFromScreener.length > 0) {
          const quoteOnly = await fetchQuoteOnlyMarketQuotes(customSymbolsMissingFromScreener, positions);
          quotes = [...quotes, ...quoteOnly.quotes];
          warnings.push(...quoteOnly.warnings);
          // The quote-only fallback DISPLAYS these Yahoo quotes; record its provider so MarketScan.source
          // still lists Yahoo even if enrichment later contributes no accepted field for those rows.
          for (const q of quoteOnly.quotes) if (q.provider) universeSources.add(q.provider);
        }
      }
      // Market breadth: % of the full screener that's advancing today — a free,
      // market-wide risk-on/risk-off gauge (computed from data we already fetched).
      const moved = allQuotes.filter((q) => q.intradayChangePct !== 0);
      if (moved.length >= 20) {
        breadthPct = Math.round((moved.filter((q) => q.intradayChangePct > 0).length / moved.length) * 100);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Market data request failed.");
    }

    if (quotes.length === 0 && allowed.size > 0 && !quoteFallbackAttempted) {
      // Fetch throw / empty payload. Same order as the empty-rows branch:
      // Yahoo whole-set, then broker, then seed. An interactive seed preview
      // returns before this call and finishes live recovery on the side.
      if (options?.skipNasdaqScreener !== true) {
        const preview = beginInteractiveSeedPreview({
          symbols,
          positions,
          allowed,
          seed: options?.seedEnrichment,
          seedAsOf: options?.seedAsOf,
          weights,
          warnings,
          options,
          allowWholeSetYahooFallback
        });
        if (preview) return preview;
      }
      const recovered = await recoverQuotesWhenScreenerEmpty({
        allowed,
        positions,
        seed: options?.seedEnrichment,
        allowWholeSetYahooFallback,
        userId: options?.userId,
        connectedAccountId: options?.connectedAccountId,
        signal: options?.signal,
        deadlineAt: options?.deadlineAt
      });
      quotes = [...quotes, ...recovered.quotes];
      warnings.push(...recovered.warnings);
      if (recovered.usedSeed) cached = true;
      if (recovered.recoverySource) {
        universeQuoteRecoverySource = recovered.recoverySource;
        universeSources.add(recovered.recoverySource);
      }
      for (const q of recovered.quotes) if (q.provider) universeSources.add(q.provider);
    }

    if (quotes.length === 0 && allowed.size === 0) {
      warnings.push(
        "This universe has no symbols.  Choose a base index or add symbols on Guardrails."
      );
    } else if (quotes.length === 0) {
      throw new ScanQuotesUnavailableError({
        scannedSymbols: allowed.size,
        warnings
      });
    }

    // Universe floor: drop penny/illiquid index + dynamic-universe candidates before ranking. `allowed`
    // (explicit symbols + held positions) is exempt — never hide a name the user listed or a position to exit.
    quotes = applyUniverseFloor(quotes, allowed, options?.universeFloor);

    const portfolioSectorContext: ScoreFactorsContext = {
      portfolioSectors: derivePortfolioSectorWeights(positions, quotes)
    };
    const ranked = rankMarketQuotes(quotes, weights, portfolioSectorContext).map((quote) => ({ ...quote, cached }));
    const candidateLimit = normalizeMarketScanCandidateLimit(options?.candidateLimit, envNumber("MARKET_SCAN_LIMIT", DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT));
    const outlierReserve = normalizeMarketScanOutlierReserve(options?.outlierReserve, candidateLimit, envNumber("MARKET_SCAN_EVENT_RESERVE", DEFAULT_MARKET_SCAN_OUTLIER_RESERVE));

    // Read cached web-source signals for the WHOLE ranked universe (no network) so a
    // freshly-disclosed congressional/insider/short name that scored below the top-N
    // cutoff can still be pulled into the candidate set — "event candidate union".
    let allWebSignals: Record<string, SymbolWebSignal> = {};
    try {
      allWebSignals = getSymbolWebSignals(ranked.map((quote) => quote.symbol));
    } catch (error) {
      warnings.push(error instanceof Error ? `Web signals failed: ${error.message}` : "Web signals failed.");
    }
    const topCut = new Set(ranked.slice(0, candidateLimit).map((quote) => quote.symbol));
    // Statistical-outlier cutoffs across the WHOLE ranked universe: a name is "extreme" today if its
    // absolute intraday move or its volume sits far in the right tail (mean + 2σ). This lets an
    // unusually active/volatile name surface as a candidate even with no congressional/insider signal.
    const moveCut = tailThreshold(
      ranked.map((q) => Math.abs(q.intradayChangePct ?? 0)).filter((v) => Number.isFinite(v)),
      2
    );
    const volCut = tailThreshold(
      ranked.map((q) => q.volume ?? 0).filter((v) => Number.isFinite(v) && v > 0),
      2
    );
    const isStatisticalOutlier = (quote: MarketQuote): boolean =>
      (moveCut !== undefined && Math.abs(quote.intradayChangePct ?? 0) >= moveCut) ||
      (volCut !== undefined && (quote.volume ?? 0) >= volCut);
    // Outliers = up to `outlierReserve` below-cutoff names with either a notable cached web signal
    // (heavy congressional/insider buying, short pressure, strong technicals) OR statistically
    // extreme price/volume action. These are ADDED ON TOP of the top-N (not swapped in), so the
    // candidate set is the full top-N PLUS the outliers — exactly the "30 + up to 8 outliers" model.
    const eventExtra = ranked
      .filter((quote) => !topCut.has(quote.symbol)
        && (hasNotableWebSignal(allWebSignals[quote.symbol], congressMultiplier) || isStatisticalOutlier(quote)))
      .sort((a, b) => {
        const signalDelta = outlierInterestScore(allWebSignals[b.symbol], congressMultiplier) - outlierInterestScore(allWebSignals[a.symbol], congressMultiplier);
        return signalDelta !== 0 ? signalDelta : compareMarketQuotes(a, b);
      })
      .slice(0, outlierReserve);
    // Holdings always remain forced candidates, including if enrichment later moves a non-held name
    // above one that initially ranked inside the top-N.
    const heldSymbols = new Set(positions.map((p) => normalizeSymbol(p.symbol)).filter(Boolean));

    // Enrich a wider, bounded first-stage pool before the final top-N cut. This lets fundamentals,
    // sentiment, and quality data promote a name that missed the initial screener-only cutoff. It is
    // deliberately one batched provider call: widening selection must not introduce another waterfall.
    //
    // Durable baseline: ALWAYS load the shared symbol_field_latest store (per-field as_of +
    // fetched_at) for the preselection pool, then layer caller seedEnrichment (audit payloads)
    // on top field-by-field. Live cascade overwrites when it returns values. This is what keeps
    // PE/EPS/div visible after strategy_run audits omit the full MarketScan, and keeps yesterday's
    // symbols' last known fields available even if they are not in today's ranked set.
    const enrichPlan = enrichmentPlanForDeadline(options?.deadlineAt);
    const skipLiveEnrich = options?.enrichmentMode === "skip" || enrichPlan.skipLiveEnrich;
    const provider = skipLiveEnrich ? undefined : getEnrichmentProvider(options?.userId, {
      connectedAccountId: options?.connectedAccountId
    });
    let rescoredRanked: MarketQuote[] = ranked;
    const preselectionPool = buildEnrichmentPreselectionPool(
      ranked,
      eventExtra,
      heldSymbols,
      candidateLimit,
      enrichPlan.shrinkPoolToCandidates ? candidateLimit : undefined
    );
    if (provider && enrichPlan.shrinkPoolToCandidates) {
      warnings.push(
        "Enrichment pool shrunk to the ranked candidate cut to finish gather before the deadline."
      );
    }
    const seedBySymbol = await loadDurableEnrichmentSeed(
      preselectionPool.map((q) => q.symbol),
      options?.seedEnrichment
    );
    // ST-4679 OD-1: derive multi-horizon momentum / realized-vol / 20d-ADV fields from the stored
    // nightly EOD cache. One chunked cache read (no network), stale series skipped inside the
    // loader; attached ahead of scoreFactors in every path below, INCLUDING the fallback quotes
    // outside the preselection pool (pool plus the top of the ranked tape, capped) so rescoredRanked
    // never mixes bar-derived and non-derived scores at the candidate cut. Absent bars leave the map
    // empty -> quotes unchanged.
    const barFieldSymbols = new Set<string>(preselectionPool.map((q) => q.symbol));
    for (const q of ranked.slice(0, BAR_DERIVED_RANKED_COVERAGE)) barFieldSymbols.add(q.symbol);
    const barFieldsBySymbol = await barDerivedFieldsBySymbolAsync(Array.from(barFieldSymbols));
    const applySeedBaseline = (quote: MarketQuote): MarketQuote => {
      const prior = seedBySymbol[quote.symbol] ?? seedBySymbol[normalizeSymbol(quote.symbol)];
      if (!prior) return quote;
      return applyEnrichment(quote, persistedSlowEnrichment(prior), paperPolicy);
    };
    // Fallback quotes outside the enrichment pool keep their gather-time score UNLESS bar-derived
    // fields exist for them, in which case they are rescored with the same inputs as the pool so the
    // mixed-score asymmetry cannot land at the candidate cut. Attaching is a no-op when no fields
    // exist, preserving the previous behavior byte-for-byte for cache-less symbols.
    const rescoreWithBarFields = (quote: MarketQuote): MarketQuote => {
      const enriched = attachBarDerivedFields(quote, barFieldsBySymbol);
      if (enriched === quote) return quote;
      const factorBreakdown = scoreFactors(enriched, weights, portfolioSectorContext);
      return { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal };
    };

    const applySeededPool = (): MarketQuote[] => {
      const seededBySymbol = new Map(
        preselectionPool.map((quote) => {
          const enriched = attachBarDerivedFields(applySeedBaseline(quote), barFieldsBySymbol);
          const factorBreakdown = scoreFactors(enriched, weights, portfolioSectorContext);
          return [quote.symbol, { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal }] as const;
        })
      );
      return ranked
        .map((quote) => seededBySymbol.get(quote.symbol) ?? rescoreWithBarFields(quote))
        .sort(compareMarketQuotes);
    };

    if (preselectionPool.length > 0 && provider) {
      try {
        if (options?.signal?.aborted) {
          warnings.push(
            "Live enrichment skipped after gather abort; using the ranked Nasdaq tape plus durable field-store values."
          );
          rescoredRanked = applySeededPool();
        } else {
          // Seed first so cascade gaps never blank a field we already know.
          const baselinePool = preselectionPool.map(applySeedBaseline);
          const enrichment = await provider.enrich(baselinePool.map((quote) => quote.symbol), {
            signal: options?.signal,
            deadlineAt: options?.deadlineAt
          });
          const rescoredBySymbol = new Map(
            baselinePool.map((quote) => {
              const live = enrichment[quote.symbol];
              const enriched = attachBarDerivedFields(live ? applyEnrichment(quote, live, paperPolicy) : quote, barFieldsBySymbol);
              const factorBreakdown = scoreFactors(enriched, weights, portfolioSectorContext);
              return [quote.symbol, { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal }] as const;
            })
          );
          rescoredRanked = ranked
            .map((quote) => rescoredBySymbol.get(quote.symbol) ?? rescoreWithBarFields(applySeedBaseline(quote)))
            .sort(compareMarketQuotes);
        }
      } catch (error) {
        // Abort during enrich used to rethrow and throw away today's ranked Nasdaq
        // tape, forcing yesterday's last-good.  Keep the live ranks + durable seed.
        if (options?.signal?.aborted) {
          warnings.push(
            "Live enrichment aborted; using the ranked Nasdaq tape plus durable field-store values."
          );
        } else {
          warnings.push(error instanceof Error ? `Enrichment failed: ${error.message}` : "Enrichment failed.");
        }
        rescoredRanked = applySeededPool();
      }
    } else if (preselectionPool.length > 0) {
      // Skip mode (interactive) or no provider: still surface last-known per-field data.
      const seededBySymbol = new Map(
        preselectionPool.map((quote) => {
          const enriched = attachBarDerivedFields(applySeedBaseline(quote), barFieldsBySymbol);
          const factorBreakdown = scoreFactors(enriched, weights, portfolioSectorContext);
          return [quote.symbol, { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal }] as const;
        })
      );
      rescoredRanked = ranked
        .map((quote) => seededBySymbol.get(quote.symbol) ?? rescoreWithBarFields(quote))
        .sort(compareMarketQuotes);
      const seedHits = preselectionPool.filter(
        (q) => seedBySymbol[q.symbol] || seedBySymbol[normalizeSymbol(q.symbol)]
      ).length;
      if (seedHits > 0) {
        warnings.push(
          `Slow fundamentals reuse the durable field store (${seedHits} names with last-known values; each field keeps its own as_of/fetched_at).`
        );
      }
      if (enrichPlan.skipLiveEnrich && options?.enrichmentMode !== "skip") {
        warnings.push(
          "Live enrichment skipped to finish gather before the 8-minute deadline; using durable field-store values."
        );
      } else if (seedHits === 0 && options?.enrichmentMode === "skip") {
        warnings.push(
          "Deep fundamentals refresh is deferred for this interactive scan and no durable field-store rows were found yet; open a ticker for on-demand data or wait for a full enrichment run."
        );
      }
    }

    // Stage two: select the re-scored top-N, then append the original event reserve and every held
    // name that is still outside that cut. Those forced paths remain additive and are never displaced
    // by enrichment; only the normal top-N boundary is allowed to move.
    const rescoredBySymbol = new Map(rescoredRanked.map((quote) => [quote.symbol, quote]));
    const finalTop = rescoredRanked.slice(0, candidateLimit);
    const finalTopSymbols = new Set(finalTop.map((quote) => quote.symbol));
    const eventExtraSymbols = new Set(eventExtra.map((quote) => quote.symbol));
    // Honest decomposition (item 26): a held position forced additively into the candidate set,
    // beyond the ranked cut AND beyond the already-counted outlier reserve. This is what actually
    // lets topCandidates.length exceed candidateLimit — surfaced so the UI can say "50 ranked + 14
    // held + 11 outliers" instead of a bare "75/50 candidates" that reads like the cap was ignored.
    const heldCandidateCount = rescoredRanked.filter(
      (quote) => heldSymbols.has(quote.symbol) && !finalTopSymbols.has(quote.symbol) && !eventExtraSymbols.has(quote.symbol)
    ).length;
    let topCandidates = uniqueQuotesBySymbol([
      ...finalTop,
      ...eventExtra.map((quote) => rescoredBySymbol.get(quote.symbol) ?? quote),
      ...rescoredRanked.filter((quote) => heldSymbols.has(quote.symbol))
    ]);

    // Overlay backend web-source signals onto the candidates and STAMP their provenance
    // (so source attribution stays honest). senateTrades/insiderSentiment are filled only
    // when a keyed provider didn't already supply them. No network here.
    const overlaySources = new Set<string>();
    const signalNow = Date.now();
    topCandidates = topCandidates.map((quote) => {
      const sig = allWebSignals[quote.symbol];
      if (!sig) return quote;
      const sources = { ...(quote.sources ?? {}) };
      let senateTrades = quote.senateTrades;
      // Item 2: skip the congressional senateTrades overlay entirely when the go/no-go gate zeroed the
      // congress term (multiplier 0), so the positioning factor never lifts on an unvalidated signal.
      if (congressMultiplier !== 0 && senateTrades == null && typeof sig.congress?.netSignal === "number") {
        senateTrades = sig.congress.netSignal;
        sources.senateTrades = "congress";
        overlaySources.add("congress");
      }
      let insiderSentiment = quote.insiderSentiment;
      if (insiderSentiment == null && typeof sig.insiderSentiment === "number") {
        insiderSentiment = sig.insiderSentiment;
        sources.insiderSentiment = "sec-edgar";
        overlaySources.add("sec-edgar");
      }
      if (typeof sig.shortVolumeRatio === "number" && sig.shortVolumeRatio >= 55) overlaySources.add("finra");
      // Bar-based technical read (TradingView push or in-house computed). Feeds momentumScore.
      if (sig.technical) overlaySources.add(sig.technical.source);
      const rawCongressComposite = scoreCongressSignal(
        { congress: sig.congress, congressAnalytics: sig.congressAnalytics },
        signalNow
      );
      // Item 2: when the go/no-go gate zeroed the congress term (multiplier 0), scale the composite score
      // to 0 so it neither lifts positioning nor adds the congress.trade source — the signal failed
      // statistical validation and must not move the ranking. Multiplier 1 (default) = unchanged.
      const congressComposite = congressMultiplier === 1
        ? rawCongressComposite
        : { ...rawCongressComposite, score: rawCongressComposite.score * congressMultiplier, signedScore: rawCongressComposite.signedScore * congressMultiplier };
      if (congressComposite.score > 0) overlaySources.add("congress.trade");
      const overlaid: MarketQuote = {
        ...quote,
        preCongressScore: quote.preCongressScore ?? quote.score,
        senateTrades,
        insiderSentiment,
        technicalScore: sig.technical?.score ?? quote.technicalScore,
        technicalDirection: sig.technical?.direction ?? quote.technicalDirection,
        technicalSignals: sig.technical?.signals ?? quote.technicalSignals,
        ...(congressComposite.score > 0
          ? {
              congressCompositeScore: congressComposite.score,
              congressCompositeSignedScore: congressComposite.signedScore,
              congressCompositeDirection: congressComposite.direction,
              congressCompositeConfidence: congressComposite.confidence,
              congressCompositeComponents: { ...congressComposite.components },
              congressCompositeProvenance: { ...congressComposite.provenance },
              congressCompositeVersion: congressComposite.version,
              congressCompositeWeights: { ...congressComposite.weights }
            }
          : {}),
        // Member skill context (App A dual performance) even when composite is low/neutral —
        // strategist + signal_snapshot need raw filing-date excess, not only rank.
        ...(sig.congressAnalytics?.topMemberScore != null
          ? {
              congressMemberSkillScore: sig.congressAnalytics.topMemberScore,
              congressMemberSkillSource: sig.congressAnalytics.topMemberScoreSource,
              congressMemberFilerId: sig.congressAnalytics.topMemberFilerId,
              congressMemberFilingAvgExcess: sig.congressAnalytics.topMemberFilingAvgExcess ?? undefined,
              congressMemberFilingWinRate: sig.congressAnalytics.topMemberFilingWinRate ?? undefined,
              congressMemberFilingScoredCount: sig.congressAnalytics.topMemberFilingScoredCount,
              congressMemberTradeAvgExcess: sig.congressAnalytics.topMemberTradeAvgExcess ?? undefined,
              congressMemberTradeWinRate: sig.congressAnalytics.topMemberTradeWinRate ?? undefined,
              congressMemberTradeScoredCount: sig.congressAnalytics.topMemberTradeScoredCount
            }
          : {}),
        // MERGE (deduped) rather than replace — otherwise a disagreement bulletin already on the quote
        // (e.g. the Yahoo-vs-FMP short-interest warning added in applyEnrichment) is silently dropped
        // for any symbol that also has web-source (congress/insider/FINRA) bulletins.
        evidenceBulletins: sig.bulletins.length > 0
          ? Array.from(new Set([...(quote.evidenceBulletins ?? []), ...sig.bulletins]))
          : quote.evidenceBulletins,
        sources
      };
      // Recompute the score: positioning depends on senateTrades/insiderSentiment and momentum
      // now blends technicalScore — both filled by the overlay — so a freshly-disclosed
      // smart-money name or a strong technical signal ranks up deterministically.
      const factorBreakdown = scoreFactors(overlaid, weights, portfolioSectorContext);
      return { ...overlaid, factorBreakdown, score: factorBreakdown.weightedTotal };
    });
    // Re-sort so the positioning/technical lift actually reorders the displayed candidates.
    topCandidates = topCandidates.sort(compareMarketQuotes);

    // Cross-sectional sector relative strength: each name's intraday move vs the average
    // move of its sector among the candidates. Lets the agent (and UI) see who is leading
    // or lagging its own sector today, not just the tape overall. Computed in-house.
    const sectorAgg = new Map<string, { sum: number; count: number }>();
    for (const quote of topCandidates) {
      if (!quote.sector || !Number.isFinite(quote.intradayChangePct)) continue;
      const agg = sectorAgg.get(quote.sector) ?? { sum: 0, count: 0 };
      agg.sum += quote.intradayChangePct;
      agg.count += 1;
      sectorAgg.set(quote.sector, agg);
    }
    topCandidates = topCandidates.map((quote) => {
      const agg = quote.sector ? sectorAgg.get(quote.sector) : undefined;
      // Need at least one peer in the sector for a relative read to be meaningful.
      if (!agg || agg.count < 2 || !Number.isFinite(quote.intradayChangePct)) return quote;
      const sectorAvg = agg.sum / agg.count;
      return { ...quote, sectorRelStrength: Math.round((quote.intradayChangePct - sectorAvg) * 100) / 100 };
    });

    // Record the candidate set plus a rotating slice of the broader ranked universe as the
    // technical watchlist so the in-house "computed" producer (TECHNICAL_SOURCE=computed) and
    // nightly OHLC rotation gradually discover broader-universe names rather than only refreshing
    // yesterday's top candidates.
    if (topCandidates.length > 0) {
      try {
        const watchlistSymbols = buildRotatingTechnicalWatchlist(
          topCandidates.map((quote) => quote.symbol),
          rescoredRanked.map((quote) => quote.symbol)
        );
        setTechnicalWatchlist(watchlistSymbols);
      } catch {
        /* watchlist persistence is best-effort; never block a scan on it */
      }
    }

    // Fold enriched candidates back into the full set so quotesBySymbol carries sentiment/PE.
    const enrichedBySymbol = new Map(topCandidates.map((quote) => [quote.symbol, quote]));
    const mergedRanked = ranked.map((quote) => enrichedBySymbol.get(quote.symbol) ?? quote);

    // Name only sources attached to fields that ACTUALLY survived arbitration. This
    // also preserves the provenance of slow facts reused from a persisted strategy
    // scan without implying that those providers were called by this HTTP request.
    const contributedSources = provider?.activeSources ?? Array.from(new Set(
      topCandidates.flatMap((quote) => Object.values(quote.sources ?? {})).filter(Boolean)
    )) as string[];
    const baseSource = appendUniqueSources(this.name, contributedSources);
    const source = appendUniqueSources(
      overlaySources.size > 0 ? `${baseSource}+${[...overlaySources].join("+")}` : baseSource,
      [...universeSources]
    );

    // Loud shortfall report — never leave blank PE/EPS/news as silent dashes only.
    let dataCoverage: MarketScan["dataCoverage"];
    try {
      const { buildScanDataCoverage } = await import("./enrichment-coverage");
      dataCoverage = buildScanDataCoverage(topCandidates);
      if (dataCoverage.missingFields.length > 0 || dataCoverage.partialFields.length > 0) {
        warnings.push(dataCoverage.shortfallSummary);
      }
    } catch {
      dataCoverage = undefined;
    }

    const result = stampScanPaperDelay(
      {
        source,
        generatedAt: new Date().toISOString(),
        scannedSymbols: new Set([...allowed, ...quotes.map((quote) => quote.symbol)]).size,
        returnedQuotes: quotes.length,
        candidateLimit,
        outlierReserve,
        outlierCandidateCount: eventExtra.length,
        heldCandidateCount,
        breadthPct,
        topCandidates,
        sectorBySymbol: sectorBySymbol(mergedRanked),
        quotesBySymbol: quotesBySymbol(mergedRanked),
        cacheTtlMs: options?.ttlMs ?? marketCacheTtlMs(),
        cached,
        warnings,
        ...(universeQuoteRecoverySource ? { universeQuoteRecoverySource } : {}),
        dataCoverage
      },
      paperPolicy
    );

    // Persist every filled field on every candidate (and the ranked merge set) into the
    // shared symbol_field_latest store — each field keeps its own as_of + fetched_at.
    // Fire-and-forget; never block or fail a scan on store write.
    void persistScanFieldsToStore(result.topCandidates, result.generatedAt);

    return result;
  }
};

/** Load durable per-field latest values, then layer optional audit seeds field-by-field. */
async function loadDurableEnrichmentSeed(
  symbols: string[],
  auditSeed?: Record<string, MarketQuoteSummary>
): Promise<Record<string, MarketQuoteSummary>> {
  let storeSeed: Record<string, MarketQuoteSummary> = {};
  try {
    const mod = await import("./db-fundamentals");
    storeSeed = mod.marketQuoteSummariesFromFieldStore(symbols) as Record<string, MarketQuoteSummary>;
  } catch {
    storeSeed = {};
  }
  if (!auditSeed || Object.keys(auditSeed).length === 0) return storeSeed;
  return mergeQuoteSeedsFieldLevel(storeSeed, auditSeed);
}

/**
 * Field-level merge of quote seeds. For each symbol/field, keep a non-empty value;
 * when both have values, prefer the one with the newer per-field fetchedAt (or asOf).
 * Later seeds without a per-field stamp (caller/audit seedEnrichment) win over earlier
 * durable-store rows so interactive intent is not blanked by a prior scan's companyName.
 * Never whole-object overwrite a rich seed with a blank audit shell.
 */
export function mergeQuoteSeedsFieldLevel(
  ...seeds: Array<Record<string, MarketQuoteSummary> | undefined>
): Record<string, MarketQuoteSummary> {
  const out: Record<string, MarketQuoteSummary> = {};
  for (const seed of seeds) {
    if (!seed) continue;
    for (const [symbol, quote] of Object.entries(seed)) {
      const key = normalizeSymbol(symbol) || symbol;
      const existing = out[key];
      if (!existing) {
        out[key] = { ...quote, symbol: key, sources: { ...(quote.sources ?? {}) } };
        continue;
      }
      out[key] = mergeOneQuoteSeed(existing, quote);
    }
  }
  return out;
}

function fieldFetchedMs(quote: MarketQuoteSummary, field: string): number {
  const obs = quote.fieldObservations?.[field as keyof NonNullable<MarketQuoteSummary["fieldObservations"]>];
  const stamp = obs?.fetchedAt ?? obs?.asOf ?? quote.asOf;
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isFilledSeedValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

function mergeOneQuoteSeed(a: MarketQuoteSummary, b: MarketQuoteSummary): MarketQuoteSummary {
  const merged: MarketQuoteSummary = {
    ...a,
    sources: { ...(a.sources ?? {}) },
    fieldObservations: { ...(a.fieldObservations ?? {}) }
  };
  const skip = new Set(["symbol", "sources", "fieldObservations", "providerFailures", "factorBreakdown"]);
  const aRec = a as unknown as Record<string, unknown>;
  const bRec = b as unknown as Record<string, unknown>;
  const mergedRec = merged as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(bRec)) {
    if (skip.has(field)) continue;
    const cur = aRec[field] !== undefined ? aRec[field] : mergedRec[field];
    const bFilled = isFilledSeedValue(value);
    const aFilled = isFilledSeedValue(cur);
    if (!bFilled) continue;
    // Prefer later seed when: (1) earlier empty, (2) later has no per-field
    // fieldObservations entry (caller seedEnrichment is intentional override and
    // rarely carries per-field stamps — quote.asOf is NOT a field stamp), or
    // (3) later is newer by field observation. Without (2), durable store rows
    // with fetchedAt always blank interactive companyName / PE from audit seeds.
    const bHasFieldObs = Boolean(
      b.fieldObservations?.[field as keyof NonNullable<MarketQuoteSummary["fieldObservations"]>]
    );
    const aHasFieldObs = Boolean(
      a.fieldObservations?.[field as keyof NonNullable<MarketQuoteSummary["fieldObservations"]>]
    );
    const preferB =
      !aFilled ||
      !bHasFieldObs ||
      !aHasFieldObs ||
      fieldFetchedMs(b, field) >= fieldFetchedMs(a, field);
    if (preferB) {
      mergedRec[field] = value;
      const bSrc = b.sources?.[field as keyof EnrichmentSources];
      if (bSrc) merged.sources = { ...merged.sources, [field]: bSrc };
      const bObs = b.fieldObservations?.[field as keyof NonNullable<MarketQuoteSummary["fieldObservations"]>];
      if (bObs) {
        merged.fieldObservations = { ...merged.fieldObservations, [field]: bObs };
      }
    }
  }
  // Prefer a real price for seed validation when one side has it.
  if (!(merged.price > 0) && b.price > 0) merged.price = b.price;
  if (!(typeof merged.score === "number" && Number.isFinite(merged.score)) && typeof b.score === "number") {
    merged.score = b.score;
  }
  return merged;
}

function persistScanFieldsToStore(candidates: MarketQuote[], fetchedAt: string): void {
  void import("./db-fundamentals")
    .then((mod) => {
      if (typeof mod.upsertSymbolFieldLatest !== "function" || typeof mod.encodeFieldValue !== "function") {
        return;
      }
      const records: import("./db-fundamentals").SymbolFieldLatestRecord[] = [];
      const META = new Set([
        "symbol",
        "sources",
        "fieldObservations",
        "providerFailures",
        "factorBreakdown",
        "evidenceBulletins",
        "technicalSignals",
        "cached",
        "provider",
        "syntheticBid",
        "syntheticAsk",
        "positionMarketValue",
        "preCongressScore",
        "score"
      ]);
      for (const quote of candidates) {
        const symbol = normalizeSymbol(quote.symbol);
        if (!symbol) continue;
        const sources = quote.sources ?? {};
        const observations = quote.fieldObservations ?? {};
        for (const [field, value] of Object.entries(quote as unknown as Record<string, unknown>)) {
          if (META.has(field)) continue;
          if (typeof value === "function") continue;
          const valueJson = mod.encodeFieldValue(value);
          if (!valueJson) continue;
          const obs = observations[field as keyof typeof observations];
          const observationAsOf =
            (obs && typeof obs === "object" && ("asOf" in obs ? (obs as { asOf?: string }).asOf : undefined)) ||
            (field === "asOf" && typeof value === "string" ? value : undefined) ||
            quote.asOf;
          const quoteClock = field === "price" || field === "bid" || field === "ask";
          if (quoteClock && !observationAsOf) continue;
          const asOf =
            observationAsOf ||
            (obs && typeof obs === "object" && ("fetchedAt" in obs ? (obs as { fetchedAt?: string }).fetchedAt : undefined)) ||
            fetchedAt;
          const fieldFetched =
            (obs && typeof obs === "object" && ("fetchedAt" in obs ? (obs as { fetchedAt?: string }).fetchedAt : undefined)) ||
            fetchedAt;
          records.push({
            symbol,
            field,
            valueJson,
            source: sources[field as keyof EnrichmentSources] ?? quote.provider ?? "scan",
            asOf: asOf ?? fetchedAt,
            fetchedAt: fieldFetched ?? fetchedAt
          });
        }
      }
      if (records.length > 0) mod.upsertSymbolFieldLatest(records);
    })
    .catch(() => {
      /* store is best-effort */
    });
}

// Pinned on globalThis so duplicate Next.js bundles share one rotation position.
declare global {
  var __socraticTechnicalWatchlistRotationCursor: number | undefined;
}

/**
 * Interleave top candidates with a rotating slice of the broader universe so nightly OHLC /
 * technical refresh gradually covers non-top universe symbols instead of starving everything
 * outside yesterday's top cut.
 */
export function buildRotatingTechnicalWatchlist(
  topSymbols: string[],
  universeSymbols: string[],
  maxWatchlist = Math.max(1, Number(process.env.WEB_SOURCE_TECHNICAL_MAX ?? 40))
): string[] {
  const top = [...new Set(topSymbols.map(normalizeSymbol).filter(Boolean))];
  const topSet = new Set(top);
  const broader = [...new Set(universeSymbols.map(normalizeSymbol).filter((s) => Boolean(s) && !topSet.has(s)))];
  if (broader.length === 0) return top.slice(0, maxWatchlist);

  // Reserve ~35% of watchlist capacity (at least 1 slot when maxWatchlist > 1) for rotating broader-universe discovery.
  const rotationSlots = maxWatchlist > 1 ? Math.max(1, Math.min(broader.length, Math.floor(maxWatchlist * 0.35))) : 0;
  const topLimit = Math.max(1, maxWatchlist - rotationSlots);
  const keptTop = top.slice(0, topLimit);

  const rotated: string[] = [];
  const start = (globalThis.__socraticTechnicalWatchlistRotationCursor ?? 0) % broader.length;
  for (let i = 0; i < rotationSlots; i++) {
    rotated.push(broader[(start + i) % broader.length]!);
  }
  globalThis.__socraticTechnicalWatchlistRotationCursor = (start + rotationSlots) % broader.length;

  const combined = [...keptTop, ...rotated];
  for (const sym of top.slice(topLimit)) {
    if (combined.length >= maxWatchlist) break;
    combined.push(sym);
  }
  return combined;
}

export function rankMarketQuotes(
  quotes: MarketQuote[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  context?: ScoreFactorsContext
): MarketQuote[] {
  const effectiveContext: ScoreFactorsContext = context ?? { portfolioSectors: derivePortfolioSectorWeights(quotes) };
  return quotes
    .map((quote) => {
      const factorBreakdown = scoreFactors(quote, weights, effectiveContext);
      return { ...quote, factorBreakdown, score: factorBreakdown.weightedTotal };
    })
    .sort(compareMarketQuotes);
}

/** Select only fields that remain useful across a short-lived interactive refresh.
 * Price, spread, change, volume, VWAP, and timestamps must always come from the
 * fresh scan/broker path, never from the persisted strategy snapshot.
 * fieldObservations are carried so each cell keeps its own as_of / fetched_at. */
export function persistedSlowEnrichment(quote: MarketQuoteSummary): SymbolEnrichment {
  // True slow fundamentals only — do NOT pull sentiment/headlines/insider/earnings from a
  // prior scan or durable store on the interactive path (those are volatile / context-specific).
  // fieldObservations are still carried for the fields we do reuse so each cell keeps as_of.
  const slowSourceFields = new Set([
    "companyName", "peRatio", "analystRating", "sector", "industry",
    "dividendYield", "eps", "pbRatio", "shortPercentOfFloat", "beta",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fcfYield", "debtToEquity",
    "epsGrowth", "institutionOwnershipPct", "targetMean", "targetHigh",
    "targetLow", "targetMedian", "returnOnEquity", "returnOnAssets",
    "revenueGrowth", "freeCashFlowYield", "grossProfitMargin", "sharesOutstanding"
  ]);
  const sources = Object.fromEntries(
    Object.entries(quote.sources ?? {}).filter(([field]) => slowSourceFields.has(field))
  ) as SymbolEnrichment["sources"];
  const fieldObservations = quote.fieldObservations
    ? Object.fromEntries(
        Object.entries(quote.fieldObservations).filter(([field]) => slowSourceFields.has(field))
      )
    : undefined;
  return {
    companyName: quote.companyName,
    peRatio: quote.peRatio,
    analystRating: quote.analystRating,
    analystScore: quote.analystScore,
    analystBySource: quote.analystBySource,
    sector: quote.sector,
    industry: quote.industry,
    dividendYield: quote.dividendYield,
    eps: quote.eps,
    pbRatio: quote.pbRatio,
    shortPercentOfFloat: quote.shortPercentOfFloat,
    beta: quote.beta,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
    fcfYield: quote.fcfYield,
    debtToEquity: quote.debtToEquity,
    epsGrowth: quote.epsGrowth,
    institutionOwnershipPct: quote.institutionOwnershipPct,
    targetMean: quote.targetMean,
    targetHigh: quote.targetHigh,
    targetLow: quote.targetLow,
    targetMedian: quote.targetMedian,
    returnOnEquity: quote.returnOnEquity,
    returnOnAssets: quote.returnOnAssets,
    revenueGrowth: quote.revenueGrowth,
    freeCashFlowYield: quote.freeCashFlowYield,
    grossProfitMargin: quote.grossProfitMargin,
    sharesOutstanding: quote.sharesOutstanding,
    sources,
    ...(fieldObservations && Object.keys(fieldObservations).length > 0
      ? { fieldObservations: fieldObservations as SymbolEnrichment["fieldObservations"] }
      : {})
  };
}

function persistedMarketQuotes(
  seed: Record<string, MarketQuoteSummary>,
  positions: EquityPosition[]
): MarketQuote[] {
  const positionsBySymbol = new Map(
    positions.map((position) => [normalizeSymbol(position.symbol), position])
  );
  return Object.values(seed).map((prior) => {
    const position = positionsBySymbol.get(prior.symbol);
    const base: MarketQuote = {
      symbol: prior.symbol,
      companyName: prior.companyName,
      price: prior.price,
      volume: prior.volume ?? 0,
      intradayChangePct: prior.intradayChangePct ?? 0,
      positionMarketValue: position?.marketValue ?? 0,
      score: prior.score,
      factorBreakdown: prior.factorBreakdown,
      provider: "persisted-strategy-scan",
      cached: true,
      asOf: prior.asOf,
      sources: {
        price: "persisted-strategy-scan",
        intradayChangePct: "persisted-strategy-scan",
        ...(prior.volume !== undefined ? { volume: "persisted-strategy-scan" } : {}),
        ...(prior.asOf ? { asOf: "persisted-strategy-scan" } : {})
      }
    };
    return applyEnrichment(base, persistedSlowEnrichment(prior));
  });
}

export interface ScoreFactorsContext {
  /**
   * Optional existing portfolio sector concentration: either a map of sector -> portfolio share
   * (0..1 or 0..100%) / dollar market value, or an array of sector strings / position objects.
   */
  portfolioSectors?: Record<string, number> | string[] | Array<{ sector?: string; marketValue?: number }>;
}

export function derivePortfolioSectorWeights(
  positions: Array<{ symbol?: string; sector?: string; marketValue?: number; positionMarketValue?: number }>,
  quotes?: MarketQuote[]
): Record<string, number> | undefined {
  const quoteSectorBySym = new Map<string, string>();
  if (quotes) {
    for (const q of quotes) {
      if (q.sector) quoteSectorBySym.set(normalizeSymbol(q.symbol), q.sector);
    }
  }
  const bySector = new Map<string, number>();
  let total = 0;
  for (const pos of positions) {
    const mv = Math.abs(pos.marketValue ?? pos.positionMarketValue ?? 0);
    if (!(mv > 0)) continue;
    const sym = pos.symbol ? normalizeSymbol(pos.symbol) : "";
    const sector = (pos.sector ?? (sym ? quoteSectorBySym.get(sym) : undefined))?.trim();
    if (!sector) continue;
    bySector.set(sector, (bySector.get(sector) ?? 0) + mv);
    total += mv;
  }
  if (total <= 0 || bySector.size === 0) return undefined;
  return Object.fromEntries(Array.from(bySector.entries()).map(([sec, val]) => [sec, val / total]));
}

export function scoreFactors(
  quote: MarketQuote,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  context?: ScoreFactorsContext
): MarketFactorBreakdown {
  const factors: Record<MarketFactor, number> = {
    liquidity: liquidityScore(quote),
    momentum: momentumScore(quote),
    value: valueScore(quote),
    quality: qualityScore(quote),
    volatility: volatilityScore(quote),
    sentiment: sentimentScore(quote),
    positioning: positioningScore(quote),
    diversification: diversificationScore(quote, context)
  };
  const normalized = normalizeWeights(weights);
  const weightedTotal = (Object.keys(factors) as MarketFactor[]).reduce(
    (sum, factor) => sum + factors[factor] * normalized[factor],
    0
  );
  return { ...factors, weightedTotal: Math.round(weightedTotal * 100) / 100 };
}

/**
 * Bulk-load the nightly EOD cache for a scan symbol set and derive the optional multi-horizon quote
 * fields (ST-4679 OD-1). One chunked cache read, no network. Symbols whose stored series is stale
 * (nightly rotation skipped them / cache predates the latest completed session) are SKIPPED — stale
 * bars must never override live factor scoring or the volume cap. Symbols with no stored bars (or no
 * derivable field) are absent from the map, so attaching stays byte-identical to today's fallback.
 * `now` is injectable for deterministic tests.
 */
export function barDerivedFieldsBySymbol(symbols: string[], now: number = Date.now()): Map<string, BarDerivedQuoteFields> {
  const out = new Map<string, BarDerivedQuoteFields>();
  const barsBySymbol = fetchHistoryCacheEodBulk(symbols);
  for (const [symbol, bars] of barsBySymbol) {
    if (!isBarSeriesFresh(bars, now)) continue;
    const fields = barDerivedQuoteFields(bars);
    if (Object.keys(fields).length > 0) out.set(symbol, fields);
  }
  return out;
}

/**
 * Async twin of {@link barDerivedFieldsBySymbol} over the yielding bulk cache read
 * (event-loop stall fix, 2026-11-25).  The scan path uses this so the EOD window query cannot
 * hold the event loop for seconds over a large candidate pool.
 */
export async function barDerivedFieldsBySymbolAsync(symbols: string[], now: number = Date.now()): Promise<Map<string, BarDerivedQuoteFields>> {
  const out = new Map<string, BarDerivedQuoteFields>();
  const barsBySymbol = await fetchHistoryCacheEodBulkAsync(symbols);
  for (const [symbol, bars] of barsBySymbol) {
    if (!isBarSeriesFresh(bars, now)) continue;
    const fields = barDerivedQuoteFields(bars);
    if (Object.keys(fields).length > 0) out.set(symbol, fields);
  }
  return out;
}

/**
 * Merge a symbol's bar-derived fields onto a quote ahead of scoreFactors. Looks up by the quote's
 * symbol then its normalized form (the cache map is keyed by normalized symbol). Returns the quote
 * unchanged when no fields exist for it, preserving the absent-bars fallback exactly.
 */
export function attachBarDerivedFields(
  quote: MarketQuote,
  fieldsBySymbol: Map<string, BarDerivedQuoteFields>
): MarketQuote {
  const fields = fieldsBySymbol.get(quote.symbol) ?? fieldsBySymbol.get(normalizeSymbol(quote.symbol));
  return fields ? { ...quote, ...fields } : quote;
}

export function mergeQuoteData(
  scan: MarketScan,
  quoteData: Record<string, Partial<BrokerQuote>>
): MarketScan {
  const paperPolicy = paperPolicyFromStamp(scan.priceDelay);
  // When a merge accepts a real broker bid/ask/price/volume, refresh THAT field's provenance too.
  // Otherwise a "yahoo-finance-synthetic" tag from the quote-only fallback (toQuoteOnlyMarketQuote)
  // would stick even after a real broker spread is merged in, making a genuine ask look synthetic to
  // hasRealAsk and the marketable-limit calc (which would then wrongly fall back to refPrice); and a
  // merged broker/Yahoo `price` (normalize replaces `price` below) would keep the SCREENER's stale
  // sources.price, so the drilldown/table price tooltip would misattribute the shown value.
  const refreshSideProvenance = (
    base: EnrichmentSources | undefined,
    extra: Partial<BrokerQuote>
  ): EnrichmentSources | undefined => {
    if (!extra.provider) return base;
    const usedBid = positiveNumber(extra.bid) !== undefined;
    const usedAsk = positiveNumber(extra.ask) !== undefined;
    const usedPrice = positiveNumber(extra.price) !== undefined;
    const usedVol = !!(extra.volume && extra.volume > 0);
    if (!usedBid && !usedAsk && !usedPrice && !usedVol) return base;
    // A synthesized (price-derived) side — e.g. a Test-mode Yahoo batch quote with no real bid/ask —
    // must KEEP synthetic provenance, not be relabeled as a real quoted spread. Tag EACH side by its
    // own synthetic flag so a one-sided quote's real side stays labeled with the actual provider
    // (falling back to the coarse syntheticSpread flag when the side-specific flags aren't set). Volume
    // and price are real data even when the SPREAD is synthetic (the synthetic flags describe the
    // derived bid/ask, not the last/mark price), so both always take the actual provider.
    const bidSynthetic = extra.syntheticBid ?? extra.syntheticSpread ?? false;
    const askSynthetic = extra.syntheticAsk ?? extra.syntheticSpread ?? false;
    const next: EnrichmentSources = { ...(base ?? {}) };
    if (usedBid) next.bid = bidSynthetic ? "yahoo-finance-synthetic" : extra.provider;
    if (usedAsk) next.ask = askSynthetic ? "yahoo-finance-synthetic" : extra.provider;
    if (usedPrice) next.price = extra.provider;
    if (usedVol) next.volume = extra.provider;
    return next;
  };
  const stampQuoteMergeObservations = (
    prior: EnrichmentFieldObservations | undefined,
    extra: Partial<BrokerQuote>,
    resolved: {
      bid?: number;
      ask?: number;
      price?: number;
      volume?: number;
      prevClose?: number;
      vwap?: number;
      bidSize?: number;
      askSize?: number;
    }
  ): EnrichmentFieldObservations | undefined => {
    if (!extra.provider && !extra.fieldProvenance) return prior;
    const usedBid = positiveNumber(extra.bid) !== undefined;
    const usedAsk = positiveNumber(extra.ask) !== undefined;
    const usedPrice = positiveNumber(extra.price) !== undefined;
    const usedVol = !!(extra.volume && extra.volume > 0);
    const usedPrevClose = positiveNumber(extra.prevClose) !== undefined;
    const usedVwap = positiveNumber(extra.vwap) !== undefined;
    const usedBidSize = positiveNumber(extra.bidSize) !== undefined;
    const usedAskSize = positiveNumber(extra.askSize) !== undefined;
    if (
      !usedBid &&
      !usedAsk &&
      !usedPrice &&
      !usedVol &&
      !usedPrevClose &&
      !usedVwap &&
      !usedBidSize &&
      !usedAskSize
    ) {
      return prior;
    }
    // Prefer cascade per-field receipts when present so a coalesced BrokerQuote does not
    // attribute every observation to the quote-level price provider (Codex P1 on #3449).
    const receiptFor = (field: string) => {
      const receipt = extra.fieldProvenance?.[field];
      const provider =
        receipt?.provider ??
        extra.provider ??
        "unknown";
      const asOf = receipt?.asOf ?? extra.asOf;
      const fetchedAt = receipt?.fetchedAt ?? extra.fetchedAt ?? extra.asOf ?? new Date().toISOString();
      return { provider, asOf, fetchedAt };
    };
    const next: EnrichmentFieldObservations = { ...(prior ?? {}) };
    if (usedPrice && resolved.price !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("price");
      next.price = stampFieldObservation(resolved.price, provider, { asOf, fetchedAt });
    }
    if (usedBid && resolved.bid !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("bid");
      const bidSrc =
        (extra.syntheticBid ?? extra.syntheticSpread) ? `${provider}-synthetic` : provider;
      next.bid = stampFieldObservation(resolved.bid, bidSrc, { asOf, fetchedAt });
    }
    if (usedAsk && resolved.ask !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("ask");
      const askSrc =
        (extra.syntheticAsk ?? extra.syntheticSpread) ? `${provider}-synthetic` : provider;
      next.ask = stampFieldObservation(resolved.ask, askSrc, { asOf, fetchedAt });
    }
    if (usedVol && resolved.volume !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("volume");
      next.volume = stampFieldObservation(resolved.volume, provider, { asOf, fetchedAt });
    }
    if (usedPrevClose && resolved.prevClose !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("prevClose");
      next.prevClose = stampFieldObservation(resolved.prevClose, provider, { asOf, fetchedAt });
    }
    if (usedVwap && resolved.vwap !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("vwap");
      next.vwap = stampFieldObservation(resolved.vwap, provider, { asOf, fetchedAt });
    }
    if (usedBidSize && resolved.bidSize !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("bidSize");
      next.bidSize = stampFieldObservation(resolved.bidSize, provider, { asOf, fetchedAt });
    }
    if (usedAskSize && resolved.askSize !== undefined) {
      const { provider, asOf, fetchedAt } = receiptFor("askSize");
      next.askSize = stampFieldObservation(resolved.askSize, provider, { asOf, fetchedAt });
    }
    const quoteAsOf = extra.asOf;
    if (quoteAsOf) {
      const provider = extra.provider ?? "unknown";
      const fetchedAt = extra.fetchedAt ?? quoteAsOf;
      next.asOf = stampFieldObservation(quoteAsOf, provider, { asOf: quoteAsOf, fetchedAt });
    }
    return next;
  };

  const normalize = (quote: MarketQuote): MarketQuote => {
    const extra = quoteData[quote.symbol];
    if (!extra) return quote;
    const usedBid = positiveNumber(extra.bid);
    const usedAsk = positiveNumber(extra.ask);
    const usedPrice = positiveNumber(extra.price);
    const bidSynthetic = extra.syntheticBid ?? extra.syntheticSpread ?? false;
    const askSynthetic = extra.syntheticAsk ?? extra.syntheticSpread ?? false;
    const volume =
      (extra.volume && extra.volume > 0 ? extra.volume : undefined) ??
      (quote.volume > 0 ? quote.volume : undefined) ??
      0;
    const effectivePrice = usedPrice ?? quote.price;
    const effectivePrevClose = positiveNumber(extra.prevClose) ?? positiveNumber(quote.prevClose);
    let intradayChangePct = quote.intradayChangePct;
    let netChange = quote.netChange;
    if (effectivePrice !== undefined && effectivePrevClose !== undefined && effectivePrevClose > 0) {
      intradayChangePct = Math.round(((effectivePrice - effectivePrevClose) / effectivePrevClose) * 10000) / 100;
      netChange = Math.round((effectivePrice - effectivePrevClose) * 100) / 100;
    } else if (extra.changePct !== undefined) {
      intradayChangePct = extra.changePct;
      netChange = extra.change ?? netChange;
    }
    return alignQuoteToPaperPolicy(
      {
      ...quote,
      bid: usedBid ?? quote.bid,
      ask: usedAsk ?? quote.ask,
      bidSize: positiveNumber(extra.bidSize) ?? quote.bidSize,
      askSize: positiveNumber(extra.askSize) ?? quote.askSize,
      price: effectivePrice,
      prevClose: effectivePrevClose ?? quote.prevClose,
      open: positiveNumber(extra.open) ?? quote.open,
      high: positiveNumber(extra.high) ?? quote.high,
      low: positiveNumber(extra.low) ?? quote.low,
      vwap: positiveNumber(extra.vwap) ?? quote.vwap,
      companyName: extra.companyName ?? quote.companyName,
      intradayChangePct,
      netChange,
      // Use broker/Yahoo volume if the screener didn't supply it (NASDAQ tableonly has no volume field).
      volume,
      asOf: extra.asOf ?? quote.asOf,
      provider: extra.provider ?? quote.provider,
      // Venue-delayed execution prices (Tradier sandbox) must survive the merge so policy ages
      // the snapshot, not the delayed trade print, and the cascade never re-overwrites them.
      venuePriceAuthoritative: extra.venuePriceAuthoritative ?? quote.venuePriceAuthoritative,
      expectedDelaySec: extra.expectedDelaySec ?? quote.expectedDelaySec,
      delayToleranceSec: extra.delayToleranceSec ?? quote.delayToleranceSec,
      fetchedAt: extra.fetchedAt ?? quote.fetchedAt,
      delayedFallback: extra.delayedFallback ?? quote.delayedFallback,
      priceDelayLabel: extra.priceDelayLabel ?? quote.priceDelayLabel,
      // Carry synthetic bid/ask flags through from the broker/Yahoo quote. When a side had a real value
      // (usedBid/usedAsk), the flag reflects whether THAT value was synthetic. When the side wasn't
      // provided, the original quote's flag is preserved by the spread operator above.
      syntheticBid: usedBid ? bidSynthetic : quote.syntheticBid,
      syntheticAsk: usedAsk ? askSynthetic : quote.syntheticAsk,
      sources: refreshSideProvenance(quote.sources, extra),
      fieldObservations: stampQuoteMergeObservations(quote.fieldObservations, extra, {
        bid: usedBid ?? quote.bid,
        ask: usedAsk ?? quote.ask,
        bidSize: positiveNumber(extra.bidSize) ?? quote.bidSize,
        askSize: positiveNumber(extra.askSize) ?? quote.askSize,
        price: effectivePrice,
        volume,
        prevClose: effectivePrevClose,
        vwap: positiveNumber(extra.vwap) ?? quote.vwap
      })
    },
      quote,
      paperPolicy
    );
  };
  const topCandidates = scan.topCandidates.map(normalize);
  const quoteMap = Object.fromEntries(
    Object.values(scan.quotesBySymbol).map((quote) => {
      const extra = quoteData[quote.symbol];
      const usedBid = positiveNumber(extra?.bid);
      const usedAsk = positiveNumber(extra?.ask);
      const usedPrice = positiveNumber(extra?.price);
      const bidSynthetic = extra?.syntheticBid ?? extra?.syntheticSpread ?? false;
      const askSynthetic = extra?.syntheticAsk ?? extra?.syntheticSpread ?? false;
      const volume =
        extra && extra.volume && extra.volume > 0
          ? extra.volume
          : quote.volume;
      const effectivePrice = usedPrice ?? quote.price;
      const effectivePrevClose = positiveNumber(extra?.prevClose) ?? positiveNumber(quote.prevClose);
      let intradayChangePct = quote.intradayChangePct;
      let netChange = quote.netChange;
      if (effectivePrice !== undefined && effectivePrevClose !== undefined && effectivePrevClose > 0) {
        intradayChangePct = Math.round(((effectivePrice - effectivePrevClose) / effectivePrevClose) * 10000) / 100;
        netChange = Math.round((effectivePrice - effectivePrevClose) * 100) / 100;
      } else if (extra?.changePct !== undefined) {
        intradayChangePct = extra.changePct;
        netChange = extra.change ?? netChange;
      }
      const merged: MarketQuoteSummary = alignQuoteToPaperPolicy({
        ...quote,
        bid: usedBid ?? quote.bid,
        ask: usedAsk ?? quote.ask,
        bidSize: positiveNumber(extra?.bidSize) ?? quote.bidSize,
        askSize: positiveNumber(extra?.askSize) ?? quote.askSize,
        price: effectivePrice,
        prevClose: effectivePrevClose ?? quote.prevClose,
        open: positiveNumber(extra?.open) ?? quote.open,
        high: positiveNumber(extra?.high) ?? quote.high,
        low: positiveNumber(extra?.low) ?? quote.low,
        vwap: positiveNumber(extra?.vwap) ?? quote.vwap,
        companyName: extra?.companyName ?? quote.companyName,
        intradayChangePct,
        netChange,
        volume: volume ?? quote.volume,
        provider: extra?.provider ?? quote.provider,
        asOf: extra?.asOf ?? quote.asOf,
        venuePriceAuthoritative: extra?.venuePriceAuthoritative ?? quote.venuePriceAuthoritative,
        expectedDelaySec: extra?.expectedDelaySec ?? quote.expectedDelaySec,
        delayToleranceSec: extra?.delayToleranceSec ?? quote.delayToleranceSec,
        fetchedAt: extra?.fetchedAt ?? quote.fetchedAt,
        delayedFallback: extra?.delayedFallback ?? quote.delayedFallback,
        priceDelayLabel: extra?.priceDelayLabel ?? quote.priceDelayLabel,
        syntheticBid: usedBid ? bidSynthetic : quote.syntheticBid,
        syntheticAsk: usedAsk ? askSynthetic : quote.syntheticAsk,
        sources: extra ? refreshSideProvenance(quote.sources, extra) : quote.sources,
        fieldObservations: extra
          ? stampQuoteMergeObservations(quote.fieldObservations, extra, {
              bid: usedBid ?? quote.bid,
              ask: usedAsk ?? quote.ask,
              bidSize: positiveNumber(extra.bidSize) ?? quote.bidSize,
              askSize: positiveNumber(extra.askSize) ?? quote.askSize,
              price: effectivePrice,
              volume: volume ?? quote.volume,
              prevClose: effectivePrevClose,
              vwap: positiveNumber(extra.vwap) ?? quote.vwap
            })
          : quote.fieldObservations
      }, quote, paperPolicy);
      return [quote.symbol, merged] as const;
    })
  );
  for (const [rawSymbol, quote] of Object.entries(quoteData)) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || quoteMap[symbol]) continue;
    const price = positiveNumber(quote.price);
    if (!price) continue;
    const added = alignQuoteToPaperPolicy({
      symbol,
      price,
      bid: positiveNumber(quote.bid),
      ask: positiveNumber(quote.ask),
      bidSize: positiveNumber(quote.bidSize),
      askSize: positiveNumber(quote.askSize),
      prevClose: positiveNumber(quote.prevClose),
      open: positiveNumber(quote.open),
      high: positiveNumber(quote.high),
      low: positiveNumber(quote.low),
      vwap: positiveNumber(quote.vwap),
      companyName: quote.companyName,
      intradayChangePct: quote.changePct ?? (
        positiveNumber(quote.prevClose) && price
          ? Math.round(((price - quote.prevClose!) / quote.prevClose!) * 10000) / 100
          : undefined
      ),
      netChange: quote.change ?? (
        positiveNumber(quote.prevClose) && price
          ? Math.round((price - quote.prevClose!) * 100) / 100
          : undefined
      ),
      volume: positiveNumber(quote.volume),
      score: 0,
      provider: quote.provider,
      asOf: quote.asOf,
      venuePriceAuthoritative: quote.venuePriceAuthoritative,
      expectedDelaySec: quote.expectedDelaySec,
      delayToleranceSec: quote.delayToleranceSec,
      fetchedAt: quote.fetchedAt,
      delayedFallback: quote.delayedFallback,
      syntheticBid: quote.syntheticBid ?? quote.syntheticSpread ?? false,
      syntheticAsk: quote.syntheticAsk ?? quote.syntheticSpread ?? false,
      // Seed per-side provenance for a NEWLY-added quote too — otherwise a synthetic bid/ask on an
      // added row carries no sources and reads as a real quoted spread downstream (hasRealAsk etc.).
      sources: refreshSideProvenance(undefined, quote),
      priceDelayLabel: quote.priceDelayLabel
    }, { symbol, price: 0, score: 0 }, paperPolicy);
    if (!(added.price > 0)) continue;
    quoteMap[symbol] = added;
  }
  return {
    ...scan,
    source: brokerQuoteSource(scan.source, quoteData),
    topCandidates,
    quotesBySymbol: quoteMap
  };
}

export function mergeGroupedBarData(scan: MarketScan, bars: GroupedDailyBar[], provider = "massive-vwap"): MarketScan {
  const bySymbol = new Map(bars.map((bar) => [normalizeSymbol(bar.ticker), bar]));
  let applied = false;
  const fetchedAt = new Date().toISOString();

  const withVwap = <T extends MarketQuote | MarketQuoteSummary>(quote: T): T => {
    const bar = bySymbol.get(quote.symbol);
    const vwap = positiveNumber(bar?.vwap);
    if (!vwap) return quote;
    applied = true;
    // Grouped daily bars carry session VWAP; stamp per-field source + time (capability: ohlcv_daily / vwap).
    return {
      ...quote,
      vwap,
      sources: { ...(quote.sources ?? {}), vwap: provider },
      fieldObservations: {
        ...(quote.fieldObservations ?? {}),
        vwap: stampFieldObservation(vwap, provider, {
          // Bar date when present on the payload; else fetch clock.
          asOf: (bar as { date?: string } | undefined)?.date ?? fetchedAt,
          fetchedAt
        })
      }
    };
  };
  const topCandidates = scan.topCandidates.map(withVwap);
  const quotesBySymbol = Object.fromEntries(
    Object.entries(scan.quotesBySymbol).map(([symbol, quote]) => [symbol, withVwap(quote)] as const)
  );

  return {
    ...scan,
    source: applied ? appendUniqueSources(scan.source, [provider]) : scan.source,
    topCandidates,
    quotesBySymbol
  };
}

function brokerQuoteSource(
  baseSource: string,
  quoteData: Record<string, { provider?: string }>
): string {
  const providerSources = Array.from(
    new Set(
      Object.values(quoteData)
        .map((quote) => quote.provider?.trim().toLowerCase())
        .filter((provider): provider is string => Boolean(provider))
        .map((provider) => (provider.endsWith("-quotes") ? provider : `${provider}-quotes`))
    )
  ).sort();
  const additions = providerSources.length === 0 && Object.keys(quoteData).length > 0 ? ["broker-quotes"] : providerSources;
  return appendUniqueSources(baseSource, additions);
}

function appendUniqueSources(baseSource: string, additions: string[]): string {
  const parts = baseSource
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  for (const addition of additions) {
    if (seen.has(addition)) continue;
    parts.push(addition);
    seen.add(addition);
  }
  return parts.join("+");
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function clearMarketCache(): void {
  screenerCache = new Map();
  screenerLastGood = new Map();
  screenerRefreshInFlight.clear();
  clearFundHoldingsCache();
}

function storeScreenerRows(
  cacheKey: string,
  rows: NasdaqScreenerRow[],
  ttlMs: number,
  now: number,
  asOf?: string
): void {
  screenerLastGood.set(cacheKey, { rows, asOf });
  screenerCache.set(cacheKey, { rows, asOf, expiresAt: expiresAtRespectingMarketClose(new Date(now), ttlMs) });
}

async function refreshNasdaqScreenerLive(
  cacheKey: string,
  ttlMs: number,
  exchange?: NasdaqExchange,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetchNasdaqScreenerResponse("nasdaq-delayed-screener", {
    url: nasdaqScreenerUrl(exchange),
    signal
  });
  if (!response.ok) throw new Error(`Market data request failed with ${response.status}.`);
  const payload = parseNasdaqScreenerPayload(await readNasdaqScreenerJson(response, signal));
  const rows = payload.data.table.rows;
  const asOf = payload.data.asof ?? undefined;
  storeScreenerRows(cacheKey, rows, ttlMs, Date.now(), asOf);
}

function scheduleScreenerBackgroundRefresh(cacheKey: string, ttlMs: number, exchange?: NasdaqExchange): void {
  if (screenerRefreshInFlight.has(cacheKey)) return;
  const pending = refreshNasdaqScreenerLive(cacheKey, ttlMs, exchange).catch(() => {
    /* background refresh is best-effort */
  }).finally(() => {
    screenerRefreshInFlight.delete(cacheKey);
  });
  screenerRefreshInFlight.set(cacheKey, pending);
}

async function fetchNasdaqScreener(
  ttlMs: number,
  exchange?: NasdaqExchange,
  signal?: AbortSignal
): Promise<{ rows: NasdaqScreenerRow[]; asOf?: string; cached: boolean; stale?: boolean }> {
  const now = Date.now();
  const cacheKey = exchange ?? "all";
  const cached = screenerCache.get(cacheKey);
  const lastGood = screenerLastGood.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { rows: cached.rows, asOf: cached.asOf, cached: true };
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Nasdaq screener aborted.");
  }

  if (lastGood) {
    scheduleScreenerBackgroundRefresh(cacheKey, ttlMs, exchange);
    return { rows: lastGood.rows, asOf: lastGood.asOf, cached: true, stale: true };
  }

  try {
    await refreshNasdaqScreenerLive(cacheKey, ttlMs, exchange, signal);
    const fresh = screenerCache.get(cacheKey)!;
    return { rows: fresh.rows, asOf: fresh.asOf, cached: false };
  } catch (error) {
    // This catch runs only when last-good is empty, so there is no prior price to
    // copy onto a symbol/name row.  The directory never carries lastsale.
    // toMarketQuote would drop every row, and storing them would skip Nasdaq until
    // the close.  Report the listing or the directory's own error, and leave both
    // caches untouched.  Explicit symbols still recover from the last scan, then Yahoo.
    const original = error instanceof Error ? error.message : "Nasdaq screener failed.";
    let fallbackDetail: string;
    try {
      const listed = (await fetchFallbackUniverseRows(signal)).length;
      fallbackDetail = listed === 1
        ? "Keyless directory listed 1 symbol without a price; that row was not cached."
        : `Keyless directory listed ${listed} symbols without prices; those rows were not cached.`;
    } catch (err) {
      fallbackDetail = err instanceof Error ? err.message : "keyless universe fallback failed";
    }
    throw new Error(`${original} ${fallbackDetail}`);
  }
}

function toMarketQuote(row: NasdaqScreenerRow, positions: EquityPosition[], provider: string, asOf?: string): MarketQuote[] {
  const symbol = normalizeMarketDataSymbol(String(row.symbol ?? ""));
  const price = number(row.lastsale);
  const intradayChangePct = percent(row.pctchange);
  const marketCap = number(row.marketCap);
  if (!symbol || !price) return [];

  const volume = number(row.volume);
  const netChange = number(row.netchange);
  const sector = text(row.sector);
  const industry = text(row.industry);
  const companyName = sanitizeCompanyName(text(row.name));
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);

  return [
    {
      symbol,
      companyName,
      price,
      volume,
      marketCap,
      intradayChangePct,
      netChange,
      sector: sector ?? position?.sector,
      industry: industry ?? position?.industry,
      positionMarketValue: position?.marketValue ?? 0,
      score: 0,
      provider,
      asOf
    }
  ];
}

async function loadDynamicUniverseQuotes(input: {
  dynamicUniverses: IndexUniverse[];
  allQuotes: MarketQuote[];
  positions: EquityPosition[];
  providerName: string;
  ttlMs: number;
  signal?: AbortSignal;
}): Promise<{ quotes: MarketQuote[]; warnings: string[]; sources: string[]; cached: boolean }> {
  const quotes: MarketQuote[] = [];
  const warnings: string[] = [];
  const sources: string[] = [];
  let cached = false;

  for (const universe of input.dynamicUniverses) {
    const config = INDEX_UNIVERSES[universe];
    if (!config?.dynamicSource) continue;
    if (config.dynamicSource === "nasdaq-screener") {
      quotes.push(...input.allQuotes);
      sources.push(`${universe}-universe`);
      continue;
    }
    if (config.dynamicSource === "nasdaq-exchange") {
      const exchange = config.exchange;
      if (!exchange) continue;
      try {
        const result = await fetchNasdaqScreener(input.ttlMs, exchange, input.signal);
        cached = cached || result.cached;
        quotes.push(...result.rows.flatMap((row) => toMarketQuote(row, input.positions, input.providerName, result.asOf)));
        sources.push(`${universe}-universe`);
      } catch (error) {
        warnings.push(error instanceof Error ? `${config.label} universe failed: ${error.message}` : `${config.label} universe failed.`);
      }
      continue;
    }
    if (isBlackRockHoldingUniverse(universe)) {
      try {
        const holdings = await fetchBlackRockHoldingSymbols(
          universe,
          Math.max(input.ttlMs, 6 * 60 * 60_000),
          input.signal
        );
        cached = cached || holdings.cached;
        const holdingSymbols = new Set(holdings.symbols.map(normalizeMarketDataSymbol));
        quotes.push(...input.allQuotes.filter((quote) => holdingSymbols.has(quote.symbol)));
        sources.push(holdings.provider);
      } catch (error) {
        warnings.push(error instanceof Error ? `${config.label} holdings failed: ${error.message}` : `${config.label} holdings failed.`);
      }
    }
  }

  return { quotes: uniqueQuotes(quotes), warnings, sources, cached };
}

function uniqueQuotes(quotes: MarketQuote[]): MarketQuote[] {
  return Array.from(new Map(quotes.map((quote) => [quote.symbol, quote])).values());
}

function normalizeMarketDataSymbol(value: string): string {
  return normalizeSymbol(value).replace(/\//g, "-");
}

function beginInteractiveSeedPreview(input: {
  symbols: string[];
  positions: EquityPosition[];
  allowed: Set<string>;
  seed?: Record<string, MarketQuoteSummary>;
  seedAsOf?: string;
  weights: ScoringWeights;
  warnings: string[];
  options?: MarketDataProviderOptions;
  allowWholeSetYahooFallback: boolean;
}): MarketScan | undefined {
  if (input.options?.previewSeedBeforeLiveRecovery !== true) return undefined;
  const pricesAsOf = resolveSeedPricesAsOf(input.seed, input.seedAsOf);
  if (!pricesAsOf || !input.seed) return undefined;
  const seeded = persistedMarketQuotes(input.seed, input.positions).filter((quote) =>
    input.allowed.has(normalizeSymbol(quote.symbol))
  );
  if (seeded.length === 0) return undefined;

  const recoveryId = globalThis.crypto.randomUUID();
  const controller = new AbortController();
  const outerSignal = input.options?.signal;
  if (outerSignal?.aborted) {
    controller.abort(outerSignal.reason);
  } else if (outerSignal) {
    outerSignal.addEventListener("abort", () => controller.abort(outerSignal.reason), { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new Error("Live quote recovery deadline exceeded."));
  }, LIVE_QUOTE_RECOVERY_BUDGET_MS);
  timer.unref?.();
  const userId = input.options?.userId;
  const promise = (async (): Promise<LiveQuoteRecoveryResult> => {
    try {
      return await nasdaqDelayedProvider.scan(input.symbols, input.positions, {
        scoringWeights: input.weights,
        ttlMs: input.options?.ttlMs,
        signal: controller.signal,
        userId,
        dynamicUniverses: input.options?.dynamicUniverses,
        candidateLimit: input.options?.candidateLimit,
        outlierReserve: input.options?.outlierReserve,
        universeFloor: input.options?.universeFloor,
        congressMultiplier: input.options?.congressMultiplier,
        enrichmentMode: input.options?.enrichmentMode,
        deadlineAt: Date.now() + LIVE_QUOTE_RECOVERY_BUDGET_MS,
        connectedAccountId: input.options?.connectedAccountId,
        allowWholeSetYahooFallback: input.allowWholeSetYahooFallback,
        skipNasdaqScreener: true,
        previewSeedBeforeLiveRecovery: false
      });
    } catch {
      return { keptSnapshot: true, pricesAsOf, refreshPending: false };
    } finally {
      clearTimeout(timer);
    }
  })();
  registerScanRecovery(recoveryId, userId, promise, controller);

  const candidateLimit = normalizeMarketScanCandidateLimit(
    input.options?.candidateLimit,
    envNumber("MARKET_SCAN_LIMIT", DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT)
  );
  const ranked = rankMarketQuotes(seeded, input.weights);
  const held = new Set(input.positions.map((position) => normalizeSymbol(position.symbol)).filter(Boolean));
  const top = ranked.slice(0, candidateLimit);
  const topCandidates = uniqueQuotes([
    ...top,
    ...ranked.filter((quote) => held.has(quote.symbol))
  ]);
  const previewWarnings = input.warnings.includes(STALE_SCAN_SNAPSHOT_WARNING)
    ? [...input.warnings]
    : [...input.warnings, STALE_SCAN_SNAPSHOT_WARNING];
  return {
    source: "persisted-strategy-scan",
    generatedAt: pricesAsOf,
    scannedSymbols: input.allowed.size,
    returnedQuotes: seeded.length,
    candidateLimit,
    topCandidates,
    sectorBySymbol: sectorBySymbol(topCandidates),
    quotesBySymbol: quotesBySymbol(seeded),
    cached: true,
    warnings: previewWarnings,
    pricesAsOf,
    refreshPending: true,
    recoveryId
  };
}

async function recoverQuotesWhenScreenerEmpty(input: {
  allowed: Set<string>;
  positions: EquityPosition[];
  seed?: Record<string, MarketQuoteSummary>;
  allowWholeSetYahooFallback?: boolean;
  userId?: string;
  connectedAccountId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<{
  quotes: MarketQuote[];
  warnings: string[];
  usedSeed: boolean;
  recoverySource?: string;
}> {
  const requested = Array.from(input.allowed);
  let quotes: MarketQuote[] = [];
  let warnings: string[] = [];
  let recoverySource: string | undefined;

  // ST-3999 fail-fast opt-out: a DOWN screener with the whole-set Yahoo
  // fallback disabled skips the Yahoo step; broker and seed recovery still run.
  if (input.allowWholeSetYahooFallback === false) {
    warnings.push(
      "Live Nasdaq screener data was unavailable; the whole-set Yahoo fallback is disabled for this scan."
    );
  } else {
    const quoteOnly = await fetchAllowedSetMarketQuotes(requested, input.positions, {
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      userId: input.userId
    });
    quotes = quoteOnly.quotes;
    warnings = [...quoteOnly.warnings];
  }

  if (quotes.length === 0 && input.userId && !input.signal?.aborted) {
    const brokerRecovery = await recoverUniverseQuotesFromBroker({
      symbols: requested,
      positions: input.positions,
      userId: input.userId,
      connectedAccountId: input.connectedAccountId,
      signal: input.signal,
      deadlineAt: input.deadlineAt
    });
    warnings.push(...brokerRecovery.warnings);
    if (brokerRecovery.quotes.length > 0) {
      quotes = brokerRecovery.quotes;
      recoverySource = brokerRecovery.recoverySource;
    }
  }

  if (quotes.length === 0 && input.seed) {
    const seeded = persistedMarketQuotes(input.seed, input.positions);
    if (seeded.length > 0) {
      return {
        quotes: seeded,
        warnings: [
          ...warnings,
          STALE_SCAN_SNAPSHOT_WARNING
        ],
        usedSeed: true,
        recoverySource
      };
    }
  }

  return { quotes, warnings, usedSeed: false, recoverySource };
}

async function fetchAllowedSetMarketQuotes(
  symbols: string[],
  positions: EquityPosition[],
  options?: { signal?: AbortSignal; deadlineAt?: number; userId?: string }
): Promise<{ quotes: MarketQuote[]; warnings: string[] }> {
  const requested = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const bySymbol = await fetchYahooFinanceQuotesBatch(requested, {
    concurrency: 4,
    userId: options?.userId,
    signal: options?.signal
  });
  const quotes: MarketQuote[] = [];
  const missing: string[] = [];
  for (const symbol of requested) {
    const quote = bySymbol.get(symbol);
    if (quote) quotes.push(toQuoteOnlyMarketQuote(symbol, quote, positions));
    else missing.push(symbol);
  }
  const warnings: string[] = [];
  if (missing.length > 0 && !options?.signal?.aborted) {
    const remainingMs =
      options?.deadlineAt != null ? Math.max(0, options.deadlineAt - Date.now()) : undefined;
    const chart = await fetchQuoteOnlyMarketQuotes(missing, positions, {
      signal: options?.signal,
      deadlineMs: remainingMs,
      userId: options?.userId
    });
    quotes.push(...chart.quotes);
    if (requested.length <= 8) warnings.push(...chart.warnings);
  }
  warnings.unshift(
    `The delayed screener returned no quotes; the quote fallback priced ${quotes.length} of ${requested.length} names.`
  );
  return { quotes, warnings };
}

async function fetchQuoteOnlyMarketQuotes(
  symbols: string[],
  positions: EquityPosition[],
  options?: { signal?: AbortSignal; deadlineMs?: number; userId?: string }
): Promise<{ quotes: MarketQuote[]; warnings: string[] }> {
  const quotes: MarketQuote[] = [];
  const unresolved: string[] = [];
  const requested = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  // Bounded pool, not Promise.all: firing one chart call per symbol at once
  // queued hundreds of requests behind the proxy gate, where each one's 5s
  // timer fired before a slot freed up — zero quotes (prod 2026-11-06).
  const bySymbol = await fetchYahooFinanceChartQuotes(requested, {
    signal: options?.signal,
    deadlineMs: options?.deadlineMs,
    userId: options?.userId
  });
  for (const symbol of requested) {
    const quote = bySymbol.get(symbol);
    if (quote) quotes.push(toQuoteOnlyMarketQuote(symbol, quote, positions));
    else unresolved.push(symbol);
  }
  const warnings = unresolved.length > 0
    ? [`No market data returned for custom symbol${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}. Check the ticker or try again if the market data provider is temporarily unavailable.`]
    : [];
  return { quotes, warnings };
}

export function toQuoteOnlyMarketQuote(symbol: string, quote: YahooFinanceQuote, positions: EquityPosition[]): MarketQuote {
  const yahooPrevClose = quote.prevClose;
  const prevClose = typeof yahooPrevClose === "number" && yahooPrevClose > 0 ? yahooPrevClose : quote.price;
  const netChange = quote.price - prevClose;
  const intradayChangePct = prevClose > 0 ? Math.round((netChange / prevClose) * 10_000) / 100 : 0;
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);
  // The chart endpoint has no real bid/ask; when the spread is synthesized from price, tag its
  // provenance as "yahoo-finance-synthetic" so downstream real-vs-synthetic checks (hasAskData,
  // marketable-limit pricing) never treat it as a real quoted ask. Real batch-quote spreads keep
  // the plain "yahoo-finance" attribution.
  const spreadSource = quote.syntheticSpread ? "yahoo-finance-synthetic" : "yahoo-finance";
  const syntheticBid = quote.syntheticBid ?? quote.syntheticSpread ?? false;
  const syntheticAsk = quote.syntheticAsk ?? quote.syntheticSpread ?? false;
  return {
    symbol,
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    volume: quote.volume > 0 ? quote.volume : 0,
    intradayChangePct,
    netChange: Math.round(netChange * 100) / 100,
    sector: position?.sector,
    industry: position?.industry,
    positionMarketValue: position?.marketValue ?? 0,
    score: 0,
    provider: "yahoo-finance",
    // Yahoo's observation time (regularMarketTime).  A wall-clock stamp makes
    // the staleness gate read ~0s old.  Missing regularMarketTime stays
    // undefined, which isQuoteFresh already treats as stale.
    asOf: quote.asOf,
    syntheticBid,
    syntheticAsk,
    sources: {
      price: "yahoo-finance",
      bid: spreadSource,
      ask: spreadSource,
      volume: "yahoo-finance",
      intradayChangePct: "yahoo-finance",
      asOf: "yahoo-finance"
    }
  };
}

function alignQuoteToPaperPolicy<T extends {
  price: number;
  asOf?: string;
  provider?: string;
  expectedDelaySec?: number;
  venuePriceAuthoritative?: boolean;
  bid?: number;
  ask?: number;
  priceDelayLabel?: "15-min delayed";
}>(merged: T, prior: T, policy: PaperDelayedPricePolicy | undefined): T {
  if (!policy?.active) return merged;
  const chosen = choosePaperPrice(
    [
      {
        price: merged.price,
        asOf: merged.asOf,
        provider: merged.provider,
        expectedDelaySec: merged.expectedDelaySec,
        venuePriceAuthoritative: merged.venuePriceAuthoritative,
        bid: merged.bid,
        ask: merged.ask
      },
      {
        price: prior.price,
        asOf: prior.asOf,
        provider: prior.provider,
        expectedDelaySec: prior.expectedDelaySec,
        venuePriceAuthoritative: prior.venuePriceAuthoritative,
        bid: prior.bid,
        ask: prior.ask
      }
    ],
    policy
  );
  if (chosen.withheld || chosen.price === undefined) {
    return { ...merged, price: 0, bid: undefined, ask: undefined, priceDelayLabel: undefined };
  }
  return {
    ...merged,
    price: chosen.price,
    asOf: chosen.asOf,
    bid: chosen.bid,
    ask: chosen.ask,
    priceDelayLabel: chosen.priceDelayLabel
  };
}

function stampScanPaperDelay(scan: MarketScan, policy: PaperDelayedPricePolicy): MarketScan {
  if (!policy.active || !policy.asOf) return scan;
  return {
    ...scan,
    topCandidates: scan.topCandidates.map((quote) => alignQuoteToPaperPolicy(quote, quote, policy)),
    quotesBySymbol: Object.fromEntries(
      Object.entries(scan.quotesBySymbol).map(([symbol, quote]) => [
        symbol,
        alignQuoteToPaperPolicy(quote, quote, policy)
      ])
    ),
    priceDelay: { label: policy.label, asOf: policy.asOf }
  };
}

// Merge a provider enrichment record onto a screener quote (first-non-undefined wins,
// enrichment overriding the screener). Exported + exhaustive on purpose: every enriched
// field on SymbolEnrichment must be folded here or it silently never reaches the quote —
// the dashboard, scoring, and the agent prompt all read these off MarketQuote. This is the
// "merge in market.ts" half of the cross-file enrichment trap documented in CLAUDE.md.
export function applyEnrichment(
  quote: MarketQuote,
  extra: SymbolEnrichment,
  policy?: PaperDelayedPricePolicy
): MarketQuote {
  const enrichmentBid = extra.bid && extra.bid > 0;
  const enrichmentAsk = extra.ask && extra.ask > 0;
  // SEC-derived market cap is a gap fill.  The cascade builds its base only from
  // enrichment providers, so it never sees the Nasdaq screener cap and emits
  // shares × price whenever no provider already set marketCap.  A positive screener
  // cap must win; a stale SEC share count (for example after a split) must not replace it.
  const screenerMarketCap =
    typeof quote.marketCap === "number" && quote.marketCap > 0 ? quote.marketCap : undefined;
  const secDerivedMarketCap =
    extra.sources?.marketCap === "sec-xbrl" &&
    typeof extra.marketCap === "number" &&
    extra.marketCap > 0;
  const keepScreenerMarketCap = Boolean(secDerivedMarketCap && screenerMarketCap !== undefined);
  const sources = mergeSources(quote, extra);
  if (keepScreenerMarketCap) {
    if (quote.sources?.marketCap) sources.marketCap = quote.sources.marketCap;
    else delete sources.marketCap;
  }
  const fieldObservations: EnrichmentFieldObservations = {
    ...(quote.fieldObservations ?? {}),
    ...(extra.fieldObservations ?? {})
  };
  if (keepScreenerMarketCap) {
    if (quote.fieldObservations?.marketCap) fieldObservations.marketCap = quote.fieldObservations.marketCap;
    else delete fieldObservations.marketCap;
  }
  const paperChoice = policy?.active
    ? choosePaperPrice(
        [
          {
            price: extra.price,
            asOf: extra.asOf,
            provider: extra.sources?.price,
            expectedDelaySec: extra.expectedDelaySec,
            venuePriceAuthoritative: extra.venuePriceAuthoritative,
            bid: extra.bid,
            ask: extra.ask
          },
          {
            price: quote.price,
            asOf: quote.asOf,
            provider: quote.provider,
            expectedDelaySec: quote.expectedDelaySec,
            venuePriceAuthoritative: quote.venuePriceAuthoritative,
            bid: quote.bid,
            ask: quote.ask
          }
        ],
        policy
      )
    : undefined;
  const paperWithheld = Boolean(paperChoice && (paperChoice.withheld || paperChoice.price === undefined));
  const price = paperChoice
    ? paperWithheld
      ? 0
      : paperChoice.price ?? 0
    : extra.price && extra.price > 0
      ? extra.price
      : quote.price;
  const bid = paperChoice ? (paperWithheld ? undefined : paperChoice.bid) : enrichmentBid ? extra.bid : quote.bid;
  const ask = paperChoice ? (paperWithheld ? undefined : paperChoice.ask) : enrichmentAsk ? extra.ask : quote.ask;
  const asOf = paperChoice ? paperChoice.asOf : extra.asOf ?? quote.asOf;
  const priceDelayLabel = paperChoice ? paperChoice.priceDelayLabel : quote.priceDelayLabel;
  const syntheticBidResolved = paperChoice
    ? paperWithheld
      ? false
      : enrichmentBid && paperChoice.bid === extra.bid
        ? false
        : quote.syntheticBid
    : enrichmentBid
      ? false
      : quote.syntheticBid;
  const syntheticAskResolved = paperChoice
    ? paperWithheld
      ? false
      : enrichmentAsk && paperChoice.ask === extra.ask
        ? false
        : quote.syntheticAsk
    : enrichmentAsk
      ? false
      : quote.syntheticAsk;
  return {
    ...quote,
    price,
    bid,
    ask,
    bidSize: extra.bidSize && extra.bidSize > 0 ? extra.bidSize : quote.bidSize,
    askSize: extra.askSize && extra.askSize > 0 ? extra.askSize : quote.askSize,
    prevClose: extra.prevClose && extra.prevClose > 0 ? extra.prevClose : quote.prevClose,
    open: extra.open && extra.open > 0 ? extra.open : quote.open,
    high: extra.high && extra.high > 0 ? extra.high : quote.high,
    low: extra.low && extra.low > 0 ? extra.low : quote.low,
    netChange: typeof extra.netChange === "number" ? extra.netChange : quote.netChange,
    // Enrichment providers supply REAL bid/ask (exchange/broker); clear the synthetic flag when they
    // override a side. When enrichment doesn't provide bid/ask, the original flag is preserved by spread.
    syntheticBid: syntheticBidResolved,
    syntheticAsk: syntheticAskResolved,
    intradayChangePct: typeof extra.intradayChangePct === "number" ? extra.intradayChangePct : quote.intradayChangePct,
    vwap: extra.vwap && extra.vwap > 0 ? extra.vwap : quote.vwap,
    asOf,
    priceDelayLabel,
    // DELAYED-TAPE METADATA: a `delayed_sip` enrichment (Alpaca PAPER) must be
    // aged with the delayed-tape rules, not the realtime-stale bar — otherwise
    // a healthy ~900s-old print is treated as a stale realtime quote and every
    // scan row fails the staleness gate.
    expectedDelaySec: extra.expectedDelaySec ?? quote.expectedDelaySec,
    delayToleranceSec: extra.delayToleranceSec ?? quote.delayToleranceSec,
    venuePriceAuthoritative: extra.venuePriceAuthoritative ?? quote.venuePriceAuthoritative,
    // A delayed tape ages by its RETRIEVAL stamp; a realtime quote keeps the
    // observation time as its freshness signal (undefined here → unchanged).
    fetchedAt: extra.fetchedAt ?? quote.fetchedAt,
    companyName: extra.companyName ?? quote.companyName,
    sentiment: extra.sentiment ?? quote.sentiment,
    peRatio: extra.peRatio ?? quote.peRatio,
    headlines: extra.headlines ?? quote.headlines,
    analystRating: extra.analystRating ?? quote.analystRating,
    analystScore: extra.analystScore ?? quote.analystScore,
    analystBySource: extra.analystBySource ?? quote.analystBySource,
    sector: extra.sector ?? quote.sector,
    industry: extra.industry ?? quote.industry,
    volume: extra.volume && extra.volume > 0 ? extra.volume : quote.volume,
    marketCap: keepScreenerMarketCap
      ? screenerMarketCap
      : extra.marketCap && extra.marketCap > 0
        ? extra.marketCap
        : quote.marketCap,
    dividendYield: extra.dividendYield ?? quote.dividendYield,
    eps: extra.eps ?? quote.eps,
    sharesOutstanding: extra.sharesOutstanding ?? quote.sharesOutstanding,
    pbRatio: extra.pbRatio ?? quote.pbRatio,
    shortPercentOfFloat: extra.shortPercentOfFloat ?? quote.shortPercentOfFloat,
    beta: extra.beta ?? quote.beta,
    fiftyTwoWeekHigh: extra.fiftyTwoWeekHigh ?? quote.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: extra.fiftyTwoWeekLow ?? quote.fiftyTwoWeekLow,
    insiderSentiment: extra.insiderSentiment ?? quote.insiderSentiment,
    fcfYield: extra.fcfYield ?? extra.freeCashFlowYield ?? quote.fcfYield ?? quote.freeCashFlowYield,
    debtToEquity: extra.debtToEquity ?? quote.debtToEquity,
    epsGrowth: extra.epsGrowth ?? quote.epsGrowth,
    senateTrades: extra.senateTrades ?? quote.senateTrades,
    daysToEarnings: extra.daysToEarnings ?? quote.daysToEarnings,
    institutionOwnershipPct: extra.institutionOwnershipPct ?? quote.institutionOwnershipPct,
    nearTheMoneyIv: extra.nearTheMoneyIv ?? quote.nearTheMoneyIv,
    putCallRatio: extra.putCallRatio ?? quote.putCallRatio,
    targetMean: extra.targetMean ?? quote.targetMean,
    targetHigh: extra.targetHigh ?? quote.targetHigh,
    targetLow: extra.targetLow ?? quote.targetLow,
    targetMedian: extra.targetMedian ?? quote.targetMedian,
    returnOnEquity: extra.returnOnEquity ?? quote.returnOnEquity,
    returnOnAssets: extra.returnOnAssets ?? quote.returnOnAssets,
    revenueGrowth: extra.revenueGrowth ?? quote.revenueGrowth,
    freeCashFlowYield: extra.freeCashFlowYield ?? extra.fcfYield ?? quote.freeCashFlowYield ?? quote.fcfYield,
    grossProfitMargin: extra.grossProfitMargin ?? quote.grossProfitMargin,
    congressTradesQuiver: extra.congressTradesQuiver ?? quote.congressTradesQuiver,
    insiderTradesQuiver: extra.insiderTradesQuiver ?? quote.insiderTradesQuiver,
    govContractsQuiver: extra.govContractsQuiver ?? quote.govContractsQuiver,
    lobbyingQuiver: extra.lobbyingQuiver ?? quote.lobbyingQuiver,
    patentsQuiver: extra.patentsQuiver ?? quote.patentsQuiver,
    // Surface the cascade's short-interest cross-check (primary vs the Massive second source) as an
    // evidence bulletin so the dashboard/prompt see a single-source short read isn't corroborated.
    evidenceBulletins: extra.shortInterestDisagreement
      ? Array.from(new Set([...(quote.evidenceBulletins ?? []), extra.shortInterestDisagreement]))
      : quote.evidenceBulletins,
    sources,
    // Keep cascade receipts on the quote so admin/ops/coverage reporting (and drilldowns) can see
    // which providers failed and the per-field observation status — not only the winning scalar.
    // MERGE observations field-by-field so a live enrich layer does not wipe per-field as_of/
    // fetched_at stamps from the durable seed baseline for fields the live pass left empty.
    // A kept screener market cap drops the SEC observation so the receipt matches the scalar.
    fieldObservations,
    providerFailures: extra.providerFailures
      ? { ...(quote.providerFailures ?? {}), ...extra.providerFailures }
      : quote.providerFailures
  };
}

// Combine enrichment-supplied field sources with screener-supplied ones so each
// displayed cell can name the single provider its value came from.
function mergeSources(quote: MarketQuote, extra: SymbolEnrichment): EnrichmentSources {
  const sources: EnrichmentSources = { ...(extra.sources ?? {}) };
  // Preserve the ORIGINAL quote's price-family provenance (incl. the "yahoo-finance-synthetic"
  // bid/ask tag from the quote-only fallback) whenever enrichment did NOT override that value —
  // applyEnrichment only takes extra.{price,bid,ask,volume} when they are > 0. Losing this tag
  // here would make a synthesized spread look like a real quoted ask to downstream limit-price math.
  const carryPriceFamilySource = (field: "price" | "bid" | "ask" | "volume", extraValue: number | undefined) => {
    const overrode = typeof extraValue === "number" && extraValue > 0;
    if (!overrode && !sources[field] && quote.sources?.[field]) sources[field] = quote.sources[field];
  };
  carryPriceFamilySource("price", extra.price);
  carryPriceFamilySource("bid", extra.bid);
  carryPriceFamilySource("ask", extra.ask);
  carryPriceFamilySource("volume", extra.volume);
  // Fields the screener supplies when enrichment didn't override them.
  if (!sources.companyName && extra.companyName === undefined && quote.companyName) {
    sources.companyName = nasdaqDelayedProvider.name;
  }
  if (!sources.sector && extra.sector === undefined && quote.sector) sources.sector = nasdaqDelayedProvider.name;
  if (!sources.industry && extra.industry === undefined && quote.industry) sources.industry = nasdaqDelayedProvider.name;
  return sources;
}

function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const sanitized = {
    liquidity: safeWeight(weights.liquidity),
    momentum: safeWeight(weights.momentum),
    value: safeWeight(weights.value),
    quality: safeWeight(weights.quality),
    volatility: safeWeight(weights.volatility),
    sentiment: safeWeight(weights.sentiment),
    positioning: safeWeight(weights.positioning),
    diversification: safeWeight(weights.diversification)
  };
  const total = Object.values(sanitized).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return normalizeWeights(DEFAULT_SCORING_WEIGHTS);
  return {
    liquidity: sanitized.liquidity / total,
    momentum: sanitized.momentum / total,
    value: sanitized.value / total,
    quality: sanitized.quality / total,
    volatility: sanitized.volatility / total,
    sentiment: sanitized.sentiment / total,
    positioning: sanitized.positioning / total,
    diversification: sanitized.diversification / total
  };
}

/**
 * Four-bucket attribution of a quote's deterministic factor scores for the proposal scorecard
 * (ProposalScorecard.signalAttribution): liquidity+momentum → technical, sentiment → news,
 * value+quality → fundamentals, positioning+volatility+diversification → market. Same
 * safeWeight idiom as normalizeWeights; normalized to INTEGERS summing to exactly 100 via
 * largest-remainder rounding. Returns undefined when the quote carries no factor breakdown or
 * every bucket is zero — the attribution block is omitted, never fabricated.
 */
export function computeSignalAttribution(
  quote: Pick<MarketQuote, "factorBreakdown">
): { technical: number; news: number; fundamentals: number; market: number } | undefined {
  const factors = quote.factorBreakdown;
  if (!factors) return undefined;
  const buckets = [
    safeWeight(factors.liquidity) + safeWeight(factors.momentum), // technical
    safeWeight(factors.sentiment), // news
    safeWeight(factors.value) + safeWeight(factors.quality), // fundamentals
    safeWeight(factors.positioning) + safeWeight(factors.volatility) + safeWeight(factors.diversification) // market
  ];
  const total = buckets.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return undefined;
  const raw = buckets.map((value) => (value / total) * 100);
  const floors = raw.map(Math.floor);
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  // Largest fractional remainders absorb the leftover points (index breaks ties deterministically).
  const order = raw
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return { technical: floors[0], news: floors[1], fundamentals: floors[2], market: floors[3] };
}

type ExtendedFactorQuote = MarketQuote & {
  avgVolume20d?: number;
  averageVolume20d?: number;
  avgVol20d?: number;
  return5d?: number;
  return20d?: number;
  return60d?: number;
  return126d?: number;
  roc5d?: number;
  roc20d?: number;
  roc60d?: number;
  roc126d?: number;
  realizedVol20d?: number;
  realizedVol60d?: number;
  realizedVolPct?: number;
  atrPct?: number;
  atr14?: number;
  earnYld?: number;
  earningsYield?: number;
  sentimentDated?: boolean;
  portfolioSectors?: ScoreFactorsContext["portfolioSectors"];
};

function liquidityScore(quote: MarketQuote): number {
  const ext = quote as ExtendedFactorQuote;
  const volOrAvg20d =
    typeof ext.avgVolume20d === "number" && ext.avgVolume20d > 0
      ? ext.avgVolume20d
      : typeof ext.averageVolume20d === "number" && ext.averageVolume20d > 0
        ? ext.averageVolume20d
        : typeof ext.avgVol20d === "number" && ext.avgVol20d > 0
          ? ext.avgVol20d
          : quote.volume;
  if (volOrAvg20d > 0) {
    const effectivePrice = typeof quote.price === "number" && quote.price > 0 ? quote.price : 1;
    const dollarVolume = effectivePrice * volOrAvg20d;
    // Map log10(price * volumeOrAvgVol20d) across [$100k (10^5) .. $1B (10^9)] onto [0, 100]
    return clamp(((Math.log10(Math.max(dollarVolume, 1)) - 5) / 4) * 100);
  }
  if (quote.marketCap && quote.marketCap > 0) return clamp(((Math.log10(quote.marketCap) - 8) / 4) * 100);
  return 35;
}

/** Position within the trailing 52-week range, 0 (at the low) … 100 (at the high). */
export function pricePosition52w(quote: MarketQuote): number | undefined {
  const { fiftyTwoWeekHigh: hi, fiftyTwoWeekLow: lo, price } = quote;
  if (typeof hi !== "number" || typeof lo !== "number" || hi <= lo) return undefined;
  return Math.round(clamp(((price - lo) / (hi - lo)) * 100));
}

/**
 * Intraday momentum: map intradayChangePct onto [0,100] using tanh over a ±20% range
 * instead of the prior saturating linear ±5% window. The old formula
 * `((pct + 5) / 10) * 100` capped at 100 for anything ≥ +5%, making a +6% gap-up
 * and a +25% short-squeeze indistinguishable. tanh(x/10) (where x is the pct value)
 * stays sensitive well past ±10%: +5%→73, +10%→88, +20%→97 — preserving meaningful
 * differentiation across the full realistic intraday range.
 */
function intradayMomentum(pct: number): number {
  // tanh maps ℝ → (-1, 1); shift+scale to [0, 100].
  return (Math.tanh(pct / 10) + 1) * 50;
}

function multiHorizonTrendScore(quote: MarketQuote): number | undefined {
  const ext = quote as ExtendedFactorQuote;
  const r20 = ext.return20d ?? ext.roc20d;
  const r60 = ext.return60d ?? ext.roc60d;
  const r126 = ext.return126d ?? ext.roc126d;
  const r5 = ext.return5d ?? ext.roc5d;

  const horizons: Array<{ val: number; weight: number; scale: number }> = [];
  if (typeof r20 === "number" && Number.isFinite(r20)) horizons.push({ val: r20, weight: 0.35, scale: 15 });
  if (typeof r60 === "number" && Number.isFinite(r60)) horizons.push({ val: r60, weight: 0.35, scale: 25 });
  if (typeof r126 === "number" && Number.isFinite(r126)) horizons.push({ val: r126, weight: 0.30, scale: 40 });

  if (horizons.length === 0) return undefined;
  const totalWeight = horizons.reduce((sum, h) => sum + h.weight, 0);
  let compositeSignal = horizons.reduce((sum, h) => sum + (Math.tanh(h.val / h.scale) * 50) * (h.weight / totalWeight), 0);

  // Subtract 5d short-term reversal penalty/boost (mean-reversion over 1 week)
  if (typeof r5 === "number" && Number.isFinite(r5)) {
    compositeSignal -= Math.tanh(r5 / 8) * 15;
  } else if (Number.isFinite(quote.intradayChangePct)) {
    // Dampen pure 1-day chase when multi-horizon history is present
    compositeSignal -= Math.tanh(quote.intradayChangePct / 10) * 5;
  }
  return clamp(50 + compositeSignal);
}

function momentumScore(quote: MarketQuote): number {
  const multiHorizon = multiHorizonTrendScore(quote);
  const pos = pricePosition52w(quote);
  const hasTech = typeof quote.technicalScore === "number";

  if (multiHorizon !== undefined) {
    let base = multiHorizon;
    if (typeof pos === "number") {
      base = base * 0.8 + pos * 0.2;
    }
    if (hasTech) {
      return clamp(base * 0.65 + quote.technicalScore! * 0.35);
    }
    return clamp(base);
  }

  // Graceful fallback when 20d/60d/126d history is unavailable:
  // Avoid pure 1-day intraday chase by prioritizing 52-week trend and technicalScore when present,
  // and damping 1-day intraday spikes.
  const intraday = intradayMomentum(quote.intradayChangePct);
  if (typeof pos === "number" && hasTech) {
    return clamp(quote.technicalScore! * 0.5 + pos * 0.35 + intraday * 0.15);
  }
  if (hasTech) {
    return clamp(quote.technicalScore! * 0.65 + intraday * 0.35);
  }
  if (typeof pos === "number") {
    return clamp(pos * 0.65 + intraday * 0.35);
  }
  return clamp(intraday);
}

function volatilityScore(quote: MarketQuote): number {
  // Higher = steadier (less realized + systematic volatility).
  // Prefer 20d/60d annualized realized volatility (%) or daily ATR% over 1-day intraday move.
  const ext = quote as ExtendedFactorQuote;
  const rv20 = typeof ext.realizedVol20d === "number" && ext.realizedVol20d > 0 ? ext.realizedVol20d : undefined;
  const rv60 = typeof ext.realizedVol60d === "number" && ext.realizedVol60d > 0 ? ext.realizedVol60d : undefined;
  const rvGeneric = typeof ext.realizedVolPct === "number" && ext.realizedVolPct > 0 ? ext.realizedVolPct : undefined;
  const atrPct =
    typeof ext.atrPct === "number" && ext.atrPct > 0
      ? ext.atrPct
      : typeof ext.atr14 === "number" && ext.atr14 > 0 && quote.price > 0
        ? (ext.atr14 / quote.price) * 100
        : undefined;

  let base: number;
  if (rv20 !== undefined || rv60 !== undefined || rvGeneric !== undefined || atrPct !== undefined) {
    // Convert ATR% (daily range %) to annualized vol equivalent (~√252 ≈ 15.87) if realizedVol is absent
    const effectiveAnnualVol =
      rv20 !== undefined && rv60 !== undefined
        ? rv20 * 0.6 + rv60 * 0.4
        : rv20 ?? rv60 ?? rvGeneric ?? (atrPct! * 15.87);
    // Annualized vol 15% -> ~85, 30% -> ~65, 50% -> ~38, 80%+ -> ~0
    base = 105 - effectiveAnnualVol * 1.33;
    if (atrPct !== undefined && (rv20 !== undefined || rv60 !== undefined || rvGeneric !== undefined)) {
      const atrScore = 105 - atrPct * 18;
      base = base * 0.75 + atrScore * 0.25;
    }
  } else if (
    typeof quote.fiftyTwoWeekHigh === "number" &&
    typeof quote.fiftyTwoWeekLow === "number" &&
    quote.fiftyTwoWeekHigh > quote.fiftyTwoWeekLow &&
    quote.fiftyTwoWeekLow > 0
  ) {
    // 52w range proxy for 60d/annualized volatility when bars are not attached to the quote
    const rangeRatio = (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow) / ((quote.fiftyTwoWeekHigh + quote.fiftyTwoWeekLow) / 2);
    const rangeBase = 95 - rangeRatio * 55;
    const intradayPenalty = Math.abs(quote.intradayChangePct) * 3;
    base = rangeBase - intradayPenalty;
  } else {
    base = 85 - Math.abs(quote.intradayChangePct) * 6;
  }

  if (typeof quote.beta === "number" && quote.beta > 0) {
    if (quote.beta > 1.5) base -= 15;
    else if (quote.beta > 1.1) base -= 6;
    else if (quote.beta < 0.8) base += 6;
  }
  return clamp(base);
}

function sentimentScore(quote: MarketQuote): number {
  const rawSentiment = typeof quote.sentiment === "number" && Number.isFinite(quote.sentiment) ? quote.sentiment : undefined;
  const analyst = typeof quote.analystScore === "number" && Number.isFinite(quote.analystScore) ? quote.analystScore : undefined;
  if (rawSentiment === undefined && analyst === undefined) return 50;

  const ext = quote as ExtendedFactorQuote;
  const sentimentObs = quote.fieldObservations?.sentiment ?? quote.fieldObservations?.headlines;
  const hasDatedTimestamp =
    ext.sentimentDated === true ||
    Boolean(sentimentObs?.asOf && sentimentObs.asOf !== sentimentObs.fetchedAt);
  // Undated headline keyword sentiment is downweighted from 0.6 -> 0.2.
  const hasHeadlineArray = Array.isArray(quote.headlines) && quote.headlines.length > 0;
  const isUndatedHeadline = (hasHeadlineArray || ext.sentimentDated === false) && !hasDatedTimestamp;
  const headlineWeight = isUndatedHeadline ? 0.2 : 0.6;

  if (rawSentiment !== undefined && analyst !== undefined) {
    return clamp(50 + (rawSentiment - 50) * headlineWeight + (analyst - 50) * (1 - headlineWeight));
  }
  if (rawSentiment !== undefined) {
    if (isUndatedHeadline) {
      return clamp(50 + (rawSentiment - 50) * 0.2);
    }
    return clamp(rawSentiment);
  }
  return clamp(50 + (analyst! - 50) * 0.6);
}

function diversificationScore(quote: MarketQuote, context?: ScoreFactorsContext): number {
  if (quote.positionMarketValue > 0) return 45;
  const ext = quote as ExtendedFactorQuote;
  const rawSectors = context?.portfolioSectors ?? ext.portfolioSectors;
  if (!rawSectors || !quote.sector) return 80;

  const targetSector = quote.sector.trim().toLowerCase();
  if (!targetSector) return 80;

  let sectorShare = 0;
  let hasPortfolioData = false;

  if (Array.isArray(rawSectors)) {
    if (rawSectors.length === 0) return 80;
    let totalWeight = 0;
    let matchWeight = 0;
    for (const item of rawSectors) {
      if (typeof item === "string") {
        const s = item.trim().toLowerCase();
        if (!s) continue;
        totalWeight += 1;
        if (s === targetSector) matchWeight += 1;
      } else if (item && typeof item === "object") {
        const s = item.sector?.trim().toLowerCase();
        const w = typeof item.marketValue === "number" && item.marketValue > 0 ? item.marketValue : 1;
        if (!s) continue;
        totalWeight += w;
        if (s === targetSector) matchWeight += w;
      }
    }
    if (totalWeight > 0) {
      hasPortfolioData = true;
      sectorShare = matchWeight / totalWeight;
    }
  } else if (typeof rawSectors === "object") {
    const entries = Object.entries(rawSectors).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0);
    if (entries.length === 0) return 80;
    hasPortfolioData = true;
    const total = entries.reduce((sum, [, v]) => sum + v, 0);
    const matched = entries.find(([k]) => k.trim().toLowerCase() === targetSector)?.[1] ?? 0;
    // Handle both fractional shares (summing to <= 1.05) and percentage/dollar maps
    sectorShare = total > 1.05 ? matched / total : matched;
  }

  if (!hasPortfolioData) return 80;
  if (sectorShare <= 0) return 85; // Bonus for adding a brand-new unrepresented sector
  // Penalize linearly with existing sector concentration: 25% share -> ~64, 50% share -> ~48, 100% -> 25
  return clamp(Math.round(80 - sectorShare * 65));
}

/**
 * Smart-money positioning sub-score (50 = neutral when no signal). Lifts names with
 * net congressional buying / insider open-market buying / squeeze-level short interest,
 * and dings net selling — so the scraped signals influence the deterministic ranking,
 * not just the LLM prompt. Populated from the web-source overlay (see scanMarket), so
 * the score is recomputed AFTER the overlay there.
 */
function congressPositioningDelta(quote: MarketQuote): number | null {
  const rawField = (quote as unknown as {
    congressCompositeScore?: number | {
      score?: number;
      signedScore?: number;
      direction?: "BUY" | "SELL" | "NEUTRAL";
      confidence?: number;
    };
  }).congressCompositeScore;

  const isObj = typeof rawField === "object" && rawField !== null;
  const direction = isObj ? rawField.direction : quote.congressCompositeDirection;
  const confidence = isObj ? rawField.confidence : quote.congressCompositeConfidence;
  const rawSigned = isObj
    ? (rawField.signedScore ??
      (typeof rawField.score === "number" && Number.isFinite(rawField.score)
        ? (direction === "SELL" ? -Math.abs(rawField.score) : direction === "BUY" ? Math.abs(rawField.score) : undefined)
        : undefined))
    : (quote.congressCompositeSignedScore ??
      (typeof rawField === "number" && Number.isFinite(rawField)
        ? (direction === "SELL" ? -Math.abs(rawField) : direction === "BUY" ? Math.abs(rawField) : undefined)
        : undefined));

  if (typeof rawSigned !== "number" || !Number.isFinite(rawSigned) || rawSigned === 0) {
    return null;
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || !(confidence > 0)) {
    return null;
  }
  const effectiveDirection = direction ?? (rawSigned > 0 ? "BUY" : "SELL");
  if (effectiveDirection === "NEUTRAL") return null;

  const reconciledSigned = effectiveDirection === "BUY" ? Math.abs(rawSigned) : -Math.abs(rawSigned);
  return Math.round(Math.max(-18, Math.min(18, reconciledSigned * 0.18)));
}

function positioningScore(quote: MarketQuote): number {
  let base = 50;
  const congressDelta = congressPositioningDelta(quote);
  if (congressDelta !== null) {
    base += congressDelta;
  } else if (typeof quote.senateTrades === "number" && quote.senateTrades !== 0) {
    // Fallback when congressCompositeScore is absent: net distinct congressional buy members minus sell members.
    base += quote.senateTrades > 0
      ? Math.min(18, 8 + (quote.senateTrades - 1) * 5)
      : -Math.min(18, 8 + (-quote.senateTrades - 1) * 5);
  }
  if (typeof quote.insiderSentiment === "number") {
    // 0–100 open-market Form 4 buy share (50 = balanced).
    if (quote.insiderSentiment >= 70) base += 12;
    else if (quote.insiderSentiment >= 60) base += 6;
    else if (quote.insiderSentiment <= 30) base -= 12;
    else if (quote.insiderSentiment <= 40) base -= 6;
  }
  if (typeof quote.shortPercentOfFloat === "number" && quote.shortPercentOfFloat >= 20) {
    base += 5; // squeeze potential (two-sided, so a small contribution only)
  }
  return clamp(base);
}

function valueScore(quote: MarketQuote): number {
  // Return neutral 50 when valuation is missing rather than a mega-cap marketCap proxy (`marketCap >= 5B ? 65`).
  const ext = quote as ExtendedFactorQuote;
  let base = 50;
  let hasPrimaryValuation = false;

  const earnYld =
    typeof ext.earnYld === "number" && Number.isFinite(ext.earnYld)
      ? ext.earnYld
      : typeof ext.earningsYield === "number" && Number.isFinite(ext.earningsYield)
        ? ext.earningsYield
        : typeof quote.eps === "number" && Number.isFinite(quote.eps) && quote.price > 0
          ? (quote.eps / quote.price) * 100
          : undefined;

  if (quote.peRatio && quote.peRatio > 0) {
    base = quote.peRatio <= 15 ? 78 : quote.peRatio <= 25 ? 64 : quote.peRatio <= 40 ? 50 : 36;
    hasPrimaryValuation = true;
  } else if (earnYld !== undefined) {
    base = earnYld >= 7 ? 78 : earnYld >= 4 ? 64 : earnYld >= 2.5 ? 50 : earnYld >= 0 ? 36 : 25;
    hasPrimaryValuation = true;
  }

  // Price-to-book ratio
  if (typeof quote.pbRatio === "number" && quote.pbRatio > 0) {
    if (!hasPrimaryValuation) {
      base = quote.pbRatio <= 1.5 ? 72 : quote.pbRatio <= 3 ? 60 : quote.pbRatio <= 6 ? 50 : 38;
      hasPrimaryValuation = true;
    } else {
      if (quote.pbRatio <= 1.5) base += 8;
      else if (quote.pbRatio <= 3) base += 4;
      else if (quote.pbRatio > 8) base -= 6;
    }
  }

  // Earnings yield bonus/penalty when P/E was already used or negative earnings yield
  if (earnYld !== undefined && quote.peRatio && quote.peRatio > 0) {
    if (earnYld >= 8) base += 6;
    else if (earnYld < 0) base -= 10;
  }

  // Free-cash-flow yield is a real value signal independent of earnings multiples.
  const fcf = quote.fcfYield ?? quote.freeCashFlowYield;
  if (typeof fcf === "number" && Number.isFinite(fcf)) {
    if (fcf >= 6) base += 12;
    else if (fcf >= 3) base += 6;
    else if (fcf < 0) base -= 8;
  }

  // Analyst consensus targetMean upside
  if (typeof quote.targetMean === "number" && quote.targetMean > 0 && quote.price > 0) {
    const upsidePct = ((quote.targetMean - quote.price) / quote.price) * 100;
    if (upsidePct >= 25) base += 10;
    else if (upsidePct >= 10) base += 5;
    else if (upsidePct <= -10) base -= 8;
  }

  return clamp(base);
}

function qualityScore(quote: MarketQuote): number {
  // Neutral 50 baseline rather than mega-cap marketCap/volume size proxy.
  let base = 50;

  // Return on equity, gross margin and revenue growth arrive in PERCENTAGE POINTS (12.34 = 12.34%):
  // every provider normalizes them (simfin-provider.ts, normalizePercent in data-providers.ts).
  // Do not re-guess fractions here; a genuine 0.5% would be misread as 50%.
  if (typeof quote.returnOnEquity === "number" && Number.isFinite(quote.returnOnEquity)) {
    const roePct = quote.returnOnEquity;
    if (roePct >= 20) base += 14;
    else if (roePct >= 12) base += 8;
    else if (roePct >= 5) base += 3;
    else if (roePct < 0) base -= 12;
  }

  // Gross profit margin (percentage points)
  if (typeof quote.grossProfitMargin === "number" && Number.isFinite(quote.grossProfitMargin)) {
    const gpmPct = quote.grossProfitMargin;
    if (gpmPct >= 50) base += 10;
    else if (gpmPct >= 30) base += 5;
    else if (gpmPct < 15) base -= 8;
  }

  // Revenue growth (percentage points YoY, e.g. 15 = +15%)
  if (typeof quote.revenueGrowth === "number" && Number.isFinite(quote.revenueGrowth)) {
    const revGrowthFrac = quote.revenueGrowth / 100;
    if (revGrowthFrac >= 0.15) base += 8;
    else if (revGrowthFrac >= 0.05) base += 4;
    else if (revGrowthFrac < -0.05) base -= 8;
  }

  // Leverage: lower debt/equity = higher quality. Providers report D/E as a ratio
  // (1.5) or a percentage (150); normalize to a ratio before bucketing. The `>10 → ÷100`
  // heuristic is SOURCE-AWARE: sec-xbrl always emits a true ratio (a genuine 12x must stay 12,
  // not become 0.12 and wrongly score as near-debt-free), so the heuristic is skipped for it.
  if (typeof quote.debtToEquity === "number") {
    const deFromRatioSource = quote.sources?.debtToEquity === "sec-xbrl";
    const de = !deFromRatioSource && quote.debtToEquity > 10 ? quote.debtToEquity / 100 : quote.debtToEquity;
    if (de >= 0 && de <= 0.5) base += 10;
    else if (de <= 1.5) base += 3;
    else if (de > 3) base -= 10;
  }

  // Earnings growth (fractional YoY, e.g. 0.15 = +15%) is a durability signal.
  if (typeof quote.epsGrowth === "number") {
    if (quote.epsGrowth >= 0.15) base += 8;
    else if (quote.epsGrowth > 0) base += 3;
    else if (quote.epsGrowth < -0.1) base -= 8;
  }
  return clamp(base);
}

function sectorBySymbol(quotes: MarketQuote[]): Record<string, string> {
  return Object.fromEntries(
    quotes
      .filter((quote) => quote.sector)
      .map((quote) => [quote.symbol, quote.sector!] as const)
  );
}

export function quotesBySymbol(quotes: MarketQuote[]): Record<string, MarketQuoteSummary> {
  return Object.fromEntries(
    quotes.map((quote) => [
      quote.symbol,
      {
        symbol: quote.symbol,
        companyName: quote.companyName,
        price: quote.price,
        vwap: quote.vwap,
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
        prevClose: quote.prevClose,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        netChange: quote.netChange,
        delayedFallback: quote.delayedFallback,
        sector: quote.sector,
        industry: quote.industry,
        score: quote.score,
        provider: quote.provider,
        asOf: quote.asOf,
        priceDelayLabel: quote.priceDelayLabel,
        expectedDelaySec: quote.expectedDelaySec,
        delayToleranceSec: quote.delayToleranceSec,
        venuePriceAuthoritative: quote.venuePriceAuthoritative,
        fetchedAt: quote.fetchedAt,
        sentiment: quote.sentiment,
        peRatio: quote.peRatio,
        analystRating: quote.analystRating,
        analystScore: quote.analystScore,
        analystBySource: quote.analystBySource,
        dividendYield: quote.dividendYield,
        eps: quote.eps,
        sharesOutstanding: quote.sharesOutstanding,
        marketCap: quote.marketCap,
        pbRatio: quote.pbRatio,
        shortPercentOfFloat: quote.shortPercentOfFloat,
        beta: quote.beta,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
        insiderSentiment: quote.insiderSentiment,
        fcfYield: quote.fcfYield ?? quote.freeCashFlowYield,
        debtToEquity: quote.debtToEquity,
        epsGrowth: quote.epsGrowth,
        senateTrades: quote.senateTrades,
        syntheticBid: quote.syntheticBid,
        syntheticAsk: quote.syntheticAsk,
        daysToEarnings: quote.daysToEarnings,
        institutionOwnershipPct: quote.institutionOwnershipPct,
        nearTheMoneyIv: quote.nearTheMoneyIv,
        putCallRatio: quote.putCallRatio,
        targetMean: quote.targetMean,
        targetHigh: quote.targetHigh,
        targetLow: quote.targetLow,
        targetMedian: quote.targetMedian,
        returnOnEquity: quote.returnOnEquity,
        returnOnAssets: quote.returnOnAssets,
        revenueGrowth: quote.revenueGrowth,
        freeCashFlowYield: quote.freeCashFlowYield ?? quote.fcfYield,
        grossProfitMargin: quote.grossProfitMargin,
        congressTradesQuiver: quote.congressTradesQuiver,
        insiderTradesQuiver: quote.insiderTradesQuiver,
        govContractsQuiver: quote.govContractsQuiver,
        lobbyingQuiver: quote.lobbyingQuiver,
        patentsQuiver: quote.patentsQuiver,
        evidenceBulletins: quote.evidenceBulletins,
        factorBreakdown: quote.factorBreakdown,
        headlines: quote.headlines,
        intradayChangePct: quote.intradayChangePct,
        volume: quote.volume > 0 ? quote.volume : undefined,
        sectorRelStrength: quote.sectorRelStrength,
        sources: quote.sources,
        // Per-field as_of / fetched_at — required for durable store re-seed and UI staleness chips.
        fieldObservations: quote.fieldObservations,
        providerFailures: quote.providerFailures
      }
    ])
  );
}

function marketCacheTtlMs(): number {
  const ttl = Number(process.env.MARKET_SCAN_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_CACHE_TTL_MS;
}

function safeWeight(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(value: unknown): number {
  return number(value);
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Strips a trailing "(Representing ...)" ADR/depositary-receipt annotation from the Nasdaq
 *  screener's raw company name ONLY when the placeholder never actually got filled in — e.g.
 *  "Shell Plc ADR (Representing - )" — a screener data-quality artifact, not real information.
 *  A genuinely populated annotation (e.g. "(Representing 2 Ordinary Shares)") is left alone; it's
 *  real, not dirty. Falls back to the original name if stripping would leave nothing. */
function sanitizeCompanyName(name: string | undefined): string | undefined {
  if (!name) return name;
  const cleaned = name.replace(/\s*\(Representing\s*[-–—]*\s*\)\s*$/i, "").trim();
  return cleaned || name;
}
