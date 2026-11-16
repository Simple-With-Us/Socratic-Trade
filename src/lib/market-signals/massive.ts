/**
 * Massive market data (api.massive.com) — a Polygon-compatible REST API (Bearer auth with
 * MASSIVE_API_KEY). We use the grouped-daily endpoint, which returns every US stock's OHLCV
 * for a single day in one call (~12k tickers), to compute TRUE full-universe market breadth —
 * a much broader read than the ~30-candidate sample in `marketInternals`. Two consecutive
 * trading days give each name's real day-over-day change. Failure-tolerant; never fabricated.
 *
 * (Massive also exposes S3 "flat files" at files.massive.com with separate flat-file access
 * key credentials. We use the REST API here, so no S3 signing is needed.)
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { getInternalSetting, resolveApiKeyWithSource } from "../db";

let cachedFetchWithRetry: typeof import("../data-providers").fetchWithRetry | undefined;
async function getFetchWithRetry() {
  if (!cachedFetchWithRetry) {
    const mod = await import("../data-providers");
    cachedFetchWithRetry = mod.fetchWithRetry;
  }
  return cachedFetchWithRetry;
}

export interface FullMarketBreadth {
  /** % of the full US universe advancing day-over-day. */
  breadthPct?: number;
  advancers: number;
  decliners: number;
  /** Most liquid biggest movers (volume-filtered to avoid penny-stock noise). */
  topGainers: Array<{ sym: string; pct: number }>;
  topLosers: Array<{ sym: string; pct: number }>;
  asOf?: string;
  universe: number;
}

interface GroupedBar { T?: string; o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number }
interface GroupedResponse { status?: string; results?: GroupedBar[] }

const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
// Client-side politeness / runaway-guard, NOT the provider's hard cap. The operator runs a paid
// Polygon/Massive "Starter" plan (unlimited API calls), so this default is generous — high enough
// that Massive reliably serves as the PRIMARY OHLC-history + full-market-breadth source (instead of
// falling back to rate-limited free Yahoo) while still bounding a pathological loop. A deployment on
// the FREE Massive tier (5 calls/min) should lower it via MASSIVE_REST_MAX_CALLS_PER_MINUTE=5.
const DEFAULT_REST_MAX_CALLS_PER_MINUTE = 100;
const DEFAULT_NEWS_TTL_MS = 30 * 60_000;
const GROUPED_BARS_TTL_MS = 30 * 60_000;
const restCallTimestamps: number[] = [];
const groupedBarsCache = new Map<string, { expiresAt: number; data: GroupedDailyBar[] }>();

function numericEnv(name: string, fallback: number, min = 0): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

export function massiveApiBase(): string {
  return process.env.MASSIVE_API_BASE ?? "https://api.massive.com";
}

// If the provider-tier watchdog (provider-tier.ts) detected the Massive key is on the FREE tier
// (e.g. the paid sub lapsed), clamp the effective limit to the free-safe 5/min so we don't 429-storm
// the raised paid default. Read from the persisted tier status, cached 60s to keep the reserve path
// cheap. Checks the "local" user's per-user key first (the scheduler runs the tier check for "local"),
// then falls back to the legacy shared key for backward compat with pre-per-user-scoping data.
// Defaults to "not free" on any read error, so detection can only ever lower the cap.
const FREE_SAFE_MAX_CALLS_PER_MINUTE = 5;
let tierClampCache = { at: 0, free: false };
function massiveDetectedFree(now: number): boolean {
  if (now - tierClampCache.at < 60_000) return tierClampCache.free;
  let free = false;
  try {
    // Per-user key (new — the scheduler writes this for "local")
    let status = getInternalSetting<Record<string, { tier?: string }>>("providerTier:status:local");
    // Legacy shared key (pre-2026-07-06) — fallback so existing data still clamps
    if (!status) status = getInternalSetting<Record<string, { tier?: string }>>("providerTier:status");
    free = status?.massive?.tier === "free";
  } catch {
    free = false;
  }
  tierClampCache = { at: now, free };
  return free;
}

/** Test helper: reset the tier-clamp cache so a freshly-written status is read immediately. */
export function clearMassiveTierClampCacheForTests(): void {
  tierClampCache = { at: 0, free: false };
}

export function reserveMassiveRestCall(now: number = Date.now()): boolean {
  const envMax = Math.floor(numericEnv("MASSIVE_REST_MAX_CALLS_PER_MINUTE", DEFAULT_REST_MAX_CALLS_PER_MINUTE));
  const maxCalls = massiveDetectedFree(now) ? Math.min(envMax, FREE_SAFE_MAX_CALLS_PER_MINUTE) : envMax;
  if (maxCalls <= 0) return false;
  const windowMs = 60_000;
  while (restCallTimestamps.length > 0 && now - restCallTimestamps[0]! >= windowMs) restCallTimestamps.shift();
  if (restCallTimestamps.length >= maxCalls) return false;
  restCallTimestamps.push(now);
  return true;
}

