/**
 * Tests for R13 (isStale / citationStalenessEnabled) and R17 (stripPublishedPrefix /
 * embedCleanTextEnabled) pure helpers in vector-db.ts. No DB/Pinecone/Voyage mocking needed —
 * these are pure functions that don't touch the network or DB at call time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citationStalenessEnabled, embedCleanTextEnabled, isStale, stripPublishedPrefix } from "../src/lib/vector-db";

describe("citationStalenessEnabled (R13)", () => {
  beforeEach(() => delete process.env.RAG_CITATION_STALENESS);
  afterEach(() => delete process.env.RAG_CITATION_STALENESS);

  it("is on by default (owner enablement 2026-07-24); set off to disable", () => {
    expect(citationStalenessEnabled()).toBe(true);
    process.env.RAG_CITATION_STALENESS = "off";
    expect(citationStalenessEnabled()).toBe(false);
  });
  it("turns on with a truthy value", () => {
    process.env.RAG_CITATION_STALENESS = "on";
    expect(citationStalenessEnabled()).toBe(true);
  });
});

describe("isStale (R13) — advisory-only heuristic", () => {
  afterEach(() => {
    delete process.env.RAG_STALENESS_DAYS_10_K;
    delete process.env.RAG_STALENESS_DAYS_8_K;
  });

  it("returns undefined (not false) when there's no as_of to judge", () => {
    expect(isStale(undefined, "10-k")).toBeUndefined();
    expect(isStale("not-a-date", "10-k")).toBeUndefined();
  });

  it("a recent 8-K is not stale (within its ~90-day horizon)", () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(recent, "8-k")).toBe(false);
  });

  it("an old 8-K IS stale past its ~90-day horizon", () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(old, "8-k")).toBe(true);
  });

  it("a 10-K has a much longer horizon than an 8-K — the same age is stale for one, not the other", () => {
    const age150Days = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(age150Days, "8-k")).toBe(true); // past the ~90d 8-K horizon
    expect(isStale(age150Days, "10-k")).toBe(false); // well within the ~400d 10-K horizon
  });

  it("falls back to a generic horizon for an unknown/missing doc_type", () => {
    const age100Days = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(age100Days, undefined)).toBe(false); // within the 180d fallback
    const age200Days = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(age200Days, "some-unknown-type")).toBe(true); // past the 180d fallback
  });

  it("respects a per-doc_type horizon override via env", () => {
    process.env.RAG_STALENESS_DAYS_8_K = "1000"; // absurdly generous override
    const age200Days = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(age200Days, "8-k")).toBe(false);
  });
});

describe("embedCleanTextEnabled (R17)", () => {
  beforeEach(() => delete process.env.VECTOR_EMBED_CLEAN_TEXT);
  afterEach(() => delete process.env.VECTOR_EMBED_CLEAN_TEXT);

  it("is off by default", () => {
    expect(embedCleanTextEnabled()).toBe(false);
  });
  it("turns on with a truthy value", () => {
    process.env.VECTOR_EMBED_CLEAN_TEXT = "on";
    expect(embedCleanTextEnabled()).toBe(true);
  });
});

describe("currentEmbedRev (clean-text migration safety)", () => {
  beforeEach(() => delete process.env.VECTOR_EMBED_CLEAN_TEXT);
  afterEach(() => delete process.env.VECTOR_EMBED_CLEAN_TEXT);

  it("stays at 1 when clean-text is off", async () => {
    const { currentEmbedRev } = await import("../src/lib/vector-db");
    expect(currentEmbedRev()).toBe(1);
  });

  it("bumps to 2 when VECTOR_EMBED_CLEAN_TEXT is on so mixed populations stay distinguishable", async () => {
    process.env.VECTOR_EMBED_CLEAN_TEXT = "on";
    const { currentEmbedRev, embeddingSpaceRevisionForModel } = await import("../src/lib/vector-db");
    expect(currentEmbedRev()).toBe(2);
    expect(embeddingSpaceRevisionForModel("voyage-finance-2")).toBe("v2");
  });
});

describe("stripPublishedPrefix (R17)", () => {
  it("strips the [Published: YYYY-MM-DD] boilerplate prefix", () => {
    expect(stripPublishedPrefix("[Published: 2026-06-18] AAPL 8-K Item 2.02 details")).toBe("AAPL 8-K Item 2.02 details");
  });

  it("leaves text without the prefix unchanged", () => {
    expect(stripPublishedPrefix("AAPL 8-K Item 2.02 details")).toBe("AAPL 8-K Item 2.02 details");
  });

  it("only strips a well-formed date prefix, not a lookalike", () => {
    expect(stripPublishedPrefix("[Published: not-a-date] text")).toBe("[Published: not-a-date] text");
  });

  it("does not strip a context_header-prefixed chunk that never got the [Published:] boilerplate", () => {
    const headerText = "Ticker: AAPL | Type: 10-K | Section: Risk Factors\n\nSome risk factor text.";
    expect(stripPublishedPrefix(headerText)).toBe(headerText);
  });
});
