// Outbound data-share to congress.trade (App A) — server-only.
//
// App A (congress.trade, a Cloudflare Worker backed by a DB) is the shared system-of-record
// for company reference + daily-close data. Both apps consume Financial Modeling Prep (FMP),
// which has a shared daily quota. To keep App A from spending that quota, this app forwards the
// company-reference + daily-close + S&P-500 data it ALREADY has to App A's idempotent import
// endpoint. App A upserts securities_ref / spx_eod / price_eod and recomputes per-trade anchors.
//
// NOTE on sourcing: this app does NOT fetch FMP /v3/profile or /v3/historical-price-full — its
// only FMP use is the fundamentals enrichment cascade (ratios/grades/insider/senate). The refs +
// closes we forward come from the app's existing sources (NASDAQ screener enrichment for refs;
// the history cascade Massive → Tradier → Marketstack → Yahoo → Stooq for closes). App A just
// needs the DATA, not FMP-sourced data, so sharing it still conserves App A's FMP quota.
//
// Safety: default OFF. Automatic forwarding (scan-refs + the nightly batch) runs only when
// CONGRESS_TRADE_TOKEN is set AND CONGRESS_SHARE_ENABLED is on. The admin route can trigger a
// manual run with just the token. The token is a server-only secret — never exposed to the browser.

import {
  API_PATHS,
  APP_B_ORIGIN_TAG,
  type PriceClose,
  type PriceSeries,
  type InsiderRow,
  type ShortVolumeRow,
  type FundamentalRow,
  type AnalystRow,
  type SharePayload,
  classifyTickerAlias,
  resolveContinuousTicker,
  resolveTickerAlias,
  SecurityRefInputSchema,
  PriceSeriesSchema,
  PriceCloseSchema,
  InsiderRowSchema,
  ShortVolumeRowSchema,
  FundamentalRowSchema,
  AnalystRowSchema,
  
} from "@jaywedgeworth22/congress-trading-shared";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "./operation-lease";
import { audit, getInternalSetting, getPolicy, listUsers, listWatchlistSymbols, setInternalSetting } from "./db";
import { createDurableMap } from "./durable-state";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import { INDEX_UNIVERSES, symbolsForPolicyUniverse } from "./index-universes";
import type { OHLCBar } from "./indicators";
import { fetchGroupedDailyBarsRange } from "./market-signals/massive-s3";
import { normalizeSymbol } from "./money";
import type { MarketQuote, MarketScan } from "./types";
import { getFinraDataset, getInsiderDataset, getInsiderSignals, getShortVolumeSignals } from "./web-sources";
const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 30_000; // App A upserts + recomputes per-trade perf anchors per call — give it room
const LAST_DAILY_RUN_KEY = "congress-share:lastDailyRunDate";

/**
 * Origin tag stamped on every outbound payload so the counterpart's receiver can recognize App B's
 * own rows and never echo them back into our store (the no-echo-loop guard). Our OWN inbound receiver
 * (POST /api/admin/securities/import) skips any payload carrying this origin. See docs/congress-trade-app-b-reply.md §1.3.
 * Re-exported from @jaywedgeworth22/congress-trading-shared as APP_B_ORIGIN_TAG.
 */
export const APP_B_ORIGIN = APP_B_ORIGIN_TAG;

// Per-POST sizing. The endpoint accepts up to ~2,000 tickers / ~20,000 closes, but App A's per-call
// work (row upserts + per-trade performance recompute) made big chunks blow the timeout in prod, so we
// keep each POST small and bounded — many small POSTs beat one timing-out megabatch.
const MAX_REFS_PER_POST = 2000; // refs are tiny (no closes) — fine in bulk
const MAX_TICKERS_PER_POST = 100; // bound per-POST perf recompute on App A
const CLOSE_BUDGET_PER_POST = 5_000; // bound per-POST upload + upsert
const MAX_ROWS_PER_POST = 500; // insider / short-volume rows per POST
const DEFAULT_MAX_CLOSES_PER_TICKER = 260; // ~1y; App A backfills deeper history itself

// ── Configuration / gating ────────────────────────────────────────────────────

