import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database, Statement } from "better-sqlite3";

// /api/health classifies every halted autopilot account.  The kind has to match
// describeAutonomyHaltCause, and the lookup has to stay a couple of indexed
// statements no matter how many halted accounts are in the fleet.

const dir = mkdtempSync(join(tmpdir(), "agentic-batched-halt-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "b".repeat(64);

type PrepareCall = { sql: string; args: unknown[] };

function capturePrepares(database: Database, fn: () => void): PrepareCall[] {
  const original = database.prepare.bind(database);
  const calls: PrepareCall[] = [];
  const wrap = (sql: string, stmt: Statement, method: "all" | "get" | "run") => {
    const inner = stmt[method].bind(stmt) as (...args: unknown[]) => unknown;
    (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls.push({ sql, args });
      return inner(...args);
    };
  };
  database.prepare = ((sql: string) => {
    const stmt = original(sql);
    wrap(sql, stmt, "all");
    wrap(sql, stmt, "get");
    wrap(sql, stmt, "run");
    return stmt;
  }) as Database["prepare"];
  try {
    fn();
  } finally {
    database.prepare = original as Database["prepare"];
  }
  return calls;
}

function planDetails(database: Database, sql: string, args: unknown[]): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail?: string }>;
  return rows.map((row) => row.detail ?? "").join("\n");
}

async function load() {
  const db = await import("../src/lib/db");
  const causes = await import("../src/lib/autonomy-halt-cause");
  const liveness = await import("../src/lib/trading-liveness");
  return { db, causes, liveness };
}

