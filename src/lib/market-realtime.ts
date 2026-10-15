// Real-time quotes + intraday bars served to congress.trade (App A).
//
// WHY THIS EXISTS
// ---------------
// App A's latency-price capture (`app/src/ingestion/latencyPriceSnapshots.ts`) took its prices from a
// single FMP key. In production that key returned HTTP 402 and blanked the capture entirely — of 2955
// scheduled snapshots only 7 ever recorded a price. Owner ruling 2026-08-20: FMP must NEVER be used for
// market data anywhere in the fleet. This module is the replacement source, reached over the SAME
// token-gated peer-read path App A already uses for EOD closes (src/lib/market-read.ts).
//
// FMP is deliberately absent from every cascade below and must not be reintroduced. (App A still PROBES
// FMP as a latency-race competitor — that is measuring a rival feed, not sourcing market data, and is
// unaffected by this module.)
//
// TWO DISTINCT NEEDS, TWO FUNCTIONS
// ---------------------------------
//   fetchRealtimeQuotes  — "what is it trading at right now", for capture at the moment of an event.
//   fetchIntradayBars    — "what was it trading at 14:43 last Tuesday", for BACKFILL.
//
// Backfill is the more important of the two. App A's snapshots are scheduled retrospectively, so their
// due times are already in the past and a live quote can never honestly answer them — stamping "now"
// onto a past event fabricates data. Minute bars answer it exactly.
//
// FEED HONESTY
// ------------
// Alpaca's free plan serves the IEX feed, roughly 2-3% of consolidated volume. For liquid names IEX
// prints track the NBBO closely; for thin names they can be stale or absent. Every quote therefore
// carries the `feed` it came from so the consumer can decide, rather than being handed a number whose
// provenance is invisible. Never paper over a missing quote with a stale one — omit the symbol instead.

import { getConnectedAccountByBroker } from "./db";
import { resolveAlpacaHistoryCredential } from "./history";
import { getStoredMcpOAuthTokens } from "./mcp-oauth";
import { normalizeSymbol } from "./money";
import { fetchRobinhoodHistoricals, robinhoodMcpDataEnabled } from "./robinhood";
import { providerObservationIso, selectObservedQuotePrice } from "./quote-observation";
import { fetchYahooFinanceQuotesBatch } from "./yahoo-finance";

/** Alpaca requires dot notation for share classes (BRK.B, not our internal BRK-B). A single
 *  unconverted hyphenated symbol rejects the WHOLE batch with HTTP 400 — this has silently
 *  broken ~97% of snapshot calls in this codebase before. */
function toAlpacaSymbol(symbol: string): string {
  return symbol.replace(/-/g, ".");
}

const ALPACA_ALLOWED_FEEDS = ["iex", "sip", "otc"] as const;
export type AlpacaFeed = (typeof ALPACA_ALLOWED_FEEDS)[number];

export function alpacaFeed(): AlpacaFeed {
  const raw = String(process.env.ALPACA_DATA_FEED ?? "").trim().toLowerCase();
  return (ALPACA_ALLOWED_FEEDS as readonly string[]).includes(raw) ? (raw as AlpacaFeed) : "iex";
}

export interface RealtimeQuote {
  symbol: string;
  /** Last trade, else the two-sided mid.  A daily-bar close is not this price. */
  price: number;
  bid?: number;
  ask?: number;
  /** ISO timestamp the price was observed upstream (not when we served it). */
  at?: string;
  /** Which provider actually answered — never inferred, always the real one. */
  source: "alpaca-snapshot" | "yahoo-chart";
  /** Consolidated-tape coverage of the source. "iex" is a PARTIAL feed; say so. */
  feed?: string;
  /**
   * TRUE when this price is materially stale relative to the tape (Yahoo's chart quote runs roughly
   * 15 minutes behind for US equities). A delayed price is NOT a real-time price, and handing one to a
   * caller that asked "what is it trading at right now" fabricates precision. Callers doing
   * point-in-time capture must reject these; callers that only need a rough level may keep them.
   * Opt in with `allowDelayed` — the default omits them entirely.
   */
  delayed: boolean;
}

