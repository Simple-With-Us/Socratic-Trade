// Weekly value + momentum screens computed from ST's own tape.
//
// These are the native version of the owner's Perplexity weekly ritual:
//   1. Deep value: large-cap, trailing P/E ≤ 10, within 10% of the 52-week low.
//   2. Momentum: liquid large-caps ranked by 5-day return, with ROC / RSI / MA stack.
//
// Rules:
//   - Never fabricate a number.  Missing P/E, 52-week low, market cap, volume, or bars
//     means the name is excluded from the screen that needs that field, and the digest
//     says so.
//   - Use the FULL scan universe (quotesBySymbol + topCandidates), not the ranked cut
//     alone — deep-value names near lows lose the momentum-weighted ranker.
//   - Dashboard path is sync and I/O-free (cache or value-only from the persisted scan).
//   - Bar work lives in the scheduler / explicit refresh.  Massive grouped-daily ranks
//     5-day returns across the tape; per-symbol OHLC fills ROC/RSI/MAs for the leaders.
//   - Advisory DATA only.  Does not change scoringWeights, policy, or sizing.

import { audit, getInternalSetting, getPolicy, listUsers, setInternalSetting } from "./db";
import { invalidateDashboardSnapshotCache } from "./dashboard-snapshot-cache";
import { getSymbolFieldLatestBySymbol } from "./db-fundamentals";
import { rocPct, rsiSeries, sma, type OHLCBar } from "./indicators";
import { newestPersistedMarketScan } from "./market-scan-freshness";
import { normalizeSymbol } from "./money";
import type { MarketQuote, MarketQuoteSummary, MarketScan } from "./types";

export const WEEKLY_DIGEST_MIN_MARKET_CAP_USD = 10_000_000_000;
export const WEEKLY_DIGEST_MIN_PRICE = 5;
export const WEEKLY_DIGEST_MIN_VOLUME = 500_000;
export const WEEKLY_DIGEST_MAX_TRAILING_PE = 10;
export const WEEKLY_DIGEST_MAX_PCT_ABOVE_52W_LOW = 10;
export const WEEKLY_DIGEST_VALUE_LIMIT = 15;
export const WEEKLY_DIGEST_MOMENTUM_LIMIT = 10;
export const WEEKLY_DIGEST_DETAIL_BAR_BUDGET = 15;
export const WEEKLY_DIGEST_FALLBACK_BAR_BUDGET = 80;
export const WEEKLY_DIGEST_GROUPED_CALENDAR_DAYS = 10;
export const WEEKLY_DIGEST_CACHE_TTL_MS = 6 * 60 * 60_000;

const CACHE_KEY_PREFIX = "weeklyMarketDigest:cache";
const WATERMARK_KEY_PREFIX = "weeklyMarketDigest:lastRefreshScan";

export const WEEKLY_DIGEST_FILTERS = {
  minMarketCapUsd: WEEKLY_DIGEST_MIN_MARKET_CAP_USD,
  minPrice: WEEKLY_DIGEST_MIN_PRICE,
  minVolume: WEEKLY_DIGEST_MIN_VOLUME,
  maxTrailingPe: WEEKLY_DIGEST_MAX_TRAILING_PE,
  maxPctAbove52wLow: WEEKLY_DIGEST_MAX_PCT_ABOVE_52W_LOW,
  valueLimit: WEEKLY_DIGEST_VALUE_LIMIT,
  momentumLimit: WEEKLY_DIGEST_MOMENTUM_LIMIT
} as const;

export type WeeklyDigestStatus = "ready" | "value_only" | "pending";
export type WeeklyDigestRsiZone = "oversold" | "neutral" | "overbought";
export type WeeklyDigestVsMa = "above" | "below";

