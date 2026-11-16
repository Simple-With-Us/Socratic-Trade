# 2026-07-01 - RAG follow-on: retrieval regression net + R1 strict as-of mode

## Summary

Focused follow-on pass on the RAG expansion backlog (`docs/reviews/2026-07-01-rag-knowledge-expansion.md`)
after Workstream C (PR #297) landed on `main`. Implements:

1. **R4 - Retrieval regression net.** Factored a pure `rankPool(matches, query, limit, options)`
   helper out of `retrieveContextDetailed`'s inline post-recall pipeline (score floor -> as-of guard
   -> hybrid fuse -> rerank -> post-rerank floor). `retrieveContextDetailed` now calls `rankPool` and
   then slices/maps to `RetrievedChunk` itself, exactly as before - the extraction is a pure
   refactor, not a behavior change. New `test/rag-retrieval-regression.test.ts` (19 tests) drives
   `rankPool` directly over `matchToChunk`-shaped recorded fixtures and pins:
   - a chunk dated after `asOf` is dropped; an undated chunk is kept under the lenient default and
     dropped under strict mode (see item 2);
   - `rerankMatches` (the real function, not a mock) preserves pool length + identity when the
     injected Voyage client throws or returns empty data (fail-open);
   - `fuseHybrid` on `<=1` match, or a deliberately malformed input, returns the input unchanged;
   - hybrid on-vs-off reorders the candidate pool but never changes the candidate *set* (nothing is
     ever dropped by hybrid fusion alone).
   - a `fetch` spy assertion proving the whole file never reaches the network (`rankPool` and its
     dependencies are pure/in-process; the only "client" involved is a fake `{ rerank }` stand-in).
2. **R1 part 2 - `VECTOR_ASOF_STRICT` strict as-of mode** (default OFF). New `asOfStrictEnabled()`
   flag reader (same `1/true/on/yes` parsing as the other RAG flags). `isWithinAsOf` gained a third
   `strict` parameter (default `false`, preserving byte-identical behavior for every existing call
   site/test): when `strict=true` **and** `asOf` resolves to a valid date, a chunk with **no**
   resolvable date stamp (after the existing `acceptance_datetime -> published_at -> as_of ->
   timestamp` chain from PR #297) is now **dropped** instead of kept. `rankPool` wires this into the
   as-of filtering step, counts strict-mode drops, and emits a fire-and-forget
   `audit("vector_asof_strict_drop", { droppedUndated, asOf }, userId)` record when it actually drops
   something - observability only, never throws, never blocks the returned pool. New
   `resolveAsOfStamp(metadata)` helper extracts the shared stamp-resolution logic (returns
   `number | undefined`) so both `isWithinAsOf` and the strict-mode drop-count use one code path.
   New `test/vector-db-asof-strict.test.ts` (5 tests) proves the golden as-of tuple end-to-end
   through the real `retrieveContextDetailed` pipeline (mocked Pinecone/Voyage, no live network):
   undated chunk **included** when the flag is off/unset (production default), **excluded** when
   `VECTOR_ASOF_STRICT=on` and `asOf` is set, and a complete no-op (undated always kept, no audit
   call) when `asOf` is unset regardless of the flag - matching the "never change behavior when
   `asOf` is unset or the flag is off" constraint verbatim.

## Why

PR #297's own rollout note (`docs/rollouts/2026-07-01-rag-eval-and-rerank.md`) explicitly listed R4
(dedicated regression-net test file) and R1's `VECTOR_ASOF_STRICT` flag as deferred follow-ups, not
silently dropped. The expansion doc flags R4 as P0 ("protects the entire eval investment" - a
regression in the as-of/rerank/hybrid fail-safes could silently look-ahead-bias a backtest-style
query or empty every retrieval result on a transient Voyage 429) and R1 as P0 (the as-of guard fails
open on undated chunks today, which is a silent look-ahead hole for point-in-time queries once the
corpus is dated well enough to make strict mode useful). Both are read/retrieval-only, default-off
where behavior-changing, and explicitly scoped as cheap in the expansion doc's effort column (`S`).

No `rankPool`/`orderMatches` pure helper existed after #297 (verified by grep across
`src/lib/vector-db.ts` before starting) - the post-recall pipeline was still inline inside
`retrieveContextDetailed` (score floor -> asOf filter -> hybrid fuse -> rerank -> relevance floor ->
slice, lines ~825-857 pre-change). This follow-on extracts it as `rankPool` per the task's explicit
instruction to reuse/export a small pure helper rather than duplicating pipeline logic in test code.

## Files

