import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Focused coverage for the crashed-run stale-row sweep (markStaleRunningRuns) wired into the
// scheduler tick. Verifies: (1) a genuinely stale running row is marked failed and receipts
// exactly one account-scoped `strategy_run_crashed` audit; (2) a fresh running row is left
// alone; (3) re-running the sweep is idempotent and never double-receipts.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-runs-${randomUUID()}.db`)}`;
});

const STALE_THRESHOLD_MS = 30 * 60_000; // matches db-execution.ts's STALE_RUN_THRESHOLD_MS

function crashedReceipts(
  db: typeof import("../src/lib/db"),
  userId: string
): Array<{ connected_account_id: string | null; payload: string }> {
  return db
    .getDb()
    .prepare(
      "SELECT connected_account_id, payload FROM audit_events WHERE kind = 'strategy_run_crashed' AND user_id = ?"
    )
    .all(userId) as Array<{ connected_account_id: string | null; payload: string }>;
}

describe("markStaleRunningRuns", () => {
  it("marks a stale running run failed and writes exactly one account-scoped receipt", async () => {
    const db = await import("../src/lib/db");
    const userId = `stale-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId, accountId);
    // Simulate the tick firing well after the run started (started_at is ~now, so a `now`
    // 20 min in the future puts it past the 10 min stale cutoff).
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    expect(db.markStaleRunningRuns(future)).toBe(1);

    const row = db
      .getDb()
      .prepare("SELECT status, summary FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("stale-run sweep");
    expect(row.summary).toContain("stalled with no progress");
    expect(row.summary).not.toContain("Process restarted mid-run");

    const receipts = crashedReceipts(db, userId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].connected_account_id).toBe(accountId);
    expect(JSON.parse(receipts[0].payload).runId).toBe(runId);
    expect(JSON.parse(receipts[0].payload).haltExempt).toBe(true);
    expect(JSON.parse(receipts[0].payload).reason).toBe("stalled_no_progress");

    // Idempotent: the row is already failed, so a second sweep neither re-counts nor re-receipts.
    expect(db.markStaleRunningRuns(future)).toBe(0);
    expect(crashedReceipts(db, userId)).toHaveLength(1);
  });

  function insertOpenRequest(
    db: typeof import("../src/lib/db"),
    input: { id: string; userId: string; status?: "queued" | "running"; createdAt?: string }
  ): void {
    db.getDb()
      .prepare(
        `INSERT INTO strategy_run_requests
          (id, user_id, manual, status, result, created_at, started_at, finished_at)
         VALUES (?, ?, 1, ?, NULL, ?, ?, NULL)`
      )
      .run(
        input.id,
        input.userId,
        input.status ?? "running",
        input.createdAt ?? new Date().toISOString(),
        input.status === "queued" ? null : new Date().toISOString()
      );
  }

  it("sweep-fails a stale run and closes its running request so the next Manual Run once is not deduped", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `sweep-lock-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    insertOpenRequest(db, { id: runId, userId, status: "running" });

    const blocked = queueStrategyRunRequest({ userId, manual: true });
    expect(blocked.deduped).toBe(true);
    expect(blocked.request.id).toBe(runId);

    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    db.markStaleRunningRuns(future);

    const request = db
      .getDb()
      .prepare("SELECT status, finished_at FROM strategy_run_requests WHERE id = ?")
      .get(runId) as { status: string; finished_at: string | null };
    expect(request.status).toBe("failed");
    expect(request.finished_at).toBeTruthy();

    const next = queueStrategyRunRequest({ userId, manual: true });
    expect(next.deduped).toBe(false);
    expect(next.request.id).not.toBe(runId);
    expect(next.request.status).toBe("queued");
  });

  it("heals an already-failed run whose request is still running (live Roth orphan shape)", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `heal-orphan-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    db.finishStrategyRun(
      runId,
      "failed",
      "Process restarted mid-run — marked failed by stale-run sweep (started at 2026-08-18T21:42:29.623Z)",
      userId
    );
    // finishStrategyRun now closes the request; recreate the pre-fix orphan: terminal run,
    // request still running.  ASC 0e5ccd66: 0 new Roth strategy_runs after 22:06:43Z because
    // the leftover running request locked every later click.
    db.getDb()
      .prepare(
        `INSERT INTO strategy_run_requests
          (id, user_id, manual, status, result, created_at, started_at, finished_at)
         VALUES (?, ?, 1, 'running', NULL, ?, ?, NULL)`
      )
      .run(runId, userId, new Date().toISOString(), new Date().toISOString());

    // Next Manual Run once must not wait for a scheduler tick.
    const next = queueStrategyRunRequest({ userId, manual: true });
    expect(next.deduped).toBe(false);
    expect(next.request.id).not.toBe(runId);

    const request = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(runId) as { status: string };
    expect(request.status).toBe("failed");
  });

  it("does not close another user's fresh running request when healing an orphan", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userA = `orphan-user-a-${randomUUID()}`;
    const userB = `live-user-b-${randomUUID()}`;
    const orphanId = randomUUID();
    const liveId = randomUUID();

    db.insertStrategyRun(orphanId, userA);
    db.finishStrategyRun(orphanId, "failed", "stale-run sweep", userA);
    db.getDb()
      .prepare(
        `INSERT INTO strategy_run_requests
          (id, user_id, manual, status, result, created_at, started_at, finished_at)
         VALUES (?, ?, 1, 'running', NULL, ?, ?, NULL)`
      )
      .run(orphanId, userA, new Date().toISOString(), new Date().toISOString());

    db.insertStrategyRun(liveId, userB);
    insertOpenRequest(db, { id: liveId, userId: userB, status: "running" });

    db.markStaleRunningRuns(Date.now());

    const orphan = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(orphanId) as { status: string };
    const live = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(liveId) as { status: string };
    expect(orphan.status).toBe("failed");
    expect(live.status).toBe("running");
    expect(queueStrategyRunRequest({ userId: userA, manual: true }).deduped).toBe(false);
    expect(queueStrategyRunRequest({ userId: userB, manual: true }).deduped).toBe(true);
  });

  it("leaves a fresh running run and its request untouched", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `fresh-request-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    insertOpenRequest(db, { id: runId, userId, status: "running" });

    db.markStaleRunningRuns(Date.now());

    const request = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(runId) as { status: string };
    expect(request.status).toBe("running");
    expect(queueStrategyRunRequest({ userId, manual: true }).deduped).toBe(true);
  });

  it("finishStrategyRun failed closes the matching running request", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `finish-close-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    insertOpenRequest(db, { id: runId, userId, status: "running" });
    db.finishStrategyRun(runId, "failed", "LLM threw", userId);

    const request = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(runId) as { status: string };
    expect(request.status).toBe("failed");
    expect(queueStrategyRunRequest({ userId, manual: true }).deduped).toBe(false);
  });

  it("sweep-fails a stale running request that has no strategy_runs row", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `stranded-request-user-${randomUUID()}`;
    const requestId = randomUUID();
    const createdAt = new Date(Date.now() - 2 * STALE_THRESHOLD_MS).toISOString();

    insertOpenRequest(db, { id: requestId, userId, status: "running", createdAt });

    const next = queueStrategyRunRequest({ userId, manual: true });
    expect(next.deduped).toBe(false);
    expect(next.request.id).not.toBe(requestId);

    const request = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(requestId) as { status: string };
    expect(request.status).toBe("failed");
  });

  it("leaves a fresh running request with no strategy_runs row alone (worker just claimed)", async () => {
    const db = await import("../src/lib/db");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `fresh-stranded-user-${randomUUID()}`;
    const requestId = randomUUID();

    insertOpenRequest(db, { id: requestId, userId, status: "running" });

    expect(queueStrategyRunRequest({ userId, manual: true }).deduped).toBe(true);
    const request = db
      .getDb()
      .prepare("SELECT status FROM strategy_run_requests WHERE id = ?")
      .get(requestId) as { status: string };
    expect(request.status).toBe("running");
  });

  it("leaves a fresh (non-stale) running run untouched", async () => {
    const db = await import("../src/lib/db");
    const userId = `fresh-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    // A sweep evaluated at the present moment: a run started ~now is not yet past the cutoff.
    expect(db.markStaleRunningRuns(Date.now())).toBe(0);

    const row = db
      .getDb()
      .prepare("SELECT status FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(row.status).toBe("running");
    expect(crashedReceipts(db, userId)).toHaveLength(0);
  });

  // 2026-07-08 incident regression: a live evening run (LLM steps 150s+ each) was marked "crashed"
  // by this sweep at the ~11-minute mark under the old 10-min threshold and completed 5s later,
  // having already placed 4 real trades. Beyond the raised 30-min threshold, a run that's still
  // emitting audit activity (any row carrying its runId, timestamped inside the sweep's lookback
  // window) is demonstrably still alive — just slow — and must be left alone.
  it("leaves a time-stale running run alone when it has recent audit activity (still alive, just slow)", async () => {
    const db = await import("../src/lib/db");
    const userId = `heartbeat-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    // Evaluate the sweep well past the 30-min cutoff relative to the run's real (~now) started_at.
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    // Simulate the run still being alive: an audit row carrying this runId, timestamped just before
    // the sweep's evaluation instant — well inside the [future - threshold, future] lookback window.
    db.getDb()
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)"
      )
      .run(randomUUID(), userId, new Date(future - 1000).toISOString(), "llm_step", JSON.stringify({ runId, step: "bull" }));

    // NOTE: don't assert on markStaleRunningRuns' raw return value here — this file shares one DB
    // across `it` blocks, and an earlier test's leftover `running` row (e.g. the "fresh" test above,
    // whose row is still real-time-fresh at ITS OWN evaluation but is old enough to be swept by
    // THIS test's synthetic far-future `now`) can also legitimately get marked failed in the same
    // sweep, inflating the count. Scope the assertion to this test's own run/user instead.
    db.markStaleRunningRuns(future);

    const row = db
      .getDb()
      .prepare("SELECT status FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(row.status).toBe("running");
    expect(crashedReceipts(db, userId)).toHaveLength(0);
  });

  it("still marks a time-stale running run failed when it has NO recent audit activity", async () => {
    const db = await import("../src/lib/db");
    const userId = `no-heartbeat-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    // An audit row exists for this run, but it's OLDER than the lookback window (simulating stale
    // history from long before the crash) — it must not grant grace.
    db.getDb()
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)"
      )
      .run(randomUUID(), userId, new Date(0).toISOString(), "llm_step", JSON.stringify({ runId, step: "bull" }));

    // See the note in the previous test — scope to this run/user rather than the global count.
    db.markStaleRunningRuns(future);

    const row = db
      .getDb()
      .prepare("SELECT status, summary FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("stalled with no progress");
    expect(row.summary).not.toContain("Process restarted mid-run");
    expect(crashedReceipts(db, userId)).toHaveLength(1);
    expect(JSON.parse(crashedReceipts(db, userId)[0].payload).reason).toBe("stalled_no_progress");
    expect(JSON.parse(crashedReceipts(db, userId)[0].payload).haltExempt).toBe(true);
  });

  it("does not call a same-process stall a restart (Roth b3b83913 shape)", async () => {
    const { staleRunningRunSweepCause, staleRunningRunSweepSummary } = await import("../src/lib/db-execution");
    const processStartedMs = Date.parse("2026-08-18T23:10:43.000Z");
    const startedAt = "2026-08-18T23:13:25.000Z";
    expect(staleRunningRunSweepCause(startedAt, processStartedMs)).toBe("stalled_no_progress");
    expect(staleRunningRunSweepSummary(startedAt, processStartedMs)).toContain("stalled with no progress");
    expect(staleRunningRunSweepSummary(startedAt, processStartedMs)).not.toContain("Process restarted");
  });

  it("labels a run that predates this process as a restart leftover", async () => {
    const db = await import("../src/lib/db");
    const userId = `prior-process-user-${randomUUID()}`;
    const runId = randomUUID();
    const startedAt = new Date(Date.now() - 2 * STALE_THRESHOLD_MS).toISOString();

    db.insertStrategyRun(runId, userId);
    db.getDb().prepare("UPDATE strategy_runs SET started_at = ? WHERE id = ?").run(startedAt, runId);

    expect(db.markStaleRunningRuns(Date.now())).toBe(1);
    const row = db
      .getDb()
      .prepare("SELECT status, summary FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("Process restarted mid-run");
    expect(JSON.parse(crashedReceipts(db, userId)[0].payload).reason).toBe("process_restarted_mid_run");
    expect(JSON.parse(crashedReceipts(db, userId)[0].payload).haltExempt).toBe(true);
  });

  it("immediately sweeps a prior-process run that started only 1 minute before boot without waiting 30 minutes", async () => {
    const db = await import("../src/lib/db");
    const userId = `recent-restart-user-${randomUUID()}`;
    const runId = randomUUID();
    // Simulate run started 1 minute ago, but process booted 10 seconds ago
    const startedAt = new Date(Date.now() - 60_000).toISOString();

    db.insertStrategyRun(runId, userId);
    db.getDb().prepare("UPDATE strategy_runs SET started_at = ? WHERE id = ?").run(startedAt, runId);

    // Running sweep now should immediately catch it as process_restarted_mid_run
    expect(db.markStaleRunningRuns(Date.now())).toBe(1);
    const row = db
      .getDb()
      .prepare("SELECT status, summary FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("Process restarted mid-run");
  });
});

