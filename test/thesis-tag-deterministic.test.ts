// P0-2 (2026-09-27) — deterministic thesis-tag assignment.
//
// The problem this pins: `tradeThesisTag` used to be chosen by the model, while the deterministic
// sizing multiplier, the negative-expectancy skip, and the thesis scorecards all keyed on it. So a
// model could escape a penalty by relabeling, and no "P&L by thesis" number was falsifiable because
// the label and the outcome were not independent.
//
// The fix's safety rests on THREE properties, and each has tests here:
//   1. ABSTENTION. When no rule fires, or the leader's margin is too small, the scorer returns null
//      and the model's tag stands. A plausible-looking guess is worse than no answer.
//   2. NO FABRICATION. Three playbook tags (Mean-Reversion, Defensive-Rotation, Analyst-Revision)
//      cannot be derived from evidence the scan computes, so the scorer must never emit them. A
//      regression that let them through would quietly redefine what those tags MEAN.
//   3. OPENINGS ONLY. Sells keep today's behaviour exactly, which is what protects the existing
//      Risk-Exit de-risking path.
//
// Pure-function tests (no DB, no network, no LLM) plus the tunables, which are env-overridable so the
// owner can calibrate against realized performance without shipping new constants.

import { afterEach, describe, expect, it } from "vitest";
import {
  assignDeterministicThesisTag,
  shouldScoreThesisTagForSide,
  THESIS_PLAYBOOK
} from "../src/lib/strategy-prompts";

const TUNABLE_ENV_KEYS = [
  "THESIS_TAG_MARGIN",
  "THESIS_TAG_NEUTRALFLOOR",
  "THESIS_TAG_SECTORRELSTRENGTHPCT",
  "THESIS_TAG_SHORTFLOATPCT",
  "THESIS_TAG_INSIDERSENTIMENT",
  "THESIS_TAG_EARNINGSWINDOWDAYS"
] as const;

afterEach(() => {
  for (const key of TUNABLE_ENV_KEYS) delete process.env[key];
});

/** A factor breakdown whose `dominant` factor is high and every other factor sits at neutral. */
const breakdown = (dominant: string, value: number, rest = 45) => {
  const all: Record<string, number> = {
    liquidity: rest,
    momentum: rest,
    value: rest,
    quality: rest,
    volatility: rest,
    sentiment: rest,
    positioning: rest,
    diversification: rest
  };
  all[dominant] = value;
  return { ...all, weightedTotal: 50 };
};

describe("assignDeterministicThesisTag — factor-mapped tags", () => {
  it("a dominant momentum factor assigns Momentum-Breakout", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("momentum", 88) });
    expect(r.tag).toBe("Momentum-Breakout");
    expect(r.margin).toBeGreaterThanOrEqual(8);
    expect(r.reason).toContain("momentum factor");
  });

  it("a dominant value factor assigns Value-Quality", () => {
    expect(assignDeterministicThesisTag({ factorBreakdown: breakdown("value", 90) }).tag).toBe("Value-Quality");
  });

  it("a dominant quality factor also assigns Value-Quality (the playbook guide names both)", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("quality", 84) });
    expect(r.tag).toBe("Value-Quality");
    expect(r.reason).toContain("quality factor");
  });

  it("a real playbook tag is always returned — never a tag outside the playbook", () => {
    for (const dominant of ["momentum", "value", "quality", "positioning", "volatility", "liquidity"]) {
      const r = assignDeterministicThesisTag({ factorBreakdown: breakdown(dominant, 95) });
      if (r.tag) expect(THESIS_PLAYBOOK as readonly string[]).toContain(r.tag);
    }
  });
});

describe("assignDeterministicThesisTag — purpose-built non-factor signals", () => {
  it("a near-term scheduled earnings date assigns Earnings-Catalyst", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), daysToEarnings: 1 });
    expect(r.tag).toBe("Earnings-Catalyst");
    expect(r.reason).toContain("earnings");
  });

  it("an earnings date OUTSIDE the window does not assign Earnings-Catalyst", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), daysToEarnings: 21 });
    expect(r.tag).toBeNull();
    expect(r.reason).toMatch(/no deterministic rule|below the/);
  });

  it("squeeze-level short interest assigns Short-Squeeze-Risk at the codebase's own threshold", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), shortPercentOfFloat: 22 });
    expect(r.tag).toBe("Short-Squeeze-Risk");
    expect(r.reason).toContain("short interest");
  });

  it("ordinary short interest does NOT assign Short-Squeeze-Risk", () => {
    expect(assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), shortPercentOfFloat: 4 }).tag).toBeNull();
  });

  it("outperformance versus its own sector assigns Sector-Relative-Strength", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), sectorRelStrength: 2.4 });
    expect(r.tag).toBe("Sector-Relative-Strength");
    expect(r.reason).toContain("sector");
  });

  it("underperformance versus its sector does not assign Sector-Relative-Strength", () => {
    expect(assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), sectorRelStrength: -1.1 }).tag).toBeNull();
  });

  it("Insider-Accumulation needs insider evidence LEADING — congress leadership does not qualify", () => {
    // Positioning dominant + insider buy share high, congress not leading.
    const insiderLeads = assignDeterministicThesisTag({
      factorBreakdown: breakdown("positioning", 82),
      insiderSentiment: 78,
      senateTrades: 0
    });
    expect(insiderLeads.tag).toBe("Insider-Accumulation");
    expect(insiderLeads.reason).toContain("insider buy share");

    // Same positioning factor, but congress is the one leading: the `positioning` factor BLENDS
    // congress + insider + short interest (see positioningScore in market.ts), so the factor alone
    // cannot say which of the two playbook tags it represents — hence the raw-field split.
    const congressLeads = assignDeterministicThesisTag({
      factorBreakdown: breakdown("positioning", 82),
      insiderSentiment: 52,
      senateTrades: 6
    });
    expect(congressLeads.tag).not.toBe("Insider-Accumulation");
  });
});

