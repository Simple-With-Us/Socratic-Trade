// Read client for congress.trade (App A) — server-only, cache-aside + congress source.
//
// App A also pulls FMP (its own key + cron + backfill) and exposes public, read-only endpoints
// that mirror the import payload shapes, plus a congressional-trade feed. App B reads App A FIRST
// and only falls back to its own providers/FMP on a miss — so whoever fetches a given symbol first
// pays for it once. This is the reverse of `congress-share.ts` (which PUSHES to App A's import
// endpoint).
//
// Two independent gates (both default OFF, so all of this is inert until enabled):
//   • CONGRESS_TRADE_READS_ENABLED        → market reads (bundle/ref/refs/prices/spx) cache-aside
//   • CONGRESS_TRADE_AS_CONGRESS_SOURCE   → the /api/transactions congressional feed
// Fully self-guarded — a slow/erroring App A never breaks an App B fetch; it just falls through.
//
// Endpoints (from App A's app/docs/fmp-data-sharing.md):
//   GET /api/market/bundle/{T}?from=&to=  -> { ref, prices:{ticker,closes,currentPrice,...}, spx }
//   GET /api/market/ref/{T}               -> { ref }
//   GET /api/market/refs?tickers=A,B,C    -> { refs:[...] }   (<=500)
//   GET /api/market/prices/{T}?from=&to=  -> { ticker, closes, currentPrice, currentPriceDate }
//   GET /api/market/spx?from=&to=         -> { closes }
//   GET /api/transactions?since=&ticker=&member=&chamber=&type=&limit=

import type {
  TransactionsPage,
  TransactionsQuery,
  FundamentalRow,
  AnalystRow,
  TickerLeader,
  ClusterBuy,
  MemberLeader,
  MemberPerformance,
  ConvictionTicker,
  BacktestHorizon,
  TickerBacktest,
  CommitteeConflict,
  PriceClose,
  PriceSeries,
} from "@jaywedgeworth22/congress-trading-shared";
import {
  API_PATHS,
  CongressTradeClient,
  MAX_REFS_BATCH,
  TransactionsPageSchema,
} from "@jaywedgeworth22/congress-trading-shared";
import type { CongressRef } from "./congress-share";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { logApiHealth } from "./db-health";

const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface AppABundle {
  ref: CongressRef | null;
  prices: PriceSeries | null;
  spx: PriceClose[];
}

// Re-export shared types under the names congress-trade-client consumers expect.
export type AppATransactionsPage = TransactionsPage;
export type AppATransactionsQuery = TransactionsQuery;
export type AppAFundamental = FundamentalRow & { source?: string | null; updatedAt?: string };
export type AppAAnalyst = AnalystRow & { analystCount?: number | null; source?: string | null; updatedAt?: string };
export type AppATickerLeader = TickerLeader;
export type AppAClusterRow = ClusterBuy;
export type AppAMemberRow = MemberLeader;
export type AppAMemberPerformance = MemberPerformance;
export type AppAConvictionTicker = ConvictionTicker;
export type AppABacktestHorizon = BacktestHorizon;
export type AppATickerBacktest = TickerBacktest;
export type AppAConflict = CommitteeConflict;

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Whether App B should read App A's MARKET cache (refs/prices/spx) before its own providers. */
export function congressReadsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_READS_ENABLED);
}

/** Whether App B should read App A's FUNDAMENTALS/ANALYST cache as an enrichment tier.
 *  Gated SEPARATELY from market/price reads (`CONGRESS_TRADE_READS_ENABLED`) so enabling
 *  the price cache-aside doesn't also give App A precedence over the direct fundamentals
 *  providers (Finnhub/FMP/Yahoo). Default OFF — an explicit, independent opt-in. */
export function congressFundamentalsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED);
}

/** Whether App B should source congressional trades from App A's /api/transactions feed. */
export function congressAsCongressSourceEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE);
}

