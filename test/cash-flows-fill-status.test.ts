import { describe, expect, it } from "vitest";
import { inferExternalCashFlows, isCashMovingFill } from "../src/lib/cash-flows";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";
import type { EquityCurvePoint, FillEvent } from "../src/lib/types";

/**
 * Live bug (2026-11-19, Tradier Sandbox "You -0.2%" vs real -3.35%): fill_events deliberately
 * books rejected/canceled/expired order receipts WITH their requested notional for the
 * reconciliation audit trail. inferExternalCashFlows counted those notionals as cash moved, so
 * flow = Δcash − tradeCash invented "withdrawals" exactly the size of rejected orders and the
 * vs-SPY TWR neutralized real trading losses. The P&L ledger already excludes these rows via
 * isAccountingFill (performance.ts); the cash-flow inference now mirrors it via isCashMovingFill.
 */

let seq = 0;
function fill(input: {
  filledAt: string;
  side: FillEvent["side"];
  notional: number;
  status: string;
  source?: FillEvent["source"];
  brokerOrderId?: string;
  executionMode?: FillEvent["executionMode"];
}): FillEvent {
  seq += 1;
  return {
    id: `f-${seq}`,
    accountNumber: "A1",
    source: input.source ?? "paper",
    executionMode: input.executionMode ?? "broker/paper",
    symbol: "AAPL",
    side: input.side,
    quantity: 1,
    price: input.notional,
    notional: input.notional,
    status: input.status,
    brokerOrderId: input.brokerOrderId ?? `bo-${seq}`,
    filledAt: input.filledAt
  };
}

function snap(timestamp: string, equity: number, cash: number, positionsValue: number): EquityCurvePoint {
  return { timestamp, equity, cash, positionsValue, source: "paper" as const };
}

describe("isCashMovingFill", () => {
  it("counts executed fills", () => {
    expect(isCashMovingFill(fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "filled" }))).toBe(true);
    expect(isCashMovingFill(fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 100, status: "partially_filled" }))).toBe(true);
  });

  it("excludes broker-order receipts that never executed (any source)", () => {
    for (const status of ["rejected", "canceled", "expired", "pending", "accepted", "new"]) {
      expect(isCashMovingFill(fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2168, status }))).toBe(false);
      expect(isCashMovingFill(fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 2168, status, source: "live" }))).toBe(false);
    }
  });

  it("keeps legacy local paper rows without a broker order id (mirrors isAccountingFill)", () => {
    const legacy = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "filled" });
    legacy.brokerOrderId = undefined;
    legacy.executionMode = undefined;
    expect(isCashMovingFill(legacy)).toBe(true);
  });
});

describe("rejected/canceled/expired orders are not cash flows", () => {
  it("a rejected sell receipt no longer mints a phantom withdrawal", () => {
    // Pure market dip: positions fall, cash untouched, no real trades.
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 99_600, 60_000, 39_600)
    ];
    const rejectedSell = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_168, status: "rejected" });
    const flows = inferExternalCashFlows(equity, [rejectedSell]);
    expect(flows.size).toBe(0);
  });

  it("canceled and expired buy receipts no longer mint phantom deposits", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 99_600, 60_000, 39_600)
    ];
    const fills = [
      fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 4_320.81, status: "canceled" }),
      fill({ filledAt: "2026-01-03T16:00:00Z", side: "buy", notional: 4_997.9, status: "expired" })
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.size).toBe(0);
  });

  it("end-to-end: rejected stops no longer lift TWR off the real loss (Sandbox -0.2% case)", () => {
    // Internally consistent books: $100k → buy $39k of stock → sell $28k back, small real loss.
    // Rejected synthetic-stop sells are booked with notional but never moved cash.
    const equity = [
      snap("2026-07-21T19:00:00Z", 100_000, 100_000, 0),
      snap("2026-10-22T19:00:00Z", 99_500, 61_000, 38_500),
      snap("2026-11-19T20:00:00Z", 99_000, 89_000, 10_000)
    ];
    const fills = [
      // Trading that actually happened (cash↔stock conversions over the window).
      fill({ filledAt: "2026-10-01T14:00:00Z", side: "buy", notional: 39_000, status: "filled" }),
      fill({ filledAt: "2026-11-10T15:00:00Z", side: "sell", notional: 28_000, status: "filled" }),
      // Rejected synthetic stops — booked with notional, never moved cash.
      fill({ filledAt: "2026-10-21T19:30:00Z", side: "sell", notional: 4_320.81, status: "rejected" }),
      fill({ filledAt: "2026-10-23T14:00:00Z", side: "sell", notional: 2_168, status: "rejected" })
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.size).toBe(0);
    const spy = [
      { date: "2026-07-21", close: 745 },
      { date: "2026-10-22", close: 730 },
      { date: "2026-11-19", close: 713 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows.size > 0 ? flows : undefined)!;
    // The raw equity move IS the performance: no phantom transfers left to neutralize.
    expect(r.accountReturnPct).toBeCloseTo(-1.0, 1);
    expect(r.cashFlowAdjusted).toBe(false);
  });
});

