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
//   2. NO FABRICATION. Every tag the scorer DOES emit is backed by evidence the scan computes, and
//      the one tag that no evidence could support (`Analyst-Revision`) is RETIRED from the
//      playbook rather than left for the model — see the retirement block at the bottom, and
//      test/thesis-tag-retired-tags.test.ts for the consumer side.
//   3. OPENINGS ONLY. Sells keep today's behaviour exactly, which is what protects the existing
//      Risk-Exit de-risking path.
//
// Pure-function tests (no DB, no network, no LLM) plus the tunables, which are env-overridable so the
// owner can calibrate against realized performance without shipping new constants.

import { afterEach, describe, expect, it } from "vitest";
import {
  assignDeterministicThesisTag,
  isSelectableThesisTag,
  RETIRED_THESIS_TAGS,
  shouldScoreThesisTagForSide,
  THESIS_PLAYBOOK
} from "../src/lib/strategy-prompts";
import {
  computeTechnicals,
  TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD
} from "../src/lib/indicators";
import type { OHLCBar } from "../src/lib/indicators";

const TUNABLE_ENV_KEYS = [
  "THESIS_TAG_MARGIN",
  "THESIS_TAG_NEUTRALFLOOR",
  "THESIS_TAG_SECTORRELSTRENGTHPCT",
  "THESIS_TAG_SHORTFLOATPCT",
  "THESIS_TAG_INSIDERSENTIMENT",
  "THESIS_TAG_EARNINGSWINDOWDAYS",
  "THESIS_TAG_DEFENSIVEBETA",
  "THESIS_TAG_MEANREVERSION52WPCT"
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

describe("assignDeterministicThesisTag — Defensive-Rotation", () => {
  // `volatilityScore` (src/lib/market.ts) is already a defensiveness score: it dings beta > 1.1 and
  // LIFTS beta < 0.8. So this rule is the app's own beta ladder used as a gate, not a new
  // definition of "defensive" invented for the feature.
  it("a low-beta name whose volatility factor leads assigns Defensive-Rotation", () => {
    const r = assignDeterministicThesisTag({
      factorBreakdown: breakdown("volatility", 92, 45),
      beta: 0.55
    });
    expect(r.tag).toBe("Defensive-Rotation");
    expect(r.reason).toContain("beta 0.55");
    expect(r.reason).toContain("volatility factor");
  });

  it("a high-beta name does NOT get the tag however steady its tape looks", () => {
    // The gate is beta, so a quiet but high-beta name stays unassigned rather than being handed the
    // tag the volatility factor alone would have scored.
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("volatility", 95, 45), beta: 1.4 });
    expect(r.tag).not.toBe("Defensive-Rotation");
  });

  it("NO beta means NO tag — absence must not read as defensive", () => {
    // `volatilityScore` is 100 − |intraday move|, so an unmeasured name (pre-market scan, stalled
    // feed, a symbol the provider did not return) scores the maximum on a quiet tape. Without the
    // beta gate every unmeasured name would be labelled Defensive-Rotation.
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("volatility", 100, 45) });
    expect(r.tag).toBeNull();
    expect(r.scores["Defensive-Rotation"]).toBeUndefined();
  });

  it("a non-positive beta is treated as absent, not as maximally defensive", () => {
    expect(assignDeterministicThesisTag({ factorBreakdown: breakdown("volatility", 95, 45), beta: 0 }).tag).not.toBe(
      "Defensive-Rotation"
    );
    expect(assignDeterministicThesisTag({ factorBreakdown: breakdown("volatility", 95, 45), beta: -1 }).tag).not.toBe(
      "Defensive-Rotation"
    );
  });

  it("it competes on the same scale as every other rule (floor + margin both apply)", () => {
    // A defensive name that is ALSO a strong value play is not a rotation call — Value-Quality
    // wins, and when the two are close the scorer abstains. Same discipline as the original six.
    const clearValue = { ...breakdown("value", 88, 45), volatility: 70 };
    expect(assignDeterministicThesisTag({ factorBreakdown: clearValue, beta: 0.5 }).tag).toBe("Value-Quality");

    const tooClose = { ...breakdown("value", 88, 45), volatility: 84 };
    const r = assignDeterministicThesisTag({ factorBreakdown: tooClose, beta: 0.5 });
    expect(r.tag).toBeNull();
    expect(r.runnerUp).toBe("Defensive-Rotation");
  });

  it("the beta threshold is env-tunable so the owner can recalibrate without a deploy", () => {
    process.env.THESIS_TAG_DEFENSIVEBETA = "1";
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("volatility", 92, 45), beta: 0.95 });
    expect(r.tag).toBe("Defensive-Rotation");
    expect(r.reason).toContain("1 defensive step");
  });
});

