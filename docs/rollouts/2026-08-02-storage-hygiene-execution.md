# Storage hygiene execution: drain + slim + VACUUM + kill-switch recovery (2026-08-02)

## Context & objective

Owner-approved follow-through on the storage investigation
(`docs/rollouts/2026-08-02-audit-write-hygiene.md`): drain the prune
backlog, reclaim the strategy_run payload bloat, VACUUM the file, and verify
the backup stream actually shrinks.

## What was executed (prod, sequenced)

1. **Backlog drain**: audit_events 493k → 364k rows (observability kinds
   >14d; default >90d had none — DB is only 7 weeks old). Remaining rows are
   all inside retention windows. Provider tables: ~75k rows pruned. Required
   creating `created_at` indexes first (unindexed batches ran minutes each);
   shipped as migration v65 (PR #2363).
2. **Payload slimming (data-preserving)**: 647 old strategy_run audit rows
   had their embedded full `marketScan` rewritten to the bounded summary —
   **458 MB reclaimed without deleting a single row**.
3. **VACUUM**: stop app → `VACUUM INTO` → integrity check → swap → start.
   DB file **1.5 GB → 832 MB (-45%)**; audit_events/strategy_runs counts
   verified identical; app healthy in minutes; pre-vacuum copy kept at
   `/data/backups/app-pre-vacuum-20260802.db`.
4. **Kill-switch recovery**: the R2 auto-disable (70% threshold, deployed by
   another agent this morning) fired at 13:55 UTC mid-work — old 1.5 GB/day
   snapshots had already crossed 7 GiB. After the shrink, emptied the bucket
   (4,439 objects via SigV4 DeleteObjects batches; old oversized generation
   redundant vs the verified live DB + local pre-vacuum backup), removed the
   marker, restarted. Replication resumed on a fresh generation: first
   snapshot **356 MB** (was ~1.5 GB), compaction healthy, zero errors since.
   Two stale-litestream-state incidents (VACUUM swap) fixed by resetting
   `/data/socratic-trade/.app.db-litestream`.

## Verification state

- Row counts preserved across VACUUM (audit_events 364,228; strategy_runs
  1,715); `integrity_check` + `quick_check` ok; site 200 throughout after
  restarts; litestream compaction completing normally post-resume.
- Steady-state forecast: ~0.8 GB/day snapshots + reduced WAL at 48h
  retention ≈ well under the 7 GiB alert line. The R2 monitor's 6h checks
  + daily digest will show the curve over the next days.

## Security incident (disclosed same-day)

`INFISICAL_ST_CLIENT_SECRET` (the socratic-trade Infisical machine-identity
client secret) was accidentally printed into the Kimi chat transcript twice
via a broken `export $(... | grep ^AWS_)` pattern that fell back to bare
`export` (dumps all env). Exposure scope: this private conversation only.
**Recommendation: rotate the ST machine-identity client secret.** Offered to
the owner with the full touch-list (Infisical identity, local secrets file,
Coolify env store) — awaiting their go-ahead.

## Next steps & blockers

- Nothing blocking. Follow-ups: verify the daily digest shows the smaller
  curve; CT/UM backup streams continue (untouched by this work); the Sunday
  weekly covers the retention-window diff going forward.
