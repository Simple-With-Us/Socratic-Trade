// market-scan-latest.ts — read/write the durable LAST market scan for a user.
//
// ST-4641 (audit F1 in docs/audits/2026-11-21-zc-backend-perf.md):
//
//   The `market_scan` audit row used to carry the FULL MarketScan — the whole-universe
//   `quotesBySymbol` map (avg 600 KB, p90 2.8 MB measured in prod).  Every interactive scan
//   and every scheduler freshness pass wrote one, and up to four readers re-read and
//   JSON.parse'd it per request.
//
//   The audit row now carries only the bounded summary (audit-bounded-run.ts's
//   `summarizeMarketScanForAudit`).  The FULL tape lives in the `market_scan_latest` table
//   (db-market-scan.ts): ONE row per (user, scope), upserted on every scan.
//
//   This module is the single reader every consumer shares, so the "last good scan" the
//   console shows, the seed a scan starts from, the tape the weekly digest screens and the
//   fallback a failed scan serves all resolve to the SAME row — exactly as they did when
//   they all read the same audit payload.
//
// Legacy rows: audit_events rows written before ST-4641 still carry the full tape.  When a
// user has no `market_scan_latest` row yet, the newest usable legacy audit row is read ONCE
// and backfilled into the table, so the last-good fallback survives the deploy boundary
// without every request re-parsing a multi-MB audit payload.

import { getDb, getLatestMarketScanRow, linkLatestMarketScanAudit, upsertLatestMarketScan } from "./db";
import type { AuditEventRow, MarketScanLatestRow } from "./db";
import type { MarketScan } from "./types";

/**
 * True when `candidate` has the shape of a real, usable MarketScan — as opposed to a
 * `BoundedMarketScanSummary` (audit-bounded-run.ts's `{ omitted: true, ... }` compaction that
 * EVERY `strategy_run` audit stores in place of the full scan since 2026-08-01, and every
 * `market_scan` audit stores since ST-4641), or any other malformed/partial audit payload.
 * Checks the fields the consumers actually read (`scan.warnings`, `scan.topCandidates`,
 * `scan.quotesBySymbol`, `scan.sectorBySymbol`).
 */
export function isUsableMarketScan(candidate: unknown): candidate is MarketScan {
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

/**
 * Pull a usable MarketScan out of an audit payload.  Accepts either shape in the wild: a
 * `strategy_run` audit nests it at `.marketScan`; the scheduled/interactive `market_scan`
 * audit kind nests it at `.scan`.  `warnings` is required on MarketScan but some genuinely
 * usable older persisted rows still lack it — default rather than reject, so every caller
 * gets a scan whose `warnings` is always a real array.
 */
export function extractScan(payload: unknown): MarketScan | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const scan = (payload as { scan?: unknown }).scan ?? (payload as { marketScan?: unknown }).marketScan;
  if (!isUsableMarketScan(scan)) return undefined;
  return Array.isArray(scan.warnings) ? scan : { ...scan, warnings: [] };
}

export interface PersistedMarketScan {
  scan: MarketScan;
  /** Audit-shaped view of the row, so callers that used the audit entry keep working. */
  entry: AuditEventRow;
}

function entryFromLatest(row: {
  userId: string;
  scopeKey: string;
  connectedAccountId?: string;
  auditId?: string;
  persistedAt: string;
  scan: MarketScan;
}): AuditEventRow {
  return {
    // The `market_scan` audit row that announced this tape, when the writer recorded it.
    // Callers compare this id against `latestAuditStampByKind` ids (the freshness lane's
    // fast-gate), so it MUST be the audit row id, not a synthetic string.
    id: row.auditId ?? `market_scan_latest:${row.userId}:${row.scopeKey}`,
    createdAt: row.persistedAt,
    kind: "market_scan",
    payload: { scan: row.scan },
    ...(row.connectedAccountId ? { connectedAccountId: row.connectedAccountId } : {})
  };
}

interface LegacyAuditRow {
  id: string;
  created_at: string;
  connected_account_id: string | null;
  payload: string;
}