describe("genuine fills and transfers still behave exactly as before", () => {
  it("a filled sell still neutralizes the cash it raised (no false transfer)", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 100_500, 70_000, 30_500)
    ];
    const sold = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 10_000, status: "filled" });
    const flows = inferExternalCashFlows(equity, [sold]);
    expect(flows.size).toBe(0);
  });

  it("a working partial fill still counts its executed notional", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 100_000, 0),
      snap("2026-01-03T20:00:00Z", 95_000, 50_000, 45_000)
    ];
    const partialBuy = fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 50_000, status: "partially_filled" });
    const flows = inferExternalCashFlows(equity, [partialBuy]);
    expect(flows.size).toBe(0);
  });

  it("a real withdrawal alongside open positions is still detected", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 95_000, 55_000, 40_000)
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-01-03")).toBeCloseTo(-5_000, 2);
  });

  it("a real all-cash deposit is still neutralized", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 60_000, 60_000, 0),
      snap("2026-01-03T20:00:00Z", 90_000, 90_000, 0)
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-01-03")).toBeCloseTo(30_000, 2);
  });

  it("a filled buy followed by a rejected sell of the same size books no net flow", () => {
    // The executed buy moved cash; the rejected copy of it must not erase that fact.
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 100_000, 0),
      snap("2026-01-03T20:00:00Z", 100_400, 89_600, 10_800)
    ];
    const fills = [
      fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 10_400, status: "filled" }),
      fill({ filledAt: "2026-01-03T15:01:00Z", side: "sell", notional: 10_400, status: "rejected" })
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.size).toBe(0);
  });
});

describe("drift guard: cash-flow predicate must agree with the P&L predicate", () => {
  it("isCashMovingFill === isAccountingFill over the full status/source/order-id/execution-mode matrix", async () => {
    const { isAccountingFill } = await import("../src/lib/performance");
    const statuses = [
      "filled",
      "partially_filled",
      "pending_reconciliation",
      // raw terminal-decline broker states written under zero-execution-evidence guards
      "rejected",
      "canceled",
      "cancelled",
      "failed",
      "expired",
      "error",
      // non-terminal raw states and anything unexpected fail closed in both
      "pending",
      "accepted",
      "new",
      "open",
      "",
      "bogus"
    ];
    const sources: FillEvent["source"][] = ["paper", "live"];
    const modes: (FillEvent["executionMode"] | "test/local" | undefined)[] = [
      "broker/paper",
      "broker/live",
      "test/local" as FillEvent["executionMode"],
      undefined
    ];
    let cases = 0;
    for (const status of statuses) {
      for (const source of sources) {
        for (const executionMode of modes) {
          for (const hasBrokerOrderId of [true, false]) {
            const f = fill({
              filledAt: "2026-01-03T15:00:00Z",
              side: "sell",
              notional: 100,
              status,
              source,
              executionMode: executionMode as FillEvent["executionMode"]
            });
            if (!hasBrokerOrderId) f.brokerOrderId = undefined;
            expect(isCashMovingFill(f), `status=${status} source=${source} mode=${String(executionMode)} brokerOrderId=${hasBrokerOrderId}`).toBe(
              isAccountingFill(f)
            );
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(100);
  });
});

describe("mixed controls: genuine flows and filled orders alongside phantom receipts", () => {
  it("a genuine withdrawal is recovered exactly when filled trades and rejected receipts share the gap", () => {
    // day2 cash = day1 cash + filledSell proceeds - genuineWithdrawal; positions unchanged.
    const filledProceeds = 1_920.99;
    const genuineWithdrawal = 5_000;
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 100_000 - genuineWithdrawal, 60_000 + filledProceeds - genuineWithdrawal, 40_000)
    ];
    const fills = [
      fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: filledProceeds, status: "filled" }),
      // phantom-class receipts in the same gap must not distort the recovered genuine flow
      fill({ filledAt: "2026-01-03T16:00:00Z", side: "sell", notional: 4_320.81, status: "rejected" }),
      fill({ filledAt: "2026-01-03T17:00:00Z", side: "buy", notional: 572.6, status: "expired" })
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.get("2026-01-03")).toBeCloseTo(-genuineWithdrawal, 6);
    expect(flows.size).toBe(1);
  });

  it("filled orders alone still neutralize to no flow", () => {
    const equity = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 100_000, 61_000, 39_000)
    ];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 1_000, status: "partially_filled" })];
    expect(inferExternalCashFlows(equity, fills).size).toBe(0);
  });
});