// Regression (2026-08-18, #2848 follow-up): `db-execution` is reachable from the BROWSER bundle
// through the `db` barrel (app/console/settings/brokers.tsx -> venue-contract -> source-settings ->
// db-api-keys -> db).  Next's browser `process` shim has no `uptime`, so a module-scope
// `process.uptime()` threw "process.uptime is not a function" and took down /console/connections.
// The boot instant must be captured lazily and guarded so evaluating the module never throws.
describe("db-execution module load without process.uptime (browser-shaped process)", () => {
  it("evaluates and still classifies stale runs when process.uptime is missing", async () => {
    const { vi } = await import("vitest");
    const realUptime = process.uptime;
    vi.resetModules();
    // Mirror Next's client shim: `process` exists (env only), `uptime` is undefined.
    (process as unknown as { uptime?: unknown }).uptime = undefined;
    try {
      const mod = await import("../src/lib/db-execution");
      // Lazy accessor with uptime=0 -> boot ~= now, so a run that started long ago reads as a
      // prior-process leftover and a run that starts now reads as a same-process stall.
      expect(mod.staleRunningRunSweepCause(new Date(Date.now() - 60 * 60_000).toISOString())).toBe(
        "process_restarted_mid_run"
      );
      expect(mod.staleRunningRunSweepCause(new Date(Date.now() + 5_000).toISOString())).toBe(
        "stalled_no_progress"
      );
    } finally {
      (process as unknown as { uptime?: unknown }).uptime = realUptime;
      vi.resetModules();
    }
  });
});
