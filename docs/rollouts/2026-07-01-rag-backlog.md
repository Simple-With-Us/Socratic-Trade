# 2026-07-01 - RAG expansion backlog: broader pass (P1 + P2)

## Summary

Broader-backlog pass on `docs/reviews/2026-07-01-rag-knowledge-expansion.md` after Workstream C
(PR #297) and its follow-on (PR #299 - `rankPool` helper, R1 `published_at` fallback +
`VECTOR_ASOF_STRICT`, R2 embedding-integrity guard, R8 first-valid-ticker salience) landed on
`main`. Implements all **P1** items (R5, R6, R7, R9, R10, R11) and all **P2** items (R12, R13, R14,
R15, R16, R17) from the expansion doc's backlog table. R3 (golden-set anti-leakage lint) and R8
(salience first-valid-ticker) were verified as already shipped in earlier passes, not
re-implemented (see "Skipped / already-shipped" below).

Read/retrieval-only. No order/execution-path code touched. No `app/` UI component edited - R13's
scope was explicitly cut down to backend/payload-only per the constraint that a parallel chat
thread is redesigning the dashboard UI. Every item is default-off/opt-in; a test proves
byte-identical default behavior per flag.

## P1 items

**R5 - Consolidated per-retrieval telemetry.** New `recordRetrievalQuality()` in
`src/lib/rag-metering.ts`, called from `rankPool` in `src/lib/vector-db.ts` (the single post-recall
pipeline both `retrieveContextDetailed` and the regression tests drive). Emits ONE record per call:
`queryHash` (SHA-256 first-16-hex via new `hashQuery()` - the raw query text is NEVER persisted),
`k`, `candidates`, `droppedByMinScore`, `droppedByAsOf`, `hybrid`, `rerankAttempted`, `rerankRan`,
`topCosine`, `topRelevanceScore`, `finalCount`. Fire-and-forget, wrapped in try/catch inside
`recordRetrievalQuality` itself. Default OFF via `RAG_RETRIEVAL_TELEMETRY` - the flag check happens
BEFORE any hashing/scanning work, so it's a true no-op (not just a suppressed write) when unset.
Fields are named `*Count`/`top*`/`dropped*` deliberately, NOT `recall`/`precision` - per the
expansion doc, this is distribution telemetry, not a recall metric (recall is only measurable
against the golden eval set in `test/rag-retrieval-eval.test.ts`).

**R6 - Shared fail-closed env-flag parser.** New `src/lib/rag/env-flag.ts` exporting
`envFlagOn(name, default_)`, accepting the same permissive set every other RAG flag already used
(`1`/`true`/`on`/`yes`, case/whitespace-insensitive), fail-closed to `default_` on anything else
including unset/empty. Routed through by:
- `hybridRetrievalEnabled()` and `asOfStrictEnabled()` in `vector-db.ts` (both already used this
  exact vocabulary - pure refactor, zero behavior change, confirmed by the existing
  `test/vector-db-hybrid.test.ts` truthy-value test staying green unmodified).
- `disclosureRagEnabled()` in `src/lib/web-sources/disclosure-rag.ts` - **this one DOES change
  behavior**. It previously required the EXACT string `"on"` (documented as a deliberate trap in a
  pre-existing test). It now accepts the same `1/true/on/yes` vocabulary as every other flag. This
  is an intentional, SAFE-DIRECTION change: an operator who set `RAG_EMBED_DISCLOSURES=true`
  (or `=1`/`=yes`) was already trying to turn disclosures ON, and the old exact-match quirk
  silently no-op'd instead of erroring. It DOES mean a `true`/`1`/`yes` operator config that
  previously (accidentally) no-op'd will now actually enable disclosure embedding - real
  Voyage/Pinecone cost. Called out explicitly here per the task's own instruction to flag this
  change.
- `rerankEnabled()` (VECTOR_ENABLE_RERANK) intentionally KEPT its own inline check rather than
  routing through `envFlagOn` - it's opt-OUT (default true), the opposite shape from every other
  RAG flag (opt-in/default-false), so reusing `envFlagOn`'s `(name, default_)` signature would have
  required an awkward "is-off" wrapper for no real benefit. Its accepted off-vocabulary
  (`0/false/off/no`) is unchanged.

