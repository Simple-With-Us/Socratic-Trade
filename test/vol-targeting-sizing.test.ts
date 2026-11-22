import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { PortfolioHeatResult } from "../src/lib/vol-targeting";
import { positionRiskUsd } from "../src/lib/vol-targeting";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing, resolveStopDistancePct } from "../src/lib/strategy-risk";

// Volatility-targeting sizing + portfolio-heat budget (opt-in, continuous taper, advisory-first).
// Drives applyDeterministicSizing directly (the deterministic, non-LLM sizer) with precomputed
// realizedVolPctBySymbol / bookHeat maps — exactly what strategy.ts's runStrategyOnce threads in
// after its async bars-fetch precompute. Both new params are OPTIONAL trailing args, so every
// existing call site (and every pre-existing test) is byte-identical when they're omitted.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-voltarget-${randomUUID()}.db`)}`;
});

const THESIS = "Momentum-Breakout";
const REGIME = "Tech-Bull";

// accountEquity() = cash + equityMarketValue + optionMarketValue — keep these summing to exactly
// $1,000,000 equity so the heat-budget-% math in the tests below is easy to hand-verify.
const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 1_000_000,
  optionMarketValue: 0,
  cash: 0
};

const NO_POSITIONS: EquityPosition[] = [];

function buyProposal(symbol = "NVDA", confidenceScore = 60): TradeProposal {
  return {
    symbol,
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

function notionalOf(p: TradeProposal): number {
  return p.dollarAmount ?? 0;
}

/**
 * Seed `count` closed round-trips for THESIS @ REGIME on `account` so the thesis is PROVEN
 * (>= minClosedLotsForWeightShift, default 20) and the sizer's real Kelly-lite multiplier — not the
 * unproven exploratory floor — governs size. Mirrors test/conviction-size-cap.test.ts's helper.
 */
async function seedClosedLots(opts: { account: string; count: number; wins: number; winPct: number; lossPct: number }) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, count, wins, winPct, lossPct } = opts;
  let t = 0;
  for (let i = 0; i < count; i++) {
    const sym = `SYM${i}`;
    const entry = 100;
    const exit = i < wins ? entry * (1 + winPct / 100) : entry * (1 - lossPct / 100);
    insertFillEvent({
      accountNumber: account,
      source: "paper",
      symbol: sym,
      side: "buy",
      quantity: 1,
      price: entry,
      notional: entry,
      status: "filled",
      filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`,
      raw: { proposal: { tradeThesisTag: THESIS, entryMarketRegime: REGIME } }
    });
    insertFillEvent({
      accountNumber: account,
      source: "paper",
      symbol: sym,
      side: "sell",
      quantity: 1,
      price: exit,
      notional: exit,
      status: "filled",
      filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`
    });
  }
}

