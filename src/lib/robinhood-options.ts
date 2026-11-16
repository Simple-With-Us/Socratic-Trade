// Robinhood option-chain enrichment tier (opt-in, low-frequency).
//
// Derives two lightweight signals from the connected Robinhood MCP option chain for a symbol:
//   - nearTheMoneyIv: implied volatility (%) of the strike(s) closest to the money
//   - putCallRatio:   put/call ratio from around-the-money open interest (or volume as a fallback)
//
// This is a LONG-TTL, low-frequency source (not a per-scan-cycle concern) gated behind a default-off
// env flag (ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED) AND a connected Robinhood MCP (ROBINHOOD_ADAPTER=mcp).
// It is INERT (contributes nothing) when either is absent, so the cascade degrades exactly as before.
//
// SECURITY: the Robinhood OAuth token is per-user. This provider is constructed with the request-scoped
// userId and threads it into every option-chain fetch; a pass with no user in scope fails closed (empty).

import { normalizeSymbol } from "./money";
import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";

const DEFAULT_OPTIONS_TTL_MS = 6 * 60 * 60_000; // 6h — options metrics move slowly at this granularity.
// Default 20 is deliberate (per-symbol option-chain fetches through the broker MCP are slow),
// but the env override is unclamped — first-N slicing starves the tail of the candidate list,
// so an operator who wants full options coverage can raise it explicitly.
const DEFAULT_OPTIONS_MAX_SYMBOLS = 20;
function optionsMaxSymbols(): number {
  const value = Number(process.env.ROBINHOOD_OPTIONS_MAX_SYMBOLS ?? DEFAULT_OPTIONS_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_OPTIONS_MAX_SYMBOLS;
  return Math.floor(value);
}

interface OptionRow {
  strike?: number;
  type?: string; // "call" | "put"
  impliedVolatility?: number; // 0–1 fraction
  openInterest?: number;
  volume?: number;
}

/** Robinhood option payloads vary in envelope shape. Collect flat rows tolerantly. */
export function extractOptionRows(raw: unknown): OptionRow[] {
  const rows: OptionRow[] = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const strike = firstNum(obj, ["strike_price", "strike", "strikePrice"]);
    const type = firstStr(obj, ["type", "option_type", "instrument_type", "rhs_tradability_type"]);
    const iv = firstNum(obj, ["implied_volatility", "impliedVolatility", "iv"]);
    const oi = firstNum(obj, ["open_interest", "openInterest", "oi"]);
    const vol = firstNum(obj, ["volume", "vol"]);
    // A row is "option-like" if it carries a strike + an option type (call/put).
    if (strike !== undefined && type && /call|put/i.test(type)) {
      rows.push({
        strike,
        type: /put/i.test(type) ? "put" : "call",
        ...(iv !== undefined ? { impliedVolatility: iv } : {}),
        ...(oi !== undefined ? { openInterest: oi } : {}),
        ...(vol !== undefined ? { volume: vol } : {})
      });
    }
    // Recurse into common nested containers.
    for (const key of ["results", "options", "chains", "instruments", "data", "quotes", "marketData", "market_data"]) {
      if (key in obj) visit(obj[key]);
    }
  };
  visit(raw);
  return rows;
}

/**
 * Derive near-the-money IV (%) and a put/call ratio from raw option payloads + the underlying price.
 * Returns an empty object (never fabricated numbers) when the inputs don't support a metric.
 */
