# 2026-07-11 — PR #1371 round 5: 4 more Codex findings + reconciling #1331's squash-merge

## Summary

- Fixed 4 fresh Codex findings triggered by the round-4 push, two of which were regressions in my
  own round-4 fixes:
  - `broker-protective-stops.ts`'s section-2b "none"-plan teardown (added round-4) only covered
    literal `"none"` plans; broadened to cover any plan-excluded broker-held stop
    (`kindForSymbol === null`), and added fill-booking before delete (it was missing entirely).
  - `strategy.ts`'s `staleStopPlanSymbols` cleanup computed candidates from the already-live-basis-
    filtered `stopPlanBySymbol` map — which never contains a closed symbol in the first place
    (`filterStopPlansByLiveBasis` drops it) — making the cleanup a silent no-op exactly when a
    position closes. Fixed by hoisting the raw unfiltered `getStopPlans` result and computing stale
    symbols from that instead.
  - `deleteConnectedAccount` (`db-api-keys.ts`) now purges `position_stop_plans` on account removal
    (the full user-deletion path already covered it; the per-account path didn't). New regression
    test in `test/account-delete-cleanup.test.ts`.
- Reconciled with PR #1331 squash-merging to `main` (GitHub auto-retargeted this PR's base) — 7 file
  conflicts, resolved by keeping this branch's per-position stop-plan additions throughout (main's
  squash tip predates the `stopPlanBySymbol`/`symKind` threading this PR adds).
- Reconciled with a concurrent owner+Opus push that added regression tests for the round-4 fixes and,
  in its own merge of `main`, chose to KEEP two round-2 PR #1331 findings (`trailingStopPct`
  `looserWhen` metadata, Alpaca-MCP ratchet flooring) that I had deferred per the owner's "not
  blocking this merge" disposition comment on #1331. Followed that call for consistency.
- The owner's own follow-up PR comment on #1371 confirmed all 4 round-5 findings were independently
  verified as correctly handled by the current code.

## Why

Continuation of the ongoing Codex-Autofix-bot-was-down triage across both PRs. The two regressions
(section-2b teardown scope, stale-plan cleanup no-op) are a reminder that a narrow fix landed under
time pressure can introduce its own gap — both were caught by the very next Codex review round.

## Files

- `src/lib/broker-protective-stops.ts` — broadened section 2b, added fill-booking there
- `src/lib/strategy.ts` — hoisted raw stop-plan lookup, fixed stale-symbol computation
- `src/lib/db-api-keys.ts` — `position_stop_plans` added to `deleteConnectedAccount`'s purge list
- `test/account-delete-cleanup.test.ts` — regression test for the above
- `app/console/guardrails/field-defs.ts`, `app/console/guardrails/stop-flow.tsx`,
  `docs/stop-loss-and-exit-strategies.md`, `src/lib/synthetic-stops.ts`,
  `test/broker-protective-stops.test.ts`, `test/stop-flow-model.test.ts` — merge conflict resolutions
  only, no independent changes (kept this branch's content in every case)

## Verification

```
npx tsc --noEmit   # clean
npm run lint       # 0 errors, 379 pre-existing grandfathered warnings
npm test           # 319 files / 3566 tests passed
npm run build      # clean
```

## Follow-ups

- Still open: OCO sibling-identity pairing (see PR #1331's comment thread) — needs a broker API
  change to fix precisely.
- PR #1371's base is now `main` directly (was the now-merged `claude/stop-loss-preset-options-f1jygn`).
  Owner has indicated intent to land this PR; no further action expected from this session unless
  new review activity arrives.
