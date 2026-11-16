/**
 * Past-decision case affinity (ST-4539).
 *
 * The issue asked for past-decision cases to be retrieved with "same symbol/strategy/setup
 * weighted". The episodic pass is deliberately cross-symbol (`matchAllSymbols: true`), so these
 * tests pin the weighting that closes that gap — and, just as importantly, pin that it is
 * BOOST-ONLY, RANK-STABLE, NON-DESTRUCTIVE and FAIL-OPEN, because this ranking feeds live trading
 * prompts.
 *
 * Covered here:
 *  1. same-symbol / same-thesis / same-regime / same-sector / same-factor components each contribute;
 *  2. no match => multiplier exactly 1.0, and re-rank returns the input order byte-identical;
 *  3. boost-only — a matched case is lifted, never a cross-symbol analog demoted;
 *  4. rank-stable — a matched case OUTRANKS a higher-ranked unmatched case only in proportion to the
 *     positional base, and a fully-matched case cannot vault past its bound;
 *  5. bounded multiplier (never above CASE_AFFINITY_MAX_MULTIPLIER);
 *  6. fail-open: a throwing chunk, a single-element list and the off-switch all return the input;
 *  7. nothing is ever excluded — output length always equals input length.
 */
import { describe, expect, it } from "vitest";
import {
  applyPastCaseAffinityWeighting,
  caseAffinityContextFromCandidates,
  caseAffinityMultiplier,
  CASE_AFFINITY_MAX_MULTIPLIER,
  CASE_AFFINITY_MIN_MULTIPLIER,
  CASE_AFFINITY_WEIGHTS,
  PAST_DECISION_CASE_AFFINITY_ENV,
  type AffinityChunk,
  type CaseAffinityContext
} from "../src/lib/past-decision-cases";

/** A closed-lot experience case as `buildClosedLotExperienceDocument` actually writes it. */
function experienceCase(input: {
  id: string;
  symbol: string;
  thesis?: string;
  regime?: string;
  sector?: string;
  factors?: Record<string, number>;
  returnPct: number;
}): AffinityChunk & { id: string } {
  // Default factor is deliberately one that does NOT match the shared CONTEXT.dominantFactors
  // ("momentum"). A case built without an explicit `factors` must score as a genuine non-match on
  // the factor dimension, otherwise every "unmatched" fixture silently collects +factor weight and
  // the boost-only / no-match assertions below prove nothing.
  const factorLine = Object.entries(input.factors ?? { quality: 0.8 })
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return {
    id: input.id,
    doc_type: "socratic-decision",
    metadata: {
      symbol: input.symbol,
      ...(input.thesis ? { thesis_tag: input.thesis } : {}),
      ...(input.regime ? { entry_market_regime: input.regime } : {}),
      ...(input.sector ? { sector: input.sector } : {}),
      return_pct: input.returnPct
    },
    text: [
      "Experience memory: closed lot with realized outcome",
      `ticker: ${input.symbol}`,
      `thesis_tag: ${input.thesis ?? "n/a"}`,
      `entry_market_regime: ${input.regime ?? "n/a"}`,
      `sector: ${input.sector ?? "n/a"}`,
      `entry_factor_scores: ${factorLine}`,
      `realized_outcome: return_pct=${input.returnPct}; holding_days=3.0; risk_exit=false`
    ].join("\n")
  };
}

const CONTEXT: CaseAffinityContext = {
  symbols: ["AAPL"],
  thesisTags: ["Momentum-Breakout"],
  regime: "Risk-On Trending",
  sectors: ["Technology"],
  dominantFactors: ["momentum"]
};

