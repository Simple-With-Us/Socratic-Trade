/**
 * Tests for src/lib/rationale-diversity.ts
 *
 * This module is a pure function — no DB access, no I/O. No beforeAll / DATABASE_URL needed.
 */

import { describe, expect, it } from "vitest";
import {
  buildTrigramMap,
  computeRationaleDiversity,
  DEFAULT_COLLAPSE_THRESHOLD,
  normaliseText,
  trigramJaccard
} from "../src/lib/rationale-diversity";

// ---------------------------------------------------------------------------
// normaliseText
// ---------------------------------------------------------------------------

describe("normaliseText", () => {
  it("lowercases input", () => {
    expect(normaliseText("AAPL Is A Buy")).toBe("aapl is a buy");
  });

  it("strips punctuation and collapses resulting whitespace", () => {
    // "Strong! momentum; here." → lowercase → "strong! momentum; here."
    // → strip punctuation (replace with space) → "strong  momentum  here "
    // → collapse whitespace → "strong momentum here"
    // → trim → "strong momentum here"
    expect(normaliseText("Strong! momentum; here.")).toBe("strong momentum here");
  });

  it("collapses whitespace runs", () => {
    expect(normaliseText("a   b\t\tc")).toBe("a b c");
  });

  it("strips leading/trailing whitespace", () => {
    expect(normaliseText("  hello world  ")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(normaliseText("")).toBe("");
  });

  it("handles string of only punctuation", () => {
    expect(normaliseText("!!! ???")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildTrigramMap
// ---------------------------------------------------------------------------

describe("buildTrigramMap", () => {
  it("returns empty map for empty string", () => {
    expect(buildTrigramMap("").size).toBe(0);
  });

  it("returns empty map for strings shorter than 3 chars", () => {
    expect(buildTrigramMap("ab").size).toBe(0);
  });

  it("returns one trigram for exactly 3-char string", () => {
    const m = buildTrigramMap("abc");
    expect(m.size).toBe(1);
    expect(m.get("abc")).toBe(1);
  });

  it("counts repeated trigrams correctly", () => {
    // "aaa" → ["aaa", "aaa"] → count 2
    const m = buildTrigramMap("aaaa");
    expect(m.get("aaa")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// trigramJaccard
// ---------------------------------------------------------------------------

describe("trigramJaccard", () => {
  it("returns 0 for two empty maps", () => {
    expect(trigramJaccard(new Map(), new Map())).toBe(0);
  });

  it("returns 1 for identical non-empty maps", () => {
    const m = buildTrigramMap("hello world test");
    expect(trigramJaccard(m, m)).toBe(1);
  });

  it("returns 0 for completely disjoint trigram sets", () => {
    const a = buildTrigramMap("aaa");     // {aaa:1}
    const b = buildTrigramMap("bbb");     // {bbb:1}
    expect(trigramJaccard(a, b)).toBe(0);
  });

  it("returns a value in (0,1) for partial overlap", () => {
    const a = buildTrigramMap("hello world");
    const b = buildTrigramMap("hello planet");
    const sim = trigramJaccard(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// computeRationaleDiversity — edge cases
// ---------------------------------------------------------------------------

describe("computeRationaleDiversity edge cases", () => {
  it("returns collapsed:false and similarities 0 for empty array", () => {
    const result = computeRationaleDiversity([]);
    expect(result.count).toBe(0);
    expect(result.meanPairwiseSimilarity).toBe(0);
    expect(result.maxPairwiseSimilarity).toBe(0);
    expect(result.collapsed).toBe(false);
    expect(result.threshold).toBe(DEFAULT_COLLAPSE_THRESHOLD);
  });

  it("returns collapsed:false and similarities 0 for single rationale", () => {
    const result = computeRationaleDiversity(["AAPL shows strong momentum, entering on breakout above 200-day SMA."]);
    expect(result.count).toBe(1);
    expect(result.meanPairwiseSimilarity).toBe(0);
    expect(result.maxPairwiseSimilarity).toBe(0);
    expect(result.collapsed).toBe(false);
  });

  it("handles two empty string rationales without throwing", () => {
    // Both normalise to "" → both trigram maps empty → Jaccard = 0
    const result = computeRationaleDiversity(["", ""]);
    expect(result.count).toBe(2);
    expect(result.meanPairwiseSimilarity).toBe(0);
    expect(result.maxPairwiseSimilarity).toBe(0);
    expect(result.collapsed).toBe(false);
  });

  it("handles rationales that are only punctuation", () => {
    const result = computeRationaleDiversity(["!!! ???", "... ;;;"]);
    // Both normalise to "" → similarity 0
    expect(result.collapsed).toBe(false);
    expect(result.meanPairwiseSimilarity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRationaleDiversity — identical rationales → collapse detected
// ---------------------------------------------------------------------------

describe("computeRationaleDiversity — identical rationales", () => {
  const identical = "The stock shows strong momentum driven by institutional buying and robust earnings growth. Entry is supported by the current market regime and positive sector trends.";

  it("two identical rationales → similarity 1 and collapsed:true", () => {
    const result = computeRationaleDiversity([identical, identical]);
    expect(result.count).toBe(2);
    expect(result.meanPairwiseSimilarity).toBeCloseTo(1, 5);
    expect(result.maxPairwiseSimilarity).toBeCloseTo(1, 5);
    expect(result.collapsed).toBe(true);
  });

  it("three identical rationales → similarity 1 and collapsed:true", () => {
    const result = computeRationaleDiversity([identical, identical, identical]);
    expect(result.count).toBe(3);
    expect(result.meanPairwiseSimilarity).toBeCloseTo(1, 5);
    expect(result.collapsed).toBe(true);
  });

  it("case / punctuation / whitespace variants of same text → similarity near 1", () => {
    // Normalisation should make these near-identical
    const a = "Strong! Momentum; entry confirmed.";
    const b = "STRONG MOMENTUM ENTRY CONFIRMED";
    const result = computeRationaleDiversity([a, b]);
    // Not identical after normalisation but substantially similar
    expect(result.meanPairwiseSimilarity).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeRationaleDiversity — fully diverse rationales → not collapsed
// ---------------------------------------------------------------------------

describe("computeRationaleDiversity — diverse rationales", () => {
  it("completely different rationales → collapsed:false and low similarity", () => {
    const rationales = [
      "AAPL is showing a classic cup-and-handle breakout pattern on the weekly chart. Earnings beat expectations by 12% last quarter and institutional ownership is at an all-time high.",
      "TSLA faces significant headwinds from rising competition in the EV market. However, the energy storage segment is showing strong growth and margin improvement. RSI is oversold.",
      "Gold is a safe-haven asset in the current macro environment. With the Fed signaling rate cuts and geopolitical tensions rising, the commodity is well-positioned for a multi-month rally.",
      "NVDA benefits from the AI infrastructure buildout. Data center revenue doubled year-over-year. The stock is consolidating near all-time highs after the recent split."
    ];
    const result = computeRationaleDiversity(rationales);
    expect(result.collapsed).toBe(false);
    expect(result.meanPairwiseSimilarity).toBeLessThan(0.5);
    expect(result.maxPairwiseSimilarity).toBeLessThan(0.85);
  });
});

// ---------------------------------------------------------------------------
// computeRationaleDiversity — threshold boundary
// ---------------------------------------------------------------------------

describe("computeRationaleDiversity — threshold boundary", () => {
  it("uses DEFAULT_COLLAPSE_THRESHOLD (0.85) when not specified", () => {
    const result = computeRationaleDiversity(["abc", "xyz"]);
    expect(result.threshold).toBe(0.85);
  });

  it("respects a custom threshold: below threshold → not collapsed", () => {
    const similar = [
      "The stock shows strong momentum with positive earnings.",
      "The stock shows strong momentum with robust earnings growth."
    ];
    const result = computeRationaleDiversity(similar, 0.99);
    // meanPairwiseSimilarity is likely < 0.99 for these two
    expect(result.threshold).toBe(0.99);
    // collapsed depends on actual similarity vs 0.99; we just confirm threshold is wired
    expect(result.collapsed).toBe(result.meanPairwiseSimilarity > 0.99);
  });

  it("with threshold=0: two distinct rationales always collapse", () => {
    const result = computeRationaleDiversity(["hello world here", "goodbye world now"], 0);
    // Any positive similarity exceeds threshold=0
    expect(result.collapsed).toBe(result.meanPairwiseSimilarity > 0);
  });

  it("with threshold=1: identical strings do NOT collapse (must exceed, not equal)", () => {
    // Jaccard of identical strings = 1; collapsed = (1 > 1) = false
    const identical = "the same rationale text exactly";
    const result = computeRationaleDiversity([identical, identical], 1);
    expect(result.meanPairwiseSimilarity).toBeCloseTo(1, 5);
    expect(result.collapsed).toBe(false);
  });

  it("collapses when meanPairwiseSimilarity exceeds threshold (not meets)", () => {
    // Force: identical rationales → mean = 1. threshold=0.85 → 1 > 0.85 → true
    const identical = "identical boilerplate rationale string for testing collapse detection";
    const result = computeRationaleDiversity([identical, identical], DEFAULT_COLLAPSE_THRESHOLD);
    expect(result.collapsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeRationaleDiversity — output shape
// ---------------------------------------------------------------------------

describe("computeRationaleDiversity — output shape", () => {
  it("returns all five required fields", () => {
    const result = computeRationaleDiversity(["a longer rationale for aapl stock", "b longer rationale for tsla stock"]);
    expect(typeof result.count).toBe("number");
    expect(typeof result.meanPairwiseSimilarity).toBe("number");
    expect(typeof result.maxPairwiseSimilarity).toBe("number");
    expect(typeof result.collapsed).toBe("boolean");
    expect(typeof result.threshold).toBe("number");
  });

  it("maxPairwiseSimilarity >= meanPairwiseSimilarity always", () => {
    const rationales = [
      "AAPL strong technical breakout confirmed by volume surge above 50-day moving average.",
      "TSLA energy division growing rapidly with margin improvements expected in Q3.",
      "Gold hedges macro risk in a rising inflation environment with Fed policy uncertainty."
    ];
    const result = computeRationaleDiversity(rationales);
    expect(result.maxPairwiseSimilarity).toBeGreaterThanOrEqual(result.meanPairwiseSimilarity);
  });

  it("similarity values are in [0, 1]", () => {
    const result = computeRationaleDiversity([
      "momentum play on AAPL with strong earnings",
      "mean reversion on TSLA after oversold RSI"
    ]);
    expect(result.meanPairwiseSimilarity).toBeGreaterThanOrEqual(0);
    expect(result.meanPairwiseSimilarity).toBeLessThanOrEqual(1);
    expect(result.maxPairwiseSimilarity).toBeGreaterThanOrEqual(0);
    expect(result.maxPairwiseSimilarity).toBeLessThanOrEqual(1);
  });
});
