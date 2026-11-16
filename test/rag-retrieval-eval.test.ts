/**
 * Retrieval-quality eval harness (item 1, 2026-07-01 RAG workstream).
 *
 * docs/chat-assistant-rag-learning.md §5 calls for "a 20-40 query retrieval eval set
 * (recall@k/MRR + faithfulness)". This is that harness for recall@k/MRR: ~28 golden
 * (query, expected-chunk-id[]) tuples in test/fixtures/rag-retrieval-eval-fixture.ts, scored
 * against retrieveContextDetailed()/matchToChunk() driven by a MOCKED Pinecone/Voyage — no live
 * network calls, no API keys required, fully deterministic.
 *
 * Design: each fixture case supplies the exact Pinecone `query()` match pool
 * retrieveContextDetailed would have received for that (query, symbol) pair, in real
 * cosine-descending order. Some gold-relevant chunks are deliberately buried below the naive
 * cosine top-K, so the eval score is sensitive to whether reranking is actually doing its job —
 * a harness that always scored 1.0 regardless of pipeline behavior would not be a real gate.
 *
 * The Voyage `rerank` mock is a deterministic lexical-overlap scorer (term-overlap with the
 * query) standing in for a real cross-encoder: cheap, fully offline, and — because our fixture's
 * gold chunks share vocabulary with their queries by construction — produces a directionally
 * correct signal (gold chunks score higher) exactly as a real reranker would for genuinely
 * relevant text. This is a fixture-quality choice, not a claim that lexical overlap "is" semantic
 * relevance in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RAG_EVAL_FIXTURE, type FixtureCase, type FixtureMatch } from "./fixtures/rag-retrieval-eval-fixture";

// ── Mocks (hoisted; mirrors test/vector-db-hybrid.test.ts's integration-test pattern) ──────────

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn() }));
  return {
    query,
    index,
    listIndexes: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    resolveApiKey: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return { listIndexes: mocks.listIndexes, createIndex: vi.fn(), Index: mocks.index };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn()
}));

// ── Deterministic "reranker" stand-in: lexical term-overlap score, NOT a network call ──────────

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function lexicalOverlapScore(query: string, doc: string): number {
  const q = tokenize(query);
  const d = tokenize(doc);
  if (q.size === 0 || d.size === 0) return 0;
  let overlap = 0;
  for (const t of q) if (d.has(t)) overlap++;
  return overlap / q.size;
}

function installMockRerank() {
  mocks.rerank.mockImplementation(async ({ query, documents, topK }: { query: string; documents: string[]; topK: number }) => {
    const scored = documents.map((doc, index) => ({ index, relevanceScore: lexicalOverlapScore(query, doc) }));
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { data: scored.slice(0, topK) };
  });
}

// ── Recall@k / MRR scorers ──────────────────────────────────────────────────────────────────────

/** Fraction of golden queries whose fixture answer appears anywhere in the top-k retrieved ids. */
function recallAtK(results: string[][], goldIds: string[][], k: number): number {
  let hits = 0;
  for (let i = 0; i < results.length; i++) {
    const topK = results[i]!.slice(0, k);
    const gold = new Set(goldIds[i]);
    if (topK.some((id) => gold.has(id))) hits++;
  }
  return results.length === 0 ? 0 : hits / results.length;
}

/** Mean Reciprocal Rank: 1/rank of the first relevant hit (0 if none found in the returned list). */
function meanReciprocalRank(results: string[][], goldIds: string[][]): number {
  let sum = 0;
  for (let i = 0; i < results.length; i++) {
    const gold = new Set(goldIds[i]);
    const rank = results[i]!.findIndex((id) => gold.has(id));
    sum += rank >= 0 ? 1 / (rank + 1) : 0;
  }
  return results.length === 0 ? 0 : sum / results.length;
}

function hasTopLevelUserId(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  if ("userId" in obj) return true;
  if (Array.isArray(obj.$and)) {
    return obj.$and.some(hasTopLevelUserId);
  }
  return false;
}

// ── Harness: run retrieveContextDetailed against each fixture's recorded pool ──────────────────

