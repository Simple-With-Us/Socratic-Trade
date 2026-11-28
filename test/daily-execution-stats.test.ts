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

    expect(legacySelectedIds(DAY_START)).toEqual(["a", "b", "d", "e"]);
    expect(dailyExecutionStats(ACCOUNT, new Date("2026-11-23T12:00:00.000Z"), USER).orderCount).toBe(4);
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

  it("counts parseable non-canonical timestamps exactly as the legacy predicate does", () => {
    // datetime() normalizes a space separator and a UTC offset; a text comparison does not. An
    // undercount here loosens the daily cap. DAY_START is 06:00:00Z.
    insert({ id: "sp", placedAt: "2026-11-23 07:00:00", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 1000 });
    insert({ id: "off", placedAt: "2026-11-23T03:00:00-05:00", createdAt: BEFORE, status: "filled", side: "buy", estimatedNotional: 2000 });
    insert({ id: "utc-off", placedAt: "2026-11-23T10:00:00.000+00:00", createdAt: BEFORE, status: "placed", side: "short", estimatedNotional: 4000 });
    insert({ id: "null-sp", placedAt: null, createdAt: "2026-11-23 09:00:00", status: "placed", side: "buy", estimatedNotional: 8000 });
    insert({ id: "old-sp", placedAt: "2026-11-23 05:00:00", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 16000 });
    insert({ id: "old-off", placedAt: "2026-11-23T00:30:00-05:00", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 32000 });
    const legacy = legacySelectedIds(DAY_START);
    expect(legacy).toEqual(["null-sp", "off", "sp", "utc-off"]);
    const stats = dailyExecutionStats(ACCOUNT, new Date("2026-11-23T12:00:00.000Z"), USER);
    expect(stats.orderCount).toBe(legacy.length);
    expect(stats.notional).toBe(1000 + 2000 + 4000 + 8000);
  });

  it("keeps stored values that datetime() accepts as relative time (e.g. 'now') counted, as the legacy predicate does", () => {
    // 'now' is non-deterministic, so an expression index over datetime() cannot be built on such
    // data. The query must neither fail nor drop the row.
    insert({ id: "now", placedAt: "now", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 500 });
    insert({ id: "now-created", placedAt: null, createdAt: "now", status: "filled", side: "buy", estimatedNotional: 250 });
    insert({ id: "sp", placedAt: "2026-11-23 07:00:00", createdAt: BEFORE, status: "placed", side: "buy", estimatedNotional: 1000 });
    const legacy = legacySelectedIds(DAY_START);
    expect(legacy).toEqual(["now", "now-created", "sp"]);
    const stats = dailyExecutionStats(ACCOUNT, new Date("2026-11-23T12:00:00.000Z"), USER);
    expect(stats.orderCount).toBe(3);
    expect(stats.notional).toBe(1750);
  });

  it("searches an existing (user_id, account_number, ...) index and creates no expression index", () => {
    const idx = getDb()
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trade_proposals'")
      .all() as Array<{ name: string; sql: string | null }>;
    expect(idx.map((i) => i.name)).toContain("idx_trade_proposals_user_account_status_placed");
    expect(idx.some((i) => /datetime\(/i.test(i.sql ?? ""))).toBe(false);
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT proposal, estimated_notional FROM trade_proposals
         WHERE datetime(coalesce(placed_at, created_at)) >= datetime(?)
           AND account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')`
      )
      .all(DAY_START, scopeAccount(ACCOUNT), USER) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    // Some existing (user_id, account_number, ...) index is searched; never a full table scan.
    expect(detail).toMatch(/SEARCH trade_proposals USING INDEX idx_trade_proposals_\w+ \(user_id=\? AND account_number=\?/);
    expect(detail).not.toContain("SCAN trade_proposals");
  });
});
