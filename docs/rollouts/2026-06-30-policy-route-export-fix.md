# 2026-06-30 - Policy Route Export Fix

## Summary

Fixed a production build failure introduced in the merged production sweep by
moving `stripNullsDeep` out of the app route module.

## Why

Next 16 validates app route module exports during `npm run build`. The merged
`app/api/policy/route.ts` exported `stripNullsDeep` for a unit test, which made
the route invalid even though the runtime policy logic was otherwise correct.

Antigravity strategy-review/test-quote fallback work landed separately on
`origin/main` as PR #274. This branch has merged that base for deployment, but
its own fix remains limited to the policy route export blocker.

## Files

- `STATUS.md`
- `PLAN.md`
- `app/api/policy/route.ts`
- `src/lib/policy-null-stripping.ts`
- `test/policy-clear-nulls.test.ts`
- `docs/rollouts/2026-06-30-policy-route-export-fix.md`

## Verification

- `npm run lint` - pass, 0 errors / 254 existing warnings.
- `npx tsc --noEmit` - pass.
- `npm test` - pass, 165 files / 1577 tests.
- `npm run build` - first rerun failed with host `ENOSPC` while writing
  `.next/trace`; after clearing this worktree's generated `.next` output and
  Homebrew download cache, rerun passed. Route table includes `/api/policy`.
- After merging `origin/main` with PR #274: `npm run lint` passed with 0 errors
  / 254 existing warnings, `npx tsc --noEmit` passed, `npm test` passed (165
  files / 1577 tests), and `npm run build` passed.

## Follow-ups

- Merge this fix before retrying the production deploy.
- Antigravity work is already accounted for through merged PR #274.
