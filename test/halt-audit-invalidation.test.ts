import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The audit write path decides in JS whether a row can change the cached halt-cause answer; the
// cached answer itself comes from two SQL predicates.  The two must agree on every row: a row the
// SQL counts but the JS skips leaves a stale answer for a TTL, and a row the JS counts but the
// SQL ignores forces a needless scan of the 19 GB audit table.

const dir = mkdtempSync(join(tmpdir(), "agentic-halt-audit-invalidation-"));
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "b".repeat(64);

afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

const KINDS = [
  "broker_placement_auto_halted",
  "policy_violation_drawdown",
  "broker_placement_auto_resumed",
  "broker_placement_pause_owner_override",
  "autonomy_halted_on_boot",
  "ops_account_control",
  "policy_change",
  "order_submitted",
  "strategy_run"
];

const PAYLOADS: Array<string | undefined> = [
  JSON.stringify({ reason: "advisory" }),
  JSON.stringify({ reason: "hard", revertedTo: "halted" }),
  JSON.stringify({ revertedTo: "active" }),
  JSON.stringify({ revertedTo: null }),
  JSON.stringify({ action: "set_system_state", dryRun: 0 }),
  JSON.stringify({ action: "set_system_state", dryRun: false }),
  JSON.stringify({ action: "set_system_state", dryRun: 1 }),
  JSON.stringify({ action: "set_system_state", dryRun: true }),
  JSON.stringify({ action: "set_system_state", dryRun: "0" }),
  JSON.stringify({ action: "set_system_state" }),
  JSON.stringify({ action: "park", dryRun: 0 }),
  JSON.stringify({ key: "policy", value: { systemState: "active" } }),
  JSON.stringify({ key: "policy", value: { systemState: "halted" } }),
  JSON.stringify({ key: "policy", value: { systemState: null } }),
  JSON.stringify({ key: "policy", value: { systemState: 3 } }),
  JSON.stringify({ key: "policy", value: {} }),
  JSON.stringify({ key: "strategyPrompt", value: "text" }),
  JSON.stringify({ key: "policy", value: [1, 2] }),
  JSON.stringify([1, 2]),
  JSON.stringify("halted"),
  JSON.stringify(null),
  "{not json",
  undefined
];

describe("auditRowChangesHaltCause", () => {
  it("agrees with the SQL app-halt and handover predicates on every row", async () => {
    const { APP_HALT_PREDICATE, handoverPredicate } = await import("../src/lib/autonomy-halt-cause");
    const { auditRowChangesHaltCause } = await import("../src/lib/halt-audit-invalidation");
    const memory = new Database(":memory:");
    try {
      memory.exec("CREATE TABLE audit_events (kind TEXT NOT NULL, payload TEXT)");
      const insert = memory.prepare("INSERT INTO audit_events (kind, payload) VALUES (?, ?)");
      for (const kind of KINDS) for (const payload of PAYLOADS) insert.run(kind, payload ?? null);
      const rows = memory
        .prepare(
          `SELECT kind, payload,
             COALESCE((${APP_HALT_PREDICATE}) OR ${handoverPredicate("kind", "payload")}, 0) AS changes
           FROM audit_events`
        )
        .all() as Array<{ kind: string; payload: string | null; changes: number }>;
      expect(rows).toHaveLength(KINDS.length * PAYLOADS.length);
      const mismatches = rows.filter(
        (row) => auditRowChangesHaltCause(row.kind, row.payload ?? undefined) !== (row.changes === 1)
      );
      expect(mismatches).toEqual([]);
      // Control: the matrix covers both answers, so agreement is not two functions that are both
      // always false (or always true).
      expect(rows.some((row) => row.changes === 1)).toBe(true);
      expect(rows.some((row) => row.changes === 0)).toBe(true);
    } finally {
      memory.close();
    }
  });

  it("skips the advisory drawdown row and keeps the hard one and the takeover kinds", async () => {
    const { auditRowChangesHaltCause } = await import("../src/lib/halt-audit-invalidation");
    expect(auditRowChangesHaltCause("policy_violation_drawdown", JSON.stringify({ reason: "advisory" }))).toBe(false);
    expect(auditRowChangesHaltCause("policy_violation_drawdown", JSON.stringify({ revertedTo: "halted" }))).toBe(true);
    expect(auditRowChangesHaltCause("broker_placement_pause_owner_override", "{}")).toBe(true);
    expect(auditRowChangesHaltCause("ops_account_control", JSON.stringify({ action: "set_system_state", dryRun: 0 }))).toBe(true);
    expect(auditRowChangesHaltCause("policy_change", JSON.stringify({ value: { systemState: "active" } }))).toBe(true);
    expect(auditRowChangesHaltCause("order_submitted", JSON.stringify({ revertedTo: "halted" }))).toBe(false);
  });
});
