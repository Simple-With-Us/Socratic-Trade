/**
 * BLS (Bureau of Labor Statistics) Public Data API v2 — a license-clean macro companion to FRED.
 * Unlike FRED (which requires a registered API key for any use), the BLS v2 API is USABLE KEYLESS:
 * registration only raises quota/feature ceilings, it isn't a hard gate. That makes this module a
 * second independent keyless macro floor (alongside `./treasury`'s par-yield curve) — headline CPI
 * inflation, the unemployment rate, and the payrolls print are available even when the operator has
 * never registered a BLS key, matching the "at least SOMETHING real, never a fabricated placeholder"
 * posture the keyless VIX/Treasury cascade already uses (see macro.ts's fetchVixOnlyFallback).
 *
 * Live-verified against the real API 2026-08-02 (not just BLS's docs, which are also cited below):
 *   - Endpoint: POST https://api.bls.gov/publicAPI/v2/timeseries/data/ , header
 *     `Content-Type: application/json`, JSON body `{ seriesid: string[], startyear, endyear,
 *     registrationkey? }`. Confirmed live with a real multi-series request (CUUR0000SA0 +
 *     LNS14000000 + CES0000000001, no key) — HTTP 200, real current data through 2026-06.
 *   - Response shape (live-observed, matches BLS's own archived API v2 docs —
 *     https://www.bls.gov/developers/api_signature_v2.htm, wayback snapshot 2026-06-12):
 *     `{ status: "REQUEST_SUCCEEDED", responseTime, message: string[],
 *        Results: { series: [{ seriesID, data: [{ year, period, periodName, value, latest?,
 *        footnotes }] }] } }`. A malformed request still returns HTTP 200 with
 *     `status: "REQUEST_FAILED"` and `Results: null` (live-observed) — never assume 200 means usable
 *     data, always check `status` AND that `Results`/`series` are actually present.
 *   - An unknown/invalid series ID does not error the whole call — it comes back as
 *     `{ seriesID, data: [] }` with a note in the top-level `message` array (live-observed).
 *   - A row can carry a non-numeric `value` (literally the string "-") with a footnote explaining an
 *     outage — live-observed for 2025-10 on both CUUR0000SA0 and LNS14000000, footnoted "Data
 *     unavailable due to the 2025 lapse in appropriations" (the Oct 2025 government shutdown). Any
 *     row like this must be dropped, never parsed as 0 or skipped-silently-in-a-way-that-shifts-
 *     month-over-month math (see `parseSeriesPoints` / the exact-month-key lookups below).
 *   - Rate limits (BLS's own FAQ page, wayback snapshot 2026-06-12 of
 *     https://www.bls.gov/developers/api_faqs.htm — a prior research pass's numbers for this were
 *     unverified and a competing third-party blog had it wrong (500/2000), so this table is taken
 *     only from BLS's own page):
 *         table                     v1.0 unregistered   v2.0 registered (with key)
 *         daily query limit         25                  500
 *         series per query limit    25                  50
 *         years per query limit     10                  20
 *         request rate limit        50 req / 10s        50 req / 10s
 *         net/percent changes       no                  yes
 *         annual averages           no                  yes
 *         catalog (series metadata) no                  yes
 *     This module only ever issues ONE combined request per refresh (3 series in one POST — well
 *     under either tier's per-query series cap) and caches the result for hours, so it stays far
 *     under the 25/day keyless ceiling even on the keyless tier.
 *
 * Series IDs (confirmed current and live-returning real 2026 data via the request above — these are
 * NOT guessed from training-data memory):
 *   - CUUR0000SA0   CPI-U, All Items, U.S. city average, NOT seasonally adjusted. This module
 *     computes the trailing 12-month % change itself (BLS returns the raw index level, e.g.
 *     "333.952", not a rate) — the same YoY-inflation-rate meaning as macro.ts's FRED-sourced
 *     `cpiInflation` (which asks FRED for the `pc1` transform of CPIAUCSL). NSA, not SA, deliberately:
 *     BLS's own headline CPI news release quotes the 12-month change off the NSA index, and a 12-
 *     month comparison already cancels most seasonality anyway.
 *   - LNS14000000   Unemployment rate, 16 years+, seasonally adjusted. Already a rate ("4.2") — no
 *     transform needed.
 *   - CES0000000001 Total nonfarm employment, seasonally adjusted, thousands of jobs. BLS returns the
 *     raw employment LEVEL (e.g. "158984" = ~158.98M jobs), not the conventional "jobs report"
 *     month-over-month change — this module computes that difference itself.
 *
 * Never fabricates: a failed fetch, a malformed body, or a request that returns no usable rows for a
 * given series produces `null` for the whole result (if nothing at all is usable) or simply omits
 * that one field (if only one series came back empty) — never a placeholder number.
 */

const BLS_TIMESERIES_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

const SERIES_CPI_U = "CUUR0000SA0";
const SERIES_UNEMPLOYMENT = "LNS14000000";
const SERIES_PAYROLLS = "CES0000000001";

