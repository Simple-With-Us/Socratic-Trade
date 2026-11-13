import { describe, expect, it } from "vitest";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";
import { inferExternalCashFlows, FLOW_MATERIALITY_MIN_USD } from "../src/lib/cash-flows";
import type { EquityCurvePoint, FillEvent } from "../src/lib/types";

function curve(points: Array<[string, number]>): EquityCurvePoint[] {
  return points.map(([timestamp, equity]) => ({ timestamp, equity, source: "paper" as const }));
}

function cashCurve(points: Array<[string, number, number]>): EquityCurvePoint[] {
  return points.map(([timestamp, equity, cash]) => ({ timestamp, equity, cash, source: "live" as const }));
}

function fill(input: { filledAt: string; side: FillEvent["side"]; notional: number }): FillEvent {
  return {
    id: `f-${input.filledAt}-${input.side}`,
    accountNumber: "A1",
    source: "live",
    symbol: "AAPL",
    side: input.side,
    quantity: 1,
    price: input.notional,
    notional: input.notional,
    status: "filled",
    filledAt: input.filledAt
  };
}

describe("normalizeAgainstBenchmark", () => {
  it("bases both series to 100 and computes returns + excess", () => {
    const equity = curve([
      ["2026-01-02T16:00:00.000Z", 100_000],
      ["2026-01-03T16:00:00.000Z", 110_000] // +10%
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-03", close: 525 } // +5%
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r).not.toBeNull();
    expect(r.equityIndex[0].index).toBe(100);
    expect(r.benchmarkIndex[0].index).toBe(100);
    expect(r.accountReturnPct).toBeCloseTo(10, 5);
    expect(r.benchmarkReturnPct).toBeCloseTo(5, 5);
    expect(r.excessReturnPct).toBeCloseTo(5, 5);
    expect(r.benchmarkSymbol).toBe("SPY");
    expect(r.startDate).toBe("2026-01-02");
    expect(r.endDate).toBe("2026-01-03");
  });

  it("reports underperformance as negative excess", () => {
    const equity = curve([
      ["2026-02-02T16:00:00Z", 100_000],
      ["2026-02-09T16:00:00Z", 98_000] // -2%
    ]);
    const spy = [
      { date: "2026-02-02", close: 500 },
      { date: "2026-02-09", close: 515 } // +3%
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.accountReturnPct).toBeCloseTo(-2, 5);
    expect(r.benchmarkReturnPct).toBeCloseTo(3, 5);
    expect(r.excessReturnPct).toBeCloseTo(-5, 5);
  });

  it("carries the benchmark close forward for non-trading-day snapshots", () => {
    // Snapshot on a Sunday (2026-01-04) with no SPY bar that day → uses Friday's (01-02) close.
    const equity = curve([
      ["2026-01-02T16:00:00Z", 100_000],
      ["2026-01-04T16:00:00Z", 105_000]
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-05", close: 510 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    // 01-04 carries forward 01-02 close (500) → benchmark index stays 100 on that date.
    const p = r.benchmarkIndex.find((x) => x.date === "2026-01-04");
    expect(p?.index).toBe(100);
  });

  it("collapses multiple same-day snapshots to the last equity of the day", () => {
    const equity = curve([
      ["2026-03-02T14:00:00Z", 100_000],
      ["2026-03-02T20:00:00Z", 101_000], // later same day wins
      ["2026-03-03T16:00:00Z", 103_000]
    ]);
    const spy = [
      { date: "2026-03-02", close: 400 },
      { date: "2026-03-03", close: 404 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    // base equity = 101_000 (last on 03-02); 03-03 = 103_000 → +1.98%
    expect(r.accountReturnPct).toBeCloseTo(1.98, 1);
    expect(r.points).toBe(2);
  });

  it("returns null on insufficient data", () => {
    expect(normalizeAgainstBenchmark(curve([["2026-01-02T16:00:00Z", 100_000]]), [{ date: "2026-01-02", close: 1 }, { date: "2026-01-03", close: 2 }])).toBeNull();
    expect(normalizeAgainstBenchmark(curve([["2026-01-02T16:00:00Z", 100_000], ["2026-01-03T16:00:00Z", 1]]), [])).toBeNull();
  });

  it("ignores non-positive equity points", () => {
    const equity = curve([
      ["2026-04-01T16:00:00Z", 0], // dropped
      ["2026-04-02T16:00:00Z", 100_000],
      ["2026-04-03T16:00:00Z", 102_000]
    ]);
    const spy = [
      { date: "2026-04-02", close: 500 },
      { date: "2026-04-03", close: 505 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.startDate).toBe("2026-04-02");
    expect(r.points).toBe(2);
  });

  it("marks the unadjusted result cashFlowAdjusted:false (default behavior unchanged)", () => {
    const equity = curve([
      ["2026-01-02T16:00:00Z", 100_000],
      ["2026-01-03T16:00:00Z", 110_000]
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-03", close: 525 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.accountReturnPct).toBeCloseTo(10, 5);
    expect(r.cashFlowAdjusted).toBe(false);
    expect(r.netExternalFlows).toBeUndefined();
  });

  it("neutralizes a withdrawal via time-weighted chaining (the owner's -80% bug)", () => {
    // $100k account; owner withdraws $80k with no trading. Raw growth reads -80%;
    // TWR with the inferred -$80k flow reads ~0%.
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 20_000, 20_000]
    ]);
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-05-02")).toBeCloseTo(-80_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.netExternalFlows).toBeCloseTo(-80_000, 2);
    expect(r.accountReturnPct).toBeCloseTo(0, 2);
    // Without the flows map the old distorted figure comes back — pinned so the fix is visible.
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeCloseTo(-80, 2);
  });

  it("does not misread trade-driven cash changes as transfers", () => {
    // Cash fell $50k because the account BOUGHT $50k of stock — equity unchanged, no flow.
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 100_000, 50_000]
    ]);
    const flows = inferExternalCashFlows(equity, [fill({ filledAt: "2026-05-02T15:00:00Z", side: "buy", notional: 50_000 })]);
    expect(flows.size).toBe(0);
  });

  it("keeps genuine performance visible alongside a deposit", () => {
    // $100k grows 10% AND a $100k deposit lands: equity 100k → 210k, cash +100k external.
    const equity = cashCurve([
      ["2026-06-01T16:00:00Z", 100_000, 100_000],
      ["2026-06-02T16:00:00Z", 210_000, 200_000]
    ]);
    const spy = [
      { date: "2026-06-01", close: 500 },
      { date: "2026-06-02", close: 500 }
    ];
    // $10k of the equity rise is a market gain; cash went 100k → 200k with no trades = +100k flow.
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-06-02")).toBeCloseTo(100_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    // TWR sub-period: 210 / (100 + 100 deposit) − 1 = +5% (deposit not counted as gain).
    expect(r.accountReturnPct).toBeCloseTo(5, 2);
    expect(r.netExternalFlows).toBeCloseTo(100_000, 2);
  });

  it("neutralizes a withdrawal while positions stay open", () => {
    // Started $100k (50k cash + 50k stock). Withdraw $20k cash. Stock flat. Equity 100k → 80k.
    // Must read ~0% account return, not −20%.
    const equity = [
      { timestamp: "2026-05-01T16:00:00Z", equity: 100_000, cash: 50_000, positionsValue: 50_000, source: "paper" as const },
      { timestamp: "2026-05-02T16:00:00Z", equity: 80_000, cash: 30_000, positionsValue: 50_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-05-02")).toBeCloseTo(-20_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.netExternalFlows).toBeCloseTo(-20_000, 2);
    // (80k − 100k − (−20k)) / 100k = 0%
    expect(r.accountReturnPct).toBeCloseTo(0, 2);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeCloseTo(-20, 2);
  });

  it("nets deposit then withdrawal to the true market P&L", () => {
    // 100k all cash → +50k deposit → 150k → −30k withdrawal → 120k → positions mark +5k → 125k.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "paper" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 150_000, cash: 150_000, positionsValue: 0, source: "paper" as const },
      { timestamp: "2026-03-02T16:00:00Z", equity: 120_000, cash: 120_000, positionsValue: 0, source: "paper" as const },
      // Deploy cash into stock (fill), then mark up:
      { timestamp: "2026-03-03T16:00:00Z", equity: 120_000, cash: 20_000, positionsValue: 100_000, source: "paper" as const },
      { timestamp: "2026-04-02T16:00:00Z", equity: 125_000, cash: 20_000, positionsValue: 105_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 },
      { date: "2026-03-02", close: 500 },
      { date: "2026-03-03", close: 500 },
      { date: "2026-04-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, [
      fill({ filledAt: "2026-03-03T15:00:00Z", side: "buy", notional: 100_000 })
    ]);
    expect(flows.get("2026-02-02")).toBeCloseTo(50_000, 2);
    expect(flows.get("2026-03-02")).toBeCloseTo(-30_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.netExternalFlows).toBeCloseTo(20_000, 2); // +50 − 30
    // TWR chains sub-periods at each transfer; final mark 120→125 is ~+4.17%.
    expect(r.accountReturnPct).toBeCloseTo(4.17, 1);
    // Sub-periods split at each deposit/withdrawal (coalesced between flows).
    expect(r.subPeriods && r.subPeriods.length).toBeGreaterThanOrEqual(2);
  });

  it("chains unequal capital regimes: $100 then $10 (owner multi-period TWR request)", () => {
    // 10 days with ~$100 cash (flat), withdraw to $10 invested, then that $10 gains 50%.
    // TWR chains both regimes so the long small-capital stretch still contributes its +50%.
    const equity = [
      { timestamp: "2026-01-01T16:00:00Z", equity: 100, cash: 100, positionsValue: 0, source: "paper" as const },
      { timestamp: "2026-01-11T16:00:00Z", equity: 100, cash: 100, positionsValue: 0, source: "paper" as const },
      // Withdraw $90 and stay fully invested at $10
      { timestamp: "2026-01-12T16:00:00Z", equity: 10, cash: 0, positionsValue: 10, source: "paper" as const },
      { timestamp: "2026-04-22T16:00:00Z", equity: 15, cash: 0, positionsValue: 15, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-11", close: 100 }, // flat while large capital
      { date: "2026-01-12", close: 100 },
      { date: "2026-04-22", close: 130 } // +30% SPY while small capital
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-01-12")).toBeCloseTo(-90, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    // Account: 100→100 (0%), then after withdrawal 15/10 = +50%. Chain: 1.0 * 1.5 − 1 = +50%.
    expect(r.accountReturnPct).toBeCloseTo(50, 1);
    // SPY chained over same knots: 100→100 (0%), 100→130 (+30%) → +30%.
    expect(r.benchmarkReturnPct).toBeCloseTo(30, 1);
    expect(r.excessReturnPct).toBeCloseTo(20, 1);
    expect(r.subPeriods?.some((s) => Math.abs(s.externalFlow + 90) < 1)).toBe(true);
  });

  it("ignores sub-threshold cash drift (dividends/fees are not transfers)", () => {
    const equity = cashCurve([
      ["2026-07-01T16:00:00Z", 100_000, 10_000],
      ["2026-07-02T16:00:00Z", 100_020, 10_020] // +$20 < max(0.5% of 100k, $0.50)
    ]);
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("treats no-cash flat books as transfers when equity jumps without trades", () => {
    // Missing cash fields but no positions metadata and no fills → equity delta is a transfer
    // (paper reset / deposit). Previously these returned no flows and raw TWR misread them as alpha.
    const flows = inferExternalCashFlows(
      curve([
        ["2026-08-01T16:00:00Z", 100_000],
        ["2026-08-02T16:00:00Z", 50_000]
      ]),
      []
    );
    expect(flows.get("2026-08-02")).toBeCloseTo(-50_000, 2);
  });

  it("all-cash prefers cash≈equity even when positionsValue is wrongly equal to equity", () => {
    // Regression: isAllCash used to check positionsValue FIRST, so a buggy positionsValue=equity
    // (while cash is full equity) blocked the all-cash deposit path and inflated account return.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 66_000, cash: 66_000, positionsValue: 66_000, source: "paper" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 100_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-02-02")).toBeCloseTo(34_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(50);
  });

  it("all-cash paper resets/deposits are neutralized (owner +31% vs SPY bug)", () => {
    // All-cash account: equity drifts 76k → 99.9k from deposits/resets with no trading.
    // Raw growth reads ~+31%; TWR with all-cash flow inference reads ~0%, so vs SPY ≈ −SPY.
    const equity = cashCurve([
      ["2026-01-02T16:00:00Z", 76_000, 76_000],
      ["2026-02-02T16:00:00Z", 80_000, 80_000],
      ["2026-03-02T16:00:00Z", 90_000, 90_000],
      ["2026-04-02T16:00:00Z", 99_900, 99_900]
    ]).map((p) => ({ ...p, positionsValue: 0 }));
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 510 },
      { date: "2026-03-02", close: 520 },
      { date: "2026-04-02", close: 530 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBeGreaterThan(0);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
    expect(r.benchmarkReturnPct).toBeCloseTo(6, 1);
    // vs SPY = account − SPY ≈ −6% (holding cash underperformed a rising market)
    expect(r.excessReturnPct).toBeCloseTo(-6, 1);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(30);
  });

  it("does not treat a cash→positions conversion without fills as a withdrawal", () => {
    // Bought $210 of stock (cash 210→0, positions 0→180 after a mark-to-market loss).
    // Missing fill must NOT invent a −$210 withdrawal.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 210, cash: 210, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 180, cash: 0, positionsValue: 180, source: "live" as const }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("keeps real mark-to-market losses visible after a buy (owner −77.7% path)", () => {
    // After buying, equity falls 210 → 46.84 from trading — that IS underperformance vs flat SPY.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 210, cash: 210, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 180, cash: 0, positionsValue: 180, source: "live" as const },
      { timestamp: "2026-03-02T16:00:00Z", equity: 100, cash: 0, positionsValue: 100, source: "live" as const },
      { timestamp: "2026-04-02T16:00:00Z", equity: 46.84, cash: 0, positionsValue: 46.84, source: "live" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 },
      { date: "2026-03-02", close: 500 },
      { date: "2026-04-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows.size > 0 ? flows : undefined)!;
    expect(r.accountReturnPct).toBeCloseTo(-77.7, 1);
    expect(r.benchmarkReturnPct).toBeCloseTo(0, 1);
    expect(r.excessReturnPct).toBeCloseTo(-77.7, 1);
  });

  it("rebases instead of distorting when a flow wipes prior equity (denom <= 0)", () => {
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 5_000, 5_000] // withdrew essentially everything
    ]);
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = new Map([["2026-05-02", -100_000]]);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    // Rebase with 0% for the wiped period — leftover $5k is new principal, not a −95% loss.
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
  });

  it("ST-4589: account TWR and the same-cash shadow agree on a flow day (start-of-day convention)", () => {
    // $100k in SPY; a $50k deposit lands and is invested the same day; SPY +2%.
    // End = 150k * 1.02 = 153k. Account: 153k / (100k + 50k) = +2%. Shadow: (100k + 50k) * 1.02.
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 0],
      ["2026-05-02T16:00:00Z", 153_000, 0]
    ]);
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 510 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", new Map([["2026-05-02", 50_000]]))!;
    expect(r.accountReturnPct).toBeCloseTo(2, 2);
    expect(r.benchmarkReturnPct).toBeCloseTo(2, 2);
    expect(r.excessReturnPct).toBeCloseTo(0, 2);
    expect(r.shadowValue).toBeCloseTo(153_000, 2);
    expect(r.dollarExcess).toBeCloseTo(0, 2);
  });

  it("ST-4589 regression: a deposit onto a tiny starting balance is not graded against the tiny base", () => {
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 505 } // +1%
    ];
    // $1,000 + $10,000 deposit, all invested, market +1% -> $11,110: a +1% day, not +11%.
    const small = normalizeAgainstBenchmark(
      cashCurve([["2026-05-01T16:00:00Z", 1_000, 0], ["2026-05-02T16:00:00Z", 11_110, 0]]),
      spy, "SPY", new Map([["2026-05-02", 10_000]])
    )!;
    expect(small.accountReturnPct).toBeCloseTo(1, 2);
    // $1 + $10,000 deposit -> $10,200: about +2% (10,200 / 10,001), never +19,900%.
    const tiny = normalizeAgainstBenchmark(
      cashCurve([["2026-05-01T16:00:00Z", 1, 0], ["2026-05-02T16:00:00Z", 10_200, 0]]),
      spy, "SPY", new Map([["2026-05-02", 10_000]])
    )!;
    expect(tiny.accountReturnPct).toBeGreaterThan(1.9);
    expect(tiny.accountReturnPct).toBeLessThan(2.1);
  });

  it("ST-4589 regression: end equity equal to the deposit does not pin the index at 0", () => {
    // $1,000 + $10,000 deposit ends the day at exactly $10,000, then gains 1% the next day.
    const r = normalizeAgainstBenchmark(
      cashCurve([
        ["2026-05-01T16:00:00Z", 1_000, 0],
        ["2026-05-02T16:00:00Z", 10_000, 0],
        ["2026-05-03T16:00:00Z", 10_100, 0]
      ]),
      [
        { date: "2026-05-01", close: 500 },
        { date: "2026-05-02", close: 500 },
        { date: "2026-05-03", close: 500 }
      ],
      "SPY",
      new Map([["2026-05-02", 10_000]])
    )!;
    // Day 1: 10,000 / 11,000 = -9.09%; day 2: +1%. Index ~91.82, not 0.
    expect(r.equityIndex[1].index).toBeCloseTo(90.91, 1);
    expect(r.equityIndex[2].index).toBeCloseTo(91.82, 1);
  });

  it("ST-4589: a withdrawal larger than the shadow floors it at 0 (never negative or NaN)", () => {
    const r = normalizeAgainstBenchmark(
      cashCurve([["2026-05-01T16:00:00Z", 10_000, 10_000], ["2026-05-02T16:00:00Z", 1_000, 1_000]]),
      [
        { date: "2026-05-01", close: 500 },
        { date: "2026-05-02", close: 450 }
      ],
      "SPY",
      new Map([["2026-05-02", -12_000]])
    )!;
    expect(Number.isFinite(r.shadowValue)).toBe(true);
    expect(r.shadowValue).toBe(0);
  });

  it("builds a same-cash S&P dollar shadow (deposit is a breakpoint, not a gain)", () => {
    // $100k, SPY +10%, then a $50k deposit with a flat tape. Shadow should earn the 10% on
    // the original $100k, then add $50k at the cutoff — $160k. Account that sat in cash is $150k.
    const equity = cashCurve([
      ["2026-01-02T16:00:00Z", 100_000, 100_000],
      ["2026-01-03T16:00:00Z", 100_000, 100_000],
      ["2026-01-04T16:00:00Z", 150_000, 150_000]
    ]).map((p) => ({ ...p, positionsValue: 0 }));
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-03", close: 550 },
      { date: "2026-01-04", close: 550 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-01-04")).toBeCloseTo(50_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.shadowBenchmarkSeries).toHaveLength(3);
    expect(r.shadowBenchmarkSeries[0].value).toBeCloseTo(100_000, 2);
    expect(r.shadowBenchmarkSeries[1].value).toBeCloseTo(110_000, 2);
    expect(r.shadowBenchmarkSeries[2].value).toBeCloseTo(160_000, 2);
    expect(r.shadowValue).toBeCloseTo(160_000, 2);
    expect(r.accountEquitySeries[2].value).toBeCloseTo(150_000, 2);
    expect(r.dollarExcess).toBeCloseTo(-10_000, 2);
  });

  it("same-cash shadow sells S&P on a withdrawal then compounds the remainder", () => {
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 60_000, 60_000],
      ["2026-05-03T16:00:00Z", 60_000, 60_000]
    ]).map((p) => ({ ...p, positionsValue: 0 }));
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 },
      { date: "2026-05-03", close: 550 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-05-02")).toBeCloseTo(-40_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.shadowValue).toBeCloseTo(66_000, 2);
    expect(r.dollarExcess).toBeCloseTo(-6_000, 2);
  });
});

