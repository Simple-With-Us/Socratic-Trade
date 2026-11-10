import { describe, expect, it } from "vitest";
import { isCompactRagSummaryDocType, orderChunksForProposer } from "../src/lib/rag/proposer-format";

describe("orderChunksForProposer", () => {
  it("puts compact summaries ahead of raw filings, then sorts by relevance", () => {
    const ordered = orderChunksForProposer([
      { doc_type: "10-k", score: 0.99, text: "item 1a" },
      { doc_type: "earnings-summary", score: 0.4, text: "call highlights" },
      { doc_type: "document-summary", score: 0.7, text: "10-q brief" },
      { doc_type: "10-q", score: 0.2, text: "md&a" }
    ]);
    expect(ordered.map((c) => c.doc_type)).toEqual([
      "document-summary",
      "earnings-summary",
      "10-k",
      "10-q"
    ]);
  });

  it("recognizes compact abstract types", () => {
    expect(isCompactRagSummaryDocType("document-summary")).toBe(true);
    expect(isCompactRagSummaryDocType("8k-brief")).toBe(true);
    expect(isCompactRagSummaryDocType("10-k")).toBe(false);
  });
});
