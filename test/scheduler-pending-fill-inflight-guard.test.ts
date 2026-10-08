import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, EquityOrder, Portfolio } from "../src/lib/types";

const reconcileMocks = vi.hoisted(() => ({
  reconcilePendingFills: vi.fn()
}));

vi.mock("../src/lib/strategy-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-execution")>();
  return {
    ...actual,
    reconcilePendingFills: (...args: Parameters<typeof actual.reconcilePendingFills>) =>
      reconcileMocks.reconcilePendingFills(...args)
  };
});

const brokerMocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn()
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: brokerMocks.getBrokerGateway
}));

const ACCOUNT_NUMBER = "PENDING-FILL-ACC";
const USER_ID = "local";
const ACCOUNT_ID = "acc-pending-fill-guard";

function healthyGateway(): BrokerGateway {
  const account: BrokerageAccount = { accountNumber: ACCOUNT_NUMBER, label: "Paper", agenticAllowed: true };
  const portfolio: Portfolio = {
    accountNumber: ACCOUNT_NUMBER,
    totalMarketValue: 10_000,
    buyingPower: 5_000,
    equityMarketValue: 5_000,
    optionMarketValue: 0,
    cash: 5_000
  };
  return {
    getAccounts: async () => [account],
    getPortfolio: async () => portfolio,
    getEquityPositions: async () => [],
    getEquityOrders: async () => [] as EquityOrder[],
    getEquityQuotes: async () => ({}),
    getEquityTradability: async () => ({}),
    reviewEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    placeEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    cancelEquityOrder: async () => {
      throw new Error("not used in this test");
    }
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pending-fill-guard-${randomUUID()}.db`)}`;
  brokerMocks.getBrokerGateway.mockReset();
  reconcileMocks.reconcilePendingFills.mockReset();
  reconcileMocks.reconcilePendingFills.mockImplementation(() => new Promise(() => undefined));
  (globalThis as { __pendingFillReconcileInFlight?: Set<string> }).__pendingFillReconcileInFlight =
    new Set<string>();

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: ACCOUNT_ID,
    userId: USER_ID,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT_NUMBER,
    label: "Pending-fill guard paper",
    isActive: true
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduler pending-fill-reconcile in-flight guard", () => {
  it("does not launch a second concurrent reconcile for the same account on the next tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    brokerMocks.getBrokerGateway.mockReturnValue(healthyGateway());

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");

    const key = `${USER_ID}::${ACCOUNT_ID}`;
    const host = globalThis as { __pendingFillReconcileInFlight?: Set<string> };

    await _runSchedulerTickForTest();
    expect(host.__pendingFillReconcileInFlight?.has(key)).toBe(true);
    expect(reconcileMocks.reconcilePendingFills).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 100);

    await _runSchedulerTickForTest();
    expect(reconcileMocks.reconcilePendingFills).toHaveBeenCalledTimes(1);
  }, 30_000);
});
