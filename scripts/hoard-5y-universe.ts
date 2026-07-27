import fs from "fs";
import path from "path";
import { FmpEnrichmentProvider, MassiveEnrichmentProvider } from "../src/lib/data-providers";
import { SP500_SYMBOLS } from "../src/lib/sp500";
import { NASDAQ100_SYMBOLS, DOW30_SYMBOLS } from "../src/lib/index-universes";
import { fetchBlackRockHoldingSymbols } from "../src/lib/fund-holdings";
import { normalizeSymbol } from "../src/lib/money";
import { resolveApiKey } from "../src/lib/db-api-keys";

const MAJOR_ETFS_AND_REITS = [
  // Major Sector & Broad Market ETFs
  "SPY", "IVV", "VOO", "QQQ", "IWM", "OEF", "VTI", "SCHD",
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLC", "XLU", "XLB", "XLRE",
  "VNQ", "JEPI", "JEPQ", "TLT", "GLD", "SLV", "USO", "UNG", "SOXX", "SMH", "ARKK",
  // Real Estate Investment Trusts (REITs)
  "O", "PLD", "AMT", "EQIX", "SPG", "PSA", "CCI", "DLR", "WELL", "VICI",
  "AVB", "EQR", "WY", "SBAC", "EXR", "MAA", "CPT", "INVH", "ARE"
];

async function hoard5YearMassiveBars(massiveKey: string, symbol: string): Promise<number> {
  const dir = path.join(process.cwd(), "data", "history-5y");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const file = path.join(dir, `${symbol}.json`);
  if (fs.existsSync(file)) {
    const stats = fs.statSync(file);
    if (stats.size > 100) return 0; // Skip already downloaded non-empty bars
  }

  const startDate = "2021-01-01";
  const endDate = new Date().toISOString().slice(0, 10);
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${massiveKey}`, Accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[Massive 5Y] Failed HTTP ${res.status} for ${symbol}`);
      return 0;
    }
    const data = await res.json();
    const results = (data as any)?.results ?? [];
    if (Array.isArray(results) && results.length > 0) {
      fs.writeFileSync(file, JSON.stringify(results, null, 2));
      return results.length;
    }
  } catch (err) {
    console.warn(`[Massive 5Y] Exception for ${symbol}:`, err);
  }
  return 0;
}

async function hoard() {
  const fmpKey = resolveApiKey("fmp") || process.env.FMP_API_KEY;
  const massiveKey = resolveApiKey("massive") || process.env.MASSIVE_API_KEY_ALT || process.env.MASSIVE_API_KEY;

  if (!fmpKey) console.warn("[Hoard 5Y] FMP_API_KEY not found.");
  if (!massiveKey) console.warn("[Hoard 5Y] MASSIVE_API_KEY not found.");

  // 1. Build Master Multi-Index Universe (~2,500+ symbols)
  console.log("=== BUILDING MASTER MULTI-INDEX UNIVERSE (S&P 500, Nasdaq 100, Dow 30, Russell 2000, S&P 100, ETFs, REITs) ===");
  const symbolSet = new Set<string>();

  for (const sym of SP500_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of NASDAQ100_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of DOW30_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of MAJOR_ETFS_AND_REITS) symbolSet.add(normalizeSymbol(sym));

  try {
    const r2k = await fetchBlackRockHoldingSymbols("russell2000", 3600000);
    for (const sym of r2k.symbols) symbolSet.add(normalizeSymbol(sym));
    console.log(`Added ${r2k.symbols.length} Russell 2000 symbols.`);
  } catch (err) {
    console.warn("Failed to fetch Russell 2000 holdings:", err);
  }

  try {
    const sp100 = await fetchBlackRockHoldingSymbols("sp100", 3600000);
    for (const sym of sp100.symbols) symbolSet.add(normalizeSymbol(sym));
    console.log(`Added ${sp100.symbols.length} S&P 100 symbols.`);
  } catch (err) {
    console.warn("Failed to fetch S&P 100 holdings:", err);
  }

  const allSymbols = Array.from(symbolSet).filter(Boolean);
  console.log(`Master Multi-Index Universe contains ${allSymbols.length} unique tradeable symbols.\n`);

  // 2. Fetch 5-Year OHLC Historical Bars via Massive API
  if (massiveKey) {
    console.log(`=== FETCHING 5-YEAR DAILY OHLC BARS VIA MASSIVE API (${allSymbols.length} symbols) ===`);
    let downloadedCount = 0;
    let totalBarsCount = 0;

    for (let i = 0; i < allSymbols.length; i++) {
      const symbol = allSymbols[i];
      if (i % 50 === 0 || i === allSymbols.length - 1) {
        console.log(`[Massive 5Y OHLC Progress] ${i}/${allSymbols.length} symbols processed (Downloaded: ${downloadedCount}, Total Bars: ${totalBarsCount})`);
      }
      const count = await hoard5YearMassiveBars(massiveKey, symbol);
      if (count > 0) {
        downloadedCount++;
        totalBarsCount += count;
      }
      await new Promise(r => setTimeout(r, 120)); // ~8 req/sec pacing
    }
    console.log(`Massive 5-Year OHLC Bar Hoarding Complete! (${downloadedCount} downloaded, ${totalBarsCount} total daily candles stored in data/history-5y/)\n`);
  }

  // 3. Fetch Fundamental Metrics, Ratings & Ratios via FMP API
  if (fmpKey) {
    console.log(`=== FETCHING FUNDAMENTALS & RATIOS VIA FMP API (${allSymbols.length} symbols) ===`);
    const fmpProvider = new FmpEnrichmentProvider(fmpKey, "env", "local");
    const chunkSize = 25;
    const totalChunks = Math.ceil(allSymbols.length / chunkSize);

    for (let i = 0; i < allSymbols.length; i += chunkSize) {
      const chunk = allSymbols.slice(i, i + chunkSize);
      console.log(`[FMP Fundamentals Progress] Chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} (${chunk.length} symbols)...`);
      await fmpProvider.enrich(chunk);
      await new Promise(r => setTimeout(r, 350));
    }
    console.log(`FMP Multi-Index Fundamentals Hoarding Complete!\n`);
  }

  // 4. Fetch Short Interest & Free Float via Massive API
  if (massiveKey) {
    console.log(`=== FETCHING SHORT INTEREST & FLOAT VIA MASSIVE API (${allSymbols.length} symbols) ===`);
    const massiveProvider = new MassiveEnrichmentProvider(massiveKey, "env", "local");
    const chunkSize = 25;
    const totalChunks = Math.ceil(allSymbols.length / chunkSize);

    for (let i = 0; i < allSymbols.length; i += chunkSize) {
      const chunk = allSymbols.slice(i, i + chunkSize);
      console.log(`[Massive Short Interest Progress] Chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} (${chunk.length} symbols)...`);
      await massiveProvider.enrich(chunk);
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`Massive Short Interest & Float Hoarding Complete!\n`);
  }

  console.log("=========================================================================");
  console.log(`ALL 5-YEAR HISTORICAL, FUNDAMENTAL & SHORT INTEREST HOARDING COMPLETE ACROSS ALL ${allSymbols.length} SYMBOLS!`);
  console.log("=========================================================================");
}

hoard().catch(console.error);
