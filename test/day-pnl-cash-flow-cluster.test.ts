import { describe, expect, it } from "vitest";
import { deriveDayPnl } from "../app/console/lib/derive";
import { inferExternalCashFlows } from "../src/lib/cash-flows";
import type { FillEvent, PerformanceSummary } from "../src/lib/types";

const performanceWith = (
  points: Array<{ timestamp: string; equity: number; cash?: number; positionsValue?: number }>,
  fills: FillEvent[] = []
): PerformanceSummary =>
  ({
    paperEquityCurve: points.map((p) => ({ ...p, source: "paper" as const })),
    liveEquityCurve: points.map((p) => ({ ...p, source: "live" as const })),
    fills
  }) as unknown as PerformanceSummary;

describe("perf-02 — directional trade day must not zero Day P&L", () => {
  it("buy $2k with +$1k mark on a $100k book reports +$1k, not $0", () => {
    const now = new Date("2026-06-10T20:00:00Z"); // Wed afternoon CT
    const fills: FillEvent[] = [
      {
        id: "buy1",
        accountNumber: "A1",
        source: "paper",
        symbol: "SPY",
        side: "buy",
        quantity: 1,
        price: 2_000,
        notional: 2_000,
        status: "filled",
        filledAt: "2026-06-10T15:00:00Z"
      } as FillEvent
    ];
    const performance = performanceWith(
      [
        { timestamp: "2026-06-09T20:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0 },
        { timestamp: "2026-06-10T16:00:00Z", equity: 101_000, cash: 98_000, positionsValue: 3_000 }
      ],
      fills
    );
    const portfolio = { totalMarketValue: 101_000, cash: 98_000 };
    const result = deriveDayPnl(performance, "broker/paper", portfolio, now);
    expect(result).not.toBeNull();
    expect(result!.pnl).toBeCloseTo(1_000, 2);
    expect(result!.pct).toBeCloseTo(1, 1);
    expect(Math.abs(result!.pnl)).toBeGreaterThan(0.01);
  });
});

describe("perf-03 — short/cover cash sign in flow inference", () => {
  it("opening a $3k short with flat equity infers zero external flow (not a 2x phantom deposit)", () => {
    const equity = [
      { timestamp: "2026-06-09T20:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-06-10T16:00:00Z", equity: 100_000, cash: 103_000, positionsValue: -3_000, source: "live" as const }
    ];
    const fills: FillEvent[] = [
      {
        id: "f1",
        accountNumber: "A1",
        source: "live",
        symbol: "TSLA",
        side: "short",
        quantity: 10,
        price: 300,
        notional: 3_000,
        status: "filled",
        filledAt: "2026-06-10T15:00:00Z"
      } as FillEvent
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.size).toBe(0);
  });

  it("covering a $3k short with flat equity infers zero external flow (not a phantom withdrawal)", () => {
    const equity = [
      { timestamp: "2026-06-09T20:00:00Z", equity: 100_000, cash: 103_000, positionsValue: -3_000, source: "live" as const },
      { timestamp: "2026-06-10T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "live" as const }
    ];
    const fills: FillEvent[] = [
      {
        id: "f2",
        accountNumber: "A1",
        source: "live",
        symbol: "TSLA",
        side: "cover",
        quantity: 10,
        price: 300,
        notional: 3_000,
        status: "filled",
        filledAt: "2026-06-10T15:00:00Z"
      } as FillEvent
    ];
    const flows = inferExternalCashFlows(equity, fills);
    expect(flows.size).toBe(0);
  });
});
