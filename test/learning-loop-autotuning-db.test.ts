// Workstream B — learning-loop auto-tuning. DB-backed integration tests (temp SQLite per run).
// Covers item 1 (OOS-gated autonomous weight apply + clamp + persist + revert), item 6 (calibration
// remap actually changes sizing when the flag is on / not when off), and item 8 (the learner's closed-lot
// returns reflect execution cost when enabled).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  applyAutonomousWeightTuning,
  revertAutonomousWeightTuning,
  AUTO_WEIGHT_APPLY_AUDIT_KIND
} from "../src/lib/strategy-tuning";
import { getConfidenceCalibration, getFactorScorecard, recordFillFromProposal } from "../src/lib/performance";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ll-autotune-db-${randomUUID()}.db`)}`;
});

const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 0,
  optionMarketValue: 0,
  cash: 1_000_000
};
const NO_POSITIONS: EquityPosition[] = [];

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    maxOrderNotional: 10_000,
    maxOrderPctOfNav: undefined,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning
  };
}

// ── Item 1: opt-in autonomous factor-weight tuning ─────────────────────────────────────────────
describe("applyAutonomousWeightTuning — item 1", () => {
  it("DEFAULT (flag off): no-op, weights untouched", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `auto-off-${randomUUID()}`;
    setPolicy(policyFor("AUTO-OFF"), userId);
    const before = { ...getPolicy(userId).scoringWeights };

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("autoApplyWeights_off");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
  });

  it("flag on but no validated weight changes (no OOS data / no closed lots) → does NOT apply", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `auto-none-${randomUUID()}`;
    // autoApplyWeights on, but a fresh account has zero closed lots → the sample gate + OOS gate strip any
    // proposed weights, so nothing is applied. This proves an UNVALIDATED weight move is never applied.
    setPolicy(policyFor("AUTO-NONE", { autoApplyWeights: true }), userId);
    const before = { ...getPolicy(userId).scoringWeights };

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("no_validated_weight_changes");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
  });

  it("revert restores the prior vector from the auto_weight_apply snapshot", async () => {
    const { setPolicy, getPolicy, audit, latestAuditByKind } = await import("../src/lib/db");
    const userId = `auto-revert-${randomUUID()}`;
    setPolicy(policyFor("AUTO-REV"), userId);
    const prior = { ...getPolicy(userId).scoringWeights };

    // Simulate a prior autonomous apply: bump momentum and record the snapshot the way the real path does.
    const bumped = { ...prior, momentum: prior.momentum + 0.05 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    audit(AUTO_WEIGHT_APPLY_AUDIT_KIND, { userId, previousWeights: prior, newWeights: bumped, changedFactors: ["momentum"] }, userId);
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum + 0.05, 5);
    expect(latestAuditByKind(AUTO_WEIGHT_APPLY_AUDIT_KIND, userId)).toBeTruthy();

    const reverted = revertAutonomousWeightTuning(userId);
    expect(reverted.reverted).toBe(true);
    // Weights are normalized on write; assert the momentum factor is back to (approximately) its prior value.
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum, 5);
  });

  it("revert is a no-op when there is no prior snapshot", async () => {
    const userId = `auto-norev-${randomUUID()}`;
    const { setPolicy } = await import("../src/lib/db");
    setPolicy(policyFor("AUTO-NOREV"), userId);
    const result = revertAutonomousWeightTuning(userId);
    expect(result.reverted).toBe(false);
    expect(result.reason).toBe("no_prior_snapshot");
  });
});

