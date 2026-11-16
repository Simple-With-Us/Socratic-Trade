// Keyless / shared options metrics for market scans (near-the-money IV + put/call ratio).
//
// Primary: Cboe delayed options JSON (cdn.cboe.com → cdn-api.cboe.com), no API key.
// Fallback: Alpaca indicative options snapshots (free Basic plan; requires market-data keys).
// Fallback: Tradier option chains + ORATS greeks (requires a connected Tradier account token).
//
// Metrics are derived with the same `deriveOptionMetrics` helper as the opt-in Robinhood tier.

import { z } from "zod";
import { getConnectedAccountByBroker, type ApiKeySource } from "./db";
import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { deriveOptionMetrics } from "./robinhood-options";
import { parseOccSymbol } from "./option-orders";
import { normalizeSymbol } from "./money";
import { politeFetch, runRateLimited } from "./web-sources/http";
import { selectObservedQuotePrice } from "./quote-observation";
import { recordProviderCall } from "./usage-monitor-push";

const CBOE_OPTIONS_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const ALPACA_OPTIONS_SNAPSHOTS = "https://data.alpaca.markets/v1beta1/options/snapshots";
const ALPACA_STOCK_SNAPSHOTS = "https://data.alpaca.markets/v2/stocks";

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_SYMBOLS = 40;
const DEFAULT_PACE_MS = 250;
const DEFAULT_TIMEOUT_MS = 12_000;
/** Empty chains are retried sooner than a filled chain, and never longer than five minutes. */
const NEGATIVE_CACHE_MAX_MS = 5 * 60_000;

const loose = z.unknown().optional();
const nestedRecord = z.record(z.string(), z.unknown()).optional().nullable();

/**
 * Vendor JSON at the HTTP boundary.  Extra keys are kept on purpose: Cboe, Alpaca, and
 * Tradier add envelope fields.  `.strict()` would reject those live payloads.
 */
function vendorObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).passthrough();
}

/** Cboe delayed-quotes envelope.  Extra keys are kept; row shape is checked per contract. */
export const CboeOptionsResponseSchema = vendorObject({
  data: vendorObject({
    current_price: loose,
    close: loose,
    prev_day_close: loose,
    options: z.array(z.unknown()).optional()
  }).optional()
});

const CboeOptionRowSchema = vendorObject({
  option: z.string(),
  iv: loose,
  implied_volatility: loose,
  impliedVolatility: loose,
  open_interest: loose,
  openInterest: loose,
  oi: loose,
  volume: loose,
  vol: loose
});

/** Alpaca `GET /v1beta1/options/snapshots/{underlying}`.  IV is root `impliedVolatility`, volume is `dailyBar.v`. */
export const AlpacaOptionsResponseSchema = vendorObject({
  snapshots: z.record(z.string(), z.unknown()).optional(),
  underlyingAssetPrice: loose,
  underlying_asset_price: loose,
  underlying: loose
});

const AlpacaGreeksSchema = vendorObject({
  implied_volatility: loose,
  iv: loose,
  mid_iv: loose
});

const AlpacaSnapshotSchema = vendorObject({
  impliedVolatility: loose,
  implied_volatility: loose,
  iv: loose,
  greeks: AlpacaGreeksSchema.optional().nullable(),
  open_interest: loose,
  openInterest: loose,
  volume: loose,
  vol: loose,
  daily_volume: loose,
  dailyBar: nestedRecord,
  daily_bar: nestedRecord
});

/** IEX stock snapshot used only when the options payload has no underlying price. */
export const AlpacaStockSnapshotSchema = vendorObject({
  latestTrade: nestedRecord,
  dailyBar: nestedRecord,
  prevDailyBar: nestedRecord
});

export const TradierExpirationsSchema = vendorObject({
  expirations: vendorObject({
    date: z.union([z.string(), z.array(z.string())]).optional().nullable()
  })
    .optional()
    .nullable()
});

