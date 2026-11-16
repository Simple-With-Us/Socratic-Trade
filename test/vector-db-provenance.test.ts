import { describe, expect, it } from "vitest";
import { formatChunkWithProvenance, matchToChunk, type RetrievedChunk } from "../src/lib/vector-db";

// I4: citations must carry REAL provenance (the Pinecone vector id, its score, and the chunk's own
// acceptance date) — never a fabricated `<SYMBOL>#i` id or the query's as_of.
describe("matchToChunk — real citation provenance (I4)", () => {
  it("uses the real vector id, score, source, acceptance date, and url", () => {
    const c = matchToChunk({
      id: "8-K:AAPL:0000320193-24-000123:1718000000",
      score: 0.87,
      metadata: {
        text: "Apple announced a new buyback.",
        source: "sec-edgar-8k",
        acceptance_datetime: "2024-06-10T16:30:00Z",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123.htm"
      }
    });
    expect(c.id).toBe("8-K:AAPL:0000320193-24-000123:1718000000");
    expect(c.id).not.toMatch(/#\d+$/); // NOT a fabricated <SYMBOL>#i id
    expect(c.score).toBe(0.87);
    expect(c.as_of).toBe("2024-06-10T16:30:00Z");
    expect(c.source).toBe("sec-edgar-8k");
    expect(c.url).toContain("sec.gov");
    expect(c.text).toBe("Apple announced a new buyback.");
  });

  it("falls back across as_of/timestamp and tolerates missing metadata", () => {
    expect(matchToChunk({ id: "x", score: 0.1, metadata: { text: "t", as_of: "2023-01-01" } }).as_of).toBe("2023-01-01");
    expect(matchToChunk({ id: "y", score: 0.1, metadata: { text: "t", timestamp: 1718000000 } }).as_of).toBe("1718000000");
    const bare = matchToChunk({ id: "z" });
    expect(bare.text).toBe("");
    expect(bare.score).toBe(0);
    expect(bare.as_of).toBeUndefined();
    expect(bare.url).toBeUndefined();
  });
});

// 2026-07-04 RAG quick-wins: prefix each retrieved chunk with a compact provenance header
// (doc_type/section/symbol/date/relevance) so the model can weight a fresh 8-K over a stale 10-K
// and reference which chunk it drew from. Chunk ids stay stable/unchanged (RetrievedChunk.id, the
// real Pinecone vector id) — the header is prepended to `text` only, never to `id`.
describe("formatChunkWithProvenance", () => {
  const baseChunk: RetrievedChunk = {
    id: "8-K:AAPL:0000320193-24-000123:1718000000",
    text: "Apple announced a new buyback.",
    score: 0.65,
    doc_type: "10-k",
    section: "risk-factors",
    as_of: "2026-02-01T16:30:00Z",
    relevanceScore: 0.82
  };

  it("prepends a compact header with doc_type/section/symbol/date/relevance, and preserves the original text verbatim after it", () => {
    const out = formatChunkWithProvenance(baseChunk, "AAPL");
    expect(out).toBe("[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.82]\nApple announced a new buyback.");
    expect(out).toContain(baseChunk.text); // original text survives untouched as a substring
  });

  it("prefers the post-rerank relevanceScore over the Pinecone cosine score when both are present", () => {
    const out = formatChunkWithProvenance({ ...baseChunk, score: 0.11, relevanceScore: 0.99 }, "AAPL");
    expect(out).toContain("rel 0.99");
    expect(out).not.toContain("rel 0.11");
  });

  it("falls back to the cosine score when relevanceScore is absent (rerank off/failed)", () => {
    const noRerank: RetrievedChunk = { ...baseChunk, relevanceScore: undefined, score: 0.42 };
    const out = formatChunkWithProvenance(noRerank, "AAPL");
    expect(out).toContain("rel 0.42");
  });

  it("omits missing fields gracefully instead of rendering a placeholder", () => {
    const sparse: RetrievedChunk = { id: "x", text: "Sparse chunk with no metadata.", score: 0 };
    const out = formatChunkWithProvenance(sparse);
    // score=0 is a valid (if uninformative) relevance value, so it's still rendered; there is no
    // doc_type/section/symbol/date to include.
    expect(out).toBe("[rel 0.00]\nSparse chunk with no metadata.");
  });

  it("returns the bare text unprefixed when there is truly nothing to show (no score, no metadata)", () => {
    const empty: RetrievedChunk = { id: "x", text: "No provenance at all.", score: undefined as unknown as number };
    const out = formatChunkWithProvenance(empty);
    expect(out).toBe("No provenance at all.");
  });

  it("is stable/idempotent for citation purposes: the chunk id itself is never altered by header formatting", () => {
    const out = formatChunkWithProvenance(baseChunk, "AAPL");
    expect(baseChunk.id).toBe("8-K:AAPL:0000320193-24-000123:1718000000");
    expect(out).not.toContain(baseChunk.id); // the header carries doc_type/section/date, not the id
  });

  it("includes the bare SEC accession from metadata when present", () => {
    const out = formatChunkWithProvenance(
      {
        ...baseChunk,
        metadata: { accession: "AAPL:0000320193-24-000123:10-K" }
      },
      "AAPL"
    );
    expect(out.startsWith("[10-K · risk-factors · AAPL · 0000320193-24-000123 · 2026-02-01 · rel 0.82]")).toBe(true);
    expect(out).not.toContain("AAPL:0000320193-24-000123:10-K");
  });
});
