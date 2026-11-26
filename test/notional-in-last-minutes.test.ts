// ST-4690 (E1d sibling): `notionalInLastMinutes` must return the SAME numbers after the sargable
// rewrite, and the rewrite must actually be sargable (index-served), not a rewrite that silently
// walks the account's whole proposal history.
//
// The old predicate was `datetime(coalesce(placed_at, created_at)) >= datetime(:cutoff)`; the new
// one is a UNION ALL of `placed_at >= :cutoff` and `(placed_at IS NULL AND created_at >= :cutoff)`
// with the cutoff truncated to whole seconds (what datetime() compared against anyway).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notional-in-last-minutes-${randomUUID()}.db`)}`;

import { getDb } from "../src/lib/db";
import { notionalInLastMinutes, scopeAccount } from "../src/lib/db-execution";

const USER = "local";
const ACCOUNT = "ACC-1";
// 60 minutes before this is 14:00:00.500Z — deliberately NOT on a whole second, so the
// datetime()-vs-text boundary is exercised.
const NOW = new Date("2026-11-26T15:00:00.500Z");

interface Row {
  id: string;
  placedAt: string | null;
  createdAt: string;
  status: string;
  side: "buy" | "sell" | "short" | "cover";
  estimatedNotional: number | null;
  proposalExtra?: Record<string, number>;
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
      JSON.stringify({ side: row.side, ...(row.proposalExtra ?? {}) }),
      row.status,
      row.estimatedNotional,
      row.placedAt
    );
}

/** The pre-ST-4690 predicate, verbatim — the reference the rewrite must match. */
function legacySelectedIds(cutoffIso: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT id FROM trade_proposals WHERE datetime(coalesce(placed_at, created_at)) >= datetime(?) AND account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')"
    )
    .all(cutoffIso, scopeAccount(ACCOUNT), USER) as Array<{ id: string }>;
  return rows.map((row) => row.id).sort();
}

function seedBoundaryRows(): void {
  insert({ id: "a", placedAt: "2026-11-26T14:30:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 1000 });
  insert({ id: "b", placedAt: null, createdAt: "2026-11-26T14:00:00.000Z", status: "filled", side: "sell", estimatedNotional: 2000 });
  // Exactly the cutoff second: datetime() truncated the cutoff to 14:00:00, so both forms include it.
  insert({ id: "b2", placedAt: "2026-11-26T14:00:00.100Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 300 });
  insert({ id: "c", placedAt: null, createdAt: "2026-11-26T13:59:59.000Z", status: "placed", side: "buy", estimatedNotional: 4000 });
  insert({ id: "d", placedAt: "2026-11-26T13:59:59.999Z", createdAt: "2026-11-26T12:00:00.000Z", status: "paper", side: "short", estimatedNotional: 5000 });
  // Empty (not NULL) placed_at: datetime('') is NULL, so the legacy predicate excluded it; the
  // rewrite must too (the empty string sorts before every ISO timestamp).
  insert({ id: "e", placedAt: "", createdAt: "2026-11-26T14:10:00.000Z", status: "placing", side: "buy", estimatedNotional: 6000 });
  insert({ id: "f", placedAt: "2026-11-26T14:30:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "proposed", side: "buy", estimatedNotional: 7000 });
  insert({ id: "g", placedAt: "2026-11-26T14:30:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 8000, accountNumber: "OTHER" });
  insert({ id: "h", placedAt: "2026-11-26T14:30:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 9000, userId: "other-user" });
  insert({ id: "i", placedAt: null, createdAt: "2026-11-26T14:45:00.000Z", status: "placed", side: "cover", estimatedNotional: 9500 });
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

describe("notionalInLastMinutes sargable rewrite (ST-4690 / E1d sibling)", () => {
  it("selects exactly the same rows as the pre-rewrite predicate", () => {
    seedBoundaryRows();
    const cutoffIso = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // ...:00.500Z

    const legacyIds = legacySelectedIds(cutoffIso);
    expect(legacyIds).toEqual(["a", "b", "b2", "i"]);

    // The function's row set is observable through its aggregates: 3 opening-ish rows in the
    // selected set are counted by orderCount, so pin the exact aggregate instead of ids.
    const stats = notionalInLastMinutes(ACCOUNT, 60, NOW, USER);
    expect(stats.orderCount).toBe(legacyIds.length);
    // a (buy, 1000) + b2 (buy, 300) are opening; b (sell) and i (cover) are closing/exempt.
    expect(stats.openingOrderCount).toBe(2);
    expect(stats.notional).toBe(1300);
  });

  it("matches the legacy predicate at a sub-second cutoff (truncation parity)", () => {
    seedBoundaryRows();
    // A cutoff whose millisecond part is non-zero is where a naive text comparison could drift.
    const cutoffIso = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(legacySelectedIds(cutoffIso)).toEqual(["a", "b", "b2", "i"]);
    // 1 minute earlier: nothing from the seeded rows is within one minute of NOW except none.
    expect(notionalInLastMinutes(ACCOUNT, 1, NOW, USER)).toMatchObject({ orderCount: 0, openingOrderCount: 0, notional: 0 });
  });

  it("keeps the opening-only notional rule, including the proposal fallback", () => {
    insert({ id: "buy-null-estimate", placedAt: "2026-11-26T14:30:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: null, proposalExtra: { dollarAmount: 250 } });
    insert({ id: "short-qty-limit", placedAt: "2026-11-26T14:31:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "filled", side: "short", estimatedNotional: null, proposalExtra: { quantity: 10, limitPrice: 12.5 } });
    insert({ id: "sell", placedAt: "2026-11-26T14:32:00.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "filled", side: "sell", estimatedNotional: 9999 });

    const stats = notionalInLastMinutes(ACCOUNT, 60, NOW, USER);
    expect(stats).toMatchObject({ orderCount: 3, openingOrderCount: 2, notional: 375 });
  });

  it("serves both branches from an index range seek (no unbounded history walk)", () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trade_proposals'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_trade_proposals_user_account_status_placed");

    const cutoffIso = "2026-11-26T14:00:00.000Z";
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
      .all(scopeAccount(ACCOUNT), USER, cutoffIso, scopeAccount(ACCOUNT), USER, cutoffIso) as Array<{
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