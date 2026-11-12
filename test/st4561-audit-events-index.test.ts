import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestHaltBranch } from "../src/lib/autonomy-halt-cause";
import { getDb } from "../src/lib/db";

/**
 * ST-4561: the `autonomy_halt_cause` halt-branch statement is the one the app's own
 * `[slow-sqlite]` detector measured holding the serving event loop for ~5 s a call in
 * prod on 2026-10-24 (14 holds, 73.8 s blocked, in 230 s of uptime = ~32% of wall clock).
 * Migration v100 adds `idx_audit_events_account_kind_created` so the correlated EXISTS
 * and the outer LIMIT 1 can seek (user_id, connected_account_id, kind, created_at)
 * instead of sorting a user's whole audit history.
 *
 * These assertions are deliberately paired: the same statement is planned with and
 * without the index, so a plan assertion that passes either way fails this file.
 */

const ACCOUNT = { userId: "u1", connectedAccountId: "a1" } as const;
const INDEX = "idx_audit_events_account_kind_created";
// v101: the correlated handover EXISTS cannot range created_at on the kind-first
// index (kind is OR/IN-constrained there), so it seeks this companion instead.
const EXISTS_INDEX = "idx_audit_events_account_created";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-st4561-${randomUUID()}.db`)}`;
});

afterAll(() => {
  // A reused Vitest worker keeps this module's mutations; restore the prior
  // value (or absence) so later suites never see the generated database.
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

function planDetails(sql: string, params: string[]): string[] {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as { detail: string }[];
  return rows.map((row) => row.detail);
}

function insertAudit(id: string, kind: string, createdAt: string, payload = "{}"): void {
  getDb()
    .prepare(
      "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, ACCOUNT.userId, ACCOUNT.connectedAccountId, createdAt, kind, payload);
}

describe("ST-4561 audit_events composite index", () => {
  it("migration v100 creates the composite index", () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(INDEX);
    expect(row).toBeTruthy();
  });

  it("plans the halt-branch statement against the composite index, without a sort b-tree", () => {
    const { sql, params } = latestHaltBranch(ACCOUNT);
    const details = planDetails(sql, params);
    // eslint-disable-next-line no-console
    console.log("PLAN WITH INDEX:", details.join(" | "));
    expect(details.join(" | ")).toContain(INDEX);
    expect(details.join(" | ")).not.toMatch(/TEMP B-TREE FOR ORDER BY/i);
    // The correlated handover EXISTS is the subplan that walked the user's whole
    // audit history; assert that subplan itself seeks the companion index rather
    // than only checking the joined plan text.
    const existsPlan = details.find((detail) => /SEARCH e\b/.test(detail));
    expect(existsPlan).toBeTruthy();
    expect(existsPlan).toContain(EXISTS_INDEX);
  });

  it("the same statement falls back to the per-kind walk when the index is absent (control)", () => {
    const db = getDb();
    db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
    db.exec(`DROP INDEX IF EXISTS ${EXISTS_INDEX}`);
    try {
      const { sql, params } = latestHaltBranch(ACCOUNT);
      const details = planDetails(sql, params);
      // eslint-disable-next-line no-console
      console.log("PLAN WITHOUT INDEX:", details.join(" | "));
      expect(details.join(" | ")).not.toContain(INDEX);
      expect(details.join(" | ")).not.toContain(EXISTS_INDEX);
      // The pre-v100 fallback still resolves every table access through some
      // index seek; pin the shape, not one specific fallback index name, since
      // several indexes can serve the per-kind lookup equally.
      expect(details.join(" | ")).toMatch(/SEARCH audit_events USING INDEX/);
    } finally {
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${INDEX} ON audit_events (user_id, connected_account_id, kind, created_at DESC)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${EXISTS_INDEX} ON audit_events (user_id, connected_account_id, created_at DESC)`
      );
    }
  });

  it("still returns the latest app halt and its handover flag", () => {
    const db = getDb();
    db.exec("DELETE FROM audit_events");
    insertAudit("evt-halt-1", "broker_placement_auto_halted", "2026-10-20T00:00:00.000Z", '{"reason":"drawdown"}');
    insertAudit("evt-noise-1", "market_scan", "2026-10-19T00:00:00.000Z");
    insertAudit("evt-noise-2", "market_scan", "2026-10-21T00:00:00.000Z");

    const { sql, params } = latestHaltBranch(ACCOUNT);
    const rows = db.prepare(sql).all(...params) as {
      kind: string;
      created_at: string;
      handed_over: number;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("broker_placement_auto_halted");
    expect(rows[0].created_at).toBe("2026-10-20T00:00:00.000Z");
    expect(rows[0].handed_over).toBe(0);

    insertAudit(
      "evt-resume-1",
      "broker_placement_auto_resumed",
      "2026-10-20T00:00:01.000Z"
    );
    const after = db.prepare(sql).all(...params) as { kind: string; handed_over: number }[];
    expect(after[0].kind).toBe("broker_placement_auto_halted");
    expect(after[0].handed_over).toBe(1);
  });

  it("does not treat an earlier same-millisecond policy change as a handover", () => {
    const db = getDb();
    db.exec("DELETE FROM audit_events");
    const at = "2026-11-12T06:01:30.000Z";
    insertAudit("evt-before", "policy_change", at, '{"value":{"systemState":"active"}}');
    insertAudit(
      "evt-breaker",
      "policy_violation_drawdown",
      at,
      '{"revertedTo":"halted","reason":"Trailing drawdown 72.10% breached the 15% limit."}'
    );

    const { sql, params } = latestHaltBranch(ACCOUNT);
    const before = db.prepare(sql).all(...params) as { kind: string; handed_over: number }[];
    expect(before).toHaveLength(1);
    expect(before[0].kind).toBe("policy_violation_drawdown");
    expect(before[0].handed_over).toBe(0);

    insertAudit("evt-after", "policy_change", at, '{"value":{"systemState":"active"}}');
    const after = db.prepare(sql).all(...params) as { handed_over: number }[];
    expect(after[0].handed_over).toBe(1);
  });
});
