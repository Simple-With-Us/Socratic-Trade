import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Statement } from "better-sqlite3";

// /api/health classifies every halted autopilot account.  The kind has to match
// describeAutonomyHaltCause, and the lookup has to stay a couple of indexed
// statements no matter how many halted accounts are in the fleet.

const dir = mkdtempSync(join(tmpdir(), "agentic-batched-halt-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "b".repeat(64);

type PrepareCall = { sql: string; args: unknown[] };

async function capturePrepares(database: Database, fn: () => void | Promise<void>): Promise<PrepareCall[]> {
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
    await fn();
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

  afterEach(async () => {
    // The off-loop read's failure bookkeeping and its cooldown are process-wide on purpose, so a
    // test that makes the read fail must not leave a cooldown behind for the next one.
    const { causes } = await load();
    causes.__resetHaltAuditReadFailureForTests();
  });

  it("pages only an app halt, and ask-first activity keeps the fleet from reading as fully dark", async () => {
    const { db, liveness } = await load();
    await seedHalted("Owner Halt");
    const exitOnly = await seedHalted("Exit Only");
    db.setPolicy(
      { ...db.getPolicy(exitOnly.userId, exitOnly.accountId), strategyAuthority: "decide", systemState: "close_only" },
      exitOnly.userId,
      exitOnly.accountId
    );
    expect(await liveness.getTradingLivenessSummary()).toBeNull();

    const { recordBootHaltReceipt } = await import("../src/lib/autonomy-halt-cause");
    const appHalt = await seedHalted("Boot Halt");
    recordBootHaltReceipt(appHalt.userId, appHalt.accountId, { at: "2026-10-14T18:00:00.000Z", from: "active" });

    const dark = await liveness.getTradingLivenessSummary();
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
    const quieted = await liveness.getTradingLivenessSummary();
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
    const calls = await capturePrepares(database, async () => {
      const { kinds } = await causes.batchedHaltCauseKinds(accounts);
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
    // The audit sweep runs OFF the serving connection (ST-4561): it held the serving event loop
    // for 5.4 s in production, on a path the health route runs.  It must not prepare here.
    expect(auditReads).toHaveLength(0);

    // Four unmarked accounts share one statement: owner, breaker, lost pause, handed over.
    const auditStatements = causes.buildHaltAuditStatements(
      [owner, breaker, lost, handed].map((account) => ({
        userId: account.userId,
        connectedAccountId: account.accountId
      }))
    );
    expect(auditStatements).toHaveLength(1);
    expect(auditStatements[0].sql.match(/UNION ALL/g) ?? []).toHaveLength(3);
    const plan = planDetails(database, auditStatements[0].sql, auditStatements[0].params);
    expect(plan).toMatch(/SEARCH audit_events USING INDEX/);
    expect(plan).not.toMatch(/SCAN audit_events/);

    for (const account of [owner, boot, runFailure, broker, breaker, lost, handed, invalidShape]) {
      const described = causes.describeAutonomyHaltCause({
        userId: account.userId,
        connectedAccountId: account.accountId,
        accountNumber: account.accountNumber,
        systemState: "halted"
      });
      const { kinds: batched } = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(described?.kind).toBe(batched.get(`${account.userId}:${account.accountId}`));
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

  it("classifies two scope sets that arrive together: a shared refresh never hides an app halt", async () => {
    const { db, causes } = await load();

    const first = await seedHalted("First Set");
    const second = await seedHalted("Second Set");
    db.audit("policy_violation_drawdown", { reason: "first set", revertedTo: "halted" }, first.userId, first.accountId);
    db.audit("policy_violation_drawdown", { reason: "second set", revertedTo: "halted" }, second.userId, second.accountId);

    // The health route and the run-failure watchdog compute their scope sets independently, so
    // two callers with DIFFERENT scopes really do overlap.  A shared refresh that only covered
    // the first caller's scopes left the second caller with no cache entry, and a missing entry
    // reads as "no app-initiated halt" -- an app halt mislabelled as an owner stop, which counts
    // as a deliberately idle account and suppresses the fleet-fully-dark page.
    const [firstBatch, secondBatch] = await Promise.all([
      causes.batchedHaltCauseKinds([ref(first)]),
      causes.batchedHaltCauseKinds([ref(second)])
    ]);

    expect(firstBatch.kinds.get(`${first.userId}:${first.accountId}`)).toBe("breaker");
    expect(secondBatch.kinds.get(`${second.userId}:${second.accountId}`)).toBe("breaker");
  });

  it("bounds the off-loop read: the runner gets the signal and the caller gives up when it aborts", async () => {
    const { causes } = await load();
    const account = await seedHalted("Bounded");

    let received: AbortSignal | undefined;
    const previous = causes.__setHaltAuditRunnerForTests(
      async (_sql, _params, _dbPath, _schema, options) =>
        new Promise<never>((_resolve, reject) => {
          received = options.signal;
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = "200";
    try {
      const started = Date.now();
      await causes.batchedHaltCauseKinds([ref(account)]);
      const elapsed = Date.now() - started;

      // The read is bounded by the abort, not by the statement: without a shared signal a queued
      // read could hold its caller for 23 s per chunk -- past the 12 s health probe and the 14 s
      // Docker HEALTHCHECK, which is the outage this fix exists to remove.
      expect(elapsed).toBeLessThan(5_000);
      expect(received).toBeDefined();
      expect(received?.aborted).toBe(true);
    } finally {
      delete process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("treats an unreadable halt cause as unknown, counts the failure, and does not re-run the failing read on the next probe", async () => {
    const { causes } = await load();
    const account = await seedHalted("Unreadable");
    const key = `${account.userId}:${account.accountId}`;

    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      const first = await causes.batchedHaltCauseKinds([ref(account)]);
      // The cause could not be read.  That is UNKNOWN -- the absence of a fact -- and not a
      // confirmed "stopped", which is what an owner stop looks like.
      expect(first.unknown.has(key)).toBe(true);
      expect(first.kinds.get(key)).toBe("stopped");

      const status = causes.haltCauseReadStatus();
      expect(status.failures).toBe(1);
      expect(status.lastFailure).toContain("off-loop read failed");
      expect(status.coolingDown).toBe(true);

      // The next probe does not re-run the failing multi-second read: the failure has a cooldown,
      // so a degraded database is not turned into a repeating multi-second read, and the scope
      // stays UNKNOWN rather than decaying into a confirmed owner stop.
      const second = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(second.unknown.has(key)).toBe(true);
      expect(invocations).toBe(1);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("classifies a fresh app halt on the next poll: the audit write drops the cached answer", async () => {
    const { db, causes } = await load();
    const account = await seedHalted("Fresh Breaker");
    const key = `${account.userId}:${account.accountId}`;

    // First poll: the app has not halted this account, so the read caches "no app-initiated halt".
    const before = await causes.batchedHaltCauseKinds([ref(account)]);
    expect(before.kinds.get(key)).toBe("stopped");
    expect(before.unknown.has(key)).toBe(false);

    // The drawdown breaker halts it, and the app writes that audit row itself.
    db.audit(
      "policy_violation_drawdown",
      { reason: "Trailing drawdown breached the limit.", revertedTo: "halted" },
      account.userId,
      account.accountId
    );

    // The write drops the cached answer for that scope, so the next poll reads the new row
    // instead of serving the minute-old "no app-initiated halt" -- which reads as an owner stop,
    // and an owner stop counts as a deliberately idle account.
    const after = await causes.batchedHaltCauseKinds([ref(account)]);
    expect(after.kinds.get(key)).toBe("breaker");
    expect(after.unknown.has(key)).toBe(false);
  });

  it("does not query for an empty fleet and splits the audit read on the chunk boundary", async () => {
    const { db, causes } = await load();
    const database = db.getDb();
    const empty = await capturePrepares(database, async () => {
      expect((await causes.batchedHaltCauseKinds([])).kinds.size).toBe(0);
    });
    expect(empty).toHaveLength(0);

    const many = Array.from({ length: 81 }, () => ({
      userId: `user-${randomUUID()}`,
      accountId: `acct-${randomUUID()}`
    }));
    const calls = await capturePrepares(database, async () => {
      const { kinds } = await causes.batchedHaltCauseKinds(many);
      expect(kinds.size).toBe(81);
      expect([...kinds.values()].every((kind) => kind === "stopped")).toBe(true);
    });
    expect(calls.filter((call) => call.sql.includes("FROM settings WHERE key IN"))).toHaveLength(1);
    // Off the serving connection (ST-4561) -- no audit statement is prepared here.
    expect(calls.filter((call) => call.sql.includes("FROM audit_events"))).toHaveLength(0);
    // 81 accounts split at the 80-account chunk boundary into two off-loop statements.
    expect(
      causes.buildHaltAuditStatements(
        many.map((account) => ({ userId: account.userId, connectedAccountId: account.accountId }))
      )
    ).toHaveLength(2);
  });

  it("keeps the health poll's audit sweep off the serving connection (ST-4561)", async () => {
    const { db, causes, liveness } = await load();
    const database = db.getDb();

    const halted = await seedHalted("Health Sweep");
    db.audit(
      "policy_violation_drawdown",
      { reason: "Trailing drawdown breached the limit.", revertedTo: "halted" },
      halted.userId,
      halted.accountId
    );

    const calls = await capturePrepares(database, async () => {
      const summary = await liveness.getTradingLivenessSummary();
      expect(summary).not.toBeNull();
    });

    // The health path prepares the marker settings read and nothing else: the `audit_events`
    // sweep is the statement that held the serving event loop for 5.4 s in production.
    const auditReads = calls.filter((call) => call.sql.includes("FROM audit_events"));
    expect(auditReads).toHaveLength(0);
    expect(calls.filter((call) => call.sql.includes("FROM settings WHERE key IN"))).toHaveLength(1);

    // Positive control: the capture really does see `audit_events` statements when one runs on
    // the serving connection, so the zero above is a property of the fix and not of the capture.
    const control = await capturePrepares(database, () => {
      causes.describeAutonomyHaltCause({
        userId: halted.userId,
        connectedAccountId: halted.accountId,
        accountNumber: halted.accountNumber,
        systemState: "halted"
      });
    });
    expect(control.filter((call) => call.sql.includes("FROM audit_events")).length).toBeGreaterThan(0);
  });
});