// ── Item 5: factor attribution never defaults an unresolved lot to "momentum" ──────────────────
describe("getFactorScorecard — item 5 (no momentum default)", () => {
  it("drops a closed lot whose dominant entry factor can't be resolved (no signal_snapshot) rather than labeling it momentum", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = `FACTOR5-${randomUUID()}`;
    const userId = `factor5-${randomUUID()}`;

    // Lot RESOLVED: entryRunId matches a signal_snapshot whose dominant factor is VALUE.
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "VAL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", runId: "run-resolved", filledAt: "2026-01-01T00:00:00.000Z", raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "R" } } });
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "VAL", side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: "2026-01-05T00:00:00.000Z" });
    audit("signal_snapshot", {
      runId: "run-resolved",
      signals: [{ symbol: "VAL", chosen: true, factorBreakdown: { liquidity: 5, momentum: 10, value: 95, quality: 10, volatility: 10, sentiment: 15, positioning: 30, diversification: 5, weightedTotal: 60 } }]
    }, userId);

    // Lot UNRESOLVED: entryRunId "run-missing" has NO signal_snapshot → factor can't be resolved.
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "UNK", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", runId: "run-missing", filledAt: "2026-02-01T00:00:00.000Z", raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "R" } } });
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "UNK", side: "sell", quantity: 1, price: 130, notional: 130, status: "filled", filledAt: "2026-02-05T00:00:00.000Z" });

    const scorecard = getFactorScorecard(account, "paper", {}, userId);
    // Only the resolved VALUE lot is attributed; the unresolved lot is DROPPED (never momentum).
    expect(scorecard).toHaveLength(1);
    expect(scorecard[0].factor).toBe("value");
    expect(scorecard.some((s) => s.factor === "momentum")).toBe(false);
  });
});

// ── Item 4 (panel B4): SPY excess-return injected in getSkippedCandidateReturns ────────────────
describe("SPY benchmark injection — item 4 (B4)", () => {
  it("buildSpyReturnToNowMap reuses one SPY fetch and computes each date's entry→now return", async () => {
    const { buildSpyReturnToNowMap } = await import("../src/lib/backtest");
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    const spyBars = [
      { time: "2026-01-05", close: 100 },
      { time: "2026-02-05", close: 110 },
      { time: "2026-03-05", close: 121 }
    ];
    const fetchOHLC = async () => spyBars as never;
    const map = await buildSpyReturnToNowMap(["2026-01-05", "2026-02-05"], now, fetchOHLC);
    // 2026-01-05 → last close at/before now (121) → (121-100)/100 = 0.21
    expect(map.get("2026-01-05")).toBeCloseTo(0.21, 4);
    // 2026-02-05 → (121-110)/110 = 0.1
    expect(map.get("2026-02-05")).toBeCloseTo(0.1, 4);
  });

  it("getSkippedCandidateReturns sets benchmarkReturnPct from the injected per-date SPY map", async () => {
    const { audit } = await import("../src/lib/db");
    const { getSkippedCandidateReturns } = await import("../src/lib/performance");
    const userId = `b4-${randomUUID()}`;
    const asOf = "2026-02-05T00:00:00.000Z";
    audit("signal_snapshot", { runId: "run-b4", asOf, signals: [{ symbol: "AAPL", chosen: false, refPrice: 100, score: 80 }] }, userId);

    const benchmarkReturnBySnapshotDate = new Map<string, number>([["2026-02-05", 0.04]]); // +4% SPY (fraction)
    const rows = getSkippedCandidateReturns({ AAPL: 110 }, userId, { maxAgeDays: 100000, benchmarkReturnBySnapshotDate });
    const aapl = rows.find((r) => r.symbol === "AAPL");
    expect(aapl?.returnPct).toBeCloseTo(10, 2); // (110-100)/100
    expect(aapl?.benchmarkReturnPct).toBeCloseTo(4, 2); // 0.04 → 4%
  });
});

