// db-execution.ts — DAILY_RESET_TIME_ZONE, daily stats, day-trade counting,
// run lock (acquireStrategyLock / releaseStrategyLock), strategy runs.
import { getDb } from "./db";
import type { StrategyRunRow } from "./types";

/**
 * IANA timezone whose civil midnight defines the daily-notional reset boundary. Made explicit so the
 * daily cap resets deterministically regardless of the server process's local TZ — the old
 * `setHours(0,0,0,0)` silently used `process.env.TZ`. US equities trade on the NYSE calendar, so the
 * market day (America/New_York) is the natural boundary. (T13)
 */
export const DAILY_RESET_TIME_ZONE = "America/New_York";

/** UTC instant of civil midnight, in `timeZone`, for the calendar day containing `now`. (T13) */
export function startOfDayInTimeZone(now: Date, timeZone: string = DAILY_RESET_TIME_ZONE): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour); // some engines render midnight as "24"
  const wallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  const offsetMs = wallAsUTC - now.getTime(); // how far the tz wall-clock leads UTC at `now`
  const midnightWallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  return new Date(midnightWallAsUTC - offsetMs);
}

/**
 * Scope key for an account. A missing/blank account number maps to an explicit sentinel so
 * the "unassigned" bucket is consistent between writes and reads, rather than relying on the
 * `account_number` column's empty-string DEFAULT (which can silently merge contexts). (T14)
 */
export function scopeAccount(accountNumber?: string | null): string {
  return accountNumber && accountNumber.trim() !== "" ? accountNumber : "__unassigned__";
}

export function dailyExecutionStats(
  accountNumber: string,
  now = new Date(),
  userId: string = "local",
  timeZone: string = DAILY_RESET_TIME_ZONE
): { orderCount: number; openingOrderCount: number; notional: number } {
  const dayStart = startOfDayInTimeZone(now, timeZone);
  // Phase 2 fix: use persisted estimated_notional so share-qty market orders
  // (which have no limitPrice) count correctly against the daily cap.
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE created_at >= ? AND account_number = ? AND user_id = ? AND status IN ('placed', 'paper')"
    )
    .all(dayStart.toISOString(), scopeAccount(accountNumber), userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      // NB: "opening" = buy OR short. (Named isBuy historically; it always included short.)
      const isOpening = proposal.side === "buy" || proposal.side === "short";
      // Notional caps intentionally count only OPENING trades (buy/short); closing trades (sell/cover) are risk-reducing and exempt (notional = 0).
      // Prefer the persisted estimated_notional; fall back to proposal fields for old rows.
      const notional = isOpening
        ? (row.estimated_notional != null
            ? row.estimated_notional
            : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
      return {
        orderCount: acc.orderCount + 1,
        openingOrderCount: acc.openingOrderCount + (isOpening ? 1 : 0),
        notional: acc.notional + notional
      };
    },
    { orderCount: 0, openingOrderCount: 0, notional: 0 }
  );
}

/**
 * Order notional executed within a rolling window of `minutes` (R1 hourly cap). Mirrors
 * dailyExecutionStats but on an arbitrary lookback rather than the calendar day.
 */
export function notionalInLastMinutes(accountNumber: string, minutes: number, now = new Date(), userId: string = "local"): { orderCount: number; openingOrderCount: number; notional: number } {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE created_at >= ? AND account_number = ? AND user_id = ? AND status IN ('placed', 'paper')"
    )
    .all(cutoff.toISOString(), scopeAccount(accountNumber), userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      // NB: "opening" = buy OR short. (Named isBuy historically; it always included short.)
      const isOpening = proposal.side === "buy" || proposal.side === "short";
      // Notional caps intentionally count only OPENING trades (buy/short); closing trades (sell/cover) are risk-reducing and exempt (notional = 0).
      const notional = isOpening
        ? (row.estimated_notional != null ? row.estimated_notional : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
      return {
        orderCount: acc.orderCount + 1,
        openingOrderCount: acc.openingOrderCount + (isOpening ? 1 : 0),
        notional: acc.notional + notional
      };
    },
    { orderCount: 0, openingOrderCount: 0, notional: 0 }
  );
}

