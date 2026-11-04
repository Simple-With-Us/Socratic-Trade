// SimFin enrichment provider — key-gated, dormant-until-configured SECOND-OPINION fundamentals
// tier. Gated ENTIRELY on SIMFIN_API_KEY (process.env only — no per-user credential store, same
// posture as quiver-provider.ts / wisesheets-provider.ts). Absent key => never registered by the
// cascade => fully dormant, zero calls, zero cost.
//
// ── Live-verified against the ACTUAL API on 2026-08-02 (not training-data memory) ──────────────
// Sources fetched directly this session:
//   - https://simfin.com/en/prices/ (pricing page) — FREE tier: "500 credits" (see CORRECTION
//     below), "2 requests per second", "5,000 US Stocks", "5 Years Fundamentals History", no
//     card required. Also quotes the ToS line "you only can use the data as long you hold a
//     valid subscription" / "delete all downloaded data ... and clean-up backups" on lapse — see
//     the ToS/retention note further down.
//   - https://simfin.readme.io/reference/getting-started-1 and its llms.txt index (the current
//     v3 API docs host; simfin.com/api/v3/documentation/ — the prior research doc's URL — now
//     404s, the docs moved to readme.io) and the specific endpoint pages:
//     https://simfin.readme.io/reference/rate-limits.md,
//     https://simfin.readme.io/reference/general-1.md,
//     https://simfin.readme.io/reference/statements-1.md.
//   - `curl -i https://backend.simfin.com/api/v3/companies/general/compact?ticker=AAPL` (no key)
//     -> HTTP 401 `{"error":"Full authentication is required to access this resource"}`. This
//     confirms the base host/path are live and real (not a stale/renamed endpoint) without
//     needing a key — creating one is against fleet policy (see FLEET-PROTOCOL.md "NEVER create a
//     new provider API key").
//   - The official `SimFin/simfin` Python client on GitHub (raw.githubusercontent.com), whose
//     `simfin/names.py` is "auto-generated from the SimFin database" per its own header comment
//     — i.e. it enumerates the REAL underlying column names this API returns, which is how every
//     field name referenced below (Company Name, Sector, Industry, Fiscal Year, Revenue, Gross
//     Profit, Net Income, Total Assets, Total Equity, Short Term Debt, Long Term Debt) was
//     confirmed. `simfin/names_extra.py` (client-side CONVENIENCE aliases, explicitly NOT part of
//     the auto-generated real-column list) supplied the "Total Debt = short term debt + long term
//     debt" formula this file mirrors for debtToEquity — but its ROE/ROA/margin definitions match
//     standard formulas anyway, so this file computes those directly from raw statement fields
//     rather than trusting an unverifiable pre-computed "derived" endpoint field name.
//
// CORRECTION to the prior research pass (docs/market-data-free-tier-research-2026-08-02.md item
// 7, "500 credits/mo, 5k US stocks, 5y fundamentals"): the "500 credits" figure is NOT the web
// API's rate limit — it is a SEPARATE in-app feature ("high-speed backtesting access") described
// on the same pricing page. The web API's actual free-tier throughput cap (confirmed on the
// dedicated rate-limits doc) is "2 requests/second" for general endpoints (companies/statements/
// shares/prices) and "8 requests/day" for the filings-retrieval endpoints specifically (not used
// by this provider). No monthly total-request ceiling is documented for the API itself. The
// "5,000 US Stocks" / "5 Years Fundamentals History" coverage claims WERE confirmed accurate.
//
// ToS / data-retention note (confirmed live, 2026-08-02): SimFin's terms require deleting
// downloaded data if the subscription lapses ("you only can use the data as long you hold a
// valid subscription", "delete all downloaded data from your devices and clean-up backups").
// This codebase does not persist enrichment-provider payloads to any database — the only
// retention here is the in-process `simFinCache` Map below, which lives only for the process's
// lifetime (cleared on restart, never written to disk) — so today's usage is already compliant
// with that ToS clause. If a future change ever persists SimFin output durably (e.g. a database
// table), that change must also implement delete-on-lapse; it does not need to today.
//
// Auth: `Authorization: api-key <KEY>` header (a custom scheme name, NOT "Bearer") — confirmed
// against the general-1 endpoint doc's example (`api-key ovBimDZTPrKdG9Yx58GjQf2A`, a docs
// placeholder, not a real credential). Base URL `https://backend.simfin.com/api/v3` per the same
// docs and confirmed live via the unauthenticated curl above.
//
// Endpoints used (all "compact" format — a `{columns: string[], data: array}` table per the docs'
// schema and the same shape demonstrated by SimFin's own v2 Python example script, which reads
// `response.json()[0]['columns']` / `['data']` and zips them into rows). The EXACT per-ticker
// response envelope (e.g. whether it's one object per ticker at the top level, or tables nested
// one level deeper per statement type) could not be observed without a live key, so
// `extractSimFinRows` below walks the whole payload looking for that columns/data shape at any
// depth instead of assuming one specific nesting — see its own comment.
//   - GET /companies/general/compact?ticker=X            -> Company Name / Sector / Industry
//   - GET /companies/statements/compact?ticker=X&statements=PL&period=FY -> annual Revenue /
//     Gross Profit / Net Income across however many fiscal years the free tier returns (used for
//     margins AND a YoY revenue-growth diff)
//   - GET /companies/statements/compact?ticker=X&statements=BS&period=FY -> annual Total Assets /
//     Total Equity / Short Term Debt / Long Term Debt (latest fiscal year only)
//
// Deliberately ANNUAL (period=FY), not the documented `ttm` boolean: whether `ttm=true` produces
// a genuinely trailing-twelve-month figure for point-in-time balance-sheet concepts (vs. only
// flow concepts like Net Income) could not be verified live. This codebase already has a
// precedent for exactly this annual-only tradeoff: `SecXbrlEnrichmentProvider`/`parseCompanyFacts`
// (src/lib/data-providers.ts) computes `revenueGrowth` from full-fiscal-year 10-K figures only,
// reasoning that "one fiscal year's growth is a reasonable free stand-in for the TTM figure a
// paid provider would supply." This file mirrors that same annual-only reasoning for every ratio
// field, and for the SAME reason does NOT populate `eps` — SymbolEnrichment.eps is documented as
// trailing-twelve-months, an annual EPS would be stale for most of the year, and this provider
// sits behind faster/keyless sources in the cascade, so publishing a stale value risks nothing
// but also helps nothing; omitting it is strictly safer. `pbRatio`, `peRatio`, `dividendYield`,
// `beta`, and the analyst-target fields are also NOT populated — all require live share-price
// data (a `/companies/prices/compact` call this provider does not make), and price fields are
// already covered earlier in the cascade by faster/keyless sources.
//
// Units match this codebase's existing conventions for these SAME fields elsewhere in the cascade
// (verified against `FmpEnrichmentProvider`'s own `percent()` helper and
// `SecXbrlEnrichmentProvider`'s debtToEquity comment, both in src/lib/data-providers.ts):
//   - grossProfitMargin / returnOnEquity / returnOnAssets / revenueGrowth: PERCENTAGE POINTS
//     (e.g. 12.34 means 12.34%), not a 0-1 fraction.
//   - debtToEquity: a RAW ratio (e.g. 1.5), never multiplied by 100 — matches SEC-XBRL's explicit
//     "must NOT be capped or pre-normalized" contract for this field.
//   debtToEquity = (Short Term Debt + Long Term Debt) / Total Equity — this exact formula is
//   SimFin's OWN documented definition of "Total Debt" (see `TOTAL_DEBT` in the Python client's
//   names_extra.py: "Total debt: short term debt + long term debt").
//
// Never throws out of enrich(): the three sub-fetches per symbol (general info, PL statement, BS
// statement) are each caught independently via Promise.allSettled — a failure in any one still
// lets the others' fields through, and a total outage for a symbol yields `{}`, never a
// fabricated value.

