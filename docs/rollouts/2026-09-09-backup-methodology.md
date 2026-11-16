# 2026-09-09 — Backup methodology: policy, archive depth, whole-attempt bounds, proven restore

## Context & Objective

The owner asked to "fix the backup methodology/procedures for ST".  PR #3192 (merged
2026-09-08T12:03Z) had just fixed the *mechanism* of the weekly cold archive — better-sqlite3
`backup()` replaced with `VACUUM INTO` in a child process.  This lane audited the whole backup
estate end to end, wrote the policy down, closed the highest-value gaps, and — the point of the
whole exercise — **actually restored a backup and checked it**.

Three things were expected going in.  All three turned out to be wrong in the owner's favour or
against it, and each is evidenced below rather than asserted:

- "A fresh cold snapshot should be landing now that #3192 is deployed."  **It is not.**
- "Backblaze is at ~535 GB and growing ~45 GB/day; propose a prune."  **No longer true.**
- "No evidence a restore has ever been tested."  **One was, on 2026-08-18.**  Also: a *fourth*
  backup tier exists that was not in the brief, it is broken, and it is broken by the exact root
  cause #3192 fixed one layer up.

## Verified current state — read live 2026-09-09

### Tier 1 — Litestream to Backblaze B2: HEALTHY

`/api/health` `checks.storage`: `litestreamStatus: replicating`, `litestreamDegradedReasons: []`,
tier 0 `ageSeconds: 1`, `litestreamTiersDegraded: false`.  Tiers 2/3 read stale (7 days) and are
*correctly* not degraded — `litestream.coolify.yml` deliberately configures a single compaction
level, which turns L2/L3 off.

`rclone size` against B2:

| Prefix | Objects | Size |
|---|---|---|
| `jays-socratic-trade-eu/trading-live/` | 5,910 | 56.343 GiB |
| `jays-socratic-trade-eu/hetzner/` | 8 | 34.236 GiB |
| **bucket total** | 5,918 | **90.579 GiB** |

**Correction to the fleet's shared understanding:** the PITR window is **7 days, not 30**.  The
`retention: 720h` figure lives in `litestream.yml`, a local-dev file pointing at
`/Users/jay/apps/trading-live/data/app.db` — a path that exists on no current machine.  The
production config is `litestream.coolify.yml`, `retention: 168h`.

### Tier 3 — weekly cold archive to Cloudflare R2: STILL NOT ADVANCING

`objectCount = 1`, `payloadSize = 9,679,310,848`, sole key `cold-snapshots/app-2026-08-30.db`
(Cloudflare R2 analytics API, window ending 2026-09-09T14:00Z; independently confirmed by a live
`ListObjectsV2` from inside the production container).  `r2Weekly.ok = false`,
`ageSeconds = 902823` (10.4 days), `reason: archive_stale`.

#3192 worked, and then exposed the next fault.  From `due_jobs` and `audit_events`:

| Evidence | Value |
|---|---|
| `week-2026-09-06` | `status = unresolvable`, `attempts = 31`, `last_error = "fetch failed"` |
| Last `r2_cold_snapshot.start` | 2026-09-08T15:36:14Z |
| First-ever `r2_cold_snapshot.error` | 2026-09-08T15:47:24Z — `"fetch failed"`, `durationMs 670094` |
| `r2_cold_snapshot.success` | 5 lifetime, newest still 2026-08-30T03:30:17Z |
| `r2coldsnap:lastFailure` | `cold-snapshots/app-2026-09-08.db.gz`, reason `fetch failed` |

So the snapshot step now completes — that is #3192 working — and the run then died in the
**upload**, which #3192 did not bound, with a bare `fetch failed` and no recoverable detail.  The
job then exhausted its attempt budget (30 of those 31 attempts were the old hang re-claiming an
expired lease, not real failures) and went terminally `unresolvable`.

Three distinct defects, all fixed here:

1. **`withSnapshotDeadline` wrapped only the snapshot step** (line 775 pre-change).  A hung
   upload had no bound short of the 2 h lease expiring — the same silent-restart shape #3192 set
   out to end.
2. **A single transient failure discarded the whole attempt**, including the ~11 minutes of
   `VACUUM INTO` that produced the artifact.  There was no retry on any S3 request.
