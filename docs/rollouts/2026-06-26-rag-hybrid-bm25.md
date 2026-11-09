# 2026-06-26 — Hybrid dense+BM25 retrieval via RRF (item #4, infra-free)

Branch `agent/claude-rag-hybrid`. Improvement-program item #4.

## Summary
Adds a lexical (BM25) signal to the previously dense-only RAG path — better recall for exact-term / ticker /
accession queries — **without** a Pinecone sparse-dense index or admin reindex.

- New `src/lib/rag/hybrid.ts` (pure, dependency-free, deterministic):
  - `tokenize` — lowercase, split on non-alphanumeric, ticker-safe.
  - `bm25Scores(query, docs)` — standard BM25 (k1=1.5, b=0.75); IDF with +1 smoothing (always positive, even
    when df == N); `avgDl || 1` zero-division guard; IDF computed from the candidate pool.
  - `rrfFuse(rankedLists, k=60)` — Reciprocal Rank Fusion over **N** ranked id lists; stable dense-biased
    tie-break. General + reusable — **the multi-query/RRF item (#2) reuses this**.
  - `fuseHybrid(query, matches)` — dense + BM25 RRF over the Pinecone candidate pool; assigns synthetic ids to
    match objects lacking one; never throws (falls back to the input order on error).
- `src/lib/vector-db.ts`: in `retrieveContextDetailed`, when `HYBRID_RETRIEVAL=on`, reorder the candidate pool
  by RRF(dense, BM25) **after** the minScore + as-of filters and **before** the cross-encoder rerank. When OFF,
  `fusedPool === pool` → the path is byte-for-byte the current dense-only flow. Does not change `overFetchK` or
  the Pinecone query — it's purely a post-retrieval reordering of the already-fetched pool.
- `.env.example`: `HYBRID_RETRIEVAL=off`.
- `test/vector-db-hybrid.test.ts`: 29 tests (tokenize, RRF math, BM25 ranking, fuseHybrid, flag-gate
  integration).

## Why
Item #4 — hybrid retrieval. Dense embeddings under-recall exact lexical matches (tickers, accession numbers,
specific phrases); BM25 fusion fixes that. Additive + flag-default-OFF; preserves the just-landed dense path
(minScore floor, docType filters, casing-tolerance). Advisory RAG, not money-path.

## Scoping decision (infra-free)
The original spec named a Pinecone sparse-dense index + an admin reindex route. That requires reprovisioning a
Pinecone index, which can't be verified autonomously and would ship a non-functional capability until the index
exists. Instead this ships a **post-retrieval** hybrid: BM25 over the over-fetched dense candidate pool, fused
via RRF before rerank. Same recall benefit for the candidate set, no infra change. A true sparse-dense index
(corpus-wide IDF via an inverted index) is a documented future enhancement.

## How (model-tiered subagent team)
Run `wf_f4d1c3ae-7c3`: all sonnet (recon → design → implement → adversarial review). Verdict:
`implementsSpec/correct/moneySafe/tscGreen/testsGreen` all true, no required fixes. RRF math and BM25 ranking
verified by the reviewer; OFF-path confirmed byte-for-byte. Orchestrator re-verified the wiring
(post-filter/pre-rerank, flag default OFF) and the helper math directly.

## Files
- new `src/lib/rag/hybrid.ts`, `src/lib/vector-db.ts`, `.env.example`
- new `test/vector-db-hybrid.test.ts`
- `docs/improvement-program-2026-06-26.md`, `STATUS.md`

## Verification
- `npx tsc --noEmit` clean (post-merge); `npx vitest run test/vector-db-hybrid.test.ts
  test/vector-db-retrieval.test.ts` → 40 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups
- True Pinecone sparse-dense index with corpus-wide IDF (current IDF is candidate-pool-local — fine for
  relative ranking within the pool, weaker than a global inverted index).
- The multi-query/RRF item (#2) reuses `rrfFuse` from this module.