/** Optional bearer for App A's public reads (market + transactions are public; token only if gated). */
function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function timeoutMs(): number {
  const v = Number(process.env.CONGRESS_TRADE_READ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function createTimedHealthFetch(timeout: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      logApiHealth({ service: "congress.trade", ok: res.ok, latencyMs: Date.now() - start, errorText: res.ok ? undefined : `HTTP ${res.status}` });
      return res;
    } catch (err) {
      logApiHealth({ service: "congress.trade", ok: false, latencyMs: Date.now() - start, errorText: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Get a shared CongressTradeClient configured with health logging, timeouts, and auth. */
function getClient(): CongressTradeClient {
  return new CongressTradeClient({
    baseUrl: baseUrl(),
    token: readToken(),
    fetch: createTimedHealthFetch(timeoutMs()),
  });
}

/** One round-trip: ref + closes + spx for a ticker. Null when reads are off / on any error. */
export async function getAppABundle(ticker: string, opts?: { from?: string; to?: string }): Promise<AppABundle | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try {
    const bundle = await getClient().getBundle(sym, opts);
    return { ref: bundle.ref as CongressRef | null, prices: bundle.prices, spx: bundle.spx };
  } catch {
    return null;
  }
}

export async function getAppARef(ticker: string): Promise<CongressRef | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try {
    return (await getClient().getRef(sym)) as CongressRef | null;
  } catch {
    return null;
  }
}

export async function getAppARefs(tickers: string[]): Promise<CongressRef[]> {
  if (!congressReadsEnabled()) return [];
  const syms = Array.from(new Set(tickers.map(normalizeSymbol).filter(Boolean)));
  if (syms.length === 0) return [];
  try {
    return (await getClient().getRefs(syms)) as unknown as CongressRef[];
  } catch {
    return [];
  }
}

export async function getAppAPrices(ticker: string, opts?: { from?: string; to?: string }): Promise<PriceSeries | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try {
    return await getClient().getPrices(sym, opts);
  } catch {
    return null;
  }
}

export async function getAppASpx(opts?: { from?: string; to?: string }): Promise<PriceClose[]> {
  if (!congressReadsEnabled()) return [];
  try {
    return await getClient().getSpx(opts);
  } catch {
    return [];
  }
}

/** Read App A's cached fundamentals (P/E, EPS, beta, 52w, FCF, debt/equity…) so App B
 *  doesn't re-pay a provider for data App A already stored. [] when the gate is off / on error. */
export async function getAppAFundamentals(ticker: string, opts?: { from?: string; to?: string }): Promise<AppAFundamental[]> {
  if (!congressFundamentalsEnabled()) return [];
  const sym = normalizeSymbol(ticker);
  if (!sym) return [];
  try {
    return await getClient().getFundamentals(sym, opts) as AppAFundamental[];
  } catch {
    return [];
  }
}

/** Read App A's cached analyst consensus + price targets. [] when off / on error. */
export async function getAppAAnalyst(ticker: string, opts?: { from?: string; to?: string }): Promise<AppAAnalyst[]> {
  if (!congressFundamentalsEnabled()) return [];
  const sym = normalizeSymbol(ticker);
  if (!sym) return [];
  try {
    return await getClient().getAnalyst(sym, opts) as AppAAnalyst[];
  } catch {
    return [];
  }
}

/** Pull a page of congressional transactions. Null when the congress-source gate is off / on error. */
export async function getAppATransactions(query: AppATransactionsQuery = {}): Promise<AppATransactionsPage | null> {
  if (!congressAsCongressSourceEnabled()) return null;
  try {
    const json = await getClient().getTransactions(query);
    if (!json || !Array.isArray(json.transactions)) return null;
    // Validate response shape at runtime.
    const parsed = TransactionsPageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("[congress-trade-client] transactions page validation failed:", parsed.error.flatten());
    }
    return json;
  } catch {
    return null;
  }
}

// ── App A analytics (the public "Trends" composite) ──────────────────────────
// App A computes aggregate congressional analytics App B can't derive from raw trades alone:
// dollar-weighted net flow, distinct-member counts, cluster buys (many members → same ticker), and
// member performance leaderboards. Public, no token. Gated on CONGRESS_ANALYTICS_ENABLED (default off).

/** Whether App B reads App A's congressional analytics overlay. */
export function congressAnalyticsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_ANALYTICS_ENABLED);
}