**R7 - Index-metric assertion at bootstrap.** New `assertIndexMetric(pc, initCacheKey)` in
`vector-db.ts`, called once inside `ensureIndex`'s already-memoized `init` promise (so it
naturally runs at most once per (pineconeKey, indexName) pair for the process lifetime - reused
the existing `indexInitPromises` memoization pattern rather than inventing a second cache). Calls
`pc.describeIndex(indexName())`; if `metric !== 'cosine'`, emits `console.warn` +
`audit("vector_index_metric_mismatch", { indexName, metric })`. NEVER throws - `describeIndex`
itself failing (network, permissions, index not yet visible) is swallowed silently, since this is
a best-effort sanity check, not a hard dependency.

**R9 - Query-embedding LRU (vector-only).** New `src/lib/rag/query-embed-cache.ts`:
`getCachedQueryEmbedding(model, query)` / `setCachedQueryEmbedding(model, query, embedding)`, keyed
on `${model}:${query.trim()}` - deliberately NO userId, NO filter context in the key, because the
query embedding is a pure function of the model+text and per-user/filter scoping happens entirely
in the Pinecone `filter` clause AFTER a cache hit, exactly as it would after a fresh embed. TTL
(default 5 min) + size-bounded (default 200 entries) LRU eviction. Wired into
`retrieveContextDetailed`: a cache hit skips the Voyage `embed` call AND the `meterEmbed` cost
count entirely (counted only on miss); only a validated (R2 integrity-guard-passing) embedding is
ever cached. Default OFF via `RAG_QUERY_EMBED_CACHE`.

