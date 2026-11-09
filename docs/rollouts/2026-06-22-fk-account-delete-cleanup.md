# 2026-06-22 — FK enforcement + account-delete cascade cleanup

## Summary

Queued durability fix: deleting a connected account left its `fill_events`,
`portfolio_snapshots`, `trade_proposals`, and `synthetic_trailing_stops` behind —
orphaned rows that still feed P&L / exposure for an account that no longer exists.

## Changes

- **`src/lib/db.ts`** — `getDb()` now sets `PRAGMA foreign_keys = ON` (SQLite leaves
  it off by default). Inert today (no FK constraints are declared) but the correct
  default so any future FK actually enforces.
- **`src/lib/db-api-keys.ts`** — `deleteConnectedAccount` looks up the account's
  `account_number`, then in **one transaction** deletes the account row and purges
  its records from `fill_events`, `portfolio_snapshots`, `trade_proposals`, and
  `synthetic_trailing_stops` (all keyed by `account_number` + `user_id`). Account
  delete is an explicit user action, so its broker-scoped trade/P&L history goes
  with it — no orphans.

## Tests

`test/account-delete-cleanup.test.ts` — `foreign_keys` is on; deleting an account
purges its fills/snapshots/proposals/stops; a non-existent id returns `false` and
touches nothing.

## Verification

Isolated worktree off `origin/main` (`5aa724b`), `npm ci`:
- `npx tsc --noEmit` — clean
- `npm test` — all pass (incl. 3 new)
- `npm run build` — green

## Note

Behavioral change: removing a connected account now **purges its trade/P&L history**
(previously orphaned). This is the intended fix for the orphaned-rows-feed-P&L issue
and was confirmed as the desired behavior.