export async function getAppATickerLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<AppATickerLeader[]> {
  if (!congressAnalyticsEnabled()) return [];
  try {
    return await getClient().getTickerLeaderboard(opts);
  } catch {
    return [];
  }
}

export async function getAppAClusterBuys(opts: { window?: string; limit?: number } = {}): Promise<AppAClusterRow[]> {
  if (!congressAnalyticsEnabled()) return [];
  try {
    return await getClient().getClusterBuys(opts);
  } catch {
    return [];
  }
}

export async function getAppAMemberLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<AppAMemberRow[]> {
  if (!congressAnalyticsEnabled()) return [];
  try {
    return await getClient().getMemberLeaderboard(opts);
  } catch {
    return [];
  }
}

/** Per-member realized performance (return / win-rate / alpha vs S&P). `scoredCount`=0 → all nulls.
 *  Now a type alias for MemberPerformance from the shared package. */
export async function getAppAMemberPerformance(filerId: string): Promise<AppAMemberPerformance | null> {
  if (!congressAnalyticsEnabled() || !filerId) return null;
  try {
    return await getClient().getMemberPerformance(filerId);
  } catch {
    return null;
  }
}

/**
 * Convert App A's {date, close} series to OHLCBars (close-only — open/high/low/volume undefined,
 * which OHLCBar permits). Suitable for close-series consumers (technical/returns); a price chart
 * fed from these renders a line, not candles. Ascending by date.
 */
export function appAClosesToBars(closes: PriceClose[] | null | undefined): OHLCBar[] {
  if (!closes || closes.length === 0) return [];
  return closes
    .filter((c) => c && typeof c.close === "number" && Number.isFinite(c.close) && typeof c.date === "string")
    .map((c) => ({
      time: c.date,
      close: c.close,
      ...(typeof c.volume === "number" && Number.isFinite(c.volume) ? { volume: c.volume } : {})
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

// ── New analytics endpoints (App A PR #77/79/80) ───────────────────────────────
// AppAConvictionTicker → type alias for ConvictionTicker from shared package.
// AppABacktestHorizon → type alias for BacktestHorizon from shared package.
// AppATickerBacktest → type alias for TickerBacktest from shared package.
// AppAConflict → type alias for CommitteeConflict from shared package.

/**
 * Per-ticker composite conviction score (0–100). Direction-aware: a high score on a SELL ticker
 * means strong bearish conviction. `convictionScore` is `null` (not 0) when the signal is too thin
 * (resolved-side trades < 3) so callers can distinguish "no signal" from "bearish".
 */

export async function getAppAConviction(opts: { window?: string; limit?: number } = {}): Promise<AppAConvictionTicker[]> {
  if (!congressAnalyticsEnabled()) return [];
  try {
    return await getClient().getConviction(opts);
  } catch {
    return [];
  }
}

/**
 * Per-horizon post-buy return stats for a ticker (congressional backtest).
 * `n` is the number of buy events with full forward price history; horizons with n < 5 report null stats.
 * Returns are fractions: 0.18 = +18%. `winRate` = share beating the S&P (excess > 0).
 */

export async function getAppATickerBacktest(
  ticker: string,
  opts: { window?: string; horizons?: string; filerId?: string } = {}
): Promise<AppATickerBacktest | null> {
  if (!congressAnalyticsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try {
    return await getClient().getTickerBacktest(sym, opts);
  } catch {
    return null;
  }
}

/**
 * Trades flagged as potential committee conflicts of interest (member sits on a committee
 * overseeing the traded stock's GICS sector). Educational/observational — not an accusation
 * of wrongdoing. ETFs (no single sector) are not flagged.
 */

export async function getAppAConflicts(
  opts: { window?: string; limit?: number; chamber?: string; party?: string } = {}
): Promise<AppAConflict[]> {
  if (!congressAnalyticsEnabled()) return [];
  try {
    return await getClient().getConflicts(opts);
  } catch {
    return [];
  }
}
