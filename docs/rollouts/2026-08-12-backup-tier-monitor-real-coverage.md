# 2026-08-12 — Litestream per-tier backup monitor: real coverage (previous version had none)

## 1. Context & Objective

`assessLitestreamTierFreshness()` shipped on 2026-08-11 (`docs/rollouts/2026-08-11-litestream-tier-backup-status.md`)
to close the gap where `/api/health`'s `checks.storage.litestream*` fields only ever reflect
level 0, so a wedged higher-level compaction is invisible. It was widened to levels 0/1/2/3/9
on 2026-08-12.

**It never worked.** In production every one of the five tiers reported `state: "unknown"` on
every health check — zero coverage, presented in the API and the admin panel as a five-tier
breakdown. The incident it was built for (a level-2 compaction wedge) was running the entire
time and the monitor did not see it. This note records the two causes, the evidence, and the
replacement design.

## 2. Changes Made

### The defect, with evidence from the live container (2026-08-12)

**Cause 1 — four of the five levels do not exist locally.** The check scanned
`<statePath>/ltx/<level>/`. On the production container:

```
$ ls -la /app/data/.app.db-litestream/ltx/
drwxr-xr-x 2 root root 81920 Aug 12 23:25 0        <- the only entry
```

Litestream 0.5.12 compacts levels 1, 2, 3 and 9 straight into the remote replica and keeps
nothing on local disk. Levels 1/2/3/9 could therefore **never** be observed by this method.
The premise of the check was wrong for 80% of what it claimed to cover.

**Cause 2 — the one observable level was blinded by a scan bound.** `ltx/0` held **1,078
files**. The shared helper `newestFileMtimeMs()` returned `null` once a scan exceeded
`LITESTREAM_FILE_SCAN_MAX_ENTRIES = 256`, and `assessLitestreamTierFreshness` mapped `null` to
`"unknown"`. So level 0 — the one level with a real local signal — also reported "unknown", on
every request, permanently. The same bound silently blinded the `fileFallback()` diagnostic
path for the same reason.

**What was actually happening while the monitor reported nothing** (container log, live):

```
level=ERROR msg="compaction failed" system=store db=app.db level=2
  error="write ltx file: extract timestamp from LTX header: non-contiguous transaction ids
  in input files: (000000000000e5d6,000000000000e5e1) -> (000000000000e5dd,000000000000e5e1)"
```

Recurring roughly every 30 minutes. Remote inventory at 2026-08-12T23:30Z:

| level | newest LTX | newest txid | verdict |
|-------|-----------|-------------|---------|
| 0 | 2026-08-12T23:30Z | `0000000000037d0b` | healthy, advancing |
| 1 | 2026-08-10T14:54Z | `000000000002324c` | **stalled ~2 days** |
| 2 | 2026-08-08T14:35Z | `000000000000e5ad` | **wedged ~4 days** |
| 3 | 2026-08-08T15:00Z | `000000000000e5ad` | **stalled ~4 days** |
| 9 | 2026-08-12T00:01Z | `0000000000030586` | healthy (24h snapshot) |

### What per-level data is genuinely obtainable (all three candidates probed, not assumed)

- **(a) The IPC control socket — NO.** Litestream 0.5.12 serves exactly two routes on
  `/app/data/litestream.sock`: `/list` → `{"databases":[{"path","status","last_sync_at"}]}` and
  `/info` → `{"version","pid","uptime_seconds","started_at","database_count"}`. Every other path
  probed (`/status`, `/metrics`, `/levels`, `/db`, `/databases`, `/health`, `/debug/vars`, `/`)
  returned `404 page not found`. **No per-level or error data exists on the socket.**
- **(b) The pinned binary — YES.** `litestream ltx -level N -json -config <cfg> <db>` lists the
  remote inventory per level (`level`, `min_txid`, `max_txid`, `size`, `timestamp`). It works
  from the app process because the app is a **child** of the litestream daemon
  (`litestream replicate -exec "next start"`), so it inherits the `AWS_*` replica credentials —
  verified by reading env var *names* from `/proc/<next-pid>/environ`. **This is the only source
  of higher-level truth.** Cost measured: level 1 = 8.3s / 5,635 files / 887 KB; level 2 = 0.9s;
  level 3 = 0.7s; level 9 = 0.7s; `-level all` = **143s / 90,500 files / 14.1 MB**.
