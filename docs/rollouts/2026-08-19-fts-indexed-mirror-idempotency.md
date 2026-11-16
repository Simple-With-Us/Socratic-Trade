# FTS indexed mirror idempotency + strategy-run yield (event-loop-pins)

## Context & Objective

Part II cluster `event-loop-pins` from `docs/reviews/2026-08-18-full-app-expert-review.md`: FTS5 idempotency DELETE on non-rowid columns was a full-corpus scan (~300ms/chunk live), and whole-doc mirror callers (`persistLocalComplete`, filing-body ingest) pinned the serving loop with no yield or `hasInFlightStrategyWork()` gate.

## Changes Made

- Added `document_chunks_fts_index` side table (migration v85) mapping occurrence identity → `fts_rowid`, with one-time backfill from `document_chunks_fts`.
- Rewrote `insertDocumentChunkFts` / `insertDocumentChunkFtsBatch` to PK-lookup + `DELETE … WHERE rowid = ?` + index upsert (O(1) idempotency).
- `countDocumentChunkFts` now counts from the index table.
- New `mirrorFtsChunksBounded` routes mirror work through `planFtsMirrorSlice`, `yieldEventLoop`, and `hasInFlightStrategyWork`.
- `persistLocalComplete` is async and uses the bounded mirror; records ledger only when mirror completes.
- `ingestFiling` filing-body FTS mirror uses the same bounded helper; defers with `deferredStrategy` when strategy work is in flight.

**Files touched**

- `src/lib/db.ts`
- `src/lib/db-learning.ts`
- `src/lib/rag/mirror-fts-bounded.ts` (new)
- `src/lib/rag/persist-local-complete.ts`
- `src/lib/web-sources/sec-filings.ts`
- `test/persist-local-complete.test.ts` (new)
- `test/sec-ingest-worker.test.ts`
- `test/sec-filings.test.ts`
- `test/pinecone-write-class.test.ts`
- `test/persistence-hardening.test.ts` (schema version 84→85 for migration v85)

## Decisions & Trade-offs

- FTS mirror moved outside `runWithActiveVectorCommitProof` for filing-body ingest so yields are possible; ledger insert stays inside the commit proof after mirror completes.  Partial FTS on strategy defer leaves accession un-ledgered for retry (idempotent).
- `document-summarizer.ts` bulk DELETE left untouched (orphan index rows are harmless per review plan).
- Did not change `RAG_PINECONE_WRITE_CLASS`, embed model, or Pinecone index.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npx vitest run test/persistence-hardening.test.ts test/persist-local-complete.test.ts test/sec-ingest-worker.test.ts test/pinecone-write-class.test.ts test/sec-filings.test.ts  # 107 passed
npm run build         # clean
```

Rebased onto `origin/main` (2026-08-20); CI `verify` failed on hardcoded migration 84 until `persistence-hardening` retarget.

## Next Steps & Blockers

- Green `verify` on PR #2885; owner merge when ready (do not auto-merge from agent).
- Optional follow-up: route `document-summarizer.ts` FTS mirror through bounded helper; clean orphan index rows on its bulk DELETE.

## Zero-Code Findings

None.