export interface BlsMacroSeries {
  /** CPI-U (all items, U.S. city average, NSA), trailing 12-month % change — e.g. "3.53%". */
  cpiInflation?: string;
  /** Seasonally adjusted national unemployment rate, % — e.g. "4.20%". */
  unemploymentRate?: string;
  /** Month-over-month change in total nonfarm payroll employment, thousands of jobs — e.g. "+57K"
   *  or "-12K". This is the conventional "jobs report" headline number, not the raw employment level. */
  nonfarmPayrollsChangeK?: string;
  /** Latest publication month actually reflected among the fields above, "YYYY-MM". When series lag
   *  each other (they often do — CES usually leads LNS/CPI by a few days), this is the max across
   *  whichever fields resolved, not a single shared release date. */
  asOf?: string;
}

/** The sole registration gate: trimmed `BLS_API_KEY`, or undefined when unset/blank. Registering is
 *  optional for this API (unlike FRED) — the keyless tier is a real, useful floor, not a stub. */
export function resolveBlsApiKey(): string | undefined {
  const key = (process.env.BLS_API_KEY ?? "").trim();
  return key || undefined;
}

interface BlsSeriesPoint {
  year: number;
  /** 1-12. */
  month: number;
  value: number;
}

function monthKey(p: { year: number; month: number }): number {
  return p.year * 12 + p.month;
}

/** Parses one series' raw `data` array into valid, sorted (ascending) monthly points. Drops any row
 *  that isn't a plain calendar month (e.g. an M13 annual-average row, only returned when
 *  `annualaverage=true` is requested, which this module never does) or whose `value` doesn't parse
 *  as a finite number (BLS uses the literal string "-" for a footnoted gap, e.g. the 2025 lapse in
 *  appropriations) — such rows are simply absent from the array, never coerced to 0. */
function parseSeriesPoints(rawData: unknown): BlsSeriesPoint[] {
  if (!Array.isArray(rawData)) return [];
  const points: BlsSeriesPoint[] = [];
  for (const row of rawData) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const year = Number(r.year);
    const period = typeof r.period === "string" ? r.period : "";
    const monthMatch = /^M(0[1-9]|1[0-2])$/.exec(period);
    if (!Number.isFinite(year) || !monthMatch) continue;
    const value = Number(r.value);
    if (!Number.isFinite(value)) continue;
    points.push({ year, month: Number(monthMatch[1]), value });
  }
  points.sort((a, b) => monthKey(a) - monthKey(b));
  return points;
}

/**
 * Pure parse of a raw BLS v2 timeseries response into `{ seriesID: points[] }`. Returns `{}` (no
 * series) for anything that isn't a well-formed, successful response — a malformed body (live-
 * observed: `status: "REQUEST_FAILED"`, `Results: null`), a non-2xx-shaped payload, or a response
 * missing the `Results.series` array. Never throws.
 */
export function parseBlsTimeseriesResponse(json: unknown): Record<string, BlsSeriesPoint[]> {
  const out: Record<string, BlsSeriesPoint[]> = {};
  if (!json || typeof json !== "object") return out;
  const obj = json as Record<string, unknown>;
  if (obj.status !== "REQUEST_SUCCEEDED") return out;
  const results = obj.Results;
  if (!results || typeof results !== "object") return out;
  const seriesArr = (results as Record<string, unknown>).series;
  if (!Array.isArray(seriesArr)) return out;
  for (const s of seriesArr) {
    if (!s || typeof s !== "object") continue;
    const sid = (s as Record<string, unknown>).seriesID;
    if (typeof sid !== "string") continue;
    out[sid] = parseSeriesPoints((s as Record<string, unknown>).data);
  }
  return out;
}

/** Trailing 12-month % change off the latest point, matched to the point exactly 12 calendar months
 *  earlier by (year, month) key — NOT `points[length - 13]`, so a gap (a dropped/unavailable month,
 *  e.g. the 2025 lapse in appropriations) can never silently shift which two rows get compared. */
function yoyPctChange(points: BlsSeriesPoint[]): { value: number; year: number; month: number } | undefined {
  if (points.length === 0) return undefined;
  const latest = points[points.length - 1];
  const targetKey = monthKey(latest) - 12;
  const prior = points.find((p) => monthKey(p) === targetKey);
  if (!prior || prior.value === 0) return undefined;
  const pct = ((latest.value - prior.value) / prior.value) * 100;
  return Number.isFinite(pct) ? { value: pct, year: latest.year, month: latest.month } : undefined;
}

/** Month-over-month level change off the latest point, matched to the point exactly 1 calendar month
 *  earlier — same exact-key-match reasoning as `yoyPctChange` (never diff across a gap and call it
 *  "MoM"). */
function momChange(points: BlsSeriesPoint[]): { value: number; year: number; month: number } | undefined {
  if (points.length < 2) return undefined;
  const latest = points[points.length - 1];
  const targetKey = monthKey(latest) - 1;
  const prior = points.find((p) => monthKey(p) === targetKey);
  if (!prior) return undefined;
  const diff = latest.value - prior.value;
  return Number.isFinite(diff) ? { value: diff, year: latest.year, month: latest.month } : undefined;
}