3. **`err.message` was recorded.**  Node's `fetch` collapses every transport failure into the
   literal string `fetch failed` and hides the reason in `error.cause`, so production recorded
   nothing classifiable.

### Tier 2 — host-side 6-hourly SQLite dumps: BROKEN.  Not in this repo.

This tier was not in the brief.  It exists, it is real coverage, and it is down.

- `/data/backups/socratic/` holds exactly **one** dump,
  `socratic-app-20260906T121501Z.db` (10,607,546,368 bytes), finished 2026-09-07T11:59Z.
  Retention asks for two.  Nothing since.
- That dump took **~23.7 hours**.  It is `sqlite3 "$src" ".backup '$dest'"` against the live
  volume — **the same online-backup API whose page-1 restart loop #3192 diagnosed one layer up**.
- Every 6-hourly tick from 2026-09-07T18:15Z to 2026-09-09T12:15Z logged
  `SKIP already running (lock held)` because the previous run still held the `flock`.
- The hardened script installed 2026-09-08T03:24Z bounds the dump at `FLEET_BACKUP_TIMEOUT=30m`.
  A copy that takes ~24 h is now killed at 30 minutes, its output deleted, and the function
  `return 0`s — **failing silently, forever, on every tick**, with no alert path.
- `fleet-backup-verify-weekly.sh` already caught this once: on 2026-09-06 it reported
  `FAIL socratic integrity` / `Error: in prepare, file is not a database (26)`.  That went to
  `/var/log/fleet-backup/cron-weekly.log` and nowhere else.

The fix is one word — `.backup` to `VACUUM INTO` — but the script lives at
`/usr/local/sbin/fleet-sqlite-backup.sh` on the host, which is fleet-ops territory, and
production is read-only to this lane.  Filed for the owner in `docs/backup-policy.md` §8.1 with
the exact change.

### Backblaze growth: the ~535 GB board figure is stale

Re-measured rather than assumed.  All three `hetzner/` prefixes together are **41.280 GiB**
across 18 objects (socratic 34.236, congress 5.055, usage-monitor 1.989), unchanged when B2 file
versions are included.  The `B2_KEEP_SETS` prune added 2026-08-31 fixed it.  **No deletion is
proposed and none is needed.**

### Restore proof: one, on 2026-08-18, never repeated

`docs/rollouts/2026-08-17-litestream-restore-drill.md` records a real B2 restore to scratch:
4.9 GB, 107 s, `integrity_check` ok, row counts compared.  It was manual, it was three weeks ago,
and the database has since **more than doubled** to 10.98 GB.  `scripts/litestream-restore-drill.sh`
— the script that would repeat it — was unrunnable: it defaulted to a Mac path that exists on no
current machine and described the replica as R2, which it has not been since #2584.

## Changes Made

### Policy

- **`docs/backup-policy.md` (new, canonical).**  Four tiers with cadence, retention, RPO, RTO;
  why the two-provider split exists and must not be optimised away; an explicit **what is NOT
  covered** section; verification cadences; per-tier alerting; restore runbooks; the open owner
  decisions with numbers.

### Cold archive (`src/lib/r2-cold-snapshot.ts`)

- **Archive depth 1 → 4.**  Depth one means a single object *is* the entire archive tier.  The 1
  was a free-tier cap; paid R2 is enabled.  Also removed the clamp that made
  `R2_COLD_SNAPSHOT_RETAIN` **write-only in the up direction** (`min(env, DEFAULT)`), replacing it
  with a real `MAX_RETAIN = 12` ceiling.  A useful side effect: at retain 4 the legacy 9.68 GB
  `app-2026-08-30.db` is simply **kept**, so no deletion approval is needed and the
  `SKIP_PRUNE` workaround becomes moot.
- **Pre-upload artifact verification.**  The snapshot child now runs `PRAGMA integrity_check` on
  the copy it just made and counts rows in `audit_events`, `trade_proposals`,
  `portfolio_snapshots`, `connected_accounts`, `settings`, `llm_usage` — in both the live source
  and the copy — and the run **refuses to upload** unless integrity is `ok` and every table that
  is populated live is populated in the copy.  A structurally perfect *empty* database passes
  `integrity_check` and is worthless as a backup, which is why the second assertion exists.
  Exact row equality is deliberately not required: the live DB is written continuously.
  "Reached the upload unverified" is not a reachable state — a snapshot impl that reports nothing
  falls back to a real verification child.