**R10 - `content_hash` dedup for `storeContexts`.** `StoreContextsOptions` gained an opt-in
`dedupKeyPrefix`. When set, `storeContexts` hashes each document's (post-trim) text via the
existing `hashContent` SHA-256-first-16 helper (`src/lib/rag/chunk.ts`, already used by
`storeDocument`/`chunk.ts` - reused, not duplicated), checks `document_chunks` via
`filterNewDocumentChunks`, skips already-indexed documents entirely (no Voyage embed, no Pinecone
upsert), and records newly-indexed documents via `insertDocumentChunks` under a synthetic
`source` of `${dedupKeyPrefix}:<original source>` (keeps this call's dedup namespace from
colliding with `storeDocument`'s own hashes in the same table, while still sharing infrastructure).
Keys on TEXT content, not accession/id - a changed accession with byte-identical text is still
deduped; a genuinely-changed filing (different text) always re-embeds. Wired into two call sites,
both gated by a new shared `VECTOR_STORECONTEXTS_DEDUP` flag (default off):
- `src/lib/web-sources/sec8k.ts` - the always-on 8-K summary ingest inside `refreshEightK`
  (`dedupKeyPrefix: "sec8k-summary"`), the exact example the expansion doc calls out (an unchanged
  6-line summary otherwise re-embeds every refresh cycle).
- `src/lib/web-sources/disclosure-rag.ts` - the disclosure batch ingest (`dedupKeyPrefix:
  "disclosure"`).

**R11 - Faithfulness / citation-grounding eval.** New `scripts/eval/faithfulness.ts`:
`scoreFaithfulness({id, retrievedChunks, answer})` runs two DETERMINISTIC checks - (1)
`citationsGrounded`: every `[chunk_id]` or `(source: chunk_id)` the answer cites must be present in
`retrievedChunks` (a citation to a never-retrieved chunk is flagged as fabricated); (2)
`numericClaimsSupported`: every dollar amount / percentage / bare multi-digit number the answer
states must substring-appear in at least one retrieved chunk's text. An OPTIONAL LLM judge
(`judgeFaithfulness`) adds a holistic pass for claims the deterministic checks can't reach
(paraphrases, causal claims) - it no-ops (`ran: false`) unless BOTH `RAG_EVAL_FAITHFULNESS_JUDGE`
is truthy AND `OPENAI_API_KEY` is set, mirroring `scripts/eval/score.ts`'s `scoreLlmJudge` pattern.
New `test/rag-faithfulness-eval.test.ts` (fully offline, asserts `fetch` is never called when the
judge is disabled) + `test/fixtures/rag-faithfulness-fixture.ts` (7 hand-authored cases covering
grounded/fabricated-citation/hallucinated-numeric/multi-chunk/paren-citation-style). New CLI runner
`scripts/eval/run-faithfulness.ts` (`npm run eval:faithfulness`) prints a citation-support rate +
unsupported-claim count; NOT part of the required `verify` CI gate (the deterministic scorer IS
covered by `npm test`; the runner is a manual/scheduled diagnostic, and the LLM judge stays out of
CI per the task's explicit instruction to avoid flaky-build risk).

## P2 items

**R12 - Centralize default cosine floor for new callers.** `RetrieveOptions` gained
`applyDefaultFloors?: boolean`; `retrieveContextDetailed` applies `defaultMinScore()`
(`VECTOR_MIN_SCORE`, default 0.30) when `options.minScore == null` AND (`applyDefaultFloors` is
true OR `RAG_APPLY_DEFAULT_FLOORS` is truthy). Both existing callers (`strategy.ts:415-423`,
`orchestrator.ts:182-186`) already pass `minScore: defaultMinScore()` explicitly, so
`options.minScore == null` is false for them regardless of this flag - proven byte-identical by a
dedicated test. The "run rerank on small pools" half of the original R12 idea was dropped per the
expansion doc's own correction (a full-pool result set is returned regardless of ordering, so
there was never a meaningful behavior change there).

**R13 - Provenance-complete citations + optional staleness label (BACKEND/PAYLOAD ONLY).**
`KbChunk` (`src/lib/chat/types.ts`) gained additive `doc_type?` and `isStale?` fields.
`orchestrator.searchKnowledge` (`buildProductionDeps`) now forwards `doc_type`/`section` on every
result (previously dropped even though `RetrievedChunk` already carried them), and includes
`isStale` ONLY when `RAG_CITATION_STALENESS` is on (the key is entirely absent, not
`undefined`-valued, when the flag is off). New `isStale(asOfIso, docType)` +
`citationStalenessEnabled()` in `vector-db.ts`: a heuristic, documented, per-doc_type staleness
horizon (10-K: 400d, 10-Q: 120d, 8-K: 90d, transcript: 120d, congress-trade: 60d, insider-filing:
90d, fallback: 180d - each overridable via `RAG_STALENESS_DAYS_<DOC_TYPE>`), returning `undefined`
(not `false`) when there's no resolvable `as_of` to judge. Advisory-only by construction - it is
computed entirely inside the citation-mapping step and never touches `score`, `minScore`, ranking,
or any numeric/sizing path. **No UI code was touched** - the additive fields are inert until a
future citation UI (owned by the parallel redesign thread) chooses to render them.

**R14 - Near-duplicate suppression.** New `src/lib/rag/dedupe-similar.ts`:
`dedupeSimilar(pool, limit, threshold)` - a greedy Jaccard-shingle (trigram) filter over
`pool[].metadata.text`, reusing `tokenize` from `rag/hybrid.ts` (not duplicated). Walks the
already-ranked pool, keeps each candidate unless it's `>= threshold` similar to an already-kept
chunk, defers near-duplicates, and back-fills from the deferred set so a pool with fewer than
`limit` truly-distinct chunks still returns as many as actually exist rather than an artificially
short list. Wired as opt-in `RankPoolOptions.dedupeSimilarity` / `RetrieveOptions.dedupeSimilarity`,
applied inside `rankPool` AFTER the post-rerank relevance floor and BEFORE the final
slice-to-`limit` (so it can actually change what's in the returned pool - applying it later, after
the caller's own `.slice`, would be a no-op). Default unset = current behavior (no dedup pass).

**R15 - Corpus coverage & freshness report.** New `scripts/eval/corpus-coverage.ts`
(`npm run eval:corpus-coverage`), fully offline against SQLite alone (no Pinecone/Voyage key
required): counts + distinct-ticker counts + min/median/max `indexed_at` grouped by `doc_type`
from `ingested_accessions`; top-N symbols by chunk count from `document_chunks`; watchlist symbols
(`user_watchlist`, across all users) with ZERO corpus coverage; an optional live
`describeIndexStats` cross-check when a Pinecone key IS configured. Explicitly documents a real
schema limitation in its own output: neither `ingested_accessions` nor `document_chunks` stores
the filing's own point-in-time date (`acceptance_datetime`/`as_of`) in a queryable aggregate form -
only `indexed_at`/`created_at` (when THIS process embedded it) - so the freshness numbers are an
ingest-recency proxy, not filing-content freshness; a real content-freshness report would need a
schema change, out of scope here. **Related, not duplicated:** the repo already has a live
`/api/admin/rag-coverage` route + `app/admin/rag-coverage/` UI implementing an overlapping (richer,
UI-facing) version of this idea. This pass did not touch that route or its UI (owned by the
dashboard-redesign thread) - R15's script is a separate, additive, offline CLI diagnostic per the
expansion doc's own framing ("offline script").

**R16 - Per-run RAG budget ceiling with graceful degradation.** New `src/lib/rag/run-budget.ts`:
a default-off (`RAG_RUN_BUDGET_ENABLED`), very-high-ceiling (default 5000 ops/hour, both tunable)
process-global rolling-window counter. `recordRagOperation()` is called at the query-embed-miss
site and inside `rerankMatches` after a successful rerank call. `shouldDegradeForBudget()` is
checked once per `retrieveContextDetailed` call; when tripped, it degrades by forcing
`wantRerank`/`wantHybrid` to `false` for that call - core dense-cosine recall is NEVER affected.
Emits exactly one `rag_run_budget_tripped` audit row the first time the ceiling is crossed per
process lifetime (not once per call, to avoid its own log-volume problem under sustained load).
Deliberately process-global rather than threaded through a `runId` parameter, per the expansion
doc's own guidance - a per-run accounting scheme is a natural follow-up once R5 telemetry shows a
real, specific cost problem worth that wiring cost.

**R17 - Fix train/serve text skew.** New `embedCleanTextEnabled()` (`VECTOR_EMBED_CLEAN_TEXT`,
default off) + `stripPublishedPrefix(text)` in `vector-db.ts`. When on, `storeContexts` embeds
`stripPublishedPrefix(doc.text)` (the `[Published: YYYY-MM-DD] ` boilerplate removed) while the
STORED/upserted metadata `text` (used for citations/display) is completely unchanged - still
carries the boilerplate prefix exactly as before. Confirmed via `grep -rn "\[Published"` across
`src`/`test` that NO non-test consumer parses the prefix out of chunk text before enabling this
(only `test/vector-db.test.ts`'s own assertions reference the literal string, which this change
does not touch since the default stays off and the stored text is unaffected either way).
Query-side embedding was already "clean" (the raw query has no boilerplate) - the skew this fixes
is entirely on the document/write side. Default OFF because flipping it changes the embedding-space
representation of every NEWLY-indexed vector going forward, which is not directly comparable to
vectors indexed before the flag was enabled without a full reindex - a transitional mixed-
representation period vs. a scheduled reindex is an operator/cost decision, not made here.

## Skipped / already-shipped (verified, not re-implemented)

- **R3** (golden-set anti-leakage + hard-negative lint): already shipped as part of
  `test/rag-retrieval-eval.test.ts`'s "golden-set lint" test (every fixture case has
  `hardNegativeIds`, checked disjoint from gold, checked present in the pool; every chunk carries
  `acceptance_datetime`). Verified present and green; not touched.
- **R1** (fail-closed as-of guard + `published_at` fallback) and **R2** (embedding integrity guard):
  shipped in #297/#299 (`resolveAsOfStamp`'s `acceptance_datetime -> published_at -> as_of ->
  timestamp` chain, `VECTOR_ASOF_STRICT`, and `isValidEmbedding`). Verified present; not touched.
- **R8** (salience: validate + first-*valid*-ticker): shipped in #299 as
  `firstValidTicker(text, validate?)` in `src/lib/memory/salience.ts` (uses `matchAll`, filters
  through a stopword denylist + injected validator). Verified present; not touched.
- **R4** (retrieval regression net): shipped in the prior follow-on
  (`docs/rollouts/2026-07-01-rag-followon.md`) as `test/rag-retrieval-regression.test.ts` +
  the `rankPool` helper this pass reuses (not duplicates) for R5/R14's wiring.

## Files

**New:**
- `src/lib/rag/env-flag.ts` - R6 shared `envFlagOn(name, default_)` parser.
- `src/lib/rag/query-embed-cache.ts` - R9 query-embedding LRU.
- `src/lib/rag/dedupe-similar.ts` - R14 near-duplicate suppression (Jaccard-shingle + back-fill).
- `src/lib/rag/run-budget.ts` - R16 per-run RAG budget ceiling.
- `scripts/eval/faithfulness.ts` - R11 deterministic scorer + optional LLM judge.
- `scripts/eval/run-faithfulness.ts` - R11 CLI runner (`npm run eval:faithfulness`).
- `scripts/eval/corpus-coverage.ts` - R15 offline coverage/freshness report (`npm run eval:corpus-coverage`).
- `test/fixtures/rag-faithfulness-fixture.ts` - R11 fixture (7 cases).
- `test/rag-faithfulness-eval.test.ts` - R11 tests (deterministic + judge no-op proofs).
- `test/rag-env-flag.test.ts` - R6 `envFlagOn` unit tests.
- `test/rag-dedupe-similar.test.ts` - R14 `dedupeSimilar`/`jaccardSimilarity` unit tests.
- `test/rag-query-embed-cache.test.ts` - R9 cache unit tests (TTL, LRU eviction, key shape).
- `test/rag-run-budget.test.ts` - R16 rolling-window counter unit tests.
- `test/vector-db-staleness-and-clean-text.test.ts` - R13 `isStale`/R17 `stripPublishedPrefix` pure-function tests.
- `test/chat-orchestrator-search-knowledge.test.ts` - R13 `searchKnowledge` payload integration tests.
- `test/vector-db-backlog-c-integration.test.ts` - R5/R7/R9/R10/R12/R14/R16/R17 full-mock integration tests (23 tests).

**Modified:**
- `src/lib/vector-db.ts` - R5 (`rankPool` telemetry emission), R6 (`envFlagOn` routing for
  hybrid/as-of-strict), R7 (`assertIndexMetric`, wired into `ensureIndex`), R9 (query-embed cache
  wiring in `retrieveContextDetailed`), R10 (`StoreContextsOptions.dedupKeyPrefix`, dedup logic in
  `storeContexts`), R12 (`RetrieveOptions.applyDefaultFloors`), R13 (`isStale`/
  `citationStalenessEnabled`), R14 (`RankPoolOptions.dedupeSimilarity`/
  `RetrieveOptions.dedupeSimilarity`, `dedupeSimilar` call in `rankPool`), R16
  (`shouldDegradeForBudget`/`recordRagOperation` wiring), R17 (`embedCleanTextEnabled`/
  `stripPublishedPrefix`, embed-input selection in `storeContexts`).
- `src/lib/rag-metering.ts` - R5 `recordRetrievalQuality`/`hashQuery`/`retrievalTelemetryEnabled`.
- `src/lib/web-sources/disclosure-rag.ts` - R6 (`disclosureRagEnabled` routed through `envFlagOn`),
  R10 (opt-in `dedupKeyPrefix: "disclosure"` on the `storeContexts` call).
- `src/lib/web-sources/sec8k.ts` - R10 (`storeContextsDedupEnabled()`/`VECTOR_STORECONTEXTS_DEDUP`,
  opt-in `dedupKeyPrefix: "sec8k-summary"` on the summary-ingest `storeContexts` call).
- `src/lib/chat/orchestrator.ts` - R13 (`searchKnowledge` forwards `doc_type`/`section`/`isStale`).
- `src/lib/chat/types.ts` - R13 (`KbChunk.doc_type`/`KbChunk.isStale` additive fields).
- `test/disclosure-rag.test.ts` - R6: replaced the test that documented the OLD exact-`'on'`-only
  trap with tests proving the NEW `envFlagOn`-backed behavior (accepts `true/1/yes/on`, fails
  closed on garbage) - a deliberate, explained test change, not a silent behavior-change cover-up.
- `package.json` - added `eval:faithfulness` and `eval:corpus-coverage` npm scripts.
- `docs/chat-assistant-rag-learning.md` - roadmap §5 updated: the faithfulness half of the "20-40
  query eval set" item is now DONE (was "still open"); corpus coverage/freshness is now DONE as an
  offline script (dashboard UI still open, cross-referenced against the existing
  `/api/admin/rag-coverage` route); new "Backlog pass, 2026-07-01" summary paragraph.
- `PLAN.md` - new dated blockquote note summarizing this pass (matches the existing running-note
  convention at the top of the file).
- `STATUS.md` - new dated entry at the top (this file's own summary, item-by-item).

## Verification

Verify quartet, run in the required order, all green:

```
npx tsc --noEmit    # clean, 0 errors
npm run lint        # 0 errors, 276 warnings (pre-existing grandfathered class; net -2 from removing one unused test var)
npm test            # 1918 tests / 193 files, all passed (was 1797/183 before this change)
npm run build       # clean Next.js build, no errors
```

`npx tsc --noEmit` was re-run after `npm run build` regenerated `.next/types` and stayed clean.

Targeted runs during development (all green):
```
npx vitest run test/rag-env-flag.test.ts test/rag-dedupe-similar.test.ts \
  test/rag-query-embed-cache.test.ts test/rag-run-budget.test.ts \
  test/vector-db-staleness-and-clean-text.test.ts                          # 53 passed (5 files)
npx vitest run test/vector-db-backlog-c-integration.test.ts                # 23 passed
npx vitest run test/chat-orchestrator-search-knowledge.test.ts             # 4 passed
npx vitest run test/rag-faithfulness-eval.test.ts                          # all passed
npx vitest run test/disclosure-rag.test.ts test/sec8k*.test.ts             # 30 passed (regression check)
npx tsx scripts/eval/corpus-coverage.ts                                     # smoke test, no crash, no keys required
npx tsx scripts/eval/run-faithfulness.ts                                    # smoke test, 5/7 pass (2 intentionally-failing fixture cases)
```

No live Voyage/Pinecone call is reachable from any new/modified test - every integration test
mocks `@pinecone-database/pinecone` and `voyageai` at the module level (same pattern as
`test/vector-db.test.ts`), and `filterNewDocumentChunks`/`insertDocumentChunks`/`audit` are mocked
via `../src/lib/db`. Temp SQLite (`DATABASE_URL=file:<tmpdir>/...`) is used wherever a real
(non-mocked) DB is touched (`test/chat-orchestrator-search-knowledge.test.ts`); no test points at
the dev `data/app.db`.

## Follow-ups (not in this change's scope)

- **R6 disclosure-flag behavior change**: operators with `RAG_EMBED_DISCLOSURES` set to a
  non-`"on"` truthy-looking value (e.g. `true`) will now see disclosures actually embed. This is
  the intended fix, but it's worth a one-time check of production env config before/after deploy
  to confirm the new behavior is what's wanted (real Voyage/Pinecone cost).
- **R7/R16 calibration**: the index-metric assertion and the run-budget ceiling are both new
  observability/safety nets with no production signal yet - `vector_index_metric_mismatch` and
  `rag_run_budget_tripped` audit rows should be reviewed after some real usage before tuning
  `RAG_RUN_BUDGET_CEILING`/`RAG_RUN_BUDGET_WINDOW_MS` away from the very-conservative defaults.
- **R9/R10 flags stay off** until an operator decides the cache/dedup savings are worth enabling -
  no default recommendation is made here per the expansion doc's own "config/cost decision for the
  owner, not a code default" framing (see its Open Decision #4, same spirit).
- **R11 LLM judge threshold**: no pass/fail threshold or CI gate is wired for the optional LLM
  judge - it's a manual diagnostic (`npm run eval:faithfulness` with `RAG_EVAL_FAITHFULNESS_JUDGE`
  + `OPENAI_API_KEY` set) until real usage data justifies promoting it.
- **R13 UI**: additive `doc_type`/`isStale` citation fields are backend-only; rendering them (e.g.
  a recency badge on a citation chip) is left to the parallel dashboard-redesign thread.
- **R15 UI**: the offline script complements, but does not replace, a richer
  `/api/admin/rag-coverage`-style UI presentation of the same data - not attempted here per the
  UI-touch constraint.
- **R17 reindex**: flipping `VECTOR_EMBED_CLEAN_TEXT` on for an existing corpus creates two
  embedding-space representations (old boilerplate-embedded vectors vs. new clean-text vectors)
  that aren't directly comparable by cosine similarity. A full reindex (or accepting a transitional
  mixed corpus) is an operator decision for whenever the flag is actually flipped, not made here.
