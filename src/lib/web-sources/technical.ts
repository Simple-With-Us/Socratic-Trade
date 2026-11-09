// Technical-signal connector — the producer-agnostic seam for bar-based technicals.
//
// The app has no other source of price-history technicals (RSI/MACD/MA crossovers);
// every other signal is a snapshot or cross-sectional aggregate. This connector owns a
// single persisted per-symbol technical dataset that TWO interchangeable producers fill:
//
//   • TradingView (push):   a Pine `alert()` POSTs to /api/webhooks/tradingview, which
//                           calls recordTradingViewSignal() to upsert a record.
//   • In-house (pull):      refreshTechnical() pulls free daily OHLC (Yahoo chart, Stooq
//                           fallback) for a bounded watchlist and runs computeTechnicals().
//
// Pick the producer with TECHNICAL_SOURCE=tradingview|computed (default tradingview).
// Downstream (overlay, scoring, evidence, learning) is identical for both — so the
// TradingView trial and the free computed fallback are drop-in swaps. Like every web
// source: persisted, low-frequency, never fabricated (no bars → no signal, not a fake).

import crypto from "crypto";
import { audit, getInternalSetting, setInternalSetting } from "../db";
import { normalizeSymbol } from "../money";
import { computeTechnicals, type TechnicalDirection, type TechnicalRead } from "../indicators";
import { fetchDailyOHLC } from "../history";
import type { WebSourceRefreshResult } from "./types";

// parseStooqCsv moved to ../history (the single OHLC source); re-exported for back-compat.
export { parseStooqCsv } from "../history";

const DATASET_KEY = "webSource:technical:dataset";
const WATCHLIST_KEY = "webSource:technical:watchlist";
const ATTEMPT_KEY = "webSource:technical:lastAttempt";
const DEFAULT_TTL_MS = 36 * 60 * 60_000; // a daily signal stays fresh ~1.5 trading days
const RETRY_BACKOFF_MS = 30 * 60_000; // don't re-attempt a failed compute for 30m
const MAX_COMPUTE_SYMBOLS = Math.max(1, Number(process.env.WEB_SOURCE_TECHNICAL_MAX ?? 40));

export type TechnicalSource = "tradingview" | "computed";

/** A persisted per-symbol technical read (TTL-expiring on `receivedAt`). */
export interface TechnicalSignalRecord {
  symbol: string;
  score: number; // 0–100, 50 = neutral
  direction: TechnicalDirection;
  signals: string[]; // named conditions, e.g. ["sma50_200_golden_cross"]
  tf?: string; // timeframe ("1d", "60", …)
  price?: number;
  rsi14?: number;
  asOf?: string; // bar/signal time
  receivedAt: string; // ingestion/compute time — drives TTL expiry
  source: TechnicalSource;
  dedupeKey: string; // (symbol|signals|asOf|direction) to drop duplicate retries
  bulletin: string;
}

export interface TechnicalDataset {
  signals: Record<string, TechnicalSignalRecord>;
  fetchedAt: string;
  recordCount: number;
  source: TechnicalSource;
}

/** The read shape the overlay consumes (mirrors the other web-source signal getters). */
export interface TechnicalSignal {
  score: number;
  direction: TechnicalDirection;
  signals: string[];
  tf?: string;
  asOf?: string;
  source: TechnicalSource;
  bulletin: string;
}

/** Raw JSON body a TradingView Pine `alert()` posts to the webhook route. */
export interface TradingViewWebhookPayload {
  secret?: string;
  symbol?: string;
  exchange?: string;
  action?: string; // bullish|bearish|neutral|buy|sell
  signal?: string; // signal name
  score?: number; // optional precomputed 0–100
  price?: number;
  rsi?: number;
  tf?: string;
  bar_time?: number | string;
}

export interface IngestResult {
  ok: boolean;
  symbol?: string;
  deduped?: boolean;
  warning?: string;
}

// ── Env gates ────────────────────────────────────────────────────────────────

/** Whether the technical connector is enabled (default on; disable with WEB_SOURCE_TECHNICAL=off). */
export function technicalEnabled(): boolean {
  return (process.env.WEB_SOURCE_TECHNICAL ?? "on").toLowerCase() !== "off";
}

/** Which producer fills the dataset. Default "tradingview" (the trial-window pilot). */
export function technicalSource(): TechnicalSource {
  return (process.env.TECHNICAL_SOURCE ?? "tradingview").toLowerCase() === "computed" ? "computed" : "tradingview";
}

export function technicalTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_TECHNICAL_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function webhookSecret(): string | undefined {
  const s = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  return s && s.length > 0 ? s : undefined;
}

