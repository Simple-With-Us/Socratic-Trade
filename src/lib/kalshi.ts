/**
 * Kalshi event-market data client.  Prompt injection lives in kalshi-macro.ts;
 * event-contract trading (live kill switch default OFF) lives in kalshi-trading.ts.
 *
 * Package K1 of the Kalshi integration design (see
 * docs/rollouts/2026-07-12-kalshi-data-fetcher.md): a self-contained, flag-gated fetcher for
 * Kalshi's CFTC-regulated event-contract markets, exposing normalized event-probability signals
 * (`getKalshiEventSignals`) intended for LATER strategist injection as macro/regime evidence.
 * Wave 2 wires it into strategy.ts / market-signals; this module deliberately imports nothing
 * from the app (only bare `crypto`) so it stays inert until then.
 *
 * Configuration (all via env; absent => module inert, every surface fails soft):
 *   - KALSHI_ENV             "demo" | "prod" — selects the base URL. REQUIRED to enable the module.
 *   - KALSHI_API_KEY_ID      optional — Kalshi API key id (UUID shown at key creation).
 *   - KALSHI_PRIVATE_KEY_PEM optional — RSA private key PEM delivered once at key creation
 *                            (PKCS#1 "BEGIN RSA PRIVATE KEY" or PKCS#8; literal "\n" accepted).
 *
 * Market-data endpoints (GET /markets, /events/{t}, /series/{t}) are PUBLIC — no auth required —
 * so the data package works with KALSHI_ENV alone. When BOTH key id and PEM are present, requests
 * are signed anyway (harmless on public endpoints; exercises the auth plumbing the future trading
 * gateway needs).
 *
 * Auth scheme (verified against docs.kalshi.com, 2026-07-12): RSA-PSS over SHA-256 with
 * salt length = digest length, base64-encoded, over the message
 *   `${timestampMs}${METHOD}${pathWithoutQuery}`
 * where the path INCLUDES the /trade-api/v2 prefix and EXCLUDES the query string. Headers:
 *   KALSHI-ACCESS-KEY / KALSHI-ACCESS-TIMESTAMP / KALSHI-ACCESS-SIGNATURE.
 *
 * Prices: Kalshi's default market-data representation is INTEGER CENTS (yes_bid/yes_ask/
 * last_price, ints 1-99); the *_dollars fields are a separate parallel string form. We parse the
 * cent fields and divide by 100 — never the string fields, never floats-as-money beyond the
 * derived probability. Demo and prod credentials are never interchangeable (a demo key 401s
 * against prod and vice versa), and the base URL is DERIVED from KALSHI_ENV so they cannot cross.
 *
 * Failure policy (repo convention: never fabricate): any HTTP/parse/signing failure drops that
 * series (or the whole result) — `getKalshiEventSignals` returns `[]`, never synthetic data.
 * Subaccounts (1-63) are institution-gated and ignored entirely here.
 */

// Bare specifier (not "node:crypto") on purpose: this module is reachable from
// strategy.ts -> scheduler.ts, which Next also compiles into the client/edge
// bundles. A `node:`-scheme request is handled by webpack's scheme plugin BEFORE
// resolve.alias runs, so the config's `"node:crypto": false` alias cannot
// neutralize it there and the build fails with `UnhandledSchemeError`. Bare
// `crypto` goes through resolve.fallback, where next.config.mjs maps it to
// `false` for non-server bundles (and to the real builtin on the server).
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type KalshiEnv = "demo" | "prod";

const KALSHI_BASE_URLS: Record<KalshiEnv, string> = {
  prod: "https://external-api.kalshi.com/trade-api/v2",
  demo: "https://external-api.demo.kalshi.co/trade-api/v2"
};

export interface KalshiConfig {
  env: KalshiEnv;
  baseUrl: string;
  /** Present only when BOTH key id and private key PEM are configured. */
  keyId?: string;
  privateKeyPem?: string;
}

export function kalshiApiBase(env: KalshiEnv): string {
  return KALSHI_BASE_URLS[env];
}

/**
 * Resolve module configuration from the environment at call time (never at module load, so tests
 * and late-set env both work). Returns undefined when KALSHI_ENV is absent/invalid — the module
 * is inert in that state. Credentials are attached only when BOTH halves are present.
 */
export function getKalshiConfig(env: NodeJS.ProcessEnv = process.env): KalshiConfig | undefined {
  const rawEnv = env.KALSHI_ENV?.trim().toLowerCase();
  if (rawEnv !== "demo" && rawEnv !== "prod") return undefined;
  const config: KalshiConfig = { env: rawEnv, baseUrl: KALSHI_BASE_URLS[rawEnv] };
  const keyId = env.KALSHI_API_KEY_ID?.trim();
  // PEMs shipped through env vars often carry literal "\n" — normalize to real newlines.
  const pem = env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n").trim();
  if (keyId && pem) {
    config.keyId = keyId;
    config.privateKeyPem = pem;
  }
  return config;
}

