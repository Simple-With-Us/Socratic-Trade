# Rollout Note — 2026-06-20 — Multi-Tenant RAG & Rate-Limit Hardening

## Summary
Implemented security sanitization, rate-limiting, and error-handling improvements to harden the vector store and data providers for multi-user operations.

## Why / Decisions Made
- **User ID Sanitization**: Unsanitized user IDs in query filters can lead to Pinecone parse failures or query hijacking. We implemented a strict alphanumeric + `-` + `_` + `.` + `@` filter capped at 100 characters to safeguard the index.
- **Credential Lookup Preservation**: Pinecone metadata/filter user IDs are sanitized, but per-user Pinecone/Voyage API-key lookup still uses the raw app user ID so identity-provider IDs with punctuation keep resolving saved credentials.
- **RAG Chunk Dates**: Downstream LLMs need to evaluate the age of context snippets. We extract the publication date from the document metadata and prepend a standard `[Published: YYYY-MM-DD]` prefix during store operations.
- **Voyage API Rate Limiting**: Capped jitter (500ms) leads to collision storms during heavy batch operations. We switched to exponential backoff with Full Jitter. Query embeddings now also use Voyage retry wrapping.
- **Pinecone Parallel Queries**: Starter/serverless Pinecone filters can starve user-specific results. We perform parallel lookups for user-specific context and public `"local"` context, merge/deduplicate in-memory, and rank by score before slicing to `limit`.
- **Cache Poisoning Protection**: Previously, parallel fetch rejections or empty results were cached for 6 hours, blocking subsequent updates. We now prevent cache writes if any parallel promise rejects with a transient error, if all reject, or if the resulting data is completely empty.
- **Alpha Vantage warning detection**: Alpha Vantage serves error messages inside HTTP 200 payloads. We detect keys `Note`, `Information`, and `Error Message` and throw errors to trigger fetch retry bypassing the cache.

## Files Touched
- `src/lib/vector-db.ts` — User ID sanitization, Voyage jitter retry wrapping, date prepending, parallel queries, and deduplication/ranking.
- `src/lib/data-providers.ts` — Transient error helper, cache poisoning protection for Finnhub/FMP, and Alpha Vantage HTTP 200 warning detection.
- `test/vector-db.test.ts` — Unit/integration tests for sanitization, parallel query matching, date prepending, deduplication, and score ranking.
- `test/data-providers.test.ts` — Unit/integration tests for transient errors, cache poisoning prevention, and Alpha Vantage warning checks.

## Verification
Executed commands:
1. `npx tsc --noEmit` — Clean compile.
2. `npm test` — 271/271 Vitest tests passed.
3. `npm run build` — Clean production build compiled successfully.

## Follow-ups / Risks
- None. Multi-tenant RAG and data provider rate-limiting are fully hardened.
