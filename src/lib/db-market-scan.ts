// db-market-scan.ts — the durable home for the LAST market scan per (user, scope).
//
// Why this table exists (ST-4641, audit F1 in docs/audits/2026-11-21-zc-backend-perf.md):
//
//   The `market_scan` audit row used to carry the FULL MarketScan — the whole-universe
//   `quotesBySymbol` map (avg 600 KB, p90 2.8 MB measured in prod).  Every interactive scan
//   AND every scheduler freshness pass wrote one, and up to four readers re-read and
//   JSON.parse'd it per request.  `audit_events` is half the production database and
//   Litestream ships every byte of it to R2.
//
//   The audit row now carries only the bounded summary (audit-bounded-run.ts's
//   `summarizeMarketScanForAudit`), so the FULL tape lives HERE instead: exactly ONE row per
//   (user, scope), upserted on every scan.  The consumers that genuinely need the whole
//   universe — the last-good fallback, the scan seed, the weekly digest — read this row; the
//   audit keeps the forensic shape (counts, source, ranked head) at a few hundred bytes.
//
// Scope: one row per (user_id, scope_key) where scope_key is the connected account id, or the
// empty string for the user-wide row.  That mirrors the audit scoping the old readers used
// (`latestAuditByKind(kind, userId, connectedAccountId) ?? latestAuditByKind(kind, userId)`):
// account-scoped preferred, user-wide as the fallback.
//
// Retention: the row is REPLACED on every scan (upsert), so the table never grows with scan
// count — it is bounded by (users × scopes).

import "server-only";
import { getDb } from "./db";
import type { MarketScan } from "./types";

/** Scope key of the user-wide row (no connected account). */
export const MARKET_SCAN_SCOPE_USER_WIDE = "";

export function marketScanScopeKey(connectedAccountId?: string | null): string {
  const trimmed = connectedAccountId?.trim();
  return trimmed ? trimmed : MARKET_SCAN_SCOPE_USER_WIDE;
}

export interface MarketScanLatestRow {
  userId: string;
  scopeKey: string;
  connectedAccountId?: string;
  /** The `market_scan` audit_events.id that produced this tape (when the writer knew it). */
  auditId?: string;
  /** scan.generatedAt — when the data itself was produced. */
  generatedAt: string;
  /** When this row was persisted (the audit row's created_at). */
  persistedAt: string;
  scan: MarketScan;
}

interface RawMarketScanLatestRow {
  user_id: string;
  scope_key: string;
  connected_account_id: string | null;
  audit_id: string | null;
  generated_at: string;
  persisted_at: string;
  payload: string;
}

function toRow(raw: RawMarketScanLatestRow): MarketScanLatestRow {
  return {
    userId: raw.user_id,
    scopeKey: raw.scope_key,
    ...(raw.connected_account_id ? { connectedAccountId: raw.connected_account_id } : {}),
    ...(raw.audit_id ? { auditId: raw.audit_id } : {}),
    generatedAt: raw.generated_at,
    persistedAt: raw.persisted_at,
    scan: JSON.parse(raw.payload) as MarketScan
  };
}

/**
 * Write (replace) the last scan for one (user, scope).  One row per scope: the previous
 * tape is overwritten, never appended to.
 *
 * The write is a diagnostic side-effect of a scan, so a failure here must NOT fail the scan
 * that produced it — callers wrap this in try/catch.
 */
