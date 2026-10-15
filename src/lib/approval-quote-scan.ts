import { fetchFreshQuotesCascade } from "./quotes-cascade";
import { normalizeSymbol } from "./money";
import type { BrokerQuote, EquityPosition, MarketQuote, MarketScan, MarketQuoteSummary, TradeProposal } from "./types";

/**
 * Approval-time quotes for one proposal — never a full-universe NASDAQ screener.
 * `executeProposal` used to call `scanMarket(allowedSymbols)` which always fetches
 * the whole screener then enriches it, so one Approve held the strategy lock for
 * tens of seconds and the phone sat on "Sending approve…".
 */
export function approvalQuoteSymbols(proposal: Pick<TradeProposal, "symbol">, positions: EquityPosition[]): string[] {
  return Array.from(
    new Set([proposal.symbol, ...positions.map((position) => position.symbol)].map(normalizeSymbol).filter(Boolean))
  );
}

export function buildApprovalQuoteScan(
  quotes: Record<string, BrokerQuote>,
  positions: EquityPosition[],
  generatedAt = new Date().toISOString()
): MarketScan {
  const providers = new Set<string>();
  const quotesBySymbol: Record<string, MarketQuoteSummary> = {};
  const sectorBySymbol: Record<string, string> = {};
  const topCandidates: MarketQuote[] = [];

  for (const [rawSymbol, quote] of Object.entries(quotes)) {
    const symbol = normalizeSymbol(rawSymbol);
    const price = quote.price;
    if (!(typeof price === "number" && price > 0)) continue;
    if (quote.provider) providers.add(quote.provider);
    const position = positions.find((row) => normalizeSymbol(row.symbol) === symbol);
    const summary: MarketQuoteSummary = {
      symbol,
      price,
      bid: quote.bid,
      ask: quote.ask,
      score: 0,
      provider: quote.provider,
      ...(quote.asOf ? { asOf: quote.asOf } : {}),
      venuePriceAuthoritative: quote.venuePriceAuthoritative,
      fetchedAt: quote.fetchedAt,
      delayedFallback: quote.delayedFallback,
      sector: position?.sector,
      industry: position?.industry,
      syntheticBid: quote.syntheticBid ?? quote.syntheticSpread,
      syntheticAsk: quote.syntheticAsk ?? quote.syntheticSpread
    };
    quotesBySymbol[symbol] = summary;
    if (position?.sector) sectorBySymbol[symbol] = position.sector;
    topCandidates.push({
      ...summary,
      volume: quote.volume && quote.volume > 0 ? quote.volume : 0,
      intradayChangePct: 0,
      positionMarketValue: position?.marketValue ?? 0
    });
  }

  return {
    source: [...providers].join("+") || "approval-quotes",
    generatedAt,
    scannedSymbols: Object.keys(quotes).length,
    returnedQuotes: topCandidates.length,
    topCandidates,
    sectorBySymbol,
    quotesBySymbol,
    warnings: topCandidates.length === 0 ? ["No live quotes for this approval."] : []
  };
}

export async function loadApprovalQuoteScan(input: {
  proposal: Pick<TradeProposal, "symbol">;
  positions: EquityPosition[];
  userId: string;
  accountNumber?: string;
  connectedAccountId?: string;
}): Promise<MarketScan> {
  const symbols = approvalQuoteSymbols(input.proposal, input.positions);
  const quotes = await fetchFreshQuotesCascade(
    symbols,
    input.userId,
    input.accountNumber,
    input.connectedAccountId
  );
  return buildApprovalQuoteScan(quotes, input.positions);
}
