import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../app/dashboard-types";
import type { EquityCurvePoint, EquityPosition, Portfolio, TradingPolicy } from "../src/lib/types";
import { deriveMarkToMarket, deriveRiskUtilization, selectEquityWindow } from "../app/console/lib/derive";

function snapshotWith(input: {
  positions?: EquityPosition[];
  portfolio?: Partial<Portfolio>;
  dailyStats?: DashboardSnapshot["dailyStats"];
  policy?: Partial<TradingPolicy>;
}): DashboardSnapshot {
  return {
    positions: input.positions ?? [],
    portfolio: input.portfolio as Portfolio | undefined,
    dailyStats: input.dailyStats ?? { orderCount: 0, openingOrderCount: 0, notional: 0 },
    policy: {
      maxDailyOrders: 6,
      maxDailyNotional: 10_000,
      ...input.policy
    } as TradingPolicy
  } as DashboardSnapshot;
}

describe("console live-data derivations", () => {
  it("derives open mark-to-market from the signed open book", () => {
    const snapshot = snapshotWith({
      positions: [
        { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_250 },
        { symbol: "MSFT", quantity: 5, averageCost: 200, marketValue: 950 }
      ],
      portfolio: { equityMarketValue: 2_200, cash: 500, buyingPower: 750 } satisfies Partial<Portfolio>
    });

    expect(deriveMarkToMarket(snapshot)).toEqual({
      costBasis: 2_000,
      marketValue: 2_200,
      unrealizedPnl: 200,
      unrealizedPct: 10,
      positionsValue: 2_200,
      cash: 500,
      buyingPower: 750
    });
  });

  it("derives daily notional, order, and deployed-capital utilization", () => {
    const snapshot = snapshotWith({
      positions: [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 }],
      portfolio: { totalMarketValue: 2_000, equityMarketValue: 1_200 } satisfies Partial<Portfolio>,
      dailyStats: { orderCount: 3, openingOrderCount: 2, notional: 2_500 },
      policy: { maxDailyOrders: 8, maxDailyNotional: 5_000 }
    });

    expect(deriveRiskUtilization(snapshot)).toEqual({
      dailyNotional: { used: 2_500, limit: 5_000, pct: 50 },
      dailyOrders: { used: 2, limit: 8, pct: 25 },
      investedCapital: { used: 1_200, limit: 2_000, pct: 60 }
    });
  });

  it("treats missing positions as zero deployed capital in degraded snapshots", () => {
    const snapshot = snapshotWith({
      dailyStats: { orderCount: 0, openingOrderCount: 0, notional: 0 },
      policy: { maxDailyOrders: 8, maxDailyNotional: 5_000 }
    });
    delete (snapshot as Partial<DashboardSnapshot>).positions;

    expect(deriveRiskUtilization(snapshot).investedCapital).toEqual({
      used: 0,
      limit: undefined,
      pct: undefined
    });
  });

  it("prefers today's equity points for the intraday chart when enough exist", () => {
    const points: EquityCurvePoint[] = [
      { timestamp: "2026-07-03T20:00:00.000Z", equity: 9_800, source: "live" },
      { timestamp: "2026-07-04T14:00:00.000Z", equity: 10_000, source: "live" },
      { timestamp: "2026-07-04T15:00:00.000Z", equity: 10_120, source: "live" }
    ];

    const selected = selectEquityWindow(points, new Date("2026-07-04T16:00:00.000Z"));
    expect(selected.label).toBe("Intraday mark-to-market");
    expect(selected.points).toEqual(points.slice(1));
  });

  it("falls back to the most recent window when today has fewer than two points", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      timestamp: `2026-06-${String(index + 1).padStart(2, "0")}T20:00:00.000Z`,
      equity: 10_000 + index,
      source: "paper" as const
    }));

    const selected = selectEquityWindow(points, new Date("2026-07-04T16:00:00.000Z"));
    expect(selected.label).toBe("Recent equity");
    expect(selected.points).toHaveLength(24);
    expect(selected.points[0]).toEqual(points[6]);
  });
});
