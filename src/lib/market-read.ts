// Token-gated market-data READ side of the congress.trade (App A) price bridge.
//
// App B (this app) already PUSHES refs/prices/spx to App A (src/lib/congress-share.ts) and RECEIVES
// gap-fills back (app/api/admin/securities/import). These read endpoints complete the loop: they let
// App A PULL App B's daily EOD bars over HTTP (cache-aside), served in the exact PriceSeries /
// { closes } envelopes the shared CongressTradeClient parses
// (@jaywedgeworth22/congress-trading-shared: /api/market/prices/{ticker}, /api/market/spx).
// Company profiles for App A enrichment: /api/market/profile/{symbol} → { ref } / 404 { ref: null }.
//
// Auth lives in the route handlers (verifySecuritiesImportToken — the same APP_B_INGEST_TOKEN bearer
// secret as the import receiver); middleware only passes bearer requests through.
//
// Bars come from fetchDailyOHLC — the app's single daily-OHLC cascade (local imported-EOD tier →
// App A → Massive → Tradier → Marketstack → Yahoo → Stooq, briefly cached in-process). SPX is served
// as SPY daily bars — the benchmark convention the consumer already uses. Contract notes:
//   - closes are DESCENDING by date (newest first) — App A treats closes[0] as the latest close;
//   - from/to are optional, inclusive YYYY-MM-DD; an omitted `from` defaults to ~1y back, `to` to today;
//   - unknown symbols / empty ranges return 200 with empty closes.  Congress.Trade treats that
//     200 as "this source has nothing" and only falls back on a genuine non-200.
//   - a series whose newest close is behind the latest completed session is 502
//     { ok: false, error: "stale" }.  An empty 200 there would suppress that fallback.
//     404 stays reserved for a missing company profile.

import type { OHLCBar } from "./indicators";
import { fetchDailyOHLC } from "./history";
import { normalizeSymbol } from "./money";
import { fetchNasdaqScreenerResponse } from "./nasdaq-screener-fetch";
import {
  closesCoverLatestSession,
  marketQuoteToRef,
  ohlcBarsToCloses,
  type CongressClose,
  type CongressPrice,
  type CongressRef
} from "./congress-share";
import { recordCongressStalePriceWithheld } from "./sentry-metrics";

/** Injectable daily-OHLC fetcher; the routes use the app's canonical cascade, tests inject canned bars. */
export type DailyOHLCFetcher = (symbol: string) => Promise<OHLCBar[] | null>;

/** Peer-serving default: the canonical cascade minus its App A read-back tier. A request App A
 *  itself originated must not be echoed back at App A — it asks precisely because its own series
 *  needs topping up, so the echo can only return the stale closes App A already holds (one
 *  guaranteed-wasted HTTP hop per cache miss, App A's route is read-only so the loop is 1-hop). */
const peerServingFetcher: DailyOHLCFetcher = (symbol) =>
  fetchDailyOHLC(symbol, Date.now(), undefined, { skipAppATier: true, usageLabel: "congress-read" });

/** Resolved inclusive YYYY-MM-DD bounds for a market read (defaults already applied). */
export interface MarketRange {
  from: string;
  to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Default lookback when `from` is omitted — a sensible recent window (~1y of trading days). */
const DEFAULT_LOOKBACK_DAYS = 366;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse `from`/`to` query params (inclusive, YYYY-MM-DD). Missing/invalid values fall back to the
 *  default recent window — the read contract stays 200-with-data rather than failing on a bad param. */
export function parseMarketRange(url: string, now: Date = new Date()): MarketRange {
  const sp = new URL(url).searchParams;
  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");
  const to = rawTo && ISO_DATE.test(rawTo) ? rawTo : isoDay(now);
  const from =
    rawFrom && ISO_DATE.test(rawFrom)
      ? rawFrom
      : isoDay(new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000));
  return { from, to };
}

/** Inclusive date-window filter; preserves the input order. */
export function closesInRange(closes: CongressClose[], from: string, to: string): CongressClose[] {
  return closes.filter((c) => c.date >= from && c.date <= to);
}

/** Confirmed series, or a stale tail the route must answer with HTTP 502. */
export type PriceSeriesRead =
  | { kind: "ok"; series: CongressPrice }
  | { kind: "stale" };

/** Confirmed SPY closes, or a stale tail the route must answer with HTTP 502. */
export type SpxClosesRead =
  | { kind: "ok"; closes: CongressClose[] }
  | { kind: "stale" };

/**
 * Build the /api/market/prices/{ticker} envelope: closes DESCENDING within [from, to], plus
 * currentPrice/currentPriceDate taken from the newest close of the FULL series (range-independent, so
 * a historical-backfill response still reports the true latest).  No bars → `{ kind: "ok" }` with
 * empty closes and null currentPrice.  The route returns that as HTTP 200.
 * A series whose newest close is behind the latest completed session is `{ kind: "stale" }`.
 * The route returns HTTP 502.  Congress.Trade treats closes[0] as the current price, and an
 * empty 200 means "this source has nothing", so a stale tail must not use that envelope.
 */
export async function fetchPriceSeries(
  rawSymbol: string,
  range: MarketRange,
  fetcher: DailyOHLCFetcher = peerServingFetcher,
  nowMs: number = Date.now()
): Promise<PriceSeriesRead> {
  const ticker = normalizeSymbol(rawSymbol);
  const bars = ticker ? await fetcher(ticker) : null;
  const ascending = ohlcBarsToCloses(bars); // deduped, date-ascending
  if (ascending.length > 0 && !closesCoverLatestSession(ascending, nowMs)) {
    recordCongressStalePriceWithheld("pull", 1);
    return { kind: "stale" };
  }
  const closes = closesInRange(ascending, range.from, range.to).reverse(); // DESC — closes[0] is latest
  const newest = ascending[ascending.length - 1];
  return {
    kind: "ok",
    series: {
      ticker,
      closes,
      currentPrice: newest?.close ?? null,
      currentPriceDate: newest?.date ?? null
    }
  };
}

