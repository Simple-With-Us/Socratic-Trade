# 2026-09-04 — R2 weekly gzip freshen: skip-prune gate + read-only inventory

## Context & Objective

Gzip of the weekly R2 cold snapshot already landed on main via #3135
(`createGzip`, key `cold-snapshots/app-<ISO-date>.db.gz`, retain capped at 1,
`KEY_PATTERN` matches `.db` and `.db.gz`).  Live continuous Litestream replica is
Backblaze B2 `jays-socratic-trade-eu`, not R2.  R2 is weekly DR only.  A normal
Sunday run with retain=1 would upload a new `.db.gz` then prune/delete the 9 GiB
legacy `.db`.  Jay has not approved that delete.  This unit adds an opt-in
skip-prune freshen gate, a read-only inventory script, and docs that record the
verified prefixes so the next agent does not mislabel the live replica or prune
the wrong bucket.

## Changes Made

High level: `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` (also `true`/`on`/`yes`) lets a
weekly upload land a new gzipped snapshot without calling DeleteObject.  Default
remains current retain=1 prune for later Sunday jobs after Jay approves deleting
`cold-snapshots/app-2026-08-30.db`.  First gzip land must use skip-prune until
that approval.  Restore of `.db.gz` still needs gunzip first.  Agents must never
delete R2 objects without Jay's approval.

Read-only inventory 2026-09-04 (SocraticTrade.com account, bucket
`socratic-trade-bucket`):

| Prefix | Count | Notes |
|---|---|---|
| (bucket) | object_count=1, bucket_size ~9.68 GB | sole object below |
| `cold-snapshots/` | 1 | `cold-snapshots/app-2026-08-30.db` size=9679310848 (~9.02 GiB) |
| `trading-live/` | 0 | historic litestream prune moot |
| `weekly/` | 0 | leftover env `R2_ARCHIVE_KEEP_GENERATIONS` unused |

Touched files:

- `src/lib/r2-cold-snapshot.ts` — skip-prune env gate, audit `prune_skipped`,
  `wouldPrune` on the success receipt; header documents first gzip land + inventory.
- `src/lib/scheduler.ts` — comment: skip-prune until Jay approves the 9 GiB delete.
- `test/r2-cold-snapshot.test.ts` — skip-prune vs normal prune for `.db` and
  `.db.gz` candidates; retain cap stays 1.
- `test/r2-cold-snapshot-inventory.test.ts` — XML parse, prefix summary,
  AccessDenied, GET-only source contract.
- `scripts/ops/r2-cold-snapshot-inventory.mjs` — read-only ListObjectsV2 via
  `AWS_R2_HISTORIC_*`; prints keys+sizes+counts; exits 2 on AccessDenied; no
  delete path.
- `.env.example` — gzip key shape + `R2_COLD_SNAPSHOT_SKIP_PRUNE`.
- `docs/litestream.md` — B2 live replica vs R2 weekly DR; skip-prune; gunzip
  restore; 2026-09-04 prefix inventory.
- `docs/deployment.md` — un-mislabeled Litestream target (B2 live, R2 weekly only).
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout note.

## Decisions & Trade-offs

- Skip-prune is opt-in, not the new default.  After Jay approves deleting the
  legacy `.db`, Sunday jobs keep retain=1 prune so the free tier stays one object.
- Skip-prune still lists the prefix (Class A, cheap) so the audit records
  `wouldPrune` without deleting.
- Inventory script is GET-only and throws if asked to sign any other method.
  It never prints secrets, endpoints, or raw XML.
- Did not touch `litestream.coolify.yml` (inside Coolify `watch_paths`).  Did
  not run a live prune.  Did not call DeleteObject against the live bucket.
- `trading-live/` is empty on R2 as of this inventory, so the historic
  litestream prune is moot.  The B2 path of the same name remains LIVE — do not
  confuse endpoints.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/r2-cold-snapshot.test.ts test/r2-cold-snapshot-inventory.test.ts
npx eslint src/lib/r2-cold-snapshot.ts src/lib/scheduler.ts \
  test/r2-cold-snapshot.test.ts test/r2-cold-snapshot-inventory.test.ts \
  scripts/ops/r2-cold-snapshot-inventory.mjs
```

No R2 DeleteObject from this seat.  No Coolify mutate.  No extra-ship.  No
`--force-ship`.  No merge from this lane.

## Next Steps & Blockers

- Open PR to `main` (no merge).  Title/body: gzip already on main; this PR adds
  skip-prune freshen + inventory + docs; does NOT delete the 9 GiB object;
  `trading-live/` prune moot.
- First production gzip land: set `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` in Infisical
  until Jay explicitly approves deleting `cold-snapshots/app-2026-08-30.db`.
- After that approval, unset skip-prune so retain=1 prune resumes.
- Restore of a future `.db.gz` still needs `gunzip` first.

## Zero-Code Findings

Read-only inventory (verified 2026-09-04, not performed by this PR's script
against live if creds were absent from this seat — numbers come from the
owner-provided snapshot in the task brief): one object, 9.68 GB bucket, sole key
`cold-snapshots/app-2026-08-30.db` at 9679310848 bytes; `trading-live/` and
`weekly/` empty.  Gzip path already on main.  No agent deletes without Jay.
