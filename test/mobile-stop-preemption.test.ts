import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const strategyMocks = vi.hoisted(() => ({
  rejectProposal: vi.fn(),
  runStrategyOnce: vi.fn()
}));

vi.mock("../src/lib/strategy", () => strategyMocks);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-stop-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  strategyMocks.rejectProposal.mockReset();
  strategyMocks.runStrategyOnce.mockReset();
});

describe("immediate mobile protective state", () => {
  it("halts while run_once is still in flight and cancels queued risk-increasing work", async () => {
    let releaseRun!: () => void;
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    strategyMocks.runStrategyOnce.mockImplementation(async () => {
      markRunStarted();
      await runReleased;
      return { runId: "run-1", status: "completed", summary: "done", proposals: [] };
    });

    const db = await import("../src/lib/db");
    const mobile = await import("../src/lib/mobile-api");
    const guard = await import("../src/lib/system-state-placement-guard");
    const userId = `mobile-stop-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `PAPER-${randomUUID()}`,
      label: "Stop preemption",
      isActive: true
    });
    db.setPolicy(
      {
        ...db.getPolicy(userId, accountId),
        systemState: "active",
        additionalSymbols: ["AAPL"]
      },
      userId,
      accountId
    );

    const running = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.run_once",
      idempotencyKey: "run-before-stop"
    });
    const worker = mobile.processPendingMobileCommands({ limit: 1 });
    await runStarted;
    expect(mobile.getMobileCommand(running.command.id, userId)?.status).toBe("running");

    const queuedStart = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.start",
      idempotencyKey: "start-behind-run"
    });
    const stop = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.stop",
      idempotencyKey: "protect-now"
    });
    const stopped = await mobile.executeProtectiveMobileCommandImmediately(
      stop.command.id,
      userId
    );

    expect(stopped.status).toBe("succeeded");
    expect(db.getPolicy(userId, accountId).systemState).toBe("halted");
    expect(mobile.getMobileCommand(queuedStart.command.id, userId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because strategy.stop took immediate effect."
    });
    // The provider-backed run cannot be synchronously aborted, but its final placement boundary
    // now reads this durable halt before any new broker submission.
    expect(mobile.getMobileCommand(running.command.id, userId)?.status).toBe("running");
    expect(guard.freshPlacementBlockReason({
      userId,
      connectedAccountId: accountId,
      side: "buy"
    })).toContain("halted before broker submission");

    releaseRun();
    await worker;
    expect(mobile.getMobileCommand(running.command.id, userId)?.status).toBe("succeeded");
  });

  it("lets close-only and liquidating states preserve exits while blocking openings", async () => {
    const { systemStatePlacementBlockReason } = await import("../src/lib/system-state-placement-guard");

    expect(systemStatePlacementBlockReason("halted", "sell")).toContain("halted");
    expect(systemStatePlacementBlockReason("close_only", "buy")).toContain("Only closing orders");
    expect(systemStatePlacementBlockReason("liquidating", "short")).toContain("Only closing orders");
    expect(systemStatePlacementBlockReason("close_only", "sell")).toBeUndefined();
    expect(systemStatePlacementBlockReason("liquidating", "cover")).toBeUndefined();
  });

  it("allows a containment state without a configured strategy universe", async () => {
    const db = await import("../src/lib/db");
    const mobile = await import("../src/lib/mobile-api");
    const userId = `mobile-containment-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `PAPER-${randomUUID()}`,
      label: "Containment state",
      isActive: true
    });
    db.setPolicy(
      {
        ...db.getPolicy(userId, accountId),
        systemState: "active",
        includedIndices: [],
        additionalSymbols: []
      },
      userId,
      accountId
    );

    const queued = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.close_only",
      idempotencyKey: "contain-now"
    });
    const completed = await mobile.executeProtectiveMobileCommandImmediately(queued.command.id, userId);

    expect(completed.status).toBe("succeeded");
    expect(db.getPolicy(userId, accountId).systemState).toBe("close_only");
  });

  it("preserves queued exits in close-only, but a full Stop cancels every queued approval", async () => {
    const db = await import("../src/lib/db");
    const mobile = await import("../src/lib/mobile-api");
    const userId = `mobile-exit-preserve-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    const accountNumber = `PAPER-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Exit preservation",
      isActive: true
    });
    db.setPolicy({
      ...db.getPolicy(userId, accountId),
      systemState: "active",
      additionalSymbols: ["AAPL"]
    }, userId, accountId);

    db.insertProposal({
      id: "exit-proposal",
      userId,
      runId: "run-exit",
      accountNumber,
      proposal: { symbol: "AAPL", side: "sell" },
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });
    db.insertProposal({
      id: "opening-proposal",
      userId,
      runId: "run-opening",
      accountNumber,
      proposal: { symbol: "AAPL", side: "buy" },
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });

    const exitApproval = mobile.queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: { proposalId: "exit-proposal" },
      idempotencyKey: "exit-approval"
    });
    const openingApproval = mobile.queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: { proposalId: "opening-proposal" },
      idempotencyKey: "opening-approval"
    });
    const closeOnly = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.close_only",
      idempotencyKey: "close-only-exits"
    });

    await mobile.executeProtectiveMobileCommandImmediately(closeOnly.command.id, userId);

    expect(mobile.getMobileCommand(exitApproval.command.id, userId)?.status).toBe("queued");
    expect(mobile.getMobileCommand(openingApproval.command.id, userId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because strategy.close_only took immediate effect."
    });

    const stop = mobile.queueMobileCommand({
      userId,
      commandType: "strategy.stop",
      idempotencyKey: "stop-exits"
    });
    await mobile.executeProtectiveMobileCommandImmediately(stop.command.id, userId);

    expect(mobile.getMobileCommand(exitApproval.command.id, userId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because strategy.stop took immediate effect."
    });
  });
});
