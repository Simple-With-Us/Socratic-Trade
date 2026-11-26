import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { SP500_SYMBOLS } from "../../src/lib/sp500";
import { NASDAQ100_SYMBOLS, DOW30_SYMBOLS } from "../../src/lib/index-universes";
import { normalizeSymbol } from "../../src/lib/money";
import {
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseSourceReceipt
} from "../../src/lib/rag/universe-manifest";
import {
  buildSecUniverseManifest,
  normalizeManifestTicker,
  type SecMarketDatum,
  type SecTickerRow
} from "../../src/lib/rag/universe-manifest-build";

// Generates the FrozenSecUniverseManifest the SEC ingest seeder reads.
//
// ST-4690 (A4e): the assembly step moved to src/lib/rag/universe-manifest-build.ts, which
// quarantines (never emits) an issuer without a verified exchange or a real quote, backfills
// quarantine drops from the ordered SEC list to the 1,000-issuer contract, and validates with the
// same default expected count the seeder enforces. This script now owns only fetching and file IO.
//
// Market data comes from the Nasdaq delayed screener (the repo's established keyless bulk
// provider: real last sale, volume, market cap, sector and industry for ~7,000 US listings in one
// request). Yahoo Finance's per-symbol quote endpoint stays as a fallback when the screener is
// unavailable. Every emitted figure is a measurement from one of those sources; an issuer with no
// usable quote is quarantined with an honest reason instead of being assigned a placeholder.
// The Nasdaq URL/headers deliberately mirror src/lib/nasdaq-screener-fetch.ts rather than import
// it: that module pulls the proxy/rate-limit stack (withProviderLimit, data-source-fetch) that a
// one-shot operator script neither needs nor should initialize.
//
// This script does not import src/lib/db or src/lib/web-sources/http either. Both are
// `server-only` modules (db.ts throws outside a React Server Component build, and http.ts imports
// db.ts), which is why the old version of this script could not be executed with `tsx` at all —
// the very "live run" A4e asks for was impossible. It reads the local SQLite file directly,
// read-only, and uses the small fetch helper below.

interface FetchedSource {
  receipt: SecUniverseSourceReceipt;
  text: string;
}

const TARGET_ISSUER_COUNT = 1000;

