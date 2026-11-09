# 2026-06-22 — Scheduler cadence rehydrate on boot

## Summary

Queued reliability fix: the scheduler fired a strategy run on the **first tick after
every restart/HMR/deploy**, regardless of the configured cadence, because its
in-memory `userSchedules[user].lastRunAt` starts `null` each process. Now it
rehydrates `lastRunAt` from the last real `strategy_runs` row on init, so the
cadence survives a restart.

## Changes

- **`src/lib/db-execution.ts`** — new `getLastStrategyRunStartedAt(userId)`:
  `SELECT MAX(started_at) FROM strategy_runs WHERE user_id = ?`, or `null`.
- **`src/lib/scheduler.ts`** — when initializing `userSchedules[userId]`, seed
  `lastRunAt` from `getLastStrategyRunStartedAt(userId)` instead of `null`. The
  existing `elapsed < cadenceMs` check then correctly skips an immediate run when
  the last run was recent.

## Tests

`test/scheduler-cadence.test.ts` — accessor returns `null` with no runs, the most
recent run's start time after inserts (MAX advances), and is scoped per user.

## Verification

Isolated worktree off `origin/main` (`f88c47c`), `npm ci`:
- `npx tsc --noEmit` — clean
- `npm test` — all pass (incl. 3 new)
- `npm run build` — green

## Note

Dropped from the queue: the `fill_events` `UNIQUE(proposal_id, source)` idempotency
index — a proposal legitimately produces multiple fills (partial fills / multi-lot),
so that key isn't unique (it broke 26 fill/performance/tax tests), and the
execution-section CAS claim already prevents the retry/double-approve double-book it
was meant to address.
