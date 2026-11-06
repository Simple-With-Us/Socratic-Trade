import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-vector-retrieval-${randomUUID()}.db`)}`;

const {
  activeEmbeddingProvider,
  activeRerankModel,
  activeRerankProvider,
  buildExtraFilters,
  defaultMinScore,
  filterMatchesForTranscriptRights,
  isWithinAsOf,
  matchToChunk,
  rankPool,
  rerankMatches
} = await import("../src/lib/vector-db");

describe("buildExtraFilters", () => {
  beforeEach(() => vi.stubEnv("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("is empty with no options while transcript storage/display rights are confirmed", () => {
    expect(buildExtraFilters()).toEqual({});
    expect(buildExtraFilters({})).toEqual({});
  });
  it("excludes transcripts from broad and explicit retrieval when rights are unconfirmed", () => {
    vi.stubEnv("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", "off");
    vi.stubEnv("ROIC_API_KEY", "");
    vi.stubEnv("ROIC_TRANSCRIPTS_DISABLED", "");
    // Broad queries preserve server-side recall for legacy vectors that lack doc_type; the
    // post-fetch guard below removes transcripts before ranking/prompt injection.
    expect(buildExtraFilters()).toEqual({});

    const mixed = buildExtraFilters({ docType: ["10-k", "earnings-transcript"] }).doc_type as { $in: string[] };
    expect(new Set(mixed.$in)).toEqual(new Set(["10-k", "10-K"]));
    expect(buildExtraFilters({ docType: ["earnings-transcript"] })).toEqual({
      doc_type: { $eq: "__earnings_transcript_rights_unconfirmed__" }
    });

    const legacy = { id: "legacy", metadata: { source: "sec-edgar" } };
    const filing = { id: "filing", metadata: { doc_type: "10-k" } };
    const transcript = { id: "transcript", metadata: { doc_type: "EARNINGS-TRANSCRIPT" } };
    expect(filterMatchesForTranscriptRights([legacy, filing, transcript])).toEqual([legacy, filing]);
  });
  it("admits ROIC earnings-transcript chunks when the ROIC key is on and FMP/EarningsCalls are off", () => {
    vi.stubEnv("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", "off");
    vi.stubEnv("EARNINGSCALLS_API_KEY", "");
    vi.stubEnv("EARNINGSCALLS_RAPIDAPI_KEY", "");
    vi.stubEnv("ROIC_API_KEY", "test-roic-key");
    vi.stubEnv("ROIC_TRANSCRIPTS_DISABLED", "");
    const explicit = buildExtraFilters({ docType: ["earnings-transcript"] }).doc_type as { $in: string[] };
    expect(new Set(explicit.$in)).toEqual(new Set(["earnings-transcript", "EARNINGS-TRANSCRIPT"]));
    const roic = { id: "roic", metadata: { doc_type: "earnings-transcript", source: "roic-earnings-transcript" } };
    const fmp = { id: "fmp", metadata: { doc_type: "earnings-transcript", source: "fmp-earnings-transcript" } };
    expect(filterMatchesForTranscriptRights([roic, fmp])).toEqual([roic]);
    vi.stubEnv("ROIC_TRANSCRIPTS_DISABLED", "1");
    expect(filterMatchesForTranscriptRights([roic, fmp])).toEqual([]);
    expect(buildExtraFilters({ source: "roic-earnings-transcript" })).toEqual({
      source: { $eq: "__roic_transcripts_disabled__" }
    });
  });
  it("leaves broad transcript matches available while rights are confirmed", async () => {
    const { activateFmpTranscriptRightsGeneration } = await import("../src/lib/web-sources/fmp-transcripts");
    activateFmpTranscriptRightsGeneration();
    const matches = [{ id: "transcript", metadata: { doc_type: "earnings-transcript" } }];
    expect(filterMatchesForTranscriptRights(matches)).toBe(matches);
  });
  it("keeps transcripts blocked when the env flag is on but the durable rights gate is revoked", async () => {
    const {
      activateFmpTranscriptRightsGeneration
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    activateFmpTranscriptRightsGeneration();
    getDb().prepare(`
      UPDATE fmp_transcript_rights_gate
      SET generation = generation + 1, status = 'revoked', updated_at = ?
      WHERE singleton = 1
    `).run(new Date().toISOString());

    expect(buildExtraFilters({ docType: ["earnings-transcript"] })).toEqual({
      doc_type: { $eq: "__earnings_transcript_rights_unconfirmed__" }
    });
    expect(buildExtraFilters({ source: "fmp-earnings-transcript" })).toEqual({
      source: { $eq: "__fmp_transcript_rights_unconfirmed__" }
    });
    const matches = [{ id: "transcript", metadata: { doc_type: "earnings-transcript", source: "fmp-earnings-transcript" } }];
    expect(filterMatchesForTranscriptRights(matches)).toEqual([]);
  });
  it("admits only the active generation of FMP-derived decision memory", async () => {
    const {
      activateFmpTranscriptRightsGeneration,
      captureFmpTranscriptRightsGeneration
    } = await import("../src/lib/web-sources/fmp-transcripts");
    activateFmpTranscriptRightsGeneration();
    const generation = captureFmpTranscriptRightsGeneration()!.generation;
    const current = {
      id: "current-derived",
      metadata: { fmp_derived: true, fmp_rights_generation: generation }
    };
    const stale = {
      id: "stale-derived",
      metadata: { fmp_derived: true, fmp_rights_generation: generation - 1 }
    };

    expect(filterMatchesForTranscriptRights([current, stale])).toEqual([current]);
    vi.stubEnv("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", "off");
    expect(filterMatchesForTranscriptRights([current, stale])).toEqual([]);
  });
  it("matches doc_type across casings (stored values are inconsistent: '10-K' vs '8-k')", () => {
    // Each requested type expands to original + lower + upper, deduped — so a lowercase filter still
    // matches uppercase-stored "10-K"/"10-Q" chunks (the bug this fixes), and vice-versa.
    const f = buildExtraFilters({ docType: ["10-k", "10-q"] }).doc_type as { $in: string[] };
    expect(new Set(f.$in)).toEqual(new Set(["10-k", "10-K", "10-q", "10-Q"]));
    // An already-uppercase request stays matched too.
    const u = buildExtraFilters({ docType: ["8-K"] }).doc_type as { $in: string[] };
    expect(new Set(u.$in)).toEqual(new Set(["8-K", "8-k"]));
  });
  it("builds section / source clauses unchanged", () => {
    expect(buildExtraFilters({ section: "risk_factors" })).toEqual({ section: { $eq: "risk_factors" } });
    expect(buildExtraFilters({ source: "sec-8k" })).toEqual({ source: { $eq: "sec-8k" } });
  });
  it("builds an exact connected-account memory filter and fails closed when its id is absent", () => {
    expect(buildExtraFilters({ accountScope: "exact", connectedAccountId: "account-a" })).toEqual({
      connected_account_id: { $eq: "account-a" }
    });
    expect(buildExtraFilters({ accountScope: "exact" })).toEqual({
      connected_account_id: { $eq: "__missing_connected_account__" }
    });
  });
  it("exact-or-user admits this account's memory OR pooled user-level private lessons (ST-4589 B2)", async () => {
    const filter = buildExtraFilters({ accountScope: "exact-or-user", connectedAccountId: "account-a" });
    expect(filter).toEqual({
      $and: [
        {
          $or: [
            { connected_account_id: { $eq: "account-a" } },
            { $and: [{ memory_scope: { $eq: "user" } }, { scope: { $eq: "private" } }] }
          ]
        }
      ]
    });
    // Spread into a tier filter that has its own top-level `$or`, both clauses survive and the
    // Qdrant translator accepts the shape (it refuses anything it cannot translate).
    const tier: Record<string, unknown> = { userId: { $eq: "u1" }, ...filter, $or: [{ tenant_scope: { $eq: "private:u1" } }] };
    expect(tier.$and).toBeDefined();
    expect(tier.$or).toBeDefined();
    const { pineconeFilterToQdrant } = await import("../src/lib/vector-store/pinecone-filter-to-qdrant");
    expect(() => pineconeFilterToQdrant(tier)).not.toThrow();
    // A missing account id still fails closed on the account branch.
    const missing = buildExtraFilters({ accountScope: "exact-or-user" }) as { $and: Array<{ $or: unknown[] }> };
    expect(missing.$and[0].$or[0]).toEqual({ connected_account_id: { $eq: "__missing_connected_account__" } });
  });
  it("ignores an empty docType array", () => {
    expect(buildExtraFilters({ docType: [] })).toEqual({});
  });
});

describe("defaultMinScore", () => {
  const prev = process.env.VECTOR_MIN_SCORE;
  afterEach(() => { if (prev === undefined) delete process.env.VECTOR_MIN_SCORE; else process.env.VECTOR_MIN_SCORE = prev; });
  it("defaults to 0.30, reads VECTOR_MIN_SCORE, and clamps to [0,1]", () => {
    delete process.env.VECTOR_MIN_SCORE;
    expect(defaultMinScore()).toBe(0.3);
    process.env.VECTOR_MIN_SCORE = "0"; expect(defaultMinScore()).toBe(0); // disable floor
    process.env.VECTOR_MIN_SCORE = "0.55"; expect(defaultMinScore()).toBe(0.55);
    process.env.VECTOR_MIN_SCORE = "9"; expect(defaultMinScore()).toBe(1); // clamp high
    process.env.VECTOR_MIN_SCORE = "-1"; expect(defaultMinScore()).toBe(0); // clamp low
    process.env.VECTOR_MIN_SCORE = "nonsense"; expect(defaultMinScore()).toBe(0.3); // fallback
  });
});

function fakeVoyage(impl: (args: { documents: string[]; topK?: number }) => any) {
  return { rerank: async (args: any) => impl(args) } as any;
}

const m = (id: string, text: string, score: number) => ({ id, score, metadata: { text } });

describe("rerankMatches", () => {
  it("reorders matches by the reranker's returned index order and caps at topK", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8), m("c", "gamma", 0.7)];
    // Reranker says doc index 2 is most relevant, then 0.
    const voyage = fakeVoyage(() => ({ data: [{ index: 2, relevanceScore: 0.99 }, { index: 0, relevanceScore: 0.5 }] }));
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("falls back to the input order when the reranker throws", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8)];
    const voyage = fakeVoyage(() => { throw new Error("rate limited"); });
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("returns input unchanged for <=1 match or all-empty documents (no rerank call needed)", async () => {
    const one = [m("a", "alpha", 0.9)];
    expect((await rerankMatches(fakeVoyage(() => { throw new Error("should not be called"); }), "q", one, 3)).map((x) => x.id)).toEqual(["a"]);
    const empty = [{ id: "x", score: 0.5, metadata: {} }, { id: "y", score: 0.4, metadata: {} }];
    expect((await rerankMatches(fakeVoyage(() => { throw new Error("should not be called"); }), "q", empty, 2)).map((x) => x.id)).toEqual(["x", "y"]);
  });

  it("falls back when the reranker returns no data", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8)];
    const out = await rerankMatches(fakeVoyage(() => ({ data: [] })), "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  // Item 2 (2026-07-01 RAG workstream): the reranker's own relevanceScore was previously discarded —
  // rerankMatches only reordered by index, and matchToChunk only read Pinecone's cosine `score`.
  it("attaches the reranker's relevanceScore onto each reordered match (not just reordering by index)", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8), m("c", "gamma", 0.7)];
    const voyage = fakeVoyage(() => ({
      data: [{ index: 2, relevanceScore: 0.95 }, { index: 0, relevanceScore: 0.4 }]
    }));
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["c", "a"]);
    // matchToChunk reads _rerankScore into RetrievedChunk.relevanceScore.
    expect(matchToChunk(out[0]).relevanceScore).toBe(0.95);
    expect(matchToChunk(out[1]).relevanceScore).toBe(0.4);
  });

  it("matchToChunk omits relevanceScore when reranking never ran (no _rerankScore on the match)", () => {
    const chunk = matchToChunk(m("a", "alpha", 0.9));
    expect(chunk.relevanceScore).toBeUndefined();
    expect(chunk.score).toBe(0.9); // cosine score is unaffected either way
  });

  it("does not attach relevanceScore when the reranker response omits it for a given item", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8)];
    // Reranker returns an index with no relevanceScore field (some responses may omit it).
    const voyage = fakeVoyage(() => ({ data: [{ index: 1 }, { index: 0 }] }));
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(matchToChunk(out[0]).relevanceScore).toBeUndefined();
  });
});

