// Nasdaq public calendar API — keyless, dormant-by-default-ON producer for the existing
// `daysToEarnings` carrier field. The owner has explicitly waived the general ToS caution that
// previously blocked scraping api.nasdaq.com for anything beyond the delayed screener (this repo
// already depends on that same host/UA pattern for market.ts's NASDAQ_SCREENER_URL and for
// data-providers.ts's NasdaqQuoteEnrichmentProvider — this file is a third, independent consumer
// of the same public host).
//
// LIVE-VERIFIED 2026-08-02 (curl against the real host — do not trust the pre-existing research
// doc's guessed paths, two of the three were wrong):
//   - Earnings:   GET https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
//                 -> { data: { asOf, headers, rows: [{ symbol, name, time, ... }] | null } }
//                 `rows` is `null` (not `[]`, not absent) on days with zero reports (e.g. weekends)
//                 — confirmed live for a real Sunday (2026-08-02): `"rows":null`.
//   - Dividends:  GET https://api.nasdaq.com/api/calendar/dividends?date=YYYY-MM-DD
//                 -> { data: { calendar: { asOf, headers, rows: [...] } } } — note the EXTRA
//                 `calendar` nesting layer that the earnings endpoint does NOT have. Confirmed
//                 live; not consumed by this file (see the "Dividends / IPOs" note below).
//   - IPOs:       The path guessed in the task brief, `/api/calendar/ipos?date=YYYY-MM`, 404s.
//                 The REAL live endpoint is `/api/ipo/calendar?date=YYYY-MM` (singular "ipo", verb
//                 order swapped) -> { data: { upcoming: { upcomingTable: { rows: [{
//                 proposedTickerSymbol, companyName, expectedPriceDate, ... }] } }, priced: {...},
//                 filed: {...}, withdrawn: {...} } }. Confirmed live 2026-08-02 (3 upcoming NASDAQ
//                 deals returned). Not consumed by this file (see note below) — this correction is
//                 recorded here so the integration pass (or a future dividend/IPO wiring task)
//                 doesn't re-guess the wrong path.
//
// Only the earnings calendar is wired here. SymbolEnrichment has no ex-dividend-date or IPO-date
// carrier field today, and inventing one is a 6-touchpoint wiring change (interface + sourced-field
// union + takeScalar + EMPTY_SOURCED + MarketQuote/MarketQuoteSummary + market.ts merge) explicitly
// out of scope for this task — see integrationNotes in the handoff for the exact finding instead of
// silently skipping it.
//
// Shape of the problem: `daysToEarnings` needs the NEXT future earnings date for a symbol, but the
// calendar endpoint is scoped by DATE (returns every symbol reporting that day), not by symbol. A
// naive per-symbol design doesn't exist server-side, so this provider inverts the query: it walks
// forward from today one day at a time (in small parallel chunks), building a shared, module-level
// "which symbols report on date X" index, and stops as soon as every symbol in THIS call has been
// located (or the horizon is exhausted). The per-date index is deliberately a single shared cache —
// like market.ts's screenerCache, this is public unauthenticated data, safe to serve every user from
// one cache — so a cold horizon walk only ever happens once per TTL window regardless of how many
// enrich() calls/users hit it in between.
//
// Never throws out of enrich(): every per-date fetch is caught independently and negative-cached
// (short TTL) so a single bad day never blocks the others or gets hammered every call.

import type { EnrichmentContext, MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { fetchWithRetry } from "./data-providers";
import { normalizeSymbol } from "./money";
import { BROWSER_UA } from "./web-sources/http";

const NASDAQ_CALENDAR_BASE = "https://api.nasdaq.com/api/calendar";

// Browser-like UA — same as NASDAQ_QUOTE_UA in data-providers.ts. Live-verified 2026-08-05:
// the prior contactable "compatible; SocraticTrade/1.0" bot UA hangs against api.nasdaq.com
// while Chrome desktop UA returns 200 for /api/calendar/earnings and quote paths.
const NASDAQ_CALENDAR_UA = BROWSER_UA;

function flagEnabled(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Default ON — mirrors data-providers.ts's secXbrlEnrichmentEnabled() exactly: unset/blank env
 *  => enabled; once set, the value must parse as truthy to stay enabled. Env:
 *  NASDAQ_CALENDAR_ENRICHMENT_ENABLED. */
export function nasdaqCalendarEnabled(): boolean {
  const raw = process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return flagEnabled(raw);
}

const DEFAULT_HORIZON_DAYS = 45;
const MIN_HORIZON_DAYS = 7;
const MAX_HORIZON_DAYS = 90;

/** How many calendar days forward of "today" to scan for a next earnings date before giving up
 *  (returning undefined rather than an unbounded, ever-growing per-call fetch count). Env:
 *  NASDAQ_CALENDAR_HORIZON_DAYS, clamped to [7, 90]; default 45. A symbol whose next earnings date
 *  falls beyond the horizon simply gets no daysToEarnings from this provider this cycle — never a
 *  guess — same as any other provider's coverage gap. */
export function nasdaqCalendarHorizonDays(): number {
  const value = Number(process.env.NASDAQ_CALENDAR_HORIZON_DAYS);
  if (!Number.isFinite(value)) return DEFAULT_HORIZON_DAYS;
  return Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, Math.floor(value)));
}

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const MIN_TTL_MS = 30 * 60_000;