describe("assignDeterministicThesisTag — abstains rather than guesses", () => {
  it("no factor breakdown and no signals → abstain with a stated reason", () => {
    const r = assignDeterministicThesisTag({});
    expect(r.tag).toBeNull();
    expect(r.rule).toBeNull();
    expect(r.reason).toContain("no deterministic rule matched");
  });

  it("a weak best signal (below the neutral floor) → abstain", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("momentum", 52) });
    expect(r.tag).toBeNull();
    expect(r.reason).toContain("neutral floor");
  });

  it("two signals too close to call → abstain, and SAY which two", () => {
    // momentum 58 and value 56: both clear the floor, neither leads by the required margin.
    const both = { liquidity: 45, momentum: 58, value: 56, quality: 45, volatility: 45, sentiment: 45, positioning: 45, diversification: 45, weightedTotal: 50 };
    const r = assignDeterministicThesisTag({ factorBreakdown: both });
    expect(r.tag).toBeNull();
    expect(r.reason).toMatch(/abstained/);
    expect(r.runnerUp).not.toBeNull();
  });

  it("the abstention reason is diagnostic, never silent", () => {
    for (const evidence of [{}, { factorBreakdown: breakdown("momentum", 52) }]) {
      const r = assignDeterministicThesisTag(evidence);
      if (r.tag === null) expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("assignDeterministicThesisTag — the three tags that must NEVER be invented", () => {
  // These cannot be derived from what the scan computes. Mean-Reversion needs "extended from a
  // reference", Defensive-Rotation needs a definition of "defensive", and Analyst-Revision needs a
  // revision DELTA where we only have a consensus LEVEL. A rule that confidently emitted any of them
  // would redefine the tag's meaning for every performance number keyed on it.
  const NEVER_ASSIGNED = ["Mean-Reversion", "Defensive-Rotation", "Analyst-Revision"] as const;

  it("none of them is ever produced, across a spread of evidence", () => {
    const cases = [
      { factorBreakdown: breakdown("volatility", 95) },
      { factorBreakdown: breakdown("volatility", 95), beta: 0.4, daysToEarnings: 0 },
      { factorBreakdown: breakdown("momentum", 95), analystScore: 95 },
      { factorBreakdown: breakdown("liquidity", 95), analystScore: 99, sectorRelStrength: 5 },
      { factorBreakdown: breakdown("volatility", 92), analystScore: 90, shortPercentOfFloat: 40 }
    ];
    for (const evidence of cases) {
      const r = assignDeterministicThesisTag(evidence);
      if (r.tag) expect(NEVER_ASSIGNED).not.toContain(r.tag as never);
    }
  });

  it("a high analyst score alone does not produce Analyst-Revision (a level is not a revision)", () => {
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), analystScore: 99 });
    expect(r.tag).not.toBe("Analyst-Revision");
  });
});

describe("assignDeterministicThesisTag — tunables are env-overridable and fail safe", () => {
  it("raising the required margin turns a previously-assigned tag into an abstention", () => {
    const evidence = { factorBreakdown: breakdown("momentum", 62) };
    expect(assignDeterministicThesisTag(evidence).tag).toBe("Momentum-Breakout");
    process.env.THESIS_TAG_MARGIN = "40";
    const widened = assignDeterministicThesisTag(evidence);
    expect(widened.tag).toBeNull();
    expect(widened.reason).toContain("under the 40 margin");
  });

  it("a malformed tunable value falls back to the default instead of poisoning the scorer", () => {
    process.env.THESIS_TAG_MARGIN = "not-a-number";
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("momentum", 88) });
    expect(r.tag).toBe("Momentum-Breakout"); // default margin still applies
  });

  it("the short-interest threshold is configurable, so the owner can calibrate it", () => {
    process.env.THESIS_TAG_SHORTFLOATPCT = "8";
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), shortPercentOfFloat: 9 });
    expect(r.tag).toBe("Short-Squeeze-Risk");
    expect(r.reason).toContain("8%");
  });
});

describe("shouldScoreThesisTagForSide — openings only", () => {
  it("entries are scored", () => {
    expect(shouldScoreThesisTagForSide("buy")).toBe(true);
    expect(shouldScoreThesisTagForSide("short")).toBe(true);
  });

  it("exits are NOT scored, which is what leaves the Risk-Exit de-risking path untouched", () => {
    expect(shouldScoreThesisTagForSide("sell")).toBe(false);
    expect(shouldScoreThesisTagForSide("cover")).toBe(false);
  });

  it("a missing or unexpected side is not scored (fail-safe toward today's behaviour)", () => {
    expect(shouldScoreThesisTagForSide(undefined)).toBe(false);
    expect(shouldScoreThesisTagForSide(null)).toBe(false);
    expect(shouldScoreThesisTagForSide("")).toBe(false);
    expect(shouldScoreThesisTagForSide("something-else")).toBe(false);
  });
});
