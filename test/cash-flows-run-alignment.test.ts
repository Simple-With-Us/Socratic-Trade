import { describe, expect, it } from "vitest";
import { hasAmbiguousSnapshotFillTiming, inferExternalCashFlows } from "../src/lib/cash-flows";
import type { EquityCurvePoint, FillEvent } from "../src/lib/types";

/**
 * Snapshot/fill run-identity alignment (piece 2, after the rejected 60s shift).
 *
 * Mechanism (code-proven): runStrategyOnce fetches the portfolio ONCE at run start
 * (strategy.ts:719) and BOTH the pre-run (strategy.ts:925) and post-run (strategy.ts:5007)
 * snapshots record that same fetch. A snapshot's cash therefore excludes every fill its own
 * run executed, however fast the broker is. inferExternalCashFlows now assigns each fill to
 * the first covering snapshot from a DIFFERENT run, keeping tradeCash consistent with the
 * cash the snapshots actually captured. Real-window evidence (Tradier Sandbox, 2026-11):
 * +1,920.99 on 11/4 and -1,920.99 on 11/5 (VZ+BMY buys 1.1-3.9s before their run's post-run
 * snapshot), -1,820.07 on 10/28 (SAP sell 2.0s before + BMY settle-in from 10/27).
 */

let seq = 0;
function fill(input: {
  filledAt: string;
  side: FillEvent["side"];
  notional: number;
  runId?: string;
}): FillEvent {
  seq += 1;
  return {
    id: `f-${seq}`,
    accountNumber: "A1",
    source: "paper",
    executionMode: "broker/paper",
    symbol: "AAPL",
    side: input.side,
    quantity: 1,
    price: input.notional,
    notional: input.notional,
    status: "filled",
    brokerOrderId: `bo-${seq}`,
    filledAt: input.filledAt,
    runId: input.runId
  };
}

function snap(
  timestamp: string,
  equity: number,
  cash: number,
  positionsValue: number,
  runId?: string
): EquityCurvePoint {
  return { timestamp, equity, cash, positionsValue, source: "paper" as const, runId };
}

