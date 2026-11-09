# UI account deletion visual pass

## Summary

Added a signed-in-user app account deletion lifecycle and focused visual polish
for the account-management UI. Settings -> Data now has a danger-zone procedure
that previews the deletion scope, prepares deletion by halting the user's system,
and requires explicit acknowledgements plus typed phrases before final deletion.

Also improved connected-account rows so they stack on mobile, make inactive
`Use` the primary action, and visually anchor the active account.

## Why

Multi-user auth makes account lifecycle visible and important. Users need a
clear way to delete app-local data and stored broker/API/OAuth connections so
they can later sign in again as a fresh app user. The app cannot delete Google
accounts, Apple IDs, broker positions, broker orders, or provider grants, so
the UI must say that plainly and require multiple deliberate steps.

Visual review also found that account rows compressed poorly on narrow screens,
and that destructive account actions should live beside data/privacy controls
with more explicit copy.

## Files

- `app/api/account/deletion/route.ts`
- `app/dashboard-client.tsx`
- `src/lib/account-deletion.ts`
- `src/lib/db.ts`
- `src/lib/mcp-oauth.ts`
- `test/account-deletion.test.ts`
- `vitest.config.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-23-ui-account-deletion-visual-pass.md`

## Implementation notes

- Added `account_deletion_requests` and `account_deletion_audit` in schema
  migration version 4.
- Added `GET /api/account/deletion` for preview, `POST /api/account/deletion`
  for prepare, and `DELETE /api/account/deletion` for final confirmation.
- Prepare halts the user's system and releases `strategy_run_lock:<userId>`.
- Final deletion requires:
  - prepared request
  - typed verified email
  - typed `DELETE MY ACCOUNT`
  - acknowledgements for app data, broker/API connections, broker
    positions/orders remaining outside the app, provider revocation, and
    future fresh sign-in
  - for `local`, an additional checkbox and `DELETE LOCAL OPERATOR ACCOUNT`
- Final deletion blocks while strategy runs are `running`, proposals are
  `placing`, or broker-routed fills are `pending_reconciliation`.
- Final deletion removes private user rows across credentials, connections,
  profiles/settings, proposals/fills/snapshots, synthetic stops, notifications,
  watchlist, alerts, chat, memory, learned context, LLM usage, market-data
  demands, and normal audit events.
- Robinhood MCP token/state cleanup is per-user and preserves the global MCP
  client registration.
- The retained deletion audit stores only a subject HMAC/hash, schema version,
  timestamps, and row counts.
- Vitest now aliases both `@` and `@/` to `src` so tests that import Next route
  handlers resolve the same app aliases used by TypeScript/Next.

## Verification

- `npx tsc --noEmit` passed.
- `npx vitest run test/account-deletion.test.ts` passed 2 tests.
- `npx vitest run test/proposal-action-state.test.ts` passed 2 tests after the
  Vitest alias fix.
- `npm test` passed 107 files / 936 tests.
- `npm run build` passed.
- `git diff --check` passed.
- Local API smoke:
  - `/api/health` returned `200`.
  - `GET /api/account/deletion` with trusted
    `cf-access-authenticated-user-email` returned the signed-in preview, two
    connected accounts, zero blockers, and deletion counts.
- Playwright visual smoke using trusted Cloudflare Access email header:
  - desktop `1440x900`: no horizontal overflow; Settings -> Data shows Start
    deletion; deletion modal opens.
  - tablet `1024x768`: no horizontal overflow; Settings -> Data shows Start
    deletion.
  - mobile `390x844`: no horizontal overflow; normal page/modal scrolling;
    deletion modal opens with fixed footer actions.

- Restarted `trading-codex` after `npm run build`.

## Follow-ups

- Add a provider identity table keyed by provider + provider account id before
  Apple private-relay login becomes first-class.
- Consider a larger shell/header IA pass separately: visual review found tablet
  header density, readiness details hidden in native titles, and a generally
  softer/glassier style than a professional cockpit should have.
