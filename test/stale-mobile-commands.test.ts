import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Coverage for markStaleRunningMobileCommands — the crashed-command sweep wired into the scheduler
// tick. Before it existed, claimNextQueuedCommand was the ONLY writer of status='running' and
// nothing ever read that status back, so a crash mid-command stranded the row forever: account
// deletion stayed blocked on activeMobileCommands permanently and mobileCommandBacklog().running
// never returned to zero. These tests pin the repair, the liveness graces that keep a slow-but-alive
// command from being declared dead, and the honesty of the recorded outcome.

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  purgePrivateVectorRecordsForUser: vi.fn(async () => ({ ids: [], contentHashes: [], deleted: 0 }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-mobile-commands-${randomUUID()}.db`)}`;
});

const STALE_THRESHOLD_MS = 30 * 60_000; // matches STALE_MOBILE_COMMAND_THRESHOLD_MS in mobile-api.ts

/** Queue a command and force it into the 'running' state a worker would have claimed it into. */
async function queueRunningCommand(
  userId: string,
  commandType: "watchlist.add" | "strategy.run_once" | "proposal.approve",
  payload: Record<string, unknown>,
  startedAt: string = new Date().toISOString()
): Promise<string> {
  const { queueMobileCommand } = await import("../src/lib/mobile-api");
  const { getDb } = await import("../src/lib/db");
  const { command } = queueMobileCommand({ userId, commandType, payload });
  getDb()
    .prepare("UPDATE mobile_commands SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?")
    .run(startedAt, startedAt, command.id);
  return command.id;
}

async function commandRow(id: string): Promise<{ status: string; error: string | null; finished_at: string | null }> {
  const { getDb } = await import("../src/lib/db");
  return getDb()
    .prepare("SELECT status, error, finished_at FROM mobile_commands WHERE id = ?")
    .get(id) as { status: string; error: string | null; finished_at: string | null };
}