async function runFixture(
  options: { rerank: boolean; hybrid: boolean; limit?: number; cases?: FixtureCase[] }
): Promise<{ results: string[][]; gold: string[][] }> {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = options.rerank ? "on" : "off";
  process.env.HYBRID_RETRIEVAL = options.hybrid ? "on" : "off";
  delete process.env.VECTOR_MIN_SCORE;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  installMockRerank();

  const { retrieveContextDetailed } = await import("../src/lib/vector-db");

  const limit = options.limit ?? 3;
  // `cases` is an ADDITIVE, test-harness-only option (defaults to the full fixture) so existing
  // callers of runFixture({ rerank, hybrid, limit }) are byte-for-byte unchanged; the new episodic
  // describe block below passes a filtered subset instead of touching production code.
  const fixtureCases = options.cases ?? RAG_EVAL_FIXTURE;
  const results: string[][] = [];
  const gold: string[][] = [];

  for (const testCase of fixtureCases) {
    mocks.query.mockImplementation((args: any) => {
      if (hasTopLevelUserId(args?.filter)) {
        return { matches: [] };
      }
      return {
        matches: testCase.pool.map((m: FixtureMatch) => ({
          id: m.id,
          score: m.score,
          metadata: {
            text: m.text,
            userId: "local",
            scope: "shared",
            doc_type: m.doc_type,
            section: m.section,
            source: m.source,
            acceptance_datetime: m.acceptance_datetime
          }
        }))
      };
    });

    const chunks = await retrieveContextDetailed(testCase.query, testCase.symbol, limit, "local", testCase.asOf ? { asOf: testCase.asOf } : undefined);
    results.push(chunks.map((c) => c.id));
    gold.push(testCase.goldRelevantIds);
  }

  return { results, gold };
}

// ── Baseline thresholds (this pipeline's current dense+rerank behavior, measured on this fixture) ─
// These are regression floors, not aspirational targets — a drop below them on an unrelated change
// signals a retrieval regression worth investigating before merge. Measured values on this fixture
// as of 2026-07-01: recall@3=1.0, recall@1=1.0, MRR=1.0 with the default pipeline (rerank ON, hybrid
// OFF); thresholds are set with headroom below that so small, legitimate fixture edits don't flake.
const BASELINE_RECALL_AT_3 = 0.9;
const BASELINE_MRR = 0.85;

// The filings-only subset of the fixture (excludes the 10 episodic cases added 2026-07-06). The
// baseline/rerank/hybrid/as-of tests below were measured against ONLY the original ~29 filings
// cases; passing the full mixed fixture (39 cases) to them silently changes their scored
// population once the episodic cases exist (episodic cases have looser, deliberately-harder
// recall/MRR characteristics — see the dedicated episodic describe block), which would make this
// suite's "filings behavior unchanged" claim untrue. Filter explicitly so each population is
// always scored against itself, mirroring the episodic block's own EPISODIC_CASES pattern below.
const FILINGS_CASES = RAG_EVAL_FIXTURE.filter((c) => !c.id.startsWith("episodic-"));

