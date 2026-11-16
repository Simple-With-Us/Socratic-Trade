# 2026-06-28 - quiet tile first-paint loading

## Summary

- Replaced the first-paint dashboard shell's repeated visible loading labels with
  quiet skeleton tiles.
- Kept one screen-reader status (`Preparing dashboard.`) for assistive tech.
- Preserved an explicit alert card for `/api/dashboard` load failures.
- Updated app-facing metadata, welcome-page copy, and one UI comment to use
  dashboard language.

## Why

The initial page could briefly show loading copy in three places: the header
state, the header-right status, and the center card. The selected design keeps
the transient state visually calm on mobile and desktop without adding
dependencies, timers, extra fetches, or meaningful load cost.

## Files

- `app/dashboard-client.tsx`
- `app/layout.tsx`
- `app/welcome/page.tsx`
- `app/ui/strategy-flow.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-28-quiet-tiles-loading.md`

## Verification

- `npm ci` - passed in the isolated worktree to install local dependencies.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 153 files / 1,485 tests.
- `npm run build` - passed.
- Local preview on `http://127.0.0.1:4117` - passed.
- Playwright first-paint screenshot check with `**/api/dashboard` held pending:
  - Desktop screenshot: `/tmp/agentic-loading-options/real-app/quiet-tiles-desktop.png`
  - Mobile screenshot: `/tmp/agentic-loading-options/real-app/quiet-tiles-mobile.png`
  - Confirmed the first-paint document did not contain the disliked wording.

## Follow-ups

- After merge, let the normal production deploy workflow run and verify
  `socratictrade.com` reaches the auth gate or health endpoint as expected.
