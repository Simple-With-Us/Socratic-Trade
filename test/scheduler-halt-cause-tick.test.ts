import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, Portfolio } from "../src/lib/types";

// Board 687a5fb4, lane h5 review round.  The halt-cause helpers are unit-tested in
// test/autonomy-halt-cause.test.ts; this file drives the REAL scheduler tick() so the wiring is
// pinned too: deleting the tick's receipt cleanup, or the health gate's probe of halted accounts,
// fails here even though every helper test stays green.
//
// Only the broker gateway (src/lib/broker.ts) and the strategy run itself are replaced: a resumed
// account may be due for a run in the same tick, and that run must not reach an LLM from a test.

const mocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn(),
  runStrategyOnce: vi.fn(async () => ({ runId: "mock-run", status: "completed", summary: "mock", proposals: [] }))
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: mocks.getBrokerGateway
}));

vi.mock("../src/lib/strategy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy")>();
  return { ...actual, runStrategyOnce: mocks.runStrategyOnce };
});

const USER_ID = "local";

function gateway(accountNumber: string, health: "healthy" | "unreachable"): BrokerGateway {
  const account: BrokerageAccount = { accountNumber, label: "Paper", agenticAllowed: true };
  const portfolio: Portfolio = {
    accountNumber,
    totalMarketValue: 10_000,
    buyingPower: 5_000,
    equityMarketValue: 5_000,
    optionMarketValue: 0,
    cash: 5_000
  };
  const read = async <T,>(value: T): Promise<T> => {
    if (health === "unreachable") throw new Error("socket hang up");
    return value;
  };
  return {
    getAccounts: () => read([account]),
    getPortfolio: () => read(portfolio),
    getEquityPositions: async () => [],
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({}),
    getEquityTradability: async () => ({}),
    reviewEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    placeEquityOrder: async () => {
      throw new Error("a halt-cause tick test must never place an order");
    },
    cancelEquityOrder: async () => {
      throw new Error("not used in this test");
    }
  };
}

async function seedAccount(systemState: "active" | "halted" | "close_only") {
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
  db.setPolicy({ ...db.getPolicy(USER_ID, accountId), systemState, additionalSymbols: ["AAPL"] }, USER_ID, accountId);
  return { accountId, accountNumber };
}

/** The durable shape a broker-health auto-halt leaves behind: halted + the auto-resume marker. */
async function markAutoPaused(accountId: string) {
  const db = await import("../src/lib/db");
  db.setPolicy({ ...db.getPolicy(USER_ID, accountId), systemState: "halted" }, USER_ID, accountId);
  db.setInternalSetting(`broker:placement-paused:${USER_ID}:${accountId}`, {
    since: new Date().toISOString(),
    reason: "Broker health check timed out: checkBrokerHealth timeout",
    category: "connectivity",
    autoResume: true,
    priorState: "active"
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  delete process.env.AUTONOMY_RESUME_ON_BOOT;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-halt-cause-tick-${randomUUID()}.db`)}`;
  mocks.getBrokerGateway.mockReset();
  mocks.runStrategyOnce.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Generous: every test re-imports the scheduler graph after vi.resetModules (slow on a loaded host).
const SLOW = 600_000;

describe("scheduler tick wiring for halt causes (lane h5)", () => {
  it("drops a restart receipt on the tick after the account leaves halted, and keeps it while halted", async () => {
    const left = await seedAccount("close_only");
    const stillHalted = await seedAccount("halted");
    const byNumber = new Map([
      [left.accountNumber, gateway(left.accountNumber, "healthy")],
      [stillHalted.accountNumber, gateway(stillHalted.accountNumber, "healthy")]
    ]);
    mocks.getBrokerGateway.mockImplementation((policy: { accountNumber?: string }) => byNumber.get(policy.accountNumber ?? ""));
    const { recordBootHaltReceipt, getBootHaltReceipt } = await import("../src/lib/autonomy-halt-cause");
    const receipt = { at: "2026-09-26T00:40:00.000Z", from: "active" as const };
    recordBootHaltReceipt(USER_ID, left.accountId, receipt);
    recordBootHaltReceipt(USER_ID, stillHalted.accountId, receipt);

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    await _runSchedulerTickForTest();

    expect(getBootHaltReceipt(USER_ID, left.accountId)).toBeUndefined();
    expect(getBootHaltReceipt(USER_ID, stillHalted.accountId)).toEqual(receipt);
  }, SLOW);

  it("probes an auto-paused halted account every tick and records the failed check on its marker", async () => {
    const paused = await seedAccount("active");
    await markAutoPaused(paused.accountId);
    mocks.getBrokerGateway.mockReturnValue(gateway(paused.accountNumber, "unreachable"));

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    await _runSchedulerTickForTest();

    const { getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const marker = getBrokerPlacementPauseMarker(USER_ID, paused.accountId);
    expect(marker?.lastProbeReason).toMatch(/socket hang up/);
    expect(marker?.reason).toBe("Broker health check timed out: checkBrokerHealth timeout");
    expect(getPolicy(USER_ID, paused.accountId).systemState).toBe("halted");
  }, SLOW);

  it("auto-halt, restart, then a real healthy tick resumes it when Auto-resume on boot is on; a manual halt stays halted", async () => {
    const db = await import("../src/lib/db");
    db.setAutoResumeOnBoot(USER_ID, true);
    const auto = await seedAccount("active");
    await markAutoPaused(auto.accountId);
    const manual = await seedAccount("halted");
    const byNumber = new Map([
      [auto.accountNumber, gateway(auto.accountNumber, "healthy")],
      [manual.accountNumber, gateway(manual.accountNumber, "healthy")]
    ]);
    mocks.getBrokerGateway.mockImplementation((policy: { accountNumber?: string }) => byNumber.get(policy.accountNumber ?? ""));

    const { reconcileAutonomyOnBoot, _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    await reconcileAutonomyOnBoot();
    await _runSchedulerTickForTest();

    const { getPolicy, listAudit } = await import("../src/lib/db");
    expect(getPolicy(USER_ID, auto.accountId).systemState).toBe("active");
    expect(listAudit(200, USER_ID).some((a) => a.kind === "broker_placement_auto_resumed")).toBe(true);
    expect(getPolicy(USER_ID, manual.accountId).systemState).toBe("halted");
  }, SLOW);

  it("with Auto-resume on boot off, the restart ends the auto-pause, a healthy tick leaves it halted, and it says why", async () => {
    const db = await import("../src/lib/db");
    db.setAutoResumeOnBoot(USER_ID, false);
    const auto = await seedAccount("active");
    await markAutoPaused(auto.accountId);
    mocks.getBrokerGateway.mockReturnValue(gateway(auto.accountNumber, "healthy"));

    const { reconcileAutonomyOnBoot, _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    await reconcileAutonomyOnBoot();
    await _runSchedulerTickForTest();

    const { getPolicy } = await import("../src/lib/db");
    const { describeAutonomyHaltCause } = await import("../src/lib/autonomy-halt-cause");
    const policy = getPolicy(USER_ID, auto.accountId);
    expect(policy.systemState).toBe("halted");
    expect(
      describeAutonomyHaltCause({ userId: USER_ID, connectedAccountId: auto.accountId, accountNumber: auto.accountNumber, systemState: policy.systemState })
    ).toMatchObject({ kind: "restart", from: "broker_auto_pause", resumesOnItsOwn: false, autoResumeOnBootNow: false });
  }, SLOW);
});
