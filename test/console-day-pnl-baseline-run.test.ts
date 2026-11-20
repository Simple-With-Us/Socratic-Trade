import { describe, expect, it } from "vitest";
import { deriveDayPnl } from "../app/console/lib/derive";
import type { FillEvent, PerformanceSummary } from "../src/lib/types";

/**
 * CANDIDATE (unpublished, pending separate qualification): deriveDayPnl passes all fills
 * with t <= now to inferExternalCashFlows; the v4 run-identity assigner does the windowing.
 * Earlier other-run fills land in the baseline's own (unreported) gap; the baseline run's
 * own fills defer into today's gap because the baseline's cash is its run's start-fetch.
 *
 * Provenance: "REAL" fixtures replay actual live-account inputs (Tradier Sandbox account
 * becad9f1, snapshots + fills from the 2026-11-19 API pull, host-verified runIds). A replay
 * establishes code output under reconstructed conditions only — not what any screen
 * historically showed, and the balance-change reference assumes no real external transfer
 * in the window (none appears in the account's fill/activity data for it).
 */

let seq = 0;
function fill(input: {
  filledAt: string;
  side: FillEvent["side"];
  symbol?: string;
  notional: number;
  status?: FillEvent["status"];
  runId?: string;
}): FillEvent {
  seq += 1;
  return {
    id: `f-${seq}`,
    accountNumber: "VA93389646",
    source: "live",
    executionMode: "broker/live",
    symbol: input.symbol ?? "VZ",
    side: input.side,
    quantity: 1,
    price: input.notional,
    notional: input.notional,
    status: input.status ?? "filled",
    brokerOrderId: `bo-${seq}`,
    filledAt: input.filledAt,
    runId: input.runId
  };
}

function perf(curve: PerformanceSummary["liveEquityCurve"], fills: FillEvent[]): PerformanceSummary {
  return { liveEquityCurve: curve, paperEquityCurve: [], fills } as unknown as PerformanceSummary;
}

// REAL 2026-11-04 post-run snapshot (host-verified run 30ac371e; run-start fetch: cash
// excludes the run's two buys).
const BASELINE_1104 = {
  timestamp: "2026-11-04T20:34:50.413Z",
  equity: 98_216.085,
  cash: 55_180.77,
  positionsValue: 43_035.315,
  source: "live" as const,
  runId: "run-30ac"
};
// REAL 11/4 buys, executed 1.1s and 3.9s before the baseline row.
const BASELINE_RUN_BUYS = [
  fill({ filledAt: "2026-11-04T20:34:46.530Z", side: "buy", symbol: "VZ", notional: 967.89, runId: "run-30ac" }),
  fill({ filledAt: "2026-11-04T20:34:49.312Z", side: "buy", symbol: "BMY", notional: 953.1, runId: "run-30ac" })
];
// REAL 11/5 fills (live API newest-100 payload).
const REAL_1105_FILLS = [
  fill({ filledAt: "2026-11-05T14:58:22.674Z", side: "buy", symbol: "SIRI", notional: 2_688.8, runId: "run-cae9" }),
  fill({ filledAt: "2026-11-05T15:54:09.122Z", side: "sell", symbol: "UNH", notional: 2_468.88, runId: "run-9122" }),
  fill({ filledAt: "2026-11-05T15:54:11.247Z", side: "sell", symbol: "BP", notional: 692.55, runId: "run-9122" }),
  fill({ filledAt: "2026-11-05T15:54:29.779Z", side: "buy", symbol: "MO", notional: 1_109.78, runId: "run-9122" }),
  fill({ filledAt: "2026-11-05T15:54:29.794Z", side: "buy", symbol: "MO", notional: 1_109.78, runId: "run-9122" }),
  fill({ filledAt: "2026-11-05T17:56:03.314Z", side: "buy", symbol: "ELV", notional: 2_154.45, runId: "run-4b11" }),
  fill({ filledAt: "2026-11-05T17:56:11.251Z", side: "buy", symbol: "TMUS", notional: 0, status: "expired", runId: "run-4b11" }),
  fill({ filledAt: "2026-11-05T17:56:14.517Z", side: "sell", symbol: "VZ", notional: 462.7, runId: "run-4b11" }),
  fill({ filledAt: "2026-11-05T17:57:45.706Z", side: "buy", symbol: "ADP", notional: 916.26, runId: "run-4b11" }),
  fill({ filledAt: "2026-11-05T18:23:11.045Z", side: "sell", symbol: "TTE", notional: 6_107.08 }),
  fill({ filledAt: "2026-11-05T19:26:09.736Z", side: "buy", symbol: "AFL", notional: 1_519.44, runId: "run-694c" }),
  fill({ filledAt: "2026-11-05T20:05:04.952Z", side: "buy", symbol: "JPM", notional: 4_046.16, runId: "run-eefd" }),
  fill({ filledAt: "2026-11-05T20:53:06.144Z", side: "sell", symbol: "BP", notional: 1_214.19 })
];

