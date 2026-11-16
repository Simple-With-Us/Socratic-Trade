import { describe, expect, it } from "vitest";
import { derivePromptRagConsumption, stableRagEvidenceRef, type PromptRagCandidate } from "../src/lib/rag/evidence-consumption";

function candidate(overrides: Partial<PromptRagCandidate> = {}): PromptRagCandidate {
  return {
    chunkId: "chunk-a",
    symbol: "AAPL",
    source: "sec-edgar",
    docType: "10-k",
    text: "Revenue grew 12%.",
    serializedText: "[10-K · AAPL]\nRevenue grew 12%.",
    ...overrides
  };
}

describe("RAG prompt-consumption receipts", () => {
  it("credits only chunks actually serialized and keeps retrieval-only candidates separate", () => {
    const used = candidate();
    const dropped = candidate({ chunkId: "chunk-b", text: "Risk rose.", serializedText: "[10-K · AAPL]\nRisk rose." });
    const receipt = derivePromptRagConsumption([used, dropped], [`dossier\n${used.serializedText}`]);

    expect(receipt.consumed).toMatchObject([{ chunkId: "chunk-a", state: "consumed" }]);
    expect(receipt.retrievedButNotConsumed).toMatchObject([{ chunkId: "chunk-b", state: "not_consumed" }]);
    expect(JSON.stringify(receipt)).not.toContain("Revenue grew");
    expect(JSON.stringify(receipt)).not.toContain("Risk rose");
  });

  it("records a prompt-tail chunk prefix as truncated, never as a whole consumed chunk", () => {
    const chunk = candidate({ serializedText: "[8-K · AAPL]\nMaterial agreement announced today." });
    const serialized = `dossier\n${chunk.serializedText.slice(0, 27)}`;
    const receipt = derivePromptRagConsumption([chunk], [serialized]);

    expect(receipt.consumed).toMatchObject([{ chunkId: "chunk-a", state: "truncated", consumedCharacters: 27 }]);
    expect(receipt.retrievedButNotConsumed).toEqual([]);
  });

  it("does not over-credit a prompt tail that contains only a chunk provenance header", () => {
    const chunk = candidate({ serializedText: "[10-K · AAPL]\nMaterial agreement announced today." });
    const headerOnly = "dossier\n[10-K · AAPL]\n";
    const receipt = derivePromptRagConsumption([chunk], [headerOnly]);

    expect(receipt.consumed).toEqual([]);
    expect(receipt.retrievedButNotConsumed).toMatchObject([
      { chunkId: "chunk-a", state: "not_consumed", consumedCharacters: 0 }
    ]);
  });

  it("deduplicates repeated retrieval rows by stable evidence ref", () => {
    const first = candidate();
    const duplicate = candidate({ score: 0.99, serializedText: first.serializedText });
    const receipt = derivePromptRagConsumption([first, duplicate], [first.serializedText]);

    expect(receipt.consumed).toHaveLength(1);
    expect(receipt.consumed[0]?.evidenceRef).toBe(stableRagEvidenceRef(first));
    expect(receipt).toMatchObject({
      outcome: "assembled",
      retrievedCandidateCount: 2,
      uniqueCandidateCount: 1,
      duplicateCandidateCount: 1
    });
  });

  it("keeps distinct legacy chunks separate when broad fallback fields collide", () => {
    const first = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "MD&A",
      ordinal: 3,
      contentHash: "content-hash-one",
      vectorNamespace: "managed:public",
      scope: "shared",
      tenantScope: "shared:operator"
    });
    const second = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "MD&A",
      ordinal: 4,
      contentHash: "content-hash-two",
      vectorNamespace: "managed:public",
      scope: "shared",
      tenantScope: "shared:operator",
      serializedText: "[10-K · AAPL]\nA second distinct legacy chunk."
    });

    const receipt = derivePromptRagConsumption([first, second], [first.serializedText, second.serializedText]);

    expect(stableRagEvidenceRef(first)).not.toBe(stableRagEvidenceRef(second));
    expect(receipt).toMatchObject({ uniqueCandidateCount: 2, duplicateCandidateCount: 0 });
    expect(receipt.consumed).toHaveLength(2);
  });

  it("credits only one of two distinct identical-text occurrences when one was budgeted out", () => {
    const first = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "MD&A",
      ordinal: 3,
      contentHash: "same-boilerplate"
    });
    const second = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "Risk Factors",
      ordinal: 4,
      contentHash: "same-boilerplate"
    });
    const receipt = derivePromptRagConsumption([first, second], [first.serializedText]);

    expect(receipt.uniqueCandidateCount).toBe(2);
    expect(receipt.consumed).toHaveLength(1);
    expect(receipt.retrievedButNotConsumed).toHaveLength(1);
  });

  it("makes empty, failed, and skipped retrieval outcomes explicit without persisting error text", () => {
    const empty = derivePromptRagConsumption([], [], { retrievalAttempted: true });
    const failed = derivePromptRagConsumption([], [], { retrievalAttempted: true, retrievalFailureCount: 2 });
    const skipped = derivePromptRagConsumption([], [], { retrievalAttempted: false });

    expect(empty).toMatchObject({ outcome: "empty", retrievalFailureCount: 0 });
    expect(failed).toMatchObject({ outcome: "retrieval_failed", retrievalFailureCount: 2 });
    expect(skipped).toMatchObject({ outcome: "not_attempted", retrievalFailureCount: 0 });
    expect(JSON.stringify(failed)).not.toContain("error");
  });

  it("keeps the stable ref independent of raw query or prompt text", () => {
    const first = candidate();
    const changedPrompt = candidate({ serializedText: "[10-K · AAPL]\nA differently formatted prompt excerpt." });

    expect(stableRagEvidenceRef(first)).toBe(stableRagEvidenceRef(changedPrompt));
    expect(stableRagEvidenceRef(first)).not.toContain("Revenue");
  });

  it("preserves ordinal zero in fallback evidence refs", () => {
    const zero = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "MD&A",
      ordinal: 0,
      contentHash: "hash-zero"
    });
    const missing = candidate({
      chunkId: undefined,
      accession: "0000123-26-000001",
      section: "MD&A",
      ordinal: undefined,
      contentHash: "hash-zero"
    });
    expect(stableRagEvidenceRef(zero)).not.toBe(stableRagEvidenceRef(missing));
  });
});
