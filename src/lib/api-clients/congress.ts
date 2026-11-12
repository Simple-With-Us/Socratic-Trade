import "server-only";
import { CongressTradeClient } from "@jaywedgeworth22/congress-trading-shared";
import { z } from "zod";
import { logApiHealth } from "../db-health";
import {
  PEER_LANE_CONGRESS_TRADE,
  recordPeerLaneSample,
  shouldDeferPeerRefresh,
} from "../peer-lane-backoff";

const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 8_000;

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

/**
 * Parse an env flag. When `defaultOn` is true, an unset/blank value enables the
 * feature; explicit off (`0`/`false`/`no`/`off`) still disables it.
 */
function flagOn(value: string | undefined, defaultOn = false): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return defaultOn;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Price/history cache-aside — remains opt-in (can echo Massive via peer; keep default off). */
export function congressReadsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_READS_ENABLED, false);
}

/**
 * Fundamentals/analyst read-back from App A. Default OFF — owner 2026-08-04:
 * Socratic fundamentals come from the multi-provider cascade (Yahoo, Finnhub,
 * ROIC, SEC XBRL, Tiingo, SimFin, …), not from Congress.Trade or direct FMP.
 * Opt in only if you want App A as an extra cache-aside tier.
 */
export function congressFundamentalsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED, false);
}

/**
 * App A as congressional disclosure source of record. Default ON: replaces
 * scrapers / direct Quiver congressional counts (owner 2026-08-04).
 */
export function congressAsCongressSourceEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE, true);
}

/**
 * App A analytics overlay (conviction, clusters, member skill). Default ON so
 * congress composite scoring has a real peer feed without paid alt-data keys.
 */
export function congressAnalyticsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_ANALYTICS_ENABLED, true);
}