export function clearMassiveRestBudgetForTests(): void {
  restCallTimestamps.length = 0;
  groupedBarsCache.clear();
  breadthCache.expiresAt = 0;
  breadthCache.data = undefined;
  newsCache.clear();
}

export interface GroupedDailyBar { ticker: string; open?: number; high?: number; low?: number; close: number; volume?: number; vwap?: number }

function fetchGroupedBarsLocal(date: string): GroupedDailyBar[] | null {
  if ((process.env.MASSIVE_LOCAL_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const [yyyy, mm] = date.split("-");
    const baseDir = path.join(process.cwd(), "data", "massive-history");
    const gzFile = path.join(baseDir, yyyy, mm, `${date}.json.gz`);
    const jsonFile = path.join(baseDir, yyyy, mm, `${date}.json`);

    let buf: Buffer | null = null;
    if (fs.existsSync(gzFile)) {
      buf = zlib.gunzipSync(fs.readFileSync(gzFile));
    } else if (fs.existsSync(jsonFile)) {
      buf = fs.readFileSync(jsonFile);
    }
    if (!buf) return null;
    const json = JSON.parse(buf.toString("utf8"));
    const rows = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : [];
    const bars: GroupedDailyBar[] = [];
    for (const r of rows) {
      const ticker = r.T ?? r.ticker ?? r.symbol;
      const c = typeof r.c === "number" ? r.c : typeof r.close === "number" ? r.close : undefined;
      if (typeof ticker === "string" && typeof c === "number" && Number.isFinite(c)) {
        bars.push({
          ticker,
          open: numOrUndef(r.o ?? r.open),
          high: numOrUndef(r.h ?? r.high),
          low: numOrUndef(r.l ?? r.low),
          close: c,
          volume: numOrUndef(r.v ?? r.volume),
          vwap: numOrUndef(r.vw ?? r.vwap)
        });
      }
    }
    return bars.length > 0 ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Bulk daily OHLCV for the whole US stock market via local flat files (data/massive-history/)
 * or REST grouped-daily endpoint (~12k tickers in one call).
 */
export async function fetchGroupedBarsRest(date: string, userId?: string): Promise<GroupedDailyBar[] | null> {
  const localBars = fetchGroupedBarsLocal(date);
  if (localBars && localBars.length > 0) {
    return localBars;
  }
  const { key, source } = resolveApiKeyWithSource("massive", userId);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const cacheKey = `${userId ?? "local"}:${date}`;
  const cached = groupedBarsCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  if (!reserveMassiveRestCall()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const url = `${massiveApiBase()}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`;
    // Tracked provider boundary (usage-compliance WS1 gap #1): same circuit breaker, health
    // logging, and usage.jays.services call-volume telemetry as MassiveEnrichmentProvider in
    // data-providers.ts. `retries: 0` because reserveMassiveRestCall() above reserved exactly ONE
    // call — fetchWithRetry's contract says exact-quota reservers must not hide an uncounted
    // internal 429 retry inside one logical call.
    const fetchWithRetry = await getFetchWithRetry();
    const res = await fetchWithRetry(
      url,
      { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${key}` } },
      { service: "massive", keySource: source, userId, apiKey: key, retries: 0 }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as GroupedResponse;
    const rows = json?.results ?? [];
    const bars: GroupedDailyBar[] = [];
    for (const r of rows) {
      if (typeof r.T === "string" && typeof r.c === "number" && Number.isFinite(r.c)) {
        bars.push({ ticker: r.T, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v), vwap: numOrUndef(r.vw) });
      }
    }
    if (bars.length === 0) return null;
    groupedBarsCache.set(cacheKey, { expiresAt: now + GROUPED_BARS_TTL_MS, data: bars });
    return bars;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function fetchRecentGroupedBarsRest(
  now: number = Date.now(),
  userId?: string,
  maxDateProbes = Math.floor(numericEnv("MASSIVE_GROUPED_MAX_DATE_PROBES", 5, 1))
): Promise<{ date: string; bars: GroupedDailyBar[] } | null> {
  for (const date of recentDates(maxDateProbes, now)) {
    const bars = await fetchGroupedBarsRest(date, userId);
    if (bars && bars.length > 0) return { date, bars };
  }
  return null;
}

export interface MarketNewsItem {
  title: string;
  publisher?: string;
  url?: string;
  publishedAt?: string;
  tickers?: string[];
}

interface MassiveNewsResponse {
  results?: Array<{
    title?: string;
    article_url?: string;
    published_utc?: string;
    publisher?: { name?: string };
    tickers?: string[];
  }>;
}

/** Recent market-wide news headlines (Massive /v2/reference/news, Polygon-compatible). */
const newsCache = new Map<string, { expiresAt: number; data: MarketNewsItem[] }>();

export async function fetchMassiveNews(limit = 8, userId?: string): Promise<MarketNewsItem[]> {
  const { key, source } = resolveApiKeyWithSource("massive", userId);
  if (!key) return [];
  const now = Date.now();
  const cacheKey = `${userId ?? "local"}:${limit}`;
  const cached = newsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;
  if (!reserveMassiveRestCall(now)) return cached?.data ?? [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // Tracked provider boundary — see fetchGroupedBarsRest for the retries: 0 rationale.
    const fetchWithRetry = await getFetchWithRetry();
    const res = await fetchWithRetry(
      `${massiveApiBase()}/v2/reference/news?order=desc&limit=${limit}`,
      {
        cache: "no-store",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}` }
      },
      { service: "massive", keySource: source, userId, apiKey: key, retries: 0 }
    );
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = (await res.json()) as MassiveNewsResponse;
    const data = (json?.results ?? [])
      .filter((r) => typeof r.title === "string" && r.title.length > 0)
      .map((r) => ({
        title: r.title as string,
        publisher: r.publisher?.name,
        url: r.article_url,
        publishedAt: r.published_utc,
        tickers: Array.isArray(r.tickers) ? r.tickers.slice(0, 4) : undefined
      }));
    newsCache.set(cacheKey, { expiresAt: now + numericEnv("MASSIVE_NEWS_TTL_MS", DEFAULT_NEWS_TTL_MS), data });
    return data;
  } catch {
    clearTimeout(timeout);
    return cached?.data ?? [];
  }
}

/** Last `n` calendar days as YYYY-MM-DD, newest first (weekends/holidays return empty + are skipped). */
function recentDates(n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(new Date(now - i * 24 * 60 * 60_000).toISOString().slice(0, 10));
  }
  return out;
}

async function fetchGrouped(
  date: string,
  key: string,
  keySource?: string,
  userId?: string
): Promise<Map<string, { close: number; vol: number }> | null> {
  if (!reserveMassiveRestCall()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `${massiveApiBase()}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`;
    // Tracked provider boundary — see fetchGroupedBarsRest for the retries: 0 rationale.
    const fetchWithRetry = await getFetchWithRetry();
    const res = await fetchWithRetry(
      url,
      { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${key}` } },
      { service: "massive", keySource, userId, apiKey: key, retries: 0 }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as GroupedResponse;
    const rows = json?.results ?? [];
    if (rows.length === 0) return null;
    const map = new Map<string, { close: number; vol: number }>();
    for (const r of rows) {
      if (typeof r.T === "string" && typeof r.c === "number" && Number.isFinite(r.c) && r.c > 0) {
        map.set(r.T, { close: r.c, vol: typeof r.v === "number" ? r.v : 0 });
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

const MIN_VOLUME_FOR_MOVERS = 1_000_000; // ignore illiquid names when ranking movers

// Own success-only cache so a transient failure never poisons the market-signals bundle, and
// repeated callers (dashboard + strategy) share one grouped-file fetch.
const BREADTH_TTL_MS = 30 * 60_000;
const breadthCache: { expiresAt: number; data: FullMarketBreadth | undefined } = { expiresAt: 0, data: undefined };

export async function fetchFullMarketBreadth(now: number = Date.now(), userId?: string): Promise<FullMarketBreadth | undefined> {
  if (breadthCache.data && breadthCache.expiresAt > now) return breadthCache.data;
  const { key, source } = resolveApiKeyWithSource("massive", userId);
  if (!key) return undefined;

  // Collect the two most recent trading days that have data.
  const days: Array<{ date: string; map: Map<string, { close: number; vol: number }> }> = [];
  const maxDateProbes = Math.floor(numericEnv("MASSIVE_BREADTH_MAX_DATE_PROBES", 5, 1));
  for (const date of recentDates(maxDateProbes, now)) {
    const map = await fetchGrouped(date, key, source, userId);
    if (map && map.size > 100) days.push({ date, map });
    if (days.length === 2) break;
  }
  if (days.length < 2) return breadthCache.data;

  const [today, prev] = days; // newest first
  let advancers = 0;
  let decliners = 0;
  const movers: Array<{ sym: string; pct: number }> = [];
  for (const [sym, t] of today.map) {
    const p = prev.map.get(sym);
    if (!p || p.close <= 0) continue;
    const pct = ((t.close - p.close) / p.close) * 100;
    if (pct > 0) advancers += 1;
    else if (pct < 0) decliners += 1;
    if (t.vol >= MIN_VOLUME_FOR_MOVERS && Number.isFinite(pct)) movers.push({ sym, pct: Math.round(pct * 100) / 100 });
  }
  const total = advancers + decliners;
  movers.sort((a, b) => b.pct - a.pct);
  const result: FullMarketBreadth = {
    breadthPct: total > 0 ? Math.round((advancers / total) * 100) : undefined,
    advancers,
    decliners,
    topGainers: movers.slice(0, 5),
    topLosers: movers.slice(-5).reverse(),
    asOf: today.date,
    universe: total
  };
  breadthCache.data = result; // success-only cache
  breadthCache.expiresAt = now + BREADTH_TTL_MS;
  return result;
}