export function isKalshiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getKalshiConfig(env) !== undefined;
}

// ---------------------------------------------------------------------------
// Request signing (RSA-PSS SHA-256)
// ---------------------------------------------------------------------------

/**
 * Sign one request. `path` is the request path INCLUDING the /trade-api/v2 prefix; any query
 * string is stripped before signing (Kalshi signs the path only). Returns base64.
 */
export function signKalshiRequest(privateKeyPem: string, timestampMs: string, method: string, path: string): string {
  const pathWithoutQuery = path.split("?")[0] ?? path;
  const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;
  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return signature.toString("base64");
}

/**
 * Build Kalshi auth headers for a request, or {} when credentials are not configured
 * (market-data endpoints are public, so unsigned requests are fine).
 */
export function kalshiAuthHeaders(
  config: KalshiConfig,
  method: string,
  path: string,
  nowMs: number = Date.now()
): Record<string, string> {
  if (!config.keyId || !config.privateKeyPem) return {};
  const timestampMs = String(nowMs);
  return {
    "KALSHI-ACCESS-KEY": config.keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signKalshiRequest(config.privateKeyPem, timestampMs, method, path)
  };
}

// ---------------------------------------------------------------------------
// Raw API shapes (snake_case, straight off the wire)
// ---------------------------------------------------------------------------

/** A single Kalshi market. Since March 2026, Kalshi uses `*_dollars` (fixed-point string) and
 * `*_fp` (fixed-point integer) fields instead of legacy integer-cent/count fields. We parse the
 * `_dollars` string fields for prices and `_fp` fields for counts, with legacy integer fallbacks
 * for any environment that still returns them. */
export interface KalshiApiMarket {
  ticker?: string;
  event_ticker?: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  status?: string;
  // Current price representation: fixed-point dollar strings (e.g. "0.50").
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  // Legacy integer-cent price fields (removed March 2026 from production; kept as fallback).
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  // Current count representation: fixed-point integers (*_fp).
  volume_24h_fp?: number;
  open_interest_fp?: number;
  // Legacy integer count fields.
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  // String-based dollar representations for liquidity (Feb 2026: deprecated, returns 0).
  liquidity_dollars?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  result?: string;
}

export interface KalshiApiEvent {
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  markets?: KalshiApiMarket[];
}

export interface KalshiApiSeries {
  ticker?: string;
  title?: string;
  category?: string;
  frequency?: string;
}