/**
 * Count day-trades for an account over a rolling N-business-day window ending at `asOf` (PDT gate).
 *
 * Regulatory definition (FINRA Rule 4210 pattern-day-trader): a day-trade is a same-symbol
 * round-trip OPENED and CLOSED on the same calendar day. We detect this from `fill_events`:
 * group fills by symbol + market-calendar day (the America/New_York day, matching the
 * daily-notional boundary), and count a day-trade when that symbol+day has BOTH an opening fill
 * (side buy or short) AND a closing fill (side sell or cover). The PDT rule counts at most one
 * day-trade per symbol per day for this purpose, so each qualifying symbol+day bucket contributes
 * exactly one. The window is the last `businessDays` market days (weekdays) ending at `asOf`'s
 * market day, inclusive; weekend days carry no fills and are skipped.
 */
export function countDayTradesInLastBusinessDays(
  accountNumber: string,
  businessDays: number,
  asOf: Date = new Date(),
  userId: string = "local",
  timeZone: string = DAILY_RESET_TIME_ZONE
): number {
  if (businessDays <= 0) return 0;
  // Walk back from asOf's market day, collecting business days (Mon–Fri) until we have N of them.
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = startOfDayInTimeZone(asOf, timeZone);
  let collected = 0;
  let windowStart = cursor;
  while (collected < businessDays) {
    // getUTCDay() on a civil-midnight instant identifies the market day's weekday: 0=Sun, 6=Sat.
    const weekday = startOfDayInTimeZone(cursor, timeZone).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      collected += 1;
      windowStart = cursor;
    }
    // Step back ~one day, then re-snap to the market-day boundary to stay DST-safe.
    cursor = startOfDayInTimeZone(new Date(cursor.getTime() - dayMs), timeZone);
  }

  const rows = getDb()
    .prepare(
      "SELECT symbol, side, filled_at FROM fill_events WHERE filled_at >= ? AND filled_at <= ? AND account_number = ? AND user_id = ?"
    )
    .all(windowStart.toISOString(), asOf.toISOString(), scopeAccount(accountNumber), userId) as Array<{
    symbol: string;
    side: string;
    filled_at: string;
  }>;

  // Bucket by symbol + market-calendar day; track whether each bucket saw an open and a close.
  const buckets = new Map<string, { opened: boolean; closed: boolean }>();
  for (const row of rows) {
    const marketDay = startOfDayInTimeZone(new Date(row.filled_at), timeZone).toISOString();
    const key = `${row.symbol}__${marketDay}`;
    const bucket = buckets.get(key) ?? { opened: false, closed: false };
    if (row.side === "buy" || row.side === "short") bucket.opened = true;
    if (row.side === "sell" || row.side === "cover") bucket.closed = true;
    buckets.set(key, bucket);
  }

  let dayTrades = 0;
  for (const bucket of buckets.values()) {
    if (bucket.opened && bucket.closed) dayTrades += 1;
  }
  return dayTrades;
}

// ── Run lock ──────────────────────────────────────────────────────────────────
// Uses a direct prepared statement (not setSetting) to avoid noisy policy_change
// audit events.

/** Lock key — per-account when an account id is given, else the legacy user-wide key. */
function strategyLockKey(userId: string, connectedAccountId?: string): string {
  return connectedAccountId ? `strategy_run_lock:${userId}:${connectedAccountId}` : `strategy_run_lock:${userId}`;
}

export function acquireStrategyLock(userId: string = "local", connectedAccountId?: string, staleMs = 5 * 60_000, now = new Date()): boolean {
  const database = getDb();
  const key = strategyLockKey(userId, connectedAccountId);
  const acquire = database.transaction(() => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    if (row) {
      try {
        const { lockedAt } = JSON.parse(row.value) as { lockedAt: string };
        const age = now.getTime() - new Date(lockedAt).getTime();
        if (age < staleMs) return false; // lock is still live
      } catch {
        // malformed lock value — treat as absent and reclaim
      }
    }

    const value = JSON.stringify({ lockedAt: now.toISOString() });
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, value, now.toISOString());
    return true;
  });

  return acquire.immediate() as boolean;
}

