import { describe, expect, it } from "vitest";
import { buildBullSystem, buildRedTeamReviewSystem } from "../src/lib/strategy-prompts";

describe("exit-plan expert-panel prompts", () => {
  it("tells Green Team to debate a target and staged exits when they omit one", () => {
    const text = buildBullSystem({
      shortAllowed: false,
      executionMode: "broker/live",
      executionModeClarification: "",
      strategyPrompt: "",
      hasTaxContext: false,
      holdingHorizon: "swing",
      maxSymbolExposurePct: 15,
      stopLossPct: 8,
      takeProfitPct: 20
    });
    expect(text).toContain("EXIT PLAN (expert-panel debate");
    expect(text).toContain("bracketTakeProfit");
    expect(text).toContain("exitPlan");
    expect(text).toContain("PART of the position would exit");
  });

  it("tells Green to treat packed closestHistoricalAnalogs as advisory evidence", () => {
    const text = buildBullSystem({
      shortAllowed: false,
      executionMode: "broker/live",
      executionModeClarification: "",
      strategyPrompt: "",
      hasTaxContext: false,
      holdingHorizon: "swing",
      maxSymbolExposurePct: 15,
      stopLossPct: 8,
      takeProfitPct: 20
    });
    expect(text).toContain("`closestHistoricalAnalogs` (when present in the user message) are packed analog cards");
    expect(text).toContain("Treat them as advisory evidence.");
    expect(text).toContain("Weigh COUNTEREXAMPLE rows as dissent the rationale must address, not as noise.");
    expect(text).toContain("Do not copy size or side from a past analog.");
  });

  it("asks Red Team to review a missing target without inventing an exit objection when one exists", () => {
    const text = buildRedTeamReviewSystem({ side: "buy", symbol: "AAPL" });
    expect(text).toContain("Job 3 — TARGET AND EXIT");
    expect(text).toContain("bracketTakeProfit");
    expect(text).toContain("do not invent an exit objection");
  });
});
