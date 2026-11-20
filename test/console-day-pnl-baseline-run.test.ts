import { describe, expect, it } from "vitest";
import { deriveDayPnl } from "../app/console/lib/derive";
import type { FillEvent, PerformanceSummary } from "../src/lib/types";
import { computeDayPnlInferredHint, inferExternalCashFlows, inferTodayExternalFlow, selectDayPnlBaseline } from "../src/lib/cash-flows";
import { startOfCentralTradingDay } from "../src/lib/trading-day";
import { startOfCentralDay } from "../app/console/lib/format";

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
  raw?: FillEvent["raw"];
}): FillEvent {
  seq += 1;
  return {
    id: `f-${seq}`,
    accountNumber: "VA00000000", // synthetic — never a real account identifier (Kody W0F)
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
    runId: input.runId,
    raw: input.raw
  };
}

function perf(curve: PerformanceSummary["liveEquityCurve"], fills: FillEvent[]): PerformanceSummary {
  // Complete value, no cast escape: a new required PerformanceSummary field must fail HERE at
  // compile time rather than hide an invalid fixture (Kody W4O). Zeroed scorecard fields are
  // inert for deriveDayPnl, which reads only the curve, fills and hints.
  return {
    liveEquityCurve: curve,
    paperEquityCurve: [],
    liveRealizedPnl: 0,
    paperRealizedPnl: 0,
    liveUnrealizedPnl: 0,
    paperUnrealizedPnl: 0,
    liveWinRate: 0,
    paperWinRate: 0,
    liveAverageReturnPct: 0,
    paperAverageReturnPct: 0,
    liveClosedLotCount: 0,
    paperClosedLotCount: 0,
    liveUnmatchedClosingFills: 0,
    paperUnmatchedClosingFills: 0,
    attribution: [],
    fills
  };
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

// The hint shape the server ships for this fixture: same day, same baseline, same portfolio.
function serverHint(flow: number) {
  return {
    mode: "live" as const,
    flow,
    dayKey: "2026-11-18",
    baselineAt: "2026-11-17T21:00:00.000Z",
    currentEquity: 88_000,
    currentCash: 40_000
  };
}

describe("server inferred-flow hint vs display-truncated fills (Kody Wx0)", () => {
  // PerformanceSummary.fills is allFills.slice(-100) — a DISPLAY tail. Once the ledger outgrows
  // it, fills that explain a cash delta can fall off, and the console's local inference mints a
  // phantom transfer. Shape that defeats the missing-fill guards: a 10k buy while OTHER holdings
  // drop 12k — cash and positions move in the SAME direction, so no guard can reconstruct the
  // trade from aggregates.
  const baseline = {
    timestamp: "2026-11-17T21:00:00.000Z", // Monday 15:00 Central
    equity: 100_000,
    cash: 50_000,
    positionsValue: 50_000,
    source: "live" as const,
    runId: "run-base"
  };
  const NOW = new Date("2026-11-18T20:00:00.000Z"); // Tuesday 14:00 Central
  // Bought 10k; other holdings fell 12k; bought name flat. cash 40k, positions 48k, equity 88k.
  const portfolio = { totalMarketValue: 88_000, cash: 40_000 };
  const bigBuy = fill({ filledAt: "2026-11-18T15:35:00.000Z", side: "buy", symbol: "VZ", notional: 10_000, runId: "run-today" });
  const tinyFills = Array.from({ length: 100 }, (_, i) =>
    fill({
      filledAt: `2026-11-18T16:${String(10 + (i % 40)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      side: i % 2 === 0 ? "buy" : "sell",
      symbol: "MO",
      notional: 10,
      runId: "run-today"
    })
  );
  const fullLedger = [bigBuy, ...tinyFills];
  const displayTail = fullLedger.slice(-100); // what PerformanceSummary.fills actually carries

  it("display tail really does drop the explanatory fill (fixture sanity)", () => {
    expect(displayTail).toHaveLength(100);
    expect(displayTail.some((f) => f.notional === 10_000)).toBe(false);
  });

  it("full-ledger helper: no external flow (the buy explains the cash move)", () => {
    const flow = inferTodayExternalFlow({
      baseline,
      fills: fullLedger,
      currentEquity: portfolio.totalMarketValue,
      currentCash: portfolio.cash,
      now: NOW
    });
    expect(flow).toBe(0);
  });

  it("truncated tail alone: the phantom withdrawal survives the guards (pinned production limit)", () => {
    const flow = inferTodayExternalFlow({
      baseline,
      fills: displayTail,
      currentEquity: portfolio.totalMarketValue,
      currentCash: portfolio.cash,
      now: NOW
    });
    expect(flow).toBe(-10_000);
  });

  it("server hint present: deriveDayPnl uses the full-ledger flow, not the tail phantom", () => {
    const summary = perf([baseline], displayTail);
    summary.dayPnlHints = { todayInferredFlow: serverHint(0) };
    const day = deriveDayPnl(summary, "broker/live", portfolio, NOW, summary.dayPnlHints);
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-12_000, 2); // 88k - 100k - 0
    expect(day!.cashFlowSource).toBe("inferred");
  });

  it("hint absent (legacy snapshot): fallback infers from the tail — phantom documented, not silently solved", () => {
    const day = deriveDayPnl(perf([baseline], displayTail), "broker/live", portfolio, NOW);
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-2_000, 2); // 88k - 100k - (-10k): the pre-hint artifact
  });

  it("hint keyed to the other mode is ignored; local inference runs instead", () => {
    const summary = perf([baseline], displayTail);
    summary.dayPnlHints = { todayInferredFlow: { ...serverHint(0), mode: "paper" as const } };
    const day = deriveDayPnl(summary, "broker/live", portfolio, NOW, summary.dayPnlHints);
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-2_000, 2); // same as no hint
  });

  it("broker hint still outranks the inferred hint", () => {
    const summary = perf([baseline], displayTail);
    summary.dayPnlHints = { todayBrokerFlow: 250, todayInferredFlow: serverHint(0), cashFlowSource: "broker" };
    const day = deriveDayPnl(summary, "broker/live", portfolio, NOW, summary.dayPnlHints);
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-12_250, 2); // broker flow wins
    expect(day!.cashFlowSource).toBe("broker");
  });

  it.each([
    ["stale day key", { dayKey: "2026-11-17" }],
    ["different baseline point", { baselineAt: "2026-11-16T21:00:00.000Z" }],
    ["equity moved since the snapshot", { currentEquity: 88_500 }],
    ["cash moved since the snapshot", { currentCash: 40_500 }]
  ])("hint ignored on input mismatch: %s", (_label, override) => {
    const hint = { ...serverHint(0), ...override };
    const day = deriveDayPnl(perf([baseline], displayTail), "broker/live", portfolio, NOW, { todayInferredFlow: hint });
    expect(day).not.toBeNull();
    // Every mismatch must fall back to the local tail inference, phantom and all — never apply
    // a flow computed for a different day, baseline or portfolio.
    expect(day!.pnl).toBeCloseTo(-2_000, 2);
  });

  it("hint ignored when priorCloseEquity is set (server flow was computed against baseline.equity, not the override)", () => {
    // priorCloseEquity is never written by any server code today (source-verified); if it ever
    // accompanies a hint, the hint's guard used baseline.equity while the console overrides to
    // the broker close — different premises, so the hint must not apply. Falls back to the tail
    // inference, and the override also moves baselineEquity: 88k - 99k - (-10k) = -1k.
    const day = deriveDayPnl(perf([baseline], displayTail), "broker/live", portfolio, NOW, {
      todayInferredFlow: serverHint(0),
      priorCloseEquity: 99_000
    });
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(-1_000, 2);
  });
});

describe("day-boundary equivalence (review gap 1: one baseline implementation, no policy change)", () => {
  // derive.ts previously used startOfCentralDay (console format.ts); the shared selector uses
  // startOfCentralTradingDay (trading-day.ts). Identical algorithm by construction — pinned here
  // across the instants most likely to diverge, so unifying on the shared selector changes NO
  // existing day-boundary behavior.
  it("startOfCentralDay === startOfCentralTradingDay across DST, midnight and weekend instants", () => {
    const instants: number[] = [];
    // Hourly sweeps across both 2026 DST transitions and a weekend-midnight crossing.
    for (const start of ["2026-03-07T00:00:00-06:00", "2026-10-31T00:00:00-05:00", "2026-11-13T00:00:00-06:00"]) {
      const t0 = new Date(start).getTime();
      for (let h = 0; h <= 72; h++) instants.push(t0 + h * 3_600_000);
    }
    // Exact local midnights either side of a boundary.
    instants.push(new Date("2026-11-18T00:00:00-06:00").getTime() - 1);
    instants.push(new Date("2026-11-18T00:00:00-06:00").getTime());
    for (const ms of instants) {
      expect(startOfCentralDay(new Date(ms)).getTime()).toBe(startOfCentralTradingDay(new Date(ms)).getTime());
    }
  });

  it("selectDayPnlBaseline matches the legacy inline loop (last point strictly before Central today)", () => {
    const curve = [
      { timestamp: "2026-11-16T21:00:00.000Z", equity: 1, source: "live" as const },
      { timestamp: "2026-11-17T21:00:00.000Z", equity: 2, source: "live" as const },
      { timestamp: "2026-11-18T15:00:00.000Z", equity: 3, source: "live" as const }
    ];
    const now = new Date("2026-11-18T20:00:00.000Z");
    expect(selectDayPnlBaseline(curve, now)?.timestamp).toBe("2026-11-17T21:00:00.000Z");
    expect(selectDayPnlBaseline(curve, new Date("2026-11-17T20:00:00.000Z"))?.timestamp).toBe("2026-11-16T21:00:00.000Z");
    expect(selectDayPnlBaseline([], now)).toBeUndefined();
  });
});

describe("computeDayPnlInferredHint (server wiring, review gap 3)", () => {
  const liveBaseline = {
    timestamp: "2026-11-17T21:00:00.000Z",
    equity: 100_000,
    cash: 50_000,
    positionsValue: 50_000,
    source: "live" as const,
    runId: "run-base"
  };
  const paperBaseline = { ...liveBaseline, runId: "run-paper" };
  const NOW = new Date("2026-11-18T20:00:00.000Z");
  const liveBuy = fill({ filledAt: "2026-11-18T15:35:00.000Z", side: "buy", symbol: "VZ", notional: 10_000, runId: "run-today" });
  // Discriminating ledgers (Kody UVy): the paper buy differs from the live buy, so the paper
  // hint's flow DEPENDS on reading paperFills — a mode swap yields a different value.
  const paperBuy = fill({ filledAt: "2026-11-18T16:00:00.000Z", side: "buy", symbol: "MO", notional: 5_000, runId: "run-paper-today" });
  const portfolio = { totalMarketValue: 88_000, cash: 40_000 };
  const args = {
    liveCurve: [liveBaseline],
    paperCurve: [paperBaseline],
    liveFills: [liveBuy],
    paperFills: [paperBuy],
    portfolio,
    now: NOW
  };

  it("live mode uses the live curve and live ledger, and carries its inputs", () => {
    const hint = computeDayPnlInferredHint({ ...args, mode: "live" });
    expect(hint).toEqual({
      mode: "live",
      flow: 0, // the live buy explains the cash move
      dayKey: "2026-11-18",
      baselineAt: "2026-11-17T21:00:00.000Z",
      currentEquity: 88_000,
      currentCash: 40_000
    });
  });

  it("paper mode selects the paper curve and paper ledger (mode-to-ledger binding)", () => {
    // Same portfolio, same curve shape as live — only the LEDGER differs. Live: the 10k buy
    // explains the cash move (flow 0). Paper: the 5k buy explains half of it (flow -5k).
    // A live/paper ledger swap would produce 0 here, so this asserts the binding itself.
    const hint = computeDayPnlInferredHint({ ...args, mode: "paper" });
    expect(hint).not.toBeUndefined();
    expect(hint!.mode).toBe("paper");
    expect(hint!.baselineAt).toBe("2026-11-17T21:00:00.000Z");
    expect(hint!.flow).toBe(-5_000);
    expect(hint!.flow).not.toBe(computeDayPnlInferredHint({ ...args, mode: "live" })!.flow);
  });

  it.each([
    ["no baseline on the mode's curve", { paperCurve: [] as typeof liveBaseline[], mode: "paper" as const }],
    ["zero-equity baseline", { liveCurve: [{ ...liveBaseline, equity: 0 }] }],
    ["non-finite portfolio equity", { portfolio: { totalMarketValue: Number.NaN, cash: 40_000 } }],
    ["absent portfolio", { portfolio: undefined }]
  ])("returns undefined, never a guess: %s", (_label, override) => {
    expect(computeDayPnlInferredHint({ ...args, mode: "live", ...override })).toBeUndefined();
  });

  it("zero flow is a VALID hint (not confused with absent)", () => {
    const hint = computeDayPnlInferredHint({ ...args, mode: "live" });
    expect(hint).not.toBeUndefined();
    expect(hint!.flow).toBe(0);
  });
});

describe("priorCloseEquity synthetic-baseline fallback (host-caught compile/fallback regression)", () => {
  // v2 of this fix declared `const baseline` while this branch REASSIGNS it and referenced the
  // removed `todayStart`. Runtime tests never executed the branch, so neither failure showed.
  // This test executes it.
  it("no pre-today curve point + broker prior close: synthetic yesterday baseline carries the day", () => {
    const portfolio = { totalMarketValue: 100_500, cash: 40_000 };
    const now = new Date("2026-11-18T20:00:00.000Z"); // Tuesday 14:00 Central
    // Curve non-empty (an empty curve returns null earlier by design) but nothing before today.
    const todayPoint = { timestamp: "2026-11-18T15:00:00.000Z", equity: 100_000, source: "live" as const };
    const day = deriveDayPnl(perf([todayPoint], []), "broker/live", portfolio, now, { priorCloseEquity: 99_000 });
    expect(day).not.toBeNull();
    expect(day!.pnl).toBeCloseTo(1_500, 2); // 100.5k - 99k, no flow (synthetic baseline has no cash)
    expect(day!.baselineEquity).toBe(99_000);
    expect(day!.baselineAt).toBe(new Date(startOfCentralTradingDay(now).getTime() - 86_400_000).toISOString());
  });

  it("no pre-today curve point and no prior close: still null, never invented", () => {
    const todayPoint = { timestamp: "2026-11-18T15:00:00.000Z", equity: 100_000, source: "live" as const };
    const day = deriveDayPnl(perf([todayPoint], []), "broker/live", { totalMarketValue: 100_500, cash: 40_000 }, new Date("2026-11-18T20:00:00.000Z"));
    expect(day).toBeNull();
  });
});

describe("executed-marker pending fills (Kody UKS re-adjudication)", () => {
  // Writer census (10a4c73): strategy.ts books pending_reconciliation for a WORKING order whose
  // broker state is non-terminal but already reports a priced partial fill; raw.execution then
  // carries BOTH filledQuantity and averagePrice and the row notional is their product, real
  // cash moved. A price-only pending is not truth: recordFillFromProposal falls back to the
  // proposal quantity when filledQuantity is absent, so its notional is unexecuted requests.
  // The marker mirrors hasBrokerReportedPricedFill (broker-side.ts): BOTH fields, positive
  // finite. Provisional pendings (resting synthetic stops at quote, placeholder receipts at
  // price/notional 0) carry no execution payload at all.
  const baseline = {
    timestamp: "2026-11-17T21:00:00.000Z",
    equity: 100_000,
    cash: 50_000,
    positionsValue: 50_000,
    source: "live" as const,
    runId: "run-base"
  };
  const NOW = new Date("2026-11-18T20:00:00.000Z");
  // Bought 10k (broker-confirmed priced execution on a still-working order); other holdings
  // fell 12k.
  const portfolio = { totalMarketValue: 88_000, cash: 40_000 };
  const flowWith = (raw: unknown) =>
    inferTodayExternalFlow({
      baseline,
      fills: [
        fill({
          filledAt: "2026-11-18T15:35:00.000Z",
          side: "buy",
          symbol: "VZ",
          notional: 10_000,
          runId: "run-today",
          status: "pending_reconciliation",
          raw
        })
      ],
      currentEquity: portfolio.totalMarketValue,
      currentCash: portfolio.cash,
      now: NOW
    });

  it("working order with priced broker execution (qty AND price) is cash-moving: no phantom", () => {
    // Non-terminal broker state is why this row is pending rather than filled: the strategy.ts
    // caller marks filled only on terminal/partial states with a priced fill.
    expect(flowWith({ execution: { orderId: "bo-x", state: "accepted", filledQuantity: 100, averagePrice: 100 } })).toBe(0);
  });

  it("price-only pending is excluded (writer would fall back to proposal quantity)", () => {
    expect(flowWith({ execution: { orderId: "bo-x", state: "accepted", averagePrice: 100 } })).toBe(-10_000);
  });

  it("quantity-only pending is excluded (awaitingBrokerPrice books notional 0)", () => {
    expect(flowWith({ execution: { orderId: "bo-x", state: "accepted", filledQuantity: 100 } })).toBe(-10_000);
  });

  it("provisional pending (resting order, no execution payload) stays excluded", () => {
    expect(flowWith(undefined)).toBe(-10_000);
    expect(flowWith({ syntheticStop: true, triggerPrice: 100 })).toBe(-10_000);
  });

  it("non-finite or non-positive marker fields are not truth", () => {
    for (const raw of [
      { execution: { filledQuantity: 100, averagePrice: 0 } },
      { execution: { filledQuantity: 100, averagePrice: -1 } },
      { execution: { filledQuantity: 100, averagePrice: Number.NaN } },
      { execution: { filledQuantity: 0, averagePrice: 100 } },
      { execution: { filledQuantity: "100", averagePrice: 100 } },
      { execution: null },
      { execution: "filled" }
    ]) {
      expect(flowWith(raw)).toBe(-10_000);
    }
  });
});

describe("unsorted curve input (Kody UOv) and relevance pre-filter equivalence (Kody USc)", () => {
  const baseline = {
    timestamp: "2026-11-17T21:00:00.000Z",
    equity: 100_000,
    cash: 50_000,
    positionsValue: 50_000,
    source: "live" as const,
    runId: "run-base"
  };
  const NOW = new Date("2026-11-18T20:00:00.000Z");
  const portfolio = { totalMarketValue: 88_000, cash: 40_000 };
  const bigBuy = fill({ filledAt: "2026-11-18T15:35:00.000Z", side: "buy", symbol: "VZ", notional: 10_000, runId: "run-today" });

  it("same-date points supplied out of chronological order: the later point is retained", () => {
    // The 11/18 pair in REVERSE order. Chronological-last is the 20:00 point (88k/40k): the 10k
    // buy fully explains the cash drop, so the 11/17 -> 11/18 gap reports flow 0. Last-inserted
    // retention would keep 15:00 (99k/49k): tradeCash -10k vs delta-cash -1k -> a phantom +9k
    // flow (clears both guard floors: 5x|deltaEquity| = 5k and 2% of start equity = 2k).
    const curve = [
      { timestamp: "2026-11-17T21:00:00.000Z", equity: 100_000, cash: 50_000, positionsValue: 50_000, source: "live" as const },
      { timestamp: "2026-11-18T20:00:00.000Z", equity: 88_000, cash: 40_000, positionsValue: 48_000, source: "live" as const },
      { timestamp: "2026-11-18T15:00:00.000Z", equity: 99_000, cash: 49_000, positionsValue: 50_000, source: "live" as const }
    ];
    const flows = inferExternalCashFlows(curve, [bigBuy]);
    expect(flows.get("2026-11-18") ?? 0).toBe(0);
    expect(flows.get("2026-11-18")).not.toBe(9_000);
  });

  it("ancient other-run fills do not change the result (pre-filter equivalence)", () => {
    const ancient = Array.from({ length: 200 }, (_, i) =>
      fill({ filledAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T15:00:00.000Z`, side: i % 2 ? "buy" : "sell", symbol: "MO", notional: 10_000 + i, runId: `run-old-${i}` })
    );
    const withAncient = inferTodayExternalFlow({ baseline, fills: [...ancient, bigBuy], currentEquity: portfolio.totalMarketValue, currentCash: portfolio.cash, now: NOW });
    const without = inferTodayExternalFlow({ baseline, fills: [bigBuy], currentEquity: portfolio.totalMarketValue, currentCash: portfolio.cash, now: NOW });
    expect(withAncient).toBe(without);
    expect(withAncient).toBe(0);
  });

  it("baseline-run's own older fill still lands in the reported gap through the pre-filter", () => {
    // Same-run deferral: this fill predates the baseline but its run recorded the baseline, so
    // it defers INTO today's gap. The pre-filter must keep it (runId === baseline.runId).
    const ownRunBuy = fill({ filledAt: "2026-11-17T20:59:00.000Z", side: "buy", symbol: "VZ", notional: 10_000, runId: "run-base" });
    const flow = inferTodayExternalFlow({ baseline, fills: [ownRunBuy, bigBuy], currentEquity: portfolio.totalMarketValue, currentCash: portfolio.cash, now: NOW });
    // tradeCash = -20k vs Δcash -10k -> +10k flow... guarded? |Δequity|=12k, 5x=60k; 2%=2k;
    // |flow|=10k < 60k -> stands. Pinned: deferral survives the pre-filter.
    expect(flow).toBe(10_000);
  });
});