export function releaseStrategyLock(userId: string = "local", connectedAccountId?: string): void {
  if (connectedAccountId) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(strategyLockKey(userId, connectedAccountId));
    return;
  }
  // No account given: release the user's base lock AND any per-account locks (teardown/back-compat).
  getDb()
    .prepare("DELETE FROM settings WHERE key = ? OR key LIKE ?")
    .run(`strategy_run_lock:${userId}`, `strategy_run_lock:${userId}:%`);
}

export function insertStrategyRun(id: string, userId: string = "local", connectedAccountId?: string): void {
  getDb()
    .prepare("INSERT INTO strategy_runs (id, user_id, connected_account_id, started_at, status) VALUES (?, ?, ?, ?, 'running')")
    .run(id, userId, connectedAccountId ?? null, new Date().toISOString());
}

export function finishStrategyRun(id: string, status: "completed" | "failed", summary: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE strategy_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ? AND user_id = ?")
    .run(new Date().toISOString(), status, summary, id, userId);
}

/**
 * Most recent strategy-run start time for a user (ISO string), or null if none. The scheduler
 * rehydrates its in-memory cadence clock from this on boot so a restart/HMR/deploy doesn't fire an
 * immediate run regardless of the configured cadence (userSchedules starts empty each process).
 */
export function getLastStrategyRunStartedAt(userId: string = "local", connectedAccountId?: string): string | null {
  const row = (connectedAccountId
    ? getDb()
        .prepare("SELECT MAX(started_at) AS last FROM strategy_runs WHERE user_id = ? AND connected_account_id = ?")
        .get(userId, connectedAccountId)
    : getDb()
        .prepare("SELECT MAX(started_at) AS last FROM strategy_runs WHERE user_id = ?")
        .get(userId)) as { last: string | null } | undefined;
  return row?.last ?? null;
}

export function listStrategyRuns(limit = 20, userId: string = "local", connectedAccountId?: string): StrategyRunRow[] {
  type RawRow = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
    total_count: number;
  };

  const selectSql = `SELECT
        sr.id,
        sr.started_at,
        sr.finished_at,
        sr.status,
        sr.summary,
        sr.connected_account_id,
        COUNT(CASE WHEN tp.status = 'placed'   THEN 1 END) AS placed_count,
        COUNT(CASE WHEN tp.status = 'paper'    THEN 1 END) AS paper_count,
        COUNT(CASE WHEN tp.status = 'blocked'  THEN 1 END) AS blocked_count,
        COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count,
        COUNT(tp.id)                                        AS total_count
       FROM strategy_runs sr
       LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
       WHERE sr.user_id = ?${connectedAccountId ? " AND sr.connected_account_id = ?" : ""}
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`;
  const rows = getDb()
    .prepare(selectSql)
    .all(...(connectedAccountId ? [userId, connectedAccountId, limit] : [userId, limit])) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    status: r.status as StrategyRunRow["status"],
    summary: r.summary ?? undefined,
    connectedAccountId: r.connected_account_id ?? undefined,
    placedCount: r.placed_count,
    paperCount: r.paper_count,
    blockedCount: r.blocked_count,
    proposedCount: r.proposed_count,
    totalCount: r.total_count
  }));
}

export function getStrategyRunById(id: string, userId: string = "local"): StrategyRunRow | undefined {
  type RawRow = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
    total_count: number;
  };
  const row = getDb()
    .prepare(
      `SELECT sr.id, sr.started_at, sr.finished_at, sr.status, sr.summary, sr.connected_account_id,
              COUNT(CASE WHEN tp.status = 'placed'   THEN 1 END) AS placed_count,
              COUNT(CASE WHEN tp.status = 'paper'    THEN 1 END) AS paper_count,
              COUNT(CASE WHEN tp.status = 'blocked'  THEN 1 END) AS blocked_count,
              COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count,
              COUNT(tp.id)                                        AS total_count
         FROM strategy_runs sr
         LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
        WHERE sr.id = ? AND sr.user_id = ?
        GROUP BY sr.id`
    )
    .get(id, userId) as RawRow | undefined;

  return row
    ? {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? undefined,
        status: row.status as StrategyRunRow["status"],
        summary: row.summary ?? undefined,
        connectedAccountId: row.connected_account_id ?? undefined,
        placedCount: row.placed_count,
        paperCount: row.paper_count,
        blockedCount: row.blocked_count,
        proposedCount: row.proposed_count,
        totalCount: row.total_count
      }
    : undefined;
}
