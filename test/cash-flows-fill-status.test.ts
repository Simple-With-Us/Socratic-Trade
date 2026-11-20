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
  raw?: FillEvent["raw"];
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
    filledAt: input.filledAt,
    raw: input.raw
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
    // The executed-status short-circuit (filled/partially_filled -> true) must NOT decide
    // these: a non-executed status makes the legacy branch itself the deciding path.
    const legacyUndefinedMode = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "rejected" });
    legacyUndefinedMode.brokerOrderId = undefined;
    legacyUndefinedMode.executionMode = undefined;
    expect(isCashMovingFill(legacyUndefinedMode)).toBe(true);

    const legacyTestLocal = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "expired" });
    legacyTestLocal.brokerOrderId = undefined;
    legacyTestLocal.executionMode = "test/local" as FillEvent["executionMode"];
    expect(isCashMovingFill(legacyTestLocal)).toBe(true);
  });

  it("legacy-row negative controls: broker id or incompatible mode excludes non-executed rows", () => {
    // Same shape as the legacy rows but with a broker order id: reconciliation-booked, excluded.
    const withBrokerId = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "rejected" });
    withBrokerId.executionMode = undefined;
    expect(isCashMovingFill(withBrokerId)).toBe(false);

    // No broker id but a broker execution mode: not a legacy local row, excluded.
    const brokerMode = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "rejected" });
    brokerMode.brokerOrderId = undefined;
    brokerMode.executionMode = "broker/live";
    expect(isCashMovingFill(brokerMode)).toBe(false);

    const brokerPaperMode = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 100, status: "canceled" });
    brokerPaperMode.brokerOrderId = undefined;
    brokerPaperMode.executionMode = "broker/paper";
    expect(isCashMovingFill(brokerPaperMode)).toBe(false);
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

  it("pending live rows pin the INTENTIONAL predicate divergence (Kody qrM)", async () => {
    // The cash-flow display admits a non-paper pending_reconciliation row only when the writer
    // persisted broker execution truth on it (raw.execution filledQuantity AND averagePrice,
    // both positive finite — the hasBrokerReportedPricedFill contract). The P&L predicate
    // (isAccountingFill, performance.ts) NEVER admits a pending row: realized accounting waits
    // for reconciliation. That divergence is deliberate — the cash hint cares that executed
    // cash moved; the ledger cares about booked truth — and it must stay asserted, because the
    // matrix above never sets raw and would let a silent re-unification (or a raw-shape change
    // restoring the phantom class) pass green.
    const { isAccountingFill } = await import("../src/lib/performance");
    const base = {
      filledAt: "2026-01-03T15:00:00Z",
      side: "buy" as const,
      notional: 10_000,
      status: "pending_reconciliation",
      source: "live" as const,
      executionMode: "broker/live" as const
    };
    // Admitted by the cash-flow predicate only: BOTH fields present and positive.
    const executedPending = fill({ ...base, raw: { execution: { filledQuantity: 100, averagePrice: 100 } } });
    expect(isCashMovingFill(executedPending)).toBe(true);
    expect(isAccountingFill(executedPending)).toBe(false);
    // Everything else agrees on exclusion: price-only (writer falls back to proposal quantity),
    // quantity-only, no payload, synthetic-stop provisional, non-finite fields.
    const excluded: FillEvent[] = [
      fill({ ...base, raw: { execution: { averagePrice: 100 } } }),
      fill({ ...base, raw: { execution: { filledQuantity: 100 } } }),
      fill({ ...base }),
      fill({ ...base, raw: { syntheticStop: true, triggerPrice: 100 } }),
      fill({ ...base, raw: { execution: { filledQuantity: 100, averagePrice: 0 } } }),
      fill({ ...base, raw: { execution: { filledQuantity: 100, averagePrice: Number.NaN } } })
    ];
    for (const row of excluded) {
      expect(isCashMovingFill(row)).toBe(false);
      expect(isAccountingFill(row)).toBe(false);
    }
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

describe("equity-only gaps: declined receipts are NOT order-activity evidence (pinned semantics)", () => {
  // Adjudication of PR 5427 review thread PRRT_kwDOS7mOVM65yz8K. The missing-cash branch
  // (4) only fires for legacy/synthetic non-brokerHistory points: persisted snapshots
  // require cash, and brokerHistory points are excluded. A rejected/canceled/expired
  // receipt moves no cash and opens no position (piece-1 audit: a row persisting in those
  // statuses has zero execution evidence), so it cannot be evidence that the account may
  // be non-flat. Suppressing the branch on such receipts would HIDE genuine transfers on
  // flat books (e.g. 100k -> 90k with a rejected order is a real 10k withdrawal).
  const eqOnly = (timestamp: string, equity: number): EquityCurvePoint =>
    ({ timestamp, equity, source: "paper" as const });

  it("a rejected-only gap behaves exactly like a no-receipt gap", () => {
    const curve = [eqOnly("2026-01-02T20:00:00Z", 100_000), eqOnly("2026-01-03T20:00:00Z", 90_000)];
    const rejected = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_168, status: "rejected" })];
    const withReceipt = inferExternalCashFlows(curve, rejected);
    const withoutReceipt = inferExternalCashFlows(curve, []);
    expect([...withReceipt.entries()]).toEqual([...withoutReceipt.entries()]);
    expect(withReceipt.get("2026-01-03")).toBeCloseTo(-10_000, 6);
  });

  it("a genuine transfer is still detected in a gap that also has a rejected receipt", () => {
    // Flat legacy curve, real 10k withdrawal, plus a rejected stop receipt: the transfer
    // must NOT be suppressed by the receipt (the accidental pre-PR behavior).
    const curve = [eqOnly("2026-01-02T20:00:00Z", 100_000), eqOnly("2026-01-03T20:00:00Z", 90_000)];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_168, status: "rejected" })];
    const flows = inferExternalCashFlows(curve, fills);
    expect(flows.get("2026-01-03")).toBeCloseTo(-10_000, 6);
    expect(flows.size).toBe(1);
  });

  it("an EXECUTED fill in the equity-only gap still suppresses invention (position-exposure ambiguity)", () => {
    const curve = [eqOnly("2026-01-02T20:00:00Z", 100_000), eqOnly("2026-01-03T20:00:00Z", 101_000)];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "buy", notional: 2_168, status: "filled" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("cash-bearing curves are unchanged by the equity-only semantics (suite already pins the phantom cases)", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 90_000, 50_000, 40_000)
    ];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_168, status: "rejected" })];
    const flows = inferExternalCashFlows(curve, fills);
    expect(flows.get("2026-01-03")).toBeCloseTo(-10_000, 6);
    expect(flows.size).toBe(1);
  });
});

describe("legacy kept rows: flow-level control", () => {
  it("a legacy kept row's notional participates in tradeCash (mutation-sensitive)", () => {
    // Reviewer-calibrated fixture: equity moves WITH cash (+1,000 both), positions flat.
    // With the legacy clause REMOVED the row is excluded, tradeCash = 0, and the
    // cash-and-equity-moved-together guard books a +1,000 phantom deposit. With the clause
    // the row's notional neutralizes the cash delta to no flow. (An equity-flat fixture is
    // NOT sensitive here: the cash-moved/equity-flat guard zeroes it either way.)
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 101_000, 61_000, 40_000)
    ];
    const legacy = fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 1_000, status: "rejected" });
    legacy.brokerOrderId = undefined;
    legacy.executionMode = undefined;
    expect(inferExternalCashFlows(curve, [legacy]).size).toBe(0);
  });
});
