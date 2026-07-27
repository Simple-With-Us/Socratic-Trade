import { shareScanRefs } from "./congress-share";
import { congressLongScore, scoreCongressSignal } from "./congress-score";
import { getEnrichmentProvider, type SymbolEnrichment } from "./data-providers";
import type { GroupedDailyBar } from "./market-signals/massive";
import { getSymbolWebSignals, setTechnicalWatchlist } from "./web-sources";
import type { SymbolWebSignal } from "./web-sources";
import { clearFundHoldingsCache, fetchBlackRockHoldingSymbols, isBlackRockHoldingUniverse } from "./fund-holdings";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { INDEX_UNIVERSES, isIndexMemberSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import {
  DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "./scan-settings";
import { fetchYahooFinanceQuote, type YahooFinanceQuote } from "./yahoo-finance";
import type {
  EnrichmentSources,
  EquityPosition,
  IndexUniverse,
  MarketDataProvider,
  MarketFactor,
  MarketFactorBreakdown,
  MarketQuote,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights,
  UniverseFloor
} from "./types";

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
    (analytics.topMemberScoreSource === "realized_skill" && (analytics.topMemberScore ?? 0) >= 60);
  return hasSupport ? composite.score : 0;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const NASDAQ_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0";
const DEFAULT_ENRICHMENT_POOL_MULTIPLIER = 5;
const DEFAULT_ENRICHMENT_POOL_CAP = 500;
const MAX_ENRICHMENT_POOL_MULTIPLIER = 10;
const MAX_ENRICHMENT_POOL_CAP = 1_000;

type RawNasdaqRow = Record<string, unknown>;
type NasdaqExchange = "nasdaq" | "nyse";

// Nasdaq screener is a public, unauthenticated endpoint — no user API key is
// consumed, so this single shared cache is safe to serve to all users.
let screenerCache = new Map<string, { expiresAt: number; rows: RawNasdaqRow[]; asOf?: string }>();

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
  candidateLimit: number
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
  const targetSize = Math.min(ranked.length, Math.min(candidateLimit * multiplier, configuredCap));
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

function uniqueQuotesBySymbol(quotes: MarketQuote[]): MarketQuote[] {
  const seen = new Set<string>();
  return quotes.filter((quote) => {
    if (seen.has(quote.symbol)) return false;
    seen.add(quote.symbol);
    return true;
  });
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
    seedEnrichment: scanOptions.seedEnrichment
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
    const warnings: string[] = [];
    let quotes: MarketQuote[] = [];
    let cached = false;
    let breadthPct: number | undefined;
    const universeSources = new Set<string>();

    try {
      const result = await fetchNasdaqScreener(
        options?.ttlMs ?? marketCacheTtlMs(),
        undefined,
        options?.signal
      );
      cached = result.cached;
      const allQuotes = result.rows.flatMap((row) => toMarketQuote(row, positions, this.name, result.asOf));
      quotes = allQuotes.filter((quote) => allowed.has(quote.symbol));

      const dynamicResult = await loadDynamicUniverseQuotes({
        dynamicUniverses,
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
      // Market breadth: % of the full screener that's advancing today — a free,
      // market-wide risk-on/risk-off gauge (computed from data we already fetched).
      const moved = allQuotes.filter((q) => q.intradayChangePct !== 0);
      if (moved.length >= 20) {
        breadthPct = Math.round((moved.filter((q) => q.intradayChangePct > 0).length / moved.length) * 100);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Market data request failed.");
    }

    if (quotes.length === 0 && options?.seedEnrichment) {
      quotes = persistedMarketQuotes(options.seedEnrichment, positions);
      cached = true;
      warnings.push(
        "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
      );
    }

    // Universe floor: drop penny/illiquid index + dynamic-universe candidates before ranking. `allowed`
    // (explicit symbols + held positions) is exempt — never hide a name the user listed or a position to exit.
    quotes = applyUniverseFloor(quotes, allowed, options?.universeFloor);

    const ranked = rankMarketQuotes(quotes, weights).map((quote) => ({ ...quote, cached }));
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
    const provider = options?.enrichmentMode === "skip"
      ? undefined
      : getEnrichmentProvider(options?.userId);
    let rescoredRanked: MarketQuote[] = ranked;
    const preselectionPool = buildEnrichmentPreselectionPool(ranked, eventExtra, heldSymbols, candidateLimit);
    if (preselectionPool.length > 0 && provider) {
      try {
        const enrichment = await provider.enrich(preselectionPool.map((quote) => quote.symbol));
        const rescoredBySymbol = new Map(
          preselectionPool.map((quote) => {
            const enriched = enrichment[quote.symbol] ? applyEnrichment(quote, enrichment[quote.symbol]) : quote;
            const factorBreakdown = scoreFactors(enriched, weights);
            return [quote.symbol, { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal }] as const;
          })
        );
        rescoredRanked = ranked
          .map((quote) => rescoredBySymbol.get(quote.symbol) ?? quote)
          .sort(compareMarketQuotes);
      } catch (error) {
        warnings.push(error instanceof Error ? `Enrichment failed: ${error.message}` : "Enrichment failed.");
      }
    } else if (preselectionPool.length > 0 && options?.seedEnrichment) {
      // Keep slow facts from the last completed strategy scan while the interactive
      // screener replaces current price/change/volume. This gives the table useful
      // fundamentals without any provider fan-out on the HTTP request path.
      const seededBySymbol = new Map(
        preselectionPool.map((quote) => {
          const prior = options.seedEnrichment?.[quote.symbol];
          const enriched = prior
            ? applyEnrichment(quote, persistedSlowEnrichment(prior))
            : quote;
          const factorBreakdown = scoreFactors(enriched, weights);
          return [quote.symbol, { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal }] as const;
        })
      );
      rescoredRanked = ranked
        .map((quote) => seededBySymbol.get(quote.symbol) ?? quote)
        .sort(compareMarketQuotes);
      warnings.push(
        "Slow fundamentals reuse the latest completed strategy scan; current price data was refreshed without starting the deep provider cascade."
      );
    } else if (preselectionPool.length > 0) {
      warnings.push(
        "Deep fundamentals refresh is deferred for this interactive scan; open a ticker for on-demand data or use the latest strategy scan for the fully enriched snapshot."
      );
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
      const factorBreakdown = scoreFactors(overlaid, weights);
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

    // Record the candidate set as the technical watchlist so the in-house "computed"
    // producer (TECHNICAL_SOURCE=computed) knows which names to pull OHLC for next refresh.
    // Cheap local write; a no-op consumer in TradingView push mode.
    if (topCandidates.length > 0) {
      try {
        setTechnicalWatchlist(topCandidates.map((quote) => quote.symbol));
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

    return {
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
      warnings
    };
  }
};

export function rankMarketQuotes(quotes: MarketQuote[], weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): MarketQuote[] {
  return quotes
    .map((quote) => {
      const factorBreakdown = scoreFactors(quote, weights);
      return { ...quote, factorBreakdown, score: factorBreakdown.weightedTotal };
    })
    .sort(compareMarketQuotes);
}

/** Select only fields that remain useful across a short-lived interactive refresh.
 * Price, spread, change, volume, VWAP, and timestamps must always come from the
 * fresh scan/broker path, never from the persisted strategy snapshot. */
export function persistedSlowEnrichment(quote: MarketQuoteSummary): SymbolEnrichment {
  const slowSourceFields = new Set([
    "companyName", "peRatio", "analystRating", "sector", "industry",
    "dividendYield", "eps", "pbRatio", "shortPercentOfFloat", "beta",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fcfYield", "debtToEquity",
    "epsGrowth", "institutionOwnershipPct", "targetMean", "targetHigh",
    "targetLow", "targetMedian", "returnOnEquity", "returnOnAssets",
    "revenueGrowth", "freeCashFlowYield", "grossProfitMargin"
  ]);
  const sources = Object.fromEntries(
    Object.entries(quote.sources ?? {}).filter(([field]) => slowSourceFields.has(field))
  ) as SymbolEnrichment["sources"];
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
    sources
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
      stale: true,
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

export function scoreFactors(quote: MarketQuote, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): MarketFactorBreakdown {
  const factors: Record<MarketFactor, number> = {
    liquidity: liquidityScore(quote),
    momentum: momentumScore(quote),
    value: valueScore(quote),
    quality: qualityScore(quote),
    volatility: volatilityScore(quote),
    sentiment: clamp(quote.sentiment ?? 50),
    positioning: positioningScore(quote),
    diversification: quote.positionMarketValue > 0 ? 45 : 80
  };
  const normalized = normalizeWeights(weights);
  const weightedTotal = (Object.keys(factors) as MarketFactor[]).reduce(
    (sum, factor) => sum + factors[factor] * normalized[factor],
    0
  );
  return { ...factors, weightedTotal: Math.round(weightedTotal * 100) / 100 };
}

export function mergeQuoteData(
  scan: MarketScan,
  quoteData: Record<string, { bid?: number; ask?: number; price?: number; volume?: number; asOf?: string; provider?: string; syntheticSpread?: boolean; syntheticBid?: boolean; syntheticAsk?: boolean }>
): MarketScan {
  // When a merge accepts a real broker bid/ask/price/volume, refresh THAT field's provenance too.
  // Otherwise a "yahoo-finance-synthetic" tag from the quote-only fallback (toQuoteOnlyMarketQuote)
  // would stick even after a real broker spread is merged in, making a genuine ask look synthetic to
  // hasRealAsk and the marketable-limit calc (which would then wrongly fall back to refPrice); and a
  // merged broker/Yahoo `price` (normalize replaces `price` below) would keep the SCREENER's stale
  // sources.price, so the drilldown/table price tooltip would misattribute the shown value.
  const refreshSideProvenance = (
    base: EnrichmentSources | undefined,
    extra: { bid?: number; ask?: number; price?: number; volume?: number; provider?: string; syntheticSpread?: boolean; syntheticBid?: boolean; syntheticAsk?: boolean }
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
  const normalize = (quote: MarketQuote): MarketQuote => {
    const extra = quoteData[quote.symbol];
    if (!extra) return quote;
    const usedBid = positiveNumber(extra.bid);
    const usedAsk = positiveNumber(extra.ask);
    const bidSynthetic = extra.syntheticBid ?? extra.syntheticSpread ?? false;
    const askSynthetic = extra.syntheticAsk ?? extra.syntheticSpread ?? false;
    return {
      ...quote,
      bid: usedBid ?? quote.bid,
      ask: usedAsk ?? quote.ask,
      price: positiveNumber(extra.price) ?? quote.price,
      // Use broker/Yahoo volume if the screener didn't supply it (NASDAQ tableonly has no volume field).
      volume: (extra.volume && extra.volume > 0 ? extra.volume : undefined) ?? (quote.volume > 0 ? quote.volume : undefined) ?? 0,
      asOf: extra.asOf ?? quote.asOf,
      provider: extra.provider ?? quote.provider,
      // Carry synthetic bid/ask flags through from the broker/Yahoo quote. When a side had a real value
      // (usedBid/usedAsk), the flag reflects whether THAT value was synthetic. When the side wasn't
      // provided, the original quote's flag is preserved by the spread operator above.
      syntheticBid: usedBid ? bidSynthetic : quote.syntheticBid,
      syntheticAsk: usedAsk ? askSynthetic : quote.syntheticAsk,
      sources: refreshSideProvenance(quote.sources, extra)
    };
  };
  const topCandidates = scan.topCandidates.map(normalize);
  const quoteMap = Object.fromEntries(
    Object.values(scan.quotesBySymbol).map((quote) => {
      const extra = quoteData[quote.symbol];
      const usedBid = positiveNumber(extra?.bid);
      const usedAsk = positiveNumber(extra?.ask);
      const bidSynthetic = extra?.syntheticBid ?? extra?.syntheticSpread ?? false;
      const askSynthetic = extra?.syntheticAsk ?? extra?.syntheticSpread ?? false;
      const merged: MarketQuoteSummary = {
        ...quote,
        bid: usedBid ?? quote.bid,
        ask: usedAsk ?? quote.ask,
        price: positiveNumber(extra?.price) ?? quote.price,
        provider: extra?.provider ?? quote.provider,
        asOf: extra?.asOf ?? quote.asOf,
        syntheticBid: usedBid ? bidSynthetic : quote.syntheticBid,
        syntheticAsk: usedAsk ? askSynthetic : quote.syntheticAsk,
        sources: extra ? refreshSideProvenance(quote.sources, extra) : quote.sources
      };
      return [quote.symbol, merged] as const;
    })
  );
  for (const [rawSymbol, quote] of Object.entries(quoteData)) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || quoteMap[symbol]) continue;
    const price = positiveNumber(quote.price);
    if (!price) continue;
    quoteMap[symbol] = {
      symbol,
      price,
      bid: positiveNumber(quote.bid),
      ask: positiveNumber(quote.ask),
      score: 0,
      provider: quote.provider,
      asOf: quote.asOf,
      syntheticBid: quote.syntheticBid ?? quote.syntheticSpread ?? false,
      syntheticAsk: quote.syntheticAsk ?? quote.syntheticSpread ?? false,
      // Seed per-side provenance for a NEWLY-added quote too — otherwise a synthetic bid/ask on an
      // added row carries no sources and reads as a real quoted spread downstream (hasRealAsk etc.).
      sources: refreshSideProvenance(undefined, quote)
    };
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

  const withVwap = <T extends MarketQuote | MarketQuoteSummary>(quote: T): T => {
    const bar = bySymbol.get(quote.symbol);
    const vwap = positiveNumber(bar?.vwap);
    if (!vwap) return quote;
    applied = true;
    return {
      ...quote,
      vwap,
      sources: { ...(quote.sources ?? {}), vwap: provider }
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
  clearFundHoldingsCache();
}

async function fetchNasdaqScreener(
  ttlMs: number,
  exchange?: NasdaqExchange,
  signal?: AbortSignal
): Promise<{ rows: RawNasdaqRow[]; asOf?: string; cached: boolean }> {
  const now = Date.now();
  const cacheKey = exchange ?? "all";
  const cached = screenerCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { rows: cached.rows, asOf: cached.asOf, cached: true };
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(nasdaqScreenerUrl(exchange), {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0"
      }
    });
    if (!response.ok) throw new Error(`Market data request failed with ${response.status}.`);

    const payload = await response.json();
    const rows = Array.isArray(payload?.data?.table?.rows) ? (payload.data.table.rows as RawNasdaqRow[]) : [];
    const asOf = typeof payload?.data?.asof === "string" ? payload.data.asof : undefined;
    screenerCache.set(cacheKey, { rows, asOf, expiresAt: now + ttlMs });
    return { rows, asOf, cached: false };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function toMarketQuote(row: RawNasdaqRow, positions: EquityPosition[], provider: string, asOf?: string): MarketQuote[] {
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
      stale: true,
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

function nasdaqScreenerUrl(exchange?: NasdaqExchange): string {
  if (!exchange) return NASDAQ_SCREENER_URL;
  const url = new URL(NASDAQ_SCREENER_URL);
  url.searchParams.set("exchange", exchange);
  return url.toString();
}

function normalizeMarketDataSymbol(value: string): string {
  return normalizeSymbol(value).replace(/\//g, "-");
}

async function fetchQuoteOnlyMarketQuotes(symbols: string[], positions: EquityPosition[]): Promise<{ quotes: MarketQuote[]; warnings: string[] }> {
  const quotes: MarketQuote[] = [];
  const unresolved: string[] = [];
  const requested = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const results = await Promise.all(requested.map(async (symbol) => [symbol, await fetchYahooFinanceQuote(symbol)] as const));
  for (const [symbol, quote] of results) {
    if (quote) quotes.push(toQuoteOnlyMarketQuote(symbol, quote, positions));
    else unresolved.push(symbol);
  }
  const warnings = unresolved.length > 0
    ? [`No market data returned for custom symbol${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}. Check the ticker or try again if the market data provider is temporarily unavailable.`]
    : [];
  return { quotes, warnings };
}

function toQuoteOnlyMarketQuote(symbol: string, quote: YahooFinanceQuote, positions: EquityPosition[]): MarketQuote {
  const prevClose = quote.prevClose > 0 ? quote.prevClose : quote.price;
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
    asOf: new Date().toISOString(),
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

// Merge a provider enrichment record onto a screener quote (first-non-undefined wins,
// enrichment overriding the screener). Exported + exhaustive on purpose: every enriched
// field on SymbolEnrichment must be folded here or it silently never reaches the quote —
// the dashboard, scoring, and the agent prompt all read these off MarketQuote. This is the
// "merge in market.ts" half of the cross-file enrichment trap documented in CLAUDE.md.
export function applyEnrichment(quote: MarketQuote, extra: SymbolEnrichment): MarketQuote {
  const enrichmentBid = extra.bid && extra.bid > 0;
  const enrichmentAsk = extra.ask && extra.ask > 0;
  return {
    ...quote,
    price: extra.price && extra.price > 0 ? extra.price : quote.price,
    bid: enrichmentBid ? extra.bid : quote.bid,
    ask: enrichmentAsk ? extra.ask : quote.ask,
    // Enrichment providers supply REAL bid/ask (exchange/broker); clear the synthetic flag when they
    // override a side. When enrichment doesn't provide bid/ask, the original flag is preserved by spread.
    syntheticBid: enrichmentBid ? false : quote.syntheticBid,
    syntheticAsk: enrichmentAsk ? false : quote.syntheticAsk,
    intradayChangePct: typeof extra.intradayChangePct === "number" ? extra.intradayChangePct : quote.intradayChangePct,
    vwap: extra.vwap && extra.vwap > 0 ? extra.vwap : quote.vwap,
    asOf: extra.asOf ?? quote.asOf,
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
    dividendYield: extra.dividendYield ?? quote.dividendYield,
    eps: extra.eps ?? quote.eps,
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
    freeCashFlowYield: extra.freeCashFlowYield ?? quote.freeCashFlowYield,
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
    sources: mergeSources(quote, extra),
    // Keep cascade receipts on the quote so admin/ops/coverage reporting (and drilldowns) can see
    // which providers failed and the per-field observation status — not only the winning scalar.
    fieldObservations: extra.fieldObservations ?? quote.fieldObservations,
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

function liquidityScore(quote: MarketQuote): number {
  if (quote.volume > 0) return clamp(((Math.log10(Math.max(quote.volume, 1)) - 4) / 4) * 100);
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

function momentumScore(quote: MarketQuote): number {
  const intraday = intradayMomentum(quote.intradayChangePct);

  // Blend in the 52-week price position when available: near the high reflects
  // sustained strength/breakout; near the low reflects weakness (or mean-reversion).
  // DE-COLLINEARIZATION: when technicalScore IS present, it already encodes the
  // RSI/MACD/SMA-stack signals that are themselves functions of "price near its highs"
  // — the same information expressed by the 52-week position. Keeping the 52w weight
  // at 0.4 in that case would triple-count trend (intraday + 52w + technical). Instead
  // we reduce it to 0.15 when technicalScore is available, preserving a small
  // breakout/breakdown signal while removing the bulk of the redundancy.
  const pos = pricePosition52w(quote);
  const hasTech = typeof quote.technicalScore === "number";
  const w52 = hasTech ? 0.15 : 0.4;
  const base = typeof pos === "number"
    ? intraday * (1 - w52) + pos * w52
    : intraday;

  // Blend in the bar-based technical read when present (RSI/MACD/MA crossovers from a
  // real price-history series — the one momentum input the snapshot screener lacks).
  // Reduced from 0.5 to 0.4 (technical is informative but already subsumes much of the
  // 52-week-position signal above; keeping it at 0.5 was an implicit double-weight on
  // trend relative to the fresh intraday signal).
  if (hasTech) {
    return clamp(base * 0.6 + quote.technicalScore! * 0.4);
  }
  return clamp(base);
}

function volatilityScore(quote: MarketQuote): number {
  // Higher = steadier (less realized + systematic volatility). Beta, when available,
  // adjusts the intraday-only base so high-beta names score as riskier.
  let base = 100 - Math.abs(quote.intradayChangePct) * 12;
  if (typeof quote.beta === "number" && quote.beta > 0) {
    if (quote.beta > 1.5) base -= 15;
    else if (quote.beta > 1.1) base -= 6;
    else if (quote.beta < 0.8) base += 6;
  }
  return clamp(base);
}

/**
 * Smart-money positioning sub-score (50 = neutral when no signal). Lifts names with
 * net congressional buying / insider open-market buying / squeeze-level short interest,
 * and dings net selling — so the scraped signals influence the deterministic ranking,
 * not just the LLM prompt. Populated from the web-source overlay (see scanMarket), so
 * the score is recomputed AFTER the overlay there.
 */
function positioningScore(quote: MarketQuote): number {
  let base = 50;
  if (typeof quote.senateTrades === "number" && quote.senateTrades !== 0) {
    // Net distinct congressional buy members minus sell members.
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
  // Prefer a real P/E signal when available; otherwise fall back to a market-cap heuristic.
  let base: number;
  if (quote.peRatio && quote.peRatio > 0) {
    base = quote.peRatio <= 15 ? 78 : quote.peRatio <= 25 ? 64 : quote.peRatio <= 40 ? 50 : 36;
  } else if (!quote.marketCap || quote.marketCap <= 0) {
    base = 50;
  } else {
    base = quote.marketCap >= 5_000_000_000 ? 65 : quote.marketCap >= 1_000_000_000 ? 55 : 45;
  }
  // Free-cash-flow yield is a real value signal independent of earnings multiples.
  if (typeof quote.fcfYield === "number") {
    if (quote.fcfYield >= 6) base += 12;
    else if (quote.fcfYield >= 3) base += 6;
    else if (quote.fcfYield < 0) base -= 8;
  }
  return clamp(base);
}

function qualityScore(quote: MarketQuote): number {
  let base: number;
  if (!quote.marketCap || quote.marketCap <= 0) base = 50;
  else if (quote.marketCap >= 10_000_000_000 && quote.volume >= 1_000_000) base = 70;
  else if (quote.marketCap >= 1_000_000_000) base = 60;
  else base = 45;
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

function quotesBySymbol(quotes: MarketQuote[]): Record<string, MarketQuoteSummary> {
  return Object.fromEntries(
    quotes.map((quote) => [
      quote.symbol,
      {
        symbol: quote.symbol,
        companyName: quote.companyName,
        price: quote.price,
        bid: quote.bid,
        ask: quote.ask,
        sector: quote.sector,
        industry: quote.industry,
        score: quote.score,
        provider: quote.provider,
        asOf: quote.asOf,
        sentiment: quote.sentiment,
        peRatio: quote.peRatio,
        analystRating: quote.analystRating,
        analystScore: quote.analystScore,
        analystBySource: quote.analystBySource,
        dividendYield: quote.dividendYield,
        eps: quote.eps,
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
        freeCashFlowYield: quote.freeCashFlowYield,
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
        sources: quote.sources
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
