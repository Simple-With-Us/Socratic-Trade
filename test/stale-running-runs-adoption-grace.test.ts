import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Regression (#3138 restart sweep, P1 money path).  The immediate pre-boot arm of
// `markStaleRunningRuns` ("started_at < processBootCutoff") selects EVERY run that started before
// this process booted, however young.  Its only liveness graces were `isStrategyRunExecutionLive`,
// whose map is process-local by construction, and an audit-activity probe a seconds-old run has not
// populated yet — so on a multi-instance deploy or a rolling restart a run another node had
// legitimately adopted was marked `failed` mid-flight and its request row freed for a duplicate.
//
// `hasLiveStrategyRunLease` is the durable, cross-process grace: `runStrategyOnce` acquires the
// strategy run lock with the run id as `owner` BEFORE `insertStrategyRun` and releases it AFTER
// `finishStrategyRun`, and `startStrategyLockGuard` renews it every 60s with a 5-minute TTL.
//
// Kept in its own file rather than appended to `stale-running-runs.test.ts` because these cases
// depend on this worker's boot instant (`process.uptime()`), and that file's own
// "started only 1 minute before boot" case is already sensitive to how long the file has been
// running — adding work ahead of it pushes it past its implicit one-minute budget.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-adoption-grace-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  // These cases assert lease behaviour with the restart arm already eligible.  A fresh vitest
  // worker is still inside the boot grace, which would hide the expired-lease sweep.
  const { RESTART_SWEEP_BOOT_GRACE_MS, setProcessStartedAtMsForTests } = await import("../src/lib/db-execution");
  setProcessStartedAtMsForTests(Date.now() - RESTART_SWEEP_BOOT_GRACE_MS - 60_000);
});

afterEach(async () => {
  const { setProcessStartedAtMsForTests } = await import("../src/lib/db-execution");
  setProcessStartedAtMsForTests(null);
});

const STALE_THRESHOLD_MS = 30 * 60_000; // matches db-execution.ts's STALE_RUN_THRESHOLD_MS

function crashedReceipts(
  db: typeof import("../src/lib/db"),
  userId: string
): Array<{ payload: string }> {
  return db
    .getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = 'strategy_run_crashed' AND user_id = ?")
    .all(userId) as Array<{ payload: string }>;
}

function insertPreBootRun(
  db: typeof import("../src/lib/db"),
  input: { runId: string; userId: string; accountId?: string; ageMs: number }
): void {
  db.insertStrategyRun(input.runId, input.userId, input.accountId);
  db.getDb()
    .prepare("UPDATE strategy_runs SET started_at = ? WHERE id = ?")
    .run(new Date(Date.now() - input.ageMs).toISOString(), input.runId);
}

function runStatus(db: typeof import("../src/lib/db"), runId: string): string {
  return (db.getDb().prepare("SELECT status FROM strategy_runs WHERE id = ?").get(runId) as {
    status: string;
  }).status;
}

describe("markStaleRunningRuns adoption grace", () => {
  it("leaves a pre-boot run alone while another node holds a live strategy run lease", async () => {
    const db = await import("../src/lib/db");
    const userId = `adopted-live-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const runId = randomUUID();
    // 20 minutes old: before this process booted (so the restart arm selects it) but well inside
    // the 30-minute stale window (so ONLY the restart arm selects it).
    insertPreBootRun(db, { runId, userId, accountId, ageMs: 20 * 60_000 });
    // Exactly what runStrategyOnce does before insertStrategyRun: owner === runId.
    expect(db.acquireStrategyLock(runId, userId, accountId)).toBe(true);

    db.markStaleRunningRuns(Date.now());

    expect(runStatus(db, runId)).toBe("running");
    expect(crashedReceipts(db, userId)).toHaveLength(0);
    db.releaseStrategyLock(runId, userId, accountId);
  });

  it("still sweeps a pre-boot run whose strategy run lease has expired", async () => {
    const db = await import("../src/lib/db");
    const userId = `adopted-expired-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const runId = randomUUID();
    insertPreBootRun(db, { runId, userId, accountId, ageMs: 20 * 60_000 });
    // Lease taken 10 minutes ago with the production 5-minute TTL — expired, so the owning process
    // is gone and nothing is renewing it.  This is the crashed leftover the sweep exists for.
    expect(
      db.acquireStrategyLock(runId, userId, accountId, 5 * 60_000, new Date(Date.now() - 10 * 60_000))
    ).toBe(true);

    db.markStaleRunningRuns(Date.now());

    expect(runStatus(db, runId)).toBe("failed");
    expect(JSON.parse(crashedReceipts(db, userId)[0].payload).reason).toBe("process_restarted_mid_run");
  });

  it("still sweeps a time-stale run even while its lease is being renewed (wedged, not adopted)", async () => {
    const db = await import("../src/lib/db");
    const userId = `wedged-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const runId = randomUUID();
    // Past STALE_RUN_THRESHOLD_MS: the lease grace must NOT apply, or a run whose lock-guard
    // interval keeps ticking while its work is wedged would never be swept — the exact stuck-run
    // bug #3138 set out to fix.
    insertPreBootRun(db, { runId, userId, accountId, ageMs: 2 * STALE_THRESHOLD_MS });
    expect(db.acquireStrategyLock(runId, userId, accountId)).toBe(true);

    db.markStaleRunningRuns(Date.now());

    expect(runStatus(db, runId)).toBe("failed");
    db.releaseStrategyLock(runId, userId, accountId);
  });

  it("hasLiveStrategyRunLease matches both the legacy user-wide and account-scoped lock keys", async () => {
    const db = await import("../src/lib/db");
    const userId = `lease-key-user-${randomUUID()}`;
    const runId = randomUUID();
    expect(db.hasLiveStrategyRunLease(runId, userId)).toBe(false);
    // Acquired without an account id — `strategyLockKey` writes the legacy user-wide key.
    expect(db.acquireStrategyLock(runId, userId)).toBe(true);
    expect(db.hasLiveStrategyRunLease(runId, userId)).toBe(true);
    // …and the account-scoped key shape is matched too.
    const accountId = `acct-${randomUUID()}`;
    const accountRunId = randomUUID();
    expect(db.acquireStrategyLock(accountRunId, userId, accountId)).toBe(true);
    expect(db.hasLiveStrategyRunLease(accountRunId, userId)).toBe(true);
    // A run id that holds no lock is not alive, even while another run's lock exists.
    expect(db.hasLiveStrategyRunLease(randomUUID(), userId)).toBe(false);
    db.releaseStrategyLock(runId, userId);
    expect(db.hasLiveStrategyRunLease(runId, userId)).toBe(false);
    db.releaseStrategyLock(accountRunId, userId, accountId);
  });
});
