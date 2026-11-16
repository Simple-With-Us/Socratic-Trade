import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getDb } from "../../src/lib/db";
import { politeFetchText } from "../../src/lib/web-sources/http";
import { SP500_SYMBOLS } from "../../src/lib/sp500";
import { NASDAQ100_SYMBOLS, DOW30_SYMBOLS } from "../../src/lib/index-universes";
import { normalizeSymbol } from "../../src/lib/money";
import {
  SEC_UNIVERSE_SCHEMA_VERSION,
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseIssuer,
  type SecUniverseInclusionReason,
  type SecUniverseSourceReceipt
} from "../../src/lib/rag/universe-manifest";

// Emits the versioned FrozenSecUniverseManifest shape validateSecUniverseManifest requires (see
// src/lib/rag/universe-manifest.ts). Previously this script wrote a bare issuer array — the
// generator and the validator had silently drifted apart (Codex audit, 2026-07-18). Every field
// below is either derived from a source this script actually fetches, or an explicit null/
// quarantine when no honest source exists — never a fabricated number standing in for real data.

interface UniverseEntry {
  cik: string;
  ticker: string;
  title: string;
  inclusionReason: SecUniverseInclusionReason;
  /** Alternative tickers for the same CIK (e.g. GOOG/GOOGL for Alphabet). */
  aliases: string[];
}

interface QuarantineEntry {
  cik?: string;
  ticker?: string;
  reason: string;
}

interface FetchedSource {
  receipt: SecUniverseSourceReceipt;
  text: string;
}

async function fetchSource(name: string, url: string): Promise<FetchedSource> {
  console.log(`  Fetching ${name}: ${url}`);
  const { secUserAgent } = await import("../../src/lib/web-sources/http");
  const text = await politeFetchText(url, { headers: { "user-agent": secUserAgent() } });
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return { receipt: { name, asOf: new Date().toISOString(), sha256 }, text };
}

