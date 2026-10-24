import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    // test that makes the read fail must not leave a cooldown behind for the next one.  The shared
    // refresh, the pending scopes and the cache are process-wide too, so they are cleared here as
    // well: a test that leaves a refresh running hands the next one a refresh that is dying.
    const { causes } = await load();
    causes.__resetHaltAuditReadFailureForTests();
    causes.__resetHaltAuditStateForTests();
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
    const priorBudget = process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
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
      // Restore the EXACT prior value.  Deleting the key would erase a value the environment
      // already carried, and the budget is read from the environment on every call.
      if (priorBudget === undefined) delete process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
      else process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = priorBudget;
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("keeps the classification pending until the injected runner resolves, then reflects the row it returned", async () => {
    const { causes } = await load();
    const account = await seedHalted("Deferred Runner");
    const key = `${account.userId}:${account.accountId}`;

    type ProbeRow = {
      user_id: string;
      connected_account_id: string | null;
      kind: string;
      created_at: string;
      payload: string;
      handed_over: number;
    };
    let resolveRows: ((rows: ProbeRow[]) => void) | undefined;
    let markRunnerCalled: () => void = () => undefined;
    const runnerCalled = new Promise<void>((resolve) => {
      markRunnerCalled = resolve;
    });
    const previous = causes.__setHaltAuditRunnerForTests(() => {
      markRunnerCalled();
      return new Promise<ProbeRow[]>((resolve) => {
        resolveRows = resolve;
      });
    });
    try {
      const pending = causes.batchedHaltCauseKinds([ref(account)]);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // The read reached the injected runner, and the classification is still PENDING: an
      // unresolved Promise must not be projected as an answer.  Without the await the Promise
      // would stand in for the row map and the scope would read as a confirmed "stopped" -- an
      // owner stop -- instead of the app halt the row names.
      await runnerCalled;
      expect(settled).toBe(false);

      resolveRows?.([
        {
          user_id: account.userId,
          connected_account_id: account.accountId,
          kind: "policy_violation_drawdown",
          created_at: new Date().toISOString(),
          payload: JSON.stringify({ reason: "deferred breaker", revertedTo: "halted" }),
          handed_over: 0
        }
      ]);
      const batch = await pending;
      expect(batch.kinds.get(key)).toBe("breaker");
      expect(batch.unknown.has(key)).toBe(false);
    } finally {
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

  it("does not write a pre-halt answer back over an invalidation from the same millisecond", async () => {
    const { db, causes } = await load();
    const account = await seedHalted("Same Millisecond");
    const key = `${account.userId}:${account.accountId}`;

    // A frozen clock makes the invalidation and the read share ONE timestamp.  The old code
    // compared `invalidatedAt > readStartedAt`, and two equal timestamps are not "greater than",
    // so the read wrote its pre-halt answer back over the invalidation and the scope read as a
    // confirmed "stopped" -- an owner stop -- instead of unknown.
    const fixedNow = 1_760_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    let calls = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        // The app writes a fresh drawdown-breaker halt while this read is in flight.
        db.audit(
          "policy_violation_drawdown",
          { reason: "same-millisecond breaker", revertedTo: "halted" },
          account.userId,
          account.accountId
        );
        // This read's answer: the account had no app-initiated halt when the statement ran.
        return [];
      }
      // The read that follows the invalidation sees the row the app wrote.
      return [
        {
          user_id: account.userId,
          connected_account_id: account.accountId,
          kind: "policy_violation_drawdown",
          created_at: new Date(fixedNow).toISOString(),
          payload: JSON.stringify({ reason: "same-millisecond breaker", revertedTo: "halted" }),
          handed_over: 0
        }
      ];
    });
    try {
      const during = await causes.batchedHaltCauseKinds([ref(account)]);
      // The poll ends on the FRESH answer.  With the old timestamp comparison the pre-halt answer
      // was written back over the invalidation, so the scope read as a confirmed "stopped" -- an
      // owner stop -- and the breaker the app had just written stayed invisible for a whole TTL.
      expect(during.kinds.get(key)).toBe("breaker");
      expect(during.unknown.has(key)).toBe(false);
      // Control: the invalidation was NOTICED.  The pre-halt answer was discarded, so the scope
      // had no cache entry and was read again; without the generation the first answer would have
      // been cached and the second read would never have happened.
      expect(calls).toBe(2);
    } finally {
      clock.mockRestore();
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("keeps the chunks that succeeded when a later chunk fails", async () => {
    const { causes } = await load();
    const scopes = Array.from({ length: 81 }, () => ({
      userId: `user-${randomUUID()}`,
      accountId: `acct-${randomUUID()}`
    }));
    let calls = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) return [];
      throw new Error("off-loop read failed");
    });
    try {
      const batch = await causes.batchedHaltCauseKinds(scopes);
      expect(calls).toBe(2);

      // The first chunk completed, so those scopes have a CONFIRMED answer ("no app-initiated
      // halt").  The read used to throw the completed chunks away and requeue the whole batch,
      // so every scope came back unknown.
      for (const scope of scopes.slice(0, 80)) {
        expect(batch.unknown.has(`${scope.userId}:${scope.accountId}`)).toBe(false);
        expect(batch.kinds.get(`${scope.userId}:${scope.accountId}`)).toBe("stopped");
      }
      // The scope in the chunk that failed was never read, so its cause is unknown.
      expect(batch.unknown.has(`${scopes[80].userId}:${scopes[80].accountId}`)).toBe(true);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("runs one refresh at a time when two callers ask for different scopes", async () => {
    const { causes } = await load();
    const first = await seedHalted("Refresh First");
    const second = await seedHalted("Refresh Second");

    let active = 0;
    let maxActive = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return [];
    });
    try {
      const [a, b] = await Promise.all([
        causes.batchedHaltCauseKinds([ref(first)]),
        causes.batchedHaltCauseKinds([ref(second)])
      ]);
      // Two refreshes at once are two reads of the same 19 GB table.  The second caller reuses
      // the running refresh instead of starting its own.
      expect(maxActive).toBe(1);
      expect(a.kinds.get(`${first.userId}:${first.accountId}`)).toBe("stopped");
      expect(b.kinds.get(`${second.userId}:${second.accountId}`)).toBe("stopped");
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("gives the caller back at the deadline when the runner never settles", async () => {
    const { causes } = await load();
    const account = await seedHalted("Deferred");
    const key = `${account.userId}:${account.accountId}`;

    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      return new Promise<never>(() => {
        // A runner that ignores its abort: it never settles and never rejects.
      });
    });
    const priorBudget = process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
    process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = "200";
    try {
      const started = Date.now();
      const batch = await causes.batchedHaltCauseKinds([ref(account)]);
      const elapsed = Date.now() - started;

      // Control: the never-settling runner is the read the caller gave up on.  Without this, an
      // early return that never reached the runner would pass the timing and unknown checks too.
      expect(invocations).toBe(1);
      // The caller does not wait for a runner that never settles: a health probe that misses its
      // deadline restarts the container, which re-runs the boot sweep.
      expect(elapsed).toBeLessThan(5_000);
      // The cause was never read, so it is unknown -- not a confirmed owner stop.
      expect(batch.unknown.has(key)).toBe(true);
    } finally {
      if (priorBudget === undefined) delete process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
      else process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = priorBudget;
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("keeps the pending queue bounded when a failing read requeues more scopes than the cap", async () => {
    const { causes } = await load();
    const many = Array.from({ length: 1002 }, () => ({
      userId: `user-${randomUUID()}`,
      accountId: `acct-${randomUUID()}`
    }));
    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      await causes.batchedHaltCauseKinds(many);
      // Control: the failing read ran, so the requeue path the cap guards was exercised.
      expect(invocations).toBeGreaterThan(0);
      // The cache has a cap; the queue that holds the scopes a failed read must retry had none,
      // so a fleet larger than the cache cap left the queue growing past it.
      expect(causes.__haltAuditPendingScopeCountForTests()).toBeLessThanOrEqual(1_000);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("keeps a confirmed app halt when the forced re-read cannot land, and does not keep a stale 'no halt'", async () => {
    const { db, causes } = await load();
    const breaker = await seedHalted("Confirmed Breaker");
    const quiet = await seedHalted("Confirmed Quiet");
    const breakerKey = `${breaker.userId}:${breaker.accountId}`;
    const quietKey = `${quiet.userId}:${quiet.accountId}`;
    db.audit(
      "policy_violation_drawdown",
      { reason: "Trailing drawdown breached the limit.", revertedTo: "halted" },
      breaker.userId,
      breaker.accountId
    );

    // A successful read confirms both answers: a breaker for one, no app halt for the other.
    const confirmed = await causes.batchedHaltCauseKinds([ref(breaker), ref(quiet)]);
    expect(confirmed.kinds.get(breakerKey)).toBe("breaker");
    expect(confirmed.kinds.get(quietKey)).toBe("stopped");
    expect(confirmed.unknown.size).toBe(0);

    // The app writes new halt rows for both, and the forced re-read fails.
    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      db.audit("broker_placement_auto_halted", { reason: "Broker health check timed out" }, breaker.userId, breaker.accountId);
      db.audit(
        "policy_violation_drawdown",
        { reason: "Trailing drawdown breached the limit.", revertedTo: "halted" },
        quiet.userId,
        quiet.accountId
      );
      const after = await causes.batchedHaltCauseKinds([ref(breaker), ref(quiet)]);

      // Control: the invalidation forced a re-read, and that re-read is the one that failed.
      expect(invocations).toBe(1);
      // The confirmed breaker survives the failed re-read.  The invalidation used to DELETE the
      // row, so this scope read as unknown -- and unknown counts toward idleness for the
      // fleet-dark page, which is how a confirmed breaker stopped paging.
      expect(after.unknown.has(breakerKey)).toBe(false);
      expect(after.kinds.get(breakerKey)).toBe("breaker");
      // A stale "no app halt" is NOT kept: the write that made it stale is the halt it is
      // missing, so serving it would read a fresh breaker as an owner stop.
      expect(after.unknown.has(quietKey)).toBe(true);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("re-reads a scope when the owner takes over an app halt", async () => {
    const { db, causes } = await load();
    const account = await seedHalted("Owner Takeover");
    const key = `${account.userId}:${account.accountId}`;
    db.audit("broker_placement_auto_halted", { reason: "Broker health check timed out" }, account.userId, account.accountId);
    const before = await causes.batchedHaltCauseKinds([ref(account)]);
    expect(before.kinds.get(key)).toBe("auto_pause_lost");

    // The owner overrides the pause while the account stays halted.  That row hands the halt over,
    // so the cause is now an owner stop.  Without invalidating on it, the cached
    // `handed_over: 0` row kept reporting an app halt for up to a TTL -- which can page the owner
    // about a stop they made themselves.
    db.audit("broker_placement_pause_owner_override", { reason: "owner took over" }, account.userId, account.accountId);
    const after = await causes.batchedHaltCauseKinds([ref(account)]);
    expect(after.kinds.get(key)).toBe("stopped");
    expect(after.unknown.has(key)).toBe(false);
    // Control: the live path reads the same scope and agrees.
    expect(
      causes.describeAutonomyHaltCause({
        userId: account.userId,
        connectedAccountId: account.accountId,
        accountNumber: account.accountNumber,
        systemState: "halted"
      })?.kind
    ).toBe("stopped");
  });

  it("does not re-read the audit table for an advisory drawdown row", async () => {
    const { db, causes } = await load();
    const account = await seedHalted("Advisory Drawdown");
    const key = `${account.userId}:${account.accountId}`;
    let reads = 0;
    const real = causes.__setHaltAuditRunnerForTests(null);
    causes.__setHaltAuditRunnerForTests((...args) => {
      reads += 1;
      return real(...args);
    });
    try {
      await causes.batchedHaltCauseKinds([ref(account)]);
      expect(reads).toBe(1);

      // The ADVISORY row is written on every breached strategy run and cannot halt the account,
      // so it must not force a fresh scan of the 19 GB audit table.
      db.audit("policy_violation_drawdown", { reason: "Trailing drawdown breached the limit." }, account.userId, account.accountId);
      const advisory = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(reads).toBe(1);
      expect(advisory.kinds.get(key)).toBe("stopped");

      // Control: the HARD row on the same scope does invalidate, so the zero above is the
      // advisory gate and not a dead hook.
      db.audit(
        "policy_violation_drawdown",
        { reason: "Trailing drawdown breached the limit.", revertedTo: "halted" },
        account.userId,
        account.accountId
      );
      const hard = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(reads).toBe(2);
      expect(hard.kinds.get(key)).toBe("breaker");
    } finally {
      causes.__setHaltAuditRunnerForTests(real);
    }
  });

  it("leaves other callers' pending scopes alone while the read is cooling down", async () => {
    const { causes } = await load();
    const first = await seedHalted("Cooldown First");
    const second = await seedHalted("Cooldown Second");
    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      // The failed read requeues the scope it did not cover, for the retry after the cooldown.
      await causes.batchedHaltCauseKinds([ref(first)]);
      expect(invocations).toBe(1);
      expect(causes.haltCauseReadStatus().coolingDown).toBe(true);
      expect(causes.__haltAuditPendingScopeCountForTests()).toBe(1);

      // A second caller arrives during the cooldown.  It must not wipe the shared queue: the
      // cooldown branch used to queue its own scope and then clear EVERY scope, including the one
      // queued for retry and any another caller queued for a refresh already running.
      const during = await causes.batchedHaltCauseKinds([ref(second)]);
      expect(during.unknown.has(`${second.userId}:${second.accountId}`)).toBe(true);
      expect(causes.__haltAuditPendingScopeCountForTests()).toBe(1);
      // Control: the cooldown held -- no second read ran.
      expect(invocations).toBe(1);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("does not let a released refresh overwrite the answer of the newer refresh", async () => {
    const { causes } = await load();
    const account = await seedHalted("Released Refresh");
    const key = `${account.userId}:${account.accountId}`;
    const breakerRow = {
      user_id: account.userId,
      connected_account_id: account.accountId,
      kind: "policy_violation_drawdown",
      created_at: new Date().toISOString(),
      payload: JSON.stringify({ reason: "newer answer", revertedTo: "halted" }),
      handed_over: 0
    };
    let releaseFirst: (rows: never[]) => void = () => undefined;
    let firstResolved = false;
    let calls = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        // Ignores its abort, and answers late with an OLDER answer ("no app halt").
        return new Promise<never[]>((resolve) => {
          releaseFirst = (rows) => {
            firstResolved = true;
            resolve(rows);
          };
        });
      }
      return [breakerRow];
    });
    const priorBudget = process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
    process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = "100";
    try {
      const stuck = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(stuck.unknown.has(key)).toBe(true);
      // Past the refresh's deadline plus the release grace: the shared pointer is released.
      await new Promise((resolve) => setTimeout(resolve, 450));

      const newer = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(calls).toBe(2);
      expect(newer.kinds.get(key)).toBe("breaker");

      // The released refresh finally answers, with the older "no app halt".
      releaseFirst([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Control: the late answer really was delivered to the old refresh.
      expect(firstResolved).toBe(true);

      // Its late write used to stamp `at = now` over the newer breaker, and the scope then read as
      // a confirmed owner stop for a whole TTL.
      const later = await causes.batchedHaltCauseKinds([ref(account)]);
      expect(later.kinds.get(key)).toBe("breaker");
      expect(later.unknown.has(key)).toBe(false);
      expect(calls).toBe(2);
    } finally {
      if (priorBudget === undefined) delete process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
      else process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS = priorBudget;
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });

  it("does not cache a pre-invalidation answer after the invalidation stamps were pruned", async () => {
    const { causes } = await load();
    const account = await seedHalted("Pruned Stamp");
    const key = `${account.userId}:${account.accountId}`;
    let calls = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        // While this read is in flight the scope is invalidated, and then more than the stamp
        // cap of other scopes are invalidated, which prunes this scope's (oldest) stamp.
        causes.invalidateHaltAuditCache(account.userId, account.accountId);
        for (let i = 0; i < 1_001; i += 1) causes.invalidateHaltAuditCache(`other-${i}`, `acct-${i}`);
        return [];
      }
      return [
        {
          user_id: account.userId,
          connected_account_id: account.accountId,
          kind: "policy_violation_drawdown",
          created_at: new Date().toISOString(),
          payload: JSON.stringify({ reason: "after the prune", revertedTo: "halted" }),
          handed_over: 0
        }
      ];
    });
    try {
      const batch = await causes.batchedHaltCauseKinds([ref(account)]);
      // With the stamp pruned, the pre-invalidation "no app halt" used to be cached as a
      // confirmed owner stop.  The pruned-generation fallback refuses it, so the scope is read
      // again and the newer row wins.
      expect(batch.kinds.get(key)).toBe("breaker");
      expect(batch.unknown.has(key)).toBe(false);
      // Control: the first answer was discarded, which is why a second read happened.
      expect(calls).toBe(2);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });
});
