# 2026-06-23 - mobile-pwa-command-api

## Summary

- Added a shared backend mobile API for both the responsive Next.js/PWA phone
  surface and a SwiftUI iPhone client.
- Added a durable `mobile_commands` table, idempotent command queue, server-side
  command executor, audited command status, and SSE command/freshness events.
- Added `/mobile` as a phone-first PWA control surface for Run once, Start,
  Close only, Stop, approvals, watchlist, price alerts, positions, command log,
  and account deletion.
- Added SwiftUI starter files under `ios/SocraticTrade/` that use the same
  backend snapshot, command, SSE, and deletion endpoints.
- Added a multi-step account deletion/reset procedure for Google/Apple-authenticated
  users. The backend deletes user-scoped app data and server-stored broker/provider
  secrets, then signs the user out; optional Google/Apple OAuth grant revocation is
  called out as a provider-side action.
- Browser visual review tightened mobile UI contrast and touch targets: the
  `/mobile` danger-zone copy now has readable light/dark contrast, alert controls
  no longer overflow on phone widths, delete confirmation buttons stack on phones,
  and existing dashboard mobile action/consent controls use 44px touch targets.
- 2026-07-01 rebase: re-extracted the feature from the stale
  `codex/mobile-command-api` worktree onto current `origin/main` as
  `codex/mobile-command-api-rebase-20260701`. Resolved conflicts by preserving
  the current audited account-deletion lifecycle, adding `mobile_commands` as
  migration v8 after the account-scoped strategy-model migration, keeping the
  current dashboard header semantics, and adding the mobile PWA metadata.

## Why

- The backend needs to remain the source of truth for trading state, credentials,
  MCP orchestration, scraping, calculations, and long-running work.
- The PWA and native iOS app should be two control surfaces over the same validated,
  queued, audited command/status model instead of two separate authority paths.
- Account deletion has to be clear, deliberate, reversible only by re-signing in
  as a fresh app user, and safe for future Google/Apple login reuse.

## Files

- `app/api/mobile/bootstrap/route.ts`
- `app/api/mobile/snapshot/route.ts`
- `app/api/mobile/commands/route.ts`
- `app/api/mobile/commands/[id]/route.ts`
- `app/api/mobile/events/route.ts`
- `app/api/mobile/account-deletion/request/route.ts`
- `app/api/mobile/account-deletion/confirm/route.ts`
- `app/layout.tsx`
- `app/manifest.ts`
- `app/dashboard-client.tsx`
- `app/mobile/page.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `docs/mobile-api-and-clients.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-23-mobile-pwa-command-api.md`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/README.md`
- `PLAN.md`
- `public/icon.svg`
- `src/lib/account-deletion.ts`
- `src/lib/db.ts`
- `src/lib/mobile-api.ts`
- `src/lib/scheduler.ts`
- `STATUS.md`
- `test/mobile-api.test.ts`

## Verification

- `npm ci`
- `npx tsc --noEmit` - passed after fixing route/manifest/tax-settings types.
- `npx vitest run test/mobile-api.test.ts --testTimeout=20000` - passed.
- `npx tsc --noEmit` - passed after the visual polish and scheduler lazy-import fix.
- `npm test` - passed 100 files / 913 tests.
- `npm run build` - passed.
- Browser visual pass: `/mobile` checked at 360x740, 390x844, 768x1024, and
  1440x900; main dashboard smoke checked at 390x844 and 1440x900. Fixed the
  issues found during that pass.
- 2026-07-01 rebase verification:
  `bash scripts/npm-ci-with-shared-deps.sh`; `npx vitest run test/mobile-api.test.ts`
  (5 tests passed); `npx tsc --noEmit` (passed after dropping stale
  `evaluatorCadenceHours` from the mobile policy patch allowlist);
  `npm run lint && npx tsc --noEmit && npm test && npm run build`
  (lint 0 errors / existing warnings, TypeScript pass, 170 test files /
  1,632 tests pass, build pass with the existing Sentry Edge-runtime warning).

## Follow-ups

- Add a hosted push-notification provider/device-token path once the native app
  transport is chosen.
- Add Playwright coverage for `/mobile` deletion guardrails and core command
  controls.
- Consider adding `Sign in with Apple` to Auth.js once the Apple developer
  account/configuration is ready; the mobile API is already provider-neutral.
