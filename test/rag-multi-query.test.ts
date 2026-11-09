/**
 * hyde-multiquery-retrieval (2026-07-05): pure evidence-derived multi-query variant derivation.
 *
 * `deriveQueryVariants` is deterministic and I/O-free — no LLM, no network, no DB. These tests
 * cover the shape/count contract (2-4 facet sub-queries) and the empty-evidence fallback (a bare
 * symbol with no context returns `[]` so the caller falls back to its existing static query).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveQueryVariants, multiQueryEnabled, hydeEnabled } from "../src/lib/rag/multi-query";

describe("multiQueryEnabled / hydeEnabled (default-off flags)", () => {
  beforeEach(() => {
    delete process.env.RAG_MULTIQUERY;
    delete process.env.RAG_HYDE;
  });
  afterEach(() => {
    delete process.env.RAG_MULTIQUERY;
    delete process.env.RAG_HYDE;
  });

  it("RAG_MULTIQUERY is off by default", () => {
    expect(multiQueryEnabled()).toBe(false);
  });
  it("RAG_HYDE is off by default", () => {
    expect(hydeEnabled()).toBe(false);
  });
  it("RAG_MULTIQUERY turns on with 'on'", () => {
    process.env.RAG_MULTIQUERY = "on";
    expect(multiQueryEnabled()).toBe(true);
  });
  it("RAG_HYDE turns on with 'on'", () => {
    process.env.RAG_HYDE = "on";
    expect(hydeEnabled()).toBe(true);
  });
});

describe("deriveQueryVariants", () => {
  it("returns [] for a bare symbol with no evidence/sector/factor/regime/thesis context", () => {
    expect(deriveQueryVariants({ symbol: "AAPL" })).toEqual([]);
  });

  it("returns [] when symbol is empty/whitespace regardless of context", () => {
    expect(deriveQueryVariants({ symbol: "", sector: "Technology", evidenceBulletins: ["x"] })).toEqual([]);
    expect(deriveQueryVariants({ symbol: "   ", sector: "Technology" })).toEqual([]);
  });

  it("derives at least 2 variants when only sector context is present", () => {
    const variants = deriveQueryVariants({ symbol: "AAPL", sector: "Technology" });
    expect(variants.length).toBeGreaterThanOrEqual(2);
    expect(variants.length).toBeLessThanOrEqual(4);
    for (const v of variants) {
      expect(v).toContain("AAPL");
      expect(v).toContain("sector Technology");
    }
  });

  it("derives 3 variants when a dominantFactor is present (adds the litigation/regulatory facet)", () => {
    const variants = deriveQueryVariants({ symbol: "MSFT", dominantFactor: "momentum" });
    expect(variants.length).toBe(3);
    expect(variants.some((v) => /litigation|regulatory|compliance/i.test(v))).toBe(true);
  });

  it("derives 4 variants when 2+ evidence bulletins are present (adds the supply-chain facet)", () => {
    const variants = deriveQueryVariants({
      symbol: "NVDA",
      evidenceBulletins: ["Insider buying reported this week.", "Congress trade disclosed a purchase."]
    });
    expect(variants.length).toBe(4);
    expect(variants.some((v) => /supply chain|operational|production/i.test(v))).toBe(true);
    for (const v of variants) {
      expect(v).toContain("NVDA");
      expect(v).toContain("Recent evidence:");
    }
  });

  it("includes regime and thesis in the context suffix when provided", () => {
    const variants = deriveQueryVariants({ symbol: "TSLA", regimeLabel: "Risk-On", thesis: "momentum breakout" });
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const v of variants) {
      expect(v).toContain("market regime Risk-On");
      expect(v).toContain("thesis: momentum breakout");
    }
  });

  it("uppercases the symbol in generated variants", () => {
    const variants = deriveQueryVariants({ symbol: "aapl", sector: "Technology" });
    for (const v of variants) {
      expect(v).toContain("AAPL");
    }
  });

  it("is pure/deterministic: identical input produces identical output", () => {
    const input = { symbol: "AAPL", sector: "Technology", dominantFactor: "value", evidenceBulletins: ["a", "b"] };
    expect(deriveQueryVariants(input)).toEqual(deriveQueryVariants(input));
  });

  it("truncates long evidence bulletins rather than including them verbatim", () => {
    const longBulletin = "x".repeat(500);
    const variants = deriveQueryVariants({ symbol: "AAPL", evidenceBulletins: [longBulletin] });
    for (const v of variants) {
      expect(v.length).toBeLessThan(longBulletin.length);
    }
  });

  it("caps evidence bulletins fed into the query at 3", () => {
    const variants = deriveQueryVariants({
      symbol: "AAPL",
      evidenceBulletins: ["one", "two", "three", "four", "five"]
    });
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(v).not.toContain("four");
      expect(v).not.toContain("five");
    }
  });
});
