import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { STRATEGY_DATASET } from "../scripts/eval/strategy-dataset";
import {
  scoreStrategyCase,
  scoreNoOffUniverse,
  scoreShortsHaveStop,
  scoreBuysMatchEvidence,
  type ProposalFixture
} from "../scripts/eval/strategy-score";

// Gate the strategy offline-eval scorers (Chat A item 2). Proves (a) the shipped dataset all passes,
// (b) each scorer actually FAILS a violating fixture (has teeth), and (c) the versioned prompts build.

beforeAll(() => {
  // strategy-prompts -> policy may transitively touch the db barrel; point it at a throwaway file.
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-eval-${randomUUID()}.db`)}`;
});

describe("strategy offline eval — dataset all-pass (Chat A item 2)", () => {
  it("every shipped dataset case passes all three invariants", () => {
    for (const c of STRATEGY_DATASET) {
      const r = scoreStrategyCase(c);
      expect(r.pass, `${c.id}: ${r.scorers.filter((s) => !s.result.pass).map((s) => `${s.name} — ${s.result.detail}`).join("; ")}`).toBe(true);
      expect(r.score).toBe(1);
    }
  });
});

describe("strategy offline eval — scorers have teeth", () => {
  const universe = ["AAPL", "MSFT"];

  it("scorer 1 fails an OFF-UNIVERSE opening (but exempts an off-universe exit)", () => {
    const offUniverseBuy: ProposalFixture[] = [{ symbol: "ZZZZ", side: "buy", type: "market" }];
    expect(scoreNoOffUniverse(offUniverseBuy, universe).pass).toBe(false);
    // A sell/exit of an off-universe held name is exempt.
    const offUniverseSell: ProposalFixture[] = [{ symbol: "ZZZZ", side: "sell", type: "market" }];
    expect(scoreNoOffUniverse(offUniverseSell, universe).pass).toBe(true);
  });

  it("scorer 2 fails a stopless short and a short emitted while shorting is disabled", () => {
    const stoplessShort: ProposalFixture[] = [{ symbol: "AAPL", side: "short", type: "market" }];
    expect(scoreShortsHaveStop(stoplessShort, true).pass).toBe(false);
    // A short entered AS a stop order but with no protective stopPrice/bracketStopLoss is still
    // stopless — the entry order's own type is not the mandatory post-entry stop-loss.
    const stopOrderEntryNoStop: ProposalFixture[] = [{ symbol: "AAPL", side: "short", type: "stop_market" }];
    expect(scoreShortsHaveStop(stopOrderEntryNoStop, true).pass).toBe(false);
    // A malformed non-positive stop (0 / negative) is not a real protective stop.
    expect(scoreShortsHaveStop([{ symbol: "AAPL", side: "short", type: "market", stopPrice: 0 }], true).pass).toBe(false);
    expect(scoreShortsHaveStop([{ symbol: "AAPL", side: "short", type: "market", bracketStopLoss: -5 }], true).pass).toBe(false);
    const shortWithStop: ProposalFixture[] = [{ symbol: "AAPL", side: "short", type: "stop_market", stopPrice: 100 }];
    expect(scoreShortsHaveStop(shortWithStop, true).pass).toBe(true);
    // Short emitted while disabled fails even with a stop.
    expect(scoreShortsHaveStop(shortWithStop, false).pass).toBe(false);
  });

  it("scorer 3 fails buys that contradict structured evidence", () => {
    const buy: ProposalFixture[] = [{ symbol: "AAPL", side: "buy", type: "market" }];
    // Cash-burning buy (fcfYield below floor).
    expect(scoreBuysMatchEvidence(buy, { AAPL: { fcfYield: -2 } }, { fcfYieldFloorPct: 0 }, "Neutral").pass).toBe(false);
    // Over-levered buy (debt/equity above ceiling).
    expect(scoreBuysMatchEvidence(buy, { AAPL: { debtToEquity: 5 } }, { debtToEquityCeiling: 3 }, "Neutral").pass).toBe(false);
    // Below-median buy in a risk-off regime.
    expect(scoreBuysMatchEvidence(buy, { AAPL: { score: 40, medianScore: 60 } }, {}, "Risk-Off (High Volatility)").pass).toBe(false);
    // A supported buy passes.
    expect(scoreBuysMatchEvidence(buy, { AAPL: { fcfYield: 4, debtToEquity: 0.8, score: 80, medianScore: 60 } }, { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 }, "Neutral").pass).toBe(true);
  });
});

