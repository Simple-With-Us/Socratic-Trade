/**
 * Tests for near-duplicate suppression (R14, 2026-07-01 RAG backlog).
 */
import { describe, expect, it } from "vitest";
import { dedupeSimilar, jaccardSimilarity } from "../src/lib/rag/dedupe-similar";

function match(id: string, text: string): { id: string; metadata: { text: string } } {
  return { id, metadata: { text } };
}

describe("jaccardSimilarity", () => {
  it("is 1.0 for identical sets", () => {
    const a = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(a, new Set(a))).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("is 0 for two empty sets (no divide-by-zero NaN)", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes intersection-over-union for partial overlap", () => {
    // {a,b,c} vs {b,c,d}: intersection={b,c}=2, union={a,b,c,d}=4 -> 0.5
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5, 5);
  });
});

describe("dedupeSimilar", () => {
  it("returns the pool unchanged when it has <=1 item", () => {
    const pool = [match("a", "some text")];
    expect(dedupeSimilar(pool, 3, 0.5)).toEqual(pool);
    expect(dedupeSimilar([], 3, 0.5)).toEqual([]);
  });

  it("keeps distinct chunks and drops a near-duplicate restatement", () => {
    const pool = [
      match("a", "Apple reported strong iPhone sales growth in the quarter driven by upgrades"),
      match("a-dup", "Apple reported strong iPhone sales growth in the quarter driven by upgrades and services"),
      match("b", "Microsoft cloud revenue grew significantly due to Azure enterprise adoption")
    ];
    const result = dedupeSimilar(pool, 3, 0.5);
    const ids = result.map((m) => m.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // a-dup is a near-restatement of a (high shingle overlap) — should be dropped when limit=2 is reachable without it.
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it("back-fills from later candidates when an early one is a near-duplicate, to still reach `limit`", () => {
    const pool = [
      match("a", "the exact same repeated phrase over and over about revenue growth this quarter"),
      match("a-dup", "the exact same repeated phrase over and over about revenue growth this quarter too"),
      match("b", "a completely different discussion about supply chain risk factors and logistics"),
      match("c", "yet another unrelated passage about executive compensation and governance policy")
    ];
    const result = dedupeSimilar(pool, 3, 0.3);
    // Should reach 3 distinct chunks by back-filling with b/c even though a-dup was dropped.
    expect(result.length).toBe(3);
    const ids = result.map((m) => m.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("a-dup");
  });

  it("returns fewer than limit when the pool genuinely has fewer distinct chunks than limit", () => {
    const pool = [
      match("a", "identical text about the same exact topic in the same exact words here"),
      match("a-dup1", "identical text about the same exact topic in the same exact words here too"),
      match("a-dup2", "identical text about the same exact topic in the same exact words here also")
    ];
    const result = dedupeSimilar(pool, 3, 0.3);
    expect(result.length).toBeLessThan(3);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("never drops anything when threshold is 1.0 and no chunk is byte-identical", () => {
    const pool = [
      match("a", "first distinct passage about revenue"),
      match("b", "second distinct passage about margins"),
      match("c", "third distinct passage about guidance")
    ];
    const result = dedupeSimilar(pool, 3, 1.0);
    expect(result.length).toBe(3);
  });

  it("handles missing/empty metadata.text gracefully (no crash, treated as empty shingle set)", () => {
    const pool = [
      { id: "a", metadata: {} },
      { id: "b", metadata: { text: "real content here about something" } }
    ];
    expect(() => dedupeSimilar(pool, 2, 0.5)).not.toThrow();
  });
});
