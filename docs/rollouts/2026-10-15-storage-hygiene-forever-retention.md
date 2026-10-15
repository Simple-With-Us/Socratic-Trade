# Storage hygiene: forever retention (2026-10-15)

## Context & Objective

Jay decision (2026-10-15 03:13 CT): Socratic Trade keeps strategy runs and every operational log forever.  Age-based row deletes are removed from the `storage-hygiene` scheduler lane so production cannot silently trim run history, task journal, API health logs, embed stage, coverage runs, or related tables.

## Changes Made

- `src/lib/sqlite-storage-hygiene.ts` — no row deletes; maintenance only (ANALYZE, optimize, incremental_vacuum, WAL checkpoint).
- `src/lib/audit-prune.ts` — age-based `audit_events` / provider table deletes removed; daily watermark kept, counts always zero.
- `src/lib/db-task-journal.ts` — `pruneTaskJournal` is a no-op.
- `src/lib/db-fills.ts` — `sweepPortfolioSnapshots` is a no-op.
- `src/lib/db-embed-stage.ts` — `sweepEmbedStage` no longer age/cap-deletes; rows clear only via `deleteStagedEmbeddings` after Pinecone delivery.
- `src/lib/db-economic-events.ts`, `src/lib/headline-first-seen.ts` — age prunes disabled.
- `test/forever-retention-no-age-delete.test.ts` — regression guard on policy modules.
- `test/audit-hygiene.test.ts`, portfolio/embed/headline/hygiene tests updated.
- Docs: rollout notes, `STATUS.md`, `PLAN.md`, scheduler comments.

## Decisions & Trade-offs

- **Transient queues left alone (not calendar TTL):**
  - `embed_stage` — `deleteStagedEmbeddings` / corrupt-row delete after successful Pinecone delivery.
  - `api_health_log` — per-service lane **count** cap (`HEALTH_LOG_LANE_CAP`), not age.
  - Operational lease/settings keys, vector commit cleanup, account deletion, user-initiated deletes — unchanged.
- Disk growth is accepted; bounding history requires an explicit owner decision.

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
