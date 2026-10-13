// market-scan-freshness.ts — scheduler lane guaranteeing Market Scan data is refreshed at
// least every MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS, including over weekends when no strategy
// run fires (isRunAllowedNow/isTradingDay block trading on non-trading days, and scanMarket
// otherwise has no scheduled caller — see docs/rollouts/2026-08-01-data-cascade-freshness-handoff.md).
//
// This is a DATA-FRESHNESS lane, not a trading lane: it deliberately does NOT pass through
// isRunAllowedNow/isTradingDay, never places an order, and never invokes the LLM — it only
// calls scanMarket (a read-only screener/enrichment fetch) and persists the result under the
// `market_scan` audit kind (the same kind app/api/scan/route.ts already writes on an
// interactive refresh; dashboard.ts already reads the newer of `market_scan` and
// `strategy_run` — see fullMarketScan/`latestScan` there).
//
// Runs for every listUsers() id.  Hardcoding "local" left signed-in market_scan rows
// stuck while the scheduler tick itself stayed green.  Not gated on market hours.
//
// Cost posture: on a trading day, run the full enrichment scan (fundamentals are still worth
// refreshing). On a non-trading day, run in `enrichmentMode: "skip"` seeded from the newest
// persisted scan's quotesBySymbol — a keyless price/breadth refresh that burns no keyed
// provider quota, mirroring the interactive /api/scan path.
import { audit, getPolicy, latestAuditByKind, listUsers, newerAuditEntry, type AuditEventRow, latestAuditStampByKind } from "./db";
import { dynamicIndexUniversesForPolicy } from "./index-universes";
import { isTradingDay } from "./market-calendar";
import { scanMarket } from "./market";
import { allowedSymbolsForPolicy } from "./policy";
import { interactiveScanKey, isUnusableEmptyMarketScan, marketScanQuotesFromAudit, runScanSingleFlight, withScanDeadline } from "./scan-singleflight";
import type { MarketScan } from "./types";

const DEFAULT_MAX_AGE_HOURS = 20;

/** `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS` env knob: how stale the newest persisted scan may get
 *  before this lane refreshes it. `0` disables the lane entirely. Unset/invalid falls back to
 *  the 20h default (comfortably inside a ~60h Friday-close-to-Monday-open weekend gap). */
export function marketScanFreshnessMaxAgeHours(): number {
  const raw = process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_AGE_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
}

/**
 * True when `candidate` has the shape of a real, usable MarketScan — as opposed to a
 * `BoundedMarketScanSummary` (audit-bounded-run.ts's `{ omitted: true, ... }` compaction that
 * EVERY `strategy_run` audit stores in place of the full scan since 2026-08-01, or any other
 * malformed/partial audit payload). Checks the fields this lane and its callers actually read
 * (`withLastGoodWarning`'s `scan.warnings` spread, `refreshTopCandidateQuotes`'s
 * `scan.topCandidates`) — a payload missing any of them is not a scan this lane can safely hand
 * back as "the last completed scan".
 */
function isUsableMarketScan(candidate: unknown): candidate is MarketScan {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Record<string, unknown>;
  // The bounded-audit marker (audit-bounded-run.ts) — an omitted:true summary is NEVER a usable
  // last-good scan, even though it happens to also carry `source`/`generatedAt`/etc.
  if (c.omitted === true) return false;
  return (
    typeof c.source === "string" &&
    typeof c.generatedAt === "string" &&
    typeof c.scannedSymbols === "number" &&
    typeof c.returnedQuotes === "number" &&
    Array.isArray(c.topCandidates) &&
    Boolean(c.sectorBySymbol) && typeof c.sectorBySymbol === "object" &&
    Boolean(c.quotesBySymbol) && typeof c.quotesBySymbol === "object"
  );
}

function extractScan(payload: unknown): MarketScan | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const scan = (payload as { scan?: unknown }).scan ?? (payload as { marketScan?: unknown }).marketScan;
  if (!isUsableMarketScan(scan)) return undefined;
  // `warnings` is required on MarketScan but some genuinely-usable older persisted rows (pre-dates
  // the field, or a partial write) still lack it — default rather than reject, and default HERE
  // (not just at the `withLastGoodWarning` spread site) so every caller of `extractScan` /
  // `newestPersistedMarketScan` gets a scan whose `warnings` is always a real array.
  return Array.isArray(scan.warnings) ? scan : { ...scan, warnings: [] };
}

