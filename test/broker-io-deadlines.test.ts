import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPACA_BROKER_IO_DEADLINE_MS, EQUITY_ORDERS_TERMINAL_LOOKBACK_MS } from "../src/lib/inflight-deadline";

let getOrdersCalls: Array<Record<string, unknown>> = [];
let createOrderHang = false;
let createOrderCalls = 0;
let createOrderSocketFail = false;
let getAccountCalls = 0;
/** ms after which getAccount rejects with a dead-keep-alive-socket error, or 0 to answer fast. */
let getAccountSlowSocketFailMs = 0;

function deadSocketError(): Error {
  const err = new TypeError("fetch failed");
  (err as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET"
  });
  return err;
}

vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
      async getAccount() {
        getAccountCalls += 1;
        if (getAccountSlowSocketFailMs > 0) {
          const failAfter = getAccountSlowSocketFailMs;
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(deadSocketError()), failAfter);
          });
        }
        return { account_number: "MOCK_ACC", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "10000" };
      }
      async getPositions() { return []; }
      async getOrders(opts: Record<string, unknown>) {
        getOrdersCalls.push(opts);
        return [];
      }
      async getLatestQuotes() { return {}; }
      async createOrder() {
        createOrderCalls += 1;
        if (createOrderHang) return new Promise(() => undefined);
        if (createOrderSocketFail) {
          const err = new TypeError("fetch failed");
          (err as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET"
          });
          throw err;
        }
        return { id: "ord-1", status: "accepted", filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder(id: string) {
        if (createOrderHang) return new Promise(() => undefined);
        return { id, status: "cancelled" };
      }
  }
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  getOrdersCalls = [];
  createOrderHang = false;
  createOrderCalls = 0;
  createOrderSocketFail = false;
  getAccountCalls = 0;
  getAccountSlowSocketFailMs = 0;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-io-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-broker-io",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper IO"
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("broker I/O deadlines", () => {
  it("placeEquityOrder rejects when createOrder hangs past the broker I/O deadline", async () => {
    vi.useFakeTimers();
    createOrderHang = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    const pending = gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 1,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-place-timeout"
    });
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(ALPACA_BROKER_IO_DEADLINE_MS);
    await expect(pending).rejects.toThrow(/timed out/i);
    createOrderHang = false;
  });

  it("placeEquityOrder does not retry createOrder after a dead response socket", async () => {
    createOrderSocketFail = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(
      gateway.placeEquityOrder({
        accountNumber: "MOCK_ACC",
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: 1,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        refId: "ref-place-socket"
      })
    ).rejects.toThrow(/fetch failed|other side closed|UND_ERR_SOCKET/i);
    expect(createOrderCalls).toBe(1);
    createOrderSocketFail = false;
  });

  it("cancelEquityOrder rejects when cancelOrder hangs past the broker I/O deadline", async () => {
    vi.useFakeTimers();
    createOrderHang = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    const pending = gateway.cancelEquityOrder("MOCK_ACC", "order-123");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ALPACA_BROKER_IO_DEADLINE_MS);
    await expect(pending).rejects.toThrow(/timed out/i);
    createOrderHang = false;
  });

  it("default getEquityOrders scopes to open plus bounded closed history, not status all", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    await gateway.getEquityOrders("MOCK_ACC");

    expect(getOrdersCalls.some((c) => c.status === "all")).toBe(false);
    expect(getOrdersCalls.some((c) => c.status === "open")).toBe(true);
    expect(getOrdersCalls.some((c) => c.status === "closed")).toBe(true);
    const closedCall = getOrdersCalls.find((c) => c.status === "closed");
    expect(closedCall?.after).toBeTypeOf("string");
    const afterMs = Date.parse(String(closedCall?.after));
    expect(Date.now() - afterMs).toBeLessThanOrEqual(EQUITY_ORDERS_TERMINAL_LOOKBACK_MS + 5_000);
  });

  it("does not reconnect an abandoned getAccount read after its budget expired", async () => {
    vi.useFakeTimers();
    const { ALPACA_ACCOUNT_READ_FIRST_MS, ALPACA_ACCOUNT_READ_RETRY_MS } = await import("../src/lib/inflight-deadline");
    // Reject AFTER the combined first+retry budget, so both attempts are already abandoned by
    // the time the dead socket surfaces.  A transient-looking error on an abandoned attempt used
    // to earn a fresh connection apiece, so a slow broker kept minting new sockets nobody awaited.
    getAccountSlowSocketFailMs = ALPACA_ACCOUNT_READ_FIRST_MS + ALPACA_ACCOUNT_READ_RETRY_MS + 6_000;

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    const pending = gateway.getAccounts();
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(ALPACA_ACCOUNT_READ_FIRST_MS + ALPACA_ACCOUNT_READ_RETRY_MS);
    await expect(pending).rejects.toThrow(/Timed out waiting for alpaca\.getAccount/i);
    expect(getAccountCalls).toBe(2);

    // Let both abandoned attempts surface their dead socket well past the point where the
    // transient-retry backoff would have fired.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAccountCalls).toBe(2);
  });

  it("fullHistory getEquityOrders still walks status all", async () => {
    getOrdersCalls = [];
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    await gateway.getEquityOrders("MOCK_ACC", { fullHistory: true });
    expect(getOrdersCalls.some((c) => c.status === "all")).toBe(true);
  });

  // scheduler.ts's guard-release chain must be attached to the REAL lane work, never to the
  // withDeadline race loser: a lane still running past SCHEDULER_BROKER_TIMEOUT_MS must not free
  // its in-flight slot for a duplicate launch on the next 60s tick (money-path bug — see the
  // "in-flight guards released by the loser of the race" fix). These mirror scheduler.ts's exact
  // shape (`const work = journalLane(...); work.catch().finally(() => set.delete(key)); void
  // withDeadline(work, ...)`) rather than calling into the private per-tick guard Sets directly.
  it("scheduler stop-monitor lane keeps its in-flight key held while real work outlives the broker deadline", async () => {
    vi.useFakeTimers();
    const host = globalThis as { __stopMonitorInFlight?: Set<string> };
    host.__stopMonitorInFlight = new Set<string>();

    const { withDeadline, SCHEDULER_BROKER_TIMEOUT_MS: timeoutMs } = await import("../src/lib/safety-maintenance");

    const key = "user:acct";
    host.__stopMonitorInFlight.add(key);

    let releaseWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    void work.catch(() => undefined).finally(() => host.__stopMonitorInFlight!.delete(key));
    void withDeadline(work, timeoutMs, "runSyntheticStopMonitor timeout").catch(() => undefined);

    await vi.advanceTimersByTimeAsync(timeoutMs + 10);
    // The 15s deadline has already fired (withDeadline's race lost to the timeout), but the REAL
    // work is still pending -- the guard must still be held, or the next tick launches a duplicate
    // concurrent monitor for the same account.
    expect(host.__stopMonitorInFlight.has(key)).toBe(true);

    releaseWork!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.__stopMonitorInFlight.has(key)).toBe(false);
  });

  it("scheduler stale-exit lane keeps its in-flight key held while real work outlives the broker deadline", async () => {
    vi.useFakeTimers();
    const host = globalThis as { __staleExitInFlight?: Set<string> };
    host.__staleExitInFlight = new Set<string>();

    const { withDeadline, SCHEDULER_BROKER_TIMEOUT_MS: timeoutMs } = await import("../src/lib/safety-maintenance");

    const key = "user:acct";
    host.__staleExitInFlight.add(key);

    let releaseWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    void work.catch(() => undefined).finally(() => host.__staleExitInFlight!.delete(key));
    void withDeadline(work, timeoutMs, "stale-limit-scan broker timeout").catch(() => undefined);

    await vi.advanceTimersByTimeAsync(timeoutMs + 10);
    // Same contract as the stop-monitor lane above: a slow cancel-replace (>=4 sequential broker
    // round-trips) must not free the slot for a second market sell on the next tick.
    expect(host.__staleExitInFlight.has(key)).toBe(true);

    releaseWork!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.__staleExitInFlight.has(key)).toBe(false);
  });
});
