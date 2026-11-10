import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

/**
 * Rank 5 of the 2026-09-25 trading-performance report: "Shrink Value-Quality position sizes and
 * watch Momentum-Breakout" — "the most consistent negative thesis in the data (25 lots, -$79.18)".
 *
 * The learned `edgeFactor` already shrinks a weak thesis from realized stats, so the operator dial
 * is only useful for the case it cannot cover: a thesis whose sample is too thin or too
 * regime-specific for its learned factor to be trustworthy. These tests pin the two properties that
 * make such a dial safe to leave sitting in a policy file — it can only ever SHRINK, and a missing
 * or malformed value changes nothing at all.
 */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-thesis-mult-${randomUUID()}.db`)}`;
});

const THESIS = "Value-Quality";
const REGIME = "Tech-Bull";

const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 1_000_000,
  optionMarketValue: 0,
  cash: 0
};

const NO_POSITIONS: EquityPosition[] = [];

function buyProposal(thesis = THESIS, symbol = "NVDA"): TradeProposal {
  return {
    symbol,
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: thesis,
    entryMarketRegime: REGIME,
    confidenceScore: 60
  };
}

function policyFor(account: string, thesisSizeMultipliers?: Record<string, number>): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    maxOrderNotional: 10_000,
    maxOrderPctOfNav: undefined,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning: thesisSizeMultipliers ? { thesisSizeMultipliers } : undefined
  };
}

const notionalOf = (p: TradeProposal) => p.dollarAmount ?? 0;

/**
 * Seed `count` closed round trips for THESIS @ REGIME on `account` so the thesis reads as PROVEN
 * (>= minClosedLotsForWeightShift, default 20) and the sizer's real Kelly-lite multiplier — not
 * the UNPROVEN exploratory FLOOR — governs size.  Without this every assertion below is vacuous:
 * the floor pins size to its minimum and masks any multiplier change, including the
 * "byte-identical when unconfigured" controls.  Mirrors test/vol-targeting-sizing.test.ts.
 */
async function seedProvenThesis(account: string) {
  const { insertFillEvent } = await import("../src/lib/db");
  let t = 0;
  for (let i = 0; i < 24; i++) {
    const sym = `TSM${i}`;
    const entry = 100;
    const exit = i < 16 ? entry * 1.02 : entry * 0.98; // ~67% win rate
    const ts = () => `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`;
    insertFillEvent({
      accountNumber: account,
      source: "paper",
      symbol: sym,
      side: "buy",
      quantity: 1,
      price: entry,
      notional: entry,
      status: "filled",
      filledAt: ts(),
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
      filledAt: ts()
    });
  }
}

describe("per-thesis sizing multiplier (review rank 5)", () => {
  it("is byte-identical to baseline when no multipliers are configured", async () => {
    const account = "TM-NONE";
    await seedProvenThesis(account);
    const baseline = applyDeterministicSizing(buyProposal(), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const emptyMap = applyDeterministicSizing(buyProposal(), policyFor(account, {}), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(notionalOf(emptyMap)).toBe(notionalOf(baseline));
  });

  it("shrinks a configured thesis and leaves every other thesis untouched", async () => {
    const account = "TM-SHRINK";
    await seedProvenThesis(account);
    const onThesis = applyDeterministicSizing(buyProposal(THESIS), policyFor(account, { [THESIS]: 0.5 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const onOtherThesis = applyDeterministicSizing(buyProposal("Momentum-Breakout"), policyFor(account, { [THESIS]: 0.5 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const baseline = applyDeterministicSizing(buyProposal(THESIS), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const otherBaseline = applyDeterministicSizing(buyProposal("Momentum-Breakout"), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(notionalOf(onThesis)).toBeLessThan(notionalOf(baseline));
    // An unconfigured thesis is unaffected — the dial is per-thesis, not global.
    expect(notionalOf(onOtherThesis)).toBe(notionalOf(otherBaseline));
  });

  it("clamps a value above 1 down to 1, so a typo can never inflate a position", async () => {
    const account = "TM-CLAMPHIGH";
    await seedProvenThesis(account);
    const inflated = applyDeterministicSizing(buyProposal(), policyFor(account, { [THESIS]: 4 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const baseline = applyDeterministicSizing(buyProposal(), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(notionalOf(inflated)).toBe(notionalOf(baseline));
  });

  it("accepts 0 to park a thesis entirely, and clamps a negative value to 0 rather than passing it through", async () => {
    const account = "TM-ZERO";
    await seedProvenThesis(account);
    const zeroed = applyDeterministicSizing(buyProposal(), policyFor(account, { [THESIS]: 0 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const negative = applyDeterministicSizing(buyProposal(), policyFor(account, { [THESIS]: -2 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(notionalOf(zeroed)).toBe(0);
    // Clamped to 0, not passed through: a negative size is nonsense, parking is the honest reading.
    expect(notionalOf(negative)).toBe(0);
  });

  it("ignores a non-finite value rather than propagating NaN into a size", async () => {
    const account = "TM-NAN";
    await seedProvenThesis(account);
    const nan = applyDeterministicSizing(buyProposal(), policyFor(account, { [THESIS]: Number.NaN }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    const baseline = applyDeterministicSizing(buyProposal(), policyFor(account), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(notionalOf(nan)).toBe(notionalOf(baseline));
  });

  it("says so in the rationale, so a shrunk order is not mistaken for a bug", async () => {
    const account = "TM-NOTE";
    await seedProvenThesis(account);
    const sized = applyDeterministicSizing(buyProposal(), policyFor(account, { [THESIS]: 0.5 }), PORTFOLIO, "paper", "local", NO_POSITIONS);
    expect(sized.rationale).toContain("thesisSizeMultipliers");
    expect(sized.rationale).toContain(THESIS);
  });
});
