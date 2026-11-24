// ST-4643 (audit F3): `dailyExecutionStats` must return the SAME numbers after the sargable
// rewrite, and the rewrite must actually be sargable (index-served), not a rewrite that
// silently walks the account's whole proposal history.
//
// The old predicate was `datetime(coalesce(placed_at, created_at)) >= datetime(:dayStart)`.
// The new one is `(placed_at >= :dayStart) OR (placed_at IS NULL AND created_at >= :dayStart)`.
// Both are asserted against the same fixture rows here.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-daily-execution-stats-${randomUUID()}.db`)}`;

import { getDb } from "../src/lib/db";
import { dailyExecutionStats, scopeAccount } from "../src/lib/db-execution";

const USER = "local";
const ACCOUNT = "ACC-1";
const DAY = "2026-11-23";
const DAY_START = "2026-11-23T06:00:00.000Z"; // 00:00 America/New_York (EST)
const BEFORE = "2026-11-22T20:00:00.000Z";
const AFTER = "2026-11-23T18:00:00.000Z";

interface Row {
  id: string;
  placedAt: string | null;
  createdAt: string;
  status: string;
  side: "buy" | "sell" | "short" | "cover";
  estimatedNotional: number | null;
  accountNumber?: string;
  userId?: string;
}

function insert(row: Row): void {
  getDb()
    .prepare(
      `INSERT INTO trade_proposals
         (id, user_id, run_id, account_number, created_at, proposal, decision, status, estimated_notional, placed_at)
       VALUES (?, ?, 'run-1', ?, ?, ?, '{}', ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId ?? USER,
      row.accountNumber ?? scopeAccount(ACCOUNT),
      row.createdAt,
      JSON.stringify({ side: row.side }),
      row.status,
      row.estimatedNotional,
      row.placedAt
    );
}

/** The pre-ST-4643 predicate, verbatim — the reference the rewrite must match. */
function legacySelectedIds(dayStartIso: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT id FROM trade_proposals WHERE datetime(coalesce(placed_at, created_at)) >= datetime(?) AND account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')"
    )
    .all(dayStartIso, scopeAccount(ACCOUNT), USER) as Array<{ id: string }>;
  return rows.map((row) => row.id).sort();
}

/** The post-ST-4643 predicate, verbatim (the UNION ALL of the two sargable branches). */
function rewrittenSelectedIds(dayStartIso: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM trade_proposals
       WHERE account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')
         AND placed_at >= ?
       UNION ALL
       SELECT id FROM trade_proposals
       WHERE account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')
         AND placed_at IS NULL AND created_at >= ?`
    )
    .all(scopeAccount(ACCOUNT), USER, dayStartIso, scopeAccount(ACCOUNT), USER, dayStartIso) as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id).sort();
}

beforeEach(() => {
  getDb().prepare("DELETE FROM trade_proposals").run();
});

// Restore the shared config this file mutated.  `getDb()` memoizes its connection, so the
// already-open handle keeps pointing at this file's temp database for the rest of the file.
afterEach(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe("dailyExecutionStats sargable rewrite (ST-4643 / audit F3)", () => {
  it("selects exactly the same rows as the pre-rewrite predicate", () => {
    insert({ id: "a", placedAt: DAY_START, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 1000 });
    insert({ id: "b", placedAt: null, createdAt: DAY_START, status: "placed", side: "buy", estimatedNotional: 2000 });
    insert({ id: "c", placedAt: null, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 4000 });
    insert({ id: "d", placedAt: AFTER, createdAt: BEFORE, status: "filled", side: "sell", estimatedNotional: 5000 });
    insert({ id: "e", placedAt: null, createdAt: AFTER, status: "filled", side: "short", estimatedNotional: 6000 });
    insert({ id: "f", placedAt: DAY_START, createdAt: BEFORE, status: "proposed", side: "buy", estimatedNotional: 7000 });
    insert({ id: "g", placedAt: null, createdAt: BEFORE, status: "paper", side: "buy", estimatedNotional: 8000 });
    insert({ id: "h", placedAt: null, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 9000, accountNumber: "OTHER" });
    insert({ id: "i", placedAt: null, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 9500, userId: "other-user" });

    expect(rewrittenSelectedIds(DAY_START)).toEqual(legacySelectedIds(DAY_START));
    expect(rewrittenSelectedIds(DAY_START)).toEqual(["a", "b", "d", "e"]);
  });

  it("returns the same counts and notional as the pre-rewrite predicate", () => {
    insert({ id: "a", placedAt: DAY_START, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 1000 });
    insert({ id: "b", placedAt: null, createdAt: DAY_START, status: "placed", side: "buy", estimatedNotional: 2000 });
    insert({ id: "c", placedAt: null, createdAt: BEFORE, status: "placed", side: "sell", estimatedNotional: 4000 });
    insert({ id: "d", placedAt: null, createdAt: DAY_START, status: "paper", side: "short", estimatedNotional: null });
    insert({ id: "e", placedAt: DAY_START, createdAt: BEFORE, status: "filled", side: "cover", estimatedNotional: 5000 });

    // 2026-11-23T06:00:00Z is midnight America/New_York on 2026-11-23.
    const stats = dailyExecutionStats(ACCOUNT, new Date("2026-11-23T12:00:00.000Z"), USER);
    // Selected rows: a (placed), b (created today), d (created today), e (placed).
    // c is excluded: it was created BEFORE the day boundary and has no placed_at.
    expect(stats.orderCount).toBe(4);
    // "opening" = buy OR short; closing trades (sell/cover) are risk-reducing and exempt.
    expect(stats.openingOrderCount).toBe(3);
    // Opening notional only: 1000 + 2000 + (d has no estimated_notional -> proposal fallback 0).
    expect(stats.notional).toBe(3000);
  });

  it("excludes rows from before the day boundary", () => {
    // Control: an in-window row IS counted, so the single row below is the boundary rule
    // working and not a broken reader.
    insert({ id: "in-window", placedAt: DAY_START, createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 700 });
    insert({ id: "old", placedAt: "2026-11-23T05:59:59.000Z", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 1000 });
    const stats = dailyExecutionStats(ACCOUNT, new Date("2026-11-23T12:00:00.000Z"), USER);
    expect(stats.orderCount).toBe(1);
    expect(stats.notional).toBe(700);
  });

  it("serves both branches from an index range seek (no unbounded history walk)", () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trade_proposals'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_trade_proposals_user_account_status_placed");

    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT proposal, estimated_notional FROM trade_proposals
         WHERE account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')
           AND placed_at >= ?
         UNION ALL
         SELECT proposal, estimated_notional FROM trade_proposals
         WHERE account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')
           AND placed_at IS NULL AND created_at >= ?`
      )
      .all(scopeAccount(ACCOUNT), USER, DAY_START, scopeAccount(ACCOUNT), USER, DAY_START) as Array<{
      detail: string;
    }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    // The point of the rewrite: every branch is an INDEX range seek, never a table scan and
    // never an unbounded (user, account, status) search over the whole order history.
    expect(detail).toContain("idx_trade_proposals_user_account_status_placed");
    expect(detail).toContain("placed_at>?");
    expect(detail).not.toContain("SCAN trade_proposals");
    expect(detail).not.toMatch(/status=\?\)\s*$/);
  });
});
