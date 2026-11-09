// Tests for the label-permutation significance baseline (Jesse lesson, docs/oss-lessons.md §6).
// The module is pure — no DB, no env — so these run without the temp-SQLite harness.

import { describe, expect, it } from "vitest";
import {
  permutationSignificance,
  significanceConfidence,
  significancePValue,
  significanceSentence
} from "../src/lib/significance";
import { classifyRiskTier } from "../src/lib/learned-context/classify";

/** Deterministic rng (mulberry32) so permutation draws are reproducible. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("permutationSignificance", () => {
  it("is deterministic for an injected rng", () => {
    const bucket = [5, 7, 6, 8, 4];
    const pool = [...bucket, -3, -2, -4, 1, 2, -1, 0, 3, -5, 2, 1, -2, 4, -3];
    const a = permutationSignificance({ bucket, pool, random: seededRng(42) });
    const b = permutationSignificance({ bucket, pool, random: seededRng(42) });
    expect(a).toEqual(b);
  });

  it("flags an obvious positive edge as significant (pUpper tiny)", () => {
    const bucket = [10, 12, 8, 9, 11];
    const pool = [...bucket, ...Array.from({ length: 25 }, () => -3)];
    const r = permutationSignificance({ bucket, pool, random: seededRng(7) });
    expect(r.meaningful).toBe(true);
    expect(r.observedMeanReturnPct).toBeCloseTo(10, 5);
    expect(r.baselineMeanReturnPct).toBeLessThan(0);
    expect(r.pUpper).toBeLessThan(0.01);
    expect(r.pUpper).toBeGreaterThan(0); // +1 correction — never exactly 0
    expect(r.pLower).toBeGreaterThan(0.99);
  });

  it("flags an obvious negative edge via pLower", () => {
    const bucket = [-10, -12, -8, -9, -11];
    const pool = [...bucket, ...Array.from({ length: 25 }, () => 3)];
    const r = permutationSignificance({ bucket, pool, random: seededRng(7) });
    expect(r.pLower).toBeLessThan(0.01);
    expect(r.pUpper).toBeGreaterThan(0.99);
  });

  it("does not flag a bucket identical to the pool distribution", () => {
    // Every draw has the same mean — no permutation can beat or trail the observed.
    const bucket = [2, 2, 2, 2, 2];
    const pool = Array.from({ length: 20 }, () => 2);
    const r = permutationSignificance({ bucket, pool, random: seededRng(1) });
    expect(r.meaningful).toBe(true);
    expect(r.pUpper).toBe(1);
    expect(r.pLower).toBe(1);
  });

  it("marks the baseline not meaningful when the pool is too small", () => {
    const bucket = [1, 2, 3, 4, 5];
    const pool = [...bucket, 6, 7, 8, 9]; // only 4 extra lots (< MIN_POOL_EXCESS = 5)
    const r = permutationSignificance({ bucket, pool, random: seededRng(1) });
    expect(r.meaningful).toBe(false);
    expect(r.pUpper).toBe(1);
    expect(r.pLower).toBe(1);
    expect(r.sampleSize).toBe(5);
    expect(r.poolSize).toBe(9);
  });

  it("is not meaningful for an empty bucket", () => {
    const r = permutationSignificance({ bucket: [], pool: [1, 2, 3, 4, 5, 6], random: seededRng(1) });
    expect(r.meaningful).toBe(false);
  });

  it("clamps permutations to [100, 10000]", () => {
    const bucket = [1, 2, 3, 4, 5];
    const pool = [...bucket, 6, 7, 8, 9, 10, 11];
    expect(permutationSignificance({ bucket, pool, permutations: 5, random: seededRng(1) }).permutations).toBe(100);
    expect(permutationSignificance({ bucket, pool, permutations: 99999, random: seededRng(1) }).permutations).toBe(10_000);
  });
});

describe("significancePValue", () => {
  const edge = permutationSignificance({
    bucket: [10, 12, 8, 9, 11],
    pool: [10, 12, 8, 9, 11, ...Array.from({ length: 25 }, () => -3)],
    random: seededRng(7)
  });

  it("returns pUpper for positive and pLower for negative", () => {
    expect(significancePValue("positive", edge)).toBe(edge.pUpper);
    expect(significancePValue("negative", edge)).toBe(edge.pLower);
  });

  it("returns undefined for neutral verdicts and meaningless baselines", () => {
    expect(significancePValue("neutral", edge)).toBeUndefined();
    const small = permutationSignificance({ bucket: [1, 2, 3], pool: [1, 2, 3, 4], random: seededRng(1) });
    expect(significancePValue("positive", small)).toBeUndefined();
  });
});

describe("significanceSentence", () => {
  const positiveEdge = permutationSignificance({
    bucket: [10, 12, 8, 9, 11],
    pool: [10, 12, 8, 9, 11, ...Array.from({ length: 25 }, () => -3)],
    random: seededRng(7)
  });
  const noEdge = permutationSignificance({
    bucket: [1, -1, 2, -2, 0, 1],
    pool: [1, -1, 2, -2, 0, 1, 3, -3, 0, 1, -1, 2, -2, 1, -1, 0, 2, -1, 1, -2, 0, 1],
    random: seededRng(3)
  });

  it("claims the edge when significant, disclaims it when not", () => {
    const strong = significanceSentence("positive", positiveEdge);
    expect(strong).toContain("beats a random-bucket label-permutation baseline");
    expect(strong).not.toContain("NOT");
    const weak = significanceSentence("positive", noEdge);
    expect(weak).toContain("does NOT beat");
    expect(weak).toContain("could still be luck");
  });

  it("has symmetric negative-direction wording", () => {
    const negativeEdge = permutationSignificance({
      bucket: [-10, -12, -8, -9, -11],
      pool: [-10, -12, -8, -9, -11, ...Array.from({ length: 25 }, () => 3)],
      random: seededRng(7)
    });
    expect(significanceSentence("negative", negativeEdge)).toContain("significantly worse");
    expect(significanceSentence("negative", noEdge)).toContain("not significantly worse");
  });

  it("returns undefined for neutral verdicts and meaningless baselines", () => {
    expect(significanceSentence("neutral", positiveEdge)).toBeUndefined();
    const small = permutationSignificance({ bucket: [1, 2, 3], pool: [1, 2, 3, 4], random: seededRng(1) });
    expect(significanceSentence("positive", small)).toBeUndefined();
  });

  it("never trips the learned-context numeric/risk gate (stays a FACT)", () => {
    // The annotation is appended to an ingested learned-context fact; if the fail-closed
    // classifier reclassified it as risk it would be gated away from the brain entirely.
    const sentences = [
      significanceSentence("positive", positiveEdge),
      significanceSentence("positive", noEdge),
      significanceSentence("negative", positiveEdge),
      significanceSentence("negative", noEdge)
    ].filter((s): s is string => typeof s === "string");
    expect(sentences.length).toBe(4);
    for (const s of sentences) {
      expect(classifyRiskTier({ kind: "pattern", subject: "thesis track record", value: s, intent: "learning" })).toBe("fact");
      expect(s).not.toMatch(/[%$]/);
      expect(s.toLowerCase()).not.toMatch(/\bpercent\b|\bshares\b|\blots\b/);
    }
  });
});

describe("significanceConfidence", () => {
  const positiveEdge = permutationSignificance({
    bucket: [10, 12, 8, 9, 11],
    pool: [10, 12, 8, 9, 11, ...Array.from({ length: 25 }, () => -3)],
    random: seededRng(7)
  });
  const noEdge = permutationSignificance({
    bucket: [1, -1, 2, -2, 0, 1],
    pool: [1, -1, 2, -2, 0, 1, 3, -3, 0, 1, -1, 2, -2, 1, -1, 0, 2, -1, 1, -2, 0, 1],
    random: seededRng(3)
  });

  it("rewards validated edges, discounts luck-compatible ones", () => {
    expect(significanceConfidence("positive", positiveEdge)).toBe(0.7);
    expect(significanceConfidence("positive", noEdge)).toBe(0.45);
  });

  it("keeps the fallback for neutral verdicts and meaningless baselines", () => {
    expect(significanceConfidence("neutral", positiveEdge)).toBe(0.6);
    const small = permutationSignificance({ bucket: [1, 2, 3], pool: [1, 2, 3, 4], random: seededRng(1) });
    expect(significanceConfidence("positive", small)).toBe(0.6);
    expect(significanceConfidence("positive", small, 0.5)).toBe(0.5);
  });
});