export interface IntradayBar {
  /** Bar start, ISO UTC. */
  t: string;
  o?: number;
  h?: number;
  l?: number;
  c: number;
  v?: number;
}

const ALPACA_SNAPSHOT_CHUNK = 100;
const DEFAULT_TIMEOUT_MS = 8_000;

interface AlpacaSnapshot {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { bp?: number; ap?: number; t?: string };
  dailyBar?: { c?: number };
}

function positive(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

type JsonFetch<T> =
  | { kind: "ok"; data: T }
  | { kind: "http_error"; status: number }
  | { kind: "network_error" };

function assertNever(value: never): never {
  throw new Error(`unhandled json fetch kind: ${String(value)}`);
}

async function fetchJsonResult<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<JsonFetch<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    if (!res.ok) return { kind: "http_error", status: res.status };
    return { kind: "ok", data: (await res.json()) as T };
  } catch {
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  const result = await fetchJsonResult<T>(url, headers, timeoutMs);
  switch (result.kind) {
    case "ok":
      return result.data;
    case "http_error":
    case "network_error":
      return null;
    default:
      return assertNever(result);
  }
}

/**
 * Batch real-time quotes. Alpaca snapshots first (one call per 100 symbols), then Yahoo for whatever
 * Alpaca could not answer. A symbol that no provider can price is OMITTED from the result — the caller
 * must be able to tell "no quote" from "some quote", which a zero or a stale carry-forward would hide.
 */
export async function fetchRealtimeQuotes(
  rawSymbols: string[],
  userId?: string,
  opts: { allowDelayed?: boolean } = {}
): Promise<Record<string, RealtimeQuote>> {
  const symbols = Array.from(new Set(rawSymbols.map(normalizeSymbol).filter(Boolean)));
  const out: Record<string, RealtimeQuote> = {};
  if (symbols.length === 0) return out;

  const { apiKey, secretKey } = resolveAlpacaHistoryCredential(userId);
  const feed = alpacaFeed();

  if (apiKey && secretKey) {
    for (let i = 0; i < symbols.length; i += ALPACA_SNAPSHOT_CHUNK) {
      const chunk = symbols.slice(i, i + ALPACA_SNAPSHOT_CHUNK);
      const url =
        `https://data.alpaca.markets/v2/stocks/snapshots` +
        `?symbols=${encodeURIComponent(chunk.map(toAlpacaSymbol).join(","))}&feed=${feed}`;
      const json = await fetchJson<Record<string, AlpacaSnapshot>>(url, {
        accept: "application/json",
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": secretKey
      });
      if (!json) continue;
      for (const symbol of chunk) {
        const snap = json[toAlpacaSymbol(symbol)] ?? json[symbol];
        if (!snap) continue;
        const selected = selectObservedQuotePrice({
          last: snap.latestTrade?.p,
          bid: snap.latestQuote?.bp,
          ask: snap.latestQuote?.ap
        });
        if (selected.price === undefined) continue;
        const at = providerObservationIso(selected.basis === "last" ? snap.latestTrade?.t : snap.latestQuote?.t);
        out[symbol] = {
          symbol,
          price: selected.price,
          bid: positive(snap.latestQuote?.bp),
          ask: positive(snap.latestQuote?.ap),
          ...(at ? { at } : {}),
          source: "alpaca-snapshot",
          feed,
          delayed: false
        };
      }
    }
  }

  // Yahoo's chart quote lags the tape by ~15 minutes. For a point-in-time capture that is worse than
  // no answer, because a stale number is indistinguishable from a fresh one once it is written down.
  // So it is OFF unless the caller explicitly accepts delayed data, and it is flagged when served.
  // (ROIC is deliberately NOT in this cascade: its price API is daily-only with a 4-hour cache, so it
  // cannot answer "price now" OR "price at 14:43" — verified against roic.ai/api/docs 2026-08-20.)
  const missing = symbols.filter((s) => !out[s]);
  if (opts.allowDelayed && missing.length > 0) {
    const yahoo = await fetchYahooFinanceQuotesBatch(missing).catch(() => new Map());
    for (const symbol of missing) {
      const q = yahoo.get(symbol);
      const price = positive(q?.price);
      if (price === undefined) continue;
      const at = providerObservationIso(q?.asOf);
      out[symbol] = {
        symbol,
        price,
        ...(at ? { at } : {}),
        source: "yahoo-chart",
        feed: "consolidated-delayed",
        delayed: true
      };
    }
  }

  return out;
}

