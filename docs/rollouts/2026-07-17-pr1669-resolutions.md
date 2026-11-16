# Rollout Note: PR #1669 Codex Review Thread Resolutions (2026-07-17)

## Summary
Successfully resolved all 11 remaining Codex review thread issues on PR #1669 to allow the PR to be merged and deployed to production.

## Touched Files
- [strategy.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/strategy.ts): Chunked contexts retrieval into batches of 5 to bound scout retrieval concurrent fan-out and avoid resource exhaustion.
- [search-fusion.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/rag/search-fusion.ts):
  - Updated `chunk_occurrences` join clauses to filter by `symbol` and `source` to prevent cross-symbol text leaks in as-of queries.
  - Used `bm25(document_chunks_fts)` instead of SQL alias `bm25(f)` in as-of BM25 ranking to resolve FTS5 errors.
  - Sliced fallback `getHash` SHA-256 digest to 32 characters (reusing `hashContent(text)`) to align with standard chunk hashes.
- [sec-filings.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-filings.ts): Moved the local FTS indexing call inside the `runWithActiveVectorCommitProof` database transaction block to ensure FTS insertion failures trigger transaction rollback, making the ingestion task retryable.
- [vector-db.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/vector-db.ts): Updated `withDurableRagProviderDispatch` type signature to admit alternative providers (`"openrouter" | "siliconflow"`) and passed the active provider name instead of hardcoded `"voyage"` for accurate metering.
- [chunk.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/rag/chunk.ts): Rechecked overlap text tokens inside `splitLongProse` after a flush and yielded the overlap tail as its own chunk when combined tokens exceed `maxTokens`.
- [sec-parser.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-parser.ts): Replaced the 1D table rows parser with a 2D grid structure mapping that expands both `rowspan` and `colspan` attributes during Cheerio parsing, preventing column alignment shifts.
- [sec-parser.test.ts](file:///Users/jay/apps/trading-ag-rag/test/sec-parser.test.ts): Added a new unit test `should preserve row-spanned table cells correctly` validating rowspan cell replication.
- [rag-eval-harness.ts](file:///Users/jay/apps/trading-ag-rag/scripts/eval/rag-eval-harness.ts): Updated CIK-to-symbol resolution in the eval harness to check `sec_filings` first, falling back to `sec_ingest_tasks` to ensure active production-ingested CIKs are fully resolved.
- [sec-facts.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-facts.ts):
  - Excluded non-market Form 4 events from the evidence card by filtering for transaction codes `'P'` and `'S'`.
  - Added taxonomy name (`us-gaap` / `ifrs-full`) to the deterministic facts ID hash to prevent GAAP/IFRS concept name collisions.

## Verification
1. **TypeScript Compiler Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit` -> Passed with zero errors.
2. **Production Build Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run build` -> Next.js static and dynamic page bundles built successfully with zero errors.
3. **Unit Tests Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx vitest run test/sec-parser.test.ts test/search-fusion.test.ts test/sec-filings.test.ts test/strategy-rag-quickwins-wiring.test.ts test/persistence-notification.test.ts test/sec-ingest-worker.test.ts --run` -> All 79 tests passed successfully.
