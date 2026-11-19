import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, OrderCapabilityProbeResult, Portfolio } from "../src/lib/types";

// ST-4636 review round.  A sub-threshold connectivity skip (order-capability probe timeout) leaves
// the account active, so the scheduler gate must write one `skipped_broker_unhealthy`
// strategy_runs row per skip episode.  test/broker-probe-timeout-no-halt.test.ts pins the
// predicate; this file drives the REAL scheduler tick() against a temp DB so the write itself is
// pinned: removing the persist call or the connectivity branch fails here.
//
// The broker gateway and the strategy run are replaced, so no test reaches a broker or an LLM, and
// the regime-flip lane is stubbed so the real tick cannot fetch macro data from providers.

const mocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn(),
  runStrategyOnce: vi.fn(async () => ({ runId: "mock-run", status: "completed", summary: "mock", proposals: [] }))
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: mocks.getBrokerGateway
}));

vi.mock("../src/lib/regime-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/regime-watch")>();
  return { ...actual, checkRegimeFlip: vi.fn(async () => undefined) };
});

vi.mock("../src/lib/strategy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy")>();
  return { ...actual, runStrategyOnce: mocks.runStrategyOnce };
});

const USER_ID = "local";

const TIMEOUT: OrderCapabilityProbeResult = {
  ok: false,
  reason: "Tradier order capability probe timed out: The operation was aborted due to timeout",
  transientFailure: "timeout"
};

function gateway(accountNumber: string, probe: { current: OrderCapabilityProbeResult }): BrokerGateway {
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
    getAccounts: async () => [account],
    getPortfolio: async () => portfolio,
    getEquityPositions: async () => [],
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({}),
    getEquityTradability: async () => ({}),
    probeOrderCapability: async () => probe.current,
    reviewEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    placeEquityOrder: async () => {
      throw new Error("a health-gate tick test must never place an order");
    },
    cancelEquityOrder: async () => {
      throw new Error("not used in this test");
    }
  };
}

async function seedActiveAccount() {
  const db = await import("../src/lib/db");
  const accountId = `acct-${randomUUID()}`;
  const accountNumber = `PA-${randomUUID().slice(0, 8)}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId: USER_ID,
    broker: "alpaca",
    environment: "paper",
    accountNumber,
    label: `Paper ${accountId.slice(-4)}`,
    isActive: false
  });
  db.setPolicy({ ...db.getPolicy(USER_ID, accountId), systemState: "active", additionalSymbols: ["AAPL"] }, USER_ID, accountId);
  return { accountId, accountNumber };
}

async function skipRows(accountId: string) {
  const { getDb } = await import("../src/lib/db");
  return getDb()
    .prepare("SELECT status, summary FROM strategy_runs WHERE connected_account_id = ? AND status = 'skipped_broker_unhealthy'")
    .all(accountId) as Array<{ status: string; summary: string }>;
}

let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-connectivity-skip-row-${randomUUID()}.db`)}`;
  mocks.getBrokerGateway.mockReset();
  mocks.runStrategyOnce.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// Generous: the test re-imports the scheduler graph after vi.resetModules (slow on a loaded host).
const SLOW = 600_000;

describe("scheduler gate writes a strategy_runs row for a sub-threshold connectivity skip (ST-4636)", () => {
  it("writes one skipped_broker_unhealthy row per episode and leaves the account active", async () => {
    const seeded = await seedActiveAccount();
    const probe = { current: TIMEOUT };
    mocks.getBrokerGateway.mockReturnValue(gateway(seeded.accountNumber, probe));
    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { getPolicy, listAudit } = await import("../src/lib/db");

    // Episode 1: three ticks with the same timeout.  One row, not three, and no halt.
    for (let i = 0; i < 3; i++) await _runSchedulerTickForTest();
    let rows = await skipRows(seeded.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(
      `Broker health check failed: ${TIMEOUT.reason}. Skipping strategy run to avoid consuming budget.`
    );
    expect(getPolicy(USER_ID, seeded.accountId).systemState).toBe("active");
    expect(listAudit(200, USER_ID).filter((a) => a.kind === "run_skipped_broker_unhealthy")).toHaveLength(1);
    expect(listAudit(200, USER_ID).some((a) => a.kind === "broker_placement_auto_halted")).toBe(false);
    expect(mocks.runStrategyOnce).not.toHaveBeenCalled();

    // A healthy tick ends the episode; the next timeout starts episode 2 and writes a second row.
    probe.current = { ok: true };
    await _runSchedulerTickForTest();
    expect(await skipRows(seeded.accountId)).toHaveLength(1);
    probe.current = TIMEOUT;
    await _runSchedulerTickForTest();
    await _runSchedulerTickForTest();
    rows = await skipRows(seeded.accountId);
    expect(rows).toHaveLength(2);
    expect(getPolicy(USER_ID, seeded.accountId).systemState).toBe("active");
  }, SLOW);
});