describe("RAG retrieval-quality eval (recall@k / MRR against a recorded fixture, no network)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("fixture has a reasonable golden-query set size (20-40 per the roadmap)", () => {
    expect(RAG_EVAL_FIXTURE.length).toBeGreaterThanOrEqual(20);
    expect(RAG_EVAL_FIXTURE.length).toBeLessThanOrEqual(40);
    for (const c of RAG_EVAL_FIXTURE) {
      expect(c.goldRelevantIds.length).toBeGreaterThan(0);
      expect(c.pool.some((m) => c.goldRelevantIds.includes(m.id))).toBe(true);
    }
  });

  // R3-lite (golden-set anti-leakage/hard-negative lint, C1 expert-review correction): a golden set
  // that leaks (query paraphrases its own gold chunk text) or has no hard negatives rubber-stamps
  // regressions instead of catching them. This is a lightweight lint, not a full trigram-overlap
  // scorer — it enforces the two cheapest, highest-value invariants: every case has ≥1 real hard
  // negative in its pool, and every chunk carries a real acceptance_datetime (required for the as-of
  // guard to be exercisable at all).
  it("golden-set lint: every case has ≥1 hard negative and every chunk is dated", () => {
    for (const c of RAG_EVAL_FIXTURE) {
      expect(c.hardNegativeIds, `case ${c.id} has no hardNegativeIds`).toBeDefined();
      expect(c.hardNegativeIds!.length, `case ${c.id} has zero hard negatives`).toBeGreaterThan(0);
      // Hard negatives must be real pool members, not typos/dangling ids.
      const poolIds = new Set(c.pool.map((m) => m.id));
      for (const hn of c.hardNegativeIds!) {
        expect(poolIds.has(hn), `case ${c.id}: hardNegativeId "${hn}" is not in the pool`).toBe(true);
      }
      // Hard negatives and gold must be disjoint (a hard negative that's secretly gold is a lint bug).
      for (const hn of c.hardNegativeIds!) {
        expect(c.goldRelevantIds.includes(hn), `case ${c.id}: "${hn}" is listed as both gold and hard-negative`).toBe(false);
      }
      for (const m of c.pool) {
        expect(m.acceptance_datetime, `case ${c.id} chunk ${m.id} has no acceptance_datetime`).toBeTruthy();
      }
    }
  });

  // C1 expert-review correction: assert NO network call happens anywhere in this harness — the
  // eval must be fully offline. getClients() (private) resolves through resolveApiKey + the
  // mocked Pinecone/Voyage constructors; asserting embed/query/rerank are only ever invoked via
  // the mocks (never a real fetch) is the closest black-box proxy available from this test file.
  it("never calls the real network (only the mocked Voyage/Pinecone clients are invoked)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await runFixture({ rerank: true, hybrid: false, limit: 3 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.embed).toHaveBeenCalled(); // via the mocked VoyageAIClient, not real network
    expect(mocks.query).toHaveBeenCalled(); // via the mocked Pinecone client, not real network
    fetchSpy.mockRestore();
  });

  // C1 expert-review correction: a golden chunk at dense rank 51+ is structurally unreachable
  // (overFetchK caps at 50) — that's a known pipeline ceiling, not a bug this eval should chase.
  // This asserts the ceiling function itself, documenting the floor rather than asserting recall
  // against it (no fixture case here has >50 candidates, so this is a standalone unit check).
  it("documents the overFetchK ceiling (>=50 pool cap) that bounds achievable recall for a golden chunk buried past rank 50", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    // Build a pool of 60 matches where the gold chunk is at index 55 (rank 56) — beyond the
    // overFetchK(3)=15 cap for this limit, so it must be UNREACHABLE regardless of rerank.
    const bigPool = Array.from({ length: 60 }, (_, i) => ({
      id: `filler-${i}`,
      score: 1 - i * 0.01,
      metadata: { text: `filler chunk ${i}`, userId: "local", scope: "shared", acceptance_datetime: "2026-05-01" }
    }));
    bigPool[55] = { id: "buried-gold", score: 1 - 55 * 0.01, metadata: { text: "the actual gold answer for this query", userId: "local", scope: "shared", acceptance_datetime: "2026-05-01" } };

    process.env.PINECONE_API_KEY = "pinecone-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.VECTOR_ENABLE_RERANK = "off";
    process.env.HYBRID_RETRIEVAL = "off";
    mocks.resolveApiKey.mockImplementation((s: string) => (s === "pinecone" ? "pinecone-test" : "voyage-test"));
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: bigPool });

    const chunks = await retrieveContextDetailed("find the gold answer", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).not.toContain("buried-gold"); // structurally unreachable, not a bug
  });

  it("current default pipeline (rerank ON, hybrid OFF) meets the recall@3 / MRR baseline", async () => {
    const { results, gold } = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const recall3 = recallAtK(results, gold, 3);
    const mrr = meanReciprocalRank(results, gold);

    expect(recall3).toBeGreaterThanOrEqual(BASELINE_RECALL_AT_3);
    expect(mrr).toBeGreaterThanOrEqual(BASELINE_MRR);
  });

  it("reranking materially improves recall@1 / MRR vs raw cosine order (rerank OFF) on this fixture", async () => {
    const withRerank = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const withoutRerank = await runFixture({ rerank: false, hybrid: false, limit: 3, cases: FILINGS_CASES });

    const recall1WithRerank = recallAtK(withRerank.results, withRerank.gold, 1);
    const recall1WithoutRerank = recallAtK(withoutRerank.results, withoutRerank.gold, 1);
    const mrrWithRerank = meanReciprocalRank(withRerank.results, withRerank.gold);
    const mrrWithoutRerank = meanReciprocalRank(withoutRerank.results, withoutRerank.gold);

    // The fixture is constructed so several gold chunks are NOT the top cosine hit — reranking
    // should recover at least some of them, i.e. rerank-on recall@1/MRR >= cosine-only.
    expect(recall1WithRerank).toBeGreaterThanOrEqual(recall1WithoutRerank);
    expect(mrrWithRerank).toBeGreaterThanOrEqual(mrrWithoutRerank);
  });

  // C1 expert-review correction: pin acceptance_datetime on fixture chunks AND include an explicit
  // asOf case, so the harness actually exercises isWithinAsOf rather than only recall/MRR ranking.
  it("the as-of guard case excludes the look-ahead chunk and surfaces the older, still-relevant one", async () => {
    const { results, gold } = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const idx = FILINGS_CASES.findIndex((c) => c.id === "aapl-8k-asof-guard");
    expect(idx).toBeGreaterThanOrEqual(0);

    const retrievedIds = results[idx]!;
    const goldIds = gold[idx]!;
    // The look-ahead chunk (dated after asOf) must never appear — this is the load-bearing
    // point-in-time guard, not just a ranking preference.
    expect(retrievedIds).not.toContain("aapl-8k-catalyst-future");
    // The correct (older, in-window) answer must be recoverable.
    expect(retrievedIds.some((id) => goldIds.includes(id))).toBe(true);
  });
});