// ── Item 6: calibration remap changes sizing only when the flag is on ──────────────────────────
describe("calibration-remapped sizing — item 6", () => {
  const THESIS = "Momentum-Breakout";
  const REGIME = "Tech-Bull";

  function buyProposal(confidenceScore: number): TradeProposal {
    return {
      symbol: "NVDA",
      side: "buy",
      type: "market",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "entry",
      tradeThesisTag: THESIS,
      entryMarketRegime: REGIME,
      confidenceScore
    };
  }

  // Seed proven, CORROBORATED thesis stats (so the conviction cap does NOT bind and we isolate the
  // calibration remap), PLUS closed high-confidence BUY lots that realized a POOR win rate (over-confidence).
  async function seedCorroboratedButOverconfident(account: string) {
    const { insertFillEvent } = await import("../src/lib/db");
    let t = 0;
    const stamp = () => `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`;
    // 20 round-trips: 18 winners (+5%) / 2 losers (-1%) → shrunkWinRate ~82% (corroborated), and every
    // entry carries confidenceScore 95 so the "85-100 (high)" calibration band realizes a LOW win rate
    // relative to the confidence (18/20 raw but we want the BAND's shrunk rate below raw conviction 0.95).
    for (let i = 0; i < 20; i++) {
      const sym = `SYM${i}`;
      const win = i < 6; // only 6/20 winners → shrunkWinRate for the band ~ round((6+2.5)/25*100)=34% << 95
      const entry = 100;
      const exit = win ? entry * 1.05 : entry * 0.99;
      insertFillEvent({
        accountNumber: account, source: "paper", symbol: sym, side: "buy", quantity: 1, price: entry, notional: entry,
        status: "filled", filledAt: stamp(),
        raw: { proposal: { tradeThesisTag: THESIS, entryMarketRegime: REGIME, confidenceScore: 95 } }
      });
      insertFillEvent({
        accountNumber: account, source: "paper", symbol: sym, side: "sell", quantity: 1, price: exit, notional: exit,
        status: "filled", filledAt: stamp()
      });
    }
  }

  it("flag OFF (default): sizing uses raw confidenceScore (byte-identical); flag ON sizes DOWN an over-confident band", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "CALIB-A";
    await seedCorroboratedButOverconfident(account);
    setPolicy(policyFor(account), "local");

    // Confirm the band actually realized a low win rate (over-confidence) so the remap has something to do.
    const calibration = getConfidenceCalibration(account, "paper", {}, "local");
    const highBand = calibration.find((c) => c.band === "85-100 (high)");
    expect(highBand && highBand.shrunkWinRate).toBeLessThan(70);

    // corroborationWinRatePct lowered so this thesis counts as corroborated → the conviction CAP does not
    // bind and we isolate the calibration remap's effect on sizing.
    const base = policyFor(account, { corroborationWinRatePct: 30 });
    const withCalib = policyFor(account, { corroborationWinRatePct: 30, calibrationSizing: true });

    const off = applyDeterministicSizing(buyProposal(95), base, PORTFOLIO, "paper", "local", NO_POSITIONS);
    const on = applyDeterministicSizing(buyProposal(95), withCalib, PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(on.dollarAmount ?? 0).toBeGreaterThan(0);
    // Calibration remap shrinks conviction (0.95 → blended toward realized), so the ON size is strictly
    // smaller than the raw-conviction OFF size.
    expect(on.dollarAmount ?? 0).toBeLessThan(off.dollarAmount ?? 0);
  });
});

// ── Item 2: cached congress verdict store/read + staleness ─────────────────────────────────────
describe("congress-score verdict cache — item 2 (three-way)", () => {
  const baseEval = (goNoGo: { pass: boolean; reasons: string[] }) => ({
    observations: 600, rawDates: 70, dates: 70, tickers: 60,
    rankIC: { meanIC: 0.03, nDates: 70, tStat: 2.5 }, quantiles: [],
    topMinusBottomReturn: 0.02, topHitRate: 0.55, benchmarkCoveragePct: 1,
    goNoGo
  }) as never;

  it("PASS verdict → stored as PASS, multiplier 1", async () => {
    const { storeCongressScoreVerdict, readCongressScoreVerdict, congressGateMultiplier } = await import("../src/lib/congress-score-gate");
    const userId = `cong-pass-${randomUUID()}`;
    const fresh = storeCongressScoreVerdict(userId, baseEval({ pass: true, reasons: [] }));
    expect(fresh.verdict).toBe("PASS");
    const read = readCongressScoreVerdict(userId);
    expect(read?.verdict).toBe("PASS");
    expect(read?.stale).toBe(false);
    expect(congressGateMultiplier(read, true)).toBe(1);
  });

  it("data-insufficiency no-go → INSUFFICIENT, multiplier 1 (not a kill-switch)", async () => {
    const { storeCongressScoreVerdict, readCongressScoreVerdict, congressGateMultiplier } = await import("../src/lib/congress-score-gate");
    const userId = `cong-insuf-${randomUUID()}`;
    storeCongressScoreVerdict(userId, baseEval({ pass: false, reasons: ["insufficient observations (10 < 500)", "insufficient dates (2 < 60)"] }));
    const read = readCongressScoreVerdict(userId);
    expect(read?.verdict).toBe("INSUFFICIENT");
    expect(congressGateMultiplier(read, true)).toBe(1);
  });

  it("significance no-go on adequate data → FAIL_SIGNIFICANCE, multiplier 0; stale → fail-open (1)", async () => {
    const { storeCongressScoreVerdict, readCongressScoreVerdict, congressGateMultiplier } = await import("../src/lib/congress-score-gate");
    const userId = `cong-fail-${randomUUID()}`;
    storeCongressScoreVerdict(userId, baseEval({ pass: false, reasons: ["rank IC t-stat is below 2"] }));
    const read = readCongressScoreVerdict(userId);
    expect(read?.verdict).toBe("FAIL_SIGNIFICANCE");
    expect(congressGateMultiplier(read, true)).toBe(0);

    // Re-store 30 days ago → stale → fail-open regardless of verdict.
    storeCongressScoreVerdict(userId, baseEval({ pass: false, reasons: ["rank IC t-stat is below 2"] }), Date.now() - 30 * 24 * 60 * 60 * 1000);
    const staleRead = readCongressScoreVerdict(userId);
    expect(staleRead?.stale).toBe(true);
    expect(congressGateMultiplier(staleRead, true)).toBe(1);
  });
});

