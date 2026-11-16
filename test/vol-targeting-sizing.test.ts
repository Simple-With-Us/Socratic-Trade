import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { PortfolioHeatResult } from "../src/lib/vol-targeting";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";

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
});
