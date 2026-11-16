# 2026-08-22 Hardening SQLite Migrations with tableExists and columnExists Guards

## Context & Objective
- **Issue:** #2964 ("Migrations 2 and 14 use PRAGMA table_info as an existence check, which returns empty (not an error) for a missing table")
- **Root Cause:** In SQLite, running `PRAGMA table_info(foo)` on a non-existent table returns an empty list (`[]`) rather than throwing an error.  Consequently, statements like `if (!cols.some(c => c.name === 'bar')) ALTER TABLE foo ADD COLUMN bar ...` evaluate to `true` when `foo` is missing, causing subsequent `ALTER TABLE` operations or table queries to throw fatal `no such table: foo` runtime exceptions.
- **Goal:** Standardize and export `tableExists` and `columnExists` helpers in `src/lib/db.ts`, and harden all versioned migrations (v2 through v86) against missing tables so they safely execute on any schema state (e.g. `DB_BOOTSTRAP=fresh`, isolated unit test databases, or out-of-order replays).

## Changes Made
- **`src/lib/db.ts`:**
  - Exported `tableExists(database, tableName)` querying `sqlite_master` for `type = 'table' AND name = ?`.
  - Exported `columnExists(database, tableName, columnName)` ensuring `tableExists` is verified before calling `PRAGMA table_info`.
  - Replaced un-guarded `PRAGMA table_info` and direct table access with `tableExists` and `columnExists` across migrations 2, 3, 5, 6, 9, 10, 12, 14, 15, 16, 17, 18, 20, 21, 22, 24, 25, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 46, 50, 59, 60, 63, 64, 65, 67, 70, 71, 72, 73, 83, 84, 85, 86, `migrateLegacyDailyOpeningCapRows`, and `backfillAccountScopedStrategyModels`.
- **`test/persistence-hardening.test.ts`:**
  - Added unit test asserting `tableExists` and `columnExists` correctly identify present and non-existent tables and columns.
  - Added test validating that running all versioned migrations (v2-v86) against a brand-new blank `:memory:` database with zero initial schema succeeds completely with zero errors.

## Decisions & Trade-offs
- Preserved existing migration semantics and schema integrity while guaranteeing idempotency across all database startup paths.
- Used strict parameter binding for table name queries in `tableExists` to prevent SQL injection or identifier casing ambiguity.

## Verification State
- `npm run lint`: passed (0 errors, 773 grandfathered warnings).
- `npx tsc --noEmit`: passed with 0 errors.
- `npx vitest run test/persistence-hardening.test.ts`: passed (25/25 tests).
- `npm test`: passed (7,566 tests across 681 files).
- `npm run build`: passed (clean Next.js production build).

## Next Steps & Blockers
- Merge PR #2964 with auto-merge.
- Proceed to next planned improvements in the autonomous cycle (Issue #2958 and Issue #2961).