export function upsertLatestMarketScan(input: {
  userId: string;
  connectedAccountId?: string | null;
  /**
   * The `market_scan` audit_events.id, when the caller already wrote the audit row.
   * Optional: the tape is written inside the SAME TRANSACTION as the audit row, and the id
   * is linked by `linkLatestMarketScanAudit` inside that transaction too.  A replaced tape
   * therefore never keeps the PREVIOUS scan's audit id: the id is cleared on the write and
   * set again by the link step in the same transaction.
   */
  auditId?: string | null;
  scan: MarketScan;
  generatedAt?: string;
  persistedAt?: string;
}): void {
  const userId = input.userId || "local";
  const scopeKey = marketScanScopeKey(input.connectedAccountId);
  const generatedAt = input.generatedAt ?? input.scan.generatedAt ?? new Date().toISOString();
  const persistedAt = input.persistedAt ?? new Date().toISOString();
  const payload = JSON.stringify(input.scan);
  getDb()
    .prepare(
      `INSERT INTO market_scan_latest
         (user_id, scope_key, connected_account_id, audit_id, generated_at, persisted_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, scope_key) DO UPDATE SET
         connected_account_id = excluded.connected_account_id,
         audit_id = excluded.audit_id,
         generated_at = excluded.generated_at,
         persisted_at = excluded.persisted_at,
         payload = excluded.payload`
    )
    .run(
      userId,
      scopeKey,
      input.connectedAccountId?.trim() ? input.connectedAccountId!.trim() : null,
      input.auditId ?? null,
      generatedAt,
      persistedAt,
      payload
    );
}

/**
 * Point the tape row at the `market_scan` audit row that announced it.  The tape is written
 * first (so a failed tape write cannot leave a successful audit behind) and the audit id is
 * linked here, afterwards.  The id lets the freshness lane's fast gate compare the tape
 * against `latestAuditStampByKind` ids.
 */
export function linkLatestMarketScanAudit(input: {
  userId: string;
  connectedAccountId?: string | null;
  auditId: string;
}): void {
  getDb()
    .prepare(
      `UPDATE market_scan_latest SET audit_id = ? WHERE user_id = ? AND scope_key = ?`
    )
    .run(input.auditId, input.userId || "local", marketScanScopeKey(input.connectedAccountId));
}

function readScope(userId: string, scopeKey: string): MarketScanLatestRow | undefined {
  const raw = getDb()
    .prepare(
      `SELECT user_id, scope_key, connected_account_id, audit_id, generated_at, persisted_at, payload
       FROM market_scan_latest
       WHERE user_id = ? AND scope_key = ?`
    )
    .get(userId, scopeKey) as RawMarketScanLatestRow | undefined;
  if (!raw) return undefined;
  try {
    return toRow(raw);
  } catch {
    return undefined; // corrupt payload — treat as absent rather than throwing into a request
  }
}

/**
 * The last scan for one scope, with the account-scoped row preferred and a user-wide
 * fallback.  Mirrors the audit lookup the old readers used:
 * `latestAuditByKind(kind, userId, connectedAccountId) ?? latestAuditByKind(kind, userId)`.
 *
 * The fallback is "the user's newest row at ANY scope", not just the user-wide row: the old
 * `latestAuditByKind(kind, userId)` had no account filter at all, so a user whose scans are
 * all account-scoped still got a last-good tape.  Keeping that shape means the last-good
 * fallback and the scan seed behave exactly as they did before ST-4641.
 */
export function getLatestMarketScanRow(
  userId: string,
  connectedAccountId?: string | null
): MarketScanLatestRow | undefined {
  const scopeKey = marketScanScopeKey(connectedAccountId);
  if (scopeKey !== MARKET_SCAN_SCOPE_USER_WIDE) {
    const scoped = readScope(userId, scopeKey);
    if (scoped) return scoped;
  }
  return readNewestScope(userId);
}

function readNewestScope(userId: string): MarketScanLatestRow | undefined {
  const raw = getDb()
    .prepare(
      `SELECT user_id, scope_key, connected_account_id, audit_id, generated_at, persisted_at, payload
       FROM market_scan_latest
       WHERE user_id = ?
       ORDER BY persisted_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(userId) as RawMarketScanLatestRow | undefined;
  if (!raw) return undefined;
  try {
    return toRow(raw);
  } catch {
    return undefined; // corrupt payload — treat as absent rather than throwing into a request
  }
}