describe("independent rerank routing", () => {
  it("lets an explicit rerank provider differ from the embedding provider", async () => {
    const previousEmbed = process.env.RAG_EMBED_PROVIDER;
    const previousRerank = process.env.RAG_RERANK_PROVIDER;
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const previousSiliconFlowKey = process.env.SILICONFLOW_API_KEY;
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    process.env.RAG_RERANK_PROVIDER = "openrouter";
    process.env.SILICONFLOW_API_KEY = "sf-key";
    process.env.OPENROUTER_API_KEY = "or-key";
    try {
      expect(activeEmbeddingProvider()).toBe("siliconflow");
      expect(activeRerankProvider()).toBe("openrouter");
      expect(activeRerankModel()).toBe("cohere/rerank-v3.5");
    } finally {
      if (previousEmbed === undefined) delete process.env.RAG_EMBED_PROVIDER; else process.env.RAG_EMBED_PROVIDER = previousEmbed;
      if (previousRerank === undefined) delete process.env.RAG_RERANK_PROVIDER; else process.env.RAG_RERANK_PROVIDER = previousRerank;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
      if (previousSiliconFlowKey === undefined) delete process.env.SILICONFLOW_API_KEY; else process.env.SILICONFLOW_API_KEY = previousSiliconFlowKey;
    }
  });
});

