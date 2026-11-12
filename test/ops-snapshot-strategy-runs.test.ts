import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-runs-${randomUUID()}.db`)}`;
});

describe("ops snapshot strategy run listing", () => {
  it("counts proposals per run without a strategy_runs JOIN", async () => {
    const db = await import("../src/lib/db");
    const userId = `runs-user-${randomUUID()}`;
    const accountId = randomUUID();
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "RUNS-1",
      label: "Runs",
      isActive: true
    });
    const runId = randomUUID();
    db.insertStrategyRun(runId, userId, accountId);
    db.finishStrategyRun(runId, "completed", "ok", userId);
    db.insertProposal({
      id: randomUUID(),
      userId,
      runId,
      accountNumber: "RUNS-1",
      proposal: {
        symbol: "SPY",
        side: "buy",
        type: "market",
        dollarAmount: 10,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "test",
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] },
      estimatedNotional: 10,
      status: "filled",
      executionMode: "broker/paper"
    });

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = await buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 1 });
    const user = snapshot.users.find((row) => row.userId === userId);
    const run = user?.recentRuns.find((row) => row.id === runId);
    expect(run?.placedCount).toBe(1);
    expect(run?.proposedCount).toBe(0);
  });
});
