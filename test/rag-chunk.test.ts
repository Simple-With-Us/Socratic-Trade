import { describe, expect, it } from "vitest";
import {
  chunkDocument,
  canonicalTicker,
  countTokens,
  hashContent,
  splitSentencesPreservingAbbreviations,
  splitTableByRowGroups
} from "../src/lib/rag/chunk";
import { isWithinAsOf } from "../src/lib/vector-db";

describe("rag chunkDocument", () => {
  it("keeps tables atomic and carries section from headings", () => {
    const doc = {
      text: [
        "# Risk Factors",
        "",
        "Our business faces competition and supply-chain risk.",
        "",
        "| Metric | Value |",
        "| Rev | 100 |",
        "| Net | 20 |",
        "",
        "## Management Discussion",
        "",
        "Margins improved this quarter.",
      ].join("\n"),
      ticker: "aapl",
      doc_type: "10-K",
      source: "sec",
      acceptance_datetime: "2024-01-15",
      published_at: "2024-01-15",
    };
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const table = chunks.find((c) => c.is_table);
    expect(table).toBeTruthy();
    expect(table!.text).toContain("| Rev | 100 |");
    expect(table!.text).toContain("| Net | 20 |");

    expect(chunks.some((c) => c.section === "Risk Factors")).toBe(true);
    expect(chunks.some((c) => /Management Discussion/i.test(c.section))).toBe(true);

    expect(chunks[0]!.context_header).toContain("AAPL");
    expect(chunks[0]!.ticker).toEqual(["AAPL"]);
    expect(chunks[0]!.acceptance_datetime).toContain("2024-01-15");
  });

  it("splits long prose into multiple windows under the token cap", () => {
    const longText = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkDocument({ text: longText, published_at: "2024-01-15" }, { maxTokens: 100, overlapRatio: 0.1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.split(/\s+/).filter(Boolean).length <= 100)).toBe(true);
  });

  it("requires doc.text", () => {
    expect(() => chunkDocument({ text: "", published_at: "2024-01-15" })).toThrow();
  });

  it("canonicalTicker uppercases and strips noise", () => {
    expect(canonicalTicker(" brk.b ")).toBe("BRK.B");
    expect(canonicalTicker("aapl123")).toBe("AAPL");
  });

  it("hashContent is deterministic", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(32); // 128-bit (first 32 hex chars of SHA-256)
  });

  it("hashContent produces different hashes for different texts", () => {
    const h1 = hashContent("risk factors for AAPL");
    const h2 = hashContent("risk factors for MSFT");
    expect(h1).not.toBe(h2);
  });

  it("chunks carry content_hash", () => {
    const chunks = chunkDocument({ text: "Test content for hashing.", ticker: "TSLA", doc_type: "10-K", source: "sec", published_at: "2024-01-15" });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content_hash).toBeDefined();
    expect(chunks[0]!.content_hash.length).toBe(32); // 128-bit (first 32 hex chars of SHA-256)
    // Same content → same hash
    const chunks2 = chunkDocument({ text: "Test content for hashing.", ticker: "TSLA", doc_type: "10-K", source: "sec", published_at: "2024-01-15" });
    expect(chunks2[0]!.content_hash).toBe(chunks[0]!.content_hash);
    // Different content → different hash
    const chunks3 = chunkDocument({ text: "Different content.", ticker: "TSLA", doc_type: "10-K", source: "sec", published_at: "2024-01-15" });
    expect(chunks3[0]!.content_hash).not.toBe(chunks[0]!.content_hash);
  });

  it("preserves company/country abbreviations and decimals without shattering sentences", () => {
    const prose =
      "Apple Inc. and Microsoft Corp. expanded operations in the U.S. and U.K. under Dr. Smith and Mr. Doe, growing revenue by 12.5% to $3.14 billion. Next sentence starts here.";
    const sentences = splitSentencesPreservingAbbreviations(prose);
    expect(sentences).toEqual([
      "Apple Inc. and Microsoft Corp. expanded operations in the U.S. and U.K. under Dr. Smith and Mr. Doe, growing revenue by 12.5% to $3.14 billion.",
      "Next sentence starts here."
    ]);
  });

  it("does not emit standalone overlap mini-chunks when tail overlap + next sentence exceeds maxTokens", () => {
    const s1 = "First sentence with substantial corporate disclosure detail " + "alpha ".repeat(35) + ".";
    const s2 = "Second sentence that is nearly full on its own " + "beta ".repeat(42) + ".";
    const chunks = chunkDocument(
      {
        text: `${s1} ${s2}`,
        ticker: "AAPL",
        doc_type: "10-K",
        published_at: "2024-01-15"
      },
      { maxTokens: 90, overlapRatio: 0.4 }
    );
    // Should produce 2 substantive chunks (one for s1, one for s2), never a 3rd standalone tail-only mini-chunk.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain("First sentence");
    expect(chunks[1]!.text).toContain("Second sentence");
  });

  it("splits oversized financial tables by row groups while repeating the header row", () => {
    const header = "| Segment | FY24 Revenue | FY25 Revenue | YoY % |";
    const sep = "| --- | --- | --- | --- |";
    const rows = Array.from(
      { length: 25 },
      (_, i) => `| Segment_${i}_Operations_North_America | $${(i + 1) * 100}M | $${(i + 1) * 120}M | +20.0% |`
    );
    const bigTable = [header, sep, ...rows].join("\n");
    expect(countTokens(bigTable, true)).toBeGreaterThan(120);

    const groups = splitTableByRowGroups(bigTable, 120);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.startsWith(`${header}\n${sep}\n`)).toBe(true);
      expect(countTokens(group, true)).toBeLessThanOrEqual(120);
    }

    const docChunks = chunkDocument(
      {
        text: bigTable,
        ticker: "AAPL",
        doc_type: "10-K",
        published_at: "2024-01-15"
      },
      { maxTokens: 120 }
    );
    expect(docChunks.length).toBe(groups.length);
    expect(docChunks.every((c) => c.is_table)).toBe(true);
    expect(docChunks.every((c) => c.text.startsWith(`${header}\n${sep}\n`))).toBe(true);
  });
});

describe("retrieveContext as_of guard (isWithinAsOf)", () => {
  it("drops chunks dated after the as-of date; keeps earlier and undated", () => {
    const asOf = "2024-06-01";
    expect(isWithinAsOf({ acceptance_datetime: "2024-01-15" }, asOf)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2024-12-31" }, asOf)).toBe(false);
    expect(isWithinAsOf({ timestamp: "2025-01-01" }, asOf)).toBe(false);
    expect(isWithinAsOf({}, asOf)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2024-12-31" }, undefined)).toBe(true);
  });
});
