# RAG corpus hardening — content-hash dedup, metering, 8-K body ingest, coverage UI

_2026-06-29_

## Summary

Four additive gaps filled to harden the RAG pipeline without touching the already-working
10-K/10-Q filing ingestion (`sec-filings.ts`) or the disclosure RAG path:

1. **Chunk-level `content_hash` dedup** — SHA-256 hash per chunk stored in a new SQLite
   `document_chunks` table so a re-run of the same filing text never pays Voyage tokens
   for unchanged chunks.
2. **Voyage/Pinecone usage metering** — `src/lib/rag-metering.ts` mirrors `src/lib/llm-usage.ts`,
   tracking embed/rerank/query/upsert calls with cost estimates in a `rag_usage` table.
3. **8-K full-body ingest** — optional path in `sec8k.ts` that fetches full 8-K filing
   text and feeds it through `storeDocument` (gated behind `WEB_SOURCE_SEC8K_FULL_BODY`, default OFF).
4. **Corpus coverage UI** — admin API (`GET /api/admin/rag-coverage`) plus a client widget
   at `/admin/rag-coverage` showing per-ticker chunk counts, freshness, coverage gaps,
   and RAG usage cost.

## Why

The design doc `docs/design/full-filing-rag.md` §3.4 flagged these as deferred follow-ups,
and `docs/prod-config-voyage.md` listed them under "Follow-ups (additive, not yet shipped)".

All four are additive — zero existing behavior changed.

## Files

### Modified
- `src/lib/rag/chunk.ts` — added `content_hash` to `DocumentChunk`, `hashContent()` export, SHA-256 in `chunkDocument`
- `src/lib/vector-db.ts` — `storeDocument` now checks `filterNewDocumentChunks` before embedding; wires `meterEmbed`/`meterPineconeUpsert`/`meterPineconeQuery`/`meterRerank` at each API call site; imports from `rag-metering`
- `src/lib/db.ts` — added `document_chunks` table + index and `rag_usage` table + indexes in `migrate()`
- `src/lib/db-learning.ts` — added `filterNewDocumentChunks`, `insertDocumentChunks`, `getChunkCoverage` helpers
- `src/lib/web-sources/sec8k.ts` — added `eightKFullBodyEnabled()`, `ingestEightKBody()`, `ingestEightKBodies()`; wired fire-and-forget into `refreshEightK`; imports `extractFilingText` from `sec-filings.ts`
- `test/rag-chunk.test.ts` — added `hashContent` determinism + chunk content_hash carry tests

### New
- `src/lib/rag-metering.ts` — Voyage/Pinecone usage ledger with `recordRagUsage`, `meterEmbed`, `meterRerank`, `meterPineconeQuery`, `meterPineconeUpsert`, `getRagUsageSummary`
- `app/api/admin/rag-coverage/route.ts` — admin GET endpoint returning per-ticker coverage + RAG usage
- `app/admin/rag-coverage/page.tsx` — page shell
- `app/admin/rag-coverage/rag-coverage-client.tsx` — client widget with summary cards, per-ticker bar chart, coverage gaps warning, and RAG usage table
- `test/rag-metering.test.ts` — 8 tests: metering record/aggregate, sinceIso window, content-hash dedup filter/coverage

## Verification

```bash
npx tsc --noEmit   # clean
npm test            # 1516 passed / 157 files (includes new rag-metering tests)
```

## Follow-ups

- `WEB_SOURCE_SEC8K_FULL_BODY` remains OFF by default — enable once a paid Voyage key is in place (`VECTOR_EMBED_BATCH_DELAY_MS=0`)
- `rag_usage` cost estimates are approximate (word-count tokenizer, not Voyage's subword tokenizer) — refine when exact counts matter
- The coverage widget could be added to the admin layout sidebar — currently standalone at `/admin/rag-coverage`