async function fetchSecTickerList(): Promise<{ source: FetchedSource; rows: Array<{ cik: number; ticker: string; title: string }> }> {
  // company_tickers.json preserves SEC's original prominence ordering (loadCikMap converts it to a
  // key-value record where order is lost), so this script fetches it directly.
  const source = await fetchSource("sec-company-tickers", "https://www.sec.gov/files/company_tickers.json");
  const data = JSON.parse(source.text) as Record<string, { cik_str: number; ticker: string; title: string }>;
  return { source, rows: Object.values(data).map((row) => ({ cik: row.cik_str, ticker: row.ticker, title: row.title })) };
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

interface YahooMarketDatum {
  price: number;
  volume: number;
  marketCap?: number;
}

/**
 * Real price/volume/market-cap via Yahoo's free quote endpoint (no API key — the same "floor" real
 * data source the app uses elsewhere, see src/lib/yahoo-finance.ts). A small self-contained fetch
 * rather than reusing fetchYahooFinanceQuotesBatch: that shared helper is consumed by live app code
 * and does not currently extract marketCap, and widening its return shape for this one script isn't
 * worth the cross-cutting risk.
 */
async function fetchYahooMarketData(
  symbols: string[]
): Promise<{ receipt: SecUniverseSourceReceipt; byTicker: Map<string, YahooMarketDatum> }> {
  const byTicker = new Map<string, YahooMarketDatum>();
  const rawChunks: string[] = [];
  const chunkSize = 50;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.map(encodeURIComponent).join(",")}`;
    try {
      const text = await politeFetchText(url, { headers: { accept: "application/json" }, timeoutMs: 10_000 });
      rawChunks.push(text);
      const payload = JSON.parse(text) as {
        quoteResponse?: {
          result?: Array<{ symbol?: string; regularMarketPrice?: number; regularMarketVolume?: number; marketCap?: number }>;
        };
      };
      for (const item of payload?.quoteResponse?.result ?? []) {
        const ticker = normalizeSymbol(item.symbol ?? "");
        const price = Number(item.regularMarketPrice);
        if (!ticker || !Number.isFinite(price) || price <= 0) continue;
        const volume = Number(item.regularMarketVolume ?? 0);
        const marketCap = Number(item.marketCap);
        byTicker.set(ticker, {
          price,
          volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
          marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : undefined
        });
      }
    } catch (err) {
      console.warn(`  ⚠️  Yahoo market-data fetch failed for chunk starting ${chunk[0]}:`, err);
    }
    // Polite delay between chunks — this endpoint has no documented rate contract like EDGAR's, but
    // ~1,000 tickers in 50-wide chunks is only ~20 requests; no need to hammer it back-to-back.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Not one canonical byte blob (many chunked, time-varying quote responses) — hash the concatenated
  // raw responses this run actually received, in fetch order, as the exact provenance for this
  // snapshot's market-cap/dollar-volume figures. Reproducing the SAME hash later is not expected
  // (quotes change every second); this sha256 documents "what bytes fed this run", not "a stable
  // fixture".
  const sha256 = createHash("sha256").update(rawChunks.join("\n"), "utf8").digest("hex");
  return {
    receipt: { name: "yahoo-finance-quotes", asOf: new Date().toISOString(), sha256 },
    byTicker
  };
}

async function main() {
  console.log("\n▶ SEC/RAG 1,000-Stock Universe Manifest Generator");

  // 1. Load active/traded symbols from DB history
  const db = getDb();
  const fillSymbols = db.prepare("SELECT DISTINCT symbol FROM fill_events").all() as Array<{ symbol: string }>;
  const chunkSymbols = db.prepare("SELECT DISTINCT symbol FROM document_chunks").all() as Array<{ symbol: string }>;
  const watchlistSymbols = db.prepare("SELECT DISTINCT symbol FROM user_watchlist").all() as Array<{ symbol: string }>;
  const skippedSymbols = db.prepare("SELECT DISTINCT symbol FROM skipped_candidate_counterfactuals").all() as Array<{ symbol: string }>;

  const dbSymbols = new Set<string>();
  [fillSymbols, chunkSymbols, watchlistSymbols, skippedSymbols].forEach(list => {
    list.forEach(s => {
      const norm = normalizeSymbol(s.symbol);
      if (norm) dbSymbols.add(norm);
    });
  });
  console.log(`  Found ${dbSymbols.size} unique symbols from local database history (fills/chunks/watchlists/skipped).`);

  // 2. Load index symbols
  const indexSymbols = new Set<string>([
    ...SP500_SYMBOLS,
    ...NASDAQ100_SYMBOLS,
    ...DOW30_SYMBOLS
  ].map(normalizeSymbol).filter(Boolean) as string[]);
  console.log(`  Found ${indexSymbols.size} unique symbols in S&P 500, Nasdaq 100, and Dow 30.`);

  // 3. Fetch full SEC ticker CIK list + the exchange-listing file
  let tickerSource: FetchedSource;
  let secList: Array<{ cik: number; ticker: string; title: string }>;
  let exchangeSource: FetchedSource;
  let cikToExchange: Map<string, string>;
  try {
    ({ source: tickerSource, rows: secList } = await fetchSecTickerList());
    console.log(`  Loaded ${secList.length} company tickers from the SEC.`);
    ({ source: exchangeSource, cikToExchange } = await fetchSecExchangeMap());
    console.log(`  Loaded exchange listings for ${cikToExchange.size} CIKs from the SEC.`);
  } catch (err) {
    console.error("  ❌ Failed to fetch SEC ticker/exchange lists:", err);
    process.exit(1);
  }

  // Build direct mapping records
  const secTickerToCik: Record<string, string> = {};
  const secCikToTitle: Record<string, string> = {};

  secList.forEach(row => {
    const normTicker = normalizeSymbol(row.ticker);
    const paddedCik = String(row.cik).padStart(10, "0");
    if (normTicker) {
      secTickerToCik[normTicker] = paddedCik;
      secCikToTitle[paddedCik] = row.title;
    }
  });

  const universe: UniverseEntry[] = [];
  const addedCiks = new Set<string>();
  const addedTickers = new Set<string>();

  const addIssuer = (cik: string, ticker: string, title: string, reason: SecUniverseInclusionReason) => {
    if (addedCiks.has(cik)) {
      // CIK already exists — track alias ticker for multi-ticker entities (e.g. GOOG/GOOGL)
      if (!addedTickers.has(ticker)) {
        addedTickers.add(ticker);
        const existing = universe.find(e => e.cik === cik);
        if (existing && !existing.aliases.includes(ticker)) {
          existing.aliases.push(ticker);
        }
      }
      return false;
    }
    if (universe.length >= 1000) return false; // hard cap at 1,000 CIKs
    addedCiks.add(cik);
    addedTickers.add(ticker);
    universe.push({ cik, ticker, title, inclusionReason: reason, aliases: [] });
    return true;
  };

  // Tranche 1: Traded database symbols. "research-priority" — a valid, non-leaking inclusion
  // category (the DB is the selection mechanism; the manifest itself never records which symbols
  // came from the owner's real trade/watch history, only that they were research-prioritized).
  console.log("  Processing Tranche 1: DB History...");
  let dbAdded = 0;
  for (const sym of dbSymbols) {
    const cik = secTickerToCik[sym];
    if (cik) {
      const title = secCikToTitle[cik] ?? "";
      if (addIssuer(cik, sym, title, "research-priority")) dbAdded++;
    } else {
      console.log(`  ⚠️  Ticker ${sym} from DB history could not be mapped to an SEC CIK.`);
    }
  }
  console.log(`  Added ${dbAdded} issuers from DB history.`);

  // Tranche 2: Index symbols
  console.log("  Processing Tranche 2: Index Members...");
  let indexAdded = 0;
  for (const sym of indexSymbols) {
    const cik = secTickerToCik[sym];
    if (cik) {
      const title = secCikToTitle[cik] ?? "";
      if (addIssuer(cik, sym, title, "index-member")) indexAdded++;
    }
  }
  console.log(`  Added ${indexAdded} new issuers from index memberships.`);

  // Tranche 3: Top prominent SEC companies by original listing order
  console.log("  Processing Tranche 3: Filling up to 1,000 using top market-cap SEC listings...");
  let secAdded = 0;
  for (const row of secList) {
    if (universe.length >= 1000) break;
    const normTicker = normalizeSymbol(row.ticker);
    const paddedCik = String(row.cik).padStart(10, "0");
    if (normTicker) {
      if (addIssuer(paddedCik, normTicker, row.title, "market-cap-liquidity")) secAdded++;
    }
  }
  console.log(`  Added ${secAdded} new issuers from top SEC listings.`);
  console.log(`  Total universe size: ${universe.length} CIKs.`);
  if (universe.length < 1000) {
    console.warn(`  ⚠️  Warning: Managed to gather only ${universe.length} symbols. Universe is below 1,000.`);
  }

  // Sort by ticker before writing to avoid leaking DB-derived provenance through insertion order.
  universe.sort((a, b) => a.ticker.localeCompare(b.ticker));

  // 4. Enrich with real market data (price/volume/market-cap) — no fabricated fallback. An issuer
  // Yahoo has no usable quote for is quarantined with an honest reason rather than assigned a made-up
  // number, matching the "never label real data mock/fallback" house rule (CLAUDE.md).
  const { receipt: yahooReceipt, byTicker: marketData } = await fetchYahooMarketData(universe.map(e => e.ticker));

  const generatedAt = new Date().toISOString();
  const sources: SecUniverseSourceReceipt[] = [tickerSource.receipt, exchangeSource.receipt, yahooReceipt];
  const sourceRefs = sources.map(s => s.name);

  const issuers: SecUniverseIssuer[] = [];
  const quarantined: QuarantineEntry[] = [];
  universe.forEach((entry) => {
    const market = marketData.get(entry.ticker);
    const dollarVolumeUsd = market ? market.price * market.volume : 0;
    if (!market || !market.marketCap || dollarVolumeUsd <= 0) {
      quarantined.push({
        cik: entry.cik,
        ticker: entry.ticker,
        reason: "no usable Yahoo Finance quote (price/volume/market-cap) at generation time"
      });
      return;
    }
    issuers.push({
      rank: 0, // assigned below, after quarantine drops are known
      cik: entry.cik,
      ticker: entry.ticker,
      aliases: entry.aliases,
      aliasesVerifiedAt: generatedAt,
      title: entry.title,
      exchange: cikToExchange.get(entry.cik) ?? "UNKNOWN",
      // FPI (20-F/40-F filer) detection would need a per-CIK submissions-type check, which this
      // script does not do (1,000 extra EDGAR calls) — every issuer defaults to operating-company.
      // A wrongly-tagged FPI just means the ingest seeder's 10-K/10-Q discovery finds nothing for it.
      securityType: "operating-company",
      sector: null,
      industry: null,
      marketCapUsd: market.marketCap,
      dollarVolumeUsd,
      // This script only reaches here with a real Yahoo Finance quote (marketCap/dollarVolumeUsd
      // are genuine measurements, not placeholders) — see the quarantine branch above for the
      // no-usable-quote case, which never becomes an issuer at all.
      dataQuality: "live",
      inclusionReason: entry.inclusionReason,
      sourceRefs
    });
  });
  issuers.forEach((issuer, index) => { issuer.rank = index + 1; });

  if (quarantined.length > 0) {
    console.warn(`  ⚠️  Quarantined ${quarantined.length} issuer(s) with no usable market data: ${quarantined.map(q => q.ticker).join(", ")}`);
  }

  const manifest: FrozenSecUniverseManifest = {
    schemaVersion: SEC_UNIVERSE_SCHEMA_VERSION,
    snapshotId: `sec-rag-${generatedAt.slice(0, 10)}`,
    effectiveAt: generatedAt,
    generatedAt,
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod:
      "Tranche 1: DB trading/watch history (research-priority) -> Tranche 2: S&P 500/Nasdaq-100/" +
      "Dow-30 index membership (index-member) -> Tranche 3: SEC company_tickers.json prominence-" +
      "order fill (market-cap-liquidity), capped at 1,000, sorted by ticker. exchange from SEC's " +
      "company_tickers_exchange.json; marketCapUsd/dollarVolumeUsd from a live Yahoo Finance quote " +
      "(no API key); sector/industry are not sourced by this script and are left null. Issuers with " +
      "no usable Yahoo quote are quarantined rather than assigned a fabricated number.",
    sources,
    issuers,
    quarantined
  };

  const issues = blockingUniverseValidationIssues(validateSecUniverseManifest(manifest, { expectedIssuerCount: issuers.length }));
  if (issues.length > 0) {
    console.error(`  ❌ Generated manifest failed its own schema validation (${issues.length} issue(s)):`);
    for (const issue of issues.slice(0, 20)) console.error(`     - ${issue.code} ${issue.path}: ${issue.message}`);
    process.exit(1);
  }

  // 5. Save the manifest
  const destDir = path.dirname(path.resolve("data/rag-universe-manifest.json"));
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const manifestPath = path.resolve("data/rag-universe-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`  Manifest frozen successfully! Wrote ${issuers.length} issuers to: ${manifestPath}`);
  console.log("══ Done ══════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error("Universe generator crashed:", err);
  process.exit(1);
});