/** The App A bearer token (ADMIN_TOKEN or INGEST_TOKEN). Server-only; trimmed; empty → undefined. */
export function congressTradeToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function congressTradeBaseUrl(): string {
  const base = (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim();
  return base.replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether AUTOMATIC forwarding (the scan-refs hook + the nightly batch) is enabled. Requires both
 * the token AND an explicit CONGRESS_SHARE_ENABLED opt-in, so a configured token alone never starts
 * silently pushing data off-box. The admin route bypasses the flag (token-only) for manual ops.
 */
export function isCongressShareAutoEnabled(): boolean {
  return congressTradeToken() !== undefined && flagOn(process.env.CONGRESS_SHARE_ENABLED);
}

/**
 * Whether to include fundamentals[]/analyst[] in the scan-hook push. Held OFF by default: App A's #46
 * tables don't exist until its migration runs, and pushing those rows earlier just errors them on App A
 * (the rest of the import is unaffected). Flip this on only after App A confirms #46 is applied.
 */
export function congressFundamentalsShareEnabled(): boolean {
  return flagOn(process.env.CONGRESS_SHARE_FUNDAMENTALS_ENABLED);
}

function maxDailyTickers(): number {
  // Caps the nightly UNIVERSE (chunked into MAX_TICKERS_PER_POST-sized POSTs), not the per-POST size.
  const v = Number(process.env.CONGRESS_SHARE_MAX_TICKERS ?? 2000);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 2000) : 2000;
}

/** Per-symbol close cap for the nightly price push — bounds payload (App A backfills deeper itself). */
function maxClosesPerTicker(): number {
  const v = Number(process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER ?? DEFAULT_MAX_CLOSES_PER_TICKER);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_CLOSES_PER_TICKER;
}

/** Split an array into fixed-size chunks (for insider / short-volume rows). */
function rowChunks<T>(rows: T[], size = MAX_ROWS_PER_POST): T[][] {
  if (rows.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function refTtlMs(): number {
  const v = Number(process.env.CONGRESS_SHARE_REF_TTL_MS ?? 6 * 60 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

// ── Payload types (mirror App A's import contract; we send subsets we have) ─────
// Many individual row types now come from @jaywedgeworth22/congress-trading-shared.
// CongressRef stays local because it uses optional (?) fields rather than T|null.

export type CongressAssetClass = "equity" | "etf" | "adr" | "fund" | "other";

export interface CongressRef {
  ticker: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  assetClass?: CongressAssetClass;
  isEtf?: boolean;
  isAdr?: boolean;
  country?: string;
  stateHq?: string;
  stateOfIncorp?: string;
  exchange?: string;
  exchangeShort?: string;
  currency?: string;
  marketCap?: number;
  ipoDate?: string;
  cik?: string;
  sicCode?: string;
  sicDescription?: string;
}

// Re-export shared types under the names congress-share consumers expect.
export type CongressClose = PriceClose;
export type CongressPrice = PriceSeries;
export type CongressInsider = InsiderRow;
export type CongressShortVol = ShortVolumeRow;
export type CongressFundamental = FundamentalRow;
export type CongressAnalyst = AnalystRow;

/**
 * Outbound share payload. Same wire shape as shared `SharePayload`; `refs` may
 * use the local optional-field builder (`CongressRef`) before schema validation
 * coerces them to `SecurityRefInput`.
 */
export type CongressSharePayload = Omit<SharePayload, "refs"> & {
  refs?: CongressRef[];
};

export interface CongressShareResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  response?: unknown;
  error?: string;
  /** Counts actually transmitted across all POSTs in this call. */
  sent: {
    refs: number;
    spx: number;
    prices: number;
    closes: number;
    insider: number;
    shortVolume: number;
    fundamentals: number;
    analyst: number;
    
  };
}

// ── Mappers (pure, unit-testable) ──────────────────────────────────────────────

/**
 * Canonicalize a symbol for OUTBOUND IDENTITY / company-ref rows: normalize (trim+upper) then
 * resolve corporate-action aliases via the shared map (FB->META, SQ->XYZ, ATVI->MSFT, ...). This is
 * display/identity resolution — acquisitions fold onto the acquirer so App A does not keep a dead
 * securities_ref row. For MARKET DATA (prices/fundamentals/analyst/insider/short-vol) use
 * `canonicalMarketDataSymbol` instead, which drops acquisition sources so their history is never
 * relabeled onto the acquirer. Well-formed non-aliased symbols (incl. share-class hyphens like
 * BRK-B) pass through unchanged.
 */
export function canonicalOutboundSymbol(symbol: string): string {
  return resolveTickerAlias(normalizeSymbol(symbol));
}

/**
 * Canonicalize a symbol for MARKET-DATA rows (price / fundamentals / analyst / insider /
 * short-volume). Uses the shared package's rename-vs-acquisition classification
 * (`classifyTickerAlias` / `resolveContinuousTicker` / curated `TICKER_RENAMES` +
 * `TICKER_ACQUISITIONS`) — do NOT hand-roll a local acquisition set.
 *
 * - RENAMES (FB->META, SQ->XYZ, …): fold to the current ticker (continuous series).
 * - ACQUISITIONS (ATVI, TWX, RHT, …): return `null` so the caller DROPS the row — an acquired
 *   ticker's numbers must never be relabeled onto the acquirer.
 * - Non-aliased well-formed symbols pass through unchanged.
 */
export function canonicalMarketDataSymbol(symbol: string): string | null {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  const classified = classifyTickerAlias(normalized);
  if (classified?.class === "acquisition") return null;
  return resolveContinuousTicker(normalized);
}

/**
 * Map an app MarketQuote/summary to a (partial) company ref. This app only knows
 * name/sector/industry/market-cap — never CIK, exchange, country, ipoDate, etc. — and every name
 * in the screener universe is an equity, so assetClass defaults to "equity". Undefined fields are
 * omitted (the endpoint accepts any subset). Returns null when there is no usable ticker.
 */
export function marketQuoteToRef(
  q: Pick<MarketQuote, "symbol" | "companyName" | "sector" | "industry" | "marketCap">
): CongressRef | null {
  const ticker = canonicalOutboundSymbol(q.symbol);
  if (!ticker) return null;
  const ref: CongressRef = { ticker, assetClass: "equity" };
  if (q.companyName) ref.companyName = q.companyName;
  if (q.sector) ref.sector = q.sector;
  if (q.industry) ref.industry = q.industry;
  if (typeof q.marketCap === "number" && Number.isFinite(q.marketCap) && q.marketCap > 0) {
    ref.marketCap = q.marketCap;
  }
  return ref;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a scanned MarketQuote's fundamentals to App A's import row (PR #46). `date` is the as-of day.
 * Returns null when the quote carries no fundamental values (nothing worth sending). App A saves App B's
 * FMP quota by accepting these — App B already fetched them during the scan.
 */
export function marketQuoteToFundamentals(
  q: Pick<MarketQuote, "symbol" | "peRatio" | "eps" | "beta" | "dividendYield" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow" | "fcfYield" | "debtToEquity" | "epsGrowth">,
  date: string
): CongressFundamental | null {
  const ticker = canonicalMarketDataSymbol(q.symbol); // renames only; drops acquired tickers
  if (!ticker) return null;
  const row: CongressFundamental = { ticker, date };
  const pe = numOrUndef(q.peRatio); if (pe !== undefined) row.peRatio = pe;
  const eps = numOrUndef(q.eps); if (eps !== undefined) row.eps = eps;
  const beta = numOrUndef(q.beta); if (beta !== undefined) row.beta = beta;
  const dy = numOrUndef(q.dividendYield); if (dy !== undefined) row.dividendYield = dy;
  const hi = numOrUndef(q.fiftyTwoWeekHigh); if (hi !== undefined) row.week52High = hi;
  const lo = numOrUndef(q.fiftyTwoWeekLow); if (lo !== undefined) row.week52Low = lo;
  const fcf = numOrUndef(q.fcfYield); if (fcf !== undefined) row.fcfYield = fcf;
  const de = numOrUndef(q.debtToEquity); if (de !== undefined) row.debtToEquity = de;
  const eg = numOrUndef(q.epsGrowth); if (eg !== undefined) row.epsGrowth = eg;
  // Only the ticker+date keys present → nothing real to share.
  return Object.keys(row).length > 2 ? row : null;
}

/**
 * Map a scanned MarketQuote's analyst consensus to App A's import row (PR #46). Blends the per-source
 * rating counts App B holds. Numeric price targets are included only when the opt-in FMP price-target
 * provider populated them on the quote (FMP_PRICE_TARGETS_ENABLED); otherwise omitted (App A fills null).
 */
export function marketQuoteToAnalyst(
  q: Pick<MarketQuote, "symbol" | "analystRating" | "analystBySource" | "targetMean" | "targetHigh" | "targetLow" | "targetMedian">,
  date: string
): CongressAnalyst | null {
  const ticker = canonicalMarketDataSymbol(q.symbol); // renames only; drops acquired tickers
  if (!ticker) return null;
  const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
  let haveCounts = false;
  for (const detail of Object.values(q.analystBySource ?? {})) {
    if (!detail?.counts) continue;
    haveCounts = true;
    counts.strongBuy += detail.counts.strongBuy ?? 0;
    counts.buy += detail.counts.buy ?? 0;
    counts.hold += detail.counts.hold ?? 0;
    counts.sell += detail.counts.sell ?? 0;
    counts.strongSell += detail.counts.strongSell ?? 0;
  }
  const tMean = numOrUndef(q.targetMean);
  const tHigh = numOrUndef(q.targetHigh);
  const tLow = numOrUndef(q.targetLow);
  const tMedian = numOrUndef(q.targetMedian);
  const haveTargets = tMean !== undefined || tHigh !== undefined || tLow !== undefined || tMedian !== undefined;
  if (!q.analystRating && !haveCounts && !haveTargets) return null;
  const row: CongressAnalyst = { ticker, date };
  if (q.analystRating) row.rating = q.analystRating;
  if (haveCounts) Object.assign(row, counts);
  if (tMean !== undefined) row.targetMean = tMean;
  if (tHigh !== undefined) row.targetHigh = tHigh;
  if (tLow !== undefined) row.targetLow = tLow;
  if (tMedian !== undefined) row.targetMedian = tMedian;
  return row;
}

/** Convert OHLC bars to deduped, date-sorted {date, close, volume?} closes (drops invalid bars). */
export function ohlcBarsToCloses(bars: OHLCBar[] | null | undefined): CongressClose[] {
  if (!bars || bars.length === 0) return [];
  const byDate = new Map<string, CongressClose>();
  for (const bar of bars) {
    const date = toBusinessDay(bar.time);
    const close = bar.close;
    if (!date || typeof close !== "number" || !Number.isFinite(close)) continue;
    const entry: CongressClose = { date, close };
    if (typeof bar.volume === "number" && Number.isFinite(bar.volume)) entry.volume = bar.volume;
    byDate.set(date, entry); // later bar for a given date wins
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // ascending
}

/** Build a per-ticker price entry from OHLC bars. currentPrice/currentPriceDate = most recent close. */
export function ohlcBarsToPriceEntry(symbol: string, bars: OHLCBar[] | null | undefined): CongressPrice | null {
  const ticker = canonicalMarketDataSymbol(symbol); // renames only; drops acquired tickers (never relabel bars onto the acquirer)
  if (!ticker) return null;
  const closes = ohlcBarsToCloses(bars);
  if (closes.length === 0) return null;
  const newest = closes[closes.length - 1]; // closes are ascending
  return { ticker, closes, currentPrice: newest.close, currentPriceDate: newest.date };
}

// ── Insider / short-volume import builders (App B's highest-fit datasets for App A) ──

/** Build App A insider rows from App B's cached SEC Form-4 dataset; shares summed per symbol. */
export function buildInsiderImport(): CongressInsider[] {
  const ds = getInsiderDataset();
  if (!ds || ds.filings.length === 0) return [];
  const agg = new Map<string, { buyShares: number; sellShares: number; date: string }>();
  for (const f of ds.filings) {
    const sym = normalizeSymbol(f.symbol);
    if (!sym) continue;
    const a = agg.get(sym) ?? { buyShares: 0, sellShares: 0, date: f.filedAt };
    a.buyShares += f.buyShares;
    a.sellShares += f.sellShares;
    if (f.filedAt > a.date) a.date = f.filedAt;
    agg.set(sym, a);
  }
  const symbols = Array.from(agg.keys());
  const signals = getInsiderSignals(symbols);
  const out: CongressInsider[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    const a = agg.get(sym);
    if (!sig || !a) continue;
    const ticker = canonicalMarketDataSymbol(sym);
    if (!ticker) continue; // acquired ticker — drop rather than relabel onto the acquirer
    out.push({
      ticker,
      date: a.date,
      sentiment: sig.insiderSentiment,
      buyFilings: sig.buyFilings,
      sellFilings: sig.sellFilings,
      buyShares: a.buyShares,
      sellShares: a.sellShares,
      owners: sig.owners
    });
  }
  return out.slice(0, maxDailyTickers());
}

/** Build App A short-volume rows from App B's cached FINRA dataset. */
export function buildShortVolumeImport(): CongressShortVol[] {
  const ds = getFinraDataset();
  const symbols = ds ? Object.keys(ds.ratios) : [];
  if (symbols.length === 0) return [];
  const signals = getShortVolumeSignals(symbols);
  const out: CongressShortVol[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    if (!sig) continue;
    const date = sig.asOf ?? ds?.asOf;
    if (!date) continue;
    const ticker = canonicalMarketDataSymbol(sym);
    if (!ticker) continue; // acquired ticker — drop rather than relabel onto the acquirer
    out.push({ ticker, date, ratio: sig.shortVolumeRatio, elevated: sig.elevated });
  }
  return out.slice(0, maxDailyTickers());
}

// ── Low-level POST ─────────────────────────────────────────────────────────────

function countCloses(payload: CongressSharePayload): number {
  let n = (payload.spx?.length ?? 0);
  for (const p of payload.prices ?? []) n += p.closes.length;
  return n;
}

/** Minimal shape of a shared Zod row schema (avoids importing `z` just for the parameter type). */
type RowSchema = { safeParse: (value: unknown) => { success: boolean } };

/**
 * Validate each dataset's rows against the shared row schemas and DROP any that fail, so malformed
 * data never reaches App A's import endpoint. Validation is PER-ROW (not whole-payload) so one bad
 * row never suppresses the valid rows in the same dataset — and it filters, rather than logs-and-sends
 * as the old code did. Rows that pass are returned verbatim (App A's importer accepts the extra
 * CongressRef fields the strict schema strips, so we never narrow a valid row's payload).
 * Returns the filtered payload plus a per-dataset dropped-row count for observability.
 */
export function dropInvalidShareRows(
  payload: CongressSharePayload,
): { payload: CongressSharePayload; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const filterRows = <T>(rows: T[] | undefined, schema: RowSchema, key: string): T[] | undefined => {
    if (!rows || rows.length === 0) return rows;
    const valid: T[] = [];
    let bad = 0;
    for (const row of rows) {
      if (schema.safeParse(row).success) valid.push(row);
      else bad++;
    }
    if (bad > 0) dropped[key] = bad;
    return valid;
  };
  return {
    payload: {
      ...payload,
      refs: filterRows(payload.refs, SecurityRefInputSchema, "refs"),
      prices: filterRows(payload.prices, PriceSeriesSchema, "prices"),
      spx: filterRows(payload.spx, PriceCloseSchema, "spx"),
      insider: filterRows(payload.insider, InsiderRowSchema, "insider"),
      shortVolume: filterRows(payload.shortVolume, ShortVolumeRowSchema, "shortVolume"),
      fundamentals: filterRows(payload.fundamentals, FundamentalRowSchema, "fundamentals"),
      analyst: filterRows(payload.analyst, AnalystRowSchema, "analyst"),
    },
    dropped,
  };
}

/**
 * POST one payload to App A's import endpoint. Idempotent + safe to resend. Self-guarded: never
 * throws — returns a structured result (skipped when no token; ok:false on transport/HTTP error).
 */
export async function shareWithCongressTrade(payload: CongressSharePayload): Promise<CongressShareResult> {
  // Drop schema-invalid rows BEFORE building the payload so malformed data never reaches App A;
  // `sent` (and the empty check) then reflect only what is actually transmitted.
  const { payload: clean, dropped } = dropInvalidShareRows(payload);
  if (Object.keys(dropped).length > 0) {
    console.warn("[congress-share] dropped schema-invalid rows before send:", dropped);
  }
  const sent = {
    refs: clean.refs?.length ?? 0,
    spx: clean.spx?.length ?? 0,
    prices: clean.prices?.length ?? 0,
    closes: countCloses(clean),
    insider: clean.insider?.length ?? 0,
    shortVolume: clean.shortVolume?.length ?? 0,
    fundamentals: clean.fundamentals?.length ?? 0,
    analyst: clean.analyst?.length ?? 0,
    
  };
  const token = congressTradeToken();
  if (!token) return { ok: false, skipped: true, reason: "no-token", sent };
  const total =
    sent.refs +
    sent.spx +
    sent.prices +
    sent.insider +
    sent.shortVolume +
    sent.fundamentals +
    sent.analyst;
  if (total === 0) {
    // Distinguish a genuinely-empty input (nothing to send → legitimate skip) from a payload whose
    // rows were ALL rejected by the shared schema. The latter is a real failure: counting it as a
    // skip would let the daily-run marker advance and silently swallow schema/API drift until the
    // next day. Returning skipped:false makes runCongressDailyShare count it in failedPosts.
    if (Object.keys(dropped).length > 0) {
      return { ok: false, skipped: false, reason: "all-rows-dropped", sent };
    }
    return { ok: false, skipped: true, reason: "empty", sent };
  }

  const url = `${congressTradeBaseUrl()}${API_PATHS.ADMIN_SECURITIES_IMPORT}`;
  const timeoutMs = Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Stamp our origin so the counterpart never echoes our own rows back to us (no-echo-loop guard).
    const body = { ...clean, origin: clean.origin ?? APP_B_ORIGIN_TAG };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[congress-share] import failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}`, sent };
    }
    const response = await res.json().catch(() => undefined);
    return { ok: true, status: res.status, response, sent };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Include payload sizes so a timeout/abort points at which dataset was too big.
    console.error(
      `[congress-share] import error: ${error} ` +
        `(refs=${sent.refs} spx=${sent.spx} prices=${sent.prices} closes=${sent.closes} ` +
        `insider=${sent.insider} shortVolume=${sent.shortVolume} fundamentals=${sent.fundamentals} analyst=${sent.analyst})`
    );
    return { ok: false, error, sent };
  } finally {
    clearTimeout(timer);
  }
}

// ── Chunking ────────────────────────────────────────────────────────────────────

/**
 * Greedily pack price entries into POST-sized chunks bounded by BOTH a close budget and a ticker
 * count. A single ticker carrying more closes than the budget is sent alone (truncating its history
 * to the most-recent `CLOSE_BUDGET_PER_POST` closes so one POST always stays under the ceiling).
 */
export function chunkPrices(
  prices: CongressPrice[],
  closeBudget = CLOSE_BUDGET_PER_POST,
  maxTickers = MAX_TICKERS_PER_POST
): CongressPrice[][] {
  const chunks: CongressPrice[][] = [];
  let current: CongressPrice[] = [];
  let closesInChunk = 0;
  for (const price of prices) {
    let entry = price;
    if (entry.closes.length > closeBudget) {
      const trimmed = entry.closes.slice(-closeBudget);
      entry = { ...entry, closes: trimmed };
    }
    const wouldExceedCloses = closesInChunk + entry.closes.length > closeBudget && current.length > 0;
    const wouldExceedTickers = current.length >= maxTickers;
    if (wouldExceedCloses || wouldExceedTickers) {
      chunks.push(current);
      current = [];
      closesInChunk = 0;
    }
    current.push(entry);
    closesInChunk += entry.closes.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Scan-refs forwarding (after each scan) ──────────────────────────────────────

// Per-symbol throttle so frequent scans don't re-POST the same refs. Durable (survives a process
// restart): the app now auto-deploys on every merge to main, and without this a redeploy would make
// every symbol look "never shared" to the very next scan, re-POSTing refs shared minutes earlier.
// Low stakes either way (App A's import endpoint is idempotent — worst case is redundant, harmless
// network calls, per the module header above), so debounced (not immediate) flush is fine here.
// Lazily created (not at module top level) — see provider-rate-limit.ts's quotaStore() for why
// eagerly calling createDurableMap() at import time risks a circular-import TDZ crash.
let refSentAtInstance: ReturnType<typeof createDurableMap<number>> | undefined;
function refSentAt(): ReturnType<typeof createDurableMap<number>> {
  return refSentAtInstance ?? (refSentAtInstance = createDurableMap<number>("congress-share-ref-throttle"));
}

/**
 * Forward the scan's candidate company refs — plus the fundamentals + analyst consensus App B just
 * fetched for them — to App A. The scan already paid for this data, so sharing it lets App A skip its
 * own FMP calls (PR #46 import slots). Fire-and-forget friendly + self-guarded; no-op unless automatic
 * sharing is enabled; per-symbol throttled (default 6h) so it never spams. Fundamentals/analyst are
 * HELD OFF (refs still flow) until CONGRESS_SHARE_FUNDAMENTALS_ENABLED is set — App A's #46 tables don't
 * exist until its migration runs, and pushing those rows earlier errors them on App A.
 */
export async function shareScanRefs(scan: Pick<MarketScan, "topCandidates">): Promise<CongressShareResult | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    const now = Date.now();
    const ttl = refTtlMs();
    const date = utcDate(now);
    // Held OFF until App A's #46 migration is live (pushing these rows earlier errors them on App A).
    const includeFundamentals = congressFundamentalsShareEnabled();
    const refs: CongressRef[] = [];
    const fundamentals: CongressFundamental[] = [];
    const analyst: CongressAnalyst[] = [];
    const claimed: string[] = [];
    for (const quote of scan.topCandidates ?? []) {
      const ref = marketQuoteToRef(quote);
      if (!ref) continue;
      const sentAt = refSentAt().get(ref.ticker);
      if (sentAt !== undefined && now - sentAt < ttl) continue; // throttled
      refs.push(ref);
      if (includeFundamentals) {
        const f = marketQuoteToFundamentals(quote, date);
        if (f) fundamentals.push(f);
        const a = marketQuoteToAnalyst(quote, date);
        if (a) analyst.push(a);
      }
      claimed.push(ref.ticker);
      // Optimistically claim BEFORE the await so concurrent scans don't double-POST the same ref.
      refSentAt().set(ref.ticker, now);
      if (refs.length >= MAX_REFS_PER_POST) break;
    }
    if (refs.length === 0) return null;
    const result = await shareWithCongressTrade({ refs, fundamentals, analyst });
    if (!result.ok) {
      // Roll back the throttle so a later scan retries the failed refs (don't spam on success).
      for (const ticker of claimed) refSentAt().delete(ticker);
    }
    return result;
  } catch (err) {
    console.error("[congress-share] shareScanRefs error:", err);
    return null;
  }
}

/** Test seam: reset the in-memory scan-refs throttle. */
export function resetCongressRefThrottle(): void {
  refSentAt().clear();
}

// ── Nightly daily-close + S&P-500 batch ─────────────────────────────────────────

/** UTC calendar date (YYYY-MM-DD) for the given epoch ms. */
function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** True when the once-per-day batch has not yet run for `now`'s UTC date and isn't in failure backoff. Pure (no env gate). */
export function isCongressDailyShareDue(now: number): boolean {
  const last = getInternalSetting<string>(LAST_DAILY_RUN_KEY);
  if (last === utcDate(now)) return false;
  
  // 60-minute backoff after a failure to prevent unbounded retry storms
  const lastFailure = getInternalSetting<number>("congress_share_last_failure_ms");
  if (lastFailure && now - lastFailure < 60 * 60 * 1000) return false;
  
  return true;
}

/** Union of every user's watchlist symbols + policy-universe symbols (what this app monitors). */
function collectMonitoredSymbols(): string[] {
  const set = new Set<string>();
  for (const userId of listUsers()) {
    try {
      const policy = getPolicy(userId);
      for (const s of symbolsForPolicyUniverse(policy)) {
        const sym = normalizeSymbol(s);
        if (sym) set.add(sym);
      }
      for (const item of listWatchlistSymbols(userId)) {
        const sym = normalizeSymbol(item.symbol);
        if (sym) set.add(sym);
      }
    } catch {
      // one user's DB error must not block the others
    }
  }
  return Array.from(set);
}

/** Union of every STATIC index universe's members (dynamic-source universes contribute no static symbols). */
export function allIndexUniverseSymbols(): string[] {
  const set = new Set<string>();
  for (const cfg of Object.values(INDEX_UNIVERSES)) {
    for (const s of cfg.symbols) {
      const sym = normalizeSymbol(s);
      if (sym) set.add(sym);
    }
  }
  return Array.from(set);
}

/** Bounded-concurrency async map (gentle on the upstream history providers). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunCongressDailyShareOptions {
  now?: number;
  /** Bypass the once-per-day date gate (the admin/manual path passes true). */
  force?: boolean;
  /** Override the universe (admin targeted test). When set, the date marker is NOT advanced. */
  symbols?: string[];
  /**
   * Deep-history backfill: send each symbol's FULL available history (skip the per-symbol close cap)
   * so App A can compute performance back to old trade dates. Still chunked into small bounded POSTs.
   * Use one-time / on-demand via the admin route; the recurring nightly run leaves this off (light).
   */
  fullHistory?: boolean;
  /**
   * Source full history from Massive flat files (bulk per-day downloads pivoted to per-ticker series)
   * instead of N per-ticker REST calls. Scales to a broad universe; falls back to the per-ticker source
   * for any symbol absent from the flat files. Best paired with `fullHistory` + `allIndexes`.
   */
  flatFile?: boolean;
  /**
   * Expand the (non-custom) universe to the union of every STATIC index universe (S&P 500, Nasdaq-100,
   * Dow 30, …) plus the monitored symbols — for a broad cross-index backfill. Still capped by maxDailyTickers.
   */
  allIndexes?: boolean;
  /** Opaque durable claim supplied by the outer admin guard; background callers omit it. */
  operationLeaseClaim?: OperationLeaseClaim;
}

export interface CongressDailyShareSummary {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  tickers: number;
  priced: number;
  spxRows: number;
  insiderRows: number;
  shortVolRows: number;
  posts: number;
  failedPosts: number;
  sent: { spx: number; prices: number; closes: number; insider: number; shortVolume: number };
  responses?: unknown[];
}

let activeDailySharePromise: Promise<OperationLeaseAware<CongressDailyShareSummary>> | null = null;

/**
 * Collect the monitored universe's daily closes + the S&P-500 (^GSPC) series and POST them to App A
 * in capped chunks. Reuses the app's history cache, so a name fetched earlier in the day is free.
 * Self-guarded; safe to fire-and-forget. The scheduler calls the gated wrapper below; the admin
 * route calls this with force:true.
 */
export async function runCongressDailyShare(
  options: RunCongressDailyShareOptions = {}
): Promise<OperationLeaseAware<CongressDailyShareSummary>> {
  if (activeDailySharePromise) {
    return activeDailySharePromise;
  }
  
  const promise = (async () => {
    const now = options.now ?? Date.now();
    const empty = {
      tickers: 0, priced: 0, spxRows: 0, insiderRows: 0, shortVolRows: 0,
      posts: 0, failedPosts: 0, sent: { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 }
    };
    if (!congressTradeToken()) return { ok: false, skipped: true, reason: "no-token", ...empty };

    const customUniverse = Array.isArray(options.symbols) && options.symbols.length > 0;
    if (!options.force && !customUniverse && !isCongressDailyShareDue(now)) {
      return { ok: false, skipped: true, reason: "not-due", ...empty };
    }

    const guarded = await runWithOperationLease(
      {
        group: OPERATION_LEASE_GROUPS.CONGRESS_SHARE,
        operation: "congress-share",
        claim: options.operationLeaseClaim
      },
      async (claim, signal) => runCongressDailyShareUnlocked(options, claim, signal)
    );
    if (!guarded.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: "operation-in-flight",
        ...empty,
        operationLease: guarded.busy
      };
    }
    return guarded.value;
  })();

  activeDailySharePromise = promise;
  try {
    return await promise;
  } finally {
    activeDailySharePromise = null;
  }
}

async function runCongressDailyShareUnlocked(
  options: RunCongressDailyShareOptions,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<CongressDailyShareSummary> {
  const now = options.now ?? Date.now();
  const empty = {
    tickers: 0, priced: 0, spxRows: 0, insiderRows: 0, shortVolRows: 0,
    posts: 0, failedPosts: 0, sent: { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 }
  };
  if (!congressTradeToken()) return { ok: false, skipped: true, reason: "no-token", ...empty };
  const customUniverse = Array.isArray(options.symbols) && options.symbols.length > 0;
  // Recheck after durable acquisition: another process may have completed and advanced the daily
  // marker after this caller's cheap pre-check but before it won the lease.
  if (!options.force && !customUniverse && !isCongressDailyShareDue(now)) {
    return { ok: false, skipped: true, reason: "not-due", ...empty };
  }
  assertOperationLeaseOwnership(operationLeaseClaim);
  const baseUniverse = customUniverse
    ? options.symbols!
    : options.allIndexes
      ? [...allIndexUniverseSymbols(), ...collectMonitoredSymbols()]
      : collectMonitoredSymbols();
  const universe = Array.from(new Set(baseUniverse.map(normalizeSymbol).filter(Boolean))).slice(0, maxDailyTickers());

  // S&P-500 daily closes (^GSPC) — sent once per day regardless of the ticker universe.
  let spx: CongressClose[] = [];
  throwIfOperationLeaseCancelled(operationLeaseSignal);
  try {
    spx = ohlcBarsToCloses(await fetchDailyOHLC("^GSPC", now));
  } catch (err) {
    console.error("[congress-share] SPX fetch failed:", err);
  }

  const concurrency = Number(process.env.CONGRESS_SHARE_CONCURRENCY ?? 4) || 4;
  // Deep-history backfill sends each symbol's FULL series (still chunked into small POSTs); the nightly
  // run caps to the most-recent N closes (App A backfills deeper itself) to keep each POST under the wall.
  const maxCloses = options.fullHistory ? Number.POSITIVE_INFINITY : maxClosesPerTicker();
  const capCloses = (entry: CongressPrice | null): CongressPrice | null => {
    if (entry && entry.closes.length > maxCloses) entry.closes = entry.closes.slice(-maxCloses);
    return entry;
  };
  const perTicker = async (symbols: string[]): Promise<CongressPrice[]> =>
    (
      await mapPool(symbols, concurrency, async (symbol) => {
        throwIfOperationLeaseCancelled(operationLeaseSignal);
        try {
          return capCloses(ohlcBarsToPriceEntry(symbol, await fetchDailyOHLC(symbol, now)));
        } catch {
          return null;
        }
      })
    ).filter((p): p is CongressPrice => p !== null);

  let priceEntries: CongressPrice[];
  if (options.flatFile) {
    // Bulk path: one pass over the flat files for the whole universe, then per-ticker fallback for misses
    // (or when flat-file download isn't granted, in which case the whole universe falls back).
    const years = Number(process.env.MASSIVE_FLATFILE_BACKFILL_YEARS ?? 5) || 5;
    const toISO = toBusinessDay(now) ?? new Date(now).toISOString().slice(0, 10);
    const fromISO = new Date(now - years * 365 * 86_400_000).toISOString().slice(0, 10);
    let seriesBySymbol = new Map<string, OHLCBar[]>();
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    try {
      seriesBySymbol = await fetchGroupedDailyBarsRange(fromISO, toISO, { tickers: universe });
    } catch (err) {
      console.error("[congress-share] flat-file range fetch failed; falling back per-ticker:", err);
    }
    const entries: CongressPrice[] = [];
    const missing: string[] = [];
    for (const symbol of universe) {
      const bars = seriesBySymbol.get(symbol);
      const entry = bars && bars.length ? capCloses(ohlcBarsToPriceEntry(symbol, bars)) : null;
      if (entry) entries.push(entry);
      else missing.push(symbol);
    }
    priceEntries = [...entries, ...(await perTicker(missing))];
  } else {
    priceEntries = await perTicker(universe);
  }

  // App B's two highest-fit datasets for congress.trade — already cached locally, sent once/day.
  const insider = customUniverse ? [] : buildInsiderImport();
  const shortVolume = customUniverse ? [] : buildShortVolumeImport();

  // Send each dataset as its OWN bounded POST(s) rather than one bundled megabatch: App A's per-call
  // work (upserts + per-trade perf recompute) made big combined payloads exceed the timeout, and a
  // bundled POST also let one oversized dataset abort the rest. Independent small POSTs each succeed.
  const payloads: CongressSharePayload[] = [];
  if (spx.length > 0) payloads.push({ spx });
  for (const rows of rowChunks(insider)) payloads.push({ insider: rows });
  for (const rows of rowChunks(shortVolume)) payloads.push({ shortVolume: rows });
  for (const prices of chunkPrices(priceEntries)) payloads.push({ prices });

  const responses: unknown[] = [];
  let posts = 0;
  let failedPosts = 0;
  const sent = { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 };
  for (const payload of payloads) {
    assertOperationLeaseOwnership(operationLeaseClaim);
    const result = await shareWithCongressTrade(payload);
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    posts++;
    if (result.ok) {
      responses.push(result.response);
      sent.spx += result.sent.spx;
      sent.prices += result.sent.prices;
      sent.closes += result.sent.closes;
      sent.insider += result.sent.insider;
      sent.shortVolume += result.sent.shortVolume;
    } else if (!result.skipped) {
      failedPosts++;
    }
  }

  const ok = posts > 0 && failedPosts === 0;
  // Advance the once-per-day marker only for the real scheduled universe (not admin custom-symbol tests).
  if (!customUniverse) {
    assertOperationLeaseOwnership(operationLeaseClaim);
    try {
      if (ok) {
        setInternalSetting(LAST_DAILY_RUN_KEY, utcDate(now));
      } else {
        setInternalSetting("congress_share_last_failure_ms", now);
      }
    } catch (err) {
      console.error("[congress-share] failed to persist daily-run or failure marker:", err);
    }
  }

  const summary: CongressDailyShareSummary = {
    ok,
    tickers: universe.length,
    priced: priceEntries.length,
    spxRows: spx.length,
    insiderRows: insider.length,
    shortVolRows: shortVolume.length,
    posts,
    failedPosts,
    sent,
    responses
  };
  try {
    audit("congress_share_daily", {
      ok,
      reason: posts === 0 ? "nothing-to-send" : undefined,
      tickers: summary.tickers,
      priced: summary.priced,
      spxRows: summary.spxRows,
      insiderRows: summary.insiderRows,
      shortVolRows: summary.shortVolRows,
      posts,
      failedPosts,
      sent,
      custom: customUniverse
    });
  } catch {
    // audit is best-effort
  }
  return summary;
}

/**
 * Scheduler entry point: run the nightly batch at most once per UTC day, only when automatic
 * sharing is enabled. Self-guarded; returns null when disabled/not due so the tick stays clean.
 */
export async function runCongressDailyShareIfDue(
  now: number = Date.now()
): Promise<OperationLeaseAware<CongressDailyShareSummary> | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    if (!isCongressDailyShareDue(now)) return null;
    return await runCongressDailyShare({ now });
  } catch (err) {
    console.error("[congress-share] daily batch error:", err);
    return null;
  }
}
