# SEC/RAG 1,000-Stock Backfill: P1 — Identity and Manifest

## Summary
Completed the implementation of P1 (Identity and Manifest) package of the SEC/RAG 1,000-stock high-yield backfill program. This structures relational manifest tracking for filings, documents, and chunk occurrences, splitting the embedding cache deduplication from evidence identity.

## Why
Under the old architecture, identical text across multiple filings/issuers would deduplicate at the database primary key level, meaning we would lose distinct occurrence metadata (e.g. ticker, accession number, acceptance date). This prevented point-in-time filtering from behaving correctly. The new design caches Voyage embedding vectors but preserves and logs every unique occurrence in Pinecone and SQLite.

## Files Touched
- [src/lib/db.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/db.ts)
- [src/lib/db-learning.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/db-learning.ts)
- [src/lib/vector-db.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/vector-db.ts)
- [src/lib/web-sources/sec-filings.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-filings.ts)
- [src/lib/web-sources/sec8k.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec8k.ts)
- [docs/EFFORT-LOG.md](file:///Users/jay/apps/trading-ag-rag/docs/EFFORT-LOG.md)
- [STATUS.md](file:///Users/jay/apps/trading-ag-rag/STATUS.md)

## Verification
- Run typescript compilation checks: `npx tsc --noEmit` completed successfully with 0 errors.
- Run ESLint checks: `npm run lint` completed successfully with 0 errors (warnings only).
- Run Vitest tests: `npm test` completed successfully with 3,927 / 3,927 passing tests.
- Run database query counts to verify migration & backfill:
  ```bash
  sqlite3 data/app.db "SELECT 'filings', count(*) FROM sec_filings; SELECT 'occurrences', count(*) FROM chunk_occurrences;"
  # filings|1
  # occurrences|205
  ```
- Run census script:
  ```bash
  npm run eval:rag-census
  ```
