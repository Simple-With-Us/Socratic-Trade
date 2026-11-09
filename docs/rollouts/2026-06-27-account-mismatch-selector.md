# 2026-06-27 - account mismatch selector

## Summary

- Fixed the Hide Test account preference so inactive Test rows are hidden from both Settings -> Accounts and the command-bar account selector.
- Scoped Latest Decisions and Strategy Tuning latest-run reads to the active `connectedAccountId`.
- Wrote new `strategy_run` audit rows with the selected `connectedAccountId`.
- Stopped selected Alpaca connected accounts from falling back to generic/operator paper keys when their stored credentials are missing or unreadable.

## Why

- The operator selected the Roth IRA Alpaca account, but the Decision tab could still show an old red Account Mismatch from another account because `strategy_run` audit reads were user-global.
- A selected Alpaca account with unreadable or missing stored credentials could silently borrow the generic Alpaca paper key, creating a misleading cross-account mismatch instead of an actionable credential error.
- The Hide Test account toggle only affected one selector surface; Settings -> Accounts still showed Test.

## Files

- `app/dashboard-client.tsx`
- `src/lib/alpaca.ts`
- `src/lib/dashboard.ts`
- `src/lib/db-learning.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `test/account-scope.test.ts`
- `test/persistence-notification.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-27-account-mismatch-selector.md`

## Verification

- `npx vitest run test/account-scope.test.ts test/persistence-notification.test.ts` - passed, 18 tests.
- `npx tsc --noEmit` - passed.
- `npm test` - first run failed only because `test/correlation-cluster-gate.test.ts` timed out at 5s; 1,445 tests passed.
- `npx vitest run test/correlation-cluster-gate.test.ts` - passed, 8 tests.
- `npm test` - passed on rerun, 1,446 tests.
- `npm run build` - passed; Next emitted the existing `middleware` convention deprecation warning.

## Follow-ups

- If an account still reports missing Alpaca credentials after this change, re-save the Roth IRA API key in Settings -> Accounts and confirm the server can decrypt it with the current `ENCRYPTION_KEY`.