describe("strategy offline eval — versioned prompts build (Chat A item 2)", () => {
  it("buildBullSystem/buildRedTeamReviewSystem reflect their flags and STRATEGY_PROMPT_VERSION is set", async () => {
    const { buildBullSystem, buildRedTeamReviewSystem, STRATEGY_PROMPT_VERSION } = await import("../src/lib/strategy-prompts");
    expect(typeof STRATEGY_PROMPT_VERSION).toBe("string");
    expect(STRATEGY_PROMPT_VERSION.length).toBeGreaterThan(0);

    const base = { executionMode: "broker/paper", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: false, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    expect(buildBullSystem({ ...base, shortAllowed: false })).toContain("SHORT SELLING IS DISABLED");
    expect(buildBullSystem({ ...base, shortAllowed: true })).toContain("SHORT SELLING IS ENABLED");
    // The single Red Team reviewer replaced the in-flow Bear (2026-07-07): direction-aware framing
    // instead of a short-selling flag — a BUY gets the BEAR framing, a SHORT the skeptical-BULL one.
    expect(buildRedTeamReviewSystem({ side: "buy", symbol: "AAPL" })).toContain("You are the BEAR");
    expect(buildRedTeamReviewSystem({ side: "short", symbol: "AAPL" })).toContain("skeptical BULL");
    for (const side of ["buy", "short"] as const) {
      const prompt = buildRedTeamReviewSystem({ side, symbol: "AAPL" });
      expect(prompt).toContain('"approve-at-half"');
      expect(prompt).toContain("Red Team Risk Agent");
    }
  });

  it("wash-sale prompt guidance: IRA-disregard PERMITS locked rebuys, taking precedence over washSaleHandling", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const taxBase = { shortAllowed: false, executionMode: "test/local", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: true, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    // "block" (an explicit stricter opt-in, no longer the default): absolute prohibition.
    expect(buildBullSystem({ ...taxBase, washSaleHandling: "block" })).toContain("NEVER propose a BUY of any symbol in `washSaleLockedSymbols`");
    // IRA-disregard PERMITS the rebuy and takes precedence even when washSaleHandling is "block".
    const iraPrompt = buildBullSystem({ ...taxBase, washSaleHandling: "block", iraWashSaleDisregard: true });
    expect(iraPrompt).toContain("does not constrain this IRA");
    expect(iraPrompt).toContain("the owner chose Ignore");
    expect(iraPrompt).not.toContain("You MAY propose a BUY of a symbol in `washSaleLockedSymbols`");
    expect(iraPrompt).not.toContain("technically-forfeited");
    expect(iraPrompt).not.toContain("NEVER propose a BUY of any symbol in `washSaleLockedSymbols`");
    expect(iraPrompt).toContain("Do NOT sell to harvest a tax loss");
    expect(iraPrompt).not.toContain("you trade in a taxable account");
    expect(iraPrompt).not.toContain("harvestableLosses");
  });

  it("IRA tax context never instructs tax-loss harvesting even without disregard", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const taxBase = { shortAllowed: false, executionMode: "test/local", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: true, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    const iraPrompt = buildBullSystem({ ...taxBase, washSaleHandling: "auto", isIraAccount: true });
    expect(iraPrompt).toContain("this is an IRA");
    expect(iraPrompt).toContain("Do NOT sell to harvest a tax loss");
    expect(iraPrompt).toContain("IRA wash-sale handling is Ignore");
    expect(iraPrompt).not.toContain("you trade in a taxable account");
    expect(iraPrompt).not.toContain("harvestableLosses");
    expect(iraPrompt).not.toContain("positionsNearLongTerm");
  });

  it("IRA Auto prompt weighs lockouts; Block forbids them", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const taxBase = { shortAllowed: false, executionMode: "test/local", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: true, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    const autoPrompt = buildBullSystem({ ...taxBase, isIraAccount: true, iraWashSaleHandling: "auto" });
    expect(autoPrompt).toContain("IRA wash-sale handling is Auto");
    expect(autoPrompt).toContain("YOUR judgment call");
    expect(autoPrompt).toContain("`taxContext.washSaleRebuyCosts`");
    expect(autoPrompt).toContain("Do NOT sell to harvest a tax loss");
    const blockPrompt = buildBullSystem({ ...taxBase, isIraAccount: true, iraWashSaleHandling: "block" });
    expect(blockPrompt).toContain("IRA wash-sale handling is Block");
    expect(blockPrompt).toContain("NEVER propose a BUY of a symbol in `washSaleLockedSymbols`");
    expect(blockPrompt).not.toContain("YOUR judgment call");
  });

  it("taxable tax context still offers harvestableLosses", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const taxBase = { shortAllowed: false, executionMode: "test/local", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: true, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    const taxablePrompt = buildBullSystem({ ...taxBase, washSaleHandling: "auto" });
    expect(taxablePrompt).toContain("you trade in a taxable account");
    expect(taxablePrompt).toContain("harvestableLosses");
    expect(taxablePrompt).toContain("positionsNearLongTerm");
    expect(taxablePrompt).not.toContain("Do NOT sell to harvest a tax loss");
  });

  it("wash-sale prompt guidance: 'auto' (the default) tells the model the buy always proceeds and to weigh the priced tax cost itself", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const taxBase = { shortAllowed: false, executionMode: "test/local", executionModeClarification: "x", strategyPrompt: "s", hasTaxContext: true, holdingHorizon: "swing", maxSymbolExposurePct: 25, stopLossPct: 8, takeProfitPct: 20 };
    const autoPrompt = buildBullSystem({ ...taxBase, washSaleHandling: "auto" });
    // Owner decision 2026-07-03: no deterministic edge-vs-cost threshold language remains — the
    // model is told this is its own judgment call, referencing the priced cost in taxContext.
    expect(autoPrompt).not.toContain("ONLY when its expected edge is at least");
    expect(autoPrompt).toContain("`taxContext.washSaleRebuyCosts`");
    expect(autoPrompt).toContain("YOUR judgment call");
    expect(autoPrompt).toContain("estimatedTaxCostUsd");
    expect(autoPrompt).not.toContain("NEVER propose a BUY of any symbol in `washSaleLockedSymbols`");
  });
});