export function deriveOptionMetrics(raw: { chains: unknown; instruments: unknown }, underlyingPrice?: number): SymbolEnrichment {
  const rows = [...extractOptionRows(raw.chains), ...extractOptionRows(raw.instruments)];
  if (rows.length === 0) return {};

  const result: SymbolEnrichment = {};

  // Near-the-money IV: strike closest to the underlying price with a real IV. When we have no
  // underlying price, fall back to the median IV across rows that carry one.
  const withIv = rows.filter((r) => typeof r.impliedVolatility === "number" && r.impliedVolatility! > 0);
  if (withIv.length > 0) {
    let iv: number | undefined;
    if (typeof underlyingPrice === "number" && underlyingPrice > 0) {
      let best: OptionRow | undefined;
      let bestDist = Infinity;
      for (const r of withIv) {
        if (typeof r.strike !== "number") continue;
        const dist = Math.abs(r.strike - underlyingPrice);
        if (dist < bestDist) {
          bestDist = dist;
          best = r;
        }
      }
      iv = best?.impliedVolatility;
    }
    if (iv === undefined) {
      const sorted = withIv.map((r) => r.impliedVolatility!).sort((a, b) => a - b);
      iv = sorted[Math.floor(sorted.length / 2)];
    }
    if (typeof iv === "number" && iv > 0) {
      // Normalize a 0–1 fraction to a percentage (0.32 → 32%); leave already-percent values alone.
      result.nearTheMoneyIv = Math.round((iv <= 3 ? iv * 100 : iv) * 100) / 100;
    }
  }

  // Put/call ratio from around-the-money interest. Restrict to strikes within ±20% of the underlying
  // when a price is known, so far OTM tails don't dominate. Prefer open interest, fall back to volume.
  const near = (r: OptionRow) =>
    typeof underlyingPrice !== "number" || underlyingPrice <= 0 || typeof r.strike !== "number"
      ? true
      : Math.abs(r.strike - underlyingPrice) <= underlyingPrice * 0.2;
  let putWeight = 0;
  let callWeight = 0;
  for (const r of rows) {
    if (!near(r)) continue;
    // Prefer open interest, but fall back to volume whenever OI is not POSITIVE — a present-but-zero
    // open_interest (common for new / same-day strikes) must not shadow real volume via `??`.
    const w = r.openInterest && r.openInterest > 0 ? r.openInterest : r.volume;
    if (typeof w !== "number" || w <= 0) continue;
    if (r.type === "put") putWeight += w;
    else if (r.type === "call") callWeight += w;
  }
  if (callWeight > 0 && putWeight >= 0) {
    result.putCallRatio = Math.round((putWeight / callWeight) * 100) / 100;
  }

  return result;
}

export class RobinhoodOptionsEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "robinhood-options";
  readonly configured = true;
  readonly costTier = "paid" as const;

  constructor(private readonly userId?: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, optionsMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;
    // Fail closed without a user in scope — never borrow the operator's broker token.
    if (!this.userId) {
      for (const symbol of normalized) result[symbol] = {};
      return result;
    }

    const now = Date.now();
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = optionsCache.get(cacheKey(this.userId, symbol));
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    try {
      const { fetchRobinhoodOptionChain } = await import("./robinhood");
      // Sequential (not fan-out) — MCP option calls are rate/session sensitive and this tier is
      // deliberately low-frequency. A single failing symbol never poisons the others.
      for (const symbol of misses) {
        try {
          const raw = await fetchRobinhoodOptionChain(symbol, this.userId);
          // Pass the underlying price so near-the-money IV picks the closest strike and the put/call
          // ratio applies its ±20% ATM filter — far-OTM tails must not drive these fields.
          const data = raw ? deriveOptionMetrics(raw, raw.underlyingPrice) : {};
          if (Object.keys(data).length > 0) {
            optionsCache.set(cacheKey(this.userId, symbol), { expiresAt: now + optionsTtlMs(), data });
          }
          result[symbol] = data;
        } catch {
          result[symbol] = {};
        }
      }
    } catch {
      for (const symbol of misses) if (!result[symbol]) result[symbol] = {};
    }
    return result;
  }
}

// Keyed by user + symbol. The option data is fetched with a PER-USER Robinhood OAuth token, so a value
// warmed by user A must never be served to user B (who may have no connected Robinhood session and whose
// own fetch would fail closed) — that would leak A's token-derived data and mis-attribute it.
const optionsCache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

function cacheKey(userId: string, symbol: string): string {
  return `${userId}::${symbol}`;
}

/** Test helper: clear the long-TTL options cache between runs. */
export function clearRobinhoodOptionsCache(): void {
  optionsCache.clear();
}

function optionsTtlMs(): number {
  const value = Number(process.env.ROBINHOOD_OPTIONS_TTL_MS ?? DEFAULT_OPTIONS_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_OPTIONS_TTL_MS;
}

function firstNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstStr(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
