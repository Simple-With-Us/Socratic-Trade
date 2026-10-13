import { NextResponse } from "next/server";
import { audit, getPolicy, latestAuditByKind, newerAuditEntry } from "@/lib/db";
import { dynamicIndexUniversesForPolicy } from "@/lib/index-universes";
import { isScanQuotesUnavailableError, mergeGroupedBarData, mergeQuoteData, scanMarket } from "@/lib/market";
import { newestPersistedMarketScan } from "@/lib/market-scan-freshness";
import { allowedSymbolsForPolicy } from "@/lib/policy";
import { getBrokerGateway } from "@/lib/broker";
import { fetchRecentGroupedBarsRest } from "@/lib/market-signals/massive";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import type { EquityPosition, MarketScan } from "@/lib/types";
import {
  interactiveScanKey,
  isUnusableEmptyMarketScan,
  marketScanQuotesFromAudit,
  runScanSingleFlight,
  staleMarketScanResponse,
  withScanDeadline
} from "@/lib/scan-singleflight";

export const dynamic = "force-dynamic";
// 15s Nasdaq header budget + one abort retry + rank.  The screener fetch and
// its JSON body honor this deadline signal.  On timeout the handler returns
// the last good scan (stale) instead of 500/503 when one exists.
const INTERACTIVE_SCAN_BUDGET_MS = 35_000;

function lastGoodScanResponse(userId: string, connectedAccountId: string | undefined, staleReason: string) {
  const persisted = newestPersistedMarketScan(userId, connectedAccountId);
  if (!persisted || isUnusableEmptyMarketScan(persisted.scan)) return undefined;
  return NextResponse.json(
    staleMarketScanResponse(persisted.scan as MarketScan & { warnings?: string[] }, staleReason)
  );
}

// Fresh, standalone market scan for the Market Scan tab. It returns current screener,
// broker, and persisted web-signal data instead of waiting for the next strategy run.
// Slow fundamentals are reused from that run while prices refresh; deep provider work
// stays on the scheduled strategy and on-demand ticker paths. Cheap on repeat calls:
// scanMarket caches the screener (~5 min). Read-only; places nothing.
export async function GET(request: Request) {
  let userId = "local";
  let connectedAccountId: string | undefined;
  try {
    userId = resolveRequestUserId(request);
    // Per-user rate limit: read-only, but each scan fans out to several data providers, so a
    // tight refresh loop can hammer upstreams. Returns 429 with Retry-After; fails open on limiter error.
    const limited = enforceRateLimit(userId, "scan", RATE_LIMITS.scan);
    if (limited) return limited;
    const policy = getPolicy(userId);
    connectedAccountId = policy.connectedAccountId;
    // Seed from whichever kind is newer at each scope — a scheduled market_scan_freshness
    // audit (weekend/off-hours) can be fresher than the last strategy_run, and vice versa.
    const latestAccountAudit = newerAuditEntry(
      policy.connectedAccountId ? latestAuditByKind("strategy_run", userId, policy.connectedAccountId) : undefined,
      policy.connectedAccountId ? latestAuditByKind("market_scan", userId, policy.connectedAccountId) : undefined
    );
    const latestGlobalAudit = newerAuditEntry(
      latestAuditByKind("strategy_run", userId),
      latestAuditByKind("market_scan", userId)
    );
    const accountSeed = marketScanQuotesFromAudit(latestAccountAudit?.payload, latestAccountAudit?.createdAt);
    const globalSeed = marketScanQuotesFromAudit(latestGlobalAudit?.payload, latestGlobalAudit?.createdAt);
    // Prefer the durable shared symbol_field_latest store (per-field as_of + fetched_at) over
    // audit payloads. strategy_run audits deliberately omit the full MarketScan; whole-object
    // `{...global, ...account}` would also wipe rich seeds with blank interactive scans.
    // scanMarket always reloads the store for the preselection pool; pass audit seeds only as
    // an extra field-level layer when they still carry quotesBySymbol.
    const { mergeQuoteSeedsFieldLevel } = await import("@/lib/market");
    const seedEnrichment = mergeQuoteSeedsFieldLevel(globalSeed, accountSeed);
    const symbols = allowedSymbolsForPolicy(policy);
    const gateway = getBrokerGateway(policy, userId);
    let positions: EquityPosition[] = [];
    if (policy.accountNumber) {
      try {
        positions = await gateway.getEquityPositions(policy.accountNumber);
      } catch {
        positions = [];
      }
    }
    // Interactive scans are quote/screener refreshes, not deep-ingestion jobs. The
    // fully enriched strategy scan supplies slow facts locally, while this path avoids
    // enqueueing hundreds of paced fundamentals calls. Coalesce identical page-mount/
    // manual-refresh requests so retries cannot multiply work.
    const dynamicUniverses = dynamicIndexUniversesForPolicy(policy);
    const scanKey = interactiveScanKey({
      userId,
      accountNumber: policy.accountNumber,
      symbols,
      candidateLimit: policy.marketScanCandidateLimit,
      outlierReserve: policy.marketScanOutlierReserve,
      dynamicUniverses,
      latestRunAuditId: latestAccountAudit?.id ?? latestGlobalAudit?.id,
      scoringWeights: policy.scoringWeights,
      universeFloor: policy.universeFloor,
      positions
    });
    const base = await runScanSingleFlight(scanKey, () =>
      withScanDeadline(INTERACTIVE_SCAN_BUDGET_MS, (signal) =>
        scanMarket(symbols, positions, policy.scoringWeights, userId, dynamicUniverses, {
          candidateLimit: policy.marketScanCandidateLimit,
          outlierReserve: policy.marketScanOutlierReserve,
          universeFloor: policy.universeFloor,
          enrichmentMode: "skip",
          seedEnrichment,
          signal
        })
      )
    );
    // Merge live broker bid/ask quotes for the top candidates, matching the strategy
    // run path (mergeQuoteData) so the table's Bid/Ask and freshest prices are populated.
    let scan = base;
    if (policy.accountNumber && base.topCandidates.length > 0) {
      try {
        const quoteSymbols = Array.from(new Set(base.topCandidates.map((q) => q.symbol)));
        scan = mergeQuoteData(base, await gateway.getEquityQuotes(policy.accountNumber, quoteSymbols));
      } catch {
        scan = base;
      }
    }
    if (scan.topCandidates.length > 0) {
      try {
        const grouped = await fetchRecentGroupedBarsRest(Date.now(), userId);
        if (grouped) scan = mergeGroupedBarData(scan, grouped.bars);
      } catch {
        // VWAP is additive only; keep the scan available when the grouped feed is absent.
      }
    }
    try {
      audit("market_scan", { scan }, userId, policy.connectedAccountId);
    } catch {
      /* audit is diagnostic only */
    }
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "scan failed";
    console.warn("[api/scan] market scan failed", message);
    try {
      audit(
        "market_scan_failed",
        isScanQuotesUnavailableError(error)
          ? {
              message,
              code: error.code,
              scannedSymbols: error.scannedSymbols,
              returnedQuotes: error.returnedQuotes,
              warnings: error.warnings
            }
          : { message },
        userId,
        connectedAccountId
      );
    } catch {
      /* audit is diagnostic only */
    }
    const stale = lastGoodScanResponse(userId, connectedAccountId, message);
    if (stale) return stale;
    if (isScanQuotesUnavailableError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          scannedSymbols: error.scannedSymbols,
          returnedQuotes: error.returnedQuotes,
          warnings: error.warnings,
          topCandidates: []
        },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
