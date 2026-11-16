/**
 * news-relevance.ts — deterministic entity-relevance rubric for provider headlines with no
 * native provider relevance score. Leaf module (no imports), so this file exercises it directly
 * with no DB/network setup needed.
 */
import { describe, expect, it } from "vitest";
import { AMBIGUOUS_COMPANY_NAMES, scoreHeadlineRelevance } from "../src/lib/news-relevance";

describe("scoreHeadlineRelevance", () => {
  it("scores a bare ticker mention highly", () => {
    const { score, reasons } = scoreHeadlineRelevance("AAPL reports record quarterly revenue", "AAPL");
    expect(score).toBeGreaterThanOrEqual(0.9);
    expect(reasons.some((r) => /ticker "AAPL" matched/.test(r))).toBe(true);
  });

  it("scores a $TICKER cashtag mention the same as a bare ticker", () => {
    const bare = scoreHeadlineRelevance("AAPL shares climb after earnings beat", "AAPL");
    const cashtag = scoreHeadlineRelevance("$AAPL shares climb after earnings beat", "AAPL");
    expect(cashtag.score).toBe(bare.score);
  });

  it("does not match a ticker embedded inside a longer word (no false substring match)", () => {
    const { score, reasons } = scoreHeadlineRelevance("SNAAPLE unveils new snack flavor", "AAPL");
    expect(score).toBe(0);
    expect(reasons.some((r) => /ticker "AAPL" not found/.test(r))).toBe(true);
  });

  it("is case-insensitive for ticker matches", () => {
    const { score } = scoreHeadlineRelevance("aapl slides on weak guidance", "AAPL");
    expect(score).toBeGreaterThan(0);
  });

  it("scores a non-ambiguous company name match without requiring corroboration", () => {
    const { score, reasons } = scoreHeadlineRelevance("Nvidia unveils new laptop chips at trade show", "NVDA", "Nvidia");
    expect(score).toBeGreaterThan(0);
    expect(reasons.some((r) => /company name "Nvidia" matched/.test(r))).toBe(true);
  });

  it("strips a trailing corporate suffix so 'Inc.' and the bare name match the same way", () => {
    const withSuffix = scoreHeadlineRelevance("Nvidia Inc. unveils new laptop chips", "NVDA", "Nvidia Inc.");
    const bare = scoreHeadlineRelevance("Nvidia unveils new laptop chips", "NVDA", "Nvidia");
    expect(withSuffix.score).toBe(bare.score);
  });

  it("adds ticker and non-ambiguous company-name signals additively, capped at 1", () => {
    const tickerOnly = scoreHeadlineRelevance("NVDA slides after chip export curbs announced", "NVDA");
    const both = scoreHeadlineRelevance("NVDA: Nvidia reports record earnings, guidance raised", "NVDA", "Nvidia");
    expect(both.score).toBeGreaterThan(tickerOnly.score);
    expect(both.score).toBeLessThanOrEqual(1); // 0.9 ticker + 0.6 name would exceed 1 unclamped
  });

  it("an ambiguous company-name match adds nothing on top of an already-matched ticker without corroboration", () => {
    const tickerOnly = scoreHeadlineRelevance("AAPL: Apple Inc. reports record iPhone sales", "AAPL");
    const tickerAndName = scoreHeadlineRelevance("AAPL: Apple Inc. reports record iPhone sales", "AAPL", "Apple Inc.");
    // "reports"/"record"/"sales" are not in FINANCE_EVENT_TERMS, so the ambiguous "Apple" match
    // stays uncorroborated and contributes 0 — the two scores are identical.
    expect(tickerAndName.score).toBe(tickerOnly.score);
  });

  it("scores 0 for a headline with no ticker or company-name evidence at all", () => {
    const { score, reasons } = scoreHeadlineRelevance("Regional bakery chain opens new downtown location", "AAPL");
    expect(score).toBe(0);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("returns 0 with a clear reason for empty headline or symbol", () => {
    expect(scoreHeadlineRelevance("", "AAPL").score).toBe(0);
    expect(scoreHeadlineRelevance("   ", "AAPL").score).toBe(0);
    expect(scoreHeadlineRelevance("Apple news today", "").score).toBe(0);
  });

  describe("ambiguous company names (require finance-event corroboration)", () => {
    it("every documented example name is present in AMBIGUOUS_COMPANY_NAMES", () => {
      for (const name of ["apple", "meta", "square", "block", "target", "gap", "oracle", "shell", "visa", "camden", "arch"]) {
        expect(AMBIGUOUS_COMPANY_NAMES[name]).toBe(true);
      }
    });

    it("an ambiguous name match with NO finance-event term scores 0 (ordinary-word sense)", () => {
      const { score, reasons } = scoreHeadlineRelevance("She picked up an apple from the fruit stand", "AAPL", "Apple");
      expect(score).toBe(0);
      expect(reasons.some((r) => /ambiguous company name "Apple" matched but no corroborating/.test(r))).toBe(true);
    });

    it("an ambiguous name match WITH a co-occurring finance-event term scores nonzero", () => {
      const { score, reasons } = scoreHeadlineRelevance("Apple warns on next-quarter earnings guidance", "AAPL", "Apple");
      expect(score).toBeGreaterThan(0);
      expect(reasons.some((r) => /ambiguous company name "Apple" matched, corroborated/.test(r))).toBe(true);
    });

    it("target (retailer) requires corroboration the same way", () => {
      const noSignal = scoreHeadlineRelevance("Analysts missed their target for the quarter", "TGT", "Target");
      const withSignal = scoreHeadlineRelevance("Target discloses SEC filing after accounting review", "TGT", "Target");
      expect(noSignal.score).toBe(0);
      expect(withSignal.score).toBeGreaterThan(0);
    });

    it("shell (Shell plc vs. a beach shell) requires corroboration the same way", () => {
      const noSignal = scoreHeadlineRelevance("Child finds a rare shell washed up on the beach", "SHEL", "Shell");
      const withSignal = scoreHeadlineRelevance("Shell reports record quarterly profit forecast", "SHEL", "Shell");
      expect(noSignal.score).toBe(0);
      expect(withSignal.score).toBeGreaterThan(0);
    });
  });

  describe("aliases option", () => {
    it("scores an alias under the exact same rubric as companyName", () => {
      const { score, reasons } = scoreHeadlineRelevance(
        "Facebook parent posts strong quarterly earnings report",
        "META",
        undefined,
        { aliases: ["Facebook"] }
      );
      expect(score).toBeGreaterThan(0);
      expect(reasons.some((r) => /company name "Facebook" matched/.test(r))).toBe(true);
    });

    it("applies the ambiguous-name corroboration gate to an ambiguous alias too", () => {
      const { score } = scoreHeadlineRelevance(
        "He built a wooden block for the toddler",
        "SQ",
        undefined,
        { aliases: ["Block"] }
      );
      expect(score).toBe(0);
    });
  });
});