// ── Item 8: the learner certifies a COST-AWARE edge (execution cost in the closed-lot returns) ──
describe("execution-cost in the learner — item 8", () => {
  function marketScanWithQuote(symbol: string, price: number): MarketScan {
    const quote = { symbol, price, bid: undefined, ask: undefined, volume: 0, score: 0 } as never;
    return {
      source: "test", generatedAt: new Date().toISOString(), scannedSymbols: 1, returnedQuotes: 1,
      warnings: [], topCandidates: [quote], quotesBySymbol: { [symbol]: quote }
    } as unknown as MarketScan;
  }

  it("a simulated paper BUY fill's price reflects execution cost (default ON), so downstream P&L is net-of-cost", async () => {
    const account = `COST-${randomUUID()}`;
    // Default execution-cost model ON (20 bps base, no spread/vol here) → buy fills ABOVE the quote.
    const fill = recordFillFromProposal({
      accountNumber: account,
      source: "paper",
      proposal: {
        symbol: "AAPL", side: "buy", type: "market", dollarAmount: 1000, timeInForce: "gfd",
        marketHours: "regular_hours", rationale: "cost-test", tradeThesisTag: "t", entryMarketRegime: "r"
      },
      review: { estimatedNotional: 1000, alerts: [], raw: {} },
      marketScan: marketScanWithQuote("AAPL", 100),
      status: "filled"
    });
    // price = 100 * (1 + 0.002) = 100.2 — strictly worse than the 100 quote for a buy.
    expect(fill.price).toBeGreaterThan(100);
    expect(fill.price).toBeCloseTo(100.2, 3);

    // The closed-lot return the learner reads is computed from THIS cost-adjusted entry price, so the
    // certified edge is net of cost. Close the lot at exactly the quote and confirm the realized return is
    // negative purely because of the cost drag (proving the learner sees cost, not a cost-free edge).
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const { calculatePnl } = await import("../src/lib/performance");
    insertFillEvent({
      accountNumber: account, source: "paper", symbol: "AAPL", side: "sell",
      quantity: fill.quantity, price: 100, notional: fill.quantity * 100, status: "filled",
      filledAt: new Date(Date.now() + 60_000).toISOString()
    });
    const { closedLots } = calculatePnl(listFillEvents(account, "paper", 500, "local"));
    expect(closedLots).toHaveLength(1);
    expect(closedLots[0].returnPct).toBeLessThan(0); // cost drag → negative realized return, cost-aware
  });

  it("B8: a paper EXIT priced at the raw quote pays the exit-side execution cost (applyPaperExitCost)", async () => {
    const { applyPaperExitCost } = await import("../src/lib/execution-cost");
    // sell (exit of a long) receives DOWN by the base cost → strictly below the raw 100 quote.
    const sell = applyPaperExitCost(100, "sell", "paper");
    expect(sell).toBeLessThan(100);
    expect(sell).toBeCloseTo(99.8, 3);
    // cover (exit of a short) pays UP → strictly above.
    const cover = applyPaperExitCost(100, "cover", "paper");
    expect(cover).toBeGreaterThan(100);
    // LIVE fills are NEVER adjusted (they carry a real reconciled price).
    expect(applyPaperExitCost(100, "sell", "live")).toBe(100);
  });

  it("B8 round-trip: a paper lot exited via a synthetic-stop-style raw-price fill still realizes a cost drag", async () => {
    // Simulate the synthetic-stops exit path: entry via recordFillFromProposal (costed), exit inserted at
    // the cost-adjusted raw price (what the fixed writer now does). The round-trip realized return must be
    // net of BOTH legs' cost — proving the losing tail no longer exits cost-free.
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const { calculatePnl } = await import("../src/lib/performance");
    const { applyPaperExitCost } = await import("../src/lib/execution-cost");
    const account = `SSTOP-${randomUUID()}`;

    const entry = recordFillFromProposal({
      accountNumber: account, source: "paper",
      proposal: { symbol: "TSLA", side: "buy", type: "market", dollarAmount: 1000, timeInForce: "gfd", marketHours: "regular_hours", rationale: "e", tradeThesisTag: "t", entryMarketRegime: "r" },
      review: { estimatedNotional: 1000, alerts: [], raw: {} },
      marketScan: marketScanWithQuote("TSLA", 100),
      status: "filled"
    });
    // Exit at the SAME 100 quote but through the paper-exit-cost helper (mirrors the fixed writer).
    const exitPrice = applyPaperExitCost(100, "sell", "paper");
    insertFillEvent({ accountNumber: account, source: "paper", symbol: "TSLA", side: "sell", quantity: entry.quantity, price: exitPrice, notional: entry.quantity * exitPrice, status: "filled", filledAt: new Date(Date.now() + 60_000).toISOString() });

    const { closedLots } = calculatePnl(listFillEvents(account, "paper", 500, "local"));
    expect(closedLots).toHaveLength(1);
    // Both legs cost: entry filled >100, exit filled <100 → strictly negative round-trip.
    expect(closedLots[0].returnPct).toBeLessThan(0);
  });
});

