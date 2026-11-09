// G9(b) — cross-check that DELETE_TABLES_BY_USER_ID (src/lib/account-deletion.ts) covers every
// USER-SCOPED table in the actual, fully-migrated runtime schema. Static grep of db.ts's CREATE
// TABLE statements is not enough: several tables (strategy_runs, trade_proposals, strategy_profiles,
// portfolio_snapshots, fill_events, notification_events, audit_events, api_health_log) only gain
// their user_id column via an ALTER TABLE in migrate(), not the original CREATE TABLE — so this test
// queries sqlite_master + PRAGMA table_info at runtime against a freshly-migrated temp DB, exactly as
// the audit item requires. It intentionally FAILS if a user-scoped table is missing from the list.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-deletion-coverage-${randomUUID()}.db`)}`;
});

// Tables that carry a user_id column but are intentionally handled OUTSIDE the generic
// DELETE_TABLES_BY_USER_ID loop in confirmAndDeleteAccount (each has its own explicit DELETE):
//  - learned_context: two user-scoping columns (user_id OR contributor_user_id), needs an OR clause.
//  - account_deletion_requests: the deletion-request bookkeeping row itself; deleted last, by design,
//    after the generic loop runs (so the audit trail / prepared-request check stays valid mid-delete).
const HANDLED_OUTSIDE_GENERIC_LOOP = new Set(["learned_context", "account_deletion_requests"]);

describe("account-deletion table coverage (G9b)", () => {
  it("DELETE_TABLES_BY_USER_ID covers every user-scoped table in the migrated schema", async () => {
    // Force a fresh migration by touching getDb() before importing account-deletion's constant.
    const { getDb } = await import("../src/lib/db");
    const db = getDb();

    const allTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    ).map((r) => r.name);

    const userScopedTables = allTables.filter((table) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === "user_id");
    });

    expect(userScopedTables.length).toBeGreaterThan(0); // sanity: the schema actually has user-scoped tables

    const { DELETE_TABLES_BY_USER_ID_FOR_TEST } = await import("../src/lib/account-deletion");
    const deleteList = new Set(DELETE_TABLES_BY_USER_ID_FOR_TEST);

    const uncovered = userScopedTables.filter((t) => !deleteList.has(t) && !HANDLED_OUTSIDE_GENERIC_LOOP.has(t));

    expect(uncovered, `These user-scoped tables are missing from DELETE_TABLES_BY_USER_ID (or the outside-loop allowlist) and would silently escape account deletion: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("every table in DELETE_TABLES_BY_USER_ID actually exists and has a user_id column (catches stale/renamed entries)", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    const { DELETE_TABLES_BY_USER_ID_FOR_TEST } = await import("../src/lib/account-deletion");

    for (const table of DELETE_TABLES_BY_USER_ID_FOR_TEST) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(cols.length, `DELETE_TABLES_BY_USER_ID references "${table}" but it does not exist in the migrated schema`).toBeGreaterThan(0);
      expect(cols.some((c) => c.name === "user_id"), `DELETE_TABLES_BY_USER_ID references "${table}" but it has no user_id column`).toBe(true);
    }
  });
});