describe("caseAffinityMultiplier", () => {
  it("returns exactly 1.0 (not below) when nothing matches", () => {
    const chunk = experienceCase({ id: "x", symbol: "MSFT", thesis: "Mean-Revert", regime: "Choppy", returnPct: -2 });
    expect(caseAffinityMultiplier(chunk, CONTEXT)).toBe(1);
  });

  it("scores each matching dimension independently", () => {
    expect(
      caseAffinityMultiplier(experienceCase({ id: "s", symbol: "AAPL", returnPct: 1 }), CONTEXT)
    ).toBeCloseTo(1 + CASE_AFFINITY_WEIGHTS.symbol, 10);

    const thesis = experienceCase({ id: "t", symbol: "MSFT", thesis: "Momentum-Breakout", returnPct: 1 });
    expect(caseAffinityMultiplier(thesis, CONTEXT)).toBeCloseTo(1 + CASE_AFFINITY_WEIGHTS.thesis, 10);

    const regime = experienceCase({ id: "r", symbol: "MSFT", regime: "Risk-On Trending", returnPct: 1 });
    expect(caseAffinityMultiplier(regime, CONTEXT)).toBeCloseTo(1 + CASE_AFFINITY_WEIGHTS.regime, 10);

    const sector = experienceCase({ id: "c", symbol: "MSFT", sector: "Technology", returnPct: 1 });
    expect(caseAffinityMultiplier(sector, CONTEXT)).toBeCloseTo(1 + CASE_AFFINITY_WEIGHTS.sector, 10);
  });

  it("sums the dimensions additively, and clamps once the sum exceeds the bound", () => {
    // regime + sector + factor = 0.35, under the 0.50 headroom -> plain additive sum.
    const partial = experienceCase({
      id: "partial",
      symbol: "MSFT",
      regime: "Risk-On Trending",
      sector: "Technology",
      factors: { momentum: 0.9 },
      returnPct: 3
    });
    expect(caseAffinityMultiplier(partial, CONTEXT)).toBeCloseTo(
      1 + CASE_AFFINITY_WEIGHTS.regime + CASE_AFFINITY_WEIGHTS.sector + CASE_AFFINITY_WEIGHTS.factor,
      10
    );

    // All five dimensions = 0.90, which OVERSHOOTS the cap, so this asserts the clamp rather than
    // the raw sum: the strongest possible match is worth exactly CASE_AFFINITY_MAX_MULTIPLIER.
    const full = experienceCase({
      id: "full",
      symbol: "AAPL",
      thesis: "Momentum-Breakout",
      regime: "Risk-On Trending",
      sector: "Technology",
      factors: { momentum: 0.9, value: 0.8, quality: 0.2 },
      returnPct: 3
    });
    expect(caseAffinityMultiplier(full, CONTEXT)).toBe(CASE_AFFINITY_MAX_MULTIPLIER);
    expect(1 + Object.values(CASE_AFFINITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeGreaterThan(
      CASE_AFFINITY_MAX_MULTIPLIER
    );
  });

  it("clamps to the bounded maximum instead of running away", () => {
    const chunk = experienceCase({
      id: "x",
      symbol: "AAPL",
      thesis: "Momentum-Breakout",
      regime: "Risk-On Trending",
      sector: "Technology",
      factors: { momentum: 0.9 },
      returnPct: 5
    });
    expect(caseAffinityMultiplier(chunk, CONTEXT)).toBeLessThanOrEqual(CASE_AFFINITY_MAX_MULTIPLIER);
  });

  it("matches symbol case-insensitively and ignores an empty/n/a symbol", () => {
    expect(caseAffinityMultiplier(experienceCase({ id: "a", symbol: "aapl", returnPct: 1 }), CONTEXT)).toBeCloseTo(
      1 + CASE_AFFINITY_WEIGHTS.symbol,
      10
    );
    const nameless: AffinityChunk = { doc_type: "lesson", metadata: { symbol: "n/a" }, text: "ticker: n/a" };
    expect(caseAffinityMultiplier(nameless, CONTEXT)).toBe(1);
  });

  it("falls back to the embedded text when metadata was dropped", () => {
    const chunk: AffinityChunk = {
      doc_type: "socratic-decision",
      text: "Experience memory\nticker: AAPL\nentry_market_regime: Risk-On Trending"
    };
    expect(caseAffinityMultiplier(chunk, CONTEXT)).toBeCloseTo(
      1 + CASE_AFFINITY_WEIGHTS.symbol + CASE_AFFINITY_WEIGHTS.regime,
      10
    );
  });

  it("is inert when the decision context carries no symbols", () => {
    const chunk = experienceCase({ id: "x", symbol: "AAPL", returnPct: 1 });
    expect(caseAffinityMultiplier(chunk, { symbols: [] })).toBe(1);
  });
});

describe("applyPastCaseAffinityWeighting", () => {
  it("lifts a same-symbol prior above a higher-ranked cross-symbol analog", () => {
    const crossSymbol = experienceCase({ id: "cross", symbol: "MSFT", returnPct: 1 });
    const sameSymbol = experienceCase({
      id: "same",
      symbol: "AAPL",
      thesis: "Momentum-Breakout",
      regime: "Risk-On Trending",
      returnPct: -1
    });
    const result = applyPastCaseAffinityWeighting([crossSymbol, sameSymbol], CONTEXT);
    expect(result[0]!.id).toBe("same");
    // Outcome must not matter to the ordering: a same-symbol LOSSER still outranks the
    // cross-symbol winner. Selection of what to show is not a claim about what worked.
    expect(caseAffinityMultiplier(crossSymbol, CONTEXT)).toBe(1);
  });

  it("is boost-only — nothing is dropped, and unmatched cases are never demoted below 1.0", () => {
    const chunks = [
      experienceCase({ id: "a", symbol: "MSFT", returnPct: 1 }),
      experienceCase({ id: "b", symbol: "MSFT", returnPct: 1 }),
      experienceCase({ id: "c", symbol: "AAPL", returnPct: 1 })
    ];
    const result = applyPastCaseAffinityWeighting(chunks, CONTEXT);
    // Nothing is ever excluded: output length always equals input length.
    expect(result).toHaveLength(chunks.length);
    expect(result.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    // The matched case is LIFTED (that is the feature); the unmatched pair keep multiplier 1.0 —
    // never penalized — and keep their relative incoming order with each other.
    expect(result[0]!.id).toBe("c");
    expect(caseAffinityMultiplier(chunks[0]!, CONTEXT)).toBe(CASE_AFFINITY_MIN_MULTIPLIER);
    expect(caseAffinityMultiplier(chunks[1]!, CONTEXT)).toBe(CASE_AFFINITY_MIN_MULTIPLIER);
    expect(result.slice(1).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns the input order byte-identical when nothing matches (rank-stable / neutral prior)", () => {
    const chunks = [
      experienceCase({ id: "a", symbol: "MSFT", returnPct: 1 }),
      experienceCase({ id: "b", symbol: "NVDA", returnPct: 2 }),
      experienceCase({ id: "c", symbol: "TSLA", returnPct: 3 })
    ];
    const result = applyPastCaseAffinityWeighting(chunks, CONTEXT);
    expect(result).toEqual(chunks);
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves a coach note ahead of an equally-matched analog (incoming order breaks ties)", () => {
    const coachNote: AffinityChunk & { id: string } = {
      id: "coach",
      doc_type: "coach-note",
      metadata: { symbol: "AAPL" },
      text: ""
    };
    const analog = experienceCase({ id: "analog", symbol: "AAPL", returnPct: 1 });
    const result = applyPastCaseAffinityWeighting([analog, coachNote], CONTEXT);
    // Equal multipliers => the caller's incoming order is preserved exactly.
    expect(result.map((c) => c.id)).toEqual(["analog", "coach"]);
  });

  it("never exceeds the bound, even when every dimension matches", () => {
    const chunks = Array.from({ length: 6 }, (_, i) =>
      experienceCase({
        id: `all-${i}`,
        symbol: "AAPL",
        thesis: "Momentum-Breakout",
        regime: "Risk-On Trending",
        sector: "Technology",
        factors: { momentum: 0.9 },
        returnPct: 1
      })
    );
    for (const chunk of applyPastCaseAffinityWeighting(chunks, CONTEXT)) {
      expect(caseAffinityMultiplier(chunk, CONTEXT)).toBeLessThanOrEqual(CASE_AFFINITY_MAX_MULTIPLIER);
    }
  });

  it("fails open (never throws) on a hostile chunk and keeps every chunk", () => {
    const hostile = {
      id: "hostile",
      get metadata(): Record<string, unknown> {
        throw new Error("metadata exploded");
      }
    } as unknown as AffinityChunk & { id: string };
    const ok = experienceCase({ id: "ok", symbol: "AAPL", returnPct: 1 });
    const result = applyPastCaseAffinityWeighting([hostile, ok], CONTEXT);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id).sort()).toEqual(["hostile", "ok"]);
  });

  it("is a no-op for a single chunk, an empty list, or a symbol-less context", () => {
    const one = [experienceCase({ id: "only", symbol: "AAPL", returnPct: 1 })];
    expect(applyPastCaseAffinityWeighting(one, CONTEXT)).toEqual(one);
    expect(applyPastCaseAffinityWeighting([], CONTEXT)).toEqual([]);
    const chunks = [experienceCase({ id: "a", symbol: "AAPL", returnPct: 1 })];
    expect(applyPastCaseAffinityWeighting(chunks, { symbols: [] })).toEqual(chunks);
  });

  it("restores incoming order exactly when the off-switch is set", () => {
    const chunks = [
      experienceCase({ id: "a", symbol: "MSFT", returnPct: 1 }),
      experienceCase({ id: "b", symbol: "AAPL", thesis: "Momentum-Breakout", regime: "Risk-On Trending", returnPct: 1 })
    ];
    const previous = process.env[PAST_DECISION_CASE_AFFINITY_ENV];
    process.env[PAST_DECISION_CASE_AFFINITY_ENV] = "off";
    try {
      expect(applyPastCaseAffinityWeighting(chunks, CONTEXT)).toEqual(chunks);
    } finally {
      if (previous === undefined) delete process.env[PAST_DECISION_CASE_AFFINITY_ENV];
      else process.env[PAST_DECISION_CASE_AFFINITY_ENV] = previous;
    }
  });
});

describe("caseAffinityContextFromCandidates", () => {
  it("derives symbols/sectors/factors/regime from the candidates already passed to the pass", () => {
    expect(
      caseAffinityContextFromCandidates({
        regime: "Risk-On Trending",
        candidates: [
          { symbol: "aapl", sector: "Technology", dominantFactor: "momentum" },
          { symbol: "MSFT", sector: "Technology", dominantFactor: "value" }
        ]
      })
    ).toEqual({
      symbols: ["AAPL", "MSFT"],
      sectors: ["Technology", "Technology"],
      dominantFactors: ["momentum", "value"],
      regime: "Risk-On Trending"
    });
  });

  it("omits thesisTags entirely when the caller does not know one yet", () => {
    const ctx = caseAffinityContextFromCandidates({ regime: "Choppy", candidates: [{ symbol: "AAPL" }] });
    expect("thesisTags" in ctx).toBe(false);
  });

  it("drops empty candidate fields rather than matching on blank strings", () => {
    const ctx = caseAffinityContextFromCandidates({
      regime: "Choppy",
      candidates: [{ symbol: "AAPL" }, { symbol: "", sector: undefined, dominantFactor: undefined }]
    });
    expect(ctx.symbols).toEqual(["AAPL"]);
    expect(ctx.sectors).toEqual([]);
    expect(ctx.dominantFactors).toEqual([]);
  });
});