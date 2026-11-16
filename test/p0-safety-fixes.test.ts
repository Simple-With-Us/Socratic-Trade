// Regression tests for the P0 safety slice from the 2026-06-21 financial-expert-panel review:
//  A. Quantity-less exit hole (silent no-op stop)  — policy.ts hard reject
//  B. Fail-closed Red Team                          — red-team.ts `available` flag
//  C. Atomic / recoverable order placement          — ref_id persistence + stale 'placing' sweep
//  D. Account-level drawdown / daily-loss kill-switch — risk-breaker.ts
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import { evaluateDrawdownBreaker } from "../src/lib/risk-breaker";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-p0-${randomUUID()}.db`)}`;
});

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000
};

const positions: EquityPosition[] = [{ symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }];

const enabledPolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["AAPL"]
};

const baseCtx = {
  policy: enabledPolicy,
  portfolio,
  positions,
  dailyNotionalUsed: 0,
  dailyOrderCount: 0
};

function exit(side: "sell" | "cover", overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "AAPL",
    side,
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "exit",
    tradeThesisTag: "Risk-Exit",
    entryMarketRegime: "Active Risk Check",
    ...overrides
  };
}

describe("A. quantity-less exit is rejected (no silent 0-qty phantom fill)", () => {
  it("rejects a sell with neither quantity nor dollarAmount", () => {
    const decision = evaluateTradeProposal(exit("sell"), { ...baseCtx, estimatedNotional: 0 });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("exit must specify a quantity or dollar amount"))).toBe(true);
  });

  it("rejects a cover with neither quantity nor dollarAmount", () => {
    const shortPos: EquityPosition[] = [{ symbol: "AAPL", quantity: -5, averageCost: 200, marketValue: -1000 }];
    const decision = evaluateTradeProposal(exit("cover"), {
      ...baseCtx,
      positions: shortPos,
      policy: { ...enabledPolicy, shortSellingEnabled: true, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 5 } },
      estimatedNotional: 0
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("exit must specify a quantity or dollar amount"))).toBe(true);
  });

  it("allows an exit that specifies a quantity", () => {
    const decision = evaluateTradeProposal(exit("sell", { quantity: 5 }), { ...baseCtx, estimatedNotional: 1000 });
    expect(decision.reasons.some((r) => r.includes("exit must specify"))).toBe(false);
  });

  it("allows an exit that specifies a dollarAmount", () => {
    const decision = evaluateTradeProposal(exit("sell", { dollarAmount: 500 }), { ...baseCtx, estimatedNotional: 500 });
    expect(decision.reasons.some((r) => r.includes("exit must specify"))).toBe(false);
  });
});

describe("D. drawdown / daily-loss circuit breaker (pure)", () => {
  it("does not breach when both limits are unset", () => {
    expect(evaluateDrawdownBreaker({ equity: 5000, highWaterMark: 10000, startOfDayEquity: 10000 }).breached).toBe(false);
  });

  it("breaches on a trailing drawdown beyond the limit", () => {
    const r = evaluateDrawdownBreaker({ equity: 8000, highWaterMark: 10000, startOfDayEquity: 9000, maxDrawdownPct: 15 });
    expect(r.breached).toBe(true); // 20% drawdown > 15%
    expect(r.reason).toMatch(/drawdown/i);
  });

  it("does not breach when drawdown is within the limit", () => {
    const r = evaluateDrawdownBreaker({ equity: 9500, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 });
    expect(r.breached).toBe(false); // 5% drawdown < 15%
  });

  it("breaches on a single-day loss beyond the notional limit", () => {
    const r = evaluateDrawdownBreaker({ equity: 9000, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 500 });
    expect(r.breached).toBe(true); // $1000 loss > $500
    expect(r.reason).toMatch(/daily-loss/i);
  });

  it("does not breach when the day's loss is within the limit", () => {
    const r = evaluateDrawdownBreaker({ equity: 9800, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 500 });
    expect(r.breached).toBe(false); // $200 loss < $500
  });
});

