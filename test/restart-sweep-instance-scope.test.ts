import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ST-8.  PR #3138 sweeps every strategy run that started before this process booted.
// Three money-path holes: the restart arm fired on the first tick (no boot grace), a follower
// swept runs the leader still owned, and the sweep failed a running request the drain was
// about to adopt.  These cases pin all three.  Boot time and instance id are arguments, so the
// file does not depend on this worker's uptime.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-restart-scope-${randomUUID()}.db`)}`;
});

const STALE_THRESHOLD_MS = 30 * 60_000;
const LEADER = "leader-instance";
const FOLLOWER = "follower-instance";

type Db = typeof import("../src/lib/db");

async function loadDb(): Promise<Db> {
  return import("../src/lib/db");
}

function insertRun(
  db: Db,
  input: { runId: string; userId: string; ageMs: number; owner: string | null }
): void {
  db.insertStrategyRun(input.runId, input.userId, `acct-${input.userId}`);
  db.getDb()
    .prepare("UPDATE strategy_runs SET started_at = ?, owner_instance = ? WHERE id = ?")
    .run(new Date(Date.now() - input.ageMs).toISOString(), input.owner, input.runId);
}

function statusOf(db: Db, runId: string): string {
  return (db.getDb().prepare("SELECT status FROM strategy_runs WHERE id = ?").get(runId) as { status: string })
    .status;
}

function requestStatus(db: Db, runId: string): string | null {
  const row = db.getDb().prepare("SELECT status FROM strategy_run_requests WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

function insertRunningRequest(db: Db, input: { runId: string; userId: string; retryOf: string | null }): void {
  const now = new Date().toISOString();
  db.getDb()
    .prepare(
      `INSERT INTO strategy_run_requests
        (id, user_id, manual, status, result, created_at, started_at, finished_at, connected_account_id, retry_of_run_id)
       VALUES (?, ?, 1, 'running', NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(input.runId, input.userId, now, now, input.retryOf);
}

describe("restart sweep boot grace, instance scope, and drain adoption", () => {
  it("stamps owner_instance with this process when a run starts", async () => {
    const db = await loadDb();
    const { PROCESS_INSTANCE_ID } = await import("../src/lib/process-instance");
    const runId = randomUUID();
    db.insertStrategyRun(runId, `stamp-user-${randomUUID()}`);
    const row = db.getDb().prepare("SELECT owner_instance FROM strategy_runs WHERE id = ?").get(runId) as {
      owner_instance: string;
    };
    expect(row.owner_instance).toBe(PROCESS_INSTANCE_ID);
  });

  it("does not sweep a young prior-process run during boot grace, and does after the grace", async () => {
    const db = await loadDb();
    const { RESTART_SWEEP_BOOT_GRACE_MS } = await import("../src/lib/db-execution");
    const userId = `grace-user-${randomUUID()}`;
    const runId = randomUUID();
    const now = Date.now();
    const bootAfterGrace = now - RESTART_SWEEP_BOOT_GRACE_MS - 5_000;
    // One minute before the post-grace boot, so the row stays on the restart arm (not the 30-minute stall).
    insertRun(db, { runId, userId, ageMs: now - (bootAfterGrace - 60_000), owner: LEADER });

    db.markStaleRunningRuns(now, {
      reapUnowned: true,
      instanceId: FOLLOWER,
      processStartedMs: now
    });
    expect(statusOf(db, runId)).toBe("running");

    db.markStaleRunningRuns(now, {
      reapUnowned: true,
      instanceId: FOLLOWER,
      processStartedMs: bootAfterGrace
    });
    expect(statusOf(db, runId)).toBe("failed");
  });

  it("a follower never sweeps the leader's runs, including a time-stale one with no lease", async () => {
    const db = await loadDb();
    const userId = `follower-user-${randomUUID()}`;
    const youngId = randomUUID();
    const staleId = randomUUID();
    const now = Date.now();
    const { RESTART_SWEEP_BOOT_GRACE_MS } = await import("../src/lib/db-execution");
    const bootAfterGrace = now - RESTART_SWEEP_BOOT_GRACE_MS - 5_000;
    insertRun(db, { runId: youngId, userId, ageMs: now - (bootAfterGrace - 60_000), owner: LEADER });
    insertRun(db, { runId: staleId, userId, ageMs: 2 * STALE_THRESHOLD_MS, owner: LEADER });

    db.markStaleRunningRuns(now, {
      reapUnowned: false,
      instanceId: FOLLOWER,
      processStartedMs: bootAfterGrace
    });

    expect(statusOf(db, youngId)).toBe("running");
    expect(statusOf(db, staleId)).toBe("running");
  });

  it("the leader reaps a dead instance's run after the grace, and leaves one that still holds a lease", async () => {
    const db = await loadDb();
    const { RESTART_SWEEP_BOOT_GRACE_MS } = await import("../src/lib/db-execution");
    const userId = `leader-user-${randomUUID()}`;
    const deadId = randomUUID();
    const liveId = randomUUID();
    const now = Date.now();
    const bootAfterGrace = now - RESTART_SWEEP_BOOT_GRACE_MS - 5_000;
    const ageMs = now - (bootAfterGrace - 60_000);
    insertRun(db, { runId: deadId, userId, ageMs, owner: LEADER });
    insertRun(db, { runId: liveId, userId, ageMs, owner: LEADER });
    expect(db.acquireStrategyLock(liveId, userId, `acct-${userId}`)).toBe(true);

    const options = {
      reapUnowned: true,
      instanceId: FOLLOWER,
      processStartedMs: bootAfterGrace
    };
    db.markStaleRunningRuns(now, options);

    expect(statusOf(db, deadId)).toBe("failed");
    expect(statusOf(db, liveId)).toBe("running");
    db.releaseStrategyLock(liveId, userId, `acct-${userId}`);
  });

  it("does not pre-empt drain adoption of a running request, and still sweeps a restart retry", async () => {
    const db = await loadDb();
    const { RESTART_SWEEP_BOOT_GRACE_MS } = await import("../src/lib/db-execution");
    const now = Date.now();
    const bootAfterGrace = now - RESTART_SWEEP_BOOT_GRACE_MS - 5_000;
    const ageMs = now - (bootAfterGrace - 60_000);
    const options = {
      reapUnowned: true,
      instanceId: FOLLOWER,
      processStartedMs: bootAfterGrace
    };

    const adoptUser = `adopt-user-${randomUUID()}`;
    const adoptId = randomUUID();
    insertRun(db, { runId: adoptId, userId: adoptUser, ageMs, owner: LEADER });
    insertRunningRequest(db, { runId: adoptId, userId: adoptUser, retryOf: null });

    const retryUser = `retry-user-${randomUUID()}`;
    const retryId = randomUUID();
    insertRun(db, { runId: retryId, userId: retryUser, ageMs, owner: LEADER });
    insertRunningRequest(db, { runId: retryId, userId: retryUser, retryOf: randomUUID() });

    db.markStaleRunningRuns(now, options);

    expect(statusOf(db, adoptId)).toBe("running");
    expect(requestStatus(db, adoptId)).toBe("running");
    expect(statusOf(db, retryId)).toBe("failed");
    expect(requestStatus(db, retryId)).toBe("failed");
  });
});
