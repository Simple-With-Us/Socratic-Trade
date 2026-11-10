# Rollout: 2026-07-15 — SEC/RAG Backfill Phase 2: Discovery and Archive

## Summary
Implements Phase 2 (Discovery and Archive) of the SEC/RAG 1,000-stock high-yield backfill plan.

## Why
To build:
1. A polite aggregate host-wide SEC rate limiter (token bucket) that respects EDGAR fair access limits and handles 429 `Retry-After` backoffs.
2. A local caching layer for raw filings (HTML/JSON) on the persistent volume to prevent redundant EDGAR hits.
3. Support for parsing older history shards (`filings.files` list) to look lookbacks deeper than the most recent 1,000 filings.
4. Exhibit index resolution helpers (`index.json` directory parsing).

## Touched Files
- [NEW] [sec-limiter.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-limiter.ts) — Token-bucket rate limiter.
- [MODIFY] [http.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/http.ts) — Integration of SEC rate limiter in `politeFetch`.
- [MODIFY] [sec-filings.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/web-sources/sec-filings.ts) — Integration of local filesystem cache check, submissions shard discovery, and directory parsing.
- [NEW] [sec-backfill-p2.test.ts](file:///Users/jay/apps/trading-ag-rag/test/sec-backfill-p2.test.ts) — Unit tests for rate-limiter, shard traversal, and directory parsing.
- [MODIFY] [STATUS.md](file:///Users/jay/apps/trading-ag-rag/STATUS.md) — Status ledger update.
- [MODIFY] [docs/EFFORT-LOG.md](file:///Users/jay/apps/trading-ag-rag/docs/EFFORT-LOG.md) — Effort log mirror update.
- [MODIFY] [/Users/jay/apps/TRADING-EFFORT-LOG.md](file:///Users/jay/apps/TRADING-EFFORT-LOG.md) — Shared live effort ledger update.

## Verification
- **ESLint:** `npm run lint` passed (0 errors, 501 warnings).
- **TypeScript:** `npx tsc --noEmit` passed (0 errors).
- **Unit Tests:** `npx vitest run test/sec-backfill-p2.test.ts` passed (4/4 green).
- **Integration Tests:** `npx vitest run test/sec-filings.test.ts` passed (44/44 green).
- **Production Build:** `npm run build` completed successfully.
