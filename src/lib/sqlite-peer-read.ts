// Peer market-read SQLite helpers (ST-4602 / SOCRATIC-TRADE-35).
//
// Congress.Trade cache-aside pulls hit GET /api/market/prices/* and related routes while the
// serving process is writing (scheduler, ingest, litestream checkpoints). DEFERRED read-then-write
// transactions upgrade a stale WAL snapshot to SQLITE_BUSY_SNAPSHOT instantly — busy_timeout never
// runs — so a best-effort audit or history-cache upsert on the read path could 500 the peer.
//
// Policy:
//   - Required reads: short yield-retry budget, then propagate SQLITE_BUSY to the route → 503 + Retry-After.
//   - Best-effort writes on read paths: swallow SQLITE_BUSY; never fail the price envelope.

import { NextResponse } from "next/server";
import { audit } from "./db";
import {
  SQLITE_BUSY_RETRY_BUDGET_MS,
  isSqliteBusy,
  sqliteYieldRetry
} from "./sqlite-event-loop";
import { yieldEventLoop } from "./slow-sync-guard";

/** Lock-wait budget for congress.trade peer pulls (fail fast → 503 + Retry-After). */
export const PEER_READ_SQLITE_RETRY_BUDGET_MS = 4_000;

/** Retry-After on peer-read 503 when SQLite contention persists after the budget. */
export const PEER_READ_SQLITE_RETRY_AFTER_SECONDS = 2;

export { isSqliteBusy };

export function isPeerReadUsageLabel(usageLabel: string | undefined): boolean {
  return usageLabel === "congress-read";
}

/**
 * Run a sync sqlite call for a peer read: yield-retry with the shorter peer budget.
 * Only use from async call sites (e.g. fetchDailyOHLC on the congress-read label).
 */
export async function peerReadSqliteRetry<T>(fn: () => T): Promise<T> {
  return sqliteYieldRetry(fn, PEER_READ_SQLITE_RETRY_BUDGET_MS);
}

/** For route handlers whose work includes awaited sqlite retries inside fetchDailyOHLC. */
export async function peerReadRouteSqliteRetry<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + PEER_READ_SQLITE_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      await yieldEventLoop();
    }
  }
}

/** Swallow SQLITE_BUSY on optional persistence during a read path; rethrow everything else. */
export function bestEffortSqliteWrite(work: () => void, context = "peer-read"): void {
  try {
    work();
  } catch (err) {
    if (isSqliteBusy(err)) {
      console.warn(`[${context}] sqlite write skipped (database locked)`);
      return;
    }
    throw err;
  }
}

/** Audit helper for token rejections and similar — must not 401-fail because audit is locked. */
export function bestEffortAudit(kind: string, payload: unknown, userId = "local", connectedAccountId?: string): void {
  bestEffortSqliteWrite(() => audit(kind, payload, userId, connectedAccountId), "peer-read-audit");
}

/** Standard 503 for peer market reads when required sqlite work is still locked after retry. */
export function peerReadSqliteContentionResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "database temporarily unavailable" },
    {
      status: 503,
      headers: {
        "retry-after": String(PEER_READ_SQLITE_RETRY_AFTER_SECONDS)
      }
    }
  );
}

/** Re-export for tests that need the default long budget on non-peer paths. */
export const DEFAULT_SQLITE_YIELD_RETRY_BUDGET_MS = SQLITE_BUSY_RETRY_BUDGET_MS;
