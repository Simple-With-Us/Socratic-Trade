# 2026-06-30 - Test account readiness

## Summary
Fixed the Test/local account Start blocker that showed:
`Test account data check failed. Open Accounts and reconnect or fix credentials.`

## Why
Dashboard snapshots can record a recoverable portfolio display read error. That should block a
broker-backed Paper/Brokerage account, because broker data availability is part of account safety.
It should not block Test/local mode, which submits no broker orders and has no credentials to
reconnect. The previous readiness function treated every portfolio read error as a credential-style
account blocker, so local Test mode could incorrectly route the user back to Accounts.

## Files
- `src/lib/dashboard.ts` - treats Test/local readiness as independent of broker account and portfolio read gates.
- `test/dashboard-agentic-fallback.test.ts` - covers Test/local remaining ready when a portfolio display read error is present.
- `STATUS.md`, `PLAN.md` - handoff notes for the fix.

## Verification
- `bash scripts/npm-ci-with-shared-deps.sh` - installed dependencies in the fresh Codex worktree.
- `npx vitest run test/dashboard-agentic-fallback.test.ts` - 1 file / 9 tests passed.
- `npm run lint` - passed with 0 errors and 256 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - first post-merge run timed out in `test/route-ownership.test.ts`; focused rerun of that file passed, then full reruns passed with 159 files / 1540 tests and, after merging the latest `origin/main`, 159 files / 1547 tests.
- `npm run build` - passed; Next production build completed successfully.

## Follow-ups
- None for this Start blocker.
