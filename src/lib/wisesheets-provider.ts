// Wisesheets enrichment provider — key-gated, dormant-until-configured fundamentals tier.
// Wisesheets ("SEC-sourced fundamentals for AI agents and developers") launched a public REST
// API + MCP server 2026-07-24. Gated ENTIRELY on WISESHEETS_API_KEY (process.env only — no
// per-user credential store; same posture as quiver-provider.ts). Absent key => never
// registered by the cascade => fully dormant, zero calls, zero cost.
//
// ── Live-verified against the ACTUAL API on 2026-08-02 (not training-data memory) ──────────
// Sources fetched directly this session: https://www.wisesheets.io/api/docs (endpoint
// reference + example responses), https://www.wisesheets.io/api (pricing table), and the
// live API itself via curl:
//   curl https://api.wisesheets.io/v1/health/               -> 200 {"status":"ok","db":"ok",...}
//   curl https://api.wisesheets.io/v1/metrics/?q=growth      -> 401 {"error":{"code":"AUTH_MISSING",
//     "message":"Missing API key",...}} with header `www-authenticate: Bearer realm="api"`
// This confirms: base URL `https://api.wisesheets.io/v1/`, auth = a plain Bearer API-key header
// (NOT the OAuth flow the marketing page describes — that OAuth language is for the separate
// `mcp.wisesheets.io` MCP server product, a different integration surface from this REST API).
//
// Free tier (per the live pricing page, cross-checked against the docs page's own /v1/me/
// example — its "pro" plan numbers there, 80,000/mo + 600/min, match the pricing table's Pro
// row exactly, which is good internal-consistency evidence the Free row is current too):
//   5,000 requests/month, 200 requests/minute, 5 years of history, ~10,412 covered US stocks,
//   no credit card required. `GET /v1/me/` reports live quota windows (non-consuming).
//
// Numeric values are serialized as STRINGS in every response (documented precision-preservation
// choice) — every numeric field below is parsed with Number(), never assumed to already be a
// JS number. Response envelope is always `{ "data": [...], "meta": {...} }`.
//
// Endpoints this provider uses (all batchable — comma-joined tickers, up to 25 per GET call
// per the docs' stated per-request cap for prices/live and dividends; financials/ does not
// state an explicit GET cap but is capped at the same 25 here as a conservative default):
//   GET /v1/prices/live?tickers=...&fields=name,price,changesPercentage,volume,yearHigh,
//       yearLow,eps,pe,timestamp
//     -> real observed example row: {"symbol":"AAPL","price":"190.12","change":"1.25",
//        "volume":"1200","timestamp":1710000000,"name":"Apple Inc."} (fields requested there
//        were a subset of the full "Allowed" list: name, price, changesPercentage, change,
//        dayLow, dayHigh, yearHigh, yearLow, marketCap, priceAvg50, priceAvg200, exchange,
//        volume, avgVolume, open, previousClose, eps, pe, earningsAnnouncement,
//        sharesOutstanding, timestamp — `symbol` is always included regardless of `fields`).
//   GET /v1/dividends/?tickers=...&fields=adjDividend&from=YYYY-MM-DD&to=YYYY-MM-DD
//     -> real observed example row: {"symbol":"AAPL","date":"2024-02-09","adjDividend":"0.24",
//        "dividend":"0.24","recordDate":"2024-02-12","paymentDate":"2024-02-15"}. Docs say a
//        ticker with no dividend rows (a non-payer) appears in `meta.missingSymbols` rather
//        than erroring — a real, computed 0% yield, not a fabricated one.
//   GET /v1/financials/?tickers=...&metrics=revenue,gross_margin&period=last5y&frequency=annual
//        &include=none
//     -> real observed example row: {"cik":"0000320193","ticker":"AAPL",
//        "companyName":"Apple Inc.","metric":"revenue","periodEnd":"2025-09-27",
//        "fiscalYear":2025,"fiscalPeriod":"FY","value":"416161000000","unit":"USD",
//        "source":{...}}. "revenue", "net_income", and "gross_margin" are the only metric KEYS
//        the docs literally demonstrate — the full metric catalog is only discoverable via the
//        authenticated `GET /v1/metrics/` endpoint, which this session could not call without
//        provisioning a key (forbidden by fleet policy; see integrationNotes in the handoff).
//        `period=last5y` + `frequency=annual` is a verified literal example from the docs (not
//        guessed) — used here so two annual `revenue` rows can be diffed into a real YoY
//        revenueGrowth instead of guessing an unverified `revenue_growth` metric key.
//
// Deliberately NOT implemented: debtToEquity and returnOnEquity. Every SymbolEnrichment field
// this provider fills is backed by a metric/field name the docs page or a live curl literally
// showed. Wisesheets' own docs are explicit that "/v1/metrics/ is the authoritative list of
// every metric key the API understands" and that catalog is gated behind a real key — this
// session had no way to confirm exact keys like `debt_to_equity` / `return_on_equity` without
// guessing, which the task instructions forbid. See integrationNotes for the concrete next step.
//
// Cache: plain in-process Map, TTL floor mirrors quiver-provider.ts's posture (fundamentals and
// the free tier's own monthly-quota scarcity both argue for a long positive TTL; a short
// negative TTL lets a transient outage retry the same day instead of waiting out the floor).
// Never throws out of enrich() — every sub-fetch is independently caught; a partial failure
// still returns whatever succeeded.