/** Tradier chain envelope.  `underlying` is often the ticker string, not a price. */
export const TradierChainSchema = vendorObject({
  options: vendorObject({
    option: z.unknown().optional().nullable()
  })
    .optional()
    .nullable(),
  underlying: loose,
  underlying_price: loose
});

const TradierOptionRowSchema = vendorObject({
  strike: loose,
  strike_price: loose,
  option_type: loose,
  type: loose,
  open_interest: loose,
  openInterest: loose,
  volume: loose,
  vol: loose,
  implied_volatility: loose,
  iv: loose,
  greeks: loose
});

const TradierGreeksSchema = vendorObject({
  mid_iv: loose,
  smv_vol: loose,
  bid_iv: loose,
  ask_iv: loose
});

export const TradierQuotesSchema = vendorObject({
  quotes: vendorObject({
    quote: z.unknown().optional().nullable()
  })
    .optional()
    .nullable()
});

const TradierQuoteSchema = vendorObject({
  last: loose,
  close: loose,
  bid: loose,
  ask: loose
});

const UnderlyingObjectSchema = vendorObject({
  price: loose,
  underlyingPrice: loose
});

const optionsCache = new Map<string, { expiresAt: number; data: SymbolEnrichment; source: string }>();

function flagEnabled(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Default ON — keyless Cboe lane. Set KEYLESS_OPTIONS_ENRICHMENT_ENABLED=0 to disable. */
export function keylessOptionsEnrichmentEnabled(): boolean {
  const raw = process.env.KEYLESS_OPTIONS_ENRICHMENT_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return flagEnabled(raw);
}

export function keylessOptionsTtlMs(): number {
  const value = Number(process.env.KEYLESS_OPTIONS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

function keylessOptionsMaxSymbols(): number {
  const value = Number(process.env.KEYLESS_OPTIONS_MAX_SYMBOLS ?? DEFAULT_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

function keylessOptionsPaceMs(): number {
  const value = Number(process.env.KEYLESS_OPTIONS_PACE_MS ?? DEFAULT_PACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PACE_MS;
}

function readPositive(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return undefined;
}

function nestedPositive(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  return record ? readPositive(record[key]) : undefined;
}

/** Latest trade, else the two-sided mid.  A bar close and a prior close are not the price. */
export function readAlpacaStockSnapshotPrice(json: unknown): number | undefined {
  const parsed = AlpacaStockSnapshotSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const snap = parsed.data as {
    latestTrade?: Record<string, unknown> | null;
    latestQuote?: Record<string, unknown> | null;
  };
  return selectObservedQuotePrice({
    last: nestedPositive(snap.latestTrade, "p"),
    bid: nestedPositive(snap.latestQuote, "bp"),
    ask: nestedPositive(snap.latestQuote, "ap")
  }).price;
}

function withUnderlying(underlyingPrice: number | undefined, chains: unknown): { underlyingPrice?: number; chains: unknown } {
  return underlyingPrice !== undefined ? { underlyingPrice, chains } : { chains };
}

const ChainResultsSchema = vendorObject({ results: z.array(z.unknown()).optional() });

function chainRowCount(chains: unknown): number {
  const parsed = ChainResultsSchema.safeParse(chains);
  return parsed.success ? (parsed.data.results?.length ?? 0) : 0;
}

/** A number, or `{ price | underlyingPrice }`.  A ticker string is not a price. */
function underlyingPriceFromUnknown(value: unknown): number | undefined {
  const direct = readPositive(value);
  if (direct !== undefined) return direct;
  const obj = UnderlyingObjectSchema.safeParse(value);
  if (!obj.success) return undefined;
  return readPositive(obj.data.underlyingPrice) ?? readPositive(obj.data.price);
}

function quotePrice(quote: { last?: unknown; bid?: unknown; ask?: unknown }): number | undefined {
  return selectObservedQuotePrice({ last: quote.last, bid: quote.bid, ask: quote.ask }).price;
}

/** Map a Cboe delayed options payload into `deriveOptionMetrics` chain rows. */
export function parseCboeOptionsPayload(json: unknown): { underlyingPrice?: number; chains: unknown } {
  const parsed = CboeOptionsResponseSchema.safeParse(json);
  if (!parsed.success || !parsed.data.data) return { chains: { results: [] } };
  const data = parsed.data.data;
  const underlyingPrice = readPositive(data.current_price);

  const results: Record<string, unknown>[] = [];
  for (const entry of data.options ?? []) {
    const rowParsed = CboeOptionRowSchema.safeParse(entry);
    if (!rowParsed.success) continue;
    const row = rowParsed.data;
    const occ = parseOccSymbol(row.option);
    if (!occ) continue;
    const iv = readPositive(row.iv) ?? readPositive(row.implied_volatility) ?? readPositive(row.impliedVolatility);
    const oi = readPositive(row.open_interest) ?? readPositive(row.openInterest) ?? readPositive(row.oi);
    const vol = readPositive(row.volume) ?? readPositive(row.vol);
    results.push({
      strike_price: occ.strikePrice,
      type: occ.optionType,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }

  return withUnderlying(underlyingPrice, { results });
}

function tradierOptionRows(optionNode: unknown): z.infer<typeof TradierOptionRowSchema>[] {
  const list = Array.isArray(optionNode) ? optionNode : optionNode ? [optionNode] : [];
  const rows: z.infer<typeof TradierOptionRowSchema>[] = [];
  for (const entry of list) {
    const parsed = TradierOptionRowSchema.safeParse(entry);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/** Map Tradier option chain rows into `deriveOptionMetrics` chain rows. */
export function parseTradierOptionsChains(
  chainsJson: unknown,
  underlyingPrice?: number
): { underlyingPrice?: number; chains: unknown } {
  const parsed = TradierChainSchema.safeParse(chainsJson);
  if (!parsed.success) return withUnderlying(underlyingPrice, { results: [] });
  const rows = tradierOptionRows(parsed.data.options?.option);
  const price =
    underlyingPrice ??
    readPositive(parsed.data.underlying_price) ??
    underlyingPriceFromUnknown(parsed.data.underlying);
  const results: Record<string, unknown>[] = [];
  for (const row of rows) {
    const strike = readPositive(row.strike) ?? readPositive(row.strike_price);
    const typeRaw = String(row.option_type ?? row.type ?? "").toLowerCase();
    const type = typeRaw.includes("put") ? "put" : typeRaw.includes("call") ? "call" : undefined;
    if (!strike || !type) continue;
    const greeksParsed = TradierGreeksSchema.safeParse(row.greeks);
    const greeks = greeksParsed.success ? greeksParsed.data : undefined;
    const iv =
      (greeks
        ? readPositive(greeks.mid_iv) ??
          readPositive(greeks.smv_vol) ??
          readPositive(greeks.bid_iv) ??
          readPositive(greeks.ask_iv)
        : undefined) ??
      readPositive(row.implied_volatility) ??
      readPositive(row.iv);
    const oi = readPositive(row.open_interest) ?? readPositive(row.openInterest);
    const vol = readPositive(row.volume) ?? readPositive(row.vol);
    results.push({
      strike_price: strike,
      type,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }
  return withUnderlying(price, { results });
}

/** Map Alpaca indicative option snapshots into `deriveOptionMetrics` chain rows. */
export function parseAlpacaOptionsSnapshots(
  json: unknown,
  underlyingPrice?: number
): { underlyingPrice?: number; chains: unknown } {
  const parsed = AlpacaOptionsResponseSchema.safeParse(json);
  if (!parsed.success) return withUnderlying(underlyingPrice, { results: [] });
  const fromPayload =
    readPositive(parsed.data.underlyingAssetPrice) ??
    readPositive(parsed.data.underlying_asset_price) ??
    underlyingPriceFromUnknown(parsed.data.underlying);
  const price = underlyingPrice ?? fromPayload;
  const results: Record<string, unknown>[] = [];
  for (const [occ, snap] of Object.entries(parsed.data.snapshots ?? {})) {
    const rowParsed = AlpacaSnapshotSchema.safeParse(snap);
    if (!rowParsed.success) continue;
    const contract = parseOccSymbol(occ);
    if (!contract) continue;
    const row = rowParsed.data;
    const greeks = row.greeks ?? undefined;
    const iv =
      readPositive(row.impliedVolatility) ??
      readPositive(greeks?.implied_volatility) ??
      readPositive(greeks?.iv) ??
      readPositive(greeks?.mid_iv) ??
      readPositive(row.implied_volatility) ??
      readPositive(row.iv);
    const oi = readPositive(row.open_interest) ?? readPositive(row.openInterest);
    const vol =
      readPositive(row.volume) ??
      readPositive(row.vol) ??
      readPositive(row.daily_volume) ??
      nestedPositive(row.dailyBar, "v") ??
      nestedPositive(row.daily_bar, "v");
    results.push({
      strike_price: contract.strikePrice,
      type: contract.optionType,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }
  return withUnderlying(price, { results });
}

export function metricsFromChainPayload(payload: { underlyingPrice?: number; chains: unknown }): SymbolEnrichment {
  const metrics = deriveOptionMetrics({ chains: payload.chains, instruments: undefined }, payload.underlyingPrice);
  return Object.keys(metrics).length > 0 ? metrics : {};
}

async function fetchCboeOptionsPayload(symbol: string): Promise<{ underlyingPrice?: number; chains: unknown } | null> {
  const url = `${CBOE_OPTIONS_URL}/${encodeURIComponent(symbol)}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal, redirect: "follow" });
    clearTimeout(timeout);
    if (!res.ok) {
      recordProviderCall("cboe-options", { service: "options-chain", ok: false });
      return null;
    }
    const parsedJson = CboeOptionsResponseSchema.safeParse(await res.json());
    if (!parsedJson.success) {
      recordProviderCall("cboe-options", { service: "options-chain", ok: false });
      return null;
    }
    recordProviderCall("cboe-options", { service: "options-chain", ok: true });
    const parsed = parseCboeOptionsPayload(parsedJson.data);
    if (chainRowCount(parsed.chains) === 0) {
      return null;
    }
    return parsed;
  } catch {
    clearTimeout(timeout);
    recordProviderCall("cboe-options", { service: "options-chain", ok: false });
    return null;
  }
}

async function fetchAlpacaOptionsPayload(
  symbol: string,
  apiKey: string,
  apiSecret: string,
  userId?: string
): Promise<{ underlyingPrice?: number; chains: unknown } | null> {
  const url = `${ALPACA_OPTIONS_SNAPSHOTS}/${encodeURIComponent(symbol)}?feed=indicative&limit=1000`;
  try {
    const res = await politeFetch(url, {
      headers: {
        accept: "application/json",
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 1
    });
    if (!res.ok) {
      recordProviderCall("alpaca-options", { service: "options-snapshots", ok: false, userId });
      return null;
    }
    const parsedJson = AlpacaOptionsResponseSchema.safeParse(await res.json());
    if (!parsedJson.success) {
      recordProviderCall("alpaca-options", { service: "options-snapshots", ok: false, userId });
      return null;
    }
    recordProviderCall("alpaca-options", { service: "options-snapshots", ok: true, userId });
    const parsed = parseAlpacaOptionsSnapshots(parsedJson.data);
    const count = chainRowCount(parsed.chains);
    if (count === 0) return null;
    if (parsed.underlyingPrice === undefined) {
      const quote = await fetchAlpacaUnderlyingPrice(symbol, apiKey, apiSecret, userId);
      if (quote !== undefined) parsed.underlyingPrice = quote;
    }
    return parsed;
  } catch {
    recordProviderCall("alpaca-options", { service: "options-snapshots", ok: false, userId });
    return null;
  }
}

async function fetchAlpacaUnderlyingPrice(
  symbol: string,
  apiKey: string,
  apiSecret: string,
  userId?: string
): Promise<number | undefined> {
  const url = `${ALPACA_STOCK_SNAPSHOTS}/${encodeURIComponent(symbol)}/snapshot?feed=iex`;
  try {
    const res = await politeFetch(url, {
      headers: {
        accept: "application/json",
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 0
    });
    if (!res.ok) {
      recordProviderCall("alpaca-options", { service: "underlying-snapshot", ok: false, userId });
      return undefined;
    }
    const json: unknown = await res.json();
    if (!AlpacaStockSnapshotSchema.safeParse(json).success) {
      recordProviderCall("alpaca-options", { service: "underlying-snapshot", ok: false, userId });
      return undefined;
    }
    recordProviderCall("alpaca-options", { service: "underlying-snapshot", ok: true, userId });
    return readAlpacaStockSnapshotPrice(json);
  } catch {
    recordProviderCall("alpaca-options", { service: "underlying-snapshot", ok: false, userId });
    return undefined;
  }
}

export function resolveTradierOptionsCredential(userId?: string): { key?: string; baseUrl: string; source: ApiKeySource } {
  const acct = getConnectedAccountByBroker("tradier", userId && userId !== "local" ? userId : "local");
  return {
    key: acct?.apiKey?.trim() || undefined,
    baseUrl: acct?.environment === "live" ? "https://api.tradier.com" : "https://sandbox.tradier.com",
    source: acct?.userId && acct.userId !== "local" ? "user" : "env"
  };
}

async function fetchTradierNearestChain(
  symbol: string,
  token: string,
  baseUrl: string,
  userId?: string
): Promise<{ underlyingPrice?: number; chains: unknown } | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let service: "options-expirations" | "options-chains" = "options-expirations";
  try {
    const expUrl = `${baseUrl}/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`;
    const expRes = await politeFetch(expUrl, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 });
    if (!expRes.ok) {
      recordProviderCall("tradier-options", { service: "options-expirations", ok: false, userId });
      return null;
    }
    const expParsed = TradierExpirationsSchema.safeParse(await expRes.json());
    if (!expParsed.success) {
      recordProviderCall("tradier-options", { service: "options-expirations", ok: false, userId });
      return null;
    }
    const datesRaw = expParsed.data.expirations?.date;
    const dates = Array.isArray(datesRaw) ? datesRaw : datesRaw ? [datesRaw] : [];
    const today = new Date().toISOString().slice(0, 10);
    const future = dates.filter((d) => typeof d === "string" && d >= today).sort();
    const expiration = future[0] ?? dates.sort()[0];
    if (!expiration) return null;

    service = "options-chains";
    const chainUrl =
      `${baseUrl}/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}` +
      `&expiration=${encodeURIComponent(expiration)}&greeks=true`;
    const chainRes = await politeFetch(chainUrl, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 });
    if (!chainRes.ok) {
      recordProviderCall("tradier-options", { service: "options-chains", ok: false, userId });
      return null;
    }
    const chainParsed = TradierChainSchema.safeParse(await chainRes.json());
    if (!chainParsed.success) {
      recordProviderCall("tradier-options", { service: "options-chains", ok: false, userId });
      return null;
    }
    recordProviderCall("tradier-options", { service: "options-chains", ok: true, userId });
    const parsed = parseTradierOptionsChains(chainParsed.data);
    const count = chainRowCount(parsed.chains);
    if (count === 0) return null;
    if (parsed.underlyingPrice === undefined) {
      const quote = await fetchTradierUnderlyingPrice(symbol, token, baseUrl, userId);
      if (quote !== undefined) parsed.underlyingPrice = quote;
    }
    return parsed;
  } catch {
    recordProviderCall("tradier-options", { service, ok: false, userId });
    return null;
  }
}

async function fetchTradierUnderlyingPrice(
  symbol: string,
  token: string,
  baseUrl: string,
  userId?: string
): Promise<number | undefined> {
  const url = `${baseUrl}/v1/markets/quotes?symbols=${encodeURIComponent(symbol)}`;
  try {
    const res = await politeFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 0
    });
    if (!res.ok) {
      recordProviderCall("tradier-options", { service: "quotes", ok: false, userId });
      return undefined;
    }
    const parsed = TradierQuotesSchema.safeParse(await res.json());
    if (!parsed.success) {
      recordProviderCall("tradier-options", { service: "quotes", ok: false, userId });
      return undefined;
    }
    const quoteNode = parsed.data.quotes?.quote;
    const first = Array.isArray(quoteNode) ? quoteNode[0] : quoteNode;
    const quote = TradierQuoteSchema.safeParse(first);
    if (!quote.success) {
      recordProviderCall("tradier-options", { service: "quotes", ok: false, userId });
      return undefined;
    }
    recordProviderCall("tradier-options", { service: "quotes", ok: true, userId });
    return quotePrice(quote.data);
  } catch {
    recordProviderCall("tradier-options", { service: "quotes", ok: false, userId });
    return undefined;
  }
}

abstract class OptionsMetricsEnrichmentProvider implements MarketEnrichmentProvider {
  abstract readonly name: string;
  readonly configured = true;
  /** Cboe stays free (Wave A).  Keyed subclasses override this to "paid" so they gap-fill in Wave B. */
  readonly costTier: "free" | "paid" = "free";
  readonly suppliesFields: readonly (keyof SymbolEnrichment)[] = ["nearTheMoneyIv", "putCallRatio"];

  protected abstract fetchPayload(symbol: string): Promise<{ underlyingPrice?: number; chains: unknown } | null>;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, keylessOptionsMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;

    const now = Date.now();
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = optionsCache.get(`${this.name}::${symbol}`);
      if (cached && cached.expiresAt > now && cached.source === this.name) {
        result[symbol] = cached.data;
      } else {
        misses.push(symbol);
      }
    }
    if (misses.length === 0) return result;

    await runRateLimited(misses, keylessOptionsPaceMs(), async (symbol) => {
      try {
        const payload = await this.fetchPayload(symbol);
        const data = payload ? metricsFromChainPayload(payload) : {};
        const hasData = Object.keys(data).length > 0;
        optionsCache.set(`${this.name}::${symbol}`, {
          expiresAt: now + (hasData ? keylessOptionsTtlMs() : Math.min(keylessOptionsTtlMs(), NEGATIVE_CACHE_MAX_MS)),
          data,
          source: this.name
        });
        result[symbol] = data;
      } catch {
        result[symbol] = {};
      }
    });

    return result;
  }
}

export class CboeOptionsEnrichmentProvider extends OptionsMetricsEnrichmentProvider {
  readonly name = "cboe-options";

  protected async fetchPayload(symbol: string) {
    return fetchCboeOptionsPayload(symbol);
  }
}

export class AlpacaOptionsEnrichmentProvider extends OptionsMetricsEnrichmentProvider {
  readonly name = "alpaca-options";
  override readonly costTier = "paid" as const;
  readonly healthKeySource: ApiKeySource | null;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    super();
    this.healthKeySource = keySource;
  }

  protected async fetchPayload(symbol: string) {
    return fetchAlpacaOptionsPayload(symbol, this.apiKey, this.apiSecret, this.userId);
  }
}

export class TradierOptionsEnrichmentProvider extends OptionsMetricsEnrichmentProvider {
  readonly name = "tradier-options";
  override readonly costTier = "paid" as const;
  readonly healthKeySource: ApiKeySource | null;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    super();
    this.healthKeySource = keySource;
  }

  protected async fetchPayload(symbol: string) {
    return fetchTradierNearestChain(symbol, this.token, this.baseUrl, this.userId);
  }
}

/** Test helper — clears per-provider symbol caches. */
export function clearKeylessOptionsCache(): void {
  optionsCache.clear();
}
