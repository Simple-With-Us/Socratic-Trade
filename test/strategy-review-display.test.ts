import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { buildStrategyReviewDisplay } from "../src/lib/strategy-review-display";
import type { StrategyTuningProposal } from "../src/lib/types";

describe("buildStrategyReviewDisplay", () => {
  it("shows the exact prompt replacement and before/after setting values", () => {
    const proposal: StrategyTuningProposal = {
      summary: "Tighten risk.",
      rationale: "Small sample.",
      marketContext: "Neutral.",
      performanceReadout: "No closed lots.",
      generatedBy: "llm",
      confidenceScore: 45,
      cautions: [],
      proposedPatch: {
        prompt: "NEW PROMPT\nKeep orders small.",
        scoringWeights: {
          momentum: 1.05
        },
        policy: {
          maxOrderNotional: 250,
          maxDailyNotional: 500,
          maxSymbolExposurePct: 10,
          runCadenceMinutes: 90,
          strategyAuthority: "decide",
          runDuringExtendedHours: false,
          riskRules: {
            stopLossPct: 5,
            takeProfitPct: 15,
            trailingStopPct: 5
          }
        }
      }
    };

    const display = buildStrategyReviewDisplay(proposal, {
      policy: {
        ...DEFAULT_POLICY,
        maxOrderNotional: 100,
        maxDailyNotional: 300,
        maxSymbolExposurePct: 25,
        runCadenceMinutes: 60,
        strategyAuthority: "propose",
        runDuringExtendedHours: true,
        scoringWeights: { ...DEFAULT_POLICY.scoringWeights, momentum: 0.95 },
        riskRules: {
          ...DEFAULT_POLICY.riskRules,
          stopLossPct: 8,
          takeProfitPct: 20,
          trailingStopPct: undefined
        }
      },
      strategyPrompt: "OLD PROMPT"
    });

    expect(display.promptChange).toEqual({
      current: "OLD PROMPT",
      proposed: "NEW PROMPT\nKeep orders small.",
      changed: true
    });
    expect(display.studioChanges).toContainEqual(
      expect.objectContaining({
        label: "Momentum weight",
        current: "0.95",
        proposed: "1.05",
        location: "Scoring Weights"
      })
    );
    expect(display.riskChanges).toContainEqual(
      expect.objectContaining({
        label: "Max order notional",
        current: "$100",
        proposed: "$250",
        location: "Key Parameters"
      })
    );
    expect(display.riskChanges).toContainEqual(
      expect.objectContaining({
        label: "Run cadence",
        current: "60 min",
        proposed: "90 min"
      })
    );
    expect(display.riskChanges).toContainEqual(
      expect.objectContaining({
        label: "Strategy authority",
        current: "Propose (manual approval)",
        proposed: "Decide (auto-execute)"
      })
    );
    expect(display.riskChanges).toContainEqual(
      expect.objectContaining({
        label: "Trailing stop",
        current: "Not set",
        proposed: "5%"
      })
    );
    expect(display.hasEffectiveChanges).toBe(true);
  });

  it("does not invent scoring-weight rows when the tuner returns nulls stripped from the patch", () => {
    const proposal: StrategyTuningProposal = {
      summary: "No weight changes.",
      rationale: "Closed-lot sample is too small.",
      marketContext: "Neutral.",
      performanceReadout: "No closed lots.",
      generatedBy: "llm",
      confidenceScore: 45,
      cautions: [],
      proposedPatch: {
        prompt: "PROMPT ONLY"
      }
    };

    const display = buildStrategyReviewDisplay(proposal, {
      policy: DEFAULT_POLICY,
      strategyPrompt: "CURRENT"
    });

    expect(display.promptChange?.proposed).toBe("PROMPT ONLY");
    expect(display.studioChanges).toEqual([]);
    expect(display.riskChanges).toEqual([]);
    expect(display.hasEffectiveChanges).toBe(true);
  });
});
