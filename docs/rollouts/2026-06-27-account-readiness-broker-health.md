# 2026-06-27 - account-readiness-broker-health

## Summary

- Added server-derived `accountReadiness` to dashboard snapshots.
- Wired the readiness strip, Start blocker, Run once blocker, and setup routing to that shared readiness result.
- Kept stored/backfilled connected-account rows visible for management without allowing them to imply execution readiness.
- Made `/api/strategy/enable` return a clear setup error when broker account enumeration fails.

## Why

- The dashboard could show `Account` as ready because `policy.accountNumber` existed, even when Robinhood OAuth was missing or the broker account was otherwise unusable.
- Alpaca needed the same fail-closed treatment: selected account rows should not become a green check when credentials fail, live broker enumeration omits the selected account, the broker marks the account non-agentic, or portfolio/balance reads fail.
- Visibility fallbacks remain useful, but every fallback that keeps the UI usable must leave enough status trail to correct the underlying issue.

## Files

- `app/api/strategy/enable/route.ts`
- `app/dashboard-client.tsx`
- `app/dashboard-types.ts`
- `src/lib/dashboard.ts`
- `test/dashboard-agentic-fallback.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-27-account-readiness-broker-health.md`

## Verification

- `npm ci`
- `npm test -- --run test/dashboard-agentic-fallback.test.ts` - 8 tests passing
- `npx tsc --noEmit`
- `npx eslint src/lib/dashboard.ts app/api/strategy/enable/route.ts test/dashboard-agentic-fallback.test.ts`
- `npx eslint app/dashboard-client.tsx src/lib/dashboard.ts app/api/strategy/enable/route.ts test/dashboard-agentic-fallback.test.ts` - 0 errors, existing dashboard-client warnings only
- `npm test` - 1463 tests passing across 151 files
- `npm run build`
- `npm run lint` - 0 errors, 214 existing warnings

## Follow-ups

- Production still needs deployment/sync before `socratictrade.com` reflects this branch.
- If future broker integrations add account health checks, feed them into `accountReadinessForSnapshot` instead of adding another client-only readiness guess.
