/**
 * Board 687a5fb4, lane h5 review round: the dashboard snapshot must carry WHY an account is halted,
 * for the loaded account (snapshot.haltCause, the run-state chip and control sheet) AND for every
 * other connected account (connectedAccountPolicies[id].haltCause, the account switcher and the
 * Settings Brokers rows).  Production 2026-09-29: the incident account (Alpaca Paper) was NOT the
 * loaded one, so a loaded-account-only cause would still have shown it as a bare "Stopped".
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Same off-the-network scaffolding as dashboard-connected-account-pending-counts.test.ts.
vi.mock("../src/lib/macro", () => ({
  fetchMacroData: vi.fn(async () => ({})),
  determineMarketRegime: vi.fn(() => "Unknown")
}));
vi.mock("../src/lib/macro-metrics", () => ({ deriveMacroMetrics: vi.fn(() => ({})) }));
vi.mock("../src/lib/macro-history", () => ({ fetchMacroHistory: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals", () => ({ getMarketSignals: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals/massive", () => ({ fetchMassiveNews: vi.fn(async () => []) }));
vi.mock("../src/lib/market-internals", () => ({ computeMarketInternals: vi.fn(() => ({ medianEarnYld: undefined })) }));
vi.mock("../src/lib/benchmark", () => ({
  computeSpyBenchmark: vi.fn(async () => null),
  computeSpyBenchmarkDetailed: vi.fn(async () => ({ comparison: null }))
}));
vi.mock("../src/lib/web-sources", () => ({
  getCongressDataset: vi.fn(() => undefined),
  getInsiderDataset: vi.fn(() => undefined),
  getWebSourcesStatus: vi.fn(() => ({}))
}));
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "HALT-LOADED", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return { accountNumber: "HALT-LOADED", totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
    },
    async getEquityPositions() {
      return [];
    },
    async getEquityOrders() {
      return [];
    },
    async getEquityQuotes() {
      return {};
    }
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-halt-cause-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("getDashboardSnapshot halt causes (lane h5)", () => {
  it("carries the loaded account's cause and each other halted account's cause; running accounts carry none", async () => {
    const db = await import("../src/lib/db");
    const { recordBootHaltReceipt } = await import("../src/lib/autonomy-halt-cause");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-halt-${randomUUID()}`;
    const loadedId = `acct-loaded-${userId}`;
    const pausedId = `acct-paused-${userId}`;
    const restartedId = `acct-restarted-${userId}`;
    const runningId = `acct-running-${userId}`;
    const accounts = [
      { id: loadedId, accountNumber: "HALT-LOADED", label: "Loaded", isActive: true },
      { id: pausedId, accountNumber: "HALT-PAUSED", label: "Paused", isActive: false },
      { id: restartedId, accountNumber: "HALT-RESTARTED", label: "Restarted", isActive: false },
      { id: runningId, accountNumber: "HALT-RUNNING", label: "Running", isActive: false }
    ];
    for (const account of accounts) {
      db.upsertConnectedAccount({ ...account, userId, broker: "test", environment: "paper" });
    }
    const setState = (id: string, systemState: "active" | "halted") =>
      db.setPolicy({ ...db.getPolicy(userId, id), systemState, additionalSymbols: ["AAPL"] }, userId, id);
    setState(loadedId, "halted");
    setState(pausedId, "halted");
    setState(restartedId, "halted");
    setState(runningId, "active");

    // Loaded account: stopped with no record.  Paused: a live broker auto-pause.  Restarted: the
    // boot interlock ended its auto-pause.
    db.setInternalSetting(`broker:placement-paused:${userId}:${pausedId}`, {
      since: "2026-09-25T18:20:24.034Z",
      reason: "Broker health check timed out: checkBrokerHealth timeout",
      category: "connectivity",
      autoResume: true,
      priorState: "active",
      lastProbeAt: "2026-09-25T19:00:00.000Z",
      lastProbeReason: "Broker connectivity failure: socket hang up"
    });
    recordBootHaltReceipt(userId, restartedId, {
      at: "2026-09-26T00:40:00.000Z",
      from: "broker_auto_pause",
      autoPauseReason: "Broker health check timed out: checkBrokerHealth timeout"
    });

    const snapshot = await getDashboardSnapshot(userId);

    expect(snapshot.haltCause).toMatchObject({ kind: "stopped", resumesOnItsOwn: false });
    const policies = snapshot.connectedAccountPolicies ?? {};
    expect(policies[loadedId]?.haltCause).toMatchObject({ kind: "stopped" });
    expect(policies[pausedId]?.haltCause).toMatchObject({
      kind: "broker_auto_pause",
      resumesOnItsOwn: true,
      lastProbeAt: "2026-09-25T19:00:00.000Z",
      lastProbeReason: "Broker connectivity failure: socket hang up"
    });
    expect(policies[restartedId]?.haltCause).toMatchObject({ kind: "restart", from: "broker_auto_pause", resumesOnItsOwn: false });
    expect(policies[runningId]?.systemState).toBe("active");
    expect(policies[runningId]?.haltCause).toBeUndefined();

    // The switcher and Brokers rows fold the per-account cause into their chip.
    const { deriveStateInfo, withHaltCause } = await import("../app/console/lib/derive");
    const pausedRow = policies[pausedId]!;
    expect(withHaltCause(deriveStateInfo(pausedRow), pausedRow.haltCause)).toMatchObject({ word: "Stopped", label: "Stopped · auto-paused", tone: "warn" });
    const restartedRow = policies[restartedId]!;
    expect(withHaltCause(deriveStateInfo(restartedRow), restartedRow.haltCause)).toMatchObject({ label: "Stopped · by restart" });
  }, 600_000);
});