/** Newest `market_scan` audit rows for one scope, newest first. */
function legacyAuditRows(
  userId: string,
  connectedAccountId: string | null | undefined,
  kind: "market_scan" | "strategy_run",
  limit: number
): LegacyAuditRow[] {
  const db = getDb();
  if (connectedAccountId) {
    // Exact account scope first (mirrors latestAuditByKind(kind, userId, connectedAccountId)).
    const scoped = db
      .prepare(
        `SELECT id, created_at, connected_account_id, payload FROM audit_events
         WHERE kind = ? AND user_id = ? AND connected_account_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(kind, userId, connectedAccountId, limit) as LegacyAuditRow[];
    if (scoped.length > 0) return scoped;
  }
  // No account filter (mirrors latestAuditByKind(kind, userId)).
  return db
    .prepare(
      `SELECT id, created_at, connected_account_id, payload FROM audit_events
       WHERE kind = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(kind, userId, limit) as LegacyAuditRow[];
}

/** How many legacy audit rows to inspect for a usable full tape. */
const LEGACY_ROW_SCAN_LIMIT = 3;

function legacyScanFromRows(rows: LegacyAuditRow[]): { scan: MarketScan; row: LegacyAuditRow } | undefined {
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const scan = extractScan(payload);
    if (scan) return { scan, row };
  }
  return undefined;
}

/**
 * The newest legacy `market_scan` audit row that still carries a FULL tape, backfilled into
 * the `market_scan_latest` table so the expensive parse happens once per user instead of once
 * per request.  Returns undefined when the user has no legacy tape.
 */
export function legacyMarketScanAudit(
  userId: string,
  connectedAccountId?: string
): PersistedMarketScan | undefined {
  const rows = legacyAuditRows(userId, connectedAccountId, "market_scan", LEGACY_ROW_SCAN_LIMIT);
  const found = legacyScanFromRows(rows);
  if (!found) return undefined;
  try {
    upsertLatestMarketScan({
      userId,
      connectedAccountId: found.row.connected_account_id,
      auditId: found.row.id,
      scan: found.scan,
      generatedAt: found.scan.generatedAt,
      persistedAt: found.row.created_at
    });
  } catch {
    // Backfill is best-effort: the read below still works without it.
  }
  return {
    scan: found.scan,
    entry: {
      id: found.row.id,
      createdAt: found.row.created_at,
      kind: "market_scan",
      payload: { scan: found.scan },
      ...(found.row.connected_account_id ? { connectedAccountId: found.row.connected_account_id } : {})
    }
  };
}

/**
 * The newest legacy `strategy_run` audit row that still carries a FULL tape.  Since
 * 2026-08-01 every `strategy_run` audit stores a bounded summary instead, so this returns
 * undefined in production — it exists for the pre-2026-08-01 rows.
 */
export function legacyStrategyRunAudit(
  userId: string,
  connectedAccountId?: string
): PersistedMarketScan | undefined {
  const rows = legacyAuditRows(userId, connectedAccountId, "strategy_run", LEGACY_ROW_SCAN_LIMIT);
  const found = legacyScanFromRows(rows);
  if (!found) return undefined;
  return {
    scan: found.scan,
    entry: {
      id: found.row.id,
      createdAt: found.row.created_at,
      kind: "strategy_run",
      payload: { marketScan: found.scan },
      ...(found.row.connected_account_id ? { connectedAccountId: found.row.connected_account_id } : {})
    }
  };
}

/**
 * The durable tape row for one scope (table only — no legacy fallback).
 */
export function getPersistedMarketScanRow(
  userId: string,
  connectedAccountId?: string
): MarketScanLatestRow | undefined {
  return getLatestMarketScanRow(userId, connectedAccountId);
}

/** Audit-shaped view of a durable tape row. */
export function persistedMarketScanFromRow(row: {
  userId: string;
  scopeKey: string;
  connectedAccountId?: string;
  auditId?: string;
  persistedAt: string;
  scan: MarketScan;
}): PersistedMarketScan {
  return { scan: row.scan, entry: entryFromLatest(row) };
}

/**
 * The newest persisted MarketScan for a user, from the durable `market_scan_latest` row.
 *
 * Reads the table first.  When the user has no row yet (the deploy boundary, before their
 * next scan), it falls back to the newest legacy `market_scan` audit rows that still carry a
 * full tape and BACKFILLS that tape into the table.
 */
export function latestPersistedMarketScan(
  userId: string,
  connectedAccountId?: string
): PersistedMarketScan | undefined {
  const latest = getLatestMarketScanRow(userId, connectedAccountId);
  if (latest && isUsableMarketScan(latest.scan)) {
    return { scan: latest.scan, entry: entryFromLatest(latest) };
  }
  return legacyMarketScanAudit(userId, connectedAccountId);
}

/**
 * Persist the full tape for one scope, then announce it with the BOUNDED `market_scan` audit
 * row.
 *
 * ORDER MATTERS: the tape is written FIRST and the audit row SECOND.  `recentFailureForUser`
 * (market-scan-freshness.ts) reads the newest `market_scan` audit row to decide that a quote
 * outage has ended, so a successful audit with a failed tape write behind it would suppress
 * the outage de-duplication and log a fresh `market_scan_failed` row on every tick.  Writing
 * the tape first means a failed tape leaves NO successful audit behind.
 *
 * The audit id is linked back onto the tape row afterwards, so the freshness lane's fast gate
 * can compare the tape against `latestAuditStampByKind` ids.
 */
export function persistLatestMarketScan(input: {
  userId: string;
  connectedAccountId?: string;
  scan: MarketScan;
  /** Writes the BOUNDED `market_scan` audit row and returns its id. */
  writeAudit: () => string;
}): string {
  upsertLatestMarketScan({
    userId: input.userId,
    connectedAccountId: input.connectedAccountId,
    scan: input.scan,
    generatedAt: input.scan.generatedAt
  });
  const auditId = input.writeAudit();
  linkLatestMarketScanAudit({
    userId: input.userId,
    connectedAccountId: input.connectedAccountId,
    auditId
  });
  return auditId;
}
