/**
 * Faithfulness / citation-grounding eval (R11, 2026-07-01 RAG backlog).
 *
 * docs/chat-assistant-rag-learning.md §5 asks for "recall@k/MRR + faithfulness". C1
 * (test/rag-retrieval-eval.test.ts) covers recall/MRR; this file covers faithfulness — whether a
 * model's cited/stated claims actually trace back to the retrieved chunks.
 *
 * Fully offline: no network, no API keys, no live LLM. The optional LLM-judge path is separately
 * unit-tested to confirm it no-ops without OPENROUTER_API_KEY — it is NEVER exercised for real here
 * (keeping this suite in the required/default `npm test` gate flake-free).
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractCitedChunkIds,
  extractNumericClaims,
  faithfulnessJudgeEnabled,
  judgeFaithfulness,
  scoreFaithfulness,
  summarizeFaithfulness
} from "../scripts/eval/faithfulness";
import { RAG_FAITHFULNESS_FIXTURE } from "./fixtures/rag-faithfulness-fixture";

describe("extractCitedChunkIds", () => {
  it("extracts bracketed citations", () => {
    expect(extractCitedChunkIds("Revenue grew [AAPL-10Q#c001] and margins improved [AAPL-10Q#c002].")).toEqual([
      "AAPL-10Q#c001",
      "AAPL-10Q#c002"
    ]);
  });

  it("extracts (source: id) style citations", () => {
    expect(extractCitedChunkIds("Revenue grew (source: AAPL-10Q#c001).")).toEqual(["AAPL-10Q#c001"]);
  });

  it("dedupes repeated citations", () => {
    expect(extractCitedChunkIds("[c1] and again [c1]")).toEqual(["c1"]);
  });

  it("returns empty array when there are no citations", () => {
    expect(extractCitedChunkIds("No citations here at all.")).toEqual([]);
  });
});

describe("extractNumericClaims", () => {
  it("extracts dollar amounts with a magnitude suffix", () => {
    expect(extractNumericClaims("Revenue was $90.8 billion this quarter.")).toContain("$90.8 billion");
  });

  it("extracts percentages", () => {
    expect(extractNumericClaims("Growth of 12% year over year.")).toContain("12%");
  });

  it("does not double-count a number already captured inside a $ or % claim", () => {
    const claims = extractNumericClaims("Revenue was $90.8 billion, up 5%.");
    // "90.8" and "5" should not ALSO appear as bare-number claims once captured by $/%.
    expect(claims).not.toContain("90.8");
    expect(claims).not.toContain("5");
  });

  it("skips single-digit bare numbers (noise floor)", () => {
    expect(extractNumericClaims("We have 3 segments.")).not.toContain("3");
  });
});

describe("scoreFaithfulness (deterministic floor)", () => {
  for (const testCase of RAG_FAITHFULNESS_FIXTURE) {
    it(`case "${testCase.id}" scores as expected`, () => {
      const result = scoreFaithfulness(testCase);
      // Every fixture id encodes its expected verdict in its name for a self-documenting assertion.
      const expectFail = testCase.id.startsWith("fabricated-") || testCase.id.startsWith("hallucinated-");
      if (expectFail) {
        expect(result.pass, `expected case "${testCase.id}" to FAIL the deterministic floor`).toBe(false);
      } else {
        expect(result.pass, `expected case "${testCase.id}" to PASS the deterministic floor: ${JSON.stringify(result)}`).toBe(true);
      }
    });
  }

  it("flags a fabricated citation as an unsupported citation, not a numeric-claim failure", () => {
    const result = scoreFaithfulness(RAG_FAITHFULNESS_FIXTURE.find((c) => c.id === "fabricated-citation")!);
    expect(result.citationsGrounded).toBe(false);
    expect(result.unsupportedCitations).toContain("AAPL-10Q#c999");
    expect(result.numericClaimsSupported).toBe(true); // the $90.8B figure IS in the retrieved text
  });

  it("flags a hallucinated numeric claim, not a citation failure", () => {
    const result = scoreFaithfulness(RAG_FAITHFULNESS_FIXTURE.find((c) => c.id === "hallucinated-numeric")!);
    expect(result.citationsGrounded).toBe(true); // the cited chunk id IS in the retrieved set
    expect(result.numericClaimsSupported).toBe(false);
    expect(result.unsupportedNumericClaims).toContain("$120.4 billion");
  });

  it("handles multi-chunk answers where each claim is grounded in a DIFFERENT chunk", () => {
    const result = scoreFaithfulness(RAG_FAITHFULNESS_FIXTURE.find((c) => c.id === "multi-chunk-grounded")!);
    expect(result.pass).toBe(true);
  });

  it("supports the (source: id) citation style", () => {
    const result = scoreFaithfulness(RAG_FAITHFULNESS_FIXTURE.find((c) => c.id === "source-paren-citation-style")!);
    expect(result.citationsGrounded).toBe(true);
  });
});

describe("summarizeFaithfulness", () => {
  it("reports a citation-support rate and unsupported-claim count across the fixture", () => {
    const results = RAG_FAITHFULNESS_FIXTURE.map(scoreFaithfulness);
    const summary = summarizeFaithfulness(results);
    expect(summary.total).toBe(RAG_FAITHFULNESS_FIXTURE.length);
    // Exactly one fixture case (fabricated-citation) has an unsupported citation.
    expect(summary.citationSupportRate).toBeCloseTo((RAG_FAITHFULNESS_FIXTURE.length - 1) / RAG_FAITHFULNESS_FIXTURE.length, 5);
    // Exactly one unsupported numeric claim across the whole fixture (hallucinated-numeric).
    expect(summary.unsupportedClaimCount).toBe(1);
  });

  it("returns a citationSupportRate of 1 for an empty result set (no false 0/0 signal)", () => {
    expect(summarizeFaithfulness([]).citationSupportRate).toBe(1);
  });
});

describe("faithfulnessJudgeEnabled / judgeFaithfulness (LLM judge stays default-off, no network)", () => {
  it("is disabled by default (no env vars set)", () => {
    const savedFlag = process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(faithfulnessJudgeEnabled()).toBe(false);
    } finally {
      if (savedFlag !== undefined) process.env.RAG_EVAL_FAITHFULNESS_JUDGE = savedFlag;
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it("stays disabled when the flag is on but OPENROUTER_API_KEY is unset (fail-closed on missing key)", () => {
    const savedFlag = process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.RAG_EVAL_FAITHFULNESS_JUDGE = "on";
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(faithfulnessJudgeEnabled()).toBe(false);
    } finally {
      if (savedFlag === undefined) delete process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
      else process.env.RAG_EVAL_FAITHFULNESS_JUDGE = savedFlag;
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it("judgeFaithfulness no-ops (never calls fetch/network) when disabled", async () => {
    const savedFlag = process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
    delete process.env.RAG_EVAL_FAITHFULNESS_JUDGE;
    const fetchSpy = vi.spyOn(global, "fetch");
    try {
      const result = await judgeFaithfulness(RAG_FAITHFULNESS_FIXTURE[0]!);
      expect(result.ran).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (savedFlag !== undefined) process.env.RAG_EVAL_FAITHFULNESS_JUDGE = savedFlag;
      fetchSpy.mockRestore();
    }
  });
});
