// Free daily OHLC price-history fetch — the single source of bars for the app.
//
// Two consumers share this: the technical connector (`web-sources/technical.ts`, which
// only reads closes) and the symbol-drilldown price chart (`/api/history`, which needs
// full candles). The default lookback is ~5y. Requests longer than the Massive free
// aggregate window (2y) skip Massive — that tier truncates — and try Yahoo chart
// `range=max` (paced), then Tradier history, then Twelve Data. Shorter requests keep
// the broker-first order: imported/App A → Tradier / Alpaca / Robinhood → Massive →
// ROIC.ai → Tiingo → Yahoo `range=1y` → Marketstack.
// Broker-owned bars come BEFORE paid third parties on the short path so a connected
// venue lifts Massive/ROIC/Tiingo spend and is usually the same tape the account would
// fill against. On the deep path Yahoo's free max range is the only source that
// reliably covers more than two years without a paid history tier.
// Capability matrix ranks Yahoo `good` and Marketstack `last_resort` for ohlcv_daily.
// Marketstack only runs after Yahoo fails. Yahoo chart 429s fail fast when Marketstack
// can still try.
// Server-side only; cached briefly. Never fabricates — no bars → returns null, callers
// degrade to "—".
//
// ROIC.ai (api.roic.ai v3 stock-prices) is ST-side only: Congress.Trade (App A) reads
// prices exclusively via ST's peer market-read routes (PRICE_PROVIDER=peer) after ST has
// cached the series. CT never holds a ROIC key.
//
// Stooq was the terminal free fallback here until 2026-08: research confirmed its daily-CSV
// endpoint now sits behind an Anubis-style JS proof-of-work wall (bot-blocked, not merely
// rate-limited) — integrating around that would mean circumventing bot protection, so the tier
// was removed rather than kept as permanently-dead code. `parseStooqCsv` stays exported (still
// unit-tested as a pure parser, and re-exported from web-sources/technical.ts for back-compat)
// in case a future non-bot-walled CSV source needs the same shape.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { z } from "zod";
import type { OHLCBar } from "./indicators";
export type { OHLCBar };
import { dataSourceFetch } from "./data-source-fetch";
import { normalizeSymbol, toAlpacaSymbol } from "./money";
import { audit, deleteInternalSetting, fulfillMarketDataDemand, getConnectedAccountByBroker, getImportedPriceCloses, getImportedSpxCloses, getInternalSetting, hasDataPoolConsent, recordMarketDataDemand, resolveApiKeyWithSource, setInternalSetting, upsertImportedPrices, type ApiKeySource } from "./db";
import { emitDashboardEvent } from "./events";
import { expiresAtRespectingMarketClose, latestCompletedTradingSessionEtKey } from "./market-hours";
import { recordProviderCall } from "./usage-monitor-push";
import { massiveApiBase, reserveMassiveRestCall } from "./market-signals/massive";
import { fetchRobinhoodHistoricals } from "./robinhood";
import { appAClosesToBars, congressReadsEnabled, getCongressTradeClient } from "./api-clients/congress";
import { BROWSER_UA, politeFetchJson } from "./web-sources/http";
import { admitProviderRequests, withProviderLimit } from "./provider-rate-limit";
import { apiKeyFingerprint } from "./data-providers";
import { fetchHistoryCacheEod, upsertHistoryCacheEod } from "./history-cache";
const DEFAULT_TTL_MS = 30 * 60_000; // daily bars only move intraday on the last candle
const cache = new Map<string, { expiresAt: number; bars: OHLCBar[] }>();
const KEYED_HISTORY_SERVICES = ["massive", "roic", "marketstack", "tiingo", "twelvedata"] as const;
/** Massive free aggregates stop at about two years. Longer requests skip that tier. */
const MASSIVE_FREE_LOOKBACK_DAYS = 730;
const DEFAULT_LOOKBACK_DAYS = 1825;
type CacheScope = "shared" | "private" | "pool";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        /** Split-and-dividend-adjusted closes — prefer these over quote.close for multi-year returns. */
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
  };
}

