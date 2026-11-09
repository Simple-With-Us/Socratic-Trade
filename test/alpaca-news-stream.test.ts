/**
 * filterRelevantStreamSymbols — NEWS_RELEVANCE_FILTER / NEWS_RELEVANCE_MIN_SCORE gating of the
 * Alpaca/Benzinga news stream's per-article symbol tags (src/lib/streams/alpaca-news-stream.ts).
 * The stream has no native per-symbol relevance score, so this uses news-relevance.ts's headline-
 * text rubric directly, symbol by symbol, and drops only the low-relevance symbol's ASSOCIATION
 * with the article — never the whole article.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-news-stream-${randomUUID()}.db`)}`;
});

describe("filterRelevantStreamSymbols", () => {
  const originalFilter = process.env.NEWS_RELEVANCE_FILTER;
  const originalMinScore = process.env.NEWS_RELEVANCE_MIN_SCORE;

  beforeEach(() => {
    delete process.env.NEWS_RELEVANCE_FILTER;
    delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  afterEach(() => {
    if (originalFilter) process.env.NEWS_RELEVANCE_FILTER = originalFilter;
    else delete process.env.NEWS_RELEVANCE_FILTER;
    if (originalMinScore) process.env.NEWS_RELEVANCE_MIN_SCORE = originalMinScore;
    else delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  it("with the filter ON (default), drops a low-relevance symbol's association while keeping other relevant symbols on the same article", async () => {
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    // Names AAPL by ticker; MSFT is not mentioned anywhere in the headline text at all.
    const kept = filterRelevantStreamSymbols("AAPL reports record quarterly earnings", ["AAPL", "MSFT"]);
    expect(kept).toEqual(["AAPL"]); // MSFT's association dropped, AAPL's kept — article not discarded
  });

  it("keeps every symbol actually named in a broad multi-symbol roundup headline", async () => {
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    const kept = filterRelevantStreamSymbols("AAPL and MSFT both climb after Fed guidance", ["AAPL", "MSFT"]);
    expect(kept).toEqual(["AAPL", "MSFT"]);
  });

  it("returns an empty array when NO tagged symbol is actually named in the headline text", async () => {
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    const kept = filterRelevantStreamSymbols("Regional bakery chain opens new downtown location", ["AAPL", "MSFT"]);
    expect(kept).toEqual([]);
  });

  it("with the filter OFF, returns every tagged symbol unchanged regardless of headline text", async () => {
    process.env.NEWS_RELEVANCE_FILTER = "0";
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    const kept = filterRelevantStreamSymbols("Regional bakery chain opens new downtown location", ["AAPL", "MSFT"]);
    expect(kept).toEqual(["AAPL", "MSFT"]);
  });

  it("accumulates dropped associations in the in-memory counter, only for symbols actually dropped", async () => {
    const {
      filterRelevantStreamSymbols,
      resetStreamRelevanceDroppedAssociationCount,
      streamRelevanceDroppedAssociationCount
    } = await import("../src/lib/streams/alpaca-news-stream");
    resetStreamRelevanceDroppedAssociationCount();
    filterRelevantStreamSymbols("AAPL reports record quarterly earnings", ["AAPL", "MSFT"]); // drops MSFT only
    expect(streamRelevanceDroppedAssociationCount()).toBe(1);
    filterRelevantStreamSymbols("AAPL and MSFT both climb after Fed guidance", ["AAPL", "MSFT"]); // drops nothing
    expect(streamRelevanceDroppedAssociationCount()).toBe(1);
  });

  it("always trusts provider attribution on single-symbol articles", async () => {
    // The stream payload carries no company name, so a headline naming the company but not the
    // ticker scores 0 here — Benzinga's own tag is the only signal, and it must win.
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    const kept = filterRelevantStreamSymbols("Apple beats estimates on services strength", ["AAPL"]);
    expect(kept).toEqual(["AAPL"]);
  });

  it("drops only zero-evidence symbols on multi-symbol articles, keeping scored ones", async () => {
    const { filterRelevantStreamSymbols } = await import("../src/lib/streams/alpaca-news-stream");
    const kept = filterRelevantStreamSymbols("AAPL reports record quarterly earnings", ["AAPL", "MSFT"]);
    expect(kept).toEqual(["AAPL"]);
  });
});
