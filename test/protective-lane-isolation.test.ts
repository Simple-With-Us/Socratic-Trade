import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, Portfolio } from "../src/lib/types";

// One hung broker read must not freeze protection for every account, and it must not
// leave a strategy run in `running`.  Account A never answers getAccounts (the health
// probe).  Account B's protective lanes (stops / exits) are launched before that probe
// is awaited, so B's order listing is already in flight while A's health is still
// pending.  B's own snapshot then hangs; the run deadline fails that run.

const brokerMocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn()
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: brokerMocks.getBrokerGateway
}));

const USER_ID = "local";
const REGULAR_SESSION = new Date("2026-10-15T14:30:00.000Z");

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

function gateway(accountNumber: string, mode: "hang-health" | "hang-snapshot", counters: { orders: number; accounts: number }): BrokerGateway {
  const account: BrokerageAccount = { accountNumber, label: "Paper", agenticAllowed: true };
  const portfolio: Portfolio = {
    accountNumber,
    totalMarketValue: 10_000,
    buyingPower: 5_000,
    equityMarketValue: 5_000,
    optionMarketValue: 0,
    cash: 5_000
  };
  return {
    getAccounts: async () => {
      counters.accounts += 1;
      if (mode === "hang-health") return hang();
      // Tick health, then the in-run health probe, then the pre-decision snapshot.
      if (counters.accounts >= 3) return hang();
      return [account];
    },
    getPortfolio: async () => portfolio,
    getEquityPositions: async () => [],
    getEquityOrders: async () => {
      counters.orders += 1;
      return [];
    },
    getEquityQuotes: async () => ({}),
    getEquityTradability: async () => ({}),
    reviewEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    placeEquityOrder: async () => {
      throw new Error("a hung-broker test must never place an order");
    },
    cancelEquityOrder: async () => {
      throw new Error("not used in this test");
    }
  };
}

async function seed(label: string, createdAt: string) {
  const db = await import("../src/lib/db");
  const accountId = `acct-${randomUUID()}`;
  const accountNumber = `PA-${randomUUID().slice(0, 8)}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId: USER_ID,
    broker: "alpaca",
    environment: "paper",
    accountNumber,
    label,
    isActive: false
  });
  db.getDb().prepare("UPDATE connected_accounts SET created_at = ? WHERE id = ?").run(createdAt, accountId);
  db.setPolicy(
    { ...db.getPolicy(USER_ID, accountId), systemState: "active", llmModel: "gpt-5.4-mini", additionalSymbols: ["AAPL"] },
    USER_ID,
    accountId
  );
  return { accountId, accountNumber };
}

/** Poll on the real event loop.  `shouldAdvanceTime` keeps fake deadlines moving while this waits. */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  delete process.env.SENTRY_CRONS_ENABLED;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-lane-isolation-${randomUUID()}.db`)}`;
  brokerMocks.getBrokerGateway.mockReset();
  const host = globalThis as {
    __staleExitInFlight?: Set<string>;
    __stopMonitorInFlight?: Set<string>;
    __pendingFillReconcileInFlight?: Set<string>;
  };
  host.__staleExitInFlight = new Set();
  host.__stopMonitorInFlight = new Set();
  host.__pendingFillReconcileInFlight = new Set();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("protective lanes stay isolated from a hung broker call", () => {
  it("keeps the next account's stops and exits moving, and fails the hung snapshot run", async () => {
    const hung = await seed("Hung health", "2026-01-01T00:00:00.000Z");
    const healthy = await seed("Hung snapshot", "2026-01-01T00:00:01.000Z");
    const hungCounts = { orders: 0, accounts: 0 };
    const healthyCounts = { orders: 0, accounts: 0 };
    const byNumber = new Map<string, BrokerGateway>([
      [hung.accountNumber, gateway(hung.accountNumber, "hang-health", hungCounts)],
      [healthy.accountNumber, gateway(healthy.accountNumber, "hang-snapshot", healthyCounts)]
    ]);
    brokerMocks.getBrokerGateway.mockImplementation((policy: { accountNumber?: string }) => byNumber.get(policy.accountNumber ?? ""));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(REGULAR_SESSION);

    const { _runSchedulerTickForTest, _resetSchedulerTickGuardForTest, SCHEDULER_HEALTH_PROBE_TIMEOUT_MS } = await import("../src/lib/scheduler");
    const { STRATEGY_BROKER_SNAPSHOT_DEADLINE_MS } = await import("../src/lib/inflight-deadline");
    _resetSchedulerTickGuardForTest();

    const tick = _runSchedulerTickForTest();
    await waitFor(() => healthyCounts.orders > 0);
    // B's exit lane listed orders before A's health probe could return, and before B's own probe started.
    expect(healthyCounts.orders, JSON.stringify({ healthyCounts, hungCounts, gatewayCalls: brokerMocks.getBrokerGateway.mock.calls.length })).toBeGreaterThan(0);
    expect(healthyCounts.accounts).toBe(0);
    expect(hungCounts.accounts).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(SCHEDULER_HEALTH_PROBE_TIMEOUT_MS + 100);
    await waitFor(() => healthyCounts.accounts >= 3);
    expect(healthyCounts.accounts).toBeGreaterThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(STRATEGY_BROKER_SNAPSHOT_DEADLINE_MS + 100);
    await waitFor(() => false, 50);
    await tick;

    const { listStrategyRuns } = await import("../src/lib/db");
    const runs = listStrategyRuns(5, USER_ID, healthy.accountId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.summary ?? "").toMatch(/timeout/i);
    expect(runs[0]?.finishedAt).toBeTruthy();

    const ordersAfterFailure = healthyCounts.orders;
    const tickAgain = _runSchedulerTickForTest();
    await waitFor(() => healthyCounts.orders > ordersAfterFailure);
    expect(healthyCounts.orders).toBeGreaterThan(ordersAfterFailure);
    await vi.advanceTimersByTimeAsync(SCHEDULER_HEALTH_PROBE_TIMEOUT_MS * 2 + 200);
    await tickAgain;
  }, 60_000);
});
