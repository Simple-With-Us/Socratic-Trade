# SQLite storage hygiene (2026-10-14)

## Context & Objective

Production SQLite is about 16.5 GB with a 415 MB pending WAL while Litestream is replicating.  Background checks spiked to 76-79s and the scheduler lagged 120s.  The goal is a scheduled cleanup that reclaims cache, log, and finished-run rows without deleting money-path records and without a blocking full file rewrite.

## Changes Made

A new `storage-hygiene` scheduler lane runs a full pass every 6 hours and a WAL checkpoint every 10 minutes.  Deletes are `rowid` batches (default 200, at most 25 batches per target) and the lane awaits `yieldEventLoop` between full batches.  The daily audit prune uses the same retention as before, now in 500-row steps with a yield between steps.  Portfolio snapshots stay on that existing 90-day lane and are refused by the new job.

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
- Retention windows: terminal unreferenced strategy runs 120 days, terminal run requests 30 days, skipped task-journal rows 1 day, other finished journal rows 30 days, EOD history cache 400 days, symbol-field cache 180 days, embed stage 35 days, API health log 14 days, inactive SEC ingest attempts 21 days.  Coverage keeps the newest 30 runs always, and deletes past 90 days or past 120 runs.  Runs referenced by a fill or a proposal are kept even when old.  Running rows are kept.
- Audit row deletes stay on the daily lane.  Hygiene only counts them so the report can show the eligible bytes.  That avoids two lanes deleting the same rows.
- `expectedReclaimBytes` is the logical page-fraction of eligible hygiene rows.  `expectedFileShrinkBytes` is pages actually returned this pass.  On a production file that is still `auto_vacuum=NONE`, deletes free pages for reuse and the file size does not shrink.  Switching that file would require a full rewrite, which this job refuses.
- No `CREATE INDEX` in `migrate()` for the new deletes.  A boot-time index on a multi-gigabyte table is the stall class from 2026-10-05.  History-cache deletes filter `date` in batches.  Coverage deletes by the existing `as_of` key.
- Watermarks and the ops report are quiet `settings` writes.  They do not insert `policy_change` audit rows.
- Phase docs are unchanged.  This is operational retention, not a phase-design change.  `docs/EFFORT-LOG.md` is archived and was not edited.
- Linear team ST and Zulip were not updated.  This cloud seat has no Fleet Linear client credentials and no Zulip credentials (`board whoami` and `agent-sync whoami` both refused).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx vitest run test/sqlite-storage-hygiene.test.ts
```

`npm run lint` ok (0 errors, 866 grandfathered warnings).  `npx tsc --noEmit` ok.  `npm run build` ok.  Targeted hygiene tests 12 passed.  Full `npm test` was 9284 passed, 51 skipped, and 25 failed.  Those 25 are outside this diff: provider-key tests expect no OpenRouter or notify credential in the environment, `scripts/ops/summarize-cpuprofile.mjs` fails to import a `.ts` file under this Node 22, Twelve Data and Alpha Vantage pool cases see a configured key, and server-metrics host detection does not report a local host.  `test/sqlite-storage-hygiene.test.ts` is not in the failure list.

## Next Steps & Blockers

- Jay reviews and squashes.  Do not automerge.  The job deletes production rows once it is on `main` and the image ships (weekday RTH still latches the image build).
- Optional before squash: set `SQLITE_STORAGE_HYGIENE_DRY_RUN=1` on the Coolify app for one 6-hour pass and read `storageHygiene` on `GET /api/ops/snapshot`.  The default without that env is live.
- The 16.5 GB file will not shrink until it is on INCREMENTAL, which this job will not force.  Freelist reuse is the production effect.  A later, explicit rewrite is a separate owner decision.
- Fleet board claim is blocked on missing `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` for this seat.

## Zero-Code Findings

`wal_checkpoint(PASSIVE)` returns `busy`, `log`, and `checkpointed`.  `busy` is 0 or 1, not a frame count.  After a complete PASSIVE copy the WAL file can stay large until TRUNCATE.  `PRAGMA auto_vacuum = INCREMENTAL` on a database that already has tables does not change the mode.  Setting it before `journal_mode=WAL` on an empty file sticks at 2.  `incremental_vacuum` on mode NONE returns no rows and does not shrink the file.
