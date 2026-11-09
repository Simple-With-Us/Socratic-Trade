# 2026-06-19 - Request user resolution

## Summary

- Added a central request-user resolver that reads `x-user-id`, then `userId`
  query/body hints, and defaults to `local`.
- Routed high-impact API handlers through that helper while preserving current
  no-auth dashboard behavior for requests without user hints.
- Added focused resolver tests for default local, header, query, body, and empty
  hint fallback behavior.

## Why

- Phase 11 needs request-level `userId` plumbing before real identity/auth is
  exposed.
- The current app is still intentionally no-auth; this pass keeps `local` as the
  default and avoids presenting the scaffolding as completed authentication.

## Files

- `src/lib/request-user.ts`
- `app/api/accounts/route.ts`
- `app/api/audit/route.ts`
- `app/api/connected-accounts/route.ts`
- `app/api/connected-accounts/[id]/activate/route.ts`
- `app/api/connected-accounts/[id]/route.ts`
- `app/api/dashboard/route.ts`
- `app/api/history/route.ts`
- `app/api/keys/route.ts`
- `app/api/market/flatfile/route.ts`
- `app/api/orders/route.ts`
- `app/api/orders/cancel/route.ts`
- `app/api/policy/route.ts`
- `app/api/portfolio/route.ts`
- `app/api/positions/route.ts`
- `app/api/profiles/route.ts`
- `app/api/profiles/[id]/activate/route.ts`
- `app/api/profiles/[id]/route.ts`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/[id]/reject/route.ts`
- `app/api/scan/route.ts`
- `app/api/strategy/enable/route.ts`
- `app/api/strategy/pause/route.ts`
- `app/api/strategy/run/route.ts`
- `app/api/strategy/tune/route.ts`
- `test/request-user.test.ts`
- `docs/phase-11-multi-user.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-19-request-user-resolution.md`

## Verification

- `npx vitest run test/request-user.test.ts test/counterfactual-learning.test.ts test/policy.test.ts test/reconciliation-risk.test.ts` - passed, 34 tests across 4 files.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 223 tests across 30 files.
- `npm run build` - passed.

## Follow-ups

- Complete the remaining Phase 11 query/data isolation audit before exposing
  non-local users.
- Add real identity/auth last; this helper is only request-user scaffolding.