/** Positive-result TTL for a single date's symbol index. Nasdaq's earnings calendar is populated
 *  ahead of time and only shifts as companies confirm/reschedule, so a several-hour cache is safe
 *  for a keyless, shared, non-time-critical field. Env: NASDAQ_CALENDAR_CACHE_TTL_MS, floored at
 *  30 minutes so a low override can't turn this into a per-call hammer. */
function nasdaqCalendarTtlMs(): number {
  const value = Number(process.env.NASDAQ_CALENDAR_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= MIN_TTL_MS ? value : DEFAULT_TTL_MS;
}

const DEFAULT_NEGATIVE_TTL_MS = 30 * 60_000;

/** Short negative-cache TTL for a date whose fetch failed (network error / non-2xx / malformed
 *  body) — retries the same date again well within the same trading day instead of waiting out the
 *  full positive TTL. Env: NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS. */
function nasdaqCalendarNegativeTtlMs(): number {
  const value = Number(process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NEGATIVE_TTL_MS;
}

const DEFAULT_MAX_SYMBOLS = 500;

/** Bounds the output/memory size of a single enrich() call. Unlike a per-symbol provider, this
 *  provider's OUTBOUND request count is governed by the horizon (dates), not by symbol count, so
 *  this cap exists for sane output sizing rather than quota protection. Env:
 *  NASDAQ_CALENDAR_MAX_SYMBOLS. */
function nasdaqCalendarMaxSymbols(): number {
  const value = Number(process.env.NASDAQ_CALENDAR_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

// Parallel date-fetch chunk size while walking the horizon. Small and polite (mirrors the
// CONCURRENCY=4 convention other providers in this cascade use for the same reason).
const CHUNK_SIZE = 4;

/** Nasdaq's calendar rows use dots for share classes (e.g. "BRK.B"), matching the wire format
 *  documented elsewhere in this codebase for this same host (data-providers.ts: "BRK.B works on
 *  Nasdaq's API; BRK-B does not"). Our canonical in-app symbol format hyphenates share classes
 *  (money.ts normalizeSymbol / the sp500.ts convention), so convert dot -> hyphen when indexing a
 *  day's rows for matching against caller-supplied (already-hyphenated) symbols. */
function toCanonicalSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/\./g, "-");
}

/** Parses `GET /api/calendar/earnings?date=...`'s response into the Set of symbols reporting that
 *  day. Tolerant of every malformed shape actually observed live: `data` absent, `rows` absent,
 *  and `rows: null` (confirmed live for a zero-report day) all resolve to an empty Set rather than
 *  throwing. */
export function extractEarningsSymbols(payload: unknown): Set<string> {
  const rows = (payload as { data?: { rows?: unknown } } | undefined)?.data?.rows;
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const symbol = (row as Record<string, unknown>).symbol;
    if (typeof symbol === "string" && symbol.trim()) out.add(toCanonicalSymbol(symbol));
  }
  return out;
}

/** UTC-midnight-anchored `YYYY-MM-DD` for `offsetDays` days ahead of `now`. UTC is used as a
 *  deliberate, documented approximation of Nasdaq's own (US/Eastern) calendar-day boundary — this
 *  field is advisory/informational (see the SymbolEnrichment doc comment: "never fabricated"), not
 *  a precise timestamp, so a boundary date that's off by one within a few hours of US midnight is
 *  an acceptable trade-off for a keyless, dependency-free implementation. */
export function dateKeyFromOffset(now: number, offsetDays: number): string {
  const d = new Date(now);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const target = new Date(utcMidnight + offsetDays * 86_400_000);
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface DayCacheEntry {
  expiresAt: number;
  symbols: Set<string>;
}

// Shared, module-level, keyless — one index per calendar date, safe to serve every user/call.
const dayCache = new Map<string, DayCacheEntry>();

/** Test helper: clear the shared per-date cache between runs. */
export function clearNasdaqCalendarCache(): void {
  dayCache.clear();
}

export class NasdaqCalendarEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "nasdaq-calendar";
  readonly configured = true;
  readonly costTier = "free" as const;
  readonly suppliesFields = ["daysToEarnings"] as const;

  async enrich(symbols: string[], context?: EnrichmentContext): Promise<Record<string, SymbolEnrichment>> {
    if (!nasdaqCalendarEnabled()) return {};

    const normalized = Array.from(new Set(symbols.map(normalizeSymbol)))
      .filter(Boolean)
      .slice(0, nasdaqCalendarMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;

    // Skip symbols an earlier-registered cascade provider already covered for this field this
    // cycle — mirrors FilingApiEnrichmentProvider's `context?.coveredFields` short-circuit.
    const remaining = new Set<string>();
    for (const symbol of normalized) {
      const covered = context?.coveredFields?.[symbol];
      result[symbol] = {};
      if (!covered?.has("daysToEarnings")) remaining.add(symbol);
    }
    if (remaining.size === 0) return result;

    const now = Date.now();
    const horizonDays = nasdaqCalendarHorizonDays();

    for (let start = 0; start <= horizonDays && remaining.size > 0; start += CHUNK_SIZE) {
      const offsets: number[] = [];
      for (let offset = start; offset < start + CHUNK_SIZE && offset <= horizonDays; offset++) {
        offsets.push(offset);
      }
      // Promise.all preserves input order in its result array regardless of settle order, so
      // `dayResults` below stays in ascending-offset order — required so the FIRST matching day
      // within (and across) chunks wins as the "next" earnings date.
      const dayResults = await Promise.all(
        offsets.map(async (offset) => ({
          offset,
          daySymbols: await this.getDaySymbols(dateKeyFromOffset(now, offset), now)
        }))
      );
      for (const { offset, daySymbols } of dayResults) {
        if (remaining.size === 0) break;
        const matched: string[] = [];
        for (const symbol of remaining) {
          if (daySymbols.has(symbol)) matched.push(symbol);
        }
        for (const symbol of matched) {
          const fetchedAt = new Date(now).toISOString();
          // Calendar row asOf = the earnings date key (market fact); fetchedAt = when we read it.
          // Cascade takeScalar will preserve these fieldObservations (source-capability-matrix: earnings_calendar).
          const earningsDate = dateKeyFromOffset(now, offset);
          result[symbol] = {
            daysToEarnings: offset,
            sources: { daysToEarnings: "nasdaq-calendar" },
            fieldObservations: {
              daysToEarnings: {
                value: offset,
                source: "nasdaq-calendar",
                upstreamFamily: "nasdaq-calendar",
                asOf: earningsDate,
                fetchedAt,
                status: "ok"
              }
            },
            fieldDates: { daysToEarnings: earningsDate }
          };
          remaining.delete(symbol);
        }
      }
    }

    return result;
  }

  private async getDaySymbols(dateKey: string, now: number): Promise<Set<string>> {
    const cached = dayCache.get(dateKey);
    if (cached && cached.expiresAt > now) return cached.symbols;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let symbols: Set<string>;
      try {
        const response = await fetchWithRetry(
          `${NASDAQ_CALENDAR_BASE}/earnings?date=${dateKey}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: "application/json,text/plain,*/*",
              "User-Agent": NASDAQ_CALENDAR_UA,
              Origin: "https://www.nasdaq.com",
              Referer: "https://www.nasdaq.com/"
            }
          },
          { service: this.name, retries: 1 }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        symbols = extractEarningsSymbols(await response.json());
      } finally {
        clearTimeout(timeout);
      }
      dayCache.set(dateKey, { expiresAt: now + nasdaqCalendarTtlMs(), symbols });
      return symbols;
    } catch {
      const empty = new Set<string>();
      dayCache.set(dateKey, { expiresAt: now + nasdaqCalendarNegativeTtlMs(), symbols: empty });
      return empty;
    }
  }
}
