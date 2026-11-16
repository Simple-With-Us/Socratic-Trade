# 2026-08-21 - Activity layout redesign

## 1. Context & Objective

Activity and Strategy Runs were hard to read: Title Case was inconsistent, Runs/Fills/All/Audit duplicated each other, failed runs showed "Sent" instead of why they failed, Alpaca Paper stamped Delayed Quote on last-session closes, and system alerts went to Pushover while account notices went to iOS.  This redesign makes Activity scannable, tells the user why a run failed in plain English, pushes through the app first, and keeps iOS deep links additive so another agent's pairing work is not smashed.

## 2. Changes Made

Website Activity is five Title Case tabs in this order: Alerts Center, Notifications, Strategy Runs, Order Fills, Audit Log.  Default is Alerts Center.  The former All unified feed is Audit Log.  Legacy `?tab=all` still opens Audit Log.  Raw JSON stays behind Raw Events.

Failed strategy runs now show a wrapping English reason on Alerts Center, Strategy Runs, Audit Log, and Notifications (when the payload has one).  Delivery-status copy ("Not sent - ...") still explains empty-payload skips.

Native iOS push is included whenever APNs is configured and the user has a live device token, even if prefs omitted `apns`.  System-wide connection and storage alerts fan out to every administrator.  Pushover/email remain last-resort extra delivery when no admin has a live device.

Alpaca last-session close is tagged `session-close`, not `yahoo-finance-delayed`.  A two-sided live NBBO with a fresh `fetchedAt` is treated as live even when last-print `asOf` is old.  Delayed Quote stays only for real Yahoo delayed fallback.

iOS Activity matches the five sections (iPhone chips, iPad/Mac left rail).  Push URLs add `?tab=alerts` or `?tab=notifications` only.  Approvals / orders / watchlist paths are unchanged.  Path-only `/console/activity` still lands on the Activity tab without resetting the last section.

Touched files:

- `src/lib/activity-tabs.ts`
- `src/lib/strategy-run-failure.ts`
- `src/lib/admin-user-ids.ts`
- `src/lib/notification-delivery.ts`
- `src/lib/notify.ts`
- `src/lib/db-health.ts`
- `src/lib/dashboard-ui.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard.ts`
- `src/lib/push-deep-links.ts`
- `src/lib/notification-history.ts`
- `src/lib/alpaca.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/quote-delayed-fallback.ts`
- `app/console/activity/page.tsx`
- `app/console/activity/audit-feed.tsx`
- `app/console/activity/audit-log.tsx`
- `app/console/activity/day-groups.tsx`
- `app/console/activity/notifications-ledger.tsx`
- `app/console/activity/order-fills-list.tsx`
- `app/console/activity/status-tone.ts`
- `app/console/activity/strategy-runs-list.tsx`
- `app/console/components/alert-center.tsx`
- `app/console/components/command-palette.tsx`
- `app/console/components/notification-inbox.tsx`
- `app/console/components/nav.tsx`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/api/mobile/snapshot/route.ts`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/DeepLink.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTradeTests/DeepLinkTests.swift`
- `ios/SocraticTradeTests/PushNotificationTests.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `test/activity-tabs.test.ts`
- `test/strategy-run-failure.test.ts`
- `test/console-tabs-keyboard.test.ts`
- `test/alpaca-quote-fallback.test.ts`
- `test/quotes-cascade.test.ts`
- `test/dashboard-feed.test.ts`
- `test/apns-deep-link-contract.test.ts`
- `test/apns-push.test.ts`
- `test/notification-history.test.ts`
- `test/admin-user-ids.test.ts`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/rollouts/2026-08-21-activity-layout-redesign.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- Did not rewrite Alerts Center internals (incident grouping, mutes, Attention filter).  The layout and Title Case heading changed; the triage logic did not.
- Did not invent new content URL paths.  `?tab=` is query-only so the iOS parser's two-segment rule still holds.  Another agent pairing notifications to in-app destinations keeps `/console/approvals?proposal=`, `/console/orders?symbol=`, `/console/watchlist?symbol=`.  Catch-all with no place to go lands on Notifications.
- Enabled-event toggles stay real.  Auto-including APNs is a channel rule, not a type override.
- Session close is not Delayed Quote.  The stamp stays for actual Yahoo delayed fallback.
- iOS Today metrics and Recent Actions were dropped from Activity.  Those already live on Home.  Strategy Runs keeps the scheduler Last/Next strip.
- Linux cannot compile Swift.  `ios-build` on the Mac runner is the Swift gate.
- Did not HOTFIX or bounce production during weekday RTH.

## 4. Verification State

Local (this Linux cloud VM):

```
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npx vitest run test/activity-tabs.test.ts test/admin-user-ids.test.ts \
  test/strategy-run-failure.test.ts test/console-tabs-keyboard.test.ts \
  test/alpaca-quote-fallback.test.ts test/quotes-cascade.test.ts \
  test/dashboard-feed.test.ts test/apns-deep-link-contract.test.ts \
  test/apns-push.test.ts test/console-nav-labels.test.ts \
  test/notification-history.test.ts test/connection-health-routing.test.ts
                      # 12 files / related suites green after Title Case + failure-body assertion updates
npm run build         # Next.js 16.3.1 webpack build succeeded
```

CI `ios-build` on SHA `9abde5cd` (Mac run 32537949489): BUILD SUCCEEDED, TEST SUCCEEDED, 233 XCTests / 0 failures.

CI `verify` on the same SHA failed three tests: sentence-gap on the Strategy Runs tooltip (two ASCII spaces, which HTML collapses), and operator-diagnostics still expecting `AuditLogPanel` on `activity/page.tsx` after it moved behind Audit Log's Raw Events.  Fixed on the next SHA.

CI `verify` on `0e2d4dcf` (run 32539289575): classify + verify-hosted + verify all success.

Merged to `main` as squash `d588387b` at 2026-08-22T00:47:48Z.

A full local `npm test` pass was started earlier and then stopped after ~15m: unrelated files were timing out on network (history/Yahoo, strategy gather, RAG coverage).

## 5. Next Steps & Blockers

- Merged.  Website half auto-deploys off `main` (watch_paths include `app/**` + `src/**`).  Live `/api/health` at 00:49Z still showed `c6f33086` (#3032) — do not claim this SHA is in production until `checks.release.sha` contains `d588387b`.
- iOS Activity rail ships only via TestFlight (`ios/**` is outside Coolify watch_paths).
- Other agent's notification deep-link pairing can keep adding destinations; catch-all remains Notifications.
- Pushover remains available as an extra channel in Settings.  It is no longer the primary system-alert path when APNs can reach an admin.
- Optional follow-up: extract `deliverSystemAlertToAdmins` for vector-db / llm-provider-cooldown / usage-limit-alerts / provider-tier (primary admin already gets APNs via `channelsForNotify` when tokens exist on `"local"`).

## 6. Zero-Code Findings

Stale quotes on Alpaca Paper were a real bug, not a display quirk.  IEX last-print `asOf` can sit still on quiet names, and `fillMissingQuotesWithClose` used to tag last-session OHLC as `yahoo-finance-delayed` plus `delayedFallback: true`, so empty IEX stamped Delayed Quote even for a session close.  Freshness now ages `fetchedAt` for two-sided live NBBO, and session close is its own provider.