import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { fetchWithRetry } from "./data-providers";
import { normalizeSymbol } from "./money";

const WISESHEETS_BASE_URL = "https://api.wisesheets.io/v1";

// Hard per-request ticker cap Wisesheets documents for the GET variants of /prices/live and
// /dividends/ (25). Not env-overridable — raising it would just get truncated/rejected upstream.
const BATCH_SIZE = 25;

// How many symbol groups of BATCH_SIZE to fetch concurrently. Each group issues 3 parallel HTTP
// calls, so 2 groups = 6 concurrent requests — comfortably inside the free tier's 200 req/min.
const GROUP_CONCURRENCY = 2;

// Floor at 24h — fundamentals/dividends/quote-adjacent fields here don't move fast enough to
// justify a shorter cache, and this tier also sits behind faster real-time sources in the
// intended cascade order, so staleness of its OWN copy rarely matters. A misconfigured low
// override would otherwise burn the scarce 5,000/month free-tier budget needlessly.
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
function wisesheetsTtlMs(): number {
  const value = Number(process.env.WISESHEETS_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= DEFAULT_TTL_MS ? value : DEFAULT_TTL_MS;
}

// Short negative/partial-result TTL so a transient outage retries the same day instead of
// sitting behind the 24h positive floor.
const DEFAULT_NEGATIVE_TTL_MS = 6 * 60 * 60_000;
function wisesheetsNegativeTtlMs(): number {
  const value = Number(process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NEGATIVE_TTL_MS;
}

// Default overall symbol cap per enrich() call. Deliberately conservative given the free tier's
// 5,000/month ceiling — 25 symbols costs exactly 3 requests (one batch, one call per endpoint).
// Unclamped override, like quiver-provider.ts's MAX_SYMBOLS knob — an operator raising it is an
// explicit decision.
const DEFAULT_MAX_SYMBOLS = 25;
function wisesheetsMaxSymbols(): number {
  const value = Number(process.env.WISESHEETS_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

/** The sole registration gate: trimmed WISESHEETS_API_KEY, or undefined when unset/blank. */
export function resolveWisesheetsApiKey(): string | undefined {
  const key = (process.env.WISESHEETS_API_KEY ?? "").trim();
  return key || undefined;
}

interface WisesheetsRow {
  [key: string]: unknown;
}

/** Wisesheets always answers `{ "data": [...], "meta": {...} }` — tolerate anything else
 *  defensively (malformed/empty body) rather than throwing. */
export function extractWisesheetsRows(payload: unknown): WisesheetsRow[] {
  if (payload && typeof payload === "object") {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data.filter((r): r is WisesheetsRow => !!r && typeof r === "object");
  }
  return [];
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** Mirrors data-providers.ts's own normalizePercent (not exported from there): treats a
 *  fraction (|x| <= 1) as needing *100, an already-scaled percent as-is. Sign preserved. */
function normalizePercent(value: number): number {
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.round(pct * 100) / 100;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GET /v1/prices/live rows -> per-symbol SymbolEnrichment slice.
 *  Verified field names: symbol, name, price, changesPercentage, volume, yearHigh, yearLow,
 *  eps, pe, timestamp (Unix epoch seconds). All numeric quote values arrive as strings. */
export function parseLiveQuotes(rows: WisesheetsRow[]): Record<string, SymbolEnrichment> {
  const result: Record<string, SymbolEnrichment> = {};
  for (const row of rows) {
    const symbol = str(row.symbol);
    if (!symbol) continue;
    const price = num(row.price);
    const pe = num(row.pe);
    const eps = num(row.eps);
    const volume = num(row.volume);
    const yearHigh = num(row.yearHigh);
    const yearLow = num(row.yearLow);
    const changePct = num(row.changesPercentage);
    const name = str(row.name);
    const timestamp = num(row.timestamp);

    result[symbol.toUpperCase()] = {
      ...(price !== undefined && price > 0 && { price }),
      ...(pe !== undefined && pe > 0 && { peRatio: pe }),
      ...(eps !== undefined && { eps }),
      ...(volume !== undefined && volume > 0 && { volume }),
      ...(yearHigh !== undefined && yearHigh > 0 && { fiftyTwoWeekHigh: yearHigh }),
      ...(yearLow !== undefined && yearLow > 0 && { fiftyTwoWeekLow: yearLow }),
      ...(changePct !== undefined && { intradayChangePct: Math.round(changePct * 100) / 100 }),
      ...(name !== undefined && { companyName: name }),
      ...(timestamp !== undefined && Number.isFinite(timestamp) && { asOf: new Date(timestamp * 1000).toISOString() })
    };
  }
  return result;
}

/** GET /v1/dividends/ rows -> trailing-12-month adjDividend sum per symbol, divided by the
 *  symbol's known price. `symbols` is the full requested batch (not just rows-having ones) so a
 *  confirmed non-payer (present in the batch, absent from `rows`) correctly yields 0%, never
 *  `undefined` — the docs describe that case explicitly ("missingSymbols ... such as
 *  non-payers"), so a real, computed zero is legitimate data, not a fabrication. Omits a symbol
 *  entirely when its price is unknown (can't turn a $ sum into a % without one). */
export function computeDividendYields(
  rows: WisesheetsRow[],
  symbols: string[],
  priceBySymbol: Record<string, number | undefined>
): Record<string, number> {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const symbol = str(row.symbol);
    if (!symbol) continue;
    const amount = num(row.adjDividend) ?? num(row.dividend);
    if (amount === undefined) continue;
    const key = symbol.toUpperCase();
    sums.set(key, (sums.get(key) ?? 0) + amount);
  }
  const result: Record<string, number> = {};
  for (const symbol of symbols) {
    const price = priceBySymbol[symbol];
    if (price === undefined || price <= 0) continue;
    const sum = sums.get(symbol) ?? 0;
    result[symbol] = Math.round((sum / price) * 10000) / 100;
  }
  return result;
}

function periodSortKey(row: WisesheetsRow): string {
  const fiscalYear = num(row.fiscalYear);
  const periodEnd = str(row.periodEnd) ?? "";
  // Zero-padded fiscal year prefix so numeric ordering matches lexical ordering; periodEnd as
  // tie-break/fallback when fiscalYear is missing.
  return `${fiscalYear !== undefined ? String(fiscalYear).padStart(6, "0") : "000000"}:${periodEnd}`;
}

/** GET /v1/financials/?metrics=revenue,gross_margin rows -> per-symbol grossProfitMargin
 *  (latest annual period) + revenueGrowth (YoY diff of the two most recent annual `revenue`
 *  rows this session could verify are real metric keys the docs demonstrate). Verified fields:
 *  ticker, metric, periodEnd, fiscalYear, value (string). */
export function parseFinancialsBySymbol(rows: WisesheetsRow[]): Record<string, SymbolEnrichment> {
  const bySymbol = new Map<string, WisesheetsRow[]>();
  for (const row of rows) {
    const ticker = str(row.ticker);
    if (!ticker) continue;
    const key = ticker.toUpperCase();
    const bucket = bySymbol.get(key);
    if (bucket) bucket.push(row);
    else bySymbol.set(key, [row]);
  }

  const result: Record<string, SymbolEnrichment> = {};
  for (const [symbol, symbolRows] of bySymbol) {
    const data: SymbolEnrichment = {};

    const marginRows = symbolRows
      .filter((r) => str(r.metric) === "gross_margin")
      .sort((a, b) => periodSortKey(b).localeCompare(periodSortKey(a)));
    const marginValue = marginRows.length > 0 ? num(marginRows[0].value) : undefined;
    if (marginValue !== undefined) data.grossProfitMargin = normalizePercent(marginValue);

    const revenueRows = symbolRows
      .filter((r) => str(r.metric) === "revenue")
      .sort((a, b) => periodSortKey(b).localeCompare(periodSortKey(a)));
    if (revenueRows.length >= 2) {
      const latest = num(revenueRows[0].value);
      const prior = num(revenueRows[1].value);
      if (latest !== undefined && prior !== undefined && prior !== 0) {
        data.revenueGrowth = Math.round(((latest - prior) / Math.abs(prior)) * 10000) / 100;
      }
    }

    if (Object.keys(data).length > 0) result[symbol] = data;
  }
  return result;
}

const wisesheetsCache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

/** Test helper: clear the Wisesheets cache between runs. */
export function clearWisesheetsCache(): void {
  wisesheetsCache.clear();
}

export class WisesheetsEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "wisesheets";
  readonly configured = true;
  readonly costTier = "free" as const;
  // 5,000 req/month on the free tier is a real, easily-exhausted budget compared to most other
  // free tiers in this cascade — treat it like the RapidAPI failover tiers (quotaScarce = true)
  // so the free-first planner only spends it on symbols still missing these fields, rather than
  // re-fetching fields a faster/unlimited source already filled.
  readonly quotaScarce = true;
  readonly suppliesFields = [
    "price",
    "peRatio",
    "eps",
    "companyName",
    "volume",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "intradayChangePct",
    "asOf",
    "dividendYield",
    "revenueGrowth",
    "grossProfitMargin"
  ] as const;

  constructor(private readonly apiKey: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, wisesheetsMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;

    const now = Date.now();
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = wisesheetsCache.get(symbol);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const groups: string[][] = [];
    for (let i = 0; i < misses.length; i += BATCH_SIZE) groups.push(misses.slice(i, i + BATCH_SIZE));

    for (let i = 0; i < groups.length; i += GROUP_CONCURRENCY) {
      const chunk = groups.slice(i, i + GROUP_CONCURRENCY);
      await Promise.all(chunk.map((group) => this.fetchGroup(group, now, result)));
    }

    return result;
  }

  private async fetchGroup(batch: string[], now: number, result: Record<string, SymbolEnrichment>): Promise<void> {
    try {
      const tickers = encodeURIComponent(batch.join(","));
      const to = isoDate(new Date(now));
      const from = isoDate(new Date(now - 366 * 24 * 60 * 60_000));

      const settled = await Promise.allSettled([
        this.getJson(
          `${WISESHEETS_BASE_URL}/prices/live?tickers=${tickers}&fields=name,price,changesPercentage,volume,yearHigh,yearLow,eps,pe,timestamp`
        ),
        this.getJson(`${WISESHEETS_BASE_URL}/dividends/?tickers=${tickers}&fields=adjDividend&from=${from}&to=${to}`),
        this.getJson(
          `${WISESHEETS_BASE_URL}/financials/?tickers=${tickers}&metrics=revenue,gross_margin&period=last5y&frequency=annual&include=none`
        )
      ]);

      const [liveSettled, divSettled, finSettled] = settled;

      const liveBySymbol =
        liveSettled.status === "fulfilled" ? parseLiveQuotes(extractWisesheetsRows(liveSettled.value)) : {};
      const finBySymbol =
        finSettled.status === "fulfilled" ? parseFinancialsBySymbol(extractWisesheetsRows(finSettled.value)) : {};

      const allOk = liveSettled.status === "fulfilled" && divSettled.status === "fulfilled" && finSettled.status === "fulfilled";

      let dividendYields: Record<string, number> = {};
      if (divSettled.status === "fulfilled") {
        const priceBySymbol: Record<string, number | undefined> = {};
        for (const symbol of batch) priceBySymbol[symbol] = liveBySymbol[symbol]?.price;
        dividendYields = computeDividendYields(extractWisesheetsRows(divSettled.value), batch, priceBySymbol);
      }

      for (const symbol of batch) {
        const data: SymbolEnrichment = { ...liveBySymbol[symbol], ...finBySymbol[symbol] };
        const dy = dividendYields[symbol];
        if (dy !== undefined) data.dividendYield = dy;

        wisesheetsCache.set(symbol, { expiresAt: now + (allOk ? wisesheetsTtlMs() : wisesheetsNegativeTtlMs()), data });
        result[symbol] = data;
      }
    } catch {
      // Defensive: should be unreachable (every await above is inside Promise.allSettled), but
      // enrich() must NEVER throw regardless — fail open with whatever the batch already has.
      for (const symbol of batch) if (!(symbol in result)) result[symbol] = {};
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await fetchWithRetry(
      url,
      { cache: "no-store", headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } },
      {
        service: "wisesheets",
        keySource: "env",
        // An unrecognized/out-of-universe ticker set can legitimately 404 rather than return an
        // empty `data` array — treat that as "no data", not a lane failure.
        suppressHealthStatuses: [404]
      }
    );
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
}
