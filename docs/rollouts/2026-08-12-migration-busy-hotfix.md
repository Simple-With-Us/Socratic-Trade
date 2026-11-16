# 2026-08-12 — Hotfix: boot migrations vs rolling deploys (SQLITE_BUSY crash-loop)

## Context & Objective

PR #2652's auto-deploy failed (deployment `pyqxv16i`, 11:03-11:17Z): the incoming container crash-looped with `SqliteError: database is locked (SQLITE_BUSY)` while loading the instrumentation hook, failed 10 healthchecks, and Coolify rolled back to the old container (prod stayed up throughout).  Root cause: `runMigrations` wrapped each migration in better-sqlite3's default DEFERRED transaction.  During a rolling deploy the outgoing container commits continuously (the litestream ltx stream shows multiple commits per second), and a deferred transaction that reads before writing dies with an INSTANT `SQLITE_BUSY` on the WAL snapshot upgrade — `busy_timeout` (already 60s) never applies to that path.  Migration 72 (the new `trade_proposals.symbol` column + backfill) was the first migration to ship since the pattern became load-bearing.

## Changes Made

- `src/lib/db.ts` `runMigrations()`: apply each migration via `apply.immediate()` (BEGIN IMMEDIATE) instead of `apply()` — the write lock is taken up front, so the 60s `busy_timeout` does its job while the old container's short writes drain.
- `test/db-migration-busy.test.ts` (new): a child-process lock holder takes BEGIN IMMEDIATE and holds it 1.2s; `runMigrations` on a second connection must wait it out and apply cleanly.

## Decisions & Trade-offs

- IMMEDIATE, not EXCLUSIVE: migrations only need the writer slot; readers in the old container may proceed.
- No change to deploy topology: rolling deploys over shared SQLite stay as-is — this makes the boot path wait instead of die.

## Verification State

- `npx tsc --noEmit` clean; `npx vitest run test/db-migration-busy.test.ts test/db-migration-old-schema.test.ts` 2/2; full suite + build via `scripts/land.sh` at push.
- Post-merge: this PR's own deploy must apply migration 72 under contention — its success is the live proof.

## Next Steps & Blockers

- After merge, verify the deploy finishes, `/api/health` stays green, and migration 72 applied (schema version).
