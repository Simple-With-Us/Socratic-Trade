# 2026-06-28 - thin boot strip first-paint loading

## Summary

- Replaced the selected Quiet Tiles SSR dashboard loading shell with option 4,
  the thin boot strip.
- Kept the brand header, one screen-reader status, and the existing explicit
  failure alert for dashboard load errors.
- Added one tiny CSS animation class that respects `prefers-reduced-motion`.

## Why

The user selected option 4 after reviewing the loading-state alternatives. The
thin boot strip is cheaper and calmer than the tile grid because it adds no
dependencies, no timers, no extra fetches, and very little DOM while still making
the brief initial state feel intentional on mobile and desktop.

## Files

- `app/dashboard-client.tsx`
- `app/globals.css`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-28-thin-boot-strip-loading.md`

## Verification

- `npm ci` - passed in the isolated worktree.
- `npm run lint -- --quiet` - passed.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 155 files / 1,494 tests.
- `npm run build` - passed, existing Next middleware-to-proxy deprecation warning only.
- In-app browser against `http://127.0.0.1:4125/` - passed:
  - desktop first-paint screenshot showed only the brand header plus thin strip;
  - 390px mobile first-paint screenshot showed only the brand header plus thin strip;
  - DOM status contained one screen-reader-only `Preparing dashboard.` status.

## Follow-ups

- After merge, let the normal production deploy workflow run and verify
  `socratictrade.com` reaches the auth gate or health endpoint as expected.