function historyTtlMs(): number {
  const v = Number(process.env.HISTORY_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function clampLookbackDays(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_LOOKBACK_DAYS;
}

/** True when the oldest bar is on or before the requested start (the series is not a short stub). */
function seriesCoversStart(bars: OHLCBar[], startDate: string): boolean {
  const oldest = toBusinessDay(bars[0]?.time);
  return Boolean(oldest && oldest <= startDate);
}

const LISTING_START_PREFIX = "history:listing-start:";

function listingStartKey(symbol: string): string {
  return `${LISTING_START_PREFIX}${symbol}`;
}

/** Oldest session Yahoo `range=max` actually returned.  A young listing never reaches a 5y start. */
function readListingStart(symbol: string): string | undefined {
  try {
    const raw = getInternalSetting<unknown>(listingStartKey(symbol));
    return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeListingStart(symbol: string, iso: string | null): void {
  try {
    if (!iso) {
      deleteInternalSetting(listingStartKey(symbol));
      return;
    }
    setInternalSetting(listingStartKey(symbol), iso);
  } catch {
    // A settings miss must not drop bars the cascade already fetched.
  }
}

function localSeriesCovers(symbol: string, bars: OHLCBar[] | null, startDate: string, deepHistory: boolean): boolean {
  if (!bars || !deepHistory) return true;
  if (seriesCoversStart(bars, startDate)) return true;
  const oldest = toBusinessDay(bars[0]?.time);
  const listedAt = readListingStart(symbol);
  // The marker is the first bar of a completed range=max fetch.  Cached bars
  // that still start on or before that date are the full listing, not a stub.
  return Boolean(oldest && listedAt && oldest <= listedAt);
}

// ── Yahoo v8/finance/chart HTTP 429 hardening ────────────────────────────────
// Live-verified 2026-08-02: this endpoint does NOT require the crumb+cookie session handshake that
// v7/finance/quote and v10/finance/quoteSummary now enforce (401 "Invalid Crumb" without one) — a
// plain GET with a browser User-Agent (BROWSER_UA) returns real chart data. What it DOES do is
// intermittently rate-limit (HTTP 429) shared/datacenter egress IPs in short bursts that usually
// clear within a second or two. `politeFetchJson` already retries once on 429 (web-sources/http.ts),
// but a single retry isn't always enough for this specific bot-detection pattern, so this dedicated
// helper layers true exponential backoff on top, retrying ONLY on 429 — any other failure (network
// error, timeout, non-429 status) still fails on the first attempt so the cascade degrades to the
// next tier promptly instead of stalling.
//
// When a later live tier still exists (Marketstack), keep Yahoo attempts short (2) so a 429 burst
// does not stall the serial cascade for ~4×9s before the last-resort keyed source can run. When
// Yahoo is the terminal floor, keep the longer retry budget.
const YAHOO_CHART_TIMEOUT_MS = 9000;
const YAHOO_CHART_MAX_ATTEMPTS = 4; // terminal floor: 1 initial try + 3 retries
const YAHOO_CHART_FAST_FAIL_ATTEMPTS = 2; // later tier present: 1 initial + 1 retry
const YAHOO_CHART_BASE_BACKOFF_MS = 400;

async function fetchYahooChartJson<T>(
  url: string,
  opts?: { maxAttempts?: number }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? YAHOO_CHART_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The abort timer starts after the yahoo-finance slot is acquired.  Time
    // spent in the pacer queue must not count against YAHOO_CHART_TIMEOUT_MS.
    // range=1y and range=max share this helper and the same chart host, so both
    // take the 400ms / concurrency-2 pacer.  That spacing is intentional on the
    // short path: a cache-miss fan-out was already drawing HTTP 429s here.
    const res = await withProviderLimit("yahoo-finance", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), YAHOO_CHART_TIMEOUT_MS);
      try {
        return await dataSourceFetch(url, {
          headers: { "user-agent": BROWSER_UA, accept: "application/json" },
          cache: "no-store",
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    });
    if (res.status === 429 && attempt < maxAttempts - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(4000, YAHOO_CHART_BASE_BACKOFF_MS * 2 ** attempt))
      );
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
  throw new Error(`HTTP 429 for ${url} (exhausted retries)`);
}

/**
 * Evaluates whether a series of daily OHLC bars is fresh: the latest bar must include the most
 * recently completed US equity trading session (session-counted, not calendar days).
 */
export function isBarSeriesFresh(bars: OHLCBar[] | null, now: number = Date.now()): boolean {
  if (!bars || bars.length < 2) return false;
  const lastBar = bars[bars.length - 1];
  if (!lastBar || lastBar.time == null) return false;
  const lastBarDay = toBusinessDay(lastBar.time);
  if (!lastBarDay) return false;
  const latestExpected = latestCompletedTradingSessionEtKey(now);
  return lastBarDay >= latestExpected;
}

/**
 * Merges historical bars with incoming fresh bars by date YYYY-MM-DD, sorting ascending.
 */
export function mergeOHLCBars(existing: OHLCBar[], incoming: OHLCBar[]): OHLCBar[] {
  const map = new Map<string, OHLCBar>();
  const toKey = (b: OHLCBar) => {
    if (!b.time) return "";
    if (typeof b.time === "string") return b.time.slice(0, 10);
    const ms = typeof b.time === "number" ? (b.time < 1e10 ? b.time * 1000 : b.time) : 0;
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  };

  for (const b of existing) {
    const k = toKey(b);
    if (k) map.set(k, b);
  }
  for (const b of incoming) {
    const k = toKey(b);
    if (k) {
      const prev = map.get(k);
      map.set(k, { ...prev, ...b });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const tA = typeof a.time === "number" ? a.time : typeof a.time === "string" ? new Date(a.time).getTime() : 0;
    const tB = typeof b.time === "number" ? b.time : typeof b.time === "string" ? new Date(b.time).getTime() : 0;
    return tA - tB;
  });
}

function persistEodBarsToCache(symbol: string, bars: OHLCBar[]): void {
  try {
    const pricesInput = [{
      ticker: symbol,
      closes: bars.map((b) => {
        const dStr = typeof b.time === "string"
          ? b.time.slice(0, 10)
          : new Date(typeof b.time === "number" ? (b.time < 1e10 ? b.time * 1000 : b.time) : 0).toISOString().slice(0, 10);
        return {
          date: dStr,
          close: b.close,
          volume: b.volume
        };
      })
    }];
    upsertImportedPrices(pricesInput, "eod-auto-cache");
  } catch {
    // Non-fatal if DB write fails
  }

  try {
    const baseDir = path.join(process.cwd(), "data", "history-5y");
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const targetFile = path.join(baseDir, `${symbol.toUpperCase()}.json`);
    const formatted = bars.map((b) => ({
      t: typeof b.time === "number" ? b.time : typeof b.time === "string" ? new Date(b.time).getTime() : 0,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume
    }));
    fs.writeFileSync(targetFile, JSON.stringify(formatted));
  } catch {
    // Non-fatal if disk write fails
  }
}


/**
 * Fetch daily OHLC bars for a symbol. Default lookback is ~5y (`lookbackDays`).
 * Lookbacks longer than {@link MASSIVE_FREE_LOOKBACK_DAYS} skip Massive and try
 * Yahoo `range=max` (paced), Tradier, then Twelve Data before the remaining tiers.
 * Shorter lookbacks keep Massive in the broker-first cascade and Yahoo at `range=1y`.
 * SQLite `history_cache_eod` rows are permanent (no row TTL). A fresh series is
 * served with no network only when it reaches `startDate`, or when a prior Yahoo
 * `range=max` response confirmed the listing starts later.  A 2y cache with no
 * such marker cannot block a deep Yahoo fetch. Returns the first source that yields ≥2 bars,
 * or null (never fabricated).
 * ROIC is operator-key only (ROIC_API_KEY); CT (App A) never holds a ROIC key — it
 * pulls via ST market-read peer routes after ST has cached the series.
 */
export async function fetchDailyOHLC(
  rawSymbol: string,
  now: number = Date.now(),
  userId?: string,
  opts?: { skipAppATier?: boolean; usageLabel?: string; lookbackDays?: number },
): Promise<OHLCBar[] | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;

  const keySources: Record<(typeof KEYED_HISTORY_SERVICES)[number], { key?: string; source: ApiKeySource }> = {
    massive: resolveApiKeyWithSource("massive", userId),
    roic: resolveApiKeyWithSource("roic", userId),
    marketstack: resolveApiKeyWithSource("marketstack", userId),
    tiingo: resolveApiKeyWithSource("tiingo", userId),
    twelvedata: resolveApiKeyWithSource("twelvedata", userId)
  };
  const tradierCredential = resolveTradierHistoryCredential();
  const alpacaHistory = resolveAlpacaHistoryCredential(userId);
  const privateCacheKey = historyCacheKey(symbol, userId, "private");
  const poolCacheKey = historyCacheKey(symbol, userId, "pool");
  const sharedCacheKey = historyCacheKey(symbol, userId, "shared");

  const consented = hasDataPoolConsent(userId ?? "local");
  const privateHit = cache.get(privateCacheKey);
  if (privateHit && privateHit.expiresAt > now) return privateHit.bars;
  if (consented) {
    const poolHit = cache.get(poolCacheKey);
    if (poolHit && poolHit.expiresAt > now) return poolHit.bars;
  }
  const sharedHit = cache.get(sharedCacheKey);
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit.bars;

  const lookbackDays = clampLookbackDays(opts?.lookbackDays);
  const deepHistory = lookbackDays > MASSIVE_FREE_LOOKBACK_DAYS;
  const startDate = new Date(now - lookbackDays * 24 * 60 * 60_000).toISOString().slice(0, 10);

  // 1. Evaluate local SQLite history cache. Rows are permanent. A fresh series
  //    short-circuits the network only when it covers the requested start, or when
  //    Yahoo range=max already confirmed this symbol lists later than that start.
  //    A 2-year cache with no marker cannot hide Yahoo range=max on a deep request.
  const localBars = await fetchHistoryCacheEod(symbol);
  const localCovers = localSeriesCovers(symbol, localBars, startDate, deepHistory);
  if (localBars && localBars.length >= 2 && isBarSeriesFresh(localBars, now) && localCovers) {
    const stampedLocal = stampOhlcBarProvenance(localBars, "history-cache-eod", new Date(now).toISOString());
    cache.set(sharedCacheKey, { expiresAt: expiresAtRespectingMarketClose(new Date(now), historyTtlMs()), bars: stampedLocal });
    emitHistoryDemandFilled(symbol, now);
    return stampedLocal;
  }

  // If localBars exists but is STALE, retain for topping up with active provider data
  const staleLocalBars = localBars && localBars.length >= 2 ? localBars : null;

  // Imported-EOD series (congress.trade return-path), read ONCE.  A FRESH dense series may displace
  // a re-fetch (the tier below).  A STALE one must not (#4009): production had this tier ON with a
  // 1,000-bar SPY series ending 2026-07-24 that won ahead of Tradier, Massive, ROIC, Tiingo, and
  // Yahoo, so the SPY benchmark read "imported-eod" pinned to that date for two months.  Here a
  // stale series is instead a merge base for a live fetch and the all-sources-failed fallback.
  // Tagged "imported-eod" now so bars it contributes keep that provenance after a live merge
  // instead of inheriting whichever live source's tag stamps the merged result.
  const importedBars = fetchImportedHistory(symbol);
  const importedIsFresh = importedBars != null && isBarSeriesFresh(importedBars, now);
  const staleImportedBars =
    importedBars != null && !importedIsFresh
      ? stampOhlcBarProvenance(importedBars, "imported-eod", new Date(now).toISOString())
      : null;
  // One stale base for both the live top-up and the final fallback: the local cache and a stale
  // import unioned by date (import wins a shared date, as #4009's fallback did).
  const staleFallbackBars =
    staleLocalBars && staleImportedBars
      ? mergeOHLCBars(staleLocalBars, staleImportedBars)
      : staleLocalBars ?? staleImportedBars;

  const yahooAttempts = keySources.marketstack.key ? YAHOO_CHART_FAST_FAIL_ATTEMPTS : YAHOO_CHART_MAX_ATTEMPTS;
  const importedSource = {
    scope: "shared" as const,
    sourceId: "imported-eod",
    // A fresh, dense series may displace a re-fetch; a stale one was diverted to
    // `staleImportedBars` above (#4009). DEFAULT OFF + density-guarded inside
    // fetchImportedHistory so a sparse gap-fill never short-circuits.
    fetch: async () => (importedIsFresh ? importedBars : null)
  };
  const appASource = opts?.skipAppATier
    ? []
    : [{ scope: "shared" as const, sourceId: "congress.trade", fetch: () => fetchAppAHistory(symbol) }];
  const tradierSource = {
    scope: "shared" as const,
    sourceId: "tradier",
    fetch: () => fetchTradier(symbol, startDate, tradierCredential.key, tradierCredential.baseUrl)
  };
  const twelveSource = {
    scope: cacheScopeForKeySource(keySources.twelvedata.source, userId),
    sourceId: "twelvedata",
    fetch: () => fetchTwelveData(symbol, startDate, keySources.twelvedata.key, opts?.usageLabel)
  };
  const alpacaSource = {
    scope: cacheScopeForKeySource(alpacaHistory.source, userId),
    sourceId: "alpaca",
    fetch: () => fetchAlpacaDaily(symbol, startDate, alpacaHistory.apiKey, alpacaHistory.secretKey)
  };
  const robinhoodSource = userId
    ? [
        {
          scope: cacheScopeForKeySource("user", userId),
          sourceId: "robinhood",
          fetch: () => fetchRobinhoodHistoricals(symbol, { interval: "day", span: "5year", userId })
        }
      ]
    : [];
  const massiveSource = {
    scope: cacheScopeForKeySource(keySources.massive.source, userId),
    sourceId: "massive",
    fetch: () => fetchMassive(symbol, startDate, keySources.massive.key, opts?.usageLabel)
  };
  const roicSource = {
    scope: cacheScopeForKeySource(keySources.roic.source, userId),
    sourceId: "roic",
    fetch: () => fetchRoic(symbol, startDate, keySources.roic.key, opts?.usageLabel)
  };
  const tiingoSource = {
    scope: cacheScopeForKeySource(keySources.tiingo.source, userId),
    sourceId: "tiingo",
    fetch: () => fetchTiingo(symbol, startDate, keySources.tiingo.key, opts?.usageLabel)
  };
  const yahooSource = (range: "max" | "1y") => ({
    scope: "shared" as const,
    sourceId: "yahoo-finance",
    confirmsListingStart: range === "max",
    fetch: () => fetchYahoo(symbol, { range, maxAttempts: yahooAttempts })
  });
  const marketstackSource = {
    scope: cacheScopeForKeySource(keySources.marketstack.source, userId),
    sourceId: "marketstack",
    fetch: () => fetchMarketstack(symbol, keySources.marketstack.key, opts?.usageLabel)
  };
  // Deep (>2y): Yahoo range=max, Tradier, Twelve Data. Massive is omitted because
  // the free tier truncates at ~2y and would win the cascade with a short series.
  // Short: brokers, then Massive, then Yahoo range=1y before Marketstack.
  const sources: Array<{
    scope: CacheScope;
    sourceId: string;
    confirmsListingStart?: boolean;
    fetch: () => Promise<OHLCBar[] | null>;
  }> = deepHistory
    ? [
        importedSource,
        ...appASource,
        yahooSource("max"),
        tradierSource,
        twelveSource,
        alpacaSource,
        ...robinhoodSource,
        roicSource,
        tiingoSource,
        marketstackSource
      ]
    : [
        importedSource,
        ...appASource,
        tradierSource,
        alpacaSource,
        ...robinhoodSource,
        massiveSource,
        roicSource,
        tiingoSource,
        yahooSource("1y"),
        marketstackSource
      ];

  for (const source of sources) {
    const liveBars = await source.fetch();
    if (liveBars && liveBars.length >= 2) {
      const fetchedAt = new Date(now).toISOString();
      const stampedLive = stampOhlcBarProvenance(liveBars, source.sourceId, fetchedAt);
      const finalBars = staleFallbackBars
        ? stampOhlcBarProvenance(mergeOHLCBars(staleFallbackBars, stampedLive), source.sourceId, fetchedAt)
        : stampedLive;
      if (source.confirmsListingStart) {
        const oldest = toBusinessDay(finalBars[0]?.time);
        writeListingStart(symbol, oldest && oldest > startDate ? oldest : null);
      }
      persistEodBarsToCache(symbol, finalBars);

      const cacheKey = source.scope === "private" ? privateCacheKey : source.scope === "pool" ? poolCacheKey : sharedCacheKey;
      cache.set(cacheKey, { expiresAt: expiresAtRespectingMarketClose(new Date(now), historyTtlMs()), bars: finalBars });
      if (source.scope === "shared") emitHistoryDemandFilled(symbol, now);
      
      // Persist permanently (no row TTL) so a later deep request can serve history
      // without re-downloading bars that already reach startDate.
      if (source.fetch.name !== "fetchHistoryCacheEod") {
        upsertHistoryCacheEod(symbol, finalBars);
      }
      
      return finalBars;
    }
  }

  // Fallback if active providers hit errors or expired keys: audit warning and return the stale base
  // (local cache and/or stale import).  This is not a success: the peer reader must be able to tell
  // the series is behind the session.
  if (staleFallbackBars && staleFallbackBars.length >= 2) {
    const lastBar = staleFallbackBars[staleFallbackBars.length - 1];
    const staleSourceId = staleLocalBars ? "history-cache-eod-stale" : "imported-eod-stale";
    audit(
      "eod_cache_stale",
      {
        symbol,
        lastBarTime: lastBar?.time,
        note: `All active EOD price history providers failed or expired; falling back to stale ${staleLocalBars ? "local" : "imported-EOD"} bars.`
      },
      userId ?? "local"
    );
    // Import bars were pre-tagged "imported-eod" (so a live merge keeps per-bar provenance) and
    // stampOhlcBarProvenance never overwrites an existing tag.  As the FINAL fallback the whole
    // series is stale, so re-tag those bars: otherwise a consumer that keys on the stale source
    // (benchmark.ts fellBackToStaleCache) cannot tell a frozen feed from a live one.
    const stampedStale = stampOhlcBarProvenance(
      staleFallbackBars.map((bar) => (bar.source === "imported-eod" ? { ...bar, source: staleSourceId } : bar)),
      staleSourceId,
      new Date(now).toISOString()
    );
    cache.set(sharedCacheKey, { expiresAt: now + 5 * 60_000, bars: stampedStale });
    return stampedStale;
  }

  recordMarketDataDemand({ kind: "history", symbol, userId, now });
  return null;
}

function historyCacheKey(symbol: string, userId: string | undefined, scope: CacheScope): string {
  if (scope === "private") return `user:${userId ?? "local"}:${symbol}`;
  if (scope === "pool") return `pool:${symbol}`;
  return `shared:${symbol}`;
}

/**
 * Stamp every bar in a series with source + fetch clock. Bar `time` remains the session
 * date/as-of; `fetchedAt` is when we obtained the series. Capability ranks: source-capability-matrix
 * `ohlcv_daily`.
 */
export function stampOhlcBarProvenance(
  bars: OHLCBar[],
  source: string,
  fetchedAt: string = new Date().toISOString()
): OHLCBar[] {
  if (!bars.length) return bars;
  const src = source.trim() || "unknown";
  return bars.map((bar) => ({
    ...bar,
    source: bar.source ?? src,
    fetchedAt: bar.fetchedAt ?? fetchedAt
  }));
}

function cacheScopeForKeySource(source: ApiKeySource, userId: string | undefined): CacheScope {
  if (source !== "user") return "shared"; // env-key / free providers are public — everyone benefits.
  // A user's OWN provider key: shared globally if the env override is on; otherwise contributed to
  // the reciprocal POOL when the user has consented; otherwise kept private to that user.
  if (shareUserKeyedHistory()) return "shared";
  if (hasDataPoolConsent(userId ?? "local")) return "pool";
  return "private";
}

function shareUserKeyedHistory(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function emitHistoryDemandFilled(symbol: string, now: number): void {
  const fill = fulfillMarketDataDemand({ kind: "history", symbol, now });
  if (!fill) return;
  emitDashboardEvent({
    type: "market-data",
    at: new Date(now).toISOString(),
    detail: {
      kind: fill.kind,
      cacheScope: "shared",
      pendingUserCount: fill.pendingUserCount,
      oldestRequestedAt: fill.oldestRequestedAt,
      latestRequestedAt: fill.latestRequestedAt
    }
  });
}

interface MassiveAggBar { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number }
interface MassiveAggResponse { results?: MassiveAggBar[] }

interface RoicPriceRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface RoicStockPricesResponse {
  data?: RoicPriceRow[];
  next_page_url?: string | null;
}

/**
 * Pure mapper for ROIC.ai v3 stock-prices rows → OHLCBar[]. Exported for unit tests.
 * Prefers split-adjusted closes when the caller requested adjustment=splits (the
 * fetch path always does). Volume is always raw session volume per ROIC docs.
 */
export function parseRoicStockPrices(rows: unknown): OHLCBar[] {
  const list = Array.isArray(rows) ? rows : [];
  const bars: OHLCBar[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RoicPriceRow;
    if (!r.date || typeof r.close !== "number" || !Number.isFinite(r.close)) continue;
    bars.push({
      time: String(r.date).slice(0, 10),
      open: numOrUndef(r.open),
      high: numOrUndef(r.high),
      low: numOrUndef(r.low),
      close: r.close,
      volume: numOrUndef(r.volume),
    });
  }
  // Ascending by date so consumers (MACD/SMA) see chronological series.
  bars.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return bars;
}

/**
 * ROIC.ai historical daily prices
 * (`GET https://api.roic.ai/v3.0.0/stock-prices/{identifier}`).
 * Free tier: ~2y history + low rpm; paid plans deepen history. Cursor-paginated
 * (limit ≤1000). Shares the "roic" admitProviderRequests bucket with
 * RoicAiEnrichmentProvider so enrichment + history cannot jointly over-burn.
 */
async function fetchRoic(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  if ((process.env.ROIC_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  const credKey = await apiKeyFingerprint(key);
  // Reserve one request for the first page; further pages re-admit.
  if (admitProviderRequests("roic", credKey, 1) < 1) return null;

  const to = new Date().toISOString().slice(0, 10);
  // Plain ticker works for US names; exchange-prefixed form is accepted by the API too.
  const identifier = encodeURIComponent(symbol);
  let url: string | null =
    `https://api.roic.ai/v3.0.0/stock-prices/${identifier}` +
    `?apikey=${encodeURIComponent(key)}` +
    `&date.gte=${encodeURIComponent(startDate)}` +
    `&date.lte=${encodeURIComponent(to)}` +
    `&adjustment=splits&order=asc&limit=1000`;

  const all: OHLCBar[] = [];
  let pages = 0;
  const MAX_PAGES = 8; // 8×1000 >> 5y of daily bars
  try {
    while (url && pages < MAX_PAGES) {
      if (pages > 0 && admitProviderRequests("roic", credKey, 1) < 1) break;
      // Explicit types break TS7022 circular inference with `url` reassignment in the loop.
      const json: RoicStockPricesResponse = await politeFetchJson<RoicStockPricesResponse>(url, {
        headers: { Accept: "application/json" },
      });
      pages += 1;
      const pageBars = parseRoicStockPrices(json?.data);
      for (const b of pageBars) all.push(b);
      const next: string | null =
        typeof json?.next_page_url === "string" && json.next_page_url.trim()
          ? json.next_page_url.trim()
          : null;
      // next_page_url is absolute; ensure apikey still present (some page tokens drop query).
      if (next && !/[?&]apikey=/.test(next)) {
        url = next.includes("?")
          ? `${next}&apikey=${encodeURIComponent(key)}`
          : `${next}?apikey=${encodeURIComponent(key)}`;
      } else {
        url = next;
      }
    }
    recordProviderCall("roic", { service: "market-data", ok: all.length >= 2, label: usageLabel });
    // Dedupe by date (overlap across pages) keeping last write.
    const byDate = new Map<string, OHLCBar>();
    for (const b of all) byDate.set(String(b.time), b);
    const bars = [...byDate.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("roic", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

/** Massive daily aggregates (Polygon-compatible REST). Generous limits — the preferred primary. */
async function fetchMassive(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  if ((process.env.MASSIVE_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  if (!reserveMassiveRestCall()) return null;
  const base = massiveApiBase();
  const to = new Date().toISOString().slice(0, 10);
  try {
    const url = `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${startDate}/${to}?adjusted=true&sort=asc&limit=50000`;
    const json = await politeFetchJson<MassiveAggResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    recordProviderCall("massive", { service: "market-data", ok: true, label: usageLabel });
    const rows = json?.results ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.c !== "number" || !Number.isFinite(r.c) || typeof r.t !== "number") continue;
      bars.push({ time: r.t, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v), vwap: numOrUndef(r.vw) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("massive", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

interface TradierHistoryDay {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface TradierHistoryResponse {
  history?: { day?: TradierHistoryDay | TradierHistoryDay[] } | null;
}

/**
 * Resolves Tradier's price-history credential from the owner's own CONNECTED broker account
 * (connected_accounts, broker "tradier") rather than a separate stored API key — the owner connects
 * Tradier once (even just as a data source, not necessarily as the active EXECUTION broker — see
 * getConnectedAccountByBroker's doc comment) and that connection's access token becomes the app's
 * Tradier price-history source too. Always resolves the "local" (owner's) connection regardless of
 * the requesting userId — a single connected broker naturally serves the whole app, mirroring the
 * "shared-operator-infra" model every other keyed history provider already uses via an env var, just
 * sourced from a broker connection instead. Sandbox vs production tracks the connection's own
 * `environment`, matching tradier.ts's own derivation for order placement.
 */
/**
 * Alpaca daily bars come from a CONNECTED Alpaca account (the requesting user, else
 * the owner's local connection).  We do not fall back to leftover env paper keys —
 * those would silently spend the operator credential on every tenant history miss.
 */
export function resolveAlpacaHistoryCredential(userId?: string): { apiKey?: string; secretKey?: string; source: ApiKeySource } {
  const scoped = userId ? getConnectedAccountByBroker("alpaca", userId) ?? getConnectedAccountByBroker("alpaca-mcp", userId) : undefined;
  const acct = scoped ?? getConnectedAccountByBroker("alpaca", "local") ?? getConnectedAccountByBroker("alpaca-mcp", "local");
  const liveKey = process.env.ALPACA_LIVE_API_KEY?.trim() ?? process.env.APCA_API_KEY_ID?.trim() ?? process.env.ALPACA_API_KEY?.trim();
  const liveSecret = process.env.ALPACA_LIVE_SECRET_KEY?.trim() ?? process.env.APCA_API_SECRET_KEY?.trim() ?? process.env.ALPACA_SECRET_KEY?.trim();
  return {
    apiKey: acct?.apiKey?.trim() || liveKey || undefined,
    secretKey: acct?.apiSecret?.trim() || liveSecret || undefined,
    source: scoped ? "user" : "env"
  };
}

function resolveTradierHistoryCredential(): { key?: string; baseUrl: string } {
  const acct = getConnectedAccountByBroker("tradier", "local");
  return {
    key: acct?.apiKey?.trim() || undefined,
    baseUrl: acct?.environment === "live" ? "https://api.tradier.com" : "https://sandbox.tradier.com"
  };
}

interface AlpacaDailyBar {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}
interface AlpacaBarsResponse {
  bars?: AlpacaDailyBar[] | Record<string, AlpacaDailyBar[]>;
  next_page_token?: string | null;
}

/**
 * Alpaca IEX daily bars from the market-data credential already on a connected
 * Alpaca account (or the operator paper key).  Same tape as the snapshot
 * cascade.  No extra third-party key.
 */
async function fetchAlpacaDaily(
  symbol: string,
  startDate: string,
  apiKey: string | undefined,
  secretKey: string | undefined
): Promise<OHLCBar[] | null> {
  if (!apiKey || !secretKey) return null;
  const alpacaSymbol = toAlpacaSymbol(symbol);
  try {
    const bars: OHLCBar[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const params = new URLSearchParams({
        timeframe: "1Day",
        start: `${startDate}T00:00:00Z`,
        adjustment: "split",
        limit: "10000",
        feed: "iex"
      });
      if (pageToken) params.set("page_token", pageToken);
      const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(alpacaSymbol)}/bars?${params.toString()}`;
      const json = await politeFetchJson<AlpacaBarsResponse>(url, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
          Accept: "application/json"
        }
      });
      const raw = Array.isArray(json?.bars)
        ? json.bars
        : json?.bars && typeof json.bars === "object"
          ? (json.bars[alpacaSymbol] ?? json.bars[symbol] ?? [])
          : [];
      for (const d of raw) {
        if (typeof d.c !== "number" || !Number.isFinite(d.c) || !d.t) continue;
        bars.push({
          time: d.t.slice(0, 10),
          open: numOrUndef(d.o),
          high: numOrUndef(d.h),
          low: numOrUndef(d.l),
          close: d.c,
          volume: numOrUndef(d.v)
        });
      }
      pageToken = json?.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    recordProviderCall("alpaca", { service: "market-data", ok: true });
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("alpaca", { service: "market-data", ok: false });
    return null;
  }
}

/** Tradier daily history — brokerage-grade, generous rate limits. Best primary source. */
async function fetchTradier(symbol: string, startDate: string, key: string | undefined, baseUrl: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `${baseUrl}/v1/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${startDate}`;
    const json = await politeFetchJson<TradierHistoryResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    recordProviderCall("tradier", { service: "market-data", ok: true });
    const day = json?.history?.day;
    const days = Array.isArray(day) ? day : day ? [day] : [];
    const bars: OHLCBar[] = [];
    for (const d of days) {
      if (typeof d.close !== "number" || !Number.isFinite(d.close) || !d.date) continue;
      bars.push({ time: d.date, open: numOrUndef(d.open), high: numOrUndef(d.high), low: numOrUndef(d.low), close: d.close, volume: numOrUndef(d.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tradier", { service: "market-data", ok: false });
    return null;
  }
}

const twelveDataNumber = z.union([z.string(), z.number()]);

// `.passthrough()` on both objects is deliberate and the reason is recorded here rather than left
// implicit.  Twelve Data's `/time_series` payload carries a top-level `meta` block and each bar can
// carry keys beyond OHLCV.  `.strict()` was rejected on purpose: `fetchTwelveData` treats a
// `safeParse` failure as a provider outage and returns null, so a single unmodelled upstream key
// would silently drop every Twelve Data lookback in production instead of surfacing as a type
// error.  The `meta` block we know about is modelled explicitly below so that known drift stays
// visible in the type rather than being absorbed invisibly, and nothing downstream reads any of the
// passthrough keys.
export const TwelveDataBarSchema = z
  .object({
    datetime: z.string().min(1),
    open: twelveDataNumber.optional(),
    high: twelveDataNumber.optional(),
    low: twelveDataNumber.optional(),
    close: twelveDataNumber,
    volume: twelveDataNumber.optional()
  })
  .passthrough();

export const TwelveDataTimeSeriesSchema = z
  .object({
    status: z.string().optional(),
    // Twelve Data documents symbol / interval / currency / exchange / timezone / type.
    meta: z
      .object({
        symbol: z.string().optional(),
        interval: z.string().optional(),
        currency: z.string().optional(),
        exchange: z.string().optional(),
        timezone: z.string().optional(),
        type: z.string().optional()
      })
      .passthrough()
      .optional(),
    values: z.array(TwelveDataBarSchema).optional()
  })
  .passthrough();

export type TwelveDataBar = z.infer<typeof TwelveDataBarSchema>;
export type TwelveDataTimeSeries = z.infer<typeof TwelveDataTimeSeriesSchema>;

/**
 * Twelve Data daily time series. Free tier is credit-capped (same `twelvedata`
 * quota as quote enrichment). Used on lookbacks Massive cannot cover.
 */
async function fetchTwelveData(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  const credKey = await apiKeyFingerprint(key);
  if (admitProviderRequests("twelvedata", credKey, 1) < 1) return null;
  try {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1day&start_date=${startDate}&order=ASC&outputsize=5000&apikey=${encodeURIComponent(key)}`;
    const parsed = TwelveDataTimeSeriesSchema.safeParse(
      await politeFetchJson<unknown>(url, { headers: { Accept: "application/json" } })
    );
    if (!parsed.success || parsed.data.status === "error" || !Array.isArray(parsed.data.values)) {
      recordProviderCall("twelvedata", { service: "market-data", ok: false, label: usageLabel });
      return null;
    }
    const bars: OHLCBar[] = [];
    for (const row of parsed.data.values) {
      const close = Number(row.close);
      if (!row.datetime || !Number.isFinite(close)) continue;
      bars.push({
        time: row.datetime.slice(0, 10),
        open: numOrUndef(Number(row.open)),
        high: numOrUndef(Number(row.high)),
        low: numOrUndef(Number(row.low)),
        close,
        volume: numOrUndef(Number(row.volume))
      });
    }
    recordProviderCall("twelvedata", { service: "market-data", ok: bars.length >= 2, label: usageLabel });
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("twelvedata", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

interface TiingoPriceRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  adjOpen?: number;
  adjHigh?: number;
  adjLow?: number;
  adjClose?: number;
  adjVolume?: number;
}

/**
 * Tiingo EOD history (`/tiingo/daily/{ticker}/prices`) — 30+ years of split/dividend-adjusted daily
 * bars on the free Starter tier (50 req/hour, 1,000/day, 500 unique symbols/month). Admits against the
 * SAME "tiingo" quota bucket TiingoEnrichmentProvider uses (provider-rate-limit.ts RATE_QUOTAS), since
 * both draw on one real account-wide rate limit — a scan's enrichment calls must not let a chart's
 * history call (or vice versa) blow the hourly cap. Prefers adjOpen/High/Low/Close over the raw OHLC
 * (same technique fetchYahoo uses: scale raw O/H/L by adjClose/close so all four stay on one basis).
 */
async function fetchTiingo(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  const credKey = await apiKeyFingerprint(key);
  if (admitProviderRequests("tiingo", credKey, 1) < 1) return null; // hourly/daily budget exhausted this pass
  try {
    const url = `https://api.tiingo.com/tiingo/daily/${symbol.toLowerCase()}/prices?startDate=${startDate}&token=${key}`;
    const json = await politeFetchJson<TiingoPriceRow[]>(url, { headers: { Authorization: `Token ${key}`, Accept: "application/json" } });
    recordProviderCall("tiingo", { service: "market-data", ok: true, label: usageLabel });
    const rows = Array.isArray(json) ? json : [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (!r.date) continue;
      const rawClose = numOrUndef(r.close);
      const adjClose = numOrUndef(r.adjClose);
      const close = adjClose ?? rawClose;
      if (close === undefined) continue;
      let o = numOrUndef(r.open);
      let h = numOrUndef(r.high);
      let l = numOrUndef(r.low);
      if (adjClose !== undefined && rawClose !== undefined && rawClose !== 0) {
        const factor = adjClose / rawClose;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({ time: r.date.slice(0, 10), open: o, high: h, low: l, close, volume: numOrUndef(r.adjVolume ?? r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tiingo", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

interface MarketstackEodRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface MarketstackEodResponse {
  data?: MarketstackEodRow[];
}

/** Marketstack EOD — keyed fallback (free tier is monthly-capped, so secondary to Tradier). */
async function fetchMarketstack(symbol: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `https://api.marketstack.com/v1/eod?access_key=${key}&symbols=${encodeURIComponent(symbol)}&limit=1500&sort=ASC`;
    const json = await politeFetchJson<MarketstackEodResponse>(url, {});
    recordProviderCall("marketstack", { service: "market-data", ok: true, label: usageLabel });
    const rows = json?.data ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.close !== "number" || !Number.isFinite(r.close) || !r.date) continue;
      bars.push({ time: r.date, open: numOrUndef(r.open), high: numOrUndef(r.high), low: numOrUndef(r.low), close: r.close, volume: numOrUndef(r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("marketstack", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

async function fetchYahoo(
  symbol: string,
  opts?: { maxAttempts?: number; range?: "max" | "1y" }
): Promise<OHLCBar[] | null> {
  try {
    const range = opts?.range ?? "1y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const json = await fetchYahooChartJson<YahooChartResponse>(url, opts);
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    const rawClose = q?.close ?? [];
    // Prefer split+dividend-adjusted closes (adjclose) for correct multi-year returns.
    // Fall back to raw close if adjclose is absent or length-mismatched.
    const adjCloseArr = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const useAdjusted = adjCloseArr.length === ts.length;
    if (ts.length === 0 || rawClose.length === 0) return null;
    const bars: OHLCBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const rawC = rawClose[i] ?? null;
      // Per-bar fallback: if adjclose entry is null/non-finite use rawC so Yahoo gaps
      // in adjclose don't cause bars with valid rawclose to be silently dropped.
      const adjEntry = useAdjusted ? (adjCloseArr[i] ?? null) : null;
      const usingAdj = typeof adjEntry === "number" && Number.isFinite(adjEntry);
      const c = usingAdj ? adjEntry : rawC;
      if (typeof c !== "number" || !Number.isFinite(c)) continue; // skip null/holiday gaps
      // Scale O/H/L by adjclose/rawclose so all four OHLC values stay on the same basis.
      // Candle consistency: close cannot fall outside [low, high] after ex-dividend adjustments.
      let o = numOrUndef(q?.open?.[i]);
      let h = numOrUndef(q?.high?.[i]);
      let l = numOrUndef(q?.low?.[i]);
      if (usingAdj && typeof rawC === "number" && Number.isFinite(rawC) && rawC !== 0) {
        const factor = c / rawC;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({
        time: ts[i] * 1000, // seconds → ms epoch
        open: o, high: h, low: l,
        close: c,
        volume: numOrUndef(q?.volume?.[i])
      });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) into bars. Pure / unit-tested.
 * The cascade no longer CALLS Stooq (see the header comment — its endpoint sits behind a
 * proof-of-work bot wall as of 2026-08). Kept exported in case a future non-bot-walled CSV
 * source needs the same shape.
 */
export function parseStooqCsv(text: string): OHLCBar[] {
  const out: OHLCBar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips the header row
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    out.push({
      time: date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: c,
      volume: volume ? Number(volume) : undefined
    });
  }
  return out;
}

/** Normalize a bar's `time` (ms-epoch number or date string) to a 'YYYY-MM-DD' business day. */
export function toBusinessDay(time: number | string | undefined): string | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    const ms = time > 1e12 ? time : time * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof time === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10);
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return undefined;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clearHistoryCache(): void {
  cache.clear();
}

/**
 * congress.trade (App A) cache-aside source: App A's EOD close series for a symbol (or the S&P-500
 * via ^GSPC) as close-only OHLCBars. Returns null unless reads are enabled AND App A has ≥2 closes,
 * so the cascade falls through to App B's own providers on a miss. Self-guarded inside the client.
 */
async function fetchAppAHistory(symbol: string): Promise<OHLCBar[] | null> {
  if (!congressReadsEnabled()) return null;

  let closes: any[] = [];
  try {
    const client = getCongressTradeClient();
    if (symbol === "^GSPC") {
      closes = await client.getSpx();
    } else {
      const resp = await client.getPrices(symbol);
      closes = resp?.closes ?? [];
    }
  } catch (err) {
    // Ignore error, fallback logic kicks in
  }
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}

function importedHistoryTierEnabled(): boolean {
  const v = (process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Minimum imported closes before the local tier may short-circuit the cascade (avoids sparse gap-fills). */
function importedHistoryMinBars(): number {
  const v = Number(process.env.SECURITIES_IMPORT_MIN_BARS ?? 200);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200;
}

/**
 * Local imported-EOD cache tier (congress.trade return-path). Serves App A's gap-fill closes that were
 * POSTed to /api/admin/securities/import (persisted in imported_price_eod / imported_spx_eod). DEFAULT
 * OFF (SECURITIES_IMPORT_HISTORY_TIER_ENABLED) and density-guarded (SECURITIES_IMPORT_MIN_BARS, default
 * 200 ≈ ~10 months) so a sparse gap-fill never displaces a full fetch with an incomplete series.
 * A dense series still has to be fresh (latest bar covers the latest completed session) before it
 * may win. Otherwise the cascade continues, and these bars are only the all-sources-failed fallback.
 * Close-only bars (no OHLC), like the App A HTTP tier — an enabled price chart renders a line on hits.
 */
function fetchImportedHistory(symbol: string): OHLCBar[] | null {
  if (!importedHistoryTierEnabled()) return null;
  const closes = symbol === "^GSPC" ? getImportedSpxCloses() : getImportedPriceCloses(symbol);
  if (closes.length < importedHistoryMinBars()) return null;
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}