/**
 * The newest persisted MarketScan across BOTH audit kinds that can carry one — a scheduled/
 * interactive `market_scan` audit (payload `{ scan }`) and a `strategy_run` audit's embedded
 * `result.marketScan` — account-scoped preferred, falling back to user-wide (mirrors the
 * lookup dashboard.ts already does for `snapshot.latestScan`). Compares the two kinds' latest
 * rows independently rather than picking "whichever audit row is newest, period": a strategy_run
 * that skipped (e.g. kill switch) is still the newer AUDIT ROW but carries no marketScan, and
 * must not mask an older-but-still-usable market_scan. Returns undefined only when NEITHER kind
 * has ever produced a usable scan payload.
 */
export function newestPersistedMarketScan(
  userId: string,
  connectedAccountId?: string
): { scan: MarketScan; entry: AuditEventRow } | undefined {
  const scanAudit = (connectedAccountId ? latestAuditByKind("market_scan", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("market_scan", userId);
  const runAudit = (connectedAccountId ? latestAuditByKind("strategy_run", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("strategy_run", userId);

  const fromScan = scanAudit && extractScan(scanAudit.payload) ? { scan: extractScan(scanAudit.payload)!, entry: scanAudit } : undefined;
  const fromRun = runAudit && extractScan(runAudit.payload) ? { scan: extractScan(runAudit.payload)!, entry: runAudit } : undefined;
  if (!fromScan) return fromRun;
  if (!fromRun) return fromScan;
  return newerAuditEntry(fromScan.entry, fromRun.entry) === fromRun.entry ? fromRun : fromScan;
}

/** Deterministic single-flight key for this lane's own scan, stable across repeated calls with
 *  the same policy/universe so a lane invocation still in flight (audit not yet persisted) never
 *  causes a second tick to kick off a duplicate scanMarket call — see runScanSingleFlight. */
function freshnessScanKey(userId: string, policy: ReturnType<typeof getPolicy>, symbols: string[], dynamicUniverses: ReturnType<typeof dynamicIndexUniversesForPolicy>): string {
  return interactiveScanKey({
    userId,
    accountNumber: policy.accountNumber,
    symbols,
    candidateLimit: policy.marketScanCandidateLimit,
    outlierReserve: policy.marketScanOutlierReserve,
    dynamicUniverses,
    scoringWeights: policy.scoringWeights,
    universeFloor: policy.universeFloor,
    // No broker call in this lane (see module comment) — positions are always empty, which also
    // keeps this key stable across ticks instead of chasing a live portfolio it never fetches.
    positions: []
  });
}

/**
 * Scheduler entry point: refresh the persisted Market Scan when it has gone stale, independent
 * of trading gates. Self-guarded — never throws into the tick.
 */
/** Serve HTTP before grinding: the scheduler's first tick fires at boot+ε, and this lane running
 *  a cold full scan on that tick was the 2026-08-02 prod wedge. Enforced at the scheduler call
 *  site (which passes process.uptime()); unit callers omit the arg and are exempt. */
export const FRESHNESS_BOOT_GRACE_SECONDS = 300;
/** Hard ceiling on one freshness scan — a scan that cannot finish inside this is exactly the
 *  wedge shape this lane must never re-create. */
export const FRESHNESS_SCAN_DEADLINE_MS = 10 * 60_000;

/** Per-user last audit row id proven to carry a usable scan.  A single global id skipped every
 *  other user once `local` was fresh, which is why signed-in scans stopped moving. */
const lastUsableAuditRowId = new Map<string, string>();

/** Test-only (per-file temp DBs make cached row ids stale across tests). */
export function resetFreshnessGateForTests(): void {
  lastUsableAuditRowId.clear();
}

function recordScanFailure(userId: string, connectedAccountId: string | undefined, message: string): void {
  try {
    audit("market_scan_failed", { message, source: "market_scan_freshness" }, userId, connectedAccountId);
  } catch {
    /* audit is diagnostic only */
  }
}

/** One user.  Not market-hours gated: weekends still refresh in skip-enrichment mode.
 *  A usable strategy_run scan counts as fresh.  A bounded `omitted` run does not. */
async function refreshUserMarketScanIfDue(userId: string, now: number, maxAgeMs: number): Promise<"refreshed" | "failed" | "fresh"> {
  const policy = getPolicy(userId);
  const stampOf = (kind: string) =>
    latestAuditStampByKind(kind, userId, policy.connectedAccountId) ??
    latestAuditStampByKind(kind, userId);
  const scanStamp = stampOf("market_scan");
  const runStamp = stampOf("strategy_run");
  const newestStamp = !scanStamp
    ? runStamp
    : !runStamp || Date.parse(scanStamp.createdAt) >= Date.parse(runStamp.createdAt)
      ? scanStamp
      : runStamp;
  if (newestStamp && now - Date.parse(newestStamp.createdAt) < maxAgeMs) {
    if (newestStamp.id === lastUsableAuditRowId.get(userId)) return "fresh";
    const freshCheck = newestPersistedMarketScan(userId, policy.connectedAccountId);
    if (freshCheck && now - Date.parse(freshCheck.entry.createdAt) < maxAgeMs) {
      lastUsableAuditRowId.set(userId, freshCheck.entry.id);
      return "fresh";
    }
  }

  const newest = newestPersistedMarketScan(userId, policy.connectedAccountId);
  const ageMs = newest ? now - Date.parse(newest.entry.createdAt) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(ageMs) && ageMs < maxAgeMs) {
    lastUsableAuditRowId.set(userId, newest!.entry.id);
    return "fresh";
  }

  const symbols = allowedSymbolsForPolicy(policy);
  const dynamicUniverses = dynamicIndexUniversesForPolicy(policy);
  const tradingDay = isTradingDay(new Date(now));
  const seedEnrichment = !tradingDay && newest
    ? marketScanQuotesFromAudit(newest.entry.payload, newest.entry.createdAt, now)
    : undefined;

  const key = freshnessScanKey(userId, policy, symbols, dynamicUniverses);
  let scan: MarketScan;
  try {
    // withScanDeadline rejects even if a body read ignores the signal, so one hung
    // Nasdaq response cannot pin this user's singleflight for the life of the process.
    scan = await runScanSingleFlight(key, () =>
      withScanDeadline(FRESHNESS_SCAN_DEADLINE_MS, (signal) =>
        scanMarket(symbols, [], policy.scoringWeights, userId, dynamicUniverses, {
          candidateLimit: policy.marketScanCandidateLimit,
          outlierReserve: policy.marketScanOutlierReserve,
          universeFloor: policy.universeFloor,
          enrichmentMode: tradingDay ? undefined : "skip",
          seedEnrichment,
          signal,
          deadlineAt: now + FRESHNESS_SCAN_DEADLINE_MS
        }),
        "Market scan freshness deadline exceeded."
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[market-scan-freshness] ${userId}:`, message);
    recordScanFailure(userId, policy.connectedAccountId, message);
    return "failed";
  }

  if (isUnusableEmptyMarketScan(scan)) {
    recordScanFailure(userId, policy.connectedAccountId, "Scan finished with zero quotes.");
    return "failed";
  }

  try {
    audit("market_scan", { scan }, userId, policy.connectedAccountId);
  } catch (err) {
    recordScanFailure(userId, policy.connectedAccountId, err instanceof Error ? err.message : String(err));
    return "failed";
  }
  return "refreshed";
}

export async function runMarketScanFreshnessIfDue(now: number = Date.now(), uptimeSeconds?: number): Promise<void> {
  try {
    const maxAgeHours = marketScanFreshnessMaxAgeHours();
    if (maxAgeHours <= 0) return; // 0 disables the lane
    if (uptimeSeconds !== undefined && uptimeSeconds < FRESHNESS_BOOT_GRACE_SECONDS) return; // boot grace

    const maxAgeMs = maxAgeHours * 60 * 60_000;
    // Signed-in users are not "local".  Refreshing only local left their market_scan
    // row stuck (prod: last interactive/scheduled scan 2026-10-12 06:29Z) while the
    // scheduler tick itself stayed healthy.  The lane is not gated on market hours.
    const users = listUsers();
    let refreshed = 0;
    let failed = 0;
    for (const userId of users) {
      try {
        const outcome = await refreshUserMarketScanIfDue(userId, now, maxAgeMs);
        if (outcome === "refreshed") refreshed += 1;
        if (outcome === "failed") failed += 1;
      } catch (err) {
        failed += 1;
        console.error("[market-scan-freshness] error:", err instanceof Error ? err.message : err);
      }
    }
    if (refreshed > 0 || failed > 0) {
      console.info(`[market-scan-freshness] users=${users.length} refreshed=${refreshed} failed=${failed}`);
    }
  } catch (err) {
    console.error("[market-scan-freshness] error:", err instanceof Error ? err.message : err);
  }
}
