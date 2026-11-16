import { describe, expect, it, vi } from "vitest";
import { fuseDenseAndLexicalRecall, hasLexicalRecall } from "../src/lib/rag/recall-fusion";
import type { CorpusWideLexicalCandidate } from "../src/lib/rag/corpus-wide-lexical";
import { rankPool } from "../src/lib/vector-db";

function lexical(id: string, text = id): CorpusWideLexicalCandidate {
  return {
    id,
    text,
    score: 0,
    lexicalScore: -1,
    source: "sec-edgar",
    symbol: "AAPL",
    accession: `accession-${id}`,
    retrievalSources: ["lexical"],
    metadata: { retrieval_sources: ["lexical"] }
  };
}

describe("dense plus corpus-wide lexical recall fusion", () => {
  it("adds a lexical-only candidate that dense recall never returned", () => {
    const dense = [
      { id: "dense-a", score: 0.9, metadata: { text: "semantic A" } },
      { id: "dense-b", score: 0.8, metadata: { text: "semantic B" } }
    ];
    const result = fuseDenseAndLexicalRecall(dense, [lexical("exact")], 10);
    expect(result.matches.map((match) => match.id)).toContain("exact");
    expect(hasLexicalRecall(result.matches.find((match) => match.id === "exact"))).toBe(true);
    expect(result).toMatchObject({ denseCandidates: 2, lexicalCandidates: 1, overlapCandidates: 0 });
  });

  it("deduplicates an overlap while retaining the dense score and dual provenance", () => {
    const result = fuseDenseAndLexicalRecall(
      [{ id: "same", score: 0.83, metadata: { text: "dense text", provider_field: "kept" } }],
      [lexical("same", "lexical text")],
      10
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: "same",
      score: 0.83,
      metadata: { text: "dense text", provider_field: "kept", retrieval_sources: ["dense", "lexical"] }
    });
    expect(result.overlapCandidates).toBe(1);
  });

  it("honors the fused-pool cap deterministically", () => {
    const result = fuseDenseAndLexicalRecall(
      [
        { id: "dense-a", score: 0.9, metadata: { text: "A" } },
        { id: "dense-b", score: 0.8, metadata: { text: "B" } }
      ],
      [lexical("lexical-a"), lexical("lexical-b")],
      2
    );
    expect(result.matches).toHaveLength(2);
    expect(new Set(result.matches.map((match) => match.id)).size).toBe(2);
  });

  it("feeds one deduplicated dense-plus-lexical pool through exactly one rerank pass", async () => {
    const dense = [
      { id: "overlap", score: 0.9, metadata: { text: "dense overlap", userId: "local", scope: "shared" } },
      { id: "dense-only", score: 0.8, metadata: { text: "dense only", userId: "local", scope: "shared" } }
    ];
    const fusion = fuseDenseAndLexicalRecall(dense, [lexical("overlap"), lexical("lexical-only")], 10);
    const rerank = vi.fn(async (_query: string, matches: any[]) => matches);

    const ranked = await rankPool(fusion.matches, "generic strategy evidence", 2, {
      rerank,
      rerankCandidateLimit: 10
    });

    expect(rerank).toHaveBeenCalledOnce();
    expect(rerank.mock.calls[0]?.[1]).toHaveLength(3);
    expect(ranked.map((match) => match.id)).toEqual(expect.arrayContaining([
      "overlap",
      "dense-only",
      "lexical-only"
    ]));
  });
});
