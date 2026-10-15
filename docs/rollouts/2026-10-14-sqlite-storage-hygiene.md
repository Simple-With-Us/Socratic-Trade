# SQLite storage hygiene (2026-10-14)

## Context & Objective

Production SQLite is about 16.5 GB with a 415 MB pending WAL while Litestream is replicating.  Background checks spiked to 76-79s and the scheduler lagged 120s.  The goal is scheduled SQLite maintenance (checkpoint, ANALYZE/optimize, incremental free-page reclaim) without deleting money-path records and without a blocking full file rewrite.  **Update 2026-10-15:** age-based row deletes were removed entirely; see `docs/rollouts/2026-10-15-storage-hygiene-forever-retention.md`.

## Changes Made

A new `storage-hygiene` scheduler lane runs a full pass every 6 hours and a WAL checkpoint every 10 minutes.  **Historical note:** the first version batched age-based deletes; that behavior was retired 2026-10-15.  The daily audit prune lane is separate.  Portfolio snapshots stay on the existing 90-day audit lane and are refused by storage hygiene.

Fresh database files arm `auto_vacuum=INCREMENTAL` before `journal_mode=WAL` writes the header.  Existing files are left on their current mode.  When the mode is already INCREMENTAL, each pass may run `incremental_vacuum` for at most 128 pages.  The job never issues a full rewrite.

WAL checkpoint is PASSIVE.  TRUNCATE runs only after that copy reports busy 0 and every frame copied, the WAL is at least 8 MiB, and the local Litestream generation is fresh or absent.  A stale or unreadable replica refuses TRUNCATE.

`GET /api/ops/snapshot` attaches the last cached report.  It does not walk `dbstat` on the request.

`SQLITE_STORAGE_HYGIENE_DRY_RUN=1` estimates and writes the report, and deletes nothing, checkpoints nothing, and does not reclaim pages.  `SQLITE_STORAGE_HYGIENE_DISABLED=1` turns the lane off.  The default after merge is live deletes.  This PR is labeled `do-not-automerge` so Jay squashes.

- `src/lib/sqlite-storage-hygiene.ts`
- `src/lib/audit-prune.ts`
- `src/lib/db.ts`
- `src/lib/scheduler.ts`
- `src/lib/ops-snapshot.ts`
- `test/sqlite-storage-hygiene.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-14-sqlite-storage-hygiene.md`

## Decisions & Trade-offs

- Money-path denylist: `fill_events`, `order_replacements`, `trade_proposals`, `portfolio_snapshots`, stop and bracket tables, `settings` (HWM and SOD keys live here), connected accounts, account strategy state, and learned context.  An unlisted table throws before any DELETE is prepared.  `llm_usage` stays for the lifetime rule and is reported, not deleted.  Document chunks and FTS stay (retrieval corpus).
- **Retention windows (retired 2026-10-15):** strategy runs, logs, task journal, embed stage, coverage, and EOD history are kept forever from the hygiene lane.  See `docs/rollouts/2026-10-15-storage-hygiene-forever-retention.md`.
- Audit row deletes stay on the daily audit-prune lane only.
- `expectedFileShrinkBytes` is pages returned by `incremental_vacuum` this pass.  On a production file that is still `auto_vacuum=NONE`, the file size does not shrink until a separate owner decision.
- No `CREATE INDEX` in `migrate()` for the new deletes.  A boot-time index on a multi-gigabyte table is the stall class from 2026-10-05.  History-cache deletes filter `date` in batches.  Coverage deletes by the existing `as_of` key.
- Watermarks and the ops report are quiet `settings` writes.  They do not insert `policy_change` audit rows.
- The storage-hygiene lane runs after the single-leader gate.  A follower does not checkpoint or delete.  `runStorageHygieneIfDue` also refuses a second same-process call while one pass is in flight, and it claims `storage-hygiene:lastFullAt` before the await.  A thrown pass keeps that claim so the next tick does not start another full walk.
- Litestream age reads the generation directory by directory, not by the first 80 `readdir` entries.  A wide LTX directory contributes its highest-named files (name order is write order).  A walk that stops early stays uncertain and refuses TRUNCATE.
- Each coverage batch deletes `enrichment_coverage_fields` and `enrichment_coverage_runs` in one transaction.  There is no foreign key between them.
- Daily audit prune stays watermark-first, matching `runAuditPruneIfDue`.  Moving that write to after the yielding delete would let the next 60s tick start a second delete pass.  Partial deletes stay committed and the next daily pass continues the backlog.
- Phase docs are unchanged.  This is operational retention, not a phase-design change.  `docs/EFFORT-LOG.md` is archived and was not edited.
- Linear team ST and Zulip were not updated.  This cloud seat has no Fleet Linear client credentials and no Zulip credentials (`board whoami` and `agent-sync whoami` both refused).

## Verification State

- npm run lint -> ok (0 errors, 866 grandfathered warnings)
- npx tsc --noEmit -> ok
- npm test -> 1 failed, 9341 passed, 51 skipped.  The failure is sandbox DNS for discord.com in `test/egress-guard.test.ts`, outside this diff.  `test/sqlite-storage-hygiene.test.ts` 14 passed.
- npm run build -> ok

## Next Steps & Blockers

- Jay reviews and squashes.  Do not automerge.  The job deletes production rows once it is on `main` and the image ships (weekday RTH still latches the image build).
- Optional before squash: set `SQLITE_STORAGE_HYGIENE_DRY_RUN=1` on the Coolify app for one 6-hour pass and read `storageHygiene` on `GET /api/ops/snapshot`.  The default without that env is live.
- The 16.5 GB file will not shrink until it is on INCREMENTAL, which this job will not force.  Freelist reuse is the production effect.  A later, explicit rewrite is a separate owner decision.
- Fleet board claim is blocked on missing `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` for this seat.

## Zero-Code Findings

`wal_checkpoint(PASSIVE)` returns `busy`, `log`, and `checkpointed`.  `busy` is 0 or 1, not a frame count.  After a complete PASSIVE copy the WAL file can stay large until TRUNCATE.  `PRAGMA auto_vacuum = INCREMENTAL` on a database that already has tables does not change the mode.  Setting it before `journal_mode=WAL` on an empty file sticks at 2.  `incremental_vacuum` on mode NONE returns no rows and does not shrink the file.