export interface KalshiMarketsPage {
  markets: KalshiApiMarket[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * GET a Kalshi endpoint (path relative to the /trade-api/v2 base, e.g. "/markets").
 * Signs the request when credentials are configured. Returns the parsed JSON body or null on any
 * failure (network, timeout, non-2xx, malformed JSON) — callers treat null as "no data".
 */
async function kalshiGet(config: KalshiConfig, path: string, query?: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...kalshiAuthHeaders(config, "GET", url.pathname)
    };
    const res = await fetch(url.toString(), { cache: "no-store", signal: controller.signal, headers });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Typed fetchers (public market-data endpoints; null on failure/unconfigured)
// ---------------------------------------------------------------------------

export interface KalshiMarketsQuery {
  seriesTicker?: string;
  eventTicker?: string;
  /** Comma-joined on the wire. */
  tickers?: string[];
  /** e.g. "open" | "unopened" | "paused" | "closed" | "settled". */
  status?: string;
  limit?: number;
  cursor?: string;
}

/** GET /markets — one page of markets matching the query. */
export async function fetchKalshiMarkets(
  query: KalshiMarketsQuery = {},
  config: KalshiConfig | undefined = getKalshiConfig()
): Promise<KalshiMarketsPage | null> {
  if (!config) return null;
  const body = asRecord(
    await kalshiGet(config, "/markets", {
      series_ticker: query.seriesTicker,
      event_ticker: query.eventTicker,
      tickers: query.tickers && query.tickers.length > 0 ? query.tickers.join(",") : undefined,
      status: query.status,
      limit: query.limit !== undefined ? String(query.limit) : undefined,
      cursor: query.cursor
    })
  );
  if (!body || !Array.isArray(body.markets)) return null;
  return {
    markets: body.markets.filter((m): m is KalshiApiMarket => asRecord(m) !== null),
    cursor: typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : undefined
  };
}

/** GET /events/{event_ticker} — one event, optionally with nested markets. */
export async function fetchKalshiEvent(
  eventTicker: string,
  withNestedMarkets = false,
  config: KalshiConfig | undefined = getKalshiConfig()
): Promise<KalshiApiEvent | null> {
  if (!config || !eventTicker.trim()) return null;
  const body = asRecord(
    await kalshiGet(config, `/events/${encodeURIComponent(eventTicker.trim())}`, {
      with_nested_markets: withNestedMarkets ? "true" : undefined
    })
  );
  const event = asRecord(body?.event);
  if (!event || !body) return null;
  const result = event as KalshiApiEvent;
  // Some responses carry markets as a sibling of `event` rather than nested.
  if (!Array.isArray(result.markets) && Array.isArray(body.markets)) {
    result.markets = (body.markets as unknown[]).filter((m): m is KalshiApiMarket => asRecord(m) !== null);
  }
  return result;
}

/** GET /series/{series_ticker} — series metadata. */
export async function fetchKalshiSeries(
  seriesTicker: string,
  config: KalshiConfig | undefined = getKalshiConfig()
): Promise<KalshiApiSeries | null> {
  if (!config || !seriesTicker.trim()) return null;
  const body = asRecord(await kalshiGet(config, `/series/${encodeURIComponent(seriesTicker.trim())}`));
  const series = asRecord(body?.series);
  return series ? (series as KalshiApiSeries) : null;
}

// ---------------------------------------------------------------------------
// Normalization — dollars strings and cents to probability
// ---------------------------------------------------------------------------

/**
 * Parse a Kalshi `*_dollars` fixed-point string (e.g. "0.50" or "$0.50") into cents (50).
 * Returns undefined for missing/blank/invalid values.
 */
function parseDollarsPrice(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^[$]/, "");
  if (trimmed.length === 0) return undefined;
  const num = parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0 || num >= 100) return undefined;
  // Convert to cent-equivalent (e.g. 0.5012 → 50.12) and verify it's a valid cent price.
  const cents = num * 100;
  return cents > 0 && cents < 100 ? cents : undefined;
}

/** A valid Kalshi cent price: finite number in (0, 100). 0 means "no book on that side". */
function validCents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100 ? value : undefined;
}

/**
 * Resolve a market's YES-side price to cents, preferring the current `*_dollars` string
 * representation with legacy integer-cent fallback.
 */
function marketYesBidCents(market: KalshiApiMarket): number | undefined {
  return parseDollarsPrice(market.yes_bid_dollars) ?? validCents(market.yes_bid);
}

function marketYesAskCents(market: KalshiApiMarket): number | undefined {
  return parseDollarsPrice(market.yes_ask_dollars) ?? validCents(market.yes_ask);
}

function marketLastPriceCents(market: KalshiApiMarket): number | undefined {
  return parseDollarsPrice(market.last_price_dollars) ?? validCents(market.last_price);
}

/** Convert an integer-cent price (1-99) to a probability in (0, 1), 4dp. */
export function centsToProbability(cents: unknown): number | undefined {
  const valid = typeof cents === "number" && Number.isFinite(cents) && cents > 0 && cents < 100 ? cents : undefined;
  return valid === undefined ? undefined : Math.round((valid / 100) * 10_000) / 10_000;
}

/**
 * Implied YES probability for a market: mid of yes_bid/yes_ask when both sides have a book,
 * falling back to last_price when they don't. Undefined when no usable price exists —
 * never fabricated.
 */
export function impliedProbability(
  market: KalshiApiMarket
): { probability: number; basis: "mid" | "last" } | undefined {
  const bid = marketYesBidCents(market);
  const ask = marketYesAskCents(market);
  if (bid !== undefined && ask !== undefined) {
    const mid = centsToProbability((bid + ask) / 2);
    if (mid !== undefined) return { probability: mid, basis: "mid" };
  }
  const last = marketLastPriceCents(market);
  if (last !== undefined) return { probability: centsToProbability(last)!, basis: "last" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Normalized event signals — the surface Wave 2 will inject into the strategist
// ---------------------------------------------------------------------------

export interface KalshiEventSignal {
  /** Curated series this market belongs to (as requested by the caller). */
  seriesTicker: string;
  /** Kalshi market ticker, e.g. "KXFEDDECISION-26SEP-C25". */
  marketTicker: string;
  /** Human-readable market title (+ subtitle when present). */
  title: string;
  /** Implied YES probability, 0-1 (parsed from integer cents). */
  probability: number;
  /** Whether the probability came from the bid/ask mid or a last-trade fallback. */
  probabilityBasis: "mid" | "last";
  /** Liquidity/confidence context — the LLM must weight thin books lower. */
  volume24h?: number;
  openInterest?: number;
  /** ISO market close time, when provided. */
  closeTime?: string;
  /** ISO timestamp of this fetch. */
  asOf: string;
}

export interface KalshiEventSignalsOptions {
  /** Cap per series, most-liquid (open interest) first. Default 8. */
  maxMarketsPerSeries?: number;
  /** Injection point for tests/config; defaults to env-derived config. */
  config?: KalshiConfig;
  now?: number;
}

const finiteOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const parseFloatOrUndef = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = parseFloat(v);
    if (Number.isFinite(p)) return p;
  }
  return undefined;
};