describe("computeSpyBenchmark synthetic curve guard", () => {
  it("refuses a synthetic $100-base fill curve even when tipped with a live $100k snapshot", async () => {
    // Repro: paperAverage/syntheticPaperCurve builds equity=100+realized; dashboard tips with
    // live totalMarketValue ~$100k. Old hasRealSnapshot=some(cash) treated the tip as enough
    // and TWR read ~+tens of thousands % as "Your account".
    const { computeSpyBenchmark } = await import("../src/lib/benchmark");
    const synthetic: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100, source: "paper" },
      { timestamp: "2026-07-15T16:00:00Z", equity: 150, source: "paper" },
      {
        timestamp: "2026-08-05T16:00:00Z",
        equity: 100_000,
        cash: 95_000,
        positionsValue: 5_000,
        source: "paper"
      }
    ];
    // fetchDailyOHLC may be called if guard fails — mock by only testing the filter: with a
    // single real point the function returns null before network.
    const result = await computeSpyBenchmark(synthetic, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    expect(result).toBeNull();
  });

  it("accepts two real snapshots (with cash) and computes a sane small return", async () => {
    const { computeSpyBenchmark } = await import("../src/lib/benchmark");
    const real: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "paper" },
      { timestamp: "2026-08-05T16:00:00Z", equity: 99_000, cash: 90_000, positionsValue: 9_000, source: "paper" }
    ];
    // May return null if SPY history fetch fails in offline CI — either null or a small negative
    // account return is acceptable; never a huge positive.
    const result = await computeSpyBenchmark(real, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    if (result) {
      expect(result.accountReturnPct).toBeLessThan(5);
      expect(result.accountReturnPct).toBeGreaterThan(-20);
    }
  });
});

