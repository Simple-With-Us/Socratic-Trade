import { beforeEach, describe, expect, it } from "vitest";
import { getStreamedHeadlines, newsStoreSize, recordStreamedArticle } from "../src/lib/streams/news-store";

// The store is a module-level globalThis-pinned Map with no reset hook; each test uses
// unique symbols so entries from other tests/files don't cross-contaminate assertions.

describe("news-store symbol normalization", () => {
  it("stores and retrieves headlines for a plain symbol", () => {
    recordStreamedArticle(["ZZZPLAIN"], "Plain symbol headline", "id-1");
    expect(getStreamedHeadlines("ZZZPLAIN", 60_000)).toEqual(["Plain symbol headline"]);
  });

  it("converts Alpaca's dot-notation share-class symbol to our hyphenated format on write", () => {
    // Regression: the news WebSocket stream tags articles with Alpaca's own dot notation
    // (BRK.B). Before this fix the store keyed on the raw dot symbol while
    // AlpacaNewsEnrichmentProvider always looks up the hyphenated internal symbol (BRK-B),
    // so streamed headlines for share-class tickers could never be found.
    recordStreamedArticle(["ZZZ.B"], "Share-class headline", "id-2");
    expect(getStreamedHeadlines("ZZZ-B", 60_000)).toEqual(["Share-class headline"]);
    expect(getStreamedHeadlines("ZZZ.B", 60_000)).toBeUndefined();
  });

  it("returns undefined for a symbol with no recorded headlines", () => {
    expect(getStreamedHeadlines("ZZZNEVER", 60_000)).toBeUndefined();
  });

  it("tracks store size as symbols are recorded", () => {
    const before = newsStoreSize();
    recordStreamedArticle(["ZZZUNIQUE"], "Unique headline", "id-3");
    expect(newsStoreSize()).toBe(before + 1);
  });
});

describe("news-store staleness and dedup", () => {
  beforeEach(() => {
    recordStreamedArticle(["ZZZSTALE"], "Original headline", "id-stale-1");
  });

  it("treats headlines older than maxAgeMs as absent", () => {
    expect(getStreamedHeadlines("ZZZSTALE", -1)).toBeUndefined();
  });

  it("dedups repeated article ids for the same symbol", () => {
    recordStreamedArticle(["ZZZSTALE"], "Original headline", "id-stale-1");
    expect(getStreamedHeadlines("ZZZSTALE", 60_000)?.length).toBe(1);
  });
});