// Success-only cache: event probabilities move faster than the 1h market-signals bundle but a
// 15-min TTL is plenty at signal cadence, and a transient failure never poisons a prior success.
const SIGNALS_TTL_MS = 15 * 60_000;
const signalsCache = new Map<string, { expiresAt: number; data: KalshiEventSignal[] }>();

export function clearKalshiCacheForTests(): void {
  signalsCache.clear();
}

/**
 * Fetch ALL markets for a series by following cursor pagination, then sort by open interest
 * descending and return the top N (capped at 200 per page, but accumulated across pages).
 * Returns an empty array on total failure (caller handles fail-soft).
 */
async function fetchAllMarketsForSeries(
  seriesTicker: string,
  config: KalshiConfig,
): Promise<KalshiApiMarket[]> {
  const all: KalshiApiMarket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const pageData = await fetchKalshiMarkets({ seriesTicker, status: "open", limit: 200, cursor }, config);
    if (!pageData) {
      if (page > 0) throw new Error("Pagination failed");
      break;
    }
    all.push(...pageData.markets);
    if (!pageData.cursor) break;
    cursor = pageData.cursor;
  }
  return all;
}

/**
 * Fetch normalized event-probability signals for a list of Kalshi series tickers
 * (e.g. ["KXFEDDECISION", "KXCPIYOY", "KXRECSSNBER"]). Public endpoints only. Fail-soft:
 * unconfigured module, empty input, or total failure all return [] — a failed series is skipped
 * rather than failing the batch, and nothing is ever fabricated.
 */
export async function getKalshiEventSignals(
  seriesList: string[],
  options: KalshiEventSignalsOptions = {}
): Promise<KalshiEventSignal[]> {
  const config = options.config ?? getKalshiConfig();
  if (!config) return [];
  const series = [...new Set((seriesList ?? []).map((s) => (typeof s === "string" ? s.trim().toUpperCase() : "")).filter((s) => s.length > 0))];
  if (series.length === 0) return [];

  const now = options.now ?? Date.now();
  const maxPerSeries = Math.max(1, Math.floor(options.maxMarketsPerSeries ?? 8));
  const cacheKey = `${config.env}:${maxPerSeries}:${series.join(",")}`;
  const cached = signalsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  const asOf = new Date(now).toISOString();
  const signals: KalshiEventSignal[] = [];
  let allSeriesSucceeded = true;
  for (const seriesTicker of series) {
    try {
      const allMarkets = await fetchAllMarketsForSeries(seriesTicker, config);
      if (allMarkets.length === 0) { allSeriesSucceeded = false; continue; }
      const rows: KalshiEventSignal[] = [];
      for (const market of allMarkets) {
        if (typeof market.ticker !== "string" || market.ticker.length === 0) continue;
        const implied = impliedProbability(market);
        if (!implied) continue; // no usable price — drop, never fabricate
        const title = [market.title, market.subtitle || market.yes_sub_title]
          .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .map((part) => part.trim())
          .join(" — ");
        rows.push({
          seriesTicker,
          marketTicker: market.ticker,
          title: title || market.ticker,
          probability: implied.probability,
          probabilityBasis: implied.basis,
          volume24h: parseFloatOrUndef(market.volume_24h_fp) ?? finiteOrUndef(market.volume_24h) ?? finiteOrUndef(market.volume),
          openInterest: parseFloatOrUndef(market.open_interest_fp) ?? finiteOrUndef(market.open_interest),
          closeTime: typeof market.close_time === "string" && market.close_time.length > 0 ? market.close_time : undefined,
          asOf
        });
      }
      rows.sort((a, b) => (b.openInterest ?? 0) - (a.openInterest ?? 0));
      signals.push(...rows.slice(0, maxPerSeries));
    } catch {
      allSeriesSucceeded = false;
      // fail-soft: a throwing series never takes down the batch
    }
  }

  if (signals.length > 0 && allSeriesSucceeded) {
    signalsCache.set(cacheKey, { expiresAt: now + SIGNALS_TTL_MS, data: signals });
  }
  return signals;
}
