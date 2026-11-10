# 2026-09-08 — R2 weekly cold snapshot: the archive stalled for 9 days, silently

## Context & Objective

`GET /api/health` reported the only red check on the whole endpoint:

```json
"storage": { "r2Weekly": { "ok": false, "ageSeconds": 797627,
             "key": "cold-snapshots/app-2026-08-30.db", "reason": "archive_stale" } }
```

Litestream continuous replication to Backblaze B2 was healthy throughout (tier 0 newest
activity ~1s, `litestreamStatus: replicating`, `litestreamDegradedReasons: []`), so live
durability was never at risk.  What had stopped was the **independent archive tier** — the
one that survives a fault replication faithfully reproduces: corruption, an accidental
delete, a bad restore.  It had not advanced since 2026-08-30 and nothing had said a word.

## Root Cause

**The snapshot step hung.  It never failed, so nothing ever reported it.**

`performR2ColdSnapshot` took its consistent copy with better-sqlite3's `backup()`, which
wraps SQLite's online-backup API.  `sqlite3_backup_step` **restarts the copy from page 1
whenever the source database is modified through a different connection**.  `app.db` is
written continuously by the live trading app and checkpointed by litestream, and it has
grown to ~10.7 GB — so the copy can never outrun the writers.

Production evidence (2026-09-08, container `d83b1aykr03uwr32yhgzaiay`):

| Evidence | Value |
|---|---|
| `due_jobs` row `week-2026-09-06` | `status=claimed`, `attempts=27`, `last_error=NULL` |
| `audit_events` `r2_cold_snapshot.start` | 55 lifetime, most recent 2026-09-08T07:34:00Z |
| `audit_events` `r2_cold_snapshot.success` | 5 lifetime, most recent **2026-08-30T03:30:17Z** |
| `audit_events` `r2_cold_snapshot.error` | **0 — ever** |
| `settings` `r2coldsnap:lastFailure` | absent |
| In-flight temp file size at 09:06:00Z / 09:09:46Z / 09:14:00Z | `5666406400` / `5666406400` / `5666406400` bytes |
| That file's mtime over the same window | advancing every few seconds |

A backup file that is byte-for-byte identical across eight minutes while being written
continuously is the restart loop, observed directly.  Every `.start` since
2026-09-06T03:17Z is spaced ~2h apart — the due-job lease — because each attempt was
terminated only by its lease expiring, whereupon the next scheduler drain re-claimed the
same job and started over.

Reproduced locally on better-sqlite3 **13.0.3** (the exact production version): with one
writer on a second connection, `backup()` logged **2698 restarts in 15 seconds** with
`remainingPages` pinned at 10601/10701 and never converged.  The same source, copied with
`VACUUM INTO` from a read-only connection under the same concurrent writer, completed in
117 ms with `PRAGMA integrity_check` = `ok`.

Because the run hung rather than threw, `failDueJob` was never called, `lastFailure` was
never written, the `r2_cold_snapshot_failed` storage advisory never fired, and
`checks.storage.r2Weekly` — which did flip red on schedule — was watched by nothing.

### Ruled out, with evidence

- **PR #3168 (skip-prune + inventory) is not the cause.**  It only adds the
  `R2_COLD_SNAPSHOT_SKIP_PRUNE` env gate and a read-only inventory script.  Both are inert
  unless a run reaches the retention pass, which no run since 2026-08-30 has reached.
- **PR #3135 (gzip) is not the cause.**  The hang is upstream of the upload: the last audit
  row of every attempt is `.start`, and the temp backup file is still being written hours
  in.  No `CreateMultipartUpload` is ever issued.
- **R2 capacity is not the cause.**  No upload is attempted, so R2 never rejects anything.
- **Credentials, the kill switch, and the Class A budget guard are not implicated.**  All
  three short-circuit to `status: "skipped"` with an audit row before the snapshot starts;
  we see `.start` instead.
- **Not new.**  The trend was already visible and was read as flakiness: attempts to first
  success were 1 (08-09), 5 (08-16), 21 (08-23), 1 (08-30).  The DB crossing ~10 GB made it
  permanent.

## Changes Made

- **`src/lib/r2-cold-snapshot.ts`**
  - The snapshot step is now `VACUUM INTO` run in a **child process**
    (`runVacuumIntoSnapshot`).  `VACUUM INTO` runs inside one read transaction, so
    concurrent writers cannot restart it, and it emits a compacted copy (smaller gzip,
    smaller upload, smaller R2 footprint).  It is synchronous and would block the event
    loop for minutes in-process — stalling `/api/health` and risking a Coolify healthcheck
    restart mid-snapshot — so it runs in a child spawned with a **minimal env that carries
    no application secrets**, against a **read-only** source connection.
  - Every attempt is bounded by `R2_COLD_SNAPSHOT_DEADLINE_MIN` (default 45 minutes,
    `withSnapshotDeadline` + a real `SIGKILL` of the child).  A stuck snapshot now fails
    loudly **inside its own lease** instead of hanging until the lease expires.  That also
    ends overlapping attempts piling up inside one process lifetime, where each attempt's
    start-of-run sweep unlinked the previous attempt's temp file while that attempt still
    held the fd (invisible multi-GB disk usage).
  - `logError` on a failed run, so a failure is visible in Sentry immediately rather than
    only once the 8-day staleness window trips.
  - **`reportR2WeeklyFreshness()`** watches the same `checks.storage.r2Weekly` state the
    public health endpoint publishes and emits **one** Sentry event per state transition
    (`ok` <-> `archive_stale` / `archive_not_run`), plus the `r2_cold_snapshot_stale`
    storage advisory on degrade.  State is persisted in `r2coldsnap:lastHealthState`, so a
    tick where nothing changed is a single settings read.
  - `snapshotMs` recorded on the success audit for future trend visibility.