describe("inferred-flow sanity bound (#2557 — phantom $36.5k withdrawal)", () => {
  it("flags a flow that dwarfs its sub-period's equity move as unverified", async () => {
    const { isInferredFlowUnverified } = await import("../src/lib/cash-flows");
    // Live repro: "withdrawal $36,501.38" on a sub-period whose equity moved only −$837.
    expect(isInferredFlowUnverified(-36_501.38, 100_541, 99_704)).toBe(true);
  });

  it("keeps real flows verified: flow ≈ equity delta, and small flows under the 2% floor", async () => {
    const { isInferredFlowUnverified } = await import("../src/lib/cash-flows");
    // Genuine $80k withdrawal moves equity by ~$80k.
    expect(isInferredFlowUnverified(-80_000, 100_000, 20_000)).toBe(false);
    // Genuine $500 deposit on a $100k book on a day the market dipped $400 (delta +$100):
    // 5×|Δ| = $500 would be borderline, but the 2%-of-equity floor ($2k) keeps it verified.
    expect(isInferredFlowUnverified(500, 100_000, 100_100)).toBe(false);
    // Deposit slightly above its equity delta (same-day market dip) is still verified.
    expect(isInferredFlowUnverified(10_000, 100_000, 108_000)).toBe(false);
    // Zero / non-flow inputs never flag.
    expect(isInferredFlowUnverified(0, 100_000, 50_000)).toBe(false);
  });

  it("excludes an unverified flow from TWR but keeps it visible on the sub-period row", () => {
    // Equity is basically flat (−0.83%) but the flow map claims a $36.5k withdrawal.
    // Old behavior: 99_704 / (100_541 − 36_501.38) ⇒ +55.7% fake TWR.
    const equity = cashCurve([
      ["2026-08-04T16:00:00Z", 100_541, 30_000],
      ["2026-08-05T16:00:00Z", 99_704, 29_500]
    ]);
    const spy = [
      { date: "2026-08-04", close: 500 },
      { date: "2026-08-05", close: 505 }
    ];
    const flows = new Map([["2026-08-05", -36_501.38]]);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    // Math ignores the phantom flow: raw equity growth, not +55%.
    expect(r.accountReturnPct).toBeCloseTo(-0.83, 1);
    expect(r.cashFlowAdjusted).toBe(false);
    expect(r.netExternalFlows).toBeUndefined();
    // The owner still sees the inferred transfer, flagged.
    expect(r.unverifiedFlows).toEqual([{ date: "2026-08-05", amount: -36_501.38 }]);
    const seg = r.subPeriods!.find((s) => s.endDate === "2026-08-05")!;
    expect(seg.flowUnverified).toBe(true);
    expect(seg.externalFlow).toBeCloseTo(-36_501.38, 2);
    expect(seg.accountReturnPct).toBeCloseTo(-0.83, 1);
  });

  it("still neutralizes a verified flow in the same window as an unverified one", () => {
    const equity = cashCurve([
      ["2026-08-01T16:00:00Z", 100_000, 100_000],
      ["2026-08-02T16:00:00Z", 150_000, 150_000], // real $50k deposit (delta ≈ flow)
      ["2026-08-03T16:00:00Z", 150_100, 150_100] // flat day; phantom flow injected below
    ]);
    const spy = [
      { date: "2026-08-01", close: 500 },
      { date: "2026-08-02", close: 500 },
      { date: "2026-08-03", close: 500 }
    ];
    const flows = new Map([
      ["2026-08-02", 50_000],
      ["2026-08-03", -40_000] // phantom: equity moved +$100
    ]);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.netExternalFlows).toBeCloseTo(50_000, 2); // phantom excluded from the net
    expect(r.unverifiedFlows).toHaveLength(1);
    expect(r.unverifiedFlows![0].date).toBe("2026-08-03");
    // TWR: deposit day 150/(100+50)=0%, flat day ≈ +0.07% — no phantom distortion.
    expect(r.accountReturnPct).toBeGreaterThan(-0.5);
    expect(r.accountReturnPct).toBeLessThan(0.5);
  });
});

