/**
 * Prompt data-age audit (2026-08-13, r4: dataage) — every data block reaching the strategist
 * (Green/Bull) prompt must carry an as-of/age signal. Most blocks already did (candidate `asOf`,
 * `marketScan.generatedAt`, `macroeconomicData.asOf`, congress/insider "in last Nd" bulletins,
 * learnedContext's inline `asserted=` dates, RAG chunk `formatChunkWithProvenance` dates) — see
 * docs/rollouts/2026-08-13-prompt-data-age-audit.md for the full block-by-block table. This file
 * covers the two blocks the audit found genuinely missing an age signal and fixed here
 * (`compactMarketScanForPrompt`'s new `newsAgeNote`/`predictionMarketsAgeNote`), plus a couple of
 * regression checks for the "already adequate" blocks that had no prior direct test.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketScan } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-prompt-data-age-${randomUUID()}.db`)}`;
});

afterEach(() => {
  delete process.env.POLYMARKET_CACHE_TTL_MS;
});

type Candidate = MarketScan["topCandidates"][number];

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    symbol: "TEST",
    price: 100,
    asOf: "2026-07-15T14:30:00.000Z",
    ...overrides
  } as Candidate;
}

function scan(topCandidates: Candidate[]): MarketScan {
  return {
    source: "test-source",
    generatedAt: "2026-08-13T14:00:00.000Z",
    scannedSymbols: topCandidates.length,
    returnedQuotes: topCandidates.length,
    topCandidates,
    sectorBySymbol: {},
    quotesBySymbol: {},
    warnings: []
  };
}

describe("compactMarketScanForPrompt — headline age honesty (news has no per-item timestamp)", () => {
  it("adds newsAgeNote at the BLOCK level (not per headline) when any candidate carries news", async () => {
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(
      scan([candidate({ symbol: "AAPL", headlines: ["Apple beats estimates on strong services growth"] })])
    );
    expect(compact?.newsAgeNote).toBeDefined();
    expect(compact?.newsAgeNote).toContain("no provider-supplied per-item publish timestamp");
    expect(compact?.newsAgeNote).toContain("UNKNOWN");
    // One line for the whole scan, not one per candidate/headline.
    expect(typeof compact?.newsAgeNote).toBe("string");
  });

  it("omits newsAgeNote entirely when no candidate has any headlines — never a scaffold with nothing to say", async () => {
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(scan([candidate({ symbol: "AAPL" })]));
    expect("newsAgeNote" in (compact ?? {})).toBe(false);
  });
});

describe("compactMarketScanForPrompt — Polymarket age honesty (cache-bounded, not a fabricated per-market timestamp)", () => {
  it("states the REAL configured cache TTL (default 10 minutes) as an upper bound, not an invented exact time", async () => {
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(
      scan([candidate({ symbol: "AAPL", polymarketLines: ['Polymarket: "Will AAPL beat Q3 EPS?" — Yes 62%'] })])
    );
    expect(compact?.predictionMarketsAgeNote).toBeDefined();
    expect(compact?.predictionMarketsAgeNote).toContain("10 minute(s)");
    expect(compact?.predictionMarketsAgeNote).toContain("cached");
  });

  it("reflects an overridden POLYMARKET_CACHE_TTL_MS knob rather than a hardcoded duplicate constant", async () => {
    process.env.POLYMARKET_CACHE_TTL_MS = String(3 * 60_000);
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(
      scan([candidate({ symbol: "AAPL", polymarketLines: ['Polymarket: "Will AAPL beat Q3 EPS?" — Yes 62%'] })])
    );
    expect(compact?.predictionMarketsAgeNote).toContain("3 minute(s)");
  });

  it("omits predictionMarketsAgeNote entirely when no candidate has Polymarket lines", async () => {
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(scan([candidate({ symbol: "AAPL" })]));
    expect("predictionMarketsAgeNote" in (compact ?? {})).toBe(false);
  });
});

describe("compactCandidateForPrompt — quotes/technicals already carry a per-candidate as-of stamp", () => {
  it("passes quote.asOf through verbatim (candidate data freshness)", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const compact = compactCandidateForPrompt(candidate({ asOf: "2026-08-13T13:57:00.000Z" }), 0);
    expect(compact.asOf).toBe("2026-08-13T13:57:00.000Z");
  });

  it("never fabricates an asOf when the pipeline has none for this candidate", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const withoutAsOf = { symbol: "TEST", price: 100 } as Candidate;
    const compact = compactCandidateForPrompt(withoutAsOf, 0);
    expect("asOf" in compact).toBe(false);
  });
});

describe("compactMarketScanForPrompt — generatedAt is always the block-level scan timestamp", () => {
  it("carries the scan's generatedAt regardless of per-candidate news/prediction-market presence", async () => {
    const { compactMarketScanForPrompt } = await import("../src/lib/strategy");
    const compact = compactMarketScanForPrompt(scan([candidate({})]));
    expect(compact?.generatedAt).toBe("2026-08-13T14:00:00.000Z");
  });
});
