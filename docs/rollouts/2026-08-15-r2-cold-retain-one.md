# Rollout — Keep one weekly R2 cold snapshot

## Why

The weekly R2 cold snapshot defaulted to retaining 4 copies.  That assumed a
~1.5 GB database (4 × 1.5 GB ≈ 6 GB of the 10 GiB free tier).  Live
`/app/data/app.db` is **4.2 GB** (2026-08-15).  Four copies would be ~17 GB
and trip the 70% storage guard.  Two copies would be ~8.4 GB (84%).

B2 Litestream is the frequent replica.  R2 is second-vendor weekly DR.  One
verified current weekly is enough.

## Change

- `R2_COLD_SNAPSHOT_DEFAULT_RETAIN`: 4 → **1**
- Still overridable with `R2_COLD_SNAPSHOT_RETAIN` when the file is small
  enough
- Tests updated: drain path prunes every older `cold-snapshots/app-*.db`

Ops in the same unit already deleted leftover R2 `trading-live/` LTX (B2
uses that prefix now).  After today's `app-2026-08-15.db` upload is
verified, the Aug 9 object should be deleted so the bucket holds one weekly.