- **`src/lib/scheduler.ts`** — calls `reportR2WeeklyFreshness()` in the existing
  `r2-cold-snapshot` lane on every tick, whether or not a job drained.
- **`.env.example`** — `R2_COLD_SNAPSHOT_DEADLINE_MIN`.
- **`test/r2-cold-snapshot.test.ts`** — 11 new tests: deadline config and env override,
  `withSnapshotDeadline` both ways, the production hang shape now producing
  `status: "error"` with an audited error, a persisted `lastFailure`, an advisory and a
  retryable job, a real child-process `VACUUM INTO` round trip, and the freshness watchdog
  firing exactly once per transition in both directions.

## Decisions & Trade-offs

- `VACUUM INTO` over "make `backup()` faster".  Larger page batches only shrink the restart
  window; any single write from another connection still restarts the whole copy.  The
  online-backup API is the wrong tool for a continuously written database.
- Child process over worker thread.  Native modules in `worker_threads` are a known
  hazard, and a child gives a genuine kill for the deadline — an in-process hang cannot be
  cancelled, which is precisely how this lane stayed stuck for nine days.
- The deadline also wraps the `backupImpl` test seam.  A seam that ignores cancellation at
  least stops blocking the run, so the attempt still fails inside its own lease.
- One event per state **transition**, not per tick.  The health check already computed the
  right answer every tick for nine days; the missing piece was an edge-triggered watcher.
- No `DeleteObject` against the bucket from this lane.  No backup data was removed.

## Verification State

```bash
npx tsc --noEmit                                    # clean
npx vitest run test/r2-cold-snapshot.test.ts        # 39 passed (11 new)
npx eslint src/lib/r2-cold-snapshot.ts src/lib/scheduler.ts test/r2-cold-snapshot.test.ts
```

Local reproduction of the root cause and of the fix was run against better-sqlite3 13.0.3,
the version production runs.  No Coolify mutate.  No R2 delete.  No production env change
from this seat.

## Bucket capacity — owner decision required

Live R2 usage for `socratic-trade-bucket` (SocraticTrade.com account
`94ec35cf8b40d3bf9710c0e3320b2e79`), read 2026-09-08 via the Cloudflare API, window ending
`2026-09-08T07:10:00Z`:

| Field | Value |
|---|---|
| `objectCount` | 1 |
| `payloadSize` | 9,679,310,848 bytes (9.68 GB / 9.01 GiB) |
| `uploadCount` | 0 (no orphaned multipart uploads accumulating) |
| Sole key | `cold-snapshots/app-2026-08-30.db` |

That is **~96.8% of the 10 GB R2 free tier**, and that single object is currently the
**only** cold archive that exists.  Capacity did not cause this incident — no upload has
been attempted since 2026-08-30, so the bucket cannot have changed — but it constrains how
the first successful run should land, and the two options pull against each other:

- **`R2_COLD_SNAPSHOT_SKIP_PRUNE` unset (current state, retain=1 prune).**  The run uploads
  the new compacted `.db.gz`, then immediately deletes the 9.68 GB legacy object, returning
  the bucket to one small object.  Peak usage during the upload window is
  9.68 GB + the new object, which **exceeds the free tier for a few hours**.
- **`R2_COLD_SNAPSHOT_SKIP_PRUNE=1` (what PR #3168 recommended).**  Both objects are kept,
  so the overage is **sustained** until someone deletes the legacy object by hand.  That
  guidance was written before the bucket was known to be at 96.8%.

**Recommendation, for the owner to approve:** leave skip-prune unset so the very first
successful run self-heals capacity, and accept the transient overage.  Whether R2 accepts a
write past the free tier at all depends on whether paid R2 is enabled on this account —
**that was not verified and should be checked before relying on this path.**  If it is not
enabled, set `R2_COLD_SNAPSHOT_SKIP_PRUNE=1`, take one fresh snapshot to a *different*
prefix or another provider, verify it, and only then delete
`cold-snapshots/app-2026-08-30.db`.

Nothing in this lane deletes anything.  No agent should `DeleteObject` against this bucket
without Jay's explicit approval — and deleting the legacy object *before* a fresh snapshot
is verified would leave the archive tier at zero coverage.

## Next Steps & Blockers

- After merge auto-deploys, the first scheduler tick fires one Sentry
  `r2 cold snapshot archive stale` event — that is the watchdog correctly reporting the
  state it inherits, not a new fault.  The pending `week-2026-09-06` job is re-claimed and
  should now either succeed or fail within 45 minutes.
- **Owner decision — `R2_COLD_SNAPSHOT_SKIP_PRUNE`.**  It is not currently set.  With it
  unset, the first successful `.db.gz` upload will `DeleteObject`
  `cold-snapshots/app-2026-08-30.db` (~9.02 GiB), which is today the only archive object
  that exists.  Set it to `1` in Infisical to keep the legacy object until a fresh `.db.gz`
  is verified; unset it afterwards so retain=1 resumes.  See the bucket-capacity note in
  the PR body.
- The 27-attempt loop has been re-running a multi-hour pointless copy against the live DB
  every 2 hours since 2026-09-06.  It is bounded to 45 minutes once this deploys; if the
  deploy is delayed, `R2_COLD_SNAPSHOT_ENABLED=0` is the kill switch, but that trades one
  silence for another and is the owner's call.
