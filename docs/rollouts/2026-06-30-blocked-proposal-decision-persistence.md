# 2026-06-30 - Blocked proposal decision persistence

## Summary

- Added optional decision persistence to `updateProposalStatus`.
- Stored policy/tradability block reasons when `executeProposal` moves a proposal to `blocked`.
- Added a Latest Decisions fallback label for older blocked proposals that do not have stored reasons.

## Why

The stale PR #256 contained one useful behavior not yet present on current main:
blocked proposals should keep the policy decision reasons that caused the block.
The rest of #256 was stale and would revert newer merged work, so this branch
reapplies only the safe persistence change on top of current `origin/main`.

## Files

- `src/lib/db-proposals.ts`
- `src/lib/strategy.ts`
- `app/dashboard-client.tsx`
- `test/deep-safety-fixes.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-30-blocked-proposal-decision-persistence.md`

## Verification

- `npm ci` - passed in the fresh worktree; npm reported 2 moderate audit findings and install-script allowlist warnings.
- `npm test -- test/deep-safety-fixes.test.ts -t "can persist blocked policy decisions when status changes"` - passed.
- `npx tsc --noEmit --pretty false` - passed.
- `npm test -- test/deep-safety-fixes.test.ts` - passed, 9 tests.
- `npm run lint` - passed with 0 errors and 256 existing warnings.
- `npm test` - passed, 160 files / 1555 tests.
- `npm run build` - passed; Next emitted the existing middleware-to-proxy deprecation warning.

## Follow-ups

- Close stale PR #256 after this replacement lands.