import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { fetchWithRetry } from "./data-providers";
import { normalizeSymbol } from "./money";

const SIMFIN_BASE_URL = "https://backend.simfin.com/api/v3";

// This is slow-moving, quarterly/annual-filing-cadence data — floor the cache at 24h regardless
// of override, mirroring quiver-provider.ts's reasoning (a misconfigured low override would burn
// the free tier's "2 requests/second" throughput needlessly on unchanged fundamentals).
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
function simFinTtlMs(): number {
  const value = Number(process.env.SIMFIN_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= DEFAULT_TTL_MS ? value : DEFAULT_TTL_MS;
}

// Shorter negative/partial-result TTL so a transient outage or a single-endpoint failure retries
// the same day instead of sitting behind the 24h positive floor.
const DEFAULT_NEGATIVE_TTL_MS = 6 * 60 * 60_000;
function simFinNegativeTtlMs(): number {
  const value = Number(process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NEGATIVE_TTL_MS;
}

// Each symbol costs 3 sub-fetches here against a "2 requests/second" free-tier throughput cap —
// keep the default batch conservative (mirrors quiver-provider.ts's DEFAULT_MAX_SYMBOLS
// reasoning). The env override is unclamped — an operator raising it is an explicit decision.
const DEFAULT_MAX_SYMBOLS = 20;
function simFinMaxSymbols(): number {
  const value = Number(process.env.SIMFIN_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

// Low concurrency to respect the free tier's documented "2 requests/second" cap even with 3
// sub-fetches per symbol in flight.
const CONCURRENCY = 2;

/** The sole registration gate: trimmed SIMFIN_API_KEY, or undefined when unset/blank. */
export function resolveSimFinApiKey(): string | undefined {
  const key = (process.env.SIMFIN_API_KEY ?? "").trim();
  return key || undefined;
}

export type SimFinRow = Record<string, unknown>;

interface SimFinTable {
  columns: string[];
  data: unknown[];
}

/**
 * SimFin's "compact" format nests one or more `{columns: string[], data: array}` tables
 * somewhere in the response envelope. The exact per-ticker wrapper shape (one object per
 * requested ticker at the top level? tables nested one level deeper per statement type?) could
 * not be observed without a live key, so this walks the ENTIRE payload looking for that
 * columns/data shape at any depth and flattens every row it finds into a keyed record via
 * `columns` — correct regardless of how the tables end up nested. A `data` row that is already a
 * keyed object (not a positional array) is tolerated too, defensively. Malformed/empty input
 * (null, `{}`, a table with no rows, non-string columns) yields `[]`, never a fabricated row.
 */
export function extractSimFinRows(payload: unknown): SimFinRow[] {
  const tables: SimFinTable[] = [];

  function walk(node: unknown, depth: number): void {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const columns = obj.columns;
    const data = obj.data;
    if (Array.isArray(columns) && columns.length > 0 && columns.every((c) => typeof c === "string") && Array.isArray(data)) {
      tables.push({ columns: columns as string[], data });
      // Still walk sibling keys defensively (some shapes could nest another table alongside this
      // one), just skip re-walking columns/data themselves.
      for (const [key, value] of Object.entries(obj)) {
        if (key === "columns" || key === "data") continue;
        walk(value, depth + 1);
      }
      return;
    }
    for (const value of Object.values(obj)) walk(value, depth + 1);
  }

  walk(payload, 0);

  const rows: SimFinRow[] = [];
  for (const table of tables) {
    for (const raw of table.data) {
      if (Array.isArray(raw)) {
        const row: SimFinRow = {};
        table.columns.forEach((col, i) => {
          row[col] = raw[i];
        });
        rows.push(row);
      } else if (raw && typeof raw === "object") {
        rows.push(raw as SimFinRow);
      }
    }
  }
  return rows;
}

function num(row: SimFinRow, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function str(row: SimFinRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Confirmed-live literal column names (see the file header) plus a couple of tolerant casing
// fallbacks, mirroring quiver-provider.ts's firstStr/firstNum candidate-list style.
const FISCAL_YEAR_KEYS = ["Fiscal Year", "FiscalYear", "fiscalYear"];
const REVENUE_KEYS = ["Revenue"];
const GROSS_PROFIT_KEYS = ["Gross Profit"];
const NET_INCOME_KEYS = ["Net Income"];
const TOTAL_ASSETS_KEYS = ["Total Assets"];
const TOTAL_EQUITY_KEYS = ["Total Equity"];
const ST_DEBT_KEYS = ["Short Term Debt"];
const LT_DEBT_KEYS = ["Long Term Debt"];
const COMPANY_NAME_KEYS = ["Company Name"];
const SECTOR_KEYS = ["Sector"];
const INDUSTRY_KEYS = ["Industry"];

/** company info from the `general/compact` response — expects a single row (SimFin returns one
 *  company-info row per requested ticker; this provider requests one ticker at a time). */
export function parseGeneralInfo(rows: SimFinRow[]): Pick<SymbolEnrichment, "companyName" | "sector" | "industry"> {
  const row = rows[0];
  const out: Pick<SymbolEnrichment, "companyName" | "sector" | "industry"> = {};
  if (!row) return out;
  const companyName = str(row, COMPANY_NAME_KEYS);
  const sector = str(row, SECTOR_KEYS);
  const industry = str(row, INDUSTRY_KEYS);
  if (companyName !== undefined) out.companyName = companyName;
  if (sector !== undefined) out.sector = sector;
  if (industry !== undefined) out.industry = industry;
  return out;
}

function latestByFiscalYear(rows: SimFinRow[]): SimFinRow | undefined {
  let best: SimFinRow | undefined;
  let bestYear = -Infinity;
  for (const row of rows) {
    const year = num(row, FISCAL_YEAR_KEYS);
    if (year === undefined) continue;
    if (year > bestYear) {
      bestYear = year;
      best = row;
    }
  }
  return best;
}

/** The most recent fiscal year strictly BEFORE `year`, for a YoY comparison. */
function priorFiscalYearRow(rows: SimFinRow[], year: number): SimFinRow | undefined {
  let best: SimFinRow | undefined;
  let bestYear = -Infinity;
  for (const row of rows) {
    const y = num(row, FISCAL_YEAR_KEYS);
    if (y === undefined || y >= year) continue;
    if (y > bestYear) {
      bestYear = y;
      best = row;
    }
  }
  return best;
}

/**
 * Computes the ratio fields from annual (period=FY) PL and BS rows. Each field is independently
 * guarded (undefined numerator/denominator, zero/negative denominator) and simply omitted rather
 * than fabricated — a company with negative equity, for example, yields no returnOnEquity or
 * debtToEquity rather than a nonsensical or misleading number.
 */
export function computeSimFinRatios(plRows: SimFinRow[], bsRows: SimFinRow[]): SymbolEnrichment {
  const out: SymbolEnrichment = {};

  // Gross margin and YoY revenue growth are pure income-statement figures — anchor on the PL
  // statement's own latest fiscal year.
  const latestPl = latestByFiscalYear(plRows);
  if (latestPl) {
    const revenue = num(latestPl, REVENUE_KEYS);
    const grossProfit = num(latestPl, GROSS_PROFIT_KEYS);
    if (revenue !== undefined && revenue > 0 && grossProfit !== undefined) {
      out.grossProfitMargin = round2((grossProfit / revenue) * 100);
    }

    const plYear = num(latestPl, FISCAL_YEAR_KEYS);
    if (revenue !== undefined && revenue > 0 && plYear !== undefined) {
      const prior = priorFiscalYearRow(plRows, plYear);
      const priorRevenue = prior ? num(prior, REVENUE_KEYS) : undefined;
      if (priorRevenue !== undefined && priorRevenue > 0) {
        out.revenueGrowth = round2(((revenue - priorRevenue) / priorRevenue) * 100);
      }
    }
  }

  // ROE / ROA / debtToEquity are balance-sheet-anchored (mirrors SecXbrlEnrichmentProvider's own
  // "anchor on the equity period" convention in data-providers.ts): find the latest BS fiscal
  // year, then pull that SAME year's Net Income from the PL rows (falling back to PL's own latest
  // year when no exact match exists — both statement fetches share the same ticker/period=FY
  // request and should normally line up on identical fiscal years).
  const latestBs = latestByFiscalYear(bsRows);
  if (latestBs) {
    const bsYear = num(latestBs, FISCAL_YEAR_KEYS);
    const netIncomeRow = (bsYear !== undefined && plRows.find((r) => num(r, FISCAL_YEAR_KEYS) === bsYear)) || latestPl;
    const netIncome = netIncomeRow ? num(netIncomeRow, NET_INCOME_KEYS) : undefined;
    const totalEquity = num(latestBs, TOTAL_EQUITY_KEYS);
    const totalAssets = num(latestBs, TOTAL_ASSETS_KEYS);

    if (netIncome !== undefined && totalEquity !== undefined && totalEquity > 0) {
      out.returnOnEquity = round2((netIncome / totalEquity) * 100);
    }
    if (netIncome !== undefined && totalAssets !== undefined && totalAssets > 0) {
      out.returnOnAssets = round2((netIncome / totalAssets) * 100);
    }

    if (totalEquity !== undefined && totalEquity > 0) {
      const stDebt = num(latestBs, ST_DEBT_KEYS);
      const ltDebt = num(latestBs, LT_DEBT_KEYS);
      // Omit entirely when NEITHER debt concept is present (statement type didn't carry them) —
      // never assume zero debt from an absent column. When at least one is present, a missing
      // sibling contributes 0 (a company can genuinely carry only one of the two).
      if (stDebt !== undefined || ltDebt !== undefined) {
        const totalDebt = (stDebt ?? 0) + (ltDebt ?? 0);
        out.debtToEquity = round2(totalDebt / totalEquity);
      }
    }
  }

  return out;
}

const simFinCache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

/** Test helper: clear the long-TTL SimFin cache between runs. */
export function clearSimFinCache(): void {
  simFinCache.clear();
}

export class SimFinEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "simfin";
  readonly configured = true;
  // SimFin's FREE tier ($0, no card) is what this provider targets — see the file header.
  readonly costTier = "free" as const;
  // Wave-gate like Wisesheets: 3 endpoints/symbol/scan is wasteful when Yahoo/Roic already
  // filled these fields (first-wins would discard most of the computed ratios anyway).
  readonly quotaScarce = true;
  readonly suppliesFields = [
    "grossProfitMargin",
    "revenueGrowth",
    "returnOnEquity",
    "returnOnAssets",
    "debtToEquity",
    "companyName",
    "sector",
    "industry"
  ] as const;

  constructor(private readonly apiKey: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, simFinMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;

    const now = Date.now();
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = simFinCache.get(symbol);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const settled = await Promise.allSettled([
            this.getRows("companies/general/compact", symbol, {}),
            this.getRows("companies/statements/compact", symbol, { statements: "PL", period: "FY" }),
            this.getRows("companies/statements/compact", symbol, { statements: "BS", period: "FY" })
          ]);
          const [generalR, plR, bsR] = settled;

          const data: SymbolEnrichment = {};
          let allOk = true;

          if (generalR.status === "fulfilled") Object.assign(data, parseGeneralInfo(generalR.value));
          else allOk = false;

          const plRows = plR.status === "fulfilled" ? plR.value : [];
          const bsRows = bsR.status === "fulfilled" ? bsR.value : [];
          if (plR.status !== "fulfilled" || bsR.status !== "fulfilled") allOk = false;
          Object.assign(data, computeSimFinRatios(plRows, bsRows));

          // Fully successful -> cache at the long positive floor. Any partial failure -> cache
          // whatever DID succeed (never lost this cycle) but at the short negative TTL so the
          // failed endpoint(s) are retried the same day instead of waiting out the 24h floor.
          simFinCache.set(symbol, { expiresAt: now + (allOk ? simFinTtlMs() : simFinNegativeTtlMs()), data });
          result[symbol] = data;
        })
      );
    }

    return result;
  }

  private async getRows(path: string, symbol: string, extraParams: Record<string, string>): Promise<SimFinRow[]> {
    const params = new URLSearchParams({ ticker: symbol, ...extraParams });
    const url = `${SIMFIN_BASE_URL}/${path}?${params.toString()}`;
    const response = await fetchWithRetry(
      url,
      { cache: "no-store", headers: { Authorization: `api-key ${this.apiKey}`, Accept: "application/json" } },
      {
        service: "simfin",
        keySource: "env",
        // A ticker SimFin doesn't cover (outside the free tier's ~5,000 US stocks) is a normal
        // "no data" outcome, not a failure — never let it count against the lane's health.
        suppressHealthStatuses: [404]
      }
    );
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractSimFinRows(await response.json());
  }
}
