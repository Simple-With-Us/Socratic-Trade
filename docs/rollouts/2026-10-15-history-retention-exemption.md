# History retention exemption (2026-10-15)

## Context & Objective

PR #4666 (merge a3d21b73, live on production) added storage hygiene that deletes `history_cache_eod` rows older than 400 days.  Still-open PR #4661 promises that table stays a permanent upsert with no age-based deletion, backing a ~5y (1825d) deep-history lookback.  The deployed code contradicted the documented design, and the first live pass actually deleted rows.  This change exempts durable EOD history from age-based cleanup while keeping disposable-cache cleanup intact.

## Changes Made

- `history_cache_eod` is no longer a hygiene retention target: the `history-cache-eod` entry, the `HISTORY_CACHE_RETENTION_DAYS` constant, and the now-unused `dayCutoff` helper are removed from the hygiene module.  The table stays categorized for size reporting with retain reason "durable price history (no age deletion)", and `assertPruneTableAllowed` refuses it as unlisted — the same guard that protects money-path tables.
- Disposable cleanup is unchanged: symbol-field cache (180d), embed stage, API health log, SEC ingest attempts, terminal runs/requests, task journal, and coverage pruning all keep their windows.
- I updated `docs/rollouts/2026-10-14-sqlite-storage-hygiene.md` (struck the 400-day EOD line) rather than replacing it, so the correction has a paper trail.
- Regression tests in `test/sqlite-storage-hygiene.test.ts`: old EOD rows (500d, 6y+) now survive the "deletes stale caches" pass; a new dedicated test proves 401d/1825d/2300d rows survive two consecutive live passes with no history estimate in the report; the allowlist test asserts no retention target touches the table and pruning it throws.

Touched files:

- `src/lib/sqlite-storage-hygiene.ts`
- `test/sqlite-storage-hygiene.test.ts`
- `docs/rollouts/2026-10-14-sqlite-storage-hygiene.md`
- `docs/rollouts/2026-10-15-history-retention-exemption.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Exemption (no age target at all) instead of a longer window: any finite window re-creates the same conflict later and contradicts the permanent-upsert design.  If the history footprint ever needs bounding, that is an explicit owner decision with a migration plan — not silent hygiene.
- `history-cache.ts` upsert code is untouched, and #4661's identical permanence comment there was deliberately not duplicated, to avoid colliding with that open PR's diff.
- `imported_price_eod` never had a retention target and was already safe; only `history_cache_eod` was deleting.
- No backfill is executed in this change: refilling before the exemption deploys would feed new old bars straight into the next delete pass.  See Next Steps for the paced proposal.

## Verification State

Production evidence collected before the fix (read-only, no credentials printed):

- Live release sha from public `/api/health`: `a3d21b73b105e65081b6fd697aac6974b0a5232f` — the #4666 merge.  The 400-day delete was live, not inferred.
- Cached hygiene report via `GET /api/ops/snapshot` (02:56:49Z pass, dryRun=false): `history-cache-eod` eligible=3,427,386 rows, deleted=5,000 (the 25-batch x 200 cap).  Deletion is confirmed real: ~5,000 scattered pre-2025-09-10 bars are gone.  No env override exists for the window — the 400d value was hardcoded, so the report's `retentionDays: 400` was the effective setting.
- Oldest retained date is not directly observable (`/api/history` requires auth; the snapshot carries no per-table oldest date).  With ~3.42M pre-cutoff rows still eligible at report time, multi-year history is largely intact; the loss is scattered gaps from one capped pass, not truncation (deletes pick by rowid order, not oldest-first).

Local gates (commands run, in order):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 854 grandfathered warnings).  `./node_modules/.bin/tsc --noEmit` pass.  `npm test` 9,378 passed, 51 skipped, 1 failed: `test/event-loop-stall-hot-path.test.ts` "pruneTaskJournal stays under 100ms" timed out at 60s — pre-existing and unrelated (fails identically on the clean `2656320f5` tree with this diff stashed; the file never touches hygiene or history).  Targeted `test/sqlite-storage-hygiene.test.ts` 15 passed (14 existing + 1 new 5y+ regression); `test/history*.test.ts` + `test/audit-hygiene.test.ts` 39 passed.  `npm run build` pass (compiled successfully, rc=0).

## Next Steps & Blockers

- Land this PR and verify: live sha moves past a3d21b73, and the next `storageHygiene` report carries no `history-cache-eod` estimate with `deletedRows` for history at 0.  Next full pass after the 02:56Z report lands ~08:56Z — merging before then stops a second 5,000-row pass.
- Backfill proposal (after the exemption is live): identify the ~5,000 missing (ticker, date) pairs older than 2025-09-10 by diffing cache coverage against the approved deep-path sources (Yahoo `range=max` paced at 400ms/concurrency 2, then Tradier history, then Twelve Data within its 8/min + 800/day quota), refill via the existing `upsertHistoryCacheEod` (COALESCE semantics preserve existing rows), and never issue full-universe refetches — targeted gaps only, paced through the existing provider limiters.  Owner approval needed before running it, since it spends provider quota.
- Notify #4661 (cursor/free-data-gaps-55d1) that the permanent-upsert promise now holds on main, so its rollout note stays accurate on merge.
- Linear ST-4532 moves to Completed on merge and Deployed after the live-sha + hygiene-report verification above.

## Zero-Code Findings

- The 400-day window had no env override — `SQLITE_STORAGE_HYGIENE_DRY_RUN`/`DISABLED` gate the whole lane, not per-table windows.  Per-table tuning would need a code change.
- `/api/history` returns 401 without a session, so oldest-bar checks need an authenticated read; the ops snapshot is the unauthenticated-safe surface for retention forensics.
