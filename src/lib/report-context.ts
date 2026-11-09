// report-context.ts — pure data assembly for the daily watchlist digest (see watchlist-digest.ts).
// Builds one typed WatchlistReportContext per user from data the app ALREADY persisted this run
// cycle: the watchlist itself, the latest persisted `market_scan` audit (never a live provider
// call — see dashboard.ts's identical latestAuditByKind("market_scan", ...) read), and each
// symbol's recent trade_proposals trajectory. No rendering here — report-renderer.ts turns this
// into the three push/email tiers (full/medium/brief).

import { latestAuditByKind, listProposalsBySymbol } from "./db";
import { listWatchlist } from "./watchlist";
import type { SymbolProposalTrajectoryRow } from "./db-proposals";
import type { MarketQuoteSummary, MarketScan } from "./types";

/** Max trajectory rows per symbol — a compact "recent history", not the full ledger. */
export const WATCHLIST_DIGEST_TRAJECTORY_LIMIT = 5;

export interface WatchlistSymbolReport {
  symbol: string;
  /** When the watchlist symbol was added (WatchlistItem.addedAt) — honest "how long have I been
   *  watching this" context, independent of whether any quote/proposal data exists yet. */
  addedAt: string;
  /** Latest known quote summary for this symbol from the most recently persisted market_scan
   *  audit. Undefined when the symbol never appeared in a persisted scan (e.g. just added, or
   *  outside the scanned universe) — rendered as no-data, never fabricated. */
  quote?: MarketQuoteSummary;
  /** Most recent trade_proposals row for this symbol (trajectory[0]) — a convenience accessor,
   *  not a second query. Undefined when the symbol has no proposal history at all. */
  latestProposal?: SymbolProposalTrajectoryRow;
  /** Up to WATCHLIST_DIGEST_TRAJECTORY_LIMIT rows, newest first (latestProposal is trajectory[0]
   *  when present). Empty array — never padded — when the symbol has no proposal history. */
  trajectory: SymbolProposalTrajectoryRow[];
}

export interface WatchlistReportContext {
  userId: string;
  /** When this context was assembled (ISO instant) — the digest's own "as of" stamp. */
  generatedAt: string;
  /** createdAt of the persisted market_scan audit the quotes below were read from. Undefined
   *  when no market_scan audit has ever been persisted for this user — every symbol's `quote`
   *  is then also undefined, rendered honestly as no-data rather than a fabricated "0 symbols
   *  scanned" summary. */
  marketScanAsOf?: string;
  symbols: WatchlistSymbolReport[];
}

/**
 * Assemble the watchlist digest's report context for `userId`. Pure/synchronous: every input is
 * already in SQLite (watchlist, the latest market_scan audit, trade_proposals) — no network or
 * provider calls, so this is safe to call from a scheduler tick. Symbols on the watchlist with no
 * quote and no proposal history are still included (with those fields empty/undefined) — a thin
 * watchlist is honest information, not an error.
 */
export function buildWatchlistReportContext(userId: string): WatchlistReportContext {
  const watchlist = listWatchlist(userId);

  // User-wide latest scan (no connectedAccountId scoping) — matches dashboard.ts's own
  // account-less fallback read of the same audit kind, and market-scan-freshness.ts keeps this
  // populated on a background cadence independent of whether the owner is actively trading.
  const latestScanAudit = latestAuditByKind("market_scan", userId);
  const scanPayload = latestScanAudit?.payload as { scan?: MarketScan } | undefined;
  const quotesBySymbol = scanPayload?.scan?.quotesBySymbol;

  const symbols: WatchlistSymbolReport[] = watchlist.map((item) => {
    const trajectory = listProposalsBySymbol({
      symbol: item.symbol,
      userId,
      limit: WATCHLIST_DIGEST_TRAJECTORY_LIMIT
    });
    return {
      symbol: item.symbol,
      addedAt: item.addedAt,
      quote: quotesBySymbol?.[item.symbol],
      latestProposal: trajectory[0],
      trajectory
    };
  });

  return {
    userId,
    generatedAt: new Date().toISOString(),
    marketScanAsOf: latestScanAudit?.createdAt,
    symbols
  };
}
