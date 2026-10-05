# RTH sqlite stall bounds (2026-10-05 profiles)

## Context & Objective

Production `event_loop_stall` profiles captured on the Coolify ST container during RTH on 2026-10-05 name two first-party synchronous paths that pin the Node serving loop.  The goal is one small change that stops those paths from scanning the whole table or walking the whole archive on the request or tick that is already running.  Extra-ship no.  No Coolify Deploy.  Do not duplicate in-flight PR #4164 (lexical FTS off the loop).

## Changes Made

Source maps from a webpack production build of the same SHA the profiles were taken against (`9c7dca0a`) map the repeated ~58-66% frames to scheduler `tickInner` (`src/lib/scheduler.ts`) and `pruneTaskJournal` (`src/lib/db-task-journal.ts`).  The 82s profile's first-party frames are `app/api/ops/snapshot/route.ts`, `RegExp ^(\d{4})Q([1-4])\.json$` (`TRANSCRIPT_FILE_RE` in `src/lib/roic-archive-artifacts.ts`), `getEquityOrders`, and better-sqlite3 `prepare`.  `summarizeRoicArchiveCoverage` calls both the transcript coverage query and the sync directory walk.

`pruneTaskJournal` now deletes with `INDEXED BY idx_task_journal_started`: skipped rows older than 24h first, then non-skipped rows older than 30d, sharing `TASK_JOURNAL_PRUNE_BATCH_LIMIT` (500).  The old OR predicate planned as MULTI-INDEX OR and, without the index, as a full scan.  No new index.  `CREATE INDEX` on a large `task_journal` inside `migrate()` would stall boot.

`summarizeEarningsCallsTranscriptCoverage` counts `content IS NOT NULL`.  `length(content)` made SQLite read every transcript blob.  Empty bodies are already stored as NULL.  Non-null bodies shorter than 200 characters now count.  Negative-cache NULL rows still do not.

`buildOpsSnapshot` passes `artifactFiles: peekRoicArtifactFileCount() ?? 0` and starts `refreshRoicArtifactFileCount()`.  That walk yields once per symbol directory (`yieldEventLoop` / `setImmediate`) and caches for 10 minutes.  Direct callers of `summarizeRoicArchiveCoverage` still sync-walk when they omit the option.  `GET /api/ops/snapshot` awaits `yieldEventLoop()` between `buildOpsSnapshot` and `attachOpsOrderSummaries` so an already-resolved order import cannot extend the snapshot turn.

- `src/lib/db-task-journal.ts`
- `src/lib/db-earningscalls.ts`
- `src/lib/roic-archive-artifacts.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/ops/snapshot/route.ts`
- `test/event-loop-stall-hot-path.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/rollouts/2026-10-05-rth-sqlite-stall-bounds.md`

## Decisions & Trade-offs

- One PR covers both mapped hot paths.  They are the same class (a serving-thread full read) and the 82s snapshot is the longest stall.  The diff is query and walk bounds, not a worker-thread framework.
- A filing-CPU worker draft (`parseFilingHtml` / `chunkDocument` off loop) was dropped.  `runTaskStage` is about 8% of profile 3, not the 58-66% function.  Child total time cannot exceed the parent frame.
- #4164 owns `searchCorpusWideLexicalCandidates`.  Those frames were not the mapped leaders.
- `listProviderUsageOutboxRows` and `usage-monitor-replay.ts` (chunk 8358, about 8-22%) stay.  They are the next profile if stalls remain after this lands.
- `rankDemandFirstSymbols` still reads `data/rag-universe-manifest.json` synchronously when the snapshot does not pass a universe.  That was not the regex frame or the 58% function.
- Local benches did not reproduce a 45s prune.  `INDEXED BY` makes a planner SCAN of `task_journal` impossible for this statement.  If the index is missing the existing catch returns 0 and retention stops for that call, which is the same swallow-errors behavior as before.  The index is created in the same migration as the table (v62).
- No schema migration and no boot backfill of a stored `content_len`.  Either would scan blobs at migrate time.
- Ops snapshot `artifactFiles` is 0 until the first yielding walk finishes, then the cached count for 10 minutes.  Diagnostic GETs no longer `readdirSync` the tree.
- Live effort board `/Users/jay/apps/TRADING-EFFORT-LOG.md` does not exist on this cloud VM.  `docs/EFFORT-LOG.md` is the tracked mirror.  Phase docs are unchanged.  This is not a phase-design change.