function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function timeoutMs(): number {
  const v = Number(process.env.CONGRESS_TRADE_READ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

let sharedClientInstance: CongressTradeClient | null = null;

/** Shared timeout, peer-lane defer, and health log.  No new auth scheme. */
export async function congressTradeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { softStatuses?: readonly number[] } = {}
): Promise<Response> {
  if (shouldDeferPeerRefresh(PEER_LANE_CONGRESS_TRADE)) {
    const err = new Error("congress.trade deferred (peer lane slow)");
    err.name = "AbortError";
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const start = Date.now();
  try {
    const res = await fetch(input, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        "User-Agent": "SocraticTrade/1.0"
      },
      signal: controller.signal,
      cache: "no-store"
    });
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_CONGRESS_TRADE, latencyMs);
    logApiHealth({
      service: "congress.trade",
      ok: res.ok,
      latencyMs,
      errorText: res.ok ? undefined : `HTTP ${res.status}`,
      soft: !res.ok && (res.status === 429 || res.status === 503 || (opts.softStatuses ?? []).includes(res.status)),
    });
    // Live `9d71dda4`: a 502 must fail-open gather, not keep pulling the
    // rest of the 250-name batch.  404 stays a miss (return the body).
    if (!res.ok && (res.status === 429 || res.status >= 500)) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    if (/^HTTP \d+/.test(errorText)) throw err;
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_CONGRESS_TRADE, latencyMs);
    logApiHealth({
      service: "congress.trade",
      ok: false,
      latencyMs,
      errorText,
      soft: true,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function getCongressTradeClient(): CongressTradeClient {
  if (!sharedClientInstance) {
    sharedClientInstance = new CongressTradeClient({
      baseUrl: baseUrl(),
      token: readToken(),
      fetch: congressTradeFetch
    });
  }
  return sharedClientInstance;
}

export interface CongressTransactionsPageRaw {
  transactions: unknown[];
  cursor: number;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * GET /api/transactions without the published client's Zod strip.  Same base
 * URL, optional bearer, and fetch wrapper as {@link getCongressTradeClient}.
 * Returns null when the body is not a transactions page.  429 and 5xx still throw.
 */
export async function readCongressTransactionsPage(query: {
  since?: string | number;
  from?: string;
  limit?: number;
}): Promise<CongressTransactionsPageRaw | null> {
  const params = new URLSearchParams();
  if (query.since !== undefined && String(query.since) !== "") params.set("since", String(query.since));
  if (query.from) params.set("from", query.from);
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json"
  };
  const token = readToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await congressTradeFetch(`${baseUrl()}/api/transactions${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers
  });
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const page = body as { transactions?: unknown; cursor?: unknown };
  if (!Array.isArray(page.transactions)) return null;
  let cursor = finiteNumber(page.cursor) ?? 0;
  for (const raw of page.transactions) {
    if (!raw || typeof raw !== "object") continue;
    const rowCursor = finiteNumber((raw as { cursorSeq?: unknown }).cursorSeq);
    if (rowCursor !== undefined && rowCursor > cursor) cursor = rowCursor;
  }
  return { transactions: page.transactions, cursor };
}

export interface CongressRetraction {
  txId: string;
  docId?: string;
  retractedAt?: string;
}

export interface CongressRetractionsPageRaw {
  retractions: CongressRetraction[];
  cursor: number;
}

/** A 401/403 from Congress.Trade: the read token is wrong or lacks access. */
export class CongressTradeAuthError extends Error {
  constructor(readonly status: number, path: string) {
    super(
      `congress.trade ${path} HTTP ${status}: the bearer from CONGRESS_TRADE_READ_TOKEN was rejected` +
        (readToken() ? "" : " (CONGRESS_TRADE_READ_TOKEN is not set)")
    );
    this.name = "CongressTradeAuthError";
  }
}

const RetractionTxIdSchema = z.string().trim().min(1).max(200);
const finiteCursor = z.union([z.number(), z.string().trim().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative());

/** One retraction row as Congress.Trade serves it (retractions.ts toWire). */
const CongressRetractionRowSchema = z.object({
  txId: RetractionTxIdSchema,
  docId: z.string().optional(),
  retractedAt: z.string().optional(),
  retractSeq: finiteCursor.optional(),
  cursor: finiteCursor.optional(),
  cursorSeq: finiteCursor.optional()
});

/** GET /api/transactions/retractions page; unknown top-level fields are ignored. */
export const CongressRetractionsPageSchema = z.object({
  retractions: z.array(z.unknown()),
  cursor: finiteCursor.optional(),
  hasMore: z.boolean().optional()
});

/**
 * GET /api/transactions/retractions?since=<cursor> (same base URL and optional
 * bearer as /api/transactions; the CT endpoint is public like that feed).
 * Rows are `{retractSeq, txId, docId, retractedAt}`.  Returns null only on a
 * 404 (endpoint not deployed yet, logged as a soft miss).  401/403 throw
 * CongressTradeAuthError, every other non-OK status or a body that is not a
 * retractions page throws, so the caller surfaces it and the retraction
 * cursor never advances past unread rows.  Rows that fail validation are
 * skipped but still advance the cursor via the page cursor.
 */
export async function readCongressRetractionsPage(query: {
  since?: string | number;
  limit?: number;
}): Promise<CongressRetractionsPageRaw | null> {
  const params = new URLSearchParams();
  if (query.since !== undefined && String(query.since) !== "") params.set("since", String(query.since));
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  const headers: Record<string, string> = { accept: "application/json" };
  const token = readToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const path = "/api/transactions/retractions";
  const res = await congressTradeFetch(`${baseUrl()}${path}${qs ? `?${qs}` : ""}`, { method: "GET", headers }, { softStatuses: [404] });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new CongressTradeAuthError(res.status, path);
  if (!res.ok) throw new Error(`congress.trade ${path} HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`congress.trade ${path}: response is not JSON`);
  }
  const page = CongressRetractionsPageSchema.safeParse(body);
  if (!page.success) throw new Error(`congress.trade ${path}: not a retractions page`);
  let cursor = page.data.cursor ?? 0;
  const retractions: CongressRetraction[] = [];
  for (const raw of page.data.retractions) {
    const row = CongressRetractionRowSchema.safeParse(raw);
    if (!row.success) continue;
    const rowCursor = row.data.retractSeq ?? row.data.cursor ?? row.data.cursorSeq;
    if (rowCursor !== undefined && rowCursor > cursor) cursor = rowCursor;
    retractions.push({
      txId: row.data.txId,
      ...(row.data.docId !== undefined ? { docId: row.data.docId } : {}),
      ...(row.data.retractedAt !== undefined ? { retractedAt: row.data.retractedAt } : {})
    });
  }
  return { retractions, cursor };
}

/** Test-only: drop the shared client so a later getCongressTradeClient() rebuilds the wrapper. */
export function resetCongressTradeClientForTests(): void {
  sharedClientInstance = null;
}

import type { PriceClose } from "@jaywedgeworth22/congress-trading-shared";
import type { OHLCBar } from "../indicators";

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