async function seedHalted(label: string) {
  const { db } = await load();
  const userId = `batch-halt-${randomUUID()}`;
  const accountId = `acct-${randomUUID()}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `PA-${randomUUID().slice(0, 8)}`,
    label,
    isActive: true
  });
  const policy = db.getPolicy(userId, accountId);
  db.setPolicy({ ...policy, strategyAuthority: "decide", systemState: "halted" }, userId, accountId);
  return { userId, accountId, accountNumber: db.getPolicy(userId, accountId).accountNumber ?? "" };
}

function ref(account: { userId: string; accountId: string; accountNumber: string }) {
  return { userId: account.userId, accountId: account.accountId, accountNumber: account.accountNumber };
}

describe("batched halt-cause kinds", () => {
  beforeAll(async () => {
    const { db } = await load();
    db.getDb();
  }, 120_000);

  it("pages only an app halt, and ask-first activity keeps the fleet from reading as fully dark", async () => {
    const { db, liveness } = await load();
    await seedHalted("Owner Halt");
    const exitOnly = await seedHalted("Exit Only");
    db.setPolicy(
      { ...db.getPolicy(exitOnly.userId, exitOnly.accountId), strategyAuthority: "decide", systemState: "close_only" },
      exitOnly.userId,
      exitOnly.accountId
    );
    expect(liveness.getTradingLivenessSummary()).toBeNull();

    const { recordBootHaltReceipt } = await import("../src/lib/autonomy-halt-cause");
    const appHalt = await seedHalted("Boot Halt");
    recordBootHaltReceipt(appHalt.userId, appHalt.accountId, { at: "2026-10-14T18:00:00.000Z", from: "active" });

    const dark = liveness.getTradingLivenessSummary();
    expect(dark?.darkness).toMatchObject({
      eligibleAccounts: 3,
      activeAccounts: 0,
      fleetActiveAccounts: 0,
      eligibleDeliberatelyIdle: 2,
      fullyDark: true
    });

    const askFirst = await seedHalted("Ask First");
    db.setPolicy(
      { ...db.getPolicy(askFirst.userId, askFirst.accountId), strategyAuthority: "propose", systemState: "active" },
      askFirst.userId,
      askFirst.accountId
    );
    const quieted = liveness.getTradingLivenessSummary();
    expect(quieted?.darkness?.fullyDark).toBe(false);
    expect(quieted?.darkness?.fleetActiveAccounts).toBe(1);
    expect(quieted?.accounts).toHaveLength(1);
  });

  it("matches describeAutonomyHaltCause and keeps the health poll to one settings read plus one audit read", async () => {
    const { db, causes } = await load();
    const { recordBootHaltReceipt } = causes;
    const database = db.getDb();

    const owner = await seedHalted("Owner");
    const boot = await seedHalted("Boot");
    recordBootHaltReceipt(boot.userId, boot.accountId, { at: "2026-10-14T18:01:00.000Z", from: "active" });

    const runFailure = await seedHalted("Run Failure");
    db.setInternalSetting(`runFailureHaltMarker:${runFailure.userId}:${runFailure.accountId}`, {
      since: "2026-10-14T18:02:00.000Z",
      reason: "runs kept failing",
      consecutiveFailures: 10,
      autoResume: false,
      priorState: "active"
    });
    recordBootHaltReceipt(runFailure.userId, runFailure.accountId, { at: "2026-10-14T17:00:00.000Z", from: "active" });

    const broker = await seedHalted("Broker");
    db.setInternalSetting(`broker:placement-paused:${broker.userId}:${broker.accountId}`, {
      since: "2026-10-14T18:03:00.000Z",
      reason: "broker down",
      autoResume: true,
      priorState: "active"
    });
    recordBootHaltReceipt(broker.userId, broker.accountId, { at: "2026-10-14T17:30:00.000Z", from: "broker_auto_pause" });
    db.setInternalSetting(`runFailureHaltMarker:${broker.userId}:${broker.accountId}`, {
      since: "2026-10-14T17:45:00.000Z",
      reason: "should lose to the broker marker",
      consecutiveFailures: 4
    });

    const breaker = await seedHalted("Breaker");
    db.audit(
      "policy_violation_drawdown",
      { reason: "Trailing drawdown 72.10% breached the 15% limit.", revertedTo: "halted" },
      breaker.userId,
      breaker.accountId
    );
    db.audit(
      "policy_violation_drawdown",
      { reason: "older halt", revertedTo: "halted" },
      breaker.userId,
      breaker.accountId
    );
    database
      .prepare("UPDATE audit_events SET created_at = ? WHERE user_id = ? AND payload LIKE ?")
      .run("2026-10-01T00:00:00.000Z", breaker.userId, "%older halt%");

    const lost = await seedHalted("Lost Pause");
    db.audit("broker_placement_auto_halted", { reason: "Broker health check timed out" }, lost.userId, lost.accountId);
    database
      .prepare(
        `INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload)
         VALUES (?, ?, ?, ?, 'policy_change', ?)`
      )
      .run(
        randomUUID(),
        lost.userId,
        lost.accountId,
        "2020-01-01T00:00:00.000Z",
        JSON.stringify({ value: { systemState: "active" } })
      );

    const handed = await seedHalted("Handed Over");
    const stamp = "2026-10-14T18:04:00.000Z";
    database
      .prepare(
        `INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload)
         VALUES (?, ?, ?, ?, 'policy_violation_drawdown', ?)`
      )
      .run(randomUUID(), handed.userId, handed.accountId, stamp, JSON.stringify({ reason: "dd", revertedTo: "halted" }));
    database
      .prepare(
        `INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload)
         VALUES (?, ?, ?, ?, 'policy_change', ?)`
      )
      .run(randomUUID(), handed.userId, handed.accountId, stamp, JSON.stringify({ value: { systemState: "active" } }));

    const badJson = await seedHalted("Bad Json");
    database
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`broker:placement-paused:${badJson.userId}:${badJson.accountId}`, "{", new Date().toISOString());
    recordBootHaltReceipt(badJson.userId, badJson.accountId, { at: "2026-10-14T18:05:00.000Z", from: "active" });

    const invalidShape = await seedHalted("Invalid Broker Shape");
    db.setInternalSetting(`broker:placement-paused:${invalidShape.userId}:${invalidShape.accountId}`, {
      since: "2026-10-14T18:06:00.000Z",
      reason: "not auto",
      autoResume: false,
      priorState: "active"
    });
    recordBootHaltReceipt(invalidShape.userId, invalidShape.accountId, { at: "2026-10-14T18:07:00.000Z", from: "active" });

    const accounts = [owner, boot, runFailure, broker, breaker, lost, handed, badJson, invalidShape].map(ref);
    const calls = capturePrepares(database, () => {
      const kinds = causes.batchedHaltCauseKinds(accounts);
      expect(kinds.get(`${owner.userId}:${owner.accountId}`)).toBe("stopped");
      expect(kinds.get(`${boot.userId}:${boot.accountId}`)).toBe("restart");
      expect(kinds.get(`${runFailure.userId}:${runFailure.accountId}`)).toBe("run_failure_halt");
      expect(kinds.get(`${broker.userId}:${broker.accountId}`)).toBe("broker_auto_pause");
      expect(kinds.get(`${breaker.userId}:${breaker.accountId}`)).toBe("breaker");
      expect(kinds.get(`${lost.userId}:${lost.accountId}`)).toBe("auto_pause_lost");
      expect(kinds.get(`${handed.userId}:${handed.accountId}`)).toBe("stopped");
      expect(kinds.get(`${badJson.userId}:${badJson.accountId}`)).toBe("stopped");
      expect(kinds.get(`${invalidShape.userId}:${invalidShape.accountId}`)).toBe("restart");
    });

    const settingsReads = calls.filter((call) => call.sql.includes("FROM settings WHERE key IN"));
    const auditReads = calls.filter((call) => call.sql.includes("FROM audit_events"));
    expect(settingsReads).toHaveLength(1);
    expect(auditReads).toHaveLength(1);
    // Four unmarked accounts share one statement: owner, breaker, lost pause, handed over.
    expect(auditReads[0].sql.match(/UNION ALL/g) ?? []).toHaveLength(3);
    const plan = planDetails(database, auditReads[0].sql, auditReads[0].args);
    expect(plan).toMatch(/SEARCH audit_events USING INDEX/);
    expect(plan).not.toMatch(/SCAN audit_events/);

    for (const account of [owner, boot, runFailure, broker, breaker, lost, handed, invalidShape]) {
      const described = causes.describeAutonomyHaltCause({
        userId: account.userId,
        connectedAccountId: account.accountId,
        accountNumber: account.accountNumber,
        systemState: "halted"
      });
      expect(described?.kind).toBe(causes.batchedHaltCauseKinds([ref(account)]).get(`${account.userId}:${account.accountId}`));
    }
    expect(() =>
      causes.describeAutonomyHaltCause({
        userId: badJson.userId,
        connectedAccountId: badJson.accountId,
        accountNumber: badJson.accountNumber,
        systemState: "halted"
      })
    ).toThrow();
  });

  it("does not query for an empty fleet and splits the audit read on the chunk boundary", async () => {
    const { db, causes } = await load();
    const database = db.getDb();
    const empty = capturePrepares(database, () => {
      expect(causes.batchedHaltCauseKinds([]).size).toBe(0);
    });
    expect(empty).toHaveLength(0);

    const many = Array.from({ length: 81 }, () => ({
      userId: `user-${randomUUID()}`,
      accountId: `acct-${randomUUID()}`
    }));
    const calls = capturePrepares(database, () => {
      const kinds = causes.batchedHaltCauseKinds(many);
      expect(kinds.size).toBe(81);
      expect([...kinds.values()].every((kind) => kind === "stopped")).toBe(true);
    });
    expect(calls.filter((call) => call.sql.includes("FROM settings WHERE key IN"))).toHaveLength(1);
    expect(calls.filter((call) => call.sql.includes("FROM audit_events"))).toHaveLength(2);
  });

  it("bounds audit reads inside getTradingLivenessSummary when several autopilot accounts are halted", async () => {
    const { db, liveness } = await load();
    const database = db.getDb();
    const calls = capturePrepares(database, () => {
      liveness.getTradingLivenessSummary();
    });
    const auditReads = calls.filter((call) => call.sql.includes("audit_events"));
    expect(auditReads.length).toBeGreaterThan(0);
    expect(auditReads.length).toBeLessThanOrEqual(2);
    for (const call of auditReads) {
      expect(planDetails(database, call.sql, call.args)).not.toMatch(/SCAN audit_events/);
    }
  });
});
