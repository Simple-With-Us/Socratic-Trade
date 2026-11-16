/**
 * PR #7 — the mobile "switch account" command changes the ephemeral view pointer only; it
 * must NOT mutate any account's execution state (it is not the side-door that re-introduces
 * the view→execution coupling). Verified end-to-end through the real mobile command path.
 *
 * 2026-08-03: account.activate is also an IMMEDIATE command (bypasses the sequential worker)
 * so a long strategy.run_once cannot leave the iOS "Use" button spinning.
 */
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-view-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  strategyMocks.rejectProposal.mockReset();
  strategyMocks.runStrategyOnce.mockReset();
});

describe("mobile account switch is view-only (PR #7)", () => {
  it("account.activate flips the active pointer without changing any account's run-state", async () => {
    const db = await import("../src/lib/db");
    const { queueMobileCommand, executeMobileCommandImmediately, listMobileCommands } = await import("../src/lib/mobile-api");

    const u = `mobile-user-${randomUUID()}`;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    db.upsertConnectedAccount({ id: a, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "A", isActive: true });
    db.upsertConnectedAccount({ id: b, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-B", label: "B", isActive: false });

    // A armed, B halted.
    db.setPolicy({ ...db.getPolicy(u, a), systemState: "active" }, u, a);
    db.setPolicy({ ...db.getPolicy(u, b), systemState: "halted" }, u, b);

    // Mobile switches the active account to B via the immediate path (same as POST /api/mobile/commands).
    const queued = queueMobileCommand({
      userId: u,
      commandType: "account.activate",
      payload: { accountId: b },
      idempotencyKey: `act-${b}`
    });
    const completed = await executeMobileCommandImmediately(queued.command.id, u);
    expect(completed.status).toBe("succeeded");

    const commands = listMobileCommands({ userId: u });
    expect(commands[0]?.status).toBe("succeeded");

    // The view pointer moved to B…
    expect(db.getActiveConnectedAccount(u)?.id).toBe(b);
    // …but neither account's execution state changed.
    expect(db.getPolicy(u, a).systemState).toBe("active");
    expect(db.getPolicy(u, b).systemState).toBe("halted");
  });

  it("account.activate drops cached dashboard snapshots for that user", async () => {
    const db = await import("../src/lib/db");
    const cache = await import("../src/lib/dashboard-snapshot-cache");
    const { queueMobileCommand, executeMobileCommandImmediately } = await import("../src/lib/mobile-api");

    const u = `mobile-user-${randomUUID()}`;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    db.upsertConnectedAccount({ id: a, userId: u, broker: "tradier", environment: "paper", accountNumber: "SANDBOX-A", label: "Sandbox", isActive: true });
    db.upsertConnectedAccount({ id: b, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-B", label: "Alpaca Paper", isActive: false });

    cache.setCachedDashboardSnapshot(cache.dashboardSnapshotCacheKey(u, "SANDBOX-A"), { stale: true });
    cache.setCachedDashboardSnapshot(cache.dashboardSnapshotCacheKey(u, "PA-B"), { stale: true });

    const queued = queueMobileCommand({
      userId: u,
      commandType: "account.activate",
      payload: { accountId: b },
      idempotencyKey: `act-cache-${b}`
    });
    const completed = await executeMobileCommandImmediately(queued.command.id, u);
    expect(completed.status).toBe("succeeded");
    expect(cache.getCachedDashboardSnapshot(cache.dashboardSnapshotCacheKey(u, "SANDBOX-A"))).toBeUndefined();
    expect(cache.getCachedDashboardSnapshot(cache.dashboardSnapshotCacheKey(u, "PA-B"))).toBeUndefined();
  });

  it("account.activate completes immediately while strategy.run_once is still running", async () => {
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

    const u = `mobile-user-${randomUUID()}`;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: a,
      userId: u,
      broker: "tradier",
      environment: "paper",
      accountNumber: "SANDBOX-A",
      label: "Sandbox",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: b,
      userId: u,
      broker: "alpaca",
      environment: "live",
      accountNumber: "ROTH-B",
      label: "Roth IRA",
      isActive: false
    });
    db.setPolicy(
      { ...db.getPolicy(u, a), systemState: "active", additionalSymbols: ["AAPL"] },
      u,
      a
    );

    const running = mobile.queueMobileCommand({
      userId: u,
      commandType: "strategy.run_once",
      idempotencyKey: `run-${randomUUID()}`
    });
    const worker = mobile.processPendingMobileCommands({ limit: 1 });
    await runStarted;
    expect(mobile.getMobileCommand(running.command.id, u)?.status).toBe("running");

    // Switch must not wait for run_once to finish.
    const activate = mobile.queueMobileCommand({
      userId: u,
      commandType: "account.activate",
      payload: { accountId: b },
      idempotencyKey: `act-${b}`
    });
    const completed = await mobile.executeMobileCommandImmediately(activate.command.id, u);

    expect(completed.status).toBe("succeeded");
    expect(db.getActiveConnectedAccount(u)?.id).toBe(b);
    // run_once still in flight on the sequential worker
    expect(mobile.getMobileCommand(running.command.id, u)?.status).toBe("running");

    releaseRun();
    await worker;
    expect(mobile.getMobileCommand(running.command.id, u)?.status).toBe("succeeded");
  });
});
