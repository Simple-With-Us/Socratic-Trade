# Rollout Note: Managed RAG ingestion provider-authority gate

## Summary

Repaired the managed `storeDocument` configuration gate so production BGE-M3 ingestion requires
Pinecone initialization and the resolved active embedding provider credential. It no longer requires
the test-only Voyage client.

## Why

The Voyage SDK purge left `getClients()` intentionally creating Voyage only during tests, while the
managed document path still required `providerClients.voyage`. Production OpenRouter BGE-M3 documents
therefore returned `unconfigured` before embedding or Pinecone upsert.

## Files

- `src/lib/vector-db.ts`
- `test/vector-db-chunk-cap.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/design/full-filing-rag.md`
- `docs/EFFORT-LOG.md`

## Verification

- `git diff --check`
- Scoped ESLint: `node_modules/.bin/eslint src/lib/vector-db.ts test/vector-db-chunk-cap.test.ts`
  (0 errors; existing warnings only).
- Focused Vitest: `node_modules/.bin/vitest run test/vector-db-chunk-cap.test.ts -t 'uses the active OpenRouter' --reporter=verbose`
  passed (1 passed, 14 skipped), using mocked OpenRouter and Pinecone only.
- TypeScript: `node_modules/.bin/tsc --noEmit` passed.

## Follow-ups

- Review and land this isolated code-path repair before relying on normal managed ingestion.
- The active corpus re-embed is outside this lane. Do not purge legacy vectors until the existing
  operational re-embed program independently verifies complete active-space coverage.