- **Whole-attempt deadline** (`R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN`, default 90 min, under the
  2 h lease), threaded as an `AbortSignal` into every S3 request so an over-deadline upload is
  genuinely **aborted** rather than left running against a job whose lease has moved on.
- **Bounded per-request retries** (3 by default, retryable statuses and transport errors only,
  short-circuited once the attempt deadline fires).  Part bodies are already buffered, so a retry
  re-sends the same bytes and part numbering never shifts.
- **`describeRequestError`** unwraps the `cause` chain, so the next `fetch failed` arrives as
  `fetch failed <- read ECONNRESET (ECONNRESET)` in the audit row, Sentry, and `lastFailure`.

### Restore verification

- **`scripts/ops/verify-cold-snapshot-restore.mjs` (new).**  Downloads the newest
  `cold-snapshots/` object, gunzips it in-stream, opens it with the same SQLite driver production
  uses, `integrity_check`s it, asserts the key tables are populated, writes a JSON receipt, and
  discards the scratch copy.  Exit 3 means *not provably restorable*.  Read-only against R2 with
  no DELETE path of any kind.
- **`scripts/litestream-restore-drill.sh` repointed** at the production paths and the B2 replica,
  with a free-space precheck, an explicit bucket/endpoint echo against the documented
  same-object-path footgun, the same six key tables, and a real non-zero exit on failure (it
  previously printed a warning and exited 0).

## Decisions & Trade-offs

- **Retain 4, not 8 or 52.**  Four gzipped weeklies is about a month of archive history at ~12 GB
  of paid R2.  Cheap enough not to need a conversation, deep enough that no single fault empties
  the tier.  The ceiling is 12 so a fat-fingered env cannot pin hundreds of multi-GB objects.
- **Verification in the snapshot child, not a separate pass.**  The child already has the file
  open and the source connection live; verifying there costs one extra `integrity_check` and six
  `COUNT(*)`s, and it happens while the artifact is still local and cheap to throw away.
- **The round-trip restore drill is a script, not a durable in-app job.**  Downloading ~10 GB and
  integrity-checking it inside the trading container on a schedule is real CPU, IO, and disk
  pressure on a live-money box.  A documented monthly script with a receipt is the right ratio
  until someone wants to pay for it continuously.
- **`R2_COLD_SNAPSHOT_SKIP_PRUNE` kept, not removed.**  It is inert at retain 4 and is still the
  right escape hatch if retention is ever lowered again.
- **No deletion of anything, anywhere.**  No R2 object, no B2 object, no host backup.  The one
  file this lane's tooling removes is the scratch copy the restore drill itself creates.
- **Production stayed read-only.**  No restart, no deploy, no env change, no host script edit.
  The tier-2 breakage is documented and handed to the owner rather than fixed in place.

## Verification State

```
npx tsc --noEmit                              # clean
npx vitest run test/r2-cold-snapshot.test.ts  # 64 passed (24 new)
npx eslint src/lib/r2-cold-snapshot.ts test/r2-cold-snapshot.test.ts   # clean
```

New tests cover: retention raising as well as lowering and the `MAX_RETAIN` ceiling; the
verification verdict in all four shapes (pass, missing report, bad integrity, structurally sound
but empty table); fail-closed on unreadable live COUNT(*) (null); skip only empty live
(0); unparseable child output; the real
child-process `VACUUM INTO` reporting integrity plus live-and-copy row counts; the standalone
verifier rejecting a non-database; `describeRequestError` unwrapping a cause chain; and, on the
drain path, that a failed verification uploads **zero bytes**, that a transient part failure is
retried to success, that retries are bounded, and that a hung **upload** now fails with
`attempt_deadline_exceeded` inside its own lease.

### Restore actually proven

A real round trip was run against production R2 on 2026-09-09 using the new script.
**PASS.**

```json
{
  "ok": true,
  "key": "cold-snapshots/app-2026-08-30.db",
  "objectBytes": 9679310848,
  "restoredBytes": 9679310848,
  "integrity": "ok",
  "tables": {
    "audit_events": 262290,
    "trade_proposals": 803,
    "portfolio_snapshots": 1755,
    "connected_accounts": 7,
    "settings": 664,
    "llm_usage": 2491
  },
  "failures": [],
  "archiveDepth": 1,
  "startedAt": "2026-09-09T15:14:28.746Z",
  "completedAt": "2026-09-09T15:24:44.095Z",
  "durationMs": 615349
}
```