describe("B. Red Team fails closed (surfaces availability) — never silently drops a trade", () => {
  const buyProposal = (): TradeProposal => ({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "momentum",
    confidenceScore: 90,
    tradeThesisTag: "Momentum-Breakout",
    entryMarketRegime: "test"
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("reports available:false (and rejected:false) when OpenAI is not configured", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    delete process.env.OPENROUTER_API_KEY;
    // No-defaults world: the Red model must be an EXPLICIT choice for this test to exercise the
    // missing-KEY path (a blank model is its own earlier not_configured exit).
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_NOKEY", llmModel: "openai/gpt-4.1-mini", redTeamLlmModel: "openai/gpt-4.1-mini" });
    setStrategyPrompt("BASE STRATEGY");

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.rejected).toBe(false); // never silently drop
    expect(result.available).toBe(false); // but the caller can see it didn't run
  });

  it("reports available:false on a non-OK provider response", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    process.env.OPENROUTER_API_KEY = "sk-test";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_FAIL", llmModel: "openai/gpt-4.1-mini", redTeamLlmModel: "openai/gpt-4.1-mini" });
    setStrategyPrompt("BASE STRATEGY");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.rejected).toBe(false);
    expect(result.available).toBe(false);
  });
});

describe("C. atomic placement support (ref_id persistence + stale 'placing' sweep)", () => {
  it("persists ref_id via updateProposalStatus and surfaces stale 'placing' intents", async () => {
    const { insertProposal, updateProposalStatus, listStalePlacingProposals } = await import("../src/lib/db");
    const account = "PLACING_ACCT";
    const id = randomUUID();
    const proposal: TradeProposal = {
      symbol: "MSFT",
      side: "buy",
      type: "market",
      quantity: 1,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "intent",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "test"
    };

    insertProposal({ id, runId: randomUUID(), accountNumber: account, proposal, decision: { approved: true, reasons: [] }, status: "placing" });

    // updateProposalStatus persists the broker idempotency key (ref_id). The stale-intent query
    // reads ref_id back, so a matching refId there proves persistence.
    updateProposalStatus(id, "placing", undefined, undefined, undefined, "local", "ref-123");

    // A future cutoff means "every placing row is older than the cutoff" → the intent is surfaced.
    const future = new Date(Date.now() + 60_000).toISOString();
    const stale = listStalePlacingProposals(account, future, "local");
    expect(stale.some((s) => s.id === id && s.refId === "ref-123")).toBe(true);

    // A far-past cutoff means nothing is older than it → not surfaced.
    const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    expect(listStalePlacingProposals(account, past, "local").some((s) => s.id === id)).toBe(false);
  });
});

describe("E. buying-power affordability gate (opening orders only)", () => {
  const buy = (notional: number): TradeProposal => ({
    symbol: "AAPL", side: "buy", type: "market", dollarAmount: notional,
    timeInForce: "gfd", marketHours: "regular_hours", rationale: "buy", tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "test"
  });

  it("blocks an opening buy that exceeds available buying power", () => {
    const decision = evaluateTradeProposal(buy(8000), { ...baseCtx, portfolio: { ...portfolio, buyingPower: 5000 }, estimatedNotional: 8000 });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("exceeds available buying power"))).toBe(true);
  });

  it("allows an opening buy within buying power", () => {
    const decision = evaluateTradeProposal(buy(1000), { ...baseCtx, portfolio: { ...portfolio, buyingPower: 5000 }, estimatedNotional: 1000 });
    expect(decision.reasons.some((r) => r.includes("buying power"))).toBe(false);
  });

  it("does not enforce when buyingPower is unknown (<=0)", () => {
    const decision = evaluateTradeProposal(buy(8000), { ...baseCtx, portfolio: { ...portfolio, buyingPower: 0 }, estimatedNotional: 8000 });
    expect(decision.reasons.some((r) => r.includes("buying power"))).toBe(false);
  });

  it("never blocks a closing sell on buying power", () => {
    const decision = evaluateTradeProposal(
      { symbol: "AAPL", side: "sell", type: "market", quantity: 5, timeInForce: "gfd", marketHours: "regular_hours", rationale: "exit", tradeThesisTag: "Risk-Exit", entryMarketRegime: "test" },
      { ...baseCtx, portfolio: { ...portfolio, buyingPower: 1 }, estimatedNotional: 1000 }
    );
    expect(decision.reasons.some((r) => r.includes("buying power"))).toBe(false);
  });
});