describe("deriveDayPnl baseline-run inclusion via run-identity assignment (candidate)", () => {
  it("REAL 2026-11-05 replay corrected: no flow; day P&L is the reference balance change -814.84 (-0.83%)", () => {
    const portfolio = { totalMarketValue: 97_401.2405, cash: 50_660.51 }; // REAL 11/5 snapshot
    const day = deriveDayPnl(
      perf([BASELINE_1104], [...BASELINE_RUN_BUYS, ...REAL_1105_FILLS]),
      "broker/live",
      portfolio,
      new Date("2026-11-05T21:06:29.573Z")
    );
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-814.84, 2);
    expect(day!.pct).toBeCloseTo(-0.83, 2);
    expect(day!.cashFlowAdjusted).toBeUndefined();
  });

  it("baseline ID stripped (known limit): the pre-fix artifact persists, pinned", () => {
    const baseline = { ...BASELINE_1104, runId: undefined };
    const portfolio = { totalMarketValue: 97_401.2405, cash: 50_660.51 };
    const day = deriveDayPnl(
      perf([baseline], [...BASELINE_RUN_BUYS, ...REAL_1105_FILLS]),
      "broker/live",
      portfolio,
      new Date("2026-11-05T21:06:29.573Z")
    );
    expect(day).not.toBeNull();
    // Unlabeled baseline cannot defer the two dropped buys: phantom withdrawal -1,920.99.
    expect(day!.pnl).toBeCloseTo(1_106.15, 2);
    expect(day!.cashFlowAdjusted).toBe(true);
    expect(day!.cashFlowSource).toBe("inferred");
  });

  it("earlier other-run fill before the baseline is excluded (lands in the baseline's own gap)", () => {
    // Baseline cash already includes this older fill's effect; today's cash reflects only
    // the baseline run's settle-in. If the older fill leaked into today's gap it would mint
    // a +1,000 phantom deposit.
    const olderFill = fill({ filledAt: "2026-11-04T19:00:00Z", side: "buy", symbol: "XOM", notional: 1_000, runId: "run-older" });
    const portfolio = { totalMarketValue: 98_216.085, cash: 55_180.77 - 1_920.99 };
    const day = deriveDayPnl(perf([BASELINE_1104], [olderFill, ...BASELINE_RUN_BUYS]), "broker/live", portfolio, new Date("2026-11-05T15:00:00Z"));
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(0, 2);
    expect(day!.cashFlowAdjusted).toBeUndefined();
  });

  it("within-day fills are counted exactly as before (no behavior change inside the day)", () => {
    // A within-day sell whose proceeds are in today's cash: pre-fix it passed the t-filter;
    // now it reaches inference the same way via the covering gap.
    const sell = fill({ filledAt: "2026-11-05T18:23:11.045Z", side: "sell", symbol: "TTE", notional: 6_107.08, runId: "run-9122" });
    const portfolio = { totalMarketValue: 98_216.085, cash: 55_180.77 + 6_107.08 };
    const day = deriveDayPnl(perf([BASELINE_1104], [sell]), "broker/live", portfolio, new Date("2026-11-05T21:00:00Z"));
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(0, 2);
    expect(day!.cashFlowAdjusted).toBeUndefined();
  });

  it("null-ID parity: with no runIds anywhere the output is exactly the pre-fix result", () => {
    const baseline = { ...BASELINE_1104, runId: undefined };
    const nullFills = [...BASELINE_RUN_BUYS, ...REAL_1105_FILLS].map((f) => ({ ...f, runId: undefined }));
    const portfolio = { totalMarketValue: 97_401.2405, cash: 50_660.51 };
    const day = deriveDayPnl(perf([baseline], nullFills), "broker/live", portfolio, new Date("2026-11-05T21:06:29.573Z"));
    expect(day).not.toBeNull();
    // Same as the pre-fix t-windowed output on these inputs (artifact, pinned as parity).
    expect(day!.pnl).toBeCloseTo(1_106.15, 2);
    expect(day!.cashFlowAdjusted).toBe(true);
    expect(day!.cashFlowSource).toBe("inferred");
  });

  it("market-up settle-in day: the real equity move survives instead of pinning to zero", () => {
    const positions = (43_035.315 + 1_920.99) * 1.012; // settled book up 1.2%
    const portfolio = { totalMarketValue: 53_259.78 + positions, cash: 53_259.78 };
    const day = deriveDayPnl(perf([BASELINE_1104], [...BASELINE_RUN_BUYS]), "broker/live", portfolio, new Date("2026-11-05T15:00:00Z"));
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(539.48, 2);
    expect(day!.pct).toBeCloseTo(0.55, 2);
    expect(day!.cashFlowAdjusted).toBeUndefined();
  });

  it("broker-hint bypass: an authoritative todayBrokerFlow skips inference entirely", () => {
    const portfolio = { totalMarketValue: 97_401.2405, cash: 50_660.51 };
    const day = deriveDayPnl(
      perf([BASELINE_1104], [...BASELINE_RUN_BUYS, ...REAL_1105_FILLS]),
      "broker/live",
      portfolio,
      new Date("2026-11-05T21:06:29.573Z"),
      { todayBrokerFlow: -250, cashFlowSource: "broker" }
    );
    expect(day).not.toBeNull();
    // flow = -250 from the ledger, not the inferred -1,920.99: pnl = -814.84 + 250.
    expect(day!.pnl).toBeCloseTo(-564.84, 2);
    expect(day!.cashFlowAdjusted).toBe(true);
    expect(day!.cashFlowSource).toBe("broker");
  });
});