/**
 * Build the /api/market/spx payload: SPY daily bars (the consumer's S&P 500 benchmark convention),
 * DESCENDING within [from, to]. `{ kind: "ok", closes: [] }` when no bars are available.
 * A SPY series behind the latest completed session is `{ kind: "stale" }` (HTTP 502 at the route).
 */
export async function fetchSpxCloses(
  range: MarketRange,
  fetcher: DailyOHLCFetcher = peerServingFetcher,
  nowMs: number = Date.now()
): Promise<SpxClosesRead> {
  const ascending = ohlcBarsToCloses(await fetcher("SPY"));
  if (ascending.length > 0 && !closesCoverLatestSession(ascending, nowMs)) {
    recordCongressStalePriceWithheld("pull", 1);
    return { kind: "stale" };
  }
  return { kind: "ok", closes: closesInRange(ascending, range.from, range.to).reverse() };
}

// ── Company profile (peer enrichment for Congress.Trade) ─────────────────────
//
// Contract expected by CT `enrichment/socratic.ts`:
//   GET /api/market/profile/{symbol}
//   200 { ref: ProfileRef }
//   404 { ref: null }   — symbol unknown (envelope so CT keeps asking others)
// Auth + rate-limit live in the route handler (same bearer as prices/quotes).


/** Peer profile shape — a subset of SecurityRef / CongressRef. */
export type ProfileRef = CongressRef;

export type ProfileLookup = (symbol: string) => Promise<ProfileRef | null>;

/** In-process screener map (ticker → ref), TTL-aligned with other peer caches. */
let screenerProfileCache: { expiresAt: number; byTicker: Map<string, ProfileRef> } | null = null;
const SCREENER_PROFILE_TTL_MS = 5 * 60_000;

function parseScreenerMarketCap(raw: unknown): number | undefined {
  const marketCapStr = String(raw ?? "").replace(/[$,%\s,]/g, "");
  const marketCap = Number(marketCapStr);
  return Number.isFinite(marketCap) && marketCap > 0 ? marketCap : undefined;
}

async function loadScreenerProfileMap(now = Date.now()): Promise<Map<string, ProfileRef>> {
  if (screenerProfileCache && screenerProfileCache.expiresAt > now) {
    return screenerProfileCache.byTicker;
  }
  try {
    const response = await fetchNasdaqScreenerResponse("congress-nasdaq-screener");
    // Only cache successful HTTP responses. Transient failures / non-OK must not
    // poison the 5m TTL with an empty map (valid symbols would 404 until expiry).
    if (!response.ok) {
      return new Map();
    }
    const payload = (await response.json()) as {
      data?: { table?: { rows?: Array<Record<string, unknown>> } };
    };
    const rows = Array.isArray(payload?.data?.table?.rows) ? payload.data.table.rows : [];
    const byTicker = new Map<string, ProfileRef>();
    for (const row of rows) {
      const ref = marketQuoteToRef({
        symbol: String(row.symbol ?? ""),
        companyName: typeof row.name === "string" ? row.name : undefined,
        sector: typeof row.sector === "string" ? row.sector : undefined,
        industry: typeof row.industry === "string" ? row.industry : undefined,
        marketCap: parseScreenerMarketCap(row.marketCap)
      });
      if (ref) byTicker.set(ref.ticker, ref);
    }
    // Successful empty screener (legitimately zero rows) is still cacheable.
    screenerProfileCache = { expiresAt: now + SCREENER_PROFILE_TTL_MS, byTicker };
    return byTicker;
  } catch (err) {
    console.warn("[market-read] screener profile map failed:", err);
    // Leave any prior (expired) cache alone; return empty without writing TTL
    // so the next call retries immediately.
    return new Map();
  }
}

/** Test seam: drop the screener profile cache. */
export function clearScreenerProfileCacheForTests(): void {
  screenerProfileCache = null;
}

/**
 * Resolve a company profile for peer enrichment. Prefers the local imported
 * securities_ref cache (no network), then the keyless Nasdaq delayed screener.
 * Returns null when the symbol is unknown — the route turns that into 404 `{ ref: null }`.
 */
export async function fetchCompanyProfile(
  rawSymbol: string,
  lookup: ProfileLookup | undefined = undefined
): Promise<ProfileRef | null> {
  const ticker = normalizeSymbol(rawSymbol);
  if (!ticker) return null;
  if (lookup) return lookup(ticker);

  try {
    const { getImportedRef } = await import("./db-securities-import");
    const imported = getImportedRef(ticker);
    if (imported) {
      const ref: ProfileRef = {
        ticker: imported.ticker,
        assetClass: (imported.assetClass as ProfileRef["assetClass"]) ?? "equity"
      };
      if (imported.companyName) ref.companyName = imported.companyName;
      if (imported.sector) ref.sector = imported.sector;
      if (imported.industry) ref.industry = imported.industry;
      if (imported.exchange) ref.exchange = imported.exchange;
      if (imported.currency) ref.currency = imported.currency;
      if (typeof imported.marketCap === "number" && Number.isFinite(imported.marketCap) && imported.marketCap > 0) {
        ref.marketCap = imported.marketCap;
      }
      if (imported.cik) ref.cik = imported.cik;
      return ref;
    }
  } catch (err) {
    // DB may be unavailable in some test/edge contexts — fall through to screener.
    console.warn("[market-read] imported profile lookup failed:", err);
  }

  const map = await loadScreenerProfileMap();
  return map.get(ticker) ?? null;
}
