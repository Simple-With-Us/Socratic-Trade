# 2026-07-06 — Console de-alarm, optional confirmation, mobile parity, legacy removal, ⌘K, admin hub

**Author:** CLAUDE · **Branch:** `claude/vigorous-lederberg-5b6d55` · one PR bundling several owner-directed changes.

## Summary

A themed batch that removes real-money risk-aversion from the UI, makes the typed-confirmation
ritual an owner-adjustable preference, brings mobile to parity, retires the legacy `/old` dashboard,
adds a ⌘K command palette, and stands up an operator-admin hub / `admin.socratictrade.com` scaffold.

1. **Real-money banner removed + "START LIVE" ritual removed.** Real money is the app's normal,
   in-domain case, so it carries no banner and no extra ceremony. `executionBanner()` returns null for
   `broker/live` (`app/dashboard-client.tsx`, now deleted); the console `RealityBanner` already
   suppressed live. The run-control "START LIVE / RESUME LIVE" typed ritual is gone — starting a live
   account is one tap like any other (`app/console/components/chrome.tsx`). Only paper/simulated money
   keeps a calm marker.
2. **`policy.requireTypedConfirmation` (Settings → Advanced action confirmation).** New owner
   preference (default ON, preserves current behavior). When OFF, high-impact LIVE actions become
   one-click: approving a broker order, replacing a live order at market, and loosening a guardrail on
   a live account. Enforced on BOTH server (`assertLiveApprovalConfirmation` in `src/lib/strategy.ts`,
   `assertMarketReplaceConfirmation` in `src/lib/order-replacement.ts` early-return when off) and
   client (approval-card, replace-market-sheet, policy-form, strategy review). Genuinely destructive
   actions (wind-down that SELLS, account deletion) keep their own typed confirmation regardless.
3. **Mobile parity.** The mobile PWA now honors the same flag — the snapshot API forwards
   `requireTypedConfirmation` and the client keys its typed-input/gating/payload off `willPromptTyped`.
   Server already covered mobile (same `executeProposal` gate).
4. **Legacy `/old` dashboard removed.** `/old` now redirects to `/console` and its exclusive files are
   deleted (see Files). The console is a verified near-complete superset. Two legacy-only features were
   dropped by owner decision: the Strategy Flow `@xyflow` visualizer (cosmetic; per-piece status lives
   in the admin pages) and the legacy command palette (replaced by the new console-native ⌘K).
5. **⌘K command palette (console-native).** `app/console/components/command-palette.tsx`, wired into
   `ShellFrame`. ⌘K/Ctrl+K or the chrome trigger opens it; seeded with the 13 destinations + theme
   toggle; ↑/↓ + Enter, Esc. `con-*`-styled, platform-aware (⌘ vs Ctrl).
6. **Operator admin hub + `admin.socratictrade.com` scaffold.** New `app/admin/page.tsx` lists the four
   admin pages in one place (replacing the scattered Settings links). Host-aware redirect in
   `app/page.tsx` and env-gated cross-subdomain session cookie in `src/lib/auth/auth.ts` — both INERT
   until `ADMIN_HOST` + `AUTH_COOKIE_DOMAIN` are set (see Follow-ups for the DNS/env runbook).
7. **Fixed a pre-existing flaky test (blocking the gate).** `src/lib/db-socratic.ts` framework/decision
   list queries ordered by `created_at` alone; same-millisecond inserts tied and `[0]` was
   nondeterministic (`socratic-db.test.ts` failed ~80% of runs). Added `, rowid` tiebreakers to the
   three queries — now deterministic (6/6 + full-suite green).

## Why

Owner directives across the session: stop treating real money as dangerous/annoying (banners, alarm
red, typed rituals); make the confirmation friction an adjustable preference like the other guardrails;
fix mobile too; retire the legacy dashboard (superseded, and it ignored the new preference); add a
standard ⌘K palette; consolidate the admin pages onto a dedicated hub/subdomain.

## Files

Added: `app/console/components/command-palette.tsx`, `app/admin/page.tsx`,
`docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`, this rollout note.
Modified: `app/console/components/{chrome,shell,nav,approval-card,policy-form}.tsx`,
`app/console/orders/replace-market-sheet.tsx`, `app/console/strategy/page.tsx`,
`app/console/settings/page.tsx`, `app/console/console.css`, `app/mobile/mobile-pwa-client.tsx`,
`app/api/mobile/snapshot/route.ts`, `app/old/page.tsx` (now a redirect), `app/page.tsx`,
`src/lib/{types,defaults,strategy,order-replacement,db-socratic}.ts`, `src/lib/auth/auth.ts`,
`docs/EFFORT-LOG.md`, `STATUS.md`.
Deleted (legacy `/old` dashboard + exclusive deps + 2 dead tests): `app/dashboard-client.tsx`,
`app/dashboard-widgets.tsx`, `app/components/ConfirmationModal.tsx`,
`app/ui/{overlays,charts,macro-panel,assistant-console,delivery-channels,symbol-button,symbol-drilldown,ticker-logo,learned-context-queue,command-palette,strategy-flow}.tsx`,
`src/lib/strategy-review-display.ts`, `test/{tuningcard-consolidation,strategy-review-display}.test.ts`.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **266 files / 2642 tests, all pass** (count dropped from 2650 because two dead test
  files were deleted; the previously-flaky `socratic-db` test now passes 6/6 in isolation and in the
  full suite).
- `npm run build` — passes (exit 0).
- Safety-grepped every deleted module for external importers (none); tsc caught the one wrong
  "exclusive" claim (`app/ui/ticker-logo` was also used by `app/ui/symbol-drilldown`, which was itself
  orphaned and deleted).

## Follow-ups

- **`admin.socratictrade.com` runbook (owner):** (1) DNS `admin.socratictrade.com` → CNAME to the same
  tunnel target as `socratictrade.com`; (2) add it as a tunnel ingress hostname; (3) set prod env
  `ADMIN_HOST=admin.socratictrade.com` and `AUTH_COOKIE_DOMAIN=.socratictrade.com`, redeploy. The
  cookie-domain change re-scopes the session cookie across `*.socratictrade.com`, so existing sessions
  sign in once more. Until then, the admin hub is live at `socratictrade.com/admin`.
- **`@xyflow/react`** is now unused (only `strategy-flow.tsx` imported it) — removable from
  `package.json` in a small deps-cleanup pass (left in to avoid a lockfile/install churn in this PR).
- `app/old/page.tsx` was kept as a redirect (not a hard 404) so stale bookmarks land on `/console`.
- Owner decision still open: default `requireTypedConfirmation` OFF instead of ON (currently ON to
  preserve behavior; flip in `src/lib/defaults.ts`). Wind-down and account deletion intentionally still
  require their typed confirmation.
