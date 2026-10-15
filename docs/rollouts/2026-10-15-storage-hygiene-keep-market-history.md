# Storage hygiene: keep market-data history forever

## Context & Objective

PR #4666 merged a storage-hygiene lane that deleted `history_cache_eod` rows older than 400 days.  Owner policy forbids deleting any price or market-data history by age.  This change removes market-data tables from hygiene retention targets and adds a hard guard so they cannot be pruned by this lane.

## Changes Made

- `MARKET_DATA_HISTORY_TABLES` plus `isMarketDataHistoryTable()` refuse DELETE on price, fundamentals, filings, transcripts, SEC facts, and document-chunk tables (including `document_chunks_fts*`).
- Removed `history_cache_eod` and `symbol_field_latest` from `RETENTION_TARGETS`.
- Tests assert market-data tables are never retention targets and `assertPruneTableAllowed` rejects them.

**Files**

- `src/lib/sqlite-storage-hygiene.ts`
- `test/sqlite-storage-hygiene.test.ts`
- `docs/rollouts/2026-10-15-storage-hygiene-keep-market-history.md`
- `STATUS.md`

## Decisions & Trade-offs

- `embed_stage` and `sec_ingest_task_attempts` stay on retention (operational staging/logs, not corpus content).
- `enrichment_coverage_*` stays on retention (operational coverage reports, not fundamentals snapshots).

## Verification State

```bash
npx vitest run test/sqlite-storage-hygiene.test.ts
npm run lint
npx tsc --noEmit
```

## Next Steps & Blockers

- Owner: squash merge with `do-not-automerge` (touches prod delete path semantics).  No data restore for rows already deleted by #4666 unless a separate backfill is planned.