- **(c) Litestream's `compaction failed` log lines — NO (and not safely).** They go to the
  container's stdout pipe, owned by the Docker log collector. The only in-container handle is
  `/proc/<litestream-pid>/fd/2`; reading it **drains the same pipe and steals lines from
  `docker logs`** (confirmed empirically — a read returned a live app log line). That is a
  destructive read racing dockerd, so it is rejected. There is no log file on disk.

### The replacement design

Two sources, each used where it is actually valid, with an explicit third state for the rest:

- **Level 0** → local `ltx/0/` directory, real time, free, no bound problem (below).
- **Levels 1/2/3/9** → a scheduled **remote replica inventory**, refreshed every 30 minutes by
  the scheduler and read (never collected) by `/api/health` and the admin route.
- **Anything else** → `state: "not-observable"` with a machine-readable `reason` and a
  human-readable `detail`. Never a bare `"unknown"`.

**Level-0 blindness fix — no new magic number.** LTX files are named
`<minTXID>-<maxTXID>.ltx` with zero-padded hex ids, so lexicographic filename order *is* write
order (verified on the live replica: the lexicographically greatest name in `ltx/0` also carried
the newest mtime). `newestMtimeAmong()` selects the highest-named entries in a single O(n) pass
and stats only those, so cost is **one `readdir` + at most 8 `stat` calls regardless of
directory size**. Directories at or below the sample size are stat-ed exhaustively (exact).
Sampling several rather than exactly one tolerates a small name/time inversion. The recursive
`fileFallback()` scan was fixed the same way: it is still bounded (depth + directory count) but
a large directory is now *sampled* instead of collapsing the whole result to `null`.

**False-positive guard.** A higher level is degraded only when it is past its threshold **and**
its newest txid is behind level 0's. On a fully idle database level 0 stops too and every higher
level would otherwise age out and false-alarm; a level that has caught up with level 0 has
nothing left to compact. Level 0 itself is graded on age alone — it is the pacemaker.

**Dead-collector guard.** If the inventory snapshot is older than
`LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS` (90 min = 3x the refresh cadence), its levels
revert to `not-observable / remote-inventory-stale` rather than being graded on frozen numbers
whose age grows on its own. Without this, a dead refresher would manufacture a fake wedge.

### Files touched

- `src/lib/runtime-health.ts` — scan helpers rewritten (`newestMtimeAmong`,
  `readLocalLtxDirectory`, `newestFileMtimeMs`); new `maxTxidFromLtxFilename`,
  `compareLitestreamTxid`; `assessLitestreamTierFreshness` rewritten around the two sources plus
  `not-observable`; new `LitestreamTierSource`, `LitestreamTierUnobservableReason`,
  `LitestreamRemoteInventorySnapshot`, `LitestreamRemoteInventoryState`, report counters.
  Removed `LITESTREAM_FILE_SCAN_MAX_ENTRIES`.
- `src/lib/litestream-remote-inventory.ts` — **new.** Scheduled collector, pure payload
  summarizer, config resolution/gating, in-process snapshot cache.
- `src/lib/scheduler.ts` — new `litestream-remote-inventory` lane.
- `app/api/health/route.ts` — passes the cached snapshot in; new additive
  `checks.storage.litestreamTierCoverage`; tier alert text names the source; new
  `litestream_tier_coverage_blind` advisory (live mode only).
- `app/api/admin/backup-status/route.ts` — passes the snapshot in; new `coverage` block.
- `app/admin/backups/backup-status-client.tsx` — three-way tier rendering, per-tier source
  badge, newest-txid row, Monitoring Coverage card, `PARTIAL COVERAGE` header chip, corrected
  explanatory copy, `SENTENCE_GAP` applied to prose.
- `test/runtime-health.test.ts`, `test/litestream-remote-inventory.test.ts` (new),
  `test/backup-status-route.test.ts`, `test/connection-health-routing.test.ts`.

## 3. Decisions & Trade-offs

