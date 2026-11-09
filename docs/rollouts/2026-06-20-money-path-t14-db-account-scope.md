# 2026-06-20 — T14-db: consistent account scoping for notional caps

## Summary

Closed the last open money-path task (T14-db): a missing/blank `account_number` now maps to
an explicit sentinel (`__unassigned__`) **consistently at write and read**, rather than relying
on the `account_number` column's empty-string DEFAULT (which could silently merge the
unassigned bucket across contexts).

## What changed

- `src/lib/db.ts`: new `scopeAccount()` helper, applied at the `trade_proposals` write
  (`insertProposal`) and both notional-cap readers (`dailyExecutionStats`,
  `notionalInLastMinutes`). Named accounts are unchanged; only empty/whitespace normalizes.
- `test/account-scope.test.ts` (new): an empty write + a whitespace read resolve to the SAME
  bucket (this is the fix), a named account is isolated, and the rolling hourly window mirrors it.

## Why

Audit T14 flagged that `account_number TEXT NOT NULL DEFAULT ''` plus per-account WHERE scoping
could mis-bucket an unassigned account. Owner approved (the data-migration risk is acceptable —
the agentic account holds throwaway-only funds).

## Verification

- `npx tsc --noEmit` clean; `npx vitest run test/account-scope.test.ts` — 1 passed.

## Follow-ups

- Legacy rows written with a literal `''` won't match the new sentinel; acceptable per owner
  (throwaway data, recent-window caps). No migration run.

## Blockers

- None.
