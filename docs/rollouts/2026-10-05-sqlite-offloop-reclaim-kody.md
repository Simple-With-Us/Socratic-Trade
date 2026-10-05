# SQLite off-loop wedged reclaim (Kody PR #4164)

## Context & Objective

Kody flagged that matching execution timeout to the caller deadline without a started-slot reclaim left wedged FTS workers pinned after caller abort won the race.  Restore module-level reclaim without respawning the pool on ordinary caller abort.

## Changes Made

- Keep the start-armed execution timer when a started request settles via caller `AbortSignal`; track those waiters in `reclaimById`.
- `onExecutionTimeout` retires the slot even when the waiter already settled; `clearExecutionReclaim` drops the timer when the worker replies after a caller abort.
- Remove unreachable `settleReject` branch (`started && abandonedByBudget`).
- Test: reclaim after caller abort when execution budget fires.

Files:

- `src/lib/rag/sqlite-all-offloop.ts`
- `test/sqlite-all-offloop.test.ts`

## Decisions & Trade-offs

Caller abort alone still does not `killSlot` synchronously (warm pool).  Wedged `.all()` is reclaimed only when the start-armed budget fires or the worker finishes and clears reclaim.

## Verification State

```bash
npm test -- test/sqlite-all-offloop.test.ts
```

22 tests passed.

## Next Steps & Blockers

Push to `grok/lexical-fts-off-event-loop`; reply on Kody threads; human resolves GraphQL.

## Zero-Code Findings

None.
