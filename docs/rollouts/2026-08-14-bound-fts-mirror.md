# 2026-08-14 — Bound per-document FTS mirror with durable resume

## Context & Objective

#2680 added a 250ms adaptive yield inside `insertDocumentChunkFtsBatch`.  Live receipts after that "fix" were worse, not better: `ftsMirrorBatch 279522ms (933 chunks)`, then 103s / 98s / 91s.  Every `embed_queued` task failed with `Failed to advance checkpoint from embed_queued to embedded` and `Ingestion budget or capacity exceeded mid-task`.  Queue sat at 3501 pending / 16 complete (~0.5%).  Site 50% timeouts, CPU 103%, health 503.

Yielding converts a hard block into a long soak.  933 chunks needing 279s is a throughput problem.  A 250ms stretch budget cannot bound wall-clock or keep a 60s lease alive.  The lease heartbeat ran only during `storeDocument`, not during the FTS mirror.

This PR is the durable fix Monet's `bound-fts-mirror-cost` workflow started and never finished (quota).  Code + PR only.  Do **not** re-enable `SEC_INGEST_WORKER_ENABLED` here.  Re-enable is the owner's call after this lands.

## Changes Made

- Split the FTS mirror into per-tick slices.  Bound is **20 chunks or 6s wall-clock, whichever first**.  Math from the live receipt: `20 * (279522 / 933) = 5991.9ms <= 6000ms`.  A 933-chunk filing is ~47 ticks, never 279s in one call.
- Resume is durable via `countDocumentChunkFts` (what was actually written).  Next lease continues from that offset.  `fts-progress.json` is an observability artifact, not the source of truth.
- Heartbeat the 60s lease every 20s across **both** `storeDocument` and the FTS mirror.
- Partial ticks call new `releaseSecIngestTaskForResume` (immediately reclaimable, stage-attempt refunded) so 47 slices cannot dead-letter a healthy filing (`max_stage_attempts` is 6).
- Skip `storeDocument` on FTS-only resume (storeResult present or FTS rows already exist).  Keep the existing WU-defer and capacity-exceeded throw when store has not completed.
- `insertDocumentChunkFtsBatch` keeps its internal 250ms yield.  The worker never feeds it 933 chunks in one call.

Touched files:
- `src/lib/rag/fts-mirror-bound.ts` (new; pure slice/lease policy)
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/db-learning.ts` (`countDocumentChunkFts`, export stretch constant)
- `src/lib/db-rag-ingest.ts` (`releaseSecIngestTaskForResume`)
- `test/sec-ingest-worker.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- **20 chunks / 6s**, not a larger cap.  Computed from the production 299.6ms/chunk, not a comment.  Inner feed is 8 (the batch helper's starting group) so the tick can re-check the wall clock.
- Resume cursor is the FTS row count, not `payload_json`.  Enqueue treats payload as immutable replay identity; mutating it would throw `SEC ingest task replay conflict` on a seeder re-run.
- `releaseSecIngestTaskForResume` does **not** use `deferSecIngestTask`'s 60s clamp.  47 slices * 60s would add ~47 minutes of idle queue time.
- Attempt outcome stays `retry_wait` (existing CHECK).  No schema migration.
- This PR does **not** flip Infisical or restart prod.  The worker stays off until the owner re-enables it.

## Verification State

- `./node_modules/.bin/tsc --noEmit` clean
- `./node_modules/.bin/vitest run test/sec-ingest-worker.test.ts` 19/19
- `./node_modules/.bin/vitest run test/pinecone-wu-breaker.test.ts test/rag-ingest-worker.test.ts` 30/30
- Full `scripts/land.sh` trio (tsc → test → build) at push

Policy tests pin the production numbers: 933 chunks / 279522ms, sync stretch stays 250ms, worst-case tick wall 5991.9ms, resume does not re-plan completed slices, and the 279s no-heartbeat full-mirror **does** expire a 60s lease while the capped+heartbeated tick does not.

## Next Steps & Blockers

- Owner: after this deploys and the site stays healthy, decide whether to re-enable `SEC_INGEST_WORKER_ENABLED`.  Do not flip it in this PR.
- Watch the first `ftsMirrorSlice` logs (`start->end/total`, cap 20/6000ms).  A 933-chunk filing should be ~47 short ticks, not one 279s soak.
- Do not restart prod or change Infisical as part of this landing.
