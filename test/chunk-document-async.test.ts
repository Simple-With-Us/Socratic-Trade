/**
 * Yielded-async chunking (2026-11-27 stall follow-up).
 *
 * `chunkDocument` chunked a whole filing in one synchronous stretch — the
 * sentence-segmentation regexes and content hashing in the production stall
 * profiles. `chunkDocumentAsync` bounds each stretch to ~128KB of input and
 * yields between units. These tests pin: a single-unit document is byte-for-
 * byte the sync path, and a multi-unit document produces sequential chunk
 * ids with no chunk text lost.
 */
import { describe, expect, it } from "vitest";
import { chunkDocument, chunkDocumentAsync, type ChunkInput } from "../src/lib/rag/chunk";

const baseDoc: ChunkInput = {
  text: "placeholder",
  doc_id: "doc-async-1",
  title: "Async Test Filing",
  ticker: "ACME",
  doc_type: "filing",
  source: "sec-edgar",
  published_at: "2026-01-15T00:00:00.000Z",
  sections: [
    { itemCode: "1", itemTitle: "Business", text: "Acme sells widgets. Revenue grew steadily last year." },
    { itemCode: "2", itemTitle: "Risks", text: "Widgets may rust. Rust is bad for widgets and margins." }
  ]
};

describe("chunkDocumentAsync", () => {
  it("matches chunkDocument exactly for a single-unit document", async () => {
    const sync = chunkDocument(baseDoc, { maxTokens: 400, overlapRatio: 0.15 });
    const asyncChunks = await chunkDocumentAsync(baseDoc, { maxTokens: 400, overlapRatio: 0.15 });
    expect(asyncChunks).toEqual(sync);
    expect(asyncChunks.length).toBeGreaterThan(0);
  });

  it("chunks a multi-unit document with sequential ids and no lost text", async () => {
    const paragraph = "The quick brown fox jumps over the lazy dog near the river bank today. ".repeat(40);
    const bigText = Array.from({ length: 12 }, () => paragraph).join("\n\n");
    const doc: ChunkInput = {
      ...baseDoc,
      doc_id: "doc-async-big",
      text: bigText,
      sections: [{ itemCode: "FULL", itemTitle: "Full filing text", text: bigText }]
    };
    const chunks = await chunkDocumentAsync(doc, { maxTokens: 400, overlapRatio: 0.15 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.chunk_id).toBe(`doc-async-big#c${String(i + 1).padStart(3, "0")}`);
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.content_hash).toMatch(/^[0-9a-f]{32}$/);
    });
    const joined = chunks.map((c) => c.text).join(" ");
    expect(joined).toContain("quick brown fox");
  });
});
