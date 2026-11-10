# 2026-09-01 - Qdrant write-path cutover, stage 2

## Context & Objective

Owner 2026-09-01: self-hosted Qdrant must become fully integrated for ALL ST purposes and data ingestion.  Stage 1 (#3138) already serves dense reads from collection `socratic-trade` (thousands of production searches, 0 errors).  Writes still hit Pinecone `index.upsert` / `deleteMany` / hourly `reconcileManagedVectorRecords`, so Pinecone WU exhaustion kept parking ingest and paging Alerts Center.  Stage 2 moves upsert, delete, payload patch, and inventory onto Qdrant.

## Changes Made

- New `src/lib/vector-store/qdrant-write.ts`: `vectorWriteBackend()` (knob `RAG_VECTOR_WRITE_QDRANT`, default true when `QDRANT_URL` is set), uuid5 point ids matching `scripts/qdrant/pinecone-to-qdrant-copy.py`, payload `pc_id` + `ns`, REST upsert/delete/set-payload/scroll/collection-info, metering provider `"qdrant"` with zero write units.
- Wired `storeContexts` / `storeDocument` / managed commit re-upsert, deletes (metadata purge, exact ids, managed ids, namespace deleteAll, account erasure filter+verify), `inventoryVectorRecordsByMetadata`, `getVectorStoreStats` / `getAllVectorStoreStats`, and `reconcileManagedVectorRecords` to the write backend.  Qdrant path does not call Pinecone and does not call `withRagApiHealth("pinecone")`.
- Pinecone monthly WU breaker and daily write fuse apply only when the write backend is pinecone.  SEC ingest worker, filings preflight, and `hasPineconeWriteBudget` skip those parks on Qdrant.
- Provider authority on the Qdrant path comes from `durableProviderAuthority` (SQLite commits) so `assertIndexMetric` being skipped cannot leave authority undefined (boards dc98d716 / c741db8e).  Retrieval no longer calls `describeIndex` when reads are already on Qdrant even if a Pinecone key is present.
- Tests: `test/qdrant-write.test.ts` (mocked fetch: id scheme, payload, delete filter, backend resolution, zero-WU meter).  Extended `test/vector-db-qdrant-retrieval.test.ts` so store/inventory/reconcile/authority work without a Pinecone client, including a tripped WU marker.

Touched files:

- `src/lib/vector-store/qdrant-write.ts` (new)
- `src/lib/vector-store/qdrant-read.ts` (stage-2 pointer in header)
- `src/lib/vector-db.ts`
- `src/lib/server-knobs.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/web-sources/sec-filings.ts`
- `test/qdrant-write.test.ts` (new)
- `test/vector-db-qdrant-retrieval.test.ts`
- `test/vector-db.test.ts` (pin pinecone write backend)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-01-qdrant-write-cutover.md`

## Decisions & Trade-offs

- Did **not** uninstall `@pinecone-database/pinecone`.  Remaining call sites stay behind `vectorWriteBackend() === "pinecone"` plus the pinecone read path and the one-shot `backfillAsOfEpoch` ops tool.  A follow-up can delete the package once prod has run Qdrant-only.
- Did **not** run the Sep-1 Pinecone->Qdrant delta copy.  Pinecone reads still 429; burning remaining units for a delta is not worth it.  The 08-28 copy already holds ~801k non-Voyage points.  After this PR, new ingest writes Qdrant directly, so the copy gap cannot grow.
- Did **not** point ST embeddings at the fleet bge-m3 endpoint (board b99cba29, spaces incompatible).  Writes use the existing ST embed provider/model.
- Qdrant inventory of a namespace is a scroll (client-side prefix filter) rather than Pinecone `listPaginated({ prefix })`.  Acceptable on the self-hosted box; hourly reconcile is still gated by `assertGatherSafeWholeIndexInventory`.
- Account-deletion residual verify still uses a stability window.  Qdrant is immediately consistent, so the window should pass on the first clean observation.

## Verification State

Commands run:

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version   # v24.20.0
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run test/qdrant-write.test.ts test/qdrant-read.test.ts \
  test/vector-db-qdrant-retrieval.test.ts test/vector-db.test.ts \
  test/vector-db-document-receipts.test.ts test/pinecone-wu-breaker.test.ts \
  test/scheduler-managed-vector-reconcile.test.ts \
  test/local-db-fault-classification.test.ts \
  test/pinecone-filter-to-qdrant.test.ts \
  test/vector-db-retrieval.test.ts test/sec-ingest-worker.test.ts
```

tsc clean.  Focused suites green (qdrant-write  + retrieval wiring + existing pinecone store tests).  Full gate via `scripts/land.sh`.

## Next Steps & Blockers

1. After merge/deploy: `bash scripts/verify-deploy-sha.sh`; confirm ingest no longer trips Pinecone 429s; confirm Qdrant `points_count` moves on the next filing/transcript write.
2. Follow-up: uninstall `@pinecone-database/pinecone` once the pinecone backend flag is unused in prod.
3. Follow-up: port `backfillAsOfEpoch` if a Qdrant-side as-of backfill is ever needed (the 08-28 copy already stamped `as_of_epoch_ms`).
4. Follow-up: Qdrant snapshot->R2 cron + mesh watchdog (still open from Stage 1).
5. Do not bounce Coolify.  Do not FORCE_RESTORE.

## Zero-Code Findings

Skipped the Sep-1 Pinecone delta copy on purpose: remaining Pinecone read units are the failure mode Stage 1 existed to escape.  Qdrant-only sentinel backfill is a no-op unless new Pinecone-origin points appear, which they will not after this write cutover.
