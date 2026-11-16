# 2026-07-13 — Exit Replacement Codex Fixes Round 5 (Antigravity/AG)

## Summary
Addressed the final two architectural P1 findings identified by Codex on PR #1492 for the exit replacement state machine.

## Why
1. **Migration 21 Deduplication**: Previously, duplicate active rows were resolved strictly by `MIN(rowid)`. Codex noted that this could drop a row that has already progressed (e.g. `replacement_submitted`) in favor of an older duplicate stuck in `cancel_requested`. Updated Migration 21 to use a SQLite window function to rank rows by state progress, ensuring the most advanced row survives.
2. **Ambiguous Claim State**: The CAS from `cancel_confirmed` -> `replacement_submitted` happened before `placeEquityOrder`. A crash in that window left a row that recovery treated as already-submitted, attempting to find a non-existent broker order. Introduced `replacement_claiming` as a distinct leased state. If a row is found in `claiming`, it implies it never reached the broker, and after a timeout, the background pump safely reverts it to `cancel_confirmed` for retry instead of failing.

## Files Touched
- `src/lib/order-replacement.ts`: Modified `OrderReplacementRow` status type and state machine logic.
- `src/lib/db.ts`: Updated Migration 21 and baseline `CREATE TABLE` to include `replacement_claiming`. Added Migration 22 to recreate the `order_replacements` table to properly expand the `CHECK` constraint.

## Verification
- Local build, typecheck, lint, and all 3934 tests passed successfully.
- Tests confirm the state transitions function correctly and the migration does not break existing test data.

## Next Steps
Land the PR and await merge to production.
