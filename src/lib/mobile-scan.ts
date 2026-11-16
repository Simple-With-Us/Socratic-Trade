import { isUnusableEmptyMarketScan } from "./scan-singleflight";
import type { MarketQuote, MarketScan } from "./types";

/** Compact last-good scan for `/api/mobile/snapshot`.  The desk table needs
 *  ranked names + counts, not the 5k-row `quotesBySymbol` map. */
export interface MobileMarketScan {
  generatedAt: string;
  asOf?: string;
  scannedSymbols: number;
  returnedQuotes: number;
  candidateLimit?: number;
  heldCandidateCount?: number;
  outlierCandidateCount?: number;
  warnings: string[];
  source?: string;
  topCandidates: Array<{
    symbol: string;
    companyName?: string;
    price?: number;
    score?: number;
    intradayChangePct?: number;
    sector?: string;
    industry?: string;
    volume?: number;
    bid?: number;
    ask?: number;
  }>;
}

function compactCandidate(quote: MarketQuote): MobileMarketScan["topCandidates"][number] {
  return {
    symbol: quote.symbol,
    companyName: quote.companyName,
    price: quote.price,
    score: quote.score,
    intradayChangePct: quote.intradayChangePct,
    sector: quote.sector,
    industry: quote.industry,
    volume: quote.volume,
    bid: quote.bid,
    ask: quote.ask
  };
}

export function compactMobileMarketScan(scan: MarketScan | null | undefined): MobileMarketScan | null {
  if (!scan || typeof scan.generatedAt !== "string" || !Array.isArray(scan.topCandidates)) {
    return null;
  }
  if (isUnusableEmptyMarketScan(scan)) return null;
  const warnings = Array.isArray(scan.warnings) ? [...scan.warnings] : [];
  const shortfall = scan.dataCoverage?.shortfallSummary?.trim();
  if (shortfall && !warnings.includes(shortfall)) warnings.push(shortfall);
  return {
    generatedAt: scan.generatedAt,
    asOf: scan.generatedAt,
    scannedSymbols: scan.scannedSymbols,
    returnedQuotes: scan.returnedQuotes,
    candidateLimit: scan.candidateLimit,
    heldCandidateCount: scan.heldCandidateCount,
    outlierCandidateCount: scan.outlierCandidateCount,
    warnings,
    source: scan.source,
    topCandidates: scan.topCandidates.map(compactCandidate)
  };
}
