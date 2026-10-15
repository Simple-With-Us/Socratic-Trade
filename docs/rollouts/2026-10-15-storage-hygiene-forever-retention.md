# Storage hygiene: forever retention (2026-10-15)

## Context & Objective

Jay decision (2026-10-15 03:13 CT): Socratic Trade keeps strategy runs and every operational log forever.  Age-based row deletes are removed from the `storage-hygiene` scheduler lane so production cannot silently trim run history, task journal, API health logs, embed stage, coverage runs, or related tables.

## Changes Made

- `src/lib/sqlite-storage-hygiene.ts` — removed `RETENTION_TARGETS`, coverage pruning, and all `DELETE` paths.  The lane now runs `ANALYZE`, `PRAGMA optimize`, capped `incremental_vacuum` (when `auto_vacuum=INCREMENTAL`), and WAL checkpoint/TRUNCATE only.  Ops reports still walk `dbstat` sizes; `deletedRows` and `estimates` stay at zero/empty.
- `src/lib/scheduler.ts` — scheduler summary uses `shrinkBytes` instead of `eligibleBytes`.
- `test/sqlite-storage-hygiene.test.ts` — expectations updated for forever retention; regression test fails if `DELETE FROM`, `RETENTION_DAYS`, or `isoCutoff` reappear in the hygiene module.
- `docs/rollouts/2026-10-15-history-retention-exemption.md` — backfill note no longer proposes Yahoo/Tradier/Twelve Data refills.
- `docs/rollouts/2026-10-14-sqlite-storage-hygiene.md` — retention windows struck; lane is maintenance-only.
- `STATUS.md`, `PLAN.md`

## Decisions & Trade-offs

- Audit row age deletes remain on the **daily audit-prune lane** only (`src/lib/audit-prune.ts`).  Storage hygiene no longer estimates eligible audit bytes.
- `task_journal` may still be pruned by `pruneTaskJournal` in `db-task-journal.ts` if that lane runs separately — out of scope for this change; Jay's directive targeted storage hygiene.
- Disk growth is accepted; bounding history is an explicit owner decision, not silent hygiene.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/sqlite-storage-hygiene.test.ts
npm test
npm run build
```

- `npm run lint` — 0 errors (854 grandfathered warnings)
- `npx tsc --noEmit` — ok
- `npx vitest run test/sqlite-storage-hygiene.test.ts` — 17/17 passed
- `npm test` — 9376 passed, 51 skipped, 24 failed (pre-existing; e.g. `test/server-metrics.test.ts`, unrelated to hygiene)
- `npm run build` — ok

## Next Steps & Blockers

- After merge: confirm the next `GET /api/ops/snapshot` `storageHygiene` report shows `deletedRows: 0` and empty `estimates`.
- Linear: claim/file effort row and close on deploy verification.

## Zero-Code Findings

None.
