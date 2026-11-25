# 2026-11-24 — ST-4677 RAG and backend hygiene (ZC)

## 1. Context & Objective

ST-4677 (child of ST-4668) removes dead and unretrievable RAG/backend write paths and corrects stale comments and retention labels, without deleting any stored data or touching owner-merge paths.   The lane stops writing new junk rows; it does not prune existing rows.

## 2. Changes Made

Summary: deleted three dead RAG modules and their dedicated test, removed an uncalled ROIC ingest path, stopped embedding unretrievable `fundamentals` cards, removed a duplicate FTS mirror insert, corrected stale comments, and fixed the `api_health_log` retention label.

- Deleted `src/lib/rag/search-fusion.ts`, `src/lib/rag/query-deconstruct.ts`, `src/lib/rag/intent-router.ts` (zero production importers; only search-fusion imported the other two).
- Deleted `test/search-fusion.test.ts` (covered only search-fusion).
- `test/embed-resilience.test.ts`: removed the search-fusion schema case (coverage retained by `test/embedding-response-schema.test.ts`).
- `test/usage-compliance-classifier.test.ts`: removed the WS1 gap #2/#3 describes that imported the deleted modules; trimmed the header comment.
- `src/lib/llm-request.ts`: removed the orphaned `queryDeconstruct` output cap (its only consumer was query-deconstruct.ts).
- `src/lib/llm-call.ts`: classifier tag maps LEFT UNCHANGED (see Decisions).
- `src/lib/web-sources/roic-financials.ts`: deleted uncalled `ingestRoicFinancialsToRag` plus the `storeDocument` import and the `ROIC_FINANCIALS_DOC_TYPE`/`ROIC_FINANCIALS_SOURCE` constants it solely used.
- `src/lib/web-sources/sec-filings.ts`: `ingestFundamentalsCard` no longer embeds the `doc_type: "fundamentals"` card (no `storeContexts` call); the structured enrichment (`provider.enrich`) is unchanged.   Removed the duplicate qualified-accession `mirrorFtsChunksBounded` insert in the full-body post-commit path; the bare-accession mirror in `persistLocalComplete` remains the single FTS write.   Removed the now-unused `mirrorFtsChunksBounded` import.
- `src/lib/vector-db.ts`: corrected the rerank top-K comment (the code passes `rerankTopN = min(rerankPool.length, max(limit * 3, 24))`) and the table-chunk comment (chunk.ts splits tables via `splitTableByRowGroups`).
- `src/lib/learned-context/store.ts`: corrected the risk-tier comments — `listLearnedContextForDecision` returns owner-approved active private risk rows since ST-4665 (PR #5466).
- `src/lib/sqlite-storage-hygiene.ts`: corrected the `api_health_log` retention label and header note to reflect the 30-day FIFO sweep (ST-4644, `db-health-retention.ts`, `API_HEALTH_LOG_RETENTION_DAYS`).
- `test/sec-filings.test.ts`: rewrote the fundamentals test to assert no embed; added a neighbouring 10-K embeds test and a one-FTS-row-per-chunk test; reworked the two post-commit error tests to target `runWithActiveVectorCommitProof` (now a hoisted mock) after the duplicate mirror removal.
- `test/sqlite-storage-hygiene.test.ts`: added a pin for the corrected `api_health_log` retain reason.
- SKIPPED `src/lib/experience-memory.ts` (sibling lane ST-4678 owns that file).

## 3. Decisions & Trade-offs

- The `llm-call.ts` classifier tag maps (`rag-query-deconstruct`, `search-fusion-mmr`) were LEFT in place: grep shows `test/usage-compliance-classifier.test.ts` still pins those translations, so the deleted modules were not their only consumers.   Per the task fallback, a map is removed only when grep proves sole consumption.
- The fundamentals fix lives at the sec-filings write site, not in the shared `storeContexts` pipeline, so other doc types and structured writes are untouched.   `buildFundamentalsContext` is retained (a test-covered formatter).
- For the FTS dedup, the bare accession is the form `corpus-wide-lexical.ts` (GLOB `'*:' || fts.accession || ':*'`) and the prune path (`bareSecAccession`) join on; the qualified mirror was the duplicate.   Removing it required reworking two error-propagation tests that previously failed the second mirror; they now fail the post-commit proof delivery, preserving the same `{ skipped: true, error }` contract.
- No stored data was deleted or pruned; `scheduler.ts` and `strategy-execution.ts` were not modified.

## 4. Verification State

Commands run in the lane (Node v22; CI uses v26):

```
npx tsc --noEmit                      # exit 0, clean
npm run lint                          # 0 errors, 899 grandfathered warnings, exit 0
npx vitest run <group A: 14 files>    # 252 passed
npx vitest run <group B: 10 files>    # 137 passed
```

Group A: sec-filings, roic-financials, fts-mirror-convergence, corpus-wide-lexical, embed-resilience, usage-compliance-classifier, embedding-response-schema, rag-production-path-contract, rag-retrieval-status, llm-request, llm-call, llm-call-json-payload, rag-information-routing, rag-doc-type-coverage.   Group B: sqlite-storage-hygiene, forever-retention-no-age-delete, api-health-log-retention, learned-context, learned-context-pending, learned-context-sharing, learned-context-account-scope, prompt-trust-boundary, experience-memory, pending-fill-reconcile-refire.   Total: 24 files, 389 tests passed.

The full `npm test` and `npm run build` gate was NOT run by this lane (the lead runs it once per lane); the known Node-22-only `test/cpuprofile-summary.test.ts` failure was not exercised.

## 5. Next Steps & Blockers

- Lead runs the full `verify` gate (tsc -> vitest -> build) and pushes/opens the PR; this lane made one local commit and did not push.
- origin/main has moved to a61b531789; the lead handles merge/rebase at push time (this lane did not merge or rebase).
- ST-4678 owns the `experience-memory.ts` stale-comment fix skipped here.

## 6. Zero-Code Findings

None.
