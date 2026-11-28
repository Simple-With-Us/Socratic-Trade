// Preserve original datetime predicate semantics for cap inputs, including parser-accepted
// non-canonical values. No nondeterministic datetime expression index is installed.
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
  // Kody 68-aIu: malformed timestamp STRINGS sort after ISO text, so the plain `>= ?` comparison
  // admits them while the legacy datetime() form treated them as NULL.  Both must exclude.
  insert({ id: "j", placedAt: "garbage", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 700 });
  insert({ id: "k", placedAt: null, createdAt: "not-a-timestamp", status: "placed", side: "buy", estimatedNotional: 800 });
  insert({ id: "l", placedAt: "2026-13-99T99:99:99.000Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 900 });
  // A VALID timestamp without milliseconds parses (the legacy form included it) and must stay
  // included — this is why the guard is julianday's parser and not a strict shape GLOB.
  insert({ id: "m", placedAt: "2026-11-26T14:20:00Z", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 110 });
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

describe("notionalInLastMinutes legacy predicate semantics (ST-4690 / E1d sibling)", () => {
  it("selects exactly the same rows as the pre-rewrite predicate", () => {
    seedBoundaryRows();
    const cutoffIso = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // ...:00.500Z

    const legacyIds = legacySelectedIds(cutoffIso);
    // Malformed strings (j, k, l) are excluded by BOTH forms; the ms-less valid timestamp (m)
    // stays included by both.
    expect(legacyIds).toEqual(["a", "b", "b2", "i", "m"]);

    // The function's row set is observable through its aggregates: pin the exact aggregate
    // instead of ids.
    const stats = notionalInLastMinutes(ACCOUNT, 60, NOW, USER);
    expect(stats.orderCount).toBe(legacyIds.length);
    // a (buy, 1000) + b2 (buy, 300) + m (buy, 110) are opening; b (sell) and i (cover) are
    // closing/exempt.
    expect(stats.openingOrderCount).toBe(3);
    expect(stats.notional).toBe(1410);
  });

  it("matches the legacy predicate at a sub-second cutoff (truncation parity)", () => {
    seedBoundaryRows();
    // A cutoff whose millisecond part is non-zero is where a naive text comparison could drift.
    const cutoffIso = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(legacySelectedIds(cutoffIso)).toEqual(["a", "b", "b2", "i", "m"]);
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

  it("counts parseable non-canonical timestamps exactly as the legacy predicate does", () => {
    // datetime() normalizes a space separator and a UTC offset; a text comparison does not. The
    // hourly cap must count these rows (an undercount loosens the cap), so the query keeps the
    // original datetime() predicate. Cutoff is 14:00:00.500Z.
    insert({ id: "sp", placedAt: "2026-11-26 14:30:00", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 1000 });
    insert({ id: "sp-ms", placedAt: "2026-11-26 14:31:00.000", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 2000 });
    insert({ id: "off", placedAt: "2026-11-26T09:30:00-05:00", createdAt: "2026-11-26T12:00:00.000Z", status: "filled", side: "buy", estimatedNotional: 4000 });
    insert({ id: "utc-off", placedAt: "2026-11-26T14:32:00.000+00:00", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "short", estimatedNotional: 8000 });
    insert({ id: "null-sp", placedAt: null, createdAt: "2026-11-26 14:33:00", status: "placed", side: "buy", estimatedNotional: 16000 });
    insert({ id: "old-sp", placedAt: "2026-11-26 13:00:00", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 32000 });
    insert({ id: "off-old", placedAt: "2026-11-26T07:00:00-05:00", createdAt: "2026-11-26T12:00:00.000Z", status: "placed", side: "buy", estimatedNotional: 64000 });
    const cutoffIso = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const legacyIds = legacySelectedIds(cutoffIso);
    expect(legacyIds).toEqual(["null-sp", "off", "sp", "sp-ms", "utc-off"]);
    const stats = notionalInLastMinutes(ACCOUNT, 60, NOW, USER);
    expect(stats.orderCount).toBe(legacyIds.length);
    expect(stats.notional).toBe(1000 + 2000 + 4000 + 8000 + 16000);
  });

  it("preserves parser-accepted now without breaking DB writes", () => {
    insert({ id: "now-row", placedAt: "now", createdAt: "now", status: "placed", side: "buy", estimatedNotional: 100 });
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 60_000).toISOString();
    const ids = legacySelectedIds(cutoff);
    expect(ids).toContain("now-row");
    expect(notionalInLastMinutes(ACCOUNT, 60, now, USER).notional).toBe(100);
  });
});
