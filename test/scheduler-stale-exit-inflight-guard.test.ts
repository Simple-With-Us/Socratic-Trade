import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, EquityOrder, Portfolio } from "../src/lib/types";

// scheduler.ts's stale-limit-scan in-flight guard (staleExitInFlight) must not stay latched
// when a broker READ never settles.  The deadline aborts that read and releases the guard so
// the next tick can protect the account again.  A broker WRITE that has already started keeps
// the guard: releasing it would let the next tick send a second cancel-replace (a double-sell).
//
// This exercises the REAL scheduler.ts tick() code path: a real connected account + policy drive
// the per-account loop into the stale-limit-scan lane, with only `getBrokerGateway`
// (src/lib/broker.ts) replaced by a hand-built stub gateway so the test never depends on the
// real Alpaca/Tradier wire adapters.  The stub's getEquityOrders hangs forever, mirroring a
// broker call slower than SCHEDULER_BROKER_TIMEOUT_MS (live Alpaca reads have reached 14.4s --
// see src/lib/inflight-deadline.ts).  Remediation never starts, so the guard must drop.
const brokerMocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn()
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: brokerMocks.getBrokerGateway
}));

const ACCOUNT_NUMBER = "STALE-GUARD-ACC";
const USER_ID = "local";
const ACCOUNT_ID = "acc-stale-guard";

function healthyGateway(getEquityOrders: BrokerGateway["getEquityOrders"]): BrokerGateway {
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
    getEquityOrders,
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

/** Never resolves -- mirrors a broker call slower than SCHEDULER_BROKER_TIMEOUT_MS. */
function hangingGetEquityOrders(): Promise<EquityOrder[]> {
  return new Promise<EquityOrder[]>(() => undefined);
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-guard-${randomUUID()}.db`)}`;
  brokerMocks.getBrokerGateway.mockReset();
  // Defensive reset: globalThis-pinned, so it survives module reset and could otherwise leak from
  // another test file sharing this worker process.
  (globalThis as { __staleExitInFlight?: Set<string> }).__staleExitInFlight = new Set<string>();

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: ACCOUNT_ID,
    userId: USER_ID,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT_NUMBER,
    label: "Stale-guard paper",
    isActive: true
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduler stale-exit lane in-flight guard", () => {
  it("releases the exit lane after the broker deadline when getEquityOrders never settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    brokerMocks.getBrokerGateway.mockReturnValue(healthyGateway(hangingGetEquityOrders));

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");

    const key = `${USER_ID}::${ACCOUNT_ID}`;
    const host = globalThis as { __staleExitInFlight?: Set<string> };

    // The tick itself resolves quickly: the stale-limit-scan lane is fire-and-forget (`void
    // withDeadline(...)`), so tick() does not wait on it -- only the guard Set does.
    await _runSchedulerTickForTest();
    expect(host.__staleExitInFlight?.has(key)).toBe(true);

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 100);
    // The read never started remediation, so the deadline must unlatch the lane.
    expect(host.__staleExitInFlight?.has(key)).toBe(false);
  }, 30_000);

  it("runs the exit lane again on the next tick after a hung read is released", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let getEquityOrdersCalls = 0;
    // getBrokerGateway itself is called unconditionally every tick (it's evaluated before the
    // guard check), so the guard's effect can only be observed on calls made INSIDE the guarded
    // branch -- getEquityOrders, which scheduler.ts only calls once the guard lets a lane launch.
    brokerMocks.getBrokerGateway.mockImplementation(() =>
      healthyGateway(() => {
        getEquityOrdersCalls += 1;
        return hangingGetEquityOrders();
      })
    );

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");

    const key = `${USER_ID}::${ACCOUNT_ID}`;
    const host = globalThis as { __staleExitInFlight?: Set<string> };

    await _runSchedulerTickForTest();
    expect(host.__staleExitInFlight?.has(key)).toBe(true);
    expect(getEquityOrdersCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 100);

    // The hung read was aborted before remediation, so the next tick must protect the account again.
    await _runSchedulerTickForTest();
    expect(getEquityOrdersCalls).toBe(2);
  }, 30_000);
});
