# 2026-07-29 Mobile and PWA Account Switcher Fixes

## Context & Objective
The user reported that account switching was completely inaccessible on the iOS PWA ("no way to change accounts from the PWA") and that on the native iOS app, account switching was frequently glitching and getting stuck on a loading spinner, while incorrectly reporting "50+ open orders". 

The objectives were to un-hide the account switcher on the PWA by fixing layout bugs related to iOS safe areas, and to fix the mobile API payload to correctly filter out historical terminal orders.

## Changes Made
- **Fixed PWA Account Switcher Accessibility**: Added a new `.con-topbar` CSS class that applies `padding-top: env(safe-area-inset-top)` when the app is running in `display-mode: standalone`. Applied this class to the sticky wrapper of `ChromeBar`. This ensures the account switcher and top bar clear the physical iPhone notch and system status bar (time, battery) when installed as a PWA, making the `ScopeSelector` button visible and tappable.
- **Fixed iOS App Order Count & Account Switch Glitch**: Updated `app/api/mobile/snapshot/route.ts` to filter the `orders` array using `isWorkingOrderState(o.state)`. Previously, it was returning the full historical list of terminal orders (often hundreds of records). This huge payload was causing JSON parsing timeouts and UI hangs (the rotating animation) on the iOS app, and inflating the open orders count.

Touched files:
- `app/console/components/shell.tsx`
- `app/console/console.css`
- `app/api/mobile/snapshot/route.ts`

## Decisions & Trade-offs
- Filtering terminal orders at the API boundary ensures the mobile client only receives actionable working orders, reducing payload size significantly and preventing performance hangs.

## Verification State
- Verified CSS rules visually through layout inspection.
- The `isWorkingOrderState` filter is identical to the logic used by the web dashboard, bringing parity to the reported counts.

## Next Steps & Blockers
None. Changes are ready to land.
