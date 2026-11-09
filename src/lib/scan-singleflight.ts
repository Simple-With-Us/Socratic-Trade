import { previousTradingDayStart } from "./market-hours";
import type {
  EquityPosition,
  IndexUniverse,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights,
  UniverseFloor
} from "./types";

/**
 * Coalesce identical interactive refreshes. A page mount and a quick manual retry
 * must share one upstream scan instead of multiplying provider work.
 */
const activeScans = new Map<string, Promise<MarketScan>>();

export function interactiveScanKey(input: {
  userId: string;
  accountNumber?: string;
  symbols: string[];
  candidateLimit?: number;
  outlierReserve?: number;
  dynamicUniverses: IndexUniverse[];
  latestRunAuditId?: string;
  scoringWeights: ScoringWeights;
  universeFloor?: UniverseFloor;
  positions: EquityPosition[];
}): string {
  const positions = input.positions
    .map((position) => ({
      symbol: position.symbol.trim().toUpperCase(),
      marketValue: position.marketValue,
      sector: position.sector ?? "",
      industry: position.industry ?? ""
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return JSON.stringify({
    userId: input.userId,
    accountNumber: input.accountNumber ?? "",
    symbols: [...input.symbols].sort(),
    candidateLimit: input.candidateLimit,
    outlierReserve: input.outlierReserve,
    dynamicUniverses: [...input.dynamicUniverses].sort(),
    latestRunAuditId: input.latestRunAuditId ?? "",
    scoringWeights: input.scoringWeights,
    universeFloor: input.universeFloor,
    positions
  });
}

export async function withScanDeadline<T>(
  budgetMs: number,
  factory: (signal: AbortSignal) => Promise<T>,
  deadlineMessage = "Interactive market scan deadline exceeded."
): Promise<T> {
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const deadlineError = new Error(deadlineMessage);
    const timeout = setTimeout(() => {
      controller.abort(deadlineError);
      reject(deadlineError);
    }, Math.max(1, budgetMs));
    timeout.unref?.();
    void Promise.resolve()
      .then(() => factory(controller.signal))
      .then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
  });
}

export function runScanSingleFlight(
  key: string,
  factory: () => Promise<MarketScan>
): Promise<MarketScan> {
  const existing = activeScans.get(key);
  if (existing) return existing;

  const pending = Promise.resolve().then(factory);
  activeScans.set(key, pending);
  const clear = () => {
    if (activeScans.get(key) === pending) activeScans.delete(key);
  };
  // Attach both handlers to the original promise. `finally()` would create a
  // rejected child promise that nobody observes when the scan fails.
  void pending.then(clear, clear);
  return pending;
}

export function resetScanSingleFlightForTests(): void {
  activeScans.clear();
}

/** Last-good scan served after a failed or timed-out refresh.  `generatedAt` stays the
 *  last successful scan's stamp so a stale response is not mistaken for a new one. */
export function staleMarketScanResponse<T extends { generatedAt?: string; warnings?: string[] }>(
  scan: T,
  staleReason: string
): T & { stale: true; staleReason: string; generatedAt: string; warnings: string[] } {
  const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  const reason = staleReason.trim() || "Market scan refresh failed.";
  return {
    ...scan,
    stale: true,
    staleReason: reason,
    generatedAt: scan.generatedAt ?? new Date(0).toISOString(),
    warnings: warnings.includes(reason) ? warnings : [...warnings, reason]
  };
}

/** Zero-quote abort/empty rows written as `market_scan` (prod d0359642) are
 *  not last-good.  A 505-symbol universe with 0 quotes is a quote miss, not
 *  an empty universe and not a ranker-zero day. */
export function isUnusableEmptyMarketScan(scan: {
  topCandidates?: unknown;
  returnedQuotes?: unknown;
  scannedSymbols?: unknown;
  quotesBySymbol?: unknown;
} | null | undefined): boolean {
  if (!scan) return false;
  const scanned = typeof scan.scannedSymbols === "number" ? scan.scannedSymbols : 0;
  const quoted =
    typeof scan.returnedQuotes === "number"
      ? scan.returnedQuotes
      : scan.quotesBySymbol && typeof scan.quotesBySymbol === "object" && !Array.isArray(scan.quotesBySymbol)
        ? Object.keys(scan.quotesBySymbol).length
        : 0;
  const candidates = Array.isArray(scan.topCandidates) ? scan.topCandidates.length : 0;
  return scanned > 0 && quoted === 0 && candidates === 0;
}

/**
 * Read the full per-symbol quote map from a persisted market-scan-bearing audit without
 * trusting an older compact prompt snapshot or a malformed audit payload. Accepts either
 * payload shape in the wild: a `strategy_run` audit nests it at `.marketScan`; the scheduled/
 * interactive `market_scan` audit kind nests it at `.scan` (see market-scan-freshness.ts and
 * app/api/scan/route.ts) — both are the same MarketScan on disk, just written by different
 * callers, so a caller comparing freshness across both kinds doesn't need to know which one won.
 */
export function marketScanQuotesFromAudit(
  payload: unknown,
  createdAt?: string,
  now = Date.now()
): Record<string, MarketQuoteSummary> | undefined {
  const timestamp = Date.parse(createdAt ?? "");
  // Calendar-aware, not a flat 24h window: a seed is acceptable back through the START of the
  // most recent trading day (same rule as isStaleBaseline in app/console/lib/derive.ts), so
  // Friday's run stays a valid seed all weekend and expires only once Tuesday's session starts —
  // a flat 24h cutoff would reject Friday's data by Monday afternoon even though nothing has
  // traded since.
  const earliestAcceptable = previousTradingDayStart(new Date(now)).getTime();
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || timestamp < earliestAcceptable) {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const marketScan = (payload as { marketScan?: unknown; scan?: unknown }).marketScan
    ?? (payload as { scan?: unknown }).scan;
  if (!marketScan || typeof marketScan !== "object") return undefined;
  const quotes = (marketScan as { quotesBySymbol?: unknown }).quotesBySymbol;
  if (!quotes || typeof quotes !== "object" || Array.isArray(quotes)) return undefined;

  const entries = Object.entries(quotes);
  if (entries.length === 0) return undefined;
  const validEntries = entries.filter(([symbol, value]) => {
    if (!symbol || !value || typeof value !== "object" || Array.isArray(value)) return false;
    const quote = value as { symbol?: unknown; price?: unknown; score?: unknown };
    return quote.symbol === symbol
      && typeof quote.price === "number"
      && Number.isFinite(quote.price)
      && typeof quote.score === "number"
      && Number.isFinite(quote.score);
  });
  if (validEntries.length === 0) return undefined;
  // Keep valid rows.  One bad entry in a 5k-name map must not void the seed
  // that Refresh needs when Nasdaq/Yahoo miss the interactive budget.
  if (validEntries.length === entries.length) return quotes as Record<string, MarketQuoteSummary>;
  return Object.fromEntries(validEntries) as Record<string, MarketQuoteSummary>;
}