## Verification State

Commands actually run on this branch, in order:

```bash
npm run lint          # exit 0 (errors only; grandfathered warnings remain)
npx tsc --noEmit      # exit 0
npm test              # vitest run, exit 1 — see below
npm run build         # exit 0 (Next.js webpack production build)
```

`npm test` on this cloud seat: 9 failed, 9048 passed, 51 skipped (808 files, 925s).  A second run of the stall files plus the two reproducible failures: `test/event-loop-stall-hot-path.test.ts`, `test/task-journal.test.ts`, `test/ops-snapshot.test.ts`, `test/roic-archive-resume.test.ts`, and `test/sqlite-event-loop-stall.test.ts` passed.  The 9 failures are outside the diff:

- `test/cpuprofile-summary.test.ts` (2): `node scripts/ops/summarize-cpuprofile.mjs` imports `src/lib/cpuprofile-summary.ts`.  This VM is Node v22.14.0.  The script comment requires Node 24 type stripping.  `ERR_UNKNOWN_FILE_EXTENSION`.
- `test/notify-body-tiers.test.ts`, `test/notify-user-creds.test.ts` (2), `test/persistence-notification.test.ts`: this seat exports `PUSHOVER_*` and `RESEND_API_KEY`, so tests that expect empty credentials see a configured channel.
- `test/server-metrics.test.ts`: `COOLIFY_SERVER_STATS` is set, so the unconfigured-local assertion `usesLocalHost === true` is false.
- `test/alpha-vantage-key-pool.test.ts` and `test/congress-share.test.ts`: reproduced in isolation (fetch count 3 vs 2, and 3 vs 2).  Timing/pacer and breaker-cooldown tests.  Neither file is in this diff.

Targeted proof in `test/event-loop-stall-hot-path.test.ts`: scale a fixture until the old scan or `length(content)` query takes at least 100ms, then assert the fixed function finishes in under 100ms and is at least 4x faster.  The snapshot case warms `getDb()` and one snapshot (migrations), resets the artifact cache, times a second snapshot under 100ms with `artifactFiles === 0`, and asserts the yielding refresh emits timer ticks and returns the directory count.

## Next Steps & Blockers

- Open a ready PR against `main`.  Do not merge.  Do not Coolify Deploy.  Extra-ship no.  No Slack.
- No Kodus threads exist on this branch yet.  If review opens threads, fix them or reply `defer` with a rationale.  Do not resolve a thread only to merge.
- If production still stalls inside `pruneTaskJournal` after this image is live, re-map the new profile.  Do not assume the old OR scan came back.
- Do not call production `GET /api/ops/snapshot` during RTH to "check" this.  That GET is the 82s path.

## Zero-Code Findings

Chunk map (webpack build of `9c7dca0a`, 1-based line/col from the profile summary):

- `ha@chunks/5313.js:51:1922` -> `tickInner` in `src/lib/scheduler.ts`.
- `r@chunks/6744.js:611:505` -> `pruneTaskJournal` (minified body contains `DELETE FROM task_journal`).
- `F@chunks/6744.js:3134` -> `listProviderUsageOutboxRows` in `src/lib/db-provider-dispatch.ts`.
- Chunk 8358 -> `src/lib/usage-monitor-replay.ts` only.
- Chunk 9818 -> `src/lib/rag/sec-ingest-worker.ts` only.  `runTaskStage` is the ~8% frame, not the 66% frame.
- `RegExp ^(\d{4})Q([1-4])\.json$` is `TRANSCRIPT_FILE_RE`, used only by the ROIC artifact file count, which `summarizeRoicArchiveCoverage` calls from `buildOpsSnapshot`.
