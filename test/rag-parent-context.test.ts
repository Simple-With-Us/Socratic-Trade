import { describe, expect, it } from "vitest";
import {
  PARENT_CONTEXT_MARKER,
  expandPostRerankParentContext,
  type ParentContextCandidate
} from "../src/lib/rag/parent-context";

function chunk(
  id: string,
  text: string,
  parentText?: string,
  metadata: Record<string, unknown> = {}
): ParentContextCandidate {
  return {
    id,
    text,
    score: id.length / 10,
    relevanceScore: id.length / 20,
    metadata: {
      source: "sec-edgar",
      accession: "0000123-26-000001",
      acceptance_datetime: "2026-01-20T12:00:00.000Z",
      ...metadata,
      ...(parentText ? { parent_text: parentText } : {})
    }
  };
}

describe("expandPostRerankParentContext", () => {
  it("attaches a shared parent once while retaining every selected sibling's identity and score", () => {
    const parent = "Parent section context with the complete risk discussion.";
    const first = chunk("child-1", "selected child one", parent);
    const second = chunk("child-2", "selected child two", parent);

    const result = expandPostRerankParentContext([first, second], { enabled: true });

    expect(result.chunks.map((item) => item.id)).toEqual(["child-1", "child-2"]);
    expect(result.chunks.map((item) => item.score)).toEqual([first.score, second.score]);
    expect(result.chunks.map((item) => item.relevanceScore)).toEqual([first.relevanceScore, second.relevanceScore]);
    expect(result.chunks[0]!.metadata).toBe(first.metadata);
    expect(result.chunks[0]!.text).toContain(`${PARENT_CONTEXT_MARKER}\n${parent}`);
    expect(result.chunks[1]!.text).toBe(second.text);
    expect(result.receipt).toMatchObject({ attachedParents: 1, skippedDuplicateParents: 1 });
  });

  it("deduplicates a parent across sibling chunks with distinct child content hashes", () => {
    const parent = "Parent section context shared by two separately embedded children.";
    const result = expandPostRerankParentContext([
      chunk("child-1", "first selected child", parent, { content_hash: "child-hash-one" }),
      chunk("child-2", "second selected child", parent, { content_hash: "child-hash-two" })
    ], { enabled: true });

    expect(result.chunks[0]!.text).toContain(PARENT_CONTEXT_MARKER);
    expect(result.chunks[1]!.text).toBe("second selected child");
    expect(result.receipt).toMatchObject({ attachedParents: 1, skippedDuplicateParents: 1 });
  });

  it("leaves a missing parent untouched and keeps disabled mode byte-identical", () => {
    const missing = chunk("missing", "child without parent");
    const source = [missing];

    const enabled = expandPostRerankParentContext(source, { enabled: true });
    const disabled = expandPostRerankParentContext(source, { enabled: false });

    expect(enabled.chunks).toEqual([missing]);
    expect(enabled.chunks[0]).toBe(missing);
    expect(enabled.receipt.skippedMissingParents).toBe(1);
    expect(disabled.chunks).toBe(source);
    expect(disabled.chunks[0]).toBe(missing);
    expect(disabled.receipt).toEqual({
      attachedParents: 0,
      attachedCharacters: 0,
      skippedDuplicateParents: 0,
      skippedMissingParents: 0,
      skippedPointInTimeParents: 0,
      skippedBudgetParents: 0
    });
  });

  it("uses deterministic per-parent and total character budgets", () => {
    const firstParent = "abcdefghij";
    const secondParent = "klmnopqrst";
    const result = expandPostRerankParentContext([
      chunk("first", "first child", firstParent, { accession: "first-doc" }),
      chunk("second", "second child", secondParent, { accession: "second-doc" })
    ], {
      enabled: true,
      maxParentChars: 8,
      maxTotalParentChars: 11
    });

    expect(result.chunks[0]!.text).toContain("abcdefgh");
    expect(result.chunks[0]!.text).not.toContain("abcdefghi");
    expect(result.chunks[1]!.text).toContain("klm");
    expect(result.chunks[1]!.text).not.toContain("klmn");
    expect(result.receipt).toMatchObject({ attachedParents: 2, attachedCharacters: 11 });
  });

  it("removes an exact selected child from parent context instead of duplicating prompt text", () => {
    const child = "The company identified supply-chain disruption as a material risk.";
    const parent = `Risk factors introduction.\n\n${child}\n\nRisk factors conclusion.`;
    const result = expandPostRerankParentContext([chunk("child", child, parent)], { enabled: true });

    const rendered = result.chunks[0]!.text;
    expect(rendered).toContain("Risk factors introduction.");
    expect(rendered).toContain("Risk factors conclusion.");
    expect(rendered.split(child)).toHaveLength(2);
  });

  it("does not attach a parent when the selected child already is its entire text", () => {
    const child = "Only selected passage.";
    const source = chunk("only-child", child, child);
    const result = expandPostRerankParentContext([source], { enabled: true });

    expect(result.chunks).toEqual([source]);
    expect(result.chunks[0]).toBe(source);
    expect(result.receipt).toMatchObject({ attachedParents: 0, skippedDuplicateParents: 1 });
  });

  it("preserves strict point-in-time behavior and provenance without manufacturing another candidate", () => {
    const eligible = chunk("eligible", "eligible child", "eligible parent", {
      accession: "eligible-doc",
      acceptance_datetime: "2026-01-01T00:00:00.000Z"
    });
    const future = chunk("future", "future child", "future parent", {
      accession: "future-doc",
      acceptance_datetime: "2026-02-01T00:00:00.000Z"
    });
    const undated = chunk("undated", "undated child", "undated parent", {
      accession: "undated-doc",
      acceptance_datetime: undefined
    });

    const result = expandPostRerankParentContext([eligible, future, undated], {
      enabled: true,
      asOf: "2026-01-15T00:00:00.000Z",
      strictAsOf: true
    });

    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]!.text).toContain("eligible parent");
    expect(result.chunks[1]!.text).toBe(future.text);
    expect(result.chunks[2]!.text).toBe(undated.text);
    expect(result.chunks[0]!.id).toBe(eligible.id);
    expect(result.chunks[0]!.metadata).toBe(eligible.metadata);
    expect(result.receipt.skippedPointInTimeParents).toBe(2);
  });

  it("can expose the raw selected child to the opt-in attachment path while preserving legacy mapping by default", async () => {
    const { matchToChunk, matchToChunkWithOptions } = await import("../src/lib/vector-db");
    const match = {
      id: "child-vector",
      score: 0.91,
      metadata: {
        text: "[Filing: Example]\n\nselected child",
        parent_text: "complete parent section",
        source: "sec-edgar",
        acceptance_datetime: "2026-01-01T00:00:00.000Z"
      }
    };

    expect(matchToChunk(match).text).toContain("complete parent section");
    const rawChild = matchToChunkWithOptions(match, { includeParentText: false });
    expect(rawChild.text).toBe("[Filing: Example]\n\nselected child");
    expect(rawChild.metadata?.parent_text).toBe("complete parent section");
  });
});
