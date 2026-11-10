// db-trade-locks.ts — CRUD for scoped, expiring trade locks (migration 79).
import "server-only";
import { getDb } from "./db";
import {
  lockCoversQuery,
  type TradeLockScope,
  type TradeLockSide,
  type TradeLockTrigger
} from "./trade-locks";

export interface TradeLockRow {
  id: string;
  userId: string;
  connectedAccountId: string;
  scope: TradeLockScope;
  symbol: string | null;
  side: TradeLockSide;
  reason: string;
  trigger: TradeLockTrigger;
  createdAt: string;
  until: string;
  active: boolean;
}

function rowFromDb(row: {
  id: string;
  user_id: string;
  connected_account_id: string;
  scope: string;
  symbol: string | null;
  side: string;
  reason: string;
  trigger: string;
  created_at: string;
  until: string;
  active: number;
}): TradeLockRow {
  return {
    id: row.id,
    userId: row.user_id,
    connectedAccountId: row.connected_account_id,
    scope: row.scope === "account" ? "account" : "symbol",
    symbol: row.symbol && row.symbol.trim() ? row.symbol : null,
    side: row.side === "long" || row.side === "short" ? row.side : "*",
    reason: row.reason,
    trigger: row.trigger === "symbol_cooldown" ? "symbol_cooldown" : "symbol_losing_streak",
    createdAt: row.created_at,
    until: row.until,
    active: row.active === 1
  };
}

/** Idempotent: unique on (user, account, scope, symbol, side, trigger). Refreshes until/reason. */
export function upsertTradeLock(input: {
  userId: string;
  connectedAccountId: string;
  scope: TradeLockScope;
  symbol?: string | null;
  side?: TradeLockSide;
  reason: string;
  trigger: TradeLockTrigger;
  until: string;
  now?: string;
}): TradeLockRow {
  const now = input.now ?? new Date().toISOString();
  const symbol = input.scope === "symbol" ? (input.symbol ?? "").trim().toUpperCase() : "";
  const side: TradeLockSide = input.side ?? "*";
  const id = `${input.userId}:${input.connectedAccountId}:${input.scope}:${symbol}:${side}:${input.trigger}`;
  getDb()
    .prepare(
      `INSERT INTO trade_locks (
         id, user_id, connected_account_id, scope, symbol, side, reason, trigger, created_at, until, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, connected_account_id, scope, symbol, side, trigger) DO UPDATE SET
         reason = excluded.reason,
         until = excluded.until,
         active = 1`
    )
    .run(
      id,
      input.userId,
      input.connectedAccountId,
      input.scope,
      symbol,
      side,
      input.reason,
      input.trigger,
      now,
      input.until
    );
  return {
    id,
    userId: input.userId,
    connectedAccountId: input.connectedAccountId,
    scope: input.scope,
    symbol: symbol || null,
    side,
    reason: input.reason,
    trigger: input.trigger,
    createdAt: now,
    until: input.until,
    active: true
  };
}

export function getActiveTradeLocks(
  userId: string,
  connectedAccountId: string,
  nowIso: string = new Date().toISOString()
): TradeLockRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, connected_account_id, scope, symbol, side, reason, trigger, created_at, until, active
       FROM trade_locks
       WHERE user_id = ? AND connected_account_id = ? AND active = 1 AND until > ?`
    )
    .all(userId, connectedAccountId, nowIso) as Array<{
    id: string;
    user_id: string;
    connected_account_id: string;
    scope: string;
    symbol: string | null;
    side: string;
    reason: string;
    trigger: string;
    created_at: string;
    until: string;
    active: number;
  }>;
  return rows.map(rowFromDb);
}

export function findCoveringTradeLock(
  locks: TradeLockRow[],
  query: { symbol: string; side: TradeLockSide }
): TradeLockRow | undefined {
  return locks.find((lock) => lockCoversQuery(lock, query));
}

export function pruneExpiredTradeLocks(nowIso: string = new Date().toISOString()): number {
  const result = getDb().prepare(`UPDATE trade_locks SET active = 0 WHERE active = 1 AND until <= ?`).run(nowIso);
  return Number(result.changes ?? 0);
}