describe("benchmark series staleness gate (#2557 — SPY 0.00% co-bug)", () => {
  it("declares a series stale when its last close predates the account window end", async () => {
    const { assessBenchmarkSeries } = await import("../src/lib/benchmark");
    const closes = [
      { date: "2026-07-20", close: 500 },
      { date: "2026-07-25", close: 505 }
    ];
    const verdict = assessBenchmarkSeries(closes, "2026-07-29", "2026-08-06", "SPY", "history-cache-eod");
    expect(verdict?.reason).toBe("stale-series");
    expect(verdict?.detail).toContain("2026-07-25");
    expect(verdict?.detail).toContain("history-cache-eod");
  });

  it("allows normal weekend/holiday lag inside the grace window", async () => {
    const { assessBenchmarkSeries } = await import("../src/lib/benchmark");
    const closes = [
      { date: "2026-08-01", close: 500 },
      { date: "2026-08-04", close: 505 }
    ];
    // Window ends 2 calendar days after the last close — ordinary T+1/weekend lag.
    expect(assessBenchmarkSeries(closes, "2026-07-29", "2026-08-06")).toBeNull();
  });

  it("reports no-bars when the series has fewer than two usable closes", async () => {
    const { assessBenchmarkSeries } = await import("../src/lib/benchmark");
    expect(assessBenchmarkSeries([], "2026-07-29", "2026-08-06")?.reason).toBe("no-bars");
    expect(assessBenchmarkSeries([{ date: "2026-08-01", close: 0 }], "2026-07-29", "2026-08-06")?.reason).toBe("no-bars");
  });

  it("accepts broker-reported daily equity history (no cash split) as a real curve", async () => {
    // Alpaca Paper parity: the broker's own EOD equity history has no cash/positions
    // split, but it is real account equity — it must not be refused as "synthetic"
    // the way the fabricated $100-base fill curve above is. With SPY unreachable the
    // honest outcome is a feed verdict, never insufficient-history.
    const { computeSpyBenchmarkDetailed } = await import("../src/lib/benchmark");
    const brokerHistory: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, source: "paper", brokerHistory: true },
      { timestamp: "2026-08-05T16:00:00Z", equity: 101_000, source: "paper", brokerHistory: true }
    ];
    const result = await computeSpyBenchmarkDetailed(brokerHistory, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    expect(result.unavailable?.reason).not.toBe("insufficient-history");
    if (result.comparison) {
      expect(result.comparison.accountReturnPct).toBeCloseTo(1, 1);
    }
  });

  it("computeSpyBenchmarkDetailed names insufficient-history for a synthetic curve (no fake 0.00%)", async () => {
    const { computeSpyBenchmarkDetailed } = await import("../src/lib/benchmark");
    const synthetic: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100, source: "paper" },
      { timestamp: "2026-07-15T16:00:00Z", equity: 150, source: "paper" }
    ];
    const result = await computeSpyBenchmarkDetailed(synthetic, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    expect(result.comparison).toBeNull();
    expect(result.unavailable?.reason).toBe("insufficient-history");
  });
});
