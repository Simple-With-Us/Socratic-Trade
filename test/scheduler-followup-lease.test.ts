import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const followupMocks = vi.hoisted(() => ({
  runStrategyOnce: vi.fn(),
  maybeAutoTuneWeights: vi.fn()
}));

vi.mock("../src/lib/strategy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy")>();
  return {
    ...actual,
    runStrategyOnce: followupMocks.runStrategyOnce
  };
});

vi.mock("../src/lib/auto-tune-scheduler", () => ({
  maybeAutoTuneWeights: followupMocks.maybeAutoTuneWeights
}));

import {
  SCHEDULER_LEASE_RELEASE_EVENTS,
  runScheduledStrategyAndMaybeTune,
  shouldAutoTuneAfterStrategyRun,
  shouldReleaseSchedulerLeaseOnShutdown
} from "../src/lib/scheduler";

beforeEach(() => {
  followupMocks.runStrategyOnce.mockReset();
  followupMocks.maybeAutoTuneWeights.mockReset().mockResolvedValue({ ran: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduler shutdown fencing", () => {
  it("retains the leader lease for SIGTERM/SIGINT and releases only after beforeExit", () => {
    expect(SCHEDULER_LEASE_RELEASE_EVENTS).toEqual(["beforeExit"]);
    expect(shouldReleaseSchedulerLeaseOnShutdown("SIGTERM")).toBe(false);
    expect(shouldReleaseSchedulerLeaseOnShutdown("SIGINT")).toBe(false);
    expect(shouldReleaseSchedulerLeaseOnShutdown("beforeExit")).toBe(true);
  });
});

describe("scheduled auto-tune follow-up", () => {
  it("does not tune after a failed strategy result", async () => {
    followupMocks.runStrategyOnce.mockResolvedValue({
      runId: "failed-run",
      status: "failed",
      summary: "ownership lost",
      proposals: []
    });

    const result = await runScheduledStrategyAndMaybeTune("user-a", "account-a", 123);

    expect(shouldAutoTuneAfterStrategyRun(result)).toBe(false);
    expect(followupMocks.runStrategyOnce).toHaveBeenCalledWith("user-a", { connectedAccountId: "account-a" });
    expect(followupMocks.maybeAutoTuneWeights).not.toHaveBeenCalled();
  });

  it("does not tune after pure pre-decision skips (UX PR-A1)", async () => {
    for (const status of ["skipped", "skipped_budget", "skipped_market_closed", "skipped_broker_unhealthy"] as const) {
      followupMocks.runStrategyOnce.mockReset();
      followupMocks.maybeAutoTuneWeights.mockReset();
      followupMocks.runStrategyOnce.mockResolvedValue({
        runId: `skip-${status}`,
        status,
        summary: status,
        proposals: []
      });
      const result = await runScheduledStrategyAndMaybeTune("user-skip", "account-skip", 99);
      expect(shouldAutoTuneAfterStrategyRun(result)).toBe(false);
      expect(followupMocks.maybeAutoTuneWeights).not.toHaveBeenCalled();
    }
  });

  it("passes the scheduled account id into tuning after a completed run", async () => {
    followupMocks.runStrategyOnce.mockResolvedValue({
      runId: "completed-run",
      status: "completed",
      summary: "done",
      proposals: []
    });

    await runScheduledStrategyAndMaybeTune("user-b", "account-b", 456);

    expect(followupMocks.maybeAutoTuneWeights).toHaveBeenCalledWith("user-b", 456, "account-b");
  });

  it("computes the tuning timestamp after a long strategy run completes", async () => {
    let clock = 100;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    followupMocks.runStrategyOnce.mockImplementation(async () => {
      clock = 200;
      return { runId: "long-run", status: "completed", summary: "done", proposals: [] };
    });

    await runScheduledStrategyAndMaybeTune("user-c", "account-c");

    expect(followupMocks.maybeAutoTuneWeights).toHaveBeenCalledWith("user-c", 200, "account-c");
  });
});
