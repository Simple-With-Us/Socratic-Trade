# 2026-07-04 - RAG filing ingest smoke + deterministic vector ids

## Summary

Verified production RAG against the new Pinecone account/index and fixed SEC filing vector ids so
retries are stable.

## Why

The RAG dashboard previously showed one stale ticker (`A`) with an ingest accession but zero chunk
coverage, and the old Pinecone account had hit its monthly Write Unit limit. Before any larger
backfill, we needed a controlled smoke test proving the app writes to and retrieves from the new
`socratic-trade` index without wasting quota.

## Production smoke test

- Production runtime secrets are injected through `scripts/infisical-run.mjs`.
- Runtime Pinecone stats showed one visible index: `socratic-trade`, dimension `1024`.
- Before ingest: `totalVectorCount=0`.
- First manual MSFT filing ingest timed out after writing 56 vectors but before local bookkeeping.
- Retrieval already worked against those vectors, proving the new index was receiving searchable
  SEC chunks.
- Re-ran the same MSFT filing with `VECTOR_EMBED_BATCH_DELAY_MS=0` for the manual command only.
- Successful completed ingest:
  - ticker: `MSFT`
  - accession: `0001193125-26-191507`
  - doc type: `10-Q`
  - filed: `2026-04-29`
  - accepted: `2026-04-29T20:06:24.000Z`
  - vectors indexed: `95`
  - `document_chunks` rows: `95`
  - `ingested_accessions` row recorded with `chunk_count=95`
  - retrieval returned MSFT MD&A chunks from `sec-edgar`.
- Deleted the 56 orphan vectors from the timed-out first run. Final Pinecone stats: `95` vectors.

## Decision

SEC filing ingestion must pass a deterministic `doc_id` to `storeDocument`. Without that, the
chunker defaults `doc_id` to a random UUID, so retrying the same filing can create duplicate vector
ids. The new invariant is:

```text
doc_id = ticker:accession:docType
```

## Files

- `src/lib/web-sources/sec-filings.ts`
- `test/sec-filings.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-04-rag-filing-ingest-smoke.md`

## Verification

- `npx vitest run test/sec-filings.test.ts`
- Production direct vector stats through Infisical runtime:
  - `indexName=socratic-trade`
  - `exists=true`
  - `dimension=1024`
  - final `totalVectorCount=95`
- Production retrieval smoke for `MSFT` returned `sec-edgar` 10-Q chunks.

## Follow-ups

- Add `ADMIN_REINDEX_TOKEN` to the production Infisical app project if we want the admin
  `/api/admin/reindex-10k` route usable in production. It is currently fail-closed.
- Before larger backfills, consider a chunk-level progress ledger or per-batch finalization so a
  killed process can reconcile partially written vectors more cleanly.