/** Constant-time compare of the webhook secret. Fails closed when no secret is configured. */
export function verifyWebhookSecret(provided: unknown): boolean {
  const expected = webhookSecret();
  if (!expected) return false; // no secret set → reject every push (never run open)
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Dataset read ─────────────────────────────────────────────────────────────

export function getTechnicalDataset(): TechnicalDataset | undefined {
  return getInternalSetting<TechnicalDataset>(DATASET_KEY);
}

/** Per-symbol overlay read (TTL-filtered). No network — pure cache read for the scan. */
export function getTechnicalSignals(symbols: string[], now: number = Date.now()): Record<string, TechnicalSignal> {
  if (!technicalEnabled()) return {};
  const dataset = getTechnicalDataset();
  if (!dataset?.signals) return {};
  const ttl = technicalTtlMs();
  const out: Record<string, TechnicalSignal> = {};
  for (const raw of symbols) {
    const symbol = normalizeSymbol(raw);
    const rec = dataset.signals[symbol];
    if (!rec) continue;
    if (now - Date.parse(rec.receivedAt) >= ttl) continue; // expired — stale signals never linger
    out[symbol] = {
      score: rec.score,
      direction: rec.direction,
      signals: rec.signals,
      tf: rec.tf,
      asOf: rec.asOf,
      source: rec.source,
      bulletin: rec.bulletin
    };
  }
  return out;
}

export function getTechnicalStatus(now: number = Date.now()): {
  enabled: boolean;
  source: TechnicalSource;
  fetchedAt?: string;
  recordCount: number;
  due: boolean;
  ttlMs: number;
  secretConfigured: boolean;
} {
  const ds = getTechnicalDataset();
  return {
    enabled: technicalEnabled(),
    source: technicalSource(),
    fetchedAt: ds?.fetchedAt,
    recordCount: ds?.recordCount ?? 0,
    due: isTechnicalRefreshDue(now),
    ttlMs: technicalTtlMs(),
    secretConfigured: !!webhookSecret()
  };
}

// ── Producer A: TradingView push ingestion ───────────────────────────────────

/** Upsert a pushed TradingView signal into the dataset. Dedups identical retries. */
export function recordTradingViewSignal(payload: TradingViewWebhookPayload, now: number = Date.now()): IngestResult {
  const symbol = normalizeSymbol(String(payload.symbol ?? ""));
  if (!symbol) return { ok: false, warning: "missing symbol" };

  const direction = toDirection(payload.action);
  const signals = payload.signal ? [String(payload.signal)] : [];
  const score =
    typeof payload.score === "number" && Number.isFinite(payload.score)
      ? clampScore(payload.score)
      : direction === "bullish"
        ? 70
        : direction === "bearish"
          ? 30
          : 50;
  const asOf = toIso(payload.bar_time);
  const dedupeKey = `${symbol}|${signals.join(",")}|${asOf ?? ""}|${direction}`;

  const dataset = getTechnicalDataset() ?? emptyDataset("tradingview");
  if (dataset.signals[symbol]?.dedupeKey === dedupeKey) {
    return { ok: true, deduped: true, symbol }; // identical retry — ignore
  }

  dataset.signals[symbol] = {
    symbol,
    score,
    direction,
    signals,
    tf: payload.tf ? String(payload.tf) : undefined,
    price: numOrUndef(payload.price),
    rsi14: numOrUndef(payload.rsi),
    asOf,
    receivedAt: new Date(now).toISOString(),
    source: "tradingview",
    dedupeKey,
    bulletin: buildBulletin({ symbol, direction, score, signals, source: "tradingview", tf: payload.tf })
  };
  dataset.source = "tradingview";
  dataset.fetchedAt = new Date(now).toISOString();
  dataset.recordCount = Object.keys(dataset.signals).length;
  setInternalSetting(DATASET_KEY, dataset);
  audit("technical_signal_ingest", { symbol, direction, score, signals, source: "tradingview" });
  return { ok: true, symbol };
}

// ── Producer B: in-house computed pull ───────────────────────────────────────

/** Record the symbols the computed producer should cover next refresh (bounded). */
export function setTechnicalWatchlist(symbols: string[]): void {
  const list = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))].slice(0, MAX_COMPUTE_SYMBOLS);
  if (list.length > 0) setInternalSetting(WATCHLIST_KEY, list);
}

export function getTechnicalWatchlist(): string[] {
  return getInternalSetting<string[]>(WATCHLIST_KEY) ?? [];
}