**New:**
- `test/rag-retrieval-regression.test.ts` - R4 regression net (19 tests): as-of guard (lenient +
  strict), `rerankMatches` fail-open, `fuseHybrid` fail-safe, hybrid reorders-never-drops, and a
  `rankPool`-defaults-are-a-no-op byte-identity check.
- `test/vector-db-asof-strict.test.ts` - R1 strict-mode golden as-of tuple (5 tests), full-pipeline
  integration test (mocked Pinecone/Voyage) proving the flag's on/off/unset-asOf behavior end-to-end.

**Modified:**
- `src/lib/vector-db.ts`:
  - Added `asOfStrictEnabled()` (reads `VECTOR_ASOF_STRICT`, default off).
  - Added `resolveAsOfStamp(metadata): number | undefined` (extracted stamp-resolution chain).
  - `isWithinAsOf(metadata, asOf, strict = false)` - new optional third parameter; default
    unchanged (byte-identical to pre-change behavior for every existing caller/test).
  - Extracted `rankPool(matches, query, limit, options)` (`RankPoolOptions`, `RankPoolRerankFn`
    exported types) from `retrieveContextDetailed`'s inline pipeline. `retrieveContextDetailed` now
    calls `rankPool(...)` with the same env-flag-resolved values (`hybridRetrievalEnabled()`,
    `wantRerank`, `asOfStrictEnabled()`) it always would have used, then slices/maps exactly as
    before. Pure refactor - no change to the values passed or the resulting order for any existing
    caller/option combination.

No other files needed changes - `strategy.ts`, `orchestrator.ts`, and every other
`retrieveContextDetailed`/`isWithinAsOf` caller are unaffected (new parameters are optional and
default to current behavior).

## Verification

Verify quartet, run in the required order, all green:

```
npx tsc --noEmit                              # clean, 0 errors
npm run lint                                  # 0 errors, 274 warnings (pre-existing grandfathered backlog; unchanged in kind)
npm test                                      # 1797 tests / 183 files, all passed (was ~1778/181 before this change)
npm run build                                 # clean Next.js build, no errors
```

Targeted runs during development:
```
npx vitest run test/rag-retrieval-regression.test.ts   # 19 passed
npx vitest run test/vector-db-asof-strict.test.ts       # 5 passed
npx vitest run test/vector-db-retrieval.test.ts test/vector-db-rerank-floor.test.ts \
  test/vector-db-hybrid.test.ts test/vector-db.test.ts test/vector-db-chunk-cap.test.ts \
  test/vector-db-embedding-integrity.test.ts test/vector-db-provenance.test.ts \
  test/vector-db-scope.test.ts test/rag-retrieval-eval.test.ts                 # 119 passed (11 files)
```

`npx tsc --noEmit` was re-run after `npm run build` regenerated `.next/types` (per the repo's
"Verify before claiming done" guidance) and stayed clean.

## Item completion vs the task spec

- **Item 1 (R4 regression net): DONE.** All four invariants from the task spec are pinned:
  as-of drop/keep (lenient + strict), `rerankMatches` fail-open (throwing + empty-data mocks),
  `fuseHybrid` fail-safe (`<=1` match / malformed input), hybrid reorders-never-drops. Routed
  through the newly-exported pure `rankPool` helper (no duplicate was created - grep confirmed none
  existed post-#297). No live network: the test file never imports `@pinecone-database/pinecone` or
  `voyageai`, and a `fetch` spy assertion is included as an explicit belt-and-suspenders check.
- **Item 2 (R1 strict mode): DONE.** `VECTOR_ASOF_STRICT` (default OFF); strict-drop only applies
  when `options.asOf` is set; drop-count `audit()` emitted on an actual drop; golden as-of tuple
  (undated excluded under strict / included without) proven through the real
  `retrieveContextDetailed` pipeline, not just the `isWithinAsOf` unit level.

Nothing was deferred from the two assigned items. Everything else in the expansion doc (R2/R3/
R5-R17, C1-C7) was already addressed or explicitly deferred by PR #297 and is out of scope for this
focused follow-on per the task's own item list.

## Follow-ups (not in this change's scope)

- `VECTOR_ASOF_STRICT` stays off by default per the expansion doc's open decision #2 - flip it only
  after an operator reviews the `vector_asof_strict_drop` audit volume against the real corpus and
  confirms strict mode won't empty results for common queries.
- R3 (formal trigram-overlap golden-set leakage scorer), R5 (consolidated retrieval telemetry), R6
  (shared `envFlagOn` parser), R7 (index-metric bootstrap assertion), R9 (query-embedding LRU), R10
  (`storeContexts` content-hash dedup), R11 (faithfulness/citation-grounding eval), and R12-R17 (P2)
  remain unimplemented, as documented in PR #297's rollout note - none were in this follow-on's
  assigned scope.
