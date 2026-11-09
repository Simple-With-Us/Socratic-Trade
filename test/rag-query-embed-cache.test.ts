/**
 * Tests for the query-embedding LRU cache (R9, 2026-07-01 RAG backlog).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/lib/rag/chunk";
import {
  clearQueryEmbedCache,
  getCachedQueryEmbedding,
  queryEmbedCacheEnabled,
  queryEmbedCacheKey,
  queryEmbedCacheSize,
  setCachedQueryEmbedding
} from "../src/lib/rag/query-embed-cache";

describe("query-embed-cache", () => {
  beforeEach(() => {
    clearQueryEmbedCache();
    delete process.env.RAG_QUERY_EMBED_CACHE;
    delete process.env.RAG_QUERY_EMBED_CACHE_MAX;
    delete process.env.RAG_QUERY_EMBED_CACHE_TTL_MS;
  });
  afterEach(() => {
    clearQueryEmbedCache();
    delete process.env.RAG_QUERY_EMBED_CACHE;
    delete process.env.RAG_QUERY_EMBED_CACHE_MAX;
    delete process.env.RAG_QUERY_EMBED_CACHE_TTL_MS;
  });

  it("is enabled by default (consolidated G8b)", () => {
    expect(queryEmbedCacheEnabled()).toBe(true);
  });

  it("is a complete no-op when explicitly disabled: get always undefined, set never grows the cache", () => {
    process.env.RAG_QUERY_EMBED_CACHE = "off";
    setCachedQueryEmbedding("voyage-finance-2", "what is AAPL's PE ratio", [0.1, 0.2, 0.3]);
    expect(queryEmbedCacheSize()).toBe(0);
    expect(getCachedQueryEmbedding("voyage-finance-2", "what is AAPL's PE ratio")).toBeUndefined();
  });

  describe("when enabled", () => {
    beforeEach(() => {
      process.env.RAG_QUERY_EMBED_CACHE = "on";
    });

    it("caches and retrieves an embedding by (model, query)", () => {
      const vec = [0.1, 0.2, 0.3];
      setCachedQueryEmbedding("voyage-finance-2", "AAPL supply chain risk", vec);
      expect(getCachedQueryEmbedding("voyage-finance-2", "AAPL supply chain risk")).toEqual(vec);
    });

    it("misses on a different query or model", () => {
      setCachedQueryEmbedding("voyage-finance-2", "AAPL supply chain risk", [0.1, 0.2]);
      expect(getCachedQueryEmbedding("voyage-finance-2", "MSFT supply chain risk")).toBeUndefined();
      expect(getCachedQueryEmbedding("other-model", "AAPL supply chain risk")).toBeUndefined();
    });

    it("trims leading/trailing whitespace in the cache key (query.trim())", () => {
      setCachedQueryEmbedding("voyage-finance-2", "  AAPL risk  ", [0.5]);
      expect(getCachedQueryEmbedding("voyage-finance-2", "AAPL risk")).toEqual([0.5]);
    });

    it("the cache key omits userId and any per-user/filter context — only model+hash of the normalized query", () => {
      const key = queryEmbedCacheKey("voyage-finance-2", "AAPL risk");
      expect(key).toBe(`voyage-finance-2:${hashContent("aapl risk")}`);
      expect(key).not.toMatch(/user/i);
      expect(key).not.toContain("aapl risk");
    });

    it("normalizes casing and internal whitespace so trivial variants share a cache entry", () => {
      setCachedQueryEmbedding("voyage-finance-2", "AAPL   Guidance", [0.7]);
      expect(getCachedQueryEmbedding("voyage-finance-2", "  aapl guidance  ")).toEqual([0.7]);
    });

    it("expires an entry after the configured TTL", async () => {
      process.env.RAG_QUERY_EMBED_CACHE_TTL_MS = "10";
      setCachedQueryEmbedding("voyage-finance-2", "AAPL risk", [0.1]);
      expect(getCachedQueryEmbedding("voyage-finance-2", "AAPL risk")).toEqual([0.1]);
      await new Promise((r) => setTimeout(r, 30));
      expect(getCachedQueryEmbedding("voyage-finance-2", "AAPL risk")).toBeUndefined();
    });

    it("evicts the least-recently-used entry once RAG_QUERY_EMBED_CACHE_MAX is exceeded", () => {
      process.env.RAG_QUERY_EMBED_CACHE_MAX = "2";
      setCachedQueryEmbedding("m", "q1", [1]);
      setCachedQueryEmbedding("m", "q2", [2]);
      // Touch q1 so it's more-recently-used than q2.
      expect(getCachedQueryEmbedding("m", "q1")).toEqual([1]);
      // Adding q3 should evict q2 (the least-recently-used), not q1.
      setCachedQueryEmbedding("m", "q3", [3]);
      expect(getCachedQueryEmbedding("m", "q1")).toEqual([1]);
      expect(getCachedQueryEmbedding("m", "q2")).toBeUndefined();
      expect(getCachedQueryEmbedding("m", "q3")).toEqual([3]);
      expect(queryEmbedCacheSize()).toBe(2);
    });
  });
});
