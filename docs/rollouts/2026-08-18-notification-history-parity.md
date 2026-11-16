# 2026-08-18 — Notification history + web/iOS inbox parity

## Context & Objective

Jay asked for notification history (page, sheet, or inbox) and more user-visible parity between the website and iOS.  Toasts and lock-screen banners disappear.  Users need to reopen later alerts with time, title/body, and whether they were read.  Persist across refresh / relaunch.  Reasonable recency is enough — not a huge archive product.

## Changes Made

Web already had Activity → Alert Center on `notification_events` (ack, filters, mute).  iOS had APNs delivery and no inbox.  This PR reuses that store and ack API.

- Slim last-100 history items on `GET /api/mobile/snapshot` (`title`/`body` already worded; no raw payload).
- iOS Activity opens with a Notifications list (Unread / All, Mark as Read, unread badge on the Activity tab).
- Website header bell inbox (time, title/body, read) plus unread badges on Activity nav.  `?tab=alerts` opens Alert Center.  Command palette gains Notifications.

Touched files:

- `src/lib/notification-history.ts`
- `test/notification-history.test.ts`
- `app/api/mobile/snapshot/route.ts`
- `app/console/components/notification-inbox.tsx`
- `app/console/components/shell.tsx`
- `app/console/components/nav.tsx`
- `app/console/components/command-palette.tsx`
- `app/console/activity/page.tsx`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/PreviewSupport.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-08-18-notification-history-parity.md`

## Decisions & Trade-offs

- Reused `notification_events` and `POST /api/notifications/ack`.  No second backend.
- Recency window is the existing dashboard cap of 100 rows.
- iOS history is a section on Activity (same place push taps already land: `/console/activity`), not a new tab.
- Did not port Alert Center mute / provider rollup / delivery-failure filters to iOS.  Mark as Read is the shared action.
- Did not add iOS Settings channel prefs (email / Pushover / event toggles).  Device alerts stay in Account & Settings.
- Did not touch trading, broker, OpenRouter, RAG, or health-gate code.
- Separate from #2831, #2812, #2830, #2800, and the HOTFIX deploy.
- Coolify `watch_paths` includes this web/src change, so merge will rebuild production.  This PR is opened, not merged.

## Verification State

```
npm run lint            # exit 0 (warnings only; no new errors)
./node_modules/.bin/tsc --noEmit   # exit 0
./node_modules/.bin/vitest run test/notification-history.test.ts \
  test/notification-lifecycle.test.ts test/alert-center-incident-grouping.test.ts \
  test/alert-mutes.test.ts test/notify.test.ts test/notify-push-sanitize.test.ts \
  test/notification-status-truth.test.ts test/policy-notification-events.test.ts
  # 8 files / 73 passed
npm run build           # Next.js 16.3.1 webpack, exit 0
```

Full `npm test` on this Linux VM hits leftover Yahoo/SEC/Alpaca 404s and strategy timeouts (untouched here; same residue noted on #2812).  No Mac pool; `xcodebuild` skipped.

## Rebase onto origin/main (2026-08-18)

`origin/main` moved to `13b60747` (#2830 Nasdaq UA + retry, plus docs #2832).  This branch rebased onto that SHA.  Sole conflict: `ios/SocraticTradeTests/UserFacingCopyTests.swift` — kept both #2830 `testScanCopyDoesNotTreatWatchlistAsTheUniverse` and this PR's `testNotificationHistoryCopyStaysOrdinary`.  Git auto-merged `MobileStore.swift` without a conflict marker but left two identical `acknowledgeNotifications` methods; the extra copy was removed so iOS still compiles.  #2830 `scanQuotesUnavailable` exhaustive switch and `nasdaq-screener-fetch` UA/retry were not reverted.

Did not recreate the PR.  Did not merge.  Did not deploy.  Did not touch #2831, #2812, #2840, trading, broker, OpenRouter, RAG, or the health gate.

## Rebase onto origin/main (2026-08-20)

`origin/main` moved to `ce31c367` (31 commits past the prior rebase base `13b60747`).  This branch rebased onto that SHA.  Real conflicts (rebase commit 1/4):

- `app/api/mobile/snapshot/route.ts` — kept this PR's `notifications: buildNotificationHistory(...)` and main's `latestScan: compactMobileMarketScan(...)`.
- `docs/phase-6-customization-risk-notifications.md` — kept both the last-100 inbox acceptance bullet and main's 60s alert-fingerprint bullet.
- `ios/SocraticTradeTests/MobileModelsTests.swift` — kept this PR's inbox decode tests and main's compact `latestScan` decode tests.

`MobileModels.swift` auto-merged: both `notifications` and `latestScan` remain.  `MobileStore.swift` still has a single `acknowledgeNotifications`.  Commits 2–4 applied clean.

Did not recreate the PR.  Did not merge.  Did not deploy.  Did not absorb other clusters.

## Rebase onto origin/main (2026-08-20, after #2892/#2876/#2942)

`origin/main` moved to `1d6bbf68` (#2834 + #2942 + #2876 + #2892 + #2814).  This branch rebased onto that SHA.  Git conflicts:

- `app/console/components/nav.tsx` — kept `unreadCount` and main's `sheetId`.
- `app/console/components/shell.tsx` — kept unread badges / header inbox and main's `#console-main` + `online`.
- `ios/SocraticTradeTests/MobileModelsTests.swift` — kept inbox assertions and main's `acknowledgedAt` / `latestScan` tests.
- `ios/SocraticTradeTests/UserFacingCopyTests.swift` — kept this PR's inbox copy test and main's scan-refresh / portfolio copy tests.

Silent auto-merge would have duplicated `notifications` on the snapshot and in `MobileSnapshot`.  Resolution stayed in this PR's scope: one last-100 `buildNotificationHistory` payload (also emits `status` / `acknowledgedAt` so a #2942-shaped row still decodes).  One iOS type (`NotificationHistoryItem`).  One Activity inbox (Unread / All / Mark as Read).  Left `serializeMobileNotifications` on main unused by this route.  Did not take #2942 deep-links, #2892 visibility, #2876 write guards, or #2834 failover.

Did not recreate the PR.  Did not merge.  Did not deploy.

## Next Steps & Blockers

- Done when GitHub reports #2841 MERGEABLE.  Leave auto-merge as Jay left it.
- ASC TestFlight after merge if iOS changed (no Mac pool on this account; `xcodebuild` skipped).
- Left gaps listed in the PR body (channel prefs, mute on iOS, full Strategy page on iOS).

## Zero-Code Findings

Investigation: website Alert Center already persisted history with `acknowledgedAt`.  Mobile snapshot omitted `notifications`.  iOS Activity showed fills and recent actions only.  Highest-value missing screen Jay hits is therefore the iOS inbox plus a website header inbox so a toast is not the only reopen path.
