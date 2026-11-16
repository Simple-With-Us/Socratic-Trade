# 2026-06-30 - Production Build Hotfix

## Summary

- Repaired production after the PR #270 deploy left `trading` stopped.
- Confirmed the `stripNullsDeep` route-export repair that first restored production has now landed separately in PR #275.
- Switched server-only crypto imports from `node:crypto` to `crypto` so the webpack build can compile the affected server/edge graph.
- Changed `npm run build` to `next build --webpack` so the automated deploy emits the root `BUILD_ID`, `routes-manifest.json`, `prerender-manifest.json`, and `required-server-files.json` files that the current PM2 `next start` runtime requires.

## Why

The self-hosted deploy for main commit `07085c91` failed during install, then a manual default `next build` completed but produced Turbopack artifacts without the root production marker files expected by `next start`. PM2 repeatedly restarted with `Could not find a production build in the '.next' directory`. A webpack build exposed the invalid route export and `node:crypto` import blockers, then produced the expected artifacts and let production boot after those blockers were fixed.

The Antigravity strategy-review persistence work landed separately as PR #274, and the route-export repair landed separately as PR #275. This branch only carries the remaining build/start repeatability changes.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/deployment.md`
- `docs/rollouts/2026-06-30-prod-build-hotfix.md`
- `package.json`
- `src/lib/ops-auth.ts`
- `src/lib/recoverable-issue.ts`
- `src/lib/scheduler-lease.ts`

## Verification

- Live manual repair on `~/apps/trading-live`:
  - `npx next build --webpack` - pass.
  - `pm2 restart trading --update-env && pm2 save` - pass.
  - `curl -I http://127.0.0.1:4000/` - 307 to `/login`.
  - `curl -i http://127.0.0.1:4000/api/health` - 200, `{"ok":true,...}`.
  - `curl -I https://socratictrade.com/` - 307 to `/login`.
- Branch verification after merging current `origin/main` (`0f5078d2`, PR #275):
  - `npm run lint` - pass, 0 errors, 254 existing warnings.
  - `npx tsc --noEmit` - pass after freeing disposable worktree build/cache artifacts to resolve host `ENOSPC`.
  - `npm test` - pass, 165 files / 1,577 tests.
  - `npm run build` - pass.

## Follow-ups

- Revisit Turbopack production builds separately once the production start command is known to consume the new artifact layout.
