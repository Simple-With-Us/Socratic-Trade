import { isWorkingOrderState } from "./broker-held-orders";
import { normalizeSymbol } from "./money";
import type {
  EquityOrder,
  EquityPosition,
  MarketQuoteSummary,
  MarketScan,
  PendingProposal,
  RecentProposal
} from "./types";

/** Matches app/console/orders/lib.ts terminalOrders history cap. */
export const CLIENT_SNAPSHOT_TERMINAL_ORDER_LIMIT = 20;

export function collectSnapshotQuoteSymbols(input: {
  positions: EquityPosition[];
  orders: EquityOrder[];
  pendingProposals: PendingProposal[];
  recentProposals?: RecentProposal[];
  scan?: Pick<MarketScan, "topCandidates"> | null;
}): Set<string> {
  const symbols = new Set<string>();
  const add = (symbol: string | undefined) => {
    const normalized = symbol?.trim();
    if (!normalized) return;
    symbols.add(normalizeSymbol(normalized));
  };
  for (const position of input.positions) add(position.symbol);
  for (const order of input.orders) add(order.symbol);
  for (const pending of input.pendingProposals) add(pending.proposal.symbol);
  for (const recent of input.recentProposals ?? []) add(recent.proposal.symbol);
  for (const quote of input.scan?.topCandidates ?? []) add(quote.symbol);
  return symbols;
}

export function projectQuotesBySymbolForClient(
  quotesBySymbol: Record<string, MarketQuoteSummary> | undefined,
  referencedSymbols: Set<string>
): Record<string, MarketQuoteSummary> {
  if (!quotesBySymbol || referencedSymbols.size === 0) return {};
  const projected: Record<string, MarketQuoteSummary> = {};
  for (const symbol of referencedSymbols) {
    const quote =
      quotesBySymbol[symbol] ??
      quotesBySymbol[symbol.toUpperCase()] ??
      Object.values(quotesBySymbol).find((row) => normalizeSymbol(row.symbol) === symbol);
    if (quote) projected[symbol] = quote;
  }
  return projected;
}

export function projectMarketScanForClient<T extends MarketScan>(
  scan: T | undefined,
  referencedSymbols: Set<string>
): T | undefined {
  if (!scan) return scan;
  return {
    ...scan,
    quotesBySymbol: projectQuotesBySymbolForClient(scan.quotesBySymbol, referencedSymbols)
  };
}

export function projectOrdersForClientSnapshot(orders: EquityOrder[]): EquityOrder[] {
  const working: EquityOrder[] = [];
  const terminal: EquityOrder[] = [];
  for (const order of orders) {
    if (isWorkingOrderState(order.state)) working.push(order);
    else terminal.push(order);
  }
  terminal.sort((a, b) => orderSortTime(b) - orderSortTime(a));
  return [...working, ...terminal.slice(0, CLIENT_SNAPSHOT_TERMINAL_ORDER_LIMIT)];
}

function orderSortTime(order: EquityOrder): number {
  const parsed = Date.parse(order.updatedAt ?? order.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