/**
 * Pure derivation of the public `BlsMacroSeries` shape from parsed per-series points. Returns `null`
 * only when NOTHING resolved across all three series (matches the keyless-VIX-fallback convention of
 * "nothing live -> null", not a placeholder object of empty strings). A partial result (e.g.
 * unemployment resolved but CPI didn't have a matching prior-year row yet) still returns an object
 * with just the fields that resolved.
 */
export function deriveBlsMacroSeries(seriesRows: Record<string, BlsSeriesPoint[]>): BlsMacroSeries | null {
  const cpi = yoyPctChange(seriesRows[SERIES_CPI_U] ?? []);
  const unemploymentPoints = seriesRows[SERIES_UNEMPLOYMENT] ?? [];
  const latestUnemployment = unemploymentPoints.length > 0 ? unemploymentPoints[unemploymentPoints.length - 1] : undefined;
  const payrolls = momChange(seriesRows[SERIES_PAYROLLS] ?? []);

  const out: BlsMacroSeries = {};
  const candidates: Array<{ year: number; month: number }> = [];

  if (cpi) {
    out.cpiInflation = `${cpi.value.toFixed(2)}%`;
    candidates.push({ year: cpi.year, month: cpi.month });
  }
  if (latestUnemployment) {
    out.unemploymentRate = `${latestUnemployment.value.toFixed(2)}%`;
    candidates.push({ year: latestUnemployment.year, month: latestUnemployment.month });
  }
  if (payrolls) {
    const rounded = Math.round(payrolls.value);
    out.nonfarmPayrollsChangeK = `${rounded >= 0 ? "+" : ""}${rounded}K`;
    candidates.push({ year: payrolls.year, month: payrolls.month });
  }
  if (candidates.length === 0) return null;

  const latest = candidates.reduce((a, b) => (monthKey(a) >= monthKey(b) ? a : b));
  out.asOf = `${latest.year}-${String(latest.month).padStart(2, "0")}`;
  return out;
}

async function fetchBlsRaw(now: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const endYear = new Date(now).getUTCFullYear();
    // 3 calendar years back-to-current comfortably covers a 12-month YoY lookup and a 1-month MoM
    // lookup even in early January (before this year has any published months yet), and sits well
    // under BOTH tiers' years-per-query cap (10 unregistered / 20 registered).
    const startYear = endYear - 2;
    const apiKey = resolveBlsApiKey();
    const body: Record<string, unknown> = {
      seriesid: [SERIES_CPI_U, SERIES_UNEMPLOYMENT, SERIES_PAYROLLS],
      startyear: String(startYear),
      endyear: String(endYear)
    };
    // Only ever set when a key is actually configured — the keyless tier must issue the exact same
    // request shape minus this one field, never a blank/placeholder registrationkey.
    if (apiKey) body.registrationkey = apiKey;

    const res = await fetch(BLS_TIMESERIES_URL, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface BlsCacheEntry {
  expiresAt: number;
  data: BlsMacroSeries | null;
}
let cacheEntry: BlsCacheEntry | null = null;

// BLS updates each of these series at most monthly, so a 12-24h cache is generous, not overly
// cautious — default sits in the middle of that band. Overridable for ops/testing, never below 0.
const DEFAULT_POSITIVE_TTL_MS = 18 * 60 * 60_000; // 18h
function blsPositiveTtlMs(): number {
  const value = Number(process.env.BLS_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POSITIVE_TTL_MS;
}
// A failed/empty fetch (network hiccup, momentary outage) retries within the half hour instead of
// being pinned behind the full positive TTL — mirrors the quiver-provider negative-cache pattern.
const NEGATIVE_TTL_MS = 30 * 60_000;

/**
 * Latest available BLS macro reading (CPI YoY inflation, unemployment rate, payrolls MoM change).
 * Works with OR without `BLS_API_KEY` — the keyless tier is a real, useful floor. Cached in-process
 * for `blsPositiveTtlMs()` on success or `NEGATIVE_TTL_MS` on failure/empty; never fabricates — a
 * failed or malformed fetch returns `null`, and any single series with no usable rows simply omits
 * its field rather than inventing one.
 */
export async function fetchBlsMacroSeries(now: number = Date.now()): Promise<BlsMacroSeries | null> {
  if (cacheEntry && cacheEntry.expiresAt > now) return cacheEntry.data;

  const raw = await fetchBlsRaw(now);
  const seriesRows = parseBlsTimeseriesResponse(raw);
  const data = deriveBlsMacroSeries(seriesRows);

  cacheEntry = { expiresAt: now + (data ? blsPositiveTtlMs() : NEGATIVE_TTL_MS), data };
  return data;
}

/** Test helper: clear the module-level cache between runs. */
export function clearBlsMacroCacheForTests(): void {
  cacheEntry = null;
}
