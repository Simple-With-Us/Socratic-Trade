# 2026-07-03 — P0 hotfix: baseline-DDL index crashed boot on pre-existing DBs (client_turn_id)

## Summary

Production (`trading-live`, pm2 `trading`) crash-looped after being deployed past
PR #333: every boot threw `SqliteError: An error occurred while loading
instrumentation hook: no such column: client_turn_id` (Sentry project
`socratic-trade`, issue `a595484d8c4b4f02ad5e9d27ace6eb16`, release `8e2b1181` =
the #333 squash commit; first seen 2026-07-02 21:14 CDT). `/api/health` returned
500; pm2 restart counter climbed (46 on `trading`, ~1500 on the `trading-codex`
preview, which had synced past #333 with an old dev DB).

## Root cause

PR #333 added `chat_turns.client_turn_id` correctly via a **versioned migration**
(`chat_turns_client_turn_id`: PRAGMA-guarded ALTER + `CREATE INDEX IF NOT
EXISTS`), but ALSO added both the column and
`idx_chat_turns_user_client (user_id, client_turn_id)` to the **baseline DDL**
inside `migrate()`. `getDb()` runs `migrate()` (baseline) **before**
`applyVersionedMigrations()`. On a pre-existing database:

1. `CREATE TABLE IF NOT EXISTS chat_turns (...)` — no-op (table exists, old shape);
2. `CREATE INDEX IF NOT EXISTS idx_chat_turns_user_client ...` — `IF NOT EXISTS`
   only guards the index **name**; the index doesn't exist yet, so SQLite tries to
   build it against the old table → `no such column: client_turn_id` → `migrate()`
   throws → boot fails **before** the versioned migration that would have added the
   column ever runs.

On a **fresh** database the baseline `CREATE TABLE` includes the column, so
nothing fails — which is exactly why CI (`verify`) stayed green and why the same
error signature in two agent worktrees earlier in the evening was misdiagnosed as
a "stale gitignored artifact" instead of a shipped bug. The failure mode only
exists for databases that predate the migration — i.e. every real deployment.

## Ops recovery (already performed, before this PR)

- `pm2 stop trading` → `sqlite3 data/app.db ".backup data/app.db.bak-20260703-clientturnid"`
  → `ALTER TABLE chat_turns ADD COLUMN client_turn_id TEXT;` (the exact statement
  the versioned migration would have executed) → `pm2 restart trading` →
  `/api/health` 200. Backup retained at
  `~/apps/trading-live/data/app.db.bak-20260703-clientturnid`.
- Same additive ALTER applied to `~/apps/trading-codex/data/app.db` (stopped the
  ~1500-restart crash loop) and `~/apps/trading-claude/data/app.db`
  (pre-emptive — that preview was still on pre-#333 code and would have crashed on
  its next sync).
- The integration worktree (`trading-main`, beta 4001) is still pre-#333 and its
  DB will be migrated correctly by the fixed code when it syncs.

## Code fix (this branch)

- `src/lib/db.ts`: baseline DDL reverted to the frozen `SCHEMA_BASELINE` shape —
  removed `client_turn_id` from the baseline `CREATE TABLE chat_turns` and removed
  the baseline `CREATE INDEX idx_chat_turns_user_client` line. The versioned
  migration `chat_turns_client_turn_id` is now the **single** source for both the
  column and the index (it runs for fresh DBs too — first boot applies it right
  after the baseline). A warning comment now marks the trap at the site.
- `test/db-migration-old-schema.test.ts` (new): creates a real pre-#333-shaped
  `chat_turns` (with `model`, without `client_turn_id`) plus a legacy row in a temp
  DB, points `DATABASE_URL` at it, then calls `getDb()` — the exact call that
  crashed production — and asserts no throw, column present, index present, legacy
  row intact with `client_turn_id IS NULL`.

## Rule going forward (all agents)

`migrate()`'s baseline exec is frozen at `SCHEMA_BASELINE`. Never add
migration-era columns or indexes to it — new schema changes go ONLY in the
versioned `MIGRATIONS` array (as its own doc-comment already instructs). An index
in the baseline that references a column only a versioned migration adds will
boot-crash every pre-existing database while CI stays green.

## Files

- `src/lib/db.ts` — baseline DDL reverted to SCHEMA_BASELINE shape + warning comment.
- `test/db-migration-old-schema.test.ts` — new regression test (old-DB boot).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` (results in PR).
- Manual: prod `/api/health` 200 after ops recovery; regression test fails against
  the pre-fix db.ts (baseline index) and passes with the fix.

## Follow-ups

- None for the incident itself. The Sentry alert did its job — first real save
  from the 2026-07-02 monitoring rollout.