describe("vol-targeting sizing integration", () => {
  it("flag OFF: byte-identical size vs baseline even when realizedVolPctBySymbol/bookHeat are supplied", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-OFF";
    setPolicy(policyFor(account));

    const baseline = applyDeterministicSizing(buyProposal(), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const withData = applyDeterministicSizing(
      buyProposal(),
      policyFor(account), // volTargeting undefined → off
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 60 }, // high realized vol supplied, but flag is off
      undefined
    );

    expect(notionalOf(withData)).toBe(notionalOf(baseline));
    // The realized-vol number is still surfaced as an advisory-only receipt when cheaply available,
    // even with the feature off — but it must say advisory-only, never "applied".
    expect(withData.rationale).toContain("Realized vol 60.0%");
    expect(withData.rationale).toContain("advisory-only");
    expect(withData.rationale).not.toContain("vol-target scale") ; // no target configured → different branch text
  });

  it("flag ON, high-vol symbol vs target: size is tapered and the vol-target note is present", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-ON-HIGH";
    // PROVEN + strong edge so the Kelly-lite multiplier (not the unproven exploratory floor) governs
    // size — otherwise the vol-target taper on `multiplier` would be masked by the flat 10% floor.
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const policy = policyFor(account, { volTargeting: true, targetPortfolioVolPct: 20 });
    // Realized vol 60% vs target 20% → scale = clamp(20/60, 0.25, 1) = 0.3333...
    const tapered = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 60 }
    );
    const untaperedPolicy = policyFor(account, { volTargeting: false, targetPortfolioVolPct: 20 });
    const untapered = applyDeterministicSizing(
      buyProposal(),
      untaperedPolicy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 60 }
    );

    expect(notionalOf(tapered)).toBeGreaterThan(0);
    expect(notionalOf(tapered)).toBeLessThan(notionalOf(untapered));
    expect(tapered.rationale).toContain("Realized vol 60.0% vs target 20% → vol-target scale 0.33x (applied)");
    expect(untapered.rationale).toContain("advisory-only");
  });

  it("realized vol at/below target never sizes UP (scale clamped at 1)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-ON-LOW";
    setPolicy(policyFor(account));

    const policy = policyFor(account, { volTargeting: true, targetPortfolioVolPct: 20 });
    const atTarget = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 10 } // below target
    );
    const noVolData = applyDeterministicSizing(buyProposal(), policy, PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(notionalOf(atTarget)).toBe(notionalOf(noVolData));
    expect(atTarget.rationale).toContain("vol-target scale 1.00x (applied)");
  });

  it("heat budget exceeded: order is continuously tapered to fit the remaining budget", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-HEAT-EXCEED";
    // PROVEN + strong edge so targetNotional starts well above the unproven $1,000 exploratory
    // floor (near the $10,000 maxOrderNotional cap) — otherwise there's nothing left to taper.
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const policy = policyFor(account, { volTargeting: true, portfolioHeatBudgetPct: 2 });
    // Book already at 1.97% heat (out of a 2% budget) on $1,000,000 equity = $19,700 already at
    // risk. Remaining budget = 0.03% of equity = $300. This proven+corroborated buy sizes to
    // roughly $4,900 un-tapered (8% stop → ~$392 of incremental risk) — over the $300 remaining —
    // so it must taper down to fit.
    const tightBookHeat: PortfolioHeatResult = {
      totalRiskUsd: 19_700,
      heatPct: 1.97,
      perPosition: [{ symbol: "AAPL", riskUsd: 19_700, stopPctUsed: 8, estimated: false }]
    };

    const tapered = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      tightBookHeat
    );
    const noHeatPolicy = policyFor(account, { volTargeting: true }); // no budget configured
    const untapered = applyDeterministicSizing(
      buyProposal(),
      noHeatPolicy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      tightBookHeat
    );

    expect(notionalOf(tapered)).toBeGreaterThan(0);
    expect(notionalOf(tapered)).toBeLessThan(notionalOf(untapered));
    expect(tapered.rationale).toContain("[Risk] Portfolio heat 2.0% of equity vs budget 2%");
    expect(untapered.rationale).not.toContain("[Risk] Portfolio heat");
  });

  it("no stop basis anywhere: heat receipt states missing basis honestly, never a fabricated number", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-NO-BASIS";
    setPolicy(policyFor(account));

    const policy = policyFor(account, { volTargeting: true, portfolioHeatBudgetPct: 5 });
    const noBasisHeat: PortfolioHeatResult = {
      totalRiskUsd: 0,
      heatPct: 0,
      perPosition: [
        { symbol: "AAPL", riskUsd: 0, stopPctUsed: 0, estimated: true },
        { symbol: "MSFT", riskUsd: 0, stopPctUsed: 0, estimated: true }
      ]
    };

    const sized = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      noBasisHeat
    );

    expect(sized.rationale).toContain("2 positions, 2 without stop basis");
    // No taper applied since book heat is 0 and the order's own risk is well within budget — just
    // the honest "adds X%" receipt, no fabricated heat number.
    expect(sized.rationale).toContain("[Risk] Portfolio heat 0.0% of equity vs budget 5%");
  });

  it("heat budget fully exhausted: holds at the exploratory floor and tags an overridable advisory note (never a hard block)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-HEAT-FLOOR";
    setPolicy(policyFor(account));

    const policy = policyFor(account, { volTargeting: true, portfolioHeatBudgetPct: 1 });
    const maxedHeat: PortfolioHeatResult = {
      totalRiskUsd: 10_000, // already AT the 1% budget of $1,000,000 equity
      heatPct: 1,
      perPosition: [{ symbol: "AAPL", riskUsd: 10_000, stopPctUsed: 8, estimated: false }]
    };

    const sized = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      maxedHeat
    );

    // Still places (never a hard block) — dollarAmount stays positive/defined, just floored.
    expect(sized.dollarAmount).toBeDefined();
    expect(sized.rationale).toContain("no remaining budget");
    expect(sized.rationale).toContain("overridable advisory, not a block");
  });

  it("heat budget exhausted never jumps upward above an already-trimmed targetNotional", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-HEAT-NO-JUMP";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    // Equal-risk cap trims targetNotional to $2,500 (0.02% of $1M = $200 risk ÷ 8% stop = $2,500),
    // while fallbackNotional on this proven thesis is ~$4,900. Exhausted heat budget must NOT jump
    // targetNotional back up from $2,500 to $4,900.
    const policy = policyFor(account, {
      volTargeting: true,
      portfolioHeatBudgetPct: 1,
      maxPositionRiskPctOfEquity: 0.02
    });
    const maxedHeat: PortfolioHeatResult = {
      totalRiskUsd: 10_000,
      heatPct: 1,
      perPosition: [{ symbol: "AAPL", riskUsd: 10_000, stopPctUsed: 8, estimated: false }]
    };

    const sized = applyDeterministicSizing(
      buyProposal(),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      maxedHeat
    );

    expect(notionalOf(sized)).toBeLessThanOrEqual(2_500);
  });

  it("scales an explicit LLM-advised dollarAmount by finalMultiplier when vol-targeting tapers size", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-ADVISED-SCALE";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    const taperedPolicy = policyFor(account, { volTargeting: true, targetPortfolioVolPct: 20 });
    const untaperedPolicy = policyFor(account, { volTargeting: false, targetPortfolioVolPct: 20 });
    const proposalWithDollar = { ...buyProposal("NVDA", 95), dollarAmount: 5_000 };

    const tapered = applyDeterministicSizing(
      proposalWithDollar,
      taperedPolicy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 60 }
    );
    const untapered = applyDeterministicSizing(
      proposalWithDollar,
      untaperedPolicy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      { NVDA: 60 }
    );

    expect(notionalOf(tapered)).toBeGreaterThan(0);
    expect(notionalOf(tapered)).toBeLessThan(notionalOf(untapered));
  });

  it("resolveStopDistancePct prioritizes bracketStopLoss, then stopPrice, then ATR, then side-specific stop, then fallback", () => {
    const basePolicy = policyFor("STOP-PRIO");
    const scan: MarketScan = {
      source: "test",
      generatedAt: "2026-11-22T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [],
      sectorBySymbol: {},
      quotesBySymbol: { NVDA: { symbol: "NVDA", price: 200, score: 80 } },
      warnings: []
    };

    // 1) bracketStopLoss vs referencePrice (or scanQuotePrice when referencePrice absent)
    expect(
      resolveStopDistancePct(
        { ...buyProposal("NVDA"), bracketStopLoss: 190, stopPrice: 160 },
        basePolicy,
        scan,
        { NVDA: 12 }
      )
    ).toBeCloseTo(5, 6);

    // 2) stopPrice vs referencePrice when bracketStopLoss is absent
    expect(
      resolveStopDistancePct(
        { ...buyProposal("NVDA"), referencePrice: 100, stopPrice: 94 },
        basePolicy,
        scan,
        { NVDA: 12 }
      )
    ).toBeCloseTo(6, 6);

    // 3) atrStopPctByOpeningSymbol when no concrete order stop is attached
    expect(
      resolveStopDistancePct(buyProposal("NVDA"), basePolicy, scan, { NVDA: 12.5 })
    ).toBeCloseTo(12.5, 6);

    // 4) Side-specific configured stop (shortStopLossPct for shorts, stopLossPct for buys)
    const shortPolicy: TradingPolicy = {
      ...basePolicy,
      riskRules: { ...basePolicy.riskRules, stopLossPct: 7, shortStopLossPct: 4 }
    };
    expect(resolveStopDistancePct({ ...buyProposal("NVDA"), side: "short" }, shortPolicy, scan)).toBe(4);
    expect(resolveStopDistancePct(buyProposal("NVDA"), shortPolicy, scan)).toBe(7);

    // 5) STOP_PLAN_FALLBACK_STOP_PCT (8%) when configured stop is 0
    const barePolicy: TradingPolicy = {
      ...basePolicy,
      riskRules: { ...basePolicy.riskRules, stopLossPct: 0, shortStopLossPct: 0 }
    };
    expect(resolveStopDistancePct(buyProposal("NVDA"), barePolicy, scan)).toBe(8);
  });

  it("equal-risk cap and heat taper both honor precomputed opening ATR stop distance", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-ATR-EQUAL-RISK";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    // 0.1% of $1,000,000 equity = $1,000 risk budget.
    // With default 8% stop: equalRiskCap = $1,000 / 0.08 = $12,500 (does not bind below $10k maxOrderNotional).
    // With 20% opening ATR stop: equalRiskCap = $1,000 / 0.20 = $5,000 (trims order to <= $5,000).
    const policy = policyFor(account, {
      sizingFloorPct: 100,
      maxPositionRiskPctOfEquity: 0.1
    });
    const sized = applyDeterministicSizing(
      { ...buyProposal("NVDA", 95), dollarAmount: 8_000 },
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { NVDA: 20 }
    );

    expect(notionalOf(sized)).toBe(5_000);
    expect(sized.rationale).toContain("20.0% stop risks at most $1,000");
  });

  it("re-asserts the portfolio-heat cap AFTER bracketWholeShareMinimum without double-auditing", async () => {
    const { setPolicy, listAuditByKind } = await import("../src/lib/db");
    const account = "VT-HEAT-BRACKET-REASSERT";
    setPolicy(policyFor(account));

    // Alpaca policy with brackets enabled: 1 share of V costs $400.
    // Heat budget is 1% of $1,000,000 = $10,000. Existing book heat is $9,990, leaving $10 risk budget.
    // At a 10% stop, $10 remaining risk budget allows at most $100 notional — well below the $400
    // whole-share bracket bump. The post-bracket applyHeatCap re-assertion must clamp the $400 raise
    // back down to $100 and emit sizing_heat_budget_applied once.
    const policy: TradingPolicy = {
      ...policyFor(account, { volTargeting: true, portfolioHeatBudgetPct: 1 }),
      activeBroker: "alpaca",
      brokerBracketsEnabled: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 10, takeProfitPct: 20 }
    };
    const scan: MarketScan = {
      source: "test",
      generatedAt: "2026-11-22T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [],
      sectorBySymbol: {},
      quotesBySymbol: { V: { symbol: "V", price: 400, score: 80 } },
      warnings: []
    };
    const tightHeat: PortfolioHeatResult = {
      totalRiskUsd: 9_990,
      heatPct: 0.999,
      perPosition: [{ symbol: "AAPL", riskUsd: 9_990, stopPctUsed: 10, estimated: false }]
    };

    const sized = applyDeterministicSizing(
      buyProposal("V"),
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      scan,
      undefined,
      undefined,
      tightHeat
    );

    expect(notionalOf(sized)).toBe(100);
    const audits = listAuditByKind("sizing_heat_budget_applied", 500, "local").filter(
      (e) => (e.payload as { symbol?: string })?.symbol === "V"
    );
    expect(audits).toHaveLength(1);
  });

  it("accumulates runningBookHeat sequentially across multiple proposals in a batch", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const account = "VT-SEQ-BATCH";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 });
    setPolicy(policyFor(account));

    // Budget = 1% of $1,000,000 = $10,000. Existing book heat = $9,600 (remaining = $400).
    // Stop = 10%, so each $3,000 order adds $300 of risk.
    // Proposal 1 ($3,000) fits in the $400 remaining budget ($9,600 + $300 = $9,900 <= $10,000).
    // After accumulating Proposal 1's $300 risk into runningBookHeat ($9,900, remaining = $100),
    // Proposal 2 ($3,000 → $300 risk) exceeds the $100 remaining budget and tapers to $1,000.
    const policy: TradingPolicy = {
      ...policyFor(account, { volTargeting: true, portfolioHeatBudgetPct: 1, sizingFloorPct: 100 }),
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 10 }
    };
    let runningBookHeat: PortfolioHeatResult = {
      totalRiskUsd: 9_600,
      heatPct: 0.96,
      perPosition: [{ symbol: "AAPL", riskUsd: 9_600, stopPctUsed: 10, estimated: false }]
    };

    const first = applyDeterministicSizing(
      { ...buyProposal("NVDA", 95), dollarAmount: 3_000 },
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      runningBookHeat
    );
    expect(notionalOf(first)).toBe(3_000);

    const firstStopPct = resolveStopDistancePct(first, policy);
    const addedRiskUsd = positionRiskUsd(notionalOf(first), firstStopPct);
    runningBookHeat = {
      ...runningBookHeat,
      totalRiskUsd: runningBookHeat.totalRiskUsd + addedRiskUsd,
      heatPct: ((runningBookHeat.totalRiskUsd + addedRiskUsd) / PORTFOLIO.totalMarketValue) * 100
    };

    const second = applyDeterministicSizing(
      { ...buyProposal("MSFT", 95), dollarAmount: 3_000 },
      policy,
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS,
      undefined,
      undefined,
      undefined,
      runningBookHeat
    );
    expect(notionalOf(second)).toBe(1_000);
    expect(second.rationale).toContain("fit remaining budget");
  });
});