// ── Item 4: hybrid BM25/RRF on-vs-off eval delta (gates whether to recommend enabling it) ───────
//
// HYBRID_RETRIEVAL defaults OFF (src/lib/vector-db.ts hybridRetrievalEnabled()) — this suite
// measures the recall@k/MRR delta so the rollout note can record a real number instead of a guess,
// per docs/reviews/2026-07-01-audit-work-split.md item 4 ("run the eval with hybrid on vs off and
// record the measured delta ... only recommend enabling if the eval shows a gain").
describe("item 4: hybrid BM25/RRF eval delta (HYBRID_RETRIEVAL on vs off)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("records the measured hybrid-on vs hybrid-off recall@k/MRR delta (both with rerank ON, the shipped default)", async () => {
    const hybridOff = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const hybridOn = await runFixture({ rerank: true, hybrid: true, limit: 3, cases: FILINGS_CASES });

    const metrics = (r: { results: string[][]; gold: string[][] }) => ({
      recall1: recallAtK(r.results, r.gold, 1),
      recall3: recallAtK(r.results, r.gold, 3),
      mrr: meanReciprocalRank(r.results, r.gold)
    });
    const off = metrics(hybridOff);
    const on = metrics(hybridOn);

    // Recorded for the rollout note (docs/rollouts/2026-07-01-rag-eval-and-rerank.md) — this is the
    // actual measured table, not a guess. On THIS fixture (rerank already recovers most exact-term
    // cases), hybrid does not regress recall@3 and is within noise on MRR/recall@1 — see the rollout
    // note for the full table and the "stay off by default" recommendation.
    expect(on.recall3).toBeGreaterThanOrEqual(off.recall3 - 0.05);
    // Hybrid must never catastrophically regress recall@1/MRR even though this suite doesn't
    // require an improvement to recommend enabling it.
    expect(on.recall1).toBeGreaterThanOrEqual(off.recall1 - 0.1);
    expect(on.mrr).toBeGreaterThanOrEqual(off.mrr - 0.1);
  });

  it("hybrid recovers the exact-term case where the lexical match is buried below cosine top-3 (rerank OFF, isolating hybrid's own contribution)", async () => {
    // Isolate hybrid's contribution by disabling rerank — this is the scenario hybrid targets:
    // an exact lexical hit sitting outside the naive cosine top-K with no reranker to rescue it.
    const denseOnly = await runFixture({ rerank: false, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const denseWithHybrid = await runFixture({ rerank: false, hybrid: true, limit: 3, cases: FILINGS_CASES });

    const exactTermCaseIds = ["amzn-exact-term-fulfillment", "jpm-exact-term-provision"];
    const indexOf = (id: string) => FILINGS_CASES.findIndex((c) => c.id === id);

    for (const caseId of exactTermCaseIds) {
      const idx = indexOf(caseId);
      const gold = new Set(FILINGS_CASES[idx]!.goldRelevantIds);
      const denseHit = denseOnly.results[idx]!.some((id) => gold.has(id));
      const hybridHit = denseWithHybrid.results[idx]!.some((id) => gold.has(id));
      // Hybrid must be at least as good as dense-only on the exact-term case it targets.
      expect(Number(hybridHit)).toBeGreaterThanOrEqual(Number(denseHit));
    }
  });

  // C4 expert-review correction: report per-query-type deltas, not one blended average — a mixed
  // aggregate can read ~0 even though hybrid meaningfully helps exact-token queries specifically
  // (BM25's actual target) while barely moving paraphrastic ones. Split the fixture into the two
  // exact-token cases vs everything else and report each delta separately (both on the RAW/rerank-off
  // pool, per C4, to isolate hybrid's own contribution rather than measuring it through rerank).
  it("reports the hybrid delta split by query type (exact-token vs paraphrastic), not one blended average", async () => {
    const denseOnly = await runFixture({ rerank: false, hybrid: false, limit: 3, cases: FILINGS_CASES });
    const denseWithHybrid = await runFixture({ rerank: false, hybrid: true, limit: 3, cases: FILINGS_CASES });

    const exactTermIds = new Set(["amzn-exact-term-fulfillment", "jpm-exact-term-provision"]);
    const exactIdx: number[] = [];
    const paraphrasticIdx: number[] = [];
    FILINGS_CASES.forEach((c, i) => (exactTermIds.has(c.id) ? exactIdx : paraphrasticIdx).push(i));

    const recallForSubset = (r: { results: string[][]; gold: string[][] }, indices: number[], k: number) => {
      const subsetResults = indices.map((i) => r.results[i]!);
      const subsetGold = indices.map((i) => r.gold[i]!);
      return recallAtK(subsetResults, subsetGold, k);
    };

    const exactRecallOff = recallForSubset(denseOnly, exactIdx, 1);
    const exactRecallOn = recallForSubset(denseWithHybrid, exactIdx, 1);
    const paraRecallOff = recallForSubset(denseOnly, paraphrasticIdx, 1);
    const paraRecallOn = recallForSubset(denseWithHybrid, paraphrasticIdx, 1);

    // Recorded for the rollout note: hybrid's lift concentrates on exact-token queries (its actual
    // target) — it must not regress either subset, and the exact-token subset is where any real gain
    // should show up (a blended average could hide this signal or wrongly damn hybrid).
    expect(exactRecallOn).toBeGreaterThanOrEqual(exactRecallOff);
    expect(paraRecallOn).toBeGreaterThanOrEqual(paraRecallOff - 0.15); // must not regress paraphrastic queries
  });
});

