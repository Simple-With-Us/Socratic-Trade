// Keyless / shared options metrics for market scans (near-the-money IV + put/call ratio).
//
// Primary: Cboe delayed options JSON (cdn.cboe.com → cdn-api.cboe.com), no API key.
// Fallback: Alpaca indicative options snapshots (free Basic plan; requires market-data keys).
// Fallback: Tradier option chains + ORATS greeks (requires a connected Tradier account token).
//
// Metrics are derived with the same `deriveOptionMetrics` helper as the opt-in Robinhood tier.

import { getConnectedAccountByBroker, type ApiKeySource } from "./db";
import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { deriveOptionMetrics } from "./robinhood-options";
import { parseOccSymbol } from "./option-orders";
import { normalizeSymbol } from "./money";
import { politeFetch, runRateLimited } from "./web-sources/http";
import { recordProviderCall } from "./usage-monitor-push";

const CBOE_OPTIONS_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const ALPACA_OPTIONS_SNAPSHOTS = "https://data.alpaca.markets/v1beta1/options/snapshots";

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_SYMBOLS = 40;
const DEFAULT_PACE_MS = 250;
const DEFAULT_TIMEOUT_MS = 12_000;

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

function firstPositiveNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Map a Cboe delayed options payload into `deriveOptionMetrics` chain rows. */
export function parseCboeOptionsPayload(json: unknown): { underlyingPrice?: number; chains: unknown } {
  const root = json as { data?: Record<string, unknown> };
  const data = root?.data;
  if (!data || typeof data !== "object") return { chains: { results: [] } };

  const underlyingRaw = data.current_price ?? data.close ?? data.prev_day_close;
  const underlyingPrice =
    typeof underlyingRaw === "number" && Number.isFinite(underlyingRaw) && underlyingRaw > 0
      ? underlyingRaw
      : undefined;

  const rawOptions = data.options;
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  const results: Record<string, unknown>[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const occ = typeof row.option === "string" ? row.option : undefined;
    if (!occ) continue;
    const parsed = parseOccSymbol(occ);
    if (!parsed) continue;
    const iv = firstPositiveNum(row, ["iv", "implied_volatility", "impliedVolatility"]);
    const oi = firstPositiveNum(row, ["open_interest", "openInterest", "oi"]);
    const vol = firstPositiveNum(row, ["volume", "vol"]);
    results.push({
      strike_price: parsed.strikePrice,
      type: parsed.optionType,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }

  return { underlyingPrice, chains: { results } };
}

function tradierOptionRows(optionNode: unknown): Record<string, unknown>[] {
  if (!optionNode) return [];
  if (Array.isArray(optionNode)) return optionNode.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  if (typeof optionNode === "object") return [optionNode as Record<string, unknown>];
  return [];
}

/** Map Tradier option chain rows into `deriveOptionMetrics` chain rows. */
export function parseTradierOptionsChains(
  chainsJson: unknown,
  underlyingPrice?: number
): { underlyingPrice?: number; chains: unknown } {
  const options = (chainsJson as { options?: { option?: unknown } })?.options?.option;
  const rows = tradierOptionRows(options);
  const results: Record<string, unknown>[] = [];
  for (const row of rows) {
    const strike = firstPositiveNum(row, ["strike", "strike_price"]);
    const typeRaw = String(row.option_type ?? row.type ?? "").toLowerCase();
    const type = typeRaw.includes("put") ? "put" : typeRaw.includes("call") ? "call" : undefined;
    if (!strike || !type) continue;
    const greeks = row.greeks && typeof row.greeks === "object" ? (row.greeks as Record<string, unknown>) : {};
    const iv =
      firstPositiveNum(greeks, ["mid_iv", "smv_vol", "bid_iv", "ask_iv"]) ??
      firstPositiveNum(row, ["implied_volatility", "iv"]);
    const oi = firstPositiveNum(row, ["open_interest", "openInterest"]);
    const vol = firstPositiveNum(row, ["volume", "vol"]);
    results.push({
      strike_price: strike,
      type,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }
  return { underlyingPrice, chains: { results } };
}

/** Map Alpaca indicative option snapshots into `deriveOptionMetrics` chain rows. */
export function parseAlpacaOptionsSnapshots(
  json: unknown,
  underlyingPrice?: number
): { underlyingPrice?: number; chains: unknown } {
  const snapshots = (json as { snapshots?: Record<string, unknown> })?.snapshots;
  if (!snapshots || typeof snapshots !== "object") return { underlyingPrice, chains: { results: [] } };

  const results: Record<string, unknown>[] = [];
  for (const [occ, snap] of Object.entries(snapshots)) {
    if (!snap || typeof snap !== "object") continue;
    const row = snap as Record<string, unknown>;
    const parsed = parseOccSymbol(occ);
    if (!parsed) continue;
    const greeks = row.greeks && typeof row.greeks === "object" ? (row.greeks as Record<string, unknown>) : {};
    const iv =
      firstPositiveNum(greeks, ["implied_volatility", "iv", "mid_iv"]) ??
      firstPositiveNum(row, ["implied_volatility", "iv"]);
    const oi = firstPositiveNum(row, ["open_interest", "openInterest"]);
    const vol = firstPositiveNum(row, ["volume", "vol", "daily_volume"]);
    results.push({
      strike_price: parsed.strikePrice,
      type: parsed.optionType,
      ...(iv !== undefined ? { implied_volatility: iv } : {}),
      ...(oi !== undefined ? { open_interest: oi } : {}),
      ...(vol !== undefined ? { volume: vol } : {})
    });
  }
  return { underlyingPrice, chains: { results } };
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
    const json = (await res.json()) as unknown;
    recordProviderCall("cboe-options", { service: "options-chain", ok: true });
    const parsed = parseCboeOptionsPayload(json);
    if (!Array.isArray((parsed.chains as { results?: unknown[] })?.results) || (parsed.chains as { results: unknown[] }).results.length === 0) {
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
    const json = (await res.json()) as unknown;
    recordProviderCall("alpaca-options", { service: "options-snapshots", ok: true, userId });
    const parsed = parseAlpacaOptionsSnapshots(json);
    const count = (parsed.chains as { results?: unknown[] })?.results?.length ?? 0;
    return count > 0 ? parsed : null;
  } catch {
    recordProviderCall("alpaca-options", { service: "options-snapshots", ok: false, userId });
    return null;
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
  try {
    const expUrl = `${baseUrl}/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`;
    const expRes = await politeFetch(expUrl, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 });
    if (!expRes.ok) {
      recordProviderCall("tradier-options", { service: "options-expirations", ok: false, userId });
      return null;
    }
    const expJson = (await expRes.json()) as { expirations?: { date?: string | string[] } };
    const datesRaw = expJson?.expirations?.date;
    const dates = Array.isArray(datesRaw) ? datesRaw : datesRaw ? [datesRaw] : [];
    const today = new Date().toISOString().slice(0, 10);
    const future = dates.filter((d) => typeof d === "string" && d >= today).sort();
    const expiration = future[0] ?? dates.sort()[0];
    if (!expiration) return null;

    const chainUrl =
      `${baseUrl}/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}` +
      `&expiration=${encodeURIComponent(expiration)}&greeks=true`;
    const chainRes = await politeFetch(chainUrl, { headers, timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 });
    if (!chainRes.ok) {
      recordProviderCall("tradier-options", { service: "options-chains", ok: false, userId });
      return null;
    }
    const chainJson = (await chainRes.json()) as unknown;
    recordProviderCall("tradier-options", { service: "options-chains", ok: true, userId });
    const parsed = parseTradierOptionsChains(chainJson);
    const count = (parsed.chains as { results?: unknown[] })?.results?.length ?? 0;
    return count > 0 ? parsed : null;
  } catch {
    recordProviderCall("tradier-options", { service: "options-expirations", ok: false, userId });
    return null;
  }
}

abstract class OptionsMetricsEnrichmentProvider implements MarketEnrichmentProvider {
  abstract readonly name: string;
  readonly configured = true;
  readonly costTier = "free" as const;
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
        if (Object.keys(data).length > 0) {
          optionsCache.set(`${this.name}::${symbol}`, {
            expiresAt: now + keylessOptionsTtlMs(),
            data,
            source: this.name
          });
        }
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