// Mirrors BROWSER_UA / SEC_EDGAR_FALLBACK_UA in src/lib/web-sources/http.ts (that module imports
// db.ts and is server-only, so it cannot be loaded from this script — see the header note).
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEC_USER_AGENT = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Socratic Trade research jay@socratic.trade";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors NASDAQ_SCREENER_URL / NASDAQ_SCREENER_HEADERS in src/lib/nasdaq-screener-fetch.ts.
// `download=true` is what adds volume/sector/industry to the rows (without it the response has
// marketCap only), and the full (limit=8000) payload carries rows under data.table.rows.
const NASDAQ_SCREENER_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0&download=true";
const NASDAQ_SCREENER_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent": BROWSER_UA,
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/"
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Minimal fetch-with-timeout-and-backoff; retries only on 429/5xx and transport errors. */
async function fetchText(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {}
): Promise<string> {
  const { headers, timeoutMs = 30_000, retries = 2 } = options;
  const effectiveHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (url.includes(".sec.gov") && !Object.keys(effectiveHeaders).some((key) => key.toLowerCase() === "user-agent")) {
    effectiveHeaders["user-agent"] = SEC_USER_AGENT;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: effectiveHeaders, cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (!(response.status === 429 || response.status >= 500)) break;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }
    if (attempt < retries) await sleep(600 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

async function fetchSource(name: string, url: string): Promise<FetchedSource> {
  console.log(`  Fetching ${name}: ${url}`);
  const text = await fetchText(url, { timeoutMs: 30_000, retries: 2 });
  return { receipt: { name, asOf: new Date().toISOString(), sha256: sha256(text) }, text };
}

async function fetchSecTickerList(): Promise<{ source: FetchedSource; rows: SecTickerRow[] }> {
  // company_tickers.json preserves SEC's original prominence ordering (loadCikMap converts it to a
  // key-value record where order is lost), so this script fetches it directly.
  const source = await fetchSource("sec-company-tickers", "https://www.sec.gov/files/company_tickers.json");
  const data = JSON.parse(source.text) as Record<string, { cik_str: number; ticker: string; title: string }>;
  return {
    source,
    rows: Object.values(data).map((row) => ({
      cik: String(row.cik_str).padStart(10, "0"),
      ticker: row.ticker,
      title: row.title
    }))
  };
}

async function fetchSecExchangeMap(): Promise<{ source: FetchedSource; cikToExchange: Map<string, string> }> {
  // A separate SEC file (not company_tickers.json) that additionally carries a listing exchange
  // per CIK/ticker — the only honest, already-public source this script can cite for `exchange`.
  const source = await fetchSource("sec-company-tickers-exchange", "https://www.sec.gov/files/company_tickers_exchange.json");
  const data = JSON.parse(source.text) as { fields?: string[]; data?: Array<Array<string | number | null>> };
  const fields = data.fields ?? [];
  const cikIdx = fields.indexOf("cik");
  const exchangeIdx = fields.indexOf("exchange");
  const cikToExchange = new Map<string, string>();
  if (cikIdx >= 0 && exchangeIdx >= 0) {
    for (const row of data.data ?? []) {
      const cik = String(row[cikIdx] ?? "").padStart(10, "0");
      const exchange = row[exchangeIdx];
      if (cik.length === 10 && typeof exchange === "string" && exchange.trim()) {
        cikToExchange.set(cik, exchange.trim().toUpperCase());
      }
    }
  }
  return { source, cikToExchange };
}

function parseMoney(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Nasdaq delayed screener in one request: real last sale, volume, market cap, sector and industry.
 * The endpoint is bulk, so backfilling quarantine drops costs nothing extra.
 */
async function fetchNasdaqMarketData(): Promise<{
  receipt: SecUniverseSourceReceipt;
  byTicker: Map<string, SecMarketDatum>;
}> {
  console.log(`  Fetching nasdaq-delayed-screener: ${NASDAQ_SCREENER_URL}`);
  const text = await fetchText(NASDAQ_SCREENER_URL, {
    headers: { ...NASDAQ_SCREENER_HEADERS },
    timeoutMs: 45_000,
    retries: 2
  });
  const payload = JSON.parse(text) as {
    data?: {
      rows?: Array<Record<string, unknown>>;
      table?: { rows?: Array<Record<string, unknown>> };
    };
  };
  // The 5-row probe shape is data.rows; the full download shape is data.table.rows.
  const rows = payload?.data?.table?.rows ?? payload?.data?.rows ?? [];
  const byTicker = new Map<string, SecMarketDatum>();
  for (const row of rows) {
    const ticker = normalizeManifestTicker(String(row.symbol ?? ""));
    if (!ticker) continue;
    const price = parseMoney(row.lastsale);
    const volume = parseMoney(row.volume);
    const marketCap = parseMoney(row.marketCap);
    if (!(price > 0) || !(volume > 0) || !(marketCap > 0)) continue;
    // First usable row per ticker wins; duplicates on this endpoint are the same listing.
    if (byTicker.has(ticker)) continue;
    byTicker.set(ticker, {
      price,
      volume,
      marketCap,
      sector: typeof row.sector === "string" ? row.sector : null,
      industry: typeof row.industry === "string" ? row.industry : null
    });
  }
  return {
    receipt: { name: "nasdaq-delayed-screener", asOf: new Date().toISOString(), sha256: sha256(text) },
    byTicker
  };
}

/**
 * Fallback only: Yahoo's per-symbol quote endpoint (no API key — the same "floor" real data
 * source the app uses elsewhere). Used when the bulk screener is unavailable; capped so a failed
 * screener cannot turn into an unbounded request fan-out.
 */
async function fetchYahooMarketData(
  symbols: string[]
): Promise<{ receipt: SecUniverseSourceReceipt; byTicker: Map<string, SecMarketDatum> }> {
  const byTicker = new Map<string, SecMarketDatum>();
  const rawChunks: string[] = [];
  const chunkSize = 50;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.map(encodeURIComponent).join(",")}`;
    try {
      const text = await fetchText(url, {
        headers: { accept: "application/json" },
        timeoutMs: 10_000,
        retries: 1
      });
      rawChunks.push(text);
      const payload = JSON.parse(text) as {
        quoteResponse?: {
          result?: Array<{ symbol?: string; regularMarketPrice?: number; regularMarketVolume?: number; marketCap?: number }>;
        };
      };
      for (const item of payload?.quoteResponse?.result ?? []) {
        const ticker = normalizeManifestTicker(item.symbol ?? "");
        const price = Number(item.regularMarketPrice);
        const volume = Number(item.regularMarketVolume ?? 0);
        const marketCap = Number(item.marketCap);
        if (!ticker || !(price > 0) || !(volume > 0) || !(marketCap > 0)) continue;
        if (byTicker.has(ticker)) continue;
        // This endpoint carries neither sector nor industry — left null rather than guessed.
        byTicker.set(ticker, { price, volume, marketCap, sector: null, industry: null });
      }
    } catch (err) {
      console.warn(`  ⚠️  Yahoo market-data fetch failed for chunk starting ${chunk[0]}:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    // Not one canonical byte blob (many chunked, time-varying quote responses) — the hash
    // documents what bytes fed this run, not a reproducible fixture.
    receipt: { name: "yahoo-finance-quotes", asOf: new Date().toISOString(), sha256: sha256(rawChunks.join("\n")) },
    byTicker
  };
}

/**
 * Tranche 1 symbol source: the local SQLite file, read-only.
 *
 * Opened directly rather than through getDb() because db.ts is a `server-only` module (see the
 * header note) and because a generator should never migrate or write the database it reads. A
 * missing file or table is legitimate (fresh checkout) and yields an empty history.
 */
function dbSymbolsFromLocalHistory(): Set<string> {
  const symbols = new Set<string>();
  const databaseUrl = process.env.DATABASE_URL ?? "file:./data/app.db";
  if (!databaseUrl.startsWith("file:")) {
    console.warn("  ⚠️  DATABASE_URL is not a SQLite file URL; skipping DB history (Tranche 1).");
    return symbols;
  }
  const dbPath = path.resolve(databaseUrl.slice("file:".length));
  if (!fs.existsSync(dbPath)) {
    console.log(`  No local database at ${dbPath}; Tranche 1 contributes no symbols.`);
    return symbols;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    for (const table of ["fill_events", "document_chunks", "user_watchlist", "skipped_candidate_counterfactuals"]) {
      if (!tables.has(table)) continue;
      for (const row of db.prepare(`SELECT DISTINCT symbol FROM ${table}`).all() as Array<{ symbol: string | null }>) {
        const normalized = normalizeSymbol(row.symbol ?? "");
        if (normalized) symbols.add(normalized);
      }
    }
  } finally {
    db.close();
  }
  return symbols;
}

function outputPathFromArgv(): string {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  return path.resolve(outArg ? outArg.slice("--out=".length) : "data/rag-universe-manifest.json");
}

async function main() {
  console.log("\n▶ SEC/RAG 1,000-Stock Universe Manifest Generator");
  const outputPath = outputPathFromArgv();

  // 1. Local DB history (Tranche 1). Read-only; an empty history is legitimate on a fresh
  //    checkout and simply contributes no research-priority issuers.
  const dbSymbols = dbSymbolsFromLocalHistory();
  console.log(`  Found ${dbSymbols.size} unique symbols from local database history (fills/chunks/watchlists/skipped).`);

  // 2. Index membership (Tranche 2)
  const indexSymbols = new Set<string>(
    [...SP500_SYMBOLS, ...NASDAQ100_SYMBOLS, ...DOW30_SYMBOLS].map(normalizeSymbol).filter(Boolean) as string[]
  );
  console.log(`  Found ${indexSymbols.size} unique symbols in S&P 500, Nasdaq 100, and Dow 30.`);

  // 3. SEC ticker + exchange lists (Tranche 3 ordering and the exchange field)
  let tickerSource: FetchedSource;
  let secRows: SecTickerRow[];
  let exchangeSource: FetchedSource;
  let cikToExchange: Map<string, string>;
  try {
    ({ source: tickerSource, rows: secRows } = await fetchSecTickerList());
    console.log(`  Loaded ${secRows.length} company tickers from the SEC.`);
    ({ source: exchangeSource, cikToExchange } = await fetchSecExchangeMap());
    console.log(`  Loaded exchange listings for ${cikToExchange.size} CIKs from the SEC.`);
  } catch (err) {
    console.error("  ❌ Failed to fetch SEC ticker/exchange lists:", err);
    process.exit(1);
  }

  // 4. Live market measurements. The bulk screener first; the per-symbol fallback only when the
  //    screener could not cover the universe (so a transient screener outage does not fail the
  //    run, but a total data outage does).
  const sources: SecUniverseSourceReceipt[] = [tickerSource.receipt, exchangeSource.receipt];
  const marketByTicker = new Map<string, SecMarketDatum>();
  try {
    const nasdaq = await fetchNasdaqMarketData();
    sources.push(nasdaq.receipt);
    for (const [ticker, datum] of nasdaq.byTicker) marketByTicker.set(ticker, datum);
    console.log(`  Nasdaq screener returned usable quotes for ${marketByTicker.size} tickers.`);
  } catch (err) {
    console.warn("  ⚠️  Nasdaq delayed screener failed:", err);
  }

  if (marketByTicker.size < TARGET_ISSUER_COUNT) {
    const fallbackSymbols = Array.from(
      new Set<string>([
        ...dbSymbols,
        ...indexSymbols,
        ...secRows.slice(0, TARGET_ISSUER_COUNT * 3).map((row) => normalizeManifestTicker(row.ticker))
      ])
    );
    console.warn(
      `  ⚠️  Only ${marketByTicker.size} usable screener quotes; trying Yahoo for ${fallbackSymbols.length} candidate symbols.`
    );
    try {
      const yahoo = await fetchYahooMarketData(fallbackSymbols);
      if (yahoo.byTicker.size > 0) {
        sources.push(yahoo.receipt);
        for (const [ticker, datum] of yahoo.byTicker) {
          if (!marketByTicker.has(ticker)) marketByTicker.set(ticker, datum);
        }
      }
      console.log(`  Yahoo fallback contributed ${yahoo.byTicker.size} quotes (merged total ${marketByTicker.size}).`);
    } catch (err) {
      console.warn("  ⚠️  Yahoo fallback failed:", err);
    }
  }

  if (marketByTicker.size === 0) {
    console.error(
      "  ❌ No market-data source returned a usable quote. Refusing to write a manifest with no real rows."
    );
    process.exit(1);
  }

  // 5. Assemble + validate. buildSecUniverseManifest throws rather than write a degraded artifact.
  const generatedAt = new Date().toISOString();
  let built: ReturnType<typeof buildSecUniverseManifest>;
  try {
    built = buildSecUniverseManifest({
      secRows,
      cikToExchange,
      marketByTicker,
      dbSymbols,
      indexSymbols,
      sources,
      generatedAt,
      snapshotId: `sec-rag-${generatedAt.slice(0, 10)}`,
      targetIssuerCount: TARGET_ISSUER_COUNT,
      selectionMethod:
        "Tranche 1: DB trading/watch history (research-priority) -> Tranche 2: S&P 500/Nasdaq-100/" +
        "Dow-30 index membership (index-member) -> Tranche 3: SEC company_tickers.json prominence-" +
        "order fill (market-cap-liquidity), capped at 1,000, sorted by ticker. exchange from SEC's " +
        "company_tickers_exchange.json; marketCapUsd/dollarVolumeUsd/sector/industry from live " +
        "market data (Nasdaq delayed screener, Yahoo Finance per-symbol fallback — no API key). " +
        "Issuers without a verified listing exchange or a usable quote are quarantined with an " +
        "honest reason and backfilled from the next SEC listing rather than assigned a placeholder."
    });
  } catch (err) {
    console.error("  ❌ Manifest assembly refused:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { manifest, stats } = built;
  console.log(
    `  Emitted ${stats.emitted} live issuers (research-priority ${stats.researchPriority}, ` +
      `index-member ${stats.indexMember}, market-cap-liquidity ${stats.marketCapLiquidity}; ` +
      `${stats.withSector} with sector).`
  );
  if (stats.quarantined > 0) {
    const reasons = Object.entries(stats.quarantineReasons)
      .map(([reason, count]) => `${count}x ${reason}`)
      .join("; ");
    console.warn(`  ⚠️  Quarantined ${stats.quarantined} candidate(s): ${reasons}`);
  }

  // 6. Sort by ticker before writing to avoid leaking DB-derived provenance through insertion
  //    order. Ranks are re-derived from the sorted array and the hash is recomputed over it, then
  //    the artifact is re-validated exactly as it will be written.
  manifest.issuers.sort((a, b) => a.ticker.localeCompare(b.ticker));
  manifest.issuers.forEach((issuer, index) => {
    issuer.rank = index + 1;
  });
  manifest.issuerSha256 = hashSecUniverseIssuers(manifest.issuers);
  const postSortIssues = blockingUniverseValidationIssues(
    validateSecUniverseManifest(manifest as FrozenSecUniverseManifest)
  );
  if (postSortIssues.length > 0) {
    console.error(`  ❌ Sorted manifest failed schema validation (${postSortIssues.length} issue(s)):`);
    for (const issue of postSortIssues.slice(0, 20)) console.error(`     - ${issue.code} ${issue.path}: ${issue.message}`);
    process.exit(1);
  }

  // 7. Save.
  const destDir = path.dirname(outputPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(
    `  Manifest frozen successfully! Wrote ${manifest.issuers.length} issuers ` +
      `(${manifest.sources.length} source receipt(s)) to: ${outputPath}`
  );
  console.log("══ Done ══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Universe generator crashed:", err);
  process.exit(1);
});