const ALPACA_TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "30Min", "1Hour"]);

/**
 * Operator Robinhood for the Congress.Trade peer INTRADAY route only.
 *
 * `getMcpAccessToken` is already per-user (no env-token skip).  Deleting operator
 * Robinhood from this module would still interfere with CT: `/api/market/quotes`
 * never uses Robinhood (Alpaca, then opt-in delayed Yahoo), but `/api/market/intraday`
 * is Robinhood-first because CT backfills past due_at times and RH 15s bars beat
 * Alpaca's 1-minute IEX feed.  A peer handler has no tenant userId; using some other
 * user's token is the leak robinhood.ts forbids.  So the operator (`local`) *stored*
 * token is used here, and only when the caller passes `operatorPeerRead` after
 * `APP_B_INGEST_TOKEN`.  `ROBINHOOD_MCP_AUTH_TOKEN` is a boot seed
 * (`migrateLocalRobinhoodToken`), not a per-request bypass, and is never read here.
 */
function operatorRobinhoodForPeerRead(): boolean {
  if (!robinhoodMcpDataEnabled()) return false;
  return Boolean(getStoredMcpOAuthTokens("local")?.accessToken?.trim());
}

/** Alpaca timeframe -> Robinhood interval. Robinhood names the 1-minute bar `minute`, NOT `1minute`;
 *  the wrong spelling is accepted upstream and silently returns an auto-selected interval, which would
 *  answer a minute-resolution question with hour bars. */
const ROBINHOOD_INTERVALS: Record<string, string> = {
  "1Min": "minute",
  "5Min": "5minute",
  "15Min": "30minute", // Robinhood has no 15-minute bar; 30minute is the nearest COARSER honest match
  "30Min": "30minute",
  "1Hour": "hour"
};

export function toRobinhoodInterval(timeframe: string): string {
  return ROBINHOOD_INTERVALS[normalizeTimeframe(timeframe)] ?? "minute";
}

/** Normalize a caller-supplied timeframe, defaulting to 1-minute. Unknown values fall back rather
 *  than erroring, so a typo yields the finest resolution instead of no data. */
export function normalizeTimeframe(raw?: string | null): string {
  const v = String(raw ?? "").trim();
  return ALPACA_TIMEFRAMES.has(v) ? v : "1Min";
}

/**
 * Intraday fetch outcome.  `ok` means a provider answered — including a confirmed empty
 * window (weekend / halt).  `unavailable` means no provider confirmed the window, so the
 * peer route must return a non-200 and let Congress.Trade fall back.  NEVER substitutes
 * a current quote for a past bar.
 */
export type IntradayBarsResult =
  | { kind: "ok"; bars: IntradayBar[] }
  | { kind: "unavailable"; reason: string };

/**
 * Historical intraday bars — the honest way to answer "what was the price at time T" for a T that has
 * already passed.
 */
