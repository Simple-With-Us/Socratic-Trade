import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/strategy", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/strategy")>();
  return { ...actual, runStrategyOnce: vi.fn() };
});

import { runStrategyOnce } from "@/lib/strategy";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-drain-handoff-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  vi.mocked(runStrategyOnce).mockReset();
  const { resetStrategyRunExecutionsForTest } = await import("../src/lib/strategy-run-requests");
  resetStrategyRunExecutionsForTest();
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

describe("Manual Run once drain handoff (claimed worker)", () => {
  it("resumes a claimed running request with no heartbeat on the same run id", async () => {
    const db = await import("../src/lib/db");
    const {
      processPendingStrategyRunRequests,
      getStrategyRunRequest
    } = await import("../src/lib/strategy-run-requests");
    const userId = `drain-adopt-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    insertOpenRequest(db, { id: runId, userId, status: "running" });

    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId,
      status: "completed",
      summary: "green ran",
      proposals: []
    } as never);

    const result = await processPendingStrategyRunRequests({ limit: 1 });
    expect(result.processed).toBe(1);
    expect(result.adopted).toBe(1);
    expect(result.liveRunning).toBe(0);
    expect(runStrategyOnce).toHaveBeenCalledWith(userId, { manual: true, runId });
    expect(getStrategyRunRequest(runId, userId)).toMatchObject({
      status: "completed",
      result: { runId, summary: "green ran" }
    });
  });

  it("leaves a live in-process worker alone even when its heartbeat timestamp is older than 90s", async () => {
    const db = await import("../src/lib/db");
    const {
      beginStrategyRunExecution,
      processPendingStrategyRunRequests,
      STRATEGY_RUN_EXECUTION_STALE_MS
    } = await import("../src/lib/strategy-run-requests");
    const userId = `drain-live-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    insertOpenRequest(db, { id: runId, userId, status: "running" });
    // Same process, map entry present, beat older than the old 90s cutoff — the
    // 55–120s SQLite busy_timeout freezes from #2967.  Adopting here would
    // release the living run's lock and start a second gather/place.
    const execution = beginStrategyRunExecution(runId, Date.now() - STRATEGY_RUN_EXECUTION_STALE_MS - 30_000);

    const result = await processPendingStrategyRunRequests({ limit: 1 });
    expect(result.processed).toBe(0);
    expect(result.adopted).toBe(0);
    expect(result.liveRunning).toBe(1);
    expect(runStrategyOnce).not.toHaveBeenCalled();
    execution.stop();
  });

  it("insertStrategyRun is a no-op when the same id is still running (resume, do not mint a second)", async () => {
    const db = await import("../src/lib/db");
    const userId = `insert-resume-${randomUUID()}`;
    const runId = randomUUID();
    db.insertStrategyRun(runId, userId, "acct-a", "ACC-A");
    expect(() => db.insertStrategyRun(runId, userId, "acct-a", "ACC-A")).not.toThrow();
    const rows = db
      .getDb()
      .prepare("SELECT id, status FROM strategy_runs WHERE id = ?")
      .all(runId) as Array<{ id: string; status: string }>;
    expect(rows).toEqual([{ id: runId, status: "running" }]);
  });

  it("refuses to reuse a terminal strategy_runs row", async () => {
    const db = await import("../src/lib/db");
    const userId = `insert-terminal-${randomUUID()}`;
    const runId = randomUUID();
    db.insertStrategyRun(runId, userId);
    db.finishStrategyRun(runId, "failed", "sweep-failed stalled_no_progress", userId);
    expect(() => db.insertStrategyRun(runId, userId)).toThrow(/Cannot reuse strategy run/);
  });
});