describe("corpus-wide lexical candidate floors", () => {
  it("does not apply a dense cosine floor to an independently recalled lexical candidate", async () => {
    const lexicalOnly = {
      id: "lexical-only",
      score: 0,
      metadata: { text: "exact accession evidence", retrieval_sources: ["lexical"] }
    };
    const dense = { id: "dense", score: 0.8, metadata: { text: "semantic evidence" } };
    const ordered = await rankPool([dense, lexicalOnly], "accession", 2, { minScore: 0.5 });
    expect(ordered.map((match) => match.id)).toEqual(["dense", "lexical-only"]);
  });
});

describe("isWithinAsOf (point-in-time guard, incl. 8-K acceptance_datetime)", () => {
  it("excludes a filing dated after the as-of date and includes one on/before", () => {
    const filing = { acceptance_datetime: "2026-03-10", source: "sec-8k" };
    expect(isWithinAsOf(filing, "2026-03-09")).toBe(false);
    expect(isWithinAsOf(filing, "2026-03-10")).toBe(true);
    expect(isWithinAsOf(filing, "2026-03-11")).toBe(true);
  });
  it("keeps undated chunks and ignores an unset/invalid as-of", () => {
    expect(isWithinAsOf({ source: "x" }, "2026-03-10")).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2026-03-10" }, undefined)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2026-03-10" }, "not-a-date")).toBe(true);
  });

  // R1 (2026-07-01 expert review): published_at is now in the resolution chain, between
  // acceptance_datetime and as_of/timestamp — a chunk lacking acceptance_datetime but carrying a
  // dated published_at is still correctly point-in-time-guarded instead of falling through to
  // "include" via the (today, always-empty) as_of key.
  it("falls back to published_at when acceptance_datetime is absent", () => {
    const chunk = { published_at: "2026-03-10", source: "sec-edgar" };
    expect(isWithinAsOf(chunk, "2026-03-09")).toBe(false); // look-ahead, excluded
    expect(isWithinAsOf(chunk, "2026-03-10")).toBe(true);
    expect(isWithinAsOf(chunk, "2026-03-11")).toBe(true);
  });

  it("acceptance_datetime still takes precedence over published_at when both are present", () => {
    // acceptance_datetime says "after asOf" (exclude); published_at alone would have said "on/before"
    // (include) — acceptance_datetime must win since it's the more precise anchor.
    const chunk = { acceptance_datetime: "2026-03-12", published_at: "2026-03-05" };
    expect(isWithinAsOf(chunk, "2026-03-10")).toBe(false);
  });
});