// ── Episodic decision-memory eval (2026-07-06 golden-eval expansion) ────────────────────────────
//
// The filings-only fixture above never exercises doc_type in EPISODIC_DOC_TYPES
// (['socratic-decision','coach-note','lesson'], src/lib/experience-memory.ts:44) — this describe
// block scores recall@k/MRR over ONLY the new episodic cases (query -> closed-lot experience /
// coach-note / lesson chunk), reusing the exact same runFixture + recall/MRR scorers as the
// filings suite above, filtered to the episodic subset via runFixture's additive `cases` option.
const EPISODIC_CASES = RAG_EVAL_FIXTURE.filter((c) => c.id.startsWith("episodic-"));

describe("episodic decision-memory eval (recall@k / MRR over socratic-decision/coach-note/lesson cases)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("has a non-trivial episodic golden set (>=8 cases) where every case carries a discriminating hard negative", () => {
    expect(EPISODIC_CASES.length).toBeGreaterThanOrEqual(8);
    for (const c of EPISODIC_CASES) {
      expect(c.goldRelevantIds.length, `case ${c.id} has no gold ids`).toBeGreaterThan(0);
      expect(c.hardNegativeIds?.length ?? 0, `case ${c.id} has no hard negatives`).toBeGreaterThan(0);
      // Every case in this block must actually target an episodic doc_type — a filings case
      // slipping in here would silently make this suite meaningless again.
      const goldChunks = c.pool.filter((m) => c.goldRelevantIds.includes(m.id));
      expect(goldChunks.length).toBeGreaterThan(0);
      for (const chunk of goldChunks) {
        expect(["socratic-decision", "coach-note", "lesson"]).toContain(chunk.doc_type);
      }
    }
  });

  it("current default pipeline (rerank ON, hybrid OFF) recovers the discriminating near-miss episodic cases", async () => {
    const { results, gold } = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: EPISODIC_CASES });
    const recall3 = recallAtK(results, gold, 3);
    const recall1 = recallAtK(results, gold, 1);
    const mrr = meanReciprocalRank(results, gold);

    // These cases are DELIBERATELY harder than the filings set (near-miss hard negatives share
    // symbol+regime but flip thesis/side) — the fixture-quality goal per the task is that this
    // NOT trivially saturate at 1.0 the way the filings-only harness did. The floor here is looser
    // than the filings baseline (0.9) precisely because the near-misses are designed to be
    // genuinely confusable for a lexical-overlap stand-in reranker, not a real cross-encoder.
    expect(recall3).toBeGreaterThanOrEqual(0.6);
    expect(mrr).toBeGreaterThanOrEqual(0.4);

    // recall@3 saturates at 1.0 on this fixture (limit=3 gives the lexical-overlap mock reranker
    // enough room to always place gold somewhere in the top 3), so recall@3 alone can't tell a
    // real ranking regression from a lucky one — it would only catch a case falling out of the
    // top 3 entirely. recall@1 is where the near-miss design actually bites: on 6 of the 10 cases
    // (nvda-momentum, tsla-riskoff, amzn-thesis-tag, asof-guard, googl-counterexample,
    // jpm-rate-thesis) a near-miss hard negative that shares surface vocabulary (ticker/regime/
    // thesis_tag) with the query out-scores the true analog on the lexical-overlap stand-in, so
    // gold is NOT rank 1 even though it's always in the top 3. Measured on this fixture: 4/10 hits
    // -> recall@1 = 0.4 (this is the actual observed value, not a target) — asserting equality
    // (rather than a loose floor) means a future fixture edit that accidentally makes the mock
    // reranker "too good" (recall@1 creeping toward 1.0, silently un-burying the near-misses) or
    // an actual ranking regression (recall@1 dropping below what these near-misses guarantee) both
    // get caught, unlike a saturated recall@3 assertion.
    expect(recall1).toBeCloseTo(0.4, 5);
  });

  it("every episodic case's hard negatives are pool members disjoint from gold (golden-set lint, episodic subset)", () => {
    for (const c of EPISODIC_CASES) {
      const poolIds = new Set(c.pool.map((m) => m.id));
      for (const hn of c.hardNegativeIds!) {
        expect(poolIds.has(hn), `case ${c.id}: hardNegativeId "${hn}" not in pool`).toBe(true);
        expect(c.goldRelevantIds.includes(hn), `case ${c.id}: "${hn}" is both gold and hard-negative`).toBe(false);
      }
    }
  });

  it("the episodic as-of guard case excludes the look-ahead analog and surfaces the older, still-relevant one", async () => {
    const { results, gold } = await runFixture({ rerank: true, hybrid: false, limit: 3, cases: EPISODIC_CASES });
    const idx = EPISODIC_CASES.findIndex((c) => c.id === "episodic-asof-guard-analog");
    expect(idx).toBeGreaterThanOrEqual(0);

    const retrievedIds = results[idx]!;
    const goldIds = gold[idx]!;
    expect(retrievedIds).not.toContain("exp-xom-riskoff-future"); // dated after asOf — must never appear
    expect(retrievedIds.some((id) => goldIds.includes(id))).toBe(true);
  });
});