- **`checks.storage.litestreamTiers[].state` changed `"unknown"` → `"not-observable"`.** This is
  the one non-additive change and it is deliberate: "unknown" was the exact word that made zero
  coverage look like coverage. Everything else is additive (`source`, `newestTxid`, `reason`,
  `detail`, `litestreamTierCoverage`). The only in-repo consumers are the admin panel and the
  tests, all updated.
- **Losing sight of a tier does NOT flip `storageDegraded`.** Blind monitoring is not a backup
  failure, and conflating them would make the flag fire in every non-production environment. It
  raises a separate `litestream_tier_coverage_blind` advisory, live mode only, and the admin
  header reads `PARTIAL COVERAGE` rather than `HEALTHY`.
- **Level 0 is not collected remotely.** It dominates `-level all` (143s of the 143s) and is
  already free locally.
- **Shelling out vs. an S3 client.** The pinned binary is the authoritative reader of
  Litestream's own format and already carries the config; a hand-rolled `ListObjectsV2` would
  pay the same pagination cost while re-implementing key parsing. Arguments are fixed literals,
  `execFile` uses no shell, and credentials are inherited via `process.env` rather than passed.
- **In-process cache, not the database.** `next start` serves the scheduler and the routes from
  one process, so reader and writer coincide; a restart honestly reports "not collected yet"
  instead of resurrecting numbers from a previous replica state.
- **`eval("require")` for `child_process` and bare `fs`/`path` specifiers.** Required: the module
  is reachable from `scheduler.ts`, which Next's webpack build traverses and which rejects
  `node:` URIs. Follows the existing precedent in `src/lib/data-providers.ts`. Caught by
  `npm run build`, not by tsc.
- **Not fixed here:** the underlying wedged level-2 B2 compaction is still live ops work. This
  change makes it visible; it does not clear it.

## 4. Verification State

Run in `/Users/jay/apps/trading-monet-tierfix` with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`:

```
npx tsc --noEmit          -> clean, no output
npm run lint              -> 751 problems (0 errors, 751 warnings)   [grandfathered backlog]
npm test                  -> Test Files 550 passed | 1 skipped (551)
                             Tests 6383 passed | 51 skipped (6434)
npm run build             -> success (first attempt failed on the node: scheme issue above)
```

Touched files specifically: `Test Files 4 passed (4)`, `Tests 71 passed (71)`.

The wedge-detection proof is
`test/runtime-health.test.ts` → *"flags the wedged level-2 compaction from the real 2026-08-12
production replica state"*: it feeds the literal production numbers from the table above and
asserts level 2 `degraded: true` while level 0 and level 9 stay healthy. The companion test
*"does not flag a quiet higher level that has already caught up with level 0"* proves the idle
database does not false-alarm, and *"measures level 0 from a directory holding far more files
than the old 256-entry bound"* pins the 1,200-file regression.

## 5. Next Steps & Blockers

1. **Clear the wedged level-2 compaction in production** — still open, unchanged by this PR.
   The `non-contiguous transaction ids` error repeats indefinitely; levels 1, 2 and 3 have not
   advanced since 2026-08-08/10 and the restore floor currently rests on level 9 snapshots plus
   level 0.
2. After deploy, confirm `checks.storage.litestreamTierCoverage.observed` reaches `5` (it will
   read `1` until the first scheduled inventory lands, up to 30 minutes in).
3. Once the wedge is cleared, expect levels 1/2/3 to flip to `degraded: false` on their own; if
   they do not, the monitor is now the right place to look.

## 6. Zero-Code Findings

- Litestream 0.5.12's IPC socket exposes only `/list` and `/info`; there is no per-level or
  error surface to build on, now or after this change.
- The app process inherits replica credentials because it is a child of the litestream daemon.
  If the boot chain in `scripts/coolify-prod-start.sh` ever stops using `replicate -exec`, this
  collector loses its credentials and will report `skipped` with that reason rather than
  silently degrade.
- `/app/litestream.coolify.yml` is world-readable and `/app/data/.bin/litestream` is
  world-executable in the production image; the app runs as uid 0 there. Both preconditions
  verified.
