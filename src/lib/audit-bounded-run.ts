// audit-bounded-run.ts — bounds the strategy_run audit payload.
//
// Production finding (2026-08-01): `audit("strategy_run", result, ...)` embedded the
// FULL MarketScan — avg 600 KB, p90 ~2.8 MB per run (marketScan = 2.7 MB of it),
// 130/141 runs last week >500 KB. That is ~430 MB/month of audit_events volume
// (audit_events is 718 MB — half the DB) plus the same bytes again in every
// litestream snapshot + WAL LTX into R2. Consumers of the audit payload
// (dashboard-feed, ops-snapshot) read only status/summary/llmSteps.
//
// The scan itself is reconstructable (it re-runs every cycle) and the run's
// decisions/proposals live in their own tables — the audit row needs the scan's
// SHAPE (source, counts, top symbols), not its megabytes of enrichment blobs.

import type { MarketScan } from "./types";

export interface BoundedMarketScanSummary {
  /** Marker so forensic readers know the full scan was deliberately omitted. */
  omitted: true;
  source: string;
  generatedAt: string;
  scannedSymbols: number;
  returnedQuotes: number;
  candidateCount: number;
  /** First N candidate symbols in scan order (the ranked head). */
  topSymbols: string[];
}

const TOP_SYMBOLS_CAP = 15;

export function summarizeMarketScanForAudit(scan: MarketScan | null | undefined): BoundedMarketScanSummary | null {
  if (!scan) return null;
  const candidates = Array.isArray(scan.topCandidates) ? scan.topCandidates : [];
  const topSymbols = candidates
    .slice(0, TOP_SYMBOLS_CAP)
    .map((c) => (c && typeof c === "object" ? (c as { symbol?: unknown }).symbol : undefined))
    .filter((s): s is string => typeof s === "string");
  return {
    omitted: true,
    source: scan.source,
    generatedAt: scan.generatedAt,
    scannedSymbols: scan.scannedSymbols,
    returnedQuotes: scan.returnedQuotes,
    candidateCount: candidates.length,
    topSymbols,
  };
}

/** Shallow-clone a StrategyResult with its marketScan replaced by the bounded
 *  summary. Everything else passes through by reference (the audit payload
 *  JSON-stringifies immediately, so sharing references is safe). */
export function auditBoundedStrategyRunResult<T extends { marketScan?: MarketScan | null }>(
  result: T,
): Omit<T, "marketScan"> & { marketScan: BoundedMarketScanSummary | null } {
  return {
    ...result,
    marketScan: summarizeMarketScanForAudit(result.marketScan ?? null),
  };
}
