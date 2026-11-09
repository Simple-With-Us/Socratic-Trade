# 2026-06-28 - Settings Connection Status placement

## Summary

- Moved the admin-only `Connection Status` link into the Settings modal header
  beside `Manage Accounts`.
- Removed the old bottom `Connection Health` card from Settings -> Connections.
- Changed OpenAI's API-key catalog row from `Required` to `LLM`, so it no
  longer shows a `Required` badge or OpenAI-specific warning copy.
- Updated the current multi-user/connections doc wording to treat OpenAI as one
  LLM provider among the configured provider set.

## Why

The connection-status entry should be visible as soon as Settings opens, and
OpenAI should not be presented as a special required provider now that strategy
and assistant model choice spans multiple LLM providers.

## Files

- `app/dashboard-client.tsx`
- `app/api/keys/route.ts`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-settings-connection-status.md`

## Verification

- `npm ci` - passed in the isolated worktree to install local dependencies.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 153 files / 1,486 tests.
- `npm run build` - passed.
- Local production preview on `http://127.0.0.1:4119` - passed.
- Playwright desktop/mobile Settings smoke - passed:
  - Desktop: `/tmp/settings-connection-status-desktop-settled.png`
  - Mobile: `/tmp/settings-connection-status-mobile-settled.png`
  - Confirmed desktop shows `Connection Status` beside `Manage Accounts`.
  - Confirmed mobile uses compact `Status` / `Accounts` header labels.
  - Confirmed old `Connection Health` / `View Status` text and OpenAI-required
    warning copy are absent.
- Note: a temporary `next dev` preview on port 4118 returned framework 404s for
  app routes/APIs and left a corrupt generated `.next/dev/types/validator.ts`.
  After stopping it, deleting the generated `.next/dev` directory made
  `npx tsc --noEmit` pass; the built `next start` preview served the same routes
  correctly.

## Follow-ups

- None.