describe("run-identity alignment", () => {
  it("own-run post-run last-of-day: fills seconds before their run's snapshot produce no phantom pair", () => {
    // Real 2026-11-04/05 pattern: VZ+BMY buys 1.1-3.9s before their run's post-run snapshot.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:34:50Z", 100_000, 60_000, 40_000, "run-B"), // fetch predates the buys
      snap("2026-01-04T21:06:29Z", 100_000, 58_079.01, 41_920.99, "run-C") // settled here
    ];
    const fills = [
      fill({ filledAt: "2026-01-03T20:34:46.5Z", side: "buy", notional: 967.89, runId: "run-B" }),
      fill({ filledAt: "2026-01-03T20:34:49.3Z", side: "buy", notional: 953.1, runId: "run-B" })
    ];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("same-run fill AFTER its snapshot (resting/late fill) stays naturally next-gap: the real 10/27 pair mints nothing", () => {
    // Real 2026-10-27 pattern, host-verified runIds: fill 40727569 executed 1.6s BEFORE its
    // run's post-run snapshot, fill 40727565 executed 10.5s AFTER it, both run 7e01cefd.
    // The late fill's cash lands in the next day's snapshot just like the early one's;
    // both must be counted in that gap and nowhere else. The pre-rule result minted a
    // one-sided +3,772.00 deposit on 10/27 (early fill counted, its cash absent).
    const curve = [
      snap("2026-10-26T20:00:00Z", 100_000, 60_000, 40_000, "run-older"),
      snap("2026-10-27T20:01:48.574Z", 100_000, 60_000, 40_000, "run-7e01"), // run-start fetch
      snap("2026-10-28T19:23:38.506Z", 100_000, 58_728, 41_272, "run-ba14"), // both fills settled
      snap("2026-10-29T20:05:00Z", 100_000, 58_728, 41_272, "run-other")
    ];
    const fills = [
      fill({ filledAt: "2026-10-27T20:01:46.967Z", side: "buy", notional: 3_772, runId: "run-7e01" }),
      fill({ filledAt: "2026-10-27T20:01:59.045Z", side: "sell", notional: 2_500, runId: "run-7e01" })
    ];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("older-run fill in the same gap is counted against the gap-ending snapshot", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:00:00Z", 100_000, 62_127.42, 37_872.58, "run-B")
    ];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_127.42, runId: "run-X" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("approval between runs: a fill stamped with the proposing run's id is not deferred from a later run's snapshot", () => {
    // Proposal created in run-A, approved and executed a day later. This fixture ASSUMES
    // broker cash already reflects the fill by run-B's start-fetch, hence run-B's settled
    // cash below. This is a fixture assumption, not a proven broker visibility contract.
    // Excluding the approval act during a strategy run does not establish when broker cash
    // becomes visible. The proposing run's snapshots predate this fill by timestamp, so
    // this settled shape must leave the fill counted where it executed.
    // A resting/asynchronous fill or delayed cash visibility can instead leave a covering
    // snapshot with pre-fill cash. The proposing-run stamp does not solve that timing
    // class: the pinned cross-run limit below remains. For the review's pre-settlement
    // run-B / settled run-C shape, inference produces a one-sided phantom withdrawal;
    // the cash-moved/equity-flat guard removes the later settlement-gap mirror.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:00:00Z", 100_000, 62_127.42, 37_872.58, "run-B"),
      snap("2026-01-04T20:00:00Z", 100_000, 62_127.42, 37_872.58, "run-C")
    ];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 2_127.42, runId: "run-A" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("null runIds are unchanged: reconciliation-booked fills bucket by timestamp as before", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:00:00Z", 100_000, 62_127.42, 37_872.58, "run-B")
    ];
    const fills = [fill({ filledAt: "2026-01-03T19:59:58Z", side: "sell", notional: 2_127.42 })]; // no runId
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("crashed run with only a pre-run snapshot: the run's fills fall in the next gap by timestamp", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:00:00Z", 100_000, 60_000, 40_000, "run-B"), // pre-run only; run crashed
      snap("2026-01-04T20:00:00Z", 100_000, 58_000, 42_000, "run-C")
    ];
    const fills = [fill({ filledAt: "2026-01-03T20:05:00Z", side: "buy", notional: 2_000, runId: "run-B" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("two same-run snapshots in one day collapse to the post-run point and still defer", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:30:00Z", 100_000, 60_000, 40_000, "run-B"), // pre-run
      snap("2026-01-03T20:34:50Z", 100_000, 60_000, 40_000, "run-B"), // post-run (kept)
      snap("2026-01-04T20:00:00Z", 100_000, 63_000, 37_000, "run-C")
    ];
    const fills = [fill({ filledAt: "2026-01-03T20:34:40Z", side: "sell", notional: 3_000, runId: "run-B" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("final-snapshot deferral: a same-run fill before the last snapshot is counted nowhere and mints nothing", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:34:50Z", 100_000, 60_000, 40_000, "run-B")
    ];
    const fills = [fill({ filledAt: "2026-01-03T20:34:46.5Z", side: "buy", notional: 967.89, runId: "run-B" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("UTC/Chicago midnight (pure function): a run straddling the Central day boundary keeps one point per Chicago day and defers correctly", () => {
    // PURE-FUNCTION scope only: this fixture exercises the Central-day collapse inside
    // inferExternalCashFlows. It is NOT a pipeline-integration claim: the production loader
    // (listDailyPortfolioSnapshots) selects MAX(created_at) per UTC day first, and the two
    // run-B snapshots below share one UTC day (2026-01-04), so the delivered curve would
    // contain only the 06:01Z point. The production-selected shape is covered separately
    // in the next test. Pre-run 23:55 CST Jan 3 (= 2026-01-04T05:55Z), post-run 00:01 CST
    // Jan 4 (= 06:01Z): different Chicago days, so both points survive the function's own
    // Central collapse — and both belong to run-B.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-04T05:55:00Z", 100_000, 60_000, 40_000, "run-B"), // Jan 3 Chicago
      snap("2026-01-04T06:01:00Z", 100_000, 60_000, 40_000, "run-B"), // Jan 4 Chicago
      snap("2026-01-05T20:00:00Z", 100_000, 63_000, 37_000, "run-C")
    ];
    const fills = [fill({ filledAt: "2026-01-04T06:00:30Z", side: "sell", notional: 3_000, runId: "run-B" })];
    const flows = inferExternalCashFlows(curve, fills);
    expect(flows.size).toBe(0); // counted exactly once, in the run-C gap where its cash settled
  });

  it("production UTC-day selection shape: only the post-run point is delivered — own-run fill defers, other-run ambiguity withholds adjustment", () => {
    // The loader (MAX(created_at) per UTC day, db-fills.ts) delivers only the 06:01Z
    // post-run point for the straddle above; the 05:55Z pre-run point never reaches
    // inference. Own-run: deferral still lands the fill in the run-C gap -> zero flows.
    const delivered = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-04T06:01:00Z", 100_000, 60_000, 40_000, "run-B"), // only survivor of the UTC-day selection
      snap("2026-01-05T20:00:00Z", 103_000, 63_000, 40_000, "run-C")
    ];
    const ownRun = [fill({ filledAt: "2026-01-04T06:00:30Z", side: "sell", notional: 3_000, runId: "run-B" })];
    expect(inferExternalCashFlows(delivered, ownRun).size).toBe(0);

    // Another-run execution cannot be assigned to reused cash by its write
    // timestamp alone. The uncertain adjustment is withheld, not deferred by a guess.
    const otherRun = [fill({ filledAt: "2026-01-04T06:00:30Z", side: "sell", notional: 3_000, runId: "run-X" })];
    const artifact = inferExternalCashFlows(delivered, otherRun);
    expect(hasAmbiguousSnapshotFillTiming(delivered, otherRun)).toBe(true);
    expect(artifact.size).toBe(0);
  });

  it("a different-run execution with unknown capture timing withholds adjustment", () => {
    // The execution may precede or follow the portfolio capture inside this
    // run. Without capture provenance, neither transfer nor trade-cash assignment
    // is established. The old phantom deposit must not be published.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:00:00Z", 100_000, 60_000, 40_000, "run-B") // run-B fetched before the fill
    ];
    const fills = [fill({ filledAt: "2026-01-03T19:30:00Z", side: "buy", notional: 2_000, runId: "run-X" })];
    const flows = inferExternalCashFlows(curve, fills);
    expect(hasAmbiguousSnapshotFillTiming(curve, fills)).toBe(true);
    expect(flows.size).toBe(0);
  });

  it("baseline parity: with no runIds anywhere the flows are exactly the pre-rule result", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000),
      snap("2026-01-03T20:00:00Z", 95_000, 56_000, 39_000) // -5,000 withdrawal, +1,000 settled sell
    ];
    const fills = [fill({ filledAt: "2026-01-03T15:00:00Z", side: "sell", notional: 1_000 })];
    const flows = inferExternalCashFlows(curve, fills);
    expect(flows.size).toBe(1);
    expect(flows.get("2026-01-03")).toBeCloseTo(-5_000, 6);
  });

  it("a genuine withdrawal is recovered exactly when same-run fills share the gap", () => {
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:34:50Z", 95_000, 55_000, 40_000, "run-B"), // real -5,000; buys unsettled
      snap("2026-01-04T21:06:29Z", 95_000, 53_079.01, 41_920.99, "run-C")
    ];
    const fills = [
      fill({ filledAt: "2026-01-03T20:34:46.5Z", side: "buy", notional: 967.89, runId: "run-B" }),
      fill({ filledAt: "2026-01-03T20:34:49.3Z", side: "buy", notional: 953.1, runId: "run-B" })
    ];
    // The next run is explicitly known to start after these fills. Its cash
    // capture is not guessed from its later write timestamp.
    const bounded = curve.map((p) => ({ ...p, runStartedAt: new Date(Date.parse(p.timestamp) - 60_000).toISOString() }));
    const flows = inferExternalCashFlows(bounded, fills);
    expect(flows.size).toBe(1);
    expect(flows.get("2026-01-03")).toBeCloseTo(-5_000, 6);
  });

  it("notional guards see the deferred fills in the gap that receives them (no invented flow on equity-only points)", () => {
    // s3 has no cash/positions metadata: the missing-cash guard must still see the deferred
    // 3,000 buy's notional and refuse to invent a transfer from the equity move.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      // Cash present but no positionsValue -> prevFlat in the missing-cash guard branch.
      { timestamp: "2026-01-03T20:34:50Z", equity: 100_000, cash: 60_000, source: "paper" as const, runId: "run-B" },
      { timestamp: "2026-01-04T20:00:00Z", equity: 101_000, source: "paper" as const, runId: "run-C" },
      snap("2026-01-05T20:00:00Z", 101_000, 58_000, 43_000, "run-D")
    ];
    const fills = [fill({ filledAt: "2026-01-03T20:34:46.5Z", side: "buy", notional: 3_000, runId: "run-B" })];
    expect(inferExternalCashFlows(curve, fills).size).toBe(0);
  });

  it("a null-runId execution before an unsettled snapshot is withheld", () => {
    // Resting broker orders can execute inside another run without its id.
    // Unknown capture timing must not be published as an external withdrawal.
    const curve = [
      snap("2026-01-02T20:00:00Z", 100_000, 60_000, 40_000, "run-A"),
      snap("2026-01-03T20:34:50Z", 100_000, 60_000, 40_000, "run-B"),
      snap("2026-01-04T21:06:29Z", 100_000, 62_127.42, 37_872.58, "run-C")
    ];
    const fills = [fill({ filledAt: "2026-01-03T20:34:48Z", side: "sell", notional: 2_127.42 })]; // no runId
    const flows = inferExternalCashFlows(curve, fills);
    expect(hasAmbiguousSnapshotFillTiming(curve, fills)).toBe(true);
    expect(flows.size).toBe(0);
  });
});


describe("cash capture uncertainty is not a transfer", () => {
  const point = { timestamp: "2026-01-03T20:00:00Z", equity: 100000, cash: 60000,
    positionsValue: 40000, source: "live" as const, runId: "capture-run", runStartedAt: "2026-01-03T19:00:00Z" };
  it("bounds uncertainty with verified run start without claiming exact cash time", () => {
    for (const runId of ["other-run", undefined]) {
      expect(hasAmbiguousSnapshotFillTiming([point], [fill({ filledAt: "2026-01-03T19:30:00Z", side: "buy", notional: 2000, runId })])).toBe(true);
      expect(hasAmbiguousSnapshotFillTiming([point], [fill({ filledAt: "2026-01-03T18:00:00Z", side: "buy", notional: 2000, runId })])).toBe(false);
    }
  });
  it("missing, invalid or backwards run bounds stay unknown", () => {
    const f = fill({ filledAt: "2026-01-03T18:00:00Z", side: "buy", notional: 2000 });
    for (const runStartedAt of [undefined, "invalid", "2026-01-03 19:00:00", "2026-01-04T00:00:00Z"])
      expect(hasAmbiguousSnapshotFillTiming([{ ...point, runStartedAt }], [f])).toBe(true);
  });
});


it("ambiguity only withholds adjacent gaps, preserving a later genuine withdrawal", () => {
  const curve = [
    { ...snap("2026-01-01T20:00:00Z", 100000, 60000, 40000, "r1"), runStartedAt: "2026-01-01T19:00:00Z" },
    { ...snap("2026-01-02T20:00:00Z", 100000, 60000, 40000, "r2"), runStartedAt: "2026-01-02T19:00:00Z" },
    { ...snap("2026-01-03T20:00:00Z", 100000, 58000, 42000, "r3"), runStartedAt: "2026-01-03T19:00:00Z" },
    { ...snap("2026-01-04T20:00:00Z", 95000, 53000, 42000, "r4"), runStartedAt: "2026-01-04T19:00:00Z" }
  ];
  const fills = [fill({ filledAt: "2026-01-02T19:30:00Z", side: "buy", notional: 2000 })];
  const flows = inferExternalCashFlows(curve, fills);
  expect(flows.size).toBe(1);
  expect(flows.get("2026-01-04")).toBe(-5000);
});


it("explicit timezone offsets locate the same uncertainty window", () => {
  const at = { ...snap("2026-01-03T20:00:00Z", 100000, 60000, 40000, "r"), runStartedAt: "2026-01-03T13:00:00-06:00" };
  const f = fill({ filledAt: "2026-01-03T19:30:00Z", side: "buy", notional: 2000 });
  expect(hasAmbiguousSnapshotFillTiming([at], [f])).toBe(true);
  expect(hasAmbiguousSnapshotFillTiming([{ ...at, runStartedAt: "2026-01-03T19:00:00Z" }], [f])).toBe(true);
});