async function receipts(userId: string, kind: string): Promise<Array<Record<string, unknown>>> {
  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ? AND user_id = ?")
    .all(kind, userId) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("markStaleRunningMobileCommands", () => {
  it("marks a stale running command failed with an honest unknown-outcome record, exactly once", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const userId = `stale-cmd-user-${randomUUID()}`;
    const id = await queueRunningCommand(userId, "watchlist.add", { symbol: "AAPL" });

    // Evaluate the sweep well past the 30-min cutoff relative to the command's (~now) started_at.
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    expect(markStaleRunningMobileCommands(future)).toBe(1);

    const row = await commandRow(id);
    expect(row.status).toBe("failed");
    expect(row.finished_at).not.toBeNull();
    // The money-path honesty requirement: the sweep knows the worker stopped reporting, NOT that
    // the command failed to execute. Claiming it failed would invite a duplicate order.
    expect(row.error).toContain("UNKNOWN");
    expect(row.error).toContain("Check your orders");
    expect(row.error).not.toMatch(/failed to (execute|run)/i);

    const crashed = await receipts(userId, "mobile_command_crashed");
    expect(crashed).toHaveLength(1);
    expect(crashed[0].commandId).toBe(id);
    expect(crashed[0].commandType).toBe("watchlist.add");

    // Idempotent under a second sweep (and under a concurrent scheduler instance): the row is no
    // longer 'running', so the guarded UPDATE changes nothing and no duplicate receipt is written.
    expect(markStaleRunningMobileCommands(future)).toBe(0);
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(1);
  });

  it("leaves a fresh (non-stale) running command untouched", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const userId = `fresh-cmd-user-${randomUUID()}`;
    const id = await queueRunningCommand(userId, "watchlist.add", { symbol: "MSFT" });

    expect(markStaleRunningMobileCommands(Date.now())).toBe(0);

    expect((await commandRow(id)).status).toBe("running");
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(0);
  });

  // strategy.run_once wraps runStrategyOnce, whose LLM steps are exactly what forced the strategy-run
  // threshold up to 30 min after the 2026-07-08 incident (a live run was declared dead while it was
  // still placing real trades). The command must inherit that grace via its own strategy_runs row.
  it("spares a time-stale strategy.run_once whose strategy run is still alive", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const { insertStrategyRun } = await import("../src/lib/db");
    const userId = `run-once-user-${randomUUID()}`;
    const id = await queueRunningCommand(userId, "strategy.run_once", {});
    insertStrategyRun(randomUUID(), userId);

    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    // NOTE: don't assert the raw return value — this file shares one DB across `it` blocks, so a
    // prior test's still-'running' row can legitimately be swept by this test's far-future `now`.
    markStaleRunningMobileCommands(future);

    expect((await commandRow(id)).status).toBe("running");
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(0);
  });

  it("sweeps a time-stale strategy.run_once once its strategy run is no longer running", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const { insertStrategyRun, finishStrategyRun } = await import("../src/lib/db");
    const userId = `run-once-dead-user-${randomUUID()}`;
    const id = await queueRunningCommand(userId, "strategy.run_once", {});
    const runId = randomUUID();
    insertStrategyRun(runId, userId);
    // The scheduler sweeps strategy_runs on the same tick and with the same threshold, so a run
    // that is genuinely dead is already terminal by the time this sweep looks at the command.
    finishStrategyRun(runId, "failed", "stale-run sweep", userId);

    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    markStaleRunningMobileCommands(future);

    expect((await commandRow(id)).status).toBe("failed");
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(1);
  });

  // The worst outcome this sweep can produce is telling an operator "outcome unknown" while the
  // broker submission is still in flight — the natural response to that is a duplicate manual
  // order. executeProposal receipts every approval step under the proposal's id, so recent audit
  // activity for that proposalId is proof the approval is slow, not dead.
  it("spares a time-stale proposal.approve that is still emitting approval receipts", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const { getDb } = await import("../src/lib/db");
    const userId = `approve-live-user-${randomUUID()}`;
    const proposalId = randomUUID();
    const id = await queueRunningCommand(userId, "proposal.approve", { proposalId });

    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    getDb()
      .prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(
        randomUUID(),
        userId,
        new Date(future - 1000).toISOString(),
        "order_placement_uncertain",
        JSON.stringify({ proposalId, symbol: "AAPL" })
      );

    markStaleRunningMobileCommands(future);

    expect((await commandRow(id)).status).toBe("running");
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(0);
  });

  it("sweeps a time-stale proposal.approve whose receipts predate the lookback window", async () => {
    const { markStaleRunningMobileCommands } = await import("../src/lib/mobile-api");
    const { getDb } = await import("../src/lib/db");
    const userId = `approve-dead-user-${randomUUID()}`;
    const proposalId = randomUUID();
    const id = await queueRunningCommand(userId, "proposal.approve", { proposalId });

    // Receipts exist, but from long before the cutoff — stale history must not grant grace.
    getDb()
      .prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(randomUUID(), userId, new Date(0).toISOString(), "proposal_approved", JSON.stringify({ proposalId }));

    const future = Date.now() + 2 * STALE_THRESHOLD_MS;
    markStaleRunningMobileCommands(future);

    const row = await commandRow(id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("UNKNOWN");
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(1);
  });

  it("clears the permanent account-deletion deadlock and the stuck backlog counter", async () => {
    const { markStaleRunningMobileCommands, mobileCommandBacklog } = await import("../src/lib/mobile-api");
    const { getAccountDeletionBlockers } = await import("../src/lib/account-deletion");
    const userId = `deletion-blocked-user-${randomUUID()}`;
    const id = await queueRunningCommand(userId, "watchlist.add", { symbol: "NVDA" });

    // Before the sweep this is the permanent-block state: deletion counts 'queued'/'running'
    // commands and waits for them to drain, and a stranded row never drains.
    expect(getAccountDeletionBlockers(userId).activeMobileCommands).toBe(1);
    const runningBefore = mobileCommandBacklog(userId).running;

    markStaleRunningMobileCommands(Date.now() + 2 * STALE_THRESHOLD_MS);

    expect((await commandRow(id)).status).toBe("failed");
    expect(getAccountDeletionBlockers(userId).activeMobileCommands).toBe(0);
    // The permanently-wrong backlog gauge comes back down for THIS user (api-contract-web-ios:api-10 —
    // mobileCommandBacklog is now scoped by user_id, so this no longer needs to tolerate other users'
    // rows via a delta; it is asserted as a hard zero).
    expect(runningBefore).toBe(1);
    expect(mobileCommandBacklog(userId).running).toBe(0);
  });

  // Regression for the race the sweep introduces: finishCommand used to UPDATE with no status
  // guard, so a slow-but-alive worker reporting in AFTER the sweep silently overwrote the crashed
  // record and left an unexplained mobile_command_crashed -> mobile_command_succeeded pair. The
  // worker's outcome is ground truth and still wins, but the correction must be receipted.
  it("receipts a late worker completion instead of silently clobbering the crashed record", async () => {
    const { markStaleRunningMobileCommands, executeMobileCommand } = await import("../src/lib/mobile-api");
    const userId = `late-finish-user-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const id = await queueRunningCommand(userId, "watchlist.add", { symbol: "TSLA" }, startedAt);

    markStaleRunningMobileCommands(Date.now() + 2 * STALE_THRESHOLD_MS);
    expect((await commandRow(id)).status).toBe("failed");

    // The worker that the sweep declared dead finishes anyway, with the real outcome.
    const completed = await executeMobileCommand({
      id,
      userId,
      commandType: "watchlist.add",
      status: "running",
      payload: { symbol: "TSLA" },
      createdAt: startedAt,
      queuedAt: startedAt,
      startedAt,
      updatedAt: startedAt
    });

    expect(completed.status).toBe("succeeded");
    expect((await commandRow(id)).status).toBe("succeeded");

    const late = await receipts(userId, "mobile_command_late_completion");
    expect(late).toHaveLength(1);
    expect(late[0].commandId).toBe(id);
    expect(late[0].supersededStatus).toBe("failed");
    expect(late[0].status).toBe("succeeded");
    // The crash receipt survives — the audit trail keeps both halves of the sequence.
    expect(await receipts(userId, "mobile_command_crashed")).toHaveLength(1);
  });
});