describe("assignDeterministicThesisTag — Mean-Reversion", () => {
  const reversion = (over: Partial<Parameters<typeof assignDeterministicThesisTag>[0]> = {}) => ({
    factorBreakdown: breakdown("liquidity", 45),
    technicalSignals: [TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD],
    technicalDirection: "neutral",
    pricePosition52w: 8,
    ...over
  });

  it("an oversold reclaim that is no longer read as bearish, low in the 52-week band, assigns Mean-Reversion", () => {
    const r = assignDeterministicThesisTag(reversion());
    expect(r.tag).toBe("Mean-Reversion");
    expect(r.reason).toContain("reclaimed oversold");
  });

  it("a deeper extension scores higher, capped like the other event rules", () => {
    const deep = assignDeterministicThesisTag(reversion({ pricePosition52w: 0 }));
    const shallow = assignDeterministicThesisTag(reversion({ pricePosition52w: 28 }));
    expect(deep.scores["Mean-Reversion"]).toBe(80);
    expect(shallow.scores["Mean-Reversion"]).toBe(62);
    expect(deep.scores["Mean-Reversion"]!).toBeGreaterThan(shallow.scores["Mean-Reversion"]!);
  });

  it("does NOT fire without the reclaim event (a weak name low in its band is not a reversion)", () => {
    const r = assignDeterministicThesisTag(reversion({ technicalSignals: ["sma50_200_death_cross"] }));
    expect(r.tag).toBeNull();
    expect(r.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("does NOT fire on the reclaim alone — a BEARISH read is a falling knife, not a reversion", () => {
    // The reclaim event is pushed on the RSI cross by itself, WITHOUT the `!downTrend` guard the
    // level nudge uses (src/lib/indicators.ts), so it also fires inside a persistent downtrend.
    // Measured against the real producer, that case scores 36 → "bearish"; the accepted cases
    // score 56 ("neutral") and 67 ("bullish"). This is the separation, and it is why the gate is
    // "no longer bearish" rather than the "bearish" string alone.
    const knife = assignDeterministicThesisTag(reversion({ technicalDirection: "bearish" }));
    expect(knife.tag).toBeNull();
    expect(knife.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("an UNKNOWN technical direction abstains rather than being read as non-bearish", () => {
    // Absence must not clear a gate. An undefined direction is "we do not know", not "fine".
    const unknown = assignDeterministicThesisTag(reversion({ technicalDirection: undefined }));
    expect(unknown.tag).toBeNull();
    expect(unknown.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("does NOT fire on an oversold reclaim high in the 52-week band (that is a pullback, i.e. momentum)", () => {
    const pullback = assignDeterministicThesisTag(reversion({ pricePosition52w: 71 }));
    expect(pullback.tag).toBeNull();
    expect(pullback.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("an unknown 52-week position abstains rather than assuming extension", () => {
    const noBand = assignDeterministicThesisTag(reversion({ pricePosition52w: undefined }));
    expect(noBand.tag).toBeNull();
    expect(noBand.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("the band threshold is env-tunable", () => {
    process.env.THESIS_TAG_MEANREVERSION52WPCT = "80";
    const r = assignDeterministicThesisTag(reversion({ pricePosition52w: 71 }));
    expect(r.tag).toBe("Mean-Reversion");
  });
});

describe("Mean-Reversion reads the REAL producer output, not a hand-written name", () => {
  // A bar series that drifts down long enough for RSI-14 to reach oversold, then bounces. These are
  // the strongest form of the test: they prove the scorer's gate and `computeTechnicals` agree, so a
  // rename on either side fails here instead of silently no-op'ing in production — and they pin the
  // falling-knife / reversion separation against the numbers the producer ACTUALLY emits rather than
  // against strings the test made up.
  const slideThenBounce = (dropPerBar: number, declineBars: number, bouncePct: number): OHLCBar[] => {
    const bars: OHLCBar[] = [];
    for (let i = 0; i < 220; i++) bars.push({ time: i, close: 100 + (i % 3) * 0.1, high: 101, low: 99 });
    for (let i = 0; i < declineBars; i++) {
      const close = 100 - i * dropPerBar;
      bars.push({ time: 220 + i, close, high: 100, low: close - 0.2 });
    }
    const last = bars[bars.length - 1]!.close;
    bars.push({
      time: 400,
      close: last * (1 + bouncePct / 100),
      high: last * (1 + bouncePct / 100) + 0.1,
      low: last * 0.995
    });
    return bars;
  };

  const score = (read: ReturnType<typeof computeTechnicals>) =>
    assignDeterministicThesisTag({
      factorBreakdown: breakdown("liquidity", 45),
      technicalSignals: read?.signals,
      technicalDirection: read?.direction,
      pricePosition52w: 12
    });

  it("a bounce that turns the MACD produces the reclaim event and the tag", () => {
    const read = computeTechnicals(slideThenBounce(0.3, 20, 4));
    expect(read?.signals).toContain(TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD);
    expect(read?.direction).toBe("neutral");
    expect(score(read).tag).toBe("Mean-Reversion");
  });

  it("a stronger bounce reads bullish and still produces the tag", () => {
    const read = computeTechnicals(slideThenBounce(0.3, 25, 6));
    expect(read?.direction).toBe("bullish");
    expect(score(read).tag).toBe("Mean-Reversion");
  });

  it("a weak bounce inside a downtrend MA stack reclaims oversold but is REJECTED as a falling knife", () => {
    // The regression this whole second condition exists for: same reclaim event, same 52-week
    // position, and without the direction gate the scorer would label a falling knife Mean-Reversion.
    const read = computeTechnicals(slideThenBounce(0.3, 20, 2));
    expect(read?.signals).toContain(TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD);
    expect(read?.direction).toBe("bearish");
    const r = score(read);
    expect(r.tag).toBeNull();
    expect(r.scores["Mean-Reversion"]).toBeUndefined();
  });

  it("a flat series produces no reclaim event, so nothing is fabricated from it", () => {
    const bars: OHLCBar[] = [];
    for (let i = 0; i < 200; i++) bars.push({ time: i, close: 100, high: 101, low: 99 });
    expect(computeTechnicals(bars)?.signals ?? []).not.toContain(TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD);
  });
});

describe("every tag the scorer can return is in the playbook, and no retired tag ever is", () => {
  it("no retired tag is ever produced, across a spread of evidence", () => {
    const cases = [
      { factorBreakdown: breakdown("volatility", 95), analystScore: 99, beta: 0.4 },
      { factorBreakdown: breakdown("volatility", 95), beta: 0.4, daysToEarnings: 0 },
      { factorBreakdown: breakdown("momentum", 95), analystScore: 95 },
      { factorBreakdown: breakdown("liquidity", 95), analystScore: 99, sectorRelStrength: 5 },
      { factorBreakdown: breakdown("volatility", 92), analystScore: 90, shortPercentOfFloat: 40, beta: 0.3 }
    ];
    for (const evidence of cases) {
      const r = assignDeterministicThesisTag(evidence);
      if (r.tag) {
        expect(Object.keys(RETIRED_THESIS_TAGS)).not.toContain(r.tag);
        expect(isSelectableThesisTag(r.tag)).toBe(true);
      }
    }
  });

  it("a high analyst score alone still does not produce Analyst-Revision — a level is not a revision", () => {
    // `analystScore` is deliberately left OUT of every rule. It is a consensus LEVEL; a revision is
    // a DELTA, and no field in the scan carries one. Pinning this is what stops a future
    // "just use the analyst score" shortcut from quietly redefining the tag.
    const r = assignDeterministicThesisTag({ factorBreakdown: breakdown("liquidity", 45), analystScore: 99 });
    expect(r.tag).not.toBe("Analyst-Revision");
    expect(r.scores["Analyst-Revision"]).toBeUndefined();
  });

  it("every playbook tag except the exit tag has a rule that can produce it", () => {
    // Risk-Exit is the deliberate exception: openings are the only scored side, and the de-risking
    // path assigns it at its own call sites.
    const producible = new Set([
      "Momentum-Breakout",
      "Value-Quality",
      "Earnings-Catalyst",
      "Insider-Accumulation",
      "Short-Squeeze-Risk",
      "Sector-Relative-Strength",
      "Defensive-Rotation",
      "Mean-Reversion"
    ]);
    for (const tag of THESIS_PLAYBOOK) {
      if (tag === "Risk-Exit") continue;
      expect(producible.has(tag)).toBe(true);
    }
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