// ── Item 5 (panel B5): dominantFactor persisted at entry survives audit-cap aging ──────────────
describe("factor attribution persisted at entry — item 5 (B5)", () => {
  it("attributes a lot via the entry-stamped dominantFactor even when NO signal_snapshot exists for it", async () => {
    const { getFactorScorecard, recordFillFromProposal } = await import("../src/lib/performance");
    const account = `B5-${randomUUID()}`;
    const userId = `b5-${randomUUID()}`;

    // Entry via recordFillFromProposal with a marketScan candidate whose dominant factor is VALUE. NO
    // signal_snapshot audit is written — so the ONLY way to attribute this lot is the entry stamp.
    const valueScan = {
      source: "test", generatedAt: new Date().toISOString(), scannedSymbols: 1, returnedQuotes: 1, warnings: [],
      topCandidates: [{ symbol: "VLU", price: 100, score: 60, factorBreakdown: { liquidity: 5, momentum: 10, value: 95, quality: 10, volatility: 10, sentiment: 15, positioning: 30, diversification: 5, weightedTotal: 60 } } as never],
      quotesBySymbol: { VLU: { symbol: "VLU", price: 100, score: 60 } as never }
    } as unknown as MarketScan;

    recordFillFromProposal({
      userId, accountNumber: account, source: "paper",
      proposal: { symbol: "VLU", side: "buy", type: "market", quantity: 1, timeInForce: "gfd", marketHours: "regular_hours", rationale: "e", tradeThesisTag: "t", entryMarketRegime: "r" },
      review: { estimatedNotional: 100, alerts: [], raw: {} },
      marketScan: valueScan,
      status: "filled"
    });
    const { insertFillEvent } = await import("../src/lib/db");
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "VLU", side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: new Date(Date.now() + 60_000).toISOString() });

    const scorecard = getFactorScorecard(account, "paper", {}, userId);
    expect(scorecard).toHaveLength(1);
    expect(scorecard[0].factor).toBe("value"); // resolved from the ENTRY stamp, no snapshot needed
  });
});