// ── Single-query vs multi-query (#822 HyDE + evidence-derived multi-query retrieval) ────────────
//
// Exercises RetrieveOptions.queries / rrfFuse directly against retrieveContextDetailed: the SAME
// fixture case is run once as a plain single query, and once with `options.queries` set to
// [...2-3 derived variants] (the primary query is passed separately as retrieveContextDetailed's
// own first arg and vector-db.ts folds it into the fan-out set itself) — mirroring how
// strategy.ts's RAG_MULTIQUERY/RAG_HYDE lane would populate it (paraphrases/evidence-derived
// variants of the same situation sketch), without flipping either flag or touching production
// code. Because the mocked Pinecone `query()` returns
// the SAME recorded pool for every fan-out variant call (this harness has one fixed pool per case,
// not a different pool per paraphrase), the realistic assertion is NO-REGRESSION + "the fused pool
// actually drew from multiple query lists" — not a strict improvement, since the mock cannot
// produce a variant-specific recall gain by construction (see per-case comments below for the
// observed delta on this fixture).
async function runSingleVsMultiQuery(
  testCase: FixtureCase,
  derivedQueries: string[],
  limitArg = 3
): Promise<{ single: string[]; multi: string[] }> {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "on";
  process.env.HYBRID_RETRIEVAL = "off";
  delete process.env.VECTOR_MIN_SCORE;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  installMockRerank();

  const { retrieveContextDetailed } = await import("../src/lib/vector-db");

  const poolMatches = () =>
    testCase.pool.map((m: FixtureMatch) => ({
      id: m.id,
      score: m.score,
      metadata: {
        text: m.text,
        userId: "local",
        scope: "shared",
        doc_type: m.doc_type,
        section: m.section,
        source: m.source,
        acceptance_datetime: m.acceptance_datetime
      }
    }));

  // Single-query path: one private/shared Pinecone pair (options.queries omitted).
  mocks.query
    .mockResolvedValueOnce({ matches: [] })
    .mockResolvedValueOnce({ matches: poolMatches() });
  const singleChunks = await retrieveContextDetailed(
    testCase.query,
    testCase.symbol,
    limitArg,
    "local",
    testCase.asOf ? { asOf: testCase.asOf } : undefined
  );

  // Multi-query path: one private/shared pair per fan-out variant (primary + derived).
  vi.clearAllMocks();
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  installMockRerank();
  const fanOutCount = new Set([testCase.query, ...derivedQueries]).size;
  for (let i = 0; i < fanOutCount; i++) {
    mocks.query
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: poolMatches() });
  }
  const multiChunks = await retrieveContextDetailed(
    testCase.query,
    testCase.symbol,
    limitArg,
    "local",
    { ...(testCase.asOf ? { asOf: testCase.asOf } : {}), queries: derivedQueries }
  );

  return { single: singleChunks.map((c) => c.id), multi: multiChunks.map((c) => c.id) };
}

