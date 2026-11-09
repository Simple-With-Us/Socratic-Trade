# Rollout Note: SEC RAG Advanced Backfill Improvements (2026-07-17)

## Summary
Successfully implemented the Advanced RAG Backfill improvements (`RAG-B08`, `RAG-B09`, `RAG-B10`, `RAG-B13`, `RAG-B14`) to optimize database-backed caching, prioritize annual and quarterly report backfills globally, inject structured company facts and insider transactions cards into per-symbol dossiers, execute a two-stage retrieval process (scouting all scanned candidates at limit=1, and deep-retrieving finalists + holdings at limit=8), and expose a complete, uncapped admin coverage statistics report.

## Touched Files
- [sec-filings.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-filings.ts): Updated `refreshFilingBodiesUnlocked` to read discovered filings from SQLite, cap online CIK scans to 20 per tick, and sort filings breadth-first globally. Added `sortBreadthFirst` helper.
- [sec-ingest-worker.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/rag/sec-ingest-worker.ts): Check the local raw HTML artifact cache before calling `politeFetchText` inside the `discovered` queue checkpoint handler.
- [sec-facts.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-facts.ts): Implemented `formatInsiderTransactionsEvidenceCard` to query `sec_insider_transactions` and return structured Form 4 transaction cards.
- [strategy.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/strategy.ts): Implemented the two-stage filings RAG query (scouting all scan candidates with limit=1, deep-scouting top-3 + holdings with limit=8). Loaded the CIK map inside a `try-catch` block to ensure robustness. Built and formatted markdown dossiers per symbol dynamically joining Company Facts Cards, Insider Transactions Cards, and narrative chunks.
- [route.ts](file:///Users/jay/apps/trading-ag-rag/app/api/admin/rag-coverage/route.ts): Replaced the 200-row cap with uncapped queries over `sec_filings` and `sec_artifacts`. Returns active model name, parser versions, and exact date ranges per symbol.
- [sec-filings.test.ts](file:///Users/jay/apps/trading-ag-rag/test/sec-filings.test.ts): Added database cleanup after each test block to prevent data leakage and isolate the test runs.

## Verification
1. **TypeScript Compiler Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit` -> Passed with zero errors.
2. **Production Build Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run build` -> Next.js static and dynamic page bundles built successfully with zero errors.
3. **Unit Tests Check**:
   `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm test -- test/sec-filings.test.ts test/strategy-held-position-retrieval-scope.test.ts test/strategy-prompt-safety.test.ts test/strategy-rag-quickwins-wiring.test.ts --run` -> All 51 tests passed successfully.