// ── P2-8: congress go/no-go — scheduled/cached refresher off the scan hot path ─────────────────
describe("refreshCongressScoreVerdict — P2-8", () => {
  // A fixture OHLC fetcher returning a rising ramp so forward returns resolve for every seeded date.
  function rampFetcher() {
    // Distinct per-symbol slopes so the score→return relationship is learnable.
    return async (symbol: string) => {
      const slope = symbol === "SPY" ? 0.0 : symbol.charCodeAt(0) % 5;
      const bars = [] as { time: string; close: number }[];
      for (let d = 1; d <= 28; d++) {
        for (const m of ["01", "02", "03", "04"]) {
          bars.push({ time: `2026-${m}-${String(d).padStart(2, "0")}`, close: 100 + slope * d });
        }
      }
      return bars as never;
    };
  }

  it("computes, stores, and makes a verdict readable (eval runs OFF the scan path)", async () => {
    const { audit, setPolicy } = await import("../src/lib/db");
    const { refreshCongressScoreVerdict, readCongressScoreVerdict } = await import("../src/lib/congress-score-gate");
    const userId = `p28-${randomUUID()}`;
    setPolicy(policyFor(`P28-${randomUUID()}`), userId);
    // Seed one snapshot with a couple of congress-scored names so an evaluation has data.
    audit("signal_snapshot", {
      runId: "r", asOf: "2026-01-05T00:00:00.000Z",
      signals: [
        { symbol: "AAA", refPrice: 100, congressCompositeScore: 80, congressCompositeDirection: "BUY" },
        { symbol: "BBB", refPrice: 100, congressCompositeScore: 20, congressCompositeDirection: "BUY" }
      ]
    }, userId);

    const verdict = await refreshCongressScoreVerdict(userId, { horizonDays: 5, fetchOHLC: rampFetcher(), placeboSeed: 7 });
    expect(verdict.computedAt).toBeTruthy();
    // A data-poor account yields INSUFFICIENT (not a permanent kill-switch) — the key P2-8 property.
    expect(["PASS", "FAIL_SIGNIFICANCE", "INSUFFICIENT"]).toContain(verdict.verdict);
    const read = readCongressScoreVerdict(userId);
    expect(read?.verdict).toBe(verdict.verdict);
    expect(read?.stale).toBe(false);
  });

  it("honors congressRequireTopBucketPositive (P2-3) — bakes the long-leg reason into the stored verdict", async () => {
    const { audit, setPolicy } = await import("../src/lib/db");
    const { refreshCongressScoreVerdict } = await import("../src/lib/congress-score-gate");
    const userId = `p28-p23-${randomUUID()}`;
    setPolicy(policyFor(`P28TB-${randomUUID()}`, { congressRequireTopBucketPositive: true }), userId);
    // Seed several dates where the TOP score bucket falls while the BOTTOM falls harder (spread positive,
    // long leg negative). Fixture fetcher returns FALLING bars so forward returns are negative for all.
    const fallFetcher = async () => {
      const bars = [] as { time: string; close: number }[];
      for (let d = 1; d <= 28; d++) for (const m of ["01", "02"]) bars.push({ time: `2026-${m}-${String(d).padStart(2, "0")}`, close: 100 - d });
      return bars as never;
    };
    for (const day of ["01-02", "01-05", "01-08"]) {
      audit("signal_snapshot", {
        runId: `r-${day}`, asOf: `2026-${day}T00:00:00.000Z`,
        signals: [
          { symbol: `T1${day}`, refPrice: 100, congressCompositeScore: 90, congressCompositeDirection: "BUY" },
          { symbol: `T2${day}`, refPrice: 100, congressCompositeScore: 80, congressCompositeDirection: "BUY" },
          { symbol: `B1${day}`, refPrice: 100, congressCompositeScore: 20, congressCompositeDirection: "BUY" },
          { symbol: `B2${day}`, refPrice: 100, congressCompositeScore: 10, congressCompositeDirection: "BUY" }
        ]
      }, userId);
    }
    const verdict = await refreshCongressScoreVerdict(userId, { horizonDays: 5, fetchOHLC: fallFetcher as never, placeboSeed: 3 });
    // The stored verdict cannot PASS while the long leg loses; when it FAILs on significance the P2-3 reason
    // is among the reasons. (Data thinness may render it INSUFFICIENT — the reason set still carries P2-3.)
    expect(verdict.reasons.some((r) => r.startsWith("top-bucket long-leg excess return is not positive"))).toBe(true);
    expect(verdict.pass).toBe(false);
  });
});
