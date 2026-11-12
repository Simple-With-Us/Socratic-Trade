// P1-5 (2026-09-27) — evidence depth must be able to CONTRADICT the ranking, not just re-read it.
//
// The scan surfaces 8+ candidates, but only the top 3 plus held names got an 8-chunk dossier; every
// other scored candidate got exactly ONE. That is an 8:1 tilt toward the existing ordering, so the
// extra evidence re-read the ranking rather than being able to contradict it — the names the ranking
// had demoted received the thinnest dossier of all.
//
// These pin the shape of the change and, importantly, pin the BUDGET claim: the raise is safe against
// token blowout (applyEvidenceBudget truncates and hard-caps) but NOT against within-RAG displacement,
// because the whole RAG block is one budget item and the tail is what gets cut.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/strategy.ts"), "utf8");

afterEach(() => {
  delete process.env.FILINGS_SCOUT_CHUNK_LIMIT;
});

describe("P1-5: evidence depth for non-deep candidates", () => {
  it("the non-deep limit is no longer 1 — the flat `isDeep ? 8 : 1` tilt is gone", () => {
    expect(source).not.toMatch(/isDeep\s*\?\s*8\s*:\s*1\b/);
    expect(source).toContain("scoutFilingsChunkLimit()");
  });

  it("the scout limit is configurable AND clamped, so it cannot blow the filings quota", async () => {
    const { scoutFilingsChunkLimit } = await import("../src/lib/strategy");
    expect(scoutFilingsChunkLimit()).toBe(3); // the default: low end of the intended 3-4
    process.env.FILINGS_SCOUT_CHUNK_LIMIT = "5";
    expect(scoutFilingsChunkLimit()).toBe(5);
    // Clamped at the deep limit: a bad env value can never exceed the 8 a deep symbol already uses.
    process.env.FILINGS_SCOUT_CHUNK_LIMIT = "999";
    expect(scoutFilingsChunkLimit()).toBe(8);
    // Floored at 1, so the tunable can never DISABLE evidence below the pre-change floor.
    process.env.FILINGS_SCOUT_CHUNK_LIMIT = "0";
    expect(scoutFilingsChunkLimit()).toBe(1);
    // A malformed value fails safe to the default rather than poisoning the retrieval loop.
    process.env.FILINGS_SCOUT_CHUNK_LIMIT = "not-a-number";
    expect(scoutFilingsChunkLimit()).toBe(3);
    delete process.env.FILINGS_SCOUT_CHUNK_LIMIT;
    expect(scoutFilingsChunkLimit()).toBe(3);
  });

  it("BUDGET: the raise cannot blow the token budget — applyEvidenceBudget truncates and hard-caps", async () => {
    const { applyEvidenceBudget } = await import("../src/lib/evidence-budget");
    const { createEvidenceRef } = await import("../src/lib/evidence-pack");

    // A RAG block far larger than the filings quota, which is exactly what more chunks produce.
    const huge = "x".repeat(200_000);
    const ref = createEvidenceRef({
      kind: "retrieved-financial-context",
      subject: "acct",
      source: {
        family: "filings",
        name: "vector-retrieval",
        status: "success",
        observedAt: null,
        asOf: null,
        retrievedAt: null,
        provenance: { provider: "vector-db", locator: null, upstreamHash: null, lineage: ["strategy-rag"] }
      },
      content: huge
    });
    const result = applyEvidenceBudget([{ ref, text: huge, priority: 100 }], {
      maxCharacters: 48_000,
      maxTokenEstimate: 12_000,
      familyQuotas: { filings: { maxCharacters: 24_000, maxTokenEstimate: 6_000 } }
    });
    // Truncated, never dropped, and never over the cap — so a deeper scout dossier cannot exceed the
    // prompt budget no matter how many chunks it produces.
    expect(result.included).toHaveLength(1);
    expect(result.included[0].truncated).toBe(true);
    expect(result.usedCharacters).toBeLessThanOrEqual(24_000);
    expect(result.usedTokenEstimate).toBeLessThanOrEqual(6_000);
    // The receipt is explicit rather than silent, which is what makes displacement diagnosable.
    const receipt = result.receipts[0];
    expect(receipt.action).toBe("truncated");
    expect(receipt.originalCharacters).toBe(200_000);
    expect(receipt.includedCharacters).toBeLessThan(receipt.originalCharacters);
  });
});
