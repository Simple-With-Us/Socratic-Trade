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

  describe("optional `report` out-param: distinguishes genuine near-dup drops from limit-cap truncation", () => {
    it("5 fully-distinct candidates, limit=3: the 2 cut candidates are never-reached (cap truncation), not genuine duplicates", () => {
      const pool = [
        match("a", "the first entirely distinct passage about quarterly revenue growth trends"),
        match("b", "a second entirely distinct passage about supply chain logistics risk factors"),
        match("c", "a third entirely distinct passage about executive compensation governance policy"),
        match("d", "a fourth entirely distinct passage about international regulatory compliance matters"),
        match("e", "a fifth entirely distinct passage about capital expenditure and infrastructure investment")
      ];
      const report = { genuineDuplicateIndices: [], neverReachedIndices: [] };
      const result = dedupeSimilar(pool, 3, 0.6, report);

      // Behavior unchanged: exactly 3 distinct candidates kept.
      expect(result.length).toBe(3);
      expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);

      // The 2 cut candidates (indices 3="d", 4="e") were never even compared — pure cap
      // truncation — NOT genuine near-duplicates.
      expect(report.genuineDuplicateIndices).toEqual([]);
      expect(report.neverReachedIndices.sort()).toEqual([3, 4]);
    });

    it("genuine near-duplicates are reported in genuineDuplicateIndices, distinct from cap truncation", () => {
      const text = "the exact same repeated phrase over and over about revenue growth this quarter";
      const pool = [
        match("original", text),
        match("near-dup", text + " indeed"),
        match("distinct", "a totally different passage about supply chain risk and logistics")
      ];
      const report = { genuineDuplicateIndices: [], neverReachedIndices: [] };
      const result = dedupeSimilar(pool, 2, 0.5, report);

      expect(result.map((m) => m.id)).toEqual(["original", "distinct"]);
      // "near-dup" (index 1) was compared and judged a genuine duplicate of "original".
      expect(report.genuineDuplicateIndices).toEqual([1]);
      expect(report.neverReachedIndices).toEqual([]);
    });

    it("a mix: some genuinely deduped, others cut only by the cap", () => {
      const text = "the exact same repeated phrase over and over about revenue growth this quarter";
      const pool = [
        match("a", text),
        match("a-dup", text + " precisely"),
        match("b", "a completely different discussion about supply chain risk factors and logistics"),
        match("c", "yet another unrelated passage about executive compensation and governance policy"),
        match("d", "a fourth unrelated passage about capital markets and treasury operations")
      ];
      // limit=2: "a" kept first, "a-dup" judged genuine dup of "a" (deferred, then re-judged dup
      // again in back-fill since "a" is still the only kept item), "b" kept second (fills the cap),
      // "c" and "d" never reached because the cap (2) is already full by the time they're visited.
      const report = { genuineDuplicateIndices: [], neverReachedIndices: [] };
      const result = dedupeSimilar(pool, 2, 0.5, report);

      expect(result.map((m) => m.id)).toEqual(["a", "b"]);
      expect(report.genuineDuplicateIndices).toEqual([1]); // a-dup
      expect(report.neverReachedIndices.sort()).toEqual([3, 4]); // c, d
    });

    it("does not change dedupeSimilar's return value or behavior when report is supplied vs omitted", () => {
      const pool = [
        match("a", "alpha passage about revenue growth this quarter across every segment"),
        match("a-dup", "alpha passage about revenue growth this quarter across every segment too"),
        match("b", "beta passage about supply chain risk and logistics disruption")
      ];
      const withoutReport = dedupeSimilar(pool, 2, 0.5);
      const report = { genuineDuplicateIndices: [], neverReachedIndices: [] };
      const withReport = dedupeSimilar(pool, 2, 0.5, report);
      expect(withReport).toEqual(withoutReport);
      expect(withReport.map((m) => m.id)).toEqual(withoutReport.map((m) => m.id));
    });

    it("early-return shape (pool.length <= 1) populates an empty report rather than leaving it stale", () => {
      const pool = [match("solo", "only one candidate here")];
      const report = { genuineDuplicateIndices: [1, 2], neverReachedIndices: [3] };
      const result = dedupeSimilar(pool, 3, 0.5, report);
      expect(result).toEqual(pool);
      expect(report.genuineDuplicateIndices).toEqual([]);
      expect(report.neverReachedIndices).toEqual([]);
    });
  });
});
