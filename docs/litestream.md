# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams the
WAL as LTX files to an S3-compatible object store.

**Production (Coolify, 2026-08-07+):** active replica is **Backblaze B2** EU Central
(`jays-socratic-trade-eu`, endpoint `s3.eu-central-003.backblazeb2.com`) via
`litestream.coolify.yml` + Infisical `AWS_*`. B2 restore to a host scratch path is
**VERIFIED** (2026-08-18 UTC).  Cloudflare R2 (`socratic-trade-bucket`) is weekly
cold-snapshot DR only (`cold-snapshots/app-YYYY-MM-DD.db.gz` since PR #3135), not a
second Litestream writer.  Read-only inventory 2026-09-04: object_count=1,
bucket_size ~9.68 GB; sole key `cold-snapshots/app-2026-08-30.db` (9679310848
bytes, ~9.02 GiB); `trading-live/` empty in that snapshot (bucket may still hold pre-cutover LTX — re-inventory before
assuming); dead `trading-live/**` prune plan: `docs/runbooks/r2-trading-live-dead-history-prune.md`.
`weekly/` empty (leftover `R2_ARCHIVE_KEEP_GENERATIONS` unused).  Details:
`docs/rollouts/2026-08-07-litestream-b2-backup.md`,
`docs/rollouts/2026-08-17-litestream-restore-drill.md`, and
`docs/rollouts/2026-09-04-r2-weekly-gzip-freshen.md`.

**All three fleet apps (ST, CT, UM) run litestream IN-CONTAINER** since the August
2026 Hetzner rebuild.  The 2026-08-01 host-level `litestream-congress` systemd unit
was an interim measure and no longer exists — any doc describing Congress.Trade
litestream on the host is historical.

## B2 lifecycle caps restore depth

All fleet B2 buckets carry lifecycle rules **hide after 14 days + delete hidden
after 1 day**.  B2 applies these to litestream's LTX objects like any other file,
so point-in-time restore depth from B2 is hard-capped at **~15 days** regardless
of what litestream's own retention settings claim.  Do not plan a restore deeper
than that from B2.  The weekly R2 cold snapshot is SECOND-PROVIDER disaster
recovery, not deeper history: retain=1 means it is a single point at most ~7
days old.  No provider holds a recovery point older than ~15 days.

## Weekly R2 cold snapshot is gzipped (2026-08-31)

**2026-09-08 — the snapshot step is `VACUUM INTO`, never `backup()`.**  SQLite's
online-backup API restarts the copy from page 1 whenever the source is modified through a
different connection.  `app.db` is written continuously and has passed 10.7 GB, so
`backup()` can never converge: the weekly job started 27 times between 2026-09-06 and
2026-09-08 without ever reaching success OR failure, and the archive silently went 9 days
stale.  The snapshot now runs `VACUUM INTO` in a child process (one read transaction, so
concurrent writers cannot restart it; compacted output; read-only source; minimal env with
no secrets), bounded by `R2_COLD_SNAPSHOT_DEADLINE_MIN` (default 45 min, under the 2h job
lease) so a stuck attempt fails loudly instead of hanging.  `reportR2WeeklyFreshness()`
watches `checks.storage.r2Weekly` and emits one Sentry event per state transition — before
it, nothing watched that field.  Detail: `docs/rollouts/2026-09-08-r2-cold-snapshot-hang.md`.

The weekly cold snapshot (`src/lib/r2-cold-snapshot.ts`, Sunday ~03:17 UTC due-job)
uploads `cold-snapshots/app-YYYY-MM-DD.db.gz` — a `VACUUM INTO` copy of the live DB
gzip-streamed during the multipart upload (the raw DB reached ~9.7 GB, ~90% of the
R2 free tier; compressed is expected at ~2.5-4 GB).  Gzip landed on main in PR
#3135.  Retention is retain=1 across BOTH extensions (`.db` and `.db.gz`).

**First gzip land must NOT prune.**  A normal retain=1 success would upload the new
`.db.gz` then DeleteObject `cold-snapshots/app-2026-08-30.db` (~9.02 GiB).  Jay has
not approved that delete.  Set `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` so the freshen
uploads without pruning.  Default remains retain=1 prune for later Sunday jobs
after that approval.  Agents must never DeleteObject against this bucket without
Jay's approval.  Read-only inventory: `node scripts/ops/r2-cold-snapshot-inventory.mjs`
(AWS_R2_HISTORIC_* when present; prints keys+sizes+counts only; exits 2 on
AccessDenied; no delete path).

**Restore from a `.db.gz` cold snapshot needs a gunzip step first:**

```bash
# Download (rclone/aws cli against the historic R2 bucket), then:
gunzip app-2026-08-31.db.gz          # yields app-2026-08-31.db
sqlite3 app-2026-08-31.db 'PRAGMA integrity_check;'   # expect: ok
```

After gunzip the file is a plain SQLite DB — treat it exactly like the old raw
`.db` snapshot.  A still-present legacy `app-YYYY-MM-DD.db` needs no gunzip.

## L1 suffix heal precedent (2026-08-31)

A stuck ST L2 compaction (litestream 0.5.12 trying to upload ONE giant L2 file
covering a multi-day L1 backlog, failing repeatedly) had been tripping the B2
Class B download cap daily since 8/29.  Healed 2026-08-31 with the L1 suffix heal
in its keep-above-snapshot-boundary variant: `scripts/litestream-l1-suffix-heal.py`
keeps the newest contiguous L1 suffix, deletes older L1 plus all L2/L3 so Compact
rebuilds small files, and never touches L0, L9, `cold-snapshots/`, or any other
bucket (dry-run by default; `--apply` to delete).  Use that script — not ad-hoc
deletes — if the pattern recurs.

Local Mac notes below (`litestream.yml` + `scripts/run-litestream.sh`) are optional
dev/sidecar history; production does **not** use Mac PM2 litestream.

> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**
> (the old multi-replica config errors with "multiple replicas on a single database
> are no longer supported"). It also replaced the `snapshots`/`generations` model with
> **LTX files** — inspect them with `litestream ltx`, not `litestream snapshots`.

## Setup (retired Mac / PM2 path — not production)

Production Litestream runs in the Coolify container via `litestream.coolify.yml`.
The Mac `~/apps/trading-live` steps below are rollback/dev history.  Do not start
Mac `pm2` `litestream` while Coolify runs `DB_BOOTSTRAP=live`.

### 1. Install

```bash
brew install benbjohnson/litestream/litestream
litestream version   # expect 0.5.x
```

### 2. Create an R2 bucket + token

dash.cloudflare.com → R2 → create a bucket (e.g. `trading-live-backups`) →
**Manage R2 API Tokens** → create a token with **Object Read & Write** scoped to that
bucket. You get an **Access Key ID**, a **Secret Access Key**, and an **endpoint URL**
(`https://<account-id>.r2.cloudflarestorage.com`).

### 3. Add credentials to `~/apps/trading-live/.env.local`

```bash
AWS_S3_BUCKET_NAME=trading-live-backups
AWS_REGION=auto
AWS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

(Names follow the fleet-wide `AWS_*` convention shared with Congress.Trade —
renamed from the older `LITESTREAM_S3_*` set on 2026-07-30.)

### 4. Deploy the config + launcher and start under PM2

```bash
cp litestream.yml ~/apps/trading-live/litestream.yml
cp scripts/run-litestream.sh ~/apps/trading-live/run-litestream.sh

pm2 start ~/apps/trading-live/run-litestream.sh --name litestream --interpreter bash
pm2 save
```

The launcher sources the creds itself (via `eval`, so it survives PM2 restarts and
`pm2 resurrect` on reboot — unlike relying on a shell that happened to have the vars
exported at `pm2 start` time).

### 5. Verify

```bash
# Config parses + replica is wired:
litestream databases -config ~/apps/trading-live/litestream.yml

# LTX files actually landed in R2 (need creds exported, or run via the launcher's env):
litestream ltx -config ~/apps/trading-live/litestream.yml ~/apps/trading-live/data/app.db

# PM2 process is stable (restart count should stay at 0):
pm2 show litestream
```

Healthy output log shows `replicating to type=s3 bucket=...`, periodic
`ltx file uploaded`, then `replica sync` ticking each second.

## Disaster recovery

`scripts/litestream-restore.sh` reads creds from `.env.local` if they are not already
exported, then restores the latest backup:

```bash
bash scripts/litestream-restore.sh /tmp/app.db.restored

# Verify, then swap in:
sqlite3 /tmp/app.db.restored 'SELECT count(*) FROM audit_events;'
pm2 stop trading
cp /tmp/app.db.restored ~/apps/trading-live/data/app.db
pm2 restart trading
```

Point-in-time restore (0.5.x): add `-timestamp 2026-06-21T18:00:00Z` or
`-txid <hex>` to the `litestream restore` call.

## Restore verification status (2026-08-18 UTC)

**B2 restore to scratch is VERIFIED.**  ASC ran `litestream restore` on
`fleet-hetzner-nbg1` to two scratch paths (both off the live volume):
`/data/scratch/socratic-restore-20260818/app.db` (started 2026-08-18T01:12:26Z,
file complete ~01:14Z, 4.9G) and
`/data/backups/restore-proof/socratic-restore-scratch-20260817/app.db`
(litestream 0.5.16, 107s, exit 0, 4.9G).  `PRAGMA integrity_check` was `ok`.
Newest LTX at the second restore: level 0 txid `0000000000080781` @
2026-08-18T01:14:43Z.  A later live compare (8:19pm CT) is seconds / ~31 rows
ahead of the scratch, as expected.  Site stayed up.  No bounce.  No
`FORCE_RESTORE`.  No Mac pm2.

Also **VERIFIED**: decrypt of one stored credential on the scratch (`fred`
last-4 `6dd4`; do not write plaintext or `ENCRYPTION_KEY`); R2 weekly retain=1
(exactly one `cold-snapshots/app-2026-08-16.db`).  `R2_ARCHIVE_KEEP_GENERATIONS=2`
is unused on ST.

Full receipts: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.

The 2026-07-01 G9a gap (replicate proven, restore never run) is closed for the B2
path.  Repeat after a Litestream / `litestream.coolify.yml` version bump.

### Runbook: perform and record a restore drill

Run this periodically (recommend: quarterly, and after any Litestream / `litestream.coolify.yml`
version bump).  Production is Coolify on `fleet-hetzner-nbg1`, not Mac pm2.  The 2026-08-18
drill used host scratch + `litestream restore -config …/litestream.coolify.yml` (creds from
the running socratic litestream process env, shredded after).  The Mac-oriented script
below is still valid for a local replica.  Do not `cp` over live `/app/data/app.db` as part
of a drill.  Do not bounce.  Do not set `FORCE_RESTORE`.

```bash
# 1. Restore the latest replica to a scratch path (does NOT touch the live app.db).
bash scripts/litestream-restore.sh /tmp/app.db.restored

# 2. Sanity-check row counts against a table that changes frequently, and compare
#    against the live DB's count (expect the restored count to be close, modulo
#    whatever wrote since the last LTX sync).
sqlite3 /tmp/app.db.restored 'SELECT count(*) FROM audit_events;'
sqlite3 ~/apps/trading-live/data/app.db 'SELECT count(*) FROM audit_events;'

# 3. Confirm the restored file is a valid, non-corrupt SQLite DB.
sqlite3 /tmp/app.db.restored 'PRAGMA integrity_check;'   # expect: ok

# 4. Clean up the scratch file (do NOT cp it over the live app.db as part of a drill).
rm /tmp/app.db.restored
```

Record the outcome (date, LTX generation/txid if noted, row-count delta, integrity
result) in a `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md` note so future
agents/operators can see when restore was last actually proven to work, not just
assumed from replication health.

## Compaction health - the L2 mega-upload wedge

### The failure mode

Litestream 0.5's level-2 compaction walks forward from the last L2 `maxTXID` and folds
**the whole remaining L1 chain into one output object**.  That is fine when it runs every
few minutes.  It becomes a trap the moment L2 stalls for any reason - a B2 endpoint flake,
a killed multipart, an exhausted download cap - because L0/L1 keep advancing while L2 does
not.  Each retry therefore has to download *more* L1 than the last one and upload a *bigger*
single object than the last one, so the loop diverges instead of converging.  It has never
self-healed: the fleet has hand-healed it four times (ST 2026-08-13, ST 2026-08-22,
UM 2026-08-27, ST 2026-08-31/09-01).

The retry storm also burns the **shared** Backblaze Class B download allowance, which is
fleet-wide - so a wedged ST L2 starves CT's and UM's compaction too.  That makes the cap
error a *symptom* that appears late, well after the real failure.  Do not stop at it.

Signature log lines, in the order they usually appear.  The upload failures come first:

```
level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="write ltx file: s3: upload to trading-live/app.db/0002/<min>-<max>.ltx: \
  read upload data failed: read page header 312: unexpected EOF"

level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="write ltx file: s3: upload to trading-live/app.db/0002/<min>-<max>.ltx: \
  read upload data failed: read page header 402: read lz4 trailer: expected lz4 end frame"
```

Then, once the retries have eaten the day's Class B allowance, the same 5-minute tick
starts failing earlier - on the *read* side - and the message changes shape:

```
level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="open ltx file: s3: get object trading-live/app.db/0001/<min>-<max>.ltx: \
  ... AccessDenied: Cannot download file, download bandwidth or transaction \
  (Class B) cap exceeded."
```

Two tells that this is the mega-upload wedge and not a credentials or endpoint problem:
`level=2` on every failure while `level=0` `ltx file uploaded` lines keep flowing normally
in between, and a `0002/` object name whose `<min>` TXID never advances across retries.

### Structural product (2026-09-01): L2/L3 are off

Repeated L1 trim/heal did not stick.  The product is now **L0 + bounded L1 + 24h snapshots**.
PITR to the last snapshot plus remaining L0/L1 is enough.  Mega L2 is the failure mode, so
it is no longer a compaction target.

Litestream 0.5.12 (pinned; do not upgrade) has no disable-L2 flag.  `litestream.coolify.yml`
sets a single top-level `levels:` entry (`interval: 30s` = L1).  `Config.Levels` is L1..N
in list order (`cmd/litestream/main.go` `CompactionLevels()`).  One entry makes
`MaxLevel() == 1` and `NextLevel(1)` the snapshot level.  DefaultConfig would otherwise
start L2 at 5m and L3 at 1h.

There is also **no compaction-backoff yaml key**.  `store.go` `monitorCompactionLevel`
retries on the level interval with no exponential delay.  Removing L2/L3 is the backoff:
the storm was re-downloading the whole L1 chain every 5 minutes.  Remaining L1 retries
every 30s against a small L0 window.

Health (`src/lib/runtime-health.ts`):
- Log scan recovery is **per level**.  A later L1 `compaction complete` does not clear an
  L2 `compaction failed`.  The previous nullish fallback to any-level complete kept
  `litestreamCompactionLogFailureCount` at 0 through the incident.
- L2/L3 are listed but **product-disabled**: leftover replica objects and empty listings
  do not page.  Stale L9 still pages even when L0 age is 0.
- `litestream-runtime.log` still rotates at boot above 64 MB (keep newest 16 MB, one `.1`).
  With L2 mega-retry gone, that cap is enough; do not grow another 200 MB file.

Do **not** add `verify-compaction: true` (ListObjects after every compact; tcp_mem 2026-07-10).

### The heal: `scripts/litestream-l1-boundary-trim.py`

Installed on `fleet-hetzner-nbg1` as `/usr/local/sbin/litestream-l1-boundary-trim`; the
repo copy is the source of truth for review and re-installation, and the two are kept
byte-identical (verify with `sha256sum` on both sides).  It lists the newest L9 snapshot,
reads its `maxTXID` as a boundary, and deletes every L1 object whose `maxTXID` is at or
below that boundary.  This is safe by construction: a full snapshot already contains those
transactions, so a restore is snapshot + the remaining L1/L0 chain.

**It is a fleet tool, not a Socratic-only one.**  `--app` selects the replica; the bucket
and prefix come from a table in the script rather than module constants:

| `--app` | bucket | prefix |
|---|---|---|
| `socratic` (default) | `jays-socratic-trade-eu` | `trading-live/app.db` |
| `congress` | `jays-congress-trade-eu` | `congress-trade/db.sqlite` |
| `usage-monitor` | `jays-usage-monitor-eu` | `api-usage-monitor/prod.db` |

```bash
# Dry run (default) - prints the plan and changes nothing.
ssh root@100.69.77.26 /usr/local/sbin/litestream-l1-boundary-trim --app socratic

# Apply, and require a snapshot no older than 6h (what the scheduled units pass).
ssh root@100.69.77.26 /usr/local/sbin/litestream-l1-boundary-trim \
  --app congress --max-snapshot-age-hours 6 --apply
```

**Run it right after the nightly snapshot lands (~00:00Z).**  The snapshot is what advances
the boundary, so trimming immediately afterwards leaves the next L2 compaction with only
minutes of L1 to fold in - a small upload that succeeds.  Running it long after the snapshot
still works but heals less, because the L1 accumulated since the snapshot is exactly what
L2 still has to carry.

### Guards

Every guard aborts rather than proceeding, and each one has its own exit code so a scheduled
unit's failure is diagnosable from `systemctl status` alone.

- **No usable snapshot.**  No L9 object parses as `<min>-<max>.ltx` (exit 2).
- **Absolute size floor.**  The newest snapshot is under 100 MB - a truncated or
  in-progress snapshot must never define the boundary (exit 3).
- **Relative size floor.**  The newest snapshot is under 50% of the *previous* snapshot's
  size (exit 3).  The absolute floor alone cannot catch this: the real ST snapshot is
  ~4.5 GB, so a badly truncated one still clears 100 MB, and the boundary is read from the
  object's *filename*, which stays authoritative-looking regardless of content.  Comparing
  consecutive snapshots is what actually detects truncation.
- **Freshness.**  The snapshot is older than `--max-snapshot-age-hours` (default 48; the
  scheduled units pass 6) (exit 3).  Without a tight bound a late or failed nightly snapshot
  lets the run trim to *yesterday's* boundary, exit 0, and lapse - leaving roughly a full day
  of L1 for the same oversized L2 upload this procedure exists to avoid.  A tight bound turns
  that silent near-no-op into a loud failure.
- **Restore hole.**  The first kept L1 object starts above `boundary + 1`, so deleting would
  strand transactions between the snapshot and the kept chain (exit 4).
- **Kept-chain contiguity.**  The run walks the *entire* retained set for internal txid gaps,
  not just the first kept object, and aborts when any exist (exit 5).  Twins (same `maxTXID`,
  different `minTXID`) are allowed and not counted as gaps.  This matters because L2
  compaction stays wedged on non-contiguous input no matter how much L1 is trimmed - see
  `docs/rollouts/2026-08-22-litestream-l2l3-unwedge.md`, where Litestream refused L1 with
  `non-contiguous transaction ids in input files` and four holes across 560 objects.  The
  trim never *creates* such a hole, but without this guard it reported success while L2 stayed
  wedged and kept burning the shared allowance.
- **Boundary did not advance.**  Nothing is superseded while L1 still holds more than 200
  objects (exit 6).  A large L1 with a zero-length delete list means the snapshot boundary
  never moved past the backlog, which is a failure to report, not a no-op to shrug at.

Unparseable object names are warned about and skipped, never deleted.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Deleted successfully, or a legitimate no-op (small L1, nothing superseded), or a dry run |
| 1 | Doomed objects **survived** the trim - measured by re-listing the bucket afterwards, not inferred from rclone's return codes.  Also covers an `rclone lsl` listing that raised, since that propagates uncaught and Python exits 1 on the traceback; the tell is that a listing failure produces no `APPLIED` line at all |
| 2 | No usable L9 snapshot |
| 3 | The snapshot failed a safety guard (too small, shrank, or too old) |
| 4 | Trimming would leave a restore hole |
| 5 | The kept chain has internal gaps - L2 will stay wedged, a human must reconcile |
| 6 | Nothing superseded although L1 is large - the boundary did not advance |

**Exit 0 means "the run completed without hitting a guard" - not "objects were deleted", and
certainly not "compaction recovered".**  A dry run exits 0, and so does a legitimate no-op
with nothing superseded.  An operator reading only `systemctl status` can therefore see
success while the entire L1 backlog is still sitting there.  To establish that deletion
actually happened, require an `APPLIED ... deleted=N survived=M` line with a non-zero `N` -
those figures are read back off the bucket, so they can be trusted.  To establish that the
*wedge* is fixed, look for `msg="compaction complete" ... level=2` and for the L2 object's
`<min>` TXID advancing.

### Deletes are HIDES, not hard deletes - and that is deliberate

B2 is versioned, so `rclone delete` writes a **hide marker** and leaves the prior version in
place.  `--b2-hard-delete` removes the version outright.  The obvious conclusion is that the
tool should always hard-delete.  It must not, from this host, and the reason cost a whole run
to learn.

**The host's scoped `fleet-backup-writer` key can hide a version but cannot delete one.**  It
returns `Unknown 401 (401 unauthorized)` on `b2_delete_file_version`.  With
`--b2-hard-delete` set, rclone still reports progress while removing **nothing** - measured
2026-09-01, roughly 800 "deletes" against Congress.Trade left the object count unchanged (it
rose, from new L1 arrivals).  Verified on a single object both ways: hard delete returns 401
and the file survives; a plain delete via `--files-from` removes it from listings.

A hide is sufficient for the job this tool exists to do.  Litestream stops seeing the object
immediately, so compaction unwedges at once, and the bucket's own lifecycle rule
(`daysFromHidingToDeleting=1`) frees the bytes about a day later.

What you give up is **same-hour space reclamation**, and that is where the billing lesson
still bites: hidden versions stay billed until the reaper collects them.  That overhang was
measured across the fleet - **199.59 GB** billed against a **126.49 GB** logical footprint,
~73 GB of hidden-but-billed versions.  So the distinction absolutely matters; the host simply
cannot avoid it.  Hard deletes need the **B2 master key**, so if you need the space back the
same hour, run the trim from an operator workstation with that key instead.

The `NOT --b2-hard-delete` comment in the script records this.  **Keep it** - the flag looks
like an obvious improvement to anyone who has not seen the 401.

### The delete phase: batched, and verified against the bucket

Deletes are issued in chunks of `DELETE_CHUNK = 500` names written to a temp file and passed
as one `rclone delete --files-from <file> --transfers 16 --checkers 16` per chunk.

This replaced a per-object `rclone delete --include "/<name>"` loop, which was **O(n^2)**:
resolving an `--include` filter re-lists the entire prefix, so an N-object trim performed N
full listings.  Measured against Congress.Trade's ~2,400-object L1 at **~12 s per delete** -
roughly 8 hours for 2,362 objects.  Batching lists the prefix once per chunk instead of once
per object.

**The run no longer trusts rclone's exit codes.**  After applying, it re-lists L1 and reports
what actually survived:

```
APPLIED app=congress deleted=N survived=M batch_errors=E
```

`deleted` and `survived` are computed from the bucket, not from return codes, and any
survivors are named in a following line.  This exists because the 401 above produced a run
that reported clean progress the whole way through while deleting nothing - exit codes were
lying, and the only honest source was the bucket itself.  A non-empty `survived` returns
exit 1.

### Known defects in the current build - read before arming anything

These are confirmed by reproduction, not suspected.  All need a **paired repo + host** change
(the repo copy is kept byte-identical to the installed tool), so none is fixed in the build
documented here.

0. **The truncation guard is a heuristic, not an integrity check.**  It compares byte sizes -
   a 100 MB floor, and 50% of the previous snapshot.  A snapshot truncated to 3 GB from 4.5 GB
   clears both, and the boundary is then read from that incomplete object's *filename*, so the
   trim would hide L1 history the snapshot does not actually contain.  Nothing opens or
   checksums the LTX file.  Real completion evidence (`litestream ltx` inspection, or a
   checksum / finalisation marker) is the fix; a tighter percentage is not.  Severity is
   bounded but not removed: deletes are hides, so within the
   `daysFromHidingToDeleting=1` window the versions still exist and are recoverable, and the
   restore-hole guard (exit 4) still refuses to strand the kept chain.  After the reaper runs,
   neither helps - treat ~24h as the remediation deadline.

1. **The tool has no lock, and concurrent runs can still collide.**  Nothing prevents two
   invocations for the same app from overlapping.  Each snapshots its own delete list up
   front, so a second run started while the first is still deleting re-lists and re-issues
   deletes for the same keys, wasting Class A/C calls.  Batching cut run times by orders of
   magnitude and so made a collision far less likely than it was at ~12 s per object, but
   16-20 minute retry spacing is not a guarantee for a level with thousands of objects.  Add
   single-flight locking, or space retries beyond the maximum expected runtime.
2. **A zero-byte previous snapshot crashes the run.**  The relative-size guard short-circuits
   on `prev_size > 0`, but the log line immediately after it computes `size / prev_size`
   unconditionally, so a 0-byte predecessor raises an uncaught `ZeroDivisionError` and exits
   with a traceback instead of a documented code.  Fail-safe (it happens before any delete),
   but undiagnosable from the exit status.
3. **Legal twin shapes can be misreported as gaps.**  The contiguity walk sorts by
   `(min, max)` and only recognises a twin when the *adjacent* pair shares a `max`.  For the
   retained set `(1,99), (1,200), (100,200)` the sort yields that order, so `(1,99)` is
   compared against `(1,200)`, the twin test fails, and a gap `63->1` is reported even though
   `(100,200)` supplies the exact continuation.  The result is a spurious exit 5 that blocks
   a trim which should have proceeded.  Fail-safe (it refuses rather than deleting), but it
   will stall a real recovery until a human overrides it.  Collapse same-max twins before
   testing adjacency.

### The deliberate trade-off

Trimming L1 below a snapshot **reduces sub-daily point-in-time granularity for the trimmed
span** to whatever L0 still covers.  You can still restore to the snapshot, and to any point
after the trim boundary; you lose the ability to land between two arbitrary mid-day
transactions inside the span the snapshot already subsumes.

**As of 2026-09-01 this is a first-class scheduled unit**, not a forgotten one-shot.  L2/L3
are off, so L1 is the only compaction level that can grow; the nightly trim is what keeps
it bounded.  Snapshot retention (168h) stays the restore-depth policy.  The trim only
hides L1 already contained in the newest L9 snapshot.

Repo source of truth (install on `fleet-hetzner-nbg1`, do not bounce Coolify):

```
scripts/ops/litestream-l1-boundary-trim.timer      # OnCalendar 00:04 UTC
scripts/ops/litestream-l1-boundary-trim.service
scripts/ops/litestream-l1-boundary-trim-fleet.sh   # socratic, then congress, then usage-monitor
scripts/ops/install-litestream-l1-trim.sh          # root, idempotent, does not fire the oneshot
```

Transient 00:04 / 00:20 / 00:40 UTC oneshots already armed for 2026-09-02 must not be
fought.  The persistent timer is the same 00:04 UTC minute so the next deploy does not
depend on a unit that dies on reboot.  Install is remaining host ops; this repo change
does not SSH-enable it.

### `boundary-trim` vs `suffix-heal` - which one

| | `litestream-l1-boundary-trim.py` | `litestream-l1-suffix-heal.py` |
|---|---|---|
| Keeps | everything above the newest snapshot's `maxTXID` | the newest `--keep-l1` contiguous L1 objects |
| Deletes | superseded L1 only | older L1 **plus all L2 and L3** |
| Restore hole | refuses to create one | **possible** if `--keep-l1` is chosen carelessly |
| Credentials | host `rclone` `[b2]` remote | `B2_KEY_ID` / `B2_APPLICATION_KEY` in env |

Prefer **boundary-trim** by default: it is keyed to something real (a snapshot that provably
contains the transactions being dropped) and it refuses to leave a gap.  Reach for
**suffix-heal** when the L2/L3 objects themselves are the problem - a poisoned or half-written
L2 that Compact keeps trying to extend - since boundary-trim never touches L2/L3.  When you
do use suffix-heal, read its dry-run hole/twin counts before applying and keep the default
`--keep-l1` unless you have a reason.

## Local snapshot (optional)

0.5.x cannot also mirror to a local file replica (single-replica limit). If you want a
no-credentials local copy, schedule a periodic SQLite backup independently, e.g. a
`launchd` job running:

```bash
sqlite3 ~/apps/trading-live/data/app.db ".backup ~/apps/backups/trading-live/app.db"
```

## Monitoring

```bash
litestream ltx -config ~/apps/trading-live/litestream.yml ~/apps/trading-live/data/app.db | tail
pm2 logs litestream --lines 30
```
