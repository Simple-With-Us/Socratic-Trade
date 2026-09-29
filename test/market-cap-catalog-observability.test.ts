// marketCap is a SCORE-INPUT, not a cosmetic field — and the data catalog did not list it.
//
// `scoreFactors` (src/lib/market.ts) fans out to eight sub-scores, and THREE of them branch on
// `quote.marketCap`: liquidityScore (:1888, a log10 bucket), valueScore (:1986) and qualityScore
// (:2002). An absent market cap is not neutral — valueScore and qualityScore fall back to a flat
// 50/45 — so a screener regression that stops returning it silently re-scores the entire universe
// toward the middle with nothing anywhere going amber.
//
// These tests pin the catalog entry (so the admin data-catalog and the completeness report stop
// under-reporting the app's inputs) and pin the dependency itself, so a future refactor that drops
// marketCap from one of the three factors fails a test rather than quietly moving every score.
//
// The last case pins a DELIBERATE OMISSION and is the reason this file exists in this shape: see the
// comment on it before "fixing" it.

import { describe, expect, it } from "vitest";
import { CATALOG_FIELDS, catalogFieldsByCategory } from "../src/lib/data-catalog";
import { COVERAGE_TRACKED_FIELDS } from "../src/lib/enrichment-coverage";
import { scoreFactors } from "../src/lib/market";
import type { MarketQuote } from "../src/lib/types";

const BASE_QUOTE: MarketQuote = {
  symbol: "TEST",
  price: 100,
  volume: 1_000_000,
  score: 0
} as MarketQuote;

describe("marketCap is a catalogued field", () => {
  it("is listed with at least one real source and required provenance", () => {
    const field = CATALOG_FIELDS.find((f) => f.id === "marketCap");
    expect(field).toBeTruthy();
    expect(field!.category).toBe("quote");
    expect(field!.valueKind).toBe("number");
    expect(field!.provenanceRequired).toBe(true);
    // The only source that actually supplies it today is the Nasdaq delayed screener.
    expect(field!.sources.map((s) => s.sourceId)).toContain("nasdaq-delayed-screener");
  });

  it("appears in the quote category, so the completeness report counts it", () => {
    expect(catalogFieldsByCategory().quote?.some((f) => f.id === "marketCap")).toBe(true);
  });
});

describe("marketCap really does drive three of the eight score factors", () => {
  const withCap = scoreFactors({ ...BASE_QUOTE, marketCap: 50_000_000_000 });
  const withoutCap = scoreFactors(BASE_QUOTE);

  it("liquidity, value and quality all react to a present market cap", () => {
    // A $50B mega-cap must not score identically to a symbol with no market cap at all.
    expect(withCap.liquidity).not.toBe(withoutCap.liquidity);
    expect(withCap.value).not.toBe(withoutCap.value);
    expect(withCap.quality).not.toBe(withoutCap.quality);
  });

  it("a missing market cap collapses value and quality to their neutral fallbacks (50 / 45)", () => {
    // This is the exact failure mode the catalog entry exists to make visible: one dropped field
    // moves the whole universe to a flat middle instead of an obviously broken one.
    expect(withoutCap.value).toBe(50);
    expect(withoutCap.quality).toBe(45);
  });

  it("value still discriminates across market caps, so the branch is not a constant", () => {
    const mega = scoreFactors({ ...BASE_QUOTE, marketCap: 50_000_000_000 }).value;
    const small = scoreFactors({ ...BASE_QUOTE, marketCap: 200_000_000 }).value;
    expect(mega).toBeGreaterThan(small);
  });
});

describe("marketCap is deliberately NOT on the enrichment coverage board", () => {
  it("stays off COVERAGE_TRACKED_FIELDS until a cascade provider actually emits it", () => {
    // The audit that asked for marketCap on BOTH lists was half right. COVERAGE_TRACKED_FIELDS
    // records what the ENRICHMENT CASCADE filled for a symbol, and no registered enrichment
    // provider sets marketCap: the yahoo provider parses summaryDetail.marketCap but uses it only as
    // the fcfYield denominator, nasdaq-quote never reads the key, and the value the scores consume
    // comes from the universe SCREENER (toMarketQuote) and the imported ref cache. Adding the field
    // here would therefore add a PERMANENT 0% row — the exact crying-wolf board this same batch of
    // work is removing (the five dormant Quiver fields).
    //
    // This assertion is the tripwire. If a future change makes a cascade provider emit marketCap,
    // this test fails and the coverage board SHOULD gain the row at that point. See
    // docs/rollouts/2026-09-28-postmortem-and-coverage.md.
    expect(COVERAGE_TRACKED_FIELDS as readonly string[]).not.toContain("marketCap");
  });
});