export async function fetchIntradayBars(
  rawSymbol: string,
  startIso: string,
  endIso: string,
  timeframe = "1Min",
  userId?: string,
  opts?: { operatorPeerRead?: boolean }
): Promise<IntradayBarsResult> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return { kind: "unavailable", reason: "symbol required" };

  // Robinhood first (15s vs Alpaca 1m) only on the token-gated CT peer path.  See
  // operatorRobinhoodForPeerRead: env ROBINHOOD_MCP_AUTH_TOKEN is not a live bypass.
  if (opts?.operatorPeerRead && operatorRobinhoodForPeerRead()) {
    const rhBars = await fetchRobinhoodHistoricals(symbol, {
      userId: "local",
      interval: toRobinhoodInterval(timeframe),
      startTime: startIso,
      endTime: endIso,
      bounds: "regular"
    }).catch(() => null);
    if (rhBars && rhBars.length > 0) {
      const mapped = rhBars
        .filter((b) => typeof b.time === "string" && Number.isFinite(b.close))
        .map((b) => ({ t: String(b.time), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
      if (mapped.length > 0) return { kind: "ok", bars: mapped };
    }
  }

  const { apiKey, secretKey } = resolveAlpacaHistoryCredential(userId);
  if (!apiKey || !secretKey) {
    return { kind: "unavailable", reason: "no history credential" };
  }

  const bars: IntradayBar[] = [];
  let pageToken: string | undefined;
  let confirmedEmpty = false;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({
      timeframe: normalizeTimeframe(timeframe),
      start: startIso,
      end: endIso,
      adjustment: "split",
      limit: "10000",
      feed: alpacaFeed()
    });
    if (pageToken) params.set("page_token", pageToken);
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(toAlpacaSymbol(symbol))}/bars?${params}`;
    const json = await fetchJsonResult<{ bars?: unknown; next_page_token?: string | null }>(url, {
      accept: "application/json",
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": secretKey
    });
    switch (json.kind) {
      case "http_error":
        return bars.length > 0
          ? { kind: "ok", bars }
          : { kind: "unavailable", reason: `alpaca bars HTTP ${json.status}` };
      case "network_error":
        return bars.length > 0
          ? { kind: "ok", bars }
          : { kind: "unavailable", reason: "alpaca bars request failed" };
      case "ok":
        break;
      default:
        return assertNever(json);
    }
    const raw = Array.isArray(json.data.bars)
      ? json.data.bars
      : json.data.bars && typeof json.data.bars === "object"
        ? ((json.data.bars as Record<string, unknown[]>)[toAlpacaSymbol(symbol)] ?? (json.data.bars as Record<string, unknown[]>)[symbol] ?? [])
        : [];
    confirmedEmpty = true;
    for (const b of raw as Array<Record<string, unknown>>) {
      const c = positive(b.c);
      const t = typeof b.t === "string" ? b.t : undefined;
      if (c === undefined || !t) continue;
      bars.push({ t, o: positive(b.o), h: positive(b.h), l: positive(b.l), c, v: typeof b.v === "number" ? b.v : undefined });
    }
    pageToken = json.data.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  if (bars.length > 0) return { kind: "ok", bars };
  if (confirmedEmpty) return { kind: "ok", bars: [] };
  return { kind: "unavailable", reason: "alpaca bars request failed" };
}

/** Nearest bar at or after `atIso`, within `toleranceMin`. Pure — the price-at-a-past-instant primitive
 *  App A needs for snapshot backfill. Returns null rather than reaching further and quietly answering
 *  with a bar from a different part of the session. */
export function barAt(bars: IntradayBar[], atIso: string, toleranceMin = 5): IntradayBar | null {
  const target = Date.parse(atIso);
  if (!Number.isFinite(target)) return null;
  const limit = target + toleranceMin * 60_000;
  let best: IntradayBar | null = null;
  let bestT = Infinity;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t) || t < target || t > limit) continue;
    if (t < bestT) {
      bestT = t;
      best = b;
    }
  }
  return best;
}

/** True when a broker credential capable of serving real-time quotes is configured. */
export function realtimeQuotesConfigured(userId?: string): boolean {
  const { apiKey, secretKey } = resolveAlpacaHistoryCredential(userId);
  return Boolean(apiKey && secretKey) || Boolean(getConnectedAccountByBroker("alpaca", "local"));
}