export interface WeeklyDigestName {
  symbol: string;
  companyName?: string;
  sector?: string;
  price: number;
  volume?: number;
  marketCap?: number;
  peRatio?: number;
  fiftyTwoWeekLow?: number;
  pctAbove52wLow?: number;
  return5d?: number;
  roc14?: number;
  roc21?: number;
  rsi14?: number;
  rsiZone?: WeeklyDigestRsiZone;
  sma20?: number;
  sma50?: number;
  sma200?: number;
  vsSma20?: WeeklyDigestVsMa;
  vsSma50?: WeeklyDigestVsMa;
  vsSma200?: WeeklyDigestVsMa;
  asOf?: string;
}

export interface WeeklyMarketDigest {
  generatedAt: string;
  status: WeeklyDigestStatus;
  scanGeneratedAt?: string;
  scanSource?: string;
  universeSize: number;
  valueEvaluated: number;
  momentumRanked: number;
  barsCovered: number;
  groupedDaysUsed: number;
  filters: typeof WEEKLY_DIGEST_FILTERS;
  value: WeeklyDigestName[];
  momentum: WeeklyDigestName[];
  overlap: string[];
  warnings: string[];
}

export interface DigestQuote {
  symbol: string;
  companyName?: string;
  sector?: string;
  price: number;
  volume?: number;
  marketCap?: number;
  sharesOutstanding?: number;
  peRatio?: number;
  fiftyTwoWeekLow?: number;
  asOf?: string;
}

export interface WeeklyDigestCache {
  scanGeneratedAt: string;
  digest: WeeklyMarketDigest;
  storedAt: string;
}

function cacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}:${userId}`;
}

function watermarkKey(userId: string): string {
  return `${WATERMARK_KEY_PREFIX}:${userId}`;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function impliedMarketCapUsd(quote: Pick<DigestQuote, "marketCap" | "sharesOutstanding" | "price">): number | undefined {
  if (finitePositive(quote.marketCap)) return quote.marketCap;
  if (finitePositive(quote.sharesOutstanding) && finitePositive(quote.price)) {
    return quote.sharesOutstanding * quote.price;
  }
  return undefined;
}

/** Percent the price sits above the 52-week low.  0 = at the low.  Undefined when either input is missing. */
export function pctAbove52wLow(price: number, fiftyTwoWeekLow: number): number | undefined {
  if (!finitePositive(price) || !finitePositive(fiftyTwoWeekLow)) return undefined;
  return ((price / fiftyTwoWeekLow) - 1) * 100;
}

export function rsiZoneFrom(rsi14: number | undefined): WeeklyDigestRsiZone | undefined {
  if (!finiteNumber(rsi14)) return undefined;
  if (rsi14 < 30) return "oversold";
  if (rsi14 > 70) return "overbought";
  return "neutral";
}

export function vsMa(price: number, ma: number | undefined): WeeklyDigestVsMa | undefined {
  if (!finitePositive(price) || !finitePositive(ma)) return undefined;
  return price >= ma ? "above" : "below";
}

export function computeMomentumFromCloses(closes: number[]): Pick<
  WeeklyDigestName,
  "return5d" | "roc14" | "roc21" | "rsi14" | "rsiZone" | "sma20" | "sma50" | "sma200"
> {
  const return5d = rocPct(closes, 5);
  const roc14 = rocPct(closes, 14);
  const roc21 = rocPct(closes, 21);
  const rsiArr = rsiSeries(closes, 14);
  const rsi14 = rsiArr[rsiArr.length - 1];
  return {
    ...(finiteNumber(return5d) ? { return5d: round(return5d, 2) } : {}),
    ...(finiteNumber(roc14) ? { roc14: round(roc14, 2) } : {}),
    ...(finiteNumber(roc21) ? { roc21: round(roc21, 2) } : {}),
    ...(finiteNumber(rsi14) ? { rsi14: round(rsi14, 1), rsiZone: rsiZoneFrom(rsi14) } : {}),
    ...(finitePositive(sma(closes, 20)) ? { sma20: round(sma(closes, 20) as number, 2) } : {}),
    ...(finitePositive(sma(closes, 50)) ? { sma50: round(sma(closes, 50) as number, 2) } : {}),
    ...(finitePositive(sma(closes, 200)) ? { sma200: round(sma(closes, 200) as number, 2) } : {})
  };
}

export function computeMomentumFromBars(bars: OHLCBar[]): ReturnType<typeof computeMomentumFromCloses> {
  const closes = bars
    .map((bar) => bar.close)
    .filter((close): close is number => finitePositive(close));
  return computeMomentumFromCloses(closes);
}

function takeBetterNumber(a: number | undefined, b: number | undefined): number | undefined {
  if (finitePositive(a)) return a;
  if (finitePositive(b)) return b;
  return finiteNumber(a) ? a : finiteNumber(b) ? b : undefined;
}

export function digestQuoteFromScanRow(row: MarketQuote | MarketQuoteSummary | DigestQuote): DigestQuote | undefined {
  const symbol = normalizeSymbol(row.symbol);
  if (!symbol) return undefined;
  const price = finitePositive(row.price) ? row.price : undefined;
  if (!price) return undefined;
  const volume = "volume" in row ? takeBetterNumber(row.volume, undefined) : undefined;
  const marketCap = impliedMarketCapUsd({
    marketCap: "marketCap" in row ? row.marketCap : undefined,
    sharesOutstanding: "sharesOutstanding" in row ? row.sharesOutstanding : undefined,
    price
  });
  return {
    symbol,
    ...(typeof row.companyName === "string" && row.companyName.trim() ? { companyName: row.companyName } : {}),
    ...(typeof row.sector === "string" && row.sector.trim() ? { sector: row.sector } : {}),
    price,
    ...(finitePositive(volume) ? { volume } : {}),
    ...(finitePositive(marketCap) ? { marketCap } : {}),
    ...("sharesOutstanding" in row && finitePositive(row.sharesOutstanding)
      ? { sharesOutstanding: row.sharesOutstanding }
      : {}),
    ...("peRatio" in row && finiteNumber(row.peRatio) ? { peRatio: row.peRatio } : {}),
    ...("fiftyTwoWeekLow" in row && finitePositive(row.fiftyTwoWeekLow)
      ? { fiftyTwoWeekLow: row.fiftyTwoWeekLow }
      : {}),
    ...(typeof row.asOf === "string" && row.asOf ? { asOf: row.asOf } : {})
  };
}

function mergeDigestQuotes(primary: DigestQuote, incoming: DigestQuote): DigestQuote {
  return {
    symbol: primary.symbol,
    companyName: primary.companyName ?? incoming.companyName,
    sector: primary.sector ?? incoming.sector,
    price: primary.price,
    volume: takeBetterNumber(primary.volume, incoming.volume),
    marketCap: takeBetterNumber(primary.marketCap, incoming.marketCap),
    sharesOutstanding: takeBetterNumber(primary.sharesOutstanding, incoming.sharesOutstanding),
    peRatio: finiteNumber(primary.peRatio) ? primary.peRatio : incoming.peRatio,
    fiftyTwoWeekLow: takeBetterNumber(primary.fiftyTwoWeekLow, incoming.fiftyTwoWeekLow),
    asOf: primary.asOf ?? incoming.asOf
  };
}

/** Full scan tape: summaries first, then topCandidates overwrite with the richer row. */
export function collectDigestUniverse(scan: Pick<MarketScan, "topCandidates" | "quotesBySymbol">): DigestQuote[] {
  const bySymbol = new Map<string, DigestQuote>();
  for (const row of Object.values(scan.quotesBySymbol ?? {})) {
    const quote = digestQuoteFromScanRow(row);
    if (!quote) continue;
    const existing = bySymbol.get(quote.symbol);
    bySymbol.set(quote.symbol, existing ? mergeDigestQuotes(existing, quote) : quote);
  }
  for (const row of scan.topCandidates ?? []) {
    const quote = digestQuoteFromScanRow(row);
    if (!quote) continue;
    const existing = bySymbol.get(quote.symbol);
    bySymbol.set(quote.symbol, existing ? mergeDigestQuotes(quote, existing) : quote);
  }
  return Array.from(bySymbol.values());
}

export function hydrateDigestUniverse(
  quotes: DigestQuote[],
  fieldStore: Record<string, Record<string, { value: unknown }>>
): DigestQuote[] {
  return quotes.map((quote) => {
    const fields = fieldStore[quote.symbol] ?? fieldStore[normalizeSymbol(quote.symbol)] ?? {};
    const readNum = (field: string): number | undefined => {
      const value = fields[field]?.value;
      return finiteNumber(value) ? value : undefined;
    };
    const peRatio = finiteNumber(quote.peRatio) ? quote.peRatio : readNum("peRatio");
    const fiftyTwoWeekLow = takeBetterNumber(quote.fiftyTwoWeekLow, readNum("fiftyTwoWeekLow"));
    const volume = takeBetterNumber(quote.volume, readNum("volume"));
    const sharesOutstanding = takeBetterNumber(quote.sharesOutstanding, readNum("sharesOutstanding"));
    const marketCap = impliedMarketCapUsd({
      marketCap: takeBetterNumber(quote.marketCap, readNum("marketCap")),
      sharesOutstanding,
      price: quote.price
    });
    return {
      ...quote,
      ...(finiteNumber(peRatio) ? { peRatio } : {}),
      ...(finitePositive(fiftyTwoWeekLow) ? { fiftyTwoWeekLow } : {}),
      ...(finitePositive(volume) ? { volume } : {}),
      ...(finitePositive(sharesOutstanding) ? { sharesOutstanding } : {}),
      ...(finitePositive(marketCap) ? { marketCap } : {})
    };
  });
}

export function passesLiquidityFloor(quote: DigestQuote): boolean {
  return quote.price > WEEKLY_DIGEST_MIN_PRICE && finitePositive(quote.volume) && quote.volume >= WEEKLY_DIGEST_MIN_VOLUME;
}

export function passesLargeCap(quote: DigestQuote): boolean {
  const cap = impliedMarketCapUsd(quote);
  return finitePositive(cap) && cap >= WEEKLY_DIGEST_MIN_MARKET_CAP_USD;
}

export function passesValueScreen(quote: DigestQuote): boolean {
  if (!passesLiquidityFloor(quote) || !passesLargeCap(quote)) return false;
  if (!finitePositive(quote.peRatio) || quote.peRatio > WEEKLY_DIGEST_MAX_TRAILING_PE) return false;
  const pct = pctAbove52wLow(quote.price, quote.fiftyTwoWeekLow ?? NaN);
  return finiteNumber(pct) && pct <= WEEKLY_DIGEST_MAX_PCT_ABOVE_52W_LOW;
}

function toDigestName(
  quote: DigestQuote,
  momentum?: ReturnType<typeof computeMomentumFromCloses>
): WeeklyDigestName {
  const pct = pctAbove52wLow(quote.price, quote.fiftyTwoWeekLow ?? NaN);
  const price = quote.price;
  return {
    symbol: quote.symbol,
    ...(quote.companyName ? { companyName: quote.companyName } : {}),
    ...(quote.sector ? { sector: quote.sector } : {}),
    price,
    ...(finitePositive(quote.volume) ? { volume: quote.volume } : {}),
    ...(finitePositive(quote.marketCap) ? { marketCap: quote.marketCap } : {}),
    ...(finiteNumber(quote.peRatio) ? { peRatio: quote.peRatio } : {}),
    ...(finitePositive(quote.fiftyTwoWeekLow) ? { fiftyTwoWeekLow: quote.fiftyTwoWeekLow } : {}),
    ...(finiteNumber(pct) ? { pctAbove52wLow: round(pct, 2) } : {}),
    ...(momentum ?? {}),
    ...(momentum?.sma20 ? { vsSma20: vsMa(price, momentum.sma20) } : {}),
    ...(momentum?.sma50 ? { vsSma50: vsMa(price, momentum.sma50) } : {}),
    ...(momentum?.sma200 ? { vsSma200: vsMa(price, momentum.sma200) } : {}),
    ...(quote.asOf ? { asOf: quote.asOf } : {})
  };
}

export function buildWeeklyMarketDigest(input: {
  quotes: DigestQuote[];
  closesBySymbol?: Record<string, number[]>;
  generatedAt?: string;
  scanGeneratedAt?: string;
  scanSource?: string;
  groupedDaysUsed?: number;
  status?: WeeklyDigestStatus;
  extraWarnings?: string[];
}): WeeklyMarketDigest {
  const warnings: string[] = [...(input.extraWarnings ?? [])];
  const closesBySymbol = input.closesBySymbol ?? {};
  let missingPe = 0;
  let missingLow = 0;
  let missingCap = 0;
  let missingVolume = 0;
  let pennyOrIlliquid = 0;

  for (const quote of input.quotes) {
    if (!finitePositive(quote.volume) || quote.volume < WEEKLY_DIGEST_MIN_VOLUME || quote.price <= WEEKLY_DIGEST_MIN_PRICE) {
      pennyOrIlliquid += 1;
    }
    if (!finiteNumber(quote.peRatio) || quote.peRatio <= 0) missingPe += 1;
    if (!finitePositive(quote.fiftyTwoWeekLow)) missingLow += 1;
    if (!passesLargeCap(quote)) missingCap += 1;
    if (!finitePositive(quote.volume)) missingVolume += 1;
  }

  const valuePool = input.quotes.filter(passesValueScreen);
  const value = valuePool
    .map((quote) => toDigestName(quote, computeMomentumFromCloses(closesBySymbol[quote.symbol] ?? [])))
    .sort((a, b) => {
      const pctA = a.pctAbove52wLow ?? Number.POSITIVE_INFINITY;
      const pctB = b.pctAbove52wLow ?? Number.POSITIVE_INFINITY;
      if (pctA !== pctB) return pctA - pctB;
      return (a.peRatio ?? Number.POSITIVE_INFINITY) - (b.peRatio ?? Number.POSITIVE_INFINITY);
    })
    .slice(0, WEEKLY_DIGEST_VALUE_LIMIT);

  const liquidLarge = input.quotes.filter((quote) => passesLiquidityFloor(quote) && passesLargeCap(quote));
  const withReturn = liquidLarge
    .map((quote) => {
      const momentum = computeMomentumFromCloses(closesBySymbol[quote.symbol] ?? []);
      return { quote, momentum };
    })
    .filter((row) => finiteNumber(row.momentum.return5d));
  const momentum = withReturn
    .sort((a, b) => (b.momentum.return5d ?? Number.NEGATIVE_INFINITY) - (a.momentum.return5d ?? Number.NEGATIVE_INFINITY))
    .slice(0, WEEKLY_DIGEST_MOMENTUM_LIMIT)
    .map((row) => toDigestName(row.quote, row.momentum));

  const valueSymbols = new Set(value.map((row) => row.symbol));
  const overlap = momentum.filter((row) => valueSymbols.has(row.symbol)).map((row) => row.symbol);

  if (value.length === 0) {
    warnings.push(
      "No names pass the value screen (large-cap, trailing P/E ≤ 10, within 10% of the 52-week low, liquid).  That is a real empty set, not a fetch miss."
    );
  }
  if (input.status === "value_only" || (momentum.length === 0 && Object.keys(closesBySymbol).length === 0)) {
    warnings.push("Momentum is waiting on daily bars.  Value uses this scan's live quotes only.");
  } else if (momentum.length === 0) {
    warnings.push("No liquid large-caps had a 5-day return in the bar window.");
  }
  if (missingPe > 0 || missingLow > 0 || missingCap > 0 || missingVolume > 0) {
    warnings.push(
      `Skipped incomplete rows — no P/E: ${missingPe}, no 52-week low: ${missingLow}, no large-cap print: ${missingCap}, no volume: ${missingVolume}.  ${pennyOrIlliquid} names failed the $5 / 500k-share floor.`
    );
  }
  if (overlap.length === 0 && value.length > 0 && momentum.length > 0) {
    warnings.push("No overlap: deep value near lows and 5-day winners are disjoint in this tape.");
  }

  const barsCovered = Object.values(closesBySymbol).filter((closes) => closes.length >= 6).length;
  const status: WeeklyDigestStatus =
    input.status ??
    (barsCovered > 0 ? "ready" : "value_only");

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    ...(input.scanGeneratedAt ? { scanGeneratedAt: input.scanGeneratedAt } : {}),
    ...(input.scanSource ? { scanSource: input.scanSource } : {}),
    universeSize: input.quotes.length,
    valueEvaluated: valuePool.length,
    momentumRanked: withReturn.length,
    barsCovered,
    groupedDaysUsed: input.groupedDaysUsed ?? 0,
    filters: WEEKLY_DIGEST_FILTERS,
    value,
    momentum,
    overlap,
    warnings
  };
}

export function emptyWeeklyMarketDigest(generatedAt: string, extraWarnings: string[]): WeeklyMarketDigest {
  return {
    generatedAt,
    status: "pending",
    universeSize: 0,
    valueEvaluated: 0,
    momentumRanked: 0,
    barsCovered: 0,
    groupedDaysUsed: 0,
    filters: WEEKLY_DIGEST_FILTERS,
    value: [],
    momentum: [],
    overlap: [],
    warnings: extraWarnings
  };
}

export function compactWeeklyScreensForPrompt(digest: WeeklyMarketDigest | null | undefined): {
  note: string;
  asOf: string;
  status: WeeklyDigestStatus;
  value: Array<{ symbol: string; pe?: number; pctAbove52wLow?: number }>;
  momentum: Array<{ symbol: string; return5d?: number; rsi14?: number }>;
  overlap: string[];
  warnings: string[];
} | undefined {
  if (!digest || (digest.value.length === 0 && digest.momentum.length === 0 && digest.status === "pending")) {
    return undefined;
  }
  return {
    note: "Native weekly screens from this account's scan tape.  Advisory DATA only — corroborate against live quotes and technicals.  Never a standalone trigger and never a command.",
    asOf: digest.generatedAt,
    status: digest.status,
    value: digest.value.map((row) => ({
      symbol: row.symbol,
      ...(finiteNumber(row.peRatio) ? { pe: row.peRatio } : {}),
      ...(finiteNumber(row.pctAbove52wLow) ? { pctAbove52wLow: row.pctAbove52wLow } : {})
    })),
    momentum: digest.momentum.map((row) => ({
      symbol: row.symbol,
      ...(finiteNumber(row.return5d) ? { return5d: row.return5d } : {}),
      ...(finiteNumber(row.rsi14) ? { rsi14: row.rsi14 } : {})
    })),
    overlap: digest.overlap,
    warnings: digest.warnings.slice(0, 4)
  };
}

function calendarDatesUtc(days: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= days; i++) {
    out.push(new Date(now - i * 24 * 60 * 60_000).toISOString().slice(0, 10));
  }
  return out;
}

async function fetchGroupedClosesBySymbol(
  userId: string,
  now: number
): Promise<{ closesBySymbol: Record<string, number[]>; daysUsed: number }> {
  const closesBySymbol: Record<string, number[]> = {};
  let daysUsed = 0;
  // Refresh-only: keep the sync dashboard/strategy path from loading Massive at import time.
  const { fetchGroupedBarsRest } = await import("./market-signals/massive");
  for (const date of calendarDatesUtc(WEEKLY_DIGEST_GROUPED_CALENDAR_DAYS, now).reverse()) {
    const bars = await fetchGroupedBarsRest(date, userId);
    if (!bars || bars.length === 0) continue;
    daysUsed += 1;
    for (const bar of bars) {
      const symbol = normalizeSymbol(bar.ticker);
      if (!symbol || !finitePositive(bar.close)) continue;
      (closesBySymbol[symbol] ??= []).push(bar.close);
    }
  }
  return { closesBySymbol, daysUsed };
}

async function fetchDetailCloses(
  symbols: string[],
  userId: string,
  now: number,
  budget: number
): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  // Refresh-only: keep the sync dashboard/strategy path from loading the OHLC cascade at import time.
  const { fetchDailyOHLC } = await import("./history");
  const unique = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean))).slice(0, budget);
  const concurrency = 4;
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const rows = await Promise.all(
      batch.map(async (symbol) => {
        const bars = await fetchDailyOHLC(symbol, now, userId);
        return { symbol, bars };
      })
    );
    for (const row of rows) {
      if (!row.bars || row.bars.length < 6) continue;
      out[row.symbol] = row.bars
        .map((bar) => bar.close)
        .filter((close): close is number => finitePositive(close));
    }
  }
  return out;
}

function loadFieldStore(symbols: string[]): Record<string, Record<string, { value: unknown }>> {
  try {
    return getSymbolFieldLatestBySymbol(symbols);
  } catch {
    return {};
  }
}

export function readCachedWeeklyMarketDigest(userId: string): WeeklyDigestCache | undefined {
  try {
    const cached = getInternalSetting<WeeklyDigestCache>(cacheKey(userId));
    if (!cached || typeof cached.digest !== "object" || !cached.digest) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

export function writeCachedWeeklyMarketDigest(userId: string, cache: WeeklyDigestCache): void {
  setInternalSetting(cacheKey(userId), cache);
}

/** Sync dashboard/read path: cached digest when it matches this scan, else a value-only rebuild. */
export function weeklyMarketDigestForScan(
  userId: string,
  scan: MarketScan | null | undefined,
  now: number = Date.now()
): WeeklyMarketDigest {
  const generatedAt = new Date(now).toISOString();
  if (!scan) {
    return emptyWeeklyMarketDigest(generatedAt, ["No persisted market scan yet.  Run Scan or wait for the next strategy gather."]);
  }
  const cached = readCachedWeeklyMarketDigest(userId);
  if (
    cached &&
    cached.scanGeneratedAt === scan.generatedAt &&
    Date.parse(cached.storedAt) > now - WEEKLY_DIGEST_CACHE_TTL_MS
  ) {
    return cached.digest;
  }
  const rawUniverse = collectDigestUniverse(scan);
  const quotes = hydrateDigestUniverse(rawUniverse, loadFieldStore(rawUniverse.map((quote) => quote.symbol)));
  return buildWeeklyMarketDigest({
    quotes,
    generatedAt,
    scanGeneratedAt: scan.generatedAt,
    scanSource: scan.source,
    status: "value_only",
    extraWarnings: cached
      ? ["Showing value from this scan.  Momentum will refresh against the new tape."]
      : undefined
  });
}

export async function refreshWeeklyMarketDigest(
  userId: string,
  now: number = Date.now()
): Promise<WeeklyMarketDigest> {
  const policy = getPolicy(userId);
  const persisted = newestPersistedMarketScan(userId, policy.connectedAccountId);
  const scan = persisted?.scan;
  const generatedAt = new Date(now).toISOString();
  if (!scan) {
    const digest = emptyWeeklyMarketDigest(generatedAt, ["No persisted market scan to screen."]);
    writeCachedWeeklyMarketDigest(userId, { scanGeneratedAt: "", digest, storedAt: generatedAt });
    return digest;
  }

  const rawUniverse = collectDigestUniverse(scan);
  const quotes = hydrateDigestUniverse(rawUniverse, loadFieldStore(rawUniverse.map((quote) => quote.symbol)));
  const extraWarnings: string[] = [];

  let closesBySymbol: Record<string, number[]> = {};
  let groupedDaysUsed = 0;
  try {
    const grouped = await fetchGroupedClosesBySymbol(userId, now);
    closesBySymbol = grouped.closesBySymbol;
    groupedDaysUsed = grouped.daysUsed;
  } catch (err) {
    extraWarnings.push(
      `Grouped daily bars failed (${err instanceof Error ? err.message : String(err)}).  Falling back to per-symbol history.`
    );
  }

  const liquidLarge = quotes.filter((quote) => passesLiquidityFloor(quote) && passesLargeCap(quote));
  if (groupedDaysUsed < 6) {
    extraWarnings.push(
      groupedDaysUsed === 0
        ? "No grouped daily bars.  Ranking a volume-capped per-symbol sample instead of the full large-cap tape."
        : `Only ${groupedDaysUsed} grouped sessions landed; 5-day returns need six closes.  Filling gaps from per-symbol history.`
    );
    const fallbackPool = liquidLarge
      .slice()
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, WEEKLY_DIGEST_FALLBACK_BAR_BUDGET);
    const fallbackCloses = await fetchDetailCloses(
      fallbackPool.map((quote) => quote.symbol),
      userId,
      now,
      WEEKLY_DIGEST_FALLBACK_BAR_BUDGET
    );
    closesBySymbol = { ...closesBySymbol, ...fallbackCloses };
    extraWarnings.push(
      `Momentum sample is ${Object.keys(fallbackCloses).length} of ${liquidLarge.length} liquid large-caps (highest volume first).`
    );
  }

  const preliminary = buildWeeklyMarketDigest({
    quotes,
    closesBySymbol,
    generatedAt,
    scanGeneratedAt: scan.generatedAt,
    scanSource: scan.source,
    groupedDaysUsed,
    extraWarnings
  });

  const detailSymbols = Array.from(
    new Set([
      ...preliminary.momentum.map((row) => row.symbol),
      ...preliminary.value.map((row) => row.symbol)
    ])
  );
  const detailCloses = await fetchDetailCloses(detailSymbols, userId, now, WEEKLY_DIGEST_DETAIL_BAR_BUDGET);
  const mergedCloses = { ...closesBySymbol, ...detailCloses };
  const digest = buildWeeklyMarketDigest({
    quotes,
    closesBySymbol: mergedCloses,
    generatedAt,
    scanGeneratedAt: scan.generatedAt,
    scanSource: scan.source,
    groupedDaysUsed,
    extraWarnings,
    status: Object.keys(mergedCloses).length > 0 ? "ready" : "value_only"
  });

  writeCachedWeeklyMarketDigest(userId, {
    scanGeneratedAt: scan.generatedAt,
    digest,
    storedAt: generatedAt
  });
  setInternalSetting(watermarkKey(userId), scan.generatedAt);
  invalidateDashboardSnapshotCache(userId);
  audit(
    "weekly_market_digest.refreshed",
    {
      scanGeneratedAt: scan.generatedAt,
      status: digest.status,
      valueCount: digest.value.length,
      momentumCount: digest.momentum.length,
      overlap: digest.overlap,
      groupedDaysUsed,
      barsCovered: digest.barsCovered
    },
    userId,
    policy.connectedAccountId
  );
  return digest;
}

export interface WeeklyDigestRefreshResult {
  status: "refreshed" | "skipped" | "error";
  reason?: string;
  users?: number;
}

/** Scheduler lane: rebuild when the persisted scan is newer than the last refresh. */
export async function runWeeklyMarketDigestRefreshIfDue(
  now: number = Date.now()
): Promise<WeeklyDigestRefreshResult> {
  try {
    const users = listUsers();
    let refreshed = 0;
    for (const userId of users) {
      try {
        const policy = getPolicy(userId);
        const persisted = newestPersistedMarketScan(userId, policy.connectedAccountId);
        const scanAt = persisted?.scan.generatedAt;
        if (!scanAt) continue;
        const last = getInternalSetting<string>(watermarkKey(userId));
        if (last === scanAt) continue;
        await refreshWeeklyMarketDigest(userId, now);
        refreshed += 1;
      } catch (err) {
        console.error(`[weekly-market-digest] refresh error for ${userId}:`, err);
        audit(
          "weekly_market_digest.error",
          { error: err instanceof Error ? err.message : String(err) },
          userId
        );
      }
    }
    if (refreshed === 0) return { status: "skipped", reason: "scan_unchanged" };
    return { status: "refreshed", users: refreshed };
  } catch (err) {
    console.error("[weekly-market-digest] lane error:", err);
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
