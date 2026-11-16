# 2026-09-01 - Litestream structural: stop L2 mega-compaction as a product

## Context & Objective

Owner 2026-09-01: fully resolve ST Litestream compaction.  Repeated L1 trim/heal has
not stuck.  Dominant class is L2 mega-compaction retry with no backoff: each attempt
re-downloads a huge L1 chain and uploads one mega L2; B2 Class B/C caps then 403;
retries continue; the detector was blind.

Issue #3153.  Boards 081c8ecf (parent) and 1e3df744 (old L2/L3 wedge).  Branch
`grok/litestream-structural`.  Worktree `~/apps/trading-grok-litestream-struct`.

Live `/api/health` at start of this lane (read-only): L0 age 0, L1 ~11m, L2/L3
~13m after the overnight snapshot, L9 ~4h, `litestreamCompactionLogFailureCount=0`.
L2 advancing tonight does not change the product: the next stall restarts the
retry storm.  Do not bounce Coolify.  Do not FORCE_RESTORE.  Do not touch live
B2 `trading-live/**`.

## Changes Made

Stop L2/L3 compaction as a product.  Rely on L0 + bounded L1 + 24h snapshots + the
existing L1 boundary-trim as a first-class scheduled unit.

Litestream 0.5.12 (pinned; do not upgrade -- tcp_mem 2026-07-10) has no disable-L2
flag and no compaction-backoff yaml key.  `cmd/litestream/main.go` `Config.Levels`
is L1..N in list order; `DefaultConfig()` otherwise starts monitors at 30s / 5m / 1h.
One `levels:` entry is how 0.5.12 turns L2/L3 off.  Retry cadence equals the level
interval; removing L2/L3 is the backoff.

Honest per-level detector: a later L1 `compaction complete` does not recover an L2
`compaction failed`.  Health still pages a stale snapshot when L0 age is 0.  Leftover
L2/L3 replica objects do not page (product-disabled).

Boot-time `litestream-runtime.log` rotation (#3135, 64 MB / keep 16 MB) is enough
once the mega-retry storm is gone.  Do not add `verify-compaction: true`.

Exact files:

- `litestream.coolify.yml` -- top-level `levels: [{interval: 30s}]` (L1 only).
- `src/lib/runtime-health.ts` -- product-disabled L2/L3, per-level log recovery,
  L0 interval lockstep 300s, `level` on log findings.
- `app/api/health/route.ts` -- pass `LITESTREAM_PRODUCT_DISABLED_TIERS`.
- `test/runtime-health.test.ts` -- honest detector + product-disabled + stale L9.
- `test/litestream-coolify-config.test.ts` -- yaml lockstep (one levels entry, no
  `verify-compaction: true`).
- `scripts/ops/litestream-l1-boundary-trim.timer` -- persistent 00:04 UTC.
- `scripts/ops/litestream-l1-boundary-trim.service`
- `scripts/ops/litestream-l1-boundary-trim-fleet.sh` -- socratic, congress,
  usage-monitor sequential.
- `scripts/ops/install-litestream-l1-trim.sh` -- host install, does not fire the
  oneshot, does not bounce Coolify.
- `docs/litestream.md` -- structural product + scheduled trim.
- `docs/rollouts/2026-09-01-litestream-structural.md` -- this note.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

**L2/L3 off, not lengthened.**  0.5.12 can omit them.  A longer L2 interval would
still mega-upload after a stall.  PITR to last snapshot + L0/L1 is enough.

**No yaml backoff key exists.**  Closest safe equivalent is "do not run the
level that mega-retries".  Remaining L1 retries every 30s against a small L0
window, which is cheap.

**L1 trim is now scheduled.**  Claude #3140/#3142 kept it as a transient oneshot
because trimming costs sub-daily PITR in the trimmed span.  That was right while
L2 still existed.  With L2 off, L1 is the only compaction level that can grow, so
the nightly trim is the bound.  Snapshot retention 168h stays the restore-depth
policy.  Do not fight the 2026-09-02 00:04 UTC transient units already on the host.

**Detector default in the assessor is still "all levels".**  Production health
passes `disabledTiers`.  Historical empty-L2 unit tests keep the 2026-08-14
algorithm via `disabledTiers: []`.

**Evening auto-deploy.**  `src/**` and `litestream.coolify.yml` (via `COPY . .`)
are runtime.  Next container start loads L1-only.  Safe: L0/L1/L9 keep working;
leftover L2 objects sit until retention.

**Log rotation stays boot-only.**  The 237 MB file was the retry storm.  Confirm,
do not add another rotator.

## Verification State

Commands (run via `scripts/land.sh` under Node 24):

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh
```

Focused checks before land: `npx vitest run test/runtime-health.test.ts test/litestream-coolify-config.test.ts`.

Live health at diagnosis (no secrets): L0/L1/L2/L3/L9 all `known`, not degraded,
`litestreamCompactionLogFailureCount=0`, weekly R2 key `cold-snapshots/app-2026-08-30.db`.

## Next Steps & Blockers

Remaining ops (not this PR):

1. Install the persistent timer on `fleet-hetzner-nbg1`:
   `sudo bash scripts/ops/install-litestream-l1-trim.sh`
   Do not fight tonight's 00:04 UTC transient oneshots.
2. Do not bounce Coolify from this lane.  Evening auto-deploy on merge restarts
   the container and picks up L1-only yaml.
3. After that boot: confirm litestream log has `starting compaction monitor`
   for level=1 only, no level=2/3 monitors, and `/api/health` L2/L3 are
   `product-disabled` or leftover-known with `degraded: false`.
4. Do not FORCE_RESTORE.  Do not touch live B2 `trading-live/**` without
   echoing endpoint `s3.eu-central-003.backblazeb2.com` and bucket
   `jays-socratic-trade-eu`.  Keep R2 `cold-snapshots/**`.