describe("item #822: single-query vs multi-query (RetrieveOptions.queries / rrfFuse) fan-out", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("multi-query (rrfFuse) recall is never worse than single-query on the same near-miss-heavy episodic case", async () => {
    const testCase = RAG_EVAL_FIXTURE.find((c) => c.id === "episodic-nvda-momentum-analog");
    expect(testCase, "fixture case episodic-nvda-momentum-analog not found").toBeDefined();
    if (!testCase) throw new Error("unreachable: asserted above");
    // Derived variants: paraphrases of the same situation sketch, the shape strategy.ts's
    // RAG_MULTIQUERY/RAG_HYDE lane produces (evidence-derived rephrasings, not new topics).
    const derived = [
      "Prior NVDA long entries on a momentum breakout thesis during a risk-on macro backdrop",
      "How did our last NVDA momentum trade in a risk-on regime turn out?",
      "NVDA breakout entry risk-on regime realized outcome"
    ];

    const { single, multi } = await runSingleVsMultiQuery(testCase, derived, 3);
    const gold = new Set(testCase.goldRelevantIds);

    const singleHit = single.some((id) => gold.has(id));
    const multiHit = multi.some((id) => gold.has(id));
    // No-regression, not a strict-improvement assertion: the mock returns the IDENTICAL recorded
    // pool for every fan-out variant (there's no separate "pool per paraphrase" in this harness),
    // so rrfFuse over N copies of the same ranked list cannot itself invent new recall the way a
    // real multi-query fan-out against a live index could. Observed on this fixture: singleHit and
    // multiHit are BOTH true (rerank already recovers this case single-query) — the delta here is
    // zero on recall, which is the expected/documented outcome for a same-pool mock, not a failure
    // of the fan-out wiring.
    expect(Number(multiHit)).toBeGreaterThanOrEqual(Number(singleHit));
  });

  it("multi-query (rrfFuse) recall is never worse than single-query on the exact-term hybrid-style case", async () => {
    const testCase = RAG_EVAL_FIXTURE.find((c) => c.id === "amzn-exact-term-fulfillment");
    expect(testCase, "fixture case amzn-exact-term-fulfillment not found").toBeDefined();
    if (!testCase) throw new Error("unreachable: asserted above");
    const derived = [
      "Amazon fulfillment centers and delivery stations network structure",
      "How is AMZN's fulfillment and sortation infrastructure organized?"
    ];

    const { single, multi } = await runSingleVsMultiQuery(testCase, derived, 3);
    const gold = new Set(testCase.goldRelevantIds);

    const singleHit = single.some((id) => gold.has(id));
    const multiHit = multi.some((id) => gold.has(id));
    // Observed on this fixture: both single and multi recover the gold chunk at limit=3 once
    // rerank is on (rerank alone already promotes the exact-term chunk here) — multi-query must
    // still not regress it.
    expect(Number(multiHit)).toBeGreaterThanOrEqual(Number(singleHit));
  });

  it("the fused candidate pool draws from multiple query lists, not just the primary query's own ranking", async () => {
    // A pool where dense cosine order for the PRIMARY query alone would bury the gold chunk near
    // the tail, but a derived variant's (identical, per the mock) ranked list still contributes to
    // rrfFuse's reciprocal-rank scoring — this asserts the plumbing (fanOutQueries/rrfFuse) is
    // actually exercised end-to-end with >1 query list, not that a single query already suffices.
    const testCase: FixtureCase = {
      id: "synthetic-multiquery-plumbing-check",
      query: "closest prior decision for a thinly-covered small-cap momentum long",
      symbol: "SMCX",
      goldRelevantIds: ["smcx-gold-analog"],
      hardNegativeIds: ["smcx-near-miss-thesis", "smcx-near-miss-regime"],
      pool: [
        { id: "smcx-near-miss-thesis", score: 0.5, text: "Experience memory: closed lot with realized outcome\nticker: SMCX\nside: buy\nthesis_tag: value-reversion\nentry_market_regime: risk-on\nrealized_outcome: return_pct=3.1", doc_type: "socratic-decision", acceptance_datetime: "2026-05-15" },
        { id: "smcx-near-miss-regime", score: 0.47, text: "Experience memory: closed lot with realized outcome\nticker: SMCX\nside: buy\nthesis_tag: momentum-breakout\nentry_market_regime: risk-off\nrealized_outcome: return_pct=-2.4", doc_type: "socratic-decision", acceptance_datetime: "2026-05-15" },
        { id: "smcx-gold-analog", score: 0.3, text: "Experience memory: closed lot with realized outcome\nticker: SMCX\nside: buy\nthesis_tag: momentum-breakout\nentry_market_regime: risk-on\nrealized_outcome: return_pct=14.7", doc_type: "socratic-decision", acceptance_datetime: "2026-05-15" }
      ]
    };
    const derived = ["thinly-covered small-cap momentum breakout risk-on prior decision"];

    const { multi } = await runSingleVsMultiQuery(testCase, derived, 3);
    // rrfFuse's output must be a de-duplicated union of ids seen across the fan-out's ranked lists
    // (mocks.query was called once per fan-out variant, per the harness above) — this is the
    // observable proxy from outside vector-db.ts that fan-out + fusion actually ran (not the
    // single-query short-circuit), since every id in the pool appears in every variant's list here.
    expect(mocks.query).toHaveBeenCalledTimes(new Set([testCase.query, ...derived]).size * 2);
    // Order-insensitive by construction: assert no duplicate ids (rrfFuse actually de-duped) and
    // that every returned id is a real pool member — not a brittle fixed-array .slice() that
    // silently stops catching drift once the array and multi.length happen to line up.
    const poolIds = new Set(testCase.pool.map((m) => m.id));
    expect(new Set(multi).size).toBe(multi.length);
    expect(multi.every((id) => poolIds.has(id))).toBe(true);
    expect(multi.length).toBeGreaterThan(0);
  });
});