export function isTechnicalRefreshDue(now: number = Date.now()): boolean {
  if (!technicalEnabled() || technicalSource() !== "computed") return false;
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < RETRY_BACKOFF_MS) return false;
  const ds = getTechnicalDataset();
  if (!ds?.fetchedAt || ds.source !== "computed") return true;
  return now - Date.parse(ds.fetchedAt) >= technicalTtlMs();
}

/**
 * Refresh the computed dataset. No-op (skipped) when TECHNICAL_SOURCE=tradingview — that
 * mode is push-fed, so there's nothing to pull. Pulls free daily OHLC for the bounded
 * watchlist, computes technicals, and writes the dataset. Never fabricates: a symbol with
 * no bars simply gets no record.
 */
export async function refreshTechnical(
  now: number = Date.now(),
  opts?: { symbols?: string[]; force?: boolean }
): Promise<WebSourceRefreshResult> {
  if (technicalSource() !== "computed") {
    const ds = getTechnicalDataset();
    return { id: "technical", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? [ds.source] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  if (!opts?.force && !isTechnicalRefreshDue(now)) {
    const ds = getTechnicalDataset();
    return { id: "technical", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["computed"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const symbols = (opts?.symbols && opts.symbols.length > 0 ? opts.symbols : getTechnicalWatchlist())
    .map(normalizeSymbol)
    .filter(Boolean)
    .slice(0, MAX_COMPUTE_SYMBOLS);
  if (symbols.length === 0) {
    const ds = getTechnicalDataset();
    return { id: "technical", ok: false, recordCount: ds?.recordCount ?? 0, sources: [], fetchedAt: ds?.fetchedAt ?? "", warning: "no watchlist to compute" };
  }

  const signals: Record<string, TechnicalSignalRecord> = {};
  for (const symbol of symbols) {
    try {
      const bars = await fetchDailyOHLC(symbol, now);
      if (!bars || bars.length < 30) continue;
      const read = computeTechnicals(bars);
      if (!read) continue;
      signals[symbol] = toComputedRecord(symbol, read, now, bars[bars.length - 1]?.close);
    } catch {
      /* skip this symbol; never fabricate a signal */
    }
  }

  const recordCount = Object.keys(signals).length;
  if (recordCount === 0) {
    audit("web_source_refresh", { id: "technical", ok: false, recordCount: 0, source: "computed", requested: symbols.length });
    const ds = getTechnicalDataset();
    return { id: "technical", ok: false, recordCount: ds?.recordCount ?? 0, sources: [], fetchedAt: ds?.fetchedAt ?? "", warning: "no bars computed" };
  }

  const fetchedAt = new Date(now).toISOString();
  const dataset: TechnicalDataset = { signals, fetchedAt, recordCount, source: "computed" };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "technical", ok: true, recordCount, source: "computed", skipped: symbols.length - recordCount });
  return { id: "technical", ok: true, recordCount, sources: ["computed"], fetchedAt };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyDataset(source: TechnicalSource): TechnicalDataset {
  return { signals: {}, fetchedAt: "", recordCount: 0, source };
}

function toComputedRecord(symbol: string, read: TechnicalRead, now: number, price?: number): TechnicalSignalRecord {
  return {
    symbol,
    score: read.score,
    direction: read.direction,
    signals: read.signals,
    tf: "1d",
    price: numOrUndef(price),
    rsi14: read.rsi14,
    asOf: read.asOf,
    receivedAt: new Date(now).toISOString(),
    source: "computed",
    dedupeKey: `${symbol}|${read.signals.join(",")}|${read.asOf ?? ""}|${read.direction}`,
    bulletin: buildBulletin({ symbol, direction: read.direction, score: read.score, signals: read.signals, source: "computed", tf: "1d" })
  };
}

function buildBulletin(r: {
  symbol: string;
  direction: TechnicalDirection;
  score: number;
  signals: string[];
  source: TechnicalSource;
  tf?: string;
}): string {
  const named = r.signals.length > 0 ? r.signals.join(", ").replace(/_/g, " ") : `${r.direction} technical read`;
  const tf = r.tf ? ` ${r.tf}` : "";
  const src = r.source === "tradingview" ? "TradingView" : "computed";
  return `Technical${tf}: ${r.symbol} ${r.direction} ${r.score}/100 — ${named} [${src}].`;
}

function toDirection(action: unknown): TechnicalDirection {
  const a = String(action ?? "").toLowerCase();
  if (a === "bullish" || a === "buy" || a === "long") return "bullish";
  if (a === "bearish" || a === "sell" || a === "short") return "bearish";
  return "neutral";
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toIso(time: number | string | undefined): string | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    const ms = time > 1e12 ? time : time * 1000; // accept ms or seconds epoch
    return new Date(ms).toISOString();
  }
  if (typeof time === "string" && time) return time;
  return undefined;
}