Download 127 s, whole drill 615 s.  Every count trails the live database
(`audit_events` 360,059, `trade_proposals` 831, `portfolio_snapshots` 1,877,
`connected_accounts` 7, `settings` 937, `llm_usage` 2,989) exactly as a 2026-08-30 snapshot
should.  The scratch copy was removed.

**So the cold archive tier is stale, not broken:** the object that has been sitting there for
ten days is a genuinely restorable database.  That is a materially different risk position from
the one the health field alone implied.

The drill also earned its keep immediately by finding a bug in the brand-new script: opening the
restored file read-only still leaves `-shm` and `-wal` sidecars behind, which the cleanup missed.
A stray sidecar next to a future scratch file is a corruption hazard, not litter.  Fixed in the
same lane.

## Review round 1 — five findings, all real, all fixed

`sentry` and `chatgpt-codex-connector` between them found five defects in the first push.
None was a false positive; three were in code this lane had just written, which is a useful
reminder that "bound the thing" is easy to write and easy to get subtly wrong.

1. **Orphaned multipart upload race** (`sentry`, MEDIUM).  If the attempt deadline fired while
   `CreateMultipartUpload` was in flight, `uploadId` was still `undefined` when the catch ran,
   so the abort was skipped — while the create could still land server-side.  The failure path
   now holds the create promise and waits for it to settle before aborting.  That wait is
   **bounded** (10 s): the reason we are in the catch may be that the create never settles,
   and an unbounded wait there would reproduce, inside the cleanup, exactly the hang it was
   escaping.  The first version of this fix did hang — the new upload-deadline test caught it.
2. **Child deadline did not draw down the attempt budget** (`sentry`, LOW).  The verification
   child was handed a fresh 45 minutes regardless of how much of the 90-minute attempt was
   left, so it could outlive the parent that had already reported failure.  Both children now
   get `min(snapshotDeadline, remaining attempt budget)`.
3. **Attempt deadline was not enforced below the job lease** (`codex`, P2).  An env of 120 min
   or more was accepted even though the drain claims a 120-minute lease — the precise overlap
   the deadline exists to prevent.  Now clamped to lease − 15 min, and the snapshot-step
   deadline is additionally clamped to the attempt deadline.  A comment saying a value "must
   stay under" a limit is not an enforcement mechanism.
4. **The documented container invocation of the Litestream drill was not runnable**
   (`codex`, P2).  Correct: the runtime image ships no `sqlite3` CLI, and Litestream is on
   PID 1's `PATH` only.  Verified on the host and corrected in both the script header and
   `docs/backup-policy.md` §9 — that drill runs on the **host**; the R2 drill, which uses the
   bundled `better-sqlite3`, is the one that runs in the container.
5. **A negative row delta failed the drill** (`codex`, P2).  The sharpest of the five: it
   contradicted this lane's own stated policy.  Rows are legitimately deleted between the
   replica point and the live read (`deleteInternalSetting()` prunes `settings`), so a correct
   restore can hold *more* rows than live.  The delta is now informational in both directions;
   pass/fail is non-emptiness plus integrity, exactly as the policy says.

## Follow-ups (owner)

1. **Tier 2 host backups.**  `/usr/local/sbin/fleet-sqlite-backup.sh`: `.backup` → `VACUUM INTO`,
   and make a timed-out dump alert instead of `return 0`.  Applies to Congress.Trade and
   Usage-Monitor too — their databases are still small enough to succeed, for now.
2. **Weekly verify output.**  `fleet-backup-verify-weekly.sh` writes `FAIL` into a log file
   nobody reads.  Route it to Slack or Pushover.
3. **Litestream PITR window.**  Production keeps 7 days.  If 30 is wanted, change
   `litestream.coolify.yml` and budget the B2 storage.
4. **Nothing to delete.**  Explicitly: no B2 prune is warranted (41.3 GiB total, not 535 GB), and
   the legacy R2 object is now retained by policy rather than needing a deletion decision.
